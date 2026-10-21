'use strict';
/* Ready-made workflows shown in "Şablonlar". The first one runs fully offline. */
const crypto = require('crypto');
const { defaults } = require('./nodes');

const id = () => crypto.randomBytes(6).toString('base64url');
function build(name, description, spec, edges, extra = {}) {
  const nodes = {};
  for (const [key, [type, x, y, label, params]] of Object.entries(spec)) nodes[key] = { id: id(), type, name: label, x, y, params: { ...defaults(type), ...(params || {}) }, disabled: false, settings: {} };
  return { name, description, nodes: Object.values(nodes), edges: edges.map(([a, ap, b, bp]) => ({ id: id(), from: nodes[a].id, fromPort: ap, to: nodes[b].id, toPort: bp })), ...extra };
}

const ORDERS = JSON.stringify([
  { id: 'SP-1041', musteri: 'Ayşe Yılmaz', eposta: 'ayse@ornek.com', tutar: 1249.9, durum: 'odendi', urunler: [{ ad: 'Kulaklık', adet: 1 }, { ad: 'Kılıf', adet: 2 }] },
  { id: 'SP-1042', musteri: 'Mehmet Kaya', eposta: 'mehmet@ornek.com', tutar: 349, durum: 'bekliyor', urunler: [{ ad: 'Kablo', adet: 1 }] },
  { id: 'SP-1043', musteri: 'Elif Şahin', eposta: 'elif@ornek.com', tutar: 860, durum: 'odendi', urunler: [{ ad: 'Klavye', adet: 1 }] },
  { id: 'SP-1044', musteri: 'Can Öztürk', eposta: 'can@ornek.com', tutar: 129.5, durum: 'iade', urunler: [{ ad: 'Mouse pad', adet: 1 }] },
  { id: 'SP-1045', musteri: 'Selin Aydın', eposta: 'selin@ornek.com', tutar: 2290, durum: 'odendi', urunler: [{ ad: 'Monitör', adet: 1 }] },
  { id: 'SP-1046', musteri: 'Burak Arslan', eposta: 'burak@ornek.com', tutar: 415, durum: 'bekliyor', urunler: [{ ad: 'Webcam', adet: 1 }] },
], null, 2);

const TEMPLATES = {
  siparis: () => build('Sipariş raporu', 'İnternetsiz çalışan örnek: siparişleri duruma göre ayırır, ödenenlerin KDV\'sini hesaplar, özet çıkarır ve CSV dosyasına yazar.', {
    tr: ['manual', 0, 200, 'Başlat', { data: ORDERS }],
    note: ['note', 0, -40, 'Not', { text: 'Örnek akış: Çalıştır\'a basın, sonra her node\'a tıklayıp girdi/çıktısına bakın.', color: 'yellow' }],
    sw: ['switch', 340, 200, 'Duruma göre', { value: '{{ $json.durum }}', rules: [{ value: 'odendi', label: 'ödendi' }, { value: 'bekliyor', label: 'bekliyor' }], fallback: true }],
    kdv: ['code', 700, 40, 'KDV hesapla', { code: '// KDV dahil tutardan net ve KDV (%20)\nreturn items.map(({ json }) => {\n  const net = json.tutar / 1.2;\n  return {\n    ...json,\n    net: Math.round(net * 100) / 100,\n    kdv: Math.round((json.tutar - net) * 100) / 100,\n  };\n});' }],
    csv: ['writeFile', 1060, 40, 'Faturaları CSV\'ye yaz', { path: 'faturalar.csv', format: 'csv' }],
    hat: ['set', 700, 220, 'Hatırlatma metni', { fields: [{ key: 'hatirlatma', value: 'Sayın {{ $json.musteri }}, {{ $json.id }} numaralı siparişinizin ödemesi bekleniyor.' }], keep: true }],
    tum: ['merge', 1060, 300, 'Hepsini topla', { mode: 'append' }],
    ozet: ['summarize', 1400, 300, 'Duruma göre özet', { groupBy: 'durum', field: 'tutar', ops: 'adet, toplam, ortalama' }],
    iade: ['noop', 700, 400, 'İadeler', {}],
  }, [['tr', 0, 'sw', 0], ['sw', 0, 'kdv', 0], ['kdv', 0, 'csv', 0], ['sw', 1, 'hat', 0], ['hat', 0, 'tum', 0], ['sw', 2, 'iade', 0], ['iade', 0, 'tum', 1], ['tum', 0, 'ozet', 0]]),

  destek: () => build('Destek mesajı analizi (Claude)', 'Webhook ile gelen müşteri mesajını Claude\'a özetletir, duygusunu bulur ve isteğe JSON olarak yanıt döner. Anthropic API anahtarı gerekir.', {
    wh: ['webhook', 0, 100, 'Destek isteği', { method: 'POST', path: 'destek', respond: 'node', sample: '{\n  "musteri": "Ayşe",\n  "mesaj": "Siparişim 5 gündür kargoda, çok mağdur oldum. Ne zaman gelir?"\n}' }],
    ai: ['claude', 340, 100, 'Mesajı analiz et', { prompt: 'Aşağıdaki müşteri mesajını incele. Yalnızca şu JSON\'u döndür: {"ozet": "...", "duygu": "olumlu|olumsuz|nötr", "oncelik": "düşük|orta|yüksek"}\n\nMesaj: {{ $json.body.mesaj }}', json: true, effort: 'low' }],
    yan: ['respond', 680, 100, 'Sonucu döndür', { type: 'json', body: '{{ $json.yanit }}' }],
  }, [['wh', 0, 'ai', 0], ['ai', 0, 'yan', 0]]),

  form: () => build('İletişim formu → Telegram', 'Programın sunduğu iletişim formundan gelen her mesajı CSV dosyasına ekler ve Telegram\'dan bildirir.', {
    fm: ['form', 0, 100, 'İletişim formu', {}],
    tar: ['datetime', 320, 100, 'Zaman damgası', { op: 'now', pattern: 'DD.MM.YYYY HH:mm', output: 'zaman' }],
    csv: ['writeFile', 640, 0, 'Kayıtlara ekle', { path: 'iletisim.csv', format: 'csv', append: true }],
    tg: ['telegram', 640, 200, 'Telegram\'a bildir', { text: '📩 Yeni mesaj ({{ $json.zaman }})\n{{ $json.ad }} <{{ $json.eposta }}>\n\n{{ $json.mesaj }}' }],
  }, [['fm', 0, 'tar', 0], ['tar', 0, 'csv', 0], ['tar', 0, 'tg', 0]]),

  hava: () => build('Sabah hava durumu e-postası', 'Hafta içi her sabah 08:00\'de İstanbul\'un hava durumunu Open-Meteo\'dan alır ve e-posta ile gönderir.', {
    sc: ['schedule', 0, 100, 'Hafta içi 08:00', { mode: 'cron', cron: '0 8 * * 1-5' }],
    http: ['http', 320, 100, 'Hava durumunu al', { url: 'https://api.open-meteo.com/v1/forecast?latitude=41.01&longitude=28.98&current=temperature_2m,wind_speed_10m&timezone=Europe%2FIstanbul', perItem: true }],
    msg: ['set', 640, 100, 'Mesajı hazırla', { fields: [{ key: 'metin', value: 'Günaydın! İstanbul\'da şu an {{ $json.current.temperature_2m }}°C, rüzgâr {{ $json.current.wind_speed_10m }} km/sa.' }], keep: false }],
    mail: ['email', 960, 100, 'E-posta gönder', { to: 'ben@ornek.com', subject: 'Bugünün havası', body: '{{ $json.metin }}' }],
  }, [['sc', 0, 'http', 0], ['http', 0, 'msg', 0], ['msg', 0, 'mail', 0]]),

  hata: () => build('Hata bildirimi', 'Başka bir akış hata verince Slack ya da Discord kanalına haber verir. Diğer akışların Ayarlar bölümünde bu akışı "hata akışı" seçin.', {
    et: ['errorTrigger', 0, 100, 'Bir akış hata verdi', {}],
    msg: ['chatWebhook', 340, 100, 'Kanala yaz', { text: '⚠️ "{{ $json.workflow.name }}" akışı hata verdi\nNode: {{ $json.execution.lastNode }}\nHata: {{ $json.execution.error }}' }],
  }, [['et', 0, 'msg', 0]]),

  asistan: () => build('Sohbet asistanı (Claude ajanı)', 'Hazır sohbet sayfasından gelen soruları Claude ajanına yönlendirir. Ajan web\'e bakabilir, hesap yapabilir, sohbeti hatırlar. Anthropic API anahtarı gerekir.', {
    ch: ['chatTrigger', 0, 100, 'Sohbet', { path: 'asistan', title: 'Asistan', welcome: 'Merhaba! Bir şey sorun, gerekirse internetten bakarım.' }],
    ag: ['agent', 340, 100, 'Claude ajanı', { memory: true, session: '{{ $json.oturum }}', prompt: '{{ $json.mesaj }}' }],
  }, [['ch', 0, 'ag', 0]]),

  haber: () => build('Haber özeti → Telegram', 'Her sabah RSS\'ten son haberleri alır, daha önce gönderilmemiş olanları Claude ile tek mesajda özetler ve Telegram\'a yollar.', {
    sc: ['schedule', 0, 100, 'Her sabah 08:30', { mode: 'cron', cron: '30 8 * * *' }],
    rss: ['rss', 300, 100, 'Haberleri al', { url: 'https://www.ntv.com.tr/gundem.rss', limit: 15 }],
    yeni: ['newItems', 600, 100, 'Yeni olanlar', { key: '{{ $json.guid }}' }],
    top: ['aggregate', 900, 40, 'Tek listede topla', { mode: 'all', output: 'haberler' }],
    ai: ['claude', 1200, 40, 'Özetle', { prompt: 'Aşağıdaki haber başlıklarını ve özetlerini en önemli 5 maddede, kısa Türkçe cümlelerle özetle:\n\n{{ JSON.stringify($json.haberler.map(h => h.baslik + " - " + h.ozet)) }}', effort: 'low' }],
    tg: ['telegram', 1500, 40, 'Telegram\'a gönder', { text: '📰 Günün özeti\n\n{{ $json.yanit }}' }],
  }, [['sc', 0, 'rss', 0], ['rss', 0, 'yeni', 0], ['yeni', 0, 'top', 0], ['top', 0, 'ai', 0], ['ai', 0, 'tg', 0]]),

  kayit: () => build('Form kayıtlarını tabloya yaz', 'Web formundan gelen başvuruları "Başvurular" tablosuna ekler; aynı e-posta tekrar gelirse kaydı günceller. İnternetsiz çalışır.', {
    fm: ['form', 0, 100, 'Başvuru formu', { path: 'basvuru', title: 'Etkinlik başvurusu', fields: [{ label: 'Ad soyad', name: 'ad', type: 'text', required: true }, { label: 'E-posta', name: 'eposta', type: 'email', required: true }, { label: 'Kaç kişi?', name: 'kisi', type: 'number', required: false }] }],
    tb: ['table', 320, 100, 'Tabloya yaz', { table: 'Başvurular', op: 'upsert', key: 'eposta', dataMode: 'item' }],
  }, [['fm', 0, 'tb', 0]]),

  sss: () => build('Telegram SSS botu (bilgi tabanı)', 'Telegram botunuza gelen soruları "Müşteri SSS" bilgi tabanındaki belgelere göre Claude cevaplar. Cevap belgelerde yoksa bunu söyler ve size haber verir. Önce "Bilgi tabanı" sayfasından "Müşteri SSS" adında bir taban açıp belgelerinizi yükleyin.', {
    tg: ['telegramTrigger', 0, 100, 'Telegram mesajı', {}],
    kb: ['knowledge', 320, 100, 'Belgelere göre cevapla', { kb: 'Müşteri SSS', op: 'ask', question: '{{ $json.mesaj }}', instructions: 'Kısa, nazik ve Türkçe cevap ver. Müşteriye "siz" diye hitap et.' }],
    yanit: ['telegram', 640, 0, 'Cevabı gönder', { chatId: '{{ $json.sohbetId }}', text: '{{ $json.cevap }}' }],
    var: ['if', 640, 200, 'Cevap bulunamadı mı?', { conditions: [{ left: '{{ $json.bilgiBulundu }}', op: 'isFalse', right: '' }] }],
    ben: ['telegram', 960, 200, 'Bana haber ver', { chatId: '', text: '❓ Bilgi tabanında cevabı olmayan soru:\n{{ $json.ad }}: {{ $json.mesaj }}' }],
  }, [['tg', 0, 'kb', 0], ['kb', 0, 'yanit', 0], ['kb', 0, 'var', 0], ['var', 0, 'ben', 0]]),

  eposta: () => build('Gelen e-postaları sınıflandır → Slack', 'Gmail\'e gelen her e-postayı Claude şikâyet, sipariş ya da soru olarak ayırır; şikâyetleri ve siparişleri ilgili Slack kanalına yazar.', {
    gm: ['gmailTrigger', 0, 100, 'Yeni e-posta', { query: 'in:inbox' }],
    cl: ['classify', 320, 100, 'Ne tür bir e-posta?', { text: 'Konu: {{ $json.konu }}\n\n{{ $json.metin }}', categories: [{ key: 'Şikâyet', value: 'Müşteri bir sorundan memnun değil ya da iade istiyor' }, { key: 'Sipariş', value: 'Yeni sipariş veriyor ya da siparişini soruyor' }, { key: 'Soru', value: 'Ürün ya da hizmet hakkında bilgi istiyor' }], other: true }],
    sk: ['slack', 680, -40, '#sikayetler', { channel: '#sikayetler', text: ':warning: *Şikâyet* - {{ $json.kimden }}\n*{{ $json.konu }}*\n{{ $json.metin }}' }],
    sp: ['slack', 680, 120, '#siparisler', { channel: '#siparisler', text: ':package: *Sipariş* - {{ $json.kimden }}\n*{{ $json.konu }}*' }],
  }, [['gm', 0, 'cl', 0], ['cl', 0, 'sk', 0], ['cl', 1, 'sp', 0]]),

  fatura: () => build('Metinden bilgi çıkar → tabloya yaz', 'Webhook\'a gönderilen serbest metinden (fatura, sipariş e-postası, not) Claude ad, tutar ve tarih gibi alanları çıkarır, "Faturalar" tablosuna yazar ve sonucu JSON olarak döner.', {
    wh: ['webhook', 0, 100, 'Metin gelince', { method: 'POST', path: 'fatura', respond: 'node' }],
    ex: ['extract', 320, 100, 'Alanları çıkar', { text: '{{ $json.body.metin }}', fields: [{ key: 'firma', value: 'Faturayı kesen firma' }, { key: 'faturaNo', value: 'Fatura numarası' }, { key: 'tutar:sayı', value: 'KDV dahil toplam, TL' }, { key: 'tarih:tarih', value: 'Fatura tarihi' }, { key: 'kalemler:liste', value: 'Ürün ya da hizmet adları' }] }],
    tb: ['table', 640, 100, 'Faturalar tablosuna yaz', { table: 'Faturalar', op: 'upsert', key: 'faturaNo', dataMode: 'item' }],
    rs: ['respond', 960, 100, 'Sonucu dön', { type: 'json', body: '{{ JSON.stringify($json) }}' }],
  }, [['wh', 0, 'ex', 0], ['ex', 0, 'tb', 0], ['tb', 0, 'rs', 0]]),

  dongu: () => build('Döngü örneği: sayfa sayfa API', 'Döngü node\'unun nasıl çalıştığını gösterir: 10 kullanıcıyı ikişerli gruplar halinde işler, her turda bekler ve sonunda hepsini toplar. İnternet gerekir.', {
    tr: ['manual', 0, 100, 'Başlat', { data: '[{"id":1},{"id":2},{"id":3},{"id":4},{"id":5},{"id":6},{"id":7},{"id":8},{"id":9},{"id":10}]' }],
    lp: ['loop', 300, 100, 'Döngü (ikişer)', { batchSize: 2 }],
    http: ['http', 600, 240, 'Kullanıcıyı al', { url: 'https://jsonplaceholder.typicode.com/users/{{ $json.id }}' }],
    bek: ['wait', 900, 240, 'Biraz bekle', { amount: 300, unit: 'ms' }],
    son: ['aggregate', 600, -40, 'Hepsini topla', { mode: 'field', field: 'name', output: 'isimler' }],
  }, [['tr', 0, 'lp', 0], ['lp', 1, 'http', 0], ['http', 0, 'bek', 0], ['bek', 0, 'lp', 0], ['lp', 0, 'son', 0]]),
};

const LIST = [
  { key: 'sss', title: 'Telegram SSS botu', text: 'Sorulara kendi belgelerinize (bilgi tabanı) göre Claude cevap verir; bilinmeyen soruları size iletir.', flow: ['Telegram', 'Bilgi tabanı', 'Telegram'] },
  { key: 'eposta', title: 'E-postaları sınıflandır → Slack', text: 'Gelen e-postaları Claude şikâyet, sipariş ya da soru diye ayırır ve Slack\'e yazar.', flow: ['Gmail', 'Sınıflandır', 'Slack'] },
  { key: 'fatura', title: 'Metinden bilgi çıkar → tablo', text: 'Serbest metinden firma, tutar, tarih gibi alanları çıkarıp tabloya yazar.', flow: ['Webhook', 'Bilgi çıkar', 'Veri tablosu', 'Yanıt ver'] },
  { key: 'asistan', title: 'Sohbet asistanı', text: 'Hazır sohbet sayfası + araç kullanan, hafızalı Claude ajanı.', flow: ['Sohbet', 'Claude ajanı'] },
  { key: 'haber', title: 'Haber özeti → Telegram', text: 'RSS, yeni haberleri ayıklama, Claude ile özet ve Telegram.', flow: ['Zamanlayıcı', 'RSS', 'Yeni öğeler', 'Topla', 'Claude', 'Telegram'] },
  { key: 'kayit', title: 'Form kayıtlarını tabloya yaz', text: 'Hazır form ve yerleşik veri tablosu; internetsiz çalışır.', flow: ['Form', 'Veri tablosu'] },
  { key: 'dongu', title: 'Döngü örneği', text: 'Öğeleri parça parça işleyen, her turda bekleyen döngü.', flow: ['Manuel', 'Döngü', 'HTTP', 'Bekle', 'Topla'] },
  { key: 'siparis', title: 'Sipariş raporu', text: 'İnternetsiz çalışır: siparişleri ayırır, KDV hesaplar, özet çıkarır, CSV\'ye yazar.', flow: ['Manuel', 'Yönlendir', 'Kod', 'Dosyaya yaz', 'Birleştir', 'Özetle'] },
  { key: 'destek', title: 'Destek mesajı analizi', text: 'Webhook ile gelen mesajı Claude\'a analiz ettirir ve JSON yanıt döner.', flow: ['Webhook', 'Claude', 'Yanıt ver'] },
  { key: 'form', title: 'İletişim formu → Telegram', text: 'Hazır web formu, CSV kaydı ve Telegram bildirimi.', flow: ['Form', 'Tarih', 'Dosyaya yaz', 'Telegram'] },
  { key: 'hava', title: 'Sabah hava durumu e-postası', text: 'Cron ile hafta içi 08:00\'de gerçek API\'den veri alıp e-posta gönderir.', flow: ['Zamanlayıcı', 'HTTP', 'Ayarla', 'E-posta'] },
  { key: 'hata', title: 'Hata bildirimi', text: 'Diğer akışlar hata verince Slack/Discord\'a haber verir.', flow: ['Hata tetikleyici', 'Slack/Discord'] },
];

module.exports = { TEMPLATES, LIST };
