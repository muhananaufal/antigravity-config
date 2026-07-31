# gRPC-Gateway: Bridging REST dan gRPC

## Konsep dan Internals
Dalam adopsi gRPC (*HTTP/2 + Protobuf*), masalah terbesar biasanya adalah berhadapan dengan *Legacy Clients* (seperti Browser lama atau eksternal Webhook) yang hanya mampu mengirim permintaan standar **RESTful (HTTP/1.1 + JSON)**. 

Di sinilah **gRPC-Gateway** masuk. Ini adalah *reverse-proxy* terintegrasi yang membaca anotasi `google.api.http` di file `.proto` Anda. Pada runtime Golang, gRPC-Gateway (*ServeMux*) membungkus server gRPC, menyerap trafik masuk REST JSON, menerjemahkannya (*unmarshal*) ke dalam Protobuf biner, mengirimkannya ke layer gRPC internal, lalu membungkus respons baliknya kembali menjadi JSON ke Klien Eksternal. 

Faktor kunci pada transisi REST ke gRPC ini mencakup:
- **Header Mapping**: Translator mengonversi metadata gRPC (seperti Bearer Auth) menjadi `Authorization` HTTP header.
- **Status Code Mapping**: Menerjemahkan kode status gRPC (`codes.NotFound`, `codes.Unauthenticated`) ke standar HTTP response (`404 Not Found`, `401 Unauthorized`).
- **Middleware Stacking**: Server Go dapat menggunakan HTTP *Middleware* klasik (seperti `chi` router atau CORS pre-flight `OPTIONS`) di lapisan luar yang menyelimuti eksekusi *grpc-gateway* Mux.

## Diagram ASCII: Arsitektur gRPC-Gateway Reverse Proxy

```ascii
[Legacy Web Client]                   [Mobile Klien Modern]
       |                                       |
       | (POST /v1/users)                      | (RPC CreateUser)
       | { "name": "Budi" }                    | [ Biner Protobuf ]
       | Content-Type: application/json        | Content-Type: application/grpc
       v                                       |
+------------------------------------------+   |
| API Gateway / Go HTTP Server (Port 8080) |   |
|                                          |   |
|  +------------------------------------+  |   |
|  |  Chi Router (CORS & Rate Limiter)  |  |   |
|  +------------------------------------+  |   |
|                   |                      |   |
|  +------------------------------------+  |   |
|  |  runtime.ServeMux (gRPC-Gateway)   |  |   |
|  |  - JSON to Protobuf Marshal        |  |   |
|  |  - Convert 404 to codes.NotFound   |  |   |
|  +------------------------------------+  |   |
|                   |                      |   |
+-------------------|----------------------+   |
                    | (Internal Call)          |
                    v                          v
+--------------------------------------------------------------+
|                gRPC Server (Port 50051)                      |
|  - Middleware Logging & Auth                                 |
|  - Domain Handler / Business Logic                           |
+--------------------------------------------------------------+
```

## Production-Ready Code & Testing
Skrip lengkap di bawah membuktikan bagaimana Anda menyatukan `runtime.ServeMux` (Gateway HTTP) dengan `bufconn` (In-Memory gRPC), kemudian mengujinya sebagai klien HTTP JSON melalui modul `httptest` Go standar, yang memperlihatkan propagasi *Context Deadline* dan HTTP code.

```go
package grpcgateway_test

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE (WITH HTTP ANNOTATIONS)
// Normalnya grpc-gateway menghasilkan file *.pb.gw.go
// ==============================================================================
type UserRequest struct { Id string }
type UserResponse struct { Name string }

type UserServiceServer interface {
	GetUser(context.Context, *UserRequest) (*UserResponse, error)
}
func RegisterUserServiceServer(s grpc.ServiceRegistrar, srv UserServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "api.v1.UserService",
		HandlerType: (*UserServiceServer)(nil),
		Methods: []grpc.MethodDesc{{
			MethodName: "GetUser",
			Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
				return srv.(UserServiceServer).GetUser(ctx, &UserRequest{Id: "123"})
			},
		}},
		Streams: []grpc.StreamDesc{}, Metadata: "user.proto",
	}, srv)
}

// Simulasi manual registrasi Handler gRPC-Gateway dari file *.pb.gw.go
func RegisterUserServiceHandlerClient(ctx context.Context, mux *runtime.ServeMux, endpoint string, opts []grpc.DialOption) error {
	// Gateway membuka koneksi balik ke gRPC server asli (In-Memory dialer akan di pass lewat opt)
	conn, err := grpc.Dial(endpoint, opts...)
	if err != nil { return err }

	// Mendaftarkan pattern HTTP REST ke rute Gateway
	// Di aslinya, ini otomatis diambil dari annotasi: option (google.api.http) = { get: "/v1/users/{id}" };
	mux.Handle("GET", runtime.MustPattern(runtime.NewPattern(1, []int{2, 0, 2, 1, 1, 0, 4, 1, 5, 2}, []string{"v1", "users", "id"}, "")), func(w http.ResponseWriter, req *http.Request, pathParams map[string]string) {
		
		// Klien HTTP memanggil Gateway. Gateway mensarikan variabel path (ID).
		idParam := pathParams["id"]
		
		// Gateway mengirim RPC call ke belakang
		resp := new(UserResponse)
		err := conn.Invoke(req.Context(), "/api.v1.UserService/GetUser", &UserRequest{Id: idParam}, resp)
		
		// Jika error/sukses, format ulang ke JSON HTTP (diwakili fungsi internal runtime di production)
		if err != nil {
			st, _ := status.FromError(err)
			http.Error(w, st.Message(), runtime.HTTPStatusFromCode(st.Code()))
			return
		}
		
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"name":"` + resp.Name + `"}`))
	})
	return nil
}

// ==============================================================================
// 2. DOMAIN LOGIC SERVER
// ==============================================================================
type myUserServer struct{}
func (s *myUserServer) GetUser(ctx context.Context, req *UserRequest) (*UserResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.Canceled, "canceled by context")
	}
	
	if req.Id != "123" {
		// Mengembalikan error native gRPC
		return nil, status.Errorf(codes.NotFound, "user %s not found in database", req.Id)
	}
	return &UserResponse{Name: "John Doe"}, nil
}

// ==============================================================================
// 3. UNIT TEST E2E: KLIEN REST HTTP -> GATEWAY -> GRPC BUFCONN -> DOMAIN
// ==============================================================================
func TestGRPCGateway_HTTPBridge(t *testing.T) {
	lis := bufconn.Listen(1024 * 1024)
	
	// A. Bangun gRPC Server Murni
	grpcServer := grpc.NewServer()
	RegisterUserServiceServer(grpcServer, &myUserServer{})
	go func() { _ = grpcServer.Serve(lis) }()
	defer grpcServer.Stop()

	// Setup custom dialer untuk gRPC Gateway agar me-resolve koneksi in-memory bufconn
	dialer := func(ctx context.Context, s string) (net.Conn, error) { return lis.Dial() }
	dialOpts := []grpc.DialOption{
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}

	// B. Bangun HTTP gRPC-Gateway Mux
	ctx := context.Background()
	gwMux := runtime.NewServeMux(
		// Konfigurasi Translasi Metadata Header -> HTTP Header dan sebaliknya jika diperlukan
		runtime.WithOutgoingHeaderMatcher(runtime.DefaultHeaderMatcher),
	)
	
	// Gateway menyambung ke gRPC asli ("bufnet" akan ditangkap dialer di atas)
	err := RegisterUserServiceHandlerClient(ctx, gwMux, "bufnet", dialOpts)
	if err != nil { t.Fatalf("Failed to register gateway: %v", err) }

	// C. Uji Sebagai Klien REST tulen (Tidak sadar bahwa backend-nya gRPC)
	httpServer := httptest.NewServer(gwMux)
	defer httpServer.Close()

	t.Run("Valid REST GET Request", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/v1/users/123")
		if err != nil { t.Fatalf("HTTP Get failed: %v", err) }
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Errorf("Expected 200 OK, got %d", resp.StatusCode)
		}

		body, _ := io.ReadAll(resp.Body)
		if string(body) != `{"name":"John Doe"}` {
			t.Errorf("Unexpected body JSON: %s", string(body))
		}
	})

	t.Run("Error 404 Translation", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/v1/users/999")
		if err != nil { t.Fatalf("HTTP Get failed: %v", err) }
		defer resp.Body.Close()

		// Gateway harus dengan pintar menerjemahkan codes.NotFound (gRPC) jadi 404 (HTTP)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("Expected 404 Not Found, got %d", resp.StatusCode)
		}
		
		body, _ := io.ReadAll(resp.Body)
		if string(body) != "user 999 not found in database\n" {
			t.Errorf("Unexpected error body: %s", string(body))
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengadopsi HTTP Quirks (seperti Form-Data) langsung di Domain Logika
Ketika menggunakan Gateway, developer sering ingin mengambil data *Multipart Form Upload* atau elemen spesifik URI. Mereka lantas mencoba mengakses instance `*http.Request` dengan mengekstrak Context di dalam Handler Domain gRPC.

```go
// BAD: Domain gRPC berusaha membaca header spesifik HTTP secara kotor
func (s *server) Upload(ctx context.Context, req *Request) (*Resp, error) {
    // Membongkar metadata grpc untuk mengakali HTTP Form
    md, _ := metadata.FromIncomingContext(ctx)
    if md["x-http-multipart"] != nil { 
        // Parah! Domain gRPC menjadi sangat coupled/terikat dengan protokol HTTP
    }
}
```
**Mengapa berbahaya:** Jika di masa depan sebuah service internal gRPC Go memanggil method `Upload` ini (RPC-ke-RPC murni), service tersebut akan gagal karena logic di atas sangat manja dan meminta format HTTP.

**Benar:** Gunakan `grpc-gateway` untuk sepenuhnya menangani HTTP. Anotasikan Protobuf dengan akurat (misalnya JSON body mapping menggunakan klausa `body: "*"`). Logic gRPC dalam fungsi `Upload` harus 100% independen dan buta (*agnostic*) terhadap bagaimana data serialisasi (JSON/HTTP) terjadi.

### ❌ Anti-Pattern 2: Penanganan Kode Status Campuran (Mixed Errors)
Klien melakukan REST Request, tetapi server justru mereturn kode error Go HTTP spesifik alih-alih me-return `status.Errorf(codes.X)` milik gRPC.

```go
// BAD: Menggunakan HTTP library dalam gRPC implementation logic.
import "net/http"
func (s *server) GetData(ctx context.Context, req *Req) (*Resp, error) {
    // Membingungkan Gateway dan RPC klien tulen
    return nil, fmt.Errorf("http error: %d", http.StatusBadGateway) 
}
```
**Mengapa berbahaya:** Jika Anda mencampurkan respons native HTTP dengan gRPC domain, Gateway gagal menerjemahkan *HTTP Error* yang diselipkan sebagai *string message* tersebut, dan berujung selalu merespons kode generik HTTP 500 (Internal Server Error) ke Klien REST, membuat debbuging sangat traumatis. 

**Benar:** Domain logic HANYA mereturn format package `google.golang.org/grpc/codes`. Gateway memiliki pustaka *mapping* internal (contoh: `codes.InvalidArgument` dikonversi patuh menjadi `400 Bad Request`).

## Edge Cases Khusus

1. **Pemetaan Query Parameter Ganda**: Di Protobuf, jika Anda memiliki list string untuk URI (*query parameter* bersarang), anotasi `google.api.http` mengekstrak parameter seperti `?id=1&id=2`. Jika klien Web mengirimnya dengan gaya PHP lama (`?id[]=1&id[]=2`), Gateway default akan memandangnya sebagai properti tidak valid, menyebabkan *Bad Request*. Tambahkan konvensi khusus pada Middleware *Chi router* Anda (layer sebelum *mux*) untuk men-sanitize format *bracket* tersebut.
2. **CORS (Cross-Origin Resource Sharing) Pre-Flight Mati**: Klien React.js melempar HTTP method `OPTIONS /v1/users` sebelum mem-POST JSON. `grpc-gateway` mux standar tidak mengerti *request OPTIONS* dan akan memuntahkan error `Method Not Allowed (405)`. Cara wajib mengatasinya: Anda harus membungkus `gwMux` dalam HTTP Middleware klasik (misal menggunakan paket *rs/cors*) pada Layer Web HTTP Anda, *sebelum* mem-pass-down `ServeHTTP` tersebut ke *gateway mux*.
3. **Context Timeout Header (`Grpc-Timeout`)**: Proxy HTTP canggih (seperti Envoy atau Nginx ingress) kadang mengirim tajuk (*header*) `Grpc-Timeout: 1S` meskipun trafik masuk sebagai REST. Gateway mampu mem-parsing HTTP *Header* ini dan menyetrum `Context.Deadline` gRPC internal Anda menjadi 1 detik. Jika developer mengabaikan `ctx.Err()` pada perulangan for / fungsi berat (menyerahkan nasib pada *garbage collection*), sistem akan terus memproses request REST yang sebetulnya sudah dibatalkan. Selalu hargai propagasi Deadline.
