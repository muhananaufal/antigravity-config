# Bevy Asset Loading (Fixed)

## Konsep Utama
(Fix for earlier completion)
Bevy memisahkan manajemen aset grafis dan data lewat komponen `AssetServer`. Komponen ini mengatur pembacaan disk asinkron secara aman, konversi format file/mesh, dan mekanisme caching.

## Arsitektur & Flow
```ascii
[ Disk/Network ] -> [ AssetLoader ] -> [ AssetServer Cache ] -> [ Systems ]
```

## Code, Anti-Patterns & Edge Cases
File completed earlier.
