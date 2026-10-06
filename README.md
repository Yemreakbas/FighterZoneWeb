# FighterZone

Tarayıcıda çalışan 3D dövüş oyunu (Mortal Kombat tarzı 1v1). Three.js ile render, PeerJS (WebRTC) ile P2P çok oyunculu.

- Build aracı yok: saf HTML, CSS, ES Modules; kütüphaneler CDN'den.
- Tüm yollar göreli (`./`). Cloudflare Pages'te alt klasörde (ör. `games/fighter-game/`) çalışır.

## Yerelde çalıştırma

ES modülleri `file://` üzerinden yüklenmez, statik bir sunucu gerekir:

```bash
python -m http.server 8080
# http://localhost:8080
```

## Testler

Simülasyon (dövüş kuralları, enerji topu, combo, ağ paketleri) için regresyon testleri `tests/` klasöründe. npm gerekmez, Node 18+ yeterli:

```bash
node --test
```

Denge ayarı (`js/config.js`) yaptıktan sonra çalıştırırsan kuralların bozulmadığını görürsün. `tests/` klasörü oyun tarafından yüklenmez, alt klasöre kopyalarken dahil etmen gerekmez.

## Cloudflare Pages'e yayınlama

Build adımı yok, dosyalar olduğu gibi yayınlanır.

**Tek başına site olarak:**
1. Cloudflare Dashboard → Workers & Pages → Create → Pages → bu repoyu bağla.
2. Framework preset: `None`, Build command: *(boş)*, Build output directory: `/`.
3. Deploy.

**Mevcut bir sitenin alt klasörü olarak (ör. `games/fighter-game/`):**
1. `index.html`, `style.css` ve `js/` klasörünü ana sitenin `games/fighter-game/` klasörüne kopyala.
2. Ana siteyi her zamanki gibi deploy et.

Tüm yollar göreli olduğu için oyun hangi klasörde olursa olsun çalışır. Adres sonunda `/` olmadan açılırsa (`.../fighter-game`) sayfa kendini otomatik olarak `.../fighter-game/` adresine yönlendirir.

**Dış bağımlılıklar** (CDN): Three.js (jsDelivr), PeerJS (unpkg), Google Fonts. P2P sinyalleşmesi için PeerJS'in ücretsiz genel sunucusu (`0.peerjs.com`) kullanılır. Bağlantı kurulduktan sonra oyun verisi doğrudan iki tarayıcı arasında akar.

> Not: Bazı kurumsal ağlar ve simetrik NAT arkasındaki bağlantılar, TURN sunucusu olmadan WebRTC ile eşleşemeyebilir. Bu durumda "WebRTC bağlantısı kurulamadı" hatası görünür.

## Modlar

- **Tek oyunculu (Bot):** Karakter seçim ekranında zorluk seçilir (KOLAY / NORMAL / ZOR, tarayıcıda hatırlanır). Bot her roundda bir kademe güçlenir: daha hızlı tepki verir, daha sık bloklar, daha çok kombo yapar. KOLAY'da tavanı düşük kalır, ZOR'da en baştan sert başlar.
- **Antrenman:** Süresiz, bitmeyen tek round. Kuklanın davranışı seçilir: DUR / BLOK / ALT BLOK / EĞİL / ZIPLA. Kombonun toplam hasarı kuklanın can barının altında görünür. Can, 1,2 saniye hasar almayınca dolar, K.O. olmaz. Çıkmak için Esc → Ana Menü.
- **Turnuva:** Seçtiğin karakterle diğer üç karakteri sırayla yen. Rakipler rastgele sırada gelir ve her aşama bir kademe zorlaşır (KOLAY → NORMAL → ZOR). Kaybedersen aynı aşamayı tekrar denersin, üçünü de yenersen şampiyon olursun. En iyi sonucun menüdeki butonda görünür.
- **Takım Maçı 2v2 (Bot):** Sen ve bir bot takım arkadaşı, iki bota karşı. Zorluk tek oyunculudaki gibi seçilir.
- **Oda Kur / Odaya Katıl (P2P):** Host 4 haneli bir kod alır, en fazla 3 kişi bu kodla bağlanır. Lobide herkes önce **ORTA**'ya düşer, isteyen KIRMIZI ya da MAVİ takıma geçer. Host modu seçer (1v1 / 2v2), **RASTGELE DAĞIT** ile herkesi rastgele takımlara dağıtabilir ve **BAŞLAT**'a basar. Başlarken ortada kalan oyuncular rastgele boş koltuklara yerleşir, 2v2'de boş koltuklara bot gelir. Maç sırasında çıkan oyuncunun yerine bot geçer. Simülasyon host'ta çalışır. Client her karede numaralı girdisini gönderir ve kendi karakterini anında yerelde tahmin eder (client prediction). Host'tan gelen durumla karşılaştırıp gerekirse yumuşakça düzeltir. Rakibi ise bağlantı kalitesine göre 50-150 ms arası ayarlanan bir tamponla ara değerleyerek çizer.

## Vuruş bağlama

Yerdeki bir yumruk ya da tekme isabet edince (bloklansa da) kalan toparlanmasını beklemek gerekmez. Bu sırada basılan daha güçlü hareket hemen çıkar: **yumruk → tekme / özel**, **tekme → özel**. Böylece seriler kesintisiz akar. Sadece yukarı doğru bağlanır (tekme yumruğa bağlanmaz). Boşa giden vuruş da süpürme de bağlanmaz, ikisi de cezalandırılabilir kalır. Bağlanan vuruşlar da aşağıdaki kombo kırıcıya tabidir.

## Kombo kırıcı

Bir dövüşçü sersemken üst üste en fazla **2 vuruş** yiyebilir. İkinci vuruşta geri savrulur, saldıran da biraz geri itilir. Ardından 0,6 saniye boyunca yanıp söner; bu sürede ona vuruş, fırlatma ya da enerji topu işlemez, o da hareket edebilir. Böylece köşeye sıkıştırıp yumruk spamlayarak sonsuz kombo yapılamaz.

## 2v2 kuralları

- Takım arkadaşına vuramazsın; takım arkadaşları birbirinin içinden geçebilir.
- Herkes en yakın, ayakta duran rakibe döner.
- Canı biten yere düşer ve roundun sonuna kadar yerde kalır. Bir takımın hepsi düşünce round biter.
- Süre dolarsa toplam canı fazla olan takım kazanır.
- Yerdeki halkanın rengi takımı, başının üstündeki sarı ok seni gösterir.
- FINISH HIM / FATALITY sadece 1v1'de var.

## Platformlar ve arena

Her arenada üç **katı** platform var:
- İki yanda **2,9 m**'de sabit platform. Dövüşçünün kafasının üstünde kaldığı için altlarından rahatça yürünür.
- Ortada **5,75 m**'de zincirle asılı, sağa sola gidip gelen **hareketli platform**. Üstündeki dövüşçüyü taşır. Yerden ulaşılmaz; yan platformdan, yaklaşırken ona doğru zıplayarak binilir.

Platformların içinden geçilmez: altından zıplarsan kafan çarpar, yandan gelirsen kenarına çarparsın. Platforma çıkmak için **yanından ona doğru zıpla** (ileri + W). Zıplama devam ederken ayakların kenarı aşınca üstüne çıkarsın; ayaklar kenardan biraz taşsa bile basılır. İnmek için kenardan yürü. Yerden zıplayan birinin kafası üstteki platforma hiçbir yükseklikte yetişmez, hareketli platform tırmanmayı kesmez. Fırlatma sadece aynı seviyedeki rakibe yapılır. Botlar da kenardan tırmanır, kenardan yürüyerek iner. Hareketli platformun konumu maç saatinden hesaplanır, online maçta herkes aynı yeri görür.

Yan platformlar arkadaki taş kemerlerin üstüne oturur. Arka planda kaideli sütunlar, demir kâseli ve haleli meşaleler, armalı ve hafifçe dalgalanan sancaklar var. Sınırlarda sandıklar ve fıçılar, yerde de arena amblemi duruyor. Zemin ve duvar dövüş alanında aydınlık, kenarlara doğru karanlık, ekranın kenarlarında da hafif bir vinyet var. Böylece göz dövüşe gider. Hepsi ekstra ışık kullanmadan çizilir.

## Karakterlere özel hareketler

Her karakterin özel hareketi kendine ait bir atıştır ve farklı bir savunma ister:

| Karakter | Özel hareket | Nasıl kaçılır |
|---|---|---|
| KOR | **Yer Dalgası**: yerden giden yavaş, güçlü dalga (×1,2 hasar) | Eğilmek işe yaramaz, üstünden zıpla ya da blokla |
| AYAZ | **Buz Topu**: dengeli enerji topu | Eğil, zıpla ya da blokla |
| KUZGUN | **Gölge Oku**: kafa hizasında, çok hızlı, küçük ok (×0,95 hasar) | Eğil |
| YILDIRIM | **Yıldırım Küresi**: iri, yavaş küre (×1,1 hasar) | Eğilmek yetmez; zıpla ya da blokla |

Farklı yükseklikteki atışlar birbirinin yanından geçer, sadece çarpışanlar birbirini yok eder. Bot gelen atışa göre eğilir, zıplar ya da bloklar. Değerler, botlar arasında her eşleşmeden 8 maçlık bir turnuvada karakterler %42-54 kazanacak şekilde ayarlandı.

## Güçlendirme kristalleri

Maç sırasında (antrenmanda değil) rastgele bir platformun üstünde dönen bir kristal belirir: ilki 12. saniyede, sonra her 18 saniyede bir. Hareketli platformdaki kristal platformla birlikte gider.

- **Yeşil kristal:** +25 can.
- **Mavi kristal:** özel hareketin bekleme süresini sıfırlar.

Dokunan alır. 10 saniye içinde kimse almazsa kaybolur. Botlar canları azken ya da özel hareketleri dolarken, yakınlarında rakip yoksa kristale gider. Online maçta kristali host belirler, herkes aynısını görür.

## Görsel

- Dövüşçüler kendi renklerinde kıyafet giyer: üstü karakter renginde, pantolonu aynı rengin koyu tonunda, kemer, sargı, eldiven ve botlar koyu. İnce koyu bir kontur onları arka plandan ayırır. Uzuvlar kapsül biçiminde olduğu için dirsek ve dizlerde boşluk görünmez.
- Her karakterin kendine özgü görünümü var:
  - **KOR:** iri yapı, dikenli omuz zırhı, boynuzlu kask.
  - **AYAZ:** buz mavisi eldivenler, savrulan bandana uçları.
  - **KUZGUN:** ince yapı, başlık ve hızla dalgalanan pelerin.
  - **YILDIRIM:** dikenli saç, göğsünde parlayan şimşek.
- Can barları parlak; yenen hasar arkada açık renkli bir iz olarak kalır ve kısa bir gecikmeyle erir. Can %25'in altına inince bar nabız gibi atar.
- Temiz vuruşlarda kıvılcımın yanında genişleyen bir şok halkası çıkar. Zıplayıp bir yüzeye inince küçük bir toz bulutu kalkar.
- Enerji topları sahibinin renginde bir haleyle parlar ve arkalarında kısa, sönen bir iz bırakır.
- Arenada meşalelerden kıvılcımlar yükselir (tek çizim çağrısı).

## Müzik

Maç sırasında, tıpkı ses efektleri gibi Web Audio ile kodda üretilen bir müzik çalar: 132 BPM, Am–F–G–E akorlarında 4 ölçülük döngü. Bas, davul, hi-hat ve arada bir arpej var. Notalar ses saatine göre biraz önceden planlandığı için oyun yoğunken de tempo kaymaz. Maç bitince susar, menüde çalmaz. Ses dosyası yoktur.

## Performans

- Menüde **GRAFİK** ayarı var: OTO / DÜŞÜK / ORTA / YÜKSEK (tarayıcıda hatırlanır).
  - DÜŞÜK: gölge yok, çözünürlük 0,85x.
  - ORTA: 1024'lük gölge, en fazla 1,25x.
  - YÜKSEK: 2048'lik gölge, en fazla 1,75x.
- OTO'da telefonlar ORTA, diğer cihazlar YÜKSEK ile başlar. Kare hızı 2 saniye boyunca ortalama 50 fps'in altında kalırsa kalite kendiliğinden bir kademe düşer.
- Telefonlarda kenar yumuşatma (MSAA) kapalı. Gölge filtresi her cihazda ucuz PCF; gölge kamerası arenaya sıkı oturur.
- Sahnede sadece 3 nokta ışık var: iki renkli kenar ışığı ve vuruş parlaması. Enerji topları ve meşaleler ışık yerine parlak malzeme ve hale sprite'larıyla çizilir. Zemin ve duvardaki aydınlık-karanlık geçişi köşe renklerine işlenmiştir, vinyet ise CSS ile çizilir. İkisinin de GPU maliyeti yok denecek kadar azdır.
- Açılışta tüm shader'lar önceden derlenir, böylece ilk enerji topu, kristal ya da fatality'de takılma olmaz.
- Dövüşçüler gölge alma hesabı yapmaz, sabit dekor her karede matris güncellemez.

## Özel hareket bekleme süresi

Özel hareket (enerji topu) kullanıldıktan sonra **3 saniye** dolması gerekir. Can barının altındaki mavi çubuk dolunca parlar ve hareket hazırdır. Dolmadan basılırsa hiçbir şey olmaz. FINISH HIM başladığında kazananın çubuğu anında dolar, fatality her zaman mümkündür.

## Fırlatma

Rakibe yapışıkken **ileri + yumruk** onu tutup omzunun üstünden arkana fırlatır (13 hasar). Fırlatma bloğu deler, yani sürekli blok yapan rakibin cevabıdır. Karşılığında:

- Vuruş yemekte (hitstun) olan, havadaki ya da blok sersemliğindeki rakip tutulamaz.
- Önce gelen yumruk/tekme fırlatmayı bozar.
- Boşa giden fırlatmanın toparlanması uzundur, ceza yersin.

Bot da blok yapan ya da eğilip bekleyen rakibe fırlatma dener.

## Süpürme ve alt blok

**Eğilip tekme** atmak bir süpürmedir: alçaktan vurur ve rakibi ayağından alıp sırt üstü yere serer (9 hasar, yere düşünce kısa sersemleme). Ayakta blok süpürmeyi durdurmaz. Sadece **aşağı + blok** ile yapılan alt blok durdurur. Karşılığında süpürmenin toparlanması normal tekmeden uzundur, bloklanırsa ya da boşa giderse ceza yersin.

Böylece savunmada tahmin oyunu oluşur: ayakta blok süpürmeye, alt blok ise fırlatmaya açıktır (fırlatma her bloğu deler). Bot, süpürme gördüğünde alt blok yapar, ayakta blok yapan rakibe de zaman zaman süpürme atar.

## FINISH HIM

Maçı belirleyen K.O.'da rakip yere düşmez, sersemlemiş halde ayakta kalır ve **FINISH HIM!** anonsu gelir. Kazananın 4 saniyesi var:

- **Özel hareket** (enerji topu) isabet ederse **FATALITY**: rakip parçalara ayrılır.
- Normal vuruşlar rakibi sadece sendeletir, yani K.O.'dan sonra tuşlara basmaya devam etsen de şansını kaybetmezsin.
- Süre dolarsa rakip kendiliğinden yere yığılır.

Bot da kazandığında zaman zaman fatality dener.

## Karakterler

| Karakter | Özellik |
|----------|---------|
| KOR | Güçlü ama yavaş, yavaş enerji topu |
| AYAZ | Dengeli, en hızlı enerji topu |
| KUZGUN | Çevik ama vuruşları zayıf |
| YILDIRIM | En hızlısı, yavaş ama ağır enerji topu |

**Arenalar:** Zindan ve Tapınak. Her maç rastgele birinde oynanır; online maçta arenayı host seçer. Yeni arena eklemek için `js/config.js` içindeki `ARENAS` listesine renk ve doku paletiyle bir satır eklemen yeterli.

Değerler `js/config.js` içindeki `CHARACTERS` listesinde. Yeni karakter eklemek için listeye bir satır eklemen yeterli, seçim ekranı otomatik güncellenir.

## Kontroller

| Tuş | Aksiyon |
|-----|---------|
| A / D (← / →) | Sol / Sağ |
| W (↑ / Space) | Zıpla |
| S (↓) | Eğil |
| J | Yumruk |
| K | Tekme |
| U | Özel hareket (enerji topu) |
| L | Blok |
| M | Sesi aç / kapat |
| N | Müziği aç / kapat (tarayıcıda hatırlanır; dokunmatikte ❚❚ → MÜZİK) |
| Esc | Duraklat (online maçta oyun arka planda sürer) |

**Gamepad** (Xbox / PlayStation, tarayıcının standart eşlemesi): D-pad veya sol analog hareket, ↑ zıpla, ↓ eğil · X [□] yumruk · A [✕] tekme · B [○] özel · LB / RB / RT blok · Start duraklat. Menüler fare, klavye ya da dokunmatikle kullanılıyor.

Dokunmatik cihazlarda ekranda yön tuşları ve YUMRUK / TEKME / ÖZEL / BLOK butonları çıkar.

**Mobil:**
- Oyun yatay ekran için tasarlandı. Telefon dikey tutulunca "yan çevir" uyarısı çıkar ve tek oyunculu maç duraklar.
- Ana menüdeki **TAM EKRAN** tarayıcı çubuklarını gizler ve destekleyen tarayıcılarda (Android Chrome) ekranı yataya kilitler.
- Platforma çıkmak için yanından ona doğru ▶ (ya da ◀) basılıyken ▲'ye dokun; inmek için kenardan yürü.
- ÖZEL butonu bekleme süresince sönük durur ve alttan dolar.
- Kısa ekranlarda HUD, menüler ve lobi sıkıştırılır, kamera dövüşçülere biraz yaklaşır.

## Yapı

```
index.html         Giriş noktası, UI overlay, import map
style.css          Menü + HUD stilleri
js/config.js       Ayar sabitleri (fizik, saldırılar, bot, ağ)
js/main.js         Boot, oturumlar (solo / host / client), oyun döngüsü
js/game.js         Maç akışı: round, süre, K.O.
js/fighter.js      Dövüşçü simülasyonu ve AABB hitbox/hurtbox
js/bot.js          Yapay zeka rakip
js/input.js        Klavye girdisi
js/fighterView.js  Primitive model + prosedürel animasyon
js/effects.js      Vuruş kıvılcımları
js/sound.js        WebAudio ile prosedürel ses efektleri
js/scene.js        Renderer, kamera, ışıklar, arena
js/ui.js           Ekran yönetimi, can barları, anons
js/network.js      PeerJS host/join, heartbeat
js/netsync.js      Durum paketleri, girdi kuyruğu, client interpolasyonu
js/prediction.js   Client tarafı tahmin ve uzlaştırma
```
