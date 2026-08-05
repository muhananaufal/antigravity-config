# Panduan Definitif: Otorisasi RBAC & ABAC dengan Casbin

> **Berlaku:** Go 1.21+ · `casbin/casbin/v2` · **Lihat juga:** `security_owasp/jwt_dual_token_auth.md` · `distributed_patterns_resilience/multi_tenancy_isolation.md` · `security_owasp/audit_logging_scrubbing.md` · `security_owasp/owasp_input_validation.md`

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
// ✅ GOOD: seluruh logika akses pindah ke kebijakan Casbin
func deleteDocSafe(w http.ResponseWriter, r *http.Request) {
	// Bentuk comma-ok, dan kunci context BERTIPE, bukan string telanjang.
	// `r.Context().Value("userID").(string)` panic bila nilainya tidak ada —
	// di jalur otorisasi, itu berarti satu middleware yang lupa terpasang
	// menjatuhkan handler alih-alih menolak permintaan.
	sub, ok := r.Context().Value(kunciUserID).(string)
	if !ok || sub == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	dom, _ := r.Context().Value(kunciTenant).(string)

	izin, err := authz.CheckPermission(r.Context(), sub, dom, r.URL.Path, r.Method)
	if err != nil {
		// Galat penegakan BUKAN "tolak diam-diam": ia menandakan mesin
		// otorisasi sedang tidak berfungsi, dan itu harus terlihat.
		http.Error(w, "internal", http.StatusInternalServerError)
		return
	}
	if !izin {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// hapus dokumen...
}
```

> `r.URL.Path` diteruskan apa adanya di sini **hanya karena** `CheckPermission` menormalkannya di dalam (lihat §5). Bila Anda memanggil `enforcer.Enforce` langsung, normalkan sendiri — memberi izin atas satu bentuk path lalu bertindak atas bentuk lain adalah salah satu bypass otorisasi yang paling sering lolos review.

### ❌ Anti-Pattern 2: Permissive Default (Fail-Open)

**Mengapa berbahaya:** effect `!some(where (p.eft == deny))` mengizinkan apa pun yang tidak dilarang secara eksplisit, sehingga setiap resource baru lahir dalam keadaan terbuka sampai ada yang ingat menulis aturan larangannya. Penyerang cukup mencari yang terlupakan.

Satu koreksi yang penting agar tidak salah paham: ini **bukan** perilaku bawaan Casbin. Model standar Casbin memakai `e = some(where (p.eft == allow))` — fail-closed. Efek permisif hanya muncul bila seseorang menuliskannya sendiri, biasanya untuk "sementara" saat migrasi dari sistem lama. Yang perlu Anda periksa karena itu bukan pustakanya, melainkan berkas model di repositori Anda.

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

1. **Role Explosion — dan konsekuensi yang lebih tajam daripada sekadar "banyak peran"**: Alice adalah admin di TenantA; saat ia meminta data TenantB, perannya tidak boleh berlaku. Menumpuk `admin_tenantA`, `admin_tenantB` menghasilkan ledakan peran; jawabannya dimensi *domain*: `r = sub, dom, obj, act` dengan `dom` sebagai TenantID, dan `g = _, _, _` agar penugasan peran pun terikat domain.

   Yang perlu ditegaskan: model tanpa `dom` **bukan** sekadar kurang praktis. Pada aplikasi multi-tenant ia berarti setiap "editor" adalah editor di seluruh tenant — Broken Access Control, kerentanan yang berkas ini sendiri sebut sebagai peringkat #1 OWASP di kalimat pembukanya. Perbedaannya satu kolom di model, dan akibatnya seluruh isolasi tenant.
2. **Kinerja Sinkronisasi Database (Watcher)**: Jika server melakukan query SQL untuk tiap evaluasi `.Enforce()`, latency API turun ke bawah tanah. Casbin menyimpan *rules* di memori RAM via *Trie*. Anda WAJIB memakai Redis Watcher (`casbin/redis-watcher`) agar jika instans Go merubah tabel via `AddPolicy()`, instans Go lain mendapat ping *event* untuk mereload dari DB.
3. **Pengecekan Objek Dinamis (ABAC JSON)**: Kadang kita tidak bisa memodelkan aturan dalam String. "Pengguna boleh Approve jika transaksi.Amount < 50000". Anda dapat mempassing *Struct golang pointer* ke dalam `Enforce()`, dan menggunakan built-in `eval()` pada model Casbin untuk mengakses `r.obj.Amount`.

## 5. Production-Ready Go Code

Implementasi RBAC dan ABAC hibrida Casbin.

```go
package authz

import (
	"context"
	"fmt"
	"log/slog"
	"path"
	"strings"

	"github.com/casbin/casbin/v2"
	"github.com/casbin/casbin/v2/model"
	fileadapter "github.com/casbin/casbin/v2/persist/file-adapter"
)

// Model PERM dengan dimensi DOMAIN (tenant).
//
// Tiga perbedaan dari bentuk yang biasa ditulis, dan ketiganya penting:
//
//  1. `dom` ada di request, policy, dan grouping. Kasus Tepi 1 di berkas ini
//     menuntutnya, tetapi versi sebelumnya memakai `r = sub, obj, act` — yang
//     berarti "editor" adalah editor di SELURUH tenant. Untuk aplikasi
//     multi-tenant itu bukan kekurangan fitur, melainkan Broken Access
//     Control, kerentanan yang berkas ini sebut sendiri sebagai OWASP #1.
//
//  2. TIDAK ADA `|| r.sub == "root"` di matcher. Superuser yang ditanam di
//     dalam matcher persis merupakan Anti-Pattern 1 yang dikutuk berkas ini:
//     logika akses di tempat yang bukan kebijakan — tidak bisa diubah tanpa
//     deploy, tidak muncul di audit perubahan kebijakan, dan tidak bisa
//     dicabut dengan menghapus satu baris. Ia juga menjadi pengambilalihan
//     total bila ada pengguna yang bisa memakai ID "root". Kekuasaan penuh
//     tetap bisa diberikan — lewat BARIS KEBIJAKAN, sehingga terhitung,
//     terlihat, dan bisa dicabut.
//
//  3. Pola aksi DIJANGKARKAN. `regexMatch` casbin memakai regexp.MatchString
//     yang mencocokkan SUBSTRING: pola `GET` juga cocok dengan `XGETX`, dan
//     pola `read` cocok dengan `read-write`. Tanpa `^...$`, izin sempit
//     diam-diam melebar.
const modelConf = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && keyMatch2(r.obj, p.obj) && regexMatch(r.act, p.act)
`

// Kebijakan (di produksi ditarik dari DB lewat adapter; di sini string).
const policyCSV = `
p, role:editor, tenant-a, /articles/*, ^(GET|POST|PUT)$
p, role:viewer, tenant-a, /articles/*, ^GET$
p, role:admin,  tenant-a, /admin/*,    ^(GET|POST)$
p, role:editor, tenant-b, /articles/*, ^(GET|POST|PUT)$

g, alice, role:editor, tenant-a
g, bob,   role:viewer, tenant-a
g, carol, role:editor, tenant-b
g, dana,  role:admin,  tenant-a
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

	// Wajib di produksi multi-node:
	// watcher := rediswatcher.NewWatcher("redis:6379")
	// enforcer.SetWatcher(watcher)
	//
	// Catatan: casbin.NewEnforcer SUDAH memuat kebijakan dari adapter.
	// Memanggil LoadPolicy() lagi di sini — seperti versi sebelumnya — tidak
	// salah, tetapi menyiratkan sebuah keharusan yang tidak ada.

	return &Authorizer{enforcer: enforcer}, nil
}

// CheckPermission mengevaluasi satu keputusan otorisasi.
//
// Perhatikan `domain` sebagai parameter tersendiri: tanpa itu, peran seorang
// pengguna berlaku di seluruh tenant.
func (auth *Authorizer) CheckPermission(ctx context.Context, userID, domain, resource, action string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, fmt.Errorf("context batal: %w", err)
	}

	// Objek DINORMALKAN sebelum dievaluasi.
	//
	// Ini bukan kerapian, melainkan penutup celah: `r.URL.Path` sudah
	// ter-decode, sehingga permintaan ke `/articles/%2e%2e/admin/settings`
	// tiba di sini sebagai `/articles/../admin/settings`. Pola `/articles/*`
	// mencocokkannya dan otorisasi MENGIZINKAN, lalu lapisan berikutnya
	// menormalkannya menjadi `/admin/settings` dan bertindak di situ.
	// Memberi izin atas satu bentuk path lalu bertindak atas bentuk lain
	// adalah pintu belakang yang tidak terlihat di kebijakan mana pun.
	objek := path.Clean("/" + strings.TrimPrefix(resource, "/"))

	izin, err := auth.enforcer.Enforce(userID, domain, objek, action)
	if err != nil {
		// Mesin otorisasi yang bermasalah harus TERLIHAT. Yang diam-diam
		// menolak semua orang adalah pemadaman; yang diam-diam mengizinkan
		// adalah pelanggaran. Keduanya tidak boleh sunyi.
		slog.ErrorContext(ctx, "penegakan otorisasi gagal", "galat", err,
			"subjek", userID, "domain", domain, "objek", objek, "aksi", action)
		return false, fmt.Errorf("penegakan casbin: %w", err)
	}

	// Setiap keputusan dicatat. Tabel deteksi di berkas ini menanyakan "siapa
	// mengakses apa", dan perintah bash-nya menyaring event "otorisasi" —
	// event yang sebelumnya tidak pernah dipancarkan kode mana pun.
	//
	// Ya, ini menambah satu baris log per pemeriksaan. Untuk keputusan
	// otorisasi, itu memang jejak auditnya: yang diizinkan sama pentingnya
	// dengan yang ditolak. Kalau volumenya jadi masalah, kurangi jumlah
	// PEMERIKSAAN yang berlebihan, jangan kurangi catatannya.
	hasil := "tolak"
	if izin {
		hasil = "izinkan"
	}
	slog.InfoContext(ctx, "keputusan otorisasi", "event", "otorisasi",
		"hasil", hasil, "subjek", userID, "domain", domain, "objek", objek, "aksi", action)

	return izin, nil
}
```

```go
package authz

import (
	"context"
	"testing"
)

func authzUji(t *testing.T) *Authorizer {
	t.Helper()
	// Galat konstruktor TIDAK dibuang. Versi sebelumnya menulis
	// `authz, _ := NewAuthorizer(ctx)` di tiga uji: bila konstruksi gagal,
	// authz bernilai nil dan ujinya panic dengan nil pointer, bukan gagal
	// dengan pesan yang menjelaskan apa pun.
	a, err := NewAuthorizer(context.Background())
	if err != nil {
		t.Fatalf("NewAuthorizer: %v", err)
	}
	return a
}

func TestKeputusanOtorisasi(t *testing.T) {
	a, ctx := authzUji(t), context.Background()

	kasus := []struct {
		nama              string
		sub, dom, obj, act string
		mauIzin           bool
	}{
		{"editor membaca artikel di tenant sendiri", "alice", "tenant-a", "/articles/10", "GET", true},
		{"editor mengubah artikel di tenant sendiri", "alice", "tenant-a", "/articles/10", "PUT", true},
		{"viewer membaca", "bob", "tenant-a", "/articles/10", "GET", true},
		{"viewer mengubah", "bob", "tenant-a", "/articles/10", "PUT", false},
		{"editor menyentuh area admin", "alice", "tenant-a", "/admin/settings", "POST", false},
		{"admin di area admin", "dana", "tenant-a", "/admin/settings", "POST", true},
		{"pengguna tak dikenal", "charlie", "tenant-a", "/articles/10", "GET", false},

		// Baris ini yang membuktikan dimensi domain benar-benar bekerja.
		// Dengan model lama (r = sub, obj, act) carol DIIZINKAN — perannya
		// berlaku di seluruh tenant, dan itulah Broken Access Control.
		{"editor tenant lain menyeberang", "carol", "tenant-a", "/articles/10", "PUT", false},
		{"editor tenant lain di tenant sendiri", "carol", "tenant-b", "/articles/10", "PUT", true},

		// Tidak ada lagi jalan pintas "root" yang ditanam di matcher.
		{"root bukan lagi kata sakti", "root", "tenant-a", "/admin/settings", "POST", false},
	}

	for _, k := range kasus {
		t.Run(k.nama, func(t *testing.T) {
			izin, err := a.CheckPermission(ctx, k.sub, k.dom, k.obj, k.act)
			if err != nil {
				t.Fatalf("CheckPermission: %v", err)
			}
			if izin != k.mauIzin {
				t.Fatalf("izin = %v, mau %v", izin, k.mauIzin)
			}
		})
	}
}

// Path ter-encode yang menormalkan menjadi area terlarang WAJIB ditolak.
// Tanpa normalisasi sebelum evaluasi, pola /articles/* mencocokkannya dan
// otorisasi mengizinkan sesuatu yang kemudian dieksekusi sebagai /admin/*.
func TestPathTernormalkanSebelumDievaluasi(t *testing.T) {
	a, ctx := authzUji(t), context.Background()

	izin, err := a.CheckPermission(ctx, "alice", "tenant-a", "/articles/../admin/settings", "POST")
	if err != nil {
		t.Fatalf("CheckPermission: %v", err)
	}
	if izin {
		t.Fatal("path traversal lolos otorisasi — dievaluasi sebelum dinormalkan")
	}
}

// Pola aksi WAJIB berjangkar. regexMatch casbin mencocokkan substring, jadi
// pola tak berjangkar diam-diam melebarkan izin.
func TestPolaAksiBerjangkar(t *testing.T) {
	a, ctx := authzUji(t), context.Background()

	for _, aksi := range []string{"XGET", "GETX", "XGETX"} {
		izin, err := a.CheckPermission(ctx, "bob", "tenant-a", "/articles/10", aksi)
		if err != nil {
			t.Fatalf("CheckPermission: %v", err)
		}
		if izin {
			t.Fatalf("aksi %q diterima — pola aksi tidak berjangkar", aksi)
		}
	}
}
```

## Kapan JANGAN Pakai Ini

- **Mesin kebijakan untuk aturan otorisasi yang sederhana dan stabil.** Tiga peran dengan izin tetap lebih jelas ditulis sebagai kode Go yang bisa dibaca, diuji, dan di-review. Mesin kebijakan mulai membayar dirinya ketika aturan berubah tanpa deploy.
- **Evaluasi kebijakan tanpa cache di jalur panas.** Memuat kebijakan dari database pada setiap permintaan menambah latensi dan satu dependensi baru di jalur yang paling tidak boleh gagal.
- **Otorisasi hanya di lapisan API.** Job terjadwal, konsumer antrean, dan skrip admin melewatinya sepenuhnya. Penegakan harus berada di tempat yang dilewati **semua** jalur.
- **Kebijakan yang tidak diuji.** Aturan otorisasi adalah kode yang menentukan siapa melihat apa. Ia layak mendapat cakupan uji setara logika bisnis — dan kesalahannya jauh lebih mahal.
- **Menambah ABAC sebelum RBAC-nya benar.** Atribut menambah dimensi yang membuat kebijakan sulit dinalar dan sulit diaudit. Mulai dari peran; tambahkan atribut hanya bila terbukti tidak cukup.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Data diakses lewat jalur yang tidak dicek | rasio endpoint vs pemanggilan `Enforce` | Ada jalur tanpa penegakan |
| Latensi naik sejak kebijakan diperbanyak | waktu evaluasi kebijakan | Evaluasi tanpa cache di jalur panas |
| Tidak bisa menjawab "siapa mengakses apa" | log keputusan otorisasi | Keputusan tidak dicatat |
| Kebijakan berubah tanpa jejak | audit perubahan kebijakan | Kebijakan diubah langsung di database |
| Aturan saling bertumpuk dan sulit dinalar | jumlah dimensi atribut | ABAC ditambahkan sebelum RBAC stabil |
| Pengguna satu tenant melihat data tenant lain | ada tidaknya `dom` di request & policy | Peran berlaku lintas tenant |
| Ada akun yang bisa apa saja tanpa baris kebijakan | pintasan di dalam matcher | Superuser ditanam di model, bukan di kebijakan |
| Izin terasa lebih luas dari yang tertulis | jangkar `^...$` pada pola aksi | `regexMatch` mencocokkan substring |
| Akses lolos lewat URL ter-encode | normalisasi path sebelum evaluasi | Diizinkan atas satu bentuk path, dieksekusi atas bentuk lain |

```bash
# Rasio kasar endpoint terhadap pemanggilan penegakan: selisih besar layak dicurigai
grep -rncE 'r\.(Get|Post|Put|Patch|Delete)\(' --include='*.go' internal/ | awk -F: '{s+=$2} END{print "rute:",s}'
grep -rnc 'Enforce(' --include='*.go' internal/ | awk -F: '{s+=$2} END{print "enforce:",s}'

# Keputusan otorisasi -- tanpa log ini tidak ada audit trail sama sekali
kubectl logs -l app=api --since=24h \
  | jq -r 'select(.event=="otorisasi") | "\(.hasil) \(.subjek) \(.aksi) \(.objek)"' \
  | sort | uniq -c | sort -rn | head -20
```
