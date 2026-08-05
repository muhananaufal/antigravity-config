# Database Persistence & SQLx (Top 1% Architecture)

## 1. Fundamental Law & Mechanical Sympathy

Di dunia asinkron Rust, berinteraksi dengan pangkalan data (*database*) relasional menghadirkan tantangan teknis brutal: kita harus menghindari pemblokiran eksekutor asinkron, memastikan keamanan tipe kompilasi (*compile-time type safety*), dan menjaga siklus hidup koneksi melalui kolam koneksi (*Connection Pooling*). **SQLx** telah menjadi standar industri Top 1% (melampaui Diesel) karena ia merupakan kerangka asinkron sejati yang tidak memerlukan OS *thread* tersendiri untuk operasi I/O, serta tidak memerlukan abstraksi *Domain Specific Language* (DSL) yang menyembunyikan SQL asli Anda.

Secara mekanik (*Mechanical Sympathy*), SQLx menggunakan fitur makro `query!` yang berkomunikasi dengan pangkalan data langsung **saat proses kompilasi (cargo build)** berjalan. Makro ini meminta pangkalan data untuk memvalidasi sintaks SQL Anda, memeriksa apakah kolom benar-benar ada, dan memastikan tipe data sesuai dengan *struct* Rust Anda. Jika kueri Anda `SELECT name FROM users` tetapi kolom `name` bertipe `NULLABLE` di Postgres, Rust akan memaksa Anda menanganinya sebagai `Option<String>`, memusnahkan ancaman *Null Pointer Exception* di tingkat kompilator. Ini adalah sihir arsitektur yang tidak dimiliki ekosistem bahasa lain.

## 2. Top 1% Production Architecture

Arsitektur Enterprise menghindari koneksi basis data global. Sebagai gantinya, mereka mendirikan *Connection Pool* dengan batasan terukur dan menyuntikkannya *(Dependency Injection)* ke lapisan repositori.

### 2.1 The Asynchronous Connection Pool (PgPool)
Kolam koneksi bertugas memelihara beberapa jalur TCP aktif ke Postgres. Konfigurasi `max_connections` dan `acquire_timeout` adalah kunci untuk bertahan dari *Traffic Spikes*.

```rust
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;

pub async fn establish_connection_pool(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        // Jangan pasang terlalu tinggi. Rumus ideal: ((Core CPU * 2) + Effective Spindles)
        .max_connections(50)
        // Putuskan koneksi jika db membisu selama 3 detik
        .acquire_timeout(Duration::from_secs(3))
        // Ping koneksi yang diam untuk mencegah pemutusan oleh Firewall
        .idle_timeout(Duration::from_secs(600))
        .connect(database_url)
        .await
}
```

### 2.2 Compile-Time Verified Repositories
Gunakan pola Repositori untuk mengisolasi logika SQL dari lapisan *HTTP/gRPC Handler*. Penggunaan makro `query_as!` secara magis akan memetakan baris hasil dari *database* ke dalam struktur memori (*Struct*) secara *Zero-Copy* atau *low-overhead*.

```rust
use sqlx::PgPool;
use uuid::Uuid;
use chrono::{DateTime, Utc};

// Derivasi dasar untuk DTO (Data Transfer Object)
#[derive(Debug, sqlx::FromRow)]
pub struct UserRecord {
    pub id: Uuid,
    pub username: String,
    pub created_at: DateTime<Utc>, // Postgres TIMESTAMPTZ maps to chrono automatically
}

pub struct UserRepository {
    pool: PgPool,
}

impl UserRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn find_by_id(&self, user_id: Uuid) -> Result<Option<UserRecord>, sqlx::Error> {
        // MAHA-OPUS: "query_as!" memvalidasi SQL ini langsung ke DB saat 'cargo build' dijalankan!
        let user = sqlx::query_as!(
            UserRecord,
            r#"
            SELECT id, username, created_at
            FROM users
            WHERE id = $1
            "#,
            user_id
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(user)
    }
}
```

## 3. Failure & Edge-Case Anomaly Matrix

| Kelas Anomali | Gejala / Dampak Mutlak | Matriks Mitigasi (Top 1% Tactic) |
| :--- | :--- | :--- |
| **Connection Pool Exhaustion** | Seluruh *request* HTTP melempar *Timeout Error*. Metrik *database* menunjukkan 0 kueri aktif, tapi aplikasi tidak bisa meminjam koneksi. | Penyebab utama adalah Anda membuka *database transaction* (`pool.begin().await`) namun lupa melakukan `.commit()` atau `.rollback()`. Transaksi yang menggantung (*dangling*) menahan koneksi selamanya. Rust membuang (*drop*) transaksi secara otomatis sebagai *rollback* jika keluar cakupan (*out of scope*), namun pastikan Anda tidak menahannya di dalam variabel *struct* berumur panjang. |
| **CI/CD Build Failures (No DB)** | Pipeline Github Actions Anda gagal di langkah `cargo build` karena ia tidak menemukan Postgres untuk memvalidasi makro `query!`. | Gunakan mode **Offline** pada SQLx. Eksekusi perintah `cargo sqlx prepare` secara lokal, yang akan melahirkan berkas `.sqlx/` berisi metadata kueri. Simpan (*commit*) berkas tersebut ke Git. CI/CD akan membaca berkas tersebut tanpa perlu koneksi DB fisik. |
| **N+1 Query Amplification** | Mengeksekusi `.fetch_one()` di dalam putaran `for` menghasilkan ratusan latensi jaringan (RRT). | Jangan pernah melakukan *loop kueri*. Di SQLx, gunakan makro unnest array postgres atau gunakan kueri dengan perintah `IN (...)` untuk meraup (*batching*) semuanya dalam satu panggilan jaringan. |

## 4. High-Assurance Testing

Pengujian basis data tingkat lanjut tidak boleh saling bertabrakan (*race condition*) antar kasus uji. Top 1% *Engineers* menggunakan penanda (flag) transaksional di SQLx untuk membatalkan (*rollback*) seluruh mutasi data sesaat setelah sebuah *Test* selesai dijalankan.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    // The #[sqlx::test] macro automatically provides a fresh, isolated database connection pool!
    #[sqlx::test]
    async fn test_find_by_id_returns_user(pool: PgPool) {
        // Arrange: Insert dummy data directly
        let test_id = Uuid::new_v4();
        sqlx::query!(
            "INSERT INTO users (id, username, created_at) VALUES ($1, $2, NOW())",
            test_id, "test_user"
        )
        .execute(&pool)
        .await
        .unwrap();

        let repo = UserRepository::new(pool);

        // Act
        let result = repo.find_by_id(test_id).await.unwrap();

        // Assert
        assert!(result.is_some());
        assert_eq!(result.unwrap().username, "test_user");
        
        // Auto-rollback happens magically at the end of the test boundary!
    }
}
```

## 5. Anti-Patterns & "When NOT to Use" Matrix

### Anti-Pattern: Mengembalikan Raw `sqlx::Error` hingga ke API Endpoint
Pemula sering menggunakan `?` (operator try) untuk mempropagasi *error* dari SQLx langsung ke *handler* Axum yang mengimplementasikan HTTP 500.

**Mengapa ini fatal?**
- **Pros:** Tidak perlu merancang tipe galat (Error Enum) sendiri.
- **Cons (1):** *Data Leakage (OWASP)*. Kesalahan `sqlx::Error::Database(err)` mungkin memuat pesan "*Duplicate key violation on constraint 'users_email_key'*". Mengirimkan ini ke antarmuka klien mengungkap skema rahasia struktur basis data Anda.
- **Cons (2):** Merusak pengalaman pengguna (UX). Pelanggaran kunci ganda (*Unique Constraint*) seharusnya diolah menjadi respons manis 409 Conflict ("Email sudah terdaftar"), bukan 500 Internal Server Error.

**Kapan Makro `query!` SQLx TIDAK Boleh Digunakan:**
- **Kueri Dinamis (Dynamic Queries):** Jika tabel, kolom, atau *WHERE clause* Anda bersifat amat dinamis (tergantung *filter input* pengguna), kompilator tidak dapat memverifikasinya. Di situasi ini, Anda WAJIB meninggalkan makro `query!` dan beralih menggunakan Query Builder standar `sqlx::QueryBuilder` atau alat khusus (seperti *SeaORM*).
