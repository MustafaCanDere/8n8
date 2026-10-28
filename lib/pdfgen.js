'use strict';
/* Small PDF writer for the "PDF oluştur" node: headings, paragraphs, bullet lists, rules, tables with repeated
   headers, PNG/JPEG images, page numbers. Uses the built-in Helvetica fonts with an ISO-8859-9 (Latin-5) encoding,
   so Turkish letters work without embedding a font file. */
const zlib = require('zlib');

const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// Unicode -> byte in the font encoding (WinAnsi with the Latin-5 Turkish letters at their ISO-8859-9 places)
const SPECIAL = { 'Ğ': 0xd0, 'ğ': 0xf0, 'Ş': 0xde, 'ş': 0xfe, 'İ': 0xdd, 'ı': 0xfd, '€': 0x80, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '₺': 0x54 };
const BASE = { 0xd0: 'G', 0xf0: 'g', 0xde: 'S', 0xfe: 's', 0xdd: 'I', 0xfd: 'i', 0x80: 'C', 0x85: 'W', 0x95: '-', 0x96: 'n', 0x97: 'M', 0x91: "'", 0x92: "'", 0x93: '"', 0x94: '"' };
const DIFF = '/Differences [128 /Euro 133 /ellipsis 145 /quoteleft /quoteright /quotedblleft /quotedblright /bullet /endash /emdash 208 /Gbreve 221 /Idotaccent 222 /Scedilla 240 /gbreve 253 /dotlessi 254 /scedilla]';

function encodeText(s) {
  const out = [];
  for (const ch of String(s).normalize('NFC')) {
    if (SPECIAL[ch] != null) out.push(SPECIAL[ch]);
    else { const c = ch.codePointAt(0); out.push(c >= 32 && c < 127 ? c : c >= 160 && c < 256 && ![0xd0, 0xf0, 0xde, 0xfe, 0xdd, 0xfd].includes(c) ? c : ch === '\t' ? 32 : 63); }
  }
  return Buffer.from(out);
}
function charWidth(b, bold) {
  const W = bold ? W_BOLD : W_REG;
  if (b >= 32 && b < 127) return W[b - 32];
  if (b === 0x85) return 1000; if (b === 0x97) return 1000; if (b === 0x95) return 350;
  const base = BASE[b] || (b >= 0xc0 ? 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy'[b - 0xc0] : 'a');
  if (base === 'i' && b === 0xfd) return bold ? 278 : 278;
  return W[base.charCodeAt(0) - 32] ?? 556;
}
const textWidth = (buf, size, bold) => { let w = 0; for (const b of buf) w += charWidth(b, bold); return (w * size) / 1000; };
const esc = buf => { const o = []; for (const b of buf) { if (b === 0x28 || b === 0x29 || b === 0x5c) o.push(0x5c); o.push(b); } return Buffer.from(o).toString('latin1'); };

function wrap(text, size, bold, maxW) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (textWidth(encodeText(tryLine), size, bold) <= maxW) { line = tryLine; continue; }
      if (line) lines.push(line);
      line = word;
      while (textWidth(encodeText(line), size, bold) > maxW && line.length > 1) { // break a very long word
        let n = line.length - 1; while (n > 1 && textWidth(encodeText(line.slice(0, n)), size, bold) > maxW) n--;
        lines.push(line.slice(0, n)); line = line.slice(n);
      }
    }
    lines.push(line);
  }
  return lines;
}
function fit(text, size, bold, maxW) {
  let t = String(text ?? '').replace(/\s+/g, ' ');
  if (textWidth(encodeText(t), size, bold) <= maxW) return t;
  while (t && textWidth(encodeText(`${t}…`), size, bold) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/* ---------- images ---------- */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG dosyası değil');
  let p = 8, w, h, depth, type, inter; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
    if (t === 'IDAT') idat.push(d);
    if (t === 'IEND') break; p += 12 + len;
  }
  if (depth !== 8 || inter || ![0, 2, 4, 6].includes(type)) throw new Error('Yalnızca 8 bit, taramalı olmayan PNG desteklenir (gri, RGB, saydam)');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type]; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * ch;
  const px = Buffer.alloc(stride * h); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) { // undo the PNG row filters
    const f = raw[y * (stride + 1)]; const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const out = px.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 255;
    }
    prev = out;
  }
  const color = ch === 1 || ch === 2 ? 1 : 3; const alpha = ch === 2 || ch === 4;
  const col = Buffer.alloc(w * h * color), al = alpha ? Buffer.alloc(w * h) : null;
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < color; k++) col[i * color + k] = px[i * ch + k]; if (alpha) al[i] = px[i * ch + ch - 1]; }
  return { w, h, kind: 'png', cs: color === 1 ? '/DeviceGray' : '/DeviceRGB', data: zlib.deflateSync(col), alpha: al && zlib.deflateSync(al) };
}
function readJpeg(buf) {
  let p = 2;
  while (p < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const m = buf[p + 1]; const len = buf.readUInt16BE(p + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5), kind: 'jpeg', cs: { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[buf[p + 9]] || '/DeviceRGB', data: buf };
    p += 2 + len;
  }
  throw new Error('JPEG boyutu okunamadı');
}
const readImage = buf => (buf[0] === 0xff && buf[1] === 0xd8 ? readJpeg(buf) : readPng(buf));

/* doc = { title, blocks: [{ type: 'h1'|'h2'|'p'|'bullet'|'rule'|'space'|'table'|'image', text, rows, columns, image, width, align }],
          pageSize: 'A4'|'Letter', landscape, fontSize, footer } -> { buffer, pages } */
function build(doc) {
  let [PW, PH] = doc.pageSize === 'Letter' ? [612, 792] : [595.28, 841.89];
  if (doc.landscape) [PW, PH] = [PH, PW];
  const M = 50, FS = Number(doc.fontSize) || 10.5, CW = PW - 2 * M;
  const pages = []; let ops = []; let y = PH - M; const images = [];
  const newPage = () => { if (ops.length || !pages.length) pages.push(ops = []); y = PH - M; };
  newPage();
  const need = h => { if (y - h < M + 20) { pages.push(ops = []); y = PH - M; return true; } return false; };
  const text = (x, yy, s, size, bold, color) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color || '0.1 0.1 0.1'} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(encodeText(s))}) Tj ET`);
  const para = (s, size, bold, indent = 0, gap = 0.4) => {
    const lh = size * 1.35;
    for (const l of wrap(s, size, bold, CW - indent)) { need(lh); y -= lh; text(M + indent, y + size * 0.25, l, size, bold); }
    y -= size * gap;
  };
  if (doc.title) { para(doc.title, FS * 1.9, true, 0, 0.3); ops.push(`0.8 0.8 0.8 RG 1 w ${M} ${y.toFixed(2)} m ${PW - M} ${y.toFixed(2)} l S`); y -= FS; }
  for (const b of doc.blocks || []) {
    if (b.type === 'h1') { need(FS * 4); y -= FS * 0.6; para(b.text, FS * 1.5, true, 0, 0.3); }
    else if (b.type === 'h2') { need(FS * 3.4); y -= FS * 0.4; para(b.text, FS * 1.2, true, 0, 0.2); }
    else if (b.type === 'p') para(b.text, FS, !!b.bold);
    else if (b.type === 'pagebreak') { if (ops.length) { pages.push(ops = []); y = PH - M; } }
    else if (b.type === 'bullet') {
      const lh = FS * 1.35; const lines = wrap(b.text, FS, false, CW - 14);
      lines.forEach((l, i) => { need(lh); y -= lh; if (!i) text(M + 2, y + FS * 0.25, '•', FS, false); text(M + 14, y + FS * 0.25, l, FS, false); });
      y -= FS * 0.15;
    } else if (b.type === 'rule') { need(FS); y -= FS * 0.5; ops.push(`0.75 0.75 0.75 RG 0.8 w ${M} ${y.toFixed(2)} m ${PW - M} ${y.toFixed(2)} l S`); y -= FS * 0.5; }
    else if (b.type === 'space') y -= FS;
    else if (b.type === 'image') {
      const img = readImage(b.image); const name = `Im${images.length + 1}`; images.push({ ...img, name });
      let w = Math.min(Number(b.width) || img.w * 0.75, CW); let h = (w * img.h) / img.w;
      if (h > PH - 2 * M - 30) { h = PH - 2 * M - 30; w = (h * img.w) / img.h; }
      need(h + 6); y -= h; const x = b.align === 'center' ? M + (CW - w) / 2 : b.align === 'right' ? PW - M - w : M;
      ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`); y -= FS * 0.6;
    } else if (b.type === 'table') {
      const cols = b.columns; if (!cols.length) continue;
      const size = Math.max(6, FS - 1); const pad = 4; const rh = size * 1.25 + pad * 2;
      // column widths: proportional to the longest content, at least 8% each
      const want = cols.map(c => Math.max(textWidth(encodeText(c.label), size, true), ...b.rows.slice(0, 200).map(r => textWidth(encodeText(r[c.key] ?? ''), size, false)), 20) + pad * 2);
      const tot = want.reduce((a, v) => a + v, 0); let ws = want.map(v => Math.max(CW * 0.08, (v / tot) * CW)); const sc = CW / ws.reduce((a, v) => a + v, 0); ws = ws.map(v => v * sc);
      const numeric = cols.map(c => b.rows.length && b.rows.every(r => r[c.key] === '' || r[c.key] == null || /^-?[\d.,]+( ?(TL|₺|%|USD|EUR))?$/.test(String(r[c.key]))));
      const header = () => {
        need(rh); y -= rh; ops.push(`0.93 0.94 0.96 rg ${M} ${y.toFixed(2)} ${CW.toFixed(2)} ${rh.toFixed(2)} re f`);
        let x = M; cols.forEach((c, i) => { const t = fit(c.label, size, true, ws[i] - pad * 2); text(numeric[i] ? x + ws[i] - pad - textWidth(encodeText(t), size, true) : x + pad, y + pad + size * 0.3, t, size, true); x += ws[i]; });
      };
      y -= FS * 0.3; header();
      b.rows.forEach((r, ri) => {
        if (need(rh)) header();
        y -= rh; if (ri % 2) ops.push(`0.98 0.98 0.98 rg ${M} ${y.toFixed(2)} ${CW.toFixed(2)} ${rh.toFixed(2)} re f`);
        let x = M; cols.forEach((c, i) => { const t = fit(r[c.key] ?? '', size, false, ws[i] - pad * 2); text(numeric[i] ? x + ws[i] - pad - textWidth(encodeText(t), size, false) : x + pad, y + pad + size * 0.3, t, size, false); x += ws[i]; });
        ops.push(`0.88 0.88 0.88 RG 0.5 w ${M} ${y.toFixed(2)} m ${PW - M} ${y.toFixed(2)} l S`);
      });
      if (b.total) { need(rh); y -= rh; const t = b.total; text(PW - M - pad - textWidth(encodeText(t), size, true), y + pad + size * 0.3, t, size, true); }
      y -= FS * 0.8;
    }
  }
  // footer: page numbers and optional text
  const n = pages.length;
  pages.forEach((p, i) => {
    const s = `${doc.footer ? `${doc.footer}   ` : ''}${i + 1} / ${n}`; const fs = 8;
    p.push(`BT /F1 ${fs} Tf 0.45 0.45 0.45 rg ${(PW - M - textWidth(encodeText(s), fs, false)).toFixed(2)} ${(M / 2).toFixed(2)} Td (${esc(encodeText(s))}) Tj ET`);
  });

  // ---- serialize ----
  const objs = []; const add = b => { objs.push(b); return objs.length; };
  const cat = add(null), pagesId = add(null);
  const font = base => add(Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ${DIFF} >> >>`));
  const f1 = font('Helvetica'), f2 = font('Helvetica-Bold');
  const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  const imgRefs = images.map(im => {
    let smask = '';
    if (im.alpha) smask = ` /SMask ${add(stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, im.alpha))} 0 R`;
    return `/${im.name} ${add(stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${im.cs} /BitsPerComponent 8 /Filter /${im.kind === 'jpeg' ? 'DCTDecode' : 'FlateDecode'}${smask}`, im.data))} 0 R`;
  }).join(' ');
  const res = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${imgRefs ? ` /XObject << ${imgRefs} >>` : ''} >>`;
  const kids = pages.map(p => {
    const c = add(stream('/Filter /FlateDecode', zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'))));
    return add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW.toFixed(2)} ${PH.toFixed(2)}] /Resources ${res} /Contents ${c} 0 R >>`));
  });
  objs[cat - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const u16 = s => `<FEFF${Buffer.from(String(s), 'utf16le').swap16().toString('hex').toUpperCase()}>`;
  const d = new Date(); const p2 = v => String(v).padStart(2, '0');
  const info = add(Buffer.from(`<< /Producer (Auto-Move) /Title ${u16(doc.title || 'Belge')} /CreationDate (D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z) >>`));
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offs = []; let len = parts[0].length;
  objs.forEach((o, i) => { const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]); offs.push(len); parts.push(b); len += b.length; });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return { buffer: Buffer.concat(parts), pages: n };
}

/* "# Başlık", "## Alt başlık", "- madde", "---" (çizgi), "[sayfa]" (yeni sayfa), "**kalın paragraf**", blank line = new paragraph */
function parseMarkup(src) {
  const blocks = []; let para = [];
  const flush = () => { if (para.length) { const t = para.join(' '); const m = t.match(/^\*\*([^*]+)\*\*$/); blocks.push({ type: 'p', text: (m ? m[1] : t).replace(/\*\*/g, ''), bold: !!m }); } para = []; };
  for (const raw of String(src ?? '').split(/\r?\n/)) {
    const l = raw.trimEnd();
    if (!l.trim()) { flush(); continue; }
    let m;
    if ((m = l.match(/^##\s+(.*)/))) { flush(); blocks.push({ type: 'h2', text: m[1] }); }
    else if ((m = l.match(/^#\s+(.*)/))) { flush(); blocks.push({ type: 'h1', text: m[1] }); }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { flush(); blocks.push({ type: 'bullet', text: m[1] }); }
    else if (/^\s*\[sayfa\]\s*$/i.test(l)) { flush(); blocks.push({ type: 'pagebreak' }); }
    else if (/^\s*(-{3,}|_{3,})\s*$/.test(l)) { flush(); blocks.push({ type: 'rule' }); }
    else para.push(l.trim());
  }
  flush();
  return blocks;
}

module.exports = { build, parseMarkup, encodeText, textWidth, readImage };
