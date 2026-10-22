'use strict';
/* Türkiye'ye özel iş uygulamaları: Trendyol pazaryeri (+ yeni sipariş tetikleyicisi) ve Paraşüt ön muhasebe.
   N8N8_TRENDYOL_API and N8N8_PARASUT_API point them at other base URLs (tests). */

const CREDENTIAL_TYPES = {
  trendyolApi: { label: 'Trendyol satıcı hesabı', fields: [
    { key: 'sellerId', label: 'Satıcı ID (Cari ID)', help: 'Satıcı paneli → Hesap Bilgilerim → Entegrasyon Bilgileri' },
    { key: 'apiKey', label: 'API Key' }, { key: 'apiSecret', label: 'API Secret', secret: true },
    { key: 'stage', label: 'Ortam', def: 'false', options: [['false', 'Canlı'], ['true', 'Test (stage)']] }] },
  parasutApi: { label: 'Paraşüt', fields: [
    { key: 'companyId', label: 'Firma numarası', help: 'Paraşüt\'e girince adres çubuğundaki sayı: uygulama.parasut.com/123456/…' },
    { key: 'clientId', label: 'Client ID', help: 'API erişimi için Paraşüt destekten alınır' }, { key: 'clientSecret', label: 'Client Secret', secret: true },
    { key: 'user', label: 'Paraşüt e-postanız' }, { key: 'password', label: 'Paraşüt şifreniz', secret: true }] },
};

module.exports = function trNodes(h) {
  const { httpRequest } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const num = v => { const t = String(v ?? '').replace(/[\s₺$€]|TL/gi, ''); return Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); };
  const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); // Türkiye saati
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const newOnly = (c, list, idOf) => {
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };

  /* ---------- Trendyol ---------- */
  async function trendyol(cr, method, p, body, signal) {
    const d = cr.data; const sid = String(d.sellerId || '').trim(); if (!/^\d+$/.test(sid)) throw new Error('Trendyol satıcı ID sayı olmalı');
    const base = env('N8N8_TRENDYOL_API', d.stage === 'true' ? 'https://stageapigw.trendyol.com/integration' : 'https://apigw.trendyol.com/integration');
    const r = await httpRequest({ method, url: `${base}${p.replace('{sid}', sid)}`, headers: { Authorization: `Basic ${Buffer.from(`${d.apiKey}:${d.apiSecret}`).toString('base64')}`, 'User-Agent': `${sid} - SelfIntegration`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    if (!r.ok) {
      const e = r.body?.errors?.[0]; const msg = r.status === 401 ? 'API Key ya da Secret yanlış' : r.status === 403 ? 'erişim reddedildi (satıcı ID ve User-Agent eşleşmeli)' : r.status === 429 ? 'çok sık istek, biraz bekleyin' : e?.message || e?.key || r.body?.message || str(r.body).slice(0, 200);
      throw new Error(`Trendyol (${r.status}): ${msg}`);
    }
    return r.body;
  }
  const STATUS = [['Created', 'Yeni (Oluşturuldu)'], ['Picking', 'Hazırlanıyor'], ['Invoiced', 'Faturalandı'], ['Shipped', 'Kargoda'], ['Delivered', 'Teslim edildi'], ['Cancelled', 'İptal'], ['UnDelivered', 'Teslim edilemedi'], ['Returned', 'İade']];
  const tyOrder = o => ({
    paketId: o.id ?? o.shipmentPackageId, siparisNo: o.orderNumber, durum: o.status ?? o.shipmentPackageStatus,
    musteri: [o.customerFirstName, o.customerLastName].filter(Boolean).join(' ') || o.shipmentAddress?.fullName, eposta: o.customerEmail,
    tutar: o.totalPrice ?? o.grossAmount, paraBirimi: o.currencyCode || 'TRY', tarih: o.orderDate ? new Date(o.orderDate).toISOString() : null,
    kargo: o.cargoProviderName, takipNo: o.cargoTrackingNumber, takipAdresi: o.cargoTrackingLink,
    adres: o.shipmentAddress ? { ad: o.shipmentAddress.fullName, telefon: o.shipmentAddress.phone, il: o.shipmentAddress.city, ilce: o.shipmentAddress.district, acikAdres: o.shipmentAddress.fullAddress } : null,
    urunler: (o.lines || []).map(l => ({ satirId: l.id, ad: l.productName, barkod: l.barcode, stokKodu: l.merchantSku, adet: l.quantity, fiyat: l.price, tutar: l.amount })),
  });

  /* ---------- Paraşüt (JSON:API, OAuth parola akışı; jeton 2 saat geçerli, bellekte tutulur) ---------- */
  const tokens = new Map();
  async function parasutToken(d, signal, fresh) {
    const k = require('crypto').createHash('sha256').update(JSON.stringify([d.clientId, d.clientSecret, d.user, d.password])).digest('hex'); const t = tokens.get(k);
    if (!fresh && t && t.until > Date.now() + 60000) return t.token;
    const r = await httpRequest({ method: 'POST', url: `${env('N8N8_PARASUT_API', 'https://api.parasut.com')}/oauth/token`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: d.clientId || '', client_secret: d.clientSecret || '', username: d.user || '', password: d.password || '', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }).toString(), signal, timeout: 30000 });
    if (!r.ok || !r.body?.access_token) throw new Error(`Paraşüt girişi başarısız: ${r.body?.error === 'invalid_grant' ? 'e-posta ya da şifre yanlış' : r.body?.error === 'invalid_client' ? 'Client ID ya da Secret yanlış' : r.body?.error_description || r.status}`);
    tokens.set(k, { token: r.body.access_token, until: Date.now() + (Number(r.body.expires_in) || 7200) * 1000 });
    return r.body.access_token;
  }
  async function parasut(cr, method, p, body, signal) {
    const d = cr.data; const cid = String(d.companyId || '').trim(); if (!/^\d+$/.test(cid)) throw new Error('Paraşüt firma numarası sayı olmalı');
    const go = async fresh => httpRequest({ method, url: `${env('N8N8_PARASUT_API', 'https://api.parasut.com')}/v4/${cid}${p}`, headers: { Authorization: `Bearer ${await parasutToken(d, signal, fresh)}`, 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' }, body: body == null ? undefined : JSON.stringify(body), signal, timeout: 60000 });
    let r = await go(false); if (r.status === 401) r = await go(true);
    if (!r.ok) { const e = r.body?.errors?.[0]; throw new Error(`Paraşüt (${r.status}): ${e ? [e.title, e.detail].filter(Boolean).join(' - ') : str(r.body).slice(0, 200)}`); }
    return r.body;
  }
  const flat = x => (x ? { id: x.id, tur: x.type, ...x.attributes } : null);
  const lineList = (v, vatIncluded) => {
    let a = v; if (typeof a === 'string') { const t = a.trim(); if (!t) return []; try { a = JSON.parse(t); } catch (e) { throw new Error(`Fatura satırları geçerli JSON değil: ${e.message}`); } }
    if (!Array.isArray(a)) a = [a];
    return a.map((l, i) => {
      const qty = num(l.adet ?? l.quantity ?? 1), price = num(l.fiyat ?? l.birimFiyat ?? l.unit_price ?? l.price), vat = num(l.kdv ?? l.vat_rate ?? 20);
      if (!Number.isFinite(price)) throw new Error(`${i + 1}. satırda fiyat yok ya da sayı değil`);
      return { type: 'sales_invoice_details', attributes: { quantity: qty, unit_price: vatIncluded ? Math.round(price / (1 + vat / 100) * 10000) / 10000 : price, vat_rate: vat, description: str(l.ad ?? l.aciklama ?? l.description ?? '') }, ...(l.urunId ? { relationships: { product: { data: { id: String(l.urunId), type: 'products' } } } } : {}) };
    });
  };

  const NODES = {
    trendyol: {
      label: 'Trendyol', cat: 'app', icon: 'cart', inputs: 1, outputs: ['main'],
      desc: 'Trendyol satıcı hesabınızda siparişleri listeler, paket durumunu günceller (Hazırlanıyor / Faturalandı), fatura bağlantısı gönderir, stok ve fiyat günceller, ürünleri ve müşteri sorularını getirir, sorulara cevap yazar.',
      params: [
        cred(['trendyolApi'], 'Trendyol satıcı hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'orders', options: [['orders', 'Siparişleri listele'], ['status', 'Paket durumunu güncelle'], ['invoice', 'Fatura bağlantısı gönder'], ['stock', 'Stok ve fiyat güncelle'], ['batch', 'Toplu işlem sonucunu sorgula'], ['products', 'Ürünleri listele'], ['questions', 'Cevap bekleyen soruları getir'], ['answer', 'Soruya cevap yaz']] },
        { key: 'status', label: 'Durum', type: 'select', def: 'Created', options: [['', 'Hepsi'], ...STATUS], showIf: { op: 'orders' } },
        { key: 'days', label: 'Son kaç gün', type: 'number', def: 7, min: 1, showIf: { op: 'orders' }, help: 'Trendyol en fazla 14 günlük aralık verir.' },
        { key: 'max', label: 'En fazla', type: 'number', def: 50, min: 1, showIf: { op: ['orders', 'products', 'questions'] } },
        { key: 'packageId', label: 'Paket ID', type: 'expr', def: '{{ $json.paketId }}', showIf: { op: ['status', 'invoice'] } },
        { key: 'newStatus', label: 'Yeni durum', type: 'select', def: 'Picking', options: [['Picking', 'Hazırlanıyor'], ['Invoiced', 'Faturalandı']], showIf: { op: 'status' } },
        { key: 'lines', label: 'Satırlar', type: 'expr', def: '{{ $json.urunler }}', showIf: { op: 'status' }, help: 'Siparişteki ürün listesi (satirId ve adet içerir). "Siparişleri listele" çıktısındaki urunler alanı doğrudan kullanılabilir.' },
        { key: 'invoiceNumber', label: 'Fatura numarası', type: 'expr', def: '{{ $json.faturaNo }}', showIf: { op: 'status' }, help: 'Yalnızca Faturalandı durumu için gereklidir.' },
        { key: 'invoiceLink', label: 'Fatura adresi (PDF bağlantısı)', type: 'expr', def: '{{ $json.faturaAdresi }}', showIf: { op: 'invoice' } },
        { key: 'barcode', label: 'Barkod', type: 'expr', def: '{{ $json.barkod }}', showIf: { op: 'stock' } },
        { key: 'productBarcode', label: 'Barkod (boş = bütün ürünler)', type: 'expr', def: '', showIf: { op: 'products' } },
        { key: 'quantity', label: 'Stok adedi (boş = değiştirme)', type: 'expr', def: '{{ $json.stok }}', showIf: { op: 'stock' } },
        { key: 'salePrice', label: 'Satış fiyatı (boş = değiştirme)', type: 'expr', def: '', showIf: { op: 'stock' } },
        { key: 'listPrice', label: 'Liste fiyatı (boş = satış fiyatı)', type: 'expr', def: '', showIf: { op: 'stock' } },
        { key: 'batchId', label: 'İşlem numarası', type: 'expr', def: '{{ $json.islemNo }}', showIf: { op: 'batch' } },
        { key: 'questionId', label: 'Soru ID', type: 'expr', def: '{{ $json.soruId }}', showIf: { op: 'answer' } },
        { key: 'answer', label: 'Cevap', type: 'textarea', def: '{{ $json.cevap }}', showIf: { op: 'answer' }, help: 'Trendyol en az 10, en çok 2000 karakter kabul eder.' },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const max = Math.max(1, Number(c.p.max) || 50);
        if (c.p.op === 'orders') {
          const days = Math.min(14, Math.max(1, Number(c.p.days) || 7)); const end = Date.now(); const start = end - days * 86400000;
          const out = [];
          for (let page = 0; out.length < max; page++) {
            const r = await trendyol(cr, 'GET', `/order/sellers/{sid}/orders?${new URLSearchParams({ ...(c.p.status ? { status: c.p.status } : {}), startDate: String(start), endDate: String(end), page: String(page), size: String(Math.min(200, max)), orderByField: 'PackageLastModifiedDate', orderByDirection: 'DESC' })}`, null, c.signal);
            out.push(...(r.content || []).map(tyOrder)); if (page + 1 >= (r.totalPages || 1) || !(r.content || []).length) break;
          }
          return [out.slice(0, max).map(json => ({ json }))];
        }
        if (c.p.op === 'products' && !str(c.p.productBarcode).trim()) {
          const r = await trendyol(cr, 'GET', `/product/sellers/{sid}/products?page=0&size=${Math.min(200, max)}&approved=true`, null, c.signal);
          return [(r.content || []).slice(0, max).map(p => ({ json: { id: p.id, ad: p.title, barkod: p.barcode, stokKodu: p.stockCode, marka: p.brand, stok: p.quantity, satisFiyati: p.salePrice, listeFiyati: p.listPrice, kdv: p.vatRate, onayli: p.approved, satista: p.onSale, adres: p.productUrl } }))];
        }
        if (c.p.op === 'questions') {
          const r = await trendyol(cr, 'GET', `/qna/sellers/{sid}/questions/filter?status=WAITING_FOR_ANSWER&size=${Math.min(50, max)}&page=0`, null, c.signal);
          return [(r.content || []).slice(0, max).map(q => ({ json: { soruId: q.id, soru: q.text, urun: q.productName, musteri: q.userName || q.customerName, tarih: q.creationDate ? new Date(q.creationDate).toISOString() : null, kalanSure: q.answeringDeadline ?? null } }))];
        }
        if (c.p.op === 'stock') {
          const list = []; const its = items(c);
          for (let i = 0; i < its.length; i++) {
            const R = k => str(c.R(c.p[k], its[i], i)).trim(); const barcode = R('barcode'); if (!barcode) throw new Error(`${i + 1}. öğede barkod yok`);
            const x = { barcode }; const q = R('quantity'), s = R('salePrice'), l = R('listPrice');
            if (q !== '') { x.quantity = Math.trunc(num(q)); if (!Number.isFinite(x.quantity) || x.quantity < 0) throw new Error(`"${barcode}" için stok adedi geçersiz: ${q}`); }
            if (s !== '') { x.salePrice = num(s); if (!(x.salePrice > 0)) throw new Error(`"${barcode}" için satış fiyatı geçersiz: ${s}`); x.listPrice = l !== '' ? num(l) : x.salePrice; if (x.listPrice < x.salePrice) throw new Error(`"${barcode}": liste fiyatı satış fiyatından düşük olamaz`); }
            if (Object.keys(x).length === 1) throw new Error(`"${barcode}" için ne stok ne fiyat verilmiş`);
            list.push(x);
          }
          const out = [];
          for (let i = 0; i < list.length; i += 1000) { const r = await trendyol(cr, 'POST', '/inventory/sellers/{sid}/products/price-and-inventory', { items: list.slice(i, i + 1000) }, c.signal); out.push({ json: { islemNo: r.batchRequestId, urunSayisi: list.slice(i, i + 1000).length, barkodlar: list.slice(i, i + 1000).map(x => x.barcode) } }); }
          return [out];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'products') {
            const r = await trendyol(cr, 'GET', `/product/sellers/{sid}/products?barcode=${encodeURIComponent(R('productBarcode'))}`, null, c.signal); const p = r.content?.[0];
            return p ? { ...it.json, urun: { id: p.id, ad: p.title, barkod: p.barcode, stok: p.quantity, satisFiyati: p.salePrice, listeFiyati: p.listPrice, satista: p.onSale } } : { ...it.json, urun: null };
          }
          if (c.p.op === 'batch') {
            const r = await trendyol(cr, 'GET', `/product/sellers/{sid}/products/batch-requests/${encodeURIComponent(R('batchId'))}`, null, c.signal);
            return { islemNo: r.batchRequestId, durum: r.status, toplam: r.itemCount, hatali: r.failedItemCount, hatalar: (r.items || []).filter(x => x.status === 'FAILED').map(x => ({ barkod: x.requestItem?.barcode, neden: (x.failureReasons || []).join('; ') })) };
          }
          if (c.p.op === 'answer') {
            const text = R('answer'); if (text.length < 10 || text.length > 2000) throw new Error(`Cevap 10-2000 karakter olmalı (şu an ${text.length})`);
            await trendyol(cr, 'POST', `/qna/sellers/{sid}/questions/${encodeURIComponent(R('questionId'))}/answers`, { text }, c.signal);
            return { ...it.json, cevaplandi: true };
          }
          const pkg = R('packageId'); if (!/^\d+$/.test(pkg)) throw new Error(`Paket ID sayı olmalı: "${pkg}"`);
          if (c.p.op === 'invoice') {
            const link = R('invoiceLink'); if (!/^https?:\/\//.test(link)) throw new Error(`Fatura adresi http ile başlamalı: "${link}"`);
            await trendyol(cr, 'POST', '/order/sellers/{sid}/seller-invoice-links', { invoiceLink: link, shipmentPackageId: Number(pkg) }, c.signal);
            return { ...it.json, faturaGonderildi: true };
          }
          let lines = c.R(c.p.lines, it, 0); if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = []; } }
          lines = (Array.isArray(lines) ? lines : []).map(l => ({ lineId: Number(l.satirId ?? l.lineId ?? l.id), quantity: Number(l.adet ?? l.quantity ?? 1) })).filter(l => l.lineId);
          if (!lines.length) throw new Error('Satır listesi boş; siparişin urunler alanını verin');
          const params = {};
          if (c.p.newStatus === 'Invoiced') { params.invoiceNumber = R('invoiceNumber'); if (!params.invoiceNumber) throw new Error('Faturalandı durumu için fatura numarası gerekli'); }
          await trendyol(cr, 'PUT', `/order/sellers/{sid}/shipment-packages/${pkg}`, { lines, params, status: c.p.newStatus }, c.signal);
          return { ...it.json, durum: c.p.newStatus };
        });
      },
    },
    trendyolTrigger: {
      label: 'Trendyol\'da yeni sipariş', cat: 'trigger', icon: 'cart', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Trendyol satıcı hesabınızı düzenli kontrol eder; her yeni siparişte (Oluşturuldu durumundaki paket) akışı çalıştırır.',
      params: pollParams(2, 'm', [cred(['trendyolApi'], 'Trendyol satıcı hesabı')]),
      async poll(c) {
        const end = Date.now(); const r = await trendyol(await c.credential(c.p.credential), 'GET', `/order/sellers/{sid}/orders?status=Created&startDate=${end - 3 * 86400000}&endDate=${end}&page=0&size=100&orderByField=PackageLastModifiedDate&orderByDirection=DESC`, null);
        return newOnly(c, r.content || [], o => o.id ?? o.shipmentPackageId).map(tyOrder);
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { paketId: 3360000001, siparisNo: '10560000001', durum: 'Created', musteri: 'Ayşe Yılmaz', tutar: 449.9, paraBirimi: 'TRY', adres: { ad: 'Ayşe Yılmaz', il: 'İstanbul', ilce: 'Kadıköy', acikAdres: 'Moda Cd. 1' }, urunler: [{ satirId: 1, ad: 'Seramik Kupa', barkod: '8690000000011', adet: 1, fiyat: 449.9 }] } }]]; },
      eachItem: true,
    },

    parasut: {
      label: 'Paraşüt', cat: 'app', icon: 'coin', inputs: 1, outputs: ['main'],
      desc: 'Paraşüt ön muhasebede müşteri arar ve oluşturur, satış faturası keser, faturaya tahsilat işler, faturaları listeler ve faturayı e-Fatura / e-Arşiv olarak resmileştirir.',
      params: [
        cred(['parasutApi'], 'Paraşüt hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'invoice', options: [['contacts', 'Müşteri ara'], ['contact', 'Müşteri oluştur'], ['invoice', 'Satış faturası oluştur'], ['invoices', 'Faturaları listele'], ['pay', 'Faturaya tahsilat ekle'], ['formalize', 'e-Fatura / e-Arşiv\'e dönüştür']] },
        { key: 'search', label: 'Ara (ad, e-posta ya da vergi no)', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'contacts' } },
        { key: 'name', label: 'Ad / unvan', type: 'expr', def: '{{ $json.musteri }}', showIf: { op: 'contact' } },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'contact' } },
        { key: 'phone', label: 'Telefon', type: 'expr', def: '{{ $json.telefon }}', showIf: { op: 'contact' } },
        { key: 'taxNumber', label: 'TCKN / Vergi no', type: 'expr', def: '{{ $json.vergiNo }}', showIf: { op: 'contact' } },
        { key: 'taxOffice', label: 'Vergi dairesi', type: 'expr', def: '', showIf: { op: 'contact' } },
        { key: 'city', label: 'İl', type: 'expr', def: '{{ $json.il }}', showIf: { op: 'contact' } },
        { key: 'district', label: 'İlçe', type: 'expr', def: '{{ $json.ilce }}', showIf: { op: 'contact' } },
        { key: 'address', label: 'Adres', type: 'expr', def: '{{ $json.adres }}', showIf: { op: 'contact' } },
        { key: 'contactId', label: 'Müşteri ID', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'invoice' } },
        { key: 'description', label: 'Fatura açıklaması', type: 'expr', def: 'Sipariş {{ $json.siparisNo }}', showIf: { op: 'invoice' } },
        { key: 'lines', label: 'Satırlar', type: 'textarea', def: '[{ "ad": "Danışmanlık", "adet": 1, "fiyat": 1000, "kdv": 20 }]', showIf: { op: 'invoice' }, help: 'JSON dizi ya da {{ $json.urunler }}. Her satır: ad, adet, fiyat (KDV hariç birim fiyat), kdv (oran), isteğe bağlı urunId.' },
        { key: 'vatIncluded', label: 'Fiyatlar KDV dahil', type: 'toggle', def: false, showIf: { op: 'invoice' }, help: 'Pazaryeri ve mağaza fiyatları genellikle KDV dahildir; açıkken KDV hariç birim fiyat hesaplanır.' },
        { key: 'issueDate', label: 'Fatura tarihi (boş = bugün)', type: 'expr', def: '', showIf: { op: ['invoice', 'pay'] } },
        { key: 'dueDays', label: 'Vade (gün)', type: 'number', def: 0, min: 0, showIf: { op: 'invoice' } },
        { key: 'currency', label: 'Para birimi', type: 'select', def: 'TRL', options: [['TRL', 'TL'], ['USD', 'Dolar'], ['EUR', 'Euro'], ['GBP', 'Sterlin']], showIf: { op: 'invoice' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 25, min: 1, showIf: { op: 'invoices' } },
        { key: 'invoiceId', label: 'Fatura ID', type: 'expr', def: '{{ $json.faturaId }}', showIf: { op: ['pay', 'formalize'] } },
        { key: 'accountId', label: 'Kasa / banka hesabı ID', type: 'expr', def: '', showIf: { op: 'pay' }, help: 'Paraşüt → Kasa ve Bankalar\'da hesabı açınca adres çubuğundaki sayı.' },
        { key: 'amount', label: 'Tutar', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: 'pay' } },
        { key: 'internetSale', label: 'İnternet satışı (e-Arşiv için)', type: 'toggle', def: true, showIf: { op: 'formalize' } },
        { key: 'saleUrl', label: 'Satış yapılan site', type: 'expr', def: 'https://magazam.com', showIf: { op: 'formalize' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'invoices') {
          const r = await parasut(cr, 'GET', `/sales_invoices?sort=-issue_date&page[size]=${Math.min(25, Math.max(1, Number(c.p.max) || 25))}&include=contact`, null, c.signal);
          const contacts = Object.fromEntries((r.included || []).filter(x => x.type === 'contacts').map(x => [x.id, x.attributes?.name]));
          return [(r.data || []).map(x => ({ json: { faturaId: x.id, aciklama: x.attributes.description, tarih: x.attributes.issue_date, vade: x.attributes.due_date, tutar: Number(x.attributes.net_total ?? x.attributes.gross_total), kalan: Number(x.attributes.remaining ?? 0), paraBirimi: x.attributes.currency, musteri: contacts[x.relationships?.contact?.data?.id] ?? null, durum: x.attributes.payment_status } }))];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'contacts') {
            const q = R('search'); const key = /@/.test(q) ? 'email' : /^\d{10,11}$/.test(q) ? 'tax_number' : 'name';
            const r = await parasut(cr, 'GET', `/contacts?filter[${key}]=${encodeURIComponent(q)}&page[size]=5`, null, c.signal);
            const first = r.data?.[0]; return { ...it.json, musteriBulundu: !!first, ...(first ? { id: first.id, musteriAdi: first.attributes.name } : {}) };
          }
          if (c.p.op === 'contact') {
            const tax = R('taxNumber').replace(/\s/g, ''); const name = R('name'); if (!name) throw new Error('Müşteri adı boş');
            const r = await parasut(cr, 'POST', '/contacts', { data: { type: 'contacts', attributes: { account_type: 'customer', name, email: R('email') || undefined, phone: R('phone') || undefined, tax_number: tax || undefined, tax_office: R('taxOffice') || undefined, city: R('city') || undefined, district: R('district') || undefined, address: R('address') || undefined, contact_type: tax.length === 10 ? 'company' : 'person' } } }, c.signal);
            return { ...it.json, ...flat(r.data) };
          }
          if (c.p.op === 'invoice') {
            const contactId = R('contactId'); if (!contactId) throw new Error('Müşteri ID boş');
            const details = lineList(c.R(c.p.lines, it, 0), !!c.p.vatIncluded); if (!details.length) throw new Error('Fatura satırı yok');
            const issue = R('issueDate') || today(); const due = new Date(Date.parse(`${issue}T00:00:00Z`) + (Number(c.p.dueDays) || 0) * 86400000).toISOString().slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(issue)) throw new Error(`Fatura tarihi YYYY-AA-GG biçiminde olmalı: "${issue}"`);
            const r = await parasut(cr, 'POST', '/sales_invoices', { data: { type: 'sales_invoices', attributes: { item_type: 'invoice', description: R('description'), issue_date: issue, due_date: due, currency: c.p.currency || 'TRL' }, relationships: { contact: { data: { id: contactId, type: 'contacts' } }, details: { data: details } } } }, c.signal);
            const a = r.data.attributes; return { ...it.json, faturaId: r.data.id, faturaTutari: Number(a.net_total ?? a.gross_total), kdv: Number(a.total_vat ?? 0), faturaTarihi: a.issue_date };
          }
          const inv = R('invoiceId'); if (!/^\d+$/.test(inv)) throw new Error(`Fatura ID sayı olmalı: "${inv}"`);
          if (c.p.op === 'pay') {
            const amount = num(R('amount')); if (!(amount > 0)) throw new Error(`Tahsilat tutarı geçersiz: "${R('amount')}"`);
            const acc = R('accountId'); if (!/^\d+$/.test(acc)) throw new Error('Kasa / banka hesabı ID gerekli');
            const r = await parasut(cr, 'POST', `/sales_invoices/${inv}/payments`, { data: { type: 'payments', attributes: { account_id: Number(acc), date: R('issueDate') || today(), amount } } }, c.signal);
            return { ...it.json, tahsilatId: r.data?.id, tahsilEdilen: amount };
          }
          // formalize: e-Fatura when the customer is registered for it, otherwise e-Arşiv
          const invr = await parasut(cr, 'GET', `/sales_invoices/${inv}?include=contact`, null, c.signal);
          const contact = (invr.included || []).find(x => x.type === 'contacts'); const vkn = contact?.attributes?.tax_number;
          let inbox = null;
          if (vkn) { const ib = await parasut(cr, 'GET', `/e_invoice_inboxes?filter[vkn]=${encodeURIComponent(vkn)}`, null, c.signal); inbox = ib.data?.[0]?.attributes?.e_invoice_address || null; }
          const rel = { invoice: { data: { id: inv, type: 'sales_invoices' } } };
          const r = inbox
            ? await parasut(cr, 'POST', '/e_invoices', { data: { type: 'e_invoices', attributes: { scenario: 'basic', to: inbox }, relationships: rel } }, c.signal)
            : await parasut(cr, 'POST', '/e_archives', { data: { type: 'e_archives', attributes: c.p.internetSale ? { internet_sale: { url: R('saleUrl'), payment_type: 'KREDIKARTI/BANKAKARTI', payment_platform: 'iyzico', payment_date: today() } } : {}, relationships: { sales_invoice: { data: { id: inv, type: 'sales_invoices' } } } } }, c.signal);
          return { ...it.json, faturaId: inv, resmiTur: inbox ? 'e-Fatura' : 'e-Arşiv', isNo: r.data?.id, durum: r.data?.attributes?.status || 'sırada' };
        });
      },
    },
  };

  async function test(type, d) {
    if (type === 'trendyolApi') { const r = await trendyol({ data: d }, 'GET', '/product/sellers/{sid}/products?page=0&size=1', null); return `Bağlanıldı (${d.stage === 'true' ? 'test' : 'canlı'}); ${r.totalElements ?? 0} ürün`; }
    if (type === 'parasutApi') { const r = await parasut({ data: d }, 'GET', '/contacts?page[size]=1', null); return `Giriş yapıldı; ${r.meta?.total_count ?? r.data?.length ?? 0} müşteri kaydı`; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
