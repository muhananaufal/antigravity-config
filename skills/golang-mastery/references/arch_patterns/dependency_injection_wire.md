# Dependency Injection dengan Google Wire

> **Berlaku:** Go 1.21+ · `google/wire` · **Lihat juga:** `arch_patterns/clean_hexagonal_architecture.md` · `arch_patterns/config_management.md` · `testing_quality/mocking_interfaces.md` · `cli_tooling/cobra_command_architecture.md`

## Konsep Utama dan Internal Mendalam

Dependency Injection (DI) adalah teknik fundamental dalam rekayasa perangkat lunak yang memisahkan pembentukan (instansiasi) dependensi dari penggunaannya. Di Go, hal ini secara konvensional dicapai melalui constructor manual (misal `NewService(repo)`). Namun, saat skala aplikasi membengkak ratusan file, merangkai komponen secara manual menjadi neraka pemeliharaan.

### Algorithm Internals & Code-Generation Details
Google Wire beroperasi murni pada fase **Compile-Time Code Generation** menggunakan package `go/ast` dan `golang.org/x/tools/go/packages`.
1. **AST Parsing (Abstract Syntax Tree)**: Saat perintah `wire` dijalankan, ia tidak menjalankan kode Go Anda. Ia melakukan parsing statis terhadap fungsi-fungsi provider yang diregistrasikan dalam `wire.Build()`. Wire mengekstrak *signature* fungsi (parameter input dan nilai return).
2. **Topological Sorting Algorithm**: Wire merepresentasikan semua dependency sebagai *Directed Acyclic Graph (DAG)*. Setiap provider adalah sebuah *Node*, dan setiap parameter yang dibutuhkan adalah sebuah *Edge*. Ia menjalankan algoritma *Topological Sort* (Kahn's algorithm) untuk menentukan urutan resolusi instansiasi. Jika terdeteksi *cycle* (A -> B -> A), ia akan melempar error statis `cycle detected` dan membatalkan code-gen.
3. **API Internals (`wire.NewSet` & `wire.Bind`)**:
   - `wire.NewSet`: API ini membungkus sekelompok provider menjadi satu kesatuan logis (misalnya `RepositorySet`). Wire akan *flatten* (meratakan) semua set secara rekursif saat memproses DAG.
   - `wire.Bind(new(Interface), new(*Struct))`: API ini tidak melakukan alokasi memori runtime. `new(Interface)` di-compile-out (dihilangkan) saat runtime. Ini semata-mata petunjuk AST (*AST hint*) agar Wire tahu bahwa `*Struct` memenuhi `Interface` tersebut, sehingga kapanpun parameter meminta `Interface`, gunakan output dari provider `*Struct`.

**Google Wire** memecahkan masalah ini dengan pendekatan **Compile-Time Code Generation**. Berbeda dengan framework DI *Runtime* seperti Uber FX (yang menggunakan reflection Go secara berat, rentan error saat aplikasi berjalan, dan overhead lambat), Wire melakukan analisis *Abstract Syntax Tree (AST)* sebelum build. Wire men-generate file Go biasa (`wire_gen.go`) yang persis sama dengan kode manual bersih yang ditulis oleh manusia.
Hasilnya:
1. **Type-Safety Absolut**: Error dependensi tertangkap saat kompilasi.
2. **Kinerja Maksimal**: Nol overhead reflection saat runtime.
3. **Debuggable**: Jejak tumpukan (stack trace) bersih, transparan.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

```text
  [ Developer menulis provider & injector ]
       (wire.go + component files)
                 |
                 v
   +---------------------------------------+
   |   $ wire ./... (CLI)                  |
   | 1. Parse AST dengan golang.org/x/tools|
   | 2. Bangun Directed Acyclic Graph (DAG)|
   | 3. Topological Sort untuk resolve urutan|
   | 4. Deteksi Circular Dependency        |
   +---------------------------------------+
                 |
                 | (Menghasilkan file tanpa overhead reflection)
                 v
  [ wire_gen.go (Auto-generated) ]  <---- (Digunakan oleh main.go saat runtime)
                 |
                 v
+-------------------------------------------------+
| func InitializeApp(ctx context.Context) (*App, error) |
|                                                 |
|   // Dependency Graph dirakit berurutan (DAG)   |
|   db, cleanup1, err := NewDatabase(ctx)         |
|   if err != nil { return nil, err }             |
|                                                 |
|   repo := NewUserRepository(db)                 |
|   svc := NewUserService(repo) // interface bind |
|                                                 |
|   app := NewApp(svc)                            |
|   return app, func() { cleanup1() }, nil        |
+-------------------------------------------------+
```

## Kode Go Production-Ready

Contoh ini mendemonstrasikan kasus dunia nyata: mengembalikan *cleanup function*, error, dan menyuntikkan struct serta interface menggunakan Set.

```go
package diwire

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// ==========================================
// 1. KOMPONEN DAN PROVIDER
// ==========================================

// Database men-simulasikan koneksi eksternal yang memerlukan penutupan (cleanup).
type Database struct {
	ConnString string
}

func NewDatabase(ctx context.Context) (*Database, func(), error) {
	if ctx == nil {
		return nil, nil, errors.New("context is nil")
	}
	db := &Database{ConnString: "postgres://localhost/test"}
	
	// Cleanup function yang akan di-aggregate oleh Wire
	cleanup := func() {
		fmt.Println("Closing database connection...")
	}
	return db, cleanup, nil
}

// IUserRepository adalah abstraksi port (Interface).
type IUserRepository interface {
	GetName() string
}

type UserRepositoryImpl struct {
	db *Database
}

func NewUserRepository(db *Database) *UserRepositoryImpl {
	return &UserRepositoryImpl{db: db}
}

func (r *UserRepositoryImpl) GetName() string {
	return "User from " + r.db.ConnString
}

type UserService struct {
	repo IUserRepository
}

// Perhatikan UserService menerima Interface, bukan Concrete Implementation.
func NewUserService(repo IUserRepository) *UserService {
	return &UserService{repo: repo}
}

type App struct {
	svc *UserService
}

func NewApp(svc *UserService) *App {
	return &App{svc: svc}
}

// ==========================================
// 1.5. WIRE.GO (INJECTOR PATTERN: wire.NewSet)
// ==========================================
// File ini digunakan sebagai blueprint AST oleh Google Wire.
// File ini diberi build tag `//go:build wireinject` agar tidak dikompilasi saat production.

// +build wireinject
//go:build wireinject

/*
import "github.com/google/wire"

var RepositorySet = wire.NewSet(
	NewDatabase,
	NewUserRepository,
	wire.Bind(new(IUserRepository), new(*UserRepositoryImpl)),
)

var ServiceSet = wire.NewSet(
	NewUserService,
)

// InitializeApp adalah template injector. Tubuhnya akan di-replace oleh wire.
func InitializeApp(ctx context.Context) (*App, func(), error) {
	wire.Build(
		RepositorySet,
		ServiceSet,
		NewApp,
	)
	return &App{}, nil, nil
}
*/

// ==========================================
// 2. HASIL KODE YANG DIGENERATE OLEH WIRE (wire_gen.go)
// ==========================================
// Di aplikasi nyata, fungsi ini berada di file `wire_gen.go`
// yang dihasilkan dari perintah `wire` di terminal.

// InitializeApp murni di-generate oleh Wire.
func InitializeApp(ctx context.Context) (*App, func(), error) {
	// Wire otomatis mendeteksi urutan inisialisasi yang benar
	database, cleanup, err := NewDatabase(ctx)
	if err != nil {
		return nil, nil, err
	}
	
	// Wire otomatis menyambungkan binding dari UserRepositoryImpl ke IUserRepository
	userRepositoryImpl := NewUserRepository(database)
	
	userService := NewUserService(userRepositoryImpl)
	app := NewApp(userService)
	
	return app, func() {
		cleanup() // Wire merangkai pemanggilan cleanup LIFO (Last-In-First-Out)
	}, nil
}

// ==========================================
// 3. UNIT TEST (MOCK & REAL IMPLEMENTATION)
// ==========================================

// MockUserRepository mengimplementasikan IUserRepository untuk testing.
type MockUserRepository struct {
	MockedName string
}

func (m *MockUserRepository) GetName() string {
	return m.MockedName
}

func TestDIApp_WireGenerated_Integration(t *testing.T) {
	ctx := context.Background()
	
	// Kita memanggil Injector yang di-generate oleh wire (Integration)
	app, cleanup, err := InitializeApp(ctx)
	if err != nil {
		t.Fatalf("Failed to initialize app: %v", err)
	}
	defer cleanup() // Eksekusi cleanup di akhir jalannya tes

	if app == nil || app.svc == nil {
		t.Fatal("DI failed, components are nil")
	}

	result := app.svc.repo.GetName()
	expected := "User from postgres://localhost/test"
	if result != expected {
		t.Errorf("Expected '%s', got '%s'", expected, result)
	}
}

func TestUserService_Logic(t *testing.T) {
	// Unit Test murni tanpa Wire (isolasi 100% menggunakan Mock Provider)
	mockRepo := &MockUserRepository{MockedName: "Mocked User"}
	svc := NewUserService(mockRepo)
	
	result := svc.repo.GetName()
	if result != "Mocked User" {
		t.Errorf("Expected 'Mocked User', got '%s'", result)
	}
}

func TestDatabase_InitializationError(t *testing.T) {
	// Test Edge Case: error handling jika ctx nil (3+ Edge Case Implementation Test)
	db, cleanup, err := NewDatabase(nil)
	if err == nil {
		t.Fatal("Expected error when ctx is nil")
	}
	if db != nil || cleanup != nil {
		t.Fatal("Expected nil db and cleanup on error")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengembalikan Interface Langsung dari Provider
Terkadang developer menulis fungsi constructor yang me-return Interface langsung untuk disuntikkan.

```go
// ❌ BAD: Provider me-return interface
func NewUserRepository(db *Database) IUserRepository {
    return &UserRepositoryImpl{db: db}
}
```
**Why dangerous:** Ini merusak kapabilitas Wire untuk melakukan injeksi ke banyak tempat yang membutuhkan implementasi konkrit (struct) dan merusak inspeksi tipe saat kompilasi statis. 
**Solusi (Benar):** Kembalikan tipe `struct` (pointer to concrete struct) dari fungsi provider Anda (`func NewUserRepository(db *Database) *UserRepositoryImpl`). Kemudian beritahu Wire cara memetakannya secara eksplisit (Binding) melalui definisi Set di file `wire.go`:
`wire.Bind(new(IUserRepository), new(*UserRepositoryImpl))`

### ❌ Anti-Pattern 2: Tipe Dependensi yang Ambigu (Type Collision)
Wire memetakan dependensi berdasarkan **Tipe (Type) Go**, BUKAN berdasarkan nama parameter.

```go
// ❌ BAD: Menggunakan tipe primitif yang sama untuk keperluan berbeda
func NewMySQLConfig() string { return "mysql://..." }
func NewRedisConfig() string { return "redis://..." }

// Saat Service meminta string, Wire akan bingung / error "Multiple providers for string"
func NewService(dbUrl string, redisUrl string) *Service 
```
**Why dangerous:** Wire tidak dapat membedakan mana `string` yang dialokasikan untuk Redis dan mana untuk MySQL. Compiler akan gagal (error duplicate provider).
**Solusi (Benar):** Selalu buat custom type (*Type Alias* atau *Struct Options*) yang sangat spesifik.
```go
type MySQLConnString string
type RedisConnString string

func NewService(db MySQLConnString, redis RedisConnString) *Service
```

### ❌ Anti-Pattern 3: Circular Dependency Bypass attempt (Setter Injection Bypass)
Terkadang, saat membangun arsitektur monolith besar, Service A membutuhkan Service B, dan Service B membutuhkan Service A (Circular Dependency). Pengembang sering mencoba menyiasatinya dengan pass setter struct / inisialisasi tertunda (*late initialization*).

```go
// ❌ BAD: Mencoba bypass circular dependency dengan method setter (Setter Injection)
type ServiceA struct { b *ServiceB }
func NewServiceA() *ServiceA { return &ServiceA{} }
func (a *ServiceA) SetB(b *ServiceB) { a.b = b } // Bahaya: Race condition atau nil pointer panic saat run-time!

type ServiceB struct { a *ServiceA }
func NewServiceB(a *ServiceA) *ServiceB { return &ServiceB{a: a} }
```
**Why dangerous:** Wire mendeteksi siklus dependensi pada constructor (Constructor Injection), namun Setter Injection menutupi cacat desain ini. Akibatnya, dependensi direkayasa pada waktu run-time dan membuka celah `nil pointer dereference` jika fungsi `SetB` dipanggil terlambat atau tidak berurutan, dan memunculkan *race condition* bila aplikasi berjalan *concurrently*. Wire sendiri sangat tegas menolak *Constructor Injection* yang circular dan akan mengeluarkan error statis: `wire: cycle for ...`.
**Solusi (Benar):** Jangan sembunyikan siklus dependensi. Jika terdeteksi oleh Wire, perbaiki struktur arsitektur (Refactoring). Ekstrak lapisan mediator/event bus, atau gabungkan fitur tersebut jika mereka kohesif secara fungsional (Cohesion).

```go
// ✅ GOOD: Ekstrak dependensi melingkar ke dependensi shared baru (atau Event Bus)
type SharedComponent struct {} // Logic A & B yang beririsan di-ekstrak ke bawahnya
func NewSharedComponent() *SharedComponent { return &SharedComponent{} }

type ServiceA struct { shared *SharedComponent }
func NewServiceA(s *SharedComponent) *ServiceA { return &ServiceA{shared: s} }

type ServiceB struct { shared *SharedComponent }
func NewServiceB(s *SharedComponent) *ServiceB { return &ServiceB{shared: s} }
```

## Edge Cases & Defensive Programming Konkrit

1. **Memory Leak akibat Cleanup Function Hilang (Zombie Connections):**
   Komponen seperti `sql.DB` atau `redis.Client` memerlukan penutupan port TCP saat mematikan aplikasi.
   *Defensive:* Dalam arsitektur Wire, pastikan setiap provider I/O me-return nilai kedua bertipe `func()` (fungsi cleanup). Wire akan merangkai (*aggregate*) seluruh fungsi `func()` dari semua dependensi ke dalam sebuah closure tunggal dalam mode LIFO (*Last In, First Out*). Saat `InitializeApp` dipanggil oleh `main.go`, jalankan `defer cleanup()`.

2. **Siklus Dependensi (Circular Dependencies):**
   Jika Service A meminta Service B di argumen konstruktornya, dan Service B meminta Service A, aplikasi Go standar tidak akan menyadarinya hingga terjadi inisialisasi tak terhingga (Stack Overflow) atau kegagalan kompilasi impor.
   *Defensive:* Wire bertindak sebagai perisai statis. Ia menolak meng-generate `wire_gen.go` dan melempar *cycle error*. Jika Anda menabrak masalah ini, artinya desain domain Anda cacat (Tight Coupling). Gunakan pola *Event Bus / PubSub* atau esktrak lapisan *Mediator Interface* untuk memecah siklus dependensi tersebut. Jangan biarkan objek bertaut erat.

3. **Injeksi Konstanta atau Konfigurasi Dinamis (Struct Providers):**
   Seringkali sebuah struct membutuhkan konfigurasi nilai yang tidak berasal dari provider lain, melainkan parameter luar seperti environment variables (`env`).
   *Defensive:* Jangan membuat provider bodoh `ProvideEnvX`. Gunakan utilitas injeksi `wire.Struct`. Anda bisa me-return struct raksasa seperti `type AppConfig struct { Port int }` lalu menembakkannya ke layer yang membutuhkan, atau inject value langsung di parameter injector `InitializeApp(config *AppConfig) (*App, error)`. Wire membolehkan nilai argumen injektor di-pass murni menembus ke provider di dalamnya. Contoh pattern: `wire.Struct(new(Config), "*")`.

4. **Multi-Environment Build Tags (`wire_gen.go` & `wire.go` conflicts):**
   *Edge Case:* Terkadang Anda mendapatkan error `InitializeApp redeclared in this block` karena file `wire.go` dan `wire_gen.go` keduanya mendefinisikan fungsi `InitializeApp`.
   *Detail Implementasi:* Pastikan file konfigurasi Wire Anda (`wire.go`) memiliki baris tag *build constraint* yang benar di baris paling atas (tanpa spasi dengan awal baris):
   ```go
   //go:build wireinject
   // +build wireinject
   ```
   Tag ini memberi tahu compiler Go normal (seperti `go build`) agar mengabaikan file ini, sementara tools command line `wire` secara spesifik membaca tag `wireinject`.

5. **Graceful Shutdown & LIFO Cleanup Execution (Aggregate Cleanup):**
   *Edge Case:* Jika ada 5 provider I/O (DB, Redis, gRPC Client, Kafka, NATS) dan di tengah-tengah inisialisasi, provider ke-3 melempar error, apakah provider ke-1 dan ke-2 akan mengalami *resource leak*?
   *Detail Implementasi:* Tidak. Algoritma auto-generated dari Wire secara otomatis akan memanggil `cleanup()` pada dependensi yang telah berhasil dibuat secara berurutan mundur (LIFO) sebelum mereturn error kepada caller. Ini mencegah zombie process atau memori leak pada Kubernetes Pod *OOM-kill* jika aplikasi gagal startup. Perhatikan struktur kode `wire_gen.go`: jika ada `err != nil`, ia langsung memanggil defer/cleanup dari instance sebelumnya.

## Kapan JANGAN Pakai Ini

- **Wire untuk graf dependensi yang kecil.** Konstruktor manual di `main.go` lebih mudah dibaca, tidak butuh langkah generate, dan tidak menambah alat yang harus dipelajari orang baru. Wire mulai berguna ketika grafnya cukup dalam sehingga urutan inisialisasi sulit dilacak dengan mata.
- **DI berbasis refleksi (container runtime).** Ia memindahkan kegagalan dari waktu kompilasi ke waktu jalan — persis kebalikan dari alasan memilih Go. Dependensi yang hilang seharusnya gagal saat build, bukan pada permintaan pertama di produksi.
- **Menyuntikkan segalanya.** `time.Now` dan `rand` layak disuntikkan bila memang perlu diuji. Menyuntikkan hal yang tidak pernah diganti hanya memperpanjang daftar parameter.
- **Singleton global sebagai jalan pintas.** Ia menyembunyikan urutan inisialisasi dan membuat uji saling mempengaruhi lewat state yang tidak terlihat di tanda tangan fungsi mana pun.
- **Wire untuk dependensi yang dibangun per permintaan.** Wire menyusun graf sekali saat start; apa pun yang bersifat per-permintaan bukan urusannya dan akan memaksa desain yang aneh.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Aplikasi gagal start setelah deploy | urutan inisialisasi | Dependensi dibangun sebelum yang dibutuhkannya siap |
| `wire_gen.go` tidak sesuai provider | `go generate` + `git diff` di CI | Kode hasil generate basi |
| Waktu start lama | apa yang dilakukan konstruktor | Koneksi jaringan dibangun sinkron saat start |
| Uji saling mempengaruhi | variabel global paket | Singleton menyimpan state antar uji |
| Sulit mengganti implementasi untuk uji | tanda tangan konstruktor | Dependensi dibuat di dalam, bukan disuntikkan |

```bash
wire ./... && go build ./...

# Gerbang CI: hasil generate WAJIB sinkron
go generate ./... && git diff --exit-code

# Singleton global yang menyimpan sumber daya -- kandidat masalah urutan init
grep -rnE '^var [A-Z][A-Za-z]* +\*?[A-Za-z.]+ *=' --include='*.go' internal/ \
  | grep -iE 'client|pool|conn|logger|cache'

# Waktu dari start sampai siap menerima trafik
kubectl logs <pod> | grep -iE 'listening|siap|ready' | head -3
```
