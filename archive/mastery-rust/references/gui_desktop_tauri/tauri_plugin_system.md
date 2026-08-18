# Sistem Plugin Tauri v2 & Ekstensibilitas Arsitektur

## Konsep Utama & Arsitektur
Tauri v2 dirancang sebagai inti (core) yang sangat modular. Alih-alih membengkakkan biner utama dengan fitur-fitur seperti File System (fs), Global Shortcut, atau SQL Database, Tauri mendelegasikannya melalui Sistem Plugin. 

Keunggulan Sistem Plugin:
1. **Modularitas (Opt-in Security)**: Aplikasi hanya mengompilasi dan memberikan izin OS untuk modul yang dibutuhkan (mengurangi attack surface).
2. **Lifecycle Hooks**: Plugin dapat menginjeksi logika asinkron pada siklus hidup aplikasi (seperti saat `setup`, `on_page_load`, atau `on_drop`).
3. **Cross-Language Bindings**: Memungkinkan pembuatan perintah kustom yang terikat langsung ke objek JavaScript global (`window.__TAURI__.myPlugin`).

### Diagram Arsitektur: Aliran Data Plugin Tauri
```text
[ Webview (JS/TS) ] 
       | invoke('plugin:my_sql|execute_query')
       v
+-------------------------------------------------+
|               [ Tauri Core IPC ]                |
+-------------------------------------------------+
       | Rute berdasarkan prefix 'plugin:nama_plugin'
       v
[ Tauri Plugin 'my_sql' ]
  - setup(): Inisialisasi koneksi DB (saat App mulai)
  - commands: {
       execute_query() -> Akses DB Pool
  }
  - on_page_load(): Injeksi script pelacak (opsional)
```

## Kode Produksi Tauri v2 Plugin (Rust)
Kode ini adalah implementasi plugin otentikasi biometrik kustom yang berbagi state (Arc Mutex) secara aman.

```rust
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime, State,
};
use serde::{Deserialize, Serialize};

// 1. Definisikan Error Custom untuk Plugin
#[derive(Debug, thiserror::Error)]
pub enum BiometricError {
    #[error("Hardware unavailable: {0}")]
    HardwareError(String),
    #[error("User canceled authentication")]
    Canceled,
}

impl serde::Serialize for BiometricError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

// 2. Struct State Internal Plugin
struct BiometricState {
    pub is_locked: Mutex<bool>,
    pub hardware_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct AuthResponse {
    success: bool,
    token: Option<String>,
}

// 3. Deklarasikan Commands (Prefix otomatis di-handle oleh Tauri IPC)
#[tauri::command]
async fn authenticate_user<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<BiometricState>>,
) -> Result<AuthResponse, BiometricError> {
    
    let mut locked = state.is_locked.lock().await;
    if !*locked {
        return Ok(AuthResponse { success: true, token: Some("ALREADY_AUTH".into()) });
    }

    // Simulasi pemanggilan OS API Biometrik (C FFI / WinRT)
    // let result = hardware_biometric_scan(&state.hardware_id).await?;
    
    *locked = false; // Buka kunci
    
    // Broadcast event ke semua webview
    let _ = app.emit("biometric-unlocked", ());

    Ok(AuthResponse { success: true, token: Some("NEW_TOKEN_XYZ".into()) })
}

// 4. Builder Plugin
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("biometrics")
        .setup(|app, _api| {
            // Lifecycle: Dijalankan saat aplikasi mulai, sebelum webview muncul.
            let state = Arc::new(BiometricState {
                is_locked: Mutex::new(true),
                hardware_id: "HW_FINGERPRINT_01".to_string(),
            });
            
            // Manage state KHUSUS untuk plugin ini (terisolasi)
            app.manage(state);
            Ok(())
        })
        .on_page_load(|window, _payload| {
            // Lifecycle: Otomatis inject script ke window baru
            let _ = window.eval("console.log('Biometric plugin loaded');");
        })
        .invoke_handler(tauri::generate_handler![authenticate_user])
        .build()
}

// Cara Integrasi di `main.rs`:
// tauri::Builder::default().plugin(my_plugin::init())

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_biometric_error_serialization() {
        let err = BiometricError::HardwareError("Disconnected".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Hardware unavailable: Disconnected\"");
    }
}
```

## Anti-Patterns

### 1. Hardcoding Izin (Permissions) Tanpa Validasi Context
**Penjelasan:** Di dalam command `authenticate_user`, Anda tidak mengecek apakah URL Webview yang memanggil berasal dari local origin (`tauri://localhost`) atau dari website eksternal via iframe.
**Bahaya:** Jika iframe pihak ketiga disisipkan ke aplikasi Anda (misal via XSS), iframe tersebut bisa dengan mudah memanggil `invoke('plugin:biometrics|authenticate_user')` dan mencuri token. Manfaatkan sistem Capabilities Tauri v2 dan selalu verifikasi `Window::url()` pada operasi sensitif.

### 2. State Mutex Blocking di `on_page_load`
**Penjelasan:** Menggunakan `std::sync::Mutex` (sinkron) lalu melakukan `.lock().unwrap()` di dalam hook sinkronus seperti `on_page_load` atau `on_drop` saat menunggu operasi I/O jaringan lambat.
**Bahaya:** Ini akan membuat thread OS mandek. Hook lifecycle GUI Tauri berjalan di thread utama/UI. Jika terblokir, OS akan menganggap aplikasi crash/hang ("Application is not responding"). Selalu spawn thread terpisah atau gunakan tokio task untuk logika berat di dalam lifecycle hooks sinkron.

## Edge Cases & Defensive Programming

1. **State Overwriting (Manage State Collision)**:
   Aplikasi Tauri memiliki satu global registry untuk `State`. Jika Plugin Anda memanggil `app.manage(Arc<Mutex<String>>)` dan Plugin lain juga mem-manage tipe yang eksak sama (`Arc<Mutex<String>>`), state plugin pertama akan TERTIMPA. Ini bug silent yang mengerikan. Selalu bungkus state plugin Anda di dalam *Custom Newtype Struct* (seperti `BiometricState` di atas) agar tipe datanya unik secara global.
2. **Webview HMR (Hot Module Replacement)**:
   Selama development React/Vite, hook `on_page_load` akan dipicu ratusan kali saat developer men-save file JS (karena halaman reload otomatis). Jika plugin Anda melakukan alokasi hardware/socket pada hook ini tanpa debouncing atau pengecekan state "already_initialized", aplikasi akan crash karena port/hardware contention (Address already in use).
3. **Plugin Drop Hook Panic**:
   Saat aplikasi dimatikan (graceful shutdown), jika Anda melakukan clean-up logic di trait `Drop` pada state, perhatikan bahwa Anda tidak boleh mengasumsi `tokio::Runtime` masih aktif sepenuhnya. Melakukan `tokio::spawn` pada saat aplikasi exit akan memicu panic (Runtime is dropping). Gunakan OS-level thread native jika Anda benar-benar perlu flush data darurat sebelum proses mati.
