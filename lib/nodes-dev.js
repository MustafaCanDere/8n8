'use strict';
/* GitHub, Airtable and Discord (bot) nodes. Merged into NODES by nodes.js.
   N8N8_GITHUB_API, N8N8_AIRTABLE_API and N8N8_DISCORD_API point the nodes at another base URL (tests). */

const CREDENTIAL_TYPES = {
  githubApi: { label: 'GitHub', fields: [{ key: 'token', label: 'Erişim anahtarı (personal access token)', secret: true, help: 'github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Kullanacağınız depoları seçin; Issues, Contents ve Pull requests için okuma-yazma izni verin.' }] },
  airtableApi: { label: 'Airtable', fields: [{ key: 'token', label: 'Kişisel erişim anahtarı (pat…)', secret: true, help: 'airtable.com/create/tokens → Yeni anahtar. İzinler: data.records:read, data.records:write, schema.bases:read; erişim olarak kullanacağınız tabanları ekleyin.' }] },
  discordBot: { label: 'Discord botu', fields: [{ key: 'token', label: 'Bot token', secret: true, help: 'discord.com/developers/applications → uygulamanız → Bot → Reset Token. Mesajları okumak için aynı sayfada "Message Content Intent"i açın. Botu sunucunuza OAuth2 → URL Generator (bot; Send Messages, Read Message History, Add Reactions) ile ekleyin.' }] },
};

module.exports = function devNodes(h) {
  const { httpRequest } = h;
  const GITHUB = () => process.env.N8N8_GITHUB_API || 'https://api.github.com';
  const AIRTABLE = () => process.env.N8N8_AIRTABLE_API || 'https://api.airtable.com/v0';
  const DISCORD = () => process.env.N8N8_DISCORD_API || 'https://discord.com/api/v10';
  const cred = (types, label) => ({ key: 'credential', label, type: 'credential', credTypes: types, def: '' });
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const forItems = async (c, fn) => {
    const items = c.items.length ? c.items : [{ json: {} }]; const out = [];
    for (let i = 0; i < items.length; i++) { c.checkAbort(); const r = await fn(items[i], i); if (r) out.push(...[].concat(r).map(json => ({ json }))); }
    return [out];
  };
  const list = v => Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  /* ---------- GitHub ---------- */
  async function github(cr, method, path, { body, signal, allow404 = false } = {}) {
    const r = await httpRequest({ method, url: path.startsWith('http') ? path : GITHUB() + path, headers: { Authorization: `Bearer ${cr.data.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Auto-Move', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
    if (r.status === 404 && allow404) return null;
    if (!r.ok) {
      const msg = r.body?.message || '';
      const extra = (r.body?.errors || []).map(e => e.message || `${e.field} ${e.code}`).join(', ');
      throw new Error(`GitHub (${r.status}): ${r.status === 401 ? 'erişim anahtarı geçersiz' : r.status === 404 ? 'depo ya da kayıt bulunamadı (anahtarın bu depoya erişimi var mı?)' : r.status === 403 && /rate limit/i.test(msg) ? 'istek sınırı doldu; biraz sonra tekrar deneyin' : msg || 'hata'}${extra ? ` (${extra})` : ''}`);
    }
    return r.body;
  }
  // "sahip/depo" or a github.com link
  const repoOf = v => { const s = String(v || '').trim().replace(/\.git$/, ''); const m = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)/) || s.match(/^([\w.-]+)\/([\w.-]+)\/?$/); if (!m) throw new Error(`Depo "sahip/depo" biçiminde olmalı: ${v || '(boş)'}`); return `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`; };
  const issueJson = x => ({ numara: x.number, baslik: x.title, durum: x.state, metin: x.body || '', yazar: x.user?.login, etiketler: (x.labels || []).map(l => l.name || l), atananlar: (x.assignees || []).map(a => a.login), yorumSayisi: x.comments, link: x.html_url, olusturuldu: x.created_at, guncellendi: x.updated_at, ...(x.pull_request ? { pr: true } : {}), id: x.id });
  const prJson = x => ({ numara: x.number, baslik: x.title, durum: x.merged_at ? 'merged' : x.state, taslak: !!x.draft, metin: x.body || '', yazar: x.user?.login, dal: x.head?.ref, hedef: x.base?.ref, link: x.html_url, olusturuldu: x.created_at, id: x.id });
  const releaseJson = x => ({ etiket: x.tag_name, ad: x.name || x.tag_name, metin: x.body || '', taslak: x.draft, onSurum: x.prerelease, yazar: x.author?.login, link: x.html_url, yayinlandi: x.published_at, id: x.id });
  const commitJson = x => ({ sha: x.sha, mesaj: x.commit?.message || '', yazar: x.commit?.author?.name, eposta: x.commit?.author?.email, tarih: x.commit?.author?.date, link: x.html_url, id: x.sha });
  const filePath = p => String(p || '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

  /* ---------- Airtable ---------- */
  async function airtable(cr, method, path, body, signal) {
    for (let attempt = 0; ; attempt++) {
      const r = await httpRequest({ method, url: path.startsWith('http') ? path : AIRTABLE() + path, headers: { Authorization: `Bearer ${cr.data.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 60000 });
      if (r.status === 429 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; } // 5 requests per second per base
      if (!r.ok) {
        const e = r.body?.error; const msg = typeof e === 'string' ? e : e?.message || e?.type || '';
        throw new Error(`Airtable (${r.status}): ${r.status === 401 ? 'erişim anahtarı geçersiz' : r.status === 403 || r.status === 404 ? `taban ya da tablo bulunamadı veya anahtarın erişimi yok. ${msg}` : msg || 'hata'}`);
      }
      return r.body;
    }
  }
  // accepts appXXX + table name, or an airtable.com/appXXX/tblYYY link in the base field
  function baseTable(c, it, i) {
    const b = String(c.R(c.p.base, it, i) || '').trim(); let t = String(c.R(c.p.table, it, i) || '').trim();
    const app = b.match(/app[A-Za-z0-9]{14}/)?.[0]; if (!app) throw new Error(`Taban kimliği bulunamadı (app… ile başlar ya da bağlantıyı yapıştırın): ${b || '(boş)'}`);
    if (!t) t = b.match(/tbl[A-Za-z0-9]{14}/)?.[0] || '';
    if (!t) throw new Error('Tablo adı ya da kimliği boş');
    return `/${app}/${encodeURIComponent(t)}`;
  }
  const recordJson = r => ({ ...r.fields, id: r.id, _olusturuldu: r.createdTime });
  function fieldsOf(c, it, i) {
    if (c.p.fieldsMode === 'all') return Object.fromEntries(Object.entries(it.json).filter(([k]) => k !== 'id' && !k.startsWith('_')));
    const o = {}; for (const f of c.p.fields || []) if (f.key) o[f.key] = c.R(f.value, it, i); return o;
  }

  /* ---------- Discord ---------- */
  async function discord(cr, method, path, { body, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await httpRequest({ method, url: DISCORD() + path, headers: { Authorization: `Bot ${cr.data.token}`, 'User-Agent': 'DiscordBot (https://8n8.local, 2)', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal, timeout: 30000 });
      if (r.status === 429 && attempt < 2) { await sleep(Math.min(10000, (Number(r.body?.retry_after) || 1) * 1000)); continue; }
      if (r.status === 204) return {};
      if (!r.ok) {
        const code = r.body?.code; const msg = r.body?.message || '';
        throw new Error(`Discord (${r.status}): ${r.status === 401 ? 'bot token geçersiz' : code === 50001 ? 'botun bu kanala erişimi yok (kanal izinlerinde botu ekleyin)' : code === 50013 ? 'botun bu işlem için izni yok' : code === 10003 ? 'kanal bulunamadı' : code === 10008 ? 'mesaj bulunamadı' : code === 50006 ? 'boş mesaj gönderilemez' : msg || 'hata'}`);
      }
      return r.body;
    }
  }
  const snowflake = (v, what) => { const s = String(v ?? '').trim().replace(/^<#(\d+)>$/, '$1'); const m = s.match(/(\d{15,22})\/?$/); if (!m) throw new Error(`${what} kimliği geçersiz: ${s || '(boş)'} (Discord'da Geliştirici modunu açıp sağ tık → Kimliği kopyala)`); return m[1]; };
  const discordMsg = m => ({ id: m.id, kanal: m.channel_id, metin: m.content || '', yazar: m.author?.global_name || m.author?.username || '', yazarId: m.author?.id, bot: !!m.author?.bot, zaman: m.timestamp, ekler: (m.attachments || []).map(a => a.url), ...(m.message_reference?.message_id ? { yanitlanan: m.message_reference.message_id } : {}) });

  const NODES = {
    github: {
      label: 'GitHub', cat: 'app', icon: 'code', inputs: 1, outputs: ['main'],
      desc: 'GitHub deposunda konu (issue) açar, yorum yazar, kapatır, konuları ve PR\'ları listeler, dosya okur ya da kaydeder, sürümleri listeler.',
      params: [
        cred(['githubApi'], 'GitHub bağlantısı'),
        { key: 'repo', label: 'Depo (sahip/depo)', type: 'expr', def: '', help: 'Örnek: 8n8/ornek ya da depo bağlantısı' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'createIssue', options: [['createIssue', 'Konu (issue) aç'], ['comment', 'Konuya yorum yaz'], ['updateIssue', 'Konuyu kapat / aç / etiketle'], ['listIssues', 'Konuları listele'], ['listPulls', 'PR\'ları listele'], ['getFile', 'Dosya oku'], ['saveFile', 'Dosya kaydet (oluştur ya da güncelle)'], ['releases', 'Sürümleri listele']] },
        { key: 'title', label: 'Başlık', type: 'expr', def: '{{ $json.baslik }}', showIf: { op: 'createIssue' } },
        { key: 'body', label: 'Metin', type: 'textarea', def: '', showIf: { op: ['createIssue', 'comment'] }, help: 'Markdown kullanılabilir.' },
        { key: 'labels', label: 'Etiketler (virgülle)', type: 'expr', def: '', showIf: { op: ['createIssue', 'updateIssue', 'listIssues'] } },
        { key: 'assignees', label: 'Atananlar (kullanıcı adları, virgülle)', type: 'expr', def: '', showIf: { op: 'createIssue' } },
        { key: 'number', label: 'Konu numarası', type: 'expr', def: '{{ $json.numara }}', showIf: { op: ['comment', 'updateIssue'] } },
        { key: 'state', label: 'Durum', type: 'select', def: 'closed', options: [['closed', 'Kapat'], ['open', 'Yeniden aç'], ['', 'Değiştirme']], showIf: { op: 'updateIssue' } },
        { key: 'filter', label: 'Hangileri', type: 'select', def: 'open', options: [['open', 'Açık'], ['closed', 'Kapalı'], ['all', 'Hepsi']], showIf: { op: ['listIssues', 'listPulls'] } },
        { key: 'max', label: 'En fazla', type: 'number', def: 30, min: 1, showIf: { op: ['listIssues', 'listPulls', 'releases'] } },
        { key: 'path', label: 'Dosya yolu', type: 'expr', def: 'README.md', showIf: { op: ['getFile', 'saveFile'] } },
        { key: 'branch', label: 'Dal (boş = varsayılan)', type: 'expr', def: '', showIf: { op: ['getFile', 'saveFile'] } },
        { key: 'content', label: 'İçerik', type: 'textarea', def: '{{ JSON.stringify($json, null, 2) }}', showIf: { op: 'saveFile' } },
        { key: 'message', label: 'Değişiklik mesajı (commit)', type: 'expr', def: 'Auto-Move ile güncellendi', showIf: { op: 'saveFile' } },
      ],
      sub: '{op} · {repo}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const call = (m, p, o = {}) => github(cr, m, p, { ...o, signal: c.signal });
        const first = c.items[0] || { json: {} };
        const max = Math.max(1, Number(c.p.max) || 30);
        const paged = async (path, map, keep = () => true) => {
          const out = [];
          for (let page = 1; out.length < max && page <= 50; page++) {
            c.checkAbort();
            const r = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${Math.min(100, max)}&page=${page}`);
            out.push(...r.filter(keep).map(map));
            if (r.length < Math.min(100, max)) break;
          }
          return [out.slice(0, max).map(json => ({ json }))];
        };
        if (c.p.op === 'listIssues') { const repo = repoOf(c.R(c.p.repo, first, 0)); return paged(`/repos/${repo}/issues?${q({ state: c.p.filter, labels: list(c.R(c.p.labels, first, 0)).join(',') })}`, issueJson, x => !x.pull_request); }
        if (c.p.op === 'listPulls') { const repo = repoOf(c.R(c.p.repo, first, 0)); return paged(`/repos/${repo}/pulls?state=${c.p.filter}`, prJson); }
        if (c.p.op === 'releases') { const repo = repoOf(c.R(c.p.repo, first, 0)); return paged(`/repos/${repo}/releases`, releaseJson); }
        return forItems(c, async (it, i) => {
          const repo = repoOf(c.R(c.p.repo, it, i));
          if (c.p.op === 'createIssue') {
            const title = str(c.R(c.p.title, it, i)).trim(); if (!title) throw new Error(`${i + 1}. öğede başlık boş`);
            const labels = list(c.R(c.p.labels, it, i)); const assignees = list(c.R(c.p.assignees, it, i));
            return issueJson(await call('POST', `/repos/${repo}/issues`, { body: { title, body: str(c.R(c.p.body, it, i)), ...(labels.length ? { labels } : {}), ...(assignees.length ? { assignees } : {}) } }));
          }
          if (c.p.op === 'comment' || c.p.op === 'updateIssue') {
            const n = parseInt(String(c.R(c.p.number, it, i)).replace(/^#/, ''), 10); if (!n) throw new Error(`${i + 1}. öğede konu numarası yok`);
            if (c.p.op === 'comment') {
              const body = str(c.R(c.p.body, it, i)); if (!body.trim()) throw new Error(`${i + 1}. öğede yorum boş`);
              const r = await call('POST', `/repos/${repo}/issues/${n}/comments`, { body: { body } });
              return { numara: n, yorumId: r.id, link: r.html_url };
            }
            const labels = list(c.R(c.p.labels, it, i));
            return issueJson(await call('PATCH', `/repos/${repo}/issues/${n}`, { body: { ...(c.p.state ? { state: c.p.state } : {}), ...(labels.length ? { labels } : {}) } }));
          }
          const p = filePath(c.R(c.p.path, it, i)); if (!p) throw new Error(`${i + 1}. öğede dosya yolu boş`);
          const ref = str(c.R(c.p.branch, it, i)).trim();
          const existing = await call('GET', `/repos/${repo}/contents/${p}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, { allow404: c.p.op === 'saveFile' });
          if (c.p.op === 'getFile') {
            if (Array.isArray(existing)) return existing.map(f => ({ ad: f.name, yol: f.path, tur: f.type, boyut: f.size, link: f.html_url }));
            return { yol: existing.path, icerik: Buffer.from(existing.content || '', 'base64').toString('utf8'), boyut: existing.size, sha: existing.sha, link: existing.html_url };
          }
          if (Array.isArray(existing)) throw new Error(`"${decodeURIComponent(p)}" bir klasör`);
          const content = str(c.R(c.p.content, it, i));
          const r = await call('PUT', `/repos/${repo}/contents/${p}`, { body: { message: str(c.R(c.p.message, it, i)) || 'Auto-Move ile güncellendi', content: Buffer.from(content, 'utf8').toString('base64'), ...(existing?.sha ? { sha: existing.sha } : {}), ...(ref ? { branch: ref } : {}) } });
          return { yol: r.content?.path, sha: r.content?.sha, commit: r.commit?.sha, link: r.content?.html_url, islem: existing ? 'guncellendi' : 'olusturuldu' };
        });
      },
    },

    githubTrigger: {
      label: 'GitHub\'da yeni olay olunca', cat: 'trigger', icon: 'code', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken depoyu düzenli kontrol eder; yeni konu (issue), PR, sürüm ya da commit için akışı çalıştırır. İlk kontrolde mevcutlar yalnızca hatırlanır.',
      params: pollParams(5, 'm', [cred(['githubApi'], 'GitHub bağlantısı'), { key: 'repo', label: 'Depo (sahip/depo)', type: 'text', def: '' },
        { key: 'event', label: 'Olay', type: 'select', def: 'issues', options: [['issues', 'Yeni konu (issue)'], ['pulls', 'Yeni PR'], ['releases', 'Yeni sürüm'], ['commits', 'Yeni commit']] },
        { key: 'branch', label: 'Dal (commit için, boş = varsayılan)', type: 'text', def: '', showIf: { event: 'commits' } }]),
      sub: '{event} · {repo}',
      async poll(c) {
        const cr = await c.credential(c.p.credential); const repo = repoOf(c.p.repo);
        const [path, map, keep] = {
          issues: [`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=30`, issueJson, x => !x.pull_request],
          pulls: [`/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=30`, prJson, () => true],
          releases: [`/repos/${repo}/releases?per_page=30`, releaseJson, x => !x.draft],
          commits: [`/repos/${repo}/commits?per_page=30${c.p.branch ? `&sha=${encodeURIComponent(c.p.branch)}` : ''}`, commitJson, () => true],
        }[c.p.event] || [];
        if (!path) throw new Error('Bilinmeyen olay');
        const rows = (await github(cr, 'GET', path)).filter(keep).map(map);
        const mem = c.memory(); const key = `${repo}:${c.p.event}`;
        const first = mem.key !== key; const seen = new Set(first ? [] : mem.seen || []);
        const fresh = rows.filter(r => !seen.has(String(r.id)));
        Object.assign(mem, { key, seen: [...new Set([...rows.map(r => String(r.id)), ...seen])].slice(0, 2000) }); c.saveMemory();
        return first ? [] : fresh.reverse();
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        return [[{ json: { numara: 42, baslik: 'Giriş sayfası açılmıyor', durum: 'open', metin: 'Tarayıcıda boş sayfa geliyor.', yazar: 'ayse', etiketler: ['hata'], link: 'https://github.com/ornek/depo/issues/42', olusturuldu: new Date().toISOString() } }]];
      },
      eachItem: true,
    },

    airtable: {
      label: 'Airtable', cat: 'app', icon: 'table', inputs: 1, outputs: ['main'],
      desc: 'Airtable tablosunda kayıtları listeler, getirir, ekler, günceller, ekler-ya-da-günceller ve siler.',
      params: [
        cred(['airtableApi'], 'Airtable bağlantısı'),
        { key: 'base', label: 'Taban (app… ya da bağlantı)', type: 'expr', def: '', help: 'Tabloyu tarayıcıda açıp bağlantıyı yapıştırabilirsiniz; tablo da bağlantıdan alınır.' },
        { key: 'table', label: 'Tablo adı ya da kimliği', type: 'expr', def: '', help: 'Bağlantı yapıştırdıysanız boş bırakın.' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'list', options: [['list', 'Kayıtları listele'], ['get', 'Kaydı getir'], ['create', 'Kayıt ekle'], ['update', 'Kaydı güncelle'], ['upsert', 'Ekle ya da güncelle (alana göre)'], ['delete', 'Kaydı sil']] },
        { key: 'formula', label: 'Filtre formülü (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'list' }, help: 'Airtable formülü; ör. {Durum} = "Yeni" ya da AND({Puan} > 3, NOT({Bitti}))' },
        { key: 'view', label: 'Görünüm (isteğe bağlı)', type: 'text', def: '', showIf: { op: 'list' } },
        { key: 'sort', label: 'Sırala (alan adı, isteğe bağlı)', type: 'text', def: '', showIf: { op: 'list' } },
        { key: 'max', label: 'En fazla kayıt', type: 'number', def: 100, min: 1, showIf: { op: 'list' } },
        { key: 'recordId', label: 'Kayıt kimliği (rec…)', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['get', 'update', 'delete'] } },
        { key: 'mergeOn', label: 'Eşleştirme alanı', type: 'text', def: 'E-posta', showIf: { op: 'upsert' }, help: 'Bu alanı aynı olan kayıt varsa güncellenir, yoksa eklenir.' },
        { key: 'fieldsMode', label: 'Yazılacak alanlar', type: 'select', def: 'map', options: [['map', 'Belirttiğim alanlar'], ['all', 'Gelen öğenin tüm alanları']], showIf: { op: ['create', 'update', 'upsert'] } },
        { key: 'fields', label: 'Alanlar (Airtable\'daki ad = değer)', type: 'kv', def: [{ key: 'Ad', value: '{{ $json.ad }}' }], showIf: { op: ['create', 'update', 'upsert'], fieldsMode: 'map' } },
      ],
      sub: '{op} · {table}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const call = (m, p, b) => airtable(cr, m, p, b, c.signal);
        const items = c.items.length ? c.items : [{ json: {} }];
        if (c.p.op === 'list') {
          const path = baseTable(c, items[0], 0); const max = Math.max(1, Number(c.p.max) || 100); const out = []; let offset;
          const formula = str(c.R(c.p.formula, items[0], 0)).trim();
          do {
            c.checkAbort();
            const params = new URLSearchParams(q({ pageSize: Math.min(100, max - out.length), filterByFormula: formula, view: c.p.view, offset }));
            if (c.p.sort) { params.set('sort[0][field]', c.p.sort); params.set('sort[0][direction]', 'asc'); }
            const r = await call('GET', `${path}?${params}`);
            out.push(...r.records.map(recordJson)); offset = r.offset;
          } while (offset && out.length < max);
          return [out.slice(0, max).map(json => ({ json }))];
        }
        if (c.p.op === 'get' || c.p.op === 'delete') {
          return forItems(c, async (it, i) => {
            const id = str(c.R(c.p.recordId, it, i)).trim(); if (!/^rec\w+$/.test(id)) throw new Error(`${i + 1}. öğede geçerli kayıt kimliği yok (rec…): ${id || '(boş)'}`);
            const path = `${baseTable(c, it, i)}/${id}`;
            if (c.p.op === 'get') return recordJson(await call('GET', path));
            await call('DELETE', path); return { id, silindi: true };
          });
        }
        // create / update / upsert go in batches of 10 (Airtable's limit), grouped by table
        const groups = new Map();
        items.forEach((it, i) => {
          const path = baseTable(c, it, i); const fields = fieldsOf(c, it, i);
          let rec;
          if (c.p.op === 'update') { const id = str(c.R(c.p.recordId, it, i)).trim(); if (!/^rec\w+$/.test(id)) throw new Error(`${i + 1}. öğede geçerli kayıt kimliği yok (rec…): ${id || '(boş)'}`); rec = { id, fields }; }
          else rec = { fields };
          if (!groups.has(path)) groups.set(path, []);
          groups.get(path).push(rec);
        });
        const out = [];
        for (const [path, recs] of groups) for (let i = 0; i < recs.length; i += 10) {
          c.checkAbort();
          const records = recs.slice(i, i + 10);
          const body = { records, typecast: true, ...(c.p.op === 'upsert' ? { performUpsert: { fieldsToMergeOn: list(c.p.mergeOn) } } : {}) };
          const r = await call(c.p.op === 'create' ? 'POST' : 'PATCH', path, body);
          const created = new Set(r.createdRecords || []);
          out.push(...r.records.map(x => ({ json: { ...recordJson(x), ...(c.p.op === 'upsert' ? { _islem: created.has(x.id) ? 'eklendi' : 'guncellendi' } : {}) } })));
        }
        return [out];
      },
    },

    discord: {
      label: 'Discord', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'Discord botunuzla kanala mesaj ya da kart (embed) gönderir, mesaja yanıt verir, mesajı düzenler veya siler, tepki ekler, kanal mesajlarını ve sunucu kanallarını listeler.',
      params: [
        cred(['discordBot'], 'Discord botu'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'send', options: [['send', 'Mesaj gönder'], ['edit', 'Mesajı düzenle'], ['delete', 'Mesajı sil'], ['react', 'Tepki (emoji) ekle'], ['history', 'Kanal mesajlarını oku'], ['channels', 'Sunucu kanallarını listele']] },
        { key: 'channel', label: 'Kanal kimliği', type: 'expr', def: '', showIf: { op: ['send', 'edit', 'delete', 'react', 'history'] }, help: 'Discord ayarlarında Gelişmiş → Geliştirici modu\'nu açın, kanala sağ tıklayıp "Kimliği kopyala"ya basın. Kanal bağlantısı da olur.' },
        { key: 'guild', label: 'Sunucu kimliği', type: 'expr', def: '', showIf: { op: 'channels' } },
        { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Yeni kayıt: **{{ $json.ad }}**', showIf: { op: ['send', 'edit'] }, help: 'Discord biçimi: **kalın**, *italik*, `kod`. En fazla 2000 karakter.' },
        { key: 'embedTitle', label: 'Kart başlığı (isteğe bağlı)', type: 'expr', def: '', showIf: { op: ['send', 'edit'] } },
        { key: 'embedText', label: 'Kart metni', type: 'textarea', def: '', showIf: { op: ['send', 'edit'] } },
        { key: 'embedColor', label: 'Kart rengi', type: 'text', def: '#2fc2a6', showIf: { op: ['send', 'edit'] } },
        { key: 'replyTo', label: 'Yanıtlanacak mesaj kimliği (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'send' } },
        { key: 'messageId', label: 'Mesaj kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['edit', 'delete', 'react'] } },
        { key: 'emoji', label: 'Emoji', type: 'text', def: '✅', showIf: { op: 'react' }, help: 'Standart emoji ya da sunucu emojisi için ad:kimlik' },
        { key: 'max', label: 'En fazla mesaj', type: 'number', def: 20, min: 1, showIf: { op: 'history' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const call = (m, p, body) => discord(cr, m, p, { body, signal: c.signal });
        const first = c.items[0] || { json: {} };
        if (c.p.op === 'channels') {
          const g = snowflake(c.R(c.p.guild, first, 0), 'Sunucu');
          const TYPES = { 0: 'metin', 2: 'ses', 4: 'kategori', 5: 'duyuru', 13: 'sahne', 15: 'forum' };
          return [(await call('GET', `/guilds/${g}/channels`)).sort((a, b) => a.position - b.position).map(x => ({ json: { id: x.id, ad: x.name, tur: TYPES[x.type] || String(x.type), kategori: x.parent_id || null } }))];
        }
        if (c.p.op === 'history') {
          const ch = snowflake(c.R(c.p.channel, first, 0), 'Kanal'); const max = Math.max(1, Number(c.p.max) || 20); const out = []; let before;
          while (out.length < max) {
            c.checkAbort();
            const r = await call('GET', `/channels/${ch}/messages?${q({ limit: Math.min(100, max - out.length), before })}`);
            out.push(...r.map(discordMsg)); if (r.length < 100) break; before = r[r.length - 1].id;
          }
          return [out.map(json => ({ json }))];
        }
        return forItems(c, async (it, i) => {
          const ch = snowflake(c.R(c.p.channel, it, i), 'Kanal');
          const msgPath = () => `/channels/${ch}/messages/${snowflake(c.R(c.p.messageId, it, i), 'Mesaj')}`;
          if (c.p.op === 'send' || c.p.op === 'edit') {
            const content = str(c.R(c.p.text, it, i));
            if (content.length > 2000) throw new Error(`${i + 1}. öğede mesaj 2000 karakterden uzun (${content.length})`);
            const et = str(c.R(c.p.embedTitle, it, i)).trim(), ed = str(c.R(c.p.embedText, it, i)).trim();
            const color = parseInt(String(c.p.embedColor || '').replace('#', ''), 16);
            const embeds = et || ed ? [{ ...(et ? { title: et.slice(0, 256) } : {}), ...(ed ? { description: ed.slice(0, 4096) } : {}), ...(Number.isFinite(color) ? { color } : {}) }] : [];
            if (!content.trim() && !embeds.length) throw new Error(`${i + 1}. öğede mesaj boş`);
            const reply = c.p.op === 'send' ? str(c.R(c.p.replyTo, it, i)).trim() : '';
            const body = { content, embeds, allowed_mentions: { parse: ['users'] }, ...(reply ? { message_reference: { message_id: snowflake(reply, 'Mesaj') } } : {}) };
            const m = await call(c.p.op === 'send' ? 'POST' : 'PATCH', c.p.op === 'send' ? `/channels/${ch}/messages` : msgPath(), body);
            return { ...discordMsg(m), [c.p.op === 'send' ? 'gonderildi' : 'duzenlendi']: true };
          }
          if (c.p.op === 'delete') { await call('DELETE', msgPath()); return { id: str(c.R(c.p.messageId, it, i)), silindi: true }; }
          await call('PUT', `${msgPath()}/reactions/${encodeURIComponent(String(c.p.emoji || '✅').trim())}/@me`);
          return { ...it.json, tepki: c.p.emoji };
        });
      },
    },

    discordTrigger: {
      label: 'Discord\'a mesaj gelince', cat: 'trigger', icon: 'chat', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken bir Discord kanalını düzenli kontrol eder; her yeni mesaj için akışı çalıştırır. Botların mesajları atlanır.',
      params: pollParams(30, 's', [cred(['discordBot'], 'Discord botu'), { key: 'channel', label: 'Kanal kimliği', type: 'text', def: '' }, { key: 'contains', label: 'Yalnız içinde geçenler (boş = hepsi)', type: 'text', def: '' }]),
      sub: '{channel}',
      async poll(c) {
        const cr = await c.credential(c.p.credential); const ch = snowflake(c.p.channel, 'Kanal');
        const mem = c.memory(); const first = mem.channel !== ch || !mem.last;
        const r = await discord(cr, 'GET', `/channels/${ch}/messages?${q({ limit: first ? 1 : 100, after: first ? '' : mem.last })}`);
        if (r.length) mem.last = r.reduce((a, m) => (BigInt(m.id) > BigInt(a) ? m.id : a), mem.last && !first ? mem.last : '0');
        else if (first) mem.last = String((BigInt(Date.now() - 1420070400000) << 22n)); // a snowflake for "now"
        mem.channel = ch; c.saveMemory();
        if (first) return [];
        const needle = String(c.p.contains || '').toLocaleLowerCase('tr');
        return r.filter(m => !m.author?.bot && (!needle || String(m.content || '').toLocaleLowerCase('tr').includes(needle))).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map(discordMsg);
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        return [[{ json: { id: '1200000000000000001', kanal: '1100000000000000001', metin: 'Merhaba, sipariş durumu nedir?', yazar: 'ayse', bot: false, zaman: new Date().toISOString() } }]];
      },
      eachItem: true,
    },
  };

  async function test(type, d) {
    if (type === 'githubApi') { const r = await github({ data: d }, 'GET', '/user'); return `Bağlandı: @${r.login}`; }
    if (type === 'airtableApi') { const r = await airtable({ data: d }, 'GET', '/meta/whoami'); return `Bağlandı${r.email ? `: ${r.email}` : ''}`; }
    if (type === 'discordBot') { const r = await discord({ data: d }, 'GET', '/users/@me'); return `Bot bulundu: ${r.username}`; }
    return null;
  }
  return { NODES, CREDENTIAL_TYPES, test };
};
