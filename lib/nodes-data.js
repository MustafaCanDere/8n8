'use strict';
/* Database and messaging nodes: MongoDB, Elasticsearch, Supabase, Odoo, MQTT (+ trigger). Merged into NODES by nodes.js. */
const Mongo = require('./mongo');
const MQTT = require('./mqtt');

const CREDENTIAL_TYPES = {
  mongoDb: { label: 'MongoDB', fields: [
    { key: 'uri', label: 'Bağlantı adresi', secret: true, help: 'mongodb+srv://kullanici:sifre@kume.xxxx.mongodb.net/veritabani (Atlas → Connect → Drivers) ya da mongodb://localhost:27017/veritabani' },
    { key: 'database', label: 'Veritabanı (adreste yoksa)', def: '' }] },
  elasticsearchApi: { label: 'Elasticsearch / OpenSearch', fields: [
    { key: 'url', label: 'Adres', def: 'http://localhost:9200' },
    { key: 'user', label: 'Kullanıcı adı (isteğe bağlı)' }, { key: 'password', label: 'Şifre', secret: true },
    { key: 'apiKey', label: 'API anahtarı (kullanıcı adı yerine, isteğe bağlı)', secret: true, help: 'Elastic Cloud → Management → API keys; "Encoded" değerini yapıştırın' }] },
  supabaseApi: { label: 'Supabase', fields: [
    { key: 'url', label: 'Proje adresi', def: 'https://xxxx.supabase.co' },
    { key: 'key', label: 'service_role anahtarı', secret: true, help: 'Project Settings → API. Satır güvenliği (RLS) kurallarını aşar; yalnızca bu programda saklayın.' }] },
  odooApi: { label: 'Odoo', fields: [
    { key: 'url', label: 'Adres', def: 'https://sirketim.odoo.com' },
    { key: 'db', label: 'Veritabanı adı', help: 'Odoo Online\'da genellikle alt alan adıyla aynıdır' },
    { key: 'user', label: 'Kullanıcı (e-posta)' },
    { key: 'password', label: 'Şifre ya da API anahtarı', secret: true, help: 'Tercihler → Hesap Güvenliği → Yeni API Anahtarı' }] },
  mqttBroker: { label: 'MQTT sunucusu', fields: [
    { key: 'host', label: 'Sunucu', def: 'localhost' }, { key: 'port', label: 'Port', def: '1883', help: 'Şifreli bağlantıda genellikle 8883' },
    { key: 'user', label: 'Kullanıcı adı (isteğe bağlı)' }, { key: 'password', label: 'Şifre', secret: true },
    { key: 'secure', label: 'Şifreli bağlantı (TLS)', def: 'false', options: [['false', 'Hayır'], ['true', 'Evet (HiveMQ Cloud, EMQX Cloud…)']] },
    { key: 'clientId', label: 'İstemci kimliği (boş = rastgele)', def: '' }] },
};

module.exports = function dataNodes(h) {
  const { httpRequest } = h;
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const R0 = (c, k) => str(c.R(c.p[k], items(c)[0], 0)).trim();
  const parseJSON = (t, what, fallback) => { if (!String(t).trim()) return fallback; try { return JSON.parse(t); } catch (e) { throw new Error(`${what} geçerli JSON değil: ${e.message}`); } };
  const pick = (json, fields) => { const f = str(fields).split(',').map(x => x.trim()).filter(Boolean); return f.length ? Object.fromEntries(f.filter(k => k in json).map(k => [k, json[k]])) : { ...json }; };
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];

  /* ---------- MongoDB ---------- */
  const mongoUri = d => { const u = str(d.uri).trim(); if (!u) throw new Error('MongoDB bağlantı adresi boş'); if (d.database && !/^mongodb(\+srv)?:\/\/[^/]+\/[^?]+/.test(u)) return u.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)\/?/, `$1/${encodeURIComponent(d.database)}`); return u; };
  async function withMongo(c, fn) { const cl = await Mongo.connect(mongoUri((await c.credential(c.p.credential)).data)); try { return await fn(cl); } finally { cl.close(); } }

  /* ---------- Elasticsearch ---------- */
  async function es(cr, method, p, body, signal) {
    const d = cr.data; const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (d.apiKey) headers.Authorization = `ApiKey ${d.apiKey}`; else if (d.user) headers.Authorization = `Basic ${Buffer.from(`${d.user}:${d.password || ''}`).toString('base64')}`;
    const r = await httpRequest({ method, url: `${str(d.url).trim().replace(/\/+$/, '')}${p}`, headers, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok && !(method === 'GET' && r.status === 404 && r.body?.found === false)) {
      const e = r.body?.error; const reason = typeof e === 'string' ? e : e?.root_cause?.[0]?.reason || e?.reason || str(r.body).slice(0, 200);
      throw new Error(`Elasticsearch (${r.status}): ${r.status === 401 ? 'kullanıcı adı, şifre ya da API anahtarı yanlış' : reason}`);
    }
    return r.body;
  }
  const idx = s => { const v = str(s).trim().toLowerCase(); if (!v || /[\\/*?"<>| ,#]/.test(v)) throw new Error(`Geçersiz dizin adı: "${s}"`); return encodeURIComponent(v); };

  /* ---------- Supabase ---------- */
  async function supa(cr, method, p, body, signal, prefer) {
    const d = cr.data; const base = str(d.url).trim().replace(/\/+$/, '');
    const r = await httpRequest({ method, url: `${base}/rest/v1${p}`, headers: { apikey: d.key, Authorization: `Bearer ${d.key}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Supabase (${r.status}): ${r.status === 401 ? 'anahtar geçersiz' : r.body?.message || r.body?.hint || str(r.body).slice(0, 200)}`);
    return r.body;
  }
  /* "durum = yeni" lines or PostgREST text (durum=eq.yeni&yas=gt.18) -> query string */
  const OPS = { '=': 'eq', '!=': 'neq', '<>': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '~': 'ilike' };
  function supaFilter(t) {
    const s = str(t).trim(); if (!s) return '';
    if (/^[\w.]+=\w+\./.test(s) || s.includes('&')) return s.replace(/^[?&]+/, '');
    return s.split(/\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^([\w.]+)\s*(!=|<>|>=|<=|=|>|<|~)\s*(.*)$/); if (!m) throw new Error(`Filtre satırı anlaşılamadı: "${l}" (örnek: durum = yeni)`);
      let v = m[3].trim().replace(/^"(.*)"$/, '$1'); const op = OPS[m[2]];
      if (op === 'ilike') v = `*${v}*`; if (/^null$/i.test(v) && (op === 'eq' || op === 'neq')) return `${m[1]}=${op === 'eq' ? 'is' : 'not.is'}.null`;
      return `${m[1]}=${op}.${encodeURIComponent(v)}`;
    }).join('&');
  }
  const table = s => { const v = str(s).trim(); if (!/^[\w$.-]+$/.test(v)) throw new Error(`Geçersiz tablo adı: "${s}"`); return encodeURIComponent(v); };

  /* ---------- Odoo (JSON-RPC) ---------- */
  async function odoo(cr, signal) {
    const d = cr.data; const url = `${str(d.url).trim().replace(/\/+$/, '')}/jsonrpc`;
    const call = async (service, method, args) => {
      const r = await httpRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }), signal, timeout: 60000 });
      if (r.body?.error) { const e = r.body.error; throw new Error(`Odoo: ${e.data?.message || e.message}`); }
      if (!r.ok) throw new Error(`Odoo (${r.status}): ${str(r.body).slice(0, 200)}`);
      return r.body.result;
    };
    const uid = await call('common', 'authenticate', [d.db, d.user, d.password, {}]);
    if (!uid) throw new Error('Odoo girişi başarısız: veritabanı, kullanıcı ya da şifre yanlış');
    return { uid, exec: (model, method, args, kwargs = {}) => call('object', 'execute_kw', [d.db, uid, d.password, model, method, args, kwargs]) };
  }

  /* ---------- MQTT trigger: one live subscription per credential + topics, drained by each poll ---------- */
  const subs = new Map();
  const sweeper = setInterval(() => { for (const [k, s] of subs) if (Date.now() - s.lastPoll > s.idle) { s.client?.close(); subs.delete(k); } }, 60000); sweeper.unref?.();
  const decodeMsg = (m, parse) => { let v = m.payload.toString('utf8'); if (parse) { try { v = JSON.parse(v); } catch {} } return { konu: m.topic, mesaj: v, saklanan: m.retain, zaman: new Date().toISOString() }; };

  const NODES = {
    mongodb: {
      label: 'MongoDB', cat: 'action', icon: 'db', inputs: 1, outputs: ['main'],
      desc: 'MongoDB\'de (Atlas dahil) belge arar, ekler, günceller, siler, sayar ya da toplama (aggregate) çalıştırır.',
      params: [
        cred(['mongoDb'], 'MongoDB bağlantısı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'find', options: [['find', 'Belge bul'], ['insert', 'Belge ekle'], ['update', 'Belge güncelle'], ['delete', 'Belge sil'], ['count', 'Belge say'], ['aggregate', 'Toplama (aggregate)']] },
        { key: 'collection', label: 'Koleksiyon', type: 'expr', def: 'musteriler' },
        { key: 'filter', label: 'Filtre (JSON)', type: 'textarea', def: '{ "durum": "aktif" }', showIf: { op: ['find', 'update', 'delete', 'count'] }, help: 'MongoDB sorgusu. {{ }} ifadeleri kullanılabilir. 24 haneli _id metni ObjectId\'ye çevrilir; {"$date": "2026-01-01"} tarih olur.' },
        { key: 'projection', label: 'Gelecek alanlar (virgülle, boş = hepsi)', type: 'text', def: '', showIf: { op: 'find' } },
        { key: 'sort', label: 'Sıralama (JSON)', type: 'text', def: '{ "_id": -1 }', showIf: { op: 'find' } },
        { key: 'limit', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'find' } },
        { key: 'fields', label: 'Eklenecek alanlar (virgülle, boş = hepsi)', type: 'text', def: '', showIf: { op: 'insert' } },
        { key: 'update', label: 'Değişiklik (JSON)', type: 'textarea', def: '{ "durum": "{{ $json.durum }}" }', showIf: { op: 'update' }, help: '$ ile başlamayan alanlar $set olarak uygulanır. $inc, $push gibi işleçler de yazılabilir.' },
        { key: 'upsert', label: 'Bulunamazsa ekle (upsert)', type: 'toggle', def: false, showIf: { op: 'update' } },
        { key: 'many', label: 'Eşleşen hepsine uygula', type: 'toggle', def: false, showIf: { op: ['update', 'delete'] } },
        { key: 'pipeline', label: 'Aşamalar (JSON dizi)', type: 'textarea', def: '[\n  { "$match": { "durum": "aktif" } },\n  { "$group": { "_id": "$sehir", "adet": { "$sum": 1 } } }\n]', showIf: { op: 'aggregate' } },
      ],
      sub: '{op} · {collection}',
      async run(c) {
        return withMongo(c, async m => {
          const coll = R0(c, 'collection'); if (!coll) throw new Error('Koleksiyon adı boş');
          if (c.p.op === 'find') {
            const proj = str(c.p.projection).split(',').map(x => x.trim()).filter(Boolean);
            const sort = parseJSON(str(c.p.sort).trim(), 'Sıralama', undefined); const max = Math.max(1, Number(c.p.limit) || 100);
            const r = await m.run({ find: coll, filter: Mongo.fromJSON(parseJSON(R0(c, 'filter'), 'Filtre', {})), ...(proj.length ? { projection: Object.fromEntries(proj.map(k => [k, 1])) } : {}), ...(sort ? { sort } : {}), limit: max, batchSize: Math.min(max, 1000) });
            return [(await m.cursor(r, coll, m.db, max)).map(d => ({ json: Mongo.toJSON(d) }))];
          }
          if (c.p.op === 'count') return [[{ json: { koleksiyon: coll, adet: (await m.run({ count: coll, query: Mongo.fromJSON(parseJSON(R0(c, 'filter'), 'Filtre', {})) })).n } }]];
          if (c.p.op === 'aggregate') {
            const pl = parseJSON(R0(c, 'pipeline'), 'Aşamalar', []); if (!Array.isArray(pl)) throw new Error('Aşamalar bir JSON dizisi olmalı: [ {...}, {...} ]');
            const r = await m.run({ aggregate: coll, pipeline: Mongo.fromJSON(pl), cursor: { batchSize: 1000 } });
            return [(await m.cursor(r, coll, m.db, 100000)).map(d => ({ json: Mongo.toJSON(d) }))];
          }
          if (c.p.op === 'insert') {
            const docs = items(c).map(it => { const d = Mongo.fromJSON(pick(it.json, c.p.fields)); if (d._id == null) d._id = new Mongo.ObjectId(); return d; });
            for (let i = 0; i < docs.length; i += 1000) await m.run({ insert: coll, documents: docs.slice(i, i + 1000), ordered: true });
            return [docs.map(d => ({ json: Mongo.toJSON(d) }))];
          }
          return forItems(c, async (R, it) => {
            const q = Mongo.fromJSON(parseJSON(R('filter'), 'Filtre', {}));
            if (!Object.keys(q).length && !c.p.many) throw new Error('Filtre boş; bütün belgeleri etkilemek için "Eşleşen hepsine uygula"yı açın');
            if (c.p.op === 'delete') { const r = await m.run({ delete: coll, deletes: [{ q, limit: c.p.many ? 0 : 1 }] }); return { ...it.json, silinen: r.n }; }
            let u = Mongo.fromJSON(parseJSON(R('update'), 'Değişiklik', {}));
            if (!Object.keys(u).some(k => k.startsWith('$'))) u = { $set: u };
            const r = await m.run({ update: coll, updates: [{ q, u, upsert: !!c.p.upsert, multi: !!c.p.many }] });
            return { ...it.json, eslesen: r.n - (r.upserted?.length || 0), degisen: r.nModified, ...(r.upserted?.length ? { eklenenId: Mongo.toJSON(r.upserted[0]._id) } : {}) };
          });
        });
      },
    },

    elasticsearch: {
      label: 'Elasticsearch', cat: 'action', icon: 'scan', inputs: 1, outputs: ['main'],
      desc: 'Elasticsearch ya da OpenSearch\'te belge ekler, arar, getirir, günceller ve siler.',
      params: [
        cred(['elasticsearchApi'], 'Elasticsearch bağlantısı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'search', options: [['search', 'Ara'], ['index', 'Belge ekle / değiştir'], ['get', 'Belge getir'], ['update', 'Belgeyi kısmen güncelle'], ['delete', 'Belge sil']] },
        { key: 'index', label: 'Dizin (index)', type: 'expr', def: 'urunler' },
        { key: 'text', label: 'Aranacak metin', type: 'expr', def: '{{ $json.soru }}', showIf: { op: 'search' }, help: 'Bütün alanlarda arar. Ayrıntılı sorgu için aşağıdaki alanı doldurun.' },
        { key: 'query', label: 'Sorgu (JSON, isteğe bağlı)', type: 'textarea', def: '', showIf: { op: 'search' }, help: 'Örnek: { "match": { "ad": "kupa" } }. Doluysa metnin yerine kullanılır.' },
        { key: 'size', label: 'En fazla sonuç', type: 'number', def: 20, min: 1, showIf: { op: 'search' } },
        { key: 'id', label: 'Belge kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['index', 'get', 'update', 'delete'] }, help: 'Eklemede boş bırakılırsa Elasticsearch kimlik üretir.' },
        { key: 'fields', label: 'Gönderilecek alanlar (virgülle, boş = hepsi)', type: 'text', def: '', showIf: { op: ['index', 'update'] } },
      ],
      sub: '{op} · {index}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'search') {
          const q = R0(c, 'query'); const text = R0(c, 'text');
          const query = q ? parseJSON(q, 'Sorgu') : text ? { multi_match: { query: text, fields: ['*'], fuzziness: 'AUTO', lenient: true } } : { match_all: {} };
          const r = await es(cr, 'POST', `/${idx(R0(c, 'index'))}/_search`, { query, size: Math.max(1, Number(c.p.size) || 20) }, c.signal);
          return [(r.hits?.hits || []).map(x => ({ json: { _id: x._id, _skor: x._score, ...x._source } }))];
        }
        return forItems(c, async (R, it) => {
          const ix = idx(R('index')); const id = R('id');
          if (c.p.op === 'index') { const r = await es(cr, id ? 'PUT' : 'POST', `/${ix}/_doc${id ? `/${encodeURIComponent(id)}` : ''}?refresh=wait_for`, pick(it.json, c.p.fields), c.signal); return { ...it.json, _id: r._id, sonuc: r.result }; }
          if (!id) throw new Error('Belge kimliği boş');
          if (c.p.op === 'get') { const r = await es(cr, 'GET', `/${ix}/_doc/${encodeURIComponent(id)}`, null, c.signal); return r.found ? { _id: r._id, ...r._source } : { _id: id, bulunamadi: true }; }
          if (c.p.op === 'update') { const r = await es(cr, 'POST', `/${ix}/_update/${encodeURIComponent(id)}?refresh=wait_for`, { doc: pick(it.json, c.p.fields) }, c.signal); return { ...it.json, _id: r._id, sonuc: r.result }; }
          const r = await es(cr, 'DELETE', `/${ix}/_doc/${encodeURIComponent(id)}?refresh=wait_for`, null, c.signal); return { _id: id, sonuc: r.result };
        });
      },
    },

    supabase: {
      label: 'Supabase', cat: 'action', icon: 'db', inputs: 1, outputs: ['main'],
      desc: 'Supabase veritabanındaki bir tablodan satır okur, ekler, ekler-ya-da-günceller, günceller ve siler.',
      params: [
        cred(['supabaseApi'], 'Supabase projesi'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'select', options: [['select', 'Satırları getir'], ['insert', 'Satır ekle'], ['upsert', 'Ekle ya da güncelle'], ['update', 'Satırları güncelle'], ['delete', 'Satırları sil']] },
        { key: 'table', label: 'Tablo', type: 'expr', def: 'siparisler' },
        { key: 'filter', label: 'Filtre', type: 'textarea', def: 'durum = yeni', showIf: { op: ['select', 'update', 'delete'] }, help: 'Her satıra bir koşul: alan = değer, alan != değer, alan > 5, alan ~ metin (içerir), alan = null. PostgREST biçimi de olur: durum=eq.yeni&yas=gt.18' },
        { key: 'columns', label: 'Sütunlar', type: 'text', def: '*', showIf: { op: 'select' } },
        { key: 'order', label: 'Sıralama', type: 'text', def: 'id.desc', showIf: { op: 'select' }, help: 'sütun.asc ya da sütun.desc' },
        { key: 'limit', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'select' } },
        { key: 'fields', label: 'Gönderilecek alanlar (virgülle, boş = hepsi)', type: 'text', def: '', showIf: { op: ['insert', 'upsert'] } },
        { key: 'onConflict', label: 'Eşleştirme sütunu', type: 'text', def: 'id', showIf: { op: 'upsert' } },
        { key: 'values', label: 'Yeni değerler (JSON)', type: 'textarea', def: '{ "durum": "hazirlaniyor" }', showIf: { op: 'update' } },
      ],
      sub: '{op} · {table}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'select') {
          const qs = [`select=${encodeURIComponent(str(c.p.columns).trim() || '*')}`, supaFilter(R0(c, 'filter')), str(c.p.order).trim() ? `order=${encodeURIComponent(str(c.p.order).trim())}` : '', `limit=${Math.max(1, Number(c.p.limit) || 100)}`].filter(Boolean).join('&');
          return [(await supa(cr, 'GET', `/${table(R0(c, 'table'))}?${qs}`, null, c.signal)).map(json => ({ json }))];
        }
        if (c.p.op === 'insert' || c.p.op === 'upsert') {
          const rows = items(c).map(it => pick(it.json, c.p.fields)); const out = [];
          const oc = str(c.p.onConflict).trim();
          for (let i = 0; i < rows.length; i += 500) out.push(...await supa(cr, 'POST', `/${table(R0(c, 'table'))}${c.p.op === 'upsert' && oc ? `?on_conflict=${encodeURIComponent(oc)}` : ''}`, rows.slice(i, i + 500), c.signal, `return=representation${c.p.op === 'upsert' ? ',resolution=merge-duplicates' : ''}`));
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async R => {
          const f = supaFilter(R('filter')); if (!f) throw new Error('Filtre boş; bütün tabloyu değiştirmemek için en az bir koşul yazın');
          if (c.p.op === 'delete') return (await supa(cr, 'DELETE', `/${table(R('table'))}?${f}`, null, c.signal, 'return=representation'));
          const vals = parseJSON(R('values'), 'Yeni değerler', {});
          return (await supa(cr, 'PATCH', `/${table(R('table'))}?${f}`, vals, c.signal, 'return=representation'));
        });
      },
    },

    odoo: {
      label: 'Odoo', cat: 'app', icon: 'board', inputs: 1, outputs: ['main'],
      desc: 'Odoo ERP\'de herhangi bir modelde (müşteri, satış, fatura, ürün…) kayıt arar, oluşturur, günceller ya da siler.',
      params: [
        cred(['odooApi'], 'Odoo hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'search', options: [['search', 'Kayıt ara'], ['create', 'Kayıt oluştur'], ['update', 'Kayıt güncelle'], ['delete', 'Kayıt sil']] },
        { key: 'model', label: 'Model', type: 'expr', def: 'res.partner', help: 'res.partner (kişi/firma), sale.order (satış), account.move (fatura), product.product (ürün), crm.lead (fırsat)…' },
        { key: 'domain', label: 'Koşullar (Odoo domain, JSON)', type: 'textarea', def: '[["is_company", "=", true]]', showIf: { op: 'search' } },
        { key: 'fieldNames', label: 'Gelecek alanlar (virgülle)', type: 'text', def: 'name,email,phone', showIf: { op: 'search' } },
        { key: 'limit', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'search' } },
        { key: 'id', label: 'Kayıt kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['update', 'delete'] } },
        { key: 'values', label: 'Değerler (JSON)', type: 'textarea', def: '{ "name": "{{ $json.ad }}", "email": "{{ $json.eposta }}" }', showIf: { op: ['create', 'update'] } },
      ],
      sub: '{op} · {model}',
      async run(c) {
        const o = await odoo(await c.credential(c.p.credential), c.signal);
        if (c.p.op === 'search') {
          const fields = str(c.p.fieldNames).split(',').map(x => x.trim()).filter(Boolean);
          const rows = await o.exec(R0(c, 'model'), 'search_read', [parseJSON(R0(c, 'domain'), 'Koşullar', [])], { ...(fields.length ? { fields } : {}), limit: Math.max(1, Number(c.p.limit) || 100) });
          return [rows.map(r => ({ json: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string' ? { id: v[0], ad: v[1] } : v === false && k !== 'active' ? null : v])) }))];
        }
        return forItems(c, async (R, it) => {
          const model = R('model');
          if (c.p.op === 'create') { const id = await o.exec(model, 'create', [parseJSON(R('values'), 'Değerler', {})]); return { ...it.json, id }; }
          const id = Number(R('id')); if (!Number.isInteger(id) || id <= 0) throw new Error(`Kayıt kimliği sayı olmalı: "${R('id')}"`);
          if (c.p.op === 'update') { await o.exec(model, 'write', [[id], parseJSON(R('values'), 'Değerler', {})]); return { ...it.json, id, guncellendi: true }; }
          await o.exec(model, 'unlink', [[id]]); return { id, silindi: true };
        });
      },
    },

    mqtt: {
      label: 'MQTT gönder', cat: 'action', icon: 'send', inputs: 1, outputs: ['main'],
      desc: 'Bir MQTT sunucusundaki konuya mesaj yayınlar (akıllı ev, IoT cihazları, sensörler, Home Assistant).',
      params: [
        cred(['mqttBroker'], 'MQTT sunucusu'),
        { key: 'topic', label: 'Konu', type: 'expr', def: 'ev/salon/lamba' },
        { key: 'message', label: 'Mesaj', type: 'textarea', def: '{{ $json }}', help: 'Boş bırakılırsa öğenin tamamı JSON olarak gider.' },
        { key: 'qos', label: 'Teslim garantisi (QoS)', type: 'select', def: '0', options: [['0', '0 - en fazla bir kez'], ['1', '1 - en az bir kez (onaylı)']] },
        { key: 'retain', label: 'Sunucuda sakla (retain)', type: 'toggle', def: false },
      ],
      sub: '{topic}',
      async run(c) {
        const cl = await MQTT.connect((await c.credential(c.p.credential)).data);
        try {
          return await forItems(c, async (R, it) => {
            const topic = R('topic'); if (!topic || /[+#]/.test(topic)) throw new Error(`Geçersiz konu: "${topic}" (+ ve # yayında kullanılamaz)`);
            const msg = str(c.p.message).trim() ? R('message') : JSON.stringify(it.json);
            await cl.publish(topic, msg, { qos: Number(c.p.qos), retain: !!c.p.retain });
            return { ...it.json, mqtt: { konu: topic, gonderildi: true } };
          });
        } finally { await cl.close(); }
      },
    },
    mqttTrigger: {
      label: 'MQTT mesajı gelince', cat: 'trigger', icon: 'bolt', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'MQTT sunucusundaki konulara abone olur; gelen her mesajda akışı çalıştırır. Bağlantı akış etkinken açık kalır.',
      params: pollParams(5, 's', [
        cred(['mqttBroker'], 'MQTT sunucusu'),
        { key: 'topics', label: 'Konular (virgülle)', type: 'text', def: 'ev/+/sicaklik', help: '+ bir seviyeyi, # gerisini kapsar: sensor/#' },
        { key: 'qos', label: 'QoS', type: 'select', def: '0', options: [['0', '0'], ['1', '1']] },
        { key: 'parse', label: 'JSON mesajları çöz', type: 'toggle', def: true },
      ]),
      async poll(c) {
        const topics = str(c.p.topics).split(',').map(x => x.trim()).filter(Boolean); if (!topics.length) throw new Error('En az bir konu yazın');
        const key = JSON.stringify([c.p.credential, topics, c.p.qos]);
        const every = Math.max(5000, (Number(c.p.every) || 5) * ({ s: 1000, m: 60000, h: 3600000 }[c.p.unit] || 1000));
        let s = subs.get(key);
        if (!s || s.client?.closed) {
          const err = s?.error; s = { buf: [], lastPoll: Date.now(), idle: Math.max(600000, every * 3), client: null };
          subs.set(key, s);
          const cl = await MQTT.connect((await c.credential(c.p.credential)).data, { onMessage: m => { if (s.buf.length < 1000) s.buf.push(decodeMsg(m, c.p.parse)); }, onClose: e => { s.error = e.message; } }).catch(e => { subs.delete(key); throw e; });
          await cl.subscribe(topics, Number(c.p.qos)).catch(async e => { await cl.close(); subs.delete(key); throw e; });
          s.client = cl;
          if (err) throw new Error(`Bağlantı koptu ve yeniden kuruldu: ${err}`);
          return [];
        }
        const stale = Date.now() - s.lastPoll > every * 2 + 5000; // messages that arrived while the workflow was off
        s.lastPoll = Date.now(); s.idle = Math.max(600000, every * 3);
        const got = s.buf.splice(0); return stale ? [] : got;
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { konu: 'ev/salon/sicaklik', mesaj: { deger: 22.5, birim: 'C' }, saklanan: false, zaman: new Date().toISOString() } }]]; },
      eachItem: true,
    },
  };

  async function test(type, d) {
    if (type === 'mongoDb') { const cl = await Mongo.connect(mongoUri(d), { timeout: 15000 }); try { const r = await cl.run({ listCollections: 1, nameOnly: true, cursor: {} }); const names = r.cursor.firstBatch.map(x => x.name); return `Bağlanıldı (${cl.db}); koleksiyonlar: ${names.slice(0, 10).join(', ') || '(yok)'}${cl.hello.setName ? `, küme ${cl.hello.setName}` : ''}`; } finally { cl.close(); } }
    if (type === 'elasticsearchApi') { const r = await es({ data: d }, 'GET', '/', null); return `Bağlanıldı: ${r.version?.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} ${r.version?.number || ''}`.trim(); }
    if (type === 'supabaseApi') { await supa({ data: d }, 'GET', '/', null); return 'Bağlanıldı'; }
    if (type === 'odooApi') { const o = await odoo({ data: d }); return `Giriş yapıldı (kullanıcı #${o.uid})`; }
    if (type === 'mqttBroker') { const cl = await MQTT.connect(d); await cl.close(); return 'Bağlanıldı'; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
