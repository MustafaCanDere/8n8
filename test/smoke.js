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
function fakeTelegramApi(req, res) {
  const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const m = req.url.match(/^\/tg\/bot123:abc\/(\w+)/); if (!m) return json({ ok: false, description: 'Unauthorized' }, 401);
  if (m[1] === 'getMe') return json({ ok: true, result: { id: 1, username: 'sahte_bot' } });
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
  const routes = [[/^\/notion\//, fakeNotion], [/^\/slack\//, fakeSlack], [/^\/(ms-token|graph\/)/, fakeMicrosoft]];
  for (const [re, fn] of routes) if (re.test(req.url)) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fn(req, res, raw)); }
  if (/^\/(oauth-token|gmail\/|drive\/|upload\/|calendar\/)/.test(req.url)) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fakeGoogleOAuth(req, res, raw)); }
  if (req.url === '/token' || req.url.startsWith('/v4/')) { let raw = ''; req.on('data', d => { raw += d; }); return req.on('end', () => fakeGoogleApi(req, res, raw)); }
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
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, N8N8_DATA: DATA, PORT: String(PORT), N8N8_NO_OPEN: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_SHEETS_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_TELEGRAM_API: `http://127.0.0.1:${fakeClaude.port}/tg`, N8N8_GOOGLE_API: `http://127.0.0.1:${fakeClaude.port}`, N8N8_GOOGLE_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-auth`, N8N8_GOOGLE_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/oauth-token`, N8N8_NOTION_API: `http://127.0.0.1:${fakeClaude.port}/notion`, N8N8_SLACK_API: `http://127.0.0.1:${fakeClaude.port}/slack`, N8N8_GRAPH_API: `http://127.0.0.1:${fakeClaude.port}/graph`, N8N8_MS_AUTH_URL: `http://127.0.0.1:${fakeClaude.port}/ms-auth`, N8N8_MS_TOKEN_URL: `http://127.0.0.1:${fakeClaude.port}/ms-token` }, stdio: ['ignore', 'pipe', 'inherit'] });
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
