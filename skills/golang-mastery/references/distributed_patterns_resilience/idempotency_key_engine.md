# Idempotency Key Engine

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ / Redis 7+ · `redis/go-redis/v9` · **Lihat juga:** `distributed_patterns_resilience/retry_backoff_jitter.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md` · `db_sqlc/acid_transactions_isolation.md` · `microservices_grpc/webhook_delivery_engine.md`

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

## 2. Production-Ready Code (Redis + Lease)

Implementasi yang benar harus menangani *Concurrency* (penguncian atomik), pemulihan dari pemegang lock yang mati (*lease*), dan penyimpanan hasil akhir yang tidak bisa ditimpa pemegang basi.

*Catatan modul:* klien Redis di sini adalah `github.com/redis/go-redis/v9`. `github.com/go-redis/redis/v8` — yang masih sering tersalin dari contoh lama — sudah dipindahkan ke path baru dan tidak lagi dipelihara; ia mendahului Redis 7 yang disyaratkan berkas ini.

```go
package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// State Konstanta
const (
	StateInProgress = "IN_PROGRESS"
	StateCompleted  = "COMPLETED"
)

var (
	ErrConflict    = errors.New("concurrent request is processing this idempotency key")
	ErrKeyMismatch = errors.New("idempotency key dipakai untuk payload berbeda")
	// ErrLockHilang berarti lease kita kedaluwarsa dan pihak lain mengambil
	// alih kunci ini SEMENTARA kita sudah menjalankan efek sampingnya.
	// Ini kondisi yang wajib memicu alert -- lihat catatan fencing di bawah.
	ErrLockLost = errors.New("lock idempotensi hilang sebelum hasil tersimpan")
)

type IdempotencyEngine struct {
	rdb *redis.Client
	// Lease membatasi berapa lama satu proses boleh memegang IN_PROGRESS
	// sebelum proses lain boleh mengambil alih. Ini TERPISAH dari TTL:
	// TTL menjaga memori Redis, lease menjaga klien dari deadlock.
	Lease time.Duration
	TTL   time.Duration
	// Jam disuntikkan agar kedaluwarsa lease bisa diuji tanpa menunggu.
	Jam func() time.Time
}

type IdempotencyRecord struct {
	State        string `json:"state"`
	ResponseCode int    `json:"response_code"`
	ResponseBody []byte `json:"response_body"`
	RequestHash  string `json:"request_hash"` // Untuk mencegah key yang sama dipakai untuk payload berbeda

	// DikunciPadaMs adalah stempel waktu perolehan lock, dalam MILIDETIK Unix.
	//
	// Milidetik, bukan nanodetik, dan itu bukan selera. Skrip Lua di bawah
	// membaca field ini lewat cjson, dan angka di Lua adalah double IEEE-754
	// yang hanya eksak sampai 2^53 (~9e15). Unix NANO hari ini sekitar 1,7e18
	// -- jauh di atas batas itu, sehingga nilainya akan DIBULATKAN diam-diam
	// dan perbandingan lease menjadi tidak bisa dipercaya. Unix milidetik
	// (~1,7e12) aman sampai tahun 287396.
	LockedAtMs int64 `json:"dikunci_pada_ms"`
}

func NewIdempotencyEngine(rdb *redis.Client) *IdempotencyEngine {
	return &IdempotencyEngine{
		rdb:   rdb,
		Lease: 5 * time.Minute,
		TTL:   24 * time.Hour,
		Jam:   time.Now,
	}
}

// skripAmbilAtauBaca menggabungkan SETNX, GET, dan pengambilalihan lease
// kedaluwarsa menjadi SATU operasi atomik.
//
// Dua alasan ini harus berupa skrip Lua, bukan tiga perintah Go berurutan:
//
//  1. SETNX-lalu-GET punya celah: kunci bisa kedaluwarsa di antara keduanya,
//     dan GET mengembalikan redis.Nil untuk kunci yang barusan kita lihat ada.
//  2. Pengambilalihan lease yang basi adalah read-modify-write. Dua pekerja
//     yang sama-sama pulih dari kunci yang sama akan sama-sama membaca
//     "IN_PROGRESS dan sudah basi", lalu sama-sama merasa berhak -- yaitu
//     tepat perlombaan yang seluruh mekanisme ini ada untuk mencegahnya.
//
// Redis menjalankan skrip Lua secara single-threaded sampai selesai, sehingga
// keseluruhan blok ini atomik terhadap klien lain.
var scriptGetOrRead = redis.NewScript(`
local ada = redis.call('GET', KEYS[1])
if not ada then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 'DIPEROLEH'
end
local rec = cjson.decode(ada)
if rec.state == 'IN_PROGRESS' and tonumber(rec.locked_at_ms) < tonumber(ARGV[3]) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 'DIAMBIL_ALIH'
end
return ada
`)

// skripSimpanBilaMasihMilikKita menulis hasil HANYA bila stempel lock di Redis
// masih sama dengan yang kita pegang.
//
// SetXX polos TIDAK cukup, dan cara gagalnya halus: bila lease kita basi lalu
// pekerja lain mengambil alih dan menyelesaikan permintaannya, kunci itu TETAP
// ADA -- sehingga SetXX berhasil dan kita MENIMPA hasil milik pekerja lain
// dengan hasil kita. Dua-duanya sudah menagih kartu, dan yang tersimpan hanya
// satu. Perbandingan stempel di bawah adalah versi minimal dari fencing token.
var scriptSaveIfStillOurs = redis.NewScript(`
local ada = redis.call('GET', KEYS[1])
if not ada then return 'HILANG' end
local rec = cjson.decode(ada)
if tonumber(rec.locked_at_ms) ~= tonumber(ARGV[2]) then return 'HILANG' end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 'OK'
`)

// HashPermintaan menghasilkan RequestHash dari bentuk KANONIK payload.
//
// Jangan hash byte mentah body. Klien yang membentuk ulang JSON-nya saat retry
// -- perilaku normal aplikasi mobile -- bisa menghasilkan urutan field atau
// spasi yang berbeda untuk permintaan yang secara semantik IDENTIK, dan hash
// mentah akan menolaknya sebagai ErrKeyMismatch. Klien lalu melihat 422 untuk
// retry yang benar-benar sah, dan pembayarannya tidak pernah selesai.
//
// json.Marshal atas struct Go selalu mengurutkan field sesuai deklarasi
// (dan kunci map secara terurut), sehingga bentuknya kanonik.
//
// Yang di-hash HARUS hanya field yang mendefinisikan identitas permintaan.
// Sertakan timestamp, nonce, atau request-id di dalamnya dan setiap retry
// menghasilkan hash berbeda -- idempotensinya mati tanpa satu galat pun.
func HashPermintaan(payload any) (string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("mengkanonikkan payload: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// CheckOrLock mencoba mengunci Idempotency Key.
//
// Mengembalikan stempel lock (dikunciPadaMs) yang WAJIB diteruskan ke
// StoreResult. Stempel itulah yang membuktikan lock masih milik kita saat
// hasil ditulis.
func (e *IdempotencyEngine) CheckOrLock(ctx context.Context, key, requestHash string) (
	boleh bool, dikunciPadaMs int64, lama *IdempotencyRecord, err error,
) {
	redisKey := "idempotency:" + key
	sekarangMs := e.Jam().UnixMilli()

	record := IdempotencyRecord{
		State:         StateInProgress,
		RequestHash:   requestHash,
		LockedAtMs: sekarangMs,
	}
	// Galat json.Marshal TIDAK dibuang dengan `_`. Bila ia gagal, recordBytes
	// bernilai nil dan yang tersimpan di Redis adalah nilai kosong -- yang
	// kemudian gagal di-decode pada SETIAP retry berikutnya, mengunci klien
	// dari kuncinya sendiri sampai TTL habis.
	recordBytes, err := json.Marshal(record)
	if err != nil {
		return false, 0, nil, fmt.Errorf("mengkodekan record idempotensi: %w", err)
	}

	// Batas lease: IN_PROGRESS yang dikunci lebih awal dari ini sudah basi.
	batasLeaseMs := sekarangMs - e.Lease.Milliseconds()

	result, err := scriptGetOrRead.Run(ctx, e.rdb,
		[]string{redisKey},
		recordBytes, e.TTL.Milliseconds(), batasLeaseMs,
	).Text()
	if err != nil {
		return false, 0, nil, fmt.Errorf("redis error when locking: %w", err)
	}

	switch result {
	case "DIPEROLEH":
		return true, sekarangMs, nil, nil
	case "DIAMBIL_ALIH":
		// Pemegang sebelumnya mati atau menggantung melewati lease-nya.
		//
		// PENTING: ini TIDAK membuktikan pemegang lama berhenti bekerja. Ia
		// mungkin hanya tertahan GC pause atau partisi jaringan, dan bisa
		// bangun sedetik lagi lalu melanjutkan efek sampingnya. Lease
		// membatasi berapa lama klien MENUNGGU, bukan menjamin eksekusi
		// tunggal. Baca "Batas jujur mekanisme ini" di bawah.
		slog.WarnContext(ctx, "lease idempotensi diambil alih dari pemegang basi",
			"key", key, "lease", e.Lease)
		return true, sekarangMs, nil, nil
	}

	// Selain dua sentinel di atas, `hasil` adalah record JSON yang sudah ada.
	var existing IdempotencyRecord
	if err := json.Unmarshal([]byte(result), &existing); err != nil {
		return false, 0, nil, fmt.Errorf("mendekode record yang ada: %w", err)
	}

	// Validasi Hash (lihat Anti-Pattern 2)
	if existing.RequestHash != requestHash {
		return false, 0, nil, ErrKeyMismatch
	}

	if existing.State == StateInProgress {
		// Masih dalam lease dan masih diproses pihak lain.
		// Handler HTTP-nya WAJIB membalas 409 DISERTAI header Retry-After,
		// bukan 409 telanjang -- tanpa itu klien akan langsung mencoba lagi
		// dan menambah beban pada permintaan yang memang sedang berjalan.
		return false, 0, nil, ErrConflict
	}

	return false, 0, &existing, nil
}

// StoreResult menyimpan hasil eksekusi dari proses domain.
//
// dikunciPadaMs WAJIB berasal dari CheckOrLock pada permintaan yang sama.
func (e *IdempotencyEngine) StoreResult(ctx context.Context, key string, dikunciPadaMs int64, record IdempotencyRecord) error {
	redisKey := "idempotency:" + key

	record.State = StateCompleted
	record.LockedAtMs = dikunciPadaMs
	recordBytes, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("mengkodekan hasil: %w", err)
	}

	result, err := scriptSaveIfStillOurs.Run(ctx, e.rdb,
		[]string{redisKey},
		recordBytes, dikunciPadaMs, e.TTL.Milliseconds(),
	).Text()
	if err != nil {
		return fmt.Errorf("menyimpan hasil: %w", err)
	}
	if result == "HILANG" {
		// Efek samping SUDAH terjadi (kartu sudah ditagih) tetapi lock sudah
		// bukan milik kita. Kemungkinan besar pihak lain juga sudah
		// memprosesnya. Ini kondisi yang butuh manusia, bukan retry.
		return fmt.Errorf("%w: key %s", ErrLockLost, key)
	}
	return nil
}

// CleanupOnFailure dipanggil jika proses domain gagal dengan galat TRANSIENT.
// Ia melepaskan lock agar klien bisa mencoba lagi.
func (e *IdempotencyEngine) CleanupOnFailure(ctx context.Context, key string) {
	// Context TERPISAH. Fungsi ini hampir selalu dipanggil karena sesuatu
	// gagal, dan yang paling sering gagal adalah ctx itu sendiri (timeout).
	// Meneruskan ctx yang sudah mati membuat pelepasan lock gagal seketika --
	// tepat pada saat ia paling dibutuhkan.
	ctx, batal := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer batal()

	// Galat Del TIDAK boleh dibuang. Kegagalan di sini MENYEBABKAN persis
	// deadlock yang dibahas Edge Case 1: lock tertinggal, dan setiap retry
	// klien mendapat ErrConflict sampai lease habis. Ia tidak bisa
	// dikembalikan ke pemanggil (fungsi ini dipanggil dari jalur cleanup),
	// sehingga mencatatnya adalah SATU-SATUNYA jalan keluar informasinya.
	if err := e.rdb.Del(ctx, "idempotency:"+key).Err(); err != nil {
		slog.ErrorContext(ctx, "failed to release idempotency lock; client will be blocked until lease expires",
			"key", key, "lease", e.Lease, "error", err)
	}
}
```

### Batas jujur mekanisme ini

Bagian ini ada karena tanpanya seseorang akan membaca kode di atas dan menyimpulkan bahwa Redis `SETNX` membuat pembayarannya aman. Tidak.

**Lease membatasi berapa lama klien menunggu. Ia tidak menjamin eksekusi tunggal.** Urutan berikut sah dan tidak dilanggar oleh kode mana pun di atas:

```text
t=0    Pekerja A memperoleh lock, mulai menagih kartu
t=1    A tertahan: GC pause panjang / partisi jaringan / VM di-freeze
t=5m   Lease habis
t=5m   Pekerja B mengambil alih lock, menagih kartu (TAGIHAN KEDUA)
t=5m   B menyimpan hasil, membalas klien
t=6m   A bangun, penagihannya SUDAH TERLANJUR sukses di gateway
       A memanggil StoreResult -> stempel tidak cocok -> ErrLockHilang
```

Perbandingan stempel menyelamatkan *data* yang tersimpan — hasil B tidak tertimpa oleh A. Ia **tidak** menyelamatkan uang pelanggan; kartu tetap tertagih dua kali. Tidak ada lock terdistribusi yang bisa mencegah ini, karena tidak ada cara bagi Redis untuk menghentikan proses yang sudah berjalan di mesin lain. Inilah inti kritik Kleppmann terhadap Redlock, dan ia berlaku untuk setiap lock berbasis TTL, bukan hanya Redlock.

**Yang benar-benar menjamin eksekusi tunggal hanya satu hal: penanda idempotensi ditulis DI DALAM transaksi yang sama dengan efek sampingnya.**

```sql
-- Idempotensi yang benar-benar atomik: satu transaksi, satu constraint unik.
BEGIN;
  INSERT INTO idempotency_key (key, request_hash) VALUES ($1, $2);
  -- ^ unique constraint. Percobaan kedua GAGAL DI SINI, sebelum uang bergerak.
  INSERT INTO ledger (account_id, amount_minor) VALUES ($3, $4);
COMMIT;
```

Bila `key` sudah ada, `INSERT` pertama melanggar constraint unik dan **seluruh transaksi rollback** — pergerakan dana tidak pernah terjadi. Tidak ada jendela, tidak ada lease, tidak ada asumsi tentang jam. Bandingkan dengan bagian "Kapan JANGAN Pakai Ini" di bawah, yang memang sudah menyatakan bahwa mencatat kunci di luar transaksi yang mengubah data adalah kesalahan — dan perhatikan bahwa seluruh implementasi Redis di atas melakukan persis itu.

Jadi kapan versi Redis masih layak dipakai?

| Situasi | Pilihan |
| :--- | :--- |
| Efek sampingnya SQL, dan Anda memegang transaksinya | Constraint unik dalam transaksi. Redis tidak diperlukan. |
| Efek sampingnya API pihak ketiga (payment gateway, pengiriman email) | Redis + lease, **ditambah** idempotency key milik penyedia itu sendiri (Stripe, Xendit, dan sejenisnya menerima `Idempotency-Key` — pakai) |
| Efeknya idempoten secara alami (PUT, upsert) | Tidak perlu apa-apa |
| Beban sangat tinggi, efeknya boleh ganda sesekali | Redis + lease sudah memadai; ukur ongkos duplikatnya lebih dulu |

Baris kedua itu yang paling sering ditemui, dan jawabannya berlapis: Redis mencegah *sebagian besar* duplikat dengan murah, sementara idempotency key milik penyedia menutup sisanya di tempat yang benar-benar bisa menegakkannya.

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
**Solusi:** Hash payload dan simpan sebagai `RequestHash` (lihat `HashPermintaan`). Jika *Key* sama tetapi *Hash* berbeda, tolak permintaan (mengindikasikan bug pada klien, HTTP `422`).

**Dua jebakan yang membuat solusi ini justru merusak retry yang sah:**
- **Jangan hash byte mentah body.** Klien yang membentuk ulang JSON-nya saat retry — perilaku normal aplikasi mobile — bisa menghasilkan urutan field atau spasi berbeda untuk permintaan yang secara semantik identik. Hash mentah menolaknya sebagai `ErrKeyMismatch`, klien menerima `422` untuk retry yang benar, dan pembayarannya tidak pernah selesai. Hash bentuk **kanonik**: unmarshal ke struct, lalu `json.Marshal` kembali.
- **Jangan sertakan field yang berubah tiap permintaan.** Timestamp, nonce, atau `X-Request-ID` di dalam payload membuat setiap retry menghasilkan hash berbeda. Idempotensinya mati total, tanpa satu pun galat yang menandainya — permintaan pertama diproses, setiap retry ditolak `422`, dan gejalanya terlihat seperti bug klien.

## 4. Edge Cases Spesifik

1. **Deadlock Karena Pod Mati di Tengah "IN_PROGRESS"**:
   Jika Worker/Pod mati saat sedang memproses *request* (State masih `IN_PROGRESS`), Idempotency Key tersebut akan terkunci selamanya. Jika klien me-*retry*, ia akan selalu mendapat error `ErrConflict`.
   *Penanganan*: Pisahkan **TTL** dari **lease**. TTL (24 jam) menjaga memori Redis; lease (5 menit) menjaga klien dari deadlock. Bila state masih `IN_PROGRESS` melewati lease, proses lain boleh mengambil alih — lihat `Lease`, `DikunciPadaMs`, dan `skripAmbilAtauBaca` pada kode di atas.

   *Yang membuat ini benar dan sering salah:* pengambilalihan lease adalah read-modify-write. Membacanya dengan `GET`, memeriksa umurnya di Go, lalu menulis dengan `SET` berarti dua pekerja yang sama-sama pulih akan sama-sama membaca "basi" dan sama-sama merasa berhak — perlombaan yang persis sama dengan yang dicegah Anti-Pattern 1, hanya berpindah satu lapis. Karena itu seluruh urutannya harus berada dalam satu skrip Lua; Redis menjalankannya single-threaded sampai selesai.

   *Dan yang tidak diselesaikan lease:* mengambil alih lock TIDAK menghentikan pemegang lama. Ia mungkin hanya tertahan GC pause dan akan bangun lalu melanjutkan efek sampingnya. Lihat "Batas jujur mekanisme ini" di atas.

2. **Error Internal (Transient) vs Error Bisnis (Fatal)**:
   Jika proses gagal karena saldo kurang (400 Bad Request), hasil kegagalan ini *seharusnya disave* sebagai hasil idempotensi (`COMPLETED` dengan status HTTP 400). Sehingga *retry* dari klien akan mendapatkan jawaban HTTP 400 yang sama.
   Namun, jika proses gagal karena *Database Timeout* (500 Internal Error), *jangan simpan hasilnya*. Lakukan penghapusan *lock* (panggil fungsi `CleanupOnFailure`), sehingga jika klien *retry* 5 detik kemudian, proses pembayaran benar-benar diulang dari awal.

   *Kedua arah salahnya berbahaya, dan tidak simetris:*
   - Menyimpan galat **transient** sebagai `COMPLETED` adalah yang lebih buruk. Pembayaran ditandai selesai padahal tidak pernah terjadi, dan **klien tidak akan pernah bisa mengulanginya** — setiap retry membalas 500 yang tersimpan, sampai TTL 24 jam habis. Uangnya tidak berpindah dan tidak ada yang menyadarinya.
   - Melepas lock untuk galat **bisnis** hanya membuang tenaga: retry memproses ulang dan mendapat penolakan yang sama.

   Ini bergantung pada klasifikasi transient-vs-permanen yang sama persis dengan `IsTransientError` di `distributed_patterns_resilience/retry_backoff_jitter.md` — pakai satu fungsi yang sama untuk keduanya. Dua klasifikasi terpisah yang perlahan menyimpang adalah cara sistem ini gagal secara diam-diam.

   ```go
   // Bentuk pemakaian di handler.
   boleh, stempel, lama, err := engine.CheckOrLock(ctx, key, hash)
   switch {
   case errors.Is(err, ErrConflict):
       w.Header().Set("Retry-After", "2")   // WAJIB, bukan 409 telanjang
       http.Error(w, "processing", http.StatusConflict)
       return
   case errors.Is(err, ErrKeyMismatch):
       http.Error(w, "key dipakai untuk payload berbeda", http.StatusUnprocessableEntity)
       return
   case err != nil:
       http.Error(w, "internal error", http.StatusInternalServerError)
       return
   case lama != nil:
       balasTersimpan(w, lama)              // replay, tanpa efek samping
       return
   case !boleh:
       return
   }

   result, errProcess := processPayment(ctx)
   if errProcess != nil && IsTransientError(errProcess) {
       engine.CleanupOnFailure(ctx, key)    // biarkan klien mencoba lagi
       http.Error(w, "coba lagi", http.StatusServiceUnavailable)
       return
   }
   // Galat BISNIS ikut disimpan sebagai hasil final.
   if err := engine.StoreResult(ctx, key, stempel, recordFrom(result, errProcess)); err != nil {
       // ErrLockHilang di sini berarti efek samping sudah terjadi tetapi
       // pihak lain memegang kuncinya -- alert, jangan retry.
       slog.ErrorContext(ctx, "menyimpan hasil idempotensi", "key", key, "error", err)
   }
   ```

3. **Storage Exhaustion (Redis OOM)**:
   Mengingat setiap *request* `POST` menyimpan data beserta balasannya di Redis, lalu lintas tinggi dapat menyebabkan RAM Redis penuh.
   *Penanganan*: Selalu aplikasikan TTL yang wajar (misal: 24 atau 48 jam). Asumsinya, klien (aplikasi ponsel) tidak akan me-*retry* permintaan yang sama persis lebih dari jangka waktu 24 jam setelah kejadian awal.

## 5. Unit Tests (Behavioral Testing)

> **Mengapa `miniredis`, bukan `redismock`.**
>
> Rangkaian uji sebelumnya memakai `redismock` dan menskripkan setiap balasan
> Redis (`ExpectSetNX(...).SetVal(true)`). Yang diuji dengan cara itu adalah
> **percabangan Go terhadap balasan yang sudah kita asumsikan sendiri** — ia
> tidak pernah bisa menangkap perintah Redis yang salah, semantik `SETNX` yang
> salah dipahami, atau perlombaan apa pun. Salah satu ujinya bahkan bernama
> `ConcurrentRequests` tanpa memuat satu goroutine pun: dua panggilan berurutan
> dengan balasan yang sudah ditentukan sebelumnya.
>
> Uji itu juga mengasersi **byte JSON persis** dari record yang di-marshal,
> sehingga menambah satu field ke `IdempotencyRecord` merusak ketiganya tanpa
> ada perilaku yang berubah.
>
> `miniredis` menjalankan Redis sungguhan di dalam proses — termasuk `EVAL`,
> `SET PX`, dan kedaluwarsa kunci — sehingga skrip Lua di atas benar-benar
> dieksekusi dan goroutine yang bersaing benar-benar bersaing.

```go
package idempotency

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func mesinUji(t *testing.T) (*IdempotencyEngine, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t) // RunT membersihkan sendiri lewat t.Cleanup
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	e := NewIdempotencyEngine(rdb)
	e.Lease = 5 * time.Minute
	return e, mr
}

// Uji ini benar-benar serentak. Ia gagal bila pengecekan dan penguncian tidak
// atomik -- yaitu Anti-Pattern 1, satu-satunya hal yang paling penting untuk
// dibuktikan berkas ini.
func TestCheckOrLock_HanyaSatuPemenangDariBanyakGoroutine(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()
	const pesaing = 50

	var wg sync.WaitGroup
	var mu sync.Mutex
	var won, conflict int

	for i := 0; i < pesaing; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			boleh, _, _, err := e.CheckOrLock(ctx, "key-balapan", "hash-a")
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil && boleh:
				won++
			case errors.Is(err, ErrConflict):
				conflict++
			case err != nil:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	wg.Wait()

	if won != 1 {
		t.Fatalf("tepat satu goroutine boleh melanjutkan, dapat %d", won)
	}
	if conflict != pesaing-1 {
		t.Errorf("sisanya harus ErrConflict: %d dari %d", conflict, pesaing-1)
	}
}

func TestCheckOrLock_MemutarUlangHasilTersimpan(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()

	boleh, stempel, lama, err := e.CheckOrLock(ctx, "key-completed", "hash-a")
	if err != nil || !boleh || lama != nil {
		t.Fatalf("permintaan pertama harus memperoleh lock: boleh=%v lama=%v err=%v", boleh, lama, err)
	}

	if err := e.StoreResult(ctx, "key-completed", stempel, IdempotencyRecord{
		ResponseCode: 201,
		ResponseBody: []byte(`{"id":1}`),
		RequestHash:  "hash-a",
	}); err != nil {
		t.Fatalf("StoreResult: %v", err)
	}

	boleh, _, lama, err = e.CheckOrLock(ctx, "key-completed", "hash-a")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if boleh {
		t.Error("completed request must not be reprocessed")
	}
	if lama == nil || lama.State != StateCompleted || lama.ResponseCode != 201 {
		t.Fatalf("mengharapkan record COMPLETED, dapat %+v", lama)
	}
	if string(lama.ResponseBody) != `{"id":1}` {
		t.Errorf("body tersimpan = %q", lama.ResponseBody)
	}
}

func TestCheckOrLock_HashBerbedaDitolak(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()

	if _, _, _, err := e.CheckOrLock(ctx, "key-beda", "hash-lama"); err != nil {
		t.Fatalf("pengambilan pertama: %v", err)
	}
	_, _, _, err := e.CheckOrLock(ctx, "key-beda", "hash-baru")
	if !errors.Is(err, ErrKeyMismatch) {
		t.Fatalf("mengharapkan ErrKeyMismatch, dapat %v", err)
	}
}

// Inilah uji untuk Edge Case 1: pemegang lock mati, lease habis, klien harus
// bisa maju lagi. Tanpa lease, assersi terakhir mendapat ErrConflict selama
// 24 jam penuh.
func TestCheckOrLock_LeaseBasiBisaDiambilAlih(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()
	sekarang := time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)
	e.Jam = func() time.Time { return sekarang }

	if boleh, _, _, err := e.CheckOrLock(ctx, "key-mati", "hash-a"); err != nil || !boleh {
		t.Fatalf("pengambilan pertama: boleh=%v err=%v", boleh, err)
	}
	// Pemegangnya "mati" di sini -- tidak pernah memanggil StoreResult.

	// Masih di dalam lease: klien wajib tertahan.
	sekarang = sekarang.Add(2 * time.Minute)
	if _, _, _, err := e.CheckOrLock(ctx, "key-mati", "hash-a"); !errors.Is(err, ErrConflict) {
		t.Fatalf("di dalam lease harus ErrConflict, dapat %v", err)
	}

	// Lease habis: pemulihan diizinkan.
	sekarang = sekarang.Add(4 * time.Minute)
	boleh, _, _, err := e.CheckOrLock(ctx, "key-mati", "hash-a")
	if err != nil {
		t.Fatalf("setelah lease habis: %v", err)
	}
	if !boleh {
		t.Fatal("lock basi harus bisa diambil alih; tanpa ini klien terkunci sampai TTL")
	}
}

// Skenario fencing: pemegang lama bangun setelah lock diambil alih dan mencoba
// menulis hasilnya. Tanpa perbandingan stempel, SetXX polos akan BERHASIL dan
// menimpa hasil pemegang baru.
func TestStoreResult_PemegangBasiTidakBisaMenimpa(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()
	sekarang := time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)
	e.Jam = func() time.Time { return sekarang }

	_, stampA, _, err := e.CheckOrLock(ctx, "key-fencing", "hash-a")
	if err != nil {
		t.Fatalf("A mengambil lock: %v", err)
	}

	sekarang = sekarang.Add(6 * time.Minute) // lease A habis
	_, stampB, _, err := e.CheckOrLock(ctx, "key-fencing", "hash-a")
	if err != nil {
		t.Fatalf("B mengambil alih: %v", err)
	}
	if err := e.StoreResult(ctx, "key-fencing", stampB, IdempotencyRecord{
		ResponseCode: 201, RequestHash: "hash-a",
	}); err != nil {
		t.Fatalf("B menyimpan hasil: %v", err)
	}

	// A bangun terlambat dan mencoba menulis hasilnya sendiri.
	err = e.StoreResult(ctx, "key-fencing", stampA, IdempotencyRecord{
		ResponseCode: 500, RequestHash: "hash-a",
	})
	if !errors.Is(err, ErrLockLost) {
		t.Fatalf("penulisan pemegang basi harus ErrLockHilang, dapat %v", err)
	}

	// Hasil milik B wajib utuh.
	_, _, lama, err := e.CheckOrLock(ctx, "key-fencing", "hash-a")
	if err != nil {
		t.Fatalf("pembacaan akhir: %v", err)
	}
	if lama == nil || lama.ResponseCode != 201 {
		t.Fatalf("hasil B tertimpa oleh pemegang basi: %+v", lama)
	}
}

func TestCleanupOnFailure_MembebaskanKlien(t *testing.T) {
	e, _ := mesinUji(t)
	ctx := context.Background()

	if _, _, _, err := e.CheckOrLock(ctx, "key-transient", "hash-a"); err != nil {
		t.Fatalf("pengambilan: %v", err)
	}
	e.CleanupOnFailure(ctx, "key-transient")

	boleh, _, _, err := e.CheckOrLock(ctx, "key-transient", "hash-a")
	if err != nil || !boleh {
		t.Fatalf("after cleanup, retry should be able to reprocess: allowed=%v err=%v", boleh, err)
	}
}

// Hash kanonik: urutan field yang berbeda pada JSON mentah TIDAK boleh
// menghasilkan hash berbeda, atau retry yang sah akan ditolak 422.
func TestHashPermintaan_Kanonik(t *testing.T) {
	type pay struct {
		AkunID      string `json:"akun_id"`
		JumlahMinor int64  `json:"jumlah_minor"`
	}
	a, err := HashPermintaan(pay{AkunID: "acc-1", JumlahMinor: 50000})
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPermintaan(pay{JumlahMinor: 50000, AkunID: "acc-1"})
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Error("payload identik menghasilkan hash berbeda; retry sah akan ditolak")
	}

	c, err := HashPermintaan(pay{AkunID: "acc-1", JumlahMinor: 50001})
	if err != nil {
		t.Fatal(err)
	}
	if a == c {
		t.Error("payload berbeda menghasilkan hash sama; ini menggabungkan dua transaksi")
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
