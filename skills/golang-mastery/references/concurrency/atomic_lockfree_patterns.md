# Atomic Operations & Lock-Free Patterns

## Konsep Utama
Paket `sync/atomic` menyediakan primitif operasi atomic pada level hardware. Operasi atomic memastikan akses ke memori dilakukan secara aman tanpa interupsi *concurrent*, dan menjadi fondasi utama untuk membangun *lock-free* dan *wait-free* data structures. Dibandingkan `sync.Mutex` yang memblokir goroutine dan melakukan *context-switching* pada level OS (mahal), operasi atomic diselesaikan dalam satu atau beberapa instruksi CPU saja (sangat cepat).

1. **Primitive Operations**: Menyediakan fungsi dasar `Add`, `CompareAndSwap` (CAS), `Load`, dan `Store` untuk tipe bilangan bulat dasar (`int32`, `int64`, `uint32`, `uint64`, `uintptr`).
2. **CAS (Compare-And-Swap)**: Jantung dari operasi lock-free. Mekanismenya: membaca suatu nilai lama dari memori, memeriksa apakah nilainya masih sama dengan yang dibaca, dan jika iya, mengubahnya menjadi nilai baru secara atomik. Jika di antara waktu itu ada goroutine lain yang sudah mengubahnya, CAS akan gagal (`false`). Goroutine pemanggil kemudian harus mengulang kembali (looping) proses pembacaan dan perhitungan (disebut *CAS Loop*).
3. **`atomic.Value` & Hot Reload**: Tipe serbaguna (pre-Go 1.19) untuk menyimpan dan mengambil nilai tipe `any` (interface{}) secara atomik. Sangat sering digunakan untuk *Hot-Reloading* konfigurasi, di mana ada satu goroutine *writer* yang rutin mem-push konfigurasi baru, dan ribuan goroutine *readers* yang membacanya tanpa pernah terblokir *lock*.
4. **`atomic.Pointer[T]` (Go 1.19+)**: Pembungkus generic dan type-safe yang sepenuhnya menggantikan kebutuhan untuk melakukan *type-assertion* manual (dan rentan panic) pada `atomic.Value`. Ini adalah standar industri terbaru.
5. **Memory Ordering (Happens-Before)**: Go menjamin *sequential consistency* dari semua fungsi di package atomic. Artinya, jika goroutine A melakukan atomic `Store` dan goroutine B melihat nilai tersebut via atomic `Load`, semua penulisan memori yang dilakukan A sebelum `Store` dijamin akan terlihat oleh B (*Happens-Before relationship*). Tidak ada instruction reordering yang akan merusak logika data.

## Diagram ASCII

```text
    CAS (Compare-And-Swap) Loop Concept
    
    [ Goroutine A ]                           [ Memory Address X ]
           |                                          | (Value: 5)
    1. Read value (5) <-------------------------------+
           |
    2. Compute new (5+1 = 6)
           |
    3. CAS(old=5, new=6) ---------------------------> + (Matches 5! Changes to 6)
           |                                          |
    [ Goroutine B ]                                   |
           |                                          |
    1. Read value (5) <-------------------------------+
           |                                          | (Value is now 6)
    2. Compute new (5+2 = 7)                          |
           |                                          |
    3. CAS(old=5, new=7) ---------------------------> + (Fails! Current is 6, not 5)
           |                                          |
    4. Loop back, re-read (reads 6) <-----------------+
    5. Compute new (6+2 = 8)
    6. CAS(old=6, new=8) ---------------------------> + (Success, Value = 8)
```

## Kode Go Production-Ready

Kode berikut mendemonstrasikan implementasi lock-free untuk hot-reloading konfigurasi menggunakan `atomic.Pointer` dan implementasi lock-free counter.

```go
package concurrency

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// Config merupakan struct konfigurasi kompleks yang akan di-reload secara hot.
type Config struct {
	MaxWorkers int
	DSN        string
	Timeout    time.Duration
}

// ConfigHolder mendemonstrasikan pattern Lock-Free Hot Reload 
// menggunakan tipe generic baru di Go 1.19+, atomic.Pointer[T].
// Ini memastikan type safety tanpa perlu mutex.
type ConfigHolder struct {
	config atomic.Pointer[Config]
}

// NewConfigHolder menginisialisasi config holder dengan nilai awal.
func NewConfigHolder(initial *Config) *ConfigHolder {
	ch := &ConfigHolder{}
	ch.config.Store(initial)
	return ch
}

// Get me-return configurasi saat ini tanpa lock.
// Sangat cepat, wait-free, dan aman dari data race.
func (ch *ConfigHolder) Get() *Config {
	return ch.config.Load()
}

// Update menyimpan konfigurasi baru secara atomik.
func (ch *ConfigHolder) Update(ctx context.Context, newConfig *Config) error {
	if newConfig == nil {
		return fmt.Errorf("context: %w", fmt.Errorf("new config cannot be nil"))
	}
	ch.config.Store(newConfig)
	return nil
}

// LockFreeCounter mendemonstrasikan penggunaan primitif atomic klasik
// untuk performa ultra-tinggi dalam operasi matematis concurrent.
type LockFreeCounter struct {
	// Menggunakan Go 1.19+ types, equivalent to atomic.AddInt64(&c, 1)
	count atomic.Int64 
}

// Inc menambahkan counter sebesar 1 secara atomik.
func (c *LockFreeCounter) Inc() {
	c.count.Add(1)
}

// Add menambahkan counter dengan nilai tertentu secara atomik.
func (c *LockFreeCounter) Add(delta int64) {
	c.count.Add(delta)
}

// Val mengembalikan nilai counter saat ini.
func (c *LockFreeCounter) Val() int64 {
	return c.count.Load()
}

// ==========================================
// UNIT TEST
// ==========================================

func TestAtomicConfigHotReload(t *testing.T) {
	defer goleak.VerifyNone(t)

	initialCfg := &Config{MaxWorkers: 10, DSN: "postgres://db1", Timeout: 1 * time.Second}
	holder := NewConfigHolder(initialCfg)

	var wg sync.WaitGroup
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start 100 reader goroutines. Mereka membaca konfigurasi ribuan kali
	// tanpa diblokir oleh Mutex (Lock-Free).
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				cfg := holder.Get()
				if cfg.MaxWorkers < 10 {
					t.Errorf("Invalid MaxWorkers read: %d", cfg.MaxWorkers)
				}
				// Simulasi kerja kecil
				time.Sleep(1 * time.Microsecond)
			}
		}()
	}

	// Hot reload (Writer) goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond) // Let readers run a bit
		newCfg := &Config{MaxWorkers: 50, DSN: "postgres://db2", Timeout: 5 * time.Second}
		err := holder.Update(ctx, newCfg) // Atomically swap pointer
		if err != nil {
			t.Errorf("Failed to update config: %v", err)
		}
	}()

	wg.Wait()
	
	finalCfg := holder.Get()
	if finalCfg.MaxWorkers != 50 {
		t.Errorf("Expected 50, got %d", finalCfg.MaxWorkers)
	}
}

func TestLockFreeCounter(t *testing.T) {
	defer goleak.VerifyNone(t)

	counter := &LockFreeCounter{}
	var wg sync.WaitGroup
	
	// 1000 concurrent increments
	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counter.Inc()
		}()
	}
	
	wg.Wait()
	if counter.Val() != 1000 {
		t.Errorf("Expected 1000, got %d", counter.Val())
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Tipe yang Berbeda ke `atomic.Value`

```go
// ❌ BAD: Menggunakan atomic.Value tanpa jaminan tipe yang konsisten
var val atomic.Value
val.Store(10) // Store integer
val.Store("hello") // PANIC saat runtime! Tipe tidak konsisten.
// BAD: Tipe data abstrak `atomic.Value` mengharuskan tipe konsisten.

// ✅ GOOD: Gunakan Go 1.19+ `atomic.Pointer[T]` untuk jaminan compile-time
var cfg atomic.Pointer[Config]
cfg.Store(&Config{})
// GOOD: Go compiler memastikan hanya pointer dari struct Config yang bisa di-store.
```

**Why dangerous:** `atomic.Value` di Go pre-1.19 menerima `interface{}`. Jika Anda melakukan `Store()` dengan objek yang tipenya berbeda dari *Store pertama* (misal pertama kali diisi struct `ConfigA`, lalu dipaksa `Store` struct `ConfigB`), runtime Go akan otomatis panic (`panic: sync/atomic: store of inconsistently typed value into Value`). Hal ini dapat menumbangkan seluruh sistem di *production* tanpa terdeteksi saat *compile-time*.

### ❌ Anti-Pattern 2: Mencampur Atomic dengan Mutex (Hybrid Access)

```go
// ❌ BAD: Read dengan atomic, tapi Write dengan Mutex
type BadStruct struct {
    mu sync.Mutex
    val int64
}
func (b *BadStruct) Set() {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.val = 99 // Penulisan non-atomic
}
func (b *BadStruct) Get() int64 {
    return atomic.LoadInt64(&b.val) // Pembacaan atomic tanpa Mutex. RACE!
}
// BAD: Mutex dan Atomic beroperasi pada level yang berbeda. Penulisan non-atomic dengan mutex tidak menyinkronkan memori dengan Load atomic di hardware tertentu.

// ✅ GOOD: Konsisten menggunakan atomic untuk semua akses ke variabel tersebut
type GoodStruct struct {
    val atomic.Int64
}
func (b *GoodStruct) Set() {
    b.val.Store(99)
}
func (b *GoodStruct) Get() int64 {
    return b.val.Load()
}
// GOOD: Memori selalu konsisten diakses menggunakan hardware atomic instructions.
```

**Why dangerous:** Seringkali engineer berasumsi bahwa karena writer sudah terproteksi oleh `sync.Mutex`, pembaca (`reader`) cukup menggunakan `atomic.Load`. Hal ini merusak *Memory Consistency*. Di beberapa arsitektur, operasi write biasa di dalam mutex mungkin tidak segera di-flush ke *main memory* jika tidak ada instruksi atomic padanya. Akibatnya, `atomic.Load` bisa membaca nilai basi (stale) atau berpotensi mengalami *torn read* pada tipe 64-bit di mesin 32-bit (Silent Data Corruption / Data Race).

## Edge Cases

1. **ABA Problem pada CAS**: Saat melakukan CAS dalam loop, operasi mengecek (Compare) "apakah memori ini bernilai A?". Jika ya, tukar (Swap) dengan B. Masalah muncul jika goroutine X membaca memori adalah A. Lalu ia tertidur (context switch). Goroutine Y masuk, mengubah A ke B, lalu goroutine Z mengubahnya kembali dari B menjadi A. Goroutine X bangun, melihat bahwa nilainya *masih* A, dan melanjutkan Swap-nya. Walaupun CAS berhasil, integritas *state flow* program (kejadian transisi ke B lalu ke A) sebenarnya telah terlewatkan.
   - *Defensive*: Di Go, masalah ini sering dimitigasi dengan selalu mengalokasikan objek baru pada *Pointer* (mengubah alamat memori alih-alih nilai integer), sehingga pointer alamat lama dan baru tidak akan pernah sama (A != A'). Cara lain adalah menambahkan variabel "Version/Epoch" yang increment secara atomik.

2. **False Sharing (Cache Line Bouncing)**: Struktur data dengan multiple variabel atomic bersebelahan di memori yang sama (misal struct array dengan puluhan `atomic.Int64`). Ketika goroutine pada CPU Core 1 meng-update field pertama, dan CPU Core 2 meng-update field kedua, perangkat keras (CPU Cache) akan terus membatalkan (invalidate) Cache Line ukuran 64-byte secara penuh. Hal ini membuat performa anjlok drastis (bisa 10x-100x lipat), seolah-olah core tersebut terblokir mutex padahal menggunakan atomic.
   - *Defensive*: Gunakan padding byte di struct (misal `_ [64]byte`) untuk menjauhkan variabel atomic agar berada di *Cache Line* hardware yang berbeda secara fisik.

3. **Loop CAS Tak Berujung (Livelock)**: Dalam sistem dengan concurrency ekstrem (ribuan goroutine berebut meng-update satu atomic variable dengan CAS loop), beberapa goroutine mungkin terus-menerus kalah *balapan* (CAS return `false`) dan tidak bisa maju, sehingga terjebak loop membakar CPU selamanya (CPU bound spinning).
   - *Defensive*: Sisipkan backoff strategy seperti `runtime.Gosched()` untuk memberi kesempatan pada goroutine lain, atau batasi iterasi maksimal (maksimal `N` kali retries sebelum *fallback* ke `sync.Mutex` atau mengembalikan error).
