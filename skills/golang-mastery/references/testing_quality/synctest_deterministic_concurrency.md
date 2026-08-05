# testing/synctest — Menguji Konkurensi Secara Deterministik

> **Berlaku:** Go 1.24 (di balik `GOEXPERIMENT=synctest`) · Go 1.25+ (stabil, tanpa flag) · **Lihat juga:** `concurrency/context_cancellation_timeout.md` · `concurrency/goroutine_leak_detection.md` · `distributed_patterns_resilience/retry_backoff_jitter.md`

## Konsep Utama

Test konkurensi di Go rapuh karena satu alasan: **ia bergantung pada waktu nyata**. Pola yang ada di hampir setiap repo Go:

```go
go worker()
time.Sleep(100 * time.Millisecond) // "semoga worker sudah jalan"
assertSomething()
```

Ini rusak dua arah sekaligus. Di laptop cepat, 100ms terbuang percuma pada tiap test. Di CI yang sibuk, 100ms **tidak cukup**, test gagal acak, lalu seseorang menaikkannya jadi 500ms — dan suite Anda pelan-pelan menjadi lambat sekaligus tetap rapuh.

`testing/synctest` menghapus seluruh kelas masalah ini dengan satu ide: **gelembung (bubble) berisi waktu palsu yang hanya bergerak ketika seluruh goroutine di dalamnya benar-benar terhenti.**

### Cara kerjanya

`synctest.Test` menjalankan fungsi di dalam gelembung. Di dalamnya:

1. Jam dimulai dari `2000-01-01 00:00:00 UTC` dan **tidak berjalan** selama masih ada goroutine yang bisa maju.
2. Ketika **semua** goroutine di gelembung *durably blocked*, jam melompat maju ke deadline terdekat — seketika.
3. `time.Sleep(24 * time.Hour)` selesai dalam mikrodetik, bukan sehari.

**Durably blocked** artinya terhenti dengan cara yang hanya bisa dibangunkan oleh goroutine lain di dalam gelembung yang sama:

| Durably blocked ✅ | TIDAK durably blocked ❌ |
| :--- | :--- |
| Kirim/terima pada channel yang dibuat **di dalam** gelembung | Channel yang dibuat di luar gelembung |
| `select` yang seluruh case-nya channel gelembung | Syscall, I/O jaringan, baca berkas |
| `time.Sleep`, `time.After`, `time.Ticker` | `sync.Mutex.Lock` |
| `sync.WaitGroup.Wait`, `sync.Cond.Wait` | `runtime.Gosched`, spin loop |
| `synctest.Wait` | Menunggu proses eksternal |

Perbedaan ini bukan detail — **inilah sumber hampir semua kebingungan saat pertama memakai synctest**. Kalau ada satu goroutine yang menunggu I/O nyata, jam tidak akan pernah maju, dan test Anda menggantung.

### Dua kemampuan sekaligus

| Kemampuan | Dampaknya |
| :--- | :--- |
| Waktu palsu instan | Test timeout, backoff, TTL cache, dan cron selesai dalam mikrodetik |
| Deteksi deadlock | Bila seluruh gelembung macet permanen, `synctest` **panic** alih-alih menggantung sampai CI timeout |

Yang kedua sering terlewat padahal sama berharganya: deadlock yang biasanya muncul sebagai "CI hang 10 menit lalu dibunuh" kini muncul sebagai kegagalan test dengan stack trace.

## Diagram ASCII

```text
   WAKTU NYATA vs WAKTU GELEMBUNG

   TANPA synctest — test menunggu sungguhan
   
   t=0ms    go worker()
   t=0ms    time.Sleep(100ms) ....................... CPU idle, 100ms terbuang
   t=100ms  assert
   
   suite 200 test x 100ms = 20 detik hanya untuk menunggu

   ---------------------------------------------------------------

   DENGAN synctest — jam melompat saat semua terhenti

   bubble start (jam palsu = 2000-01-01T00:00:00Z)
        |
        |  goroutine A: time.Sleep(1 jam)   -> durably blocked
        |  goroutine B: <-ch (ch di bubble) -> durably blocked
        |  goroutine utama: synctest.Wait() -> durably blocked
        |
        v  SEMUA terhenti -> jam LOMPAT ke deadline terdekat
        |
        |  jam palsu = 01:00:00Z, A bangun
        v
   selesai dalam ~50 mikrodetik waktu nyata

   ---------------------------------------------------------------

   JEBAKAN: satu goroutine memakai I/O NYATA

        goroutine A: time.Sleep(1 jam)     -> durably blocked
        goroutine C: http.Get("...")       -> TIDAK durably blocked
                                              ^
        jam TIDAK PERNAH maju --------------'
        A tidur selamanya, test menggantung sampai timeout

        Solusi: seluruh I/O di dalam gelembung WAJIB dipalsukan.
```

## Kode Go Production-Ready

Klien HTTP dengan retry eksponensial — kode produksi biasa, tanpa kompromi demi test.

```go
package retryclient

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"
)

// Doer memisahkan klien dari *http.Client agar bisa dipalsukan di test.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Config mengatur perilaku retry.
type Config struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// DefaultConfig memberi backoff eksponensial 100ms, 200ms, 400ms, ...
func DefaultConfig() Config {
	return Config{MaxAttempts: 5, BaseDelay: 100 * time.Millisecond, MaxDelay: 10 * time.Second}
}

// Client melakukan request dengan retry pada kegagalan sementara.
type Client struct {
	HTTP Doer
	Cfg  Config
}

// ErrHabisPercobaan dikembalikan bila seluruh percobaan gagal.
var ErrHabisPercobaan = errors.New("retryclient: percobaan habis")

// backoff menghitung jeda untuk percobaan ke-n (0-indexed), dibatasi MaxDelay.
//
// TIDAK ADA JITTER di sini, dan itu keputusan sadar yang perlu dinyatakan —
// bukan kelalaian. Backoff eksponensial murni membuat seluruh klien yang
// gagal pada detik yang sama mencoba lagi pada detik yang sama pula:
// hilir yang baru pulih langsung dihantam serentak dan jatuh kembali. Untuk
// produksi, jitter WAJIB (lihat `distributed_patterns_resilience/retry_backoff_jitter.md`).
//
// Yang menarik justru interaksinya dengan berkas ini: begitu jitter masuk,
// asersi `elapsed == 300ms` di uji tidak lagi mungkin. Cara mempertahankan
// determinisme adalah MENYUNTIKKAN sumber acaknya —
//
//	type Config struct { ...; Jitter func(time.Duration) time.Duration }
//
// — lalu memberi fungsi identitas di dalam gelembung. Jam palsu synctest
// menghapus ketergantungan pada waktu; sumber acak yang disuntikkan
// menghapus ketergantungan pada keberuntungan. Keduanya diperlukan untuk
// uji yang benar-benar deterministik.
func (c Client) backoff(attempt int) time.Duration {
	d := time.Duration(float64(c.Cfg.BaseDelay) * math.Pow(2, float64(attempt)))
	if d > c.Cfg.MaxDelay {
		return c.Cfg.MaxDelay
	}
	return d
}

// layakDiulang menentukan apakah status HTTP pantas dicoba lagi.
func layakDiulang(code int) bool {
	return code == http.StatusTooManyRequests ||
		code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable ||
		code == http.StatusGatewayTimeout
}

// Get menjalankan GET dengan retry. Menghormati pembatalan context pada
// SETIAP titik tunggu — inilah yang paling sering salah dan paling sulit diuji
// tanpa synctest.
func (c Client) Get(ctx context.Context, url string) (*http.Response, error) {
	var lastErr error

	for attempt := 0; attempt < c.Cfg.MaxAttempts; attempt++ {
		if attempt > 0 {
			// Jeda WAJIB bisa dibatalkan. Memakai time.Sleep di sini adalah bug:
			// context yang sudah dibatalkan tetap menunggu sampai jeda habis.
			t := time.NewTimer(c.backoff(attempt - 1))
			select {
			case <-ctx.Done():
				t.Stop()
				return nil, fmt.Errorf("batal saat menunggu percobaan %d: %w", attempt+1, ctx.Err())
			case <-t.C:
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("bangun request: %w", err)
		}

		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if layakDiulang(resp.StatusCode) {
			resp.Body.Close()
			lastErr = fmt.Errorf("status %d layak diulang", resp.StatusCode)
			continue
		}
		return resp, nil
	}

	// Context yang sudah dibatalkan WAJIB dilaporkan sebagai pembatalan,
	// bukan sebagai "percobaan habis".
	//
	// Tanpa pemeriksaan ini ada satu celah sempit yang mahal: bila
	// pembatalan datang saat percobaan TERAKHIR sedang berjalan, loop
	// selesai tanpa pernah menyentuh cabang <-ctx.Done() — dan pemanggil
	// menerima ErrHabisPercobaan. Akibatnya `errors.Is(err, context.Canceled)`
	// bernilai false, sehingga lapisan di atas memperlakukan pembatalan
	// pengguna sebagai kegagalan hilir: ia mencatatnya sebagai galat,
	// menghitungnya ke error rate, dan bisa membuka circuit breaker karena
	// pengguna menutup tab.
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("batal setelah %d percobaan: %w", c.Cfg.MaxAttempts, err)
	}
	return nil, fmt.Errorf("%w setelah %d percobaan: %v", ErrHabisPercobaan, c.Cfg.MaxAttempts, lastErr)
}
```

## Uji

```go
package retryclient

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// fakeDoer menjawab tanpa I/O nyata. WAJIB begini di dalam gelembung —
// http.Client sungguhan tidak pernah durably blocked dan akan menggantungkan test.
type fakeDoer struct {
	calls  atomic.Int32
	status []int // status yang dikembalikan berurutan
	err    error
}

func (f *fakeDoer) Do(_ *http.Request) (*http.Response, error) {
	n := int(f.calls.Add(1)) - 1
	if f.err != nil {
		return nil, f.err
	}
	code := f.status[len(f.status)-1]
	if n < len(f.status) {
		code = f.status[n]
	}
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader("")),
	}, nil
}

func TestGet_RetrySampaiBerhasil(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeDoer{status: []int{503, 503, 200}}
		c := Client{HTTP: f, Cfg: DefaultConfig()}

		mulai := time.Now() // jam palsu di dalam gelembung
		resp, err := c.Get(context.Background(), "http://contoh.test")
		if err != nil {
			t.Fatalf("tak terduga: %v", err)
		}
		defer resp.Body.Close() // body respons SUKSES juga wajib ditutup
		if resp.StatusCode != 200 {
			t.Fatalf("want 200, got %d", resp.StatusCode)
		}
		if got := f.calls.Load(); got != 3 {
			t.Fatalf("want 3 attempts, got %d", got)
		}

		// Backoff 100ms + 200ms = 300ms waktu GELEMBUNG.
		// Test ini selesai dalam mikrodetik waktu nyata.
		if elapsed := time.Since(mulai); elapsed != 300*time.Millisecond {
			t.Fatalf("want 300ms bubble time, got %v", elapsed)
		}
	})
}

func TestGet_ContextDibatalkanSaatMenungguBackoff(t *testing.T) {
	// Inilah bug yang hampir mustahil diuji andal tanpa synctest:
	// pembatalan yang datang DI TENGAH jeda backoff.
	synctest.Test(t, func(t *testing.T) {
		f := &fakeDoer{status: []int{503}}
		c := Client{HTTP: f, Cfg: DefaultConfig()}

		// Kita perlu channel dengan kapasitas 1 agar worker yang selesai lebih
		// dulu setelah t.FailNow tidak memblokir dan bocor.
		errCh := make(chan error, 1)
		ctx, cancel := context.WithCancel(context.Background())

		go func() {
			_, err := c.Get(ctx, "http://contoh.test")
			errCh <- err
		}()

		// Menjamin goroutine worker mendapat giliran berjalan dan
		// mencapai `c.Get` yang kita tahu akan memblokir tanpa batas.
		synctest.Wait()
		cancel()

		err := <-errCh
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
		// Hanya satu percobaan yang sempat jalan sebelum dibatalkan.
		if got := f.calls.Load(); got != 1 {
			t.Fatalf("want 1 attempt, got %d", got)
		}
	})
}

func TestGet_HabisPercobaan(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeDoer{status: []int{503}}
		c := Client{HTTP: f, Cfg: Config{MaxAttempts: 4, BaseDelay: time.Second, MaxDelay: time.Minute}}

		_, err := c.Get(context.Background(), "http://contoh.test")
		if !errors.Is(err, ErrHabisPercobaan) {
			t.Fatalf("want ErrHabisPercobaan, got %v", err)
		}
		if got := f.calls.Load(); got != 4 {
			t.Fatalf("want 4 attempts, got %d", got)
		}
	})
}

func TestBackoff_DibatasiMaxDelay(t *testing.T) {
	c := Client{Cfg: Config{BaseDelay: time.Second, MaxDelay: 5 * time.Second}}
	if got := c.backoff(10); got != 5*time.Second {
		t.Fatalf("want bounded 5s, got %v", got)
	}
}
```

Menjalankan pada Go 1.24 (eksperimental):

```bash
GOEXPERIMENT=synctest go test ./...
# Go 1.25+ : cukup `go test ./...`
```

## Anti-Pattern

**❌ SALAH — `time.Sleep` sebagai sinkronisasi**

```go
func TestWorker(t *testing.T) {
	q := NewQueue()
	go q.Process()
	q.Push("job")

	time.Sleep(50 * time.Millisecond) // berdoa
	if q.Done() != 1 {
		t.Fatal("job belum selesai")
	}
}
```

Rapuh di CI yang sibuk, lambat di laptop cepat, dan **menyembunyikan bug**: kalau worker sebenarnya butuh 60ms, test ini gagal acak dan orang akan menaikkan sleep-nya alih-alih memperbaiki penyebabnya.

**✅ BENAR — `synctest.Wait` menunggu keadaan, bukan durasi**

```go
func TestWorker(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := NewQueue()
		go q.Process()
		q.Push("job")

		synctest.Wait() // kembali tepat saat semua goroutine terhenti
		if q.Done() != 1 {
			t.Fatal("job belum selesai")
		}
	})
}
```

**❌ SALAH — I/O nyata di dalam gelembung**

```go
synctest.Test(t, func(t *testing.T) {
	srv := httptest.NewServer(handler) // socket sungguhan
	defer srv.Close()

	c := Client{HTTP: http.DefaultClient, Cfg: DefaultConfig()}
	_, _ = c.Get(context.Background(), srv.URL) // TIDAK durably blocked
	// Jam tidak pernah maju. Test menggantung sampai timeout.
})
```

**✅ BENAR — seluruh batas luar dipalsukan**

```go
synctest.Test(t, func(t *testing.T) {
	f := &fakeDoer{status: []int{200}} // in-memory, tanpa syscall
	c := Client{HTTP: f, Cfg: DefaultConfig()}
	_, err := c.Get(context.Background(), "http://contoh.test")
	if err != nil {
		t.Fatal(err)
	}
})
```

**❌ SALAH — goroutine masih hidup saat gelembung berakhir**

```go
synctest.Test(t, func(t *testing.T) {
	go func() {
		for { // tidak pernah keluar
			time.Sleep(time.Second)
		}
	}()
}) // panic: gelembung berakhir dengan goroutine yang masih berjalan
```

**✅ BENAR — tiap goroutine punya jalan keluar**

```go
synctest.Test(t, func(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
		}
	}()
	synctest.Wait()
})
```

## Kasus Tepi Produksi

1. **`sync.Mutex` bukan durably blocked.** Goroutine yang menunggu `Lock()` tidak dihitung terhenti, sehingga jam tidak maju. Kalau desain Anda memakai mutex yang ditahan lama sambil menunggu waktu, itu tanda desainnya bermasalah — tapi di test, gantilah dengan channel bila ingin diuji di gelembung.

2. **Channel yang dibuat di luar gelembung.** Channel yang dibuat sebelum `synctest.Test` lalu dipakai di dalamnya **tidak** memberi durably blocked. Semua channel yang dipakai untuk koordinasi WAJIB dibuat di dalam fungsi gelembung.

3. **`t.Parallel()` di dalam gelembung.** Gelembung punya jam sendiri; menjalankan subtest paralel di dalamnya membuat semantiknya kabur. Jalankan `synctest.Test` di level test yang tidak paralel, atau paralelkan di luar gelembung.

4. **Timer yang dibuat di luar, dipicu di dalam.** `time.Ticker` yang dibuat sebelum gelembung tetap memakai jam nyata. Buat seluruh timer di dalam gelembung, atau suntikkan lewat antarmuka jam (`Clock`) yang bisa dipalsukan.

5. **Migrasi bertahap pada suite besar.** Jangan mengubah 200 test sekaligus. Mulai dari test paling lambat — cari dengan `go test -v` dan urutkan durasinya. Biasanya 10 test teratas menyumbang separuh waktu suite, dan hampir semuanya berbasis `time.Sleep`.

6. **Kode produksi yang memanggil `time.Now()` langsung.** Di dalam gelembung, `time.Now()` mengembalikan jam palsu — ini bekerja otomatis. TAPI kalau kode Anda menyimpan waktu ke database lalu membandingkannya dengan `time.Now()` di luar gelembung, Anda akan mendapat selisih 26 tahun. Batasi kebocoran waktu gelembung ke penyimpanan nyata.

## Kapan JANGAN Pakai Ini

- **Test integrasi yang memang harus menyentuh sistem nyata.** Testcontainers, database sungguhan, socket sungguhan — semuanya tidak durably blocked. Gelembung bukan untuk lapis ini; pakai `testcontainers_integration.md`.
- **Test yang mengukur performa waktu nyata.** Benchmark dan uji latensi butuh jam sungguhan. Gelembung membuat semua pengukuran durasi menjadi fiksi.
- **Kode yang bergantung pada penjadwal OS.** Bila yang Anda uji justru perilaku di bawah kontensi CPU nyata, gelembung menghapus persis fenomena yang ingin diamati.
- **Sebagai pengganti `-race`.** synctest membuat eksekusi deterministik; race detector mencari akses memori bersamaan. Keduanya saling melengkapi, bukan menggantikan. Tetap jalankan `go test -race`.

## Cara Mendeteksi Gejalanya di Produksi

Berbeda dari berkas lain, gejala di sini muncul di **CI**, bukan di runtime produksi — tapi ongkosnya nyata: bug konkurensi yang lolos karena test-nya tidak pernah benar-benar menguji jalur waktu.

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Test gagal acak lalu lulus saat di-retry | tingkat kegagalan per test di CI | Sinkronisasi berbasis `time.Sleep`; kandidat utama synctest |
| Suite lambat tanpa test yang berat | urutkan durasi test | Waktu habis untuk menunggu, bukan menghitung |
| Bug timeout/pembatalan lolos ke produksi | telusuri insiden ke test yang ada | Jalur pembatalan tidak pernah diuji karena sulit dipicu andal |
| CI hang lalu dibunuh timeout | job yang dibatalkan runner | Deadlock. Di dalam gelembung ini muncul sebagai panic bernama |

```bash
# 15 test paling lambat — kandidat migrasi ke synctest
go test ./... -v 2>&1 | grep -E '^--- (PASS|FAIL)' \
  | sed -E 's/.*\((.*)s\)/\1 &/' | sort -rn | head -15

# Cari sinkronisasi berbasis sleep di berkas test
grep -rn "time.Sleep" --include="*_test.go" . | wc -l
grep -rn "time.Sleep" --include="*_test.go" . | head -20

# Buktikan sebuah test rapuh sebelum memigrasikannya
go test -run TestWorker -count=200 -race ./...
```
