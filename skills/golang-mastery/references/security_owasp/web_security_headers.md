# CORS, CSRF, dan Security Header

> **Berlaku:** Go 1.22+ (`http.ServeMux` pola metode) · Fetch Standard · **Lihat juga:** `microservices_grpc/rest_chi_middleware_stack.md` · `security_owasp/oauth2_oidc_flow.md` · `security_owasp/owasp_input_validation.md` · `caching_strategy/http_cdn_caching.md`

## Konsep Utama

Tiga hal ini sering dianggap satu topik, padahal menjawab pertanyaan yang berbeda — dan mencampurnya adalah sumber kesalahan konfigurasi yang paling umum:

| Mekanisme | Menjawab | Melindungi siapa |
| :--- | :--- | :--- |
| **CORS** | "Boleh tidak JavaScript dari origin lain **membaca** respons saya?" | Melindungi **pengguna** dari situs lain yang membaca data mereka |
| **CSRF** | "Permintaan yang mengubah data ini benar-benar dari aplikasi saya?" | Melindungi **pengguna** dari aksi yang tidak mereka maksudkan |
| **Security header** | "Bagaimana browser harus memperlakukan halaman ini?" | Mengurangi dampak XSS, clickjacking, dan kebocoran referrer |

### CORS bukan kontrol akses

Kesalahpahaman yang paling merusak: **CORS tidak mengamankan API Anda.** Ia adalah kebijakan yang ditegakkan **browser**, dan hanya browser. `curl`, skrip Python, dan aplikasi seluler mengabaikannya sepenuhnya.

CORS melindungi **pengguna Anda** dari situs jahat yang mencoba membaca respons API Anda dengan kredensial pengguna. Ia tidak menghalangi siapa pun mengakses API Anda secara langsung — untuk itu, yang dibutuhkan autentikasi dan otorisasi.

Dua kombinasi yang WAJIB dipahami:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true      <- KOMBINASI TERLARANG
```

Browser menolak kombinasi ini, tetapi banyak middleware "memperbaikinya" dengan memantulkan `Origin` pemanggil:

```
Access-Control-Allow-Origin: <apa pun yang dikirim penyerang>
Access-Control-Allow-Credentials: true      <- SAMA BAHAYANYA
```

Ini secara efektif membuka API berkredensial Anda ke situs mana pun. Bila `Allow-Credentials: true`, daftar origin WAJIB eksplisit.

### CSRF: kapan masih relevan

`SameSite=Lax` (default browser modern) sudah menutup sebagian besar CSRF klasik. Tetapi ia **bukan** perlindungan lengkap:

| Keadaan | Masih rentan? |
| :--- | :--- |
| Cookie sesi, `SameSite=Lax`, mutasi lewat `POST` | Sebagian besar tertutup |
| Cookie sesi, `SameSite=None` (dibutuhkan lintas situs) | **Ya** — butuh token CSRF |
| Mutasi lewat `GET` | **Ya** — dan itu memang salah desain |
| Subdomain yang bisa dikendalikan pihak lain | **Ya** — cookie dibagi lintas subdomain |
| Bearer token di header, bukan cookie | Tidak — browser tidak mengirim header otomatis |

Aturan sederhana: **kalau otentikasinya lewat cookie, Anda butuh perlindungan CSRF.** Kalau lewat header `Authorization`, tidak.

## Diagram ASCII

```text
   CORS: SIAPA YANG SEBENARNYA DILINDUNGI

   situs-jahat.com                Browser              api.anda.id
        |                            |                      |
        |-- fetch(credentials) ----->|                      |
        |                            |-- OPTIONS (preflight)->|
        |                            |<-- Allow-Origin: app.anda.id
        |                            |
        |                     Origin TIDAK cocok
        |                     -> permintaan asli tidak dikirim
        |<-- error di JS ------------|
        |
   Yang dilindungi: PENGGUNA, dari situs-jahat membaca datanya.
   Yang TIDAK dilindungi: API Anda. curl mengabaikan semua ini.

   ---------------------------------------------------------------

   PREFLIGHT: kapan browser bertanya dulu

   Sederhana (TANPA preflight):
     GET/HEAD/POST + Content-Type: text/plain | form-urlencoded | multipart
   Butuh preflight:
     PUT/PATCH/DELETE, atau Content-Type: application/json,
     atau header kustom (Authorization, X-Request-ID, ...)

   Hampir semua API JSON memicu preflight. Preflight yang gagal
   membuat permintaan aslinya TIDAK PERNAH dikirim -- dan galatnya
   hanya muncul di konsol browser, bukan di log server Anda.

   ---------------------------------------------------------------

   CSRF: kenapa SameSite saja belum cukup

   Cookie + SameSite=Lax  -> POST lintas situs tidak membawa cookie  OK
   Cookie + SameSite=None -> cookie IKUT terkirim   -> butuh token
   Bearer di header       -> browser tidak mengirim otomatis          OK

   Pola double-submit:
     server -> cookie csrf (bisa dibaca JS) + sesi (HttpOnly)
     klien  -> kirim balik nilainya di header X-CSRF-Token
     server -> bandingkan header vs cookie; situs lain tidak bisa
               MEMBACA cookie itu, jadi tidak bisa mengirim header yang cocok
```

## Kode Go Production-Ready

```go
package webkeamanan

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
)

// ---------- CORS ----------

// KonfigCORS mendaftarkan origin secara eksplisit. Tidak ada mode wildcard
// ketika kredensial diizinkan -- itu kombinasi yang tidak boleh ada.
type KonfigCORS struct {
	OriginDiizinkan []string
	MetodeDiizinkan []string
	HeaderDiizinkan []string
	HeaderDibuka    []string // yang boleh dibaca JS dari respons
	Kredensial      bool
	MaksUmurDetik   int // berapa lama browser boleh meng-cache preflight
}

// CORSDefault memberi konfigurasi yang aman untuk API JSON berkredensial.
func CORSDefault(origin ...string) KonfigCORS {
	return KonfigCORS{
		OriginDiizinkan: origin,
		MetodeDiizinkan: []string{"GET", "POST", "PUT", "PATCH", "DELETE"},
		HeaderDiizinkan: []string{"Content-Type", "Authorization", "X-CSRF-Token", "X-Request-ID"},
		HeaderDibuka:    []string{"X-Request-ID"},
		Kredensial:      true,
		MaksUmurDetik:   600,
	}
}

// CORS mengembalikan middleware yang menangani preflight dan respons biasa.
func CORS(k KonfigCORS) func(http.Handler) http.Handler {
	diizinkan := make(map[string]struct{}, len(k.OriginDiizinkan))
	for _, o := range k.OriginDiizinkan {
		diizinkan[o] = struct{}{}
	}
	metode := strings.Join(k.MetodeDiizinkan, ", ")
	header := strings.Join(k.HeaderDiizinkan, ", ")
	dibuka := strings.Join(k.HeaderDibuka, ", ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			// Permintaan tanpa Origin bukan permintaan lintas asal
			// (curl, server-ke-server). Lewatkan tanpa header CORS.
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}

			// Vary WAJIB ada: tanpa ini, cache/CDN bisa menyajikan respons
			// beserta header CORS milik origin LAIN.
			w.Header().Add("Vary", "Origin")

			if _, ok := diizinkan[origin]; !ok {
				// Origin tidak dikenal: JANGAN pantulkan, JANGAN pakai "*".
				// Preflight dijawab tanpa izin; permintaan biasa tetap
				// diproses tetapi JS pemanggil tidak boleh membaca hasilnya.
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			w.Header().Set("Access-Control-Allow-Origin", origin)
			if k.Kredensial {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			if dibuka != "" {
				w.Header().Set("Access-Control-Expose-Headers", dibuka)
			}

			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.Header().Set("Access-Control-Allow-Methods", metode)
				w.Header().Set("Access-Control-Allow-Headers", header)
				w.Header().Set("Access-Control-Max-Age", strconv.Itoa(k.MaksUmurDetik))
				// Preflight WAJIB dijawab 204 dan berhenti di sini.
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// ---------- CSRF: double-submit cookie ----------

const (
	namaCookieCSRF = "csrf_token"
	namaHeaderCSRF = "X-CSRF-Token"
)

// metodeAman tidak mengubah keadaan, jadi tidak butuh token CSRF.
func metodeAman(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return true
	}
	return false
}

// PasangTokenCSRF menerbitkan token baru bila belum ada.
// Cookie ini SENGAJA tidak HttpOnly: JavaScript aplikasi Anda harus bisa
// membacanya untuk mengirimkannya kembali sebagai header.
func PasangTokenCSRF(w http.ResponseWriter, r *http.Request) (string, error) {
	if c, err := r.Cookie(namaCookieCSRF); err == nil && c.Value != "" {
		return c.Value, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := base64.RawURLEncoding.EncodeToString(b)
	http.SetCookie(w, &http.Cookie{
		Name:     namaCookieCSRF,
		Value:    tok,
		Path:     "/",
		Secure:   true,
		HttpOnly: false, // disengaja: JS aplikasi perlu membacanya
		SameSite: http.SameSiteLaxMode,
	})
	return tok, nil
}

// CSRF menolak mutasi yang header-nya tidak cocok dengan cookie.
//
// Situs lain TIDAK BISA membaca cookie Anda karena same-origin policy,
// sehingga mereka tidak bisa mengirim header yang cocok -- itulah dasar
// perlindungan pola double-submit.
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if metodeAman(r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		// Otentikasi lewat header Authorization tidak rentan CSRF:
		// browser tidak mengirim header itu secara otomatis.
		if r.Header.Get("Authorization") != "" {
			next.ServeHTTP(w, r)
			return
		}

		c, err := r.Cookie(namaCookieCSRF)
		if err != nil || c.Value == "" {
			http.Error(w, "token CSRF tidak ada", http.StatusForbidden)
			return
		}
		dariHeader := r.Header.Get(namaHeaderCSRF)
		// Perbandingan konstan waktu: mencegah kebocoran lewat timing.
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(dariHeader)) != 1 {
			http.Error(w, "token CSRF tidak cocok", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- Security header ----------

// KonfigHeader mengatur header keamanan respons.
type KonfigHeader struct {
	// CSP untuk halaman HTML. Untuk API JSON, gunakan kebijakan yang
	// melarang segalanya -- respons API tidak seharusnya dirender.
	CSP string
	// HSTSDetik = 0 mematikan HSTS. Nyalakan HANYA setelah yakin
	// seluruh subdomain siap HTTPS: HSTS tidak bisa ditarik cepat.
	HSTSDetik int
}

// HeaderAPI memberi kebijakan yang tepat untuk endpoint JSON.
func HeaderAPI() KonfigHeader {
	return KonfigHeader{
		CSP:       "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		HSTSDetik: 31536000,
	}
}

// Header memasang header keamanan pada setiap respons.
func Header(k KonfigHeader) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			// Mencegah browser menebak tipe konten -- dasar serangan
			// yang mengubah unggahan teks menjadi skrip yang dieksekusi.
			h.Set("X-Content-Type-Options", "nosniff")
			// Membatasi kebocoran URL internal ke situs lain.
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			// Mematikan API browser yang tidak dibutuhkan API JSON.
			h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
			if k.CSP != "" {
				// frame-ancestors di CSP menggantikan X-Frame-Options
				// dan lebih ekspresif.
				h.Set("Content-Security-Policy", k.CSP)
			}
			if k.HSTSDetik > 0 && r.TLS != nil {
				h.Set("Strict-Transport-Security",
					"max-age="+strconv.Itoa(k.HSTSDetik)+"; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

## Uji

```go
package webkeamanan

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func handlerOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
}

func TestCORS_OriginTidakDikenalTidakDipantulkan(t *testing.T) {
	// Inti pengujian: memantulkan Origin pemanggil sambil mengizinkan
	// kredensial membuka API berkredensial ke situs mana pun.
	h := CORS(CORSDefault("https://app.contoh.id"))(handlerOK())

	r := httptest.NewRequest(http.MethodGet, "/data", nil)
	r.Header.Set("Origin", "https://situs-jahat.id")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("origin asing TIDAK BOLEH diizinkan, dapat %q", got)
	}
}

func TestCORS_TidakPernahWildcardBersamaKredensial(t *testing.T) {
	h := CORS(CORSDefault("https://app.contoh.id"))(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil)
	r.Header.Set("Origin", "https://app.contoh.id")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	asal := w.Header().Get("Access-Control-Allow-Origin")
	kred := w.Header().Get("Access-Control-Allow-Credentials")
	if asal == "*" && kred == "true" {
		t.Fatal("kombinasi terlarang: wildcard + kredensial")
	}
	if asal != "https://app.contoh.id" {
		t.Fatalf("origin yang diizinkan harus dikembalikan persis, dapat %q", asal)
	}
}

func TestCORS_VaryOriginSelaluAda(t *testing.T) {
	// Tanpa Vary: Origin, CDN bisa menyajikan respons beserta header CORS
	// milik origin lain kepada pengguna yang berbeda.
	h := CORS(CORSDefault("https://app.contoh.id"))(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil)
	r.Header.Set("Origin", "https://app.contoh.id")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !strings.Contains(w.Header().Get("Vary"), "Origin") {
		t.Fatal("Vary: Origin WAJIB ada agar cache tidak tercampur")
	}
}

func TestCORS_PreflightDijawab204DanBerhenti(t *testing.T) {
	dipanggil := false
	h := CORS(CORSDefault("https://app.contoh.id"))(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) { dipanggil = true }))

	r := httptest.NewRequest(http.MethodOptions, "/data", nil)
	r.Header.Set("Origin", "https://app.contoh.id")
	r.Header.Set("Access-Control-Request-Method", "POST")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight harus 204, dapat %d", w.Code)
	}
	if dipanggil {
		t.Fatal("preflight tidak boleh diteruskan ke handler")
	}
	if w.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Error("preflight harus menyebutkan header yang diizinkan")
	}
}

func TestCSRF_MutasiTanpaTokenDitolak(t *testing.T) {
	h := CSRF(handlerOK())
	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r.AddCookie(&http.Cookie{Name: "sesi", Value: "abc"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("mutasi berbasis cookie tanpa token CSRF harus 403, dapat %d", w.Code)
	}
}

func TestCSRF_HeaderHarusCocokCookie(t *testing.T) {
	h := CSRF(handlerOK())

	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r.AddCookie(&http.Cookie{Name: namaCookieCSRF, Value: "token-benar"})
	r.Header.Set(namaHeaderCSRF, "token-penyerang")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("token tidak cocok harus 403, dapat %d", w.Code)
	}

	r2 := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r2.AddCookie(&http.Cookie{Name: namaCookieCSRF, Value: "token-benar"})
	r2.Header.Set(namaHeaderCSRF, "token-benar")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusOK {
		t.Fatalf("token cocok harus lolos, dapat %d", w2.Code)
	}
}

func TestCSRF_BearerTokenTidakButuhCSRF(t *testing.T) {
	// Browser tidak mengirim header Authorization secara otomatis,
	// jadi jalur ini memang tidak rentan CSRF.
	h := CSRF(handlerOK())
	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r.Header.Set("Authorization", "Bearer xyz")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("otentikasi bearer tidak butuh CSRF, dapat %d", w.Code)
	}
}

func TestCSRF_MetodeAmanDilewatkan(t *testing.T) {
	h := CSRF(handlerOK())
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		r := httptest.NewRequest(m, "/data", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Errorf("%s harus lolos tanpa token, dapat %d", m, w.Code)
		}
	}
}

func TestHeader_APIMemasangKebijakanKetat(t *testing.T) {
	h := Header(HeaderAPI())(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	mau := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for k, v := range mau {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s: mau %q, dapat %q", k, v, got)
		}
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Error("frame-ancestors 'none' wajib untuk mencegah clickjacking")
	}
}

func TestHeader_HSTSHanyaDiHTTPS(t *testing.T) {
	// HSTS lewat HTTP polos diabaikan browser dan hanya menyesatkan
	// pembaca konfigurasi.
	h := Header(HeaderAPI())(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil) // r.TLS == nil
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("HSTS tidak boleh dipasang pada koneksi non-TLS")
	}
}
```

## Anti-Pattern

**❌ SALAH — memantulkan `Origin` pemanggil**

```go
w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
w.Header().Set("Access-Control-Allow-Credentials", "true")
```

Ini setara membuka API berkredensial Anda ke **setiap situs di internet**. Browser akan mengizinkan situs mana pun membaca respons Anda dengan cookie pengguna terlampir. Kesalahan ini sering muncul sebagai "perbaikan cepat" ketika wildcard ditolak browser.

**✅ BENAR — daftar putih eksplisit**

```go
if _, ok := diizinkan[origin]; !ok {
	next.ServeHTTP(w, r) // tanpa header CORS: JS tidak boleh membacanya
	return
}
w.Header().Set("Access-Control-Allow-Origin", origin)
```

**❌ SALAH — melupakan `Vary: Origin`**

```go
w.Header().Set("Access-Control-Allow-Origin", origin) // tanpa Vary
```

CDN akan meng-cache respons **beserta** header CORS-nya dan menyajikannya ke pengguna dari origin lain. Hasilnya: izin yang diberikan ke satu origin bocor ke origin lain, atau sebaliknya permintaan sah ditolak secara acak.

**✅ BENAR — `Vary` ditambahkan sebelum keputusan apa pun**

```go
w.Header().Add("Vary", "Origin")
```

**❌ SALAH — menganggap CORS mengamankan API**

```go
// "API ini aman, CORS-nya hanya mengizinkan domain kami."
```

`curl -H 'Origin: apa-saja' https://api.anda.id/admin/pengguna` mengembalikan datanya dengan senang hati. CORS tidak pernah menghalangi klien non-browser.

**✅ BENAR — CORS untuk melindungi pengguna, autentikasi untuk melindungi API**

Keduanya diperlukan, dan tidak saling menggantikan.

**❌ SALAH — mutasi lewat `GET`**

```go
mux.HandleFunc("GET /akun/hapus", hapusAkun)
```

`GET` bisa dipicu dari `<img src>` di situs mana pun, dan `SameSite=Lax` **mengizinkan** cookie ikut pada navigasi tingkat atas. Ini CSRF dengan permukaan terluas yang mungkin.

**✅ BENAR — mutasi hanya lewat metode yang tidak aman, dengan CSRF**

```go
mux.Handle("POST /akun/hapus", CSRF(http.HandlerFunc(hapusAkun)))
```

**❌ SALAH — `Content-Security-Policy` dengan `unsafe-inline`**

```
Content-Security-Policy: script-src 'self' 'unsafe-inline'
```

`unsafe-inline` mematikan justru perlindungan utama CSP terhadap XSS. Kebijakan itu terlihat ada di header dan praktis tidak melakukan apa-apa.

**✅ BENAR — nonce per permintaan untuk skrip inline yang memang perlu**

```go
nonce, _ := acak16()
h.Set("Content-Security-Policy", "script-src 'self' 'nonce-"+nonce+"'")
// lalu render: <script nonce="{{.Nonce}}">
```

## Kasus Tepi Produksi

1. **Preflight yang gagal tidak muncul di log server Anda.** Browser membatalkan permintaan aslinya, dan galatnya hanya tampak di konsol browser. Dari sisi server, permintaan itu **tidak pernah ada** — ini penyebab paling umum "bekerja dengan curl, gagal di browser".

2. **`Access-Control-Max-Age` yang terlalu panjang mengunci kesalahan.** Browser meng-cache hasil preflight; perubahan kebijakan CORS tidak berlaku sampai cache kedaluwarsa. Beberapa menit wajar saat produksi stabil; kecilkan saat sedang mengubah konfigurasi.

3. **HSTS sulit ditarik.** `max-age` satu tahun dengan `includeSubDomains` berarti browser menolak HTTP untuk seluruh subdomain selama setahun — termasuk subdomain internal yang belum siap TLS. Naikkan `max-age` bertahap, dan pastikan setiap subdomain siap sebelum `includeSubDomains`.

4. **Cookie dibagi lintas subdomain.** Cookie yang disetel untuk `.contoh.id` terkirim ke `apa-pun.contoh.id`. Subdomain yang bisa dikendalikan pihak lain — halaman pelanggan, dokumentasi yang di-host pihak ketiga — menjadi jalur pengambilan sesi. Batasi domain cookie sesempit mungkin.

5. **`SameSite=None` menuntut `Secure`.** Browser modern menolak kombinasi `SameSite=None` tanpa `Secure`, dan cookie-nya diabaikan diam-diam. Gejalanya: pengguna tidak pernah bisa login lewat alur lintas situs, tanpa satu pun galat di server.

6. **Websocket melewati CORS.** Koneksi WebSocket tidak tunduk pada CORS. Origin WAJIB diperiksa manual pada saat upgrade; tanpa itu, situs mana pun bisa membuka koneksi berkredensial ke server Anda.

7. **CSP untuk respons API tidak sama dengan CSP untuk halaman.** Respons JSON seharusnya tidak pernah dirender sebagai dokumen. `default-src 'none'; frame-ancestors 'none'` adalah kebijakan yang tepat — dan menutup serangan yang mengandalkan browser merender respons API secara langsung.

## Kapan JANGAN Pakai Ini

- **Token CSRF pada API yang otentikasinya lewat header `Authorization`.** Browser tidak mengirim header itu secara otomatis, jadi CSRF tidak berlaku. Menambahkannya hanya menambah kerumitan dan satu jalur kegagalan baru.
- **CORS untuk komunikasi antar layanan internal.** Klien server-ke-server tidak mengirim `Origin` dan tidak menegakkan CORS. Yang membatasi akses di situ adalah kebijakan jaringan dan autentikasi layanan.
- **CSP yang ketat pada aplikasi lama tanpa jalur migrasi.** Kebijakan yang langsung memblokir akan mematikan fitur yang sedang dipakai. Pakai `Content-Security-Policy-Report-Only` lebih dulu, kumpulkan laporan, baru tegakkan.
- **HSTS preload sebelum yakin.** Masuk ke daftar preload berarti tertanam di browser dan penghapusannya memakan bulan. Pastikan setiap subdomain — termasuk yang belum ada — akan mendukung HTTPS.
- **Security header sebagai pengganti perbaikan XSS.** CSP mengurangi **dampak**, bukan menghapus kerentanannya. Pengodean keluaran yang benar tetap pekerjaan utama.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Bekerja dengan `curl`, gagal di browser | apakah preflight dijawab benar | Preflight gagal; permintaan asli tidak pernah dikirim |
| Izin CORS kadang benar kadang salah | ada tidaknya `Vary: Origin` | Cache menyajikan header CORS milik origin lain |
| Login lintas situs tidak pernah berhasil | `SameSite=None` tanpa `Secure` | Cookie diabaikan browser diam-diam |
| Perubahan kebijakan CORS tidak berlaku | `Access-Control-Max-Age` | Browser masih memakai preflight yang di-cache |
| Laporan CSP membanjir setelah rilis | sumber yang diblokir | Kebijakan lebih ketat daripada yang dipakai aplikasi |
| Subdomain internal tidak bisa diakses | HSTS `includeSubDomains` | Subdomain belum siap HTTPS |

```bash
# Preflight adalah hal pertama yang diperiksa saat browser gagal tapi curl jalan
curl -si -X OPTIONS https://api.contoh.id/v1/pesanan \
  -H 'Origin: https://app.contoh.id' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  | grep -iE '^HTTP|access-control|vary'

# Apakah origin asing dipantulkan? Kalau ya, ini temuan kritis.
curl -si https://api.contoh.id/v1/pesanan -H 'Origin: https://situs-jahat.id' \
  | grep -i 'access-control-allow-origin'

# Kombinasi terlarang: wildcard bersama kredensial
curl -si https://api.contoh.id/v1/pesanan -H 'Origin: https://x.id' \
  | grep -iE 'allow-origin: \*|allow-credentials: true'

# Header keamanan yang benar-benar terpasang
curl -sI https://api.contoh.id/v1/pesanan \
  | grep -iE 'content-security-policy|strict-transport|x-content-type|referrer-policy|permissions-policy'

# CSP yang memuat unsafe-inline praktis tidak melindungi apa pun
curl -sI https://app.contoh.id/ | grep -i 'content-security-policy' | grep -c 'unsafe-inline'

# Atribut cookie sesi
curl -sI https://app.contoh.id/login | grep -i 'set-cookie'

# Laporan pelanggaran CSP -- pasang endpoint report-to lalu pantau ini
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.msg=="csp_violation") | .blocked_uri' | sort | uniq -c | sort -rn | head
```
