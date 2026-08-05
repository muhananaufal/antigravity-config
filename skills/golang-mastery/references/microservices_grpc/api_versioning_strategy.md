# gRPC API Versioning Strategy

> **Berlaku:** Go 1.21+ · `buf breaking` · **Lihat juga:** `microservices_grpc/grpc_protobuf_patterns.md` · `microservices_grpc/openapi_ogen_codegen.md` · `db_sqlc/zero_downtime_migrations.md` · `engineering_practice/adr_decision_records.md`

## Konsep dan Internals
Dalam ekosistem gRPC dan Protobuf, evolusi API difokuskan pada stabilitas *contract* jangka panjang dengan Klien. Tidak seperti REST HTTP/1.1 yang biasanya mengandalkan *URL Versioning* (`/api/v1/users`) atau *Header Versioning*, gRPC menggunakan pendekatan struktural berbasis penamaan paket biner (*Package Namespace Versioning*). 

Prinsip Utama Evolusi gRPC API:
1. **Backward & Forward Compatibility Inheren**: Karena `proto3` menggunakan identifikasi Field Tag berupa angka integer (`= 1`, `= 2`), Klien V1 dan Klien V2 dapat mengonsumsi endpoint yang sama tanpa terputus, asalkan kita hanya menambah field (non-breaking) dan tidak pernah mengganti tipe atau tag-number.
2. **Package Versioning (Major Version)**: Saat perubahan struktur yang *Breaking* benar-benar tak terhindarkan (misalnya restrukturisasi fundamental payload), kita membuat direktori package *proto* yang benar-benar baru. (`package acme.api.v1;` menjadi `package acme.api.v2;`).
3. **Simultanous Serving**: Pada level Golang, peladen (Server) akan meregistrasi dan menghidupkan *handler* V1 dan V2 secara bersamaan di dalam satu instance `grpc.Server` dan TCP port yang persis sama. 
4. **Adapter / Anti-Corruption Layer**: Layer *domain / database* Golang tidak boleh terpengaruh oleh *versioning* eksternal ini. Handler V1 dan V2 bertindak sebagai *Adapter* yang menerjemahkan data lama/baru ke struct internal (*Canonical Model*) tunggal sebelum dieksekusi.

Tooling modern seperti `buf breaking` wajib diintegrasikan pada tahap CI/CD untuk mencegah modifikasi (seperti penghapusan field, perubahan nama proto, dll) yang secara siluman melanggar kompatibilitas kontrak lama.

## Diagram ASCII: Arsitektur Simultanous Versioning

```ascii
[Client V1 (Legacy)]                   [Client V2 (Modern Web)]
      | (Memanggil acme.v1.User)             | (Memanggil acme.v2.User)
      | Payload: { full_name }               | Payload: { first_name, last_name }
      v                                      v
+-------------------------------------------------------------------+
|  Multiplexer / gRPC Server (1 Port: 50051)                        |
|                                                                   |
|  +--------------------+             +--------------------+        |
|  | Handler_V1 Adapter |             | Handler_V2 Adapter |        |
|  | - Concat names     |             | - Passthrough      |        |
|  +--------------------+             +--------------------+        |
|            |                                   |                  |
|            | (Mapping ke Internal Canonical)   |                  |
|            v                                   v                  |
|  +-------------------------------------------------------+        |
|  |  Business Logic (Domain Services & Repository)        |        |
|  |  (Tidak mempedulikan versi, hanya tahu 1 struktur DB) |        |
|  +-------------------------------------------------------+        |
+-------------------------------------------------------------------+
```

## Production-Ready Code & Testing
Kode berikut memperlihatkan cara peladen gRPC Go menangani dua versi *Contract* secara bersamaan. Diuji via memori menggunakan `bufconn`.

```go
package apiversioning_test

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE V1 (LEGACY)
// ==============================================================================
type UserV1 struct {
	Id       string `protobuf:"bytes,1,opt,name=id"`
	FullName string `protobuf:"bytes,2,opt,name=full_name"`
}
type GetUserRequestV1 struct { Id string }
type GetUserResponseV1 struct { User *UserV1 }

type UserServiceV1Server interface {
	GetUserV1(context.Context, *GetUserRequestV1) (*GetUserResponseV1, error)
}
func RegisterUserServiceV1Server(s grpc.ServiceRegistrar, srv UserServiceV1Server) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.UserService",
		HandlerType: (*UserServiceV1Server)(nil),
		Methods: []grpc.MethodDesc{{
			MethodName: "GetUserV1",
			Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
				if interceptor == nil { return srv.(UserServiceV1Server).GetUserV1(ctx, &GetUserRequestV1{Id: "123"}) }
				return interceptor(ctx, &GetUserRequestV1{Id: "123"}, &grpc.UnaryServerInfo{Server: srv, FullMethod: "/acme.api.v1.UserService/GetUserV1"}, func(c context.Context, req interface{}) (interface{}, error) {
					return srv.(UserServiceV1Server).GetUserV1(c, req.(*GetUserRequestV1))
				})
			},
		}},
		Streams: []grpc.StreamDesc{}, Metadata: "user_v1.proto",
	}, srv)
}

// ==============================================================================
// 2. SIMULASI PROTO-GENERATED CODE V2 (MODERN)
// ==============================================================================
type UserV2 struct {
	Id        string `protobuf:"bytes,1,opt,name=id"`
	FirstName string `protobuf:"bytes,2,opt,name=first_name"`
	LastName  string `protobuf:"bytes,3,opt,name=last_name"`
}
type GetUserRequestV2 struct { Id string }
type GetUserResponseV2 struct { User *UserV2 }

type UserServiceV2Server interface {
	GetUserV2(context.Context, *GetUserRequestV2) (*GetUserResponseV2, error)
}
func RegisterUserServiceV2Server(s grpc.ServiceRegistrar, srv UserServiceV2Server) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v2.UserService",
		HandlerType: (*UserServiceV2Server)(nil),
		Methods: []grpc.MethodDesc{{
			MethodName: "GetUserV2",
			Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
				if interceptor == nil { return srv.(UserServiceV2Server).GetUserV2(ctx, &GetUserRequestV2{Id: "123"}) }
				return interceptor(ctx, &GetUserRequestV2{Id: "123"}, &grpc.UnaryServerInfo{Server: srv, FullMethod: "/acme.api.v2.UserService/GetUserV2"}, func(c context.Context, req interface{}) (interface{}, error) {
					return srv.(UserServiceV2Server).GetUserV2(c, req.(*GetUserRequestV2))
				})
			},
		}},
		Streams: []grpc.StreamDesc{}, Metadata: "user_v2.proto",
	}, srv)
}

// ==============================================================================
// 3. CANONICAL MODEL & BUSINESS LOGIC ADAPTERS
// ==============================================================================
// Internal canonical model di layer aplikasi
type InternalUser struct {
	ID        string
	FirstName string
	LastName  string
}

// Database Mock
func fetchUserFromDB(ctx context.Context, id string) (*InternalUser, error) {
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.Canceled, "request canceled")
	}
	if id != "123" {
		return nil, status.Error(codes.NotFound, "user not found")
	}
	return &InternalUser{ID: "123", FirstName: "John", LastName: "Doe"}, nil
}

// Handler Adapter untuk V1
type myUserServerV1 struct{}
func (s *myUserServerV1) GetUserV1(ctx context.Context, req *GetUserRequestV1) (*GetUserResponseV1, error) {
	domainUser, err := fetchUserFromDB(ctx, req.Id)
	if err != nil { return nil, err }
	
	// Translasi dari Internal (Modern) ke External V1 (Legacy)
	fullName := domainUser.FirstName + " " + domainUser.LastName
	return &GetUserResponseV1{
		User: &UserV1{Id: domainUser.ID, FullName: fullName},
	}, nil
}

// Handler Adapter untuk V2
type myUserServerV2 struct{}
func (s *myUserServerV2) GetUserV2(ctx context.Context, req *GetUserRequestV2) (*GetUserResponseV2, error) {
	domainUser, err := fetchUserFromDB(ctx, req.Id)
	if err != nil { return nil, err }
	
	// Translasi 1:1
	return &GetUserResponseV2{
		User: &UserV2{Id: domainUser.ID, FirstName: domainUser.FirstName, LastName: domainUser.LastName},
	}, nil
}

// ==============================================================================
// 4. UNIT TEST MENGGUNAKAN BUFCONN
// ==============================================================================
func TestAPIVersioningSimultaneousServing(t *testing.T) {
	lis := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()

	// REGISTRASI MULTI-VERSION PADA SATU SERVER
	RegisterUserServiceV1Server(grpcServer, &myUserServerV1{})
	RegisterUserServiceV2Server(grpcServer, &myUserServerV2{})

	go func() { _ = grpcServer.Serve(lis) }()
	defer grpcServer.Stop()

	dialer := func(context.Context, string) (net.Conn, error) { return lis.Dial() }
	conn, _ := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(dialer), grpc.WithInsecure())
	defer conn.Close()

	// Uji Klien Legacy (V1)
	t.Run("Client V1 Access", func(t *testing.T) {
		respV1 := new(GetUserResponseV1)
		err := conn.Invoke(context.Background(), "/acme.api.v1.UserService/GetUserV1", &GetUserRequestV1{Id: "123"}, respV1)
		
		if err != nil { t.Fatalf("Expected no error, got %v", err) }
		if respV1.User.FullName != "John Doe" {
			t.Errorf("Expected concat FullName 'John Doe', got %v", respV1.User.FullName)
		}
	})

	// Uji Klien Modern (V2)
	t.Run("Client V2 Access", func(t *testing.T) {
		respV2 := new(GetUserResponseV2)
		err := conn.Invoke(context.Background(), "/acme.api.v2.UserService/GetUserV2", &GetUserRequestV2{Id: "123"}, respV2)
		
		if err != nil { t.Fatalf("Expected no error, got %v", err) }
		if respV2.User.FirstName != "John" {
			t.Errorf("Expected FirstName 'John', got %v", respV2.User.FirstName)
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyusupkan Flag Versi (`isV2`) Menembus Layer Bisnis/Database
Menyelesaikan masalah versioning dengan *spaghetti logic* flag kontrol di dalam fungsi inti database/domain Anda sangatlah rapuh.

```go
// BAD: Logic DB Anda memiliki if/else brutal berdasarkan versi klien API
func (repo *UserRepository) FetchUser(ctx context.Context, id string, isV2 bool) (*DomainUser, error) {
    if isV2 {
        return repo.queryNewTable(...)
    }
    return repo.queryOldLegacyTable(...)
}
```
**Mengapa berbahaya:** Lapisan domain/repositori akan hancur dan membengkak drastis dengan kerumitan yang eksponensial setiap kali ada rilis V3, V4. Mengotori *Clean Architecture*.

**Solusi Benar:** Gunakan pola Adapter (*seperti kode di atas*). Handler Endpoint (Lapisan *Transport*) adalah yang bertanggung jawab atas penyesuaian/translasi tipe data, sedangkan Lapisan Repositori hanya mengetahui model data 1 bentuk paling modern. 

### ❌ Anti-Pattern 2: Mutasi Definisi Proto Lama Secara Diam-Diam
Alih-alih membuat direktori dan paket *proto* baru (`v2`), developer memodifikasi isi file *proto* `v1` yang sudah berjalan di *production* karena malas meregistrasi service gRPC baru.

```protobuf
// BAD: Menghapus field di file v1 proto yang sudah pernah dirilis 
package acme.api.v1;
message User {
  // string full_name = 1; (dihapus diam-diam)
  string first_name = 2; // tambahan baru
}
```
**Mengapa berbahaya:** Aplikasi Klien mobile yang dirilis bulan lalu dan masih menembakkan Field tag `= 1` kini datanya akan di-drop/dibuang oleh Server secara diam-diam. Proses serialisasi/deserialisasi (*binary wire*) akan berantakan (*Silent failure* / *Corrupted bytes*). Selalu gunakan utilitas deteksi *Breaking Change* seperti `buf breaking`. 

## Edge Cases Khusus

1. **Database Schema Breaking Change vs API (Kolom Hilang)**: Ketika API berevolusi menjadi V2 dan memisahkan string `full_name` menjadi dua bagian independen (`first_name`, `last_name`), Anda tidak boleh langsung men-drop kolom fisik `full_name` di database PostgreSQL. Jika Anda men-drop-nya, Handler Klien V1 tidak memiliki data asli (*source of truth*) untuk disajikan, karena konkat `first_name + " " + last_name` mungkin secara tata letak salah jika format asli nama tersebut tidak standar. *Defensive strategy*: Di fase deprecation (sering bertahun-tahun lamanya), Database memegang semua state dengan *backfilling scripts*, hingga analitik menunjukkan sisa traffic Klien V1 mencapai angka nol absolute.
2. **Webhook / Asynchronous Payload Versioning**: Jika ekosistem microservice Anda menerbitkan Pub/Sub event asinkron atau Webhook HTTP (e.g. `UserCreatedEvent`) melalui jembatan gRPC-Gateway, versi struktur pesan tersebut juga terikat kuat pada Klien pendengar. Meningkatkan Service ke V2 dan mengirim event dengan struktur V2 secara paksa akan menyebabkan aplikasi pihak ketiga (Partner) kebingungan memilah *JSON mapping* dan men-trigger interupsi fatal. Sistem Anda harus menyimpan preferensi `WebhookVersion` untuk setiap mitra (Misal Partner A masih V1, Partner B V2).
3. **Konflik Package Naming dalam Kode Golang**: Saat `protoc` (atau `buf generate`) menghasilkan *structs* Go untuk `v1` dan `v2`, nama Go package hasil gen bisa bentrok (*import collision*) karena identitas namanya sama-sama disederhanakan menjadi `userpb`. Kustomisasi konfigurasi `go_package` di opsi `.proto` mutlak diperlukan, contohnya: `option go_package = "github.com/acme/repo/api/v1;userpbv1";`.

## Kapan JANGAN Pakai Ini

- **Membuat `v2` untuk perubahan yang sebenarnya bisa dilakukan secara kompatibel.** Setiap versi baru adalah dua sistem yang harus dipelihara, diuji, dipantau, dan diamankan — selamanya, sampai ada yang berani mematikannya.
- **Versi di header untuk API publik.** Ia tidak terlihat di URL, sulit di-cache, sulit didokumentasikan, dan sulit direproduksi dari log. Untuk API internal itu bisa diterima; untuk publik, versi di path lebih jujur.
- **Menyusupkan flag versi ke lapisan domain.** Begitu `if isV2` muncul di service atau repository, setiap perubahan berikutnya harus mempertimbangkan dua dunia sekaligus. Versi adalah urusan lapisan transport, dan harus berhenti di situ.
- **Menjanjikan dukungan tanpa tanggal akhir.** Tanpa tanggal sunset yang diumumkan sejak versi itu lahir, `v1` akan hidup selamanya dan menjadi alasan setiap penundaan berikutnya.
- **Mengubah makna field tanpa mengubah namanya.** Kompatibel secara biner, tidak kompatibel secara semantik — dan tidak ada satu pun alat yang bisa mendeteksinya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `v1` tidak pernah bisa dimatikan | metrik pemakaian per versi | Tanpa angka, sunset hanya harapan |
| Perbaikan bug hanya masuk ke satu versi | riwayat commit per versi | Dua basis kode menyimpang diam-diam |
| Klien rusak tanpa ada perubahan skema | makna field yang berubah | Perubahan semantik tanpa perubahan nama |
| Beban dukungan tinggi untuk versi lama | siapa yang masih memakainya | Tidak ada komunikasi migrasi yang menyasar pemakai nyata |
| Versi baru dirilis tiap kuartal | apa yang memicu versi baru | Perubahan kompatibel diperlakukan sebagai breaking |

```bash
buf breaking --against '.git#branch=main'

# Siapa yang masih memakai versi lama -- ini yang membuat sunset mungkin
kubectl logs -l app=api --since=24h | jq -r '.path' | grep -oE '^/v[0-9]+' | sort | uniq -c

# Klien mana yang belum bermigrasi
kubectl logs -l app=api --since=24h \
  | jq -r 'select(.path|startswith("/v1/")) | .user_agent' | sort | uniq -c | sort -rn | head

# PromQL untuk dasbor sunset:
#   sum by (versi) (rate(http_requests_total[24h]))
```
