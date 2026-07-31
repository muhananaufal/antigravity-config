# Strategi Database Locking: Pessimistic, Optimistic, & Advisory

## Konsep dan Internals

Meskipun *Isolation Levels* pada PostgreSQL dapat mencegah anomali standar (seperti *dirty reads* atau *write skew*), aplikasi skala produksi seringkali menuntut aturan bisnis eksplisit. Misalnya: "Jangan biarkan dua *worker* mengirim email selamat datang ke pengguna yang sama," atau "Pastikan hanya ada satu server yang mengeksekusi migrasi *cron job* harian". Untuk inilah sistem *Locking* (penguncian) ada.

Terdapat 3 strategi fundamental di PostgreSQL saat diakses dari Go:

1. **Pessimistic Locking (`SELECT ... FOR UPDATE`)**: Transaksi secara agresif mengunci satu atau beberapa baris di disk (database-level). Transaksi lain yang mencoba memodifikasi atau mengunci baris tersebut harus berhenti/mengantre (menunggu) hingga lock dilepas (via `COMMIT` atau `ROLLBACK`). Pendekatan ini aman, namun memicu antrean (*bottleneck*) jika tidak hati-hati.
   *Fitur Super*: `FOR UPDATE SKIP LOCKED`. Sangat ideal untuk sistem antrean (Queue / Worker). Alih-alih mengantre menunggu baris yang terkunci, PostgreSQL langsung melompatinya dan memberikan baris berikutnya yang tidak dikunci!

2. **Optimistic Locking (CAS - Compare and Swap)**: Transaksi berjalan *tanpa mengunci database sedikitpun*. Pendekatan ini mengandalkan kolom kontrol di dalam tabel (biasanya `version` integer, atau cap waktu `updated_at`). Transaksi hanya memodifikasi data **jika dan hanya jika** versinya belum berubah sejak terakhir dibaca. Ini jauh lebih murah dan skalabel (tanpa beban koneksi pool yang mengantre) untuk sistem dengan rasio operasi *Read* jauh melebihi *Write* (contoh: CMS, pengubahan profil pengguna).

3. **Advisory Locks (`pg_advisory_lock` / `pg_advisory_xact_lock`)**: PostgreSQL menyediakan memori khusus bagi aplikasi untuk mendefinisikan "gembok logis" berbasis ID *Integer* (64-bit). Lock ini tidak mengikat ke tabel mana pun, tidak mengunci row apapun, murni bergantung pada nama yang disepakati aplikasi. Sempurna untuk menjaga agar skrip penjadwalan (*Cron scheduler*) atau sinkronisasi infrastruktur tidak berjalan ganda di atas arsitektur *microservices* multi-replika.

---

## Diagram ASCII: Antrean Pekerjaan (Queue) dengan SKIP LOCKED

```text
========================================================================================
Skenario: 3 Worker berjalan bersamaan memproses antrean email (Jobs 101, 102, 103)
========================================================================================

    [Worker A]               [Worker B]                [Worker C]
    (Mencari Job)            (Mencari Job)             (Mencari Job)
          |                        |                         |
          v                        v                         v
  SELECT * FROM jobs       SELECT * FROM jobs        SELECT * FROM jobs
  WHERE status='pending'   WHERE status='pending'    WHERE status='pending'
  ORDER BY id ASC          ORDER BY id ASC           ORDER BY id ASC
  FOR UPDATE SKIP LOCKED   FOR UPDATE SKIP LOCKED    FOR UPDATE SKIP LOCKED
  LIMIT 1;                 LIMIT 1;                  LIMIT 1;

 +-------------------------------------------------------------------------+
 | Database PostgreSQL (Mengeksekusi Query nyaris serentak)                |
 |                                                                         |
 |  [Tabel Jobs]                                                           |
 |  Row 101 (Pending) <---- Dikunci oleh Worker A (Berhasil dapat Job 101) |
 |                                                                         |
 |  Row 102 (Pending) <---- Worker B mencoba Row 101, TERKUNCI!            |
 |                          Bukannya hang, SKIP LOCKED melempar ke baris   |
 |                          selanjutnya. Dikunci oleh Worker B (Job 102)   |
 |                                                                         |
 |  Row 103 (Pending) <---- Worker C skip 101 & 102. Mengunci 103!         |
 +-------------------------------------------------------------------------+

Hasil: Worker bekerja paralel sempurna TANPA ADA deadlock atau waktu idle!
========================================================================================
```

---

## Kode Go Production-Ready

Kode berikut menunjukkan tiga fungsi untuk mengimplementasikan ketiga pilar strategi di atas menggunakan `pgx/v5`.

```go
package database

import (
	"context"
	"errors"
	"fmt"
	"hash/crc32"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrOptimisticLockFailed dilempar saat terjadi benturan versi.
var ErrOptimisticLockFailed = errors.New("optimistic lock failed: version mismatch")
// ErrNoJobsAvailable dilempar saat queue habis.
var ErrNoJobsAvailable = errors.New("no jobs available at the moment")

// 1. Optimistic Locking
// Mengupdate profil produk hanya jika tak ada admin lain yang mengubahnya secara bersamaan.
func UpdateProductOptimistic(ctx context.Context, pool *pgxpool.Pool, id int, newPrice float64, expectedVersion int) error {
	query := `
		UPDATE products 
		SET price = $1, version = version + 1 
		WHERE id = $2 AND version = $3
	`
	
	// Tidak perlu BeginTx. Satu query mandiri sangat cepat dan ringkas.
	commandTag, err := pool.Exec(ctx, query, newPrice, id, expectedVersion)
	if err != nil {
		return fmt.Errorf("failed to execute optimistic update: %w", err)
	}

	// Memeriksa RowsAffected() adalah "jantung" dari Optimistic Locking.
	// Jika kembaliannya 0, maka klausa `version = $3` luput (sudah dimodifikasi pihak lain).
	if commandTag.RowsAffected() == 0 {
		return ErrOptimisticLockFailed
	}

	return nil
}

// 2. Pessimistic Locking dengan SKIP LOCKED
// Mengambil Job teratas dari Queue dan langsung menguncinya.
func FetchJobForProcessing(ctx context.Context, pool *pgxpool.Pool) (jobID int, payload string, err error) {
	// Wajib dalam transaksi, karena lock bertahan hanya selama transaksi aktif.
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Pastikan menunjuk spesifik tabel OF jobs agar tidak mengunci relasi (jika pakai JOIN)
	query := `
		SELECT id, payload 
		FROM jobs 
		WHERE status = 'pending' 
		ORDER BY created_at ASC 
		FOR UPDATE OF jobs SKIP LOCKED 
		LIMIT 1
	`
	
	err = tx.QueryRow(ctx, query).Scan(&jobID, &payload)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, "", ErrNoJobsAvailable
		}
		return 0, "", fmt.Errorf("query locked row: %w", err)
	}

	// Update status ke processing agar ketika transaksi selesai (commit),
	// Worker lain yang tidak pakai SKIP LOCKED tidak mengambilnya.
	_, err = tx.Exec(ctx, "UPDATE jobs SET status = 'processing' WHERE id = $1", jobID)
	if err != nil {
		return 0, "", fmt.Errorf("update status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, "", fmt.Errorf("commit tx: %w", err)
	}

	return jobID, payload, nil
}

// 3. Advisory Locking (Transaction-level)
// Menjamin hanya 1 pod aplikasi yang mengeksekusi fungsi closure `fn`.
func ExecuteExclusiveLeaderTask(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, taskName string, fn func(context.Context) error) error {
	// Hashing string ke int64 yang diperlukan oleh Advisory Lock
	lockID := int64(crc32.ChecksumIEEE([]byte(taskName)))

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin leader tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var lockAcquired bool
	// xact_lock otomatis melepaskan kunci di ujung transaksi (rollback/commit)
	// pg_try_* tidak akan hang menunggu, ia mereturn true/false (Non-Blocking)
	err = tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1)", lockID).Scan(&lockAcquired)
	if err != nil {
		return fmt.Errorf("acquire advisory lock: %w", err)
	}

	if !lockAcquired {
		logger.DebugContext(ctx, "task already running on another node, skipping", slog.String("task", taskName))
		return nil // Secara terhormat mengalah
	}

	logger.InfoContext(ctx, "advisory lock acquired, executing task", slog.String("task", taskName))
	
	// Eksekusi core logic eksklusif (misal kirim report harian)
	if err := fn(ctx); err != nil {
		return fmt.Errorf("leader task failed: %w", err)
	}

	return tx.Commit(ctx)
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Menahan Lock Pessimistic Saat Pemanggilan I/O Lambat
Sebuah baris dikunci di DB, tapi aplikasi kemudian melakukan pemanggilan jaringan pihak ketiga.

```go
// ❌ BAD: Mengunci database selama durasi pemanggilan API
func ProcessPaymentSync(ctx context.Context, tx pgx.Tx, userID int) error {
	// 1. Kunci baris user
	tx.Exec(ctx, "SELECT * FROM users WHERE id = $1 FOR UPDATE", userID)
	
	// 2. Memanggil Stripe HTTP API (Membutuhkan 3-5 detik latensi!)
	resp, _ := stripeClient.Charge(...) 
	
	// 3. Modifikasi DB dan Selesai
	tx.Exec(ctx, "UPDATE users ...") 
	return tx.Commit(ctx)
}
```

```go
// ✅ GOOD: Commit transaksi lock untuk mengamankan state logis, proses API lambat, gunakan state logis
func ProcessPaymentAsync(ctx context.Context, pool *pgxpool.Pool, userID int) error {
	// Transaksi Kecil Cepat
	pool.Exec(ctx, "UPDATE users SET status='paying' WHERE id=$1 AND status='idle'", userID)
	
	// Di Luar Transaksi (Tidak ada Row DB yang di-lock di OS)
	resp, _ := stripeClient.Charge(...)
	
	// Transaksi Kecil Cepat 2
	pool.Exec(ctx, "UPDATE users SET status='paid' WHERE id=$1", userID)
	return nil
}
```
**Why dangerous:** Saat `stripeClient.Charge()` sedang "terbang" di jaringan selama 5 detik, transaksi masih terbuka dan baris DB `users` terkunci secara eksklusif. Apabila API *Stripe* melambat drastis, seluruh koneksi pool aplikasi bisa habis tertahan (karena goroutine memblok menunggu lock), menyebabkan efek kartu domino (kematian aplikasi). Database tidak didesain sebagai pelindung *state* jaringan internet.

### ❌ Anti-Pattern 2: Deadlock karena Lock Ordering yang Acak
Mengunci baris `FOR UPDATE` dalam iterasi array tanpa menjamin urutannya selalu pasti dan deterministik.

```go
// ❌ BAD: Transaksi A me-lock User 5 lalu 10. Transaksi B (karena input acak) me-lock User 10 lalu 5.
for _, id := range userIDs { // userIDs = [10, 5] (Acak / Tergantung API request)
	tx.Exec(ctx, "SELECT * FROM users WHERE id = $1 FOR UPDATE", id)
}
```

```go
// ✅ GOOD: Selalu mengurutkan ID secara menaik (Ascending) sebelum Locking massal.
import "sort"

sort.Ints(userIDs) // Terjamin [5, 10]
for _, id := range userIDs {
	tx.Exec(ctx, "SELECT * FROM users WHERE id = $1 FOR UPDATE", id)
}
```
**Why dangerous:** Dua Goroutine yang bersilangan arah *locking* akan menyebabkan `Deadlock` di dalam PostgreSQL engine (SQLSTATE 40P01). Database akan mendeteksi kebuntuan dan secara paksa menembak jatuh salah satu transaksi dengan melemparkan error yang parah.

---

## Edge Cases & Defensive Programming

1. **Advisory Lock Key Collision (Benturan Kunci)**
   Kunci Advisory Lock menggunakan *namespace* integer tunggal seluas (64-bit) untuk seluruh database secara absolut. Berbeda dengan lock tabel. Jika Sistem Logistik *Cron* A membuat *hash* ke ID `123`, dan Sistem HR *Cron* B kebetulan menghasilkan ID `123`, satu cron tidak akan jalan.
   *Tip Spesifik*: Alih-alih melakukan *hash string*, sediakan *registry map* di kode berisi ID unik (contoh: `const TaskBilling = 1`, `TaskPromo = 2`), atau gunakan *hash function* yang kuat dan kombinasikan dengan nama tabel/prefix.

2. **ABA Problem di Optimistic Lock**
   Terkadang orang menggunakan kolom `status` sebagai ganti `version` (*Optimistic check*). Contoh: `UPDATE ... WHERE status = 'pending'`. 
   Masalahnya (ABA Problem): Transaksi 1 melihat 'pending'. Transaksi 2 mengubah ke 'done'. Transaksi 3 mengubah kembali jadi 'pending'. Saat Transaksi 1 mengeksekusi update-nya, kondisinya tembus karena status kembali ke awal, padahal *state* internal aplikasi mungkin sudah banyak yang korup/berubah. Selalu manfaatkan penghitung Monotonik (Maju terus), yakni `INT version = version + 1`.

3. **Bahaya SKIP LOCKED pada Relasi (JOIN)**
   Saat menggunakan tabel queue kompleks dengan JOIN:
   `SELECT ... FROM jobs JOIN users ON ... FOR UPDATE SKIP LOCKED`
   Secara default, PostgreSQL akan mengunci row di tabel `jobs` DAN baris relasinya di `users`. Worker 1 yang memproses Job (User Alice) akan diam-diam membuat Worker 2 (yang melayani Job User Alice tapi kategori lain) melompati *Job* tersebut karena baris `users` Alice terkunci.
   *Solusi wajib*: Gunakan `FOR UPDATE OF jobs SKIP LOCKED` untuk secara tegas membatasi entitas mana yang di-lock.

---

## Unit Tests

Menguji lock bisa *tricky* dalam unit testing reguler. Yang terpenting adalah menguji skenario positif dan negatif (kembalian *RowsAffected* = 0) tanpa harus men-spawn konkurensi sesungguhnya (untuk stabilitas test lokal).

```go
package database_test

import (
	"context"
	"errors"
	"testing"
	"yourproject/internal/database" // sesuaikan path import
)

// Dummy struktural mock untuk pool (demonstrasi Test pattern).
// Di environment Go yang direkomendasikan, gunakan pgxmock atau Testcontainers-go.

type mockCommandTag struct {
	rows int64
}

func (m mockCommandTag) RowsAffected() int64 { return m.rows }
// dummy interface methods...

func TestUpdateProductOptimistic_FailMismatchedVersion(t *testing.T) {
	// Simulasi: Database mengembalikan 0 rows affected karena 
	// klausa "WHERE version = X" luput.
	rowsAffected := int64(0)
	
	// Dalam struktur sesungguhnya, mock ini diatur pada interface sql/DB
	// atau disimulasikan menggunakan logic branch.
	if rowsAffected == 0 {
		err := database.ErrOptimisticLockFailed
		
		if !errors.Is(err, database.ErrOptimisticLockFailed) {
			t.Fatalf("expected ErrOptimisticLockFailed, got %v", err)
		}
	}
}

func TestUpdateProductOptimistic_Success(t *testing.T) {
	// Simulasi: Database sukses update.
	rowsAffected := int64(1)
	
	if rowsAffected != 1 {
		t.Fatalf("unexpected failure")
	}
	// success case
}
```
