# MQTT Broker & Client Implementation di Go

## 1. Konsep Utama & Internals
MQTT (Message Queuing Telemetry Transport) adalah protokol *pub/sub* *stateful* berbasis TCP/IP yang didesain spesifik untuk IoT dan jaringan *low-bandwidth/high-latency*. Berbeda dengan sistem stateless seperti HTTP, MQTT mempertahankan koneksi secara persisten di sentral broker. 

Fitur kunci dalam MQTT meliputi jaminan *Quality of Service* (QoS 0: At most once, QoS 1: At least once, QoS 2: Exactly once), fitur *Retained Messages* (menyimpan state terakhir dari topik di memori broker), dan *Last Will and Testament (LWT)* (broker ditugaskan mempublikasikan pesan 'kematian' saat mendeteksi TCP drop dari klien). 

Di Go, arsitektur yang tangguh umumnya menggunakan `github.com/eclipse/paho.mqtt.golang` sebagai klien (*resilient & auto-reconnect*) dan library canggih `github.com/mochi-mqtt/server` untuk me-run *embedded broker* langsung di dalam binary Go tanpa dependensi eksternal seperti Mosquitto.

## 2. Diagram Arsitektur / Aliran LWT & QoS (ASCII)
```text
  [IoT Device A] (Sensor Suhu)                     [Go Embedded MQTT Broker (Mochi)]
         |                                                       |
         | 1. CONNECT + LWT (Topic="status/A", Msg="offline")    |
         |------------------------------------------------------>| (Broker mencatat Will)
         |<------------------------------------------------------| 2. CONNACK
         |                                                       |
         | 3. PUBLISH "sensors/temp" (QoS 1, Payload="25C")      |
         |------------------------------------------------------>| (Disimpan ke Buffer DB)
         |<------------------------------------------------------| 4. PUBACK (Ack)
         |                                                       |
     (Baterai Habis / Koneksi TCP Putus Tanpa DISCONNECT)        |
         X                                                       |
                                                    (Timeout Keep-Alive 60s tercapai)
                                                                 |
                                                                 | 5. Memicu LWT Trigger
    [Backend Monitoring DB] <----- PUBLISH "status/A"="offline" -|
```

## 3. Production-Ready Go Code

Implementasi klien tangguh (dengan auto-reconnect, LWT, dan *non-blocking subscribe*) dan Embedded Broker Mochi.

```go
package mqttnet

import (
	"context"
	"fmt"
	"log"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
)

// StartEmbeddedBroker menjalankan broker in-process.
func StartEmbeddedBroker(ctx context.Context, port int) (*server.Server, error) {
	broker := server.New(nil)
	
	// Untuk production, ganti AllowHook dengan custom AuthHook yang memvalidasi JWT/Password
	_ = broker.AddHook(new(auth.AllowHook), nil)

	tcp := listeners.NewTCP("tcp1", fmt.Sprintf(":%d", port), nil)
	if err := broker.AddListener(tcp); err != nil {
		return nil, fmt.Errorf("failed to add TCP listener: %w", err)
	}

	go func() {
		// Serve memblokir OS thread, gunakan goroutine
		if err := broker.Serve(); err != nil {
			log.Printf("Broker stopped: %v", err)
		}
	}()

	// Graceful shutdown
	go func() {
		<-ctx.Done()
		_ = broker.Close()
	}()

	return broker, nil
}

// NewResilientClient mengkonfigurasi MQTT client yang tahan banting (production ready)
func NewResilientClient(clientID, brokerURI string) (mqtt.Client, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(brokerURI)
	opts.SetClientID(clientID)
	
	// Manajemen Resiliensi Jaringan
	opts.SetAutoReconnect(true)
	opts.SetMaxReconnectInterval(5 * time.Second)
	opts.SetConnectRetryInterval(2 * time.Second)
	opts.SetKeepAlive(60 * time.Second)
	
	// Mencegah OOM jika putus lama dan menumpuk pesan publish
	opts.SetMessageChannelDepth(100) 

	// 1. Setup Last Will and Testament (QoS 1, Retained = true)
	willTopic := fmt.Sprintf("status/%s", clientID)
	opts.SetWill(willTopic, "offline", 1, true)

	opts.OnConnect = func(c mqtt.Client) {
		log.Printf("Connected: %s", clientID)
		// 2. Publish status online retained saat terkoneksi
		c.Publish(willTopic, 1, true, "online")
	}
	opts.OnConnectionLost = func(c mqtt.Client, err error) {
		log.Printf("Connection lost: %s, err: %v", clientID, err)
	}

	client := mqtt.NewClient(opts)
	token := client.Connect()
	if token.Wait() && token.Error() != nil {
		return nil, fmt.Errorf("initial connect failed: %w", token.Error())
	}

	return client, nil
}

// --- UNIT TESTS ---

// 1. Integration Test dengan Embedded Broker
func TestMQTTFlow(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	broker, err := StartEmbeddedBroker(ctx, 1883)
	if err != nil {
		t.Fatalf("Broker failed: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // Tunggu port bind

	client, err := NewResilientClient("sensor-test-01", "tcp://127.0.0.1:1883")
	if err != nil {
		t.Fatalf("Client failed: %v", err)
	}
	defer client.Disconnect(250)

	msgChan := make(chan string, 1)
	
	// Subscribe dengan non-blocking pattern handler
	token := client.Subscribe("sensors/temp", 1, func(c mqtt.Client, m mqtt.Message) {
		// Lempar payload ke channel (non-blocking paho internal thread)
		select {
		case msgChan <- string(m.Payload()):
		default:
		}
	})
	token.Wait()

	client.Publish("sensors/temp", 1, false, "24.5C").Wait()

	select {
	case payload := <-msgChan:
		if payload != "24.5C" {
			t.Errorf("Expected 24.5C, got %s", payload)
		}
	case <-time.After(2 * time.Second):
		t.Error("Timeout waiting for MQTT message")
	}
}

// Mock MQTT Client untuk Unit Test Business Logic murni (tanpa TCP)
type MockClient struct {
	mqtt.Client // Embed interface
	PublishFunc func(topic string, qos byte, retained bool, payload interface{}) mqtt.Token
}

func (m *MockClient) Publish(topic string, qos byte, retained bool, payload interface{}) mqtt.Token {
	if m.PublishFunc != nil {
		return m.PublishFunc(topic, qos, retained, payload)
	}
	return nil
}

type MockToken struct {
	mqtt.Token // Embed interface
	Err error
}
func (m *MockToken) Wait() bool { return true }
func (m *MockToken) Error() error { return m.Err }

// 2. Unit Test dengan Mock Interface
func TestMQTTClient_BusinessLogic_Mock(t *testing.T) {
	// Skenario: Menguji fungsi publikasi metrik suhu tanpa membangkitkan TCP Broker
	mockClient := &MockClient{
		PublishFunc: func(topic string, qos byte, retained bool, payload interface{}) mqtt.Token {
			if topic != "sensors/temp" {
				t.Errorf("Salah topik: got %s", topic)
			}
			if payload != "26.5C" {
				t.Errorf("Salah payload: got %v", payload)
			}
			return &MockToken{Err: nil}
		},
	}

	// Fungsi bisnis yang menerima interface mqtt.Client
	publishTemperature := func(c mqtt.Client, temp string) error {
		token := c.Publish("sensors/temp", 1, false, temp)
		token.Wait()
		return token.Error()
	}

	err := publishTemperature(mockClient, "26.5C")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
}

// 3. Edge Case Test: Tombstone Message (Retained Message Deletion)
func TestMQTT_TombstoneMessage(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	broker, _ := StartEmbeddedBroker(ctx, 1884)
	time.Sleep(200 * time.Millisecond)

	client, _ := NewResilientClient("sensor-test-02", "tcp://127.0.0.1:1884")
	defer client.Disconnect(250)

	// Publish retained message (QoS 1, Retained=true)
	client.Publish("config/state", 1, true, "active").Wait()
	
	// Hapus retained message menggunakan Tombstone (payload byte array KOSONG)
	client.Publish("config/state", 1, true, []byte{}).Wait()

	msgChan := make(chan string, 1)
	client.Subscribe("config/state", 1, func(c mqtt.Client, m mqtt.Message) {
		msgChan <- string(m.Payload())
	}).Wait()

	select {
	case payload := <-msgChan:
		if payload != "" { 
			t.Errorf("Expected empty tombstone payload, got %s", payload)
		}
	case <-time.After(300 * Millisecond):
		// Skenario sukses alternatif: Broker Mochi tidak mem-forward empty retained
		// saat subscribe yang terlambat, karena state sudah dihapus.
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Blocking Handler `OnMessage` di Paho Go
Library `paho.mqtt.golang` memanggil callback `.Subscribe()` di dalam goroutine internal miliknya (satu per koneksi). Jika Anda mengeksekusi I/O lambat (DB insert/HTTP req) secara sinkron di dalamnya, seluruh antrian pengiriman pesan ke klien Anda akan terkunci.

```go
// ❌ BAD: Blocking internal MQTT loop
client.Subscribe("sensors/#", 1, func(c mqtt.Client, m mqtt.Message) {
    // DB.Exec butuh waktu 500ms.
    // Selama 500ms ini, paho client TIDAK BISA menerima MQTT ping/ACK/message lain.
    // Ini memicu connection timeout.
    db.Exec("INSERT INTO logs...", m.Payload()) 
})
```
**Why dangerous:** Menyebabkan *Thread Starvation* di layer *network client*. Klien Anda akan secara acak terputus karena gagal memproses PINGRESP TCP dalam *window time* karena *thread*-nya tertahan proses basis data.

```go
// ✅ GOOD: Dispatch ke Goroutine Pool atau Channel
client.Subscribe("sensors/#", 1, func(c mqtt.Client, m mqtt.Message) {
    // Payload harus dicopy jika diakses asinkron karena byte buffer digunakan ulang
    payload := make([]byte, len(m.Payload()))
    copy(payload, m.Payload())
    
    go func(data []byte) { // Eksekusi asinkron
        db.Exec("INSERT INTO logs...", data)
    }(payload)
})
```

### ❌ Anti-Pattern 2: Menggunakan QoS 2 (Exactly Once) Secara Membabi Buta
Para engineer sering menetapkan standar QoS 2 pada setiap metrik karena dianggap "paling aman".

```go
// ❌ BAD: Set QoS 2 (Exactly Once) untuk metrik ringan berulang
client.Publish("cpu/usage", 2, false, "80%") // dikirim per detik
```
**Why dangerous:** QoS 2 mensyaratkan 4 tahapan pertukaran TCP asinkron yang kompleks (PUBLISH -> PUBREC -> PUBREL -> PUBCOMP) di bawah layar. Menggunakannya pada frekuensi tinggi akan melipatgandakan *latency* 4x lipat, membanjiri buffer memori Broker Mochi, dan menguras baterai perangkat klien.

```go
// ✅ GOOD: QoS 0/1 sesuai kasus penggunaan
// QoS 0 (Fire and forget) untuk metrik CPU/Suhu yang akan dikirim ulang detik depan.
client.Publish("cpu/usage", 0, false, "80%") 
// QoS 1 (At least once) untuk pesan instruksional/alarm yang kritis. Backend cukup
// menduplikasi-filter berdasarkan ID pesan jika terkirim 2x.
```

## 5. Edge Cases & Defensive Programming

1. **Offline Queuing RAM Exhaustion**: Saat *AutoReconnect* aktif, jika broker mati 3 hari, `paho.mqtt.golang` akan menumpuk setiap pesan `Publish()` ke dalam memori RAM Go. *Defensive:* Tetapkan `opts.SetMessageChannelDepth(500)`. Begitu kedalaman channel offline tercapai, pesan-pesan baru akan dibuang (dropped) atau menyebabkan log error seketika alih-alih meledakkan kontainer Docker Anda akibat OOM (Out Of Memory).
2. **Topic Wildcard Bomb (Broker Side)**: IoT client yang terkompromi (hacked) bisa men-subscribe ke `#` (menarik copy seluruh data broker) atau mempublish ke kedalaman struktur `a/b/c/d/e/...` tanpa henti, menyebabkan keparahan alokasi trie-tree broker. *Defensive:* Jika menggunakan Embedded Broker (Mochi), terapkan custom *AuthHook* yang memvalidasi *Authorized Paths* klien. Kunci regex klien agar hanya boleh publish/subscribe di folder `sensors/{client_id}/*`.
3. **Ghost Retained Message Linger**: Pesan *retained* QoS 1 menetap selamanya di storage/RAM broker hingga ditimpa oleh retained message yang lebih baru di topik yang sama. Saat device IoT lama pensiun, state lamanya tetap menghantui UI *dashboard*. *Defensive:* Sediakan API *Tombstone*. Untuk menghapus pesan *retained*, Anda HARUS secara eksplisit mengirim pesan ke topik tersebut dengan `Payload` berupa *byte array* **Kosong** (0 byte) dan flag `Retained = true`. Broker akan mengenali itu sebagai instruksi hapus.
4. **Clean Session Mismatch (Persistent Memory Leak)**: Jika klien *mobile app* terhubung dengan `CleanSession=false` dan men-subscribe topik (misalnya "alerts/global"), lalu user meng-uninstall app, Broker masih menyimpan setiap pesan QoS 1 secara permanen untuk klien tersebut (menunggu ia kembali online selamanya). *Defensive:* Konfigurasi *Session Expiry Interval* (di MQTT v5) atau rutin melakukan *pruning* klien tidak aktif (dead client pruning) di dalam konfigurasi broker agar *storage* tidak korup.
