#!/usr/bin/env node
'use strict';
/* 8n8 — local workflow automation server.
   Serves the editor, the REST API, live events, webhooks, hosted forms and the scheduler. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./lib/store');
const engine = require('./lib/engine');
const { NODES, describe, defaults } = require('./lib/nodes');
const { nextRun } = require('./lib/cron');
const templates = require('./lib/templates');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT || process.env.N8N8_PORT || 5678);
const HOST = process.env.N8N8_HOST || '127.0.0.1';
const PASSWORD = process.env.N8N8_PASSWORD || '';
const PUBLIC_URL = (process.env.N8N8_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`).replace(/\/$/, '');
const MAX_BODY = 16 * 1024 * 1024;

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'İstek gövdesi çok büyük (16 MB sınırı)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (!raw) return resolve({});
      if (ct.includes('application/json')) { try { return resolve(JSON.parse(raw)); } catch { return reject(new HttpError(400, 'Geçersiz JSON gövde')); } }
      if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try { return resolve(JSON.parse(raw)); } catch { return resolve(raw); }
    });
    req.on('error', reject);
  });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanPath = p => String(p || '').trim().replace(/^\/+|\/+$/g, '');

/* ---------------- scheduler ---------------- */
const timers = new Map(); // `${wfId}:${nodeId}` -> { timer, next }
function disarm(wfId) { for (const [k, t] of timers) if (k.startsWith(wfId + ':')) { clearTimeout(t.timer); timers.delete(k); } }
function arm(wf) {
  disarm(wf.id);
  if (!wf.active) return;
  for (const n of wf.nodes) {
    if (n.type !== 'schedule' || n.disabled) continue;
    const key = `${wf.id}:${n.id}`;
    const p = { ...defaults('schedule'), ...n.params };
    const fire = () => {
      const cur = store.getWorkflow(wf.id);
      if (!cur?.active) return;
      try { engine.start(cur, { triggerId: n.id, mode: 'zamanlayıcı' }); } catch (e) { console.error('Zamanlayıcı:', e.message); }
    };
    const schedule = () => {
      let at;
      try {
        if (p.mode === 'cron') at = nextRun(p.cron).getTime();
        else at = Date.now() + Math.max(5000, (Number(p.every) || 1) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[p.unit] || 60000));
      } catch (e) { console.error(`"${wf.name}" zamanlayıcı hatası: ${e.message}`); return; }
      const delay = Math.min(at - Date.now(), 2 ** 31 - 1);
      const timer = setTimeout(() => { if (Date.now() >= at - 50) fire(); schedule(); }, delay);
      timers.set(key, { timer, next: at });
    };
    schedule();
  }
}
function nextRuns(wfId) { const o = {}; for (const [k, t] of timers) if (k.startsWith(wfId + ':')) o[k.split(':')[1]] = new Date(t.next).toISOString(); return o; }
for (const wf of store.listWorkflows()) arm(wf);

/* ---------------- webhooks & forms ---------------- */
function findTriggerNode(type, p, method, includeInactive) {
  const list = store.listWorkflows().filter(w => includeInactive || w.active);
  for (const wf of list) for (const n of wf.nodes) {
    if (n.type !== type || n.disabled) continue;
    const params = { ...defaults(type), ...n.params };
    if (cleanPath(params.path) !== p) continue;
    if (type === 'webhook' && params.method !== 'ANY' && params.method !== method) continue;
    return { wf, node: n, params };
  }
  return null;
}
async function handleWebhook(req, res, p, test) {
  const hit = findTriggerNode('webhook', p, req.method, test);
  if (!hit) {
    const other = findTriggerNode('webhook', p, req.method, true);
    return send(res, 404, { hata: other ? `"${other.wf.name}" akışı etkin değil. Etkinleştirin ya da /webhook-test/${p} adresini kullanın.` : `/${test ? 'webhook-test' : 'webhook'}/${p} için ${req.method} kabul eden bir webhook yok` });
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
  const url = new URL(req.url, PUBLIC_URL);
  const request = { method: req.method, yol: p, headers: { ...req.headers }, query: Object.fromEntries(url.searchParams), body, ip: req.socket.remoteAddress };
  let responded = false;
  const respond = r => {
    if (responded || res.headersSent) return false;
    responded = true;
    const isJSON = String(r.headers?.['Content-Type'] || '').includes('json');
    send(res, r.status || 200, isJSON ? (r.body ?? null) : String(r.body ?? ''), r.headers || {});
    return true;
  };
  const { exec, done } = engine.start(hit.wf, { triggerId: hit.node.id, triggerData: { request }, mode: test ? 'webhook testi' : 'webhook', respond });
  const mode = hit.params.respond;
  if (mode === 'immediately') return respond({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { durum: 'alındı', calistirma: exec.id } });
  const fin = await done;
  if (responded) return;
  if (fin.status !== 'success') return respond({ status: 500, headers: { 'Content-Type': 'application/json' }, body: { hata: fin.error, calistirma: fin.id } });
  const out = (fin.lastOutput || []).map(i => i.json);
  if (mode === 'node') return respond({ status: 200, headers: { 'Content-Type': 'application/json' }, body: { uyari: '"Webhook\'a yanıt ver" node\'u çalışmadı', calistirma: fin.id } });
  respond({ status: 200, headers: { 'Content-Type': 'application/json' }, body: out.length === 1 ? out[0] : out });
}
function formPage(params, { message, error, test } = {}) {
  const fields = (params.fields || []).map(f => {
    const req = f.required ? ' required' : '';
    const id = `f_${esc(f.name)}`;
    const input = f.type === 'textarea' ? `<textarea id="${id}" name="${esc(f.name)}" rows="5"${req}></textarea>` : `<input id="${id}" name="${esc(f.name)}" type="${['email', 'number', 'date', 'tel'].includes(f.type) ? f.type : 'text'}"${req}>`;
    return `<label for="${id}">${esc(f.label)}${f.required ? ' <span>*</span>' : ''}</label>${input}`;
  }).join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(params.title)}</title>
<style>:root{--bg:#eef1f4;--card:#fff;--fg:#15202b;--muted:#5a6876;--line:#d6dde4;--accent:#0b7563}@media(prefers-color-scheme:dark){:root{--bg:#0d1217;--card:#151c23;--fg:#e2e8ee;--muted:#8b9aa8;--line:#2a3540;--accent:#2fc2a6}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px;box-sizing:border-box}
form,.done{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:460px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 12px;color:var(--muted)}label{font-weight:600;font-size:13px;margin-top:8px}label span{color:#c62828}
input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}input:focus,textarea:focus{outline:2px solid var(--accent);border-color:transparent}
button{margin-top:16px;font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:11px;cursor:pointer}.err{color:#c62828}.test{font-size:12px;color:var(--muted);text-align:center}</style></head><body>
${message ? `<div class="done"><h1>${esc(message)}</h1></div>` : `<form method="post"><h1>${esc(params.title)}</h1>${params.description ? `<p>${esc(params.description)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}${fields}<button type="submit">Gönder</button>${test ? '<div class="test">Test formu: akış kapalıyken de çalışır.</div>' : ''}</form>`}
</body></html>`;
}
async function handleForm(req, res, p, test) {
  const hit = findTriggerNode('form', p, req.method, test);
  if (!hit) return send(res, 404, formPage({ title: 'Form bulunamadı' }, { message: 'Bu form bulunamadı ya da şu an kapalı.' }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method === 'GET') return send(res, 200, formPage(hit.params, { test }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method !== 'POST') return send(res, 405, 'Yalnızca GET ve POST');
  const body = await readBody(req);
  const values = {};
  for (const f of hit.params.fields || []) {
    let v = typeof body === 'object' ? body[f.name] ?? '' : '';
    if (f.type === 'number' && v !== '') v = Number(v);
    if (f.required && (v === '' || v == null)) return send(res, 400, formPage(hit.params, { error: `"${f.label}" alanı zorunlu.`, test }), { 'Content-Type': 'text/html; charset=utf-8' });
    values[f.name] = v;
  }
  engine.start(hit.wf, { triggerId: hit.node.id, triggerData: { values: { ...values, gonderimZamani: new Date().toISOString() } }, mode: test ? 'form testi' : 'form' });
  send(res, 200, formPage(hit.params, { message: hit.params.thanks || 'Teşekkürler!' }), { 'Content-Type': 'text/html; charset=utf-8' });
}

/* ---------------- live events (SSE) ---------------- */
const clients = new Set();
engine.events.on('event', ev => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(line); });
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

/* ---------------- API ---------------- */
function workflowSummary(wf) {
  const last = store.listExecutions({ workflowId: wf.id, limit: 1 })[0];
  const triggers = wf.nodes.filter(n => NODES[n.type]?.trigger).map(n => n.type);
  return { id: wf.id, name: wf.name, active: wf.active, tags: wf.tags, nodeCount: wf.nodes.filter(n => n.type !== 'note').length, triggers, updatedAt: wf.updatedAt, createdAt: wf.createdAt, lastExecution: last || null };
}
function validateActivation(wf) {
  if (!wf.active) return;
  const trig = wf.nodes.filter(n => NODES[n.type]?.trigger && !n.disabled && !['manual', 'subTrigger', 'errorTrigger'].includes(n.type));
  if (!trig.length && !wf.nodes.some(n => ['subTrigger', 'errorTrigger'].includes(n.type))) throw new HttpError(400, 'Etkinleştirmek için Zamanlayıcı, Webhook ya da Form tetikleyicisi gerekir. Manuel tetikleyici yalnızca editörden çalışır.');
  for (const n of wf.nodes) {
    if (n.type === 'schedule' && n.params?.mode === 'cron') { try { nextRun(n.params.cron); } catch (e) { throw new HttpError(400, `"${n.name}": ${e.message}`); } }
    if (['webhook', 'form'].includes(n.type) && !n.disabled) {
      const p = cleanPath(n.params?.path);
      if (!p || !/^[A-Za-z0-9._~\-/]+$/.test(p)) throw new HttpError(400, `"${n.name}": yol yalnızca harf, rakam, - ve / içerebilir`);
      for (const other of store.listWorkflows()) {
        if (other.id === wf.id || !other.active) continue;
        if (other.nodes.some(o => o.type === n.type && !o.disabled && cleanPath(o.params?.path) === p && (n.type === 'form' || o.params?.method === n.params?.method || [o.params?.method, n.params?.method].includes('ANY'))))
          throw new HttpError(409, `"${p}" yolu "${other.name}" akışında zaten kullanılıyor`);
      }
    }
  }
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/info', () => ({ version: pkg.version, url: PUBLIC_URL, data: store.DATA, files: store.DIRS.files, password: !!PASSWORD, host: HOST, node: process.version }));
route('GET', '/api/node-types', () => describe());
route('GET', '/api/workflows', () => store.listWorkflows().map(workflowSummary));
route('POST', '/api/workflows', async ({ body }) => {
  const wf = store.saveWorkflow({ ...body, id: undefined, active: false });
  return wf;
});
route('GET', '/api/workflows/:id', ({ params }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  return { ...wf, nextRuns: nextRuns(wf.id) };
});
route('PUT', '/api/workflows/:id', ({ params, body }) => {
  const cur = store.getWorkflow(params.id); if (!cur) throw new HttpError(404, 'Akış bulunamadı');
  const next = { ...cur, ...body, id: cur.id };
  if (next.active) validateActivation(next);
  const wf = store.saveWorkflow(next);
  arm(wf);
  return { ...wf, nextRuns: nextRuns(wf.id) };
});
route('DELETE', '/api/workflows/:id', ({ params }) => { disarm(params.id); store.deleteWorkflow(params.id); return { ok: true }; });
route('POST', '/api/workflows/:id/duplicate', ({ params }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  return store.saveWorkflow({ ...JSON.parse(JSON.stringify(wf)), id: undefined, name: `${wf.name} (kopya)`, active: false });
});
route('POST', '/api/workflows/:id/run', ({ params, body }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  const { exec } = engine.start(wf, { triggerId: body.triggerId, destinationId: body.destinationId, triggerData: body.triggerData, mode: body.destinationId ? 'node testi' : 'manuel', usePinData: true });
  return { executionId: exec.id };
});
route('GET', '/api/workflows/:id/versions', ({ params }) => store.listVersions(params.id).map(({ nodes, edges, ...v }) => v));
route('POST', '/api/workflows/:id/versions/:vid/restore', ({ params }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  const v = store.listVersions(params.id).find(x => x.id === params.vid); if (!v) throw new HttpError(404, 'Sürüm bulunamadı');
  const saved = store.saveWorkflow({ ...wf, nodes: v.nodes, edges: v.edges, name: v.name });
  arm(saved); return saved;
});
route('GET', '/api/executions', ({ query }) => ({ items: store.listExecutions({ workflowId: query.workflowId, status: query.status, limit: query.limit }), running: engine.runningIds() }));
route('GET', '/api/executions/:id', ({ params }) => { const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı'); return e; });
route('DELETE', '/api/executions/:id', ({ params }) => { store.deleteExecution(params.id); return { ok: true }; });
route('POST', '/api/executions/:id/stop', ({ params }) => ({ stopped: engine.stop(params.id) }));
route('POST', '/api/executions/:id/retry', ({ params, body }) => {
  const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı');
  const wf = store.getWorkflow(e.workflowId); if (!wf) throw new HttpError(404, 'Akış artık yok');
  const source = body.useCurrent ? wf : { ...wf, nodes: e.snapshot.nodes, edges: e.snapshot.edges };
  const { exec } = engine.start(source, { triggerId: e.triggerId, triggerData: e.triggerData, mode: 'yeniden deneme', retryOf: e.id });
  return { executionId: exec.id };
});
route('DELETE', '/api/executions', ({ query }) => { for (const e of store.listExecutions({ workflowId: query.workflowId, limit: 1000 })) store.deleteExecution(e.id); return { ok: true }; });
route('GET', '/api/credentials', () => store.listCredentials());
route('GET', '/api/credentials/:id', ({ params }) => {
  const c = store.getCredentialData(params.id); if (!c) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  const t = describe().credentialTypes[c.type];
  const data = Object.fromEntries((t?.fields || []).map(f => [f.key, f.secret ? '' : c.data[f.key] ?? '']));
  const filled = Object.fromEntries((t?.fields || []).filter(f => f.secret).map(f => [f.key, !!c.data[f.key]]));
  return { id: c.id, name: c.name, type: c.type, data, filled };
});
route('POST', '/api/credentials', ({ body }) => { if (!describe().credentialTypes[body.type]) throw new HttpError(400, 'Bilinmeyen kimlik bilgisi türü'); return store.saveCredential(body); });
route('PUT', '/api/credentials/:id', ({ params, body }) => store.saveCredential({ ...body, id: params.id }));
route('DELETE', '/api/credentials/:id', ({ params }) => { store.deleteCredential(params.id); return { ok: true }; });
route('GET', '/api/variables', () => store.getVariables());
route('PUT', '/api/variables', ({ body }) => store.setVariables(body));
route('GET', '/api/templates', () => templates.LIST);
route('POST', '/api/templates/:key', ({ params }) => {
  const t = templates.TEMPLATES[params.key]; if (!t) throw new HttpError(404, 'Şablon bulunamadı');
  return store.saveWorkflow({ ...t(), active: false });
});
route('GET', '/api/files', () => {
  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name), path.join(base, d.name)) : [{ ad: path.join(base, d.name), boyut: fs.statSync(path.join(dir, d.name)).size, degisti: fs.statSync(path.join(dir, d.name)).mtime }]);
  return walk(store.DIRS.files);
});
route('GET', '/api/expr-check', ({ query }) => { try { require('./lib/expr').parse(query.e || ''); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

/* ---------------- server ---------------- */
function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === PASSWORD;
}
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/expr.js': ['lib/expr.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    let m;
    if ((m = p.match(/^\/(webhook|webhook-test)\/(.+)$/))) return await handleWebhook(req, res, cleanPath(m[2]), m[1] === 'webhook-test');
    if ((m = p.match(/^\/(form|form-test)\/(.+)$/))) return await handleForm(req, res, cleanPath(m[2]), m[1] === 'form-test');
    if (!authorized(req)) return send(res, 401, 'Giriş gerekli', { 'WWW-Authenticate': 'Basic realm="8n8"' });
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(__dirname, file)), { 'Content-Type': type });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', running: engine.runningIds() })}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'DELETE' && !String(req.headers['content-type'] || '').includes('application/json'))
        throw new HttpError(415, 'API istekleri JSON olmalı'); // also blocks simple cross-site form posts
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const mm = p.match(r.re); if (!mm) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = await r.fn({ params: mm.groups || {}, query: Object.fromEntries(url.searchParams), body: typeof body === 'object' ? body : {} });
        return send(res, 200, out);
      }
      throw new HttpError(404, 'Böyle bir API yok');
    }
    send(res, 404, 'Bulunamadı');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, p.startsWith('/api/') || p.startsWith('/webhook') ? { hata: e.message } : e.message);
  }
});

function openBrowser(u) {
  if (process.env.N8N8_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`\n  ${PORT} portu kullanımda. 8n8 zaten açık olabilir: ${PUBLIC_URL}\n  Başka port için: PORT=5679 npm start\n`); openBrowser(PUBLIC_URL); setTimeout(() => process.exit(1), 300); }
  throw e;
});
server.listen(PORT, HOST, () => {
  if (!store.listWorkflows().length) store.saveWorkflow({ ...templates.TEMPLATES.siparis(), active: false });
  console.log(`\n  8n8 ${pkg.version} çalışıyor → ${PUBLIC_URL}`);
  console.log(`  Veri klasörü: ${store.DATA}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) console.log('  UYARI: Ağa açıksınız ama şifre yok. N8N8_PASSWORD ayarlayın.');
  console.log('  Kapatmak için bu pencerede Ctrl+C\n');
  openBrowser(PUBLIC_URL);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\n  8n8 kapatılıyor…'); for (const id of engine.runningIds()) engine.stop(id); setTimeout(() => process.exit(0), 300); });

module.exports = { server };
