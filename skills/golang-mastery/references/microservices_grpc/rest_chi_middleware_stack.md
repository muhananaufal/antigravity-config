# Lapisan HTTP di Depan gRPC: Middleware Stack & gRPC-Gateway

> **Berlaku:** Go 1.22+ (`http.ServeMux` dengan pola metode) · `grpc-gateway` v2 · `go-chi/chi` v5 · **Lihat juga:** `microservices_grpc/http_client_production.md` · `microservices_grpc/openapi_ogen_codegen.md` · `microservices_grpc/pagination_patterns.md` · `security_owasp/web_security_headers.md`

> **Catatan cakupan.** Berkas ini dirutekan dari SKILL.md dengan kata kunci "REST, chi, middleware stack", tetapi isinya berfokus pada **gRPC-Gateway** — jembatan REST/JSON ke gRPC. Keduanya memang satu lapisan (HTTP di depan layanan), tetapi bila yang Anda cari adalah susunan middleware HTTP murni — CORS, CSRF, header keamanan, rate limit, pemetaan galat ke status — tempatnya:
>
> | Yang dicari | Berkas |
> | :--- | :--- |
> | CORS, CSRF, CSP, HSTS | `security_owasp/web_security_headers.md` |
> | Rate limiting per rute | `observability_resilience/rate_limiting_patterns.md` |
> | Pemetaan galat domain ke status HTTP | `arch_patterns/error_handling_strategy.md` |
> | Cursor/offset pada endpoint daftar | `microservices_grpc/pagination_patterns.md` |
>
> Sejak Go 1.22, `http.ServeMux` bawaan sudah mendukung pola metode dan wildcard (`GET /pesanan/{id}`); untuk banyak layanan, router pihak ketiga tidak lagi diperlukan.

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

> ### ⚠ Kode di bawah ILUSTRATIF, bukan uji yang bisa dijalankan
>
> `UserRequest`/`UserResponse` adalah struct Go biasa, bukan `proto.Message`. Codec bawaan `grpc-go` menolaknya, sehingga `conn.Invoke` gagal sebelum menyentuh jaringan:
> ```
> failed to marshal, message is *UserRequest, want proto.Message
> ```
> Selain itu, `Handler` di `ServiceDesc` di bawah **tidak pernah memanggil `dec`** dan mengembalikan `Id: "123"` yang di-hardcode — sehingga uji "404" tidak akan pernah menerima `999`.
>
> Bacalah bagian ini sebagai **peta bentuk** gRPC-Gateway: bagaimana pola URL dipetakan, bagaimana `runtime.HTTPStatusFromCode` menerjemahkan kode gRPC ke status HTTP, dan di mana middleware HTTP membungkusnya. Untuk uji yang benar-benar berjalan, pakai proto hasil generate dan `*.pb.gw.go` yang sesungguhnya.

Skrip di bawah menunjukkan bagaimana `runtime.ServeMux` (Gateway HTTP) disatukan dengan `bufconn` (gRPC in-memory), lalu diakses sebagai klien HTTP JSON lewat `httptest`.

```go
package grpcgateway_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// pesanAman memetakan kode gRPC ke pesan yang boleh dilihat klien.
//
// Satu tempat, bukan tersebar di tiap handler -- itulah yang mencegah
// 404 dan 500 tertukar secara acak antar endpoint.
func pesanAman(c codes.Code) string {
	switch c {
	case codes.NotFound:
		return "Data yang diminta tidak ada."
	case codes.InvalidArgument:
		return "Permintaan tidak valid."
	case codes.PermissionDenied:
		return "Anda tidak punya akses ke sumber daya ini."
	case codes.Unauthenticated:
		return "Autentikasi diperlukan."
	case codes.DeadlineExceeded:
		return "Permintaan melebihi batas waktu."
	default:
		return "Terjadi kesalahan pada server."
	}
}

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
	conn, err := grpc.NewClient(endpoint, opts...)
	if err != nil { return err }

	// Mendaftarkan pattern HTTP REST ke rute Gateway
	// Di aslinya, ini otomatis diambil dari annotasi: option (google.api.http) = { get: "/v1/users/{id}" };
	mux.Handle("GET", runtime.MustPattern(runtime.NewPattern(1, []int{2, 0, 2, 1, 1, 0, 4, 1, 5, 2}, []string{"v1", "users", "id"}, "")), func(w http.ResponseWriter, req *http.Request, pathParams map[string]string) {
		
		// Klien HTTP memanggil Gateway. Gateway mensarikan variabel path (ID).
		idParam := pathParams["id"]
		
		// Gateway mengirim RPC call ke belakang
		resp := new(UserResponse)
		err := conn.Invoke(req.Context(), "/api.v1.UserService/GetUser", &UserRequest{Id: idParam}, resp)
		
		if err != nil {
			st, _ := status.FromError(err)
			// Pesan gRPC internal TIDAK diteruskan mentah ke klien: ia rutin
			// menyebut nama tabel, host, atau nilai yang gagal. Yang menyeberang
			// hanya kode status dan pesan yang aman.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(runtime.HTTPStatusFromCode(st.Code()))
			_ = json.NewEncoder(w).Encode(map[string]string{
				"kode":  st.Code().String(),
				"pesan": pesanAman(st.Code()),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		// JANGAN merangkai JSON dengan penggabungan string. Satu tanda kutip
		// atau backslash di dalam nilai menghasilkan JSON rusak -- dan bila
		// nilainya berasal dari input pengguna, itu injeksi.
		_ = json.NewEncoder(w).Encode(map[string]string{"name": resp.Name})
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
		
		// Uji memeriksa KODE, bukan kalimat internal. Meng-assert
		// "user 999 not found in database" justru MENGUNCI kebocoran
		// informasi sebagai perilaku yang diharapkan.
		var badan struct{ Kode, Pesan string }
		_ = json.NewDecoder(resp.Body).Decode(&badan)
		if badan.Kode != codes.NotFound.String() {
			t.Errorf("mau kode NotFound, dapat %q", badan.Kode)
		}
		if strings.Contains(badan.Pesan, "database") {
			t.Errorf("detail internal bocor ke klien: %q", badan.Pesan)
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

## Kapan JANGAN Pakai Ini

- **Router pihak ketiga untuk kebutuhan sederhana.** Sejak Go 1.22, `http.ServeMux` mendukung pola metode dan wildcard (`POST /pesanan/{id}`). Untuk banyak layanan itu sudah cukup — dan satu dependensi yang tidak ada adalah satu dependensi yang tidak perlu diamankan, diperbarui, atau dipelajari orang baru.
- **Membiarkan bentuk HTTP merambat ke domain.** `*http.Request` di lapisan service mengikat logika bisnis pada transport, dan membuatnya tidak bisa dipanggil dari CLI, konsumer antrean, atau uji tanpa membangun request palsu.
- **Middleware untuk aturan yang hanya berlaku pada sebagian rute.** Ia akan tumbuh menjadi daftar pengecualian di dalam middleware. Pasang di grup rute yang tepat.
- **Mengembalikan galat internal apa adanya ke klien.** Pesan galat database memuat nama tabel, nama kolom, dan kadang nilai yang gagal — itu kebocoran informasi yang gratis diberikan kepada penyerang.
- **Menentukan kode status secara ad-hoc di tiap handler.** Pemetaan galat domain ke status HTTP harus berada di satu tempat; kalau tidak, `404` dan `500` akan tertukar secara acak tergantung siapa yang menulis handler-nya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `404` dan `500` tertukar untuk kasus serupa | tempat pemetaan galat | Pemetaan tersebar di banyak handler |
| Kardinalitas metrik HTTP meledak | label `path` | Path mentah dipakai sebagai label, bukan pola rute |
| Pesan `pq:` atau `sql:` sampai ke klien | body respons galat | Galat internal tidak dipetakan |
| Logika bisnis sulit diuji tanpa server | tanda tangan fungsi service | HTTP merambat ke domain |
| Middleware baru memecahkan rute lain | cakupan pemasangan middleware | Dipasang global padahal spesifik |

```bash
# Kode status yang sebenarnya dikembalikan
curl -s localhost:9090/metrics | grep http_requests_total | grep -E 'code="(4|5)'

# Jumlah deret metrik HTTP -- membengkak berarti label path mentah
curl -s localhost:9090/metrics | grep -c '^http_requests_total'

# Apakah galat internal bocor?
curl -si localhost:8080/api/v1/pesanan/tidak-ada | head -20
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.status>=500) | .response' | grep -iE 'pq:|sql:|pgx|panic' | head
```
