'use strict';
/* Everyday utility nodes: TCMB exchange rates, weather (Open-Meteo, no key needed), QR codes and validation of
   Turkish identifiers (TCKN, VKN, IBAN, phone) plus e-mail and card numbers. Merged into NODES by nodes.js.
   N8N8_TCMB_API, N8N8_WEATHER_API and N8N8_GEO_API point the services at other base URLs (tests). */
const fs = require('fs');
const path = require('path');

/* ---------- validation ---------- */
const digits = s => String(s ?? '').replace(/\D/g, '');
function tckn(v) {
  const s = digits(v);
  if (s.length !== 11) return { ok: false, why: '11 hane olmalı', value: s };
  const d = [...s].map(Number);
  if (d[0] === 0) return { ok: false, why: 'İlk hane 0 olamaz', value: s };
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  if (((odd * 7 - even) % 10 + 10) % 10 !== d[9] || d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 !== d[10]) return { ok: false, why: 'Kontrol haneleri tutmuyor', value: s };
  return { ok: true, value: s };
}
function vkn(v) {
  const s = digits(v);
  if (s.length !== 10) return { ok: false, why: '10 hane olmalı', value: s };
  let sum = 0;
  for (let i = 0; i < 9; i++) { const t = (Number(s[i]) + 9 - i) % 10; let p = (t * 2 ** (9 - i)) % 9; if (t !== 0 && p === 0) p = 9; sum += p; }
  if ((10 - sum % 10) % 10 !== Number(s[9])) return { ok: false, why: 'Kontrol hanesi tutmuyor', value: s };
  return { ok: true, value: s };
}
const IBAN_LEN = { TR: 26, DE: 22, GB: 22, FR: 27, NL: 18, IT: 27, ES: 24, AT: 20, CH: 21, BE: 16 };
function iban(v) {
  const s = String(v ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return { ok: false, why: 'Biçim hatalı (ülke kodu + 2 kontrol hanesi + hesap)', value: s };
  if (IBAN_LEN[s.slice(0, 2)] && s.length !== IBAN_LEN[s.slice(0, 2)]) return { ok: false, why: `${s.slice(0, 2)} IBAN'ı ${IBAN_LEN[s.slice(0, 2)]} karakter olmalı`, value: s };
  const num = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let r = 0; for (const ch of num) r = (r * 10 + Number(ch)) % 97;
  if (r !== 1) return { ok: false, why: 'Kontrol haneleri tutmuyor', value: s };
  const extra = s.startsWith('TR') ? { bankaKodu: s.slice(4, 9) } : {};
  return { ok: true, value: s.replace(/(.{4})/g, '$1 ').trim(), ...extra };
}
function phone(v) {
  let s = digits(v);
  if (s.startsWith('0090')) s = s.slice(4); else if (s.startsWith('90') && s.length === 12) s = s.slice(2); else if (s.startsWith('0')) s = s.slice(1);
  if (s.length !== 10) return { ok: false, why: '10 haneli numara olmalı (5XX XXX XX XX)', value: s };
  if (!/^[2-5]/.test(s)) return { ok: false, why: 'Türkiye numarası 2, 3, 4 ya da 5 ile başlar', value: s };
  return { ok: true, value: `+90${s}`, mobil: s.startsWith('5'), yerel: `0${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6, 8)} ${s.slice(8)}` };
}
function email(v) {
  const s = String(v ?? '').trim();
  if (!/^[^\s@"<>(),;:]+@[^\s@"<>(),;:]+\.[^\s@"<>(),;:.]{2,}$/u.test(s) || s.includes('..')) return { ok: false, why: 'Geçerli bir e-posta adresi değil', value: s };
  return { ok: true, value: s.replace(/@(.*)$/, (_, d) => `@${d.toLowerCase()}`) };
}
function card(v) {
  const s = digits(v);
  if (s.length < 12 || s.length > 19) return { ok: false, why: '12-19 hane olmalı', value: s };
  let sum = 0; for (let i = 0; i < s.length; i++) { let n = Number(s[s.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  if (sum % 10) return { ok: false, why: 'Luhn kontrolü tutmuyor', value: `**** ${s.slice(-4)}` };
  const brand = /^4/.test(s) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(s) ? 'Mastercard' : /^3[47]/.test(s) ? 'American Express' : /^9792/.test(s) ? 'Troy' : 'diğer';
  return { ok: true, value: `**** ${s.slice(-4)}`, marka: brand }; // never pass the full number on
}
const VALIDATORS = { tckn, vkn, iban, phone, email, card };

/* ---------- TCMB ---------- */
function parseTcmb(xml) {
  const date = (xml.match(/Tarih="([\d.]+)"/) || [])[1] || '';
  const num = s => { const t = String(s || '').trim(); return t ? Number(t) : null; };
  const rates = {};
  for (const m of String(xml).matchAll(/<Currency\b[^>]*Kod="([A-Z]{3})"[^>]*>([\s\S]*?)<\/Currency>/g)) {
    const tag = t => (m[2].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
    rates[m[1]] = { kod: m[1], ad: (tag('Isim') || '').trim(), birim: num(tag('Unit')) || 1, dovizAlis: num(tag('ForexBuying')), dovizSatis: num(tag('ForexSelling')), efektifAlis: num(tag('BanknoteBuying')), efektifSatis: num(tag('BanknoteSelling')) };
  }
  if (!Object.keys(rates).length) throw new Error('TCMB yanıtında kur bulunamadı');
  const [d, mo, y] = date.split('.');
  return { tarih: y ? `${y}-${mo}-${d}` : null, rates };
}

const WMO = { 0: 'Açık', 1: 'Çoğunlukla açık', 2: 'Parçalı bulutlu', 3: 'Kapalı', 45: 'Sisli', 48: 'Kırağılı sis', 51: 'Hafif çisenti', 53: 'Çisenti', 55: 'Yoğun çisenti', 56: 'Dondurucu çisenti', 57: 'Yoğun dondurucu çisenti',
  61: 'Hafif yağmur', 63: 'Yağmur', 65: 'Kuvvetli yağmur', 66: 'Dondurucu yağmur', 67: 'Kuvvetli dondurucu yağmur', 71: 'Hafif kar', 73: 'Kar', 75: 'Yoğun kar', 77: 'Kar taneleri',
  80: 'Hafif sağanak', 81: 'Sağanak', 82: 'Şiddetli sağanak', 85: 'Kar sağanağı', 86: 'Yoğun kar sağanağı', 95: 'Gök gürültülü fırtına', 96: 'Dolulu fırtına', 99: 'Şiddetli dolulu fırtına' };

module.exports = function utilNodes(h) {
  const { httpRequest, safeFile, DIRS } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const items = c => (c.items.length ? c.items : [{ json: {} }]);

  const tcmbCache = new Map(); // date -> { at, data }; today's bulletin is reused for 10 minutes
  async function tcmb(c, dateStr) {
    const base = env('N8N8_TCMB_API', 'https://www.tcmb.gov.tr/kurlar');
    const key = dateStr || 'today'; const hit = tcmbCache.get(key);
    if (hit && (dateStr || Date.now() - hit.at < 600000)) return hit.data;
    let data;
    if (!dateStr) {
      const r = await httpRequest({ url: `${base}/today.xml`, signal: c.signal });
      if (!r.ok) throw new Error(`TCMB kurları alınamadı (${r.status})`);
      data = parseTcmb(str(r.body));
    } else {
      // weekends and holidays have no bulletin: use the last one published on or before the date
      const d0 = new Date(`${dateStr}T12:00:00Z`); if (isNaN(d0)) throw new Error(`Geçersiz tarih: ${dateStr} (YYYY-AA-GG yazın)`);
      for (let back = 0; back < 10 && !data; back++) {
        const d = new Date(d0 - back * 86400000); const p = n => String(n).padStart(2, '0');
        const y = d.getUTCFullYear(), m = p(d.getUTCMonth() + 1), day = p(d.getUTCDate());
        const r = await httpRequest({ url: `${base}/${y}${m}/${day}${m}${y}.xml`, signal: c.signal });
        if (r.ok) data = parseTcmb(str(r.body)); else if (r.status !== 404) throw new Error(`TCMB kurları alınamadı (${r.status})`);
      }
      if (!data) throw new Error(`${dateStr} ve önceki 10 gün için TCMB bülteni bulunamadı`);
    }
    tcmbCache.set(key, { at: Date.now(), data });
    return data;
  }
  const rateOf = (data, code, kind) => {
    code = String(code || '').trim().toUpperCase();
    if (code === 'TRY' || code === 'TL') return 1;
    const r = data.rates[code]; if (!r) throw new Error(`TCMB'de "${code}" kuru yok. Örnekler: USD, EUR, GBP, CHF, JPY, SAR`);
    const v = r[kind] ?? r.dovizSatis ?? r.dovizAlis; if (v == null) throw new Error(`${code} için ${kind} değeri yayımlanmamış`);
    return v / r.birim;
  };

  async function geocode(c, place) {
    const base = env('N8N8_GEO_API', 'https://geocoding-api.open-meteo.com');
    const r = await httpRequest({ url: `${base}/v1/search?name=${encodeURIComponent(place)}&count=1&language=tr&format=json`, signal: c.signal });
    if (!r.ok) throw new Error(`Konum aranamadı (${r.status})`);
    const g = r.body?.results?.[0]; if (!g) throw new Error(`"${place}" adlı yer bulunamadı`);
    return { lat: g.latitude, lon: g.longitude, ad: [g.name, g.admin1, g.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', ') };
  }

  const NODES = {
    exchangeRate: {
      label: 'Döviz kuru (TCMB)', cat: 'data', icon: 'coin', inputs: 1, outputs: ['main'],
      desc: 'Türkiye Cumhuriyet Merkez Bankası\'nın günlük kurlarını getirir ya da bir tutarı dövizler ve TL arasında çevirir. Geçmiş bir tarih verilirse o günün (tatilse önceki iş gününün) bülteni kullanılır. Anahtar gerekmez.',
      params: [
        { key: 'op', label: 'İşlem', type: 'select', def: 'convert', options: [['convert', 'Tutar çevir'], ['rates', 'Kurları getir']] },
        { key: 'amount', label: 'Tutar', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: 'convert' } },
        { key: 'from', label: 'Kaynak para birimi', type: 'expr', def: 'USD', showIf: { op: 'convert' }, help: 'USD, EUR, GBP… ya da TRY' },
        { key: 'to', label: 'Hedef para birimi', type: 'expr', def: 'TRY', showIf: { op: 'convert' } },
        { key: 'codes', label: 'Para birimleri (virgülle, boş = hepsi)', type: 'text', def: 'USD, EUR, GBP', showIf: { op: 'rates' } },
        { key: 'kind', label: 'Kur türü', type: 'select', def: 'dovizSatis', options: [['dovizSatis', 'Döviz satış'], ['dovizAlis', 'Döviz alış'], ['efektifSatis', 'Efektif satış'], ['efektifAlis', 'Efektif alış']] },
        { key: 'date', label: 'Tarih (boş = bugün)', type: 'expr', def: '', help: 'YYYY-AA-GG, örneğin {{ $json.faturaTarihi }}' },
        { key: 'decimals', label: 'Ondalık hane', type: 'number', def: 2, min: 0, showIf: { op: 'convert' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'cevrilen', showIf: { op: 'convert' } },
      ],
      sub: '{op}',
      async run(c) {
        const out = [];
        if (c.p.op === 'rates') {
          const data = await tcmb(c, str(c.R(c.p.date, items(c)[0], 0)).trim());
          const want = str(c.p.codes).split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
          for (const k of want.length ? want : Object.keys(data.rates)) { const r = data.rates[k]; if (!r) throw new Error(`TCMB'de "${k}" kuru yok`); out.push({ json: { ...r, tarih: data.tarih } }); }
          return [out];
        }
        const its = items(c);
        for (let i = 0; i < its.length; i++) {
          c.checkAbort(); const it = its[i]; const R = k => str(c.R(c.p[k], it, i)).trim();
          const raw = R('amount').replace(/\s/g, ''); const amount = Number(/,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''));
          if (!isFinite(amount)) throw new Error(`Tutar sayı değil: "${R('amount')}"`);
          const data = await tcmb(c, R('date'));
          const from = R('from').toUpperCase() || 'USD', to = R('to').toUpperCase() || 'TRY';
          const kur = rateOf(data, from, c.p.kind) / rateOf(data, to, c.p.kind);
          const dec = Number(c.p.decimals ?? 2); const value = Math.round(amount * kur * 10 ** dec) / 10 ** dec;
          const o = { ...it.json }; const f = str(c.p.output).trim() || 'cevrilen';
          o[f] = value; o[`${f}Kur`] = Math.round(kur * 1e6) / 1e6; o[`${f}Tarih`] = data.tarih; o[`${f}Birim`] = to;
          out.push({ json: o });
        }
        return [out];
      },
    },

    weather: {
      label: 'Hava durumu', cat: 'data', icon: 'sun', inputs: 1, outputs: ['main'],
      desc: 'Bir şehir ya da koordinat için şu anki hava durumunu ve günlük tahmini getirir (Open-Meteo, anahtar gerekmez). Yağmur uyarısı, sevkiyat planı, sabah bülteni gibi akışlar için.',
      params: [
        { key: 'place', label: 'Yer', type: 'expr', def: 'İstanbul', help: 'Şehir ya da ilçe adı. Koordinat için "41.01, 28.97" yazın.' },
        { key: 'days', label: 'Tahmin günü', type: 'number', def: 3, min: 1, max: 16 },
        { key: 'split', label: 'Her gün ayrı öğe olsun', type: 'toggle', def: false },
      ],
      sub: '{place}',
      async run(c) {
        const out = []; const its = items(c);
        for (let i = 0; i < its.length; i++) {
          c.checkAbort(); const place = str(c.R(c.p.place, its[i], i)).trim(); if (!place) throw new Error('Yer boş');
          const m = place.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
          const loc = m ? { lat: Number(m[1]), lon: Number(m[2]), ad: place } : await geocode(c, place);
          const days = Math.max(1, Math.min(16, Number(c.p.days) || 3));
          const base = env('N8N8_WEATHER_API', 'https://api.open-meteo.com');
          const q = `latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto&forecast_days=${days}&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset`;
          const r = await httpRequest({ url: `${base}/v1/forecast?${q}`, signal: c.signal });
          if (!r.ok) throw new Error(`Hava durumu alınamadı (${r.status}): ${str(r.body?.reason || r.body).slice(0, 200)}`);
          const cur = r.body.current || {}; const d = r.body.daily || {};
          const gunler = (d.time || []).map((t, k) => ({ tarih: t, durum: WMO[d.weather_code?.[k]] ?? '', enYuksek: d.temperature_2m_max?.[k], enDusuk: d.temperature_2m_min?.[k], yagis: d.precipitation_sum?.[k], yagisIhtimali: d.precipitation_probability_max?.[k], ruzgar: d.wind_speed_10m_max?.[k], gunDogumu: d.sunrise?.[k], gunBatimi: d.sunset?.[k] }));
          const simdi = { sicaklik: cur.temperature_2m, hissedilen: cur.apparent_temperature, nem: cur.relative_humidity_2m, yagis: cur.precipitation, ruzgar: cur.wind_speed_10m, durum: WMO[cur.weather_code] ?? '' };
          if (c.p.split) gunler.forEach(g => out.push({ json: { yer: loc.ad, ...g } }));
          else out.push({ json: { ...its[i].json, yer: loc.ad, enlem: loc.lat, boylam: loc.lon, simdi, gunler, ozet: gunler[0] ? `${loc.ad}: ${simdi.durum || gunler[0].durum}, ${Math.round(simdi.sicaklik ?? gunler[0].enYuksek)}°C. Bugün ${Math.round(gunler[0].enDusuk)}–${Math.round(gunler[0].enYuksek)}°C, yağış ihtimali %${gunler[0].yagisIhtimali ?? 0}.` : '' } });
        }
        return [out];
      },
    },

    qrcode: {
      label: 'QR kod oluştur', cat: 'data', icon: 'qr', inputs: 1, outputs: ['main'],
      desc: 'Bir metin ya da bağlantıdan QR kod resmi (PNG ya da SVG) üretir ve dosya klasörüne kaydeder. Fatura, bilet, masa menüsü, ödeme bağlantısı için. E-posta ve Telegram node\'larında ek olarak gönderilebilir.',
      params: [
        { key: 'text', label: 'İçerik', type: 'expr', def: '{{ $json.link }}', help: 'Bağlantı, metin, Wi-Fi için WIFI:T:WPA;S:ağ;P:şifre;;' },
        { key: 'format', label: 'Biçim', type: 'select', def: 'png', options: [['png', 'PNG resmi'], ['svg', 'SVG (vektör)']] },
        { key: 'level', label: 'Hata düzeltme', type: 'select', def: 'M', options: [['L', 'Düşük (%7, en küçük)'], ['M', 'Orta (%15)'], ['Q', 'Yüksek (%25)'], ['H', 'En yüksek (%30, logo/baskı için)']] },
        { key: 'scale', label: 'Modül boyutu (piksel)', type: 'number', def: 8, min: 1, max: 40 },
        { key: 'file', label: 'Dosya adı (boş = otomatik)', type: 'expr', def: '', help: 'Dosya klasörüne göre, örneğin qr/{{ $json.siparisNo }}.png' },
        { key: 'dataUrl', label: 'Ayrıca data: adresi ekle (HTML e-postaya gömmek için)', type: 'toggle', def: false },
      ],
      sub: '{format}',
      async run(c) {
        const Q = require('./qr'); const out = []; const its = items(c);
        for (let i = 0; i < its.length; i++) {
          c.checkAbort(); const it = its[i]; const text = str(c.R(c.p.text, it, i));
          if (!text) throw new Error('QR içeriği boş');
          const q = Q.encode(text, c.p.level); const fmt = c.p.format === 'svg' ? 'svg' : 'png';
          const data = fmt === 'svg' ? Buffer.from(Q.svg(q, { scale: Number(c.p.scale) || 8 })) : Q.png(q, { scale: Number(c.p.scale) || 8 });
          let rel = str(c.R(c.p.file, it, i)).trim();
          if (!rel) rel = `qr/${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}-${i}.${fmt}`;
          else if (!/\.(png|svg)$/i.test(rel)) rel += `.${fmt}`;
          const f = safeFile(rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data);
          const o = { ...it.json, qr: { dosya: path.relative(DIRS.files, f).split(path.sep).join('/'), surum: q.version, boyut: q.size, bayt: data.length } };
          if (c.p.dataUrl) o.qr.dataUrl = `data:${fmt === 'svg' ? 'image/svg+xml' : 'image/png'};base64,${data.toString('base64')}`;
          out.push({ json: o });
        }
        return [out];
      },
    },

    validate: {
      label: 'Doğrula (TCKN, VKN, IBAN…)', cat: 'logic', icon: 'shield', inputs: 1, outputs: ['geçerli', 'geçersiz'],
      desc: 'T.C. kimlik no, vergi no, IBAN, telefon, e-posta ya da kart numarasını kontrol hanesiyle doğrular, düzgün biçime çevirir ve öğeyi "Geçerli" ya da "Geçersiz" çıkışına gönderir. İnternete bağlanmaz.',
      params: [
        { key: 'kind', label: 'Tür', type: 'select', def: 'tckn', options: [['tckn', 'T.C. kimlik numarası'], ['vkn', 'Vergi kimlik numarası'], ['iban', 'IBAN'], ['phone', 'Telefon (Türkiye)'], ['email', 'E-posta adresi'], ['card', 'Kredi kartı (Luhn, numara maskelenir)']] },
        { key: 'value', label: 'Değer', type: 'expr', def: '{{ $json.tckn }}' },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'dogrulama' },
        { key: 'replace', label: 'Geçerliyse alanın yerine düzgün biçimi yaz', type: 'text', def: '', help: 'Alan adı, örneğin telefon. Boşsa yalnız sonuç alanı eklenir.' },
      ],
      sub: '{kind}',
      async run(c) {
        const fn = VALIDATORS[c.p.kind]; if (!fn) throw new Error(`Bilinmeyen tür: ${c.p.kind}`);
        const ok = [], bad = []; const f = str(c.p.output).trim() || 'dogrulama';
        c.items.forEach((it, i) => {
          const r = fn(c.R(c.p.value, it, i)); const o = { ...it.json };
          o[f] = { gecerli: r.ok, deger: r.value, ...(r.why ? { neden: r.why } : {}), ...Object.fromEntries(Object.entries(r).filter(([k]) => !['ok', 'value', 'why'].includes(k))) };
          if (r.ok && str(c.p.replace).trim()) o[str(c.p.replace).trim()] = r.value;
          (r.ok ? ok : bad).push({ json: o });
        });
        return [ok, bad];
      },
    },
  };
  return { NODES, VALIDATORS, parseTcmb };
};
