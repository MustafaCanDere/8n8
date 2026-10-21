'use strict';
/* Minimal PDF text extraction, no packages: reads objects (also inside compressed object streams),
   inflates FlateDecode streams, maps glyph codes to Unicode with each font's ToUnicode CMap (or its
   simple encoding) and walks the page content operators (Tj, TJ, ', ", Td, Tm, T*, Do) to rebuild lines.
   Good for PDFs made by Word, LibreOffice, browsers and most reporting tools; scanned PDFs (images only)
   have no text to extract and encrypted PDFs are refused. */
const zlib = require('zlib');

const bad = msg => Object.assign(new Error(msg), { status: 400 });

/* ---------- tokenizer for PDF objects and content streams ---------- */
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map(c => c.charCodeAt(0)));
class Ref { constructor(n) { this.n = n; } }
class Name { constructor(s) { this.s = s; } }
class Op { constructor(s) { this.s = s; } }

function lexer(buf, pos = 0) {
  const n = buf.length;
  const skip = () => {
    for (;;) {
      while (pos < n && WS.has(buf[pos])) pos++;
      if (buf[pos] === 37) { while (pos < n && buf[pos] !== 10 && buf[pos] !== 13) pos++; continue; } // % comment
      return;
    }
  };
  function literal() { // after "("
    const out = []; let depth = 1;
    while (pos < n) {
      let c = buf[pos++];
      if (c === 92) { // backslash
        c = buf[pos++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[c] !== undefined) out.push(map[c]);
        else if (c >= 48 && c <= 55) { let v = c - 48; for (let k = 0; k < 2 && buf[pos] >= 48 && buf[pos] <= 55; k++) v = v * 8 + buf[pos++] - 48; out.push(v & 255); }
        else if (c === 13) { if (buf[pos] === 10) pos++; }
        else if (c !== 10) out.push(c);
        continue;
      }
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
      out.push(c);
    }
    return Buffer.from(out);
  }
  function hex() { // after "<"
    let s = '';
    while (pos < n && buf[pos] !== 62) { const c = buf[pos++]; if (!WS.has(c)) s += String.fromCharCode(c); }
    pos++;
    if (s.length % 2) s += '0';
    return Buffer.from(s, 'hex');
  }
  function next() {
    skip();
    if (pos >= n) return undefined;
    const c = buf[pos];
    if (c === 40) { pos++; return literal(); }
    if (c === 60) {
      if (buf[pos + 1] === 60) { pos += 2; return dict(); }
      pos++; return hex();
    }
    if (c === 62 && buf[pos + 1] === 62) { pos += 2; return END_DICT; }
    if (c === 91) { pos++; const a = []; for (;;) { const t = next(); if (t === END_ARR || t === undefined) return a; a.push(t); } }
    if (c === 93) { pos++; return END_ARR; }
    if (c === 47) { // name
      pos++; let s = '';
      while (pos < n && !WS.has(buf[pos]) && !DELIM.has(buf[pos])) s += String.fromCharCode(buf[pos++]);
      return new Name(s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 123 || c === 125) { pos++; return next(); }
    let s = '';
    while (pos < n && !WS.has(buf[pos]) && !DELIM.has(buf[pos])) s += String.fromCharCode(buf[pos++]);
    if (s === '') { pos++; return next(); }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {
      // "12 0 R" is a reference
      const save = pos; skip();
      let g = ''; let p2 = pos; while (p2 < n && buf[p2] >= 48 && buf[p2] <= 57) g += String.fromCharCode(buf[p2++]);
      if (g && /^\d+$/.test(s)) {
        let p3 = p2; while (p3 < n && WS.has(buf[p3])) p3++;
        if (buf[p3] === 82 && (p3 + 1 >= n || WS.has(buf[p3 + 1]) || DELIM.has(buf[p3 + 1]))) { pos = p3 + 1; return new Ref(Number(s)); }
      }
      pos = save;
      return Number(s);
    }
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    return new Op(s);
  }
  function dict() {
    const d = {};
    for (;;) {
      const k = next();
      if (k === END_DICT || k === undefined) return d;
      if (k instanceof Name) d[k.s] = next();
    }
  }
  return { next, get pos() { return pos; }, set pos(v) { pos = v; } };
}
const END_DICT = Symbol('>>'), END_ARR = Symbol(']');

/* ---------- document ---------- */
function parsePdf(buf) {
  if (buf.slice(0, 1024).indexOf('%PDF') < 0) throw bad('Dosya PDF değil');
  const objs = new Map(); // num -> { dict|value, stream? }
  const text = buf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(text))) {
    const lx = lexer(buf, m.index + m[0].length);
    let val; try { val = lx.next(); } catch { continue; }
    const o = { value: val };
    // stream?
    let p = lx.pos; while (WS.has(buf[p])) p++;
    if (text.startsWith('stream', p)) {
      p += 6; if (buf[p] === 13) p++; if (buf[p] === 10) p++;
      const len = typeof val?.Length === 'number' ? val.Length : -1;
      let end = len >= 0 && text.startsWith('endstream', skipWs(buf, p + len)) ? p + len : text.indexOf('endstream', p);
      if (end < 0) end = buf.length;
      let e2 = end; if (len < 0) { while (e2 > p && (buf[e2 - 1] === 10 || buf[e2 - 1] === 13)) e2--; }
      o.raw = buf.slice(p, e2);
      re.lastIndex = end;
    }
    objs.set(Number(m[1]), o); // later definitions (incremental updates) win
  }
  const get = v => { let k = 0; while (v instanceof Ref && k++ < 32) v = objs.get(v.n)?.value; return v; };
  const data = o => {
    if (!o?.raw) return Buffer.alloc(0);
    let filters = get(o.value?.Filter); filters = filters == null ? [] : Array.isArray(filters) ? filters : [filters];
    let b = o.raw;
    for (const f of filters.map(x => get(x)?.s)) {
      if (f === 'FlateDecode' || f === 'Fl') { try { b = zlib.inflateSync(b); } catch { try { b = zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return Buffer.alloc(0); } } }
      else if (f === 'ASCII85Decode' || f === 'A85') b = a85(b);
      else if (f === 'ASCIIHexDecode') b = Buffer.from(b.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      else return Buffer.alloc(0); // images (DCT, JPX, CCITT) carry no text
    }
    return b;
  };
  // objects inside object streams
  for (const [, o] of [...objs]) {
    if (get(o.value?.Type)?.s !== 'ObjStm') continue;
    const d = data(o); const N = get(o.value.N), first = get(o.value.First);
    const head = lexer(d, 0); const pairs = [];
    for (let i = 0; i < N; i++) pairs.push([head.next(), head.next()]);
    for (const [num, off] of pairs) {
      if (objs.has(num) && !objs.get(num).fromStm) continue;
      try { const lx = lexer(d, first + off); objs.set(num, { value: lx.next(), fromStm: true }); } catch {}
    }
  }
  const trailerHasEncrypt = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);
  if (trailerHasEncrypt) throw bad('PDF şifreli; şifresini kaldırıp yeniden kaydedin');
  return { objs, get, data };
}
function a85(b) {
  const s = b.toString('latin1').replace(/^\s*<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s/g, '');
  const out = []; let grp = [];
  const flush = (g, n) => { let v = 0; for (let i = 0; i < 5; i++) v = v * 85 + (g[i] ?? 84); for (let i = 0; i < n; i++) out.push((v >>> (24 - 8 * i)) & 255); };
  for (const ch of s) {
    if (ch === 'z' && !grp.length) { out.push(0, 0, 0, 0); continue; }
    grp.push(ch.charCodeAt(0) - 33);
    if (grp.length === 5) { flush(grp, 4); grp = []; }
  }
  if (grp.length) flush(grp, grp.length - 1);
  return Buffer.from(out);
}
function skipWs(buf, p) { while (p < buf.length && WS.has(buf[p])) p++; return p; }

/* ---------- fonts ---------- */
const GLYPHS = { space: ' ', gbreve: 'ğ', Gbreve: 'Ğ', scedilla: 'ş', Scedilla: 'Ş', dotlessi: 'ı', Idotaccent: 'İ', Idot: 'İ', ccedilla: 'ç', Ccedilla: 'Ç', odieresis: 'ö', Odieresis: 'Ö', udieresis: 'ü', Udieresis: 'Ü', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•', Euro: '€', ellipsis: '…', fi: 'fi', fl: 'fl', hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', parenleft: '(', parenright: ')', slash: '/', percent: '%', ampersand: '&', at: '@', question: '?', exclam: '!', quotesingle: "'", quotedbl: '"', plus: '+', equal: '=', underscore: '_', numbersign: '#', dollar: '$', asterisk: '*', less: '<', greater: '>', bracketleft: '[', bracketright: ']', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const glyph = n => GLYPHS[n] ?? (/^uni([0-9A-Fa-f]{4})$/.test(n) ? String.fromCharCode(parseInt(n.slice(3), 16)) : /^[A-Za-z]$/.test(n) ? n : null);
// WinAnsi differs from latin1 in 0x80-0x9F
const WIN = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x8A: 'Š', 0x8C: 'Œ', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™', 0x9A: 'š', 0x9C: 'œ' };

function parseCMap(b) {
  const s = b.toString('latin1'); const map = new Map(); let bytes = 1;
  const cs = s.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/); if (cs) bytes = Math.max(1, cs[1].length / 2);
  const uni = h => { const hh = h.replace(/\s/g, ''); let out = ''; for (let i = 0; i + 4 <= hh.length; i += 4) out += String.fromCharCode(parseInt(hh.slice(i, i + 4), 16)); return out; };
  for (const blk of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const [, a, b2] of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { map.set(parseInt(a, 16), uni(b2)); bytes = Math.max(bytes, a.length / 2); }
  for (const blk of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, z, rest] of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(a, 16), hi = parseInt(z, 16); bytes = Math.max(bytes, a.length / 2);
      if (hi - lo > 65535) continue;
      if (rest[0] === '[') { const items = [...rest.matchAll(/<([0-9a-fA-F]*)>/g)].map(x => uni(x[1])); for (let k = lo; k <= hi; k++) map.set(k, items[k - lo] ?? ''); }
      else { const base = rest.slice(1, -1); const last = parseInt(base.slice(-4), 16); const pre = uni(base.slice(0, -4)); for (let k = lo; k <= hi; k++) map.set(k, pre + String.fromCharCode(last + k - lo)); }
    }
  }
  return { map, bytes };
}
function makeFont(doc, f) {
  f = doc.get(f) || {};
  const sub = doc.get(f.Subtype)?.s;
  let cmap = null;
  const tu = f.ToUnicode instanceof Ref ? doc.objs.get(f.ToUnicode.n) : null;
  if (tu) cmap = parseCMap(doc.data(tu));
  const twoByte = sub === 'Type0';
  const diff = {};
  const enc = doc.get(f.Encoding);
  if (enc && !(enc instanceof Name)) {
    let code = 0;
    for (const x of doc.get(enc.Differences) || []) { if (typeof x === 'number') code = x; else if (x instanceof Name) { const g = glyph(x.s); if (g != null) diff[code] = g; code++; } }
  }
  const bytes = cmap ? (twoByte ? Math.max(2, cmap.bytes) : cmap.bytes) : twoByte ? 2 : 1;
  // glyph widths (thousandths of the font size), used to tell a word gap from the end of the previous run
  const widths = new Map(); let dw = twoByte ? 1000 : 500;
  if (twoByte) {
    const d = doc.get((doc.get(f.DescendantFonts) || [])[0]) || {};
    if (typeof doc.get(d.DW) === 'number') dw = doc.get(d.DW);
    const W = doc.get(d.W) || [];
    for (let i = 0; i < W.length;) {
      const a = doc.get(W[i]), b = doc.get(W[i + 1]);
      if (Array.isArray(b)) { b.forEach((w, k) => widths.set(a + k, doc.get(w))); i += 2; }
      else { const w = doc.get(W[i + 2]); for (let k = a; k <= b && k - a < 65536; k++) widths.set(k, w); i += 3; }
    }
  } else {
    const fc = doc.get(f.FirstChar) || 0; (doc.get(f.Widths) || []).forEach((w, k) => widths.set(fc + k, doc.get(w)));
    const avg = [...widths.values()].filter(w => w > 0); if (avg.length) dw = avg.reduce((x, y) => x + y, 0) / avg.length;
  }
  return {
    bytes,
    width(b) { let w = 0; for (let i = 0; i + bytes <= b.length; i += bytes) { const code = bytes === 2 ? b.readUInt16BE(i) : b[i]; w += widths.get(code) ?? dw; } return w / 1000; },
    decode(b) {
      let out = '';
      for (let i = 0; i + bytes <= b.length; i += bytes) {
        const code = bytes === 2 ? b.readUInt16BE(i) : b[i];
        if (cmap?.map.has(code)) out += cmap.map.get(code);
        else if (diff[code] != null) out += diff[code];
        else if (twoByte) out += code >= 32 && code < 0xD800 ? String.fromCharCode(code) : ''; // Identity encoding without ToUnicode: best effort
        else out += WIN[code] || (code >= 32 ? String.fromCharCode(code) : code === 9 ? ' ' : '');
      }
      return out;
    },
  };
}

/* ---------- pages ---------- */
function resourcesOf(doc, page) { let p = page, k = 0; while (p && k++ < 32) { const r = doc.get(p.Resources); if (r) return r; p = doc.get(p.Parent); } return {}; }
function pageList(doc) {
  const catalog = [...doc.objs.values()].map(o => o.value).find(v => doc.get(v?.Type)?.s === 'Catalog');
  const out = []; const seen = new Set();
  const walk = (node, depth) => {
    node = doc.get(node); if (!node || depth > 64 || seen.has(node)) return; seen.add(node);
    const t = doc.get(node.Type)?.s;
    if (t === 'Page' || (!t && node.Contents)) out.push(node);
    else for (const k of doc.get(node.Kids) || []) walk(k, depth + 1);
  };
  if (catalog) walk(catalog.Pages, 0);
  if (!out.length) for (const o of doc.objs.values()) if (doc.get(o.value?.Type)?.s === 'Page') out.push(o.value);
  return out;
}
function contentData(doc, contents) {
  contents = contents instanceof Ref ? contents : doc.get(contents);
  const list = Array.isArray(contents) ? contents : [contents];
  return Buffer.concat(list.flatMap(r => { const o = r instanceof Ref ? doc.objs.get(r.n) : null; return o ? [doc.data(o), Buffer.from('\n')] : []; }));
}

function runContent(doc, buf, res, state, depth = 0) {
  const fonts = {}; const fontDict = doc.get(res.Font) || {};
  const fontOf = name => fonts[name] ||= makeFont(doc, fontDict[name]);
  const xobj = doc.get(res.XObject) || {};
  const lx = lexer(buf); const st = []; let font = null;
  const out = state;
  const show = s => { if (!font || !s) return; out.penX = (out.penX || 0) + font.width(s) * (out.size || 12); const t = font.decode(s); if (t) { if (out.pendingNl) { out.text += out.pendingNl; out.pendingNl = ''; } out.text += t; out.lineHasText = true; } };
  const newline = (n = '\n') => { if (out.lineHasText) { out.pendingNl = n; out.lineHasText = false; } };
  const moveY = y => { if (out.y != null && Math.abs(y - out.y) > 1) newline(Math.abs(y - out.y) > (out.size || 12) * 1.9 ? '\n\n' : '\n'); out.y = y; };
  for (let t = lx.next(), k = 0; t !== undefined && k < 5e6; t = lx.next(), k++) {
    if (!(t instanceof Op)) { st.push(t); continue; }
    const a = st;
    switch (t.s) {
      case 'Tf': font = fontOf(a[a.length - 2]?.s); if (a[a.length - 1] > 0) out.size = a[a.length - 1]; break;
      case 'Tj': show(a[a.length - 1]); break;
      case "'": newline(); show(a[a.length - 1]); break;
      case '"': newline(); show(a[a.length - 1]); break;
      case 'TJ': {
        for (const x of a[a.length - 1] || []) {
          if (Buffer.isBuffer(x)) show(x);
          else if (typeof x === 'number') { out.penX = (out.penX || 0) - x / 1000 * (out.size || 12); if (x < -180 && out.lineHasText && !/\s$/.test(out.text)) out.text += ' '; }
        }
        break;
      }
      case 'BT': out.ly = 0; out.penX = 0; out.newBT = true; break;
      case 'Td': case 'TD': { const ty = a[a.length - 1], tx = a[a.length - 2]; const prev = out.y; out.ly = (out.ly || 0) + (ty || 0); if (ty) moveY(out.ly); const gap = out.newBT ? Math.abs(tx) : tx - (out.penX || 0); out.penX = 0; out.newBT = false;
        if ((prev == null || Math.abs(out.ly - prev) <= 1) && gap > (out.size || 12) * 0.2 && out.lineHasText && !/\s$/.test(out.text)) out.text += ' '; break; }
      case 'Tm': out.ly = a[a.length - 1]; out.penX = 0; out.newBT = false; moveY(out.ly); if (out.lineHasText && !/\s$/.test(out.text)) out.text += ' '; break;
      case 'T*': newline(); out.ly = (out.ly || 0) - (out.size || 12); out.y = out.ly; break;
      case 'ET': break;
      case 'Do': {
        const x = xobj[a[a.length - 1]?.s]; const o = x instanceof Ref ? doc.objs.get(x.n) : null;
        if (o && doc.get(o.value?.Subtype)?.s === 'Form' && depth < 8) runContent(doc, doc.data(o), doc.get(o.value.Resources) || res, out, depth + 1);
        break;
      }
    }
    st.length = 0;
  }
}

function pdfText(buf) {
  const doc = parsePdf(buf);
  const pages = pageList(doc);
  const parts = [];
  for (const pg of pages) {
    const state = { text: '', y: null, lineHasText: false, pendingNl: '' };
    try { runContent(doc, contentData(doc, pg.Contents), resourcesOf(doc, pg), state); } catch {}
    parts.push(state.text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim());
  }
  const text = parts.filter(Boolean).join('\n\n');
  if (!text.trim()) throw bad(pages.length ? 'PDF\'te okunabilir metin yok (taranmış bir belge olabilir)' : 'PDF okunamadı');
  return text;
}

module.exports = { pdfText };
