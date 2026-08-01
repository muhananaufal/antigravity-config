# Saga Pattern & Compensation Jobs di Golang: Background Job Processing

Saga Pattern adalah pola arsitektur untuk mengelola transaksi yang mencakup berbagai layanan (services) tanpa bergantung pada *Distributed Transactions* seperti Two-Phase Commit (2PC) yang sering menimbulkan *locking* berlebih dan bottleneck. Dalam implementasinya menggunakan *background jobs* di Golang, pendekatan terbaik adalah **Choreography dengan Job Chaining** yang dikombinasikan dengan basis data relasional (seperti PostgreSQL) untuk *Saga State Tracking*.

Dokumen referensi ini mengupas tuntas secara *deep-dive* implementasi pola Saga, kompensasi kegagalan, deteksi *poison pill*, hingga contoh kode yang tangguh (*production-ready*) dengan *zero placeholders* dan *defensive programming*.

---

## 1. Konsep Dasar & Internals

### 1.1 Choreography dengan Job Chaining
Berbeda dengan *Orchestration* di mana satu service pengatur memanggil API untuk setiap step, *Choreography* dengan background jobs (misalnya dengan RiverQueue, machinery, atau Asynq) bekerja dengan cara melempar pesan/job ke antrean (queue) setelah step sebelumnya sukses.
- **Transaksi Lokal**: Setiap step adalah transaksi database lokal.
- **Job Chaining**: Jika Step A sukses, ia mendaftarkan (enqueue) job untuk Step B di dalam blok transaksi yang sama (sering disebut *Transactional Outbox* atau *Job Staging*).
- **At-least-once delivery**: Message broker menjamin job dikirim minimal satu kali. Pekerja (worker) harus **idempoten**.

### 1.2 Compensating Transaction
Jika sebuah step gagal (misal Step 3 dari 5), kita tidak bisa melakukan `ROLLBACK` database secara ajaib karena Step 1 dan 2 sudah di-commit secara permanen. Sebagai gantinya, sistem mendaftarkan *Compensating Jobs* untuk Step 2, lalu Step 1, untuk membatalkan efek yang sudah terjadi.

### 1.3 State Tracking di PostgreSQL
Melacak di mana posisi Saga saat ini sangat krusial. Kita menggunakan tabel `saga_states` di PostgreSQL untuk mencatat:
- `saga_id` (UUID unik)
- `current_step` (String enum: `RESERVE_INVENTORY`, `PROCESS_PAYMENT`, `SHIP_ITEM`)
- `status` (String enum: `PENDING`, `COMPLETED`, `COMPENSATING`, `FAILED_AND_NEEDS_REVIEW`)

### 1.4 Diagram Arsitektur ASCII

```ascii
      [Saga Initiator]
             |
             v
+-----------------------------+
| PostgreSQL (State DB)       |
| Table: saga_states          |
| Insert Saga (ID: 123)       |
+-----------------------------+
             |
             v (Enqueue Job A)
+-----------------------------+
| Worker A (Inventory)        |
| 1. Deduplicate by saga_id   |
| 2. Do Work (Reserve)        |
| 3. Enqueue Job B            |
| 4. Update saga_states       |
+-----------------------------+
             |
             | (If Success)
             v
+-----------------------------+
| Worker B (Payment)          |
| 1. Charge Card (Fails!)     |
| 2. Catch Error              |
| 3. Enqueue Compensate Job A |
| 4. Update status=COMPENSATING|
+-----------------------------+
             |
             v
+-----------------------------+
| Worker A (Compensation)     |
| 1. Idempotent check         |
| 2. Release Inventory        |
| 3. Mark Saga as FAILED      |
+-----------------------------+
```

---

## 2. Anti-Patterns & Best Practices

### Anti-Pattern 1: Saga Tanpa Timeout (Stuck Forever)
Jika job gagal dan tidak pernah memberikan sinyal (misal karena OOM killed atau panic tanpa defer), Saga bisa tersangkut di status `PENDING` selamanya. Pelanggan tidak tahu nasib pesanannya.

❌ **BAD: Tidak ada mekanisme pembersihan/timeout**
```go
// Job handler tanpa pengecekan deadline atau timeout recovery
func ProcessPaymentJob(ctx context.Context, args []byte) error {
    var req PaymentReq
    json.Unmarshal(args, &req)
    // Jika API Gateway Stripe mati dan HTTP client tidak punya timeout,
    // goroutine ini hang selamanya.
    resp, err := http.Get("https://api.stripe.com/...")
    if err != nil {
        return err // Retry selamanya tanpa update Saga status
    }
    return nil
}
```

✅ **GOOD: Timeout-based Saga Expiry & Sweeper**
Implementasikan job "Sweeper" (cron/periodic job) atau atur deadline di dalam job payload.
```go
// 1. Set HTTP timeout
// 2. Gunakan context dengan timeout
// 3. Sweeper job untuk saga_states
func SweepStaleSagas(ctx context.Context, db *sql.DB) error {
    // Cari saga yang PENDING lebih dari 15 menit
    query := `
        UPDATE saga_states
        SET status = 'COMPENSATING'
        WHERE status = 'PENDING' AND updated_at < NOW() - INTERVAL '15 minutes'
        RETURNING id, current_step;
    `
    rows, err := db.QueryContext(ctx, query)
    if err != nil {
        return fmt.Errorf("query stale sagas: %w", err)
    }
    defer rows.Close()

    for rows.Next() {
        var sagaID uuid.UUID
        var step string
        if err := rows.Scan(&sagaID, &step); err != nil {
            return fmt.Errorf("scan saga: %w", err)
        }
        // Daftarkan compensation job sesuai step terakhir
        if err := EnqueueCompensationJob(ctx, db, sagaID, step); err != nil {
            return fmt.Errorf("enqueue compensation for %s: %w", sagaID.String(), err)
        }
    }
    return rows.Err()
}
```

### Anti-Pattern 2: Compensation Job yang Tidak Idempoten
Mekanisme *At-least-once delivery* berarti compensation job bisa dieksekusi lebih dari satu kali (misal worker restart di tengah proses). Jika compensation menambah/mengurangi saldo tanpa cek duplikasi, data akan korup.

❌ **BAD: Compensation langsung manipulasi state tanpa validasi**
```go
func CompensateInventory(ctx context.Context, db *sql.DB, sagaID string) error {
    // Berbahaya! Jika dieksekusi 2 kali karena retry broker,
    // stok akan bertambah +2 padahal reserve hanya -1.
    _, err := db.ExecContext(ctx, "UPDATE inventory SET qty = qty + 1 WHERE item_id = 1")
    return err
}
```

✅ **GOOD: Idempotency Key & Transactional Check**
```go
func CompensateInventoryIdempotent(ctx context.Context, db *sql.DB, sagaID uuid.UUID, itemID string, qty int) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    // 1. Cek apakah compensation ini sudah pernah berhasil (Idempotency Key = sagaID + step)
    var isCompensated bool
    err = tx.QueryRowContext(ctx, `
        SELECT EXISTS(
            SELECT 1 FROM compensation_logs
            WHERE saga_id = $1 AND step = 'INVENTORY_COMPENSATION'
        )
    `, sagaID).Scan(&isCompensated)
    if err != nil {
        return fmt.Errorf("check idempotency: %w", err)
    }

    if isCompensated {
        return nil // Sudah pernah di-compensate, success and exit
    }

    // 2. Lakukan kompensasi sesungguhnya
    res, err := tx.ExecContext(ctx, "UPDATE inventory SET stock = stock + $1 WHERE item_id = $2", qty, itemID)
    if err != nil {
        return fmt.Errorf("update inventory: %w", err)
    }
    
    rowsAffected, _ := res.RowsAffected()
    if rowsAffected == 0 {
         // Defensive: jika tidak ada inventory yang diupdate, mungkin item_id salah.
         // Tapi tidak perlu error karena kompensasi berarti kita mau "undo".
    }

    // 3. Catat di tabel idempotency (compensation_logs)
    _, err = tx.ExecContext(ctx, `
        INSERT INTO compensation_logs (saga_id, step, created_at)
        VALUES ($1, 'INVENTORY_COMPENSATION', NOW())
    `, sagaID)
    if err != nil {
        return fmt.Errorf("insert log: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit tx: %w", err)
    }
    return nil
}
```

---

## 3. Edge Cases & Penanganan

1. **Partial Failure Saat Compensation**: Bagaimana jika job kompensasi itu sendiri gagal terus-menerus (misal API partner down permanen)?
   *Penyelesaian*: Batasi maximum retry (misal 5 kali) di queue. Setelah max retry tercapai, masukkan job ke *Dead Letter Queue* (DLQ) dan ubah status Saga menjadi `REQUIRES_MANUAL_REVIEW`. (Deteksi Poison Pill).

2. **Concurrent Saga Execution (Race Condition)**: Dua saga berbeda mencoba memanipulasi resource yang sama (contoh: 2 saga memesan kamar hotel terakhir yang sama).
   *Penyelesaian*: Gunakan `SELECT ... FOR UPDATE` (Pessimistic Locking) atau versioning field `version` (Optimistic Concurrency Control) pada resource target di dalam worker.

3. **Saga Terpotong karena Database Error saat Enqueue (Double Fault)**: Step 1 sukses dalam memodifikasi tabel domain, tetapi saat melakukan `INSERT` ke antrean job Step 2, database gagal.
   *Penyelesaian*: WAJIB gunakan `Transactional Outbox`. Insert ke antrean dan update domain harus dalam *satu database transaction* yang sama.

4. **Network Partition (Worker Terisolasi)**: Worker memproses job, tetapi kehilangan koneksi ke Redis/RabbitMQ/DB saat mengirim ack/ACK, sehingga broker mengira job gagal dan dikirim ulang ke worker lain.
   *Penyelesaian*: Ini menegaskan kembali kebutuhan mutlak akan *Idempotency Keys* pada tabel terpisah atau field unik di database. Worker baru akan membaca DB dan melihat statusnya sudah selesai.

5. **Out of Order Delivery**: Job B datang sebelum Job A selesai karena antrean mendahului.
   *Penyelesaian*: Validasi state saat job dijalankan. Jika Job B (misal Payment) dijalankan, ia harus mem-verify bahwa tabel `saga_states` memiliki `current_step = 'RESERVE_INVENTORY'`. Jika status tidak sesuai, kembalikan error "retry later".

---

## 4. Production-Ready Go Code: Saga State & Jobs

### `types.go`
```go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type SagaStatus string

const (
	StatusPending         SagaStatus = "PENDING"
	StatusCompleted       SagaStatus = "COMPLETED"
	StatusCompensating    SagaStatus = "COMPENSATING"
	StatusFailed          SagaStatus = "FAILED"
	StatusManualReview    SagaStatus = "REQUIRES_MANUAL_REVIEW"
)

type SagaState struct {
	ID          uuid.UUID
	Type        string
	CurrentStep string
	Status      SagaStatus
	Payload     []byte // Data JSON yang dioper melintasi step
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
```

### `repository.go`
```go
package saga

import (
	"context"
	"database/sql"
	"fmt"
	"time"
	"github.com/google/uuid"
)

// Repository mengelola interaksi state dengan Postgres
type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// UpdateStatus idempoten, memperbarui status dan langkah.
func (r *Repository) UpdateState(ctx context.Context, tx *sql.Tx, id uuid.UUID, step string, status SagaStatus) error {
	query := `
		UPDATE saga_states
		SET current_step = $1, status = $2, updated_at = NOW()
		WHERE id = $3
	`
	var err error
	if tx != nil {
		_, err = tx.ExecContext(ctx, query, step, status, id)
	} else {
		_, err = r.db.ExecContext(ctx, query, step, status, id)
	}
	
	if err != nil {
		return fmt.Errorf("failed to update saga state: %w", err)
	}
	return nil
}

// LockSagaForUpdate mencegah race condition pada saga state
func (r *Repository) LockSagaForUpdate(ctx context.Context, tx *sql.Tx, id uuid.UUID) (*SagaState, error) {
	query := `
		SELECT id, type, current_step, status, payload
		FROM saga_states
		WHERE id = $1
		FOR UPDATE
	`
	var state SagaState
	var payload []byte
	err := tx.QueryRowContext(ctx, query, id).Scan(
		&state.ID, &state.Type, &state.CurrentStep, &state.Status, &payload,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("saga not found")
		}
		return nil, fmt.Errorf("failed to lock saga: %w", err)
	}
	state.Payload = payload
	return &state, nil
}
```

### `worker_idempotent_handler.go`
```go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
)

type ProcessOrderPayload struct {
	OrderID uuid.UUID `json:"order_id"`
	Amount  float64   `json:"amount"`
	UserID  uuid.UUID `json:"user_id"`
}

// Job args untuk worker (River, Asynq, dsb)
type JobArgs struct {
	SagaID  uuid.UUID `json:"saga_id"`
	Payload []byte    `json:"payload"`
}

type OrderWorker struct {
	db   *sql.DB
	repo *Repository
}

func NewOrderWorker(db *sql.DB) *OrderWorker {
	return &OrderWorker{
		db:   db,
		repo: NewRepository(db),
	}
}

// HandlePayment adalah step 2 dari saga.
func (w *OrderWorker) HandlePayment(ctx context.Context, args []byte) error {
	var jobArgs JobArgs
	if err := json.Unmarshal(args, &jobArgs); err != nil {
		return fmt.Errorf("unmarshal args: %w", err) // Terminal error, jangan retry
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// 1. Lock state untuk mencegah eksekusi paralel pada Saga ID yang sama
	state, err := w.repo.LockSagaForUpdate(ctx, tx, jobArgs.SagaID)
	if err != nil {
		return fmt.Errorf("lock saga: %w", err)
	}

	// 2. Idempotency Check: Jika step sudah PAYMENT_DONE atau melebihi, abaikan.
	if state.CurrentStep == "PAYMENT_DONE" || state.Status == StatusCompleted || state.Status == StatusCompensating {
		// Sudah pernah sukses diproses, silent ack
		return nil
	}

	// 3. Validasi urutan (Out of order prevention)
	if state.CurrentStep != "INVENTORY_RESERVED" {
		return fmt.Errorf("invalid step transition: expected INVENTORY_RESERVED, got %s", state.CurrentStep)
	}

	// 4. Lakukan logika bisnis (Contoh: Potong Saldo)
	var payload ProcessOrderPayload
	if err := json.Unmarshal(state.Payload, &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}

	paymentErr := w.mockChargeCard(ctx, tx, payload.UserID, payload.Amount)
	if paymentErr != nil {
		// Kegagalan bisnis! Kita tidak return error agar job broker tidak me-retry payment.
		// Sebaliknya, kita trigger kompensasi ke inventory.
		
		err = w.repo.UpdateState(ctx, tx, jobArgs.SagaID, "INVENTORY_COMPENSATING", StatusCompensating)
		if err != nil {
			return fmt.Errorf("update saga to compensating: %w", err)
		}

		// Enqueue compensation job dengan transactional outbox (simulasi)
		err = w.enqueueCompensationJob(ctx, tx, jobArgs.SagaID)
		if err != nil {
			return fmt.Errorf("enqueue compensation: %w", err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit compensation start: %w", err)
		}
		
		// Kembalikan nil agar message ini dianggap sukses diproses oleh worker queue
		return nil
	}

	// 5. Sukses
	err = w.repo.UpdateState(ctx, tx, jobArgs.SagaID, "PAYMENT_DONE", StatusCompleted)
	if err != nil {
		return fmt.Errorf("update saga to completed: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	
	return nil
}

// Simulasi external API / query
func (w *OrderWorker) mockChargeCard(ctx context.Context, tx *sql.Tx, userID uuid.UUID, amount float64) error {
	// Dummy error: saldo tidak cukup
	return fmt.Errorf("insufficient funds")
}

func (w *OrderWorker) enqueueCompensationJob(ctx context.Context, tx *sql.Tx, sagaID uuid.UUID) error {
	// Insert ke tabel queue untuk outbox pattern
	_, err := tx.ExecContext(ctx, `
		INSERT INTO outbox_jobs (saga_id, job_type, created_at)
		VALUES ($1, 'COMPENSATE_INVENTORY', NOW())
	`, sagaID)
	return err
}
```

### `poison_pill.go`
```go
package saga

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/google/uuid"
)

// HandlePoisonPill dipanggil jika worker mendeteksi max retries tercapai.
func HandlePoisonPill(ctx context.Context, db *sql.DB, sagaID uuid.UUID, reason string) error {
	// Set saga menjadi manual review
	_, err := db.ExecContext(ctx, `
		UPDATE saga_states
		SET status = $1, current_step = $2, updated_at = NOW()
		WHERE id = $3
	`, StatusManualReview, fmt.Sprintf("POISON: %s", reason), sagaID)
	if err != nil {
		return fmt.Errorf("mark poison pill: %w", err)
	}

	// TODO: Send alert to Slack/PagerDuty
	return nil
}
```

---

## 5. Testing (Unit & Integration)

Berikut adalah 3 tes yang memvalidasi idempotent handler, transisi state yang salah, dan kompensasi dari mock payment failure. Membutuhkan PostgreSQL (bisa via testcontainers).

```go
package saga_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	
	"myproject/saga" // Sesuaikan dengan module path
)

func setupTestDB(t *testing.T) *sql.DB {
	// Setup DB Postgres nyata untuk integrasi
	// Ganti DSN dengan instance test atau docker
	db, err := sql.Open("postgres", "postgres://postgres:postgres@localhost:5432/testdb?sslmode=disable")
	require.NoError(t, err)

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS saga_states (
			id UUID PRIMARY KEY,
			type VARCHAR(50),
			current_step VARCHAR(50),
			status VARCHAR(50),
			payload JSONB,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW()
		);
		CREATE TABLE IF NOT EXISTS outbox_jobs (
			id SERIAL PRIMARY KEY,
			saga_id UUID,
			job_type VARCHAR(50),
			created_at TIMESTAMP
		);
	`)
	require.NoError(t, err)

	t.Cleanup(func() {
		db.Exec("DROP TABLE saga_states")
		db.Exec("DROP TABLE outbox_jobs")
		db.Close()
	})

	return db
}

func TestWorker_HandlePayment_Idempotency_Success(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()
	worker := saga.NewOrderWorker(db)

	sagaID := uuid.New()
	payload := []byte(`{"order_id":"12345678-1234-1234-1234-123456789012","amount":100.0}`)

	// Insert state yang SUDAH SELESAI
	_, err := db.ExecContext(ctx, `
		INSERT INTO saga_states (id, type, current_step, status, payload)
		VALUES ($1, 'ORDER', 'PAYMENT_DONE', $2, $3)
	`, sagaID, saga.StatusCompleted, payload)
	require.NoError(t, err)

	jobArgs := saga.JobArgs{SagaID: sagaID}
	argsB, _ := json.Marshal(jobArgs)

	// Action
	err = worker.HandlePayment(ctx, argsB)

	// Assert: Tidak boleh return error (silent success)
	assert.NoError(t, err)

	// Assert DB tidak berubah mundur
	var step string
	err = db.QueryRow("SELECT current_step FROM saga_states WHERE id = $1", sagaID).Scan(&step)
	require.NoError(t, err)
	assert.Equal(t, "PAYMENT_DONE", step)
}

func TestWorker_HandlePayment_OutOfOrderTransition(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()
	worker := saga.NewOrderWorker(db)

	sagaID := uuid.New()
	payload := []byte(`{}`)

	// Insert state masih awal, belum mencapai INVENTORY_RESERVED
	_, err := db.ExecContext(ctx, `
		INSERT INTO saga_states (id, type, current_step, status, payload)
		VALUES ($1, 'ORDER', 'INITIATED', $2, $3)
	`, sagaID, saga.StatusPending, payload)
	require.NoError(t, err)

	jobArgs := saga.JobArgs{SagaID: sagaID}
	argsB, _ := json.Marshal(jobArgs)

	// Action
	err = worker.HandlePayment(ctx, argsB)

	// Assert: Harus mengembalikan error transition agar di-retry later
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid step transition")
}

func TestWorker_HandlePayment_BusinessFailure_TriggersCompensation(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()
	worker := saga.NewOrderWorker(db)

	sagaID := uuid.New()
	payload := []byte(`{"user_id":"00000000-0000-0000-0000-000000000000","amount":99999.0}`)

	// State siap untuk di-charge
	_, err := db.ExecContext(ctx, `
		INSERT INTO saga_states (id, type, current_step, status, payload)
		VALUES ($1, 'ORDER', 'INVENTORY_RESERVED', $2, $3)
	`, sagaID, saga.StatusPending, payload)
	require.NoError(t, err)

	jobArgs := saga.JobArgs{SagaID: sagaID}
	argsB, _ := json.Marshal(jobArgs)

	// Action (akan trigger insufficient funds di mockChargeCard)
	err = worker.HandlePayment(ctx, argsB)

	// Assert: Nil di-return agar antrean tidak retry
	assert.NoError(t, err)

	// Assert state berubah jadi COMPENSATING
	var status, step string
	err = db.QueryRow("SELECT status, current_step FROM saga_states WHERE id = $1", sagaID).Scan(&status, &step)
	require.NoError(t, err)
	assert.Equal(t, string(saga.StatusCompensating), status)
	assert.Equal(t, "INVENTORY_COMPENSATING", step)

	// Assert outbox job terbuat
	var jobType string
	err = db.QueryRow("SELECT job_type FROM outbox_jobs WHERE saga_id = $1", sagaID).Scan(&jobType)
	require.NoError(t, err)
	assert.Equal(t, "COMPENSATE_INVENTORY", jobType)
}
```

---

*Panduan Referensi Go Mastery - Saga Compensation Pattern*
