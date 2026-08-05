# Connection Pool Tuning & Management di Go dengan pgx/v5

> **Berlaku:** Go 1.21+ · pgx/v5 (`pgxpool`) · **Lihat juga:** `db_sqlc/acid_transactions_isolation.md` · `db_sqlc/read_replica_routing.md` · `db_sqlc/sharding_partitioning.md` · `concurrency/worker_pool_errgroup.md`

## Konsep dan Internals

Dalam bahasa ber-konkurensi tinggi seperti Go, membuat sebuah *goroutine* sangatlah murah (hanya membutuhkan sekitar ~2KB memori). Di sisi lain, setiap koneksi jaringan ke **PostgreSQL** sangatlah mahal. PostgreSQL beroperasi dengan model *process-per-connection*; setiap koneksi dari aplikasi Anda akan memicu (*fork*) sebuah proses *backend* OS baru di server PostgreSQL, yang memakan setidaknya 5-10MB RAM serta resource CPU untuk manajemen *context switching*.

Tanpa **Connection Pooling** yang ketat, ribuan goroutine dapat menghantam PostgreSQL secara bersamaan (*thundering herd*), menyebabkan *OOM (Out-of-Memory)* atau *FATAL: too many connections*. 

Paket `github.com/jackc/pgx/v5/pgxpool` menawarkan kontrol pool tingkat produksi yang melampaui `database/sql` bawaan Go. `pgxpool` dapat mengelola siklus hidup koneksi, menjalankan *health check* secara transparan, menangani batas maksimal masa pakai (untuk melewati *load balancer* atau *firewall state timeout*), serta menyelaraskan pembuatan statement (*prepared statement caching*).

### Mengapa Tuning Penting?
- **MaxConns (Batas Atas)**: Menghindari database dari kelebihan beban (overload). Jika diset terlalu rendah, aplikasi Anda akan kelaparan (menunggu lama mendapatkan koneksi).
- **MinConns (Batas Bawah)**: Menjaga sejumlah koneksi tetap "hangat" (*warm*). Sangat krusial agar aplikasi siap merespons lonjakan lalu lintas (*traffic spike*) dadakan tanpa penalti latensi pembuatan koneksi TCP/TLS baru.
- **MaxConnLifetime dengan Jitter**: Secara berkala memutus koneksi lama untuk melepaskan resource di server DB, dan *Jitter* mencegah semua koneksi di pool kedaluwarsa secara bersamaan di detik yang persis sama.

---

## Diagram ASCII: Siklus Hidup dan Pool Exhaustion

```text
========================================================================================
| Skenario: Goroutine Mengantre Saat Connection Pool Penuh (Exhaustion)                |
========================================================================================

   [HTTP Requests Masuk: 100 req/sec]
           |
           v
+-----------------------+       +---------------------------------------------+
|   Go Web Server       |       |                 pgxpool                     |
| (100 Active Goroutines|------>| [Conn 1 (In Use)] [Conn 2 (In Use)]         |
+-----------------------+       | [Conn 3 (In Use)] [Conn 4 (In Use)]         |
           |                    |             ... MaxConns = 10 ...           |
           |                    | [Conn 10 (In Use)]                          |
           |                    +---------------------------------------------+
           |                                          |
           | (Menunggu...)                            | (PostgreSQL memproses query)
           v                                          v
    [Blocked Queue]                            +----------------+
    - Goroutine 11                             | PostgreSQL DB  |
    - Goroutine 12                             | (Max 10 Procs) |
    - ...                                      +----------------+
    - Goroutine 100                            
  (Menunggu Conn Idle)                         
           |
           +--> JIKA timeout (context deadline) terlampaui:
                Kembalikan HTTP 500 "context deadline exceeded" 
                ke sisi Klien sebelum query terkirim!
========================================================================================
```

---

## Kode Go Production-Ready

Di bawah ini adalah implementasi standar inisialisasi pool yang aman dan dilengkapi metrik untuk *observability*.

```go
package database

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Config merangkum pengaturan spesifik untuk Database Connection.
type Config struct {
	DSN          string
	MaxConns     int32
	MinConns     int32
	MaxLifetime  time.Duration
	MaxIdleTime  time.Duration
	HealthPeriod time.Duration
}

// DefaultPoolConfig memberikan estimasi baseline yang baik untuk layanan API menengah.
func DefaultPoolConfig(dsn string) Config {
	return Config{
		DSN:          dsn,
		MaxConns:     40, // Rumus umum: ((Core CPU DB * 2) + Kapasitas Disk Spindle) / Total Pods Aplikasi
		MinConns:     10,
		MaxLifetime:  1 * time.Hour,
		MaxIdleTime:  30 * time.Minute,
		HealthPeriod: 1 * time.Minute,
	}
}

// ConnectPool melakukan parsing DSN, menerapkan tuning lanjutan, dan memverifikasi koneksi.
func ConnectPool(ctx context.Context, cfg Config, logger *slog.Logger) (*pgxpool.Pool, error) {
	// Parse URL Database terlebih dahulu
	poolConfig, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database DSN: %w", err)
	}

	// Terapkan pengaturan Pool
	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	
	// MaxConnLifetime memaksa koneksi ditutup setelah durasi ini.
	// Sangat penting jika memakai Load Balancer (seperti AWS RDS Proxy / HAProxy).
	poolConfig.MaxConnLifetime = cfg.MaxLifetime
	
	// Tambahkan Jitter (sekitar 10%) untuk menyebarkan (spread) waktu recycle koneksi,
	// menghindari thundering herd di mana puluhan koneksi terputus dan dibuka bersamaan.
	poolConfig.MaxConnLifetimeJitter = time.Duration(float64(cfg.MaxLifetime) * 0.1)
	
	poolConfig.MaxConnIdleTime = cfg.MaxIdleTime
	poolConfig.HealthCheckPeriod = cfg.HealthPeriod

	// (Opsional) Jika di depan PG ada PgBouncer di mode Transaction, matikan prepared statements:
	// poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec

	logger.InfoContext(ctx, "initializing database connection pool",
		slog.Int("max_conns", int(poolConfig.MaxConns)),
		slog.Int("min_conns", int(poolConfig.MinConns)))

	// Inisialisasi pool (akan otomatis membuka koneksi awal sebesar MinConns secara asinkron)
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize connection pool: %w", err)
	}

	// Validasi bahwa database dapat dihubungi secara nyata
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	
	if err := pool.Ping(pingCtx); err != nil {
		// Tutup pool secara bersih jika ping gagal agar tidak ada resource bocor
		pool.Close()
		return nil, fmt.Errorf("database ping failed: %w", err)
	}

	return pool, nil
}

// MonitorPool berjalan di background (goroutine) dan mempublikasikan metrik kesehatan pool
// secara berkala ke logger atau sistem agregasi metrik (mis. Prometheus).
func MonitorPool(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.InfoContext(ctx, "stopping database pool monitor")
			return
		case <-ticker.C:
			stats := pool.Stat()
			
			// Jika EmptyAcquireCount merangkak naik sangat cepat, aplikasi kekurangan koneksi.
			logger.InfoContext(ctx, "db pool metrics",
				slog.Int("total_conns", int(stats.TotalConns())),
				slog.Int("idle_conns", int(stats.IdleConns())),
				slog.Int("acquired_conns", int(stats.AcquiredConns())),
				slog.Int64("empty_acquire_count", stats.EmptyAcquireCount()), // Jumlah request yang terpaksa menunggu koneksi idle
				slog.Int64("canceled_acquire_count", stats.CanceledAcquireCount()), // Request yang batal (timeout) selagi antre
			)
		}
	}
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Lupa Memanggil `rows.Close()` pada Eksekusi Query 
Ini adalah sumber paling umum dari fenomena *Connection Leak*. Ketika menggunakan `.Query()`, koneksi tidak akan dikembalikan ke pool hingga seluruh *rows* selesai diiterasi atau `.Close()` dipanggil.

```go
// ❌ BAD: Jika terjadi error saat memproses rows.Next(), loop berhenti dan koneksi ditahan SELAMANYA.
rows, _ := pool.Query(ctx, "SELECT id, name FROM users")
for rows.Next() {
	var id int
	if err := rows.Scan(&id); err != nil {
		return err // BAHAYA: koneksi tertahan In-Use dan tidak pernah dikembalikan ke pool!
	}
}
```

```go
// ✅ GOOD: Selalu manfaatkan defer rows.Close() langsung di bawah inisialisasi query.
rows, err := pool.Query(ctx, "SELECT id, name FROM users")
if err != nil {
	return err
}
defer rows.Close() // Memastikan koneksi dikembalikan, meskipun function mengembalikan error (early return)

for rows.Next() {
	var id int
	if err := rows.Scan(&id); err != nil {
		return err // Koneksi aman tertutup dan dikembalikan oleh defer
	}
}
```
**Why dangerous:** Koneksi yang tidak ditutup menyebabkan `pgxpool` mengira koneksi tersebut masih sibuk (`In-Use`). Kapasitas pool berkurang 1. Setelah kejadian ini berulang sebanyak nilai `MaxConns`, setiap query baru akan *hang* mengantre hingga waktu `context` habis (*timeout*). Seluruh endpoint yang bergantung pada database akan lumpuh secara seketika (*Outage*).

### ❌ Anti-Pattern 2: `MaxConns` Terlalu Tinggi atau Menggunakan Nilai Default Tanpa Batas
Banyak developer beranggapan menyetel `MaxConns = 10000` akan membuat aplikasi "lebih cepat melayani banyak user".

```go
// ❌ BAD: Pool size sangat besar melebihi kapasitas server Postgres.
config.MaxConns = 1000 
```

```go
// ✅ GOOD: Sesuaikan dengan CPU DB dan jumlah pod Kubernetes Anda.
// Misal, DB m5.large (2 vCPU) -> Optimal conns = (2 * 4) = 8 conns aktif per DB.
config.MaxConns = 15
```
**Why dangerous:** Jika Postgres dikonfigurasi dengan limit koneksi standar (`max_connections=100`), dan tiga replika aplikasi (Pods) Anda mencoba membuka 100 koneksi bersamaan (total 300), Postgres akan memblokirnya dengan `FATAL: sorry, too many clients already`. Koneksi adalah antrean yang harus dikelola oleh aplikasi (*client-side queuing* via pool), bukan ditekan mentah-mentah ke server database.

---

## Edge Cases & Defensive Programming

1. **Memantau `EmptyAcquireCount` dan `CanceledAcquireCount`**
   Metrik ini sangat krusial. Jika Anda melihat `EmptyAcquireCount` meningkat pesat setiap jam sibuk, itu artinya goroutine aplikasi terpaksa menunggu koneksi. Namun, jika `CanceledAcquireCount` yang meningkat (sementara DB utilisasi CPU rendah), berarti ukuran pool (`MaxConns`) Anda terlampau kecil untuk menampung *traffic burst* (goroutine keburu *timeout* selagi mengantre dalam memori).
   
2. **PostgreSQL Failover & Health Check (Network Partition)**
   Jika instance PostgreSQL utama Anda mengalami *failover* (mati dan digantikan *replica* stand-by), semua TCP session lama di OS Anda menjadi invalid secara sepihak. `pgxpool` tangguh dalam hal ini jika `HealthCheckPeriod` Anda di-set dengan baik (contoh: 30 detik). *Background worker* `pgx` akan mendeteksi `broken pipe` dan membersihkan pool *sebelum* permintaan aktual dari pengguna masuk dan gagal secara kasat mata.

3. **Inkompatibilitas PgBouncer pada Transaction Pooling**
   Jika infrastruktur Anda memasang **PgBouncer** (sebuah connection pooler populer) di depan PostgreSQL dalam mode `Transaction`, Anda akan mendapat error aneh secara sporadis seperti `prepared statement "stmt_1" does not exist`. 
   Solusinya adalah mematikan prepared statement lokal di `pgxpool`. Tambahkan parameter `default_query_exec_mode=exec` di dalam DSN (`postgres://.../?default_query_exec_mode=exec`). Ini memaksa `pgx` langsung mengirim SQL mentah alih-alih me-register *prepare statement* yang state-nya diacak oleh Pgbouncer.

4. **Context Deadline Exceeded vs Context Canceled pada Acquire**
   Gunakan Context HTTP request yang berisi batas waktu (timeout) selalu. Saat server berada di bawah beban luar biasa (antrean pool penuh), HTTP request dari klien seringkali diputus klien karena lelah menunggu. Context *cancelation* menyebar (propagate) ke goroutine yang menunggu koneksi di *Pool*. `pgx` dengan efisien merespons sinyal batal ini dengan mendepak goroutine dari antrean pool (*Dequeue*), membebaskan slot antrean, dan tidak repot-repot memproses query yang hasilnya sudah tidak dihiraukan.

---

## Unit Tests

Unit testing terkait pool berpusat pada penjaminan bahwa konfigurasi (DSN dan overrides) diproses (parse) secara akurat sesuai harapan lingkungan produksi, sehingga mencegah nilai *default* merusak stabilitas produksi.

```go
package database_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"yourproject/internal/database" // sesuaikan path import
)

func TestDefaultPoolConfig(t *testing.T) {
	dsn := "postgres://usr:pwd@localhost:5432/myapp?sslmode=disable"
	cfg := database.DefaultPoolConfig(dsn)

	if cfg.MaxConns <= 0 {
		t.Errorf("expected positive MaxConns, got %d", cfg.MaxConns)
	}
	if cfg.MinConns > cfg.MaxConns {
		t.Errorf("MinConns (%d) cannot be greater than MaxConns (%d)", cfg.MinConns, cfg.MaxConns)
	}
}

func TestPoolConfigParsingWithOverrides(t *testing.T) {
	// DSN dapat secara bawaan mendikte ukuran pool. 
	// Pastikan parse config dan kode Go kita menangani prioritas secara benar.
	dsn := "postgres://user:pass@localhost:5432/db?pool_max_conns=12&pool_max_conn_lifetime=2h"
	
	parsedConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("failed to parse valid DSN: %v", err)
	}

	// Validasi bahwa query params DSN (pool_max_conns) diterapkan oleh engine pgx
	if parsedConfig.MaxConns != 12 {
		t.Errorf("expected MaxConns to be parsed as 12 from DSN, got %d", parsedConfig.MaxConns)
	}

	if parsedConfig.MaxConnLifetime != 2*time.Hour {
		t.Errorf("expected MaxConnLifetime to be 2h from DSN, got %v", parsedConfig.MaxConnLifetime)
	}

	// Simulasi timpa (override) dalam kode Go
	overrideMaxConns := int32(50)
	parsedConfig.MaxConns = overrideMaxConns

	if parsedConfig.MaxConns != 50 {
		t.Errorf("expected MaxConns to be overridden to 50, got %d", parsedConfig.MaxConns)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Memperbesar `MaxConns` sebagai obat latensi.** PostgreSQL punya titik jenuh; melewatinya throughput justru **turun** karena kontensi lock internal dan context switch. Antrean lebih murah di aplikasi daripada di dalam database.
- **Menyetel pool per pod tanpa menghitung totalnya.** Batas sebenarnya adalah `jumlah_pod × MaxConns ≤ max_connections − cadangan superuser − alat lain (migrasi, metrik, admin)`. Autoscaling yang menaikkan pod juga menaikkan koneksi.
- **Pool aplikasi besar di belakang PgBouncer mode transaksi.** Poolnya sudah ada di PgBouncer; pool aplikasi yang besar hanya menambah satu lapisan antrean tanpa menambah kapasitas.
- **`MinConns` tinggi pada layanan bertrafik jarang.** Koneksi idle tetap memakan memori di sisi server dan tetap harus di-health-check. Untuk cron atau layanan internal, `MinConns` kecil lebih tepat.
- **Pool sebagai pengganti perbaikan query.** Query 2 detik dengan pool 100 hanya berarti 100 query lambat berjalan bersamaan. Perbaiki query-nya lebih dulu — lihat `db_sqlc/index_design_explain_analyze.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi permintaan naik, waktu query tetap cepat | `AcquireDuration` vs waktu query | Antre menunggu koneksi, bukan menunggu database |
| `FATAL: sorry, too many clients already` | pod × MaxConns vs `max_connections` | Total pool melewati batas server |
| `prepared statement "..." does not exist` sporadis | mode PgBouncer | Transaction pooling mengacak state prepared statement |
| Memori server PostgreSQL tinggi dengan sedikit query aktif | jumlah koneksi idle | Terlalu banyak koneksi menganggur |
| Lonjakan galat tepat saat autoscaling | jumlah pod saat insiden | Penambahan pod melewati batas koneksi |

```go
// Tanpa metrik ini, penyetelan pool hanya tebakan. Ekspor sebagai gauge.
s := pool.Stat()
_ = s.AcquireCount()          // total permintaan koneksi
_ = s.AcquireDuration()       // akumulasi waktu tunggu -- yang paling penting
_ = s.EmptyAcquireCount()     // berapa kali harus menunggu karena pool kosong
_ = s.CanceledAcquireCount()  // pemanggil menyerah sebelum dapat koneksi
_ = s.TotalConns()
_ = s.IdleConns()
_ = s.MaxConns()
```

```sql
-- Berapa yang terpakai vs berapa batasnya
SELECT (SELECT count(*) FROM pg_stat_activity) AS terpakai,
       (SELECT setting::int FROM pg_settings WHERE name='max_connections') AS batas,
       (SELECT setting::int FROM pg_settings WHERE name='superuser_reserved_connections') AS cadangan;

-- Siapa yang memakai koneksi: sering ternyata bukan aplikasi utama
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY count DESC LIMIT 20;
```

```bash
kubectl logs -l app=api --since=1h | grep -c 'too many clients'

# Bila memakai PgBouncer: cl_waiting > 0 berarti klien mengantre
psql -p 6432 pgbouncer -c 'SHOW POOLS;'
psql -p 6432 pgbouncer -c 'SHOW STATS;'
```
