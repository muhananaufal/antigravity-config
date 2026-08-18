# Bevy Asset Loading (v0.14+)

## Konsep Utama & Arsitektur
Sistem manajemen aset Bevy (`AssetServer`) di v0.14 sangat bergantung pada pemuatan asinkron (async/await), polling di background I/O threads, dan status tracking via `Handle<T>`. Ini menjamin game loop di thread utama tidak pernah terhenti (frame drop) karena operasi baca disk yang berat.

Fitur Kunci:
1. **AssetLoader Trait**: Ekstensibilitas tinggi untuk memproses tipe file custom (`.ron`, `.gltf`, dsb).
2. **Handle<T> vs Handle<Untyped>**: Reference counting aman menggunakan tipe yang kuat (`Handle<Image>`).
3. **State Management Transitions**: Menyelaraskan status game (misal: LoadingScreen -> MainMenu) yang baru ditrigger setelah sebuah list dari kumpulan `Handle<T>` berubah status `LoadState`-nya menjadi `Loaded`.

### Diagram Arsitektur: Background Asset Loading
```text
[Main Game Thread (ECS)]
  | 
  | (1) AssetServer::load("audio.ogg") -> Returns Handle<AudioSource>
  +--------------------------------------------------------+
  |                                                        |
  v (Poll LoadState: Loading)                              v
[Background Task Pool / I/O Threads]              [Handle Storage]
  |                                                        |
  | (2) Read File Bytes Async                              |
  | (3) Invoke AudioAssetLoader                            |
  | (4) Decode OGG                                         |
  +--------------------------------------------------------+
  |
  v (5) Insert to Asset Storage (Assets<AudioSource>)
[Main Game Thread (ECS)]
  |
  v (Poll LoadState: Loaded) -> State Transition!
```

## Kode Produksi Bevy Custom Asset Loader
Kode ini memperagakan pembuatan ekstensi file kustom `.myasset` dengan deserialisasi Serde secara asinkron di Bevy.

```rust
use bevy::{
    asset::{io::Reader, AssetLoader, AsyncReadExt, LoadContext},
    prelude::*,
    reflect::TypePath,
    utils::BoxedFuture,
};
use serde::Deserialize;
use thiserror::Error;

// 1. Definisikan Struktur Aset (Tipe Data Game)
#[derive(Asset, TypePath, Debug, Deserialize)]
pub struct CustomGameData {
    pub player_name: String,
    pub level: u32,
    pub max_hp: f32,
}

// 2. Deklarasikan Tipe Error Kustom
#[derive(Debug, Error)]
pub enum CustomAssetLoaderError {
    #[error("Could not read asset: {0}")]
    Io(#[from] std::io::Error),
    #[error("Could not parse RON format: {0}")]
    RonError(#[from] ron::error::SpannedError),
}

// 3. Buat Struct Kosong untuk Loader
#[derive(Default)]
pub struct CustomGameDataLoader;

// 4. Implementasikan AssetLoader
impl AssetLoader for CustomGameDataLoader {
    type Asset = CustomGameData;
    type Settings = ();
    type Error = CustomAssetLoaderError;

    fn load<'a>(
        &'a self,
        reader: &'a mut dyn Reader,
        _settings: &'a (),
        _load_context: &'a mut LoadContext,
    ) -> BoxedFuture<'a, Result<Self::Asset, Self::Error>> {
        Box::pin(async move {
            let mut bytes = Vec::new();
            // Async File I/O untuk mencegah stuttering frame!
            reader.read_to_end(&mut bytes).await?;

            // Proses deserialization
            let custom_asset: CustomGameData = ron::de::from_bytes(&bytes)?;
            
            Ok(custom_asset)
        })
    }

    fn extensions(&self) -> &[&str] {
        &["myasset"] // File extension: level1.myasset
    }
}

// 5. Plugin untuk mendaftarkan Aset ke App Bevy
pub struct CustomAssetPlugin;

impl Plugin for CustomAssetPlugin {
    fn build(&self, app: &mut App) {
        app.init_asset::<CustomGameData>()
            .register_asset_loader(CustomGameDataLoader);
    }
}

// Dummy tests for rustc checking
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_asset_loader_registration() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default()));
        app.add_plugins(CustomAssetPlugin);
        
        let assets = app.world().get_resource::<Assets<CustomGameData>>();
        assert!(assets.is_some(), "Asset collection not initialized");
    }
}
```

## Anti-Patterns

### 1. Blocking I/O di dalam Custom `AssetLoader`
**Penjelasan:** Menggunakan `std::fs::read_to_string` sinkronus di dalam method loader (meskipun diletakkan di dalam block `Box::pin(async move { ... })`).
**Bahaya:** Ini akan mencekik (starve) I/O thread pool milik `bevy_tasks`. Game bisa freeze/stutter (patah-patah) selama sepersekian detik hingga load file tersebut selesai karena tidak di-yield. Gunakan selalu API asinkron dari `Reader` (`AsyncReadExt`).

### 2. Spawning Entitas Langsung Menunggu `Handle<T>`
**Penjelasan:** Di dalam sistem *setup*, me-load `.gltf` model (mendapat `Handle<Scene>`) lalu langsung menyuntikkannya ke `SceneBundle` dan berharap animasi dan mesh langsung tersedia di frame berikutnya.
**Bahaya:** Karena *asynchronous*, aset tersebut belum ada di `Assets<T>` storage di awal frame. Komponen Anda akan invisible. Tangani ini menggunakan *State transitions* di mana Anda mem-buffer list handles dan mengkueri `.get_load_state(id)` sampai semuanya berstatus `Loaded`.

## Edge Cases & Defensive Programming

1. **Asset Loading Failure / Missing File**:
   Status `AssetServer::load_state` bisa kembali dengan enum `Failed(error)`. Selalu tangani fail state dalam Loading Screen Anda (misal menunjukkan tombol "Retry" atau aset grafis cadangan / default fallback sprite). Jika tidak, game akan mematung tanpa ujung menunggu di Loading Screen selamanya.
2. **Handle Dropping Prematur**:
   Jika Anda menggunakan `AssetServer::load` tetapi Anda tidak menyimpan kembalian `Handle<T>`-nya pada resource / entity (misal: disimpan pada variabel lokal fungsi yang drop di akhir sistem), Bevy Garbage Collector akan menganggap handle tidak ada yang memakai dan **membuang aset tersebut dari RAM** (`Assets<T>`) meskipun ia baru saja beres di-load di background thread.
3. **Hot-Reloading Korupsi**:
   Bevy mendukung hot-reloading asset saat runtime. Namun jika file shader atau `.gltf` yang sedang di-hot-reload dikalkulasi setengah oleh OS saat Anda menyimpannya dari VSCode (file IO lock contention), ia akan melempar parse error. Loader harus toleran dan meretain state dari asset valid yang lama daripada meng-crash app secara brutal (lihat error handling `unwrap` vs `?` dalam trait).
