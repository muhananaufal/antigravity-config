# Webhook Delivery Engine via gRPC Server Streaming

## Konsep dan Internals
Sistem pengiriman *Webhook* seringkali digunakan untuk menginformasikan layanan pihak ketiga (Partner eksternal) tentang suatu kejadian (*Event*) di dalam sistem Anda (misal: "Pembayaran Berhasil", "Kurir Tiba").

Jika Anda melakukan pengiriman HTTP POST (Webhook) ke eksternal langsung dari dalam *Service Core* (misal layanan Checkout), Anda membahayakan ketersediaan peladen internal Anda. Layanan pihak ketiga yang lambat akan menyandera *Goroutine* internal Anda, memicu kehabisan memori (*OOM*).

Arsitektur terbaik adalah memisahkan peran: **Service Core** bertugas menyiarkan kejadian ke **Webhook Worker**. Cara paling efisien di Golang untuk mendistribusikan deretan *event* ini dengan latensi sub-milidetik adalah melalui pola **gRPC Server Streaming**.
- **Service Core**: Membuka koneksi `ServerStream` dan secara non-stop memompa pesan `Send()`.
- **Webhook Worker (Klien gRPC)**: Terkoneksi ke Core, membaca `Recv()` secara *continuous*, dan memasukkan pesan-pesan tersebut ke dalam *Goroutine Worker Pool* yang bertugas menembakkan HTTP POST ke luar.

Ini memungkinkan pemisahan (*decoupling*) dan mengisolasi kegagalan jaringan eksternal dari *throughput* sistem inti.

## Diagram ASCII: Arsitektur gRPC Webhook Worker

```ascii
+------------------------+
|  Service Core (gRPC)   |
| (Payment Processor)    |
+------------------------+
            | (gRPC Server Streaming: StreamEvents)
            | payload: { "url": "https://partner.com", "data": "..." }
            v
+------------------------+       [Goroutine Pool HTTP] ---> (HTTP POST) [Partner 1]
|  Webhook Worker (App)  |       |
|  - Terkoneksi gRPC     |=======[Goroutine Pool HTTP] ---> (HTTP POST) [Partner 2]
|  - Membaca Recv()      |       |
|  - Menyebar ke Worker  |       [Goroutine Pool HTTP] ---> (HTTP POST) [Partner 3]
+------------------------+
                                 (Tertahan 30 detik? Tidak masalah, gRPC
                                  streaming tidak diblokir berkat Channel Go)
```

## Production-Ready Code & Testing
Kode berikut merepresentasikan kerangka mumpuni *Webhook Delivery*. Klien (Worker) membaca stream dari Server Core dan menyebarkannya (*dispatch*) ke worker asinkron agar `Recv()` gRPC tidak terblokir oleh HTTP I/O lambat.

```go
package webhookengine_test

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE (Server Streaming)
// ==============================================================================
type WebhookEvent struct {
	Id      string
	DestUrl string
	Payload string
}
type SubscribeRequest struct { WorkerNodeId string }

type WebhookServiceServer interface {
	SubscribeEvents(*SubscribeRequest, WebhookService_SubscribeEventsServer) error
}
type WebhookService_SubscribeEventsServer interface {
	Send(*WebhookEvent) error
	grpc.ServerStream
}
func RegisterWebhookServiceServer(s grpc.ServiceRegistrar, srv WebhookServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.WebhookService",
		HandlerType: (*WebhookServiceServer)(nil),
		Methods: []grpc.MethodDesc{},
		Streams: []grpc.StreamDesc{{
			StreamName:    "SubscribeEvents",
			Handler:       func(srv interface{}, stream grpc.ServerStream) error {
				return srv.(WebhookServiceServer).SubscribeEvents(&SubscribeRequest{}, &mockStreamWrapper{stream})
			},
			ServerStreams: true,
		}}, Metadata: "webhook.proto",
	}, srv)
}
type mockStreamWrapper struct{ grpc.ServerStream }
func (x *mockStreamWrapper) Send(m *WebhookEvent) error { return x.ServerStream.SendMsg(m) }

// Klien stream interface
type WebhookService_SubscribeEventsClient interface {
	Recv() (*WebhookEvent, error)
	grpc.ClientStream
}
type clientStreamWrapper struct{ grpc.ClientStream }
func (x *clientStreamWrapper) Recv() (*WebhookEvent, error) {
	m := new(WebhookEvent)
	if err := x.ClientStream.RecvMsg(m); err != nil { return nil, err }
	return m, nil
}

// ==============================================================================
// 2. DOMAIN LOGIC: SERVICE CORE (SERVER)
// ==============================================================================
type myCoreServer struct {
	mu     sync.Mutex
	events []*WebhookEvent
}

func (s *myCoreServer) SubscribeEvents(req *SubscribeRequest, stream WebhookService_SubscribeEventsServer) error {
	ctx := stream.Context()
	
	// Server Streaming berpotensi hidup selamanya, memompa events
	for {
		if err := ctx.Err(); err != nil {
			return status.Error(codes.Canceled, "worker disconnected")
		}

		s.mu.Lock()
		if len(s.events) > 0 {
			eventToPush := s.events[0]
			s.events = s.events[1:]
			s.mu.Unlock()

			if err := stream.Send(eventToPush); err != nil {
				return status.Errorf(codes.Internal, "failed to push event: %v", err)
			}
		} else {
			s.mu.Unlock()
			// Tunggu sebentar jika tidak ada event baru (polling buffer memory)
			time.Sleep(50 * time.Millisecond)
			
			// Untuk keperluan Unit Test, kita hancurkan stream dengan return nil
			// (asumsikan kita selesai mengirim test cases). Di realita, stream berlanjut terus.
			return nil 
		}
	}
}

// ==============================================================================
// 3. UNIT TEST E2E: CORE SERVER -> gRPC STREAM -> WORKER -> HTTP POST
// ==============================================================================
func TestWebhookDelivery_WithGRPCStreaming(t *testing.T) {
	lis := bufconn.Listen(1024 * 1024)

	// Setup Dummy Eksternal Partner HTTP API
	var partnerReceivedPayloads []string
	var muPartner sync.Mutex
	partnerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		muPartner.Lock()
		partnerReceivedPayloads = append(partnerReceivedPayloads, string(body))
		muPartner.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer partnerServer.Close()

	// A. Bangun gRPC Server (Core Service) yang memegang 2 Event di Memory
	coreSrv := &myCoreServer{
		events: []*WebhookEvent{
			{Id: "1", DestUrl: partnerServer.URL, Payload: `{"status":"paid"}`},
			{Id: "2", DestUrl: partnerServer.URL, Payload: `{"status":"shipped"}`},
		},
	}
	grpcServer := grpc.NewServer()
	RegisterWebhookServiceServer(grpcServer, coreSrv)
	go func() { _ = grpcServer.Serve(lis) }()
	defer grpcServer.Stop()

	// B. Bangun Worker Klien gRPC
	dialer := func(ctx context.Context, s string) (net.Conn, error) { return lis.Dial() }
	conn, _ := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(dialer), grpc.WithInsecure())
	defer conn.Close()

	streamDesc, _ := conn.NewStream(context.Background(), &grpc.StreamDesc{
		StreamName: "SubscribeEvents", ServerStreams: true,
	}, "/acme.api.v1.WebhookService/SubscribeEvents")
	clientStream := &clientStreamWrapper{streamDesc}
	
	// Karena stream sudah dibuat, kita asumsikan Request "Subscribe" sudah dikirim.
	// Di sistem sebenarnya, kita memanggil RPC method, tidak langsung `conn.NewStream`.

	// Channel buffer agar gRPC Recv() tidak terblokir oleh lambatnya HTTP POST
	jobQueue := make(chan *WebhookEvent, 100)
	var wg sync.WaitGroup

	// C. Worker HTTP Asinkron (Simulasi Pool, misal 2 worker)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for event := range jobQueue {
				// Tembakkan Webhook (HTTP POST)
				req, _ := http.NewRequest("POST", event.DestUrl, bytes.NewBufferString(event.Payload))
				req.Header.Set("Content-Type", "application/json")
				client := &http.Client{Timeout: 2 * time.Second}
				resp, err := client.Do(req)
				if err == nil {
					resp.Body.Close()
				}
			}
		}()
	}

	// D. Klien (Worker Node) Membaca gRPC Stream Terus Menerus
	for {
		event, err := clientStream.Recv()
		if err == io.EOF {
			break // Server selesai memompa events
		}
		if err != nil {
			t.Fatalf("Stream received error: %v", err)
		}
		
		// Masukkan ke antrian untuk dikerjakan worker
		jobQueue <- event
	}

	// Selesaikan antrian & tunggu semua worker selesai
	close(jobQueue)
	wg.Wait()

	// Verifikasi: Apakah Partner Server menerima ke-2 payload HTTP?
	muPartner.Lock()
	if len(partnerReceivedPayloads) != 2 {
		t.Errorf("Expected 2 webhooks delivered, got %d", len(partnerReceivedPayloads))
	}
	muPartner.Unlock()
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Memblokir gRPC stream saat I/O HTTP Lambat (Head-of-Line Blocking)
Menerima event `Recv()`, dan *langsung menembak HTTP POST di fungsi perulangan (loop) yang sama*.

```go
// BAD: Loop gRPC terhambat oleh jaringan pihak ketiga.
for {
    event, _ := stream.Recv()
    // Eksekusi POST sinkron memakan waktu 30 Detik timeout...
    http.Post(event.DestUrl, "application/json", event.Payload) 
    // Event ke-2 tertahan selama 30 detik di buffer TCP server inti!
}
```
**Mengapa berbahaya:** Jika URL Partner down atau membiarkan HTTP koneksi *hanging*, proses pembacaan Stream `Recv()` akan membeku. Keadaan ini menyebabkan efek domino balik ke *Service Core*: *buffer* stream gRPC di memori server inti akan membengkak (*backpressure* TCP) dan akhirnya menenggelamkan service paling berharga di sistem Anda.

**Benar:** Pisahkan (*Decouple*) logika menggunakan *Channel* buffered di Go, seperti `jobQueue <- event`, lalu proses channel tersebut melalui goroutine tersendiri (seperti kode tes di atas).

### ❌ Anti-Pattern 2: Tidak Ada State Cursor untuk Reconnect (Hilangnya Kejadian)
Memulai *Server Streaming* buta tanpa parameter kompensasi (*Cursor/Offset*). Klien langsung melakukan `SubscribeEvents()`.

```protobuf
// BAD: Jika klien terputus, semua event yang disiarkan server selama koneksi mati akan hangus (At-most-once delivery).
message SubscribeRequest {
   // Kosong
}
```
**Mengapa berbahaya:** Pembaruan infrastruktur (seperti Kubernetes men-deploy versi baru Worker) pasti akan memutus TCP Stream. Saat Worker bangun dan menyambung ulang, segala orderan/webhook yang memicu di interval 5 detik *downtime* hilang begitu saja, memicu keluhan Partner yang gagal menerima webhook.

**Benar:** *Subscribe Request* wajib meminta rekam jejak terakhir (`int64 last_event_id`). Server mengambil data dari *Offset* tersebut di database, dan memompa event yang sempat tertinggal di masa transisi.

## Edge Cases Khusus

1. **Poison Pill Webhook**: Jika *payload* yang Anda kirim menyebabkan Partner API me-return HTTP `400 Bad Request` permanen, namun Worker gRPC Anda dikonfigurasi untuk melakukan *Infinite Retry* (coba ulang selamanya). Satu *Poison Pill* event ini akan menyandera 1 thread worker secara absolut hingga akhir zaman. Patenkan *Dead-Letter-Queue* (DLQ) atau set limit percobaan ulang maksimal 5 kali dengan pola jeda (*Exponential Backoff*).
2. **Backpressure Saturated Worker Pool**: Klien mengimplementasikan antrian Go (`jobQueue := make(chan *Event, 1000)`). Tiba-tiba terjadi badai *Black Friday* event sebanyak sejuta permintaan. Antrian Go 1000 penuh. Eksekusi penulisan `jobQueue <- event` akan mulai memblokir `Recv()`. Akhirnya menjalar ke masalah inti. Solusi tingkat lanjut: jika kanal *channel* 100% penuh, buang metrik penanda *Worker Exhausted* ke Prometheus dan secara dinamis mulai *Horizontal Pod Autoscaler (HPA)* Worker App di Kubernetes untuk mencairkan kepadatan antrian.
3. **Pemisahan Traffic (Sharding)**: Server memiliki memori terbatas dan Klien memompa sejuta koneksi Stream. Jika Anda me-deploy 5 replika Klien Worker, setiap worker perlu parameter penyaring (*sharding id*) di requestnya, agar Service Core bisa secara selektif membroadcast "Event 1-200 ke Worker A, Event 201-400 ke Worker B". Jika tidak, 5 Replika Worker akan menerima replika webhook yang persis sama, mengirim webhook duplikat ke pelanggan Anda (*At-least-once chaos*).
