'use strict';
/* End-to-end smoke test: starts a real server on a temp data folder and drives it through the HTTP API.
   Run with `npm test`. Needs no internet. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), '8n8-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const B = `http://127.0.0.1:${PORT}`;
let seq = 0;
const nid = () => `n${++seq}`;

async function api(method, url, body) {
  const r = await fetch(B + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${t}`);
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitExec(id, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const e = await api('GET', `/api/executions/${id}`).catch(() => null); if (e && e.status !== 'running') return e; if (Date.now() > end) throw new Error('çalıştırma bitmedi'); await sleep(100); }
}
/* tiny builder: nodes as [type, params, extra], edges as [fromIdx, toIdx, fromPort] */
function wf(name, nodes, edges, extra = {}) {
  const ns = nodes.map(([type, params = {}, more = {}], i) => ({ id: nid(), type, name: more.name || `${type} ${i}`, x: i * 300, y: 0, params, settings: {}, ...more }));
  return { name, nodes: ns, edges: edges.map(([a, b, p = 0, q = 0]) => ({ id: nid(), from: ns[a].id, fromPort: p, to: ns[b].id, toPort: q })), ...extra };
}
const outOf = (e, name) => { const n = Object.values(e.nodes).find(x => x.name === name); return n?.output?.[0]?.map(i => i.json); };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('örnek akış çalışır ve CSV yazar', async () => {
  const [w] = await api('GET', '/api/workflows');
  const { executionId } = await api('POST', `/api/workflows/${w.id}/run`, {});
  const e = await waitExec(executionId);
  assert.equal(e.status, 'success', e.error);
  const sum = outOf(e, 'Duruma göre özet');
  assert.equal(sum.length, 2);
  assert.ok(fs.readFileSync(path.join(DATA, 'dosyalar', 'faturalar.csv'), 'utf8').includes('SP-1045'));
});

test('webhook testi + "Yanıt ver" node\'u', async () => {
  const w = await api('POST', '/api/workflows', wf('wh', [
    ['webhook', { method: 'POST', path: 'selam', respond: 'node' }],
    ['set', { fields: [{ key: 'ad', value: '{{ $json.body.ad }}' }], keep: false }],
    ['respond', { status: 201, type: 'json', body: '{"mesaj":"Merhaba {{ $json.ad }}"}', headers: [] }],
  ], [[0, 1], [1, 2]]));
  let r = await fetch(`${B}/webhook-test/selam`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ad":"Ayşe"}' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { mesaj: 'Merhaba Ayşe' });
  r = await fetch(`${B}/webhook/selam`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 404, 'etkin olmayan akışın üretim adresi 404 vermeli');
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  r = await fetch(`${B}/webhook/selam`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ad":"Can"}' });
  assert.deepEqual(await r.json(), { mesaj: 'Merhaba Can' });
});

test('aynı webhook yolu iki etkin akışta kullanılamaz', async () => {
  const w = await api('POST', '/api/workflows', wf('wh2', [['webhook', { method: 'POST', path: 'selam', respond: 'lastNode' }]], []));
  await assert.rejects(api('PUT', `/api/workflows/${w.id}`, { active: true }), /409|400|zaten|kullan/i);
});

test('form gönderimi akışı başlatır', async () => {
  const w = await api('POST', '/api/workflows', wf('form', [
    ['form', { path: 'iletisim', title: 'Bize yazın', fields: [{ label: 'Ad', name: 'ad', type: 'text', required: true }], thanks: 'Sağ olun' }],
    ['noop', {}, { name: 'son' }],
  ], [[0, 1]]));
  const page = await (await fetch(`${B}/form-test/iletisim`)).text();
  assert.ok(page.includes('Bize yazın') && page.includes('name="ad"'));
  const r = await fetch(`${B}/form-test/iletisim`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ad=Selin' });
  assert.ok((await r.text()).includes('Sağ olun'));
  await sleep(300);
  const { items } = await api('GET', `/api/executions?workflowId=${w.id}`);
  const e = await waitExec(items[0].id);
  assert.equal(outOf(e, 'son')[0].ad, 'Selin');
});

test('alt akış çağrısı', async () => {
  const sub = await api('POST', '/api/workflows', wf('alt', [
    ['subTrigger', {}],
    ['set', { fields: [{ key: 'iki', value: '{{ $json.n * 2 }}' }], keep: true }],
  ], [[0, 1]]));
  const main = await api('POST', '/api/workflows', wf('ana', [
    ['manual', { data: '[{"n":2},{"n":5}]' }],
    ['execWorkflow', { workflowId: sub.id, mode: 'all', wait: true }, { name: 'çağır' }],
  ], [[0, 1]]));
  const e = await waitExec((await api('POST', `/api/workflows/${main.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'çağır').map(x => x.iki), [4, 10]);
});

let failedExec;
test('hata akışı tetiklenir, yeniden deneme çalışır', async () => {
  const ew = await api('POST', '/api/workflows', wf('hata yakalayıcı', [['errorTrigger', {}], ['noop', {}, { name: 'yakaladı' }]], [[0, 1]]));
  const bad = await api('POST', '/api/workflows', wf('bozuk', [
    ['manual', { data: '[{"id":7}]' }],
    ['stopError', { message: 'Kötü veri: {{ $json.id }}' }],
  ], [[0, 1]], { settings: { errorWorkflow: ew.id } }));
  const e = await waitExec((await api('POST', `/api/workflows/${bad.id}/run`, {})).executionId);
  assert.equal(e.status, 'error');
  assert.match(e.error, /Kötü veri: 7/);
  failedExec = e;
  await sleep(400);
  const { items } = await api('GET', `/api/executions?workflowId=${ew.id}`);
  assert.equal(items.length, 1, 'hata akışı çalışmalı');
  const ee = await waitExec(items[0].id);
  assert.equal(outOf(ee, 'yakaladı')[0].workflow.name, 'bozuk');
  const r = await waitExec((await api('POST', `/api/executions/${e.id}/retry`, {})).executionId);
  assert.equal(r.retryOf, e.id);
});

test('hatada devam et, Kod node\'u console.log, $vars', async () => {
  await api('PUT', '/api/variables', { ortam: 'test' });
  const w = await api('POST', '/api/workflows', wf('kod', [
    ['manual', { data: '[{"a":1}]' }],
    ['code', { code: 'console.log("merhaba", items.length);\nthrow new Error("patladı");' }, { name: 'kırık', settings: { continueOnFail: true } }],
    ['code', { code: 'return [{ ortam: $vars.ortam }];' }, { name: 'değişken' }],
  ], [[0, 1], [0, 2]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const k = Object.values(e.nodes).find(n => n.name === 'kırık');
  assert.ok(JSON.stringify(k.output).includes('patladı'));
  assert.ok(JSON.stringify(k.logs).includes('merhaba'));
  assert.equal(outOf(e, 'değişken')[0].ortam, 'test');
});

test('sabitlenmiş veri editör çalıştırmasında kullanılır', async () => {
  const w = await api('POST', '/api/workflows', wf('pin', [
    ['manual', { data: '[{"x":1}]' }],
    ['http', { url: 'http://127.0.0.1:1/olmaz' }, { name: 'istek', pinData: [{ sabit: true }] }],
    ['noop', {}, { name: 'son' }],
  ], [[0, 1], [1, 2]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'son'), [{ sabit: true }]);
});

test('zamanlayıcı (5 sn) etkinken çalışır', async () => {
  const w = await api('POST', '/api/workflows', wf('zaman', [['schedule', { mode: 'interval', every: 5, unit: 's' }]], []));
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  await sleep(5800);
  await api('PUT', `/api/workflows/${w.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${w.id}`);
  assert.ok(items.length >= 1, 'zamanlayıcı çalışmadı');
});

test('kimlik bilgisi şifreli saklanır, gizli alan geri dönmez; e-posta SMTP ile gider', async () => {
  let got = '';
  const smtp = net.createServer(s => {
    let data = false;
    s.write('220 test\r\n');
    s.on('data', d => {
      const t = d.toString();
      if (data) { got += t; if (got.includes('\r\n.\r\n')) { data = false; s.write('250 tamam\r\n'); } return; }
      for (const line of t.split('\r\n').filter(Boolean)) {
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) s.write('235 ok\r\n');
        else if (/^DATA/.test(line)) { data = true; s.write('354 git\r\n'); }
        else if (/^QUIT/.test(line)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  const cred = await api('POST', '/api/credentials', { type: 'smtp', name: 'test', data: { host: '127.0.0.1', port: String(smtp.address().port), secure: 'false', user: 'u', password: 'gizli-sifre' } });
  const raw = fs.readFileSync(path.join(DATA, 'credentials.json'), 'utf8');
  assert.ok(!raw.includes('gizli-sifre'), 'şifre düz metin olarak yazılmamalı');
  assert.ok(!JSON.stringify(await api('GET', `/api/credentials/${cred.id}`)).includes('gizli-sifre'));
  const w = await api('POST', '/api/workflows', wf('mail', [
    ['manual', { data: '[{"ad":"Elif","eposta":"elif@ornek.com"}]' }],
    ['email', { credential: cred.id, from: 'ben@ornek.com', to: '{{ $json.eposta }}', subject: 'Merhaba {{ $json.ad }}', format: 'text', body: 'Selam' }],
  ], [[0, 1]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  smtp.close();
  assert.equal(e.status, 'success', e.error);
  assert.ok(got.includes('Subject: Merhaba Elif'));
});

test('JSON olmayan API isteği reddedilir', async () => {
  const r = await fetch(`${B}/api/workflows`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, N8N8_DATA: DATA, PORT: String(PORT), N8N8_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('çalışıyor')) res(); }); srv.on('exit', c => rej(new Error('sunucu kapandı: ' + c))); });
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  }
  srv.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} test başarısız` : `\nTüm ${tests.length} test geçti`);
  process.exit(fail ? 1 : 0);
})();
