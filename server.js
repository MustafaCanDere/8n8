#!/usr/bin/env node
'use strict';
/* Auto-Move — local workflow automation server.
   Serves the editor, the REST API, live events, webhooks, hosted forms and the scheduler. */
if (Number(process.versions.node.split('.')[0]) < 20) { console.error(`\n  Auto-Move için Node.js 20 ya da daha yeni bir sürüm gerekir (şu an ${process.version}). https://nodejs.org adresinden LTS sürümünü kurun.\n`); process.exit(1); }
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const engine = require('./lib/engine');
const { AI, MAIL, NODES, describe, defaults, CREDENTIAL_TYPES, testCredential } = require('./lib/nodes');
const backup = require('./lib/backup');
const kb = require('./lib/kb');
const notify = require('./lib/notify');
const multipart = require('./lib/multipart');
const crypto = require('crypto');
const oauth = require('./lib/oauth');
const { nextRun } = require('./lib/cron');
const templates = require('./lib/templates');
const aiBuilder = require('./lib/ai-builder');
const n8n = require('./lib/n8n-import');
const pkg = require('./package.json');
const { readAsset } = require('./lib/sea');
const desktop = require('./lib/desktop');
const users = require('./lib/users');

const PORT = Number(process.env.PORT || process.env.N8N8_PORT || 5678);
const HOST = process.env.N8N8_HOST || '127.0.0.1';
const PASSWORD = process.env.N8N8_PASSWORD || '';
const PUBLIC_URL = (process.env.N8N8_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`).replace(/\/$/, '');
const MAX_BODY = 16 * 1024 * 1024;
const UPLOAD_MAX = Number(process.env.N8N8_UPLOAD_MB || 50) * 1024 * 1024; // webhook and form uploads

/* ---------------- helpers ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req, max = MAX_BODY, files = false) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, `İstek gövdesi çok büyük (${Math.round(max / 1048576)} MB sınırı)`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('multipart/form-data')) { if (!files) return reject(new HttpError(415, 'Burada dosya yüklenemez')); try { return resolve(multipart.save(multipart.parse(buf, ct))); } catch (e) { return reject(e.status ? e : new HttpError(400, `Yüklenen dosyalar okunamadı: ${e.message}`)); } }
      const raw = buf.toString('utf8');
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
/* the "Kimlik doğrulama" option of webhook and MCP triggers; returns null when the request may pass */
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function credAuthError(req, params) {
  if (!params.auth || params.auth === 'none') return null;
  const cred = params.credential ? store.getCredentialData(params.credential) : null;
  if (!cred) return { status: 500, message: 'Kimlik doğrulaması açık ama kimlik bilgisi seçilmemiş' };
  const h = req.headers;
  const ok = cred.type === 'httpBasic'
    ? (() => { const a = String(h.authorization || ''); if (!a.startsWith('Basic ')) return false; const [u, ...rest] = Buffer.from(a.slice(6), 'base64').toString().split(':'); return safeEqual(u, cred.data.user) && safeEqual(rest.join(':'), cred.data.password); })()
    : cred.type === 'httpHeader' ? safeEqual(h[String(cred.data.name || '').toLowerCase()] || '', cred.data.value || '')
    : cred.type === 'httpBearer' ? safeEqual(h.authorization || '', `Bearer ${cred.data.token}`) : false;
  return ok ? null : { status: 401, message: 'Yetkisiz', headers: cred.type === 'httpBasic' ? { 'WWW-Authenticate': 'Basic realm="Auto-Move"' } : {} };
}
async function handleWebhook(req, res, p, test) {
  const hit = findTriggerNode('webhook', p, req.method, test);
  if (!hit) {
    const other = findTriggerNode('webhook', p, req.method, true);
    return send(res, 404, { hata: other ? `"${other.wf.name}" akışı etkin değil. Etkinleştirin ya da /webhook-test/${p} adresini kullanın.` : `/${test ? 'webhook-test' : 'webhook'}/${p} için ${req.method} kabul eden bir webhook yok` });
  }
  const denied = credAuthError(req, hit.params);
  if (denied) return send(res, denied.status, { hata: denied.message }, denied.headers);
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req, UPLOAD_MAX, true);
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
    const input = f.type === 'textarea' ? `<textarea id="${id}" name="${esc(f.name)}" rows="5"${req}></textarea>` : f.type === 'file' ? `<input id="${id}" name="${esc(f.name)}" type="file"${req}>` : `<input id="${id}" name="${esc(f.name)}" type="${['email', 'number', 'date', 'tel'].includes(f.type) ? f.type : 'text'}"${req}>`;
    return `<label for="${id}">${esc(f.label)}${f.required ? ' <span>*</span>' : ''}</label>${input}`;
  }).join('');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(params.title)}</title>
<style>:root{--bg:#eef1f4;--card:#fff;--fg:#15202b;--muted:#5a6876;--line:#d6dde4;--accent:#0b7563}@media(prefers-color-scheme:dark){:root{--bg:#0d1217;--card:#151c23;--fg:#e2e8ee;--muted:#8b9aa8;--line:#2a3540;--accent:#2fc2a6}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px;box-sizing:border-box}
form,.done{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:460px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 12px;color:var(--muted)}label{font-weight:600;font-size:13px;margin-top:8px}label span{color:#c62828}
input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}input:focus,textarea:focus{outline:2px solid var(--accent);border-color:transparent}
button{margin-top:16px;font:inherit;font-weight:600;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:11px;cursor:pointer}.err{color:#c62828}.test{font-size:12px;color:var(--muted);text-align:center}</style></head><body>
${message ? `<div class="done"><h1>${esc(message)}</h1></div>` : `<form method="post"${(params.fields || []).some(f => f.type === 'file') ? ' enctype="multipart/form-data"' : ''}><h1>${esc(params.title)}</h1>${params.description ? `<p>${esc(params.description)}</p>` : ''}${error ? `<p class="err">${esc(error)}</p>` : ''}${fields}<button type="submit">Gönder</button>${test ? '<div class="test">Test formu: akış kapalıyken de çalışır.</div>' : ''}</form>`}
</body></html>`;
}
async function handleForm(req, res, p, test) {
  const hit = findTriggerNode('form', p, req.method, test);
  if (!hit) return send(res, 404, formPage({ title: 'Form bulunamadı' }, { message: 'Bu form bulunamadı ya da şu an kapalı.' }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method === 'GET') return send(res, 200, formPage(hit.params, { test }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.method !== 'POST') return send(res, 405, 'Yalnızca GET ve POST');
  const body = await readBody(req, UPLOAD_MAX, (hit.params.fields || []).some(f => f.type === 'file'));
  const values = {};
  for (const f of hit.params.fields || []) {
    let v = typeof body === 'object' ? body[f.name] ?? '' : '';
    if (f.type === 'number' && v !== '') v = Number(v);
    if (f.type === 'file' && typeof v !== 'object') v = '';
    if (f.required && (v === '' || v == null)) return send(res, 400, formPage(hit.params, { error: `"${f.label}" alanı zorunlu.`, test }), { 'Content-Type': 'text/html; charset=utf-8' });
    values[f.name] = v;
  }
  engine.start(hit.wf, { triggerId: hit.node.id, triggerData: { values: { ...values, gonderimZamani: new Date().toISOString() } }, mode: test ? 'form testi' : 'form' });
  send(res, 200, formPage(hit.params, { message: hit.params.thanks || 'Teşekkürler!' }), { 'Content-Type': 'text/html; charset=utf-8' });
}

/* ---------------- WhatsApp webhook ---------------- */
function readRaw(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(new HttpError(413, 'İstek gövdesi çok büyük')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function handleWhatsapp(req, res, p, url) {
  const hit = findTriggerNode('whatsappTrigger', p, req.method, false);
  if (!hit) return send(res, 404, { hata: `/whatsapp/${p} için etkin bir WhatsApp tetikleyicisi yok` });
  const cred = hit.params.credential ? store.getCredentialData(hit.params.credential) : null;
  if (!cred) return send(res, 500, { hata: 'WhatsApp hesabı seçilmemiş' });
  if (req.method === 'GET') { // Meta's subscription check
    const q = url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && cred.data.verifyToken && safeEqual(q.get('hub.verify_token') || '', cred.data.verifyToken)) return send(res, 200, q.get('hub.challenge') || '', { 'Content-Type': 'text/plain' });
    return send(res, 403, 'Doğrulama sözcüğü uyuşmuyor');
  }
  if (req.method !== 'POST') return send(res, 405, 'Yalnızca GET ve POST');
  const raw = await readRaw(req);
  if (!MAIL.verifySignature(raw, req.headers['x-hub-signature-256'], cred.data.appSecret)) return send(res, 401, 'İmza geçersiz');
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'Geçersiz JSON'); }
  send(res, 200, { durum: 'alındı' }); // Meta wants a quick 200; the workflow runs afterwards
  for (const item of MAIL.whatsappItems(body, { statuses: !!hit.params.statuses }))
    try { engine.start(hit.wf, { triggerId: hit.node.id, triggerData: { items: [item] }, mode: 'whatsapp' }); } catch (e) { console.error('WhatsApp:', e.message); }
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
const clients = new Map(); // response -> signed-in user (null: single-user mode)
engine.events.on('event', ev => {
  const line = `data: ${JSON.stringify(ev)}\n\n`; const wf = ev.workflowId ? store.getWorkflow(ev.workflowId) : null;
  for (const [c, u] of clients) if (!u || !ev.workflowId || users.canWf(u, wf, 'gor')) c.write(line);
});
setInterval(() => { for (const c of clients.keys()) c.write(': ping\n\n'); }, 25000).unref();

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
  for (const n of wf.nodes) if (NODES[n.type]?.poll && !n.disabled && NODES[n.type].params.some(f => f.key === 'credential') && !n.params?.credential) throw new HttpError(400, `"${n.name}": ${NODES[n.type].params.find(f => f.key === 'credential').label} seçin`);
  for (const n of wf.nodes) {
    if (n.type === 'schedule' && n.params?.mode === 'cron') { try { nextRun(n.params.cron); } catch (e) { throw new HttpError(400, `"${n.name}": ${e.message}`); } }
    if (n.type === 'mcpTrigger' && !n.disabled) {
      const params = { ...defaults('mcpTrigger'), ...n.params };
      const p = cleanPath(params.path), tool = String(params.tool || '').trim();
      if (!p || !/^[A-Za-z0-9._~\-/]+$/.test(p)) throw new HttpError(400, `"${n.name}": sunucu adresi yalnızca harf, rakam, - ve / içerebilir`);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool)) throw new HttpError(400, `"${n.name}": araç adı yalnızca İngilizce harf, rakam, _ ve - içerebilir`);
      try { AI.toolOf(params); } catch (e) { throw new HttpError(400, `"${n.name}": ${e.message}`); }
      for (const other of store.listWorkflows()) {
        if (other.id === wf.id || !other.active) continue;
        if (other.nodes.some(o => o.type === 'mcpTrigger' && !o.disabled && cleanPath(o.params?.path ?? 'araclar') === p && String(o.params?.tool ?? '').trim() === tool))
          throw new HttpError(409, `"${tool}" aracı /mcp/${p} adresinde "${other.name}" akışında zaten var`);
      }
    }
    if (n.type === 'whatsappTrigger' && !n.disabled && !n.params?.credential) throw new HttpError(400, `"${n.name}": WhatsApp hesabı seçilmemiş`);
    if (['webhook', 'form', 'chatTrigger', 'whatsappTrigger'].includes(n.type) && !n.disabled) {
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
const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/approvals', ({ user }) => [...engine.approvals.entries()].filter(([, a]) => !a.workflowId || users.canWf(user, store.getWorkflow(a.workflowId), 'gor')).map(([token, a]) => ({ url: `${PUBLIC_URL}/onay/${token}`, execId: a.execId, workflow: a.workflow, node: a.node, message: a.message, since: a.since })));
route('GET', '/api/info', () => ({ version: pkg.version, url: PUBLIC_URL, oauthRedirect: OAUTH_REDIRECT, data: store.DATA, files: store.DIRS.files, password: !!PASSWORD, host: HOST, node: process.version }));
route('GET', '/api/node-types', () => describe());
route('GET', '/api/workflows', ({ user }) => store.listWorkflows().filter(w => users.canWf(user, w, 'gor')).map(w => ({ ...workflowSummary(w), sahip: w.sahip, sahipAd: users.get(w.sahip)?.ad || '', erisim: users.wfLevel(user, w) })));
function checkTypes(nodes) {
  const unknown = (Array.isArray(nodes) ? nodes : []).find(n => n && !NODES[n.type]);
  if (unknown) throw new HttpError(400, `Bilinmeyen node türü: ${String(unknown.type).slice(0, 60)} ("${String(unknown.name || '').slice(0, 60)}")`);
}
/* a team member may only put credentials they can use into a workflow; ones already in it stay */
function checkCreds(user, nodes, before = []) {
  if (!user || user.rol === 'yonetici') return;
  const ids = ns => new Set((Array.isArray(ns) ? ns : []).flatMap(n => Object.entries(n?.params || {}).filter(([k, v]) => /credential$/i.test(k) && typeof v === 'string' && v).map(([, v]) => v)));
  const old = ids(before); const all = store.listCredentials();
  for (const id of ids(nodes)) {
    if (old.has(id)) continue;
    const c = all.find(x => x.id === id);
    if (c && !users.canCred(user, c)) throw new HttpError(403, `"${c.name}" kimlik bilgisini kullanma izniniz yok`);
  }
}
const owned = (user, wf) => ({ ...wf, sahip: user ? user.id : wf.sahip ?? null, paylasim: user ? {} : wf.paylasim || {} });
route('POST', '/api/workflows', async ({ body, user }) => {
  checkTypes(body.nodes); checkCreds(user, body.nodes);
  const wf = store.saveWorkflow(owned(user, { ...body, id: undefined, active: false }));
  return wf;
});
route('GET', '/api/workflows/:id', ({ params, user }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  return { ...wf, nextRuns: nextRuns(wf.id), erisim: users.wfLevel(user, wf) };
});
route('PUT', '/api/workflows/:id', ({ params, body, user }) => {
  const cur = store.getWorkflow(params.id); if (!cur) throw new HttpError(404, 'Akış bulunamadı');
  checkTypes(body.nodes); checkCreds(user, body.nodes, cur.nodes);
  const next = { ...cur, ...body, id: cur.id, sahip: cur.sahip, paylasim: cur.paylasim }; // owner and sharing change only through /share
  if (next.active) validateActivation(next);
  const wf = store.saveWorkflow(next);
  arm(wf);
  return { ...wf, nextRuns: nextRuns(wf.id) };
});
/* full backup / restore (settings page) */
route('POST', '/api/backup', ({ body }) => {
  const password = String(body.password || '');
  if (password && password.length < 8) throw new HttpError(400, 'Yedek şifresi en az 8 karakter olmalı');
  return backup.create({ password, version: pkg.version });
});
route('POST', '/api/restore', ({ body }) => {
  const r = backup.restore(body.backup, { password: String(body.password || ''), checkWorkflow: w => checkTypes(w?.nodes) });
  const wasActive = new Map((body.backup.akislar || []).map(w => [w?.id, !!w?.active]));
  let active = 0;
  for (const wf of r.akislar) {
    disarm(wf.id);
    if (!wasActive.get(wf.id)) continue;
    try { validateActivation({ ...wf, active: true }); arm(store.saveWorkflow({ ...wf, active: true }, { version: false })); active++; }
    catch (e) { r.atlanan.push(`${wf.name}: geri yüklendi ama etkinleştirilemedi (${e.message})`); }
  }
  return { akislar: r.akislar.length, etkin: active, tablolar: r.tablolar, bilgiTabanlari: r.bilgiTabanlari, degiskenler: r.degiskenler, kimlikBilgileri: r.kimlikBilgileri, uyarilar: r.atlanan };
});
route('DELETE', '/api/workflows/:id', ({ params }) => { disarm(params.id); store.deleteWorkflow(params.id); return { ok: true }; });
/* error notifications (settings page) */
engine.onEnd((wf, exec) => { notify.onEnd(wf, exec, PUBLIC_URL); desktop.onEnd(wf, exec, PUBLIC_URL); });
route('GET', '/api/notify', () => notify.get());
/* desktop: start with the computer, updates */
route('GET', '/api/desktop', () => desktop.info());
route('PUT', '/api/desktop', async ({ body }) => {
  if ('guncellemeDenetle' in body) desktop.saveSettings({ guncellemeDenetle: !!body.guncellemeDenetle });
  if ('autostart' in body) await desktop.setAutostart(!!body.autostart);
  return desktop.info();
});
route('POST', '/api/desktop/update/check', () => desktop.checkUpdate());
route('POST', '/api/desktop/update/install', async () => {
  const r = await desktop.installUpdate();
  r.restarting = require('./lib/sea').inSea && !process.env.N8N8_NO_RESTART;
  if (r.restarting) setTimeout(() => shutdown(true), 500);
  return r;
});
route('PUT', '/api/notify', ({ body }) => notify.set(body));
route('POST', '/api/notify/test', async ({ body }) => {
  const s = { ...notify.get(), ...body };
  if (!s.kanal) throw new HttpError(400, 'Önce bir kanal seçin');
  try { await notify.send('✅ Auto-Move deneme bildirimi: hata bildirimleri bu kanala gelecek.', 'Auto-Move deneme bildirimi', s); } catch (e) { throw new HttpError(400, e.message); }
  return { ok: true };
});
route('GET', '/api/trash', () => store.listTrash());
route('POST', '/api/trash/:id/restore', ({ params }) => store.restoreTrash(params.id));
route('DELETE', '/api/trash/:id', ({ params }) => { store.purgeTrash(params.id); return { ok: true }; });
route('DELETE', '/api/trash', () => { store.purgeTrash(); return { ok: true }; });
route('POST', '/api/workflows/:id/duplicate', ({ params, user }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  if (user && !users.atLeast(user, 'duzenleyici')) throw new HttpError(403, 'Bu işlem için düzenleyici rolü gerekir');
  return store.saveWorkflow(owned(user, { ...JSON.parse(JSON.stringify(wf)), id: undefined, name: `${wf.name} (kopya)`, active: false }));
});
/* team use: who else may see or edit this workflow */
route('PUT', '/api/workflows/:id/share', ({ params, body }) => {
  const wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı');
  if (!users.enabled()) throw new HttpError(400, 'Paylaşım için önce Ayarlar sayfasından ekip kullanımını açın');
  const sahip = body.sahip !== undefined && users.get(body.sahip) ? body.sahip : wf.sahip;
  return store.saveWorkflow({ ...wf, sahip, paylasim: users.cleanShare(body.paylasim, sahip) }, { version: false });
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
const seesExec = user => { if (!user || user.rol === 'yonetici') return () => true; const m = new Map(); return e => { if (!m.has(e.workflowId)) m.set(e.workflowId, users.canWf(user, store.getWorkflow(e.workflowId), 'gor')); return m.get(e.workflowId); }; };
route('GET', '/api/executions', ({ query, user }) => {
  const ok = seesExec(user); const limit = Number(query.limit) || undefined;
  const items = user && user.rol !== 'yonetici' ? store.listExecutions({ workflowId: query.workflowId, status: query.status, all: true }).filter(ok).slice(0, Math.min(limit || 50, 500)) : store.listExecutions({ workflowId: query.workflowId, status: query.status, limit: query.limit });
  return { items, running: engine.runningIds().filter(id => { const e = store.getExecution(id); return !e || ok(e); }) };
});
/* "Özet" page: counts, success rate, per-day chart, per-workflow table and most frequent errors, from the kept execution records */
route('GET', '/api/stats', ({ query, user }) => {
  const days = Math.min(365, Math.max(1, Number(query.days) || 7));
  const dayKey = d => new Date(d).toLocaleDateString('sv');
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - days + 1);
  const list = store.listExecutions({ all: true }).filter(e => e.startedAt >= from.toISOString()).filter(seesExec(user));
  const byDay = new Map(); for (let i = 0; i < days; i++) { const d = new Date(from); d.setDate(d.getDate() + i); byDay.set(dayKey(d), { gun: dayKey(d), basarili: 0, hatali: 0, diger: 0 }); }
  const byWf = new Map(), errors = new Map(), modes = {};
  const done = list.filter(e => e.status === 'success' || e.status === 'error');
  const durs = list.filter(e => e.duration != null).map(e => e.duration).sort((a, b) => a - b);
  for (const e of list) {
    const d = byDay.get(dayKey(e.startedAt)); if (d) d[e.status === 'success' ? 'basarili' : e.status === 'error' ? 'hatali' : 'diger']++;
    modes[e.mode] = (modes[e.mode] || 0) + 1;
    const w = byWf.get(e.workflowId) || { id: e.workflowId, ad: store.getWorkflow(e.workflowId)?.name || e.workflowName, toplam: 0, basarili: 0, hatali: 0, sure: 0, sureSay: 0, son: null, sonDurum: null };
    w.toplam++; if (e.status === 'success') w.basarili++; if (e.status === 'error') w.hatali++;
    if (e.duration != null) { w.sure += e.duration; w.sureSay++; }
    if (!w.son || e.startedAt > w.son) { w.son = e.startedAt; w.sonDurum = e.status; }
    byWf.set(e.workflowId, w);
    if (e.status === 'error' && e.error) {
      const k = `${e.workflowId}\n${String(e.error).slice(0, 160)}`;
      const x = errors.get(k) || { hata: String(e.error).slice(0, 300), akis: w.ad, akisId: e.workflowId, sayi: 0, son: '', sonId: '' };
      x.sayi++; if (e.startedAt > x.son) { x.son = e.startedAt; x.sonId = e.id; }
      errors.set(k, x);
    }
  }
  const success = list.filter(e => e.status === 'success').length;
  return {
    gun: days,
    toplam: list.length, basarili: success, hatali: list.filter(e => e.status === 'error').length, calisiyor: engine.runningIds().length,
    basariOrani: done.length ? Math.round(success / done.length * 1000) / 10 : null,
    ortSure: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    p95Sure: durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : null,
    etkinAkis: store.listWorkflows().filter(w => w.active && users.canWf(user, w, 'gor')).length, akisSayisi: store.listWorkflows().filter(w => users.canWf(user, w, 'gor')).length, bekleyenOnay: engine.approvals.size,
    gunluk: [...byDay.values()], sekiller: modes,
    akislar: [...byWf.values()].map(({ sure, sureSay, ...w }) => ({ ...w, ortSure: sureSay ? Math.round(sure / sureSay) : null })).sort((a, b) => b.toplam - a.toplam),
    hatalar: [...errors.values()].sort((a, b) => b.sayi - a.sayi || b.son.localeCompare(a.son)).slice(0, 10),
    kayitSiniri: Number(process.env.N8N8_MAX_EXECUTIONS || 1000),
  };
});
route('GET', '/api/executions/:id', ({ params }) => { const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı'); return e; });
/* "Editörde hata ayıkla": pin the trigger output of a past run so editor runs replay it */
route('POST', '/api/executions/:id/debug', ({ params }) => {
  const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı');
  const wf = store.getWorkflow(e.workflowId); if (!wf) throw new HttpError(404, 'Akış silinmiş');
  const node = wf.nodes.find(n => n.id === e.triggerId);
  if (!node) throw new HttpError(409, `"${e.trigger}" tetikleyicisi artık akışta yok`);
  const out = e.nodes?.[e.triggerId]?.output?.[0];
  if (!Array.isArray(out) || !out.length) throw new HttpError(409, 'Bu çalıştırmada tetikleyicinin çıktısı kayıtlı değil');
  const saved = store.saveWorkflow({ ...wf, nodes: wf.nodes.map(n => (n.id === node.id ? { ...n, pinData: out.filter(i => !i.json?._kesildi).map(i => i.json) } : n)) });
  arm(saved);
  return { workflowId: wf.id, node: node.name, items: out.length };
});
route('DELETE', '/api/executions/:id', ({ params }) => { store.deleteExecution(params.id); return { ok: true }; });
route('POST', '/api/executions/:id/stop', ({ params }) => ({ stopped: engine.stop(params.id) }));
route('POST', '/api/executions/:id/retry', ({ params, body }) => {
  const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı');
  const wf = store.getWorkflow(e.workflowId); if (!wf) throw new HttpError(404, 'Akış artık yok');
  const source = body.useCurrent ? wf : { ...wf, nodes: e.snapshot.nodes, edges: e.snapshot.edges };
  const { exec } = engine.start(source, { triggerId: e.triggerId, triggerData: e.triggerData, mode: 'yeniden deneme', retryOf: e.id });
  return { executionId: exec.id };
});
route('DELETE', '/api/executions', ({ query, user }) => {
  if (user && user.rol !== 'yonetici' && !(query.workflowId && users.canWf(user, store.getWorkflow(query.workflowId), 'duzenle'))) throw new HttpError(403, 'Bütün çalıştırma kayıtlarını yalnızca yönetici silebilir');
  const running = new Set(engine.runningIds()); let n = 0;
  for (const e of store.listExecutions({ workflowId: query.workflowId || undefined, status: query.status || undefined, all: true })) if (!running.has(e.id)) { store.deleteExecution(e.id); n++; }
  return { ok: true, silinen: n };
});
route('GET', '/api/credentials', ({ user }) => store.listCredentials().filter(c => users.canCred(user, c)).map(c => ({ ...c, sahipAd: users.get(c.sahip)?.ad || '', erisim: users.canCred(user, c, 'sahip') ? 'sahip' : 'kullan' })));
route('GET', '/api/credentials/:id', ({ params }) => {
  const c = store.getCredentialData(params.id); if (!c) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  const t = describe().credentialTypes[c.type];
  const data = Object.fromEntries((t?.fields || []).map(f => [f.key, f.secret ? '' : c.data[f.key] ?? '']));
  const filled = Object.fromEntries((t?.fields || []).filter(f => f.secret).map(f => [f.key, !!c.data[f.key]]));
  return { id: c.id, name: c.name, type: c.type, data, filled, ...(oauth.isOAuth(c.type) ? { connected: !!c.data.access_token, account: c.data.account || '' } : {}) };
});
route('POST', '/api/credentials', ({ body, user }) => { if (!describe().credentialTypes[body.type]) throw new HttpError(400, 'Bilinmeyen kimlik bilgisi türü'); return store.saveCredential({ name: body.name, type: body.type, data: body.data, sahip: user ? user.id : null, paylasim: [] }); });
route('PUT', '/api/credentials/:id/share', ({ params, body }) => {
  const c = store.listCredentials().find(x => x.id === params.id); if (!c) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  if (!users.enabled()) throw new HttpError(400, 'Paylaşım için önce Ayarlar sayfasından ekip kullanımını açın');
  const r = store.saveCredential({ id: c.id, type: c.type, data: {}, paylasim: users.cleanCredShare(body.paylasim, c.sahip) });
  return { ...r, paylasim: store.listCredentials().find(x => x.id === c.id).paylasim };
});
route('POST', '/api/credentials/test', async ({ body, user }) => {
  const t = describe().credentialTypes[body.type]; if (!t) throw new HttpError(400, 'Bilinmeyen kimlik bilgisi türü');
  const saved = body.id && users.canCred(user, store.listCredentials().find(c => c.id === body.id), 'sahip') ? store.getCredentialData(body.id) : null;
  const data = Object.fromEntries(t.fields.map(f => [f.key, body.data?.[f.key] || (f.secret && saved?.type === body.type ? saved.data[f.key] : '') || '']));
  try { const msg = await testCredential(body.type, data); return { ok: true, message: msg || 'Bu tür için deneme yok' }; }
  catch (e) { return { ok: false, message: e.message }; }
});
route('PUT', '/api/credentials/:id', ({ params, body }) => {
  const cur = store.listCredentials().find(c => c.id === params.id); if (!cur) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
  return store.saveCredential({ name: body.name, data: body.data, id: params.id, type: cur.type });
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
route('POST', '/api/tables/:id/import', ({ params, body }) => {
  const X = require('./lib/xlsx');
  const sheets = X.readWorkbook(Buffer.from(String(body.icerik || ''), 'base64'));
  const rows = X.toItems(X.pickSheet(sheets, body.sayfa || '').rows).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))));
  return { added: store.insertRows(params.id, rows).length, sayfa: X.pickSheet(sheets, body.sayfa || '').name };
});
route('GET', '/api/tables/:id/xlsx', ({ params }) => {
  const t = store.getTable(params.id);
  const rows = t.rows.map(r => Object.fromEntries(t.columns.map(c => [c, r[c] ?? null])));
  return { ad: `${t.name}.xlsx`, icerik: require('./lib/xlsx').write(rows.length ? rows : [Object.fromEntries(t.columns.map(c => [c, null]))], { sheet: t.name }).toString('base64') };
});
route('PUT', '/api/tables/:id/rows/:rowId', ({ params, body }) => {
  const changed = store.updateRows(params.id, r => String(r._id) === params.rowId, body.data || {});
  if (!changed.length) throw new HttpError(404, 'Satır bulunamadı'); return changed[0];
});
route('DELETE', '/api/tables/:id/rows/:rowId', ({ params }) => ({ deleted: store.deleteRows(params.id, r => String(r._id) === params.rowId).length }));
route('POST', '/api/tables/:id/clear', ({ params }) => ({ deleted: store.deleteRows(params.id, () => true).length }));
/* knowledge bases ("Bilgi tabanı") */
route('GET', '/api/kb', () => kb.list());
route('POST', '/api/kb', ({ body }) => kb.create(body.name));
route('GET', '/api/kb/:id', ({ params }) => kb.getKb(params.id));
route('PUT', '/api/kb/:id', ({ params, body }) => kb.rename(params.id, body.name));
route('DELETE', '/api/kb/:id', ({ params }) => { kb.remove(params.id); return { ok: true }; });
route('POST', '/api/kb/:id/docs', ({ params, body }) => {
  if (body.url) return kb.addUrl(params.id, body.url, body.ad);
  if (body.icerik != null) return kb.addDoc(params.id, body.ad, Buffer.from(String(body.icerik), 'base64'));
  return kb.addDoc(params.id, body.ad || 'metin.txt', String(body.metin ?? ''));
});
route('DELETE', '/api/kb/:id/docs/:docId', ({ params }) => { kb.removeDoc(params.id, params.docId); return { ok: true }; });
route('GET', '/api/kb/:id/search', ({ params, query }) => kb.search(params.id, query.q || '', query.k || 5));

/* AI builder and n8n import */
route('POST', '/api/ai/build', async ({ body, user }) => {
  const credId = body.credential || store.listCredentials().find(c => c.type === 'anthropicApi' && users.canCred(user, c))?.id;
  if (credId && !users.canCred(user, store.listCredentials().find(c => c.id === credId))) throw new HttpError(403, 'Bu kimlik bilgisini kullanma izniniz yok');
  if (!credId) throw new HttpError(400, 'Önce Kimlik bilgileri sayfasından bir Anthropic (Claude) API anahtarı ekleyin');
  const cred = store.getCredentialData(credId);
  if (!cred || cred.type !== 'anthropicApi') throw new HttpError(400, 'Seçilen kimlik bilgisi bir Anthropic API anahtarı değil');
  if (!String(body.prompt || '').trim()) throw new HttpError(400, 'Ne yapmak istediğinizi yazın');
  const current = body.workflowId && users.canWf(user, store.getWorkflow(body.workflowId), 'gor') ? store.getWorkflow(body.workflowId) : null;
  return aiBuilder.build({ prompt: String(body.prompt).slice(0, 8000), apiKey: cred.data.apiKey, model: body.model || 'claude-opus-5-5', current });
});
route('POST', '/api/import/convert', ({ body }) => {
  if (n8n.isN8n(body)) return { source: 'n8n', ...n8n.convertN8n(body) };
  if (Array.isArray(body.nodes) && Array.isArray(body.edges)) return { source: 'Auto-Move', workflow: body, notes: [] };
  throw new HttpError(400, 'Bu dosya bir Auto-Move ya da n8n akışı gibi görünmüyor');
});

route('GET', '/api/templates', () => templates.LIST);
route('POST', '/api/templates/:key', ({ params, user }) => {
  const t = templates.TEMPLATES[params.key]; if (!t) throw new HttpError(404, 'Şablon bulunamadı');
  return store.saveWorkflow(owned(user, { ...t(), active: false }));
});
route('GET', '/api/files', () => {
  const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name), path.join(base, d.name)) : [{ ad: path.join(base, d.name), boyut: fs.statSync(path.join(dir, d.name)).size, degisti: fs.statSync(path.join(dir, d.name)).mtime }]);
  return walk(store.DIRS.files);
});
/* ---------- team use: accounts, sign-in, activity log ---------- */
const COOKIE = 'am_oturum';
const cookieOf = req => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)am_oturum=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; };
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${PUBLIC_URL.startsWith('https:') ? '; Secure' : ''}`;
const clientIp = req => req.socket.remoteAddress || '';
route('GET', '/api/me', ({ user }) => ({ ekip: users.enabled(), kullanici: user ? users.pub(user) : null, roller: users.ROLES }));
route('POST', '/api/login', ({ body, req, cookies }) => {
  if (!users.enabled()) throw new HttpError(400, 'Ekip kullanımı açık değil');
  const u = users.verify(body.kullanici, body.sifre, clientIp(req));
  if (!u) { users.audit({ kullanici: String(body.kullanici || '').slice(0, 60) }, 'Hatalı giriş denemesi', clientIp(req)); throw new HttpError(401, 'Kullanıcı adı ya da şifre yanlış'); }
  cookies.push(sessionCookie(users.login(u), 30 * 86400)); users.audit(u, 'Giriş yaptı', clientIp(req));
  return { kullanici: users.pub(u) };
});
route('POST', '/api/logout', ({ req, user, cookies }) => { users.logout(cookieOf(req)); cookies.push(sessionCookie('', 0)); if (user) users.audit(user, 'Çıkış yaptı'); return { ok: true }; });
/* the first administrator turns team use on; from then on the editor asks everyone to sign in */
route('POST', '/api/setup', ({ body, cookies }) => {
  if (users.enabled()) throw new HttpError(409, 'Ekip kullanımı zaten açık');
  const u = users.create({ ...body, rol: 'yonetici' }); const full = users.get(u.id);
  for (const w of store.listWorkflows()) if (!w.sahip) store.saveWorkflow({ ...w, sahip: u.id }, { version: false }); // existing work belongs to the first administrator
  for (const c of store.listCredentials()) if (!c.sahip) store.saveCredential({ id: c.id, type: c.type, data: {}, sahip: u.id });
  cookies.push(sessionCookie(users.login(full), 30 * 86400)); users.audit(full, 'Ekip kullanımını açtı');
  return { kullanici: u };
});
route('GET', '/api/users', () => users.list());
route('POST', '/api/users', ({ body }) => users.create(body));
route('PUT', '/api/users/:id', ({ params, body, req }) => users.update(params.id, { ad: body.ad, rol: body.rol, sifre: body.sifre }, users.sha(cookieOf(req))));
route('DELETE', '/api/users/:id', ({ params, user }) => {
  if (user && params.id === user.id) throw new HttpError(400, 'Kendi hesabınızı silemezsiniz');
  users.remove(params.id);
  for (const w of store.listWorkflows()) if (w.paylasim?.[params.id]) { const p = { ...w.paylasim }; delete p[params.id]; store.saveWorkflow({ ...w, paylasim: p }, { version: false }); }
  return { ok: true };
});
route('PUT', '/api/me/password', ({ body, user, req }) => {
  if (!user) throw new HttpError(400, 'Ekip kullanımı açık değil');
  if (!users.verify(user.kullanici, body.eski, clientIp(req))) throw new HttpError(400, 'Mevcut şifre yanlış');
  return users.update(user.id, { sifre: body.yeni }, users.sha(cookieOf(req)));
});
route('GET', '/api/audit', ({ query }) => users.auditLog(Number(query.limit) || 200));
route('GET', '/api/expr-check', ({ query }) => { try { require('./lib/expr').parse(query.e || ''); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

/* ---------------- permissions (team use) ----------------
   Every API route needs a rule here; a route without one is for administrators only. In single-user mode
   (no accounts) everything is allowed. wf / exec / cred: access to the workflow, execution or credential in :id. */
const PERMS = {
  'GET /api/me': 'acik', 'POST /api/login': 'acik', 'POST /api/logout': 'acik',
  'GET /api/info': 'herkes', 'GET /api/node-types': 'herkes', 'GET /api/approvals': 'herkes', 'GET /api/workflows': 'herkes', 'GET /api/executions': 'herkes', 'GET /api/stats': 'herkes',
  'GET /api/notify': 'herkes', 'GET /api/desktop': 'herkes', 'GET /api/variables': 'herkes', 'GET /api/templates': 'herkes', 'GET /api/files': 'herkes', 'GET /api/expr-check': 'herkes',
  'GET /api/tables': 'herkes', 'GET /api/tables/:id': 'herkes', 'GET /api/tables/:id/xlsx': 'herkes', 'GET /api/kb': 'herkes', 'GET /api/kb/:id': 'herkes', 'GET /api/kb/:id/search': 'herkes',
  'PUT /api/me/password': 'herkes', 'GET /api/users': 'duzenleyici', 'GET /api/credentials': 'herkes',
  'POST /api/workflows': 'duzenleyici', 'POST /api/templates/:key': 'duzenleyici', 'POST /api/import/convert': 'duzenleyici', 'POST /api/ai/build': 'duzenleyici',
  'POST /api/credentials': 'duzenleyici', 'POST /api/credentials/test': 'duzenleyici',
  'POST /api/tables': 'duzenleyici', 'PUT /api/tables/:id': 'duzenleyici', 'DELETE /api/tables/:id': 'duzenleyici', 'POST /api/tables/:id/rows': 'duzenleyici', 'POST /api/tables/:id/import': 'duzenleyici',
  'PUT /api/tables/:id/rows/:rowId': 'duzenleyici', 'DELETE /api/tables/:id/rows/:rowId': 'duzenleyici', 'POST /api/tables/:id/clear': 'duzenleyici',
  'POST /api/kb': 'duzenleyici', 'PUT /api/kb/:id': 'duzenleyici', 'DELETE /api/kb/:id': 'duzenleyici', 'POST /api/kb/:id/docs': 'duzenleyici', 'DELETE /api/kb/:id/docs/:docId': 'duzenleyici',
  'DELETE /api/executions': 'duzenleyici',
  'GET /api/workflows/:id': { wf: 'gor' }, 'GET /api/workflows/:id/versions': { wf: 'gor' }, 'GET /api/workflows/:id/status': { wf: 'gor' }, 'POST /api/workflows/:id/duplicate': { wf: 'gor' },
  'PUT /api/workflows/:id': { wf: 'duzenle' }, 'POST /api/workflows/:id/run': { wf: 'duzenle' }, 'POST /api/workflows/:id/versions/:vid/restore': { wf: 'duzenle' }, 'DELETE /api/workflows/:id/memory': { wf: 'duzenle' },
  'DELETE /api/workflows/:id': { wf: 'sahip' }, 'PUT /api/workflows/:id/share': { wf: 'sahip' },
  'GET /api/executions/:id': { exec: 'gor' }, 'POST /api/executions/:id/debug': { exec: 'duzenle' }, 'DELETE /api/executions/:id': { exec: 'duzenle' }, 'POST /api/executions/:id/stop': { exec: 'duzenle' }, 'POST /api/executions/:id/retry': { exec: 'duzenle' },
  'GET /api/credentials/:id': { cred: 'sahip' }, 'PUT /api/credentials/:id': { cred: 'sahip' }, 'DELETE /api/credentials/:id': { cred: 'sahip' }, 'PUT /api/credentials/:id/share': { cred: 'sahip' },
};
const ROLE_MSG = { duzenleyici: 'Bu işlem için düzenleyici rolü gerekir', yonetici: 'Bu işlem için yönetici rolü gerekir' };
function guard(r, user, params) {
  const perm = PERMS[`${r.method} ${r.pattern}`] || 'yonetici';
  if (perm === 'acik') return;
  if (user === undefined) throw new HttpError(401, 'Giriş gerekli');
  if (!user || perm === 'herkes') return;
  if (typeof perm === 'string') { if (!users.atLeast(user, perm)) throw new HttpError(403, ROLE_MSG[perm]); return; }
  let wf;
  if (perm.wf) { wf = store.getWorkflow(params.id); if (!wf) throw new HttpError(404, 'Akış bulunamadı'); }
  if (perm.exec) { const e = store.getExecution(params.id); if (!e) throw new HttpError(404, 'Çalıştırma bulunamadı'); wf = store.getWorkflow(e.workflowId); }
  if (perm.wf || perm.exec) {
    const need = perm.wf || perm.exec;
    if (users.canWf(user, wf, need)) return;
    throw users.canWf(user, wf, 'gor') ? new HttpError(403, need === 'sahip' ? 'Bunu yalnızca akışın sahibi ya da bir yönetici yapabilir' : 'Bu akışı düzenleme izniniz yok') : new HttpError(404, perm.exec ? 'Çalıştırma bulunamadı' : 'Akış bulunamadı');
  }
  if (perm.cred) {
    const c = store.listCredentials().find(x => x.id === params.id);
    if (!c || !users.canCred(user, c)) throw new HttpError(404, 'Kimlik bilgisi bulunamadı');
    if (!users.canCred(user, c, 'sahip')) throw new HttpError(403, 'Bu kimlik bilgisini yalnızca sahibi ya da bir yönetici değiştirebilir');
  }
}
/* what the activity log says about a change */
const AUDIT_LABEL = {
  'POST /api/workflows': 'Akış oluşturdu', 'PUT /api/workflows/:id': 'Akışı kaydetti', 'DELETE /api/workflows/:id': 'Akışı sildi', 'POST /api/workflows/:id/run': 'Akışı çalıştırdı',
  'PUT /api/workflows/:id/share': 'Akışın paylaşımını değiştirdi', 'POST /api/workflows/:id/duplicate': 'Akışı kopyaladı', 'POST /api/workflows/:id/versions/:vid/restore': 'Akışın eski sürümüne döndü', 'POST /api/templates/:key': 'Şablondan akış oluşturdu',
  'POST /api/credentials': 'Kimlik bilgisi ekledi', 'PUT /api/credentials/:id': 'Kimlik bilgisini değiştirdi', 'DELETE /api/credentials/:id': 'Kimlik bilgisini sildi', 'PUT /api/credentials/:id/share': 'Kimlik bilgisinin paylaşımını değiştirdi',
  'POST /api/users': 'Kullanıcı ekledi', 'PUT /api/users/:id': 'Kullanıcıyı değiştirdi', 'DELETE /api/users/:id': 'Kullanıcıyı sildi', 'PUT /api/me/password': 'Şifresini değiştirdi',
  'POST /api/backup': 'Yedek aldı', 'POST /api/restore': 'Yedekten geri yükledi', 'PUT /api/variables': 'Değişkenleri değiştirdi', 'PUT /api/notify': 'Hata bildirimlerini değiştirdi',
  'DELETE /api/executions': 'Çalıştırma kayıtlarını sildi', 'POST /api/desktop/update/install': 'Programı güncelledi', 'DELETE /api/tables/:id': 'Veri tablosunu sildi', 'DELETE /api/kb/:id': 'Bilgi tabanını sildi',
};
function auditFor(r, user, params, body, out, before) {
  const label = AUDIT_LABEL[`${r.method} ${r.pattern}`]; if (!label || !user) return;
  let what = before || out?.name || out?.kullanici || '';
  if (r.pattern === '/api/workflows/:id' && r.method === 'PUT' && typeof body.active === 'boolean') what += body.active ? ' (etkin)' : ' (kapalı)';
  if (r.pattern.startsWith('/api/users/')) what = users.get(params.id)?.kullanici || what;
  users.audit(user, label, what);
}

/* ---------------- server ---------------- */
/* undefined: not signed in; null: single-user mode, everyone may do everything; otherwise the signed-in user */
function authenticate(req) {
  if (!users.enabled()) return authorized(req) ? null : undefined;
  const u = users.fromToken(cookieOf(req)); if (u) return u;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) { // scripts and tools: kullanıcı adı ve şifre
    const [name, pass] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
    try { return users.verify(name, pass, clientIp(req)) || undefined; } catch { return undefined; }
  }
  return undefined;
}
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

/* DNS-rebinding guard: while Auto-Move listens only on this computer, the editor and API answer only to
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
// Google and most providers accept plain http only for "localhost", so loopback addresses use that name
const OAUTH_REDIRECT = `${PUBLIC_URL.replace(/^http:\/\/(127\.0\.0\.1|\[::1\])(?=[:/]|$)/, 'http://localhost')}/oauth/callback`;
engine.setPublicUrl(PUBLIC_URL);
/* approval page for "Onay bekle": GET shows the question (link previews and mail scanners only read),
   POST records the decision */
async function handleApproval(req, res, token) {
  const a = engine.approvals.get(token);
  const page = (body, status = 200) => send(res, status, `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onay</title>
<style>:root{--bg:#eef1f4;--card:#fff;--fg:#15202b;--muted:#5a6876;--line:#d6dde4;--ok:#15803d;--no:#c62828}@media(prefers-color-scheme:dark){:root{--bg:#0d1217;--card:#151c23;--fg:#e2e8ee;--muted:#8b9aa8;--line:#2a3540;--ok:#3ccf6e;--no:#ff6b6b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:480px;width:100%;box-sizing:border-box}h1{font-size:19px;margin:0 0 4px}.m{color:var(--muted);font-size:13px;margin:0 0 16px}.q{white-space:pre-wrap;margin:0 0 16px}
textarea{width:100%;box-sizing:border-box;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit;background:transparent;color:inherit}
.b{display:flex;gap:10px;margin-top:14px}button{flex:1;border:0;border-radius:8px;padding:11px;font:600 15px system-ui;color:#fff;cursor:pointer}.y{background:var(--ok)}.n{background:var(--no)}</style></head><body><main>${body}</main></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!a) return page('<h1>Bu onay artık geçerli değil</h1><p class="m">Karar zaten verilmiş, süresi dolmuş ya da akış durdurulmuş olabilir.</p>', 404);
  if (req.method === 'POST') {
    const b = await readBody(req);
    const karar = b?.karar === 'evet' ? 'evet' : b?.karar === 'hayir' ? 'hayır' : null;
    if (!karar) return page('<h1>Geçersiz karar</h1>', 400);
    engine.decide(token, karar, b.not);
    return page(`<h1>${karar === 'evet' ? 'Onaylandı' : 'Reddedildi'}</h1><p class="m">Kararınız kaydedildi; akış devam ediyor. Bu sayfayı kapatabilirsiniz.</p>`);
  }
  return page(`<h1>Onayınız bekleniyor</h1><p class="m">${esc(a.workflow)} · ${esc(a.node)} · ${new Date(a.since).toLocaleString('tr-TR')}</p><p class="q">${esc(a.message)}</p>
<form method="post"><label for="not" class="m">Not (isteğe bağlı)</label><textarea id="not" name="not"></textarea><div class="b"><button class="y" name="karar" value="evet">Onayla</button><button class="n" name="karar" value="hayir">Reddet</button></div></form>`);
}
async function oauthCallback(res, url) {
  const page = (ok, msg) => send(res, ok ? 200 : 400, `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-Move · Hesap bağlantısı</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;background:#eef1f4;color:#15202b}@media(prefers-color-scheme:dark){body{background:#0d1217;color:#e2e8ee}}div{max-width:420px;text-align:center}b{color:${ok ? '#15803d' : '#c62828'}}</style></head>
<body><div><p><b>${ok ? 'Bağlandı' : 'Bağlanamadı'}</b></p><p>${esc(msg)}</p><p>Bu pencereyi kapatabilirsiniz.</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'8n8-oauth',ok:${ok}},'*')}catch(e){}${ok ? 'setTimeout(()=>window.close(),1200)' : ''}</script></body></html>`, { 'Content-Type': 'text/html; charset=utf-8' });
  const err = url.searchParams.get('error');
  if (err) return page(false, err === 'access_denied' ? 'İzin verilmedi.' : `Sağlayıcı hata döndürdü: ${err}`);
  try { const r = await oauth.finish(url.searchParams.get('state'), url.searchParams.get('code')); return page(true, `"${r.name}"${r.account ? ` (${r.account})` : ''} artık kullanılabilir.`); }
  catch (e) { return page(false, e.message); }
}
/* MCP server (Streamable HTTP, JSON responses): every active workflow with an "MCP aracı" trigger on this
   address is one tool. Claude Code: claude mcp add --transport http Auto-Move <url> */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
async function handleMcp(req, res, p) {
  const o = req.headers.origin; // browsers send Origin: a web page must not drive local tools (DNS rebinding)
  if (o) { let hn = ''; try { hn = new URL(o).hostname.toLowerCase(); } catch {} if (!ALLOWED_HOSTS.has(hn) && !ALLOWED_HOSTS.has(`[${hn}]`)) return send(res, 403, { hata: 'Bu kaynaktan erişime izin verilmiyor' }); }
  if (req.method !== 'POST') return send(res, 405, { hata: 'MCP istekleri POST ile gönderilir' }, { Allow: 'POST' });
  const tools = [];
  for (const wf of store.listWorkflows()) if (wf.active) for (const n of wf.nodes) {
    if (n.type !== 'mcpTrigger' || n.disabled) continue;
    const params = { ...defaults('mcpTrigger'), ...n.params };
    if (cleanPath(params.path) !== p) continue;
    let tool; try { tool = AI.toolOf(params); } catch { continue; }
    if (!tools.some(t => t.tool.name === tool.name)) tools.push({ wf, node: n, params, tool });
  }
  if (!tools.length) return send(res, 404, { hata: `/mcp/${p} adresinde etkin araç yok. Akışta "MCP aracı" tetikleyicisi olduğundan ve akışın etkin olduğundan emin olun.` });
  const visible = tools.filter(t => !credAuthError(req, t.params));
  if (!visible.length) { const e = credAuthError(req, tools[0].params); return send(res, e.status, { hata: e.message }, e.headers); }
  const body = await readBody(req);
  const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const handle = async m => {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcErr(m?.id, -32600, 'Geçersiz istek');
    const isNote = !('id' in m);
    if (isNote) return null; // notifications/initialized, cancelled, …
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') {
      const want = m.params?.protocolVersion;
      return ok({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Auto-Move', title: `Auto-Move · ${p}`, version: pkg.version }, instructions: 'Auto-Move iş akışlarını araç olarak çalıştırır. Her araç bir akışı başlatır ve sonucunu döndürür.' });
    }
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: visible.map(t => t.tool) });
    if (m.method === 'tools/call') {
      const t = visible.find(x => x.tool.name === m.params?.name);
      if (!t) return rpcErr(m.id, -32602, `Bilinmeyen araç: ${m.params?.name}`);
      const args = m.params?.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return rpcErr(m.id, -32602, 'arguments bir nesne olmalı');
      const missing = t.tool.inputSchema.required.filter(k => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length) return ok({ content: [{ type: 'text', text: `Eksik girdi: ${missing.join(', ')}` }], isError: true });
      const cur = store.getWorkflow(t.wf.id);
      const { done } = engine.start(cur, { triggerId: t.node.id, triggerData: { items: [args] }, mode: 'mcp' });
      const fin = await done;
      if (fin.status !== 'success') return ok({ content: [{ type: 'text', text: `Akış hata verdi: ${fin.error || fin.status}` }], isError: true });
      const items = (fin.lastOutput || []).map(i => i.json);
      const text = t.params.result === 'first' ? JSON.stringify(items[0] ?? null, null, 2)
        : t.params.result === 'field' ? (v => (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2)))(items[0]?.[t.params.field || 'yanit'])
        : JSON.stringify(items, null, 2);
      return ok({ content: [{ type: 'text', text }] });
    }
    return rpcErr(m.id, -32601, `Desteklenmeyen yöntem: ${m.method}`);
  };
  if (typeof body !== 'object' || body === null) return send(res, 400, rpcErr(null, -32700, 'Geçersiz JSON'));
  if (Array.isArray(body)) { const out = (await Promise.all(body.map(handle))).filter(Boolean); return out.length ? send(res, 200, out) : (res.writeHead(202), res.end()); }
  const out = await handle(body);
  if (!out) { res.writeHead(202); return res.end(); }
  return send(res, 200, out);
}
const UNAUTH = res => send(res, 401, 'Giriş gerekli', { 'WWW-Authenticate': 'Basic realm="Auto-Move"' });

const server = http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'Geçersiz adres'); }
  try {
    let m;
    if ((m = p.match(/^\/(webhook|webhook-test|form|form-test|sohbet|sohbet-test)\/(.+)$/))) {
      const test = m[1].endsWith('-test');
      if (test) { const u = authenticate(req); if (u === undefined || !users.atLeast(u, 'duzenleyici') || !hostAllowed(req)) return UNAUTH(res); } // test addresses run drafts: editor users only
      const kind = m[1].replace('-test', '');
      return await (kind === 'webhook' ? handleWebhook : kind === 'form' ? handleForm : handleChat)(req, res, cleanPath(m[2]), test);
    }
    // public by design: an unguessable token ties each to a sign-in or an approval this program started
    if (p === '/oauth/callback') return await oauthCallback(res, url);
    if ((m = p.match(/^\/mcp\/(.+)$/))) return await handleMcp(req, res, cleanPath(m[1]));
    if ((m = p.match(/^\/whatsapp\/(.+)$/))) return await handleWhatsapp(req, res, cleanPath(m[1]), url);
    if ((m = p.match(/^\/onay\/([A-Za-z0-9_-]{10,64})$/))) return await handleApproval(req, res, m[1]);
    if (!hostAllowed(req)) return send(res, 403, 'Bu adresten erişime izin verilmiyor. Başka bir adres kullanıyorsanız N8N8_ALLOWED_HOSTS ile ekleyin.');
    const user = authenticate(req);
    const open = users.enabled() && (STATIC[p] || p === '/api/me' || p === '/api/login' || p === '/api/logout');
    if (user === undefined && !open) return users.enabled() ? send(res, 401, p.startsWith('/api/') ? { hata: 'Giriş gerekli', giris: true } : 'Giriş gerekli') : UNAUTH(res);
    if (p === '/oauth/start') {
      const cr = store.listCredentials().find(c => c.id === url.searchParams.get('cred'));
      if (user && !users.canCred(user, cr, 'sahip')) return send(res, 403, 'Bu kimlik bilgisini yalnızca sahibi ya da bir yönetici bağlayabilir');
      res.writeHead(302, { Location: oauth.startUrl(url.searchParams.get('cred'), OAUTH_REDIRECT), 'Cache-Control': 'no-store' }); return res.end(); }
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, readAsset(file), { 'Content-Type': type });
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', running: engine.runningIds() })}\n\n`);
      clients.set(res, user); req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'DELETE' && !String(req.headers['content-type'] || '').includes('application/json'))
        throw new HttpError(415, 'API istekleri JSON olmalı'); // also blocks simple cross-site form posts
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const mm = p.match(r.re); if (!mm) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req, p === '/api/restore' ? 256 * 1024 * 1024 : /^\/api\/(kb\/[^/]+\/docs|tables\/[^/]+\/import)$/.test(p) ? 40 * 1024 * 1024 : MAX_BODY) : {};
        const params = mm.groups || {}; const ctx = { params, query: Object.fromEntries(url.searchParams), body: typeof body === 'object' && body ? body : {}, user, req, cookies: [] };
        guard(r, user, params);
        const before = req.method === 'DELETE' && params.id ? (store.getWorkflow(params.id)?.name || store.listCredentials().find(c => c.id === params.id)?.name || '') : '';
        const out = await r.fn(ctx);
        if (req.method !== 'GET') auditFor(r, user, params, ctx.body, out, before);
        return send(res, 200, out, ctx.cookies.length ? { 'Set-Cookie': ctx.cookies } : {});
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
  if (process.env.N8N8_NO_OPEN || desktop.BACKGROUND) return;
  desktop.openUrl(u);
}

let listenTries = 0;
server.on('error', e => {
  // after an update the new version may start a moment before the old one has let go of the port
  if (e.code === 'EADDRINUSE' && process.env.N8N8_YENIDEN && ++listenTries < 40) return setTimeout(() => server.listen(PORT, HOST), 500);
  if (e.code === 'EADDRINUSE') { console.error(`\n  ${PORT} portu kullanımda. Auto-Move zaten açık olabilir: ${PUBLIC_URL}\n  Başka port için: PORT=5679 npm start\n`); openBrowser(PUBLIC_URL); setTimeout(() => process.exit(1), 300); }
  throw e;
});
server.listen(PORT, HOST, () => {
  if (!store.listWorkflows().length) store.saveWorkflow({ ...templates.TEMPLATES.siparis(), active: false });
  console.log(`\n  Auto-Move ${pkg.version} çalışıyor → ${PUBLIC_URL}`);
  console.log(`  Veri klasörü: ${store.DATA}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) console.log('  UYARI: Ağa açıksınız ama şifre yok. N8N8_PASSWORD ayarlayın.');
  desktop.cleanupOld();
  desktop.startTray({ url: PUBLIC_URL, onQuit: () => shutdown(), onUpdate: () => openBrowser(`${PUBLIC_URL}/#/hakkinda`) }).then(on => {
    console.log(on ? '  Kapatmak için saatin yanındaki Auto-Move simgesine sağ tıklayıp Kapat\'ı seçin.\n' : '  Kapatmak için bu pencerede Ctrl+C\n');
  });
  desktop.scheduleChecks(PUBLIC_URL);
  if (!process.env.N8N8_YENIDEN) openBrowser(PUBLIC_URL);
});
// one failed background save or a stray promise must not take every workflow down with it
process.on('unhandledRejection', e => console.error('Beklenmeyen hata:', e));
function shutdown(restart = false) {
  console.log(restart ? '\n  Auto-Move yeni sürümle yeniden başlıyor…' : '\n  Auto-Move kapatılıyor…');
  for (const id of engine.runningIds()) engine.stop(id);
  server.close(); desktop.stopTray();
  setTimeout(() => { if (restart) desktop.relaunch(); process.exit(0); }, 300);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown());

module.exports = { server };
