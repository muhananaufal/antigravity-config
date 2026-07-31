# Realtime Networking: NATS JetStream Patterns di Go

## 1. Konsep dan Internals

NATS (secara spesifik Core NATS) adalah sistem *messaging* berbasis saraf tulang belakang (*message broker*) murni yang sangat cepat dengan semantik "At-Most-Once". Core NATS beroperasi murni di memori (RAM), membuatnya mampu memproses jutaan pesan per detik, tetapi jika *subscriber* sedang tidak *online*, pesan tersebut menguap (*lost*).

**JetStream** adalah subsistem persistensi terpadu (menggantikan NATS Streaming/STAN yang usang). JetStream dibangun tepat di atas Core NATS dan menambahkan penyimpanan *disk-backed*, semantik "At-Least-Once" atau "Exactly-Once", dan *consumer offsets*. Tidak seperti Kafka yang sangat terikat pada *partition-based consumer groups*, JetStream menggunakan pendekatan berbasis *Stream* dinamis dan *Key/Value* (KV) *store* atau *Object Store* yang terintegrasi di dalam broker.

**Kunci Konseptual JetStream:**
1.  **Stream:** Penyimpanan persisten log *append-only*. Sebuah *stream* bisa "menangkap" (*bind*) banyak subjek (contoh: *stream* "ORDERS" menangkap pesan dari subjek `orders.us.>` dan `orders.eu.>`).
2.  **Consumer:** Kursor dinamis (mirip *offset* di Kafka) yang bisa berbentuk *Push-based* (Broker memaksa data ke *client* secepat mungkin) atau *Pull-based* (*Client* meminta *batch* data, memegang kontrol laju konsumsi).
3.  **WorkQueue vs Interest:**
    *   *WorkQueue Stream*: Begitu 1 consumer di dalam group berhasil memproses (mengirim *Ack*), pesan dihapus dari stream (seperti RabbitMQ).
    *   *Interest Stream*: Pesan dipertahankan selama masih ada *consumer* yang belum membacanya. Begitu semua *consumer* membacanya, ia dibuang.

## 2. Diagram ASCII: JetStream Pub/Sub Architecture

```text
       [ Producer 1 ]                       [ Producer 2 ]
       conn.Publish("orders.us.123")        conn.Publish("orders.eu.999")
            |                                      |
            V                                      V
+-----------------------------------------------------------------+
|                         NATS Server                             |
|                                                                 |
|   [ Core NATS Routing ]  ---> (Routes based on subject match)   |
|            |                                                    |
|            V                                                    |
|   [ JetStream Engine ]                                          |
|                                                                 |
|      Stream: "ORDERS" (Subjects: "orders.>")                    |
|      +-------------------------------------------------------+  |
|      | 1: [us.123] | 2: [eu.999] | 3: [...] (Saved on Disk)  |  |
|      +-------------------------------------------------------+  |
|               |                             |                   |
|               V                             V                   |
|      Consumer: "EU-Processor"        Consumer: "AuditLog"       |
|      (Filter: "orders.eu.>")         (Filter: "orders.>")       |
+---------------|-----------------------------|-------------------+
                |                             |
                V (Push/Pull delivery)        V
       [ EU Microservice ]              [ Data Warehouse ]
       (Ack explicit required)          (Ack explicit required)
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Push Consumer untuk Beban Fluktuatif (Spiky Workloads)

NATS JetStream secara *default* sangat cepat dan mendorong (Push) pesan dari broker ke memori klien (Go) melalui *channel* internal. Jika *handler* bisnis Anda lambat (contoh: menulis ke *database* SQL), pesan akan menumpuk di dalam memori Go aplikasi Anda.

```go
// ❌ BAD: Menggunakan Push Consumer (Subscribe) untuk tugas berat
// NATS akan membombardir aplikasi dengan ribuan pesan tanpa henti.
js.Subscribe("orders.>", func(m *nats.Msg) {
    db.Exec("INSERT ...") // Lambat (misal 50ms per query)
    m.Ack()
}, nats.Durable("worker-group"))
```
**Why dangerous:** *Slow Consumer / Out of Memory*. Memori aplikasi Go akan menggelembung (*bloat*) karena ia terus menerima paket jaringan lebih cepat daripada memprosesnya. Pada akhirnya NATS broker memutus klien dengan pesan `Slow Consumer Detected`.

```go
// ✅ GOOD: Menggunakan Pull Consumer untuk mengatur laju (Backpressure)
sub, _ := js.PullSubscribe("orders.>", "worker-group")
for {
    // Tarik maksimal 10 pesan saja, lalu proses. Klien mengontrol laju.
    msgs, err := sub.Fetch(10, nats.MaxWait(1*time.Second))
    for _, m := range msgs {
        db.Exec("INSERT ...")
        m.Ack()
    }
}
```

### ❌ Anti-Pattern 2: Asumsi `Publish` di JetStream Bersifat Sinkron Tanpa Context

Saat kita mem- *publish* data ke Core NATS, sifatnya *fire-and-forget* murni. Pada JetStream, fungsi `js.Publish` bersifat *blocking* (menunggu balasan/ *Ack* dari broker bahwa pesan sudah ditulis ke disk).

```go
// ❌ BAD: Publish berantai dalam request loop tanpa Timeout
for _, item := range dataList {
    // Jika koneksi NATS lambat, goroutine web request ini block selamanya!
    js.Publish("logs", []byte(item)) 
}
```
**Why dangerous:** Aplikasi HTTP atau gRPC Anda akan macet total (*thread starvation*) jika *disk* di server NATS tiba-tiba penuh atau jaringan melambat, karena tidak ada proteksi *timeout* di sisi *publisher*.

```go
// ✅ GOOD: PublishAsync (Batching) atau Publish dengan Context/Timeout
ackCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
defer cancel()

for _, item := range dataList {
    _, err := js.PublishMsg(&nats.Msg{
        Subject: "logs",
        Data:    []byte(item),
    }, nats.Context(ackCtx)) 
    // Tangani error timeout...
}
```

## 4. Edge Cases & Defensive Programming

1.  **AckPolicy & MaxDeliveries (Poison Pill):**
    Jika *consumer* menerima pesan cacat (JSON *malformed*) dan Anda me- *return* error tanpa memanggil `m.Ack()`, JetStream akan me-*redeliver* (mengirim ulang) pesan tersebut selamanya sesuai timeout `AckWait` (standarnya 30 detik). Untuk mencegah pesan ini terus-menerus memblokir saluran (*infinite loop*), set `MaxDeliveries` (misal 5). Saat mencapai 5x redelivery, panggil `m.Term()` untuk memberi tahu broker agar membuang pesan ini selamanya, atau kirim secara manual ke *Subject* DLQ (Dead Letter Queue).
2.  **Concurrency dan Naked Acks:**
    Seringkali *developer* melemparkan pemrosesan pesan ke goroutine latar, dan segera me-*return* dari fungsi handler *Push Consumer*. NATS akan berpikir pesannya sudah tidak ditangani dan bisa jadi otomatis me-*redeliver* jika fungsi tersebut tidak memiliki *Ack*. Selalu gunakan pola sinkron atau *Pull Consumer* jika melibatkan *goroutine pool*.
3.  **Exactly-Once Publish (Message Deduplication):**
    Di jaringan tidak stabil, `js.Publish` mungkin *timeout* meskipun broker sebenarnya berhasil menulis ke disk. Jika *publisher* (Aplikasi Go) melakukan *retry* paksa, pesan menjadi ganda (duplikat). Gunakan *header* deduplikasi bawaan NATS: `Nats-Msg-Id`. Broker memiliki jendela memori untuk mengecek ID ini dan otomatis membuang kiriman ulang yang duplikat, memastikan *Exactly-Once semantics*.

## 5. Production-Ready Go Code & Unit Test

Kode berikut menunjukkan implementasi tangguh *Pull Consumer* JetStream yang menggunakan *MaxDeliveries* untuk menangani *Poison Pills* dan melindungi memori via *backpressure*.

```go
package jetstreamman

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// ProcessFunc adalah handler logika bisnis
type ProcessFunc func(ctx context.Context, payload []byte) error

// PullWorker mengekstrak dan memproses data dari JetStream
type PullWorker struct {
	nc       *nats.Conn
	js       nats.JetStreamContext
	stream   string
	subject  string
	consumer string
}

func NewPullWorker(nc *nats.Conn, stream, subject, consumer string) (*PullWorker, error) {
	js, err := nc.JetStream()
	if err != nil {
		return nil, err
	}

	// Idempotent Stream Creation (Opsional, asumsikan Stream terbuat via Terraform/Admin)
	// Tapi defensifnya, kita tambahkan stream/consumer di kode:
	_, err = js.AddStream(&nats.StreamConfig{
		Name:     stream,
		Subjects: []string{subject},
		Storage:  nats.FileStorage,
	})
	if err != nil && err != nats.ErrStreamNameAlreadyInUse {
		// Logika init stream
	}

	// Buat Pull Consumer dengan AckExplicit dan MaxDeliveries = 3
	_, err = js.AddConsumer(stream, &nats.ConsumerConfig{
		Durable:       consumer,
		AckPolicy:     nats.AckExplicitPolicy,
		MaxDeliveries: 3,                 // Batas percobaan ulang
		FilterSubject: subject,
	})

	return &PullWorker{
		nc:       nc,
		js:       js,
		stream:   stream,
		subject:  subject,
		consumer: consumer,
	}, nil
}

// Start mengonsumsi pesan menggunakan mekanisme Pull
func (w *PullWorker) Start(ctx context.Context, handler ProcessFunc) error {
	sub, err := w.js.PullSubscribe(w.subject, w.consumer)
	if err != nil {
		return fmt.Errorf("failed to pull subscribe: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
			// Tarik 10 pesan sekaligus, timeout 2 detik jika kosong (Long Polling)
			msgs, err := sub.Fetch(10, nats.MaxWait(2*time.Second))
			if err != nil {
				if err == nats.ErrTimeout {
					continue // Kosong, lanjut polling
				}
				// Log error lainnya, dan backoff
				time.Sleep(1 * time.Second)
				continue
			}

			for _, msg := range msgs {
				// Proses pesan dengan context timeout lokal
				procCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				
				meta, _ := msg.Metadata()
				if meta.NumDelivered >= 3 {
					// POISON PILL DETECTED!
					// Sudah 3 kali dicoba dan gagal. Terminate pesan dari broker.
					msg.Term()
					// Opsional: Publish msg.Data ke subject DLQ di sini
					cancel()
					continue
				}

				if err := handler(procCtx, msg.Data); err != nil {
					// GAGAL: Jangan panggil Ack(). Biarkan NATS me-redeliver (Nack bisa mempercepat)
					msg.Nak()
				} else {
					// SUKSES
					msg.Ack()
				}
				cancel()
			}
		}
	}
}

// -------------------------------------------------------------------------
// Unit Test / Mocks
// -------------------------------------------------------------------------

// Tes ini menggunakan Embedded NATS server untuk tes realistis tanpa testcontainers!
import "github.com/nats-io/nats-server/v2/server"

func runEmbeddedServer(t *testing.T) *server.Server {
	opts := &server.Options{
		Port:       -1, // Port acak
		JetStream:  true,
		StoreDir:   t.TempDir(),
	}
	s, err := server.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go s.Start()
	if !s.ReadyForConnections(5 * time.Second) {
		t.Fatal("Embedded NATS tidak siap")
	}
	return s
}

func TestJetStreamPullWorker(t *testing.T) {
	// 1. Setup Embedded NATS
	s := runEmbeddedServer(t)
	defer s.Shutdown()

	clientUrl := s.ClientURL()
	nc, err := nats.Connect(clientUrl)
	if err != nil {
		t.Fatalf("Gagal konek: %v", err)
	}
	defer nc.Close()

	// 2. Inisialisasi Worker
	worker, err := NewPullWorker(nc, "ORDERS_STREAM", "orders.>", "order_processor")
	if err != nil {
		t.Fatalf("Gagal init worker: %v", err)
	}

	// 3. Publish Dummy Data
	js, _ := nc.JetStream()
	
	// Data Valid
	js.Publish("orders.id", []byte(`{"id": 1, "status": "ok"}`))
	
	// Data Cacat (Poison Pill)
	js.Publish("orders.id", []byte(`CORRUPTED_JSON`))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var processedCount int

	// 4. Proses Logika
	go worker.Start(ctx, func(c context.Context, payload []byte) error {
		// Validasi JSON
		var dat map[string]interface{}
		if err := json.Unmarshal(payload, &dat); err != nil {
			return err // Akan memicu Nak() dan oredelivery
		}
		processedCount++
		return nil
	})

	// Beri waktu pesan diproses, gagal, dan redeliver sampai di-Term
	time.Sleep(1 * time.Second)

	// Harusnya cuma data Valid yang berhasil
	if processedCount != 1 {
		t.Errorf("Ekspektasi proses 1x sukses, dapet %d", processedCount)
	}
}
```
