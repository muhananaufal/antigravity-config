# gRPC Streaming Patterns: Server, Client, & Bidirectional

> **Berlaku:** Go 1.21+ · `grpc-go` v1.60+ · **Lihat juga:** `microservices_grpc/grpc_interceptors_middleware.md` · `concurrency/channel_patterns_pipelines.md` · `concurrency/context_cancellation_timeout.md` · `microservices_grpc/webhook_delivery_engine.md`

## Konsep dan Internals
Dalam gRPC, *streaming* memungkinkan pengiriman kumpulan pesan tanpa batas atas koneksi TCP/HTTP2 tunggal. Alih-alih membuat request berulang-ulang yang mengorbankan waktu dalam *TCP handshake* dan *HTTP header overhead*, *streaming* menjaga *channel* tetap terbuka (long-lived connection) untuk transfer data dua arah.

Terdapat tiga pola aliran data (streaming):
1. **Server Streaming**: Klien mengirim 1 request. Server merespons dengan aliran data (N response). Contoh: Klien me-request "Unduh File Besar", server mem-pecah file menjadi potongan dan men-stream-nya.
2. **Client Streaming**: Klien mengirim aliran data (N request). Server merespons dengan 1 response di akhir stream. Contoh: Sensor IoT mengirimkan log metrik harian; setelah klien selesai, server merespons "Berhasil di-ingest".
3. **Bidirectional Streaming (Bidi)**: Klien dan Server saling mengirim aliran data secara independen (full-duplex). Klien bisa menulis dan membaca secara bersamaan, begitu pula server. Contoh: Aplikasi Chat real-time, sinkronisasi state multiplayer game.

Di tingkat yang lebih rendah, gRPC menggunakan fitur *Multiplexing* dan *Flow Control* dari HTTP/2. Artinya, banyak stream gRPC bisa berjalan di atas satu koneksi TCP nyata. Jika *buffer* di klien sudah penuh (klien membaca lebih lambat dari server mengirim), mekanisme *window update* HTTP/2 akan memberi tahu server untuk menghentikan pengiriman sementara (*backpressure*).

## Diagram ASCII: Arsitektur Eksekusi Streaming

```ascii
[Client]                                 [gRPC Server]
   |                                            |
   | --- 1. HTTP/2 HEADERS (Path, Auth) ------> |
   | <--- 2. HTTP/2 HEADERS (200 OK) ---------- |
   |                                            |
   | === STREAM ESTABLISHED (Full Duplex) ===   |
   |                                            |
   | --- 3. DATA (Payload 1) -----------------> |
   |                                            |
   | <--- 4. DATA (Response 1) ---------------- |
   |                                            |
   | --- 5. DATA (Payload 2) -----------------> |
   |                                            |
   | <--- 6. DATA (Response 2) ---------------- |
   |                                            |
   | --- 7. DATA (Payload 3) + END_STREAM ----> | (Client memanggil CloseSend)
   |                                            | (Server menerima io.EOF di Recv)
   | <--- 8. DATA (Response 3) ---------------- |
   | <--- 9. HEADERS (Trailer: gRPC Status) --- | (Server mereturn nil, stream ditutup)
   |                                            |
   V                                            V
```

## Production-Ready Code & Testing
Berikut adalah contoh implementasi **Bidirectional Streaming** untuk layanan gema (Chat/Echo). Implementasi ini menangani propagasi context, deteksi EOF, dan pengujian (testing) in-memory menggunakan `google.golang.org/grpc/test/bufconn`.

> **Catatan**: Dalam produksi, struktur `.proto` biasanya di-generate oleh `protoc`. Di sini kita mensimulasikan struct dan interface manual yang semirip mungkin dengan hasil *codegen* tersebut untuk tujuan testing mandiri.

```go
package grpcstreaming_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"sync"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE
// Normalnya ini di-generate otomatis dari file `.proto` menggunakan `protoc`.
// ==============================================================================
type StreamRequest struct {
	Payload string
}

type StreamResponse struct {
	Payload string
}

// StreamingServiceServer adalah interface untuk sisi server
type StreamingServiceServer interface {
	Chat(StreamingService_ChatServer) error
}

// StreamingService_ChatServer mensimulasikan stream wrapper server
type StreamingService_ChatServer interface {
	Send(*StreamResponse) error
	Recv() (*StreamRequest, error)
	grpc.ServerStream
}

// Untuk mendaftarkan service
func RegisterStreamingServiceServer(s grpc.ServiceRegistrar, srv StreamingServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.StreamingService",
		HandlerType: (*StreamingServiceServer)(nil),
		Methods:     []grpc.MethodDesc{},
		Streams: []grpc.StreamDesc{
			{
				StreamName:    "Chat",
				Handler:       func(srv interface{}, stream grpc.ServerStream) error {
					return srv.(StreamingServiceServer).Chat(&streamingServiceChatServer{stream})
				},
				ServerStreams: true,
				ClientStreams: true,
			},
		},
		Metadata: "streaming.proto",
	}, srv)
}

// Wrapper struct untuk mengimplementasikan interface generated
type streamingServiceChatServer struct {
	grpc.ServerStream
}
func (x *streamingServiceChatServer) Send(m *StreamResponse) error {
	return x.ServerStream.SendMsg(m)
}
func (x *streamingServiceChatServer) Recv() (*StreamRequest, error) {
	m := new(StreamRequest)
	if err := x.ServerStream.RecvMsg(m); err != nil {
		return nil, err
	}
	return m, nil
}

// StreamingService_ChatClient mensimulasikan stream wrapper client
type StreamingService_ChatClient interface {
	Send(*StreamRequest) error
	Recv() (*StreamResponse, error)
	CloseSend() error
	grpc.ClientStream
}

type streamingServiceChatClient struct {
	grpc.ClientStream
}
func (x *streamingServiceChatClient) Send(m *StreamRequest) error {
	return x.ClientStream.SendMsg(m)
}
func (x *streamingServiceChatClient) Recv() (*StreamResponse, error) {
	m := new(StreamResponse)
	if err := x.ClientStream.RecvMsg(m); err != nil {
		return nil, err
	}
	return m, nil
}

// ==============================================================================
// 2. IMPLEMENTASI HANDLER SERVER STREAMING
// ==============================================================================

type myStreamingServer struct{}

// Chat memproses komunikasi dua arah secara sekuensial (baca -> proses -> tulis)
func (s *myStreamingServer) Chat(stream StreamingService_ChatServer) error {
	ctx := stream.Context()

	// CATATAN POLA: loop ini SEKUENSIAL (recv -> proses -> send), bukan
	// full-duplex sungguhan. Itu aman dan cukup untuk sebagian besar kasus,
	// TETAPI hanya bila klien membaca responsnya secara konkuren.
	//
	// Bila klien mengirim terus tanpa membaca, kedua sisi bisa saling
	// menunggu: jendela flow control HTTP/2 penuh, Send() server memblokir,
	// dan Send() klien juga memblokir. Deadlock ini tidak menghasilkan galat
	// -- stream hanya berhenti bergerak. Untuk bidi yang benar-benar
	// independen, pisahkan menjadi dua goroutine (satu Recv, satu Send)
	// dengan channel di tengahnya, dan JANGAN pernah memanggil Send dari
	// lebih dari satu goroutine.
	for {
		// Recv() SUDAH kembali dengan galat ketika context selesai; memeriksa
		// ctx.Err() lebih dulu tidak menambah jaminan apa pun, hanya membuka
		// jendela balapan antara pemeriksaan dan pemanggilan.
		req, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			// Klien memanggil CloseSend(): tidak ada permintaan lagi.
			return nil
		}
		if err != nil {
			// KLIEN YANG PERGI BUKAN GALAT SERVER.
			//
			// Memetakannya ke codes.Internal menaikkan error rate layanan
			// untuk peristiwa yang disebabkan klien -- membakar error budget,
			// memicu alert, dan membuat SLO tampak buruk karena pengguna
			// menutup tab. Kembalikan kode aslinya, dan catat sebagai info.
			switch status.Code(err) {
			case codes.Canceled, codes.Unavailable:
				slog.InfoContext(ctx, "client disconnected stream", slog.String("reason", err.Error()))
				return err
			case codes.DeadlineExceeded:
				return err
			}
			slog.ErrorContext(ctx, "failed to receive from stream", slog.String("error", err.Error()))
			return status.Error(codes.Internal, "failed to read stream")
		}

		replyMsg := fmt.Sprintf("Echo: %s", req.Payload)

		if err := stream.Send(&StreamResponse{Payload: replyMsg}); err != nil {
			// Sama seperti di atas: Send yang gagal karena klien pergi
			// bukan kegagalan server.
			if c := status.Code(err); c == codes.Canceled || c == codes.Unavailable {
				return err
			}
			slog.ErrorContext(ctx, "failed to send to stream", slog.String("error", err.Error()))
			return status.Error(codes.Internal, "failed to write stream")
		}
	}
}

// ==============================================================================
// 3. UNIT TEST MENGGUNAKAN BUFCONN
// ==============================================================================

func TestBidirectionalStreamWithBufconn(t *testing.T) {
	const bufSize = 1024 * 1024
	lis := bufconn.Listen(bufSize)

	// 1. Setup Server
	grpcServer := grpc.NewServer()
	RegisterStreamingServiceServer(grpcServer, &myStreamingServer{})

	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("Server exited with error: %v", err)
		}
	}()
	defer grpcServer.Stop()

	// 2. Setup Client Dialing menggunakan bufconn
	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}

	ctx := context.Background()
	conn, err := grpc.NewClient("bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("Failed to dial bufnet: %v", err)
	}
	defer conn.Close()

	// 3. Buka koneksi stream dari client
	clientStream, err := conn.NewStream(ctx, &grpc.StreamDesc{
		StreamName:    "Chat",
		ServerStreams: true,
		ClientStreams: true,
	}, "/acme.api.v1.StreamingService/Chat")
	if err != nil {
		t.Fatalf("Failed to open stream: %v", err)
	}

	chatClient := &streamingServiceChatClient{clientStream}

	// 4. Goroutine untuk mengirim data ke server
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		messages := []string{"hello", "world", "streaming", "is", "awesome"}
		
		for _, msg := range messages {
			err := chatClient.Send(&StreamRequest{Payload: msg})
			if err != nil {
				t.Errorf("Client failed to send: %v", err)
				return
			}
		}
		
		// Klien HARUS memanggil CloseSend untuk menandai io.EOF di sisi server
		if err := chatClient.CloseSend(); err != nil {
			t.Errorf("Client failed to CloseSend: %v", err)
		}
	}()

	// 5. Menerima data respons dari server di thread utama
	receivedCount := 0
	for {
		resp, err := chatClient.Recv()
		if err == io.EOF {
			break // Server telah mereturn `nil`, stream berakhir sukses
		}
		if err != nil {
			t.Fatalf("Client received error from stream: %v", err)
		}
		
		expectedPrefix := "Echo: "
		if resp.Payload[:len(expectedPrefix)] != expectedPrefix {
			t.Fatalf("Unexpected response payload: %s", resp.Payload)
		}
		receivedCount++
	}

	wg.Wait()
	
	if receivedCount != 5 {
		t.Fatalf("Expected 5 responses, got %d", receivedCount)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Pemanggilan SendMsg() atau RecvMsg() secara Konkuren di Stream yang Sama
Di gRPC Go, aman untuk memiliki 1 goroutine memanggil `stream.Send()` dan 1 goroutine terpisah memanggil `stream.Recv()` secara bersamaan (karena aliran HTTP/2 memiliki jalurnya sendiri). Namun, memanggil `stream.Send()` dari *beberapa* goroutine sekaligus akan memicu *data race* internal pada HTTP/2 framer dan merusak stream.

```go
// BAD: Goroutine jamak memanggil Send() berbarengan (RACE CONDITION)
for _, user := range users {
    go func(u User) {
        stream.Send(&Response{Data: u}) // BAHAYA! 
    }(user)
}
```
**Mengapa berbahaya:** Jika terjadi tubrukan saat mem-frame data HTTP/2 ke memori, buffer internal akan terkorupsi. `grpc-go` akan mengalami kepanikan atau stream akan mati secara prematur dan tidak menentu, menjatuhkan stabilitas microservice.

```go
// GOOD: Gunakan Channel dan biarkan satu worker terdedikasi melakukan pengiriman
respChan := make(chan *Response, 100)
go func() {
    for resp := range respChan {
        if err := stream.Send(resp); err != nil {
            return
        }
    }
}()

// Worker pengumpul data mengirim ke channel
for _, user := range users {
    go func(u User) {
        respChan <- &Response{Data: u}
    }(user)
}
```

### ❌ Anti-Pattern 2: Melupakan Penanganan io.EOF pada Sisi Penerima
Para pemula di gRPC sering membuat block kode `if err != nil` secara naif, menyertakan `io.EOF` sebagai error kegagalan, kemudian me-log-nya di level `ERROR`.

```go
// BAD: io.EOF tercatat sebagai error aplikasi
req, err := stream.Recv()
if err != nil {
    log.Errorf("stream failed: %v", err) // Akan selalu me-log ERROR saat stream usai
    return status.Errorf(codes.Internal, "stream broken")
}
```
**Mengapa berbahaya:** Mengacaukan observabilitas Anda. Alert pada log agregator (seperti Kibana atau Datadog) akan terus-menerus terpicu karena setiap klien yang melakukan pemutusan normal akan dihitung sebagai insiden kritis.

```go
// GOOD: Filter io.EOF sebagai indikator normal penyelesaian stream
req, err := stream.Recv()
if err == io.EOF {
    // Klien selesai mengirim request. (Normal termination).
    return nil 
}
if err != nil {
    // True network / logic error
    log.Printf("stream error: %v", err)
    return err
}
```

## Edge Cases Khusus

1. **Deadlock Aliran Dua Arah (Bidirectional Deadlock)**: Jika Klien mengirim jutaan request secepat mungkin *tanpa* membaca response (Recv()), receive buffer TCP milik Klien akan terisi penuh. Saat buffer TCP penuh, mekanisme *backpressure* HTTP/2 memaksa Server untuk berhenti pada pemanggilan `Send()`. Karena `Send()` dari Server terblokir, goroutine server utama membeku dan tidak akan melanjutkan ke pemanggilan `Recv()`. Hasilnya: Klien dan Server akan terjebak menunggu satu sama lain untuk selamanya. Cara mengatasinya: Selalu pastikan klien menjalankan goroutine terpisah yang terus memompa (membaca) `Recv()` tanpa mempedulikan seberapa cepat `Send()` dipanggil.
2. **Koneksi Mati Separo (Half-Open TCP Connection)**: Jika laptop klien menutup paksa koneksi fisiknya (tanpa mengirimkan pesan TCP FIN) akibat kehilangan jangkauan Wi-Fi, Load Balancer (LB) atau server gRPC bisa terjebak berasumsi koneksi stream tersebut masih "hidup" tanpa henti. Memori di server tidak akan pernah bersih. Solusi: Nyalakan **gRPC Keepalive** parameter (`keepalive.EnforcementPolicy` dan `keepalive.ServerParameters`) saat membuat server agar melakukan pings TCP secara berkala dan memutus stream jika klien diam saja.
3. **Max Message Size Exceeded (Ukuran File)**: Saat melakukan *Streaming*, klien cenderung tidak sengaja mengirimkan satu payload raksasa melebihi 4MB. Karena stream didesain untuk data yang "dipecah menjadi serpihan (chunks)", ini akan meng-crash-kan stream secara instan. Anda harus selalu mendefinisikan batas khusus dengan `grpc.MaxRecvMsgSize(1024 * 1024 * 10)` pada inisialisasi Server jika ingin memperbolehkan satu payload chunk dalam stream melebihi batas default.
4. **Context Deadline Ignored**: Dalam stream yang berlangsung selama berjam-jam, propagasi timeout bisa menyesatkan. Jika koneksi diam dan Anda berada pada pemblokiran fungsi `stream.Recv()`, context server mungkin terbatalkan/expired, tetapi fungsi internal Anda yang lain tidak menyadarinya karena tidak memeriksa `ctx.Err()`. Lakukan multiplex (select) atas `ctx.Done()` setiap kali memanggil logika I/O tambahan agar sistem terurai dari blokir.

## Kapan JANGAN Pakai Ini

- **Untuk permintaan-respons biasa.** Streaming menambah manajemen siklus hidup, penanganan `io.EOF`, dan pemulihan koneksi — semuanya tanpa satu pun manfaat bila datanya memang satu potong.
- **Untuk data yang wajib sampai melewati restart.** Stream yang putus kehilangan posisinya kecuali Anda membangun kursor sendiri. Untuk pengiriman yang tidak boleh hilang, antrean durabel adalah alat yang benar.
- **`SendMsg`/`RecvMsg` dari beberapa goroutine pada stream yang sama.** Ini bukan pembatasan yang bisa dilanggar sesekali — ia merusak protokol. Satu goroutine pengirim, satu penerima, titik.
- **Stream berumur panjang tanpa keepalive.** Load balancer, NAT, dan firewall memutus koneksi yang diam. Aplikasi baru menyadarinya saat mencoba mengirim, sering beberapa menit setelah datanya seharusnya terkirim.
- **Streaming melewati proxy L4 tanpa dukungan HTTP/2.** Koneksi tampak hidup dan sehat, tetapi balancing tidak pernah terjadi — seluruh stream satu klien menempel di satu backend.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Stream mati setelah beberapa menit diam | idle timeout perantara | Keepalive tidak disetel di klien maupun server |
| Pesan hilang setelah reconnect | apakah ada kursor | Posisi stream tidak dipulihkan |
| Kerusakan data acak pada stream sibuk | jumlah goroutine yang menulis | `SendMsg` dipanggil konkuren |
| Satu backend jauh lebih sibuk | tipe proxy di depan | L4 menyeimbangkan koneksi, bukan permintaan |
| `code = Canceled` sangat banyak | siapa yang membatalkan | Klien pergi, atau context induk dibatalkan lebih awal |

```bash
curl -s localhost:9090/metrics | grep -E 'grpc_server_msg_(received|sent)_total'
kubectl logs -l app=api --since=1h | grep -cE 'code = (Unavailable|Canceled)'

# Perantara yang memutus stream di tengah jalan
kubectl logs -l app=ingress --since=1h | grep -ciE 'stream reset|GOAWAY'

# Log internal grpc-go: keepalive, resolver, dan penutupan koneksi
GRPC_GO_LOG_SEVERITY_LEVEL=info GRPC_GO_LOG_VERBOSITY_LEVEL=2 ./app 2>&1 | grep -i keepalive | head
```
