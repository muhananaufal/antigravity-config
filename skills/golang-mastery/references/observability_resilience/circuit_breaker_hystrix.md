# Circuit Breaker Pattern untuk Network Resilience

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
	"net/http"
	"testing"
	"time"

	"github.com/sony/gobreaker"
)

var ErrServiceUnavailable = errors.New("service is unavailable due to circuit breaker")

// PaymentClient membungkus HTTP client dengan Circuit Breaker.
type PaymentClient struct {
	cb     *gobreaker.CircuitBreaker
	client *http.Client
}

// NewPaymentClient membuat instance dengan konfigurasi CB production-ready.
func NewPaymentClient(name string) *PaymentClient {
	st := gobreaker.Settings{
		Name: name,
		// MaxRequests: Jumlah request saat Half-Open
		MaxRequests: 3,
		// Interval: Periode untuk menghitung kegagalan (jika 0, dihitung saat closed secara terus-menerus)
		Interval: 10 * time.Second,
		// Timeout: Waktu istirahat (Open) sebelum masuk ke Half-Open
		Timeout: 5 * time.Second,
		// ReadyToTrip: Kondisi kapan CB harus Open. 
		// Di sini kita gunakan: minimal 10 request dalam interval, dan failure rate >= 60%
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
			return counts.Requests >= 10 && failureRatio >= 0.6
		},
		// OnStateChange: Hook untuk observability (Metrics/Logs)
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			fmt.Printf("[CB-EVENT] %s changed from %s to %s\n", name, from, to)
		},
	}

	return &PaymentClient{
		cb: gobreaker.NewCircuitBreaker(st),
		client: &http.Client{
			Timeout: 2 * time.Second, // Timeout ketat untuk I/O
		},
	}
}

// ProcessPayment mengeksekusi request melalui Circuit Breaker.
func (p *PaymentClient) ProcessPayment(ctx context.Context, url string) (string, error) {
	// Execute berjalan dalam scope CB
	result, err := p.cb.Execute(func() (interface{}, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
		if err != nil {
			// Request creation error TIDAK boleh mentrip CB, karena ini bukan error dari downstream.
			// Tapi gobreaker akan menganggap semua error dari func ini sbg failure jika di-return.
			// Ini adalah tantangan umum. Kita tangani di Edge Case #3 (Ignore specific errors).
			return nil, err
		}

		resp, err := p.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("network error: %w", err)
		}
		defer resp.Body.Close()

		// 5xx errors considered as failure that trips the breaker
		if resp.StatusCode >= 500 {
			return nil, fmt.Errorf("server error: %d", resp.StatusCode)
		}

		// 4xx errors (client errors) SHOULD NOT trip the breaker.
		// Sayangnya, gobreaker trip pada *semua* non-nil error.
		// Workaround: return nil error, tapi return custom response object.
		// Untuk simplicity kode ini, kita kembalikan error. Lihat Anti-Pattern #2.

		body, _ := io.ReadAll(resp.Body)
		return string(body), nil
	})

	if err != nil {
		// Jika error berasal dari CB yang Open
		if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
			return "", ErrServiceUnavailable // Fast-fail atau memicu Fallback logic
		}
		return "", err
	}

	return result.(string), nil
}

// --- Unit Tests ---

func TestCircuitBreakerTrips(t *testing.T) {
	client := NewPaymentClient("test-cb")

	ctx := context.Background()
	// Simulasi 10 kegagalan beruntun agar menyentuh ambang batas (>=10 req, 100% fail)
	for i := 0; i < 10; i++ {
		_, err := client.ProcessPayment(ctx, "http://invalid.local") // Pasti gagal network
		if err == nil {
			t.Errorf("Expected network error on iteration %d", i)
		}
	}

	// Request ke-11 harusnya langsung gagal oleh Circuit Breaker (ErrServiceUnavailable)
	_, err := client.ProcessPayment(ctx, "http://invalid.local")
	if !errors.Is(err, ErrServiceUnavailable) {
		t.Errorf("Expected %v, got %v", ErrServiceUnavailable, err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Timeout Request Lebih Lama dari Interval/Timeout CB
**Mengapa berbahaya:** Jika CB memiliki `Timeout` (durasi state Open) 5 detik, tetapi `http.Client` memiliki timeout 30 detik, goroutines akan menggantung (hang) selama 30 detik pada state Closed/Half-Open. Ini membatalkan keuntungan utama CB (*fast-fail*), menyebabkan *thread exhaustion* pada sistem sebelum sekering sempat putus.

```go
// BAD: HTTP Timeout >> CB Interval/Timeout
cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{Timeout: 5 * time.Second})
client := &http.Client{Timeout: 30 * time.Second} 
```
```go
// GOOD: HTTP Timeout (1s) << CB Interval (10s)
client := &http.Client{Timeout: 1 * time.Second}
```

### ❌ Anti-Pattern 2: Mentrip CB untuk Kesalahan Klien (HTTP 4xx)
**Mengapa berbahaya:** Kode 400 Bad Request atau 404 Not Found adalah kesalahan dari pihak pemanggil (client-side), bukan indikasi *downstream service* sedang down. Jika 4xx mereturn `error` ke fungsi CB, CB akan terbuka (Open), menolak akses bahkan untuk pengguna lain dengan *request* yang valid! Ini memicu *Denial of Service* secara tidak disengaja.

```go
// BAD: Semua error mentrip CB
if resp.StatusCode == 400 {
    return nil, errors.New("bad request") // Ini akan menambah counter kegagalan CB!
}
```

```go
// GOOD: Abaikan 4xx dari perhitungan CB (return nilai dan nil error, lalu olah di luar)
if resp.StatusCode == 400 {
    return &CustomResponse{Err: "bad request"}, nil 
    // Tidak dihitung gagal oleh CB. Evaluasi error dilakukan caller.
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
2. **Context Cancellation saat Wait**: Jika *parent context* dari `r.Context()` (HTTP request yang masuk) dibatalkan (misal user me-*refresh* browser) tepat saat CB mengeksekusi request di Half-Open, proses HTTP Client akan gagal dengan `context.Canceled`. Kegagalan ini akan dianggap sebagai *service failure* dan men-trip ulang CB menjadi Open! Sebaiknya, deteksi `errors.Is(err, context.Canceled)` dan jangan hitung itu sebagai kegagalan *downstream*.
3. **Flapping State di Arsitektur Load Balanced**: Jika downstream Anda berada di balik Load Balancer bundar (*round-robin*), dan hanya 1 dari 5 pod yang mati, *error rate* total mungkin hanya 20%. Jika ambang CB adalah 50%, sekring tidak akan pernah putus (Closed), namun 20% pengguna Anda menderita. Di sistem tingkat lanjut, CB harus dipasang *per-instance/pod* (Client-side Load Balancing CB), bukan *per-hostname*.
4. **Data Race pada Custom Metrics**: Karena CB diakses oleh ribuan goroutines secara simultan, jika Anda menambahkan *counter* kustom (di luar fitur library) di fungsi pelaksana tanpa `sync.Mutex` atau `atomic`, Anda akan mengalami keparahan *Race Condition*. Selalu manfaatkan statistik atomik *internal* yang ditawarkan oleh pustaka.
