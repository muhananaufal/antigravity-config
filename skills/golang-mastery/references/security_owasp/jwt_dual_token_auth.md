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
// ✅ GOOD: metode ditetapkan SERVER lewat opsi parser, bukan dibaca dari token.
func parseJWTSafe(tokenStr string) error {
	token, err := jwt.ParseWithClaims(tokenStr, &klaim, func(t *jwt.Token) (any, error) {
		// Lapis kedua. Lihat catatan di bawah soal mana yang menyala lebih dulu.
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing algorithm: %v", t.Header["alg"])
		}
		return publicKey, nil
	}, jwt.WithValidMethods([]string{"RS256"})) // <- lapis pertama, dan yang menentukan
	//...
}
```

Dua hal yang perlu diluruskan tentang potongan di atas:

- **`jwt.WithValidMethods` diperiksa SEBELUM keyfunc dipanggil.** Untuk token `alg: none`, galat yang keluar adalah `signing method none is invalid` dari opsi itu — pesan `algoritma tak terduga` di dalam keyfunc tidak pernah tercapai. Uji yang menuntut pesan dari keyfunc akan gagal. Keduanya tetap layak dipasang, tetapi ketahuilah mana yang benar-benar menyala.
- **Mekanisme serangan RS256→HS256 layak diketahui, bukan sekadar namanya.** Penyerang mengubah `alg` menjadi `HS256` lalu menandatangani token memakai **kunci publik Anda sebagai secret HMAC** — kunci yang memang sengaja dipublikasikan. Bila server meneruskan bahan kunci yang sama ke verifier tanpa memeriksa metode, verifikasi HMAC-nya cocok dan token buatan penyerang diterima. Itulah sebabnya pemeriksaan metode tidak bisa digantikan oleh "kunci publik toh tidak rahasia".

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
// ✅ GOOD: ParseWithClaims memvalidasi klaim standar secara otomatis.
jwt.ParseWithClaims(tokenStr, &klaim, keyfunc,
	jwt.WithValidMethods([]string{"RS256"}),
	jwt.WithAudience("api.mycompany.internal"), // WAJIB disebut; tanpa opsi ini `aud` tidak diperiksa
	jwt.WithIssuer("auth.mycompany.internal"),  // sama: tanpa opsi ini `iss` diabaikan
	jwt.WithExpirationRequired(),               // token TANPA `exp` ditolak, bukan dianggap abadi
)
```

Kata kuncinya **"jika didefinisikan"**, dan di situlah jebakannya. `exp` dan `nbf` divalidasi otomatis — tetapi hanya bila klaimnya ada. Token yang sama sekali **tidak memuat `exp`** lolos tanpa keluhan dan berlaku selamanya, kecuali Anda memasang `jwt.WithExpirationRequired()`. Begitu pula `aud` dan `iss`: keduanya tidak diperiksa sama sekali sampai Anda menyebutkan `WithAudience` dan `WithIssuer` secara eksplisit — sehingga anti-pattern ini bisa tetap hidup di kode yang sudah memakai `ParseWithClaims` dan tampak benar.

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Clock Skew (Waktu Tak Sinkron)**: waktu sistem (NTP) antara Server A (IDP) yang menerbitkan token dan Server B (Resource Server) yang memvalidasi bisa berbeda 1–3 detik. Token yang baru terbit dapat tertolak karena dianggap dipakai *sebelum* `NotBefore` (`nbf`). Di Go, kompensasinya `jwt.WithLeeway(5 * time.Second)`. **Leeway berlaku dua arah**: nilai yang sama juga memperpanjang umur efektif setiap token — leeway 60 detik pada access token 15 menit berarti token yang sudah kedaluwarsa masih diterima satu menit penuh. Pilih angka sekecil mungkin yang menutupi selisih NTP nyata Anda, dan perlakukan ia sebagai bagian dari umur token, bukan sebagai setelan bebas.
2. **Race Condition di Sistem Klien akibat Rotasi Token**: SPA (React/Vue) sering melakukan lima pemanggilan API sekaligus. Bila access token kedaluwarsa, kelimanya memicu `POST /refresh`. Karena rotasi hanya mengizinkan satu kali pakai, empat sisanya tertolak dan sesi terputus — deteksi pencurian yang keliru. **Solusinya jendela tenggang (±15 detik), tetapi detail implementasinya menentukan apakah ia benar-benar menolong:** di dalam tenggang, penukaran WAJIB mengembalikan **refresh token yang identik** dengan penukaran pertama, bukan menerbitkan JTI baru lagi. Bila JTI baru diterbitkan tiap kali, empat klien pulang membawa token yang tidak pernah terdaftar di penyimpan — dan pemakaian berikutnya terbaca sebagai pencurian, persis kesalahan yang ingin dicegah, hanya tertunda satu siklus. Lihat nilai kembalian `Tukar` pada §5.

   Harga yang dibayar harus disebut terang-terangan: **di dalam jendela itu, token curian yang dipakai tepat setelah penukaran sah TIDAK terdeteksi.** Tenggang menukar sebagian daya deteksi dengan stabilitas sesi. Buat sependek yang masih menutupi jitter jaringan klien Anda.
3. **Information Leakage via Token Error Messages**: saat validasi gagal, API tidak boleh mengembalikan galat kriptografis spesifik ke luar — `Invalid signature`, `token is expired`, dan `invalid audience` masing-masing memberi tahu penyerang hal berbeda tentang token yang ia pegang, dan itulah bahan sebuah oracle. Pemisahannya harus struktural, bukan sekadar kesepakatan: fungsi verifikasi internal mengembalikan galat detail **untuk log**, dan pintu publiknya menyeragamkan semuanya menjadi satu galat. Menyerahkan disiplin ini ke lapisan controller — seperti yang ditulis komentar pada versi sebelumnya sementara kodenya tetap mengembalikan galat pustaka apa adanya — berarti kebocoran hanya berjarak satu handler ceroboh.
4. **Refresh token yang disimpan sebagai JWT ber-JTI tidak perlu di-hash di penyimpan, dan itu bukan kebetulan**: yang tersimpan hanyalah JTI, dan JTI saja tidak cukup untuk membuat token — penyerang tetap membutuhkan tanda tangan kunci privat. Ini berbeda dari desain *opaque refresh token*, di mana string yang tersimpan **adalah** kredensialnya, sehingga satu dump database berarti pengambilalihan setiap akun dan penyimpanannya wajib dalam bentuk hash. Pilih salah satu desain dengan sadar; yang berbahaya adalah memakai token opaque lalu menyimpannya seperti JTI.

## 5. Production-Ready Go Code

Kode berikut menggunakan standar industri (`golang-jwt/jwt/v5`) dan mengimplementasi standar *Key Asymmetric* dengan kontrol clock-skew dan validasi klaim yang mumpuni.

```go
package security

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Galat yang boleh dilihat pemanggil. Detail kriptografisnya sengaja TIDAK
// ikut keluar: pesan yang membedakan "signature is invalid" dari "token is
// expired" memberi penyerang oracle untuk memilah token cacat dari token basi.
// Detailnya masuk ke log, bukan ke respons — inilah Kasus Tepi 3 yang di versi
// sebelumnya hanya ditulis sebagai komentar sementara kodenya tetap
// mengembalikan galat pustaka apa adanya.
var (
	ErrInvalidToken = errors.New("invalid token")
	ErrTokenReused  = errors.New("refresh token reused")
)

const (
	umurAccessToken  = 15 * time.Minute
	umurRefreshToken = 7 * 24 * time.Hour
	tenggangRotasi   = 15 * time.Second
	penerbit         = "auth.mycompany.internal"
	audAccess        = "api.mycompany.internal"
	audRefresh       = "refresh.mycompany.internal"
)

// ============ Kunci dan rotasinya ============

type Kunci struct {
	ID     string // masuk ke header `kid`
	Privat *rsa.PrivateKey
}

// PenyediaKunci memegang kunci penandatangan aktif DAN kunci lama yang masih
// diperlukan untuk memverifikasi token yang belum kedaluwarsa.
//
// Dua hal yang tidak ada di versi sebelumnya, dan keduanya wajib:
//
//   - Kunci TIDAK dibangkitkan di `init()`. Kunci per-proses berarti token yang
//     ditandatangani pod A ditolak pod B — sistemnya tidak bekerja dengan lebih
//     dari satu replika sama sekali, dan setiap restart membatalkan seluruh
//     sesi yang sedang berjalan.
//   - Header `kid`. Tanpa itu, verifier tidak punya cara memilih kunci mana
//     yang harus dipakai, sehingga periode tumpang tindih saat rotasi mustahil
//     dibuat dan rotasi kunci membatalkan semua token sekaligus. Itu persis
//     gejala "lonjakan 401 setelah rotasi kunci" di tabel deteksi.
type PenyediaKunci struct {
	mu     sync.RWMutex
	aktif  Kunci
	publik map[string]*rsa.PublicKey
}

func NewPenyediaKunci(aktif Kunci) *PenyediaKunci {
	return &PenyediaKunci{
		aktif:  aktif,
		publik: map[string]*rsa.PublicKey{aktif.ID: &aktif.Privat.PublicKey},
	}
}

// Rotasi memasang kunci penandatangan baru dan MEMPERTAHANKAN yang lama untuk
// verifikasi. Kunci lama baru boleh dibuang setelah token terlama yang
// ditandatanganinya kedaluwarsa — untuk refresh token, itu tujuh hari.
func (p *PenyediaKunci) Rotasi(baru Kunci) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.aktif = baru
	p.publik[baru.ID] = &baru.Privat.PublicKey
}

func (p *PenyediaKunci) Buang(kid string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.publik, kid)
}

func (p *PenyediaKunci) Penandatangan() Kunci {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.aktif
}

func (p *PenyediaKunci) Verifikator(kid string) (*rsa.PublicKey, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	k, ada := p.publik[kid]
	if !ada {
		return nil, fmt.Errorf("unknown kid: %q", kid)
	}
	return k, nil
}

// ============ Klaim ============

type AccessClaims struct {
	UserID string   `json:"uid"`
	Roles  []string `json:"roles"`
	jwt.RegisteredClaims
}

// RefreshClaims membawa `fam` — pengenal KELUARGA sesi.
//
// Rotasi menghasilkan rantai token yang saling menggantikan. Ketika satu mata
// rantai terbukti dipakai ulang, yang harus dicabut bukan satu token itu saja
// melainkan seluruh rantainya: pada saat itu pemakai sah dan pencuri
// sama-sama memegang token dari keluarga yang sama, dan tidak ada cara
// mengetahui mana yang mana.
type RefreshClaims struct {
	Keluarga string `json:"fam"`
	jwt.RegisteredClaims
}

type TokenPair struct {
	AccessToken  string
	RefreshToken string
}

// acakID menghasilkan 128 bit acak.
//
// Versi sebelumnya memakai `fmt.Sprintf("jti-%d", now.UnixNano())` dengan
// komentar `// (seharusnya UUID v4)` di baris yang sama — lalu tetap dikirim
// begitu. JTI adalah KUNCI ROTASI: bila bisa ditebak, penyerang dapat
// menandai refresh token milik orang lain sebagai "dipakai ulang" dan memaksa
// pencabutan sesi mereka. Stempel waktu nanodetik juga membocorkan waktu
// penerbitan dengan presisi penuh.
func acakID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("entropy source failed: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
```

### Rotasi refresh token dan deteksi pencurian

Bagian ini **sama sekali tidak ada** di versi sebelumnya, padahal §1 butir 4–5 dan langkah 7 pada diagram menjanjikannya. Tanpa penyimpanan sisi server, kalimat "refresh token dihanguskan" tidak bisa dieksekusi: JWT yang sudah ditandatangani berlaku sampai kedaluwarsa, sehingga refresh token tujuh hari yang dicuri bekerja penuh selama tujuh hari tanpa satu pun mekanisme mendeteksinya — persis kerentanan yang berkas ini klaim selesaikan.

```go
package security

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type StatusTukar int

const (
	TukarBerhasil StatusTukar = iota
	// TukarDalamTenggang: JTI ini baru saja dirotasi dan masih di dalam
	// jendela tenggang. Ini BUKAN pencurian — lihat Kasus Tepi 2.
	TukarDalamTenggang
	// TukarDipakaiUlang: JTI sudah dirotasi dan melewati tenggang. Satu-satunya
	// tafsir yang aman adalah rantai auth sudah terkompromi.
	TukarDipakaiUlang
)

// PenyimpanRefresh adalah state sisi server yang membuat rotasi MUNGKIN.
//
// Tukar WAJIB atomik. Dua permintaan refresh yang tiba bersamaan dengan JTI
// lama yang sama harus menghasilkan tepat satu pemenang; implementasi
// baca-lalu-tulis membuat keduanya berhasil, dan deteksi pencurian menjadi
// tidak berarti. Di Redis, ini berarti satu skrip Lua — dengan alasan yang
// sama seperti pada `observability_resilience/rate_limiting_patterns.md`.
type PenyimpanRefresh interface {
	Simpan(ctx context.Context, keluarga, jti string, umur time.Duration) error
	// Tukar mengembalikan JTI yang HARUS dipakai untuk menandatangani refresh
	// token berikutnya. Pada jalur tenggang, nilainya adalah JTI yang sudah
	// diterbitkan sebelumnya — sehingga lima permintaan bersamaan menerima
	// refresh token yang IDENTIK dan penyimpanan tetap konsisten. Menerbitkan
	// JTI baru di jalur tenggang akan membuat empat klien memegang token yang
	// tidak pernah terdaftar, dan pemakaian berikutnya terbaca sebagai
	// pencurian — kesalahan yang justru ingin dicegah tenggang ini.
	Tukar(ctx context.Context, keluarga, jtiLama, jtiBaru string, umur, tenggang time.Duration) (StatusTukar, string, error)
	CabutKeluarga(ctx context.Context, keluarga string) error
}

type Auth struct {
	kunci     *PenyediaKunci
	penyimpan PenyimpanRefresh
}

func NewAuth(k *PenyediaKunci, p PenyimpanRefresh) *Auth { return &Auth{kunci: k, penyimpan: p} }

func (a *Auth) tandatangani(klaim jwt.Claims) (string, error) {
	k := a.kunci.Penandatangan()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, klaim)
	tok.Header["kid"] = k.ID // WAJIB, agar verifier bisa memilih kunci
	return tok.SignedString(k.Privat)
}

// Login menerbitkan pasangan token dan MEMBUKA keluarga sesi baru.
func (a *Auth) Login(ctx context.Context, userID string, roles []string) (*TokenPair, error) {
	keluarga, err := acakID()
	if err != nil {
		return nil, err
	}
	jti, err := acakID()
	if err != nil {
		return nil, err
	}
	if err := a.penyimpan.Simpan(ctx, keluarga, jti, umurRefreshToken); err != nil {
		return nil, fmt.Errorf("save session: %w", err)
	}
	return a.terbitkanPasangan(userID, roles, keluarga, jti)
}

// terbitkanPasangan menandatangani access+refresh dengan JTI yang SUDAH
// ditentukan pemanggil. Pendaftaran ke penyimpan dilakukan pemanggil, karena
// hanya dia yang tahu apakah ini sesi baru (Simpan) atau rotasi (Tukar).
func (a *Auth) terbitkanPasangan(userID string, roles []string, keluarga, jti string) (*TokenPair, error) {
	now := time.Now().UTC()

	accStr, err := a.tandatangani(AccessClaims{
		UserID: userID,
		Roles:  roles,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(umurAccessToken)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    penerbit,
			Subject:   userID,
			Audience:  []string{audAccess},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("sign access token: %w", err)
	}

	refStr, err := a.tandatangani(RefreshClaims{
		Keluarga: keluarga,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(umurRefreshToken)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    penerbit,
			Subject:   userID,
			Audience:  []string{audRefresh}, // audience TERPISAH dari access
			ID:        jti,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("sign refresh token: %w", err)
	}
	return &TokenPair{AccessToken: accStr, RefreshToken: refStr}, nil
}

// Refresh menukar refresh token dengan pasangan baru, dan mendeteksi pemakaian
// ulang.
func (a *Auth) Refresh(ctx context.Context, refreshStr string, roles []string) (*TokenPair, error) {
	var klaim RefreshClaims
	if err := a.uraikan(refreshStr, &klaim, audRefresh); err != nil {
		slog.WarnContext(ctx, "refresh token rejected", "error", err)
		return nil, ErrInvalidToken
	}

	calonJTI, err := acakID()
	if err != nil {
		return nil, err
	}

	status, jtiTerbit, err := a.penyimpan.Tukar(
		ctx, klaim.Keluarga, klaim.ID, calonJTI, umurRefreshToken, tenggangRotasi)
	if err != nil {
		return nil, fmt.Errorf("exchange refresh token: %w", err)
	}

	if status == TukarDipakaiUlang {
		// Yang benar BUKAN sekadar menolak permintaan ini. Pada titik ini
		// pemakai sah dan pencuri sama-sama memegang token dari keluarga yang
		// sama, dan tidak ada cara mengetahui mana yang mana. Seluruh keluarga
		// dicabut dan pengguna login ulang.
		if err := a.penyimpan.CabutKeluarga(ctx, klaim.Keluarga); err != nil {
			return nil, fmt.Errorf("revoke session family: %w", err)
		}
		slog.ErrorContext(ctx, "refresh token reused, session family revoked",
			"family", klaim.Keluarga, "subject", klaim.Subject)
		return nil, ErrTokenReused
	}

	return a.terbitkanPasangan(klaim.Subject, roles, klaim.Keluarga, jtiTerbit)
}
```

Verifikasi access token — perhatikan pemisahan galat detail (untuk log) dari galat yang dikembalikan (untuk klien):

```go
package security

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// uraikan melakukan verifikasi penuh dan mengembalikan galat DETAIL, agar
// bisa dicatat. Ia tidak boleh dipanggil langsung dari handler.
func (a *Auth) uraikan(tokenStr string, klaim jwt.Claims, audience string) error {
	token, err := jwt.ParseWithClaims(tokenStr, klaim, func(t *jwt.Token) (any, error) {
		// Pemeriksaan ini BUKAN yang pertama menyala.
		//
		// jwt/v5 memeriksa WithValidMethods SEBELUM memanggil keyfunc, jadi
		// token `alg: none` sudah ditolak di sana dengan pesan "signing method
		// none is invalid" — keyfunc ini tidak pernah dijangkau. Ia tetap ada
		// sebagai lapis kedua: kalau suatu saat WithValidMethods terhapus saat
		// refactor, kelas serangan yang sama masih tertutup.
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing algorithm: %v", t.Header["alg"])
		}
		kid, _ := t.Header["kid"].(string)
		return a.kunci.Verifikator(kid)
	},
		// Leeway berlaku dua arah: ia memaafkan jam yang lambat pada `nbf`/`iat`,
		// TETAPI juga memperpanjang umur efektif setiap token sebesar nilai yang
		// sama. Pilih sekecil mungkin yang masih menutupi selisih NTP nyata.
		jwt.WithLeeway(5*time.Second),
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithAudience(audience),
		jwt.WithIssuer(penerbit),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return err
	}
	if !token.Valid {
		return errors.New("token parsed but marked invalid")
	}
	return nil
}

// VerifyAccessToken adalah pintu untuk handler. Ia mengembalikan SATU galat
// generik apa pun penyebabnya.
func (a *Auth) VerifyAccessToken(ctx context.Context, header string) (*AccessClaims, error) {
	tokenStr, ok := potongBearer(header)
	if !ok {
		return nil, ErrInvalidToken
	}
	var klaim AccessClaims
	if err := a.uraikan(tokenStr, &klaim, audAccess); err != nil {
		slog.WarnContext(ctx, "access token rejected", "error", err)
		return nil, ErrInvalidToken
	}
	return &klaim, nil
}

// potongBearer menuntut skema `Bearer` yang benar-benar ada.
//
// strings.TrimPrefix(s, "Bearer ") diam-diam menerima token telanjang tanpa
// skema apa pun, dan menolak `bearer ` huruf kecil yang sah menurut RFC 7235
// (skema autentikasi bersifat case-insensitive).
func potongBearer(header string) (string, bool) {
	bagian := strings.Fields(header)
	if len(bagian) != 2 || !strings.EqualFold(bagian[0], "Bearer") {
		return "", false
	}
	return bagian[1], true
}
```

Uji batas keamanan — memakai galat sentinel pustaka, bukan pencocokan teks:

```go
package security

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// penyimpanMemori adalah implementasi PenyimpanRefresh untuk uji.
type jejakRotasi struct {
	batas     time.Time
	pengganti string // JTI yang SUDAH diterbitkan untuk penukaran ini
}

type penyimpanMemori struct {
	mu       sync.Mutex
	aktif    map[string]string      // keluarga -> jti aktif
	dirotasi map[string]jejakRotasi // keluarga|jti -> jejak
}

func newPenyimpanMemori() *penyimpanMemori {
	return &penyimpanMemori{aktif: map[string]string{}, dirotasi: map[string]jejakRotasi{}}
}

func (p *penyimpanMemori) Simpan(_ context.Context, keluarga, jti string, _ time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.aktif[keluarga] = jti
	return nil
}

func (p *penyimpanMemori) Tukar(_ context.Context, keluarga, jtiLama, jtiBaru string, _, tenggang time.Duration) (StatusTukar, string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	kunci := keluarga + "|" + jtiLama
	if p.aktif[keluarga] == jtiLama {
		p.aktif[keluarga] = jtiBaru
		p.dirotasi[kunci] = jejakRotasi{batas: time.Now().Add(tenggang), pengganti: jtiBaru}
		return TukarBerhasil, jtiBaru, nil
	}
	if j, ada := p.dirotasi[kunci]; ada && time.Now().Before(j.batas) {
		// Kembalikan JTI yang SAMA seperti penukaran pertama, bukan yang baru.
		return TukarDalamTenggang, j.pengganti, nil
	}
	return TukarDipakaiUlang, "", nil
}

func (p *penyimpanMemori) lewatiTenggang() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, j := range p.dirotasi {
		j.batas = time.Now().Add(-time.Second)
		p.dirotasi[k] = j
	}
}

func (p *penyimpanMemori) CabutKeluarga(_ context.Context, keluarga string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.aktif, keluarga)
	for k := range p.dirotasi {
		if strings.HasPrefix(k, keluarga+"|") {
			delete(p.dirotasi, k)
		}
	}
	return nil
}

func authUji(t *testing.T) (*Auth, *penyimpanMemori) {
	t.Helper()
	pk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	simpan := newPenyimpanMemori()
	return NewAuth(NewPenyediaKunci(Kunci{ID: "key-1", Privat: pk}), simpan), simpan
}

func TestAlurNormalDanKlaim(t *testing.T) {
	a, _ := authUji(t)
	ctx := context.Background()

	pasangan, err := a.Login(ctx, "usr_998877", []string{"admin"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	klaim, err := a.VerifyAccessToken(ctx, "Bearer "+pasangan.AccessToken)
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if klaim.Subject != "usr_998877" {
		t.Errorf("Subject = %q, want usr_998877", klaim.Subject)
	}
}

// Uji ini yang paling penting di berkas, dan sebelumnya tidak ada sama sekali:
// memakai ulang refresh token yang sudah dirotasi WAJIB mencabut seluruh
// keluarga sesi, bukan sekadar menolak satu permintaan.
func TestPemakaianUlangRefreshMencabutSeluruhKeluarga(t *testing.T) {
	a, simpan := authUji(t)
	ctx := context.Background()

	awal, err := a.Login(ctx, "usr_1", nil)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	baru, err := a.Refresh(ctx, awal.RefreshToken, nil)
	if err != nil {
		t.Fatalf("First refresh: %v", err)
	}

	// Pencuri memakai token LAMA setelah jendela tenggang berlalu.
	simpan.lewatiTenggang()

	if _, err := a.Refresh(ctx, awal.RefreshToken, nil); !errors.Is(err, ErrTokenReused) {
		t.Fatalf("reuse err = %v, want ErrTokenReused", err)
	}

	// Dan token SAH milik pengguna pun ikut mati — itu memang yang diinginkan.
	if _, err := a.Refresh(ctx, baru.RefreshToken, nil); !errors.Is(err, ErrTokenReused) {
		t.Fatalf("valid token after revocation err = %v, want rejected", err)
	}
}

// Beberapa permintaan refresh yang tiba bersamaan (SPA memanggil 5 API
// sekaligus) TIDAK boleh disalahartikan sebagai pencurian. Lihat Kasus Tepi 2.
func TestRefreshBersamaanDalamTenggangTidakDianggapPencurian(t *testing.T) {
	a, simpan := authUji(t)
	ctx := context.Background()

	awal, err := a.Login(ctx, "usr_2", nil)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	pertama, err := a.Refresh(ctx, awal.RefreshToken, nil)
	if err != nil {
		t.Fatalf("First refresh: %v", err)
	}
	kedua, err := a.Refresh(ctx, awal.RefreshToken, nil)
	if err != nil {
		t.Fatalf("second refresh in grace period rejected: %v", err)
	}

	// Keduanya WAJIB menerima refresh token dengan JTI yang sama. Bila jalur
	// tenggang menerbitkan JTI baru, klien kedua memegang token yang tidak
	// pernah terdaftar — dan pemakaian berikutnya terbaca sebagai pencurian,
	// tepat kesalahan yang ingin dicegah tenggang ini.
	var jtiPertama, jtiKedua RefreshClaims
	if err := a.uraikan(pertama.RefreshToken, &jtiPertama, audRefresh); err != nil {
		t.Fatalf("parse first token: %v", err)
	}
	if err := a.uraikan(kedua.RefreshToken, &jtiKedua, audRefresh); err != nil {
		t.Fatalf("parse second token: %v", err)
	}
	if jtiPertama.ID != jtiKedua.ID {
		t.Fatalf("different JTI in grace window: %q vs %q", jtiPertama.ID, jtiKedua.ID)
	}

	// Dan token itu memang yang aktif — refresh berikutnya harus lolos.
	simpan.lewatiTenggang()
	if _, err := a.Refresh(ctx, kedua.RefreshToken, nil); err != nil {
		t.Fatalf("grace period token rejected on subsequent refresh: %v", err)
	}
}

func TestBatasKeamananUraikan(t *testing.T) {
	a, _ := authUji(t)
	ctx := context.Background()

	pasangan, err := a.Login(ctx, "usr_3", nil)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	bagian := strings.Split(pasangan.AccessToken, ".")
	if len(bagian) != 3 {
		t.Fatalf("abnormal JWT structure")
	}

	// Asersi memakai galat SENTINEL jwt/v5, bukan pencocokan substring pesan.
	// Versi lama mencocokkan teks — dan salah satunya, "unexpected signing
	// algorithm" untuk alg:none, TIDAK PERNAH muncul: WithValidMethods
	// memeriksa metode sebelum keyfunc dipanggil, sehingga pesan yang keluar
	// adalah "signing method none is invalid". Uji keamanan itu GAGAL.
	kasus := []struct {
		nama  string
		token string
		mau   error
	}{
		{
			nama:  "tampered payload",
			token: fmt.Sprintf("%s.%s.%s", bagian[0], "eyJ1aWQiOiJ1c3JfYWRtaW4ifQ", bagian[2]),
			mau:   jwt.ErrTokenSignatureInvalid,
		},
		{
			nama:  "alg none",
			token: fmt.Sprintf("%s.%s.", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0", bagian[1]),
			mau:   jwt.ErrTokenSignatureInvalid, // dilaporkan WithValidMethods
		},
		{
			nama:  "refresh token used as access token",
			token: pasangan.RefreshToken,
			mau:   jwt.ErrTokenInvalidAudience,
		},
	}
	for _, k := range kasus {
		var klaim AccessClaims
		err := a.uraikan(k.token, &klaim, audAccess)
		if !errors.Is(err, k.mau) {
			t.Errorf("%s: err = %v, want %v", k.nama, err, k.mau)
		}
		// Pintu publiknya WAJIB menyeragamkan semuanya menjadi satu galat.
		if _, err := a.VerifyAccessToken(ctx, "Bearer "+k.token); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s: public err = %v, want ErrInvalidToken", k.nama, err)
		}
	}
}

func TestRotasiKunciTidakMembatalkanTokenLama(t *testing.T) {
	a, _ := authUji(t)
	ctx := context.Background()

	lama, err := a.Login(ctx, "usr_4", nil)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}

	pk2, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	a.kunci.Rotasi(Kunci{ID: "key-2", Privat: pk2})

	// Token yang ditandatangani kunci lama HARUS tetap sah selama kunci lama
	// belum dibuang. Tanpa `kid`, ini mustahil — dan rotasi kunci akan
	// mem-401-kan seluruh pengguna sekaligus.
	if _, err := a.VerifyAccessToken(ctx, "Bearer "+lama.AccessToken); err != nil {
		t.Fatalf("token from old key rejected after rotation: %v", err)
	}

	a.kunci.Buang("key-1")
	if _, err := a.VerifyAccessToken(ctx, "Bearer "+lama.AccessToken); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("token from discarded key = %v, want rejected", err)
	}
}

func TestPotongBearer(t *testing.T) {
	kasus := map[string]bool{
		"Bearer abc": true, "bearer abc": true,
		"abc": false, "": false, "Bearer": false, "Basic abc": false,
	}
	for masukan, mau := range kasus {
		if _, ok := potongBearer(masukan); ok != mau {
			t.Errorf("potongBearer(%q) = %v, mau %v", masukan, ok, mau)
		}
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
| Lonjakan `401` setelah rotasi kunci | ada tidaknya header `kid` | Tanpa `kid`, tumpang tindih kunci mustahil; rotasi = pemutusan serentak |
| Token pod A ditolak pod B | dari mana kunci berasal | Kunci dibangkitkan per proses, bukan dari sumber bersama |
| Sesi putus massal saat trafik ramai | jendela tenggang rotasi | Refresh bersamaan disalahartikan sebagai pencurian |
| Token tanpa `exp` diterima | `jwt.WithExpirationRequired()` | Klaim yang tidak ada tidak divalidasi |

```bash
# Validasi metode penandatanganan WAJIB eksplisit -- ini baris paling penting
grep -rn -A5 'jwt.Parse\|ParseWithClaims' --include='*.go' . | grep -i 'SigningMethod'

# Umur token yang benar-benar diterbitkan
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="token_issued") | .ttl_seconds' | sort -n | uniq -c

# Alasan token ditolak -- pola tak terduga di sini layak diselidiki
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="token_rejected") | .reason' | sort | uniq -c | sort -rn

# Refresh token yang dipakai ulang = indikasi pencurian
kubectl logs -l app=api --since=24h | grep -c 'refresh_reused'

# Kunci dibangkitkan per proses? Ini membuat sistem gagal begitu replika > 1.
grep -rn 'rsa.GenerateKey' --include='*.go' . | grep -v '_test.go'

# Token yang beredar WAJIB punya `kid`, atau rotasi kunci mustahil dilakukan mulus
echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null | jq '.kid // "TIDAK ADA kid"'
```
