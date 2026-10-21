'use strict';
/* multipart/form-data (file uploads from forms and webhooks). Uploaded files are saved under
   dosyalar/yuklemeler/<date>/ so "Dosya oku" and the other file nodes can use them. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS } = require('./store');

function parse(buf, contentType) {
  const bm = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!bm) throw Object.assign(new Error('multipart sınırı (boundary) yok'), { status: 400 });
  const delim = Buffer.from(`--${bm[1] || bm[2]}`);
  const fields = {}, files = [];
  let p = buf.indexOf(delim);
  while (p >= 0) {
    p += delim.length;
    if (buf[p] === 45 && buf[p + 1] === 45) break; // closing --
    if (buf[p] === 13) p += 2; else if (buf[p] === 10) p += 1;
    const headEnd = buf.indexOf('\r\n\r\n', p); if (headEnd < 0) break;
    const head = buf.slice(p, headEnd).toString('utf8');
    const next = buf.indexOf(delim, headEnd + 4); if (next < 0) break;
    let end = next; if (buf[end - 1] === 10) end--; if (buf[end - 1] === 13) end--;
    const body = buf.slice(headEnd + 4, end);
    const disp = head.match(/content-disposition:[^\r\n]*/i)?.[0] || '';
    const name = disp.match(/\bname="([^"]*)"/i)?.[1] ?? '';
    const fnStar = disp.match(/filename\*=UTF-8''([^;\r\n]+)/i)?.[1];
    const filename = fnStar ? decodeURIComponent(fnStar) : disp.match(/filename="([^"]*)"/i)?.[1];
    const type = head.match(/content-type:\s*([^\r\n;]+)/i)?.[1]?.trim() || 'application/octet-stream';
    if (filename !== undefined) { if (filename || body.length) files.push({ field: name, filename: filename || 'dosya', type, data: body }); }
    else add(fields, name, body.toString('utf8'));
    p = next;
  }
  return { fields, files };
}
function add(o, k, v) { if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; }

/* saves files and returns fields with file info objects in place of the file fields */
function save({ fields, files }) {
  const out = { ...fields };
  if (!files.length) return out;
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(DIRS.files, 'yuklemeler', day); fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const clean = path.basename(f.filename).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(-120) || 'dosya';
    const name = `${crypto.randomBytes(4).toString('hex')}-${clean}`;
    fs.writeFileSync(path.join(dir, name), f.data);
    add(out, f.field, { ad: clean, tur: f.type, boyut: f.data.length, dosya: `yuklemeler/${day}/${name}` });
  }
  return out;
}

module.exports = { parse, save };
