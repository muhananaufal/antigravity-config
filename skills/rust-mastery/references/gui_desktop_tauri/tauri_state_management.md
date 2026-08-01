# Tauri State Management & Sinkronisasi Thread (Tokio)

## Konsep Utama & Arsitektur
Tauri adalah framework *multithreaded* secara default. Ketika antarmuka (Frontend) memanggil perintah (Commands) di Rust, Tauri menggunakan Tokio (async runtime) untuk mengeksekusinya di thread pool asinkron. Ini berarti jika dua jendela (Webview A dan Webview B) memanggil command secara bersamaan, mereka berpotensi membaca dan memutasi state Rust yang sama secara konkuren (bersamaan).

Pengelolaan State Tauri bergantung pada:
1. **Dependency Injection**: Tipe data disisipkan melalui `app.manage(T)`.
2. **State Extractor**: Fungsi command menarik tipe data tersebut secara otomatis via parameter `State<'_, T>`.
3. **Thread-Safe Mutability**: Karena Rust tidak mengizinkan mutasi variabel bersama dari multi-thread (Ownership rules), Anda wajib membungkus state menggunakan `Arc<Mutex<T>>` atau lock-free atomic `AtomicUsize`.

### Diagram Arsitektur: Konkurensi State Tauri
```text
[ Webview 1 ]             [ Webview 2 ]
   | (invoke)                | (invoke)
   v                         v
[ Tokio Thread A ]        [ Tokio Thread B ]
   |                         |
   |   (Tauri State Manager) |
   +-------> [ Arc ] <-------+
                |
           [ Mutex (Lock) ]  --> Hanya 1 thread yang bisa masuk!
                |
          [ AppDatabase ]
          (Data Terlindungi)
```

## Kode Produksi Tauri State Management
Kode di bawah mendemonstrasikan manajemen database koneksi memori secara thread-safe menggunakan Tokio Mutex (asinkron), memastikan tidak ada thread blocking pada UI saat mengkueri data besar.

```rust
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use serde::{Deserialize, Serialize};

// 1. Tipe Data Inti (Bussiness Logic)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    id: String,
    name: String,
    role: String,
}

// 2. Pembungkus State (Arc + Tokio Mutex)
// Gunakan tokio::sync::Mutex agar kita bisa memegang lock melintasi await point (.await)
pub struct AppState {
    pub active_users: Arc<Mutex<HashMap<String, UserProfile>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_users: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// 3. Command 1: Memutasi State (Asinkron)
#[tauri::command]
pub async fn add_user(
    state: State<'_, AppState>,
    user: UserProfile,
) -> Result<(), String> {
    
    // Kunci (Lock) asinkron: Menunggu tanpa mem-block thread!
    let mut users_map = state.active_users.lock().await;
    
    if users_map.contains_key(&user.id) {
        return Err("User ID already exists".into());
    }

    users_map.insert(user.id.clone(), user);
    
    // Lock dilepas secara otomatis di akhir scope fungsi (Drop)
    Ok(())
}

// 4. Command 2: Membaca State
#[tauri::command]
pub async fn get_user(
    state: State<'_, AppState>,
    user_id: String,
) -> Result<Option<UserProfile>, String> {
    
    let users_map = state.active_users.lock().await;
    
    // Mengembalikan clone objek agar lock bisa langsung dilepas dengan cepat
    Ok(users_map.get(&user_id).cloned())
}

pub fn build_tauri_app() {
    let builder = tauri::Builder::default()
        // Registrasi State Global saat startup
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![add_user, get_user]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_state_mutation() {
        let state = AppState::default();
        let user = UserProfile {
            id: "U01".into(),
            name: "Alice".into(),
            role: "Admin".into(),
        };

        // Simulasi akses dari Thread 1
        let mut map = state.active_users.lock().await;
        map.insert(user.id.clone(), user.clone());
        drop(map); // Lepas manual agar lock berikutnya berhasil

        // Simulasi akses dari Thread 2
        let map_read = state.active_users.lock().await;
        assert_eq!(map_read.get("U01").unwrap().name, "Alice");
    }
}
```

## Anti-Patterns

### 1. Menggunakan `std::sync::Mutex` melintasi `.await`
**Penjelasan:** Menggunakan Standard Library Mutex sinkron (std::sync::Mutex), menguncinya, lalu memanggil fungsi asinkron (misal: HTTP request ke eksternal) sebelum lock dilepas.
**Bahaya:** Ini adalah malapetaka kompilasi (`Future is not Send`) atau malapetaka *Runtime Deadlock*. Tokio memindahkan (yield) eksekusi antar thread. Jika thread Tokio yang memegang sinkron-lock di-yield sebelum ia sempat melepas lock, thread lain yang dialokasikan task tersebut akan hang selamanya saat mencoba mengakuisisi lock. *Gunakan `tokio::sync::Mutex` jika lock harus ditahan melintasi `.await`.*

### 2. State God Object Raksasa (Monolithic State)
**Penjelasan:** Membuat satu buah struct State (misal: `GlobalState`) yang membungkus semua konfigurasi aplikasi, cache gambar, dan koneksi DB dalam SATU Mutex tunggal.
**Bahaya:** *Lock Contention* massif. Jika Jendela 1 (Webview 1) memanggil command untuk meresize gambar, Mutex raksasa ini akan dikunci. Akibatnya, Jendela 2 yang hanya ingin mengambil `config.theme_color` akan terblokir menanti image resize selesai. **Pecah State menjadi butiran kecil (Granular Mutexes).**

## Edge Cases & Defensive Programming

1. **Deadlock Rekursif**:
   Sangat mudah terjadi jika Anda memiliki dua fungsi di dalam command Rust yang sama-sama mencoba me-lock state yang sama: 
   `let a = state.lock().await; helper_function(state).await;` (dimana helper juga memanggil `.lock().await;`). Mutex asinkron Rust tidak re-entrant; thread akan terhenti selamanya menanti dirinya sendiri melepas lock. Gunakan *Copy* / *Clone* data atau oper reference variabel internal (pass `&mut HashMap`) ketimbang mempassing struct Mutex ke helper.
2. **Penggunaan Lock RWLock untuk Pola Baca Intensif**:
   Jika data Anda sangat sering dibaca (misalnya konfigurasi bahasa) tapi nyaris tidak pernah ditulis ulang, gunakan `tokio::sync::RwLock` alih-alih `tokio::sync::Mutex`. Ini mengizinkan banyak thread membaca (Read-Lock) secara simultan berbarengan, mengoptimalkan throughput IPC Tauri.
3. **Poisoned Lock Error**:
   Jika thread yang memegang `std::sync::Mutex` (bukan Tokio) mengalami Panic, Mutex tersebut dianggap "Poisoned" dan request dari webview selanjutnya yang mencoba me-lock akan terus-terusan mengembalikan `PoisonError` menyebabkan domino effect crash. Tangani error secara anggun (`lock.unwrap_or_else(|poisoned| poisoned.into_inner())`) bila state korup ringan masih bisa ditolerir.
