# Panduan Definitif: Otorisasi RBAC & ABAC dengan Casbin

## 1. Konsep dan Internals (Technical Depth)

Otorisasi (*Authorization*) adalah gerbang kedua setelah Autentikasi. Jika Otentikasi bertanya "Siapakah Anda?", Otorisasi bertanya "Apakah Anda diizinkan membaca dokumen #42?". Ketiadaan atau kecacatan Otorisasi adalah penyebab utama vulnerability **Broken Access Control** (Peringkat #1 di OWASP Top 10).

Ekosistem Go memiliki pustaka standar industri bernama **Casbin**, yang menggunakan model PERM (*Policy, Effect, Request, Matcher*) yang fleksibel.

1. **Model PERM**: File konfigurasi (atau string memory) yang memisahkan sintaks cara kerja otorisasi (RBAC/ABAC) dari kode Golang itu sendiri.
   - *Request (r)*: Parameter masuk (Siapa `sub`, Objek apa `obj`, Aksi apa `act`).
   - *Policy (p)*: Aturan (Siapa `sub`, Objek `obj`, Aksi `act`).
   - *Matcher (m)*: Syarat perbandingan (misal: `r.sub == p.sub`).
   - *Effect (e)*: Hasil akhir (misal: jika ada SATU saja p yang cocok, kembalikan `allow`).
2. **RBAC (Role-Based)**: Pengguna dikelompokkan dalam peran (Admin, HR, Editor). Casbin mendukung pemetaan dinamis ini via policy grup: `g(alice, admin)`.
3. **ABAC (Attribute-Based)**: Akses dinamis berdasar kondisi runtime. "Pengguna dapat mengedit artikel, JIKA (artikel.id_pemilik == pengguna.id_user)". ABAC jauh lebih kuat untuk struktur B2B SaaS daripada jumlah *Role* yang meledak jutaan baris (*Role Explosion*).
4. **Adapter Pattern**: Policy tidak diletakkan di RAM saat server reboot. Casbin secara asinkron membaca policy (aturan DB) menggunakan *Adapter* (Postgres/Redis). Anda harus mengawinkan Casbin dengan *Watcher* (Redis Pub/Sub) agar saat instans Go 1 merubah aturan, instans Go 2 s/d 100 langsung me-refresh *cache memory*-nya secara otonom.

## 2. Diagram ASCII: Alur Enforcement Otorisasi Terdistribusi

```text
[ Client Request ]
  GET /api/docs/123
        |
        v
+-----------------------------+
| Auth Middleware             |
| (Decode JWT -> sub: Alice)  |
+-----------------------------+
        |
        v
+-----------------------------+           (Update aturan dari Admin API)
| Golang API Handler          |<============ [ DB PostgreSQL Policy Table ]
|                             |                      ^
| Casbin.Enforce()            |                      | (1. Load & Update DB)
| - r.sub = alice             |                      v
| - r.obj = /api/docs/123     |================= [ Redis PubSub (Watcher) ]
| - r.act = read              |                      | (2. Broadcast event)
|                             |                      v
|  * Matcher Engine di RAM *  |========> (Service Golang Instance #2)
|  return TRUE / FALSE        |
+-----------------------------+
        |
    [ ALLOW ] -----------------> Lanjutkan eksekusi (Return Data Doc 123)
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Otorisasi (Spaghetti Auth)

**Mengapa berbahaya (Exploit Vector)**: Developer Go pemula cenderung menyebar logika IF/ELSE di setiap handler (ratusan fungsi). Jika besok CEO Anda berkata "HR juga bisa read data Finance", Anda harus berburu ratusan IF di seluruh kode base. Risiko ada API yang terlewat dan menyebabkan eksploitasi Insecure Direct Object Reference (IDOR).

```go
// VULNERABLE: Hardcoded Access Control (Spaghetti)
func deleteDocVulnerable(w http.ResponseWriter, r *http.Request) {
	userRole := r.Context().Value("role").(string)
	docID := getDocID(r)
	docOwner := db.getOwner(docID)

	// ❌ BAD: Logika akses sangat kaku. Sulit merubah struktur korporasi.
	if userRole != "admin" && userRole != "superadmin" {
		if r.Context().Value("userID").(string) != docOwner {
			http.Error(w, "Forbidden", 403)
			return
		}
	}
	// delete doc...
}
```

```go
// ✅ GOOD: Pindahkan 100% logika tersebut ke file Casbin Policy dan Enforcer
func deleteDocSafe(w http.ResponseWriter, r *http.Request) {
	sub := r.Context().Value("userID").(string)
	obj := r.URL.Path
	act := r.Method

	// Engine yang akan menentukan apakah sub diizinkan act terhadap obj
	ok, _ := enforcer.Enforce(sub, obj, act)
	if !ok {
		http.Error(w, "Forbidden", 403)
		return
	}
	// delete doc...
}
```

### ❌ Anti-Pattern 2: Permissive Default (Fail-Open)

**Mengapa berbahaya (Exploit Vector)**: Policy Effect di Casbin disetel untuk membolehkan segala sesuatu kecuali jika dilarang. Ini bertentangan dengan prinsip Zero Trust. Attacker akan mencari resource tersembunyi yang "lupa" dilindungi rule spesifik. 

```text
// ❌ BAD: Default Effect - mengizinkan akses jika tidak dilarang
const badModel = `
[policy_effect]
e = !some(where (p.eft == deny))
`

// ✅ GOOD: Fail-Closed Default (Harus ada rule eksplisit allow)
const safeModel = `
[policy_effect]
e = some(where (p.eft == allow))
`
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Role Explosion**: Aplikasi multi-tenant B2B memiliki TenantA dan TenantB. Alice adalah "admin" di TenantA. Jika ia meminta `/tenantB/data`, role `admin`-nya tidak berlaku. Jangan menumpuk role `admin_tenantA`, `admin_tenantB` (Role Explosion). Gunakan ekstensi *Domain* RBAC pada casbin model: `r = sub, dom, obj, act` dimana *dom* adalah TenantID.
2. **Kinerja Sinkronisasi Database (Watcher)**: Jika server melakukan query SQL untuk tiap evaluasi `.Enforce()`, latency API turun ke bawah tanah. Casbin menyimpan *rules* di memori RAM via *Trie*. Anda WAJIB memakai Redis Watcher (`casbin/redis-watcher`) agar jika instans Go merubah tabel via `AddPolicy()`, instans Go lain mendapat ping *event* untuk mereload dari DB.
3. **Pengecekan Objek Dinamis (ABAC JSON)**: Kadang kita tidak bisa memodelkan aturan dalam String. "Pengguna boleh Approve jika transaksi.Amount < 50000". Anda dapat mempassing *Struct golang pointer* ke dalam `Enforce()`, dan menggunakan built-in `eval()` pada model Casbin untuk mengakses `r.obj.Amount`.

## 5. Production-Ready Go Code

Implementasi RBAC dan ABAC hibrida Casbin.

```go
package authz

import (
	"context"
	"fmt"
	"testing"

	"github.com/casbin/casbin/v2"
	"github.com/casbin/casbin/v2/model"
	fileadapter "github.com/casbin/casbin/v2/persist/file-adapter"
)

// CasbinModel mengadopsi model PERM (Policy, Effect, Request, Matcher)
// Mendukung RBAC via fungsi "g" dan pattern matching via "keyMatch2"
const modelConf = `
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
# Kondisi: Jika user cocok secara Role (g), ATAU dia adalah Root admin
# DAN target objek HTTP url cocok pola restful (keyMatch2 /api/docs/* == /api/docs/1)
m = g(r.sub, p.sub) && keyMatch2(r.obj, p.obj) && regexMatch(r.act, p.act) || r.sub == "root"
`

// DefaultPolicies (Biasanya ditarik dari DB/Gorm, tapi kita simulasikan string Adapter)
const policyCSV = `
p, role:editor, /articles/*, (GET|POST|PUT)
p, role:viewer, /articles/*, GET
p, role:editor, /admin/*, GET

g, alice, role:editor
g, bob, role:viewer
`

type Authorizer struct {
	enforcer *casbin.Enforcer
}

// NewAuthorizer inisialisasi Enforcer dengan Fail-safe default
func NewAuthorizer(ctx context.Context) (*Authorizer, error) {
	m, err := model.NewModelFromString(modelConf)
	if err != nil {
		return nil, fmt.Errorf("failed creating casbin model: %w", err)
	}

	adapter := fileadapter.NewAdapterFromMemory(policyCSV)

	enforcer, err := casbin.NewEnforcer(m, adapter)
	if err != nil {
		return nil, fmt.Errorf("failed creating casbin enforcer: %w", err)
	}

	// Wajib dilakukan di aplikasi production multi-node:
	// watcher := rediswatcher.NewWatcher("redis:6379")
	// enforcer.SetWatcher(watcher)

	// Pastikan sinkronisasi awal
	if err := enforcer.LoadPolicy(); err != nil {
		return nil, fmt.Errorf("failed to load policy: %w", err)
	}

	return &Authorizer{enforcer: enforcer}, nil
}

// CheckPermission adalah proxy helper mengeksekusi Otorisasi
func (auth *Authorizer) CheckPermission(ctx context.Context, userID, resource, action string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, fmt.Errorf("context timeout: %w", err)
	}

	// Gunakan enforcer internal untuk validasi model
	ok, err := auth.enforcer.Enforce(userID, resource, action)
	if err != nil {
		return false, fmt.Errorf("casbin enforcement error: %w", err)
	}

	return ok, nil
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestCasbinRBACBoundaries_HappyPath(t *testing.T) {
	ctx := context.Background()
	authz, _ := NewAuthorizer(ctx)

	tests := []struct {
		sub string
		obj string
		act string
	}{
		{"alice", "/articles/10", "GET"},
		{"alice", "/articles/10", "PUT"},
		{"bob", "/articles/10", "GET"},
	}

	for _, tt := range tests {
		ok, err := authz.CheckPermission(ctx, tt.sub, tt.obj, tt.act)
		if err != nil || !ok {
			t.Errorf("Expected allow for %s on %s %s", tt.sub, tt.obj, tt.act)
		}
	}
}

func TestCasbinRBACBoundaries_FailSecure(t *testing.T) {
	ctx := context.Background()
	authz, _ := NewAuthorizer(ctx)

	tests := []struct {
		sub string
		obj string
		act string
	}{
		{"bob", "/articles/10", "PUT"},
		{"alice", "/admin/settings", "POST"},
		{"charlie", "/articles/10", "GET"},
	}

	for _, tt := range tests {
		ok, _ := authz.CheckPermission(ctx, tt.sub, tt.obj, tt.act)
		if ok {
			t.Errorf("Expected deny for %s on %s %s", tt.sub, tt.obj, tt.act)
		}
	}
}

func TestCasbinRBACBoundaries_RootBypass(t *testing.T) {
	ctx := context.Background()
	authz, _ := NewAuthorizer(ctx)

	ok, err := authz.CheckPermission(ctx, "root", "/secret/vault", "DELETE")
	if err != nil || !ok {
		t.Errorf("Expected root to bypass all rules")
	}
}
```
