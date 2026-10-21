'use strict';
/* File-producing nodes: PDF oluştur, ZIP (sıkıştır / aç), Takvim daveti (.ics). Files go to the files folder and
   are returned as { dosya } so the e-mail, Telegram and other nodes can send them. Merged into NODES by nodes.js. */
const fs = require('fs');
const path = require('path');

module.exports = function fileNodes(h) {
  const { safeFile, DIRS } = h;
  const str = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rel = f => path.relative(DIRS.files, f).split(path.sep).join('/');
  const save = (relName, data) => { const f = safeFile(relName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  const stamp = () => `${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const withExt = (name, ext) => (new RegExp(`\\.${ext}$`, 'i').test(name) ? name : `${name}.${ext}`);
  const cell = v => (v == null ? '' : typeof v === 'number' ? v.toLocaleString('tr-TR', { maximumFractionDigits: 2 }) : typeof v === 'boolean' ? (v ? 'evet' : 'hayır') : typeof v === 'object' ? JSON.stringify(v) : String(v));

  const NODES = {
    pdfCreate: {
      label: 'PDF oluştur', cat: 'data', icon: 'file', inputs: 1, outputs: ['main'],
      desc: 'Başlık, metin, madde listesi, tablo ve resimden (QR kod, logo) PDF belgesi üretir: fatura, teklif, rapor, sertifika. Türkçe karakterler desteklenir. Dosya, e-posta ya da Telegram ile gönderilebilir.',
      params: [
        { key: 'mode', label: 'Kaç PDF', type: 'select', def: 'each', options: [['each', 'Her öğe için ayrı PDF'], ['all', 'Bütün öğeler tek PDF (tablo halinde)']] },
        { key: 'title', label: 'Başlık', type: 'expr', def: 'Teklif - {{ $json.musteri }}' },
        { key: 'content', label: 'İçerik', type: 'textarea', def: 'Sayın {{ $json.musteri }},\n\nTalebiniz için teklifimiz aşağıdadır.\n\n## Koşullar\n- Fiyatlara KDV dahildir.\n- Teklif 15 gün geçerlidir.', help: '# başlık, ## alt başlık, - madde, --- çizgi, [sayfa] yeni sayfa, **kalın paragraf**. Boş satır yeni paragraf başlatır.' },
        { key: 'tableField', label: 'Tablo verisi (isteğe bağlı)', type: 'expr', def: '', showIf: { mode: 'each' }, help: 'Öğedeki bir liste, örneğin {{ $json.urunler }}. Her satır bir nesne olmalı.' },
        { key: 'columns', label: 'Tablo sütunları (alan:Başlık, virgülle)', type: 'text', def: '', help: 'Örnek: ad:Ürün, adet:Adet, fiyat:Birim fiyat. Boş = bütün alanlar.' },
        { key: 'total', label: 'Tablo altı satırı (isteğe bağlı)', type: 'expr', def: '', help: 'Örnek: Toplam: {{ $json.tutar }} TL' },
        { key: 'image', label: 'Resim (isteğe bağlı)', type: 'expr', def: '', help: 'Dosya klasöründeki PNG ya da JPEG, örneğin {{ $json.qr.dosya }} ya da logo.png. İçerikten önce konur.' },
        { key: 'imageWidth', label: 'Resim genişliği (pt, 72 pt = 2,54 cm)', type: 'number', def: 120, min: 10 },
        { key: 'imageAlign', label: 'Resim hizası', type: 'select', def: 'left', options: [['left', 'Sol'], ['center', 'Orta'], ['right', 'Sağ']] },
        { key: 'footer', label: 'Alt bilgi', type: 'expr', def: '' },
        { key: 'pageSize', label: 'Sayfa', type: 'select', def: 'A4', options: [['A4', 'A4'], ['Letter', 'Letter (ABD)']] },
        { key: 'landscape', label: 'Yatay sayfa', type: 'toggle', def: false },
        { key: 'fontSize', label: 'Yazı boyutu', type: 'number', def: 10.5, min: 6, max: 24 },
        { key: 'file', label: 'Dosya adı (boş = otomatik)', type: 'expr', def: '', help: 'Dosya klasörüne göre, örneğin teklifler/{{ $json.no }}.pdf' },
      ],
      sub: '{mode}',
      async run(c) {
        const G = require('./pdfgen');
        const cols = rows => {
          const spec = str(c.p.columns).split(',').map(x => x.trim()).filter(Boolean);
          if (spec.length) return spec.map(x => { const [k, ...l] = x.split(':'); return { key: k.trim(), label: (l.join(':') || k).trim() }; });
          return [...new Set(rows.flatMap(r => Object.keys(r)))].slice(0, 12).map(k => ({ key: k, label: k }));
        };
        const tableOf = (rows, total) => { const cs = cols(rows); return { type: 'table', columns: cs, rows: rows.map(r => Object.fromEntries(cs.map(x => [x.key, cell(r[x.key])]))), total }; };
        const make = (it, i, rows) => {
          const R = k => str(c.R(c.p[k], it, i));
          const blocks = [];
          const img = R('image').trim();
          if (img) { const f = safeFile(img); if (!fs.existsSync(f)) throw new Error(`Resim bulunamadı: ${img}`); blocks.push({ type: 'image', image: fs.readFileSync(f), width: Number(c.p.imageWidth) || 120, align: c.p.imageAlign }); }
          blocks.push(...G.parseMarkup(R('content')));
          if (rows) blocks.push(tableOf(rows.map(r => (r && typeof r === 'object' ? r : { deger: r })), R('total').trim()));
          const { buffer, pages } = G.build({ title: R('title').trim(), blocks, footer: R('footer').trim(), pageSize: c.p.pageSize, landscape: !!c.p.landscape, fontSize: c.p.fontSize });
          const name = R('file').trim(); const f = save(name ? withExt(name, 'pdf') : `pdf/${stamp()}-${i}.pdf`, buffer);
          return { dosya: rel(f), sayfa: pages, bayt: buffer.length };
        };
        if (c.p.mode === 'all') {
          const it0 = c.items[0] || { json: {} };
          return [[{ json: { pdf: make(it0, 0, c.items.map(x => x.json)), adet: c.items.length } }]];
        }
        return [c.items.map((it, i) => {
          c.checkAbort();
          let rows = null;
          if (str(c.p.tableField).trim()) { rows = c.R(c.p.tableField, it, i); if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = null; } } if (!Array.isArray(rows)) throw new Error(`${i + 1}. öğede tablo verisi liste değil`); }
          return { json: { ...it.json, pdf: make(it, i, rows) } };
        })];
      },
    },

    compression: {
      label: 'ZIP (sıkıştır / aç)', cat: 'data', icon: 'stack', inputs: 1, outputs: ['main'],
      desc: 'Dosya klasöründeki dosyaları tek ZIP dosyasında toplar ya da bir ZIP dosyasını açar. Açılan her dosya ayrı öğe olur.',
      params: [
        { key: 'op', label: 'İşlem', type: 'select', def: 'zip', options: [['zip', 'Sıkıştır (ZIP oluştur)'], ['unzip', 'Aç']] },
        { key: 'files', label: 'Dosyalar', type: 'expr', def: '{{ $json.pdf.dosya }}', showIf: { op: 'zip' }, help: 'Her öğeden alınır; bir öğede virgülle birden çok dosya da yazılabilir. Bütün öğelerin dosyaları tek ZIP\'e girer.' },
        { key: 'output', label: 'ZIP dosya adı', type: 'expr', def: 'arsiv/{{ $dt.format($now, "YYYY-MM-DD") }}.zip', showIf: { op: 'zip' } },
        { key: 'file', label: 'ZIP dosyası', type: 'expr', def: '{{ $json.dosya }}', showIf: { op: 'unzip' } },
        { key: 'folder', label: 'Açılacak klasör (boş = ZIP ile aynı adda)', type: 'expr', def: '', showIf: { op: 'unzip' } },
      ],
      sub: '{op}',
      async run(c) {
        const Z = require('./zip');
        if (c.p.op === 'unzip') {
          const out = [];
          for (let i = 0; i < c.items.length; i++) {
            const it = c.items[i]; const src = str(c.R(c.p.file, it, i)).trim(); const f = safeFile(src);
            if (!fs.existsSync(f)) throw new Error(`ZIP dosyası bulunamadı: ${src}`);
            const dir = str(c.R(c.p.folder, it, i)).trim() || src.replace(/\.zip$/i, '');
            const files = Z.unzip(fs.readFileSync(f));
            for (const [name, get] of Object.entries(files)) {
              if (name.endsWith('/')) continue;
              const target = save(path.posix.join(dir, name.replace(/\\/g, '/').replace(/^(\.\.\/|\/)+/, '')), get());
              out.push({ json: { dosya: rel(target), ad: path.posix.basename(name), bayt: fs.statSync(target).size, zip: src } });
            }
          }
          return [out];
        }
        const files = {}; const used = new Set();
        c.items.forEach((it, i) => {
          for (const x of str(c.R(c.p.files, it, i)).split(',').map(s => s.trim()).filter(Boolean)) {
            const f = safeFile(x); if (!fs.existsSync(f)) throw new Error(`Dosya bulunamadı: ${x}`);
            let name = path.basename(f); for (let k = 2; used.has(name); k++) name = path.basename(f).replace(/(\.[^.]*)?$/, `-${k}$1`);
            used.add(name); files[name] = fs.readFileSync(f);
          }
        });
        if (!Object.keys(files).length) throw new Error('ZIP\'e konacak dosya yok');
        const buf = Z.zip(files); const out = str(c.R(c.p.output, c.items[0] || { json: {} }, 0)).trim() || `arsiv/${stamp()}.zip`;
        const f = save(withExt(out, 'zip'), buf);
        return [[{ json: { dosya: rel(f), adet: Object.keys(files).length, bayt: buf.length, dosyalar: Object.keys(files) } }]];
      },
    },

    ics: {
      label: 'Takvim daveti (.ics)', cat: 'data', icon: 'calendar', inputs: 1, outputs: ['main'],
      desc: 'Toplantı ya da randevu için takvim dosyası (.ics) oluşturur. E-postaya eklenince Outlook, Gmail ve Apple Takvim "takvime ekle" seçeneği sunar.',
      params: [
        { key: 'title', label: 'Başlık', type: 'expr', def: 'Randevu: {{ $json.ad }}' },
        { key: 'start', label: 'Başlangıç', type: 'expr', def: '{{ $json.tarih }}', help: '2026-11-03 14:30 ya da ISO tarih. Saat dilimi yazılmazsa bilgisayarın saati kullanılır.' },
        { key: 'duration', label: 'Süre (dakika)', type: 'number', def: 60, min: 1 },
        { key: 'allDay', label: 'Tüm gün', type: 'toggle', def: false },
        { key: 'location', label: 'Yer / bağlantı', type: 'expr', def: '' },
        { key: 'description', label: 'Açıklama', type: 'textarea', def: '' },
        { key: 'organizer', label: 'Düzenleyen e-posta', type: 'expr', def: '' },
        { key: 'attendees', label: 'Katılımcılar (virgülle)', type: 'expr', def: '{{ $json.eposta }}' },
        { key: 'reminder', label: 'Hatırlatma (dakika önce, 0 = yok)', type: 'number', def: 30, min: 0 },
        { key: 'file', label: 'Dosya adı (boş = otomatik)', type: 'expr', def: '' },
      ],
      sub: '{title}',
      async run(c) {
        const icsEsc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
        const fold = line => { const b = Buffer.from(line); if (b.length <= 75) return line; const out = []; let cur = ''; for (const ch of line) { if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; } cur += ch; } out.push(cur); return out.join('\r\n '); };
        const utc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        return [c.items.map((it, i) => {
          const R = k => str(c.R(c.p[k], it, i)).trim();
          const raw = R('start'); const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(raw) ? raw.replace(' ', 'T') : raw);
          if (isNaN(d)) throw new Error(`${i + 1}. öğede başlangıç tarihi okunamadı: "${raw}"`);
          const end = new Date(d.getTime() + (Number(c.p.duration) || 60) * 60000);
          const day = x => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
          const uid = `${require('crypto').randomUUID()}@8n8`;
          const att = R('attendees').split(/[,;]/).map(s => s.trim()).filter(Boolean);
          const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//8n8//TR', 'CALSCALE:GREGORIAN', `METHOD:${att.length ? 'REQUEST' : 'PUBLISH'}`, 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(new Date())}`,
            ...(c.p.allDay ? [`DTSTART;VALUE=DATE:${day(d)}`, `DTEND;VALUE=DATE:${day(new Date(d.getTime() + 86400000))}`] : [`DTSTART:${utc(d)}`, `DTEND:${utc(end)}`]),
            `SUMMARY:${icsEsc(R('title'))}`, ...(R('location') ? [`LOCATION:${icsEsc(R('location'))}`] : []), ...(R('description') ? [`DESCRIPTION:${icsEsc(R('description'))}`] : []),
            ...(R('organizer') ? [`ORGANIZER:mailto:${R('organizer')}`] : []), ...att.map(a => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a.replace(/^.*<([^>]+)>.*$/, '$1')}`),
            ...(Number(c.p.reminder) > 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(R('title'))}`, `TRIGGER:-PT${Number(c.p.reminder)}M`, 'END:VALARM'] : []),
            'END:VEVENT', 'END:VCALENDAR'];
          const text = lines.map(fold).join('\r\n') + '\r\n';
          const name = R('file'); const f = save(name ? withExt(name, 'ics') : `takvim/${stamp()}-${i}.ics`, text);
          return { json: { ...it.json, takvim: { dosya: rel(f), uid, baslangic: d.toISOString(), bitis: c.p.allDay ? null : end.toISOString() } } };
        })];
      },
    },
  };
  return { NODES };
};
