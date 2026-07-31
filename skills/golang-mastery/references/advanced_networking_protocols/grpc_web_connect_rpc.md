# gRPC-Web & Connect RPC di Ekosistem Go

## 1. Konsep Utama & Internals
gRPC beroperasi murni di atas HTTP/2 dengan implementasi *binary framing* dan *trailing headers* yang ketat. Arsitektur ini menantang bagi klien web browser karena API native browser (`fetch` atau XHR) tidak mengizinkan pembacaan langsung dari *trailing headers* di HTTP/2 sebelum stream selesai. Hal ini melahirkan gRPC-Web (protokol modifikasi berbasis HTTP/1.1 atau HTTP/2 tanpa trailer).

Namun, **Connect RPC** (kini dikelola oleh CNCF) telah merevolusi pola ini. Connect adalah protokol dan pustaka (library) *multi-protocol*. Dalam Go (`connectrpc.com/connect`), Connect memungkinkan satu *handler* `net/http` standar untuk melayani tiga protokol secara bersamaan tanpa proxy sidecar (seperti Envoy). Connect secara otomatis mendeteksi dan melakukan demultiplexing protokol berdasarkan `Content-Type` dari request:
1. **gRPC standard** (`application/grpc`): untuk komunikasi *service-to-service* via HTTP/2.
2. **gRPC-Web** (`application/grpc-web+proto` / `+json`): untuk frontend SPA/React/Vue.
3. **Connect Protocol** (`application/json` atau `application/proto` via HTTP/1.1 / HTTP/2): Protokol REST-like RPC asli yang sangat ramah terhadap `curl` dan network inspector browser.

## 2. Diagram Arsitektur / Aliran (ASCII)
```text
  [Browser JS / React]          [Mobile App / iOS]             [Go Microservice B]
  (Connect JSON/HTTP1)             (gRPC-Web)                  (gRPC Standard HTTP2)
           |                           |                                 |
           +---------------------------+---------------------------------+
                                       |
                   [ Load Balancer (AWS ALB / NGINX / K8s Ingress) ]
                                       |
   =============================================================================
   | Go `net/http` Server (Port 8080)                                          |
   |                                                                           |
   |   +-------------------------------------------------------------------+   |
   |   | connect-go Mux (Otomatis Mendeteksi & Me-routing Protokol)        |   |
   |   +-------------------------------------------------------------------+   |
   |             | (Interceptors: Auth, Logging, Metrics)                      |
   |             v                                                             |
   |   +-------------------------------------------------------------------+   |
   |   | Generated Protobuf Handler Logic (MyService.Greet)                |   |
   |   +-------------------------------------------------------------------+   |
   =============================================================================
```

## 3. Production-Ready Go Code

Kode di bawah menunjukkan setup handler Connect RPC dengan interceptor yang memproses header/context secara aman, *cors*, dan manajemen *timeout*.

```go
package connectrpc

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"time"

	"connectrpc.com/connect"
	// Asumsi di-generate oleh buf:
	// "myproject/gen/greet/v1"
	// "myproject/gen/greet/v1/greetv1connect"
)

// Dummy types untuk simulasi generated protobuf code
type GreetRequest struct{ Name string }
type GreetResponse struct{ Greeting string }

// GreetService mengimplementasikan generated interface
type GreetService struct{}

// Greet adalah implementasi method unary RPC.
func (s *GreetService) Greet(
	ctx context.Context,
	req *connect.Request[GreetRequest],
) (*connect.Response[GreetResponse], error) {
	// 1. Ekstraksi Context
	userID, ok := ctx.Value("userID").(string)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("missing user identity"))
	}

	if req.Msg.Name == "" {
		// Mengembalikan Connect standard error (map otomatis ke gRPC status 400 Invalid Argument)
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name cannot be empty"))
	}
	
	res := connect.NewResponse(&GreetResponse{
		Greeting: "Hello " + req.Msg.Name + ", you are " + userID,
	})
	res.Header().Set("X-Custom-Greeting", "v1")
	return res, nil
}

// AuthInterceptor mengekstrak HTTP Headers tanpa peduli protokol
func AuthInterceptor() connect.UnaryInterceptorFunc {
	return connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(
			ctx context.Context,
			req connect.AnyRequest,
		) (connect.AnyResponse, error) {
			// Connect RPC membungkus header HTTP/1 dan HTTP/2 menjadi map yang sama
			token := req.Header().Get("Authorization")
			if token != "Bearer valid-token" {
				return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid token"))
			}

			// Injeksi ke Go context standar
			ctx = context.WithValue(ctx, "userID", "user-123")
			
			return next(ctx, req)
		})
	})
}

// SetupConnectServer mensimulasikan registrasi mux yang production-ready
func SetupConnectServer() *http.ServeMux {
	mux := http.NewServeMux()
	
	// Dalam kode nyata, Anda memanggil generated func:
	// path, handler := greetv1connect.NewGreetServiceHandler(
	// 	&GreetService{},
	// 	connect.WithInterceptors(AuthInterceptor()),
	// )
	// mux.Handle(path, handler)
	
	// Mock implementasi route (simulasi dari connect-go generated handler)
	mux.HandleFunc("/greet.v1.GreetService/Greet", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Simulasi AuthInterceptor
		if r.Header.Get("Authorization") != "Bearer valid-token" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code": "unauthenticated", "message": "invalid token"}`))
			return
		}
		
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"greeting": "Hello mock, you are user-123"}`))
	})

	return mux
}

// 1. Test Kasus Sukses dengan httptest Server Nyata
func TestConnectRPC_Success(t *testing.T) {
	mux := SetupConnectServer()
	server := httptest.NewServer(mux)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/greet.v1.GreetService/Greet", nil)
	req.Header.Set("Content-Type", "application/json") 
	req.Header.Set("Authorization", "Bearer valid-token")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200 OK, got %d", resp.StatusCode)
	}
}

// 2. Test Kasus Gagal Autentikasi (Missing Token)
func TestConnectRPC_Unauthenticated(t *testing.T) {
	mux := SetupConnectServer()
	server := httptest.NewServer(mux)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/greet.v1.GreetService/Greet", nil)
	req.Header.Set("Content-Type", "application/json") 
	// Sengaja tidak mengirim token Authorization

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("Expected status 401 Unauthorized, got %d", resp.StatusCode)
	}
}

// 3. Test Kasus Invalid HTTP Method (Connect RPC wajib POST)
func TestConnectRPC_InvalidProtocol(t *testing.T) {
	mux := SetupConnectServer()
	server := httptest.NewServer(mux)
	defer server.Close()

	// Menggunakan method GET (Connect RPC mengharuskan POST)
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/greet.v1.GreetService/Greet", nil)
	req.Header.Set("Authorization", "Bearer valid-token")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("Expected status 405 Method Not Allowed, got %d", resp.StatusCode)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyuntikkan Envoy Proxy Sekadar Untuk gRPC-Web
Di era gRPC tradisional, *frontend engineer* akan diblokir karena browser tidak bisa berbicara HTTP/2 dengan trailing headers. Solusi malas (lazy) adalah mendeploy kontainer Envoy terpisah.

```yaml
// ❌ BAD: Kubernetes manifest dengan Sidecar Envoy yang rakus memori
containers:
  - name: grpc-app
    image: my-go-app
  - name: envoy-grpc-web
    image: envoyproxy/envoy
    # Memerlukan 100 baris envoy.yaml hanya untuk menerjemahkan HTTP/1 ke HTTP/2
```
**Why dangerous:** Menambah kompleksitas infrastruktur operasional. Envoy sidecar memakan setidaknya 50-100MB RAM tambahan per pod, menambah latensi hop jaringan, dan menyulitkan proses debugging tracing.

```go
// ✅ GOOD: Handle langsung di Go via connectrpc
// Go app mengekspos 1 port yang melayani gRPC, gRPC-Web, dan Connect HTTP1/JSON
mux.Handle(greetv1connect.NewGreetServiceHandler(svc))
http.ListenAndServe(":8080", h2c.NewHandler(mux, &http2.Server{}))
```

### ❌ Anti-Pattern 2: Asumsi `metadata.FromIncomingContext` Selalu Bekerja
Jika melakukan migrasi dari `google.golang.org/grpc`, kode lama yang terbiasa mengekstrak header gRPC dari metadata *context* akan berantakan (panic/nil pointer) ketika diakses via Connect protocol HTTP/1.1.

```go
// ❌ BAD: Mengekstrak kredensial menggunakan pustaka gRPC native di handler
func (s *GreetService) Greet(ctx context.Context, req *connect.Request[Req]) (*connect.Response[Res], error) {
    // Akan GAGAL karena connect tidak menyuntikkan ini ke gRPC metadata context
    md, ok := metadata.FromIncomingContext(ctx) 
    token := md.Get("Authorization")
}
```
**Why dangerous:** Mematahkan kompatibilitas *tri-protocol*. Handler Anda akan mengembalikan Unauthenticated untuk *request* dari browser meskipun token dikirim dengan benar di HTTP header.

```go
// ✅ GOOD: Ekstrak secara natural menggunakan interface HTTP Headers Connect
func AuthInterceptor(...) ... {
    // Header HTTP/1.1, HTTP/2, dan gRPC-Web dinormalisasi di req.Header()
    token := req.Header().Get("Authorization")
    // ... validasi lalu masukkan ke `ctx` standar Go
}
```

## 5. Edge Cases & Defensive Programming

1. **CORS (Cross-Origin Resource Sharing) Preflight Bouncing**: Browser memberlakukan CORS secara ketat untuk gRPC-Web dan Connect-protocol (terutama karena `Content-Type: application/connect+json`). *Defensive:* Jangan pernah lupa membungkus `ServeMux` dengan middleware CORS standard (seperti `github.com/rs/cors`). Middleware tersebut HARUS mengizinkan header spesifik seperti `Connect-Protocol-Version`, `Connect-Timeout-Ms`, dan `Grpc-Timeout`, atau request `OPTIONS` akan ditolak *browser* sebelum mencapai kode Go Anda.
2. **Timeout Propagation Silence**: Browser sering tidak mengirim *gRPC deadline* atau header `Connect-Timeout-Ms`. Jika klien seluler secara tiba-tiba kehilangan sinyal, RPC di backend bisa hang, menunggu database selamanya. *Defensive:* Jangan pernah membiarkan eksekusi RPC dengan `context.Background()` telanjang. Di tingkat interceptor Connect, periksa ketiadaan deadline, lalu paksa `context.WithTimeout` cadangan (misal 15 detik) untuk melindungi backend dari *goroutine leak* massal.
3. **HTTP/2 H2C Plaintext Cleartext**: Connect-go membutuhkan `golang.org/x/net/http2/h2c` jika berjalan di belakang *Load Balancer* Kubernetes internal (dimana ALB/Ingress men-terminate SSL, dan meneruskan trafik plaintext HTTP/2 ke pod). Tanpa `h2c.NewHandler`, klien internal gRPC murni akan gagal melakukan *handshake* karena server Go default `net/http` memblokir HTTP/2 *cleartext* yang tak dienkripsi TLS.
4. **Error Mapping ke REST Status Codes (JSON Clients)**: Klien Connect protocol (JSON) memetakan kode error gRPC ke HTTP Status (contoh: `CodeNotFound` menjadi `404`). *Defensive:* Jangan melempar sembarang Go `error` biasa dari handler. Jika Anda mengembalikan `errors.New("user not found")`, itu akan menjadi HTTP 500 Internal Error. Kembalikan `connect.NewError(connect.CodeNotFound, err)` agar frontend mendapat 404 dan dapat merender halaman "Not Found" dengan presisi.
