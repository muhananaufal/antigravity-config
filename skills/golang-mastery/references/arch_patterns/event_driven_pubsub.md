# Event-Driven Architecture & Pub/Sub di Go

> **Berlaku:** Go 1.21+ · Kafka / NATS JetStream · **Lihat juga:** `distributed_patterns_resilience/outbox_pattern_transactional.md` · `arch_patterns/modular_monolith_go.md` · `background_jobs_worker/asynq_redis_jobs.md` · `microservices_grpc/webhook_delivery_engine.md`

## Konsep Utama dan Internal

Arsitektur Event-Driven memecah monolitisitas operasional dengan membuat komponen-komponen sistem bereaksi terhadap *events* (kejadian historis) secara asinkron alih-alih saling memanggil secara sinkron via RPC atau HTTP. 

Dalam arsitektur *Publish/Subscribe (Pub/Sub)*:
- **Publisher** memancarkan pesan ke topik tertentu tanpa memedulikan siapa yang mendengarkan.
- **Subscriber (Consumer)** mendaftarkan dirinya untuk mendengarkan topik tersebut dan memproses pesannya.

Di ekosistem Go, framework seperti `ThreeDotsLabs/watermill` memberikan abstraksi tingkat tinggi. Anda bisa mengembangkan fitur di lokal menggunakan *In-Memory Go Channels* atau SQL PubSub, lalu saat meluncur ke *production*, Anda hanya mengganti driver (adapter) ke Kafka, RabbitMQ, atau Google Cloud PubSub **tanpa merubah sebaris pun kode logika aplikasi**. Pola ini mendemokratisasi event-driven dan membuat *unit test* menjadi instan.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

Diagram di bawah menggambarkan arsitektur tangguh di mana Publisher TIDAK BUKAN mem-publish langsung ke Broker dari memori, melainkan melewatinya melalui tabel database tunggal (*Transactional Outbox Pattern*) agar tidak terjadi inkonsistensi (*split-brain*).

```text
 +-------------------------------------------------------------------------+
 |                            User Service (Publisher)                     |
 |                                                                         |
 |  1. HTTP POST /users                                                    |
 |  2. BEGIN SQL TRANSACTION                                               |
 |  3. INSERT INTO users (data)                                            |
 |  4. INSERT INTO outbox_events (event_data) // Menjamin event tercatat!  |
 |  5. COMMIT SQL TRANSACTION                                              |
 +-------------------------------------------------------------------------+
                                 |
 [ Outbox Relay Worker ] (Poller yg menarik event dari DB lalu me-publish)
                                 |
                                 v
   +-----------------------------------------------------------------+
   |    Event Broker (Kafka / NATS / RabbitMQ / Google PubSub)       |
   +-----------------------------------------------------------------+
              |                                          |
              v (Consume Async)                          v (Consume Async)
 +--------------------------+                +-------------------------+
 |   Notification Service   |                |    Analytics Service    |
 | (Mengirim Welcome Email) |                | (Mengolah Data Metrik)  |
 +--------------------------+                +-------------------------+
```

## Kode Go Production-Ready

Kode di bawah mendemonstrasikan implementasi router pub/sub yang solid di Go menggunakan library `watermill`, termasuk penanganan `context` dan *graceful shutdown*.

```go
package eventpubsub

import (
	"context"
	"errors"
	"fmt"
	"log"
	"testing"
	"time"

	"github.com/ThreeDotsLabs/watermill"
	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/ThreeDotsLabs/watermill/pubsub/gochannel"
)

// =====================================
// 1. EVENT DEFINITIONS & PUBLISHER
// =====================================

type Publisher struct {
	pub message.Publisher
}

func NewPublisher(p message.Publisher) *Publisher {
	return &Publisher{pub: p}
}

// PublishUserRegistered mengirim event bahwa user berhasil mendaftar
func (p *Publisher) PublishUserRegistered(ctx context.Context, userID, email string) error {
	// Buat payload mentah (di production gunakan JSON/Protobuf serializer)
	payload := []byte(fmt.Sprintf(`{"user_id":"%s", "email":"%s"}`, userID, email))
	
	// watermill.NewUUID menjamin traceability
	msg := message.NewMessage(watermill.NewUUID(), payload)
	msg.SetContext(ctx) // Sebarkan context untuk tracing/cancellation
	
	// Metadata krusial untuk Versioning dan Filter consumer
	msg.Metadata.Set("event_type", "UserRegistered")
	msg.Metadata.Set("version", "v1")

	// Publish ke topik "user_events"
	if err := p.pub.Publish("user_events", msg); err != nil {
		return fmt.Errorf("failed to publish user event: %w", err)
	}
	return nil
}

// =====================================
// 2. EVENT CONSUMER (ROUTER)
// =====================================

// UserRegistrationHandler adalah instance handler untuk consumer.
type UserRegistrationHandler struct {
	emailSender func(email string) error
}

// Handle memproses satu buah pesan secara aman.
func (h *UserRegistrationHandler) Handle(msg *message.Message) error {
	eventType := msg.Metadata.Get("event_type")
	if eventType != "UserRegistered" {
		return nil // Abaikan event yang tak relevan di topik ini
	}

	// Simulasi parsing sederhana
	payload := string(msg.Payload) // {"user_id":"X", "email":"Y"}
	fmt.Printf("[Consumer] Processing Event %s: Payload: %s\n", msg.UUID, payload)

	// Proses bisnis
	if err := h.emailSender("mock@mock.com"); err != nil {
		// Mengembalikan error akan memicu mekanisme RETRY/Nack oleh Watermill
		return fmt.Errorf("email sending failed: %w", err)
	}

	// Mengembalikan nil artinya message sukses dan akan di-Ack secara otomatis
	return nil
}

// =====================================
// 3. UNIT TEST (Siklus Pub/Sub)
// =====================================

func TestEventDrivenPubSub_FullCycle(t *testing.T) {
	// In-Memory Go Channels adapter (Cocok untuk test atau internal bus)
	pubSub := gochannel.NewGoChannel(
		gochannel.Config{BlockPublishUntilSubscriberAck: false},
		watermill.NewStdLogger(false, false),
	)
	defer pubSub.Close()

	// 1. Inisiasi Router & Handler
	router, err := message.NewRouter(
		message.RouterConfig{},
		watermill.NewStdLogger(false, false),
	)
	if err != nil {
		t.Fatalf("Failed to create router: %v", err)
	}

	// Flag untuk verifikasi test
	processed := false
	handler := &UserRegistrationHandler{
		emailSender: func(email string) error {
			processed = true
			return nil
		},
	}

	// 2. Pasang Handler ke Router (Subscribe)
	router.AddNoPublisherHandler(
		"notification_handler", // Nama Handler unik
		"user_events",          // Topik
		pubSub,                 // Subscriber
		handler.Handle,         // Fungsi eksekusi
	)

	// Jalankan Router di background
	go func() {
		if err := router.Run(context.Background()); err != nil {
			log.Println("Router closed")
		}
	}()

	// Tunggu goroutine router siap menerima subscriber
	<-router.Running()

	// 3. Inisiasi Publisher & Eksekusi Publish
	publisher := NewPublisher(pubSub)
	err = publisher.PublishUserRegistered(context.Background(), "usr-123", "alice@example.com")
	if err != nil {
		t.Fatalf("Failed to publish: %v", err)
	}

	// Beri jeda sangat kecil agar Go channel scheduler mengirim sinyal
	time.Sleep(50 * time.Millisecond)

	if !processed {
		t.Errorf("Expected event to be processed by consumer")
	}

	router.Close()
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Dual-Write Non-Atomik (Mimpi Buruk Inkonsistensi)
Mencoba memodifikasi database (MySQL/Postgres) lalu me-publish event (RabbitMQ/Kafka) dalam blok kode linear yang terpisah.

```go
// ❌ BAD: Mem-publish event ke jaringan *setelah* SQL commit secara tidak pasti.
func (s *Service) CreateUser(u *User) error {
    db.Exec("INSERT INTO users ...") // Langkah 1: Berhasil tersimpan di SQL!
    
    // TIBA-TIBA APLIKASI CRASH ATAU KAFKA TIMEOUT DI SINI!
    
    // Langkah 2: Gagal ter-publish. Event ini hilang selamanya.
    kafka.Publish("UserCreated", u)  
    return nil
}
```
**Why dangerous:** Jika pemanggilan ke Kafka *timeout*, database telah berkomit perubahan. Service Email (Consumer) tidak akan pernah mengirimkan *welcome email* ke pengguna yang sudah terdaftar. Data menjadi selamanya cacat (split brain).
**Solusi (Benar):** Gunakan pola **Transactional Outbox**. Di dalam sebuah *SQL Transaction*, simpan rekor `users` BERSAMA dengan menyimpan rekor log payload ke tabel `outbox_events`. Jika sukses, maka keduanya sukses. Buat background worker yang menelusuri tabel `outbox_events` (polling asinkron) lalu mengirimkannya secara tangguh ke Kafka. Library watermill menyediakan *SQL Outbox* built-in untuk ini.

### ❌ Anti-Pattern 2: Menunggu Balasan di atas Pub/Sub (Sinkronisasi Semu)
Memaksa sistem Event-Driven berperilaku selayaknya API Request-Response (RPC) gRPC/REST.

```go
// ❌ BAD: Mem-publish lalu ngeblok goroutine menunggu balasan di channel/topic lain
kafka.Publish("ProcessImageRequest", image)
<- waitForResponseOnTopic("ProcessImageResponse") // Menunggu balasan dari worker lain
```
**Why dangerous:** Sifat alami Pub/Sub adalah *fire-and-forget*. Jika *consumer* mati, request goroutine API Anda akan diam menunggu selamanya (memory leak) atau *timeout*. Kode menjadi sangat kompleks dan rapuh, serta performa turun drastis (Head-of-line blocking).
**Solusi (Benar):** Jika frontend/API mutlak butuh respon real-time, gunakan gRPC atau HTTP murni lintas microservice. Jika *harus* via event, kembalikan status `202 Accepted` bersama *Job ID* ke UI. Biarkan klien UI melakukan HTTP Polling, WebSocket, atau SSE untuk menanti pembaruan status saat job selesai secara asinkron.

## Edge Cases & Defensive Programming Konkrit

1. **Idempotensi Consumer di Tengah Badai Retries (Duplicate Delivery):**
   Broker terdistribusi (Kafka, AWS SQS) umumnya hanya memberi jaminan jaring *At-Least-Once*. Pesan bisa dan *pasti* akan dikirim berulang (duplikat) jika *acknowledge* (ACK) terputus oleh kegagalan koneksi sesaat.
   *Defensive:* Consumer/Handler harus murni *Idempotent*. Jika event menyuruh "Deduct Balance Rp5000", jangan langsung dikurangi. Simpan `message.UUID` di tabel Postgres. Gunakan SQL query bersyarat: 
   `INSERT INTO processed_events (msg_id) VALUES ($1) ON CONFLICT DO NOTHING`. Jika ID sudah ada, `return nil` untuk mengabaikan dan meng-ACK duplikat tersebut.

2. **Poison Pill Messages (Head-of-Line Blocking):**
   Bayangkan satu pesan memiliki JSON yang rusak fatal atau referensi DB ID yang tak akan pernah bisa ditemukan. Setiap kali Handler menerimanya, ia *panic* atau me-return error, membuat Broker menolak ACK dan terus *retrying* pesan busuk tersebut di awal antrean (menyumbat laju antrean selamanya).
   *Defensive:* Terapkan Middleware *PoisonQueue / Dead Letter Queue (DLQ)*. Jika pesan gagal dalam iterasi 5 kali penolakan, Middleware melempar pesan tesebut ke topik tong sampah cadangan (`user_events_failed`), lalu memaksa broker melakukan *Ack* pesan awal untuk melapangkan antrean.

3. **Evolusi Schema dan Ketidakcocokan Versi Field:**
   Publisher mengubah struktur struct dari `{"age": 20}` (int) ke `{"age": "dua puluh"}` (string). Consumer versi lama seketika *panic* saat unmarshal.
   *Defensive:* Versi event bersifat esensial. Setiap publikasi **wajib** mencantumkan label versi di metadata (`msg.Metadata.Set("schema_version", "2")`). Konsumer lama menolak mengeksekusi dan dengan aman meng-ACK pesan tak dikenal (Forward Compatibility), atau gunakan format serialization tangguh berstandar seperti Protobuf/Avro yang memiliki registri kompatibilitas terpusat (Schema Registry).

## 5. Transactional Outbox + Watermill Integration

Pola **Transactional Outbox** adalah jaminan absolut (*bulletproof*) untuk masalah *dual-write*. Daripada memodifikasi basis data bisnis lalu mengirim pesan ke *message broker* melalui jaringan yang rawan gagal, kita menyimpan pesannya di tabel basis data (dalam *transaction* SQL yang sama). Pekerja (Worker) terpisah akan mengambil pesan dari tabel ini dan meneruskannya ke *message broker*.

### At-Least-Once vs Exactly-Once Guarantee
- **Exactly-Once Delivery** ke *Message Broker* sangat sulit dicapai secara matematis. Pola Outbox ini memberikan jaminan **At-Least-Once**.
- Jika *publisher worker* berhasil mengirim pesan ke Kafka namun *crash* sebelum sempat menandai event tersebut terkirim di tabel DB, *worker* baru akan membaca event itu lagi saat hidup kembali, menyebabkan duplikasi ke Kafka. Karenanya, Consumer akhir di layanan hilir (downstream) **harus idempotent**.

### Schema Tabel Outbox
```sql
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL, -- ID entitas domain (misal user_id)
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP WITH TIME ZONE -- NULL jika belum terkirim
);
-- Indeks agar poller outbox berjalan instan
CREATE INDEX idx_outbox_unpublished ON outbox_events(created_at) WHERE published_at IS NULL;
```

### Contoh Kode Go: Outbox Writer & Polling Publisher

```go
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/ThreeDotsLabs/watermill"
	"github.com/ThreeDotsLabs/watermill-sql/v2/pkg/sql_pubsub"
	"github.com/ThreeDotsLabs/watermill/message"
)

// 1. Transactional Outbox Writer (Domain Service)
func RegisterUser(ctx context.Context, tx *sql.Tx, userID string, email string) error {
	// A. Modifikasi data utama
	_, err := tx.ExecContext(ctx, "INSERT INTO users (id, email) VALUES ($1, $2)", userID, email)
	if err != nil {
		return err
	}

	// B. Tulis Event ke Outbox dalam Transaksi yang Sama
	payload, _ := json.Marshal(map[string]string{"email": email})
	
	outboxQuery := `
		INSERT INTO outbox_events (id, aggregate_id, event_type, payload) 
		VALUES ($1, $2, $3, $4)
	`
	_, err = tx.ExecContext(ctx, outboxQuery, watermill.NewUUID(), userID, "UserRegistered", payload)
	
	// C. Commit transaksi (jika error bubble up) akan menjamin kedua tindakan atomic!
	return err
}

// 2. Polling Publisher (Watermill SQL Publisher worker)
// Fungsi ini berjalan sebagai daemon/background worker terpisah.
func StartOutboxForwarder(db *sql.DB, brokerPublisher message.Publisher) error {
	logger := watermill.NewStdLogger(false, false)

	// Inisialisasi Subscriber berbasis SQL
	subscriber, err := sql_pubsub.NewSubscriber(
		db,
		sql_pubsub.SubscriberConfig{
			SchemaAdapter:    sql_pubsub.DefaultPostgreSQLSchema{},
			OffsetsAdapter:   sql_pubsub.DefaultPostgreSQLOffsetsAdapter{},
			InitializeSchema: true,
		},
		logger,
	)
	if err != nil {
		return err
	}
	defer subscriber.Close()

	// Menarik pesan dari tabel outbox_events untuk dipublish
	messages, err := subscriber.Subscribe(context.Background(), "outbox_events")
	if err != nil {
		return err
	}

	fmt.Println("[Outbox Relay] Worker started...")

	// Loop pengiriman (Relay) pesan
	for msg := range messages {
		// Teruskan pesan ke Message Broker sesungguhnya (Kafka/RabbitMQ)
		if err := brokerPublisher.Publish("user_events", msg); err != nil {
			fmt.Printf("Failed to relay message %s: %v\n", msg.UUID, err)
			msg.Nack() // Tolak, kembalikan antrian untuk dicoba ulang
			continue
		}
		
		// Jika sukses ke Broker, Ack akan memodifikasi DB Outbox (published_at)
		msg.Ack()
		fmt.Printf("Message %s relayed to Broker\n", msg.UUID)
	}

	return nil
}
```

### Edge Cases Tambahan

1. **Duplicate Event Downstream (Duplikasi Hilir)**: 
   Karena worker *outbox* menggunakan pendekatan At-Least-Once, sangat dimungkinkan *consumer* downstream (misalnya service e-mail) menerima event *UserRegistered* 2 kali. *Consumer* wajib mendesain logika mereka sedemikian rupa agar aman dieksekusi berulang kali (*Idempotent*). Caranya: gunakan `msg.UUID` sebagai *idempotency key* di DB tujuan untuk mencegat proses duplikat.
   
2. **Outbox Table Growth Management (Ukuran Tabel Membengkak)**:
   Karena setiap event yang diterbitkan direkam secara abadi di tabel `outbox_events`, tabel tersebut bisa membengkak menjadi jutaan baris dalam hitungan hari. Ini membebani ruang disk dan performa DB. Solusi: Buat operasi pembersihan asinkron (*cron job*) atau *partitioning* DB untuk menghapus (`DELETE`) rekaman di tabel *outbox_events* yang `published_at`-nya sudah lebih lama dari 7 hari.

## Kapan JANGAN Pakai Ini

- **Untuk komunikasi yang membutuhkan jawaban.** Bila pemanggil menunggu hasilnya, itu permintaan-respons. Membungkusnya sebagai event hanya menambah korelasi, timeout, dan jalur kegagalan tanpa satu pun manfaat asinkron.
- **Publish dari dalam transaksi bisnis tanpa outbox.** Bila publish berhasil lalu transaksi rollback, konsumer bereaksi terhadap kejadian yang tidak pernah terjadi — dan tidak ada cara menariknya kembali.
- **Event yang membawa seluruh keadaan objek.** Konsumer akan mulai bergantung pada field yang tidak pernah Anda niatkan menjadi kontrak, dan sejak saat itu Anda tidak bisa lagi mengubahnya tanpa memecahkan sistem orang lain.
- **Tanpa dead letter queue.** Satu pesan beracun akan menghentikan konsumer atau diulang selamanya, dan lag akan tumbuh sampai ada yang menyadarinya.
- **Berasumsi urutan terjamin lintas partisi.** Urutan hanya dijamin dalam satu partisi. Kunci partisi yang salah menghancurkan asumsi itu **diam-diam** — tidak ada galat, hanya hasil yang kadang salah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Consumer lag tumbuh terus | lag per partisi | Konsumer kalah cepat, atau satu partisi tersangkut |
| Satu partisi jauh lebih penuh | kunci partisi | Sebaran kunci timpang |
| Kejadian diproses di luar urutan | kunci partisi vs asumsi urutan | Entitas yang sama tersebar ke banyak partisi |
| Konsumer mengulang pesan yang sama | apakah ada DLQ | Pesan beracun tanpa jalur keluar |
| Konsumer bereaksi ke kejadian yang batal | apakah publish lewat outbox | Publish di luar transaksi bisnis |

```bash
# Lag per partisi -- kolom LAG adalah metrik kesehatan utama
kafka-consumer-groups --bootstrap-server "$BROKER" --describe --group pesanan

# Sebaran pesan antar partisi
kafka-run-class kafka.tools.GetOffsetShell --broker-list "$BROKER" --topic pesanan

# DLQ yang terisi berarti ada pesan yang tidak pernah bisa diproses
kafka-run-class kafka.tools.GetOffsetShell --broker-list "$BROKER" --topic pesanan.dlq

# NATS JetStream
nats stream info PESANAN
nats consumer report PESANAN
```
