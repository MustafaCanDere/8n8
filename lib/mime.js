'use strict';
/* E-mail (RFC 822 / MIME) parsing for the IMAP trigger: headers with encoded words, nested multipart,
   base64 and quoted-printable bodies, Turkish legacy charsets (ISO-8859-9, Windows-1254) and attachments. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function decodeCharset(buf, charset = 'utf-8') {
  let cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'latin5') cs = 'iso-8859-9';
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}
function qp(s, header = false) {
  if (header) s = s.replace(/_/g, ' ');
  const out = []; const b = Buffer.from(s.replace(/=\r?\n/g, ''), 'latin1');
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 61 && /^[0-9A-Fa-f]{2}$/.test(String.fromCharCode(b[i + 1], b[i + 2]))) { out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16)); i += 2; }
    else out.push(b[i]);
  }
  return Buffer.from(out);
}
/* =?charset?B|Q?...?= words; adjacent encoded words are joined without the space between them */
function decodeWords(s) {
  return String(s ?? '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) =>
    decodeCharset(enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qp(txt, true), cs.replace(/\*.*$/, '')));
}
function parseHeaders(raw) {
  const headers = {};
  const text = raw.toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); let v = line.slice(i + 1).trim();
    // raw 8-bit headers are usually UTF-8
    if (/[\x80-\xff]/.test(v)) v = Buffer.from(v, 'latin1').toString('utf8');
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return headers;
}
function params(v) { // 'text/plain; charset="utf-8"; name=a.pdf' -> { _: 'text/plain', charset, name }
  const out = { _: String(v || '').split(';')[0].trim().toLowerCase() };
  for (const m of String(v || '').matchAll(/;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const k = m[1].toLowerCase(); let val = (m[2] ?? m[3] ?? '').trim();
    if (k.endsWith('*')) { const mm = val.match(/^([^']*)'[^']*'(.*)$/); if (mm) val = decodeCharset(Buffer.from(decodeURIComponent(mm[2].replace(/%(?![0-9a-f]{2})/gi, '%25')), 'latin1'), mm[1] || 'utf-8'); out[k.replace(/\*(\d+\*?)?$/, '')] = (out[k.replace(/\*(\d+\*?)?$/, '')] || '') + val; continue; }
    if (/^\d+$/.test(k.split('*')[1] || '')) { const base = k.split('*')[0]; out[base] = (out[base] || '') + val; continue; }
    out[k] = decodeWords(val);
  }
  return out;
}
function splitPart(buf) {
  let i = buf.indexOf('\r\n\r\n'); let skip = 4;
  const j = buf.indexOf('\n\n'); if (j >= 0 && (i < 0 || j < i)) { i = j; skip = 2; }
  if (i < 0) return [buf, Buffer.alloc(0)];
  return [buf.slice(0, i), buf.slice(i + skip)];
}
function bodyOf(raw, enc) {
  enc = String(enc || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qp(raw.toString('latin1'));
  return raw;
}
function walk(buf, out, depth = 0) {
  const [h, body] = splitPart(buf); const headers = parseHeaders(h);
  const ct = params(headers['content-type'] || 'text/plain'); const cd = params(headers['content-disposition'] || '');
  if (ct._.startsWith('multipart/') && ct.boundary && depth < 20) {
    const delim = Buffer.from(`--${ct.boundary}`); let p = body.indexOf(delim);
    while (p >= 0) {
      let s = p + delim.length; if (body[s] === 45 && body[s + 1] === 45) break;
      while (body[s] === 13 || body[s] === 10 || body[s] === 32 || body[s] === 9) s++;
      const n = body.indexOf(delim, s); if (n < 0) break;
      let e = n; if (body[e - 1] === 10) e--; if (body[e - 1] === 13) e--;
      walk(body.slice(s, e), out, depth + 1); p = n;
    }
    return headers;
  }
  if (ct._ === 'message/rfc822' && depth < 20 && cd._ !== 'attachment') { walk(bodyOf(body, headers['content-transfer-encoding']), out, depth + 1); return headers; }
  const data = bodyOf(body, headers['content-transfer-encoding']);
  const name = cd.filename || ct.name;
  if ((cd._ === 'attachment' || name) && !(ct._ === 'text/plain' && !name && cd._ !== 'attachment')) out.files.push({ name: name || 'ek', type: ct._, data, cid: (headers['content-id'] || '').replace(/[<>]/g, '') });
  else if (ct._ === 'text/html' && !out.html) out.html = decodeCharset(data, ct.charset);
  else if (ct._.startsWith('text/') && !out.text) out.text = decodeCharset(data, ct.charset);
  return headers;
}
const htmlToText = html => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/* raw message -> plain object; attachments are saved to dir (relative names returned) when given */
function parseMail(raw, { saveDir, relBase } = {}) {
  const out = { text: '', html: '', files: [] };
  const headers = walk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), out);
  const ekler = out.files.map(f => {
    const clean = path.basename(decodeWords(f.name)).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(-120) || 'ek';
    const e = { ad: clean, tur: f.type, boyut: f.data.length };
    if (saveDir) {
      fs.mkdirSync(saveDir, { recursive: true });
      const fn = `${crypto.randomBytes(4).toString('hex')}-${clean}`;
      fs.writeFileSync(path.join(saveDir, fn), f.data);
      e.dosya = path.posix.join(relBase || '', fn);
    }
    return e;
  });
  const date = headers.date ? new Date(headers.date) : null;
  return {
    kimden: decodeWords(headers.from || ''), kime: decodeWords(headers.to || ''), ...(headers.cc ? { bilgi: decodeWords(headers.cc) } : {}),
    konu: decodeWords(headers.subject || ''), tarih: date && !isNaN(date) ? date.toISOString() : null,
    metin: (out.text || htmlToText(out.html)).replace(/\r\n/g, '\n').trim(), html: out.html || '',
    ekler, messageId: (headers['message-id'] || '').replace(/[<>]/g, '').trim(), yanitAdresi: decodeWords(headers['reply-to'] || headers.from || ''),
  };
}
const address = s => (String(s).match(/<([^>]+)>/) || [null, String(s).trim()])[1];

module.exports = { parseMail, decodeWords, address, htmlToText };
