# Transactional Outbox Pattern

## 1. Konsep & Internal

Dalam arsitektur *microservices* terdistribusi, sering kali satu *service* perlu mengubah *state* internalnya (menyimpan ke *database*) dan mempublikasikan notifikasi terkait perubahan tersebut ke sistem lain (mengirim *event* ke *message broker* seperti Kafka). 

Jika dilakukan secara bersamaan (Dual Write), akan muncul masalah **Inkonsistensi Data**:
- Jika *database commit* sukses, tapi publish ke Kafka gagal (timeout), sistem lain tidak tahu ada data baru.
- Jika publish ke Kafka sukses duluan, tapi *database commit* gagal (constraints error), sistem lain menerima *event* palsu.

**Transactional Outbox Pattern** menyelesaikan ini dengan memanfaatkan properti ACID dari *database relasional*. *Event* yang akan dipublikasikan disimpan ke dalam sebuah tabel khusus (`outbox_events`) di dalam transaksi *database* lokal yang **sama** dengan penyimpanan data utama.

Setelah transaksi *commit*, sebuah proses independen (*Relay Worker* atau *Debezium CDC*) akan secara asinkron membaca tabel outbox dan mempublikasikan pesannya ke *message broker* dengan jaminan pengiriman **at-least-once**.

### Diagram Arsitektur & Alur (ASCII)

```ascii
[ Service API / Domain Logic ]
         |
         | (1. Buka Transaksi Lokal)
         v
+-----------------------------+
|    RDBMS (PostgreSQL)       |
|-----------------------------|
| 1a. INSERT INTO users       |
| 1b. INSERT INTO outbox_evts |
| (Commit Atomik)             |
+-----------------------------+
         |
         | (2. Poller / CDC Tailer)
         v
[ Outbox Relay Worker ]
         |
         | (3. Publish Event via Network)
         v
[ Message Broker (Kafka) ] ----> [ Consumer (Harus Idempotent) ]
         |
         | (4. Hapus / Tandai Diproses)
         v
+-----------------------------+
| DELETE FROM outbox_evts     |
| WHERE id = X                |
+-----------------------------+
```

## 2. Production-Ready Code (PostgreSQL + pgx/v5)

Implementasi ini menggunakan paket `github.com/jackc/pgx/v5` untuk optimasi PostgreSQL. Pekerja outbox menggunakan fitur `FOR UPDATE SKIP LOCKED` yang sangat krusial untuk *concurrency* poller.

```go
package outbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Event merepresentasikan data yang disimpan di tabel outbox.
type Event struct {
	ID            uuid.UUID
	AggregateType string
	AggregateID   string
	EventType     string
	Payload       []byte
	CreatedAt     time.Time
}

// User adalah entitas domain utama.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// CreateUser mendaftarkan user baru dan menerbitkan event secara atomik.
func CreateUser(ctx context.Context, pool *pgxpool.Pool, email string) error {
	// Buka transaksi database
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	defer tx.Rollback(ctx) // No-op jika tx sudah di-commit

	userID := uuid.New().String()
	user := User{ID: userID, Email: email}

	// 1. Simpan Domain Entity
	_, err = tx.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, user.ID, user.Email)
	if err != nil {
		return fmt.Errorf("failed to insert user: %w", err)
	}

	// 2. Siapkan Payload Event
	payload, err := json.Marshal(user)
	if err != nil {
		return fmt.Errorf("failed to marshal event payload: %w", err)
	}

	// 3. Simpan ke Outbox dalam Transaksi yang Sama
	outboxID := uuid.New()
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload) 
		VALUES ($1, $2, $3, $4, $5)`,
		outboxID, "User", user.ID, "UserCreated", payload)

	if err != nil {
		return fmt.Errorf("failed to insert outbox event: %w", err)
	}

	// 4. Commit transaksi
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit tx: %w", err)
	}

	return nil
}

// MessagePublisher adalah interface untuk mempublikasikan pesan (misal ke Kafka).
type MessagePublisher interface {
	Publish(ctx context.Context, key string, payload []byte) error
}

// RelayWorker menarik data dari Outbox dan mengirimkannya ke broker.
func RelayWorker(ctx context.Context, pool *pgxpool.Pool, publisher MessagePublisher) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("Relay worker shutting down")
			return
		case <-ticker.C:
			if err := processOutboxBatch(ctx, pool, publisher); err != nil {
				log.Printf("Error processing outbox batch: %v", err)
			}
		}
	}
}

// processOutboxBatch memproses 1 batch event menggunakan SKIP LOCKED.
func processOutboxBatch(ctx context.Context, pool *pgxpool.Pool, publisher MessagePublisher) error {
	// Menggunakan transaksi untuk melakukan SKIP LOCKED
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin tx for relay: %w", err)
	}
	defer tx.Rollback(ctx)

	// AMBIL BATCH - KUNCI BARIS DENGAN SKIP LOCKED
	// Ini memungkinkan beberapa goroutine RelayWorker berjalan secara konkuren tanpa membaca data yang sama
	rows, err := tx.Query(ctx, `
		SELECT id, aggregate_type, aggregate_id, event_type, payload 
		FROM outbox_events 
		ORDER BY created_at ASC 
		LIMIT 50 
		FOR UPDATE SKIP LOCKED
	`)
	if err != nil {
		return fmt.Errorf("failed to query outbox: %w", err)
	}

	var events []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.AggregateType, &e.AggregateID, &e.EventType, &e.Payload); err != nil {
			rows.Close()
			return fmt.Errorf("failed to scan event: %w", err)
		}
		events = append(events, e)
	}
	rows.Close() // Wajib di-close sebelum exec delete

	if len(events) == 0 {
		return nil // Tidak ada data
	}

	// Publikasikan setiap event
	var processedIDs []uuid.UUID
	for _, e := range events {
		// EventType atau AggregateID biasa dijadikan partition key di Kafka
		err := publisher.Publish(ctx, e.AggregateID, e.Payload)
		if err != nil {
			// Jika gagal publish, hentikan pemrosesan sisa batch.
			// Event yang gagal (dan sisa batch) TIDAK di-append ke processedIDs.
			// Rollback akan melepas lock sehingga event ini akan diambil lagi di siklus polling berikutnya.
			log.Printf("Failed to publish event %s: %v", e.ID, err)
			break 
		}
		processedIDs = append(processedIDs, e.ID)
	}

	// Hapus hanya event yang SUKSES dipublikasikan
	if len(processedIDs) > 0 {
		// Menggunakan pgx.NamedArgs atau Any array untuk klausa IN
		_, err = tx.Exec(ctx, `DELETE FROM outbox_events WHERE id = ANY($1)`, processedIDs)
		if err != nil {
			return fmt.Errorf("failed to delete processed events: %w", err)
		}
	}

	// Commit transaksi penghapusan
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit relay tx: %w", err)
	}

	return nil
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Event Ke DB & Publish Ke Broker Secara Sekuensial (2PC Fallacy)
**Masalah**: Service melakukan commit data ke database, kemudian pada *flow* yang sama langsung memanggil `kafka.Produce()`.
```go
// BAD: Dual Write
tx.Commit()
// JIKA SERVER CRASH DISINI, EVENT HILANG SELAMANYA! Data di DB sudah tercommit.
kafkaPublisher.Publish(payload)
```
**Why dangerous:** Ini adalah penyebab utama inkonsistensi data di sistem terdistribusi. Tanpa mekanisme *recovery* atau re-try (Outbox), aplikasi lain tidak akan pernah menerima perubahan data jika *crash* atau pemadaman jaringan terjadi tepat di antara 2 operasi tersebut.
**Solusi:** Gunakan pola Outbox di mana *publish* dilakukan secara *asinkron* oleh komponen *Relay Worker* setelah DB tercommit.

### ❌ Anti-Pattern 2: Consumer Tidak Idempotent
**Masalah**: *Relay worker* berhasil melakukan `publisher.Publish()` ke Kafka, tapi *crash* atau *timeout* saat akan melakukan `DELETE FROM outbox_events`. Akibatnya, pada iterasi berikutnya, *worker* akan membaca dan me-*publish* event yang sama lagi (At-least-once delivery).

**Why dangerous:** Jika layanan penerima (consumer) langsung menambah saldo `$10` pada setiap event yang diterima tanpa validasi, pengiriman ulang (retry) akan mengakibatkan saldo ditambahkan `$20`, yang berarti *Data Loss* / kerugian finansial di pihak bisnis.

**Solusi:** Setiap pesan harus memiliki `ID` atau `IdempotencyKey` yang unik, dan penerima **wajib** mencatat ID tersebut di databasenya (dalam transaksi yang sama dengan operasi utamanya) untuk menolak pesan duplikat.

## 4. Edge Cases Spesifik

1. **Head of Line Blocking (Poller Macet)**:
   Jika terjadi gangguan saat mempublikasikan ke Kafka (misalnya broker lambat), `processOutboxBatch` akan gagal (`err != nil`) lalu melakukan `rollback` dan mencoba membaca baris yang **sama persis** di loop berikutnya. Jika event tertentu bermasalah (poison pill), ia akan memblokir semua event baru di belakangnya.
   *Penanganan*: Implementasikan mekanisme `retry_count` di tabel outbox. Jika `retry_count > 3`, pindahkan *event* ke tabel `dead_letter_outbox` dan lanjutkan pemrosesan agar antrean tidak macet total.

2. **Tabel Outbox Membengkak (Table Bloat)**:
   Karena *Relay* secara agresif melakukan `INSERT` dan `DELETE` terus menerus, tabel PostgreSQL akan mengalami pembengkakan (bloat) karena *dead tuples*. Proses ini dapat mengganggu *autovacuum* dan membuat *query* poller lambat.
   *Penanganan*: Pertimbangkan pola *Tombstone/Soft-Delete* dengan kolom `processed_at` di-set NULL lalu diubah ke *Timestamp*. Kemudian jalankan *cron job* saat *off-peak hours* untuk membersihkan row lama secara massal (`DELETE ... WHERE processed_at < NOW() - 1 DAY`). 

3. **Ordering Guarantees & Concurrency Constraint**:
   Penggunaan `FOR UPDATE SKIP LOCKED` memungkinkan multiple *worker pod* mengambil batch yang berbeda. Namun hal ini dapat memicu **out-of-order delivery** (Event ke-2 diproses Worker A yang lebih cepat daripada Event ke-1 di Worker B). 
   *Penanganan*: Jika *ordering* ketat wajib dijamin per-Aggregate, hanya gunakan **1 Relay Worker** (Single Leader Poller), atau beralih menggunakan sistem *Change Data Capture (CDC)* murni (contoh: Debezium) yang membaca secara sekuensial dari WAL (Write-Ahead Log) PostgreSQL.

## 5. Unit Tests (Behavioral Testing)

```go
package outbox

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MockPublisher menyimpan daftar pesan yang berhasil dipublish untuk validasi
type MockPublisher struct {
	PublishedEvents [][]byte
	ShouldFail      bool
}

func (m *MockPublisher) Publish(ctx context.Context, key string, payload []byte) error {
	if m.ShouldFail {
		return context.DeadlineExceeded // Simulasi network error
	}
	m.PublishedEvents = append(m.PublishedEvents, payload)
	return nil
}

// Catatan: Asumsi Test dijalankan di environment dengan database Postgres sungguhan
// (misal menggunakan Testcontainers)
func TestOutboxPattern_RelayWorkerRecovery(t *testing.T) {
	// Setup Postgres Pool menggunakan Testcontainer (pseudocode untuk brevity)
	// pool, err := setupTestPostgres()
	// defer pool.Close()
	
	// Gunakan var dummy agar compilable jika mock db diterapkan
	var pool *pgxpool.Pool 
	if pool == nil {
		t.Skip("Skipping test without postgres integration")
	}

	ctx := context.Background()
	_ = pool.QueryRow(ctx, "TRUNCATE outbox_events, users")

	// 1. Buat 2 event secara atomik
	err := CreateUser(ctx, pool, "user1@example.com")
	if err != nil {
		t.Fatalf("Failed to create user 1: %v", err)
	}
	err = CreateUser(ctx, pool, "user2@example.com")
	if err != nil {
		t.Fatalf("Failed to create user 2: %v", err)
	}

	publisher := &MockPublisher{ShouldFail: true}

	// 2. Simulasi percobaan publish gagal
	err = processOutboxBatch(ctx, pool, publisher)
	if err == nil {
		// Log error karena mock publisher harus return error
		t.Log("Expected batch to fail due to simulated network error")
	}

	// Verifikasi: Outbox events TIDAK terhapus karena transaksi rollback
	var count int
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM outbox_events").Scan(&count)
	if count != 2 {
		t.Fatalf("Expected 2 outbox events to remain, got %d", count)
	}
	if len(publisher.PublishedEvents) > 0 {
		t.Fatalf("No events should be fully committed as published")
	}

	// 3. Simulasi recovery (network pulih)
	publisher.ShouldFail = false
	err = processOutboxBatch(ctx, pool, publisher)
	if err != nil {
		t.Fatalf("Expected batch to succeed, got %v", err)
	}

	// Verifikasi: Events dipublish, tabel dibersihkan
	if len(publisher.PublishedEvents) != 2 {
		t.Fatalf("Expected 2 events published, got %d", len(publisher.PublishedEvents))
	}
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM outbox_events").Scan(&count)
	if count != 0 {
		t.Fatalf("Expected outbox to be empty after processing, got %d", count)
	}
}
```
