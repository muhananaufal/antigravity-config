# Idempotency pada Payment Engine (Distributed Systems)

## Concept/Internals
Sifat fundamental jaringan internet adalah *unreliable* (tidak dapat diandalkan). *Client* (seperti mobile app atau upstream microservice) mengirim HTTP POST untuk transaksi pembayaran $100. Jaringan terputus, *client* mendapat error `timeout` tapi *sebenarnya* server berhasil memproses uangnya di backend. *Client*, yang menganggap itu gagal, secara otomatis melakukan *retry* (coba ulang). Bencana terjadi: Saldo kepotong $200!

**Idempotency** adalah jaminan matematis bahwa sebuah fungsi/API dapat dipanggil berkali-kali secara identik dengan *dampak* (efek samping ke data/uang) yang **sama seperti dipanggil hanya 1 kali**.

Konsep inti:
- **Idempotency Key**: String UUID acak unik (RFC 4122) yang dikirim oleh pembuat transaksi (client) di header HTTP (e.g., `Idempotency-Key: uuid-v4`).
- **Idempotency Store**: Lapisan penyimpanan (Redis atau Tabel Postgres khusus) yang merekam status `Key` tersebut beserta hasil response akhir (JSON/HTTP status) jika transaksi tersebut berhasil. 

### Diagram ASCII: Aliran Idempotency (Save-and-Check Pattern)

```ascii
[ Client ] -> ( POST /pay, Key: X-123, Payload: {amt: 50} )
     |
     v
[ API Server ] ----> { Cek Key X-123 di Idempotency Store }
                     |
                 ( Ditemukan? )
                /              \
         [ YES ]                [ NO ]
           |                      |
    (Return Cached        +->(A. Lock Key X-123 in-progress)
    Response JSON         |
    & HTTP 200 OK)        +->(B. Eksekusi Pembayaran DB/3rd Party)
                          |
                          +->(C. Simpan Hasil Sukses ke Store (Key: X-123))
                          |
                          +->(D. Return HTTP 201 Created/Success)
```

## Production Code

Implementasi Idempotency wajib berbasis **Atomic Lock**. Kami memakai struktur pseudo-Redis. 

```go
package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"
)

var (
	ErrConflictIdempotency = errors.New("request payload mismatch for same idempotency key")
	ErrConcurrentExecution = errors.New("a request with this key is currently executing")
)

// IdempotencyRecord disimpan di DB/Redis
type IdempotencyRecord struct {
	Key           string
	Status        string // "IN_PROGRESS", "COMPLETED"
	PayloadHash   string // Mengamankan payload agar tak ada request beda pakai key yang sama
	CachedRespond string // JSON Body balasan sukses 
}

// Mocking Idempotency Repository
type IdempotencyStore interface {
	// TryLock atomik (seperti SETNX di Redis atau INSERT ignore PostgreSQL)
	TryLock(ctx context.Context, key string, hash string) (*IdempotencyRecord, error)
	// SaveCompleted update state menjadi COMPLETED dan menaruh balasan
	SaveCompleted(ctx context.Context, key string, responseBody string) error
}

type PaymentService struct {
	store IdempotencyStore
}

func NewPaymentService(store IdempotencyStore) *PaymentService {
	return &PaymentService{store: store}
}

// ProcessPayment mengeksekusi request aman via idempotency key
func (s *PaymentService) ProcessPayment(ctx context.Context, idempotencyKey string, payload []byte) (string, error) {
	// Kalkulasi hash dari body request
	hasher := sha256.New()
	hasher.Write(payload)
	payloadHash := hex.EncodeToString(hasher.Sum(nil))

	// 1. Fase Akuisisi Lock (Atomic)
	record, err := s.store.TryLock(ctx, idempotencyKey, payloadHash)
	if err != nil {
		return "", fmt.Errorf("failed idempotency check: %w", err)
	}

	// 2. Evaluasi Status
	if record != nil {
		if record.Status == "IN_PROGRESS" {
			// Client memanggil lagi terlalu cepat saat worker masih jalan (Double Click)
			return "", ErrConcurrentExecution
		}
		
		if record.Status == "COMPLETED" {
			// Mismatch Payload checking (Cegah Key Re-use jahat)
			if record.PayloadHash != payloadHash {
				return "", ErrConflictIdempotency // HTTP 409 Conflict
			}
			
			// Sukses Idempotent: Kembalikan respon lama 
			return record.CachedRespond, nil
		}
	}

	// 3. Eksekusi Core Logika Bisnis
	// (Jika gagal di tengah ini (misal HTTP Timeout / Server Crash), state di DB
	// tetap IN_PROGRESS, perlu cron atau mekanisme release lock/timeout).
	
	result, bizErr := s.executeDownstreamPayment(payload)
	
	// Jika gagal karena business rules (misal saldo tidak cukup), kita mungkin MENGHAPUS
	// lock atau MENYIMPAN respon error (tergantung kebutuhan produk: apakah retry error diperbolehkan).
	// Untuk simplicity, kita asumsikan simpan sukses.
	if bizErr != nil {
		// Logika pelepasan Lock error handling
		return "", bizErr
	}

	// 4. Rekam hasil permanen
	err = s.store.SaveCompleted(ctx, idempotencyKey, result)
	if err != nil {
		// Peringatan keras: Uang terpotong tapi gagal record idempotency. 
		// Alert DevOps/SRE. Butuh rekonsiliasi.
		fmt.Printf("CRITICAL: Failed to save idempotency key %s: %v", idempotencyKey, err)
	}

	return result, nil
}

func (s *PaymentService) executeDownstreamPayment(payload []byte) (string, error) {
	// Simulasi mutasi DB sungguhan
	time.Sleep(50 * time.Millisecond)
	return `{"status": "success", "tx_id": "ABC"}`, nil
}

// mockIdempotencyStore adalah implementasi in-memory untuk testing.
type mockIdempotencyStore struct {
	records map[string]*IdempotencyRecord
	lockErr error // inject error untuk testing
}

func newMockStore() *mockIdempotencyStore {
	return &mockIdempotencyStore{records: make(map[string]*IdempotencyRecord)}
}

func (m *mockIdempotencyStore) TryLock(ctx context.Context, key, hash string) (*IdempotencyRecord, error) {
	if m.lockErr != nil {
		return nil, m.lockErr
	}
	if rec, exists := m.records[key]; exists {
		return rec, nil // record sudah ada
	}
	// Atomic insert: buat record baru dengan status IN_PROGRESS
	m.records[key] = &IdempotencyRecord{
		Key:         key,
		Status:      "IN_PROGRESS",
		PayloadHash: hash,
	}
	return nil, nil // nil = baru pertama kali
}

func (m *mockIdempotencyStore) SaveCompleted(ctx context.Context, key, responseBody string) error {
	if rec, exists := m.records[key]; exists {
		rec.Status = "COMPLETED"
		rec.CachedRespond = responseBody
	}
	return nil
}

// --- Unit Tests ---

func TestIdempotency_FirstCallSucceeds(t *testing.T) {
	store := newMockStore()
	svc := NewPaymentService(store)

	ctx := context.Background()
	payload := []byte(`{"amount": 100, "currency": "IDR"}`)

	result, err := svc.ProcessPayment(ctx, "idemp-key-001", payload)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if result == "" {
		t.Error("expected non-empty result")
	}

	// Store harus berubah ke COMPLETED
	rec := store.records["idemp-key-001"]
	if rec == nil {
		t.Fatal("record should exist after first call")
	}
	if rec.Status != "COMPLETED" {
		t.Errorf("status = %q, want COMPLETED", rec.Status)
	}
}

func TestIdempotency_SecondCallReturnsCached(t *testing.T) {
	store := newMockStore()
	svc := NewPaymentService(store)
	ctx := context.Background()
	payload := []byte(`{"amount": 100}`)

	// Call 1
	result1, err := svc.ProcessPayment(ctx, "idemp-key-002", payload)
	if err != nil {
		t.Fatalf("call1: %v", err)
	}

	// Call 2 dengan key dan payload yang sama — harus return cached response
	result2, err := svc.ProcessPayment(ctx, "idemp-key-002", payload)
	if err != nil {
		t.Fatalf("call2: %v", err)
	}

	// Kedua result harus identik (cached)
	if result1 != result2 {
		t.Errorf("cached result mismatch: %q != %q", result1, result2)
	}
}

func TestIdempotency_PayloadMismatch409(t *testing.T) {
	store := newMockStore()
	svc := NewPaymentService(store)
	ctx := context.Background()

	// Call 1: payload A dengan key X
	payloadA := []byte(`{"amount": 100}`)
	_, err := svc.ProcessPayment(ctx, "idemp-key-003", payloadA)
	if err != nil {
		t.Fatalf("call1: %v", err)
	}

	// Call 2: payload B (berbeda!) dengan key X — harus 409 Conflict
	payloadB := []byte(`{"amount": 200}`) // amount berbeda!
	_, err = svc.ProcessPayment(ctx, "idemp-key-003", payloadB)
	if !errors.Is(err, ErrConflictIdempotency) {
		t.Errorf("expected ErrConflictIdempotency, got %v", err)
	}
}

func TestIdempotency_ConcurrentExecution(t *testing.T) {
	store := newMockStore()
	svc := NewPaymentService(store)
	ctx := context.Background()
	payload := []byte(`{"amount": 50}`)

	// Simulate: key sudah ada dengan status IN_PROGRESS (sedang diproses worker lain)
	hasher := sha256.New()
	hasher.Write(payload)
	hash := hex.EncodeToString(hasher.Sum(nil))
	store.records["idemp-key-004"] = &IdempotencyRecord{
		Key:         "idemp-key-004",
		Status:      "IN_PROGRESS", // sedang diproses
		PayloadHash: hash,
	}

	_, err := svc.ProcessPayment(ctx, "idemp-key-004", payload)
	if !errors.Is(err, ErrConcurrentExecution) {
		t.Errorf("expected ErrConcurrentExecution, got %v", err)
	}
}

func TestIdempotency_StoreError(t *testing.T) {
	store := newMockStore()
	store.lockErr = errors.New("redis connection refused")
	svc := NewPaymentService(store)

	_, err := svc.ProcessPayment(context.Background(), "idemp-key-005", []byte(`{}`))
	if err == nil {
		t.Error("expected error when store fails")
	}
}

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Hash Data Request sebagai Key
**Mengapa berbahaya:** Anda men-*generate* Idempotency Key otomatis di server dengan melakukan Hash MD5/SHA dari *body request* (misal hash JSON `{amount: 100}`). Jika user memang dengan sengaja menekan tombol beli barang yang sama seharga 100 dua kali beruntun dengan tulus, *hash* request-nya akan identik. Sistem Anda menolaknya secara diam-diam!
Idempotency Key **HARUS** dipasok oleh *Client* secara eksplisit (seperti V4 UUID).

```go
// BAD: Server yang bikin key-nya
key := md5(req.Body) 
CheckIdempotency(key) // Menolak order kedua yang valid!
```
```go
// GOOD: Terima dari klien
key := req.Header.Get("Idempotency-Key")
if key == "" { return error("Header required") }
```

### ❌ Anti-Pattern 2: Lock-and-Check Non-Atomik
**Mengapa berbahaya:** Murni bergantung pada fungsi `SELECT` dan kemudian `INSERT` secara terpisah di PostgreSQL (atau `GET` lalu `SET` di Redis). Dua request HTTP bersamaan dari *double-click* aplikasi HP yang lag akan melewati fungsi `SELECT` (hasil: kosong), kemudian keduanya masuk mengeksekusi logika pembayaran (Double Charge!).

```go
// BAD: Race Condition Celah Lebar
row := db.QueryRow("SELECT status FROM keys WHERE key=X") // 1. Belum ada
// (goroutine context switch)
db.Exec("INSERT INTO keys ...") // 2. Keduanya masuk dan eksekusi
```
```go
// GOOD: SETNX di Redis atau INSERT ON CONFLICT DO NOTHING di PostgreSQL
result, _ := redis.SetNX(ctx, "idemp_key", "IN_PROGRESS", 24*time.Hour).Result()
if !result { /* Sudah terkunci oleh orang lain! */ }
```

### ❌ Anti-Pattern 3: Memberikan Data (Timestamp) Baru Pada Respon Replay
**Mengapa berbahaya:** Tujuan idempotensi adalah ilusi bahwa eksekusi hanya jalan satu kali. Jika Anda mengembalikan JSON yang menampakkan tanggal mutasi yang berbeda (*timestamp server current time*) dari waktu mutasi aslinya, *client/frontend state* akan korup karena memproses penyesuaian waktu yang salah untuk data yang sama. Selalu *cache* mentah JSON response asli beserta header HTTP aslinya, lalu muntahkan (replay) apa adanya.

## Edge Cases & Defensive Programming

1. **Payload Mismatch on Identical Key**: *Client bug* bisa mengirim Payload A dengan Key X (gagal koneksi di jalan), lalu mengirim Payload B dengan Key X lagi. Jika sistem meloloskan Key X langsung (berdasarkan logika Cached), Payload B diabaikan secara magis! Oleh karena itu, kita **wajib menghitung hash dari Payload A** dan membandingkannya di *request* ulangan. Jika beda, tendang dengan HTTP 409 Conflict.
2. **Key Expiry & Pruning**: Idempotency key di tabel SQL akan tumbuh miliaran data per bulan dan merusak peforma DB. *Records* ini harus kadaluarsa dalam periode logis yang wajar untuk *retry window* (umumnya 24 s/d 72 jam). Gunakan TTL di Redis atau mekanisme table partitioning (Hapus drop partisi 3 hari lalu) di PostgreSQL.
3. **Dead In-Progress State**: Jika node worker Go *crash/OOM Killed* tepat setelah menset status `IN_PROGRESS` tapi *sebelum* merubah ke `COMPLETED`, key tersebut selamanya menjadi *zombie* (terkunci tak bernyawa). Selesaikan dengan *soft TTL* di lock-nya: tambahkan cap waktu, bila IN_PROGRESS berlangsung melebihi batas (misal > 2 menit), ijinkan *goroutine* penantang untuk mengambil alih kunci (menganggap *crash* sebelumnya dan aman mengeksekusi ulang secara transaksional).
