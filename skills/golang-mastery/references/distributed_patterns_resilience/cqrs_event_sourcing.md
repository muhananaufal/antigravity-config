# CQRS & Event Sourcing

## 1. Konsep & Internal

Aplikasi tradisional menggunakan satu model (entitas) yang sama untuk operasi *Read* (membaca) dan *Write* (menulis). Namun, seiring berkembangnya sistem, operasi baca (query) sering kali jauh lebih banyak (100:1) dibanding operasi tulis (command). Kebutuhan query sering kali kompleks (JOIN multi-table), sementara write harus cepat dan menjaga konsistensi data.

**CQRS (Command Query Responsibility Segregation)** memisahkan model aplikasi menjadi dua:
1. **Command Model**: Menangani aksi (*Create, Update, Delete*). Model ini berfokus pada validasi bisnis, invarian, dan menulis data secepat/sekonsisten mungkin.
2. **Query Model**: Menangani pencarian (*Read*). Data di-denormalisasi secara khusus (misal: disimpan dalam bentuk JSON dokumen, Elasticsearch, atau tabel *View*) agar query sangat cepat tanpa JOIN.

**Event Sourcing** sering dipasangkan dengan CQRS. Alih-alih menyimpan *state* akhir di database, kita menyimpan **daftar semua event/perubahan** yang pernah terjadi (*append-only* log). State saat ini didapat dengan me-*replay* event-event tersebut.

### Diagram Arsitektur (ASCII)

```ascii
                      [ Client ]
                        |  ^
                (POST)  |  | (GET)
              Command   |  |   Query
                +-------+  +------+
                v                 |
       +------------------+    +---------------+
       | Command API      |    | Query API     |
       +------------------+    +---------------+
                |                 ^
  (Validate &   |                 | (Read optimized view)
   Append Event)|                 |
                v                 |
       +------------------+    +-------------------+
       | Event Store      |    | Read DB / Elastic |
       | (Append-only)    |    | (Denormalized)    |
       +------------------+    +-------------------+
                |                      ^
                | (Event Bus / Broker) |
                +----------------------+
                 [ Event Projections ]
          (Worker yang meng-update Read DB)
```

## 2. Production-Ready Code

Contoh mengimplementasikan Event Store sederhana menggunakan Postgres dan *projection* asinkron untuk CQRS.

```go
package cqrs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// --- EVENT DEFINITIONS ---

type Event struct {
	ID            uuid.UUID `json:"id"`
	AggregateID   string    `json:"aggregate_id"`
	AggregateType string    `json:"aggregate_type"`
	EventType     string    `json:"event_type"`
	Payload       []byte    `json:"payload"`
	Version       int       `json:"version"`
	CreatedAt     time.Time `json:"created_at"`
}

type AccountCreatedPayload struct {
	OwnerName string `json:"owner_name"`
}

type MoneyDepositedPayload struct {
	Amount float64 `json:"amount"`
}

// --- COMMAND SIDE (Write Model) ---

type AccountAggregate struct {
	ID      string
	Balance float64
	Version int // Optimistic Concurrency
}

func (a *AccountAggregate) Apply(evt Event) error {
	switch evt.EventType {
	case "AccountCreated":
		var p AccountCreatedPayload
		_ = json.Unmarshal(evt.Payload, &p)
		a.ID = evt.AggregateID
	case "MoneyDeposited":
		var p MoneyDepositedPayload
		_ = json.Unmarshal(evt.Payload, &p)
		a.Balance += p.Amount
	}
	a.Version = evt.Version
	return nil
}

type EventStore struct {
	db *sql.DB
}

// SaveEvents menyimpan event dengan Optimistic Concurrency Control
func (es *EventStore) SaveEvents(ctx context.Context, aggregateID string, aggregateType string, expectedVersion int, events []Event) error {
	tx, err := es.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Validasi Version (Optimistic Lock)
	var currentVersion int
	err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(version), 0) FROM events WHERE aggregate_id = $1", aggregateID).Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	if currentVersion != expectedVersion {
		return fmt.Errorf("concurrency conflict: expected version %d but got %d", expectedVersion, currentVersion)
	}

	// 2. Insert Events
	for i, evt := range events {
		newVersion := expectedVersion + i + 1
		evt.Version = newVersion
		
		_, err = tx.ExecContext(ctx, `
			INSERT INTO events (id, aggregate_id, aggregate_type, event_type, payload, version, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			evt.ID, evt.AggregateID, evt.AggregateType, evt.EventType, evt.Payload, evt.Version, evt.CreatedAt)
		if err != nil {
			return fmt.Errorf("failed to save event %s: %w", evt.ID, err)
		}
	}

	return tx.Commit()
}

func (es *EventStore) LoadAggregate(ctx context.Context, id string) (*AccountAggregate, error) {
	rows, err := es.db.QueryContext(ctx, "SELECT id, aggregate_id, aggregate_type, event_type, payload, version, created_at FROM events WHERE aggregate_id = $1 ORDER BY version ASC", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	aggregate := &AccountAggregate{}
	count := 0
	for rows.Next() {
		var evt Event
		if err := rows.Scan(&evt.ID, &evt.AggregateID, &evt.AggregateType, &evt.EventType, &evt.Payload, &evt.Version, &evt.CreatedAt); err != nil {
			return nil, err
		}
		aggregate.Apply(evt)
		count++
	}

	if count == 0 {
		return nil, errors.New("aggregate not found")
	}
	return aggregate, nil
}

// DepositMoney adalah Command Handler
func DepositMoney(ctx context.Context, store *EventStore, accountID string, amount float64) error {
	if amount <= 0 {
		return errors.New("amount must be positive")
	}

	// 1. Replay events untuk membentuk state terbaru
	acc, err := store.LoadAggregate(ctx, accountID)
	if err != nil {
		return err
	}

	// 2. Validasi bisnis (contoh: max balance)
	if acc.Balance+amount > 1000000 {
		return errors.New("balance limit exceeded")
	}

	// 3. Hasilkan event baru
	payload, _ := json.Marshal(MoneyDepositedPayload{Amount: amount})
	newEvent := Event{
		ID:            uuid.New(),
		AggregateID:   accountID,
		AggregateType: "Account",
		EventType:     "MoneyDeposited",
		Payload:       payload,
		CreatedAt:     time.Now(),
	}

	// 4. Simpan (Write)
	return store.SaveEvents(ctx, accountID, "Account", acc.Version, []Event{newEvent})
}

// --- QUERY SIDE (Read Model Projection) ---

// ProjectionWorker membaca event baru secara asinkron dan membangun Read Model
func ProjectionWorker(ctx context.Context, db *sql.DB, readDB *sql.DB) {
	var lastProcessedVersion int

	// Loop polling (atau gunakan CDC / Postgres NOTIFY)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(1 * time.Second):
			// Ambil event terbaru yang belum diproses
			rows, err := db.QueryContext(ctx, "SELECT aggregate_id, event_type, payload, version FROM events WHERE version > $1 ORDER BY version ASC LIMIT 100", lastProcessedVersion)
			if err != nil {
				continue
			}
			
			for rows.Next() {
				var aggID, evType string
				var payload []byte
				var version int
				_ = rows.Scan(&aggID, &evType, &payload, &version)

				// Update tabel READ khusus untuk Query (Sangat cepat di-SELECT)
				if evType == "MoneyDeposited" {
					var p MoneyDepositedPayload
					json.Unmarshal(payload, &p)
					
					// Upsert logic ke tabel View Account
					readDB.ExecContext(ctx, "UPDATE account_views SET balance = balance + $1 WHERE id = $2", p.Amount, aggID)
				}
				lastProcessedVersion = version
			}
			rows.Close()
		}
	}
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan "State" di dalam Event Sourcing (Fat Events)
**Masalah**: *Payload* event mengandung seluruh *state* dari objek setelah perubahan, bukan hanya *delta*-nya (perubahan yang terjadi).
```json
// BAD: State Snapshot. Jika ini yang disimpan, ini CRUD biasa yang di-history-kan.
{
  "event_type": "UserUpdated",
  "payload": {
    "id": "123",
    "name": "Budi Baru", // Berubah
    "email": "budi@lama.com", // Tidak berubah
    "password_hash": "..." // Tidak berubah
  }
}
```
**Why dangerous:** Jika skema (*schema*) untuk *User* bertambah (misal kolom `phone`), Anda akan kesulitan mengatur *backward compatibility* pada ribuan *event* lama. Selain itu, *concurrent update* ke 2 field yang berbeda (misal Name dan Email di-*update* bersamaan) tidak bisa di-*merge* dan menyebabkan *race condition*.
**Solusi:** Event Sourcing harus berbasis *Delta* / *Intention*. (contoh: `UserNameChanged`, `UserEmailChanged`). Payload hanya berisi kolom yang berubah.

### ❌ Anti-Pattern 2: Sinkronisasi Read Model di dalam Transaksi Command
**Masalah**: *Command* menyimpan event di EventStore, lalu *langsung* melakukan query `UPDATE read_db_table ...` di dalam transaksi HTTP yang sama.
```go
// BAD: Synchronous Projection
store.SaveEvents(ctx, evt)
readStore.UpdateView(evt) // Blocking!
return c.JSON(200, "Success")
```
**Why dangerous:** Jika *Read Database* (*Elasticsearch* / MongoDB) melambat, maka sistem tulis (*Write API*) akan ikut terseret melambat (*Cascading Failure*). Ini merusak esensi C dan Q dari CQRS.
**Solusi:** Terapkan **Eventual Consistency**. Proyeksi ke model *Read* harus selalu dilakukan *Asynchronously* di *background worker*.

## 4. Edge Cases Spesifik

1. **Replay Time yang Lama (Snapshotting)**:
   Sebuah *Aggregate* Rekening Bank yang aktif bertahun-tahun mungkin memiliki jutaan `MoneyDeposited` *event*. Memanggil `LoadAggregate()` yang melakukan `SELECT` dan meloop jutaan *event* saat *User* mentransfer dana akan memakan waktu terlalu lama (Hit di atas 5 detik).
   *Penanganan*: Buat **Snapshotting**. Setiap 1.000 event, simpan hasil akhir `State` ke dalam tabel `snapshots`. Saat loading, sistem cukup mengambil 1 *Snapshot* terakhir, lalu me-*replay* *event* nomor 1.001 ke atas saja.

2. **Event Schema Evolution (Upcasting)**:
   Bagaimana jika kita menambah field wajib `currency` di payload `MoneyDeposited` setelah sistem berjalan 1 tahun? Event lama di dalam DB tidak memiliki field ini dan akan menyebabkan *Unmarshal Error*.
   *Penanganan*: Buat layer **Upcaster**. Saat *event* versi lama dibaca dari DB, sebelum di-*apply* ke *Aggregate*, program *middleware* akan menambahkan nilai `currency: "IDR"` (default) secara *on-the-fly*. Struktur *JSON* di *database* tidak pernah diubah (Immutability is sacred).

3. **Concurrency Conflict Saat Proyeksi Tertinggal**:
   Klien melakukan `POST /withdraw` dan mendapat *Success*. Namun karena *Eventual Consistency*, saat aplikasi *mobile* langsung me-*reload* saldo (*GET /balance* yang mengambil dari ReadDB), saldonya masih menampilkan angka lama. Klien panik dan menekan `withdraw` lagi.
   *Penanganan*: Klien (*frontend*) harus menyimpan *expected version* atau me-*mock* UI untuk sementara. Jika memungkinkan, *Query API* dapat menerima param `?min_version=10`, yang mana akan me-nge-*block* *request* (atau long-polling) sampai ReadDB ter-update hingga versi 10 sebelum menjawab.

## 5. Unit Tests (Behavioral Testing)

```go
package cqrs

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/DATA-DOG/go-sqlmock"
)

func TestAggregate_Apply(t *testing.T) {
	agg := &AccountAggregate{}
	
	// Replay 1: Create
	evt1 := Event{
		EventType: "AccountCreated",
		Payload:   []byte(`{"owner_name": "Alice"}`),
		Version:   1,
	}
	agg.Apply(evt1)
	
	if agg.Version != 1 {
		t.Fatalf("expected version 1, got %d", agg.Version)
	}

	// Replay 2: Deposit
	evt2 := Event{
		EventType: "MoneyDeposited",
		Payload:   []byte(`{"amount": 150.0}`),
		Version:   2,
	}
	agg.Apply(evt2)

	if agg.Balance != 150.0 {
		t.Fatalf("expected balance 150.0, got %f", agg.Balance)
	}
}

func TestEventStore_ConcurrencyConflict(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("an error '%s' was not expected when opening a stub database connection", err)
	}
	defer db.Close()

	store := &EventStore{db: db}
	ctx := context.Background()

	// Simulate current version in DB is 5
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT COALESCE").
		WithArgs("acc-123").
		WillReturnRows(sqlmock.NewRows([]string{"version"}).AddRow(5)) // Real version is 5
	mock.ExpectRollback() // Will rollback due to conflict

	// Attempt to save assuming expected version is 4 (Stale write attempt)
	events := []Event{{ID: uuid.New(), AggregateID: "acc-123"}}
	err = store.SaveEvents(ctx, "acc-123", "Account", 4, events)

	if err == nil {
		t.Fatal("expected concurrency error, got nil")
	}

	if !strings.Contains(err.Error(), "concurrency conflict") {
		t.Fatalf("expected concurrency conflict error, got: %v", err)
	}
}
```
