# Panduan Definitif: Password Security dengan Argon2id

> **Berlaku:** Go 1.21+ · `golang.org/x/crypto/argon2` · **Lihat juga:** `security_owasp/jwt_dual_token_auth.md` · `security_owasp/aes_gcm_cryptography.md` · `observability_resilience/rate_limiting_patterns.md` · `security_owasp/audit_logging_scrubbing.md`

## 1. Konsep dan Internals (Technical Depth)

Standar pengamanan kata sandi berevolusi dengan pesat, menanggapi melimpahnya komputasi GPU dan ASIC murah di tangan *hacker*. Menggunakan SHA256 atau MD5 saat ini disamakan dengan menyimpan password dalam plain-text. Pemenang dari komite *Password Hashing Competition (PHC)* internasional adalah algoritme **Argon2**, yang hadir dalam varian **Argon2id**.

1. **Mengapa tidak Bcrypt/Scrypt?**: Walau bcrypt lambat pada CPU, ia tidak menghabiskan cukup memori (RAM), sehingga *hacker* dapat membeli ribuan GPU modern dan mengeksekusi perhitungan paralel. Argon2id mengatasi masalah ini dengan mekanisme resistensi hibrid.
2. **Memory-Hard (Tahan GPU)**: Argon2 memerlukan alokasi block memori raksasa (*memory cost*, parameter `m`)—misalnya 64MB atau 128MB. GPU modern, walau memiliki ribuan *compute cores*, dibatasi oleh *Video RAM* yang spesifik. VRAM habis = Paralelisasi gagal.
3. **Time-Cost (Tahan CPU)**: Kontrol iterasi eksekusi matematika (parameter `t`).
4. **Side-Channel Resistance**: Argon2i dirancang untuk tahan terhadap ancaman tebakan berdasarkan waktu operasional CPU yang dapat dimonitor melalui pergerakan cache mesin.
5. **Format Standard (PHC String Format)**: Agar kita bisa memperbarui (upgrade) parameter algoritma di masa depan tanpa harus me-reset semua password pengguna, kita harus menyimpan seluruh komponennya dengan format modular string: `$argon2id$v=19$m=65536,t=3,p=4$saltB64$hashB64`.

## 2. Diagram ASCII: Hashing Flow Dinamis

```text
[ Plaintext Password ("supersecret") ]     [ Secure Random Salt (16-bytes) ]
                |                                          |
                +--------------------+---------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                  Argon2id Algorithm Factory Engine                      |
|  (Time: 3 passes) | (Memory: 64MB dialokasikan) | (Threads: 4 Workers)  |
|         -- CPU terikat penuh, Memory cache dipenuhi data blok --        |
+-------------------------------------------------------------------------+
                                     |
                                     v
                           [ 32-byte Raw Hash ]
                                     |
                                     +------------------+
                                                        |
       +--------------+------------+-------+--------+---+-----+-----+
PHC:   | $argon2id$v= | 19$m=65536 | ,t=3, | p=4$   | saltB64 | $   | hashB64 
       +--------------+------------+-------+--------+---+-----+-----+
                                     |
             [ String utuh ini yang di-INSERT ke Database Column ]
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Fast Hashing Algorithms (SHA-256) Tanpa Salt

**Mengapa berbahaya (Exploit Vector)**: SHA-256 adalah algoritme kriptografi yang diciptakan untuk menjadi *cepat dan murah*. Dalam kondisi *Offline Dictionary Attack* atau jika Database Anda bocor, sebuah rig multi-GPU RTX 4090 dapat menghitung **miliaran SHA-256 hashes per detik**. Menghancurkan 1 juta row pengguna dalam hitungan menit menggunakan *Rainbow Tables*.

```go
// VULNERABLE: SHA256 / Fast Hashing
func hashPasswordVulnerable(password string) string {
	// ❌ BAD: Kecepatan terlalu tinggi (Hacker menang), tiada perlindungan terhadap pre-computed table (Rainbow Tables)
	h := sha256.New()
	h.Write([]byte(password)) 
	return hex.EncodeToString(h.Sum(nil))
}
```

```go
// ✅ GOOD: Menggunakan Argon2id yang akan menduduki CPU selama ratusan milidetik dengan buffer RAM.
// (Lihat contoh implementasi production di section 5).
```

### ❌ Anti-Pattern 2: Timing Attack pada Verifikasi

**Mengapa berbahaya (Exploit Vector)**: Operasi string operator `==` di Go secara internal merupakan `bytes.Equal()`. Algoritme komparasi bahasa pemrograman konvensional akan segera berhenti mengeksekusi jika menemukan *byte* pertama yang tidak cocok. Attacker (via koneksi konstan) dapat mengukur perbedaan 0.5ms *waktu respons server* untuk membedakan tebakan karakter `a` (langsung ditolak) vs `x` (karena *byte* pertama benar, butuh waktu CPU lebih ekstra sebelum gagal di byte ke-2). Sedikit demi sedikit hash terbongkar dari luar *blackbox*.

```go
// VULNERABLE: Constant Timing Leak
func verifyHashVulnerable(inputHash, dbHash []byte) bool {
	// ❌ BAD: Waktu kembali tidak konstan (Early escape).
	return string(inputHash) == string(dbHash) 
}
```

```go
// ✅ GOOD: Constant Time Compare (Subtle Library)
func verifyHashSafe(inputHash, dbHash []byte) bool {
	// Selalu menghabiskan waktu evaluasi array O(N) ke byte terakhir tanpa henti.
	return subtle.ConstantTimeCompare(inputHash, dbHash) == 1
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Denial of Service (DoS) via "Billion Laughs" Password**: Implementasi hashing Argon2id sengaja membebani *server resources*. Jika *attacker* mengirimkan satu juta karakter (1 MB) via input payload password, fungsi *hash* akan mengkonsumsi waktu CPU luar biasa panjang (OOM server-side CPU DoS). **Selalu batasi maksimal panjang password yang diterima menjadi 72-128 karakter sebelum dilempar ke library kriptografi.** (Lihat `maxPasswordLength`).
2. **Kelelahan RAM Kolektif (Concurrent Auth Flooding)**: Jika Anda mengatur *Memory Cost* pada $64MB$ per panggilan `argon2.IDKey`, maka $100$ panggilan login HTTP serentak akan menghabiskan **6.4 Gigabyte RAM**. Aplikasi backend Go dengan pod kecil ($512MB$ RAM di K8S) akan seketika *Out of Memory Killed* (OOMKill) oleh Linux kernel `oom_reaper`. Solusinya adalah melakukan *Rate Limiting* / antrian (semaphore/worker pool terbatas di Golang untuk max $N$ *concurrent login execution*), bukan membatasi RAM.
3. **Empty String Parsing**: Anda harus selalu melakukan `.TrimSpace()` dan menolak password berstatus string kosong `""` atau hanya berisi kombinasi spasi secara dini. Jangan biarkan *argon2* bekerja pada data hampat yang buang-buang resource sistem.

## 5. Production-Ready Go Code

Kode di bawah ini memberikan fungsi *encoding & decoding* format PHC standard menggunakan Argon2id `golang.org/x/crypto/argon2` dan *subtle constant time comparison*.

```go
package security

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

var (
	ErrPasswordTooLong = errors.New("password length exceeds maximum allowed")
	ErrPasswordEmpty   = errors.New("password cannot be empty")
	ErrInvalidFormat   = errors.New("invalid stored hash format")
)

// Profil Parameter Argon2id (Rekomendasi OWASP)
// Bisa disesuaikan dengan spek server. Gunakan worker limit jika concurrent rate tinggi.
const (
	timeCost         = 3         // t: Iterasi CPU (makin tinggi, makin tahan CPU brute-force)
	memoryCost       = 64 * 1024 // m: Memori buffer (64 MB, tahan ASIC/GPU memory limits)
	threads          = 4         // p: Parallel worker per perhitungan
	hashLength       = 32        // 256-bit hash key
	saltLength       = 16        // 128-bit salt entropy
	maxPassLength    = 128       // Mitigasi Hash DoS payload
)

// HashPassword mengenkripsi dan memformat string raw ke standar modular PHC.
// Context digunakan untuk melacak tracing timeout dari handler caller (opsional namun best-practice)
func HashPassword(ctx context.Context, password string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("context timeout: %w", err)
	}

	trimmed := strings.TrimSpace(password)
	if trimmed == "" {
		return "", ErrPasswordEmpty
	}
	if len(password) > maxPassLength {
		return "", ErrPasswordTooLong
	}

	// 1. Ekstrak entropy acak (Salt)
	salt := make([]byte, saltLength)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("entropy error for salt: %w", err)
	}

	// 2. Hash algoritma inti (CPU bound operations)
	rawHash := argon2.IDKey([]byte(password), salt, timeCost, uint32(memoryCost), uint8(threads), hashLength)

	// 3. Konversi format
	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(rawHash)
	
	// Format string modular -> $argon2id$v=19$m=65536,t=3,p=4$salt...$hash...
	encodedHash := fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memoryCost, timeCost, threads, b64Salt, b64Hash,
	)

	return encodedHash, nil
}

// VerifyPassword membandingkan masukan kata sandi raw terhadap field encoded database PHC.
func VerifyPassword(ctx context.Context, password, encodedHash string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, fmt.Errorf("context timeout: %w", err)
	}

	if len(password) > maxPassLength {
		// Evaluasi cepat tanpa error untuk menghindari info leaking
		return false, nil 
	}

	// 1. Parse struktur PHC format
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 {
		return false, ErrInvalidFormat
	}

	if parts[1] != "argon2id" {
		return false, fmt.Errorf("unsupported algorithm: %s", parts[1])
	}

	var version, memCost, tCost, thrds uint32
	_, err := fmt.Sscanf(parts[2], "v=%d", &version)
	if err != nil {
		return false, err
	}

	_, err = fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memCost, &tCost, &thrds)
	if err != nil {
		return false, err
	}

	// 2. Decode String ke Bytes Array
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("base64 salt error: %w", err)
	}

	decodedDBHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("base64 hash error: %w", err)
	}

	// 3. Re-hash parameter menggunakan parameter yang diekstrak
	inputHash := argon2.IDKey([]byte(password), salt, tCost, memCost, uint8(thrds), uint32(len(decodedDBHash)))

	// 4. Verifikasi Konstan. 1 = true (cocok), 0 = false (gagal)
	if subtle.ConstantTimeCompare(decodedDBHash, inputHash) == 1 {
		return true, nil
	}
	
	return false, nil
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestArgon2idSecurityBoundaries(t *testing.T) {
	ctx := context.Background()
	password := "Secure$Passw0rd_32!"

	// 1. Happy Path - Hashing
	hashString, err := HashPassword(ctx, password)
	if err != nil {
		t.Fatalf("Failed to hash standard password: %v", err)
	}
	
	if !strings.HasPrefix(hashString, "$argon2id$v=") {
		t.Errorf("Invalid PHC hash prefix: %s", hashString)
	}

	// 2. Happy Path - Verification Match
	match, err := VerifyPassword(ctx, password, hashString)
	if err != nil || !match {
		t.Errorf("Verification failed for correct password")
	}

	// 3. Verification Boundary - Wrong Password (1 char diff)
	wrongPassword := "Secure$Passw0rd_32?" // ? diff
	match, err = VerifyPassword(ctx, wrongPassword, hashString)
	if err != nil || match {
		t.Errorf("Expected false match for wrong password without error")
	}

	// 4. Input Validation Boundary - Length DoS Mitigation
	longPass := strings.Repeat("a", 150) // Melewati maxPassLength
	_, err = HashPassword(ctx, longPass)
	if err != ErrPasswordTooLong {
		t.Errorf("Expected ErrPasswordTooLong, got: %v", err)
	}

	// 5. Input Validation Boundary - Empty String bypass
	_, err = HashPassword(ctx, "   ")
	if err != ErrPasswordEmpty {
		t.Errorf("Expected ErrPasswordEmpty, got: %v", err)
	}

	// 6. DB Record Boundary - Malformed Hash string Format Tampering
	malformedHash := "$argon2id$v=19$m=65536,t=3,p=4$malformed-salt$hash"
	_, err = VerifyPassword(ctx, password, malformedHash)
	if err == nil {
		t.Errorf("Expected error when verifying malformed hash string format")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Parameter yang disalin dari tutorial tanpa diukur di mesin produksi.** Parameter terlalu ringan tidak melindungi apa pun; terlalu berat mengubah endpoint login menjadi vektor DoS terhadap diri sendiri. Ukur, targetkan sekitar 100–500 ms per verifikasi di perangkat keras produksi.
- **Argon2id di endpoint yang tidak dibatasi laju.** Setiap percobaan memakan memori dan CPU yang signifikan — itulah gunanya, dan itu pula yang bisa dipakai penyerang untuk menjatuhkan Anda dengan seratus permintaan.
- **Menyimpan parameter terpisah dari hash.** Format hash Argon2 sudah memuat parameternya. Menyimpannya terpisah membuat rotasi parameter mustahil dilakukan bertahap.
- **MD5, SHA-1, atau SHA-256 polos untuk kata sandi.** Cepat adalah **kelemahan** di sini. GPU modern membuat "cepat" berarti miliaran percobaan per detik terhadap dump yang bocor.
- **Membandingkan hash dengan `==`.** Perbandingan yang tidak konstan waktu membocorkan informasi lewat waktu respons. `subtle.ConstantTimeCompare` yang benar.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Endpoint login lambat lalu seluruh layanan lambat | memori dan CPU saat login | Parameter Argon2 berat tanpa rate limiting |
| Waktu respons login berbeda untuk pengguna ada/tidak ada | perbandingan konstan waktu | Enumerasi pengguna lewat timing |
| Verifikasi kata sandi < 10 ms | parameter yang dipakai | Terlalu ringan untuk melindungi |
| Hash lama tidak bisa diverifikasi | apakah parameter ada di hash | Parameter disimpan terpisah dan berubah |
| Ribuan login gagal dari satu sumber | sebaran IP/akun | Serangan credential stuffing sedang berlangsung |

```bash
# Algoritma cepat yang tidak boleh dipakai untuk kata sandi
grep -rniE 'md5\.|sha1\.|sha256\.Sum' --include='*.go' . | grep -iE 'pass|sandi|kredensial'
gosec -include=G401,G505 ./...

# Waktu verifikasi: konsisten dan berada di rentang 50-500 ms
for i in 1 2 3; do
  curl -sw '%{time_total}\n' -o /dev/null -X POST localhost:8080/login \
    -d '{"email":"ada@contoh.id","sandi":"salah"}'
done

# Credential stuffing terlihat sebagai banyak akun dari sedikit sumber
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="login_gagal") | .ip' | sort | uniq -c | sort -rn | head
```
