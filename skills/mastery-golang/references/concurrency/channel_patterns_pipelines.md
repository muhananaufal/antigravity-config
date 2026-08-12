# Channel Patterns & Pipelines

> **Berlaku:** Go 1.21+ · **Lihat juga:** `concurrency/worker_pool_errgroup.md` · `concurrency/goroutine_leak_detection.md` · `runtime_internals/iterators_range_over_func.md` · `hft_zero_alloc/lock_free_ring_buffer.md`

## Konsep Utama
Channels di Go adalah implementasi dari konsep **CSP (Communicating Sequential Processes)**. Di bawah kap mesin (runtime/chan.go), channel adalah struct `hchan` yang mengelola sebuah *circular buffer* (untuk buffered channel), antrean penunggu `recvq` dan `sendq` yang berisi linked-list dari struct `sudog` (merepresentasikan goroutine yang sedang park/terblokir), serta sebuah `mutex` untuk atomicity operasi sinkronisasi. State machine dari channel memastikan bahwa saat data dikirim/diterima, runtime akan melakukan memory copy langsung (memmove) dari stack *sender* ke stack *receiver* untuk mengoptimalkan performa. Dalam arsitektur concurrent modern, channels sangat krusial digunakan untuk membangun **pipelines** yang modular dan terisolasi.

Sebuah pipeline umumnya terdiri dari sekumpulan tahapan (stages). Setiap tahap adalah satu atau sekelompok goroutine yang bertugas:
1. Menerima data dari hulu (upstream) melalui *inbound channels*.
2. Melakukan beberapa transformasi/pemrosesan (workload) pada data tersebut.
3. Mengirim data hasil ke hilir (downstream) melalui *outbound channels*.

Pola-pola penting dalam pipeline concurrency:
- **Generator**: Pola di mana sebuah fungsi memproduksi sequence data (misalnya dari database atau stream) dan memancarkannya lewat channel ke pipeline.
- **Fan-out**: Banyak goroutine membaca dari satu channel yang sama. Yang terjadi adalah **work-stealing alami**: worker yang lebih dulu selesai mengambil item berikutnya. Ini **bukan** round-robin dan **bukan** distribusi merata — runtime tidak menjamin urutan penerima, dan worker yang lebih cepat akan memproses lebih banyak. Sifat itu justru diinginkan (beban mengikuti kapasitas), tetapi jangan mengharapkan pembagian yang rata bila Anda mengukurnya.
- **Fan-in**: Satu goroutine membaca dari banyak channel yang berbeda dan menggabungkannya kembali ke dalam satu channel output tunggal.
- **Done Channel (Cancellation)**: Menggunakan satu channel broadcast (biasanya `chan struct{}`) atau `context.Context` untuk memberi sinyal terminasi ke semua goroutine sekaligus agar berhenti bekerja dan merapikan resource (prevent goroutine leak).

## Diagram ASCII

```text
               +-> [Worker 1] (Stage 2) --+
               |                          |
[Generator] ---+-> [Worker 2] (Stage 2) --+--> [Multiplexer] -> [Consumer]
 (Stage 1)     |                          |      (Fan-in)       (Stage 3)
               +-> [Worker N] (Stage 2) --+
    |                                                      |
    +--------------------- Context Done / Cancel ----------+
```

## Kode Go Production-Ready

Kode di bawah ini mendemonstrasikan implementasi Pipeline lengkap (Generator -> Fan-out -> Fan-in) dengan propagasi `context.Context` untuk memastikan bebas data race dan goroutine leak.

```go
package concurrency

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// Generate mengalirkan array integer ke dalam channel sampai habis 
// atau hingga context dibatalkan secara prematur.
func Generate(ctx context.Context, nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out) // Principle: Sender always closes the channel
		for _, n := range nums {
			select {
			case out <- n:
			case <-ctx.Done():
				// Context dibatalkan, keluar untuk mencegah leak
				return
			}
		}
	}()
	return out
}

// Transformer adalah antarmuka untuk memudahkan mock saat Unit Test
type Transformer interface {
	Transform(val int) (int, error)
}

// MathTransformer adalah implementasi nyata
type MathTransformer struct{}

func (m *MathTransformer) Transform(val int) (int, error) {
	return val * val, nil
}

// Result membawa nilai ATAU galat. Pipeline yang menelan galat diam-diam
// akan menghasilkan keluaran yang lebih sedikit dari masukan tanpa ada
// yang tahu penyebabnya -- dan itu baru terlihat berbulan-bulan kemudian
// sebagai "data kadang hilang".
type Result struct {
	Value int
	Err   error
}

// Process melakukan pekerjaan pada setiap data yang diterima dari hulu.
// Ini mewakili satu stage worker dalam Fan-out.
//
// Galat DITERUSKAN ke hilir, tidak dibuang. Konsumer yang memutuskan
// apakah satu kegagalan berarti seluruh batch gagal, atau cukup dicatat.
func Process(ctx context.Context, in <-chan int, transformer Transformer) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for n := range in {
			val, err := transformer.Transform(n)
			h := Result{Value: val, Err: err}
			if err != nil {
				// Konteks item WAJIB ikut, kalau tidak galatnya tidak bisa
				// ditelusuri kembali ke masukan yang menyebabkannya.
				h.Err = fmt.Errorf("transform %d: %w", n, err)
			}

			select {
			case out <- h:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// Merge melakukan pola Fan-in: membaca dari sejumlah channel 'in' 
// secara concurrent dan menggabungkannya ke satu channel 'out'.
func Merge(ctx context.Context, cs ...<-chan Result) <-chan Result {
	var wg sync.WaitGroup
	out := make(chan Result)

	// Fungsi penolong untuk membaca satu channel spesifik
	output := func(c <-chan Result) {
		defer wg.Done()
		for n := range c {
			select {
			case out <- n:
			case <-ctx.Done():
				return
			}
		}
	}

	// Fan-in listener
	wg.Add(len(cs))
	for _, c := range cs {
		go output(c)
	}

	// Goroutine pembersih: menutup output setelah semua listener selesai.
	go func() {
		wg.Wait()
		close(out)
	}()

	return out
}

// ==========================================
// UNIT TEST
// ==========================================

func TestPipeline(t *testing.T) {
	defer goleak.VerifyNone(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	in := Generate(ctx, 1, 2, 3, 4, 5, 6)
	transformer := &MathTransformer{}

	w1 := Process(ctx, in, transformer)
	w2 := Process(ctx, in, transformer)
	w3 := Process(ctx, in, transformer)

	out := Merge(ctx, w1, w2, w3)

	var results []int
	for h := range out {
		if h.Err != nil {
			t.Errorf("unexpected error: %v", h.Err)
			continue
		}
		results = append(results, h.Value)
	}

	if len(results) != 6 {
		t.Fatalf("expected 6 results, got %d", len(results))
	}

	sum := 0
	for _, v := range results {
		sum += v
	}

	expectedSum := (1 * 1) + (2 * 2) + (3 * 3) + (4 * 4) + (5 * 5) + (6 * 6)
	if sum != expectedSum {
		t.Errorf("expected sum %d, got %d", expectedSum, sum)
	}
}

func TestPipeline_Cancellation(t *testing.T) {
	defer goleak.VerifyNone(t)

	ctx, cancel := context.WithCancel(context.Background())
	
	nums := make([]int, 1000)
	for i := range nums {
		nums[i] = i
	}
	
	in := Generate(ctx, nums...)
	w := Process(ctx, in, &MathTransformer{})
	out := Merge(ctx, w)

	<-out
	cancel() 

	for range out {
		// Draining
	}
}

// MockTransformer mensimulasikan kegagalan jaringan atau error
type MockTransformer struct {
	mu           sync.Mutex
	CalledCounts int
}

func (m *MockTransformer) Transform(val int) (int, error) {
	m.mu.Lock()
	m.CalledCounts++
	m.mu.Unlock()
	if val%2 == 0 {
		return 0, fmt.Errorf("mock error for even number")
	}
	return val * 10, nil
}

func TestPipeline_WithMockError(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mock := &MockTransformer{}
	in := Generate(ctx, 1, 2, 3, 4) // 2 dan 4 akan gagal
	w := Process(ctx, in, mock)
	out := Merge(ctx, w)

	var successes []int
	var errorsList []error
	for h := range out {
		if h.Err != nil {
			errorsList = append(errorsList, h.Err)
			continue
		}
		successes = append(successes, h.Value)
	}

	// Jumlah keluaran WAJIB sama dengan jumlah masukan. Pipeline yang
	// menelan galat akan menghasilkan 2, dan tidak ada yang tahu 2 lainnya
	// ke mana -- itulah yang diuji baris ini.
	if len(successes)+len(errorsList) != 4 {
		t.Fatalf("every input must produce exactly one output; got %d", len(successes)+len(errorsList))
	}
	if len(successes) != 2 || len(errorsList) != 2 {
		t.Fatalf("want 2 successes and 2 errors, got %d and %d", len(successes), len(errorsList))
	}

	// Galat WAJIB membawa konteks item yang menyebabkannya.
	for _, e := range errorsList {
		if !strings.Contains(e.Error(), "transform ") {
			t.Errorf("error missing item context: %v", e)
		}
	}

	if successes[0]+successes[1] != 40 { // 1*10 + 3*10
		t.Errorf("want sum 40, got %d", successes[0]+successes[1])
	}
	if mock.CalledCounts != 4 {
		t.Errorf("want mock called 4 times, got %d", mock.CalledCounts)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Receiver Menutup Channel

```go
// ❌ BAD: Receiver yang menutup channel
func badReceiver(ch chan int) {
    defer close(ch) // BAD: Memicu panic jika sender masih menulis ke channel ini
    <-ch
}

// ✅ GOOD: Sender yang bertanggung jawab menutup channel
func goodSender() <-chan int {
    ch := make(chan int)
    go func() {
        defer close(ch) // GOOD: Sender tahu persis kapan pengiriman selesai
        ch <- 1
    }()
    return ch
}
```

**Why dangerous**: Aturan emas di Go: "Hanya *sender* (pihak yang mengirim) yang boleh menutup channel". Jika goroutine *receiver* menutup channel, sementara *sender* masih mencoba melakukan `ch <- value`, sistem akan melempar *panic* yang tak bisa di-recover (`panic: send on closed channel`), membuat production service crash seketika.

### ❌ Anti-Pattern 2: Mengabaikan Context/Done Channel saat Menulis (Blocking Send)

```go
// ❌ BAD: Mengirim tanpa menghiraukan sinyal pembatalan
func badWorker(ctx context.Context, in <-chan int, out chan<- int) {
    for n := range in {
        // BAD: Jika tidak ada consumer yang membaca 'out', dan sistem mau shutdown,
        // goroutine ini akan terblokir abadi (Goroutine Leak).
        out <- n 
    }
}

// ✅ GOOD: Menggunakan select dengan <-ctx.Done()
func goodWorker(ctx context.Context, in <-chan int, out chan<- int) {
    for n := range in {
        select {
        case out <- n:
        case <-ctx.Done(): // GOOD: Bisa lolos keluar jika context dibatalkan
            return
        }
    }
}
```

**Why dangerous**: Goroutine Leak yang sangat senyap. Jika ada pembatalan di tahap akhir pipeline (misal koneksi HTTP terputus atau timeout), goroutine di tahap hulu (upstream) bisa tersangkut mencoba menulis ke `out <- n` saat *receiver* di hilir sudah pergi dan tidak membaca channel itu lagi. Goroutine ini akan tertahan di RAM selamanya, menyebabkan kehabisan resource memori seiring waktu (OOM Killer).

## Edge Cases

1. **Nil Channels Block Forever**: Mengirim atau membaca dari channel yang bernilai `nil` (yaitu channel yang tidak pernah diinisialisasi dengan `make`) akan memblokir eksekusi selamanya (bukan panic). 
   - *Defensive*: Manfaatkan perilaku *aneh* ini di dalam blok `select` dengan mengatur (set) channel menjadi `nil` setelah ia di-close. Ini akan secara elegan "mematikan" (disable) `case` channel tersebut di *event loop* `select`, mencegah `select` terus-menerus terpanggil dengan nilai nol dari closed channel.

2. **Spinning Select (Default Case Empty Loop)**: Menggunakan blok `default` di dalam `select` membuat operasi bersifat *non-blocking*. Namun, jika dimasukkan ke dalam loop `for` tanpa jeda (`for { select { default: } }`), ini akan berputar secepat kecepatan CPU (busy-wait), menyebabkan 100% CPU usage pada core tersebut dan membakar energi tanpa hasil.
   - *Defensive*: Hindari penggunaan `default` dalam loop yang tidak terikat waktu, kecuali Anda secara sadar mengimplementasikan pola *backoff* atau *throttle* (menggunakan `time.Sleep`). Gunakan `select` yang sepenuhnya blocking.

3. **Overly Buffered Channels sebagai Silver Bullet**: Menggunakan buffered channel yang kapasitasnya diset sangat besar (misal `make(chan int, 100000)`) seringkali dilakukan untuk mengatasi "lag" pada sistem, padahal ini menyembunyikan arsitektur pipeline yang buruk. *Sender* akan melesat cepat mengisi memori sementara *receiver* lambat (bottleneck tidak terpecahkan), menyebabkan spike Memory OOM yang dahsyat.
   - *Defensive*: Mulai desain pipeline selalu dengan channel unbuffered (`size 0`) untuk memastikan aliran tersinkronisasi 1:1. Jika memang butuh buffer untuk menoleransi burst traffic, gunakan ukuran sekecil mungkin yang terukur (misal `size 5` atau `10`), dan tingkatkan perlahan jika terbukti melegakan bottleneck, bukan diset tinggi sejak awal.

## Kapan JANGAN Pakai Ini

- **Sebagai antrean pekerjaan.** Channel tidak bisa diperiksa panjangnya secara bermakna, tidak bisa diprioritaskan, tidak bisa di-retry, dan isinya lenyap saat proses mati. Bila pekerjaannya tidak boleh hilang, yang dibutuhkan antrean sungguhan — lihat `background_jobs_worker/`.
- **Untuk melindungi satu variabel.** `mutex` atau `atomic` lebih murah, lebih pendek, dan lebih mudah dibaca daripada goroutine penjaga yang berkomunikasi lewat channel.
- **Untuk melewatkan data yang tidak butuh konkurensi.** Pipeline tiga tahap dengan tiga goroutine hanya untuk mentransformasi slice adalah kerumitan tanpa imbalan. `iter.Seq` melakukan hal yang sama tanpa goroutine — lihat `runtime_internals/iterators_range_over_func.md`.
- **Lintas proses atau lintas mesin.** Channel adalah konstruksi dalam-proses. Aliran yang harus bertahan melewati restart membutuhkan outbox atau message broker.
- **Pada jalur latensi sangat rendah.** Setiap operasi channel melibatkan lock runtime dan kemungkinan penjadwalan ulang goroutine. Di jalur mikrodetik, ring buffer lock-free adalah alat yang benar — lihat `hft_zero_alloc/lock_free_ring_buffer.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu core 100% tanpa kemajuan | profil CPU pada `select` | `default:` di dalam loop tanpa jeda (busy-wait) |
| RSS melonjak saat trafik naik | kapasitas buffer channel | Buffer besar menyembunyikan hilir yang lambat |
| p99 melompat berkala | tahap pipeline yang paling lambat | Backpressure mengunci hulu sampai hilir menyusul |
| Goroutine menumpuk pada `chan send` | `pprof/goroutine?debug=2` | Consumer sudah pergi; pengirim tidak memeriksa `ctx.Done()` |
| `panic: send on closed channel` | siapa yang memanggil `close` | Receiver menutup channel; hanya sender yang boleh |

```bash
# Busy-wait terlihat sebagai runtime.selectgo yang mendominasi profil CPU
go tool pprof -top 'http://localhost:6060/debug/pprof/profile?seconds=30'

# Distribusi status goroutine: banyak 'chan send' = hilir tidak mengonsumsi
curl -s 'localhost:6060/debug/pprof/goroutine?debug=2' \
  | grep -oE '\[chan (send|receive)[^]]*\]' | sort | uniq -c | sort -rn

# Penjadwal kelebihan beban: runqueue panjang menandakan goroutine terlalu banyak
GODEBUG=schedtrace=1000 ./app 2>&1 | head -20
```
