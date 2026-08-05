# Sync Primitives Deep Dive

> **Berlaku:** Go 1.21+ (`sync.OnceValue`, `sync.OnceFunc`) · **Lihat juga:** `concurrency/atomic_lockfree_patterns.md` · `concurrency/data_race_detection.md` · `runtime_internals/stdlib_modern_slices_maps_sync.md` · `hft_zero_alloc/memory_arena_batch_alloc.md`

## Konsep Utama
Paket bawaan `sync` menyediakan primitif sinkronisasi tingkat rendah yang melengkapi channel — bukan menggantikannya. Keduanya menjawab masalah yang berbeda, dan memilih berdasarkan "mana yang lebih cepat" adalah cara paling umum memilih yang salah.

| Kebutuhan | Alat |
| :--- | :--- |
| Melindungi akses baca-tulis ke state bersama | `sync.Mutex` / `RWMutex` |
| Memindahkan **kepemilikan** data antar goroutine | channel |
| Koordinasi siklus hidup dan pembatalan | channel + `context` |
| Menghitung, menandai, atau menukar satu nilai | `sync/atomic` |

Mutex memang punya overhead lebih tipis daripada channel untuk melindungi satu variabel — tetapi itu bukan alasan memakainya untuk alur data. Pipeline yang dipaksa memakai mutex kehilangan backpressure alami channel dan menjadi jauh lebih sulit dibuktikan benar.

1. **`sync.Mutex` & `sync.RWMutex`**: Kunci akses perlindungan eksklusif (Exclusive Locks). Varian `RWMutex` memecah kunci menjadi dua jenis: Pembaca (`RLock`) yang izinkan berparalel tanpa batas asalkan tak ada penulis, dan Penulis (`Lock`) yang mutlak tunggal dan menyetop seluruh aktivitas baca.
   - *Starvation Mode (Sejak Go 1.9)*: Dulu, goroutine baru yang beruntung bisa terus "menyerobot" lock dari goroutine lama yang sudah lama antri (karena faktor CPU cache fairness). Kini, jika ada sebuah goroutine menunggu lock lebih dari 1 milidetik, Mutex beralih dari mode *Fast-Spin* ke mode kelaparan (*Starvation/Strict FIFO Queue*). Ia akan melarang pendatang baru memperebutkan kunci hingga antrian paling depan mendapatkan porsi jalan kerjanya.
2. **`sync.Map`**: Implementasi Thread-Safe Hash Map (`map[K]V`) murni bawaan Go. Ini **TIDAK UNTUK** digunakan sehari-hari! Ia diciptakan, dioptimalkan, dan ber-performa sangat tinggi HANYA untuk dua spesifik *use-case*: (a) `Append-Only / Write-Once, Read-Many` layaknya Cache Memori Konfigurasi Aplikasi. (b) Goroutine yang berinteraksi tidak memodifikasi Kunci (Key) yang saling tabrakan (Disjoint set). Pemakaian `sync.Map` di kasus umum justru memperlambat aplikasi.
3. **`sync.Pool`**: Penampungan objek sementara yang bisa dipakai ulang, untuk memangkas tekanan GC pada jalur seperti encoding JSON. Objek di dalamnya **dapat dibuang GC sewaktu-waktu** — jadi Pool tidak pernah boleh dipakai sebagai cache yang isinya diandalkan.

   Sejak Go 1.13 pembuangannya tidak seketika: ada *victim cache*, sehingga objek bertahan sekitar dua siklus GC sebelum benar-benar hilang. Itu mengurangi hentakan alokasi tepat setelah GC, tetapi tidak mengubah aturannya — apa pun yang ada di Pool harus aman untuk hilang kapan saja.
4. **`sync.Once`**: Semantik garansi matematis. Menjamin satu potong blok instruksi tertutup (closure function) hanya akan dieksekusi **tepat satu kali** di sepanjang umur hidup program (sejak *boot-up* hingga *shutdown*), bahkan jika ia dipanggil oleh 5 juta goroutine di fraksi milidetik yang sama identik. Inti dari desain *Singleton Inisialisasi Lazy* di Go.
5. **`sync.Cond`**: Fasilitas Wait/Notify Pattern primitif (Kondisi Variabel). Mengizinkan sepasukan goroutine untuk tidur pulas (tanpa membakar 1% pun siklus CPU) lalu dibangunkan mendadak secara spesifik (`Signal()`) atau massal (`Broadcast()`) apabila syarat variabel luar telah digenapi.

## Diagram ASCII

```text
    RWMutex: Reader-Writer Conflict Simulation
    
    [Time 0ms] 
    Reader 1 -> `mu.RLock()` -> Success. Enters critical section.
    Reader 2 -> `mu.RLock()` -> Success. Enters critical section.
    
    [Time 5ms]
    Writer 1 -> `mu.Lock()`  -> BLOCKED. 
    (Waiting for R1 & R2 to call RUnlock). Writer enters Queue.
    
    [Time 7ms]  <-- The strict Fairness (Anti-Starvation) Guard
    Reader 3 -> `mu.RLock()` -> BLOCKED! 
    (Wait, why blocked if it's a Reader? Because Writer 1 is in the Queue! 
     Go protects the Writer from starving to death by blocking new Readers).
    
    [Time 10ms]
    Reader 1 & 2 finish -> `mu.RUnlock()`.
    Writer 1 proceeds -> Writes data -> `mu.Unlock()`.
    Reader 3 finally proceeds -> Reads data -> `mu.RUnlock()`.
```

## Kode Go Production-Ready

Kode ini mensimulasikan komponen infrastruktur inti (contohnya perute koneksi atau Registry Konfigurasi) yang lazim ditemukan di Backend High-Performance.

```go
package concurrency

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// RegistryConfig melayani pengambilan data berintensitas read sangat tinggi
// (seperti feature flags).
type RegistryConfig struct {
	mu     sync.RWMutex
	flags  map[string]bool
	
	initOnce sync.Once
	isReady  bool
}

func NewRegistryConfig() *RegistryConfig {
	return &RegistryConfig{
		flags: make(map[string]bool),
	}
}

// Bootstrap (Lazy Initialization). Akan dipanggil oleh siapa saja yang pertama 
// butuh akses, tanpa mempedulikan siapa yang duluan sampai.
func (rc *RegistryConfig) Bootstrap() {
	rc.initOnce.Do(func() {
		// Logika lambat misalnya Load dari File atau Network.
		// Dijamin hanya berjalan 1 kali.
		time.Sleep(10 * time.Millisecond) 
		
		rc.mu.Lock()
		defer rc.mu.Unlock()
		rc.flags["maintenance_mode"] = false
		rc.flags["dark_theme"] = true
		rc.isReady = true
	})
}

// CheckFlag mengeksekusi operasi baca cepat yang thread-safe.
func (rc *RegistryConfig) CheckFlag(key string) bool {
	// Pastikan ter-inisialisasi. (Panggilan ke-2 dst tidak akan makan waktu)
	rc.Bootstrap() 

	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.flags[key]
}

// SetFlag mengubah mode (jarang terjadi).
func (rc *RegistryConfig) SetFlag(key string, val bool) {
	rc.Bootstrap()
	
	rc.mu.Lock()
	defer rc.mu.Unlock()
	rc.flags[key] = val
}

// ------------------------------------------
// Object Pool for Garbage Collector Relief
// ------------------------------------------

// jsonBufferPool menghindari jutaan alokasi bytes.Buffer di Memory Heap
// per HTTP Request, mendaur ulang memori lama.
var jsonBufferPool = sync.Pool{
	New: func() interface{} {
		// Pra-alokasikan 1024 bytes (1 KB) memori untuk meminimalisir
		// pemekaran slice (slice growing re-allocations).
		return bytes.NewBuffer(make([]byte, 0, 1024))
	},
}

// batasBufferPool adalah ambang di atas mana buffer TIDAK dikembalikan.
//
// Tanpa ambang ini, satu permintaan yang menghasilkan buffer 10 MB akan
// menitipkannya di pool selamanya, dan RSS proses tetap tinggi permanen
// meski beban sudah lama reda. Pool dirancang untuk objek berumur pendek
// dengan ukuran yang seragam.
const batasBufferPool = 64 << 10 // 64 KB

// FastStringConcat mendemonstrasikan daur ulang objek.
func FastStringConcat(a, b string) string {
	// 1. Dapatkan struct kotor/baru dari Pool (butuh Type Assertion)
	buf := jsonBufferPool.Get().(*bytes.Buffer)

	// 2. CRITICAL: Bersihkan sampah / sisa teks data masa lalu!
	buf.Reset()

	// 3. Tulis (Zero Allocations if capacity holds)
	buf.WriteString(a)
	buf.WriteString("-")
	buf.WriteString(b)

	// bytes.Buffer.String() menyalin isinya, jadi aman mengembalikan buf
	// ke pool setelah baris ini.
	result := buf.String()

	// 4. Kembalikan HANYA bila ukurannya masih wajar. Buffer yang sudah
	//    tumbuh besar dibiarkan di-GC, bukan dititipkan ke pool.
	if buf.Cap() <= batasBufferPool {
		jsonBufferPool.Put(buf)
	}

	return result
}

// ==========================================
// UNIT TEST (-race flag target)
// ==========================================

func TestRegistryConfig_DataRaceFree(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	reg := NewRegistryConfig()
	var wg sync.WaitGroup

	// Spawning 500 Pembaca (Readers)
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = reg.CheckFlag("dark_theme")
			time.Sleep(1 * time.Microsecond)
		}()
	}

	// Spawning 50 Penulis (Writers)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			reg.SetFlag(fmt.Sprintf("feature_%d", idx), true)
		}(i)
	}

	wg.Wait()
	
	if !reg.isReady {
		t.Fatal("Expected system to be completely initialized")
	}
}

func TestFastStringConcat(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	// Uji kebersihan objek daur ulang
	res1 := FastStringConcat("hello", "world")
	res2 := FastStringConcat("foo", "bar")
	
	if res1 != "hello-world" {
		t.Errorf("Unexpected %s", res1)
	}
	// Jika buf.Reset() lupa dipanggil di implementation, res2 akan berisi "hello-worldfoo-bar"
	if res2 != "foo-bar" {
		t.Errorf("Unexpected %s (Did you forget to Reset the pool buffer?)", res2)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyalin Objek `sync.Mutex` Melalui Passing By Value

```go
// ❌ BAD: Mengirim struct yang mengandung mutex tanpa Pointer
func ProcessConfigBad(rc RegistryConfig) { // 'rc' BUKAN pointer! (Tergandakan nilainya di stack memori)
    rc.mu.Lock()  // Ini mengunci MUTEX BARU (Hasil clone)!
    defer rc.mu.Unlock()
    // Mutex asli (original) sama sekali tidak terkunci! 
    // Goroutine lain bisa mengobrak-abrik variabel dengan bebas (Data Race).
}

// ✅ GOOD: Pass by Reference (Pointer)
func ProcessConfigGood(rc *RegistryConfig) {
    rc.mu.Lock() // Mengunci referensi memory mutex yang sejati.
    defer rc.mu.Unlock()
}
```

**Why dangerous:** Struct primitif sinkronisasi di paket `sync` (termasuk `sync.WaitGroup`, `sync.Cond`, `sync.Once`) tidak boleh disalin paska awal mula inisialisasinya. `sync.Mutex` internalnya menyimpan variabel flag berupa `state` (status lock) dan `sema` (semafor antrean). Bila Anda meng-*copy by value* (seperti lewat argumen fungsi atau assignment sama dengan `=`), struct tujuan mendapat kunci tiruan palsu di alamat RAM terpisah. Operasi `.Lock()` Anda hanya menggembok "udara kosong". Aplikasi Production Anda akan kebanjiran bentrokan korupsi Data Race tanpa Anda mengerti sebab musababnya. (*Note: Go linter `go vet` biasanya sudah mencegah ini, tapi tetap sering lolos jika dibungkus struct anonim bersarang*).

### ❌ Anti-Pattern 2: Lock Upgrading pada `sync.RWMutex` (Skenario Deadlock)

```go
// ❌ BAD: Mencoba memegang Lock Eksklusif padahal Reader Lock belum dilepas
func (rc *RegistryConfig) CorruptDeadlockMethod() {
    rc.mu.RLock() // 1. Goroutine mengambil ijin baca
    // ... baca sesuatu ...
    
    // BAD: Anda mencoba menjadi Penulis (Lock), namun karena RLock Anda 
    // belum di-RUnlock(), Mutex akan menanti Reader selesai dulu. 
    // Goroutine ini menanti dirinya sendiri. DEADLOCK ABADI!
    rc.mu.Lock()  
    rc.flags["new"] = true
    rc.mu.Unlock()
    
    rc.mu.RUnlock()
}

// ✅ GOOD: RUnlock() dulu, lalu Lock() -- TAPI WAJIB periksa ulang kondisinya.
func (rc *RegistryConfig) AmbilAtauBuat(key string) bool {
    rc.mu.RLock()
    v, ada := rc.flags[key]
    rc.mu.RUnlock()
    if ada {
        return v
    }

    // ANTARA RUnlock DAN Lock ADA CELAH. Goroutine lain bisa menyisipkan
    // key ini lebih dulu. Melewatkan pemeriksaan kedua di bawah adalah bug
    // TOCTOU klasik: dua goroutine sama-sama menyimpulkan "belum ada",
    // dan yang kedua menimpa hasil yang pertama.
    rc.mu.Lock()
    defer rc.mu.Unlock()
    if v, ada := rc.flags[key]; ada {   // <-- pemeriksaan KEDUA, wajib
        return v
    }
    rc.flags[key] = false
    return false
}
```

**Why dangerous:** Ini jebakan klasik bagi programmer yang terbiasa pada *Reentrant Lock* di Java/C#. Di Go, Mutex **TIDAK** mencatat goroutine mana yang memegangnya — ia tidak reentrant. Ketika `G-99` memanggil `RLock()`, Mutex hanya mencatat "+1 pembaca". Saat `G-99` lalu memanggil `Lock()`, Mutex menunggu **seluruh** pembaca pulang — termasuk +1 miliknya sendiri, yang tidak akan pernah pulang. Goroutine itu menunggu dirinya sendiri: deadlock permanen.

**Dan perbaikannya tidak berhenti di "RUnlock dulu".** Melepas lalu mengambil ulang membuka celah waktu di mana state bisa berubah. Nasihat "RUnlock dulu baru Lock" tanpa pemeriksaan kedua hanya menukar deadlock dengan bug TOCTOU yang jauh lebih sulit terlihat — karena ia tidak menggantung, ia hanya kadang-kadang salah.

## Edge Cases

1. **Retensi Kunci (Lock Retention) yang Lama via Defer dalam Loop**: Kata kunci `defer mu.Unlock()` adalah jurus sakti, NAMUN, eksekusinya hanya dipicu ketika aliran kendali menembus kata kunci `return` pada ujung luar *parent function*. Jika Anda meletakkan `defer mu.Unlock()` di dalam blok `for` yang melakukan perulangan seribu kali pembacaan data, Mutex tersebut tidak akan pernah terlepas dari cengkraman di antara iterasi.
   - *Defensive*: Mutex *Contention* akan hancur lebur. Hindari `defer` di dalam loop jika bisa. Jika harus (karena takut *panic* dalam loop), isolasi *critical section* tersebut ke dalam satu baris closure function murni: `func() { mu.Lock(); defer mu.Unlock(); process(); }()`.

2. **Pengambilan Objek Kotor (Dirty Obsolete Objects) dari `sync.Pool`**: Objek yang dikembalikan dari `pool.Get()` belum tentu kosong atau suci. Ia merupakan perwujudan data "sampah daur ulang" yang ditinggalkan oleh peminjam (caller) beberapa detik lalu. Jika ini adalah `bytes.Buffer` atau custom struct yang menampung informasi user Token, dan Anda gagal menimpa atau me-reset nilainya, informasi sensitif user pertama bisa bocor (Cross Data Leak) tergabung dalam respons JSON milik user kedua.
   - *Defensive*: Wajib hukumnya menyediakan metode `.Reset()` atau re-inisialisasi ke nilai NOL (Zero Value) di *setiap* item detik Anda menarik objek dari Pool, TANPA KECUALI. 

3. **Inisialisasi `sync.WaitGroup` ADD() di Tempat Tertinggal**: Seringkali programmer lupa diri dan memanggil `wg.Add(1)` *di dalam tubuh anonim goroutine* (`go func() { wg.Add(1); ... }()`). 
   - *Defensive*: Operasi instruksi peluncuran `go func()` sifatnya *Asinkron / Non-Blocking* (menyerahkan nasibnya kepada Scheduler Go-Runtime). Sangat jamak terjadi eksekutor goroutine utama keburu melesat maju mengeksekusi instruksi `wg.Wait()`, di saat goroutine kecil-kecil tersebut belum sempat dialokasikan mesinnya (jadi belum sempat `wg.Add(1)`). Program akan instan tamat *return* keluar secara prematur. Hukum besi: **Lakukan wg.Add(1) SELALU dan HARUS di luar/sebelum tubuh go func() dimulai.**

## Kapan JANGAN Pakai Ini

- **`sync.Map` sebagai pengganti umum `map`+mutex.** Ia hanya menang pada dua pola: kunci ditulis sekali lalu dibaca berkali-kali, atau tiap goroutine menyentuh kunci yang saling lepas. Di luar itu ia lebih lambat, dan kehilangan keamanan tipe.
- **`sync.Pool` untuk objek yang mahal dibuat tapi jarang dipakai.** Isi pool dibuang pada setiap siklus GC. Objek yang butuh 200 ms untuk dibangun akan dibangun ulang terus-menerus. Pool dirancang untuk objek berumur pendek dan sangat sering, seperti buffer.
- **`sync.Pool` untuk objek berukuran sangat beragam.** Satu buffer 10 MB yang pernah masuk pool akan tertahan di sana dan membuat RSS tinggi permanen. Buang objek yang melewati ambang ukuran, jangan kembalikan.
- **`RWMutex` dengan asumsi selalu lebih cepat.** Pada critical section yang sangat pendek, pembukuan pembaca lebih mahal daripada keuntungan paralelismenya. `RWMutex` menang bila bagian baca benar-benar lama dan bacanya dominan. Ukur, jangan asumsikan.
- **Mutex untuk koordinasi antar proses.** Mutex hanya berlaku dalam satu proses. Dua pod tidak saling melihat mutexnya, dan kebutuhan itu punya syarat yang sama sekali berbeda — lihat `concurrency/distributed_locks_redis.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 melar sementara CPU rendah | profil mutex | Kontensi: goroutine antre, bukan bekerja |
| Throughput menempel di langit-langit | waktu tunggu lock vs waktu kerja | Critical section terlalu panjang |
| `fatal error: all goroutines are asleep - deadlock!` | urutan pengambilan lock | Lock berurutan terbalik, atau lock upgrading pada `RWMutex` |
| Data pengguna A muncul di respons pengguna B | apakah objek dari pool di-reset | Objek kotor dari `sync.Pool` |
| Data race meski semua akses "sudah pakai mutex" | `go vet` copylocks | Struct pembawa mutex disalin by value |

```bash
# Aktifkan dulu di kode: runtime.SetMutexProfileFraction(5)
go tool pprof -top http://localhost:6060/debug/pprof/mutex
go tool pprof -list 'NamaFungsi' http://localhost:6060/debug/pprof/mutex

# Aktifkan dulu di kode: runtime.SetBlockProfileRate(1)
go tool pprof -top http://localhost:6060/debug/pprof/block

# Menangkap penyalinan struct yang mengandung sync.Mutex / WaitGroup
go vet ./...

# Deadlock yang jarang muncul biasanya butuh pengulangan dan variasi paralelisme
go test -race -count=50 -timeout=2m -cpu=1,4,8 ./...
```
