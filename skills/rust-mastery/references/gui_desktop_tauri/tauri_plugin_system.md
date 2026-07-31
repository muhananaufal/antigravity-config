# Tauri Plugin System

## Konsep Utama
Pada Tauri v2, hampir seluruh fungsionalitas inti (seperti file system, dialog, store) diekstraksi menjadi sistem **Plugin**. Arsitektur ini mengurangi binary size secara signifikan dan memungkinkan third-party developer mengekspos library Rust/native mobile khusus (seperti akses bluetooth atau kamera Android) ke API frontend, sembari mengontrol akses via izin kapabilitas (Capability Permissions).

## Arsitektur & Flow
```ascii
[ Plugin JS NPM Package ]
          |
 (Tauri IPC `plugin:nama|command`)
          |
[ App Capability Router (ACL) ]
          |
[ Rust Plugin (tauri::plugin::Builder) ] -> [ Android/iOS SDK Layer via JNI/ObjC ]
          |
[ OS Native Action (Bluetooth, FS) ]
```

## Production-Ready Code
```rust
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
    Manager,
};

#[derive(Default)]
struct PingCounter {
    count: std::sync::Mutex<u32>,
}

#[tauri::command]
async fn ping<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, PingCounter>,
) -> Result<String, String> {
    let mut count = state.count.lock().map_err(|e| e.to_string())?;
    *count += 1;
    Ok(format!("Pong! Total pings: {}", *count))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("my-custom-plugin")
        .invoke_handler(tauri::generate_handler![ping])
        .setup(|app_handle, _api| {
            // Setup plugin specific state, databases, etc.
            app_handle.manage(PingCounter::default());
            println!("Plugin 'my-custom-plugin' initialized");
            Ok(())
        })
        .on_drop(|_app| {
            // Clean up resources, threads, etc.
            println!("Plugin dropped, cleaning up resources");
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_builder() {
        // Build the plugin to ensure the API matches
        let _plugin: TauriPlugin<tauri::Wry> = init();
    }
}
```

## Anti-Patterns
1. **Mengakses State Utama (App State) dari dalam Plugin**: 
   *Mengapa Berbahaya:* Plugin harus bersifat modular. Menggunakan tipe struktural spesifik (seperti state milik aplikasi utama) akan menciptakan tight coupling. Plugin harus mendefinisikan dan mengelola statenya sendiri (di-inject lewat closure `setup`).
2. **Tidak Melakukan Cleanup di `on_drop`**:
   *Mengapa Berbahaya:* Tauri memungkinkan reload event dari webview. Jika plugin meluncurkan background thread loop dan tidak menghentikannya saat `on_drop`, thread baru akan di-spawn setiap reload, menyebabkan memory/CPU leak parah (Zombies threads).

## Edge Cases & Defensive Programming
- **Mobile Target Conditional Compile**: Gunakan `#[cfg(target_os = "android")]` untuk API yang native spesifik. Saat mem-build plugin lintas platform, hindari error saat proses linking C-libraries dengan mengeksklusi modul di iOS/Desktop.
- **V2 ACL Scope**: Panggil izin untuk IPC lewat `.json` manifest plugin. Frontend JS akan selalu mendapat error permission denied jika command tidak di-white-list di internal capability router.
