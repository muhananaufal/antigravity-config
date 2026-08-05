# Modular Monolith di Go

> **Berlaku:** Go 1.21+ · **Lihat juga:** `arch_patterns/clean_hexagonal_architecture.md` · `arch_patterns/event_driven_pubsub.md` · `engineering_practice/adr_decision_records.md` · `devops_control_planes/docker_container_go.md`

## Konsep Utama dan Internal Mendalam

Tren arsitektur sering memaksakan pengembang untuk segera memecah sistem menjadi ratusan wadah (containers) *Microservices* yang membengkakkan kompleksitas DevOps, latensi jaringan (RPC calls), dan observabilitas (distributed tracing) terlalu dini.

**Modular Monolith** memberikan kompromi *gold-ilock*: Seluruh aplikasi dikompilasi ke dalam satu entitas biner tunggal dan menempati satu proses memori, namun komponen-komponen logika bisnisnya (*Domains/Modules*) dipisahkan secara kedap/ketat selayaknya microservices mandiri. 

### 1. Mekanisme Kompilator Go (`internal/` directory)
Di ekosistem Go, hal ini difasilitasi dengan folder `internal/`. Aturannya ditegakkan `go/build` saat resolusi import: jika sebuah *import path* mengandung elemen `internal`, pengimpornya harus berakar pada direktori **induk** dari `internal` tersebut. Pelanggaran memicu galat: `use of internal package ... not allowed`. Komunikasi antar modul HANYA boleh melewati *Interface Facade* di luar folder internal.

> ### ⚠️ Tata letak menentukan segalanya — dan salah satunya tidak menjaga apa pun
>
> Aturan `internal/` bersifat **relatif terhadap induknya**, bukan global. Konsekuensinya keras dan jarang disadari:
>
> ```text
> ✅ MENJAGA — satu internal/ PER MODUL
>    pkg/inventory/facade.go
>    pkg/inventory/internal/service.go     <- hanya pkg/inventory/** yang boleh
>    pkg/billing/facade.go
>    pkg/billing/internal/service.go       <- hanya pkg/billing/** yang boleh
>    => billing mengimpor internal inventory: DITOLAK compiler
>
> ❌ TIDAK MENJAGA APA PUN ANTAR MODUL — satu internal/ di akar
>    internal/modul/inventory/service.go
>    internal/modul/billing/service.go
>    => billing mengimpor inventory/service: DIIZINKAN SEPENUHNYA
>       (keduanya berakar di internal/ yang sama)
> ```
>
> `internal/` di akar repo hanya mencegah **repo lain** mengimpor Anda. Di dalam
> repo Anda sendiri, ia tidak memisahkan modul satu pun. Ini penting karena tata
> letak akar itulah yang paling umum dipakai orang, lalu diyakini "sudah modular
> karena ada internal/". Kompilator tidak pernah menjanjikan itu.
>
> Bila Anda memang memakai tata letak akar (alasannya sah: `internal/` akar
> menyembunyikan seluruh repo dari konsumen luar), maka batas antar modul
> **tidak ditegakkan compiler** dan harus ditegakkan alat lain di CI:
>
> ```bash
> # Larang modul mengimpor paket non-facade milik modul lain.
> # (lookahead PCRE sengaja dihindari: `grep -E` tidak mendukungnya)
> bocor=$(go list -deps ./internal/modul/billing/... \
>   | grep 'internal/modul/' \
>   | grep -v 'internal/modul/billing' \
>   | grep -v '/facade$')
> [ -n "$bocor" ] && { echo "BATAS MODUL BOCOR:"; echo "$bocor"; exit 1; }
> ```
>
> Atau gunakan `depguard` (golangci-lint) / `go-arch-lint` yang memang dirancang
> untuk ini. Yang berbahaya bukan memilih tata letak akar — melainkan memilihnya
> sambil mengira compiler sedang menjaga sesuatu.

Dengan tata letak per-modul, pemecahan ke microservice fisik kelak menjadi jauh lebih murah: yang perlu diganti hanya implementasi di balik Facade, bukan setiap pemanggilnya.

### 2. Memory Layout & Escape Analysis
Berbeda dengan microservices yang me-serialize data ke JSON/Protobuf (RPC), komunikasi antar modul dalam Modular Monolith adalah *in-process function calls* — orde nanodetik, bukan milidetik. Panggilan lewat antarmuka Facade adalah *indirect call* melalui itab, jadi bukan benar-benar nol: ia menghalangi *inlining* dan karenanya juga menghalangi sebagian besar optimasi setelahnya. Tetap saja ini ~1–2 ns melawan ~1 ms untuk satu hop jaringan; selisihnya enam orde besaran dan tidak perlu dibesar-besarkan lebih dari itu.

**Yang perlu diluruskan soal escape analysis.** Sering terdengar saran "oper by value lewat Facade supaya tetap di stack". Untuk antarmuka, saran itu justru terbalik:

- Menyimpan sebuah nilai konkret ke dalam **interface** berarti nilai itu harus di-*box*. Kecuali kompilator bisa membuktikan hasilnya tidak escape (biasanya lewat devirtualisasi setelah inlining — persis yang sulit terjadi pada batas modul yang dinamis), *boxing* itu **dialokasikan di heap**. Jadi mengoper `User` by value menembus `interface` tidak menyelamatkannya dari heap; ia hanya menambah satu salinan sebelum tetap masuk heap.
- Untuk struct besar, *value semantics* berarti `memcpy` penuh di setiap panggilan. Di batas yang dipanggil ribuan kali per detik, itu bisa lebih mahal daripada satu pointer yang escape.

Verifikasi, jangan percaya (termasuk pada paragraf ini):

```bash
go build -gcflags='-m -m' ./pkg/inventory/ 2>&1 | grep -E 'escapes to heap|does not escape'
go test -bench=. -benchmem ./pkg/inventory/   # allocs/op adalah angka yang menentukan
```

**Alasan sebenarnya mengoper salinan lintas modul bukanlah stack allocation, melainkan KEPEMILIKAN.** Pointer yang menyeberangi dinding Facade membuat dua modul memegang tulisan ke memori yang sama tanpa satu pun mutex yang melindungi keduanya. Itu masalah kebenaran, bukan performa — dan itu yang dibahas Edge Case 3 di bawah. Bila performanya ternyata jadi soal, ukur dulu; jangan mendahului profiler dengan intuisi tentang stack.

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
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"sync"
	"testing"
)

// =====================================
// MODUL INVENTORY (Facade Publik)
// File: pkg/inventory/facade.go
// =====================================

var ErrInsufficientStock = errors.New("insufficient stock for reservation")
var ErrItemNotFound = errors.New("item not found in inventory")

var ErrKuantitasTidakValid = errors.New("kuantitas harus lebih besar dari nol")

// InventoryFacade adalah kontrak publik yang boleh dipanggil modul lain.
// Harus tetap berukuran kecil (Interface Segregation Principle).
//
// ReleaseStock BUKAN pelengkap opsional. Setiap operasi lintas modul yang
// memutasi state modul lain WAJIB punya pasangan kompensasinya di Facade yang
// sama -- kalau tidak, pola Saga yang dibahas di Edge Case 1 secara harfiah
// tidak punya apa pun untuk dipanggil, dan kegagalan di langkah kedua
// meninggalkan stok tertahan selamanya tanpa faktur.
type InventoryFacade interface {
	ReserveStock(ctx context.Context, itemID string, quantity int) error
	ReleaseStock(ctx context.Context, itemID string, quantity int) error
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
	// maps.Clone WAJIB, bukan kerapian. Menyimpan map milik pemanggil berarti
	// pemanggil tetap memegang tulisan ke state internal modul ini -- mutex di
	// atas hanya menyelaraskan goroutine MILIK modul, dan sama sekali tidak
	// mengikat pemanggil. Hasilnya `fatal error: concurrent map writes`, yang
	// tidak bisa di-recover, dari sebuah modul yang tampak sudah dikunci rapi.
	//
	// Ini persis kebocoran yang dilarang Edge Case 3 di bawah, hanya arahnya
	// terbalik: bukan state modul yang bocor keluar, melainkan memori luar yang
	// diadopsi menjadi state modul.
	//
	// maps.Clone(nil) mengembalikan nil, jadi urutannya: clone dulu, baru jaga.
	stok := maps.Clone(initialStock)
	if stok == nil {
		stok = make(map[string]int)
	}
	return &inventoryInternalService{stock: stok}
}

// ReserveStock mengamankan I/O lintas Goroutine di satu proses yang sama.
func (s *inventoryInternalService) ReserveStock(ctx context.Context, itemID string, qty int) error {
	// Facade in-process TETAP wajib menghormati context. Godaannya besar untuk
	// melewatkan ini ("kan cuma panggilan memori"), padahal justru di sinilah
	// pembatalan menjadi murah: satu pemeriksaan mencegah seluruh sisa rantai
	// lintas modul dieksekusi untuk permintaan yang kliennya sudah pergi.
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("reservasi %s dibatalkan: %w", itemID, err)
	}
	if qty <= 0 {
		return fmt.Errorf("%w: %d", ErrKuantitasTidakValid, qty)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	current, exists := s.stock[itemID]
	if !exists {
		return fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
	}
	if current < qty {
		return fmt.Errorf("%w: diminta %d, tersedia %d", ErrInsufficientStock, qty, current)
	}

	s.stock[itemID] = current - qty
	return nil
}

// ReleaseStock adalah kompensator ReserveStock (Saga).
//
// Perhatikan bahwa ia TIDAK memeriksa ctx.Err(). Ini disengaja dan penting:
// kompensasi hampir selalu dijalankan JUSTRU KARENA sesuatu gagal, dan sering
// kali yang gagal adalah context itu sendiri. Kompensator yang menolak bekerja
// pada context yang sudah dibatalkan tidak akan pernah berjalan tepat di saat
// ia paling dibutuhkan. Kompensasi butuh context-nya sendiri dengan batas waktu
// terpisah (lihat `observability_resilience/graceful_shutdown_drain.md`).
func (s *inventoryInternalService) ReleaseStock(_ context.Context, itemID string, qty int) error {
	if qty <= 0 {
		return fmt.Errorf("%w: %d", ErrKuantitasTidakValid, qty)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	current, exists := s.stock[itemID]
	if !exists {
		return fmt.Errorf("%w: %s", ErrItemNotFound, itemID)
	}
	s.stock[itemID] = current + qty
	return nil
}

// =====================================
// MODUL BILLING (Internal Logics)
// File: pkg/billing/internal/service.go
// =====================================

// ErrKompensasiGagal menandai kondisi yang HARUS memicu alert dan rekonsiliasi
// manual: langkah utama gagal DAN pembatalannya juga gagal. Sistem kini berada
// di state yang tidak konsisten dan tidak ada kode yang bisa memperbaikinya
// sendiri.
var ErrKompensasiGagal = errors.New("kompensasi saga gagal, perlu rekonsiliasi manual")

type BillingService struct {
	// Modul Billing menampung instance dari modul Inventory
	// Komunikasi ini berkecepatan RAM (nanodetik) tanpa TCP Overhead
	inventory InventoryFacade
	terbitkan func() (string, error)
}

func NewBillingModule(inv InventoryFacade) *BillingService {
	return &BillingService{inventory: inv, terbitkan: nomorFakturBaru}
}

// nomorFakturBaru menghasilkan ID faktur yang acak, bukan berbasis jam.
//
// `fmt.Sprintf("INV-%d", time.Now().UnixNano())` gagal sebagai ID keuangan
// karena tiga hal sekaligus:
//   - BUKAN unik. Dua goroutine pada tick jam yang sama menghasilkan ID
//     identik. Resolusi UnixNano tidak sehalus namanya di semua platform.
//   - BUKAN monoton. UnixNano adalah jam dinding; koreksi NTP mundur membuat
//     ID baru lebih kecil dari ID lama.
//   - MEMBOCORKAN informasi. Nomor faktur dapat ditebak berurutan, dan
//     menyingkap waktu penerbitan serta volume transaksi kepada siapa pun
//     yang memegang dua faktur.
func nomorFakturBaru() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("membangkitkan nomor faktur: %w", err)
	}
	return "INV-" + hex.EncodeToString(b), nil
}

// ProcessOrder menjalankan usecase utama lintas domain.
func (b *BillingService) ProcessOrder(ctx context.Context, itemID string, qty int) (string, error) {
	// 1. Koordinasi Modul 1 (Inventory) - Mutasi State
	if err := b.inventory.ReserveStock(ctx, itemID, qty); err != nil {
		// Belum ada state yang berubah di sini -- tidak ada yang perlu
		// dikompensasi. Yang perlu dikompensasi justru kasus SESUDAH ini.
		return "", fmt.Errorf("billing gagal karena aturan inventory: %w", err)
	}

	// 2. Modul 2 (Billing) - Menyelesaikan Transaksi & State miliknya sendiri.
	//
	// Inilah titik yang paling sering terlewat: langkah PERTAMA sudah memutasi
	// state modul lain. Bila langkah kedua gagal dan kita hanya `return err`,
	// stok tetap tertahan tanpa faktur yang pernah terbit -- kebocoran yang
	// tidak terlihat di log mana pun, hanya muncul sebagai stok yang perlahan
	// habis tanpa penjualan.
	invoiceID, err := b.terbitkan()
	if err != nil {
		// SAGA: batalkan langkah 1.
		if errLepas := b.inventory.ReleaseStock(ctx, itemID, qty); errLepas != nil {
			// Kegagalan KOMPENSASI adalah satu-satunya galat di alur ini yang
			// DILARANG ditelan. Stok sekarang tertahan permanen; hanya manusia
			// yang bisa membereskannya. errors.Join menjaga kedua sebab tetap
			// bisa diperiksa dengan errors.Is oleh pemanggil dan oleh alert.
			return "", errors.Join(
				fmt.Errorf("%w: melepas %d unit %s", ErrKompensasiGagal, qty, itemID),
				errLepas,
				err,
			)
		}
		return "", fmt.Errorf("penerbitan faktur gagal, stok sudah dilepas: %w", err)
	}

	return invoiceID, nil
}

// =====================================
// 4. UNIT TEST / INTEGRATION TEST (App Wiring & Mocks)
// =====================================

// Mocking Inventory untuk isolasi Unit Test Billing
type MockInventory struct {
	ReserveStockFunc func(ctx context.Context, itemID string, quantity int) error
	ReleaseStockFunc func(ctx context.Context, itemID string, quantity int) error
	JumlahRelease    int
}

func (m *MockInventory) ReserveStock(ctx context.Context, itemID string, quantity int) error {
	return m.ReserveStockFunc(ctx, itemID, quantity)
}

func (m *MockInventory) ReleaseStock(ctx context.Context, itemID string, quantity int) error {
	m.JumlahRelease++
	if m.ReleaseStockFunc == nil {
		return nil
	}
	return m.ReleaseStockFunc(ctx, itemID, quantity)
}

// Unit Test 1: Menguji domain Inventory secara murni (Isolasi)
func TestInventory_ReserveStock(t *testing.T) {
	inv := NewInventoryModule(map[string]int{"SKU-1": 10})

	if err := inv.ReserveStock(context.Background(), "SKU-1", 5); err != nil {
		t.Fatalf("mengharapkan tanpa galat, dapat %v", err)
	}

	err := inv.ReserveStock(context.Background(), "SKU-1", 10)
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("mengharapkan ErrInsufficientStock, dapat %v", err)
	}

	// Sisa 5 -> dilepas 5 -> kembali 10 -> reservasi 10 harus lolos.
	if err := inv.ReleaseStock(context.Background(), "SKU-1", 5); err != nil {
		t.Fatalf("ReleaseStock: %v", err)
	}
	if err := inv.ReserveStock(context.Background(), "SKU-1", 10); err != nil {
		t.Fatalf("setelah dilepas, reservasi 10 harus lolos, dapat %v", err)
	}
}

func TestInventory_TepiInput(t *testing.T) {
	inv := NewInventoryModule(map[string]int{"SKU-1": 10})
	ctx := context.Background()

	if err := inv.ReserveStock(ctx, "SKU-TIDAK-ADA", 1); !errors.Is(err, ErrItemNotFound) {
		t.Errorf("item tak dikenal: mengharapkan ErrItemNotFound, dapat %v", err)
	}
	// Tanpa penjaga ini, qty negatif MENAMBAH stok lewat `current - qty`.
	if err := inv.ReserveStock(ctx, "SKU-1", -5); !errors.Is(err, ErrKuantitasTidakValid) {
		t.Errorf("qty negatif: mengharapkan ErrKuantitasTidakValid, dapat %v", err)
	}

	ctxBatal, batal := context.WithCancel(ctx)
	batal()
	if err := inv.ReserveStock(ctxBatal, "SKU-1", 1); !errors.Is(err, context.Canceled) {
		t.Errorf("context dibatalkan: mengharapkan context.Canceled, dapat %v", err)
	}
}

// Uji ini membuktikan konstruktor tidak mengadopsi map milik pemanggil.
// Tanpa maps.Clone, ia gagal -- atau lebih buruk, `go test -race` melaporkan
// data race dan produksi mendapat `fatal error: concurrent map writes`.
func TestInventory_KonstruktorMenyalinMap(t *testing.T) {
	stokAwal := map[string]int{"SKU-1": 10}
	inv := NewInventoryModule(stokAwal)

	// Pemanggil memutasi map-nya sendiri setelah modul dibangun.
	stokAwal["SKU-1"] = 0
	delete(stokAwal, "SKU-1")

	if err := inv.ReserveStock(context.Background(), "SKU-1", 10); err != nil {
		t.Fatalf("state modul terpengaruh mutasi pemanggil: %v", err)
	}
}

// Premis seluruh berkas ini adalah panggilan lintas modul di dalam satu proses,
// artinya lintas goroutine. Modul yang tidak diuji dengan -race hanya
// MENGAKU thread-safe.
func TestInventory_ReservasiSerentak(t *testing.T) {
	const stok, pekerja = 100, 50
	inv := NewInventoryModule(map[string]int{"SKU-1": stok})

	var wg sync.WaitGroup
	var berhasil int64
	var muHitung sync.Mutex

	for i := 0; i < pekerja; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := inv.ReserveStock(context.Background(), "SKU-1", 3); err == nil {
				muHitung.Lock()
				berhasil++
				muHitung.Unlock()
			}
		}()
	}
	wg.Wait()

	// 50 pekerja x 3 unit = 150 > 100, jadi sebagian WAJIB ditolak.
	// Yang diuji: tidak ada oversell -- total terjual tak pernah melebihi stok.
	if berhasil*3 > stok {
		t.Errorf("oversell: %d reservasi x3 = %d unit dari stok %d", berhasil, berhasil*3, stok)
	}
	if berhasil == 0 {
		t.Error("tidak ada satu pun reservasi berhasil; uji ini tidak menguji apa pun")
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

// Unit Test 3: Menguji domain Billing - Gagal di langkah pertama.
// Tidak ada state yang berubah, jadi kompensasi TIDAK boleh dipanggil.
func TestBilling_ProcessOrder_Fail(t *testing.T) {
	mockInv := &MockInventory{
		ReserveStockFunc: func(ctx context.Context, itemID string, quantity int) error {
			return ErrInsufficientStock
		},
	}

	billing := NewBillingModule(mockInv)
	_, err := billing.ProcessOrder(context.Background(), "SKU-99", 100)

	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("mengharapkan galat membungkus ErrInsufficientStock, dapat %v", err)
	}
	if mockInv.JumlahRelease != 0 {
		t.Errorf("kompensasi dipanggil %dx padahal tak ada yang direservasi", mockInv.JumlahRelease)
	}
}

// Unit Test 3b: Gagal di langkah KEDUA -- inilah alur Saga yang sebenarnya.
// Tanpa uji ini, stok yang tertahan tanpa faktur tidak akan pernah ketahuan.
func TestBilling_ProcessOrder_GagalSetelahReservasi_MelepasStok(t *testing.T) {
	mockInv := &MockInventory{
		ReserveStockFunc: func(context.Context, string, int) error { return nil },
	}
	billing := NewBillingModule(mockInv)
	galatTerbit := errors.New("generator faktur mati")
	billing.terbitkan = func() (string, error) { return "", galatTerbit }

	_, err := billing.ProcessOrder(context.Background(), "SKU-99", 2)

	if !errors.Is(err, galatTerbit) {
		t.Fatalf("mengharapkan galat membungkus galatTerbit, dapat %v", err)
	}
	if mockInv.JumlahRelease != 1 {
		t.Fatalf("stok harus dilepas tepat 1x, dipanggil %dx", mockInv.JumlahRelease)
	}
	if errors.Is(err, ErrKompensasiGagal) {
		t.Error("kompensasi berhasil, galat tidak boleh ditandai butuh rekonsiliasi")
	}
}

// Unit Test 3c: Kompensasi ITU SENDIRI gagal. Ini state paling berbahaya di
// seluruh pola Saga, dan satu-satunya yang wajib memicu alert manusia.
func TestBilling_KompensasiGagal_DitandaiUntukRekonsiliasi(t *testing.T) {
	galatLepas := errors.New("modul inventory tidak merespons")
	mockInv := &MockInventory{
		ReserveStockFunc: func(context.Context, string, int) error { return nil },
		ReleaseStockFunc: func(context.Context, string, int) error { return galatLepas },
	}
	billing := NewBillingModule(mockInv)
	galatTerbit := errors.New("generator faktur mati")
	billing.terbitkan = func() (string, error) { return "", galatTerbit }

	_, err := billing.ProcessOrder(context.Background(), "SKU-99", 2)

	// errors.Join mempertahankan KETIGA sebab agar bisa diperiksa terpisah:
	// penanda rekonsiliasi, kegagalan kompensasi, dan kegagalan aslinya.
	for _, target := range []error{ErrKompensasiGagal, galatLepas, galatTerbit} {
		if !errors.Is(err, target) {
			t.Errorf("galat gabungan harus cocok dengan %v, tidak", target)
		}
	}
}

// Integration Test 4: End-to-end Wiring Lintas Domain
func TestModularMonolith_CrossModuleFlow(t *testing.T) {
	ctx := context.Background()

	// 1. Setup DI / Wiring di Root App (`main.go` environment)
	inventoryModule := NewInventoryModule(map[string]int{"SKU-123": 10})
	billingModule := NewBillingModule(inventoryModule)

	// 2. Eksekusi End-to-End Success flow
	faktur1, err := billingModule.ProcessOrder(ctx, "SKU-123", 4)
	if err != nil {
		t.Fatalf("kegagalan tak terduga: %v", err)
	}
	if faktur1 == "" {
		t.Errorf("mengharapkan ID faktur yang valid")
	}

	// 3. Eksekusi Flow Kegagalan Aturan Bisnis Lintas Domain
	_, err = billingModule.ProcessOrder(ctx, "SKU-123", 20) // Sisa stok: 6
	if !errors.Is(err, ErrInsufficientStock) {
		t.Errorf("mengharapkan ErrInsufficientStock, dapat: %v", err)
	}

	// 4. Dua faktur berbeda WAJIB punya ID berbeda. `receipt == ""` saja tidak
	//    pernah menangkap generator yang mengembalikan nilai sama berulang --
	//    dan justru itulah cacat pada ID berbasis time.Now().UnixNano().
	faktur2, err := billingModule.ProcessOrder(ctx, "SKU-123", 1)
	if err != nil {
		t.Fatalf("pesanan kedua gagal: %v", err)
	}
	if faktur1 == faktur2 {
		t.Errorf("dua faktur berbagi ID yang sama: %s", faktur1)
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
       // 1. Modul Payment
       txID, err := o.payment.Deduct(ctx, 1000)
       if err != nil {
           // WAJIB diperiksa di sini. Bila galat ini dilewati, txID kosong dan
           // alur berlanjut seolah pembayaran berhasil -- lalu "refund" nanti
           // dijalankan atas transaksi yang tidak pernah ada.
           return fmt.Errorf("pemotongan saldo gagal: %w", err)
       }

       // 2. Modul Inventory (Transaksi Gagal!)
       if err := o.inventory.Reserve(ctx, "SKU-1"); err != nil {
           // SAGA COMPENSATING TRANSACTION: kembalikan saldo.
           //
           // Kompensasi memakai context TERPISAH, bukan ctx pemanggil.
           // Kompensasi biasanya berjalan justru karena sesuatu gagal, dan
           // sering kali yang gagal adalah ctx itu sendiri (timeout/batal).
           // Meneruskan ctx yang sudah mati membuat refund gagal seketika --
           // tepat pada saat ia paling dibutuhkan.
           ctxKomp, batal := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
           defer batal()

           if errRefund := o.payment.Refund(ctxKomp, txID); errRefund != nil {
               // JANGAN PERNAH `_ =` di baris ini. Uang sudah keluar dari
               // dompet pelanggan dan pesanannya tidak ada. Tidak ada kode
               // yang bisa memperbaiki ini sendiri; yang dibutuhkan adalah
               // alert dan entri rekonsiliasi manual.
               slog.ErrorContext(ctx, "KOMPENSASI GAGAL: saldo terpotong tanpa pesanan",
                   "tx_id", txID, "jumlah_minor", 1000,
                   "galat_refund", errRefund, "galat_asli", err)
               return errors.Join(ErrKompensasiGagal, errRefund, err)
           }
           return fmt.Errorf("checkout gagal, saldo dikembalikan: %w", err)
       }
       return nil
   }
   ```
   *Tiga hal yang membedakan Saga sungguhan dari yang hanya terlihat seperti Saga:*
   - **Galat langkah pertama diperiksa.** `txID, err := ...` yang `err`-nya langsung ditimpa baris berikutnya adalah bug diam — `staticcheck` menandainya sebagai SA4006, `go vet` tidak.
   - **Kompensasi punya context sendiri.** `context.WithoutCancel` (Go 1.21+) mempertahankan nilai-nilai ctx (trace ID, tenant) sambil melepaskan pembatalannya.
   - **Kegagalan kompensasi tidak pernah ditelan.** Ini satu-satunya cabang di seluruh alur yang berakhir dengan state tidak konsisten permanen, dan karenanya satu-satunya yang wajib memicu alert.
   - *Catatan kejujuran:* kompensasi in-process ini tetap hilang bila prosesnya mati di antara langkah 1 dan langkah kompensasi. Jaminannya lebih lemah daripada Saga berbasis log persisten. Bila uangnya cukup penting, langkah kompensasi harus dicatat dulu ke tabel (outbox) sebelum dieksekusi — lihat `arch_patterns/event_driven_pubsub.md`.

2. **Propagasi Eventual melalui Pub/Sub Lokal (Goroutine Leak Prevention):**
   Pemanggilan in-memory facade bisa macet (bottleneck) jika lintas-koordinasi terlalu dalam (`Modul A -> Modul B -> Modul C -> Modul D`). Menahan respon HTTP User sembari modul D mengirim Email sangat rentan timeout.
   *Defensive:* Monolith modular dapat dan seharusnya mengaplikasikan arsitektur *Event Driven*. Gunakan `watermill/pubsub/gochannel` internal agar saat Modul A selesai (seperti User Terdaftar), ia mem-publish *memory event* yang membiarkan goroutine modul lain menangkapnya di latar belakang tanpa menunda waktu respon (RTT) request HTTP utama. Gunakan `context` untuk mencegah Goroutine leak.
   ```go
   // Dispatcher yang BENAR-BENAR non-blocking: `default` menjadikannya
   // paling banyak satu operasi channel, tanpa timer, tanpa penundaan.
   func (e *EventBus) PublishOrderCreated(ctx context.Context, orderID string) {
       select {
       case e.orderChan <- orderID:
           // Diterima background worker modul lain
       default:
           // Buffer penuh. Ini keputusan KEHILANGAN DATA, bukan sekadar
           // catatan log -- perlakukan sebagai metrik ber-alert, bukan
           // baris log yang tenggelam.
           e.eventDrop.Inc()
           slog.ErrorContext(ctx, "event dibuang, buffer bus penuh",
               "event", "order_created", "order_id", orderID,
               "kapasitas", cap(e.orderChan))
       }
   }
   ```
   *Tiga hal yang salah pada bentuk yang lebih sering ditulis* (`case <-time.After(100 * time.Millisecond)`):
   - **Ia memblokir hingga 100 ms** — di jalur respons HTTP, persis hal yang bagian ini justru ingin dihindari. Komentar "bebas blocking" di atas potongan yang memblokir adalah cara termudah membuat orang berhenti membacanya.
   - **`time.After` mengalokasikan timer yang tidak bisa dihentikan.** Pada Go 1.21/1.22 timer itu bertahan sampai firing penuh meski select sudah keluar; di jalur panas ia menumpuk. (Go 1.23+ membuatnya bisa di-GC lebih awal, tetapi berkas ini menyatakan berlaku untuk 1.21+, jadi jangan andalkan itu.) Bila memang perlu batas waktu, pakai `time.NewTimer` + `defer t.Stop()`.
   - **Urutan `case` tidak menjamin apa pun.** `select` memilih ACAK di antara case yang siap. Menaruh `ctx.Done()` di urutan terakhir tidak membuatnya berprioritas rendah, dan menaruhnya pertama tidak membuatnya berprioritas tinggi — event tetap bisa terkirim meski context sudah dibatalkan. Bila pembatalan harus benar-benar menang, periksa `ctx.Err()` secara eksplisit sebelum `select`.

   *Dan pertanyaan yang harus dijawab sebelum memilih `default`:* apakah event ini boleh hilang? Notifikasi "selamat datang" — boleh. Pembaruan saldo — tidak. Untuk yang tidak boleh hilang, channel in-memory adalah pilihan yang salah sejak awal; yang dibutuhkan Transactional Outbox, dan bagaimana persisnya ada di `arch_patterns/event_driven_pubsub.md`.

3. **Injeksi Memori Lintas Goroutine (Pointer Race Conditions & Escape Analysis):**
   Tidak seperti arsitektur microservices asli via HTTP di mana objek direplikasi ulang (JSON marshaling), *Modular Monolith* mengoper struct data dalam bentuk _pointer RAM_. Modul A bisa me-request Data `*User` ke Modul B dan kemudian mengubah nilainya. Itu mengubah representasi *Cache* Modul B secara liar.
   *Defensive:* Jika mengoper object struct yang dapat dimutasi (slice/maps) melintasi dinding antarmuka Facade, fungsi origin Modul pengirim **wajib** me-return salinan agar tidak termutasi oleh goroutine pemanggil di luar batas modul.
   ```go
   // ❌ BAD: Me-return referensi pointer asli (rentan dimutasi caller)
   func (s *UserService) GetUser(id string) *User {
       return s.cache[id] // Pointer aslinya bocor ke Modul lain!
   }

   // ❌ MASIH BAD, dan lebih berbahaya karena TAMPAK benar:
   func (s *UserService) GetUser(id string) User {
       return *s.cache[id]
       //     ^ id tak dikenal -> s.cache[id] adalah nil -> PANIC
       //       Tidak ada mutex -> balapan dengan penulis cache
       //       Salinan DANGKAL -> field slice/map tetap dibagi
   }

   // ✅ GOOD
   func (s *UserService) GetUser(id string) (User, error) {
       s.mu.RLock()
       defer s.mu.RUnlock()

       u, ada := s.cache[id]     // comma-ok, bukan dereference buta
       if !ada {
           return User{}, fmt.Errorf("%w: %s", ErrUserNotFound, id)
       }
       return u.Salin(), nil     // penyalinan dimiliki entity-nya sendiri
   }

   // Salin hidup di sebelah definisi User, sehingga field baru dan
   // penyalinannya diubah di satu tempat yang sama.
   func (u *User) Salin() User {
       c := *u                          // field bertipe nilai: selesai di sini
       c.Roles = slices.Clone(u.Roles)  // field referensi: WAJIB disebut satu per satu
       c.Meta = maps.Clone(u.Meta)
       return c
   }
   ```
   *Yang membuat versi terakhir berbeda:* `*u` sendirian adalah salinan **dangkal**. Ia terlihat benar hari ini hanya karena `User` kebetulan berisi field bertipe nilai saja. Begitu seseorang menambah `Roles []string`, isolasinya bocor tanpa satu baris pun berubah di sini, dan gejalanya muncul di modul lain sebagai data yang berubah sendiri. Menaruh penyalinan di dalam method `Salin()` milik entity tidak menghapus kewajiban itu — tetapi memindahkannya ke satu tempat yang pasti terlihat oleh orang yang menambah field.

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
| "Sudah modular, kan ada `internal/`" | ada berapa `internal/`, dan di mana | Satu `internal/` di akar tidak memisahkan modul mana pun (§1) |

```bash
# Siapa mengimpor siapa antar modul -- ini peta batas yang sebenarnya
go list -deps ./internal/modul/... | grep 'internal/modul' | sort -u

# Berapa banyak internal/ yang benar-benar ada, dan di kedalaman berapa.
# Hanya SATU hasil, di akar => compiler tidak menjaga batas antar modul (§1).
find . -type d -name internal -not -path './vendor/*'

# Modul yang menyentuh tabel milik modul lain
grep -rn 'FROM pesanan\|JOIN pesanan' --include='*.sql' internal/modul/ \
  | cut -d/ -f3 | sort -u

# Metrik berlabel modul: tanpa ini tidak ada dasar memutuskan pemisahan
curl -s localhost:9090/metrics | grep -oE 'modul="[a-z_]+"' | sort | uniq -c
```
