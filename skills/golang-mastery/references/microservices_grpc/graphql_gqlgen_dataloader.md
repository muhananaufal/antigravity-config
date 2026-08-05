# GraphQL API dengan gRPC Backend (Pola BFF & DataLoader)

> **Berlaku:** Go 1.21+ · `99designs/gqlgen` v0.17+ · **Lihat juga:** `db_sqlc/query_optimization_n_plus_one.md` · `caching_strategy/multilevel_cache_l1l2.md` · `observability_resilience/rate_limiting_patterns.md` · `microservices_grpc/grpc_protobuf_patterns.md`

## Konsep dan Internals
Dalam arsitektur *microservices*, memaparkan gRPC secara langsung ke klien publik (seperti SPA React atau Klien iOS) seringkali menyulitkan karena keterbatasan format payload (Over-fetching / Under-fetching). Solusi terbaik adalah menempatkan **GraphQL Server** sebagai *Backend-for-Frontend* (BFF). 

GraphQL Server bertugas mendengarkan kueri fleksibel dari klien publik, lalu di belakang layar mengorkestrasi (memanggil) sekumpulan layanan gRPC internal.

Tantangan paling masif dalam pola ini adalah **N+1 Problem**. Jika sebuah GraphQL Resolver me-resolve sebuah list yang berisi 50 artikel, dan setiap artikel harus memuat data *Penulis*, resolver naif akan melakukan **50 buah koneksi gRPC** terpisah ke `UserService`. 

Solusi utama: **Dataloader** (Batching & Caching pada tingkat *Request Life-cycle*).
- GraphQL Resolver mendelegasikan ID (`Load(id)`) ke Dataloader.
- Dataloader menunggu sejenak (beberapa milidetik), mengumpulkan 50 ID unik.
- Dataloader memanggil **Satu (1)** request gRPC `GetUsers(ids: [1,2,3...50])`.
- Dataloader mendistribusikan respons kembali ke 50 resolver tersebut.

## Diagram ASCII: Arsitektur N+1 gRPC Batching

```ascii
[Klien Web React] ----( HTTP POST GraphQL Kueri )----> [GraphQL BFF Server (gqlgen)]
                                                              |
    +---------------------------------------------------------|
    | (Proses Kueri Resolusi Artikel -> Penulis)              v
    |
    | [Resolver 1 (AuthorID: A)] --Load(A)--> +------------------------+
    | [Resolver 2 (AuthorID: B)] --Load(B)--> | Dataloader (Batching)  |
    | [Resolver 3 (AuthorID: A)] --Load(A)--> | Mengumpulkan: [A, B]   |
    |                                         +------------------------+
    |                                                     |
    |                                                     | (HANYA 1 RPC CALL)
    |                                                     | GetUsersRequest{ Ids: ["A", "B"] }
    |                                                     v
    |                                          [gRPC User Microservice]
    |                                                     |
    |                                                     | GetUsersResponse
    |                                                     | { Users: [ {A}, {B} ] }
    |                                                     v
    | [Resolver 1] <---- (Terima User A) <----------------+
    | [Resolver 2] <---- (Terima User B) <----------------+
    | [Resolver 3] <---- (Terima User A via internal Cache)+
    v
(Mengembalikan 1 Struktur JSON GraphQL Utuh)
```

## Production-Ready Code & Testing
Implementasi ini menggunakan Go murni untuk mendemonstrasikan bagaimana *Dataloader* (simulasi batch sederhana) menembak endpoint gRPC secara massal (*batch processing*), dan disimulasikan secara E2E menggunakan `bufconn`.

```go
package graphqlgrpc_test

import (
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE
// API gRPC yang didesain khusus agar Dataloader bersahabat (menerima repeated ID)
// ==============================================================================
type User struct {
	Id   string
	Name string
}
type BatchGetUsersRequest struct {
	Ids []string // Didesain menerima Batch!
}
type BatchGetUsersResponse struct {
	// Kunci efisiensi Dataloader: Mengembalikan Map (atau array) agar mudah diindeks
	Users map[string]*User
}

type UserServiceServer interface {
	BatchGetUsers(context.Context, *BatchGetUsersRequest) (*BatchGetUsersResponse, error)
}

func RegisterUserServiceServer(s grpc.ServiceRegistrar, srv UserServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.UserService",
		HandlerType: (*UserServiceServer)(nil),
		Methods: []grpc.MethodDesc{{
			MethodName: "BatchGetUsers",
			Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
				req := new(BatchGetUsersRequest)
				if err := dec(req); err != nil { return nil, err }
				if interceptor == nil { return srv.(UserServiceServer).BatchGetUsers(ctx, req) }
				return interceptor(ctx, req, &grpc.UnaryServerInfo{Server: srv, FullMethod: "/acme.api.v1.UserService/BatchGetUsers"}, func(c context.Context, r interface{}) (interface{}, error) {
					return srv.(UserServiceServer).BatchGetUsers(c, r.(*BatchGetUsersRequest))
				})
			},
		}},
		Streams: []grpc.StreamDesc{}, Metadata: "user.proto",
	}, srv)
}

// ==============================================================================
// 2. DOMAIN LOGIC SERVER (gRPC Microservice)
// ==============================================================================
type myUserServer struct{}

func (s *myUserServer) BatchGetUsers(ctx context.Context, req *BatchGetUsersRequest) (*BatchGetUsersResponse, error) {
	// Batasi ukuran chunk, defensif
	if len(req.Ids) > 100 {
		return nil, status.Error(codes.InvalidArgument, "batch size exceeded limit of 100")
	}

	res := make(map[string]*User)
	for _, id := range req.Ids {
		// Simulasi database / domain logic
		if id == "A" { res[id] = &User{Id: "A", Name: "Alice"} }
		if id == "B" { res[id] = &User{Id: "B", Name: "Bob"} }
	}
	return &BatchGetUsersResponse{Users: res}, nil
}

// ==============================================================================
// 3. SIMULASI GRAPHQL DATALOADER
// ==============================================================================
// Di produksi, gunakan github.com/graph-gophers/dataloader atau vikstrous/dataloadgen
type MockDataloader struct {
	client     func(context.Context, *BatchGetUsersRequest) (*BatchGetUsersResponse, error)
	batchMutex sync.Mutex
	pendingIds []string
	results    map[string]*User
	isFetched  bool
}

func (m *MockDataloader) Load(ctx context.Context, id string) (*User, error) {
	m.batchMutex.Lock()
	if m.isFetched {
		// Mengambil dari in-memory request life-cycle cache
		val, ok := m.results[id]
		m.batchMutex.Unlock()
		if !ok { return nil, fmt.Errorf("not found") }
		return val, nil
	}
	
	// Tambah ID ke antrian batching
	m.pendingIds = append(m.pendingIds, id)
	m.batchMutex.Unlock()
	
	// Simulasi penundaan tipis (Tick) yang biasa dilakukan pustaka dataloader asli (misal: 2ms)
	time.Sleep(10 * time.Millisecond)

	m.batchMutex.Lock()
	defer m.batchMutex.Unlock()

	// Hanya 1 goroutine (yang tercepat) yang melakukan dispatch gRPC network call
	if !m.isFetched {
		resp, err := m.client(ctx, &BatchGetUsersRequest{Ids: m.pendingIds})
		if err != nil { return nil, err }
		m.results = resp.Users
		m.isFetched = true
	}

	val, ok := m.results[id]
	if !ok { return nil, fmt.Errorf("not found in batch") }
	return val, nil
}

// ==============================================================================
// 4. UNIT TEST E2E
// ==============================================================================
func TestGraphQL_BFF_Dataloader_Batching(t *testing.T) {
	lis := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	RegisterUserServiceServer(grpcServer, &myUserServer{})
	go func() { _ = grpcServer.Serve(lis) }()
	defer grpcServer.Stop()

	dialer := func(ctx context.Context, s string) (net.Conn, error) { return lis.Dial() }
	conn, _ := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(dialer), grpc.WithInsecure())
	defer conn.Close()

	// Bungkus Invoke gRPC ke dalam fungsi untuk Dataloader
	grpcInvoker := func(ctx context.Context, req *BatchGetUsersRequest) (*BatchGetUsersResponse, error) {
		resp := new(BatchGetUsersResponse)
		err := conn.Invoke(ctx, "/acme.api.v1.UserService/BatchGetUsers", req, resp)
		return resp, err
	}

	loader := &MockDataloader{
		client: grpcInvoker,
		results: make(map[string]*User),
	}

	var wg sync.WaitGroup
	var userA, userB *User

	// Simulasi GraphQL Resolver mengeksekusi fields secara Paralel
	wg.Add(2)
	
	go func() { // Resolver 1 butuh data Penulis "A"
		defer wg.Done()
		userA, _ = loader.Load(context.Background(), "A")
	}()
	
	go func() { // Resolver 2 butuh data Penulis "B"
		defer wg.Done()
		userB, _ = loader.Load(context.Background(), "B")
	}()

	wg.Wait()

	if userA.Name != "Alice" || userB.Name != "Bob" {
		t.Fatalf("Data mismatch: A=%v, B=%v", userA, userB)
	}
	
	// Validasi bahwa payload "pendingIds" dari Dataloader membuktikan itu menembak batch "A", "B" bersamaan
	if len(loader.pendingIds) != 2 {
		t.Errorf("Expected exactly 1 batch consisting of 2 elements, got lengths %d", len(loader.pendingIds))
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Desain API "Batch" di File Proto
Membangun BFF GraphQL tetapi tim Backend hanya memberikan API gRPC *Unary* (`GetUser(id)`) murni.

```go
// BAD: Resolver GraphQL terpaksa mengulangi panggilan gRPC yang memicu lonjakan jaringan dan overhead HTTP/2 header yang masif (N+1 murni).
func (r *Resolver) Author(ctx context.Context, obj *Article) (*User, error) {
    // Dipanggil 50 kali secara paralel dari GraphQL = 50 Network Calls ke gRPC Server
    resp, err := r.GRPCClient.GetUser(ctx, &GetUserReq{Id: obj.AuthorID})
}
```
**Mengapa berbahaya:** Latensi GraphQL Server Anda akan melonjak tajam karena *overhead connection multiplexing* meskipun dalam satu *pipe* HTTP/2. gRPC Backend juga akan memproses *Unmarshaling* 50 kali dan mungkin melakukan 50 *query* pangkalan data individual secara terpisah (menguras RAM dan CPU Pool Database).

**Benar:** Backend engineer HARUS selalu memfasilitasi endpoint khusus *Bulk / Batch* (misal `BatchGetUsers(repeated string id)`) pada definisi Protobuf saat berkoordinasi dengan tim Frontend/BFF.

### ❌ Anti-Pattern 2: Kegagalan Propagasi Auth/Metadata dari GraphQL ke gRPC
Permintaan (Request) masuk ke BFF, dan resolver GraphQL mengirim ke gRPC tanpa mengekstrak `Authorization` token header.

```go
// BAD: Tidak menyisipkan otorisasi dari GraphQL HTTP header ke gRPC Metadata.
func (r *Resolver) Me(ctx context.Context) (*User, error) {
    // Klien gRPC ini anonim, meskipun Klien GraphQL melempar Bearer Token.
    resp, err := r.GRPCClient.GetProfile(context.Background(), &Req{})
}
```
**Mengapa berbahaya:** Servis Microservice internal yang memvalidasi otorisasi JWT akan selalu mereturn `codes.Unauthenticated`.

**Benar:** Ekstrak token dari `http.Request` GraphQL (biasanya disimpan di Context Middleware `gqlgen`), kemudian bungkus di `metadata.NewOutgoingContext()` sebelum mengeksekusi fungsi gRPC Klien.

## Edge Cases Khusus

1. **Partial Failure di Batching gRPC**: Dataloader mengirim 50 buah ID. Saat gRPC server melakukan kalkulasi, ID ke-49 error (contoh: *Data Corrupted*), sedangkan 49 lainnya sukses. Jika gRPC server langsung me-return `return nil, status.Error(...)`, 49 data yang sukses akan dikorbankan dan seluruh graf Kueri GraphQL akan *Fail / Nil*. Solusinya: gRPC harus menggunakan model desain *Response* yang memiliki properti array dari elemen campuran keberhasilan dan kegagalan (misalnya struct protobuf kustom `Message Result { User user = 1; string error = 2; }`), lalu BFF GraphQL memetakan properti `error` tersebut ke *GraphQL Error Path* individual.
2. **Context Deadline Cancellation**: Jika klien membatalkan HTTP GET Kueri GraphQL di Browser (contoh pengguna menutup tab React), paket Context BFF otomatis *Canceled*. Pastikan Context ini dioper (propagate) *langsung* ke gRPC Client Anda (tanpa `context.Background()`), agar microservice ikut membatalkan proses database yang sedang berjalan dan menghemat *resources*.
3. **Over-Batching di Dataloader**: Meskipun DataLoader mengumpulkan ID, batas memori protobuf default *Max Message Size* adalah 4MB. Jika Dataloader membengkak hingga puluhan ribu ID dalam sekali *tick* waktu penantian (2 milidetik), *Request Header/Payload* akan melampaui ambang batas 4MB yang akan membuat fungsi `Invoke` gRPC Klien *panic/crash*. Lakukan proteksi maksimal ID limit (misal: 100 IDs per Batch) di opsi konfigurasi Dataloader Anda.

## Kapan JANGAN Pakai Ini

- **Untuk API yang dikonsumsi satu klien yang Anda kendalikan sendiri.** Fleksibilitas query adalah jawaban atas masalah "banyak klien dengan kebutuhan berbeda". Bila kliennya satu dan tim yang sama menulisnya, REST atau gRPC lebih sederhana, lebih mudah di-cache, dan lebih mudah diamati.
- **Tanpa batas kedalaman dan kompleksitas query.** Query bersarang dalam adalah vektor DoS yang sah: satu permintaan kecil bisa memicu ribuan query database. Batas ini bukan pengaturan lanjutan — ia prasyarat.
- **Tanpa dataloader.** GraphQL membuat N+1 hampir tidak terhindarkan karena resolver dipanggil per node. Satu query yang mengembalikan 100 item menghasilkan 101 query database bila batching tidak dipasang.
- **Untuk API publik tanpa persisted query.** Membiarkan siapa saja mengirim query sembarang berarti Anda tidak bisa memperkirakan beban, tidak bisa meng-cache di CDN, dan tidak bisa melarang bentuk query yang mahal.
- **Sebagai lapisan tipis di atas gRPC yang hilirnya tidak punya API batch.** Dataloader hanya bisa membatch bila layanan hilir menyediakan endpoint batch; tanpa itu, N+1 hanya berpindah satu lapis.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu permintaan memicu ratusan query DB | jumlah span `db` per trace | Dataloader tidak dipasang, atau hilir tanpa API batch |
| Beban tidak bisa diprediksi dari jumlah permintaan | sebaran kompleksitas query | Tidak ada batas kompleksitas |
| Cache CDN tidak pernah kena | apakah persisted query dipakai | Query sembarang lewat `POST` tidak bisa di-cache |
| Satu klien menjatuhkan seluruh layanan | kedalaman query maksimum | Tidak ada batas kedalaman |
| Latensi p99 sangat berayun | variasi bentuk query | Beban ditentukan bentuk query, bukan jumlahnya |

```bash
# Jumlah query DB per permintaan GraphQL -- di atas 20 hampir pasti N+1
curl -s "$JAEGER/api/traces?service=gql&limit=20" \
  | jq '[.data[] | {t:.traceID, db:([.spans[]|select(.operationName|test("^db"))]|length)}]
        | sort_by(-.db)[:5]'

# Kedalaman dan kompleksitas yang benar-benar masuk
kubectl logs -l app=gql --since=1h | jq -r 'select(.kedalaman) | .kedalaman' | sort -n | tail -5
curl -s localhost:9090/metrics | grep -E 'graphql_(complexity|depth|resolver_duration)'
```
