# Golang Database Migration: Zero-Downtime, Tooling, & Best Practices

Dokumen ini adalah referensi komprehensif (Top 1%) tentang manajemen migrasi database di Go, mencakup *tooling* modern, strategi zero-downtime, pengujian, dan penanganan edge-case di production environment.

---

## 1. Tooling Ekosistem Migrasi di Go

### a. `golang-migrate/migrate` (File-based Migrations)
`golang-migrate` adalah standar industri untuk file-based migrations. Menggunakan pendekatan up/down `.sql` files, dan sering digabungkan dengan `embed.FS` agar binary Go tetap mandiri.

**Programmatic Execution dengan `embed.FS`:**
```go
package migration

import (
	"database/sql"
	"embed"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed sql/*.sql
var migrationFS embed.FS

func ApplyMigrations(db *sql.DB, dbName string) error {
	sourceDriver, err := iofs.New(migrationFS, "sql")
	if err != nil {
		return fmt.Errorf("failed to create iofs: %w", err)
	}

	dbDriver, err := postgres.WithInstance(db, &postgres.Config{})
	if err != nil {
		return fmt.Errorf("failed to create db instance: %w", err)
	}

	m, err := migrate.NewWithInstance(
		"iofs", sourceDriver, dbName, dbDriver)
	if err != nil {
		return fmt.Errorf("failed to init migrate: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to apply migrations: %w", err)
	}
	return nil
}
```

### b. `ariga/atlas` (Schema-as-Code & CI/CD)
Atlas memperkenalkan konsep Schema-as-Code (Deklaratif) menggunakan HCL atau Go murni. Atlas sangat kuat dalam CI/CD pipeline, terutama command `atlas migrate diff` (auto-generate SQL dari state HCL) dan `atlas migrate lint` (memeriksa destruktif changes / missing constraints).

**Workflow CI:**
1. Developer mendefinisikan schema HCL:
   ```hcl
   table "users" {
     schema = schema.public
     column "id" {
       null = false
       type = bigserial
     }
     column "email" {
       null = false
       type = character_varying(255)
     }
     primary_key {
       columns = [column.id]
     }
   }
   ```
2. Jalankan `atlas migrate diff add_users_table --env dev` → otomatis membuat `.sql` migrasi.
3. CI menjalankan `atlas migrate lint` untuk deteksi anti-patterns (misal: hapus kolom tanpa warning).

### c. `pressly/goose` (Go-based Migrations)
Goose memungkinkan migrasi ditulis dalam pure Go atau SQL. Keunggulannya adalah kontrol transaksional yang eksplisit dengan `goose.RunContext` dan eksekusi custom Go code untuk data transformation kompleks selama migrasi.

```go
package migrations

import (
	"context"
	"database/sql"
	"github.com/pressly/goose/v3"
)

func init() {
	goose.AddMigrationContext(upComplexDataTx, downComplexDataTx)
}

func upComplexDataTx(ctx context.Context, tx *sql.Tx) error {
	// Custom complex backfill logic menggunakan Go yang tidak bisa dengan mudah
	// dilakukan murni dengan SQL.
	_, err := tx.ExecContext(ctx, "UPDATE users SET status = 'active' WHERE status IS NULL")
	return err
}

func downComplexDataTx(ctx context.Context, tx *sql.Tx) error {
	return nil
}
```

---

## 2. Zero-Downtime Migration Strategies

Melakukan migrasi tanpa downtime memerlukan *backward* dan *forward compatibility* dengan kode aplikasi yang sedang berjalan.

### a. Expand-Contract Pattern
Pola ini digunakan saat ingin mengubah struktur tabel (misal memisahkan kolom, atau rename) secara aman dalam beberapa tahap deployment.

**Diagram ASCII: Expand-Contract Lifecycle**
```text
           [Database]                  [Application]
State 1: | name        | <--------> V1 (reads/writes 'name')
         
           --- Expand ---
State 2: | name | first | <-------- V2 (reads 'name', writes to BOTH 'name' & 'first')
           (backfill first)

           --- Transition ---
State 3: | name | first | <-------- V3 (reads/writes ONLY 'first')

           --- Contract ---
State 4: | first        | <-------- V3 (runs safely)
           (drop 'name')
```
*Langkah:*
1. **Expand**: Tambah kolom baru (`first_name`), deploy app yang write ke kedua kolom.
2. **Migrate/Backfill**: Jalankan background worker untuk sinkronisasi data lama.
3. **Transition**: Deploy app yang hanya read/write kolom baru.
4. **Contract**: Hapus kolom lama.

### b. Non-Blocking Index Creation
Secara default `CREATE INDEX` mengunci table untuk write. Di PostgreSQL, gunakan `CONCURRENTLY`.
```sql
-- DOWNTIME (Table locked for writes)
CREATE INDEX idx_users_email ON users(email);

-- ZERO DOWNTIME
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```
*Catatan:* `CREATE INDEX CONCURRENTLY` tidak bisa di dalam blok `BEGIN ... COMMIT` (transaction). Migrasi tool harus mendukung eksekusi non-transaksional untuk step ini (misal di Goose: tambahkan `-- +goose NO TRANSACTION`).

### c. Rename Column via View Trick
Merename kolom secara langsung akan menyebabkan downtime karena aplikasi lama masih mengakses nama kolom lama.
1. Rename tabel asli (`users` -> `users_table`).
2. Buat View `users` yang map nama kolom lama ke baru.
3. Update App.
4. Drop View dan restore nama table saat sudah aman.

### d. Foreign Key Deferrable
Saat membuat relasi FK yang kompleks secara melingkar, gunakan `DEFERRABLE INITIALLY DEFERRED` sehingga constraint check dilakukan di akhir transaksi, bukan setiap baris.

---

## 3. Migration di K8s Ecosystem

Bagaimana dan kapan migrasi harus berjalan di Kubernetes? Ada beberapa pattern:

**Diagram ASCII: K8s Migration Flow via Init Container**
```text
+------------------------- Pod --------------------------+
|                                                        |
|  [Init Container: Migration]                           |
|      |-> Fetch secrets                                 |
|      |-> Run golang-migrate (up)                       |
|      |-> Exit 0 (Success)                              |
|           |                                            |
|           v (triggers)                                 |
|  [Main Container: Go App]                              |
|      |-> Start HTTP server                             |
|      |-> Ready probe active                            |
+--------------------------------------------------------+
```

1. **Init Container**: Direkomendasikan. Aplikasi Go utama tidak akan start sebelum Init Container selesai eksekusi migrasi. Pastikan aplikasi bersifat *backward-compatible* dengan schema lama/baru.
2. **Kubernetes Job (Helm hook)**: Pre-install / Pre-upgrade hook. Cocok jika migrasi sangat berat dan butuh resource spesifik terpisah dari Pod aplikasi.
3. **Application Startup**: (Kurang disarankan) Menjalankan `migrate.Up()` di `main.go`. *Risk*: Jika ada 10 Pod replica start bersamaan, bisa terjadi race condition (lock contention pada tabel `schema_migrations`).

---

## 4. Rollback Strategy & Checkpoints

Rollback tidak selalu aman karena data bisa hilang (destructive down).
- **Forward-Only Migrations**: Beberapa tim menghindari `.down.sql` dan memilih membuat migrasi baru untuk *fix forward*.
- **Down Migration Design**: Jika pakai down, JANGAN destructive. Daripada `DROP TABLE`, ubah nama menjadi `_dropped_table_X`.
- **Checkpoints**: Lakukan backup snapshot (RDS snapshot / pg_dump) sebelum migrasi rilis besar (major release).

---

## 5. Anti-Patterns (❌ BAD vs ✅ GOOD)

### Anti-Pattern 1: Rename Column Langsung (Downtime)
❌ **BAD:**
```sql
-- V2_rename_column.sql
ALTER TABLE users RENAME COLUMN fname TO first_name;
-- Aplikasi V1 yang masih jalan akan error "column fname does not exist"
```
✅ **GOOD:**
```sql
-- Gunakan Expand-Contract
-- V2_expand.sql
ALTER TABLE users ADD COLUMN first_name VARCHAR(255);
-- Lalu backfill data di background
```

### Anti-Pattern 2: Migrasi Tanpa Transaksi (Partial Apply)
❌ **BAD:**
Membuat banyak statement DDL dalam satu file tanpa perlindungan blok transaksi. Jika error di baris ke-5, baris 1-4 sudah teraplikasi dan sulit me-revert state (Dirty Database).
✅ **GOOD:**
Pastikan tools membungkus file dalam `BEGIN; ... COMMIT;` (default pada tool modern seperti migrate/goose). Untuk `CONCURRENTLY`, pisahkan ke file khusus dengan flag non-transaksional eksplisit agar jelas.

---

## 6. Edge Cases & Penanganan

1. **Large Table Backfill**: Mengupdate jutaan row dengan `UPDATE users SET x=y` akan menyebabkan table lock dan bloat. *Solusi*: Lakukan chunking/batching (e.g. `WHERE id BETWEEN 1 AND 1000`) dengan sleep kecil di aplikasi Go atau via pg_cron.
2. **Failed Migration Detection (Dirty State)**: Jika DB crash tengah migrasi, `golang-migrate` menandai db "dirty". *Solusi*: Tim operasi harus memverifikasi state, perbaiki DB manual, lalu jalankan `migrate force <version>`.
3. **Multi-tenant Schema Migration**: Untuk arsitektur DB-per-tenant atau Schema-per-tenant. *Solusi*: Buat orchestrator Go rutin yang me-loop daftar schema (`SET search_path TO tenant_x`) lalu menjalankan instance migrasi.
4. **Statement Timeout**: Migrasi yang terlalu lama bisa diputus oleh DB. *Solusi*: Set `statement_timeout` lokal per koneksi sesi migrasi.
5. **Replication Lag**: Setelah migrasi berjalan, read-replica mungkin butuh waktu sinkronisasi. App yang langsung baca dari replica bisa error. *Solusi*: Implementasi smart routing di Go, atau tunggu lag menipis sebelum traffic dialihkan.

---

## 7. Migration Testing (Testcontainers)

Menulis test nyata menggunakan Docker container `testcontainers-go` untuk memastikan file SQL up & down valid.

```go
package migration_test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Contoh embed filesystem
//go:embed sql/*.sql
var migrationFS embed.FS

func setupTestDB(t *testing.T) (*sql.DB, func()) {
	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		Image:        "postgres:15-alpine",
		ExposedPorts: []string{"5432/tcp"},
		Env: map[string]string{
			"POSTGRES_USER":     "user",
			"POSTGRES_PASSWORD": "password",
			"POSTGRES_DB":       "testdb",
		},
		WaitingFor: wait.ForLog("database system is ready to accept connections").WithOccurrence(2),
	}
	
	postgresC, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	require.NoError(t, err)

	host, _ := postgresC.Host(ctx)
	port, _ := postgresC.MappedPort(ctx, "5432")
	dsn := "postgres://user:password@" + host + ":" + port.Port() + "/testdb?sslmode=disable"
	
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)

	cleanup := func() {
		db.Close()
		postgresC.Terminate(ctx)
	}
	return db, cleanup
}

func TestMigrationApplyAndRollback(t *testing.T) {
	db, cleanup := setupTestDB(t)
	defer cleanup()

	// 1. Setup Migrate
	sourceDriver, err := iofs.New(migrationFS, "sql")
	require.NoError(t, err)
	dbDriver, err := postgres.WithInstance(db, &postgres.Config{})
	require.NoError(t, err)
	
	m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", dbDriver)
	require.NoError(t, err)

	// 2. Test UP
	err = m.Up()
	assert.NoError(t, err, "Up migration should not error")

	// Verify table exists
	_, err = db.Exec("SELECT 1 FROM users LIMIT 1")
	assert.NoError(t, err, "Table users should exist after Up")

	// 3. Test DOWN (Rollback 1 step)
	err = m.Steps(-1)
	assert.NoError(t, err, "Down migration should not error")

	// Verify table dropped/missing
	_, err = db.Exec("SELECT 1 FROM users LIMIT 1")
	assert.Error(t, err, "Table users should be dropped after Down")
}

## Edge Case Ekstra: Multi-Tenant dengan Schema-per-Tenant
Pada arsitektur SaaS yang menggunakan *Schema-per-tenant*, Anda punya satu database fisik namun ratusan schema logical (`tenant_a`, `tenant_b`, dst).
Migrasi tidak bisa dijalankan hanya di `public`. Anda harus membuat *Orchestrator* Go yang menarik daftar tenant, dan menjalankan instance `migrate` di dalam goroutines loop, merubah prefix table (via `search_path`) untuk setiap tenant, dan melakukan agregasi error jika ada tenant yang gagal (partial failure).
```go
func MigrateAllTenants(db *sql.DB, tenants []string) error {
    var errs []error
    for _, t := range tenants {
        // ... set search path dan inisiasi migrator
        if err := m.Up(); err != nil && err != migrate.ErrNoChange {
            errs = append(errs, fmt.Errorf("tenant %s: %w", t, err))
        }
    }
    return errors.Join(errs...)
}
```
```
