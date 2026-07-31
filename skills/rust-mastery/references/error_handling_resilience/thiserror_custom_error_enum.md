# `thiserror`: Domain-Specific Custom Error Enums

## 1. Konsep Utama & Kapan Digunakan
`thiserror` adalah de facto standard di ekosistem Rust untuk membuat tipe error khusus di level *library* atau *domain logic*. Alih-alih menulis implementasi manual untuk `std::error::Error`, `std::fmt::Display`, dan `std::convert::From` (yang memakan banyak boilerplate), `thiserror` menyediakan custom derive macro `#[derive(Error)]`. 

Gunakan `thiserror` ketika:
- Anda membuat library yang akan dikonsumsi oleh aplikasi/library lain.
- Anda mendefinisikan batas sistem yang ketat (misal: layer repository vs layer HTTP).
- Konsumen dari API Anda perlu melakukan percabangan logika (`match`) berdasarkan jenis error spesifik, bukan sekadar melihat log atau string.

## 2. Arsitektur / Flow

```ascii
[ Database / I/O ] -> (std::io::Error)
        |
        v  #[from] macro auto-conversion
[ Domain Layer ] -> (crate::domain::UserError)
        |
        v  Manual mapping to HTTP layer
[ HTTP API Layer ] -> (HTTP 404 / 500)
```

## 3. Kode Rust Production-Ready

```rust
use std::path::PathBuf;
use thiserror::Error;

/// Tipe Error representatif dari Domain User.
#[derive(Debug, Error)]
pub enum UserError {
    /// Error dengan format string dinamis
    #[error("User with ID {0} not found")]
    NotFound(uuid::Uuid),

    /// Validation error tanpa source dari luar
    #[error("Invalid username: {username} - {reason}")]
    InvalidInput {
        username: String,
        reason: String,
    },

    /// Transparent: Meneruskan pesan error langsung dari source tanpa 
    /// menambahkan context tambahan dalam Display format.
    #[error(transparent)]
    DatabaseError(#[from] sqlx::Error),

    /// Menggunakan #[source] tanpa #[from] jika konversi eksplisit diperlukan.
    /// Ini berguna jika tipe error asal dipetakan ke lebih dari satu varian.
    #[error("Failed to load avatar from {path}")]
    AvatarLoadError {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub struct UserService;

impl UserService {
    pub async fn get_user(id: uuid::Uuid) -> Result<String, UserError> {
        // Asumsi query db
        let res = sqlx::query!("SELECT name FROM users WHERE id = $1", id).fetch_one(&pool).await?;
        
        Ok(res.name)
    }

    pub fn load_avatar(path: PathBuf) -> Result<Vec<u8>, UserError> {
        std::fs::read(&path).map_err(|source| UserError::AvatarLoadError {
            path,
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = UserError::InvalidInput {
            username: "admin%".to_string(),
            reason: "Contains invalid characters".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Invalid username: admin% - Contains invalid characters"
        );
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `#[from]` sembarangan pada banyak tipe generic I/O error.**
   - *Bahaya*: Jika `std::io::Error` memiliki `#[from]`, setiap operasi I/O yang gagal akan otomatis masuk ke varian ini saat menggunakan `?`. Masalahnya, Anda kehilangan *konteks* operasi I/O apa yang gagal (apakah gagal baca config? baca avatar? tulis log?).
   - *Solusi*: Gunakan `#[source]` tanpa `#[from]` untuk I/O dan rekatkan konteksnya, misalnya path file yang gagal dibuka.
2. **Membuat *God Error Enum* untuk seluruh aplikasi monolith.**
   - *Bahaya*: Semua fungsi mengembalikan `Result<T, AppError>`. Enum ini membengkak dengan 100+ varian. Pemanggil tidak tahu varian mana yang *sebenarnya* bisa dikembalikan oleh suatu fungsi (menggagalkan exhaustiveness checking di level mental developer).
   - *Solusi*: Buat tipe error spesifik per modul atau trait (misal: `AuthError`, `StorageError`).

## 5. Edge Cases & Defensive Programming
- **`#[error(transparent)]` vs context**: Saat menggunakan `transparent`, format `Display` dari enum adalah format `Display` dari source-nya. Pastikan Anda benar-benar tidak butuh konteks tambahan. Seringkali `#[error("Database error during {operation}")]` lebih baik daripada `transparent`.
- Pastikan enum error Anda merepresentasikan state bisnis yang actionable. Jika consumer hanya akan me-log errornya, gunakan `anyhow` alih-alih merancang hirarki `thiserror` yang kompleks.
