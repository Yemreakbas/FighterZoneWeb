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

## Modlar

- **Tek oyunculu (Bot):** Bot her roundda biraz daha hızlı tepki veriyor, daha sık blokluyor ve daha çok kombo yapıyor.
- **Oda Kur / Odaya Katıl (P2P):** Host 4 haneli bir kod alır, rakip bu kodla bağlanır. Simülasyon host'ta çalışır. Client sadece tuş girdisi gönderir ve host'tan gelen durumu ~100 ms gecikmeyle ara değerleyerek çizer.

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
| Esc | Menüye dön |

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
