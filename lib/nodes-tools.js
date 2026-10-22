'use strict';
/* Security and utility nodes: JWT, TOTP (iki adımlı doğrulama kodu), Ağ kontrolü (web sitesi / SSL / port / DNS) and
   Ollama (yerel yapay zekâ modelleri). Merged into NODES by nodes.js. */
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

const CREDENTIAL_TYPES = {
  jwtAuth: { label: 'JWT anahtarı', fields: [
    { key: 'algorithm', label: 'Algoritma', def: 'HS256', options: [['HS256', 'HS256 (ortak gizli anahtar)'], ['HS384', 'HS384'], ['HS512', 'HS512'], ['RS256', 'RS256 (RSA anahtar çifti)'], ['RS384', 'RS384'], ['RS512', 'RS512'], ['ES256', 'ES256 (EC P-256)'], ['ES384', 'ES384 (EC P-384)']] },
    { key: 'secret', label: 'Gizli anahtar (HS için)', secret: true },
    { key: 'privateKey', label: 'Özel anahtar PEM (RS / ES ile imzalamak için)', secret: true, multiline: true },
    { key: 'publicKey', label: 'Açık anahtar PEM (RS / ES ile doğrulamak için)', multiline: true }] },
  totpSecret: { label: 'İki adımlı doğrulama (TOTP) anahtarı', fields: [
    { key: 'secret', label: 'Gizli anahtar (Base32)', secret: true, help: 'Sitenin "kurulum anahtarı" ya da QR kodundaki secret değeri: JBSWY3DPEHPK3PXP gibi' },
    { key: 'digits', label: 'Hane', def: '6', options: [['6', '6'], ['8', '8']] },
    { key: 'period', label: 'Süre (saniye)', def: '30' },
    { key: 'algorithm', label: 'Algoritma', def: 'SHA1', options: [['SHA1', 'SHA1 (çoğu uygulama)'], ['SHA256', 'SHA256'], ['SHA512', 'SHA512']] }] },
  ollamaApi: { label: 'Ollama', fields: [
    { key: 'url', label: 'Adres', def: 'http://localhost:11434' },
    { key: 'apiKey', label: 'API anahtarı (yalnızca Ollama Cloud ya da korumalı sunucu için)', secret: true }] },
};

/* ---------- base32 / TOTP (RFC 4648, RFC 6238) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  const t = String(s || '').toUpperCase().replace(/[\s=-]/g, ''); if (!t || /[^A-Z2-7]/.test(t)) throw new Error('TOTP anahtarı Base32 değil (yalnızca A-Z ve 2-7)');
  let bits = 0, val = 0; const out = [];
  for (const ch of t) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function b32encode(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function hotp(key, counter, digits = 6, alg = 'sha1') {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(alg, key).update(c).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
const totp = (key, { time = Date.now(), period = 30, digits = 6, alg = 'sha1' } = {}) => hotp(key, Math.floor(time / 1000 / period), digits, alg);

/* ---------- JWT ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
const HASH = { 256: 'sha256', 384: 'sha384', 512: 'sha512' };
function jwtSign(payload, d) {
  const alg = d.algorithm || 'HS256'; const head = b64u(JSON.stringify({ alg, typ: 'JWT' })); const body = b64u(JSON.stringify(payload)); const data = `${head}.${body}`;
  const hash = HASH[alg.slice(2)];
  if (alg.startsWith('HS')) { if (!d.secret) throw new Error('JWT gizli anahtarı boş'); return `${data}.${b64u(crypto.createHmac(hash, d.secret).update(data).digest())}`; }
  if (!d.privateKey) throw new Error(`${alg} ile imzalamak için özel anahtar (PEM) gerekli`);
  const sig = crypto.sign(hash, Buffer.from(data), { key: d.privateKey, ...(alg.startsWith('ES') ? { dsaEncoding: 'ieee-p1363' } : {}) });
  return `${data}.${b64u(sig)}`;
}
function jwtDecode(token) {
  const parts = String(token || '').trim().replace(/^Bearer\s+/i, '').split('.'); if (parts.length !== 3) throw new Error('JWT üç parçalı olmalı (başlık.içerik.imza)');
  try { return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), payload: JSON.parse(Buffer.from(parts[1], 'base64url')), parts }; } catch { throw new Error('JWT çözülemedi: başlık ya da içerik geçerli JSON değil'); }
}
function jwtVerify(token, d, { leeway = 30 } = {}) {
  const { header, payload, parts } = jwtDecode(token); const alg = d.algorithm || 'HS256';
  if (header.alg !== alg) throw new Error(`Algoritma uyuşmuyor: belirteçte ${header.alg}, anahtarda ${alg}`);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`); const sig = Buffer.from(parts[2], 'base64url'); const hash = HASH[alg.slice(2)];
  let ok;
  if (alg.startsWith('HS')) { const exp = crypto.createHmac(hash, d.secret || '').update(data).digest(); ok = exp.length === sig.length && crypto.timingSafeEqual(exp, sig); }
  else { const key = d.publicKey || d.privateKey; if (!key) throw new Error(`${alg} doğrulaması için açık anahtar (PEM) gerekli`); ok = crypto.verify(hash, data, { key, ...(alg.startsWith('ES') ? { dsaEncoding: 'ieee-p1363' } : {}) }, sig); }
  if (!ok) throw new Error('İmza geçersiz');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp + leeway) throw new Error(`Süresi dolmuş (${new Date(payload.exp * 1000).toISOString()})`);
  if (typeof payload.nbf === 'number' && now + leeway < payload.nbf) throw new Error('Henüz geçerli değil (nbf)');
  return { header, payload };
}

/* ---------- network checks ---------- */
function certInfo(host, port = 443, timeout = 10000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout }, () => {
      const c = s.getPeerCertificate(); s.end();
      if (!c || !c.valid_to) return rej(new Error('Sunucu sertifika göndermedi'));
      const to = new Date(c.valid_to), from = new Date(c.valid_from);
      res({ gecerli: s.authorized, hata: s.authorized ? null : String(s.authorizationError), konu: c.subject?.CN || null, veren: c.issuer?.O || c.issuer?.CN || null, alanlar: String(c.subjectaltname || '').split(/,\s*/).filter(Boolean).map(x => x.replace(/^DNS:/, '')), baslangic: from.toISOString(), bitis: to.toISOString(), kalanGun: Math.floor((to - Date.now()) / 86400000), protokol: s.getProtocol(), sureMs: Date.now() - t0 });
    });
    s.on('timeout', () => { s.destroy(); rej(new Error(`${host}:${port} zamanında yanıt vermedi`)); });
    s.on('error', e => rej(new Error(`${host}:${port} SSL bağlantısı kurulamadı: ${e.code || e.message}`)));
  });
}
function portOpen(host, port, timeout = 5000) {
  return new Promise(res => {
    const t0 = Date.now(); const s = net.connect({ host, port });
    const done = (acik, hata) => { s.destroy(); res({ acik, sureMs: Date.now() - t0, ...(hata ? { hata } : {}) }); };
    s.setTimeout(timeout, () => done(false, 'zaman aşımı'));
    s.once('connect', () => done(true)); s.once('error', e => done(false, e.code || e.message));
  });
}

module.exports = function toolNodes(h) {
  const { httpRequest } = h;
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label, def = '') => ({ key: 'credential', label, type: 'credential', credTypes: types, def });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const field = (c, d) => str(c.p.output).trim() || d;

  async function ollama(cr, p, body, signal, timeout = 300000) {
    const d = cr?.data || {}; const base = (str(d.url).trim() || 'http://localhost:11434').replace(/\/+$/, '');
    let r;
    try { r = await httpRequest({ method: body ? 'POST' : 'GET', url: `${base}${p}`, headers: { 'Content-Type': 'application/json', ...(d.apiKey ? { Authorization: `Bearer ${d.apiKey}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout }); }
    catch (e) { throw new Error(/ECONNREFUSED/.test(e.message) ? `Ollama'ya ulaşılamadı (${base}). Ollama açık mı? ollama.com'dan kurup "ollama serve" ile başlatın.` : e.message); }
    if (!r.ok) { const m = r.body?.error || str(r.body).slice(0, 200); throw new Error(`Ollama (${r.status}): ${/not found/i.test(m) && body?.model ? `"${body.model}" modeli yüklü değil; önce "ollama pull ${body.model}" çalıştırın` : m}`); }
    return r.body;
  }

  const NODES = {
    jwt: {
      label: 'JWT', cat: 'data', icon: 'key', inputs: 1, outputs: ['main'],
      desc: 'JSON Web Token oluşturur (imzalar), doğrular ya da içini çözer. API girişleri ve webhook güvenliği için.',
      params: [
        { key: 'op', label: 'İşlem', type: 'select', def: 'sign', options: [['sign', 'Belirteç oluştur (imzala)'], ['verify', 'Belirteci doğrula'], ['decode', 'İçini çöz (doğrulamadan)']] },
        cred(['jwtAuth'], 'JWT anahtarı'),
        { key: 'payload', label: 'İçerik (JSON)', type: 'textarea', def: '{ "sub": "{{ $json.id }}", "ad": "{{ $json.ad }}" }', showIf: { op: 'sign' } },
        { key: 'expires', label: 'Geçerlilik süresi (dakika, 0 = süresiz)', type: 'number', def: 60, min: 0, showIf: { op: 'sign' } },
        { key: 'token', label: 'Belirteç', type: 'expr', def: '{{ $json.headers.authorization }}', showIf: { op: ['verify', 'decode'] }, help: 'Başındaki "Bearer " kendiliğinden atılır.' },
        { key: 'failInvalid', label: 'Geçersizse hata ver', type: 'toggle', def: false, showIf: { op: 'verify' }, help: 'Kapalıysa öğe gecerli: false ve hata alanıyla devam eder.' },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'jwt' },
      ],
      sub: '{op}',
      async run(c) {
        const cr = c.p.op === 'decode' ? null : await c.credential(c.p.credential); const f = field(c, 'jwt');
        return forItems(c, async (R, it) => {
          if (c.p.op === 'sign') {
            let p; try { p = JSON.parse(R('payload') || '{}'); } catch (e) { throw new Error(`İçerik geçerli JSON değil: ${e.message}`); }
            const now = Math.floor(Date.now() / 1000); p.iat ??= now; if (Number(c.p.expires) > 0) p.exp ??= now + Math.round(Number(c.p.expires) * 60);
            return { ...it.json, [f]: jwtSign(p, cr.data) };
          }
          if (c.p.op === 'decode') { const { header, payload } = jwtDecode(R('token')); return { ...it.json, [f]: { baslik: header, icerik: payload } }; }
          try { const { payload } = jwtVerify(R('token'), cr.data); return { ...it.json, [f]: { gecerli: true, icerik: payload } }; }
          catch (e) { if (c.p.failInvalid) throw new Error(`JWT geçersiz: ${e.message}`); return { ...it.json, [f]: { gecerli: false, hata: e.message } }; }
        });
      },
    },

    totp: {
      label: 'İki adımlı kod (TOTP)', cat: 'data', icon: 'shield', inputs: 1, outputs: ['main'],
      desc: 'Google Authenticator uyumlu 6 haneli doğrulama kodu üretir ya da kullanıcının yazdığı kodu doğrular; yeni gizli anahtar ve QR adresi de oluşturur.',
      params: [
        { key: 'op', label: 'İşlem', type: 'select', def: 'generate', options: [['generate', 'Kod üret'], ['verify', 'Kodu doğrula'], ['newSecret', 'Yeni gizli anahtar oluştur']] },
        { ...cred(['totpSecret'], 'TOTP anahtarı'), showIf: { op: ['generate', 'verify'] } },
        { key: 'code', label: 'Doğrulanacak kod', type: 'expr', def: '{{ $json.kod }}', showIf: { op: 'verify' } },
        { key: 'secretField', label: 'Gizli anahtar (kimlik bilgisi yerine, isteğe bağlı)', type: 'expr', def: '', showIf: { op: ['generate', 'verify'] }, help: 'Her kullanıcının kendi anahtarı varsa: {{ $json.totpAnahtari }}' },
        { key: 'account', label: 'Hesap adı', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'newSecret' } },
        { key: 'issuer', label: 'Uygulama adı', type: 'expr', def: '8n8', showIf: { op: 'newSecret' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'totp' },
      ],
      sub: '{op}',
      async run(c) {
        const f = field(c, 'totp');
        const credData = ['generate', 'verify'].includes(c.p.op) && c.p.credential ? (await c.credential(c.p.credential)).data : {};
        return forItems(c, async (R, it) => {
          if (c.p.op === 'newSecret') {
            const secret = b32encode(crypto.randomBytes(20)); const issuer = R('issuer') || '8n8'; const account = R('account') || 'kullanici';
            return { ...it.json, [f]: { anahtar: secret, adres: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` } };
          }
          const secret = R('secretField') || credData.secret; if (!secret) throw new Error('TOTP anahtarı yok: kimlik bilgisi seçin ya da gizli anahtar alanını doldurun');
          const o = { period: Math.max(1, Number(credData.period) || 30), digits: Number(credData.digits) === 8 ? 8 : 6, alg: String(credData.algorithm || 'SHA1').toLowerCase() };
          const key = b32decode(secret);
          if (c.p.op === 'generate') { const now = Date.now(); return { ...it.json, [f]: { kod: totp(key, { ...o, time: now }), kalanSaniye: o.period - Math.floor(now / 1000) % o.period } }; }
          const code = R('code').replace(/\s/g, ''); const now = Date.now();
          const ok = /^\d+$/.test(code) && code.length === o.digits && [-1, 0, 1].some(w => { const exp = totp(key, { ...o, time: now + w * o.period * 1000 }); return crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(code)); });
          return { ...it.json, [f]: { gecerli: ok } };
        });
      },
    },

    netCheck: {
      label: 'Ağ kontrolü', cat: 'action', icon: 'globe', inputs: 1, outputs: ['main'],
      desc: 'Web sitesinin açık olup olmadığını ve yanıt süresini, SSL sertifikasının bitiş tarihini, bir portun açık olup olmadığını ya da DNS kayıtlarını kontrol eder. Site izleme akışları için.',
      params: [
        { key: 'op', label: 'Kontrol', type: 'select', def: 'http', options: [['http', 'Web sitesi açık mı?'], ['ssl', 'SSL sertifikası'], ['port', 'Port açık mı?'], ['dns', 'DNS kayıtları']] },
        { key: 'url', label: 'Adres', type: 'expr', def: 'https://ornek.com', showIf: { op: 'http' } },
        { key: 'expect', label: 'Sayfada geçmesi gereken metin (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'http' } },
        { key: 'host', label: 'Sunucu', type: 'expr', def: 'ornek.com', showIf: { op: ['ssl', 'port', 'dns'] } },
        { key: 'port', label: 'Port', type: 'expr', def: '443', showIf: { op: ['ssl', 'port'] } },
        { key: 'recordType', label: 'Kayıt türü', type: 'select', def: 'A', options: [['A', 'A (IPv4)'], ['AAAA', 'AAAA (IPv6)'], ['MX', 'MX (e-posta)'], ['TXT', 'TXT (SPF, doğrulama)'], ['NS', 'NS (ad sunucuları)'], ['CNAME', 'CNAME']], showIf: { op: 'dns' } },
        { key: 'timeout', label: 'Zaman aşımı (saniye)', type: 'number', def: 10, min: 1 },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'kontrol' },
      ],
      sub: '{op}',
      async run(c) {
        const f = field(c, 'kontrol'); const ms = Math.max(1, Number(c.p.timeout) || 10) * 1000;
        return forItems(c, async (R, it) => {
          let r;
          if (c.p.op === 'http') {
            const url = R('url'); if (!/^https?:\/\//i.test(url)) throw new Error(`Adres http:// ya da https:// ile başlamalı: "${url}"`);
            const t0 = Date.now();
            try {
              const x = await httpRequest({ url, timeout: ms, signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (8n8 site kontrolü)' } });
              const exp = R('expect'); const text = typeof x.body === 'string' ? x.body : JSON.stringify(x.body);
              r = { acik: x.ok && (!exp || text.includes(exp)), durumKodu: x.status, sureMs: Date.now() - t0, ...(exp ? { metinVar: text.includes(exp) } : {}) };
            } catch (e) { r = { acik: false, durumKodu: null, sureMs: Date.now() - t0, hata: e.message.replace(/^İstek gönderilemedi: /, '') }; }
          } else if (c.p.op === 'ssl') {
            try { r = await certInfo(R('host').replace(/^https?:\/\//, '').replace(/\/.*$/, ''), Number(R('port')) || 443, ms); } catch (e) { r = { gecerli: false, hata: e.message }; }
          } else if (c.p.op === 'port') {
            const port = Number(R('port')); if (!(port > 0 && port < 65536)) throw new Error(`Port 1-65535 arası olmalı: "${R('port')}"`);
            r = await portOpen(R('host'), port, ms);
          } else {
            const host = R('host').replace(/^https?:\/\//, '').replace(/\/.*$/, ''); const t = c.p.recordType;
            try {
              const v = await dns.resolve(host, t);
              r = { kayitlar: t === 'MX' ? v.sort((a, b) => a.priority - b.priority).map(x => ({ sunucu: x.exchange, oncelik: x.priority })) : t === 'TXT' ? v.map(x => x.join('')) : v };
            } catch (e) { r = { kayitlar: [], hata: e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? 'kayıt yok' : e.code || e.message }; }
          }
          return { ...it.json, [f]: r };
        });
      },
    },

    ollama: {
      label: 'Ollama (yerel yapay zekâ)', cat: 'ai', icon: 'robot', inputs: 1, outputs: ['main'],
      desc: 'Bilgisayarınızda çalışan Ollama modellerine (Llama, Qwen, Gemma, Mistral…) soru sorar ya da metni sayılara (embedding) çevirir. Veriler bilgisayardan çıkmaz.',
      params: [
        cred(['ollamaApi'], 'Ollama sunucusu (boş = bu bilgisayar)'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'chat', options: [['chat', 'Soru sor / metin üret'], ['embed', 'Metni sayılara çevir (embedding)'], ['models', 'Yüklü modelleri listele']] },
        { key: 'model', label: 'Model', type: 'expr', def: 'llama3.2', showIf: { op: ['chat', 'embed'] }, help: 'Önce terminalde: ollama pull llama3.2' },
        { key: 'system', label: 'Sistem talimatı', type: 'textarea', def: 'Kısa ve Türkçe cevap ver.', showIf: { op: 'chat' } },
        { key: 'prompt', label: 'Mesaj', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: ['chat', 'embed'] } },
        { key: 'json', label: 'Cevabı JSON olarak iste', type: 'toggle', def: false, showIf: { op: 'chat' } },
        { key: 'temperature', label: 'Yaratıcılık (0-1)', type: 'number', def: 0.7, min: 0, showIf: { op: 'chat' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'cevap', showIf: { op: ['chat', 'embed'] } },
      ],
      sub: '{model}',
      async run(c) {
        const cr = c.p.credential ? await c.credential(c.p.credential) : null;
        if (c.p.op === 'models') return [((await ollama(cr, '/api/tags', null, c.signal, 30000)).models || []).map(m => ({ json: { ad: m.name, boyutMB: Math.round((m.size || 0) / 1048576), degisti: m.modified_at, aile: m.details?.family, parametre: m.details?.parameter_size } }))];
        const f = field(c, 'cevap');
        return forItems(c, async (R, it) => {
          const model = R('model'); if (!model) throw new Error('Model adı boş');
          if (c.p.op === 'embed') { const r = await ollama(cr, '/api/embed', { model, input: R('prompt') }, c.signal); return { ...it.json, [f]: r.embeddings?.[0] || [] }; }
          const messages = [...(R('system') ? [{ role: 'system', content: R('system') }] : []), { role: 'user', content: R('prompt') }];
          const r = await ollama(cr, '/api/chat', { model, messages, stream: false, ...(c.p.json ? { format: 'json' } : {}), options: { temperature: Math.min(2, Math.max(0, Number(c.p.temperature ?? 0.7))) } }, c.signal);
          let out = r.message?.content ?? '';
          if (c.p.json) { try { out = JSON.parse(out); } catch { throw new Error(`Model geçerli JSON döndürmedi: ${String(out).slice(0, 120)}`); } }
          return { ...it.json, [f]: out, ollama: { model: r.model, sureMs: r.total_duration ? Math.round(r.total_duration / 1e6) : null, girdiToken: r.prompt_eval_count ?? null, ciktiToken: r.eval_count ?? null } };
        });
      },
    },
  };

  async function test(type, d) {
    if (type === 'ollamaApi') { const r = await ollama({ data: d }, '/api/tags', null, null, 15000); const n = (r.models || []).map(m => m.name); return `Bağlanıldı; modeller: ${n.join(', ') || '(yok, "ollama pull llama3.2" ile indirin)'}`; }
    if (type === 'jwtAuth') {
      if (String(d.algorithm || 'HS256').startsWith('HS') || d.privateKey) { const t = jwtSign({ test: 1 }, d); jwtVerify(t, d); return `${d.algorithm || 'HS256'} anahtarı ile imzalandı ve doğrulandı`; }
      crypto.createPublicKey(d.publicKey); return 'Açık anahtar okundu (yalnızca doğrulama yapılabilir)';
    }
    if (type === 'totpSecret') { const k = b32decode(d.secret); return `Anahtar geçerli; şu anki kod ${totp(k, { period: Number(d.period) || 30, digits: Number(d.digits) === 8 ? 8 : 6, alg: String(d.algorithm || 'SHA1').toLowerCase() })}`; }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test, totp, hotp, b32decode, b32encode, jwtSign, jwtVerify };
};
