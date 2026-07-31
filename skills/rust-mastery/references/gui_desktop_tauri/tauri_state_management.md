# Tauri State Management

## Konsep Utama
State management pada Tauri diimplementasikan lewat fitur Dependency Injection yang dinamakan `tauri::Manager`. App state bisa diakses thread-safe dari backend via commands IPC, lifecycle hooks (setup, window-creation), ataupun background task loop. Pattern paling dominan di Rust adalah membungkus objek status dalam primitif sinkronisasi seperti `std::sync::Mutex` atau `tokio::sync::Mutex` jika await diperlukan.

## Arsitektur & Flow
```ascii
  [ Main Setup: AppHandle.manage(State) ]
                   |
     +-------------+-------------+
     |             |             |
[IPC Command] [Async Task] [Window Menu Hook]
     |             |             |
    (Injects `tauri::State<T>`)
                   |
            (Locks Mutex)
                   |
            [ Read / Mutate ]
```

## Production-Ready Code
```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{State, Manager};

// State Kompleks
pub struct SessionStore {
    // Gunakan Arc<Mutex> jika perlu dilempar ke async thread luar
    pub active_users: Arc<Mutex<HashMap<String, String>>>,
    pub configuration_mode: Mutex<bool>,
}

#[tauri::command]
pub fn login_user(
    username: String,
    token: String,
    store: State<'_, SessionStore>,
) -> Result<(), String> {
    // Ekstraksi Mutex
    let mut users = store.active_users.lock().map_err(|_| "PoisonError")?;
    users.insert(username.clone(), token);
    
    println!("User {} logged in", username);
    Ok(())
}

#[tauri::command]
pub fn toggle_config(store: State<'_, SessionStore>) -> Result<bool, String> {
    let mut mode = store.configuration_mode.lock().map_err(|_| "PoisonError")?;
    *mode = !*mode;
    Ok(*mode)
}

pub fn spawn_background_cleanup(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await; // 1 Jam
            // Mengambil state di background
            if let Some(store) = app_handle.try_state::<SessionStore>() {
                if let Ok(mut users) = store.active_users.lock() {
                    users.clear(); // Bersihkan session
                    println!("Session store purged");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_mutation() {
        let store = SessionStore {
            active_users: Arc::new(Mutex::new(HashMap::new())),
            configuration_mode: Mutex::new(false),
        };
        
        {
            let mut mode = store.configuration_mode.lock().unwrap();
            *mode = true;
        }
        assert!(*store.configuration_mode.lock().unwrap());
    }
}
```

## Anti-Patterns
1. **Menggunakan `tokio::sync::Mutex` di fungsi Sinkron (non-async)**: 
   *Mengapa Berbahaya:* `tokio::Mutex` harus di-_await_. Memblokir tokio Mutex dengan cara brute-force `block_on` dari dalam fungsi non-async di Tauri (seperti event handler window creation) memicu lock mati (deadlock). Sebaliknya, gunakan `std::sync::Mutex` dan tahan guard tersebut secepat mungkin.
2. **Menyimpan State Besar yang Terus Membengkak**:
   *Mengapa Berbahaya:* Jika kita menyimpan state log/history yang besar di memory dan selalu dilempar bolak-balik antara frontend WebView dan Backend Rust melalui sinkronisasi, akan menghabiskan memori RAM pengguna. Gunakan state untuk metadata lokal dan gunakan SQLite lokal untuk list rekaman.

## Edge Cases & Defensive Programming
- **Deadlock Rekursif**: Hindari emit event Tauri (menggunakan `app_handle.emit()`) DI DALAM blok tempat `MutexGuard` masih ditahan/lock aktif. Jika emit tersebut memicu trigger re-entry command yang mencoba me-lock kembali mutex, UI akan frozen permanent (Deadlock).
- **try_state vs state**: Dalam task background, selalu gunakan `try_state<T>()` yang akan me-return `Option` (bisa None). API sinkron `app_handle.state<T>()` akan mem-panic (abort runtime) jika tipe struct State tersebut belum pernah dimasukkan di `manage()` saat booting.
