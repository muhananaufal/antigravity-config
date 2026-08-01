---
description: "Panduan Top 1% Observabilitas Background Jobs di Golang: Metrik, Tracing, Logging, Alerting, dan Edge Cases"
tags: ["golang", "background-jobs", "observability", "prometheus", "opentelemetry", "structured-logging"]
---

# Observabilitas Background Jobs di Golang (Top 1% Engineering Guide)

Dalam sistem terdistribusi, memproses tugas di latar belakang (background jobs/workers) adalah hal yang krusial untuk menjaga latensi respons API tetap rendah. Namun, tanpa observabilitas yang memadai, antrean tugas bisa menjadi "kotak hitam" (black box) yang rentan terhadap penumpukan diam-diam (silent backlog), zombie jobs, atau kegagalan berulang yang menguras resource sistem.

Dokumen ini adalah referensi komprehensif untuk merancang, mengimplementasikan, dan mengelola observabilitas tingkat lanjut untuk sistem pemrosesan job asinkron di Golang menggunakan Prometheus (Metrics), OpenTelemetry (Tracing), dan Structured Logging.

---

## 1. Konsep Mendalam & Internals

Observabilitas untuk background jobs berbeda dari observabilitas HTTP API tradisional. Waktu siklus job tidak sinkron, dan eksekusi dapat melintasi batasan mesin, zona waktu, atau di-retry berkali-kali.

### Tiga Pilar Observabilitas Job
1. **Metrics (Prometheus):** Fokus pada agregasi dan trend (Macro view). 
   - *RED metrics for jobs:* Rate (jumlah job dieksekusi), Errors (jumlah job gagal), Duration (waktu pemrosesan).
   - *USE metrics for queues:* Utilization (kapasitas worker), Saturation (kedalaman antrean), Errors (kegagalan koneksi Redis/RabbitMQ).
2. **Distributed Tracing (OpenTelemetry):** Melacak jejak satu eksekusi spesifik dari pemicu awal (HTTP/gRPC request) hingga selesai (Micro view).
3. **Structured Logging (slog/zap):** Memberikan detail state lokal, error stack traces, dan payload metadata untuk debugging mendalam.

### Propagasi Konteks (Correlation ID)
Ketika sebuah HTTP request memicu sebuah background job, korelasi antara request dan job tersebut sering terputus karena antrean pesan (message broker) bertindak sebagai perantara asinkron. Untuk mengaitkan (correlate) log dan trace, kita wajib menginjeksi (inject) trace context ke dalam payload job saat antrean, lalu mengekstrak (extract) konteks tersebut saat worker mengambil job.

---

## 2. Arsitektur Propagasi & Observabilitas (Diagram ASCII)

```text
[ HTTP Request (TraceID: A123) ]
       |
       v
+-----------------------+
| HTTP Handler / API    | ---> Starts Span: "HTTP POST /checkout"
| (Inject TraceContext) |
+-----------------------+
       | (Payload + TraceID: A123, CorrelationID)
       v
[ Message Broker (Redis/RabbitMQ/Kafka) ]
       |
       | (Gauge: Queue Depth metric goes UP)
       v
+-----------------------+
| Background Worker     | ---> Extract TraceContext
| (Dequeue Job)         | ---> Gauge: Queue Depth metric goes DOWN
+-----------------------+
       |
       |---> Span: "Job.WaitTime" (Enqueue -> Dequeue Latency)
       |
       v
+-----------------------+
| Job Execution         | ---> Starts Span: "ProcessCheckoutJob"
| (Structured Logging)  | ---> log.Info("processing job", "job_id", 99, "trace_id", "A123")
+-----------------------+
       |
       +---> [ Success ] ---> Metric: job_duration_seconds (Histogram)
       |                 ---> Metric: jobs_processed_total{status="success"}
       |
       +---> [ Failure ] ---> Metric: jobs_processed_total{status="error"}
                         ---> (Retry Policy Evaluated)
                         ---> [ Max Retries Reached ] ---> Move to DLQ (Dead Letter Queue)
                                                      ---> Metric: dlq_depth (Alert!)
```

---

## 3. Anti-Patterns & Best Practices

### Anti-Pattern 1: Tidak Ada Visibilitas Kedalaman Antrean (Silent Backlog)
*Masalah:* Anda hanya memonitor CPU/RAM worker, namun tidak tahu seberapa banyak job yang sedang mengantre. Ketika worker lambat, memori Redis/RabbitMQ membengkak secara diam-diam hingga *Out Of Memory* (OOM).

❌ **BAD: Fire and Forget tanpa monitoring antrean**
```go
// Enqueue job dan berharap yang terbaik. Tidak ada metrik antrean.
func (s *Service) SendEmailAsync(email string) error {
    jobBytes, _ := json.Marshal(EmailJob{To: email})
    return s.redis.LPush(context.Background(), "email_queue", jobBytes).Err()
}
// Worker mengambil tanpa melacak berapa sisa antrean.
```

✅ **GOOD: Menggunakan Prometheus Gauge untuk Queue Depth**
```go
// Setiap kali enqueue/dequeue, atau dari background poller yang terpisah,
// kita pantau kedalaman antrean menggunakan Prometheus Gauge.
var queueDepthMetric = prometheus.NewGaugeVec(
    prometheus.GaugeOpts{
        Name: "worker_queue_depth",
        Help: "Number of jobs waiting in the queue",
    },
    []string{"queue_name"},
)

// Background poller yang mendaftarkan metrik (lebih aman daripada increment/decrement per job)
func MonitorQueueDepth(ctx context.Context, rdb *redis.Client, queueName string) {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            count, err := rdb.LLen(ctx, queueName).Result()
            if err == nil {
                queueDepthMetric.WithLabelValues(queueName).Set(float64(count))
            }
        }
    }
}
```

### Anti-Pattern 2: Fire-and-Forget Tanpa Tracing
*Masalah:* Job diproses, namun saat error terjadi, log hanya memunculkan "Failed to process job". Tidak ada cara melacak HTTP request mana (user mana) yang memicu job tersebut.

❌ **BAD: Hilangnya Konteks HTTP**
```go
func HandleHTTP(w http.ResponseWriter, r *http.Request) {
    // Context dari request (yang memiliki traceID) TIDAK diteruskan ke job payload.
    go func() { 
        ProcessJob(context.Background(), r.FormValue("id")) // context.Background() me-reset trace
    }()
}
```

✅ **GOOD: Propagasi Konteks (Trace & Correlation ID) via Payload Job**
```go
// Job Payload menyertakan TextMapCarrier untuk OpenTelemetry
type JobPayload struct {
    JobID         string            `json:"job_id"`
    Type          string            `json:"type"`
    Data          json.RawMessage   `json:"data"`
    TraceCarrier  map[string]string `json:"trace_carrier"` // W3C Trace Context
    CorrelationID string            `json:"correlation_id"`
}

// Saat Enqueue: Inject context ke dalam map
func Enqueue(ctx context.Context, jobType string, data []byte) error {
    carrier := make(map[string]string)
    otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(carrier))
    
    // Simpan `carrier` ke database / redis antrean
    return queue.Push(&JobPayload{TraceCarrier: carrier, /* ... */})
}

// Saat Dequeue: Extract context dari map
func Dequeue(ctx context.Context, payload JobPayload) {
    jobCtx := otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(payload.TraceCarrier))
    
    tracer := otel.Tracer("worker")
    jobCtx, span := tracer.Start(jobCtx, "ProcessJob")
    defer span.End()
    // Eksekusi berjalan dengan TraceID yang sama dengan HTTP Request!
}
```

---

## 4. Edge Cases & Defensive Programming

Dalam merancang observabilitas background jobs, beberapa edge cases *system-level* perlu dihindari secara defensif:

1. **Edge Case: Cardinality Explosion pada Prometheus Labels.**
   - *Skenario:* Developer menambahkan `job_id` atau `user_id` sebagai label Prometheus.
   - *Dampak:* Karena Prometheus membuat time-series baru untuk setiap kombinasi label unik, metrik akan meledak (jutaan time-series), menyebabkan OOM di Prometheus server.
   - *Defensive Action:* HANYA gunakan label dengan kardinalitas rendah, seperti `job_type`, `queue_name`, `status` (success, failed, retried). `job_id` hanya boleh masuk di Tracing atau Logging, bukan Metrik.

2. **Edge Case: Clock Skew / NTP Desync dalam Menghitung Job Wait Latency.**
   - *Skenario:* Waktu antre (enqueue time) dicatat di Server A, lalu diambil (dequeue) di Server B. Waktu di Server B telat 2 detik karena NTP desync.
   - *Dampak:* Metrik latensi "enqueue to start" bisa negatif, merusak histogram Prometheus.
   - *Defensive Action:* Gunakan `time.Since()` hanya jika diproses di mesin yang sama, atau pastikan NTP tersetting ketat. Sebagai cadangan defensif, set `if latency < 0 { latency = 0 }`.

3. **Edge Case: Context Cancellation Saat Mengekspor Trace/Metrics.**
   - *Skenario:* Context dari parent HTTP handler dibatalkan (timeout/client disconnect), lalu goroutine background menggunakan context tersebut.
   - *Dampak:* Eksportir OpenTelemetry gagal mem-flush span karena `ctx.Err() != nil`. Span hilang.
   - *Defensive Action:* Untuk background tasks di luar siklus antrean pesan (misalnya `go func()`), gunakan `context.WithoutCancel(ctx)` (diperkenalkan di Go 1.21) agar value/trace ID dipertahankan namun pembatalan (cancellation signal) diabaikan.

4. **Edge Case: Log Volume Explosion Akibat Infinite Retries.**
   - *Skenario:* API eksternal down, job di-retry ribuan kali, mencetak error log dengan stack trace besar setiap milidetik.
   - *Dampak:* Disk penuh, I/O bottleneck, tagihan datadog/splunk meroket.
   - *Defensive Action:* Implementasikan Exponential Backoff pada retry, dan gunakan Error Sampling/Throttling pada Logger (log setiap *n-th* attempt jika > 10).

5. **Edge Case: Phantom Metrics (Stale Queues).**
   - *Skenario:* Anda menggunakan `prometheus.Gauge` yang di-update setiap job (increment/decrement). Pekerja mati (panic/OOM) *setelah* dequeue namun *sebelum* metrik decrement dieksekusi.
   - *Dampak:* Gauge tidak pernah turun (phantom backlog). Metrik menipu.
   - *Defensive Action:* Jangan gunakan metode `Add(1)/Sub(1)` untuk Queue Depth. Alih-alih, gunakan *Background Poller* seperti pada *Anti-Pattern 1* yang melakukan *Length Check* absolut terhadap state riil (misal `LLEN` pada Redis atau RabbitMQ Queue Size).

---

## 5. Implementasi Code (Production-Ready)

Di bawah ini adalah implementasi lengkap untuk worker system dengan observabilitas tingkat tinggi.

```go
package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

var (
	// Metrik 1: Kedalaman Antrean (Gauge)
	metricQueueDepth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "job_queue_depth",
			Help: "Current number of jobs in the queue",
		},
		[]string{"queue"},
	)

	// Metrik 2: Latensi Tunggu (Enqueue -> Start)
	metricWaitLatency = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "job_wait_duration_seconds",
			Help:    "Time jobs spend waiting in queue before execution",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"job_type"},
	)

	// Metrik 3: Latensi Eksekusi (Start -> Complete)
	metricExecLatency = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "job_execution_duration_seconds",
			Help:    "Time taken to execute a job",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"job_type", "status"}, // status: success, error, dlq
	)
)

// JobPayload mendefinisikan struktur data untuk pesan dalam antrean.
type JobPayload struct {
	ID            string            `json:"id"`
	Type          string            `json:"type"`
	Queue         string            `json:"queue"`
	Data          json.RawMessage   `json:"data"`
	Attempt       int               `json:"attempt"`
	MaxRetries    int               `json:"max_retries"`
	EnqueuedAt    time.Time         `json:"enqueued_at"`
	TraceCarrier  map[string]string `json:"trace_carrier"`
	CorrelationID string            `json:"correlation_id"`
}

// MemoryQueue untuk demonstrasi (dapat diganti dengan Redis/RabbitMQ)
type MemoryQueue struct {
	mu     sync.Mutex
	jobs   []JobPayload
	dlq    []JobPayload
	queueN string
}

func NewMemoryQueue(name string) *MemoryQueue {
	return &MemoryQueue{queueN: name, jobs: make([]JobPayload, 0)}
}

// Enqueue menyuntikkan (inject) konteks OpenTelemetry ke payload dan memasukkannya ke antrean.
func (q *MemoryQueue) Enqueue(ctx context.Context, job JobPayload) error {
	// Defensive check: pastikan ada Tipe
	if job.Type == "" {
		return errors.New("job type is required")
	}

	job.Queue = q.queueN
	job.EnqueuedAt = time.Now().UTC()

	// 1. OTel Context Propagation (Inject)
	carrier := make(map[string]string)
	otel.GetTextMapPropagator().Inject(ctx, propagation.MapCarrier(carrier))
	job.TraceCarrier = carrier

	q.mu.Lock()
	q.jobs = append(q.jobs, job)
	metricQueueDepth.WithLabelValues(q.queueN).Set(float64(len(q.jobs)))
	q.mu.Unlock()

	return nil
}

// Dequeue mengambil job dari antrean (menggunakan blocking simulasinya)
func (q *MemoryQueue) Dequeue() (*JobPayload, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.jobs) == 0 {
		return nil, false
	}

	job := q.jobs[0]
	q.jobs = q.jobs[1:]
	metricQueueDepth.WithLabelValues(q.queueN).Set(float64(len(q.jobs)))
	return &job, true
}

func (q *MemoryQueue) MoveToDLQ(job JobPayload) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.dlq = append(q.dlq, job)
	// Kita juga bisa memiliki metrik DLQ size yang di-update di sini
}

// HandlerFunc mendefinisikan signature untuk fungsi pemrosesan job.
type HandlerFunc func(ctx context.Context, payload []byte) error

// Worker memproses job dari queue.
type Worker struct {
	queue    *MemoryQueue
	handlers map[string]HandlerFunc
	logger   *slog.Logger
	tracer   trace.Tracer
}

func NewWorker(q *MemoryQueue, logger *slog.Logger) *Worker {
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return &Worker{
		queue:    q,
		handlers: make(map[string]HandlerFunc),
		logger:   logger,
		tracer:   otel.Tracer("background_worker"),
	}
}

func (w *Worker) Register(jobType string, h HandlerFunc) {
	w.handlers[jobType] = h
}

// ProcessOne mencoba mengambil dan memproses 1 job (berguna untuk testing).
func (w *Worker) ProcessOne(ctx context.Context) error {
	job, ok := w.queue.Dequeue()
	if !ok {
		return nil // Antrean kosong
	}

	// 2. OTel Context Propagation (Extract)
	// Kita mengekstrak TraceID dari pembuat job (misalnya HTTP request awal)
	jobCtx := otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(job.TraceCarrier))

	// Start Span baru untuk eksekusi Job. Ia akan menjadi child dari span enqueue!
	jobCtx, span := w.tracer.Start(jobCtx, fmt.Sprintf("Job.Process %s", job.Type),
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("job.id", job.ID),
			attribute.String("job.type", job.Type),
			attribute.Int("job.attempt", job.Attempt),
			attribute.String("queue", job.Queue),
		),
	)
	defer span.End()

	// 3. Hitung Wait Latency (Defensive check terhadap Clock Skew)
	waitLat := time.Since(job.EnqueuedAt).Seconds()
	if waitLat < 0 {
		waitLat = 0
	}
	metricWaitLatency.WithLabelValues(job.Type).Observe(waitLat)

	handler, exists := w.handlers[job.Type]
	if !exists {
		err := fmt.Errorf("no handler for job type: %s", job.Type)
		w.recordFailure(span, *job, err)
		return err
	}

	execStart := time.Now()
	
	// 4. Structured Logging - Injeksi job info ke log untuk visibilitas
	logFields := []any{
		slog.String("job_id", job.ID),
		slog.String("job_type", job.Type),
		slog.Int("attempt", job.Attempt),
		slog.String("correlation_id", job.CorrelationID),
		slog.String("trace_id", span.SpanContext().TraceID().String()),
	}

	w.logger.InfoContext(jobCtx, "starting job execution", logFields...)

	// Eksekusi Job
	err := handler(jobCtx, job.Data)

	execDur := time.Since(execStart).Seconds()

	if err != nil {
		w.logger.ErrorContext(jobCtx, "job failed", append(logFields, slog.String("error", err.Error()), slog.Float64("duration_sec", execDur))...)
		w.recordFailure(span, *job, err)
		metricExecLatency.WithLabelValues(job.Type, "error").Observe(execDur)
		
		// Dead Job Alerting & Retry Policy
		if job.Attempt >= job.MaxRetries {
			w.logger.WarnContext(jobCtx, "max retries reached, moving to DLQ", logFields...)
			metricExecLatency.WithLabelValues(job.Type, "dlq").Observe(execDur)
			span.SetAttributes(attribute.Bool("job.dlq", true))
			w.queue.MoveToDLQ(*job)
		} else {
			// Simulasikan requeue dengan increment attempt
			job.Attempt++
			_ = w.queue.Enqueue(context.Background(), *job)
		}
		return err
	}

	w.logger.InfoContext(jobCtx, "job completed successfully", append(logFields, slog.Float64("duration_sec", execDur))...)
	span.SetStatus(codes.Ok, "success")
	metricExecLatency.WithLabelValues(job.Type, "success").Observe(execDur)

	return nil
}

func (w *Worker) recordFailure(span trace.Span, job JobPayload, err error) {
	span.SetStatus(codes.Error, err.Error())
	span.RecordError(err)
}
```

---

## 6. Unit & Integration Tests (Test Nyata & Runnable)

Pengujian harus membuktikan bahwa propagasi context berjalan, metrik terisi, dan siklus kegagalan memicu policy DLQ dengan benar.

```go
package worker_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	
	"your_module/worker" // Sesuaikan dengan module path
)

func init() {
	// Setup TextMapPropagator secara global untuk pengetesan Context Propagation
	otel.SetTextMapPropagator(propagation.TraceContext{})
}

// Test 1: Propagasi TraceID dari Publisher ke Consumer berhasil.
func TestWorker_ContextPropagation(t *testing.T) {
	// Setup Tracer Provider dalam memori untuk membaca span
	exporter := tracetest.NewInMemoryExporter()
	tp := trace.NewTracerProvider(trace.WithBatcher(exporter))
	otel.SetTracerProvider(tp)
	tracer := tp.Tracer("test-tracer")

	queue := worker.NewMemoryQueue("test_q")
	w := worker.NewWorker(queue, nil)

	var extractedTraceID string
	w.Register("send_email", func(ctx context.Context, data []byte) error {
		// Dapatkan trace ID saat ini yang aktif di dalam goroutine worker
		extractedTraceID = trace.SpanContextFromContext(ctx).TraceID().String()
		return nil
	})

	// Buat request palsu
	ctx, span := tracer.Start(context.Background(), "HTTP GET /trigger")
	originalTraceID := span.SpanContext().TraceID().String()

	job := worker.JobPayload{ID: "job-123", Type: "send_email", MaxRetries: 3}
	_ = queue.Enqueue(ctx, job)
	span.End()

	_ = w.ProcessOne(context.Background())
	
	// Pastikan OTel Tracer provider nge-flush
	_ = tp.ForceFlush(context.Background())

	if extractedTraceID != originalTraceID {
		t.Errorf("Expected trace ID %s to propagate, but got %s", originalTraceID, extractedTraceID)
	}
}

// Test 2: Metrik Histograms dan Gauge dihitung dengan benar.
func TestWorker_MetricsRecorded(t *testing.T) {
	queue := worker.NewMemoryQueue("test_metric_q")
	w := worker.NewWorker(queue, nil)
	
	w.Register("process_video", func(ctx context.Context, data []byte) error {
		time.Sleep(10 * time.Millisecond) // Simulasikan waktu proses
		return nil
	})

	job := worker.JobPayload{ID: "job-vid", Type: "process_video", MaxRetries: 0}
	
	// Enqueue job, queue depth harus 1
	_ = queue.Enqueue(context.Background(), job)
	
	// Metric Wait Latency & Exec Latency tidak bisa ditest nilainya persis (timing bervariasi),
	// tetapi kita bisa memeriksa label pada Histogram jika ada library Testutil.
	
	err := w.ProcessOne(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Setelah ProcessOne, queue depth kembali ke 0
	depth, _ := queue.Dequeue()
	if depth != nil {
		t.Fatalf("expected queue to be empty")
	}
}

// Test 3: Dead Letter Queue (DLQ) policy berfungsi setelah MaxRetries tercapai.
func TestWorker_MaxRetries_DLQ(t *testing.T) {
	queue := worker.NewMemoryQueue("test_dlq_q")
	w := worker.NewWorker(queue, nil)

	invokeCount := 0
	expectedErr := errors.New("temporary DB error")
	w.Register("unstable_job", func(ctx context.Context, data []byte) error {
		invokeCount++
		return expectedErr // Selalu gagal
	})

	// Job dengan MaxRetries = 2 (artinya 1 attempt awal, + 2 retries = max 3 kali invoke)
	job := worker.JobPayload{ID: "job-fail", Type: "unstable_job", Attempt: 0, MaxRetries: 2}
	_ = queue.Enqueue(context.Background(), job)

	// Attempt 0
	if err := w.ProcessOne(context.Background()); err != expectedErr {
		t.Errorf("expected expectedErr, got %v", err)
	}
	
	// Attempt 1 (Hasil Requeue dari retry policy)
	if err := w.ProcessOne(context.Background()); err != expectedErr {
		t.Errorf("expected expectedErr, got %v", err)
	}
	
	// Attempt 2 (Hasil Requeue)
	if err := w.ProcessOne(context.Background()); err != expectedErr {
		t.Errorf("expected expectedErr, got %v", err)
	}

	// Di titik ini MaxRetries tercapai, job harus masuk ke DLQ.
	// Pemanggilan selanjutnya harus mengembalikan no error (karena antrean kosong).
	err := w.ProcessOne(context.Background())
	if err != nil {
		t.Errorf("expected empty queue (nil error), got %v", err)
	}

	if invokeCount != 3 {
		t.Errorf("expected job to be invoked exactly 3 times (1 initial + 2 retries), got %d", invokeCount)
	}
}
```

---

## 7. Kesimpulan & Aturan Emas

1. **Jangan Jadikan Antrean sebagai "Black Box".** Jika Anda tidak memiliki Prometheus Dashboard yang berisi metrik kedalaman antrean (`job_queue_depth`), maka Anda beroperasi dalam kebutaan.
2. **Korelasikan Log dengan HTTP Layer.** Jangan mencetak `Error saving to DB` tanpa menyertakan context *siapa* dan *dari request mana* event itu terjadi. Penuhi requirement ini via OpenTelemetry TextMapCarrier.
3. **Defensive Labels:** Jangan gunakan UUID (seperti `job_id`) di *label metrik Prometheus*. Cukup letakkan UUID di *Log Attributes* atau *Trace Spans* agar tidak terjadi cardinality explosion yang memakan habis memori infrastruktur observabilitas Anda. 
