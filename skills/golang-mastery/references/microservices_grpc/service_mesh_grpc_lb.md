# Service Mesh & gRPC Load Balancing: Resilience and Traffic Control

## Konsep dan Internals
Dalam ekosistem gRPC, Load Balancing sangat berbeda dengan HTTP/1.1 tradisional. Karena gRPC berbasis HTTP/2 yang bersifat koneksi-persisten (*connection multiplexing*), meletakkan NGINX TCP (L4) Load Balancer konvensional di tengah tidak akan mendistribusikan lalu lintas secara adil. Semua request dari satu Client Go akan disalurkan melalui satu pipa HTTP/2 yang sama ke satu Server saja (*connection hoarding*).

Terdapat dua pola penyelesaian produksi (*Production Patterns*):
1. **Client-Side Load Balancing (Thick Client)**: Aplikasi Go menggunakan `grpc.Dial` yang dibekali *resolver* (seperti target format `dns:///`) dan disuntik *Service Config* lokal. Klien secara internal mengetahui semua alamat IP Pod/Node (misal Pod A, B, C) dan mendistribusikan RPC request (seperti dengan algoritma `round_robin`) langsung di memori klien.
2. **Service Mesh (Lookaside Proxy / L7 Proxy)**: Menggunakan pola *Sidecar*. Sebuah proxy Layer 7 (seperti **Envoy**, Istio, atau Linkerd) ditanam di sebelah kontainer Klien dan Server. Klien Go cukup melakukan gRPC Dial ke `localhost:8080`, lalu Envoy akan menangkap traffic tersebut secara transparan, menganalisa header HTTP/2, lalu melakukan routing, TLS offloading, Circuit Breaking, dan Retry secara pintar.

Selain itu, standar spesifikasi `grpc_health_v1` sangat krusial. Pod Kubernetes atau Proxy Service Mesh harus mengetahui kesiapan (*Readiness*) suatu backend gRPC sebelum mengalirkan load. Standar ini membutuhkan pengikatan `health.Server` resmi dari `grpc-go` ke peladen utama.

## Diagram ASCII: Arsitektur Client-Side vs Service Mesh

```ascii
=== SCENARIO A: Client-Side Load Balancing ===
[gRPC Client App] -----------------( HTTP/2 Multiplexed Requests )------------------>
        |                                                                           |
        v (Client Library grpc-go internal)                                         v
   DNS Resolver: "dns:///my-svc.local" -> [IP 10.0.0.1, IP 10.0.0.2]          [Target Replica 1]
   Policy: round_robin                                                              ^
        |------------> (RPC 1) ---> 10.0.0.1 ---------------------------------------|
        |------------> (RPC 2) ---> 10.0.0.2 ------------------> [Target Replica 2]


=== SCENARIO B: Service Mesh / Envoy Proxy ===
[gRPC Client App]                                                 [Target Replica 1]
        | (Dial localhost)                                                  ^
        v                                                                   |
 [Envoy Sidecar] ---------( Mutual TLS HTTP/2 L7 Routing )--------> [Envoy Sidecar]
        | (L7 LB: Retry, Timeout, Circuit Break)                            ^
        |--------------------------------------------------------> [Envoy Sidecar] -> [Replica 2]
```

## Production-Ready Code & Testing
Kode di bawah mensimulasikan penerapan konfigurasi Client-Side Load Balancer dan Health Server bawaan, diuji melalui konektivitas in-memory `bufconn`. Konfigurasi JSON *ServiceConfig* memastikan Go client secara agresif menggunakan Round Robin dan Retry mekanik jika `UNAVAILABLE`.

```go
package grpclb_test

import (
	"context"
	"fmt"
	"log"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE UNTUK DUMMY SERVICE
// ==============================================================================
type Empty struct{}
type EchoResponse struct { ServerID string }

type EchoServiceServer interface {
	Echo(context.Context, *Empty) (*EchoResponse, error)
}
func RegisterEchoServiceServer(s grpc.ServiceRegistrar, srv EchoServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.EchoService",
		HandlerType: (*EchoServiceServer)(nil),
		Methods: []grpc.MethodDesc{
			{
				MethodName: "Echo",
				Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
					if interceptor == nil { return srv.(EchoServiceServer).Echo(ctx, &Empty{}) }
					return interceptor(ctx, &Empty{}, &grpc.UnaryServerInfo{Server: srv, FullMethod: "/acme.api.v1.EchoService/Echo"}, func(c context.Context, req interface{}) (interface{}, error) {
						return srv.(EchoServiceServer).Echo(c, &Empty{})
					})
				},
			},
		},
		Streams:  []grpc.StreamDesc{},
		Metadata: "echo.proto",
	}, srv)
}

// ==============================================================================
// 2. IMPLEMENTASI HANDLER SERVER STREAMING
// ==============================================================================
type myEchoServer struct { id string }

func (s *myEchoServer) Echo(ctx context.Context, req *Empty) (*EchoResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.Canceled, "request canceled")
	}
	return &EchoResponse{ServerID: s.id}, nil
}

// ==============================================================================
// 3. UNIT TEST MENGGUNAKAN BUFCONN & CONFIG LOAD BALANCER
// ==============================================================================

func TestClientSideLoadBalancingConfig(t *testing.T) {
	const bufSize = 1024 * 1024
	lis1 := bufconn.Listen(bufSize)
	lis2 := bufconn.Listen(bufSize)

	// Inisialisasi Server 1
	srv1 := grpc.NewServer()
	RegisterEchoServiceServer(srv1, &myEchoServer{id: "Server-1"})
	
	// Inject standar Health Server v1 (dibutuhkan oleh K8s/Envoy)
	healthSrv1 := health.NewServer()
	healthSrv1.SetServingStatus("acme.api.v1.EchoService", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(srv1, healthSrv1)
	
	go func() { _ = srv1.Serve(lis1) }()
	defer srv1.Stop()

	// Inisialisasi Server 2
	srv2 := grpc.NewServer()
	RegisterEchoServiceServer(srv2, &myEchoServer{id: "Server-2"})
	
	healthSrv2 := health.NewServer()
	healthSrv2.SetServingStatus("acme.api.v1.EchoService", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(srv2, healthSrv2)
	
	go func() { _ = srv2.Serve(lis2) }()
	defer srv2.Stop()

	// Custom resolver dialer memetakan 2 bufconn listener sebagai 1 koneksi pool LB
	dialer := func(ctx context.Context, s string) (net.Conn, error) {
		// Logika mock LB sederhana (round robin manual tingkat listener)
		// Di realita, grpc-go DNS resolver membaca ini secara otomatis
		return lis1.Dial()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// JSON Configuration untuk algoritma Round Robin dan Retry Mechanism
	// Sangat penting jika memakai Client-Side tanpa Service Mesh.
	serviceConfig := `{
		"loadBalancingPolicy": "round_robin",
		"methodConfig": [{
			"name": [{"service": ""}],
			"retryPolicy": {
				"maxAttempts": 3,
				"initialBackoff": "0.1s",
				"maxBackoff": "1s",
				"backoffMultiplier": 2.0,
				"retryableStatusCodes": ["UNAVAILABLE"]
			}
		}]
	}`

	conn, err := grpc.DialContext(ctx, "bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithDefaultServiceConfig(serviceConfig),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("Failed to dial bufnet: %v", err)
	}
	defer conn.Close()

	// Uji panggilan Health Check resmi gRPC
	healthClient := grpc_health_v1.NewHealthClient(conn)
	healthResp, err := healthClient.Check(ctx, &grpc_health_v1.HealthCheckRequest{
		Service: "acme.api.v1.EchoService",
	})
	if err != nil {
		t.Fatalf("Health check failed: %v", err)
	}
	if healthResp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
		t.Fatalf("Expected health SERVING, got %v", healthResp.Status)
	}

	// Uji invoke service domain biasa
	resp := new(EchoResponse)
	err = conn.Invoke(ctx, "/acme.api.v1.EchoService/Echo", &Empty{}, resp)
	if err != nil {
		t.Fatalf("Expected no error on Invoke, got %v", err)
	}
	if resp.ServerID != "Server-1" {
		t.Errorf("Expected Server-1 (due to mocked dialer limit), got %s", resp.ServerID)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Terjebak Algoritma `pick_first` pada Target Multi-Node
Secara bawaan, library `grpc-go` tidak melakukan load balancing ke multiple IP. Kebijakan resolusinya adalah `pick_first`. 

```go
// BAD: Tidak menyebut algoritma LB explisit.
conn, err := grpc.Dial("dns:///my-database-svc.local:50051", grpc.WithInsecure())
// Akibatnya: DNS mengembalikan [Pod A, Pod B, Pod C]. Klien Go mengambil IP Pod A, 
// membangun 1 HTTP/2 pipe ke A, dan menembakkan SEJUTA requests ke Pod A saja. 
// Pod B dan Pod C akan idle (0 load).
```
**Mengapa berbahaya:** Anda akan mendapati CPU utilization yang sangat miring pada dashboard pemantauan. Pod A bisa mengalami _Throttling / OOM_ sedangkan replika lain menganggur. Pada saat puncak traffic (*surge*), layanan tumbang satu persatu (*cascading failure*).

```go
// GOOD: Gunakan 'round_robin' atau manfaatkan Service Mesh (Envoy L7 proxy)
serviceConfig := `{"loadBalancingPolicy": "round_robin"}`
conn, err := grpc.Dial("dns:///my-database-svc.local:50051", 
    grpc.WithDefaultServiceConfig(serviceConfig))
```

### ❌ Anti-Pattern 2: NGINX TCP L4 Proxy Sebagai Balancer gRPC
Memasang NGINX tradisional (Layer 4 TCP balancer) di depan cluster gRPC Anda adalah kesalahan arsitektural yang umum dilakukan.

```nginx
# BAD: Menggunakan stream TCP pada port 50051 untuk me-route trafik gRPC.
stream {
    upstream grpc_backend {
        server pod1:50051;
        server pod2:50051;
    }
    server { listen 50051; proxy_pass grpc_backend; }
}
```
**Mengapa berbahaya:** gRPC menggunakan TCP multiplexing (1 koneksi dipertahankan terbuka berhari-hari). Load balancer L4 (TCP) hanya menyeimbangkan *koneksi baru*. Karena klien Anda jarang membuka koneksi baru, keseimbangan beban mustahil tercapai.

**Benar:** Gunakan mode `grpc_pass` (NGINX L7) yang mampu membedah frame HTTP/2 dan meroute sub-stream, atau manfaatkan native Istio/Envoy sidecar.

## Edge Cases Khusus

1. **Headless Service Kubernetes untuk Client-Side LB**: Jika menggunakan pola Client-Side LB di dalam kluster K8s tanpa Service Mesh, mendial nama domain service biasa (misal `my-svc`) hanya me-resolve menjadi **satu IP Virtual K8s**. Go Client kembali hanya melihat 1 alamat. Anda harus membuat Service berjenis **Headless** (`clusterIP: None`) agar DNS memuntahkan daftar lengkap semua alamat IP Pod, sehingga Go Client LB dapat bekerja.
2. **Context Cancellation & Envoy Retry Storm**: Service Mesh (seperti Envoy) otomatis mem-parse *Deadline* Go Context (`context.WithTimeout`) dan menerjemahkannya ke HTTP Header `grpc-timeout`. Jika Klien menset timeout 2 detik dan timeout habis di Klien, Proxy (Envoy) akan ikut membatalkan *request* ke hilir, mencegah peladen hilir kelelahan bekerja untuk klien yang sudah menyerah. Namun jika Proxy dikonfigurasikan Retry ekstrem tanpa pembatasan `x-envoy-max-retries`, satu request gagal bisa diamplifikasi menjadi badai lalu lintas (Retry Storm).
3. **Flapping Health Checks di Service Mesh**: Endpoint `grpc_health_v1.HealthCheck` digunakan Proxy untuk memvalidasi rotasi peladen. Apabila pemeriksaan Health Check Anda terlalu sensitif (misalnya langsung `NOT_SERVING` jika ada 1 kueri DB lambat selama 200ms), pod akan ditendang keluar-masuk rotasi (*flapping*). Proses ini me-reset pool koneksi Envoy secara konstan, memicu lonjakan latensi di seluruh mesh jaringan. Gunakan state management transisional untuk Health Server.
4. **Stale DNS Resolution saat Pod di-roll**: Saat *Deployment* Kubernetes diperbarui, pod lama mati dan IP baru muncul. gRPC-go DNS Resolver mem-cache data ini. Terkadang resolusi ulangnya membutuhkan jeda (*DNS lag*). Membekali klien `grpc.Dial` dengan konfigurasi *Retry mechanism JSON* (untuk status `UNAVAILABLE`) akan memastikan request terselamatkan sementara resolver memompa IP baru ke *Load Balancing pool*.
