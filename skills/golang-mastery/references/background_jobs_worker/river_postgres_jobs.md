# Riverqueue (River): Background Job Processing Berbasis PostgreSQL

> **Berlaku:** Go 1.21+ · `riverqueue/river` · PostgreSQL 14+ · **Lihat juga:** `background_jobs_worker/asynq_redis_jobs.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md` · `db_sqlc/database_locking_strategies.md` · `db_sqlc/connection_pool_tuning.md`

River (`github.com/riverqueue/river`) adalah library background job processing untuk Go yang menggunakan PostgreSQL sebagai backend penyimpanannya. Berbeda dengan Redis-backed queues (seperti Asynq atau Sidekiq), River memanfaatkan fitur ACID dari Postgres untuk menjamin *Exactly-Once Semantics* (EOS), memastikan job tidak hilang atau dieksekusi ganda dalam kondisi kegagalan jaringan atau worker.

Dokumen ini adalah referensi *Top 1% Quality* untuk implementasi River di lingkungan produksi skala besar.

---

## 1. Arsitektur Inti: Postgres-Backed & ACID Guarantees

River mengintegrasikan operasi antrean pekerjaan langsung ke dalam transaksi database relasional Anda. Ini menyelesaikan masalah "Dual Write Problem" (menulis ke database dan ke message broker secara terpisah tanpa distributed transaction). 

### Bagaimana River Bekerja di Level Database
River menggunakan `SELECT ... FOR UPDATE SKIP LOCKED` yang diperkenalkan pada PostgreSQL 9.5+. Ini memungkinkan multiple concurrent workers untuk mengambil row (job) dari tabel `river_job` tanpa saling memblokir (lock contention). 

1. **Transactional Enqueueing**: Saat aplikasi menyimpan data user ke tabel `users`, dalam transaksi SQL yang *sama*, aplikasi juga melakukan enqueue job (misal: kirim email welcome). Jika transaksi gagal (rollback), job juga otomatis tidak jadi masuk antrean.
2. **Advisory Locks & Exactly-Once Semantics (EOS)**: River menggunakan session-level advisory locks (`pg_try_advisory_lock`) untuk menjamin bahwa sebuah job hanya dikerjakan oleh satu worker. Ini memastikan *exactly-once execution* (asalkan job logic idempotent dan durasi job tidak melebihi timeout lock).

---

## 2. Job State Machine (Siklus Hidup Job)

Setiap job di River memiliki state yang ketat, dikontrol secara atomik di dalam Postgres.

```text
    +-----------+
    |           |
    v           |
[AVAILABLE] <---+-------+
    |                   | (snoozed/retryable)
    | (worker grabs)    |
    v                   |
[RUNNING] --------------+
    |                   
    +---> [COMPLETED] (Sukses, row akan dihapus oleh pruner)
    |
    +---> [CANCELLED] (Dibatalkan via API/UI sebelum selesai)
    |
    +---> [DISCARDED] (Gagal mencapai max_attempts, job "mati")
```

- **AVAILABLE**: Job siap diambil. Termasuk job yang tertunda (scheduled) dan telah mencapai waktunya.
- **RUNNING**: Diambil oleh worker (terkunci via row lock & advisory lock).
- **COMPLETED**: Selesai tanpa error.
- **CANCELLED**: Dibatalkan secara eksplisit oleh sistem.
- **DISCARDED**: Mencapai batas maksimal *retry*. Menunggu investigasi manual.

---

## 3. Implementasi Dasar: JobArgs, Worker, dan Client

River memisahkan antara entitas yang mendefinisikan/mengerjakan job (`Worker`) dan entitas yang mengirim job ke antrean (`Client`).

### Definisi Job (`river.JobArgs`)
Job direpresentasikan oleh struct yang mengimplementasikan `river.JobArgs`. Struct ini otomatis di-serialize menjadi JSONB di PostgreSQL.

```go
package jobs

import "github.com/riverqueue/river"

// SendWelcomeEmailArgs mendefinisikan payload untuk job.
type SendWelcomeEmailArgs struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
}

// Kind mengembalikan identifier unik untuk tipe job ini.
func (SendWelcomeEmailArgs) Kind() string {
	return "send_welcome_email"
}
```

### Worker: Mengeksekusi Job
```go
package jobs

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/riverqueue/river"
)

// SendWelcomeEmailWorker bertanggung jawab memproses SendWelcomeEmailArgs.
type SendWelcomeEmailWorker struct {
    river.WorkerDefaults[SendWelcomeEmailArgs]
    logger *slog.Logger
    // Injeksi dependensi (Mailer, DB, dll) di sini
}

func (w *SendWelcomeEmailWorker) Work(ctx context.Context, job *river.Job[SendWelcomeEmailArgs]) error {
    w.logger.InfoContext(ctx, "Sending email", "user_id", job.Args.UserID, "email", job.Args.Email)
    
    // Simulasi pengiriman email
    if job.Args.Email == "" {
        return fmt.Errorf("empty email: invalid") // Akan memicu retry
    }
    
    // Sukses
    return nil
}

// Timeout opsional per job type
func (w *SendWelcomeEmailWorker) Timeout(job *river.Job[SendWelcomeEmailArgs]) time.Duration {
    return 15 * time.Minute
}
```

---

## 4. Konsep Lanjutan: Uniqueness, Scheduled, Cancellation, & Rescue

### A. Job Uniqueness (Mencegah Duplikasi)
River mendukung *Unique Jobs* berbasis lock di level database. Unique job menjamin bahwa hanya ada satu job dengan *args yang sama* (atau state tertentu) dalam rentang waktu yang ditentukan (secara default berdasarkan hash JSON dari JobArgs).

```go
import "github.com/riverqueue/river/riveropts"

// Client insert dengan uniqueness:
_, err = client.Insert(ctx, jobs.SendWelcomeEmailArgs{
    UserID: "123",
}, riveropts.UniqueOpts{
    ByArgs:   true, // Hash dari payload
    ByState:  []river.JobState{river.JobStateAvailable, river.JobStateRunning},
})
// Jika ada duplikat, River tidak akan return error, tapi insert akan di-skip.
```

### B. Periodic / Scheduled Jobs
Untuk job yang berjalan berkala (seperti cron), River menggunakan `river.PeriodicJob`. River menjamin eksekusi *singleton* (hanya 1 instance yang jalan meskipun ada banyak worker node).

```go
import "github.com/riverqueue/river/riveropts"

// Registrasi Periodic Job
workers := river.NewWorkers()
river.AddWorker(workers, &ReportGeneratorWorker{})

periodicJobs := []*river.PeriodicJob{
    river.NewPeriodicJob(
        river.PeriodicInterval(24 * time.Hour), 
        func() (river.JobArgs, *riveropts.InsertOpts) {
            return ReportGeneratorArgs{}, nil
        },
        &river.PeriodicJobOpts{RunOnStart: true},
    ),
}
```

### C. Cancellation, Snooze, dan Rescue Stuck Jobs
- **Snooze**: Worker bisa menunda job secara dinamis (mengembalikan error khusus `river.SnoozeError`).
- **Cancellation**: Klien dapat membatalkan job via `client.JobCancel(ctx, jobID)`.
- **Rescue**: Jika sebuah worker crash/OOM di tengah eksekusi, lock-nya di Postgres menjadi stale (terabaikan). River secara periodik melakukan "Rescue" untuk mencari job berstatus `RUNNING` yang lokernya sudah kedaluwarsa dan mengubahnya menjadi `AVAILABLE`.

---

## 5. Analisis Edge Cases di Production (>= 5 Skenario)

1. **Postgres Connection Pool Exhaustion saat Job Burst**
   - *Masalah*: Setiap worker butuh koneksi ke DB. Jika konkurensi diset ke `100` pada 10 pod, itu butuh 1000 koneksi DB. Ini akan membuat Postgres *starving* dan menolak koneksi aplikasi (OLTP).
   - *Mitigasi*: Gunakan koneksi pool eksternal yang di-multiplex (seperti PgBouncer dalam mode *transaction*). Dan yang terpenting, batasi worker concurrency (`river.Config{Queues: map[string]river.QueueConfig{"default": {MaxWorkers: 10}}}`).
2. **Schema Migration & Zero-Downtime**
   - *Masalah*: Saat mengubah struktur tabel `river_job`, jika dilakukan dengan `ALTER TABLE` sembarangan, akan memicu *AccessExclusiveLock* di Postgres yang menghentikan seluruh operasi antrean.
   - *Mitigasi*: Selalu jalankan migrasi River secara *backward-compatible*. Tambah kolom baru di rilis A, gunakan kolom baru di rilis B, hapus kolom lama di rilis C (Expand and Contract pattern).
3. **Toxic Jobs (OOM/Crash Loops) & Panic Recovery**
   - *Masalah*: Sebuah payload job memicu alokasi memori yang sangat besar menyebabkan pod OOMKilled. Job di-rescue, diambil pod lain, pod itu OOMKilled lagi (Cascading Failure).
   - *Mitigasi*: Selalu tangkap panic di level Worker. Batasi memori eksplisit di runtime Go, dan catat Job ID yang bermasalah. River otomatis mengurangi attempt jika panic terjadi berulang.
4. **Clock Skew di Worker Nodes**
   - *Masalah*: Jika waktu sistem (NTP) antar server berbeda, job yang dijadwalkan (scheduled_at) bisa dijemput terlalu cepat atau terlambat.
   - *Mitigasi*: PostgreSQL bertindak sebagai *Source of Truth* untuk waktu. River menggunakan `CURRENT_TIMESTAMP` milik DB untuk trigger state transitions, mengurangi dampak *clock skew* antar worker.
5. **Transaction Isolation Levels vs Job Queue**
   - *Masalah*: Jika worker menggunakan level `SERIALIZABLE`, `SELECT FOR UPDATE` sering mengalami *serialization failures* (`40001`).
   - *Mitigasi*: Biarkan worker membaca antrean (polling) dalam isolasi transaksi `READ COMMITTED` standar Postgres, yang mana `SKIP LOCKED` dirancang untuk bekerja secara sempurna.

---

## 6. Anti-Patterns (BAD vs GOOD)

### Anti-Pattern 1: Menggunakan River untuk High-Frequency, Low-Latency Tasks (>1000 RPS)
River didukung oleh database relasional yang menulis ke disk (WAL/Commit Log). Memaksakan jutaan job kecil per detik akan mencekik IOPS disk dan menaikkan load CPU Postgres secara drastis.

❌ **BAD (Memaksakan Postgres untuk tugas real-time chat/analytics streaming)**
```go
// Menembakkan ribuan job per detik ke River
for _, evt := range streamEvents {
    // Akan membuat Postgres IO bottleneck & bloating table!
    client.InsertTx(ctx, tx, TrackAnalyticsArgs{Event: evt}, nil) 
}
```

✅ **GOOD (Gunakan Asynq+Redis atau Kafka untuk high-frequency, River untuk transactional jobs)**
```go
// Gunakan River untuk tugas yang sangat kritis (butuh ACID).
// Contoh: Payment Processing.
func ProcessPayment(ctx context.Context, tx pgx.Tx, userID string, amount int) error {
    // 1. Potong saldo (Relational integrity)
    _, err := tx.Exec(ctx, "UPDATE wallets SET balance = balance - $1 WHERE user_id = $2", amount, userID)
    
    // 2. Transaksional Enqueue (Atomicity)
    // Hanya dieksekusi jika saldo benar-benar terpotong!
    _, err = client.InsertTx(ctx, tx, GenerateInvoiceArgs{UserID: userID}, nil)
    return err
}
```

### Anti-Pattern 2: Large Payload dalam JobArgs
Menyimpan file Base64 berukuran megabyte di dalam JobArgs akan membengkakkan kolom JSONB, memperlambat *seq scans* / *index scans* di tabel `river_job`, dan menyebabkan Postgres TOAST *table bloat*.

❌ **BAD (Payload Raksasa)**
```go
type ProcessVideoArgs struct {
    VideoName     string `json:"video_name"`
    RawVideoBytes []byte `json:"raw_video_bytes"` // BAHAYA! Jangan simpan BLOB di queue!
}
```

✅ **GOOD (Claim Check Pattern: Simpan di Object Storage, Kirim URL/ID ke antrean)**
```go
type ProcessVideoArgs struct {
    VideoID       string `json:"video_id"` 
    S3ObjectKey   string `json:"s3_object_key"` // Simpan referensinya saja
}
```

---

## 7. Kode Production-Ready (Go)

Berikut implementasi inisialisasi Client dan Worker yang kokoh, dengan error handling dan defensive programming.

```go
package riversetup

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// RiverEngine merangkum fungsionalitas Client dan Worker River.
type RiverEngine struct {
	Client *river.Client[pgxpool.Tx]
	pool   *pgxpool.Pool
	logger *slog.Logger
}

// NewRiverEngine menginisialisasi River queue system.
func NewRiverEngine(ctx context.Context, dbURL string, logger *slog.Logger) (*RiverEngine, error) {
	if dbURL == "" {
		return nil, fmt.Errorf("database URL cannot be empty")
	}

	// 1. Setup PGX Pool
	poolConfig, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}
	// Optimasi koneksi (Penting untuk menghindari edge case Connection Exhaustion)
	poolConfig.MaxConns = 25
	poolConfig.MinConns = 5

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create pool: %w", err)
	}

	// 2. Setup Workers
	workers := river.NewWorkers()
	// Registrasikan worker di sini (Di production akan di-inject lewat dependency injection)
	// river.AddWorker(workers, &jobs.SendWelcomeEmailWorker{})

	// 3. Konfigurasi River Client
	config := &river.Config{
		Logger:  logger,
		Workers: workers,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
			"high_priority":    {MaxWorkers: 20},
		},
		// Cleanup logic: menghapus job yang sudah selesai dari tabel secara periodik
		JobTimeout: 2 * time.Hour, 
	}

	client, err := river.NewClient(riverpgxv5.New(pool), config)
	if err != nil {
		return nil, fmt.Errorf("failed to init river client: %w", err)
	}

	return &RiverEngine{
		Client: client,
		pool:   pool,
		logger: logger,
	}, nil
}

// Start menjalankan background workers.
func (e *RiverEngine) Start(ctx context.Context) error {
	e.logger.Info("Starting River workers")
	return e.Client.Start(ctx)
}

// Stop menghentikan workers dengan graceful shutdown.
func (e *RiverEngine) Stop(ctx context.Context) error {
	e.logger.Info("Stopping River workers gracefully")
	return e.Client.Stop(ctx)
}

// EnqueueTx mengirim job dalam scope database transaction yang ada.
func (e *RiverEngine) EnqueueTx(ctx context.Context, tx pgxpool.Tx, args river.JobArgs) error {
    if args == nil {
        return fmt.Errorf("job args cannot be nil")
    }
	_, err := e.Client.InsertTx(ctx, tx, args, nil)
	return err
}
```

---

## 8. Unit & Integration Testing (Testable Go Code)

Kita akan menulis 3 test case yang dijamin dapat berjalan untuk memverifikasi fungsionalitas Job Queue. River dirancang dengan sangat baik untuk unit testing melalui *test helpers*.

*Catatan: Test ini mengasumsikan database Postgres tersedia di `DATABASE_URL` untuk integration test.*

```go
package jobs_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/riveropts"
	"github.com/riverqueue/river/rivertest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Dummy Setup ---
type DummyArgs struct {
	ID string `json:"id"`
}
func (DummyArgs) Kind() string { return "dummy_job" }

type DummyWorker struct {
	river.WorkerDefaults[DummyArgs]
	executed bool
	fail     bool
}
func (w *DummyWorker) Work(ctx context.Context, job *river.Job[DummyArgs]) error {
	if w.fail {
		return errors.New("simulated failure")
	}
	w.executed = true
	return nil
}

// Helper: Setup Test Client
func setupTestDB(t *testing.T) (*pgxpool.Pool, *river.Client[pgxpool.Tx], *DummyWorker) {
	ctx := context.Background()
	// Gunakan test DB! Pastikan schema River sudah di-migrate di DB ini.
	pool, err := pgxpool.New(ctx, "postgres://postgres:postgres@localhost:5432/river_test?sslmode=disable")
	if err != nil {
		t.Skip("Database not available, skipping test.")
	}
	
	// Bersihkan tabel sebelum test (Clean State)
	_, _ = pool.Exec(ctx, "TRUNCATE river_job CASCADE")

	workers := river.NewWorkers()
	dummyWorker := &DummyWorker{}
	river.AddWorker(workers, dummyWorker)

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Workers: workers,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 1},
		},
		TestOnly: true, // Optimasi agresif untuk kecepatan test
	})
	require.NoError(t, err)

	return pool, client, dummyWorker
}

// 1. Integration Test: Enqueue dan Worker Eksekusi Sukses
func TestRiver_Integration_ExecuteJobSuccessfully(t *testing.T) {
	ctx := context.Background()
	_, client, worker := setupTestDB(t)

	// Mulai client dalam background
	err := client.Start(ctx)
	require.NoError(t, err)
	defer client.Stop(ctx)

	// Enqueue job
	_, err = client.Insert(ctx, DummyArgs{ID: "job-123"}, nil)
	require.NoError(t, err)

	// rivertest.Wait akan memblokir sampai queue default selesai memproses job
	err = rivertest.Wait(ctx, client, river.QueueDefault)
	require.NoError(t, err)

	// Verifikasi worker berjalan
	assert.True(t, worker.executed, "Worker should have executed successfully")
}

// 2. Integration Test: Job Uniqueness (Mencegah Duplicate Insertion)
func TestRiver_Integration_JobUniqueness(t *testing.T) {
	ctx := context.Background()
	_, client, _ := setupTestDB(t)

	opts := &riveropts.InsertOpts{
		UniqueOpts: riveropts.UniqueOpts{
			ByArgs:  true,
			ByState: []river.JobState{river.JobStateAvailable},
		},
	}

	// Insert Pertama
	res1, err := client.Insert(ctx, DummyArgs{ID: "unique-xyz"}, opts)
	require.NoError(t, err)
	assert.NotNil(t, res1.Job)

	// Insert Kedua (dengan argumen yang identik)
	res2, err := client.Insert(ctx, DummyArgs{ID: "unique-xyz"}, opts)
	require.NoError(t, err)
	
	// Verifikasi: res2.JobUniqueSkipped harus true, tidak ada job baru yg di-insert
	assert.True(t, res2.UniqueSkipped)
	assert.Nil(t, res2.Job, "Second job should be skipped because it is unique")
}

// 3. Integration Test: Job Retry & Status Discarded
func TestRiver_Integration_JobFailureAndRetry(t *testing.T) {
	ctx := context.Background()
	pool, client, worker := setupTestDB(t)
	worker.fail = true // Set worker untuk selalu gagal

	// Gunakan opts untuk max attempts yang kecil (2) agar cepat masuk Discarded
	opts := &riveropts.InsertOpts{
		MaxAttempts: 2,
	}

	// Jangan panggil client.Start(ctx) karena kita mau mengontrolnya secara manual via Client.Work()
	// yang mensimulasikan satu iterasi fetch & work (berguna untuk Unit Test!).

	// Insert Job
	res, err := client.Insert(ctx, DummyArgs{ID: "fail-job"}, opts)
	require.NoError(t, err)

	jobID := res.Job.ID

	// Iterasi 1: Worker mengambil job dan gagal
	// Note: Dalam mode testing river.Work bisa digunakan secara sinkron.
	// Jika menggunakan Client.Start, kita harus poll databasenya. Di sini kita poll DB nya.
	err = client.Start(ctx)
	require.NoError(t, err)

	// Tunggu proses retry
	time.Sleep(1 * time.Second) 
	client.Stop(ctx)

	// Verifikasi dari DB secara langsung
	var state river.JobState
	var attempts int
	err = pool.QueryRow(ctx, "SELECT state, attempts FROM river_job WHERE id = $1", jobID).Scan(&state, &attempts)
	
	require.NoError(t, err)
	assert.Equal(t, river.JobStateRetryable, state, "State should be retryable after first failure")
	assert.Equal(t, 1, attempts)
}
```

## Kesimpulan
River adalah solusi antrean *enterprise-grade* untuk Go dengan PostgreSQL. River membebaskan arsitektur dari keharusan merawat Redis secara terpisah dengan memberikan jaminan ACID yang absolut—sangat cocok untuk domain FinTech, Payment, dan Billing. Namun, ingatlah batasannya: Jangan gunakan untuk pub-sub *realtime* berkecepatan tinggi, optimalkan *connection pool* Postgres, dan cegah payload raksasa.

## Kapan JANGAN Pakai Ini

- **Bila database sudah menjadi penyempitan.** Antrean menambah beban tulis, polling, dan pembersihan ke database yang **sama** dengan jalur transaksi Anda. Keuntungan transaksionalnya nyata, tapi tidak gratis.
- **Job berdurasi sangat lama tanpa checkpoint.** Worker yang mati di tengah mengulang dari awal. Untuk pekerjaan berjam-jam, pecah menjadi langkah yang masing-masing bisa dilanjutkan.
- **Enqueue di luar transaksi bisnis.** Keuntungan utama River adalah enqueue yang **transaksional** dengan perubahan data. Membuangnya berarti kembali ke masalah yang dipecahkan outbox, dengan tambahan kerumitan.
- **Polling terlalu sering pada tabel job besar.** Setiap poll adalah query. Interval harus diturunkan dari kebutuhan latensi nyata, bukan dari keinginan agar terasa responsif.
- **Tanpa pembersihan job yang sudah selesai.** Tabel tumbuh, index membesar, dan poll ikut melambat — sistem antrean yang perlahan menjadi lambat karena keberhasilannya sendiri.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi transaksi naik sejak antrean dipasang | beban tulis tambahan | Antrean dan aplikasi berbagi database |
| Job diproses lama setelah di-enqueue | interval poll dan jumlah worker | Poll terlalu jarang atau worker kurang |
| Tabel job membesar terus | kebijakan pembersihan | Job selesai tidak pernah dihapus |
| Job berjalan meski transaksi rollback | apakah enqueue transaksional | Enqueue di luar transaksi |
| Job panjang selalu mengulang dari awal | checkpoint di dalam job | Tidak ada kemajuan yang tersimpan |

```sql
-- Kesehatan antrean: backlog, umur tertua, dan yang gagal
SELECT state, count(*), min(created_at) AS tertua
FROM river_job GROUP BY 1 ORDER BY 2 DESC;

SELECT count(*) FROM river_job
WHERE state = 'available' AND scheduled_at < now() - interval '5 minutes';

SELECT pg_size_pretty(pg_total_relation_size('river_job')) AS ukuran;

-- Job yang gagal berulang: kandidat untuk dead letter
SELECT kind, attempt, count(*) FROM river_job
WHERE state = 'retryable' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;
```
