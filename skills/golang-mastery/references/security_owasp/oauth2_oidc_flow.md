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
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Galat yang dibedakan pemanggil.
var (
	ErrStateTidakCocok = errors.New("auth: state tidak cocok dengan sesi")
	ErrNonceTidakCocok = errors.New("auth: nonce tidak cocok dengan sesi")
	ErrTanpaIDToken    = errors.New("auth: respons tanpa id_token")
)

// Konfig menampung apa yang dibutuhkan alur.
type Konfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string // kosong untuk klien publik (SPA/mobile)
	RedirectURL  string
	Scope        []string
}

// KeadaanAlur adalah yang WAJIB disimpan di sesi sisi server antara
// pengalihan ke IdP dan callback. Ketiganya diperiksa saat callback.
type KeadaanAlur struct {
	State    string
	Nonce    string
	Verifier string
	Dibuat   time.Time
}

// Klien membungkus verifier OIDC dan konfigurasi OAuth2.
type Klien struct {
	penyedia *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    oauth2.Config
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
	}, nil
}

// MulaiAlur menghasilkan URL otorisasi beserta keadaan yang WAJIB disimpan
// di sesi. State, nonce, dan verifier semuanya dari crypto/rand.
func (c *Klien) MulaiAlur() (urlOtorisasi string, keadaan KeadaanAlur, err error) {
	state, err := acak32()
	if err != nil {
		return "", KeadaanAlur{}, fmt.Errorf("buat state: %w", err)
	}
	nonce, err := acak32()
	if err != nil {
		return "", KeadaanAlur{}, fmt.Errorf("buat nonce: %w", err)
	}
	verifier, err := acak32()
	if err != nil {
		return "", KeadaanAlur{}, fmt.Errorf("buat verifier: %w", err)
	}

	// PKCE S256: yang dikirim adalah HASH-nya, bukan verifier-nya.
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	u := c.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	return u, KeadaanAlur{State: state, Nonce: nonce, Verifier: verifier, Dibuat: time.Now()}, nil
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
func (c *Klien) SelesaikanAlur(ctx context.Context, k KeadaanAlur, stateDariURL, code string) (*Identitas, error) {
	// 1. CSRF: state dari URL WAJIB cocok dengan yang disimpan di sesi.
	if stateDariURL == "" || stateDariURL != k.State {
		return nil, ErrStateTidakCocok
	}

	// 2. Tukar code + verifier PKCE. IdP memeriksa S256(verifier) == challenge.
	tok, err := c.oauth.Exchange(ctx, code,
		oauth2.SetAuthURLParam("code_verifier", k.Verifier))
	if err != nil {
		return nil, fmt.Errorf("tukar authorization code: %w", err)
	}

	mentah, ok := tok.Extra("id_token").(string)
	if !ok || mentah == "" {
		return nil, ErrTanpaIDToken
	}

	// 3. Verifikasi tanda tangan (JWKS), iss, aud, dan exp.
	idToken, err := c.verifier.Verify(ctx, mentah)
	if err != nil {
		return nil, fmt.Errorf("verifikasi id_token: %w", err)
	}

	// 4. Replay: nonce di dalam token WAJIB cocok dengan yang disimpan sesi.
	if idToken.Nonce != k.Nonce {
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

// PasangCookieSesi menulis cookie sesi dengan atribut yang aman.
// Nilai yang ditulis adalah ID sesi sisi server -- BUKAN token.
func PasangCookieSesi(w http.ResponseWriter, idSesi string, umur time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     "sesi",
		Value:    idSesi,
		Path:     "/",
		MaxAge:   int(umur.Seconds()),
		HttpOnly: true,                 // tidak terbaca JavaScript -> XSS tidak mencuri sesi
		Secure:   true,                 // hanya lewat HTTPS
		SameSite: http.SameSiteLaxMode, // Lax agar redirect balik dari IdP tetap membawa cookie
	})
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
	"strings"
	"testing"
	"time"
)

func keadaanUji() KeadaanAlur {
	return KeadaanAlur{State: "state-benar", Nonce: "nonce-benar", Verifier: "verifier-benar", Dibuat: time.Now()}
}

func TestSelesaikanAlur_StateSalahDitolakSebelumMenghubungiIdP(t *testing.T) {
	// Inti pengujian: permintaan CSRF tidak boleh sampai memicu panggilan
	// jaringan ke IdP. Klien tanpa endpoint asli sudah cukup membuktikannya.
	c := &Klien{}
	_, err := c.SelesaikanAlur(context.Background(), keadaanUji(), "state-penyerang", "code")
	if !errors.Is(err, ErrStateTidakCocok) {
		t.Fatalf("mau ErrStateTidakCocok, dapat %v", err)
	}
}

func TestSelesaikanAlur_StateKosongDitolak(t *testing.T) {
	c := &Klien{}
	_, err := c.SelesaikanAlur(context.Background(), keadaanUji(), "", "code")
	if !errors.Is(err, ErrStateTidakCocok) {
		t.Fatalf("state kosong WAJIB ditolak, dapat %v", err)
	}
}

func TestMulaiAlur_MenghasilkanNilaiAcakYangBerbeda(t *testing.T) {
	c := &Klien{oauth: konfigUjiOAuth()}

	_, a, err := c.MulaiAlur()
	if err != nil {
		t.Fatal(err)
	}
	_, b, err := c.MulaiAlur()
	if err != nil {
		t.Fatal(err)
	}
	if a.State == b.State || a.Nonce == b.Nonce || a.Verifier == b.Verifier {
		t.Fatal("state/nonce/verifier WAJIB berbeda tiap alur")
	}
	if len(a.Verifier) < 43 {
		t.Errorf("verifier PKCE minimal 43 karakter, dapat %d", len(a.Verifier))
	}
}

func TestMulaiAlur_MemakaiS256BukanPlain(t *testing.T) {
	c := &Klien{oauth: konfigUjiOAuth()}
	u, k, err := c.MulaiAlur()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(u, "code_challenge_method=S256") {
		t.Fatal("metode PKCE WAJIB S256; 'plain' tidak memberi perlindungan")
	}
	// Yang dikirim WAJIB hash-nya, bukan verifier-nya.
	sum := sha256.Sum256([]byte(k.Verifier))
	mau := base64.RawURLEncoding.EncodeToString(sum[:])
	if !strings.Contains(u, "code_challenge="+mau) {
		t.Fatal("challenge harus S256(verifier)")
	}
	if strings.Contains(u, k.Verifier) {
		t.Fatal("verifier BOCOR ke URL otorisasi")
	}
}

func TestMulaiAlur_NonceIkutDikirim(t *testing.T) {
	c := &Klien{oauth: konfigUjiOAuth()}
	u, k, _ := c.MulaiAlur()
	if !strings.Contains(u, "nonce="+k.Nonce) {
		t.Fatal("nonce WAJIB dikirim, kalau tidak ID token bisa diputar ulang")
	}
}

func TestPasangCookieSesi_AtributKeamanan(t *testing.T) {
	w := httptest.NewRecorder()
	PasangCookieSesi(w, "sesi-123", time.Hour)

	c := w.Result().Cookies()[0]
	if !c.HttpOnly {
		t.Error("HttpOnly wajib: tanpa itu XSS bisa mencuri sesi")
	}
	if !c.Secure {
		t.Error("Secure wajib: tanpa itu cookie terkirim lewat HTTP polos")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Error("SameSite=Lax agar redirect balik dari IdP tetap membawa cookie")
	}
	if strings.Contains(c.Value, ".") {
		t.Error("nilai cookie harus ID sesi, bukan token JWT")
	}
}
```

## Anti-Pattern

**❌ SALAH — memakai ID token sebagai bearer ke API**

```go
req.Header.Set("Authorization", "Bearer "+identitas.IDToken)
```

ID token diterbitkan **untuk aplikasi Anda** (`aud` = client ID Anda). API yang menerimanya sedang memvalidasi token yang bukan ditujukan kepadanya — dan bila ia mengabaikan `aud`, ia akan menerima token dari aplikasi mana pun di tenant IdP yang sama.

**✅ BENAR — access token untuk API, ID token hanya untuk membangun sesi**

```go
req.Header.Set("Authorization", "Bearer "+identitas.AccessToken)
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

3. **`state` yang tidak kedaluwarsa.** Keadaan alur yang tersimpan selamanya berarti authorization code lama masih bisa ditukar. Beri masa hidup pendek — beberapa menit — dan hapus setelah dipakai sekali.

4. **Refresh token rotation.** IdP modern menerbitkan refresh token baru setiap kali dipakai dan mencabut yang lama. Pemakaian ulang refresh token yang sudah dirotasi adalah sinyal pencurian, dan IdP akan mencabut seluruh rantai — aplikasi Anda harus menangani logout mendadak ini dengan anggun.

5. **Logout tidak mencabut access token.** Menghapus cookie sesi hanya mengakhiri sesi di sisi Anda. Access token yang sudah diterbitkan tetap berlaku sampai kedaluwarsa. Untuk logout yang benar, panggil endpoint revocation dan/atau RP-initiated logout IdP.

6. **`redirect_uri` yang tidak dicocokkan persis.** Sebagian IdP mengizinkan pencocokan longgar bila dikonfigurasi salah, dan itu memungkinkan pengalihan authorization code ke domain penyerang. Daftarkan URI persis, tanpa wildcard.

7. **Discovery yang gagal saat start.** Bila IdP tidak terjangkau saat aplikasi start, `oidc.NewProvider` gagal dan pod tidak akan pernah siap. Untuk layanan yang harus tetap melayani permintaan tanpa login, tunda discovery atau ulangi di latar alih-alih menggagalkan boot.

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
