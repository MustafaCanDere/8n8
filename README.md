# Auto-Move

Auto-Move, kendi bilgisayarınızda çalışan görsel bir iş akışı otomasyon programıdır. n8n'e benzer: node'ları tuvale sürükler, birbirine bağlar ve akışı çalıştırırsınız. Akışlar zamanlayıcıyla, webhook ile, hazır web formlarıyla, sohbet sayfasıyla, RSS, Telegram ya da klasör değişiklikleriyle kendiliğinden de başlayabilir. Claude'a ne istediğinizi yazarak akışı ona kurdurabilir, n8n akışlarınızı içe aktarabilirsiniz. Bütün veriler bilgisayarınızda kalır.

## Kurulum

### Windows: tek dosya (Auto-Move.exe)

[Sürümler (Releases)](https://github.com/MustafaCanDere/Auto-Move/releases) sayfasından `Auto-Move-windows.zip` dosyasını indirin. İçindeki `Auto-Move.exe` dosyasını istediğiniz bir klasöre çıkarıp çift tıklayın. Node.js kurmanız ya da `baslat.bat` çalıştırmanız gerekmez; her şey bu dosyanın içindedir. Siyah bir pencere açılır ve tarayıcı kendiliğinden Auto-Move'i gösterir. Programı kapatmak için bu pencereyi kapatın.

- İmzasız bir program olduğu için Windows ilk açılışta "Windows bilgisayarınızı korudu" uyarısı gösterebilir. "Ek bilgi"ye, sonra "Yine de çalıştır"a tıklayın.
- Güvenlik duvarı sorarsa izin vermeniz gerekmez: Auto-Move yalnızca bu bilgisayardan erişilecek şekilde açılır.
- Verileriniz exe'nin yanında değil, kullanıcı klasörünüzdeki `.8n8` klasöründe durur (program önceden 8n8 adını taşıdığı için klasör ve `N8N8_` ile başlayan ayarlar eski adıyla kaldı; eski verileriniz olduğu gibi açılır). Yeni sürüme geçerken yalnızca exe'yi değiştirmeniz yeterlidir.
- Ortam değişkenleri (aşağıda) exe ile de çalışır, örneğin `set PORT=5679 && Auto-Move.exe`.

### Node.js ile (Windows, macOS, Linux)

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

**Tetikleyiciler:** Manuel, Zamanlayıcı (aralık ya da cron ifadesi), Webhook (`/webhook/<yol>`, isteğe bağlı başlık / Bearer / Basic kimlik doğrulaması), Form (`/form/<yol>` adresinde hazır web formu), Sohbet (`/sohbet/<yol>` adresinde hazır sohbet sayfası), RSS yeni yazı, Telegram mesajı gelince, WhatsApp mesajı gelince, E-posta gelince (IMAP: her sağlayıcı), Gmail'e e-posta gelince, Outlook'a e-posta gelince, Slack'e mesaj gelince, Discord'a mesaj gelince, GitHub'da yeni konu / PR / sürüm / commit, Stripe olayı (ödeme, müşteri, iade, abonelik), Shopify'da yeni sipariş, WooCommerce'te yeni sipariş, Trendyol'da yeni sipariş, MQTT mesajı gelince, RabbitMQ mesajı gelince, Zendesk'te yeni talep, Veritabanında yeni satır (PostgreSQL, MySQL, SQLite), Jotform gönderimi gelince, Typeform cevabı gelince, MCP aracı (Claude çağırınca), Klasör izleyici, Hata tetikleyici, Alt akış girişi

**Node'lar (135 tür)**
- **Eylemler:** HTTP isteği, GraphQL, Web sayfası oku (başlık, okunabilir metin, bağlantılar), Webhook'a yanıt ver, Başka akışı çalıştır, RSS oku
- **Yapay zekâ:** Claude, Claude ajanı (araç kullanan, hafızalı ajan), Claude ile sınıflandır (her kategori ayrı çıkış), Claude ile bilgi çıkar (serbest metinden düzgün alanlar), Bilgi tabanı (belgelerinize göre cevap), Claude metin araçları (özetle, çevir, duygu analizi, yanıt taslağı, üslup değiştir, anahtar kelime, yazım düzelt), Ollama (bilgisayarınızda çalışan yerel modeller: soru sor, JSON cevap, embedding), DeepL çeviri (Türkçe dahil 30'dan fazla dil, resmî/samimi hitap), OpenAI uyumlu model (OpenAI, Gemini, Groq, OpenRouter, Mistral, DeepSeek, LM Studio: soru sor, JSON cevap, embedding)
- **Uygulamalar:** Gmail, Google Drive, Google Takvim, Google E-Tablolar, Google Dokümanlar (şablondan sözleşme / teklif ve PDF'i), Outlook (Microsoft 365), Microsoft Teams, Slack, Discord, Notion, Airtable, GitHub, Veritabanı (PostgreSQL, MySQL / MariaDB, SQLite), Telegram, WhatsApp Business, Facebook sayfası ve Instagram (paylaşım, fotoğraf, yorumlar ve yanıt), Slack / Discord webhook, E-posta (SMTP)
- **Ödeme ve e-ticaret:** Stripe (ödeme bağlantısı, müşteri, ödemeler, iade), Shopify (siparişler, not/etiket, ürünler, stok), WooCommerce (siparişler, durum, not, ürünler, stok)
- **İş takibi, CRM, destek ve pazarlama:** Trello, Jira Cloud, Asana, ClickUp, Todoist, HubSpot, Pipedrive (kişi, fırsat, not, aktivite), Zendesk (talep aç, yanıtla, ara), Mailchimp, Brevo (e-posta, SMS, kişi listeleri)
- **SMS ve bildirim:** Netgsm (Türkiye, Türkçe karakterli) ve Twilio SMS; ntfy ve Pushover ile telefona anlık bildirim
- **Ödeme (Türkiye):** iyzico ödeme bağlantısı (iyzilink), bağlantı listesi, ödeme sorgulama
- **Pazaryeri ve muhasebe (Türkiye):** Trendyol (siparişler, paket durumu, fatura bağlantısı, stok ve fiyat, müşteri soruları), Paraşüt (müşteri, satış faturası, tahsilat, e-Fatura / e-Arşiv), Odoo ERP
- **Depolama ve sunucular:** S3 (Amazon S3, Cloudflare R2, MinIO, Wasabi): yükle, indir, listele, sil, süreli paylaşım bağlantısı; Dropbox ve OneDrive: yükle, indir, listele, taşı, sil, paylaşım bağlantısı; FTP / FTPS; SFTP ve SSH komutu; Redis; NocoDB; MongoDB (Atlas dahil); Supabase; Elasticsearch / OpenSearch; MQTT (IoT, akıllı ev); RabbitMQ (kuyruk ve değişime gönder, kuyruktan al)
- **Veri:** Veri tablosu, Alanları ayarla, Alanları yeniden adlandır, Filtrele, Sırala, Sınırla, Tekrarları kaldır, Yeni öğeleri bul, Listeyi ayır, Topla, Özetle, Veri setlerini karşılaştır, Tarih ve saat, Şifreleme / hash, Dosya oku, Dosyaya yaz (JSON, CSV, metin), Döviz kuru (TCMB), Hava durumu, QR kod oluştur, PDF oluştur (başlık, metin, tablo, resim, sayfa numarası), ZIP sıkıştır / aç, Takvim daveti (.ics), İş günü ve resmî tatiller, JWT (imzala, doğrula, çöz), İki adımlı kod (TOTP: üret, doğrula, yeni anahtar)
- **Ağ:** Ağ kontrolü (site açık mı ve yanıt süresi, SSL sertifikasının bitişine kalan gün, port açık mı, DNS kayıtları)
- **Dönüştürme:** HTML'den veri çıkar (CSS seçici), XML ⇄ JSON, Markdown ⇄ HTML, Metin işlemleri
- **Mantık ve akış:** Doğrula (T.C. kimlik no, vergi no, IBAN, telefon, e-posta, kart numarası; geçerli/geçersiz çıkışları), Onay bekle, Döngü (parça parça işle), Eğer, Yönlendir (switch), Birleştir, Kod (JavaScript), Bekle, Hiçbir şey yapma, Hata ver, Komut çalıştır (isteğe bağlı açılır)
- **Tuval:** Not

**Döngü:** Döngü node'u öğeleri parça parça işler. "Döngü" çıkışından işlenecek adımlara gidin, son adımı yeniden Döngü node'una bağlayın; bütün parçalar bitince "Bitti" çıkışı devam eder. Geriye dönen bağlantılar yalnızca Döngü node'una girebilir.

**Veri tabloları:** Tablolar sayfasında programın içinde tablo oluşturun, hücreleri yerinde düzenleyin, CSV içe ve dışa aktarın. Veri tablosu node'u satır ekler, varsa günceller, arar, günceller ve siler.

**Claude ajanı:** Ajan; web isteği, hesap makinesi, saat, veri tabloları, bilgi tabanı ve araç olarak seçtiğiniz başka akışları kendisi kullanarak cevap verir. Sohbet tetikleyicisiyle birlikte konuşma geçmişini hatırlar (akış ayarlarındaki "Hafızayı temizle" ile sıfırlanır).

**Veritabanları ve Google E-Tablolar:** Veritabanı node'u SQL sorgusu çalıştırır ya da tablo adı ve eşleştirme sütunuyla satır okur, ekler, ekler-ya-da-günceller, günceller ve siler. Değerleri SQL'e `$1, $2` yer tutucularıyla verin; bu SQL enjeksiyonuna karşı korur. Google E-Tablolar için Google Cloud'da bir hizmet hesabı açıp JSON anahtarını kimlik bilgisi olarak ekleyin ve tabloyu o hesabın e-posta adresiyle paylaşın.

**Google hesabı ve OAuth:** Gmail, Drive, Takvim ve E-Tablolar için Kimlik bilgileri sayfasında "Google hesabı" ekleyin:
1. [Google Cloud Console](https://console.cloud.google.com)'da bir proje açın; Gmail, Drive, Calendar ve Sheets API'lerini etkinleştirin.
2. "OAuth izin ekranı"nı ayarlayın (Harici; kendinizi test kullanıcısı olarak ekleyin).
3. "Kimlik bilgileri → OAuth istemci kimliği → Web uygulaması" oluşturun ve Auto-Move'un gösterdiği yönlendirme adresini (`http://localhost:5678/oauth/callback`) ekleyin.
4. İstemci kimliğini ve gizli anahtarı Auto-Move'a girip "Hesaba bağlan"a basın. Oturum süresi dolunca Auto-Move kendiliğinden yeniler.

**Microsoft hesabı (Outlook, OneDrive):** Kimlik bilgileri sayfasında "Microsoft hesabı" ekleyin:
1. [Azure portalı](https://portal.azure.com)'nda Microsoft Entra ID → Uygulama kayıtları → Yeni kayıt açın. Hesap türü olarak "herhangi bir kuruluş dizini ve kişisel Microsoft hesapları"nı seçin.
2. Yönlendirme adresi olarak platform "Web" ile Auto-Move'un gösterdiği adresi ekleyin.
3. Sertifikalar ve gizli diziler → Yeni istemci gizli dizisi oluşturun ve "Değer"i kopyalayın.
4. Uygulama (istemci) kimliğini ve gizli diziyi Auto-Move'a girip "Hesaba bağlan"a basın. Outlook node'u e-posta gönderir, okur, yanıtlar, okundu işaretler ve siler; OneDrive node'u dosya yükler (büyük dosyalar parça parça), indirir, listeler, siler ve paylaşım bağlantısı oluşturur. HTTP isteği node'unda da bu kimlik bilgisiyle Microsoft Graph'a istek atabilirsiniz. Bu sürümden önce bağladığınız Microsoft hesabıyla OneDrive'ı kullanmak için kimlik bilgisinde "Hesaba bağlan"a bir kez daha basın; dosya izni yeni eklendi.

**Slack:** [api.slack.com/apps](https://api.slack.com/apps)'te bir uygulama açın, OAuth & Permissions'ta `chat:write`, `channels:read`, `channels:history`, `reactions:write` izinlerini ekleyip çalışma alanına kurun ve "Bot User OAuth Token"ı (`xoxb-…`) kimlik bilgisi olarak girin. Botu kanala `/invite @bot` ile ekleyin. Kanalı `#genel` gibi adıyla yazabilirsiniz. Slack node'u mesaj gönderir (konuya yanıt dahil), günceller, tepki ekler, kanal mesajlarını ve kanalları listeler; "Slack'e mesaj gelince" tetikleyicisi kanaldaki yeni insan mesajlarında akışı başlatır.

**Notion:** [notion.so/my-integrations](https://www.notion.so/my-integrations)'da bir entegrasyon açın, anahtarını kimlik bilgisi olarak girin ve kullanacağınız veritabanında ••• → Bağlantılar'dan entegrasyonu ekleyin. Veritabanı alanına tarayıcıdaki bağlantıyı yapıştırabilirsiniz. Notion node'u veritabanını sorgular (isteğe bağlı Notion filtresiyle), satır ekler, sayfayı günceller, sayfaya metin ekler, arşivler ve arama yapar. Satır eklerken "sütun adı = değer" yazmanız yeter; metin, sayı, seçim, çoklu seçim, tarih, onay kutusu gibi türler veritabanından okunur.

**GitHub:** github.com → Settings → Developer settings → Fine-grained tokens'tan bir anahtar oluşturun (Issues, Contents, Pull requests: okuma-yazma). GitHub node'u konu açar, yorum yazar, kapatır, konuları, PR'ları ve sürümleri listeler, depodaki bir dosyayı okur ya da kaydeder (commit). Depo alanına `sahip/depo` ya da depo bağlantısı yazılır.

**Airtable:** [airtable.com/create/tokens](https://airtable.com/create/tokens)'da `data.records:read`, `data.records:write` izinli bir anahtar açın ve tabanınızı ekleyin. Taban alanına tablonun tarayıcıdaki bağlantısını yapıştırmanız yeterli. Airtable node'u formülle filtreleyerek listeler, getirir, ekler, günceller, bir alana göre ekler-ya-da-günceller ve siler; kayıtları Airtable'ın sınırına uygun olarak 10'arlı gruplar halinde gönderir.

**Discord:** [discord.com/developers](https://discord.com/developers/applications)'da bir uygulama ve bot açın, bot token'ını girin, mesaj okuyacaksanız "Message Content Intent"i açın ve botu sunucunuza ekleyin. Discord node'u mesaj ya da renkli kart (embed) gönderir, yanıtlar, düzenler, siler, tepki ekler, kanal mesajlarını ve sunucu kanallarını listeler. Kanal kimliği için Discord'da Geliştirici modunu açıp kanala sağ tıklayın.

Aynı yolla "OAuth2 (başka servisler)" türüyle Spotify gibi servislere bağlanıp HTTP isteği node'unda kullanabilirsiniz.

**Claude ile sınıflandır ve bilgi çıkar:** Sınıflandır node'una kategorileri ve ne zaman seçileceklerini yazın; her kategori ayrı bir çıkış olur, uymayanlar "Diğer"den çıkar. Bilgi çıkar node'una alanları `ad:tür = açıklama` biçiminde yazın (türler: metin, sayı, tamsayı, evet-hayır, liste, tarih); Claude metinde olmayanları boş bırakır. İkisi de Claude'un yapılandırılmış çıktısını kullandığı için yanıt her zaman bu alanlara uyar. Varsayılan model ucuz ve hızlı olan Haiku'dur.

**Bilgi tabanı (belgelerinize göre cevap):** "Bilgi tabanı" sayfasından bir taban açıp SSS, ürün bilgisi, fiyat listesi gibi belgeleri yükleyin (.pdf, .docx, .xlsx, .pptx, .odt, .txt, .md, .csv, .json, .html) ya da bir web sayfasını adresiyle ekleyin. Belgeler bölümlere ayrılır ve bilgisayarınızda aranır; "Bilgi tabanı" node'u soruya en uygun bölümleri bulup yalnızca onları Claude'a gönderir. Claude yalnızca bu bölümlere dayanarak cevap verir, hangi belgelere dayandığını yazar, cevap belgelerde yoksa bunu söyler (`bilgiBulundu: false`). Node bölümleri yalnızca bulabilir ya da akıştan belge ekleyebilir. Claude ajanına da araç olarak verilebilir. Arama Türkçe kelime köklerini tanır ("iadeler" "iade"yi bulur) ama anlam araması değildir; farklı kelimelerle sorulan sorularda belgeye eş anlamlıları da yazmak işe yarar.

**PDF, Excel ve dosya yükleme:** "Dosya oku" node'u Excel (.xlsx) dosyasının her satırını bir öğe yapar (sayfa seçilebilir, tarihler `YYYY-AA-GG` olur) ve PDF, Word, PowerPoint ve OpenDocument belgelerinin metnini çıkarır. "Dosyaya yaz" öğeleri Excel dosyası olarak yazabilir. Tablolar sayfasından Excel dosyası içe aktarılıp Excel olarak indirilebilir. Forma "Dosya" türünde alan ekleyebilirsiniz; webhook'lar da `multipart/form-data` ile gönderilen dosyaları alır. Yüklenen dosyalar dosya klasöründe `yuklemeler/<tarih>/` altına kaydedilir ve öğede `{ ad, tur, boyut, dosya }` olarak görünür; `{{ $json.cv.dosya }}` ile "Dosya oku"ya verebilirsiniz. Taranmış (yalnızca resim olan) ve şifreli PDF'lerden metin çıkarılamaz; eski .xls dosyalarını Excel'de .xlsx olarak kaydedin.

**E-posta (IMAP):** "E-posta gelince (IMAP)" tetikleyicisi Yandex, Outlook.com, iCloud, şirket postası ve uygulama şifresiyle Gmail dahil IMAP destekleyen her hesapla çalışır. Kimlik bilgileri sayfasından "IMAP (gelen e-posta)" ekleyin (ör. `imap.yandex.com.tr`, 993). Gönderici ve konuya göre süzebilir, ekleri `dosyalar/eposta-ekleri/<tarih>/` altına kaydedip `ekler[].dosya` olarak verir, işlenen e-postaları okundu işaretleyebilir. Türkçe karakter kodlamaları (UTF-8, ISO-8859-9, Windows-1254) çözülür. İlk kontrolde mevcut e-postalar yalnızca hatırlanır.

**WhatsApp Business:** Meta'nın WhatsApp Cloud API'si ile mesaj, onaylı şablon, belge ve resim gönderir; gelen mesajları "WhatsApp mesajı gelince" tetikleyicisiyle alır. Kimlik bilgisine erişim anahtarını, telefon numarası kimliğini, kendi seçtiğiniz bir doğrulama sözcüğünü ve (önerilir) uygulama gizli anahtarını girin. Tetikleyicideki `/whatsapp/<yol>` adresini Meta'daki WhatsApp → Configuration sayfasına girin; adres internetten erişilebilir olmalıdır (tünel ve `N8N8_URL`). Müşteri size son 24 saatte yazmadıysa WhatsApp yalnızca şablon mesajına izin verir.

**Claude ile dosya okuma:** "Claude ile bilgi çıkar" node'unda Kaynak olarak "Dosya" seçip bir PDF, fotoğraf ya da belge verin; taranmış faturalar ve fiş fotoğrafları da okunur. "Claude" node'unda "Dosya ekle" ile istemle birlikte bir dosya gönderilebilir. PDF ve resimler Claude'a olduğu gibi gönderilir (en fazla 30 MB), diğer belgelerin metni gönderilir.

**Ödeme ve e-ticaret:** Stripe için dashboard.stripe.com → Developers → API keys'ten gizli anahtarı girin (denemek için `sk_test_…`). "Ödeme bağlantısı oluştur" tutardan ürün fiyatı ve paylaşılabilir ödeme bağlantısı üretir; "1.250,50" gibi Türkçe yazılmış tutarlar doğru okunur. Shopify için yönetim panelinde Settings → Apps → Develop apps'ten bir uygulama açıp siparişler, ürünler ve stok için izin verin, Admin API anahtarını (`shpat_…`) girin. WooCommerce için WordPress'te WooCommerce → Ayarlar → Gelişmiş → REST API'den okuma/yazma anahtarı oluşturun. Stok, ürün SKU'suna göre ayarlanır. Tetikleyiciler mağazayı düzenli kontrol eder (webhook kurmak gerekmez); ilk kontrolde mevcut kayıtlar yalnızca hatırlanır.

**Trello, Jira, HubSpot, Mailchimp:** Trello'da kart oluşturur, taşır, yorum ekler, listedeki kartları getirir. Jira Cloud'da kayıt açar, JQL ile arar, yorum ekler ve durumunu sütun adıyla değiştirir ("Done", "Tamamlandı"). HubSpot'ta kişiyi e-postasına göre ekler ya da günceller ve kişiye bağlı fırsat açar. Mailchimp'te aboneyi ekler ya da günceller (isteğe bağlı çift onay), etiketler, aboneliği iptal eder.

**SMS:** Netgsm için abone numaranızı, API yetkili kullanıcının şifresini ve onaylı mesaj başlığınızı girin; numaralar 05xx, 5xx ya da +90 biçiminde yazılabilir. Twilio için Account SID, Auth token ve gönderen numarayı girin.

**Döviz, hava durumu, QR, doğrulama:** Döviz kuru node'u TCMB'nin günlük kurlarıyla tutarı çevirir; geçmiş bir tarih verilirse o günün, hafta sonu ya da tatilse önceki iş gününün kuru kullanılır. Hava durumu node'u Open-Meteo'dan şu anki durumu ve 16 güne kadar tahmini Türkçe açıklamayla getirir. İkisi de anahtar istemez. QR kod node'u PNG ya da SVG üretip dosya klasörüne kaydeder; e-postaya ek olarak ya da `data:` adresiyle HTML'e gömülebilir. Doğrula node'u internete bağlanmadan kontrol hanelerini hesaplar ve değeri düzgün biçime çevirir (IBAN'ı dörderli gruplar, telefonu +90 ile); kart numarasının yalnız son 4 hanesini çıkışa verir.

**PDF oluştur:** Başlık, içerik ve isteğe bağlı tablo ve resimden PDF üretir. İçerikte `# başlık`, `## alt başlık`, `- madde`, `---` (çizgi), `[sayfa]` (yeni sayfa) ve `**kalın paragraf**` kullanılabilir. Tablo, öğedeki bir listeden (`{{ $json.urunler }}`) ya da "Bütün öğeler tek PDF" seçilince gelen öğelerin hepsinden oluşur; sayı sütunları sağa yaslanır, uzun tablolar başlığı tekrarlayarak sonraki sayfaya geçer. QR kod ya da logo için PNG/JPEG eklenebilir. Türkçe harfler gömülü yazı tipi gerektirmeden yerleşik Helvetica ile yazılır; bu yazı tipinde olmayan harfler (ör. Arapça, Kiril) "?" olarak çıkar.

**E-posta ekleri:** E-posta (SMTP) node'unun "Ekler" alanına dosya klasöründeki dosyaları virgülle yazın, örneğin `{{ $json.pdf.dosya }}, {{ $json.takvim.dosya }}`.

**S3, FTP, Redis:** S3 kimlik bilgisinde Amazon S3 için uç noktayı boş bırakın; Cloudflare R2, MinIO gibi servislerde uç nokta adresini girin. FTP node'u düz FTP'yi ve şifreli FTPS'i (AUTH TLS) destekler; SFTP için SFTP node'unu kullanın. Redis node'u akışlar arasında paylaşılan sayaç, kuyruk ve önbellek için kullanılabilir; FLUSHALL gibi tehlikeli komutlar engellidir.

**Komut çalıştır:** Güvenlik için kapalı gelir. Açmak için programı `N8N8_ALLOW_COMMANDS=1` ile başlatın. Komutlar dosya klasöründe çalışır. Dışarıdan gelen veriyi (form, webhook) komutun içine koymayın; kötü niyetli biri bilgisayarınızda komut çalıştırabilir.

**MongoDB, Supabase, Elasticsearch:** MongoDB kimlik bilgisine Atlas'ın verdiği `mongodb+srv://…` adresini ya da `mongodb://kullanici:sifre@sunucu:27017/veritabani` adresini yapıştırın. Filtreler MongoDB'nin kendi JSON sorgu dilidir; 24 haneli `_id` metni kendiliğinden ObjectId'ye, `{"$date": "2026-01-01"}` tarihe çevrilir. Filtresiz güncelleme ve silme, "Eşleşen hepsine uygula" açılmadan çalışmaz. Supabase için Project Settings → API'den proje adresini ve `service_role` anahtarını girin; filtreleri `durum = yeni`, `tutar > 100`, `ad ~ ali` (içerir) gibi satır satır yazın. Elasticsearch ve OpenSearch için adres ile kullanıcı adı/şifre ya da API anahtarı yeterlidir.

**MQTT:** "MQTT gönder" bir konuya mesaj yayınlar; "MQTT mesajı gelince" konulara abone olur (`ev/+/sicaklik`, `sensor/#`) ve gelen her mesajda akışı çalıştırır. Bağlantı akış etkinken açık kalır, mesajlar en geç kontrol sıklığı kadar (varsayılan 5 saniye) sonra işlenir. TCP ve TLS desteklenir; WebSocket üzerinden MQTT desteklenmez.

**Trendyol:** Satıcı panelinde Hesap Bilgilerim → Entegrasyon Bilgileri'nden Satıcı ID, API Key ve API Secret'ı alın. "Trendyol'da yeni sipariş" tetikleyicisi Oluşturuldu durumundaki yeni paketlerde akışı başlatır. Paket durumu güncellenirken siparişin `urunler` listesi doğrudan verilebilir. Stok ve fiyat güncellemesi Trendyol'da sıraya alınır; dönen işlem numarasıyla "Toplu işlem sonucunu sorgula" kullanılabilir.

**Paraşüt:** API erişimi için Paraşüt destekten Client ID ve Client Secret isteyin; firma numarası Paraşüt adresindeki sayıdır. Fatura satırlarını `[{ "ad": "Kupa", "adet": 2, "fiyat": 100, "kdv": 20 }]` biçiminde ya da `{{ $json.urunler }}` ile verin; pazaryeri fiyatları KDV dahilse "Fiyatlar KDV dahil"i açın. "e-Fatura / e-Arşiv'e dönüştür" müşterinin vergi numarası e-Fatura'ya kayıtlıysa e-Fatura, değilse e-Arşiv düzenler.

**Odoo:** Adres, veritabanı adı, kullanıcı e-postası ve şifre ya da API anahtarı yeterlidir. Herhangi bir modelde (res.partner, sale.order, crm.lead…) Odoo'nun domain biçimiyle (`[["is_company", "=", true]]`) arama yapar, kayıt oluşturur, günceller ve siler.

**JWT, iki adımlı kod ve ağ kontrolü:** JWT node'u HS256/384/512, RS256/384/512 ve ES256/384 ile belirteç imzalar ve doğrular; doğrulamada süre (`exp`) de denetlenir. İki adımlı kod node'u Google Authenticator uyumlu kodları üretir ve doğrular; "Yeni gizli anahtar" bir `otpauth://` adresi verir, QR kod node'una verilerek telefona okutulabilir. Ağ kontrolü node'u site izleme akışları içindir: "Web sitesi ve SSL izleme" şablonu site kapanınca ya da sertifikanın bitmesine 14 günden az kalınca telefona bildirim gönderir.

**SSH komutu ve SFTP:** Kimlik bilgisine sunucu adresini, kullanıcı adını ve şifreyi ya da özel anahtarı (OpenSSH, RSA, ed25519; parolalı olabilir) girin. "Bağlantıyı dene" sunucunun parmak izini gösterir; bunu "Sunucu parmak izi" alanına yapıştırırsanız program yalnızca o sunucuya bağlanır. SSH komutu çıktıyı, hata çıktısını ve çıkış kodunu verir; dışarıdan gelen veriyi (form, webhook) komutun içine koymayın. "Gece sunucu yedeği" şablonu yedeği alır, indirir ve Teams'e yazar.

**OpenAI uyumlu model:** OpenAI uyumlu API sunan her servisle çalışır; kimlik bilgisindeki yardım metninde Gemini, Groq, OpenRouter, Mistral, DeepSeek ve LM Studio adresleri yazar. "Cevap JSON olsun" açıkken cevap nesne olarak gelir. Claude için Claude node'larını kullanın.

**Google Dokümanlar:** Şablon belgede değişecek yerleri `{{ad}}`, `{{tutar}}` gibi yazın; "Şablondan belge oluştur" şablonun kopyasını açar, öğedeki aynı adlı alanları yerleştirir (şablon değişmez) ve isterseniz PDF'ini dosya klasörüne kaydeder. Google hesabında Drive izni yeterlidir. "Form başvurusu → sözleşme PDF" şablonu Jotform başvurusundan sözleşme hazırlayıp Brevo ile e-postayla yollar.

**Teams, Brevo, Todoist, NocoDB:** Teams için kanalda Workflows → "Post to a channel when a webhook request is received" şablonunu ekleyip verdiği adresi kimlik bilgisine yapıştırın; mesajlar başlıklı, alanlı ve düğmeli kart olarak gider. Brevo'da gönderen adresi Brevo'da doğrulanmış olmalıdır; Türk numaraları (0532…) kendiliğinden +90'a çevrilir. Todoist görev tarihini "yarın 10:00", "her pazartesi" gibi Türkçe anlar. NocoDB koşulları Supabase'deki gibi satır satır yazılır (`durum = yeni`, `tutar > 100`, `ad ~ ali`).

**Jotform ve Typeform tetikleyicileri:** Formun bağlantısını yapıştırmanız yeterlidir. Jotform cevapları sorunun alan adıyla (ad soyad tek metin olarak), Typeform cevapları soru başlığıyla ya da isterseniz ref adıyla gelir. AB'de açılmış Jotform hesaplarında bölgeyi "Avrupa" seçin.

**RabbitMQ:** Sunucu, port, kullanıcı adı, şifre ve sanal sunucu (vhost) yeterlidir; CloudAMQP gibi şifreli bağlantılarda "Şifreli bağlantı"yı açın ve portu 5671 yapın. Gönderilen her mesajın sunucuya ulaştığı onayla beklenir. "RabbitMQ mesajı gelince" kuyruğu kontrol sıklığında boşaltır ve her mesajda akışı çalıştırır; program kapalıyken gelen mesajlar kuyrukta bekler, kaybolmaz. İsterseniz tetikleyici kuyruğu bir topic değişimine (`siparis.*` gibi bir desenle) kendisi bağlar.

**Veritabanında yeni satır:** Tabloyu düzenli kontrol eder ve otomatik artan kimlik ya da oluşturma zamanı gibi hep büyüyen bir sütuna göre yeni satırları bulur. İlk kontrol yalnızca şimdiki en büyük değeri hatırlar; sonra eklenen her satır akışı bir kez çalıştırır. Güncellenen satırları görmez.

**Dropbox:** [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)'te "Scoped access" uygulaması açın; Permissions sekmesinde `files.content.write`, `files.content.read` ve `sharing.write` izinlerini işaretleyin, Settings'te Auto-Move'un gösterdiği yönlendirme adresini ekleyin. App key ve App secret'ı Auto-Move'a girip "Hesaba bağlan"a basın. Tek seferde en fazla 150 MB yüklenebilir.

**Pipedrive, Asana, ClickUp, Zendesk, DeepL:** Hepsi kişisel API anahtarıyla çalışır; nereden alınacağı kimlik bilgisi formunda yazar. Pipedrive'da "Kişiyi bul ya da ekle" e-postaya göre arar, varsa yeni kişi açmaz. Asana'da proje ya da görev için tarayıcıdaki adresi yapıştırmanız yeterlidir. DeepL'in ücretsiz anahtarları (`:fx` ile biten) kendiliğinden ücretsiz sunucuya gider.

**Facebook sayfası ve Instagram:** [developers.facebook.com](https://developers.facebook.com)'da bir uygulama açıp Graph API Gezgini'nden `pages_manage_posts`, `pages_read_engagement`, `instagram_basic` ve `instagram_content_publish` izinli uzun süreli bir sayfa erişim anahtarı alın. Instagram'da paylaşım için hesabın işletme ya da içerik üreticisi hesabı olması ve Facebook sayfasına bağlı olması gerekir; resim herkese açık bir https adresinden verilmelidir.

**Ollama:** [ollama.com](https://ollama.com)'dan Ollama'yı kurup bir model indirin (`ollama pull llama3.2`). Kimlik bilgisi seçilmezse bu bilgisayardaki Ollama (`http://localhost:11434`) kullanılır; veriler bilgisayardan çıkmaz.

**İş günü ve tatiller:** Türkiye resmî tatilleri, Ramazan ve Kurban bayramları ve arifeler (yarım gün) hesaba katılır. Bayram tarihleri Ümmü'l-Kurâ takviminden hesaplanır; 2024–2026 için Diyanet'in ilan ettiği tarihlerle aynıdır, sonraki yıllarda bir gün fark olabilir. Köprü izinleri ve şirket tatilleri "Ek tatil günleri" alanına yazılabilir.

**MCP aracı (akışlarınızı Claude'a araç olarak verin):** Akışa "MCP aracı" tetikleyicisi koyun, araç adını, açıklamasını ve girdilerini yazıp akışı etkinleştirin. Araç `http://localhost:5678/mcp/<adres>` adresinde yayınlanır; aynı adresteki bütün etkin araçlar tek sunucuda görünür. Claude Code'a eklemek için `claude mcp add --transport http Auto-Move http://localhost:5678/mcp/araclar` yazın; uzak (http) MCP sunucusu destekleyen diğer istemcilere de aynı adresi verin. Claude aracı çağırınca akış çalışır ve son node'un çıktısı sonuç olarak döner. Program başka bilgisayarlardan erişilebiliyorsa tetikleyicide kimlik doğrulamayı açın.

**Aynı anda çalışma sınırı:** Akış ayarlarında "Aynı anda en fazla çalıştırma"yı örneğin 1 yaparsanız webhook, zamanlayıcı, form ve diğer otomatik tetiklemeler sıraya girer ve birbirini beklemeden üst üste çalışmaz. Bekleme süresi zaman aşımına sayılmaz.

**Onay bekle:** Akış bu node'da durur ve bir onay sayfası açılır. Sayfanın adresini önceki bir node'da `{{ $execution.onayAdresi }}` ile e-posta ya da Telegram mesajına koyun; kişi "Onayla" ya da "Reddet"e basınca akış ilgili çıkıştan devam eder. Bekleme süresi akış zaman aşımına sayılmaz. Program kapanırsa bekleyen onaylar iptal olur.

**Bağlantıyı dene:** Kimlik bilgisi penceresindeki düğme Claude, Telegram, Slack, Discord, Notion, Airtable, GitHub, Stripe, Shopify, WooCommerce, Trello, Jira, HubSpot, Mailchimp, Netgsm, Twilio, iyzico, Pushover, S3, FTP, Redis, IMAP, WhatsApp, SMTP, veritabanı ve Google hizmet hesabı bilgilerinin çalışıp çalışmadığını kaydetmeden önce gösterir.

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
- Editör ve API yalnızca bu bilgisayarın adresiyle gelen isteklere yanıt verir; kötü niyetli bir web sitesi tarayıcınız üzerinden Auto-Move'a ulaşamaz.
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
| `N8N8_UPLOAD_MB` | `50` | Form ve webhook ile yüklenebilecek en büyük istek boyutu (MB) |
| `N8N8_CODE_MEMORY_MB` | `256` | Kod node'unun kullanabileceği en fazla bellek |
| `N8N8_ALLOW_COMMANDS` | kapalı | `1` yapılırsa "Komut çalıştır" node'u bilgisayarda komut çalıştırabilir |
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
- IMAP tetikleyicisi, WhatsApp node'ları ve Claude'a dosya gönderme gerçek hesaplarla değil, sahte sunucularla test edildi.
- Notion, Slack, Outlook, GitHub, Airtable ve Discord node'ları ve Microsoft girişi gerçek hesaplarla değil, resmî API belgelerine göre yazılmış sahte sunucularla test edildi.
- Stripe, Shopify, WooCommerce, Trello, Jira, HubSpot, Mailchimp, Netgsm ve Twilio node'ları, Claude metin araçları, TCMB döviz kuru ve hava durumu node'ları da gerçek hesaplarla ya da gerçek servislerle değil, belgelere göre yazılmış sahte sunucularla test edildi. QR kodlar bağımsız bir okuyucuyla (zxing) okunarak doğrulandı.
- iyzico, Pushover, ntfy, GraphQL, S3, FTP ve Redis node'ları da gerçek servislerle değil sahte sunucularla test edildi.
- MongoDB, Elasticsearch, Supabase, Odoo, Trendyol, Paraşüt ve Ollama node'ları gerçek servislerle değil, belgelere göre yazılmış sahte sunucularla test edildi. MongoDB'nin BSON kodlaması resmî Python sürücüsünün (pymongo) çıktısıyla birebir karşılaştırıldı, SCRAM-SHA-256 girişi RFC 7677 örnek değerleriyle doğrulandı. MQTT istemcisi gerçek bir Mosquitto 2.0 sunucusuyla denendi. TOTP ve JWT RFC 6238 ve jwt.io örnek değerleriyle doğrulandı. S3 imzası AWS'nin yayımladığı örnek değerlerle birebir doğrulandı. Oluşturulan PDF'ler poppler (pdftotext, pdftoppm) ile açılıp kontrol edildi.
- Dropbox, OneDrive, Pipedrive, Asana, ClickUp, DeepL, Zendesk ve Facebook / Instagram node'ları gerçek hesaplarla değil, resmî API belgelerine göre yazılmış sahte sunucularla test edildi. RabbitMQ node'ları otomatik testlerde sahte sunucuyla, ayrıca gerçek bir RabbitMQ 3 sunucusuyla (yanlış şifre, olmayan vhost, 300 KB mesaj, topic değişimi) denendi. Veritabanı tetikleyicisi SQLite ile test edildi.
- OpenAI uyumlu model, Google Dokümanlar, Teams, Brevo, Todoist, Jotform, Typeform ve NocoDB node'ları gerçek hesaplarla değil, resmî API belgelerine göre yazılmış sahte sunucularla test edildi. SSH komutu ve SFTP otomatik testlerde sahte sunucuyla, ayrıca gerçek bir OpenSSH 9 sunucusuyla (şifre, parolalı ed25519 anahtar, parmak izi doğrulama, 2 MB dosya gidiş dönüş) denendi.
- MongoDB node'u MongoDB 3.6 ve sonrasıyla, kullanıcı adı/şifre (SCRAM) girişiyle çalışır; X.509, LDAP ve Kerberos girişi desteklenmez. MQTT tetikleyicisi program açıkken bağlı kalır, kapalıyken gelen mesajları almaz.
- Özet sayfası saklanan çalıştırma kayıtlarından hesaplanır (`N8N8_MAX_EXECUTIONS`, varsayılan son 1000).
- Tek kullanıcı içindir; ekip hesabı ve yetki yönetimi yoktur.
- `Auto-Move.exe` GitHub'ın Windows Server makinesinde oluşturulup 67 testin tamamı exe'ye karşı çalıştırıldı ve geçti. Kişisel bir Windows 10/11 bilgisayarda (SmartScreen, antivirüs) ayrıca denenmedi.

## Test

```
npm test
ONLY=mongo npm test   # yalnız adında "mongo" geçen testler
```

Aynı testleri derlenmiş tek dosya programa karşı çalıştırmak için: `N8N8_TEST_EXE=dist/Auto-Move npm test`.

### Auto-Move.exe'yi yeniden oluşturmak

GitHub'da `main` dalına her gönderimde testler çalışır, Windows'ta `Auto-Move.exe` oluşturulur, açıldığı denenir ve `package.json`'daki sürüm numarasıyla Sürümler sayfasına yüklenir (`.github/workflows/exe.yml`). Kendi bilgisayarınızda oluşturmak için:

```
npm install --no-save esbuild postject resedit
node build-exe.js                       # dist/Auto-Move.exe (Windows)
N8N8_EXE_TARGET=linux node build-exe.js # dist/Auto-Move (bu bilgisayar için)
```

Komut, çalıştığı Node.js sürümünün Windows karşılığını nodejs.org'dan indirir, programı tek dosyada toplar ve Node.js'in "tek dosya uygulaması" (SEA) özelliğiyle exe'nin içine yerleştirir.

Testler (67 adet) geçici bir klasörde gerçek bir sunucu başlatır. Webhook, form, zamanlayıcı, alt akış, hata akışı, yeniden deneme, döngü, veri tabloları, sohbet ve Claude ajanı, Claude ile akış oluşturma, n8n içe aktarma, RSS ve klasör izleyici, Kod node'unun kısıtlı süreci, SQLite, Google E-Tablolar, Telegram tetikleyicisi, Google OAuth girişi ve token yenileme, Gmail, Drive, Takvim, Notion, Slack ve Slack tetikleyicisi, Microsoft girişi ve Outlook, GitHub, Airtable, Discord ve tetikleyicileri, yedekleme ve geri yükleme, Claude ile sınıflandırma ve bilgi çıkarma, bilgi tabanı (.docx ve PDF dahil belge yükleme, web sayfası, arama, belgelere dayalı cevap), Excel okuma/yazma ve tablo içe/dışa aktarma, form ve webhook ile dosya yükleme, IMAP e-posta tetikleyicisi, WhatsApp, Claude'a PDF ve resim gönderme, hata bildirimleri, çöp kutusu, şablonlar, MCP sunucusu, aynı anda çalışma sınırı, editörde hata ayıklama, Özet istatistikleri, onay bekleme, Stripe, Shopify, WooCommerce ve tetikleyicileri, Trello, Jira, HubSpot, Mailchimp, Netgsm ve Twilio SMS, TCMB döviz kuru, hava durumu, QR kod, doğrulama, Claude metin araçları, PDF oluşturma, ZIP, takvim daveti, e-posta ekleri, S3 imzası, FTP, Redis, komut çalıştırma, web sayfası okuma, GraphQL, ntfy, Pushover, iyzico, iş günü hesabı, MongoDB, MQTT ve tetikleyicisi, Elasticsearch, Supabase, Odoo, Trendyol ve tetikleyicisi, Paraşüt, JWT, TOTP, ağ kontrolü, Ollama, RabbitMQ ve tetikleyicisi, veritabanı tetikleyicisi, Dropbox ve OneDrive (OAuth girişi, büyük dosya yükleme dahil), Pipedrive, Asana, ClickUp, DeepL, Zendesk ve tetikleyicisi, Facebook ve Instagram, SSH ve SFTP, OpenAI uyumlu model, Teams, Brevo, Todoist, NocoDB, Google Dokümanlar, Jotform ve Typeform tetikleyicileri ve bozuk isteklere dayanıklılık denenir. Claude, Google, Microsoft, Notion, Slack, GitHub, Airtable, Discord, Telegram, WhatsApp, IMAP, SMTP, RSS, Stripe, Shopify, WooCommerce, Trello, Jira, HubSpot, Mailchimp, Netgsm, Twilio, TCMB, Open-Meteo, S3, FTP, Redis, iyzico, ntfy, Pushover, MongoDB, MQTT, Elasticsearch, Supabase, Odoo, Trendyol, Paraşüt, Ollama, RabbitMQ, Dropbox, OneDrive, Pipedrive, Asana, ClickUp, DeepL, Zendesk, Meta, SSH/SFTP, OpenAI uyumlu API, Teams, Brevo, Todoist, Jotform, Typeform, NocoDB ve Google Dokümanlar için sahte yerel sunucular kullanılır; internet ve API anahtarı gerekmez.
