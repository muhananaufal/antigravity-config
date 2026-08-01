# Panduan Komprehensif Golang Background Jobs menggunakan Asynq & Redis

Eksekusi tugas di latar belakang (background job processing) adalah komponen kritis dalam arsitektur sistem terdistribusi modern untuk melepaskan beban dari siklus HTTP request-response. `hibiken/asynq` adalah pustaka Go terdepan yang memanfaatkan Redis sebagai perantara (message broker) untuk manajemen antrean yang persisten, andal, dan skalabel.

Dokumen ini adalah standar kualitas *top 1%* (production-ready) yang mengupas tuntas arsitektur, implementasi *type-safe*, hingga penanganan *edge cases* ekstrem di *production*.

---

## 1. Arsitektur Asynq: Client → Redis Broker → Server Worker Pool

Asynq tidak memerlukan layanan perantara terpisah seperti RabbitMQ atau Kafka; ia secara eksklusif menggunakan Redis, memanfaatkannya dengan struktur data spesifik untuk mengoptimalkan operasi antrean.

- **Client**: Aplikasi utama (misalnya REST API web server) yang membuat *Task* dan memasukannya (enqueue) ke Redis.
- **Redis Broker**: Menyimpan state (status) dari semua tugas. Asynq menggunakan berbagai tipe data Redis:
  - **ZSET (Sorted Set)**: Menyimpan tugas yang dijadwalkan (scheduled), tugas yang tertunda untuk di-retry, dan tugas *dead*. Skor di *ZSET* adalah timestamp kapan tugas harus dipindahkan ke *Queue*.
  - **LIST**: Antrean utama (Queue) di mana *Worker* melakukan operasi `BLPOP` (blocking pop) untuk mengambil tugas yang siap dieksekusi.
  - **HASH**: Menyimpan metadata tugas dan payload biner.
- **Server (Worker Pool)**: Proses background (biasanya terpisah atau goroutine di aplikasi yang sama) yang terus menerus menarik tugas dari *LIST* Redis, mengeksekusinya dalam *goroutine pool*, dan melaporkan kembali status (Sukses/Gagal).

---

## 2. Diagram Siklus Hidup Tugas (Task Lifecycle)

Setiap tugas dalam asynq melewati transisi state (status) yang sangat terdefinisi. Memahami siklus ini penting untuk *debugging*.

```text
+---------+      enqueue      +---------+      dequeue       +---------+
|         | ----------------> |         | -----------------> |         |
| Client  |                   | Pending |                    | Active  |
|         | ---+              | (LIST)  | <-------+          | (Mem)   |
+---------+    |              +---------+         |          +---------+
               | scheduled        ^               |               |
               |                  |               | retry         |
               v                  | time passes   |               |
         +---------+              |               |          +----v----+
         |         | -------------+---------------+          |         |
         |Scheduled|                                         |Completed|
         | (ZSET)  |                                         | (ZSET)  |
         +---------+                                         +---------+
                                                                  |
                                      max retries reached         | (optional retention)
                                      +-----------------+         |
                                      |                 |         v
                                      |      Dead       |   [Deleted/Archived]
                                      |     (ZSET)      |
                                      +-----------------+
```

---

## 3. Task Definition: Pola TypedTask (Type-Safe Payload)

Mengirim raw JSON byte slice sebagai payload sangat rentan terhadap kesalahan (*error-prone*). Best practice adalah menggunakan pola **TypedTask** yang membungkus inisialisasi tugas dan eksekusi dengan struct Go (Type-Safe).

```go
package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
)

// 1. Definisikan nama tugas
const (
	TypeEmailDelivery = "email:deliver"
)

// 2. Definisikan Payload Struct (Type-Safe)
type EmailDeliveryPayload struct {
	UserID     int64  `json:"user_id"`
	TemplateID string `json:"template_id"`
	ToAddress  string `json:"to_address"`
}

// 3. Fungsi Pembuat Task (Enqueuer)
func NewEmailDeliveryTask(userID int64, templateID, toAddress string) (*asynq.Task, error) {
	payload := EmailDeliveryPayload{
		UserID:     userID,
		TemplateID: templateID,
		ToAddress:  toAddress,
	}
	
	bytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("gagal marshalling email payload: %w", err)
	}

	// asynq.Task berisi nama/tipe dan payload biner
	return asynq.NewTask(TypeEmailDelivery, bytes), nil
}

// 4. Handler Interface Implementor
type EmailDeliveryProcessor struct {
	// dependencies like DB, MailerService etc go here
	Mailer EmailService // assuming an interface
}

func (p *EmailDeliveryProcessor) ProcessTask(ctx context.Context, t *asynq.Task) error {
	var payload EmailDeliveryPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("json.Unmarshal gagal: %v: %w", err, asynq.SkipRetry)
	}

	// Lakukan bisnis logic dengan type-safe payload
	err := p.Mailer.Send(ctx, payload.ToAddress, payload.TemplateID, payload.UserID)
	if err != nil {
		return fmt.Errorf("pengiriman email gagal untuk user %d: %w", payload.UserID, err)
	}
	
	return nil
}

type EmailService interface {
	Send(ctx context.Context, to, template string, userID int64) error
}
```

---

## 4. Konfigurasi Server: Worker Pool & Queue Priority

Asynq memungkinkan kita menetapkan bobot (weight) pada antrean. Priority strict memastikan antrean berbobot tinggi diproses lebih sering.

```go
package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
	"your_project/jobs"
)

func StartWorkerPool(redisConnOpt asynq.RedisConnOpt) {
	// Konfigurasi server worker
	srv := asynq.NewServer(
		redisConnOpt,
		asynq.Config{
			// Concurrency: Jumlah goroutine paralel (default: jumlah CPU)
			Concurrency: 10,
			
			// Priority weight queues
			// 60% waktu dihabiskan untuk critical, 30% default, 10% low
			Queues: map[string]int{
				"critical": 6, // 6/10 -> 60%
				"default":  3, // 3/10 -> 30%
				"low":      1, // 1/10 -> 10%
			},
			
			// Custom error handler (untuk integrasi Sentry/NewRelic)
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
				slog.Error("Task gagal", "type", task.Type(), "error", err)
			}),
			
			// Shutdown timeout saat SIGINT/SIGTERM (graceful shutdown)
			ShutdownTimeout: 30 * time.Second,
		},
	)

	// Register mux router (mirip HTTP router)
	mux := asynq.NewServeMux()
	
	// Daftarkan handler
	emailProcessor := &jobs.EmailDeliveryProcessor{/* inject deps */}
	mux.Handle(jobs.TypeEmailDelivery, emailProcessor)

	if err := srv.Run(mux); err != nil {
		slog.Error("Gagal menjalankan asynq server", "error", err)
	}
}
```

---

## 5. Fitur Lanjutan: Penjadwalan, Unik, & Retry Kustom

Asynq menawarkan banyak opsi saat *enqueueing* tugas. Kita dapat menggabungkannya (komposabilitas opsi).

### A. Retry dengan Exponential Backoff + Custom Delay

Secara default, Asynq menggunakan algoritma *exponential backoff* yang baik (`(retries^4) + 15 + (rand * 30) seconds`), tetapi untuk integrasi API pihak ketiga (misalnya webhook gateway), kita sering kali memerlukan penyesuaian.

```go
// Custom fungsi penundaan
func webhookRetryDelayFunc(n int, e error, t *asynq.Task) time.Duration {
	// Retry linear untuk 3 percobaan pertama, setelah itu eksponensial lambat
	if n < 3 {
		return 10 * time.Second
	}
	return time.Duration(n) * time.Minute // 4 menit, 5 menit, dst
}

// Saat Enqueue:
func EnqueueWebhookTask(client *asynq.Client, task *asynq.Task) error {
	info, err := client.Enqueue(task, 
		asynq.MaxRetry(5),
		asynq.Queue("default"),
		asynq.RetryDelayFunc(webhookRetryDelayFunc), // Injeksi kustom fungsi delay
	)
	_ = info
	return err
}
```

### B. Unique Tasks (Deduplication)

Seringkali kita tidak ingin tugas yang persis sama diantrekan lebih dari sekali dalam jangka waktu tertentu. Asynq menggunakan Redis `SET NX` secara atomik di belakang layar untuk menjamin properti *Unique*.

```go
// Mencegah pengiriman tagihan dua kali dalam 1 jam
func EnqueueInvoice(client *asynq.Client, invoiceID string) {
	task, _ := asynq.NewTask("invoice:generate", []byte(invoiceID))
	
	// Task akan gagal di-enqueue (mereturn `ErrDuplicateTask`) jika 
	// sudah ada tugas dengan tipe, payload, dan queue yang sama
	// dalam jendela waktu (TTL) 1 jam terakhir yang sedang pending/active.
	info, err := client.Enqueue(task, asynq.Unique(time.Hour))
	if err == asynq.ErrDuplicateTask {
		slog.Info("Invoice sudah masuk antrean", "invoice_id", invoiceID)
	}
}
```

### C. Scheduled Tasks (Tertunda Eksekusi)

Menjadwalkan tugas relatif terhadap saat ini (`ProcessIn`) atau absolut pada waktu tertentu (`ProcessAt`).

```go
// Relatif (misal: jalankan 24 jam dari sekarang)
client.Enqueue(task, asynq.ProcessIn(24*time.Hour))

// Absolut (misal: jalankan pada tanggal 1 Januari tahun depan)
targetDate := time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)
client.Enqueue(task, asynq.ProcessAt(targetDate))
```

---

## 6. Asynqmon Web UI untuk Monitoring

`asynqmon` adalah aplikasi web berbasis React + Go untuk memeriksa status tugas yang menggunakan Redis Asynq. Menjalankan asynqmon di *production* sebaiknya digabungkan di server admin *internal-only*.

```go
package main

import (
	"log"
	"net/http"

	"github.com/hibiken/asynq"
	"github.com/hibiken/asynqmon"
)

func StartAsynqmon() {
	h := asynqmon.New(asynqmon.Options{
		RootPath:     "/admin/queues", // Mount path
		RedisConnOpt: asynq.RedisClientOpt{Addr: "localhost:6379"},
	})

	// Tambahkan Basic Auth atau middleware keamanan lain di production!
	http.Handle("/admin/queues/", h)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

---

## 7. Anti-Pattern (Kesalahan Umum)

### ❌ Anti-Pattern 1: Menyimpan Payload Terlalu Besar ke Redis
Redis berbasis *in-memory* dan *single-threaded* untuk eksekusi perintah (sebagian besar). Payload > 1MB memblokir instans Redis dan mengkonsumsi banyak memori yang mahal harganya.

**❌ BAD:**
```go
// Menyisipkan gambar base64 berukuran 5MB ke dalam payload task
type UploadPayload struct {
	FileBase64Data string `json:"file_data"` // SANGAT BURUK!
}
```

**✅ GOOD:**
Simpan file ke *Blob Storage* (S3/GCS) atau database reguler, lalu lewatkan *ID/URL referensi* pada payload task.
```go
type UploadPayload struct {
	ObjectID string `json:"object_id"` // Ambil "s3://bucket/path" di dalam Worker
}
```

### ❌ Anti-Pattern 2: Tidak Menghormati Context Timeout / Pembatalan
Asynq mengirim sinyal ke `ctx.Done()` saat server shutdown, atau ketika *Timeout* tercapai. Jika Anda menggunakan IO jaringan tanpa context tersebut, *goroutine worker* akan *leak* atau mencegah graceful shutdown.

**❌ BAD:**
```go
func (p *Processor) ProcessTask(ctx context.Context, t *asynq.Task) error {
	// Context diabaikan, operasi HTTP default tanpa batas waktu
	resp, err := http.Get("https://api.external.com/slow")
	// ...
}
```

**✅ GOOD:**
```go
func (p *Processor) ProcessTask(ctx context.Context, t *asynq.Task) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.external.com/slow", nil)
	client := &http.Client{Timeout: 15 * time.Second} // Defensive timeout
	resp, err := client.Do(req)
	// ...
}
```

---

## 8. Edge Cases di Level Produksi Skala Besar

Menghadapi sistem berskala tinggi berarti bersiap terhadap ketidaksempurnaan infrastruktur jaringan.

### 1. Dampak Kegagalan (Failover) Redis & Koneksi Terputus
**Masalah**: Redis master mati, failover ke replika memakan waktu 10-30 detik.
**Solusi / Perilaku Internals**:
Asynq menggunakan library `go-redis` yang otomatis menangani *reconnection* berulang kali. Saat koneksi putus, *Worker* yang mengambil task via `BLPOP` akan gagal secara diam-diam dan akan masuk ke mode *backoff loop* internal Asynq untuk mencoba *re-connect*. Namun, untuk tugas yang *sedang diproses* dan perlu di-ACK sebagai Selesai, Asynq menyimpannya secara lokal di memori jika operasi jaringan untuk memindahkan dari `Active` ke `Completed` gagal, dan akan *retry* seiring waktu.

### 2. Kebijakan Kearsipan Tugas (Task Archival Policy) & Ledakan ZSET Dead
**Masalah**: Tugas yang melebihi `MaxRetry(N)` (default: 25) dipindahkan ke status `Dead`. Jika dibiarkan, Redis Memory akan OOM (Out Of Memory).
**Solusi**:
Konfigurasi `Retention(24*time.Hour)` pada saat `Enqueue`. Tugas otomatis dihapus setelah 24 jam meskipun `Completed`. Untuk task `Dead`, jalankan worker terpisah sebagai Cron (`asynqmon` menyediakan CLI, atau tulis script Redis Lua) secara berkala memindahkan JSON dari ZSET `asynq:dead` ke Data Warehouse (misalnya BigQuery) untuk di-audit, lalu hapus kuncinya.

### 3. Graceful Shutdown Saat Tugas Sedang Jalan (SIGTERM)
**Masalah**: Pen-deploy-an ulang Kubernetes mengirim SIGTERM. Jika worker langsung mati, tugas yang sedang berjalan hilang ke ruang hampa (berada di status `Active` tapi tak berlanjut, yang mana akan terdeteksi *stale* setelah durasi lama, tapi tak diinginkan).
**Solusi**:
Gunakan opsi `ShutdownTimeout`. Asynq akan menghentikan konsumsi antrean baru, membiarkan tugas berjalan untuk menyelesaikannya. Jika ada tugas belum selesai setelah waktu ini (mis. 30 detik), Asynq mengembalikan tugas-tugas *Active* tadi ke `Pending` (LIST) di Redis sehingga *pod Kubernetes* worker baru dapat melanjutkannya tanpa tugas hilang. WAJIB patuhi parameter context di `ProcessTask`.

### 4. Skew Waktu Server (Clock Skew)
**Masalah**: Jika server klien `Enqueue` dan server worker berbeda waktu sistemnya (NTP tidak tersinkron), tugas terjadwal (`ProcessAt`) dapat jalan terlalu cepat atau terlambat.
**Solusi**:
Pusatkan komputasi penjadwalan. Selalu gunakan Redis server time, tetapi jika tidak memungkinkan, hindari perbedaan >1 detik. Asynq worker memindahkan tugas Scheduled -> Pending dari ZSET menggunakan polling (default setiap 1 detik) di sinkronisasi dengan *server local time* worker itu sendiri.

### 5. Poison Pills & OOM Killed
**Masalah**: Sebuah pesan memiliki format cacat atau ukuran yang jika di-unmarshal menyebabkan spike RAM 5GB. Kubernetes kernel secara kasar membunuh (OOMKilled) pod (tanpa SIGTERM).
**Solusi**:
Tugas ini masuk dalam status "Zombifikasi" karena pod tiba-tiba raib tanpa sinyal Asynq mengembalikannya ke queue.
*Internals Asynq*: Asynq memiliki *background goroutine* yang disebut *Heartbeater*. Selama tugas `Active`, worker memperbarui TTL pada state Redis. Jika worker mati seketika (OOMKilled), TTL kedaluwarsa. Server Asynq lain akan mendeteksi (melalui *inspector/stale task check*) bahwa tugas tersebut *stale*, memindahkannya kembali dari `Active` ke `Pending`. Ini berarti, OOM task akan terus membuat worker satu per satu terbunuh tanpa batas (*CrashLoopBackOff*).
**Pertahanan**: Selalu terapkan batas memori baca maksimum (misalnya `io.LimitReader`) dan hindari manipulasi byte mentah tak terbatas dalam memory buffer dari payload.

---

## 9. Pengujian (Tests) Unit dan Integrasi

Untuk menguji tugas secara profesional, kita menghindari menyambung ke Redis secara langsung pada unit test jika memungkinkan, atau kita gunakan mock library Asynq, atau dalam integrasi, testcontainer.

### Test 1: Unit Test Enqueuer/Payload Type-Safety (Cepat)
```go
package jobs_test

import (
	"encoding/json"
	"testing"
	
	"your_project/jobs" // import the package
)

func TestNewEmailDeliveryTask(t *testing.testing) {
	t.Parallel()

	userID := int64(999)
	templateID := "welcome_email"
	to := "user@example.com"

	task, err := jobs.NewEmailDeliveryTask(userID, templateID, to)
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	if task.Type() != jobs.TypeEmailDelivery {
		t.Errorf("Expected type %q, got %q", jobs.TypeEmailDelivery, task.Type())
	}

	var payload jobs.EmailDeliveryPayload
	if err := json.Unmarshal(task.Payload(), &payload); err != nil {
		t.Fatalf("Gagal unmarshal payload: %v", err)
	}

	if payload.UserID != userID || payload.ToAddress != to {
		t.Errorf("Payload mismatch. Got: %+v", payload)
	}
}
```

### Test 2: Unit Test Processor (Dependency Injection)
```go
package jobs_test

import (
	"context"
	"errors"
	"testing"

	"github.com/hibiken/asynq"
	"your_project/jobs"
)

// MockMailer adalah mock dasar untuk interface EmailService
type MockMailer struct {
	SendFunc func(ctx context.Context, to, template string, userID int64) error
}

func (m *MockMailer) Send(ctx context.Context, to, template string, userID int64) error {
	return m.SendFunc(ctx, to, template, userID)
}

func TestEmailDeliveryProcessor_Success(t *testing.T) {
	t.Parallel()

	mockMailer := &MockMailer{
		SendFunc: func(ctx context.Context, to, template string, userID int64) error {
			if to != "test@test.com" {
				t.Errorf("Unexpected to: %s", to)
			}
			return nil
		},
	}

	processor := &jobs.EmailDeliveryProcessor{Mailer: mockMailer}
	task, _ := jobs.NewEmailDeliveryTask(1, "tpl", "test@test.com")

	err := processor.ProcessTask(context.Background(), task)
	if err != nil {
		t.Errorf("Expected success, got error: %v", err)
	}
}

func TestEmailDeliveryProcessor_SkipRetryOnBadJSON(t *testing.T) {
	t.Parallel()

	processor := &jobs.EmailDeliveryProcessor{Mailer: &MockMailer{}}
	
	// Sengaja memberikan payload invalid (JSON rusak)
	task := asynq.NewTask(jobs.TypeEmailDelivery, []byte("{invalid json]"))
	
	err := processor.ProcessTask(context.Background(), task)
	
	// Harus membungkus error dengan asynq.SkipRetry
	if !errors.Is(err, asynq.SkipRetry) {
		t.Errorf("Expected asynq.SkipRetry, got %v", err)
	}
}
```

### Test 3: Integration Test Worker Setup dengan Testcontainers (Real-world)
Menguji secara keseluruhan (Client → Redis → Worker) memastikan integrasi berfungsi baik.

```go
package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	"your_project/jobs"
)

func TestEndToEndAsynqFlow(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	
	// 1. Setup Redis Container Testcontainer
	req := testcontainers.ContainerRequest{
		Image:        "redis:7-alpine",
		ExposedPorts: []string{"6379/tcp"},
		WaitingFor:   wait.ForLog("Ready to accept connections"),
	}
	redisC, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("Could not start redis: %v", err)
	}
	defer func() { _ = redisC.Terminate(ctx) }()

	host, _ := redisC.Host(ctx)
	port, _ := redisC.MappedPort(ctx, "6379")
	redisAddr := host + ":" + port.Port()

	redisConnOpt := asynq.RedisClientOpt{Addr: redisAddr}

	// 2. Setup Client & Enqueue Task
	client := asynq.NewClient(redisConnOpt)
	defer client.Close()

	task, _ := jobs.NewEmailDeliveryTask(123, "test_tpl", "test@integration.com")
	if _, err := client.Enqueue(task, asynq.Queue("default")); err != nil {
		t.Fatalf("Failed to enqueue task: %v", err)
	}

	// 3. Setup Mock Processor to track success
	doneCh := make(chan bool, 1)
	mockProc := asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
		doneCh <- true
		return nil
	})

	// 4. Start Server
	srv := asynq.NewServer(redisConnOpt, asynq.Config{
		Concurrency: 1,
		Queues:      map[string]int{"default": 1},
	})
	mux := asynq.NewServeMux()
	mux.Handle(jobs.TypeEmailDelivery, mockProc)
	
	go func() {
		if err := srv.Run(mux); err != nil {
			t.Logf("Server error: %v", err)
		}
	}()

	// 5. Assert Task Processed
	select {
	case <-time.After(5 * time.Second):
		t.Fatal("Timeout waiting for task to be processed")
	case <-doneCh:
		// Success!
		srv.Stop() // Graceful stop
	}
}
```

## Kesimpulan

Asynq menyediakan sistem *background jobs* yang *production-ready*, kokoh dengan semantik yang dipikirkan dengan cermat di atas Redis. Dengan selalu menggunakan pattern TypedTask, mengelola payload biner secara waspada, serta menaati timeout *context* internal, Anda akan menghindari >90% masalah insiden skala besar. Kunci *reliability* lainnya adalah penanganan status saat proses *crash* (via Inspector dan Opsi `ShutdownTimeout`).
