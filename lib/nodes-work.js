'use strict';
/* Work and cloud nodes: RabbitMQ (+ trigger), Dropbox, OneDrive, Pipedrive, Asana, ClickUp, DeepL, Zendesk (+ trigger),
   Facebook sayfası ve Instagram. Merged into NODES by nodes.js.
   N8N8_<X>_API variables point the services at other base URLs (tests). */
const fs = require('fs');
const path = require('path');
const oauth = require('./oauth');
const AMQP = require('./amqp');

const CREDENTIAL_TYPES = {
  rabbitmq: { label: 'RabbitMQ (AMQP)', fields: [
    { key: 'host', label: 'Sunucu', def: 'localhost' }, { key: 'port', label: 'Port', def: '5672', help: 'Şifreli bağlantıda genellikle 5671' },
    { key: 'user', label: 'Kullanıcı adı', def: 'guest' }, { key: 'password', label: 'Şifre', secret: true },
    { key: 'vhost', label: 'Sanal sunucu (vhost)', def: '/' },
    { key: 'secure', label: 'Şifreli bağlantı (TLS)', def: 'false', options: [['false', 'Hayır'], ['true', 'Evet (CloudAMQP, amqps://)']] }] },
  dropboxOAuth: { label: 'Dropbox hesabı', oauth: true, fields: [
    { key: 'clientId', label: 'App key', help: 'dropbox.com/developers/apps → Create app (Scoped access). Permissions sekmesinde files.content.write, files.content.read ve sharing.write izinlerini açın; Settings\'te aşağıdaki yönlendirme adresini ekleyin.' },
    { key: 'clientSecret', label: 'App secret', secret: true }] },
  pipedriveApi: { label: 'Pipedrive', fields: [
    { key: 'token', label: 'API anahtarı', secret: true, help: 'Pipedrive → Ayarlar → Kişisel tercihler → API' },
    { key: 'domain', label: 'Şirket alan adı (isteğe bağlı)', def: '', help: 'sirketim.pipedrive.com ise "sirketim"' }] },
  asanaApi: { label: 'Asana', fields: [{ key: 'token', label: 'Kişisel erişim anahtarı', secret: true, help: 'app.asana.com/0/my-apps → Create new token' }] },
  clickupApi: { label: 'ClickUp', fields: [{ key: 'token', label: 'Kişisel API anahtarı (pk_…)', secret: true, help: 'ClickUp → Ayarlar → Apps → API Token' }] },
  deeplApi: { label: 'DeepL', fields: [{ key: 'key', label: 'API anahtarı', secret: true, help: 'deepl.com → Hesap → API anahtarları. Ücretsiz anahtar ":fx" ile biter.' }] },
  zendeskApi: { label: 'Zendesk', fields: [
    { key: 'subdomain', label: 'Alt alan adı', help: 'sirketim.zendesk.com ise "sirketim"' },
    { key: 'email', label: 'Yönetici e-postası' }, { key: 'token', label: 'API anahtarı', secret: true, help: 'Yönetim Merkezi → Uygulamalar ve entegrasyonlar → Zendesk API → API anahtarları' }] },
  metaPage: { label: 'Facebook sayfası / Instagram', fields: [
    { key: 'pageId', label: 'Facebook sayfa kimliği', help: 'Sayfa → Hakkında → Sayfa kimliği' },
    { key: 'token', label: 'Sayfa erişim anahtarı', secret: true, help: 'developers.facebook.com → Graph API Gezgini ile pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish izinli uzun süreli sayfa anahtarı alın.' },
    { key: 'igUserId', label: 'Instagram işletme hesabı kimliği (isteğe bağlı)', def: '', help: 'Boşsa sayfaya bağlı Instagram hesabı kendiliğinden bulunur.' }] },
};

module.exports = function workNodes(h) {
  const { httpRequest, safeFile, DIRS } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const R0 = (c, k) => str(c.R(c.p[k], items(c)[0], 0)).trim();
  const rel = f => path.relative(DIRS.files, f).split(path.sep).join('/');
  const save = (relName, data) => { const f = safeFile(relName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const readLocal = (name, i) => { const f = safeFile(name); if (!name || !fs.existsSync(f)) throw new Error(`${i + 1}. öğede dosya bulunamadı: ${name}`); return fs.readFileSync(f); };
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const newOnly = (c, list, idOf) => {
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };
  const errText = (r, ...paths) => { for (const p of paths) { let v = r.body; for (const k of p.split('.')) v = v?.[k]; if (v) return typeof v === 'string' ? v : JSON.stringify(v); } return typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200); };
  /* binary-safe request (downloads) */
  async function rawFetch(url, { method = 'GET', headers = {}, body, signal, timeout = 300000 } = {}) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout); signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    try { const r = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' }); return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), buf: Buffer.from(await r.arrayBuffer()) }; }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'İstek zaman aşımına uğradı ya da durduruldu' : `İstek gönderilemedi: ${e.cause?.message || e.message}`); }
    finally { clearTimeout(t); }
  }

  /* ---------- RabbitMQ ---------- */
  async function withRabbit(c, fn) { const cl = await AMQP.connect((await c.credential(c.p.credential)).data); try { return await fn(cl); } finally { await cl.close(); } }
  const decodeBody = (m, parse) => { let v = m.body.toString('utf8'); if (parse) { try { v = JSON.parse(v); } catch {} } return { mesaj: v, kuyruk: m.routingKey, degisim: m.exchange || '', yenidenTeslim: m.redelivered, ozellikler: m.properties, ...(m.properties.headers ? { basliklar: m.properties.headers } : {}) }; };
  async function drain(cl, queue, max, parse) {
    const out = []; let last = null;
    while (out.length < max) { const m = await cl.get(queue); if (!m) break; out.push(decodeBody(m, parse)); last = m.deliveryTag; }
    if (last != null) cl.ack(last, true);
    return out;
  }

  /* ---------- Dropbox ---------- */
  const dbxArg = o => JSON.stringify(o).replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`); // header must be ASCII
  const dbxPath = p => { const s = str(p).trim().replace(/\\/g, '/'); return !s || s === '/' ? '' : s.startsWith('/') ? s : `/${s}`; };
  async function dbx(cr, endpoint, body, signal) {
    const r = await httpRequest({ method: 'POST', url: `${env('N8N8_DROPBOX_API', 'https://api.dropboxapi.com')}/2${endpoint}`, headers: { Authorization: `Bearer ${await oauth.accessToken(cr)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok) throw Object.assign(new Error(`Dropbox (${r.status}): ${r.status === 401 ? 'oturum geçersiz; "Hesaba bağlan" ile yeniden bağlanın' : dbxErr(r.body)}`), { summary: r.body?.error_summary || '' });
    return r.body;
  }
  const dbxErr = b => { const s = b?.error_summary || (typeof b === 'string' ? b : ''); return /not_found/.test(s) ? 'dosya ya da klasör bulunamadı' : /insufficient_space/.test(s) ? 'Dropbox alanı dolu' : /missing_scope/.test(s) ? `uygulamada izin eksik (${b?.error?.required_scope || s})` : s.slice(0, 200) || 'hata'; };
  const dbxEntry = e => ({ ad: e.name, yol: e.path_display, tur: e['.tag'] === 'folder' ? 'klasor' : 'dosya', boyut: e.size ?? null, degisti: e.server_modified || null, id: e.id });

  /* ---------- OneDrive (Microsoft Graph) ---------- */
  const GRAPH = () => env('N8N8_GRAPH_API', 'https://graph.microsoft.com/v1.0');
  const odPath = p => str(p).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const odItem = p => (odPath(p) ? `/me/drive/root:/${odPath(p)}:` : '/me/drive/root');
  async function graph(cr, method, p, body, signal, headers = {}) {
    const r = await httpRequest({ method, url: p.startsWith('http') ? p : GRAPH() + p, headers: { Authorization: `Bearer ${await oauth.accessToken(cr)}`, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal, timeout: 300000 });
    if (!r.ok) throw new Error(`OneDrive (${r.status}): ${r.status === 401 ? 'oturum geçersiz; "Hesaba bağlan" ile yeniden bağlanın' : r.status === 403 ? 'izin yok; kimlik bilgisinde "Hesaba bağlan" ile yeniden bağlanıp dosya iznini verin' : r.status === 404 ? 'dosya ya da klasör bulunamadı' : errText(r, 'error.message')}`);
    return r.body;
  }
  const odEntry = e => ({ ad: e.name, yol: `${(e.parentReference?.path || '').replace(/^\/drive\/root:?/, '')}/${e.name}`, tur: e.folder ? 'klasor' : 'dosya', boyut: e.size ?? null, degisti: e.lastModifiedDateTime || null, id: e.id, adres: e.webUrl });

  /* ---------- Pipedrive ---------- */
  async function pd(cr, method, p, body, signal) {
    const d = cr.data; const base = env('N8N8_PIPEDRIVE_API', d.domain ? `https://${String(d.domain).replace(/\.pipedrive\.com.*$/, '').trim()}.pipedrive.com/api/v1` : 'https://api.pipedrive.com/v1');
    const r = await httpRequest({ method, url: `${base}${p}${p.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(d.token)}`, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok || r.body?.success === false) throw new Error(`Pipedrive (${r.status}): ${r.status === 401 ? 'API anahtarı geçersiz' : errText(r, 'error', 'error_info')}`);
    return r.body;
  }
  /* ---------- Asana / ClickUp / Zendesk / DeepL / Meta ---------- */
  async function asana(cr, method, p, data, signal) {
    const r = await httpRequest({ method, url: `${env('N8N8_ASANA_API', 'https://app.asana.com/api/1.0')}${p}`, headers: { Authorization: `Bearer ${cr.data.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: data ? JSON.stringify({ data }) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Asana (${r.status}): ${r.status === 401 ? 'erişim anahtarı geçersiz' : (r.body?.errors || []).map(e => e.message).join('; ') || errText(r)}`);
    return r.body.data;
  }
  async function clickup(cr, method, p, body, signal) {
    const r = await httpRequest({ method, url: `${env('N8N8_CLICKUP_API', 'https://api.clickup.com/api/v2')}${p}`, headers: { Authorization: cr.data.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`ClickUp (${r.status}): ${r.status === 401 ? 'API anahtarı geçersiz' : errText(r, 'err')}`);
    return r.body;
  }
  async function zendesk(cr, method, p, body, signal) {
    const d = cr.data; const sub = String(d.subdomain || '').replace(/\.zendesk\.com.*$/, '').replace(/^https?:\/\//, '').trim();
    if (!/^[\w-]+$/.test(sub)) throw new Error('Zendesk alt alan adı geçersiz');
    const r = await httpRequest({ method, url: `${env('N8N8_ZENDESK_API', `https://${sub}.zendesk.com/api/v2`)}${p}`, headers: { Authorization: `Basic ${Buffer.from(`${d.email}/token:${d.token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Zendesk (${r.status}): ${r.status === 401 ? 'e-posta ya da API anahtarı yanlış' : errText(r, 'details', 'description', 'error')}`);
    return r.body;
  }
  const zdTicket = t => ({ id: t.id, konu: t.subject, aciklama: t.description, durum: t.status, oncelik: t.priority, tur: t.type, isteyenId: t.requester_id, atananId: t.assignee_id, etiketler: t.tags || [], olusturuldu: t.created_at, guncellendi: t.updated_at, adres: t.url ? t.url.replace('/api/v2/tickets/', '/agent/tickets/').replace(/\.json$/, '') : null });
  const deeplBase = key => env('N8N8_DEEPL_API', /:fx$/.test(String(key || '').trim()) ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
  async function deepl(cr, method, p, body, signal) {
    const r = await httpRequest({ method, url: `${deeplBase(cr.data.key)}/v2${p}`, headers: { Authorization: `DeepL-Auth-Key ${String(cr.data.key || '').trim()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`DeepL (${r.status}): ${r.status === 403 ? 'API anahtarı geçersiz' : r.status === 456 ? 'aylık karakter sınırı doldu' : errText(r, 'message')}`);
    return r.body;
  }
  async function meta(cr, method, p, params = {}, signal) {
    const url = new URL(`${env('N8N8_META_API', 'https://graph.facebook.com/v21.0')}${p}`); const form = new URLSearchParams({ ...params, access_token: cr.data.token });
    if (method === 'GET') for (const [k, v] of form) url.searchParams.set(k, v);
    const r = await httpRequest({ method, url: url.toString(), headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : form.toString(), signal, timeout: 60000 });
    if (!r.ok || r.body?.error) { const e = r.body?.error || {}; throw new Error(`Meta (${r.status}): ${e.code === 190 ? 'erişim anahtarının süresi dolmuş ya da geçersiz' : e.code === 10 || e.code === 200 ? `izin eksik (${e.message})` : e.error_user_msg || e.message || errText(r)}`); }
    return r.body;
  }
  async function igUser(cr, signal) {
    if (cr.data.igUserId) return String(cr.data.igUserId).trim();
    const r = await meta(cr, 'GET', `/${encodeURIComponent(cr.data.pageId)}`, { fields: 'instagram_business_account' }, signal);
    if (!r.instagram_business_account?.id) throw new Error('Bu Facebook sayfasına bağlı bir Instagram işletme hesabı yok');
    return r.instagram_business_account.id;
  }

  const NODES = {
    rabbitmq: {
      label: 'RabbitMQ', cat: 'action', icon: 'send', inputs: 1, outputs: ['main'],
      desc: 'RabbitMQ kuyruğuna ya da değişimine (exchange) mesaj gönderir, kuyruktan mesaj alır ya da kuyruğu boşaltır. Mesajların sunucuya ulaştığı onayla (publisher confirm) beklenir.',
      params: [
        cred(['rabbitmq'], 'RabbitMQ sunucusu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'queue', options: [['queue', 'Kuyruğa gönder'], ['exchange', 'Değişime (exchange) gönder'], ['get', 'Kuyruktan mesaj al'], ['purge', 'Kuyruğu boşalt']] },
        { key: 'queue', label: 'Kuyruk', type: 'expr', def: 'siparisler', showIf: { op: ['queue', 'get', 'purge'] } },
        { key: 'exchange', label: 'Değişim (exchange)', type: 'expr', def: 'olaylar', showIf: { op: 'exchange' } },
        { key: 'exchangeType', label: 'Değişim türü', type: 'select', def: 'topic', options: [['topic', 'topic'], ['direct', 'direct'], ['fanout', 'fanout'], ['headers', 'headers']], showIf: { op: 'exchange' } },
        { key: 'routingKey', label: 'Yönlendirme anahtarı', type: 'expr', def: 'siparis.yeni', showIf: { op: 'exchange' } },
        { key: 'message', label: 'Mesaj', type: 'textarea', def: '', showIf: { op: ['queue', 'exchange'] }, help: 'Boş bırakılırsa öğenin tamamı JSON olarak gider.' },
        { key: 'durable', label: 'Kalıcı (sunucu yeniden başlasa da kalsın)', type: 'toggle', def: true, showIf: { op: ['queue', 'exchange'] } },
        { key: 'headers', label: 'Başlıklar', type: 'kv', def: [], showIf: { op: ['queue', 'exchange'] } },
        { key: 'max', label: 'En fazla mesaj', type: 'number', def: 10, min: 1, showIf: { op: 'get' } },
        { key: 'parse', label: 'JSON mesajları çöz', type: 'toggle', def: true, showIf: { op: 'get' } },
      ],
      sub: '{op} · {queue}',
      async run(c) {
        return withRabbit(c, async cl => {
          if (c.p.op === 'get') { const q = R0(c, 'queue'); await cl.declareQueue(q, { passive: true }); return [(await drain(cl, q, Math.max(1, Number(c.p.max) || 10), c.p.parse)).map(json => ({ json }))]; }
          if (c.p.op === 'purge') { const q = R0(c, 'queue'); return [[{ json: { kuyruk: q, silinen: await cl.purge(q) } }]]; }
          const declared = new Set();
          return forItems(c, async (R, it) => {
            const body = str(c.p.message).trim() ? R('message') : JSON.stringify(it.json);
            const headers = Object.fromEntries((c.p.headers || []).filter(x => x.key).map(x => [x.key, str(c.R(x.value, it, 0))]));
            const props = { contentType: str(c.p.message).trim() ? 'text/plain' : 'application/json', deliveryMode: c.p.durable ? 2 : 1, timestamp: Date.now(), ...(Object.keys(headers).length ? { headers } : {}) };
            let ex = '', key;
            if (c.p.op === 'queue') { key = R('queue'); if (!declared.has(key)) { await cl.declareQueue(key, { durable: !!c.p.durable }); declared.add(key); } }
            else { ex = R('exchange'); key = R('routingKey'); if (!declared.has(`x:${ex}`)) { await cl.declareExchange(ex, c.p.exchangeType, { durable: !!c.p.durable }); declared.add(`x:${ex}`); } }
            await cl.publish(ex, key, body, props);
            return { ...it.json, rabbitmq: { gonderildi: true, ...(ex ? { degisim: ex } : {}), anahtar: key } };
          });
        });
      },
    },
    rabbitmqTrigger: {
      label: 'RabbitMQ mesajı gelince', cat: 'trigger', icon: 'bolt', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'RabbitMQ kuyruğunu düzenli kontrol eder; gelen her mesajda akışı çalıştırır. Mesajlar alınınca onaylanır (ack), kuyrukta beklerken program kapalı olsa da kaybolmaz.',
      params: pollParams(5, 's', [
        cred(['rabbitmq'], 'RabbitMQ sunucusu'),
        { key: 'queue', label: 'Kuyruk', type: 'text', def: 'siparisler' },
        { key: 'bind', label: 'Değişime bağla (isteğe bağlı): değişim adı', type: 'text', def: '', help: 'Örnek: olaylar. Boşsa yalnızca kuyruk dinlenir.' },
        { key: 'bindKey', label: 'Bağlama anahtarı', type: 'text', def: '#', help: 'topic değişiminde siparis.* gibi desenler.' },
        { key: 'max', label: 'Her kontrolde en fazla', type: 'number', def: 50, min: 1 },
        { key: 'parse', label: 'JSON mesajları çöz', type: 'toggle', def: true },
      ]),
      async poll(c) {
        const q = str(c.p.queue).trim(); if (!q) throw new Error('Kuyruk adı boş');
        const cl = await AMQP.connect((await c.credential(c.p.credential)).data);
        try {
          await cl.declareQueue(q, { durable: true });
          if (str(c.p.bind).trim()) { await cl.declareExchange(str(c.p.bind).trim(), 'topic', { durable: true }); await cl.bind(q, str(c.p.bind).trim(), str(c.p.bindKey).trim() || '#'); }
          return await drain(cl, q, Math.max(1, Number(c.p.max) || 50), c.p.parse);
        } finally { await cl.close(); }
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { mesaj: { siparisId: 1001, tutar: 450 }, kuyruk: 'siparisler', degisim: '', yenidenTeslim: false, ozellikler: { contentType: 'application/json' } } }]]; },
      eachItem: true,
    },

    dropbox: {
      label: 'Dropbox', cat: 'app', icon: 'folder', inputs: 1, outputs: ['main'],
      desc: 'Dropbox\'a dosya yükler, indirir, klasörü listeler, siler, taşır ve paylaşım bağlantısı oluşturur.',
      params: [
        cred(['dropboxOAuth'], 'Dropbox hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upload', options: [['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['list', 'Klasörü listele'], ['move', 'Taşı / yeniden adlandır'], ['delete', 'Sil'], ['link', 'Paylaşım bağlantısı']] },
        { key: 'path', label: 'Dropbox\'taki yol', type: 'expr', def: '/Belgeler/{{ $json.ad }}', showIf: { op: ['upload', 'download', 'move', 'delete', 'link'] } },
        { key: 'folder', label: 'Klasör (boş = ana klasör)', type: 'expr', def: '', showIf: { op: 'list' } },
        { key: 'source', label: 'Yüklenecek', type: 'select', def: 'file', options: [['file', 'Dosya klasöründeki dosya'], ['text', 'Yazdığım metin']], showIf: { op: 'upload' } },
        { key: 'file', label: 'Dosya', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload', source: 'file' } },
        { key: 'content', label: 'Metin', type: 'textarea', def: '', showIf: { op: 'upload', source: 'text' } },
        { key: 'overwrite', label: 'Aynı adda dosya varsa üzerine yaz', type: 'toggle', def: true, showIf: { op: 'upload' } },
        { key: 'target', label: 'Kaydedilecek dosya (boş = dropbox/<ad>)', type: 'expr', def: '', showIf: { op: 'download' } },
        { key: 'to', label: 'Yeni yol', type: 'expr', def: '/Arşiv/{{ $json.ad }}', showIf: { op: 'move' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'list') {
          let r = await dbx(cr, '/files/list_folder', { path: dbxPath(R0(c, 'folder')), limit: 2000 }, c.signal); const out = r.entries.map(dbxEntry);
          while (r.has_more && out.length < 10000) { r = await dbx(cr, '/files/list_folder/continue', { cursor: r.cursor }, c.signal); out.push(...r.entries.map(dbxEntry)); }
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (R, it, i) => {
          const p = dbxPath(R('path')); if (!p) throw new Error(`${i + 1}. öğede Dropbox yolu boş`);
          if (c.p.op === 'upload') {
            const data = c.p.source === 'text' ? Buffer.from(R('content')) : readLocal(R('file'), i);
            if (data.length > 150 * 1048576) throw new Error('Dropbox tek seferde en fazla 150 MB yüklemeye izin verir');
            const r = await rawFetch(`${env('N8N8_DROPBOX_CONTENT', 'https://content.dropboxapi.com')}/2/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${await oauth.accessToken(cr)}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dbxArg({ path: p, mode: c.p.overwrite ? 'overwrite' : 'add', autorename: !c.p.overwrite, mute: true }) }, body: data, signal: c.signal });
            const b = JSON.parse(r.buf.toString() || '{}'); if (!r.ok) throw new Error(`Dropbox (${r.status}): ${dbxErr(b)}`);
            return { ...it.json, dropbox: dbxEntry({ ...b, '.tag': 'file' }) };
          }
          if (c.p.op === 'download') {
            const r = await rawFetch(`${env('N8N8_DROPBOX_CONTENT', 'https://content.dropboxapi.com')}/2/files/download`, { method: 'POST', headers: { Authorization: `Bearer ${await oauth.accessToken(cr)}`, 'Dropbox-API-Arg': dbxArg({ path: p }) }, signal: c.signal });
            if (!r.ok) { let b = {}; try { b = JSON.parse(r.buf.toString()); } catch {} throw new Error(`Dropbox (${r.status}): ${dbxErr(b)}`); }
            const f = save(R('target') || `dropbox/${path.posix.basename(p)}`, r.buf); return { ...it.json, dosya: rel(f), boyut: r.buf.length };
          }
          if (c.p.op === 'move') { const r = await dbx(cr, '/files/move_v2', { from_path: p, to_path: dbxPath(R('to')), autorename: false }, c.signal); return { ...it.json, dropbox: dbxEntry(r.metadata) }; }
          if (c.p.op === 'delete') { await dbx(cr, '/files/delete_v2', { path: p }, c.signal); return { ...it.json, silindi: p }; }
          let url;
          try { url = (await dbx(cr, '/sharing/create_shared_link_with_settings', { path: p, settings: { requested_visibility: 'public' } }, c.signal)).url; }
          catch (e) { if (!/shared_link_already_exists/.test(e.summary || '')) throw e; url = (await dbx(cr, '/sharing/list_shared_links', { path: p, direct_only: true }, c.signal)).links?.[0]?.url; }
          return { ...it.json, baglanti: url, indirmeBaglantisi: url ? url.replace(/([?&])dl=0/, '$1dl=1') : null };
        });
      },
    },

    onedrive: {
      label: 'OneDrive', cat: 'app', icon: 'folder', inputs: 1, outputs: ['main'],
      desc: 'OneDrive\'a (Microsoft 365) dosya yükler, indirir, klasörü listeler, siler ve paylaşım bağlantısı oluşturur. Microsoft hesabı kimlik bilgisini kullanır.',
      params: [
        cred(['microsoftOAuth'], 'Microsoft hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upload', options: [['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['list', 'Klasörü listele'], ['delete', 'Sil'], ['link', 'Paylaşım bağlantısı']] },
        { key: 'path', label: 'OneDrive\'daki yol', type: 'expr', def: 'Belgeler/{{ $json.ad }}', showIf: { op: ['upload', 'download', 'delete', 'link'] } },
        { key: 'folder', label: 'Klasör (boş = ana klasör)', type: 'expr', def: '', showIf: { op: 'list' } },
        { key: 'source', label: 'Yüklenecek', type: 'select', def: 'file', options: [['file', 'Dosya klasöründeki dosya'], ['text', 'Yazdığım metin']], showIf: { op: 'upload' } },
        { key: 'file', label: 'Dosya', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload', source: 'file' } },
        { key: 'content', label: 'Metin', type: 'textarea', def: '', showIf: { op: 'upload', source: 'text' } },
        { key: 'target', label: 'Kaydedilecek dosya (boş = onedrive/<ad>)', type: 'expr', def: '', showIf: { op: 'download' } },
        { key: 'scope', label: 'Bağlantıyı kimler açabilir', type: 'select', def: 'anonymous', options: [['anonymous', 'Bağlantıya sahip herkes'], ['organization', 'Yalnız kuruluşum']], showIf: { op: 'link' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'list') {
          const out = []; let next = `${odItem(R0(c, 'folder'))}/children?$top=200`;
          while (next && out.length < 10000) { const r = await graph(cr, 'GET', next, null, c.signal); out.push(...r.value.map(odEntry)); next = r['@odata.nextLink']; }
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (R, it, i) => {
          const p = R('path'); if (!odPath(p)) throw new Error(`${i + 1}. öğede OneDrive yolu boş`);
          if (c.p.op === 'upload') {
            const data = c.p.source === 'text' ? Buffer.from(R('content')) : readLocal(R('file'), i);
            let item;
            if (data.length <= 4 * 1048576) item = await graph(cr, 'PUT', `${odItem(p)}/content`, data, c.signal, { 'Content-Type': 'application/octet-stream' });
            else {
              const s = await graph(cr, 'POST', `${odItem(p)}/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'replace' } }, c.signal);
              const CH = 10 * 327680; // multiple of 320 KiB
              for (let o = 0; o < data.length; o += CH) {
                c.checkAbort(); const part = data.subarray(o, o + CH);
                const r = await rawFetch(s.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${o}-${o + part.length - 1}/${data.length}`, 'Content-Length': String(part.length) }, body: part, signal: c.signal });
                if (!r.ok) throw new Error(`OneDrive yükleme (${r.status}): ${r.buf.toString().slice(0, 200)}`);
                if (r.status === 200 || r.status === 201) item = JSON.parse(r.buf.toString());
              }
            }
            return { ...it.json, onedrive: odEntry(item) };
          }
          if (c.p.op === 'download') {
            const r = await rawFetch(`${GRAPH()}${odItem(p)}/content`, { headers: { Authorization: `Bearer ${await oauth.accessToken(cr)}` }, signal: c.signal });
            if (!r.ok) throw new Error(`OneDrive (${r.status}): ${r.status === 404 ? 'dosya bulunamadı' : r.buf.toString().slice(0, 200)}`);
            const f = save(R('target') || `onedrive/${path.posix.basename(p)}`, r.buf); return { ...it.json, dosya: rel(f), boyut: r.buf.length };
          }
          if (c.p.op === 'delete') { await graph(cr, 'DELETE', odItem(p), null, c.signal); return { ...it.json, silindi: p }; }
          const r = await graph(cr, 'POST', `${odItem(p)}/createLink`, { type: 'view', scope: c.p.scope || 'anonymous' }, c.signal);
          return { ...it.json, baglanti: r.link?.webUrl };
        });
      },
    },

    pipedrive: {
      label: 'Pipedrive', cat: 'app', icon: 'board', inputs: 1, outputs: ['main'],
      desc: 'Pipedrive CRM\'de kişiyi e-postasına göre bulur ya da ekler, fırsat (deal) açar, fırsatın aşamasını ya da durumunu değiştirir, not ve aktivite ekler, fırsatları listeler.',
      params: [
        cred(['pipedriveApi'], 'Pipedrive hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'person', options: [['person', 'Kişiyi bul ya da ekle'], ['deal', 'Fırsat oluştur'], ['dealUpdate', 'Fırsatı güncelle'], ['note', 'Not ekle'], ['activity', 'Aktivite ekle'], ['deals', 'Fırsatları listele']] },
        { key: 'name', label: 'Ad soyad', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'person' } },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'person' } },
        { key: 'phone', label: 'Telefon', type: 'expr', def: '{{ $json.telefon }}', showIf: { op: 'person' } },
        { key: 'title', label: 'Fırsat başlığı', type: 'expr', def: '{{ $json.ad }} - teklif', showIf: { op: 'deal' } },
        { key: 'value', label: 'Tutar', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: 'deal' } },
        { key: 'currency', label: 'Para birimi', type: 'text', def: 'TRY', showIf: { op: 'deal' } },
        { key: 'personId', label: 'Kişi ID', type: 'expr', def: '{{ $json.kisiId }}', showIf: { op: ['deal', 'activity'] } },
        { key: 'dealId', label: 'Fırsat ID', type: 'expr', def: '{{ $json.firsatId }}', showIf: { op: ['dealUpdate', 'note', 'activity'] } },
        { key: 'stageId', label: 'Yeni aşama ID (boş = değiştirme)', type: 'expr', def: '', showIf: { op: 'dealUpdate' } },
        { key: 'status', label: 'Durum', type: 'select', def: '', options: [['', 'Değiştirme'], ['won', 'Kazanıldı'], ['lost', 'Kaybedildi'], ['open', 'Açık']], showIf: { op: 'dealUpdate' } },
        { key: 'note', label: 'Not', type: 'textarea', def: '', showIf: { op: 'note' } },
        { key: 'subject', label: 'Aktivite konusu', type: 'expr', def: 'Müşteriyi ara', showIf: { op: 'activity' } },
        { key: 'activityType', label: 'Tür', type: 'select', def: 'call', options: [['call', 'Arama'], ['meeting', 'Toplantı'], ['task', 'Görev'], ['email', 'E-posta'], ['deadline', 'Son tarih']], showIf: { op: 'activity' } },
        { key: 'due', label: 'Tarih (YYYY-AA-GG, boş = bugün)', type: 'expr', def: '', showIf: { op: 'activity' } },
        { key: 'dealStatus', label: 'Durum', type: 'select', def: 'open', options: [['open', 'Açık'], ['won', 'Kazanılan'], ['lost', 'Kaybedilen'], ['all_not_deleted', 'Hepsi']], showIf: { op: 'deals' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'deals' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const deal = d => ({ firsatId: d.id, baslik: d.title, tutar: d.value, paraBirimi: d.currency, durum: d.status, asamaId: d.stage_id, kisiId: d.person_id?.value ?? d.person_id ?? null, kisi: d.person_id?.name ?? d.person_name ?? null, eklendi: d.add_time });
        if (c.p.op === 'deals') { const r = await pd(cr, 'GET', `/deals?status=${encodeURIComponent(c.p.dealStatus || 'open')}&limit=${Math.min(500, Math.max(1, Number(c.p.max) || 100))}`, null, c.signal); return [(r.data || []).map(d => ({ json: deal(d) }))]; }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'person') {
            const email = R('email');
            if (email) { const s = await pd(cr, 'GET', `/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&limit=1`, null, c.signal); const f = s.data?.items?.[0]?.item; if (f) return { ...it.json, kisiId: f.id, yeniKisi: false }; }
            const r = await pd(cr, 'POST', '/persons', { name: R('name') || email || 'İsimsiz', ...(email ? { email: [{ value: email, primary: true }] } : {}), ...(R('phone') ? { phone: [{ value: R('phone'), primary: true }] } : {}) }, c.signal);
            return { ...it.json, kisiId: r.data.id, yeniKisi: true };
          }
          if (c.p.op === 'deal') {
            const v = Number(String(R('value')).replace(/\./g, '').replace(',', '.')) || 0;
            const r = await pd(cr, 'POST', '/deals', { title: R('title'), value: v, currency: str(c.p.currency).trim() || 'TRY', ...(R('personId') ? { person_id: Number(R('personId')) } : {}) }, c.signal);
            return { ...it.json, ...deal(r.data) };
          }
          const dealId = R('dealId'); if (!/^\d+$/.test(dealId) && c.p.op !== 'activity') throw new Error(`Fırsat ID sayı olmalı: "${dealId}"`);
          if (c.p.op === 'dealUpdate') { const body = { ...(R('stageId') ? { stage_id: Number(R('stageId')) } : {}), ...(c.p.status ? { status: c.p.status } : {}) }; if (!Object.keys(body).length) throw new Error('Değiştirilecek bir şey seçilmedi'); const r = await pd(cr, 'PUT', `/deals/${dealId}`, body, c.signal); return { ...it.json, ...deal(r.data) }; }
          if (c.p.op === 'note') { const r = await pd(cr, 'POST', '/notes', { content: R('note'), deal_id: Number(dealId) }, c.signal); return { ...it.json, notId: r.data.id }; }
          const due = R('due') || new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
          const r = await pd(cr, 'POST', '/activities', { subject: R('subject'), type: c.p.activityType, due_date: due, ...(/^\d+$/.test(dealId) ? { deal_id: Number(dealId) } : {}), ...(R('personId') ? { person_id: Number(R('personId')) } : {}) }, c.signal);
          return { ...it.json, aktiviteId: r.data.id };
        });
      },
    },

    asana: {
      label: 'Asana', cat: 'app', icon: 'check', inputs: 1, outputs: ['main'],
      desc: 'Asana\'da projeye görev ekler, görevi tamamlar, yorum yazar ya da projedeki görevleri listeler.',
      params: [
        cred(['asanaApi'], 'Asana hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Görev oluştur'], ['complete', 'Görevi tamamla'], ['comment', 'Yorum yaz'], ['list', 'Projedeki görevler']] },
        { key: 'project', label: 'Proje (kimlik ya da bağlantı)', type: 'expr', def: '', showIf: { op: ['create', 'list'] }, help: 'Projeyi tarayıcıda açıp adresini yapıştırabilirsiniz.' },
        { key: 'name', label: 'Görev adı', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'notes', label: 'Açıklama', type: 'textarea', def: '', showIf: { op: 'create' } },
        { key: 'due', label: 'Bitiş tarihi (YYYY-AA-GG)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'assignee', label: 'Atanacak kişi (e-posta, boş = kimse)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'task', label: 'Görev (kimlik ya da bağlantı)', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['complete', 'comment'] } },
        { key: 'text', label: 'Yorum', type: 'textarea', def: '', showIf: { op: 'comment' } },
        { key: 'open', label: 'Yalnız tamamlanmamışlar', type: 'toggle', def: true, showIf: { op: 'list' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        // accepts a bare id or a link: /0/<proje>/list, /0/<proje>/<görev>/f, /1/<alan>/project/<proje>/task/<görev>
        const gid = (v, kind) => {
          const t = String(v).trim(); if (/^\d+$/.test(t)) return t;
          const named = t.match(new RegExp(`/${kind === 'task' ? 'task' : 'project'}/(\\d+)`)); if (named) return named[1];
          const old = t.match(/\/0\/(\d+)(?:\/(\d+))?/); const id = old && (kind === 'task' ? old[2] || old[1] : old[1]);
          if (!id) throw new Error(`Asana ${kind === 'task' ? 'görev' : 'proje'} kimliği anlaşılamadı: "${v}"`); return id;
        };
        const task = t => ({ id: t.gid, ad: t.name, tamamlandi: !!t.completed, bitis: t.due_on || null, atanan: t.assignee?.name ?? null, adres: t.permalink_url || null });
        if (c.p.op === 'list') {
          const out = []; let off = '';
          do { const r = await httpRequest({ url: `${env('N8N8_ASANA_API', 'https://app.asana.com/api/1.0')}/projects/${gid(R0(c, 'project'), 'project')}/tasks?opt_fields=name,completed,due_on,assignee.name,permalink_url&limit=100${c.p.open ? '&completed_since=now' : ''}${off ? `&offset=${off}` : ''}`, headers: { Authorization: `Bearer ${cr.data.token}` }, signal: c.signal, timeout: 60000 }); if (!r.ok) throw new Error(`Asana (${r.status}): ${(r.body?.errors || []).map(e => e.message).join('; ')}`); out.push(...r.body.data.map(task)); off = r.body.next_page?.offset || ''; } while (off && out.length < 5000);
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'create') { const t = await asana(cr, 'POST', '/tasks?opt_fields=name,completed,due_on,assignee.name,permalink_url', { name: R('name') || '(adsız görev)', notes: R('notes'), projects: [gid(R('project'), 'project')], ...(R('due') ? { due_on: R('due') } : {}), ...(R('assignee') ? { assignee: R('assignee') } : {}) }, c.signal); return { ...it.json, ...task(t) }; }
          if (c.p.op === 'complete') { const t = await asana(cr, 'PUT', `/tasks/${gid(R('task'), 'task')}?opt_fields=name,completed,due_on,assignee.name,permalink_url`, { completed: true }, c.signal); return { ...it.json, ...task(t) }; }
          const s = await asana(cr, 'POST', `/tasks/${gid(R('task'), 'task')}/stories`, { text: R('text') }, c.signal); return { ...it.json, yorumId: s.gid };
        });
      },
    },

    clickup: {
      label: 'ClickUp', cat: 'app', icon: 'check', inputs: 1, outputs: ['main'],
      desc: 'ClickUp listesine görev ekler, görevin durumunu değiştirir, yorum yazar ya da listedeki görevleri getirir.',
      params: [
        cred(['clickupApi'], 'ClickUp hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Görev oluştur'], ['status', 'Durumu değiştir'], ['comment', 'Yorum yaz'], ['list', 'Listedeki görevler']] },
        { key: 'list', label: 'Liste kimliği', type: 'expr', def: '', showIf: { op: ['create', 'list'] }, help: 'Listeyi açınca adres çubuğundaki /li/ sonrasındaki sayı.' },
        { key: 'name', label: 'Görev adı', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '', showIf: { op: 'create' } },
        { key: 'priority', label: 'Öncelik', type: 'select', def: '3', options: [['1', 'Acil'], ['2', 'Yüksek'], ['3', 'Normal'], ['4', 'Düşük']], showIf: { op: 'create' } },
        { key: 'due', label: 'Bitiş tarihi (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'task', label: 'Görev kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['status', 'comment'] } },
        { key: 'status', label: 'Yeni durum (listedeki adıyla)', type: 'expr', def: 'complete', showIf: { op: 'status' } },
        { key: 'text', label: 'Yorum', type: 'textarea', def: '', showIf: { op: 'comment' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const task = t => ({ id: t.id, ad: t.name, durum: t.status?.status ?? null, oncelik: t.priority?.priority ?? null, bitis: t.due_date ? new Date(Number(t.due_date)).toISOString() : null, adres: t.url || null });
        if (c.p.op === 'list') return [((await clickup(cr, 'GET', `/list/${encodeURIComponent(R0(c, 'list'))}/task?archived=false&subtasks=true`, null, c.signal)).tasks || []).map(t => ({ json: task(t) }))];
        return forItems(c, async (R, it) => {
          if (c.p.op === 'create') {
            const due = R('due'); const ms = due ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T17:00:00+03:00` : due) : NaN;
            if (due && !Number.isFinite(ms)) throw new Error(`Bitiş tarihi anlaşılamadı: "${due}"`);
            return { ...it.json, ...task(await clickup(cr, 'POST', `/list/${encodeURIComponent(R('list'))}/task`, { name: R('name') || '(adsız görev)', description: R('description'), priority: Number(c.p.priority) || 3, ...(due ? { due_date: ms, due_date_time: !/^\d{4}-\d{2}-\d{2}$/.test(due) } : {}) }, c.signal)) };
          }
          if (c.p.op === 'status') return { ...it.json, ...task(await clickup(cr, 'PUT', `/task/${encodeURIComponent(R('task'))}`, { status: R('status') }, c.signal)) };
          const r = await clickup(cr, 'POST', `/task/${encodeURIComponent(R('task'))}/comment`, { comment_text: R('text'), notify_all: false }, c.signal); return { ...it.json, yorumId: r.id };
        });
      },
    },

    deepl: {
      label: 'DeepL çeviri', cat: 'ai', icon: 'type', inputs: 1, outputs: ['main'],
      desc: 'Metni DeepL ile çevirir (Türkçe dahil 30\'dan fazla dil); kaynak dili kendiliğinden bulur. Kalan karakter hakkını da gösterebilir.',
      params: [
        cred(['deeplApi'], 'DeepL hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'translate', options: [['translate', 'Çevir'], ['usage', 'Kalan karakter hakkı']] },
        { key: 'text', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'translate' } },
        { key: 'target', label: 'Hedef dil', type: 'select', def: 'EN-US', options: [['TR', 'Türkçe'], ['EN-US', 'İngilizce (ABD)'], ['EN-GB', 'İngilizce (Birleşik Krallık)'], ['DE', 'Almanca'], ['FR', 'Fransızca'], ['ES', 'İspanyolca'], ['IT', 'İtalyanca'], ['NL', 'Felemenkçe'], ['RU', 'Rusça'], ['UK', 'Ukraynaca'], ['AR', 'Arapça'], ['ZH-HANS', 'Çince (basitleştirilmiş)'], ['JA', 'Japonca'], ['KO', 'Korece'], ['PT-BR', 'Portekizce (Brezilya)'], ['PL', 'Lehçe'], ['EL', 'Yunanca'], ['BG', 'Bulgarca'], ['RO', 'Rumence'], ['SV', 'İsveççe']], showIf: { op: 'translate' } },
        { key: 'source', label: 'Kaynak dil (boş = kendiliğinden bul)', type: 'text', def: '', showIf: { op: 'translate' } },
        { key: 'formality', label: 'Hitap', type: 'select', def: 'default', options: [['default', 'Varsayılan'], ['prefer_more', 'Resmî (siz)'], ['prefer_less', 'Samimi (sen)']], showIf: { op: 'translate' } },
        { key: 'html', label: 'Metin HTML (etiketleri koru)', type: 'toggle', def: false, showIf: { op: 'translate' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'ceviri', showIf: { op: 'translate' } },
      ],
      sub: '→ {target}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'usage') { const u = await deepl(cr, 'GET', '/usage', null, c.signal); return [[{ json: { kullanilan: u.character_count, sinir: u.character_limit, kalan: u.character_limit - u.character_count } }]]; }
        const its = items(c); const texts = its.map((it, i) => str(c.R(c.p.text, it, i))); const out = []; const f = str(c.p.output).trim() || 'ceviri';
        for (let i = 0; i < texts.length; i += 50) {
          c.checkAbort(); const part = texts.slice(i, i + 50);
          const r = await deepl(cr, 'POST', '/translate', { text: part, target_lang: c.p.target || 'EN-US', ...(str(c.p.source).trim() ? { source_lang: str(c.p.source).trim().toUpperCase() } : {}), ...(c.p.formality && c.p.formality !== 'default' ? { formality: c.p.formality } : {}), ...(c.p.html ? { tag_handling: 'html' } : {}) }, c.signal);
          r.translations.forEach((t, k) => out.push({ json: { ...its[i + k].json, [f]: t.text, kaynakDil: t.detected_source_language } }));
        }
        return [out];
      },
    },

    zendesk: {
      label: 'Zendesk', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'Zendesk\'te destek talebi açar, talebe yanıt ya da iç not yazar, durumunu değiştirir, talebi getirir ya da arar.',
      params: [
        cred(['zendeskApi'], 'Zendesk hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Talep oluştur'], ['update', 'Yanıt yaz / durum değiştir'], ['get', 'Talebi getir'], ['search', 'Talepleri ara']] },
        { key: 'subject', label: 'Konu', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'body', label: 'Mesaj', type: 'textarea', def: '{{ $json.mesaj }}', showIf: { op: ['create', 'update'] } },
        { key: 'name', label: 'Müşteri adı', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'create' } },
        { key: 'email', label: 'Müşteri e-postası', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'create' } },
        { key: 'priority', label: 'Öncelik', type: 'select', def: 'normal', options: [['low', 'Düşük'], ['normal', 'Normal'], ['high', 'Yüksek'], ['urgent', 'Acil']], showIf: { op: 'create' } },
        { key: 'tags', label: 'Etiketler (virgülle)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'ticket', label: 'Talep numarası', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['update', 'get'] } },
        { key: 'public', label: 'Müşteriye görünsün (kapalı = iç not)', type: 'toggle', def: true, showIf: { op: 'update' } },
        { key: 'status', label: 'Yeni durum', type: 'select', def: '', options: [['', 'Değiştirme'], ['open', 'Açık'], ['pending', 'Beklemede'], ['solved', 'Çözüldü']], showIf: { op: 'update' } },
        { key: 'query', label: 'Arama', type: 'expr', def: 'status<solved', showIf: { op: 'search' }, help: 'Zendesk arama dili: status<solved, priority:urgent, requester:ali@ornek.com, tags:iade' },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: 'search' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'search') { const r = await zendesk(cr, 'GET', `/search.json?query=${encodeURIComponent(`type:ticket ${R0(c, 'query')}`)}&per_page=${Math.min(100, Math.max(1, Number(c.p.max) || 50))}`, null, c.signal); return [(r.results || []).map(t => ({ json: zdTicket(t) }))]; }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'create') {
            const tags = R('tags').split(',').map(x => x.trim()).filter(Boolean);
            const r = await zendesk(cr, 'POST', '/tickets.json', { ticket: { subject: R('subject') || '(konusuz)', comment: { body: R('body') }, priority: c.p.priority, ...(R('email') ? { requester: { name: R('name') || R('email'), email: R('email') } } : {}), ...(tags.length ? { tags } : {}) } }, c.signal);
            return { ...it.json, ...zdTicket(r.ticket) };
          }
          const id = R('ticket'); if (!/^\d+$/.test(id)) throw new Error(`Talep numarası sayı olmalı: "${id}"`);
          if (c.p.op === 'get') return { ...it.json, ...zdTicket((await zendesk(cr, 'GET', `/tickets/${id}.json`, null, c.signal)).ticket) };
          const t = { ...(R('body') ? { comment: { body: R('body'), public: !!c.p.public } } : {}), ...(c.p.status ? { status: c.p.status } : {}) };
          if (!Object.keys(t).length) throw new Error('Mesaj ya da yeni durum gerekli');
          return { ...it.json, ...zdTicket((await zendesk(cr, 'PUT', `/tickets/${id}.json`, { ticket: t }, c.signal)).ticket) };
        });
      },
    },
    zendeskTrigger: {
      label: 'Zendesk\'te yeni talep', cat: 'trigger', icon: 'chat', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Zendesk\'i düzenli kontrol eder; her yeni destek talebinde akışı çalıştırır.',
      params: pollParams(1, 'm', [cred(['zendeskApi'], 'Zendesk hesabı')]),
      async poll(c) { const r = await zendesk(await c.credential(c.p.credential), 'GET', '/tickets.json?sort_by=created_at&sort_order=desc&per_page=50', null); return newOnly(c, r.tickets || [], t => t.id).map(zdTicket); },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { id: 101, konu: 'Siparişim gelmedi', aciklama: 'Merhaba, 3 gündür bekliyorum.', durum: 'new', oncelik: 'normal', etiketler: [], olusturuldu: new Date().toISOString() } }]]; },
      eachItem: true,
    },

    facebook: {
      label: 'Facebook sayfası / Instagram', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'Facebook sayfanızda metin, bağlantı ya da fotoğraf paylaşır; Instagram işletme hesabınızda fotoğraf paylaşır; gönderi yorumlarını getirir ve yorumlara yanıt yazar.',
      params: [
        cred(['metaPage'], 'Facebook sayfası'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'post', options: [['post', 'Facebook\'ta paylaş'], ['photo', 'Facebook\'ta fotoğraf paylaş'], ['igPost', 'Instagram\'da fotoğraf paylaş'], ['posts', 'Sayfa gönderilerini getir'], ['comments', 'Gönderi yorumlarını getir'], ['reply', 'Yoruma yanıt yaz']] },
        { key: 'message', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: ['post', 'photo', 'igPost', 'reply'] } },
        { key: 'link', label: 'Bağlantı (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'post' } },
        { key: 'image', label: 'Resim adresi (herkese açık https)', type: 'expr', def: '{{ $json.resim }}', showIf: { op: ['photo', 'igPost'] }, help: 'Instagram ve Facebook resmi bu adresten kendisi indirir; JPEG önerilir.' },
        { key: 'postId', label: 'Gönderi kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'comments' } },
        { key: 'commentId', label: 'Yorum kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'reply' } },
        { key: 'platform', label: 'Platform', type: 'select', def: 'facebook', options: [['facebook', 'Facebook'], ['instagram', 'Instagram']], showIf: { op: ['comments', 'reply', 'posts'] } },
        { key: 'max', label: 'En fazla', type: 'number', def: 25, min: 1, showIf: { op: ['posts', 'comments'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const page = encodeURIComponent(String(cr.data.pageId || '').trim()); const max = String(Math.min(100, Math.max(1, Number(c.p.max) || 25)));
        if (c.p.op === 'posts') {
          if (c.p.platform === 'instagram') { const r = await meta(cr, 'GET', `/${await igUser(cr, c.signal)}/media`, { fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count', limit: max }, c.signal); return [(r.data || []).map(m => ({ json: { id: m.id, metin: m.caption || '', tur: m.media_type, resim: m.media_url, adres: m.permalink, tarih: m.timestamp, begeni: m.like_count ?? null, yorum: m.comments_count ?? null } }))]; }
          const r = await meta(cr, 'GET', `/${page}/posts`, { fields: 'id,message,created_time,permalink_url', limit: max }, c.signal); return [(r.data || []).map(p => ({ json: { id: p.id, metin: p.message || '', tarih: p.created_time, adres: p.permalink_url } }))];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'post') { const r = await meta(cr, 'POST', `/${page}/feed`, { message: R('message'), ...(R('link') ? { link: R('link') } : {}) }, c.signal); return { ...it.json, gonderiId: r.id }; }
          if (c.p.op === 'photo') { const img = R('image'); if (!/^https:\/\//.test(img)) throw new Error(`Resim adresi https ile başlamalı: "${img}"`); const r = await meta(cr, 'POST', `/${page}/photos`, { url: img, caption: R('message') }, c.signal); return { ...it.json, gonderiId: r.post_id || r.id }; }
          if (c.p.op === 'igPost') {
            const img = R('image'); if (!/^https:\/\//.test(img)) throw new Error(`Resim adresi https ile başlamalı: "${img}"`);
            if (R('message').length > 2200) throw new Error('Instagram açıklaması en fazla 2200 karakter olabilir');
            const ig = await igUser(cr, c.signal);
            const box = await meta(cr, 'POST', `/${ig}/media`, { image_url: img, caption: R('message') }, c.signal);
            for (let k = 0; k < 15; k++) { const s = await meta(cr, 'GET', `/${box.id}`, { fields: 'status_code' }, c.signal); if (s.status_code === 'FINISHED' || !s.status_code) break; if (s.status_code === 'ERROR') throw new Error('Instagram resmi işleyemedi (biçim ya da boyut uygun değil)'); await new Promise(r => setTimeout(r, 2000)); }
            const r = await meta(cr, 'POST', `/${ig}/media_publish`, { creation_id: box.id }, c.signal);
            return { ...it.json, gonderiId: r.id };
          }
          if (c.p.op === 'comments') {
            const ig = c.p.platform === 'instagram';
            const r = await meta(cr, 'GET', `/${encodeURIComponent(R('postId'))}/comments`, { fields: ig ? 'id,text,username,timestamp' : 'id,message,from,created_time', limit: max }, c.signal);
            return (r.data || []).map(x => ({ id: x.id, gonderiId: R('postId'), metin: x.message ?? x.text ?? '', yazan: x.from?.name ?? x.username ?? null, tarih: x.created_time ?? x.timestamp }));
          }
          const id = encodeURIComponent(R('commentId'));
          const r = await meta(cr, 'POST', c.p.platform === 'instagram' ? `/${id}/replies` : `/${id}/comments`, { message: R('message') }, c.signal);
          return { ...it.json, yanitId: r.id };
        });
      },
    },
  };

  async function test(type, d) {
    const cr = { data: d };
    if (type === 'rabbitmq') { const cl = await AMQP.connect(d); await cl.close(); return `Bağlanıldı (vhost ${d.vhost || '/'})`; }
    if (type === 'pipedriveApi') { const r = await pd(cr, 'GET', '/users/me', null); return `Bağlanıldı: ${r.data?.name || ''} (${r.data?.company_name || ''})`; }
    if (type === 'asanaApi') { const r = await asana(cr, 'GET', '/users/me', null); return `Bağlanıldı: ${r.name}; çalışma alanları: ${(r.workspaces || []).map(w => w.name).join(', ')}`; }
    if (type === 'clickupApi') { const r = await clickup(cr, 'GET', '/user', null); return `Bağlanıldı: ${r.user?.username || r.user?.email}`; }
    if (type === 'deeplApi') { const u = await deepl(cr, 'GET', '/usage', null); return `Geçerli; bu ay ${u.character_count.toLocaleString('tr-TR')} / ${u.character_limit.toLocaleString('tr-TR')} karakter kullanıldı`; }
    if (type === 'zendeskApi') { const r = await zendesk(cr, 'GET', '/users/me.json', null); if (!r.user?.id) throw new Error('Zendesk: giriş başarısız (e-posta ya da API anahtarı yanlış)'); return `Bağlanıldı: ${r.user.name} (${r.user.role})`; }
    if (type === 'metaPage') { const r = await meta(cr, 'GET', `/${encodeURIComponent(d.pageId)}`, { fields: 'name,instagram_business_account' }); return `Sayfa: ${r.name}${r.instagram_business_account ? '; Instagram hesabı bağlı' : '; bağlı Instagram hesabı yok'}`; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
