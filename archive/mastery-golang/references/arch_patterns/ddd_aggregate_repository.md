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
	"sync"
	"testing"
	"time"
)

// ==========================================
// 1. VALUE OBJECTS
// ==========================================
// Value object tidak memiliki identifier unik dan harus bersifat IMMUTABLE.

var (
	ErrCurrencyMismatch = errors.New("mata uang tidak cocok antar-operasi")
	ErrStaleVersion     = errors.New("versi agregat usang: ada yang menulis lebih dulu")
	ErrOrderNotFound    = errors.New("order tidak ditemukan")
)

// Money memakai SATUAN MINOR bertipe int64, bukan float64.
//
// Ini bukan detail gaya di berkas tentang DDD — Money adalah contoh unggulan
// Value Object di sini, dan uang berbasis float64 adalah anti-contoh kanonis
// DDD. Total() mengalikan harga dengan kuantitas lalu menjumlahkannya
// berulang; galat pembulatan float terakumulasi di setiap langkah, dan yang
// dihasilkan adalah nilai yang tidak bisa direkonsiliasi dengan pembukuan.
type Money struct {
	AmountMinor int64  // sen, fils, dsb.
	Currency    string
}

// Add mengembalikan Value Object BARU alih-alih memutasi m.
func (m Money) Add(other Money) (Money, error) {
	if m.Currency != other.Currency {
		return Money{}, ErrCurrencyMismatch
	}
	return Money{AmountMinor: m.AmountMinor + other.AmountMinor, Currency: m.Currency}, nil
}

// Kali mengalikan dengan bilangan bulat — operasi yang sah untuk uang.
// Perkalian dengan pecahan (pajak, diskon) WAJIB menyatakan pembulatannya
// secara eksplisit; ia tidak boleh muncul sebagai efek samping tipe data.
func (m Money) Multiply(n int64) Money {
	return Money{AmountMinor: m.AmountMinor * n, Currency: m.Currency}
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
//
// SELURUH field yang membawa invarian tidak diekspor — bukan hanya `items`.
//
// Versi sebelumnya mengenkapsulasi `items` lalu membiarkan `Status` dan
// `Version` terbuka, dan ujinya sendiri menulis `savedOrder.Status =
// StatusPaid` secara langsung. Konsekuensinya membatalkan seluruh tesis
// berkas ini: invarian "tidak boleh menambah item pada order yang sudah
// dibayar" ditegakkan di AddItem, tetapi siapa pun bisa mengembalikan Status
// ke Pending dan menembusnya. Enkapsulasi setengah bukan enkapsulasi — ia
// hanya memindahkan pintunya.
type Order struct {
	id        string
	status    OrderStatus
	items     []OrderItem
	version   int // optimistic locking; lihat Save
	createdAt time.Time
}

// Pembaca untuk keperluan di luar domain.
func (o *Order) ID() string           { return o.id }
func (o *Order) Status() OrderStatus  { return o.status }
func (o *Order) Version() int         { return o.version }
func (o *Order) CreatedAt() time.Time { return o.createdAt }

// TandaiDibayar adalah SATU-SATUNYA jalan menuju status PAID, dan ia
// membawa aturan transisinya sendiri.
func (o *Order) MarkAsPaid() error {
	if o.status != StatusPending {
		return fmt.Errorf("only PENDING orders can be marked as paid, current status: %s", o.status)
	}
	if len(o.items) == 0 {
		return errors.New("cannot pay for an order without items")
	}
	o.status = StatusPaid
	return nil
}

func (o *Order) Cancel() error {
	if o.status == StatusPaid {
		return errors.New("paid order cannot be canceled; issue a refund instead")
	}
	o.status = StatusCanceled
	return nil
}

// NewOrder bertindak sebagai Factory Method untuk menjamin inisiasi state yang valid.
func NewOrder(id string) (*Order, error) {
	if id == "" {
		return nil, errors.New("order ID cannot be empty")
	}
	return &Order{
		id:        id,
		status:    StatusPending,
		items:     make([]OrderItem, 0),
		version:   0,
		createdAt: time.Now().UTC(),
	}, nil
}

// AddItem adalah contoh perlindungan Invariant (aturan bisnis mutlak).
func (o *Order) AddItem(item OrderItem) error {
	if o.status != StatusPending {
		return fmt.Errorf("cannot add item to order with status: %s", o.status)
	}
	if item.Quantity <= 0 {
		return errors.New("item quantity must be greater than zero")
	}
	if item.Price.Currency == "" {
		return errors.New("item price must have a currency")
	}
	// Mata uang seluruh item WAJIB seragam. Tanpa penjagaan ini, invarian
	// baru gagal saat Total() dipanggil — jauh dari titik masuk datanya,
	// dan agregatnya sudah terlanjur berada di keadaan yang tidak sah.
	if len(o.items) > 0 && o.items[0].Price.Currency != item.Price.Currency {
		return fmt.Errorf("%w: order uses %s, item uses %s",
			ErrCurrencyMismatch, o.items[0].Price.Currency, item.Price.Currency)
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

// Total menyatukan perhitungan di satu pusat logika (Domain).
func (o *Order) Total() (Money, error) {
	if len(o.items) == 0 {
		// Mata uang TIDAK dipatok "USD".
		//
		// Versi sebelumnya mengembalikan Money{0, "USD"} untuk order kosong,
		// sehingga order kosong milik pedagang Indonesia melaporkan total
		// dalam dolar. Nol tanpa mata uang adalah nol; memberinya mata uang
		// yang salah menciptakan fakta yang tidak pernah benar.
		return Money{}, nil
	}

	total := Money{Currency: o.items[0].Price.Currency}
	for _, item := range o.items {
		var err error
		total, err = total.Add(item.Price.Multiply(int64(item.Quantity)))
		if err != nil {
			return Money{}, err
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
	// Mutex WAJIB. Versi sebelumnya memakai map telanjang: dua permintaan
	// yang bersamaan memanggil FindByID dan Save membuat runtime Go PANIC
	// dengan "concurrent map read and map write" — dan repositori adalah
	// justru komponen yang paling pasti diakses banyak goroutine sekaligus.
	mu sync.RWMutex
	db map[string]*Order
}

func NewInMemoryOrderRepository() *InMemoryOrderRepository {
	return &InMemoryOrderRepository{db: make(map[string]*Order)}
}

func copyOrder(o *Order) *Order {
	items := make([]OrderItem, len(o.items))
	copy(items, o.items)
	return &Order{
		id: o.id, status: o.status, items: items,
		version: o.version, createdAt: o.createdAt,
	}
}

func (r *InMemoryOrderRepository) FindByID(ctx context.Context, id string) (*Order, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()

	order, exists := r.db[id]
	if !exists {
		// Sentinel, bukan errors.New anonim: pemanggil perlu membedakan
		// "tidak ada" dari "penyimpanan bermasalah" untuk memetakannya ke 404.
		return nil, fmt.Errorf("%s: %w", id, ErrOrderNotFound)
	}
	return copyOrder(order), nil
}

// Save menegakkan OPTIMISTIC LOCKING.
//
// Field `version` sudah ada sejak versi sebelumnya, dengan komentar
// "Digunakan untuk Optimistic Locking" — dan tidak satu baris pun yang
// memakainya. Save menimpa apa pun yang ada di penyimpanan.
//
// Akibatnya adalah lost update yang klasik: dua permintaan memuat order yang
// sama, keduanya menambah item berbeda, keduanya Save, dan yang menulis
// terakhir menghapus pekerjaan yang pertama. Tidak ada galat, tidak ada
// gejala — item pelanggan hilang begitu saja. Field yang dideklarasikan
// untuk sebuah mekanisme tanpa mekanismenya lebih berbahaya daripada tidak
// ada: ia membuat pembaca yakin perlindungannya sudah terpasang.
func (r *InMemoryOrderRepository) Save(ctx context.Context, order *Order) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if saved, exists := r.db[order.id]; exists && saved.version != order.version {
		return fmt.Errorf("%w: order %s version %d, store is already at version %d",
			ErrStaleVersion, order.id, order.version, saved.version)
	}

	o := copyOrder(order)
	o.version++      // versi naik hanya bila penulisan benar-benar terjadi
	r.db[o.id] = o
	order.version = o.version // agregat di tangan pemanggil ikut maju
	return nil
}

// ==========================================
// 4. UNIT TEST
// ==========================================

func TestDDDAggregate_InvarianDanPersistensi(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryOrderRepository()

	order, err := NewOrder("ord-999") // galat konstruktor TIDAK dibuang
	if err != nil {
		t.Fatalf("NewOrder: %v", err)
	}
	priceUSD := Money{AmountMinor: 5_000, Currency: "USD"} // 50,00
	if err := order.AddItem(OrderItem{ID: "i-1", ProductID: "prod-x", Price: priceUSD, Quantity: 2}); err != nil {
		t.Fatalf("AddItem: %v", err)
	}

	total, err := order.Total()
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	// Perbandingan EKSAK; toleransi tidak diperlukan pada bilangan bulat.
	if total.AmountMinor != 10_000 {
		t.Errorf("total = %d, want 10000", total.AmountMinor)
	}

	if err := repo.Save(ctx, order); err != nil {
		t.Fatalf("Save: %v", err)
	}

	saved, err := repo.FindByID(ctx, "ord-999")
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if len(saved.Items()) != 1 {
		t.Errorf("item count = %d, want 1", len(saved.Items()))
	}

	// Invarian ditembus lewat METODE DOMAIN, bukan dengan menugaskan field.
	// Versi sebelumnya menulis `savedOrder.Status = StatusPaid` secara
	// langsung — yang justru membuktikan enkapsulasinya bocor.
	if err := saved.MarkAsPaid(); err != nil {
		t.Fatalf("MarkAsPaid: %v", err)
	}
	if err := saved.AddItem(OrderItem{ID: "i-2", Price: priceUSD, Quantity: 1}); err == nil {
		t.Error("adding item to PAID order should fail")
	}
}

// Lost update: dua penulis memuat versi yang sama, yang kedua WAJIB ditolak.
// Tanpa uji ini, field `version` tetap ada dan tetap tidak melakukan apa pun.
func TestSave_OptimisticLocking(t *testing.T) {
	ctx := context.Background()
	repo := NewInMemoryOrderRepository()

	order, err := NewOrder("ord-1")
	if err != nil {
		t.Fatalf("NewOrder: %v", err)
	}
	price := Money{AmountMinor: 1_000, Currency: "IDR"}
	if err := order.AddItem(OrderItem{ID: "a", Price: price, Quantity: 1}); err != nil {
		t.Fatalf("AddItem: %v", err)
	}
	if err := repo.Save(ctx, order); err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	writerA, err := repo.FindByID(ctx, "ord-1")
	if err != nil {
		t.Fatalf("FindByID A: %v", err)
	}
	writerB, err := repo.FindByID(ctx, "ord-1")
	if err != nil {
		t.Fatalf("FindByID B: %v", err)
	}

	if err := writerA.AddItem(OrderItem{ID: "b", Price: price, Quantity: 1}); err != nil {
		t.Fatalf("AddItem A: %v", err)
	}
	if err := repo.Save(ctx, writerA); err != nil {
		t.Fatalf("Save A: %v", err)
	}

	if err := writerB.AddItem(OrderItem{ID: "c", Price: price, Quantity: 1}); err != nil {
		t.Fatalf("AddItem B: %v", err)
	}
	if err := repo.Save(ctx, writerB); !errors.Is(err, ErrStaleVersion) {
		t.Fatalf("Save B = %v, want ErrStaleVersion (writer A work overwritten silently)", err)
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
