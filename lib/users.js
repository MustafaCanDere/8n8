'use strict';
/* Ekip kullanımı: kullanıcı hesapları, oturumlar, akış ve kimlik bilgisi paylaşımı, etkinlik kaydı.
   Hiç kullanıcı yokken program eskisi gibi tek kişiliktir (isteğe bağlı N8N8_PASSWORD). İlk yönetici
   Ayarlar sayfasından açılınca editör ve API giriş ister. Roller:
     yonetici     her şey: kullanıcılar, ayarlar, yedek, bütün akışlar ve kimlik bilgileri
     duzenleyici  kendi akışları ve kendisiyle paylaşılanlar; kendi kimlik bilgileri ve kendisiyle paylaşılanlar
     izleyici     yalnızca kendisiyle paylaşılan akışları ve çalıştırmalarını görür
   Kullanıcılar kullanicilar.json'da, şifreler scrypt ile; oturumlar oturumlar.json'da yalnızca özetleriyle durur. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const FILE = path.join(store.DATA, 'kullanicilar.json');
const SESSIONS = path.join(store.DATA, 'oturumlar.json');
const AUDIT = path.join(store.DATA, 'etkinlik.log');
const ROLES = { yonetici: 'Yönetici', duzenleyici: 'Düzenleyici', izleyici: 'İzleyici' };
const RANK = { izleyici: 1, duzenleyici: 2, yonetici: 3 };
const SESSION_DAYS = 30;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(t, f); };
let users = readJSON(FILE, []);
let sessions = readJSON(SESSIONS, {}); // sha256(token) -> { userId, at, seen }
const save = () => writeJSON(FILE, users);
let sessionsDirty = false;
const saveSessions = () => { sessionsDirty = false; writeJSON(SESSIONS, sessions); };
setInterval(() => { if (sessionsDirty) try { saveSessions(); } catch {} }, 60000).unref();

const enabled = () => users.length > 0;
const pub = u => u && ({ id: u.id, kullanici: u.kullanici, ad: u.ad, rol: u.rol, olusturma: u.olusturma, sonGiris: u.sonGiris || null });
const list = () => users.map(pub);
const get = id => users.find(u => u.id === id) || null;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// "ALI" and "ali" are the same account; Turkish lower-casing would turn I into ı
const norm = k => String(k || '').trim().replace(/İ/g, 'i').toLowerCase();
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

function checkName(k) {
  const v = norm(k);
  if (!/^[a-z0-9çğıöşü._@-]{2,60}$/.test(v)) throw bad('Kullanıcı adı 2-60 karakter olmalı; harf, rakam, nokta, alt çizgi, tire ve @ kullanılabilir');
  return v;
}
function checkPw(pw) { if (String(pw || '').length < 8) throw bad('Şifre en az 8 karakter olmalı'); return String(pw); }
function checkRole(r) { if (!ROLES[r]) throw bad('Rol yonetici, duzenleyici ya da izleyici olmalı'); return r; }

function create({ kullanici, ad, sifre, rol }) {
  const k = checkName(kullanici);
  if (users.some(u => u.kullanici === k)) throw bad('Bu kullanıcı adı zaten var', 409);
  const r = users.length ? checkRole(rol || 'duzenleyici') : 'yonetici'; // the first account is always an administrator
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomBytes(8).toString('hex'), kullanici: k, ad: String(ad || k).trim().slice(0, 100) || k, rol: r, tuz: salt, ozet: hashPw(checkPw(sifre), salt), olusturma: new Date().toISOString() };
  users.push(u); save();
  return pub(u);
}
function update(id, patch, by) {
  const u = get(id); if (!u) throw bad('Kullanıcı bulunamadı', 404);
  if (patch.rol !== undefined && patch.rol !== u.rol) {
    checkRole(patch.rol);
    if (u.rol === 'yonetici' && users.filter(x => x.rol === 'yonetici').length === 1) throw bad('Son yöneticinin rolü değiştirilemez');
    u.rol = patch.rol;
  }
  if (patch.ad !== undefined) u.ad = String(patch.ad).trim().slice(0, 100) || u.kullanici;
  if (patch.sifre) {
    u.tuz = crypto.randomBytes(16).toString('hex'); u.ozet = hashPw(checkPw(patch.sifre), u.tuz);
    for (const [k, s] of Object.entries(sessions)) if (s.userId === id && k !== by) delete sessions[k]; // other devices sign in again
    saveSessions();
  }
  save(); return pub(u);
}
function remove(id) {
  const u = get(id); if (!u) throw bad('Kullanıcı bulunamadı', 404);
  if (u.rol === 'yonetici' && users.filter(x => x.rol === 'yonetici').length === 1) throw bad('Son yönetici silinemez');
  users = users.filter(x => x.id !== id); save();
  for (const [k, s] of Object.entries(sessions)) if (s.userId === id) delete sessions[k];
  saveSessions();
}

/* sign-in, with a brake on guessing: 10 failures in 15 minutes from one address wait */
const fails = new Map();
function verify(kullanici, sifre, ip = '') {
  const f = fails.get(ip); const now = Date.now();
  if (f && f.n >= 10 && now - f.at < 15 * 60000) throw bad('Çok fazla hatalı deneme. 15 dakika sonra yeniden deneyin.', 429);
  const k = norm(kullanici);
  const u = users.find(x => x.kullanici === k);
  const salt = u?.tuz || 'yok';
  const want = Buffer.from(u?.ozet || hashPw('-', salt), 'hex'), got = Buffer.from(hashPw(String(sifre || ''), salt), 'hex');
  const ok = !!u && crypto.timingSafeEqual(want, got);
  if (!ok) { fails.set(ip, { n: (f && now - f.at < 15 * 60000 ? f.n : 0) + 1, at: now }); return null; }
  fails.delete(ip);
  return u;
}
function login(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[sha(token)] = { userId: u.id, at: Date.now(), seen: Date.now() };
  u.sonGiris = new Date().toISOString(); save(); saveSessions();
  return token;
}
function fromToken(token) {
  if (!token) return null;
  const k = sha(token); const s = sessions[k]; if (!s) return null;
  if (Date.now() - s.seen > SESSION_DAYS * 86400000) { delete sessions[k]; sessionsDirty = true; return null; }
  const u = get(s.userId); if (!u) { delete sessions[k]; sessionsDirty = true; return null; }
  if (Date.now() - s.seen > 3600000) { s.seen = Date.now(); sessionsDirty = true; }
  return u;
}
function logout(token) { if (token && sessions[sha(token)]) { delete sessions[sha(token)]; saveSessions(); } }

/* ---------- permissions ---------- */
const atLeast = (u, role) => !u || RANK[u.rol] >= RANK[role];
const isAdmin = u => !u || u.rol === 'yonetici';
/* workflow access: 'gor' (see), 'duzenle' (edit and run), 'sahip' (delete, share) */
function wfLevel(u, wf) {
  if (!u || u.rol === 'yonetici') return 'sahip';
  if (!wf) return null;
  if (wf.sahip === u.id && u.rol !== 'izleyici') return 'sahip';
  const s = wf.paylasim?.[u.id];
  if (s === 'duzenle' && u.rol !== 'izleyici') return 'duzenle';
  return s ? 'gor' : null;
}
const LV = { gor: 1, duzenle: 2, sahip: 3 };
const canWf = (u, wf, need) => (LV[wfLevel(u, wf)] || 0) >= LV[need];
function canCred(u, c, need = 'kullan') {
  if (!u || u.rol === 'yonetici') return true;
  if (!c || u.rol === 'izleyici') return false;
  if (c.sahip === u.id) return true;
  return need === 'kullan' && (c.paylasim || []).includes(u.id);
}
/* who may share with whom: only existing users, and only at levels their role allows */
function cleanShare(p, ownerId) {
  const out = {};
  for (const [id, lv] of Object.entries(p && typeof p === 'object' ? p : {})) {
    const u = get(id); if (!u || id === ownerId) continue;
    if (lv === 'duzenle' && u.rol !== 'izleyici') out[id] = 'duzenle';
    else if (lv === 'gor' || lv === 'duzenle') out[id] = 'gor';
  }
  return out;
}
const cleanCredShare = (a, ownerId) => [...new Set((Array.isArray(a) ? a : []).map(String))].filter(id => id !== ownerId && get(id) && get(id).rol !== 'izleyici');

/* ---------- activity log ("Etkinlik kaydı") ---------- */
function audit(u, eylem, ayrinti = '') {
  try {
    if (fs.existsSync(AUDIT) && fs.statSync(AUDIT).size > 5 * 1048576) fs.renameSync(AUDIT, AUDIT + '.1');
    fs.appendFileSync(AUDIT, JSON.stringify({ zaman: new Date().toISOString(), kullanici: u?.kullanici || '-', ad: u?.ad || '', eylem, ayrinti: String(ayrinti || '').slice(0, 300) }) + '\n');
  } catch {}
}
function auditLog(limit = 200) {
  let lines = [];
  try { lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean); } catch {}
  return lines.slice(-Math.min(2000, Math.max(1, limit))).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

module.exports = { sha, ROLES, enabled, list, get, create, update, remove, verify, login, fromToken, logout, atLeast, isAdmin, wfLevel, canWf, canCred, cleanShare, cleanCredShare, audit, auditLog, pub };
