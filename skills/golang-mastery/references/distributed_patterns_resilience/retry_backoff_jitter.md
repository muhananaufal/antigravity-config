# Retry dengan Exponential Backoff + Jitter

> **Berlaku:** Go 1.21+ · `cenkalti/backoff/v4` · **Lihat juga:** `observability_resilience/circuit_breaker_hystrix.md` · `distributed_patterns_resilience/idempotency_key_engine.md` · `microservices_grpc/http_client_production.md` · `distributed_patterns_resilience/bulkhead_isolation.md`

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
	"io"
	"math/rand"
	"net"
	"net/http"
	"syscall"
	"time"
)

var ErrKebijakanTidakValid = errors.New("kebijakan retry tidak valid")

// ErrTransient adalah opt-in eksplisit. Bungkus galat domain Anda dengan ini
// bila Anda TAHU ia layak diulang tetapi klasifikasi di bawah tidak mengenalinya
// (misalnya galat dari driver pihak ketiga).
var ErrTransient = errors.New("galat sementara")

// Policy mendefinisikan konfigurasi Retry.
type Policy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration

	// SetengahJitter memilih Equal Jitter alih-alih Full Jitter.
	// Perbandingannya ada di bagian "Tiga varian jitter" di bawah.
	SetengahJitter bool

	// Acak disuntikkan agar kalkulasi jeda bisa diuji secara deterministik.
	// Nil berarti rand.Float64.
	Acak func() float64
}

// Validasi menolak kebijakan yang secara diam-diam melumpuhkan retry.
//
// Tanpa ini, Policy{} kosong menghasilkan MaxAttempts=0: loop tidak pernah
// berjalan, operasinya TIDAK PERNAH DIPANGGIL SAMA SEKALI, dan fungsi
// mengembalikan galat "exhausted all 0 retries" yang membungkus err yang masih
// nil. Sebuah operasi yang tidak pernah dieksekusi dilaporkan sebagai
// operasi yang gagal setelah kehabisan percobaan.
//
// BaseDelay=0 sama berbahayanya: setiap jeda menjadi nol dan retry berubah
// menjadi loop panas -- yaitu persis thundering herd yang berkas ini ada untuk
// mencegahnya.
func (p Policy) Validasi() error {
	if p.MaxAttempts < 1 {
		return fmt.Errorf("%w: MaxAttempts=%d, minimal 1", ErrKebijakanTidakValid, p.MaxAttempts)
	}
	if p.BaseDelay <= 0 {
		return fmt.Errorf("%w: BaseDelay=%v, harus > 0", ErrKebijakanTidakValid, p.BaseDelay)
	}
	if p.MaxDelay > 0 && p.MaxDelay < p.BaseDelay {
		return fmt.Errorf("%w: MaxDelay=%v lebih kecil dari BaseDelay=%v",
			ErrKebijakanTidakValid, p.MaxDelay, p.BaseDelay)
	}
	return nil
}

// Jeda menghitung waktu tunggu untuk percobaan ke-`attempt` (0-based).
//
// Dipisah dari DoWithRetry SECARA SENGAJA. Selama kalkulasi ini terkubur di
// dalam loop, satu-satunya cara mengujinya adalah mengukur waktu tidur --
// uji yang lambat dan flaky, sehingga dalam praktiknya tidak pernah ditulis.
// Sebagai fungsi murni dengan sumber acak yang disuntikkan, backoff dan jitter
// bisa diasersi secara eksak dan instan.
func (p Policy) Jeda(attempt int) time.Duration {
	acak := p.Acak
	if acak == nil {
		acak = rand.Float64
	}

	// `1 << attempt` MELUAP menjadi 0 atau negatif pada attempt >= 63, yang
	// membuat jeda menjadi nol atau negatif -- timer langsung menyala dan
	// retry berubah jadi loop panas. Batasi eksponennya, jangan andalkan
	// MaxDelay untuk menyelamatkan aritmetika yang sudah rusak.
	const eksponenMaks = 32
	if attempt > eksponenMaks {
		attempt = eksponenMaks
	}
	if attempt < 0 {
		attempt = 0
	}

	backoff := float64(p.BaseDelay) * float64(uint64(1)<<uint(attempt))
	if p.MaxDelay > 0 && backoff > float64(p.MaxDelay) {
		backoff = float64(p.MaxDelay)
	}

	if p.SetengahJitter {
		// Equal Jitter: separuh tetap + separuh acak. Menjamin jeda minimum.
		return time.Duration(backoff/2 + acak()*backoff/2)
	}
	// Full Jitter: random(0, backoff).
	return time.Duration(acak() * backoff)
}

// IsTransientError menentukan apakah error layak di-retry.
//
// PRINSIPNYA: DAFTAR-IZIN, BUKAN DAFTAR-TOLAK.
//
// Bentuk yang jauh lebih sering ditulis -- menolak beberapa galat lalu
// `return true` di akhir -- berarti SETIAP galat yang tidak terpikirkan saat
// menulisnya akan diulang: 400 Bad Request, 401, 404, kegagalan validasi,
// galat unmarshal, bahkan nil pointer dereference yang sudah di-recover.
// Itu persis Anti-Pattern 2 di bagian bawah berkas ini. Galat yang tidak
// dikenali adalah galat yang BELUM TERBUKTI sementara, dan default yang aman
// untuk sesuatu yang belum terbukti adalah menolak.
//
// Biayanya asimetris dan itulah alasan sebenarnya: tidak mengulang galat yang
// sebetulnya sementara berarti satu permintaan gagal. Mengulang galat permanen
// berarti mengalikan beban ke hilir yang sedang sekarat, berkali-kali, untuk
// hasil yang sudah pasti sama.
func IsTransientError(err error) bool {
	if err == nil {
		return false
	}

	// 1. Pembatalan pemanggil: JANGAN PERNAH diulang. Pemanggilnya sudah pergi.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	// 2. Opt-in eksplisit dari kode domain.
	if errors.Is(err, ErrTransient) {
		return true
	}

	// 3. Timeout jaringan -- satu-satunya kategori net.Error yang benar-benar
	//    layak diulang. Jangan pakai net.Error saja: galat DNS "no such host"
	//    juga net.Error dan tidak akan berubah karena diulang.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}

	// 4. Kegagalan soket yang khas terjadi saat hilir sedang restart.
	//    errors.Is menembus *net.OpError -> *os.SyscallError -> syscall.Errno.
	if errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE) {
		return true
	}

	// 5. Koneksi terputus di tengah respons.
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}

	// 6. Belum terbukti sementara -> TOLAK.
	return false
}

// StatusLayakDiulang mengklasifikasi kode status HTTP.
//
// Sengaja konservatif: 500 TIDAK termasuk. 500 sama seringnya berarti bug
// deterministik di hilir (panic pada input tertentu) seperti berarti gangguan
// sementara, dan mengulang input yang memicu panic hanya memicu panic lagi.
// Bila hilir Anda memang memakai 500 untuk gangguan sementara, itu keputusan
// sadar yang layak ditulis di sini -- bukan default.
func StatusLayakDiulang(kode int) bool {
	switch kode {
	case http.StatusRequestTimeout, // 408
		http.StatusTooManyRequests,    // 429
		http.StatusBadGateway,         // 502
		http.StatusServiceUnavailable, // 503
		http.StatusGatewayTimeout:     // 504
		return true
	}
	return false
}

// JedaDariRetryAfter membaca header Retry-After.
//
// Bila hilir memberi tahu KAPAN harus kembali, angka itu mengalahkan backoff
// hasil tebakan Anda: ia tahu berapa lama pemulihannya, Anda tidak. Mengabaikan
// Retry-After pada 429 adalah cara tercepat berpindah dari dibatasi-rate
// menjadi diblokir.
//
// Formatnya bisa detik ("120") atau tanggal HTTP.
func JedaDariRetryAfter(h http.Header) (time.Duration, bool) {
	v := h.Get("Retry-After")
	if v == "" {
		return 0, false
	}
	if detik, err := time.ParseDuration(v + "s"); err == nil && detik > 0 {
		return detik, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
	}
	return 0, false
}

// DoWithRetry mengeksekusi operasi menggunakan Exponential Backoff + Jitter.
func DoWithRetry(ctx context.Context, p Policy, operation func(ctx context.Context) error) error {
	if errKebijakan := p.Validasi(); errKebijakan != nil {
		return errKebijakan
	}

	var err error

	for attempt := 0; attempt < p.MaxAttempts; attempt++ {
		// 1. Eksekusi operasi
		err = operation(ctx)
		if err == nil {
			return nil // Berhasil, keluar dari loop
		}

		// 2. Evaluasi Error (Jangan retry error fatal/client error)
		if !IsTransientError(err) {
			return fmt.Errorf("galat non-transient pada percobaan %d: %w", attempt+1, err)
		}

		// Jika ini adalah percobaan terakhir, tidak perlu menunggu
		if attempt == p.MaxAttempts-1 {
			break
		}

		// 3. Backoff eksponensial + jitter (fungsi murni, teruji terpisah)
		tunggu := p.Jeda(attempt)

		// 4. ANGGARAN RETRY HARUS MUAT DI SISA TENGGAT PEMANGGIL.
		//
		// Tanpa pemeriksaan ini, tenggat 10 detik dengan backoff 8 detik akan
		// menghabiskan 8 detik untuk menunggu, lalu memanggil operasi dengan
		// context yang tinggal 2 detik -- atau lebih sering, terbangun oleh
		// ctx.Done() setelah membuang seluruh sisa waktu tanpa satu pun
		// percobaan tambahan. Menunggu lebih lama dari sisa tenggat bukan
		// sekadar sia-sia: ia MENUKAR satu percobaan nyata dengan nol.
		//
		// Batasnya jujur: kita tidak tahu berapa lama operasinya sendiri akan
		// berjalan, jadi ini mencegah kasus yang jelas rugi, bukan menjamin
		// percobaan berikutnya pasti selesai.
		if tenggat, ada := ctx.Deadline(); ada {
			if sisa := time.Until(tenggat); tunggu >= sisa {
				return fmt.Errorf("anggaran retry tidak muat di sisa tenggat (%v tunggu, %v sisa): %w (galat terakhir: %w)",
					tunggu, sisa, context.DeadlineExceeded, err)
			}
		}

		// 5. Tidur sambil mengawasi pembatalan context.
		// TIDAK BOLEH time.Sleep: ia tidak bisa dibangunkan oleh ctx.
		timer := time.NewTimer(tunggu)
		select {
		case <-ctx.Done():
			timer.Stop()
			// Dua %w sekaligus (Go 1.20+). Meratakan galat terakhir dengan %v
			// -- bentuk yang lebih sering ditulis -- membuat pemanggil TIDAK
			// BISA lagi memeriksanya dengan errors.Is, sehingga alasan
			// sebenarnya operasi ini gagal hilang tepat di lapisan yang
			// tugasnya melaporkan kegagalan.
			return fmt.Errorf("context dibatalkan saat menunggu retry: %w (galat terakhir: %w)", ctx.Err(), err)
		case <-timer.C:
			// Lanjut ke percobaan berikutnya
		}
	}

	return fmt.Errorf("habis setelah %d percobaan, galat terakhir: %w", p.MaxAttempts, err)
}
```

### Tiga varian jitter — "algoritma AWS" itu ada tiganya

Artikel AWS yang sering dikutip (*Exponential Backoff And Jitter*) membandingkan tiga varian, bukan menetapkan satu. Memilihnya sembarangan berarti mengambil trade-off tanpa tahu sedang mengambilnya.

| Varian | Rumus | Sifat |
| :--- | :--- | :--- |
| **Full Jitter** | `random(0, backoff)` | Sebaran paling merata, beban hilir paling halus. Tapi ekspektasi jeda hanya `backoff/2`, dan satu percobaan bisa mendapat jeda **nyaris nol** — untuk percobaan itu, backoff-nya efektif tidak ada. |
| **Equal Jitter** | `backoff/2 + random(0, backoff/2)` | Menjamin jeda minimum `backoff/2`. Lebih aman bila hilir butuh waktu pulih yang pasti; sebarannya sedikit lebih menggumpal. |
| **Decorrelated Jitter** | `min(maks, random(base, jeda_sebelumnya*3))` | Jeda bertumbuh dari jeda SEBELUMNYA, bukan dari nomor percobaan. Pada simulasi AWS ia menyelesaikan pekerjaan tercepat dengan beban server yang tetap rendah, tetapi butuh menyimpan state antar percobaan. |

Pemilihan praktisnya: **Full Jitter** untuk klien yang banyak dan pendek (mobile, browser) di mana meratakan beban adalah segalanya; **Equal Jitter** ketika hilir butuh jeda minimum yang terjamin untuk pulih (`Policy{SetengahJitter: true}`).

Satu hal yang sering ditanyakan: `math/rand` — bukan `crypto/rand` — memang pilihan yang benar di sini. Jitter tidak perlu tak-tertebak secara kriptografis; ia hanya perlu tidak sinkron. `crypto/rand` menambah syscall di jalur yang justru dieksekusi saat sistem sedang tertekan. (Pada Go 1.22+, `math/rand/v2` juga menghilangkan mutex global yang di-`math/rand` menjadi titik contention saat ribuan goroutine me-retry bersamaan — persis skenario yang berkas ini bahas.)

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
// GOOD: klasifikasi galat transport DAN kode status, lalu fail-fast.
err := DoWithRetry(ctx, policy, func(ctx context.Context) error {
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
    if err != nil {
        return err // pembentukan request gagal: permanen, tidak akan diulang
    }

    resp, err := klien.Do(req)
    if err != nil {
        return err // IsTransientError yang memutuskan (timeout, ECONNRESET, ...)
    }
    // WAJIB, di SETIAP jalur keluar. Body yang tidak ditutup menahan koneksi
    // di pool sampai habis -- dan retry-lah yang paling cepat menghabiskannya.
    defer resp.Body.Close()

    if resp.StatusCode >= 400 {
        // Kuras body sebelum menutup agar koneksinya bisa dipakai ulang
        // ketimbang dibuang dan didial ulang di percobaan berikutnya.
        _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

        if StatusLayakDiulang(resp.StatusCode) {
            return fmt.Errorf("%w: status %d", ErrTransient, resp.StatusCode)
        }
        return fmt.Errorf("status permanen %d", resp.StatusCode) // 400/401/404 -> berhenti
    }
    return nil
})
```
*Tiga cacat pada bentuk yang lebih sering ditulis* (`if err != nil && !IsTransientError(err) { return err }; return retry()`):
- **Ia mengulang saat BERHASIL.** Ketika `err == nil`, kondisinya salah dan alur tetap jatuh ke `retry()` — respons `200 OK` pun diulang.
- **`resp.StatusCode` tidak pernah dilihat.** Untuk `http.Client`, respons `400` maupun `503` sama-sama `err == nil`; klasifikasi galat transport saja tidak pernah bisa membedakan keduanya.
- **`resp.Body` tidak pernah ditutup.** Setiap percobaan menahan satu koneksi. Kebocoran ini paling cepat menggigit justru saat retry paling aktif.

## 4. Edge Cases Spesifik

1. **Context Deadline Exceeded di Tengah Backoff Window**:
   Jika *caller* memberi `context.WithTimeout(ctx, 10s)`, dan percobaan ke-3 mengkalkulasi waktu tidur (backoff) 8 detik sementara sisa waktu (deadline) *context* tinggal 2 detik, Goroutine *akan terbangun oleh `<-ctx.Done()`* sebelum *timer* selesai. Implementasi yang buruk (menggunakan `time.Sleep()`) akan menyebabkan *goroutine leak* selama sisa 6 detik tersebut. Kode produksi *wajib* menggunakan `select` dan `time.Timer`.

2. **Retry Amplification (Cascading Retries)**:
   Service A memanggil Service B (Max Retry = 3). Service B memanggil Service C (Max Retry = 3).
   Jika Service C mati, satu request dari User ke Service A akan memicu `1 * 3 * 3 = 9` request ke Service C. Jika ada 1.000 user per detik, Service C akan dibanjiri 9.000 request per detik saat ia paling rentan.
   *Penanganan*: *Retry* sebaiknya hanya dilakukan di satu lapis (layer) sistem, biasanya di sistem terluar atau yang paling dekat dengan *client*. Internal service lebih baik segera *fail fast* ke atas menggunakan *Circuit Breaker*.

   *Masalahnya, "hanya satu lapis" adalah kesepakatan, bukan mekanisme.* Ia bertahan tepat sampai satu tim menambahkan retry di klien HTTP-nya "untuk jaga-jaga", dan tidak ada satu pun build yang gagal karenanya. Yang menegakkannya di produksi adalah **retry budget** (istilah gRPC: `retryThrottling`; di SRE Book: *retry budget*): batasi retry sebagai PERSENTASE trafik, bukan sebagai hitungan per permintaan.

   ```go
   // Anggaran retry: maksimal 10% dari trafik boleh berupa percobaan ulang.
   // Saat hilir mati total, rasio kegagalan melonjak, token habis, dan retry
   // BERHENTI SENDIRI -- persis ketika ia paling merusak. Retry per-permintaan
   // justru melakukan kebalikannya: makin banyak yang gagal, makin banyak yang
   // diulang.
   type AnggaranRetry struct {
       mu     sync.Mutex
       token  float64
       maks   float64
       rasio  float64 // token yang dipulihkan per permintaan sukses
   }

   func (a *AnggaranRetry) BolehUlang() bool {
       a.mu.Lock()
       defer a.mu.Unlock()
       if a.token < 1 {
           return false // anggaran habis: fail fast, jangan tambah beban
       }
       a.token--
       return true
   }

   func (a *AnggaranRetry) CatatSukses() {
       a.mu.Lock()
       defer a.mu.Unlock()
       if a.token += a.rasio; a.token > a.maks {
           a.token = a.maks
       }
   }
   ```

   Perbedaan sifatnya yang menentukan: batas per-permintaan (`MaxAttempts: 3`) **naik** seiring tingkat kegagalan, anggaran berbasis rasio **turun**. Yang pertama menendang sistem yang sedang jatuh; yang kedua melepaskannya. Bila Anda memakai service mesh (Istio/Linkerd), fitur ini sudah ada di sana — pakai itu, dan pastikan retry di aplikasi dimatikan agar tidak berlapis.

3. **Operasi yang Tidak Idempotent (Misal: POST Payment)**:
   Sebuah *request* `HTTP POST /charge-card` dikirimkan. Server memprosesnya secara sukses, namun balasan jaringannya terputus (`Connection Reset`). Klien melihatnya sebagai error dan melakukan *retry*. Klien ditagih (charged) dua kali.
   *Penanganan*: Jangan pernah me-*retry* operasi non-idempotent TANPA menambahkan **Idempotency Key** di Header/Payload. Server harus menolak operasi duplikat dari *Idempotency Key* yang sama.

## 5. Unit Tests (Behavioral Testing)

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"net"
	"syscall"
	"testing"
	"time"
)

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

// galatSementara adalah net.Error dengan Timeout()==true -- bentuk galat yang
// benar-benar diterima klasifikasi daftar-izin. errors.New("simulated network
// timeout") TIDAK, dan memang tidak boleh: namanya menyebut timeout, isinya
// tidak. Uji lama lolos hanya karena IsTransientError dulu mengulang apa saja.
type galatSementara struct{}

func (galatSementara) Error() string { return "timeout jaringan tersimulasi" }
func (galatSementara) Timeout() bool { return true }
func (galatSementara) Temporary() bool { return true }

var _ net.Error = galatSementara{}

func TestDoWithRetry_SuccessOnThirdAttempt(t *testing.T) {
	ctx := context.Background()
	policy := Policy{
		MaxAttempts: 5,
		BaseDelay:   10 * time.Millisecond,
		MaxDelay:    100 * time.Millisecond,
	}

	api := &mockAPI{errs: []error{galatSementara{}, galatSementara{}}}

	err := DoWithRetry(ctx, policy, api.Call)

	if err != nil {
		t.Fatalf("mengharapkan sukses, dapat galat: %v", err)
	}
	if api.attempts != 3 {
		t.Fatalf("mengharapkan 3 percobaan, dapat %d", api.attempts)
	}
}

// Kalkulasi jeda diuji sebagai fungsi murni: eksak, instan, tanpa tidur.
func TestPolicy_Jeda(t *testing.T) {
	p := Policy{
		MaxAttempts: 10,
		BaseDelay:   100 * time.Millisecond,
		MaxDelay:    1 * time.Second,
		Acak:        func() float64 { return 1.0 }, // jitter maksimum: deterministik
	}

	// Backoff eksponensial, lalu terpotong MaxDelay.
	for _, k := range []struct {
		attempt int
		mau     time.Duration
	}{
		{0, 100 * time.Millisecond},
		{1, 200 * time.Millisecond},
		{2, 400 * time.Millisecond},
		{3, 800 * time.Millisecond},
		{4, 1 * time.Second}, // 1600ms dipotong ke MaxDelay
		{9, 1 * time.Second},
	} {
		if got := p.Jeda(k.attempt); got != k.mau {
			t.Errorf("Jeda(%d) = %v, mau %v", k.attempt, got, k.mau)
		}
	}

	// Full Jitter WAJIB bisa menghasilkan nyaris nol -- itu definisinya.
	pNol := p
	pNol.Acak = func() float64 { return 0 }
	if got := pNol.Jeda(3); got != 0 {
		t.Errorf("Full Jitter dengan acak=0 harus 0, dapat %v", got)
	}

	// Equal Jitter MENJAMIN separuh backoff sebagai lantai.
	pEqual := p
	pEqual.SetengahJitter = true
	pEqual.Acak = func() float64 { return 0 }
	if got := pEqual.Jeda(3); got != 400*time.Millisecond {
		t.Errorf("Equal Jitter dengan acak=0 harus separuh backoff (400ms), dapat %v", got)
	}
}

// Eksponen besar dulu meluap menjadi jeda nol atau negatif -- timer menyala
// seketika dan retry berubah menjadi loop panas tanpa jeda sama sekali.
func TestPolicy_Jeda_EksponenBesarTidakMeluap(t *testing.T) {
	p := Policy{
		MaxAttempts: 100,
		BaseDelay:   time.Second,
		MaxDelay:    30 * time.Second,
		Acak:        func() float64 { return 1.0 },
	}
	for _, attempt := range []int{62, 63, 64, 99} {
		if got := p.Jeda(attempt); got != 30*time.Second {
			t.Errorf("Jeda(%d) = %v, mau 30s (terpotong MaxDelay)", attempt, got)
		}
	}
}

// Policy{} kosong dulu TIDAK PERNAH memanggil operasinya, lalu melaporkan
// "kehabisan percobaan" -- kegagalan yang dilaporkan atas pekerjaan yang tidak
// pernah dilakukan.
func TestDoWithRetry_KebijakanTidakValidDitolak(t *testing.T) {
	for nama, p := range map[string]Policy{
		"kosong":            {},
		"tanpa percobaan":   {MaxAttempts: 0, BaseDelay: time.Millisecond},
		"base delay nol":    {MaxAttempts: 3},
		"maks < base":       {MaxAttempts: 3, BaseDelay: time.Second, MaxDelay: time.Millisecond},
	} {
		t.Run(nama, func(t *testing.T) {
			dipanggil := 0
			err := DoWithRetry(context.Background(), p, func(context.Context) error {
				dipanggil++
				return nil
			})
			if !errors.Is(err, ErrKebijakanTidakValid) {
				t.Errorf("mengharapkan ErrKebijakanTidakValid, dapat %v", err)
			}
			if dipanggil != 0 {
				t.Errorf("operasi tidak boleh dijalankan dengan kebijakan tidak valid")
			}
		})
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

	galatHilir := galatSementara{}
	start := time.Now()
	err := DoWithRetry(ctx, policy, func(ctx context.Context) error {
		return galatHilir
	})
	duration := time.Since(start)

	if err == nil {
		t.Fatal("mengharapkan galat karena pembatalan context")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("mengharapkan deadline exceeded, dapat: %v", err)
	}

	// Galat TERAKHIR dari hilir wajib tetap bisa diperiksa. Dengan `%v` --
	// bentuk yang lebih sering ditulis -- assersi ini gagal, dan pemanggil
	// kehilangan satu-satunya petunjuk mengapa operasinya sebenarnya gagal.
	if !errors.Is(err, galatHilir) {
		t.Errorf("galat terakhir dari hilir hilang dari rantai: %v", err)
	}

	// Memastikan tidak ter-block melebihi context timeout
	if duration > 100*time.Millisecond {
		t.Fatalf("retry terlalu lama (%v), select ctx.Done gagal", duration)
	}
}

func TestDoWithRetry_NoRetryOnNonTransient(t *testing.T) {
	ctx := context.Background()
	policy := Policy{MaxAttempts: 5, BaseDelay: 1 * time.Millisecond, MaxDelay: 10 * time.Millisecond}

	// Galat aplikasi biasa -- BUKAN context.Canceled. Uji lama memakai
	// context.Canceled, satu-satunya galat yang dulu ditolak IsTransientError,
	// sehingga ia lolos justru karena cacatnya: 400 Bad Request, kegagalan
	// validasi, dan galat unmarshal semuanya tetap diulang tanpa ketahuan.
	galatValidasi := errors.New("400 bad request: field email tidak valid")

	attempts := 0
	err := DoWithRetry(ctx, policy, func(ctx context.Context) error {
		attempts++
		return galatValidasi
	})

	if !errors.Is(err, galatValidasi) {
		t.Fatalf("mengharapkan galat membungkus galatValidasi, dapat %v", err)
	}
	if attempts != 1 {
		t.Fatalf("galat non-transient harus fail-fast di percobaan pertama, dapat %d percobaan", attempts)
	}
}

func TestIsTransientError_Klasifikasi(t *testing.T) {
	kasus := []struct {
		nama string
		err  error
		mau  bool
	}{
		{"nil", nil, false},
		{"context dibatalkan", context.Canceled, false},
		{"tenggat terlampaui", context.DeadlineExceeded, false},
		{"galat aplikasi biasa", errors.New("validasi gagal"), false},
		{"galat aplikasi terbungkus", fmt.Errorf("simpan: %w", errors.New("kolom unik bentrok")), false},
		{"opt-in eksplisit", fmt.Errorf("%w: status 503", ErrTransient), true},
		{"timeout jaringan", galatSementara{}, true},
		{"koneksi ditolak", syscall.ECONNREFUSED, true},
		{"koneksi di-reset", fmt.Errorf("baca: %w", syscall.ECONNRESET), true},
	}
	for _, k := range kasus {
		t.Run(k.nama, func(t *testing.T) {
			if got := IsTransientError(k.err); got != k.mau {
				t.Errorf("IsTransientError(%v) = %v, mau %v", k.err, got, k.mau)
			}
		})
	}
}

func TestStatusLayakDiulang(t *testing.T) {
	for kode, mau := range map[int]bool{
		400: false, 401: false, 403: false, 404: false, 422: false,
		408: true, 429: true, 502: true, 503: true, 504: true,
		500: false, // sengaja konservatif -- lihat komentar pada fungsinya
		501: false,
		200: false,
	} {
		if got := StatusLayakDiulang(kode); got != mau {
			t.Errorf("StatusLayakDiulang(%d) = %v, mau %v", kode, got, mau)
		}
	}
}
```

## Kapan JANGAN Pakai Ini

- **Pada operasi non-idempoten tanpa idempotency key.** Permintaan yang sebenarnya sudah sampai — hanya responsnya yang hilang di jaringan — akan dieksekusi dua kali. Pada pembayaran, itu uang pelanggan.
- **Pada galat yang pasti tidak akan berubah.** `400`, `401`, `403`, `404`, dan kegagalan validasi tidak menjadi benar karena diulang. Mengulanginya hanya membakar kuota dan menunda kegagalan yang sudah pasti.
- **Tanpa jitter.** Semua klien yang gagal pada detik yang sama akan mencoba lagi pada detik yang sama. Backoff eksponensial tanpa jitter menghasilkan gelombang serempak yang menjaga hilir tetap mati.
- **Berlapis di beberapa tingkat.** Klien HTTP retry 3×, service mesh retry 3×, pemanggil retry 3× — itu 27 permintaan untuk satu operasi logis, tepat ketika hilir paling tidak sanggup menerimanya.
- **Dengan total waktu melebihi deadline pemanggil.** Pemanggil sudah pergi; percobaan berikutnya hanya membebani hilir tanpa ada yang menerima hasilnya. Anggaran retry WAJIB muat di dalam sisa deadline.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Trafik ke hilir jauh melebihi trafik masuk | rasio permintaan keluar/masuk | Retry berlapis mengalikan beban |
| Hilir tidak pernah pulih setelah gangguan singkat | apakah ada jitter | Gelombang serempak menghantam terus-menerus |
| Efek ganda di sistem penerima | idempotency key | Retry pada operasi yang tidak idempoten |
| Latensi p99 melonjak berlipat dari p50 | jumlah percobaan per permintaan | Retry menambah waktu, bukan mengurangi kegagalan |
| Retry pada galat `4xx` | klasifikasi galat | Galat permanen ikut diulang |

```bash
curl -s localhost:9090/metrics | grep -E 'retry_(attempts|exhausted)_total'

# Sebaran jumlah percobaan: puncak di angka maksimum berarti retry sia-sia
kubectl logs -l app=api --since=1h | jq -r 'select(.percobaan) | .percobaan' | sort -n | uniq -c

# PromQL untuk mendeteksi retry berlapis:
#   sum(rate(http_client_requests_total[5m])) / sum(rate(http_server_requests_total[5m]))
#   nilai jauh di atas 1 berarti satu permintaan masuk menghasilkan banyak keluar
```
