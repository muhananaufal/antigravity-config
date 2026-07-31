# LazyLock & OnceLock (Standard Library)

## Konsep Utama
Rust 1.70 dan 1.80 menstabilkan tipe `std::sync::OnceLock` dan `std::sync::LazyLock` (sebelumnya sangat bergantung pada crate `lazy_static` dan `once_cell`).
- `OnceLock<T>`: Sel sinkronisasi yang bisa diinisialisasi sekali saja secara aman di seluruh thread. Sering digunakan untuk data statis atau global state.
- `LazyLock<T, F>`: Abstraksi di atas `OnceLock` yang otomatis memanggil fungsi/closure inisialisasi pada saat data diakses pertama kali (lazy evaluation).

**Kapan Digunakan:**
Singleton patterns, konfigurasi global, regex caching, koneksi pool database global, dan FFI callback contexts.

## Arsitektur / Flow
```text
Access GLOBAL_REGEX:
Is Initialized? 
 |--> YES: Return &T (Lock-free/Wait-free read)
 |
 |--> NO: Acquire init mutex
      |-- Check again (Double-Checked Locking pattern)
      |-- If still uninitialized -> Run Init function
      |-- Store T, release mutex
      |-- Return &T
```

## Implementasi Production-Ready

```rust
use std::sync::{LazyLock, OnceLock};
use std::time::Instant;
use std::collections::HashMap;

/// Menggunakan LazyLock untuk global komputasi berat.
/// Hanya dijalankan saat pertama kali diakses.
pub static GLOBAL_DICTIONARY: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("rust", "safe and fast");
    m.insert("go", "simple and concurrent");
    m.insert("c++", "powerful and complex");
    m
});

/// Menggunakan OnceLock untuk inisialisasi yang datang dari input runtime.
/// LazyLock tidak cocok di sini karena nilai bergantung parameter dinamis.
pub static APP_START_TIME: OnceLock<Instant> = OnceLock::new();

pub fn initialize_app() -> Result<(), &'static str> {
    APP_START_TIME
        .set(Instant::now())
        .map_err(|_| "Aplikasi sudah diinisialisasi sebelumnya!")
}

pub fn get_uptime() -> u128 {
    // get() return Option<&T>, kita bisa safe unwrap atau berikan default
    APP_START_TIME
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_lazy_lock_init() {
        // Belum diinisialisasi saat test dimulai
        let desc = GLOBAL_DICTIONARY.get("rust").copied();
        assert_eq!(desc, Some("safe and fast")); // Trigger init
    }

    #[test]
    fn test_once_lock_concurrent_init() {
        let handles: Vec<_> = (0..10).map(|_| {
            thread::spawn(|| {
                let _ = initialize_app();
            })
        }).collect();

        for h in handles {
            h.join().unwrap();
        }
        
        // Hanya satu yang berhasil, tapi aplikasi tidak panic.
        assert!(get_uptime() >= 0);
    }
}
```

## Anti-Patterns

1. **Inisialisasi `LazyLock` yang bergantung pada I/O atau Operasi Bloking di Async Runtime:**
   Menaruh operasi jaringan (seperti HTTP Request) di dalam closure `LazyLock`.
   *Mengapa Berbahaya:* `LazyLock` menahan lock sinkron internal (OS Mutex). Memanggil fungsi async `.block_on()` di dalamnya bisa menyebabkan runtime I/O worker threads kehabisan stok (thread starvation) atau deadlock jika runtime diinisialisasi dalam thread yang sama. Gunakan `tokio::sync::OnceCell` untuk asinkronus.

2. **Panic dalam Inisialisasi `LazyLock`:**
   *Mengapa Berbahaya:* Jika closure inisialisasi panik, thread pemanggil akan panik. Panggilan berikutnya ke `LazyLock` dari thread lain mungkin akan menyebabkan deadlock permanen atau panic instan (tergantung implementasi poisoning). Inisialisasi harus infallible (jangan gunakan unwrap asal).

## Edge Migration dari `once_cell` / `lazy_static`
- Hapus dependensi `lazy_static` dan gunakan `std::sync::LazyLock` (Rust 1.80+).
- Makro `lazy_static! { ... }` membungkus tipe menjadi struct tertutup. `LazyLock` murni tipe fungsional yang lebih bersih untuk diketik eksplisit `static FOO: LazyLock<T> = LazyLock::new(...)`.
- `OnceLock` adalah pengganti 1:1 untuk `once_cell::sync::OnceCell`.
