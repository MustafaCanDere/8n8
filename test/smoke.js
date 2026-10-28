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

test('MongoDB (SCRAM girişi, getMore), MQTT gönder ve tetikleyici (sahte sunucular)', async () => {
  const uri = `mongodb://ali:gizli@127.0.0.1:${fakeMongo.port}/magaza?authSource=admin`;
  const mg = await api('POST', '/api/credentials', { type: 'mongoDb', name: 'mg', data: { uri } });
  const bad = await api('POST', '/api/credentials/test', { type: 'mongoDb', data: { uri: uri.replace(':gizli@', ':yanlis@') } });
  assert.equal(bad.ok, false); assert.match(bad.message, /kullanıcı adı ya da şifre yanlış/);
  const w = await api('POST', '/api/workflows', wf('mongo', [
    ['manual', { data: '[{"ad":"Ayşe","sehir":"İzmir","puan":5,"kayit":{"$date":"2026-01-02T03:04:05Z"}},{"ad":"Ali","sehir":"Bursa","puan":3},{"ad":"Can","sehir":"İzmir","puan":4}]' }],
    ['mongodb', { credential: mg.id, op: 'insert', collection: 'musteriler' }, { name: 'ekle' }],
    ['mongodb', { credential: mg.id, op: 'find', collection: 'musteriler', filter: '{}', sort: '', limit: 100 }, { name: 'hepsi' }],
    ['mongodb', { credential: mg.id, op: 'find', collection: 'musteriler', filter: '{ "sehir": "İzmir", "puan": { "$gte": 4 } }', sort: '{ "puan": -1 }', projection: 'ad,puan', limit: 10 }, { name: 'bul' }],
    ['mongodb', { credential: mg.id, op: 'update', collection: 'musteriler', filter: '{ "_id": "{{ $json._id }}" }', update: '{ "durum": "vip", "puan": {{ $json.puan + 1 }} }' }, { name: 'gunc' }],
    ['mongodb', { credential: mg.id, op: 'count', collection: 'musteriler', filter: '{ "durum": "vip" }' }, { name: 'say' }],
    ['mongodb', { credential: mg.id, op: 'aggregate', collection: 'musteriler', pipeline: '[{ "$group": { "_id": "$sehir", "adet": { "$sum": 1 } } }, { "$sort": { "adet": -1 } }]' }, { name: 'grup' }],
    ['mongodb', { credential: mg.id, op: 'delete', collection: 'musteriler', filter: '{ "sehir": "{{ $json._id }}", "puan": 3 }' }, { name: 'sil' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.match((await api('POST', '/api/credentials/test', { type: 'mongoDb', id: mg.id, data: {} })).message, /Bağlanıldı \(magaza\); koleksiyonlar: musteriler/);
  const hepsi = outOf(e, 'hepsi'); assert.equal(hepsi.length, 3, 'getMore ile üç belge');
  assert.match(hepsi[0]._id, /^[0-9a-f]{24}$/); assert.equal(hepsi[0].kayit, '2026-01-02T03:04:05.000Z');
  const M = require('../lib/mongo'); const stored = fakeMongo.cols.musteriler;
  assert.ok(stored.every(d => d._id instanceof M.ObjectId)); assert.ok(stored.find(d => d.ad === 'Ayşe').kayit instanceof Date);
  assert.deepEqual(outOf(e, 'bul').map(x => [x.ad, x.puan, 'sehir' in x]), [['Ayşe', 5, false], ['Can', 4, false]]);
  assert.deepEqual(outOf(e, 'gunc').map(x => [x.eslesen, x.degisen]), [[1, 1], [1, 1]]);
  assert.deepEqual([stored.find(d => d.ad === 'Ayşe').puan, stored.find(d => d.ad === 'Ayşe').durum], [6, 'vip']);
  assert.equal(outOf(e, 'say')[0].adet, 2);
  assert.deepEqual(outOf(e, 'grup').map(x => [x._id, x.adet]), [['İzmir', 2], ['Bursa', 1]]);
  assert.deepEqual(outOf(e, 'sil').map(x => x.silinen), [0, 1]); assert.equal(fakeMongo.cols.musteriler.length, 2);
  const w0 = await api('POST', '/api/workflows', wf('mongo-bos', [['manual', {}], ['mongodb', { credential: mg.id, op: 'delete', collection: 'musteriler', filter: '{}' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${w0.id}/run`, {})).executionId)).error, /Filtre boş/);

  // MQTT: publish, wrong password, and the trigger fires once per matching message
  const mq = await api('POST', '/api/credentials', { type: 'mqttBroker', name: 'mq', data: { host: '127.0.0.1', port: String(fakeMqtt.port), user: 'ali', password: 'gizli', secure: 'false' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'mqttBroker', id: mq.id, data: { host: '127.0.0.1', port: String(fakeMqtt.port), user: 'ali', secure: 'false' } })).message, 'Bağlanıldı');
  const mb = await api('POST', '/api/credentials/test', { type: 'mqttBroker', data: { host: '127.0.0.1', port: String(fakeMqtt.port), user: 'ali', password: 'x' } });
  assert.match(mb.message, /reddedildi: yetkiniz yok/);
  const t = await api('POST', '/api/workflows', wf('mqtt-tetik', [['mqttTrigger', { credential: mq.id, topics: 'ev/+/sicaklik, alarm/#', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1300);
  const p = await api('POST', '/api/workflows', wf('mqtt-gonder', [
    ['manual', { data: '[{"oda":"salon","tur":"sicaklik","sicaklik":22.5},{"oda":"mutfak","tur":"nem","nem":40}]' }],
    ['mqtt', { credential: mq.id, topic: 'ev/{{ $json.oda }}/{{ $json.tur }}', message: '', qos: '1', retain: false }, { name: 'gonder' }],
    ['mqtt', { credential: mq.id, topic: 'alarm/kapi', message: 'açıldı', qos: '0', retain: true }, { name: 'alarm' }],
  ], [[0, 1], [1, 2]]));
  const ep = await waitExec((await api('POST', `/api/workflows/${p.id}/run`, {})).executionId);
  assert.equal(ep.status, 'success', ep.error);
  assert.deepEqual(fakeMqtt.published.map(x => [x.topic, x.qos, x.retain]), [['ev/salon/sicaklik', 1, false], ['ev/mutfak/nem', 1, false], ['alarm/kapi', 0, true], ['alarm/kapi', 0, true]]);
  assert.deepEqual(JSON.parse(fakeMqtt.published[0].payload), { oda: 'salon', tur: 'sicaklik', sicaklik: 22.5 });
  await sleep(4500);
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  const got = await Promise.all(items.map(async x => outOf(await waitExec(x.id), 'son')[0]));
  assert.deepEqual(got.map(x => [x.konu, x.mesaj]).sort((a, b) => a[0].localeCompare(b[0])), [['alarm/kapi', 'açıldı'], ['alarm/kapi', 'açıldı'], ['ev/salon/sicaklik', { oda: 'salon', tur: 'sicaklik', sicaklik: 22.5 }]]);
});

test('Elasticsearch, Supabase ve Odoo (sahte API)', async () => {
  const B0 = `http://127.0.0.1:${fakeClaude.port}`;
  const es = await api('POST', '/api/credentials', { type: 'elasticsearchApi', name: 'es', data: { url: `${B0}/es`, apiKey: 'es-key' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'elasticsearchApi', id: es.id, data: { url: `${B0}/es` } })).message, 'Bağlanıldı: Elasticsearch 8.15.0');
  const sb = await api('POST', '/api/credentials', { type: 'supabaseApi', name: 'sb', data: { url: `${B0}/supa/`, key: 'supa-key' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'supabaseApi', id: sb.id, data: { url: `${B0}/supa/` } })).message, 'Bağlanıldı');
  const od = await api('POST', '/api/credentials', { type: 'odooApi', name: 'od', data: { url: B0 + '/odoo', db: 'firma', user: 'admin@ornek.com', password: 'odoo-key' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'odooApi', id: od.id, data: { url: B0 + '/odoo', db: 'firma', user: 'admin@ornek.com' } })).message, /kullanıcı #7/);
  const ob = await api('POST', '/api/credentials/test', { type: 'odooApi', data: { url: B0 + '/odoo', db: 'firma', user: 'admin@ornek.com', password: 'x' } });
  assert.match(ob.message, /Odoo girişi başarısız/);
  const w = await api('POST', '/api/workflows', wf('es-supa-odoo', [
    ['manual', { data: '[{"id":"k1","ad":"Kırmızı Kupa","fiyat":225,"gizli":1},{"id":"k2","ad":"Mavi tabak","fiyat":120}]' }],
    ['elasticsearch', { credential: es.id, op: 'index', index: 'urunler', id: '{{ $json.id }}', fields: 'ad,fiyat' }, { name: 'esEkle' }],
    ['elasticsearch', { credential: es.id, op: 'search', index: 'urunler', text: 'kupa', query: '', size: 20 }, { name: 'esAra' }],
    ['elasticsearch', { credential: es.id, op: 'update', index: 'urunler', id: '{{ $json._id }}', fields: 'fiyat' }, { name: 'esGunc' }],
    ['elasticsearch', { credential: es.id, op: 'get', index: 'urunler', id: '{{ $json._id }}' }, { name: 'esGetir' }],
    ['elasticsearch', { credential: es.id, op: 'delete', index: 'urunler', id: '{{ $json._id }}' }, { name: 'esSil' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const w2 = await api('POST', '/api/workflows', wf('supa-odoo', [
    ['manual', { data: '[{"id":1,"musteri":"Ayşe","durum":"yeni"},{"id":2,"musteri":"Ali","durum":"hazir"},{"id":3,"musteri":"Alper","durum":"yeni"}]' }, { name: 'satirlar' }],
    ['supabase', { credential: sb.id, op: 'insert', table: 'siparisler' }, { name: 'sEkle' }],
    ['supabase', { credential: sb.id, op: 'select', table: 'siparisler', filter: 'durum = yeni', columns: '*', order: 'id.desc', limit: 1 }, { name: 'sOku' }],
    ['supabase', { credential: sb.id, op: 'update', table: 'siparisler', filter: 'id = {{ $json.id }}', values: '{ "durum": "hazirlaniyor" }' }, { name: 'sGunc' }],
    ['set', { fields: [{ key: 'id', value: '{{ 2 }}' }, { key: 'durum', value: 'kargoda' }], keep: false }],
    ['supabase', { credential: sb.id, op: 'upsert', table: 'siparisler', onConflict: 'id' }, { name: 'sUpsert' }],
    ['supabase', { credential: sb.id, op: 'delete', table: 'siparisler', filter: 'musteri ~ ayş' }, { name: 'sSil' }],
    ['odoo', { credential: od.id, op: 'search', model: 'res.partner', domain: '[["is_company", "=", true]]', fieldNames: 'name,email,phone,country_id', limit: 10 }, { name: 'oAra' }],
    ['odoo', { credential: od.id, op: 'create', model: 'crm.lead', values: '{ "name": "{{ $json.name }} fırsatı", "email_from": "{{ $json.email }}" }' }, { name: 'oEkle' }],
    ['odoo', { credential: od.id, op: 'update', model: 'crm.lead', id: '{{ $json.id }}', values: '{ "priority": "2" }' }, { name: 'oGunc' }],
    ['odoo', { credential: od.id, op: 'delete', model: 'crm.lead', id: '{{ $json.id }}' }, { name: 'oSil' }],
  ], Array.from({ length: 10 }, (_, i) => [i, i + 1])));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual(outOf(e, 'esEkle').map(x => [x._id, x.sonuc]), [['k1', 'created'], ['k2', 'created']]);
  assert.deepEqual(outOf(e, 'esAra').map(x => [x._id, x.ad, x._skor]), [['k1', 'Kırmızı Kupa', 1.2]]);
  assert.equal(outOf(e, 'esGunc')[0].sonuc, 'updated');
  assert.deepEqual(outOf(e, 'esGetir')[0], { _id: 'k1', ad: 'Kırmızı Kupa', fiyat: 225 });
  assert.deepEqual(outOf(e, 'esSil')[0], { _id: 'k1', sonuc: 'deleted' }); assert.deepEqual(Object.keys(fakeMore.es.urunler), ['k2']);
  assert.equal(outOf(e2, 'sEkle').length, 3);
  assert.deepEqual(outOf(e2, 'sOku').map(x => x.id), [3]);
  assert.deepEqual(outOf(e2, 'sGunc').map(x => [x.id, x.durum]), [[3, 'hazirlaniyor']]);
  assert.deepEqual(outOf(e2, 'sUpsert').map(x => [x.id, x.musteri, x.durum]), [[2, 'Ali', 'kargoda']]);
  assert.deepEqual(outOf(e2, 'sSil').map(x => x.musteri), ['Ayşe']);
  assert.ok(fakeMore.supaQs.includes('GET ?select=*&durum=eq.yeni&order=id.desc&limit=1'), fakeMore.supaQs.join(' | '));
  assert.ok(fakeMore.supaQs.includes('DELETE ?musteri=ilike.*ay%C5%9F*'), fakeMore.supaQs.join(' | '));
  assert.deepEqual(outOf(e2, 'oAra')[0], { id: 14, name: 'Deco Ltd', email: 'info@deco.com', phone: null, country_id: { id: 224, ad: 'Türkiye' } });
  assert.equal(outOf(e2, 'oEkle')[0].id, 51); assert.equal(outOf(e2, 'oGunc')[0].guncellendi, true); assert.deepEqual(outOf(e2, 'oSil')[0], { id: 51, silindi: true });
  assert.deepEqual(fakeMore.odoo.filter(x => x[0] === 'object').map(x => [x[3], x[2]]), [['search_read', 'res.partner'], ['create', 'crm.lead'], ['write', 'crm.lead'], ['unlink', 'crm.lead']]);
  assert.deepEqual(fakeMore.odoo.find(x => x[3] === 'create')[4], [{ name: 'Deco Ltd fırsatı', email_from: 'info@deco.com' }]);
  const g = await api('POST', '/api/workflows', wf('supa-bos', [['manual', {}], ['supabase', { credential: sb.id, op: 'delete', table: 'siparisler', filter: '' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${g.id}/run`, {})).executionId)).error, /Filtre boş/);
});

test('Trendyol (sipariş, paket durumu, fatura, stok, soru) + tetikleyici ve Paraşüt (müşteri, fatura, tahsilat, e-Arşiv) (sahte API)', async () => {
  const ty = await api('POST', '/api/credentials', { type: 'trendyolApi', name: 'ty', data: { sellerId: '555', apiKey: 'ty-key', apiSecret: 'ty-secret', stage: 'false' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'trendyolApi', id: ty.id, data: { sellerId: '555', apiKey: 'ty-key', stage: 'false' } })).message, 'Bağlanıldı (canlı); 1 ürün');
  const tb = await api('POST', '/api/credentials/test', { type: 'trendyolApi', data: { sellerId: '555', apiKey: 'ty-key', apiSecret: 'x' } });
  assert.match(tb.message, /API Key ya da Secret yanlış/);
  const w = await api('POST', '/api/workflows', wf('trendyol', [
    ['manual', {}],
    ['trendyol', { credential: ty.id, op: 'orders', status: 'Created', days: 7, max: 50 }, { name: 'sip' }],
    ['trendyol', { credential: ty.id, op: 'status', packageId: '{{ $json.paketId }}', newStatus: 'Picking', lines: '{{ $json.urunler }}' }, { name: 'durum' }],
    ['trendyol', { credential: ty.id, op: 'status', packageId: '{{ $json.paketId }}', newStatus: 'Invoiced', lines: '{{ $json.urunler }}', invoiceNumber: 'GIB2026000000001' }, { name: 'durum2' }],
    ['trendyol', { credential: ty.id, op: 'invoice', packageId: '{{ $json.paketId }}', invoiceLink: 'https://f.com/{{ $json.siparisNo }}.pdf' }, { name: 'fatura' }],
    ['trendyol', { credential: ty.id, op: 'stock', barcode: '{{ $json.urunler[0].barkod }}', quantity: '7', salePrice: '1.250,50', listPrice: '' }, { name: 'stok' }],
    ['trendyol', { credential: ty.id, op: 'batch', batchId: '{{ $json.islemNo }}' }, { name: 'islem' }],
    ['trendyol', { credential: ty.id, op: 'products', productBarcode: '869001' }, { name: 'urun' }],
    ['trendyol', { credential: ty.id, op: 'questions', max: 10 }, { name: 'soru' }],
    ['trendyol', { credential: ty.id, op: 'answer', questionId: '{{ $json.soruId }}', answer: 'Merhaba, bulaşık makinesinde yıkanabilir.' }, { name: 'cevap' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const o = outOf(e, 'sip')[0];
  assert.deepEqual([o.paketId, o.siparisNo, o.musteri, o.tutar, o.adres.il, o.urunler[0].satirId, o.tarih], [3360001, '10561', 'Ayşe Yılmaz', 449.9, 'İstanbul', 77, '2025-10-20T22:40:00.000Z']);
  assert.deepEqual(fakeMore.ty.status, [{ id: 3360001, lines: [{ lineId: 77, quantity: 1 }], params: {}, status: 'Picking' }, { id: 3360001, lines: [{ lineId: 77, quantity: 1 }], params: { invoiceNumber: 'GIB2026000000001' }, status: 'Invoiced' }]);
  assert.deepEqual(fakeMore.ty.invoices, [{ invoiceLink: 'https://f.com/10561.pdf', shipmentPackageId: 3360001 }]);
  assert.deepEqual(fakeMore.ty.stock, [{ barcode: '869001', quantity: 7, salePrice: 1250.5, listPrice: 1250.5 }]);
  assert.deepEqual(outOf(e, 'islem')[0], { islemNo: 'b-123', durum: 'COMPLETED', toplam: 1, hatali: 0, hatalar: [] });
  assert.equal(outOf(e, 'urun')[0].urun.stok, 7);
  assert.deepEqual(outOf(e, 'soru').map(x => [x.soruId, x.soru]), [[901, 'Bulaşık makinesine girer mi?']]);
  assert.deepEqual(fakeMore.ty.answers, [{ id: 901, text: 'Merhaba, bulaşık makinesinde yıkanabilir.' }]);
  const kisa = await api('POST', '/api/workflows', wf('ty-kisa', [['manual', { data: '[{"soruId":1}]' }], ['trendyol', { credential: ty.id, op: 'answer', questionId: '1', answer: 'Evet' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${kisa.id}/run`, {})).executionId)).error, /10-2000 karakter/);
  // trigger: only the order added after the first check starts the workflow
  const t = await api('POST', '/api/workflows', wf('ty-tetik', [['trendyolTrigger', { credential: ty.id, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1300);
  fakeMore.ty.orders.unshift({ id: 3360002, orderNumber: '10562', status: 'Created', customerFirstName: 'Mert', customerLastName: 'Kaya', totalPrice: 120, currencyCode: 'TRY', lines: [] });

  // Paraşüt
  const ps = await api('POST', '/api/credentials', { type: 'parasutApi', name: 'ps', data: { companyId: '777', clientId: 'pc', clientSecret: 'ps', user: 'muh@ornek.com', password: 'pp' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'parasutApi', id: ps.id, data: { companyId: '777', clientId: 'pc', user: 'muh@ornek.com' } })).message, /Giriş yapıldı; 0 müşteri/);
  const pb = await api('POST', '/api/credentials/test', { type: 'parasutApi', data: { companyId: '777', clientId: 'pc', clientSecret: 'ps', user: 'muh@ornek.com', password: 'x' } });
  assert.match(pb.message, /e-posta ya da şifre yanlış/);
  const tokensBefore = fakeMore.parasut.tokens;
  const w2 = await api('POST', '/api/workflows', wf('parasut', [
    ['manual', { data: '[{"musteri":"Ayşe Yılmaz","eposta":"ayse@ornek.com","telefon":"05321112233","vergiNo":"11111111111","il":"İzmir","ilce":"Konak","adres":"Cumhuriyet Blv. 5","siparisNo":"S-1","urunler":[{"ad":"Kupa","adet":2,"fiyat":"100,50","kdv":20}]}]' }],
    ['parasut', { credential: ps.id, op: 'contacts', search: '{{ $json.eposta }}' }, { name: 'ara' }],
    ['parasut', { credential: ps.id, op: 'contact' }, { name: 'musteri' }],
    ['parasut', { credential: ps.id, op: 'invoice', contactId: '{{ $json.id }}', lines: '{{ $json.urunler }}', issueDate: '2026-10-22', dueDays: 15, currency: 'TRL' }, { name: 'fatura' }],
    ['parasut', { credential: ps.id, op: 'pay', invoiceId: '{{ $json.faturaId }}', accountId: '42', amount: '{{ $json.faturaTutari }}', issueDate: '2026-10-22' }, { name: 'tahsilat' }],
    ['parasut', { credential: ps.id, op: 'formalize', invoiceId: '{{ $json.faturaId }}', internetSale: true, saleUrl: 'https://magazam.com' }, { name: 'resmi' }],
    ['parasut', { credential: ps.id, op: 'invoices', max: 5 }, { name: 'liste' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.equal(outOf(e2, 'ara')[0].musteriBulundu, false);
  const body = k => fakeMore.parasut.bodies.find(([r]) => r === k)?.[1];
  assert.deepEqual(body('/contacts').data.attributes, { account_type: 'customer', name: 'Ayşe Yılmaz', email: 'ayse@ornek.com', phone: '05321112233', tax_number: '11111111111', city: 'İzmir', district: 'Konak', address: 'Cumhuriyet Blv. 5', contact_type: 'person' });
  const inv = body('/sales_invoices').data;
  assert.deepEqual([inv.attributes.issue_date, inv.attributes.due_date, inv.attributes.currency, inv.attributes.description, inv.relationships.contact.data.id], ['2026-10-22', '2026-11-06', 'TRL', 'Sipariş S-1', '501']);
  assert.deepEqual(inv.relationships.details.data[0].attributes, { quantity: 2, unit_price: 100.5, vat_rate: 20, description: 'Kupa' });
  assert.deepEqual([outOf(e2, 'fatura')[0].faturaId, outOf(e2, 'fatura')[0].faturaTutari, outOf(e2, 'fatura')[0].kdv], ['9001', 241.2, 40.2]);
  assert.deepEqual(body('/sales_invoices/9001/payments').data.attributes, { account_id: 42, date: '2026-10-22', amount: 241.2 });
  assert.deepEqual([outOf(e2, 'resmi')[0].resmiTur, outOf(e2, 'resmi')[0].isNo], ['e-Arşiv', 'job-1']);
  assert.equal(body('/e_archives').data.attributes.internet_sale.url, 'https://magazam.com');
  assert.deepEqual(outOf(e2, 'liste').map(x => [x.faturaId, x.musteri, x.tutar]), [['9001', 'Ayşe Yılmaz', 241.2]]);
  assert.equal(fakeMore.parasut.tokens - tokensBefore, 0, 'jeton önbellekten kullanılmalı');

  // template: Trendyol order -> Paraşüt invoice with VAT-inclusive prices -> e-Arşiv -> ntfy
  const nt = await api('POST', '/api/credentials', { type: 'ntfyApi', name: 'nt-ty', data: { server: `http://127.0.0.1:${fakeClaude.port}/ntfy`, token: 'tk_ntfy' } });
  const tw = await api('POST', '/api/templates/trendyolParasut', {});
  for (const n of tw.nodes) { if (n.type === 'trendyolTrigger') n.params.credential = ty.id; if (n.type === 'parasut') n.params.credential = ps.id; if (n.type === 'push') { n.params.ntfyCred = nt.id; n.params.topic = 'magaza-x7k2'; } }
  await api('PUT', `/api/workflows/${tw.id}`, tw);
  const et = await waitExec((await api('POST', `/api/workflows/${tw.id}/run`, {})).executionId);
  assert.equal(et.status, 'success', et.error);
  const lastInv = fakeMore.parasut.bodies.filter(([r]) => r === '/sales_invoices').at(-1)[1].data;
  assert.deepEqual(lastInv.relationships.details.data[0].attributes, { quantity: 1, unit_price: 374.9167, vat_rate: 20, description: 'Seramik Kupa' });
  assert.equal(lastInv.attributes.description, 'Trendyol sipariş 10560000001');
  assert.equal(fakeMisc.pushes.at(-1).message, '10560000001 · Ayşe Yılmaz · 449.9 TL');
  await sleep(Math.max(0, 4500 - 0));
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  assert.equal(items.length, 1, 'yalnız yeni sipariş akışı başlatmalı');
  const x = outOf(await waitExec(items[0].id), 'son')[0]; assert.deepEqual([x.siparisNo, x.musteri, x.tutar], ['10562', 'Mert Kaya', 120]);
});

test('JWT, iki adımlı kod (TOTP), ağ kontrolü (site, SSL, port) ve Ollama (sahte API)', async () => {
  const B0 = `http://127.0.0.1:${fakeClaude.port}`;
  const jw = await api('POST', '/api/credentials', { type: 'jwtAuth', name: 'jw', data: { algorithm: 'HS256', secret: 'cok-gizli' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'jwtAuth', id: jw.id, data: { algorithm: 'HS256' } })).message, /imzalandı ve doğrulandı/);
  const tp = await api('POST', '/api/credentials', { type: 'totpSecret', name: 'tp', data: { secret: 'JBSWY3DPEHPK3PXP', digits: '6', period: '30', algorithm: 'SHA1' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'totpSecret', id: tp.id, data: { digits: '6', period: '30', algorithm: 'SHA1' } })).message, /şu anki kod \d{6}/);
  const ol = await api('POST', '/api/credentials', { type: 'ollamaApi', name: 'ol', data: { url: `${B0}/ollama` } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'ollamaApi', id: ol.id, data: { url: `${B0}/ollama` } })).message, 'Bağlanıldı; modeller: llama3.2:latest');
  const closed = net.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const closedPort = closed.address().port; await new Promise(r => closed.close(r));
  const w = await api('POST', '/api/workflows', wf('araclar', [
    ['manual', { data: '[{"id":"u1","ad":"Ayşe"}]' }],
    ['jwt', { op: 'sign', credential: jw.id, payload: '{ "sub": "{{ $json.id }}", "ad": "{{ $json.ad }}" }', expires: 60, output: 'jwt' }, { name: 'imzala' }],
    ['jwt', { op: 'verify', credential: jw.id, token: 'Bearer {{ $json.jwt }}', output: 'dogru' }, { name: 'dogrula' }],
    ['jwt', { op: 'verify', credential: jw.id, token: '{{ $json.jwt }}x', output: 'bozuk' }, { name: 'bozuk' }],
    ['jwt', { op: 'decode', token: '{{ $json.jwt }}', output: 'coz' }, { name: 'coz' }],
    ['totp', { op: 'generate', credential: tp.id, output: 'totp' }, { name: 'kod' }],
    ['totp', { op: 'verify', credential: tp.id, code: '{{ $json.totp.kod }}', output: 'kontrol' }, { name: 'kodDogru' }],
    ['totp', { op: 'verify', credential: tp.id, code: '12345', output: 'kontrol2' }, { name: 'kodYanlis' }],
    ['totp', { op: 'newSecret', account: 'ayse@ornek.com', issuer: 'Mağazam', output: 'yeni' }, { name: 'yeniAnahtar' }],
    ['netCheck', { op: 'http', url: `${B0}/urun.html`, expect: 'Kırmızı Kupa', output: 'site' }, { name: 'site' }],
    ['netCheck', { op: 'http', url: `${B0}/es/`, expect: '', output: 'site2' }, { name: 'site2' }],
    ['netCheck', { op: 'ssl', host: 'localhost', port: String(tlsServer.address().port), output: 'ssl' }, { name: 'ssl' }],
    ['netCheck', { op: 'port', host: '127.0.0.1', port: String(fakeMqtt.port), output: 'p1' }, { name: 'p1' }],
    ['netCheck', { op: 'port', host: '127.0.0.1', port: String(closedPort), output: 'p2' }, { name: 'p2' }],
    ['ollama', { credential: ol.id, op: 'chat', model: 'llama3.2', system: 'Kısa cevap ver.', prompt: 'Selam {{ $json.ad }}', temperature: 0.2, output: 'cevap' }, { name: 'sohbet' }],
    ['ollama', { credential: ol.id, op: 'chat', model: 'llama3.2', system: '', prompt: 'Duygu?', json: true, output: 'analiz' }, { name: 'json' }],
    ['ollama', { credential: ol.id, op: 'embed', model: 'llama3.2', prompt: 'kupa', output: 'vektor' }, { name: 'gomme' }],
    ['ollama', { credential: ol.id, op: 'models' }, { name: 'modeller' }],
  ], Array.from({ length: 17 }, (_, i) => [i, i + 1])));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const tok = outOf(e, 'imzala')[0].jwt; assert.match(tok, /^eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[\w-]+\.[\w-]{43}$/);
  const d = outOf(e, 'dogrula')[0].dogru; assert.deepEqual([d.gecerli, d.icerik.sub, d.icerik.ad, d.icerik.exp - d.icerik.iat], [true, 'u1', 'Ayşe', 3600]);
  assert.deepEqual(outOf(e, 'bozuk')[0].bozuk, { gecerli: false, hata: 'İmza geçersiz' });
  assert.equal(outOf(e, 'coz')[0].coz.baslik.alg, 'HS256');
  const k = outOf(e, 'kodDogru')[0]; assert.match(k.totp.kod, /^\d{6}$/); assert.equal(k.kontrol.gecerli, true);
  assert.equal(outOf(e, 'kodYanlis')[0].kontrol2.gecerli, false);
  const yeni = outOf(e, 'yeniAnahtar')[0].yeni; assert.match(yeni.anahtar, /^[A-Z2-7]{32}$/); assert.ok(yeni.adres.startsWith('otpauth://totp/Ma%C4%9Fazam:ayse%40ornek.com?secret='));
  const s = outOf(e, 'site')[0].site; assert.deepEqual([s.acik, s.durumKodu, s.metinVar], [true, 200, true]); assert.ok(s.sureMs >= 0);
  assert.deepEqual([outOf(e, 'site2')[0].site2.acik, outOf(e, 'site2')[0].site2.durumKodu], [false, 401]);
  const ssl = outOf(e, 'ssl')[0].ssl; assert.deepEqual([ssl.gecerli, ssl.konu, ssl.veren, ssl.alanlar, ssl.bitis.slice(0, 10)], [false, 'localhost', '8n8 Test', ['localhost'], '2036-10-19']);
  assert.match(ssl.hata, /SELF_SIGNED/); assert.ok(ssl.kalanGun > 3000);
  assert.equal(outOf(e, 'p1')[0].p1.acik, true); assert.deepEqual([outOf(e, 'p2')[0].p2.acik, outOf(e, 'p2')[0].p2.hata], [false, 'ECONNREFUSED']);
  const so = outOf(e, 'sohbet')[0]; assert.equal(so.cevap, 'Merhaba! "Selam Ayşe" mesajını aldım.'); assert.deepEqual(so.ollama, { model: 'llama3.2', sureMs: 1500, girdiToken: 12, ciktiToken: 8 });
  assert.deepEqual(fakeMore.ollama[0].messages, [{ role: 'system', content: 'Kısa cevap ver.' }, { role: 'user', content: 'Selam Ayşe' }]); assert.equal(fakeMore.ollama[0].options.temperature, 0.2);
  assert.deepEqual(outOf(e, 'json')[0].analiz, { duygu: 'olumlu' }); assert.equal(fakeMore.ollama[1].format, 'json');
  assert.deepEqual(outOf(e, 'gomme')[0].vektor, [0.1, -0.2, 0.3]);
  assert.deepEqual(outOf(e, 'modeller')[0], { ad: 'llama3.2:latest', boyutMB: 1926, degisti: '2026-10-01T10:00:00Z', aile: 'llama', parametre: '3.2B' });
  const g = await api('POST', '/api/workflows', wf('ollama-yok', [['manual', {}], ['ollama', { credential: ol.id, op: 'chat', model: 'qwen3', prompt: 'x' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${g.id}/run`, {})).executionId)).error, /"qwen3" modeli yüklü değil; önce "ollama pull qwen3"/);
});

test('RabbitMQ: kuyruğa ve değişime gönder, kuyruktan al, boşalt; tetikleyici bağlanıp mesajları alır (sahte sunucu)', async () => {
  const data = { host: '127.0.0.1', port: String(fakeAmqp.port), user: 'ali', vhost: '/', secure: 'false' };
  const rc = await api('POST', '/api/credentials', { type: 'rabbitmq', name: 'rmq', data: { ...data, password: 'şifre1' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'rabbitmq', id: rc.id, data })).message, 'Bağlanıldı (vhost /)');
  assert.match((await api('POST', '/api/credentials/test', { type: 'rabbitmq', data: { ...data, password: 'yanlis' } })).message, /girişi başarısız/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'rabbitmq', id: rc.id, data: { ...data, vhost: 'dukkan' } })).message, /"dukkan" sanal sunucusu/);
  // trigger first: declares its queue and binds it to the topic exchange
  const t = await api('POST', '/api/workflows', wf('rmq-tetik', [['rabbitmqTrigger', { credential: rc.id, queue: 'bildirimler', bind: 'olaylar', bindKey: 'siparis.*', max: 50, parse: true, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1000);
  const w = await api('POST', '/api/workflows', wf('rmq', [
    ['manual', { data: '[{"siparisId":1,"tutar":450},{"siparisId":2,"tutar":99}]' }],
    ['rabbitmq', { credential: rc.id, op: 'queue', queue: 'siparisler', message: '', durable: true }, { name: 'kuyruk' }],
    ['rabbitmq', { credential: rc.id, op: 'exchange', exchange: 'olaylar', exchangeType: 'topic', routingKey: 'siparis.yeni', message: 'Sipariş {{ $json.siparisId }} · {{ $json.tutar }} TL', durable: true, headers: [{ key: 'kaynak', value: '8n8' }] }, { name: 'degisim' }],
    ['rabbitmq', { credential: rc.id, op: 'exchange', exchange: 'olaylar', exchangeType: 'topic', routingKey: 'stok.az', message: 'yönlendirilmez', durable: true }, { name: 'baska' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'kuyruk')[0].rabbitmq, { gonderildi: true, anahtar: 'siparisler' });
  const q1 = fakeAmqp.published.filter(x => x.key === 'siparisler');
  assert.deepEqual(q1.map(x => [JSON.parse(x.body).siparisId, x.props.contentType, x.props.deliveryMode]), [[1, 'application/json', 2], [2, 'application/json', 2]]);
  assert.equal(fakeAmqp.queues.get('siparisler').msgs.length, 2);
  const w2 = await api('POST', '/api/workflows', wf('rmq-al', [
    ['manual', {}],
    ['rabbitmq', { credential: rc.id, op: 'get', queue: 'siparisler', max: 1, parse: true }, { name: 'al' }],
    ['rabbitmq', { credential: rc.id, op: 'purge', queue: 'siparisler' }, { name: 'bosalt' }],
  ], [[0, 1], [1, 2]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  const g = outOf(e2, 'al'); assert.equal(g.length, 1); assert.deepEqual([g[0].mesaj, g[0].kuyruk, g[0].yenidenTeslim], [{ siparisId: 1, tutar: 450 }, 'siparisler', false]);
  assert.deepEqual(outOf(e2, 'bosalt'), [{ kuyruk: 'siparisler', silinen: 1 }]);
  const yok = await api('POST', '/api/workflows', wf('rmq-yok', [['manual', {}], ['rabbitmq', { credential: rc.id, op: 'get', queue: 'olmayan', max: 1 }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${yok.id}/run`, {})).executionId)).error, /RabbitMQ: bulunamadı \(no queue 'olmayan'/);
  await sleep(5000);
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  assert.equal(items.length, 2, 'değişime giden iki mesaj tetikleyiciyi çalıştırmalı; stok.az bağlanmadı');
  const got = [];
  for (const x of items) got.push(outOf(await waitExec(x.id), 'son')[0]);
  assert.deepEqual(got.map(x => x.mesaj).sort(), ['Sipariş 1 · 450 TL', 'Sipariş 2 · 99 TL']);
  assert.deepEqual([got[0].degisim, got[0].kuyruk, got[0].basliklar], ['olaylar', 'siparis.yeni', { kaynak: '8n8' }]);
  assert.equal(fakeAmqp.queues.get('bildirimler').msgs.length, 0, 'alınan mesajlar onaylanmalı');
});

test('Veritabanında yeni satır tetikleyicisi (SQLite): ilk kontrol yalnız hatırlar, sonra yeni satırlar gelir', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'sqlite', name: 'tetik-db', data: { file: 'tetik.db' } });
  const kur = await api('POST', '/api/workflows', wf('db-kur', [
    ['manual', {}],
    ['database', { credential: cred.id, op: 'query', sql: 'CREATE TABLE siparis (id INTEGER PRIMARY KEY, musteri TEXT, tutar REAL)', params: '' }, { name: 'a' }],
    ['database', { credential: cred.id, op: 'query', sql: "INSERT INTO siparis (musteri, tutar) VALUES ('Eski', 1)", params: '' }, { name: 'b' }],
  ], [[0, 1], [1, 2]]));
  assert.equal((await waitExec((await api('POST', `/api/workflows/${kur.id}/run`, {})).executionId)).status, 'success');
  const t = await api('POST', '/api/workflows', wf('db-tetik', [['databaseTrigger', { credential: cred.id, table: 'siparis', column: 'id', limit: 100, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1200);
  const ekle = await api('POST', '/api/workflows', wf('db-ekle', [
    ['manual', { data: '[{"musteri":"Ayşe","tutar":120.5},{"musteri":"Can","tutar":80}]' }],
    ['database', { credential: cred.id, op: 'insert', table: 'siparis' }],
  ], [[0, 1]]));
  assert.equal((await waitExec((await api('POST', `/api/workflows/${ekle.id}/run`, {})).executionId)).status, 'success');
  await sleep(5000);
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  assert.equal(items.length, 2, 'yalnız sonradan eklenen iki satır');
  const rows = []; for (const x of items) rows.push(outOf(await waitExec(x.id), 'son')[0]);
  assert.deepEqual(rows.sort((a, b) => a.id - b.id), [{ id: 2, musteri: 'Ayşe', tutar: 120.5 }, { id: 3, musteri: 'Can', tutar: 80 }]);
});

test('Dropbox (OAuth, yükle, listele, indir, taşı, bağlantı, sil) ve OneDrive (yükle, büyük dosya, listele, indir, bağlantı, sil) (sahte API)', async () => {
  const dc = await api('POST', '/api/credentials', { type: 'dropboxOAuth', name: 'DBX', data: { clientId: 'dbx-app', clientSecret: 'dbx-sec' } });
  let r = await fetch(`${B}/oauth/start?cred=${dc.id}`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.pathname, '/dbx-auth'); assert.equal(loc.searchParams.get('token_access_type'), 'offline'); assert.match(loc.searchParams.get('scope'), /files\.content\.write/);
  r = await fetch(`${B}/oauth/callback?code=dkod&state=${loc.searchParams.get('state')}`);
  assert.match(await r.text(), /Bağlandı/);
  assert.equal((await api('GET', `/api/credentials/${dc.id}`)).account, 'can@ornek.com');
  fs.mkdirSync(path.join(DATA, 'dosyalar'), { recursive: true }); fs.writeFileSync(path.join(DATA, 'dosyalar', 'teklif.txt'), 'Teklif: 1.250 TL');
  const w = await api('POST', '/api/workflows', wf('dropbox', [
    ['manual', { data: '[{"dosya":"teklif.txt","ad":"Müşteri teklifi ğüş.txt"}]' }],
    ['dropbox', { credential: dc.id, op: 'upload', source: 'file', file: '{{ $json.dosya }}', path: '/Belgeler/{{ $json.ad }}', overwrite: true }, { name: 'yukle' }],
    ['dropbox', { credential: dc.id, op: 'list', folder: 'Belgeler' }, { name: 'liste' }],
    ['dropbox', { credential: dc.id, op: 'download', path: '{{ $json.yol }}', target: 'indirilen/{{ $json.ad }}' }, { name: 'indir' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e0 = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e0.status, 'success', e0.error);
  const wb = await api('POST', '/api/workflows', wf('dropbox2', [
    ['manual', {}],
    ['dropbox', { credential: dc.id, op: 'move', path: '/Belgeler/fiyat.txt', to: '/Arşiv/fiyat.txt' }, { name: 'tasi' }],
    ['dropbox', { credential: dc.id, op: 'link', path: '/Arşiv/fiyat.txt' }, { name: 'bag' }],
    ['dropbox', { credential: dc.id, op: 'link', path: '/Arşiv/fiyat.txt' }, { name: 'bag2' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e1 = await waitExec((await api('POST', `/api/workflows/${wb.id}/run`, {})).executionId);
  assert.equal(e1.status, 'success', e1.error);
  const e = { nodes: { ...e0.nodes, ...e1.nodes } };
  assert.equal(fakeWork.dbxArgs.path, '/Belgeler/Müşteri teklifi ğüş.txt', 'Türkçe ad ASCII başlıkla doğru gitmeli');
  assert.equal(fakeWork.dbx.get('/Belgeler/Müşteri teklifi ğüş.txt').toString(), 'Teklif: 1.250 TL');
  assert.deepEqual(outOf(e, 'yukle')[0].dropbox.boyut, 16);
  assert.deepEqual(outOf(e, 'liste').map(x => x.ad), ['Müşteri teklifi ğüş.txt', 'fiyat.txt'], JSON.stringify(outOf(e, 'liste')));
  assert.deepEqual(outOf(e, 'indir').map(x => x.dosya), ['indirilen/Müşteri teklifi ğüş.txt', 'indirilen/fiyat.txt']);
  assert.equal(fs.readFileSync(path.join(DATA, 'dosyalar', 'indirilen', 'fiyat.txt'), 'utf8'), 'Fiyat listesi');
  assert.equal(outOf(e, 'tasi')[0].dropbox.yol, '/Arşiv/fiyat.txt');
  assert.equal(outOf(e, 'bag')[0].indirmeBaglantisi, 'https://www.dropbox.com/s/abc/fiyat.txt?dl=1');
  assert.equal(outOf(e, 'bag2')[0].baglanti, 'https://www.dropbox.com/s/abc/fiyat.txt?dl=0', 'bağlantı zaten varsa mevcut bağlantı dönmeli');
  const sil = await api('POST', '/api/workflows', wf('dbx-sil', [['manual', {}], ['dropbox', { credential: dc.id, op: 'delete', path: '/Belgeler/yok.txt' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${sil.id}/run`, {})).executionId)).error, /Dropbox \(409\): dosya ya da klasör bulunamadı/);

  // OneDrive with the Microsoft account
  const mc = await api('POST', '/api/credentials', { type: 'microsoftOAuth', name: 'MS-OD', data: { clientId: 'mcid', clientSecret: 'msec', tenant: 'common' } });
  r = await fetch(`${B}/oauth/start?cred=${mc.id}`, { redirect: 'manual' });
  const ml = new URL(r.headers.get('location')); assert.match(ml.searchParams.get('scope'), /Files\.ReadWrite/);
  await fetch(`${B}/oauth/callback?code=mkod&state=${ml.searchParams.get('state')}`);
  const big = Buffer.alloc(5 * 1048576 + 123, 7); fs.writeFileSync(path.join(DATA, 'dosyalar', 'buyuk.bin'), big);
  const w2 = await api('POST', '/api/workflows', wf('onedrive', [
    ['manual', { data: '[{"dosya":"teklif.txt","ad":"teklif.txt"},{"dosya":"buyuk.bin","ad":"büyük.bin"}]' }],
    ['onedrive', { credential: mc.id, op: 'upload', source: 'file', file: '{{ $json.dosya }}', path: 'Belgeler/{{ $json.ad }}' }, { name: 'yukle' }],
    ['onedrive', { credential: mc.id, op: 'list', folder: 'Belgeler' }, { name: 'liste' }],
    ['onedrive', { credential: mc.id, op: 'download', path: 'Belgeler/{{ $json.ad }}', target: 'od/{{ $json.ad }}' }, { name: 'indir' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e20 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e20.status, 'success', e20.error);
  const w3 = await api('POST', '/api/workflows', wf('onedrive2', [
    ['manual', {}],
    ['onedrive', { credential: mc.id, op: 'link', path: 'Belgeler/teklif.txt', scope: 'organization' }, { name: 'bag' }],
    ['onedrive', { credential: mc.id, op: 'delete', path: 'Belgeler/büyük.bin' }, { name: 'sil' }],
  ], [[0, 1], [1, 2]]));
  const e21 = await waitExec((await api('POST', `/api/workflows/${w3.id}/run`, {})).executionId);
  assert.equal(e21.status, 'success', e21.error);
  const e2 = { nodes: { ...e20.nodes, ...e21.nodes } };
  assert.deepEqual(outOf(e2, 'yukle').map(x => [x.onedrive.ad, x.onedrive.boyut]), [['teklif.txt', 16], ['büyük.bin', big.length]]);
  assert.equal(fakeWork.odSessions.get('s1').parts, 2, '5 MB üstü dosya parça parça yüklenmeli');
  assert.deepEqual(outOf(e2, 'liste').map(x => [x.ad, x.yol]), [['büyük.bin', 'Belgeler/büyük.bin'], ['teklif.txt', 'Belgeler/teklif.txt']].map(([a, y]) => [a, `/${y}`]));
  assert.ok(fs.readFileSync(path.join(DATA, 'dosyalar', 'od', 'büyük.bin')).equals(big));
  assert.equal(outOf(e2, 'bag')[0].baglanti, 'https://1drv.ms/t/Belgeler%2Fteklif.txt');
  assert.equal(fakeWork.od.has('Belgeler/büyük.bin'), false);
});

test('CRM ve iş takibi: Pipedrive, Asana, ClickUp, Zendesk (+tetikleyici); DeepL çeviri (sahte API)', async () => {
  const mk = async (type, data, test, msg) => { const c = await api('POST', '/api/credentials', { type, name: type, data }); assert.match((await api('POST', '/api/credentials/test', { type, id: c.id, data: test })).message, msg); return c.id; };
  const pd = await mk('pipedriveApi', { token: 'pd-key', domain: '' }, { domain: '' }, /Bağlanıldı: Can \(Dükkan A\.Ş\.\)/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'pipedriveApi', data: { token: 'x' } })).message, /API anahtarı geçersiz/);
  const as = await mk('asanaApi', { token: 'as-key' }, {}, /Bağlanıldı: Can; çalışma alanları: Dükkan/);
  const cu = await mk('clickupApi', { token: 'pk_cu' }, {}, /Bağlanıldı: can/);
  const dl = await mk('deeplApi', { key: 'dl-key:fx' }, {}, /12\.345 \/ 500\.000 karakter/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'deeplApi', data: { key: 'yanlis' } })).message, /DeepL \(403\): API anahtarı geçersiz/);
  const zd = await mk('zendeskApi', { subdomain: 'dukkan', email: 'can@ornek.com', token: 'zd-key' }, { subdomain: 'dukkan', email: 'can@ornek.com' }, /Bağlanıldı: Can \(admin\)/);
  const w = await api('POST', '/api/workflows', wf('crm', [
    ['manual', { data: '[{"ad":"Mevcut Kişi","eposta":"mevcut@ornek.com","tutar":"12.500,75"},{"ad":"Ali Veli","eposta":"ali@ornek.com","telefon":"05321112233","tutar":"300"}]' }],
    ['pipedrive', { credential: pd, op: 'person', name: '{{ $json.ad }}', email: '{{ $json.eposta }}', phone: '{{ $json.telefon }}' }, { name: 'kisi' }],
    ['pipedrive', { credential: pd, op: 'deal', title: '{{ $json.ad }} - teklif', value: '{{ $json.tutar }}', currency: 'TRY', personId: '{{ $json.kisiId }}' }, { name: 'firsat' }],
    ['pipedrive', { credential: pd, op: 'note', dealId: '{{ $json.firsatId }}', note: 'Teklif gönderildi' }, { name: 'not' }],
    ['pipedrive', { credential: pd, op: 'activity', dealId: '{{ $json.firsatId }}', subject: 'Ara', activityType: 'call', due: '2026-10-25' }, { name: 'akt' }],
    ['pipedrive', { credential: pd, op: 'dealUpdate', dealId: '{{ $json.firsatId }}', status: 'won', stageId: '' }, { name: 'kazan' }],
    ['pipedrive', { credential: pd, op: 'deals', dealStatus: 'won', max: 10 }, { name: 'kazanilan' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'kisi').map(x => [x.kisiId, x.yeniKisi]), [[5, false], [6, true]]);
  const body = k => fakeWork.bodies.filter(([r]) => r === k).map(x => x[1]);
  assert.deepEqual(body('POST /pd/persons')[0], { name: 'Ali Veli', email: [{ value: 'ali@ornek.com', primary: true }], phone: [{ value: '05321112233', primary: true }] });
  assert.deepEqual(body('POST /pd/deals').map(b => [b.title, b.value, b.person_id]), [['Mevcut Kişi - teklif', 12500.75, 5], ['Ali Veli - teklif', 300, 6]]);
  assert.deepEqual(outOf(e, 'firsat').map(x => [x.firsatId, x.kisi]), [[30, 'Mevcut Kişi'], [31, 'Ali Veli']]);
  assert.deepEqual(body('POST /pd/activities')[0], { subject: 'Ara', type: 'call', due_date: '2026-10-25', deal_id: 30, person_id: 5 });
  assert.deepEqual(outOf(e, 'kazanilan').map(x => [x.firsatId, x.durum]), [[30, 'won'], [31, 'won']]);
  // template: form -> Pipedrive person, deal, note, call tomorrow -> ntfy
  const nt = await api('POST', '/api/credentials', { type: 'ntfyApi', name: 'nt-crm', data: { server: `http://127.0.0.1:${fakeClaude.port}/ntfy`, token: 'tk_ntfy' } });
  const tw = await api('POST', '/api/templates/formCrm', {});
  for (const n of tw.nodes) { if (n.type === 'pipedrive') n.params.credential = pd; if (n.type === 'push') { n.params.ntfyCred = nt.id; n.params.topic = 'crm-x1'; } }
  await api('PUT', `/api/workflows/${tw.id}`, tw);
  const fr = await fetch(`${B}/form-test/teklif-iste`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ad: 'Zeynep Ak', eposta: 'zeynep@ornek.com', telefon: '05551112233', tutar: '45000', mesaj: '20 kişilik ofis için yazılım' }).toString() });
  assert.equal(fr.status, 200);
  await sleep(300);
  const te = await waitExec((await api('GET', `/api/executions?workflowId=${tw.id}`)).items[0].id);
  assert.equal(te.status, 'success', te.error);
  const lastAct = body('POST /pd/activities').at(-1);
  assert.deepEqual([lastAct.subject, lastAct.deal_id, lastAct.person_id, lastAct.due_date], ['Zeynep Ak ile teklif görüşmesi', 32, 7, new Date(Date.now() + 86400000).toISOString().slice(0, 10)]);
  assert.equal(body('POST /pd/notes').at(-1).content, '20 kişilik ofis için yazılım');
  assert.equal(fakeMisc.pushes.at(-1).message, 'Zeynep Ak · 45000 TL · yeni kişi');

  const w2 = await api('POST', '/api/workflows', wf('gorev', [
    ['manual', { data: '[{"konu":"Kargo gecikti","metin":"Siparişim nerede? Çok bekledim."}]' }],
    ['asana', { credential: as, op: 'create', project: 'https://app.asana.com/0/1209999999999999/list', name: '{{ $json.konu }}', notes: 'Müşteri yazdı', due: '2026-10-30', assignee: '' }, { name: 'asana' }],
    ['asana', { credential: as, op: 'comment', task: '{{ $json.adres }}', text: 'Kargoya soruldu' }, { name: 'asanaYorum' }],
    ['asana', { credential: as, op: 'complete', task: '{{ $json.id }}' }, { name: 'asanaBitir' }],
    ['asana', { credential: as, op: 'list', project: '1209999999999999', open: false }, { name: 'asanaListe' }],
    ['clickup', { credential: cu, op: 'create', list: '901', name: 'Kargo gecikti', description: 'x', priority: '2', due: '2026-10-30' }, { name: 'cu' }],
    ['clickup', { credential: cu, op: 'status', task: '{{ $json.id }}', status: 'complete' }, { name: 'cuDurum' }],
    ['clickup', { credential: cu, op: 'status', task: '{{ $json.id }}', status: 'yok-boyle' }, { name: 'cuHata', settings: { continueOnFail: true } }],
    ['deepl', { credential: dl, op: 'translate', text: '{{ $json.metin || "Hello" }}', target: 'EN-US', source: '', formality: 'prefer_more', output: 'ingilizce' }, { name: 'ceviri' }],
    ['deepl', { credential: dl, op: 'usage' }, { name: 'hak' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [0, 8], [8, 9]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual(body('POST /asana/tasks')[0].data, { name: 'Kargo gecikti', notes: 'Müşteri yazdı', projects: ['1209999999999999'], due_on: '2026-10-30' });
  assert.equal(outOf(e2, 'asanaYorum')[0].yorumId, '9001');
  assert.equal(outOf(e2, 'asanaBitir')[0].tamamlandi, true);
  assert.equal(outOf(e2, 'asanaListe').length, 1);
  const cb = body('POST /cu/list/901/task')[0]; assert.deepEqual([cb.priority, new Date(cb.due_date).toISOString(), cb.due_date_time], [2, '2026-10-30T14:00:00.000Z', false]);
  assert.deepEqual([outOf(e2, 'cuDurum')[0].durum, outOf(e2, 'cuDurum')[0].oncelik], ['complete', 'high']);
  assert.match(JSON.stringify(outOf(e2, 'cuHata')), /Status does not exist/);
  assert.deepEqual([outOf(e2, 'ceviri')[0].ingilizce, outOf(e2, 'ceviri')[0].kaynakDil], ['[EN-US/prefer_more] Siparişim nerede? Çok bekledim.', 'TR']);
  assert.deepEqual(outOf(e2, 'hak')[0], { kullanilan: 12345, sinir: 500000, kalan: 487655 });

  // Zendesk: trigger remembers the old ticket, the new one starts the workflow
  const t = await api('POST', '/api/workflows', wf('zd-tetik', [['zendeskTrigger', { credential: zd, every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t.id}`, { active: true });
  await sleep(1200);
  const w3 = await api('POST', '/api/workflows', wf('zd', [
    ['manual', { data: '[{"konu":"İade talebi","mesaj":"Ürünü iade etmek istiyorum","ad":"Ayşe","eposta":"ayse@ornek.com"}]' }],
    ['zendesk', { credential: zd, op: 'create', subject: '{{ $json.konu }}', body: '{{ $json.mesaj }}', name: '{{ $json.ad }}', email: '{{ $json.eposta }}', priority: 'high', tags: 'iade, web' }, { name: 'ac' }],
    ['zendesk', { credential: zd, op: 'update', ticket: '{{ $json.id }}', body: 'İade kodunuz: R-55', public: true, status: 'pending' }, { name: 'yanit' }],
    ['zendesk', { credential: zd, op: 'get', ticket: '{{ $json.id }}' }, { name: 'getir' }],
    ['zendesk', { credential: zd, op: 'search', query: 'status<solved', max: 10 }, { name: 'ara' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4]]));
  const e3 = await waitExec((await api('POST', `/api/workflows/${w3.id}/run`, {})).executionId);
  assert.equal(e3.status, 'success', e3.error);
  assert.deepEqual(body('POST /zd/tickets.json')[0].ticket, { subject: 'İade talebi', comment: { body: 'Ürünü iade etmek istiyorum' }, priority: 'high', requester: { name: 'Ayşe', email: 'ayse@ornek.com' }, tags: ['iade', 'web'] });
  assert.deepEqual(body('PUT /zd/tickets/101.json')[0], { ticket: { comment: { body: 'İade kodunuz: R-55', public: true }, status: 'pending' } });
  const g = outOf(e3, 'getir')[0]; assert.deepEqual([g.id, g.durum, g.oncelik, g.adres], [101, 'pending', 'high', 'https://dukkan.zendesk.com/agent/tickets/101']);
  assert.deepEqual(outOf(e3, 'ara').map(x => x.id), [100, 101]);
  await sleep(4500);
  await api('PUT', `/api/workflows/${t.id}`, { active: false });
  const { items } = await api('GET', `/api/executions?workflowId=${t.id}`);
  assert.equal(items.length, 1, 'yalnız yeni talep');
  assert.equal(outOf(await waitExec(items[0].id), 'son')[0].konu, 'İade talebi');
});

test('Facebook sayfası ve Instagram: paylaş, fotoğraf, Instagram gönderisi, yorumlar ve yanıt (sahte API)', async () => {
  const fb = await api('POST', '/api/credentials', { type: 'metaPage', name: 'fb', data: { pageId: '555', token: 'fb-token', igUserId: '' } });
  assert.equal((await api('POST', '/api/credentials/test', { type: 'metaPage', id: fb.id, data: { pageId: '555', igUserId: '' } })).message, 'Sayfa: Dükkan Sayfası; Instagram hesabı bağlı');
  assert.match((await api('POST', '/api/credentials/test', { type: 'metaPage', data: { pageId: '555', token: 'eski' } })).message, /süresi dolmuş ya da geçersiz/);
  const w = await api('POST', '/api/workflows', wf('meta', [
    ['manual', { data: '[{"metin":"Yeni sezon ürünleri geldi! 🎉","resim":"https://cdn.ornek.com/urun.jpg"}]' }],
    ['facebook', { credential: fb.id, op: 'post', message: '{{ $json.metin }}', link: 'https://magazam.com' }, { name: 'paylas' }],
    ['facebook', { credential: fb.id, op: 'photo', message: '{{ $json.metin }}', image: '{{ $json.resim }}' }, { name: 'foto' }],
    ['facebook', { credential: fb.id, op: 'igPost', message: '{{ $json.metin }} #yenisezon', image: '{{ $json.resim }}' }, { name: 'ig' }],
    ['facebook', { credential: fb.id, op: 'posts', platform: 'facebook', max: 5 }, { name: 'gonderiler' }],
    ['facebook', { credential: fb.id, op: 'comments', postId: '{{ $json.id }}', platform: 'facebook', max: 5 }, { name: 'yorumlar' }],
    ['facebook', { credential: fb.id, op: 'reply', commentId: '{{ $json.id }}', message: 'Merhaba {{ $json.yazan }}, fiyat 450 TL.', platform: 'facebook' }, { name: 'yanit' }],
    ['facebook', { credential: fb.id, op: 'photo', message: 'x', image: 'http://guvensiz.com/a.jpg' }, { name: 'http', settings: { continueOnFail: true } }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [0, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const call = (m, r) => fakeWork.meta.find(([a, b]) => a === m && b === r)?.[2];
  assert.deepEqual([call('POST', '/555/feed').message, call('POST', '/555/feed').link], ['Yeni sezon ürünleri geldi! 🎉', 'https://magazam.com']);
  assert.equal(outOf(e, 'paylas')[0].gonderiId, '555_1001');
  assert.equal(outOf(e, 'foto')[0].gonderiId, '555_1002');
  assert.deepEqual([call('POST', '/1789/media').image_url, call('POST', '/1789/media').caption], ['https://cdn.ornek.com/urun.jpg', 'Yeni sezon ürünleri geldi! 🎉 #yenisezon']);
  assert.deepEqual(call('POST', '/1789/media_publish').creation_id, 'kap1');
  assert.equal(outOf(e, 'ig')[0].gonderiId, 'ig900');
  assert.deepEqual(outOf(e, 'yorumlar').map(x => [x.id, x.metin, x.yazan]), [['cm1', 'Fiyatı nedir?', 'Ali']]);
  assert.equal(call('POST', '/cm1/comments').message, 'Merhaba Ali, fiyat 450 TL.');
  assert.equal(outOf(e, 'yanit')[0].yanitId, 'yanit-cm1');
  assert.match(JSON.stringify(outOf(e, 'http')), /https ile başlamalı/);
});

test('SSH komutu (şifre ve anahtarla, stdin, çıkış kodu, zaman aşımı, parmak izi) ve SFTP (yükle, listele, indir, taşı, sil, klasör) (sahte sunucu)', async () => {
  const base = { host: '127.0.0.1', port: String(fakeSsh.port), user: 'ali', fingerprint: '' };
  const sc = await api('POST', '/api/credentials', { type: 'sshServer', name: 'ssh', data: { ...base, password: 'sifre' } });
  const ok = await api('POST', '/api/credentials/test', { type: 'sshServer', id: sc.id, data: base });
  assert.match(ok.message, /^Bağlanıldı: Linux sunucu1 · parmak izi SHA256:[A-Za-z0-9+/]{43}$/);
  const fp = ok.message.split('parmak izi ')[1];
  assert.match((await api('POST', '/api/credentials/test', { type: 'sshServer', data: { ...base, password: 'yanlis' } })).message, /SSH girişi başarısız/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'sshServer', id: sc.id, data: { ...base, fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).message, /parmak izi kayıtlı olanla aynı değil/);
  const kc = await api('POST', '/api/credentials', { type: 'sshServer', name: 'ssh-anahtar', data: { ...base, password: '', privateKey: sshKeys.client, fingerprint: fp } });
  const w = await api('POST', '/api/workflows', wf('ssh', [
    ['manual', { data: '[{"ad":"yedek"},{"ad":"log"}]' }],
    ['ssh', { credential: kc.id, command: 'tar czf /srv/yedek/{{ $json.ad }}.tgz /var/www', timeout: 10, failOnCode: true, perItem: true }, { name: 'komut' }],
    ['ssh', { credential: sc.id, command: 'cat', input: 'merhaba dünya', timeout: 10, failOnCode: true, perItem: false }, { name: 'girdi' }],
    ['ssh', { credential: sc.id, command: 'exit 3', timeout: 10, failOnCode: false }, { name: 'kod' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  assert.deepEqual(outOf(e, 'komut').map(x => [x.ad, x.cikti, x.kod]), [['yedek', 'çalıştı: tar czf /srv/yedek/yedek.tgz /var/www', 0], ['log', 'çalıştı: tar czf /srv/yedek/log.tgz /var/www', 0]]);
  assert.deepEqual(outOf(e, 'girdi'), [{ cikti: 'MERHABA DÜNYA', hata: '', kod: 0 }]);
  assert.deepEqual(outOf(e, 'kod'), [{ cikti: '', hata: 'disk dolu', kod: 3 }]);
  const w2 = await api('POST', '/api/workflows', wf('ssh-hata', [['manual', {}], ['ssh', { credential: sc.id, command: 'exit 2', timeout: 10, failOnCode: true }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId)).error, /Komut 2 koduyla bitti: disk dolu/);
  const w3 = await api('POST', '/api/workflows', wf('ssh-uzun', [['manual', {}], ['ssh', { credential: sc.id, command: 'sleep 100', timeout: 1, failOnCode: true }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${w3.id}/run`, {})).executionId)).error, /1 saniyede bitmedi/);

  fs.mkdirSync(path.join(DATA, 'dosyalar'), { recursive: true }); const big = Buffer.alloc(300000, 'ş'); fs.writeFileSync(path.join(DATA, 'dosyalar', 'yedek.sql'), big);
  const w4 = await api('POST', '/api/workflows', wf('sftp', [
    ['manual', { data: '[{"dosya":"yedek.sql"}]' }],
    ['sftp', { credential: kc.id, op: 'mkdir', remote: '/srv/gunluk' }, { name: 'klasor' }],
    ['sftp', { credential: kc.id, op: 'upload', file: '{{ $json.dosya }}', remote: '/srv/gunluk/{{ $json.dosya }}' }, { name: 'yukle' }],
    ['sftp', { credential: kc.id, op: 'list', dir: '/srv' }, { name: 'liste' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e4 = await waitExec((await api('POST', `/api/workflows/${w4.id}/run`, {})).executionId);
  assert.equal(e4.status, 'success', e4.error);
  assert.ok(fakeSsh.files.get('/srv/gunluk/yedek.sql').equals(big), 'dosya bozulmadan yüklenmeli');
  assert.deepEqual(outOf(e4, 'yukle')[0].sftp, { yuklendi: '/srv/gunluk/yedek.sql', boyut: big.length });
  assert.deepEqual(outOf(e4, 'liste').map(x => [x.ad, x.tur]), [['gunluk', 'klasor'], ['rapor.txt', 'dosya'], ['yedek', 'klasor']]);
  const w5 = await api('POST', '/api/workflows', wf('sftp2', [
    ['manual', {}],
    ['sftp', { credential: kc.id, op: 'download', remote: '/srv/gunluk/yedek.sql', target: 'indirilen/yedek.sql' }, { name: 'indir' }],
    ['sftp', { credential: kc.id, op: 'rename', remote: '/srv/rapor.txt', to: '/srv/yedek/rapor-eski.txt' }, { name: 'tasi' }],
    ['sftp', { credential: kc.id, op: 'delete', remote: '/srv/gunluk/yedek.sql' }, { name: 'sil' }],
  ], [[0, 1], [1, 2], [2, 3]]));
  const e5 = await waitExec((await api('POST', `/api/workflows/${w5.id}/run`, {})).executionId);
  assert.equal(e5.status, 'success', e5.error);
  assert.ok(fs.readFileSync(path.join(DATA, 'dosyalar', 'indirilen', 'yedek.sql')).equals(big));
  assert.equal(outOf(e5, 'indir')[0].dosya, 'indirilen/yedek.sql');
  assert.ok(fakeSsh.files.has('/srv/yedek/rapor-eski.txt') && !fakeSsh.files.has('/srv/gunluk/yedek.sql'));
  const w6 = await api('POST', '/api/workflows', wf('sftp-yok', [['manual', {}], ['sftp', { credential: kc.id, op: 'download', remote: '/srv/yok.txt' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${w6.id}/run`, {})).executionId)).error, /SFTP: "\/srv\/yok.txt" bulunamadı/);
  // template: nightly backup over SSH, download with SFTP, report to Teams
  const tm = await api('POST', '/api/credentials', { type: 'teamsWebhook', name: 'tm-yedek', data: { url: `http://127.0.0.1:${fakeClaude.port}/teams/hook1` } });
  const tw = await api('POST', '/api/templates/sunucuYedek', {});
  for (const n of tw.nodes) { if (n.type === 'ssh' || n.type === 'sftp') n.params.credential = sc.id; if (n.type === 'teams') n.params.credential = tm.id; }
  await api('PUT', `/api/workflows/${tw.id}`, tw);
  const et = await waitExec((await api('POST', `/api/workflows/${tw.id}/run`, {})).executionId);
  assert.equal(et.status, 'success', et.error);
  const gun = new Date().toISOString().slice(0, 10);
  assert.ok(fs.readFileSync(path.join(DATA, 'dosyalar', 'yedekler', `yedek-${gun}.sql.gz`)).length === 4096);
  assert.equal(fakeSsh.files.has(`/tmp/yedek-${gun}.sql.gz`), false, 'sunucudaki kopya silinmeli');
  assert.deepEqual(fakeMore3.teams.at(-1).attachments[0].content.body.map(b => b.text || b.facts), ['Yedek alındı', `${gun} yedeği bilgisayara indirildi.`, [{ title: 'Boyut', value: '4 KB' }]]);
});

test('OpenAI uyumlu model, Teams, Brevo, Todoist ve NocoDB (sahte API)', async () => {
  const B0 = `http://127.0.0.1:${fakeClaude.port}`;
  const mk = async (type, data, test, msg) => { const c = await api('POST', '/api/credentials', { type, name: type, data }); if (msg) assert.match((await api('POST', '/api/credentials/test', { type, id: c.id, data: test })).message, msg); return c.id; };
  const oa = await mk('openaiCompat', { baseUrl: `${B0}/oai/v1/`, apiKey: 'oai-key', model: 'gpt-4o-mini' }, { baseUrl: `${B0}/oai/v1/`, model: 'gpt-4o-mini' }, /^Bağlanıldı; 2 model$/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'openaiCompat', data: { baseUrl: `${B0}/oai/v1`, apiKey: 'x' } })).message, /Model \(401\): API anahtarı geçersiz/);
  const tm = await mk('teamsWebhook', { url: `${B0}/teams/hook1` });
  const bv = await mk('brevoApi', { apiKey: 'bv-key' }, {}, /Bağlanıldı: Dükkan A\.Ş\./);
  const td = await mk('todoistApi', { token: 'td-key' }, {}, /Bağlanıldı; 2 proje/);
  const nc = await mk('nocodbApi', { url: `${B0}/noco`, token: 'nc-key' }, { url: `${B0}/noco` }, /1 veritabanı/);
  fs.mkdirSync(path.join(DATA, 'dosyalar'), { recursive: true }); fs.writeFileSync(path.join(DATA, 'dosyalar', 'fatura-1.pdf'), '%PDF-1.4 fatura');
  const w = await api('POST', '/api/workflows', wf('karma', [
    ['manual', { data: '[{"metin":"Kargo çok geç geldi","ad":"Ayşe","eposta":"ayse@ornek.com","telefon":"0532 111 22 33","tutar":450}]' }],
    ['llm', { credential: oa, op: 'chat', model: '', system: 'Duyguyu bul', prompt: '{{ $json.metin }}', json: true, temperature: '0,2', maxTokens: '', output: 'analiz' }, { name: 'model' }],
    ['llm', { credential: oa, op: 'chat', model: 'gpt-4o-mini', system: '', prompt: 'Merhaba {{ $json.ad }}', json: false, temperature: '', maxTokens: '50', output: 'cevap' }, { name: 'model2' }],
    ['llm', { credential: oa, op: 'embed', model: 'text-embedding-3-small', prompt: '{{ $json.metin }}', output: 'vektor' }, { name: 'vektor' }],
    ['teams', { credential: tm, title: '{{ $json.analiz.duygu === "olumsuz" ? "Olumsuz yorum" : "Yorum" }}', text: '{{ $json.ad }}: {{ $json.metin }}', facts: [{ key: 'Puan', value: '{{ $json.analiz.puan }}' }, { key: 'Tutar', value: '{{ $json.tutar }} TL' }], button: 'Siparişi aç', url: 'https://magazam.com/s/1', color: 'attention' }, { name: 'teams' }],
    ['brevo', { credential: bv, op: 'email', senderName: 'Dükkan', senderEmail: 'bilgi@dukkan.com', to: '{{ $json.eposta }}', toName: '{{ $json.ad }}', subject: 'Özür dileriz', html: '<p>Merhaba {{ $json.ad }}</p>', templateId: '', attach: 'fatura-1.pdf' }, { name: 'eposta' }],
    ['brevo', { credential: bv, op: 'contact', email: '{{ $json.eposta }}', attributes: [{ key: 'ad', value: '{{ $json.ad }}' }, { key: 'SMS', value: '' }], lists: '3, 7' }, { name: 'kisi' }],
    ['brevo', { credential: bv, op: 'sms', sender: 'DUKKAN-MAGAZA', phone: '{{ $json.telefon }}', message: 'Siparişiniz yolda' }, { name: 'sms' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const body = k => fakeMore3.bodies.filter(([r]) => r === k).map(x => x[1]);
  const chat = body('POST /oai/v1/chat/completions');
  assert.deepEqual([chat[0].model, chat[0].temperature, chat[0].response_format, chat[0].messages[0]], ['gpt-4o-mini', 0.2, { type: 'json_object' }, { role: 'system', content: 'Duyguyu bul' }]);
  assert.deepEqual([chat[1].max_tokens, chat[1].messages.length], [50, 1]);
  const o = outOf(e, 'vektor')[0];
  assert.deepEqual([o.analiz, o.cevap, o.vektor, o.model, o.token], [{ duygu: 'olumsuz', puan: 2 }, 'Cevap: Merhaba Ayşe', [0.25, -0.5, 0.125], 'gpt-4o-mini-2024', { girdi: 11, cikti: 4 }]);
  const card = fakeMore3.teams.at(-1).attachments[0];
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.deepEqual(card.content.body.map(b => b.text || b.facts), ['Olumsuz yorum', 'Ayşe: Kargo çok geç geldi', [{ title: 'Puan', value: '2' }, { title: 'Tutar', value: '450 TL' }]]);
  assert.equal(card.content.body[0].color, 'attention'); assert.deepEqual(card.content.actions, [{ type: 'Action.OpenUrl', title: 'Siparişi aç', url: 'https://magazam.com/s/1' }]);
  const mail = body('POST /brevo/smtp/email')[0];
  assert.deepEqual([mail.sender, mail.to, mail.subject, mail.htmlContent, mail.attachment], [{ name: 'Dükkan', email: 'bilgi@dukkan.com' }, [{ email: 'ayse@ornek.com', name: 'Ayşe' }], 'Özür dileriz', '<p>Merhaba Ayşe</p>', [{ name: 'fatura-1.pdf', content: Buffer.from('%PDF-1.4 fatura').toString('base64') }]]);
  assert.deepEqual(body('POST /brevo/contacts')[0], { email: 'ayse@ornek.com', attributes: { AD: 'Ayşe' }, listIds: [3, 7], updateEnabled: true });
  assert.deepEqual(outOf(e, 'kisi')[0].brevo, { kisiId: 501, yeni: true });
  const sms = body('POST /brevo/transactionalSMS/sms')[0];
  assert.deepEqual([sms.sender, sms.recipient, sms.content, sms.unicodeEnabled], ['DUKKAN-MAGA', '905321112233', 'Siparişiniz yolda', true]);
  const bad = await api('POST', '/api/workflows', wf('model-yok', [['manual', {}], ['llm', { credential: oa, op: 'chat', model: 'gpt-9', prompt: 'x' }]], [[0, 1]]));
  assert.match((await waitExec((await api('POST', `/api/workflows/${bad.id}/run`, {})).executionId)).error, /Model \(404\): bulunamadı \(The model `gpt-9` does not exist\)/);

  const w2 = await api('POST', '/api/workflows', wf('todoist', [
    ['manual', { data: '[{"konu":"Faturayı kes"},{"konu":"Kargoyu ara"}]' }],
    ['todoist', { credential: td, op: 'create', content: '{{ $json.konu }}', description: 'otomatik', due: 'yarın 10:00', priority: '4', labels: 'iş, acil', project: '' }, { name: 'ekle' }],
  ], [[0, 1]]));
  const e2 = await waitExec((await api('POST', `/api/workflows/${w2.id}/run`, {})).executionId);
  assert.equal(e2.status, 'success', e2.error);
  assert.deepEqual(body('POST /todoist/tasks')[0], { content: 'Faturayı kes', description: 'otomatik', due_string: 'yarın 10:00', due_lang: 'tr', priority: 4, labels: ['iş', 'acil'] });
  assert.deepEqual(outOf(e2, 'ekle').map(x => [x.id, x.tarih, x.oncelik]), [['6X1', '2026-10-23T07:00:00Z', 4], ['6X2', '2026-10-23T07:00:00Z', 4]]);
  const w3 = await api('POST', '/api/workflows', wf('todoist2', [
    ['manual', {}],
    ['todoist', { credential: td, op: 'close', task: '6X1' }, { name: 'bitir' }],
    ['todoist', { credential: td, op: 'comment', task: '6X2', text: 'Arandı' }, { name: 'yorum' }],
    ['todoist', { credential: td, op: 'list', filter: '', project: '' }, { name: 'liste' }],
    ['todoist', { credential: td, op: 'list', filter: 'today', project: '' }, { name: 'bugun' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4]]));
  const e3 = await waitExec((await api('POST', `/api/workflows/${w3.id}/run`, {})).executionId);
  assert.equal(e3.status, 'success', e3.error);
  assert.equal(outOf(e3, 'yorum')[0].yorumId, 'cm9');
  assert.deepEqual(outOf(e3, 'liste').map(x => x.gorev), ['Kargoyu ara']);
  assert.equal(outOf(e3, 'bugun').length, 2);

  const w4 = await api('POST', '/api/workflows', wf('noco', [
    ['manual', { data: '[{"Ad":"Deniz","Durum":"yeni","Tutar":50}]' }],
    ['nocodb', { credential: nc, table: 'mTBL1', op: 'list', where: 'Durum = yeni\nTutar > 100', sort: '-Tutar', limit: 10 }, { name: 'ara' }],
    ['nocodb', { credential: nc, table: 'mTBL1', op: 'list', where: 'Ad ~ ş', sort: '', limit: 10 }, { name: 'icerir' }],
    ['nocodb', { credential: nc, table: 'mTBL1', op: 'create', fields: [] }, { name: 'ekle' }],
    ['nocodb', { credential: nc, table: 'mTBL1', op: 'update', id: '{{ $json.Id }}', fields: [{ key: 'Durum', value: 'işlendi' }] }, { name: 'guncelle' }],
    ['nocodb', { credential: nc, table: 'mTBL1', op: 'delete', id: '2' }, { name: 'sil' }],
  ], [[0, 1], [0, 2], [0, 3], [3, 4], [4, 5]]));
  const e4 = await waitExec((await api('POST', `/api/workflows/${w4.id}/run`, {})).executionId);
  assert.equal(e4.status, 'success', e4.error);
  assert.deepEqual(outOf(e4, 'ara').map(x => x.Ad), ['Ece', 'Ayşe'], 'iki koşul, büyük tutar önce, sayfalı');
  assert.deepEqual(outOf(e4, 'icerir').map(x => x.Ad), ['Ayşe']);
  assert.deepEqual(outOf(e4, 'ekle')[0], { Ad: 'Deniz', Durum: 'yeni', Tutar: 50, Id: 4 });
  assert.equal(fakeMore3.noco.find(x => x.Id === 4).Durum, 'işlendi');
  assert.equal(fakeMore3.noco.some(x => x.Id === 2), false);
});

test('Google Dokümanlar: şablondan sözleşme + PDF, yeni belge, metin ekle, değiştir, oku; Jotform ve Typeform tetikleyicileri (sahte API)', async () => {
  const cred = await api('POST', '/api/credentials', { type: 'googleOAuth', name: 'G-docs', data: { clientId: 'cid', clientSecret: 'sec', services: 'drive' } });
  let r = await fetch(`${B}/oauth/start?cred=${cred.id}`, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location')); fakeG.challenge = loc.searchParams.get('code_challenge');
  r = await fetch(`${B}/oauth/callback?code=kod1&state=${loc.searchParams.get('state')}`); assert.match(await r.text(), /Bağlandı/);
  const w = await api('POST', '/api/workflows', wf('docs', [
    ['manual', { data: '[{"ad":"Ayşe Yılmaz","tutar":"12.500","tarih":"22.10.2026","adres":{"il":"İzmir"}}]' }],
    ['googleDocs', { credential: cred.id, op: 'template', template: 'https://docs.google.com/document/d/docTEMPLATE0000000000000001/edit', title: 'Sözleşme - {{ $json.ad }}', folder: '', values: [{ key: '{{tarih}}', value: '23.10.2026' }], pdf: true, pdfName: 'sozlesmeler/{{ $json.ad }}' }, { name: 'sablon' }],
    ['googleDocs', { credential: cred.id, op: 'append', doc: '{{ $json.belgeLinki }}', text: 'Ek madde: teslim 7 gün.' }, { name: 'ekle' }],
    ['googleDocs', { credential: cred.id, op: 'replace', doc: '{{ $json.belgeId }}', values: [{ key: 'SÖZLEŞME', value: 'HİZMET SÖZLEŞMESİ' }] }, { name: 'degistir' }],
    ['googleDocs', { credential: cred.id, op: 'read', doc: '{{ $json.belgeId }}' }, { name: 'oku' }],
    ['googleDocs', { credential: cred.id, op: 'create', title: 'Toplantı notları', folder: 'kl1', text: 'Gündem' }, { name: 'yeni' }],
  ], [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5]]));
  const e = await waitExec((await api('POST', `/api/workflows/${w.id}/run`, {})).executionId);
  assert.equal(e.status, 'success', e.error);
  const s = outOf(e, 'sablon')[0];
  assert.deepEqual([s.belgeAdi, s.degisenYer, s.pdf.dosya], ['Sözleşme - Ayşe Yılmaz', 3, 'sozlesmeler/Ayşe Yılmaz.pdf']);
  assert.match(fs.readFileSync(path.join(DATA, 'dosyalar', 'sozlesmeler', 'Ayşe Yılmaz.pdf'), 'utf8'), /Müşteri: Ayşe Yılmaz\nTutar: 12\.500 TL\nTarih: 23\.10\.2026/);
  assert.equal(outOf(e, 'degistir')[0].degisenYer, 1);
  assert.equal(outOf(e, 'oku')[0].metin, 'HİZMET SÖZLEŞMESİ\nMüşteri: Ayşe Yılmaz\nTutar: 12.500 TL\nTarih: 23.10.2026\n\nEk madde: teslim 7 gün.Ürün\tAdet');
  const created = fakeMore3.bodies.find(([k]) => k === 'POST /drive/v3/files')[1];
  assert.deepEqual(created, { name: 'Toplantı notları', mimeType: 'application/vnd.google-apps.document', parents: ['kl1'] });
  assert.equal(fakeMore3.docs.get(outOf(e, 'yeni')[0].belgeId).text, 'Gündem');
  assert.equal(fakeMore3.docs.get('docTEMPLATE0000000000000001').text.includes('{{ad}}'), true, 'şablon değişmemeli');

  // Jotform + Typeform triggers: the first check remembers, later submissions start the workflow
  const jf = await api('POST', '/api/credentials', { type: 'jotformApi', name: 'jf', data: { apiKey: 'jf-key', region: 'api' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'jotformApi', id: jf.id, data: { region: 'api' } })).message, /Bağlanıldı: Dükkan \(can@ornek\.com\)/);
  assert.match((await api('POST', '/api/credentials/test', { type: 'jotformApi', data: { apiKey: 'x', region: 'api' } })).message, /API anahtarı geçersiz/);
  const tf = await api('POST', '/api/credentials', { type: 'typeformApi', name: 'tf', data: { token: 'tf-key' } });
  assert.match((await api('POST', '/api/credentials/test', { type: 'typeformApi', id: tf.id, data: {} })).message, /Bağlanıldı: Dükkan/);
  const t1 = await api('POST', '/api/workflows', wf('jf-tetik', [['jotformTrigger', { credential: jf.id, form: 'https://form.jotform.com/251234567890', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  const t2 = await api('POST', '/api/workflows', wf('tf-tetik', [['typeformTrigger', { credential: tf.id, form: 'https://dukkan.typeform.com/to/AbC123', keys: 'title', every: 5, unit: 's' }], ['noop', {}, { name: 'son' }]], [[0, 1]]));
  await api('PUT', `/api/workflows/${t1.id}`, { active: true }); await api('PUT', `/api/workflows/${t2.id}`, { active: true });
  await sleep(1200);
  fakeMore3.jf.push({ id: '5900000000000000002', created_at: '2026-10-22 10:00:00', ip: '1.2.3.4', status: 'ACTIVE', answers: { 3: { name: 'adSoyad', text: 'Ad Soyad', type: 'control_fullname', answer: { first: 'Ayşe', last: 'Yılmaz' } }, 4: { name: 'eposta', text: 'E-posta', type: 'control_email', answer: 'ayse@ornek.com' }, 5: { name: 'telefon', type: 'control_phone', answer: { area: '532', phone: '1112233', full: '(532) 111-2233' } }, 6: { name: 'baslik', type: 'control_head', text: 'Başvuru' }, 7: { name: 'urunler', type: 'control_checkbox', answer: ['Kupa', 'Tabak'] } } });
  fakeMore3.tf.push({ response_id: 'r-new', submitted_at: '2026-10-22T10:00:00Z', hidden: { kaynak: 'instagram' }, calculated: { score: 7 }, answers: [{ field: { id: 'f1', type: 'short_text' }, type: 'text', text: 'Ayşe' }, { field: { id: 'f2', type: 'email' }, type: 'email', email: 'ayse@ornek.com' }, { field: { id: 'f3', type: 'multiple_choice' }, type: 'choice', choice: { label: 'Instagram' } }, { field: { id: 'f4', type: 'multiple_choice' }, type: 'choices', choices: { labels: ['Mutfak', 'Bahçe'] } }] });
  await sleep(4800);
  await api('PUT', `/api/workflows/${t1.id}`, { active: false }); await api('PUT', `/api/workflows/${t2.id}`, { active: false });
  const j = await api('GET', `/api/executions?workflowId=${t1.id}`); assert.equal(j.items.length, 1, 'yalnız yeni Jotform gönderimi');
  const jo = outOf(await waitExec(j.items[0].id), 'son')[0];
  assert.deepEqual(jo, { gonderimId: '5900000000000000002', tarih: '2026-10-22 10:00:00', ip: '1.2.3.4', adSoyad: 'Ayşe Yılmaz', eposta: 'ayse@ornek.com', telefon: '(532) 111-2233', urunler: ['Kupa', 'Tabak'] });
  const t = await api('GET', `/api/executions?workflowId=${t2.id}`); assert.equal(t.items.length, 1, 'yalnız yeni Typeform cevabı');
  const to = outOf(await waitExec(t.items[0].id), 'son')[0];
  assert.deepEqual(to, { cevapId: 'r-new', tarih: '2026-10-22T10:00:00Z', 'Adınız nedir?': 'Ayşe', 'e-posta adresiniz?': 'ayse@ornek.com', 'Bizi nereden duydunuz?': 'Instagram', 'İlgi alanları': ['Mutfak', 'Bahçe'], gizli: { kaynak: 'instagram' }, puan: 7 });
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
  const routes = [[/^\/notion\//, fakeNotion], [/^\/slack\//, fakeSlack], [/^\/(ms-token|graph\/)/, fakeMicrosoft], [/^\/gh\//, fakeGithub], [/^\/at\//, fakeAirtable], [/^\/dc\//, fakeDiscord], [/^\/wa\//, fakeWhatsapp], [/^\/(stripe|shop|woo|trello|jira|hubspot|mc|twilio|netgsm|tcmb|geo|meteo)\//, fakeBizApi], [/^\/(pushover\/|ntfy|iyzico\/|graphql|urun\.html)/, fakeMiscApi], [/^\/(es|supa|odoo|ty|parasut|ollama)(\/|$)/, fakeMoreApi]];
  if (req.url.startsWith('/s3/')) { const ch = []; req.on('data', d => ch.push(d)); return req.on('end', () => fakeS3Api(req, res, Buffer.concat(ch))); }
  if (/^\/(dbx|graph-upload\/|graph\/me\/drive|pd\/|asana\/|cu\/|deepl\/|zd\/|meta\/)/.test(req.url)) { const ch = []; req.on('data', d => ch.push(d)); return req.on('end', () => fakeWorkApi(req, res, Buffer.concat(ch))); }
  if (/^\/(oai|teams|brevo|todoist|jotform|typeform|noco)\/|^\/v1\/documents\/|^\/drive\/v3\/files\/doc\w+\/(copy|export)|^\/drive\/v3\/files\?fields=id,name,webViewLink$/.test(req.url)) { const ch = []; req.on('data', d => ch.push(d)); return req.on('end', () => fakeMore3Api(req, res, Buffer.concat(ch))); }
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

/* fake MongoDB: OP_MSG, SCRAM-SHA-256 login (ali / gizli), in-memory collections, small batches so getMore is used */
const fakeMongo = { port: 0, cols: {}, logins: 0 };
const mongoServer = net.createServer(sock => {
  const B = require('../lib/mongo'); const crypto = require('crypto');
  let buf = Buffer.alloc(0); let authed = false; let sc = null; const cursors = new Map(); let curSeq = 0;
  const salt = crypto.randomBytes(16); const salted = crypto.pbkdf2Sync('gizli', salt, 4096, 32, 'sha256');
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest(); const storedKey = crypto.createHash('sha256').update(hm(salted, 'Client Key')).digest();
  const send = (to, doc) => { const body = B.encode(doc); const h = Buffer.alloc(21); h.writeInt32LE(21 + body.length, 0); h.writeInt32LE(1, 4); h.writeInt32LE(to, 8); h.writeInt32LE(2013, 12); h.writeUInt32LE(0, 16); h[20] = 0; sock.write(Buffer.concat([h, body])); };
  const key = v => (v instanceof B.ObjectId ? `oid:${v}` : v instanceof Date ? `d:${v.getTime()}` : JSON.stringify(v));
  const match = (d, q) => Object.entries(q).every(([k, c]) => {
    const v = d[k];
    if (c && typeof c === 'object' && !(c instanceof B.ObjectId) && !(c instanceof Date) && Object.keys(c).some(x => x.startsWith('$'))) return Object.entries(c).every(([op, x]) => (op === '$gt' ? v > x : op === '$gte' ? v >= x : op === '$lt' ? v < x : op === '$in' ? x.some(y => key(y) === key(v)) : op === '$ne' ? key(v) !== key(x) : false));
    return key(v) === key(c);
  });
  const col = n => (fakeMongo.cols[n] ??= []);
  const batch = (ns, docs) => { const first = docs.slice(0, 2); const rest = docs.slice(2); let id = 0; if (rest.length) { id = 2 ** 40 + ++curSeq; cursors.set(id, rest); } return { cursor: { id: id ? BigInt(id) : 0, ns, firstBatch: first }, ok: 1 }; };
  const handle = cmd => {
    const name = Object.keys(cmd)[0]; const db = cmd.$db;
    if (/^(hello|isMaster|ismaster)$/.test(name)) return { isWritablePrimary: true, ismaster: true, helloOk: true, maxWireVersion: 21, minWireVersion: 0, maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000, localTime: new Date(), logicalSessionTimeoutMinutes: 30, connectionId: 1, ok: 1 };
    if (name === 'saslStart') {
      if (cmd.mechanism !== 'SCRAM-SHA-256') return { ok: 0, errmsg: `Unsupported mechanism ${cmd.mechanism}`, code: 334 };
      const first = Buffer.from(cmd.payload).toString(); const bare = first.replace(/^n,,/, ''); const a = Object.fromEntries(bare.split(',').map(x => [x[0], x.slice(2)]));
      const serverFirst = `r=${a.r}${crypto.randomBytes(12).toString('base64')},s=${salt.toString('base64')},i=4096`;
      sc = { user: a.n, bare, serverFirst }; return { conversationId: 1, done: false, payload: Buffer.from(serverFirst), ok: 1 };
    }
    if (name === 'saslContinue') {
      const fin = Buffer.from(cmd.payload).toString(); const without = fin.replace(/,p=[^,]*$/, ''); const proof = Buffer.from(fin.match(/,p=([^,]*)$/)[1], 'base64');
      const authMsg = `${sc.bare},${sc.serverFirst},${without}`; const sig = hm(storedKey, authMsg); const clientKey = Buffer.from(proof.map((b, i) => b ^ sig[i]));
      if (sc.user !== 'ali' || !crypto.createHash('sha256').update(clientKey).digest().equals(storedKey)) return { ok: 0, errmsg: 'Authentication failed.', code: 18, codeName: 'AuthenticationFailed' };
      authed = true; fakeMongo.logins++; return { conversationId: 1, done: true, payload: Buffer.from(`v=${hm(hm(salted, 'Server Key'), authMsg).toString('base64')}`), ok: 1 };
    }
    if (/^(ping|endSessions|buildInfo)$/.test(name)) return { ok: 1 };
    if (!authed) return { ok: 0, errmsg: 'command requires authentication', code: 13, codeName: 'Unauthorized' };
    if (name === 'listCollections') return batch(`${db}.$cmd.listCollections`, Object.keys(fakeMongo.cols).map(n => ({ name: n, type: 'collection' })));
    const c = ['insert', 'find', 'count', 'update', 'delete', 'aggregate'].includes(name) ? col(cmd[name]) : null;
    if (name === 'insert') { for (const d of cmd.documents) { if (c.some(x => key(x._id) === key(d._id))) return { n: 0, writeErrors: [{ index: 0, code: 11000, errmsg: 'E11000 duplicate key error' }], ok: 1 }; c.push(d); } return { n: cmd.documents.length, ok: 1 }; }
    if (name === 'find') {
      let docs = c.filter(d => match(d, cmd.filter || {}));
      if (cmd.sort) { const [[f, dir]] = Object.entries(cmd.sort); docs = [...docs].sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * dir); }
      if (cmd.limit) docs = docs.slice(0, cmd.limit);
      if (cmd.projection) docs = docs.map(d => Object.fromEntries(Object.entries(d).filter(([k]) => k === '_id' || cmd.projection[k])));
      return batch(`${db}.${cmd.find}`, docs);
    }
    if (name === 'getMore') { const id = Number(cmd.getMore); const rest = cursors.get(id) || []; const next = rest.splice(0, 2); if (!rest.length) cursors.delete(id); return { cursor: { id: rest.length ? BigInt(id) : 0, ns: `${db}.${cmd.collection}`, nextBatch: next }, ok: 1 }; }
    if (name === 'killCursors') return { cursorsKilled: cmd.cursors, ok: 1 };
    if (name === 'count') return { n: c.filter(d => match(d, cmd.query || {})).length, ok: 1 };
    if (name === 'update') {
      let n = 0, nModified = 0; const upserted = [];
      cmd.updates.forEach((u, i) => {
        const hits = c.filter(d => match(d, u.q)).slice(0, u.multi ? undefined : 1);
        const apply = d => { for (const [k, v] of Object.entries(u.u.$set || {})) d[k] = v; for (const [k, v] of Object.entries(u.u.$inc || {})) d[k] = (d[k] || 0) + v; };
        if (!hits.length && u.upsert) { const d = { _id: new B.ObjectId(), ...Object.fromEntries(Object.entries(u.q).filter(([, v]) => typeof v !== 'object')) }; apply(d); c.push(d); upserted.push({ index: i, _id: d._id }); n++; }
        for (const d of hits) { n++; nModified++; apply(d); }
      });
      return { n, nModified, ...(upserted.length ? { upserted } : {}), ok: 1 };
    }
    if (name === 'delete') { let n = 0; for (const d of cmd.deletes) { const hits = c.filter(x => match(x, d.q)).slice(0, d.limit ? 1 : undefined); n += hits.length; fakeMongo.cols[cmd.delete] = col(cmd.delete).filter(x => !hits.includes(x)); } return { n, ok: 1 }; }
    if (name === 'aggregate') {
      let docs = c;
      for (const st of cmd.pipeline) {
        if (st.$match) docs = docs.filter(d => match(d, st.$match));
        if (st.$group) { const g = new Map(); const f = String(st.$group._id).replace(/^\$/, ''); for (const d of docs) { const k = d[f]; g.set(k, (g.get(k) || 0) + 1); } const out = Object.keys(st.$group).find(k => k !== '_id'); docs = [...g].map(([k, n]) => ({ _id: k, [out]: n })); }
        if (st.$sort) { const [[f, dir]] = Object.entries(st.$sort); docs = [...docs].sort((a, b) => (a[f] > b[f] ? 1 : -1) * dir); }
      }
      return batch(`${db}.${cmd.aggregate}`, docs);
    }
    return { ok: 0, errmsg: `no such command: '${name}'`, code: 59 };
  };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
      const len = buf.readInt32LE(0); const msg = buf.subarray(0, len); buf = buf.subarray(len);
      const reqId = msg.readInt32LE(4); const op = msg.readInt32LE(12);
      if (op !== 2013) { sock.destroy(); return; }
      let i = 20; let cmd = null; const seqs = {};
      while (i < len) { const kind = msg[i++]; if (kind === 0) { cmd = B.decode(msg, i); i += msg.readInt32LE(i); } else { const sz = msg.readInt32LE(i); const end = i + sz; const z = msg.indexOf(0, i + 4); const ident = msg.toString('utf8', i + 4, z); let j = z + 1; seqs[ident] = []; while (j < end) { seqs[ident].push(B.decode(msg, j)); j += msg.readInt32LE(j); } i = end; } }
      Object.assign(cmd, seqs);
      send(reqId, handle(cmd));
    }
  });
  sock.on('error', () => {});
});

/* fake MQTT broker: login ali / gizli, routes publishes to matching subscriptions */
const fakeMqtt = { port: 0, published: [], clients: new Set() };
const mqttServer = net.createServer(sock => {
  const { matches } = require('../lib/mqtt');
  let buf = Buffer.alloc(0); const me = { sock, subs: [] };
  const pkt = (type, flags, body) => { const len = []; let n = body.length; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n); return Buffer.concat([Buffer.from([(type << 4) | flags, ...len]), body]); };
  const s16 = (b, i) => b.toString('utf8', i + 2, i + 2 + b.readUInt16BE(i));
  const enc = t => { const b = Buffer.from(t); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return; let mul = 1, len = 0, i = 1, byte;
      do { if (i >= buf.length) return; byte = buf[i++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
      if (buf.length < i + len) return;
      const type = buf[0] >> 4, flags = buf[0] & 15, b = buf.subarray(i, i + len); buf = buf.subarray(i + len);
      if (type === 1) {
        let p = 2 + b.readUInt16BE(0); p += 1; const f = b[p++]; p += 2; p += 2 + b.readUInt16BE(p);
        const user = f & 0x80 ? s16(b, p) : null; if (f & 0x80) p += 2 + b.readUInt16BE(p); const pass = f & 0x40 ? s16(b, p) : null;
        if (user !== 'ali' || pass !== 'gizli') { sock.end(pkt(2, 0, Buffer.from([0, 5]))); return; }
        fakeMqtt.clients.add(me); sock.write(pkt(2, 0, Buffer.from([0, 0])));
      } else if (type === 8) {
        const id = b.readUInt16BE(0); let p = 2; const granted = [];
        while (p < b.length) { const t = s16(b, p); p += 2 + b.readUInt16BE(p); const q = b[p++]; me.subs.push(t); granted.push(t.startsWith('yasak/') ? 0x80 : q); }
        sock.write(pkt(9, 0, Buffer.concat([Buffer.from([id >> 8, id & 255]), Buffer.from(granted)])));
      } else if (type === 3) {
        const qos = (flags >> 1) & 3; const topic = s16(b, 0); let p = 2 + b.readUInt16BE(0); let id = 0; if (qos) { id = b.readUInt16BE(p); p += 2; }
        const payload = b.subarray(p).toString(); fakeMqtt.published.push({ topic, payload, qos, retain: !!(flags & 1) });
        if (qos === 1) sock.write(pkt(4, 0, Buffer.from([id >> 8, id & 255])));
        for (const c of fakeMqtt.clients) if (c.subs.some(s => matches(s, topic))) c.sock.write(pkt(3, 0, Buffer.concat([enc(topic), Buffer.from(payload)])));
      } else if (type === 12) sock.write(Buffer.from([0xd0, 0]));
      else if (type === 14) sock.end();
    }
  });
  sock.on('close', () => fakeMqtt.clients.delete(me)); sock.on('error', () => {});
});

/* fake RabbitMQ (AMQP 0-9-1): one vhost "/", user ali / şifre1, queues, topic/direct/fanout exchanges, publisher confirms, basic.get with ack */
const fakeAmqp = { port: 0, queues: new Map(), exchanges: new Map(), published: [], logins: 0 };
const amqpServer = net.createServer(sock => {
  const { table, Reader, encodeProps, decodeProps } = require('../lib/amqp');
  const u8 = n => Buffer.from([n]); const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }; const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const ss = s => { const b = Buffer.from(s); return Buffer.concat([u8(b.length), b]); }; const ls = s => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };
  const frame = (type, ch, p) => Buffer.concat([u8(type), u16(ch), u32(p.length), p, u8(0xce)]);
  const method = (ch, cls, mth, args = Buffer.alloc(0)) => sock.write(frame(1, ch, Buffer.concat([u16(cls), u16(mth), args])));
  const closeCh = (code, text) => method(1, 20, 40, Buffer.concat([u16(code), ss(text), u16(0), u16(0)]));
  const topic = (pat, key) => new RegExp(`^${pat.split('.').map(w => w === '#' ? '.*' : w === '*' ? '[^.]+' : w.replace(/[^\w]/g, '\\$&')).join('\\.')}$`).test(key);
  let buf = Buffer.alloc(0); let hdr = false; let pub = null; let confirm = false; let seq = 0; let tag = 0; const unacked = new Map();
  method(0, 10, 10, Buffer.concat([u8(0), u8(9), table({ product: 'FakeRabbit' }), ls('PLAIN AMQPLAIN'), ls('en_US')]));
  const route = (ex, key, props, body) => {
    fakeAmqp.published.push({ ex, key, props, body: body.toString() });
    const targets = ex === '' ? [key] : (fakeAmqp.exchanges.get(ex)?.binds || []).filter(b => { const t = fakeAmqp.exchanges.get(ex).type; return t === 'fanout' || (t === 'topic' ? topic(b.key, key) : b.key === key); }).map(b => b.q);
    for (const q of targets) fakeAmqp.queues.get(q)?.msgs.push({ ex, key, props, body, redelivered: false });
  };
  const onMethod = (cls, mth, r) => {
    if (cls === 10 && mth === 11) {
      r.table(); r.shortstr(); const [, user, pass] = r.longstr().toString().split('\0');
      if (user !== 'ali' || pass !== 'şifre1') { method(0, 10, 50, Buffer.concat([u16(403), ss('ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN'), u16(0), u16(0)])); return sock.end(); }
      fakeAmqp.logins++; method(0, 10, 30, Buffer.concat([u16(2047), u32(131072), u16(60)]));
    } else if (cls === 10 && mth === 40) {
      const vh = r.shortstr(); if (vh !== '/') { method(0, 10, 50, Buffer.concat([u16(530), ss(`NOT_ALLOWED - vhost ${vh} not found`), u16(0), u16(0)])); return sock.end(); }
      method(0, 10, 41, ss(''));
    } else if (cls === 20 && mth === 10) method(1, 20, 11, ls(''));
    else if (cls === 85 && mth === 10) { confirm = true; method(1, 85, 11); }
    else if (cls === 50 && mth === 10) {
      r.u16(); const name = r.shortstr(); const f = r.u8(); const q = fakeAmqp.queues.get(name);
      if (f & 1 && !q) return closeCh(404, `NOT_FOUND - no queue '${name}' in vhost '/'`);
      if (q && !(f & 1) && q.durable !== !!(f & 2)) return closeCh(406, `PRECONDITION_FAILED - inequivalent arg 'durable' for queue '${name}' in vhost '/'`);
      if (!q) fakeAmqp.queues.set(name, { durable: !!(f & 2), msgs: [] });
      method(1, 50, 11, Buffer.concat([ss(name), u32(fakeAmqp.queues.get(name).msgs.length), u32(0)]));
    } else if (cls === 40 && mth === 10) { r.u16(); const name = r.shortstr(); const type = r.shortstr(); if (!fakeAmqp.exchanges.has(name)) fakeAmqp.exchanges.set(name, { type, binds: [] }); method(1, 40, 11); }
    else if (cls === 50 && mth === 20) { r.u16(); const q = r.shortstr(), ex = r.shortstr(), key = r.shortstr(); const x = fakeAmqp.exchanges.get(ex); if (!x.binds.some(b => b.q === q && b.key === key)) x.binds.push({ q, key }); method(1, 50, 21); }
    else if (cls === 50 && mth === 30) { r.u16(); const q = fakeAmqp.queues.get(r.shortstr()); const n = q ? q.msgs.length : 0; if (q) q.msgs = []; method(1, 50, 31, u32(n)); }
    else if (cls === 60 && mth === 40) { r.u16(); pub = { ex: r.shortstr(), key: r.shortstr(), size: null, chunks: [], got: 0 }; }
    else if (cls === 60 && mth === 70) {
      r.u16(); const name = r.shortstr(); const q = fakeAmqp.queues.get(name);
      if (!q) return closeCh(404, `NOT_FOUND - no queue '${name}' in vhost '/'`);
      const m = q.msgs.shift(); if (!m) return method(1, 60, 72, ss(''));
      tag++; unacked.set(tag, { q: name, m });
      method(1, 60, 71, Buffer.concat([u64(tag), u8(m.redelivered ? 1 : 0), ss(m.ex), ss(m.key), u32(q.msgs.length)]));
      sock.write(frame(2, 1, Buffer.concat([u16(60), u16(0), u64(m.body.length), encodeProps(m.props)])));
      if (m.body.length) sock.write(frame(3, 1, m.body));
    } else if (cls === 60 && mth === 80) { const t = Number(r.u64()); const multi = r.u8(); for (const k of [...unacked.keys()]) if (k === t || (multi && k <= t)) unacked.delete(k); }
    else if (cls === 20 && mth === 40) method(1, 20, 41);
    else if (cls === 10 && mth === 50) { method(0, 10, 51); sock.end(); }
  };
  const published = () => { route(pub.ex, pub.key, pub.props, Buffer.concat(pub.chunks)); pub = null; if (confirm) method(1, 60, 80, Buffer.concat([u64(++seq), u8(0)])); };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!hdr) { if (buf.length < 8) return; hdr = true; buf = buf.subarray(8); }
    while (buf.length >= 8) {
      const type = buf[0], size = buf.readUInt32BE(3); if (buf.length < size + 8) return;
      const p = buf.subarray(7, 7 + size); buf = buf.subarray(size + 8);
      if (type === 1) { const r = new Reader(p); onMethod(r.u16(), r.u16(), r); }
      else if (type === 2 && pub) { const r = new Reader(p); r.u16(); r.u16(); pub.size = Number(r.u64()); pub.props = decodeProps(r); if (!pub.size) published(); }
      else if (type === 3 && pub) { pub.chunks.push(Buffer.from(p)); pub.got += p.length; if (pub.got >= pub.size) published(); }
    }
  });
  sock.on('close', () => { for (const { q, m } of [...unacked.values()].reverse()) fakeAmqp.queues.get(q)?.msgs.unshift({ ...m, redelivered: true }); unacked.clear(); });
  sock.on('error', () => {});
});

/* Dropbox, OneDrive (Graph drive), Pipedrive, Asana, ClickUp, DeepL, Zendesk, Facebook / Instagram */
const fakeWork = { dbx: new Map([['/Belgeler/fiyat.txt', Buffer.from('Fiyat listesi')]]), dbxLinks: new Set(), od: new Map(), odSessions: new Map(), bodies: [], pd: { persons: [{ id: 5, name: 'Mevcut Kişi', email: 'mevcut@ornek.com' }], deals: [] }, asana: [], cu: [], zd: [{ id: 100, subject: 'Eski talep', description: 'eski', status: 'open', priority: 'normal', created_at: '2026-10-01T10:00:00Z' }], meta: [] };
function fakeWorkApi(req, res, rawBuf) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const raw = rawBuf.toString();
  const body = (() => { try { return (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || 'null') : Object.fromEntries(new URLSearchParams(raw)); } catch { return {}; } })();
  const rec = () => fakeWork.bodies.push([`${req.method} ${p}`, body]);
  let m;
  // ---- Dropbox
  if (p === '/dbx-token') { const b = Object.fromEntries(new URLSearchParams(raw)); if (b.client_id !== 'dbx-app' || (b.grant_type === 'authorization_code' && b.code !== 'dkod')) return json({ error: 'invalid_grant' }, 400); return json({ access_token: 'dbx-at', refresh_token: 'dbx-rt', expires_in: 14400, token_type: 'bearer' }); }
  if (p.startsWith('/dbx')) {
    if (req.headers.authorization !== 'Bearer dbx-at') return json({ error_summary: 'invalid_access_token/' }, 401);
    const arg = req.headers['dropbox-api-arg'] ? JSON.parse(req.headers['dropbox-api-arg']) : null;
    if (arg && /[^\x20-\x7e]/.test(req.headers['dropbox-api-arg'])) return json({ error_summary: 'header ASCII olmalı' }, 400);
    const nf = () => json({ error_summary: 'path/not_found/..', error: { '.tag': 'path' } }, 409);
    const entry = k => ({ '.tag': 'file', name: k.split('/').pop(), path_display: k, path_lower: k.toLowerCase(), id: `id:${k}`, size: fakeWork.dbx.get(k).length, server_modified: '2026-10-22T10:00:00Z' });
    if (p === '/dbxc/2/files/upload') { fakeWork.dbxArgs = arg; if (arg.mode !== 'overwrite' && fakeWork.dbx.has(arg.path)) return json({ error_summary: 'path/conflict/file/' }, 409); fakeWork.dbx.set(arg.path, rawBuf); return json({ ...entry(arg.path), '.tag': undefined }); }
    if (p === '/dbxc/2/files/download') { if (!fakeWork.dbx.has(arg.path)) return nf(); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(fakeWork.dbx.get(arg.path)); }
    rec();
    if (p === '/dbx/2/users/get_current_account') return json({ email: 'can@ornek.com', name: { display_name: 'Can' } });
    if (p === '/dbx/2/files/list_folder') { const all = [...fakeWork.dbx.keys()].filter(k => k.startsWith(`${body.path}/`)).sort(); return json({ entries: all.slice(0, 1).map(entry), cursor: 'c2', has_more: all.length > 1 }); }
    if (p === '/dbx/2/files/list_folder/continue') { const all = [...fakeWork.dbx.keys()].sort().filter(k => k.startsWith('/Belgeler/')); return json({ entries: all.slice(1).map(entry), cursor: 'c3', has_more: false }); }
    if (p === '/dbx/2/files/move_v2') { if (!fakeWork.dbx.has(body.from_path)) return nf(); fakeWork.dbx.set(body.to_path, fakeWork.dbx.get(body.from_path)); fakeWork.dbx.delete(body.from_path); return json({ metadata: entry(body.to_path) }); }
    if (p === '/dbx/2/files/delete_v2') { if (!fakeWork.dbx.has(body.path)) return nf(); fakeWork.dbx.delete(body.path); return json({ metadata: { name: 'x' } }); }
    if (p === '/dbx/2/sharing/create_shared_link_with_settings') { if (fakeWork.dbxLinks.has(body.path)) return json({ error_summary: 'shared_link_already_exists/metadata/..' }, 409); fakeWork.dbxLinks.add(body.path); return json({ url: `https://www.dropbox.com/s/abc/${encodeURIComponent(body.path.split('/').pop())}?dl=0` }); }
    if (p === '/dbx/2/sharing/list_shared_links') return json({ links: [{ url: `https://www.dropbox.com/s/abc/${encodeURIComponent(body.path.split('/').pop())}?dl=0` }] });
    return json({ error_summary: 'yok' }, 404);
  }
  // ---- OneDrive
  if ((m = p.match(/^\/graph-upload\/(\w+)$/))) {
    const s = fakeWork.odSessions.get(m[1]); const [, a, b, total] = req.headers['content-range'].match(/bytes (\d+)-(\d+)\/(\d+)/).map(Number);
    if (a !== s.got || rawBuf.length !== b - a + 1 || (rawBuf.length % 327680 && b + 1 !== total)) return json({ error: { message: 'parça hatalı' } }, 400);
    s.chunks.push(rawBuf); s.got += rawBuf.length; s.parts++;
    if (s.got < total) return json({ nextExpectedRanges: [`${s.got}-`] }, 202);
    fakeWork.od.set(s.path, Buffer.concat(s.chunks)); return json({ id: 'OD-big', name: s.path.split('/').pop(), size: s.got, parentReference: { path: `/drive/root:/${s.path.split('/').slice(0, -1).join('/')}` }, file: {} }, 201);
  }
  if (p.startsWith('/graph/me/drive')) {
    if (req.headers.authorization !== 'Bearer ms-at') return json({ error: { message: 'unauthorized' } }, 401);
    const it = k => ({ id: `OD-${k}`, name: k.split('/').pop(), size: fakeWork.od.get(k).length, lastModifiedDateTime: '2026-10-22T10:00:00Z', webUrl: `https://onedrive.live.com/${k}`, parentReference: { path: `/drive/root:/${k.split('/').slice(0, -1).join('/')}` }, file: {} });
    const q = decodeURIComponent(p.replace(/^\/graph\/me\/drive\/root/, ''));
    if ((m = q.match(/^:\/(.+):\/content$/))) {
      if (req.method === 'PUT') { fakeWork.od.set(m[1], rawBuf); return json(it(m[1]), 201); }
      if (!fakeWork.od.has(m[1])) return json({ error: { message: 'itemNotFound' } }, 404);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(fakeWork.od.get(m[1]));
    }
    if ((m = q.match(/^:\/(.+):\/createUploadSession$/))) { const id = `s${fakeWork.odSessions.size + 1}`; fakeWork.odSessions.set(id, { path: m[1], chunks: [], got: 0, parts: 0 }); return json({ uploadUrl: `http://127.0.0.1:${fakeClaude.port}/graph-upload/${id}` }); }
    if ((m = q.match(/^:\/(.+):\/createLink$/))) { rec(); return json({ link: { webUrl: `https://1drv.ms/t/${encodeURIComponent(m[1])}`, scope: body.scope } }); }
    if ((m = q.match(/^(?::\/(.+):)?\/children$/))) {
      const dir = m[1] ? `${m[1]}/` : ''; const all = [...fakeWork.od.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).sort();
      if (u.searchParams.get('skip')) return json({ value: all.slice(1).map(it) });
      return json({ value: all.slice(0, 1).map(it), ...(all.length > 1 ? { '@odata.nextLink': `http://127.0.0.1:${fakeClaude.port}${p}?skip=1` } : {}) });
    }
    if ((m = q.match(/^:\/(.+):$/)) && req.method === 'DELETE') { if (!fakeWork.od.delete(m[1])) return json({ error: { message: 'itemNotFound' } }, 404); res.writeHead(204); return res.end(); }
    return json({ error: { message: 'yok ' + q } }, 400);
  }
  // ---- Pipedrive
  if (p.startsWith('/pd/')) {
    if (u.searchParams.get('api_token') !== 'pd-key') return json({ success: false, error: 'unauthorized access', errorCode: 401 }, 401);
    rec(); const d = fakeWork.pd; const r = p.slice(3);
    const deal = x => ({ ...x, person_id: x.person_id ? { value: x.person_id, name: d.persons.find(y => y.id === x.person_id)?.name } : null });
    if (r === '/users/me') return json({ success: true, data: { name: 'Can', company_name: 'Dükkan A.Ş.' } });
    if (r === '/persons/search') { const f = d.persons.filter(x => x.email === u.searchParams.get('term')); return json({ success: true, data: { items: f.map(item => ({ result_score: 1, item })) } }); }
    if (r === '/persons' && req.method === 'POST') { const x = { id: 6 + d.persons.length - 1, name: body.name, email: body.email?.[0]?.value, phone: body.phone?.[0]?.value }; d.persons.push(x); return json({ success: true, data: x }, 201); }
    if (r === '/deals' && req.method === 'POST') { const x = { id: 30 + d.deals.length, title: body.title, value: body.value, currency: body.currency, status: 'open', stage_id: 1, person_id: body.person_id, add_time: '2026-10-22 10:00:00' }; d.deals.push(x); return json({ success: true, data: deal(x) }, 201); }
    if ((m = r.match(/^\/deals\/(\d+)$/))) { const x = d.deals.find(y => y.id === Number(m[1])); if (!x) return json({ success: false, error: 'Deal not found' }, 404); Object.assign(x, body); return json({ success: true, data: deal(x) }); }
    if (r === '/deals') return json({ success: true, data: d.deals.filter(x => u.searchParams.get('status') === 'all_not_deleted' || x.status === u.searchParams.get('status')).map(deal) });
    if (r === '/notes') return json({ success: true, data: { id: 70 } }, 201);
    if (r === '/activities') return json({ success: true, data: { id: 80 } }, 201);
    return json({ success: false, error: 'yok' }, 404);
  }
  // ---- Asana
  if (p.startsWith('/asana/')) {
    if (req.headers.authorization !== 'Bearer as-key') return json({ errors: [{ message: 'Not Authorized' }] }, 401);
    rec(); const r = p.slice(6); const task = x => ({ gid: x.gid, name: x.name, completed: !!x.completed, due_on: x.due_on || null, assignee: x.assignee ? { name: x.assignee } : null, permalink_url: `https://app.asana.com/0/0/${x.gid}` });
    if (r === '/users/me') return json({ data: { name: 'Can', workspaces: [{ gid: '1', name: 'Dükkan' }] } });
    if (r === '/tasks' && req.method === 'POST') { const x = { gid: String(1200000000000001 + fakeWork.asana.length), ...body.data }; fakeWork.asana.push(x); return json({ data: task(x) }, 201); }
    if ((m = r.match(/^\/tasks\/(\d+)$/))) { const x = fakeWork.asana.find(y => y.gid === m[1]); if (!x) return json({ errors: [{ message: 'task: Not a recognized ID' }] }, 404); Object.assign(x, body.data); return json({ data: task(x) }); }
    if ((m = r.match(/^\/tasks\/(\d+)\/stories$/))) return json({ data: { gid: '9001', text: body.data.text } }, 201);
    if ((m = r.match(/^\/projects\/(\d+)\/tasks$/))) { const all = fakeWork.asana.filter(x => !u.searchParams.has('completed_since') || !x.completed); const off = u.searchParams.get('offset'); return json({ data: (off ? all.slice(1) : all.slice(0, 1)).map(task), next_page: !off && all.length > 1 ? { offset: 'o2' } : null }); }
    return json({ errors: [{ message: 'yok' }] }, 404);
  }
  // ---- ClickUp
  if (p.startsWith('/cu/')) {
    if (req.headers.authorization !== 'pk_cu') return json({ err: 'Token invalid', ECODE: 'OAUTH_025' }, 401);
    rec(); const r = p.slice(3); const task = x => ({ id: x.id, name: x.name, status: { status: x.status }, priority: { priority: { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' }[x.priority] }, due_date: x.due_date ? String(x.due_date) : null, url: `https://app.clickup.com/t/${x.id}` });
    if (r === '/user') return json({ user: { username: 'can', email: 'can@ornek.com' } });
    if ((m = r.match(/^\/list\/(\d+)\/task$/))) { if (req.method === 'GET') return json({ tasks: fakeWork.cu.map(task) }); const x = { id: `86a${fakeWork.cu.length + 1}`, ...body, status: 'to do' }; fakeWork.cu.push(x); return json(task(x)); }
    if ((m = r.match(/^\/task\/(\w+)$/))) { const x = fakeWork.cu.find(y => y.id === m[1]); if (!['to do', 'complete'].includes(body.status)) return json({ err: 'Status does not exist', ECODE: 'CRTSK_001' }, 400); x.status = body.status; return json(task(x)); }
    if ((m = r.match(/^\/task\/(\w+)\/comment$/))) return json({ id: 458, hist_id: 'h1' });
    return json({ err: 'yok' }, 404);
  }
  // ---- DeepL
  if (p.startsWith('/deepl/')) {
    if (req.headers.authorization !== 'DeepL-Auth-Key dl-key:fx') return json({ message: 'Forbidden' }, 403);
    rec();
    if (p === '/deepl/v2/usage') return json({ character_count: 12345, character_limit: 500000 });
    if (p === '/deepl/v2/translate') return json({ translations: body.text.map(t => ({ detected_source_language: /[ğışçöü]/i.test(t) ? 'TR' : 'EN', text: `[${body.target_lang}${body.formality ? `/${body.formality}` : ''}] ${t}` })) });
    return json({ message: 'yok' }, 404);
  }
  // ---- Zendesk
  if (p.startsWith('/zd/')) {
    if (req.headers.authorization !== `Basic ${Buffer.from('can@ornek.com/token:zd-key').toString('base64')}`) return json({ error: 'Couldn\'t authenticate you' }, 401);
    rec(); const r = p.slice(3); const t = x => ({ ...x, url: `https://dukkan.zendesk.com/api/v2/tickets/${x.id}.json` });
    if (r === '/users/me.json') return json({ user: { id: 1, name: 'Can', role: 'admin' } });
    if (r === '/tickets.json' && req.method === 'POST') { const x = { id: 100 + fakeWork.zd.length, subject: body.ticket.subject, description: body.ticket.comment.body, status: 'new', priority: body.ticket.priority, tags: body.ticket.tags || [], requester_id: 77, created_at: new Date().toISOString() }; fakeWork.zd.push(x); return json({ ticket: t(x) }, 201); }
    if (r === '/tickets.json') return json({ tickets: [...fakeWork.zd].reverse().map(t) });
    if ((m = r.match(/^\/tickets\/(\d+)\.json$/))) { const x = fakeWork.zd.find(y => y.id === Number(m[1])); if (!x) return json({ error: 'RecordNotFound', description: 'Not found' }, 404); if (req.method === 'PUT') { if (body.ticket.status) x.status = body.ticket.status; (x.comments ??= []).push(body.ticket.comment); } return json({ ticket: t(x) }); }
    if (r === '/search.json') { const q = u.searchParams.get('query'); return json({ results: fakeWork.zd.filter(x => q.startsWith('type:ticket ') && (q.includes('status<solved') ? x.status !== 'solved' : true)).map(t) }); }
    return json({ error: 'yok' }, 404);
  }
  // ---- Meta
  if (p.startsWith('/meta/')) {
    const tok = u.searchParams.get('access_token') || body.access_token;
    if (tok !== 'fb-token') return json({ error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } }, 400);
    const r = p.slice(5); fakeWork.meta.push([req.method, r, req.method === 'GET' ? Object.fromEntries(u.searchParams) : body]);
    if (r === '/555') return json({ id: '555', name: 'Dükkan Sayfası', instagram_business_account: { id: '1789' } });
    if (r === '/555/feed') return json({ id: '555_1001' });
    if (r === '/555/photos') return json({ id: 'ph1', post_id: '555_1002' });
    if (r === '/555/posts') return json({ data: [{ id: '555_1001', message: 'Merhaba', created_time: '2026-10-22T10:00:00+0000', permalink_url: 'https://facebook.com/555_1001' }] });
    if (r === '/1789/media' && req.method === 'POST') return json({ id: 'kap1' });
    if (r === '/kap1') return json({ status_code: 'FINISHED', id: 'kap1' });
    if (r === '/1789/media_publish') return json({ id: 'ig900' });
    if (r === '/555_1001/comments' && req.method === 'GET') return json({ data: [{ id: 'cm1', message: 'Fiyatı nedir?', from: { name: 'Ali' }, created_time: '2026-10-22T11:00:00+0000' }] });
    if ((m = r.match(/^\/(\w+)\/(comments|replies)$/))) return json({ id: `yanit-${m[1]}` });
    return json({ error: { message: 'Unsupported request ' + r, code: 100 } }, 400);
  }
  return json({ error: 'yok' }, 404);
}

/* fake SSH / SFTP server (ssh2): user ali with password "sifre" or the test RSA key; in-memory files */
const sshKeys = (() => { const k = () => require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey; return { host: k(), client: k() }; })();
const fakeSsh = { port: 0, cmds: [], files: new Map([['/srv/rapor.txt', Buffer.from('günlük rapor')]]), dirs: new Set(['/', '/srv', '/srv/yedek']), logins: 0 };
const sshServer = (() => {
  const { Server, utils } = require('ssh2');
  const allowed = utils.parseKey(sshKeys.client);
  const { STATUS_CODE: S, OPEN_MODE: O } = utils.sftp;
  return new Server({ hostKeys: [sshKeys.host] }, client => {
    client.on('authentication', ctx => {
      if (ctx.username !== 'ali') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'sifre') { fakeSsh.logins++; return ctx.accept(); }
      if (ctx.method === 'publickey' && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) { fakeSsh.logins++; return ctx.accept(); }
      }
      ctx.reject(['password', 'publickey']);
    }).on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acc, rej, info) => {
        const st = acc(); const cmd = info.command; fakeSsh.cmds.push(cmd);
        if (cmd.startsWith('uname')) { st.write('Linux sunucu1\n'); return st.exit(0), st.end(); }
        if (cmd === 'cat') { const ch = []; st.on('data', d => ch.push(d)); return st.on('end', () => { st.write(Buffer.concat(ch).toString().toUpperCase()); st.exit(0); st.end(); }); }
        if (cmd.startsWith('exit ')) { st.stderr.write('disk dolu\n'); st.exit(Number(cmd.slice(5))); return st.end(); }
        if (cmd.startsWith('sleep')) return; // never ends
        if (cmd.startsWith('mysqldump')) { fakeSsh.dirs.add('/tmp'); fakeSsh.files.set(cmd.match(/> (\S+)$/)[1], Buffer.alloc(4096, 1)); }
        if (cmd.startsWith('rm -f ')) fakeSsh.files.delete(cmd.slice(6));
        st.write(`çalıştı: ${cmd}\n`); st.exit(0); st.end();
      });
      session.on('sftp', acc => {
        const sftp = acc(); const handles = new Map(); let hn = 0;
        const H = v => { const b = Buffer.alloc(4); b.writeUInt32BE(++hn); handles.set(hn, v); return b; };
        const get = b => handles.get(b.readUInt32BE(0));
        const attrs = p => fakeSsh.dirs.has(p) ? { mode: 0o040755, size: 4096, uid: 0, gid: 0, atime: 1761100000, mtime: 1761100000 } : { mode: 0o100644, size: fakeSsh.files.get(p).length, uid: 0, gid: 0, atime: 1761100000, mtime: 1761100000 };
        const exists = p => fakeSsh.dirs.has(p) || fakeSsh.files.has(p);
        sftp.on('OPEN', (id, p, flags) => {
          const parent = path.posix.dirname(p);
          if (flags & O.WRITE) { if (!fakeSsh.dirs.has(parent)) return sftp.status(id, S.NO_SUCH_FILE); fakeSsh.files.set(p, Buffer.alloc(0)); return sftp.handle(id, H({ p, w: true })); }
          if (!fakeSsh.files.has(p)) return sftp.status(id, S.NO_SUCH_FILE);
          sftp.handle(id, H({ p }));
        });
        sftp.on('WRITE', (id, h, off, data) => { const x = get(h); const cur = fakeSsh.files.get(x.p); const n = Buffer.alloc(Math.max(cur.length, off + data.length)); cur.copy(n); data.copy(n, off); fakeSsh.files.set(x.p, n); sftp.status(id, S.OK); });
        sftp.on('READ', (id, h, off, len) => { const b = fakeSsh.files.get(get(h).p); if (off >= b.length) return sftp.status(id, S.EOF); sftp.data(id, b.subarray(off, off + len)); });
        sftp.on('FSTAT', (id, h) => sftp.attrs(id, attrs(get(h).p)));
        sftp.on('FSETSTAT', id => sftp.status(id, S.OK)); sftp.on('SETSTAT', id => sftp.status(id, S.OK));
        sftp.on('CLOSE', (id, h) => { handles.delete(h.readUInt32BE(0)); sftp.status(id, S.OK); });
        for (const ev of ['STAT', 'LSTAT']) sftp.on(ev, (id, p) => (exists(p) ? sftp.attrs(id, attrs(p)) : sftp.status(id, S.NO_SUCH_FILE)));
        sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.resolve('/', p), longname: '', attrs: {} }]));
        sftp.on('OPENDIR', (id, p) => (fakeSsh.dirs.has(p) ? sftp.handle(id, H({ dir: p, done: false })) : sftp.status(id, S.NO_SUCH_FILE)));
        sftp.on('READDIR', (id, h) => {
          const x = get(h); if (x.done) return sftp.status(id, S.EOF); x.done = true;
          const kids = [...fakeSsh.dirs, ...fakeSsh.files.keys()].filter(k => k !== x.dir && path.posix.dirname(k) === x.dir);
          sftp.name(id, kids.map(k => ({ filename: path.posix.basename(k), longname: path.posix.basename(k), attrs: attrs(k) })));
        });
        sftp.on('REMOVE', (id, p) => sftp.status(id, fakeSsh.files.delete(p) ? S.OK : S.NO_SUCH_FILE));
        sftp.on('RENAME', (id, a, b) => { if (!fakeSsh.files.has(a)) return sftp.status(id, S.NO_SUCH_FILE); fakeSsh.files.set(b, fakeSsh.files.get(a)); fakeSsh.files.delete(a); sftp.status(id, S.OK); });
        sftp.on('MKDIR', (id, p) => { if (exists(p)) return sftp.status(id, S.FAILURE); fakeSsh.dirs.add(p); sftp.status(id, S.OK); });
      });
    })).on('error', () => {});
  });
})();

/* OpenAI-compatible model, Teams webhook, Brevo, Todoist, Jotform, Typeform, NocoDB, Google Docs */
const fakeMore3 = { bodies: [], teams: [], docs: new Map([['docTEMPLATE0000000000000001', { title: 'Sözleşme şablonu', text: 'SÖZLEŞME\nMüşteri: {{ad}}\nTutar: {{tutar}} TL\nTarih: {{tarih}}\n' }]]), todo: [], noco: [{ Id: 1, Ad: 'Ayşe', Durum: 'yeni', Tutar: 120 }, { Id: 2, Ad: 'Can', Durum: 'eski', Tutar: 80 }, { Id: 3, Ad: 'Ece', Durum: 'yeni', Tutar: 300 }], jf: [{ id: '5900000000000000001', created_at: '2026-10-22 09:00:00', status: 'ACTIVE', answers: { 3: { name: 'adSoyad', text: 'Ad Soyad', type: 'control_fullname', answer: { first: 'Eski', last: 'Kayıt' } } } }], tf: [{ response_id: 'r-old', submitted_at: '2026-10-22T08:00:00Z', answers: [{ field: { id: 'f1', type: 'short_text' }, type: 'text', text: 'Eski' }] }] };
function fakeMore3Api(req, res, rawBuf) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const raw = rawBuf.toString();
  const body = (() => { try { return JSON.parse(raw || 'null'); } catch { return null; } })();
  const rec = () => fakeMore3.bodies.push([`${req.method} ${p}`, body]);
  let m;
  if (p.startsWith('/oai/')) {
    if (req.headers.authorization !== 'Bearer oai-key') return json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401);
    rec();
    if (p === '/oai/v1/models') return json({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }, { id: 'text-embedding-3-small', owned_by: 'openai' }] });
    if (p === '/oai/v1/embeddings') return json({ data: [{ embedding: [0.25, -0.5, 0.125] }], model: body.model });
    if (p === '/oai/v1/chat/completions') {
      if (!['gpt-4o-mini'].includes(body.model)) return json({ error: { message: `The model \`${body.model}\` does not exist` } }, 404);
      const last = body.messages.at(-1).content;
      const content = body.response_format?.type === 'json_object' ? '```json\n{"duygu":"olumsuz","puan":2}\n```' : `Cevap: ${last}`;
      return json({ id: 'c1', model: 'gpt-4o-mini-2024', choices: [{ index: 0, message: { role: 'assistant', content } }], usage: { prompt_tokens: 11, completion_tokens: 4 } });
    }
  }
  if (p.startsWith('/teams/')) { if (p !== '/teams/hook1') return json({ error: { code: 'NotFound', message: 'not found' } }, 404); fakeMore3.teams.push(body); return json(undefined, 202); }
  if (p.startsWith('/brevo/')) {
    if (req.headers['api-key'] !== 'bv-key') return json({ code: 'unauthorized', message: 'Key not found' }, 401);
    rec(); const r = p.slice(6);
    if (r === '/account') return json({ email: 'can@ornek.com', companyName: 'Dükkan A.Ş.' });
    if (r === '/smtp/email') { if (!body.sender?.email) return json({ code: 'invalid_parameter', message: 'sender is missing' }, 400); return json({ messageId: '<202610@smtp-relay.brevo.com>' }, 201); }
    if (r === '/contacts') return body.email === 'mevcut@ornek.com' ? json(undefined, 204) : json({ id: 501 }, 201);
    if (r === '/transactionalSMS/sms') return json({ reference: 'ab1', messageId: 1511882900176220, smsCount: 1, usedCredits: 0.7, remainingCredits: 100 }, 201);
  }
  if (p.startsWith('/todoist/')) {
    if (req.headers.authorization !== 'Bearer td-key') return json({ error: 'Unauthorized' }, 401);
    rec(); const r = p.slice(8); const T = fakeMore3.todo;
    if (r === '/projects') return json({ results: [{ id: 'p1', name: 'Gelen kutusu' }, { id: 'p2', name: 'İş' }], next_cursor: null });
    if (r === '/tasks' && req.method === 'POST') { const t = { id: `6X${T.length + 1}`, content: body.content, description: body.description || '', priority: body.priority, labels: body.labels || [], project_id: body.project_id || 'p1', checked: false, due: body.due_string ? { string: body.due_string, date: '2026-10-23', datetime: '2026-10-23T07:00:00Z', lang: body.due_lang } : null }; T.push(t); return json(t); }
    if (r === '/tasks') { const all = T.filter(t => !t.checked); const cur = u.searchParams.get('cursor'); return json({ results: cur ? all.slice(1) : all.slice(0, 1), next_cursor: !cur && all.length > 1 ? 'k2' : null }); }
    if (r === '/tasks/filter') return json({ results: u.searchParams.get('query') === 'today' && u.searchParams.get('lang') === 'tr' ? T.filter(t => t.due) : [], next_cursor: null });
    if ((m = r.match(/^\/tasks\/(\w+)\/close$/))) { const t = T.find(x => x.id === m[1]); if (!t) return json({ error: 'Task not found' }, 404); t.checked = true; return json(undefined, 204); }
    if (r === '/comments') return json({ id: 'cm9', content: body.content, task_id: body.task_id });
  }
  if (p.startsWith('/jotform/')) {
    if (u.searchParams.get('apiKey') !== 'jf-key') return json({ responseCode: 401, message: "You're not authorized to use (/user) ", content: '' }, 401);
    const r = p.slice(8);
    if (r === '/user') return json({ responseCode: 200, content: { username: 'dukkan', name: 'Dükkan', email: 'can@ornek.com' } });
    if (r === '/form/251234567890/submissions') return json({ responseCode: 200, content: [...fakeMore3.jf].reverse() });
  }
  if (p.startsWith('/typeform/')) {
    if (req.headers.authorization !== 'Bearer tf-key') return json({ code: 'AUTHENTICATION_FAILED', description: 'Authentication credentials not found' }, 403);
    const r = p.slice(9);
    if (r === '/me') return json({ alias: 'Dükkan', email: 'can@ornek.com' });
    if (r === '/forms/AbC123/responses') return json({ total_items: fakeMore3.tf.length, items: [...fakeMore3.tf].reverse() });
    if (r === '/forms/AbC123') return json({ id: 'AbC123', fields: [{ id: 'f1', ref: 'ad', title: 'Adınız nedir?' }, { id: 'f2', ref: 'eposta', title: '{{field:ad}}, e-posta adresiniz?' }, { id: 'g', ref: 'grup', title: 'Grup', properties: { fields: [{ id: 'f3', ref: 'kanal', title: 'Bizi nereden duydunuz?' }, { id: 'f4', ref: 'ilgi', title: 'İlgi alanları' }] } }] });
  }
  if (p.startsWith('/noco/')) {
    if (req.headers['xc-token'] !== 'nc-key') return json({ msg: 'Invalid token' }, 401);
    rec(); const r = p.slice(5); const N = fakeMore3.noco;
    if (r === '/api/v2/meta/bases/') return json({ list: [{ id: 'p1', title: 'Dükkan' }] });
    if (r === '/api/v2/tables/mTBL1/records') {
      if (req.method === 'GET') {
        let list = [...N]; const w = u.searchParams.get('where');
        if (w) for (const [, f, op, v] of w.matchAll(/\(([^,]+),(\w+),([^)]*)\)/g)) list = list.filter(x => op === 'eq' ? String(x[f]) === v : op === 'gt' ? x[f] > Number(v) : op === 'like' ? String(x[f]).toLowerCase().includes(v.replace(/%/g, '').toLowerCase()) : true);
        if (u.searchParams.get('sort') === '-Tutar') list.sort((a, b) => b.Tutar - a.Tutar);
        const lim = Number(u.searchParams.get('limit')), off = Number(u.searchParams.get('offset'));
        const page = list.slice(off, off + Math.min(lim, 1)); // one row per page, to exercise paging
        return json({ list: page, pageInfo: { totalRows: list.length, isLastPage: off + page.length >= list.length } });
      }
      if (req.method === 'POST') { const x = { Id: N.length + 1, ...body }; N.push(x); return json({ Id: x.Id }); }
      if (req.method === 'PATCH') { const x = N.find(y => y.Id === body.Id); if (!x) return json({ msg: 'Record not found' }, 404); Object.assign(x, body); return json({ Id: x.Id }); }
      if (req.method === 'DELETE') { const i = N.findIndex(y => y.Id === body.Id); if (i < 0) return json({ msg: 'Record not found' }, 404); N.splice(i, 1); return json({ Id: body.Id }); }
    }
    return json({ msg: 'Table not found' }, 404);
  }
  // Google Docs (+ the Drive calls it makes)
  if (/^\/(v1\/documents|drive\/v3\/files)/.test(p)) {
    if (!/^Bearer g-at[12]$/.test(req.headers.authorization || '')) return json({ error: { message: 'Invalid Credentials' } }, 401);
    rec(); const D = fakeMore3.docs;
    if ((m = p.match(/^\/drive\/v3\/files\/(\w+)\/copy$/))) { const src = D.get(m[1]); if (!src) return json({ error: { message: 'File not found' } }, 404); const id = `docCOPY${String(D.size).padStart(19, '0')}`; D.set(id, { title: body.name, text: src.text, parents: body.parents }); return json({ id, name: body.name, webViewLink: `https://docs.google.com/document/d/${id}/edit` }); }
    if ((m = p.match(/^\/drive\/v3\/files\/(\w+)\/export$/))) { const d = D.get(m[1]); res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(`%PDF-1.4\n${d.text}\n%%EOF`); }
    if (p === '/drive/v3/files' && req.method === 'POST') { const id = `docNEW${String(D.size).padStart(20, '0')}`; D.set(id, { title: body.name, text: '' }); return json({ id, name: body.name }); }
    if ((m = p.match(/^\/v1\/documents\/(\w+):batchUpdate$/))) {
      const d = D.get(m[1]); if (!d) return json({ error: { message: 'Requested entity was not found.' } }, 404);
      const replies = body.requests.map(q => {
        if (q.replaceAllText) { const t = q.replaceAllText.containsText.text; const n = d.text.split(t).length - 1; d.text = d.text.split(t).join(q.replaceAllText.replaceText); return { replaceAllText: n ? { occurrencesChanged: n } : {} }; }
        if (q.insertText) { d.text += q.insertText.text; return {}; }
        return {};
      });
      return json({ documentId: m[1], replies });
    }
    if ((m = p.match(/^\/v1\/documents\/(\w+)$/))) { const d = D.get(m[1]); if (!d) return json({ error: { message: 'Requested entity was not found.' } }, 404); return json({ documentId: m[1], title: d.title, body: { content: [{ sectionBreak: {} }, ...d.text.split(/(?<=\n)/).map(line => ({ paragraph: { elements: [{ textRun: { content: line } }] } })), { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Ürün\n' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: 'Adet\n' } }] } }] }] }] } }] } }); }
  }
  return json({ error: 'yok' }, 404);
}

/* self-signed TLS server for the SSL check (CN=localhost, O=8n8 Test, valid until 2036) */
const tlsServer = require('tls').createServer({
  key: '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/GIm/fbRLgtjYLos\nURWFa8DCJNlnZK26xybhJBJn3H2hRANCAATEk5LNlH9PDEuFH8GM9o/fKPS1HNrW\n/kIGjXsJUFUggDMNRSY5qYg3xi0VcE8Kv3gfgjTuRgkmrpTRSblvhTHe\n-----END PRIVATE KEY-----\n',
  cert: '-----BEGIN CERTIFICATE-----\nMIIBujCCAV+gAwIBAgIUPOfUEe447dcon9QeEZ3ho9R9OT8wCgYIKoZIzj0EAwIw\nJzESMBAGA1UEAwwJbG9jYWxob3N0MREwDwYDVQQKDAg4bjggVGVzdDAeFw0yNjEw\nMjIxNjA5MDdaFw0zNjEwMTkxNjA5MDdaMCcxEjAQBgNVBAMMCWxvY2FsaG9zdDER\nMA8GA1UECgwIOG44IFRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATEk5LN\nlH9PDEuFH8GM9o/fKPS1HNrW/kIGjXsJUFUggDMNRSY5qYg3xi0VcE8Kv3gfgjTu\nRgkmrpTRSblvhTHeo2kwZzAdBgNVHQ4EFgQUc3DQA8wXXT8oYB6pMv7L3gKSVPcw\nHwYDVR0jBBgwFoAUc3DQA8wXXT8oYB6pMv7L3gKSVPcwDwYDVR0TAQH/BAUwAwEB\n/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwIDSQAwRgIhAJE7eu55\nJYCm6+kDhaZISofEG82ZKR0A9TB0OU8qtCeMAiEAp+mFTb6PnSD/YbNihi2woT32\n3pHzLycMa+huA3WW30s=\n-----END CERTIFICATE-----\n',
}, s => s.end());
tlsServer.on('tlsClientError', () => {});

/* Elasticsearch, Supabase (PostgREST), Odoo (JSON-RPC), Trendyol, Paraşüt, Ollama */
const fakeMore = { es: {}, supa: [], supaQs: [], odoo: [], ty: { orders: [], stock: [], status: [], invoices: [], answers: [] }, parasut: { tokens: 0, bodies: [] }, ollama: [] };
fakeMore.ty.orders.push({ id: 3360001, orderNumber: '10561', status: 'Created', customerFirstName: 'Ayşe', customerLastName: 'Yılmaz', customerEmail: 'pf+abc@trendyolmail.com', totalPrice: 449.9, currencyCode: 'TRY', orderDate: 1761000000000, cargoProviderName: 'Trendyol Express', shipmentAddress: { fullName: 'Ayşe Yılmaz', phone: '05321112233', city: 'İstanbul', district: 'Kadıköy', fullAddress: 'Moda Cd. 1' }, lines: [{ id: 77, productName: 'Seramik Kupa', barcode: '869001', merchantSku: 'KUP-1', quantity: 1, price: 449.9, amount: 449.9 }] });
function fakeMoreApi(req, res, raw) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || 'null') : Object.fromEntries(new URLSearchParams(raw));
  if (p.startsWith('/es/') || p === '/es') {
    if (req.headers.authorization !== 'ApiKey es-key') return json({ error: { root_cause: [{ reason: 'missing authentication credentials' }] }, status: 401 }, 401);
    const m = p.match(/^\/es\/([^/]+)\/(_doc|_search|_update)(?:\/(.+))?$/);
    if (!m) return json({ name: 'n1', version: { number: '8.15.0' }, tagline: 'You Know, for Search' });
    const [, ix, what, id] = m; const store = (fakeMore.es[ix] ??= {});
    if (what === '_search') {
      const q = body.query; let hits = Object.entries(store);
      if (q.multi_match) hits = hits.filter(([, s]) => JSON.stringify(s).toLocaleLowerCase('tr').includes(q.multi_match.query.toLocaleLowerCase('tr')));
      return json({ hits: { total: { value: hits.length }, hits: hits.map(([k, s]) => ({ _index: ix, _id: k, _score: 1.2, _source: s })) } });
    }
    if (what === '_update') { if (!store[id]) return json({ error: { reason: 'document missing' } }, 404); Object.assign(store[id], body.doc); return json({ _id: id, result: 'updated' }); }
    if (req.method === 'GET') return store[id] ? json({ _id: id, found: true, _source: store[id] }) : json({ _id: id, found: false }, 404);
    if (req.method === 'DELETE') { const had = !!store[id]; delete store[id]; return json({ _id: id, result: had ? 'deleted' : 'not_found' }, had ? 200 : 404); }
    const nid = id || `auto${Object.keys(store).length + 1}`; const had = !!store[nid]; store[nid] = body; return json({ _id: nid, result: had ? 'updated' : 'created' }, had ? 200 : 201);
  }
  if (p.startsWith('/supa/')) {
    if (req.headers.apikey !== 'supa-key' || req.headers.authorization !== 'Bearer supa-key') return json({ message: 'Invalid API key' }, 401);
    if (p === '/supa/rest/v1/') return json({ swagger: '2.0' });
    fakeMore.supaQs.push(`${req.method} ${u.search}`);
    const conds = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
    const ok = r => conds.every(([k, v]) => { const [op, ...rest] = v.split('.'); const x = rest.join('.'); return op === 'eq' ? String(r[k]) === x : op === 'gt' ? r[k] > Number(x) : op === 'ilike' ? new RegExp(`^${x.replace(/\*/g, '.*')}$`, 'i').test(r[k]) : op === 'is' ? r[k] == null : false; });
    const pref = req.headers.prefer || '';
    if (req.method === 'GET') return json(fakeMore.supa.filter(ok).sort((a, b) => b.id - a.id).slice(0, Number(u.searchParams.get('limit')) || 1000));
    if (req.method === 'POST') {
      const out = [];
      for (const r of body) { const ex = fakeMore.supa.find(x => x.id === r.id); if (ex && !pref.includes('merge-duplicates')) return json({ code: '23505', message: 'duplicate key value violates unique constraint "siparisler_pkey"' }, 409); if (ex) { Object.assign(ex, r); out.push(ex); } else { const n = { id: r.id ?? fakeMore.supa.length + 1, ...r }; fakeMore.supa.push(n); out.push(n); } }
      return json(pref.includes('return=representation') ? out : null, 201);
    }
    const hits = fakeMore.supa.filter(ok);
    if (req.method === 'PATCH') { hits.forEach(r => Object.assign(r, body)); return json(hits); }
    if (req.method === 'DELETE') { fakeMore.supa = fakeMore.supa.filter(r => !hits.includes(r)); return json(hits); }
  }
  if (p === '/odoo/jsonrpc') {
    const { service, method, args } = body.params; fakeMore.odoo.push([service, method, ...(service === 'object' ? args.slice(3, 6) : [])]);
    if (service === 'common') return json({ jsonrpc: '2.0', id: body.id, result: args[1] === 'admin@ornek.com' && args[2] === 'odoo-key' && args[0] === 'firma' ? 7 : false });
    if (args[2] !== 'odoo-key') return json({ jsonrpc: '2.0', id: body.id, error: { code: 200, message: 'Odoo Server Error', data: { message: 'Access Denied' } } });
    const [, , , model, m, a, kw] = args;
    if (m === 'search_read') return json({ jsonrpc: '2.0', id: body.id, result: [{ id: 14, name: 'Deco Ltd', email: 'info@deco.com', phone: false, country_id: [224, 'Türkiye'], is_company: true }].map(r => Object.fromEntries(Object.entries(r).filter(([k]) => k === 'id' || !kw.fields || kw.fields.includes(k)))) });
    if (m === 'create') return json({ jsonrpc: '2.0', id: body.id, result: 51 });
    if (m === 'write' || m === 'unlink') return json({ jsonrpc: '2.0', id: body.id, result: true });
    return json({ jsonrpc: '2.0', id: body.id, error: { message: 'Odoo Server Error', data: { message: `${model}.${m} yok` } } });
  }
  if (p.startsWith('/ty/')) {
    if (req.headers.authorization !== `Basic ${Buffer.from('ty-key:ty-secret').toString('base64')}`) return json({ errors: [{ message: 'Unauthorized' }] }, 401);
    if (req.headers['user-agent'] !== '555 - SelfIntegration') return json({ errors: [{ message: 'forbidden' }] }, 403);
    const q = u.searchParams;
    if (p === '/ty/order/sellers/555/orders') { const list = fakeMore.ty.orders.filter(o => !q.get('status') || o.status === q.get('status')); return json({ page: 0, size: 50, totalPages: 1, totalElements: list.length, content: list }); }
    let m = p.match(/^\/ty\/order\/sellers\/555\/shipment-packages\/(\d+)$/); if (m) { fakeMore.ty.status.push({ id: Number(m[1]), ...body }); return json(null); }
    if (p === '/ty/order/sellers/555/seller-invoice-links') { fakeMore.ty.invoices.push(body); return json(null, 201); }
    if (p === '/ty/inventory/sellers/555/products/price-and-inventory') { fakeMore.ty.stock.push(...body.items); return json({ batchRequestId: 'b-123' }); }
    if (p === '/ty/product/sellers/555/products/batch-requests/b-123') return json({ batchRequestId: 'b-123', status: 'COMPLETED', itemCount: 1, failedItemCount: 0, items: [{ requestItem: { barcode: '869001' }, status: 'SUCCESS', failureReasons: [] }] });
    if (p === '/ty/product/sellers/555/products') return json({ totalElements: 1, content: [{ id: 'x1', title: 'Seramik Kupa', barcode: '869001', stockCode: 'KUP-1', brand: 'Atölye', quantity: 7, salePrice: 1250.5, listPrice: 1250.5, vatRate: 20, approved: true, onSale: true, productUrl: 'https://ty.com/x1' }].filter(x => !q.get('barcode') || x.barcode === q.get('barcode')) });
    if (p === '/ty/qna/sellers/555/questions/filter') return json({ content: [{ id: 901, text: 'Bulaşık makinesine girer mi?', productName: 'Seramik Kupa', userName: 'A***', creationDate: 1761000000000 }] });
    m = p.match(/^\/ty\/qna\/sellers\/555\/questions\/(\d+)\/answers$/); if (m) { fakeMore.ty.answers.push({ id: Number(m[1]), ...body }); return json(null); }
    return json({ errors: [{ message: 'yok' }] }, 404);
  }
  if (p.startsWith('/parasut/')) {
    if (p === '/parasut/oauth/token') {
      if (body.grant_type !== 'password' || body.client_id !== 'pc' || body.client_secret !== 'ps') return json({ error: 'invalid_client' }, 401);
      if (body.username !== 'muh@ornek.com' || body.password !== 'pp') return json({ error: 'invalid_grant' }, 401);
      fakeMore.parasut.tokens++; return json({ access_token: 'p-tok', token_type: 'bearer', expires_in: 7200, refresh_token: 'r' });
    }
    if (req.headers.authorization !== 'Bearer p-tok') return json({ errors: [{ title: 'Unauthorized' }] }, 401);
    const r = p.replace(/^\/parasut\/v4\/777/, ''); if (body) fakeMore.parasut.bodies.push([r, body]);
    if (r === '/contacts' && req.method === 'GET') return json({ data: [], meta: { total_count: 0 } });
    if (r === '/contacts') return json({ data: { id: '501', type: 'contacts', attributes: body.data.attributes } }, 201);
    if (r === '/sales_invoices' && req.method === 'POST') {
      const d = body.data.relationships.details.data; const net = d.reduce((s, x) => s + x.attributes.quantity * x.attributes.unit_price, 0); const vat = d.reduce((s, x) => s + x.attributes.quantity * x.attributes.unit_price * x.attributes.vat_rate / 100, 0);
      return json({ data: { id: '9001', type: 'sales_invoices', attributes: { ...body.data.attributes, net_total: String((net + vat).toFixed(2)), total_vat: String(vat.toFixed(2)) } } }, 201);
    }
    if (r === '/sales_invoices') return json({ data: [{ id: '9001', type: 'sales_invoices', attributes: { description: 'Sipariş S-1', issue_date: '2026-10-22', due_date: '2026-10-22', net_total: '241.2', remaining: '0.0', currency: 'TRL', payment_status: 'paid' }, relationships: { contact: { data: { id: '501', type: 'contacts' } } } }], included: [{ id: '501', type: 'contacts', attributes: { name: 'Ayşe Yılmaz' } }] });
    if (r === '/sales_invoices/9001/payments') return json({ data: { id: 'pay1', type: 'payments', attributes: body.data.attributes } }, 201);
    if (r === '/sales_invoices/9001') return json({ data: { id: '9001', type: 'sales_invoices', attributes: {} }, included: [{ id: '501', type: 'contacts', attributes: { name: 'Ayşe Yılmaz', tax_number: '11111111111' } }] });
    if (r === '/e_invoice_inboxes') return json({ data: [] });
    if (r === '/e_archives') return json({ data: { id: 'job-1', type: 'trackable_jobs', attributes: { status: 'pending' } } }, 202);
    return json({ errors: [{ title: 'Not found', detail: r }] }, 404);
  }
  if (p.startsWith('/ollama/')) {
    if (p === '/ollama/api/tags') return json({ models: [{ name: 'llama3.2:latest', size: 2019393189, modified_at: '2026-10-01T10:00:00Z', details: { family: 'llama', parameter_size: '3.2B' } }] });
    if (!/^llama3\.2/.test(body.model)) return json({ error: `model "${body.model}" not found, try pulling it first` }, 404);
    fakeMore.ollama.push(body);
    if (p === '/ollama/api/embed') return json({ model: body.model, embeddings: [[0.1, -0.2, 0.3]] });
    const last = body.messages.at(-1).content;
    return json({ model: body.model, message: { role: 'assistant', content: body.format === 'json' ? '{"duygu":"olumlu"}' : `Merhaba! "${last}" mesajını aldım.` }, done: true, total_duration: 1500000000, prompt_eval_count: 12, eval_count: 8 });
  }
  return json({ error: 'yok' }, 404);
}

(async () => {
  await new Promise(r => fakeServer.listen(0, '127.0.0.1', r)); fakeClaude.port = fakeServer.address().port;
  await new Promise(r => imapServer.listen(0, '127.0.0.1', r)); fakeIMAP.port = imapServer.address().port;
  await new Promise(r => ftpServer.listen(0, '127.0.0.1', r)); fakeFTP.port = ftpServer.address().port;
  await new Promise(r => redisServer.listen(0, '127.0.0.1', r)); fakeRedis.port = redisServer.address().port;
  await new Promise(r => mongoServer.listen(0, '127.0.0.1', r)); fakeMongo.port = mongoServer.address().port;
  await new Promise(r => mqttServer.listen(0, '127.0.0.1', r)); fakeMqtt.port = mqttServer.address().port;
  await new Promise(r => tlsServer.listen(0, '127.0.0.1', r));
  await new Promise(r => sshServer.listen(0, '127.0.0.1', r)); fakeSsh.port = sshServer.address().port;
  await new Promise(r => amqpServer.listen(0, '127.0.0.1', r)); fakeAmqp.port = amqpServer.address().port;
  // N8N8_TEST_EXE=<path> runs the same tests against a built 8n8 executable
  const srv = spawn(process.env.N8N8_TEST_EXE || process.execPath, process.env.N8N8_TEST_EXE ? [] : [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, N8N8_DATA: DATA, PORT: String(PORT), N8N8_NO_OPEN: '1', N8N8_ALLOW_COMMANDS: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_SHEETS_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_TELEGRAM_API: `http://127.0.0.1:${fakeClaude.port}/tg`, N8N8_GOOGLE_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-auth`, N8N8_GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-token`, N8N8_NOTION_API: `http://127.0.0.1:${fakeClaude.port}/notion`, N8N8_SLACK_API: `http://127.0.0.1:${fakeClaude.port}/slack`, N8N8_GRAPH_API: `http://127.0.0.1:${fakeClaude.port}/graph`, N8N8_MS_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/ms-auth`, N8N8_MS_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/ms-token`, N8N8_GITHUB_API: `http://127.0.0.1:${fakeClaude.port}/gh`, N8N8_AIRTABLE_API: `http://127.0.0.1:${fakeClaude.port}/at`, N8N8_DISCORD_API: `http://127.0.0.1:${fakeClaude.port}/dc`, N8N8_WHATSAPP_API: `http://127.0.0.1:${fakeClaude.port}/wa`, N8N8_DROPBOX_CONTENT: `http://127.0.0.1:${fakeClaude.port}/dbxc`, N8N8_DROPBOX_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/dbx-auth`, N8N8_DROPBOX_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/dbx-token`, ...Object.fromEntries(Object.entries({ STRIPE: 'stripe', SHOPIFY: 'shop', WOO: 'woo', TRELLO: 'trello', JIRA: 'jira', HUBSPOT: 'hubspot', MAILCHIMP: 'mc', TWILIO: 'twilio', NETGSM: 'netgsm', TCMB: 'tcmb', GEO: 'geo', WEATHER: 'meteo', PUSHOVER: 'pushover', IYZICO: 'iyzico', TRENDYOL: 'ty', PARASUT: 'parasut', DROPBOX: 'dbx', PIPEDRIVE: 'pd', ASANA: 'asana', CLICKUP: 'cu', DEEPL: 'deepl', ZENDESK: 'zd', META: 'meta', BREVO: 'brevo', TODOIST: 'todoist', JOTFORM: 'jotform', TYPEFORM: 'typeform' }).map(([k, v]) => [`N8N8_${k}_API`, `http://127.0.0.1:${fakeClaude.port}/${v}`])) }, stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => srv.kill());
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (String(d).includes('çalışıyor')) res(); }); srv.on('exit', c => rej(new Error('sunucu kapandı: ' + c))); });
  let fail = 0, ran = 0;
  for (const [name, fn] of tests) {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) continue; // ONLY=mongo npm test
    ran++;
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  }
  srv.kill(); fakeServer.close(); imapServer.close(); ftpServer.close(); redisServer.close(); mongoServer.close(); mqttServer.close(); tlsServer.close(); amqpServer.close(); sshServer.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? `\n${fail} test başarısız` : `\nTüm ${ran} test geçti`);
  process.exit(fail ? 1 : 0);
})();
