'use strict';
/* SSH komutu ve SFTP, OpenAI uyumlu dil modelleri, Microsoft Teams, Brevo, Todoist, Jotform ve Typeform tetikleyicileri, NocoDB.
   Merged into NODES by nodes.js. N8N8_<X>_API variables point the services at other base URLs (tests). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CREDENTIAL_TYPES = {
  sshServer: { label: 'SSH / SFTP sunucusu', fields: [
    { key: 'host', label: 'Sunucu' }, { key: 'port', label: 'Port', def: '22' }, { key: 'user', label: 'Kullanıcı adı', def: 'root' },
    { key: 'password', label: 'Şifre (anahtar kullanılıyorsa boş)', secret: true },
    { key: 'privateKey', label: 'Özel anahtar (isteğe bağlı)', secret: true, multiline: true, help: '-----BEGIN OPENSSH PRIVATE KEY----- ile başlayan metnin tamamını yapıştırın.' },
    { key: 'passphrase', label: 'Anahtar parolası (varsa)', secret: true },
    { key: 'fingerprint', label: 'Sunucu parmak izi (önerilir)', def: '', help: 'Boşsa her sunucuya güvenilir. "Bağlantıyı dene" parmak izini gösterir; buraya yapıştırırsanız başka bir sunucuya bağlanılması engellenir.' }] },
  openaiCompat: { label: 'OpenAI uyumlu model (OpenAI, Gemini, Groq, OpenRouter, Mistral, LM Studio…)', fields: [
    { key: 'baseUrl', label: 'API adresi', def: 'https://api.openai.com/v1', help: 'Gemini: https://generativelanguage.googleapis.com/v1beta/openai · Groq: https://api.groq.com/openai/v1 · OpenRouter: https://openrouter.ai/api/v1 · Mistral: https://api.mistral.ai/v1 · DeepSeek: https://api.deepseek.com/v1 · LM Studio: http://localhost:1234/v1' },
    { key: 'apiKey', label: 'API anahtarı (yerel sunucularda boş)', secret: true },
    { key: 'model', label: 'Varsayılan model', def: 'gpt-4o-mini' }] },
  teamsWebhook: { label: 'Microsoft Teams kanalı (webhook)', fields: [{ key: 'url', label: 'Webhook adresi', secret: true, help: 'Teams kanalı → … → Workflows → "Post to a channel when a webhook request is received" şablonu; verdiği adresi yapıştırın.' }] },
  brevoApi: { label: 'Brevo (Sendinblue)', fields: [{ key: 'apiKey', label: 'API anahtarı', secret: true, help: 'Brevo → SMTP & API → API Keys' }] },
  todoistApi: { label: 'Todoist', fields: [{ key: 'token', label: 'API anahtarı', secret: true, help: 'Todoist → Ayarlar → Entegrasyonlar → Geliştirici' }] },
  jotformApi: { label: 'Jotform', fields: [
    { key: 'apiKey', label: 'API anahtarı', secret: true, help: 'Jotform → Ayarlar → API → Create New Key' },
    { key: 'region', label: 'Bölge', def: 'api', options: [['api', 'Standart'], ['eu-api', 'Avrupa (EU)'], ['hipaa-api', 'HIPAA']] }] },
  typeformApi: { label: 'Typeform', fields: [{ key: 'token', label: 'Kişisel erişim anahtarı', secret: true, help: 'Typeform → Hesap → Your settings → Personal tokens (responses:read, forms:read)' }] },
  nocodbApi: { label: 'NocoDB', fields: [{ key: 'url', label: 'Adres', def: 'https://app.nocodb.com' }, { key: 'token', label: 'API anahtarı', secret: true, help: 'NocoDB → Hesap → Tokens' }] },
};

module.exports = function moreNodes(h) {
  const { httpRequest, safeFile, DIRS } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const R0 = (c, k) => str(c.R(c.p[k], items(c)[0], 0)).trim();
  const rel = f => path.relative(DIRS.files, f).split(path.sep).join('/');
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const newOnly = (c, list, idOf) => {
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };
  const errText = (r, ...paths) => { for (const p of paths) { let v = r.body; for (const k of p.split('.')) v = v?.[k]; if (v) return typeof v === 'string' ? v : JSON.stringify(v); } return typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body ?? '').slice(0, 200); };

  /* ---------- SSH / SFTP (ssh2) ---------- */
  const fpOf = key => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
  function sshConnect(d, signal) {
    const { Client } = require('ssh2');
    return new Promise((resolve, reject) => {
      const conn = new Client(); let fp = '';
      const want = String(d.fingerprint || '').trim().replace(/=+$/, '');
      const fail = e => { conn.end(); reject(e); };
      const onAbort = () => fail(new Error('Durduruldu')); signal?.addEventListener('abort', onAbort, { once: true });
      conn.on('ready', () => { signal?.removeEventListener('abort', onAbort); resolve({ conn, fp }); });
      conn.on('error', e => reject(new Error(e.level === 'client-authentication' ? 'SSH girişi başarısız: kullanıcı adı, şifre ya da anahtar yanlış' : e.message === 'Timed out while waiting for handshake' ? 'SSH sunucusu zamanında yanıt vermedi' : /host key|verification failed/i.test(e.message) ? `SSH sunucusunun parmak izi kayıtlı olanla aynı değil (gelen: ${fp}). Sunucu değiştiyse kimlik bilgisini güncelleyin.` : `SSH: ${e.code || e.message}`)));
      let pk = String(d.privateKey || '').trim(); if (pk && !pk.endsWith('\n')) pk += '\n';
      try {
        conn.connect({ host: String(d.host || '').trim(), port: Number(d.port) || 22, username: String(d.user || '').trim(), ...(d.password ? { password: d.password } : {}), ...(pk ? { privateKey: pk, ...(d.passphrase ? { passphrase: d.passphrase } : {}) } : {}), readyTimeout: 20000, keepaliveInterval: 15000,
          hostVerifier: key => { fp = fpOf(key); return !want || want === fp || want === fp.slice(7); } });
      } catch (e) { reject(new Error(/privateKey|parse/i.test(e.message) ? 'Özel anahtar okunamadı (biçim ya da parola yanlış)' : `SSH: ${e.message}`)); }
    });
  }
  const sftpOf = conn => new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(new Error(`SFTP açılamadı: ${e.message}`)) : res(s))));
  const P = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));
  const sftpErr = (e, p) => new Error(e.code === 2 ? `SFTP: "${p}" bulunamadı` : e.code === 3 ? `SFTP: "${p}" için izin yok` : `SFTP: ${e.message}`);
  function exec(conn, cmd, { timeout, input, signal }) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, st) => {
        if (err) return reject(new Error(`Komut başlatılamadı: ${err.message}`));
        const out = [], errs = []; let size = 0; const LIM = 5 * 1048576;
        const t = setTimeout(() => { st.close(); reject(new Error(`Komut ${timeout / 1000} saniyede bitmedi`)); }, timeout);
        signal?.addEventListener('abort', () => { st.close(); clearTimeout(t); reject(new Error('Durduruldu')); }, { once: true });
        st.on('data', b => { size += b.length; if (size <= LIM) out.push(b); });
        st.stderr.on('data', b => { if (errs.reduce((a, x) => a + x.length, 0) < LIM) errs.push(b); });
        st.on('close', (code, sig) => { clearTimeout(t); resolve({ cikti: Buffer.concat(out).toString('utf8').replace(/\n$/, ''), hata: Buffer.concat(errs).toString('utf8').replace(/\n$/, ''), kod: code ?? null, ...(sig ? { sinyal: sig } : {}), ...(size > LIM ? { kesildi: true } : {}) }); });
        if (input) st.end(input); else st.end();
      });
    });
  }

  /* ---------- OpenAI-compatible ---------- */
  async function oai(cr, p, body, signal) {
    const d = cr.data; const base = String(d.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    const r = await httpRequest({ method: body ? 'POST' : 'GET', url: base + p, headers: { 'Content-Type': 'application/json', ...(d.apiKey ? { Authorization: `Bearer ${String(d.apiKey).trim()}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 300000 });
    if (!r.ok) throw new Error(`Model (${r.status}): ${r.status === 401 ? 'API anahtarı geçersiz' : r.status === 404 ? `bulunamadı (${errText(r, 'error.message', 'message')})` : r.status === 429 ? 'istek sınırı ya da kota doldu' : errText(r, 'error.message', 'error', 'message')}`);
    return r.body;
  }

  /* ---------- Brevo / Todoist / Jotform / Typeform / NocoDB ---------- */
  async function brevo(cr, method, p, body, signal) {
    const r = await httpRequest({ method, url: `${env('N8N8_BREVO_API', 'https://api.brevo.com/v3')}${p}`, headers: { 'api-key': String(cr.data.apiKey || '').trim(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Brevo (${r.status}): ${r.status === 401 ? 'API anahtarı geçersiz' : errText(r, 'message', 'code')}`);
    return r.body;
  }
  async function todoist(cr, method, p, body, signal) {
    const r = await httpRequest({ method, url: `${env('N8N8_TODOIST_API', 'https://api.todoist.com/api/v1')}${p}`, headers: { Authorization: `Bearer ${String(cr.data.token || '').trim()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Todoist (${r.status}): ${r.status === 401 || r.status === 403 ? 'API anahtarı geçersiz' : r.status === 404 ? 'görev ya da proje bulunamadı' : errText(r, 'error')}`);
    return r.body;
  }
  async function jotform(cr, p, signal) {
    const region = ['api', 'eu-api', 'hipaa-api'].includes(cr.data.region) ? cr.data.region : 'api';
    const url = `${env('N8N8_JOTFORM_API', `https://${region}.jotform.com`)}${p}${p.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(String(cr.data.apiKey || '').trim())}`;
    const r = await httpRequest({ url, headers: { Accept: 'application/json' }, signal, timeout: 60000 });
    if (!r.ok || (r.body?.responseCode && r.body.responseCode !== 200)) throw new Error(`Jotform (${r.body?.responseCode || r.status}): ${r.status === 401 || r.body?.responseCode === 401 ? 'API anahtarı geçersiz (AB hesaplarında bölgeyi "Avrupa" seçin)' : errText(r, 'message')}`);
    return r.body.content;
  }
  const jfAnswers = a => {
    const o = {};
    for (const q of Object.values(a || {})) {
      if (!q || q.answer == null || q.answer === '') continue;
      const key = q.name || q.text; let v = q.answer;
      if (q.type === 'control_fullname' && typeof v === 'object') v = [v.first, v.last].filter(Boolean).join(' ');
      else if (q.type === 'control_phone' && typeof v === 'object') v = v.full || Object.values(v).join('');
      else if (q.type === 'control_address' && typeof v === 'object') v = Object.fromEntries(Object.entries(v).filter(([, x]) => x));
      o[key] = v;
    }
    return o;
  };
  async function typeform(cr, p, signal) {
    const r = await httpRequest({ url: `${env('N8N8_TYPEFORM_API', 'https://api.typeform.com')}${p}`, headers: { Authorization: `Bearer ${String(cr.data.token || '').trim()}` }, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`Typeform (${r.status}): ${r.status === 401 || r.status === 403 ? 'erişim anahtarı geçersiz ya da izni eksik' : r.status === 404 ? 'form bulunamadı' : errText(r, 'description', 'code')}`);
    return r.body;
  }
  const tfValue = a => a.type === 'choice' ? a.choice?.label ?? a.choice?.other : a.type === 'choices' ? [...(a.choices?.labels || []), ...(a.choices?.other ? [a.choices.other] : [])] : a.type === 'payment' ? a.payment : a[a.type];
  async function nocodb(cr, method, p, body, signal) {
    const r = await httpRequest({ method, url: `${String(cr.data.url || 'https://app.nocodb.com').trim().replace(/\/+$/, '')}${p}`, headers: { 'xc-token': String(cr.data.token || '').trim(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (!r.ok) throw new Error(`NocoDB (${r.status}): ${r.status === 401 ? 'API anahtarı geçersiz' : errText(r, 'msg', 'message', 'error')}`);
    return r.body;
  }
  const where = lines => String(lines || '').split('\n').map(x => x.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.+?)\s*(>=|<=|!=|=|>|<|~)\s*(.*)$/); if (!m) throw new Error(`Koşul anlaşılamadı: "${l}" (örnek: durum = yeni)`);
    const op = { '=': 'eq', '!=': 'neq', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte', '~': 'like' }[m[2]];
    return `(${m[1].trim()},${op},${op === 'like' ? `%${m[3]}%` : m[3]})`;
  }).join('~and');

  const NODES = {
    ssh: {
      label: 'SSH komutu', cat: 'action', icon: 'code', inputs: 1, outputs: ['main'],
      desc: 'Uzaktaki sunucunuzda SSH ile komut çalıştırır (yedek al, servisi yeniden başlat, disk durumuna bak). Çıktıyı, hata çıktısını ve çıkış kodunu verir.',
      params: [
        cred(['sshServer'], 'SSH sunucusu'),
        { key: 'command', label: 'Komut', type: 'code', def: 'df -h /', help: 'Dışarıdan gelen veriyi (form, webhook) komutun içine koymayın; sunucunuzda istenmeyen komut çalışabilir.' },
        { key: 'input', label: 'Komuta verilecek girdi (stdin, isteğe bağlı)', type: 'textarea', def: '' },
        { key: 'timeout', label: 'Zaman aşımı (saniye)', type: 'number', def: 60, min: 1 },
        { key: 'failOnCode', label: 'Çıkış kodu 0 değilse hata ver', type: 'toggle', def: true },
        { key: 'perItem', label: 'Her öğe için ayrı çalıştır', type: 'toggle', def: false },
      ],
      sub: '{command}',
      async run(c) {
        const { conn } = await sshConnect((await c.credential(c.p.credential)).data, c.signal);
        try {
          const its = c.p.perItem ? items(c) : [items(c)[0]]; const out = [];
          for (let i = 0; i < its.length; i++) {
            c.checkAbort(); const cmd = str(c.R(c.p.command, its[i], i)); if (!cmd.trim()) throw new Error('Komut boş');
            const r = await exec(conn, cmd, { timeout: Math.max(1, Number(c.p.timeout) || 60) * 1000, input: str(c.R(c.p.input, its[i], i)), signal: c.signal });
            if (c.p.failOnCode && r.kod !== 0) throw new Error(`Komut ${r.kod ?? r.sinyal} koduyla bitti: ${(r.hata || r.cikti).slice(0, 500)}`);
            out.push({ json: { ...(c.p.perItem ? its[i].json : {}), ...r } });
          }
          return [out];
        } finally { conn.end(); }
      },
    },
    sftp: {
      label: 'SFTP', cat: 'app', icon: 'folder', inputs: 1, outputs: ['main'],
      desc: 'SSH sunucusuna SFTP ile dosya yükler, indirir, klasörü listeler, siler, taşır ya da klasör oluşturur.',
      params: [
        cred(['sshServer'], 'SSH sunucusu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'upload', options: [['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['list', 'Klasörü listele'], ['delete', 'Dosya sil'], ['rename', 'Taşı / yeniden adlandır'], ['mkdir', 'Klasör oluştur']] },
        { key: 'remote', label: 'Sunucudaki yol', type: 'expr', def: '/home/kullanici/{{ $json.dosya }}', showIf: { op: ['upload', 'download', 'delete', 'rename', 'mkdir'] } },
        { key: 'dir', label: 'Klasör', type: 'expr', def: '/home/kullanici', showIf: { op: 'list' } },
        { key: 'file', label: 'Yüklenecek dosya (dosya klasöründe)', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload' } },
        { key: 'target', label: 'Kaydedilecek ad (boş = sftp/<ad>)', type: 'expr', def: '', showIf: { op: 'download' } },
        { key: 'to', label: 'Yeni yol', type: 'expr', def: '', showIf: { op: 'rename' } },
      ],
      sub: '{op}',
      async run(c) {
        const { conn } = await sshConnect((await c.credential(c.p.credential)).data, c.signal);
        try {
          const s = await sftpOf(conn);
          const entry = (dir, f) => ({ ad: f.filename, yol: path.posix.join(dir, f.filename), tur: (f.attrs.mode & 0o170000) === 0o040000 ? 'klasor' : (f.attrs.mode & 0o170000) === 0o120000 ? 'baglanti' : 'dosya', boyut: f.attrs.size, degisti: new Date(f.attrs.mtime * 1000).toISOString(), izin: (f.attrs.mode & 0o777).toString(8) });
          if (c.p.op === 'list') {
            const dir = R0(c, 'dir') || '.'; let list; try { list = await P(s.readdir.bind(s), dir); } catch (e) { throw sftpErr(e, dir); }
            return [list.filter(f => f.filename !== '.' && f.filename !== '..').sort((a, b) => a.filename.localeCompare(b.filename, 'tr')).map(f => ({ json: entry(dir, f) }))];
          }
          return await forItems(c, async (R, it, i) => {
            const rp = R('remote'); if (!rp) throw new Error(`${i + 1}. öğede sunucudaki yol boş`);
            try {
              if (c.p.op === 'upload') { const lf = safeFile(R('file')); if (!R('file') || !fs.existsSync(lf)) throw new Error(`${i + 1}. öğede dosya bulunamadı: ${R('file')}`); await P(s.fastPut.bind(s), lf, rp); return { ...it.json, sftp: { yuklendi: rp, boyut: fs.statSync(lf).size } }; }
              if (c.p.op === 'download') { const lf = safeFile(R('target') || `sftp/${path.posix.basename(rp)}`); fs.mkdirSync(path.dirname(lf), { recursive: true }); await P(s.fastGet.bind(s), rp, lf); return { ...it.json, dosya: rel(lf), boyut: fs.statSync(lf).size }; }
              if (c.p.op === 'delete') { await P(s.unlink.bind(s), rp); return { ...it.json, silindi: rp }; }
              if (c.p.op === 'rename') { const to = R('to'); if (!to) throw new Error('Yeni yol boş'); await P(s.rename.bind(s), rp, to); return { ...it.json, tasindi: to }; }
              await P(s.mkdir.bind(s), rp); return { ...it.json, olusturuldu: rp };
            } catch (e) { throw e.code != null && typeof e.code === 'number' ? sftpErr(e, rp) : e; }
          });
        } finally { conn.end(); }
      },
    },

    llm: {
      label: 'OpenAI uyumlu model', cat: 'ai', icon: 'robot', inputs: 1, outputs: ['main'],
      desc: 'OpenAI, Gemini, Groq, OpenRouter, Mistral, DeepSeek ya da bilgisayarınızdaki LM Studio gibi OpenAI uyumlu bir modele soru sorar, JSON cevap alır ya da metni vektöre (embedding) çevirir.',
      params: [
        cred(['openaiCompat'], 'Model sağlayıcısı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'chat', options: [['chat', 'Soru sor'], ['embed', 'Vektöre çevir (embedding)'], ['models', 'Modelleri listele']] },
        { key: 'model', label: 'Model (boş = kimlik bilgisindeki)', type: 'text', def: '', showIf: { op: ['chat', 'embed'] } },
        { key: 'system', label: 'Sistem talimatı', type: 'textarea', def: 'Kısa ve Türkçe cevap ver.', showIf: { op: 'chat' } },
        { key: 'prompt', label: 'Mesaj', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: ['chat', 'embed'] } },
        { key: 'json', label: 'Cevap JSON olsun', type: 'toggle', def: false, showIf: { op: 'chat' }, help: 'Talimatta istediğiniz alanları yazın. Cevap çözülüp nesne olarak verilir.' },
        { key: 'temperature', label: 'Yaratıcılık (0–2, boş = varsayılan)', type: 'text', def: '', showIf: { op: 'chat' } },
        { key: 'maxTokens', label: 'En fazla token (boş = varsayılan)', type: 'text', def: '', showIf: { op: 'chat' } },
        { key: 'output', label: 'Sonuç alanı', type: 'text', def: 'cevap', showIf: { op: ['chat', 'embed'] } },
      ],
      sub: '{op} {model}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        if (c.p.op === 'models') return [((await oai(cr, '/models', null, c.signal)).data || []).map(m => ({ json: { id: m.id, sahip: m.owned_by ?? null } }))];
        const model = str(c.p.model).trim() || str(cr.data.model).trim(); if (!model) throw new Error('Model adı girin');
        const f = str(c.p.output).trim() || 'cevap';
        return forItems(c, async (R, it) => {
          if (c.p.op === 'embed') { const r = await oai(cr, '/embeddings', { model, input: R('prompt') }, c.signal); return { ...it.json, [f]: r.data?.[0]?.embedding }; }
          const t = str(c.p.temperature).trim(), mt = str(c.p.maxTokens).trim();
          const r = await oai(cr, '/chat/completions', { model, messages: [...(R('system') ? [{ role: 'system', content: R('system') }] : []), { role: 'user', content: R('prompt') }], ...(t ? { temperature: Number(t.replace(',', '.')) } : {}), ...(mt ? { max_tokens: Number(mt) } : {}), ...(c.p.json ? { response_format: { type: 'json_object' } } : {}) }, c.signal);
          const msg = r.choices?.[0]?.message?.content ?? '';
          let v = msg; if (c.p.json) { try { v = JSON.parse(String(msg).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error(`Model geçerli JSON döndürmedi: ${String(msg).slice(0, 200)}`); } }
          return { ...it.json, [f]: v, model: r.model || model, token: { girdi: r.usage?.prompt_tokens ?? null, cikti: r.usage?.completion_tokens ?? null } };
        });
      },
    },

    teams: {
      label: 'Microsoft Teams', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'Microsoft Teams kanalına başlıklı, alanlı ve düğmeli kart olarak mesaj gönderir (Workflows webhook\'u).',
      params: [
        cred(['teamsWebhook'], 'Teams kanalı'),
        { key: 'title', label: 'Başlık', type: 'expr', def: 'Yeni sipariş' },
        { key: 'text', label: 'Mesaj', type: 'textarea', def: '{{ $json.musteri }} {{ $json.tutar }} TL tutarında sipariş verdi.' },
        { key: 'facts', label: 'Alanlar', type: 'kv', def: [] },
        { key: 'button', label: 'Düğme yazısı (isteğe bağlı)', type: 'expr', def: '' },
        { key: 'url', label: 'Düğme adresi', type: 'expr', def: '' },
        { key: 'color', label: 'Başlık rengi', type: 'select', def: 'default', options: [['default', 'Normal'], ['good', 'Yeşil'], ['warning', 'Turuncu'], ['attention', 'Kırmızı'], ['accent', 'Mavi']] },
      ],
      sub: '{title}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const url = String(cr.data.url || '').trim();
        if (!/^https?:\/\//.test(url)) throw new Error('Teams webhook adresi geçersiz');
        return forItems(c, async (R, it, i) => {
          const facts = (c.p.facts || []).filter(x => x.key).map(x => ({ title: x.key, value: str(c.R(x.value, it, i)) }));
          const body = [
            ...(R('title') ? [{ type: 'TextBlock', text: R('title'), weight: 'Bolder', size: 'Medium', wrap: true, ...(c.p.color && c.p.color !== 'default' ? { color: c.p.color } : {}) }] : []),
            ...(R('text') ? [{ type: 'TextBlock', text: R('text'), wrap: true }] : []),
            ...(facts.length ? [{ type: 'FactSet', facts }] : []),
          ];
          const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, ...(R('button') && /^https?:\/\//.test(R('url')) ? { actions: [{ type: 'Action.OpenUrl', title: R('button'), url: R('url') }] } : {}) };
          const r = await httpRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }), signal: c.signal, timeout: 30000 });
          if (!r.ok) throw new Error(`Teams (${r.status}): ${r.status === 404 ? 'webhook adresi bulunamadı ya da silinmiş' : errText(r, 'error.message', 'message')}`);
          return { ...it.json, teams: { gonderildi: true } };
        });
      },
    },

    brevo: {
      label: 'Brevo', cat: 'app', icon: 'mail', inputs: 1, outputs: ['main'],
      desc: 'Brevo (Sendinblue) ile işlem e-postası (ekli olabilir) ya da SMS gönderir, kişiyi ekler veya günceller, listeye ekler.',
      params: [
        cred(['brevoApi'], 'Brevo hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'email', options: [['email', 'E-posta gönder'], ['contact', 'Kişi ekle / güncelle'], ['sms', 'SMS gönder']] },
        { key: 'senderName', label: 'Gönderen adı', type: 'text', def: 'Dükkanım', showIf: { op: 'email' } },
        { key: 'senderEmail', label: 'Gönderen e-postası (Brevo\'da doğrulanmış)', type: 'text', def: '', showIf: { op: 'email' } },
        { key: 'to', label: 'Alıcı e-postası', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'email' } },
        { key: 'toName', label: 'Alıcı adı', type: 'expr', def: '{{ $json.ad }}', showIf: { op: 'email' } },
        { key: 'subject', label: 'Konu', type: 'expr', def: 'Siparişiniz alındı', showIf: { op: 'email' } },
        { key: 'html', label: 'İçerik (HTML ya da düz metin)', type: 'textarea', def: '<p>Merhaba {{ $json.ad }},</p><p>Siparişiniz hazırlanıyor.</p>', showIf: { op: 'email' } },
        { key: 'templateId', label: 'Brevo şablon numarası (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'email' }, help: 'Doluysa içerik yerine bu şablon gönderilir; öğenin alanları şablonda {{ params.alan }} olarak kullanılır.' },
        { key: 'attach', label: 'Ekler (dosya klasöründen, virgülle)', type: 'expr', def: '', showIf: { op: 'email' } },
        { key: 'email', label: 'E-posta', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'contact' } },
        { key: 'attributes', label: 'Özellikler (Brevo\'daki adlarıyla: AD, SOYAD, SMS…)', type: 'kv', def: [{ key: 'AD', value: '{{ $json.ad }}' }], showIf: { op: 'contact' } },
        { key: 'lists', label: 'Liste numaraları (virgülle)', type: 'text', def: '', showIf: { op: 'contact' } },
        { key: 'sender', label: 'Gönderen adı (en fazla 11 karakter)', type: 'text', def: 'DUKKAN', showIf: { op: 'sms' } },
        { key: 'phone', label: 'Telefon (+90…)', type: 'expr', def: '{{ $json.telefon }}', showIf: { op: 'sms' } },
        { key: 'message', label: 'Mesaj', type: 'textarea', def: '', showIf: { op: 'sms' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        return forItems(c, async (R, it, i) => {
          if (c.p.op === 'email') {
            const to = R('to'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`${i + 1}. öğede alıcı e-postası geçersiz: "${to}"`);
            if (!str(c.p.senderEmail).trim()) throw new Error('Gönderen e-postasını girin');
            const files = R('attach').split(',').map(x => x.trim()).filter(Boolean).map(n => { const f = safeFile(n); if (!fs.existsSync(f)) throw new Error(`Ek bulunamadı: ${n}`); return { name: path.basename(f), content: fs.readFileSync(f).toString('base64') }; });
            const tid = R('templateId');
            const html = R('html'); const isHtml = /<[a-z][\s\S]*>/i.test(html);
            const r = await brevo(cr, 'POST', '/smtp/email', { sender: { name: str(c.p.senderName).trim() || undefined, email: str(c.p.senderEmail).trim() }, to: [{ email: to, ...(R('toName') ? { name: R('toName') } : {}) }], ...(tid ? { templateId: Number(tid), params: it.json } : { subject: R('subject'), ...(isHtml ? { htmlContent: html } : { textContent: html }) }), ...(files.length ? { attachment: files } : {}) }, c.signal);
            return { ...it.json, brevo: { gonderildi: true, mesajId: r.messageId } };
          }
          if (c.p.op === 'contact') {
            const email = R('email'); if (!email) throw new Error(`${i + 1}. öğede e-posta boş`);
            const attributes = Object.fromEntries((c.p.attributes || []).filter(x => x.key).map(x => [x.key.trim().toUpperCase(), str(c.R(x.value, it, i))]).filter(([, v]) => v !== ''));
            const listIds = str(c.p.lists).split(',').map(x => Number(x.trim())).filter(Boolean);
            const r = await brevo(cr, 'POST', '/contacts', { email, attributes, ...(listIds.length ? { listIds } : {}), updateEnabled: true }, c.signal);
            return { ...it.json, brevo: { kisiId: r?.id ?? null, yeni: !!r?.id } };
          }
          let phone = R('phone').replace(/[\s()-]/g, ''); if (/^0\d{10}$/.test(phone)) phone = `90${phone.slice(1)}`; else if (/^5\d{9}$/.test(phone)) phone = `90${phone}`; phone = phone.replace(/^\+/, '');
          if (!/^\d{10,15}$/.test(phone)) throw new Error(`${i + 1}. öğede telefon numarası geçersiz: "${R('phone')}"`);
          const r = await brevo(cr, 'POST', '/transactionalSMS/sms', { sender: str(c.p.sender).trim().slice(0, 11) || 'SMS', recipient: phone, content: R('message'), type: 'transactional', unicodeEnabled: /[^\x00-\x7f]/.test(R('message')) }, c.signal);
          return { ...it.json, brevo: { gonderildi: true, mesajId: r.messageId, kredi: r.usedCredits ?? null } };
        });
      },
    },

    todoist: {
      label: 'Todoist', cat: 'app', icon: 'check', inputs: 1, outputs: ['main'],
      desc: 'Todoist\'e görev ekler ("yarın 10:00" gibi Türkçe tarihle), görevi tamamlar, yorum yazar ya da görevleri listeler.',
      params: [
        cred(['todoistApi'], 'Todoist hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'create', options: [['create', 'Görev ekle'], ['close', 'Görevi tamamla'], ['comment', 'Yorum yaz'], ['list', 'Görevleri listele']] },
        { key: 'content', label: 'Görev', type: 'expr', def: '{{ $json.konu }}', showIf: { op: 'create' } },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '', showIf: { op: 'create' } },
        { key: 'due', label: 'Ne zaman (ör. yarın 10:00, her pazartesi)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'priority', label: 'Öncelik', type: 'select', def: '1', options: [['4', 'P1 (acil)'], ['3', 'P2'], ['2', 'P3'], ['1', 'P4 (normal)']], showIf: { op: 'create' } },
        { key: 'labels', label: 'Etiketler (virgülle)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'project', label: 'Proje kimliği (boş = Gelen kutusu)', type: 'expr', def: '', showIf: { op: ['create', 'list'] } },
        { key: 'task', label: 'Görev kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['close', 'comment'] } },
        { key: 'text', label: 'Yorum', type: 'textarea', def: '', showIf: { op: 'comment' } },
        { key: 'filter', label: 'Süzgeç (ör. today | overdue, boş = hepsi)', type: 'expr', def: '', showIf: { op: 'list' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const task = t => ({ id: t.id, gorev: t.content, aciklama: t.description || '', tamamlandi: !!(t.checked ?? t.is_completed), oncelik: t.priority, tarih: t.due?.datetime || t.due?.date || null, tarihMetni: t.due?.string || null, etiketler: t.labels || [], projeId: t.project_id ?? null, adres: t.url || `https://app.todoist.com/app/task/${t.id}` });
        if (c.p.op === 'list') {
          const flt = R0(c, 'filter'); const out = []; let cursor = '';
          do {
            const qs = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}), ...(flt ? { query: flt, lang: 'tr' } : R0(c, 'project') ? { project_id: R0(c, 'project') } : {}) });
            const r = await todoist(cr, 'GET', `${flt ? '/tasks/filter' : '/tasks'}?${qs}`, null, c.signal);
            out.push(...(r.results || r || []).map(task)); cursor = r.next_cursor || '';
          } while (cursor && out.length < 5000);
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (R, it) => {
          if (c.p.op === 'create') {
            const labels = R('labels').split(',').map(x => x.trim()).filter(Boolean);
            const t = await todoist(cr, 'POST', '/tasks', { content: R('content') || '(adsız görev)', ...(R('description') ? { description: R('description') } : {}), ...(R('due') ? { due_string: R('due'), due_lang: 'tr' } : {}), priority: Number(c.p.priority) || 1, ...(labels.length ? { labels } : {}), ...(R('project') ? { project_id: R('project') } : {}) }, c.signal);
            return { ...it.json, ...task(t) };
          }
          const id = R('task'); if (!id) throw new Error('Görev kimliği boş');
          if (c.p.op === 'close') { await todoist(cr, 'POST', `/tasks/${encodeURIComponent(id)}/close`, null, c.signal); return { ...it.json, id, tamamlandi: true }; }
          const r = await todoist(cr, 'POST', '/comments', { task_id: id, content: R('text') }, c.signal); return { ...it.json, yorumId: r.id };
        });
      },
    },

    jotformTrigger: {
      label: 'Jotform gönderimi gelince', cat: 'trigger', icon: 'form', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Jotform formunu düzenli kontrol eder; her yeni gönderimde akışı çalıştırır. Cevaplar sorunun alan adıyla gelir.',
      params: pollParams(1, 'm', [cred(['jotformApi'], 'Jotform hesabı'), { key: 'form', label: 'Form kimliği ya da bağlantısı', type: 'text', def: '', help: 'form.jotform.com/251234567890 gibi bağlantıyı yapıştırabilirsiniz.' }]),
      async poll(c) {
        const id = (String(c.p.form || '').match(/(\d{10,})/) || [])[1]; if (!id) throw new Error('Jotform form kimliği anlaşılamadı');
        const list = await jotform(await c.credential(c.p.credential), `/form/${id}/submissions?limit=50&orderby=created_at`, c.signal);
        return newOnly(c, (list || []).filter(s => s.status !== 'DELETED'), s => s.id).map(s => ({ gonderimId: s.id, tarih: s.created_at, ip: s.ip, ...jfAnswers(s.answers) }));
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { gonderimId: '6012345678901234567', tarih: '2026-10-22 10:00:00', ad: 'Ayşe Yılmaz', eposta: 'ayse@ornek.com', telefon: '(532) 111-2233', mesaj: 'Teklif istiyorum' } }]]; },
      eachItem: true,
    },
    typeformTrigger: {
      label: 'Typeform cevabı gelince', cat: 'trigger', icon: 'form', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Typeform formunu düzenli kontrol eder; her yeni cevapta akışı çalıştırır. Cevaplar soru başlığıyla (ya da ref adıyla) gelir.',
      params: pollParams(1, 'm', [cred(['typeformApi'], 'Typeform hesabı'), { key: 'form', label: 'Form kimliği ya da bağlantısı', type: 'text', def: '', help: 'ornek.typeform.com/to/AbC123 bağlantısını yapıştırabilirsiniz.' }, { key: 'keys', label: 'Alan adları', type: 'select', def: 'title', options: [['title', 'Soru başlığı'], ['ref', 'Ref (Typeform\'da tanımlı kısa ad)']] }]),
      async poll(c) {
        const s = String(c.p.form || '').trim(); const id = (s.match(/\/to\/([A-Za-z0-9]+)/) || s.match(/\/forms\/([A-Za-z0-9]+)/) || [null, s])[1]; if (!/^[A-Za-z0-9]+$/.test(id || '')) throw new Error('Typeform form kimliği anlaşılamadı');
        const cr = await c.credential(c.p.credential);
        const r = await typeform(cr, `/forms/${id}/responses?page_size=50&completed=true`, c.signal);
        const fresh = newOnly(c, r.items || [], x => x.response_id || x.token);
        if (!fresh.length) return [];
        const form = await typeform(cr, `/forms/${id}`, c.signal);
        const flat = fs => fs.flatMap(f => [f, ...flat(f.properties?.fields || [])]);
        const names = new Map(flat(form.fields || []).map(f => [f.id, c.p.keys === 'ref' ? f.ref || f.title : String(f.title || f.ref).replace(/\{\{[^}]*\}\}/g, '').replace(/^[\s,.:;!?-]+/, '').trim()]));
        return fresh.map(x => ({ cevapId: x.response_id || x.token, tarih: x.submitted_at, ...Object.fromEntries((x.answers || []).map(a => [names.get(a.field.id) || a.field.ref || a.field.id, tfValue(a)])), ...(x.hidden && Object.keys(x.hidden).length ? { gizli: x.hidden } : {}), ...(x.calculated?.score != null ? { puan: x.calculated.score } : {}) }));
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: { cevapId: 'abc123', tarih: '2026-10-22T10:00:00Z', 'Adınız nedir?': 'Ayşe', 'E-posta adresiniz': 'ayse@ornek.com', 'Bizi nereden duydunuz?': 'Instagram' } }]]; },
      eachItem: true,
    },

    nocodb: {
      label: 'NocoDB', cat: 'app', icon: 'table', inputs: 1, outputs: ['main'],
      desc: 'NocoDB tablosunda kayıt arar, ekler, günceller ya da siler (kendi sunucunuzdaki ya da app.nocodb.com).',
      params: [
        cred(['nocodbApi'], 'NocoDB hesabı'),
        { key: 'table', label: 'Tablo kimliği', type: 'text', def: '', help: 'Tabloyu açıp ⋯ → "Copy table ID" ya da adres çubuğundaki m… ile başlayan kimlik.' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'list', options: [['list', 'Kayıtları ara'], ['create', 'Kayıt ekle'], ['update', 'Kayıt güncelle'], ['delete', 'Kayıt sil']] },
        { key: 'where', label: 'Koşullar (satır satır, boş = hepsi)', type: 'textarea', def: '', showIf: { op: 'list' }, help: 'durum = yeni · tutar > 100 · ad ~ ali (içerir)' },
        { key: 'sort', label: 'Sırala (alan, tersi için -alan)', type: 'text', def: '', showIf: { op: 'list' } },
        { key: 'limit', label: 'En fazla', type: 'number', def: 100, min: 1, showIf: { op: 'list' } },
        { key: 'id', label: 'Kayıt Id', type: 'expr', def: '{{ $json.Id }}', showIf: { op: ['update', 'delete'] } },
        { key: 'fields', label: 'Alanlar (boş = öğedeki bütün alanlar)', type: 'kv', def: [], showIf: { op: ['create', 'update'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const t = encodeURIComponent(str(c.p.table).trim()); if (!t) throw new Error('Tablo kimliğini girin');
        const base = `/api/v2/tables/${t}/records`;
        if (c.p.op === 'list') {
          const lim = Math.max(1, Number(c.p.limit) || 100); const w = where(c.R(c.p.where, items(c)[0], 0)); const out = [];
          for (let off = 0; out.length < lim;) {
            const qs = new URLSearchParams({ limit: String(Math.min(1000, lim - out.length)), offset: String(off), ...(w ? { where: w } : {}), ...(str(c.p.sort).trim() ? { sort: str(c.p.sort).trim() } : {}) });
            const r = await nocodb(cr, 'GET', `${base}?${qs}`, null, c.signal); out.push(...(r.list || [])); off += (r.list || []).length;
            if (r.pageInfo?.isLastPage !== false || !(r.list || []).length) break;
          }
          return [out.slice(0, lim).map(json => ({ json }))];
        }
        return forItems(c, async (R, it, i) => {
          const fields = (c.p.fields || []).filter(x => x.key).length ? Object.fromEntries(c.p.fields.filter(x => x.key).map(x => [x.key, c.R(x.value, it, i)])) : Object.fromEntries(Object.entries(it.json).filter(([k]) => k !== 'Id'));
          if (c.p.op === 'create') { const r = await nocodb(cr, 'POST', base, fields, c.signal); return { ...it.json, ...fields, Id: r.Id ?? r.id }; }
          const id = R('id'); if (!id) throw new Error(`${i + 1}. öğede kayıt Id boş`);
          if (c.p.op === 'update') { await nocodb(cr, 'PATCH', base, { ...fields, Id: Number(id) || id }, c.signal); return { ...it.json, ...fields, Id: Number(id) || id }; }
          await nocodb(cr, 'DELETE', base, { Id: Number(id) || id }, c.signal); return { ...it.json, silindi: Number(id) || id };
        });
      },
    },
  };

  async function test(type, d) {
    const cr = { data: d };
    if (type === 'sshServer') {
      const { conn, fp } = await sshConnect(d);
      try { const r = await exec(conn, 'uname -sn 2>/dev/null || ver', { timeout: 10000 }); return `Bağlanıldı: ${r.cikti.split('\n')[0] || 'sunucu'} · parmak izi ${fp}`; } finally { conn.end(); }
    }
    if (type === 'openaiCompat') { const r = await oai(cr, '/models', null); const ids = (r.data || []).map(m => m.id); return `Bağlanıldı; ${ids.length} model${d.model && ids.length && !ids.includes(d.model) ? ` (dikkat: "${d.model}" listede yok)` : ''}`; }
    if (type === 'brevoApi') { const r = await brevo(cr, 'GET', '/account', null); return `Bağlanıldı: ${r.companyName || r.email}`; }
    if (type === 'todoistApi') { const r = await todoist(cr, 'GET', '/projects?limit=200', null); return `Bağlanıldı; ${(r.results || r).length} proje`; }
    if (type === 'jotformApi') { const r = await jotform(cr, '/user'); return `Bağlanıldı: ${r.name || r.username} (${r.email})`; }
    if (type === 'typeformApi') { const r = await typeform(cr, '/me'); return `Bağlanıldı: ${r.alias || r.email}`; }
    if (type === 'nocodbApi') { const r = await nocodb(cr, 'GET', '/api/v2/meta/bases/', null); return `Bağlanıldı; ${(r.list || []).length} veritabanı (base)`; }
    if (type === 'teamsWebhook') return undefined;
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
