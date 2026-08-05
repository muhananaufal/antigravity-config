# gRPC Interceptors & Middleware: Konsep, Implementasi, dan Best Practices

> **Berlaku:** Go 1.21+ · `grpc-go` v1.60+ · `go-grpc-middleware` v2 · **Lihat juga:** `microservices_grpc/grpc_streaming_patterns.md` · `observability_resilience/opentelemetry_tracing.md` · `observability_resilience/rate_limiting_patterns.md` · `microservices_grpc/rest_chi_middleware_stack.md`

## Konsep dan Internals
Dalam ekosistem gRPC, middleware disebut sebagai **Interceptors**. Interceptors memungkinkan kita untuk mencegat (intercept) eksekusi dari panggilan RPC (Remote Procedure Call) baik di sisi client maupun server. Konsep ini sangat mirip dengan middleware di HTTP/REST (seperti pada Chi, Gin, atau Express), dan merupakan tempat yang ideal untuk menangani *cross-cutting concerns* seperti:
- **Authentication & Authorization** (contoh: validasi JWT, pengecekan RBAC).
- **Observability** (contoh: Logging, Tracing dengan OpenTelemetry, Metrics dengan Prometheus).
- **Resiliency** (contoh: Rate Limiting, Timeout, Retry mechanics, Panic Recovery).
- **Payload Validation** (contoh: memvalidasi struktur data sebelum masuk ke layer domain).

Terdapat dua tipe interceptor utama di gRPC:
1. **Unary Interceptors**: Mencegat request-response tunggal (simple RPC).
2. **Stream Interceptors**: Mencegat streaming RPC. Mereka membungkus interface `grpc.ServerStream` (atau `grpc.ClientStream` di sisi client) untuk memantau siklus hidup dari stream.

Sejak rilis `grpc-go` versi 1.28, kita tidak lagi memerlukan library eksternal (seperti `go-grpc-middleware`) untuk menggabungkan beberapa interceptor. Fungsi bawaan `grpc.ChainUnaryInterceptor` dan `grpc.ChainStreamInterceptor` sudah menyediakan mekanisme *chaining* (penggabungan) secara rapi.

Urutan eksekusi interceptor adalah sangat krusial. Urutan yang direkomendasikan umumnya adalah dari lapisan terluar hingga terdalam (mendekati handler utama):
1. **Recovery / Panic Handler**: Harus paling luar agar bisa menangkap *panic* dari interceptor lain.
2. **Tracing / Correlation ID**: Membuat/melanjutkan context trace secepat mungkin.
3. **Metrics & Logging**: Mengukur durasi total request.
4. **Authentication**: Menolak akses yang tidak sah sebelum memproses beban kerja berat.
5. **Authorization / RBAC**: Memastikan user berhak mengakses *method* tertentu.
6. **Validation**: Validasi payload.

## Diagram ASCII: Arsitektur Eksekusi Interceptor

```ascii
[gRPC Client]
      | 
      | (Kirim Request & Metadata)
      v
+--------------------------------------------------------------------------------+
|  gRPC Server                                                                   |
|                                                                                |
|  +--------------------------------------------------------------------------+  |
|  | 1. Recovery Interceptor (Paling Luar)                                    |  |
|  |    - defer recover() untuk mencegah server crash                         |  |
|  |   +--------------------------------------------------------------------+ |  |
|  |   | 2. Logging Interceptor                                             | |  |
|  |   |    - Catat start time, request path                                | |  |
|  |   |   +--------------------------------------------------------------+ | |  |
|  |   |   | 3. Auth Interceptor (JWT)                                    | | |  |
|  |   |   |    - Validasi token di metadata                              | | |  |
|  |   |   |   +--------------------------------------------------------+ | | |  |
|  |   |   |   | Handler (Business Logic)                               | | | |  |
|  |   |   |   |    - Eksekusi layanan utama                            | | | |  |
|  |   |   |   +--------------------------------------------------------+ | | |  |
|  |   |   |    - Return (Response / Error)                               | | |  |
|  |   |   +--------------------------------------------------------------+ | |  |
|  |   |    - Catat end time & durasi eksekusi                              | |  |
|  |   +--------------------------------------------------------------------+ |  |
|  |    - Translasi Panic ke gRPC Status Internal                             |  |
|  +--------------------------------------------------------------------------+  |
+--------------------------------------------------------------------------------+
      | (Kirim Response & Trailer)
      v
[gRPC Client]
```

## Production-Ready Code & Testing
Kode berikut mendemonstrasikan implementasi interceptor yang *production-ready* dengan `ChainUnaryInterceptor`, penanganan context, propagasi metadata, serta testing in-memory menggunakan `google.golang.org/grpc/test/bufconn`. 

> **Catatan**: Dalam produksi, struktur `.proto` biasanya di-generate oleh `protoc`. Di sini kita mensimulasikan struct dan interface manual yang semirip mungkin dengan hasil *codegen* tersebut untuk tujuan testing mandiri.

```go
package grpcinterceptors_test

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net"
	"runtime/debug"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// kunciPengguna adalah tipe PRIVAT untuk kunci context.
//
// Memakai string telanjang (`ctx.Value("userID")`) berarti paket lain --
// pustaka tracing, framework, middleware pihak ketiga -- yang kebetulan
// memakai kunci "userID" akan menimpa atau membaca nilai Anda. Tidak ada
// galat kompilasi, tidak ada galat runtime; hanya identitas yang kadang
// salah.
type kunciCtx string

const kunciPengguna kunciCtx = "userID"

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE
// Normalnya ini di-generate otomatis dari file `.proto` menggunakan `protoc`.
// ==============================================================================
type PingRequest struct {
	Message string
}

type PingResponse struct {
	Reply string
}

type PingServiceServer interface {
	Ping(context.Context, *PingRequest) (*PingResponse, error)
}

func RegisterPingServiceServer(s grpc.ServiceRegistrar, srv PingServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.PingService",
		HandlerType: (*PingServiceServer)(nil),
		Methods: []grpc.MethodDesc{
			{
				MethodName: "Ping",
				Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
					in := new(PingRequest)
					if err := dec(in); err != nil {
						return nil, err
					}
					if interceptor == nil {
						return srv.(PingServiceServer).Ping(ctx, in)
					}
					info := &grpc.UnaryServerInfo{
						Server:     srv,
						FullMethod: "/acme.api.v1.PingService/Ping",
					}
					handler := func(ctx context.Context, req interface{}) (interface{}, error) {
						return srv.(PingServiceServer).Ping(ctx, req.(*PingRequest))
					}
					return interceptor(ctx, in, info, handler)
				},
			},
		},
		Streams:  []grpc.StreamDesc{},
		Metadata: "ping.proto",
	}, srv)
}

// ==============================================================================
// 2. IMPLEMENTASI MIDDLEWARE (INTERCEPTORS)
// ==============================================================================

// RecoveryInterceptor memastikan panic tidak mematikan instance server gRPC.
func RecoveryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp interface{}, err error) {
		defer func() {
			if r := recover(); r != nil {
				// STACK TRACE ADALAH SATU-SATUNYA HAL YANG BENAR-BENAR
				// DIBUTUHKAN DI SINI. Panic yang di-recover memutus jejaknya:
				// tanpa debug.Stack(), yang tersisa hanya pesan seperti
				// "database connection lost" tanpa satu pun petunjuk baris
				// mana yang memicunya. Insiden menjadi tebakan.
				slog.ErrorContext(ctx, "panic dipulihkan di handler gRPC",
					slog.String("method", info.FullMethod),
					slog.Any("panic", r),
					slog.String("stack", string(debug.Stack())),
				)

				// Ke klien: hanya codes.Internal. Detail panic tidak boleh
				// menyeberang -- ia memuat nama fungsi, path berkas, dan
				// kadang nilai variabel.
				err = status.Error(codes.Internal, "internal server error")
			}
		}()
		
		// Lanjutkan eksekusi ke handler / interceptor selanjutnya
		return handler(ctx, req)
	}
}

// AuthInterceptor memvalidasi Bearer token JWT statis.
func AuthInterceptor(validToken string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		// Mengekstrak metadata dari context (mirip seperti Header di HTTP)
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			return nil, status.Error(codes.Unauthenticated, "metadata missing")
		}

		authHeader := md.Get("authorization")
		if len(authHeader) == 0 {
			return nil, status.Error(codes.Unauthenticated, "authorization token missing")
		}

		expectedHeader := "Bearer " + validToken
		// Perbandingan konstan waktu. `!=` biasa berhenti pada byte pertama
		// yang berbeda, sehingga waktu responsnya membocorkan berapa banyak
		// prefiks token yang sudah benar -- cukup untuk menebak token
		// karakter demi karakter dari jarak jauh.
		if subtle.ConstantTimeCompare([]byte(authHeader[0]), []byte(expectedHeader)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "invalid or expired token")
		}

		// Menyuntikkan identitas ke context. Kunci WAJIB bertipe privat --
		// string telanjang bisa ditimpa paket lain yang kebetulan memakai
		// kunci yang sama, diam-diam.
		return handler(context.WithValue(ctx, kunciPengguna, "user_123"), req)
	}
}

// ==============================================================================
// 3. IMPLEMENTASI HANDLER DOMAIN
// ==============================================================================

type myPingServer struct{}

func (s *myPingServer) Ping(ctx context.Context, req *PingRequest) (*PingResponse, error) {
	// Menyimulasikan panic jika request berbunyi khusus
	if req.Message == "trigger_panic" {
		panic("database connection lost unexpectedly")
	}
	
	// Menyimulasikan proses yang memakan waktu (untuk test deadline/cancellation)
	if req.Message == "sleep" {
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return nil, status.Error(codes.Canceled, "request canceled by client")
		}
	}
	
	return &PingResponse{Reply: "Pong " + req.Message}, nil
}

// ==============================================================================
// 4. UNIT TEST MENGGUNAKAN BUFCONN
// ==============================================================================

func TestInterceptorsWithBufconn(t *testing.T) {
	const bufSize = 1024 * 1024
	lis := bufconn.Listen(bufSize)

	// 1. Setup Server dengan Interceptors
	grpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			RecoveryInterceptor(),
			AuthInterceptor("super-secret-token"),
		),
	)
	RegisterPingServiceServer(grpcServer, &myPingServer{})

	// Jalankan server di goroutine
	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("Server exited with error: %v", err)
		}
	}()
	defer grpcServer.Stop()

	// 2. Setup Client Dialing menggunakan bufconn (In-Memory Network)
	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}

	ctx := context.Background()
	conn, err := grpc.DialContext(ctx, "bufnet", 
		grpc.WithContextDialer(dialer), 
		grpc.WithInsecure(), // Menggunakan WithInsecure() untuk testing lokal adalah umum
	)
	if err != nil {
		t.Fatalf("Failed to dial bufnet: %v", err)
	}
	defer conn.Close()

	// Simulasi pemanggilan RPC client manual menggunakan Invoke
	// Normalnya kita akan menggunakan struct client hasil generate protoc
	
	t.Run("Missing Auth Token", func(t *testing.T) {
		req := &PingRequest{Message: "hello"}
		resp := &PingResponse{}
		
		err := conn.Invoke(ctx, "/acme.api.v1.PingService/Ping", req, resp)
		if err == nil {
			t.Fatal("Expected error due to missing auth, got nil")
		}
		
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.Unauthenticated {
			t.Fatalf("Expected Unauthenticated code, got %v", err)
		}
	})

	t.Run("Valid Request Success", func(t *testing.T) {
		md := metadata.Pairs("authorization", "Bearer super-secret-token")
		authCtx := metadata.NewOutgoingContext(ctx, md)
		
		req := &PingRequest{Message: "hello"}
		resp := &PingResponse{}
		
		err := conn.Invoke(authCtx, "/acme.api.v1.PingService/Ping", req, resp)
		if err != nil {
			t.Fatalf("Expected success, got err: %v", err)
		}
		
		if resp.Reply != "Pong hello" {
			t.Fatalf("Unexpected reply: %s", resp.Reply)
		}
	})

	t.Run("Panic Recovery Test", func(t *testing.T) {
		md := metadata.Pairs("authorization", "Bearer super-secret-token")
		authCtx := metadata.NewOutgoingContext(ctx, md)
		
		req := &PingRequest{Message: "trigger_panic"}
		resp := &PingResponse{}
		
		err := conn.Invoke(authCtx, "/acme.api.v1.PingService/Ping", req, resp)
		if err == nil {
			t.Fatal("Expected error from panic, got nil")
		}
		
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.Internal {
			t.Fatalf("Expected Internal error (recovered), got %v", err)
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengembalikan Error Go Native saat Panic Recovery
Saat men-intercept panic, Anda harus selalu mengembalikan error dalam bentuk tipe gRPC Status, bukan error Go native standar seperti `fmt.Errorf` atau `errors.New`.

```go
// BAD: Mengembalikan error native yang transparan dan tidak terformat
defer func() {
    if r := recover(); r != nil {
        err = fmt.Errorf("panic occurred: %v", r)
    }
}()
```
**Mengapa berbahaya:** Jika Anda menggunakan error biasa, gRPC client di sisi seberang akan secara otomatis menerjemahkannya menjadi status code `codes.Unknown`. Client tidak akan tahu apakah ini masalah sementara (seperti `Internal` atau `Unavailable`) yang bisa di-retry, atau kesalahan data. Selain itu, mengekspos detail stack-trace *panic* (`%v`) ke client berpotensi membocorkan arsitektur internal atau kode sumber yang dapat dieksploitasi dalam skenario serangan siber.

```go
// GOOD: Gunakan gRPC status dan sembunyikan detail dari pengguna akhir
defer func() {
    if r := recover(); r != nil {
        // Log panic dengan stacktrace ke log internal Anda di sini
        err = status.Errorf(codes.Internal, "internal server error")
    }
}()
```

### ❌ Anti-Pattern 2: Memodifikasi/Mutasi Context Metadata Secara Langsung
Metadata gRPC disuntikkan ke dalam `context.Context` sebagai tipe peta (`map[string][]string`). Jika Anda memodifikasinya secara langsung dalam interceptor untuk menambahkan data, itu memicu *data race*.

```go
// BAD: Mutasi langsung dari hasil ekstraksi
md, _ := metadata.FromIncomingContext(ctx)
md["x-custom-id"] = []string{"new-value"} // BISA MENYEBABKAN PANIC KARENA CONCURRENT MAP WRITE!
return handler(ctx, req)
```
**Mengapa berbahaya:** Peta (`map`) di Go tidak *thread-safe*. Karena gRPC sering menggunakan kembali context di seluruh layer, mutasi *in-place* akan menyebabkan _concurrent map writes_ fatal jika ada goroutine lain (atau interceptor stream) yang juga membaca/menulis metadata, menjatuhkan *keseluruhan server process*.

```go
// GOOD: Gunakan Copy() untuk menduplikasi metadata sebelum modifikasi
md, ok := metadata.FromIncomingContext(ctx)
if ok {
    newMD := md.Copy()
    newMD["x-custom-id"] = []string{"new-value"}
    ctx = metadata.NewIncomingContext(ctx, newMD)
}
return handler(ctx, req)
```

### ❌ Anti-Pattern 3: Melupakan Stream Interceptor untuk Authentication
Seringkali pengembang hanya mendefinisikan `grpc.UnaryInterceptor` karena banyak panggilan pertama mereka bersifat unary, sementara API Streaming tertinggal tanpa pengamanan.

```go
// BAD: Stream API tidak akan melewati filter auth
server := grpc.NewServer(
    grpc.UnaryInterceptor(AuthInterceptor),
)
```
**Mengapa berbahaya:** Endpoint *Server Streaming* atau *Bidirectional Streaming* akan terbuka lebar untuk publik tanpa perlindungan autentikasi. Seseorang dapat mengakses fungsi seperti ekspor data real-time, atau menghabiskan _bandwidth_ dengan mengirimkan stream tiada henti, *bypassing* seluruh firewall middleware.

```go
// GOOD: Gunakan Unary dan Stream interceptors dengan logika auth yang serupa (diekstraksi)
server := grpc.NewServer(
    grpc.UnaryInterceptor(AuthUnaryInterceptor),
    grpc.StreamInterceptor(AuthStreamInterceptor),
)
```

## Edge Cases Khusus

1. **Context Cancellation di Tengah Interceptor Chain**: Interceptor tertentu (misalnya, melakukan remote request OIDC key fetching untuk validasi JWT) bisa memakan waktu lama. Saat ia sedang bekerja, klien mungkin membatalkan gRPC request karena _timeout_. Jika Anda tidak secara proaktif memeriksa `ctx.Err()` di dalam interceptor sebelum meneruskan ke `handler(ctx, req)`, beban kerja berat di _domain logic_ tetap akan dipanggil, menghabiskan memori dan CPU server sia-sia meskipun *client* sudah pergi.
2. **Besaran Metadata Limit (Header Bomb)**: gRPC, di atas HTTP/2, memiliki batas *header list size*. Jika Anda membaca *metadata* di interceptor dan menyimpan keseluruhan valuenya di *in-memory* logging (contoh: me-log seluruh payload headers), klien jahat dapat mengirimkan ribuan *key* palsu dan memaksa log-aggregator (atau RAM server Anda) OOM (Out-of-Memory). Letakkan interceptor size limiter atau logging yang aman (*truncate* string panjang) di titik paling awal (segera setelah panic recovery).
3. **Panic(Nil)**: Di Go, sangat memungkinkan untuk menjalankan kode bodoh seperti `panic(nil)`. Jika *panic handler* Anda hanya mengecek `if r := recover(); r != nil`, maka `panic(nil)` akan menyelinap dan menyebabkan *uncaught crash*. Untuk mendeteksi `panic(nil)`, dibutuhkan *wrapper flag* boolean di samping *recover*, atau sekadar memastikan Anda selalu menggunakan tipe *error* ketika meng-invoke panic dalam basis kode internal.
4. **Waktu Propagasi Timeout/Deadline**: Ketika *intercepting*, pastikan Anda tidak secara tidak sengaja "mereset" *context deadline*. Terkadang developer menggunakan `context.Background()` sebagai *base* baru untuk spawn *worker* di interceptor dan lupa melampirkan deadline asli. Hal ini dapat menyebabkan masalah goroutine leaking jika stream tersebut pada akhirnya menggantung karena tidak adanya timeout. Selalu buat turunan *context* dengan `context.WithTimeout` dari context asal gRPC jika Anda butuh perpanjangan sementara, dan jangan lupa panggil `cancel()`.

## Kapan JANGAN Pakai Ini

- **Logika bisnis di dalam interceptor.** Interceptor berjalan untuk **setiap** metode. Aturan yang hanya berlaku untuk sebagian metode akan tumbuh menjadi daftar pengecualian yang makin panjang, dan daftar itu akan ketinggalan saat metode baru ditambahkan.
- **Memodifikasi `metadata.MD` yang diterima di tempat.** Metadata masuk boleh dibaca, tidak boleh diubah. Salin dulu dengan `md.Copy()`; mengubahnya langsung menghasilkan data race yang sulit ditelusuri.
- **Recovery yang mengembalikan galat Go apa adanya.** Klien gRPC hanya memahami `status.Error`. Galat mentah sampai sebagai `Unknown` tanpa kode yang bisa ditindaklanjuti klien — dan retry otomatis di sisi klien jadi tidak mungkin.
- **Hanya memasang unary interceptor.** Autentikasi yang lupa dipasang di stream interceptor berarti **seluruh** metode streaming tidak terlindungi, dan itu tidak akan pernah ketahuan dari uji unary.
- **Menyimpan state per-permintaan di struct interceptor.** Interceptor dibagi antar seluruh permintaan. Apa pun yang bersifat per-permintaan harus lewat context.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Banyak `code = Unknown` di metrik | pembungkusan galat | Galat tidak dikonversi ke `status.Error` |
| Metode streaming bisa diakses tanpa token | stream interceptor terpasang atau tidak | Auth hanya dipasang di jalur unary |
| Proses mati karena panic satu permintaan | recovery interceptor | Tidak ada jaring pengaman panic |
| Data antar permintaan tercampur | state di struct interceptor | Interceptor dibagi, state-nya tidak boleh |
| Trace terputus tepat di gRPC | urutan interceptor | Interceptor tracing dipasang setelah yang lain |

```bash
grpcurl -plaintext localhost:9090 list
grpcurl -plaintext localhost:9090 pkg.Layanan/Metode          # tanpa token: harus ditolak
grpcurl -plaintext -H 'authorization: Bearer x' localhost:9090 pkg.Layanan/StreamMetode

# Kode status selain OK -- Unknown yang banyak berarti galat tidak dibungkus
curl -s localhost:9090/metrics | grep grpc_server_handled_total | grep -v 'code="OK"'

kubectl logs -l app=api --since=1h | grep -c 'code = Unknown'
```
