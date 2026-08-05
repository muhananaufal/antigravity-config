# Modular Monolith di Go

> **Berlaku:** Go 1.21+ · **Lihat juga:** `arch_patterns/clean_hexagonal_architecture.md` · `arch_patterns/event_driven_pubsub.md` · `engineering_practice/adr_decision_records.md` · `devops_control_planes/docker_container_go.md`

## Konsep Utama dan Internal Mendalam

Tren arsitektur sering memaksakan pengembang untuk segera memecah sistem menjadi ratusan wadah (containers) *Microservices* yang membengkakkan kompleksitas DevOps, latensi jaringan (RPC calls), dan observabilitas (distributed tracing) terlalu dini.

**Modular Monolith** memberikan kompromi *gold-ilock*: Seluruh aplikasi dikompilasi ke dalam satu entitas biner tunggal dan menempati satu proses memori, namun komponen-komponen logika bisnisnya (*Domains/Modules*) dipisahkan secara kedap/ketat selayaknya microservices mandiri. 

### 1. Mekanisme Kompilator Go (`internal/` directory)
Di ekosistem Go, hal ini difasilitasi dengan fitur brilian folder `internal/`. Folder `internal/` dijaga langsung oleh *Go compiler* (terutama `cmd/compile`) pada tahap *type-checking* dan *AST parsing*. Secara internal, compiler akan memeriksa *import path*; jika path mengandung elemen `internal`, maka pengimpor harus berakar dari pohon direktori yang sama dengan direktori induk dari `internal` tersebut. Pelanggaran akan memicu *compile-time error*: `use of internal package not allowed`. Komunikasi antar modul HANYA boleh melewati *Interface Facades* di luar folder internal. Hal ini mencegah terciptanya *Spaghetti Code / Big Ball of Mud* dan menjadikan pemecahan ke microservice fisik secara parsial sangat mudah bila lonjakan pengguna (scaling) di kemudian hari menuntutnya.

### 2. Memory Layout & Escape Analysis
Berbeda dengan microservices yang me-serialize data ke JSON/Protobuf (RPC), komunikasi antar modul dalam Modular Monolith adalah *in-process function calls*. Hal ini memungkinkan passing *pointers* dengan overhead eksekusi nol nanodetik. Namun, ini memicu *Escape Analysis* kompilator Go. Jika Modul A membuat struct dan memberikan pointernya ke Modul B (via antarmuka Facade), *Go compiler* akan menyimpulkan memori tersebut "escapes" ke scope lain, memindahkan alokasi dari *Stack* CPU (cepat) ke *Heap* (lambat), sehingga menambah beban *Garbage Collector (GC)*. Penggunaan *value semantics* (passing by value) via antarmuka modul sering disarankan untuk memaksimalkan performa *stack allocation*.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

```text
       [ HTTP / gRPC Router (main.go) ]  <-- The App Entrypoint
              |                    |
         (HTTP Req)           (HTTP Req)
              |                    |
              v                    v
  +--------------------+ +--------------------+
  |  Modul: BILLING    | |  Modul: INVENTORY  |
  |====================| |====================|
  | /pkg/billing       | | /pkg/inventory     |
  |   facade.go        | |   facade.go        |<-- Gerbang API (Interface)
  |--------------------| |--------------------|
  |  /internal/        | |  /internal/        |<-- TERKUNCI OLEH GO COMPILER!
  |     api/           | |     api/           |
  |     usecase/       | |     usecase/       |
  |     postgres/      | |     postgres/      |
  +--------------------+ +--------------------+
           |                        ^
           | (In-Memory Method Call)|
           +------------------------+
           Cross-Module Comms (Via Facade Interface)
           
  +-------------------------------------------+
  |              1 Shared Database            | (Tabel diisolasi per prefix, misal inv_items)
  +-------------------------------------------+
```

## Kode Go Production-Ready

Contoh berikut menunjukkan batasan modul dengan injeksi dependensi antar modul yang aman (komunikasi lewat memori, bukan HTTP/gRPC).

```go
package modularmonolith

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// =====================================
// MODUL INVENTORY (Facade Publik)
// File: pkg/inventory/facade.go
// =====================================

var ErrInsufficientStock = errors.New("insufficient stock for reservation")
var ErrItemNotFound = errors.New("item not found in inventory")

// InventoryFacade adalah kontrak publik yang boleh dipanggil modul lain.
// Harus tetap berukuran kecil (Interface Segregation Principle).
type InventoryFacade interface {
	ReserveStock(ctx context.Context, itemID string, quantity int) error
}

// =====================================
// MODUL INVENTORY (Internal Logics)
// File: pkg/inventory/internal/service.go
// =====================================
// Code di folder internal tak dapat diakses langsung oleh modul Billing!

type inventoryInternalService struct {
	mu    sync.RWMutex
	stock map[string]int
}

// NewInventoryModule adalah constructor registrasi pada level `main.go`.
func NewInventoryModule(initialStock map[string]int) InventoryFacade {
	if initialStock == nil {
		initialStock = make(map[string]int)
	}
	return &inventoryInternalService{
		stock: initialStock,
	}
}

// ReserveStock mengamankan I/O lintas Goroutine di satu proses yang sama.
func (s *inventoryInternalService) ReserveStock(ctx context.Context, itemID string, qty int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	current, exists := s.stock[itemID]
	if !exists {
		return fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
	}
	if current < qty {
		return fmt.Errorf("%w: requested %d, available %d", ErrInsufficientStock, qty, current)
	}

	s.stock[itemID] = current - qty
	return nil
}

// =====================================
// MODUL BILLING (Internal Logics)
// File: pkg/billing/internal/service.go
// =====================================

type BillingService struct {
	// Modul Billing menampung instance dari modul Inventory
	// Komunikasi ini berkecepatan RAM (nanodetik) tanpa TCP Overhead
	inventory InventoryFacade
}

func NewBillingModule(inv InventoryFacade) *BillingService {
	return &BillingService{inventory: inv}
}

// ProcessOrder menjalankan usecase utama lintas domain.
func (b *BillingService) ProcessOrder(ctx context.Context, itemID string, qty int) (string, error) {
	// 1. Koordinasi Modul 1 (Inventory) - Mutasi State
	if err := b.inventory.ReserveStock(ctx, itemID, qty); err != nil {
		// Logika kompensasi gagal jika terjadi penolakan
		return "", fmt.Errorf("billing failed due to inventory rules: %w", err)
	}

	// 2. Modul 2 (Billing) - Menyelesaikan Transaksi & State miliknya sendiri
	invoiceID := fmt.Sprintf("INV-%d", time.Now().UnixNano())
	
	return invoiceID, nil
}

// =====================================
// 4. UNIT TEST / INTEGRATION TEST (App Wiring & Mocks)
// =====================================

// Mocking Inventory untuk isolasi Unit Test Billing
type MockInventory struct {
	ReserveStockFunc func(ctx context.Context, itemID string, quantity int) error
}

func (m *MockInventory) ReserveStock(ctx context.Context, itemID string, quantity int) error {
	return m.ReserveStockFunc(ctx, itemID, quantity)
}

// Unit Test 1: Menguji domain Inventory secara murni (Isolasi)
func TestInventory_ReserveStock(t *testing.T) {
	inv := NewInventoryModule(map[string]int{"SKU-1": 10})
	
	err := inv.ReserveStock(context.Background(), "SKU-1", 5)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	
	err = inv.ReserveStock(context.Background(), "SKU-1", 10)
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("expected ErrInsufficientStock, got %v", err)
	}
}

// Unit Test 2: Menguji domain Billing - Berhasil menggunakan Mock
func TestBilling_ProcessOrder_Success(t *testing.T) {
	mockInv := &MockInventory{
		ReserveStockFunc: func(ctx context.Context, itemID string, quantity int) error {
			if itemID != "SKU-99" || quantity != 2 {
				return errors.New("unexpected args")
			}
			return nil
		},
	}
	
	billing := NewBillingModule(mockInv)
	invoice, err := billing.ProcessOrder(context.Background(), "SKU-99", 2)
	
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if invoice == "" {
		t.Fatalf("expected valid invoice string")
	}
}

// Unit Test 3: Menguji domain Billing - Gagal (Kompensasi flow) menggunakan Mock
func TestBilling_ProcessOrder_Fail(t *testing.T) {
	mockInv := &MockInventory{
		ReserveStockFunc: func(ctx context.Context, itemID string, quantity int) error {
			return ErrInsufficientStock
		},
	}
	
	billing := NewBillingModule(mockInv)
	_, err := billing.ProcessOrder(context.Background(), "SKU-99", 100)
	
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("expected error wrapping ErrInsufficientStock, got %v", err)
	}
}

// Integration Test 4: End-to-end Wiring Lintas Domain
func TestModularMonolith_CrossModuleFlow(t *testing.T) {
	ctx := context.Background()

	// 1. Setup DI / Wiring di Root App (`main.go` environment)
	inventoryModule := NewInventoryModule(map[string]int{"SKU-123": 10})
	billingModule := NewBillingModule(inventoryModule)

	// 2. Eksekusi End-to-End Success flow
	receipt, err := billingModule.ProcessOrder(ctx, "SKU-123", 4)
	if err != nil {
		t.Fatalf("Unexpected failure: %v", err)
	}
	if receipt == "" {
		t.Errorf("Expected valid receipt/invoice ID")
	}

	// 3. Eksekusi Flow Kegagalan Aturan Bisnis Lintas Domain
	_, err = billingModule.ProcessOrder(ctx, "SKU-123", 20) // Sisa stok: 6
	if !errors.Is(err, ErrInsufficientStock) {
		t.Errorf("Expected ErrInsufficientStock, got: %v", err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Spaghetti Imports Bypass dan Pelanggaran Akses Enkapsulasi
Golang secara default me-resolve import secara publik (huruf kapital). Tanpa restriksi *folder*, pengembang kerap kali mengabaikan API Facade dan langsung memanggil infrastruktur milik modul tetangganya demi "akses cepat".

```go
// ❌ BAD: Modul Billing langsung mengimpor Repositori Internal Modul Inventory 
import "myapp/pkg/inventory/repository"

func (b *BillingService) DoSth() {
    // Bypass Logic Usecase/Facade Inventory
    repository.PostgresInventoryDB.Exec("UPDATE stock SET ...") 
}
```
**Why dangerous:** Ini menciptakan sistem yang berpasangan secara masif (*High Coupling / Big Ball of Mud*). Jika modul inventory kemudian dipindahkan ke gRPC Microservice atau arsitekturnya dimodifikasi ke MongoDB, Modul Billing seketika meledak dengan *compilation errors*. 

```go
// ✅ GOOD: Komunikasi hanya via Facade Interface yang di-inject
type InventoryFacade interface {
    DeductStock(ctx context.Context, id string, qty int) error
}
// Billing hanya memanggil interface facade.go
b.inventory.DeductStock(ctx, itemID, qty)
```
**Solusi (Benar):** Simpan direktori implementasi internal `repository/` dan `usecase/` ke dalam hierarki khusus `pkg/inventory/internal/...`. Kompiler Go sendiri yang bertugas menampar (reject compile) siapa pun di luar domain `inventory` yang mencoba mencuri akses tersebut. Hanya berikan akses via antarmuka tunggal (`facade.go`).

### ❌ Anti-Pattern 2: Berbagi Tabel Database Lintas Modul (Database Coupling)
Modul dibagi rapi dalam layer kode secara isolasi, tetapi di balik layar Modul A langsung men-JOIN tabel Modul B menggunakan *Raw SQL Join*.

```go
// ❌ BAD: SQL raw join menembus dinding pembatas modul database
rows, _ := db.Query("SELECT b.id, i.name FROM bil_invoices b JOIN inv_items i ON b.item_id = i.id")
```
**Why dangerous:** Data Modul Inventory tidak lagi menjadi hak milik tunggal Modul Inventory. Hal ini menghalangi ekstrasi independen database; jika modul inventory dipisah ke server DB lain kelak, raw query `JOIN` Billing ini hancur total karena ketiadaan tabel lokal.

```go
// ✅ GOOD: In-Memory API Composition (Join di Aplikasi Go, bukan di DB)
// 1. Ambil data invoice dari DB Billing
invoices := b.repo.GetInvoices(ctx) 
// 2. Kumpulkan IDs
var itemIDs []string
for _, inv := range invoices { itemIDs = append(itemIDs, inv.ItemID) }
// 3. Panggil Modul Inventory via Facade In-Memory (Sangat cepat, 0 network latency)
itemsMetadata, _ := b.inventory.GetItemsMetadata(ctx, itemIDs)
// 4. Gabungkan di Go slice struct
```
**Solusi (Benar):** Modul harus mengontrol penuh skema tabel databasenya masing-masing (bisa disimulasikan menggunakan skema Postgres berlainan atau awalan penamaan khusus, e.g., `inv_table` vs `bil_table`). Lakukan **API Composition**: Billing men-kueri fakturnya sendiri, lalu memanggil fungsi In-Memory `inventory.GetItemsMetadata([]IDs)` via antarmuka interface Facade, lalu digabung di RAM.

### ❌ Anti-Pattern 3: Cyclic Dependency Antar Modul (A memanggil B, B memanggil A)
Desain terburuk di Golang adalah *import cycle*. Kompiler Go secara mendasar tidak mengizinkan ini dan akan langsung menolak build.

```go
// ❌ BAD: Modul Order memanggil Inventory, dan Inventory memanggil Order untuk report
import "myapp/pkg/inventory" // Di dalam modul Order
import "myapp/pkg/order"     // Di dalam modul Inventory
// Compile Error: import cycle not allowed
```
**Why dangerous:** Menciptakan deadlock kompilasi. Memaksa pengembang mem-bypass dengan interface `interface{}` kosong (untyped bypass) yang merusak Type Safety.

```go
// ✅ GOOD: Balikkan dependensi menggunakan Event Pub/Sub
// Inventory menerbitkan event tanpa peduli siapa yang mendengar
eventBus.Publish(InventoryDecreasedEvent{ItemID: "SKU-1"})

// Order (sebagai pendengar independen) memproses reportnya
func (o *OrderListener) Handle(event InventoryDecreasedEvent) {
    // Logic order here
}
```
**Solusi (Benar):** Terapkan pembalikan dependensi (*Dependency Inversion*) atau Event-Driven Pub/Sub. Modul Inventory tidak boleh mengimpor Order. Alih-alih, Inventory cukup me-lempar *event* asinkron menggunakan *Go channel* atau *in-memory event bus* (seperti Watermill), yang akan "didengarkan" (subscribed) oleh modul Order tanpa saling mengetahui implementasi konkret (Loose Coupling).

## Edge Cases & Defensive Programming Konkrit

1. **Distributed Transactions di Memori (Implementasi Saga Pattern):**
   Karena Modul A dan Modul B menggunakan koneksi / transaksi database (`*sql.Tx`) lokalnya masing-masing secara terpisah, properti konsistensi lintas-modul (ACID) hilang. Jika Billing berhasil menarik saldo dompet dari modul Payment, tapi reservasi ke Modul Inventory gagal karena stok kosong, saldo tersebut hangus tak tercatat.
   *Defensive:* Jangan mencoba mem-passing `*sql.Tx` lintasi batasan antarmuka modul. Implementasikan pola **Saga (Kompensasi)** in-process. Saat pemanggilan operasi sinkron modul dua gagal, modul satu HANYA bertanggung jawab untuk memanggil fungsi kompensator miliknya secara in-memory untuk membalikkan state.
   ```go
   // Contoh Implementasi Saga In-Memory
   func (o *OrderUsecase) Checkout(ctx context.Context) error {
       // 1. Modul Payment (Transaksi Sukses)
       txID, err := o.payment.Deduct(ctx, 1000) 
       
       // 2. Modul Inventory (Transaksi Gagal!)
       err = o.inventory.Reserve(ctx, "SKU-1")
       if err != nil {
           // SAGA COMPENSATING TRANSACTION: Revert Payment secara manual
           _ = o.payment.Refund(ctx, txID) // Fallback lokal yang cepat
           return fmt.Errorf("checkout failed, payment refunded: %w", err)
       }
       return nil
   }
   ```

2. **Propagasi Eventual melalui Pub/Sub Lokal (Goroutine Leak Prevention):**
   Pemanggilan in-memory facade bisa macet (bottleneck) jika lintas-koordinasi terlalu dalam (`Modul A -> Modul B -> Modul C -> Modul D`). Menahan respon HTTP User sembari modul D mengirim Email sangat rentan timeout.
   *Defensive:* Monolith modular dapat dan seharusnya mengaplikasikan arsitektur *Event Driven*. Gunakan `watermill/pubsub/gochannel` internal agar saat Modul A selesai (seperti User Terdaftar), ia mem-publish *memory event* yang membiarkan goroutine modul lain menangkapnya di latar belakang tanpa menunda waktu respon (RTT) request HTTP utama. Gunakan `context` untuk mencegah Goroutine leak.
   ```go
   // Event dispatcher sederhana bebas blocking
   func (e *EventBus) PublishOrderCreated(ctx context.Context, orderID string) {
       select {
       case e.orderChan <- orderID:
           // Diterima background worker modul lain
       case <-time.After(100 * time.Millisecond):
           // Handle buffer penuh (Backpressure), drop atau catat error
           log.Printf("EventBus backpressure limit reached for %s", orderID)
       case <-ctx.Done():
           return
       }
   }
   ```

3. **Injeksi Memori Lintas Goroutine (Pointer Race Conditions & Escape Analysis):**
   Tidak seperti arsitektur microservices asli via HTTP di mana objek direplikasi ulang (JSON marshaling), *Modular Monolith* mengoper struct data dalam bentuk _pointer RAM_. Modul A bisa me-request Data `*User` ke Modul B dan kemudian mengubah nilainya. Itu mengubah representasi *Cache* Modul B secara liar.
   *Defensive:* Jika mengoper object struct yang dapat dimutasi (slice/maps) melintasi dinding antarmuka Facade, fungsi origin Modul pengirim **Wajib** me-return _Deep Copy_ atau salinan alokasi data murni agar tidak termutasi oleh ulah goroutine pemanggil di luar batas modul (mengamankan Thread-Safety tanpa _panic race conditions_).
   ```go
   // ❌ BAD: Me-return referensi pointer asli (rentan dimutasi caller)
   func (s *UserService) GetUser(id string) *User {
       return s.cache[id] // Pointer aslinya bocor ke Modul lain!
   }
   
   // ✅ GOOD: Return value (Copy struct). Thread-safe & memaksa stack allocation
   func (s *UserService) GetUser(id string) User {
       return *s.cache[id] // Dereference pointer untuk membuat duplikat nilai
   }
   ```

## Kapan JANGAN Pakai Ini

- **Memecah menjadi layanan mikro sebelum batas modulnya terbukti stabil.** Batas yang salah di dalam satu proses adalah refactor sore hari; batas yang salah antar layanan adalah migrasi data, koordinasi lintas tim, dan API yang tidak bisa ditarik kembali.
- **Modul yang boleh saling mengimpor bebas.** Tanpa penegakan otomatis, "modular" hanya sebutan di README. Dalam enam bulan grafnya menjadi bola benang yang tidak bisa dipecah tanpa menulis ulang.
- **Satu database dengan semua modul berbagi tabel.** Itu menghapus batas yang paling penting. Pemisahan di kemudian hari berubah dari memindahkan kode menjadi migrasi data lintas sistem.
- **Sebagai alasan menunda observability per modul.** Modul yang tidak punya metrik dan trace sendiri tidak bisa dinilai kesiapannya untuk dipisah — Anda tidak tahu beban maupun ketergantungannya.
- **Memaksa semua modul memakai kedalaman arsitektur yang sama.** Modul dengan kompleksitas berbeda layak diperlakukan berbeda; keseragaman di sini menghasilkan pekerjaan tanpa manfaat pada modul yang sederhana.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Perubahan satu modul memecahkan modul lain | graf import antar modul | Batas sudah bocor |
| Tidak bisa menjawab "modul mana yang lambat" | metrik berlabel modul | Observability tidak sadar modul |
| Deploy satu modul memaksa deploy semuanya | struktur build | Itu memang sifat monolit — pastikan disengaja |
| Modul mengakses tabel milik modul lain | query per direktori modul | Batas data tidak ditegakkan |
| Import melingkar antar modul | `go list -deps` | Grafnya sudah tidak berbentuk pohon |

```bash
# Siapa mengimpor siapa antar modul -- ini peta batas yang sebenarnya
go list -deps ./internal/modul/... | grep 'internal/modul' | sort -u

# Modul yang menyentuh tabel milik modul lain
grep -rn 'FROM pesanan\|JOIN pesanan' --include='*.sql' internal/modul/ \
  | cut -d/ -f3 | sort -u

# Metrik berlabel modul: tanpa ini tidak ada dasar memutuskan pemisahan
curl -s localhost:9090/metrics | grep -oE 'modul="[a-z_]+"' | sort | uniq -c
```
