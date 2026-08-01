# Error Handling dengan Anyhow dan Context Chain

Dalam arsitektur microservices dan sistem backend terdistribusi di Rust, menangani error menggunakan sekadar `Result<T, String>` atau `Box<dyn std::error::Error>` sering mengakibatkan hilangnya riwayat error (Error Context). Tanpa konteks (seperti "Gagal pada step mana?"), log produksi yang menyatakan *“Connection Reset by Peer”* sama sekali tidak berguna.

Crate `anyhow` dengan trait `Context` menyelesaikan ini dengan merangkai jejak eksekusi yang ramah pengembang (chain of errors) menjadi pohon error struktural tanpa *boilerplate* enumerasi custom, memfasilitasi log dengan stack penuh yang instan dimengerti.

## Arsitektur Error Context Chaining

```ascii
[ Database Driver ] --> Err(SqlError: "Connection timeout")
       |
[ User Repository ] --> .context("Failed to query user ID 1234")
       |
[ Auth Service ]    --> .context("Authentication workflow aborted")
       |
[ API Handler ]     --> [ Logs Error Trace! ]
                        ^
      [ Output Error Print ]
      Error: Authentication workflow aborted
        Caused by: Failed to query user ID 1234
        Caused by: Connection timeout (SqlError)
```

## Produksi-Ready Code: HTTP Service Simulation dengan Anyhow

Kode ini mendemonstrasikan pattern integrasi `anyhow::Result`, metode `.context()`, dan *downcasting error* pada *top-level handler* untuk pemetaan HTTP Status Code yang akurat.

```rust
use anyhow::{Context, Result, bail};
use std::fs::File;
use std::io::Read;

/// Simulasi Custom Error tingkat rendah
#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error("Timeout while connecting to db")]
    Timeout,
    #[error("Entity {id} not found in database")]
    NotFound { id: String },
}

/// Repositori data, mensimulasikan kegagalan database
pub fn get_user_from_db(user_id: &str) -> Result<String, DatabaseError> {
    if user_id == "000" {
        Err(DatabaseError::NotFound { id: user_id.to_string() })
    } else if user_id == "lag" {
        Err(DatabaseError::Timeout)
    } else {
        Ok(format!("User data for {}", user_id))
    }
}

/// Service Layer menggunakan anyhow::Result untuk agnostik terhadap jenis error
/// yang di-bubble up, namun merajut konteks kaya (context propagation).
pub fn authenticate_user(user_id: &str) -> Result<String> {
    // 1. Eksekusi layer repository, dibubuhi (chained) dengan konteks
    let user_data = get_user_from_db(user_id)
        .with_context(|| format!("User lookup failed during authentication for '{}'", user_id))?;
        
    // 2. Simulasi failure point yang melempar error string generik secara instan dengan macro bail!
    if user_data.contains("BANNED") {
        bail!("User is permanently banned from system");
    }
    
    // 3. Simulasi operasi eksternal (baca file config)
    let _config = File::open(format!("/etc/users/{}.conf", user_id))
        .with_context(|| format!("Missing configuration file for user '{}'", user_id))?;

    Ok(user_data)
}

/// Top Level Handler (misalnya pada axum router)
pub fn http_handler_login(user_id: &str) -> (u16, String) {
    match authenticate_user(user_id) {
        Ok(data) => (200, format!("Success: {}", data)),
        Err(err) => {
            // DOWNCASTING: Memisahkan jenis error aslinya (Root cause).
            // Anyhow mengizinkan kita mengecek 'Cause' terdalam tanpa unpacking enum manual.
            if let Some(db_err) = err.downcast_ref::<DatabaseError>() {
                match db_err {
                    DatabaseError::NotFound { .. } => {
                        return (404, "User Not Found".to_string());
                    },
                    DatabaseError::Timeout => {
                        return (503, "Service Unavailable".to_string());
                    }
                }
            }

            // Jika error tidak dikenal (termasuk I/O config atau banned bailout),
            // log the full chain di server side, dan kembalikan 500 ke user.
            eprintln!("INTERNAL SERVER ERROR:\n{:?}", err);
            (500, "Internal Server Error".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_handler_not_found_downcast() {
        let (status, _body) = http_handler_login("000");
        assert_eq!(status, 404, "Downcast failed to detect NotFound variant");
    }
    
    #[test]
    fn test_handler_io_error_fallback() {
        let (status, _body) = http_handler_login("123"); // Akan gagal File::open
        assert_eq!(status, 500, "IO Error not caught by default 500 branch");
    }
}
```

## Anti-Patterns

1. **Menggunakan `map_err(|e| anyhow!(e))` daripada `context()`**
   **Mengapa berbahaya:** Macro `anyhow!(...)` memutus *error trace chain*. Ia akan membuang tipe error asli dan menggantinya sepenuhnya, sehingga operasi `.downcast_ref()` di masa depan di layer teratas tidak akan berfungsi karena root-cause telah terhapus di tengah jalan.
   **Solusi:** Selalu gunakan `.context("...")` atau `.with_context(|| "...")` agar error lama terbungkus/terbawa.

2. **Anyhow di dalam Core Library/Crate Public**
   **Mengapa berbahaya:** Jika Anda menulis library *open source* (misalnya parser data) dan mengembalikan tipe `anyhow::Result`, Anda merampas kebebasan pemanggil library (caller). Mereka tidak bisa melakukan `match` yang eksak pada jenis kesalahan. 
   **Solusi:** Gunakan `anyhow` hanya di ranah Application Code (Binaries/Servers), sedangkan untuk library murni, gunakan custom Enum dihiasi `thiserror`.

## Edge Cases dan Defensive Programming

1. **Over-Contextualization String Formatting di Hot Loops:**
   Menggunakan `.context(format!("Failed index {}", i))` dalam loop yang dieksekusi 1 juta kali per detik akan menyebabkan alokasi Heap (String allocation) yang sangat lambat secara tidak sadar meski eksekusi berhasil! Gunakan `.with_context(|| format!("..."))` secara lazily sehingga alokasi memori formating *hanya* terjadi JIKA fungsi sebelumnya mengembalikan `Err`.

2. **Kegagalan Unwrap Downcast karena Anyhow Boxing:**
   Jika sebuah library mendelegasikan error berlapis-lapis melalui trait `std::error::Error`, dan Anda memanggil `.downcast_ref::<T>()` pada Anyhow root, dan `T` tidak persis sama identik (misalnya ia di-wrap di dalam enum crate eksternal yang di-opaque), downcast akan gagal secara sepihak dan memicu fallback 500 (Unhandled logic). Jangan andalkan downcast untuk workflow bisnis utama, melainkan hanya untuk metrik diagnostik.

3. **Kehilangan Stacktrace:**
   Crate `anyhow` memiliki fitur backtrace (dengan env `RUST_BACKTRACE=1`). Namun jika kode `panic!` tertangkap oleh `catch_unwind` dan kemudian diubah menjadi `anyhow::Error`, informasi backtrace sejati dari sumber awal kepanikan tidak dikonversi ke error type anyhow, sehingga trace-nya terpotong.
