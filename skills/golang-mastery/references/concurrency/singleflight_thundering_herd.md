# Singleflight & Cache Stampede Prevention

> **Berlaku:** Go 1.21+ · `golang.org/x/sync/singleflight` · **Lihat juga:** `caching_strategy/cache_aside_singleflight.md` · `caching_strategy/multilevel_cache_l1l2.md` · `distributed_patterns_resilience/retry_backoff_jitter.md` · `observability_resilience/circuit_breaker_hystrix.md`

## Konsep Utama
Paket `golang.org/x/sync/singleflight` digunakan untuk memecahkan sebuah masalah arsitektural klasik yang mematikan dalam sistem berskala terdistribusi (high concurrency): **Thundering Herd** (Kawanan Bergemuruh) atau sering juga dikenal dengan **Cache Stampede / Dogpile Effect**.

**Problem (Cache Stampede)**: Misalkan Anda memiliki arsitektur Microservices dengan Redis sebagai layer Cache di depan Database PostgreSQL. Sebuah data populer (seperti profil "Justin Bieber") kedaluwarsa (TTL expired) di Redis. Dalam 50 milidetik berikutnya, ada 1.000 HTTP request serentak meminta profil tersebut. Semua akan mengalami *cache-miss*. Tanpa proteksi tambahan, ke-1.000 request ini akan secara berbarengan (bersamaan) memukul PostgreSQL dengan Query yang sama persis (`SELECT * FROM users WHERE id='jb'`). PostgreSQL Anda seketika akan lumpuh (Connection Pool exhausted, CPU 100%, Crash).

**Solusi (Singleflight)**: Menggabungkan (multiplexing) panggilan identik yang *sedang* terjadi atau *in-flight* (sedang terbang). Jika Goroutine 1 memanggil `Group.Do("user_jb")` dan sedang menunggu respons dari DB, maka Goroutine ke-2, ke-3, hingga ke-1.000 yang datang terlambat (namun memanggil dengan *key* yang sama `"user_jb"`) **tidak akan dibiarkan menembak DB**. Mereka akan **di-block** dalam antrian lokal. Begitu Goroutine 1 selesai Query DB, *Singleflight* menangkap hasilnya dan akan membagikan (*broadcast*) *satu hasil yang sama itu* ke Goroutine 2-1000 secara instan di memori RAM. Hasilnya? Hanya ada **1 panggilan fisik ke Database**, namun 1000 client mendapat HTTP Response 200 OK.

Fitur Kunci Paket ini:
1. **`Group.Do(key, fn)`**: Eksekusi sinkronus. Caller terblokir (blocked) menunggu hingga fungsi `fn` selesai.
2. **`Group.DoChan(key, fn)`**: Eksekusi asinkronus yang mengembalikan `<-chan Result`. Sangat krusial dalam production jika caller ingin merangkainya dengan batas *Context Timeout* (misal: jika DB lambat, caller bisa nyerah duluan dengan `select ctx.Done()`).
3. **`Group.Forget(key)`**: Melupakan suatu key secara prematur *sebelum* fungsi tuntas. Ini berguna pada skema failover, di mana jika API ke-1 gagal parsial, kita ingin pendaftar baru tidak menelan error yang sama dan dibiarkan melalukan *retry* ke backend.

## Diagram ASCII

```text
    Tanpa Singleflight (Thundering Herd)         Dengan Singleflight (Multiplexing)
    
Req 1 (Miss) -> [ Query DB  ]                  Req 1 (Miss) -> [  Query DB  ]
Req 2 (Miss) -> [ Query DB  ] -> DB CRASH      Req 2 (Miss) -> [ Waits Req1 ]
Req 3 (Miss) -> [ Query DB  ]                  Req 3 (Miss) -> [ Waits Req1 ]
Req 4 (Miss) -> [ Query DB  ]                  Req 4 (Miss) -> [ Waits Req1 ]
                                                                       |
                                                                       v
                                                               [ DB responds! ]
                                                               (Shared to 1,2,3,4)
```

## Kode Go Production-Ready

Di bawah ini adalah implementasi pola *Singleflight* yang tangguh (robust), di mana kita menggunakan `DoChan` agar caller tetap bisa menghormati (respect) batas waktu `context.Context` meskipun sedang disandera (blocked) oleh singleflight group menunggu caller pertama.

```go
package concurrency

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"
	"golang.org/x/sync/singleflight"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// UserRepository melayani pencarian user dengan mitigasi singleflight 
// di atas layer database dan memori.
type UserRepository struct {
	sgGroup     singleflight.Group
	dbCallCount atomic.Int32 // Diagnostik: Menghitung berapa kali DB fisik dipanggil
}

func NewUserRepository() *UserRepository {
	return &UserRepository{}
}

// GetUserProfile mensimulasikan pembacaan DB dengan proteksi singleflight.
// Fungsi ini aman dipanggil oleh 10.000 goroutine berbarengan untuk userID yang sama.
func (r *UserRepository) GetUserProfile(ctx context.Context, userID string) (string, error) {
	// Key identifikasi wajib unik per sumber daya (resource)
	key := fmt.Sprintf("user_profile_query_%s", userID)

	// PRINSIP PRODUCTION: Gunakan DoChan, BUKAN Do() biasa.
	// Mengapa? Jika pemanggil pertama (yang mengeksekusi anon func ini) 
	// ternyata memiliki Context yang dibatalkan paksa (user close browser), 
	// kita tidak ingin pemanggil ke-2 hingga ke-100 (yang masih punya waktu sisa) 
	// ikut mati/stuck.
	resultCh := r.sgGroup.DoChan(key, func() (interface{}, error) {
		
		// == BEGIN SIMULATED DATABASE CALL ==
		// Ini mewakili Query SQL `SELECT * FROM ...`
		r.dbCallCount.Add(1)
		
		// Catatan: Jika DB call ini meng-support context, JANGAN gunakan `ctx` dari 
		// argumen method di atas (karena itu spesifik milik Caller pertama).
		// Anda harus menggunakan `context.Background()` dengan Timeout sistem.
		time.Sleep(100 * time.Millisecond) // Heavy I/O processing
		
		// == END SIMULATED DATABASE CALL ==
		
		return fmt.Sprintf("Profile_Data_For_%s", userID), nil
	})

	// Event Loop Evaluasi
	select {
	case <-ctx.Done():
		// Skenario: Client HTTP spesifik ini timeout (misal Nginx me-reject koneksi).
		// Pemanggil ini menyerah, return error.
		// NAMUN: Goroutine yang menjalankan Heavy I/O DB di atas akan TETAP BERJALAN 
		// di background agar caller lain yang tidak timeout tetap bisa menikmati 
		// hasilnya begitu query selesai.
		return "", fmt.Errorf("user context aborted: %w", ctx.Err())
		
	case res := <-resultCh:
		// Skenario: DB Query (entah oleh pemanggil ini atau orang lain) telah selesai
		if res.Err != nil {
			return "", fmt.Errorf("underlying db error: %w", res.Err)
		}
		
		// res.Shared bernilai TRUE jika ada lebih dari 1 goroutine yang mengantri
		// dan akhirnya menerima hasil yang sama ini.
		return res.Val.(string), nil
	}
}

// ==========================================
// UNIT TEST (-race compatible)
// ==========================================

func TestSingleflightStampede(t *testing.T) {
	defer goleak.VerifyNone(t)
	
	repo := NewUserRepository()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	concurrency := 500
	
	// Buffered channel penampung hasil agar tidak block worker
	resultsCh := make(chan string, concurrency)
	errCh := make(chan error, concurrency)

	// Luncurkan 500 goroutine serentak bagai Thundering Herd!
	for i := 0; i < concurrency; i++ {
		go func() {
			val, err := repo.GetUserProfile(ctx, "user-kritis-99")
			if err != nil {
				errCh <- err
				return
			}
			resultsCh <- val
		}()
	}

	// Kumpulkan hasil
	successCount := 0
	for i := 0; i < concurrency; i++ {
		select {
		case val := <-resultsCh:
			if val != "Profile_Data_For_user-kritis-99" {
				t.Fatalf("unexpected output data: %v", val)
			}
			successCount++
		case err := <-errCh:
			t.Fatalf("unexpected error from worker: %v", err)
		}
	}

	if successCount != 500 {
		t.Fatalf("expected 500 successes, got %d", successCount)
	}

	// VERIFIKASI UTAMA (The Magic of Singleflight): 
	// Pastikan dari 500 concurrent request, Database HANYA ditembak fisik 1 kali!
	calls := repo.dbCallCount.Load()
	if calls != 1 {
		t.Errorf("Thundering herd bypass! Expected exactly 1 DB call, got %d", calls)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan `Group.Do` (Blokir Sinkronus Penuh)

```go
// ❌ BAD: Memakai Do() mengikat nasib Anda pada goroutine lain
func getCachedDataBad(ctx context.Context, key string) (string, error) {
    // BAD: Caller akan di-block (stuck) di sini 100%. 
    // Jika panggilan DB di dalam `Do` mendadak hang selamanya, 
    // `select ctx.Done()` milik caller ini TIDAK BISA tereksekusi.
    // Client akan menunggu selamanya, file descriptor OS menipis.
    res, err, _ := sgGroup.Do(key, func() (interface{}, error) {
        return fragileDBCall() // misal Network Timeout tak terbatas
    })
    return res.(string), err
}

// ✅ GOOD: Menggunakan DoChan agar caller dapat "Walk-away" (menyerah via Timeout)
func getCachedDataGood(ctx context.Context, key string) (string, error) {
    ch := sgGroup.DoChan(key, func() (interface{}, error) { return fragileDBCall() })
    select {
    case <-ctx.Done(): // GOOD: Caller bisa menyerah kapan saja!
        return "", ctx.Err()
    case res := <-ch:
        return res.Val.(string), res.Err
    }
}
```

**Why dangerous:** Ini adalah kelemahan arsitektur fatal. `sgGroup.Do()` itu sinkronus *blocking*. Ia tidak menerima `context`. Jika fungsi *anonymous* (closure) di dalamnya tersangkut karena router jaringan putus tanpa TCP Reset, goroutine Anda akan *freeze* selamanya (Goroutine Leak absolut). Semua permintaan web baru dari user yang memanggil *endpoint* yang sama juga akan terseret menjadi korban *freeze* ini. Menggunakan `DoChan` dipasangkan dengan timer `context` adalah benteng pertahanan utama layanan mikro Anda.

### ❌ Anti-Pattern 2: Membagikan Error Transient (Basi) ke Peserta Baru

```go
// ❌ BAD: Membagikan Network Error ke ratusan client tak berdosa
ch := sgGroup.DoChan(key, func() (interface{}, error) {
    // Skenario: DB kebetulan di-restart. Transient error muncul.
    return nil, errDBConnDropped 
})
// BAD: Semua dari ke-100 goroutine yang kebetulan antri di `key` yang sama 
// akan menerima error ini. Jika request ke-101 datang 2 detik kemudian, 
// ia harus memulai ulang dari 0.
```

**Why dangerous:** Pada Singleflight, **Error juga ikut dibagikan (shared)**. Jika goroutine eksekutor pertama gagal karena alasan non-permanen (misal: "Connection Reset by Peer" saat TCP Handshake), Singleflight akan mendistribusikan pesan kegagalan tersebut ke ratusan goroutine pendaftar lainnya. Mereka semua mendapat Response 500. Padahal, seandainya pendaftar lain mencoba hit DB 10 milidetik kemudian, mungkin TCP-nya sudah normal.

## Edge Cases

1. **Context Cancellation vs Ghost Query Singleflight**: Saat Anda memakai kombinasi `DoChan` dengan `<-ctx.Done()` (contoh di Good Pattern), jika *caller* 1 membatalkan konteks karena `timeout`, ia sukses exit. NAMUN fungsi *closure* `fragileDBCall()` di dalam `DoChan` **tetap berjalan merayap di background**. Goroutine tersebut tidak mati, dan koneksi PostgreSQL tetap tersedot demi melayani "hantu".
   - *Defensive*: Jika *semua caller* sudah kabur, tidak ada gunanya meneruskan Query. Di sistem *Hyper-scale*, developer Go senior mengelola *Reference Counter Context* sendiri di dalam Singleflight, yang memicu `cancel` ke DB Driver jika (dan hanya jika) jumlah pendengar (waiter) mencapai angka `0` atau melakukan `sgGroup.Forget(key)` lalu me-return custom cancel error.
   
2. **Panic di Dalam Fungsi Singleflight**: Jika *panic* tak terkontrol (seperti *Nil Pointer Dereference*) terjadi di dalam fungsi *anonymous* di dalam `sg.Do` atau `DoChan`, perpustakaan Singleflight **akan menangkapnya dan otomatis melakukan RETHROW (Memicu Panic Ulang)** secara masif ke *SELURUH* caller (1000 goroutine) yang tengah mengantri. Ini akan meruntuhkan seluruh webserver Gin/Echo Anda karena handler HTTP mereka akan tertimpa ratusan panic.
   - *Defensive*: **WAJIB HUKUMNYA** menyertakan fungsi perlindungan `defer func() { recover() }()` lokal *di dalam* tubuh fungsi yang dilempar ke `DoChan()`, dan menerjemahkan kepanikan tersebut menjadi pengembalian variable *Normal Error* (`fmt.Errorf("panic caught: %v", r)`) agar infrastruktur HTTP Anda aman.

3. **Integritas Parameter**: Singleflight melakukan de-duplikasi murni mengacu pada kesamaan variabel string `key`. Jika URL endpoint Anda adalah `/profile?id=5&lang=en` lalu pengguna kedua datang dengan `/profile?id=5&lang=id`, dan Anda hanya menggunakan `"user_5"` sebagai `key` Singleflight, pengguna kedua yang menanti akan dibanjiri profil berbahasa Inggris (EN) karena ia numpang di hasil pengguna pertama.
   - *Defensive*: Selalu pertimbangkan hash dari kombinasi seluruh variabel pengubah status (State-changing Params) sebagai parameter *key* di singleflight. (e.g. `user_5_lang_id`).

## Kapan JANGAN Pakai Ini

- **Sebagai perlindungan stampede lintas pod.** Singleflight menggabungkan permintaan **di dalam satu proses**. Dengan 50 pod, backend tetap menerima 50 permintaan serentak saat kunci cache kedaluwarsa. Untuk itu dibutuhkan kunci di Redis atau TTL berjitter.
- **Pada operasi tulis.** Menggabungkan dua `POST` yang berbeda menjadi satu eksekusi berarti satu permintaan hilang tanpa jejak. Untuk tulis, alat yang benar adalah idempotency key.
- **Untuk data yang berubah cepat.** Peserta yang bergabung di akhir eksekusi menerima hasil yang sudah beberapa ratus milidetik usang. Untuk harga atau stok yang bergerak, itu bisa berarti keputusan yang salah.
- **Untuk panggilan yang murah.** Ongkos kunci peta dan alokasi pada singleflight bisa melebihi ongkos panggilan yang hendak dihemat.
- **Sebagai pengganti cache.** Singleflight meredam ledakan serentak, tetapi tidak mengurangi permintaan yang tersebar merata sepanjang waktu. Bila beban hilir tinggi tapi tidak meledak, yang dibutuhkan cache — bukan penggabungan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| QPS backend melonjak tajam pada kelipatan TTL | grafik QPS vs nilai TTL | Semua kunci kedaluwarsa bersamaan; butuh jitter pada TTL |
| Singleflight terpasang tapi beban hilir tidak turun | rasio `shared=true` | Nyaris tidak ada penggabungan — kuncinya terlalu spesifik, atau beban memang merata |
| Ratusan permintaan gagal serentak dengan galat sama | apakah galat ikut dibagikan | Satu galat transien didistribusikan ke semua peserta |
| Seluruh handler HTTP panik bersamaan | `panic` di dalam fungsi singleflight | Panic di-*rethrow* ke semua pemanggil; butuh `recover` lokal |
| Pengguna menerima data milik permintaan lain | komposisi kunci singleflight | Parameter pembeda (bahasa, tenant) tidak masuk ke dalam kunci |

```bash
# Rasio penggabungan. Catat nilai `shared` dari Do/DoChan sebagai field log.
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.msg=="singleflight") | .shared' | sort | uniq -c

# Ledakan berkala = TTL seragam. Bandingkan pola lonjakan dengan nilai TTL.
redis-cli info stats | grep -E 'keyspace_hits|keyspace_misses|expired_keys'

# Sebaran TTL sisa: kalau menumpuk di satu nilai, jitter belum dipasang
for k in $(redis-cli --scan --pattern 'cache:*' | head -200); do redis-cli ttl "$k"; done \
  | sort -n | uniq -c | tail -20
```
