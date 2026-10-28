'use strict';
/* Full backup and restore ("Yedekle / Geri yükle" on the settings page): workflows, data tables, knowledge bases, variables and,
   when a password is given, credentials. Credentials are re-encrypted with that password (scrypt + AES-256-GCM),
   so the backup file can move to another computer whose local key is different. */
const crypto = require('crypto');
const store = require('./store');
const kb = require('./kb');

const FORMAT = '8n8/yedek';
const bad = msg => Object.assign(new Error(msg), { status: 400 });

function seal(obj, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function open(box, password) {
  try {
    const key = crypto.scryptSync(String(password), Buffer.from(box.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw bad('Yedek şifresi yanlış ya da kimlik bilgileri bölümü bozuk'); }
}

function create({ password = '', version = '' } = {}) {
  const creds = password ? store.listCredentials().map(c => { const d = store.getCredentialData(c.id); return { id: c.id, name: c.name, type: c.type, data: d.data }; }) : [];
  return {
    format: FORMAT, surum: 1, program: version, olusturuldu: new Date().toISOString(),
    akislar: store.listWorkflows(),
    tablolar: store.listTables().map(t => store.getTable(t.id)),
    degiskenler: store.getVariables(),
    bilgiTabanlari: kb.dump(),
    kimlikBilgileri: password ? seal(creds, password) : null,
    kimlikSayisi: creds.length || store.listCredentials().length,
  };
}

/* Merges a backup into the current data: items with the same id are replaced, others are added.
   checkWorkflow(wf) throws for workflows this program cannot load (unknown node types). */
function restore(b, { password = '', checkWorkflow = () => {} } = {}) {
  if (!b || b.format !== FORMAT) throw bad('Bu dosya bir Auto-Move yedeği değil');
  if (!Array.isArray(b.akislar) || !Array.isArray(b.tablolar)) throw bad('Yedek dosyası eksik');
  const out = { akislar: [], atlanan: [], tablolar: 0, bilgiTabanlari: 0, degiskenler: 0, kimlikBilgileri: 0 };
  // credentials first: restored workflows refer to them by id
  if (b.kimlikBilgileri) {
    if (!password) throw bad('Bu yedekte kimlik bilgileri var; yedeği alırken verdiğiniz şifreyi girin');
    for (const c of open(b.kimlikBilgileri, password)) { store.putCredential(c); out.kimlikBilgileri++; }
  }
  for (const t of b.tablolar) { store.putTable(t); out.tablolar++; }
  for (const k of b.bilgiTabanlari || []) { try { kb.put(k); out.bilgiTabanlari++; } catch (e) { out.atlanan.push(`Bilgi tabanı ${k?.name || ''}: ${e.message}`); } }
  const vars = { ...store.getVariables(), ...(b.degiskenler || {}) };
  out.degiskenler = Object.keys(b.degiskenler || {}).length; store.setVariables(vars);
  for (const w of b.akislar) {
    try { checkWorkflow(w); out.akislar.push(store.saveWorkflow({ ...w, active: false }, { version: true, forceVersion: true })); }
    catch (e) { out.atlanan.push(`${w?.name || w?.id}: ${e.message}`); }
  }
  return out;
}

module.exports = { create, restore, FORMAT };
