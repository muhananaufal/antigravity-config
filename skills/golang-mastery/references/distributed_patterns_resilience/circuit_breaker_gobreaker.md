# Circuit Breaker Pattern dalam Go (sony/gobreaker)

## 1. Konsep & Internal

Dalam sistem terdistribusi, kegagalan adalah hal yang pasti. Ketika sebuah service memanggil downstream service yang sedang mengalami degradasi (lambat atau *timeout*), terus-menerus mengirim request akan:
1. Menghabiskan *resource* di pemanggil (goroutine leak, koneksi terbuka).
2. Memperburuk kondisi downstream service yang sedang kesulitan (Cascading Failure).

**Circuit Breaker** bertindak sebagai katup pengaman. Mirip dengan MCB (Miniature Circuit Breaker) di rumah tangga, ia akan "terputus" (Open) jika mendeteksi anomali melebihi ambang batas, mencegah arus request mengalir.

### State Machine Circuit Breaker

Circuit Breaker memiliki tiga state utama:
- **Closed**: Arus normal. Request diteruskan. Jika *error rate* (atau kegagalan beruntun) melebihi threshold, state berubah menjadi *Open*.
- **Open**: Request langsung ditolak (Return *Fast Fail* error, misal `ErrCircuitOpen`). Sistem memberi waktu bagi downstream untuk pulih (Timeout / Sleep Window).
- **Half-Open**: Setelah *Timeout* terlewati, sejumlah kecil request (probe) diizinkan lewat. Jika sukses, state kembali ke *Closed*. Jika gagal, state kembali ke *Open*.

### Diagram State Machine & Timing

```ascii
      (Success Threshold Reached)
        +-------------------------+
        |                         |
        v                         |
+---------------+         +---------------+
|               |         |               |
|    CLOSED     |         |   HALF-OPEN   |
|               |         |               |
+---------------+         +---------------+
        |                         ^
        | (Failure Threshold      | (Timeout / Sleep
        |  Reached)               |  Window Expires)
        v                         |
+---------------+                 |
|               |                 |
|     OPEN      |-----------------+
|               |
+---------------+
        |
        +-- [Semua request langsung di-reject dengan ErrOpenState]
```

## 2. Production-Ready Code (sony/gobreaker)

Implementasi menggunakan *library* standar industri `github.com/sony/gobreaker`.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/sony/gobreaker"
)

// DownstreamClient membungkus HTTP client dengan Circuit Breaker.
type DownstreamClient struct {
	cb     *gobreaker.CircuitBreaker
	client *http.Client
}

// NewDownstreamClient membuat instance baru dengan konfigurasi breaker spesifik.
func NewDownstreamClient(timeout time.Duration) *DownstreamClient {
	st := gobreaker.Settings{
		Name:        "PaymentGateway",
		MaxRequests: 3,                // Jumlah request di state Half-Open
		Interval:    10 * time.Second, // Cyclic window untuk reset counts di state Closed
		Timeout:     5 * time.Second,  // Lama waktu di state Open sebelum ke Half-Open
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			// Trip (Closed -> Open) jika minimal 10 request, dan > 60% gagal
			failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
			return counts.Requests >= 10 && failureRatio >= 0.6
		},
		OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
			// Integrasikan dengan Metrics (Prometheus) dan Logging
			fmt.Printf("[CircuitBreaker] %s transitioned from %v to %v\n", name, from, to)
		},
	}

	return &DownstreamClient{
		cb: gobreaker.NewCircuitBreaker(st),
		client: &http.Client{
			Timeout: timeout,
		},
	}
}

// FetchData memanggil downstream service dengan proteksi Circuit Breaker.
func (c *DownstreamClient) FetchData(ctx context.Context, url string) ([]byte, error) {
	// cb.Execute mengembalikan nilai yang direturn oleh fungsi anonim
	result, err := c.cb.Execute(func() (interface{}, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			// Error karena masalah pembuatan request (misal URL invalid)
			// SEHARUSNYA tidak memicu Circuit Breaker (lihat Anti-Pattern #2)
			// Namun gobreaker standar akan menghitung semua error yang di-return func ini sebagai kegagalan.
			// Untuk penanganan yang benar, kita harus return error nil ke breaker,
			// tapi membawa error asli lewat struct result (lihat implementasi FetchDataTuned).
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		resp, err := c.client.Do(req)
		if err != nil {
			// Ini adalah error jaringan / timeout sesungguhnya
			return nil, fmt.Errorf("network error: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 500 {
			// Server error (5xx) dianggap kegagalan sistem
			return nil, fmt.Errorf("server returned 5xx status: %d", resp.StatusCode)
		}

		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			// Client error (4xx), misal 404 atau 400.
			// Ini adalah kesalahan pemanggil, downstream sehat.
			// Jangan return error agar breaker tidak menghitungnya sebagai kegagalan.
			// (Penanganan lebih presisi ada di FetchDataTuned)
			return nil, fmt.Errorf("client error 4xx: %d", resp.StatusCode)
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to read body: %w", err)
		}

		return body, nil
	})

	if err != nil {
		// Deteksi jika error berasal dari Circuit Breaker yang Open
		if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
			return nil, fmt.Errorf("circuit breaker is open (fast fail): %w", err)
		}
		return nil, err
	}

	return result.([]byte), nil
}
```

### Implementasi Presisi (Ignoring Non-System Errors)

```go
type safeResult struct {
	data []byte
	err  error
}

// FetchDataTuned hanya menghukum downstream untuk error yang relevan (5xx, Timeout, Connection Refused).
func (c *DownstreamClient) FetchDataTuned(ctx context.Context, url string) ([]byte, error) {
	res, cbErr := c.cb.Execute(func() (interface{}, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			// Bukan kegagalan downstream. Kembalikan lewat safeResult, error = nil untuk CB.
			return safeResult{err: fmt.Errorf("bad request construction: %w", err)}, nil
		}

		resp, err := c.client.Do(req)
		if err != nil {
			// Timeout/Jaringan -> INI kegagalan downstream. Beri tahu CB (return error).
			return nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 500 {
			// 5xx -> INI kegagalan downstream.
			return nil, fmt.Errorf("upstream failed with 5xx: %d", resp.StatusCode)
		}

		body, _ := io.ReadAll(resp.Body)

		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			// 4xx -> Kesalahan input kita, downstream sehat.
			return safeResult{err: fmt.Errorf("bad request (4xx): %d", resp.StatusCode)}, nil
		}

		return safeResult{data: body}, nil
	})

	// 1. Cek error dari Circuit Breaker (state Open, dsb)
	if cbErr != nil {
		return nil, fmt.Errorf("circuit breaker blocked request: %w", cbErr)
	}

	// 2. Cek error domain yang kita selamatkan dari CB
	result := res.(safeResult)
	if result.err != nil {
		return nil, result.err
	}

	return result.data, nil
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menghukum Downstream Atas Kesalahan Client (4xx)
**Masalah**: Semua error di-return ke fungsi `Execute` Circuit Breaker, termasuk error validasi input (`400 Bad Request`) atau data tidak ditemukan (`404 Not Found`).

```go
// BAD: 
resp, err := client.Do(req)
if resp.StatusCode == 400 {
    // Breaker akan mencatat ini sebagai kegagalan
    return nil, fmt.Errorf("bad request") 
}
```

**Why dangerous:** Jika sebuah *malicious user* atau bug mengirimkan ratusan request berformat salah (`400`), Circuit Breaker akan menghitungnya sebagai *failure* dan membuka sirkuit (State: Open). Akibatnya, request yang **valid** dari pengguna lain akan ikut tertolak (*False Positive Outage*).

**Solusi:** (Lihat implementasi `FetchDataTuned` di atas). Sembunyikan error bisnis/client dari Circuit Breaker, hanya *bubble-up* error jaringan dan HTTP 5xx.

### ❌ Anti-Pattern 2: Fallback Tanpa Konteks
**Masalah**: Melakukan *fallback* (misal membaca dari cache basi) saat CB *Open*, tetapi menyembunyikan log/error tersebut dari sistem observabilitas.

```go
// BAD:
result, err := cb.Execute(...)
if err != nil {
    // Diam-diam mengembalikan default value
    return []User{}, nil 
}
```

**Why dangerous:** Metrik sukses semu. Sistem terlihat beroperasi normal (sukses 100%), tetapi pengguna mendapat data kedaluwarsa. Saat downstream *down* berhari-hari, tim on-call tidak menyadari karena tidak ada alarm (alert) yang dipicu.

**Solusi:** Kembalikan fallback, tetapi **wajib** logging di level WARN dan increment metrik terpisah (misal: `fallback_responses_total`).

## 4. Edge Cases Spesifik

1. **Thundering Herd Saat Half-Open**:
   Jika `MaxRequests` di setting terlalu tinggi pada state *Half-Open* (misal tidak dibatasi), seketika timeout habis, ribuan request yang mengantri akan langsung menghantam downstream. Downstream yang baru setengah pulih akan langsung mati kembali.
   *Penanganan*: Set `MaxRequests: 1` atau angka yang sangat kecil (misal 3) untuk proses *probing*.

2. **Timeout vs Interval Mismatch**:
   Pada Sony gobreaker, `Interval` adalah *cyclic period* yang mereset counter (hanya saat *Closed*). Jika `Interval` terlalu pendek (misal 1 detik) sementara volume traffic rendah, *breaker* tidak akan pernah *Open* karena counter error tereset sebelum mencapai *Threshold*.
   *Penanganan*: Pastikan `Interval` > `Timeout` dan `Interval` cukup lama untuk mengakumulasi sampel statistik yang bermakna (misal: 10-30 detik). Set `Interval = 0` jika ingin counter tidak pernah di-reset berdasarkan waktu (hanya reset setelah trip).

3. **Context Cancellation Salah Hitung**:
   Jika `ctx context.Context` dibatalkan oleh *pemanggil* (misal user menutup browser), `http.Client.Do(req)` akan return error `context.Canceled`. Menghitung ini sebagai kegagalan downstream adalah keliru.
   *Penanganan*: Deteksi `errors.Is(err, context.Canceled)` dan jangan return sebagai error ke `cb.Execute()`.

## 5. Unit Tests (Behavioral Testing)

```go
package resilience

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sony/gobreaker"
)

func TestCircuitBreaker_StateTransitions(t *testing.T) {
	// Setup simulasi downstream server
	var return500 bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if return500 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	// Setup CB dengan threshold rendah untuk testing
	st := gobreaker.Settings{
		Name:        "TestCB",
		MaxRequests: 1,
		Interval:    0,               // Jangan reset berdasarkan waktu
		Timeout:     1 * time.Second, // Waktu di state Open -> Half-Open
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.TotalFailures >= 3 // Trip setelah 3x gagal
		},
	}
	cb := gobreaker.NewCircuitBreaker(st)
	client := &DownstreamClient{
		cb:     cb,
		client: server.Client(),
	}

	ctx := context.Background()

	// 1. Normal State (Closed)
	_, err := client.FetchDataTuned(ctx, server.URL)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}

	// 2. Paksa Server Gagal (Return 500)
	return500 = true

	// Tembak 3x agar mencapai threshold
	for i := 0; i < 3; i++ {
		_, err = client.FetchDataTuned(ctx, server.URL)
		if err == nil {
			t.Fatalf("expected error on iteration %d", i)
		}
	}

	// 3. State Harus OPEN, request ke-4 harus Fast Fail
	_, err = client.FetchDataTuned(ctx, server.URL)
	if !errors.Is(err, gobreaker.ErrOpenState) && !errors.Is(err, gobreaker.ErrTooManyRequests) {
		// Note: error dibungkus di FetchDataTuned
		t.Fatalf("expected circuit breaker to be open, got: %v", err)
	}

	// 4. Tunggu Timeout (1 detik) agar pindah ke Half-Open
	time.Sleep(1100 * time.Millisecond)

	// Pulihkan server
	return500 = false

	// 5. Probe Request di State Half-Open
	_, err = client.FetchDataTuned(ctx, server.URL)
	if err != nil {
		t.Fatalf("expected probe to succeed in half-open state, got %v", err)
	}

	// 6. CB Harus kembali ke CLOSED
	if cb.State() != gobreaker.StateClosed {
		t.Fatalf("expected state CLOSED, got %v", cb.State())
	}
}
```
