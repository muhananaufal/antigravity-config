# Retry dengan Exponential Backoff + Jitter

## 1. Konsep & Internal

Dalam lingkungan *cloud-native*, kesalahan jaringan (transient errors) seperti *packet loss*, *timeout* sementara, atau latensi *spike* tidak dapat dihindari. Melakukan panggilan ulang (*retry*) ke layanan yang gagal sangat krusial. 

Namun, jika *retry* dilakukan terlalu cepat atau pada waktu yang sama secara masif, kita dapat mematikan *downstream service* yang sudah kesulitan dengan memberikannya beban ekstra (**Thundering Herd Problem**).

**Solusi Resilien**:
1. **Exponential Backoff**: Jeda waktu antar *retry* dibuat semakin lama (misal: 1s, 2s, 4s, 8s). Ini memberikan waktu pemulihan (breathing room) bagi server *downstream*.
2. **Jitter**: Menambahkan *randomness* (kebisingan) ke jeda waktu untuk menghindari sinkronisasi *retry* oleh ribuan *client* secara bersamaan.

### Diagram: Exponential Backoff Tanpa vs Dengan Jitter

```ascii
[ Tanpa Jitter (Thundering Herd) ]
Semua client gagal bersamaan (t=0) dan retry tepat di detik ke:
 Client 1: |-> 1s ->|----> 2s ---->|--------> 4s -------->|
 Client 2: |-> 1s ->|----> 2s ---->|--------> 4s -------->|
 Client 3: |-> 1s ->|----> 2s ---->|--------> 4s -------->|
         [ SPIKE ]       [ SPIKE ]          [ SPIKE BESAR ]
    Server Downstream Menderita Beban Puncak (Spike) Berkala

[ Dengan Full Jitter ]
Client memutar "dadu" antara 0 hingga Backoff maksimal:
 Client 1: |-> 0.8s ->|-----> 1.5s ----->|-----> 2.8s ----->|
 Client 2: |-> 0.2s |-----> 1.9s ----->|------> 3.7s ------>|
 Client 3: |-> 0.9s ->|-> 0.5s |-------> 3.1s ------->|
 Beban terdistribusi secara merata, Server Downstream selamat.
```

## 2. Production-Ready Code

Implementasi ini tidak bergantung pada *library* eksternal untuk mendemonstrasikan internal *retry* secara mendalam, menggunakan algoritma *Full Jitter* (dijelaskan oleh AWS), dan sangat *context-aware*.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"
)

// Policy mendefinisikan konfigurasi Retry.
type Policy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// IsTransientError menentukan apakah error layak di-retry.
// Dalam sistem produksi, evaluasi HTTP status codes atau custom error interface.
func IsTransientError(err error) bool {
	// Contoh: Timeout, Connection Refused, atau HTTP 503 / 504 adalah transient.
	// HTTP 400, 401, 404 BUKAN transient.
	if err == nil {
		return false
	}
	
	// Dalam contoh ini kita asumsikan semua error selain Context Canceled bisa dicoba ulang,
	// namun dalam kenyataannya filter ini SANGAT krusial (Lihat Anti-Pattern #2).
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return true
}

// DoWithRetry mengeksekusi operasi menggunakan strategi Exponential Backoff dengan Full Jitter.
func DoWithRetry(ctx context.Context, p Policy, operation func(ctx context.Context) error) error {
	var err error
	
	for attempt := 0; attempt < p.MaxAttempts; attempt++ {
		// 1. Eksekusi operasi
		err = operation(ctx)
		if err == nil {
			return nil // Berhasil, keluar dari loop
		}

		// 2. Evaluasi Error (Jangan retry error fatal/client error)
		if !IsTransientError(err) {
			return fmt.Errorf("non-transient error on attempt %d: %w", attempt+1, err)
		}

		// Jika ini adalah percobaan terakhir, tidak perlu menunggu
		if attempt == p.MaxAttempts-1 {
			break
		}

		// 3. Kalkulasi Backoff (Eksponensial)
		// wait = BaseDelay * 2^attempt
		backoff := float64(p.BaseDelay) * float64(1<<attempt)
		
		if backoff > float64(p.MaxDelay) {
			backoff = float64(p.MaxDelay)
		}

		// 4. Kalkulasi Jitter (Full Jitter)
		// Jitter = random(0, backoff)
		jitteredWait := time.Duration(rand.Float64() * backoff)

		// 5. Tidur (Sleep) sambil mengawasi Context Cancellation
		// TIDAK BOLEH pakai time.Sleep(jitteredWait) karena akan nge-block goroutine!
		timer := time.NewTimer(jitteredWait)
		select {
		case <-ctx.Done():
			timer.Stop()
			// Context dibatalkan oleh caller, hentikan proses retry
			return fmt.Errorf("context canceled during retry wait: %w (last error: %v)", ctx.Err(), err)
		case <-timer.C:
			// Lanjut ke percobaan berikutnya
		}
	}

	return fmt.Errorf("exhausted all %d retries, last error: %w", p.MaxAttempts, err)
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Static / Linear Sleep (Thundering Herd)
**Masalah**: Klien menunggu secara *fix* 2 detik lalu mengulang *request*.

❌ **BAD:**
```go
// BAD: Tidak ada Backoff dan Tidak ada Jitter
for i := 0; i < 3; i++ {
    if err := doSomething(); err == nil { return nil }
    time.Sleep(2 * time.Second) // SANGAT BERBAHAYA
}
```
**Why dangerous:** Jika sebuah microservice, misalnya `API-Gateway` melakukan restart sementara (selama 5 detik), ribuan mobile client akan menerima error di detik ke-1. Pada detik ke-3, ribuan client tersebut akan mengirim *retry request* secara BERSAMAAN. `API-Gateway` yang baru saja bangkit akan kelebihan beban oleh gelombang *request* ini dan mati kembali.

✅ **GOOD:**
```go
// GOOD: Gunakan Exponential Backoff dengan Jitter
policy := Policy{MaxAttempts: 3, BaseDelay: 100 * time.Millisecond, MaxDelay: 2 * time.Second}
err := DoWithRetry(ctx, policy, doSomething)
```

### ❌ Anti-Pattern 2: Retry "Membabi Buta" (Retrying Non-Transient Errors)
**Masalah**: Melakukan *retry* atas setiap error (`err != nil`).

❌ **BAD:**
```go
// BAD: Retrying bad inputs
resp, err := http.Post(...) 
if err != nil || resp.StatusCode == 400 { 
    // Akan di-retry, padahal 400 Bad Request TIDAK AKAN pernah berhasil 
    // walau diulang 1 juta kali.
    return retry() 
}
```
**Why dangerous:** Ini adalah pemborosan siklus komputasi (*CPU/Network*). Jika sebuah operasi gagal karena input yang tidak valid (`400 Bad Request`) atau akun terkunci (`403 Forbidden`), mengulangi operasi tersebut hanya akan membuang *resource* sistem (baik di sisi client maupun server).

✅ **GOOD:**
```go
// GOOD: Fail-fast pada non-transient error
resp, err := http.Post(...)
if err != nil && !IsTransientError(err) {
    return err
}
return retry()
```

## 4. Edge Cases Spesifik

1. **Context Deadline Exceeded di Tengah Backoff Window**:
   Jika *caller* memberi `context.WithTimeout(ctx, 10s)`, dan percobaan ke-3 mengkalkulasi waktu tidur (backoff) 8 detik sementara sisa waktu (deadline) *context* tinggal 2 detik, Goroutine *akan terbangun oleh `<-ctx.Done()`* sebelum *timer* selesai. Implementasi yang buruk (menggunakan `time.Sleep()`) akan menyebabkan *goroutine leak* selama sisa 6 detik tersebut. Kode produksi *wajib* menggunakan `select` dan `time.Timer`.

2. **Retry Amplification (Cascading Retries)**:
   Service A memanggil Service B (Max Retry = 3). Service B memanggil Service C (Max Retry = 3).
   Jika Service C mati, satu request dari User ke Service A akan memicu `1 * 3 * 3 = 9` request ke Service C. Jika ada 1.000 user per detik, Service C akan dibanjiri 9.000 request per detik saat ia paling rentan.
   *Penanganan*: *Retry* sebaiknya hanya dilakukan di satu lapis (layer) sistem, biasanya di sistem terluar atau yang paling dekat dengan *client*. Internal service lebih baik segera *fail fast* ke atas menggunakan *Circuit Breaker*.

3. **Operasi yang Tidak Idempotent (Misal: POST Payment)**:
   Sebuah *request* `HTTP POST /charge-card` dikirimkan. Server memprosesnya secara sukses, namun balasan jaringannya terputus (`Connection Reset`). Klien melihatnya sebagai error dan melakukan *retry*. Klien ditagih (charged) dua kali.
   *Penanganan*: Jangan pernah me-*retry* operasi non-idempotent TANPA menambahkan **Idempotency Key** di Header/Payload. Server harus menolak operasi duplikat dari *Idempotency Key* yang sama.

## 5. Unit Tests (Behavioral Testing)

```go
package resilience

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Mock interface API
type DownstreamAPI interface {
	Call(ctx context.Context) error
}

type mockAPI struct {
	attempts int
	errs     []error
}

func (m *mockAPI) Call(ctx context.Context) error {
	m.attempts++
	if m.attempts <= len(m.errs) {
		return m.errs[m.attempts-1]
	}
	return nil
}

func TestDoWithRetry_SuccessOnThirdAttempt(t *testing.T) {
	ctx := context.Background()
	policy := Policy{
		MaxAttempts: 5,
		BaseDelay:   10 * time.Millisecond,
		MaxDelay:    100 * time.Millisecond,
	}

	api := &mockAPI{
		errs: []error{
			errors.New("simulated network timeout 1"),
			errors.New("simulated network timeout 2"),
		},
	}

	err := DoWithRetry(ctx, policy, api.Call)

	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if api.attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", api.attempts)
	}
}

func TestDoWithRetry_ContextCancellation(t *testing.T) {
	// Beri timeout singkat yang pasti akan ter-trigger saat backoff panjang
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	policy := Policy{
		MaxAttempts: 10,
		BaseDelay:   100 * time.Millisecond, // Base delay lebih besar dari Context Timeout
		MaxDelay:    1 * time.Second,
	}

	start := time.Now()
	err := DoWithRetry(ctx, policy, func(ctx context.Context) error {
		return errors.New("simulated network error")
	})
	duration := time.Since(start)

	if err == nil {
		t.Fatal("expected error due to context cancellation")
	}

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got: %v", err)
	}

	// Memastikan tidak ter-block (sleep) melebihi context timeout
	if duration > 100*time.Millisecond {
		t.Fatalf("retry took too long (%v), select context done failed", duration)
	}
}

func TestDoWithRetry_NoRetryOnNonTransient(t *testing.T) {
	ctx := context.Background()
	policy := Policy{MaxAttempts: 5, BaseDelay: 1 * time.Millisecond, MaxDelay: 10 * time.Millisecond}
	
	attempts := 0
	err := DoWithRetry(ctx, policy, func(ctx context.Context) error {
		attempts++
		// Simulasi error validasi / client error (Non-transient)
		return context.Canceled 
	})

	if err == nil {
		t.Fatal("expected error")
	}
	
	if attempts != 1 {
		t.Fatalf("expected to fail fast on first attempt for non-transient, got %d attempts", attempts)
	}
}
```
