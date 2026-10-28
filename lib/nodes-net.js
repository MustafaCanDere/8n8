'use strict';
/* Storage, server and web nodes: S3 (and R2/MinIO), FTP, Redis, Komut çalıştır, Web sayfası oku, GraphQL,
   Anlık bildirim (ntfy / Pushover), iyzico and Türkiye iş günü / resmî tatiller. Merged into NODES by nodes.js.
   N8N8_PUSHOVER_API and N8N8_IYZICO_API point those services at other base URLs (tests). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CREDENTIAL_TYPES = {
  s3Api: { label: 'S3 depolama (AWS, R2, MinIO…)', fields: [
    { key: 'accessKey', label: 'Erişim anahtarı (Access key ID)' },
    { key: 'secretKey', label: 'Gizli anahtar (Secret access key)', secret: true },
    { key: 'region', label: 'Bölge', def: 'eu-central-1', help: 'Cloudflare R2 için auto' },
    { key: 'endpoint', label: 'Uç nokta (AWS dışı için)', def: '', help: 'Boş = Amazon S3. R2: https://<hesap>.r2.cloudflarestorage.com, MinIO: http://sunucu:9000' },
    { key: 'pathStyle', label: 'Adres biçimi', def: 'true', options: [['true', 'Yol (sunucu/kova/dosya), R2 ve MinIO için'], ['false', 'Alt alan adı (kova.sunucu/dosya)']] }] },
  ftpServer: { label: 'FTP sunucusu', fields: [
    { key: 'host', label: 'Sunucu' }, { key: 'port', label: 'Port', def: '21' },
    { key: 'user', label: 'Kullanıcı adı' }, { key: 'password', label: 'Şifre', secret: true },
    { key: 'secure', label: 'Şifreli bağlantı (FTPS)', def: 'false', options: [['false', 'Hayır (düz FTP)'], ['true', 'Evet (AUTH TLS)']] }] },
  redisServer: { label: 'Redis', fields: [
    { key: 'host', label: 'Sunucu', def: '127.0.0.1' }, { key: 'port', label: 'Port', def: '6379' },
    { key: 'user', label: 'Kullanıcı adı (isteğe bağlı, Redis 6+)' }, { key: 'password', label: 'Şifre', secret: true },
    { key: 'db', label: 'Veritabanı numarası', def: '0' },
    { key: 'secure', label: 'TLS', def: 'false', options: [['false', 'Hayır'], ['true', 'Evet (Upstash, bulut Redis)']] }] },
  pushoverApi: { label: 'Pushover', fields: [
    { key: 'token', label: 'Uygulama anahtarı (API token)', secret: true, help: 'pushover.net → Create an Application' },
    { key: 'user', label: 'Kullanıcı ya da grup anahtarı' }] },
  ntfyApi: { label: 'ntfy (kendi sunucu ya da korumalı konu)', fields: [
    { key: 'server', label: 'Sunucu', def: 'https://ntfy.sh' },
    { key: 'token', label: 'Erişim anahtarı (tk_…, isteğe bağlı)', secret: true }] },
  iyzicoApi: { label: 'iyzico', fields: [
    { key: 'apiKey', label: 'API anahtarı' }, { key: 'secretKey', label: 'Gizli anahtar', secret: true },
    { key: 'sandbox', label: 'Ortam', def: 'true', options: [['true', 'Deneme (sandbox)'], ['false', 'Canlı']], help: 'merchant.iyzipay.com → Ayarlar → Firma Ayarları\'ndan anahtarları alın. Denemek için sandbox-merchant.iyzipay.com.' }] },
};

/* ---------- Türkiye resmî tatilleri ---------- */
const FIXED = [['01-01', 'Yılbaşı'], ['04-23', 'Ulusal Egemenlik ve Çocuk Bayramı'], ['05-01', 'Emek ve Dayanışma Günü'], ['05-19', 'Atatürk\'ü Anma, Gençlik ve Spor Bayramı'], ['07-15', 'Demokrasi ve Millî Birlik Günü'], ['08-30', 'Zafer Bayramı'], ['10-29', 'Cumhuriyet Bayramı']];
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const holidayCache = new Map();
/* religious holidays follow the Umm al-Qura calendar, which matches Diyanet's dates for 2024-2026; later years can be a day off */
function holidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const list = FIXED.map(([md, ad]) => ({ tarih: `${year}-${md}`, ad, tur: 'tam' }));
  list.push({ tarih: `${year}-10-28`, ad: 'Cumhuriyet Bayramı arifesi', tur: 'yarim' });
  const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86400000) {
    const p = f.formatToParts(new Date(t)); const m = +p.find(x => x.type === 'month').value, d = +p.find(x => x.type === 'day').value;
    const s = ymd(new Date(t));
    if (m === 10 && d === 1) { list.push({ tarih: addDays(s, -1), ad: 'Ramazan Bayramı arifesi', tur: 'yarim' }); for (let k = 0; k < 3; k++) list.push({ tarih: addDays(s, k), ad: `Ramazan Bayramı ${k + 1}. gün`, tur: 'tam' }); }
    if (m === 12 && d === 10) { list.push({ tarih: addDays(s, -1), ad: 'Kurban Bayramı arifesi', tur: 'yarim' }); for (let k = 0; k < 4; k++) list.push({ tarih: addDays(s, k), ad: `Kurban Bayramı ${k + 1}. gün`, tur: 'tam' }); }
  }
  const out = list.filter(x => x.tarih.startsWith(String(year))).sort((a, b) => a.tarih.localeCompare(b.tarih));
  holidayCache.set(year, out); return out;
}

module.exports = function netNodes(h) {
  const { httpRequest, safeFile, DIRS } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rel = f => path.relative(DIRS.files, f).split(path.sep).join('/');
  const save = (relName, data) => { const f = safeFile(relName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };

  /* ---------- S3 ---------- */
  const S3 = require('./s3');
  async function s3(cr, method, bucket, key, { query = {}, body, headers = {}, signal } = {}) {
    const d = cr.data; const loc = S3.locate(d, bucket, key);
    const hd = S3.sign({ method, host: loc.host, path: loc.path, query, headers, body: body || '', accessKey: d.accessKey, secretKey: d.secretKey, region: d.region || 'us-east-1' });
    delete hd.host;
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000); signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      const r = await fetch(`${loc.protocol}//${loc.host}${S3.encPath(loc.path)}${qs}`, { method, headers: hd, body: body && body.length ? body : undefined, signal: ctrl.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) { const x = buf.toString('utf8'); const code = x.match(/<Code>([^<]+)/)?.[1]; const msg = x.match(/<Message>([^<]+)/)?.[1]; throw new Error(`S3 (${r.status}): ${code === 'SignatureDoesNotMatch' ? 'gizli anahtar hatalı' : code === 'NoSuchKey' ? `"${key}" dosyası yok` : code === 'NoSuchBucket' ? `"${bucket}" kovası yok` : [code, msg].filter(Boolean).join(' - ') || r.statusText}`); }
      return { buf, headers: Object.fromEntries(r.headers) };
    } catch (e) { if (e.name === 'AbortError') throw new Error('S3 isteği zaman aşımına uğradı ya da durduruldu'); if (/^S3 /.test(e.message)) throw e; throw new Error(`S3'e ulaşılamadı: ${e.cause?.message || e.message}`); }
    finally { clearTimeout(t); }
  }
  const xmlAll = (x, tag) => [...x.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
  const xmlOne = (x, tag) => (x.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];
  const unxml = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  /* ---------- FTP / Redis ---------- */
  const withFtp = async (c, fn) => { const cr = await c.credential(c.p.credential); const cl = await require('./ftp').connect(cr.data); try { return await fn(cl); } finally { await cl.close(); } };
  const withRedis = async (c, fn) => { const cr = await c.credential(c.p.credential); const cl = await require('./redis').connect(cr.data); try { return await fn(cl); } finally { await cl.close(); } };

  /* ---------- iyzico ---------- */
  async function iyzico(cr, method, uri, body, signal) {
    const base = env('N8N8_IYZICO_API', cr.data.sandbox === 'false' ? 'https://api.iyzipay.com' : 'https://sandbox-api.iyzipay.com');
    const rnd = `${Date.now()}${crypto.randomBytes(4).toString('hex')}`; const json = body ? JSON.stringify(body) : '';
    const sig = crypto.createHmac('sha256', cr.data.secretKey).update(rnd + uri.split('?')[0] + json).digest('hex');
    const auth = Buffer.from(`apiKey:${cr.data.apiKey}&randomKey:${rnd}&signature:${sig}`).toString('base64');
    const r = await httpRequest({ method, url: base + uri, headers: { Authorization: `IYZWSv2 ${auth}`, 'x-iyzi-rnd': rnd, 'Content-Type': 'application/json', Accept: 'application/json' }, body: json || undefined, signal, timeout: 60000 });
    if (r.body?.status !== 'success') throw new Error(`iyzico (${r.status}): ${r.body?.errorMessage || r.body?.errorCode || str(r.body).slice(0, 200)}`);
    return r.body;
  }
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const NODES = {
    s3: {
      label: 'S3 depolama', cat: 'app', icon: 'db', inputs: 1, outputs: ['main'],
      desc: 'Amazon S3 ya da uyumlu depolamaya (Cloudflare R2, MinIO, Wasabi, DigitalOcean Spaces) dosya yükler, indirir, listeler, siler ve süreli paylaşım bağlantısı üretir.',
      params: [
        cred(['s3Api'], 'Depolama hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upload', options: [['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['list', 'Dosyaları listele'], ['delete', 'Dosya sil'], ['link', 'Paylaşım bağlantısı oluştur']] },
        { key: 'bucket', label: 'Kova (bucket)', type: 'text', def: '' },
        { key: 'key', label: 'Depodaki dosya adı (anahtar)', type: 'expr', def: 'yedek/{{ $json.dosya }}', showIf: { op: ['upload', 'download', 'delete', 'link'] } },
        { key: 'source', label: 'Yüklenecek', type: 'select', def: 'file', options: [['file', 'Dosya klasöründeki dosya'], ['text', 'Yazdığım metin']], showIf: { op: 'upload' } },
        { key: 'file', label: 'Dosya', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload', source: 'file' } },
        { key: 'content', label: 'Metin', type: 'textarea', def: '{{ JSON.stringify($json) }}', showIf: { op: 'upload', source: 'text' } },
        { key: 'target', label: 'Kaydedilecek dosya (boş = aynı ad)', type: 'expr', def: '', showIf: { op: 'download' } },
        { key: 'prefix', label: 'Ön ek (klasör)', type: 'expr', def: '', showIf: { op: 'list' } },
        { key: 'max', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'list' } },
        { key: 'expires', label: 'Geçerlilik (saat)', type: 'number', def: 24, min: 1, max: 168, showIf: { op: 'link' } },
      ],
      sub: '{op} · {bucket}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const bucket = str(c.p.bucket).trim(); if (!bucket) throw new Error('Kova adı boş');
        if (c.p.op === 'list') {
          const out = []; let token = '';
          const max = Number(c.p.max) || 100; const prefix = str(c.R(c.p.prefix, items(c)[0], 0)).trim();
          do {
            const q = { 'list-type': '2', 'max-keys': String(Math.min(1000, max - out.length)), ...(prefix ? { prefix } : {}), ...(token ? { 'continuation-token': token } : {}) };
            const x = (await s3(cr, 'GET', bucket, '', { query: q, signal: c.signal })).buf.toString('utf8');
            for (const ct of xmlAll(x, 'Contents')) out.push({ json: { anahtar: unxml(xmlOne(ct, 'Key')), boyut: Number(xmlOne(ct, 'Size')), degisti: xmlOne(ct, 'LastModified'), etag: unxml(xmlOne(ct, 'ETag')).replace(/"/g, '') } });
            token = xmlOne(x, 'IsTruncated') === 'true' ? unxml(xmlOne(x, 'NextContinuationToken')) : '';
          } while (token && out.length < max);
          return [out];
        }
        return forItems(c, async (R, it, i) => {
          const key = R('key').replace(/^\/+/, ''); if (!key) throw new Error(`${i + 1}. öğede dosya adı boş`);
          if (c.p.op === 'upload') {
            let data, type = 'application/octet-stream';
            if (c.p.source === 'text') { data = Buffer.from(R('content')); type = 'text/plain; charset=utf-8'; }
            else { const f = safeFile(R('file')); if (!fs.existsSync(f)) throw new Error(`${i + 1}. öğede dosya bulunamadı: ${R('file')}`); data = fs.readFileSync(f); }
            const r = await s3(cr, 'PUT', bucket, key, { body: data, headers: { 'content-type': type }, signal: c.signal });
            return { ...it.json, s3: { kova: bucket, anahtar: key, boyut: data.length, etag: (r.headers.etag || '').replace(/"/g, '') } };
          }
          if (c.p.op === 'download') {
            const r = await s3(cr, 'GET', bucket, key, { signal: c.signal }); const f = save(R('target') || `s3/${bucket}/${key}`, r.buf);
            return { ...it.json, dosya: rel(f), boyut: r.buf.length, tur: r.headers['content-type'] || null };
          }
          if (c.p.op === 'delete') { await s3(cr, 'DELETE', bucket, key, { signal: c.signal }); return { ...it.json, silindi: key }; }
          const d = cr.data; const loc = S3.locate(d, bucket, key);
          return { ...it.json, baglanti: S3.presign({ ...loc, accessKey: d.accessKey, secretKey: d.secretKey, region: d.region || 'us-east-1', expires: (Number(c.p.expires) || 24) * 3600 }), gecerlilikSaat: Number(c.p.expires) || 24 };
        });
      },
    },

    ftp: {
      label: 'FTP', cat: 'app', icon: 'folder', inputs: 1, outputs: ['main'],
      desc: 'FTP ya da FTPS sunucusunda dosyaları listeler, yükler, indirir, taşır ve siler. Eski muhasebe programları, yazıcılar ve web barındırma için.',
      params: [
        cred(['ftpServer'], 'FTP sunucusu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upload', options: [['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['list', 'Klasörü listele'], ['rename', 'Taşı / yeniden adlandır'], ['delete', 'Dosya sil']] },
        { key: 'path', label: 'Sunucudaki yol', type: 'expr', def: '/gelen/{{ $json.ad }}', help: 'Listelemede klasör yolu.' },
        { key: 'file', label: 'Yüklenecek dosya (dosya klasöründe)', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload' } },
        { key: 'target', label: 'Kaydedilecek dosya (boş = aynı ad)', type: 'expr', def: '', showIf: { op: 'download' } },
        { key: 'to', label: 'Yeni yol', type: 'expr', def: '/arsiv/{{ $json.ad }}', showIf: { op: 'rename' } },
        { key: 'mkdirs', label: 'Klasörler yoksa oluştur', type: 'toggle', def: true, showIf: { op: 'upload' } },
      ],
      sub: '{op}',
      async run(c) {
        return withFtp(c, cl => forItems(c, async (R, it, i) => {
          const p = R('path');
          if (c.p.op === 'list') return (await cl.list(p || '.')).map(x => ({ ...x, yol: path.posix.join(p || '/', x.ad) }));
          if (!p) throw new Error(`${i + 1}. öğede sunucu yolu boş`);
          if (c.p.op === 'upload') {
            const f = safeFile(R('file')); if (!fs.existsSync(f)) throw new Error(`${i + 1}. öğede dosya bulunamadı: ${R('file')}`);
            if (c.p.mkdirs !== false && path.posix.dirname(p) !== '.') await cl.mkdirs(path.posix.dirname(p));
            const data = fs.readFileSync(f); await cl.upload(p, data); return { ...it.json, ftp: { yol: p, boyut: data.length } };
          }
          if (c.p.op === 'download') { const buf = await cl.download(p); const f = save(R('target') || `ftp/${path.posix.basename(p)}`, buf); return { ...it.json, dosya: rel(f), boyut: buf.length }; }
          if (c.p.op === 'rename') { await cl.rename(p, R('to')); return { ...it.json, eskiYol: p, yeniYol: R('to') }; }
          await cl.remove(p); return { ...it.json, silindi: p };
        }));
      },
    },

    redis: {
      label: 'Redis', cat: 'app', icon: 'db', inputs: 1, outputs: ['main'],
      desc: 'Redis\'te anahtar okur, yazar (süreli), siler, sayaç artırır, listeye ekler ya da listeden alır, kanala mesaj yayınlar ya da dilediğiniz komutu çalıştırır. Akışlar arası paylaşılan hafıza ve kuyruk için.',
      params: [
        cred(['redisServer'], 'Redis sunucusu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'get', options: [['get', 'Oku'], ['set', 'Yaz'], ['del', 'Sil'], ['incr', 'Sayacı artır'], ['push', 'Listeye ekle'], ['pop', 'Listeden al'], ['publish', 'Kanala yayınla'], ['command', 'Komut çalıştır']] },
        { key: 'key', label: 'Anahtar', type: 'expr', def: 'musteri:{{ $json.id }}', showIf: { op: ['get', 'set', 'del', 'incr', 'push', 'pop'] } },
        { key: 'value', label: 'Değer', type: 'expr', def: '{{ JSON.stringify($json) }}', showIf: { op: ['set', 'push', 'publish'] } },
        { key: 'ttl', label: 'Süre (saniye, 0 = süresiz)', type: 'number', def: 0, min: 0, showIf: { op: ['set', 'incr'] } },
        { key: 'by', label: 'Artış', type: 'number', def: 1, showIf: { op: 'incr' } },
        { key: 'end', label: 'Uç', type: 'select', def: 'right', options: [['right', 'Sondan (kuyruk)'], ['left', 'Baştan (yığın)']], showIf: { op: ['push', 'pop'] } },
        { key: 'channel', label: 'Kanal', type: 'expr', def: 'olaylar', showIf: { op: 'publish' } },
        { key: 'command', label: 'Komut', type: 'expr', def: 'HGETALL musteri:{{ $json.id }}', showIf: { op: 'command' }, help: 'Boşlukla ayrılır; boşluk içeren değeri "çift tırnak" içine alın.' },
        { key: 'parse', label: 'JSON değerleri çöz', type: 'toggle', def: true, showIf: { op: ['get', 'pop', 'command'] } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'deger' },
      ],
      sub: '{op}',
      async run(c) {
        const field = str(c.p.output).trim() || 'deger';
        const dec = v => { if (!c.p.parse || typeof v !== 'string') return v; try { return /^[[{"]|^-?\d|^(true|false|null)$/.test(v.trim()) ? JSON.parse(v) : v; } catch { return v; } };
        return withRedis(c, r => forItems(c, async (R, it) => {
          const key = R('key'); let v;
          if (c.p.op === 'get') v = dec(await r.call('GET', key));
          else if (c.p.op === 'set') v = await r.call('SET', key, R('value'), ...(Number(c.p.ttl) > 0 ? ['EX', Number(c.p.ttl)] : []));
          else if (c.p.op === 'del') v = await r.call('DEL', key);
          else if (c.p.op === 'incr') { v = await r.call('INCRBY', key, Math.trunc(Number(c.p.by ?? 1))); if (Number(c.p.ttl) > 0 && v === Math.trunc(Number(c.p.by ?? 1))) await r.call('EXPIRE', key, Number(c.p.ttl)); }
          else if (c.p.op === 'push') v = await r.call(c.p.end === 'left' ? 'LPUSH' : 'RPUSH', key, R('value'));
          else if (c.p.op === 'pop') v = dec(await r.call(c.p.end === 'left' ? 'LPOP' : 'RPOP', key));
          else if (c.p.op === 'publish') v = await r.call('PUBLISH', R('channel'), R('value'));
          else {
            const args = [...R('command').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => (m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]));
            if (!args.length) throw new Error('Komut boş');
            if (/^(FLUSHALL|FLUSHDB|SHUTDOWN|CONFIG|DEBUG|MONITOR|SUBSCRIBE|PSUBSCRIBE)$/i.test(args[0])) throw new Error(`${args[0].toUpperCase()} komutu bu node'dan çalıştırılamaz`);
            v = await r.call(...args);
            if (Array.isArray(v) && /^HGETALL$/i.test(args[0])) { const o = {}; for (let k = 0; k < v.length; k += 2) o[v[k]] = dec(v[k + 1]); v = o; } else v = Array.isArray(v) ? v.map(dec) : dec(v);
          }
          return { ...it.json, [field]: v };
        }));
      },
    },

    command: {
      label: 'Komut çalıştır', cat: 'code', icon: 'code', inputs: 1, outputs: ['main'],
      desc: 'Bilgisayarda bir komut ya da betik çalıştırır (yedek alma, dönüştürme, kendi programlarınız) ve çıktısını verir. Güvenlik için kapalıdır: açmak için programı N8N8_ALLOW_COMMANDS=1 ile başlatın.',
      params: [
        { key: 'command', label: 'Komut', type: 'textarea', def: 'echo "Merhaba {{ $json.ad }}"', help: 'Çalışma klasörü dosya klasörüdür (~/.8n8/dosyalar). İfadelerden gelen değerler komutun içine aynen yazılır; dışarıdan gelen veriyi komuta koyarken dikkatli olun.' },
        { key: 'once', label: 'Yalnızca bir kez çalıştır (her öğe için değil)', type: 'toggle', def: false },
        { key: 'timeout', label: 'Zaman aşımı (saniye)', type: 'number', def: 60, min: 1 },
        { key: 'failOnError', label: 'Çıkış kodu 0 değilse hata ver', type: 'toggle', def: true },
      ],
      sub: '{command}',
      async run(c) {
        if (!['1', 'true', 'evet'].includes(String(process.env.N8N8_ALLOW_COMMANDS || '').toLowerCase())) throw new Error('Komut çalıştırma kapalı. Açmak için programı N8N8_ALLOW_COMMANDS=1 ortam değişkeniyle başlatın (README → Ayarlar).');
        const { spawn } = require('child_process');
        fs.mkdirSync(DIRS.files, { recursive: true });
        const runOne = cmd => new Promise((res, rej) => {
          const p = spawn(cmd, { shell: true, cwd: DIRS.files, env: { ...process.env, N8N8_ENCRYPTION_KEY: '', N8N8_PASSWORD: '' }, windowsHide: true });
          let out = '', err = ''; const cap = 5 * 1024 * 1024;
          p.stdout.on('data', d => { if (out.length < cap) out += d; }); p.stderr.on('data', d => { if (err.length < cap) err += d; });
          const t = setTimeout(() => { p.kill('SIGKILL'); rej(new Error(`Komut ${c.p.timeout || 60} sn içinde bitmedi`)); }, (Number(c.p.timeout) || 60) * 1000);
          const ab = () => { p.kill('SIGKILL'); rej(new Error('Çalıştırma durduruldu')); }; c.signal?.addEventListener('abort', ab, { once: true });
          p.on('error', e => { clearTimeout(t); rej(e); });
          p.on('close', code => { clearTimeout(t); c.signal?.removeEventListener('abort', ab); res({ kod: code, cikti: out.replace(/\r?\n$/, ''), hata: err.replace(/\r?\n$/, '') }); });
        });
        const its = c.p.once ? [items(c)[0]] : items(c); const out = [];
        for (let i = 0; i < its.length; i++) {
          c.checkAbort(); const cmd = str(c.R(c.p.command, its[i], i)).trim(); if (!cmd) throw new Error('Komut boş');
          const r = await runOne(cmd);
          if (r.kod !== 0 && c.p.failOnError !== false) throw new Error(`Komut ${r.kod} koduyla bitti: ${(r.hata || r.cikti).slice(0, 300)}`);
          out.push({ json: c.p.once ? r : { ...its[i].json, ...r } });
        }
        return [out];
      },
    },

    webPage: {
      label: 'Web sayfası oku', cat: 'action', icon: 'globe', inputs: 1, outputs: ['main'],
      desc: 'Bir web sayfasını açar; başlığını, açıklamasını, okunabilir metnini ve bağlantılarını verir. Claude\'a özetletmek, fiyat izlemek ya da bilgi tabanına eklemek için.',
      params: [
        { key: 'url', label: 'Adres', type: 'expr', def: '{{ $json.link }}' },
        { key: 'maxChars', label: 'En fazla karakter (0 = sınırsız)', type: 'number', def: 20000, min: 0 },
        { key: 'links', label: 'Bağlantıları da ver', type: 'toggle', def: false },
        { key: 'contains', label: 'Şunu içeriyor mu? (isteğe bağlı)', type: 'expr', def: '', help: 'Yazılırsa sonuçta "iceriyor: true/false" olur; stok, fiyat ya da duyuru izlemek için.' },
      ],
      sub: '{url}',
      async run(c) {
        const { htmlToText } = require('./mime');
        return forItems(c, async (R, it, i) => {
          const url = R('url'); if (!/^https?:\/\//i.test(url)) throw new Error(`${i + 1}. öğede geçerli bir adres yok: "${url}"`);
          const r = await httpRequest({ url, headers: { 'User-Agent': 'Mozilla/5.0 (Auto-Move)', Accept: 'text/html,*/*' }, signal: c.signal, timeout: 45000 });
          if (!r.ok) throw new Error(`Sayfa açılamadı (${r.status}): ${url}`);
          const html = str(r.body);
          const meta = n => unxml((html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, 'i')) || [])[1] || '');
          const main = (html.match(/<(main|article)\b[\s\S]*?<\/\1>/i) || [html])[0].replace(/<(nav|header|footer|aside|form|noscript|svg)\b[\s\S]*?<\/\1>/gi, '');
          let metin = htmlToText(main.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))));
          const max = Number(c.p.maxChars ?? 20000); const kesildi = max > 0 && metin.length > max; if (kesildi) metin = metin.slice(0, max);
          const o = { ...it.json, adres: url, baslik: htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || meta('og:title')), aciklama: meta('description') || meta('og:description'), resim: meta('og:image') || null, metin, karakter: metin.length, kesildi };
          if (c.p.links) o.baglantilar = [...new Map([...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => { let u; try { u = new URL(unxml(m[1]), url).href; } catch { return null; } return [u, { adres: u, metin: htmlToText(m[2]).slice(0, 200) }]; }).filter(Boolean)).values()].slice(0, 500);
          if (R('contains')) o.iceriyor = metin.toLocaleLowerCase('tr').includes(R('contains').toLocaleLowerCase('tr'));
          return o;
        });
      },
    },

    graphql: {
      label: 'GraphQL', cat: 'action', icon: 'brackets', inputs: 1, outputs: ['main'],
      desc: 'Bir GraphQL API\'sine sorgu ya da değişiklik (mutation) gönderir. Shopify, GitHub, Monday, Linear gibi servisler için.',
      params: [
        { key: 'url', label: 'Adres', type: 'expr', def: 'https://api.ornek.com/graphql' },
        cred(['httpHeader', 'httpBearer', 'httpBasic'], 'Kimlik bilgisi (isteğe bağlı)'),
        { key: 'query', label: 'Sorgu', type: 'textarea', def: 'query ($id: ID!) {\n  user(id: $id) { id name }\n}' },
        { key: 'variables', label: 'Değişkenler (JSON)', type: 'textarea', def: '{ "id": "{{ $json.id }}" }' },
        { key: 'headers', label: 'Ek başlıklar', type: 'kv', def: [] },
        { key: 'split', label: 'Sonuçtaki listeyi öğelere ayır (yol)', type: 'text', def: '', help: 'Örnek: users.nodes. Boş = tek öğe.' },
      ],
      sub: '{url}',
      async run(c) {
        const cr = c.p.credential ? await c.credential(c.p.credential) : null; const out = [];
        for (let i = 0; i < items(c).length; i++) {
          c.checkAbort(); const it = items(c)[i]; const R = k => str(c.R(c.p[k], it, i));
          const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...Object.fromEntries((c.p.headers || []).filter(x => x.key).map(x => [x.key, str(c.R(x.value, it, i))])) };
          if (cr?.type === 'httpHeader') headers[cr.data.name] = cr.data.value;
          if (cr?.type === 'httpBearer') headers.Authorization = `Bearer ${cr.data.token}`;
          if (cr?.type === 'httpBasic') headers.Authorization = `Basic ${Buffer.from(`${cr.data.user}:${cr.data.password}`).toString('base64')}`;
          let variables = {}; const vs = R('variables').trim();
          if (vs) { try { variables = JSON.parse(vs); } catch (e) { throw new Error(`Değişkenler geçerli JSON değil: ${e.message}`); } }
          const r = await httpRequest({ method: 'POST', url: R('url').trim(), headers, body: JSON.stringify({ query: c.p.query, variables }), signal: c.signal, timeout: 60000 });
          if (r.body?.errors?.length && !r.body.data) throw new Error(`GraphQL: ${r.body.errors.map(e => e.message).join('; ')}`);
          if (!r.ok) throw new Error(`GraphQL (${r.status}): ${str(r.body).slice(0, 200)}`);
          let data = r.body?.data ?? r.body;
          const sp = str(c.p.split).trim();
          if (sp) { for (const k of sp.split('.')) data = data?.[k]; if (!Array.isArray(data)) throw new Error(`"${sp}" yolunda liste yok`); out.push(...data.map(json => ({ json }))); }
          else out.push({ json: { ...data, ...(r.body?.errors ? { uyarilar: r.body.errors.map(e => e.message) } : {}) } });
        }
        return [out];
      },
    },

    push: {
      label: 'Anlık bildirim', cat: 'app', icon: 'bolt', inputs: 1, outputs: ['main'],
      desc: 'Telefona anlık bildirim gönderir: ntfy (ücretsiz, hesap gerekmez; telefona ntfy uygulamasını kurup konuya abone olun) ya da Pushover.',
      params: [
        { key: 'service', label: 'Servis', type: 'select', def: 'ntfy', options: [['ntfy', 'ntfy'], ['pushover', 'Pushover']] },
        { key: 'topic', label: 'Konu (ntfy)', type: 'text', def: '', showIf: { service: 'ntfy' }, help: 'Tahmin edilmesi zor bir ad seçin; konuyu bilen herkes mesajları görebilir. Örnek: magazam-siparis-x7k2' },
        { key: 'ntfyCred', label: 'ntfy hesabı (isteğe bağlı)', type: 'credential', credTypes: ['ntfyApi'], def: '', showIf: { service: 'ntfy' } },
        { key: 'credential', label: 'Pushover hesabı', type: 'credential', credTypes: ['pushoverApi'], def: '', showIf: { service: 'pushover' } },
        { key: 'title', label: 'Başlık', type: 'expr', def: 'Yeni sipariş' },
        { key: 'message', label: 'Mesaj', type: 'textarea', def: '{{ $json.musteri }} - {{ $json.tutar }} TL' },
        { key: 'priority', label: 'Öncelik', type: 'select', def: '3', options: [['1', 'En düşük'], ['2', 'Düşük'], ['3', 'Normal'], ['4', 'Yüksek'], ['5', 'Acil']] },
        { key: 'url', label: 'Tıklanınca açılacak adres', type: 'expr', def: '' },
        { key: 'tags', label: 'Etiketler / emoji (ntfy, virgülle)', type: 'text', def: '', showIf: { service: 'ntfy' }, help: 'Örnek: warning, tada, package' },
      ],
      sub: '{service}',
      async run(c) {
        const pc = c.p.service === 'pushover' ? await c.credential(c.p.credential) : c.p.ntfyCred ? await c.credential(c.p.ntfyCred) : null;
        return forItems(c, async R => {
          if (c.p.service === 'pushover') {
            const pr = { 1: -2, 2: -1, 3: 0, 4: 1, 5: 1 }[c.p.priority] ?? 0;
            const r = await httpRequest({ method: 'POST', url: `${env('N8N8_PUSHOVER_API', 'https://api.pushover.net')}/1/messages.json`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: pc.data.token, user: pc.data.user, title: R('title'), message: R('message') || ' ', priority: String(pr), ...(R('url') ? { url: R('url') } : {}) }).toString(), signal: c.signal });
            if (r.body?.status !== 1) throw new Error(`Pushover (${r.status}): ${(r.body?.errors || []).join(', ') || str(r.body).slice(0, 200)}`);
            return { gonderildi: true, servis: 'pushover', istek: r.body.request };
          }
          const topic = str(c.p.topic).trim(); if (!/^[\w-]{1,64}$/.test(topic)) throw new Error('ntfy konusu harf, rakam, - ve _ içermeli (en fazla 64)');
          const server = (pc?.data.server || 'https://ntfy.sh').replace(/\/+$/, '');
          const body = { topic, title: R('title'), message: R('message'), priority: Number(c.p.priority) || 3, ...(R('url') ? { click: R('url') } : {}), ...(str(c.p.tags).trim() ? { tags: str(c.p.tags).split(',').map(s => s.trim()).filter(Boolean) } : {}) };
          const r = await httpRequest({ method: 'POST', url: server, headers: { 'Content-Type': 'application/json', ...(pc?.data.token ? { Authorization: `Bearer ${pc.data.token}` } : {}) }, body: JSON.stringify(body), signal: c.signal });
          if (!r.ok) throw new Error(`ntfy (${r.status}): ${r.body?.error || str(r.body).slice(0, 200)}`);
          return { gonderildi: true, servis: 'ntfy', id: r.body?.id };
        });
      },
    },

    iyzico: {
      label: 'iyzico', cat: 'app', icon: 'card', inputs: 1, outputs: ['main'],
      desc: 'iyzico ile ödeme bağlantısı (iyzilink) oluşturur, bağlantıları listeler ya da bir ödemenin durumunu sorgular.',
      params: [
        cred(['iyzicoApi'], 'iyzico hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'link', options: [['link', 'Ödeme bağlantısı oluştur'], ['links', 'Bağlantıları listele'], ['payment', 'Ödeme sorgula']] },
        { key: 'name', label: 'Ürün / hizmet adı', type: 'expr', def: 'Sipariş {{ $json.no }}', showIf: { op: 'link' } },
        { key: 'description', label: 'Açıklama', type: 'expr', def: '{{ $json.musteri }}', showIf: { op: 'link' } },
        { key: 'price', label: 'Tutar (TL)', type: 'expr', def: '{{ $json.tutar }}', showIf: { op: 'link' } },
        { key: 'image', label: 'Ürün resmi (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'link' }, help: 'Dosya klasöründeki PNG ya da JPEG' },
        { key: 'soldLimit', label: 'Satış sınırı (boş = sınırsız)', type: 'number', def: 1, min: 0, showIf: { op: 'link' } },
        { key: 'installment', label: 'Taksit seçeneği sun', type: 'toggle', def: false, showIf: { op: 'link' } },
        { key: 'paymentId', label: 'Ödeme numarası (paymentId)', type: 'expr', def: '{{ $json.paymentId }}', showIf: { op: 'payment' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'links') { const r = await iyzico(cr, 'GET', '/v2/iyzilink/products?page=1&count=100', null, c.signal); return [(r.data?.items || []).map(x => ({ json: { token: x.token, ad: x.name, tutar: Number(x.price), paraBirimi: x.currencyCode, adres: x.url, durum: x.productStatus, satilan: x.soldCount ?? null } }))]; }
        return forItems(c, async (R, it, i) => {
          if (c.p.op === 'payment') {
            const r = await iyzico(cr, 'POST', '/payment/detail', { locale: 'tr', conversationId: `8n8-${Date.now()}`, paymentId: R('paymentId') }, c.signal);
            return { ...it.json, odeme: { durum: r.paymentStatus, tutar: Number(r.paidPrice ?? r.price), taksit: r.installment, kart: r.lastFourDigits ? `**** ${r.lastFourDigits}` : null, kartAilesi: r.cardFamily || null } };
          }
          const t = R('price').replace(/\s|TL|₺/gi, ''); const price = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
          if (!(price > 0)) throw new Error(`${i + 1}. öğede tutar geçersiz: "${R('price')}"`);
          let img = PIXEL; if (R('image')) { const f = safeFile(R('image')); if (!fs.existsSync(f)) throw new Error(`Resim bulunamadı: ${R('image')}`); img = fs.readFileSync(f).toString('base64'); }
          const body = { locale: 'tr', conversationId: `8n8-${Date.now()}-${i}`, name: R('name').slice(0, 200) || 'Ödeme', description: R('description') || R('name') || 'Ödeme', base64EncodedImage: img, price: price.toFixed(2), currencyCode: 'TRY', addressIgnorable: true, ...(Number(c.p.soldLimit) > 0 ? { soldLimit: Number(c.p.soldLimit) } : {}), installmentRequested: !!c.p.installment };
          const r = await iyzico(cr, 'POST', '/v2/iyzilink/products', body, c.signal);
          return { ...it.json, odemeBaglantisi: r.data?.url, iyzicoToken: r.data?.token };
        });
      },
    },

    businessDay: {
      label: 'İş günü ve tatiller', cat: 'data', icon: 'calendar', inputs: 1, outputs: ['main'],
      desc: 'Türkiye resmî tatillerine (bayramlar dahil) ve hafta sonuna göre iş günü hesaplar: bir tarih iş günü mü, N iş günü sonrası hangi gün, iki tarih arası kaç iş günü, yılın tatilleri. Kargo, vade ve SLA hesapları için.',
      params: [
        { key: 'op', label: 'İşlem', type: 'select', def: 'add', options: [['add', 'İş günü ekle'], ['check', 'İş günü mü?'], ['between', 'İki tarih arası iş günü'], ['list', 'Yılın tatillerini listele']] },
        { key: 'date', label: 'Tarih', type: 'expr', def: '{{ $dt.format($now, "YYYY-MM-DD") }}', showIf: { op: ['add', 'check', 'between'] } },
        { key: 'days', label: 'Eklenecek iş günü', type: 'number', def: 3, showIf: { op: 'add' }, help: 'Eksi sayı geriye sayar.' },
        { key: 'date2', label: 'Bitiş tarihi', type: 'expr', def: '{{ $json.teslim }}', showIf: { op: 'between' } },
        { key: 'year', label: 'Yıl', type: 'expr', def: '{{ $dt.format($now, "YYYY") }}', showIf: { op: 'list' } },
        { key: 'saturday', label: 'Cumartesi iş günü', type: 'toggle', def: false, showIf: { op: ['add', 'check', 'between'] } },
        { key: 'halfDays', label: 'Arifeleri (yarım gün) tatil say', type: 'toggle', def: false, showIf: { op: ['add', 'check', 'between'] } },
        { key: 'extra', label: 'Ek tatil günleri (virgülle, YYYY-AA-GG)', type: 'text', def: '', help: 'Köprü izinleri ya da şirket tatilleri.' },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'isGunu', showIf: { op: ['add', 'check', 'between'] } },
      ],
      sub: '{op}',
      async run(c) {
        const extra = new Set(str(c.p.extra).split(/[,;\s]+/).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)));
        const info = s => { const y = Number(s.slice(0, 4)); const hs = holidays(y).filter(x => x.tarih === s); return hs; };
        const off = s => {
          const wd = new Date(`${s}T00:00:00Z`).getUTCDay();
          if (wd === 0 || (wd === 6 && !c.p.saturday)) return wd === 0 ? 'Pazar' : 'Cumartesi';
          if (extra.has(s)) return 'Ek tatil';
          const h = info(s).find(x => x.tur === 'tam' || c.p.halfDays); return h ? h.ad : null;
        };
        const norm = (v, i) => { const t = str(v).trim(); const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/) || t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); if (!m) { const d = new Date(t); if (isNaN(d)) throw new Error(`${i + 1}. öğede tarih okunamadı: "${t}"`); return ymd(new Date(d.getTime() - d.getTimezoneOffset() * 60000)); } return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; };
        if (c.p.op === 'list') {
          const y = Number(str(c.R(c.p.year, items(c)[0], 0)).trim()); if (!(y >= 1990 && y <= 2100)) throw new Error('Yıl geçersiz');
          return [holidays(y).map(x => ({ json: { ...x, gun: new Date(`${x.tarih}T00:00:00Z`).toLocaleDateString('tr-TR', { weekday: 'long', timeZone: 'UTC' }), tahmini: x.ad.includes('Bayramı') && !x.ad.startsWith('Cumhuriyet') && y > 2026 } }))];
        }
        const field = str(c.p.output).trim() || 'isGunu';
        return [items(c).map((it, i) => {
          const d = norm(c.R(c.p.date, it, i), i); const o = { ...it.json };
          if (c.p.op === 'check') { const why = off(d); o[field] = !why; o[`${field}Neden`] = why; o[`${field}Tatil`] = info(d).map(x => x.ad); }
          else if (c.p.op === 'add') {
            const n = Math.trunc(Number(c.p.days) || 0); const step = n < 0 ? -1 : 1; let cur = d;
            for (let k = 0, guard = 0; k < Math.abs(n) && guard < 4000; guard++) { cur = addDays(cur, step); if (!off(cur)) k++; }
            o[field] = cur;
          } else {
            const e = norm(c.R(c.p.date2, it, i), i); const [a, b, sgn] = d <= e ? [d, e, 1] : [e, d, -1]; let cnt = 0;
            for (let cur = addDays(a, 1), guard = 0; cur <= b && guard < 40000; cur = addDays(cur, 1), guard++) if (!off(cur)) cnt++;
            o[field] = cnt * sgn;
          }
          return { json: o };
        })];
      },
    },
  };

  async function test(type, d) {
    if (type === 's3Api') {
      const u = d.endpoint ? new URL(/^https?:\/\//.test(d.endpoint) ? d.endpoint : `https://${d.endpoint}`) : new URL('https://s3.amazonaws.com');
      const p = `${u.pathname.replace(/\/+$/, '')}/`;
      const hd = S3.sign({ method: 'GET', host: u.host, path: p, body: '', accessKey: d.accessKey, secretKey: d.secretKey, region: d.endpoint ? d.region || 'us-east-1' : 'us-east-1' }); delete hd.host;
      const r = await httpRequest({ url: `${u.protocol}//${u.host}${p}`, headers: hd, timeout: 15000 });
      if (!r.ok) throw new Error(`S3 (${r.status}): ${(str(r.body).match(/<Code>([^<]+)/) || [])[1] || 'giriş başarısız'}`);
      const names = xmlAll(str(r.body), 'Name').map(unxml); return `Bağlanıldı; kovalar: ${names.join(', ') || '(yok)'}`;
    }
    if (type === 'ftpServer') { const cl = await require('./ftp').connect(d, { timeout: 15000 }); try { const l = await cl.list('.'); return `Giriş yapıldı; ana klasörde ${l.length} öğe var`; } finally { await cl.close(); } }
    if (type === 'redisServer') { const cl = await require('./redis').connect(d); try { const p = await cl.call('PING'); const info = await cl.call('INFO', 'server').catch(() => ''); return `Bağlanıldı (${p}${/redis_version:([\d.]+)/.test(info) ? `, Redis ${info.match(/redis_version:([\d.]+)/)[1]}` : ''})`; } finally { await cl.close(); } }
    if (type === 'pushoverApi') {
      const r = await httpRequest({ method: 'POST', url: `${env('N8N8_PUSHOVER_API', 'https://api.pushover.net')}/1/users/validate.json`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: d.token, user: d.user }).toString(), timeout: 15000 });
      if (r.body?.status !== 1) throw new Error(`Pushover: ${(r.body?.errors || []).join(', ') || r.status}`); return `Geçerli; cihazlar: ${(r.body.devices || []).join(', ') || '-'}`;
    }
    if (type === 'iyzicoApi') { await iyzico({ data: d }, 'GET', '/v2/iyzilink/products?page=1&count=1', null); return `Bağlanıldı (${d.sandbox === 'false' ? 'canlı' : 'deneme'} ortamı)`; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test, holidays };
};
