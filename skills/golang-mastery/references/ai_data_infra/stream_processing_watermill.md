# Stream Processing dengan Watermill

## Konsep Utama
Pipeline infrastruktur AI, seperti *real-time feature engineering* atau *asynchronous embedding generation*, membutuhkan bus pesan terdistribusi yang handal. Di ekosistem Go, `watermill` (github.com/ThreeDotsLabs/watermill) menjadi standar abstraksi *Pub/Sub*. Pustaka ini memisahkan logika domain (pemrosesan event) dari implementasi broker spesifik (Kafka, NATS JetStream, Redis Streams, Google Cloud PubSub, dll).

Fitur arsitektur utama Watermill:
- **Abstraksi Unifikasi**: Developer hanya bekerja dengan antarmuka `message.Publisher` dan `message.Subscriber`.
- **Router Pattern**: Komponen `message.Router` meniru arsitektur *HTTP Multiplexer*. Router menangani *wiring* secara otomatis; ia mengambil pesan dari Subscriber, melemparkannya ke fungsi *Handler*, dan mengirim hasil *return* ke Publisher tujuan.
- **Middleware Chain**: Watermill sangat adaptif via middleware (mirip HTTP middleware di Go). Mendukung *Retry* (eksponensial), *Poison Queue* (memindahkan pesan gagal permanen ke antrean mati), *Metrics* (Prometheus), dan *Recovery* (menangani Goroutine panic).

## Diagram ASCII

```text
[ LLM Application ] -- HTTP API --> (Post User Action) 
                                         |
                                         v
                            [ NATS JetStream / Kafka ]
                                         |  (Subscribe Topic: 'raw-events')
[ Watermill Router (Go Process) ] <------+
      |
      |-- Middleware: Prometheus Metrics
      |-- Middleware: Retry Mechanism (Max 3x)
      |-- Middleware: Recover & Poison Queue -> (Dead Letter Topic)
      |
      v
 [ Handler: Event-Driven ML Pipeline ]
      |
      | 1. Parse Event
      | 2. Fetch Text
      | 3. Generate Embedding (gRPC to ONNX)
      |
      v
(Return Transformed Event)
      |
      +-----> [ NATS JetStream / Kafka ] (Publish Topic: 'vector-updates')
                                         |
                                         v
                             [ pgvector Upsert Worker ]
```

## Kode Go Production-Ready

```go
package streaminfra

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/ThreeDotsLabs/watermill"
	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/ThreeDotsLabs/watermill/message/router/middleware"
	"github.com/ThreeDotsLabs/watermill/pubsub/gochannel"
)

// Event merepresentasikan payload data masuk
type DocumentEvent struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// VectorEvent adalah output dari ML pipeline
type VectorEvent struct {
	ID       string    `json:"id"`
	Vector   []float32 `json:"vector"`
	Generate time.Time `json:"generated_at"`
}

// StreamManager manages the pub/sub router architecture
type StreamManager struct {
	router    *message.Router
	pub       message.Publisher
	sub       message.Subscriber
	logger    watermill.LoggerAdapter
}

func NewStreamManager() (*StreamManager, error) {
	logger := watermill.NewStdLogger(false, false)
	
	// Untuk production: Gunakan kafka.NewPublisher/Subscriber atau NATS
	// gochannel digunakan disini agar testable secara internal memori
	pubSub := gochannel.NewGoChannel(gochannel.Config{}, logger)

	router, err := message.NewRouter(message.RouterConfig{}, logger)
	if err != nil {
		return nil, err
	}

	// 1. Setup Middlewares
	// Menangani panic dan error recovery
	router.AddMiddleware(middleware.Recoverer)
	
	// Mekanisme Retry (Backoff eksponensial) untuk kegagalan network/API
	retryMiddleware := middleware.Retry{
		MaxRetries:      3,
		InitialInterval: time.Millisecond * 100,
		Logger:          logger,
	}
	router.AddMiddleware(retryMiddleware.Middleware)

	sm := &StreamManager{
		router: router,
		pub:    pubSub,
		sub:    pubSub,
		logger: logger,
	}
	
	sm.registerHandlers()
	return sm, nil
}

// registerHandlers merangkai pipeline data AI
func (sm *StreamManager) registerHandlers() {
	// Router AddHandler format: Name, SubscribeTopic, Subscriber, PublishTopic, Publisher, HandlerFunc
	sm.router.AddHandler(
		"embedding_generator", // Handler name
		"raw_documents",       // Input topic
		sm.sub,
		"vector_upserts",      // Output topic (dimana return message dikirim)
		sm.pub,
		sm.processDocument,    // Handler function
	)
}

// processDocument mensimulasikan generasi embedding
func (sm *StreamManager) processDocument(msg *message.Message) ([]*message.Message, error) {
	var event DocumentEvent
	if err := json.Unmarshal(msg.Payload, &event); err != nil {
		// Logika gagal unmarshal. 
		// Karena bukan error network, kita tidak mereturn error (agar retry tidak dipicu sia-sia)
		// Melainkan di-drop atau kirim alert
		return nil, nil // Ack pesan secara diam-diam
	}

	// Simulasi memanggil model ONNX
	vector := []float32{0.1, 0.2, 0.3} // Dummy result

	outEvent := VectorEvent{
		ID:       event.ID,
		Vector:   vector,
		Generate: time.Now(),
	}

	outBytes, err := json.Marshal(outEvent)
	if err != nil {
		return nil, err
	}

	// Buat pesan Watermill baru (Bisa mewarisi context dari pesan asli untuk tracing)
	newMsg := message.NewMessage(watermill.NewUUID(), outBytes)
	
	// Message router akan mempublish newMsg secara otomatis ke "vector_upserts"
	return []*message.Message{newMsg}, nil
}

func (sm *StreamManager) Start(ctx context.Context) error {
	return sm.router.Run(ctx)
}

// --- UNIT TESTS ---

func TestStreamManager(t *testing.T) {
	sm, err := NewStreamManager()
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	
	// Jalankan router asinkron
	go func() {
		if err := sm.Start(ctx); err != nil {
			fmt.Printf("Router stopped: %v\n", err)
		}
	}()
	
	// Tunggu router siap
	<-sm.router.Running()

	// Simulasi subscribe ke output topic untuk memverifikasi
	messages, err := sm.sub.Subscribe(ctx, "vector_upserts")
	if err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}

	// Kirim pesan ke input topic
	doc := DocumentEvent{ID: "doc-1", Text: "Hello AI"}
	payload, _ := json.Marshal(doc)
	msg := message.NewMessage(watermill.NewUUID(), payload)
	
	err = sm.pub.Publish("raw_documents", msg)
	if err != nil {
		t.Fatalf("Publish failed: %v", err)
	}

	// Verifikasi output diterima
	select {
	case outMsg := <-messages:
		var result VectorEvent
		json.Unmarshal(outMsg.Payload, &result)
		if result.ID != "doc-1" {
			t.Errorf("Expected ID doc-1, got %s", result.ID)
		}
		outMsg.Ack()
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for message")
	}
	
	cancel()
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mereturn Error Akibat Bad Data (Poison Pill Loop)

```go
// BAD: Return error untuk payload yang corrupt/invalid
func (h *MLPipelineHandler) HandleEvent(msg *message.Message) ([]*message.Message, error) {
    var event DocumentEvent
    if err := json.Unmarshal(msg.Payload, &event); err != nil {
        return nil, fmt.Errorf("invalid payload: %w", err) // ← POISON PILL!
        // Middleware Retry akan coba ulang 3x, lalu forever jika MaxRetries=0
        // Payload yang invalid tidak akan pernah valid dengan dicoba ulang!
    }
    // ...
}

// GOOD: Drop pesan invalid atau kirim ke Dead Letter Queue
func (h *MLPipelineHandler) HandleEvent(msg *message.Message) ([]*message.Message, error) {
    var event DocumentEvent
    if err := json.Unmarshal(msg.Payload, &event); err != nil {
        // Log dan drop — return nil (tidak ada output), tidak error
        h.logger.Error("malformed payload, dropping", watermill.LogFields{
            "message_uuid": msg.UUID,
            "err":          err.Error(),
            // Publish ke DLQ secara manual jika perlu forensic
        })
        return nil, nil // ← Ack pesan (consume habis), jangan retry!
    }
    
    // Untuk transient error (network, API rate limit):
    if err := h.callExternalAPI(msg.Context(), &event); err != nil {
        return nil, err // ← Nack, trigger Retry middleware
    }
    // ...
    return outputMessages, nil
}
```

**Kenapa berbahaya:** `return error` di handler mengaktifkan Retry middleware. Payload yang corrupt secara struktural tidak akan pernah berubah menjadi valid dengan dicoba ulang — hasilnya adalah loop retry tak berakhir yang memblokir seluruh partisi Kafka (Head-of-Line Blocking). Di Kafka, satu consumer yang stuck di satu partisi menghentikan semua event lain di partisi tersebut.

### ❌ Anti-Pattern 2: Mengabaikan `msg.Ack()` pada Manual Subscriber

```go
// BAD: Manual subscriber tanpa Ack/Nack
func processMessages(sub message.Subscriber) {
    msgs, _ := sub.Subscribe(context.Background(), "raw_documents")
    for msg := range msgs {
        processDocument(msg.Payload)
        // ← Lupa msg.Ack()!
        // Pesan dianggap belum diproses oleh broker
    }
}
// Saat pod restart: semua pesan diulang dari awal
// Embedding API kena charge double/triple untuk setiap restart

// GOOD: Selalu Ack setelah sukses, Nack untuk retry
func processMessages(ctx context.Context, sub message.Subscriber) {
    msgs, _ := sub.Subscribe(ctx, "raw_documents")
    for msg := range msgs {
        if err := processDocument(msg.Context(), msg.Payload); err != nil {
            msg.Nack() // ← Trigger redelivery
            continue
        }
        msg.Ack() // ← Commit offset ke broker
    }
}
// Atau: Gunakan message.Router yang handle Ack/Nack otomatis
// berdasarkan return value handler (nil = Ack, error = Nack)
```

**Kenapa berbahaya:** NATS JetStream dan Kafka menggunakan consumer offset/ack mechanism. Tanpa `msg.Ack()`, broker menganggap pesan belum diproses dan akan re-deliver saat consumer restart. Di pipeline embedding dengan biaya OpenAI API per-token, ini berarti billing ganda untuk setiap Pod restart — bisa ratusan dolar wasted per incident.

### ❌ Anti-Pattern 3: Blocking Handler tanpa Context

```go
// BAD: Panggil external API tanpa context dari message
func (h *Handler) Handle(msg *message.Message) ([]*message.Message, error) {
    // SIGTERM dikirim, context.Background() tidak cancel!
    embedding, err := h.openaiClient.CreateEmbedding(
        context.Background(), // ← Tidak akan cancel saat pod shutdown
        "text-embedding-ada-002", text,
    )
    // Pod akan stuck selama ~30s OpenAI timeout, baru bisa terminate
}

// GOOD: Gunakan msg.Context() yang auto-cancel saat router shutdown
func (h *Handler) Handle(msg *message.Message) ([]*message.Message, error) {
    embedding, err := h.openaiClient.CreateEmbedding(
        msg.Context(), // ← Cancel otomatis saat SIGTERM / router stop
        "text-embedding-ada-002", text,
    )
    if errors.Is(err, context.Canceled) {
        return nil, err // Graceful shutdown, jangan log sebagai error
    }
    // ...
}
```

**Kenapa berbahaya:** Kubernetes pod termination (SIGTERM) memiliki `terminationGracePeriodSeconds` default 30 detik. Handler yang tidak menghormati context akan memblokir sampai external API timeout sendiri, sering melewati grace period dan di-SIGKILL paksa — menyebabkan in-flight messages jadi "limbo" dan tidak di-Ack.

## Edge Cases & Defensive Programming

1. **Idempotency dan Duplicate Deliveries:** At-least-once delivery adalah sifat fundamental Kafka/NATS. Handler harus idempoten — upsert PostgreSQL via `ON CONFLICT DO UPDATE`, atau track `message_uuid` di cache Redis (TTL=24h) untuk skip duplikasi. Jangan hanya check "sudah ada di DB" karena race condition bisa terjadi di multi-replica consumer.

2. **Context Cancellation Propagation:** `msg.Context()` di Watermill merepresentasikan lifecycle pesan. Semua downstream calls (gRPC, HTTP, DB query) harus menggunakan `msg.Context()` bukan `context.Background()`. Saat router shutdown, context otomatis cancel dan semua downstream operations terhenti gracefully.

3. **Data Racing pada Payload Mutasi:** `msg.Payload` adalah `[]byte` yang di-share dari broker client internal. Dilarang manipulasi in-place (`msg.Payload[0] = '{'`). Selalu unmarshal ke struct baru atau copy dengan `payload := make([]byte, len(msg.Payload)); copy(payload, msg.Payload)` jika perlu modifikasi.

4. **Subscriber Rebalancing Lag:** Kafka consumer rebalance saat Pod scale-up (3→10 node) bisa memakan 10-30 detik. Selama periode ini seluruh consumer group berhenti mengkonsumsi. Pipeline yang mengasumsikan latency stabil akan mengalami queue buildup. Implementasikan backpressure signal (channel depth monitoring) dan alert jika consumer lag > threshold.

5. **Watermill Router Panic Recovery:** Jika handler panic (nil pointer dereference, index out of bounds), middleware `middleware.Recoverer` menangkap panic dan convert ke Nack (retry). Tapi jika panic terjadi SEBELUM middleware dipasang (di router setup), router bisa crash. Selalu tambahkan `middleware.Recoverer` sebagai middleware PERTAMA (outermost) dalam chain agar semua panics tertangkap, dan test dengan `go test -race` untuk mendeteksi race condition di handler.
