# 8n8

8n8, kendi bilgisayarınızda çalışan görsel bir iş akışı otomasyon programıdır. n8n'e benzer: node'ları tuvale sürükler, birbirine bağlar ve akışı çalıştırırsınız. Akışlar zamanlayıcıyla, webhook ile, hazır web formlarıyla, sohbet sayfasıyla, RSS, Telegram ya da klasör değişiklikleriyle kendiliğinden de başlayabilir. Claude'a ne istediğinizi yazarak akışı ona kurdurabilir, n8n akışlarınızı içe aktarabilirsiniz. Bütün veriler bilgisayarınızda kalır.

## Kurulum

1. [Node.js](https://nodejs.org) kurun. Sürüm 20 ya da daha yenisi gerekir (SQLite için 22.5+); "LTS" sürümü yeterlidir.
2. Bu klasördeki başlatma dosyasını çalıştırın:
   - **Windows:** `baslat.bat` dosyasına çift tıklayın.
   - **macOS:** `baslat.command` dosyasına çift tıklayın. İlk seferde macOS izin isterse dosyaya sağ tıklayıp "Aç"ı seçin.
   - **Linux:** terminalde `./baslat.sh` komutunu çalıştırın.
3. Tarayıcı kendiliğinden açılır. Açılmazsa adres çubuğuna http://127.0.0.1:5678 yazın.

Başlatma dosyası ilk çalıştırmada gerekli paketi kendisi kurar (`npm install`). İsterseniz terminalden kendiniz de kurup başlatabilirsiniz:

```
npm install
npm start
```

Programı kapatmak için açılan siyah pencerede `Ctrl+C` tuşlarına basın ya da pencereyi kapatın. Zamanlayıcılar, webhook'lar ve formlar yalnızca program açıkken çalışır.

## Neler var

**Editör**
- Sürükle-bırak tuval, yakınlaştırma, mini harita, otomatik düzenleme
- Geri al / yinele, kopyala / yapıştır, çoklu seçim, klavye kısayolları
- Her node'un girdisini ve çıktısını tablo ya da JSON olarak görme
- "Buraya kadar çalıştır" ile akışın bir kısmını deneme
- Çıktıyı sabitleme: bir node'un çıktısını dondurup sonraki adımları onu yeniden çalıştırmadan deneme
- Canlı çalışma görünümü ve her node'un süresini gösteren zaman çizelgesi
- Akış sürümleri (otomatik kayıt, eski sürüme dönme), JSON olarak dışa ve içe aktarma, hazır şablonlar
- **Claude ile akış oluştur:** "Her sabah RSS'teki yeni yazıları özetleyip Telegram'a gönder" gibi yazın, akışı Claude kursun. Editörde mevcut akışı da değiştirebilir; değişiklik geri alınabilir.
- **n8n'den içe aktarma:** n8n'den dışa aktarılan JSON'u İçe aktar penceresine yapıştırın. Bilinen node'lar ve ifadeler dönüştürülür, karşılığı olmayanlar notla işaretlenir.
- **Editörde hata ayıkla:** Çalıştırma ayrıntısındaki düğme, o çalıştırmanın tetikleyici verisini editörde sabitler; hatayı aynı veriyle adım adım yeniden deneyebilirsiniz
- **Etiketler:** akış ayarlarından etiket verin; Akışlar sayfasında etikete, etkin/kapalı durumuna ve ada göre süzün
- **Hata bildirimleri:** Ayarlar sayfasından Telegram, e-posta ya da Slack/Discord webhook seçin; etkin bir akış hata verince size haber gelir, hata akışı kurmanız gerekmez. Aynı akış için en fazla belirlediğiniz sıklıkta (varsayılan 15 dakika) mesaj gelir
- **Çöp kutusu:** Silinen akışlar 30 gün çöp kutusunda kalır; sürüm geçmişi ve hafızasıyla geri alınabilir
- **Yedekleme:** Ayarlar sayfasından akışları, veri tablolarını, bilgi tabanlarını, değişkenleri ve (şifreyle) kimlik bilgilerini tek dosyaya yedekleyin, başka bir bilgisayara geri yükleyin
- **Özet sayfası:** seçilen dönemdeki çalıştırma sayısı, başarı oranı, ortalama süre, günlük grafik, akış başına başarı ve en sık hatalar
- Açık ve koyu tema

**Tetikleyiciler:** Manuel, Zamanlayıcı (aralık ya da cron ifadesi), Webhook (`/webhook/<yol>`, isteğe bağlı başlık / Bearer / Basic kimlik doğrulaması), Form (`/form/<yol>` adresinde hazır web formu), Sohbet (`/sohbet/<yol>` adresinde hazır sohbet sayfası), RSS yeni yazı, Telegram mesajı gelince, Gmail'e e-posta gelince, Outlook'a e-posta gelince, Slack'e mesaj gelince, Discord'a mesaj gelince, GitHub'da yeni konu / PR / sürüm / commit, MCP aracı (Claude çağırınca), Klasör izleyici, Hata tetikleyici, Alt akış girişi

**Node'lar (69 tür)**
- **Eylemler:** HTTP isteği, Webhook'a yanıt ver, Başka akışı çalıştır, RSS oku
- **Yapay zekâ:** Claude, Claude ajanı (araç kullanan, hafızalı ajan), Claude ile sınıflandır (her kategori ayrı çıkış), Claude ile bilgi çıkar (serbest metinden düzgün alanlar), Bilgi tabanı (belgelerinize göre cevap)
- **Uygulamalar:** Gmail, Google Drive, Google Takvim, Google E-Tablolar, Outlook (Microsoft 365), Slack, Discord, Notion, Airtable, GitHub, Veritabanı (PostgreSQL, MySQL / MariaDB, SQLite), Telegram, Slack / Discord webhook, E-posta (SMTP)
- **Veri:** Veri tablosu, Alanları ayarla, Alanları yeniden adlandır, Filtrele, Sırala, Sınırla, Tekrarları kaldır, Yeni öğeleri bul, Listeyi ayır, Topla, Özetle, Veri setlerini karşılaştır, Tarih ve saat, Şifreleme / hash, Dosya oku, Dosyaya yaz (JSON, CSV, metin)
- **Dönüştürme:** HTML'den veri çıkar (CSS seçici), XML ⇄ JSON, Markdown ⇄ HTML, Metin işlemleri
- **Mantık ve akış:** Onay bekle, Döngü (parça parça işle), Eğer, Yönlendir (switch), Birleştir, Kod (JavaScript), Bekle, Hiçbir şey yapma, Hata ver
- **Tuval:** Not

**Döngü:** Döngü node'u öğeleri parça parça işler. "Döngü" çıkışından işlenecek adımlara gidin, son adımı yeniden Döngü node'una bağlayın; bütün parçalar bitince "Bitti" çıkışı devam eder. Geriye dönen bağlantılar yalnızca Döngü node'una girebilir.

**Veri tabloları:** Tablolar sayfasında programın içinde tablo oluşturun, hücreleri yerinde düzenleyin, CSV içe ve dışa aktarın. Veri tablosu node'u satır ekler, varsa günceller, arar, günceller ve siler.

**Claude ajanı:** Ajan; web isteği, hesap makinesi, saat, veri tabloları, bilgi tabanı ve araç olarak seçtiğiniz başka akışları kendisi kullanarak cevap verir. Sohbet tetikleyicisiyle birlikte konuşma geçmişini hatırlar (akış ayarlarındaki "Hafızayı temizle" ile sıfırlanır).

**Veritabanları ve Google E-Tablolar:** Veritabanı node'u SQL sorgusu çalıştırır ya da tablo adı ve eşleştirme sütunuyla satır okur, ekler, ekler-ya-da-günceller, günceller ve siler. Değerleri SQL'e `$1, $2` yer tutucularıyla verin; bu SQL enjeksiyonuna karşı korur. Google E-Tablolar için Google Cloud'da bir hizmet hesabı açıp JSON anahtarını kimlik bilgisi olarak ekleyin ve tabloyu o hesabın e-posta adresiyle paylaşın.

**Google hesabı ve OAuth:** Gmail, Drive, Takvim ve E-Tablolar için Kimlik bilgileri sayfasında "Google hesabı" ekleyin:
1. [Google Cloud Console](https://console.cloud.google.com)'da bir proje açın; Gmail, Drive, Calendar ve Sheets API'lerini etkinleştirin.
2. "OAuth izin ekranı"nı ayarlayın (Harici; kendinizi test kullanıcısı olarak ekleyin).
3. "Kimlik bilgileri → OAuth istemci kimliği → Web uygulaması" oluşturun ve 8n8'in gösterdiği yönlendirme adresini (`http://localhost:5678/oauth/callback`) ekleyin.
4. İstemci kimliğini ve gizli anahtarı 8n8'e girip "Hesaba bağlan"a basın. Oturum süresi dolunca 8n8 kendiliğinden yeniler.

**Microsoft hesabı (Outlook):** Kimlik bilgileri sayfasında "Microsoft hesabı" ekleyin:
1. [Azure portalı](https://portal.azure.com)'nda Microsoft Entra ID → Uygulama kayıtları → Yeni kayıt açın. Hesap türü olarak "herhangi bir kuruluş dizini ve kişisel Microsoft hesapları"nı seçin.
2. Yönlendirme adresi olarak platform "Web" ile 8n8'in gösterdiği adresi ekleyin.
3. Sertifikalar ve gizli diziler → Yeni istemci gizli dizisi oluşturun ve "Değer"i kopyalayın.
4. Uygulama (istemci) kimliğini ve gizli diziyi 8n8'e girip "Hesaba bağlan"a basın. Outlook node'u e-posta gönderir, okur, yanıtlar, okundu işaretler ve siler; HTTP isteği node'unda da bu kimlik bilgisiyle Microsoft Graph'a istek atabilirsiniz.

**Slack:** [api.slack.com/apps](https://api.slack.com/apps)'te bir uygulama açın, OAuth & Permissions'ta `chat:write`, `channels:read`, `channels:history`, `reactions:write` izinlerini ekleyip çalışma alanına kurun ve "Bot User OAuth Token"ı (`xoxb-…`) kimlik bilgisi olarak girin. Botu kanala `/invite @bot` ile ekleyin. Kanalı `#genel` gibi adıyla yazabilirsiniz. Slack node'u mesaj gönderir (konuya yanıt dahil), günceller, tepki ekler, kanal mesajlarını ve kanalları listeler; "Slack'e mesaj gelince" tetikleyicisi kanaldaki yeni insan mesajlarında akışı başlatır.

**Notion:** [notion.so/my-integrations](https://www.notion.so/my-integrations)'da bir entegrasyon açın, anahtarını kimlik bilgisi olarak girin ve kullanacağınız veritabanında ••• → Bağlantılar'dan entegrasyonu ekleyin. Veritabanı alanına tarayıcıdaki bağlantıyı yapıştırabilirsiniz. Notion node'u veritabanını sorgular (isteğe bağlı Notion filtresiyle), satır ekler, sayfayı günceller, sayfaya metin ekler, arşivler ve arama yapar. Satır eklerken "sütun adı = değer" yazmanız yeter; metin, sayı, seçim, çoklu seçim, tarih, onay kutusu gibi türler veritabanından okunur.

**GitHub:** github.com → Settings → Developer settings → Fine-grained tokens'tan bir anahtar oluşturun (Issues, Contents, Pull requests: okuma-yazma). GitHub node'u konu açar, yorum yazar, kapatır, konuları, PR'ları ve sürümleri listeler, depodaki bir dosyayı okur ya da kaydeder (commit). Depo alanına `sahip/depo` ya da depo bağlantısı yazılır.

**Airtable:** [airtable.com/create/tokens](https://airtable.com/create/tokens)'da `data.records:read`, `data.records:write` izinli bir anahtar açın ve tabanınızı ekleyin. Taban alanına tablonun tarayıcıdaki bağlantısını yapıştırmanız yeterli. Airtable node'u formülle filtreleyerek listeler, getirir, ekler, günceller, bir alana göre ekler-ya-da-günceller ve siler; kayıtları Airtable'ın sınırına uygun olarak 10'arlı gruplar halinde gönderir.

**Discord:** [discord.com/developers](https://discord.com/developers/applications)'da bir uygulama ve bot açın, bot token'ını girin, mesaj okuyacaksanız "Message Content Intent"i açın ve botu sunucunuza ekleyin. Discord node'u mesaj ya da renkli kart (embed) gönderir, yanıtlar, düzenler, siler, tepki ekler, kanal mesajlarını ve sunucu kanallarını listeler. Kanal kimliği için Discord'da Geliştirici modunu açıp kanala sağ tıklayın.

Aynı yolla "OAuth2 (başka servisler)" türüyle Spotify gibi servislere bağlanıp HTTP isteği node'unda kullanabilirsiniz.

**Claude ile sınıflandır ve bilgi çıkar:** Sınıflandır node'una kategorileri ve ne zaman seçileceklerini yazın; her kategori ayrı bir çıkış olur, uymayanlar "Diğer"den çıkar. Bilgi çıkar node'una alanları `ad:tür = açıklama` biçiminde yazın (türler: metin, sayı, tamsayı, evet-hayır, liste, tarih); Claude metinde olmayanları boş bırakır. İkisi de Claude'un yapılandırılmış çıktısını kullandığı için yanıt her zaman bu alanlara uyar. Varsayılan model ucuz ve hızlı olan Haiku'dur.

**Bilgi tabanı (belgelerinize göre cevap):** "Bilgi tabanı" sayfasından bir taban açıp SSS, ürün bilgisi, fiyat listesi gibi belgeleri yükleyin (.txt, .md, .csv, .json, .html, .docx, .odt, .pptx; PDF henüz yok). Belgeler bölümlere ayrılır ve bilgisayarınızda aranır; "Bilgi tabanı" node'u soruya en uygun bölümleri bulup yalnızca onları Claude'a gönderir. Claude yalnızca bu bölümlere dayanarak cevap verir, hangi belgelere dayandığını yazar, cevap belgelerde yoksa bunu söyler (`bilgiBulundu: false`). Node bölümleri yalnızca bulabilir ya da akıştan belge ekleyebilir. Claude ajanına da araç olarak verilebilir. Arama Türkçe kelime köklerini tanır ("iadeler" "iade"yi bulur) ama anlam araması değildir; farklı kelimelerle sorulan sorularda belgeye eş anlamlıları da yazmak işe yarar.

**MCP aracı (akışlarınızı Claude'a araç olarak verin):** Akışa "MCP aracı" tetikleyicisi koyun, araç adını, açıklamasını ve girdilerini yazıp akışı etkinleştirin. Araç `http://localhost:5678/mcp/<adres>` adresinde yayınlanır; aynı adresteki bütün etkin araçlar tek sunucuda görünür. Claude Code'a eklemek için `claude mcp add --transport http 8n8 http://localhost:5678/mcp/araclar` yazın; uzak (http) MCP sunucusu destekleyen diğer istemcilere de aynı adresi verin. Claude aracı çağırınca akış çalışır ve son node'un çıktısı sonuç olarak döner. Program başka bilgisayarlardan erişilebiliyorsa tetikleyicide kimlik doğrulamayı açın.

**Aynı anda çalışma sınırı:** Akış ayarlarında "Aynı anda en fazla çalıştırma"yı örneğin 1 yaparsanız webhook, zamanlayıcı, form ve diğer otomatik tetiklemeler sıraya girer ve birbirini beklemeden üst üste çalışmaz. Bekleme süresi zaman aşımına sayılmaz.

**Onay bekle:** Akış bu node'da durur ve bir onay sayfası açılır. Sayfanın adresini önceki bir node'da `{{ $execution.onayAdresi }}` ile e-posta ya da Telegram mesajına koyun; kişi "Onayla" ya da "Reddet"e basınca akış ilgili çıkıştan devam eder. Bekleme süresi akış zaman aşımına sayılmaz. Program kapanırsa bekleyen onaylar iptal olur.

**Bağlantıyı dene:** Kimlik bilgisi penceresindeki düğme Claude, Telegram, Slack, Discord, Notion, Airtable, GitHub, SMTP, veritabanı ve Google hizmet hesabı bilgilerinin çalışıp çalışmadığını kaydetmeden önce gösterir.

**Çalıştırma ayarları**
- Node başına: hata olursa yeniden dene (deneme sayısı, bekleme süresi), hataya rağmen devam et, not
- Akış başına: zaman aşımı, hata akışı (akış hata verince başka bir akışı tetikler)
- Çalıştırma geçmişi; her çalıştırmada her node'un girdisi ve çıktısı saklanır. Çalışan bir akış durdurulabilir, hata veren bir çalıştırma yeniden denenebilir.

**İfadeler:** Alanların içinde `{{ }}` kullanılır. Örnekler:
- `{{ $json.ad }}` gelen öğenin `ad` alanı
- `{{ $node["HTTP isteği"].json.id }}` başka bir node'un çıktısı
- `{{ $vars.API_ADRESI }}` Değişkenler sayfasındaki bir değer
- `{{ $dt.format($now, "DD.MM.YYYY") }}` bugünün tarihi
- `{{ $json.tutar * 1.2 }}` hesaplama
- `{{ $json.urunler.map(u => u.fiyat).reduce((a, b) => a + b, 0) }}` ok fonksiyonlarıyla liste işlemleri

**Güvenlik**
- Editör ve API yalnızca bu bilgisayarın adresiyle gelen isteklere yanıt verir; kötü niyetli bir web sitesi tarayıcınız üzerinden 8n8'e ulaşamaz.
- İfadeler (`{{ }}`) kod çalıştıramaz; yalnızca veri okuma ve hesaplama yapabilir.
- API anahtarları ve şifreler AES-256-GCM ile şifrelenerek saklanır ve tarayıcıya geri gönderilmez.
- Program varsayılan olarak yalnızca bu bilgisayardan erişilebilir (127.0.0.1).
- `N8N8_PASSWORD` tanımlarsanız arayüz şifre ister.

## Ayarlar (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` ya da `N8N8_PORT` | `5678` | Programın çalıştığı port |
| `N8N8_HOST` | `127.0.0.1` | Ağdaki diğer cihazlardan erişim için `0.0.0.0` yapın; bu durumda `N8N8_PASSWORD` da tanımlayın |
| `N8N8_PASSWORD` | yok | Tanımlıysa arayüz ve API şifre ister (kullanıcı adı önemsizdir) |
| `N8N8_URL` | `http://127.0.0.1:<port>` | Webhook ve form adreslerinde gösterilecek dış adres |
| `N8N8_DATA` | `~/.8n8` | Verilerin saklandığı klasör |
| `N8N8_ENCRYPTION_KEY` | otomatik | Kimlik bilgilerini şifreleyen anahtar. Tanımlanmazsa veri klasöründeki `anahtar` dosyasında üretilir |
| `N8N8_MAX_EXECUTIONS` | `1000` | Saklanacak en fazla çalıştırma sayısı |
| `N8N8_NO_OPEN` | yok | Tanımlıysa tarayıcı kendiliğinden açılmaz |
| `N8N8_ALLOWED_HOSTS` | yok | Editöre `localhost` dışında bir adla (ör. `benimpc.local`) erişiyorsanız, virgülle o adlar |
| `N8N8_CODE_MEMORY_MB` | `256` | Kod node'unun kullanabileceği en fazla bellek |
| `N8N8_CODE_SANDBOX` | açık | `0` yapılırsa Kod node'u kısıtlı süreç yerine programın içinde çalışır (daha hızlı ama korumasız) |

Örnek (macOS / Linux): `PORT=8080 N8N8_PASSWORD=gizli npm start`
Örnek (Windows): `set PORT=8080 && npm start`

## Veriler nerede

Bütün veriler `~/.8n8` klasöründedir (Windows'ta `C:\Users\<ad>\.8n8`):
- `workflows/`: akışlar
- `versions/`: akışların önceki sürümleri
- `executions/`: çalıştırma geçmişi
- `dosyalar/`: Dosya oku / Dosyaya yaz node'larının klasörü
- `tablolar/`: veri tabloları
- `bilgi/`: bilgi tabanları
- `cop/`: çöp kutusundaki akışlar
- `bildirim.json`: hata bildirimi ayarları
- `durum/`: akışların hafızası (Yeni öğeleri bul, ajan sohbet geçmişi, RSS'te görülen yazılar)
- `credentials.json`: şifreli kimlik bilgileri
- `anahtar`: şifreleme anahtarı
- `variables.json`: değişkenler

Yedek almak için bu klasörü kopyalamanız yeterli. `anahtar` dosyasını kaybederseniz kayıtlı kimlik bilgileri açılamaz.

## Webhook'u internete açmak

Webhook ve form adresleri varsayılan olarak yalnızca sizin bilgisayarınızdan çalışır. Dışarıdan bir servisin (ödeme sistemi, GitHub vb.) webhook göndermesi için bir tünel kullanın. Örneğin `cloudflared tunnel --url http://127.0.0.1:5678` ya da `ngrok http 5678`. Ardından `N8N8_URL` değişkenine tünel adresini verin ki editör doğru adresi göstersin.

## Claude node'u

Claude node'u için [console.anthropic.com](https://console.anthropic.com) adresinden bir API anahtarı alın ve Kimlik bilgileri sayfasından "Anthropic (Claude)" olarak ekleyin.
- Varsayılan model Claude Opus 5.5'tir. Sonnet 5.5, Haiku 5.5 ve Fable 5.1 de seçilebilir.
- "Düşünme çabası" ayarı, hız ile özen arasındaki dengeyi seçer.
- "Yanıtı JSON olarak çözmeyi dene" açıkken Claude'un yanıtı nesneye çevrilir ve sonraki node'larda `$json.yanit.alan` ile kullanılır.
- **Sunucu tarafı yedek modeller açıktır.** Opus 5.5, Sonnet 5.5 ve Fable 5.1 isteklerinde, seçilen model o an yoğunsa Anthropic isteği kendiliğinden başka bir uygun modele yönlendirebilir. Yanıtı hangi modelin verdiği, node'un kayıtlarında (Çıktı sekmesindeki günlük satırı) yazar.

## Sınırlar

- Kod node'u ayrı ve kısıtlı bir süreçte çalışır: dosyalara, başka programlara ve API anahtarlarınıza erişemez, bellek ve süre sınırı vardır. İnternete (fetch) erişebilir; başkalarından aldığınız akışlardaki kodu yine de okuyun.
- Telegram tetikleyicisi botun mesajlarını sorgulayarak alır; botta webhook kuruluysa (ayar açıkken) onu kaldırır.
- RSS, Telegram ve klasör tetikleyicileri yalnızca program açıkken kontrol eder.
- Hazır node'u olmayan servislere HTTP isteği node'u ve API anahtarı ya da OAuth2 kimlik bilgisiyle bağlanabilirsiniz.
- Gmail, Outlook, Slack, Discord ve GitHub tetikleyicileri ile onay bekleme program açıkken çalışır; tetikleyiciler en sık 5 saniyede bir kontrol eder.
- Sınıflandır, Bilgi çıkar ve Bilgi tabanının "Soru sor" işlemi gerçek Claude API'sine karşı değil, sahte sunucuyla denendi. MCP sunucusu resmî MCP istemci kütüphanesiyle (TypeScript SDK) denendi.
- Notion, Slack, Outlook, GitHub, Airtable ve Discord node'ları ve Microsoft girişi gerçek hesaplarla değil, resmî API belgelerine göre yazılmış sahte sunucularla test edildi.
- Özet sayfası saklanan çalıştırma kayıtlarından hesaplanır (`N8N8_MAX_EXECUTIONS`, varsayılan son 1000).
- Tek kullanıcı içindir; ekip hesabı ve yetki yönetimi yoktur.

## Test

```
npm test
```

Testler (43 adet) geçici bir klasörde gerçek bir sunucu başlatır. Webhook, form, zamanlayıcı, alt akış, hata akışı, yeniden deneme, döngü, veri tabloları, sohbet ve Claude ajanı, Claude ile akış oluşturma, n8n içe aktarma, RSS ve klasör izleyici, Kod node'unun kısıtlı süreci, SQLite, Google E-Tablolar, Telegram tetikleyicisi, Google OAuth girişi ve token yenileme, Gmail, Drive, Takvim, Notion, Slack ve Slack tetikleyicisi, Microsoft girişi ve Outlook, GitHub, Airtable, Discord ve tetikleyicileri, yedekleme ve geri yükleme, Claude ile sınıflandırma ve bilgi çıkarma, bilgi tabanı (.docx dahil belge yükleme, arama, belgelere dayalı cevap), hata bildirimleri, çöp kutusu, şablonlar, MCP sunucusu, aynı anda çalışma sınırı, editörde hata ayıklama, Özet istatistikleri, onay bekleme ve bozuk isteklere dayanıklılık denenir. Claude, Google, Microsoft, Notion, Slack, GitHub, Airtable, Discord, Telegram, SMTP ve RSS için sahte yerel sunucular kullanılır; internet ve API anahtarı gerekmez.
