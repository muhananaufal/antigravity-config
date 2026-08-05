# CQRS & Event Sourcing Implementation di Go

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `distributed_patterns_resilience/cqrs_event_sourcing.md` · `arch_patterns/ddd_aggregate_repository.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md` · `db_sqlc/acid_transactions_isolation.md`

## Konsep Utama dan Internal

CQRS (Command Query Responsibility Segregation) adalah pola arsitektur yang memisahkan operasi pembacaan data (*Queries*) dari operasi penulisan atau mutasi state (*Commands*). Pemisahan ini memungkinkan kita untuk mengoptimalkan, menskalakan, dan memodelkan database baca (Read DB) secara independen dari database tulis (Write DB). 

CQRS paling kuat ketika digabungkan dengan **Event Sourcing (ES)**. Dalam sistem tradisional (CRUD), state aplikasi disimpan sebagai satu baris *current state* dalam tabel database, menimpa (overwrite) data lama. Dalam Event Sourcing, state *tidak pernah ditimpa*. Sebaliknya, setiap perubahan state disimpan sebagai aliran kejadian (stream of *Events*) yang bersifat *append-only* (hanya tambah). 
State terkini (*Snapshot/Current State*) direkonstruksi (rehydrate) di memori dengan memutar ulang (*replay*) seluruh event historis tersebut secara berurutan. Setiap kali event baru sukses disimpan, event tersebut di-publish ke message broker agar *Projection Worker* dapat memperbarui struktur tabel yang terdenormalisasi di *Read-Model* (untuk query super cepat).

Kelebihan:
- **Auditability absolut**: Tidak ada history data yang hilang. Sistem memiliki mesin waktu.
- **Asymmetric Scaling**: Jika rasio Query vs Command adalah 1000:1, kita bisa memperbanyak replica Read DB tanpa membebani Write DB.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

Diagram berikut menjelaskan siklus hidup sebuah perintah mulai dari klien hingga data terproyeksi ke sisi baca (Read Model) melalui proses eventual consistency.

```text
       [ UI / API Client ]
                | (1. HTTP POST: "DepositMoney")
                v
       +-------------------+
       |  Command Handler  | ----> (2. Validasi Bisnis Logic, Cek Invarian)
       +-------------------+
                | (3. Menghasilkan dan Menyimpan Event: "MoneyDeposited")
                v
+-----------------------------------+
|      Event Store (Write DB)       | (Append-Only Table: AggregateID, Version, EventData)
+-----------------------------------+
                |
                | (4. Publish Event secara Asinkron)
                v
+-----------------------------------+
| Message Broker (Kafka/RabbitMQ)   |
+-----------------------------------+
                |
                | (5. Consume Event)
                v
       +-------------------+
       | Projection Worker | ----> (6. Translate & Flatten event menjadi tabel relasional)
       +-------------------+
                |
                v
+-----------------------------------+
|       Read DB (Query DB)          | (Dioptimalkan untuk Query, misal: ElasticSearch/Postgres View)
+-----------------------------------+
                ^
                | (7. HTTP GET: "GetBalance" / Read Model)
       [ UI / API Client ]
```

## Kode Go Production-Ready

Implementasi riil CQRS/ES melibatkan Aggregate yang mampu me-rehydrate statenya sendiri (melalui metode `Apply`), Command Handler, serta abstraksi EventStore.

```go
package cqrses

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// ==========================================
// 1. EVENT DEFINITIONS (Domain Events)
// ==========================================
// Semua event bersifat Immutable (hanya mencatat masa lalu).

type Event interface {
	EventType() string
}

// Jumlah dalam SATUAN MINOR bertipe int64.
//
// Di event sourcing, uang berbasis float64 lebih berbahaya daripada di
// tempat lain: state tidak disimpan, ia DIHITUNG ULANG dengan memutar
// seluruh histori. Galat pembulatan tidak sekadar muncul sekali — ia
// terakumulasi di sepanjang ribuan event, dan saldo yang dibaca pengguna
// bergeser dari jumlah transaksinya tanpa satu pun baris kode yang salah.
type MoneyDeposited struct {
	AmountMinor int64
	Timestamp   time.Time
}

func (e MoneyDeposited) EventType() string { return "MoneyDeposited" }

type MoneyWithdrawn struct {
	AmountMinor int64
	Timestamp   time.Time
}

func (e MoneyWithdrawn) EventType() string { return "MoneyWithdrawn" }

// ==========================================
// 2. AGGREGATE ROOT (Write Model)
// ==========================================

var ErrInsufficientFunds = errors.New("insufficient funds")
var ErrInvalidAmount = errors.New("amount must be greater than zero")

var ErrEventTidakDikenal = errors.New("tipe event tidak dikenal saat replay")

type BankAccount struct {
	ID           string
	BalanceMinor int64
	Version      int // Optimistic Concurrency Control
}

// NewBankAccount menginisialisasi agregat kosong (sebelum direhydrate).
func NewBankAccount(id string) *BankAccount {
	return &BankAccount{ID: id}
}

// Apply memutar satu event ke dalam state. Ia tidak boleh memuat VALIDASI
// bisnis — masa lalu sudah terjadi dan tidak bisa ditolak.
//
// Tetapi ia WAJIB menolak event yang tidak dikenalnya, dan itu berbeda.
//
// Versi sebelumnya memakai switch tanpa cabang default: event bertipe asing
// hanya menaikkan Version tanpa mengubah saldo. Skenario yang menghasilkannya
// biasa terjadi — rollback deploy, atau satu replika tertinggal versi —
// dan akibatnya proses replay menghasilkan SALDO YANG SALAH tanpa satu pun
// galat. Di sistem event-sourced, diam adalah mode kegagalan terburuk:
// tidak ada state tersimpan yang bisa dibandingkan untuk menyadarinya.
func (a *BankAccount) Apply(event Event) error {
	switch e := event.(type) {
	case MoneyDeposited:
		a.BalanceMinor += e.AmountMinor
	case MoneyWithdrawn:
		a.BalanceMinor -= e.AmountMinor
	default:
		return fmt.Errorf("%w: %q pada agregat %s", ErrEventTidakDikenal, event.EventType(), a.ID)
	}
	a.Version++
	return nil
}

// Rehydrate memuat keseluruhan histori event untuk membangun state terkini.
func (a *BankAccount) Rehydrate(events []Event) error {
	for i, evt := range events {
		if err := a.Apply(evt); err != nil {
			return fmt.Errorf("replay event ke-%d: %w", i, err)
		}
	}
	return nil
}

// Withdraw mewakili COMMAND. Ia memvalidasi terhadap state terkini lalu
// MENGHASILKAN event, tanpa memutasi state secara langsung.
func (a *BankAccount) Withdraw(amountMinor int64) ([]Event, error) {
	if amountMinor <= 0 {
		return nil, ErrInvalidAmount
	}
	if a.BalanceMinor < amountMinor {
		return nil, ErrInsufficientFunds
	}
	return []Event{MoneyWithdrawn{AmountMinor: amountMinor, Timestamp: time.Now().UTC()}}, nil
}

// ==========================================
// 3. EVENT STORE (Write Infrastructure)
// ==========================================

// EventStore mendefinisikan kontrak persistensi append-only.
type EventStore interface {
	SaveEvents(ctx context.Context, aggregateID string, events []Event, expectedVersion int) error
	GetEvents(ctx context.Context, aggregateID string) ([]Event, error)
}

// InMemoryEventStore mensimulasikan database event (production = Postgres/EventStoreDB).
var ErrKonflikVersi = errors.New("konflik versi agregat")

type InMemoryEventStore struct {
	// Mutex WAJIB, dan alasannya lebih tajam dari sekadar "map tidak aman".
	//
	// Seluruh guna expectedVersion adalah menjaga penulisan BERSAMAAN. Tetapi
	// baca-periksa-tulis di SaveEvents tidak atomik tanpa kunci: dua goroutine
	// bisa sama-sama membaca currentVersion == 3, sama-sama lolos pemeriksaan,
	// lalu sama-sama menambahkan event. Mekanisme yang dirancang untuk
	// mencegah tulis-bersamaan justru tidak aman terhadap tulis-bersamaan —
	// dan sebelum itu, map telanjangnya sudah membuat runtime Go panic dengan
	// "concurrent map writes".
	mu     sync.RWMutex
	events map[string][]Event
}

func NewInMemoryEventStore() *InMemoryEventStore {
	return &InMemoryEventStore{events: make(map[string][]Event)}
}

func (s *InMemoryEventStore) SaveEvents(ctx context.Context, aggregateID string, events []Event, expectedVersion int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if versiKini := len(s.events[aggregateID]); expectedVersion != versiKini {
		return fmt.Errorf("%w: agregat %s diharapkan versi %d, penyimpanan di versi %d",
			ErrKonflikVersi, aggregateID, expectedVersion, versiKini)
	}
	s.events[aggregateID] = append(s.events[aggregateID], events...)
	// Di sistem nyata: picu Transactional Outbox di transaksi yang SAMA.
	return nil
}

func (s *InMemoryEventStore) GetEvents(ctx context.Context, aggregateID string) ([]Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	// SALINAN, bukan slice internal.
	//
	// Versi sebelumnya mengembalikan slice milik store apa adanya, sehingga
	// pemanggil bisa menimpa elemennya — pada penyimpanan yang seluruh
	// jaminannya adalah APPEND-ONLY. Histori yang bisa diubah pemanggil
	// bukan histori.
	asli := s.events[aggregateID]
	return append([]Event(nil), asli...), nil
}

// ==========================================
// 4. UNIT TEST (Siklus Penuh)
// ==========================================

func TestBankAccount_CQRS(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryEventStore()
	accountID := "acc-123"

	// --- 1. SETUP INITIAL STATE (Simulasi kejadian masa lalu) ---
	// Akun dibuat dan didepositkan 100 secara paralel tanpa logic command
	initialEvents := []Event{
		MoneyDeposited{AmountMinor: 10_000, Timestamp: time.Now()}, // 100,00
	}
	if err := store.SaveEvents(ctx, accountID, initialEvents, 0); err != nil {
		t.Fatalf("failed to setup initial state: %v", err)
	}

	// --- 2. COMMAND HANDLING CYCLE ---
	
	// A. Muat event history dari EventStore
	history, err := store.GetEvents(ctx, accountID)
	if err != nil {
		t.Fatalf("failed to fetch history: %v", err)
	}

	// B. Rehydrate state aggregate (Rebuild current state)
	account := NewBankAccount(accountID)
	// Galat Rehydrate TIDAK dibuang: replay yang menemui event tak dikenal
	// menghasilkan saldo yang salah, dan itu harus menghentikan proses —
	// bukan berlanjut diam-diam.
	if err := account.Rehydrate(history); err != nil {
		t.Fatalf("Rehydrate: %v", err)
	}

	if account.Version != 1 {
		t.Errorf("versi = %d, mau 1", account.Version)
	}
	if account.BalanceMinor != 10_000 {
		t.Errorf("saldo = %d, mau 10000", account.BalanceMinor)
	}

	// C. Eksekusi Business Logic Command (penarikan 40,00)
	newEvents, err := account.Withdraw(4_000)
	if err != nil {
		t.Fatalf("Unexpected withdraw error: %v", err)
	}

	// D. Simpan Event Baru dengan verifikasi Concurrency (Expected Version: 1)
	err = store.SaveEvents(ctx, accountID, newEvents, account.Version)
	if err != nil {
		t.Fatalf("Failed to save new events: %v", err)
	}

	// --- 3. TEST INVARIANT PROTECTION ---
	
	// Coba withdraw melebihi saldo baru (60)
	if err := account.Rehydrate(newEvents); err != nil {
		t.Fatalf("Rehydrate event baru: %v", err)
	}
	if _, err := account.Withdraw(99_900); !errors.Is(err, ErrInsufficientFunds) {
		t.Errorf("galat = %v, mau ErrInsufficientFunds", err)
	}
}

// eventAsing meniru event yang diterbitkan versi kode LEBIH BARU.
type eventAsing struct{}

func (eventAsing) EventType() string { return "FiturBaruDeposit" }

// Replay yang menemui event tak dikenal WAJIB gagal keras.
//
// Skenarionya biasa: satu replika di-rollback, atau deploy bergulir belum
// selesai. Tanpa cabang default di Apply, event itu hanya menaikkan versi
// tanpa mengubah saldo — dan yang dibaca pengguna adalah saldo yang salah,
// tanpa satu pun galat di mana pun.
func TestRehydrate_EventTakDikenalDitolak(t *testing.T) {
	akun := NewBankAccount("acc-x")
	err := akun.Rehydrate([]Event{
		MoneyDeposited{AmountMinor: 5_000},
		eventAsing{},
	})
	if !errors.Is(err, ErrEventTidakDikenal) {
		t.Fatalf("galat = %v, mau ErrEventTidakDikenal", err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Memutasi State Langsung di Dalam Fungsi Command
Ini adalah kesalahan paling fatal di Event Sourcing yang merusak determinisme.

```go
// ❌ BAD: Memutasi properties aggregate sebelum event benar-benar tersimpan.
func (a *BankAccount) Withdraw(amount float64) ([]Event, error) {
    if a.Balance < amount { return nil, errors.New("insufficient") }
    
    // FATAL MISTAKE: Mutasi state langsung di dalam method Command
    a.Balance -= amount 
    
    event := MoneyWithdrawn{Amount: amount}
    return []Event{event}, nil
}
```
**Why dangerous:** Fungsi command (`Withdraw`) mungkin gagal saat diproses di *layer persistence* (misal timeout koneksi). Jika Anda sudah terlanjur merubah `a.Balance -= amount` di memori, state agregat yang ter-*cache* menjadi *out-of-sync* (cacat) dengan state sebenarnya di database. State aplikasi HANYA boleh berubah melalui mutasi replikatif di dalam metode `Apply(Event)`.

### ❌ Anti-Pattern 2: Menaruh Eksekusi Eksternal (Side-Effects) di Dalam Fungsi `Apply`
Pemula sering meletakkan pemanggilan API ke sistem eksternal di dalam siklus *replay/apply*.

```go
// ❌ BAD: Menambahkan efek samping (HTTP/RPC call) ke dalam fungsi Apply event.
func (a *BankAccount) Apply(event Event) {
    switch e := event.(type) {
    case MoneyDeposited:
        a.Balance += e.Amount
        // FATAL: Mengirim email selamat setiap kali event di-replay!
        sendEmailService.NotifyUser(a.ID, "Deposit Success!") 
    }
}
```
**Why dangerous:** Saat agregat dimuat ulang (rehydrate) dari database, ribuan *event* historis akan diputar ulang secara bertahap. Jika Anda menaruh *side effect* (mengirim email, memanggil *payment gateway*) di dalam `Apply`, sistem Anda akan membombardir pihak ketiga (spamming) miliaran kali di runtime. `Apply` harus merupakan **Pure Function** tanpa I/O. Efek samping harus ditangani oleh *Event Handlers / Projections* yang terpisah.

### ❌ Anti-Pattern 3: Mengubah Skema/Struktur Field Event (Broken Poison Pill)
Event Store adalah *single source of truth*. Struktur event JSON di dalam database bersifat permanen.

```go
// ❌ BAD: Mengubah tipe data atau menghapus field di versi Go terbaru.
// Versi Lama: type UserCreated struct { Address string }
// Versi Baru (merusak format):
type UserCreated struct { 
    Address struct { City, Zip string } // Tipe data berubah drastis!
}
```
**Why dangerous:** Ketika sistem mencoba *unmarshal* event `UserCreated` dari database (yang disimpan tahun 2021) menggunakan struktur struct versi 2026 yang dirombak, proses *json.Unmarshal* akan `panic` atau gagal (menjadi *poison pill*). Akibatnya, Agregat tidak akan pernah bisa di-*rehydrate* lagi dan mati total. **Solusi (Benar):** Lakukan *Event Versioning* (buat struct `UserCreatedV2`) atau implementasikan custom upcaster JSON unmarshal yang mengkonversi event v1 menjadi struktur v2 secara *on-the-fly* pada saat memuat (read) dari DB.

## Edge Cases & Defensive Programming Konkrit

1. **Optimistic Concurrency Control Lintas Transaksi (Lost Update):**
   Dua *HTTP requests* masuk paralel untuk satu rekening, keduanya me-rehydrate pada Versi ke-5. Request pertama berhasil melakukan withdraw, sehingga Versi DB menjadi 6. Request kedua yang tidak sadar state telah berubah, juga mencoba menyimpan kalkulasinya menggunakan Versi 5.
   *Defensive:* Terapkan Optimistic Locking dengan parameter `ExpectedVersion` secara mutlak pada kueri basis data. Jika database menolak dengan constraint (`WHERE aggregate_id=? AND version=5`), kembalikan error `ConcurrencyException`, batalkan transaksi, lalu ulangi siklus Command dari awal (rehydrate ulang) di layer HTTP.

2. **Performa Replay Event Mencekik CPU dan RAM (Snapshotting):**
   Agregat berumur 5 tahun seperti "Keranjang Belanja Instansi" mungkin memiliki 50,000 *events*. Memuat dan me-replay 50 ribu struct hanya untuk mengeksekusi 1 command akan menghancurkan latensi aplikasi (bisa memakan >500ms dan I/O tinggi).
   *Defensive:* Implementasikan pola *Snapshotting*. Setelah setiap $N$ events (misalnya kelipatan 100), asinkron job menyimpan status penuh (serialize state) agregat tersebut ke dalam koleksi khusus Snapshot dengan stempel nomor versi. Saat memuat data, sistem mengambil snapshot teratas (misal versi 49,900) untuk memulai (baseline), lalu HANYA me-replay sisa *events* (versi 49,901 s/d 50,000).

3. **Eventual Consistency Projection Lag pada UI/UX:**
   Klien mengklik "Checkout/Withdraw", lalu di-redirect kembali ke halaman Beranda ("GetBalance"), namun uang yang tampil belum berkurang (karena delay asinkron 50ms di Kafka/Read Projection). Pengguna mengira gagal, lalu mengklik "Checkout" lagi dua kali.
   *Defensive:* Dalam DDD CQRS, atasi ini via optimisasi *Optimistic UI Update* di frontend (simulasikan mutasi UI sebelum API merespons), atau, biarkan API `Withdraw` mengembalikan Token/Versi mutasi (misal `CommandID: 123`). UI kemudian melakukan *short-polling* ke sisi Read-DB untuk mengecek apakah `LastProcessedCommandID == 123`. Selama Read-DB belum *up-to-date*, tampilkan indikator "Sedang Memproses" (Loading State).

## Kapan JANGAN Pakai Ini

- **Menyimpan event sebagai JSON tanpa nomor versi skema.** Deserialisasi event lama akan gagal begitu strukturnya berubah, dan data yang sudah tertulis tidak bisa diperbaiki — ia adalah fakta historis. Versi skema WAJIB ada sejak event pertama.
- **Membangun read model secara sinkron di dalam transaksi tulis.** Itu membuang seluruh alasan memisahkan sisi baca, dan satu proyeksi yang lambat memperlambat setiap penulisan di sistem.
- **Tanpa snapshot untuk agregat berumur panjang.** Memuat 200.000 event untuk merekonstruksi satu agregat mengubah operasi sederhana menjadi hitungan detik — dan itu memburuk setiap hari.
- **Memakai event store sebagai antrean pesan untuk konsumer eksternal.** Event domain internal berubah mengikuti kebutuhan domain; konsumer eksternal membutuhkan kontrak yang stabil. Terbitkan event integrasi yang terpisah.
- **Menyunting event yang sudah tertulis.** Koreksi dilakukan dengan menambahkan event kompensasi. Menyunting riwayat menghancurkan satu-satunya jaminan yang membuat event sourcing berharga.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Memuat agregat makin lambat tiap bulan | jumlah event per agregat | Tidak ada snapshot |
| Deserialisasi gagal untuk event lama | versi skema di payload | Skema berubah tanpa jalur migrasi |
| Latensi tulis mengikuti latensi proyeksi | apakah proyeksi sinkron | Read model dibangun di dalam transaksi tulis |
| Konsumer eksternal rusak saat refactor domain | jenis event yang dipublikasikan | Event domain dipakai sebagai kontrak eksternal |
| Rebuild proyeksi memakan waktu berjam-jam | posisi awal rebuild | Selalu diputar dari event pertama |

```sql
-- Agregat dengan riwayat terpanjang: kandidat snapshot paling mendesak
SELECT agregat_id, count(*) AS jumlah_event, max(versi) AS versi
FROM event_store GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Sebaran versi skema event: yang lama masih dibaca sampai kapan pun
SELECT jenis_event, versi_skema, count(*) FROM event_store GROUP BY 1,2 ORDER BY 1,2;

-- Lag tiap proyeksi
SELECT nama_proyeksi, posisi_terakhir, now() - diperbarui_pada AS lag
FROM proyeksi_checkpoint ORDER BY lag DESC;
```
