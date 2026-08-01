# Tauri v2 Architecture & Core Security Boundary

## Konsep Utama & Arsitektur
Tauri v2 (berbasis komponen WRY dan TAO) secara dramatis merevolusi cara aplikasi dekstop multiplatform dibangun. Pada inti arsitekturnya, Tauri beroperasi pada model "Multiprocess Boundary", secara fundamental memisahkan Logic Inti (Rust Backend) dari Antarmuka Web (Frontend Webview WebView2/WebKit). 

Prinsip Utama:
1. **Sandboxed Frontend**: Frontend dirender menggunakan web engine bawaan sistem operasi (tanpa memaketkan Chromium V8 yang berat seperti Electron). Ia tidak memiliki akses I/O/OS mandiri.
2. **Asynchronous IPC (Inter-Process Communication)**: Frontend (JS/TS) berkomunikasi dengan Backend (Rust) secara ekslusif melalui sistem pertukaran pesan asinkron yang ketat (Tauri Commands & Events).
3. **Custom URL Schemes**: Pengambilan aset statis (HTML/CSS) di-serve via protokol kustom (seperti `tauri://localhost`), mencegah sniffing CORS pada file sistem.

### Diagram Arsitektur: Rust / Webview Boundary (IPC)
```text
  [ Frontend Browser (JS/TS/React) ] (Sandboxed)
       |                            ^
       | invoke('read_sys_file')    | Response JSON
       v                            |
 +-----------------------------------------------------+
 | [ IPC Bridge (Custom Protocol / PostMessage) ]      |  <-- Security Boundary
 +-----------------------------------------------------+
       |                            ^
       v                            |
 [ Rust Backend (Tauri Core) ]------+
  - Command Routing                 
  - Argument Deserialization (Serde)
  - Thread Execution (Tokio Async)
  | 
  +-> [ Operating System API (File, Network, DB) ]
```

## Kode Produksi Tauri v2 Backend Command
Implementasi perintah Rust yang dipanggil dari frontend. Mencakup state sharing dan error handling berbasis Serde.

```rust
use tauri::{AppHandle, Manager, State, Emitter};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};

// State Aplikasi Global
#[derive(Default)]
pub struct RequestCounter(AtomicUsize);

// Error tipe custom untuk diteruskan ke frontend sebagai reject promise
#[derive(Debug, Serialize, thiserror::Error)]
pub enum CommandError {
    #[error("User input is strictly invalid: {0}")]
    InvalidInput(String),
    #[error("Internal database fault")]
    DbFault,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessRequest {
    pub username: String,
    pub code: i32,
}

#[derive(Serialize, Clone)]
pub struct ProcessResponse {
    pub success: bool,
    pub current_requests: usize,
}

/// #[tauri::command] mendekorasi fungsi agar dapat diakses dari JavaScript
#[tauri::command]
pub async fn process_data(
    app: AppHandle,
    state: State<'_, RequestCounter>,
    payload: ProcessRequest,
) -> Result<ProcessResponse, CommandError> {
    
    if payload.username.is_empty() {
        return Err(CommandError::InvalidInput("Username cannot be empty".to_string()));
    }

    // Mutasi stat secara thread-safe
    let new_count = state.0.fetch_add(1, Ordering::SeqCst) + 1;

    // Emisi event langsung ke jendela spesifik atau semua (broadcast)
    let _ = app.emit("data_processed", &payload);

    // Kirim response resolve ke frontend promise
    Ok(ProcessResponse {
        success: payload.code > 0,
        current_requests: new_count,
    })
}

// Simulasi build handler
pub fn build_tauri_app() {
    let builder = tauri::Builder::default()
        .manage(RequestCounter::default())
        // Registrasi command untuk IPC bridge
        .invoke_handler(tauri::generate_handler![process_data]);
    
    // builder.run(tauri::generate_context!()).expect("error"); 
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_data_logic() {
        let req = ProcessRequest {
            username: "Bob".to_string(),
            code: 10,
        };
        // Dalam unit test, function business logic bisa di-test independen.
        // Untuk mock tauri app state cukup tricky, tapi logic Serde gampang dites.
        assert_eq!(req.username, "Bob");
    }
}
```

## Anti-Patterns

### 1. Sinkronus Command untuk I/O Berat (Thread Blocking)
**Penjelasan:** Menggunakan command biasa (tanpa `async fn`) untuk fungsi Rust yang melakukan download HTTPS atau pembacaan zip 100MB (`std::fs::read`).
**Bahaya:** Fungsi sinkron akan dieksekusi dan mem-block thread IPC utama milik Tauri / WRY event loop. Akibatnya, UI webview (Frontend) Anda akan macet total (freeze/not responding). Selalu gunakan `async fn` di Rust untuk operasi I/O sehingga direntangkan ke threadpool asinkron Tokio.

### 2. Mengembalikan `Result<T, String>` Secukupnya
**Penjelasan:** Daripada membuat Custom Enum Error yang mengimplementasikan `serde::Serialize`, developer malah mem-fallback mapping string panjang: `.map_err(|e| e.to_string())`.
**Bahaya:** UI Frontend tidak memiliki struct/kode error mesin yang jelas untuk mengkategorikan fault (hanya bergantung pada regex parse String). Ini rapuh dan tidak lokalisasi (i18n) friendly. Gunakan `thiserror` + `serde`.

## Edge Cases & Defensive Programming

1. **IPC Payload Deserialization Overflow**:
   Karena parameter fungsi Tauri otomatis dideserialisasi via Serde JSON dari webview, peretas atau bug di Frontend (NodeJS) dapat memompa payload string raksasa (2 GB Base64). Deserialisasi ini akan membebani RAM backend Rust dan memicu OOM (Out of Memory) Panic. Batasi panjang limit payload, atau tangani transfer file berat mengunakan upload HTTP localhost custom alih-alih melewati IPC JSON Message.
2. **Window Handle Drops pada Long Running Async**:
   Jika `async fn` anda berjalan selama 2 menit (misal: upload), dan user menekan tombol [X] (close) pada window, objek `Window` atau `AppHandle` yang Anda pass ke fungsi akan menjadi tidak valid. Percobaan emisi (`window.emit()`) setelah await yang panjang bisa gagal diam-diam. Selalu cek validitas window state atau handle result `Result::Err`.
3. **CORS di Custom Protocols (Linux vs Windows)**:
   Perilaku fetch di dalam Webview berbeda. Di Windows WebView2 `tauri://` dikenali sebagai domain origin, sementara di WebKit Linux, URI tersebut bisa terkena blokir WebKit strict CORS rules jika mem-fetch ke `https://api.myweb.com`. Konfigurasi boundary permission Tauri v2 (`capabilities.json`) secara kaku untuk membypass OS-level webview sandbox quirks ini.
