'use strict';
/* Node catalogue. Each entry is both the editor's metadata (labels, parameters) and the server-side run().
   run(ctx) returns an array of outputs; each output is an array of items ({ json }). */
const fs = require('fs');
const path = require('path');
const { runCode } = require('./code-runner');
const crypto = require('crypto');
const Expr = require('./expr');
const { sendMail } = require('./smtp');
const { DIRS } = require('./store');

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function getPath(o, p) { return String(p).split('.').reduce((a, k) => a == null ? undefined : a[k], o); }
function setPath(o, p, v) { const ks = String(p).split('.'); let c = o; ks.slice(0, -1).forEach(k => { if (!isObj(c[k])) c[k] = {}; c = c[k]; }); c[ks[ks.length - 1]] = v; }
function parseJSON(s, label) {
  if (typeof s !== 'string') return s;
  if (!s.trim()) return undefined;
  try { return JSON.parse(s); } catch (e) { throw new Error(`${label}: geçersiz JSON (${e.message})`); }
}
function toItems(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => {
    if (isObj(x) && isObj(x.json) && Object.keys(x).every(k => k === 'json' || k === 'pairedItem')) return { json: x.json };
    return { json: isObj(x) ? x : { value: x } };
  });
}
const kvObject = (rows, R, item, i) => Object.fromEntries((rows || []).filter(r => r.key).map(r => [r.key, R(r.value, item, i)]));

/* ---------- conditions ---------- */
const OPS = [['eq', 'eşittir'], ['neq', 'eşit değil'], ['gt', 'büyüktür'], ['gte', 'büyük/eşit'], ['lt', 'küçüktür'], ['lte', 'küçük/eşit'],
  ['contains', 'içerir'], ['notContains', 'içermez'], ['starts', 'ile başlar'], ['ends', 'ile biter'],
  ['empty', 'boş'], ['notEmpty', 'boş değil'], ['isTrue', 'doğru (true)'], ['isFalse', 'yanlış (false)'], ['regex', 'regex eşleşir']];
const UNARY = new Set(['empty', 'notEmpty', 'isTrue', 'isFalse']);
function testCond(l, op, r) {
  const num = v => typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(+v)) ? +v : NaN;
  const str = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const ln = num(l), rn = num(r), both = !isNaN(ln) && !isNaN(rn), ls = str(l), rs = str(r);
  const isEmpty = l == null || l === '' || (Array.isArray(l) && !l.length) || (isObj(l) && !Object.keys(l).length);
  switch (op) {
    case 'eq': return both ? ln === rn : ls === rs;
    case 'neq': return both ? ln !== rn : ls !== rs;
    case 'gt': return both ? ln > rn : ls > rs;
    case 'gte': return both ? ln >= rn : ls >= rs;
    case 'lt': return both ? ln < rn : ls < rs;
    case 'lte': return both ? ln <= rn : ls <= rs;
    case 'contains': return Array.isArray(l) ? l.map(str).includes(rs) : ls.includes(rs);
    case 'notContains': return !(Array.isArray(l) ? l.map(str).includes(rs) : ls.includes(rs));
    case 'starts': return ls.startsWith(rs);
    case 'ends': return ls.endsWith(rs);
    case 'empty': return isEmpty;
    case 'notEmpty': return !isEmpty;
    case 'isTrue': return l === true || ls === 'true';
    case 'isFalse': return l === false || ls === 'false';
    case 'regex': try { return new RegExp(rs).test(ls); } catch { throw new Error(`Geçersiz regex: ${rs}`); }
  }
  return false;
}
function evalConds(p, R, item, i) {
  const conds = p.conditions || [];
  if (!conds.length) return true;
  const res = conds.map(c => testCond(R(c.left, item, i), c.op, UNARY.has(c.op) ? null : R(c.right, item, i)));
  return p.combinator === 'or' ? res.some(Boolean) : res.every(Boolean);
}
const condParams = [
  { key: 'conditions', label: 'Koşullar', type: 'conds', def: [{ left: '{{ $json.durum }}', op: 'eq', right: 'odendi' }] },
  { key: 'combinator', label: 'Birden fazla koşul varsa', type: 'select', def: 'and', options: [['and', 'Hepsi sağlanmalı (VE)'], ['or', 'Biri yeterli (VEYA)']] },
];

/* ---------- HTTP ---------- */
async function httpRequest({ method = 'GET', url, headers = {}, body, timeout = 30000, signal }) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Geçersiz URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Yalnızca http ve https adresleri desteklenir');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`İstek ${timeout / 1000} sn içinde yanıt almadı`)), timeout);
  const onAbort = () => ctrl.abort(new Error('Çalıştırma durduruldu'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(u, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    let data = text;
    if (ct.includes('json') || /^\s*[[{]/.test(text)) { try { data = JSON.parse(text); } catch {} }
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), body: data };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? (ctrl.signal.reason?.message || 'İstek iptal edildi') : `İstek gönderilemedi: ${e.cause?.message || e.message}`);
  } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
}

/* ---------- node definitions ---------- */
const MODELS = [['claude-opus-5-5', 'Claude Opus 5.5 (önerilen)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (hızlı)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (en ucuz)'], ['claude-fable-5-1', 'Claude Fable 5.1 (en güçlü)']];
const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

const NODES = {
  /* ===== triggers ===== */
  manual: {
    label: 'Manuel tetikleyici', cat: 'trigger', icon: 'play', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Editörde Çalıştır\'a basınca akışı başlatır.',
    params: [{ key: 'data', label: 'Başlangıç verisi (JSON)', type: 'json', def: '[\n  { "kaynak": "manuel" }\n]' }],
    sub: 'Çalıştır ile başlar',
    async run(c) { return [toItems(c.trigger?.items ?? parseJSON(c.p.data || '[{}]', 'Başlangıç verisi') ?? [{}])]; },
  },
  schedule: {
    label: 'Zamanlayıcı', cat: 'trigger', icon: 'clock', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Akış etkinken belirli aralıklarla ya da cron ifadesine göre çalışır. Program açık olduğu sürece çalışmaya devam eder.',
    params: [
      { key: 'mode', label: 'Zamanlama türü', type: 'select', def: 'interval', options: [['interval', 'Aralıklarla'], ['cron', 'Cron ifadesi']] },
      { key: 'every', label: 'Her', type: 'number', def: 15, min: 1, showIf: { mode: 'interval' } },
      { key: 'unit', label: 'Birim', type: 'select', def: 'm', options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat'], ['d', 'gün']], showIf: { mode: 'interval' } },
      { key: 'cron', label: 'Cron ifadesi', type: 'text', def: '0 9 * * 1-5', help: 'dakika saat gün ay haftagünü. Örnek: "0 9 * * 1-5" hafta içi her gün 09:00, "*/10 * * * *" her 10 dakikada.', showIf: { mode: 'cron' } },
    ],
    sub: 'schedule',
    async run() { const d = new Date(); return [[{ json: { tetik: 'zamanlayıcı', zaman: d.toISOString(), yerel: Expr.formatDate(d) } }]]; },
  },
  webhook: {
    label: 'Webhook', cat: 'trigger', icon: 'bolt', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Bu adrese gelen HTTP isteğiyle akışı başlatır. Test adresi akış kapalıyken de çalışır; üretim adresi yalnızca akış etkinken.',
    params: [
      { key: 'method', label: 'HTTP metodu', type: 'select', def: 'POST', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'].map(m => [m, m === 'ANY' ? 'Hepsi' : m]) },
      { key: 'path', label: 'Yol', type: 'text', def: 'yeni-istek', help: 'Adres: /webhook/<yol>. Harf, rakam, - ve / kullanın.' },
      { key: 'respond', label: 'Yanıt', type: 'select', def: 'immediately', options: [['immediately', 'Hemen "alındı" de'], ['lastNode', 'Akış bitince son node\'un çıktısını döndür'], ['node', '"Webhook\'a yanıt ver" node\'u belirlesin']] },
      { key: 'auth', label: 'Kimlik doğrulama', type: 'select', def: 'none', options: [['none', 'Yok (adresi bilen çağırabilir)'], ['cred', 'Kayıtlı kimlik bilgisi iste']] },
      { key: 'credential', label: 'Beklenen kimlik bilgisi', type: 'credential', credTypes: ['httpHeader', 'httpBearer', 'httpBasic'], def: '', showIf: { auth: 'cred' }, help: 'İstek bu başlığı, tokenı ya da kullanıcı adı/şifreyi taşımazsa 401 döner.' },
      { key: 'sample', label: 'Editörden test için örnek gövde (JSON)', type: 'json', def: '{\n  "mesaj": "merhaba"\n}' },
    ],
    sub: '{method} /webhook/{path}',
    async run(c) { return [[{ json: c.trigger?.request ?? { method: c.p.method, yol: c.p.path, headers: {}, query: {}, body: parseJSON(c.p.sample || '{}', 'Örnek gövde') ?? {} } }]]; },
  },
  form: {
    label: 'Form', cat: 'trigger', icon: 'form', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Programın sunduğu bir web formu açar; form her gönderildiğinde akış çalışır. Dosya alanı eklerseniz yüklenen dosyalar dosya klasörüne kaydedilir. Akış etkin olmalıdır.',
    params: [
      { key: 'path', label: 'Yol', type: 'text', def: 'iletisim', help: 'Adres: /form/<yol>' },
      { key: 'title', label: 'Form başlığı', type: 'text', def: 'Bize ulaşın' },
      { key: 'description', label: 'Açıklama', type: 'textarea', def: 'Mesajınızı bırakın, en kısa sürede dönelim.' },
      { key: 'fields', label: 'Alanlar', type: 'formfields', def: [{ label: 'Adınız', name: 'ad', type: 'text', required: true }, { label: 'E-posta', name: 'eposta', type: 'email', required: true }, { label: 'Mesaj', name: 'mesaj', type: 'textarea', required: false }] },
      { key: 'thanks', label: 'Gönderim sonrası mesaj', type: 'text', def: 'Teşekkürler, mesajınız alındı.' },
    ],
    sub: '/form/{path}',
    async run(c) { return [[{ json: c.trigger?.values ?? Object.fromEntries((c.p.fields || []).map(f => [f.name, ''])) }]]; },
  },
  errorTrigger: {
    label: 'Hata tetikleyici', cat: 'trigger', icon: 'alert', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Başka bir akış hata verdiğinde çalışır. O akışın Ayarlar bölümünde bu akışı "hata akışı" olarak seçin.',
    params: [],
    sub: 'bir akış hata verince',
    async run(c) { return [[{ json: c.trigger?.error ?? { workflow: { id: 'ornek', name: 'Örnek akış' }, execution: { id: 'ornek', error: 'Örnek hata mesajı', lastNode: 'HTTP isteği' } } }]]; },
  },
  subTrigger: {
    label: 'Alt akış girişi', cat: 'trigger', icon: 'enter', trigger: true, inputs: 0, outputs: ['main'],
    desc: 'Bu akış başka bir akıştaki "Alt akış çalıştır" node\'u ile çağrılınca başlar ve gelen öğeleri alır.',
    params: [{ key: 'sample', label: 'Editörden test için örnek öğeler (JSON)', type: 'json', def: '[\n  { "id": 1 }\n]' }],
    sub: 'başka akıştan çağrılınca',
    async run(c) { return [c.trigger?.items ?? toItems(parseJSON(c.p.sample || '[{}]', 'Örnek öğeler') ?? [{}])]; },
  },

  /* ===== actions ===== */
  http: {
    label: 'HTTP isteği', cat: 'action', icon: 'globe', inputs: 1, outputs: ['main'],
    desc: 'Herhangi bir API\'ye istek atar. Yanıt JSON ise otomatik çözülür.',
    params: [
      { key: 'method', label: 'Metot', type: 'select', def: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => [m, m]) },
      { key: 'url', label: 'URL', type: 'expr', def: 'https://jsonplaceholder.typicode.com/users' },
      { key: 'auth', label: 'Kimlik doğrulama', type: 'select', def: 'none', options: [['none', 'Yok'], ['cred', 'Kayıtlı kimlik bilgisi']] },
      { key: 'credential', label: 'Kimlik bilgisi', type: 'credential', credTypes: ['httpHeader', 'httpBearer', 'httpBasic', 'httpQuery', 'oauth2', 'googleOAuth', 'microsoftOAuth'], def: '', showIf: { auth: 'cred' } },
      { key: 'query', label: 'Sorgu parametreleri', type: 'kv', def: [] },
      { key: 'headers', label: 'Başlıklar', type: 'kv', def: [] },
      { key: 'bodyType', label: 'Gövde', type: 'select', def: 'json', options: [['json', 'JSON'], ['form', 'Form (urlencoded)'], ['raw', 'Ham metin'], ['none', 'Gövde yok']], showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
      { key: 'body', label: 'Gövde içeriği', type: 'textarea', def: '{\n  "ad": "{{ $json.ad }}"\n}', showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'], bodyType: ['json', 'raw'] } },
      { key: 'formBody', label: 'Form alanları', type: 'kv', def: [], showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'], bodyType: 'form' } },
      { key: 'perItem', label: 'Her girdi öğesi için ayrı istek at', type: 'toggle', def: true },
      { key: 'split', label: 'Dizi yanıtını ayrı öğelere böl', type: 'toggle', def: true },
      { key: 'full', label: 'Durum kodu ve başlıkları da ekle', type: 'toggle', def: false },
      { key: 'failOnError', label: '4xx/5xx yanıtında hata ver', type: 'toggle', def: true },
      { key: 'timeout', label: 'Zaman aşımı (sn)', type: 'number', def: 30, min: 1 },
    ],
    sub: '{method} {url}',
    async run(c) {
      const src = c.items.length ? c.items : [{ json: {} }];
      const targets = c.p.perItem ? src : [src[0]];
      const cred = c.p.auth === 'cred' ? await c.credential(c.p.credential) : null;
      const out = [];
      for (let i = 0; i < targets.length; i++) {
        c.checkAbort();
        const it = targets[i];
        const u = new URL(String(c.R(c.p.url, it, i) ?? '').trim());
        for (const [k, v] of Object.entries(kvObject(c.p.query, c.R, it, i))) u.searchParams.set(k, v);
        const headers = kvObject(c.p.headers, c.R, it, i);
        if (cred) {
          const d = cred.data;
          if (cred.type === 'httpHeader') headers[d.name] = d.value;
          if (cred.type === 'httpBearer') headers.Authorization = `Bearer ${d.token}`;
          if (cred.type === 'httpBasic') headers.Authorization = `Basic ${Buffer.from(`${d.user}:${d.password}`).toString('base64')}`;
          if (cred.type === 'httpQuery') u.searchParams.set(d.name, d.value);
          if (require('./oauth').isOAuth(cred.type)) headers.Authorization = `Bearer ${await require('./oauth').accessToken(cred)}`;
        }
        let body;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.p.method) && c.p.bodyType !== 'none') {
          if (c.p.bodyType === 'form') { body = new URLSearchParams(kvObject(c.p.formBody, c.R, it, i)).toString(); headers['Content-Type'] ||= 'application/x-www-form-urlencoded'; }
          else {
            const raw = c.R(c.p.body || '', it, i);
            body = typeof raw === 'string' ? raw : JSON.stringify(raw);
            if (c.p.bodyType === 'json') { parseJSON(body, 'JSON gövde'); headers['Content-Type'] ||= 'application/json'; }
          }
        }
        const res = await httpRequest({ method: c.p.method, url: u.toString(), headers, body, timeout: (Number(c.p.timeout) || 30) * 1000, signal: c.signal });
        c.log(`${c.p.method} ${u} → ${res.status}`);
        if (!res.ok && c.p.failOnError) throw new Error(`HTTP ${res.status}: ${String(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)).slice(0, 300)}`);
        const wrap = d => c.p.full ? { durum: res.status, basliklar: res.headers, govde: d } : isObj(d) ? d : { veri: d };
        if (c.p.split && Array.isArray(res.body) && !c.p.full) res.body.forEach(d => out.push({ json: isObj(d) ? d : { value: d } }));
        else out.push({ json: wrap(res.body) });
      }
      return [out];
    },
  },
  respond: {
    label: 'Webhook\'a yanıt ver', cat: 'action', icon: 'reply', inputs: 1, outputs: ['main'],
    desc: 'Webhook isteğine özel yanıt döndürür. Webhook node\'unda "Yanıt" seçeneği bu node\'a bırakılmış olmalı.',
    params: [
      { key: 'status', label: 'Durum kodu', type: 'number', def: 200 },
      { key: 'type', label: 'İçerik', type: 'select', def: 'json', options: [['json', 'JSON'], ['text', 'Metin'], ['html', 'HTML'], ['items', 'Gelen tüm öğeler (JSON dizi)']] },
      { key: 'body', label: 'Yanıt gövdesi', type: 'textarea', def: '{\n  "tamam": true\n}', showIf: { type: ['json', 'text', 'html'] } },
      { key: 'headers', label: 'Ek başlıklar', type: 'kv', def: [] },
    ],
    sub: '{status} {type}',
    async run(c) {
      const it = c.items[0] || { json: {} };
      let body = c.p.type === 'items' ? c.items.map(i => i.json) : c.R(c.p.body || '', it, 0);
      let ctype = { json: 'application/json', items: 'application/json', text: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8' }[c.p.type];
      if (c.p.type === 'json' && typeof body === 'string') body = parseJSON(body, 'Yanıt gövdesi');
      const sent = c.respond({ status: Number(c.p.status) || 200, headers: { 'Content-Type': ctype, ...kvObject(c.p.headers, c.R, it, 0) }, body });
      c.log(sent ? 'Yanıt gönderildi' : 'Bekleyen bir webhook isteği yok (editörden çalıştırıldı)');
      return [c.items];
    },
  },
  execWorkflow: {
    label: 'Alt akış çalıştır', cat: 'action', icon: 'enter', inputs: 1, outputs: ['main'],
    desc: 'Başka bir akışı (Alt akış girişi ile başlayan) gelen öğelerle çalıştırır ve onun son çıktısını döndürür.',
    params: [
      { key: 'workflowId', label: 'Akış', type: 'workflow', def: '' },
      { key: 'mode', label: 'Çağrı şekli', type: 'select', def: 'all', options: [['all', 'Tüm öğelerle bir kez'], ['each', 'Her öğe için ayrı']] },
      { key: 'wait', label: 'Bitmesini bekle ve sonucunu al', type: 'toggle', def: true },
    ],
    sub: 'workflow',
    async run(c) {
      if (!c.p.workflowId) throw new Error('Çalıştırılacak akışı seçin');
      const batches = c.p.mode === 'each' ? c.items.map(i => [i]) : [c.items];
      const out = [];
      for (const b of batches) {
        const p = c.runSub(c.p.workflowId, b);
        if (!c.p.wait) { p.catch(() => {}); out.push(...b); continue; }
        out.push(...await p);
      }
      return [out];
    },
  },

  /* ===== data ===== */
  set: {
    label: 'Alanları ayarla', cat: 'data', icon: 'pen', inputs: 1, outputs: ['main'],
    desc: 'Her öğeye alan ekler ya da değiştirir. Değerlerde {{ }} ifadeleri kullanılabilir; nokta ile iç içe alan yazılır (adres.sehir).',
    params: [
      { key: 'fields', label: 'Alanlar', type: 'kv', def: [{ key: 'yeniAlan', value: '{{ $json.ad }}' }] },
      { key: 'keep', label: 'Diğer alanları koru', type: 'toggle', def: true },
      { key: 'remove', label: 'Kaldırılacak alanlar (virgülle)', type: 'text', def: '' },
    ],
    sub: 'fields',
    async run(c) {
      const rm = String(c.p.remove || '').split(',').map(s => s.trim()).filter(Boolean);
      return [c.items.map((it, i) => {
        const o = c.p.keep ? clone(it.json) : {};
        for (const f of c.p.fields || []) if (f.key) setPath(o, f.key, c.R(f.value, it, i));
        for (const k of rm) delete o[k];
        return { json: o };
      })];
    },
  },
  filter: {
    label: 'Filtrele', cat: 'data', icon: 'funnel', inputs: 1, outputs: ['main'],
    desc: 'Yalnızca koşulları sağlayan öğeleri geçirir.',
    params: condParams, sub: 'conds',
    async run(c) { return [c.items.filter((it, i) => evalConds(c.p, c.R, it, i))]; },
  },
  sort: {
    label: 'Sırala', cat: 'data', icon: 'sort', inputs: 1, outputs: ['main'],
    desc: 'Öğeleri bir alana göre sıralar.',
    params: [
      { key: 'field', label: 'Alan (nokta ile yol)', type: 'text', def: 'id' },
      { key: 'order', label: 'Yön', type: 'select', def: 'asc', options: [['asc', 'Artan'], ['desc', 'Azalan']] },
    ],
    sub: '{field} {order}',
    async run(c) {
      const dir = c.p.order === 'desc' ? -1 : 1;
      return [[...c.items].sort((x, y) => {
        const a = getPath(x.json, c.p.field), b = getPath(y.json, c.p.field);
        if (a == null) return 1; if (b == null) return -1;
        return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'tr')) * dir;
      })];
    },
  },
  limit: {
    label: 'Sınırla', cat: 'data', icon: 'scissors', inputs: 1, outputs: ['main'],
    desc: 'Yalnızca ilk ya da son N öğeyi bırakır.',
    params: [
      { key: 'max', label: 'En fazla öğe', type: 'number', def: 10, min: 0 },
      { key: 'from', label: 'Nereden', type: 'select', def: 'start', options: [['start', 'Baştan'], ['end', 'Sondan']] },
    ],
    sub: 'ilk {max}',
    async run(c) { const n = Math.max(0, Number(c.p.max) || 0); return [c.p.from === 'end' ? (n ? c.items.slice(-n) : []) : c.items.slice(0, n)]; },
  },
  dedupe: {
    label: 'Tekrarları kaldır', cat: 'data', icon: 'copy', inputs: 1, outputs: ['main'],
    desc: 'Aynı olan öğelerden yalnızca ilkini bırakır. Alan boşsa tüm öğe karşılaştırılır.',
    params: [{ key: 'fields', label: 'Karşılaştırılacak alanlar (virgülle, boş = tümü)', type: 'text', def: '' }],
    sub: '{fields}',
    async run(c) {
      const fields = String(c.p.fields || '').split(',').map(s => s.trim()).filter(Boolean);
      const seen = new Set();
      return [c.items.filter(it => { const k = JSON.stringify(fields.length ? fields.map(f => getPath(it.json, f)) : it.json); if (seen.has(k)) return false; seen.add(k); return true; })];
    },
  },
  splitOut: {
    label: 'Diziyi öğelere ayır', cat: 'data', icon: 'split', inputs: 1, outputs: ['main'],
    desc: 'Bir öğenin içindeki diziyi alır ve her elemanını ayrı öğe yapar.',
    params: [
      { key: 'field', label: 'Dizi alanı', type: 'text', def: 'urunler' },
      { key: 'include', label: 'Üst öğenin diğer alanlarını da ekle', type: 'toggle', def: false },
    ],
    sub: '{field}',
    async run(c) {
      const out = [];
      for (const it of c.items) {
        const arr = getPath(it.json, c.p.field);
        if (arr == null) continue;
        if (!Array.isArray(arr)) throw new Error(`"${c.p.field}" bir dizi değil`);
        const rest = c.p.include ? Object.fromEntries(Object.entries(it.json).filter(([k]) => k !== c.p.field.split('.')[0])) : {};
        for (const v of arr) out.push({ json: { ...rest, ...(isObj(v) ? v : { [c.p.field.split('.').pop()]: v }) } });
      }
      return [out];
    },
  },
  aggregate: {
    label: 'Topla (tek öğe yap)', cat: 'data', icon: 'stack', inputs: 1, outputs: ['main'],
    desc: 'Tüm öğeleri tek bir öğede dizi olarak toplar.',
    params: [
      { key: 'mode', label: 'Ne toplansın', type: 'select', def: 'all', options: [['all', 'Öğelerin tamamı'], ['field', 'Tek bir alanın değerleri']] },
      { key: 'field', label: 'Alan', type: 'text', def: 'ad', showIf: { mode: 'field' } },
      { key: 'output', label: 'Çıktı alan adı', type: 'text', def: 'liste' },
    ],
    sub: '→ {output}',
    async run(c) {
      const vals = c.p.mode === 'field' ? c.items.map(i => getPath(i.json, c.p.field)) : c.items.map(i => i.json);
      return [[{ json: { [c.p.output || 'liste']: vals, adet: vals.length } }]];
    },
  },
  summarize: {
    label: 'Grupla ve özetle', cat: 'data', icon: 'sigma', inputs: 1, outputs: ['main'],
    desc: 'Öğeleri bir alana göre gruplar; sayı, toplam, ortalama, en küçük ve en büyük değerleri hesaplar.',
    params: [
      { key: 'groupBy', label: 'Gruplama alanı (boş = hepsi tek grup)', type: 'text', def: 'durum' },
      { key: 'field', label: 'Hesaplanacak sayısal alan', type: 'text', def: 'tutar' },
      { key: 'ops', label: 'Hesaplamalar', type: 'text', def: 'adet, toplam, ortalama', help: 'Virgülle: adet, toplam, ortalama, min, max' },
    ],
    sub: '{groupBy} → {ops}',
    async run(c) {
      const groups = new Map();
      for (const it of c.items) { const k = c.p.groupBy ? String(getPath(it.json, c.p.groupBy)) : 'hepsi'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      const ops = String(c.p.ops || 'adet').split(',').map(s => s.trim()).filter(Boolean);
      return [[...groups].map(([k, its]) => {
        const nums = its.map(i => getPath(i.json, c.p.field)).filter(v => v != null && v !== '' && typeof v !== 'boolean').map(Number).filter(n => Number.isFinite(n));
        const sum = nums.reduce((a, b) => a + b, 0);
        const o = c.p.groupBy ? { [c.p.groupBy]: k } : {};
        for (const op of ops) {
          if (op === 'adet') o.adet = its.length;
          else if (op === 'toplam') o.toplam = Math.round(sum * 100) / 100;
          else if (op === 'ortalama') o.ortalama = nums.length ? Math.round(sum / nums.length * 100) / 100 : null;
          else if (op === 'min') o.min = nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : null;
          else if (op === 'max') o.max = nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : null;
        }
        return { json: o };
      })];
    },
  },
  datetime: {
    label: 'Tarih ve saat', cat: 'data', icon: 'calendar', inputs: 1, outputs: ['main'],
    desc: 'Tarihi biçimlendirir ya da üzerine süre ekler. Biçim: YYYY MM DD HH mm ss.',
    params: [
      { key: 'op', label: 'İşlem', type: 'select', def: 'format', options: [['now', 'Şu anki zamanı ekle'], ['format', 'Biçimlendir'], ['add', 'Süre ekle/çıkar']] },
      { key: 'value', label: 'Tarih', type: 'expr', def: '{{ $now }}', showIf: { op: ['format', 'add'] } },
      { key: 'pattern', label: 'Biçim', type: 'text', def: 'DD.MM.YYYY HH:mm', showIf: { op: ['now', 'format'] } },
      { key: 'amount', label: 'Miktar (eksi olabilir)', type: 'number', def: 7, showIf: { op: 'add' } },
      { key: 'unit', label: 'Birim', type: 'select', def: 'gun', options: [['dakika', 'dakika'], ['saat', 'saat'], ['gun', 'gün'], ['hafta', 'hafta'], ['ay', 'ay'], ['yil', 'yıl']], showIf: { op: 'add' } },
      { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'tarih' },
    ],
    sub: '{op} → {output}',
    async run(c) {
      return [c.items.map((it, i) => {
        const o = clone(it.json);
        let v;
        if (c.p.op === 'now') v = Expr.formatDate(new Date(), c.p.pattern);
        else if (c.p.op === 'format') v = Expr.formatDate(c.R(c.p.value, it, i), c.p.pattern);
        else v = Expr.addTime(c.R(c.p.value, it, i), c.p.amount, c.p.unit);
        setPath(o, c.p.output || 'tarih', v);
        return { json: o };
      })];
    },
  },
  crypto: {
    label: 'Şifreleme ve kimlik', cat: 'data', icon: 'key', inputs: 1, outputs: ['main'],
    desc: 'Özet (hash), HMAC imzası, UUID ya da rastgele metin üretir; Base64 kodlar/çözer.',
    params: [
      { key: 'op', label: 'İşlem', type: 'select', def: 'hash', options: [['hash', 'Özet (hash)'], ['hmac', 'HMAC imzası'], ['uuid', 'UUID üret'], ['random', 'Rastgele metin'], ['b64enc', 'Base64 kodla'], ['b64dec', 'Base64 çöz']] },
      { key: 'algo', label: 'Algoritma', type: 'select', def: 'sha256', options: [['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']], showIf: { op: ['hash', 'hmac'] } },
      { key: 'value', label: 'Değer', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: ['hash', 'hmac', 'b64enc', 'b64dec'] } },
      { key: 'secret', label: 'Gizli anahtar', type: 'text', def: '', showIf: { op: 'hmac' } },
      { key: 'length', label: 'Uzunluk', type: 'number', def: 16, showIf: { op: 'random' } },
      { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'sonuc' },
    ],
    sub: '{op} → {output}',
    async run(c) {
      return [c.items.map((it, i) => {
        const o = clone(it.json); const v = () => String(c.R(c.p.value, it, i) ?? '');
        let r;
        switch (c.p.op) {
          case 'hash': r = crypto.createHash(c.p.algo).update(v()).digest('hex'); break;
          case 'hmac': r = crypto.createHmac(c.p.algo, String(c.p.secret || '')).update(v()).digest('hex'); break;
          case 'uuid': r = crypto.randomUUID(); break;
          case 'random': r = crypto.randomBytes(Math.ceil((Number(c.p.length) || 16) * 0.75) + 2).toString('base64url').slice(0, Number(c.p.length) || 16); break;
          case 'b64enc': r = Buffer.from(v(), 'utf8').toString('base64'); break;
          case 'b64dec': r = Buffer.from(v(), 'base64').toString('utf8'); break;
        }
        setPath(o, c.p.output || 'sonuc', r);
        return { json: o };
      })];
    },
  },
  readFile: {
    label: 'Dosya oku', cat: 'data', icon: 'file', inputs: 1, outputs: ['main'],
    desc: 'Programın dosya klasöründen (veri klasöründeki "dosyalar") bir dosya okur. JSON, CSV ve Excel satırları öğelere çevrilir; PDF, Word, PowerPoint ve OpenDocument belgelerinin metni çıkarılır.',
    params: [
      { key: 'path', label: 'Dosya adı', type: 'expr', def: 'liste.csv' },
      { key: 'format', label: 'Biçim', type: 'select', def: 'auto', options: [['auto', 'Uzantıya göre'], ['text', 'Düz metin'], ['json', 'JSON'], ['csv', 'CSV (her satır bir öğe)'], ['xlsx', 'Excel (her satır bir öğe)'], ['document', 'Belgenin metni (PDF, Word, PowerPoint)']] },
      { key: 'sheet', label: 'Excel sayfası (boş = ilk sayfa)', type: 'expr', def: '', showIf: { format: ['auto', 'xlsx'] } },
      { key: 'header', label: 'İlk satır başlık', type: 'toggle', def: true, showIf: { format: ['auto', 'xlsx'] }, help: 'Kapalıysa sütunlar A, B, C… adını alır.' },
    ],
    sub: '{path}',
    async run(c) {
      const out = [];
      const items = c.items.length ? c.items : [{ json: {} }];
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const file = safeFile(c.R(c.p.path, it, i));
        if (seen.has(file)) continue; seen.add(file); // same file for every item: read once
        if (!fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${path.relative(DIRS.files, file)}`);
        const ext = path.extname(file).toLowerCase();
        const fmt = c.p.format === 'auto' ? ({ '.json': 'json', '.csv': 'csv', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.pdf': 'document', '.docx': 'document', '.odt': 'document', '.pptx': 'document' }[ext] || 'text') : c.p.format;
        if (fmt === 'xlsx') {
          const X = require('./xlsx');
          const sh = X.pickSheet(X.readWorkbook(fs.readFileSync(file)), String(c.R(c.p.sheet, it, i) ?? '').trim());
          out.push(...X.toItems(sh.rows, { header: c.p.header !== false }).map(json => ({ json })));
          continue;
        }
        if (fmt === 'document') { const icerik = require('./kb').extract(file, fs.readFileSync(file)); out.push({ json: { dosya: path.basename(file), icerik, karakter: icerik.length } }); continue; }
        const text = fs.readFileSync(file, 'utf8');
        if (fmt === 'json') out.push(...toItems(parseJSON(text, 'Dosya')));
        else if (fmt === 'csv') out.push(...parseCSV(text).map(r => ({ json: r })));
        else out.push({ json: { dosya: path.basename(file), icerik: text } });
      }
      return [out];
    },
  },
  writeFile: {
    label: 'Dosyaya yaz', cat: 'data', icon: 'save', inputs: 1, outputs: ['main'],
    desc: 'Programın dosya klasörüne yazar. CSV ya da Excel seçilirse tüm öğeler tablo olarak yazılır.',
    params: [
      { key: 'path', label: 'Dosya adı', type: 'expr', def: 'cikti.csv' },
      { key: 'format', label: 'İçerik', type: 'select', def: 'csv', options: [['csv', 'Tüm öğeler (CSV)'], ['xlsx', 'Tüm öğeler (Excel .xlsx)'], ['json', 'Tüm öğeler (JSON)'], ['text', 'Metin (her öğe için)']] },
      { key: 'sheet', label: 'Sayfa adı', type: 'text', def: 'Sayfa1', showIf: { format: 'xlsx' } },
      { key: 'content', label: 'Metin', type: 'textarea', def: '{{ $json.ad }}\n', showIf: { format: 'text' } },
      { key: 'append', label: 'Dosyanın sonuna ekle (üzerine yazma)', type: 'toggle', def: false },
    ],
    sub: '{path}',
    async run(c) {
      const file = safeFile(c.R(c.p.path, c.items[0] || { json: {} }, 0));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let data;
      if (c.p.format === 'xlsx') {
        const X = require('./xlsx'); let rows = c.items.map(i => i.json);
        if (c.p.append && fs.existsSync(file)) rows = [...X.toItems(X.pickSheet(X.readWorkbook(fs.readFileSync(file)), '').rows), ...rows];
        fs.writeFileSync(file, X.write(rows, { sheet: c.p.sheet }));
        return [[{ json: { dosya: path.relative(DIRS.files, file), boyut: fs.statSync(file).size, yazilanOge: c.items.length } }]];
      }
      if (c.p.format === 'json') data = JSON.stringify(c.items.map(i => i.json), null, 2);
      else if (c.p.format === 'csv') data = toCSV(c.items.map(i => i.json), c.p.append && fs.existsSync(file));
      else data = c.items.map((it, i) => String(c.R(c.p.content, it, i) ?? '')).join('');
      fs[c.p.append ? 'appendFileSync' : 'writeFileSync'](file, data);
      return [[{ json: { dosya: path.relative(DIRS.files, file), boyut: fs.statSync(file).size, yazilanOge: c.items.length } }]];
    },
  },

  /* ===== logic ===== */
  if: {
    label: 'Eğer', cat: 'logic', icon: 'branch', inputs: 1, outputs: ['doğru', 'yanlış'],
    desc: 'Öğeleri koşula göre iki yola ayırır.',
    params: condParams, sub: 'conds',
    async run(c) { const t = [], f = []; c.items.forEach((it, i) => (evalConds(c.p, c.R, it, i) ? t : f).push(it)); return [t, f]; },
  },
  switch: {
    label: 'Yönlendir', cat: 'logic', icon: 'route', inputs: 1,
    outputs: { from: 'rules', label: 'label', fallback: 'fallback', fallbackLabel: 'diğer' },
    desc: 'Bir değere göre öğeleri farklı çıkışlara gönderir. Her kural ayrı bir çıkış açar.',
    params: [
      { key: 'value', label: 'Karşılaştırılacak değer', type: 'expr', def: '{{ $json.durum }}' },
      { key: 'rules', label: 'Kurallar (değer eşitse o çıkışa)', type: 'rules', def: [{ value: 'odendi', label: 'ödendi' }, { value: 'bekliyor', label: 'bekliyor' }] },
      { key: 'fallback', label: 'Eşleşmeyenler için "diğer" çıkışı', type: 'toggle', def: true },
    ],
    sub: '{value}',
    async run(c) {
      const rules = c.p.rules || []; const outs = rules.map(() => []); const other = [];
      c.items.forEach((it, i) => { const v = String(c.R(c.p.value, it, i)); const k = rules.findIndex(r => String(c.R(r.value, it, i)) === v); (k >= 0 ? outs[k] : other).push(it); });
      return c.p.fallback ? [...outs, other] : outs;
    },
  },
  merge: {
    label: 'Birleştir', cat: 'logic', icon: 'merge', inputs: 2, outputs: ['main'],
    desc: 'İki girdiyi tek akışta toplar. Bir girdi boş gelirse diğeri yine de geçer.',
    params: [
      { key: 'mode', label: 'Yöntem', type: 'select', def: 'append', options: [['append', 'Ardı ardına ekle'], ['index', 'Sıraya göre eşleştir'], ['key', 'Ortak alana göre eşleştir'], ['inner', 'Ortak alana göre, sadece eşleşenler']] },
      { key: 'key', label: 'Ortak alan', type: 'text', def: 'id', showIf: { mode: ['key', 'inner'] } },
    ],
    sub: '{mode}',
    async run(c) {
      const [a = [], b = []] = c.inputs;
      if (c.p.mode === 'index') return [Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ json: { ...(a[i]?.json || {}), ...(b[i]?.json || {}) } }))];
      if (c.p.mode === 'key' || c.p.mode === 'inner') {
        const m = new Map(b.map(x => [String(getPath(x.json, c.p.key)), x.json]));
        return [a.filter(x => c.p.mode === 'key' || m.has(String(getPath(x.json, c.p.key)))).map(x => ({ json: { ...x.json, ...(m.get(String(getPath(x.json, c.p.key))) || {}) } }))];
      }
      return [[...a, ...b]];
    },
  },
  code: {
    label: 'Kod', cat: 'code', icon: 'code', inputs: 1, outputs: ['main'],
    desc: 'JavaScript çalıştırır. items ({ json } dizisi), $vars ve $node kullanılabilir; await ve fetch desteklenir. console.log çıktıları node\'un günlüğünde görünür. Kod ayrı ve kısıtlı bir süreçte çalışır: dosyalara, programlara ve API anahtarlarınıza erişemez.',
    params: [
      { key: 'code', label: 'JavaScript', type: 'code', def: '// items: [{ json }] — girdi öğeleri. Bir dizi döndürün.\nreturn items.map(({ json }) => ({\n  ...json,\n  islendi: true,\n}));' },
      { key: 'timeout', label: 'Zaman aşımı (sn)', type: 'number', def: 30, min: 1 },
    ],
    sub: 'code',
    async run(c) {
      const ms = (Number(c.p.timeout) || 30) * 1000;
      const res = await runCode({ code: c.p.code, filename: `${c.node.name}.js`, items: clone(c.items), nm: c.nm, vars: c.vars, execution: { id: c.exec.id, mode: c.exec.mode }, workflow: { id: c.wf.id, name: c.wf.name }, ms, log: c.log, signal: c.signal, helpers: { sleep: ms => new Promise(r => setTimeout(r, ms)), formatDate: Expr.formatDate, addTime: Expr.addTime } });
      if (res == null) throw new Error('Kod bir dizi ya da nesne döndürmeli (return unutulmuş olabilir)');
      return [toItems(JSON.parse(JSON.stringify(res)))];
    },
  },
  wait: {
    label: 'Bekle', cat: 'flow', icon: 'hourglass', inputs: 1, outputs: ['main'],
    desc: 'Öğeleri değiştirmeden belirtilen süre kadar bekletir.',
    params: [
      { key: 'amount', label: 'Süre', type: 'number', def: 5, min: 0 },
      { key: 'unit', label: 'Birim', type: 'select', def: 's', options: [['ms', 'milisaniye'], ['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] },
    ],
    sub: '{amount} {unit}',
    async run(c) { await c.sleep((Number(c.p.amount) || 0) * UNIT_MS[c.p.unit || 's']); return [c.items]; },
  },
  noop: {
    label: 'Hiçbir şey yapma', cat: 'flow', icon: 'dot', inputs: 1, outputs: ['main'],
    desc: 'Öğeleri olduğu gibi geçirir. Dalları toplamak ya da yer tutmak için.', params: [], sub: '',
    async run(c) { return [c.items]; },
  },
  stopError: {
    label: 'Durdur ve hata ver', cat: 'flow', icon: 'stop', inputs: 1, outputs: [],
    desc: 'Çalıştırmayı verdiğiniz mesajla hata olarak bitirir. Hata akışını tetiklemek için kullanılır.',
    params: [{ key: 'message', label: 'Hata mesajı', type: 'expr', def: 'Beklenmeyen veri: {{ $json.id }}' }],
    sub: '{message}',
    async run(c) { throw new Error(String(c.R(c.p.message, c.items[0] || { json: {} }, 0))); },
  },

  /* ===== integrations ===== */
  claude: {
    label: 'Claude (yapay zekâ)', cat: 'ai', icon: 'spark', inputs: 1, outputs: ['main'],
    desc: 'Her öğe için Claude\'a bir istem gönderir ve yanıtı öğeye ekler. Anthropic API anahtarı gerekir.',
    params: [
      { key: 'credential', label: 'Anthropic API anahtarı', type: 'credential', credTypes: ['anthropicApi'], def: '' },
      { key: 'model', label: 'Model', type: 'select', def: 'claude-opus-5-5', options: MODELS },
      { key: 'effort', label: 'Düşünme çabası', type: 'select', def: 'medium', options: [['low', 'Düşük (hızlı, ucuz)'], ['medium', 'Orta'], ['high', 'Yüksek'], ['xhigh', 'Çok yüksek'], ['max', 'En yüksek']] },
      { key: 'system', label: 'Sistem talimatı', type: 'textarea', def: 'Kısa ve net Türkçe yanıt ver.' },
      { key: 'prompt', label: 'İstem', type: 'textarea', def: 'Şu müşteri mesajını tek cümleyle özetle ve duygusunu (olumlu/olumsuz/nötr) yaz:\n\n{{ $json.mesaj }}' },
      { key: 'attach', label: 'Dosya ekle (isteğe bağlı)', type: 'expr', def: '', help: 'Dosya klasöründeki bir PDF, resim ya da belge; örneğin {{ $json.ekler[0].dosya }}. Claude dosyayı istemle birlikte okur.' },
      { key: 'json', label: 'Yanıtı JSON olarak çözmeyi dene', type: 'toggle', def: false },
      { key: 'maxTokens', label: 'En fazla çıktı token', type: 'number', def: 16000, min: 1 },
      { key: 'output', label: 'Yanıt alanı', type: 'text', def: 'yanit' },
    ],
    sub: '{model}',
    async run(c) {
      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk'); Anthropic = Anthropic.default || Anthropic; }
      catch { throw new Error('Anthropic SDK kurulu değil. Program klasöründe "npm install" çalıştırın.'); }
      const cred = await c.credential(c.p.credential);
      const client = new Anthropic({ apiKey: cred.data.apiKey });
      const fallbackOK = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'].includes(c.p.model);
      const out = [];
      for (let i = 0; i < c.items.length; i++) {
        c.checkAbort();
        const it = c.items[i];
        const prompt = String(c.R(c.p.prompt, it, i) ?? '');
        if (!prompt.trim()) throw new Error('İstem boş');
        const att = String(c.R(c.p.attach || '', it, i) ?? '').trim();
        const content = att ? AI.fileContent(att, prompt) : prompt;
        let res;
        try {
          res = await client.beta.messages.create({
            model: c.p.model,
            max_tokens: Number(c.p.maxTokens) || 16000,
            system: String(c.R(c.p.system || '', it, i) || '') || undefined,
            messages: [{ role: 'user', content }],
            output_config: { effort: c.p.effort || 'medium' },
            ...(fallbackOK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
          }, { signal: c.signal });
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API anahtarı geçersiz');
          if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic hız sınırına takıldı; biraz sonra tekrar deneyin ya da node seçeneklerinden yeniden denemeyi açın');
          if (e instanceof Anthropic.APIError) throw new Error(`Claude API hatası (${e.status ?? 'ağ'}): ${e.message}`);
          throw e;
        }
        if (res.stop_reason === 'refusal') throw new Error(`Claude bu isteği reddetti${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`);
        let text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        let value = text;
        if (c.p.json) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); try { value = JSON.parse(m ? m[1] : text); } catch { value = text; } }
        c.log(`${res.model}: ${res.usage.input_tokens} girdi, ${res.usage.output_tokens} çıktı token`);
        const o = clone(it.json); setPath(o, c.p.output || 'yanit', value);
        out.push({ json: o });
      }
      return [out];
    },
  },
  telegram: {
    label: 'Telegram mesajı', cat: 'app', icon: 'send', inputs: 1, outputs: ['main'],
    desc: 'Telegram botu ile mesaj gönderir. Bot tokenını @BotFather\'dan alın; sohbet kimliği botla yazıştığınız sohbetin numarasıdır.',
    params: [
      { key: 'credential', label: 'Telegram botu', type: 'credential', credTypes: ['telegramApi'], def: '' },
      { key: 'chatId', label: 'Sohbet kimliği', type: 'expr', def: '' },
      { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Yeni kayıt: {{ $json.ad }}' },
      { key: 'parseMode', label: 'Biçim', type: 'select', def: '', options: [['', 'Düz metin'], ['HTML', 'HTML'], ['MarkdownV2', 'Markdown']] },
    ],
    sub: 'sohbet {chatId}',
    async run(c) {
      const cred = await c.credential(c.p.credential);
      const out = [];
      for (let i = 0; i < c.items.length; i++) {
        const it = c.items[i];
        const res = await httpRequest({ method: 'POST', url: `${process.env.N8N8_TELEGRAM_API || 'https://api.telegram.org'}/bot${cred.data.token}/sendMessage`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.R(c.p.chatId, it, i), text: String(c.R(c.p.text, it, i)), ...(c.p.parseMode ? { parse_mode: c.p.parseMode } : {}) }), signal: c.signal });
        if (!res.body?.ok) throw new Error(`Telegram: ${res.body?.description || res.status}`);
        out.push({ json: { mesajId: res.body.result.message_id, sohbet: res.body.result.chat?.id, gonderildi: true } });
      }
      return [out];
    },
  },
  chatWebhook: {
    label: 'Slack / Discord mesajı', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
    desc: 'Slack "Incoming Webhook" ya da Discord kanal webhook adresine mesaj gönderir.',
    params: [
      { key: 'service', label: 'Servis', type: 'select', def: 'slack', options: [['slack', 'Slack'], ['discord', 'Discord']] },
      { key: 'credential', label: 'Webhook adresi', type: 'credential', credTypes: ['webhookUrl'], def: '' },
      { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Yeni sipariş: {{ $json.id }} ({{ $json.tutar }} TL)' },
      { key: 'username', label: 'Gönderen adı (isteğe bağlı)', type: 'text', def: '8n8' },
    ],
    sub: '{service}',
    async run(c) {
      const cred = await c.credential(c.p.credential);
      const out = [];
      for (let i = 0; i < c.items.length; i++) {
        const text = String(c.R(c.p.text, c.items[i], i));
        const body = c.p.service === 'discord' ? { content: text, username: c.p.username || undefined } : { text, username: c.p.username || undefined };
        const res = await httpRequest({ method: 'POST', url: cred.data.url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal });
        if (!res.ok) throw new Error(`${c.p.service} webhook ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
        out.push({ json: { gonderildi: true, durum: res.status } });
      }
      return [out];
    },
  },
  email: {
    label: 'E-posta gönder', cat: 'app', icon: 'mail', inputs: 1, outputs: ['main'],
    desc: 'SMTP ile e-posta gönderir (Gmail için uygulama şifresi gerekir: smtp.gmail.com, 465).',
    params: [
      { key: 'credential', label: 'SMTP hesabı', type: 'credential', credTypes: ['smtp'], def: '' },
      { key: 'from', label: 'Gönderen', type: 'expr', def: '8n8 <ben@ornek.com>' },
      { key: 'to', label: 'Alıcı(lar)', type: 'expr', def: '{{ $json.eposta }}' },
      { key: 'subject', label: 'Konu', type: 'expr', def: 'Merhaba {{ $json.ad }}' },
      { key: 'format', label: 'Biçim', type: 'select', def: 'text', options: [['text', 'Düz metin'], ['html', 'HTML']] },
      { key: 'body', label: 'İçerik', type: 'textarea', def: 'Merhaba {{ $json.ad }},\n\nMesajınızı aldık.\n' },
      { key: 'attach', label: 'Ekler (isteğe bağlı)', type: 'expr', def: '', help: 'Dosya klasöründeki dosyalar, virgülle: {{ $json.pdf.dosya }}, rapor.xlsx. En fazla 25 MB.' },
    ],
    sub: '→ {to}',
    async run(c) {
      const cred = await c.credential(c.p.credential);
      const out = [];
      for (let i = 0; i < c.items.length; i++) {
        const it = c.items[i]; const body = String(c.R(c.p.body, it, i) ?? '');
        const attachments = String(c.R(c.p.attach || '', it, i) ?? '').split(',').map(s => s.trim()).filter(Boolean).map(rel => {
          const f = safeFile(rel); if (!fs.existsSync(f)) throw new Error(`Ek bulunamadı: ${rel}`);
          return { name: path.basename(f).replace(/^[0-9a-f]{8}-/, ''), data: fs.readFileSync(f) };
        });
        if (attachments.reduce((a, x) => a + x.data.length, 0) > 25 * 1024 * 1024) throw new Error('Ekler toplamı 25 MB\'ı geçiyor');
        const res = await sendMail(cred.data, { from: c.R(c.p.from, it, i) || cred.data.user, to: c.R(c.p.to, it, i), subject: String(c.R(c.p.subject, it, i) ?? ''), attachments, ...(c.p.format === 'html' ? { html: body } : { text: body }) });
        c.log(`Gönderildi: ${res.alicilar.join(', ')}`);
        out.push({ json: { gonderildi: true, alicilar: res.alicilar } });
      }
      return [out];
    },
  },

  /* ===== canvas-only ===== */
  note: {
    label: 'Not', cat: 'note', icon: 'note', inputs: 0, outputs: [], note: true,
    desc: 'Tuvale açıklama notu bırakır. Çalıştırılmaz.',
    params: [{ key: 'text', label: 'Not', type: 'textarea', def: 'Bu akış ne yapar?' }, { key: 'color', label: 'Renk', type: 'select', def: 'yellow', options: [['yellow', 'Sarı'], ['blue', 'Mavi'], ['green', 'Yeşil'], ['pink', 'Pembe']] }],
    sub: '',
  },
};

Object.assign(NODES, require('./nodes-extra')({ httpRequest, toItems, parseJSON, isObj, clone, getPath, setPath, kvObject, safeFile, MODELS }));
const INTEGRATIONS = require('./nodes-integrations')({ httpRequest, toItems, isObj, safeFile });
Object.assign(NODES, INTEGRATIONS.NODES);
Object.assign(NODES, require('./nodes-google')({ httpRequest, safeFile }).NODES);
const APPS = require('./nodes-apps')({ httpRequest });
Object.assign(NODES, APPS.NODES);
const DEV = require('./nodes-dev')({ httpRequest });
Object.assign(NODES, DEV.NODES);
const AI = require('./nodes-ai')({ MODELS, clone, setPath, safeFile });
Object.assign(NODES, AI.NODES);
const MAIL = require('./nodes-mail')({ httpRequest, DIRS });
Object.assign(NODES, MAIL.NODES);
const BIZ = require('./nodes-biz')({ httpRequest });
Object.assign(NODES, BIZ.NODES);
const UTIL = require('./nodes-util')({ httpRequest, safeFile, DIRS });
Object.assign(NODES, UTIL.NODES);
const FILES = require('./nodes-files')({ safeFile, DIRS });
Object.assign(NODES, FILES.NODES);
const NET = require('./nodes-net')({ httpRequest, safeFile, DIRS });
Object.assign(NODES, NET.NODES);

function safeFile(name) {
  const p = path.resolve(DIRS.files, String(name || '').replace(/^[/\\]+/, ''));
  if (!p.startsWith(DIRS.files + path.sep)) throw new Error('Dosya yolu dosya klasörünün dışına çıkamaz');
  return p;
}
// numbers only when they read back identically, so 06100, +905321112233, 1e5 and blank cells stay as written
const csvValue = v => { const t = v.trim(); return t !== '' && String(Number(t)) === t ? Number(t) : v; };
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x !== ''));
  if (!head) return [];
  return body.map(r => Object.fromEntries(head.map((h, i) => { const v = r[i] ?? ''; return [h.trim(), csvValue(v)]; })));
}
function toCSV(rows, skipHeader) {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [...(skipHeader ? [] : [cols.join(',')]), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

/* credential types (secret fields are never sent back to the editor) */
const CREDENTIAL_TYPES = {
  httpHeader: { label: 'HTTP başlığı (API anahtarı)', fields: [{ key: 'name', label: 'Başlık adı', def: 'X-API-Key' }, { key: 'value', label: 'Değer', secret: true }] },
  httpBearer: { label: 'Bearer token', fields: [{ key: 'token', label: 'Token', secret: true }] },
  httpBasic: { label: 'Kullanıcı adı ve şifre (Basic)', fields: [{ key: 'user', label: 'Kullanıcı adı' }, { key: 'password', label: 'Şifre', secret: true }] },
  httpQuery: { label: 'Sorgu parametresi (API anahtarı)', fields: [{ key: 'name', label: 'Parametre adı', def: 'api_key' }, { key: 'value', label: 'Değer', secret: true }] },
  anthropicApi: { label: 'Anthropic (Claude)', fields: [{ key: 'apiKey', label: 'API anahtarı', secret: true, help: 'console.anthropic.com → API Keys' }] },
  telegramApi: { label: 'Telegram botu', fields: [{ key: 'token', label: 'Bot token', secret: true, help: '@BotFather\'dan alınır' }] },
  webhookUrl: { label: 'Webhook adresi (Slack/Discord)', fields: [{ key: 'url', label: 'Webhook URL', secret: true }] },
  ...INTEGRATIONS.CREDENTIAL_TYPES,
  ...APPS.CREDENTIAL_TYPES,
  ...DEV.CREDENTIAL_TYPES,
  ...MAIL.CREDENTIAL_TYPES,
  ...BIZ.CREDENTIAL_TYPES,
  ...NET.CREDENTIAL_TYPES,
  smtp: { label: 'SMTP (e-posta)', fields: [{ key: 'host', label: 'Sunucu', def: 'smtp.gmail.com' }, { key: 'port', label: 'Port', def: '465' }, { key: 'secure', label: 'Doğrudan TLS (465 için evet)', def: 'true', options: [['true', 'Evet'], ['false', 'Hayır (STARTTLS)']] }, { key: 'user', label: 'Kullanıcı adı' }, { key: 'password', label: 'Şifre', secret: true }] },
};

const CATEGORIES = { trigger: 'Tetikleyiciler', action: 'Eylemler', ai: 'Yapay zekâ', app: 'Uygulamalar', data: 'Veri', logic: 'Mantık', code: 'Kod', flow: 'Akış', note: 'Tuval' };
const ORDER = ['manual', 'schedule', 'webhook', 'form', 'chatTrigger', 'rssTrigger', 'telegramTrigger', 'whatsappTrigger', 'emailTrigger', 'gmailTrigger', 'outlookTrigger', 'slackTrigger', 'discordTrigger', 'githubTrigger', 'stripeTrigger', 'shopifyTrigger', 'wooTrigger', 'mcpTrigger', 'fileTrigger', 'errorTrigger', 'subTrigger',
  'http', 'rss', 'respond', 'execWorkflow', 'webPage', 'graphql', 'agent', 'claude', 'classify', 'extract', 'aiText', 'knowledge', 'telegram', 'whatsapp', 'chatWebhook', 'email', 'gmail', 'drive', 'calendar', 'sheets', 'outlook', 'slack', 'discord', 'notion', 'airtable', 'github', 'stripe', 'shopify', 'woocommerce', 'trello', 'jira', 'hubspot', 'mailchimp', 'sms', 'push', 'iyzico', 's3', 'ftp', 'redis', 'database',
  'table', 'set', 'rename', 'filter', 'sort', 'limit', 'dedupe', 'splitOut', 'aggregate', 'summarize', 'datetime', 'text', 'html', 'xml', 'markdown', 'crypto', 'exchangeRate', 'weather', 'qrcode', 'pdfCreate', 'compression', 'ics', 'businessDay', 'readFile', 'writeFile',
  'if', 'switch', 'validate', 'merge', 'compare', 'code', 'command', 'loop', 'newItems', 'wait', 'approval', 'noop', 'stopError', 'note'];

function describe() {
  return {
    order: ORDER, categories: CATEGORIES, ops: OPS, unary: [...UNARY],
    types: Object.fromEntries(Object.entries(NODES).map(([k, d]) => [k, { type: k, label: d.label, cat: d.cat, icon: d.icon, trigger: !!d.trigger, poll: !!d.poll, note: !!d.note, inputs: d.inputs, outputs: d.outputs, desc: d.desc, params: d.params, sub: d.sub }])),
    credentialTypes: Object.fromEntries(Object.entries(CREDENTIAL_TYPES).map(([k, t]) => [k, { label: t.label, testable: TESTABLE.includes(k), oauth: !!t.oauth, fields: t.fields.map(({ key, label, secret, def, help, options, multiline }) => ({ key, label, secret: !!secret, def, help, options, multiline: !!multiline })) }])),
  };
}
function outputsOf(node) {
  const d = NODES[node.type]; if (!d) return [];
  if (Array.isArray(d.outputs)) return d.outputs;
  const o = d.outputs, p = node.params || {};
  return [...(p[o.from] || []).map((r, i) => r[o.label] || r.value || `kural ${i + 1}`), ...(p[o.fallback] ? [o.fallbackLabel] : [])];
}
/* "Bağlantıyı dene" in the credential dialog. Returns a short success message, throws a readable error,
   or returns null when the type has nothing to check. */
const TESTABLE = ['anthropicApi', 'telegramApi', 'smtp', 'postgres', 'mysql', 'sqlite', 'googleServiceAccount', 'notionApi', 'slackBot', 'githubApi', 'airtableApi', 'discordBot', 'imap', 'whatsappApi', 'stripeApi', 'shopifyApi', 'wooApi', 'trelloApi', 'jiraApi', 'hubspotApi', 'mailchimpApi', 'netgsmApi', 'twilioApi', 's3Api', 'ftpServer', 'redisServer', 'pushoverApi', 'iyzicoApi'];
async function testCredential(type, d) {
  if (type === 'anthropicApi') {
    let A; try { A = require('@anthropic-ai/sdk'); A = A.default || A; } catch { throw new Error('Anthropic SDK kurulu değil. "npm install" çalıştırın.'); }
    try { await new A({ apiKey: d.apiKey, maxRetries: 0, timeout: 20000 }).models.list({ limit: 1 }); return 'API anahtarı geçerli'; }
    catch (e) { throw new Error(e instanceof A.AuthenticationError ? 'API anahtarı geçersiz' : `Anthropic'e ulaşılamadı: ${e.message}`); }
  }
  if (type === 'telegramApi') {
    const r = await httpRequest({ url: `${process.env.N8N8_TELEGRAM_API || 'https://api.telegram.org'}/bot${d.token}/getMe`, timeout: 15000 });
    if (!r.body?.ok) throw new Error(r.status === 401 || r.status === 404 ? 'Bot anahtarı geçersiz' : `Telegram: ${r.body?.description || r.status}`);
    return `Bot bulundu: @${r.body.result.username}`;
  }
  if (type === 'smtp') { await sendMail({ host: d.host, port: d.port, secure: d.secure, user: d.user, password: d.password }, null, { timeout: 15000 }); return 'Sunucuya bağlanıldı ve giriş yapıldı'; }
  return (await INTEGRATIONS.test(type, d)) ?? (await APPS.test(type, d)) ?? (await MAIL.test(type, d)) ?? (await BIZ.test(type, d)) ?? (await NET.test(type, d)) ?? DEV.test(type, d);
}
function defaults(type) { const p = {}; for (const f of NODES[type].params) p[f.key] = clone(f.def); return p; }

module.exports = { AI, MAIL, NODES, CREDENTIAL_TYPES, testCredential, describe, outputsOf, defaults, toItems, parseCSV, toCSV, testCond, httpRequest };
