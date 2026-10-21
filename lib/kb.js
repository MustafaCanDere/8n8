'use strict';
/* Knowledge bases ("Bilgi tabanı"): documents split into passages and searched with BM25.
   Turkish words are cut to their first 4 and 5 letters before indexing (a simple, well-known stemming for
   an agglutinative language: "faturalarımız" and "faturası" both become "fatu"/"fatur"), so no embedding
   service or API key is needed. Stored as bilgi/<id>.json in the data folder. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');
const M = require('./markup');

const DIR = path.join(store.DATA, 'bilgi');
fs.mkdirSync(DIR, { recursive: true });
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const safeId = id => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw bad('Geçersiz kimlik'); return id; };
const MAX_DOC = 20 * 1024 * 1024;

/* ---------- text extraction ---------- */
// minimal zip reader (central directory) for .docx / .odt / .pptx / .xlsx
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('Dosya bozuk ya da zip/Office biçiminde değil');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    files[name] = () => { const lo = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28); const data = buf.slice(lo, lo + csize); return method === 8 ? zlib.inflateRawSync(data) : data; };
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const xmlText = (xml, paraTag) => M.decode(String(xml).replace(new RegExp(`</${paraTag}>`, 'g'), '\n').replace(/<w:tab\/>|<text:tab\/>/g, '\t').replace(/<w:br\/>|<text:line-break\/>/g, '\n').replace(/<[^>]+>/g, ''));
function extract(name, buf) {
  const ext = path.extname(String(name)).toLowerCase();
  if (['.docx', '.odt', '.pptx'].includes(ext)) {
    const z = unzip(buf);
    if (ext === '.docx') { if (!z['word/document.xml']) throw bad('Word belgesi okunamadı'); return xmlText(z['word/document.xml']().toString('utf8'), 'w:p'); }
    if (ext === '.odt') return xmlText(z['content.xml']().toString('utf8'), 'text:p');
    return Object.keys(z).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map((f, i) => `Slayt ${i + 1}\n${xmlText(z[f]().toString('utf8'), 'a:p')}`).join('\n\n');
  }
  if (ext === '.pdf') throw bad('PDF henüz desteklenmiyor. Metni kopyalayıp .txt olarak ekleyin ya da Word (.docx) olarak kaydedin.');
  if (['.xlsx', '.xls', '.doc', '.ppt', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.mp4', '.exe'].includes(ext)) throw bad(`${ext} dosyaları desteklenmiyor. Desteklenenler: .txt, .md, .csv, .json, .html, .docx, .odt, .pptx`);
  let text = buf.toString('utf8').replace(/^﻿/, '');
  if (text.includes('�') && !/[ğüşıöçĞÜŞİÖÇ]/.test(text)) text = buf.toString('latin1'); // old Windows files
  if (['.html', '.htm'].includes(ext) || /^\s*<(!doctype|html)/i.test(text)) return M.cleanText(M.textOf(M.parseHTML(text), { pretty: true }));
  return text;
}

/* ---------- passages & index ---------- */
function chunk(text, size = 1200, overlap = 150) {
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n+/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const out = []; let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); };
  for (const p of paras) {
    if (p.length > size) { // long paragraph: split on sentences
      push(); cur = '';
      const sents = p.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [p];
      for (const s of sents) { if ((cur + s).length > size && cur) { push(); cur = cur.slice(-overlap); } cur += s; }
      continue;
    }
    if ((cur + '\n\n' + p).length > size && cur) { push(); cur = cur.slice(-overlap).replace(/^\S*\s/, ''); }
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return out;
}
const STOP = new Set('ve veya ile için gibi bu şu o bir de da mi mı mu mü ne ki çok daha en ama fakat ancak her hiç olan olarak ise ya diye kadar sonra önce göre the a an of to in is are and or for on with what how nasıl nedir neden hangi kaç'.split(' '));
function terms(text) {
  return (String(text).toLocaleLowerCase('tr').normalize('NFC').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(w => w.length > 1 && !STOP.has(w))
    // first 4 letters always, plus the first 5 for longer words: "iade" still meets "iadeler", while 5-letter matches rank higher
    .flatMap(w => (/^\d+$/.test(w) || w.length <= 4 ? [w] : [w.slice(0, 4), w.slice(0, 5)]));
}

const cache = new Map(); // id -> kb (with built index)
const file = id => path.join(DIR, `${safeId(id)}.json`);
function index(kb) {
  const df = new Map(); let total = 0;
  kb._p = [];
  for (const d of kb.docs) for (const [i, text] of d.chunks.entries()) {
    const tf = new Map(); const ts = terms(`${d.ad}\n${text}`);
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    total += ts.length; kb._p.push({ doc: d, i, text, tf, len: ts.length });
  }
  kb._df = df; kb._avg = kb._p.length ? total / kb._p.length : 1;
  return kb;
}
function load(id) {
  if (cache.has(id)) return cache.get(id);
  let kb; try { kb = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { throw bad('Bilgi tabanı bulunamadı', 404); }
  cache.set(id, index(kb)); return kb;
}
function save(kb) {
  const { _p, _df, _avg, ...plain } = kb; plain.updatedAt = new Date().toISOString();
  const tmp = `${file(kb.id)}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(plain)); fs.renameSync(tmp, file(kb.id));
  kb.updatedAt = plain.updatedAt; cache.set(kb.id, index(kb)); return kb;
}
const summary = kb => ({ id: kb.id, name: kb.name, docs: kb.docs.length, passages: kb.docs.reduce((a, d) => a + d.chunks.length, 0), size: kb.docs.reduce((a, d) => a + d.boyut, 0), updatedAt: kb.updatedAt });

function list() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => { try { return summary(load(f.slice(0, -5))); } catch { return null; } }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}
function find(idOrName) {
  if (!idOrName) throw bad('Bilgi tabanı seçin');
  try { return load(safeId(idOrName)); } catch {}
  const s = list().find(k => k.name.toLocaleLowerCase('tr') === String(idOrName).toLocaleLowerCase('tr'));
  if (!s) throw bad(`Bilgi tabanı bulunamadı: ${idOrName}`, 404);
  return load(s.id);
}
function create(name) {
  name = String(name || '').trim().slice(0, 100); if (!name) throw bad('Ad boş olamaz');
  if (list().some(k => k.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'))) throw bad(`"${name}" adında bir bilgi tabanı zaten var`, 409);
  const now = new Date().toISOString();
  return summary(save({ id: store.uid(), name, docs: [], createdAt: now, updatedAt: now }));
}
function rename(id, name) { const kb = load(id); name = String(name || '').trim().slice(0, 100); if (!name) throw bad('Ad boş olamaz'); kb.name = name; return summary(save(kb)); }
function remove(id) { fs.rmSync(file(id), { force: true }); cache.delete(id); }
/* add or replace (same name) a document; content is a Buffer (file) or a string (text) */
function addDoc(idOrName, name, content) {
  const kb = find(idOrName);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length > MAX_DOC) throw bad('Belge 20 MB\'tan büyük olamaz');
  const ad = String(name || 'belge.txt').replace(/[\\/]/g, '_').slice(0, 200);
  const text = Buffer.isBuffer(content) ? extract(ad, buf) : String(content ?? '');
  const chunks = chunk(text);
  if (!chunks.length) throw bad(`"${ad}" içinde okunabilir metin yok`);
  const old = kb.docs.find(d => d.ad === ad);
  const doc = { id: old?.id || store.uid(8), ad, boyut: buf.length, karakter: text.length, eklendi: new Date().toISOString(), chunks };
  kb.docs = old ? kb.docs.map(d => (d === old ? doc : d)) : [...kb.docs, doc];
  save(kb);
  return { id: doc.id, ad, parca: chunks.length, karakter: text.length, guncellendi: !!old };
}
function removeDoc(id, docId) { const kb = load(id); const n = kb.docs.length; kb.docs = kb.docs.filter(d => d.id !== docId); if (kb.docs.length === n) throw bad('Belge bulunamadı', 404); save(kb); }
function getKb(id) { const kb = load(id); return { ...summary(kb), belgeler: kb.docs.map(d => ({ id: d.id, ad: d.ad, boyut: d.boyut, karakter: d.karakter, parca: d.chunks.length, eklendi: d.eklendi })) }; }

/* BM25; returns the best passages, each with its document name */
function search(idOrName, query, k = 5) {
  const kb = find(idOrName); const qs = [...new Set(terms(query))];
  if (!qs.length || !kb._p.length) return [];
  const N = kb._p.length, k1 = 1.2, b = 0.75;
  const scored = kb._p.map(p => {
    let s = 0;
    for (const t of qs) { const f = p.tf.get(t); if (!f) continue; const df = kb._df.get(t); s += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * p.len / kb._avg)); }
    return [s, p];
  }).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]).slice(0, Math.max(1, Math.min(50, Number(k) || 5)));
  const top = scored[0]?.[0] || 1;
  return scored.map(([s, p]) => ({ belge: p.doc.ad, parca: p.i + 1, puan: Math.round(s / top * 100) / 100, metin: p.text }));
}

/* whole bases, for backup / restore */
function dump() { return list().map(k => { const { _p, _df, _avg, ...plain } = load(k.id); return plain; }); }
function put(kb) {
  if (!kb || typeof kb !== 'object' || !Array.isArray(kb.docs)) throw bad('Bilgi tabanı kaydı bozuk');
  safeId(kb.id);
  for (const d of kb.docs) if (!d || typeof d.ad !== 'string' || !Array.isArray(d.chunks) || d.chunks.some(c => typeof c !== 'string')) throw bad(`"${kb.name}" içinde bozuk belge`);
  return save({ id: kb.id, name: String(kb.name || 'Bilgi tabanı').slice(0, 100), docs: kb.docs, createdAt: kb.createdAt || new Date().toISOString() });
}

module.exports = { dump, put, list, find, create, rename, remove, addDoc, removeDoc, getKb, search, chunk, terms, extract, DIR };
