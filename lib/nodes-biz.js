'use strict';
/* Business apps: payments and e-commerce (Stripe, Shopify, WooCommerce), work tracking and CRM (Trello, Jira,
   HubSpot, Mailchimp) and SMS (Netgsm, Twilio). Merged into NODES by nodes.js. Each N8N8_<NAME>_API variable
   points that service at another base URL (tests). */
const crypto = require('crypto');

const CREDENTIAL_TYPES = {
  stripeApi: { label: 'Stripe', fields: [{ key: 'secretKey', label: 'Gizli anahtar (sk_… ya da kısıtlı rk_…)', secret: true, help: 'dashboard.stripe.com → Developers → API keys. Denemek için test anahtarı (sk_test_…) kullanın.' }] },
  shopifyApi: { label: 'Shopify', fields: [
    { key: 'shop', label: 'Mağaza adresi', def: 'magazam.myshopify.com', help: 'Yalnızca alan adı: magazam.myshopify.com' },
    { key: 'token', label: 'Admin API erişim anahtarı (shpat_…)', secret: true, help: 'Shopify yönetimi → Settings → Apps and sales channels → Develop apps → uygulama oluşturun; orders, products ve inventory için okuma/yazma izni verip anahtarı alın.' }] },
  wooApi: { label: 'WooCommerce', fields: [
    { key: 'url', label: 'Site adresi', def: 'https://magazam.com' },
    { key: 'key', label: 'Consumer key (ck_…)', help: 'WordPress → WooCommerce → Ayarlar → Gelişmiş → REST API → Anahtar ekle (Okuma/Yazma).' },
    { key: 'secret', label: 'Consumer secret (cs_…)', secret: true }] },
  trelloApi: { label: 'Trello', fields: [
    { key: 'key', label: 'API anahtarı', help: 'trello.com/power-ups/admin → yeni Power-Up → API key. Aynı sayfadaki "Token" bağlantısıyla token alın.' },
    { key: 'token', label: 'Token', secret: true }] },
  jiraApi: { label: 'Jira Cloud', fields: [
    { key: 'site', label: 'Site', def: 'sirketim.atlassian.net' },
    { key: 'email', label: 'Atlassian e-posta adresi' },
    { key: 'token', label: 'API token', secret: true, help: 'id.atlassian.com/manage-profile/security/api-tokens → Create API token' }] },
  hubspotApi: { label: 'HubSpot', fields: [{ key: 'token', label: 'Özel uygulama erişim anahtarı (pat-…)', secret: true, help: 'HubSpot → Settings → Integrations → Private Apps → Create; crm.objects.contacts ve crm.objects.deals için okuma/yazma kapsamlarını seçin.' }] },
  mailchimpApi: { label: 'Mailchimp', fields: [{ key: 'apiKey', label: 'API anahtarı (…-us21 gibi biter)', secret: true, help: 'Mailchimp → Profile → Extras → API keys → Create A Key' }] },
  netgsmApi: { label: 'Netgsm (SMS)', fields: [
    { key: 'usercode', label: 'Kullanıcı adı (abone numarası, 850…)' },
    { key: 'password', label: 'API şifresi', secret: true, help: 'Netgsm panelinde Alt Kullanıcı / API yetkisi verilmiş kullanıcının şifresi.' },
    { key: 'header', label: 'Mesaj başlığı (gönderici adı)', help: 'Netgsm\'de onaylı başlığınız (ör. FIRMAADI).' }] },
  twilioApi: { label: 'Twilio (SMS)', fields: [
    { key: 'sid', label: 'Account SID (AC…)' },
    { key: 'token', label: 'Auth token', secret: true },
    { key: 'from', label: 'Gönderen numara', help: 'Twilio numaranız, ülke koduyla: +1415…' }] },
};

module.exports = function bizNodes(h) {
  const { httpRequest } = h;
  const env = (k, d) => process.env[k] || d;
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const forItems = async (c, fn) => {
    const items = c.items.length ? c.items : [{ json: {} }]; const out = [];
    for (let i = 0; i < items.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], items[i], i)).trim(); const r = await fn(R, items[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); }
    return [out];
  };
  const form = (o, prefix = '') => { // Stripe-style nested form encoding
    const parts = [];
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === '') continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) v.forEach((x, i) => parts.push(typeof x === 'object' ? form(x, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`));
      else if (typeof v === 'object') parts.push(form(v, key));
      else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
    return parts.filter(Boolean).join('&');
  };
  const kv = rows => Object.fromEntries((rows || []).filter(r => r && String(r.key || '').trim()).map(r => [String(r.key).trim(), r.value]));
  const fail = (name, r, msg) => new Error(`${name} (${r.status}): ${msg || (typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200))}`);
  const newOnly = (c, list, idOf) => { // first check remembers, later checks return the unseen ones (oldest first)
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };

  /* ---------- Stripe ---------- */
  async function stripe(cr, method, path, params, signal) {
    const qs = method === 'GET' && params ? `?${form(params)}` : '';
    const r = await httpRequest({ method, url: `${env('N8N8_STRIPE_API', 'https://api.stripe.com/v1')}${path}${qs}`, headers: { Authorization: `Bearer ${cr.data.secretKey}`, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: method !== 'GET' && params ? form(params) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw fail('Stripe', r, r.status === 401 ? 'gizli anahtar geçersiz' : r.body?.error?.message);
    return r.body;
  }
  /* "1.250,50", "1250,5", "1,250.50" and "1250.5" all read as 1250.5 */
  const num = v => { const t = String(v ?? '').replace(/[\s₺$€]|TL/gi, ''); return Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); };
  const money = (n, cur) => Math.round(num(n) * (['jpy', 'krw'].includes(String(cur).toLowerCase()) ? 1 : 100));

  /* ---------- Shopify ---------- */
  const shopBase = cr => env('N8N8_SHOPIFY_API', `https://${String(cr.data.shop).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`) + '/admin/api/2024-10';
  async function shopify(cr, method, path, body, signal) {
    const r = await httpRequest({ method, url: shopBase(cr) + path, headers: { 'X-Shopify-Access-Token': cr.data.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw fail('Shopify', r, r.status === 401 ? 'erişim anahtarı geçersiz' : typeof r.body?.errors === 'string' ? r.body.errors : r.body?.errors ? JSON.stringify(r.body.errors) : undefined);
    return r.body;
  }
  /* ---------- WooCommerce ---------- */
  async function woo(cr, method, path, body, signal) {
    const base = env('N8N8_WOO_API', String(cr.data.url).replace(/\/+$/, '')) + '/wp-json/wc/v3';
    const r = await httpRequest({ method, url: base + path, headers: { Authorization: `Basic ${Buffer.from(`${cr.data.key}:${cr.data.secret}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw fail('WooCommerce', r, r.body?.message);
    return r.body;
  }
  /* ---------- Trello ---------- */
  async function trello(cr, method, path, params, signal) {
    const qs = new URLSearchParams({ key: cr.data.key, token: cr.data.token, ...Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== '' && v != null)) });
    const r = await httpRequest({ method, url: `${env('N8N8_TRELLO_API', 'https://api.trello.com/1')}${path}?${qs}`, headers: { Accept: 'application/json' }, signal, timeout: 60000 });
    if (!r.ok) throw fail('Trello', r, r.status === 401 ? 'anahtar ya da token geçersiz' : undefined);
    return r.body;
  }
  /* ---------- Jira ---------- */
  const adf = text => ({ type: 'doc', version: 1, content: String(text || '').split(/\n{2,}/).map(p => ({ type: 'paragraph', content: p ? [{ type: 'text', text: p }] : [] })) });
  const adfText = d => !d ? '' : typeof d === 'string' ? d : (d.content || []).map(n => n.text ?? adfText(n)).join(d.type === 'doc' ? '\n\n' : '');
  async function jira(cr, method, path, body, signal) {
    const base = env('N8N8_JIRA_API', `https://${String(cr.data.site).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`);
    const r = await httpRequest({ method, url: `${base}/rest/api/3${path}`, headers: { Authorization: `Basic ${Buffer.from(`${cr.data.email}:${cr.data.token}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw fail('Jira', r, r.status === 401 ? 'e-posta ya da API token geçersiz' : [...(r.body?.errorMessages || []), ...Object.entries(r.body?.errors || {}).map(([k, v]) => `${k}: ${v}`)].join(', ') || undefined);
    return r.body;
  }
  const issueJson = i => ({ anahtar: i.key, id: i.id, ozet: i.fields?.summary, durum: i.fields?.status?.name, tur: i.fields?.issuetype?.name, atanan: i.fields?.assignee?.displayName || null, aciklama: adfText(i.fields?.description), olusturma: i.fields?.created, adres: i.self ? i.self.replace(/\/rest\/api\/.*$/, `/browse/${i.key}`) : undefined });
  /* ---------- HubSpot ---------- */
  async function hubspot(cr, method, path, body, signal) {
    const r = await httpRequest({ method, url: `${env('N8N8_HUBSPOT_API', 'https://api.hubapi.com')}${path}`, headers: { Authorization: `Bearer ${cr.data.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) throw fail('HubSpot', r, r.status === 401 ? 'erişim anahtarı geçersiz' : r.body?.message);
    return r.body;
  }
  /* ---------- Mailchimp ---------- */
  async function mailchimp(cr, method, path, body, signal) {
    const dc = String(cr.data.apiKey).split('-').pop();
    const r = await httpRequest({ method, url: `${env('N8N8_MAILCHIMP_API', `https://${dc}.api.mailchimp.com/3.0`)}${path}`, headers: { Authorization: `Basic ${Buffer.from(`8n8:${cr.data.apiKey}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw fail('Mailchimp', r, r.body?.detail || r.body?.title);
    return r.body;
  }
  /* ---------- SMS ---------- */
  const NETGSM_ERR = { 20: 'mesaj metni hatalı ya da çok uzun', 30: 'kullanıcı adı/şifre hatalı ya da API yetkisi yok (IP kısıtı olabilir)', 40: 'mesaj başlığı sistemde tanımlı değil', 50: 'İYS kontrollü gönderimde hata', 51: 'İYS marka bilgisi bulunamadı', 70: 'parametreler hatalı ya da eksik', 80: 'gönderim sınırı aşıldı', 85: 'aynı numaraya 1 dakikada 20\'den fazla mesaj' };
  const trPhone = v => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 && d.startsWith('5') ? d : d.length === 11 && d.startsWith('05') ? d.slice(1) : d.length === 12 && d.startsWith('905') ? d.slice(2) : d; };

  const NODES = {
    stripe: {
      label: 'Stripe', cat: 'app', icon: 'card', inputs: 1, outputs: ['main'],
      desc: 'Stripe\'ta müşteri oluşturur ya da arar, ödeme bağlantısı oluşturur, ödemeleri listeler ve iade yapar.',
      params: [
        cred(['stripeApi'], 'Stripe hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'paymentLink', options: [['paymentLink', 'Ödeme bağlantısı oluştur'], ['customer', 'Müşteri oluştur'], ['findCustomer', 'Müşteriyi e-postayla bul'], ['payments', 'Son ödemeleri listele'], ['refund', 'İade yap']] },
        { key: 'name', label: 'Ürün / hizmet adı', type: 'expr', def: 'Sipariş {{ $json.id }}', showIf: { op: 'paymentLink' } },
        { key: 'amount', label: 'Tutar', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: ['paymentLink', 'refund'] }, help: 'İadede boş bırakılırsa tamamı iade edilir.' },
        { key: 'currency', label: 'Para birimi', type: 'text', def: 'try', showIf: { op: 'paymentLink' } },
        { key: 'quantity', label: 'Adet', type: 'number', def: 1, min: 1, showIf: { op: 'paymentLink' } },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: ['customer', 'findCustomer'] } },
        { key: 'custName', label: 'Ad soyad', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'customer' } },
        { key: 'phone', label: 'Telefon', type: 'expr', def: '', showIf: { op: 'customer' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 20, min: 1, showIf: { op: 'payments' } },
        { key: 'paymentId', label: 'Ödeme kimliği (pi_…)', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'refund' } },
        { key: 'metadata', label: 'Ek bilgi (metadata)', type: 'kv', def: [], showIf: { op: ['paymentLink', 'customer'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'payments') {
          const r = await stripe(cr, 'GET', '/payment_intents', { limit: Math.min(100, Number(c.p.max) || 20) }, c.signal);
          return [r.data.map(p => ({ json: { id: p.id, tutar: p.amount / 100, paraBirimi: p.currency, durum: p.status, musteri: p.customer, eposta: p.receipt_email, aciklama: p.description, tarih: new Date(p.created * 1000).toISOString() } }))];
        }
        return forItems(c, async (R, it, i) => {
          const meta = Object.fromEntries(Object.entries(kv(c.p.metadata)).map(([k, v]) => [k, str(c.R(v, it, i))]));
          if (c.p.op === 'customer') { const r = await stripe(cr, 'POST', '/customers', { email: R('email'), name: R('custName'), phone: R('phone'), metadata: meta }, c.signal); return { id: r.id, eposta: r.email, ad: r.name }; }
          if (c.p.op === 'findCustomer') { const r = await stripe(cr, 'GET', '/customers', { email: R('email'), limit: 1 }, c.signal); const x = r.data[0]; return { ...it.json, musteriBulundu: !!x, musteriId: x?.id || null }; }
          if (c.p.op === 'refund') { const a = R('amount'); const r = await stripe(cr, 'POST', '/refunds', { payment_intent: R('paymentId'), ...(a ? { amount: money(a, 'try') } : {}) }, c.signal); return { id: r.id, durum: r.status, tutar: r.amount / 100 }; }
          const cur = String(c.p.currency || 'try').toLowerCase(); const amt = money(R('amount'), cur);
          if (!(amt > 0)) throw new Error(`${i + 1}. öğede tutar geçersiz: "${R('amount')}"`);
          const price = await stripe(cr, 'POST', '/prices', { currency: cur, unit_amount: amt, product_data: { name: R('name') || 'Ödeme' } }, c.signal);
          const link = await stripe(cr, 'POST', '/payment_links', { line_items: [{ price: price.id, quantity: Number(c.p.quantity) || 1 }], metadata: meta }, c.signal);
          return { ...it.json, odemeBaglantisi: link.url, baglantiId: link.id, fiyatId: price.id };
        });
      },
    },
    stripeTrigger: {
      label: 'Stripe olayı', cat: 'trigger', icon: 'card', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Stripe\'ı düzenli kontrol eder; seçilen türde yeni bir olay (başarılı ödeme, yeni müşteri, iade…) olunca akışı çalıştırır. Webhook kurmak gerekmez.',
      params: pollParams(1, 'm', [cred(['stripeApi'], 'Stripe hesabı'),
        { key: 'type', label: 'Olay türü', type: 'select', def: 'payment_intent.succeeded', options: [['payment_intent.succeeded', 'Ödeme başarılı'], ['checkout.session.completed', 'Ödeme sayfası tamamlandı'], ['customer.created', 'Yeni müşteri'], ['charge.refunded', 'İade yapıldı'], ['invoice.paid', 'Fatura ödendi'], ['customer.subscription.created', 'Yeni abonelik'], ['customer.subscription.deleted', 'Abonelik iptal']] }]),
      sub: '{type}',
      async poll(c) {
        const r = await stripe(await c.credential(c.p.credential), 'GET', '/events', { type: c.p.type, limit: 50 }, undefined);
        return newOnly(c, r.data, e => e.id).map(e => ({ olayId: e.id, tur: e.type, tarih: new Date(e.created * 1000).toISOString(), ...flatStripe(e.data.object) }));
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { olayId: 'evt_ornek', tur: c.p.type, id: 'pi_ornek', tutar: 250, paraBirimi: 'try', eposta: 'ayse@ornek.com' } }]]; },
      eachItem: true,
    },

    shopify: {
      label: 'Shopify', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'Shopify mağazanızdaki siparişleri ve ürünleri listeler, siparişe not ve etiket ekler, ürün stoğunu günceller.',
      params: [
        cred(['shopifyApi'], 'Shopify mağazası'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Siparişleri listele'], ['order', 'Siparişi getir'], ['tagOrder', 'Siparişe not / etiket ekle'], ['products', 'Ürünleri listele'], ['stock', 'Stok miktarını ayarla']] },
        { key: 'status', label: 'Sipariş durumu', type: 'select', def: 'any', options: [['any', 'Hepsi'], ['open', 'Açık'], ['closed', 'Kapalı'], ['cancelled', 'İptal']], showIf: { op: 'orders' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: ['orders', 'products'] } },
        { key: 'orderId', label: 'Sipariş kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['order', 'tagOrder'] } },
        { key: 'note', label: 'Not', type: 'expr', def: '', showIf: { op: 'tagOrder' } },
        { key: 'tags', label: 'Etiketler (virgülle)', type: 'expr', def: '8n8', showIf: { op: 'tagOrder' } },
        { key: 'sku', label: 'Ürün stok kodu (SKU)', type: 'expr', def: '{{ $json.sku }}', showIf: { op: 'stock' } },
        { key: 'qty', label: 'Yeni stok miktarı', type: 'expr', def: '{{ $json.stok }}', showIf: { op: 'stock' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'orders') return [(await shopify(cr, 'GET', `/orders.json?status=${c.p.status || 'any'}&limit=${Math.min(250, Number(c.p.max) || 50)}`, null, c.signal)).orders.map(o => ({ json: orderJson(o) }))];
        if (c.p.op === 'products') return [(await shopify(cr, 'GET', `/products.json?limit=${Math.min(250, Number(c.p.max) || 50)}`, null, c.signal)).products.map(p => ({ json: { id: p.id, ad: p.title, durum: p.status, tur: p.product_type, marka: p.vendor, varyantlar: (p.variants || []).map(v => ({ id: v.id, sku: v.sku, fiyat: Number(v.price), stok: v.inventory_quantity, inventoryItemId: v.inventory_item_id })) } }))];
        return forItems(c, async (R, it) => {
          if (c.p.op === 'order') return orderJson((await shopify(cr, 'GET', `/orders/${encodeURIComponent(R('orderId'))}.json`, null, c.signal)).order);
          if (c.p.op === 'tagOrder') {
            const cur = (await shopify(cr, 'GET', `/orders/${encodeURIComponent(R('orderId'))}.json?fields=id,tags,note`, null, c.signal)).order;
            const tags = [...new Set([...String(cur.tags || '').split(',').map(s => s.trim()), ...R('tags').split(',').map(s => s.trim())].filter(Boolean))].join(', ');
            const note = R('note') && !String(cur.note || '').split('\n').includes(R('note')) ? [cur.note, R('note')].filter(Boolean).join('\n') : cur.note; // same note twice is added once
            const o = (await shopify(cr, 'PUT', `/orders/${cur.id}.json`, { order: { id: cur.id, tags, note } }, c.signal)).order;
            return { ...it.json, id: o.id, etiketler: o.tags, not: o.note };
          }
          // stock: find the variant by SKU, then set the level at the first location
          const sku = R('sku'); const qty = Math.trunc(Number(R('qty')));
          if (!Number.isFinite(qty)) throw new Error(`"${sku}" için stok miktarı sayı değil`);
          const prods = (await shopify(cr, 'GET', '/products.json?limit=250&fields=id,title,variants', null, c.signal)).products;
          const v = prods.flatMap(p => (p.variants || []).map(x => ({ ...x, urun: p.title }))).find(x => x.sku === sku);
          if (!v) throw new Error(`Shopify'da "${sku}" stok kodlu ürün yok`);
          const loc = (await shopify(cr, 'GET', '/locations.json', null, c.signal)).locations.find(l => l.active !== false);
          const lv = (await shopify(cr, 'POST', '/inventory_levels/set.json', { location_id: loc.id, inventory_item_id: v.inventory_item_id, available: qty }, c.signal)).inventory_level;
          return { ...it.json, sku, urun: v.urun, stok: lv.available, konum: loc.name };
        });
      },
    },
    shopifyTrigger: {
      label: 'Shopify\'da yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Shopify mağazasını düzenli kontrol eder; her yeni siparişte akışı çalıştırır.',
      params: pollParams(1, 'm', [cred(['shopifyApi'], 'Shopify mağazası')]),
      async poll(c) { return newOnly(c, (await shopify(await c.credential(c.p.credential), 'GET', '/orders.json?status=any&limit=50', null)).orders, o => o.id).map(orderJson); },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { id: 1001, no: '#1001', musteri: 'Ayşe Yılmaz', eposta: 'ayse@ornek.com', tutar: 1250, paraBirimi: 'TRY', odeme: 'paid', urunler: [{ ad: 'Kulaklık', adet: 1, fiyat: 1250, sku: 'KLK-1' }] } }]]; },
      eachItem: true,
    },

    woocommerce: {
      label: 'WooCommerce', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'WooCommerce (WordPress) mağazanızdaki siparişleri listeler, sipariş durumunu değiştirir, siparişe not ekler, ürünleri listeler ve stoğu günceller.',
      params: [
        cred(['wooApi'], 'WooCommerce mağazası'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Siparişleri listele'], ['status', 'Sipariş durumunu değiştir'], ['note', 'Siparişe not ekle'], ['products', 'Ürünleri listele'], ['stock', 'Stok miktarını ayarla']] },
        { key: 'status', label: 'Durum', type: 'select', def: 'processing', options: [['any', 'Hepsi'], ['pending', 'Ödeme bekliyor'], ['processing', 'Hazırlanıyor'], ['on-hold', 'Beklemede'], ['completed', 'Tamamlandı'], ['cancelled', 'İptal'], ['refunded', 'İade edildi']], showIf: { op: ['orders', 'status'] } },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: ['orders', 'products'] } },
        { key: 'orderId', label: 'Sipariş numarası', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['status', 'note'] } },
        { key: 'note', label: 'Not', type: 'expr', def: 'Kargoya verildi.', showIf: { op: 'note' } },
        { key: 'customerNote', label: 'Müşteriye de gönder', type: 'toggle', def: false, showIf: { op: 'note' } },
        { key: 'sku', label: 'Ürün stok kodu (SKU)', type: 'expr', def: '{{ $json.sku }}', showIf: { op: 'stock' } },
        { key: 'qty', label: 'Yeni stok miktarı', type: 'expr', def: '{{ $json.stok }}', showIf: { op: 'stock' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'orders') return [(await woo(cr, 'GET', `/orders?per_page=${Math.min(100, Number(c.p.max) || 50)}${c.p.status && c.p.status !== 'any' ? `&status=${c.p.status}` : ''}`, null, c.signal)).map(o => ({ json: wooOrder(o) }))];
        if (c.p.op === 'products') return [(await woo(cr, 'GET', `/products?per_page=${Math.min(100, Number(c.p.max) || 50)}`, null, c.signal)).map(p => ({ json: { id: p.id, ad: p.name, sku: p.sku, fiyat: Number(p.price || 0), stok: p.stock_quantity, stokDurumu: p.stock_status, durum: p.status, adres: p.permalink } }))];
        return forItems(c, async (R, it) => {
          if (c.p.op === 'status') { const o = await woo(cr, 'PUT', `/orders/${encodeURIComponent(R('orderId'))}`, { status: c.p.status }, c.signal); return { ...it.json, ...wooOrder(o) }; }
          if (c.p.op === 'note') { const n = await woo(cr, 'POST', `/orders/${encodeURIComponent(R('orderId'))}/notes`, { note: R('note'), customer_note: !!c.p.customerNote }, c.signal); return { ...it.json, notId: n.id }; }
          const sku = R('sku'); const qty = Math.trunc(Number(R('qty')));
          if (!Number.isFinite(qty)) throw new Error(`"${sku}" için stok miktarı sayı değil`);
          const p = (await woo(cr, 'GET', `/products?sku=${encodeURIComponent(sku)}`, null, c.signal))[0];
          if (!p) throw new Error(`WooCommerce'te "${sku}" stok kodlu ürün yok`);
          const u = await woo(cr, 'PUT', `/products/${p.id}`, { manage_stock: true, stock_quantity: qty }, c.signal);
          return { ...it.json, sku, urun: u.name, stok: u.stock_quantity };
        });
      },
    },
    wooTrigger: {
      label: 'WooCommerce\'te yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'WooCommerce mağazasını düzenli kontrol eder; her yeni siparişte akışı çalıştırır.',
      params: pollParams(1, 'm', [cred(['wooApi'], 'WooCommerce mağazası')]),
      async poll(c) { return newOnly(c, await woo(await c.credential(c.p.credential), 'GET', '/orders?per_page=50&orderby=date&order=desc', null), o => o.id).map(wooOrder); },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { id: 501, durum: 'processing', musteri: 'Ayşe Yılmaz', eposta: 'ayse@ornek.com', telefon: '05321234567', tutar: 860, paraBirimi: 'TRY', urunler: [{ ad: 'Klavye', adet: 1, sku: 'KLV-1', tutar: 860 }] } }]]; },
      eachItem: true,
    },

    trello: {
      label: 'Trello', cat: 'app', icon: 'board', inputs: 1, outputs: ['main'],
      desc: 'Trello\'da kart oluşturur, kartı başka listeye taşır, karta yorum ekler ya da bir listedeki kartları getirir.',
      params: [
        cred(['trelloApi'], 'Trello hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Kart oluştur'], ['move', 'Kartı taşı'], ['comment', 'Karta yorum ekle'], ['list', 'Listedeki kartları getir']] },
        { key: 'listId', label: 'Liste kimliği', type: 'expr', def: '', showIf: { op: ['create', 'move', 'list'] }, help: 'Trello\'da kartı açıp adresin sonuna .json ekleyerek idList değerini görebilirsiniz.' },
        { key: 'name', label: 'Kart başlığı', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'desc', label: 'Açıklama', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'create' } },
        { key: 'due', label: 'Bitiş tarihi (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'cardId', label: 'Kart kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['move', 'comment'] } },
        { key: 'text', label: 'Yorum', type: 'textarea', def: '', showIf: { op: 'comment' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const card = k => ({ id: k.id, ad: k.name, aciklama: k.desc, listeId: k.idList, bitis: k.due, adres: k.shortUrl || k.url });
        if (c.p.op === 'list') return [(await trello(cr, 'GET', `/lists/${encodeURIComponent(str(c.R(c.p.listId, c.items[0] || { json: {} }, 0)))}/cards`, null, c.signal)).map(k => ({ json: card(k) }))];
        return forItems(c, async R => {
          if (c.p.op === 'create') return card(await trello(cr, 'POST', '/cards', { idList: R('listId'), name: R('name') || '(başlıksız)', desc: R('desc'), due: R('due') }, c.signal));
          if (c.p.op === 'move') return card(await trello(cr, 'PUT', `/cards/${encodeURIComponent(R('cardId'))}`, { idList: R('listId') }, c.signal));
          const a = await trello(cr, 'POST', `/cards/${encodeURIComponent(R('cardId'))}/actions/comments`, { text: R('text') }, c.signal);
          return { id: a.id, kartId: R('cardId'), yorum: a.data?.text };
        });
      },
    },

    jira: {
      label: 'Jira', cat: 'app', icon: 'note', inputs: 1, outputs: ['main'],
      desc: 'Jira Cloud\'da kayıt (issue) oluşturur, JQL ile arar, yorum ekler ya da kaydın durumunu değiştirir.',
      params: [
        cred(['jiraApi'], 'Jira hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Kayıt oluştur'], ['search', 'JQL ile ara'], ['comment', 'Yorum ekle'], ['transition', 'Durumunu değiştir']] },
        { key: 'project', label: 'Proje anahtarı', type: 'text', def: 'DESTEK', showIf: { op: 'create' } },
        { key: 'issueType', label: 'Kayıt türü', type: 'text', def: 'Task', showIf: { op: 'create' }, help: 'Projede tanımlı ad: Task, Bug, Story ya da Türkçe arayüzde Görev, Hata…' },
        { key: 'summary', label: 'Özet', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'create' } },
        { key: 'labels', label: 'Etiketler (virgülle, isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'jql', label: 'JQL', type: 'expr', def: 'project = DESTEK AND status != Done ORDER BY created DESC', showIf: { op: 'search' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: 'search' } },
        { key: 'issue', label: 'Kayıt anahtarı', type: 'expr', def: '{{ $json.anahtar }}', showIf: { op: ['comment', 'transition'] } },
        { key: 'text', label: 'Yorum', type: 'textarea', def: '', showIf: { op: 'comment' } },
        { key: 'to', label: 'Yeni durum adı', type: 'expr', def: 'Done', showIf: { op: 'transition' }, help: 'Panodaki sütun adı, ör. "In Progress", "Done", "Tamamlandı"' },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'search') {
          const it0 = c.items[0] || { json: {} };
          const r = await jira(cr, 'GET', `/search/jql?${new URLSearchParams({ jql: str(c.R(c.p.jql, it0, 0)), maxResults: String(Math.min(100, Number(c.p.max) || 50)), fields: 'summary,status,issuetype,assignee,description,created' })}`, null, c.signal);
          return [(r.issues || []).map(i => ({ json: issueJson(i) }))];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'create') {
            const labels = R('labels') ? R('labels').split(',').map(s => s.trim().replace(/\s+/g, '-')).filter(Boolean) : undefined;
            const r = await jira(cr, 'POST', '/issue', { fields: { project: { key: c.p.project }, issuetype: { name: c.p.issueType || 'Task' }, summary: (R('summary') || '(özet yok)').slice(0, 255), description: adf(R('description')), ...(labels ? { labels } : {}) } }, c.signal);
            return { ...it.json, anahtar: r.key, id: r.id, adres: `${r.self.replace(/\/rest\/api\/.*$/, '')}/browse/${r.key}` };
          }
          const key = R('issue'); if (!key) throw new Error('Kayıt anahtarı boş');
          if (c.p.op === 'comment') { const r = await jira(cr, 'POST', `/issue/${encodeURIComponent(key)}/comment`, { body: adf(R('text')) }, c.signal); return { ...it.json, yorumId: r.id }; }
          const ts = (await jira(cr, 'GET', `/issue/${encodeURIComponent(key)}/transitions`, null, c.signal)).transitions || [];
          const want = R('to').toLocaleLowerCase('tr');
          const t = ts.find(x => x.to?.name?.toLocaleLowerCase('tr') === want || x.name?.toLocaleLowerCase('tr') === want);
          if (!t) throw new Error(`"${key}" için "${R('to')}" durumuna geçiş yok. Geçilebilenler: ${ts.map(x => x.to?.name || x.name).join(', ')}`);
          await jira(cr, 'POST', `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } }, c.signal);
          return { ...it.json, anahtar: key, durum: t.to?.name || t.name };
        });
      },
    },

    hubspot: {
      label: 'HubSpot', cat: 'app', icon: 'tag', inputs: 1, outputs: ['main'],
      desc: 'HubSpot CRM\'de kişiyi e-postasına göre ekler ya da günceller, kişi arar ve fırsat (deal) oluşturur.',
      params: [
        cred(['hubspotApi'], 'HubSpot hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upsert', options: [['upsert', 'Kişi ekle ya da güncelle'], ['get', 'Kişiyi e-postayla getir'], ['deal', 'Fırsat oluştur']] },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: ['upsert', 'get', 'deal'] }, help: 'Fırsatta isteğe bağlı: verilirse fırsat bu kişiyle ilişkilendirilir.' },
        { key: 'firstname', label: 'Ad', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'upsert' } },
        { key: 'lastname', label: 'Soyad', type: 'expr', def: '', showIf: { op: 'upsert' } },
        { key: 'phone', label: 'Telefon', type: 'expr', def: '', showIf: { op: 'upsert' } },
        { key: 'company', label: 'Şirket', type: 'expr', def: '', showIf: { op: 'upsert' } },
        { key: 'props', label: 'Diğer alanlar (HubSpot iç adıyla)', type: 'kv', def: [], showIf: { op: ['upsert', 'deal'] } },
        { key: 'dealname', label: 'Fırsat adı', type: 'expr', def: '{{ $json.ad }} - teklif', showIf: { op: 'deal' } },
        { key: 'amount', label: 'Tutar', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: 'deal' } },
        { key: 'stage', label: 'Aşama', type: 'text', def: 'appointmentscheduled', showIf: { op: 'deal' }, help: 'Varsayılan satış hattının iç adları: appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, contractsent, closedwon, closedlost' },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const contact = x => x && ({ id: x.id, eposta: x.properties?.email, ad: x.properties?.firstname, soyad: x.properties?.lastname, telefon: x.properties?.phone, sirket: x.properties?.company });
        const byEmail = async email => hubspot(cr, 'GET', `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=email,firstname,lastname,phone,company`, null, c.signal);
        return forItems(c, async (R, it, i) => {
          const extra = Object.fromEntries(Object.entries(kv(c.p.props)).map(([k, v]) => [k, str(c.R(v, it, i))]).filter(([, v]) => v !== ''));
          const email = R('email').toLowerCase();
          if (c.p.op === 'get') { const x = await byEmail(email); return { ...it.json, kisiBulundu: !!x, kisi: contact(x) || null }; }
          if (c.p.op === 'deal') {
            const props = { dealname: R('dealname'), pipeline: 'default', dealstage: c.p.stage || 'appointmentscheduled', ...(R('amount') ? { amount: String(num(R('amount'))) } : {}), ...extra };
            const who = email ? await byEmail(email) : null;
            const d = await hubspot(cr, 'POST', '/crm/v3/objects/deals', { properties: props, ...(who ? { associations: [{ to: { id: who.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }] } : {}) }, c.signal);
            return { ...it.json, firsatId: d.id, kisiId: who?.id || null };
          }
          if (!email) throw new Error(`${i + 1}. öğede e-posta boş`);
          const props = Object.fromEntries(Object.entries({ email, firstname: R('firstname'), lastname: R('lastname'), phone: R('phone'), company: R('company'), ...extra }).filter(([, v]) => v !== ''));
          const cur = await byEmail(email);
          const x = cur ? await hubspot(cr, 'PATCH', `/crm/v3/objects/contacts/${cur.id}`, { properties: props }, c.signal) : await hubspot(cr, 'POST', '/crm/v3/objects/contacts', { properties: props }, c.signal);
          return { ...it.json, kisiId: x.id, islem: cur ? 'guncellendi' : 'eklendi' };
        });
      },
    },

    mailchimp: {
      label: 'Mailchimp', cat: 'app', icon: 'mail', inputs: 1, outputs: ['main'],
      desc: 'Mailchimp kitlesine (audience) aboneyi ekler ya da günceller, etiket ekler ya da aboneliği iptal eder.',
      params: [
        cred(['mailchimpApi'], 'Mailchimp hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upsert', options: [['upsert', 'Abone ekle ya da güncelle'], ['tag', 'Etiket ekle'], ['unsubscribe', 'Aboneliği iptal et'], ['lists', 'Kitleleri listele']] },
        { key: 'listId', label: 'Kitle kimliği (Audience ID)', type: 'text', def: '', showIf: { op: ['upsert', 'tag', 'unsubscribe'] }, help: 'Audience → Settings → Audience name and defaults sayfasında yazar. "Kitleleri listele" ile de görebilirsiniz.' },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: ['upsert', 'tag', 'unsubscribe'] } },
        { key: 'fname', label: 'Ad', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'upsert' } },
        { key: 'lname', label: 'Soyad', type: 'expr', def: '', showIf: { op: 'upsert' } },
        { key: 'status', label: 'Durum', type: 'select', def: 'subscribed', options: [['subscribed', 'Abone (onaylı)'], ['pending', 'Onay e-postası gönder (çift onay)']], showIf: { op: 'upsert' } },
        { key: 'tags', label: 'Etiketler (virgülle)', type: 'expr', def: '', showIf: { op: ['upsert', 'tag'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'lists') return [(await mailchimp(cr, 'GET', '/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count', null, c.signal)).lists.map(l => ({ json: { id: l.id, ad: l.name, aboneSayisi: l.stats?.member_count } }))];
        return forItems(c, async (R, it) => {
          const email = R('email').toLowerCase(); if (!email) throw new Error('E-posta boş');
          const hash = crypto.createHash('md5').update(email).digest('hex'); const base = `/lists/${encodeURIComponent(c.p.listId)}/members/${hash}`;
          const tags = R('tags') ? R('tags').split(',').map(s => s.trim()).filter(Boolean) : [];
          if (c.p.op === 'unsubscribe') { const m = await mailchimp(cr, 'PATCH', base, { status: 'unsubscribed' }, c.signal); return { ...it.json, durum: m.status }; }
          if (c.p.op === 'upsert') {
            const merge = Object.fromEntries(Object.entries({ FNAME: R('fname'), LNAME: R('lname') }).filter(([, v]) => v));
            const m = await mailchimp(cr, 'PUT', base, { email_address: email, status_if_new: c.p.status || 'subscribed', ...(Object.keys(merge).length ? { merge_fields: merge } : {}) }, c.signal);
            if (tags.length) await mailchimp(cr, 'POST', `${base}/tags`, { tags: tags.map(name => ({ name, status: 'active' })) }, c.signal);
            return { ...it.json, aboneId: m.id, durum: m.status };
          }
          await mailchimp(cr, 'POST', `${base}/tags`, { tags: tags.map(name => ({ name, status: 'active' })) }, c.signal);
          return { ...it.json, etiketler: tags };
        });
      },
    },

    sms: {
      label: 'SMS gönder', cat: 'app', icon: 'phone', inputs: 1, outputs: ['main'],
      desc: 'Netgsm (Türkiye) ya da Twilio ile SMS gönderir. Netgsm\'de onaylı mesaj başlığınız gerekir.',
      params: [
        cred(['netgsmApi', 'twilioApi'], 'SMS hesabı'),
        { key: 'to', label: 'Alıcı numarası', type: 'expr', def: '{{ $json.telefon }}', help: 'Birden çok numara için virgülle ayırın. Netgsm için 05xx…, Twilio için +90…' },
        { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Merhaba {{ $json.ad }}, siparişiniz kargoya verildi.' },
        { key: 'turkish', label: 'Türkçe karakterleri koru (Netgsm)', type: 'toggle', def: true, help: 'Kapalıysa ç, ğ, ı, ö, ş, ü harfleri c, g, i, o, s, u olarak gider; mesaj daha az SMS sayılır.' },
      ],
      sub: '{to}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        return forItems(c, async (R, it, i) => {
          const nums = R('to').split(/[,;]/).map(s => s.trim()).filter(Boolean); const text = R('text');
          if (!nums.length) throw new Error(`${i + 1}. öğede alıcı numarası boş`); if (!text) throw new Error('Mesaj boş');
          if (cr.type === 'twilioApi') {
            const ids = [];
            for (const n of nums) {
              const to = n.startsWith('+') ? n : `+${n.replace(/\D/g, '').replace(/^0(5\d{9})$/, '90$1').replace(/^(5\d{9})$/, '90$1')}`;
              const r = await httpRequest({ method: 'POST', url: `${env('N8N8_TWILIO_API', 'https://api.twilio.com/2010-04-01')}/Accounts/${encodeURIComponent(cr.data.sid)}/Messages.json`, headers: { Authorization: `Basic ${Buffer.from(`${cr.data.sid}:${cr.data.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: cr.data.from, Body: text }).toString(), signal: c.signal, timeout: 30000 });
              if (!r.ok) throw fail('Twilio', r, r.body?.message);
              ids.push(r.body.sid);
            }
            return { ...it.json, gonderildi: true, mesajIdleri: ids };
          }
          const msg = c.p.turkish === false ? text.replace(/[çğıöşüÇĞİÖŞÜ]/g, ch => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' }[ch])) : text;
          const qs = new URLSearchParams({ usercode: cr.data.usercode, password: cr.data.password, gsmno: nums.map(trPhone).join(','), message: msg, msgheader: cr.data.header, ...(c.p.turkish !== false ? { dil: 'TR' } : {}) });
          const r = await httpRequest({ url: `${env('N8N8_NETGSM_API', 'https://api.netgsm.com.tr')}/sms/send/get?${qs}`, signal: c.signal, timeout: 30000 });
          const body = String(r.body ?? '').trim(); const code = body.split(/\s+/)[0];
          if (!['00', '01', '02'].includes(code)) throw new Error(`Netgsm: ${NETGSM_ERR[Number(code)] || body || r.status}`);
          return { ...it.json, gonderildi: true, gorevId: body.split(/\s+/)[1] || null };
        });
      },
    },
  };

  function flatStripe(o = {}) {
    const amt = o.amount_received ?? o.amount_total ?? o.amount_paid ?? o.amount;
    return { id: o.id, nesne: o.object, ...(amt != null ? { tutar: amt / 100 } : {}), ...(o.currency ? { paraBirimi: o.currency } : {}), eposta: o.receipt_email || o.customer_email || o.customer_details?.email || o.email || null, ad: o.customer_details?.name || o.name || null, musteri: typeof o.customer === 'string' ? o.customer : o.customer?.id || null, durum: o.status || null, aciklama: o.description || null, metadata: o.metadata || {} };
  }
  function orderJson(o) {
    const cust = o.customer || {}; const addr = o.shipping_address || {};
    return { id: o.id, no: o.name, musteri: [cust.first_name, cust.last_name].filter(Boolean).join(' ') || addr.name || null, eposta: o.email || cust.email || null, telefon: o.phone || addr.phone || null, tutar: Number(o.total_price), paraBirimi: o.currency, odeme: o.financial_status, gonderim: o.fulfillment_status, etiketler: o.tags, not: o.note, tarih: o.created_at,
      adres: addr.address1 ? [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country].filter(Boolean).join(', ') : null,
      urunler: (o.line_items || []).map(l => ({ ad: l.title, adet: l.quantity, fiyat: Number(l.price), sku: l.sku })) };
  }
  function wooOrder(o) {
    const b = o.billing || {}; const s = o.shipping || {};
    return { id: o.id, no: o.number, durum: o.status, musteri: [b.first_name, b.last_name].filter(Boolean).join(' '), eposta: b.email, telefon: b.phone, tutar: Number(o.total), paraBirimi: o.currency, odemeYontemi: o.payment_method_title, tarih: o.date_created, not: o.customer_note || '',
      adres: [s.address_1 || b.address_1, s.address_2 || b.address_2, s.city || b.city, s.state || b.state, s.postcode || b.postcode].filter(Boolean).join(', '),
      urunler: (o.line_items || []).map(l => ({ ad: l.name, adet: l.quantity, sku: l.sku, tutar: Number(l.total) })) };
  }

  async function test(type, d) {
    const fake = { data: d, type };
    if (type === 'stripeApi') { const r = await stripe(fake, 'GET', '/balance', null); return `Bağlanıldı (${r.livemode ? 'canlı' : 'test'} hesabı)`; }
    if (type === 'shopifyApi') { const r = await shopify(fake, 'GET', '/shop.json', null); return `Mağaza bulundu: ${r.shop?.name}`; }
    if (type === 'wooApi') { const r = await woo(fake, 'GET', '/orders?per_page=1', null); return `Bağlanıldı; sipariş okunabiliyor (${r.length ? 'en az 1 sipariş var' : 'sipariş yok'})`; }
    if (type === 'trelloApi') { const r = await trello(fake, 'GET', '/members/me', { fields: 'fullName,username' }); return `Giriş yapıldı: ${r.fullName || r.username}`; }
    if (type === 'jiraApi') { const r = await jira(fake, 'GET', '/myself', null); return `Giriş yapıldı: ${r.displayName}`; }
    if (type === 'hubspotApi') { await hubspot(fake, 'GET', '/crm/v3/objects/contacts?limit=1', null); return 'Bağlanıldı; kişiler okunabiliyor'; }
    if (type === 'mailchimpApi') { const r = await mailchimp(fake, 'GET', '/ping', null); return r.health_status || 'Bağlanıldı'; }
    if (type === 'twilioApi') {
      const r = await httpRequest({ url: `${env('N8N8_TWILIO_API', 'https://api.twilio.com/2010-04-01')}/Accounts/${encodeURIComponent(d.sid)}.json`, headers: { Authorization: `Basic ${Buffer.from(`${d.sid}:${d.token}`).toString('base64')}` }, timeout: 15000 });
      if (!r.ok) throw fail('Twilio', r, r.body?.message); return `Hesap bulundu: ${r.body.friendly_name}`;
    }
    if (type === 'netgsmApi') {
      const r = await httpRequest({ url: `${env('N8N8_NETGSM_API', 'https://api.netgsm.com.tr')}/sms/header?${new URLSearchParams({ usercode: d.usercode, password: d.password })}`, timeout: 15000 });
      const body = String(r.body ?? '').trim();
      if (/^(30|70)$/.test(body)) throw new Error(`Netgsm: ${NETGSM_ERR[Number(body)]}`);
      return `Giriş yapıldı; başlıklar: ${body.split(/<br>|\s+/).filter(Boolean).join(', ')}`;
    }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
