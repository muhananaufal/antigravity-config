# Migrasi Database Zero-Downtime (Tanpa Henti)

> **Berlaku:** PostgreSQL 14+ · **Lihat juga:** `db_sqlc/database_migration_go.md` · `db_sqlc/database_locking_strategies.md` · `db_sqlc/index_design_explain_analyze.md` · `db_sqlc/sharding_partitioning.md`

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

4. **Large Table Backfill dengan Batching**
   Saat Anda harus mengisi jutaan baris data (misal populate default value untuk kolom baru), menggunakan satu statement `UPDATE users SET new_col = 1` akan mengunci seluruh tabel (table lock) dan memenuhi WAL log.
   *Solusi*: Buat script Go terpisah yang me-loop ID dan menggunakan klausa `LIMIT`.
   ```go
   lastID := 0
   for {
       res, _ := db.Exec("UPDATE users SET new_col = 1 WHERE id > $1 AND id <= $2", lastID, lastID+1000)
       affected, _ := res.RowsAffected()
       if affected == 0 { break }
       lastID += 1000
       time.Sleep(50 * time.Millisecond) // Jitter untuk memberi nafas ke replikasi dan query lain
   }
   ```

## 6. Foreign Key Zero-Downtime Pattern

Menambahkan batasan Foreign Key (FK) pada tabel yang sibuk dengan jutaan baris (misalnya tabel `orders` yang merujuk tabel `users`) adalah mimpi buruk *downtime* potensial, karena operasi tersebut mengunci tabel yang merujuk (table lock) saat PostgreSQL memindai seluruh kolom untuk memvalidasi kunci relasi ke tabel tujuan.

### Mekanisme NOT VALID dan VALIDATE CONSTRAINT
PostgreSQL memiliki mekanisme 2 langkah yang tidak mengganggu:
1. **`NOT VALID`**: Tambahkan FK constraint. FK ini akan langsung diwajibkan untuk semua sisipan data *baru* (`INSERT/UPDATE`), tetapi *tidak akan* memvalidasi data *lama* sehingga kembali secara instan dan tidak mengunci tabel.
2. **`VALIDATE CONSTRAINT`**: Jalankan perintah terpisah di luar transaksi. Ini akan memindai data lama dan memvalidasinya di *background* menggunakan tipe lock parsial, tanpa memblokir lalu lintas aplikasi baca/tulis normal.

### Urutan Deployment Timing
1. **Deploy v1**: Jalankan migrasi menambahkan kolom `user_id` (NULLable) dan tambahkan `FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID`.
2. **Backfill**: Aplikasikan Data Backfill secara halus untuk menetapkan data relasi.
3. **Validate**: Jalankan migrasi mandiri `ALTER TABLE orders VALIDATE CONSTRAINT fk_user_id`. (Tabel tidak terkunci penuh).
4. **Deploy v2**: Paksa keamanan ketat dengan migrasi `ALTER TABLE orders ALTER COLUMN user_id SET NOT NULL`.

### Contoh Kode: Urutan Migration dengan `golang-migrate` / `goose`

**File 1: `001_add_fk_not_valid.sql`**
```sql
-- +goose Up
-- +goose StatementBegin
ALTER TABLE orders ADD COLUMN user_id INT;

-- Instan. Tidak memblokir tabel orders. 
-- Data BARU yang di INSERT ke orders sudah mulai dipantau oleh FK.
ALTER TABLE orders 
  ADD CONSTRAINT fk_orders_user_id 
  FOREIGN KEY (user_id) REFERENCES users(id) 
  NOT VALID;
-- +goose StatementEnd
```

**File 2: `002_validate_fk.sql`** (Biasanya dijalankan setelah Data Backfill selesai)
```sql
-- +goose Up
-- Harus menggunakan NO TRANSACTION atau Statement ini di-lock Goose secara eksklusif.
-- +goose NO TRANSACTION
-- Memindai tabel di background tanpa read/write blocking penuh pada orders.
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user_id;
```

### Edge Cases 

1. **Validasi Gagal di Tengah Jalan:**
   Jika `VALIDATE CONSTRAINT` gagal karena ternyata ada data lama yang kotor (misal `user_id = 99999` namun ID tersebut tidak ada di tabel `users`), Postgres akan menggugurkan validasi. Namun, Constraint akan tetap nangkring dalam status `NOT VALID`. *Tindakan*: Bersihkan/hapus/betulkan baris bermasalah itu, lalu jalankan `VALIDATE CONSTRAINT` lagi secara manual atau migrasi retry.

2. **FK ke Tabel Tujuan yang Sangat Besar:**
   Walau memvalidasi dari tabel *asal* tidak terlalu mengunci, PostgreSQL di balik layar memicu mekanisme `SELECT FOR SHARE` pada tabel *tujuan* (tabel `users` yang dirujuk) untuk memastikan konsistensi. Jika ada kueri lain yang berniat memodifikasi (`UPDATE`/`DELETE`) struktur atau baris-baris tertentu yang sedang di-*share-lock* pada tabel `users`, kueri mutasi tersebut akan terblokir menanti validasi selesai. *Tindakan*: Eksekusi di jam *low-traffic* jika tabel rujukan dimutasi tinggi secara reguler.

## Kapan JANGAN Pakai Ini

- **Expand-contract untuk perubahan sepele pada tabel kecil.** Tiga siklus deploy untuk menambah kolom pada tabel 500 baris adalah ritual tanpa manfaat. Ongkos prosedurnya harus sebanding dengan risiko yang dihindari.
- **Melewatkan fase contract.** Kolom lama yang tidak pernah dihapus menumpuk menjadi jebakan bagi orang berikutnya — mereka tidak tahu mana yang masih dipakai. Jadwalkan contract-nya sebagai tiket, bukan sebagai niat.
- **Menjalankan DDL tanpa `lock_timeout`.** Satu `ALTER TABLE` yang menunggu lock akan mengantre di belakang satu query panjang, dan **seluruh query baru mengantre di belakangnya**. Tabel terkunci total oleh perintah yang bahkan belum mulai bekerja.
- **Backfill dalam satu pernyataan.** `UPDATE ... SET kolom_baru = ...` pada 50 juta baris menahan lock, membengkakkan WAL, dan membuat replica tertinggal jauh. Potong per batch dengan jeda di antaranya.
- **Mengasumsikan versi aplikasi lama sudah mati.** Selama rolling update, dua versi berjalan bersamaan. Skema WAJIB kompatibel dengan keduanya — itulah alasan expand-contract ada.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `column "x" does not exist` sesaat setelah deploy | urutan deploy vs migrasi | Kode baru berjalan sebelum skema siap |
| Galat hanya pada sebagian pod saat rollout | versi image tiap pod | Skema tidak kompatibel dua arah |
| Replica lag melonjak selama migrasi | volume WAL yang dihasilkan | Backfill besar membanjiri replikasi |
| Seluruh tabel membeku saat `ALTER TABLE` | `pg_blocking_pids` untuk pid DDL | DDL menunggu lock dan memblokir antrean di belakangnya |
| Aplikasi lambat berjam-jam setelah migrasi | statistik tabel | `ANALYZE` belum dijalankan setelah perubahan besar |

```sql
-- WAJIB sebelum DDL apa pun di produksi. Gagal cepat lebih baik daripada
-- memblokir seluruh tabel sambil menunggu.
SET lock_timeout = '3s';
SET statement_timeout = '30s';

-- Siapa yang menghalangi DDL Anda (ganti <pid> dengan pid migrasi)
SELECT pid, now()-query_start AS lama, state, left(query,80)
FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids(<pid>));

-- Volume WAL yang menumpuk selama backfill
SELECT pg_size_pretty(sum(size)) AS ukuran_wal FROM pg_ls_waldir();
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS tertinggal
FROM pg_replication_slots;

-- Statistik yang belum diperbarui setelah perubahan besar
SELECT relname, n_mod_since_analyze, last_analyze, last_autoanalyze
FROM pg_stat_user_tables ORDER BY n_mod_since_analyze DESC LIMIT 10;
```
