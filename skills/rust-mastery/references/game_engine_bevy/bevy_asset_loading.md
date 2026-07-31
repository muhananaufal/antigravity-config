# Bevy Asset Loading

## Konsep Utama
Bevy memisahkan manajemen aset grafis dan data lewat komponen `AssetServer`. Komponen ini mengatur pembacaan disk asinkron secara aman, konversi format file/mesh, dan mekanisme caching yang kuat agar aset besar (model 3D, memori Audio, resolusi Texture tinggi) tidak mem-blokir frame saat dimuat dan tidak diduplikasi redundan di RAM (lewat penggunaan smart pointer `Handle<T>`).

## Arsitektur & Flow
```ascii
    [ OS File System / Disk / Network ]
                  |
        [ Bevy IoTaskPool ] (Thread Pool Khusus I/O)
                  |
     [ AssetLoader (Format Parser e.g., GLTF, PNG) ]
                  |
[AssetServer (Handles Caching, States)] --> [ Handle<Image> / Handle<AudioSource> ]
                  |
    [ Systems (Render / Play Audio) ] (Use Handles via `Res<Assets<T>>`)
```

## Production-Ready Code
```rust
use bevy::prelude::*;

// Struct untuk memegang asset di sistem global 
#[derive(Resource)]
pub struct GameAssets {
    pub hero_texture: Handle<Image>,
    pub background_music: Handle<AudioSource>,
}

// 1. Inisialisasi awal (Startup system)
pub fn setup_asset_loading(mut commands: Commands, asset_server: Res<AssetServer>) {
    // Memuat asinkron secara langsung (Handle status = Loading)
    let hero_tex = asset_server.load("textures/hero.png");
    let bgm = asset_server.load("sounds/ambient.ogg");

    // Simpan Handle di resource global untuk digunakan sistem lain kelak
    commands.insert_resource(GameAssets {
        hero_texture: hero_tex,
        background_music: bgm,
    });
}

// 2. Sistem memantau Load State sebelum ganti scene atau main (Loading Screen)
pub fn check_loading_progress(
    asset_server: Res<AssetServer>,
    game_assets: Res<GameAssets>,
    mut next_state: ResMut<NextState<AppState>>,
) {
    // Bevy 0.14+ syntax menggunakan load_state
    use bevy::asset::LoadState;
    
    let tex_state = asset_server.load_state(&game_assets.hero_texture);
    let sound_state = asset_server.load_state(&game_assets.background_music);

    if tex_state == LoadState::Loaded && sound_state == LoadState::Loaded {
        info!("Semua aset telah berhasil dimuat!");
        next_state.set(AppState::InGame);
    } else if tex_state == LoadState::Failed || sound_state == LoadState::Failed {
        error!("Gagal memuat beberapa aset kritikal");
    }
}

#[derive(States, Default, Clone, Eq, PartialEq, Debug, Hash)]
pub enum AppState {
    #[default]
    Loading,
    InGame,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_defaults_to_loading() {
        let state = AppState::default();
        assert_eq!(state, AppState::Loading);
    }
}
```

## Anti-Patterns
1. **Memuat Aset Berulang (Duplikasi Handle)**: 
   *Mengapa Berbahaya:* Jika setiap kali Entitas player muncul anda memanggil `asset_server.load("textures/hero.png")`, aset akan direload ulang dari disk dan cache disk parsing akan meledakkan memori VRAM. Simpan `Handle` pertama kali di Resource dan distribusikan/klon handelnya saja pada saat spawn entitas.
2. **Mengecek Data Asli Aset Terlalu Dini**:
   *Mengapa Berbahaya:* Langsung mendereferensikan (mencari `&Image` lewat trait `Assets::get(&handle)`) persis setelah pemanggilan `.load()` akan memulangkan nilai `None`. Eksekusi disk I/O belum selesai. Sistem anda harus toleran pada ketidakhadiran aset dan melakukan try-retry render.

## Edge Cases & Defensive Programming
- **Hot Reloading Asset**: Bevy menyertakan hot-reloading di mode development. Anda hanya perlu flag fitur `bevy/asset_processor` dan merubah aset `PNG` secara dinamis di luar engine. Bevy akan mendeteksi Inotify event dan me-rebind tekstur di memory. Perlu kehati-hatian pada custom logic buffer yang di-cache di luar Asset pipeline, agar tidak korup saat handle asset id diganti runtime.
- **Untyped Load Handles**: Pada scene komplek (Loading screen), iterasi pengecekan dapat sangat panjang. Lebih baik simpan sekumpulan handle di `Vec<HandleUntyped>` dan gunakan API bulk checker untuk mencegah boilerpate if-else.
