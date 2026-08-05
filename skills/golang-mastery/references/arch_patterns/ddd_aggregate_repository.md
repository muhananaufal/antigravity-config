# Domain-Driven Design (DDD), Aggregate, & Repository Pattern di Go

> **Berlaku:** Go 1.21+ · **Lihat juga:** `arch_patterns/clean_hexagonal_architecture.md` · `arch_patterns/cqrs_event_sourcing_impl.md` · `db_sqlc/acid_transactions_isolation.md` · `db_sqlc/query_optimization_n_plus_one.md`

## Konsep Utama dan Internal

Domain-Driven Design (DDD) adalah pendekatan pengembangan perangkat lunak yang menempatkan model domain dan aturan bisnis inti di jantung arsitektur. Di Go, implementasi DDD memfokuskan pada pemisahan state, pembatasan mutasi yang ketat, dan pengelolaan dependensi melalui interface. Tiga pilar taktis utamanya adalah:

1. **Aggregate & Aggregate Root**: Entitas utama yang bertindak sebagai *gatekeeper* atau penjaga gerbang. Seluruh objek turunannya (*Child Entities*) tidak boleh dipanggil dari luar (layar Usecase/Handler). Semua modifikasi dan mutasi data harus melalui metode yang diekspos oleh Aggregate Root demi menjaga *invariants* (aturan ketat bisnis yang harus konsisten).
2. **Value Object**: Objek yang dinilai murni dari isi propertinya (state). Objek ini tidak memiliki ID unik, bersifat *Immutable* (tidak bisa dimutasi). Operasi apa pun pada Value Object harus mengembalikan instance struct yang baru.
3. **Repository Pattern**: Lapisan abstraksi penyimpanan yang bertindak seolah-olah ia adalah sebuah "koleksi agregat di dalam memori". Repository menyembunyikan detail SQL/ORM/Driver. Aturan emas: **Satu Aggregate Root = Satu Repository**.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

Diagram di bawah mencontohkan alur eksekusi. Infrastruktur DB hanya bertindak sebagai penyimpanan persisten di bagian paling bawah rantai, sedangkan keputusan logis terjadi di dalam Domain Model yang terisolasi di memori.

```text
  [ Application Service / Usecase Layer ]
                 |
                 | (1. Fetch Aggregate via ID)
                 v
       [ OrderRepository Interface ] (Domain Layer)
                 |
                 | (2. Mengembalikan State *Order)
                 v
  [ Aggregate Root: Order ] ----> [ Value Object: Money, Custom Types ]
                 |
                 | (3. Eksekusi Business Logic & Validasi Invarian)
                 |   e.g., order.AddItem(item) -> Mengembalikan Error jika Status ditutup
                 v
  [ Application Service / Usecase Layer ]
                 |
                 | (4. Persistensi: Save Mutated Aggregate)
                 v
       [ OrderRepository Interface ]
                 |
                 | (5. Adapter menyelaraskan ke DB)
                 v
  [ Infrastructure: Postgres (pgx/gorm) ] ---> (SQL Data Mutated)
```

## Kode Go Production-Ready

Contoh berikut menunjukkan implementasi Order (Aggregate) dan Money (Value Object) dengan penanganan validasi bisnis murni di level Domain.

```go
package dddpatterns

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// ==========================================
// 1. VALUE OBJECTS
// ==========================================
// Value object tidak memiliki identifier unik dan harus bersifat IMMUTABLE.

var ErrCurrencyMismatch = errors.New("currency mismatch between operations")

type Money struct {
	Amount   float64
	Currency string
}

// Add mengembalikan struktur Value Object yang sepenuhnya baru alih-alih merubah nilai m yang ada.
func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, ErrCurrencyMismatch
	}
	return Money{
		Amount:   m.Amount + other.Amount,
		Currency: m.Currency,
	}, nil
}

// ==========================================
// 2. ENTITIES & AGGREGATE ROOT
// ==========================================
// Order adalah Aggregate Root. 
// Aturan: Layer Eksternal tidak boleh memutasi struct OrderItem secara langsung!

type OrderStatus string

const (
	StatusPending  OrderStatus = "PENDING"
	StatusPaid     OrderStatus = "PAID"
	StatusCanceled OrderStatus = "CANCELED"
)

// OrderItem adalah Child Entity di bawah Order (bukan Aggregate Root sendiri).
type OrderItem struct {
	ID        string
	ProductID string
	Price     Money
	Quantity  int
}

// Order merepresentasikan konsistensi data penuh (Aggregate Root).
type Order struct {
	ID        string
	Status    OrderStatus
	items     []OrderItem // DIENKAPSULASI: Unexported untuk mencegah manipulasi slice langsung.
	Version   int         // Digunakan untuk Optimistic Locking
	CreatedAt time.Time
}

// NewOrder bertindak sebagai Factory Method untuk menjamin inisiasi state yang valid.
func NewOrder(id string) (*Order, error) {
	if id == "" {
		return nil, errors.New("order ID cannot be empty")
	}
	return &Order{
		ID:        id,
		Status:    StatusPending,
		items:     make([]OrderItem, 0),
		Version:   0,
		CreatedAt: time.Now().UTC(),
	}, nil
}

// AddItem adalah contoh perlindungan Invariant (aturan bisnis mutlak).
func (o *Order) AddItem(item OrderItem) error {
	// Mencegah modifikasi data masa lalu (Invariant Check)
	if o.Status != StatusPending {
		return fmt.Errorf("cannot add items to order with status %s", o.Status)
	}
	if item.Quantity <= 0 {
		return errors.New("item quantity must be strictly greater than zero")
	}
	
	o.items = append(o.items, item)
	return nil
}

// Items mengekspos representasi items (Read-Only) sehingga pihak luar bisa melihatnya,
// tetapi modifikasi apa pun pada slice hasil return tidak akan mengubah aslinya.
func (o *Order) Items() []OrderItem {
	copied := make([]OrderItem, len(o.items))
	copy(copied, o.items)
	return copied
}

// Total menyatukan perhitungan kompleks di satu tempat pusat logika (Domain).
func (o *Order) Total() (Money, error) {
	if len(o.items) == 0 {
		return Money{Amount: 0, Currency: "USD"}, nil
	}
	
	total := Money{Amount: 0, Currency: o.items[0].Price.Currency}
	var err error
	for _, item := range o.items {
		itemTotal := Money{
			Amount:   item.Price.Amount * float64(item.Quantity),
			Currency: item.Price.Currency,
		}
		total, err = total.Add(itemTotal)
		if err != nil {
			return Money{}, err // Propagate mis-currency error
		}
	}
	return total, nil
}

// ==========================================
// 3. REPOSITORY (Port & Adapter)
// ==========================================

// OrderRepository adalah Port, wajib berada di Domain/Usecase Layer.
type OrderRepository interface {
	FindByID(ctx context.Context, id string) (*Order, error)
	Save(ctx context.Context, order *Order) error
}

// InMemoryOrderRepository adalah Adapter untuk simulasi.
// Di dunia nyata ini menggunakan gorm, sqlx, pgx, dll (berada di lapisan infrastruktur).
type InMemoryOrderRepository struct {
	db map[string]*Order
}

func NewInMemoryOrderRepository() *InMemoryOrderRepository {
	return &InMemoryOrderRepository{db: make(map[string]*Order)}
}

func (r *InMemoryOrderRepository) FindByID(ctx context.Context, id string) (*Order, error) {
	if order, exists := r.db[id]; exists {
		// KRUSIAL: Me-return Deep Copy struct untuk mencegah mutasi pointer acak di memori repository.
		copiedItems := make([]OrderItem, len(order.items))
		copy(copiedItems, order.items)
		
		o := &Order{
			ID:        order.ID,
			Status:    order.Status,
			items:     copiedItems,
			Version:   order.Version,
			CreatedAt: order.CreatedAt,
		}
		return o, nil
	}
	return nil, errors.New("order not found in repository")
}

func (r *InMemoryOrderRepository) Save(ctx context.Context, order *Order) error {
	// KRUSIAL: Simpan salinan struct (pass-by-value di background) agar modifikasi post-save tidak bocor
	o := *order
	
	copiedItems := make([]OrderItem, len(order.items))
	copy(copiedItems, order.items)
	o.items = copiedItems
	
	r.db[o.ID] = &o
	return nil
}

// ==========================================
// 4. UNIT TEST
// ==========================================

func TestDDDAggregate_InvariantsAndPersistence(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryOrderRepository()
	
	// 1. Instansiasi dan Mutasi Agregat 
	order, _ := NewOrder("ord-999")
	priceUSD := Money{Amount: 50.0, Currency: "USD"}
	item1 := OrderItem{ID: "i-1", ProductID: "prod-x", Price: priceUSD, Quantity: 2}
	
	// Memanggil metode bisnis (Behavior)
	if err := order.AddItem(item1); err != nil {
		t.Fatalf("unexpected err when adding item: %v", err)
	}

	// 2. Evaluasi Behavior Domain
	total, _ := order.Total()
	if total.Amount != 100.0 {
		t.Errorf("Expected total 100.0, got %v", total.Amount)
	}

	// 3. Persistensi ke Repositori
	repo.Save(ctx, order)

	// 4. Retrievabilitas dan Validasi
	savedOrder, err := repo.FindByID(ctx, "ord-999")
	if err != nil {
		t.Fatalf("failed to retrieve order: %v", err)
	}
	
	if len(savedOrder.Items()) != 1 {
		t.Errorf("expected 1 item, got %d", len(savedOrder.Items()))
	}

	// 5. Uji Kegagalan Invarian Bisnis (Validation Guard)
	savedOrder.Status = StatusPaid
	err = savedOrder.AddItem(OrderItem{ID: "i-2", ProductID: "prod-y", Price: priceUSD, Quantity: 1})
	if err == nil {
		t.Errorf("expected error when adding to non-pending order")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Anemic Domain Model (Model Domain Pucat/Kering)
Ini adalah praktik procedural murni yang merusak prinsip OOP dan enkapsulasi. Anda memperlakukan entitas Domain sekadar sebagai "gudang penampung field database".

```go
// ❌ BAD: Entitas hanya berisi data mentah tanpa tingkah laku (behavior).
type Order struct { // Hanya sekadar bag of getters/setters (Anemic)
	ID    string
	Total float64 
}

// Lalu semua logika berat diasingkan ke Usecase layer.
func (svc *OrderService) CalculateTotal(o *Order) float64 {
	var total float64
	for _, item := range o.Items { total += item.Price * item.Qty }
	o.Total = total // Logika perhitungan "merembes" dari Domain
	return total
}
```
**Why dangerous:** Logika bisnis yang tersebar di belasan file Service/Usecase menyulitkan Unit Testing karena Anda harus melacak keseluruhan state service. Reusabilitas hancur ketika komponen asinkron lain (misal RabbitMQ worker) ingin melakukan proses yang sama, ujung-ujungnya me-re-implement logic `CalculateTotal` dari nol.
**Solusi (Benar):** Pastikan Struct `Order` adalah sebuah *Rich Domain Model*. Tempatkan metode (method behavior) bersama dengan field data miliknya di dalam domain. Usecase layer HANYA bertugas sebagai orkestrator yang memanggil `o.CalculateTotal()`.

### ❌ Anti-Pattern 2: Aggregate Object Reference Lintas Bounded-Context
Di bahasa terkelola seperti Java (Hibernate), sangat lazim membiarkan sebuah Agregat berisi pointer instansiasi penuh ke agregat independen lainnya. Ini bertentangan keras dengan kaidah desain DDD.

```go
// ❌ BAD: Satu Aggregate memuat pointer ke Aggregate lain.
type Order struct {
	ID       string
	Customer *User // User adalah Aggregate terpisah dengan repository sendiri
}
```
**Why dangerous:** Menampung entitas penuh `*User` akan mengaburkan batas transaksional. Saat memanggil `OrderRepo.Save(o)`, apakah repositori tersebut juga memiliki tanggung jawab untuk menimpa perubahan pada record `User` ke database SQL? Jika ya, itu melanggar isolasi transaksi (cascade horror). Jika tidak, memory state menjadi palsu.
**Solusi (Benar):** Agregat hanya boleh mereferensikan Agregat Root lainnya secara halus **melalui ID-nya** (Identity Reference). Ubah menjadi:
`type Order struct { CustomerID string }`
Jika Usecase membutuhkan detail Customer, orkestrator yang bertugas menarik dari `UserRepository.Find(o.CustomerID)` setelah order dirender.

### ❌ Anti-Pattern 3: Unrestricted Slice Exposure
Slice di Go secara internal mengandung pointer ke blok memori array. Mengembalikan slice secara mentah dari *getter* Aggregate membuka celah kebocoran state mutasi.

```go
// ❌ BAD: Mengembalikan slice internal mentah ke pemanggil eksternal.
func (o *Order) Items() []OrderItem { return o.items } 
// Usecase: items := o.Items(); items[0].Quantity = 99999 (Mutasi di luar kendali agregat!)
```
**Why dangerous:** Siapa pun yang memanggil metode tersebut dapat mem-bypass validasi aturan domain (`AddItem()`) dengan memodifikasi isi *array index* di memori secara brutal, menembus dinding pertahanan enkapsulasi Agregat.
**Solusi (Benar):** Kembalikan iterasi Deep-Copy dari slice (seperti pada contoh kode production di atas) atau return tipe `Readonly` khusus.

## Edge Cases & Defensive Programming Konkrit

1. **Lost Updates dan Concurrency Data Overwrites:**
   Dua *goroutine* atau proses memuat (FindByID) order "ord-01" secara bersamaan di memori. Keduanya memodifikasi item (misal, admin A mengedit status dan user B merubah qty), lalu keduanya memanggil `Save()`. Pemanggilan mutakhir akan menimpa modifikasi proses lain secara merusak.
   *Defensive:* Implementasikan *Optimistic Locking* dengan field tipe int `Version` di Agregat. Repositori (Adapter DB) harus menghasilkan perintah SQL: 
   `UPDATE orders SET ... WHERE id = $1 AND version = $2`. Jika driver mengembalikan row count 0 karena field versi telah meleset, Repo harus mengembalikan custom error (misal `ErrConcurrentUpdate`), yang kemudian ditangkap oleh Usecase untuk meminta klien (Retry) atau menolak secara aman.

2. **Partial Object Retrieval pada Repository (Lazy Loading Bahaya):**
   Meningkatkan performa dengan hanya melakukan koneksi `SELECT id, status FROM orders` (membuang item) sering dilakukan oleh ORM untuk efisiensi (*partial loads*). 
   *Defensive:* Agregat **mutlak harus direkonstruksi secara utuh dan menyeluruh** sebelum diproses karena aturan bisnis sering memantulkan relasi inter-dependen objeknya. Jika Agregat `Order` butuh memanggil metode `.Total()`, ia akan `panic` atau salah menghitung total (0) karena layer SQL mengembalikan slice `.items` kosong akibat lazy loading. Jika load data berlebihan, berarti struktur Agregat terlalu besar (God Object) dan harus dipecah/diperamping.

3. **In-Memory Mock State Side-Effects di Testing (Go Map Pointers):**
   Repository in-memory memetakan dictionary map menggunakan pointer objek (`map[string]*Order`). Jika fungsi test mengubah struct agregat dan menolak memanggil `repo.Save(order)` karena ada error validasi di simulasi layer, namun secara sembunyi-sembunyi *pointer in-memory* tersebut mereferensi alamat memori absolut, state di "Mock DB" sudah ikut kotor (berubah state-nya) yang mana bisa merusak run TestSuite beruntun.
   *Defensive:* Metode mock `FindByID` dan `Save` WAJIB menduplikasi instance dengan pointer baru (Deep Copy/Marshal JSON ulang) sebelum me-return data ke pemanggil, menyimulasikan ketatnya deserialisasi driver Database aslinya.

## Kapan JANGAN Pakai Ini

- **Untuk domain yang sederhana dan stabil.** Ubiquitous language, aggregate, dan value object adalah alat untuk kompleksitas bisnis yang nyata. Pada CRUD, mereka hanya nama baru untuk hal lama — dan nama baru itu harus dipelajari setiap orang yang bergabung.
- **Aggregate yang terlalu besar.** Aggregate menentukan batas transaksi. Yang memuat ratusan entitas anak akan mengunci banyak baris sekaligus dan menjadi titik kontensi yang tidak terlihat sampai trafik naik.
- **Memuat seluruh aggregate untuk membaca satu field.** Repository yang selalu mengembalikan objek lengkap membuat query sederhana menjadi mahal. Sediakan jalur baca terpisah yang tidak melewati aggregate.
- **Repository yang membocorkan detail penyimpanan.** Metode bernama `FindByJSONBQuery` mengikat domain pada PostgreSQL, dan sejak saat itu batas yang Anda bangun tidak lagi ada.
- **Memaksa satu aggregate per transaksi ketika bisnis menuntut sebaliknya.** Aturan itu panduan, bukan hukum fisika. Bila dua aggregate memang harus berubah bersama dan keduanya berada di database yang sama, transaksi biasa lebih jujur daripada saga.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Kontensi lock pada baris tertentu | `pg_blocking_pids` | Aggregate terlalu besar; batas transaksinya melebar |
| Query sederhana memuat ratusan baris | jumlah baris per operasi baca | Semua baca melewati aggregate lengkap |
| Latensi tulis naik seiring pertumbuhan data | jumlah anak per aggregate | Aggregate tumbuh tanpa batas |
| Domain berubah setiap kali skema berubah | nama metode repository | Detail penyimpanan bocor ke domain |
| Saga dipakai untuk dua tabel di database yang sama | batas aggregate | Aggregate dipecah lebih halus dari yang dibutuhkan |

```sql
-- Aggregate raksasa terlihat sebagai satu induk dengan ribuan anak
SELECT induk_id, count(*) AS jumlah_anak
FROM item_pesanan GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Baris yang paling sering diperebutkan
SELECT bl.pid, left(bl.query,60), ka.pid AS pemblokir
FROM pg_stat_activity bl
JOIN pg_stat_activity ka ON ka.pid = ANY(pg_blocking_pids(bl.pid));
```

```bash
# Jumlah query database per operasi -- aggregate besar terlihat jelas di sini
curl -s "$JAEGER/api/traces?service=api&limit=20" \
  | jq '[.data[]|{t:.traceID,db:([.spans[]|select(.operationName|test("^db"))]|length)}]|sort_by(-.db)[:5]'
```
