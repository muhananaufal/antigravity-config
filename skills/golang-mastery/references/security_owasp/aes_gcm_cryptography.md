# Panduan Definitif: Kriptografi AES-256-GCM (AEAD) di Go

> **Berlaku:** Go 1.21+ · `crypto/aes`, `crypto/cipher` · **Lihat juga:** `security_owasp/secret_management_vault.md` · `security_owasp/argon2_password_security.md` · `cybersecurity_zerotrust/secrets_rotation_automated.md` · `security_owasp/audit_logging_scrubbing.md`

## 1. Konsep dan Internals (Technical Depth)

Advanced Encryption Standard (AES) adalah cipher blok yang banyak digunakan. Namun, blok cipher mentah seperti AES-ECB dan AES-CBC rentan terhadap memanipulasi integritas data (*malleability attacks* atau *Padding Oracle Attack*). Di dalam standar kriptografi modern, Anda diwajibkan menggunakan **AEAD (Authenticated Encryption with Associated Data)**. Algoritme andalannya adalah **AES-256-GCM**.

1. **AES-256**: Menggunakan *Master Key* berukuran 256-bit (32 byte). Hal ini secara matematis kebal terhadap brute-force dan memberikan pertahanan *Post-Quantum* yang solid (berbeda dengan kunci asimetris seperti RSA/ECC yang rentan jika Shor's Algorithm pada komputer kuantum tercapai).
2. **GCM (Galois/Counter Mode)**: Mode cipher berkinerja sangat tinggi yang digerakkan oleh hardware (AES-NI instruksi di CPU modern). GCM memberikan kerahasiaan sekaligus integritas: jika ada pihak yang mengubah sekecil satu bit saja pada *ciphertext*, dekripsi GCM di sisi server akan langsung menolak dan melaporkan kesalahan otentikasi.
3. **Nonce (Number Used Once)**: GCM membutuhkan *Nonce* 12-byte (96-bit). *Nonce* tidak rahasia dan bisa (harus) diletakkan bersebelahan dengan data enkripsi, TETAPI secara ketat **TIDAK BOLEH** digunakan dua kali di bawah kunci enkripsi (*Data Encryption Key*) yang sama. Pemakaian ulang Nonce menghancurkan sepenuhnya jaminan kerahasiaan AEAD GCM.
4. **HKDF (HMAC-based Key Derivation Function)**: Kunci enkripsi tidak pernah secara mentah ditarik dari string password atau dikodekan di file. Anda sebaiknya mengambil satu *Master Secret Key*, kemudian menurunkannya via HKDF menjadi kunci spesifik domain. Contoh: Turunkan kunci terpisah untuk enkripsi *credit card* dan enkripsi *PII data*. 

## 2. Diagram ASCII: Alur Enkripsi AEAD

```text
[ Plaintext (Data rahasia) ]     [ Associated Data (AD) ]
            |                              | (AD bersifat opsional. 
            |                              |  Tidak terenkripsi, tetapi
            v                              v  diautentikasi oleh Tag)
+-------------------------------------------------------------+
|                     AES-256-GCM Core                        | <-- [ DEK (32-bytes) ]
| (Meng-XOR aliran data via Counter Mode & Auth via Galois)   | <-- [ Nonce (12-bytes)]
+-------------------------------------------------------------+
            |                              |
            v                              v
    [ Ciphertext ]               [ Auth Tag (16-bytes) ] 
            |                              |
            +-------+----------------------+
                    | (Data final digabung dan prepend Nonce untuk persistensi)
                    v
    [ Nonce (12b) + Ciphertext + Auth Tag (16b) ] ---> (Disimpan ke DB sebagai BLOB/B64)
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Reuse Nonce (Static Nonce)

**Mengapa berbahaya (Exploit Vector)**: AES-GCM secara fundamental adalah sebuah XOR *stream cipher*. Jika *nonce* statis digunakan berulang kali untuk pesan berbeda namun di-enkripsi dengan *Key* yang sama, XOR dari dua buah *ciphertext* tersebut akan sama persis dengan XOR dari dua *plaintext*-nya. Kelemahan fatal ini (dikenal sebagai serangan *Crib Dragging*) memungkinkan attacker membongkar pesan rahasia, dan memalsukan tag GCM tanpa harus tahu kuncinya.

```go
// VULNERABLE: Static Nonce Reuse
func encryptVulnerable(key []byte, plaintext []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	aesgcm, _ := cipher.NewGCM(block)
	
	// ❌ BAD: Menggunakan kata sandi hardcode atau nonce yang dapat diprediksi secara statis
	nonce := []byte("123456789012") // Bencana kriptografis nyata!
	
	ciphertext := aesgcm.Seal(nil, nonce, plaintext, nil)
	return ciphertext, nil
}
```

```go
// ✅ GOOD: Generate random 12-byte Nonce dengan entropi kuat
func encryptSafe(key []byte, plaintext []byte) ([]byte, error) {
	block, _ := aes.NewCipher(key)
	aesgcm, _ := cipher.NewGCM(block)
	
	// Generate random nonce from crypto/rand
	nonce := make([]byte, aesgcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("entropy failed: %w", err)
	}
	
	// Prepend nonce pada hasil untuk dekripsi nanti
	ciphertext := aesgcm.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}
```

### ❌ Anti-Pattern 2: Fallback ke Pseudo-Random Numbers (`math/rand`)

**Mengapa berbahaya (Exploit Vector)**: Jika *random entropy* sistem (`crypto/rand`) memunculkan error, developer kadang menangkap error itu dan menggunakan fungsi di `math/rand` untuk menghasilkan *nonce* alternatif agar sistem tidak *crash*. PRNG berbasis `math/rand` bersifat *deterministic* — nilainya mudah diprediksi. Attacker dapat memprediksi nonce ke-N, membuat celah Nonce Reuse *secara diam-diam*.

```go
// VULNERABLE: Fallback ke math/rand
func generateNonceVulnerable(size int) []byte {
	nonce := make([]byte, size)
	_, err := io.ReadFull(rand.Reader, nonce)
	if err != nil {
		// ❌ BAD: math.rand mudah diprediksi (Seed biasanya waktu boot)
		for i := 0; i < size; i++ {
			nonce[i] = byte(mathRand.Intn(256)) 
		}
	}
	return nonce
}
```

```go
// ✅ GOOD: Tolak (Fail-closed) dan stop operasi kriptografi jika entropi terkompromi
func generateNonceSafe(size int) ([]byte, error) {
	nonce := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("CRITICAL OS ENTROPY FAILURE: %w", err)
	}
	return nonce, nil
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Memori Habis (OOM) pada Enkripsi File Raksasa**: Fungsi `aesgcm.Seal()` di Go mengharuskan seluruh *plaintext* dan keluaran *ciphertext* diletakkan 100% secara sinkron dalam RAM (memori sistem). Jika Anda mengenkripsi file video 5GB dengan *Seal*, Anda akan terkena OOM *panic*. **Solusi**: Gunakan library `miscreant` (SIV) atau eksekusi *Chunking AEAD* standar (seperti library Google Tink) untuk streaming enkripsi chunk-per-chunk sebesar 64KB, atau iterasi manual dengan state rotasi kunci tiap *chunk*.
2. **Data Tampering & Silent Failure**: Metode `aesgcm.Open(..., ciphertext)` akan mengembalikan *error* bertuliskan `"cipher: message authentication failed"` jika ada sedikit byte yang berubah (karena *tag* 16-byte di ujung *ciphertext* tidak cocok dengan MAC hasil perhitungan mundur). Jangan pernah melogika fallback, atau mengembalikan data parsial. Begitu pesan *error* autentikasi diterima, hapus alokasi memori buffer dan tolak akses klien.
3. **Kelemahan Derivasi Kunci**: Key sepanjang 32-byte tidak sembarang Key. Pastikan panjang *key byte slice* eksak 16 (AES-128), 24 (AES-192), atau 32 (AES-256). Di Go, menginisialisasi cipher dengan salah ukuran akan membuat aplikasi *panic*. Menggunakan HMAC-based KDF dengan "salt" dari info konteks adalah jalan yang tepat.

## 5. Production-Ready Go Code

Kode lengkap dengan HKDF derivasi kunci, *memory-safe prepending*, dan penanganan error komprehensif.

```go
package crypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"testing"

	"golang.org/x/crypto/hkdf"
)

const (
	aes256KeySize = 32 // 256 bits
	gcmNonceSize  = 12 // 96 bits
)

var (
	ErrInvalidCiphertextLength = errors.New("ciphertext too short to contain nonce")
	ErrTamperedData            = errors.New("decryption failed or data tampered")
	ErrEntropyFailure          = errors.New("failed to read random entropy")
)

// DeriveKey menurunkan Data Encryption Key (DEK) aman berukuran 32-byte.
// Context/info harus spesifik domain, misal "payment_db_encryption_v1".
func DeriveKey(ctx context.Context, masterSecret []byte, salt, info []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context timeout: %w", err)
	}

	hash := sha256.New
	hkdfReader := hkdf.New(hash, masterSecret, salt, info)
	
	key := make([]byte, aes256KeySize)
	if _, err := io.ReadFull(hkdfReader, key); err != nil {
		return nil, fmt.Errorf("hkdf derivation failed: %w", err)
	}
	return key, nil
}

// Encrypt menyandikan plaintext dengan AES-256-GCM AEAD.
// Mengembalikan buffer tunggal berbentuk: [12-byte Nonce][Ciphertext][16-byte Auth Tag]
func Encrypt(ctx context.Context, key, plaintext, associatedData []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context timeout: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher init failed: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm init failed: %w", err)
	}

	// 1. Dapatkan Nonce secara random
	nonce := make([]byte, gcmNonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, ErrEntropyFailure
	}

	// 2. Alokasi kapasitas presisi (mengurangi realokasi buffer di memory)
	// capacity = nonceSize + plaintextSize + authTagSize(16)
	out := make([]byte, 0, gcmNonceSize+len(plaintext)+aesgcm.Overhead())
	
	// 3. Prepend nonce ke output buffer
	out = append(out, nonce...)
	
	// 4. Seal menyandikan data dan merekatkan hash di ujungnya.
	// Kita melampirkan array slice `out` pada argumen destination (`dst`)
	out = aesgcm.Seal(out, nonce, plaintext, associatedData)

	return out, nil
}

// Decrypt mengekstraksi nonce dan mendekripsi bytes AES-256-GCM.
func Decrypt(ctx context.Context, key, ciphertext, associatedData []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context timeout: %w", err)
	}

	if len(ciphertext) < gcmNonceSize+16 { // Minimal harus seluas Nonce dan Auth Tag overhead
		return nil, ErrInvalidCiphertextLength
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher init failed: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm init failed: %w", err)
	}

	// 1. Ekstrak nonce di bagian awal array
	nonce, encryptedMsg := ciphertext[:gcmNonceSize], ciphertext[gcmNonceSize:]
	
	// 2. Buka segel dekripsi
	// dst adalah nil untuk mengalokasikan array plaintext baru
	plaintext, err := aesgcm.Open(nil, nonce, encryptedMsg, associatedData)
	if err != nil {
		// Log internal err detail, tapi JANGAN PERNAH me-return string aslinya ke caller (Mencegah Oracle)
		return nil, ErrTamperedData
	}

	return plaintext, nil
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestAESGCMCryptography_SecurityBoundaries(t *testing.T) {
	ctx := context.Background()
	masterSecret := []byte("super-secret-master-key-that-is-long-enough")
	salt := []byte("random-salt-123")
	info := []byte("user-pii-data")
	
	associatedData := []byte("user-id-5000") // AD bisa digunakan untuk binding ciphertext ke record tertentu
	plaintext := []byte("Credit Card: 4111-...")

	// 1. Setup - Derive Key
	key, err := DeriveKey(ctx, masterSecret, salt, info)
	if err != nil || len(key) != 32 {
		t.Fatalf("Failed to derive key: %v", err)
	}

	// 2. Happy Path - Encrypt & Decrypt
	ciphertext, err := Encrypt(ctx, key, plaintext, associatedData)
	if err != nil {
		t.Fatalf("Encryption failed: %v", err)
	}

	decrypted, err := Decrypt(ctx, key, ciphertext, associatedData)
	if err != nil {
		t.Fatalf("Decryption failed: %v", err)
	}

	if string(decrypted) != string(plaintext) {
		t.Errorf("Expected %s, got %s", plaintext, decrypted)
	}

	// 3. Authenticity Boundary - Tampering the Ciphertext Body
	tamperedBody := make([]byte, len(ciphertext))
	copy(tamperedBody, ciphertext)
	tamperedBody[len(tamperedBody)-5] ^= 0x01 // flip 1 bit on the encrypted body
	
	_, err = Decrypt(ctx, key, tamperedBody, associatedData)
	if err != ErrTamperedData {
		t.Errorf("Expected ErrTamperedData on tampered payload, got: %v", err)
	}

	// 4. Authenticity Boundary - Tampering the Associated Data (AD)
	// Jika ciphertext utuh tetapi AD di-tamper (contoh: dipindah ke user 5001), maka harus gagal
	wrongAD := []byte("user-id-5001")
	_, err = Decrypt(ctx, key, ciphertext, wrongAD)
	if err != ErrTamperedData {
		t.Errorf("Expected ErrTamperedData on wrong Associated Data, got: %v", err)
	}
	
	// 5. Length Boundary - Short Ciphertext Bypass Attempt
	shortCipher := []byte("short")
	_, err = Decrypt(ctx, key, shortCipher, associatedData)
	if err != ErrInvalidCiphertextLength {
		t.Errorf("Expected ErrInvalidCiphertextLength, got: %v", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Menulis primitif kriptografi sendiri.** Bahkan **penggunaan** yang salah dari primitif yang benar sudah cukup untuk membuka sistem. Menulis primitifnya sendiri praktis selalu menghasilkan sesuatu yang lebih lemah, dan kelemahannya tidak akan terlihat dari uji mana pun.
- **Nonce dari penghitung atau waktu tanpa jaminan keunikan mutlak.** GCM **runtuh total** bila satu nonce dipakai ulang dengan kunci yang sama — bukan melemah: penyerang dapat memulihkan kunci otentikasi dan memalsukan pesan. Nonce WAJIB dari `crypto/rand`, atau dari penghitung yang dijamin tidak pernah berulang.
- **Satu operasi GCM untuk data yang sangat besar.** Ada batas aman jumlah data per kunci. Untuk berkas besar, enkripsi per potongan dengan nonce berbeda dan pengikat urutan.
- **Enkripsi tanpa rencana rotasi kunci.** Data yang dienkripsi hari ini akan hidup lebih lama daripada kunci yang aman hari ini. Simpan pengenal versi kunci bersama ciphertext sejak awal — menambahkannya belakangan berarti mendekripsi ulang semuanya.
- **Enkripsi sebagai pengganti kontrol akses.** Data yang bisa didekripsi oleh layanan yang bisa dijangkau penyerang tidak terlindungi oleh enkripsi itu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Nonce dihasilkan dari waktu atau penghitung | sumber nonce di kode | Risiko pemakaian ulang nonce — kegagalan total GCM |
| `math/rand` muncul di jalur kripto | import paket | Sumber acak tidak aman secara kriptografis |
| Ciphertext lama tidak bisa didekripsi | apakah versi kunci disimpan | Rotasi kunci tanpa penanda versi |
| Dekripsi gagal setelah rotasi | periode tumpang tindih kunci | Kunci lama dicabut sebelum semua data dimigrasi |
| Kunci sama dipakai lintas lingkungan | asal kunci per lingkungan | Bocornya staging berarti bocornya produksi |

```bash
# Penggunaan primitif kripto dan sumber acaknya
grep -rn 'cipher.NewGCM\|\.Seal(\|\.Open(' --include='*.go' .
grep -rn '"math/rand"' --include='*.go' . | grep -v '_test.go'

# gosec: G401 kripto lemah, G404 acak lemah, G407 nonce/IV hardcode
gosec -include=G401,G402,G404,G407 ./...
govulncheck ./...

# Versi kunci WAJIB tersimpan bersama ciphertext -- periksa formatnya
grep -rn 'versi_kunci\|key_version\|kid' --include='*.go' . | head
```
