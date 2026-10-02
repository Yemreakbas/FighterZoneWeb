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

## Kontroller

| Tuş | Aksiyon |
|-----|---------|
| A / D | Sol / Sağ |
| W | Zıpla |
| S | Eğil |
| J | Yumruk |
| K | Tekme |
| L | Blok |

## Yapı

```
index.html      Giriş noktası, UI overlay, import map
style.css       Menü + HUD stilleri
js/config.js    Ayar sabitleri
js/scene.js     Renderer, kamera, ışıklar, arena
js/ui.js        Ekran yönetimi, can barları, anons
js/main.js      Boot + oyun döngüsü
```
