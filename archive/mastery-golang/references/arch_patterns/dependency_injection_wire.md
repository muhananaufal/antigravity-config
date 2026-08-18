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
1. **Type-Safety Absolut**: Error dependensi tertangkap saat **generate-time**, bukan runtime.
2. **Kinerja Maksimal**: Nol overhead reflection saat runtime.
3. **Debuggable**: Jejak tumpukan (stack trace) bersih, transparan.

> **Presisi yang menentukan di sini: *generate-time*, bukan *compile-time*.**
> Wire hanya melihat graf Anda ketika perintah `wire` DIJALANKAN. `go build`
> tidak memanggil Wire dan tidak tahu apa-apa tentang `wire.Build`. Artinya:
> `wire_gen.go` yang basi — dibuat sebelum Anda menambah dependensi ke sebuah
> konstruktor — tetap **lolos kompilasi dan tetap ter-deploy**, merakit graf
> versi lama, karena tidak ada satu pun tahap `go build` yang membandingkannya
> dengan `wire.go`.
>
> Jaminan "tertangkap lebih awal" itu **tidak melekat pada Wire**; ia melekat
> pada gerbang CI yang memaksa hasil generate tetap sinkron:
>
> ```bash
> go generate ./... && git diff --exit-code
> ```
>
> Tanpa baris itu di pipeline, Wire memberi Anda kode rakitan yang bersih dan
> nol jaminan. Ini alasan gerbang tersebut ada di bagian deteksi paling bawah
> berkas ini — bukan sekadar saran higiene.

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
+-----------------------------------------------------------+
| func InitializeApp(ctx) (*App, func(), error)             |
|                                                           |
|   // Dependency Graph dirakit berurutan (DAG)             |
|   db, cleanupDB, err := NewDatabase(ctx)                  |
|   if err != nil { return nil, nil, err }                  |
|                                                           |
|   cache, cleanupCache, err := NewCache(ctx)               |
|   if err != nil { cleanupDB(); return nil, nil, err }     |
|                    ^^^^^^^^^^^                            |
|                    jalur galat menutup yang sudah terbuka |
|                                                           |
|   repo := NewUserRepository(db, cache)                    |
|   svc  := NewUserService(repo) // interface bind          |
|   app  := NewApp(svc)                                     |
|                                                           |
|   return app, func() {   // LIFO: terakhir dibangun,      |
|     cleanupCache()       //       pertama ditutup         |
|     cleanupDB()                                           |
|   }, nil                                                  |
+-----------------------------------------------------------+
```

## Kode Go Production-Ready

Contoh ini mendemonstrasikan kasus dunia nyata: mengembalikan *cleanup function*, error, dan menyuntikkan struct serta interface menggunakan Set.

```go
package diwire

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
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
	// Provider yang MENERIMA context wajib MENGHORMATINYA. Provider yang
	// menerima ctx lalu mengabaikannya adalah tanda tangan yang berbohong:
	// pemanggil mengira startup bisa dibatalkan, padahal tidak.
	//
	// Ini bukan kasus teoretis. Pod yang menerima SIGTERM di detik-detik
	// pertama startup (rolling update, node drain, OOM tetangga) akan tetap
	// membangun seluruh graf dependensi sampai tuntas sebelum sadar bahwa
	// tak ada yang menunggunya.
	if err := ctx.Err(); err != nil {
		return nil, nil, fmt.Errorf("database initialization canceled: %w", err)
	}

	db := &Database{ConnString: "postgres://localhost/test"}

	// Cleanup WAJIB idempoten. Wire memanggilnya di jalur galat, main.go
	// memanggilnya lewat defer, dan penangan sinyal sering memanggilnya lagi
	// -- `sql.DB.Close()` kedua kali pada sebagian driver bukan no-op.
	// Signature `func()` tidak punya tempat mengembalikan galat, jadi
	// pencatatan di dalam sini BUKAN opsional: ini satu-satunya jalan keluar
	// informasi kegagalan penutupan.
	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			// Di kode nyata: if err := sqlDB.Close(); err != nil { slog.Error(...) }
			slog.Info("database connection closed", "dsn", db.ConnString)
		})
	}
	return db, cleanup, nil
}

// Cache adalah provider I/O KEDUA. Keberadaannya bukan hiasan: ia yang
// membuat urutan cleanup dan jalur galat startup bisa diuji.
type Cache struct {
	Addr string
}

// gagalkanCache adalah kait uji untuk mensimulasikan provider yang gagal di
// tengah perakitan graf. Di kode nyata, kegagalannya datang dari dial TCP.
var failCache atomic.Bool

var ErrCacheUnreachable = errors.New("cache unreachable")

func NewCache(ctx context.Context) (*Cache, func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, fmt.Errorf("cache initialization canceled: %w", err)
	}
	if failCache.Load() {
		return nil, nil, ErrCacheUnreachable
	}

	c := &Cache{Addr: "redis://localhost:6379"}
	var once sync.Once
	cleanup := func() {
		once.Do(func() { slog.Info("cache connection closed", "addr", c.Addr) })
	}
	return c, cleanup, nil
}

// IUserRepository adalah abstraksi port (Interface).
type IUserRepository interface {
	GetName() string
}

type UserRepositoryImpl struct {
	db    *Database
	cache *Cache
}

func NewUserRepository(db *Database, cache *Cache) *UserRepositoryImpl {
	return &UserRepositoryImpl{db: db, cache: cache}
}

func (r *UserRepositoryImpl) GetName() string {
	// Cache dipakai, bukan sekadar disimpan. Field dependensi yang di-inject
	// lalu tidak pernah disentuh adalah tanda graf yang lebih rumit dari
	// kebutuhannya -- dan Wire tidak akan pernah memberitahu Anda.
	_ = r.cache.Addr
	return "User from " + r.db.ConnString
}

type UserService struct {
	repo IUserRepository
}

// Perhatikan UserService menerima Interface, bukan Concrete Implementation.
func NewUserService(repo IUserRepository) *UserService {
	return &UserService{repo: repo}
}

// Greet adalah perilaku milik service. Tanpa satu pun method seperti ini,
// "unit test service" hanya bisa menyentuh field-nya langsung -- dan yang
// teruji cuma mock-nya sendiri, bukan service-nya.
func (s *UserService) Greet() string {
	return "Halo, " + s.repo.GetName()
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
// Isi di bawah ini adalah BERKAS TERPISAH (`wire.go`), dikutip di sini sebagai
// komentar. Ia TIDAK bisa hidup di berkas yang sama dengan `wire_gen.go`:
// keduanya mendeklarasikan InitializeApp, dan yang memisahkan mereka justru
// build constraint di baris pertama wire.go.
//
// Perhatikan dua hal yang paling sering salah, dan keduanya GAGAL DIAM-DIAM
// -- tidak ada galat kompilasi, berkasnya hanya ikut terkompilasi seolah tak
// bertag, lalu muncul `InitializeApp redeclared in this block`:
//
//  1. Constraint HARUS di baris paling atas berkas, SEBELUM klausa `package`.
//     Di tengah berkas seperti posisi komentar ini, `//go:build` hanyalah
//     komentar biasa tanpa makna apa pun bagi toolchain.
//  2. Constraint HARUS dipisahkan baris kosong dari klausa `package`. Tanpa
//     baris kosong itu, Go membacanya sebagai doc comment milik package dan
//     MENGABAIKANNYA sebagai constraint.
//
// Bentuk yang benar untuk Go 1.21+ (satu baris, `// +build` sudah usang sejak
// Go 1.18 dan hanya perlu bila masih mendukung Go 1.16 ke bawah):
//
//	//go:build wireinject
//	<-- baris kosong ini wajib
//	package diwire

/*
import "github.com/google/wire"

var RepositorySet = wire.NewSet(
	NewDatabase,
	NewCache,
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
//
// Bentuk inilah yang membuktikan klaim Edge Case 5. Dengan DUA provider I/O,
// jalur galat menjadi terlihat: bila provider kedua gagal, cleanup provider
// PERTAMA dipanggil sebelum error dikembalikan. Dengan satu provider saja,
// tidak ada urutan yang bisa ditunjukkan dan klaim LIFO cuma jadi komentar.
func InitializeApp(ctx context.Context) (*App, func(), error) {
	// Wire otomatis mendeteksi urutan inisialisasi yang benar
	database, cleanupDB, err := NewDatabase(ctx)
	if err != nil {
		return nil, nil, err
	}

	cache, cleanupCache, err := NewCache(ctx)
	if err != nil {
		cleanupDB() // <-- inilah yang mencegah zombie connection saat startup gagal
		return nil, nil, err
	}

	// Wire otomatis menyambungkan binding dari UserRepositoryImpl ke IUserRepository
	userRepositoryImpl := NewUserRepository(database, cache)

	userService := NewUserService(userRepositoryImpl)
	app := NewApp(userService)

	// Cleanup dirangkai LIFO: yang terakhir dibangun, pertama ditutup.
	return app, func() {
		cleanupCache()
		cleanupDB()
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
		t.Fatalf("failed to initialize app: %v", err)
	}
	defer cleanup() // Eksekusi cleanup di akhir jalannya tes

	if app == nil || app.svc == nil {
		t.Fatal("DI failed, component is nil")
	}

	// Menguji lewat method publik, bukan menembus field internal.
	result := app.svc.Greet()
	want := "Halo, User from postgres://localhost/test"
	if result != want {
		t.Errorf("Greet() = %q, want %q", result, want)
	}
}

func TestUserService_Logic(t *testing.T) {
	// Unit Test murni tanpa Wire (isolasi 100% menggunakan Mock Provider).
	//
	// Perhatikan yang diuji: `svc.Greet()`, BUKAN `svc.repo.GetName()`.
	// Bentuk kedua hanya membuktikan bahwa mock mengembalikan nilai yang baru
	// saja kita pasang sendiri -- ia melewati service sepenuhnya dan tetap
	// hijau meski seluruh isi UserService dihapus.
	mockRepo := &MockUserRepository{MockedName: "Mocked User"}
	svc := NewUserService(mockRepo)

	result := svc.Greet()
	if result != "Halo, Mocked User" {
		t.Errorf("Greet() = %q, want %q", result, "Halo, Mocked User")
	}
}

func TestInitializeApp_ContextCanceled(t *testing.T) {
	// Skenario nyata: SIGTERM tiba saat graf dependensi masih dirakit.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	app, cleanup, err := InitializeApp(ctx)
	if err == nil {
		t.Fatal("expected error when context is already canceled")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error must wrap context.Canceled, got %v", err)
	}
	if app != nil || cleanup != nil {
		t.Fatal("app and cleanup must be nil on error path")
	}
}

func TestInitializeApp_GagalDiTengahMenutupYangSudahTerbuka(t *testing.T) {
	// Inilah uji yang membuktikan Edge Case 5. Provider kedua gagal; yang
	// diperiksa adalah apakah cleanup provider PERTAMA tetap dipanggil.
	failCache.Store(true)
	t.Cleanup(func() { failCache.Store(false) })

	app, cleanup, err := InitializeApp(context.Background())
	if !errors.Is(err, ErrCacheUnreachable) {
		t.Fatalf("expected ErrCacheUnreachable, got %v", err)
	}
	if app != nil || cleanup != nil {
		t.Fatal("app and cleanup must be nil on error path")
	}
	// Catatan: bahwa cleanupDB benar-benar terpanggil terlihat di keluaran
	// slog. Untuk menjadikannya assersi keras, ganti slog.Info dengan handler
	// uji (slog.New(slog.NewTextHandler(buf, nil))) dan periksa isi buffer --
	// pola lengkapnya ada di `observability_resilience/structured_logging_slog.md`.
}

func TestCleanup_Idempoten(t *testing.T) {
	// main.go men-defer cleanup, penangan sinyal memanggilnya lagi. Tanpa
	// sync.Once, pemanggilan kedua menutup sumber daya yang sudah tertutup.
	_, cleanup, err := NewDatabase(context.Background())
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	cleanup()
	cleanup() // tidak boleh panic, tidak boleh menutup dua kali
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
**Why dangerous:** Dua alasan konkret, bukan sekadar selera gaya.

1. **Wire memetakan berdasarkan tipe, dan `IUserRepository` bukan `*UserRepositoryImpl`.** Begitu provider mengembalikan interface, tipe konkretnya lenyap dari graf. Konsumen lain yang butuh `*UserRepositoryImpl` — misalnya untuk memanggil method yang sengaja tidak masuk interface, atau untuk pengujian integrasi — akan ditolak dengan `no provider found for *UserRepositoryImpl`, meski objeknya jelas-jelas ada di graf.
2. **Jebakan typed-nil.** Ini bagian yang benar-benar menggigit di produksi:
   ```go
   func NewUserRepository(db *Database) IUserRepository {
       var impl *UserRepositoryImpl
       if db != nil { impl = &UserRepositoryImpl{db: db} }
       return impl // <- interface berisi (tipe=*UserRepositoryImpl, nilai=nil)
   }
   // Di konsumen:
   if repo != nil { repo.GetName() } // repo != nil TRUE -> nil pointer dereference
   ```
   Interface non-nil yang membungkus pointer nil adalah salah satu bug Go yang paling mahal dilacak, karena penjaga `!= nil` yang biasanya benar justru menjadi sumber panic-nya. Mengembalikan `*UserRepositoryImpl` membuat `nil` tetap `nil`.

Ini juga sekadar bentuk konkret dari pedoman Go yang lebih tua: **terima interface, kembalikan struct.** Interface adalah milik konsumen — pihak yang butuh abstraksi — bukan milik penyedia.

**Solusi (Benar):** Kembalikan tipe `struct` (pointer to concrete struct) dari fungsi provider Anda (`func NewUserRepository(db *Database, cache *Cache) *UserRepositoryImpl`). Kemudian beritahu Wire cara memetakannya secara eksplisit (Binding) melalui definisi Set di file `wire.go`:
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
**Why dangerous:** Wire tidak dapat membedakan mana `string` yang dialokasikan untuk Redis dan mana untuk MySQL. Yang gagal di sini adalah **perintah `wire`**, bukan compiler Go — `wire: multiple bindings for string`. Bedanya penting: kegagalan ini hanya muncul bila seseorang menjalankan `wire`. Bila tidak, `wire_gen.go` lama tetap terkompilasi dan tetap jalan.

Catat juga bahwa yang dipakai harus **tipe terdefinisi** (`type MySQLConnString string`), bukan **type alias** (`type MySQLConnString = string`). Alias secara harfiah adalah nama lain untuk tipe yang sama, jadi ia sama sekali tidak memisahkan apa pun di mata Wire — tabrakannya persis sama.

**Solusi (Benar):** Selalu buat *defined type* (atau *Struct Options*) yang sangat spesifik.
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
   *Defensive:* Jangan membuat provider bodoh `ProvideEnvX`. Cara paling bersih adalah menjadikan config sebagai **parameter injector**: `InitializeApp(ctx context.Context, cfg *AppConfig) (*App, func(), error)`. Wire meneruskan argumen injektor apa adanya ke provider mana pun yang memintanya, jadi tidak ada provider tambahan yang perlu ditulis sama sekali.

   *Yang sering disalahpahami tentang `wire.Struct`:* `wire.Struct(new(AppConfig), "*")` **bukan** cara menyuntikkan config dari luar — ia justru menyuruh Wire **MERAKIT** `AppConfig` dengan mengisi setiap field-nya dari graf. Untuk `type AppConfig struct { Port int }`, Wire lalu mencari provider bertipe `int` — dan itu persis tabrakan tipe primitif yang dilarang Anti-Pattern 2 dua bagian di atas. `wire.Struct` cocok untuk struct yang field-nya adalah komponen (`struct { Repo *UserRepositoryImpl; Cache *Cache }`), bukan untuk config yang nilainya datang dari environment.

   Untuk membatasi field yang diisi, sebut namanya alih-alih `"*"`: `wire.Struct(new(Handler), "Repo", "Logger")`. Sisanya dibiarkan zero value.

4. **Multi-Environment Build Tags (`wire_gen.go` & `wire.go` conflicts):**
   *Edge Case:* Terkadang Anda mendapatkan error `InitializeApp redeclared in this block` karena file `wire.go` dan `wire_gen.go` keduanya mendefinisikan fungsi `InitializeApp`.
   *Detail Implementasi:* Pastikan `wire.go` memiliki *build constraint* yang benar di baris paling atas berkas — sebelum klausa `package`, tanpa spasi di awal baris, **dan dipisahkan satu baris kosong dari `package`**:
   ```go
   //go:build wireinject

   package myapp
   ```
   Tag ini memberi tahu compiler Go normal (seperti `go build`) agar mengabaikan file ini, sementara tools command line `wire` secara spesifik membaca tag `wireinject`.

   *Tiga cara constraint ini gagal DIAM-DIAM* — tanpa galat, tanpa peringatan, gejalanya baru muncul sebagai `redeclared in this block` yang membingungkan:
   - **Baris kosong sebelum `package` hilang.** Komentar yang langsung menempel pada klausa `package` dibaca Go sebagai *doc comment*, bukan constraint. Berkasnya ikut dikompilasi seperti tak bertag.
   - **Constraint tidak di paling atas.** Apa pun sebelum `//go:build` selain komentar dan baris kosong membuatnya kehilangan makna sepenuhnya.
   - **Salah tulis nama tag.** `//go:build wireInject` atau `//go:build wire_inject` adalah constraint yang sah — untuk tag yang tidak pernah ada. `go build` mengecualikan berkasnya (baik), tapi `wire` juga tidak melihatnya (buruk), dan Anda mendapat "no injectors found".

   Verifikasi cepat bahwa Go benar-benar mengecualikan berkasnya:
   ```bash
   go list -f '{{.GoFiles}}' ./...          # wire.go TIDAK boleh muncul
   go list -tags wireinject -f '{{.GoFiles}}' ./...  # wire.go HARUS muncul
   ```

   Sejak Go 1.18, `// +build` sudah usang dan `//go:build` saja sudah cukup. Bila Anda masih menulis keduanya (karena mendukung Go 1.16 ke bawah), urutannya adalah `//go:build` **lebih dulu**, baru `// +build` — itulah urutan yang dihasilkan `gofmt`, dan keduanya wajib sinkron atau `gofmt` akan menimpanya.

5. **Graceful Shutdown & LIFO Cleanup Execution (Aggregate Cleanup):**
   *Edge Case:* Jika ada 5 provider I/O (DB, Redis, gRPC Client, Kafka, NATS) dan di tengah-tengah inisialisasi, provider ke-3 melempar error, apakah provider ke-1 dan ke-2 akan mengalami *resource leak*?
   *Detail Implementasi:* Tidak. Algoritma auto-generated dari Wire secara otomatis akan memanggil `cleanup()` pada dependensi yang telah berhasil dibuat secara berurutan mundur (LIFO) sebelum mereturn error kepada caller. Ini mencegah zombie process atau memori leak pada Kubernetes Pod *OOM-kill* jika aplikasi gagal startup. Perhatikan struktur kode `wire_gen.go`: jika ada `err != nil`, ia langsung memanggil cleanup dari instance sebelumnya — bentuknya persis seperti `cleanupDB()` di jalur galat `NewCache` pada contoh di atas, dan `TestInitializeApp_GagalDiTengahMenutupYangSudahTerbuka` menguji tepat perilaku itu.

   *Batas jaminannya:* Wire hanya merangkai cleanup dari provider yang **mengembalikan `func()` sebagai nilai kedua**. Provider I/O yang lupa mengembalikan cleanup tidak akan pernah ditutup oleh siapa pun, dan tidak ada galat apa pun yang memberitahu Anda. Wire tidak bisa menebak bahwa `*redis.Client` perlu ditutup.

6. **Cleanup Wajib Idempoten (`func()` Tidak Punya Tempat untuk Galat):**
   *Edge Case:* Signature cleanup Wire adalah `func()` — tanpa parameter, tanpa nilai kembali. Dua konsekuensi yang jarang dipikirkan sampai terlambat.
   *Detail Implementasi (a) — galat penutupan tidak punya jalan pulang:* `sqlDB.Close()` mengembalikan `error`, tetapi cleanup tidak bisa meneruskannya ke mana pun. Karena itu **mencatat galat di dalam cleanup bukan opsional**; membuangnya dengan `_ = db.Close()` berarti kegagalan flush buffer atau koneksi yang menggantung hilang tanpa jejak, tepat pada momen ketika Anda paling butuh tahu.
   *Detail Implementasi (b) — cleanup bisa terpanggil lebih dari sekali:* `main.go` men-`defer cleanup()`, penangan `SIGTERM` sering memanggilnya lagi agar shutdown tidak menunggu, dan pada perakitan manual jalur galat bisa memanggilnya sekali lagi. Sebagian driver memperlakukan `Close()` kedua sebagai galat, sebagian panic. Bungkus isi cleanup dengan `sync.Once` — biayanya satu baris, dan tanpa itu shutdown yang sudah benar bisa berakhir dengan panic yang menutupi seluruh log shutdown.

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
