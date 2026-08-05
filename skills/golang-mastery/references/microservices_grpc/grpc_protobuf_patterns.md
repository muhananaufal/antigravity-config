# gRPC dan Protobuf Patterns di Go: Schema Design dan Evolusi

> **Berlaku:** Go 1.21+ · `google.golang.org/protobuf` · `buf` CLI · **Lihat juga:** `microservices_grpc/api_versioning_strategy.md` · `microservices_grpc/grpc_streaming_patterns.md` · `microservices_grpc/grpc_interceptors_middleware.md` · `microservices_grpc/openapi_ogen_codegen.md`

## Konsep dan Internals
Protocol Buffers (Protobuf) adalah mekanisme dari Google untuk serialisasi struktur data yang independen dari bahasa pemrograman dan platform. Dalam arsitektur microservices Go, Protobuf v3 (`proto3`) digunakan sebagai *Interface Definition Language* (IDL) tunggal bersama gRPC.

Keunggulan dan konsep kritikal dalam `proto3`:
- **Tidak ada presence pada skalar — bukan "opsional"**: Ini sering disalahpahami dengan akibat yang mahal. Field skalar `proto3` **tidak menyimpan informasi apakah ia diisi**. `int32 umur = 1` yang tidak dikirim dan yang dikirim bernilai `0` menghasilkan byte yang **identik**; di Go keduanya menjadi `0`. Anda tidak bisa membedakan "tidak disetel" dari "disetel ke nol".

  Ini penting justru pada operasi `Update`: payload dengan `umur: 0` bisa berarti "jangan sentuh umur" atau "set umur ke 0", dan server tidak punya cara mengetahuinya. Tiga jalan keluar:
  - **kata kunci `optional`** (protobuf 3.15+) — memberi presence eksplisit, dan inilah pilihan bawaan sekarang;
  - **wrapper types** (`google.protobuf.Int32Value`) — cara lama, masih dipakai di API yang sudah rilis;
  - **`FieldMask`** — pemanggil menyebutkan field mana yang dimaksud, dan nilai nol menjadi tidak ambigu.

  Yang benar-benar opsional adalah **kompatibilitasnya**: field yang tidak dikenal penerima diabaikan, sehingga versi lama dan baru bisa hidup berdampingan.
- **Polymorphism dengan `oneof`**: Memungkinkan pendefinisian sekumpulan field di mana hanya salah satu yang bisa diisi pada satu waktu. Sangat ideal untuk *Domain-Driven Design* (DDD) seperti pattern `Result` (Success vs Error).
- **Well-Known Types (WKT)**: Protobuf memiliki tipe bawaan yang canggih dari paket `google.protobuf`, seperti `Timestamp` (menggantikan int64 epoch time), `Duration`, `Struct` (untuk arbitrary JSON), dan *Wrappers* (seperti `Int32Value` untuk membedakan nilai `0` dan *null* / *unset*).
- **Field Masks (`google.protobuf.FieldMask`)**: Digunakan secara ekstensif pada operasi `Update` (mirip PATCH di HTTP) untuk memberi tahu server field mana secara spesifik yang diubah, menghindari overwriting akibat *zero value* bawaan Go saat struct di-unmarshal.
- **Strict Numbering**: Field number (seperti `= 1`, `= 2`) digunakan untuk *binary encoding*. Tag tidak boleh diubah atau di-reuse setelah dirilis.

## Diagram ASCII: Arsitektur Field Mask dan Protobuf

```ascii
[gRPC Client]                                    [gRPC Server]
      |                                                |
      | 1. Memanggil RPC `UpdateUser`                  |
      | Payload:                                       |
      | {                                              |
      |   user: { id: "123", name: "Alice" }           |
      |   update_mask: { paths: ["name"] }             |
      | }                                              |
      |----------------------------------------------->|
                                                       | 2. Menerima Byte Stream
                                                       | 3. Protobuf Unmarshal ke Go Struct
                                                       | 4. Validasi Masking:
                                                       |    Hanya ubah "name", biarkan "email"
                                                       |    meskipun "email" di payload = ""
                                                       | 5. Simpan ke Database
      |<-----------------------------------------------|
      | 6. Mengembalikan Response (Struct User baru)   |
```

## Production-Ready Code & Testing
Berikut adalah contoh implementasi penerapan **Field Mask** dan pola `oneof` secara efisien dan aman. Skrip mensimulasikan testing dengan in-memory network `bufconn`.

```go
package protobufpatterns_test

import (
	"context"
	"log"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	// Simulasi import protobuf yang seharusnya di-generate protoc
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ==============================================================================
// 1. SIMULASI PROTO-GENERATED CODE
// Normalnya ini di-generate otomatis dari file `.proto` menggunakan `protoc`.
// ==============================================================================

// User struct disimulasikan sebagai hasil protoc
type User struct {
	Id        string                 `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Name      string                 `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`
	Email     string                 `protobuf:"bytes,3,opt,name=email,proto3" json:"email,omitempty"`
	CreatedAt *timestamppb.Timestamp `protobuf:"bytes,4,opt,name=created_at,json=createdAt,proto3" json:"created_at,omitempty"`
}

type UpdateUserRequest struct {
	User       *User                  `protobuf:"bytes,1,opt,name=user,proto3" json:"user,omitempty"`
	UpdateMask *fieldmaskpb.FieldMask `protobuf:"bytes,2,opt,name=update_mask,json=updateMask,proto3" json:"update_mask,omitempty"`
}

type UpdateUserResponse struct {
	// Simulasi penerapan pattern oneof
	// oneof result { User success = 1; ErrorDetails error = 2; }
	Result isUpdateUserResponse_Result `protobuf_oneof:"result"`
}

type isUpdateUserResponse_Result interface {
	isUpdateUserResponse_Result()
}

type UpdateUserResponse_Success struct {
	Success *User `protobuf:"bytes,1,opt,name=success,proto3,oneof"`
}
type UpdateUserResponse_Error struct {
	Error string `protobuf:"bytes,2,opt,name=error,proto3,oneof"`
}

func (*UpdateUserResponse_Success) isUpdateUserResponse_Result() {}
func (*UpdateUserResponse_Error) isUpdateUserResponse_Result()   {}

// UserServiceServer simulasi interface
type UserServiceServer interface {
	UpdateUser(context.Context, *UpdateUserRequest) (*UpdateUserResponse, error)
}

func RegisterUserServiceServer(s grpc.ServiceRegistrar, srv UserServiceServer) {
	s.RegisterService(&grpc.ServiceDesc{
		ServiceName: "acme.api.v1.UserService",
		HandlerType: (*UserServiceServer)(nil),
		Methods: []grpc.MethodDesc{
			{
				MethodName: "UpdateUser",
				Handler: func(srv interface{}, ctx context.Context, dec func(interface{}) error, interceptor grpc.UnaryServerInterceptor) (interface{}, error) {
					in := new(UpdateUserRequest)
					if err := dec(in); err != nil {
						return nil, err
					}
					if interceptor == nil {
						return srv.(UserServiceServer).UpdateUser(ctx, in)
					}
					info := &grpc.UnaryServerInfo{Server: srv, FullMethod: "/acme.api.v1.UserService/UpdateUser"}
					handler := func(ctx context.Context, req interface{}) (interface{}, error) {
						return srv.(UserServiceServer).UpdateUser(ctx, req.(*UpdateUserRequest))
					}
					return interceptor(ctx, in, info, handler)
				},
			},
		},
		Streams:  []grpc.StreamDesc{},
		Metadata: "user.proto",
	}, srv)
}

// ==============================================================================
// 2. IMPLEMENTASI SERVICE DOMAIN LOGIC
// ==============================================================================

type myUserServer struct {
	// dependencies like DB injected here
}

func (s *myUserServer) UpdateUser(ctx context.Context, req *UpdateUserRequest) (*UpdateUserResponse, error) {
	// Pengecekan deadline kontekstual (wajib di production)
	if err := ctx.Err(); err != nil {
		return nil, status.Error(codes.Canceled, "request canceled or timed out")
	}

	if req.User == nil {
		return nil, status.Error(codes.InvalidArgument, "user payload is required")
	}

	// SATU KONTRAK GALAT, BUKAN DUA.
	//
	// Versi sebelumnya melaporkan "mask kosong" lewat oneof error DENGAN
	// `nil` sebagai galat gRPC, tetapi melaporkan "path tidak valid" lewat
	// status.Error. Dua cara untuk kelas kesalahan yang sama.
	//
	// Akibat yang lebih buruk daripada sekadar tidak konsisten: RPC yang
	// mengembalikan nil error terlihat SUKSES bagi seluruh lapisan di
	// atasnya. Interceptor metrik menghitungnya sebagai OK, tracing
	// menandainya hijau, circuit breaker tidak melihat apa-apa. Kegagalan
	// validasi menjadi tidak terlihat di dasbor mana pun.
	//
	// Aturannya: kegagalan yang disebabkan pemanggil -> status.Error dengan
	// kode yang tepat. oneof Result dipakai untuk hasil BISNIS yang sah
	// (mis. "ditolak karena kuota habis"), bukan untuk galat protokol.
	if req.UpdateMask == nil || len(req.UpdateMask.Paths) == 0 {
		return nil, status.Error(codes.InvalidArgument,
			"update_mask wajib diisi untuk pembaruan sebagian")
	}

	// VALIDASI SELURUH PATH LEBIH DULU, baru terapkan.
	//
	// Memvalidasi sambil menerapkan berarti path ke-3 yang tidak valid
	// membatalkan permintaan SETELAH path 1 dan 2 sudah diubah. Di sini
	// perubahannya masih di memori, tetapi pada repository yang menulis
	// per-field, itu pembaruan sebagian yang tidak bisa ditarik kembali.
	const (
		fieldNama  = "name"
		fieldEmail = "email"
	)
	for _, path := range req.UpdateMask.Paths {
		switch path {
		case fieldNama, fieldEmail:
			// diizinkan
		case "created_at", "id":
			return nil, status.Errorf(codes.InvalidArgument, "field %q cannot be updated", path)
		default:
			return nil, status.Errorf(codes.InvalidArgument, "unknown field mask: %q", path)
		}
	}

	// Mock data yang sudah ada di database
	existingUser := &User{
		Id:        req.User.Id,
		Name:      "Old Name",
		Email:     "old@example.com",
		CreatedAt: timestamppb.Now(),
	}

	// Terapkan setelah SELURUH path terbukti sah.
	for _, path := range req.UpdateMask.Paths {
		switch path {
		case fieldNama:
			existingUser.Name = req.User.Name
		case fieldEmail:
			existingUser.Email = req.User.Email
		}
	}

	// Return response keberhasilan dengan pattern oneof
	return &UpdateUserResponse{
		Result: &UpdateUserResponse_Success{Success: existingUser},
	}, nil
}

// ==============================================================================
// 3. UNIT TEST MENGGUNAKAN BUFCONN
// ==============================================================================

func TestProtobufPatternsWithBufconn(t *testing.T) {
	const bufSize = 1024 * 1024
	lis := bufconn.Listen(bufSize)

	// 1. Setup Server In-Memory
	grpcServer := grpc.NewServer()
	RegisterUserServiceServer(grpcServer, &myUserServer{})

	go func() {
		if err := grpcServer.Serve(lis); err != nil {
			log.Fatalf("Server exited with error: %v", err)
		}
	}()
	defer grpcServer.Stop()

	// 2. Setup Client Dialing In-Memory
	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, err := grpc.NewClient("bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("Failed to dial bufnet: %v", err)
	}
	defer conn.Close()

	// 3. Simulasi Client RPC Invoke

	t.Run("Update With Valid Mask", func(t *testing.T) {
		req := &UpdateUserRequest{
			User: &User{
				Id:    "123",
				Name:  "Alice Updated",
				Email: "", // Sengaja kosong, harusnya tidak ter-update karena tidak di-mask
			},
			UpdateMask: &fieldmaskpb.FieldMask{
				Paths: []string{"name"},
			},
		}
		
		resp := new(UpdateUserResponse)
		err := conn.Invoke(ctx, "/acme.api.v1.UserService/UpdateUser", req, resp)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}

		// Validasi pattern oneof
		switch r := resp.Result.(type) {
		case *UpdateUserResponse_Success:
			if r.Success.Name != "Alice Updated" {
				t.Errorf("Expected Name 'Alice Updated', got %s", r.Success.Name)
			}
			// Email harus tetap old@example.com (mensimulasikan logic mask)
			if r.Success.Email != "old@example.com" {
				t.Errorf("Expected old email to be retained, got %s", r.Success.Email)
			}
		case *UpdateUserResponse_Error:
			t.Fatalf("Expected success response, got logic error: %s", r.Error)
		default:
			t.Fatalf("Unexpected response type")
		}
	})

	t.Run("Update Immutable Field", func(t *testing.T) {
		req := &UpdateUserRequest{
			User:       &User{Id: "123"},
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"created_at"}},
		}
		resp := new(UpdateUserResponse)
		err := conn.Invoke(ctx, "/acme.api.v1.UserService/UpdateUser", req, resp)
		
		if err == nil {
			t.Fatal("Expected error when updating immutable field, got nil")
		}
		
		st, ok := status.FromError(err)
		if !ok || st.Code() != codes.InvalidArgument {
			t.Fatalf("Expected InvalidArgument code, got %v", err)
		}
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengubah Tipe Data atau Menggunakan Kembali Nomor Field (Tag Reuse)
Dalam file `.proto`, nomor di belakang field (`= 1`, `= 2`) adalah identitas mutlak untuk biner. Modifikasi gegabah akan menghancurkan data.

```protobuf
// BAD: v1 memiliki string "name" di tag 2. Di v2, developer menghapusnya
// dan mengganti tag 2 dengan integer "age".
message User {
  string id = 1;
  // string name = 2; (dihapus)
  int32 age = 2; // SANGAT BERBAHAYA! Reuse tag.
}
```
**Mengapa berbahaya:** Protobuf serialisasi mengandalkan Tag (nomor) bukan nama field. Jika klien V1 mengirimkan nama (string) di *tag 2*, Server V2 akan mencoba men-decode string biner tersebut sebagai integer 32-bit. Aplikasi Go Anda akan mengalami data korup atau decoding error fatal (unmarshal gagal) yang berdampak pada *downtime*.

```protobuf
// GOOD: Gunakan 'reserved' untuk mencegah penggunaan ulang tag di masa depan.
message User {
  string id = 1;
  reserved 2;
  reserved "name";
  int32 age = 3;
}
```

### ❌ Anti-Pattern 2: Pattern `oneof` Tanpa Default Fallback di Go
Di Go, ketika meng-handle *oneof* interface dari struct hasil protoc, developer sering hanya mengecek kasus yang mereka ketahui.

```go
// BAD: Tidak mengecek tipe nil (default uninitialized).
switch r := resp.GetResult().(type) {
case *UpdateUserResponse_Success:
    // ...
case *UpdateUserResponse_Error:
    // ...
// Tidak ada default block
}
```
**Mengapa berbahaya:** Jika di masa depan developer protobuf menambahkan varian ketiga pada `oneof`, dan server mengembalikan tipe baru tersebut, aplikasi Client lama tidak akan mengenai blok *case* manapun. Logika aplikasi secara diam-diam akan gagal memproses respon (data hilang/blank screen), tanpa mencatatkan *panic* atau *error* sama sekali.

```go
// GOOD: Selalu berikan blok `default:` atau check nil.
switch r := resp.GetResult().(type) {
case *UpdateUserResponse_Success:
case *UpdateUserResponse_Error:
case nil:
    return fmt.Errorf("result is uninitialized or null")
default:
    return fmt.Errorf("unknown response type: %T", r)
}
```

## Edge Cases Khusus

1. **Panic pada Timestamp.AsTime()**: Field `*timestamppb.Timestamp` adalah sebuah struct pointer bawaan WKT. Jika klien lupa mengirimkan (atau sengaja tidak diisi), properti tersebut bernilai `nil`. Jika kode Anda memanggil `user.CreatedAt.AsTime()` tanpa mengecek `if user.CreatedAt != nil`, service gRPC Anda akan langsung meledak (*panic nil pointer dereference*).
2. **Limitasi Default Zero Values di Masking**: Protobuf 3 tidak mengirim properti *zero-value* (seperti `int32 = 0`, `string = ""`) pada network serialization. Ini artinya, tanpa `FieldMask`, Anda tidak dapat membedakan apakah Klien ingin mereset *balance* menjadi `0`, atau klien tidak berniat memperbarui properti *balance*. Selalu andalkan kombinasi *Field Mask* atau gunakan `google.protobuf.Int32Value` (wrapper objects yang bertindak seperti pointer) untuk bidang yang sensitif terhadap beda `0` dan `null`.
3. **Validasi Sub-Paths pada FieldMask**: Pada struktur bersarang (*nested structs*), klien dapat mengirim FieldMask string bertitik, seperti `update_mask.paths = ["profile.address.city"]`. Jika Anda melakukan masking secara naif di Go tanpa rekursif `switch` (atau library seperti `protoc-gen-go-fieldmask`), operasi update akan korup di level DB layer.
4. **Context Deadline Menghilang Saat Casting**: Walaupun `context` tersalurkan di gRPC Go, ketika melakukan manipulasi `metadata.MD` lalu membuat `OutgoingContext` baru dengan `context.Background()`, deadline bawaan request dari `IncomingContext` akan terbuang (*stripped*). Server akan menjalankan komputasi tak terbatas meski klien terputus. Pastikan menyambung metadata dengan `context.WithTimeout` turunan context aslinya.

## Kapan JANGAN Pakai Ini

- **Untuk API yang dikonsumsi browser secara langsung.** gRPC-Web membutuhkan proxy, dan alat pengembang browser tidak bisa membaca payload biner. Untuk API publik yang dipakai orang di luar tim Anda, JSON masih jauh lebih ramah didebug.
- **`optional`/`oneof` sebagai cara menghindari keputusan skema.** Skema yang serba opsional memindahkan seluruh validasi ke setiap pemanggil, dan pemanggil yang lupa memvalidasi tidak akan ketahuan sampai produksi.
- **Menyimpan pesan protobuf terserialisasi sebagai satu-satunya bentuk di database.** Ia tidak bisa di-query, tidak bisa dibaca manusia saat insiden, dan migrasi skemanya berubah menjadi migrasi kode.
- **`Any` kecuali benar-benar tidak ada jalan lain.** Ia mengembalikan sistem ke pengetikan dinamis, dan seluruh keuntungan kontrak yang bisa diperiksa mesin ikut hilang.
- **Memakai ulang nomor field yang pernah dihapus.** Ini kesalahan yang tidak bisa diperbaiki belakangan: klien lama akan menafsirkan byte lama sebagai field baru dan menghasilkan data yang salah tanpa satu pun galat. Selalu `reserved`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Klien lama membaca nilai yang tidak masuk akal | riwayat nomor field di `.proto` | Nomor field dipakai ulang setelah dihapus |
| `ResourceExhausted: received message larger than max` | ukuran pesan vs batas 4 MB | Payload melewati batas bawaan gRPC |
| Field baru selalu bernilai nol di klien lama | versi generate klien | Perilaku yang benar — pastikan memang disengaja |
| Perubahan proto lolos ke rilis lalu merusak klien | apakah `buf breaking` ada di CI | Tidak ada gerbang kompatibilitas |
| Deserialisasi gagal pada sebagian pesan | tipe field yang pernah berubah | Perubahan tipe pada nomor field yang sama |

```bash
buf lint
buf format -d

# Gerbang WAJIB di CI: menolak perubahan yang merusak klien
buf breaking --against '.git#branch=main'

# Nomor field yang dihapus tanpa reserved adalah bom waktu
grep -rn 'reserved' --include='*.proto' .

# Pesan melewati batas ukuran
kubectl logs -l app=api --since=1h | grep -c 'larger than max'
```
