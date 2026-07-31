# Tauri v2 Architecture

## Konsep Utama
Tauri v2 menyediakan platform untuk membuat aplikasi desktop (Windows, macOS, Linux) dan seluler (iOS, Android) kecil, sangat cepat, dengan backend Rust dan frontend bebas hambatan (HTML/CSS/JS). Arsitekturnya berfokus pada dua proses: **Core Process** (ditulis dalam Rust) untuk akses sistem tingkat rendah dan status manajemen, dan **WebView Process** (dirender melalui WebView bawaan OS). Keduanya berkomunikasi melalui mekanisme keamanan IPC (Inter-Process Communication).

## Arsitektur & Flow
```ascii
  [ Frontend (React/Vue/Svelte) ]
         |
    (Tauri IPC Command / JSON)
         |
  [ Tauri WebView Bridge ]
         |
  [ Tauri Core Process (Rust) ]
   /             |             \
[Window Mgt] [Commands Mgt] [State<T> Injection]
                 |
          [ System APIs / DB ]
```

## Production-Ready Code
```rust
use std::sync::Mutex;
use tauri::{State, Manager, AppHandle};

// Global App State
pub struct AppState {
    pub db_connection: Mutex<Option<String>>,
    pub total_operations: Mutex<u32>,
}

// IPC Command - Ter-ekspon ke frontend JS
#[tauri::command]
pub async fn execute_query(
    query: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let mut ops = state.total_operations.lock().map_err(|e| e.to_string())?;
    *ops += 1;
    
    // Asynchronous logic
    let res = format!("Executed '{}'. Total ops: {}", query, *ops);
    
    // Broadcast event ke webview frontend
    app_handle.emit("query-executed", &res).map_err(|e| e.to_string())?;
    
    Ok(res)
}

pub fn run_app() {
    let builder = tauri::Builder::default()
        .manage(AppState {
            db_connection: Mutex::new(Some("sqlite://data.db".into())),
            total_operations: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![execute_query]);
    
    // Di aplikasi nyata, jalankan `.run(tauri::generate_context!())`
    // builder.run(tauri::generate_context!()).expect("error running app");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    
    #[test]
    fn test_state_mutation() {
        let state = AppState {
            db_connection: Mutex::new(None),
            total_operations: Mutex::new(0),
        };
        
        let mut ops = state.total_operations.lock().unwrap();
        *ops += 1;
        assert_eq!(*ops, 1);
    }
}
```

## Anti-Patterns
1. **Mem-block Main Thread dengan Command Sinkron**: 
   *Mengapa Berbahaya:* Jika fungsi ber-atribut `#[tauri::command]` melakukan IO berat (disk/network) tanpa `async`, ia akan memblokir thread UI (Tauri Core UI Loop) yang berujung pada window desktop terlihat *hang/freeze*. Selalu gunakan `async` command untuk proses mahal.
2. **Mengabaikan PosionError Mutex di `State`**:
   *Mengapa Berbahaya:* Men-unwrap hasil dari `.lock().unwrap()` pada `Mutex` di State menyebabkan seluruh aplikasi crash jika ada thread lain mem-panic saat memegang lock tersebut. Terapkan fallback handling (`map_err`).

## Edge Cases & Defensive Programming
- **Window Management**: Ketika mengirim event ke Frontend (`app_handle.emit()`), event tersebut bersifat broadcast. Jika menggunakan multi-window application, Anda harus mentargetkan label window yang spesifik jika data bersifat private.
- **Tauri Plugin Isolation**: Tauri v2 menggunakan ACL (Access Control Lists). Pastikan IPC command teregistrasi dan diberi kapabilitas di folder `capabilities/` json, jika tidak, pemanggilan fungsi dari frontend akan ditolak (Denied) di runtime.
