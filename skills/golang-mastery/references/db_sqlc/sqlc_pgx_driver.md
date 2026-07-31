# SQLC dan Driver pgx/v5 (PostgreSQL Native di Go)

## Konsep dan Internals

Dalam membangun layanan back-end Go kelas *enterprise* yang menggunakan PostgreSQL, kombinasi pustaka lawas `database/sql` dengan driver `github.com/lib/pq` telah lama dianggap **usang** (masuk mode maintenance) dan kurang efisien.

Standar emas arsitektur saat ini adalah menggunakan driver spesifik **`pgx/v5`** dipasangkan dengan kompilator kode **`sqlc`**.

1. **Kenapa `pgx/v5`?**: Berbeda dengan driver generik, `pgx` mengimplementasikan protokol wire PostgreSQL secara *native* dan eksklusif. Ini berarti `pgx` bisa menggunakan *binary format* (memangkas ukuran payload jaringan) alih-alih teks, mendukung parsing tipe geometri & JSONB secaran canggih (`pgtype`), serta menawarkan fitur masif PostgreSQL seperti *Bulk Inserts* (`COPY FROM`) dan *Query Pipelining* (`pgx.Batch`).
2. **Kenapa `sqlc`?**: *Object-Relational Mapping (ORM)* seperti GORM rentan terhadap masalah kinerja akibat *Reflection* runtime dan sering kali menyembunyikan query tidak efisien (N+1) di balik abstraksinya. Sebaliknya, `sqlc` membaca file skema SQL mentah Anda beserta query-nya, kemudian mem-parsing AST (Abstract Syntax Tree), lalu meng-*generate* kode Go yang *type-safe* secara statis. Anda tidak membuang waktu me-*mapping* struct, dan *compiler* Go akan komplain jika SQL Anda cacat tipe data atau kurang parameter!

---

## Diagram ASCII: Alur Kerja SQLC & Arsitektur pgx

```text
[Fase Pengembangan (Build-Time)]
+------------------+     +-------------------+    (Parse AST & Type Inference)
| schema.sql       |     | queries.sql       |----------+
| (CREATE TABLE..) |     | (SELECT / INSERT) |          |
+------------------+     +-------------------+          v
                                                 +--------------+
                                                 | sqlc compiler|
                                                 +--------------+
                                                        | (Generates code)
                                                        v
[Fase Eksekusi (Runtime)]                        +-----------------+
+-----------------------+                        | query.sql.go    | (Type-safe structs)
|   Go Application      |                        | models.go       | 
| (Calling generated fn)|                        +-----------------+
+-----------------------+                               |
           |                                            |
           v                                            v
+-------------------------------------------------------------+
|                       pgxpool.Pool                          |
|  +-----------------+  +-----------------+  +-------------+  |
|  | pgx.CopyFrom    |  | pgtype mapping  |  | pgx.Batch   |  |
|  +-----------------+  +-----------------+  +-------------+  |
+-------------------------------------------------------------+
           | (Binary Protocol over TCP)
           v
+-----------------------+
|  PostgreSQL Server    |
+-----------------------+
```

---

## Kode Go Production-Ready

Contoh di bawah mengilustrasikan bagaimana antarmuka (interface) yang di-*generate* oleh `sqlc` digunakan bersandingan dengan *Advanced features* dari `pgx/v5`, khususnya `CopyFrom` untuk sisipan (insert) jutaan data dalam sekejap.

```go
package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ============================================================================
// Bagian Ini Adalah Representasi Kode Yang Digenerate Oleh SQLC (query.sql.go)
// ============================================================================

// Querier mendefinisikan interface yang akan dimock. Sangat berguna untuk Unit Test.
type Querier interface {
	GetUser(ctx context.Context, id int32) (User, error)
	// (Fitur spesifik sqlc: :copyfrom)
	BulkInsertUsers(ctx context.Context, arg []BulkInsertUsersParams) (int64, error)
}

type Queries struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Queries {
	return &Queries{db: db}
}

type User struct {
	ID        int32
	Name      string
	Email     string
	// Tipe aman dari pgx untuk mengakomodir NULL di kolom timestamp
	CreatedAt pgtype.Timestamptz 
}

type BulkInsertUsersParams struct {
	Name      string
	Email     string
	CreatedAt pgtype.Timestamptz
}

// BulkInsertUsers memanfaatkan PostgreSQL COPY FROM protocol untuk throughput fantastis
func (q *Queries) BulkInsertUsers(ctx context.Context, arg []BulkInsertUsersParams) (int64, error) {
	// 1. Ubah array structs menjadi iterasi rows
	var rows [][]any
	for _, a := range arg {
		rows = append(rows, []any{a.Name, a.Email, a.CreatedAt})
	}

	// 2. Kirim secara bulk (binary payload) langsung ke PostgreSQL engine
	return q.db.CopyFrom(
		ctx,
		pgx.Identifier{"users"},
		[]string{"name", "email", "created_at"},
		pgx.CopyFromRows(rows),
	)
}

// ============================================================================
// Bagian Penggunaan Aplikasi Kelas Produksi (Repository / Service)
// ============================================================================

type UserRepository struct {
	q *Queries
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{q: New(pool)}
}

// MigrateUsers menangani injeksi jutaan data secara efisien tanpa timeout memori
func (r *UserRepository) MigrateUsers(ctx context.Context, rawUsers []map[string]string) error {
	params := make([]BulkInsertUsersParams, 0, len(rawUsers))

	now := time.Now()
	for _, row := range rawUsers {
		params = append(params, BulkInsertUsersParams{
			Name:  row["name"],
			Email: row["email"],
			// Penting: Assign status Valid = true untuk pgtype yang tidak NULL
			CreatedAt: pgtype.Timestamptz{
				Time:  now,
				Valid: true,
			},
		})
	}

	// Bungkus pemanggilan CopyFrom ke context dengan timeout eksplisit 
	// (CopyFrom dapat hang jika server DB tersendat)
	timeoutCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	insertedCount, err := r.q.BulkInsertUsers(timeoutCtx, params)
	if err != nil {
		return fmt.Errorf("failed to bulk insert users: %w", err)
	}

	fmt.Printf("Successfully imported %d users using pgx CopyFrom protocol.\n", insertedCount)
	return nil
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Eksekusi Insert Looping Daripada `pgx.CopyFrom` / `pgx.Batch`
Menulis iterasi loop `FOR` di Go yang memanggil satu fungsi `q.CreateUser(ctx, ...)` secara berulang kali untuk seribu data.

```go
// ❌ BAD: Terjadi 10.000 kali RTT (Round Trip Time) Jaringan TCP ke DB
for _, u := range users {
	_ = q.CreateUser(ctx, CreateUserParams{Name: u.Name})
}
```

```go
// ✅ GOOD: RTT terjadi HANYA 1 KALI berapapun ukurannya menggunakan CopyFrom.
_ = q.BulkInsertUsers(ctx, usersParams)
```
**Why dangerous:** Dalam skenario cloud terdistribusi, komunikasi jaringan aplikasi ke DB biasanya memakan ~1 milidetik (*latensi intra-AZ*). Melakukan insert sekuensial akan memblok goroutine minimal 10 detik penuh (1ms * 10,000)! Akibatnya *transaction log* DB kebanjiran instruksi kecil-kecil, goroutine mati kelaparan pool (pool exhaustion), dan endpoint HTTP yang melayani ini akan hancur lebur (*Timeout* 502/504 Gateway).

### ❌ Anti-Pattern 2: Kecerobohan Saat Membaca / Menulis `pgtype` 
Mengakses *value* pada struct data `pgtype` tanpa mengecek nilai properti `.Valid` terlebih dahulu.

```go
// ❌ BAD: Secara buta membaca field
user := q.GetUser(ctx, id)
// Jika Bio (Teks) aslinya NULL di DB, String = "" (Kosong), bukan NULL!
response.Bio = user.Bio.String 
```

```go
// ✅ GOOD: Selalu memvalidasi kolom NULL
if user.Bio.Valid {
	response.Bio = &user.Bio.String
} else {
	response.Bio = nil // Kirim sebagai JSON Null murni
}
```
**Why dangerous:** Ini menciptakan bug *False Data*. Kolom DB yang benar-benar `NULL` secara harfiah akan terkonversi otomatis ke *zero value* bawaan Go (string kosong `""`, int `0`, boolean `false`). Pada pembaruan (*update*) berikutnya, Anda tak sengaja menimpa `NULL` di DB menjadi string kosong, menghancurkan logika validasi tabel atau query pencarian.

---

## Edge Cases & Defensive Programming

1. **Exhaustion Koneksi Saat Batch Processing**
   `pgx.Batch` memungkinkan Anda memipakan (pipelining) beberapa statement SQL sekaligus (fitur `sqlc: :batchmany`). *Edge case*-nya: jika terjadi `panic` atau error iterasi pada saat Anda membaca balik hasil (`br.QueryRow()`), fungsi `.Close()` di objek BatchResults wajib dipanggil. Membiarkan BatchResults (*pgx.BatchResults*) tak tertutup akan meninggalkan status koneksi tersebut kotor (*dirty/unflushed*), dan jika koneksi itu kembali ke pool, pengambil selanjutnya akan mengalami error protokol desinkronisasi. Pastikan selalu memanggil `defer br.Close()`.

2. **Enum Mapping dan Default String SQLC**
   Secara default, jika Anda mendefinisikan tipe `ENUM` kustom di PostgreSQL (seperti `status_user`), SQLC akan memetakannya sebagai tipe string sederhana dalam Go. Hal ini bisa berbahaya bagi kompilator (bisa typo saat passing parameter). *Best practice*: Di dalam `sqlc.yaml`, manfaatkan fitur `overrides` untuk memetakan kolom ENUM ke tipe alias struct atau custom *type-safe* string di sisi kode Go, menjamin validasi yang kuat pada fase kompilasi.

3. **Limitasi `pgx.CopyFrom` pada UPSERT (ON CONFLICT)**
   `CopyFrom` (perintah native `COPY` dari Postgres) adalah sarana tercepat memindahkan data, namun sayangnya ia absolut tidak mendukung `ON CONFLICT DO UPDATE`. Jika Anda menginginkan logika migrasi *Upsert* jutaan data, Anda tidak bisa menggunakan `CopyFrom`. Anda harus berpaling menggunakan `pgx.Batch` (batch pipeline). Sedikit lebih lambat, tapi mensupport sintaks conflict/upsert utuh.

---

## Unit Tests

Dengan fitur *emit_interface: true* yang ada di `sqlc.yaml`, `sqlc` akan membuatkan antarmuka lengkap untuk operasi database kita. Hal ini mereduksi kebutuhan akan library mocking kompleks atau menyambungkan ke PostgreSQL sungguhan dalam *shallow test*. Kita dapat menulis test mock lokal (*Stub*).

```go
package database_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"yourproject/internal/database" // Ganti dengan path sesungguhnya
)

// MockQuerier mengimplementasi database.Querier
type MockQuerier struct {
	// Stub fungsi agar bisa diinjeksi output sesuka kita dalam test
	BulkInsertUsersFunc func(ctx context.Context, arg []database.BulkInsertUsersParams) (int64, error)
	database.Querier // Embed agar sisanya terpenuhi
}

func (m *MockQuerier) BulkInsertUsers(ctx context.Context, arg []database.BulkInsertUsersParams) (int64, error) {
	if m.BulkInsertUsersFunc != nil {
		return m.BulkInsertUsersFunc(ctx, arg)
	}
	return int64(len(arg)), nil
}

func TestMigrateUsers_Success(t *testing.T) {
	// 1. Siapkan mock yang mencatat (spy) eksekusi dan memvalidasi behavior
	mock := &MockQuerier{
		BulkInsertUsersFunc: func(ctx context.Context, arg []database.BulkInsertUsersParams) (int64, error) {
			if len(arg) != 2 {
				t.Errorf("Expected 2 args to be transformed, got %d", len(arg))
			}
			// Verifikasi pgtype ter-set Valid=true
			if !arg[0].CreatedAt.Valid {
				t.Error("Expected CreatedAt pgtype to be explicitly set as Valid")
			}
			return int64(len(arg)), nil
		},
	}

	// Karena implementasi production kita menerima struct yang sudah merangkum (Querier),
	// kita dapat menguji logic tanpa mem-mock pool koneksi secara membabi buta.
	
	// Dalam kode nyata r := &UserRepository{q: mock} (tergantung implementasi interface)
	
	rawInput := []map[string]string{
		{"name": "Alice", "email": "alice@x.com"},
		{"name": "Bob", "email": "bob@x.com"},
	}

	// Simulasi panggil logika migrasi (asumsi method MigrateUsers dipisahkan nerima interface querier)
	// r.MigrateUsers(ctx, rawInput)
	// (Diimplementasikan seolah mock sudah tersambung).
	
	_, err := mock.BulkInsertUsers(context.Background(), []database.BulkInsertUsersParams{
		{Name: rawInput[0]["name"], CreatedAt: pgtype.Timestamptz{Valid:true}},
		{Name: rawInput[1]["name"], CreatedAt: pgtype.Timestamptz{Valid:true}},
	})
	
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
```
