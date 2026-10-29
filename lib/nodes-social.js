'use strict';
/* Sosyal medya ve reklam: YouTube (+ yeni video / yorum tetikleyicisi), Google Analytics 4, Google Ads, Meta (Facebook /
   Instagram) reklamları, LinkedIn ve X. YouTube, Analytics ve Ads "Google hesabı" kimlik bilgisiyle bağlanır.
   N8N8_GOOGLE_API, N8N8_META_API, N8N8_LINKEDIN_API ve N8N8_X_API başka adrese yönlendirir (testler). */
const fs = require('fs');
const path = require('path');
const oauth = require('./oauth');

const CREDENTIAL_TYPES = {
  googleAdsApi: { label: 'Google Ads hesabı', fields: [
    { key: 'customerId', label: 'Müşteri kimliği', help: 'Google Ads\'te sağ üstteki 123-456-7890 biçimindeki numara.' },
    { key: 'developerToken', label: 'Geliştirici jetonu (developer token)', secret: true, help: 'Yönetici hesabında Araçlar → API Merkezi. Bağlantı "Google hesabı" kimlik bilgisiyle kurulur; orada servislere "ads" ekleyin.' },
    { key: 'loginCustomerId', label: 'Yönetici hesabı kimliği (isteğe bağlı)', def: '', help: 'Hesaba bir yönetici (MCC) hesabı üzerinden erişiyorsanız onun numarası.' },
    { key: 'version', label: 'API sürümü', def: 'v26', help: 'Google eski sürümleri yaklaşık bir yıl sonra kapatır; hata alırsanız güncel sürüm numarasını yazın.' }] },
  metaAds: { label: 'Meta reklam hesabı (Facebook / Instagram reklamları)', fields: [
    { key: 'adAccountId', label: 'Reklam hesabı kimliği', help: 'Reklam Yöneticisi\'nde hesap adının altındaki numara (act_ olmadan da yazılabilir).' },
    { key: 'token', label: 'Erişim anahtarı', secret: true, help: 'developers.facebook.com → uygulamanız → Graph API Gezgini: ads_read (kampanya açıp durdurmak için ads_management) izinli uzun süreli anahtar ya da Business Manager sistem kullanıcısı anahtarı.' }] },
  linkedinOAuth: { label: 'LinkedIn hesabı', oauth: true, fields: [
    { key: 'clientId', label: 'İstemci kimliği (Client ID)', help: 'linkedin.com/developers → Uygulama oluştur → Ürünler: "Sign In with LinkedIn using OpenID Connect" ve "Share on LinkedIn". Auth sekmesine aşağıdaki yönlendirme adresini ekleyin.' },
    { key: 'clientSecret', label: 'İstemci gizli anahtarı (Client secret)', secret: true },
    { key: 'pages', label: 'Şirket sayfası adına paylaşım', def: 'false', options: [['false', 'Hayır, yalnız kendi profilim'], ['true', 'Evet (Community Management API onayı gerekir)']] }] },
  xOAuth: { label: 'X (Twitter) hesabı', oauth: true, fields: [
    { key: 'clientId', label: 'OAuth 2.0 Client ID', help: 'developer.x.com → Projects & Apps → uygulamanız → User authentication settings: "Web App", Read and write izni ve aşağıdaki yönlendirme adresi. Keys and tokens sekmesindeki OAuth 2.0 Client ID ve Secret.' },
    { key: 'clientSecret', label: 'OAuth 2.0 Client Secret', secret: true }] },
};

const DATE_OPTS = [['yesterday', 'Dün'], ['today', 'Bugün'], ['last7', 'Son 7 gün'], ['last28', 'Son 28 gün'], ['last30', 'Son 30 gün'], ['thisMonth', 'Bu ay'], ['lastMonth', 'Geçen ay'], ['custom', 'Tarih aralığı']];

module.exports = function socialNodes(h) {
  const { httpRequest, safeFile } = h;
  const env = (k, d) => (process.env[k] || d).replace(/\/+$/, '');
  const G = () => process.env.N8N8_GOOGLE_API || null;
  const YT = () => `${G() || 'https://www.googleapis.com'}/youtube/v3`;
  const YTUP = () => `${G() || 'https://www.googleapis.com'}/upload/youtube/v3`;
  const GA = () => `${G() || 'https://analyticsdata.googleapis.com'}/v1beta`;
  const ADS = () => G() || 'https://googleads.googleapis.com';
  const META = () => env('N8N8_META_API', 'https://graph.facebook.com/v25.0');
  const LI = () => env('N8N8_LINKEDIN_API', 'https://api.linkedin.com');
  const X = () => env('N8N8_X_API', 'https://api.x.com');
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const cred = (types, label, key = 'credential') => ({ key, label, type: 'credential', credTypes: types, def: '' });
  const items = c => (c.items.length ? c.items : [{ json: {} }]);
  const forItems = async (c, fn) => { const its = items(c); const out = []; for (let i = 0; i < its.length; i++) { c.checkAbort(); const R = k => str(c.R(c.p[k], its[i], i)).trim(); const r = await fn(R, its[i], i); if (r != null) out.push(...[].concat(r).map(json => ({ json }))); } return [out]; };
  const toNum = v => (v === '' || v == null || Number.isNaN(Number(v)) ? v ?? null : Number(v));
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || d));
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const newOnly = (c, list, idOf) => {
    const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
    const fresh = list.filter(x => !seen.has(String(idOf(x))));
    mem.seen = [...new Set([...list.map(x => String(idOf(x))), ...seen])].slice(0, 3000); c.saveMemory();
    return first ? [] : fresh.reverse();
  };

  /* ---------- date ranges (local calendar days; "last 7 days" ends yesterday, as in Google and Meta) ---------- */
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  function range(preset, s, e) {
    const t = day(0);
    switch (preset) {
      case 'today': return [ymd(t), ymd(t)];
      case 'last7': return [ymd(day(-7)), ymd(day(-1))];
      case 'last28': return [ymd(day(-28)), ymd(day(-1))];
      case 'last30': return [ymd(day(-30)), ymd(day(-1))];
      case 'thisMonth': return [ymd(new Date(t.getFullYear(), t.getMonth(), 1, 12)), ymd(t)];
      case 'lastMonth': return [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1, 12)), ymd(new Date(t.getFullYear(), t.getMonth(), 0, 12))];
      case 'custom': {
        const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (!ok(s) || !ok(e)) throw new Error('Başlangıç ve bitiş tarihini YYYY-AA-GG biçiminde yazın');
        if (s > e) throw new Error('Başlangıç tarihi bitişten sonra olamaz');
        return [s, e];
      }
      default: return [ymd(day(-1)), ymd(day(-1))];
    }
  }
  const dateParams = (showIf, def = 'last7') => [
    { key: 'dates', label: 'Tarih aralığı', type: 'select', def, options: DATE_OPTS, showIf },
    { key: 'start', label: 'Başlangıç (YYYY-AA-GG)', type: 'expr', def: '', showIf: { ...showIf, dates: 'custom' } },
    { key: 'end', label: 'Bitiş (YYYY-AA-GG)', type: 'expr', def: '', showIf: { ...showIf, dates: 'custom' } }];

  /* ---------- HTTP ---------- */
  async function call(what, method, url, { token, body, raw, headers = {}, signal, timeout } = {}) {
    const json = body !== undefined && !raw;
    const r = await httpRequest({ method, url, headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(body) : body, signal, timeout: timeout || 60000 });
    if (!r.ok) {
      const b = r.body; const e = b?.error;
      const msg = (e?.details?.[0]?.errors?.[0]?.message) || e?.error_user_msg || e?.message || (typeof e === 'string' ? e : '') || b?.message || b?.detail || b?.errors?.[0]?.message || b?.title || (typeof b === 'string' ? b.slice(0, 200) : '');
      throw new Error(`${what} (${r.status}): ${r.status === 401 ? `oturum geçersiz ya da süresi doldu; kimlik bilgisinde yeniden bağlanın. ${msg}`.trim() : msg || 'hata'}`);
    }
    return r;
  }
  const gtoken = async (c, key = 'credential') => { const cr = await c.credential(c.p[key]); return oauth.accessToken(cr); };
  const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

  /* a file from the files folder or an https address */
  async function media(ref, signal) {
    const v = String(ref || '').trim(); if (!v) return null;
    if (/^https?:\/\//i.test(v)) {
      const r = await fetch(v, { signal: signal || AbortSignal.timeout(120000) }).catch(e => { throw new Error(`Resim indirilemedi: ${e.cause?.message || e.message}`); });
      if (!r.ok) throw new Error(`Resim indirilemedi (${r.status}): ${v}`);
      return { buf: Buffer.from(await r.arrayBuffer()), type: (r.headers.get('content-type') || '').split(';')[0] || mimeOf(v), name: path.basename(new URL(v).pathname) || 'resim' };
    }
    const f = safeFile(v); if (!fs.existsSync(f)) throw new Error(`Dosya bulunamadı: ${v}`);
    return { buf: fs.readFileSync(f), type: mimeOf(f), name: path.basename(f) };
  }
  const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
  const mimeOf = f => MIME[path.extname(String(f).split('?')[0]).toLowerCase()] || 'application/octet-stream';

  /* ================= YouTube ================= */
  const yt = (tok, method, p, opts = {}) => call('YouTube', method, `${YT()}${p}`, { token: tok, ...opts }).then(r => r.body);
  const dur = s => { const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) : null; };
  const video = v => ({
    id: v.id, baslik: v.snippet?.title ?? null, aciklama: v.snippet?.description ?? null, yayin: v.snippet?.publishedAt ?? null,
    url: `https://www.youtube.com/watch?v=${v.id}`, kanal: v.snippet?.channelTitle ?? null, kanalId: v.snippet?.channelId ?? null,
    etiketler: v.snippet?.tags || [], resim: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || null,
    goruntulenme: toNum(v.statistics?.viewCount), begeni: toNum(v.statistics?.likeCount), yorum: toNum(v.statistics?.commentCount),
    sureSn: dur(v.contentDetails?.duration), gizlilik: v.status?.privacyStatus ?? null,
  });
  const comment = t => { const s = t.snippet?.topLevelComment?.snippet || t.snippet || {}; return { id: t.id, yorumId: t.snippet?.topLevelComment?.id || t.id, videoId: s.videoId || t.snippet?.videoId || null, yazar: s.authorDisplayName ?? null, yazarKanal: s.authorChannelId?.value ?? null, metin: s.textOriginal ?? s.textDisplay ?? null, tarih: s.publishedAt ?? null, begeni: toNum(s.likeCount), yanitSayisi: toNum(t.snippet?.totalReplyCount) }; };
  async function channel(tok, id, signal) {
    const r = await yt(tok, 'GET', `/channels?${q({ part: 'snippet,statistics,contentDetails', ...(id ? { id } : { mine: 'true' }) })}`, { signal });
    const ch = r.items?.[0]; if (!ch) throw new Error(id ? `Kanal bulunamadı: ${id}` : 'Bu Google hesabının YouTube kanalı yok');
    return ch;
  }
  const chJson = ch => ({ id: ch.id, ad: ch.snippet?.title ?? null, url: `https://www.youtube.com/channel/${ch.id}`, abone: toNum(ch.statistics?.subscriberCount), goruntulenme: toNum(ch.statistics?.viewCount), videoSayisi: toNum(ch.statistics?.videoCount), olusturma: ch.snippet?.publishedAt ?? null });
  async function videosByIds(tok, ids, signal) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await yt(tok, 'GET', `/videos?${q({ part: 'snippet,statistics,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' })}`, { signal });
      out.push(...(r.items || []).map(video));
    }
    return out;
  }
  async function uploads(tok, channelId, max, signal) {
    const ch = await channel(tok, channelId, signal); const pl = ch.contentDetails?.relatedPlaylists?.uploads;
    if (!pl) return [];
    const r = await yt(tok, 'GET', `/playlistItems?${q({ part: 'contentDetails', playlistId: pl, maxResults: String(Math.min(50, max)) })}`, { signal });
    return (r.items || []).map(x => x.contentDetails?.videoId).filter(Boolean);
  }
  const videoId = v => { const s = String(v || '').trim(); const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : s; };

  const NODES = {
    youtube: {
      label: 'YouTube', cat: 'app', icon: 'video', inputs: 1, outputs: ['main'],
      desc: 'YouTube kanalınıza video yükler, başlık ve açıklamayı değiştirir, videolarınızı ve izlenme sayılarını getirir, yorumları okur ve yanıtlar. "Google hesabı" kimlik bilgisinin servislerine youtube ekleyin.',
      params: [
        cred(['googleOAuth'], 'Google hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'videos', options: [['videos', 'Kanaldaki videoları getir'], ['video', 'Video bilgisi ve istatistikleri'], ['channel', 'Kanal istatistikleri'], ['comments', 'Videonun yorumlarını getir'], ['reply', 'Yoruma yanıt yaz'], ['upload', 'Video yükle'], ['update', 'Başlık / açıklama değiştir']] },
        { key: 'channelId', label: 'Kanal kimliği (boş = kendi kanalım)', type: 'expr', def: '', showIf: { op: ['videos', 'channel'] }, help: 'UC ile başlayan kanal kimliği.' },
        { key: 'videoId', label: 'Video (kimlik ya da adres)', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['video', 'comments', 'update'] } },
        { key: 'commentId', label: 'Yorum kimliği', type: 'expr', def: '{{ $json.yorumId }}', showIf: { op: 'reply' } },
        { key: 'text', label: 'Yanıt', type: 'textarea', def: '{{ $json.yanit }}', showIf: { op: 'reply' } },
        { key: 'file', label: 'Video dosyası (dosya klasöründe)', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'upload' } },
        { key: 'title', label: 'Başlık', type: 'expr', def: '{{ $json.baslik }}', showIf: { op: ['upload', 'update'] }, help: 'Değiştirirken boş bırakılırsa aynı kalır.' },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '', showIf: { op: ['upload', 'update'] } },
        { key: 'tags', label: 'Etiketler (virgülle)', type: 'expr', def: '', showIf: { op: ['upload', 'update'] } },
        { key: 'privacy', label: 'Görünürlük', type: 'select', def: 'private', options: [['private', 'Gizli'], ['unlisted', 'Liste dışı'], ['public', 'Herkese açık']], showIf: { op: 'upload' }, help: 'Google\'ın denetiminden geçmemiş uygulamalarla yüklenen videolar gizli kalır.' },
        { key: 'max', label: 'En fazla', type: 'number', def: 25, min: 1, showIf: { op: ['videos', 'comments'] } },
      ],
      sub: '{op}',
      async run(c) {
        const tok = await gtoken(c); const max = clamp(c.p.max, 1, 500, 25);
        if (c.p.op === 'videos') {
          const out = []; const seenCh = new Set();
          for (const [i, it] of items(c).entries()) { const ch = str(c.R(c.p.channelId, it, i)).trim(); if (seenCh.has(ch)) continue; seenCh.add(ch); out.push(...await videosByIds(tok, await uploads(tok, ch, max, c.signal), c.signal)); }
          return [out.map(json => ({ json }))];
        }
        if (c.p.op === 'channel') return forItems(c, async R => chJson(await channel(tok, R('channelId'), c.signal)));
        return forItems(c, async (R, it) => {
          if (c.p.op === 'video') { const v = (await videosByIds(tok, [videoId(R('videoId'))], c.signal))[0]; if (!v) throw new Error(`Video bulunamadı: ${R('videoId')}`); return v; }
          if (c.p.op === 'comments') {
            const out = []; let page = '';
            do {
              const r = await yt(tok, 'GET', `/commentThreads?${q({ part: 'snippet', videoId: videoId(R('videoId')), order: 'time', maxResults: String(Math.min(100, max - out.length)), pageToken: page, textFormat: 'plainText' })}`, { signal: c.signal });
              out.push(...(r.items || []).map(comment)); page = r.nextPageToken || '';
            } while (page && out.length < max);
            return out;
          }
          if (c.p.op === 'reply') {
            if (!R('commentId') || !R('text')) throw new Error('Yorum kimliği ve yanıt metni gerekli');
            const r = await yt(tok, 'POST', '/comments?part=snippet', { body: { snippet: { parentId: R('commentId'), textOriginal: R('text') } }, signal: c.signal });
            return { id: r.id, yorumId: R('commentId'), metin: r.snippet?.textOriginal ?? R('text'), tarih: r.snippet?.publishedAt ?? null };
          }
          const tags = R('tags') ? R('tags').split(',').map(s => s.trim()).filter(Boolean) : null;
          if (c.p.op === 'update') {
            const id = videoId(R('videoId'));
            const cur = (await yt(tok, 'GET', `/videos?${q({ part: 'snippet', id })}`, { signal: c.signal })).items?.[0];
            if (!cur) throw new Error(`Video bulunamadı: ${id}`);
            const sn = { title: R('title') || cur.snippet.title, description: R('description') || cur.snippet.description || '', categoryId: cur.snippet.categoryId || '22', tags: tags || cur.snippet.tags || [] };
            await yt(tok, 'PUT', '/videos?part=snippet', { body: { id, snippet: sn }, signal: c.signal });
            return (await videosByIds(tok, [id], c.signal))[0];
          }
          // upload: resumable session, then the whole file in one request
          const name = R('file'); const f = safeFile(name); if (!name || !fs.existsSync(f)) throw new Error(`Video dosyası bulunamadı: ${name}`);
          if (!R('title')) throw new Error('Video başlığı gerekli');
          const buf = fs.readFileSync(f); const type = mimeOf(f).startsWith('video/') ? mimeOf(f) : 'video/*';
          const meta = { snippet: { title: R('title'), description: R('description'), tags: tags || [], categoryId: '22' }, status: { privacyStatus: c.p.privacy || 'private', selfDeclaredMadeForKids: false } };
          const s = await call('YouTube', 'POST', `${YTUP()}/videos?uploadType=resumable&part=snippet,status`, { token: tok, body: meta, headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(buf.length) }, signal: c.signal });
          const loc = s.headers.location; if (!loc) throw new Error('YouTube yükleme adresi vermedi');
          const up = await call('YouTube', 'PUT', loc, { token: tok, body: buf, raw: true, headers: { 'Content-Type': type }, signal: c.signal, timeout: 60 * 60000 });
          return video(up.body);
        });
      },
    },
    youtubeTrigger: {
      label: 'YouTube\'da yeni video ya da yorum', cat: 'trigger', icon: 'video', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Bir kanala (kendi kanalınız ya da başkasının) yeni video yüklenince ya da kanalınızın videolarına yeni yorum yazılınca akışı çalıştırır.',
      params: pollParams(15, 'm', [cred(['googleOAuth'], 'Google hesabı'),
        { key: 'event', label: 'Ne olunca', type: 'select', def: 'video', options: [['video', 'Yeni video yüklenince'], ['comment', 'Kanalıma yeni yorum gelince']] },
        { key: 'channelId', label: 'Kanal kimliği (boş = kendi kanalım)', type: 'text', def: '', showIf: { event: 'video' } }]),
      async poll(c) {
        const tok = await gtoken(c);
        if (c.p.event === 'comment') {
          const ch = await channel(tok, '', null);
          const r = await yt(tok, 'GET', `/commentThreads?${q({ part: 'snippet', allThreadsRelatedToChannelId: ch.id, order: 'time', maxResults: '50', textFormat: 'plainText' })}`);
          return newOnly(c, (r.items || []).map(comment), x => x.id);
        }
        const fresh = newOnly(c, await uploads(tok, String(c.p.channelId || '').trim(), 50), x => x);
        return fresh.length ? videosByIds(tok, fresh) : [];
      },
      async run(c) { if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))]; return [[{ json: c.p.event === 'comment' ? { id: 'Ugz-ornek', yorumId: 'Ugz-ornek', videoId: 'dQw4w9WgXcQ', yazar: 'Ayşe Yılmaz', metin: 'Harika video, teşekkürler!', tarih: new Date().toISOString(), begeni: 0, yanitSayisi: 0 } : { id: 'dQw4w9WgXcQ', baslik: 'Örnek video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', yayin: new Date().toISOString(), goruntulenme: 0 } }]]; },
      eachItem: true,
    },

    /* ================= Google Analytics 4 ================= */
    googleAnalytics: {
      label: 'Google Analytics', cat: 'app', icon: 'chart', inputs: 1, outputs: ['main'],
      desc: 'Google Analytics 4 mülkünüzden ziyaretçi, oturum, sayfa görüntüleme, gelir gibi raporları ya da şu an sitede olanları getirir. "Google hesabı" kimlik bilgisinin servislerine analytics ekleyin.',
      params: [
        cred(['googleOAuth'], 'Google hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'report', options: [['report', 'Rapor'], ['realtime', 'Şu an sitede (son 30 dakika)']] },
        { key: 'property', label: 'Mülk kimliği', type: 'expr', def: '', help: 'Analytics → Yönetici → Mülk ayrıntıları → Mülk kimliği (yalnız rakamlar).' },
        ...dateParams({ op: 'report' }),
        { key: 'dimensions', label: 'Boyutlar (virgülle)', type: 'text', def: 'date', help: 'Örnek: date, country, city, pagePath, sessionSource, deviceCategory. Boş = toplam.' },
        { key: 'metrics', label: 'Ölçümler (virgülle)', type: 'text', def: 'activeUsers,sessions,screenPageViews', help: 'Örnek: activeUsers, newUsers, sessions, screenPageViews, conversions, totalRevenue, bounceRate, averageSessionDuration.' },
        { key: 'max', label: 'En fazla satır', type: 'number', def: 100, min: 1 },
      ],
      sub: '{op}',
      async run(c) {
        const tok = await gtoken(c);
        return forItems(c, async R => {
          const prop = R('property').replace(/^properties\//, ''); if (!/^\d+$/.test(prop)) throw new Error('Mülk kimliğini rakamlarla yazın (Analytics → Yönetici → Mülk ayrıntıları)');
          const dims = String(c.p.dimensions || '').split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name }));
          const mets = String(c.p.metrics || '').split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name }));
          if (!mets.length) throw new Error('En az bir ölçüm yazın');
          const limit = String(clamp(c.p.max, 1, 100000, 100)); let body, ep;
          if (c.p.op === 'realtime') { ep = 'runRealtimeReport'; body = { dimensions: dims, metrics: mets, limit }; }
          else {
            const [s, e] = range(c.p.dates, R('start'), R('end')); ep = 'runReport';
            body = { dateRanges: [{ startDate: s, endDate: e }], dimensions: dims, metrics: mets, limit, orderBys: dims.some(d => d.name === 'date') ? [{ dimension: { dimensionName: 'date' } }] : [{ metric: { metricName: mets[0].name }, desc: true }] };
          }
          const r = (await call('Google Analytics', 'POST', `${GA()}/properties/${prop}:${ep}`, { token: tok, body, signal: c.signal })).body;
          const dh = (r.dimensionHeaders || []).map(x => x.name), mh = (r.metricHeaders || []).map(x => x.name);
          return (r.rows || []).map(row => {
            const o = {};
            dh.forEach((n, i) => { let v = row.dimensionValues?.[i]?.value ?? null; if (n === 'date' && /^\d{8}$/.test(v)) v = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`; o[n] = v; });
            mh.forEach((n, i) => { o[n] = toNum(row.metricValues?.[i]?.value); });
            return o;
          });
        });
      },
    },

    /* ================= Google Ads ================= */
    googleAds: {
      label: 'Google Ads', cat: 'app', icon: 'megaphone', inputs: 1, outputs: ['main'],
      desc: 'Google Ads kampanyalarınızın gösterim, tıklama, harcama ve dönüşümlerini getirir, GAQL sorgusu çalıştırır, kampanyayı durdurur ya da yeniden başlatır.',
      params: [
        cred(['googleOAuth'], 'Google hesabı (servislere ads ekleyin)'),
        cred(['googleAdsApi'], 'Google Ads hesabı', 'adsCredential'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'campaigns', options: [['campaigns', 'Kampanya performansı'], ['query', 'GAQL sorgusu'], ['status', 'Kampanyayı durdur / başlat']] },
        ...dateParams({ op: 'campaigns' }),
        { key: 'daily', label: 'Günlere böl', type: 'toggle', def: false, showIf: { op: 'campaigns' } },
        { key: 'gaql', label: 'Sorgu (GAQL)', type: 'textarea', def: "SELECT ad_group.name, metrics.clicks, metrics.cost_micros FROM ad_group WHERE segments.date DURING LAST_7_DAYS", showIf: { op: 'query' }, help: 'Google Ads Query Language. Sonuçta alanlar kampanya.ad gibi noktalı adlarla gelir; *_micros alanları milyonda birdir.' },
        { key: 'campaignId', label: 'Kampanya kimliği', type: 'expr', def: '{{ $json.kampanyaId }}', showIf: { op: 'status' } },
        { key: 'status', label: 'Yeni durum', type: 'select', def: 'PAUSED', options: [['PAUSED', 'Durdur'], ['ENABLED', 'Başlat']], showIf: { op: 'status' } },
      ],
      sub: '{op}',
      async run(c) {
        const tok = await gtoken(c); const ac = await c.credential(c.p.adsCredential); const d = ac.data;
        const cid = String(d.customerId || '').replace(/\D/g, ''); if (!cid) throw new Error('Google Ads müşteri kimliği eksik');
        const ver = String(d.version || 'v26').trim().replace(/^(\d)/, 'v$1');
        const headers = { 'developer-token': d.developerToken || '', ...(String(d.loginCustomerId || '').replace(/\D/g, '') ? { 'login-customer-id': String(d.loginCustomerId).replace(/\D/g, '') } : {}) };
        const ads = (method, p, body) => call('Google Ads', method, `${ADS()}/${ver}/customers/${cid}${p}`, { token: tok, body, headers, signal: c.signal }).then(r => r.body);
        async function search(query) {
          const out = []; let pageToken;
          do { const r = await ads('POST', '/googleAds:search', { query, ...(pageToken ? { pageToken } : {}) }); out.push(...(r.results || [])); pageToken = r.nextPageToken; } while (pageToken && out.length < 100000);
          return out;
        }
        const flat = (o, pre = '', out = {}) => { for (const [k, v] of Object.entries(o || {})) { const key = pre + k; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key + '.', out); else out[key] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && /^metrics\./.test(key) ? Number(v) : v; } return out; };
        return forItems(c, async R => {
          if (c.p.op === 'status') {
            const id = R('campaignId').replace(/\D/g, ''); if (!id) throw new Error('Kampanya kimliği gerekli');
            await ads('POST', '/campaigns:mutate', { operations: [{ update: { resourceName: `customers/${cid}/campaigns/${id}`, status: c.p.status }, updateMask: 'status' }] });
            return { kampanyaId: id, durum: c.p.status };
          }
          if (c.p.op === 'query') { if (!R('gaql')) throw new Error('Sorgu boş'); return (await search(R('gaql'))).map(x => flat(x)); }
          const [s, e] = range(c.p.dates, R('start'), R('end'));
          const rows = await search(`SELECT campaign.id, campaign.name, campaign.status, customer.currency_code, ${c.p.daily ? 'segments.date, ' : ''}metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc FROM campaign WHERE segments.date BETWEEN '${s}' AND '${e}' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC`);
          const m = x => Number(x ?? 0);
          return rows.map(x => ({
            ...(c.p.daily ? { tarih: x.segments?.date ?? null } : { baslangic: s, bitis: e }),
            kampanyaId: String(x.campaign?.id ?? ''), kampanya: x.campaign?.name ?? null, durum: x.campaign?.status ?? null,
            gosterim: m(x.metrics?.impressions), tiklama: m(x.metrics?.clicks), harcama: Math.round(m(x.metrics?.costMicros) / 10000) / 100,
            donusum: m(x.metrics?.conversions), donusumDegeri: m(x.metrics?.conversionsValue), tiklamaOrani: Math.round(m(x.metrics?.ctr) * 10000) / 100,
            ortalamaTbm: Math.round(m(x.metrics?.averageCpc) / 10000) / 100, paraBirimi: x.customer?.currencyCode ?? null, platform: 'Google Ads',
          }));
        });
      },
    },

    /* ================= Meta (Facebook / Instagram) reklamları ================= */
    metaAds: {
      label: 'Meta reklamları', cat: 'app', icon: 'megaphone', inputs: 1, outputs: ['main'],
      desc: 'Facebook ve Instagram reklam hesabınızın gösterim, erişim, tıklama, harcama ve dönüşüm raporunu getirir, kampanyaları listeler, durdurur ya da yeniden başlatır.',
      params: [
        cred(['metaAds'], 'Meta reklam hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'insights', options: [['insights', 'Reklam raporu'], ['campaigns', 'Kampanyaları listele'], ['status', 'Kampanyayı durdur / başlat']] },
        { key: 'level', label: 'Düzey', type: 'select', def: 'campaign', options: [['account', 'Hesap toplamı'], ['campaign', 'Kampanya'], ['adset', 'Reklam seti'], ['ad', 'Reklam']], showIf: { op: 'insights' } },
        ...dateParams({ op: 'insights' }),
        { key: 'daily', label: 'Günlere böl', type: 'toggle', def: false, showIf: { op: 'insights' } },
        { key: 'campaignId', label: 'Kampanya kimliği', type: 'expr', def: '{{ $json.kampanyaId || $json.id }}', showIf: { op: 'status' } },
        { key: 'status', label: 'Yeni durum', type: 'select', def: 'PAUSED', options: [['PAUSED', 'Durdur'], ['ACTIVE', 'Başlat']], showIf: { op: 'status' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const tok = cr.data.token;
        const act = `act_${String(cr.data.adAccountId || '').replace(/^act_/, '').trim()}`; if (act === 'act_') throw new Error('Reklam hesabı kimliği eksik');
        const get = async url => { const out = []; let next = url; while (next && out.length < 50000) { const r = (await call('Meta', 'GET', next, { token: tok, signal: c.signal })).body; out.push(...(r.data || [])); next = r.paging?.next || null; } return out; };
        return forItems(c, async R => {
          if (c.p.op === 'status') {
            const id = R('campaignId'); if (!/^\d+$/.test(id)) throw new Error('Kampanya kimliği gerekli');
            const r = await call('Meta', 'POST', `${META()}/${id}`, { token: tok, raw: true, body: new URLSearchParams({ status: c.p.status }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: c.signal });
            return { kampanyaId: id, durum: c.p.status, basarili: r.body?.success !== false };
          }
          if (c.p.op === 'campaigns') {
            const list = await get(`${META()}/${act}/campaigns?${q({ fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time', limit: '200' })}`);
            const money = v => (v == null || v === '' ? null : Number(v) / 100);
            return list.map(x => ({ kampanyaId: x.id, kampanya: x.name, durum: x.status, etkinDurum: x.effective_status, amac: x.objective, gunlukButce: money(x.daily_budget), toplamButce: money(x.lifetime_budget), baslangic: x.start_time ?? null, bitis: x.stop_time ?? null }));
          }
          const [s, e] = range(c.p.dates, R('start'), R('end')); const lv = c.p.level || 'campaign';
          const ids = { account: [], campaign: ['campaign_id', 'campaign_name'], adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'], ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'] }[lv] || [];
          const rows = await get(`${META()}/${act}/insights?${q({ level: lv, fields: [...ids, 'impressions', 'reach', 'clicks', 'spend', 'ctr', 'cpc', 'cpm', 'actions', 'action_values', 'account_currency'].join(','), time_range: JSON.stringify({ since: s, until: e }), time_increment: c.p.daily ? '1' : 'all_days', limit: '500' })}`);
          const acts = a => Object.fromEntries((a || []).map(x => [x.action_type, Number(x.value)]));
          return rows.map(x => {
            const a = acts(x.actions), v = acts(x.action_values);
            const purchase = a['purchase'] ?? a['offsite_conversion.fb_pixel_purchase'] ?? a['omni_purchase'] ?? 0;
            const value = v['purchase'] ?? v['offsite_conversion.fb_pixel_purchase'] ?? v['omni_purchase'] ?? 0;
            const spend = Number(x.spend || 0);
            return {
              ...(c.p.daily ? { tarih: x.date_start } : { baslangic: x.date_start, bitis: x.date_stop }),
              ...(x.campaign_id ? { kampanyaId: x.campaign_id, kampanya: x.campaign_name } : {}), ...(x.adset_id ? { reklamSetiId: x.adset_id, reklamSeti: x.adset_name } : {}), ...(x.ad_id ? { reklamId: x.ad_id, reklam: x.ad_name } : {}),
              gosterim: Number(x.impressions || 0), erisim: Number(x.reach || 0), tiklama: Number(x.clicks || 0), harcama: spend,
              tiklamaOrani: Math.round(Number(x.ctr || 0) * 100) / 100, tbm: Number(x.cpc || 0), bgbm: Number(x.cpm || 0),
              satinAlma: purchase, satisDegeri: value, roas: spend ? Math.round((value / spend) * 100) / 100 : null, eylemler: a, paraBirimi: x.account_currency ?? null, platform: 'Meta',
            };
          });
        });
      },
    },

    /* ================= LinkedIn ================= */
    linkedin: {
      label: 'LinkedIn', cat: 'app', icon: 'linkedin', inputs: 1, outputs: ['main'],
      desc: 'Kendi LinkedIn profilinizde ya da yönettiğiniz şirket sayfasında metin, bağlantı ya da resimli gönderi paylaşır, gönderi siler.',
      params: [
        cred(['linkedinOAuth'], 'LinkedIn hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'post', options: [['post', 'Gönderi paylaş'], ['delete', 'Gönderiyi sil'], ['me', 'Hesap bilgisi']] },
        { key: 'as', label: 'Kim adına', type: 'select', def: 'me', options: [['me', 'Kendi profilim'], ['org', 'Şirket sayfası']], showIf: { op: 'post' } },
        { key: 'orgId', label: 'Şirket sayfası kimliği', type: 'expr', def: '', showIf: { op: 'post', as: 'org' }, help: 'Sayfanın yönetici adresindeki numara: linkedin.com/company/<numara>/admin' },
        { key: 'text', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'post' } },
        { key: 'link', label: 'Bağlantı (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'post' } },
        { key: 'linkTitle', label: 'Bağlantı başlığı', type: 'expr', def: '', showIf: { op: 'post' } },
        { key: 'image', label: 'Resim (dosya adı ya da https adresi, isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'post' }, help: 'Bağlantı ve resim birlikte verilirse resim kullanılır.' },
        { key: 'visibility', label: 'Görünürlük', type: 'select', def: 'PUBLIC', options: [['PUBLIC', 'Herkes'], ['CONNECTIONS', 'Yalnız bağlantılarım']], showIf: { op: 'post', as: 'me' } },
        { key: 'postId', label: 'Gönderi kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'delete' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const tok = await oauth.accessToken(cr);
        // LinkedIn keeps each monthly API version for about a year; use the one from two months ago
        const v = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; })();
        const li = (method, p, opts = {}) => call('LinkedIn', method, /^https?:/.test(p) ? p : `${LI()}${p}`, { token: tok, headers: { 'LinkedIn-Version': v, 'X-Restli-Protocol-Version': '2.0.0', ...(opts.headers || {}) }, ...opts, signal: c.signal });
        let me;
        const userinfo = async () => (me ??= (await li('GET', '/v2/userinfo')).body);
        // LinkedIn reads these characters as markup in post text, so they are escaped to come out as typed
        const little = s => String(s).replace(/[\\|{}@[\]()<>#*_~]/g, ch => `\\${ch}`);
        return forItems(c, async R => {
          if (c.p.op === 'me') { const u = await userinfo(); return { id: u.sub, ad: u.name ?? null, eposta: u.email ?? null, resim: u.picture ?? null, urn: `urn:li:person:${u.sub}` }; }
          if (c.p.op === 'delete') { const id = R('postId'); if (!id) throw new Error('Gönderi kimliği gerekli'); await li('DELETE', `/rest/posts/${encodeURIComponent(id)}`); return { id, silindi: true }; }
          if (!R('text') && !R('link') && !R('image')) throw new Error('Paylaşılacak metin boş');
          const org = c.p.as === 'org'; const orgId = R('orgId').replace(/\D/g, '');
          if (org && !orgId) throw new Error('Şirket sayfası kimliğini yazın');
          const author = org ? `urn:li:organization:${orgId}` : `urn:li:person:${(await userinfo()).sub}`;
          let content;
          const img = await media(R('image'), c.signal);
          if (img) {
            if (!/^image\//.test(img.type)) throw new Error(`Resim dosyası değil: ${img.name}`);
            const init = (await li('POST', '/rest/images?action=initializeUpload', { body: { initializeUploadRequest: { owner: author } } })).body.value;
            await call('LinkedIn', 'PUT', init.uploadUrl, { token: tok, body: img.buf, raw: true, headers: { 'Content-Type': img.type }, signal: c.signal, timeout: 300000 });
            content = { media: { id: init.image, altText: R('linkTitle') || '' } };
          } else if (R('link')) content = { article: { source: R('link'), title: R('linkTitle') || R('link') } };
          const body = { author, commentary: little(R('text')), visibility: org ? 'PUBLIC' : (c.p.visibility || 'PUBLIC'), distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false, ...(content ? { content } : {}) };
          const r = await li('POST', '/rest/posts', { body });
          const id = r.headers['x-restli-id'] || r.headers['x-linkedin-id'] || r.body?.id || null;
          return { id, url: id ? `https://www.linkedin.com/feed/update/${id}` : null, yazar: author, metin: R('text') };
        });
      },
    },

    /* ================= X (Twitter) ================= */
    x: {
      label: 'X (Twitter)', cat: 'app', icon: 'xlogo', inputs: 1, outputs: ['main'],
      desc: 'X hesabınızdan gönderi (tweet) paylaşır, resim ekler, yanıt yazar, gönderi siler; hesabınızın ve başkalarının son gönderilerini, aramayı getirir. Okuma işlemleri X\'in ücretli API planlarını gerektirebilir.',
      params: [
        cred(['xOAuth'], 'X hesabı'),
        { key: 'op', label: 'İşlem', type: 'select', def: 'post', options: [['post', 'Gönderi paylaş'], ['delete', 'Gönderiyi sil'], ['me', 'Hesap bilgisi'], ['timeline', 'Bir hesabın son gönderileri'], ['search', 'Son 7 günde ara']] },
        { key: 'text', label: 'Metin', type: 'textarea', def: '{{ $json.metin }}', showIf: { op: 'post' }, help: 'En fazla 280 karakter (X Premium hesaplarda daha uzun).' },
        { key: 'image', label: 'Resim (dosya adı ya da https adresi, isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'post' } },
        { key: 'replyTo', label: 'Yanıtlanacak gönderi kimliği (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'post' } },
        { key: 'postId', label: 'Gönderi kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'delete' } },
        { key: 'username', label: 'Kullanıcı adı (boş = ben)', type: 'expr', def: '', showIf: { op: 'timeline' } },
        { key: 'query', label: 'Arama', type: 'expr', def: '', showIf: { op: 'search' }, help: 'X arama sözdizimi, ör. "markam -is:retweet lang:tr".' },
        { key: 'max', label: 'En fazla', type: 'number', def: 10, min: 5, showIf: { op: ['timeline', 'search'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential); const tok = await oauth.accessToken(cr);
        const xc = (method, p, opts = {}) => call('X', method, `${X()}${p}`, { token: tok, ...opts, signal: c.signal }).then(r => r.body);
        const fields = { 'tweet.fields': 'created_at,public_metrics,author_id,conversation_id,lang', expansions: 'author_id', 'user.fields': 'username,name' };
        const posts = r => { const users = Object.fromEntries((r.includes?.users || []).map(u => [u.id, u])); return (r.data || []).map(t => ({ id: t.id, metin: t.text, tarih: t.created_at ?? null, yazar: users[t.author_id]?.username ?? null, yazarAdi: users[t.author_id]?.name ?? null, yazarId: t.author_id ?? null, begeni: t.public_metrics?.like_count ?? null, yanit: t.public_metrics?.reply_count ?? null, paylasim: t.public_metrics?.retweet_count ?? null, goruntulenme: t.public_metrics?.impression_count ?? null, dil: t.lang ?? null, url: `https://x.com/${users[t.author_id]?.username || 'i/web'}/status/${t.id}` })); };
        const max = String(clamp(c.p.max, 5, 100, 10));
        return forItems(c, async R => {
          if (c.p.op === 'me') { const u = (await xc('GET', '/2/users/me?user.fields=public_metrics,description,created_at')).data; return { id: u.id, kullaniciAdi: u.username, ad: u.name, aciklama: u.description ?? null, takipci: u.public_metrics?.followers_count ?? null, takip: u.public_metrics?.following_count ?? null, gonderi: u.public_metrics?.tweet_count ?? null }; }
          if (c.p.op === 'delete') { const id = R('postId'); if (!id) throw new Error('Gönderi kimliği gerekli'); const r = await xc('DELETE', `/2/tweets/${encodeURIComponent(id)}`); return { id, silindi: !!r.data?.deleted }; }
          if (c.p.op === 'search') { if (!R('query')) throw new Error('Arama metni boş'); return posts(await xc('GET', `/2/tweets/search/recent?${q({ query: R('query'), max_results: max, ...fields })}`)); }
          if (c.p.op === 'timeline') {
            const u = R('username').replace(/^@/, '');
            const id = u ? (await xc('GET', `/2/users/by/username/${encodeURIComponent(u)}`)).data.id : (await xc('GET', '/2/users/me')).data.id;
            return posts(await xc('GET', `/2/users/${id}/tweets?${q({ max_results: max, exclude: 'retweets', ...fields })}`));
          }
          if (!R('text') && !R('image')) throw new Error('Paylaşılacak metin boş');
          const body = { ...(R('text') ? { text: R('text') } : {}) };
          const img = await media(R('image'), c.signal);
          if (img) {
            if (!/^image\//.test(img.type)) throw new Error(`Resim dosyası değil: ${img.name}`);
            const fd = new FormData(); fd.append('media', new Blob([img.buf], { type: img.type }), img.name); fd.append('media_category', img.type === 'image/gif' ? 'tweet_gif' : 'tweet_image'); fd.append('media_type', img.type);
            const r = await call('X', 'POST', `${X()}/2/media/upload`, { token: tok, body: fd, raw: true, signal: c.signal, timeout: 300000 });
            const mid = r.body?.data?.id || r.body?.media_id_string; if (!mid) throw new Error('X resmi kabul etmedi');
            body.media = { media_ids: [String(mid)] };
          }
          if (R('replyTo')) body.reply = { in_reply_to_tweet_id: R('replyTo') };
          const r = await xc('POST', '/2/tweets', { body });
          return { id: r.data.id, metin: r.data.text, url: `https://x.com/i/web/status/${r.data.id}`, ...(body.reply ? { yanitlanan: R('replyTo') } : {}) };
        });
      },
    },
  };

  async function test(type, d) {
    if (type === 'metaAds') {
      const act = `act_${String(d.adAccountId || '').replace(/^act_/, '').trim()}`;
      const r = (await call('Meta', 'GET', `${META()}/${act}?fields=name,currency,account_status`, { token: d.token })).body;
      return `Reklam hesabı: ${r.name} (${r.currency})${r.account_status === 1 ? '' : '; hesap etkin değil'}`;
    }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test };
};
