# Context, Cancellation, & Timeouts

> **Berlaku:** Go 1.21+ (`WithoutCancel`, `AfterFunc`) · **Lihat juga:** `concurrency/goroutine_leak_detection.md` · `concurrency/worker_pool_errgroup.md` · `observability_resilience/graceful_shutdown_drain.md` · `microservices_grpc/http_client_production.md`

## Konsep Utama
Paket `context` adalah tulang punggung (backbone) fundamental untuk manajemen siklus hidup goroutine dan propagasi *request-scoped data* di seluruh batas-batas API (API boundaries) pada ekosistem Go. Pattern ini wajib (mandatory) digunakan terutama pada aplikasi berbasis jaringan/HTTP, database driver, dan Microservices.

1. **Propagation & Tree Structure**: Context membentuk hierarki pohon berantai. Mulai dari `context.Background()` (akar), Anda menciptakan anak-anak context. Aturan fundamentalnya: Jika parent context dibatalkan (cancelled) atau timeout, maka *semua* child context yang lahir darinya (hingga keturunan terdalam) akan otomatis memancarkan sinyal pembatalan. Ini menjamin proses *teardown* goroutine berantai berjalan mulus dan instan.
2. **`context.WithTimeout` vs `context.WithDeadline`**: Secara internal mereka memanggil fungsi yang sama. `WithTimeout` mengambil durasi relatif (e.g., "batal dalam 5 detik ke depan"), sedangkan `WithDeadline` mengambil *absolute time* menggunakan `time.Time` (e.g., "batal tepat pada pukul 12:00 UTC").
3. **Context Values**: `context.WithValue` menempelkan key-value metadata ke context. Harus digunakan **hanya** untuk *request-scoped data* (misal: Trace ID, Request ID, API Key yang sedang login) yang harus melintasi lapisan sistem (dari middleware ke database layer). Sama sekali **BUKAN** untuk melakukan passing (injeksi) parameter fungsi seperti pool database connection atau logger.
4. **`context.WithCancelCause` (Go 1.20+)**: Resolusi atas kelemahan masa lalu. Sebelumnya, cancel hanya mengembalikan pesan error statis generik `context.Canceled`. API baru ini memungkinkan caller menyuntikkan *custom error* (Penyebab/Cause) yang spesifik saat membatalkan, membuat debugging pada *deep hierarchy* menjadi transparan.

## Diagram ASCII

```text
                      Background Context (Akar/Root)
                                |
                   WithCancel (Context B) [Batal jika request HTTP putus]
                   /                    \
     WithTimeout (Context C)         WithValue (Context D)
           [Max 5 seconds]            Key: "TraceID", Val: "uuid-123"
           /         \                          |
   [Worker DB 1]    [Worker DB 2]         [Worker Logging]

  * Sifat Aliran:
    - Jika Context B di-cancel (Client Disconnect), Worker 1,2 dan Logging mati.
    - Jika Context C timeout (DB Lemot > 5s), HANYA Worker 1 dan 2 yang mati. Logging tetap hidup.
```

## Kode Go Production-Ready

```go
package concurrency

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// ContextKey menggunakan custom type unexported agar terhindar 
// dari collision key string global antar package.
type contextKey string
const userIDKey contextKey = "userID"

// ContextWithUserID membungkus parent context dengan userID (Request-scoped).
func ContextWithUserID(ctx context.Context, userID int) context.Context {
	return context.WithValue(ctx, userIDKey, userID)
}

// UserIDFromContext mengekstrak userID dari context jika ada.
func UserIDFromContext(ctx context.Context) (int, bool) {
	id, ok := ctx.Value(userIDKey).(int)
	return id, ok
}

// FetchUser memodelkan context-aware database/API call.
// Menggunakan API Go 1.20+ (WithCancelCause).
func FetchUser(ctx context.Context, simulatedLatency time.Duration) error {
	// 1. Ekstraksi data dari context
	userID, ok := UserIDFromContext(ctx)
	if !ok {
		return fmt.Errorf("context: %w", errors.New("userID missing in context"))
	}

	// 2. Terapkan timeout mandiri yang ketat (internal fallback).
	// Jika parent memiliki timeout lebih singkat, child ini akan otomatis mematuhinya.
	dbCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel() // Wajib agar memori timer dilepaskan setelah eksekusi

	errCh := make(chan error, 1) // Buffered channel, prevent leak on timeout

	// 3. Simulasi operasi blocking/Query I/O Database di background
	go func() {
		// Menggunakan dbCtx.Done() tidak bisa men-cancel sleep langsung.
		// Pada realita `sql.DB.QueryContext`, driver DB mendengarkan cancel ini.
		// Kita lakukan polling manual singkat:
		select {
		case <-time.After(simulatedLatency):
			// Berhasil selesai
			_ = userID // Logika fetch data pakai userID berjalan
			errCh <- nil
		case <-dbCtx.Done():
			// Dibatalkan selama query berjalan
			errCh <- context.Cause(dbCtx)
		}
	}()

	// 4. Sinkronisasi respons utama
	select {
	case <-dbCtx.Done():
		// Batal dari parent atau timeout internal
		return fmt.Errorf("operation failed: %w", context.Cause(dbCtx))
	case err := <-errCh:
		// Operasi selesai alami (bisa sukses atau error query db)
		if err != nil {
			return fmt.Errorf("query error: %w", err)
		}
		return nil
	}
}

// ==========================================
// UNIT TEST
// ==========================================

func TestFetchUser_Success(t *testing.T) {
	defer goleak.VerifyNone(t)
	ctx := ContextWithUserID(context.Background(), 99)
	
	// Selesai dalam 50ms, batasnya 100ms
	err := FetchUser(ctx, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("expected success, got err: %v", err)
	}
}

func TestFetchUser_InternalTimeout(t *testing.T) {
	defer goleak.VerifyNone(t)
	ctx := ContextWithUserID(context.Background(), 99)
	
	// Operasi butuh 150ms, timeout internalnya 100ms.
	// Harus gagal dengan deadline exceeded.
	err := FetchUser(ctx, 150*time.Millisecond)
	if err == nil {
		t.Fatalf("expected error due to timeout, got nil")
	}
	
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", err)
	}
}

func TestFetchUser_ParentCancellationWithCause(t *testing.T) {
	defer goleak.VerifyNone(t)
	ctx := ContextWithUserID(context.Background(), 99)
	
	// Parent menggunakan Custom Error Cause (Go 1.20+)
	customErr := errors.New("user clicked abort button")
	cancelCtx, cancelCause := context.WithCancelCause(ctx)
	
	// Eksekusi asinkron, sengaja butuh waktu lama
	errCh := make(chan error)
	go func() {
		errCh <- FetchUser(cancelCtx, 500*time.Millisecond)
	}()

	// Beri waktu 10ms sebelum dibatalkan user
	time.Sleep(10 * time.Millisecond)
	cancelCause(customErr)
	
	err := <-errCh
	
	// Periksa apakah error custom dari Parent Cause diteruskan hingga keluar (propagasi)
	if !errors.Is(err, customErr) {
		t.Fatalf("expected custom cause %v, got %v", customErr, err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Tipe Bawaan (Built-in) untuk Context Key

```go
// ❌ BAD: Key menggunakan string built-in telanjang
ctx = context.WithValue(ctx, "session_id", "abc")
// BAD: Bisa bertabrakan dengan framework/package lain yang juga 
// tidak sengaja memakai key "session_id", menimpa value secara diam-diam.

// ✅ GOOD: Buat type alias (unexported) untuk jaminan unik
type ctxKey string
const sessionKey ctxKey = "session_id"
ctx = context.WithValue(ctx, sessionKey, "abc")
// GOOD: Paket luar tak mungkin menebak dan menimpa key private ini.
```

**Why dangerous:** Context values beroperasi seperti dictionary berantai yang menggunakan interface kosong `interface{}` dan pemeriksaannya mengandalkan kesamaan (`==`). Jika Anda memakai `string` standar bawaan, paket eksternal (misal APM tracer library) yang kebetulan menggunakan key string `"session_id"` yang sama akan saling merusak dan menimpa (overwrite) atau membaca value Anda. Ini menimbulkan bug kebocoran informasi yang mustahil terlacak saat fase compile.

### ❌ Anti-Pattern 2: Passing Dependensi Fungsional via Context

```go
// ❌ BAD: Menjejalkan koneksi database sebagai value
ctx = context.WithValue(ctx, "db_conn", sqlConnectionPool)
func getUser(ctx context.Context) {
    db := ctx.Value("db_conn").(*sql.DB) // rentan panic jika tidak diset!
}
// BAD: Menyembunyikan kebutuhan parameter API. Caller tidak tahu fungsi butuh db.

// ✅ GOOD: Passing via receiver struct (dependency injection konvensional)
type UserRepository struct {
    db *sql.DB
}
func (repo *UserRepository) GetUser(ctx context.Context, id int) {
    repo.db.QueryContext(ctx, "SELECT...", id) 
}
// GOOD: Type-safe, transparan, dan tidak bisa dikompile jika DB lupa disuntikkan.
```

**Why dangerous:** Hal ini merusak *Type-Safety* dan transparansi API khas Go. Saat melempar struct/DB/logger ke dalam context, tidak ada compiler yang mengecek ketersediaannya. Saat memanggil method `getUser`, tidak ada yang menggaransi bahwa context membawa instance DB. Di production, ini menjadi sumber utama `panic: nil pointer dereference` saat runtime jika ada caller baru yang melempar `context.Background()` kosong. Gunakan Context secara ketat hanya untuk mem-passing *Request Scoped Data* (seperti trace/auth ID).

## Edge Cases

1. **Context Leak karena Lupa Cancel**: Memanggil `ctx, cancel := context.WithTimeout(...)` atau `WithCancel` membuat entri timer baru yang dicatat di goroutine system milik Go Runtime. Jika Anda tidak pernah memanggil `cancel()`, object timer ini akan tersangkut di memori (memory leak) hingga durasi timeout murni habis, meskipun eksekusi logic fungsi sudah lama selesai (return awal). 
   - *Defensive*: Selalu letakkan baris `defer cancel()` **persis** setelah baris inisialisasi, tanpa kecuali. Pemanggilan ulang cancel sangat murah dan *safe* (idempotent).

2. **Context Value Lookup O(N) Depth Drop**: Proses pengambilan `ctx.Value()` sangat tidak efisien. Go membacanya dengan berjalan mundur (traverse up) menyusuri pohon pointer (linked-list hirarkis context) node-demi-node. Mem-passing puluhan key dengan merantai `WithValue` di HTTP middleware akan membuat depth sangat dalam. Pencarian key O(N) ini akan membebani CPU secara perlahan.
   - *Defensive*: Jangan memanggil `WithValue` secara berantai untuk 10 atribut berbeda. Kumpulkan 10 atribut itu ke dalam satu struct, lalu pass referensi (pointer) struct tersebut dalam *sekali panggil* `WithValue` agar kedalaman hirarki context tetap rendah dan flat.

3. **Goroutine Latar Belakang (Fire-and-Forget)**: Terkadang API endpoint perlu merespons ke HTTP Client (User) secepat mungkin, lalu men-spawn goroutine background (e.g. mengirim audit log atau notifikasi email). Jika Anda secara naif mem-passing *Original HTTP Request Context* ke goroutine background tersebut, *router framework* (seperti Gin/Echo) akan otomatis me-`cancel()` context saat response dikirimkan. Akibatnya background task gagal di-tengah jalan karena Context dibatalkan paksa.
   - *Defensive*: Gunakan fungsi khusus `context.WithoutCancel(parentCtx)` (tersedia di Go 1.21+) yang menciptakan context anak yang mewarisi *Values* dari parent (jadi TraceID tidak hilang), namun memutus rantai sinyal *Cancellation*, sehingga goroutine log Anda aman bekerja di background.

## Kapan JANGAN Pakai Ini

- **Untuk menghentikan komputasi CPU-bound.** Context hanya memberi *sinyal*; ia tidak menginterupsi apa pun. Loop yang tidak memeriksa `ctx.Err()` akan berjalan sampai selesai meski context sudah lama dibatalkan.
- **Sebagai wadah dependensi wajib.** Bila fungsi tidak bisa bekerja tanpa sebuah nilai, nilai itu adalah parameter — bukan isi context. Aturannya sederhana: hilangnya nilai dari context tidak boleh menyebabkan `panic`.
- **Menyalin timeout yang sama ke setiap lapisan.** Handler 5 detik → service 5 detik → repository 5 detik berarti lapisan terdalam tidak pernah punya sisa waktu untuk retry. Yang benar adalah **anggaran waktu yang menyusut**: tiap lapisan menyisakan sebagian untuk pemanggilnya.
- **Untuk pekerjaan yang WAJIB selesai** — commit outbox, penulisan audit, pelepasan lock. Membatalkannya justru merusak keadaan. Pakai `context.WithoutCancel(ctx)` agar `Values` (TraceID) tetap terbawa, lalu beri batas waktu sendiri.
- **Sebagai satu-satunya alat ketahanan.** Timeout tanpa retry dan circuit breaker hanya mengubah "lambat" menjadi "gagal cepat" — beban ke hilir tetap sama.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Lonjakan `context deadline exceeded` sementara DB sehat | p99 hilir vs nilai timeout | Anggaran waktu lebih ketat dari latensi normal hilir |
| Banyak `context canceled` pada operasi tulis | rasio canceled vs deadline | Klien memutus di tengah tulis; butuh idempotency key |
| Jumlah goroutine naik perlahan | `pprof/goroutine` | `cancel()` tidak dipanggil; timer tertahan sampai deadline |
| Pekerjaan latar mati mendadak setelah respons dikirim | apakah context request diteruskan | Framework membatalkan context saat respons selesai; butuh `WithoutCancel` |
| Retry hilir tidak pernah terjadi | sisa waktu saat masuk lapisan terdalam | Timeout disalin sama besar di tiap lapisan |

```bash
# Bedakan mati karena deadline sendiri vs klien yang pergi -- penanganannya berbeda
kubectl logs -l app=api --since=1h | grep -c 'context deadline exceeded'
kubectl logs -l app=api --since=1h | grep -c 'context canceled'

# Tren goroutine: bandingkan dua cuplikan, bukan angka absolut
curl -s 'localhost:6060/debug/pprof/goroutine' -o g1.pb.gz
# ... tunggu 10 menit ...
curl -s 'localhost:6060/debug/pprof/goroutine' -o g2.pb.gz
go tool pprof -base g1.pb.gz g2.pb.gz

# Sisa deadline yang benar-benar sampai ke lapisan terdalam.
# Catat ini sebagai field log: time.Until(deadline) saat masuk repository.
kubectl logs -l app=api --since=15m | jq -r 'select(.sisa_deadline_ms) | .sisa_deadline_ms' \
  | sort -n | head -20
```
