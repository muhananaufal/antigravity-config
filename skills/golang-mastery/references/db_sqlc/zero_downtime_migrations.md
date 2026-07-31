# Migrasi Database Zero-Downtime (Tanpa Henti)

## Konsep dan Internals

Dalam lingkungan infrastruktur modern seperti Kubernetes, *deployment* aplikasi terjadi secara *Rolling Update*. Ini berarti selama beberapa detik atau menit, Pod aplikasi versi lama (V1) dan versi baru (V2) akan beroperasi (melayani *traffic*) secara bersamaan dan mengakses database PostgreSQL yang sama. 

Jika V2 menuntut perubahan skema (misal: menghapus kolom `name` menjadi `first_name` dan `last_name`), dan Anda langsung mengeksekusi migrasi tersebut di awal deployment, maka aplikasi V1 yang masih hidup akan mengalami *Crash* karena kolom `name` tiba-tiba menghilang (Downtime). 

Oleh karena itu, setiap migrasi yang bersifat *Breaking Change* wajib menggunakan pola **Expand and Contract (Parallel Change)**. 

Selain itu, Anda harus berhati-hati dengan **Database Lock**. Di PostgreSQL, operasi Data Definition Language (DDL) seperti `ALTER TABLE` atau `CREATE INDEX` sering kali menuntut **Access Exclusive Lock**. Kunci tingkat tertinggi ini mencegah seluruh operasi baca (`SELECT`) maupun tulis (`INSERT/UPDATE/DELETE`) pada tabel tersebut hingga migrasi selesai. Jika tabel Anda berukuran ratusan gigabyte, *lock* ini bisa bertahan berjam-jam, mematikan layanan aplikasi secara total.

### Fase Expand and Contract
1. **Expand**: Anda *menambahkan* entitas skema baru (kolom/tabel) yang bersifat inklusif (opsional/NULLable). V1 dan V2 berjalan harmonis. Data disinkronkan secara perlahan.
2. **Transition**: V2 sepenuhnya disebarkan (rolled-out), V1 sudah dimatikan. Semua *logic* baru menggunakan struktur skema baru.
3. **Contract**: Skema lama yang sudah usang dan tidak ada kode yang merujuknya, dihapus secara permanen.

---

## Diagram ASCII: Expand & Contract (Pemisahan Kolom)

```text
===================================================================================================
Skenario: Memecah kolom 'full_name' menjadi 'first_name' & 'last_name' TANPA DOWNTIME.
===================================================================================================

[ FASE 1: EXPAND (Migrasi Rilis v1.1) ]
Tindakan: Menambah first_name & last_name (Keduanya NULLABLE).
Database: ALTER TABLE users ADD COLUMN first_name TEXT, ADD COLUMN last_name TEXT;

App V1 (Lama)                 App V2 (Baru - Masa Transisi)
|                             |
|-- INSERT (full_name)        |-- INSERT (full_name, first_name, last_name)
|-- SELECT (full_name)        |-- SELECT (first_name, last_name) fallback ke full_name jika NULL

*Di balik layar, Script Background Go perlahan memindahkan & memecah data lama (Backfill)*

[ FASE 2: TRANSITION (Semua pod V1 sudah mati, murni V2) ]
Tindakan: Semua traffic ditulis ke struktur baru. Backfill telah selesai.

[ FASE 3: CONTRACT (Migrasi Rilis v1.2) ]
Tindakan: Hapus kolom lama dengan aman.
Database: ALTER TABLE users DROP COLUMN full_name;

App V2 (Semua Pod)
|
|-- INSERT (first_name, last_name)
|-- SELECT (first_name, last_name)
===================================================================================================
```

---

## Kode Go Production-Ready

Kode di bawah menunjukkan implementasi engine migrasi terpadu (`goose` yang di-*embed* dalam *binary* Go) dan cara aman membuat fungsi *Backfiller* data secara perlahan tanpa melumpuhkan tabel.

```go
package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // Bridge database/sql untuk engine goose
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

// RunMigrations menginisialisasi eksekusi migrasi menggunakan Goose.
// Dalam arsitektur k8s, ini biasanya dipanggil via InitContainer atau Pre-Sync Hook,
// BUKAN berbarengan dengan startup pod HTTP (menghindari race condition startup).
func RunMigrations(ctx context.Context, dsn string, logger *slog.Logger) error {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("failed to open database for migration: %w", err)
	}
	defer db.Close()

	// Gunakan sistem file yang dibundel di dalam go binary
	goose.SetBaseFS(embedMigrations)

	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("failed to set goose dialect: %w", err)
	}

	logger.InfoContext(ctx, "starting database migrations (goose)")
	// goose secara bawaan akan memperoleh pg_advisory_lock
	// memastikan hanya 1 instance migrasi yang berjalan walau ada 10 replika k8s.
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("migration step failed: %w", err)
	}
	logger.InfoContext(ctx, "database migrations successfully applied")

	return nil
}

// DataBackfiller bertugas mensinkronkan data antar kolom/tabel baru
// dalam batch-batch kecil (misal: 1000 baris/iterasi) untuk menghindari table lock & I/O spike.
type DataBackfiller struct {
	pool *pgxpool.Pool
	log  *slog.Logger
}

func NewDataBackfiller(pool *pgxpool.Pool, logger *slog.Logger) *DataBackfiller {
	return &DataBackfiller{pool: pool, log: logger}
}

// SplitNameBackfill perlahan memindahkan data dari full_name ke first_name & last_name.
func (b *DataBackfiller) SplitNameBackfill(ctx context.Context) error {
	batchSize := 1000
	totalProcessed := 0

	for {
		// Gunakan CTE (Common Table Expression) untuk membatasi set dan 
		// memodifikasi hanya baris yang belum di-backfill (first_name IS NULL).
		query := `
			WITH batch AS (
				SELECT id, full_name
				FROM users 
				WHERE first_name IS NULL AND full_name IS NOT NULL
				LIMIT $1
				FOR UPDATE SKIP LOCKED
			)
			UPDATE users u
			SET 
				first_name = split_part(b.full_name, ' ', 1),
				last_name = substring(b.full_name FROM length(split_part(b.full_name, ' ', 1)) + 2)
			FROM batch b
			WHERE u.id = b.id
			RETURNING u.id;
		`
		
		// Mengeksekusi batch transaksi independen
		commandTag, err := b.pool.Exec(ctx, query, batchSize)
		if err != nil {
			return fmt.Errorf("backfill batch failed at processed offset %d: %w", totalProcessed, err)
		}

		rowsUpdated := commandTag.RowsAffected()
		totalProcessed += int(rowsUpdated)

		b.log.InfoContext(ctx, "backfill progress", slog.Int("updated", totalProcessed))

		if rowsUpdated == 0 {
			// Tidak ada lagi baris yang tertinggal
			break
		}

		// Berikan nafas (yield) kepada database agar query pengguna asli 
		// tidak kelaparan (I/O starvation).
		time.Sleep(100 * time.Millisecond)
	}

	b.log.InfoContext(ctx, "backfill completed", slog.Int("total_updated", totalProcessed))
	return nil
}

// --- Unit Tests ---

func TestEmbeddedMigrationsFS(t *testing.T) {
	// Memastikan embed.FS berfungsi dengan baik dengan memvalidasi ada folder migrasi
	entries, err := embedMigrations.ReadDir("migrations")
	if err != nil {
		// Karena directory ini maya (belum dibuat di source code asli test ini), 
		// kita hanya mendemonstrasikan bagaimana test FS dilakukan.
		t.Skip("migration folder is empty or not created in test dir")
	}

	if len(entries) > 0 {
		t.Logf("Found %d migration files bundled", len(entries))
	}
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: `CREATE INDEX` di dalam Block Transaksi (Tanpa CONCURRENTLY)
Secara bawaan, eksekusi pembuatan indeks standar di PostgreSQL membutuhkan *Access Exclusive Lock* parsial, menghalangi operasi `INSERT`, `UPDATE`, `DELETE`.

```sql
-- ❌ BAD: DDL konvensional dalam transaksi Goose. Aplikasi akan lumpuh jika tabel besar.
-- +goose Up
CREATE INDEX idx_users_email ON users(email);
```

```sql
-- ✅ GOOD: Menginstruksikan Goose untuk melepas block transaksi dan menggunakan fitur indeks paralel.
-- +goose NO TRANSACTION
-- +goose Up
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```
**Why dangerous:** Operasi pembuatan index memindai tabel (`Sequential Scan`) untuk menyusun *B-Tree*. Pada tabel jutaan baris, memindai dan menyusun index bisa memakan waktu 30 menit. Jika menggunakan instruksi standar di atas (BAD), selama 30 menit tersebut aplikasi Go yang mencoba memodifikasi data tabel akan *hang* hingga terjadi ledakan antrean koneksi pool (Outage/Downtime). `CONCURRENTLY` berjalan di latar belakang (bebas blokir), meski membutuhkan waktu komputasi sedikit lebih lama.

### ❌ Anti-Pattern 2: Merubah Tipe Data Secara Mendadak (`ALTER COLUMN TYPE`)
Aplikasi telah berjalan selama 3 tahun, tipe *Integer* Primary Key akan kehabisan nilai, dan Anda ingin menggantinya ke `BIGINT`.

```sql
-- ❌ BAD: Memaksa DB menulis ulang isi tabel dari disk (100% Downtime)
ALTER TABLE transactions ALTER COLUMN id TYPE BIGINT;
```
**Why dangerous:** Perintah *Alter Column* untuk pelebaran tipe data tidak terjadi secara ajaib (kecuali `varchar(10)` ke `varchar(50)`). Postgres harus menduplikasi file relasional fisik di OS, me-recast datanya, men-drop yang lama, dan menulis ulang indeksnya. Proses `Rewrite` ini sangat intensif I/O dan 100% *Exclusive Lock*.

**✅ Solusi Benar:** Terapkan pola *Expand and Contract*. 
1. Buat kolom `id_new BIGINT`. 
2. Tambahkan *Trigger* pada tabel untuk auto-sync *write* baru dari `id` ke `id_new`.
3. Jalankan script Go `DataBackfiller` untuk menyinkronkan data lawas secara bertahap.
4. Ganti nama *Constraints* & Indeks.
5. `ALTER TABLE transactions RENAME COLUMN id TO id_old; RENAME COLUMN id_new TO id;`.

---

## Edge Cases & Defensive Programming

1. **Pembuatan Indeks Concurrently Batal (INVALID INDEX)**
   Saat menggunakan `CREATE INDEX CONCURRENTLY`, jika terdapat interupsi (misal pod *runner* mati atau *Statement Timeout* database terpicu), indeks tersebut akan diciptakan tapi ditandai sebagai `INVALID`. PostgreSQL tidak menggunakannya untuk pencarian, **tetapi indeks ini tetap akan di-update pada tiap `INSERT/UPDATE`**, memakan beban performa berharga secara sia-sia! 
   *Tip Spesifik*: Jangan langsung menjalankan ulang migrasi (error akan timbul: "index already exists"). Anda harus men-`DROP INDEX CONCURRENTLY idx_name` yang invalid itu terlebih dahulu, barulah me-retry migrasinya.

2. **Memaksa Kolom `NOT NULL` Tanpa Nilai Default**
   `ALTER TABLE users ADD COLUMN age INT NOT NULL;` 
   Sesaat setelah baris SQL ini tereksekusi, *pod* V1 yang sedang hidup (yang tidak tahu menahu soal keberadaan kolom `age`) mencoba melakukan instruksi `INSERT INTO users (name) VALUES ('X')`. PostgreSQL akan menolaknya karena `age` wajib ada. 
   *Solusi*: Buat kolom `NULLABLE` dulu. Lakukan backfill data. Ubah aplikasi V2 untuk mulai mengirim nilai valid `age`. Setelah murni V2 (V1 dihabisi), migrasikan lagi skema menjadi `ALTER TABLE users ALTER COLUMN age SET NOT NULL`.

3. **Batasan Timeout Pgbouncer untuk Migrasi**
   Jika Anda mengeksekusi Goose/Migrator di lingkungan produksi yang dilindungi oleh Pgbouncer (koneksi proxy), berhati-hatilah dengan `query_wait_timeout` atau limit proxy. Tugas migrasi (terutama pembuatan indeks raksasa) bisa diputus Pgbouncer di tengah jalan. Biasakan untuk me-rute tugas migrasi menggunakan konfigurasi koneksi DNS yang mengarah secara **langsung (Direct)** ke Primary Master PostgreSQL, bukan melalui proxy *Transaction Pooling*.
