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

test('Kod node\'u ayrı süreçte çalışır: dosya, program ve ortam değişkenlerine erişemez', async () => {
  const w = await api('POST', '/api/workflows', wf('kum havuzu', [
    ['manual', { data: '[{"n":4}]' }],
    ['code', { code: 'return items.map(i => ({ kare: i.json.n ** 2, gun: helpers.formatDate("2026-01-02", "DD.MM") }));' }, { name: 'iyi' }],
    ['code', { code: 'const p = this.constructor.constructor("return process")(); return [{ env: Object.keys(p.env).length }];' }, { name: 'ortam' }],
    ['code', { code: 'const p = this.constructor.constructor("return process")(); return [{ x: p.getBuiltinModule("fs").readFileSync("/etc/hosts", "utf8") }];' }, { name: 'dosya', settings: { continueOnFail: true } }],
    ['code', { code: 'while (true) {}' }, { name: 'sonsuz', settings: { continueOnFail: true } }],
  ], [[0, 1], [0, 2], [0, 3], [0, 4]]));
  const sonsuz = w.nodes.find(n => n.name === 'sonsuz'); sonsuz.params.timeout = 1;
  await api('PUT', `/api/workflows/${w.id}`, { nodes: w.nodes });
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId, 15000);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'iyi'), [{ kare: 16, gun: '02.01' }]);
  assert.equal(outOf(e, 'ortam')[0].env, 0, 'ortam değişkenleri boş olmalı');
  assert.match(JSON.stringify(outOf(e, 'dosya')), /erişemez/);
  assert.match(JSON.stringify(outOf(e, 'sonsuz')), /1 sn içinde bitmedi/);
});

test('İfadeler kod çalıştıramaz; ?. zinciri ve 1e-5 doğru', async () => {
  const w = await api('POST', '/api/workflows', wf('ifade', [
    ['manual', { data: '[{"a":null}]' }],
    ['set', { fields: [{ key: 'v', value: "{{ Object.getOwnPropertyDescriptor(Object.getPrototypeOf(x=>1),'constructor').value.call(null,'return process.version')() }}" }], keep: false }, { name: 'kaçış', settings: { continueOnFail: true } }],
    ['set', { fields: [{ key: 'v', value: '{{ $json.a?.b.c ?? "yok" }}' }, { key: 'k', value: '{{ 1e-5 * 1e5 }}' }], keep: false }, { name: 'zincir' }],
  ], [[0, 1], [0, 2]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.ok(!JSON.stringify(outOf(e, 'kaçış')).includes(process.version.slice(1)), 'Node sürümü sızmamalı');
  assert.deepEqual(outOf(e, 'zincir'), [{ v: 'yok', k: 1 }]);
});

test('Veritabanı node\'u (SQLite): tablo kur, ekle, güncelle, oku', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'sqlite', name: 'yerel', data: { file: 'test.db' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'sqlite', id: cred.id, data: {} })).ok, true);
  const w = await api('POST', '/api/workflows', wf('sql', [
    ['manual', { data: '[{"eposta":"a@x.com","ad":"Ayşe","puan":5},{"eposta":"b@x.com","ad":"Can","puan":3}]' }],
    ['database', { credential: cred.id, op: 'query', sql: 'CREATE TABLE IF NOT EXISTS kisi (id INTEGER PRIMARY KEY, eposta TEXT UNIQUE, ad TEXT, puan INT)', params: '' }, { name: 'kur' }],
    ['database', { credential: cred.id, op: 'insert', table: 'kisi' }, { name: 'ekle' }],
    ['code', { code: 'return [{ eposta: "a@x.com", puan: 9 }, { eposta: "c@x.com", ad: "Ece", puan: 7 }];' }],
    ['database', { credential: cred.id, op: 'upsert', table: 'kisi', key: 'eposta' }, { name: 'upsert' }],
    ['database', { credential: cred.id, op: 'query', sql: 'SELECT ad, puan FROM kisi WHERE puan > $1 ORDER BY puan DESC', params: '{{ 4 }}' }, { name: 'sorgu' }],
  ], [[0, 1], [0, 2], [2, 3], [3, 4], [4, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'ekle').length, 2);
  assert.deepEqual(outOf(e, 'sorgu'), [{ ad: 'Ayşe', puan: 9 }, { ad: 'Ece', puan: 7 }]);
});

test('Google E-Tablolar: ekle, güncelle, oku (sahte API)', async () => {
  const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'bot@proje.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${fakeClaude.port}/token` };
  const cred = await api('POST', '/api/credentials', { type: 'googleServiceAccount', name: 'g', data: { json: JSON.stringify(key) } });
  const w = await api('POST', '/api/workflows', wf('sheets', [
    ['manual', { data: '[{"eposta":"a@x.com","ad":"Ayşe"},{"eposta":"b@x.com","ad":"Can"}]' }],
    ['sheets', { credential: cred.id, sheet: 'https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0', op: 'append' }, { name: 'ekle' }],
    ['code', { code: 'return [{ eposta: "b@x.com", ad: "Can Öz", puan: 3 }];' }],
    ['sheets', { credential: cred.id, sheet: 'ABC123', op: 'update', key: 'eposta' }, { name: 'guncelle' }],
    ['sheets', { credential: cred.id, sheet: 'ABC123', op: 'read' }, { name: 'oku' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'guncelle')[0]._islem, 'guncellendi');
  assert.deepEqual(outOf(e, 'oku').map(r => [r.ad, r.puan, r._satir]), [['Ayşe', '', 2], ['Can Öz', 3, 3]]);
  assert.ok(fakeGoogle.auth.every(a => a === 'Bearer sahte-token'));
});

test('Telegram tetikleyicisi botun webhook\'unu kaldırıp mesajları alır (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'telegramApi', name: 'bot', data: { token: '123:abc' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'telegramApi', id: cred.id, data: {} })).message, /@sahte_bot/);
  const w = await api('POST', '/api/workflows', wf('tg', [['telegramTrigger', { credential: cred.id, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  await sleep(1500);
  await api('PUT', `/api/workflows/${w.id}`, { active: false });
  assert.equal(fakeTelegram.webhook, false, 'webhook kaldırılmalı');
  const { items } = await api('GET', `/api/executions?workflowId=${w.id}`);
  assert.equal(items.length, 1);
  assert.equal(outOf(await waitExec(items[0].id), 'son')[0].mesaj, 'selam');
});

test('Google hesabına OAuth ile bağlanma; Gmail, Drive ve Takvim (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'googleOAuth', name: 'Google', data: { clientId: 'cid', clientSecret: 'sec', services: 'gmail,drive,calendar' } });
  let r = await fetch(`${B}/oauth/start?cred=${cred.id}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.match(loc.searchParams.get('scope'), /gmail\.modify .*drive .*calendar/);
  fakeG.challenge = loc.searchParams.get('code_challenge');
  r = await fetch(`${B}/oauth/callback?code=kod1&state=${loc.searchParams.get('state')}`);
  assert.match(await r.text(), /Bağlandı/);
  r = await fetch(`${B}/oauth/callback?code=kod1&state=sahte`); assert.equal(r.status, 400, 'bilinmeyen state reddedilmeli');
  const got = await api('GET', `/api/credentials/${cred.id}`);
  assert.equal(got.connected, true); assert.equal(got.account, 'ayse@gmail.com');
  assert.ok(!JSON.stringify(got).includes('g-at'), 'token tarayıcıya dönmemeli');
  const w = await api('POST', '/api/workflows', wf('google', [
    ['manual', { data: '[{"eposta":"can@ornek.com","ad":"Can"}]' }],
    ['gmail', { credential: cred.id, op: 'send', to: '{{ $json.eposta }}', subject: 'Merhaba {{ $json.ad }}', body: 'Toplanti yarin.' }, { name: 'gönder' }],
    ['gmail', { credential: cred.id, op: 'list', query: 'is:unread', max: 5 }, { name: 'oku' }],
    ['gmail', { credential: cred.id, op: 'read', messageId: '{{ $json.id }}' }, { name: 'okundu' }],
    ['drive', { credential: cred.id, op: 'upload', name: 'not.txt', source: 'text', content: 'Merhaba Drive' }, { name: 'yükle' }],
    ['drive', { credential: cred.id, op: 'download', fileId: '{{ $json.id }}' }, { name: 'indir' }],
    ['calendar', { credential: cred.id, op: 'create', title: 'Görüşme', start: '2030-01-02T10:00:00Z', minutes: 45, attendees: 'can@ornek.com' }, { name: 'etkinlik' }],
    ['calendar', { credential: cred.id, op: 'list', days: 3650 }, { name: 'takvim' }],
  ], [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [0, 6], [6, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'gönder')[0].gonderildi, true);
  const mail = outOf(e, 'oku')[0];
  assert.equal(mail.kime, 'can@ornek.com'); assert.equal(mail.konu, 'Merhaba Can'); assert.equal(mail.metin, 'Toplanti yarin.');
  assert.deepEqual(fakeG.mails[0].labelIds, ['INBOX'], 'okundu işaretlenmeli');
  assert.equal(outOf(e, 'indir')[0].dosya, 'not.txt');
  assert.equal(fs.readFileSync(path.join(DATA, 'dosyalar', 'not.txt'), 'utf8'), 'Merhaba Drive');
  const ev = outOf(e, 'etkinlik')[0];
  assert.equal(ev.baslik, 'Görüşme'); assert.deepEqual(ev.davetliler, ['can@ornek.com']);
  assert.equal(new Date(ev.bitis) - new Date(ev.baslangic), 45 * 60000);
  assert.equal(outOf(e, 'takvim').length, 1);
  assert.deepEqual([...new Set(fakeG.tokens)], ['authorization_code', 'refresh_token'], 'süresi dolan token yenilenmeli');
  assert.equal(fakeG.tokens.filter(t => t === 'refresh_token').length, 1, 'paralel node\'lar tek yenileme yapmalı');
  assert.ok(fakeG.auth.every(a => a === 'Bearer g-at2'));
});

test('Notion: veritabanına ekle, güncelle, sorgula, metin ekle (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'notionApi', name: 'n', data: { token: 'secret_x' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'notionApi', id: cred.id, data: {} })).message, /8n8 bot/);
  const db = 'https://www.notion.so/ekip/Gorevler-0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210';
  const w = await api('POST', '/api/workflows', wf('notion', [
    ['manual', { data: '[{"ad":"Rapor yaz","puan":"5","etiket":"iş, acil","bitti":"hayır"}]' }],
    ['notion', { credential: cred.id, op: 'create', database: db, fields: [{ key: 'Ad', value: '{{ $json.ad }}' }, { key: 'Puan', value: '{{ $json.puan }}' }, { key: 'etiketler', value: '{{ $json.etiket }}' }, { key: 'Bitti', value: '{{ $json.bitti }}' }, { key: 'Durum', value: 'Yapılacak' }], text: 'Birinci paragraf\n\nİkinci paragraf' }, { name: 'ekle' }],
    ['notion', { credential: cred.id, op: 'update', page: '{{ $json.id }}', fields: [{ key: 'Durum', value: 'Bitti' }, { key: 'Bitti', value: 'true' }] }, { name: 'guncelle' }],
    ['notion', { credential: cred.id, op: 'append', page: '{{ $json.id }}', text: 'Not: tamamlandı' }, { name: 'metin' }],
    ['notion', { credential: cred.id, op: 'query', database: db, filter: '{"property":"Durum","status":{"equals":"Bitti"}}' }, { name: 'sorgu' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const created = fakeN.pages[0];
  assert.equal(created.parent.database_id, '0123456789abcdef0123456789abcdef', 'bağlantıdan veritabanı kimliği alınmalı');
  assert.deepEqual(created.properties.Puan, { number: 5 });
  assert.deepEqual(created.properties.Etiketler.multi_select.map(x => x.name), ['iş', 'acil'], 'alan adı büyük-küçük harfe duyarsız eşleşmeli');
  assert.equal(outOf(e, 'ekle')[0].Bitti, false);
  assert.deepEqual(created.children.map(b => b.paragraph.rich_text[0].text.content), ['Birinci paragraf', 'İkinci paragraf', 'Not: tamamlandı']);
  assert.equal(outOf(e, 'ekle')[0].Ad, 'Rapor yaz');
  assert.equal(outOf(e, 'guncelle')[0].Durum, 'Bitti');
  assert.equal(outOf(e, 'guncelle')[0].Bitti, true);
  assert.equal(outOf(e, 'metin')[0].eklenenBlok, 1);
  assert.deepEqual(outOf(e, 'sorgu').map(r => [r.Ad, r.Puan, r.Etiketler]), [['Rapor yaz', 5, ['iş', 'acil']]]);
  assert.ok(fakeN.auth.every(a => a === 'Bearer secret_x'));
});

test('Slack: kanal adıyla mesaj, konu yanıtı, tepki ve tetikleyici (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'slackBot', name: 's', data: { token: 'xoxb-1' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'slackBot', id: cred.id, data: {} })).message, /Ekip.*@robot/);
  const w = await api('POST', '/api/workflows', wf('slack', [
    ['manual', { data: '[{"ad":"Ayşe"}]' }],
    ['slack', { credential: cred.id, op: 'send', channel: '#genel', text: 'Yeni kayıt: {{ $json.ad }}' }, { name: 'gonder' }],
    ['slack', { credential: cred.id, op: 'send', channel: '{{ $json.kanal }}', text: 'Ayrıntılar', thread: '{{ $json.ts }}' }, { name: 'yanit' }],
    ['slack', { credential: cred.id, op: 'react', channel: 'C111111', ts: '{{ $json.ts }}', emoji: ':tada:' }, { name: 'tepki' }],
    ['slack', { credential: cred.id, op: 'send', channel: '#yok', text: 'x' }, { name: 'hata', settings: { continueOnFail: true } }],
  ], [[0, 1], [1, 2], [2, 3], [0, 4]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeS.posts.map(p => [p.channel, p.text, p.thread_ts]), [['C111111', 'Yeni kayıt: Ayşe', undefined], ['C111111', 'Ayrıntılar', '1.0001']]);
  assert.deepEqual(fakeS.reactions, ['tada']);
  assert.match(JSON.stringify(outOf(e, 'hata')), /kanalı bulunamadı/);
  const t = await api('POST', '/api/workflows', wf('slack-tetik', [['slackTrigger', { credential: cred.id, channel: '#genel', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1300);
  fakeS.history.push({ ts: '5.0001', text: 'yeni soru', user: 'U2' }, { ts: '5.0002', text: 'bot', bot_id: 'B1' });
  await sleep(4500); // polls are at least 5 s apart
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  assert.equal(items.length, 1, 'yalnız yeni insan mesajı akışı başlatmalı');
  assert.equal(outOf(await waitExec(items[0].id), 'son')[0].metin, 'yeni soru');
});

test('Microsoft hesabına bağlanma ve Outlook: gönder, oku, yanıtla, okundu (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'microsoftOAuth', name: 'MS', data: { clientId: 'mcid', clientSecret: 'msec', tenant: 'common' } });
  let r = await fetch(`${B}/oauth/start?cred=${cred.id}`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.pathname, '/ms-auth');
  assert.match(loc.searchParams.get('scope'), /offline_access .*Mail\.Send/);
  r = await fetch(`${B}/oauth/callback?code=mkod&state=${loc.searchParams.get('state')}`);
  assert.match(await r.text(), /Bağlandı/);
  assert.equal((await api('GET', `/api/credentials/${cred.id}`)).account, 'can@contoso.com', 'preferred_username hesap adı olmalı');
  const w = await api('POST', '/api/workflows', wf('outlook', [
    ['manual', { data: '[{"eposta":"Ali <ali@ornek.com>","ad":"Ali"}]' }],
    ['outlook', { credential: cred.id, op: 'send', to: '{{ $json.eposta }}', subject: 'Merhaba {{ $json.ad }}', body: 'Toplantı yarın.' }, { name: 'gonder' }],
    ['outlook', { credential: cred.id, op: 'list', unread: true, max: 5 }, { name: 'oku' }],
    ['outlook', { credential: cred.id, op: 'reply', body: 'Teşekkürler' }, { name: 'yanit' }],
    ['outlook', { credential: cred.id, op: 'read' }, { name: 'okundu' }],
    ['http', { url: `http://127.0.0.1:${fakeClaude.port}/graph/me`, auth: 'cred', credential: cred.id }, { name: 'http' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeM.sent[0].message.toRecipients, [{ emailAddress: { address: 'ali@ornek.com' } }]);
  const m = outOf(e, 'oku')[0];
  assert.equal(m.konu, 'Merhaba Ali'); assert.equal(m.kimden, 'Can <can@contoso.com>'); assert.equal(m.metin, 'Toplantı\nyarın.'); assert.equal(m.okunmadi, true);
  assert.deepEqual(fakeM.replies, ['Teşekkürler']);
  assert.equal(fakeM.mails[0].isRead, true);
  assert.equal(outOf(e, 'http')[0].ad, 'Can');
  assert.ok(fakeM.auth.every(a => a === 'Bearer ms-at'));
});

test('Onay bekle: akış onay sayfasından gelen kararla devam eder, zaman aşımına sayılmaz', async () => {
  const w = await api('POST', '/api/workflows', wf('onay', [
    ['manual', { data: '[{"ad":"Ayşe","tutar":250}]' }],
    ['set', { fields: [{ key: 'link', value: '{{ $execution.onayAdresi }}' }], keep: true }, { name: 'link' }],
    ['approval', { message: '{{ $json.ad }} için {{ $json.tutar }} TL iade?', amount: 1, unit: 'h' }, { name: 'onay' }],
    ['noop', {}, { name: 'evet' }], ['noop', {}, { name: 'hayır' }],
  ], [[0, 1], [1, 2], [2, 3, 0], [2, 4, 1]], { settings: { timeout: 1 } }));
  const { executionId } = await api('POST', `/api/workflows/${w.id}/run`, {});
  await sleep(1600); // longer than the 1 s workflow timeout: waiting must not count
  const [a] = await api('GET', '/api/approvals');
  assert.ok(a && a.message === 'Ayşe için 250 TL iade?', JSON.stringify(a));
  const page = await (await fetch(a.url)).text();
  assert.ok(page.includes('Ayşe için 250 TL iade?') && page.includes('Onayla'));
  const r = await fetch(a.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'karar=evet&not=Tamam' });
  assert.match(await r.text(), /Onaylandı/);
  const e = await waitExec(executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'evet')[0].onay.karar, 'evet');
  assert.equal(outOf(e, 'evet')[0].onay.not, 'Tamam');
  assert.equal(outOf(e, 'link')[0].link, a.url);
  assert.equal((await fetch(a.url)).status, 404, 'karar verilen onay sayfası kapanmalı');
});

test('GitHub: konu aç, yorum yaz, kapat, dosya kaydet ve oku (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'githubApi', name: 'gh', data: { token: 'ghp_x' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'githubApi', id: cred.id, data: {} })).message, /@ayse/);
  const repo = 'https://github.com/ornek/depo/issues';
  const w = await api('POST', '/api/workflows', wf('github', [
    ['manual', { data: '[{"baslik":"Giriş bozuk","detay":"Boş sayfa"}]' }],
    ['github', { credential: cred.id, repo, op: 'createIssue', title: '{{ $json.baslik }}', body: '{{ $json.detay }}', labels: 'hata, acil' }, { name: 'ac' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'comment', body: 'Bakıyorum' }, { name: 'yorum' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'updateIssue', number: '{{ $json.numara }}', state: 'closed' }, { name: 'kapat' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'saveFile', path: 'notlar/rapor.md', content: '# Rapor', message: 'rapor' }, { name: 'kaydet' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'saveFile', path: 'notlar/rapor.md', content: '# Rapor 2' }, { name: 'guncelle' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'getFile', path: 'notlar/rapor.md' }, { name: 'oku' }],
    ['github', { credential: cred.id, repo: 'ornek/depo', op: 'listIssues', filter: 'all' }, { name: 'liste' }],
  ], [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [3, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeGH.issues.find(i => i.number === 1).labels, ['hata', 'acil']);
  assert.deepEqual(fakeGH.comments, [[1, 'Bakıyorum']]);
  assert.equal(outOf(e, 'kapat')[0].durum, 'closed');
  assert.deepEqual([outOf(e, 'kaydet')[0].islem, outOf(e, 'guncelle')[0].islem], ['olusturuldu', 'guncellendi']);
  assert.equal(outOf(e, 'oku')[0].icerik, '# Rapor 2');
  assert.deepEqual(outOf(e, 'liste').map(x => x.numara), [1], 'PR\'lar konu listesine karışmamalı');
  assert.ok(fakeGH.auth.every(a => a === 'Bearer ghp_x'));
});

test('Airtable: ekle, ekle-ya-da-güncelle, filtreyle listele, sil (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'airtableApi', name: 'at', data: { token: 'patX' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'airtableApi', id: cred.id, data: {} })).message, /ayse@ornek.com/);
  const link = 'https://airtable.com/appABCDEFGHIJKLMN/tblABCDEFGHIJKLMN/viwABCDEFGHIJKLMN';
  const rows = Array.from({ length: 12 }, (_, i) => ({ ad: `Kişi ${i + 1}`, eposta: `k${i + 1}@x.com` }));
  const w = await api('POST', '/api/workflows', wf('airtable', [
    ['manual', { data: JSON.stringify(rows) }],
    ['airtable', { credential: cred.id, base: link, op: 'create', fields: [{ key: 'Ad', value: '{{ $json.ad }}' }, { key: 'E-posta', value: '{{ $json.eposta }}' }] }, { name: 'ekle' }],
    ['code', { code: 'return [{ "Ad": "Yeni Ad", "E-posta": "k2@x.com" }, { "Ad": "Kişi 13", "E-posta": "k13@x.com" }];' }],
    ['airtable', { credential: cred.id, base: 'appABCDEFGHIJKLMN', table: 'Kişiler', op: 'upsert', mergeOn: 'E-posta', fieldsMode: 'all' }, { name: 'upsert' }],
    ['airtable', { credential: cred.id, base: link, op: 'list', formula: '{E-posta} = "k2@x.com"' }, { name: 'liste' }],
    ['airtable', { credential: cred.id, base: link, op: 'delete' }, { name: 'sil' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'ekle').length, 12);
  assert.deepEqual(fakeAT.batches, [10, 2, 2], '10\'arlı gruplar halinde gönderilmeli');
  assert.deepEqual(outOf(e, 'upsert').map(r => r._islem), ['guncellendi', 'eklendi']);
  assert.deepEqual(outOf(e, 'liste').map(r => r.Ad), ['Yeni Ad']);
  assert.equal(fakeAT.records.length, 12, 'filtrelenen kayıt silinmeli');
});

test('Discord: mesaj, kart, yanıt, tepki; GitHub ve Discord tetikleyicileri (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'discordBot', name: 'd', data: { token: 'dtok' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'discordBot', id: cred.id, data: {} })).message, /8n8bot/);
  const CH = '111111111111111111';
  const w = await api('POST', '/api/workflows', wf('discord', [
    ['manual', { data: '[{"ad":"Ayşe"}]' }],
    ['discord', { credential: cred.id, op: 'send', channel: `https://discord.com/channels/9/${CH}`, text: 'Merhaba {{ $json.ad }}', embedTitle: 'Sipariş', embedText: 'Hazır', embedColor: '#ff0000' }, { name: 'gonder' }],
    ['discord', { credential: cred.id, op: 'send', channel: '{{ $json.kanal }}', text: 'Ek bilgi', replyTo: '{{ $json.id }}' }, { name: 'yanit' }],
    ['discord', { credential: cred.id, op: 'react', channel: CH, emoji: '👍' }, { name: 'tepki' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(fakeDC.sent[0].embeds[0].color, 0xff0000);
  assert.equal(fakeDC.sent[1].message_reference.message_id, outOf(e, 'gonder')[0].id);
  assert.deepEqual(fakeDC.reactions, ['👍']);
  const ghc = await api('POST', '/api/credentials', { type: 'githubApi', name: 'gh2', data: { token: 'ghp_x' } });
  const t1 = await api('POST', '/api/workflows', wf('dc-tetik', [['discordTrigger', { credential: cred.id, channel: CH, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  const t2 = await api('POST', '/api/workflows', wf('gh-tetik', [['githubTrigger', { credential: ghc.id, repo: 'ornek/depo', event: 'issues', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t1.id}`, { active: true }); await api('PUT', `/api/workflows/${t2.id}`, { active: true });
  await sleep(1300);
  fakeDC.history.push({ id: '900000000000000001', channel_id: CH, content: 'yeni soru', author: { id: '5', username: 'can' } }, { id: '900000000000000002', channel_id: CH, content: 'bot', author: { id: '6', username: 'b', bot: true } });
  fakeGH.issues.push({ number: 99, id: 99, title: 'Yeni konu', state: 'open', body: '', user: { login: 'can' }, labels: [], html_url: 'x' });
  await sleep(4500);
  await api('PUT', `/api/workflows/${t1.id}`, { active: false }); await api('PUT', `/api/workflows/${t2.id}`, { active: false });
  for (const [t, field, val] of [[t1, 'metin', 'yeni soru'], [t2, 'baslik', 'Yeni konu']]) {
    const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
    assert.equal(items.length, 1, `${t.name}: yalnız yeni olay akışı başlatmalı`);
    assert.equal(outOf(await waitExec(items[0].id), 'son')[0][field], val);
  }
});

test('Yedekle ve geri yükle: akış, tablo, değişken, şifreli kimlik bilgisi', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'httpBearer', name: 'yedek-token', data: { token: 'gizli-123' } });
  const tbl = await api('POST', '/api/tables', { name: 'Yedek tablosu', columns: ['ad'] });
  await api('POST', `/api/tables/${tbl.id}/rows`, { rows: [{ ad: 'Ayşe' }, { ad: 'Can' }] });
  await api('PUT', '/api/variables', { ...(await api('GET', '/api/variables')), YEDEK_DENEME: 'evet' });
  const w = await api('POST', '/api/workflows', { ...wf('yedeklenen', [['schedule', { mode: 'interval', every: 1, unit: 'h' }], ['noop']], [[0, 1]]), tags: ['yedek'] });
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  await assert.rejects(api('POST', '/api/backup', { password: 'kisa' }), /en az 8/);
  const b = await api('POST', '/api/backup', { password: 'uzun-sifre-1' });
  assert.ok(!JSON.stringify(b).includes('gizli-123'), 'kimlik bilgisi düz metin olmamalı');
  const plain = await api('POST', '/api/backup', {});
  assert.equal(plain.kimlikBilgileri, null);
  await api('DELETE', `/api/workflows/${w.id}`); await api('DELETE', `/api/credentials/${cred.id}`); await api('DELETE', `/api/tables/${tbl.id}`);
  await assert.rejects(api('POST', '/api/restore', { backup: b, password: 'yanlis-sifre' }), /şifresi yanlış/);
  await assert.rejects(api('POST', '/api/restore', { backup: { format: 'baska' } }), /8n8 yedeği değil/);
  const r = await api('POST', '/api/restore', { backup: b, password: 'uzun-sifre-1' });
  assert.ok(r.akislar >= 1 && r.kimlikBilgileri >= 1 && r.tablolar >= 1, JSON.stringify(r));
  const back = await api('GET', `/api/workflows/${w.id}`);
  assert.equal(back.active, true, 'etkin akış yeniden etkinleşmeli'); assert.deepEqual(back.tags, ['yedek']);
  assert.deepEqual((await api('GET', `/api/tables/${tbl.id}`)).rows.map(x => x.ad), ['Ayşe', 'Can']);
  assert.equal((await api('GET', '/api/variables')).YEDEK_DENEME, 'evet');
  assert.ok((await api('GET', '/api/credentials')).some(c => c.id === cred.id && c.name === 'yedek-token'));
  await api('PUT', `/api/workflows/${w.id}`, { active: false });
});

test('Claude ile sınıflandır ve bilgi çıkar (sahte API, yapılandırılmış çıktı)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'c-yapisal', data: { apiKey: 'sk-test' } });
  const w = await api('POST', '/api/workflows', wf('ai', [
    ['manual', { data: '[{"mesaj":"Kargom gelmedi, bu bir şikâyet"},{"mesaj":"Fiyat sorusu: kaç para?"},{"mesaj":"Merhaba"}]' }],
    ['classify', { credential: cred.id, categories: [{ key: 'Şikâyet', value: '' }, { key: 'Soru', value: '' }], other: true }, { name: 'sinif' }],
    ['noop', {}, { name: 'sikayet' }], ['noop', {}, { name: 'soru' }], ['noop', {}, { name: 'diger' }],
    ['extract', { credential: cred.id, text: '{{ $json.mesaj }}', fields: [{ key: 'ad', value: 'adı' }, { key: 'tutar:sayı', value: '' }, { key: 'acil:evet-hayır', value: '' }, { key: 'urunler:liste', value: '' }, { key: 'teslim:tarih', value: '' }, { key: 'not', value: '' }] }, { name: 'cikar' }],
  ], [[0, 1], [1, 2, 0], [1, 3, 1], [1, 4, 2], [2, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual([outOf(e, 'sikayet').length, outOf(e, 'soru').length, outOf(e, 'diger').length], [1, 1, 1]);
  assert.equal(outOf(e, 'soru')[0].kategori, 'Soru');
  const x = outOf(e, 'cikar')[0];
  assert.deepEqual([x.ad, x.tutar, x.acil, x.urunler, x.teslim, x.not], ['Ayşe Yılmaz', 1250.5, true, ['kalem', 'defter'], '2026-11-03', null]);
  const req = fakeClaude.calls.filter(c => c.body.output_config?.format).at(-1).body;
  assert.deepEqual(req.output_config.format.schema.properties.tutar, { type: ['number', 'null'] });
  assert.equal(req.output_config.format.schema.additionalProperties, false);
  const bad = await api('POST', '/api/workflows', wf('ai-bad', [['manual', { data: '[{"metin":"a"}]' }], ['extract', { credential: cred.id, fields: [{ key: 'x:renk', value: '' }] }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${bad.id}/run`, {})).executionId);
  assert.match(e2.error, /bilinmeyen tür "renk"/);
});

/* tiny zip writer (stored + deflate) to make a .docx without extra packages */
function makeZip(files) {
  const zlib = require('zlib');
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], cents = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, data); cents.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(cents), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(cents.length / 2, 8); e.writeUInt16LE(cents.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('Bilgi tabanı: belge yükle (.txt, .docx), ara, Claude belgelere göre cevaplar (sahte API)', async () => {
  const k = await api('POST', '/api/kb', { name: 'Müşteri SSS' });
  await assert.rejects(api('POST', '/api/kb', { name: 'müşteri sss' }), /zaten var/);
  const t = await api('POST', `/api/kb/${k.id}/docs`, { ad: 'iade.txt', icerik: Buffer.from('İade politikası\n\nÜrünleri teslimden sonra 14 gün içinde iade edebilirsiniz. İade kargosu ücretsizdir.\n\nKargo\n\nSiparişler 2 iş gününde kargoya verilir.').toString('base64') });
  assert.equal(t.parca, 1);
  const docx = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Çalışma saatleri</w:t></w:r></w:p><w:p><w:r><w:t>Mağazamız hafta içi 09:00-18:00 arası açıktır.</w:t></w:r></w:p></w:body></w:document>' });
  const d = await api('POST', `/api/kb/${k.id}/docs`, { ad: 'saatler.docx', icerik: docx.toString('base64') });
  assert.ok(d.karakter > 20, 'docx metni okunmalı');
  await assert.rejects(api('POST', `/api/kb/${k.id}/docs`, { ad: 'x.pdf', icerik: 'JVBERi0=' }), /PDF/);
  const s1 = await api('GET', `/api/kb/${k.id}/search?q=${encodeURIComponent('iadeler kaç günde yapılır')}`);
  assert.equal(s1[0].belge, 'iade.txt');
  const s2 = await api('GET', `/api/kb/${k.id}/search?q=${encodeURIComponent('mağaza saat kaçta açık')}`);
  assert.equal(s2[0].belge, 'saatler.docx');
  const info = await api('GET', `/api/kb/${k.id}`);
  assert.equal(info.belgeler.length, 2);
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'c-bilgi', data: { apiKey: 'sk-test' } });
  const w = await api('POST', '/api/workflows', wf('bilgi', [
    ['manual', { data: '[{"mesaj":"İade süresi kaç gün?"},{"mesaj":"zzzz qqqq"}]' }],
    ['knowledge', { kb: 'Müşteri SSS', op: 'ask', credential: cred.id, question: '{{ $json.mesaj }}' }, { name: 'sor' }],
    ['knowledge', { kb: k.id, op: 'add', docName: 'yeni.txt', source: 'text', content: 'Hediye paketi ücretsizdir.' }, { name: 'ekle' }],
  ], [[0, 1], [1, 2]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const [a, b] = outOf(e, 'sor');
  assert.match(a.cevap, /14 gün/);
  assert.deepEqual([a.kaynaklar, a.bilgiBulundu], [['iade.txt'], true]);
  assert.equal(b.bilgiBulundu, false);
  assert.equal(outOf(e, 'ekle')[0].islem, 'eklendi');
  const req = fakeClaude.calls.filter(c => c.body.output_config?.format?.schema?.properties?.cevap).at(-1).body;
  assert.ok(String(req.messages[0].content).includes('<bolum no="1" belge="iade.txt">'));
  assert.equal((await api('GET', `/api/kb/${k.id}`)).docs, 3);
  // the agent can search the knowledge base as a tool
  const w2 = await api('POST', '/api/workflows', wf('bilgi-ajan', [['manual', { data: '[{"m":"bilgi tabanına bak: kargo ne zaman"}]' }], ['agent', { credential: cred.id, prompt: '{{ $json.m }}', kb: k.id, toolHttp: false }, { name: 'ajan' }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.equal(outOf(e2, 'ajan')[0].araclar[0].arac, 'bilgi_tabaninda_ara');
  assert.match(outOf(e2, 'ajan')[0].yanit, /iade\.txt/);
  await api('DELETE', `/api/kb/${k.id}/docs/${d.id}`);
  assert.equal((await api('GET', `/api/kb/${k.id}`)).docs, 2);
});

test('Hata bildirimi: etkin akış hata verince Telegram\'a bir kez haber verilir', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'telegramApi', name: 'tg-bildirim', data: { token: '123:abc' } });
  await assert.rejects(api('PUT', '/api/notify', { kanal: 'telegram', credential: cred.id, hedef: '' }), /sohbet kimliğini/);
  await assert.rejects(api('PUT', '/api/notify', { kanal: 'email', credential: cred.id, hedef: 'a@b.c' }), /uymuyor/);
  await api('PUT', '/api/notify', { kanal: 'telegram', credential: cred.id, hedef: '55', throttle: 10 });
  const before = (fakeTelegram.sent || []).length;
  await api('POST', '/api/notify/test', {});
  assert.match(fakeTelegram.sent.at(-1).text, /deneme bildirimi/);
  const w = await api('POST', '/api/workflows', wf('bozuk-webhook', [['webhook', { method: 'POST', path: 'bozuk', respond: 'lastNode' }], ['code', { code: 'throw new Error("stok bitti");' }, { name: 'stok' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: true });
  for (let i = 0; i < 2; i++) await fetch(`${B}/webhook/bozuk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(r => setTimeout(r, 400));
  const sent = fakeTelegram.sent.slice(before + 1);
  assert.equal(sent.length, 1, `aynı akış için 10 dakikada bir bildirim: ${JSON.stringify(fakeTelegram.sent)}`);
  assert.equal(String(sent[0].chat_id), '55');
  assert.match(sent[0].text, /"bozuk-webhook" akışı hata verdi[\s\S]*stok bitti[\s\S]*#\/calistirma\//);
  await api('PUT', '/api/workflows/' + w.id, { ...w, active: false });
  await api('PUT', '/api/notify', { kanal: '' });
});

test('Çöp kutusu: silinen akış sürümleriyle geri alınır, kalıcı silinir', async () => {
  const w = await api('POST', '/api/workflows', wf('silinecek', [['manual', {}]], [], { tags: ['deneme'] }));
  await api('PUT', `/api/workflows/${w.id}`, { ...w, name: 'silinecek 2' });
  await api('DELETE', `/api/workflows/${w.id}`);
  await assert.rejects(api('GET', `/api/workflows/${w.id}`), /404|bulunamadı/i);
  const t = await api('GET', '/api/trash');
  assert.equal(t.find(x => x.id === w.id)?.name, 'silinecek 2');
  const r = await api('POST', `/api/trash/${w.id}/restore`, {});
  assert.equal(r.active, false);
  assert.ok((await api('GET', `/api/workflows/${w.id}/versions`)).length >= 1, 'sürüm geçmişi geri gelmeli');
  assert.ok(!(await api('GET', '/api/trash')).some(x => x.id === w.id));
  await api('DELETE', `/api/workflows/${w.id}`);
  await api('DELETE', `/api/trash/${w.id}`);
  assert.ok(!(await api('GET', '/api/trash')).some(x => x.id === w.id));
  await assert.rejects(api('POST', `/api/trash/${w.id}/restore`, {}), /yok/);
});

/* hand-made PDF: one Helvetica (WinAnsi) line and one line in a font whose ToUnicode CMap maps codes 1-6 to Turkish letters */
function makePdf() {
  const zlib = require('zlib');
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 750 Td (Garanti suresi 2 yil.) Tj 0 -16 Td [(Kargo) -250 (ucretsiz.)] TJ ET\nBT /F2 12 Tf 72 700 Td <0102030405> Tj ( TL) Tj ET', 'latin1'));
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <015F> <02> <0131> <03> <011F> endbfchar 1 beginbfrange <04> <05> <00FC> endbfrange endcmap end end';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 7 0 R >>'];
  const parts = [Buffer.from('%PDF-1.4\n')];
  objs.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)));
  parts.push(Buffer.from(`6 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n'));
  parts.push(Buffer.from(`7 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('PDF ve Excel: bilgi tabanına PDF, web sayfası; Excel yaz/oku; tabloya Excel içe/dışa aktarma', async () => {
  const k = await api('POST', '/api/kb', { name: 'Belgeler' });
  const p = await api('POST', `/api/kb/${k.id}/docs`, { ad: 'garanti.pdf', icerik: makePdf().toString('base64') });
  assert.ok(p.parca >= 1);
  const hit = (await api('GET', `/api/kb/${k.id}/search?q=garanti`))[0];
  assert.equal(hit.metin, 'Garanti suresi 2 yil.\nKargo ucretsiz.\n\nşığüý TL');
  const u = await api('POST', `/api/kb/${k.id}/docs`, { url: `http://127.0.0.1:${fakeClaude.port}/sayfa.html` });
  assert.equal(u.ad, `127.0.0.1_sayfa.html`);
  assert.equal((await api('GET', `/api/kb/${k.id}/search?q=${encodeURIComponent('teslimat')}`))[0].belge, u.ad);
  // Excel round trip through the file nodes
  const w = await api('POST', '/api/workflows', wf('excel', [
    ['manual', { data: '[{"ad":"Ayşe","tutar":12.5,"odendi":true},{"ad":"Can","tutar":7}]' }],
    ['writeFile', { path: 'rapor.xlsx', format: 'xlsx', sheet: 'Satışlar' }, { name: 'yaz' }],
    ['readFile', { path: 'rapor.xlsx', format: 'auto' }, { name: 'oku' }],
  ], [[0, 1], [1, 2]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'oku'), [{ ad: 'Ayşe', tutar: 12.5, odendi: true }, { ad: 'Can', tutar: 7, odendi: null }]);
  fs.writeFileSync(path.join(DATA, 'dosyalar', 'garanti.pdf'), makePdf());
  const w2 = await api('POST', '/api/workflows', wf('pdf-oku', [['manual', {}], ['readFile', { path: 'garanti.pdf' }, { name: 'oku' }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.match(outOf(e2, 'oku')[0].icerik, /^Garanti suresi/);
  // tables: import the Excel file, export it again
  const t = await api('POST', '/api/tables', { name: 'Excelden' });
  const imp = await api('POST', `/api/tables/${t.id}/import`, { ad: 'rapor.xlsx', icerik: fs.readFileSync(path.join(DATA, 'dosyalar', 'rapor.xlsx')).toString('base64') });
  assert.deepEqual([imp.added, imp.sayfa], [2, 'Satışlar']);
  const ex = await api('GET', `/api/tables/${t.id}/xlsx`);
  const X = require('../lib/xlsx');
  assert.deepEqual(X.toItems(X.readWorkbook(Buffer.from(ex.icerik, 'base64'))[0].rows)[0], { ad: 'Ayşe', tutar: 12.5, odendi: true });
});

test('Form ve webhook ile dosya yükleme', async () => {
  const w = await api('POST', '/api/workflows', wf('basvuru', [
    ['form', { path: 'cv', title: 'Başvuru', fields: [{ label: 'Ad', name: 'ad', type: 'text', required: true }, { label: 'Özgeçmiş', name: 'cv', type: 'file', required: true }] }],
    ['readFile', { path: '{{ $json.cv.dosya }}', format: 'text' }, { name: 'oku' }],
  ], [[0, 1]]));
  const page = await (await fetch(`${B}/form-test/cv`)).text();
  assert.ok(page.includes('enctype="multipart/form-data"') && page.includes('type="file"'));
  const fd = new FormData(); fd.append('ad', 'Selin'); fd.append('cv', new Blob(['Deneyim: 5 yıl']), 'özgeçmiş.txt');
  const r = await fetch(`${B}/form-test/cv`, { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  await sleep(300);
  const e = await waitExec((await api('GET', `/api/executions?workflowId=${w.id}`)).items[0].id);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'oku')[0].icerik, 'Deneyim: 5 yıl');
  const fd2 = new FormData(); fd2.append('ad', 'Boş');
  assert.equal((await fetch(`${B}/form-test/cv`, { method: 'POST', body: fd2 })).status, 400, 'zorunlu dosya');
  const w2 = await api('POST', '/api/workflows', wf('yukle', [['webhook', { method: 'POST', path: 'yukle', respond: 'lastNode' }]], []));
  const fd3 = new FormData(); fd3.append('not', 'fatura'); fd3.append('dosya', new Blob([Buffer.from([1, 2, 3])], { type: 'application/pdf' }), 'f.pdf'); fd3.append('dosya', new Blob(['x']), 'b.txt');
  const out = await (await fetch(`${B}/webhook-test/yukle`, { method: 'POST', body: fd3 })).json();
  assert.equal(out.body.not, 'fatura');
  assert.deepEqual(out.body.dosya.map(d => [d.ad, d.tur, d.boyut]), [['f.pdf', 'application/pdf', 3], ['b.txt', 'application/octet-stream', 1]]);
  assert.ok(fs.existsSync(path.join(DATA, 'dosyalar', out.body.dosya[0].dosya)));
  // other public endpoints do not accept uploads
  const fd4 = new FormData(); fd4.append('x', new Blob(['y']), 'a.txt');
  assert.equal((await fetch(`${B}/sohbet-test/asistan`, { method: 'POST', body: fd4 })).status, 415);
});

test('E-posta gelince (IMAP): yeni e-postayı Türkçe konu ve ekiyle alır, okundu işaretler (sahte sunucu)', async () => {
  const M = require('../lib/mime');
  assert.equal(M.decodeWords('=?ISO-8859-9?Q?=DEcret_fatura?= =?UTF-8?B?w7xjcmV0?='), 'Şcret faturaücret');
  const bad = { type: 'imap', name: 'imap-yanlis', data: { host: '127.0.0.1', port: String(fakeIMAP.port), secure: 'false', user: 'kutu@ornek.com', password: 'yanlis' } };
  const t0 = await api('POST', '/api/credentials/test', bad); assert.equal(t0.ok, false); assert.match(t0.message, /girişi başarısız.*Invalid credentials/);
  const cred = await api('POST', '/api/credentials', { ...bad, name: 'imap', data: { ...bad.data, password: 'dogru-sifre' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'imap', id: cred.id, data: bad.data && { ...bad.data, password: '' } })).message, /2 e-posta/);
  const w = await api('POST', '/api/workflows', wf('posta', [['emailTrigger', { credential: cred.id, every: 5, unit: 's', markSeen: true, attachments: true }, { name: 'posta' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: true });
  await sleep(600); // first check only remembers
  const pdf = Buffer.from('%PDF-1.4 sahte').toString('base64');
  fakeIMAP.msgs.push({ uid: 3, flags: [], raw: ['From: =?UTF-8?B?QXnFn2UgWcSxbG1heg==?= <ayse@ornek.com>', 'To: kutu@ornek.com', 'Subject: =?ISO-8859-9?Q?Sipari=FE_faturas=FD?=', 'Date: Tue, 20 Oct 2026 10:00:00 +0300', 'Message-ID: <abc@ornek.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="SINIR"', '', '--SINIR', 'Content-Type: text/plain; charset=iso-8859-9', 'Content-Transfer-Encoding: quoted-printable', '', 'Merhaba, fatura ekte. Te=FEekk=FCrler.', '--SINIR', 'Content-Type: application/pdf; name="fatura.pdf"', 'Content-Disposition: attachment; filename="fatura.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '--SINIR--', ''].join('\r\n') });
  fakeIMAP.uidNext = 4;
  let e;
  for (let k = 0; k < 80 && !e; k++) { await sleep(150); const l = await api('GET', `/api/executions?workflowId=${w.id}`); if (l.items[0]) e = await waitExec(l.items[0].id); }
  assert.ok(e, 'yeni e-posta akışı başlatmalı');
  const m = outOf(e, 'son')[0];
  assert.deepEqual([m.id, m.kimden, m.konu, m.metin, m.tarih], [3, 'Ayşe Yılmaz <ayse@ornek.com>', 'Sipariş faturası', 'Merhaba, fatura ekte. Teşekkürler.', '2026-10-20T07:00:00.000Z']);
  assert.deepEqual([m.ekler[0].ad, m.ekler[0].tur], ['fatura.pdf', 'application/pdf']);
  assert.equal(fs.readFileSync(path.join(DATA, 'dosyalar', m.ekler[0].dosya), 'utf8'), '%PDF-1.4 sahte');
  assert.ok(fakeIMAP.msgs[2].flags.includes('\\Seen'));
  assert.equal((await api('GET', `/api/executions?workflowId=${w.id}`)).items.length, 1, 'eski e-postalar akışı başlatmaz');
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: false });
});

test('WhatsApp: doğrulama, imzalı gelen mesaj, yanıt ve 24 saat kuralı hatası (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'whatsappApi', name: 'wa', data: { token: 'wa-token', phoneNumberId: '1234', verifyToken: 'gizli-soz', appSecret: 'app-sir' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'whatsappApi', id: cred.id, data: { phoneNumberId: '1234' } })).message, /Mağaza/);
  const w = await api('POST', '/api/workflows', wf('wa', [
    ['whatsappTrigger', { credential: cred.id, path: 'magaza' }],
    ['whatsapp', { credential: cred.id, op: 'text', to: '{{ $json.kimden }}', text: 'Merhaba {{ $json.ad }}, mesajınız: {{ $json.mesaj }}', replyTo: '{{ $json.mesajId }}' }, { name: 'yanit' }],
  ], [[0, 1]]));
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: true });
  assert.equal(await (await fetch(`${B}/whatsapp/magaza?hub.mode=subscribe&hub.verify_token=gizli-soz&hub.challenge=4242`)).text(), '4242');
  assert.equal((await fetch(`${B}/whatsapp/magaza?hub.mode=subscribe&hub.verify_token=yanlis&hub.challenge=1`)).status, 403);
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '902120000000', phone_number_id: '1234' }, contacts: [{ profile: { name: 'Ayşe' }, wa_id: '905321234567' }], messages: [{ from: '905321234567', id: 'wamid.gelen', timestamp: '1760000000', type: 'text', text: { body: 'Kargom nerede?' } }] } }] }] });
  const sig = 'sha256=' + require('crypto').createHmac('sha256', 'app-sir').update(body).digest('hex');
  assert.equal((await fetch(`${B}/whatsapp/magaza`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body })).status, 401);
  const before = fakeWA.sent.length;
  assert.equal((await fetch(`${B}/whatsapp/magaza`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body })).status, 200);
  for (let k = 0; k < 40 && fakeWA.sent.length === before; k++) await sleep(100);
  assert.deepEqual(fakeWA.sent.at(-1), { messaging_product: 'whatsapp', to: '905321234567', type: 'text', text: { body: 'Merhaba Ayşe, mesajınız: Kargom nerede?', preview_url: true }, context: { message_id: 'wamid.gelen' } });
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: false });
  const w2 = await api('POST', '/api/workflows', wf('wa2', [['manual', { data: '[{"tel":"0555 000 00 00"}]' }], ['whatsapp', { credential: cred.id, op: 'text', to: '{{ $json.tel }}', text: 'Selam' }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.match(e2.error, /24 saatte/);
  assert.equal(fakeWA.sent.at(-1).to, '905550000000');
});

test('Claude ile bilgi çıkar: PDF ve resim dosyası Claude\'a belge olarak gider (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'c-dosya', data: { apiKey: 'sk-test' } });
  fs.writeFileSync(path.join(DATA, 'dosyalar', 'tarama.pdf'), '%PDF-1.4 resim');
  fs.writeFileSync(path.join(DATA, 'dosyalar', 'fis.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  const w = await api('POST', '/api/workflows', wf('dosyadan', [['manual', { data: '[{"f":"tarama.pdf"},{"f":"fis.jpg"}]' }], ['extract', { credential: cred.id, source: 'file', file: '{{ $json.f }}', fields: [{ key: 'tutar:sayı', value: '' }] }, { name: 'cikar' }]], [[0, 1]]));
  const n0 = fakeClaude.calls.length;
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.equal(outOf(e, 'cikar')[0].tutar, 1250.5);
  const [a, b] = fakeClaude.calls.slice(n0).map(c => c.body.messages[0].content);
  assert.deepEqual([a[0].type, a[0].source.media_type, b[0].type, b[0].source.media_type], ['document', 'application/pdf', 'image', 'image/jpeg']);
  assert.equal(Buffer.from(a[0].source.data, 'base64').toString(), '%PDF-1.4 resim');
});

test('Bütün şablonlar açılır; "Metinden bilgi çıkar" şablonu çalışır (sahte API)', async () => {
  const list = await api('GET', '/api/templates');
  assert.ok(list.length >= 12);
  const made = {};
  for (const t of list) made[t.key] = await api('POST', `/api/templates/${t.key}`, {});
  const w = made.fatura;
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'c-sablon', data: { apiKey: 'sk-test' } });
  for (const n of w.nodes) if (n.type === 'extract') n.params.credential = cred.id;
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: true });
  const r = await fetch(`${B}/webhook/fatura`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metin: 'ABC Ltd. fatura no F-12, toplam 1.250,50 TL' }) });
  const out = await r.json();
  assert.equal(r.status, 200, JSON.stringify(out));
  assert.equal(out.tutar, 1250.5);
  const tb = (await api('GET', '/api/tables')).find(x => x.name === 'Faturalar');
  assert.equal(tb.rowCount, 1);
  await api('PUT', `/api/workflows/${w.id}`, { ...w, active: false });
});

test('Ödeme ve e-ticaret: Stripe, Shopify, WooCommerce ve tetikleyicileri (sahte API)', async () => {
  const mk = async (type, data) => { const c = await api('POST', '/api/credentials', { type, name: type, data }); return c.id; };
  const st = await mk('stripeApi', { secretKey: 'sk_test_x' }), sh = await mk('shopifyApi', { shop: 'kupa.myshopify.com', token: 'shpat_x' }), wo = await mk('wooApi', { url: 'https://magaza.com', key: 'ck_x', secret: 'cs_x' });
  assert.match((await api('POST', '/api/credentials/test', { type: 'stripeApi', id: st, data: {} })).message, /test hesabı/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'shopifyApi', id: sh, data: { shop: 'kupa.myshopify.com' } })).message, /Kupa Dükkânı/);
  const bad = await api('POST', '/api/credentials/test', { type: 'wooApi', data: { url: 'https://magaza.com', key: 'ck_x', secret: 'yanlis' } });
  assert.equal(bad.ok, false); assert.match(bad.message, /WooCommerce \(401\).*listeleyemezsiniz/);
  const w = await api('POST', '/api/workflows', wf('eticaret', [
    ['manual', { data: '[{"siparis":"A-7","tutar":"1.250,50"},{"siparis":"A-8","tutar":"99,9"}]' }],
    ['stripe', { credential: st, op: 'paymentLink', name: 'Sipariş {{ $json.siparis }}', amount: '{{ $json.tutar }}', currency: 'try', quantity: 1, metadata: [{ key: 'siparis', value: '{{ $json.siparis }}' }] }, { name: 'link' }],
    ['stripe', { credential: st, op: 'findCustomer', email: 'eski@ornek.com' }, { name: 'bul' }],
    ['shopify', { credential: sh, op: 'tagOrder', orderId: '5001', note: 'Kargoya verildi', tags: 'kargo, eski' }, { name: 'etiket' }],
    ['shopify', { credential: sh, op: 'stock', sku: 'KUP-1', qty: '12' }, { name: 'stok' }],
    ['woocommerce', { credential: wo, op: 'status', orderId: '701', status: 'completed' }, { name: 'durum' }],
    ['woocommerce', { credential: wo, op: 'note', orderId: '701', note: 'Kargo no: 123', customerNote: true }, { name: 'not' }],
    ['woocommerce', { credential: wo, op: 'stock', sku: 'KLV-1', qty: '0' }, { name: 'wstok' }],
    ['limit', { max: 1 }],
    ['stripe', { credential: st, op: 'refund', paymentId: 'pi_1', amount: '' }, { name: 'iade' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeBiz.stripe.prices.map(p => [p.unit_amount, p.currency, p.name]), [[125050, 'try', 'Sipariş A-7'], [9990, 'try', 'Sipariş A-8']]);
  assert.deepEqual(outOf(e, 'link').map(x => [x.odemeBaglantisi, x.siparis]), [['https://buy.stripe.com/test_1', 'A-7'], ['https://buy.stripe.com/test_2', 'A-8']]);
  assert.deepEqual([fakeBiz.stripe.links[0].price, fakeBiz.stripe.links[0].quantity, fakeBiz.stripe.links[1].metadata.siparis], ['price_1', 1, 'A-8']);
  assert.deepEqual([outOf(e, 'bul')[0].musteriBulundu, outOf(e, 'bul')[0].musteriId], [true, 'cus_0']);
  assert.equal(fakeBiz.shop.orders[0].tags, 'eski, kargo', 'etiketler birleşmeli, tekrar etmemeli');
  assert.equal(fakeBiz.shop.orders[0].note, 'Kargoya verildi');
  assert.deepEqual(fakeBiz.shop.levels[0], { location_id: 9, inventory_item_id: 111, available: 12 });
  assert.deepEqual([outOf(e, 'stok')[0].urun, outOf(e, 'stok')[0].konum], ['Kupa', 'Ana depo']);
  assert.equal(fakeBiz.woo.orders[0].status, 'completed');
  assert.deepEqual(fakeBiz.woo.notes[0], { order: 701, note: 'Kargo no: 123', customer_note: true });
  assert.deepEqual([fakeBiz.woo.products[0].stock_quantity, fakeBiz.woo.products[0].manage_stock], [0, true]);
  assert.deepEqual(outOf(e, 'iade')[0], { id: 're_1', durum: 'succeeded', tutar: 250 });
  // pollers: the first check only remembers, then only new orders/events start the workflow
  const t1 = await api('POST', '/api/workflows', wf('stripe-tetik', [['stripeTrigger', { credential: st, type: 'payment_intent.succeeded', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  const t2 = await api('POST', '/api/workflows', wf('shopify-tetik', [['shopifyTrigger', { credential: sh, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  const t3 = await api('POST', '/api/workflows', wf('woo-tetik', [['wooTrigger', { credential: wo, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  for (const t of [t1, t2, t3]) await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1300);
  fakeBiz.stripe.events.unshift({ id: 'evt_2', type: 'payment_intent.succeeded', created: 1761000000, data: { object: { id: 'pi_2', object: 'payment_intent', amount_received: 125050, currency: 'try', receipt_email: 'yeni@ornek.com', status: 'succeeded', metadata: { siparis: 'A-7' } } } });
  fakeBiz.stripe.events.unshift({ id: 'evt_3', type: 'customer.created', created: 1761000001, data: { object: { id: 'cus_9', object: 'customer', email: 'baska@ornek.com' } } });
  fakeBiz.shop.orders.unshift({ id: 5002, name: '#1002', email: 'zeynep@ornek.com', total_price: '225.00', currency: 'TRY', financial_status: 'paid', customer: { first_name: 'Zeynep' }, shipping_address: { address1: 'Atatürk Cd. 1', city: 'Bursa', country: 'Turkey' }, line_items: [{ title: 'Kupa', quantity: 1, price: '225.00', sku: 'KUP-1' }] });
  fakeBiz.woo.orders.unshift({ id: 702, number: '702', status: 'processing', total: '120.00', currency: 'TRY', billing: { first_name: 'Ece', email: 'ece@ornek.com' }, shipping: {}, line_items: [] });
  await sleep(4500);
  for (const t of [t1, t2, t3]) await api('PUT', `/api/workflows/${t.id}`, { active: false });
  for (const [t, check] of [[t1, x => assert.deepEqual([x.olayId, x.tutar, x.eposta, x.metadata.siparis], ['evt_2', 1250.5, 'yeni@ornek.com', 'A-7'])],
    [t2, x => assert.deepEqual([x.no, x.musteri, x.adres, x.urunler[0].sku], ['#1002', 'Zeynep', 'Atatürk Cd. 1, Bursa, Turkey', 'KUP-1'])],
    [t3, x => assert.deepEqual([x.id, x.musteri, x.tutar], [702, 'Ece', 120])]]) {
    const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
    assert.equal(items.length, 1, `${t.name}: yalnız yeni kayıt akışı başlatmalı`);
    check(outOf(await waitExec(items[0].id), 'son')[0]);
  }
});

test('İş takibi ve CRM: Trello, Jira, HubSpot, Mailchimp (sahte API)', async () => {
  const mk = async (type, data) => (await api('POST', '/api/credentials', { type, name: type, data })).id;
  const tr = await mk('trelloApi', { key: 'tkey', token: 'ttok' }), ji = await mk('jiraApi', { site: 'sirket.atlassian.net', email: 'ayse@ornek.com', token: 'jtok' });
  const hs = await mk('hubspotApi', { token: 'pat-x' }), mc = await mk('mailchimpApi', { apiKey: 'abc123-us21' });
  for (const [type, id, data, re] of [['trelloApi', tr, { key: 'tkey' }, /Ayşe Yılmaz/], ['jiraApi', ji, { site: 'sirket.atlassian.net', email: 'ayse@ornek.com' }, /Ayşe Yılmaz/], ['hubspotApi', hs, {}, /kişiler okunabiliyor/], ['mailchimpApi', mc, {}, /Chimpy/]])
    assert.match((await api('POST', '/api/credentials/test', { type, id, data })).message, re);
  const w = await api('POST', '/api/workflows', wf('crm', [
    ['manual', { data: '[{"konu":"Yazıcı çalışmıyor","metin":"Üçüncü kattaki yazıcı.\\n\\nAcil.","eposta":"Var@Ornek.com","ad":"Veli"},{"konu":"Yeni bilgisayar","metin":"","eposta":"yeni@ornek.com","ad":"Nur"}]' }],
    ['trello', { credential: tr, op: 'create', listId: 'L1', name: '{{ $json.konu }}', desc: '{{ $json.metin }}' }, { name: 'kart' }],
    ['trello', { credential: tr, op: 'move', listId: 'L2', cardId: '{{ $json.id }}' }, { name: 'tasi' }],
    ['trello', { credential: tr, op: 'comment', cardId: '{{ $json.id }}', text: 'Ele alındı' }, { name: 'yorum' }],
    ['trello', { credential: tr, op: 'list', listId: 'L2' }, { name: 'liste' }],
    ['jira', { credential: ji, op: 'create', project: 'DESTEK', issueType: 'Task', summary: '{{ $json.ad }}', description: '{{ $json.aciklama }}', labels: 'trello, ofis destek' }, { name: 'kayit' }],
    ['jira', { credential: ji, op: 'comment', issue: '{{ $json.anahtar }}', text: 'Bakılıyor' }, { name: 'jyorum' }],
    ['limit', { max: 1 }],
    ['jira', { credential: ji, op: 'transition', issue: '{{ $json.anahtar }}', to: 'done' }, { name: 'gecis' }],
    ['jira', { credential: ji, op: 'search', jql: 'project = DESTEK AND status != Done' }, { name: 'ara' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeBiz.trello.cards.map(k => [k.name, k.idList]), [['Yazıcı çalışmıyor', 'L2'], ['Yeni bilgisayar', 'L2']]);
  assert.equal(fakeBiz.trello.cards[0].desc, 'Üçüncü kattaki yazıcı.\n\nAcil.');
  assert.deepEqual(fakeBiz.trello.comments.map(x => x.text), ['Ele alındı', 'Ele alındı']);
  assert.equal(outOf(e, 'liste').length, 2);
  const iss = fakeBiz.jira.issues[0];
  assert.deepEqual([iss.key, iss.fields.issuetype.name, iss.fields.labels], ['DESTEK-1', 'Task', ['trello', 'ofis-destek']]);
  assert.equal(iss.fields.description.content.length, 2, 'boş satırla ayrılan paragraflar ADF paragrafı olmalı');
  assert.match(outOf(e, 'kayit')[0].adres, /\/browse\/DESTEK-1$/);
  assert.deepEqual(fakeBiz.jira.moved, [['DESTEK-1', '31']], 'durum adı büyük/küçük harf duyarsız eşleşmeli');
  assert.deepEqual(outOf(e, 'ara').map(x => [x.anahtar, x.durum]), [['DESTEK-2', 'To Do']]);
  // HubSpot + Mailchimp
  const w2 = await api('POST', '/api/workflows', wf('crm2', [
    ['manual', { data: '[{"eposta":"Var@Ornek.com","ad":"Veli","tutar":"1500,5"},{"eposta":"yeni@ornek.com","ad":"Nur","tutar":""}]' }],
    ['hubspot', { credential: hs, op: 'upsert', email: '{{ $json.eposta }}', firstname: '{{ $json.ad }}', company: 'ACME', props: [{ key: 'city', value: 'İzmir' }] }, { name: 'kisi' }],
    ['hubspot', { credential: hs, op: 'deal', email: '{{ $json.eposta }}', dealname: '{{ $json.ad }} - teklif', amount: '{{ $json.tutar }}', stage: 'qualifiedtobuy' }, { name: 'firsat' }],
    ['mailchimp', { credential: mc, op: 'upsert', listId: 'L1', email: '{{ $json.eposta }}', fname: '{{ $json.ad }}', status: 'pending', tags: 'müşteri, 2026' }, { name: 'abone' }],
    ['limit', { max: 1 }],
    ['mailchimp', { credential: mc, op: 'unsubscribe', listId: 'L1', email: '{{ $json.eposta }}' }, { name: 'iptal' }],
    ['mailchimp', { credential: mc, op: 'lists' }, { name: 'kitle' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual(outOf(e2, 'kisi').map(x => [x.kisiId, x.islem]), [['101', 'guncellendi'], ['102', 'eklendi']]);
  assert.deepEqual(fakeBiz.hub.contacts[0].properties, { email: 'var@ornek.com', firstname: 'Veli', company: 'ACME', city: 'İzmir' });
  assert.deepEqual(fakeBiz.hub.deals.map(d => [d.properties.dealname, d.properties.amount, d.properties.dealstage, d.associations[0].to.id]), [['Veli - teklif', '1500.5', 'qualifiedtobuy', '101'], ['Nur - teklif', undefined, 'qualifiedtobuy', '102']]);
  const hash = require('crypto').createHash('md5').update('var@ornek.com').digest('hex');
  assert.deepEqual([fakeBiz.mc.members[hash].email, fakeBiz.mc.members[hash].merge], ['var@ornek.com', { FNAME: 'Veli' }]);
  assert.deepEqual(fakeBiz.mc.tags[0].tags, ['müşteri', '2026']);
  assert.equal(fakeBiz.mc.members[hash].status, 'unsubscribed');
  assert.deepEqual(outOf(e2, 'kitle')[0], { id: 'L1', ad: 'Bülten', aboneSayisi: 2 });
});

test('SMS: Netgsm (Türkçe karakter, numara düzeltme, hata kodu) ve Twilio (sahte API)', async () => {
  const ng = await api('POST', '/api/credentials', { type: 'netgsmApi', name: 'ng', data: { usercode: '8501112233', password: 'npass', header: 'FIRMAM' } });
  const tw = await api('POST', '/api/credentials', { type: 'twilioApi', name: 'tw', data: { sid: 'AC1', token: 'ttok', from: '+15550001111' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'netgsmApi', id: ng.id, data: { usercode: '8501112233', header: 'FIRMAM' } })).message, /FIRMAM, DIGER/);
  const bad = await api('POST', '/api/credentials/test', { type: 'netgsmApi', data: { usercode: '8501112233', password: 'x' } });
  assert.equal(bad.ok, false); assert.match(bad.message, /şifre hatalı/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'twilioApi', id: tw.id, data: { sid: 'AC1' } })).message, /Twilio hesabım/);
  const w = await api('POST', '/api/workflows', wf('sms', [
    ['manual', { data: '[{"ad":"Gül","telefon":"0 (532) 111 22 33, +90 544 000 11 22"}]' }],
    ['sms', { credential: ng.id, to: '{{ $json.telefon }}', text: 'Merhaba {{ $json.ad }}, siparişiniz yolda.', turkish: true }, { name: 'tr' }],
    ['sms', { credential: ng.id, to: '05321112233', text: 'Çiçeğiniz şu an ışıl ışıl.', turkish: false }, { name: 'ascii' }],
    ['sms', { credential: tw.id, to: '05321112233', text: 'Hello' }, { name: 'twilio' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(fakeBiz.sms[0], { via: 'netgsm', to: '5321112233,5440001122', text: 'Merhaba Gül, siparişiniz yolda.', dil: 'TR' });
  assert.deepEqual([fakeBiz.sms[1].text, fakeBiz.sms[1].dil], ['Ciceginiz su an isil isil.', undefined]);
  assert.deepEqual(fakeBiz.sms[2], { via: 'twilio', to: '+905321112233', from: '+15550001111', text: 'Hello' });
  assert.equal(outOf(e, 'tr')[0].gorevId, '1234567890');
  const ng2 = await api('POST', '/api/credentials', { type: 'netgsmApi', name: 'ng2', data: { usercode: '8501112233', password: 'npass', header: 'YANLIS' } });
  const w2 = await api('POST', '/api/workflows', wf('sms-hata', [['manual', {}], ['sms', { credential: ng2.id, to: '5321112233', text: 'x' }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'error'); assert.match(e2.error, /Netgsm: mesaj başlığı sistemde tanımlı değil/);
});

test('Araçlar: TCMB döviz, hava durumu, QR kod, doğrulama ve Claude metin araçları (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'anthropicApi', name: 'c-metin', data: { apiKey: 'sk-test' } });
  const w = await api('POST', '/api/workflows', wf('araclar', [
    ['manual', { data: '[{"tutar":"1.000,50","tarih":"2026-10-18","tckn":"10000000146","iban":"tr33 0006 1005 1978 6457 8413 26","tel":"0532 111 22 33","mesaj":"Kargom hâlâ gelmedi, çok kızgınım!"},{"tutar":"200","tarih":"","tckn":"10000000147","iban":"TR330006100519786457841327","tel":"123","mesaj":""}]' }],
    ['exchangeRate', { op: 'convert', amount: '{{ $json.tutar }}', from: 'USD', to: 'TRY', kind: 'dovizSatis', date: '{{ $json.tarih }}', decimals: 2, output: 'tl' }, { name: 'kur' }],
    ['exchangeRate', { op: 'convert', amount: '100', from: 'EUR', to: 'JPY', kind: 'dovizSatis', date: '', decimals: 0, output: 'yen' }, { name: 'capraz' }],
    ['validate', { kind: 'tckn', value: '{{ $json.tckn }}', output: 'kimlik' }, { name: 'tckn' }],
    ['validate', { kind: 'iban', value: '{{ $json.iban }}', output: 'ibanKontrol', replace: 'iban' }, { name: 'iban' }],
    ['validate', { kind: 'phone', value: '{{ $json.tel }}', output: 'tk', replace: 'tel' }, { name: 'tel' }],
    ['aiText', { credential: cred.id, model: 'claude-haiku-5-5', op: 'sentiment', text: '{{ $json.mesaj }}', output: 'duygu' }, { name: 'duygu' }],
    ['aiText', { credential: cred.id, model: 'claude-haiku-5-5', op: 'reply', tone: 'samimi ve sıcak', text: '{{ $json.mesaj }}', output: 'yanit' }, { name: 'yanit' }],
    ['aiText', { credential: cred.id, model: 'claude-haiku-5-5', op: 'keywords', text: '{{ $json.mesaj }}', output: 'etiket' }, { name: 'etiket' }],
    ['qrcode', { text: 'https://buy.stripe.com/test_1', format: 'png', level: 'M', scale: 4, file: 'qr/odeme.png', dataUrl: true }, { name: 'qr' }],
    ['weather', { place: 'İzmir', days: 3 }, { name: 'hava' }],
    ['weather', { place: '41.01, 28.97', days: 2, split: true }, { name: 'gunler' }],
    ['exchangeRate', { op: 'rates', codes: 'usd, EUR', date: '' }, { name: 'kurlar' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [3, 4, 1], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  // 18 Oct 2026 is a Sunday: the Friday (16th) bulletin is used; blank date = today's bulletin
  assert.deepEqual(outOf(e, 'kur').map(x => [x.tl, x.tlKur, x.tlTarih]), [[41020.5, 41, '2026-10-16'], [8300, 41.5, '2026-10-21']]);
  assert.equal(outOf(e, 'capraz')[0].yen, Math.round(100 * 48.2 / (27.3 / 100)), 'JPY 100 birim üzerinden yayımlanır');
  assert.deepEqual(outOf(e, 'tckn').map(x => x.kimlik.gecerli), [true]);
  assert.equal(Object.values(e.nodes).find(n => n.name === 'tckn').output[1][0].json.kimlik.neden, 'Kontrol haneleri tutmuyor');
  const iv = outOf(e, 'iban');
  assert.deepEqual([iv.length, iv[0].iban, iv[0].ibanKontrol.bankaKodu], [1, 'TR33 0006 1005 1978 6457 8413 26', '00061'], 'geçersiz IBAN ikinci çıkışa gitmeli');
  assert.equal(outOf(e, 'tel')[0].tel, '+905321112233');
  const d = outOf(e, 'duygu')[0];
  assert.deepEqual([d.duygu, d.duyguPuan, d.duyguGerekce], ['olumsuz', -0.8, 'sahte']);
  assert.deepEqual([outOf(e, 'yanit')[0].yanit, outOf(e, 'yanit')[0].yanitKonu], ['Yanıt (samimi): Kargom hâlâ gelmedi, çok kızgınım!', 'Siparişiniz hakkında']);
  assert.deepEqual(outOf(e, 'etiket')[0].etiket, ['kargo', 'gecikme']);
  const q = outOf(e, 'qr')[0].qr;
  assert.equal(q.dosya, 'qr/odeme.png'); assert.equal(q.surum, 3);
  const png = fs.readFileSync(path.join(DATA, 'dosyalar', 'qr', 'odeme.png'));
  assert.equal(png.slice(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), (29 + 8) * 4, 'genişlik = (modül + 2×4 boşluk) × ölçek');
  assert.ok(q.dataUrl.startsWith('data:image/png;base64,iVBOR'));
  const h = outOf(e, 'hava')[0];
  assert.deepEqual([h.yer, h.simdi.durum, h.gunler.length, h.gunler[1].durum], ['İzmir, Türkiye', 'Hafif yağmur', 3, 'Kapalı']);
  assert.equal(h.ozet, 'İzmir, Türkiye: Hafif yağmur, 18°C. Bugün 14–21°C, yağış ihtimali %80.');
  assert.deepEqual(outOf(e, 'gunler').map(x => x.tarih), ['2026-10-21', '2026-10-22']);
  assert.deepEqual(outOf(e, 'kurlar').map(x => [x.kod, x.dovizSatis, x.tarih]), [['USD', 41.5, '2026-10-21'], ['EUR', 48.2, '2026-10-21']]);
  const w2 = await api('POST', '/api/workflows', wf('hava-hata', [['manual', {}], ['weather', { place: 'Yokyer', days: 1 }]], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.match(e2.error, /"Yokyer" adlı yer bulunamadı/);
});

test('PDF oluştur (tablo, QR resmi, Türkçe), ZIP, takvim daveti ve e-postaya ek', async () => {
  let got = '';
  const smtp = net.createServer(s => {
    let data = false; s.write('220 test\r\n');
    s.on('data', d => {
      const t = d.toString('latin1');
      if (data) { got += t; if (got.includes('\r\n.\r\n')) { data = false; s.write('250 tamam\r\n'); } return; }
      for (const line of t.split('\r\n').filter(Boolean)) {
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH/.test(line)) s.write('235 ok\r\n');
        else if (/^DATA/.test(line)) { data = true; s.write('354 git\r\n'); } else if (/^QUIT/.test(line)) s.end('221 bye\r\n'); else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  const sc = await api('POST', '/api/credentials', { type: 'smtp', name: 'smtp-ek', data: { host: '127.0.0.1', port: String(smtp.address().port), secure: 'false', user: 'u', password: 'p' } });
  const orders = [{ no: 'T-1', musteri: 'Şule Işık', eposta: 'sule@ornek.com', tarih: '2026-11-03 14:30', urunler: [{ ad: 'Çay bardağı', adet: 6, fiyat: 45.5 }, { ad: 'Ğ-test ürünü', adet: 1, fiyat: 1200 }], toplam: 1473 }, { no: 'T-2', musteri: 'Ali', eposta: 'ali@ornek.com', tarih: '2026-11-04T09:00:00+03:00', urunler: [], toplam: 0 }];
  const w = await api('POST', '/api/workflows', wf('pdf', [
    ['manual', { data: JSON.stringify(orders) }],
    ['qrcode', { text: 'https://odeme/{{ $json.no }}', format: 'png', level: 'M', scale: 3, file: 'qr/{{ $json.no }}.png' }],
    ['pdfCreate', { mode: 'each', title: 'Teklif {{ $json.no }} - {{ $json.musteri }}', content: '# Merhaba {{ $json.musteri }}\n\nTeklifimiz aşağıdadır.\n\n- KDV dahildir\n- 15 gün geçerlidir\n---\n**Ödeme bilgisi**', tableField: '{{ $json.urunler }}', columns: 'ad:Ürün, adet:Adet, fiyat:Birim fiyat', total: 'Toplam: {{ $json.toplam }} TL', image: '{{ $json.qr.dosya }}', imageWidth: 90, footer: '8n8 A.Ş.', file: 'teklifler/{{ $json.no }}' }, { name: 'pdf' }],
    ['ics', { title: 'Teslimat: {{ $json.no }}', start: '{{ $json.tarih }}', duration: 45, location: 'Kadıköy, İstanbul', description: 'Satır 1\nSatır 2; virgül, nokta', attendees: '{{ $json.eposta }}', organizer: 'ben@ornek.com', reminder: 15 }, { name: 'ics' }],
    ['limit', { max: 1 }],
    ['email', { credential: sc.id, from: 'ben@ornek.com', to: '{{ $json.eposta }}', subject: 'Teklif', format: 'text', body: 'Ekte.', attach: '{{ $json.pdf.dosya }}, {{ $json.takvim.dosya }}' }, { name: 'mail' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  smtp.close();
  assert.equal(e.status, 'success', e.error);
  const p = outOf(e, 'pdf');
  assert.deepEqual(p.map(x => x.pdf.dosya), ['teklifler/T-1.pdf', 'teklifler/T-2.pdf']);
  const buf = fs.readFileSync(path.join(DATA, 'dosyalar', 'teklifler', 'T-1.pdf'));
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  const text = require('../lib/pdf').pdfText(buf);
  for (const s of ['Teklif T-1 - Şule Işık', 'Merhaba Şule Işık', '• KDV dahildir', 'Çay bardağı', 'Ğ-test ürünü', '1.200', 'Toplam: 1473 TL', 'Ödeme bilgisi', '8n8 A.Ş. 1 / 1']) assert.ok(text.includes(s), `PDF metninde "${s}" yok:\n${text}`);
  assert.match(buf.toString('latin1'), /\/Subtype \/Image \/Width (\d+) \/Height \1 /, 'QR resmi gömülmeli');
  const ics = fs.readFileSync(path.join(DATA, 'dosyalar', outOf(e, 'ics')[0].takvim.dosya), 'utf8');
  assert.match(ics, /DTSTART:20261103T\d{6}Z\r\nDTEND:20261103T\d{6}Z/);
  assert.match(ics, /SUMMARY:Teslimat: T-1\r\n/); assert.ok(ics.includes('DESCRIPTION:Satır 1\\nSatır 2\\; virgül\\, nokta\r\n'), ics);
  assert.match(ics, /ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:sule@ornek.com/); assert.match(ics, /TRIGGER:-PT15M/);
  assert.equal(outOf(e, 'ics')[1].takvim.baslangic, '2026-11-04T06:00:00.000Z');
  const mail = require('../lib/mime').parseMail(Buffer.from(got.replace(/\r\n\.\r\n$/, ''), 'latin1'));
  assert.deepEqual(mail.ekler.map(x => [x.ad, x.tur]), [['T-1.pdf', 'application/pdf'], [path.basename(outOf(e, 'ics')[0].takvim.dosya), 'text/calendar']]);
  assert.equal(mail.metin, 'Ekte.');
  // zip and unzip
  const w2 = await api('POST', '/api/workflows', wf('zip', [
    ['manual', { data: '[{"d":"teklifler/T-1.pdf"},{"d":"teklifler/T-2.pdf, qr/T-1.png"}]' }],
    ['compression', { op: 'zip', files: '{{ $json.d }}', output: 'arsiv/teklifler' }, { name: 'zip' }],
    ['compression', { op: 'unzip', file: '{{ $json.dosya }}', folder: 'acilan' }, { name: 'ac' }],
  ], [[0, 1], [1, 2]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual([outOf(e2, 'zip')[0].dosya, outOf(e2, 'zip')[0].adet], ['arsiv/teklifler.zip', 3]);
  assert.deepEqual(outOf(e2, 'ac').map(x => x.dosya).sort(), ['acilan/T-1.pdf', 'acilan/T-1.png', 'acilan/T-2.pdf']);
  assert.ok(fs.readFileSync(path.join(DATA, 'dosyalar', 'acilan', 'T-1.pdf')).equals(buf));
});

test('S3 (imzalı), FTP, Redis ve komut çalıştır (sahte sunucular)', async () => {
  const B0 = `http://127.0.0.1:${fakeClaude.port}`;
  const s3 = await api('POST', '/api/credentials', { type: 's3Api', name: 's3', data: { accessKey: 'AKTEST', secretKey: 'gizli-s3', region: 'auto', endpoint: `${B0}/s3`, pathStyle: 'true' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 's3Api', id: s3.id, data: { accessKey: 'AKTEST', region: 'auto', endpoint: `${B0}/s3`, pathStyle: 'true' } })).message, /kovalar: kova/);
  const bad = await api('POST', '/api/credentials/test', { type: 's3Api', data: { accessKey: 'AKTEST', secretKey: 'yanlis', region: 'auto', endpoint: `${B0}/s3` } });
  assert.equal(bad.ok, false); assert.match(bad.message, /SignatureDoesNotMatch/);
  fs.mkdirSync(path.join(DATA, 'dosyalar', 'yedek'), { recursive: true });
  const bin = Buffer.from([0, 255, 1, 2, 200, 13, 10]); fs.writeFileSync(path.join(DATA, 'dosyalar', 'yedek', 'veri.bin'), bin);
  const w = await api('POST', '/api/workflows', wf('s3', [
    ['manual', { data: '[{"dosya":"yedek/veri.bin"}]' }],
    ['s3', { credential: s3.id, op: 'upload', bucket: 'kova', key: 'yedek/2026 Ekim/{{ $json.dosya }}', source: 'file', file: '{{ $json.dosya }}' }, { name: 'yukle' }],
    ['s3', { credential: s3.id, op: 'upload', bucket: 'kova', key: 'notlar/ş+ç (1).txt', source: 'text', content: 'Merhaba S3' }, { name: 'metin' }],
    ['s3', { credential: s3.id, op: 'list', bucket: 'kova', prefix: '', max: 10 }, { name: 'liste' }],
    ['limit', { max: 1 }],
    ['s3', { credential: s3.id, op: 'download', bucket: 'kova', key: '{{ $json.anahtar }}', target: 'indirilen/n.txt' }, { name: 'indir' }],
    ['s3', { credential: s3.id, op: 'link', bucket: 'kova', key: 'notlar/ş+ç (1).txt', expires: 2 }, { name: 'link' }],
    ['s3', { credential: s3.id, op: 'delete', bucket: 'kova', key: 'notlar/ş+ç (1).txt' }, { name: 'sil' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.ok(fakeS3.objects.get('yedek/2026 Ekim/yedek/veri.bin').data.equals(bin), 'ikili dosya bozulmadan yüklenmeli');
  assert.deepEqual(outOf(e, 'liste').map(x => [x.anahtar, x.boyut]), [['notlar/ş+ç (1).txt', 10], ['yedek/2026 Ekim/yedek/veri.bin', 7]]);
  assert.equal(fs.readFileSync(path.join(DATA, 'dosyalar', 'indirilen', 'n.txt'), 'utf8'), 'Merhaba S3');
  assert.match(outOf(e, 'link')[0].baglanti, /\/s3\/kova\/notlar\/%C5%9F%2B%C3%A7%20%281%29\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=7200&X-Amz-Signature=[0-9a-f]{64}/);
  assert.ok(!fakeS3.objects.has('notlar/ş+ç (1).txt'));
  // FTP
  const fc = { host: '127.0.0.1', port: String(fakeFTP.port), user: 'ftpci', secure: 'false' };
  const ftp = await api('POST', '/api/credentials', { type: 'ftpServer', name: 'ftp', data: { ...fc, password: 'ftp-sifre' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'ftpServer', id: ftp.id, data: fc })).message, /ana klasörde 1 öğe/);
  const fb = await api('POST', '/api/credentials/test', { type: 'ftpServer', data: { ...fc, password: 'x' } });
  assert.match(fb.message, /FTP girişi başarısız: Login incorrect/);
  const w2 = await api('POST', '/api/workflows', wf('ftp', [
    ['manual', {}],
    ['ftp', { credential: ftp.id, op: 'upload', path: '/giden/2026/veri.bin', file: 'yedek/veri.bin', mkdirs: true }, { name: 'yukle' }],
    ['ftp', { credential: ftp.id, op: 'list', path: '/gelen' }, { name: 'liste' }],
    ['ftp', { credential: ftp.id, op: 'download', path: '{{ $json.yol }}', target: 'ftp/{{ $json.ad }}' }, { name: 'indir' }],
    ['ftp', { credential: ftp.id, op: 'rename', path: '/gelen/merhaba.txt', to: '/giden/merhaba.txt' }, { name: 'tasi' }],
    ['ftp', { credential: ftp.id, op: 'delete', path: '/giden/merhaba.txt' }, { name: 'sil' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.ok(fakeFTP.files.get('/giden/2026/veri.bin').equals(bin)); assert.ok(fakeFTP.dirs.has('/giden/2026'));
  assert.deepEqual(outOf(e2, 'liste').map(x => [x.ad, x.tur, x.boyut, x.yol]), [['merhaba.txt', 'dosya', 11, '/gelen/merhaba.txt']]);
  assert.equal(fs.readFileSync(path.join(DATA, 'dosyalar', 'ftp', 'merhaba.txt'), 'utf8'), 'FTP içerik');
  assert.deepEqual([...fakeFTP.files.keys()], ['/giden/2026/veri.bin']);
  // Redis
  const rc = { host: '127.0.0.1', port: String(fakeRedis.port), db: '2', secure: 'false' };
  const rd = await api('POST', '/api/credentials', { type: 'redisServer', name: 'redis', data: { ...rc, password: 'redis-sifre' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'redisServer', id: rd.id, data: rc })).message, /PONG, Redis 7.2.0/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'redisServer', data: { ...rc, password: 'x' } })).message, /Redis girişi başarısız: WRONGPASS/);
  const w3 = await api('POST', '/api/workflows', wf('redis', [
    ['manual', { data: '[{"id":7,"ad":"Ayşe"},{"id":8,"ad":"Can"}]' }],
    ['redis', { credential: rd.id, op: 'set', key: 'musteri:{{ $json.id }}', value: '{{ JSON.stringify($json) }}', ttl: 60, output: 'yazildi' }, { name: 'yaz' }],
    ['redis', { credential: rd.id, op: 'get', key: 'musteri:{{ $json.id }}', parse: true, output: 'kayit' }, { name: 'oku' }],
    ['redis', { credential: rd.id, op: 'incr', key: 'sayac', by: 5, output: 'sayac' }, { name: 'say' }],
    ['redis', { credential: rd.id, op: 'push', key: 'kuyruk', value: '{{ $json.ad }}', end: 'right' }, { name: 'ekle' }],
    ['redis', { credential: rd.id, op: 'command', command: 'HSET kisi:{{ $json.id }} ad "{{ $json.ad }} Yılmaz" yas 30', parse: true }],
    ['redis', { credential: rd.id, op: 'command', command: 'HGETALL kisi:{{ $json.id }}', parse: true, output: 'kisi' }, { name: 'hget' }],
    ['limit', { max: 1 }],
    ['redis', { credential: rd.id, op: 'pop', key: 'kuyruk', end: 'left', parse: true, output: 'ilk' }, { name: 'al' }],
    ['redis', { credential: rd.id, op: 'publish', channel: 'olaylar', value: 'bitti' }],
    ['redis', { credential: rd.id, op: 'command', command: 'FLUSHALL' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10]]));
  const e3 = await waitExec((await api('POST', `/api/workflows/${w3.id}/run`, {})).executionId);
  assert.equal(e3.status, 'error'); assert.match(e3.error, /FLUSHALL komutu bu node'dan çalıştırılamaz/);
  assert.deepEqual(outOf(e3, 'yaz').map(x => x.yazildi), ['OK', 'OK']); assert.equal(fakeRedis.data.get('ttl:musteri:7'), '60');
  assert.deepEqual(outOf(e3, 'oku')[1].kayit, { id: 8, ad: 'Can' });
  assert.deepEqual(outOf(e3, 'say').map(x => x.sayac), [5, 10]);
  assert.deepEqual(outOf(e3, 'hget')[0].kisi, { ad: 'Ayşe Yılmaz', yas: 30 });
  assert.equal(outOf(e3, 'al')[0].ilk, 'Ayşe'); assert.deepEqual(fakeRedis.published, [['olaylar', 'bitti']]);
  // command (enabled in tests with N8N8_ALLOW_COMMANDS=1)
  const w4 = await api('POST', '/api/workflows', wf('komut', [
    ['manual', { data: '[{"ad":"Deniz"}]' }],
    ['command', { command: `"${process.execPath}" -e "console.log('Merhaba ' + process.argv[1] + ' ' + process.cwd().endsWith('dosyalar'))" "{{ $json.ad }}"`, timeout: 20 }, { name: 'calis' }],
    ['command', { command: `"${process.execPath}" -e "console.error('olmadı'); process.exit(3)"`, failOnError: false }, { name: 'kod' }],
    ['command', { command: `"${process.execPath}" -e "process.exit(2)"` }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e4 = await waitExec((await api('POST', `/api/workflows/${w4.id}/run`, {})).executionId);
  assert.deepEqual([outOf(e4, 'calis')[0].cikti, outOf(e4, 'calis')[0].kod], ['Merhaba Deniz true', 0]);
  assert.deepEqual([outOf(e4, 'kod')[0].kod, outOf(e4, 'kod')[0].hata], [3, 'olmadı']);
  assert.equal(e4.status, 'error'); assert.match(e4.error, /Komut 2 koduyla bitti/);
});

test('Web sayfası oku, GraphQL, anlık bildirim, iyzico ve iş günü hesabı (sahte API)', async () => {
  const B0 = `http://127.0.0.1:${fakeClaude.port}`;
  const gq = await api('POST', '/api/credentials', { type: 'httpBearer', name: 'gql', data: { token: 'gql-tok' } });
  const po = await api('POST', '/api/credentials', { type: 'pushoverApi', name: 'po', data: { token: 'po-tok', user: 'u1' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'pushoverApi', id: po.id, data: { user: 'u1' } })).message, /telefon/);
  const nt = await api('POST', '/api/credentials', { type: 'ntfyApi', name: 'nt', data: { server: `${B0}/ntfy`, token: 'tk_ntfy' } });
  const iy = await api('POST', '/api/credentials', { type: 'iyzicoApi', name: 'iy', data: { apiKey: 'iyz-api', secretKey: 'iyz-gizli', sandbox: 'true' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'iyzicoApi', id: iy.id, data: { apiKey: 'iyz-api', sandbox: 'true' } })).message, /deneme ortamı/);
  const ib = await api('POST', '/api/credentials/test', { type: 'iyzicoApi', data: { apiKey: 'iyz-api', secretKey: 'yanlis', sandbox: 'true' } });
  assert.equal(ib.ok, false); assert.match(ib.message, /api bilgileri bulunamadı/);
  const w = await api('POST', '/api/workflows', wf('web', [
    ['manual', { data: `[{"link":"${B0}/urun.html","id":"42","no":"S-9","tutar":"1.250,50","musteri":"Ayşe"}]` }],
    ['webPage', { url: '{{ $json.link }}', links: true, contains: 'stokta VAR', maxChars: 0 }, { name: 'sayfa' }],
    ['graphql', { url: `${B0}/graphql`, credential: gq.id, query: 'query ($id: ID!) { user(id: $id) { id name } }', variables: '{ "id": "{{ $json.id }}" }' }, { name: 'gql' }],
    ['graphql', { url: `${B0}/graphql`, credential: gq.id, query: '{ user { repos { nodes { ad } } } }', variables: '{ "id": "1" }', split: 'user.repos.nodes' }, { name: 'gql2' }],
    ['limit', { max: 1 }],
    ['push', { service: 'pushover', credential: po.id, title: 'Sipariş', message: 'Yeni sipariş', priority: '4', url: 'https://x.com' }, { name: 'po' }],
    ['push', { service: 'ntfy', ntfyCred: nt.id, topic: 'magaza-x7k2', title: 'Sipariş', message: 'Kupa satıldı', priority: '5', tags: 'tada, package' }, { name: 'nt' }],
    ['set', { fields: [{ key: 'no', value: 'S-9' }, { key: 'tutar', value: '1.250,50' }, { key: 'paymentId', value: '1234' }], keep: false }],
    ['iyzico', { credential: iy.id, op: 'link', name: 'Sipariş {{ $json.no }}', description: 'Kupa', price: '{{ $json.tutar }}', soldLimit: 1, installment: true }, { name: 'iyz' }],
    ['iyzico', { credential: iy.id, op: 'payment', paymentId: '{{ $json.paymentId }}' }, { name: 'odeme' }],
    ['iyzico', { credential: iy.id, op: 'links' }, { name: 'linkler' }],
  ], [[0, 1], [1, 2], [0, 3], [2, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const s = outOf(e, 'sayfa')[0];
  assert.deepEqual([s.baslik, s.aciklama, s.resim, s.iceriyor], ['Kırmızı Kupa & Tabak', 'El yapımı seramik kupa', 'https://x.com/k.jpg', true]);
  assert.match(s.metin, /^Kırmızı Kupa\nFiyat: 225 TL\nDurum: Stokta var – hızlı kargo/); assert.ok(!s.metin.includes('Menü') && !s.metin.includes('©'), 'menü ve alt bilgi atılmalı');
  assert.deepEqual(s.baglantilar.map(x => x.adres), [`${B0}/`, `${B0}/sepet?u=1`, 'https://baska.com/x']);
  assert.deepEqual([outOf(e, 'gql')[0].user.id, outOf(e, 'gql')[0].user.name], ['42', 'Kişi 42']);
  assert.deepEqual(outOf(e, 'gql2').map(x => x.ad), ['a', 'b']);
  assert.deepEqual(fakeMisc.pushes.map(x => [x.via, x.title, String(x.priority)]), [['pushover', 'Sipariş', '1'], ['ntfy', 'Sipariş', '5']]);
  assert.deepEqual(fakeMisc.pushes[1].tags, ['tada', 'package']);
  const body = fakeMisc.iyzi[0];
  assert.deepEqual([body.price, body.currencyCode, body.name, body.soldLimit, body.installmentRequested, body.locale], ['1250.50', 'TRY', 'Sipariş S-9', 1, true, 'tr']);
  assert.equal(outOf(e, 'iyz')[0].odemeBaglantisi, 'https://sandbox.iyzi.link/AAA1');
  assert.deepEqual(outOf(e, 'odeme')[0].odeme, { durum: 'SUCCESS', tutar: 1250.5, taksit: 1, kart: '**** 0008', kartAilesi: 'Bonus' });
  assert.deepEqual(outOf(e, 'linkler').map(x => [x.ad, x.tutar]), [['Sipariş S-9', 1250.5]]);
  const g = await api('POST', '/api/workflows', wf('gql-hata', [['manual', {}], ['graphql', { url: `${B0}/graphql`, credential: gq.id, query: 'syntaxError', variables: '' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${g.id}/run`, {})).executionId)).error, /GraphQL: Syntax Error/);
  // business days: Ramazan Bayramı 2026 is 20-22 March (Fri-Sun), arife 19 March; Kurban 27-30 May
  const w2 = await api('POST', '/api/workflows', wf('isgunu', [
    ['manual', { data: '[{"t":"2026-03-18","b":"2026-03-25"},{"t":"26.05.2026","b":"2026-06-01"},{"t":"2026-10-28","b":"2026-10-30"}]' }],
    ['businessDay', { op: 'check', date: '{{ $json.t }}', output: 'ig' }, { name: 'mi' }],
    ['businessDay', { op: 'add', date: '{{ $json.t }}', days: 2, output: 'sonra' }, { name: 'ekle' }],
    ['businessDay', { op: 'add', date: '{{ $json.t }}', days: 2, halfDays: true, extra: '2026-03-23', output: 'sonra2' }, { name: 'ekle2' }],
    ['businessDay', { op: 'between', date: '{{ $json.t }}', date2: '{{ $json.b }}', output: 'ara' }, { name: 'ara' }],
    ['businessDay', { op: 'list', year: '2026' }, { name: 'liste' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual(outOf(e2, 'mi').map(x => x.ig), [true, true, true], 'arife yarım gün: iş günü sayılır');
  assert.deepEqual(outOf(e2, 'mi')[1].igTatil, ['Kurban Bayramı arifesi']);
  assert.deepEqual(outOf(e2, 'ekle').map(x => x.sonra), ['2026-03-23', '2026-06-02', '2026-11-02']);
  assert.deepEqual(outOf(e2, 'ekle2').map(x => x.sonra2), ['2026-03-25', '2026-06-02', '2026-11-02']);
  assert.deepEqual(outOf(e2, 'ara').map(x => x.ara), [4, 1, 1]);
  const l = outOf(e2, 'liste');
  assert.deepEqual(l.filter(x => x.tur === 'tam').map(x => x.tarih), ['2026-01-01', '2026-03-20', '2026-03-21', '2026-03-22', '2026-04-23', '2026-05-01', '2026-05-19', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30', '2026-07-15', '2026-08-30', '2026-10-29']);
  assert.equal(l.find(x => x.tarih === '2026-03-20').gun, 'Cuma');
});

test('MCP aracı: Claude istemcisi akışı araç olarak listeler ve çağırır', async () => {
  const tok = await api('POST', '/api/credentials', { type: 'httpBearer', name: 'mcp-token', data: { token: 'mcp-gizli' } });
  const w = await api('POST', '/api/workflows', wf('mcp', [
    ['mcpTrigger', { path: 'araclar', tool: 'musteri_bul', description: 'Müşteri bulur', inputs: [{ key: 'eposta', value: 'e-posta' }, { key: 'adet:tamsayı', value: '' }], optional: 'adet', result: 'first', auth: 'cred', credential: tok.id }],
    ['set', { fields: [{ key: 'bulunan', value: '{{ $json.eposta }}' }, { key: 'kac', value: '{{ ($json.adet || 0) + 1 }}' }], keep: false }],
  ], [[0, 1]]));
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  const rpc = async (body, auth = 'Bearer mcp-gizli', extra = {}) => {
    const r = await fetch(`${B}/mcp/araclar`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}), ...extra }, body: JSON.stringify(body) });
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer mcp-gizli', { Origin: 'https://kotu.site' })).status, 403);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18'); assert.ok(init.body.result.capabilities.tools);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map(t => [t.name, t.inputSchema.required]), [['musteri_bul', ['eposta']]]);
  assert.equal(list.body.result.tools[0].inputSchema.properties.adet.type, 'integer');
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'musteri_bul', arguments: { eposta: 'a@x.com', adet: 2 } } });
  assert.deepEqual(JSON.parse(call.body.result.content[0].text), { bulunan: 'a@x.com', kac: 3 });
  const missing = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'musteri_bul', arguments: {} } });
  assert.equal(missing.body.result.isError, true);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 5, method: 'yok' })).body.error.code, -32601);
  const { items } = await api('GET', `/api/executions?workflowId=${w.id}`);
  assert.ok(items.some(x => x.mode === 'mcp'));
  const dup = await api('POST', '/api/workflows', wf('mcp2', [['mcpTrigger', { path: 'araclar', tool: 'musteri_bul' }]], []));
  await assert.rejects(api('PUT', `/api/workflows/${dup.id}`, { active: true }), /zaten var/);
  await api('PUT', `/api/workflows/${w.id}`, { active: false });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' })).status, 404);
});

test('Aynı anda çalışma sınırı ve geçmiş çalıştırmayı editörde hata ayıklama', async () => {
  const w = await api('POST', '/api/workflows', wf('sira', [['webhook', { path: 'sira', method: 'POST', respond: 'immediately' }], ['wait', { amount: 400, unit: 'ms' }]], [[0, 1]], { settings: { timeout: 30, maxConcurrent: 1 } }));
  await api('PUT', `/api/workflows/${w.id}`, { active: true });
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(i => fetch(`${B}/webhook/sira`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i }) })));
  let items;
  for (let k = 0; k < 50; k++) { ({ items } = await api('GET', `/api/executions?workflowId=${w.id}`)); if (items.length === 3 && items.every(x => x.status !== 'running')) break; await sleep(100); }
  assert.ok(Date.now() - t0 >= 1150, `sırayla çalışmalı (${Date.now() - t0} ms)`);
  const runs = await Promise.all(items.map(x => api('GET', `/api/executions/${x.id}`)));
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (let k = 1; k < runs.length; k++) assert.ok(runs[k].startedAt >= runs[k - 1].stoppedAt, 'çalıştırmalar üst üste binmemeli');
  await api('PUT', `/api/workflows/${w.id}`, { active: false });
  const d = await api('POST', `/api/executions/${runs[2].id}/debug`, {});
  const pinned = (await api('GET', `/api/workflows/${w.id}`)).nodes.find(n => n.type === 'webhook').pinData;
  assert.equal(d.items, 1); assert.deepEqual(pinned[0].body, runs[2].triggerData.request.body);
});

test('Özet: çalıştırma sayıları, başarı oranı ve sık hatalar', async () => {
  const st = await api('GET', '/api/stats?days=7');
  assert.ok(st.toplam > 10 && st.basarili > 0 && st.hatali > 0, JSON.stringify(st).slice(0, 200));
  assert.equal(st.gunluk.length, 7);
  assert.equal(st.gunluk.reduce((a, d) => a + d.basarili + d.hatali + d.diger, 0), st.toplam);
  assert.equal(st.akislar.reduce((a, w) => a + w.toplam, 0), st.toplam);
  assert.ok(st.basariOrani > 0 && st.basariOrani < 100);
  assert.ok(st.hatalar[0].sayi >= 1 && st.hatalar[0].sonId);
});

test('Sunucu bozuk isteklere dayanır: hatalı adres, yabancı Host, bozuk akış', async () => {
  let r = await fetch(`${B}/%E0%A4%A`); assert.equal(r.status, 400);
  r = await new Promise(res => require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/credentials', headers: { Host: 'saldirgan.example' } }, res));
  assert.equal(r.statusCode, 403);
  await assert.rejects(api('POST', '/api/workflows', { name: 'x', nodes: [null] }), /400/);
  await assert.rejects(api('POST', '/api/workflows', { name: 'x', nodes: [{ id: '"><img src=x onerror=alert(1)>', type: 'noop' }] }), /400/);
  await assert.rejects(api('POST', '/api/workflows', { name: 'x', nodes: [{ id: 'a1', type: 'yok-boyle' }] }), /Bilinmeyen node/);
  await assert.rejects(api('PUT', '/api/credentials/olmayan', { name: 'x', data: {} }), /404/);
  const t = await api('POST', '/api/tables', { name: 'Korunan' });
  await api('POST', `/api/tables/${t.id}/rows`, { rows: [{ a: 1 }, { a: 2 }] });
  const w = await api('POST', '/api/workflows', wf('boş koşul', [['manual', { data: '[{}]' }], ['table', { table: t.id, op: 'delete', where: [{ key: 'a', value: '{{ $json.yok }}' }] }]], [[0, 1]]));
  await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal((await api('GET', `/api/tables/${t.id}`)).rowCount, 2, 'boş koşul hiçbir satırı silmemeli');
  assert.equal((await api('GET', '/api/workflows')).length > 0, true);
});

test('JSON olmayan API isteği reddedilir', async () => {
  const r = await fetch(`${B}/api/workflows`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});


/* fake Anthropic API (the SDK honours ANTHROPIC_BASE_URL) that also serves a test RSS feed */

/* fake IMAP server (plain TCP): enough of IMAP4rev1 for the e-mail trigger */
const fakeIMAP = { port: 0, uidNext: 3, msgs: [{ uid: 1, flags: [], raw: 'Subject: eski\r\n\r\neski' }, { uid: 2, flags: ['\\Seen'], raw: 'Subject: eski2\r\n\r\neski2' }], logins: 0 };
const imapServer = net.createServer(sock => {
  sock.write('* OK fake IMAP ready\r\n');
  let buf = '';
  sock.on('data', d => {
    buf += d.toString('latin1'); let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const [tag, ...rest] = line.split(' '); const cmd = rest.join(' '); const up = cmd.toUpperCase();
      const ok = (t = 'done') => sock.write(`${tag} OK ${t}\r\n`);
      if (up.startsWith('CAPABILITY')) { sock.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n'); ok(); }
      else if (up.startsWith('LOGIN')) { if (cmd.includes('"kutu@ornek.com" "dogru-sifre"')) { fakeIMAP.logins++; ok(); } else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); }
      else if (up.startsWith('SELECT')) { sock.write(`* ${fakeIMAP.msgs.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${fakeIMAP.uidNext}] ok\r\n`); ok('[READ-WRITE] SELECT completed'); }
      else if (up.startsWith('UID SEARCH')) {
        const m = cmd.match(/UID (\d+):\*/); let hits = fakeIMAP.msgs.map(x => x.uid);
        if (m) { hits = hits.filter(u => u >= Number(m[1])); if (!hits.length) hits = [fakeIMAP.msgs.at(-1).uid]; } // like real servers: n:* always matches the last message
        sock.write(`* SEARCH ${hits.join(' ')}\r\n`); ok();
      } else if (up.startsWith('UID FETCH')) {
        const want = cmd.split(' ')[2].split(',').map(Number);
        fakeIMAP.msgs.filter(x => want.includes(x.uid)).forEach((x, k) => { const raw = Buffer.from(x.raw, 'latin1'); sock.write(`* ${k + 1} FETCH (UID ${x.uid} FLAGS (${x.flags.join(' ')}) BODY[] {${raw.length}}\r\n`); sock.write(raw); sock.write(')\r\n'); });
        ok();
      } else if (up.startsWith('UID STORE')) { const want = cmd.split(' ')[2].split(',').map(Number); for (const x of fakeIMAP.msgs) if (want.includes(x.uid)) x.flags.push('\\Seen'); ok(); }
      else if (up.startsWith('LOGOUT')) { sock.write('* BYE\r\n'); ok(); sock.end(); }
      else sock.write(`${tag} BAD unknown\r\n`);
    }
  });
  sock.on('error', () => {});
});
const fakeWA = { sent: [] };
function fakeWhatsapp(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer wa-token') return json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/wa/1234') return json({ display_phone_number: '+90 212 000 00 00', verified_name: 'Mağaza', id: '1234' });
  if (req.method === 'POST' && u.pathname === '/wa/1234/messages') {
    const b = JSON.parse(raw); fakeWA.sent.push(b);
    if (b.type === 'text' && b.to === '905550000000') return json({ error: { message: 'Re-engagement message', code: 131047 } }, 400);
    return json({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.${fakeWA.sent.length}` }] });
  }
  return json({ error: { message: 'Unknown path' } }, 404);
}
const fakeClaude = { calls: [], port: 0 };
const fakeGoogle = { auth: [], tabs: {} };
const fakeTelegram = { webhook: true, served: false };
function fakeGoogleApi(req, res, raw) {
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/token') return json({ access_token: 'sahte-token', expires_in: 3600 });
  fakeGoogle.auth.push(req.headers.authorization);
  const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/v4\/spreadsheets\/ABC123\/values(?:\/([^:]*))?(?::(\w+))?$/);
  const body = raw ? JSON.parse(raw) : {};
  const rows = (fakeGoogle.tabs.Sayfa1 ||= []);
  const rowOf = range => Number(decodeURIComponent(range).match(/!A(\d+)/)[1]) - 1;
  if (!m) { res.writeHead(404); return res.end('{}'); }
  if (!m[1] && m[2] === 'batchUpdate') { for (const d of body.data) rows[rowOf(d.range)] = d.values[0]; return json({}); }
  if (m[2] === 'append') { const start = rows.length + 1; rows.push(...body.values); return json({ updates: { updatedRange: `'Sayfa1'!A${start}:C${rows.length}` } }); }
  if (m[2] === 'clear') { rows.length = Math.min(rows.length, 1); return json({}); }
  if (req.method === 'PUT') { rows[rowOf(m[1])] = body.values[0]; return json({}); }
  return json({ values: rows.map(r => r.map(v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v))) });
}
const fakeG = { tokens: [], auth: [], mails: [], files: [], events: [], challenge: null };
function fakeGoogleOAuth(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/oauth-token') {
    const b = Object.fromEntries(new URLSearchParams(raw)); fakeG.tokens.push(b.grant_type);
    if (b.client_id !== 'cid' || b.client_secret !== 'sec') return json({ error: 'invalid_client' }, 401);
    if (b.grant_type === 'authorization_code') {
      const ok = b.code === 'kod1' && require('crypto').createHash('sha256').update(b.code_verifier || '').digest('base64url') === fakeG.challenge;
      if (!ok) return json({ error: 'invalid_grant' }, 400);
      const idt = ['e30', Buffer.from(JSON.stringify({ email: 'ayse@gmail.com' })).toString('base64url'), 'x'].join('.');
      return json({ access_token: 'g-at1', refresh_token: 'g-rt', expires_in: 30, id_token: idt, scope: 'gmail' }); // expires at once: forces a refresh
    }
    if (b.grant_type === 'refresh_token' && b.refresh_token === 'g-rt') return json({ access_token: 'g-at2', expires_in: 3600 });
    return json({ error: 'bad' }, 400);
  }
  fakeG.auth.push(req.headers.authorization);
  const p = u.pathname;
  if (p === '/gmail/v1/users/me/messages/send') {
    const mime = Buffer.from(JSON.parse(raw).raw, 'base64url').toString('utf8'); const [head, body] = mime.split('\r\n\r\n');
    const hdr = name => (head.match(new RegExp(`^${name}: (.*)$`, 'mi')) || [])[1] || '';
    const text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    const m = { id: `m${fakeG.mails.length + 1}`, threadId: 't1', snippet: text.slice(0, 40), internalDate: String(Date.now()), labelIds: ['INBOX', 'UNREAD'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'ayse@gmail.com' }, { name: 'To', value: hdr('To') }, { name: 'Subject', value: hdr('Subject') }], body: { data: Buffer.from(text).toString('base64url') } } };
    fakeG.mails.push(m); return json({ id: m.id, threadId: m.threadId });
  }
  if (p === '/gmail/v1/users/me/messages') return json({ messages: fakeG.mails.map(m => ({ id: m.id })) });
  let mm;
  if ((mm = p.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)\/modify$/))) { const m = fakeG.mails.find(x => x.id === mm[1]); m.labelIds = m.labelIds.filter(l => !(JSON.parse(raw).removeLabelIds || []).includes(l)); return json({}); }
  if ((mm = p.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/))) return json(fakeG.mails.find(x => x.id === mm[1]));
  if (p === '/upload/drive/v3/files') {
    const meta = JSON.parse(raw.split('\r\n\r\n')[1].split('\r\n--')[0]); const content = raw.split('\r\n\r\n')[2].split('\r\n--')[0];
    const f = { id: `f${fakeG.files.length + 1}`, name: meta.name, mimeType: 'text/plain', size: String(Buffer.byteLength(content)), content, modifiedTime: new Date().toISOString() };
    fakeG.files.push(f); return json(f);
  }
  if (p === '/drive/v3/files') return json({ files: fakeG.files.filter(f => !u.searchParams.get('q').includes('name contains') || u.searchParams.get('q').includes(f.name.slice(0, 5))) });
  if ((mm = p.match(/^\/drive\/v3\/files\/(\w+)$/))) { const f = fakeG.files.find(x => x.id === mm[1]); if (u.searchParams.get('alt') === 'media') { res.writeHead(200); return res.end(f.content); } return json(f); }
  if (p === '/calendar/v3/calendars/primary/events') {
    if (req.method === 'POST') { const e = { ...JSON.parse(raw), id: `e${fakeG.events.length + 1}`, htmlLink: 'https://calendar/x' }; fakeG.events.push(e); return json(e); }
    return json({ items: fakeG.events });
  }
  return json({ error: { message: 'yok ' + p } }, 404);
}
const fakeN = { auth: [], pages: [] };
function fakeNotion(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  fakeN.auth.push(req.headers.authorization);
  if (req.headers['notion-version'] !== '2022-06-28') return json({ message: 'version' }, 400);
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/notion/, ''); const body = raw ? JSON.parse(raw) : {};
  const DB = '0123456789abcdef0123456789abcdef';
  const schema = { Ad: { id: 'a', name: 'Ad', type: 'title' }, Puan: { id: 'b', name: 'Puan', type: 'number' }, Etiketler: { id: 'c', name: 'Etiketler', type: 'multi_select' }, Bitti: { id: 'd', name: 'Bitti', type: 'checkbox' }, Durum: { id: 'e', name: 'Durum', type: 'status' } };
  const out = pg => {
    const props = {};
    for (const [k, d] of Object.entries(schema)) {
      const v = pg.properties[k];
      props[k] = { type: d.type, [d.type]: d.type === 'title' ? (v?.title || []).map(t => ({ plain_text: t.text.content })) : d.type === 'status' ? v?.status || null : d.type === 'multi_select' ? v?.multi_select || [] : v?.[d.type] ?? null };
    }
    return { object: 'page', id: pg.id, url: `https://notion.so/${pg.id}`, created_time: '2026-01-01T00:00:00.000Z', last_edited_time: '2026-01-01T00:00:00.000Z', parent: pg.parent, properties: props };
  };
  if (p === '/users/me') return json({ object: 'user', name: '8n8 bot', type: 'bot' });
  if (p === `/databases/${DB}`) return json({ id: DB, properties: schema });
  if (p === '/pages' && req.method === 'POST') { if (body.parent.database_id !== DB) return json({ message: 'no db' }, 404); const pg = { ...body, id: `aaaaaaaa-bbbb-cccc-dddd-00000000000${fakeN.pages.length + 1}` }; fakeN.pages.push(pg); return json(out(pg)); }
  let m;
  if ((m = p.match(/^\/pages\/(\w+)$/))) {
    const pg = fakeN.pages.find(x => x.id.replace(/-/g, '') === m[1]); if (!pg) return json({ message: 'yok' }, 404);
    if (req.method === 'PATCH') Object.assign(pg.properties, body.properties || {});
    return json(out({ ...pg, parent: { database_id: '01234567-89ab-cdef-0123-456789abcdef' } }));
  }
  if ((m = p.match(/^\/blocks\/(\w+)\/children$/))) { fakeN.pages.find(x => x.id.replace(/-/g, '') === m[1]).children.push(...body.children); return json({ results: body.children }); }
  if (p === `/databases/${DB}/query`) {
    const st = body.filter?.status?.equals;
    return json({ results: fakeN.pages.filter(pg => !st || pg.properties.Durum?.status?.name === st).map(out), has_more: false, next_cursor: null });
  }
  return json({ message: 'yok ' + p }, 404);
}
const fakeS = { posts: [], reactions: [], history: [{ ts: '1.0001', text: 'eski', user: 'U1' }] };
function fakeSlack(req, res, raw) {
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer xoxb-1') return json({ ok: false, error: 'invalid_auth' });
  const u = new URL(req.url, 'http://x'); const method = u.pathname.replace('/slack/', ''); const body = raw ? JSON.parse(raw) : Object.fromEntries(u.searchParams);
  if (method === 'auth.test') return json({ ok: true, team: 'Ekip', user: 'robot' });
  if (method === 'conversations.list') return json({ ok: true, channels: [{ id: 'C111111', name: 'genel', is_member: true }] });
  if (method === 'chat.postMessage') { if (body.channel !== 'C111111') return json({ ok: false, error: 'channel_not_found' }); fakeS.posts.push(body); return json({ ok: true, ts: `1.000${fakeS.posts.length}`, channel: body.channel }); }
  if (method === 'reactions.add') { fakeS.reactions.push(body.name); return json({ ok: true }); }
  if (method === 'conversations.history') return json({ ok: true, messages: fakeS.history.filter(m => !body.oldest || Number(m.ts) > Number(body.oldest)).reverse() });
  return json({ ok: false, error: 'unknown_method' });
}
const fakeM = { auth: [], sent: [], mails: [], replies: [] };
function fakeMicrosoft(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); if (st === 202) return res.end(); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ms-token') {
    const b = Object.fromEntries(new URLSearchParams(raw));
    if (b.client_id !== 'mcid' || b.code !== 'mkod') return json({ error: 'invalid_grant' }, 400);
    const idt = ['e30', Buffer.from(JSON.stringify({ preferred_username: 'can@contoso.com', name: 'Can' })).toString('base64url'), 'x'].join('.');
    return json({ access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600, id_token: idt });
  }
  fakeM.auth.push(req.headers.authorization);
  const p = u.pathname.replace(/^\/graph/, ''); const body = raw ? JSON.parse(raw) : {};
  if (p === '/me') return json({ ad: 'Can', mail: 'can@contoso.com' });
  if (p === '/me/sendMail') {
    fakeM.sent.push(body); const msg = body.message;
    fakeM.mails.push({ id: `AAM${fakeM.mails.length + 1}`, conversationId: 'c1', subject: msg.subject, from: { emailAddress: { name: 'Can', address: 'can@contoso.com' } }, toRecipients: msg.toRecipients, receivedDateTime: new Date().toISOString(), bodyPreview: msg.body.content, body: { contentType: 'html', content: `<p>${msg.body.content.replace(' ', '<br>')}</p>` }, isRead: false, hasAttachments: false, webLink: 'https://outlook/x' });
    return json(null, 202);
  }
  if (p === '/me/mailFolders/inbox/messages') {
    if (u.searchParams.get('$filter') !== 'isRead eq false' || u.searchParams.get('$top') !== '5') return json({ error: { message: 'beklenmeyen sorgu' } }, 400);
    return json({ value: fakeM.mails.filter(m => !m.isRead) });
  }
  let m;
  if ((m = p.match(/^\/me\/messages\/(\w+)\/reply$/))) { fakeM.replies.push(body.comment); return json(null, 202); }
  if ((m = p.match(/^\/me\/messages\/(\w+)$/)) && req.method === 'PATCH') { const x = fakeM.mails.find(y => y.id === m[1]); Object.assign(x, body); return json(x); }
  return json({ error: { message: 'yok ' + p } }, 404);
}
const fakeGH = { auth: [], issues: [{ number: 7, id: 7, title: 'PR', state: 'open', user: { login: 'x' }, labels: [], pull_request: {} }], comments: [], files: {} };
function fakeGithub(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  fakeGH.auth.push(req.headers.authorization);
  if (req.headers['user-agent'] !== '8n8') return json({ message: 'UA gerekli' }, 403);
  const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/gh/, ''); const body = raw ? JSON.parse(raw) : {};
  if (p === '/user') return json({ login: 'ayse' });
  if (!p.startsWith('/repos/ornek/depo/')) return json({ message: 'Not Found' }, 404);
  const r = p.slice('/repos/ornek/depo'.length); let m;
  const issue = x => ({ ...x, labels: (x.labels || []).map(name => (typeof name === 'string' ? { name } : name)), html_url: `https://github.com/ornek/depo/issues/${x.number}` });
  if (r === '/issues' && req.method === 'POST') { const x = { number: 1, id: 1, state: 'open', user: { login: 'ayse' }, ...body }; fakeGH.issues.push(x); return json(issue(x), 201); }
  if (r === '/issues') return json(fakeGH.issues.slice().reverse().map(issue));
  if ((m = r.match(/^\/issues\/(\d+)\/comments$/))) { fakeGH.comments.push([Number(m[1]), body.body]); return json({ id: 5, html_url: 'c' }, 201); }
  if ((m = r.match(/^\/issues\/(\d+)$/))) { const x = fakeGH.issues.find(i => i.number === Number(m[1])); Object.assign(x, body); return json(issue(x)); }
  if ((m = r.match(/^\/contents\/(.+)$/))) {
    const path = decodeURIComponent(m[1]); const f = fakeGH.files[path];
    if (req.method === 'PUT') {
      if (f && body.sha !== f.sha) return json({ message: 'sha eşleşmiyor' }, 409);
      if (!f && body.sha) return json({ message: 'sha olmamalı' }, 422);
      fakeGH.files[path] = { content: body.content, sha: `s${Date.now()}` };
      return json({ content: { path, sha: fakeGH.files[path].sha, html_url: 'f' }, commit: { sha: 'c1' } }, f ? 200 : 201);
    }
    return f ? json({ type: 'file', path, content: f.content, sha: f.sha, size: 1 }) : json({ message: 'Not Found' }, 404);
  }
  return json({ message: 'Not Found' }, 404);
}
const fakeAT = { records: [], batches: [], seq: 0 };
function fakeAirtable(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer patX') return json({ error: { type: 'AUTHENTICATION_REQUIRED' } }, 401);
  const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname.replace(/^\/at/, '')); const body = raw ? JSON.parse(raw) : {};
  if (p === '/meta/whoami') return json({ id: 'usr1', email: 'ayse@ornek.com' });
  const m = p.match(/^\/appABCDEFGHIJKLMN\/(tblABCDEFGHIJKLMN|Kişiler)(?:\/(rec\w+))?$/); if (!m) return json({ error: { type: 'NOT_FOUND' } }, 404);
  const rec = r => ({ id: r.id, createdTime: '2026-01-01T00:00:00.000Z', fields: r.fields });
  if (m[2]) { const i = fakeAT.records.findIndex(r => r.id === m[2]); if (i < 0) return json({ error: { type: 'NOT_FOUND' } }, 404); if (req.method === 'DELETE') { fakeAT.records.splice(i, 1); return json({ id: m[2], deleted: true }); } return json(rec(fakeAT.records[i])); }
  if (req.method === 'POST' || req.method === 'PATCH') {
    if (body.records.length > 10) return json({ error: { type: 'INVALID_RECORDS', message: 'en fazla 10' } }, 422);
    fakeAT.batches.push(body.records.length); const created = []; const out = [];
    for (const r of body.records) {
      let x = r.id ? fakeAT.records.find(y => y.id === r.id) : body.performUpsert ? fakeAT.records.find(y => body.performUpsert.fieldsToMergeOn.every(k => y.fields[k] === r.fields[k])) : null;
      if (x) Object.assign(x.fields, r.fields); else { x = { id: `rec${String(++fakeAT.seq).padStart(14, '0')}`, fields: { ...r.fields } }; fakeAT.records.push(x); created.push(x.id); }
      out.push(rec(x));
    }
    return json({ records: out, ...(body.performUpsert ? { createdRecords: created, updatedRecords: out.map(r => r.id).filter(id => !created.includes(id)) } : {}) });
  }
  const f = u.searchParams.get('filterByFormula'); const fm = f && f.match(/^\{(.+)\} = "(.*)"$/);
  const all = fakeAT.records.filter(r => !fm || r.fields[fm[1]] === fm[2]);
  const size = Number(u.searchParams.get('pageSize')) || 100; const off = Number(u.searchParams.get('offset') || 0);
  return json({ records: all.slice(off, off + size).map(rec), ...(off + size < all.length ? { offset: String(off + size) } : {}) });
}
const fakeDC = { sent: [], reactions: [], history: [{ id: '800000000000000001', channel_id: '111111111111111111', content: 'eski', author: { id: '4', username: 'ali' } }] };
function fakeDiscord(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bot dtok') return json({ message: '401: Unauthorized', code: 0 }, 401);
  const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname.replace(/^\/dc/, '')); const body = raw ? JSON.parse(raw) : {};
  if (p === '/users/@me') return json({ id: '1', username: '8n8bot' });
  let m;
  if ((m = p.match(/^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/(.+)\/@me$/))) { fakeDC.reactions.push(m[3]); res.writeHead(204); return res.end(); }
  if ((m = p.match(/^\/channels\/111111111111111111\/messages$/))) {
    if (req.method === 'POST') { fakeDC.sent.push(body); return json({ id: `70000000000000000${fakeDC.sent.length}`, channel_id: '111111111111111111', content: body.content, author: { id: '1', username: '8n8bot', bot: true }, timestamp: new Date().toISOString() }); }
    const after = u.searchParams.get('after'); const lim = Number(u.searchParams.get('limit')) || 50;
    return json(fakeDC.history.filter(x => !after || BigInt(x.id) > BigInt(after)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, lim));
  }
  return json({ message: 'Unknown Channel', code: 10003 }, 404);
}
function fakeTelegramApi(req, res) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const m = req.url.match(/^\/tg\/bot123:abc\/(\w+)/); if (!m) return json({ ok: false, description: 'Unauthorized' }, 401);
  if (m[1] === 'getMe') return json({ ok: true, result: { id: 1, username: 'sahte_bot' } });
  if (m[1] === 'sendMessage') { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => { (fakeTelegram.sent ||= []).push(JSON.parse(raw)); json({ ok: true, result: { message_id: 9, chat: { id: 55 } } }); }); }
  if (m[1] === 'deleteWebhook') { fakeTelegram.webhook = false; return json({ ok: true, result: true }); }
  if (m[1] === 'getUpdates') {
    if (fakeTelegram.webhook) return json({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" }, 409);
    if (fakeTelegram.served || req.url.includes('offset=')) return json({ ok: true, result: [] });
    fakeTelegram.served = true;
    return json({ ok: true, result: [{ update_id: 10, message: { message_id: 1, date: 1700000000, text: 'selam', chat: { id: 55 }, from: { username: 'ayse', first_name: 'Ayşe' } } }] });
  }
  return json({ ok: true, result: {} });
}
const fakeServer = require('http').createServer((req, res) => {
  if (req.url.startsWith('/tg/')) return fakeTelegramApi(req, res);
  const routes = [[/^\/notion\//, fakeNotion], [/^\/slack\//, fakeSlack], [/^\/(ms-token|graph\/)/, fakeMicrosoft], [/^\/gh\//, fakeGithub], [/^\/at\//, fakeAirtable], [/^\/dc\//, fakeDiscord], [/^\/wa\//, fakeWhatsapp], [/^\/(stripe|shop|woo|trello|jira|hubspot|mc|twilio|netgsm|tcmb|geo|meteo)\//, fakeBizApi], [/^\/(pushover\/|ntfy|iyzico\/|graphql|urun\.html)/, fakeMiscApi]];
  if (req.url.startsWith('/s3/')) { const ch = []; req.on('data', d => ch.push(d)); return req.on('end', () => fakeS3Api(req, res, Buffer.concat(ch))); }
  for (const [re, fn] of routes) if (re.test(req.url)) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fn(req, res, raw)); }
  if (/^\/(oauth-token|gmail\/|drive\/|upload\/|calendar\/)/.test(req.url)) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fakeGoogleOAuth(req, res, raw)); }
  if (req.url === '/token' || req.url.startsWith('/v4/')) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fakeGoogleApi(req, res, raw)); }
  if (req.url === '/sayfa.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<html><head><title>SSS</title><script>var x=1</script></head><body><h1>Teslimat</h1><p>Teslimat süresi 3 iş günüdür.</p></body></html>'); }
  if (req.url === '/rss.xml') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return res.end('<?xml version="1.0"?><rss><channel><title>T</title><item><title>İlk yazı</title><link>https://x.com/1</link><guid>1</guid></item></channel></rss>'); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    const body = JSON.parse(raw || '{}'); fakeClaude.calls.push({ headers: req.headers, body });
    const last = body.messages.at(-1);
    let content, stop = 'end_turn';
    const schema = body.output_config?.format?.schema;
    if (schema) { // structured output: classify picks the category named in the text, extract fills known fields
      const text = String(last.content); const props = schema.properties; const o = {};
      if (props.sonuc) { // Claude metin araçları
        const t = text.replace(/<\/?metin>/g, '').trim();
        if (props.puan) Object.assign(o, { sonuc: 'olumsuz', puan: -0.8, gerekce: 'sahte' });
        else if (props.sonuc.type === 'array') o.sonuc = ['kargo', 'gecikme'];
        else if (props.kaynakDil) Object.assign(o, { sonuc: `EN: ${t}`, kaynakDil: 'Türkçe' });
        else if (props.konu) Object.assign(o, { sonuc: `Yanıt (${String(body.system).match(/(samimi|kibar)/)?.[1]}): ${t}`, konu: 'Siparişiniz hakkında' });
        else o.sonuc = `${String(body.system).includes('Madde') || String(body.system).includes('madde') ? '- ' : ''}${t.slice(0, 20)}`;
      } else if (props.cevap) { // knowledge base answer: quote the passage that mentions the asked word
        const secs = [...text.matchAll(/<bolum no="(\d+)"[^>]*>\n([\s\S]*?)\n<\/bolum>/g)];
        const low = x => String(x).toLocaleLowerCase('tr'); const hit = secs.find(m => low(m[2]).includes('iade') && low(text.split('<soru>')[1] || '').includes('iade'));
        Object.assign(o, hit ? { cevap: (hit[2].match(/[^.]*14 gün[^.]*\./) || [hit[2]])[0].trim(), kaynaklar: [+hit[1]], bilgiVar: true } : { cevap: 'Bilmiyorum', kaynaklar: [], bilgiVar: false });
      } else if (props.kategori || props.kategoriler) {
        const en = (props.kategori || props.kategoriler.items).enum;
        const hits = en.filter(c => text.toLocaleLowerCase('tr').includes(c.toLocaleLowerCase('tr')));
        if (props.kategori) o.kategori = hits[0] || 'Diğer'; else o.kategoriler = hits;
        o.gerekce = 'sahte';
      } else for (const [k, p] of Object.entries(props)) o[k] = { ad: 'Ayşe Yılmaz', tutar: 1250.5, acil: true, urunler: ['kalem', 'defter'], teslim: '2026-11-03' }[k] ?? null;
      fakeClaude.structured = (fakeClaude.structured || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_s', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(o) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    if (String(body.system || '').includes('NODE TÜRLERİ')) content = [{ type: 'text', text: '```json\n{"name":"Hava","nodes":[{"key":"a","type":"schedule","name":"Her sabah","params":{"mode":"cron","cron":"0 8 * * *"}},{"key":"b","type":"http","name":"Hava durumu","params":{"url":"https://api.open-meteo.com"}}],"edges":[["a",0,"b",0]],"notes":"Hazır"}\n```' }];
    else if (typeof last.content === 'string' && last.content.includes('bilgi tabanına bak')) { content = [{ type: 'tool_use', id: 'tu_2', name: 'bilgi_tabaninda_ara', input: { sorgu: 'kargo' } }]; stop = 'tool_use'; }
    else if (typeof last.content === 'string' && last.content.includes('kaç')) { content = [{ type: 'tool_use', id: 'tu_1', name: 'hesap_makinesi', input: { ifade: '6*7' } }]; stop = 'tool_use'; }
    else if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') { const r = JSON.parse(last.content[0].content); content = [{ type: 'text', text: Array.isArray(r) ? `Kaynak: ${r[0]?.belge}` : `Sonuç: ${r.sonuc}` }]; }
    else content = [{ type: 'text', text: `Önceki mesaj sayısı: ${body.messages.length - 1}` }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});

/* fake business APIs: Stripe, Shopify, WooCommerce, Trello, Jira, HubSpot, Mailchimp, Twilio, Netgsm, TCMB, Open-Meteo */
const fakeBiz = {
  stripe: { prices: [], links: [], customers: [{ id: 'cus_0', email: 'eski@ornek.com', name: 'Eski Müşteri' }], refunds: [], events: [{ id: 'evt_1', type: 'payment_intent.succeeded', created: 1760000000, data: { object: { id: 'pi_1', object: 'payment_intent', amount_received: 25000, currency: 'try', receipt_email: 'ilk@ornek.com', status: 'succeeded', metadata: {} } } }] },
  shop: { orders: [{ id: 5001, name: '#1001', email: 'ali@ornek.com', total_price: '450.00', currency: 'TRY', financial_status: 'paid', tags: 'eski', note: null, customer: { first_name: 'Ali', last_name: 'Kaya' }, line_items: [{ title: 'Kupa', quantity: 2, price: '225.00', sku: 'KUP-1' }] }],
    products: [{ id: 1, title: 'Kupa', status: 'active', variants: [{ id: 11, sku: 'KUP-1', price: '225.00', inventory_quantity: 5, inventory_item_id: 111 }] }], levels: [] },
  woo: { orders: [{ id: 701, number: '701', status: 'processing', total: '860.00', currency: 'TRY', billing: { first_name: 'Can', last_name: 'Demir', email: 'can@ornek.com', phone: '05321112233', city: 'İzmir' }, shipping: {}, line_items: [{ name: 'Klavye', quantity: 1, sku: 'KLV-1', total: '860.00' }] }],
    products: [{ id: 41, name: 'Klavye', sku: 'KLV-1', price: '860', stock_quantity: 3, stock_status: 'instock', status: 'publish' }], notes: [] },
  trello: { cards: [], comments: [] }, jira: { issues: [], comments: [], moved: [] }, hub: { contacts: [{ id: '101', properties: { email: 'var@ornek.com', firstname: 'Eski' } }], deals: [] },
  mc: { members: {}, tags: [] }, sms: [],
};
function fakeBizApi(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams); const F = fakeBiz;
  const auth = req.headers.authorization || ''; const basic = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
  const body = () => (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
  let m;
  if ((m = u.pathname.match(/^\/stripe(\/.*)$/))) {
    if (auth !== 'Bearer sk_test_x') return json({ error: { message: 'Invalid API Key' } }, 401);
    const p = m[1]; const b = body(); const S = F.stripe;
    if (p === '/balance') return json({ object: 'balance', livemode: false });
    if (p === '/prices') { const x = { id: `price_${S.prices.length + 1}`, currency: b.currency, unit_amount: Number(b.unit_amount), name: b['product_data[name]'] }; S.prices.push(x); return json(x); }
    if (p === '/payment_links') { const x = { id: `plink_${S.links.length + 1}`, url: `https://buy.stripe.com/test_${S.links.length + 1}`, price: b['line_items[0][price]'], quantity: Number(b['line_items[0][quantity]']), metadata: { siparis: b['metadata[siparis]'] } }; S.links.push(x); return json(x); }
    if (p === '/customers' && req.method === 'POST') { const x = { id: `cus_${S.customers.length}`, email: b.email, name: b.name }; S.customers.push(x); return json(x); }
    if (p === '/customers') return json({ data: S.customers.filter(x => x.email === q.email).slice(0, 1) });
    if (p === '/refunds') { if (!b.payment_intent) return json({ error: { message: 'Missing payment_intent' } }, 400); const x = { id: 're_1', status: 'succeeded', amount: Number(b.amount || 25000), payment_intent: b.payment_intent }; S.refunds.push(x); return json(x); }
    if (p === '/events') return json({ data: S.events.filter(e => e.type === q.type) });
    return json({ error: { message: 'yok' } }, 404);
  }
  if ((m = u.pathname.match(/^\/shop\/admin\/api\/2024-10(\/.*)$/))) {
    if (req.headers['x-shopify-access-token'] !== 'shpat_x') return json({ errors: '[API] Invalid API key or access token' }, 401);
    const p = m[1]; const S = F.shop;
    if (p === '/shop.json') return json({ shop: { name: 'Kupa Dükkânı' } });
    if (p === '/orders.json') return json({ orders: S.orders });
    if ((m = p.match(/^\/orders\/(\d+)\.json$/))) { const o = S.orders.find(x => String(x.id) === m[1]); if (!o) return json({ errors: 'Not Found' }, 404); if (req.method === 'PUT') Object.assign(o, { tags: body().order.tags, note: body().order.note }); return json({ order: o }); }
    if (p === '/products.json') return json({ products: S.products });
    if (p === '/locations.json') return json({ locations: [{ id: 9, name: 'Ana depo', active: true }] });
    if (p === '/inventory_levels/set.json') { const b = body(); S.levels.push(b); return json({ inventory_level: { inventory_item_id: b.inventory_item_id, location_id: b.location_id, available: b.available } }); }
    return json({ errors: 'Not Found' }, 404);
  }
  if ((m = u.pathname.match(/^\/woo\/wp-json\/wc\/v3(\/.*)$/))) {
    if (basic !== 'ck_x:cs_x') return json({ code: 'woocommerce_rest_cannot_view', message: 'Üzgünüz, kaynakları listeleyemezsiniz.' }, 401);
    const p = m[1]; const W = F.woo;
    if (p === '/orders' && req.method === 'GET') return json(W.orders.filter(o => !q.status || o.status === q.status));
    if ((m = p.match(/^\/orders\/(\d+)\/notes$/))) { W.notes.push({ order: Number(m[1]), ...body() }); return json({ id: 77 }, 201); }
    if ((m = p.match(/^\/orders\/(\d+)$/))) { const o = W.orders.find(x => String(x.id) === m[1]); if (!o) return json({ message: 'Geçersiz kimlik.' }, 404); Object.assign(o, body()); return json(o); }
    if (p === '/products' && req.method === 'GET') return json(W.products.filter(x => !q.sku || x.sku === q.sku));
    if ((m = p.match(/^\/products\/(\d+)$/))) { const x = W.products.find(y => String(y.id) === m[1]); Object.assign(x, body()); return json(x); }
    return json({ message: 'yok' }, 404);
  }
  if ((m = u.pathname.match(/^\/trello(\/.*)$/))) {
    if (q.key !== 'tkey' || q.token !== 'ttok') return json('invalid key', 401);
    const p = m[1]; const T = F.trello;
    if (p === '/members/me') return json({ fullName: 'Ayşe Yılmaz', username: 'ayse' });
    if (p === '/cards' && req.method === 'POST') { const k = { id: `card${T.cards.length + 1}`, name: q.name, desc: q.desc, idList: q.idList, due: q.due || null, shortUrl: `https://trello.com/c/k${T.cards.length + 1}` }; T.cards.push(k); return json(k); }
    if ((m = p.match(/^\/cards\/(\w+)\/actions\/comments$/))) { T.comments.push({ card: m[1], text: q.text }); return json({ id: 'act1', data: { text: q.text } }); }
    if ((m = p.match(/^\/cards\/(\w+)$/))) { const k = T.cards.find(x => x.id === m[1]); Object.assign(k, { idList: q.idList }); return json(k); }
    if ((m = p.match(/^\/lists\/(\w+)\/cards$/))) return json(T.cards.filter(k => k.idList === m[1]));
    return json('not found', 404);
  }
  if ((m = u.pathname.match(/^\/jira\/rest\/api\/3(\/.*)$/))) {
    if (basic !== 'ayse@ornek.com:jtok') return json({ errorMessages: ['Client must be authenticated'] }, 401);
    const p = m[1]; const J = F.jira; const self = `http://${req.headers.host}/jira/rest/api/3`;
    if (p === '/myself') return json({ displayName: 'Ayşe Yılmaz' });
    if (p === '/issue') { const b = body(); if (!b.fields.project?.key) return json({ errors: { project: 'Proje gerekli' } }, 400); const key = `${b.fields.project.key}-${J.issues.length + 1}`; J.issues.push({ key, id: String(10000 + J.issues.length), self: `${self}/issue/${key}`, fields: { ...b.fields, status: { name: 'To Do' }, created: '2026-10-21T10:00:00.000+0300' } }); return json({ id: J.issues.at(-1).id, key, self: `${self}/issue/${J.issues.at(-1).id}` }, 201); }
    if (p === '/search/jql') return json({ issues: J.issues.filter(i => !q.jql.includes('status != Done') || i.fields.status.name !== 'Done') });
    if ((m = p.match(/^\/issue\/([\w-]+)\/comment$/))) { J.comments.push({ key: m[1], body: body().body }); return json({ id: 'c1' }, 201); }
    if ((m = p.match(/^\/issue\/([\w-]+)\/transitions$/))) {
      if (req.method === 'GET') return json({ transitions: [{ id: '21', name: 'Başla', to: { name: 'In Progress' } }, { id: '31', name: 'Bitir', to: { name: 'Done' } }] });
      const i = J.issues.find(x => x.key === m[1]); const t = body().transition.id; i.fields.status.name = t === '31' ? 'Done' : 'In Progress'; J.moved.push([m[1], t]); res.writeHead(204); return res.end();
    }
    return json({ errorMessages: ['yok'] }, 404);
  }
  if ((m = u.pathname.match(/^\/hubspot(\/.*)$/))) {
    if (auth !== 'Bearer pat-x') return json({ message: 'Authentication credentials not found.' }, 401);
    const p = m[1]; const H = F.hub;
    if (p === '/crm/v3/objects/contacts' && req.method === 'GET') return json({ results: H.contacts.slice(0, 1) });
    if (p === '/crm/v3/objects/contacts') { const x = { id: String(100 + H.contacts.length + 1), properties: body().properties }; H.contacts.push(x); return json(x, 201); }
    if (p === '/crm/v3/objects/deals') { const b = body(); const d = { id: `d${H.deals.length + 1}`, ...b }; H.deals.push(d); return json(d, 201); }
    if ((m = p.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const x = q.idProperty === 'email' ? H.contacts.find(c => c.properties.email === id) : H.contacts.find(c => c.id === id);
      if (!x) return json({ message: 'Object not found' }, 404);
      if (req.method === 'PATCH') Object.assign(x.properties, body().properties);
      return json(x);
    }
    return json({ message: 'yok' }, 404);
  }
  if ((m = u.pathname.match(/^\/mc(\/.*)$/))) {
    if (basic !== '8n8:abc123-us21') return json({ title: 'API Key Invalid', detail: 'Your API key may be invalid' }, 401);
    const p = m[1]; const M = F.mc;
    if (p === '/ping') return json({ health_status: "Everything's Chimpy!" });
    if (p === '/lists') return json({ lists: [{ id: 'L1', name: 'Bülten', stats: { member_count: Object.keys(M.members).length } }] });
    if ((m = p.match(/^\/lists\/L1\/members\/([a-f0-9]{32})\/tags$/))) { M.tags.push({ hash: m[1], tags: body().tags.map(t => t.name) }); res.writeHead(204); return res.end(); }
    if ((m = p.match(/^\/lists\/L1\/members\/([a-f0-9]{32})$/))) {
      const b = body(); const cur = M.members[m[1]];
      if (req.method === 'PUT') { M.members[m[1]] = { id: m[1], email: b.email_address, status: cur?.status || b.status_if_new, merge: b.merge_fields }; return json(M.members[m[1]]); }
      if (!cur) return json({ title: 'Resource Not Found', detail: 'yok' }, 404);
      cur.status = b.status; return json(cur);
    }
    return json({ title: 'Resource Not Found' }, 404);
  }
  if ((m = u.pathname.match(/^\/twilio(\/.*)$/))) {
    if (basic !== 'AC1:ttok') return json({ code: 20003, message: 'Authenticate' }, 401);
    if (m[1] === '/Accounts/AC1.json') return json({ sid: 'AC1', friendly_name: 'Twilio hesabım' });
    if (m[1] === '/Accounts/AC1/Messages.json') { const b = body(); F.sms.push({ via: 'twilio', to: b.To, from: b.From, text: b.Body }); return json({ sid: `SM${F.sms.length}`, status: 'queued' }, 201); }
    return json({ message: 'yok' }, 404);
  }
  if ((m = u.pathname.match(/^\/netgsm(\/.*)$/))) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (q.usercode !== '8501112233' || q.password !== 'npass') return res.end('30');
    if (m[1] === '/sms/header') return res.end('FIRMAM<br>DIGER');
    if (m[1] === '/sms/send/get') { if (q.msgheader !== 'FIRMAM') return res.end('40'); F.sms.push({ via: 'netgsm', to: q.gsmno, text: q.message, dil: q.dil }); return res.end('00 1234567890'); }
    return res.end('70');
  }
  if ((m = u.pathname.match(/^\/tcmb\/(today\.xml|\d{6}\/(\d{8})\.xml)$/))) {
    const day = m[2] ? `${m[2].slice(0, 2)}.${m[2].slice(2, 4)}.${m[2].slice(4)}` : '21.10.2026';
    if (m[2] && !['16102026', '20102026'].includes(m[2])) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>Bulunamadı</html>'); }
    const usd = m[2] === '16102026' ? '41.0000' : '41.5000';
    const cur = (k, name, unit, fb, fs, bb, bs) => `<Currency CrossOrder="0" Kod="${k}" CurrencyCode="${k}"><Unit>${unit}</Unit><Isim>${name}</Isim><CurrencyName>X</CurrencyName><ForexBuying>${fb}</ForexBuying><ForexSelling>${fs}</ForexSelling><BanknoteBuying>${bb}</BanknoteBuying><BanknoteSelling>${bs}</BanknoteSelling><CrossRateUSD/><CrossRateOther/></Currency>`;
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="isokur.xsl"?><Tarih_Date Tarih="${day}" Date="x" Bulten_No="2026/200">${cur('USD', 'ABD DOLARI', 1, '41.4000', usd, '41.3700', '41.5600')}${cur('EUR', 'EURO', 1, '48.0000', '48.2000', '47.9600', '48.2700')}${cur('JPY', 'JAPON YENİ', 100, '27.1000', '27.3000', '', '')}</Tarih_Date>`);
  }
  if (u.pathname === '/geo/v1/search') {
    if (q.name !== 'İzmir') return json({ generationtime_ms: 0.1 });
    return json({ results: [{ name: 'İzmir', latitude: 38.42, longitude: 27.14, country: 'Türkiye', admin1: 'İzmir' }] });
  }
  if (u.pathname === '/meteo/v1/forecast') {
    if (!q.latitude || !q.current?.includes('weather_code')) return json({ error: true, reason: 'eksik' }, 400);
    const n = Number(q.forecast_days); const days = Array.from({ length: n }, (_, i) => `2026-10-${21 + i}`);
    return json({ latitude: Number(q.latitude), current: { temperature_2m: 18.4, apparent_temperature: 17.9, relative_humidity_2m: 70, precipitation: 0.2, weather_code: 61, wind_speed_10m: 12 },
      daily: { time: days, weather_code: days.map((_, i) => [61, 3, 0][i % 3]), temperature_2m_max: days.map(() => 21), temperature_2m_min: days.map(() => 14), precipitation_sum: days.map(() => 1.5), precipitation_probability_max: days.map(() => 80), wind_speed_10m_max: days.map(() => 20), sunrise: days.map(d => `${d}T07:30`), sunset: days.map(d => `${d}T18:30`) } });
  }
  return json({ message: 'sahte iş API\'sinde yol yok' }, 404);
}

/* fake S3 (path style, checks the SigV4 signature), FTP and Redis servers */
const fakeS3 = { objects: new Map(), puts: 0 };
function fakeS3Api(req, res, raw) {
  const S3 = require('../lib/s3'); const xml = (st, x) => { res.writeHead(st, { 'Content-Type': 'application/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?>${x}`); };
  const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname);
  const auth = req.headers.authorization || ''; const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=(\w+)/);
  if (!m || m[1] !== 'AKTEST') return xml(403, '<Error><Code>InvalidAccessKeyId</Code></Error>');
  if (S3.sha(raw) !== req.headers['x-amz-content-sha256']) return xml(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
  const hs = Object.fromEntries(m[4].split(';').filter(n => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)).map(n => [n, req.headers[n]]));
  const want = S3.sign({ method: req.method, host: req.headers.host, path: p, query: Object.fromEntries(u.searchParams), headers: hs, body: raw, accessKey: 'AKTEST', secretKey: 'gizli-s3', region: m[3], date: new Date(req.headers['x-amz-date'].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')) });
  if (want.authorization !== auth) return xml(403, '<Error><Code>SignatureDoesNotMatch</Code><Message>imza tutmuyor</Message></Error>');
  const mm = p.match(/^\/s3\/([^/]*)(?:\/(.*))?$/); const bucket = mm[1], key = mm[2] || '';
  if (!bucket) return xml(200, '<ListAllMyBucketsResult><Buckets><Bucket><Name>kova</Name></Bucket></Buckets></ListAllMyBucketsResult>');
  if (bucket !== 'kova') return xml(404, '<Error><Code>NoSuchBucket</Code></Error>');
  if (!key && req.method === 'GET') {
    const pre = u.searchParams.get('prefix') || ''; const all = [...fakeS3.objects.keys()].filter(k => k.startsWith(pre)).sort();
    const max = Number(u.searchParams.get('max-keys')) || 1000; const start = Number(u.searchParams.get('continuation-token') || 0); const page = all.slice(start, start + max);
    return xml(200, `<ListBucketResult><IsTruncated>${start + max < all.length}</IsTruncated>${start + max < all.length ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ''}${page.map(k => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>2026-10-21T10:00:00.000Z</LastModified><ETag>&quot;e${fakeS3.objects.get(k).data.length}&quot;</ETag><Size>${fakeS3.objects.get(k).data.length}</Size></Contents>`).join('')}</ListBucketResult>`);
  }
  if (req.method === 'PUT') { fakeS3.objects.set(key, { data: raw, type: req.headers['content-type'] }); fakeS3.puts++; res.writeHead(200, { ETag: `"e${raw.length}"` }); return res.end(); }
  const o = fakeS3.objects.get(key);
  if (req.method === 'DELETE') { fakeS3.objects.delete(key); res.writeHead(204); return res.end(); }
  if (!o) return xml(404, '<Error><Code>NoSuchKey</Code></Error>');
  res.writeHead(200, { 'Content-Type': o.type || 'application/octet-stream' }); res.end(o.data);
}

const fakeFTP = { port: 0, files: new Map([['/gelen/merhaba.txt', Buffer.from('FTP içerik')]]), dirs: new Set(['/', '/gelen']) };
const ftpServer = net.createServer(sock => {
  let user = '', authed = false, pasv = null, rnfr = '';
  const say = l => sock.write(`${l}\r\n`);
  const abs = p => (p === '.' ? '/' : (p.startsWith('/') ? p : `/${p}`).replace(/\/+$/, '') || '/');
  say('220 sahte FTP');
  let buf = '';
  sock.on('data', async d => {
    buf += d.toString('utf8'); let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');
      const C = cmd.toUpperCase();
      if (C === 'USER') { user = arg; say('331 şifre'); continue; }
      if (C === 'PASS') { if (user === 'ftpci' && arg === 'ftp-sifre') { authed = true; say('230 hoş geldin'); } else say('530 Login incorrect.'); continue; }
      if (!authed && C !== 'QUIT') { say('530 giriş yapın'); continue; }
      if (C === 'TYPE') say('200 tamam');
      else if (C === 'FEAT') sock.write('211-Features:\r\n MLST type*;size*;modify*;\r\n EPSV\r\n211 End\r\n');
      else if (C === 'EPSV') {
        const srv = net.createServer(); let got; pasv = new Promise(r => { got = r; });
        srv.on('connection', ds => { got(ds); srv.close(); });
        await new Promise(r => srv.listen(0, '127.0.0.1', r)); say(`229 Entering Extended Passive Mode (|||${srv.address().port}|)`);
      } else if (C === 'MLSD' || C === 'RETR' || C === 'STOR') {
        const ds = await pasv; const p = abs(arg || '/');
        if (C === 'RETR' && !fakeFTP.files.has(p)) { ds.destroy(); say('550 Dosya yok'); continue; }
        say('150 veri bağlantısı açık');
        if (C === 'STOR') { const ch = []; ds.on('data', x => ch.push(x)); await new Promise(r => ds.on('close', r)); fakeFTP.files.set(p, Buffer.concat(ch)); say('226 yüklendi'); continue; }
        if (C === 'RETR') ds.end(fakeFTP.files.get(p));
        else {
          const dir = p === '/' ? '/' : `${p}/`;
          const ents = [...[...fakeFTP.dirs].filter(x => x !== p && x.startsWith(dir) && !x.slice(dir.length).includes('/')).map(x => `type=dir;modify=20261021100000; ${x.slice(dir.length)}`),
            ...[...fakeFTP.files].filter(([k]) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(([k, v]) => `type=file;size=${v.length};modify=20261021100000; ${k.slice(dir.length)}`)];
          ds.end(ents.map(x => `${x}\r\n`).join(''));
        }
        await new Promise(r => ds.on('close', r)); say('226 bitti');
      } else if (C === 'DELE') { if (fakeFTP.files.delete(abs(arg))) say('250 silindi'); else say('550 yok'); }
      else if (C === 'MKD') { const p = abs(arg); if (fakeFTP.dirs.has(p)) say('550 var'); else { fakeFTP.dirs.add(p); say(`257 "${p}" oluşturuldu`); } }
      else if (C === 'RNFR') { rnfr = abs(arg); if (fakeFTP.files.has(rnfr)) say('350 hazır'); else say('550 yok'); }
      else if (C === 'RNTO') { fakeFTP.files.set(abs(arg), fakeFTP.files.get(rnfr)); fakeFTP.files.delete(rnfr); say('250 taşındı'); }
      else if (C === 'QUIT') { say('221 hoşça kal'); sock.end(); }
      else say('502 bilinmeyen komut');
    }
  });
  sock.on('error', () => {});
});

const fakeRedis = { port: 0, data: new Map(), published: [] };
const redisServer = net.createServer(sock => {
  const R = require('../lib/redis'); let buf = Buffer.alloc(0); let authed = false;
  const bulk = v => (v == null ? '$-1\r\n' : `$${Buffer.byteLength(String(v))}\r\n${v}\r\n`);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = R.parse(buf); if (!r) break; buf = buf.slice(r[1]); const [c0, ...a] = r[0]; const C = String(c0).toUpperCase(); const D = fakeRedis.data;
      if (C === 'AUTH') { authed = a.at(-1) === 'redis-sifre'; sock.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair or user is disabled.\r\n'); continue; }
      if (!authed) { sock.write('-NOAUTH Authentication required.\r\n'); continue; }
      if (C === 'PING') sock.write('+PONG\r\n');
      else if (C === 'SELECT' || C === 'EXPIRE') sock.write(C === 'SELECT' ? '+OK\r\n' : ':1\r\n');
      else if (C === 'INFO') sock.write(bulk('# Server\r\nredis_version:7.2.0\r\n'));
      else if (C === 'GET') sock.write(bulk(D.get(a[0])));
      else if (C === 'SET') { D.set(a[0], a[1]); if (a[2] === 'EX') D.set(`ttl:${a[0]}`, a[3]); sock.write('+OK\r\n'); }
      else if (C === 'DEL') { const n = a.filter(k => D.delete(k)).length; sock.write(`:${n}\r\n`); }
      else if (C === 'INCRBY') { const v = Number(D.get(a[0]) || 0) + Number(a[1]); D.set(a[0], String(v)); sock.write(`:${v}\r\n`); }
      else if (C === 'RPUSH' || C === 'LPUSH') { const l = D.get(a[0]) || []; C === 'RPUSH' ? l.push(...a.slice(1)) : l.unshift(...a.slice(1)); D.set(a[0], l); sock.write(`:${l.length}\r\n`); }
      else if (C === 'RPOP' || C === 'LPOP') { const l = D.get(a[0]) || []; sock.write(bulk(C === 'RPOP' ? l.pop() : l.shift())); }
      else if (C === 'PUBLISH') { fakeRedis.published.push(a); sock.write(':0\r\n'); }
      else if (C === 'HSET') { const hh = D.get(a[0]) || {}; for (let k = 1; k < a.length; k += 2) hh[a[k]] = a[k + 1]; D.set(a[0], hh); sock.write(`:${(a.length - 1) / 2}\r\n`); }
      else if (C === 'HGETALL') { const hh = D.get(a[0]) || {}; const flat = Object.entries(hh).flat(); sock.write(`*${flat.length}\r\n${flat.map(bulk).join('')}`); }
      else if (C === 'QUIT') { sock.write('+OK\r\n'); sock.end(); }
      else sock.write(`-ERR unknown command '${c0}'\r\n`);
    }
  });
  sock.on('error', () => {});
});

/* pushover, ntfy, iyzico (checks the IYZWSv2 signature), GraphQL and a product page */
const fakeMisc = { pushes: [], iyzi: [] };
function fakeMiscApi(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'); const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
  if (u.pathname === '/pushover/1/users/validate.json') return body.token === 'po-tok' ? json({ status: 1, devices: ['telefon'] }) : json({ status: 0, errors: ['application token is invalid'] }, 400);
  if (u.pathname === '/pushover/1/messages.json') { if (body.token !== 'po-tok') return json({ status: 0, errors: ['application token is invalid'] }, 400); fakeMisc.pushes.push({ via: 'pushover', ...body }); return json({ status: 1, request: 'req1' }); }
  if (u.pathname === '/ntfy') { if (req.headers.authorization !== 'Bearer tk_ntfy') return json({ code: 40101, error: 'unauthorized' }, 401); fakeMisc.pushes.push({ via: 'ntfy', ...body }); return json({ id: 'nt1', event: 'message', topic: body.topic }); }
  if (u.pathname.startsWith('/iyzico/')) {
    const uri = u.pathname.replace(/^\/iyzico/, ''); const m = String(req.headers.authorization || '').match(/^IYZWSv2 (.+)$/);
    const a = m ? Object.fromEntries(Buffer.from(m[1], 'base64').toString().split('&').map(x => x.split(':'))) : {};
    const sig = require('crypto').createHmac('sha256', 'iyz-gizli').update(String(a.randomKey) + uri + (raw || '')).digest('hex');
    if (a.apiKey !== 'iyz-api' || a.signature !== sig || req.headers['x-iyzi-rnd'] !== a.randomKey) return json({ status: 'failure', errorCode: '1001', errorMessage: 'api bilgileri bulunamadı' }, 401);
    if (uri === '/v2/iyzilink/products' && req.method === 'POST') { fakeMisc.iyzi.push(body); return json({ status: 'success', data: { token: 'AAA1', url: 'https://sandbox.iyzi.link/AAA1', imageUrl: 'x' } }); }
    if (uri === '/v2/iyzilink/products') return json({ status: 'success', data: { items: fakeMisc.iyzi.map((x, i) => ({ token: `AAA${i + 1}`, name: x.name, price: Number(x.price), currencyCode: 'TRY', url: `https://sandbox.iyzi.link/AAA${i + 1}`, productStatus: 'ACTIVE' })) } });
    if (uri === '/payment/detail') return body.paymentId === '1234' ? json({ status: 'success', paymentStatus: 'SUCCESS', paidPrice: 1250.5, installment: 1, lastFourDigits: '0008', cardFamily: 'Bonus' }) : json({ status: 'failure', errorMessage: 'Ödeme bulunamadı' });
    return json({ status: 'failure', errorMessage: 'yok' }, 404);
  }
  if (u.pathname === '/graphql') {
    if (req.headers.authorization !== 'Bearer gql-tok') return json({ errors: [{ message: 'Yetkisiz' }] }, 401);
    if (/syntaxError/.test(body.query)) return json({ errors: [{ message: 'Syntax Error: Unexpected Name' }] }, 400);
    return json({ data: { user: { id: body.variables.id, name: `Kişi ${body.variables.id}`, repos: { nodes: [{ ad: 'a' }, { ad: 'b' }] } } } });
  }
  if (u.pathname === '/urun.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html><head><title>Kırmızı Kupa &amp; Tabak</title><meta name="description" content="El yapımı seramik kupa"><meta property="og:image" content="https://x.com/k.jpg"></head><body><nav><a href="/">Ana sayfa</a> Menü</nav><main><h1>Kırmızı Kupa</h1><p>Fiyat: 225 TL</p><p>Durum: Stokta&nbsp;var &#8211; hızlı kargo</p><a href="/sepet?u=1">Sepete ekle</a><a href="https://baska.com/x">Dış</a></main><footer>© Mağaza</footer></body></html>'); }
  return json({ error: 'yok' }, 404);
}

(async () => {
  await new Promise(r => fakeServer.listen(0, '127.0.0.1', r)); fakeClaude.port = fakeServer.address().port;
  await new Promise(r => imapServer.listen(0, '127.0.0.1', r)); fakeIMAP.port = imapServer.address().port;
  await new Promise(r => ftpServer.listen(0, '127.0.0.1', r)); fakeFTP.port = ftpServer.address().port;
  await new Promise(r => redisServer.listen(0, '127.0.0.1', r)); fakeRedis.port = redisServer.address().port;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, N8N8_DATA: DATA, PORT: String(PORT), N8N8_NO_OPEN: '1', N8N8_ALLOW_COMMANDS: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_SHEETS_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_TELEGRAM_API: `http://127.0.0.1:${fakeClaude.port}/tg`, N8N8_GOOGLE_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-auth`, N8N8_GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-token`, N8N8_NOTION_API: `http://127.0.0.1:${fakeClaude.port}/notion`, N8N8_SLACK_API: `http://127.0.0.1:${fakeClaude.port}/slack`, N8N8_GRAPH_API: `http://127.0.0.1:${fakeClaude.port}/graph`, N8N8_MS_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/ms-auth`, N8N8_MS_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/ms-token`, N8N8_GITHUB_API: `http://127.0.0.1:${fakeClaude.port}/gh`, N8N8_AIRTABLE_API: `http://127.0.0.1:${fakeClaude.port}/at`, N8N8_DISCORD_API: `http://127.0.0.1:${fakeClaude.port}/dc`, N8N8_WHATSAPP_API: `http://127.0.0.1:${fakeClaude.port}/wa`, ...Object.fromEntries(Object.entries({ STRIPE: 'stripe', SHOPIFY: 'shop', WOO: 'woo', TRELLO: 'trello', JIRA: 'jira', HUBSPOT: 'hubspot', MAILCHIMP: 'mc', TWILIO: 'twilio', NETGSM: 'netgsm', TCMB: 'tcmb', GEO: 'geo', WEATHER: 'meteo', PUSHOVER: 'pushover', IYZICO: 'iyzico' }).map(([k, v]) => [`N8N8_${k}_API`, `http://127.0.0.1:${fakeClaude.port}/${v}`])) }, stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => srv.kill());
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('çalışıyor')) res(); }); srv.on('exit', c => rej(new Error('sunucu kapandı: ' + c))); });
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  }
  srv.kill(); fakeServer.close(); imapServer.close(); ftpServer.close(); redisServer.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} test başarısız` : `\nTüm ${tests.length} test geçti`);
  process.exit(fail ? 1 : 0);
})();
