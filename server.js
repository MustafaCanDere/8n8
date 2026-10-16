#!/usr/bin/env node
'use strict';
/* 8n8 — local workflow automation server.
   Serves the editor, the REST API, live events, webhooks, hosted forms and the scheduler. */
if (Number(process.versions.node.split('.')[0]) < 20) { console.error(`\n  8n8 için Node.js 20 ya da daha yeni bir sürüm gerekir (şu an ${process.version}). https://nodejs.org adresinden LTS sürümünü kurun.\n`); process.exit(1); }
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./lib/store');
const engine = require('./lib/engine');
const { NODES, describe, defaults, CREDENTIAL_TYPES, testCredential } = require('./lib/nodes');
const { nextRun } = require('./lib/cron');
const templates = require('./lib/templates');
const aiBuilder = require('./lib/ai-builder');
const n8n = require('./lib/n8n-import');
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
  for (const n of wf.nodes) if (NODES[n.type]?.poll && !n.disabled) armPoll(wf, n);
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
      waitUntil(at);
    };
    // setTimeout tops out at ~24.8 days, so long waits are done in steps without moving the target time
    const waitUntil = at => {
      const timer = setTimeout(() => { if (Date.now() >= at - 50) { fire(); schedule(); } else waitUntil(at); }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
      timers.set(key, { timer, next: at });
    };
    schedule();
  }
}
/* polling triggers (RSS, Telegram, folder watch): call node.poll() on an interval, start a run for new items */
const pollState = new Map(); // `${wfId}:${nodeId}` -> { lastPoll, lastError, found }
const pollBusy = new Set();
function armPoll(wf, n) {
  const key = `${wf.id}:${n.id}`;
  const def = NODES[n.type];
  const p = { ...defaults(n.type), ...n.params };
  const every = Math.max(5000, (Number(p.every) || 1) * ({ s: 1000, m: 60000, h: 3600000 }[p.unit] || 60000));
  const tick = async () => {
    const cur = store.getWorkflow(wf.id);
    if (!cur?.active || pollBusy.has(key)) return; // shared across re-arms, so an autosave never runs two polls at once
    pollBusy.add(key);
    const st = pollState.get(key) || {};
    try {
      const memory = () => { const d = store.getStatic(wf.id); d[n.id] ??= {}; return d[n.id]; };
      const items = await def.poll({ p, memory, saveMemory: () => store.saveStatic(wf.id), credential: async cid => { if (!cid) throw new Error('Kimlik bilgisi seçilmemiş'); const c = store.getCredentialData(cid); if (!c) throw new Error('Kimlik bilgisi silinmiş'); return c; } });
      Object.assign(st, { lastPoll: new Date().toISOString(), lastError: null, found: (st.found || 0) + (items?.length || 0) });
      const node = cur.nodes.find(x => x.id === n.id);
      if (items?.length && node) {
        const batches = def.eachItem ? items.map(i => [i]) : [items];
        for (const b of batches) engine.start(cur, { triggerId: n.id, triggerData: { items: b }, mode: 'yoklama' });
      }
    } catch (e) { Object.assign(st, { lastPoll: new Date().toISOString(), lastError: e.message }); }
    finally { pollState.set(key, st); pollBusy.delete(key); }
  };
  const schedule = () => { const timer = setTimeout(async () => { await tick(); if (timers.get(key)?.timer === timer) schedule(); }, every); timers.set(key, { timer, next: Date.now() + every }); };
  const last = Date.parse(pollState.get(key)?.lastPoll || 0) || 0;
  if (Date.now() - last >= every) setTimeout(tick, 500); // not on every autosave of an active workflow
  schedule();
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
  if (hit.params.auth && hit.params.auth !== 'none') {
    const cred = hit.params.credential ? store.getCredentialData(hit.params.credential) : null;
    if (!cred) return send(res, 500, { hata: 'Webhook kimlik doğrulaması açık ama kimlik bilgisi seçilmemiş' });
    const h = req.headers;
    const ok = cred.type === 'httpBasic'
      ? (() => { const a = String(h.authorization || ''); if (!a.startsWith('Basic ')) return false; const [u, ...rest] = Buffer.from(a.slice(6), 'base64').toString().split(':'); return u === cred.data.user && rest.join(':') === cred.data.password; })()
      : cred.type === 'httpHeader' ? String(h[String(cred.data.name || '').toLowerCase()] || '') === String(cred.data.value || '')
      : cred.type === 'httpBearer' ? String(h.authorization || '') === `Bearer ${cred.data.token}` : false;
    if (!ok) return send(res, 401, { hata: 'Yetkisiz' }, cred.type === 'httpBasic' ? { 'WWW-Authenticate': 'Basic realm="webhook"' } : {});
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
  const url = new URL(req.url, PUBLIC_URL);
  const request = { method: req.method, yol: p, headers: { ...req.headers }, query: Object.fromEntries(url.searchParams), body, ip: req.socket.remoteAddress };
  let responded = false;
  const respond = r => {
    if (responded || res.headersSent) return false;
    const status = Number(r.status) || 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`Geçersiz durum kodu: ${r.status} (100-599 arası olmalı)`);
    const isJSON = String(r.headers?.['Content-Type'] || '').includes('json');
    try { send(res, status, isJSON ? (r.body ?? null) : String(r.body ?? ''), r.headers || {}); }
    catch (e) { throw new Error(`Yanıt gönderilemedi: ${e.message}`); } // e.g. a header value with a line break; the caller still answers with 500
    responded = true;
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

/* ---------------- hosted chat ---------------- */
function chatPage(params, { test, p }) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(params.title)}</title>
<style>:root{--bg:#eef1f4;--card:#fff;--fg:#15202b;--muted:#5a6876;--line:#d6dde4;--accent:#0b7563;--me:#0b7563;--meFg:#fff;--bot:#f3f5f7}@media(prefers-color-scheme:dark){:root{--bg:#0d1217;--card:#151c23;--fg:#e2e8ee;--muted:#8b9aa8;--line:#2a3540;--accent:#2fc2a6;--me:#1f7a68;--meFg:#fff;--bot:#1c252e}}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center}
.wrap{display:flex;flex-direction:column;width:100%;max-width:760px;height:100%;background:var(--card);border-inline:1px solid var(--line)}
header{padding:14px 16px;border-bottom:1px solid var(--line);font-weight:650;display:flex;gap:8px;align-items:center;justify-content:space-between}header small{font-weight:400;color:var(--muted);font-size:12px}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.m{max-width:85%;padding:9px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}.bot{background:var(--bot);align-self:flex-start;border-bottom-left-radius:4px}.me{background:var(--me);color:var(--meFg);align-self:flex-end;border-bottom-right-radius:4px}.err{color:#c62828;font-size:13px;align-self:center}
.typing{color:var(--muted);font-size:13px;align-self:flex-start}
form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}textarea{flex:1;resize:none;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;max-height:160px}textarea:focus{outline:2px solid var(--accent);border-color:transparent}
button{font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:0 18px;cursor:pointer}button:disabled{opacity:.5}
.new{background:transparent;color:var(--muted);border:1px solid var(--line);padding:4px 10px;font-size:12px;font-weight:500}</style></head>
<body><div class="wrap"><header><span>${esc(params.title)}${test ? ' <small>test</small>' : ''}</span><button class="new" id="new" type="button">Yeni sohbet</button></header><div id="log" aria-live="polite"></div>
<form id="f"><textarea id="t" rows="1" placeholder="Mesajınızı yazın…" aria-label="Mesaj" required></textarea><button id="b">Gönder</button></form></div>
<script>
const log=document.getElementById('log'),t=document.getElementById('t'),b=document.getElementById('b');
const K='8n8-sohbet-${esc(p)}';let sid;try{sid=localStorage.getItem(K)}catch{}if(!sid){sid=Math.random().toString(36).slice(2)+Date.now().toString(36);try{localStorage.setItem(K,sid)}catch{}}
const add=(cls,txt)=>{const d=document.createElement('div');d.className='m '+cls;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight;return d};
const welcome=${JSON.stringify(String(params.welcome || ''))};if(welcome)add('bot',welcome);
document.getElementById('new').onclick=()=>{sid=Math.random().toString(36).slice(2)+Date.now().toString(36);try{localStorage.setItem(K,sid)}catch{};log.innerHTML='';if(welcome)add('bot',welcome)};
t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('f').requestSubmit()}});
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const msg=t.value.trim();if(!msg)return;add('me',msg);t.value='';b.disabled=true;const ty=document.createElement('div');ty.className='typing';ty.textContent='yazıyor…';log.appendChild(ty);
try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mesaj:msg,oturum:sid})});const j=await r.json();ty.remove();if(!r.ok)add('err',j.hata||'Bir hata oluştu');else add('bot',j.yanit)}catch(err){ty.remove();add('err','Bağlantı hatası')}finally{b.disabled=false;t.focus()}};
</script></body></html>`;
}
async function handleChat(req, res, p, test) {
  const hit = findTriggerNode('chatTrigger', p, req.method, test);
  if (!hit) return send(res, 404, req.method === 'GET' ? 'Bu sohbet bulunamadı ya da akışı kapalı.' : { hata: 'Sohbet bulunamadı ya da akışı kapalı' });
  if (req.method === 'GET') return send(res, 200, chatPage(hit.params, { test, p }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method !== 'POST') return send(res, 405, 'Yalnızca GET ve POST');
  const body = await readBody(req);
  const mesaj = String(body?.mesaj ?? '').slice(0, 20000);
  if (!mesaj.trim()) return send(res, 400, { hata: 'Mesaj boş' });
  const oturum = String(body?.oturum || 'varsayilan').replace(/[^\w-]/g, '').slice(0, 64) || 'varsayilan';
  const { done } = engine.start(hit.wf, { triggerId: hit.node.id, triggerData: { chat: { mesaj, oturum } }, mode: test ? 'sohbet testi' : 'sohbet' });
  const fin = await done;
  if (fin.status !== 'success') return send(res, 500, { hata: `Akış hata verdi: ${fin.error}` });
  const first = fin.lastOutput?.[0]?.json;
  const field = hit.params.replyField || 'yanit';
  const reply = first == null ? '(yanıt yok)' : typeof first[field] === 'string' ? first[field] : first[field] != null ? JSON.stringify(first[field], null, 2) : JSON.stringify(first, null, 2);
  send(res, 200, { yanit: reply, calistirma: fin.id });
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
  if (!trig.length && !wf.nodes.some(n => ['subTrigger', 'errorTrigger'].includes(n.type))) throw new HttpError(400, 'Etkinleştirmek için Zamanlayıcı, Webhook, Form, Sohbet ya da yoklama (RSS, Telegram, klasör) tetikleyicisi gerekir. Manuel tetikleyici yalnızca editörden çalışır.');
  for (const n of wf.nodes) if (n.type === 'telegramTrigger' && !n.disabled && !n.params?.credential) throw new HttpError(400, `"${n.name}": Telegram botu seçin`);
  for (const n of wf.nodes) {
    if (n.type === 'schedule' && n.params?.mode === 'cron') { try { nextRun(n.params.cron); } catch (e) { throw new HttpError(400, `"${n.name}": ${e.message}`); } }
    if (['webhook', 'form', 'chatTrigger'].includes(n.type) && !n.disabled) {
      const p = cleanPath(n.params?.path);
      if (!p || !/^[A-Za-z0-9._~\-/]+$/.test(p)) throw new HttpError(400, `"${n.name}": yol yalnızca harf, rakam, - ve / içerebilir`);
      for (const other of store.listWorkflows()) {
        if (other.id === wf.id || !other.active) continue;
        if (other.nodes.some(o => o.type === n.type && !o.disabled && cleanPath(o.params?.path) === p && (n.type !== 'webhook' || o.params?.method === n.params?.method || [o.params?.method, n.params?.method].includes('ANY'))))
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
function checkTypes(nodes) {
  const unknown = (Array.isArray(nodes) ? nodes : []).find(n => n && !NODES[n.type]);
  if (unknown) throw new HttpError(400, `Bilinmeyen node türü: ${String(unknown.type).slice(0, 60)} ("${String(unknown.name || '').slice(0, 60)}")`);
}
route('POST', '/api/workflows', async ({ body }) => {
  checkTypes(body.nodes);
  const wf = store.saveWorkflow({ ...body, id: undefined, active: false });
  return wf;
});
route('GET', '/api/workflows/:id', ({ params }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  return { ...wf, nextRuns: nextRuns(wf.id) };
});
route('PUT', '/api/workflows/:id', ({ params, body }) => {
  const cur = store.getWorkflow(params.id); if (!cur) throw new HttpError(404, 'Akış bulunamadı');
  checkTypes(body.nodes);
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
  const saved = store.saveWorkflow({ ...wf, nodes: v.nodes, edges: v.edges, name: v.name }, { forceVersion: true });
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
route('DELETE', '/api/executions', ({ query }) => {
  const running = new Set(engine.runningIds()); let n = 0;
  for (const e of store.listExecutions({ workflowId: query.workflowId || undefined, status: query.status || undefined, all: true })) if (!running.has(e.id)) { store.deleteExecution(e.id); n++; }
  return { ok: true, silinen: n };
});
route('GET', '/api/credentials', () => store.listCredentials());
route('GET', '/api/credentials/:id', ({ params }) => {
  const c = store.getCredentialData(params.id); if (!c) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  const t = describe().credentialTypes[c.type];
  const data = Object.fromEntries((t?.fields || []).map(f => [f.key, f.secret ? '' : c.data[f.key] ?? '']));
  const filled = Object.fromEntries((t?.fields || []).filter(f => f.secret).map(f => [f.key, !!c.data[f.key]]));
  return { id: c.id, name: c.name, type: c.type, data, filled };
});
route('POST', '/api/credentials', ({ body }) => { if (!describe().credentialTypes[body.type]) throw new HttpError(400, 'Bilinmeyen kimlik bilgisi türü'); return store.saveCredential(body); });
route('POST', '/api/credentials/test', async ({ body }) => {
  const t = describe().credentialTypes[body.type]; if (!t) throw new HttpError(400, 'Bilinmeyen kimlik bilgisi türü');
  const saved = body.id ? store.getCredentialData(body.id) : null;
  const data = Object.fromEntries(t.fields.map(f => [f.key, body.data?.[f.key] || (f.secret && saved?.type === body.type ? saved.data[f.key] : '') || '']));
  try { const msg = await testCredential(body.type, data); return { ok: true, message: msg || 'Bu tür için deneme yok' }; }
  catch (e) { return { ok: false, message: e.message }; }
});
route('PUT', '/api/credentials/:id', ({ params, body }) => {
  const cur = store.listCredentials().find(c => c.id === params.id); if (!cur) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  return store.saveCredential({ ...body, id: params.id, type: cur.type });
});
route('DELETE', '/api/credentials/:id', ({ params }) => { store.deleteCredential(params.id); return { ok: true }; });
route('GET', '/api/variables', () => store.getVariables());
route('PUT', '/api/variables', ({ body }) => store.setVariables(body));
route('GET', '/api/workflows/:id/status', ({ params }) => {
  const out = {}; for (const [k, v] of pollState) if (k.startsWith(params.id + ':')) out[k.split(':')[1]] = v;
  return { nextRuns: nextRuns(params.id), polls: out };
});
route('DELETE', '/api/workflows/:id/memory', ({ params }) => { store.clearStatic(params.id); return { ok: true }; });

/* data tables */
route('GET', '/api/tables', () => store.listTables());
route('POST', '/api/tables', ({ body }) => store.createTable(body.name, body.columns || []));
route('GET', '/api/tables/:id', ({ params, query }) => {
  const t = store.getTable(params.id);
  const q = String(query.q || '').toLocaleLowerCase('tr');
  const r = store.queryRows(t.id, q ? row => Object.values(row).some(v => String(v ?? '').toLocaleLowerCase('tr').includes(q)) : () => true, { limit: Math.min(Number(query.limit) || 100, 1000), offset: Number(query.offset) || 0 });
  return { id: t.id, name: t.name, columns: t.columns, rowCount: t.rows.length, total: r.total, rows: r.rows, updatedAt: t.updatedAt };
});
route('PUT', '/api/tables/:id', ({ params, body }) => store.updateTable(params.id, body));
route('DELETE', '/api/tables/:id', ({ params }) => { store.deleteTable(params.id); return { ok: true }; });
route('POST', '/api/tables/:id/rows', ({ params, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [body.row || {}];
  return { added: store.insertRows(params.id, rows.filter(r => r && typeof r === 'object')).length };
});
route('PUT', '/api/tables/:id/rows/:rowId', ({ params, body }) => {
  const changed = store.updateRows(params.id, r => String(r._id) === params.rowId, body.data || {});
  if (!changed.length) throw new HttpError(404, 'Satır bulunamadı'); return changed[0];
});
route('DELETE', '/api/tables/:id/rows/:rowId', ({ params }) => ({ deleted: store.deleteRows(params.id, r => String(r._id) === params.rowId).length }));
route('POST', '/api/tables/:id/clear', ({ params }) => ({ deleted: store.deleteRows(params.id, () => true).length }));

/* AI builder and n8n import */
route('POST', '/api/ai/build', async ({ body }) => {
  const credId = body.credential || store.listCredentials().find(c => c.type === 'anthropicApi')?.id;
  if (!credId) throw new HttpError(400, 'Önce Kimlik bilgileri sayfasından bir Anthropic (Claude) API anahtarı ekleyin');
  const cred = store.getCredentialData(credId);
  if (!cred || cred.type !== 'anthropicApi') throw new HttpError(400, 'Seçilen kimlik bilgisi bir Anthropic API anahtarı değil');
  if (!String(body.prompt || '').trim()) throw new HttpError(400, 'Ne yapmak istediğinizi yazın');
  const current = body.workflowId ? store.getWorkflow(body.workflowId) : null;
  return aiBuilder.build({ prompt: String(body.prompt).slice(0, 8000), apiKey: cred.data.apiKey, model: body.model || 'claude-opus-5-5', current });
});
route('POST', '/api/import/convert', ({ body }) => {
  if (n8n.isN8n(body)) return { source: 'n8n', ...n8n.convertN8n(body) };
  if (Array.isArray(body.nodes) && Array.isArray(body.edges)) return { source: '8n8', workflow: body, notes: [] };
  throw new HttpError(400, 'Bu dosya bir 8n8 ya da n8n akışı gibi görünmüyor');
});

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

/* DNS-rebinding guard: while 8n8 listens only on this computer, the editor and API answer only to
   requests addressed to this computer (or to N8N8_URL / N8N8_ALLOWED_HOSTS). Public webhook, form and
   chat addresses are not affected, so tunnels keep working. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', new URL(PUBLIC_URL).hostname, ...String(process.env.N8N8_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)]);
function hostAllowed(req) {
  if (!LOOPBACK) return true;
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(h)) return false;
  const o = req.headers.origin;
  if (o && req.method !== 'GET' && req.method !== 'HEAD') { try { if (!ALLOWED_HOSTS.has(new URL(o).hostname.toLowerCase()) && `[${new URL(o).hostname}]` !== h) return false; } catch { return false; } }
  return true;
}
const UNAUTH = res => send(res, 401, 'Giriş gerekli', { 'WWW-Authenticate': 'Basic realm="8n8"' });

const server = http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'Geçersiz adres'); }
  try {
    let m;
    if ((m = p.match(/^\/(webhook|webhook-test|form|form-test|sohbet|sohbet-test)\/(.+)$/))) {
      const test = m[1].endsWith('-test');
      if (test && (!authorized(req) || !hostAllowed(req))) return UNAUTH(res); // test addresses run drafts: editor users only
      const kind = m[1].replace('-test', '');
      return await (kind === 'webhook' ? handleWebhook : kind === 'form' ? handleForm : handleChat)(req, res, cleanPath(m[2]), test);
    }
    if (!hostAllowed(req)) return send(res, 403, 'Bu adresten erişime izin verilmiyor. Başka bir adres kullanıyorsanız N8N8_ALLOWED_HOSTS ile ekleyin.');
    if (!authorized(req)) return UNAUTH(res);
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
// one failed background save or a stray promise must not take every workflow down with it
process.on('unhandledRejection', e => console.error('Beklenmeyen hata:', e));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\n  8n8 kapatılıyor…'); for (const id of engine.runningIds()) engine.stop(id); setTimeout(() => process.exit(0), 300); });

module.exports = { server };
