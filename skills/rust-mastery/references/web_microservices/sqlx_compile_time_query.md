# SQLx Compile-Time Queries & Connection Pool

## Konsep Utama
**SQLx** adalah framework database async murni untuk Rust. Keunggulan utamanya adalah makro `query!` dan `query_as!` yang memvalidasi sintaks SQL dan tipe data tabel secara **compile-time**. Ini berarti Anda tidak akan pernah menemukan syntax error SQL atau tipe data mismatch di production; compiler Rust akan menolaknya.

Konsep kunci lainnya adalah **PgPool** (Connection Pooling) dan **Transaction**, yang krusial untuk aplikasi web dengan concurrency tinggi (microservices).

**Kapan Digunakan:**
- Akses database di semua API layer.
- Eksekusi transaksi atomik (misal: Transfer saldo antar akun).
- Aplikasi yang memerlukan strict type-safety pada skema database-nya.

## Arsitektur & Flow

```ascii
+-----------------+       +--------------------+      +------------------+
| Rust Compiler   |       |  .env (DATABASE_URL)|     | PostgreSQL (Dev) |
| macro expansion +---+-->|  sqlx-data.json    |----->| Schema Validation|
+-----------------+   |   +--------------------+      +------------------+
                      v
+-----------------+       +--------------------+      +------------------+
| Axum Handler    | ----> |  sqlx::PgPool      | ---->| PostgreSQL (Prod)|
+-----------------+       +--------------------+      +------------------+
                          | max_connections: 50|
                          | idle_timeout: 3m   |
                          +--------------------+
```

## Production-Ready Code

```rust
use sqlx::{postgres::PgPoolOptions, PgPool, Transaction, Postgres};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Not found")]
    NotFound,
}

// Domain Model
#[derive(Debug)]
pub struct User {
    pub id: uuid::Uuid,
    pub username: String,
    pub is_active: bool,
}

// 1. Inisialisasi Pool dengan best practices untuk production
pub async fn init_db_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(50) // Sesuaikan dengan instance DB
        .min_connections(5)
        .idle_timeout(std::time::Duration::from_secs(300))
        .acquire_timeout(std::time::Duration::from_secs(5)) // Jangan biarkan request hang selamanya
        .connect(database_url)
        .await
}

// 2. Query_as! untuk compile time verification (Mencocokkan row ke Struct)
pub async fn get_user_by_id(pool: &PgPool, user_id: uuid::Uuid) -> Result<User, DbError> {
    // Note: macro ini butuh env DATABASE_URL saat compile time
    // atau gunakan cargo sqlx prepare (offline mode)
    let user = sqlx::query_as!(
        User,
        r#"
        SELECT id, username, is_active
        FROM users
        WHERE id = $1
        "#,
        user_id
    )
    .fetch_optional(pool)
    .await?;

    user.ok_or(DbError::NotFound)
}

// 3. Transaksi Aman (Atomic Operation)
pub async fn create_user_with_audit(
    pool: &PgPool,
    username: &str,
) -> Result<uuid::Uuid, DbError> {
    // Mulai transaksi
    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;

    let new_id = uuid::Uuid::new_v4();

    // Query 1
    sqlx::query!(
        r#"
        INSERT INTO users (id, username, is_active)
        VALUES ($1, $2, $3)
        "#,
        new_id,
        username,
        true
    )
    .execute(&mut *tx) // Execute di scope transaksi
    .await?;

    // Query 2
    sqlx::query!(
        r#"
        INSERT INTO audit_logs (action, user_id)
        VALUES ($1, $2)
        "#,
        "USER_CREATED",
        new_id
    )
    .execute(&mut *tx)
    .await?;

    // JIKA tx.commit() TIDAK DIPANGGIL, akan otomatis di-ROLLBACK saat tx di-drop.
    tx.commit().await?;

    Ok(new_id)
}

// #[cfg(test)] requires live DB or mock.
```

## Anti-Patterns

1. **Mengabaikan Transaction Rollback / Tidak Menggunakan Drop Semantics**
   - **MENGAPA BERBAHAYA:** Transaksi di SQLx otomatis di-rollback jika variabel `Transaction` di-drop (misalnya karena `?` error operator me-return error secara dini). Anti-pattern-nya adalah secara manual menangkap error dan mengabaikan `tx.rollback().await`, atau meng-clone connection alih-alih me-pass reference transaction. Biarkan RAII (Drop) SQLx yang menangani rollback otomatis jika tidak terjadi explicit `commit()`.
2. **Unbounded Connection Pool / Tanpa `acquire_timeout`**
   - **MENGAPA BERBAHAYA:** Menggunakan default settings pada database yang lambat (karena bad query / high load). Tanpa batas koneksi yang rasional dan `acquire_timeout`, server web akan spawn thread / task menunggu koneksi ke database, yang berujung pada kehabisan memori atau koneksi open socket file descriptors. 

## Edge Cases & Defensive Programming
- **CI/CD Build Tanpa Database (Offline Mode):** Karena macro `query!` bergantung pada database live saat kompilasi, pipeline CI Anda akan gagal. Gunakan perintah `cargo sqlx prepare` sebelum commit kode. Ini akan men-generate file `sqlx-data.json` yang menyimpan cache skema. Compiler akan membaca ini jika diletakkan environment variable `SQLX_OFFLINE=true`.
- **Query `IN (...)` dengan SQLx:** Macro query biasa tidak bisa menangani klausa SQL `IN` untuk dynamic array. Gunakan operator `= ANY($1)` pada PostgreSQL.
  - *Contoh Benar:* `SELECT * FROM users WHERE id = ANY($1)` dengan passing `&vec_of_ids`.
