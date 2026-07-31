# Multi-Tenancy Data Isolation

## 1. Konsep & Internal

Dalam arsitektur *Software as a Service (SaaS)*, aplikasi sering digunakan oleh banyak pelanggan (*Tenants*), seperti perusahaan A, perusahaan B, dst. Namun, menjalankan *server* dan *database* yang benar-benar terpisah untuk tiap pelanggan (*Silo Model*) tidak efisien dari sisi biaya (*infrastructure cost*) maupun upaya *deployment*.

**Multi-Tenancy** memungkinkan Anda menggunakan kode aplikasi dan basis data yang **sama (Shared)** untuk melayani semua pelanggan, namun menjamin bahwa Perusahaan A tidak akan pernah bisa melihat atau membocorkan data Perusahaan B (**Isolasi Data**).

Terdapat 3 pendekatan utama di *Database*:
1. **Shared Database, Shared Schema**: Satu tabel (misal `users`) dipakai bersama, dibedakan dengan kolom `tenant_id`. (Paling murah, namun paling rentan bocor).
2. **Shared Database, Isolated Schema**: Tiap pelanggan punya Skema/Namespace sendiri (misal `tenant_a.users`, `tenant_b.users`) di DB yang sama.
3. **Isolated Database**: Pelanggan beda mesin DB. (Untuk klien enterprise ketat keamanan).

Dokumen ini fokus ke pendekatan yang paling umum dan tersulit: **Shared Database, Shared Schema**.

### Diagram Alir Context Propagation (ASCII)

```ascii
[ User (Perusahaan B) ]
        |
    (HTTP GET /users) -- JWT Token (Sub: User123, Tenant: CorpB)
        v
[ API Gateway / Middleware ]
        | 
        | 1. Ekstrak Tenant ID dari JWT/Subdomain
        | 2. Injeksi `tenant_id` ke dalam `context.Context`
        v
[ Domain Logic (Go Handler) ] --> ctx.Value("tenant_id") = "CorpB"
        |
        | 3. Query dieksekusi dengan Context
        v
[ Data Access Layer (GORM / sqlc) ]
        |
        | 4. Middleware DB menyisipkan `WHERE tenant_id = 'CorpB'` secara OTOMATIS!
        v
[ PostgreSQL (Shared DB) ]
```

## 2. Production-Ready Code

Dalam Golang, menyebar *Tenant ID* dilakukan melalui `context.Context`. Kita tidak boleh mengandalkan ketaatan *programmer* untuk mengetik `WHERE tenant_id = ?` di setiap fungsi karena sifatnya rawan lupa. Terapkan di tingkat Global/Middleware (menggunakan GORM *Scopes* atau *Row-Level Security* di Postgres).

Berikut implementasi murni Go untuk propagasi *Context* dan GORM.

```go
package multitenancy

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// 1. Tipe kustom untuk Key context agar menghindari Collision antar paket
type contextKey string
const tenantKey contextKey = "tenant_id"

var ErrTenantNotFound = errors.New("tenant_id missing from request or context")

// 2. HTTP Middleware (Mengekstrak TenantID dari request)
func TenantMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Biasanya diambil dari JWT Claims (r.Header.Get("Authorization"))
		// atau Subdomain (corp-a.saas.com). Di sini kita ambil dari header sederhana.
		tenantID := r.Header.Get("X-Tenant-ID")
		
		if tenantID == "" {
			http.Error(w, "Unauthorized: Tenant ID required", http.StatusUnauthorized)
			return
		}

		// Inject ke context
		ctx := context.WithValue(r.Context(), tenantKey, tenantID)
		
		// Lanjutkan eksekusi ke handler dengan context yang diperkaya
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// 3. Helper untuk Mengekstrak TenantID dari Context (Aman)
func GetTenantID(ctx context.Context) (string, error) {
	val := ctx.Value(tenantKey)
	if val == nil {
		return "", ErrTenantNotFound
	}
	
	tenantID, ok := val.(string)
	if !ok || tenantID == "" {
		return "", ErrTenantNotFound
	}
	
	return tenantID, nil
}

// 4. Model Standar dengan TenantID
type User struct {
	ID       uint   `gorm:"primaryKey"`
	TenantID string `gorm:"index;not null"` // Wajib Index!
	Name     string
	Email    string
}

// 5. GORM Scope untuk Isolasi Otomatis
// Ini sangat krusial. Setiap kali Anda query DB, Anda HARUS melewatkan Scope ini.
func TenantScope(ctx context.Context) func(db *gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		tenantID, err := GetTenantID(ctx)
		if err != nil {
			// Fail-safe: Jika context hilang, paksakan error agar query tidak bocor ke semua tenant!
			db.AddError(fmt.Errorf("fatal security error: %w", err))
			return db.Where("1 = 0") // Mencegah akses ke DB sama sekali
		}
		
		return db.Where("tenant_id = ?", tenantID)
	}
}

// --- PENGGUNAAN DI LAYER REPOSITORY ---

type UserRepository struct {
	db *gorm.DB
}

// FindUsers menjamin HANYA mengembalikan user dari Tenant yang sedang aktif
func (r *UserRepository) FindUsers(ctx context.Context) ([]User, error) {
	var users []User
	
	// Cukup tambahkan `Scopes(TenantScope(ctx))` dan Go akan mengurus sisanya.
	// DB yang dihasilkan: SELECT * FROM users WHERE tenant_id = 'CorpA';
	err := r.db.WithContext(ctx).Scopes(TenantScope(ctx)).Find(&users).Error
	if err != nil {
		return nil, err
	}
	return users, nil
}

func (r *UserRepository) CreateUser(ctx context.Context, u *User) error {
	tenantID, err := GetTenantID(ctx)
	if err != nil {
		return err
	}
	
	// Paksakan TenantID yang ada di context.
	// Mengabaikan / override field u.TenantID dari Payload Klien (cegah spoofing).
	u.TenantID = tenantID
	
	return r.db.WithContext(ctx).Create(u).Error
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Tenant ID di Global Variabel atau Struct Handler
**Masalah**: Klien mengirimkan Tenant ID, lalu *Service* menyimpannya di *struct state* aplikasi.
```go
// BAD: State leaking antar Request
type UserService struct {
    CurrentTenant string
}

func (s *UserService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    s.CurrentTenant = r.Header.Get("X-Tenant-ID") // FATAL
    db.Where("tenant_id = ?", s.CurrentTenant).Find(...)
}
```
**Why dangerous:** Dalam *Go*, HTTP Server berjalan *concurrent* menggunakan Goroutine. Jika Perusahaan A dan Perusahaan B mengakses API bersamaan, *Request* dari Perusahaan B mungkin menimpa `s.CurrentTenant` menjadi "Corp-B", dan *query* Perusahaan A (yang sedang berjalan di milidetik yang sama) tiba-tiba membaca data milik Perusahaan B. **Ini insiden pembocoran data fatal**.
**Solusi:** Tenant ID HANYA BOLEH mengalir melalui `context.Context` (di dalam argumen *request* individu), tidak pernah di properti *Struct* global (*Stateless*).

### ❌ Anti-Pattern 2: Lupa Menambahkan Klausa "Tenant" dalam Sub-Query
**Masalah**: Anda sudah melakukan pengecekan `WHERE tenant_id`, tetapi saat melakukan JOIN (seperti `Preload` GORM) ke tabel lain, tabel tersebut di-baca penuh tanpa filternya.
```go
// BAD: Preload (JOIN) mungkin mengabaikan klausa tenant di tabel relasinya
db.Where("tenant_id = ?", tid).Preload("Orders").Find(&users)
```
**Why dangerous:** Anda mungkin mendapatkan User dari Corp-A dengan benar, tetapi tabel `Orders` bisa saja me-mebocorkan pesanan yang memiliki `user_id` yang sama dari *tenant* lain (jika ID tidak pakai UUID / global unik).
**Solusi:** Pastikan Middleware GORM Anda mendaftarkan klausa/Scope di Callback Global untuk **semua** operasi (Select, Update, Delete) sehingga menempel mutlak (Row Level Security). Opsi terkuat adalah mengonfigurasi *Row-Level Security* (RLS) di level mesin PostgreSQL.

## 4. Edge Cases Spesifik

1. **Membedakan Sistem Background Job**:
   Saat *cron job* berjalan (misal: mengirim rekap email bulanan untuk *semua* tenant), *request* ini tidak datang dari HTTP dan tidak punya spesifik JWT/Tenant di `context.Context`.
   *Penanganan*: Buat *Context* khusus admin (`context.WithValue(ctx, RoleKey, "SYSTEM_ADMIN")`) dan beri bypass pada *TenantScope* (`if role == "SYSTEM_ADMIN" { return db }`). Atau *loop* di tingkat atas: `for _, t := range tenants { ctx = context.WithValue(ctx, tenantKey, t); sendEmail(ctx) }`.

2. **Data Global (Shared Table)**:
   Aplikasi Anda memiliki tabel `currencies` atau `countries` yang tidak dimiliki oleh *tenant* (nilainya sama untuk semua). 
   *Penanganan*: *TenantScope* otomatis dapat merusak ini jika diterapkan global. Desain *struct* harus mengimplementasikan *interface* `type TenantAware interface { IsTenantAware() }` agar GORM callback tahu kapan menyuntik klausa dan kapan tidak.

3. **Noisy Neighbor Problem**:
   Karena *Database* digunakan bersama (Shared), jika satu Tenant (Perusahaan Raksasa) mengunggah jutaan data dalam satu waktu, CPU database akan tersita dan membuat aplikasi melambat drastis bagi *tenant* lain yang lebih kecil (UMKM).
   *Penanganan*: *Rate Limiting* harus diterapkan tidak hanya per-IP, melainkan juga per-*Tenant*. Serta atur QoS (*Quality of Service*) agar *tenant* dengan bayaran murah mendapatkan pembatasan *max connections* atau latensi.

## 5. Unit Tests (Behavioral Testing)

```go
package multitenancy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTenantMiddleware_Valid(t *testing.T) {
	handler := TenantMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Validasi context di dalam request
		tenantID, err := GetTenantID(r.Context())
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		if tenantID != "CorpABC" {
			t.Fatalf("Expected CorpABC, got %s", tenantID)
		}
		w.WriteHeader(200)
	}))

	req := httptest.NewRequest("GET", "/users", nil)
	req.Header.Set("X-Tenant-ID", "CorpABC")
	w := httptest.NewRecorder()
	
	handler.ServeHTTP(w, req)
	
	if w.Code != 200 {
		t.Fatalf("Expected status 200, got %v", w.Code)
	}
}

func TestTenantMiddleware_MissingID(t *testing.T) {
	handler := TenantMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("Handler should not be reached when unauthorized")
	}))

	req := httptest.NewRequest("GET", "/users", nil)
	// Tidak ada header X-Tenant-ID
	
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	
	if w.Code != 401 {
		t.Fatalf("Expected status 401 Unauthorized, got %v", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Tenant ID required") {
		t.Fatalf("Expected error message, got %s", w.Body.String())
	}
}

// Simulasi Test pada GORM (mengabaikan setup DB aktual untuk brevity)
func TestGetTenantID_Security(t *testing.T) {
	// 1. Aman
	ctx := context.WithValue(context.Background(), tenantKey, "tenant_X")
	tid, err := GetTenantID(ctx)
	if err != nil || tid != "tenant_X" {
		t.Fatalf("Failed positive case")
	}

	// 2. Fatal (Context tidak ada nilainya)
	emptyCtx := context.Background()
	_, err = GetTenantID(emptyCtx)
	if err == nil {
		t.Fatalf("Expected error when tenant is missing from context to prevent accidental full table scans")
	}
}
```
