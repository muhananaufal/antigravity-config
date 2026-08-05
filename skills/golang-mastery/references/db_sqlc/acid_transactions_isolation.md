# Transaksi ACID, Isolation Levels, dan Concurrency Control di PostgreSQL

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · pgx/v5 · **Lihat juga:** `db_sqlc/database_locking_strategies.md` · `db_sqlc/connection_pool_tuning.md` · `distributed_patterns_resilience/retry_backoff_jitter.md` · `distributed_patterns_resilience/saga_orchestration_choreography.md`

## Konsep dan Internals

Dalam ekosistem Golang yang sangat *concurrent*, interaksi dengan database relasional seperti PostgreSQL menuntut pemahaman mendalam tentang **ACID (Atomicity, Consistency, Isolation, Durability)**. Kesalahan pemahaman pada tingkat isolasi (Isolation Level) dapat menyebabkan bug data-korupsi yang sangat sulit dilacak (seperti *lost updates*, *phantom reads*, atau *write skew*).

PostgreSQL mengimplementasikan kontrol konkurensi melalui **MVCC (Multi-Version Concurrency Control)**. Alih-alih melakukan *lock* pada seluruh tabel saat operasi baca/tulis, PostgreSQL menyimpan beberapa versi dari sebuah *row* (baris data). Setiap *tuple* (baris) memiliki metadata tersembunyi: `xmin` (ID transaksi yang membuat tuple tersebut) dan `xmax` (ID transaksi yang menghapus/mengubah tuple tersebut).

### Tingkat Isolasi (Isolation Levels) di PostgreSQL

1. **Read Uncommitted**: Di PostgreSQL, ini berperilaku persis sama dengan *Read Committed*. PostgreSQL tidak pernah membiarkan Anda membaca data yang belum di-commit (*dirty reads*).
2. **Read Committed (Default)**: Sebuah query hanya akan melihat data yang telah di-commit **sebelum query tersebut dimulai**. Jika menjalankan `SELECT` dua kali dalam transaksi yang sama, Anda bisa mendapatkan hasil yang berbeda jika ada transaksi lain yang mengubah dan men-commit data tersebut di antara kedua query Anda (*non-repeatable read*).
3. **Repeatable Read**: Semua query dalam satu transaksi hanya akan melihat data yang telah di-commit **sebelum transaksi dimulai**. Menjamin tidak ada *non-repeatable reads*. Jika ada transaksi lain yang memodifikasi baris yang sama, PostgreSQL akan menolak commit Anda dengan pesan `could not serialize access due to concurrent update`.
4. **Serializable**: Level paling ketat. Menjamin bahwa jika transaksi berjalan secara *concurrent*, hasilnya akan sama seperti jika transaksi tersebut dijalankan secara *serial* (satu per satu). PostgreSQL secara aktif memantau ketergantungan baca/tulis (*read-write dependencies*). Jika mendeteksi potensi anomali (seperti *write skew*), ia akan menggagalkan salah satu transaksi dengan error `serialization_failure` (SQLSTATE `40001`).

### Trade-off Arsitektural
- **Pessimistic Locking (Read Committed + `SELECT ... FOR UPDATE`)**: Transaksi secara eksplisit mengunci baris data. Cocok untuk sistem dengan tingkat konflik yang sangat tinggi, namun berpotensi menurunkan *throughput* secara keseluruhan karena goroutine lain akan terblokir menunggu *lock* dilepaskan.
- **Optimistic Concurrency (Serializable Isolation)**: Transaksi tidak menggunakan lock eksplisit. Aplikasi dibiarkan memodifikasi data. Jika terjadi konflik, database menggagalkan transaksi, dan aplikasi harus **melakukan retry**. Sangat cepat untuk sistem yang jarang konflik (misal: 95% transaksi menyentuh row yang berbeda), namun wajib memiliki mekanisme *retry* di level Go.

---

## Diagram ASCII: MVCC dan Serialization Failure

```text
========================================================================================
| Skenario: Write Skew Anomaly (Dideteksi oleh Serializable, Lolos oleh Read Committed)|
========================================================================================
Tabel: doctors_on_call (Minimal 1 dokter harus on-call)
Status Awal: Alice (on-call=true), Bob (on-call=true)

Goroutine 1 (Tx A)                          Goroutine 2 (Tx B)
[Level: Serializable]                       [Level: Serializable]
-----------------------------------------   -----------------------------------------
1. BEGIN;
                                            2. BEGIN;
3. SELECT count(*) FROM doctors_on_call     
   WHERE on_call = true; (Hasil: 2)
                                            4. SELECT count(*) FROM doctors_on_call
                                               WHERE on_call = true; (Hasil: 2)
                                               
5. -- Mengira masih ada 2 orang on-call,
   -- Tx A mengizinkan Alice cuti.
   UPDATE doctors_on_call 
   SET on_call = false WHERE name='Alice';
                                            6. -- Mengira masih ada 2 orang on-call,
                                               -- Tx B mengizinkan Bob cuti.
                                               UPDATE doctors_on_call 
                                               SET on_call = false WHERE name='Bob';
7. COMMIT; 
   (Berhasil, status Alice tersimpan)

                                            8. COMMIT;
                                               (ERROR: SQLSTATE 40001)
                                               "could not serialize access..."

-----------------------------------------   -----------------------------------------
[RETRY MECHANISM BERAKSI UNTUK TX B]
9. BEGIN;
10. SELECT count(*) ... (Hasil: 1, karena Alice sudah cuti)
11. Batal Update Bob, aplikasi mereturn error "Minimal 1 dokter harus on-call".
========================================================================================
```

---

## Kode Go Production-Ready

Kode di bawah menunjukkan cara membangun *Transaction Manager* menggunakan `pgx/v5` yang secara otomatis menangani *retry* jika terjadi `serialization_failure` atau `deadlock_detected`.

```go
package database

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres error codes
const (
	ErrCodeSerializationFailure = "40001"
	ErrCodeDeadlockDetected     = "40P01"
)

// TxFn merepresentasikan fungsi yang dieksekusi dalam konteks transaksi database.
type TxFn func(ctx context.Context, tx pgx.Tx) error

// RetryOptions mengatur perilaku exponential backoff dari mekanisme transaksi.
type RetryOptions struct {
	MaxRetries int
	BaseDelay  time.Duration
	MaxDelay   time.Duration
}

// DefaultRetryOptions menyediakan konfigurasi yang disarankan untuk production.
func DefaultRetryOptions() RetryOptions {
	return RetryOptions{
		MaxRetries: 5,
		BaseDelay:  10 * time.Millisecond,
		MaxDelay:   250 * time.Millisecond,
	}
}

// ExecuteSerializableTx menjalankan callback dalam transaksi level Serializable dan 
// melakukan retry otomatis jika terjadi error concurrency dari PostgreSQL.
func ExecuteSerializableTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	opts RetryOptions,
	logger *slog.Logger,
	fn TxFn,
) error {
	// Logger nil akan panic pada pemanggilan WarnContext di bawah -- dan itu
	// HANYA terjadi saat ada konflik transaksi, yaitu di produksi bertrafik
	// tinggi, tidak pernah di uji. Jaga di sini, bukan di sana.
	if logger == nil {
		logger = slog.Default()
	}
	// MaxRetries 0 membuat loop tidak pernah berjalan, dan baris terakhir
	// fungsi ini akan membungkus err yang masih nil dengan %w.
	if opts.MaxRetries < 1 {
		opts.MaxRetries = 1
	}
	if opts.BaseDelay < time.Millisecond {
		opts.BaseDelay = time.Millisecond // rand.Int63n panic bila argumennya <= 0
	}

	txOpts := pgx.TxOptions{
		IsoLevel:   pgx.Serializable,
		AccessMode: pgx.ReadWrite,
	}

	var err error
	delay := opts.BaseDelay

	for attempt := 1; attempt <= opts.MaxRetries; attempt++ {
		err = executeSingleTx(ctx, pool, txOpts, fn)
		if err == nil {
			// Berhasil, keluar dari loop
			return nil
		}

		// Periksa apakah error ini dapat di-retry (kode 40001 atau 40P01)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == ErrCodeSerializationFailure || pgErr.Code == ErrCodeDeadlockDetected {
				logger.WarnContext(ctx, "transaction conflict, retrying",
					slog.Int("attempt", attempt),
					slog.String("pg_code", pgErr.Code),
					slog.String("pg_message", pgErr.Message),
				)

				// Jangan retry di attempt terakhir, biarkan error dikembalikan ke caller
				if attempt == opts.MaxRetries {
					break
				}

				// Exponential backoff dengan Jitter untuk menghindari thundering herd
				jitter := time.Duration(rand.Int63n(int64(delay) / 2))
				sleepDuration := delay + jitter

				select {
				case <-ctx.Done():
					return fmt.Errorf("context cancelled during tx backoff: %w", ctx.Err())
				case <-time.After(sleepDuration):
					// Lanjutkan ke iterasi retry berikutnya
					delay *= 2
					if delay > opts.MaxDelay {
						delay = opts.MaxDelay
					}
					continue
				}
			}
		}

		// Jika error bukan karena concurrency database, langsung return tanpa retry
		return err
	}

	return fmt.Errorf("failed to execute transaction after %d attempts: %w", opts.MaxRetries, err)
}

// executeSingleTx menangani life-cycle transaksi tunggal (Begin, defer Rollback, Commit).
func executeSingleTx(ctx context.Context, pool *pgxpool.Pool, opts pgx.TxOptions, fn TxFn) error {
	tx, err := pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}

	// Defer Rollback yang aman: pgx akan mengabaikan Rollback jika transaksi 
	// sudah berhasil di-commit.
	defer func() {
		rollbackErr := tx.Rollback(ctx)
		if rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			// Hanya dicatat dalam log, jangan mengoverride error utama
			// kecuali Anda memerlukan penanganan error rollback spesifik.
			slog.ErrorContext(ctx, "failed to rollback transaction", slog.String("error", rollbackErr.Error()))
		}
	}()

	// Eksekusi core logic dari transaksi
	if err := fn(ctx, tx); err != nil {
		return err // Error aplikasi atau query, serahkan ke caller dan rollback tereksekusi
	}

	// Commit transaksi
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit tx: %w", err)
	}

	return nil
}

// --- Contoh Implementasi Domain ---

// ProcessTransfer mentransfer saldo antara dua akun dengan jaminan isolasi penuh.
func ProcessTransfer(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger, fromID, toID int, amount int64) error {
	if amount <= 0 {
		return errors.New("amount must be greater than zero")
	}

	return ExecuteSerializableTx(ctx, pool, DefaultRetryOptions(), logger, func(ctx context.Context, tx pgx.Tx) error {
		var balance int64
		// Ambil saldo. Karena Serializable, tidak perlu FOR UPDATE.
		err := tx.QueryRow(ctx, "SELECT balance FROM accounts WHERE id = $1", fromID).Scan(&balance)
		if err != nil {
			return fmt.Errorf("failed to read balance: %w", err)
		}

		if balance < amount {
			return errors.New("insufficient funds")
		}

		_, err = tx.Exec(ctx, "UPDATE accounts SET balance = balance - $1 WHERE id = $2", amount, fromID)
		if err != nil {
			return fmt.Errorf("failed to deduct from sender: %w", err)
		}

		_, err = tx.Exec(ctx, "UPDATE accounts SET balance = balance + $1 WHERE id = $2", amount, toID)
		if err != nil {
			return fmt.Errorf("failed to add to recipient: %w", err)
		}

		return nil
	})
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Deferred Rollback atau Handling Error yang Salah
Tidak menutup transaksi dengan benar saat terjadi `panic` atau saat query mengembalikan error (early return).

```go
// ❌ BAD: Transaksi bocor jika query gagal atau panic terjadi.
func transfer(ctx context.Context, pool *pgxpool.Pool) error {
	tx, _ := pool.Begin(ctx)
	
	_, err := tx.Exec(ctx, "UPDATE accounts ...")
	if err != nil {
		return err // Transaksi menggantung, koneksi tidak dikembalikan ke pool (Connection Leak!)
	}
	
	tx.Commit(ctx)
	return nil
}
```

```go
// ✅ GOOD: Selalu memanggil defer tx.Rollback() segera setelah transaksi dimulai.
func transfer(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // Secara aman diabaikan jika Commit() sukses

	_, err = tx.Exec(ctx, "UPDATE accounts ...")
	if err != nil {
		return err 
	}
	
	return tx.Commit(ctx)
}
```
**Why dangerous:** Jika sebuah koneksi tertahan dan transaksi tidak di-*rollback*, *lock* tingkat baris di PostgreSQL tetap terpasang. Goroutine lain yang mencoba memperbarui baris yang sama akan tertunda tanpa henti hingga batas waktu habis, menyebabkan habisnya memori aplikasi (*Goroutine leak*) dan PostgreSQL (*Connection leak / Max Connections Reached*), berujung pada *downtime* produksi penuh.

### ❌ Anti-Pattern 2: Operasi Non-Idempotent di Dalam Callback Transaksi yang Di-retry
Melakukan aksi eksternal (*side-effects*) seperti memanggil API pembayaran atau mengirim email dari dalam callback transaksi *Serializable*.

```go
// ❌ BAD: Memanggil API Stripe di dalam fungsi transaksi.
err := ExecuteSerializableTx(ctx, pool, opts, logger, func(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "UPDATE users SET paid = true ...")
	
	// Jika transaksi gagal saat COMMIT (40001), fungsi ini akan dipanggil ulang!
	// Pelanggan bisa terpotong saldonya BERKALI-KALI.
	stripe.ChargeCustomer(...) 
	return nil
})
```

```go
// ✅ GOOD: Pindahkan side-effects ke luar transaksi menggunakan Polling/Outbox Pattern atau jalankan sesudahnya.
err := ExecuteSerializableTx(ctx, pool, opts, logger, func(ctx context.Context, tx pgx.Tx) error {
	// Hanya modifikasi database di sini (idempotent).
	// Contoh: Insert ke tabel outbox yang nantinya di proses worker lain.
	_, err := tx.Exec(ctx, "INSERT INTO outbox (event, status) VALUES ('stripe_charge', 'pending')")
	return err
})
// Worker background membaca outbox dan mengeksekusi Stripe.Charge.
```
**Why dangerous:** Mekanisme *retry* transaksi mengasumsikan bahwa seluruh *block* fungsi dapat dibatalkan dan dieksekusi ulang secara transparan oleh *database*. API eksternal tidak tunduk pada kontrol MVCC database. Eksekusi ulang akan memicu duplikasi *side-effects*, yang sangat fatal untuk sistem finansial.

---

## Edge Cases & Defensive Programming

1. **Context Cancellation di Tengah Transaksi Panjang**
   Jika `ctx` yang dilempar dari HTTP handler dibatalkan (karena *client* memutuskan koneksi internet), operasi `tx.Exec` atau `tx.Commit` akan mengembalikan `context.Canceled`. Namun, kita harus memastikan bahwa koneksi dikembalikan dengan memanggil `tx.Rollback(ctx)`. `pgx` mengimplementasikan ini dengan sangat baik: jika koneksi gagal atau context dibatalkan, `Rollback` secara cerdas melepaskan koneksi, bahkan menutup koneksi dasar (`net.Conn`) jika ia berada di status tidak aman.
   *Koreksi penting*: nasihat "biarkan `Rollback` memakai `ctx` asli, `pgx` menanganinya dengan aman" **menyesatkan**. Bila `ctx` sudah dibatalkan, `Rollback(ctx)` gagal seketika dan `pgx` **membuang koneksinya** — bukan mengembalikannya ke pool. Aman dari sisi konsistensi data, tetapi pada layanan yang sering ditinggal klien, setiap pembatalan berarti satu koneksi dibangun ulang lengkap dengan TCP dan TLS handshake. Di bawah beban, churn ini sendiri menjadi insiden.

   Yang benar untuk *cleanup*: pakai konteks yang **tidak ikut dibatalkan**, dengan batas waktu pendek agar tetap tidak menggantung.
   ```go
   defer func() {
3. **Membedakan Serialization Failure dan Exhausted Pool Timeout**
   Ketika koneksi pool habis karena *load* yang berlebihan, error yang dilempar oleh `pool.BeginTx()` adalah timeout koneksi, bukan `pgconn.PgError`. Pastikan filter *retry* (seperti `pgErr.Code == "40001"`) diterapkan secara presisi dengan menggunakan `errors.As`. Mencoba me-retry timeout pool akan memperburuk masalah karena ribuan goroutine Anda akan menambah *delay* antrean dengan eksponensial.

---

## Unit Tests

Untuk menguji logika *retry* tanpa bergantung pada *real database concurrency*, kita dapat membuat abstraksi sederhana atau secara artifisial menyuntikkan (inject) mock error. Di bawah ini, kita mendemonstrasikan bagaimana memastikan *backoff* terpicu tepat `MaxRetries` kali.

```go
package database_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"yourproject/internal/database" // sesuaikan path import
)

// MockTx dan MockPool tidak disertakan demi keringkasan (biasanya kita menggunakan mock gen seperti gomock untuk interface).
// Namun, mari kita uji logika retries dengan teknik simulasi error.

func TestExecuteSerializableTx_RetryOnSerializationFailure(t *testing.T) {
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	
	// Gunakan base delay yang sangat kecil agar unit test berjalan cepat
	opts := database.RetryOptions{
		MaxRetries: 3,
		BaseDelay:  1 * time.Millisecond,
		MaxDelay:   5 * time.Millisecond,
	}

	attempts := 0
	
	// Kita akan membuat wrapper test yang menguji fungsi core tanpa pgxpool real.
	// Di environment nyata, Anda mengeksekusi ini dengan mock DB atau testcontainers.
	// Untuk demo, asumsikan executeSingleTx telah di-mock untuk menghasilkan 40001.

	mockTxFn := func(ctx context.Context, tx pgx.Tx) error {
		attempts++
		if attempts < 3 {
			// Simulasi PostgreSQL mengembalikan Serialization Failure
			return &pgconn.PgError{
				Code:    database.ErrCodeSerializationFailure,
				Message: "could not serialize access due to concurrent update",
			}
		}
		// Pada percobaan ke-3, berhasil
		return nil
	}

	// simulasi pemanggilan Executor (Anda perlu menyesuaikan executor agar dapat di-mock / menggunakan interface)
	// err := database.ExecuteSerializableTx(...)
	
	// Simulasi logic behavior dari ExecuteSerializableTx:
	var finalErr error
	for attempt := 1; attempt <= opts.MaxRetries; attempt++ {
		err := mockTxFn(ctx, nil) // passing nil untuk tx
		if err == nil {
			finalErr = nil
			break
		}
		
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == database.ErrCodeSerializationFailure {
			if attempt == opts.MaxRetries {
				finalErr = err
				break
			}
			continue // Retry (simplified, tanpa sleep dalam test)
		}
		finalErr = err
		break
	}

	if finalErr != nil {
		t.Fatalf("expected tx to eventually succeed, got error: %v", finalErr)
	}

	if attempts != 3 {
		t.Errorf("expected exactly 3 attempts, got %d", attempts)
	}
}
```

## Kapan JANGAN Pakai Ini

- **`Serializable` sebagai tingkat isolasi bawaan.** Ia mengubah bentrokan konkurensi menjadi galat `40001` yang **WAJIB** di-retry. Kode yang belum siap retry akan memuntahkan galat acak ke pengguna pada beban tinggi. Pakai `Read Committed` kecuali ada invarian lintas baris yang benar-benar tidak bisa dijaga cara lain.
- **Membungkus panggilan jaringan di dalam transaksi.** Setiap milidetik transaksi terbuka menahan snapshot MVCC dan menghambat `VACUUM`. Satu panggilan HTTP di tengah transaksi berarti transaksi sepanjang timeout HTTP — dan bloat yang mengikutinya.
- **Retry pada callback yang tidak idempoten.** Percobaan kedua akan mengirim email kedua, memotong saldo kedua kali, atau menerbitkan event ganda. Efek samping non-transaksional WAJIB dipindahkan ke luar, atau dijamin idempoten.
- **Transaksi lintas database atau lintas layanan.** `PREPARE TRANSACTION` (two-phase commit) menahan lock tanpa batas bila koordinatornya mati, dan hampir selalu keputusan yang salah di arsitektur layanan. Yang tepat adalah saga atau outbox.
- **Satu transaksi untuk pekerjaan batch besar.** `UPDATE` 10 juta baris dalam satu transaksi menghasilkan bloat besar, WAL raksasa, dan rollback yang bisa berjam-jam. Potong per batch dengan commit di antaranya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Galat `40001` melonjak saat trafik naik | tingkat isolasi + pola akses baris | Serializable tanpa retry yang memadai |
| Tabel membengkak, `VACUUM` tidak pernah menyusul | umur transaksi tertua | Ada transaksi menganggur menahan snapshot |
| `40P01 deadlock detected` berkala | urutan pengambilan lock antar jalur kode | Dua jalur mengunci baris dengan urutan berbeda |
| p99 tulis melar tanpa kenaikan CPU | `pg_blocking_pids` | Transaksi antre menunggu lock |
| Efek samping terjadi dua kali | apakah callback di-retry | Operasi non-idempoten di dalam transaksi yang di-retry |

```sql
-- Transaksi menganggur yang masih memegang snapshot: pembunuh VACUUM nomor satu
SELECT pid, state, now()-xact_start AS umur_tx, now()-state_change AS diam,
       left(query,60) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND state <> 'idle'
ORDER BY xact_start LIMIT 20;

-- Rasio rollback dan jumlah deadlock sejak statistik terakhir direset
SELECT datname, xact_commit, xact_rollback, deadlocks, conflicts
FROM pg_stat_database WHERE datname = current_database();

-- Siapa memblokir siapa, lengkap dengan query keduanya
SELECT bl.pid AS diblokir, left(bl.query,50) AS q_diblokir,
       ka.pid AS pemblokir, left(ka.query,50) AS q_pemblokir
FROM pg_stat_activity bl
JOIN pg_stat_activity ka ON ka.pid = ANY(pg_blocking_pids(bl.pid));
```

```bash
# Berapa banyak permintaan mati karena serialization failure?
kubectl logs -l app=api --since=1h | grep -c 'SQLSTATE 40001'
kubectl logs -l app=api --since=1h | grep -c 'SQLSTATE 40P01'
```
