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

test('Döngü: parça parça işler; geri bağlantı yalnız Döngü node\'una girebilir', async () => {
  const w = await api('POST', '/api/workflows', wf('döngü', [
    ['manual', { data: '[{"n":1},{"n":2},{"n":3},{"n":4},{"n":5}]' }],
    ['loop', { batchSize: 2 }, { name: 'dış' }],
    ['code', { code: 'return items.map(i => ({ ...i.json, kare: i.json.n * i.json.n }));' }, { name: 'kare' }],
    ['noop', {}, { name: 'son' }],
  ], [[0, 1], [1, 2, 1, 0], [2, 1], [1, 3, 0, 0]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'son').map(x => x.kare), [1, 4, 9, 16, 25]);
  const k = Object.values(e.nodes).find(n => n.name === 'kare');
  assert.equal(k.runs, 3, 'kod node\'u 3 turda çalışmalı');
  assert.equal(k.output[0].length, 5);
  // döngü olmadan geri bağlantı hata vermeli
  const bad = await api('POST', '/api/workflows', wf('kötü', [['manual', {}], ['noop', {}], ['noop', {}]], [[0, 1], [1, 2], [2, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${bad.id}/run`, {})).executionId);
  assert.match(e2.error, /Döngü/);
});

test('Veri tablosu: ekle, ekle-ya-da-güncelle, ara, sil ve API', async () => {
  const t = await api('POST', '/api/tables', { name: 'Müşteriler' });
  const w = await api('POST', '/api/workflows', wf('tablo', [
    ['manual', { data: '[{"id":1,"ad":"Ayşe"},{"id":2,"ad":"Can"}]' }],
    ['table', { table: t.id, op: 'insert', dataMode: 'item' }, { name: 'ekle' }],
    ['code', { code: 'return [{ id: 2, ad: "Can Öz" }, { id: 3, ad: "Elif" }];' }],
    ['table', { table: 'müşteriler', op: 'upsert', key: 'id', dataMode: 'item' }, { name: 'upsert' }],
    ['code', { code: 'return [{ aranan: 2 }];' }],
    ['table', { table: t.id, op: 'find', where: [{ key: 'id', value: '{{ $json.aranan }}' }] }, { name: 'bul' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'bul')[0].ad, 'Can Öz');
  const got = await api('GET', `/api/tables/${t.id}`);
  assert.equal(got.rowCount, 3);
  assert.deepEqual(got.columns, ['id', 'ad']);
  await api('DELETE', `/api/tables/${t.id}/rows/${got.rows[0]._id}`);
  assert.equal((await api('GET', `/api/tables/${t.id}?q=elif`)).total, 1);
});

test('Yeni öğeleri bul: ikinci çalıştırmada yalnız yeniler geçer', async () => {
  const w = await api('POST', '/api/workflows', wf('yeni', [
    ['webhook', { method: 'POST', path: 'yeni-ogeler', respond: 'lastNode' }],
    ['splitOut', { field: 'body.liste' }],
    ['newItems', { key: '{{ $json.id }}' }, { name: 'yeni' }],
  ], [[0, 1], [1, 2]]));
  const call = async liste => (await fetch(`${B}/webhook-test/yeni-ogeler`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liste }) })).json();
  await call([{ id: 1 }, { id: 2 }]);
  const r = await call([{ id: 2 }, { id: 3 }]);
  assert.deepEqual([].concat(r).map(x => x.id), [3]);
  await api('DELETE', `/api/workflows/${w.id}/memory`);
});

test('HTML, XML, metin, karşılaştırma ve yeniden adlandırma node\'ları', async () => {
  const html = '<html><body><h1>Ürünler</h1><div class="u"><a href="/a">Kalem</a><span class="f">12 TL</span></div><div class="u"><a href="/b">Defter</a><span class="f">30 TL</span></div></body></html>';
  const w = await api('POST', '/api/workflows', wf('metin', [
    ['manual', { data: JSON.stringify([{ veri: html, xml: '<kitap id="7"><ad>Sefiller</ad></kitap>', isim: 'merhaba dünya' }]) }],
    ['html', { op: 'extract', source: 'veri', base: 'https://dukkan.com', rules: [{ key: 'baslik', selector: 'h1', attr: '', all: false }, { key: 'urunler', selector: '.u a', attr: '', all: true }, { key: 'linkler', selector: '.u a', attr: 'href', all: true }] }, { name: 'html' }],
    ['xml', { op: 'toJson', field: 'xml' }, { name: 'xml' }],
    ['text', { value: '{{ $json.isim }}', op: 'title', output: 'baslik' }, { name: 'metin' }],
    ['rename', { pairs: [{ key: 'baslik', value: 'unvan' }] }, { name: 'adlandır' }],
  ], [[0, 1], [0, 2], [0, 3], [3, 4]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'html')[0], { baslik: 'Ürünler', urunler: ['Kalem', 'Defter'], linkler: ['https://dukkan.com/a', 'https://dukkan.com/b'] });
  assert.deepEqual(outOf(e, 'xml')[0], { kitap: { '@id': '7', ad: 'Sefiller' } });
  assert.equal(outOf(e, 'adlandır')[0].unvan, 'Merhaba Dünya');
  const c = await api('POST', '/api/workflows', wf('karşılaştır', [
    ['manual', { data: '[{"id":1,"f":10},{"id":2,"f":20},{"id":3,"f":30}]' }],
    ['code', { code: 'return [{id:2,f:20},{id:3,f:35},{id:4,f:40}];' }],
    ['compare', { keyA: 'id', keyB: 'id' }, { name: 'kıyas' }],
  ], [[0, 1], [0, 2, 0, 0], [1, 2, 0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${c.id}/run`, {})).executionId);
  const k = Object.values(e2.nodes).find(n => n.name === 'kıyas').output;
  assert.deepEqual(k.map(o => o.length), [1, 1, 1, 1]);
  assert.deepEqual(k[2][0].json.farkli, ['f']);
});

test('Webhook kimlik doğrulaması', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'httpHeader', name: 'gizli', data: { name: 'X-Anahtar', value: 's3cr3t' } });
  await api('POST', '/api/workflows', wf('korumalı', [['webhook', { method: 'POST', path: 'korumali', respond: 'lastNode', auth: 'cred', credential: cred.id }]], []));
  let r = await fetch(`${B}/webhook-test/korumali`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  r = await fetch(`${B}/webhook-test/korumali`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anahtar': 's3cr3t' }, body: '{}' });
  assert.equal(r.status, 200);
});

test('Sohbet sayfası + Claude ajanı araç kullanır ve hafızası olur (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'claude', data: { apiKey: 'sk-test' } });
  const w = await api('POST', '/api/workflows', wf('asistan', [
    ['chatTrigger', { path: 'asistan', title: 'Asistan' }],
    ['agent', { credential: cred.id, prompt: '{{ $json.mesaj }}', memory: true, session: '{{ $json.oturum }}', toolHttp: false, toolTables: true }, { name: 'ajan' }],
  ], [[0, 1]]));
  const page = await (await fetch(`${B}/sohbet-test/asistan`)).text();
  assert.ok(page.includes('Asistan'));
  const say = async m => (await fetch(`${B}/sohbet-test/asistan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mesaj: m, oturum: 'o1' }) })).json();
  const r1 = await say('6 kere 7 kaç?');
  assert.equal(r1.yanit, 'Sonuç: 42');
  const r2 = await say('Az önce ne sordum?');
  assert.equal(r2.yanit, 'Önceki mesaj sayısı: 2');
  const e = await api('GET', `/api/executions/${r1.calistirma}`);
  assert.equal(outOf(e, 'ajan')[0].araclar[0].arac, 'hesap_makinesi');
  assert.equal(fakeClaude.calls.at(-1).headers['x-api-key'], 'sk-test');
  assert.ok(fakeClaude.calls.some(c => (c.body.tools || []).some(t => t.name === 'tablo_ara')));
});

test('Claude ile akış oluştur (sahte API)', async () => {
  const r = await api('POST', '/api/ai/build', { prompt: 'Her sabah hava durumunu al' });
  assert.equal(r.workflow.nodes.filter(n => n.type !== 'note').length, 2);
  assert.equal(r.workflow.edges.length, 1);
  assert.equal(r.workflow.nodes.find(n => n.type === 'schedule').params.cron, '0 8 * * *');
});

test('n8n akışını içe aktarma', async () => {
  const n8nWf = { name: 'n8n örnek', nodes: [
    { name: 'When clicking', type: 'n8n-nodes-base.manualTrigger', position: [100, 200], parameters: {} },
    { name: 'Edit Fields', type: 'n8n-nodes-base.set', position: [300, 200], parameters: { assignments: { assignments: [{ name: 'tam', value: '={{ $json.ad }} {{ $(\'When clicking\').item.json.soyad }}' }] } } },
    { name: 'If', type: 'n8n-nodes-base.if', position: [500, 200], parameters: { conditions: { conditions: [{ leftValue: '={{ $json.yas }}', rightValue: 18, operator: { operation: 'gte' } }], combinator: 'and' } } },
    { name: 'Garip', type: 'n8n-nodes-base.salesforce', position: [700, 200], parameters: {} },
  ], connections: { 'When clicking': { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] }, 'Edit Fields': { main: [[{ node: 'If', type: 'main', index: 0 }]] }, If: { main: [[], [{ node: 'Garip', type: 'main', index: 0 }]] } } };
  const r = await api('POST', '/api/import/convert', n8nWf);
  assert.equal(r.source, 'n8n');
  const by = Object.fromEntries(r.workflow.nodes.map(n => [n.name, n]));
  assert.equal(by['Edit Fields'].params.fields[0].value, '{{ $json.ad }} {{ $node["When clicking"].json.soyad }}');
  assert.equal(by.If.params.conditions[0].op, 'gte');
  assert.equal(by.Garip.type, 'noop');
  assert.equal(r.workflow.edges.find(e => e.to === by.Garip.id).fromPort, 1);
  assert.equal(r.notes.length, 1);
});

test('RSS oku ve klasör izleyici', async () => {
  const w = await api('POST', '/api/workflows', wf('rss', [['manual', {}], ['rss', { url: `http://127.0.0.1:${fakeClaude.port}/rss.xml` }, { name: 'rss' }]], [[0, 1]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'rss')[0].baslik, 'İlk yazı');
  const fw = await api('POST', '/api/workflows', wf('izle', [['fileTrigger', { folder: 'gelen', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${fw.id}`, { active: true });
  await sleep(1200);
  fs.writeFileSync(path.join(DATA, 'dosyalar', 'gelen', 'yeni.txt'), 'x');
  await sleep(5500);
  await api('PUT', `/api/workflows/${fw.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${fw.id}`);
  assert.equal(items.length, 1, 'yeni dosya bir çalıştırma başlatmalı');
  assert.equal(outOf(await waitExec(items[0].id), 'son')[0].ad, 'yeni.txt');
});

test('JSON olmayan API isteği reddedilir', async () => {
  const r = await fetch(`${B}/api/workflows`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});


/* fake Anthropic API (the SDK honours ANTHROPIC_BASE_URL) that also serves a test RSS feed */
const fakeClaude = { calls: [], port: 0 };
const fakeServer = require('http').createServer((req, res) => {
  if (req.url === '/rss.xml') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return res.end('<?xml version="1.0"?><rss><channel><title>T</title><item><title>İlk yazı</title><link>https://x.com/1</link><guid>1</guid></item></channel></rss>'); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); fakeClaude.calls.push({ headers: req.headers, body });
    const last = body.messages.at(-1);
    let content, stop = 'end_turn';
    if (String(body.system || '').includes('NODE TÜRLERİ')) content = [{ type: 'text', text: '```json\n{"name":"Hava","nodes":[{"key":"a","type":"schedule","name":"Her sabah","params":{"mode":"cron","cron":"0 8 * * *"}},{"key":"b","type":"http","name":"Hava durumu","params":{"url":"https://api.open-meteo.com"}}],"edges":[["a",0,"b",0]],"notes":"Hazır"}\n```' }];
    else if (typeof last.content === 'string' && last.content.includes('kaç')) { content = [{ type: 'tool_use', id: 'tu_1', name: 'hesap_makinesi', input: { ifade: '6*7' } }]; stop = 'tool_use'; }
    else if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') content = [{ type: 'text', text: `Sonuç: ${JSON.parse(last.content[0].content).sonuc}` }];
    else content = [{ type: 'text', text: `Önceki mesaj sayısı: ${body.messages.length - 1}` }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});

(async () => {
  await new Promise(r => fakeServer.listen(0, '127.0.0.1', r)); fakeClaude.port = fakeServer.address().port;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, N8N8_DATA: DATA, PORT: String(PORT), N8N8_NO_OPEN: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => srv.kill());
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('çalışıyor')) res(); }); srv.on('exit', c => rej(new Error('sunucu kapandı: ' + c))); });
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  }
  srv.kill(); fakeServer.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} test başarısız` : `\nTüm ${tests.length} test geçti`);
  process.exit(fail ? 1 : 0);
})();
