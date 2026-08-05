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
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
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
			// Vary WAJIB dipasang pada SETIAP respons — termasuk yang
			// permintaannya TIDAK membawa Origin.
			//
			// Ini urutan yang salah di versi sebelumnya: Vary hanya
			// ditambahkan setelah cabang `origin == ""` keluar lebih dulu.
			// Akibatnya respons dari permintaan tanpa Origin — health check,
			// curl, prefetch CDN, pemanasan cache — tersimpan di CDN TANPA
			// Vary. Permintaan browser berikutnya dengan Origin yang sah
			// menerima respons ter-cache itu, yang tidak memuat
			// Access-Control-Allow-Origin, dan CORS gagal secara acak.
			// Itulah persis gejala "izin CORS kadang benar kadang salah"
			// pada tabel deteksi di bawah.
			w.Header().Add("Vary", "Origin")

			origin := r.Header.Get("Origin")

			// Permintaan tanpa Origin bukan permintaan lintas asal
			// (curl, server-ke-server). Lewatkan tanpa header CORS.
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}

			if _, ok := diizinkan[origin]; !ok {
				// Origin tidak dikenal: JANGAN pantulkan, JANGAN pakai "*".
				if r.Method == http.MethodOptions {
					w.WriteHeader(http.StatusForbidden)
					return
				}
				// Permintaan biasa TETAP diproses — dan itu memang benar
				// menurut CORS: yang dilindungi adalah kemampuan JS MEMBACA
				// respons, bukan terjadinya efek samping. Permintaan POST
				// sederhana dari origin jahat tetap mengeksekusi mutasinya.
				// Yang menghentikan itu adalah CSRF, bukan CORS — dan inilah
				// alasan keduanya harus ada bersama.
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
	// Awalan __Host- membuat cookie menjadi host-only di tingkat browser:
	// Secure wajib, Path harus "/", dan atribut Domain DILARANG. Efeknya
	// subdomain tidak bisa menuliskan cookie ini untuk domain induk.
	namaCookieCSRF = "__Host-csrf_token"
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

// buatTokenCSRF menerbitkan token yang TERIKAT ke satu sesi lewat HMAC.
//
// Double-submit polos — "cocokkan header dengan cookie" — runtuh justru pada
// keadaan yang Kasus Tepi 4 di berkas ini sendiri jelaskan: cookie dibagi
// lintas subdomain. Penyerang yang menguasai satu subdomain (halaman
// pelanggan, dokumentasi yang di-host pihak ketiga, subdomain terbengkalai
// yang bisa diambil alih) dapat MENULIS cookie untuk domain induk. Ia lalu
// tahu persis nilai yang ia tanam, dan bisa mengirim header yang cocok.
//
// Dua penutupnya, dan keduanya diperlukan:
//   - Awalan `__Host-` membuat cookie host-only, sehingga subdomain tidak
//     bisa menuliskannya untuk induk.
//   - Ikatan HMAC ke ID sesi membuat token yang ditanam untuk sesi lain
//     gagal verifikasi, bahkan seandainya penulisan cookie itu berhasil.
//
// Konsekuensi tambahan yang menyelesaikan kontradiksi lain di berkas ini:
// karena verifikasi kini memakai HMAC dan bukan pencocokan dengan cookie,
// nilai cookie-nya tidak perlu ikut terkirim pada permintaan lintas situs.
// Pola lama gagal persis pada skenario `SameSite=None` — satu-satunya
// skenario yang menurut tabel di §Konsep memang MEMBUTUHKAN token CSRF.
func buatTokenCSRF(kunci []byte, idSesi string) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, kunci)
	mac.Write(nonce)
	mac.Write([]byte(idSesi))
	return base64.RawURLEncoding.EncodeToString(nonce) + "." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func periksaTokenCSRF(kunci []byte, idSesi, token string) bool {
	bagian := strings.SplitN(token, ".", 2)
	if len(bagian) != 2 {
		return false
	}
	nonce, err := base64.RawURLEncoding.DecodeString(bagian[0])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, kunci)
	mac.Write(nonce)
	mac.Write([]byte(idSesi))
	mau := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(mau), []byte(bagian[1])) == 1
}

// PasangTokenCSRF menerbitkan token untuk sesi ini.
// Cookie-nya SENGAJA tidak HttpOnly: JS aplikasi harus bisa membacanya untuk
// mengirimkannya kembali sebagai header.
func PasangTokenCSRF(w http.ResponseWriter, kunci []byte, idSesi string) (string, error) {
	tok, err := buatTokenCSRF(kunci, idSesi)
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     namaCookieCSRF,
		Value:    tok,
		Path:     "/", // wajib "/" karena awalan __Host-
		Secure:   true,
		HttpOnly: false, // disengaja: JS aplikasi perlu membacanya
		SameSite: http.SameSiteLaxMode,
	})
	return tok, nil
}

// SumberOtentikasi memberi tahu middleware bagaimana permintaan ini
// SEBENARNYA terautentikasi.
//
// Versi sebelumnya melewatkan pemeriksaan CSRF begitu header `Authorization`
// sekadar ADA — sebuah keputusan keamanan yang diambil dari masukan yang
// tidak pernah divalidasi. Bila aplikasi menerima bearer DAN cookie,
// permintaan dengan bearer sampah plus cookie sesi yang sah akan
// diautentikasi oleh cookie sementara CSRF-nya dilewati. Yang boleh
// menentukan adalah kredensial yang benar-benar dipakai, bukan header yang
// kebetulan terkirim.
type SumberOtentikasi func(*http.Request) (idSesi string, lewatCookie bool)

// CSRF menolak mutasi berbasis cookie yang tokennya tidak sah.
func CSRF(kunci []byte, sumber SumberOtentikasi) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if metodeAman(r.Method) {
				next.ServeHTTP(w, r)
				return
			}
			idSesi, lewatCookie := sumber(r)
			if !lewatCookie {
				// Bukan otentikasi berbasis cookie: browser tidak mengirim
				// kredensialnya secara otomatis, jadi CSRF tidak berlaku.
				next.ServeHTTP(w, r)
				return
			}
			if !periksaTokenCSRF(kunci, idSesi, r.Header.Get(namaHeaderCSRF)) {
				http.Error(w, "invalid CSRF token", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ---------- Security header ----------

// KonfigHeader mengatur header keamanan respons.
type KonfigHeader struct {
	// CSP untuk halaman HTML. Untuk API JSON, gunakan kebijakan yang
	// melarang segalanya -- respons API tidak seharusnya dirender.
	CSP string
	// URIReportCSP mengaktifkan pelaporan pelanggaran. Tanpa ini, tabel
	// deteksi di bawah menanyakan "laporan CSP" yang tidak pernah ada.
	URIReportCSP string
	// HSTSDetik = 0 mematikan HSTS. Nyalakan HANYA setelah yakin
	// seluruh subdomain siap HTTPS: HSTS tidak bisa ditarik cepat.
	HSTSDetik int
	// DiBalikProksiTLS WAJIB true bila TLS diterminasi di ingress/ALB.
	//
	// Pada topologi itu — yang paling umum di Kubernetes — `r.TLS` bernilai
	// nil di dalam pod, dan HSTS TIDAK PERNAH terkirim. Kegagalannya
	// sepenuhnya senyap: konfigurasinya terlihat benar, header-nya hilang.
	DiBalikProksiTLS bool
}

// HeaderAPI memberi kebijakan yang tepat untuk endpoint JSON.
func HeaderAPI() KonfigHeader {
	return KonfigHeader{
		CSP:              "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		HSTSDetik:        31536000,
		DiBalikProksiTLS: true,
	}
}

// lewatHTTPS menentukan apakah respons ini benar-benar berjalan di atas TLS.
//
// X-Forwarded-Proto hanya dipercaya bila kita MEMANG tahu ada proxy di depan.
// Pada topologi tanpa proxy, header itu ditulis klien dan mempercayainya
// berarti klien bisa memaksa kita mengirim HSTS lewat HTTP polos.
func lewatHTTPS(r *http.Request, diBalikProksi bool) bool {
	if r.TLS != nil {
		return true
	}
	return diBalikProksi && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
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
			// Menolak respons ini disematkan lintas asal. Untuk API JSON ini
			// murni keuntungan: ia menutup kelas kebocoran lintas-asal yang
			// tidak tersentuh CORS, termasuk yang memanfaatkan sisi-kanal
			// prosesor lewat konteks yang berbagi memori.
			h.Set("Cross-Origin-Resource-Policy", "same-origin")

			if k.CSP != "" {
				csp := k.CSP
				if k.URIReportCSP != "" {
					csp += "; report-uri " + k.URIReportCSP
				}
				// frame-ancestors di CSP menggantikan X-Frame-Options
				// dan lebih ekspresif.
				h.Set("Content-Security-Policy", csp)
			}
			if k.HSTSDetik > 0 && lewatHTTPS(r, k.DiBalikProksiTLS) {
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
		t.Fatalf("foreign origin MUST NOT be allowed, got %q", got)
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
		t.Fatal("forbidden combination: wildcard + credentials")
	}
	if asal != "https://app.contoh.id" {
		t.Fatalf("allowed origin must be returned exactly, got %q", asal)
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
		t.Fatal("Vary: Origin MUST be present to prevent cache mixing")
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
		t.Fatalf("preflight must be 204, got %d", w.Code)
	}
	if dipanggil {
		t.Fatal("preflight must not be passed to handler")
	}
	if w.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Error("preflight must specify allowed headers")
	}
}

var kunciCSRFUji = []byte("csrf-hmac-test-secret-key-32bytes")

// sumberCookie menirukan lapisan otentikasi yang melaporkan bahwa permintaan
// ini terautentikasi oleh COOKIE untuk sesi tertentu.
func sumberCookie(idSesi string) SumberOtentikasi {
	return func(*http.Request) (string, bool) { return idSesi, true }
}

func TestCSRF_MutasiTanpaTokenDitolak(t *testing.T) {
	h := CSRF(kunciCSRFUji, sumberCookie("sesi-1"))(handlerOK())
	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("cookie-based mutation without CSRF token must be 403, got %d", w.Code)
	}
}

// Uji yang menutup kelemahan double-submit polos: token yang DITANAM
// penyerang lewat subdomain tidak akan terverifikasi, karena ia tidak terikat
// ke sesi korban.
func TestCSRF_TokenSesiLainDitolak(t *testing.T) {
	tokLain, err := buatTokenCSRF(kunciCSRFUji, "sesi-penyerang")
	if err != nil {
		t.Fatal(err)
	}

	h := CSRF(kunciCSRFUji, sumberCookie("sesi-korban"))(handlerOK())
	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r.Header.Set(namaHeaderCSRF, tokLain)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("token from another session accepted (%d) — double-submit without session binding can be planted via subdomain", w.Code)
	}
}

func TestCSRF_TokenSesiSendiriDiterima(t *testing.T) {
	tok, err := buatTokenCSRF(kunciCSRFUji, "sesi-korban")
	if err != nil {
		t.Fatal(err)
	}

	h := CSRF(kunciCSRFUji, sumberCookie("sesi-korban"))(handlerOK())
	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r.Header.Set(namaHeaderCSRF, tok)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("valid token rejected, got %d", w.Code)
	}
}

// Pelewatan CSRF ditentukan oleh kredensial yang BENAR-BENAR dipakai, bukan
// oleh keberadaan header Authorization yang tidak pernah divalidasi.
func TestCSRF_PelewatanBergantungKredensialBukanHeader(t *testing.T) {
	// Lapisan auth melaporkan: permintaan ini terautentikasi oleh BEARER.
	bearer := func(*http.Request) (string, bool) { return "", false }
	h := CSRF(kunciCSRFUji, bearer)(handlerOK())

	r := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("bearer authentication does not require CSRF, got %d", w.Code)
	}

	// Header Authorization sampah + sesi cookie yang sah: CSRF TETAP berlaku.
	// Versi sebelumnya melewatkannya hanya karena header itu ada.
	h2 := CSRF(kunciCSRFUji, sumberCookie("sesi-1"))(handlerOK())
	r2 := httptest.NewRequest(http.MethodPost, "/transfer", nil)
	r2.Header.Set("Authorization", "Bearer invalid_garbage_token")
	w2 := httptest.NewRecorder()
	h2.ServeHTTP(w2, r2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("garbage Authorization header bypassed CSRF on cookie session, got %d", w2.Code)
	}
}

func TestCSRF_MetodeAmanDilewatkan(t *testing.T) {
	h := CSRF(kunciCSRFUji, sumberCookie("sesi-1"))(handlerOK())
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		r := httptest.NewRequest(m, "/data", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Errorf("%s must pass without token, got %d", m, w.Code)
		}
	}
}

func TestCookieCSRFMemakaiAwalanHost(t *testing.T) {
	w := httptest.NewRecorder()
	if _, err := PasangTokenCSRF(w, kunciCSRFUji, "sesi-1"); err != nil {
		t.Fatal(err)
	}
	c := w.Result().Cookies()[0]

	if !strings.HasPrefix(c.Name, "__Host-") {
		t.Fatalf("cookie name %q without __Host- prefix — subdomain can write it for parent domain", c.Name)
	}
	if !c.Secure || c.Path != "/" || c.Domain != "" {
		t.Errorf("__Host- prefix requires Secure, Path=/, and no Domain; got secure=%v path=%q domain=%q",
			c.Secure, c.Path, c.Domain)
	}
	if c.HttpOnly {
		t.Error("CSRF cookie must be readable by JS to be sent back as a header")
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
			t.Errorf("%s: expected %q, got %q", k, v, got)
		}
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Error("frame-ancestors 'none' is mandatory to prevent clickjacking")
	}
}

// HSTS di balik terminator TLS.
//
// Uji versi sebelumnya hanya memeriksa `r.TLS == nil` -> tanpa HSTS, dan
// dengan itu ia MENGUNCI bug yang muncul pada topologi paling umum: ingress
// atau ALB menghentikan TLS lalu meneruskan HTTP polos ke pod, sehingga
// `r.TLS` selalu nil dan HSTS TIDAK PERNAH terkirim — senyap, dengan
// konfigurasi yang terlihat benar.
func TestHeader_HSTSDiBalikProksiTLS(t *testing.T) {
	h := Header(HeaderAPI())(handlerOK())

	r := httptest.NewRequest(http.MethodGet, "/data", nil) // r.TLS == nil
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !strings.Contains(w.Header().Get("Strict-Transport-Security"), "max-age=") {
		t.Fatal("HSTS missing behind TLS terminator — most common topology in Kubernetes")
	}
}

func TestHeader_HSTSTidakDipasangDiHTTPPolos(t *testing.T) {
	k := HeaderAPI()
	k.DiBalikProksiTLS = false // benar-benar tanpa proxy di depan

	h := Header(k)(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil)
	// Klien boleh mengirim header ini sesuka hati; tanpa proxy tepercaya
	// ia TIDAK boleh dipercaya.
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("X-Forwarded-Proto from client trusted without trusted proxy")
	}
}

func TestCORS_VaryAdaMeskiTanpaOrigin(t *testing.T) {
	// Respons tanpa Origin yang ter-cache TANPA Vary akan disajikan ulang
	// kepada browser yang mengirim Origin sah — tanpa header
	// Access-Control-Allow-Origin. Itulah "izin CORS kadang benar kadang
	// salah" pada tabel deteksi.
	h := CORS(CORSDefault("https://app.contoh.id"))(handlerOK())
	r := httptest.NewRequest(http.MethodGet, "/data", nil) // tanpa Origin
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !strings.Contains(w.Header().Get("Vary"), "Origin") {
		t.Fatal("Vary: Origin missing on response without Origin — cache will be mixed")
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
b := make([]byte, 16)
if _, err := rand.Read(b); err != nil {
    http.Error(w, "internal", http.StatusInternalServerError)
    return
}
nonce := base64.RawURLEncoding.EncodeToString(b)
h.Set("Content-Security-Policy", "script-src 'self' 'nonce-"+nonce+"'")
// lalu render: <script nonce="{{.Nonce}}">
```

Nonce WAJIB dibangkitkan ulang **per permintaan** dan dari `crypto/rand`. Nonce yang dipakai ulang antar-permintaan sama tidak bergunanya dengan `unsafe-inline`: penyerang yang pernah melihat satu halaman sudah tahu nilai yang harus ia sisipkan.

**❌ SALAH — pelewatan CSRF berdasarkan keberadaan header `Authorization`**

```go
if r.Header.Get("Authorization") != "" {
    next.ServeHTTP(w, r) // CSRF dilewati
    return
}
```

Alasannya benar — browser tidak mengirim `Authorization` otomatis — tetapi keputusannya diambil dari masukan yang **tidak pernah divalidasi**. Pada aplikasi yang menerima bearer *dan* cookie, permintaan dengan bearer sampah plus cookie sesi yang sah akan diautentikasi oleh cookie sementara CSRF-nya dilewati.

**✅ BENAR — yang menentukan adalah kredensial yang benar-benar dipakai**

```go
idSesi, lewatCookie := sumberOtentikasi(r)
if !lewatCookie { /* CSRF tidak berlaku */ }
```

**❌ SALAH — double-submit polos di domain yang punya subdomain**

```go
// bandingkan header dengan cookie, tanpa ikatan apa pun ke sesi
subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header))
```

Cookie dibagi lintas subdomain (lihat Kasus Tepi 4). Penyerang yang menguasai satu subdomain — halaman pelanggan, dokumentasi yang di-host pihak ketiga, subdomain terbengkalai yang bisa diambil alih — dapat **menulis** cookie untuk domain induk, lalu mengirim header yang cocok dengan nilai yang ia tanam sendiri.

**✅ BENAR — `__Host-` plus token yang terikat sesi lewat HMAC**

```go
tok, _ := buatTokenCSRF(kunci, idSesi) // nonce . HMAC(nonce||idSesi)
```

## Kasus Tepi Produksi

1. **Preflight yang gagal tidak muncul di log server Anda.** Browser membatalkan permintaan aslinya, dan galatnya hanya tampak di konsol browser. Dari sisi server, permintaan itu **tidak pernah ada** — ini penyebab paling umum "bekerja dengan curl, gagal di browser".

2. **`Access-Control-Max-Age` yang terlalu panjang mengunci kesalahan.** Browser meng-cache hasil preflight; perubahan kebijakan CORS tidak berlaku sampai cache kedaluwarsa. Beberapa menit wajar saat produksi stabil; kecilkan saat sedang mengubah konfigurasi.

3. **HSTS sulit ditarik.** `max-age` satu tahun dengan `includeSubDomains` berarti browser menolak HTTP untuk seluruh subdomain selama setahun — termasuk subdomain internal yang belum siap TLS. Naikkan `max-age` bertahap, dan pastikan setiap subdomain siap sebelum `includeSubDomains`.

4. **Cookie dibagi lintas subdomain — dan arah yang lebih sering luput.** Cookie yang disetel untuk `.contoh.id` terkirim ke `apa-pun.contoh.id`; itu arah yang biasa disadari orang. Arah sebaliknya lebih berbahaya: **subdomain dapat MENULIS cookie untuk domain induk.** Subdomain yang bisa dikendalikan pihak lain — halaman pelanggan, dokumentasi yang di-host pihak ketiga, subdomain terbengkalai yang bisa diambil alih — karena itu dapat menanam cookie apa pun ke aplikasi utama Anda, termasuk **token CSRF yang nilainya ia ketahui sendiri**. Di situlah pola double-submit polos runtuh. Penutupnya dua lapis: awalan `__Host-` (cookie jadi host-only, subdomain tidak bisa menuliskannya untuk induk) dan token yang **terikat ke sesi** lewat HMAC, sehingga token milik sesi lain gagal verifikasi bagaimanapun ia sampai ke sana.

4b. **HSTS di balik terminator TLS.** Bila TLS dihentikan di ingress atau load balancer — topologi paling umum di Kubernetes — `r.TLS` bernilai **nil** di dalam pod, dan kondisi `if r.TLS != nil` membuat HSTS **tidak pernah terkirim**. Kegagalannya sepenuhnya senyap: konfigurasi terlihat benar, header hilang, dan tidak ada yang mengeluh sampai seseorang memeriksa `curl -I`. Percayai `X-Forwarded-Proto` — tetapi HANYA bila Anda memang tahu ada proxy tepercaya di depan; tanpa proxy, header itu ditulis klien dan mempercayainya berarti klien bisa memaksa Anda mengirim HSTS lewat HTTP polos.

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
| HSTS tidak muncul padahal dikonfigurasi | `r.TLS` di balik terminator TLS | TLS dihentikan di ingress; `r.TLS` nil di dalam pod |
| CSRF lolos pada sebagian permintaan | dasar pelewatan CSRF | Diputuskan dari header yang tidak divalidasi |
| Token CSRF sah tapi bukan milik pengguna itu | ikatan token ke sesi | Double-submit tanpa HMAC; subdomain menanam cookie |

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
