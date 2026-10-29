'use strict';
/* Pazaryerleri: Hepsiburada, N11 ve Amazon (SP-API; Amazon.com.tr ve diğer ülkeler), her biri için yeni sipariş tetikleyicisi.
   Siparişler Trendyol node'uyla aynı biçimde çıkar (paketId, siparisNo, musteri, tutar, adres, urunler), böylece aynı akış
   hepsinde çalışır. N8N8_HEPSIBURADA_API, N8N8_N11_API, N8N8_AMAZON_API ve N8N8_AMAZON_AUTH_URL başka adrese yönlendirir (testler). */

const AMAZON_MARKETS = [['A33AVAJ2PDY3EV', 'Türkiye (amazon.com.tr)', 'TRY', 'eu'], ['A1PA6795UKMFR9', 'Almanya', 'EUR', 'eu'], ['A1F83G8C2ARO7P', 'Birleşik Krallık', 'GBP', 'eu'], ['A13V1IB3VIYZZH', 'Fransa', 'EUR', 'eu'], ['APJ6JRA9NG5V4', 'İtalya', 'EUR', 'eu'], ['A1RKKUPIHCS9HS', 'İspanya', 'EUR', 'eu'], ['A1805IZSGTT6HS', 'Hollanda', 'EUR', 'eu'], ['A2VIGQ35RCS4UG', 'Birleşik Arap Emirlikleri', 'AED', 'eu'], ['ATVPDKIKX0DER', 'ABD', 'USD', 'na']];

const CREDENTIAL_TYPES = {
  hepsiburadaApi: { label: 'Hepsiburada satıcı hesabı', fields: [
    { key: 'merchantId', label: 'Merchant ID', help: 'Merchant Portal → Hesap Bilgilerim → Entegrasyon bilgileri' },
    { key: 'secretKey', label: 'Servis anahtarı (secret key)', secret: true },
    { key: 'userAgent', label: 'Entegratör kullanıcı adı', def: '', help: 'Hepsiburada her istekte User-Agent başlığında bu adı ister (entegrasyon başvurusunda verilen developer kullanıcı adı).' },
    { key: 'stage', label: 'Ortam', def: 'false', options: [['false', 'Canlı'], ['true', 'Test (SIT)']] }] },
  n11Api: { label: 'N11 mağaza hesabı', fields: [
    { key: 'appKey', label: 'App Key', help: 'N11 Mağaza Paneli → Hesabım → API Hesapları' },
    { key: 'appSecret', label: 'App Secret', secret: true }] },
  amazonSpApi: { label: 'Amazon satıcı hesabı (SP-API)', fields: [
    { key: 'sellerId', label: 'Satıcı ID (Merchant Token)', help: 'Seller Central → Ayarlar → Hesap Bilgileri → Satıcı Belirteci' },
    { key: 'marketplace', label: 'Mağaza', def: 'A33AVAJ2PDY3EV', options: AMAZON_MARKETS.map(([id, ad]) => [id, ad]) },
    { key: 'clientId', label: 'LWA Client ID', help: 'Seller Central → Uygulamalar ve Hizmetler → Uygulama geliştirme → uygulamanız → LWA kimlik bilgileri' },
    { key: 'clientSecret', label: 'LWA Client Secret', secret: true },
    { key: 'refreshToken', label: 'Refresh token', secret: true, help: 'Uygulamayı kendi hesabınıza yetkilendirince ("Authorize app") verilen Atzr| ile başlayan değer.' }] },
};

module.exports = function marketNodes(h) {
  const { httpRequest } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const num = v => { const t = String(v ?? '').replace(/[\s₺$€£]|TL/gi, ''); return Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); };
  const amount = v => (v && typeof v === 'object' ? num(v.amount ?? v.Amount ?? v.value) : v == null || v === '' ? null : num(v));
  const iso = v => { if (v == null || v === '') return null; const d = new Date(typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const newOnly = (c, list, idOf) => {
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };
  // order lines given as the urunler field of an order, a JSON string or a single object
  const lineList = v => { let a = v; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } } return (Array.isArray(a) ? a : a ? [a] : []); };
  // one stock/price row per item; blank fields stay unchanged
  const stockRows = (c, keyLabel) => items(c).map((it, i) => {
    const R = k => str(c.R(c.p[k], it, i)).trim(); const key = R('sku'); if (!key) throw new Error(`${i + 1}. öğede ${keyLabel} yok`);
    const row = { key }; const q = R('quantity'), p = R('price'), l = R('listPrice');
    if (q !== '') { row.quantity = Math.trunc(num(q)); if (!Number.isFinite(row.quantity) || row.quantity < 0) throw new Error(`"${key}" için stok adedi geçersiz: ${q}`); }
    if (p !== '') { row.price = num(p); if (!(row.price > 0)) throw new Error(`"${key}" için fiyat geçersiz: ${p}`); row.listPrice = l !== '' ? num(l) : row.price; if (row.listPrice < row.price) throw new Error(`"${key}": liste fiyatı satış fiyatından düşük olamaz`); }
    if (row.quantity === undefined && row.price === undefined) throw new Error(`"${key}" için ne stok ne fiyat verilmiş`);
    return row;
  });
  const stockParams = (label, def, extra = {}) => [
    { key: 'sku', label, type: 'expr', def, showIf: { op: 'stock' } },
    { key: 'quantity', label: 'Stok adedi (boş = değiştirme)', type: 'expr', def: '{{ $json.stok }}', showIf: { op: 'stock' } },
    { key: 'price', label: 'Satış fiyatı (boş = değiştirme)', type: 'expr', def: '', showIf: { op: 'stock' }, help: 'KDV dahil fiyat; 1.250,50 ya da 1250.50 yazılabilir.' },
    ...(extra.listPrice ? [{ key: 'listPrice', label: 'Liste fiyatı (boş = satış fiyatı)', type: 'expr', def: '', showIf: { op: 'stock' } }] : []),
  ];

  /* ---------- Hepsiburada ---------- */
  async function hb(cr, svc, method, p, body, signal) {
    const d = cr.data; const mid = String(d.merchantId || '').trim(); if (!mid) throw new Error('Hepsiburada Merchant ID boş');
    const base = process.env.N8N8_HEPSIBURADA_API ? `${env('N8N8_HEPSIBURADA_API')}/${svc}` : `https://${svc}-external${d.stage === 'true' ? '-sit' : ''}.hepsiburada.com`;
    const r = await httpRequest({ method, url: `${base}${p.replace('{mid}', encodeURIComponent(mid))}`, headers: { Authorization: `Basic ${Buffer.from(`${mid}:${d.secretKey || ''}`).toString('base64')}`, 'User-Agent': String(d.userAgent || '').trim() || 'Auto-Move', 'Content-Type': 'application/json', Accept: 'application/json' }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok) {
      const b = r.body; const msg = r.status === 401 ? 'Merchant ID ya da servis anahtarı yanlış' : r.status === 403 ? 'erişim reddedildi (entegratör kullanıcı adı / User-Agent doğru mu?)' : r.status === 429 ? 'çok sık istek, biraz bekleyin' : b?.message || b?.errors?.[0]?.message || b?.title || str(b).slice(0, 200);
      throw new Error(`Hepsiburada (${r.status}): ${msg}`);
    }
    return r.body;
  }
  const hbAddress = a => (a ? { ad: a.name ?? a.fullName, telefon: a.phoneNumber ?? a.phone, eposta: a.email, il: a.city, ilce: a.town ?? a.district, acikAdres: a.address ?? a.fullAddress } : null);
  const hbLine = l => ({ satirId: l.id ?? l.lineItemId, ad: l.productName ?? l.name, barkod: l.productBarcode ?? l.barcode, stokKodu: l.merchantSku ?? l.sku, hepsiburadaSku: l.hepsiburadaSku ?? l.hbSku, adet: Number(l.quantity ?? 1), fiyat: amount(l.unitPrice ?? l.price), tutar: amount(l.totalPrice) });
  // the paid-orders list returns one row per order line: group them into orders
  const hbOrders = list => {
    const by = new Map();
    for (const l of list) {
      const no = String(l.orderNumber ?? l.OrderNumber ?? ''); let o = by.get(no);
      if (!o) by.set(no, o = { paketId: null, siparisNo: no, durum: l.status ?? 'Open', musteri: l.customerName ?? l.shippingAddress?.name ?? null, eposta: l.shippingAddress?.email ?? l.customerEmail ?? null, tutar: 0, paraBirimi: l.totalPrice?.currency || 'TRY', tarih: iso(l.orderDate), kargo: l.cargoCompany ?? null, takipNo: null, adres: hbAddress(l.shippingAddress), urunler: [], pazaryeri: 'Hepsiburada' });
      const line = hbLine(l); o.urunler.push(line); o.tutar = Math.round((o.tutar + (line.tutar ?? (line.fiyat || 0) * line.adet)) * 100) / 100;
    }
    return [...by.values()];
  };
  const hbPackage = p => ({ paketId: p.packageNumber ?? p.id, siparisNo: p.orderNumber ?? p.items?.[0]?.orderNumber ?? null, durum: p.status, musteri: p.recipientName ?? p.customerName ?? p.shippingAddress?.name ?? null, tutar: amount(p.totalPrice), paraBirimi: p.totalPrice?.currency || 'TRY', tarih: iso(p.orderDate ?? p.packageCreatedDate), kargo: p.cargoCompany ?? null, takipNo: p.barcode ?? p.trackingNumber ?? null, adres: hbAddress(p.shippingAddress), urunler: (p.items || p.lineItems || []).map(hbLine), pazaryeri: 'Hepsiburada' });

  /* ---------- N11 ---------- */
  async function n11(cr, method, p, body, signal) {
    const d = cr.data; if (!d.appKey) throw new Error('N11 App Key boş');
    const r = await httpRequest({ method, url: `${env('N8N8_N11_API', 'https://api.n11.com')}${p}`, headers: { appkey: d.appKey, appsecret: d.appSecret || '', 'Content-Type': 'application/json', Accept: 'application/json' }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok) {
      const b = r.body; const msg = r.status === 401 || r.status === 403 ? 'App Key ya da App Secret yanlış' : r.status === 429 ? 'çok sık istek, biraz bekleyin' : b?.message || b?.errors?.[0]?.message || b?.reasons?.join?.('; ') || str(b).slice(0, 200);
      throw new Error(`N11 (${r.status}): ${msg}`);
    }
    return r.body;
  }
  const N11_STATUS = [['Created', 'Yeni (Oluşturuldu)'], ['Picking', 'Hazırlanıyor'], ['Shipped', 'Kargoda'], ['Delivered', 'Teslim edildi'], ['Cancelled', 'İptal'], ['UnPacked', 'Paketi bölünmüş'], ['Unsupplied', 'Tedarik edilemedi']];
  const n11Order = o => ({
    paketId: o.id, siparisNo: o.orderNumber, durum: o.shipmentPackageStatus ?? o.status, musteri: o.customerfullName ?? o.customerFullName ?? o.shippingAddress?.fullName ?? null, eposta: o.customerEmail ?? null,
    tutar: amount(o.totalAmount ?? o.totalPrice), paraBirimi: 'TRY', tarih: iso(o.createdDate ?? o.orderDate), kargo: o.cargoProviderName ?? null, takipNo: o.cargoTrackingNumber ?? null,
    adres: o.shippingAddress ? { ad: o.shippingAddress.fullName, telefon: o.shippingAddress.gsm ?? o.shippingAddress.phone, il: o.shippingAddress.city, ilce: o.shippingAddress.district, acikAdres: o.shippingAddress.address } : null,
    urunler: (o.lines || []).map(l => ({ satirId: l.orderLineId ?? l.id, ad: l.productName, barkod: l.barcode, stokKodu: l.stockCode, adet: Number(l.quantity ?? 1), fiyat: amount(l.price), tutar: amount(l.totalAmount ?? l.amount) ?? (amount(l.price) || 0) * Number(l.quantity ?? 1) })),
    pazaryeri: 'N11',
  });
  const n11Orders = async (cr, status, days, max, signal) => {
    const end = Date.now(); const start = end - Math.min(15, Math.max(1, days)) * 86400000; const out = [];
    for (let page = 0; out.length < max; page++) {
      const r = await n11(cr, 'GET', `/rest/delivery/v1/shipmentPackages?${new URLSearchParams({ ...(status ? { status } : {}), startDate: String(start), endDate: String(end), page: String(page), size: String(Math.min(100, max)), orderByDirection: 'DESC' })}`, null, signal);
      out.push(...(r.content || [])); if (page + 1 >= (r.totalPages || 1) || !(r.content || []).length) break;
    }
    return out.slice(0, max);
  };

  /* ---------- Amazon SP-API (Login with Amazon refresh token → access token, 1 saat; bellekte tutulur) ---------- */
  const tokens = new Map();
  const market = d => AMAZON_MARKETS.find(m => m[0] === (d.marketplace || 'A33AVAJ2PDY3EV')) || AMAZON_MARKETS[0];
  async function amazonToken(d, signal, fresh) {
    const k = require('crypto').createHash('sha256').update(JSON.stringify([d.clientId, d.clientSecret, d.refreshToken])).digest('hex'); const t = tokens.get(k);
    if (!fresh && t && t.until > Date.now() + 60000) return t.token;
    const r = await httpRequest({ method: 'POST', url: env('N8N8_AMAZON_AUTH_URL', 'https://api.amazon.com/auth/o2/token'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: d.refreshToken || '', client_id: d.clientId || '', client_secret: d.clientSecret || '' }).toString(), signal, timeout: 30000 });
    if (!r.ok || !r.body?.access_token) throw new Error(`Amazon girişi başarısız: ${r.body?.error === 'invalid_grant' ? 'refresh token geçersiz ya da iptal edilmiş' : r.body?.error === 'invalid_client' ? 'LWA Client ID ya da Secret yanlış' : r.body?.error_description || r.status}`);
    tokens.set(k, { token: r.body.access_token, until: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 });
    return r.body.access_token;
  }
  async function amazon(cr, method, p, body, signal) {
    const d = cr.data; const base = env('N8N8_AMAZON_API', market(d)[3] === 'na' ? 'https://sellingpartnerapi-na.amazon.com' : 'https://sellingpartnerapi-eu.amazon.com');
    const go = async fresh => httpRequest({ method, url: `${base}${p}`, headers: { 'x-amz-access-token': await amazonToken(d, signal, fresh), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Auto-Move (Language=JavaScript)' }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    let r = await go(false); if (r.status === 401 || (r.status === 403 && /expired|Unauthorized/i.test(str(r.body)))) r = await go(true);
    if (!r.ok) {
      const e = r.body?.errors?.[0]; const msg = r.status === 403 ? `erişim reddedildi${e?.message ? ` (${e.message})` : ''}; uygulamanın bu işlem için rolü var mı?` : r.status === 429 ? 'çok sık istek (Amazon sınırı), biraz bekleyin' : e ? [e.message, e.details].filter(Boolean).join(' - ') : str(r.body).slice(0, 200);
      throw new Error(`Amazon (${r.status}): ${msg}`);
    }
    return r.body;
  }
  const amzOrder = (o, lines) => ({
    paketId: o.AmazonOrderId, siparisNo: o.AmazonOrderId, durum: o.OrderStatus, musteri: o.ShippingAddress?.Name ?? o.BuyerInfo?.BuyerName ?? null, eposta: o.BuyerInfo?.BuyerEmail ?? null,
    tutar: amount(o.OrderTotal), paraBirimi: o.OrderTotal?.CurrencyCode || null, tarih: iso(o.PurchaseDate), kargo: o.ShipServiceLevel ?? null, takipNo: null, gonderim: o.FulfillmentChannel === 'AFN' ? 'Amazon (FBA)' : 'Satıcı',
    sonGonderim: iso(o.LatestShipDate),
    adres: o.ShippingAddress ? { ad: o.ShippingAddress.Name ?? null, telefon: o.ShippingAddress.Phone ?? null, il: o.ShippingAddress.City ?? o.ShippingAddress.StateOrRegion ?? null, ilce: o.ShippingAddress.County ?? o.ShippingAddress.District ?? null, acikAdres: [o.ShippingAddress.AddressLine1, o.ShippingAddress.AddressLine2].filter(Boolean).join(' ') || null, postaKodu: o.ShippingAddress.PostalCode ?? null, ulke: o.ShippingAddress.CountryCode ?? null } : null,
    urunler: (lines || []).map(l => ({ satirId: l.OrderItemId, ad: l.Title, asin: l.ASIN, stokKodu: l.SellerSKU, adet: Number(l.QuantityOrdered ?? 1), fiyat: l.ItemPrice ? Math.round(amount(l.ItemPrice) / Math.max(1, Number(l.QuantityOrdered ?? 1)) * 100) / 100 : null, tutar: amount(l.ItemPrice) })),
    pazaryeri: 'Amazon',
  });
  const amzItems = async (cr, id, signal) => (await amazon(cr, 'GET', `/orders/v0/orders/${encodeURIComponent(id)}/orderItems`, null, signal)).payload?.OrderItems || [];
  const amzOrders = async (cr, statuses, days, max, signal) => {
    const out = []; let next = null;
    do {
      const q = next ? { MarketplaceIds: market(cr.data)[0], NextToken: next } : { MarketplaceIds: market(cr.data)[0], CreatedAfter: new Date(Date.now() - Math.max(1, days) * 86400000).toISOString(), MaxResultsPerPage: String(Math.min(100, max)), ...(statuses ? { OrderStatuses: statuses } : {}) };
      const r = await amazon(cr, 'GET', `/orders/v0/orders?${new URLSearchParams(q)}`, null, signal);
      out.push(...(r.payload?.Orders || [])); next = r.payload?.NextToken;
    } while (next && out.length < max);
    return out.slice(0, max);
  };
  const AMZ_STATUS = [['Unshipped,PartiallyShipped', 'Gönderilmeyi bekleyen'], ['Pending', 'Ödeme bekleyen'], ['Shipped', 'Gönderildi'], ['Canceled', 'İptal'], ['', 'Hepsi']];

  const NODES = {
    hepsiburada: {
      label: 'Hepsiburada', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'Hepsiburada satıcı hesabınızda ödemesi tamamlanmış siparişleri ve paketleri listeler, sipariş satırlarını paketler, ürünlerinizi listeler, stok ve fiyat günceller ve güncellemenin sonucunu sorgular.',
      params: [
        cred(['hepsiburadaApi'], 'Hepsiburada satıcı hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Yeni siparişleri listele (paketlenmemiş)'], ['packages', 'Paketleri listele'], ['pack', 'Siparişi paketle'], ['listings', 'Ürünleri listele'], ['stock', 'Stok ve fiyat güncelle'], ['upload', 'Güncelleme sonucunu sorgula']] },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: ['orders', 'packages', 'listings'] } },
        { key: 'lines', label: 'Satırlar', type: 'expr', def: '{{ $json.urunler }}', showIf: { op: 'pack' }, help: 'Siparişin urunler alanı (satirId ve adet). Hepsiburada bu satırlardan bir kargo paketi oluşturur.' },
        ...stockParams('Satıcı stok kodu (merchant SKU)', '{{ $json.stokKodu }}'),
        { key: 'uploadId', label: 'Güncelleme numarası', type: 'expr', def: '{{ $json.islemNo }}', showIf: { op: 'upload' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const max = Math.max(1, Number(c.p.max) || 50);
        if (c.p.op === 'orders') {
          const r = await hb(cr, 'oms', 'GET', `/orders/merchantid/{mid}?offset=0&limit=${Math.min(100, max * 5)}`, null, c.signal);
          return [hbOrders(r.items || r.orders || (Array.isArray(r) ? r : [])).slice(0, max).map(json => ({ json }))];
        }
        if (c.p.op === 'packages') {
          const r = await hb(cr, 'oms', 'GET', `/packages/merchantid/{mid}?offset=0&limit=${Math.min(100, max)}`, null, c.signal);
          return [(Array.isArray(r) ? r : r.items || []).slice(0, max).map(p => ({ json: hbPackage(p) }))];
        }
        if (c.p.op === 'listings') {
          const r = await hb(cr, 'listing', 'GET', `/listings/merchantid/{mid}?offset=0&limit=${Math.min(1000, max)}`, null, c.signal);
          return [(r.listings || r.items || []).slice(0, max).map(l => ({ json: { hepsiburadaSku: l.hepsiburadaSku, stokKodu: l.merchantSku, stok: l.availableStock, fiyat: amount(l.price), satista: l.isSalable ?? null, kargoyaVerilis: l.dispatchTime ?? null } }))];
        }
        if (c.p.op === 'stock') {
          const rows = stockRows(c, 'stok kodu'); const out = [];
          for (let i = 0; i < rows.length; i += 1000) {
            const part = rows.slice(i, i + 1000);
            const r = await hb(cr, 'listing', 'POST', '/listings/merchantid/{mid}/inventory-uploads', part.map(x => ({ merchantSku: x.key, ...(x.quantity !== undefined ? { availableStock: x.quantity } : {}), ...(x.price !== undefined ? { price: x.price } : {}) })), c.signal);
            out.push({ json: { islemNo: r.id ?? r.uploadId, urunSayisi: part.length, stokKodlari: part.map(x => x.key) } });
          }
          return [out];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'upload') {
            const id = R('uploadId'); if (!id) throw new Error('Güncelleme numarası boş');
            const r = await hb(cr, 'listing', 'GET', `/listings/merchantid/{mid}/inventory-uploads/id/${encodeURIComponent(id)}`, null, c.signal);
            const errs = (r.errors || []).map(e => ({ stokKodu: e.merchantSku ?? null, neden: e.message ?? str(e) }));
            return { islemNo: id, durum: r.status, toplam: r.total ?? null, hatali: errs.length, hatalar: errs };
          }
          const lines = lineList(c.R(c.p.lines, it, 0)).map(l => ({ id: String(l.satirId ?? l.id ?? l.lineItemId ?? ''), quantity: Number(l.adet ?? l.quantity ?? 1) })).filter(l => l.id);
          if (!lines.length) throw new Error('Satır listesi boş; siparişin urunler alanını verin');
          const r = await hb(cr, 'oms', 'POST', '/packages/merchantid/{mid}', { lineItemRequests: lines }, c.signal);
          return { ...it.json, paketId: r.packageNumber ?? r.id ?? null, takipNo: r.barcode ?? null, kargo: r.cargoCompany ?? it.json.kargo ?? null, durum: 'Packaged' };
        });
      },
    },
    hepsiburadaTrigger: {
      label: 'Hepsiburada\'da yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Hepsiburada satıcı hesabınızı düzenli kontrol eder; ödemesi tamamlanan her yeni siparişte akışı çalıştırır.',
      params: pollParams(2, 'm', [cred(['hepsiburadaApi'], 'Hepsiburada satıcı hesabı')]),
      async poll(c) {
        const r = await hb(await c.credential(c.p.credential), 'oms', 'GET', '/orders/merchantid/{mid}?offset=0&limit=100', null);
        return newOnly(c, hbOrders(r.items || r.orders || (Array.isArray(r) ? r : [])), o => o.siparisNo);
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { paketId: null, siparisNo: '4080000001', durum: 'Open', musteri: 'Ayşe Yılmaz', tutar: 449.9, paraBirimi: 'TRY', adres: { ad: 'Ayşe Yılmaz', il: 'İstanbul', ilce: 'Kadıköy', acikAdres: 'Moda Cd. 1' }, urunler: [{ satirId: 'a1b2', ad: 'Seramik Kupa', stokKodu: 'KUP-1', adet: 1, fiyat: 449.9, tutar: 449.9 }], pazaryeri: 'Hepsiburada' } }]]; },
      eachItem: true,
    },

    n11: {
      label: 'N11', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'N11 mağazanızda siparişleri listeler, siparişi onaylayıp "Hazırlanıyor" durumuna alır, ürünlerinizi listeler, stok ve fiyat günceller ve güncellemenin sonucunu sorgular.',
      params: [
        cred(['n11Api'], 'N11 mağaza hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Siparişleri listele'], ['accept', 'Siparişi onayla (Hazırlanıyor)'], ['products', 'Ürünleri listele'], ['stock', 'Stok ve fiyat güncelle'], ['task', 'Güncelleme sonucunu sorgula']] },
        { key: 'status', label: 'Durum', type: 'select', def: 'Created', options: [['', 'Hepsi'], ...N11_STATUS], showIf: { op: 'orders' } },
        { key: 'days', label: 'Son kaç gün', type: 'number', def: 7, min: 1, showIf: { op: 'orders' }, help: 'N11 en fazla 15 günlük aralık verir.' },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: ['orders', 'products'] } },
        { key: 'lines', label: 'Satırlar', type: 'expr', def: '{{ $json.urunler }}', showIf: { op: 'accept' } },
        { key: 'productCode', label: 'Stok kodu (boş = bütün ürünler)', type: 'expr', def: '', showIf: { op: 'products' } },
        ...stockParams('Stok kodu', '{{ $json.stokKodu }}', { listPrice: true }),
        { key: 'taskId', label: 'Görev numarası', type: 'expr', def: '{{ $json.islemNo }}', showIf: { op: 'task' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const max = Math.max(1, Number(c.p.max) || 50);
        if (c.p.op === 'orders') return [(await n11Orders(cr, c.p.status, Number(c.p.days) || 7, max, c.signal)).map(o => ({ json: n11Order(o) }))];
        if (c.p.op === 'products' && !str(c.p.productCode).trim()) {
          const r = await n11(cr, 'GET', `/ms/product-query?page=0&size=${Math.min(100, max)}`, null, c.signal);
          return [(r.content || []).slice(0, max).map(p => ({ json: { urunId: p.n11ProductId ?? p.id, ad: p.title, stokKodu: p.stockCode, stok: p.quantity, satisFiyati: p.salePrice, listeFiyati: p.listPrice, durum: p.status ?? p.productStatus ?? null } }))];
        }
        if (c.p.op === 'stock') {
          const rows = stockRows(c, 'stok kodu'); const out = [];
          for (let i = 0; i < rows.length; i += 1000) {
            const part = rows.slice(i, i + 1000);
            const r = await n11(cr, 'POST', '/ms/product/tasks/price-stock-update', { payload: { integrator: 'Auto-Move', skus: part.map(x => ({ stockCode: x.key, ...(x.quantity !== undefined ? { quantity: x.quantity } : {}), ...(x.price !== undefined ? { salePrice: x.price, listPrice: x.listPrice } : {}), currencyType: 'TL' })) } }, c.signal);
            out.push({ json: { islemNo: r.id ?? r.taskId, durum: r.status ?? null, urunSayisi: part.length, stokKodlari: part.map(x => x.key) } });
          }
          return [out];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'products') {
            const r = await n11(cr, 'GET', `/ms/product-query?stockCode=${encodeURIComponent(R('productCode'))}&page=0&size=1`, null, c.signal); const p = r.content?.[0];
            return { ...it.json, urun: p ? { urunId: p.n11ProductId ?? p.id, ad: p.title, stokKodu: p.stockCode, stok: p.quantity, satisFiyati: p.salePrice, listeFiyati: p.listPrice } : null };
          }
          if (c.p.op === 'task') {
            const id = R('taskId'); if (!id) throw new Error('Görev numarası boş');
            const r = await n11(cr, 'POST', '/ms/product/task-details/page-query', { taskId: Number.isNaN(Number(id)) ? id : Number(id), pageable: { page: 0, size: 1000 } }, c.signal);
            const rows = r.skus?.content || r.content || []; const bad = rows.filter(x => /fail|error|hata/i.test(String(x.status)));
            return { islemNo: id, durum: r.status ?? null, toplam: rows.length, hatali: bad.length, hatalar: bad.map(x => ({ stokKodu: x.itemCode ?? x.stockCode ?? null, neden: [].concat(x.reasons || x.reason || []).join('; ') })) };
          }
          const lines = lineList(c.R(c.p.lines, it, 0)).map(l => ({ lineId: Number(l.satirId ?? l.lineId ?? l.orderLineId ?? l.id) })).filter(l => l.lineId);
          if (!lines.length) throw new Error('Satır listesi boş; siparişin urunler alanını verin');
          await n11(cr, 'PUT', '/rest/order/v1/update', { lines, status: 'Picking' }, c.signal);
          return { ...it.json, durum: 'Picking' };
        });
      },
    },
    n11Trigger: {
      label: 'N11\'de yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'N11 mağazanızı düzenli kontrol eder; her yeni siparişte (Oluşturuldu durumundaki paket) akışı çalıştırır.',
      params: pollParams(2, 'm', [cred(['n11Api'], 'N11 mağaza hesabı')]),
      async poll(c) { return newOnly(c, await n11Orders(await c.credential(c.p.credential), 'Created', 3, 100), o => o.id).map(n11Order); },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { paketId: 210000001, siparisNo: '205000000001', durum: 'Created', musteri: 'Ayşe Yılmaz', tutar: 449.9, paraBirimi: 'TRY', adres: { ad: 'Ayşe Yılmaz', il: 'İstanbul', ilce: 'Kadıköy', acikAdres: 'Moda Cd. 1' }, urunler: [{ satirId: 1, ad: 'Seramik Kupa', stokKodu: 'KUP-1', adet: 1, fiyat: 449.9, tutar: 449.9 }], pazaryeri: 'N11' } }]]; },
      eachItem: true,
    },

    amazon: {
      label: 'Amazon', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'Amazon satıcı hesabınızda (Amazon.com.tr ve diğer ülkeler, SP-API) siparişleri ürünleriyle listeler, kargo takip numarasıyla gönderimi onaylar, ürünün stok ve fiyatını günceller ve ürün bilgisini getirir.',
      params: [
        cred(['amazonSpApi'], 'Amazon satıcı hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Siparişleri listele'], ['ship', 'Gönderimi onayla (takip no)'], ['stock', 'Stok ve fiyat güncelle'], ['listing', 'Ürün bilgisini getir']] },
        { key: 'status', label: 'Durum', type: 'select', def: 'Unshipped,PartiallyShipped', options: AMZ_STATUS, showIf: { op: 'orders' } },
        { key: 'days', label: 'Son kaç gün', type: 'number', def: 7, min: 1, showIf: { op: 'orders' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 20, min: 1, showIf: { op: 'orders' } },
        { key: 'withItems', label: 'Sipariş ürünlerini de getir', type: 'toggle', def: true, showIf: { op: 'orders' }, help: 'Her sipariş için ayrı bir istek yapar; çok siparişte Amazon\'un istek sınırına takılabilir.' },
        { key: 'orderId', label: 'Sipariş no', type: 'expr', def: '{{ $json.siparisNo }}', showIf: { op: 'ship' } },
        { key: 'lines', label: 'Satırlar', type: 'expr', def: '{{ $json.urunler }}', showIf: { op: 'ship' } },
        { key: 'carrier', label: 'Kargo firması', type: 'expr', def: 'Yurtiçi Kargo', showIf: { op: 'ship' }, help: 'Amazon\'un listesinde olmayan firmalar adıyla gönderilir.' },
        { key: 'tracking', label: 'Takip numarası', type: 'expr', def: '{{ $json.takipNo }}', showIf: { op: 'ship' } },
        ...stockParams('Satıcı SKU', '{{ $json.stokKodu }}'),
        { key: 'productSku', label: 'Satıcı SKU', type: 'expr', def: '{{ $json.stokKodu }}', showIf: { op: 'listing' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const d = cr.data; const [mid, , currency] = market(d);
        const seller = String(d.sellerId || '').trim(); if (['stock', 'listing'].includes(c.p.op) && !seller) throw new Error('Amazon satıcı ID boş');
        if (c.p.op === 'orders') {
          const list = await amzOrders(cr, c.p.status, Number(c.p.days) || 7, Math.max(1, Number(c.p.max) || 20), c.signal); const out = [];
          for (const o of list) { c.checkAbort(); out.push({ json: amzOrder(o, c.p.withItems === false ? [] : await amzItems(cr, o.AmazonOrderId, c.signal)) }); }
          return [out];
        }
        if (c.p.op === 'stock') {
          const out = [];
          for (const x of stockRows(c, 'SKU')) {
            const patches = [];
            if (x.quantity !== undefined) patches.push({ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: x.quantity }] });
            if (x.price !== undefined) patches.push({ op: 'replace', path: '/attributes/purchasable_offer', value: [{ marketplace_id: mid, currency, our_price: [{ schedule: [{ value_with_tax: x.price }] }] }] });
            const r = await amazon(cr, 'PATCH', `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(x.key)}?marketplaceIds=${mid}`, { productType: 'PRODUCT', patches }, c.signal);
            const errs = (r.issues || []).filter(i => i.severity === 'ERROR');
            if (r.status !== 'ACCEPTED' || errs.length) throw new Error(`Amazon "${x.key}" güncellemesini kabul etmedi: ${errs.map(i => i.message).join('; ') || r.status}`);
            out.push({ json: { stokKodu: x.key, durum: r.status, islemNo: r.submissionId, ...(x.quantity !== undefined ? { stok: x.quantity } : {}), ...(x.price !== undefined ? { fiyat: x.price, paraBirimi: currency } : {}) } });
          }
          return [out];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'listing') {
            const sku = R('productSku'); if (!sku) throw new Error('SKU boş');
            const r = await amazon(cr, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(sku)}?marketplaceIds=${mid}&includedData=summaries,offers,fulfillmentAvailability,issues`, null, c.signal);
            const s = r.summaries?.[0] || {}; const offer = (r.offers || []).find(o => o.offerType !== 'B2B') || r.offers?.[0];
            return { ...it.json, urun: { stokKodu: r.sku ?? sku, asin: s.asin ?? null, ad: s.itemName ?? null, durum: s.status ?? [], stok: r.fulfillmentAvailability?.find(f => f.fulfillmentChannelCode === 'DEFAULT')?.quantity ?? null, fiyat: offer ? amount(offer.price) : null, paraBirimi: offer?.price?.currencyCode ?? currency, sorunlar: (r.issues || []).map(i => i.message) } };
          }
          const id = R('orderId'); if (!/^\d{3}-\d{7}-\d{7}$/.test(id)) throw new Error(`Amazon sipariş numarası 123-1234567-1234567 biçiminde olmalı: "${id}"`);
          const tracking = R('tracking'); if (!tracking) throw new Error('Takip numarası boş');
          let lines = lineList(c.R(c.p.lines, it, 0)).map(l => ({ orderItemId: String(l.satirId ?? l.OrderItemId ?? l.id ?? ''), quantity: Number(l.adet ?? l.quantity ?? 1) })).filter(l => l.orderItemId);
          if (!lines.length) lines = (await amzItems(cr, id, c.signal)).map(l => ({ orderItemId: l.OrderItemId, quantity: Number(l.QuantityOrdered ?? 1) }));
          await amazon(cr, 'POST', `/orders/v0/orders/${encodeURIComponent(id)}/shipmentConfirmation`, { marketplaceId: mid, packageDetail: { packageReferenceId: '1', carrierCode: 'Other', carrierName: R('carrier') || 'Kargo', trackingNumber: tracking, shipDate: new Date().toISOString(), orderItems: lines } }, c.signal);
          return { ...it.json, takipNo: tracking, kargo: R('carrier'), durum: 'Shipped' };
        });
      },
    },
    amazonTrigger: {
      label: 'Amazon\'da yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Amazon satıcı hesabınızı düzenli kontrol eder; gönderilmeyi bekleyen her yeni siparişte, ürünleriyle birlikte akışı çalıştırır.',
      params: pollParams(5, 'm', [cred(['amazonSpApi'], 'Amazon satıcı hesabı')]),
      async poll(c) {
        const cr = await c.credential(c.p.credential);
        const fresh = newOnly(c, await amzOrders(cr, 'Unshipped,PartiallyShipped', 3, 100), o => o.AmazonOrderId); const out = [];
        for (const o of fresh) out.push(amzOrder(o, await amzItems(cr, o.AmazonOrderId)));
        return out;
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { paketId: '407-1234567-1234567', siparisNo: '407-1234567-1234567', durum: 'Unshipped', musteri: 'Ayşe Yılmaz', tutar: 449.9, paraBirimi: 'TRY', gonderim: 'Satıcı', adres: { ad: 'Ayşe Yılmaz', il: 'İstanbul', ilce: 'Kadıköy', acikAdres: 'Moda Cd. 1' }, urunler: [{ satirId: '12345678901234', ad: 'Seramik Kupa', asin: 'B0TEST0001', stokKodu: 'KUP-1', adet: 1, fiyat: 449.9, tutar: 449.9 }], pazaryeri: 'Amazon' } }]]; },
      eachItem: true,
    },
  };

  async function test(type, d) {
    if (type === 'hepsiburadaApi') { const r = await hb({ data: d }, 'listing', 'GET', '/listings/merchantid/{mid}?offset=0&limit=1', null); return `Bağlanıldı (${d.stage === 'true' ? 'test' : 'canlı'}); ${r.totalCount ?? r.listings?.length ?? 0} ürün`; }
    if (type === 'n11Api') { const r = await n11({ data: d }, 'GET', '/ms/product-query?page=0&size=1', null); return `Bağlanıldı; ${r.totalElements ?? r.content?.length ?? 0} ürün`; }
    if (type === 'amazonSpApi') { const r = await amazon({ data: d }, 'GET', '/sellers/v1/marketplaceParticipations', null); const m = market(d); const ok = (r.payload || []).some(x => x.marketplace?.id === m[0]); return `Bağlanıldı; ${ok ? `${m[1]} mağazası açık` : `hesapta ${m[1]} mağazası görünmüyor`}`; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
