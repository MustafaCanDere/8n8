'use strict';
/* File-based storage. Everything lives in one data folder (default ~/.8n8):
   workflows/<id>.json, versions/<id>.json, executions/<id>.json,
   credentials.json (secrets encrypted with AES-256-GCM using the local key file), variables.json. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA = path.resolve(process.env.N8N8_DATA || path.join(os.homedir(), '.8n8'));
const DIRS = { workflows: path.join(DATA, 'workflows'), versions: path.join(DATA, 'versions'), executions: path.join(DATA, 'executions'), files: path.join(DATA, 'dosyalar') };
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
function normalizeWorkflow(w, existing) {
  const now = new Date().toISOString();
  return {
    id: existing?.id || w.id || uid(),
    name: String(w.name || existing?.name || 'Adsız akış').slice(0, 200),
    active: typeof w.active === 'boolean' ? w.active : !!existing?.active,
    nodes: Array.isArray(w.nodes) ? w.nodes : existing?.nodes || [],
    edges: Array.isArray(w.edges) ? w.edges : existing?.edges || [],
    settings: { timeout: 300, errorWorkflow: '', ...(existing?.settings || {}), ...(w.settings || {}) },
    tags: Array.isArray(w.tags) ? w.tags.map(String).slice(0, 20) : existing?.tags || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
function saveWorkflow(w, { version = true } = {}) {
  const existing = w.id ? workflows.get(w.id) : null;
  const wf = normalizeWorkflow(w, existing);
  safeId(wf.id);
  workflows.set(wf.id, wf);
  writeJSON(path.join(DIRS.workflows, `${wf.id}.json`), wf);
  if (version && existing && JSON.stringify([existing.nodes, existing.edges, existing.name]) !== JSON.stringify([wf.nodes, wf.edges, wf.name])) addVersion(existing);
  return wf;
}
function deleteWorkflow(id) {
  safeId(id);
  workflows.delete(id);
  for (const d of [DIRS.workflows, DIRS.versions]) fs.rmSync(path.join(d, `${id}.json`), { force: true });
}

/* versions: keep a snapshot at most every 2 minutes so autosave does not flood history */
function addVersion(wf) {
  const file = path.join(DIRS.versions, `${wf.id}.json`);
  const list = readJSON(file, []);
  const last = list[0];
  if (last && Date.now() - Date.parse(last.savedAt) < 120000) return;
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
function listExecutions({ workflowId, status, limit = 100 } = {}) {
  return [...execIndex.values()]
    .filter(e => (!workflowId || e.workflowId === workflowId) && (!status || e.status === status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.min(Number(limit) || 100, 1000));
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

module.exports = {
  DATA, DIRS, uid,
  listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, listVersions,
  saveExecution, listExecutions, getExecution, deleteExecution,
  listCredentials, getCredentialData, saveCredential, deleteCredential,
  getVariables, setVariables,
};
