# Data Race Detection & Mitigation

> **Berlaku:** Go 1.21+ · ThreadSanitizer · **Lihat juga:** `concurrency/sync_primitives_deep.md` · `concurrency/atomic_lockfree_patterns.md` · `testing_quality/synctest_deterministic_concurrency.md` · `testing_quality/fuzz_testing_go.md`

## Konsep Utama
Data Race (Balapan Data) adalah bug konkurensi terburuk, paling umum, sekaligus paling sulit direproduksi secara deterministik. Di ekosistem Go, sebuah *Data Race* secara definitif terjadi apabila:
1. Dua goroutine atau lebih mengakses alamat memori yang **sama** secara **berbarengan** (concurrently).
2. Setidaknya salah satu (atau lebih) dari goroutine tersebut melakukan instruksi **tulis (Write)** ke memori itu.
3. Tidak ada mekanisme *primitif sinkronisasi* (`sync.Mutex`, `channels`, atau `atomic`) yang menertibkan urutannya untuk menciptakan batas *Happens-Before*.

Kecanggihan Go terletak pada tersedianya sistem deteksi bawaan (built-in): **Data Race Detector** (`-race`). Saat flag ini aktif, compiler menyuntikkan *ThreadSanitizer (TSan)*. Secara internal, TSan mengalokasikan "Shadow Memory" — setiap 8 bytes memori aplikasi dipetakan ke memori bayangan yang merekam identitas thread dan vector clock dari akses terakhir. Menggunakan arsitektur *Vector Clocks* dan state machine internal, TSan memeriksa histori setiap instruksi Load/Store secara real-time. Jika terdeteksi perpotongan memori tanpa *happens-before edge* (seperti `sync.Mutex` yang menginkremen vector clock), program akan langsung mencetak *Call Stack* detail penunjuk baris kode yang menyebabkan race.

## Diagram ASCII

```text
       How Data Race Causes Silent Corruption (e.g., Maps, Slices, Structs)
       
       [Goroutine 1: Writer]                          [Goroutine 2: Reader]
       "users = append(users, x)"                     "len := len(users)"
       
                  |    (Simultaneous execution)             |
                  V                                         V
         Hardware memory layout              Hardware memory layout
       | Size: 2 | Capacity: 4 |           | Size: 2 | Capacity: 4 | 
       
         Writes Size to 3!                 Reads Size (is it 2 or 3??) 
                 \                               /
                  X ----- BOOM (DATA RACE) ---- X
                  
       Result: Random crashes, nil pointers, completely garbage values,
       or the dreaded "fatal error: concurrent map writes".
```

## Kode Go Production-Ready

Kode di bawah ini menunjukkan cara aman mengelola state yang dapat diakses oleh ratusan goroutine sekaligus tanpa memicu *Data Race*, memanfaatkan `sync.RWMutex` untuk performa *read-heavy*.

```go
package concurrency

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// RegistryInterface memungkinkan mocking
type RegistryInterface interface {
	Add(key string, val int)
	Get(key string) (int, bool)
	Snapshot() map[string]int
}

// ThreadSafeRegistry adalah struktur data yang aman dari race condition 
// untuk mengelola map. Dioptimalkan untuk kasus banyak baca, sedikit tulis.
type ThreadSafeRegistry struct {
	mu    sync.RWMutex // Menggunakan RWMutex untuk concurrency read yang tinggi
	items map[string]int
}

// Memastikan interface terpenuhi pada saat kompilasi
var _ RegistryInterface = (*ThreadSafeRegistry)(nil)

// NewRegistry menginisialisasi registry baru.
func NewRegistry() *ThreadSafeRegistry {
	return &ThreadSafeRegistry{
		items: make(map[string]int),
	}
}

// Add secara aman memutasi state. 
// Menggunakan Lock (Writer Lock) eksklusif.
func (r *ThreadSafeRegistry) Add(key string, val int) {
	r.mu.Lock()
	defer r.mu.Unlock() // WAJIB defer untuk menjamin unlock meski terjadi panic
	
	r.items[key] = val
}

// Get secara aman membaca state.
// Menggunakan RLock (Reader Lock) yang memperbolehkan banyak pembaca sekaligus.
func (r *ThreadSafeRegistry) Get(key string) (int, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	val, ok := r.items[key]
	return val, ok
}

// Snapshot mengembalikan duplikat (deep copy) dari keseluruhan isi map 
// secara aman, mencegah referensi map asli bocor ke caller.
func (r *ThreadSafeRegistry) Snapshot() map[string]int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	copyMap := make(map[string]int, len(r.items))
	for k, v := range r.items {
		copyMap[k] = v
	}
	return copyMap
}

// ==========================================
// UNIT TEST (-race)
// ==========================================
// Untuk mendeteksi keampuhan kode ini, Go mengharuskan flag -race:
// `go test -race ./...`

func TestThreadSafeRegistry_NoRace(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	reg := NewRegistry()
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(val int) {
			defer wg.Done()
			reg.Add(fmt.Sprintf("key_%d", val), val)
		}(i)
	}

	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func(val int) {
			defer wg.Done()
			reg.Get(fmt.Sprintf("key_%d", val % 100))
			time.Sleep(1 * time.Microsecond)
		}(i)
	}

	wg.Wait()
	snap := reg.Snapshot()
	if len(snap) != 100 {
		t.Errorf("expected 100 items, got %d", len(snap))
	}
}

// MockRegistry digunakan untuk testing layer bisnis tanpa overhead lock mutex
type MockRegistry struct {
	MockItems map[string]int
}
func (m *MockRegistry) Add(key string, val int) { m.MockItems[key] = val }
func (m *MockRegistry) Get(key string) (int, bool) { val, ok := m.MockItems[key]; return val, ok }
func (m *MockRegistry) Snapshot() map[string]int { return m.MockItems }

func TestRegistry_MockUsage(t *testing.T) {
	// Memastikan logika bisnis berjalan benar dengan mock
	mock := &MockRegistry{MockItems: make(map[string]int)}
	mock.Add("test_key", 42)
	
	val, ok := mock.Get("test_key")
	if !ok || val != 42 {
		t.Fatalf("expected 42, got %d", val)
	}
}

func TestThreadSafeRegistry_Sequential(t *testing.T) {
	reg := NewRegistry()
	reg.Add("single", 1)
	
	val, ok := reg.Get("single")
	if !ok || val != 1 {
		t.Errorf("expected to retrieve single item")
	}
	
	reg.Add("single", 2) // overwrite
	val, _ = reg.Get("single")
	if val != 2 {
		t.Errorf("expected overwrite to 2, got %d", val)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyembunyikan Race di Dalam Closure Slice Append

```go
// ❌ BAD: Menggabungkan hasil (append) ke shared slice tanpa Mutex
func GatherDataBad() []int {
    var results []int
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(val int) {
            defer wg.Done()
            // BAD: Data Race! Slice 'results' adalah struct di belakang layar.
            // Banyak goroutine menulis nilai ke memori dan menimpa index 'length' 
            // satu sama lain. Data akan hilang (Lost Updates).
            results = append(results, val) 
        }(i)
    }
    wg.Wait()
    return results
}

// ✅ GOOD: Lindungi slice append dengan sync.Mutex
func GatherDataGood() []int {
    var results []int
    var mu sync.Mutex
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(val int) {
            defer wg.Done()
            mu.Lock()         // GOOD: Akuisisi lock sebelum mutasi slice
            defer mu.Unlock() // GOOD: Pastikan dilepas
            results = append(results, val) 
        }(i)
    }
    wg.Wait()
    return results
}
```

**Why dangerous:** Di Go, Slice adalah *descriptor struct* (berisi Pointer array, Length, Capacity). Modifikasi via `append` akan membaca `length` saat ini, menaruh data di indeks tersebut, dan menaikkan nilai `length`. Saat dieksekusi secara *concurrent*, beberapa goroutine akan membaca nilai `length` yang sama (misal 5), lalu bersamaan menulis data ke indeks 5. Hasilnya, ratusan data akan hilang karena saling timpa (*Lost Updates*), dan panjang slice akhir akan jauh lebih kecil dari ekspektasi.

### ❌ Anti-Pattern 2: Lupa Membaca Data dengan Lock (Asimetris Synchronization)

```go
// ❌ BAD: Menulis dilindungi Mutex, tapi Membaca tidak
type CounterBad struct {
    mu sync.Mutex
    val int
}
func (c *CounterBad) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.val++ 
}
func (c *CounterBad) Val() int {
    // BAD: Membaca tanpa Mutex! Ini tetap Data Race terhadap fungsi Inc().
    // CPU Cache mungkin menampilkan nilai basi (Stale Read).
    return c.val 
}

// ✅ GOOD: Semua akses (baca dan tulis) ke shared resource HARUS tersinkronisasi
type CounterGood struct {
    mu sync.RWMutex // Gunakan RWMutex jika baca lebih dominan
    val int
}
func (c *CounterGood) Val() int {
    c.mu.RLock() // GOOD: Lindungi operasi pembacaan
    defer c.mu.RUnlock()
    return c.val
}
```

**Why dangerous:** Inilah bug konkurensi yang paling umum dilakukan Go programmer pemula. Membaca `int` biasa yang sedang diubah goroutine lain adalah pelanggaran *Memory Consistency*. Perangkat keras modern (CPU) menaruh variabel di L1/L2 Cache tiap core secara mandiri. Tanpa batasan `Lock()`, CPU Core 2 berhak membaca nilai basi `val` dari cache lokalnya (Stale Data), atau dalam kasus arsitektur 32-bit terhadap tipe 64-bit, bisa mengalami *Torn Read* (membaca memori yang baru diupdate separuh jalannya).

## Edge Cases

1. **Race pada Struct Tanpa Pointer (Pass-By-Value)**: Jika Anda meneruskan (passing) struct besar (seperti konfigurasi) dari satu goroutine ke goroutine lain secara *by-value* (tanpa `*`), operasi penyalinan (copy struct) tersebut ke goroutine baru TIDAK atomik. Jika ada thread lain yang kebetulan sedang mengupdate field struct asli saat *copy* sedang terjadi, goroutine penerima akan mendapat "Struct Frankenstein" yang berisi separuh konfigurasi baru dan separuh konfigurasi usang (Torn Read korupsi).
   - *Defensive*: Gunakan struct lock, copy menggunakan Mutex, atau di Go 1.19+ gunakan `atomic.Pointer[Config]` untuk mengganti referensi konfigurasi secara atomik utuh.

2. **Keterbatasan Statis TSan (Blind Spot)**: Race Detector Go tidak sakti secara teoritis. Ia murni bekerja secara *dinamis* saat eksekusi (runtime tracing). Artinya, ia hanya akan memprotes (detect) Data Race yang **BENAR-BENAR TERJADI dan terlewati aliran kodenya**. Jika *if-branch* Anda yang mengandung *data race* tidak pernah tereksekusi dalam Unit Test (karena coverage yang buruk), Race Detector akan buta 100% dan menganggap kode Anda aman.
   - *Defensive*: Anda *wajib* memiliki Code Coverage >80% pada package konkurensi, dan biasakan menjalankan `go test -race -count=20` (diulang berkali-kali) untuk "memancing" *flaky concurrency paths* keluar dari persembunyiannya.

3. **OOM & CPU Thrashing Akibat -race di Production**: Banyak engineer mengira bahwa flag `-race` baik dinyalakan di production server untuk mengawasi bug. Ini adalah bunuh diri infrastruktur. Mengaktifkan *Race Detector* membuat binary membesar, dan saat runtime akan meningkatkan konsumsi Memory 5x - 10x lipat dan mencekik CPU karena setiap aktivitas RAM sekecil apapun dicatat oleh struktur *Vector Clock* TSan.
   - *Defensive*: **JANGAN PERNAH** me-release binary ke *Production Traffic* dengan `-race`. Gunakan build tags standar untuk rilis, dan batasi pemakaian binaries `-race` *hanya* untuk CI/CD pipeline, Integration Tests, atau maksimal di environment *Staging* internal dengan beban trafik replika yang kecil.

## Kapan JANGAN Pakai Ini

- **Sebagai satu-satunya gerbang mutu konkurensi.** `-race` hanya melihat jalur yang benar-benar dieksekusi. Cabang `if` yang tidak pernah tersentuh uji berarti detektornya buta total di sana. Cakupan uji adalah prasyarat, bukan pelengkap.
- **Di produksi.** CPU naik 2–20×, memori 5–10×. Binary ber-`-race` layak untuk CI dan staging bertrafik kecil; melepasnya ke trafik nyata adalah menukar satu masalah dengan masalah yang lebih besar.
- **Untuk mencari deadlock, kebocoran goroutine, atau logika yang salah.** TSan hanya menjawab satu pertanyaan: apakah ada dua akses tak tersinkronisasi ke alamat memori yang sama. Deadlock butuh profil mutex; kebocoran butuh `goleak`; logika salah butuh uji.
- **Menambal laporan race dengan mutex tanpa memahami invariannya.** Menambahkan lock membuat laporannya hilang, tetapi bila urutan operasinya memang salah, yang tersisa adalah korupsi logis yang kini tidak terdeteksi alat apa pun.
- **Mengandalkan satu platform CI.** Dukungan `-race` dan perilaku penjadwalan berbeda antar OS/arsitektur. Bila produksi berjalan di `linux/amd64`, uji race WAJIB juga berjalan di sana.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `fatal error: concurrent map writes` | stack trace saat crash | Race pada `map`; `recover()` tidak bisa menolong — proses langsung mati |
| Penghitung meleset kecil dan tidak konsisten | apakah semua akses tersinkronisasi | Pembacaan tanpa lock terhadap variabel yang sedang ditulis |
| Field bernilai mustahil (mis. panjang slice negatif) | penyalinan struct antar goroutine | Torn read: struct disalin saat sedang diubah |
| Bug hanya muncul di produksi, tidak di laptop | jumlah core produksi vs lokal | Paralelisme nyata membuka jalur yang tidak pernah terjadi di 1–2 core |
| Konfigurasi kadang terbaca versi lama | mekanisme hot-reload | Penukaran konfigurasi tanpa `atomic.Pointer` |

```bash
# Ulangi dan variasikan paralelisme -- race langka jarang muncul pada percobaan pertama
go test -race -count=20 -cpu=1,2,4,8 ./...

# Hentikan pada laporan pertama dan simpan riwayat akses yang lebih panjang
GORACE="halt_on_error=1 history_size=7 log_path=/tmp/race" go test -race ./...

# Binary ber-race untuk staging -- JANGAN untuk trafik produksi
go build -race -o app-race ./cmd/app

# `concurrent map writes` mematikan proses; cari jejaknya di riwayat restart
kubectl logs -l app=api --previous | grep -A20 'fatal error: concurrent map'
kubectl get pods -l app=api -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}'
```
