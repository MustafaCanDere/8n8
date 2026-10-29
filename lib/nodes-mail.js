'use strict';
/* E-mail over IMAP (any provider: Yandex, Outlook.com, iCloud, Gmail with an app password, company mail)
   and WhatsApp Business (Cloud API). Merged into NODES by nodes.js. N8N8_WHATSAPP_API points WhatsApp at
   another base URL (tests). */
const path = require('path');
const crypto = require('crypto');
const imap = require('./imap');
const { parseMail } = require('./mime');

const CREDENTIAL_TYPES = {
  imap: { label: 'IMAP (gelen e-posta)', fields: [
    { key: 'host', label: 'IMAP sunucusu', def: 'imap.yandex.com.tr', help: 'Örnekler: imap.gmail.com, outlook.office365.com, imap.yandex.com.tr, imap.mail.me.com. Gmail ve iCloud için uygulama şifresi gerekir.' },
    { key: 'port', label: 'Port', def: '993' },
    { key: 'secure', label: 'Doğrudan TLS (993 için evet)', def: 'true', options: [['true', 'Evet'], ['false', 'Hayır (STARTTLS)']] },
    { key: 'user', label: 'Kullanıcı adı (e-posta adresi)' },
    { key: 'password', label: 'Şifre ya da uygulama şifresi', secret: true }] },
  whatsappApi: { label: 'WhatsApp Business (Cloud API)', fields: [
    { key: 'token', label: 'Erişim anahtarı (access token)', secret: true, help: 'developers.facebook.com → uygulamanız → WhatsApp → API Setup. Kalıcı anahtar için Business Settings → System users → Generate token (whatsapp_business_messaging izni).' },
    { key: 'phoneNumberId', label: 'Telefon numarası kimliği (Phone number ID)', help: 'API Setup sayfasında numaranızın altında yazar; telefon numarasının kendisi değildir.' },
    { key: 'verifyToken', label: 'Webhook doğrulama sözcüğü (tetikleyici için)', def: '', help: 'Meta\'da webhook kurarken "Verify token" kutusuna yazacağınız, kendi belirlediğiniz bir sözcük.' },
    { key: 'appSecret', label: 'Uygulama gizli anahtarı (App secret, isteğe bağlı)', secret: true, help: 'Girilirse gelen her bildirimin Meta\'dan geldiği imzadan doğrulanır. App settings → Basic sayfasındadır.' }] },
};

module.exports = function mailNodes(h) {
  const { httpRequest, DIRS } = h;
  const WA = () => process.env.N8N8_WHATSAPP_API || 'https://graph.facebook.com/v25.0';
  const pollParams = (every, unit, extra = []) => [...extra,
    { key: 'every', label: 'Kontrol sıklığı', type: 'number', def: every, min: 1 },
    { key: 'unit', label: 'Birim', type: 'select', def: unit, options: [['s', 'saniye'], ['m', 'dakika'], ['h', 'saat']] }];
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  async function withImap(cred, fn) {
    const cl = await imap.connect(cred.data);
    try { return await fn(cl); } finally { await cl.logout(); }
  }
  function toItem(m, p) {
    const day = new Date().toISOString().slice(0, 10);
    const saveDir = p.attachments ? path.join(DIRS.files, 'eposta-ekleri', day) : null;
    const j = parseMail(m.raw, { saveDir, relBase: `eposta-ekleri/${day}` });
    if (!p.html) delete j.html;
    return { id: m.uid, ...j, okundu: m.flags.some(f => /\\Seen/i.test(f)) };
  }

  /* ---------- WhatsApp ---------- */
  async function wa(cr, body, signal) {
    const r = await httpRequest({ method: 'POST', url: `${WA()}/${encodeURIComponent(cr.data.phoneNumberId)}/messages`, headers: { Authorization: `Bearer ${cr.data.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', ...body }), signal, timeout: 60000 });
    if (!r.ok) {
      const e = r.body?.error || {};
      const hint = e.code === 131047 || /24 hours|re-engagement/i.test(e.message || '') ? ' (müşteri son 24 saatte size yazmadıysa yalnızca onaylı şablon mesajı gönderilebilir)' : e.code === 190 ? ' (erişim anahtarı geçersiz ya da süresi dolmuş)' : '';
      throw new Error(`WhatsApp (${r.status}): ${e.error_user_msg || e.message || 'hata'}${hint}`);
    }
    return r.body;
  }
  const phone = v => String(v ?? '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(5\d{9})$/, '90$1');

  const NODES = {
    emailTrigger: {
      label: 'E-posta gelince (IMAP)', cat: 'trigger', icon: 'mail', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'Her e-posta sağlayıcısıyla çalışır (Yandex, Outlook, iCloud, şirket postası, uygulama şifresiyle Gmail). Akış etkinken klasörü düzenli kontrol eder; her yeni e-posta için akışı çalıştırır. İlk kontrolde mevcut e-postalar yalnızca hatırlanır.',
      params: pollParams(1, 'm', [
        { key: 'credential', label: 'IMAP hesabı', type: 'credential', credTypes: ['imap'], def: '' },
        { key: 'mailbox', label: 'Klasör', type: 'text', def: 'INBOX', help: 'Gelen kutusu için INBOX. Alt klasörler sunucuya göre "INBOX/Faturalar" ya da "INBOX.Faturalar" biçimindedir.' },
        { key: 'from', label: 'Yalnızca bu göndericiden (isteğe bağlı)', type: 'text', def: '', help: 'Adresin ya da alan adının bir parçası, örneğin @tedarikci.com' },
        { key: 'subject', label: 'Konuda geçen (isteğe bağlı)', type: 'text', def: '' },
        { key: 'attachments', label: 'Ekleri dosya klasörüne kaydet', type: 'toggle', def: true, help: 'Ekler dosyalar/eposta-ekleri/<tarih>/ altına kaydedilir; öğede ekler[].dosya olarak görünür.' },
        { key: 'markSeen', label: 'İşlenen e-postaları okundu işaretle', type: 'toggle', def: false },
        { key: 'html', label: 'HTML gövdesini de ekle', type: 'toggle', def: false },
      ]),
      sub: '{mailbox}',
      async poll(c) {
        const cred = await c.credential(c.p.credential);
        return withImap(cred, async cl => {
          const box = await cl.select(c.p.mailbox || 'INBOX');
          const mem = c.memory();
          if (!mem.uidValidity || mem.uidValidity !== box.uidValidity) { // first check (or the mailbox was rebuilt): remember where we are
            const all = box.uidNext ? [] : await cl.search('ALL');
            mem.uidValidity = box.uidValidity; mem.lastUid = box.uidNext ? box.uidNext - 1 : Math.max(0, ...all); c.saveMemory();
            return [];
          }
          const uids = (await cl.search(`UID ${mem.lastUid + 1}:*`)).filter(u => u > mem.lastUid).sort((a, b) => a - b).slice(0, 25);
          if (!uids.length) return [];
          const msgs = await cl.fetch(uids);
          mem.lastUid = Math.max(mem.lastUid, ...uids); c.saveMemory();
          const items = msgs.sort((a, b) => a.uid - b.uid).map(m => toItem(m, c.p)).filter(m =>
            (!c.p.from || m.kimden.toLocaleLowerCase('tr').includes(String(c.p.from).toLocaleLowerCase('tr'))) && (!c.p.subject || m.konu.toLocaleLowerCase('tr').includes(String(c.p.subject).toLocaleLowerCase('tr'))));
          if (c.p.markSeen && items.length) await cl.addFlags(items.map(m => m.id), '\\Seen');
          return items;
        });
      },
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        if (!c.p.credential) return [[{ json: { id: 1, kimden: 'Ayşe Yılmaz <ayse@ornek.com>', kime: 'siz@ornek.com', konu: 'Fatura', metin: 'Merhaba, ekte faturamız var.', tarih: new Date().toISOString(), ekler: [], okundu: false } }]];
        // editor test: the newest e-mail
        const cred = await c.credential(c.p.credential);
        return [await withImap(cred, async cl => { const box = await cl.select(c.p.mailbox || 'INBOX'); const uids = (await cl.search('ALL')).slice(-1); return (await cl.fetch(uids)).map(m => ({ json: toItem(m, c.p) })); }).then(x => x.length ? x : [{ json: { uyari: `${c.p.mailbox || 'INBOX'} klasörü boş` } }])];
      },
      eachItem: true,
    },

    whatsapp: {
      label: 'WhatsApp', cat: 'app', icon: 'chat', inputs: 1, outputs: ['main'],
      desc: 'WhatsApp Business (Cloud API) ile mesaj, onaylı şablon mesajı, belge ya da resim gönderir; gelen mesajı okundu işaretler. Müşteri size son 24 saatte yazmadıysa yalnızca şablon mesajı gönderilebilir.',
      params: [
        { key: 'credential', label: 'WhatsApp hesabı', type: 'credential', credTypes: ['whatsappApi'], def: '' },
        { key: 'op', label: 'İşlem', type: 'select', def: 'text', options: [['text', 'Mesaj gönder'], ['template', 'Şablon mesajı gönder'], ['document', 'Belge gönder (bağlantıdan)'], ['image', 'Resim gönder (bağlantıdan)'], ['read', 'Okundu işaretle']] },
        { key: 'to', label: 'Alıcı numarası', type: 'expr', def: '{{ $json.kimden }}', showIf: { op: ['text', 'template', 'document', 'image'] }, help: 'Ülke koduyla: 905321234567. 0532… biçimi de Türkiye numarası olarak çevrilir.' },
        { key: 'text', label: 'Mesaj', type: 'textarea', def: 'Merhaba {{ $json.ad }}, mesajınızı aldık.', showIf: { op: 'text' } },
        { key: 'replyTo', label: 'Yanıtlanan mesaj (isteğe bağlı)', type: 'expr', def: '', showIf: { op: 'text' }, help: 'Gelen mesajın kimliği ({{ $json.mesajId }}) verilirse mesaj ona yanıt olarak görünür.' },
        { key: 'template', label: 'Şablon adı', type: 'text', def: 'hello_world', showIf: { op: 'template' } },
        { key: 'language', label: 'Şablon dili', type: 'text', def: 'tr', showIf: { op: 'template' } },
        { key: 'params', label: 'Şablon değişkenleri ({{1}}, {{2}}… sırasıyla, virgülle)', type: 'expr', def: '', showIf: { op: 'template' } },
        { key: 'link', label: 'Dosya bağlantısı (https)', type: 'expr', def: '', showIf: { op: ['document', 'image'] } },
        { key: 'caption', label: 'Açıklama', type: 'expr', def: '', showIf: { op: ['document', 'image'] } },
        { key: 'filename', label: 'Dosya adı', type: 'expr', def: 'belge.pdf', showIf: { op: 'document' } },
        { key: 'messageId', label: 'Mesaj kimliği', type: 'expr', def: '{{ $json.mesajId }}', showIf: { op: 'read' } },
      ],
      sub: '{op}',
      async run(c) {
        const cr = await c.credential(c.p.credential);
        const items = c.items.length ? c.items : [{ json: {} }]; const out = [];
        for (let i = 0; i < items.length; i++) {
          c.checkAbort(); const it = items[i]; const R = k => str(c.R(c.p[k], it, i)).trim();
          if (c.p.op === 'read') { await wa(cr, { status: 'read', message_id: R('messageId') }, c.signal); out.push({ json: { ...it.json, okundu: true } }); continue; }
          const to = phone(R('to')); if (!to) throw new Error(`${i + 1}. öğede alıcı numarası boş`);
          let body;
          if (c.p.op === 'text') { const t = R('text'); if (!t) throw new Error('Mesaj boş'); body = { to, type: 'text', text: { body: t.slice(0, 4096), preview_url: true }, ...(R('replyTo') ? { context: { message_id: R('replyTo') } } : {}) }; }
          else if (c.p.op === 'template') {
            const ps = R('params') ? R('params').split(',').map(s => s.trim()) : [];
            body = { to, type: 'template', template: { name: c.p.template, language: { code: c.p.language || 'tr' }, ...(ps.length ? { components: [{ type: 'body', parameters: ps.map(text => ({ type: 'text', text })) }] } : {}) } };
          } else {
            const link = R('link'); if (!/^https:\/\//.test(link)) throw new Error('Dosya bağlantısı https:// ile başlamalı (WhatsApp dosyayı bu adresten indirir)');
            body = { to, type: c.p.op, [c.p.op]: { link, ...(R('caption') ? { caption: R('caption') } : {}), ...(c.p.op === 'document' ? { filename: R('filename') || 'belge' } : {}) } };
          }
          const r = await wa(cr, body, c.signal);
          out.push({ json: { gonderildi: true, mesajId: r.messages?.[0]?.id, alici: r.contacts?.[0]?.wa_id || to } });
        }
        return [out];
      },
    },

    whatsappTrigger: {
      label: 'WhatsApp mesajı gelince', cat: 'trigger', icon: 'chat', trigger: true, inputs: 0, outputs: ['main'],
      desc: 'WhatsApp Business numaranıza gelen her mesajda akışı çalıştırır. Meta\'nın bildirim gönderebilmesi için program internetten erişilebilir olmalı (N8N8_URL ve bir tünel); webhook adresini ve doğrulama sözcüğünü Meta\'daki WhatsApp → Configuration sayfasına girin.',
      params: [
        { key: 'credential', label: 'WhatsApp hesabı', type: 'credential', credTypes: ['whatsappApi'], def: '' },
        { key: 'path', label: 'Yol', type: 'text', def: 'whatsapp', help: 'Webhook adresi: /whatsapp/<yol>' },
        { key: 'statuses', label: 'İletildi/okundu bildirimlerinde de çalış', type: 'toggle', def: false },
      ],
      sub: '/whatsapp/{path}',
      async run(c) {
        if (c.trigger?.items) return [c.trigger.items.map(json => ({ json }))];
        return [[{ json: { kimden: '905321234567', ad: 'Ayşe Yılmaz', mesaj: 'Merhaba, siparişim ne durumda?', tur: 'text', mesajId: 'wamid.ornek', zaman: new Date().toISOString(), oturum: 'wa-905321234567' } }]];
      },
      eachItem: true,
    },
  };

  /* WhatsApp webhook body -> items */
  function whatsappItems(body, { statuses = false } = {}) {
    const out = [];
    for (const e of body?.entry || []) for (const ch of e.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name || '']));
      for (const m of v.messages || []) {
        const t = m.type;
        const media = ['image', 'document', 'audio', 'video', 'sticker'].includes(t) ? m[t] : null;
        out.push({
          kimden: m.from, ad: names[m.from] || '', mesaj: t === 'text' ? m.text?.body : t === 'button' ? m.button?.text : t === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title) : media?.caption || '',
          tur: t, mesajId: m.id, zaman: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null, oturum: `wa-${m.from}`,
          ...(media ? { medya: { id: media.id, tur: media.mime_type, ad: media.filename } } : {}), ...(t === 'location' ? { konum: m.location } : {}),
          ...(m.context?.id ? { yanitlanan: m.context.id } : {}), numara: v.metadata?.display_phone_number,
        });
      }
      if (statuses) for (const s of v.statuses || []) out.push({ tur: 'durum', durum: s.status, mesajId: s.id, alici: s.recipient_id, zaman: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null, ...(s.errors ? { hata: s.errors.map(x => x.title || x.message).join(', ') } : {}) });
    }
    return out;
  }
  const verifySignature = (raw, header, secret) => {
    if (!secret) return true;
    const want = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    const a = Buffer.from(String(header || '')), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  async function test(type, d) {
    if (type === 'imap') { const cl = await imap.connect(d, { timeout: 15000 }); try { const b = await cl.select('INBOX'); return `Giriş yapıldı; gelen kutusunda ${b.exists} e-posta var`; } finally { await cl.logout(); } }
    if (type === 'whatsappApi') {
      const r = await httpRequest({ url: `${WA()}/${encodeURIComponent(d.phoneNumberId)}?fields=display_phone_number,verified_name`, headers: { Authorization: `Bearer ${d.token}` }, timeout: 15000 });
      if (!r.ok) throw new Error(`WhatsApp (${r.status}): ${r.body?.error?.message || 'hata'}`);
      return `Bağlanıldı: ${r.body.verified_name || ''} ${r.body.display_phone_number || ''}`.trim();
    }
    return undefined;
  }

  return { NODES, CREDENTIAL_TYPES, test, whatsappItems, verifySignature };
};
