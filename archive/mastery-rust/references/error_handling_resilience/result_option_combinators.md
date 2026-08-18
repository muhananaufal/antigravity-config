# Result & Option Combinators (Zero-Branch Monadic Chaining)

Dalam kode Rust Systems tingkat lanjut (misal State Machine HFT atau Network Packet Parsers), kemunculan blok `match` atau `if let` yang bertumpuk untuk memeriksa `Option` atau `Result` (biasa disebut *Arrow Anti-Pattern* atau *Pyramid of Doom*) tidak hanya merusak keterbacaan (readability), tetapi juga membingungkan Branch Predictor CPU jika tidak di-inline dengan baik.

Rust menyediakan **Monadic Combinators** bawaan pada `Option` dan `Result` seperti `and_then`, `or_else`, `map_or_else`, `transpose`, dan `flatten`. Menggunakan rantai (chaining) dari kombinasinya menghasilkan alur data fungsional linier yang secara sempurna dikompilasi (zero-cost abstraction) ke bentuk machine code tanpa instruksi loncatan bercabang ganda.

## Arsitektur Monadic Transformation Flow

```ascii
[ Data Stream: Option<Result<Payload, Error>> ]
           |
           v
  ( transpose() ) ---> Mengubah Option<Result> menjadi Result<Option>
           |
[ Result<Option<Payload>, Error> ]
           |
           v ( ? Operator Unwrapping pada outer Result )
[ Option<Payload> ]
           |
           v
  ( and_then() ) ----> [ Chain Operation yang bisa gagal (mengembalikan Option) ]
           |
  ( or_else() ) -----> [ Fallback State Recovery tanpa break / return awal ]
           |
           v
  ( map_or_else() ) -> [ Transformasi akhir ke tipe Skalar Konkret T ]
           |
       [ Final Value (Zero Nested Branches!) ]
```

## Produksi-Ready Code: Data Pipeline Monadik Murni

Kode di bawah menunjukkan pipeline parsing dan validasi token autentikasi yang kompleks menjadi linier tanpa ada satu pun statement `match` secara eksplisit, menghapus potensi percabangan instruksi yang bersarang.

```rust
use std::num::ParseIntError;

#[derive(Debug, PartialEq, Eq)]
pub struct AuthContext {
    user_id: u32,
    role: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    InvalidFormat,
    Expired,
    ParseError(ParseIntError),
}

/// Mensimulasikan fetch token kotor dari Request Header (bisa saja None)
pub fn fetch_header_token() -> Option<String> {
    Some("Bearer 99281_admin".to_string())
}

/// Pipeline parsing dengan kombinator Zero-Branch
pub fn process_authentication() -> Result<AuthContext, AuthError> {
    // Pipeline data monadik. 
    // Tidak ada `match` atau `if let` sama sekali.
    let ctx = fetch_header_token()
        // 1. Membuang awalan yang statis
        .and_then(|token| token.strip_prefix("Bearer ").map(String::from))
        
        // 2. Transisi Option ke Result dengan tipe error kita jika None
        .ok_or(AuthError::InvalidFormat)
        
        // 3. and_then pada Result, operasi parsial memecah string menjadi struct
        .and_then(|payload| {
            let parts: Vec<&str> = payload.split('_').collect();
            
            // Mengubah Option (dari parts.get) menjadi Result
            let id_str = parts.get(0).ok_or(AuthError::InvalidFormat)?;
            let role_str = parts.get(1).ok_or(AuthError::InvalidFormat)?;
            
            // Map error dari ParseIntError bawaan ke custom enum
            let user_id = id_str.parse::<u32>().map_err(AuthError::ParseError)?;
            
            Ok(AuthContext {
                user_id,
                role: role_str.to_string(),
            })
        })
        // 4. or_else untuk Fallback Mechanism jika terjadi gagal spesifik
        .or_else(|err| {
            // Jika InvalidFormat, kita bisa fallback sebagai "Guest"
            if err == AuthError::InvalidFormat {
                Ok(AuthContext {
                    user_id: 0,
                    role: "guest".to_string(),
                })
            } else {
                Err(err)
            }
        });

    ctx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_combinator_pipeline() {
        let result = process_authentication();
        assert!(result.is_ok());
        let ctx = result.unwrap();
        
        assert_eq!(ctx.user_id, 99281);
        assert_eq!(ctx.role, "admin");
    }

    #[test]
    fn test_option_result_transpose() {
        // Contoh spesifik untuk `transpose()`
        // Bayangkan API me-return array dimana salah satu isinya adalah Option<Result<u32>>
        let opt_res: Option<Result<u32, &'static str>> = Some(Err("Network lag"));
        
        // Diubah menjadi Result<Option<u32>>, sehingga operator `?` bisa dipakai langsung
        let res_opt: Result<Option<u32>, &'static str> = opt_res.transpose();
        
        assert_eq!(res_opt, Err("Network lag"));
    }
}
```

## Anti-Patterns

1. **Penggunaan `unwrap_or()` Memakan Eksekusi Penuh secara Instan**
   **Mengapa berbahaya:** `unwrap_or(compute_expensive_fallback())` akan SELALU mengeksekusi `compute_expensive_fallback()` sebelum nilai result dievaluasi! Hal ini karena Rust menjalankan fungsi argument parameter (eager evaluation). Ini bisa melumpuhkan performa CPU atau Database.
   **Solusi:** Harus selalu menggunakan `unwrap_or_else(|| compute_expensive_fallback())` yang berbentuk *closure* (lazy evaluation), sehingga logika fallback hanya berjalan jika memang terdeteksi `Err` atau `None`.

2. **Memaksakan `match` Beruntun (Arrow Anti-Pattern)**
   **Mengapa berbahaya:** Anda menjorokkan kode ke kanan secara ekstrem. Selain kode menjadi rawan kotor, kompilator LLVM kadang gagal mengidentifikasi bahwa flow ini murni berantai dan gagal menerapkan Inlining blok fungsi, sehingga jump instructions bertambah banyak yang me-miss instruction cache L1.

## Edge Cases dan Defensive Programming

1. **Borrow Checker Constraints pada Kombinator Closures:**
   Seringkali saat menulis `result.and_then(|val| ... )`, jika Anda perlu mengembalikan referensi dengan lifetime ke memori lokal di luar closure tersebut, Borrow Checker akan memblokir Anda (Closure outlives lifetime constraint). Anda akan dipaksa mengubah aliran menjadi `match` tradisional yang secara lifetime lebih transparan bagi kompilator. 

2. **Operator `?` di dalam `map` Closure:**
   Anda **TIDAK BISA** menggunakan operator `?` untuk kembali secara sepihak (early return) pada fungsi luar dari dalam block closure fungsi kombinaor `map(|x| ...)`. Operator `?` di dalam closure hanya akan berlaku pada closure itu sendiri. Solusinya, ubah desain dari fungsi pemetaan (map) ke `and_then` agar bisa mengembalikan `Result`, baru panggil operator `?` pada rantai terluarnya.

3. **Tipe Data Kompleks Menggagalkan Type Inference:**
   Ketika melakukan rantai `.and_then(...).or_else(...).map_err(...)`, ada kalanya kompilator Rust bingung menebak tipe *Err* menengah jika menggunakan closure dinamis yang kosong seperti `|e| e.into()`. Anda terpaksa memberikan *Type Hint* atau *turbofish* (contoh: `.map_err::<DatabaseError, _>(...)`) untuk meredakan kebingungan type inference LLVM.
