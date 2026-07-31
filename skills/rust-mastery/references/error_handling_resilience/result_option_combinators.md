# Kombinator `Result` & `Option` di Rust

## 1. Konsep Utama & Kapan Digunakan
Rust menghindari exception (`try-catch`), dan menggunakan tipe aljabar (enum) `Result<T, E>` dan `Option<T>`. Kombinator (methods pada `Option`/`Result` yang menerima closure) memungkinkan transformasi fungsional yang deklaratif, aman, dan tanpa variabel mutable berlebih.

Gunakan combinators ketika:
- Anda ingin menghindari blok `match` atau `if let` bersarang yang dalam ("Pyramid of Doom").
- Mengonversi `Option` ke `Result` atau sebaliknya secara elegan.
- Melakukan chaining transformasi data yang kompleks.

## 2. Arsitektur / Flow

```ascii
[ Option<T> ] 
  -- map() --> [ Option<U> ]
  -- ok_or() --> [ Result<T, E> ]

[ Result<T, E> ]
  -- map_err() --> [ Result<T, F> ]
  -- and_then() --> [ Result<U, F> ]
  -- ok() --> [ Option<T> ]
```

## 3. Kode Rust Production-Ready

```rust
use std::env;

#[derive(Debug, PartialEq)]
pub struct DatabaseConfig {
    pub url: String,
    pub pool_size: u32,
}

#[derive(Debug, PartialEq)]
pub enum ConfigError {
    MissingUrl,
    InvalidPoolSize(std::num::ParseIntError),
}

pub fn load_db_config() -> Result<DatabaseConfig, ConfigError> {
    // 1. Mengubah Option ke Result menggunakan ok_or_else
    let url = env::var("DATABASE_URL")
        .ok_or_else(|| ConfigError::MissingUrl)?;

    // 2. Chaining: Option -> Option (map) -> Option (unwrap_or)
    let pool_size_str = env::var("POOL_SIZE").unwrap_or_else(|_| "10".to_string());

    // 3. Result -> Result (map_err)
    let pool_size = pool_size_str
        .parse::<u32>()
        .map_err(ConfigError::InvalidPoolSize)?;

    Ok(DatabaseConfig { url, pool_size })
}

pub fn parse_csv_row(row: &str) -> Option<u32> {
    // Transpose pattern: Iterator of Results -> Result of Vector
    // .and_then meratakan (flattens) Option<Option<T>> menjadi Option<T>
    row.split(',')
        .next()
        .and_then(|first_col| first_col.parse::<u32>().ok())
}

pub fn collect_results(results: Vec<Result<i32, &'static str>>) -> Result<Vec<i32>, &'static str> {
    // Ajaib! collect() tahu cara membalik Result<Vec> menjadi Vec<Result> dan berhenti di Error pertama.
    results.into_iter().collect::<Result<Vec<i32>, _>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collect_results() {
        let items = vec![Ok(1), Ok(2), Err("fail"), Ok(4)];
        let res = collect_results(items);
        assert_eq!(res, Err("fail"));
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `unwrap()` atau `expect()` pada path produksi.**
   - *Bahaya*: Langsung menghentikan (panic) aplikasi. Jika ini adalah HTTP handler, satu payload yang salah mematikan thread/task.
   - *Solusi*: Gunakan operator `?` atau ubah ke `.unwrap_or_default()` jika ada nilai default yang masuk akal.
2. **Bersarang panjang dengan `map` padahal fungsi dalam `map` me-return `Option`.**
   - *Bahaya*: Menghasilkan `Option<Option<T>>` atau `Result<Result<T, E>, E>`, yang membingungkan.
   - *Solusi*: Gunakan `and_then` (monadic bind) alih-alih `map` untuk fungsi yang mengembalikan tipe serupa, meratakannya ke `Option<T>` atau `Result<T, E>`.

## 5. Edge Cases & Defensive Programming
- **`transpose`**: Metode `.transpose()` sangat kuat. Seringkali Anda memiliki `Option<Result<T, E>>` (misal: "Mungkin ada nilai, jika ada ia mungkin error") tapi API mengharapkan `Result<Option<T>, E>` (misal: "Proses errornya sekarang juga, kalau sukses berikan sisa option-nya"). Gunakan `let res = opt_res.transpose()?;`.
- **Malas vs Eager**: Perhatikan beda `unwrap_or` (eager evaluation) vs `unwrap_or_else` (lazy closure evaluation). Selalu gunakan `_else` jika argumen berupa function call atau alokasi (misal `String::new()`).
