# Panduan Definitif: Arsitektur JWT Dual Token Auth (Access + Refresh)

> **Berlaku:** Go 1.21+ · `golang-jwt/jwt/v5` · **Lihat juga:** `security_owasp/casbin_rbac_abac.md` · `security_owasp/argon2_password_security.md` · `security_owasp/mtls_certificate_rotation.md` · `observability_resilience/rate_limiting_patterns.md`

## 1. Konsep dan Internals (Technical Depth)

JSON Web Token (JWT) di Go sering kali diimplementasikan dengan keliru sebagai token sesi permanen. Karena JWT berprinsip *stateless*, token yang sudah diterbitkan tidak bisa di-*revoke* (dicabut) tanpa membuat server menyimpan *state* (blacklist/whitelist) di cache, yang mengalahkan tujuan *statelessness* JWT itu sendiri.

Solusi principal-level untuk masalah ini adalah pola **Dual Token Architecture**:

1. **Access Token (Short-lived)**: Berlaku sangat singkat (umumnya 5-15 menit). Disertakan di header HTTP (`Authorization: Bearer <token>`) untuk mengakses API. Jika token ini bocor, *window of opportunity* untuk disalahgunakan (eksploitasi) sangat sempit.
2. **Refresh Token (Long-lived)**: Berlaku lama (7-30 hari). Tidak pernah dikirim ke API biasa. Token ini hanya dikirim ke satu endpoint spesifik (`/auth/refresh`) secara eksklusif. Sebaiknya tidak diberikan ke *client logic*, melainkan disimpan secara aman di browser sebagai *Secure, HttpOnly Cookie*.
3. **Asymmetric Cryptography (RS256 / EdDSA)**: Jangan menggunakan kunci simetris (HS256) jika arsitektur microservices Anda kompleks. Di HS256, semua API server butuh kunci yang sama untuk memvalidasi token, meningkatkan risiko bocor. Gunakan RS256: *Auth Server* menandatangani JWT menggunakan *Private Key*, dan resource API memvalidasi menggunakan *Public Key* (sering disediakan via *JWKS - JSON Web Key Set* endpoint).
4. **Refresh Token Rotation (RTR)**: Setiap kali token dikirim untuk merefresh Access Token, Refresh Token tersebut *dihanguskan* dan server menerbitkan Refresh Token yang baru. Jika token lama dipakai lagi, ini adalah indikasi Token Dicuri (Token Theft).
5. **Token Theft Detection**: Saat sistem mendeteksi percobaan menggunakan Refresh Token yang sudah dirotasi, sistem akan mengasumsikan rantai auth terkompromi dan melakukan *revocation* (penghapusan total sesi, menghanguskan Refresh Token terbaru) di server, dan memaksa pengguna untuk login ulang.

## 2. Diagram ASCII: Alur Otentikasi & Rotasi Dinamis

```text
[ Client (Browser/Mobile) ]                       [ Resource Server API ]            [ Auth Server (IDP) ]
           |                                                |                                  |
           | 1. POST /login (Username/Pass)                 |                                  |
           |==================================================================================>|
           |                                                |                                  |
           | 2. Set-Cookie: refresh_token=XYZ (HttpOnly)    |                                  |
           |    Response Body: access_token=ABC (15m)       |                                  |
           |<==================================================================================|
           |                                                |                                  |
           | 3. GET /api/data                               |                                  |
           |    Authorization: Bearer ABC                   |                                  |
           |===============================================>|                                  |
           |                                                | 4. Sync Public Key (JWKS)        |
           |                                                |--------------------------------->|
           | 5. Return Protected Data                       |                                  |
           |<===============================================|                                  |
           |                                                |                                  |
         (Waktu berlalu: Access Token ABC expired)          |                                  |
           |                                                |                                  |
           | 6. POST /refresh                               |                                  |
           |    Cookie: refresh_token=XYZ                   |                                  |
           |==================================================================================>|
           |                                                |   Validasi Redis (Rotasi check)  |
           | 7. Set-Cookie: refresh_token=NEW_MNO           |   Hapus XYZ, Simpan NEW_MNO      |
           |    Response Body: access_token=DEF             |                                  |
           |<==================================================================================|
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengizinkan Algoritma "none" (Algorithm Confusion)

**Mengapa berbahaya (Exploit Vector)**: Pada JWT, algoritma *signing* diatur di *Header* JWT (`"alg": "HS256"`). Attacker bisa mengubah header JWT yang sudah diterbitkan menjadi `"alg": "none"` dan menghilangkan bagian *signature*-nya. Jika server Go menerima semua algoritma secara membabi-buta, aplikasi akan menerima JWT bodong tersebut seolah-olah valid karena validasi *signature none* tidak membutuhkan kunci kriptografi.

```go
// VULNERABLE: JWT Algorithm Confusion
func parseJWTVulnerable(tokenStr string) error {
	// ❌ BAD: Tidak memeriksa `t.Method` apakah sesuai dengan yang kita inginkan (misal RS256).
	// Jika token memiliki alg="none", librari mungkin return key nil dan meloloskannya.
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		return publicKey, nil 
	})
	
	if err == nil && token.Valid {
		return nil
	}
	return errors.New("invalid")
}
```

```go
// ✅ GOOD: Validasi eksplisit dan paksa metode penandatanganan
func parseJWTSafe(tokenStr string) error {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		// Validasi algoritma eksplisit (Mencegah "alg: none" dan serangan HMAC->RSA confusion)
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return publicKey, nil
	})
	//...
}
```

### ❌ Anti-Pattern 2: Tidak Melakukan Validasi `exp`, `nbf`, `aud`, dan `iss`

**Mengapa berbahaya (Exploit Vector)**: Attacker yang menyadap token bisa menggunakannya kembali tanpa batas waktu jika kadaluarsa (`exp`) diabaikan. Jika `aud` (Audience) diabaikan, token untuk aplikasi lain dalam satu ekosistem microservice dapat disalahgunakan di aplikasi *payment gateway* (Cross-service Privilege Escalation).

```go
// VULNERABLE: Mengabaikan Claims Validasi Standar
func claimsVulnerable(tokenStr string) {
	// ❌ BAD: Hanya mengekstrak klaim secara manual tanpa validasi standar
	parts := strings.Split(tokenStr, ".")
	payloadB64 := parts[1]
	// ... lalu menganggap tokennya valid asalkan payloadB64 bisa di-decode.
}
```

```go
// ✅ GOOD: Gunakan `jwt.ParseWithClaims` yang otomatis memvalidasi standard klaim
// jwt-go / golang-jwt v5 memvalidasi `exp`, `nbf` (Not Before) secara otomatis jika didefinisikan.
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Clock Skew (Waktu Tak Sinkron)**: Waktu sistem (NTP) antara Server A (IDP) yang menerbitkan token dan Server B (Resource Server) yang memvalidasi bisa berbeda 1-3 detik. Token yang baru terbit bisa tertolak karena dianggap digunakan *sebelum* `IssuedAt` (`iat`). Di Go, atasi ini dengan menambahkan kompensasi *Leeway*: `jwt.WithLeeway(5 * time.Second)`.
2. **Race Condition di Sistem Klien akibat Rotasi Token**: Aplikasi *Single Page Application* (React/Vue) sering melakukan 5 pemanggilan API bersamaan di satu waktu. Jika token kedaluwarsa, ke-5 request itu akan memicu POST `/refresh`. Karena *Refresh Token Rotation* hanya memperbolehkan token dipakai *1 kali*, 4 request lainnya akan ditolak, memutus sesi user secara prematur (Token Theft misdetection). **Solusi:** Di Redis, berikan *grace period* (misal 15 detik) untuk token yang baru dipakai dirotasi. Di rentang waktu itu, token lama dapat direfresh menjadi access token yang baru.
3. **Information Leakage via Token Error Messages**: Saat error validasi terjadi, API tidak boleh mengembalikan error spesifik kriptografis ke luar, contoh: `Invalid signature for token xxxx`. Attacker bisa memanfaatkannya untuk Oracle Attack. Selalu kembalikan 401 Unauthorized secara generik pada response body.

## 5. Production-Ready Go Code

Kode berikut menggunakan standar industri (`golang-jwt/jwt/v5`) dan mengimplementasi standar *Key Asymmetric* dengan kontrol clock-skew dan validasi klaim yang mumpuni.

```go
package security

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Di aplikasi nyata, kunci diambil via JWKS endpoint, Vault, atau variabel lingkungan.
var (
	privateKey *rsa.PrivateKey
	publicKey  *rsa.PublicKey
)

// Inisialisasi awal khusus untuk demo ini (Generate 2048-bit RSA)
func init() {
	var err error
	privateKey, err = rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic("failed to generate secure rsa key for boot")
	}
	publicKey = &privateKey.PublicKey
}

// CustomClaims menyematkan klaim spesifik bisnis + RegisteredClaims (standar JWT RFC)
type CustomClaims struct {
	UserID string   `json:"uid"`
	Roles  []string `json:"roles"`
	jwt.RegisteredClaims
}

// TokenPair menampung akses dan refresh token
type TokenPair struct {
	AccessToken  string
	RefreshToken string
}

// GenerateAuthTokens membuat token berpasangan. context digunakan untuk propagasi trace
func GenerateAuthTokens(ctx context.Context, userID string, roles []string) (*TokenPair, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context cancelled during token generation: %w", err)
	}

	now := time.Now().UTC()

	// 1. GENERATE ACCESS TOKEN (15 Menit) - RS256 Asymmetric
	accClaims := CustomClaims{
		UserID: userID,
		Roles:  roles,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    "auth.mycompany.internal",
			Subject:   userID,
			Audience:  []string{"api.mycompany.internal"},
		},
	}

	accToken := jwt.NewWithClaims(jwt.SigningMethodRS256, accClaims)
	accStr, err := accToken.SignedString(privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed signing access token: %w", err)
	}

	// 2. GENERATE REFRESH TOKEN (7 Hari)
	// Refresh Token biasanya hanya opaque string acak (JTI uuid panjang)
	// Namun, bisa juga direpresentasikan sebagai JWT spesifik dengan audience berbeda.
	refClaims := jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(now.Add(7 * 24 * time.Hour)),
		IssuedAt:  jwt.NewNumericDate(now),
		Issuer:    "auth.mycompany.internal",
		Subject:   userID,
		Audience:  []string{"refresh.mycompany.internal"}, // Spesifik untuk endpoint refresh
		ID:        fmt.Sprintf("jti-%d", now.UnixNano()),    // JTI unik untuk Rotasi (seharusnya UUID v4)
	}
	
	refToken := jwt.NewWithClaims(jwt.SigningMethodRS256, refClaims)
	refStr, err := refToken.SignedString(privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed signing refresh token: %w", err)
	}

	return &TokenPair{
		AccessToken:  accStr,
		RefreshToken: refStr,
	}, nil
}

// VerifyAccessToken memvalidasi Access Token yang dikirim klien
func VerifyAccessToken(ctx context.Context, tokenStr string) (*CustomClaims, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context context cancelled: %w", err)
	}

	tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")

	var claims CustomClaims

	// Parser dengan verifikasi ketat (Algoritma dan Issuer/Audience check)
	token, err := jwt.ParseWithClaims(tokenStr, &claims, func(t *jwt.Token) (interface{}, error) {
		// Validasi Anti-Pattern 1: Hindari `alg: none`
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("critical: unexpected signing algorithm %v", t.Header["alg"])
		}
		// Return public key untuk verifikasi RS256
		return publicKey, nil
		
	}, 
	// Edge Case 1: Kompensasi Clock Skew di sistem terdistribusi (maksimal 10 detik delay jam server)
	jwt.WithLeeway(10*time.Second), 
	jwt.WithValidMethods([]string{"RS256"}),
	jwt.WithAudience("api.mycompany.internal"),
	jwt.WithIssuer("auth.mycompany.internal"))

	if err != nil {
		// Error spesifik library (Expired, Invalid Sig, Aud wrong)
		// Jangan dilempar langsung ke UI di layer controller, log di sini, balikan generic ke user.
		return nil, fmt.Errorf("verification error: %w", err)
	}

	if !token.Valid {
		return nil, errors.New("token parsed but marked invalid")
	}

	return &claims, nil
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestJWTAuthenticationFlow_SecurityBoundaries(t *testing.T) {
	ctx := context.Background()
	userID := "usr_998877"
	roles := []string{"admin", "editor"}

	// --- 1. Happy Path ---
	tokens, err := GenerateAuthTokens(ctx, userID, roles)
	if err != nil {
		t.Fatalf("Failed to generate tokens: %v", err)
	}
	if tokens.AccessToken == "" || tokens.RefreshToken == "" {
		t.Fatal("Expected tokens not to be empty")
	}

	claims, err := VerifyAccessToken(ctx, tokens.AccessToken)
	if err != nil {
		t.Fatalf("Valid token should not error: %v", err)
	}
	if claims.Subject != userID {
		t.Errorf("Expected userID %s, got %s", userID, claims.Subject)
	}

	// --- 2. Tampering Signature Boundary (Attacker modifies payload) ---
	// Pisahkan JWT: Header.Payload.Signature
	parts := strings.Split(tokens.AccessToken, ".")
	if len(parts) != 3 {
		t.Fatalf("Invalid JWT token structure")
	}
	
	// Modifikasi Payload
	tamperedPayload := "eyJ1aWQiOiJ1c3JfYWRtaW4iLCJyb2xlcyI6WyJzdXBlcmFkbWluIl19" // ubah claims b64
	tamperedToken := fmt.Sprintf("%s.%s.%s", parts[0], tamperedPayload, parts[2])
	
	_, err = VerifyAccessToken(ctx, tamperedToken)
	if err == nil {
		t.Fatal("Expected error for tampered payload, but got nil")
	}
	if !strings.Contains(err.Error(), "signature is invalid") {
		t.Errorf("Expected signature invalid error, got: %v", err)
	}

	// --- 3. Audience Validation Boundary (Cross-service Privilege Escalation) ---
	// Attacker memakai Refresh Token untuk masuk ke API resource server (Salah audience)
	_, err = VerifyAccessToken(ctx, tokens.RefreshToken)
	if err == nil {
		t.Fatal("Expected error because RefreshToken has wrong Audience for AccessToken parser")
	}
	if !strings.Contains(err.Error(), "audience") {
		t.Errorf("Expected audience error, got: %v", err)
	}
	
	// --- 4. Alg None (Algorithm Confusion) Boundary ---
	algNoneToken := fmt.Sprintf("%s.%s.", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0", parts[1]) // Header alg:none
	_, err = VerifyAccessToken(ctx, algNoneToken)
	if err == nil {
		t.Fatal("Expected error for alg:none token, but got nil")
	}
	if !strings.Contains(err.Error(), "unexpected signing algorithm") {
		t.Errorf("Expected unexpected algorithm error, got: %v", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Untuk sesi yang harus bisa dicabut seketika.** Token yang sudah diterbitkan berlaku sampai kedaluwarsa. Pencabutan membutuhkan daftar cabut yang diperiksa setiap permintaan — dan begitu daftar itu ada, keuntungan "tanpa state" sudah hilang. Untuk kasus ini, sesi berbasis server lebih jujur.
- **Menerima algoritma dari header token.** `alg: none` dan pertukaran RS256→HS256 adalah kerentanan klasik yang masih ditemukan sampai sekarang. Algoritma WAJIB ditentukan server dan diverifikasi eksplisit di callback.
- **Menyimpan data yang bisa berubah di dalam klaim.** Peran yang dicabut tetap berlaku sampai token kedaluwarsa. Untuk otorisasi yang berubah, ambil dari sumbernya.
- **Access token berumur panjang.** Pola dua token ada persis agar access token pendek dan refresh token bisa dicabut. Access token 30 hari membuang seluruh manfaatnya dan menyisakan kerumitannya.
- **Menyimpan JWT di `localStorage` untuk aplikasi web.** Satu XSS menjadi pengambilalihan akun penuh. Cookie `HttpOnly` + `Secure` + `SameSite` memberi perlindungan yang tidak bisa diberikan `localStorage`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pengguna yang dinonaktifkan masih bisa mengakses | umur access token | Tidak ada pencabutan; token berlaku sampai kedaluwarsa |
| Token dengan `alg` tak terduga diterima | validasi metode penandatanganan | Algoritma diambil dari token, bukan ditetapkan server |
| Peran yang dicabut masih berlaku | apa yang disimpan di klaim | Data berubah disimpan di token |
| Refresh token dipakai berkali-kali dari IP berbeda | rotasi refresh token | Token dicuri; butuh deteksi pemakaian ulang |
| Lonjakan `401` setelah rotasi kunci | periode tumpang tindih kunci | Kunci lama dicabut sebelum semua token kedaluwarsa |

```bash
# Validasi metode penandatanganan WAJIB eksplisit -- ini baris paling penting
grep -rn -A5 'jwt.Parse\|ParseWithClaims' --include='*.go' . | grep -i 'SigningMethod'

# Umur token yang benar-benar diterbitkan
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="token_terbit") | .ttl_detik' | sort -n | uniq -c

# Alasan token ditolak -- pola tak terduga di sini layak diselidiki
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="token_ditolak") | .alasan' | sort | uniq -c | sort -rn

# Refresh token yang dipakai ulang = indikasi pencurian
kubectl logs -l app=api --since=24h | grep -c 'refresh_dipakai_ulang'
```
