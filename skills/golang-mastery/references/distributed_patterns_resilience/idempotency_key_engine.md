# Idempotency Key Engine

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ / Redis 7+ · **Lihat juga:** `distributed_patterns_resilience/retry_backoff_jitter.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md` · `db_sqlc/acid_transactions_isolation.md` · `microservices_grpc/webhook_delivery_engine.md`

## 1. Konsep & Internal

Dalam sistem terdistribusi, komunikasi jaringan sering kali mengalami kegagalan *transient* (misal: *timeout*, koneksi terputus). Ketika sebuah klien (seperti aplikasi *mobile* atau *microservice* lain) gagal menerima respons, ia sering kali melakukan *retry* (coba ulang).

Jika operasi bersifat *Read* (GET), hal ini aman (idempoten secara alami). Namun, jika operasi bersifat *Write* (POST pembayaran, pembuatan *order*), *retry* dapat menyebabkan data duplikat (misal pengguna ditagih 2 kali).

**Idempotency Key** memecahkan masalah ini. Klien menghasilkan sebuah ID unik (biasanya UUID) dan mengirimkannya dalam HTTP Header (misal: `Idempotency-Key: <UUID>`). Server menggunakan kunci ini untuk menjamin bahwa permintaan yang sama (dengan kunci yang sama) hanya diproses **satu kali**, dan permintaan berikutnya yang menggunakan kunci yang sama akan langsung mengembalikan hasil dari percobaan pertama (tanpa memproses ulang *side effect*).

### Diagram Alir (ASCII)

```ascii
[ Client ]                          [ API Server ]                        [ Redis / DB ]
    |                                     |                                     |
    | POST /charge (Key: XYZ)             |                                     |
    |------------------------------------>|                                     |
    |                                     | 1. SETNX "idemp:XYZ" "IN_PROGRESS"  |
    |                                     |------------------------------------>|
    |                                     | <--- OK (Lock Acquired)             |
    |                                     |                                     |
    |                                     | 2. Proses Bisnis (Charge Card)      |
    |                                     |    (Memakan waktu 2 detik)          |
    | (Client Timeout setelah 1 detik!)   |                                     |
    x                                     |                                     |
    |                                     | 3. Simpan Hasil (Status 200, Data)  |
    |                                     |------------------------------------>|
    |                                     | <--- OK (Update to "COMPLETED")     |
    |                                     |                                     |
    |                                     |                                     |
    | Client Retry:                       |                                     |
    | POST /charge (Key: XYZ)             |                                     |
    |------------------------------------>|                                     |
    |                                     | 4. GET "idemp:XYZ"                  |
    |                                     |------------------------------------>|
    |                                     | <--- "COMPLETED", {Status 200}      |
    |                                     |                                     |
    | <--- Balas dengan Hasil Tersimpan   |                                     |
    |      (Tanpa memproses ulang!)       |                                     |
```

## 2. Production-Ready Code (Redis + Redis-lock)

Implementasi yang benar harus menangani *Concurrency* (menggunakan *Distributed Lock*) dan penyimpanan hasil akhir. 

```go
package idempotency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-redis/redis/v8"
)

// State Konstanta
const (
	StateInProgress = "IN_PROGRESS"
	StateCompleted  = "COMPLETED"
)

var (
	ErrConflict     = errors.New("concurrent request is currently processing this idempotency key")
	ErrKeyMismatch  = errors.New("idempotency key used with different payload")
)

type IdempotencyEngine struct {
	rdb *redis.Client
}

type IdempotencyRecord struct {
	State        string `json:"state"`
	ResponseCode int    `json:"response_code"`
	ResponseBody []byte `json:"response_body"`
	RequestHash  string `json:"request_hash"` // Untuk mencegah key yang sama dipakai untuk payload berbeda
}

func NewIdempotencyEngine(rdb *redis.Client) *IdempotencyEngine {
	return &IdempotencyEngine{rdb: rdb}
}

// CheckOrLock mencoba mengunci Idempotency Key. 
// Mengembalikan bool (true = lock berhasil, proses bisa lanjut)
// Mengembalikan data hasil lama (jika sudah COMPLETED)
func (e *IdempotencyEngine) CheckOrLock(ctx context.Context, key string, requestHash string) (bool, *IdempotencyRecord, error) {
	redisKey := fmt.Sprintf("idempotency:%s", key)
	
	// 1. Inisiasi Transaksi / Pengecekan
	// Gunakan SETNX (Set if Not eXists) untuk menjamin atomic lock
	record := IdempotencyRecord{
		State:       StateInProgress,
		RequestHash: requestHash,
	}
	recordBytes, _ := json.Marshal(record)
	
	// Set dengan TTL (misal 24 jam) agar memory Redis tidak penuh
	acquired, err := e.rdb.SetNX(ctx, redisKey, recordBytes, 24*time.Hour).Result()
	if err != nil {
		return false, nil, fmt.Errorf("redis error during lock: %w", err)
	}

	if acquired {
		// Kunci pertama kali dikirim, dan kita berhasil mengunci "IN_PROGRESS".
		// Lanjutkan eksekusi domain logika.
		return true, nil, nil
	}

	// 2. Kunci SUDAH ADA. Mari kita periksa statusnya.
	existingStr, err := e.rdb.Get(ctx, redisKey).Result()
	if err != nil {
		return false, nil, fmt.Errorf("failed to fetch existing key: %w", err)
	}

	var existingRecord IdempotencyRecord
	if err := json.Unmarshal([]byte(existingStr), &existingRecord); err != nil {
		return false, nil, fmt.Errorf("failed to decode existing record: %w", err)
	}

	// 3. Validasi Hash (lihat Anti-Pattern)
	if existingRecord.RequestHash != requestHash {
		return false, nil, ErrKeyMismatch
	}

	// 4. Periksa State
	if existingRecord.State == StateInProgress {
		// Klien memanggil ulang padahal request pertama masih diproses oleh worker lain
		return false, nil, ErrConflict
	}

	// Berarti StateCompleted. Kembalikan data yang tersimpan agar dikirim ulang ke klien.
	return false, &existingRecord, nil
}

// StoreResult menyimpan hasil eksekusi sukses dari proses domain.
func (e *IdempotencyEngine) StoreResult(ctx context.Context, key string, record IdempotencyRecord) error {
	redisKey := fmt.Sprintf("idempotency:%s", key)
	
	record.State = StateCompleted
	recordBytes, _ := json.Marshal(record)

	// Timpa (Update) value dari IN_PROGRESS menjadi COMPLETED
	// Gunakan SET untuk menimpa, pertahankan sisa TTL dengan KeepTTL
	err := e.rdb.SetXX(ctx, redisKey, recordBytes, redis.KeepTTL).Err()
	if err != nil {
		return fmt.Errorf("failed to store result: %w", err)
	}

	return nil
}

// CleanupOnFailure dipanggil jika proses domain gagal dengan error yang BISA di-retry (transient).
// Hal ini melepaskan lock agar klien bisa mencoba lagi.
func (e *IdempotencyEngine) CleanupOnFailure(ctx context.Context, key string) {
	redisKey := fmt.Sprintf("idempotency:%s", key)
	e.rdb.Del(ctx, redisKey) // Abaikan error dalam konteks defer/cleanup
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Check-Then-Act Secara Non-Atomik
**Masalah**: Service mengecek database apakah kunci ada, jika tidak, memproses data, lalu menyimpannya.
```go
// BAD: Race Condition
exists := db.CheckIdempotencyKey(key) 
if !exists {
    processPayment() // Memakan waktu 2 detik
    db.SaveIdempotencyKey(key)
}
```
**Why dangerous:** Jika dua permintaan HTTP yang identik (*retry* dari klien) tiba pada milidetik yang sama (*Race Condition*), *KEDUA* goroutine akan membaca `exists == false`. Keduanya akan menjalankan `processPayment()`, yang mengakibatkan *double charge* pada pengguna.
**Solusi:** Operasi pengecekan dan penguncian (Locking) **WAJIB** berjalan secara *Atomic* (misalnya dengan Redis `SETNX`, Postgres `INSERT ... ON CONFLICT DO NOTHING`, atau *Distributed Lock* bawaan).

### ❌ Anti-Pattern 2: Mengabaikan Payload Validasi
**Masalah**: Hanya memeriksa kuncinya saja, mengasumsikan kuncinya pasti merepresentasikan *request body* yang sama persis.
```go
// BAD: 
if exists := checkLock(req.Header("Idempotency-Key")); exists { ... }
```
**Why dangerous:** Bug di aplikasi klien dapat mengirimkan Idempotency Key yang *sama* (karena di-cache tidak sengaja) untuk dua transaksi pembayaran yang *berbeda* nilainya (misal Pembayaran A $10, Pembayaran B $500). Sistem akan merespons Pembayaran B dengan nilai sukses dari Pembayaran A.
**Solusi:** Hash seluruh payload (misal SHA-256) dan simpan sebagai `RequestHash` (lihat kode `CheckOrLock`). Jika *Key* sama tetapi *Hash* berbeda, tolak permintaan (mengindikasikan bug pada klien, HTTP `422` atau `409`).

## 4. Edge Cases Spesifik

1. **Deadlock Karena Pod Mati di Tengah "IN_PROGRESS"**:
   Jika Worker/Pod mati saat sedang memproses *request* (State masih `IN_PROGRESS`), Idempotency Key tersebut akan terkunci selamanya. Jika klien me-*retry*, ia akan selalu mendapat error `ErrConflict`.
   *Penanganan*: Saat melakukan `SETNX`, jangan hanya set TTL *overall* (misal 24 jam), namun tambahkan mekanisme *Lease/Lock Expiration* singkat (misal 5 menit). Jika setelah 5 menit state masih `IN_PROGRESS`, sistem mengizinkan proses *override* (menimpa *lock*).

2. **Error Internal (Transient) vs Error Bisnis (Fatal)**:
   Jika proses gagal karena saldo kurang (400 Bad Request), hasil kegagalan ini *seharusnya disave* sebagai hasil idempotensi (`COMPLETED` dengan status HTTP 400). Sehingga *retry* dari klien akan mendapatkan jawaban HTTP 400 yang sama.
   Namun, jika proses gagal karena *Database Timeout* (500 Internal Error), *jangan simpan hasilnya*. Lakukan penghapusan *lock* (panggil fungsi `CleanupOnFailure`), sehingga jika klien *retry* 5 detik kemudian, proses pembayaran benar-benar diulang dari awal.

3. **Storage Exhaustion (Redis OOM)**:
   Mengingat setiap *request* `POST` menyimpan data beserta balasannya di Redis, lalu lintas tinggi dapat menyebabkan RAM Redis penuh.
   *Penanganan*: Selalu aplikasikan TTL yang wajar (misal: 24 atau 48 jam). Asumsinya, klien (aplikasi ponsel) tidak akan me-*retry* permintaan yang sama persis lebih dari jangka waktu 24 jam setelah kejadian awal.

## 5. Unit Tests (Behavioral Testing)

```go
package idempotency

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/go-redis/redismock/v8"
)

func TestIdempotencyEngine_ConcurrentRequests(t *testing.T) {
	db, mock := redismock.NewClientMock()
	engine := NewIdempotencyEngine(db)
	ctx := context.Background()
	key := "req-123"
	hash := "sha256-abc"

	// Mock perilaku Redis untuk request PERTAMA (Berhasil dapat Lock)
	mock.ExpectSetNX("idempotency:"+key, []byte(`{"state":"IN_PROGRESS","response_code":0,"response_body":null,"request_hash":"sha256-abc"}`), 24*time.Hour).SetVal(true)

	// Skenario 1: Request Pertama (Lock Berhasil)
	canProceed, record, err := engine.CheckOrLock(ctx, key, hash)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if !canProceed || record != nil {
		t.Fatalf("First request should proceed and have no existing record")
	}

	// Mock perilaku Redis untuk request KEDUA (Gagal dapat Lock)
	mock.ExpectSetNX("idempotency:"+key, []byte(`{"state":"IN_PROGRESS","response_code":0,"response_body":null,"request_hash":"sha256-abc"}`), 24*time.Hour).SetVal(false)
	
	// Server membalas dengan state yang ada di Redis
	mock.ExpectGet("idempotency:"+key).SetVal(`{"state":"IN_PROGRESS","response_code":0,"response_body":null,"request_hash":"sha256-abc"}`)

	// Skenario 2: Request Kedua mencoba mengakses key yang sama persis
	canProceed, record, err = engine.CheckOrLock(ctx, key, hash)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("Expected ErrConflict, got: %v", err)
	}
	if canProceed {
		t.Fatalf("Second request should NOT proceed")
	}
}

func TestIdempotencyEngine_CompletedRequest(t *testing.T) {
	db, mock := redismock.NewClientMock()
	engine := NewIdempotencyEngine(db)
	ctx := context.Background()
	key := "req-completed"
	hash := "sha256-abc"

	mock.ExpectSetNX("idempotency:"+key, []byte(`{"state":"IN_PROGRESS","response_code":0,"response_body":null,"request_hash":"sha256-abc"}`), 24*time.Hour).SetVal(false)
	
	// Mock respons sukses yang sudah tersimpan
	mock.ExpectGet("idempotency:"+key).SetVal(`{"state":"COMPLETED","response_code":201,"response_body":"e2lkOjF9","request_hash":"sha256-abc"}`)

	canProceed, record, err := engine.CheckOrLock(ctx, key, hash)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if canProceed {
		t.Fatalf("Request should not proceed (already completed)")
	}
	
	if record == nil || record.State != StateCompleted || record.ResponseCode != 201 {
		t.Fatalf("Expected valid completed record, got: %+v", record)
	}
}

func TestIdempotencyEngine_KeyMismatch(t *testing.T) {
	db, mock := redismock.NewClientMock()
	engine := NewIdempotencyEngine(db)
	ctx := context.Background()
	key := "req-mismatch"

	mock.ExpectSetNX("idempotency:"+key, []byte(`{"state":"IN_PROGRESS","response_code":0,"response_body":null,"request_hash":"hash-baru"}`), 24*time.Hour).SetVal(false)
	mock.ExpectGet("idempotency:"+key).SetVal(`{"state":"COMPLETED","response_code":200,"response_body":null,"request_hash":"hash-lama"}`)

	canProceed, _, err := engine.CheckOrLock(ctx, key, "hash-baru")
	if !errors.Is(err, ErrKeyMismatch) {
		t.Fatalf("Expected ErrKeyMismatch, got: %v", err)
	}
	if canProceed {
		t.Fatalf("Should not proceed")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Kunci yang dibuat server.** Kunci WAJIB berasal dari klien dan bertahan lintas percobaan. Kunci yang dibuat server berubah pada setiap permintaan dan karena itu tidak menyaring apa pun.
- **Menyimpan hasil tanpa masa berlaku.** Tabelnya tumbuh selamanya dan pencariannya melambat. Tetapkan retensi yang lebih panjang daripada jendela retry klien, lalu bersihkan terjadwal.
- **Idempotensi berbasis hash body.** Dua permintaan yang sah dan kebetulan identik — misalnya dua transfer Rp50.000 berturut-turut — akan digabung menjadi satu. Itu bukan deduplikasi, itu kehilangan transaksi.
- **Mencatat kunci di luar transaksi yang mengubah data.** Bila keduanya tidak atomik, ada celah di mana operasinya sudah terjadi tetapi kuncinya belum tercatat — dan percobaan berikutnya mengulanginya.
- **Sebagai pengganti penguncian.** Idempotensi menjamin "tidak dua kali", bukan "tidak bersamaan". Dua permintaan serentak dengan kunci sama tetap membutuhkan constraint unik atau penguncian baris.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Efek ganda meski idempotensi terpasang | apakah kunci dicatat dalam transaksi yang sama | Ada celah antara eksekusi dan pencatatan kunci |
| Tabel kunci membengkak | umur baris tertua | Tidak ada pembersihan |
| Banyak baris berstatus "sedang diproses" | umur baris tersebut | Proses mati di tengah; butuh pemulihan otomatis |
| Permintaan sah ditolak sebagai duplikat | dasar penentuan duplikat | Deduplikasi berbasis isi, bukan kunci klien |
| `409` melonjak saat klien melakukan retry | perilaku klien | Kunci tidak dipertahankan lintas percobaan |

```sql
-- Pertumbuhan dan umur: kalau baris tertua berumur bulanan, pembersihan tidak jalan
SELECT count(*) AS jumlah, min(dibuat_pada) AS tertua,
       pg_size_pretty(pg_total_relation_size('idempotency_key')) AS ukuran
FROM idempotency_key;

-- Baris yang tersangkut: proses mati sebelum menyelesaikan operasi
SELECT status, count(*) FROM idempotency_key GROUP BY 1;
SELECT * FROM idempotency_key
WHERE status = 'diproses' AND dibuat_pada < now() - interval '10 minutes' LIMIT 20;
```

```bash
curl -s localhost:9090/metrics | grep -E 'idempotency_(hit|miss|conflict)_total'
```
