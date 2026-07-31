# NATS & JetStream Cluster di Go

## 1. Konsep Utama & Internals
NATS adalah sistem *messaging* sistem terdistribusi berperforma tinggi, sedangkan **JetStream** adalah subsistem persistensi terintegrasi generasi baru (pengganti NATS Streaming/STAN). NATS Core memberikan komunikasi *fire-and-forget* sub-milidetik, sementara JetStream menambahkan fitur log penyimpanan, *replay* pesan, *Consumer* (Push/Pull), dan jaminan *Exactly Once* (dengan deduplikasi *Message ID*).

Aplikasi Go terhubung ke *cluster* NATS menggunakan library `github.com/nats-io/nats.go`. Arsitektur clustering NATS tidak bergantung pada Zookeeper atau dependensi eksternal, melainkan berjejaring secara *full mesh* dengan protokol gossip. JetStream berjalan menggunakan log RAFT di balik layar untuk mereplikasi state *Stream* ke seluruh node.

## 2. Diagram Arsitektur / Aliran JetStream (ASCII)
```text
      [ Publisher / Go App ]
               |
  1. PublishMsgAsync(Subject: "orders.new", Nats-Msg-Id: "tx-123")
               v
 +-------------------------------------------------------------------+
 |                    NATS FULL-MESH CLUSTER                         |
 |                                                                   |
 |     [ Node A ] <--- RAFT Replication ---> [ Node B (LEADER) ]     |
 |  (Follower, Read)                          (Accepts Writes)       |
 |         ^                                         |               |
 |         |                                         v               |
 |         +---------- [ Node C ] ----------- [ WAL (Write-Ahead) ]  |
 |                   (Follower, Read)         [ Log on Disk       ]  |
 +-------------------------------------------------------------------+
               | 2. PubAck (OK/Err)
               v
      [ Publisher / Go App ]

 +-------------------------------------------------------------------+
 | 3. Fetch(Batch: 10)                                               |
 |    [ Consumer Group "order-worker" ] --> (Tracks Offset in RAFT)  |
 |                                                                   |
 | 4. Deliver Msgs & wait for ACK                                    |
 | 5. Msg.Ack() -> Updates Consumer State                            |
 +-------------------------------------------------------------------+
```

## 3. Production-Ready Go Code

```go
package natsnet

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// --- A. DEPENDENCY INJECTION & INTERFACES ---

// IJetStreamPublisher adalah abstraksi untuk memfasilitasi Unit Test tanpa broker NATS nyata.
type IJetStreamPublisher interface {
	PublishMsgAsync(*nats.Msg) (jetstream.PubAckFuture, error)
}

// IMessage abstraksi untuk NATS Msg agar mudah di-mock dalam testing worker.
type IMessage interface {
	Metadata() (*jetstream.MsgMetadata, error)
	Term() error
	Nak() error
	Ack() error
}

// --- B. IMPLEMENTASI PRODUKSI ---

// PublishWithDedupe mempublikasikan pesan dengan jaminan Exactly Once via MsgIdHdr.
func PublishWithDedupe(ctx context.Context, js IJetStreamPublisher, subject, msgID string, payload []byte) error {
	headers := nats.Header{}
	headers.Set(nats.MsgIdHdr, msgID)

	msg := &nats.Msg{
		Subject: subject,
		Header:  headers,
		Data:    payload,
	}

	ackFuture, err := js.PublishMsgAsync(msg)
	if err != nil {
		return fmt.Errorf("publish call failed: %w", err)
	}

	select {
	case <-ackFuture.Ok():
		return nil
	case err := <-ackFuture.Err():
		return fmt.Errorf("broker nack/error: %w", err)
	case <-ctx.Done():
		return fmt.Errorf("publish timeout: %w", ctx.Err())
	}
}

// ProcessMessage mensimulasikan worker dengan penanganan Poison Pill (Edge Case #3).
func ProcessMessage(msg IMessage) error {
	meta, err := msg.Metadata()
	if err != nil {
		msg.Term() // Unparseable metadata, hapus dari broker
		return err
	}
	
	// Jika gagal berulang kali (Poison Pill), terminate.
	if meta.NumDelivered >= 3 {
		msg.Term()
		return errors.New("poison pill detected, message terminated")
	}

	// Simulasi kegagalan pemrosesan normal
	msg.Nak()
	return errors.New("temporary processing failure")
}

// --- C. UNIT TESTS (Top 1% Standard: Cepat, Terisolasi, Realistis) ---

// 1. Mock Implementations

type mockPubAckFuture struct {
	okCh  chan *jetstream.PubAck
	errCh chan error
}
func (m *mockPubAckFuture) Ok() <-chan *jetstream.PubAck { return m.okCh }
func (m *mockPubAckFuture) Err() <-chan error { return m.errCh }
func (m *mockPubAckFuture) Msg() *nats.Msg { return nil }

type mockJSPublisher struct {
	Future *mockPubAckFuture
	Err    error
}
func (m *mockJSPublisher) PublishMsgAsync(msg *nats.Msg) (jetstream.PubAckFuture, error) {
	return m.Future, m.Err
}

type mockMessage struct {
	Meta      *jetstream.MsgMetadata
	MetaErr   error
	TermCount int
	NakCount  int
	AckCount  int
}
func (m *mockMessage) Metadata() (*jetstream.MsgMetadata, error) { return m.Meta, m.MetaErr }
func (m *mockMessage) Term() error { m.TermCount++; return nil }
func (m *mockMessage) Nak() error  { m.NakCount++; return nil }
func (m *mockMessage) Ack() error  { m.AckCount++; return nil }


// 2. Test Cases

// Test 1: Publish Timeout Scenario (Menguji Context Cancellation)
func TestPublishWithDedupe_Timeout(t *testing.T) {
	mockPub := &mockJSPublisher{
		Future: &mockPubAckFuture{
			okCh:  make(chan *jetstream.PubAck),
			errCh: make(chan error),
		},
	}
	// Timeout instan
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	// Simulasi delay (tidak ada respons dari channel okCh/errCh)
	time.Sleep(5 * time.Millisecond)

	err := PublishWithDedupe(ctx, mockPub, "orders", "tx-1", []byte("data"))
	if err == nil || err.Error() != "publish timeout: context deadline exceeded" {
		t.Errorf("Expected context timeout error, got: %v", err)
	}
}

// Test 2: Publish Success (Broker merespons OK)
func TestPublishWithDedupe_Success(t *testing.T) {
	future := &mockPubAckFuture{
		okCh:  make(chan *jetstream.PubAck, 1),
		errCh: make(chan error),
	}
	future.okCh <- &jetstream.PubAck{} // Simulasi sukses dari NATS

	mockPub := &mockJSPublisher{Future: future}

	err := PublishWithDedupe(context.Background(), mockPub, "orders", "tx-2", []byte("data"))
	if err != nil {
		t.Errorf("Expected success, got error: %v", err)
	}
}

// Test 3: Poison Pill Edge Case (Pesan dihapus dari queue setelah 3x gagal)
func TestProcessMessage_PoisonPill(t *testing.T) {
	msg := &mockMessage{
		Meta: &jetstream.MsgMetadata{NumDelivered: 3},
	}

	err := ProcessMessage(msg)
	
	if msg.TermCount != 1 {
		t.Errorf("Expected msg to be terminated, TermCount = %d", msg.TermCount)
	}
	if msg.NakCount != 0 {
		t.Errorf("Expected msg NOT to be nak'd, NakCount = %d", msg.NakCount)
	}
	if err == nil || err.Error() != "poison pill detected, message terminated" {
		t.Errorf("Unexpected error: %v", err)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Acknowledgements di Consumer
Saat bermigrasi dari NATS Core (Push / *Fire and forget*) ke JetStream, engineer sering lupa memanggil `msg.Ack()`. Jika `AckPolicy` diset ke Explicit (standar praktis) dan consumer gagal mengirim *ack* dalam batas waktu `AckWait`, server akan terus melakukan redelivery (pengiriman ulang) pesan yang sama.

```go
// ❌ BAD: Mengkonsumsi tanpa memproses ACK
cons, _ := js.Consume(ctx, "ORDERS", "worker", func(msg jetstream.Msg) {
    db.Save(msg.Data())
    // LUPA: msg.Ack() tidak dipanggil
})
```
**Why dangerous:** Ini menciptakan badai amplifikasi (*Redelivery Storm*). Jika pesan terus dikirim ulang, worker Anda akan memproses data yang sama berulang kali (menyebabkan anomali data jika operasi tidak idempoten), dan queue tidak akan pernah maju.

```go
// ✅ GOOD: Selalu ACK di akhir, atau NAK jika gagal agar di-retry instan
cons, _ := js.Consume(ctx, "ORDERS", "worker", func(msg jetstream.Msg) {
    if err := db.Save(msg.Data()); err != nil {
        msg.Nak() // Not acknowledge, redeliver
        return
    }
    msg.Ack()
})
```

### ❌ Anti-Pattern 2: Terjebak pada Push Consumer dengan Kecepatan Asimetris
Meskipun NATS JetStream mendukung Push Consumer, menggunakannya saat *processing* sisi Go Anda sangat lambat (misal, 2 detik per pesan untuk *video processing*) akan mengakibatkan masalah *slow consumer*.

```go
// ❌ BAD: Menggunakan Subscription asinkron untuk tugas CPU-bound
sub, _ := js.Subscribe("events", func(msg *nats.Msg) { // API lama (v1) Push
    time.Sleep(2 * time.Second) // Beban berat
    msg.Ack()
})
```
**Why dangerous:** Broker NATS akan menekan buffer memori goroutine internal (buffer pending default 65536) karena NATS terus mendorong pesan lebih cepat dari yang bisa ditangani. Klien Go akan terputus paksa dengan log *slow consumer*.

```go
// ✅ GOOD: Gunakan Pull Consumer (Fetch / Next)
// Di JetStream V2 (seperti di kode produksi), `cons.Fetch(10)` menarik 10 pesan saja.
// Aplikasi tidak akan ditenggelamkan (drowned) oleh broker karena ia mengambil data 
// SESUAI kemampuannya sendiri (Backpressure alami).
```

### ❌ Anti-Pattern 3: Menggunakan Wildcard Terlalu Luas di Subject Stream
Menggunakan wildcard `>` (menangkap semua subject) pada konfigurasi Stream di production sangat berbahaya jika tidak diiringi pembatasan storage yang ketat.

```go
// ❌ BAD: Menyerap seluruh message di broker ke dalam satu stream tanpa filter
js.CreateStream(ctx, jetstream.StreamConfig{
    Name:     "ALL_EVENTS",
    Subjects: []string{">"}, 
})
```
**Why dangerous:** Setiap pesan lintas domain di NATS akan disalin ke disk/memori Stream ini. Ini memperlambat throughput I/O broker secara drastis, memicu *disk full*, dan membunuh performa node RAFT.

```go
// ✅ GOOD: Gunakan filter spesifik dan terapkan batasan MaxAge, MaxBytes, atau MaxMsgs.
js.CreateStream(ctx, jetstream.StreamConfig{
    Name:     "ORDERS",
    Subjects: []string{"orders.*"}, 
    MaxAge:   7 * 24 * time.Hour, // Hapus data lama setelah 7 hari
})
```

## 5. Edge Cases & Defensive Programming

1. **Split Brain Partition (Raft Consensus)**: Jika sebuah koneksi cluster terputus (Network Partition), NATS node mungkin tidak dapat mencapai kuorum RAFT. Pada saat itu, fungsi `PublishMsgAsync` JetStream tidak akan menghasilkan sukses atau error segera, melainkan bisa ter-*block* hingga timeout tercapai. *Defensive:* Jangan gunakan sinkron blokir absolut. Selalu amankan iterasi `Publish` ke JetStream dengan *Context Timeout* sehingga goroutine Web/API tidak *hang* selamanya menunggu konsensus cluster yang terpecah.
2. **Deduplication Window Linger**: Fitur *Exactly Once* di JetStream mengandalkan header `Nats-Msg-Id`. Server melacak ID ini secara default dalam *Deduplication Window* 2 menit (bisa dikonfigurasi). *Defensive:* Jika *retry mechanism* klien Anda memakan waktu lebih dari 2 menit dan mengirim ID yang sama, *broker* akan menganggap itu pesan baru! Sesuaikan `Duplicates` config pada `StreamConfig` jika window retry aplikasi Anda mencapai hitungan jam (misalnya dengan delay exponential backoff HTTP eksternal).
3. **Poison Pill Message**: Sebuah malformed message (misalnya JSON rusak) yang menyebabkan `msg.Nak()` di *worker* Go akan terus-menerus diserap, di-*Nak*, dan dikirim ulang oleh JetStream tanpa henti hingga mencapai limit persistensi. *Defensive:* Batasi konfigurasi Consumer dengan `MaxDeliver: 3`. Jika *worker* menerima pesan dengan `msg.Metadata().NumDelivered >= 3`, lakukan `msg.Term()` (Terminate) alih-alih `Nak()`, yang secara instruksional memberi tahu JetStream untuk menghapus pesan dari antrian selamanya, atau kirim (forward) ke *Dead Letter Queue* (Topik terpisah).
