'use strict';
/* App nodes: Notion, Slack (bot) and Microsoft 365 Outlook (OAuth "Microsoft hesabı" credential).
   Merged into NODES by nodes.js. N8N8_NOTION_API, N8N8_SLACK_API and N8N8_GRAPH_API point the nodes
   at another base URL (tests). */
const oauth = require('./oauth');

const CREDENTIAL_TYPES = {
  notionApi: { label: 'Notion', fields: [{ key: 'token', label: 'Entegrasyon anahtarı (Internal Integration Secret)', secret: true, help: 'notion.so/my-integrations → Yeni entegrasyon. Sonra kullanacağınız sayfa ya da veritabanında ••• → Bağlantılar → entegrasyonunuzu ekleyin.' }] },
  slackBot: { label: 'Slack botu', fields: [{ key: 'token', label: 'Bot token (xoxb-…)', secret: true, help: 'api.slack.com/apps → uygulamanız → OAuth & Permissions → Bot User OAuth Token. İzinler: chat:write, channels:read, channels:history, reactions:write. Botu kanala /invite ile ekleyin.' }] },
  microsoftOAuth: { label: 'Microsoft hesabı (Outlook / Microsoft 365)', oauth: true, fields: [
    { key: 'clientId', label: 'Uygulama (istemci) kimliği', help: 'portal.azure.com → Microsoft Entra ID → Uygulama kayıtları → Yeni kayıt. Platform: Web; aşağıdaki yönlendirme adresini ekleyin.' },
    { key: 'clientSecret', label: 'İstemci gizli dizisi (Değer)', secret: true, help: 'Sertifikalar ve gizli diziler → Yeni istemci gizli dizisi → "Değer" sütunu.' },
    { key: 'tenant', label: 'Kiracı (tenant)', def: 'common', help: '"common" kişisel ve iş hesaplarının ikisine de açıktır. Yalnız kendi şirketiniz için dizin (kiracı) kimliğini yazın.' }] },
};

module.exports = function appNodes(h) {
  const { httpRequest } = h;
  const NOTION = () => process.env.N8N8_NOTION_API || 'https://api.notion.com/v1';
  const SLACK = () => process.env.N8N8_SLACK_API || 'https://slack.com/api';
  const GRAPH = () => process.env.N8N8_GRAPH_API || 'https://graph.microsoft.com/v1.0';
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const forItems = async (c, fn) => {
    const items = c.items.length ? c.items : [{ json: {} }]; const out = [];
    for (let i = 0; i < items.length; i++) { c.checkAbort(); const r = await fn(items[i], i); if (r) out.push(...[].concat(r).map(json => ({ json }))); }
    return [out];
  };
  const htmlText = s => String(s || '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

  /* ---------- Notion ---------- */
  async function notion(cr, method, path, body, signal) {
    const r = await httpRequest({ method, url: NOTION() + path, headers: { Authorization: `Bearer ${cr.data.token}`, 'Notion-Version': '2022-06-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) {
      const msg = r.body?.message || '';
      throw new Error(`Notion (${r.status}): ${r.status === 401 ? 'entegrasyon anahtarı geçersiz' : r.status === 404 ? 'bulunamadı. Sayfa ya da veritabanını entegrasyonunuzla paylaştınız mı? (••• → Bağlantılar)' : msg || 'hata'}`);
    }
    return r.body;
  }
  // accepts a bare id, a dashed uuid or a full notion.so link
  const notionId = v => { const s = String(v || '').trim(); const m = s.replace(/[?#].*$/, '').replace(/-/g, '').match(/[0-9a-f]{32}/gi); if (!m) throw new Error(`Geçersiz Notion kimliği ya da bağlantısı: ${s || '(boş)'}`); return m[m.length - 1].toLowerCase(); };
  const plain = arr => (arr || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
  function propValue(p) {
    switch (p.type) {
      case 'title': case 'rich_text': return plain(p[p.type]);
      case 'number': case 'checkbox': case 'url': case 'email': case 'phone_number': case 'created_time': case 'last_edited_time': return p[p.type];
      case 'select': case 'status': return p[p.type]?.name ?? null;
      case 'multi_select': return p.multi_select.map(x => x.name);
      case 'date': return p.date ? (p.date.end ? { baslangic: p.date.start, bitis: p.date.end } : p.date.start) : null;
      case 'people': return p.people.map(x => x.name || x.id);
      case 'relation': return p.relation.map(x => x.id);
      case 'files': return p.files.map(f => f.file?.url || f.external?.url || f.name);
      case 'formula': return p.formula[p.formula.type];
      case 'rollup': return p.rollup.type === 'array' ? p.rollup.array.map(propValue) : p.rollup[p.rollup.type];
      case 'unique_id': return p.unique_id ? `${p.unique_id.prefix ? p.unique_id.prefix + '-' : ''}${p.unique_id.number}` : null;
      case 'created_by': case 'last_edited_by': return p[p.type]?.name || p[p.type]?.id;
      default: return null;
    }
  }
  const pageJson = pg => ({ ...Object.fromEntries(Object.entries(pg.properties || {}).map(([k, v]) => [k, propValue(v)])), id: pg.id, url: pg.url, olusturuldu: pg.created_time, degisti: pg.last_edited_time, ...(pg.archived ? { arsivde: true } : {}) });
  const rich = v => { const s = String(v ?? ''); const out = []; for (let i = 0; i < s.length || !out.length; i += 2000) out.push({ type: 'text', text: { content: s.slice(i, i + 2000) } }); return out; };
  const list = v => Array.isArray(v) ? v : String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  function propInput(type, v, name) {
    if (v === undefined) return undefined;
    const empty = v === null || v === '';
    switch (type) {
      case 'title': case 'rich_text': return { [type]: empty ? [] : rich(typeof v === 'object' ? JSON.stringify(v) : v) };
      case 'number': { if (empty) return { number: null }; const n = Number(v); if (Number.isNaN(n)) throw new Error(`"${name}" bir sayı olmalı: ${v}`); return { number: n }; }
      case 'checkbox': return { checkbox: typeof v === 'string' ? !/^(false|0|hayır|hayir|no|)$/i.test(v.trim()) : !!v };
      case 'select': case 'status': return { [type]: empty ? null : { name: String(v) } };
      case 'multi_select': return { multi_select: list(v).map(name => ({ name: String(name) })) };
      case 'date': return { date: empty ? null : typeof v === 'object' && !(v instanceof Date) ? { start: v.baslangic || v.start, end: v.bitis || v.end || null } : { start: String(v instanceof Date ? v.toISOString() : v) } };
      case 'url': case 'email': case 'phone_number': return { [type]: empty ? null : String(v) };
      case 'relation': return { relation: list(v).map(id => ({ id: notionId(id) })) };
      case 'people': return { people: list(v).map(id => ({ id: String(id) })) };
      default: throw new Error(`"${name}" alanının türü (${type}) bu node ile yazılamıyor`);
    }
  }
  const schemaCache = new WeakMap();
  async function dbSchema(c, cr, id) {
    let m = schemaCache.get(c); if (!m) schemaCache.set(c, m = new Map());
    if (!m.has(id)) m.set(id, notion(cr, 'GET', `/databases/${id}`, null, c.signal).then(d => d.properties));
    return m.get(id);
  }
  function buildProps(schema, fields, it, i, c) {
    const props = {};
    for (const f of fields || []) {
      if (!f.key) continue;
      const def = schema[f.key] || Object.entries(schema).find(([k]) => k.toLowerCase() === f.key.toLowerCase())?.[1];
      if (!def) throw new Error(`Veritabanında "${f.key}" adlı özellik yok. Var olanlar: ${Object.keys(schema).join(', ')}`);
      const v = propInput(def.type, c.R(f.value, it, i), f.key);
      if (v !== undefined) props[def.name || f.key] = v;
    }
    return props;
  }

  /* ---------- Slack ---------- */
  const SLACK_ERR = { not_in_channel: 'bot bu kanalda değil. Kanalda /invite @botunuz yazın', channel_not_found: 'kanal bulunamadı (özel kanalsa botu davet edin)', invalid_auth: 'bot token geçersiz', not_authed: 'bot token eksik', account_inactive: 'bot token iptal edilmiş', ratelimited: 'çok fazla istek; biraz sonra tekrar deneyin', message_not_found: 'mesaj bulunamadı', already_reacted: 'bu tepki zaten eklenmiş', invalid_name: 'geçersiz emoji adı', cant_update_message: 'bu mesaj güncellenemez (yalnız botun kendi mesajları)' };
  async function slack(cr, method, params = {}, { signal, get = false } = {}) {
    const headers = { Authorization: `Bearer ${cr.data.token}` };
    const r = get ? await httpRequest({ url: `${SLACK()}/${method}?${q(params)}`, headers, signal, timeout: 30000 })
      : await httpRequest({ method: 'POST', url: `${SLACK()}/${method}`, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params), signal, timeout: 30000 });
    if (r.status === 429) throw new Error('Slack: çok fazla istek; biraz sonra tekrar deneyin');
    if (!r.body?.ok) {
      const e = r.body?.error || `HTTP ${r.status}`;
      throw new Error(`Slack: ${e === 'missing_scope' ? `bot izni eksik (${r.body.needed}). Uygulama ayarlarında bu izni ekleyip uygulamayı yeniden kurun` : SLACK_ERR[e] || e}`);
    }
    return r.body;
  }
  // "#genel" or "genel" → channel id; ids (C…, G…, D…) pass through
  async function channelId(cr, ch, cache, signal) {
    const s = String(ch || '').trim(); if (!s) throw new Error('Kanal boş');
    if (/^[CGD][A-Z0-9]{6,}$/.test(s)) return s;
    const name = s.replace(/^#/, '').toLowerCase();
    if (!cache.channels) {
      cache.channels = []; let cursor;
      do { const r = await slack(cr, 'conversations.list', { limit: 1000, exclude_archived: 'true', types: 'public_channel,private_channel', cursor }, { signal, get: true }); cache.channels.push(...r.channels); cursor = r.response_metadata?.next_cursor; } while (cursor);
    }
    const f = cache.channels.find(x => x.name.toLowerCase() === name);
    if (!f) throw new Error(`Slack: "#${name}" kanalı bulunamadı (özel kanalsa botu davet edin ya da kanal kimliğini yazın)`);
    return f.id;
  }
  const slackMsg = (m, channel) => ({ ts: m.ts, kanal: channel, metin: m.text || '', kullanici: m.user || m.bot_id || '', zaman: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : '', ...(m.thread_ts ? { konuTs: m.thread_ts } : {}), ...(m.reply_count ? { yanitSayisi: m.reply_count } : {}), ...(m.subtype ? { tur: m.subtype } : {}) });

  /* ---------- Microsoft Graph (Outlook) ---------- */
  async function graph(cr, method, path, { body, signal } = {}) {
    const token = await oauth.accessToken(cr);
    const r = await httpRequest({ method, url: path.startsWith('http') ? path : GRAPH() + path, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) {
      const msg = r.body?.error?.message || '';
      throw new Error(`Outlook (${r.status}): ${r.status === 401 ? 'oturum geçersiz; kimlik bilgisinde "Hesaba bağlan" ile yeniden bağlanın' : r.status === 403 ? `izin yok. ${msg}` : msg || 'hata'}`);
    }
    return r.body;
  }
  const addr = a => a?.emailAddress ? (a.emailAddress.name && a.emailAddress.name !== a.emailAddress.address ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress.address) : '';
  const outlookJson = m => ({
    id: m.id, konuId: m.conversationId, kimden: addr(m.from), kime: (m.toRecipients || []).map(addr).join(', '), konu: m.subject || '', tarih: m.receivedDateTime || '', ozet: m.bodyPreview || '',
    metin: m.body ? (m.body.contentType === 'html' ? htmlText(m.body.content) : m.body.content) : '', ...(m.body?.contentType === 'html' ? { html: m.body.content } : {}),
    okunmadi: m.isRead === false, ekVar: !!m.hasAttachments, link: m.webLink,
  });
  const FOLDERS = [['inbox', 'Gelen kutusu'], ['sentitems', 'Gönderilmiş'], ['drafts', 'Taslaklar'], ['archive', 'Arşiv'], ['junkemail', 'Gereksiz']];
  async function listOutlook(cr, { folder = 'inbox', search = '', unread = false, max = 10 }, signal) {
    const top = Math.min(100, Math.max(1, Number(max) || 10));
    const sel = 'id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,body,isRead,hasAttachments,webLink';
    // Graph does not allow $search together with $orderby/$filter, so a search filters unread on our side
    const params = search ? { $search: `"${String(search).replace(/"/g, '')}"`, $top: top, $select: sel } : { $top: top, $select: sel, $orderby: 'receivedDateTime desc', ...(unread ? { $filter: 'isRead eq false' } : {}) };
    const r = await graph(cr, 'GET', `/me/mailFolders/${encodeURIComponent(folder || 'inbox')}/messages?${q(params)}`, { signal });
    return (r.value || []).map(outlookJson).filter(m => !(search && unread) || m.okunmadi);
  }
  const recipients = s => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean).map(address => ({ emailAddress: { address: address.replace(/^.*<([^>]+)>$/, '$1') } }));

  const NODES = {
    notion: {
      label: 'Notion', cat: 'app', icon: 'file', inputs: 1, outputs: ['main'],
      desc: 'Notion veritabanını sorgular, satır (sayfa) ekler ya da günceller, sayfaya metin ekler, arşivler ve arama yapar.',
      params: [
        cred(['notionApi'], 'Notion bağlantısı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'query', options: [['query', 'Veritabanını sorgula'], ['create', 'Veritabanına satır ekle'], ['update', 'Sayfayı güncelle'], ['get', 'Sayfayı getir'], ['append', 'Sayfaya metin ekle'], ['archive', 'Sayfayı arşivle'], ['search', 'Ara']] },
        { key: 'database', label: 'Veritabanı (bağlantı ya da kimlik)', type: 'expr', def: '', showIf: { op: ['query', 'create'] }, help: 'Veritabanını tarayıcıda açıp adres çubuğundaki bağlantıyı yapıştırabilirsiniz.' },
        { key: 'filter', label: 'Filtre (Notion JSON, isteğe bağlı)', type: 'textarea', def: '', showIf: { op: 'query' }, help: 'Örnek: {"property":"Durum","status":{"equals":"Yapılacak"}}' },
        { key: 'sort', label: 'Sırala (özellik adı, boş = son düzenlenen)', type: 'text', def: '', showIf: { op: 'query' } },
        { key: 'max', label: 'En fazla satır', type: 'number', def: 100, min: 1, showIf: { op: ['query', 'search'] } },
        { key: 'page', label: 'Sayfa (bağlantı ya da kimlik)', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['update', 'get', 'append', 'archive'] } },
        { key: 'fields', label: 'Özellikler (Notion\'daki sütun adı = değer)', type: 'kv', def: [{ key: 'Ad', value: '{{ $json.ad }}' }], showIf: { op: ['create', 'update'] }, help: 'Türler veritabanından okunur: metin, sayı, seçim, çoklu seçim (virgülle), tarih, onay kutusu, bağlantı, e-posta, telefon, durum.' },
        { key: 'text', label: 'Eklenecek metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: ['create', 'append'] }, help: 'Her paragraf ayrı blok olur. Satır eklerken boş bırakılabilir.' },
        { key: 'query', label: 'Aranacak', type: 'expr', def: '', showIf: { op: 'search' } },
        { key: 'kind', label: 'Neyi ara', type: 'select', def: 'page', options: [['page', 'Sayfalar'], ['database', 'Veritabanları']], showIf: { op: 'search' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const call = (m, p, b) => notion(cr, m, p, b, c.signal);
        const first = c.items[0] || { json: {} };
        const blocks = t => String(t ?? '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean).slice(0, 100).map(s => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(s) } }));
        if (c.p.op === 'query' || c.p.op === 'search') {
          const max = Math.max(1, Number(c.p.max) || 100); const out = []; let cursor;
          const body = {};
          if (c.p.op === 'query') {
            const f = String(c.p.filter || '').trim();
            if (f) { const v = c.R(f, first, 0); try { body.filter = typeof v === 'object' && v ? v : JSON.parse(String(v)); } catch (e) { throw new Error(`Filtre geçerli JSON değil: ${e.message}`); } }
            body.sorts = c.p.sort ? [{ property: c.p.sort, direction: 'ascending' }] : [{ timestamp: 'last_edited_time', direction: 'descending' }];
          } else Object.assign(body, { query: String(c.R(c.p.query, first, 0) || ''), filter: { property: 'object', value: c.p.kind === 'database' ? 'database' : 'page' } });
          const path = c.p.op === 'query' ? `/databases/${notionId(c.R(c.p.database, first, 0))}/query` : '/search';
          do {
            c.checkAbort();
            const r = await call('POST', path, { ...body, page_size: Math.min(100, max - out.length), ...(cursor ? { start_cursor: cursor } : {}) });
            for (const x of r.results) out.push(x.object === 'database' ? { id: x.id, url: x.url, baslik: plain(x.title), ozellikler: Object.keys(x.properties || {}) } : pageJson(x));
            cursor = r.has_more ? r.next_cursor : null;
          } while (cursor && out.length < max);
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (it, i) => {
          if (c.p.op === 'create') {
            const db = notionId(c.R(c.p.database, it, i));
            const props = buildProps(await dbSchema(c, cr, db), c.p.fields, it, i, c);
            const children = blocks(c.R(c.p.text, it, i));
            return pageJson(await call('POST', '/pages', { parent: { database_id: db }, properties: props, ...(children.length ? { children } : {}) }));
          }
          const id = notionId(c.R(c.p.page, it, i));
          if (c.p.op === 'get') return pageJson(await call('GET', `/pages/${id}`));
          if (c.p.op === 'archive') return pageJson(await call('PATCH', `/pages/${id}`, { archived: true }));
          if (c.p.op === 'append') {
            const children = blocks(c.R(c.p.text, it, i)); if (!children.length) throw new Error(`${i + 1}. öğede eklenecek metin boş`);
            await call('PATCH', `/blocks/${id}/children`, { children }); return { ...it.json, id, eklenenBlok: children.length };
          }
          const pg = await call('GET', `/pages/${id}`);
          const schema = pg.parent?.database_id ? await dbSchema(c, cr, pg.parent.database_id.replace(/-/g, '')) : Object.fromEntries(Object.entries(pg.properties).map(([k, v]) => [k, { type: v.type, name: k }]));
          return pageJson(await call('PATCH', `/pages/${id}`, { properties: buildProps(schema, c.p.fields, it, i, c) }));
        });
      },
    },

    slack: {
      label: 'Slack', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'Slack botunuzla kanala ya da bir konuya mesaj gönderir, mesajı günceller, tepki ekler, kanal mesajlarını ve kanalları listeler.',
      params: [
        cred(['slackBot'], 'Slack botu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'send', options: [['send', 'Mesaj gönder'], ['update', 'Mesajı güncelle'], ['react', 'Tepki (emoji) ekle'], ['history', 'Kanal mesajlarını oku'], ['channels', 'Kanalları listele']] },
        { key: 'channel', label: 'Kanal', type: 'expr', def: '#genel', showIf: { op: ['send', 'update', 'react', 'history'] }, help: '#kanal-adi ya da kanal kimliği (C0123…). Kişiye özel mesaj için kullanıcı kimliği (U…) yazın.' },
        { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Yeni kayıt: *{{ $json.ad }}*', showIf: { op: ['send', 'update'] }, help: 'Slack biçimi: *kalın*, _italik_, `kod`, <https://adres|bağlantı>' },
        { key: 'thread', label: 'Konu (yanıt olarak gönder, ts)', type: 'expr', def: '', showIf: { op: 'send' } },
        { key: 'ts', label: 'Mesaj (ts)', type: 'expr', def: '{{ $json.ts }}', showIf: { op: ['update', 'react'] } },
        { key: 'emoji', label: 'Emoji adı', type: 'text', def: 'white_check_mark', showIf: { op: 'react' } },
        { key: 'max', label: 'En fazla mesaj', type: 'number', def: 20, min: 1, showIf: { op: 'history' } },
      ],
      sub: '{op} · {channel}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const cache = {};
        const call = (m, p, o = {}) => slack(cr, m, p, { ...o, signal: c.signal });
        const first = c.items[0] || { json: {} };
        if (c.p.op === 'channels') {
          await channelId(cr, '#', cache, c.signal).catch(() => {});
          return [cache.channels.map(x => ({ json: { id: x.id, ad: x.name, ozel: !!x.is_private, uye: !!x.is_member, uyeSayisi: x.num_members, konu: x.topic?.value || '' } }))];
        }
        if (c.p.op === 'history') {
          const ch = await channelId(cr, c.R(c.p.channel, first, 0), cache, c.signal);
          const r = await call('conversations.history', { channel: ch, limit: Math.min(1000, Number(c.p.max) || 20) }, { get: true });
          return [r.messages.map(m => ({ json: slackMsg(m, ch) }))];
        }
        return forItems(c, async (it, i) => {
          const raw = String(c.R(c.p.channel, it, i) || '');
          const ch = /^[UW][A-Z0-9]{6,}$/.test(raw.trim()) ? raw.trim() : await channelId(cr, raw, cache, c.signal);
          if (c.p.op === 'send') {
            const text = String(c.R(c.p.text, it, i) ?? ''); if (!text.trim()) throw new Error(`${i + 1}. öğede mesaj boş`);
            const thread = String(c.R(c.p.thread, it, i) || '');
            const r = await call('chat.postMessage', { channel: ch, text, ...(thread ? { thread_ts: thread } : {}) });
            return { gonderildi: true, ts: r.ts, kanal: r.channel, metin: text };
          }
          const ts = String(c.R(c.p.ts, it, i) || ''); if (!ts) throw new Error(`${i + 1}. öğede mesaj (ts) yok`);
          if (c.p.op === 'update') { const r = await call('chat.update', { channel: ch, ts, text: String(c.R(c.p.text, it, i) ?? '') }); return { guncellendi: true, ts: r.ts, kanal: r.channel }; }
          await call('reactions.add', { channel: ch, timestamp: ts, name: String(c.p.emoji || '').replace(/:/g, '') });
          return { ...it.json, tepki: c.p.emoji };
        });
      },
    },

    slackTrigger: {
      label: 'Slack\'e mesaj gelince', cat: 'trigger', icon: 'chat', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken bir Slack kanalını düzenli kontrol eder; her yeni mesaj için akışı çalıştırır. Botun kendi mesajları ve kanal olayları atlanır.',
      params: pollParams(1, 'm', [cred(['slackBot'], 'Slack botu'), { key: 'channel', label: 'Kanal', type: 'text', def: '#genel' }, { key: 'contains', label: 'Yalnız içinde geçenler (boş = hepsi)', type: 'text', def: '' }]),
      sub: '{channel}',
      async poll(c) {
        const cr = await c.credential(c.p.credential);
        const mem = c.memory(); const cache = {};
        const ch = mem.channelFor === c.p.channel && mem.channel ? mem.channel : await channelId(cr, c.p.channel, cache);
        const r = await slack(cr, 'conversations.history', { channel: ch, limit: 100, ...(mem.ts ? { oldest: mem.ts } : {}) }, { get: true });
        const first = !mem.ts;
        if (r.messages.length) mem.ts = r.messages.reduce((a, m) => (Number(m.ts) > Number(a) ? m.ts : a), mem.ts || '0');
        else if (first) mem.ts = String(Date.now() / 1000);
        Object.assign(mem, { channel: ch, channelFor: c.p.channel }); c.saveMemory();
        if (first) return [];
        const needle = String(c.p.contains || '').toLocaleLowerCase('tr');
        return r.messages.filter(m => !m.subtype && !m.bot_id && (!needle || String(m.text || '').toLocaleLowerCase('tr').includes(needle))).reverse().map(m => slackMsg(m, ch));
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        return [[{ json: { ts: '1700000000.000100', kanal: 'C0123456', metin: 'Merhaba, rapor hazır mı?', kullanici: 'U0123456', zaman: new Date().toISOString() } }]];
      },
      eachItem: true,
    },

    outlook: {
      label: 'Outlook', cat: 'app', icon: 'mail', inputs: 1, outputs: ['main'],
      desc: 'Outlook / Microsoft 365 hesabınızdan e-posta gönderir, e-postaları okur, yanıtlar, okundu işaretler ya da siler.',
      params: [
        cred(['microsoftOAuth'], 'Microsoft hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'send', options: [['send', 'E-posta gönder'], ['list', 'E-postaları oku'], ['reply', 'Yanıtla'], ['read', 'Okundu işaretle'], ['unread', 'Okunmadı işaretle'], ['delete', 'Sil (Silinmiş Öğeler\'e taşı)']] },
        { key: 'to', label: 'Alıcı', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'send' } },
        { key: 'cc', label: 'Bilgi (CC)', type: 'expr', def: '', showIf: { op: 'send' } },
        { key: 'subject', label: 'Konu', type: 'expr', def: 'Merhaba {{ $json.ad }}', showIf: { op: 'send' } },
        { key: 'format', label: 'Biçim', type: 'select', def: 'text', options: [['text', 'Düz metin'], ['html', 'HTML']], showIf: { op: ['send', 'reply'] } },
        { key: 'body', label: 'İleti', type: 'textarea', def: 'Merhaba {{ $json.ad }},\n\nMesajınızı aldık.\n\nSevgiler', showIf: { op: ['send', 'reply'] } },
        { key: 'folder', label: 'Klasör', type: 'select', def: 'inbox', options: FOLDERS, showIf: { op: 'list' } },
        { key: 'search', label: 'Arama (boş = en yeniler)', type: 'expr', def: '', showIf: { op: 'list' }, help: 'Örnek: fatura, from:ali@x.com, subject:sipariş' },
        { key: 'unread', label: 'Yalnız okunmamışlar', type: 'toggle', def: false, showIf: { op: 'list' } },
        { key: 'max', label: 'En fazla e-posta', type: 'number', def: 10, min: 1, showIf: { op: 'list' } },
        { key: 'messageId', label: 'E-posta kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['reply', 'read', 'unread', 'delete'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const call = (m, p, body) => graph(cr, m, p, { body, signal: c.signal });
        const first = c.items[0] || { json: {} };
        if (c.p.op === 'list') return [(await listOutlook(cr, { folder: c.p.folder, search: c.R(c.p.search, first, 0), unread: c.p.unread, max: c.p.max }, c.signal)).map(json => ({ json }))];
        return forItems(c, async (it, i) => {
          const content = String(c.R(c.p.body, it, i) ?? ''); const contentType = c.p.format === 'html' ? 'HTML' : 'Text';
          if (c.p.op === 'send') {
            const to = recipients(c.R(c.p.to, it, i)); if (!to.length) throw new Error(`${i + 1}. öğede alıcı boş`);
            const cc = recipients(c.R(c.p.cc, it, i));
            await call('POST', '/me/sendMail', { message: { subject: String(c.R(c.p.subject, it, i) ?? ''), body: { contentType, content }, toRecipients: to, ...(cc.length ? { ccRecipients: cc } : {}) }, saveToSentItems: true });
            return { gonderildi: true, alici: to.map(r => r.emailAddress.address).join(', ') };
          }
          const id = String(c.R(c.p.messageId, it, i) || ''); if (!id) throw new Error(`${i + 1}. öğede e-posta kimliği yok`);
          const path = `/me/messages/${encodeURIComponent(id)}`;
          if (c.p.op === 'reply') { await call('POST', `${path}/reply`, contentType === 'HTML' ? { message: { body: { contentType, content } } } : { comment: content }); return { ...it.json, id, yanitlandi: true }; }
          if (c.p.op === 'delete') { await call('POST', `${path}/move`, { destinationId: 'deleteditems' }); return { id, silindi: true }; }
          await call('PATCH', path, { isRead: c.p.op === 'read' });
          return { ...it.json, id, islem: c.p.op === 'read' ? 'okundu' : 'okunmadı' };
        });
      },
    },

    outlookTrigger: {
      label: 'Outlook\'a e-posta gelince', cat: 'trigger', icon: 'mail', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken Outlook gelen kutusunu düzenli kontrol eder; her yeni e-posta için akışı çalıştırır. İlk kontrolde mevcut e-postalar yalnızca hatırlanır.',
      params: pollParams(1, 'm', [cred(['microsoftOAuth'], 'Microsoft hesabı'), { key: 'search', label: 'Arama (boş = hepsi)', type: 'text', def: '', help: 'Örnek: fatura ya da from:siparis@magaza.com' }, { key: 'unread', label: 'Yalnız okunmamışlar', type: 'toggle', def: false }]),
      sub: '{search}',
      async poll(c) {
        const cr = await c.credential(c.p.credential);
        const mails = await listOutlook(cr, { search: c.p.search, unread: c.p.unread, max: 25 });
        const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
        const fresh = mails.filter(m => !seen.has(m.id));
        mem.seen = [...new Set([...mails.map(m => m.id), ...seen])].slice(0, 3000); c.saveMemory();
        return first ? [] : fresh.reverse();
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        if (!c.p.credential) return [[{ json: { id: 'ornek', kimden: 'Ayşe <ayse@ornek.com>', konu: 'Sipariş hakkında', metin: 'Merhaba, siparişim ne zaman gelir?', tarih: new Date().toISOString() } }]];
        return [(await listOutlook(await c.credential(c.p.credential), { search: c.p.search, unread: c.p.unread, max: 1 }, c.signal)).map(json => ({ json }))];
      },
      eachItem: true,
    },
  };

  async function test(type, d) {
    if (type === 'notionApi') { const r = await notion({ data: d }, 'GET', '/users/me'); return `Bağlandı: ${r.name || r.bot?.workspace_name || 'Notion entegrasyonu'}`; }
    if (type === 'slackBot') { const r = await slack({ data: d }, 'auth.test'); return `Bağlandı: ${r.team} çalışma alanı, @${r.user}`; }
    return null;
  }
  return { NODES, CREDENTIAL_TYPES, test };
};
