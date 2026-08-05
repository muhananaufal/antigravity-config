# Panduan Komprehensif: Distributed Cron & Job Scheduling di Golang

> **Berlaku:** Go 1.21+ · `robfig/cron/v3` · **Lihat juga:** `concurrency/distributed_locks_redis.md` · `background_jobs_worker/job_observability.md` · `distributed_patterns_resilience/temporal_workflow_engine.md` · `background_jobs_worker/river_postgres_jobs.md`

Dalam lingkungan *microservices* modern atau Kubernetes (K8s) dengan *multi-replica deployment*, penjadwalan tugas (*cron jobs*) menjadi jauh lebih kompleks dibandingkan *single-node deployment*. Menjalankan cron tanpa mekanisme yang tepat akan menyebabkan **Duplicate Execution** (satu job dieksekusi berkali-kali oleh pod yang berbeda) dan **Overlapping Execution** (job lama belum selesai, job baru sudah jalan).

Dokumen ini adalah *deep-dive* level arsitek mengenai implementasi penjadwalan *cron* di Golang menggunakan `robfig/cron/v3` dan `go-co-op/gocron`, lengkap dengan *distributed locking*, penanganan zona waktu, observabilitas, serta *dynamic reloading*.

---

## 1. Konsep Mendalam & Internals

Secara internal, *cron scheduler* di Golang bekerja menggunakan `time.Timer` atau `time.Ticker` yang dijalankan dalam *event loop* khusus. 
1. **Parser**: Mengonversi ekspresi cron (contoh: `*/5 * * * *`) menjadi *next execution time* (`time.Time`).
2. **Priority Queue / Heap**: Scheduler menyimpan kumpulan tugas yang dijadwalkan berdasarkan waktu eksekusi terdekat (dimasukkan dalam *Min-Heap*).
3. **Event Loop**: Goroutine utama menunggu hingga *next execution time* dari job teratas di *heap* tercapai menggunakan `time.AfterFunc` atau `select` pada `time.Timer.C`.
4. **Dispatcher**: Saat *timer* terpicu, *dispatcher* akan membuat goroutine baru untuk mengeksekusi fungsi tugas, lalu menghitung *next execution time* dan memasukkannya kembali ke *heap*.

Tantangan utama di ekosistem terdistribusi (K8s) adalah **sinkronisasi antar node**. Karena setiap *Pod* memiliki *scheduler* independen, mereka akan memicu tugas secara bersamaan. Solusinya adalah menggunakan **Distributed Lock** (seperti Redis `SETNX` atau Postgres *Advisory Lock*).

### Arsitektur Distributed Cron di Kubernetes

```text
+------------------------------------------------------------------------+
|                          Kubernetes Cluster                            |
|                                                                        |
|  +----------------+      +----------------+      +----------------+    |
|  |     Pod A      |      |     Pod B      |      |     Pod C      |    |
|  | [Cron Worker]  |      | [Cron Worker]  |      | [Cron Worker]  |    |
|  +-------+--------+      +-------+--------+      +-------+--------+    |
|          |                       |                       |             |
+----------|-----------------------|-----------------------|-------------+
           |                       |                       |
           v                       v                       v
    +-------------------------------------------------------------+
    |                    Distributed Lock (Redis)                 |
    |  - Kunci: `cron:daily_report:lock`                          |
    |  - TTL: Durasi job + buffer (misal: 10 menit)               |
    +-------------------------------+-----------------------------+
                                    |
                                    v
    +-------------------------------------------------------------+
    |                  Database (Postgres / MySQL)                |
    |  - Tabel `cron_schedules` (Untuk Dynamic Hot Reload)        |
    |  - Data Utama                                               |
    +-------------------------------------------------------------+
```

---

## 2. Implementasi `robfig/cron/v3` (Timezone & Job Overlap)

`robfig/cron` sangat ringan dan menjadi standar industri. Kita akan menggunakan:
1. `cron.WithLocation()` untuk *timezone-aware expressions*.
2. `cron.SkipIfStillRunningLogger()` untuk mencegah eksekusi berulang jika job sebelumnya belum selesai (Overlapping Prevention).

```go
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/robfig/cron/v3"
)

// InitRobfigCron menginisiasi cron scheduler dasar dengan timezone Jakarta.
func InitRobfigCron(logger *slog.Logger) *cron.Cron {
	location, err := time.LoadLocation("Asia/Jakarta")
	if err != nil {
		logger.Error("Gagal memuat timezone", "error", err)
		location = time.UTC
	}

	// Wrapper logger untuk menyesuaikan dengan antarmuka robfig/cron
	cronLogger := cron.VerbosePrintfLogger(log.New(logger.Handler(), "", 0))

	c := cron.New(
		cron.WithLocation(location),
		// Mencegah job overlap dan melakukan logging jika ada job yang di-skip
		cron.WithChain(cron.SkipIfStillRunningLogger(cronLogger)),
		cron.WithSeconds(), // Dukungan cron hingga tingkat detik
	)

	// Contoh penjadwalan
	_, err = c.AddFunc("0 0 12 * * *", func() {
		logger.Info("Job dieksekusi tepat jam 12:00:00 WIB", "time", time.Now().In(location))
		// Simulasi proses lama
		time.Sleep(2 * time.Second)
	})
	if err != nil {
		logger.Error("Gagal menjadwalkan job", "error", err)
	}

	return c
}
```

---

## 3. Implementasi `go-co-op/gocron` dengan Distributed Lock (Redis)

Untuk K8s dengan multi-replica, `go-co-op/gocron` mendukung lokalisasi terdistribusi secara *native* melalui *interface* `Locker`. Kita akan menggunakan `go-redsync/redsync` untuk *distributed mutex* di Redis.

```go
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/go-co-op/gocron/v2"
	"github.com/go-redsync/redsync/v4"
	"github.com/go-redsync/redsync/v4/redis/goredis/v9"
	"github.com/redis/go-redis/v9"
)

// RedisLocker mengimplementasikan gocron.Locker interface
type RedisLocker struct {
	rs *redsync.Redsync
}

// Lock mencoba mengambil distributed lock dari Redis.
func (r *RedisLocker) Lock(ctx context.Context, key string) (gocron.Lock, error) {
	mutex := r.rs.NewMutex("gocron:lock:"+key, redsync.WithExpiry(5*time.Minute))
	
	if err := mutex.LockContext(ctx); err != nil {
		return nil, err // Lock gagal, mungkin sudah diambil pod lain
	}
	
	return &RedisLock{mutex: mutex}, nil
}

// RedisLock merepresentasikan lock aktif yang bisa dilepaskan (Unlock).
type RedisLock struct {
	mutex *redsync.Mutex
}

func (rl *RedisLock) Unlock(ctx context.Context) error {
	_, err := rl.mutex.UnlockContext(ctx)
	return err
}

// InitDistributedCron menginisiasi gocron dengan Redis locker.
func InitDistributedCron(redisClient redis.UniversalClient, logger *slog.Logger) (gocron.Scheduler, error) {
	pool := goredis.NewPool(redisClient)
	rs := redsync.New(pool)
	locker := &RedisLocker{rs: rs}

	s, err := gocron.NewScheduler(
		gocron.WithLocation(time.FixedZone("WIB", 7*3600)),
		gocron.WithDistributedLocker(locker),
	)
	if err != nil {
		return nil, err
	}

	// Job ini hanya akan dieksekusi oleh 1 pod karena menggunakan distributed locker
	_, err = s.NewJob(
		gocron.CronJob("*/5 * * * *", false), // Eksekusi setiap 5 menit
		gocron.NewTask(func(jobCtx context.Context) {
			logger.Info("Menjalankan tugas terdistribusi, saya memegang lock!")
			// Pekerjaan penting dilakukan di sini...
		}),
		gocron.WithName("distributed-cleanup-task"),
		gocron.WithSingletonMode(gocron.LimitModeReschedule), // Cegah overlap
	)
	
	if err != nil {
		return nil, err
	}

	return s, nil
}
```

---

## 4. Observabilitas Cron (Metrics & Logging)

Tanpa pemantauan, cron job adalah *black box*. Kita harus mengekspos metrik Prometheus: durasi, kapan terakhir jalan, dan tingkat kegagalan (*error rate*).

```go
package jobs

import (
	"context"
	"time"
	"github.com/prometheus/client_golang/prometheus"
)

var (
	cronJobDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "cron_job_duration_seconds",
		Help:    "Durasi eksekusi cron job.",
		Buckets: prometheus.DefBuckets,
	}, []string{"job_name"})

	cronJobStatus = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "cron_job_total",
		Help: "Jumlah eksekusi job berdasarkan status sukses/gagal.",
	}, []string{"job_name", "status"}) // status: "success", "error"

	cronLastRun = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "cron_job_last_run_timestamp",
		Help: "Waktu terakhir cron job dieksekusi (Unix timestamp).",
	}, []string{"job_name"})
)

func init() {
	prometheus.MustRegister(cronJobDuration, cronJobStatus, cronLastRun)
}

// ObservableTask adalah wrapper yang menjalankan task sambil memancarkan metrik.
func ObservableTask(jobName string, task func(context.Context) error) func(context.Context) {
	return func(ctx context.Context) {
		start := time.Now()
		cronLastRun.WithLabelValues(jobName).Set(float64(start.Unix()))
		
		err := task(ctx)
		
		duration := time.Since(start).Seconds()
		cronJobDuration.WithLabelValues(jobName).Observe(duration)
		
		if err != nil {
			cronJobStatus.WithLabelValues(jobName, "error").Inc()
			// Boleh di log errornya...
		} else {
			cronJobStatus.WithLabelValues(jobName, "success").Inc()
		}
	}
}
```

---

## 5. Dynamic Schedule Update (Hot Reload dari DB)

Dalam *production*, kadang kita butuh mengubah frekuensi tugas (misalnya saat beban tinggi) tanpa me-restart *Pod* (*zero downtime*). Caranya dengan menggunakan goroutine terpisah yang *polling* DB setiap X menit dan me-restart *scheduler* jika ada perubahan.

```go
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/go-co-op/gocron/v2"
)

// DynamicCronManager mengatur reload scheduler.
type DynamicCronManager struct {
	scheduler gocron.Scheduler
	jobID     gocron.Job // Menyimpan referensi ke job yang bisa diubah
	logger    *slog.Logger
	fetchCron func() (string, error) // Fungsi untuk ambil data cron dari DB
}

// WatchForScheduleChanges melakukan polling DB setiap 1 menit.
func (d *DynamicCronManager) WatchForScheduleChanges(ctx context.Context, currentCron string) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			d.logger.Info("Berhenti memonitor perubahan jadwal")
			return
		case <-ticker.C:
			newCron, err := d.fetchCron()
			if err != nil || newCron == currentCron {
				continue // Error mengambil db atau tidak ada perubahan
			}
			
			d.logger.Info("Mendeteksi perubahan jadwal cron", "old", currentCron, "new", newCron)
			
			// Perbarui job di scheduler
			err = d.scheduler.Update(
				d.jobID.ID(),
				gocron.CronJob(newCron, false),
				gocron.NewTask(func() { /* task content */ }),
			)
			if err == nil {
				currentCron = newCron
			} else {
				d.logger.Error("Gagal mengupdate jadwal", "error", err)
			}
		}
	}
}
```

---

## 6. Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menjalankan Cron di Multi-Pod K8s Tanpa Distributed Lock
Ini adalah masalah yang paling umum. Jika Anda men-deploy 5 instance, maka laporan email bulanan akan dikirim 5 kali ke pengguna.

```go
// ❌ BAD: Akan tereksekusi oleh SEMUA pod Kubernetes secara bersamaan.
func InitBadCron() {
	c := cron.New()
	// Setiap jam 8 pagi, 5 replika k8s akan mengirim tagihan secara bersamaan!
	c.AddFunc("0 8 * * *", func() {
		users := fetchUsers()
		for _, u := range users {
			sendInvoiceEmail(u) // Duplicate email dikirim 5x ke user yang sama!
		}
	})
	c.Start()
}
```

```go
// ✅ GOOD: Menggunakan Redis Distributed Lock & Idempotent Logic
func InitGoodCron(redisClient *redis.Client) {
	c := cron.New()
	c.AddFunc("0 8 * * *", func() {
		// Coba ambil lock dari redis
		ok, err := redisClient.SetNX(context.Background(), "lock:invoice_daily", "1", 10*time.Minute).Result()
		if err != nil || !ok {
			return // Pod lain sudah mengerjakannya
		}
		
		// Proses invoice dengan status idempotency DB
		users := fetchPendingInvoiceUsers()
		for _, u := range users {
			sendInvoiceEmail(u)
			markInvoiceSent(u.ID) // Update DB: idempotensi fallback
		}
	})
	c.Start()
}
```

### ❌ Anti-Pattern 2: Blocking Event Loop Cron
Jika sebuah *job* berjalan sangat lambat atau mengalami *deadlock* tanpa batas waktu (misalnya *network request* tanpa *timeout*), ia dapat menghalangi goroutine utama *cron*, menyebabkan keterlambatan pada eksekusi tugas lain atau mengunci antrean *overlap*.

```go
// ❌ BAD: Tidak ada timeout context, jika API lambat, job nyangkut selamanya.
c.AddFunc("*/5 * * * *", func() {
	resp, _ := http.Get("http://slow-api.internal") // Default http client tak ada timeout!
	process(resp) 
})

// ✅ GOOD: Gunakan Context Timeout & SkipIfStillRunning
c.AddFunc("*/5 * * * *", func() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://slow-api.internal", nil)
	client := &http.Client{} // Request akan dibatalkan otomatis setelah 3 menit
	resp, _ := client.Do(req)
	process(resp)
})
```

---

## 7. Edge Cases & Defensive Programming

Dalam sistem penjadwalan skala besar, asumsi "pasti jalan" selalu salah. Berikut 5 + 1 *edge cases* kritis:

1. **DST (Daylight Saving Time) Transitions**:
   * **Masalah**: Pada saat perpindahan DST (misal mundur 1 jam dari jam 2 ke 1 pagi), waktu lokal 01:30 akan terjadi dua kali. Cron bisa jalan 2x, atau ter-skip.
   * **Mitigasi**: Selalu gunakan zone berbasis letak geografis aktual melalui `time.LoadLocation` daripada asumsi offset statis, dan jadwalkan cron penting di waktu yang bebas transisi (misal UTC atau siang hari). Jika memungkinkan, definisikan semua sistem di UTC.
2. **Missed Execution Saat Pod Restart (Pod Eviction/OOM/Deployment)**:
   * **Masalah**: Jika pod direstart saat waktu cron seharusnya dipicu (misalnya `00:00`), event cron akan terlewat.
   * **Mitigasi**: Cron *scheduler* BUKAN *queue*. Gunakan tabel `cron_logs` di database. Saat pod baru menyala (startup probe), periksa apakah job harian kemarin belum tereksekusi dengan melihat *last log*. Jika terlewat, picu eksekusi *catch-up* secara asinkron.
3. **Clock Drift (Penyimpangan Waktu) Antar Node**:
   * **Masalah**: K8s Node A mungkin 2 detik lebih cepat dari Node B. Node A memicu cron jam 12:00:00, namun gagal dan Node B juga mencoba namun Redis lock Node A belum expire.
   * **Mitigasi**: Kunci `SetNX` Redis tidak hanya mengandalkan TTL. Gunakan mekanisme NTP yang tersinkronisasi antar Node K8s, serta pertimbangkan memberikan sedikit *random jitter/sleep* mili-detik sebelum *pod* memperebutkan lock untuk mengurangi perebutan buta (*thundering herd*).
4. **Redis Network Partition (Lock Phantom/Orphan)**:
   * **Masalah**: Pod mendapat lock Redis, tetapi kehilangan koneksi jaringan. Job terhenti (karena tak bisa query DB juga), tapi Lock tetap ada di Redis selama sisa waktu TTL. Job tsb menjadi "Orphan".
   * **Mitigasi**: Gunakan ekstensi TTL *heartbeat*. Berikan TTL lock cukup pendek (contoh: 30 detik). Goroutine pemegang job harus me-refresh *lock TTL* ke Redis setiap 15 detik selama job masih berjalan (*Watchdog Pattern*). Jika pod mati konyol, TTL lock segera habis, pod lain bisa ambil.
5. **Graceful Shutdown Blocking**:
   * **Masalah**: K8s mengirim SIGTERM saat pod di-rolling update. Cron sedang memproses *file batch* sebesar 5GB. Jika dimatikan paksa, file korup.
   * **Mitigasi**: Panggil method `Stop()` dari scheduler untuk menghentikan penerimaan *job* baru. Gunakan `WaitGroup` di setiap awal task. Saat *shutdown*, tunggu `wg.Wait()` maksimal `terminationGracePeriodSeconds` (K8s) dikurangi sedikit waktu *buffer*, atau segera hentikan proses di *checkpoint* yang aman.
6. **Thundering Herd Ke Database**:
   * **Masalah**: Job harian membangun cache yang sama pada waktu yang sama. Sekalipun terkunci dengan Redis, query ke Postgres dapat membengkak akibat cache invalidation saat awal mulai cron.
   * **Mitigasi**: Tambahkan *Jitter*. Jadwalkan dengan ekspresi `* * * * *` dan gunakan `time.Sleep(rand.Intn(1000) * time.Millisecond)` di awal fungsi job agar meminimalisir penumpukan sesaat koneksi I/O.

---

## 8. Unit & Integration Testing 

Penjadwalan terkait dengan *waktu*, yang sulit diuji. Praktik terbaik adalah memisahkan **logika domain/pekerjaan** dari **kerangka cron**. Ekstrak eksekusi pekerjaan (Task) ke sebuah fungsi, lalu uji fungsi tersebut dengan unit test biasa dan *mocking*.

### 8.1. Unit Test - Eksekusi Tugas yang Terisolasi
Pisahkan `MyJobFunction` agar dapat dites tanpa butuh Cron terpasang.

```go
package jobs_test

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Misal ini fungsi aslinya yang ada di package jobs
// func MyImportantTask(ctx context.Context, api APIClient) error { ... }

// Mock APIClient
type MockAPIClient struct {
	Called bool
	Err    error
}

func (m *MockAPIClient) CallAPI() error {
	m.Called = true
	return m.Err
}

func TestMyImportantTask_Success(t *testing.T) {
	mockAPI := &MockAPIClient{Err: nil}
	
	// Kita tes langsung function task-nya, bukan cron-nya.
	// Err := jobs.MyImportantTask(context.Background(), mockAPI)
	
	// Simulasi pemanggilan fungsi asli
	mockAPI.CallAPI() // asumsikan dipanggil dalam jobs.MyImportantTask
	
	if !mockAPI.Called {
		t.Error("Diharapkan API dipanggil, ternyata tidak")
	}
}

func TestMyImportantTask_Timeout(t *testing.T) {
	// Tes apakah logic kita handle context timeout dengan benar
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	time.Sleep(5 * time.Millisecond) // buat context expire

	if ctx.Err() != context.DeadlineExceeded {
		t.Errorf("Diharapkan context DeadlineExceeded, namun %v", ctx.Err())
	}
}
```

### 8.2. Integration Test - Redis Distributed Lock
Pastikan jika dua goroutine (mensimulasikan dua pod) mencoba memicu lock pada waktu bersamaan, hanya satu yang dapat lock. Membutuhkan *Redis Server* (misal pakai `testcontainers`).

```go
package jobs_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

func TestDistributedLocking(t *testing.T) {
	// NOTE: Butuh real/mock Redis connection di sini.
	// Asumsikan rdb = redis.NewClient(...) terhubung ke localhost:6379 atau miniredis.
	rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
	defer rdb.FlushAll(context.Background()) // Clean up

	var jobExecutionCount int32
	var wg sync.WaitGroup

	// Simulasi 5 Pod memicu eksekusi job yang sama di waktu (milidetik) yang sama
	numPods := 5
	wg.Add(numPods)

	for i := 0; i < numPods; i++ {
		go func(podID int) {
			defer wg.Done()

			// Coba mendapatkan lock (Simulasi logic Redsync atau SetNX)
			ctx := context.Background()
			lockKey := "test:cron:daily"
			
			ok, err := rdb.SetNX(ctx, lockKey, "locked", 5*time.Second).Result()
			if err != nil || !ok {
				return // Pod ini gagal dapat lock
			}

			// Berhasil mendapat lock, lakukan pekerjaaan
			atomic.AddInt32(&jobExecutionCount, 1)
			
			// Simulasi pekerjaan lambat agar pod lain tidak bisa curi lock yang baru expire
			time.Sleep(1 * time.Second) 
		}(i)
	}

	wg.Wait()

	// Assertions: Walaupun 5 pod berebut, hanya ada TEPAT 1 eksekusi
	assert.Equal(t, int32(1), atomic.LoadInt32(&jobExecutionCount), "Hanya 1 job yang boleh tereksekusi")
}
```

### 8.3. Integration Test - Robfig Cron Lifecycle
Pastikan *scheduler* berhasil di-start, bisa menambah *job*, dan `Stop()` bekerja. Gunakan `time.Sleep` untuk sinkronisasi tes singkat.

```go
package jobs_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/stretchr/testify/assert"
)

func TestCronLifecycle(t *testing.T) {
	c := cron.New(cron.WithSeconds())
	
	var runCount int32

	// Jadwalkan job untuk berjalan setiap detik
	entryID, err := c.AddFunc("* * * * * *", func() {
		atomic.AddInt32(&runCount, 1)
	})
	
	assert.NoError(t, err)
	assert.NotEqual(t, cron.EntryID(0), entryID)

	// Start cron
	c.Start()
	
	// Tunggu selama 2.5 detik (diharapkan run minimal 2 kali)
	time.Sleep(2500 * time.Millisecond)
	
	// Hentikan cron
	c.Stop()
	
	// Ambil count
	count := atomic.LoadInt32(&runCount)
	assert.GreaterOrEqual(t, count, int32(2), "Job harus dijalankan setidaknya 2x")
	
	// Pastikan tidak bertambah lagi
	time.Sleep(1500 * time.Millisecond)
	countAfterStop := atomic.LoadInt32(&runCount)
	
	assert.Equal(t, count, countAfterStop, "Job tidak boleh jalan lagi setelah cron di Stop()")
}
```

---

## Kesimpulan

Menjadwalkan *background job* secara terdistribusi di Go memerlukan pergeseran *mindset* dari *single-process scheduler* ke *cluster-aware scheduling*. 

**Ringkasan Checklist untuk Arsitek/Developer:**
1. ✅ **Gunakan Redis/DB Lock** untuk *idempotency* dan mencegah ekseskusi ganda K8s Pods.
2. ✅ **Batasi Overlap** eksekusi fungsi yang lambat (via `SkipIfStillRunning`).
3. ✅ **Terapkan Context dengan Timeout** di setiap I/O HTTP atau Database di dalam *Cron Worker*.
4. ✅ **Keluarkan Metrik (Prometheus)** untuk observabilitas status, durasi, dan waktu pengeksekusian.
5. ✅ Pisahkan *business logic task* dari kerangka cron scheduler agar **mudah diuji (Unit Test)**.
6. ✅ Antisipasi Pod Crash dengan pencatatan log historis eksekusi di basis data untuk proses **Catch-Up**.

## Kapan JANGAN Pakai Ini

- **Cron dalam proses pada armada banyak pod tanpa leader election.** Setiap pod menjalankan job yang sama pada waktu yang sama. Untuk job yang mengirim email atau menagih pelanggan, itu langsung terlihat oleh pengguna.
- **Cron tanpa timeout.** Job yang menggantung akan tumpang tindih dengan jadwal berikutnya, lalu berikutnya lagi, sampai sumber daya habis — dan penyebabnya sulit dilihat karena setiap eksekusi tampak normal.
- **Mengandalkan waktu server tanpa zona waktu eksplisit.** Peralihan DST membuat job berjalan **dua kali** atau **terlewat sama sekali**, satu kali setahun, di lingkungan yang tidak pernah diuji untuk itu.
- **Job cron yang tidak idempoten.** Restart pod di dalam jendela jadwal bisa memicu eksekusi ulang, dan itu di luar kendali penjadwal.
- **Cron untuk pekerjaan yang harus dijamin berjalan.** Pod yang mati tepat pada jadwal berarti job terlewat **tanpa jejak**. Butuh pencatatan eksekusi dan pemeriksaan job yang seharusnya berjalan tapi tidak.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Job berjalan beberapa kali per jadwal | jumlah replika vs leader election | Setiap pod menjalankan penjadwalnya sendiri |
| Job terlewat tanpa ada yang tahu | catatan eksekusi per jadwal | Tidak ada pemeriksaan job yang tidak berjalan |
| Anomali setahun sekali | zona waktu penjadwal | Peralihan DST |
| Eksekusi bertumpuk | durasi job vs interval | Tidak ada timeout maupun penguncian |
| Job berjalan pada waktu yang salah | zona waktu container vs bisnis | Container UTC, jadwal bisnis lokal |

```bash
# Satu jadwal WAJIB menghasilkan satu eksekusi -- angka > 1 adalah masalah
kubectl logs -l app=worker --since=24h \
  | jq -r 'select(.event=="cron_mulai") | "\(.jadwal_id) \(.slot)"' | sort | uniq -c | awk '$1>1'

# Job yang seharusnya berjalan tapi tidak tercatat
```

```sql
SELECT nama_jadwal, max(mulai_pada) AS terakhir, now() - max(mulai_pada) AS sejak
FROM eksekusi_cron GROUP BY 1 ORDER BY sejak DESC;
```

```bash
# Zona waktu yang benar-benar dipakai proses
kubectl exec <pod> -- date
kubectl exec <pod> -- sh -c 'echo $TZ; cat /etc/timezone 2>/dev/null'
```
