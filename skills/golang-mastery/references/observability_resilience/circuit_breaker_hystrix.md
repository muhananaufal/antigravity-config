# Circuit Breaker Pattern untuk Network Resilience

> **Berlaku:** Go 1.21+ · `sony/gobreaker` v1 (v2 menambah generic, sehingga `Execute` tidak lagi mengembalikan `interface{}`) · **Lihat juga:** `distributed_patterns_resilience/circuit_breaker_gobreaker.md` · `distributed_patterns_resilience/retry_backoff_jitter.md` · `distributed_patterns_resilience/bulkhead_isolation.md` · `observability_resilience/rate_limiting_patterns.md`

## Concept/Internals
Dalam arsitektur *microservices*, kegagalan parsial (seperti *network timeout* atau matinya satu *downstream service*) adalah hal lazim. Tanpa mekanisme pertahanan, kegagalan di satu layanan dapat menyebar (cascading failure) dan meruntuhkan seluruh sistem karena *resource exhaustion* (seperti kehabisan *connection pool* atau antrean panjang goroutines).

**Circuit Breaker** (CB) bertindak sebagai sekring listrik otomatis. Saat mendeteksi tingkat kegagalan (*error rate* atau lambatnya respons) mencapai ambang batas tertentu, ia akan "terbuka" (Open) dan menolak semua *request* ke layanan bermasalah secara langsung.
Ada 3 state utama (FSM - Finite State Machine):
1. **Closed**: Sistem sehat. Semua request diteruskan ke hilir.
2. **Open**: Sistem terdeteksi bermasalah. Semua request seketika ditolak (fast-fail) atau diarahkan ke *fallback*.
3. **Half-Open**: Setelah periode `timeout` saat status Open, CB akan membiarkan sejumlah kecil request uji coba lewat. Jika sukses, CB kembali Closed. Jika gagal, kembali Open.

### Diagram ASCII: State Machine & Flow

```ascii
                      [ Request dari Client ]
                               |
                   +------------------------+
                   | Circuit Breaker Proxy  |
                   +-----------+------------+
                               |
             +-----------------v-----------------+
             |             STATE                 |
             |                                   |
             |  [ CLOSED ] <---+                 |
             |    |            | (Sukses)        |
             | (Error > Threshold)               |
             |    |            |                 |
             |    v            |                 |
             |  [  OPEN  ] ----+                 |
             |    |  (Wait Timeout)              |
             |    |            |                 |
             |    +-----> [ HALF-OPEN ]          |
             |             (Uji Coba)            |
             |                 |                 |
             |                 +-> (Gagal) -> Open
             +-----------------------------------+
                               | (Bila Closed/Half-Open)
                               v
                     [ Downstream Service ]
```

## Production Code

Di Go, implementasi defacto yang banyak digunakan adalah `github.com/sony/gobreaker` yang kokoh, ringkas, dan thread-safe.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"time"

	"github.com/sony/gobreaker"
)

var (
	ErrServiceUnavailable = errors.New("service unavailable: circuit breaker open")
	// ErrPermintaanKlien menandai galat 4xx dan galat konstruksi request.
	// Keduanya BUKAN bukti hilir bermasalah, jadi tidak boleh menghitung
	// sebagai kegagalan — lihat IsSuccessful di bawah.
	ErrClientRequest = errors.New("permintaan klien ditolak hilir")
)

const responseBodyLimit = 4 << 20 // 4 MiB — hilir bermasalah bisa mengirim tanpa batas

// PaymentClient membungkus HTTP client dengan Circuit Breaker.
type PaymentClient struct {
	cb     *gobreaker.CircuitBreaker
	client *http.Client
}

// NewPaymentClient membuat instance dengan konfigurasi CB production-ready.
//
// jitter WAJIB berbeda per instans. Tanpa itu seluruh pod masuk Half-Open pada
// detik yang sama dan menghantam hilir yang baru pulih secara serentak.
func NewPaymentClient(name string) *PaymentClient {
	// #nosec G404 — jitter penjadwalan, bukan nilai kriptografis
	jitter := time.Duration(rand.Int63n(int64(2 * time.Second)))

	st := gobreaker.Settings{
		Name: name,
		// MaxRequests: jumlah request percobaan yang diizinkan saat Half-Open.
		MaxRequests: 3,
		// Interval: periode reset penghitung saat Closed.
		//
		// JEBAKAN: Interval dan ambang `Requests` di ReadyToTrip adalah SATU
		// pasangan, dan pasangan yang salah membuat breaker mati fungsi tanpa
		// gejala. `Requests >= 10` di dalam Interval 10 detik berarti breaker
		// TIDAK PERNAH bisa terbuka bila trafik ke dependensi ini < 1 rps —
		// penghitung ter-reset sebelum sempat mencapai 10, berapa pun matinya
		// hilir. Untuk dependensi bertrafik rendah, perbesar Interval (atau
		// set 0 = tidak pernah reset selama Closed).
		Interval: 60 * time.Second,
		// Timeout: lama state Open sebelum masuk Half-Open, diberi jitter.
		Timeout: 5*time.Second + jitter,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			if counts.Requests < 10 { // ambang sampel minimum
				return false
			}
			return float64(counts.TotalFailures)/float64(counts.Requests) >= 0.6
		},
		// IsSuccessful memutuskan apakah sebuah galat MENGHITUNG sebagai
		// kegagalan hilir. Inilah tempat yang benar untuk menyaring galat yang
		// bukan salah hilir — bukan dengan menelan galatnya (Anti-Pattern 2).
		IsSuccessful: func(err error) bool {
			switch {
			case err == nil:
				return true
			case errors.Is(err, ErrClientRequest):
				// 4xx = salah pemanggil. Hilir sehat: ia menjawab dengan benar.
				return true
			case errors.Is(err, context.Canceled):
				// Klien pergi (tab ditutup, refresh). Bukan bukti hilir rusak.
				// context.DeadlineExceeded sengaja TIDAK ikut di sini: itu
				// justru sinyal paling murni bahwa hilir melambat.
				return true
			default:
				return false
			}
		},
		OnStateChange: func(name string, from, to gobreaker.State) {
			slog.Warn("circuit breaker berpindah state",
				"breaker", name, "dari", from.String(), "ke", to.String())
		},
	}

	return &PaymentClient{
		cb: gobreaker.NewCircuitBreaker(st),
		client: &http.Client{
			// WAJIB lebih pendek dari toleransi pemanggil. Lihat Anti-Pattern 1.
			Timeout: 2 * time.Second,
		},
	}
}

// ProcessPayment mengeksekusi request melalui Circuit Breaker.
func (p *PaymentClient) ProcessPayment(ctx context.Context, url string) (string, error) {
	result, err := p.cb.Execute(func() (interface{}, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
		if err != nil {
			// URL cacat = salah kita, bukan salah hilir. Dibungkus supaya
			// IsSuccessful tidak menghitungnya sebagai kegagalan hilir.
			return nil, fmt.Errorf("%w: bangun request: %w", ErrClientRequest, err)
		}

		resp, err := p.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("network error: %w", err)
		}
		defer resp.Body.Close()

		switch {
		case resp.StatusCode >= 500:
			// Body 5xx tetap dikuras (berbatas) agar koneksi bisa dipakai ulang.
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, responseBodyLimit))
			return nil, fmt.Errorf("server error: %d", resp.StatusCode)
		case resp.StatusCode >= 400:
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
			return nil, fmt.Errorf("%w: %d: %s", ErrClientRequest, resp.StatusCode, msg)
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, responseBodyLimit))
		if err != nil {
			// Body putus di tengah adalah kegagalan hilir yang sah. JANGAN
			// kembalikan potongan parsial sebagai sukses.
			return nil, fmt.Errorf("read body: %w", err)
		}
		return string(body), nil
	})

	if err != nil {
		if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
			return "", ErrServiceUnavailable // pemanggil beralih ke fallback
		}
		return "", err
	}

	// gobreaker v1 mengembalikan interface{}. Bentuk comma-ok WAJIB: begitu ada
	// satu cabang yang mengembalikan tipe lain, assertion telanjang PANIC dan
	// mematikan proses. gobreaker/v2 yang generik menghapus kelas galat ini.
	body, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("tipe hasil tak terduga: %T", result)
	}
	return body, nil
}
```

Ujinya memakai `httptest`, bukan host yang tidak bisa di-resolve:

```go
package resilience

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sony/gobreaker"
)

func TestBreakerTerbukaSetelahAmbang(t *testing.T) {
	// httptest, BUKAN "http://invalid.local". Host yang tidak bisa di-resolve
	// menggantungkan uji pada DNS mesin penguji: ISP yang membajak NXDOMAIN
	// membuat request BERHASIL, dan sufiks .local memicu jalur mDNS yang lambat
	// sehingga 10 iterasi bisa melampaui Interval dan me-reset penghitung.
	// Uji jadi gagal karena lingkungan, bukan karena kode.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := NewPaymentClient("uji-cb")
	ctx := context.Background()

	for i := 0; i < 10; i++ {
		if _, err := c.ProcessPayment(ctx, srv.URL); err == nil {
			t.Fatalf("iteration %d: expected 5xx error", i)
		}
	}

	if _, err := c.ProcessPayment(ctx, srv.URL); !errors.Is(err, ErrServiceUnavailable) {
		t.Fatalf("request ke-11 harus ditolak breaker, dapat: %v", err)
	}
	if got := c.cb.State(); got != gobreaker.StateOpen {
		t.Fatalf("state = %v, mau Open", got)
	}
}

// Uji yang justru paling sering hilang, dan satu-satunya yang membuktikan
// klasifikasi galat bekerja: galat yang BUKAN salah hilir tidak boleh membuka
// breaker. Tanpa uji ini, satu lonjakan 400 dari satu klien cacat memutus
// akses SELURUH pengguna ke hilir yang sehat.
func TestBreakerTidakTerbukaKarena4xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := NewPaymentClient("uji-cb-4xx")
	ctx := context.Background()

	for i := 0; i < 50; i++ {
		_, err := c.ProcessPayment(ctx, srv.URL)
		if !errors.Is(err, ErrClientRequest) {
			t.Fatalf("iterasi %d: mau ErrPermintaanKlien, dapat %v", i, err)
		}
	}

	if got := c.cb.State(); got != gobreaker.StateClosed {
		t.Fatalf("state = %v, mau tetap Closed — 4xx bukan kegagalan hilir", got)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Timeout HTTP Lebih Panjang dari yang Bisa Ditoleransi

**Mengapa berbahaya:** Circuit breaker **menghitung** kegagalan; ia tidak memotong request yang sedang berjalan. Dengan `http.Client.Timeout` 30 detik, setiap request yang menggantung menahan satu goroutine dan satu koneksi selama 30 detik penuh — dan breaker baru melihat kegagalan pertamanya setelah 30 detik. Pada beban tinggi, pool koneksi habis jauh sebelum sekring sempat putus.

Ada **dua** ketimpangan yang berbeda, dan keduanya sering tertukar:

| Yang dibandingkan | Kalau timpang |
| :--- | :--- |
| `http.Client.Timeout` vs toleransi pemanggil | Pemanggil menyerah lebih dulu. Kerja Anda terbuang, dan breaker tidak pernah menerima sinyal yang seharusnya ia hitung |
| `http.Client.Timeout` vs `Settings.Timeout` (durasi Open) | Probe Half-Open butuh 30 detik untuk menyimpulkan padahal Open hanya 5 detik. Breaker tertahan di Half-Open jauh lebih lama dari yang dirancang |

> `Settings.Interval` **tidak ada hubungannya** dengan timeout HTTP. Ia adalah periode reset penghitung saat Closed; pasangannya adalah ambang `Requests` di `ReadyToTrip`, bukan durasi request. Menyamakan keduanya membuat orang menyetel `Interval` untuk alasan yang salah — dan melewatkan jebakan trafik-rendah di Edge Case 5.

```go
// BAD: HTTP timeout jauh melampaui durasi Open
cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{Timeout: 5 * time.Second})
client := &http.Client{Timeout: 30 * time.Second}
```
```go
// GOOD: request selesai (atau menyerah) jauh di dalam durasi Open
cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{Timeout: 5 * time.Second})
client := &http.Client{Timeout: 1 * time.Second}
```

### ❌ Anti-Pattern 2: Menelan Galat 4xx Supaya Breaker Tidak Terbuka

Kode 400 atau 404 adalah kesalahan pemanggil, bukan indikasi hilir sedang mati. Bila 4xx ikut dihitung, breaker terbuka dan menolak akses **untuk seluruh pengguna** — satu klien cacat memadamkan layanan bagi semua orang. Sampai di sini benar. Yang salah adalah obatnya yang biasa disarankan:

> **Klaim lama yang sudah tidak berlaku:** *"gobreaker menghitung semua galat non-nil sebagai kegagalan, jadi untuk 4xx kembalikan `nil` error dan bungkus statusnya di dalam objek respons."*

`gobreaker.Settings` punya **`IsSuccessful func(err error) bool`**. Fungsi itu menerima galat yang Anda kembalikan dan memutuskan apakah ia menghitung sebagai kegagalan. Perilaku "semua galat non-nil = kegagalan" hanyalah **default saat field ini nil** — bukan batasan pustaka.

Workaround "kembalikan `nil` error" merusak dua hal sekaligus:

- **Tipe galat lenyap.** Pemanggil tidak bisa lagi `errors.Is`. Setiap lapisan di atasnya harus tahu cara membongkar objek respons hanya untuk tahu bahwa request-nya gagal.
- **`Execute` mengembalikan `interface{}`.** Begitu satu cabang mengembalikan `*CustomResponse` dan cabang lain `string`, `result.(string)` di pemanggil **panic**. Obat yang disarankan justru menjatuhkan proses.

```go
// BAD: galat ditelan supaya breaker tidak menghitungnya.
// Tipe galat hilang, dan tipe kembalian jadi tidak konsisten antar-cabang.
if resp.StatusCode == http.StatusBadRequest {
    return &CustomResponse{Err: "bad request"}, nil
}
```
```go
// GOOD: kembalikan galat SUNGGUHAN, lalu beri tahu breaker jangan menghitungnya.
// Klasifikasi terjadi di satu tempat; pemanggil tetap punya errors.Is.
if resp.StatusCode >= 400 && resp.StatusCode < 500 {
    return nil, fmt.Errorf("%w: %d", ErrClientRequest, resp.StatusCode)
}

st := gobreaker.Settings{
    IsSuccessful: func(err error) bool {
        return err == nil || errors.Is(err, ErrClientRequest)
    },
}
```

### ❌ Anti-Pattern 3: Menggunakan CB Tanpa Fallback Logic
**Mengapa berbahaya:** Ketika CB terbuka, ia melontarkan `ErrOpenState`. Jika aplikasi tidak menangkap ini dan memberikan *graceful degradation* (misal: mengembalikan data statis, membaca dari *cache*, atau merespons HTTP 503 secara elegan), pengguna akan menerima *stack trace* mentah atau *panic*, merusak *User Experience*.

```go
// BAD: Langsung panic atau expose raw error
val, err := p.ProcessPayment(ctx, url)
if err != nil {
    panic(err)
}
```
```go
// GOOD: Kembalikan fallback
if errors.Is(err, ErrServiceUnavailable) {
    return GetCachedPaymentStatus(), nil
}
```

## Edge Cases & Defensive Programming

1. **Thundering Herd pada State Half-Open**: Ketika state berubah dari Open ke Half-Open, *semua* request yang tadinya tertahan akan serentak menyerang *downstream*. Hal ini bisa menumbangkan kembali layanan yang baru saja bangkit. `gobreaker` menangani ini dengan membatasi `MaxRequests`, sehingga hanya N request pertama yang diteruskan, sisanya langsung gagal (*fast-fail*). Pastikan `MaxRequests` tidak terlalu besar.
2. **Context Cancellation — pembatalan oleh klien bisa memutus layanan Anda sendiri**: Bila *parent context* dari `r.Context()` dibatalkan (pengguna menutup tab atau me-*refresh*), `client.Do` gagal dengan `context.Canceled`. Secara default gobreaker menghitungnya sebagai kegagalan hilir. Konsekuensinya tidak sepele: satu halaman yang lambat memuat membuat banyak pengguna menekan refresh, breaker terbuka, dan **hilir yang sepenuhnya sehat jadi tidak bisa diakses siapa pun** — pemadaman yang seluruhnya Anda timbulkan sendiri. Ditangani di `IsSuccessful` pada kode di atas. Perhatikan pembedaannya: `context.Canceled` diabaikan, sedangkan **`context.DeadlineExceeded` tetap dihitung** — deadline terlampaui justru sinyal paling murni bahwa hilir melambat, dan menelannya membuat breaker buta terhadap satu-satunya kegagalan yang paling perlu ia lihat.
3. **Flapping State di Arsitektur Load Balanced**: Jika downstream Anda berada di balik Load Balancer bundar (*round-robin*), dan hanya 1 dari 5 pod yang mati, *error rate* total mungkin hanya 20%. Jika ambang CB adalah 50%, sekring tidak akan pernah putus (Closed), namun 20% pengguna Anda menderita. Di sistem tingkat lanjut, CB harus dipasang *per-instance/pod* (Client-side Load Balancing CB), bukan *per-hostname*.
4. **Data Race pada Custom Metrics**: Karena CB diakses oleh ribuan goroutines secara simultan, jika Anda menambahkan *counter* kustom (di luar fitur library) di fungsi pelaksana tanpa `sync.Mutex` atau `atomic`, Anda akan mengalami keparahan *Race Condition*. Selalu manfaatkan statistik atomik *internal* yang ditawarkan oleh pustaka.
5. **Zona mati trafik rendah — breaker yang tidak pernah bisa terbuka**: `Interval` dan ambang `Requests` di `ReadyToTrip` adalah satu pasangan, dan pasangan yang salah mematikan breaker tanpa menimbulkan gejala apa pun. `Requests >= 10` di dalam `Interval` 10 detik menuntut **lebih dari 1 rps** ke dependensi itu; di bawah itu penghitung ter-reset sebelum sempat mencapai 10, dan breaker tetap Closed **berapa pun matinya hilir**. Yang berbahaya: konfigurasi ini terlihat wajar di code review, lulus semua uji beban (yang trafiknya tinggi), dan baru ketahuan saat insiden pada dependensi bertrafik rendah — persis saat ia paling dibutuhkan. Untuk dependensi jarang-pakai, perbesar `Interval` atau set `0` (tidak pernah reset selama Closed) dan turunkan ambang sampel.
6. **`Execute` tidak membatalkan fungsi yang sedang berjalan**: Saat breaker berpindah ke Open, request yang sudah terlanjur masuk **tetap berjalan sampai selesai**. Breaker hanya menolak pemanggilan *baru*. Batas waktu sesungguhnya tetap datang dari `context` dan `http.Client.Timeout` — tanpa keduanya, breaker yang terbuka tidak menghentikan apa pun yang sudah menggantung.

## Kapan JANGAN Pakai Ini

- **Untuk dependensi yang tidak punya fallback bermakna.** Circuit breaker mengubah "lambat" menjadi "gagal cepat". Bila kegagalan itu tetap berarti permintaan pengguna gagal, yang Anda peroleh hanya kegagalan yang lebih cepat. Kadang itu memang tujuannya — tapi putuskan dengan sadar, bukan sebagai refleks.
- **Untuk database utama Anda.** Memutus akses ke satu-satunya sumber kebenaran tidak menyelamatkan apa pun. Yang dibutuhkan di situ adalah pool berbatas, timeout, dan antrean — bukan pemutusan.
- **Satu breaker untuk banyak endpoint hilir.** Endpoint `/laporan` yang berat akan memutus `/status` yang sehat karena keduanya berbagi hitungan. Satu breaker per dependensi logis.
- **Untuk melindungi diri dari pemanggil.** Breaker melindungi Anda dari **hilir**. Untuk membatasi trafik **masuk**, alatnya rate limiting dan bulkhead.
- **Tanpa jitter pada percobaan half-open.** Bila puluhan instans membuka pada detik yang sama, hilir yang baru pulih langsung dihantam serentak dan jatuh lagi.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 turun tapi error rate naik | rasio permintaan ditolak breaker | Breaker bekerja; putuskan apakah itu yang diinginkan |
| Breaker membuka-menutup terus (flapping) | interval half-open vs waktu pulih hilir | Ambang dan interval tidak selaras |
| Breaker terbuka karena lonjakan `4xx` | klasifikasi galat | Kesalahan klien seharusnya tidak menghitung sebagai kegagalan hilir |
| Breaker tidak pernah terbuka meski hilir mati | ambang dan jendela | Ambang terlalu longgar, atau timeout request lebih lama dari jendela breaker |
| Hilir jatuh lagi tepat setelah pulih | jitter pada half-open | Semua instans mencoba serentak |

```bash
# Metrik breaker per dependensi
curl -s localhost:9090/metrics | grep -E 'circuit_breaker|cb_(state|requests)'

# PromQL yang layak dipasang di dasbor:
#   max by (dependensi) (cb_state)                       0=tertutup 1=setengah 2=terbuka
#   sum by (dependensi) (rate(cb_requests_total{hasil="ditolak"}[5m]))
#   sum by (dependensi) (rate(cb_state_changes_total[15m]))   -- tinggi = flapping

kubectl logs -l app=api --since=1h | grep -c 'circuit breaker is open'
```
