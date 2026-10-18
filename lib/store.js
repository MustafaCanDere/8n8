'use strict';
/* File-based storage. Everything lives in one data folder (default ~/.8n8):
   workflows/<id>.json, versions/<id>.json, executions/<id>.json,
   tablolar/<id>.json (data tables), durum/<workflowId>.json (per-workflow memory: seen items, chat history, poll cursors),
   credentials.json (secrets encrypted with AES-256-GCM using the local key file), variables.json. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA = path.resolve(process.env.N8N8_DATA || path.join(os.homedir(), '.8n8'));
const DIRS = { workflows: path.join(DATA, 'workflows'), versions: path.join(DATA, 'versions'), executions: path.join(DATA, 'executions'), files: path.join(DATA, 'dosyalar'), tables: path.join(DATA, 'tablolar'), static: path.join(DATA, 'durum') };
for (const d of [DATA, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

const MAX_EXECUTIONS = Number(process.env.N8N8_MAX_EXECUTIONS || 1000);
const MAX_VERSIONS = 30;

const uid = (n = 12) => crypto.randomBytes(n).toString('base64url').slice(0, n);
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const safeId = id => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw Object.assign(new Error('Geçersiz kimlik'), { status: 400 }); return id; };

/* ---------- encryption key ---------- */
const keyFile = path.join(DATA, 'anahtar');
let KEY;
if (process.env.N8N8_ENCRYPTION_KEY) KEY = crypto.createHash('sha256').update(process.env.N8N8_ENCRYPTION_KEY).digest();
else {
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  KEY = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(s) {
  const [iv, tag, data] = s.split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

/* ---------- workflows ---------- */
const workflows = new Map();
for (const f of fs.readdirSync(DIRS.workflows)) if (f.endsWith('.json')) { const w = readJSON(path.join(DIRS.workflows, f)); if (w?.id) workflows.set(w.id, w); }

function listWorkflows() { return [...workflows.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); }
function getWorkflow(id) { return workflows.get(id) || null; }
/* Saved graphs come from the editor, imports and the API; keep only well-formed nodes and edges so a
   bad save can neither break the workflow list nor inject markup into the editor. */
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function cleanGraph(nodes, edges) {
  const seen = new Set();
  const outNodes = nodes.map((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw bad(`${i + 1}. node geçersiz`);
    if (!ID_RE.test(String(n.id))) throw bad(`Geçersiz node kimliği: ${String(n.id).slice(0, 40)}`);
    if (seen.has(n.id)) throw bad(`Aynı node kimliği iki kez kullanılmış: ${n.id}`);
    seen.add(n.id);
    if (typeof n.type !== 'string' || !n.type) throw bad(`"${n.name || n.id}" node'unun türü yok`);
    const num = v => { const x = Number(v); return Number.isFinite(x) ? Math.round(x * 10) / 10 : 0; };
    return { ...n, name: String(n.name ?? n.type).slice(0, 200), x: num(n.x), y: num(n.y), params: n.params && typeof n.params === 'object' && !Array.isArray(n.params) ? n.params : {} };
  });
  const outEdges = edges.filter(e => e && typeof e === 'object' && seen.has(e.from) && seen.has(e.to)).map(e => ({
    ...e, id: ID_RE.test(String(e.id)) ? e.id : uid(8), fromPort: Math.max(0, Math.trunc(Number(e.fromPort)) || 0), toPort: Math.max(0, Math.trunc(Number(e.toPort)) || 0),
  }));
  return { nodes: outNodes, edges: outEdges };
}
function normalizeWorkflow(w, existing) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || w.id || uid(),
    name: String(w.name || existing?.name || 'Adsız akış').slice(0, 200),
    active: typeof w.active === 'boolean' ? w.active : !!existing?.active,
    ...cleanGraph(Array.isArray(w.nodes) ? w.nodes : existing?.nodes || [], Array.isArray(w.edges) ? w.edges : existing?.edges || []),
    settings: { timeout: 300, errorWorkflow: '', ...(existing?.settings || {}), ...(w.settings || {}) },
    tags: Array.isArray(w.tags) ? w.tags.map(String).slice(0, 20) : existing?.tags || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
function saveWorkflow(w, { version = true, forceVersion = false } = {}) {
  const existing = w.id ? workflows.get(w.id) : null;
  const wf = normalizeWorkflow(w, existing);
  safeId(wf.id);
  workflows.set(wf.id, wf);
  writeJSON(path.join(DIRS.workflows, `${wf.id}.json`), wf);
  if (version && existing && JSON.stringify([existing.nodes, existing.edges, existing.name]) !== JSON.stringify([wf.nodes, wf.edges, wf.name])) addVersion(existing, forceVersion);
  return wf;
}
function deleteWorkflow(id) {
  safeId(id);
  workflows.delete(id);
  for (const d of [DIRS.workflows, DIRS.versions, DIRS.static]) fs.rmSync(path.join(d, `${id}.json`), { force: true });
  staticCache.delete(id);
}

/* versions: keep a snapshot at most every 2 minutes so autosave does not flood history */
function addVersion(wf, force = false) {
  const file = path.join(DIRS.versions, `${wf.id}.json`);
  const list = readJSON(file, []);
  const last = list[0];
  if (!force && last && Date.now() - Date.parse(last.savedAt) < 120000) return;
  list.unshift({ id: uid(8), savedAt: new Date().toISOString(), name: wf.name, nodes: wf.nodes, edges: wf.edges, nodeCount: wf.nodes.length });
  writeJSON(file, list.slice(0, MAX_VERSIONS));
}
function listVersions(id) { safeId(id); return readJSON(path.join(DIRS.versions, `${id}.json`), []); }

/* ---------- executions ---------- */
const execIndex = new Map(); // id -> summary
const summary = e => ({ id: e.id, workflowId: e.workflowId, workflowName: e.workflowName, mode: e.mode, status: e.status, trigger: e.trigger, startedAt: e.startedAt, stoppedAt: e.stoppedAt, duration: e.duration, error: e.error, retryOf: e.retryOf || null });
for (const f of fs.readdirSync(DIRS.executions)) {
  if (!f.endsWith('.json')) continue;
  const e = readJSON(path.join(DIRS.executions, f));
  if (e?.id) { if (e.status === 'running') { e.status = 'error'; e.error = 'Program kapanırken yarıda kaldı'; writeJSON(path.join(DIRS.executions, f), e); } execIndex.set(e.id, summary(e)); }
}
function saveExecution(e) {
  safeId(e.id);
  writeJSON(path.join(DIRS.executions, `${e.id}.json`), e);
  execIndex.set(e.id, summary(e));
  if (execIndex.size > MAX_EXECUTIONS) {
    const old = [...execIndex.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, execIndex.size - MAX_EXECUTIONS);
    for (const o of old) deleteExecution(o.id);
  }
}
function listExecutions({ workflowId, status, limit = 100, all = false } = {}) {
  return [...execIndex.values()]
    .filter(e => (!workflowId || e.workflowId === workflowId) && (!status || e.status === status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, all ? undefined : Math.min(Number(limit) || 100, 1000));
}
function getExecution(id) { safeId(id); return readJSON(path.join(DIRS.executions, `${id}.json`), null); }
function deleteExecution(id) { safeId(id); execIndex.delete(id); fs.rmSync(path.join(DIRS.executions, `${id}.json`), { force: true }); }

/* ---------- credentials ---------- */
const credFile = path.join(DATA, 'credentials.json');
let creds = readJSON(credFile, []);
const saveCreds = () => writeJSON(credFile, creds);
function listCredentials() { return creds.map(({ id, name, type, createdAt, updatedAt }) => ({ id, name, type, createdAt, updatedAt })); }
function getCredentialData(id) {
  const c = creds.find(x => x.id === id);
  if (!c) return null;
  try { return { ...c, data: decrypt(c.data) }; } catch { throw new Error(`"${c.name}" kimlik bilgisi çözülemedi (şifreleme anahtarı değişmiş olabilir)`); }
}
function saveCredential({ id, name, type, data }) {
  const now = new Date().toISOString();
  const existing = id ? creds.find(x => x.id === id) : null;
  let merged = data || {};
  if (existing) { // empty secret fields keep their stored value
    const old = decrypt(existing.data);
    merged = { ...old, ...Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '' && v !== undefined)) };
  }
  const rec = { id: existing?.id || uid(), name: String(name || existing?.name || type), type: type || existing?.type, data: encrypt(merged), createdAt: existing?.createdAt || now, updatedAt: now };
  creds = existing ? creds.map(c => c.id === rec.id ? rec : c) : [...creds, rec];
  saveCreds();
  return { id: rec.id, name: rec.name, type: rec.type };
}
// backup restore: keeps the given id and replaces a credential with the same id
function putCredential({ id, name, type, data }) {
  safeId(id); const now = new Date().toISOString(); const old = creds.find(x => x.id === id);
  const rec = { id, name: String(name || type), type, data: encrypt(data || {}), createdAt: old?.createdAt || now, updatedAt: now };
  creds = old ? creds.map(c => c.id === id ? rec : c) : [...creds, rec]; saveCreds();
}
function deleteCredential(id) { creds = creds.filter(c => c.id !== id); saveCreds(); }

/* ---------- variables ---------- */
const varFile = path.join(DATA, 'variables.json');
let variables = readJSON(varFile, {});
function getVariables() { return { ...variables }; }
function setVariables(v) {
  const clean = {};
  for (const [k, val] of Object.entries(v || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) clean[k] = String(val);
  variables = clean; writeJSON(varFile, variables); return getVariables();
}

/* ---------- data tables ---------- */
const tables = new Map();
for (const f of fs.readdirSync(DIRS.tables)) if (f.endsWith('.json')) { const t = readJSON(path.join(DIRS.tables, f)); if (t?.id) tables.set(t.id, t); }
const MAX_ROWS = 100000;
const saveTable = t => { t.updatedAt = new Date().toISOString(); writeJSON(path.join(DIRS.tables, `${t.id}.json`), t); return t; };
const tableSummary = t => ({ id: t.id, name: t.name, columns: t.columns, rowCount: t.rows.length, createdAt: t.createdAt, updatedAt: t.updatedAt });
function listTables() { return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr')).map(tableSummary); }
function findTable(idOrName) {
  if (!idOrName) return null;
  return tables.get(idOrName) || [...tables.values()].find(t => t.name.toLocaleLowerCase('tr') === String(idOrName).toLocaleLowerCase('tr')) || null;
}
function getTable(idOrName) { const t = findTable(idOrName); if (!t) throw Object.assign(new Error(`Tablo bulunamadı: ${idOrName}`), { status: 404 }); return t; }
function createTable(name, columns = []) {
  name = String(name || '').trim();
  if (!name) throw Object.assign(new Error('Tablo adı boş olamaz'), { status: 400 });
  if (findTable(name)) throw Object.assign(new Error(`"${name}" adında bir tablo zaten var`), { status: 409 });
  const now = new Date().toISOString();
  const t = { id: uid(), name: name.slice(0, 100), columns: [...new Set(columns.map(String).filter(Boolean))], rows: [], seq: 0, createdAt: now, updatedAt: now };
  tables.set(t.id, t); saveTable(t); return tableSummary(t);
}
function updateTable(id, { name, columns }) {
  const t = getTable(id);
  if (name != null && String(name).trim()) { const other = findTable(String(name).trim()); if (other && other.id !== t.id) throw Object.assign(new Error(`"${name}" adında bir tablo zaten var`), { status: 409 }); t.name = String(name).trim().slice(0, 100); }
  if (Array.isArray(columns)) t.columns = [...new Set(columns.map(String).filter(Boolean))];
  saveTable(t); return tableSummary(t);
}
function putTable(t) {
  safeId(t.id); const other = findTable(t.name);
  if (other && other.id !== t.id) throw Object.assign(new Error(`"${t.name}" adında başka bir tablo var`), { status: 409 });
  const rows = Array.isArray(t.rows) ? t.rows.slice(0, MAX_ROWS) : [];
  const full = { id: t.id, name: String(t.name || 'Tablo').slice(0, 100), columns: Array.isArray(t.columns) ? t.columns.map(String) : [], rows, seq: Math.max(Number(t.seq) || 0, ...rows.map(r => Number(r._id) || 0)), createdAt: t.createdAt || new Date().toISOString() };
  tables.set(full.id, full); saveTable(full); return tableSummary(full);
}
function deleteTable(id) { const t = getTable(id); tables.delete(t.id); fs.rmSync(path.join(DIRS.tables, `${t.id}.json`), { force: true }); }
const cleanRow = r => Object.fromEntries(Object.entries(r || {}).filter(([k]) => k && !k.startsWith('_')));
function insertRows(id, rows) {
  const t = getTable(id); const now = new Date().toISOString();
  if (t.rows.length + rows.length > MAX_ROWS) throw new Error(`Tablo en fazla ${MAX_ROWS} satır tutabilir`);
  const added = rows.map(r => { const c = cleanRow(r); for (const k of Object.keys(c)) if (!t.columns.includes(k)) t.columns.push(k); return { _id: ++t.seq, ...c, _olusturma: now, _guncelleme: now }; });
  t.rows.push(...added); saveTable(t); return added;
}
function queryRows(id, pred = () => true, { limit, offset = 0 } = {}) { const t = getTable(id); const all = t.rows.filter(pred); return { total: all.length, rows: all.slice(offset, limit ? offset + limit : undefined) }; }
function updateRows(id, pred, patch) {
  const t = getTable(id); const now = new Date().toISOString(); const changed = [];
  for (const r of t.rows) if (pred(r)) { const c = cleanRow(typeof patch === 'function' ? patch(r) : patch); for (const k of Object.keys(c)) if (!t.columns.includes(k)) t.columns.push(k); Object.assign(r, c, { _guncelleme: now }); changed.push(r); }
  if (changed.length) saveTable(t); return changed;
}
function deleteRows(id, pred) { const t = getTable(id); const before = t.rows.length; const gone = t.rows.filter(pred); t.rows = t.rows.filter(r => !pred(r)); if (gone.length) saveTable(t); return gone; }

/* ---------- per-workflow memory ---------- */
const staticCache = new Map();
function getStatic(wfId) { safeId(wfId); if (!staticCache.has(wfId)) staticCache.set(wfId, readJSON(path.join(DIRS.static, `${wfId}.json`), {})); return staticCache.get(wfId); }
function saveStatic(wfId) { safeId(wfId); writeJSON(path.join(DIRS.static, `${wfId}.json`), getStatic(wfId)); }
function clearStatic(wfId) { safeId(wfId); staticCache.set(wfId, {}); fs.rmSync(path.join(DIRS.static, `${wfId}.json`), { force: true }); }

module.exports = {
  DATA, DIRS, uid,
  listTables, getTable, findTable, createTable, putTable, updateTable, deleteTable, insertRows, queryRows, updateRows, deleteRows,
  getStatic, saveStatic, clearStatic,
  listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, listVersions,
  saveExecution, listExecutions, getExecution, deleteExecution,
  listCredentials, getCredentialData, saveCredential, putCredential, deleteCredential,
  getVariables, setVariables,
};
