# OAuth2 & OIDC: Alur Authorization Code + PKCE di Go

> **Berlaku:** Go 1.21+ · `golang.org/x/oauth2` · `coreos/go-oidc/v3` · RFC 6749/7636/9700 · **Lihat juga:** `security_owasp/jwt_dual_token_auth.md` · `security_owasp/web_security_headers.md` · `security_owasp/casbin_rbac_abac.md` · `security_owasp/mtls_certificate_rotation.md`

## Konsep Utama

OAuth2 adalah protokol **otorisasi delegasi** — ia menjawab "boleh apa aplikasi ini atas nama pengguna". OIDC adalah lapisan tipis di atasnya yang menjawab "**siapa** penggunanya", lewat satu artefak tambahan: **ID token**.

Membedakan keduanya menentukan token mana yang boleh dipercaya untuk apa:

| Token | Untuk apa | Siapa yang memvalidasi | Kesalahan umum |
| :--- | :--- | :--- | :--- |
| **ID token** (JWT, OIDC) | Membuktikan **identitas** ke aplikasi Anda | Aplikasi Anda | Dikirim sebagai bearer ke API — salah |
| **Access token** | Memanggil **API** atas nama pengguna | Resource server | Isinya di-parse padahal formatnya opaque |
| **Refresh token** | Menukar dengan access token baru | Server otorisasi | Disimpan di klien publik tanpa rotasi |

Kesalahan yang paling sering: memakai **ID token sebagai access token**. ID token ditujukan untuk aplikasi Anda (`aud` = client ID Anda); mengirimkannya ke API lain berarti API itu menerima token yang bukan untuknya.

### Hanya satu alur yang layak dipakai sekarang

Best practice OAuth 2.0 saat ini (RFC 9700) menyempitkan pilihan secara tegas:

| Alur | Status |
| :--- | :--- |
| **Authorization code + PKCE** | ✅ Untuk semua klien — web, mobile, SPA |
| Client credentials | ✅ Untuk komunikasi mesin-ke-mesin |
| Implicit (`response_type=token`) | ❌ Ditinggalkan — token bocor lewat URL dan riwayat browser |
| Resource owner password | ❌ Ditinggalkan — aplikasi memegang kata sandi pengguna |

**PKCE bukan hanya untuk mobile.** RFC 9700 mewajibkannya untuk klien rahasia juga: ia menutup penyerobotan authorization code yang tidak bisa dicegah client secret.

### Tiga pemeriksaan yang tidak boleh dilewati

1. **`state`** — mengikat permintaan ke sesi browser; tanpanya, CSRF pada alur login.
2. **`nonce`** — mengikat ID token ke permintaan otentikasi; tanpanya, ID token lama bisa diputar ulang.
3. **Verifikasi ID token**: tanda tangan lewat JWKS, `iss`, `aud`, `exp`, dan `nonce`. Melewatkan `aud` berarti menerima token yang diterbitkan untuk aplikasi lain oleh IdP yang sama.

## Diagram ASCII

```text
   AUTHORIZATION CODE + PKCE -- alur yang benar

   Browser              Aplikasi Anda                IdP
      |                       |                       |
      |-- GET /login -------->|                       |
      |                       | buat: state, nonce,
      |                       |       verifier acak
      |                       | challenge = S256(verifier)
      |                       | simpan {state,nonce,verifier} di sesi
      |<-- 302 ke IdB --------|                       |
      |    ?state&nonce&code_challenge&method=S256    |
      |----------------------------------------------->|
      |                                                | pengguna login
      |<-- 302 balik: ?code=xyz&state=abc -------------|
      |-- GET /callback?code&state -->|               |
      |                       | 1. state cocok sesi?  <- CSRF
      |                       | 2. tukar code + VERIFIER
      |                       |---------------------->|
      |                       |                       | challenge cocok?
      |                       |<-- id_token,access,refresh
      |                       | 3. verifikasi id_token:
      |                       |    tanda tangan (JWKS)
      |                       |    iss / aud / exp
      |                       |    nonce cocok sesi?  <- replay
      |<-- cookie sesi -------|                       |
          HttpOnly Secure SameSite

   ---------------------------------------------------------------

   KENAPA PKCE MENUTUP CELAH YANG CLIENT SECRET TIDAK BISA

   Tanpa PKCE: penyerang yang menyerobot `code` di redirect
               bisa menukarnya -> dapat token.

   Dengan PKCE: penukaran menuntut `verifier` yang HANYA ada di
               memori aplikasi yang memulai alur. Code yang
               diserobot menjadi tidak berguna.

   ---------------------------------------------------------------

   TOKEN MANA UNTUK APA

   ID token  --> aplikasi Anda    "siapa pengguna ini"     JANGAN kirim ke API
   Access    --> API              "boleh apa"              JANGAN di-parse isinya
   Refresh   --> server otorisasi "beri access baru"       JANGAN di localStorage
```

## Kode Go Production-Ready

```go
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Galat yang dibedakan pemanggil.
var (
	ErrStateTidakCocok         = errors.New("auth: state tidak cocok dengan sesi")
	ErrNonceTidakCocok         = errors.New("auth: nonce tidak cocok dengan sesi")
	ErrTanpaIDToken            = errors.New("auth: respons tanpa id_token")
	ErrAlurTidakDikenal        = errors.New("auth: keadaan alur tidak ditemukan atau sudah dipakai")
	ErrAlurKedaluwarsa         = errors.New("auth: keadaan alur kedaluwarsa")
	ErrEmailBelumTerverifikasi = errors.New("auth: email belum diverifikasi IdP")
)

// maksUmurAlur membatasi jarak antara pengalihan ke IdP dan callback.
const maksUmurAlur = 10 * time.Minute

// Konfig menampung apa yang dibutuhkan alur.
type Konfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string // kosong untuk klien publik (SPA/mobile)
	RedirectURL  string
	Scope        []string
}

// KeadaanAlur adalah yang WAJIB disimpan di sesi sisi server antara
// pengalihan ke IdP dan callback.
type KeadaanAlur struct {
	State    string
	Nonce    string
	Verifier string
	Dibuat   time.Time
}

// PenyimpanAlur menyimpan keadaan alur di antara dua permintaan.
//
// AmbilSekali sengaja mengambil DAN menghapus dalam satu operasi. Kasus Tepi 3
// menuntut keadaan alur berumur pendek dan SEKALI PAKAI — tetapi versi
// sebelumnya menyimpan field `Dibuat` lalu tidak pernah membacanya, dan tidak
// punya mekanisme apa pun untuk mencegah pemakaian kedua. Field yang ada
// tetapi tidak pernah diperiksa lebih buruk daripada tidak ada sama sekali:
// ia membuat aturannya tampak sudah diterapkan.
type PenyimpanAlur interface {
	Simpan(ctx context.Context, k KeadaanAlur) error
	AmbilSekali(ctx context.Context, state string) (KeadaanAlur, error)
}

// Klien membungkus verifier OIDC dan konfigurasi OAuth2.
type Klien struct {
	penyedia    *oidc.Provider
	verifier    *oidc.IDTokenVerifier
	oauth       oauth2.Config
	epRevocation string
	epEndSession string
}

// Baru menemukan konfigurasi IdP lewat discovery dan menyiapkan verifier.
//
// Discovery dilakukan SEKALI saat start. Kunci publik (JWKS) di-cache dan
// diperbarui otomatis oleh go-oidc, sehingga rotasi kunci IdP tidak
// memerlukan restart.
func Baru(ctx context.Context, k Konfig) (*Klien, error) {
	p, err := oidc.NewProvider(ctx, k.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("discovery OIDC %q: %w", k.IssuerURL, err)
	}
	scope := k.Scope
	if len(scope) == 0 {
		scope = []string{oidc.ScopeOpenID, "profile", "email"}
	}

	// Discovery memuat lebih dari sekadar endpoint auth/token. Endpoint
	// pencabutan dan RP-initiated logout dibaca di sini, karena Kasus Tepi 5
	// menuntut keduanya — dan versi sebelumnya berhenti pada pernyataan bahwa
	// keduanya dibutuhkan, tanpa jalan untuk memanggilnya.
	var ekstra struct {
		RevocationEndpoint string `json:"revocation_endpoint"`
		EndSessionEndpoint string `json:"end_session_endpoint"`
	}
	// Tidak semua IdP menyediakannya; ketiadaannya bukan galat fatal.
	_ = p.Claims(&ekstra)

	return &Klien{
		penyedia: p,
		// Verifier memeriksa tanda tangan, issuer, audience, dan exp.
		verifier: p.Verifier(&oidc.Config{ClientID: k.ClientID}),
		oauth: oauth2.Config{
			ClientID:     k.ClientID,
			ClientSecret: k.ClientSecret,
			RedirectURL:  k.RedirectURL,
			Endpoint:     p.Endpoint(),
			Scopes:       scope,
		},
		epRevocation: ekstra.RevocationEndpoint,
		epEndSession: ekstra.EndSessionEndpoint,
	}, nil
}

// MulaiAlur menghasilkan URL otorisasi dan MENYIMPAN keadaan alur.
//
// Penyimpanan dilakukan di sini, bukan diserahkan ke pemanggil: keadaan yang
// lupa disimpan menghasilkan callback yang selalu gagal, dan keadaan yang
// disimpan di tempat yang salah menghasilkan hal yang lebih buruk.
func (c *Klien) MulaiAlur(ctx context.Context, simpan PenyimpanAlur) (urlOtorisasi string, err error) {
	state, err := acak32()
	if err != nil {
		return "", fmt.Errorf("buat state: %w", err)
	}
	nonce, err := acak32()
	if err != nil {
		return "", fmt.Errorf("buat nonce: %w", err)
	}
	// oauth2.GenerateVerifier tersedia sejak x/oauth2 v0.15 dan menghasilkan
	// verifier yang sudah sesuai RFC 7636 (43–128 karakter, himpunan
	// unreserved). Merakit sendiri dengan sha256 + base64 tetap benar, tetapi
	// menambah satu tempat yang bisa salah tanpa manfaat apa pun.
	verifier := oauth2.GenerateVerifier()

	k := KeadaanAlur{State: state, Nonce: nonce, Verifier: verifier, Dibuat: time.Now()}
	if err := simpan.Simpan(ctx, k); err != nil {
		return "", fmt.Errorf("simpan keadaan alur: %w", err)
	}

	// S256ChallengeOption mengirim HASH verifier, bukan verifier-nya.
	return c.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	), nil
}

// Identitas adalah hasil login yang sudah terverifikasi.
type Identitas struct {
	Subjek        string
	Email         string
	EmailTerverif bool
	Nama          string
	AccessToken   string
	RefreshToken  string
	Kedaluwarsa   time.Time
}

// SelesaikanAlur menukar authorization code menjadi token, lalu memverifikasi
// ID token secara penuh.
//
// URUTAN PEMERIKSAAN PENTING: state diperiksa SEBELUM penukaran, agar
// permintaan CSRF tidak pernah sampai menghubungi IdP.
func (c *Klien) SelesaikanAlur(ctx context.Context, simpan PenyimpanAlur, stateDariURL, code string) (*Identitas, error) {
	if stateDariURL == "" {
		return nil, ErrStateTidakCocok
	}

	// 1. CSRF + sekali pakai. Pencarian berkunci-state MENGGANTIKAN
	// perbandingan `stateDariURL != k.State`: state yang tidak dikenal tidak
	// akan menemukan apa pun, dan AmbilSekali menghapusnya sehingga percobaan
	// kedua dengan state yang sama pasti gagal.
	k, err := simpan.AmbilSekali(ctx, stateDariURL)
	if err != nil {
		return nil, ErrAlurTidakDikenal
	}

	// 2. Umur alur. Kasus Tepi 3: keadaan yang tersimpan selamanya berarti
	// authorization code lama masih bisa ditukar.
	if time.Since(k.Dibuat) > maksUmurAlur {
		return nil, ErrAlurKedaluwarsa
	}

	// 3. Tukar code + verifier PKCE. IdP memeriksa S256(verifier) == challenge.
	tok, err := c.oauth.Exchange(ctx, code, oauth2.VerifierOption(k.Verifier))
	if err != nil {
		return nil, fmt.Errorf("tukar authorization code: %w", err)
	}

	mentah, ok := tok.Extra("id_token").(string)
	if !ok || mentah == "" {
		return nil, ErrTanpaIDToken
	}

	// 4. Verifikasi tanda tangan (JWKS), iss, aud, dan exp.
	idToken, err := c.verifier.Verify(ctx, mentah)
	if err != nil {
		return nil, fmt.Errorf("verifikasi id_token: %w", err)
	}

	// 5. Replay: nonce di dalam token WAJIB cocok dengan yang disimpan sesi.
	//
	// Dibandingkan konstan-waktu. Nonce adalah rahasia sesi yang nilainya
	// datang dari luar dan dibandingkan penuh — persis bentuk yang di
	// `microservices_grpc/grpc_interceptors_middleware.md` sudah dikoreksi
	// menjadi subtle.ConstantTimeCompare untuk token bearer.
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(k.Nonce)) != 1 {
		return nil, ErrNonceTidakCocok
	}

	var klaim struct {
		Email         string `json:"email"`
		EmailTerverif bool   `json:"email_verified"`
		Nama          string `json:"name"`
	}
	if err := idToken.Claims(&klaim); err != nil {
		return nil, fmt.Errorf("baca klaim: %w", err)
	}

	return &Identitas{
		Subjek:        idToken.Subject, // stabil; JANGAN pakai email sebagai kunci
		Email:         klaim.Email,
		EmailTerverif: klaim.EmailTerverif,
		Nama:          klaim.Nama,
		AccessToken:   tok.AccessToken,
		RefreshToken:  tok.RefreshToken,
		Kedaluwarsa:   tok.Expiry,
	}, nil
}

// BolehTautkanLewatEmail menjawab satu pertanyaan yang salah dijawab akan
// menjadi pengambilalihan akun.
//
// Ini kelas kerentanan paling umum pada integrasi "Sign in with ...": bila
// akun lokal dicocokkan lewat EMAIL sementara IdP tidak memverifikasi email,
// penyerang cukup mendaftar di IdP itu memakai alamat korban lalu masuk
// sebagai korban. Versi sebelumnya membaca klaim `email_verified` lalu
// menyimpannya tanpa pernah memakainya — dan klaim yang dibaca tanpa dipakai
// tidak melindungi apa pun.
//
// Kunci identitas SELALU `sub`. Email hanya boleh dipakai untuk MENAUTKAN
// akun lama bila terverifikasi DAN IdP-nya memang Anda percayai.
func (i *Identitas) BolehTautkanLewatEmail() error {
	if !i.EmailTerverif || i.Email == "" {
		return ErrEmailBelumTerverifikasi
	}
	return nil
}

// PasangCookieSesi menulis cookie sesi. Nilainya ID sesi sisi server, BUKAN token.
//
// Awalan `__Host-` menegakkan Secure, Path=/, dan TANPA atribut Domain di
// tingkat browser. Efeknya: subdomain — termasuk yang jatuh ke tangan
// penyerang lewat subdomain takeover — tidak bisa menuliskan cookie ini.
func PasangCookieSesi(w http.ResponseWriter, idSesi string, umur time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     "__Host-sesi",
		Value:    idSesi,
		Path:     "/",
		MaxAge:   int(umur.Seconds()),
		HttpOnly: true, // tidak terbaca JavaScript -> XSS tidak mencuri sesi
		Secure:   true, // hanya lewat HTTPS
		// Strict, bukan Lax. Cookie SESI tidak perlu ikut terkirim pada
		// navigasi lintas situs mana pun — ia baru DITULIS setelah callback
		// selesai, jadi ia tidak pernah dibaca saat kembali dari IdP.
		SameSite: http.SameSiteStrictMode,
	})
}

// PasangCookieAlur menulis cookie pembawa keadaan alur.
//
// INILAH cookie yang butuh Lax — bukan cookie sesi. Versi sebelumnya menaruh
// alasan "agar redirect balik dari IdP tetap membawa cookie" pada cookie
// sesi, padahal cookie sesi baru ditulis SESUDAH callback; yang dibaca saat
// browser kembali dari IdP adalah cookie alur ini.
//
// Dan satu jebakan yang membuat alur gagal dengan pesan menyesatkan:
// `SameSite=Lax` mengirim cookie pada navigasi GET tingkat atas, tetapi TIDAK
// pada POST lintas situs. Bila IdP dikonfigurasi `response_mode=form_post`,
// callback-nya adalah POST — cookie Lax tidak ikut terkirim, dan galat yang
// muncul berbunyi "state tidak ditemukan", yang menuntun orang mencari bug di
// tempat yang sama sekali salah.
func PasangCookieAlur(w http.ResponseWriter, nilai string, responsFormPost bool) {
	sameSite := http.SameSiteLaxMode
	if responsFormPost {
		sameSite = http.SameSiteNoneMode // wajib berpasangan dengan Secure
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "__Host-alur",
		Value:    nilai,
		Path:     "/",
		MaxAge:   int(maksUmurAlur.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: sameSite,
	})
}

// Cabut memanggil endpoint revocation IdP (RFC 7009).
//
// Kasus Tepi 5 menyatakan menghapus cookie sesi TIDAK mencabut access token
// yang sudah diterbitkan — dan versi sebelumnya berhenti pada pernyataan itu
// tanpa memberi jalan melakukannya.
func (c *Klien) Cabut(ctx context.Context, token, tipe string) error {
	if c.epRevocation == "" {
		return errors.New("IdP tidak menyediakan revocation_endpoint")
	}
	form := url.Values{"token": {token}, "token_type_hint": {tipe}}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.epRevocation,
		strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("bangun permintaan pencabutan: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(c.oauth.ClientID, c.oauth.ClientSecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("panggil pencabutan: %w", err)
	}
	defer resp.Body.Close()
	// RFC 7009: server mengembalikan 200 bahkan untuk token yang tidak
	// dikenal, supaya tidak menjadi oracle keberadaan token.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pencabutan ditolak: %d", resp.StatusCode)
	}
	return nil
}

func acak32() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
```

## Uji

```go
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// konfigUjiOAuth dipakai empat uji di versi sebelumnya dan TIDAK PERNAH
// didefinisikan — blok ujinya tidak kompilasi sama sekali.
func konfigUjiOAuth() oauth2.Config {
	return oauth2.Config{
		ClientID:    "klien-uji",
		RedirectURL: "https://app.contoh.id/callback",
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://idp.contoh.id/authorize",
			TokenURL: "https://idp.contoh.id/token",
		},
		Scopes: []string{"openid", "email"},
	}
}

type penyimpanMemori struct {
	mu    sync.Mutex
	entri map[string]KeadaanAlur
}

func newPenyimpanMemori() *penyimpanMemori {
	return &penyimpanMemori{entri: map[string]KeadaanAlur{}}
}

func (p *penyimpanMemori) Simpan(_ context.Context, k KeadaanAlur) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.entri[k.State] = k
	return nil
}

func (p *penyimpanMemori) AmbilSekali(_ context.Context, state string) (KeadaanAlur, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	k, ada := p.entri[state]
	if !ada {
		return KeadaanAlur{}, errors.New("tidak ditemukan")
	}
	delete(p.entri, state) // sekali pakai
	return k, nil
}

func TestSelesaikanAlur_StateSalahDitolakSebelumMenghubungiIdP(t *testing.T) {
	// Permintaan CSRF tidak boleh sampai memicu panggilan jaringan ke IdP.
	// Klien tanpa endpoint asli sudah cukup membuktikannya: kalau Exchange
	// sempat dipanggil, galat yang muncul bukan ErrAlurTidakDikenal.
	c := &Klien{}
	simpan := newPenyimpanMemori()
	_ = simpan.Simpan(context.Background(), KeadaanAlur{State: "state-benar", Dibuat: time.Now()})

	_, err := c.SelesaikanAlur(context.Background(), simpan, "state-penyerang", "code")
	if !errors.Is(err, ErrAlurTidakDikenal) {
		t.Fatalf("mau ErrAlurTidakDikenal, dapat %v", err)
	}
}

func TestSelesaikanAlur_StateKosongDitolak(t *testing.T) {
	c := &Klien{}
	_, err := c.SelesaikanAlur(context.Background(), newPenyimpanMemori(), "", "code")
	if !errors.Is(err, ErrStateTidakCocok) {
		t.Fatalf("state kosong WAJIB ditolak, dapat %v", err)
	}
}

// Keadaan alur hanya boleh dipakai SEKALI. Tanpa ini, authorization code yang
// diserobot bisa ditukar berulang selama keadaannya masih tersimpan.
func TestSelesaikanAlur_KeadaanSekaliPakai(t *testing.T) {
	c := &Klien{}
	simpan := newPenyimpanMemori()
	_ = simpan.Simpan(context.Background(), KeadaanAlur{State: "s1", Dibuat: time.Now()})

	// Percobaan pertama gagal di Exchange (klien kosong), tapi keadaannya
	// SUDAH terpakai dan terhapus.
	_, _ = c.SelesaikanAlur(context.Background(), simpan, "s1", "code")

	_, err := c.SelesaikanAlur(context.Background(), simpan, "s1", "code")
	if !errors.Is(err, ErrAlurTidakDikenal) {
		t.Fatalf("pemakaian kedua = %v, mau ErrAlurTidakDikenal", err)
	}
}

// Field Dibuat harus benar-benar DIPERIKSA. Versi sebelumnya menyimpannya
// lalu tidak pernah membacanya.
func TestSelesaikanAlur_KeadaanKedaluwarsaDitolak(t *testing.T) {
	c := &Klien{}
	simpan := newPenyimpanMemori()
	_ = simpan.Simpan(context.Background(), KeadaanAlur{
		State:  "s-lama",
		Dibuat: time.Now().Add(-maksUmurAlur - time.Minute),
	})

	_, err := c.SelesaikanAlur(context.Background(), simpan, "s-lama", "code")
	if !errors.Is(err, ErrAlurKedaluwarsa) {
		t.Fatalf("galat = %v, mau ErrAlurKedaluwarsa", err)
	}
}

func TestMulaiAlur_NilaiAcakBerbedaDanS256(t *testing.T) {
	c := &Klien{oauth: konfigUjiOAuth()}
	simpan := newPenyimpanMemori()
	ctx := context.Background()

	u1, err := c.MulaiAlur(ctx, simpan)
	if err != nil {
		t.Fatal(err)
	}
	u2, err := c.MulaiAlur(ctx, simpan)
	if err != nil {
		t.Fatal(err)
	}

	q1 := uraiKueri(t, u1)
	q2 := uraiKueri(t, u2)
	for _, p := range []string{"state", "nonce", "code_challenge"} {
		if q1.Get(p) == q2.Get(p) {
			t.Errorf("%s WAJIB berbeda tiap alur", p)
		}
		if q1.Get(p) == "" {
			t.Errorf("%s tidak dikirim", p)
		}
	}
	if q1.Get("code_challenge_method") != "S256" {
		t.Fatal("metode PKCE WAJIB S256; 'plain' tidak memberi perlindungan")
	}

	// Yang dikirim WAJIB hash verifier, bukan verifier-nya.
	simpan.mu.Lock()
	k := simpan.entri[q1.Get("state")]
	simpan.mu.Unlock()

	sum := sha256.Sum256([]byte(k.Verifier))
	if mau := base64.RawURLEncoding.EncodeToString(sum[:]); q1.Get("code_challenge") != mau {
		t.Fatal("challenge harus S256(verifier)")
	}
	if strings.Contains(u1, k.Verifier) {
		t.Fatal("verifier BOCOR ke URL otorisasi")
	}
	if len(k.Verifier) < 43 {
		t.Errorf("verifier PKCE minimal 43 karakter, dapat %d", len(k.Verifier))
	}
}

func TestCookieSesiDanCookieAlurPunyaSameSiteBerbeda(t *testing.T) {
	w := httptest.NewRecorder()
	PasangCookieSesi(w, "sesi-123", time.Hour)
	PasangCookieAlur(w, "alur-abc", false)
	PasangCookieAlur(w, "alur-post", true)

	kue := map[string]*http.Cookie{}
	for _, c := range w.Result().Cookies() {
		kue[c.Name] = c
	}

	sesi := kue["__Host-sesi"]
	if sesi == nil {
		t.Fatal("cookie sesi tidak memakai awalan __Host-")
	}
	if !sesi.HttpOnly || !sesi.Secure {
		t.Error("HttpOnly dan Secure wajib pada cookie sesi")
	}
	// Cookie sesi TIDAK perlu Lax: ia ditulis setelah callback, tidak pernah
	// dibaca saat browser kembali dari IdP.
	if sesi.SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite cookie sesi = %v, mau Strict", sesi.SameSite)
	}
	if strings.Count(sesi.Value, ".") == 2 {
		t.Error("nilai cookie berbentuk JWT — seharusnya ID sesi sisi server")
	}

	alur := kue["__Host-alur"]
	if alur == nil {
		t.Fatal("cookie alur tidak ditulis")
	}
	// Cookie terakhir dengan nama sama menang di map: itu varian form_post.
	if alur.SameSite != http.SameSiteNoneMode {
		t.Errorf("SameSite cookie alur (form_post) = %v, mau None — Lax tidak terkirim pada POST lintas situs", alur.SameSite)
	}
}

func TestBolehTautkanLewatEmail(t *testing.T) {
	belum := &Identitas{Email: "korban@contoh.id", EmailTerverif: false}
	if err := belum.BolehTautkanLewatEmail(); !errors.Is(err, ErrEmailBelumTerverifikasi) {
		t.Fatalf("galat = %v, mau ErrEmailBelumTerverifikasi — penautan lewat email tak terverifikasi adalah pengambilalihan akun", err)
	}
	sudah := &Identitas{Email: "asli@contoh.id", EmailTerverif: true}
	if err := sudah.BolehTautkanLewatEmail(); err != nil {
		t.Fatalf("email terverifikasi ditolak: %v", err)
	}
}

func uraiKueri(t *testing.T, u string) url.Values {
	t.Helper()
	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("urai URL: %v", err)
	}
	return parsed.Query()
}
```

## Anti-Pattern

**❌ SALAH — memakai ID token sebagai bearer ke API**

```go
// idToken di sini adalah string mentah hasil tok.Extra("id_token")
req.Header.Set("Authorization", "Bearer "+idToken)
```

ID token diterbitkan **untuk aplikasi Anda** (`aud` = client ID Anda). API yang menerimanya sedang memvalidasi token yang bukan ditujukan kepadanya — dan bila ia mengabaikan `aud`, ia akan menerima token dari aplikasi mana pun di tenant IdP yang sama.

**✅ BENAR — access token untuk API, ID token hanya untuk membangun sesi**

```go
req.Header.Set("Authorization", "Bearer "+identitas.AccessToken)
```

> Perhatikan `Identitas` di §Kode **tidak punya** field ID token, dan itu disengaja: ID token sudah selesai tugasnya begitu identitas terverifikasi, jadi tidak menyimpannya membuat kesalahan di atas sulit dilakukan. (Versi sebelumnya menulis `identitas.IDToken` pada potongan ini — field yang tidak pernah ada, sehingga contohnya bahkan tidak kompilasi.)

**❌ SALAH — menautkan akun lokal lewat email tanpa memeriksa `email_verified`**

```go
pengguna, _ := repo.CariByEmail(ctx, klaim.Email) // IdP memverifikasinya?
```

Ini kelas pengambilalihan akun yang paling sering muncul pada integrasi "Sign in with ...". Bila IdP tidak memverifikasi kepemilikan email, penyerang cukup mendaftar di IdP itu memakai alamat korban, lalu masuk sebagai korban ke aplikasi Anda. Membaca klaim `email_verified` dan menyimpannya tanpa pernah memeriksanya tidak melindungi apa pun.

**✅ BENAR — `sub` sebagai kunci; email hanya untuk penautan, dan hanya bila terverifikasi**

```go
if err := identitas.BolehTautkanLewatEmail(); err != nil {
    return err // jangan tautkan; minta verifikasi lewat jalur Anda sendiri
}
```

**❌ SALAH — memverifikasi ID token tanpa memeriksa `aud`**

```go
tok, _ := jwt.Parse(mentah, kunci)   // tanda tangan valid... untuk siapa?
```

Tanda tangan yang sah hanya membuktikan IdP menerbitkannya. Tanpa `aud`, token yang diterbitkan untuk aplikasi lain di tenant yang sama akan diterima.

**✅ BENAR — verifier yang memeriksa iss, aud, exp, sekaligus tanda tangan**

```go
verifier := penyedia.Verifier(&oidc.Config{ClientID: clientID})
idToken, err := verifier.Verify(ctx, mentah) // gagal bila aud tidak cocok
```

**❌ SALAH — `state` yang dapat ditebak, atau tidak diperiksa**

```go
u := konf.AuthCodeURL("login") // konstan
// callback:
tok, _ := konf.Exchange(ctx, r.URL.Query().Get("code")) // state tidak dilihat
```

Ini CSRF pada alur login: penyerang bisa menautkan akun mereka ke sesi korban.

**✅ BENAR — acak per alur, disimpan di sesi, diperiksa sebelum penukaran**

Lihat `MulaiAlur`/`SelesaikanAlur` di atas: `state` dari `crypto/rand` dan diperiksa **sebelum** `Exchange` dipanggil.

**❌ SALAH — menyimpan token di `localStorage`**

```js
localStorage.setItem('access_token', token)
```

Satu XSS menjadi pengambilalihan akun penuh, dan token bertahan setelah tab ditutup.

**✅ BENAR — sesi sisi server, cookie hanya membawa ID sesi**

```go
PasangCookieSesi(w, idSesi, 8*time.Hour) // HttpOnly + Secure + SameSite
```

**❌ SALAH — memakai email sebagai kunci identitas pengguna**

```go
pengguna, _ := repo.CariByEmail(ctx, klaim.Email)
```

Email bisa berubah, bisa dipakai ulang setelah akun dihapus di IdP, dan pada sebagian IdP tidak dijamin unik maupun terverifikasi.

**✅ BENAR — `sub` sebagai kunci, email sebagai atribut**

```go
pengguna, _ := repo.CariBySubjekIdP(ctx, idToken.Subject)
```

## Kasus Tepi Produksi

1. **Rotasi kunci IdP.** IdP mengganti kunci penandatanganan secara berkala. Verifikasi yang menyematkan kunci statis akan gagal serentak saat rotasi. `go-oidc` mengambil JWKS dan memperbaruinya otomatis — jangan menggantinya dengan kunci hardcode.

2. **Clock skew antara Anda dan IdP.** Token dengan `iat` sedikit di masa depan akan ditolak bila jam server Anda tertinggal. Beberapa detik toleransi wajar; pastikan NTP berjalan di semua node.

3. **`state` yang tidak kedaluwarsa dan tidak sekali pakai.** Keadaan alur yang tersimpan selamanya berarti authorization code lama masih bisa ditukar. Dua hal yang harus benar-benar dieksekusi, bukan sekadar disimpan sebagai field: **masa hidup pendek** yang diperiksa saat callback (lihat `maksUmurAlur`), dan **pengambilan yang sekaligus menghapus** (`AmbilSekali`), sehingga percobaan kedua dengan state yang sama pasti gagal. Menyimpan `Dibuat` lalu tidak pernah membacanya justru lebih berbahaya daripada tidak menyimpannya: ia membuat aturannya tampak sudah diterapkan.

3b. **`SameSite` cookie alur — dan `form_post` yang mematahkannya.** Cookie yang membawa `state`/`nonce`/`verifier` DIBACA saat browser kembali dari IdP, jadi ia butuh `SameSite=Lax`; cookie sesi baru DITULIS setelah callback selesai dan boleh `Strict`. Jebakannya: `Lax` mengirim cookie pada navigasi **GET** tingkat atas, tetapi **tidak** pada **POST** lintas situs. Bila IdP dikonfigurasi `response_mode=form_post`, callback-nya POST — cookie alur tidak ikut terkirim, dan galat yang muncul berbunyi "state tidak ditemukan", yang menuntun orang mencari bug di tempat yang sama sekali salah. Untuk mode itu, cookie alur wajib `SameSite=None; Secure`.

4. **Refresh token rotation.** IdP modern menerbitkan refresh token baru setiap kali dipakai dan mencabut yang lama. Pemakaian ulang refresh token yang sudah dirotasi adalah sinyal pencurian, dan IdP akan mencabut seluruh rantai — aplikasi Anda harus menangani logout mendadak ini dengan anggun.

5. **Logout tidak mencabut access token.** Menghapus cookie sesi hanya mengakhiri sesi di sisi Anda. Access token yang sudah diterbitkan tetap berlaku sampai kedaluwarsa. Untuk logout yang benar, panggil endpoint revocation dan/atau RP-initiated logout IdP.

6. **`redirect_uri` yang tidak dicocokkan persis.** Sebagian IdP mengizinkan pencocokan longgar bila dikonfigurasi salah, dan itu memungkinkan pengalihan authorization code ke domain penyerang. Daftarkan URI persis, tanpa wildcard.

7. **Discovery yang gagal saat start.** Bila IdP tidak terjangkau saat aplikasi start, `oidc.NewProvider` gagal dan pod tidak akan pernah siap. Untuk layanan yang harus tetap melayani permintaan tanpa login, tunda discovery atau ulangi di latar alih-alih menggagalkan boot. `Baru()` di §Kode sengaja gagal keras — itu pilihan yang benar untuk layanan yang **seluruh** fungsinya menuntut login, dan pilihan yang salah untuk yang tidak. Putuskan berdasarkan itu, bukan berdasarkan kebiasaan.

8. **`email_verified` yang dibaca tetapi tidak dipakai.** Kunci identitas selalu `sub`, dan itu menutup sebagian besar masalah. Yang tersisa adalah **penautan akun**: menghubungkan login IdP ke akun lokal yang sudah ada lewat alamat email. Bila IdP tidak memverifikasi kepemilikan email, penyerang cukup mendaftar di IdP itu memakai alamat korban untuk mengambil alih akun lokal korban. Periksa klaimnya, dan ketahui IdP mana yang benar-benar Anda percayai untuk memverifikasinya — sebagian tidak.

9. **Pengalihan setelah login.** Menyimpan tujuan "kembali ke halaman sebelumnya" lalu mengalihkan ke sana tanpa validasi adalah open redirect, dan halaman login adalah tempat paling umum ia muncul. Simpan hanya path relatif — atau lebih baik, sebuah kunci yang Anda petakan sendiri ke daftar tujuan yang sah — jangan pernah URL utuh dari parameter kueri.

## Kapan JANGAN Pakai Ini

- **OAuth2 untuk otentikasi antar layanan internal Anda sendiri.** Untuk komunikasi mesin-ke-mesin di dalam mesh, mTLS atau SPIFFE memberi identitas yang lebih kuat tanpa server otorisasi sebagai titik kegagalan tambahan.
- **Membangun server otorisasi sendiri.** Menerapkan OAuth2 dengan benar — rotasi kunci, pencabutan, consent, batas rate, penyimpanan token — adalah produk tersendiri. Pakai IdP yang sudah ada, dan investasikan waktu pada integrasinya.
- **Alur implicit atau password grant.** Keduanya sudah ditinggalkan RFC 9700. Bila ada pustaka atau tutorial yang masih mengajarkannya, itu tanda bahannya usang.
- **OIDC untuk otorisasi berbutir halus.** ID token membuktikan siapa, bukan boleh apa. Menaruh daftar izin di klaim membuat izin yang dicabut tetap berlaku sampai token kedaluwarsa — lihat `security_owasp/casbin_rbac_abac.md`.
- **Menyimpan access token pihak ketiga tanpa enkripsi saat istirahat.** Token yang tersimpan adalah kredensial hidup ke sistem orang lain; kebocorannya berarti akses ke data pengguna di layanan itu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Login gagal serentak untuk semua pengguna | rotasi kunci IdP dan cache JWKS | Kunci disematkan statis, atau JWKS tidak diperbarui |
| `state` mismatch melonjak | umur keadaan alur di sesi | Sesi kedaluwarsa sebelum pengguna selesai login di IdP |
| Token diterima padahal untuk aplikasi lain | apakah `aud` diperiksa | Verifikasi tanpa audience |
| Pengguna tetap punya akses setelah dinonaktifkan | umur access token | Tidak ada pencabutan; token berlaku sampai kedaluwarsa |
| Refresh token dipakai dari dua IP berbeda | rotasi refresh token | Indikasi pencurian token |
| Login gagal hanya di sebagian node | selisih jam node vs IdP | Clock skew menolak `iat`/`exp` |
| "state tidak ditemukan" pada IdP tertentu saja | `response_mode` IdP itu | `form_post` adalah POST; cookie `SameSite=Lax` tidak ikut terkirim |
| Satu akun IdP masuk sebagai pengguna lain | apakah penautan memeriksa `email_verified` | Pengambilalihan akun lewat email tak terverifikasi |
| Authorization code lama masih bisa ditukar | umur & sekali-pakai keadaan alur | `Dibuat` disimpan tapi tidak pernah diperiksa |

```bash
# Konfigurasi IdP yang benar-benar dipakai -- discovery adalah sumber kebenarannya
curl -s "$ISSUER/.well-known/openid-configuration" | jq '{issuer, authorization_endpoint, token_endpoint, jwks_uri, revocation_endpoint}'

# Kunci yang sedang aktif di IdP; bandingkan `kid` dengan yang ada di token
curl -s "$ISSUER/.well-known/jwks.json" | jq -r '.keys[].kid'

# Periksa klaim token TANPA memverifikasi (untuk diagnosis saja, bukan produksi)
echo "$ID_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{iss, aud, sub, exp, nonce}'

# Alasan kegagalan login, dikelompokkan -- pola tak terduga layak diselidiki
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="login_gagal") | .alasan' | sort | uniq -c | sort -rn

# Pemakaian ulang refresh token = sinyal pencurian
kubectl logs -l app=api --since=24h | grep -c 'refresh_dipakai_ulang'

# Clock skew: selisih beberapa detik saja sudah cukup menolak token
for n in $(kubectl get nodes -o name); do kubectl debug "$n" -it --image=busybox -- date -u 2>/dev/null; done
```
