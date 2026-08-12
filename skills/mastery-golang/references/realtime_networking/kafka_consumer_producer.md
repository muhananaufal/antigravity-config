# Realtime Networking: Kafka Consumer/Producer di Go

> **Berlaku:** Go 1.21+ · `segmentio/kafka-go` / `twmb/franz-go` · **Lihat juga:** `arch_patterns/event_driven_pubsub.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md` · `distributed_patterns_resilience/idempotency_key_engine.md` · `background_jobs_worker/job_observability.md`

## 1. Konsep dan Internals

Apache Kafka adalah platform *distributed event streaming* yang didesain untuk menangani *throughput* triliunan kejadian per hari dengan latensi sangat rendah. Tidak seperti antrian pesan tradisional (seperti RabbitMQ), Kafka menggunakan model berbasis *append-only log*. Data tidak dihapus seketika setelah dibaca oleh *consumer*, melainkan dipertahankan hingga batas retensi tercapai. Hal ini memungkinkan *replayability* dan analisis data *time-travel*.

Dalam ekosistem Go, `github.com/segmentio/kafka-go` menjadi standar *de facto* library klien karena ditulis secara *native* 100% menggunakan Go tanpa ketergantungan CGO (tidak seperti `librdkafka` atau `confluent-kafka-go`). Hal ini memberikan keuntungan besar dalam kemudahan *cross-compilation*, ukuran *binary*, dan manajemen memori.

**Konsep Kritis Arsitektur Kafka:**
1.  **Consumer Groups:** Sekelompok *consumer* (biasanya *instance/pod* aplikasi Go yang sama) yang saling bekerja sama membagi beban pembacaan data dari satu *Topic*. Satu Partisi dalam *Topic* hanya bisa dibaca oleh satu *Consumer* di dalam *Group* tersebut pada satu waktu, memastikan urutan pesan tetap terjaga per Partisi.
2.  **Offset Management:** "Bookmark" yang menandakan sampai mana pesan telah dibaca. Sangat krusial untuk menggunakan **Manual Offset Commit** guna menjamin pesan tidak hilang (mencegah *data loss*).
3.  **Producer Batching & Compression:** Mengirim setiap pesan satu per satu melalui jaringan sangat boros. *Producer* modern mengumpulkan pesan ke dalam memori (*batching*) berdasarkan jumlah maksimum atau jeda waktu tertentu (Linger Time), lalu mengompresnya (misal: Snappy, LZ4) sebelum dikirim, meningkatkan *throughput* secara masif.
4.  **Dead Letter Queue (DLQ):** Pola arsitektur tahan banting (*resilient*) di mana pesan yang tidak bisa diproses secara permanen (disebut *poison pill*) akan disingkirkan ke *Topic* khusus (DLQ) agar tidak memblokir laju *consumer* memproses pesan-pesan valid berikutnya.

## 2. Diagram ASCII: Consumer Group, Fetching, dan Manual Commit

```text
               +-------------------------------------------------+
               |             Kafka Cluster (Brokers)             |
               |                                                 |
               |   Topic: "transactions"                         |
               |   +-------------+ +-------------+ +-------------+ |
               |   | Partition 0 | | Partition 1 | | Partition 2 | |
               |   +-------------+ +-------------+ +-------------+ |
               +--------|--------------|--------------|----------+
                        |              |              |
    (Fetch Messages)    |              |              |
                        V              V              V
               +-------------------------------------------------+
               |              Go Application (Consumer Group)    |
               |                                                 |
               |   +-------------+ +-------------+ +-------------+ |
               |   | Consumer 1  | | Consumer 2  | | Consumer 3  | |
               |   | (Reader)    | | (Reader)    | | (Reader)    | |
               |   +------+------+ +------+------+ +------+------+ |
               |          |               |               |        |
               |          +-------+-------+---------------+        |
               |                  | (Process Data)                 |
               |                  V                                |
               |       [ Database / External API ]                 |
               |                  |                                |
               |                  V (If Success)                   |
               |        Reader.CommitMessages(ctx)                 |
               +------------------|------------------------------+
                                  |
                                  | (Commit Offset to __consumer_offsets topic)
                                  V
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Auto-Commit pada Sistem Finansial/Reliabilitas Tinggi

Secara *default*, *consumer* Kafka sering dikonfigurasi untuk melakukan komit *offset* secara otomatis setiap selang waktu tertentu (misal: setiap 5 detik) atau secara implisit saat memanggil `ReadMessage`. 

```go
// ❌ BAD: Mengandalkan Auto-commit bawaan library atau ReadMessage
reader := kafka.NewReader(kafka.ReaderConfig{
    Brokers:   []string{"localhost:9092"},
    Topic:     "payments",
    GroupID:   "payment-processor",
    // CommitInterval: 1 * time.Second (Default behavior berbahaya)
})

for {
    // ReadMessage mengambil data DAN secara implisit memajukan offset!
    msg, err := reader.ReadMessage(ctx)
    if err != nil {
        break
    }
    
    // Jika aplikasi crash di titik ini (sebelum update DB selesai), 
    // pesan hilang selamanya! Kafka mengira kita sudah selesai memprosesnya.
    saveToDatabase(msg.Value) 
}
```
**Why dangerous:** Hilangnya data secara permanen (*Data Loss*). Jika aplikasi mengambil 1000 pesan, menyimpannya di memori, lalu Kafka melakukan auto-commit, dan sedetik kemudian aplikasi Go *crash*, ke-1000 pesan tersebut tidak akan pernah dibaca ulang ketika aplikasi menyala kembali.

```go
// ✅ GOOD: Menggunakan FetchMessage dan Manual Commit
reader := kafka.NewReader(kafka.ReaderConfig{
    Brokers:        []string{"localhost:9092"},
    Topic:          "payments",
    GroupID:        "payment-processor",
    CommitInterval: 0, // 1. Matikan Auto-Commit sepenuhnya
})

for {
    // 2. Gunakan FetchMessage (Mengambil data tanpa commit)
    msg, err := reader.FetchMessage(ctx)
    if err != nil {
        break
    }
    
    // 3. Lakukan proses bisnis dengan jaminan error handling
    if err := saveToDatabase(msg.Value); err != nil {
        // Jika gagal, log dan retry, atau kirim ke DLQ. Jangan Commit!
        continue 
    }
    
    // 4. Lakukan Manual Commit hanya SETELAH proses benar-benar sukses (At-Least-Once)
    if err := reader.CommitMessages(ctx, msg); err != nil {
        log.Printf("Failed to commit offset: %v", err)
    }
}
```

### ❌ Anti-Pattern 2: Producer Sinkron Tanpa Batasan (Unbounded Goroutines)

*Developer* sering memanggil *Producer* Kafka dari dalam *handler* HTTP tanpa konfigurasi *timeout* atau tanpa menggunakan mode *Asynchronous*.

```go
// ❌ BAD: Menulis ke Kafka dari HTTP handler tanpa perlindungan
func handleRequest(w http.ResponseWriter, r *http.Request) {
    writer := &kafka.Writer{
        Addr:  kafka.TCP("localhost:9092"),
        Topic: "clickstream",
    }
    defer writer.Close() // Membuka koneksi per request! Sangat lambat dan memakan socket.

    // WriteMessages bersifat blocking. Jika Kafka down, HTTP goroutine akan hang selamanya!
    err := writer.WriteMessages(context.Background(), kafka.Message{
        Value: []byte("click event"),
    })
    // ...
}
```
**Why dangerous:** *Resource Exhaustion*. Membuat *instance Writer* baru di setiap *request HTTP* akan menghabiskan file descriptor (socket TCP). Jika broker lambat merespons, ratusan ribu *goroutine* HTTP akan *blocked/hung*, memicu *Out of Memory* (OOM) dan meruntuhkan keseluruhan *server node*.

```go
// ✅ GOOD: Menggunakan Writer global yang long-lived dengan Context Timeout
// Diinisialisasi sekali saat aplikasi booting
var globalWriter = &kafka.Writer{
    Addr:         kafka.TCP("localhost:9092"),
    Topic:        "clickstream",
    Balancer:     &kafka.LeastBytes{},
    BatchSize:    100,                  // Batching
    BatchTimeout: 10 * time.Millisecond,
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Gunakan timeout ketat untuk menghindari goroutine hang
    ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
    defer cancel()

    err := globalWriter.WriteMessages(ctx, kafka.Message{
        Value: []byte("click event"),
    })
    if err != nil {
        http.Error(w, "Service Unavailable", 503)
        return
    }
}
```

## 4. Edge Cases & Defensive Programming

1.  **Rebalance Storms (Siklus Rebalance Tak Berujung):**
    Kafka memonitor "kesehatan" *consumer* melalui sinyal *heartbeat* dan aktivitas *fetching*. Jika `processData(msg)` memakan waktu sangat lama (misalnya 5 menit karena API lambat), Kafka Broker akan menganggap *consumer* tersebut mati (*dead*). Broker kemudian memicu *Rebalance*, mendistribusikan ulang partisi ke *consumer* lain. *Consumer* lama yang masih hidup akan membuang hasil prosesnya karena posisinya dicabut. Hal ini bisa berulang terus-menerus.
    **Mitigasi:** Pisahkan *fetch loop* dan *processing pool* (menggunakan *goroutine worker pool*). Pantau selalu konfigurasi `MaxWait` dan setel *Timeout* pemrosesan yang lebih pendek dari interval deteksi mati Kafka.
    
2.  **Poison Pills (Skema Pesan Berubah/Korup):**
    Seseorang di *upstream* merilis versi baru yang mengubah format JSON menjadi Protobuf, atau mengirim JSON cacat. Fungsi `json.Unmarshal` di Go selalu me-*return* error. *Consumer* menolak melakukan komit, dan saat `FetchMessage` dipanggil lagi, pesan yang sama dikembalikan oleh Kafka (*Infinite Retry Loop*). *Consumer lag* akan naik tak terkendali.
    **Mitigasi:** Implementasikan pengecekan batas percobaan (*max retries*). Jika pesan gagal di-*parse* lebih dari 3 kali, otomatis masukkan pesan tersebut ke *Topic Dead Letter Queue* (DLQ), dan lakukan `Commit` untuk melewatinya.
    
3.  **Network Partition (Broker Unreachable):**
    Koneksi jaringan ke *Kafka Leader* terputus sementara. Jika menggunakan *producer* asinkron murni (dimana `WriteMessages` mereturn segera tanpa error), pesan di buffer memori akan membengkak tanpa batas (*unbounded queue*) jika jaringan putus lama.
    **Mitigasi:** Set konfigurasi batas kapasitas antrian internal *producer* (seperti `BatchBytes` atau ukuran channel). Jika memori hampir habis, terapkan *backpressure* dengan memaksa `WriteMessages` mengembalikan pesan error (agar aplikasi Go bisa menolak API dari klien) alih-alih meledak karena OOM.

## 5. Production-Ready Go Code & Unit Test

Kode berikut mengilustrasikan implementasi *Consumer* yang *resilient* menggunakan *Manual Commit* dan *Dead Letter Queue* (DLQ).

```go
package kafka_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
)

// -----------------------------------------------------------------
// PRODUCTION CODE: Reliable Consumer with DLQ
// -----------------------------------------------------------------

// ProcessFunc adalah signature untuk logika bisnis pemrosesan pesan
type ProcessFunc func(ctx context.Context, data []byte) error

// ReliableConsumer membungkus kafka.Reader dengan manajemen error tingkat lanjut
type ReliableConsumer struct {
	reader *kafka.Reader
	dlq    *kafka.Writer
}

// NewReliableConsumer membuat instance consumer baru dengan auto-commit nonaktif
func NewReliableConsumer(brokers []string, topic string, groupID string, dlqTopic string) *ReliableConsumer {
	return &ReliableConsumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:        brokers,
			Topic:          topic,
			GroupID:        groupID,
			MinBytes:       10e3,             // 10KB
			MaxBytes:       10e6,             // 10MB
			CommitInterval: 0,                // KRITIKAL: Matikan auto commit
			MaxWait:        1 * time.Second,  // Heartbeat keaktifan
		}),
		dlq: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        dlqTopic,
			Balancer:     &kafka.LeastBytes{},
			RequiredAcks: kafka.RequireAll,
			Async:        false, // Sinkron ke DLQ memastikan tidak ada pesan hilang
		},
	}
}

// Close membersihkan resource
func (c *ReliableConsumer) Close() error {
	var errs []error
	if err := c.reader.Close(); err != nil {
		errs = append(errs, fmt.Errorf("reader close error: %w", err))
	}
	if err := c.dlq.Close(); err != nil {
		errs = append(errs, fmt.Errorf("dlq close error: %w", err))
	}
	if len(errs) > 0 {
		return fmt.Errorf("close errors: %v", errs)
	}
	return nil
}

// Start mulai membaca dan memproses pesan secara defensif
func (c *ReliableConsumer) Start(ctx context.Context, process ProcessFunc) error {
	for {
		// 1. FetchMessage, bukan ReadMessage (tidak memajukan offset otomatis)
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil // Graceful shutdown
			}
			// Transient error (misal: broker down sesaat), tunggu dan retry
			select {
			case <-time.After(1 * time.Second):
			case <-ctx.Done():
				return nil
			}
			continue
		}

		// 2. Eksekusi Proses Bisnis
		// Gunakan child context agar tidak memakan waktu selamanya
		processCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		processErr := process(processCtx, msg.Value)
		cancel()

		// 3. Error Handling (DLQ Routing)
		if processErr != nil {
			dlqMsg := kafka.Message{
				Key:   msg.Key,
				Value: msg.Value,
				Headers: []kafka.Header{
					{Key: "error_reason", Value: []byte(processErr.Error())},
					{Key: "original_topic", Value: []byte(msg.Topic)},
				},
			}
			
			// Kirim ke DLQ
			dlqCtx, dlqCancel := context.WithTimeout(ctx, 3*time.Second)
			dlqErr := c.dlq.WriteMessages(dlqCtx, dlqMsg)
			dlqCancel()

			if dlqErr != nil {
				// Fatal: gagal proses DAN gagal mengirim ke DLQ.
				// Jangan commit offset, biarkan Kafka mengirim ulang (retry) pada iterasi berikutnya
				continue
			}
		}

		// 4. Manual Commit (Dieksekusi jika proses SUKSES, atau berhasil masuk DLQ)
		commitCtx, commitCancel := context.WithTimeout(ctx, 2*time.Second)
		if err := c.reader.CommitMessages(commitCtx, msg); err != nil {
			commitCancel()
			// Log error, pada iterasi berikutnya pesan mungkin akan di-replay (At-Least-Once semantic)
			fmt.Printf("failed to commit message offset: %v\n", err)
			continue
		}
		commitCancel()
	}
}

// -----------------------------------------------------------------
// UNIT TEST SECTION
// -----------------------------------------------------------------

// TestReliableConsumerInitialization memastikan struct dapat dikonfigurasi
// tanpa memicu panic atau error sintaksis.
// (Pada implementasi dunia nyata, tes ini diganti menggunakan testcontainers-go
// untuk menginisialisasi instance Kafka sejati di Docker.)
func TestReliableConsumerInitialization(t *testing.T) {
	brokers := []string{"127.0.0.1:9092"}
	topic := "orders"
	dlqTopic := "orders_dlq"
	group := "order-svc-group"

	consumer := NewReliableConsumer(brokers, topic, group, dlqTopic)
	if consumer == nil {
		t.Fatal("Expected ReliableConsumer instance, got nil")
	}
	
	if consumer.reader == nil {
		t.Error("kafka.Reader should be initialized")
	}

	if consumer.dlq == nil {
		t.Error("kafka.Writer (DLQ) should be initialized")
	}

	// Jangan panggil c.Start() di sini tanpa mock broker karena akan block/error
	err := consumer.Close()
	if err != nil {
		t.Errorf("Close returned unexpected error: %v", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Auto-commit offset.** Offset ter-commit berdasarkan waktu, bukan berdasarkan selesainya pemrosesan. Pesan yang gagal diproses tetap dianggap selesai dan **hilang tanpa jejak**. Commit setelah berhasil, bukan sebelum.
- **Satu consumer group untuk beban yang berbeda.** Lag bercampur, dan Anda tidak bisa mengetahui pemrosesan mana yang tertinggal. Satu group per tujuan konsumsi.
- **Partisi lebih sedikit daripada konsumer.** Konsumer berlebih akan menganggur sepenuhnya — menambah pod tidak menambah throughput sama sekali, dan itu sering baru disadari setelah scaling yang sia-sia.
- **Produser tanpa `acks=all` untuk data yang tidak boleh hilang.** `acks=1` berarti pesan hilang bila leader gagal sebelum replikasi selesai.
- **Mengubah kunci partisi tanpa memikirkan urutan.** Urutan hanya dijamin **dalam** satu partisi. Mengubah kunci memindahkan entitas ke partisi lain, dan pesan lama serta baru bisa diproses tidak berurutan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pesan hilang setelah konsumer crash | mode commit offset | Auto-commit menandai selesai sebelum diproses |
| Menambah pod tidak menambah throughput | jumlah partisi vs konsumer | Konsumer berlebih menganggur |
| Lag tumbuh hanya di satu partisi | sebaran kunci partisi | Kunci tidak merata, atau ada pesan lambat |
| Kejadian entitas diproses tidak berurutan | apakah kunci partisi berubah | Entitas berpindah partisi |
| Pesan hilang saat broker failover | setelan `acks` | `acks=1` tidak menunggu replikasi |

```bash
# Lag per partisi -- ini metrik utama, dan harus dilihat PER PARTISI
kafka-consumer-groups --bootstrap-server "$BROKER" --describe --group pesanan

# Jumlah partisi vs jumlah konsumer aktif
kafka-topics --bootstrap-server "$BROKER" --describe --topic pesanan | head -3
kubectl get deploy consumer -o jsonpath='{.status.replicas}'

# Sebaran offset antar partisi: timpang berarti kunci tidak merata
kafka-run-class kafka.tools.GetOffsetShell --broker-list "$BROKER" --topic pesanan
```
