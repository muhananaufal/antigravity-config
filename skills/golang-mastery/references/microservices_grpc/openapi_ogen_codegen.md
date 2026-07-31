# OpenAPI (Swagger) Generation untuk gRPC-Gateway

## Konsep dan Internals
Dalam lingkungan Microservices, dokumentasi API adalah kontrak suci. Menulis spesifikasi REST (Swagger / OpenAPI v2 atau v3) secara manual di ekosistem Go memakan waktu tinggi dan rentan *out-of-sync* antara dokumen dan *logic*. 

Ketika menggunakan *gRPC-Gateway*, kita mendapatkan anugerah luar biasa: **`protoc-gen-openapiv2`**. Ekstensi (plugin) dari ekosistem `grpc-ecosystem` ini memungkinkan kita me-render file `swagger.json` murni secara otomatis **langsung dari file `.proto` (Protobuf)**, menggunakan anotasi resmi `google.api.http`. 

Keunggulan metode *Source-of-Truth* tunggal (*Single Source of Truth*):
- File Protobuf `.proto` mendefinisikan rute HTTP, Tipe Data JSON, Keterangan Field, dan Autentikasi.
- Kompilasi `buf generate` atau `protoc` akan memuntahkan stub `.pb.go`, `.pb.gw.go` (HTTP router), dan sebuah `.swagger.json`.
- Klien REST dan Partner bisnis dapat melihat halaman Swagger UI yang dirender dari JSON tersebut, dan dokumentasi ini **100% akurat** secara absolut, karena router HTTP (`grpc-gateway`) yang di-deploy juga dibangun menggunakan file proto yang sama.

Anotasi *grpc-gateway* memungkinkan manipulasi properti Swagger seperti: `summary`, `description`, `tags`, tipe respon default, dan *Security Schemes* (seperti `Bearer` atau `ApiKey`).

## Diagram ASCII: Arsitektur Single-Source of Truth

```ascii
                      +-----------------------------+
                      | user.proto (IDL & Comments) |
                      +-----------------------------+
                                     |
    (Tooling: buf / protoc dengan plugin openapiv2 & gateway-gen)
                                     |
    +--------------------------------+--------------------------------+
    |                                |                                |
    v                                v                                v
+------------------+        +-------------------+           +-------------------+
|  user.pb.go      |        | user.pb.gw.go     |           | user.swagger.json |
| (Golang Struct)  |        | (Go HTTP Mux/API) |           | (OpenAPI v2 Spec) |
+------------------+        +-------------------+           +-------------------+
        \                            |                                /
         \                           |                               /
          \                          v                              /
           \-----> [ Golang HTTP + gRPC Multiplex Server ] <-------/
                             (Port: 8080)
```

## Production-Ready Code & Testing
Kode simulasi berikut ini memperlihatkan demonstrasi end-to-end `bufconn` yang meniru peladen (*Server*) gRPC-Gateway yang secara otomatis menyajikan (*serve*) file `swagger.json` statis pada endpoint `/docs/swagger.json`, sehingga siap diserap oleh Swagger UI atau Redoc.

```go
package openapigen_test

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE
// Normalnya ini dirender dari `google.api.http`
// ==============================================================================
type GetUserRequest struct{ Id string }
type UserResponse struct{ Name string }

type UserServiceServer interface {
	GetUser(context.Context, *GetUserRequest) (*UserResponse, error)
}
func RegisterUserServiceServer(s grpc.ServiceRegistrar, srv UserServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.UserService",
		HandlerType: (*UserServiceServer)(nil),
		Methods: []grpc.MethodDesc{{
			MethodName: "GetUser",
			Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
				return srv.(UserServiceServer).GetUser(ctx, &GetUserRequest{Id: "123"})
			},
		}},
		Streams: []grpc.StreamDesc{}, Metadata: "user.proto",
	}, srv)
}

// Simulasi grpc-gateway registrar
func RegisterUserServiceHandlerClient(ctx context.Context, mux *runtime.ServeMux, endpoint string, opts []grpc.DialOption) error {
	conn, err := grpc.Dial(endpoint, opts...)
	if err != nil { return err }

	mux.Handle("GET", runtime.MustPattern(runtime.NewPattern(1, []int{2, 0, 2, 1, 1, 0, 4, 1, 5, 2}, []string{"v1", "users", "id"}, "")), func(w http.ResponseWriter, req *http.Request, pathParams map[string]string) {
		resp := new(UserResponse)
		err := conn.Invoke(req.Context(), "/acme.api.v1.UserService/GetUser", &GetUserRequest{Id: pathParams["id"]}, resp)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
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

func (s *myUserServer) GetUser(ctx context.Context, req *GetUserRequest) (*UserResponse, error) {
	return &UserResponse{Name: "John Swagger"}, nil
}

// Mock konstanta file swagger.json (seolah-olah hasil generate dari protoc-gen-openapiv2)
const mockSwaggerJSON = `{
  "swagger": "2.0",
  "info": {
    "title": "ACME API",
    "version": "1.0"
  },
  "paths": {
    "/v1/users/{id}": {
      "get": {
        "summary": "Mendapatkan data pengguna",
        "operationId": "UserService_GetUser",
        "responses": {
          "200": { "description": "Berhasil", "schema": { "$ref": "#/definitions/UserResponse" } }
        }
      }
    }
  }
}`

// ==============================================================================
// 3. UNIT TEST E2E: MELAYANI SWAGGER DAN API DI SATU SERVER
// ==============================================================================
func TestOpenAPI_SwaggerJSON_Serving(t *testing.T) {
	lis := bufconn.Listen(1024 * 1024)

	// A. gRPC Server
	grpcServer := grpc.NewServer()
	RegisterUserServiceServer(grpcServer, &myUserServer{})
	go func() { _ = grpcServer.Serve(lis) }()
	defer grpcServer.Stop()

	// B. Gateway Mux
	dialer := func(ctx context.Context, s string) (net.Conn, error) { return lis.Dial() }
	dialOpts := []grpc.DialOption{
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}

	gwMux := runtime.NewServeMux()
	_ = RegisterUserServiceHandlerClient(context.Background(), gwMux, "bufnet", dialOpts)

	// C. Root HTTP Mux untuk menyisipkan Swagger Endpoint di samping Gateway
	mux := http.NewServeMux()
	
	// Menyajikan static JSON file
	mux.HandleFunc("/docs/swagger.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(mockSwaggerJSON))
	})
	
	// Sisa traffic diteruskan ke gRPC-Gateway
	mux.Handle("/", gwMux)

	// Uji HTTP
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()

	// Test 1: Hit API endpoint
	t.Run("Hit gRPC Gateway API", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/v1/users/123")
		if err != nil { t.Fatalf("API failed: %v", err) }
		defer resp.Body.Close()
		
		body, _ := io.ReadAll(resp.Body)
		if string(body) != `{"name":"John Swagger"}` {
			t.Errorf("Unexpected API body: %s", string(body))
		}
	})

	// Test 2: Hit Swagger documentation endpoint
	t.Run("Hit Swagger Docs Endpoint", func(t *testing.T) {
		resp, err := http.Get(httpServer.URL + "/docs/swagger.json")
		if err != nil { t.Fatalf("Swagger endpoint failed: %v", err) }
		defer resp.Body.Close()

		if resp.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Expected application/json, got %s", resp.Header.Get("Content-Type"))
		}
		
		body, _ := io.ReadAll(resp.Body)
		if len(body) < 10 {
			t.Errorf("Swagger body seems empty/invalid")
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Swagger Options di `.proto`
Menganggap `protoc-gen-openapiv2` bisa memprediksi segalanya, dan tidak mengimpor plugin grpc-gateway *swagger options*.

```protobuf
// BAD: Generasi minimal, OpenAPI merender nama field mentah (seringkali buram).
message UserRequest {
  string xyz_identifier_code = 1; 
}
```
**Mengapa berbahaya:** Dokumentasi publik atau portal Klien Anda akan menjadi sangat membingungkan karena tidak ada deskripsi atau aturan (seperti MaxLength). Ini menyulitkan partner integrasi eksternal.

**Benar:** Impor ekstensi khusus dan buat *self-documenting struct*.
```protobuf
import "protoc-gen-openapiv2/options/annotations.proto";

message UserRequest {
  // Tambahkan keterangan lengkap agar masuk ke UI Swagger.
  string xyz_identifier_code = 1 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    description: "Nomor registrasi identitas Klien berformat UUIDv4."
    pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89aAbB][a-f0-9]{3}-[a-f0-9]{12}$"
  }];
}
```

### ❌ Anti-Pattern 2: Menulis `swagger.json` atau YAML secara Manual (*Hand-written*)
Ada tim yang menggunakan gRPC-Gateway, tetapi menugaskan Technical Writer/Frontend merakit dokumen API Swagger.yaml sendiri menggunakan aplikasi pihak ketiga.

**Mengapa berbahaya:** API Drift. Jika Backend Engineer menambahkan *Required parameter* baru pada `.proto` tetapi Technical Writer lupa memutakhirkan yaml buatan tangannya, dokumentasi akan menyesatkan Klien, berujung pada HTTP 400 *Bad Request* yang fatal saat peluncuran (*Production deployment*). Selalu gunakan `buf generate` agar selaras secara otomatis (*Source of Truth*).

## Edge Cases Khusus

1. **Format Enum (*Int vs String*) di Swagger JSON**: Secara bawaan (*default*), tipe `enum` protobuf akan dikonversi menjadi Integer/Angka pada serialisasi JSON. Namun, Spesifikasi OpenAPI hasil generasi `protoc-gen-openapiv2` seringkali mendeskripsikan Enum tersebut sebagai himpunan string (`"ACTIVE"`, `"INACTIVE"`). Akibat ketidakcocokan ini, klien yang memvalidasi payload JSON mereka secara kaku (*Strict Validator*) akan error. *Solusi*: Anda harus memastikan `runtime.ServeMux` gRPC-Gateway dikonfigurasi dengan `runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{ EnumsAsInts: false })` agar *output* HTTP menjadi String selaras dengan *Swagger Specs*.
2. **Kustomisasi CamelCase vs Snake_case**: Protobuf standar menggunakan *snake_case* untuk field (e.g. `first_name`). `openapiv2` standar akan mengonversinya menjadi *camelCase* (`firstName`) di Swagger UI, namun tergantung pada opsi *marshaler* gRPC-Gateway (`UseProtoNames: true/false`), output HTTP aktual bisa saja berbeda (tetap `first_name`). Jika dokumentasi (camelCase) tidak cocok dengan network response aktual (snake_case), Klien Web Front-end akan gagal memetakan JSON. Anda harus meninjau konsistensi flag `json_name` di file *proto* Anda.
3. **Mengabaikan Health Check Endpoint di Swagger**: Layanan Microservice sering memiliki endpoint `/healthz` yang diimplementasikan di atas gRPC. Endpoint-endpoint operasional ini idealnya disembunyikan (*hidden*) dari Swagger Specs agar Klien Publik tidak kebingungan. Gunakan *Swagger exclude config* atau beri anotasi pengabaian (jangan taruh `google.api.http` di atas rute kesehatan internal).
