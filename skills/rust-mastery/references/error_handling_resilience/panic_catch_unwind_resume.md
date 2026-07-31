# Panic, Catch Unwind, dan Resume

## 1. Konsep Utama & Kapan Digunakan
Dalam Rust, `panic!` idealnya digunakan hanya untuk unrecoverable errors (bug, invariants violation). Secara default, panic akan melakukan *unwinding* stack (menjalankan destructors/Drop). Namun di sistem tertentu, Anda tidak ingin panic meruntuhkan seluruh runtime. `std::panic::catch_unwind` menangkap panic yang melakukan unwinding, mengembalikannya sebagai `Result`.

Gunakan `catch_unwind` HANYA untuk:
- Melindungi batas FFI (Foreign Function Interface): Unwinding melewati C-boundary adalah Undefined Behavior (UB).
- Melindungi worker thread utama, threadpool, atau sistem plugin, di mana modul 3rd party yang panic tidak boleh mematikan host.
- Menulis test framework.

## 2. Arsitektur / Flow

```ascii
[ User Code ] -> panics! ("Out of bounds")
        |
        v Stack Unwinding (Drop in progress)
[ Boundary  ] -> catch_unwind()
        |
        +-- (Err) -> Tangkap tipe (Any), Log, return C Error Code
        |
[ Host Code ] -> Terus berjalan (Tidak crash)
```

## 3. Kode Rust Production-Ready

```rust
use std::panic::{self, AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

/// Contoh sistem eksekusi plugin eksternal
pub struct PluginExecutor {
    pub shared_state: Arc<Mutex<i32>>,
}

impl PluginExecutor {
    /// Mengeksekusi fungsi yang tidak dipercaya tanpa membahayakan host.
    pub fn execute_untrusted_plugin(&self, plugin_fn: fn()) -> Result<(), String> {
        // AssertUnwindSafe memberitahu compiler: "Saya jamin data yang ditangkap
        // aman dari logical inconsistencies meskipun thread panic di tengah jalan."
        let result = catch_unwind(AssertUnwindSafe(|| {
            plugin_fn();
        }));

        match result {
            Ok(_) => Ok(()),
            Err(err) => {
                // `err` adalah `Box<dyn Any + Send + 'static>`
                // Kita coba downcast untuk melihat isi pesan panic-nya
                let msg = if let Some(s) = err.downcast_ref::<&str>() {
                    *s
                } else if let Some(s) = err.downcast_ref::<String>() {
                    s.as_str()
                } else {
                    "Unknown panic type"
                };
                
                Err(format!("Plugin crashed with panic: {}", msg))
            }
        }
    }
}

// FFI Boundary example
#[no_mangle]
pub extern "C" fn rust_function_called_by_c() -> i32 {
    let result = catch_unwind(|| {
        // ... some complex logic that might panic ...
        42
    });

    result.unwrap_or_else(|_| {
        eprintln!("Rust panicked, preventing C crash");
        -1 // Error code for C
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_crash_isolation() {
        let executor = PluginExecutor {
            shared_state: Arc::new(Mutex::new(0)),
        };

        let res = executor.execute_untrusted_plugin(|| {
            panic!("Div by zero");
        });

        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "Plugin crashed with panic: Div by zero");
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `catch_unwind` sebagai mekanisme error handling normal mirip `try-catch`.**
   - *Bahaya*: Sangat lambat dan memecah alur kontrol Rust (seperti Poisoned `Mutex`). Data bisa berada di state inkonsisten jika fungsi panic di tengah mutasi.
   - *Solusi*: Selalu gunakan `Result` untuk error yang dapat diprediksi. `catch_unwind` hanya untuk isolasi catastrophic failure.
2. **Mengabaikan profil kompilasi `panic = "abort"`.**
   - *Bahaya*: Jika aplikasi Anda atau user di-compile dengan `panic = "abort"` di `Cargo.toml`, maka `catch_unwind` TIDAK AKAN BEKERJA. Aplikasi akan langsung terminate (abort) tanpa unwinding.
   - *Solusi*: Jika sistem Anda mutlak butuh menangkap plugin crashes, dokumentasikan atau check configurasi, atau jalankan plugin di process terpisah (IPC) yang kebal abort.

## 5. Edge Cases & Defensive Programming
- **Mutex Poisoning**: Jika sebuah thread panic saat menahan lock `std::sync::Mutex`, mutex tersebut menjadi "poisoned". Semua thread lain yang mencoba me-lock-nya akan mendapat error. Ini adalah mekanisme proteksi `AssertUnwindSafe`.
- **`panic::resume_unwind(err)`**: Jika Anda menangkap panic untuk melakukan beberapa aksi (log), namun pada akhirnya ingin merambatkan (propagate) panic tersebut ke atas, gunakan `resume_unwind(err)`.
- **Panic Hook**: Gunakan `std::panic::set_hook` untuk mencatat metrik / melaporkan crash ke Sentry/Datadog tepat *sebelum* unwinding dimulai.
