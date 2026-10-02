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

- **Tek oyunculu (Bot):** Bot her roundda biraz daha hızlı tepki veriyor, daha sık blokluyor ve daha çok kombo yapıyor.
- **Oda Kur / Odaya Katıl (P2P):** Host 4 haneli bir kod alır, rakip bu kodla bağlanır. Simülasyon host'ta çalışır. Client sadece tuş girdisi gönderir ve host'tan gelen durumu bağlantı kalitesine göre 50-150 ms arası ayarlanan bir tamponla ara değerleyerek çizer.

## Karakterler

| Karakter | Özellik |
|----------|---------|
| KOR | Güçlü ama yavaş, yavaş enerji topu |
| AYAZ | Dengeli, en hızlı enerji topu |
| KUZGUN | Çevik ama vuruşları zayıf |

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
| Esc | Duraklat (online maçta oyun arka planda sürer) |

**Gamepad** (Xbox / PlayStation, tarayıcının standart eşlemesi): D-pad veya sol analog hareket, ↑ zıpla, ↓ eğil · X [□] yumruk · A [✕] tekme · B [○] özel · LB / RB / RT blok · Start duraklat. Menüler fare, klavye ya da dokunmatikle kullanılıyor.

Dokunmatik cihazlarda ekranda yön tuşları ve YUMRUK / TEKME / ÖZEL / BLOK butonları çıkar.

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
js/netsync.js      Durum paketleri ve client interpolasyonu
```
