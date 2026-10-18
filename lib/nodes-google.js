'use strict';
/* Google nodes that sign in with OAuth ("Google hesabı" credential): Gmail, Gmail trigger, Drive, Calendar.
   Merged into NODES by nodes.js. N8N8_GOOGLE_API points every Google API host at one base URL (tests). */
const fs = require('fs');
const path = require('path');
const oauth = require('./oauth');
const { buildMessage } = require('./smtp');

module.exports = function googleNodes(h) {
  const { httpRequest, safeFile } = h;
  const base = host => process.env.N8N8_GOOGLE_API || `https://${host}`;
  const GMAIL = () => `${base('gmail.googleapis.com')}/gmail/v1/users/me`;
  const DRIVE = () => `${base('www.googleapis.com')}/drive/v3`;
  const UPLOAD = () => `${base('www.googleapis.com')}/upload/drive/v3`;
  const CAL = () => `${base('www.googleapis.com')}/calendar/v3`;
  const credParam = { key: 'credential', label: 'Google hesabı', type: 'credential', credTypes: ['googleOAuth'], def: '' };
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];

  /* authorised JSON call; Google's error message is passed through in Turkish context */
  async function gcall(cred, method, url, { body, headers = {}, raw = false, signal, what = 'Google' } = {}) {
    const token = await oauth.accessToken(cred);
    const r = await httpRequest({ method, url, headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !raw ? JSON.stringify(body) : body, signal, timeout: 60000 });
    if (!r.ok) {
      const msg = r.body?.error?.message || (typeof r.body === 'string' ? r.body.slice(0, 200) : '') || '';
      throw new Error(`${what} (${r.status}): ${r.status === 401 ? 'oturum geçersiz; kimlik bilgisinde "Hesaba bağlan" ile yeniden bağlanın' : r.status === 403 ? `izin yok. ${msg}` : msg || 'hata'}`);
    }
    return r.body;
  }
  const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

  /* ---------- Gmail message parsing ---------- */
  const b64d = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  function partsOf(p, out = []) { if (!p) return out; out.push(p); for (const x of p.parts || []) partsOf(x, out); return out; }
  function mailJson(m) {
    const hd = Object.fromEntries((m.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    const parts = partsOf(m.payload);
    const text = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
    const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
    const files = parts.filter(p => p.filename).map(p => ({ ad: p.filename, tur: p.mimeType, boyut: p.body?.size || 0, ekId: p.body?.attachmentId }));
    return {
      id: m.id, konuId: m.threadId, kimden: hd.from || '', kime: hd.to || '', konu: hd.subject || '', tarih: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : hd.date || '',
      ozet: m.snippet || '', metin: text ? b64d(text.body.data) : html ? b64d(html.body.data).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      ...(html ? { html: b64d(html.body.data) } : {}), etiketler: m.labelIds || [], okunmadi: (m.labelIds || []).includes('UNREAD'), ekler: files,
    };
  }
  async function listMail(cred, query, max, signal) {
    const l = await gcall(cred, 'GET', `${GMAIL()}/messages?${q({ q: query, maxResults: Math.min(500, Math.max(1, Number(max) || 10)) })}`, { signal, what: 'Gmail' });
    const out = [];
    for (const { id } of l.messages || []) out.push(mailJson(await gcall(cred, 'GET', `${GMAIL()}/messages/${encodeURIComponent(id)}?format=full`, { signal, what: 'Gmail' })));
    return out;
  }

  const NODES = {
    gmail: {
      label: 'Gmail', cat: 'app', icon: 'mail', inputs: 1, outputs: ['main'],
      desc: 'Gmail hesabınızdan e-posta gönderir, e-postaları arar ve okur, okundu işaretler ya da çöpe atar.',
      params: [
        credParam,
        { key: 'op', label: 'İşlem', type: 'select', def: 'send', options: [['send', 'E-posta gönder'], ['list', 'E-postaları ara ve oku'], ['read', 'Okundu işaretle'], ['unread', 'Okunmadı işaretle'], ['trash', 'Çöpe at']] },
        { key: 'to', label: 'Alıcı', type: 'expr', def: '{{ $json.eposta }}', showIf: { op: 'send' } },
        { key: 'cc', label: 'Bilgi (CC)', type: 'expr', def: '', showIf: { op: 'send' } },
        { key: 'subject', label: 'Konu', type: 'expr', def: 'Merhaba {{ $json.ad }}', showIf: { op: 'send' } },
        { key: 'format', label: 'Biçim', type: 'select', def: 'text', options: [['text', 'Düz metin'], ['html', 'HTML']], showIf: { op: 'send' } },
        { key: 'body', label: 'İleti', type: 'textarea', def: 'Merhaba {{ $json.ad }},\n\nMesajınızı aldık.\n\nSevgiler', showIf: { op: 'send' } },
        { key: 'threadId', label: 'Yanıt olarak gönder (konu kimliği, isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'send' } },
        { key: 'query', label: 'Arama', type: 'expr', def: 'is:unread in:inbox', showIf: { op: 'list' }, help: 'Gmail arama kutusundaki gibi: from:ali@x.com, subject:fatura, has:attachment, newer_than:2d' },
        { key: 'max', label: 'En fazla e-posta', type: 'number', def: 10, min: 1, showIf: { op: 'list' } },
        { key: 'messageId', label: 'E-posta kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['read', 'unread', 'trash'] } },
      ],
      sub: '{op}',
      async run(c) {
        const cred = await c.credential(c.p.credential);
        const items = c.items.length ? c.items : [{ json: {} }];
        if (c.p.op === 'list') return [(await listMail(cred, c.R(c.p.query, items[0], 0), c.p.max, c.signal)).map(json => ({ json }))];
        const out = [];
        for (let i = 0; i < items.length; i++) {
          c.checkAbort(); const it = items[i];
          if (c.p.op === 'send') {
            const to = String(c.R(c.p.to, it, i) || '').trim(); if (!to) throw new Error(`${i + 1}. öğede alıcı boş`);
            const body = String(c.R(c.p.body, it, i) ?? '');
            const mime = buildMessage({ from: 'me', to, cc: c.R(c.p.cc, it, i) || '', subject: String(c.R(c.p.subject, it, i) ?? ''), ...(c.p.format === 'html' ? { html: body } : { text: body }) }).replace(/^From: me\r\n/, '');
            const threadId = String(c.R(c.p.threadId, it, i) || '');
            const r = await gcall(cred, 'POST', `${GMAIL()}/messages/send`, { body: { raw: Buffer.from(mime).toString('base64url'), ...(threadId ? { threadId } : {}) }, signal: c.signal, what: 'Gmail' });
            out.push({ json: { gonderildi: true, id: r.id, konuId: r.threadId, alici: to } });
          } else {
            const id = String(c.R(c.p.messageId, it, i) || ''); if (!id) throw new Error(`${i + 1}. öğede e-posta kimliği yok`);
            const url = c.p.op === 'trash' ? `${GMAIL()}/messages/${encodeURIComponent(id)}/trash` : `${GMAIL()}/messages/${encodeURIComponent(id)}/modify`;
            await gcall(cred, 'POST', url, { body: c.p.op === 'trash' ? {} : c.p.op === 'read' ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }, signal: c.signal, what: 'Gmail' });
            out.push({ json: { ...it.json, id, islem: { read: 'okundu', unread: 'okunmadı', trash: 'çöpe atıldı' }[c.p.op] } });
          }
        }
        return [out];
      },
    },

    gmailTrigger: {
      label: 'Gmail\'e e-posta gelince', cat: 'trigger', icon: 'mail', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Akış etkinken Gmail\'i düzenli kontrol eder; aramaya uyan her yeni e-posta için akışı çalıştırır. İlk kontrolde mevcut e-postalar yalnızca hatırlanır.',
      params: pollParams(1, 'm', [credParam, { key: 'query', label: 'Arama', type: 'text', def: 'in:inbox', help: 'Örnek: from:siparis@magaza.com ya da subject:fatura' }]),
      sub: '{query}',
      async poll(c) {
        const cred = await c.credential(c.p.credential);
        const mails = await listMail(cred, c.p.query, 25);
        const mem = c.memory(); const first = !mem.seen; const seen = new Set(mem.seen || []);
        const fresh = mails.filter(m => !seen.has(m.id));
        mem.seen = [...new Set([...mails.map(m => m.id), ...seen])].slice(0, 3000); c.saveMemory();
        return first ? [] : fresh.reverse();
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        if (!c.p.credential) return [[{ json: { id: 'ornek', kimden: 'Ayşe <ayse@ornek.com>', konu: 'Sipariş hakkında', metin: 'Merhaba, siparişim ne zaman gelir?', tarih: new Date().toISOString() } }]];
        return [(await listMail(await c.credential(c.p.credential), c.p.query, 1, c.signal)).map(json => ({ json }))];
      },
      eachItem: true,
    },

    drive: {
      label: 'Google Drive', cat: 'app', icon: 'folder', inputs: 1, outputs: ['main'],
      desc: 'Drive\'da dosya arar, metin ya da dosya klasöründen dosya yükler, dosyayı indirir, klasör oluşturur ya da çöpe atar.',
      params: [
        credParam,
        { key: 'op', label: 'İşlem', type: 'select', def: 'list', options: [['list', 'Dosyaları listele / ara'], ['upload', 'Dosya yükle'], ['download', 'Dosya indir'], ['folder', 'Klasör oluştur'], ['delete', 'Çöpe at']] },
        { key: 'search', label: 'Adında geçen (boş = hepsi)', type: 'expr', def: '', showIf: { op: 'list' } },
        { key: 'parent', label: 'Klasör kimliği (boş = Drive\'ım)', type: 'expr', def: '', showIf: { op: ['list', 'upload', 'folder'] } },
        { key: 'max', label: 'En fazla dosya', type: 'number', def: 50, min: 1, showIf: { op: 'list' } },
        { key: 'name', label: 'Ad', type: 'expr', def: 'rapor-{{ $today }}.txt', showIf: { op: ['upload', 'folder'] } },
        { key: 'source', label: 'İçerik', type: 'select', def: 'text', options: [['text', 'Yazdığım metin'], ['file', 'Dosya klasöründeki bir dosya']], showIf: { op: 'upload' } },
        { key: 'content', label: 'Metin', type: 'textarea', def: '{{ JSON.stringify($json) }}', showIf: { op: 'upload', source: 'text' } },
        { key: 'file', label: 'Dosya adı (~/.8n8/dosyalar içinde)', type: 'expr', def: 'faturalar.csv', showIf: { op: 'upload', source: 'file' } },
        { key: 'fileId', label: 'Dosya kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: ['download', 'delete'] } },
        { key: 'saveAs', label: 'Kaydedilecek ad (boş = Drive\'daki adı)', type: 'expr', def: '', showIf: { op: 'download' }, help: 'Dosya klasörüne kaydedilir. Google Dokümanlar PDF, E-Tablolar CSV olarak iner.' },
      ],
      sub: '{op}',
      async run(c) {
        const cred = await c.credential(c.p.credential);
        const items = c.items.length ? c.items : [{ json: {} }];
        const call = (m, u, o = {}) => gcall(cred, m, u, { ...o, signal: c.signal, what: 'Drive' });
        const FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';
        const fileJson = f => ({ id: f.id, ad: f.name, tur: f.mimeType, boyut: f.size != null ? Number(f.size) : null, degisti: f.modifiedTime, link: f.webViewLink, klasor: f.parents?.[0] });
        if (c.p.op === 'list') {
          const parts = ['trashed = false'];
          const s = String(c.R(c.p.search, items[0], 0) || ''); if (s) parts.push(`name contains '${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
          const p = String(c.R(c.p.parent, items[0], 0) || ''); if (p) parts.push(`'${p.replace(/'/g, '')}' in parents`);
          const r = await call('GET', `${DRIVE()}/files?${q({ q: parts.join(' and '), pageSize: Math.min(1000, Number(c.p.max) || 50), fields: `files(${FIELDS})`, orderBy: 'modifiedTime desc' })}`);
          return [(r.files || []).map(f => ({ json: fileJson(f) }))];
        }
        const out = [];
        for (let i = 0; i < items.length; i++) {
          c.checkAbort(); const it = items[i];
          if (c.p.op === 'folder' || c.p.op === 'upload') {
            const name = String(c.R(c.p.name, it, i) || '').trim() || (c.p.op === 'folder' ? 'Yeni klasör' : 'dosya.txt');
            const parent = String(c.R(c.p.parent, it, i) || '');
            const meta = { name, ...(parent ? { parents: [parent] } : {}), ...(c.p.op === 'folder' ? { mimeType: 'application/vnd.google-apps.folder' } : {}) };
            if (c.p.op === 'folder') { out.push({ json: fileJson(await call('POST', `${DRIVE()}/files?fields=${FIELDS}`, { body: meta })) }); continue; }
            let data;
            if (c.p.source === 'file') { const f = safeFile(String(c.R(c.p.file, it, i) || '')); if (!fs.existsSync(f)) throw new Error(`Dosya bulunamadı: ${path.basename(f)}`); data = fs.readFileSync(f); }
            else { const v = c.R(c.p.content, it, i); data = Buffer.from(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8'); }
            const boundary = `8n8${Date.now().toString(36)}`;
            const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
            out.push({ json: fileJson(await call('POST', `${UPLOAD()}/files?uploadType=multipart&fields=${FIELDS}`, { body, raw: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } })) });
          } else {
            const id = String(c.R(c.p.fileId, it, i) || ''); if (!id) throw new Error(`${i + 1}. öğede dosya kimliği yok`);
            if (c.p.op === 'delete') { await call('PATCH', `${DRIVE()}/files/${encodeURIComponent(id)}`, { body: { trashed: true } }); out.push({ json: { id, cope: true } }); continue; }
            const meta = await call('GET', `${DRIVE()}/files/${encodeURIComponent(id)}?fields=${FIELDS}`);
            const exportAs = { 'application/vnd.google-apps.document': ['application/pdf', '.pdf'], 'application/vnd.google-apps.spreadsheet': ['text/csv', '.csv'], 'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'] }[meta.mimeType];
            const url = exportAs ? `${DRIVE()}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs[0])}` : `${DRIVE()}/files/${encodeURIComponent(id)}?alt=media`;
            const token = await oauth.accessToken(cred);
            const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: c.signal });
            if (!r.ok) throw new Error(`Drive (${r.status}): dosya indirilemedi`);
            const buf = Buffer.from(await r.arrayBuffer());
            const name = String(c.R(c.p.saveAs, it, i) || '') || meta.name + (exportAs && !meta.name.endsWith(exportAs[1]) ? exportAs[1] : '');
            const file = safeFile(name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf);
            out.push({ json: { ...fileJson(meta), dosya: path.basename(file), indirilen: buf.length } });
          }
        }
        return [out];
      },
    },

    calendar: {
      label: 'Google Takvim', cat: 'app', icon: 'calendar', inputs: 1, outputs: ['main'],
      desc: 'Takvimdeki yaklaşan etkinlikleri listeler, yeni etkinlik ekler ya da siler.',
      params: [
        credParam,
        { key: 'calendarId', label: 'Takvim', type: 'text', def: 'primary', help: '"primary" ana takviminizdir. Başka takvimler için takvim ayarlarındaki kimliği yazın.' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'list', options: [['list', 'Yaklaşan etkinlikleri listele'], ['create', 'Etkinlik ekle'], ['delete', 'Etkinliği sil']] },
        { key: 'days', label: 'Kaç gün ileriye', type: 'number', def: 7, min: 1, showIf: { op: 'list' } },
        { key: 'search', label: 'İçinde geçen (boş = hepsi)', type: 'expr', def: '', showIf: { op: 'list' } },
        { key: 'title', label: 'Başlık', type: 'expr', def: '{{ $json.ad }} ile görüşme', showIf: { op: 'create' } },
        { key: 'start', label: 'Başlangıç', type: 'expr', def: '{{ $dt.add($now, 1, "gun") }}', showIf: { op: 'create' }, help: 'Tarih ve saat; ör. 2026-11-03T14:00. Yalnız tarih yazarsanız tüm gün etkinlik olur.' },
        { key: 'minutes', label: 'Süre (dakika)', type: 'number', def: 30, min: 1, showIf: { op: 'create' } },
        { key: 'location', label: 'Konum', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '', showIf: { op: 'create' } },
        { key: 'attendees', label: 'Davetliler (e-posta, virgülle)', type: 'expr', def: '', showIf: { op: 'create' } },
        { key: 'eventId', label: 'Etkinlik kimliği', type: 'expr', def: '{{ $json.id }}', showIf: { op: 'delete' } },
      ],
      sub: '{op} · {calendarId}',
      async run(c) {
        const cred = await c.credential(c.p.credential);
        const cal = `${CAL()}/calendars/${encodeURIComponent(c.p.calendarId || 'primary')}/events`;
        const call = (m, u, o = {}) => gcall(cred, m, u, { ...o, signal: c.signal, what: 'Takvim' });
        const ev = e => ({ id: e.id, baslik: e.summary || '', baslangic: e.start?.dateTime || e.start?.date, bitis: e.end?.dateTime || e.end?.date, tumGun: !!e.start?.date, konum: e.location || '', aciklama: e.description || '', davetliler: (e.attendees || []).map(a => a.email), link: e.htmlLink });
        const items = c.items.length ? c.items : [{ json: {} }];
        if (c.p.op === 'list') {
          const now = new Date();
          const r = await call('GET', `${cal}?${q({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + (Number(c.p.days) || 7) * 864e5).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 250, q: c.R(c.p.search, items[0], 0) || '' })}`);
          return [(r.items || []).map(e => ({ json: ev(e) }))];
        }
        const out = [];
        for (let i = 0; i < items.length; i++) {
          c.checkAbort(); const it = items[i];
          if (c.p.op === 'delete') {
            const id = String(c.R(c.p.eventId, it, i) || ''); if (!id) throw new Error(`${i + 1}. öğede etkinlik kimliği yok`);
            await call('DELETE', `${cal}/${encodeURIComponent(id)}`); out.push({ json: { id, silindi: true } }); continue;
          }
          const startRaw = String(c.R(c.p.start, it, i) || '').trim();
          if (!startRaw) throw new Error(`${i + 1}. öğede başlangıç zamanı boş`);
          const allDay = /^\d{4}-\d{2}-\d{2}$/.test(startRaw);
          const st = new Date(startRaw); if (isNaN(st)) throw new Error(`Geçersiz tarih: ${startRaw}`);
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const end = allDay ? new Date(st.getTime() + 864e5).toISOString().slice(0, 10) : new Date(st.getTime() + (Number(c.p.minutes) || 30) * 60000).toISOString();
          const att = String(c.R(c.p.attendees, it, i) || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
          const body = { summary: String(c.R(c.p.title, it, i) ?? ''), location: String(c.R(c.p.location, it, i) ?? '') || undefined, description: String(c.R(c.p.description, it, i) ?? '') || undefined,
            start: allDay ? { date: startRaw } : { dateTime: st.toISOString(), timeZone: tz }, end: allDay ? { date: end } : { dateTime: end, timeZone: tz }, ...(att.length ? { attendees: att.map(email => ({ email })) } : {}) };
          out.push({ json: ev(await call('POST', `${cal}${att.length ? '?sendUpdates=all' : ''}`, { body })) });
        }
        return [out];
      },
    },
  };
  return { NODES };
};
