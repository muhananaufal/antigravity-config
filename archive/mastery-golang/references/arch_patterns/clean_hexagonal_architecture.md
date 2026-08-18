# Clean Architecture & Hexagonal (Ports and Adapters) di Go

> **Berlaku:** Go 1.21+ · **Lihat juga:** `arch_patterns/dependency_injection_wire.md` · `arch_patterns/ddd_aggregate_repository.md` · `arch_patterns/modular_monolith_go.md` · `testing_quality/mocking_interfaces.md`

## Konsep Utama dan Internal

Clean Architecture, atau Hexagonal Architecture (Ports and Adapters), dirancang untuk memisahkan logika bisnis inti (Domain) dari detail teknis (Infrastruktur, UI, Framework, Database). Di Go, konsep ini direalisasikan secara elegan menggunakan *Dependency Inversion Principle* (DIP) melalui `interface`. 

Kunci dari arsitektur ini adalah **Aturan Ketergantungan (Dependency Rule)**: *Dependency atau ketergantungan kode sumber (source code dependencies) hanya boleh mengarah ke dalam, menuju lapisan Domain.*
- Lapisan **Domain** tidak boleh mengimpor package apapun di luar *standard library* Go (dan package domain itu sendiri).
- Lapisan terluar (**Adapter/Infrastructure**) akan mengimplementasikan *Port* (`interface`) yang didefinisikan oleh lapisan dalam (**Usecase/Service** atau Domain).

Pendekatan ini sangat mempermudah *Unit Testing* karena setiap adapter teknis (seperti database atau HTTP client eksternal) dapat di-mock dengan mudah tanpa menyentuh *logic* utama.

## Diagram Arsitektur dan Aliran Dependency (ASCII)

Diagram berikut menunjukkan bagaimana dependency (panah `--->`) mengalir ke arah dalam (Domain), dan bagaimana interface digunakan sebagai Port untuk membalikkan dependency pada runtime.

```text
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ INBOUND ADAPTERS ] (Primary)                 [ OUTBOUND ADAPTERS ] (Secondary) |
|                                                                                   |
|   +---------------+                              +----------------------+         |
|   | HTTP Handlers |                              |  PostgreSQL/pgx Repo |         |
|   +---------------+                              +----------------------+         |
|           | (Memanggil Usecase)                             | (Mengimplementasikan|
|           |                                                 |  Port / Interface)  |
|           v                                                 v                     |
|  +-----------------------------------------------------------------------------+  |
|  |                                  APPLICATION LAYER                          |  |
|  |   +-----------------------+                    +-----------------------+    |  |
|  |   |    User Usecase       |                    |    User Repository    |    |  |
|  |   |    (Business Logic)   |----(Bergantung)--->|    (PORT / Interface) |    |  |
|  |   +-----------------------+                    +-----------------------+    |  |
|  |           | (Memanggil / Mengelola Entity)                                  |  |
|  |           v                                                                 |  |
|  |  +-----------------------------------------------------------------------+  |  |
|  |  |                                 DOMAIN LAYER                          |  |  |
|  |  |   +-----------------------+                                           |  |  |
|  |  |   |      User Entity      | (Hanya Go Standard Library)               |  |  |
|  |  |   |      (Structs)        |                                           |  |  |
|  |  |   +-----------------------+                                           |  |  |
|  |  +-----------------------------------------------------------------------+  |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```
*Catatan Penting: Pada level kode, Repository Implementation (PostgreSQL) mengimpor package Domain untuk mengembalikan `Entity`, tetapi Domain tidak pernah mengimpor PostgreSQL.*

## Kode Go Production-Ready

Kode di bawah ini mendemonstrasikan implementasi riil Clean Architecture di Go dengan `context` propagation, *error handling* yang presisi (menggunakan `%w`), dan dependensi yang di-inject.

```go
package hexagonal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// ==========================================
// 1. DOMAIN LAYER (Entities & Custom Errors)
// ==========================================
// Layer ini SANGAT MURNI. Tidak ada import library eksternal (kecuali stdlib).

var (
	ErrUserNotFound = errors.New("user not found")
	ErrInvalidState = errors.New("invalid user state for operation")
)

// User merepresentasikan entitas bisnis inti (Aggregate Root).
type User struct {
	ID        string
	Email     string
	IsActive  bool
	UpdatedAt time.Time
}

// Deactivate berisi business logic murni dalam entity.
//
// `sekarang` DISUNTIKKAN, tidak diambil dari time.Now() di dalam entity.
//
// Ini persoalan yang sama dengan memanggil database dari domain, hanya lebih
// mudah luput karena `time` adalah pustaka standar. Lapisan ini dinyatakan
// "SANGAT MURNI" beberapa baris di atas — tetapi entity yang membaca jam
// dinding punya ketergantungan tersembunyi pada dunia luar: hasilnya berbeda
// tiap pemanggilan, tidak bisa diuji tanpa menerima apa pun yang dikembalikan
// jam, dan uji terhadap perilaku yang bergantung waktu (kedaluwarsa, jeda,
// batas hari) menjadi mustahil ditulis secara deterministik.
//
// Jam adalah dependensi INFRASTRUKTUR. Ia masuk lewat pintu yang sama dengan
// repository — dari luar ke dalam, bukan diambil diam-diam dari dalam.
func (u *User) Deactivate(now time.Time) error {
	if !u.IsActive {
		return fmt.Errorf("%w: user is already inactive", ErrInvalidState)
	}
	u.IsActive = false
	u.UpdatedAt = now.UTC()
	return nil
}

// ==========================================
// 2. APPLICATION LAYER (Ports & Usecases)
// ==========================================

// UserRepository adalah Port (Interface) Outbound yang harus diimplementasikan oleh Adapter.
type UserRepository interface {
	GetByID(ctx context.Context, id string) (*User, error)
	Save(ctx context.Context, u *User) error
}

// Jam adalah Port keluar, sejajar dengan UserRepository.
type Clock interface{ Now() time.Time }

// JamSistem adalah Adapter-nya; di uji, gantikan dengan jam beku.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now() }

// UserUsecase mengorkestrasi alur aplikasi.
type UserUsecase struct {
	repo  UserRepository
	clock Clock
}

// NewUserUsecase adalah konstruktor untuk Dependency Injection.
func NewUserUsecase(repo UserRepository, clock Clock) *UserUsecase {
	if repo == nil {
		panic("user repository cannot be nil")
	}
	if clock == nil {
		panic("clock cannot be nil")
	}
	return &UserUsecase{repo: repo, clock: clock}
}

// DeactivateUser mengorkestrasi pengambilan data, mutasi entity, dan persistensi.
func (uc *UserUsecase) DeactivateUser(ctx context.Context, id string) error {
	// 1. Ambil state terkini (melalui Port)
	user, err := uc.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return fmt.Errorf("deactivation failed, user missing: %w", err)
		}
		return fmt.Errorf("failed to fetch user for deactivation: %w", err)
	}

	// 2. Eksekusi Business Logic di Entity — waktu diteruskan dari luar
	if err := user.Deactivate(uc.clock.Now()); err != nil {
		return fmt.Errorf("cannot deactivate user %s: %w", id, err)
	}

	// 3. Simpan state (melalui Port)
	if err := uc.repo.Save(ctx, user); err != nil {
		return fmt.Errorf("failed to persist deactivated user %s: %w", id, err)
	}

	return nil
}

// ==========================================
// 3. ADAPTER LAYER (Infrastructure)
// ==========================================
// Layer ini kotor dan boleh mengimpor library spesifik (misal: pgx, redis).

// InMemoryUserRepository adalah contoh adapter untuk repository.
// Dalam production nyata, struct ini bernama postgres.UserRepository (menggunakan pgx).
type InMemoryUserRepository struct {
	// Mutex WAJIB: tanpa ini, dua permintaan HTTP yang bersamaan memanggil
	// GetByID dan Save membuat runtime Go panic dengan "concurrent map read
	// and map write". Adapter repository adalah komponen yang paling pasti
	// diakses banyak goroutine sekaligus.
	mu   sync.RWMutex
	data map[string]*User
}

func NewInMemoryUserRepository() *InMemoryUserRepository {
	return &InMemoryUserRepository{
		data: map[string]*User{
			"u-123": {ID: "u-123", Email: "john@example.com", IsActive: true, UpdatedAt: time.Now()},
			"u-456": {ID: "u-456", Email: "jane@example.com", IsActive: false, UpdatedAt: time.Now()},
		},
	}
}

func (r *InMemoryUserRepository) GetByID(ctx context.Context, id string) (*User, error) {
	// Simulasi pengecekan context timeout/cancellation
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	u, exists := r.data[id]
	if !exists {
		// Mengembalikan error domain agar Usecase bisa menangani secara semantik
		return nil, ErrUserNotFound
	}
	// Selalu kembalikan salinan agar pointer tidak termutasi di luar repo tanpa Save().
	//
	// `*u` adalah salinan DANGKAL, dan itu cukup HANYA karena setiap field
	// User bertipe nilai (string, bool, time.Time). Begitu ada yang menambah
	// `Roles []string` atau `Metadata map[string]string`, baris ini diam-diam
	// berhenti mengisolasi: array pendukung slice/map tetap dibagi, pemanggil
	// bisa menulis ke dalamnya, dan gejalanya baru muncul jauh dari sini.
	// Menambah field referensi ke User BERARTI menambah penyalinannya di sini.
	copied := *u
	return &copied, nil
}

func (r *InMemoryUserRepository) Save(ctx context.Context, u *User) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	copied := *u
	r.data[u.ID] = &copied
	return nil
}

// ==========================================
// 4. UNIT TEST
// ==========================================

// jamBeku adalah Adapter uji untuk Port Jam. Inilah imbalan konkret dari
// menyuntikkan jam: waktu jadi nilai yang bisa DIASERSI, bukan sesuatu yang
// hanya bisa dicek "kira-kira sekitar sekarang" dengan toleransi.
type frozenClock struct{ t time.Time }

func (j frozenClock) Now() time.Time { return j.t }

func TestUserUsecase_DeactivateUser(t *testing.T) {
	ctx := context.Background()
	// Sengaja bukan UTC: membuktikan Deactivate menormalkan zona waktu.
	frozen := frozenClock{t: time.Date(2024, 3, 1, 10, 30, 0, 0, time.FixedZone("WIB", 7*3600))}

	t.Run("Success Deactivation", func(t *testing.T) {
		repo := NewInMemoryUserRepository()
		uc := NewUserUsecase(repo, frozen)

		// Eksekusi
		err := uc.DeactivateUser(ctx, "u-123")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		// Verifikasi State di Repo
		u, err := repo.GetByID(ctx, "u-123")
		if err != nil {
			t.Fatalf("GetByID after Save: %v", err)
		}
		if u.IsActive {
			t.Errorf("user should be inactive")
		}
		// Assersi eksak — mustahil ditulis kalau entity memanggil time.Now().
		if want := frozen.t.UTC(); !u.UpdatedAt.Equal(want) {
			t.Errorf("UpdatedAt = %v, want %v", u.UpdatedAt, want)
		}
	})

	t.Run("Fails When Already Inactive", func(t *testing.T) {
		repo := NewInMemoryUserRepository()
		uc := NewUserUsecase(repo, frozen)

		err := uc.DeactivateUser(ctx, "u-456")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !errors.Is(err, ErrInvalidState) {
			t.Errorf("expected ErrInvalidState, got %v", err)
		}
	})

	t.Run("Fails When User Not Found", func(t *testing.T) {
		repo := NewInMemoryUserRepository()
		uc := NewUserUsecase(repo, frozen)

		err := uc.DeactivateUser(ctx, "u-999")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		if !errors.Is(err, ErrUserNotFound) {
			t.Errorf("expected ErrUserNotFound, got %v", err)
		}
	})

	// Uji ini membuktikan klaim "deep copy" di Edge Case 2. Tanpa salinan,
	// mutasi pada objek hasil GetByID akan bocor ke penyimpanan meski Save
	// tidak pernah dipanggil — persis bug aliasing yang dibahas di bawah.
	t.Run("GetByID Mengembalikan Salinan", func(t *testing.T) {
		repo := NewInMemoryUserRepository()

		u1, err := repo.GetByID(ctx, "u-123")
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		u1.Email = "hacked@example.com"

		u2, err := repo.GetByID(ctx, "u-123")
		if err != nil {
			t.Fatalf("second GetByID: %v", err)
		}
		if u2.Email == "hacked@example.com" {
			t.Error("mutation on GetByID result leaked to storage")
		}
	})

	// Uji ini gagal dengan "concurrent map read and map write" bila mutex
	// di InMemoryUserRepository dilepas. Jalankan dengan -race.
	//
	// Perhatikan batas yang dijaga mutex: ia melindungi PETA, bukan invarian
	// bisnis. Urutan GetByID -> Deactivate -> Save di Usecase tetap
	// read-modify-write yang tidak atomik, jadi banyak goroutine bisa
	// sama-sama membaca IsActive=true dan sama-sama lolos. Untuk menutup
	// celah itu perlu optimistic locking di tingkat aggregate — lihat
	// `arch_patterns/ddd_aggregate_repository.md`.
	t.Run("Akses Serentak Aman", func(t *testing.T) {
		repo := NewInMemoryUserRepository()
		uc := NewUserUsecase(repo, frozen)

		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				// Galat diabaikan dengan sengaja: hanya satu goroutine yang
				// menang menonaktifkan, sisanya wajar mendapat ErrInvalidState.
				_ = uc.DeactivateUser(ctx, "u-123")
			}()
		}
		wg.Wait()
	})
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengimpor Database Framework (seperti GORM/SQL) di Usecase atau Domain
Usecase seharusnya tidak peduli sama sekali tentang *bagaimana* dan *dimana* data disimpan.

```go
// ❌ BAD: Usecase layer mengimpor gorm dan menggunakan tipe teknis (*gorm.DB)
package usecase

import (
	"context"
	"gorm.io/gorm"
)

type UserUsecase struct {
	db *gorm.DB 
}

func (uc *UserUsecase) Deactivate(ctx context.Context, id string) error {
    // Logika bisnis bercampur dengan detail database
	return uc.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("is_active", false).Error
}
```
**Why dangerous:** Ini menghancurkan Dependency Inversion. Jika kita melakukan migrasi dari MySQL (GORM) ke MongoDB, Redis, atau gRPC Microservice lain, **seluruh Usecase layer harus diubah**. Selain itu, *unit test* menjadi sangat sulit karena kita harus melakukan mocking koneksi DB alih-alih cukup me-mock satu interface Go murni.

### ❌ Anti-Pattern 2: Membocorkan Struct HTTP (Transport Layer) ke Usecase Layer
Seringkali struct yang secara spesifik diturunkan dari JSON payload HTTP (berisi tag `json` atau `validate`) dilempar langsung ke Usecase.

```go
// ❌ BAD: Usecase layer bergantung pada format HTTP Handler Request
package usecase

import (
	"context"
	"myapp/delivery/http/handler"
)

func (uc *UserUsecase) CreateUser(ctx context.Context, req handler.CreateUserRequest) error {
	// ... logic
	return nil
}
```
**Why dangerous:** Jika suatu saat kita ingin memanggil fungsi `CreateUser` dari background job worker (misal Kafka consumer atau CLI task), kita harus merangkai (construct) struct HTTP Request tiruan, yang secara semantik tidak masuk akal. Lapisan transport (HTTP/gRPC/CLI) harusnya mem-parsing input, lalu memetakannya ke struct internal murni di Usecase.

```go
// ✅ GOOD: Transport layer mapping ke DTO milik Usecase.
package usecase

type CreateUserInput struct {
    Email    string
    Password string
}
// func (uc *UserUsecase) CreateUser(ctx context.Context, input CreateUserInput) error { ... }
```

## Edge Cases & Defensive Programming Konkrit

1. **Context Timeout vs Driver Connection Pool Exhaustion:** 
   Saat menggunakan PostgreSQL via `pgx`, ketika *connection pool* habis dan *request* mengantri, `context.Context` dari HTTP (misal timeout 5 detik) dapat kedaluwarsa sebelum mendapat koneksi. Dalam Adapter layer, `pgx` akan mengembalikan error context canceled, tapi Usecase bisa saja mengira error ini adalah "Entity Not Found" jika adapter hanya me-return error generik.
   *Defensive:* Adapter PostgreSQL harus mengecek `errors.Is(err, pgx.ErrNoRows)` secara eksplisit dan me-mappingnya ke `domain.ErrUserNotFound`. Jika `err` adalah `context.DeadlineExceeded` atau `context.Canceled`, biarkan *bubble up* apa adanya sehingga HTTP layer bisa merespons `504 Gateway Timeout` atau `499 Client Closed Request` alih-alih `500 Internal Error`.

2. **Pointer Mutation (Aliasing Bug) Lintas Layer:**
   Jika `UserRepository.GetByID` mengembalikan pointer (`*User`) ke objek internal di dalam memori (seperti di *in-memory cache* atau objek reference GORM yang di-cache), dan Usecase mengubah `user.IsActive = false`, maka *state* tersebut berubah di seluruh aplikasi *sebelum* `Save()` dipanggil, atau parahnya tetap termutasi jika transaksi di-rollback.
   *Defensive:* Adapter **wajib** menyalin Entity sebelum mengembalikan pointernya, atau layer Domain mendefinisikan Entity sebagai *immutable struct* (di-*passing by value*) apabila ukurannya cukup ringan (beberapa field saja).
   *Yang sering terlewat:* `salinan := *u` adalah salinan **dangkal**. Ia hanya setara *deep copy* selama seluruh field bertipe nilai. Satu field `[]string`, `map[string]X`, atau pointer bersarang membuat array pendukungnya tetap dibagi — isolasinya bocor tanpa satu pun baris berubah di adapter. Karena itu penyalinan entity adalah kode yang **wajib ikut diperbarui setiap kali entity bertambah field referensi**, dan lebih aman ditulis sebagai method eksplisit (`func (u *User) Salin() *User`) di domain daripada dereference satu baris yang tampak selalu benar.

3. **Transaction / Unit of Work Across Multiple Repositories:**
   Dalam Clean Architecture, Usecase tidak boleh mengimpor objek database (seperti `sql.Tx` atau `pgx.Tx`). Bagaimana jika `OrderUsecase.Checkout()` harus memanggil `OrderRepo.Save()`, `InventoryRepo.Deduct()`, dan `WalletRepo.Charge()` dalam satu transaksi ACID? Mengoper `*sql.Tx` ke dalam argumen method Usecase adalah pelanggaran berat terhadap isolasi layer.
   *Defensive:* Terapkan pattern *Unit of Work (UoW)* dengan menyisipkan transaction via `context.Context` atau *closure*. Buat interface `TransactionManager` di Usecase layer yang memiliki signature: `RunInTransaction(ctx context.Context, fn func(ctx context.Context) error) error`. Infrastruktur mengimplementasikannya dengan membungkus `sql.Tx` ke dalam `context.WithValue`. Tiap Repository Adapter kemudian akan mencoba mengekstrak `sql.Tx` dari context, dan jika ada, menggunakannya, jika tidak, kembali menggunakan koneksi standar. Ini membiarkan Usecase tetap 100% agnostik terhadap transaksi SQL.

## Kapan JANGAN Pakai Ini

- **Untuk layanan kecil yang batasnya sudah jelas.** Empat lapisan dan tiga interface untuk CRUD dengan lima endpoint menambah berkas tanpa menambah kejelasan. Arsitektur berlapis membayar dirinya ketika ada perubahan yang benar-benar perlu diisolasi.
- **Interface untuk setiap dependensi.** Di Go, interface milik konsumen dan lahir ketika ada dua implementasi nyata atau kebutuhan uji yang tidak bisa dipenuhi cara lain. Interface satu-implementasi yang dibuat "demi arsitektur" adalah kerja tanpa hasil.
- **Memetakan struct antar lapisan yang isinya identik.** Bila DTO, entity, dan model database sama field demi field, tiga salinan itu murni biaya pemeliharaan — dan tempat bug menyelinap saat salah satunya lupa diperbarui.
- **Menerapkannya seragam ke seluruh modul.** Modul pembayaran mungkin butuh lapisan penuh; modul "daftar negara" tidak. Keseragaman di sini bukan kebajikan.
- **Sebagai alasan menunda keputusan tentang batas domain.** Arsitektur berlapis tidak memperbaiki model domain yang salah — ia menyebarkannya ke lebih banyak berkas sehingga lebih mahal diperbaiki nanti.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Perubahan sepele menyentuh 6+ berkas | jumlah lapisan yang dilewati | Lapisan tidak membayar dirinya untuk kasus ini |
| Domain mengimpor paket infrastruktur | `go list -deps` pada paket domain | Arah dependensi terbalik |
| Uji domain butuh database | apa yang di-mock di uji | Batas tidak benar-benar ada |
| Interface hanya punya satu implementasi | jumlah implementasi per interface | Abstraksi yang tidak pernah dipakai untuk apa pun |
| Logika bisnis ada di handler | ukuran fungsi handler | Lapisan ada di nama direktori, bukan di kode |

```bash
# Aturan paling penting: domain TIDAK BOLEH bergantung pada infrastruktur
go list -deps ./internal/domain/... | grep -E 'database/sql|net/http|redis|pgx|aws-sdk'

# Penegakan di CI -- tanpa ini aturan lapisan hanya kesepakatan lisan
grep -rn 'net/http\|database/sql' --include='*.go' internal/domain/ internal/service/

# golangci-lint dengan linter depguard bisa memblokir import terlarang per direktori
golangci-lint run --enable=depguard
```
