# Derive Macros & Custom Impl Internal

## Konsep Utama
Rust menyediakan prosedur auto-implementation (`#[derive(Trait)]`) untuk membebaskan programmer dari menulis boilerplate. Namun, banyak skenario dalam sistem tingkat lanjut mengharuskan kita meninggalkan *derive macro* default dan menulis implementasi manual (*Custom Impl*).
Makro bawaan `#[derive(Debug, Clone, PartialEq, dll.)]` beroperasi secara struktural (per field), dan lebih kritisnya: makro tersebut memasukkan Trait Bounds secara implisit terhadap SEMUA parameter generik yang ada pada Struct Anda.

**Penggunaan di Proyek Nyata:**
- `impl Debug`: Menyembunyikan token rahasia, password, PII (Personal Identifiable Information) agar tidak tercetak bocor di log files.
- `impl Clone`: Membuat implementasi shallow-copy murah via `Arc` ketimbang deep-copy yang fatal, atau mencegah cloning pada field yang mengikat sistem memori eksternal.
- `impl PartialEq`: Mengabaikan perbandingan data timestamp atau *cache hit flag* dalam persamaan domain agregat Anda.

## Arsitektur Trait Bound Expansion Implicit
```text
  Struct Generik              Ekspansi Default Macro (Seringkali Salah)
  #[derive(Clone)]            impl<T> Clone for MyBuffer<T>
  struct MyBuffer<T> {          where 
      ptr: Arc<Vec<T>>             T: Clone  <--- INI MASALAHNYA! (T tidak perlu Clone)
  }                           { ... }
```

## Production-Ready Rust Code

```rust
use std::fmt;
use std::sync::Arc;

// ---------------------------------------------------------
// Custom Debug - Redacting Sensitive Information
// ---------------------------------------------------------
pub struct UserCredentials {
    pub id: u64,
    pub username: String,
    pub password_hash: String, // Rahasia!
    pub api_token: String,     // Rahasia!
}

impl fmt::Debug for UserCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Menggunakan struct builder bawaan std::fmt untuk format yang rapi
        f.debug_struct("UserCredentials")
            .field("id", &self.id)
            .field("username", &self.username)
            // Mem-bypass isi aslinya dan mencetak penanda rahasia
            .field("password_hash", &"<REDACTED>")
            // Atau menunjukkan partial data (4 digit terakhir)
            .field("api_token", &format!("***{}", &self.api_token.chars().rev().take(4).collect::<String>()))
            .finish()
    }
}

// ---------------------------------------------------------
// Custom Clone - Bypassing Implicit Bounds
// ---------------------------------------------------------
/// `T` di dalam tipe ini tidak membutuhkan implementasi `Clone`.
/// Hal ini karena `Arc` sudah mengatur referensi ber-counter sendiri, 
/// namun jika kita memakai `#[derive(Clone)]`, ia akan memaksakan `T: Clone`!
pub struct SharedBuffer<T> {
    data: Arc<Vec<T>>,
}

// Custom Impl menyelesaikan masalah Bound ini dengan bersih
impl<T> Clone for SharedBuffer<T> {
    fn clone(&self) -> Self {
        Self {
            // Kita hanya men-clone pointer Arc, bukan data 'T' nya (Zero-cost copy)
            data: Arc::clone(&self.data),
        }
    }
}

// ---------------------------------------------------------
// Custom PartialEq - Domain-Specific Equality
// ---------------------------------------------------------
pub struct CachedRequest {
    pub url: String,
    pub query: String,
    pub cached_at_timestamp_ms: u64, // Tidak dihiraukan saat komparasi!
}

impl PartialEq for CachedRequest {
    fn eq(&self, other: &Self) -> bool {
        // Hanya membandingkan field fundamental
        self.url == other.url && self.query == other.query
    }
}
// EQ mengikuti jika logic mematuhi ke-ekuivalen-an refleksif, simetris, transitif
impl Eq for CachedRequest {}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_debug_redaction() {
        let creds = UserCredentials {
            id: 42,
            username: "sysadmin".into(),
            password_hash: "hash_abc123".into(),
            api_token: "tok_9988".into(),
        };

        let debug_str = format!("{:?}", creds);
        assert!(debug_str.contains("sysadmin"));
        assert!(debug_str.contains("<REDACTED>"));
        assert!(!debug_str.contains("hash_abc123")); // Password aman
        assert!(debug_str.contains("***8899"));      // Partial token
    }

    #[test]
    fn test_custom_clone_without_bounds() {
        // NonCloneStruct TIDAK me-ngimplementasikan `Clone`
        struct NonCloneStruct(u8);
        
        let buf = SharedBuffer {
            data: Arc::new(vec![NonCloneStruct(1), NonCloneStruct(2)]),
        };
        
        // Kita BISA memanggil `.clone()` pada buf. Jika memakai #[derive(Clone)], 
        // baris ini akan melempar compile-error!
        let buf_cloned = buf.clone();
        assert_eq!(Arc::strong_count(&buf_cloned.data), 2);
    }
}
```

## Anti-Patterns Spesifik
1. **Implicit `#[derive(Clone)]` pada Data Masif**: Menaruh `#[derive(Clone)]` secara membabi-buta di atas hirarki struct kompleks yang tanpa Anda sadari mengandung data heap masif (`Vec`, `HashMap`, `String`).
   - *Mengapa berbahaya:* Developer yang memanggil metode atau meneruskan variabel dapat terpancing melakukan `.clone()` alih-alih referensi `&`, memicu alokasi O(n) besar-besaran di memori heap yang menghancurkan latensi aplikasi (silent performance killer). 
2. **`#[derive(PartialEq)]` dengan tipe `f32/f64`**: Mencoba mengimplementasikan standard trait logika jika field-nya adalah float secara default derivatif.
   - *Mengapa berbahaya:* Mengingat `NaN != NaN` menurut standar IEEE 754, Rust tidak memberikan trait `Eq` untuk floats. Anda harus mengurus `PartialEq` manual dengan toleransi Epsilon (delta) spesifik, atau menggunakan crate seperti `ordered_float`.

## Edge Cases & Defensive Engineering
- **Hash vs PartialEq Invariant**: Sangat krusial! Jika Anda mengimplementasikan `PartialEq` secara manual (misalnya mengabaikan `timestamp`), Anda **WAJIB** mengimplementasikan `Hash` secara manual juga (hanya menghash field yang dibandingkan). Jika tidak, jika Anda menaruh struct tersebut ke `HashMap`, program Anda akan patah (*Hash set mengembalikan value salah pada key yang sama!*). Selalu pegang hukum: `k1 == k2 ➡ hash(k1) == hash(k2)`.
