# Panduan Definitif: Kriptografi AES-256-GCM (AEAD) di Go

> **Berlaku:** Go 1.21+ · `crypto/aes`, `crypto/cipher` · **Lihat juga:** `security_owasp/secret_management_vault.md` · `security_owasp/argon2_password_security.md` · `cybersecurity_zerotrust/secrets_rotation_automated.md` · `security_owasp/audit_logging_scrubbing.md`

## 1. Konsep dan Internals (Technical Depth)

Advanced Encryption Standard (AES) adalah cipher blok yang banyak digunakan. Namun, blok cipher mentah seperti AES-ECB dan AES-CBC rentan terhadap memanipulasi integritas data (*malleability attacks* atau *Padding Oracle Attack*). Di dalam standar kriptografi modern, Anda diwajibkan menggunakan **AEAD (Authenticated Encryption with Associated Data)**. Algoritme andalannya adalah **AES-256-GCM**.

1. **AES-256**: memakai kunci 256-bit (32 byte). Soal pasca-kuantum, ada nuansa yang justru menjadi ALASAN memilih 256 dan bukan 128: algoritme Grover memberi percepatan **kuadratik** terhadap cipher simetris, sehingga AES-256 secara efektif turun ke tingkat keamanan ~128 bit di hadapan komputer kuantum — masih sangat kuat, sementara AES-128 turun ke ~64 bit yang tidak lagi memadai. Jadi AES-256 bukan "kebal", melainkan **punya cadangan yang cukup**. Bandingkan dengan RSA/ECC yang dipatahkan algoritme Shor secara menyeluruh, bukan sekadar dilemahkan setengah.
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

1. **Memori Habis (OOM) pada Enkripsi Berkas Raksasa**: `Seal` menuntut seluruh plaintext dan ciphertext berada di RAM sekaligus. Berkas video 5 GB berarti belasan gigabyte teralokasi. **Solusinya adalah AEAD berpotongan** (streaming), dan Google Tink menyediakannya; `miscreant` yang dulu sering disebut sudah tidak dipelihara lagi dan sebaiknya tidak dipakai untuk kode baru.

   Bila Anda memotong sendiri, ada satu jebakan yang menghapus seluruh manfaat autentikasi dan hampir selalu terlewat: **potongan yang masing-masing valid tidak membuat aliran itu utuh.** Penyerang cukup **membuang potongan-potongan terakhir**, dan hasilnya tetap terdekripsi bersih — berkas yang terpotong terbaca sebagai berkas yang sah. Kontrak minimalnya:
   - nonce tiap potongan diturunkan dari penghitung urut, bukan diacak ulang (agar urutan tidak bisa ditukar);
   - nomor urut potongan ikut masuk ke associated data (menolak penukaran posisi);
   - potongan terakhir **ditandai** — misalnya satu byte penanda di dalam AD — sehingga pemotongan aliran terdeteksi sebagai kegagalan autentikasi, bukan sebagai akhir berkas.
2. **Data Tampering & Silent Failure**: Metode `aesgcm.Open(..., ciphertext)` akan mengembalikan *error* bertuliskan `"cipher: message authentication failed"` jika ada sedikit byte yang berubah (karena *tag* 16-byte di ujung *ciphertext* tidak cocok dengan MAC hasil perhitungan mundur). Jangan pernah melogika fallback, atau mengembalikan data parsial. Begitu pesan *error* autentikasi diterima, hapus alokasi memori buffer dan tolak akses klien.
3. **Yang benar-benar panic di API ini — dan yang tidak.** Klaim yang sering diulang bahwa "kunci salah ukuran membuat aplikasi panic" **tidak benar**: `aes.NewCipher` mengembalikan `KeySizeError`, sebuah galat biasa yang bisa Anda tangani. Yang **memang panic**:
   - `Seal`/`Open` dengan panjang nonce yang tidak cocok dengan `NonceSize()` AEAD — karena itu pakailah `aead.NonceSize()`, bukan konstanta `12` yang ditulis tangan;
   - `Seal` dengan plaintext melampaui batas GCM (~64 GiB), yang membawa kita ke butir berikutnya.

   Tetap validasi panjang kunci saat **start**, supaya kegagalannya muncul di sana dan bukan pada permintaan pertama yang kebetulan menyentuh baris bermasalah.

4. **Dua batas kuantitas yang harus jadi angka, bukan kalimat.** "Ada batas aman jumlah data per kunci" tidak bisa ditindaklanjuti siapa pun. Angkanya:
   - **Per pesan:** satu operasi GCM dibatasi ~64 GiB plaintext. Melewatinya membuat `Seal` panic.
   - **Per kunci:** dengan nonce ACAK 96-bit, NIST SP 800-38D membatasi **2^32 pemanggilan** per kunci. Di atas itu, peluang dua nonce bertabrakan tidak lagi dapat diabaikan — dan tabrakan nonce pada GCM bukan pelemahan bertahap: penyerang dapat memulihkan kunci otentikasi dan **memalsukan pesan apa pun**, bukan sekadar membaca satu.

   Hitung pemakaiannya dan tolak setelah batas tercapai, seperti `batasEnkripsiPerKunci` di §5. Kunci yang "cuma dipakai untuk PII" pada layanan 1.000 rps mencapai 2^32 dalam sekitar 50 hari.

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
	"sync/atomic"

	"golang.org/x/crypto/hkdf"
)

const (
	aes256KeySize = 32 // 256 bit
	formatVersion = 1  // versi format kotak, sekaligus penunjuk kunci
	headerLength  = 1  // satu byte versi di depan

	// NIST SP 800-38D membatasi GCM dengan nonce ACAK 96-bit pada 2^32
	// pemanggilan per kunci. Di atas itu, peluang dua nonce bertabrakan
	// (batas ulang tahun) tidak lagi dapat diabaikan — dan SATU tabrakan
	// saja sudah cukup untuk memulihkan kunci otentikasi GCM dan memalsukan
	// pesan, bukan sekadar membocorkan satu plaintext.
	maxEncryptionsPerKey = 1 << 32
)

var (
	ErrCiphertextLength = errors.New("ciphertext too short")
	ErrDataTampered     = errors.New("decryption failed or data tampered")
	ErrEntropyFailed    = errors.New("failed to read random entropy")
	ErrKeyVersion       = errors.New("unknown key version")
	ErrKeyQuotaExceeded = errors.New("key usage limit exceeded, rotation required")
)

// KeyRing memegang kunci aktif untuk enkripsi DAN kunci lama untuk dekripsi.
//
// Byte versi di depan kotak adalah bagian yang hilang dari versi sebelumnya,
// padahal bagian "Kapan JANGAN Pakai Ini" di berkas yang SAMA sudah
// menuntutnya: "Simpan pengenal versi kunci bersama ciphertext sejak awal —
// menambahkannya belakangan berarti mendekripsi ulang semuanya." Tanpa satu
// byte itu, memutar master key pada tabel berisi jutaan baris berubah dari
// penggantian konfigurasi menjadi proyek migrasi berminggu-minggu.
type KeyRing struct {
	activeVersion   byte
	keys            map[byte][]byte
	encryptionCount atomic.Uint64
}

func NewKeyRing(activeVersion byte, keys map[byte][]byte) (*KeyRing, error) {
	if _, exists := keys[activeVersion]; !exists {
		return nil, fmt.Errorf("active version %d not found in key ring", activeVersion)
	}
	for v, k := range keys {
		// aes.NewCipher SEBENARNYA mengembalikan KeySizeError untuk ukuran
		// yang salah — ia tidak panic, berbeda dari yang sering dinyatakan.
		// Diperiksa di sini supaya kegagalannya muncul saat start, bukan saat
		// permintaan pertama menyentuh baris yang salah.
		if len(k) != aes256KeySize {
			return nil, fmt.Errorf("key version %d size is %d bytes, want %d", v, len(k), aes256KeySize)
		}
	}
	return &KeyRing{activeVersion: activeVersion, keys: keys}, nil
}

func (kr *KeyRing) keyFor(version byte) ([]byte, error) {
	k, exists := kr.keys[version]
	if !exists {
		return nil, fmt.Errorf("%w: %d", ErrKeyVersion, version)
	}
	return k, nil
}

// combineAAD mengikat byte versi ke data terautentikasi.
//
// Tanpa ini, byte versi berada DI LUAR cakupan tag GCM, dan penyerang bisa
// mengubahnya menjadi versi kunci lain — serangan penurunan versi ke kunci
// lama yang mungkin sudah diketahui bocor. Aturannya sederhana: apa pun yang
// berada di luar tag, bisa diubah.
func combineAAD(version byte, ad []byte) []byte {
	out := make([]byte, 0, 1+len(ad))
	return append(append(out, version), ad...)
}

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

func aeadFor(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher initialization failed: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm initialization failed: %w", err)
	}
	return aead, nil
}

// Encrypt menyandikan plaintext dengan AES-256-GCM.
// Bentuk keluaran: [1 byte versi kunci][12 byte nonce][ciphertext][16 byte tag]
func Encrypt(ctx context.Context, kr *KeyRing, plaintext, associatedData []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context canceled: %w", err)
	}

	// Batas pemakaian kunci ditegakkan, bukan sekadar disebut di prosa.
	// Melewatinya berarti masuk wilayah tabrakan nonce, dan di GCM tabrakan
	// nonce bukan pelemahan bertahap melainkan keruntuhan total.
	if kr.encryptionCount.Add(1) > maxEncryptionsPerKey {
		return nil, ErrKeyQuotaExceeded
	}

	version := kr.activeVersion
	key, err := kr.keyFor(version)
	if err != nil {
		return nil, err
	}
	aead, err := aeadFor(key)
	if err != nil {
		return nil, err
	}

	// aead.NonceSize(), bukan konstanta 12. Seal PANIC bila panjang nonce
	// tidak cocok — dan itulah panic yang benar-benar ada di API ini,
	// berbeda dari aes.NewCipher yang mengembalikan galat biasa.
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, ErrEntropyFailed
	}

	out := make([]byte, 0, headerLength+len(nonce)+len(plaintext)+aead.Overhead())
	out = append(out, version)
	out = append(out, nonce...)
	return aead.Seal(out, nonce, plaintext, combineAAD(version, associatedData)), nil
}

// Decrypt memilih kunci berdasarkan byte versi, lalu membuka segel.
func Decrypt(ctx context.Context, kr *KeyRing, box, associatedData []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context canceled: %w", err)
	}
	if len(box) < headerLength+1 {
		return nil, ErrCiphertextLength
	}

	version := box[0]
	key, err := kr.keyFor(version)
	if err != nil {
		return nil, err
	}
	aead, err := aeadFor(key)
	if err != nil {
		return nil, err
	}

	// Pemeriksaan panjang memakai NonceSize()/Overhead() dari AEAD-nya
	// sendiri, bukan angka 12 dan 16 yang ditulis tangan. Tanpa ini,
	// pemotongan slice di bawah bisa panic pada masukan pendek.
	minimal := headerLength + aead.NonceSize() + aead.Overhead()
	if len(box) < minimal {
		return nil, ErrCiphertextLength
	}

	nonce := box[headerLength : headerLength+aead.NonceSize()]
	body := box[headerLength+aead.NonceSize():]

	plaintext, err := aead.Open(nil, nonce, body, combineAAD(version, associatedData))
	if err != nil {
		// Galat asli dicatat ke log, TIDAK dikembalikan: membedakan
		// "tag salah" dari "AD salah" akan menjadi oracle bagi penyerang.
		return nil, ErrDataTampered
	}
	return plaintext, nil
}
```

```go
package crypto

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func testKeyRing(t *testing.T) *KeyRing {
	t.Helper()
	ctx := context.Background()
	k1, err := DeriveKey(ctx, []byte("master-secret-sufficiently-long-for-testing"), []byte("salt"), []byte("pii-v1"))
	if err != nil {
		t.Fatalf("DeriveKey v1: %v", err)
	}
	k2, err := DeriveKey(ctx, []byte("master-secret-sufficiently-long-for-testing"), []byte("salt"), []byte("pii-v2"))
	if err != nil {
		t.Fatalf("DeriveKey v2: %v", err)
	}
	kr, err := NewKeyRing(2, map[byte][]byte{1: k1, 2: k2})
	if err != nil {
		t.Fatalf("NewKeyRing: %v", err)
	}
	return kr
}

func TestEncryptDecrypt(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	pt := []byte("Credit Card: 4111-...")
	ad := []byte("user-id-5000")

	box, err := Encrypt(ctx, kr, pt, ad)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	got, err := Decrypt(ctx, kr, box, ad)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(got, pt) {
		t.Fatalf("plaintext = %q, want %q", got, pt)
	}
}

// Sifat TERPENTING di seluruh berkas ini, dan sebelumnya tidak diuji sama
// sekali: nonce tidak boleh berulang. Anti-Pattern 1 menjelaskan akibatnya
// panjang lebar, tetapi tidak ada satu pun asersi yang menjaganya.
func TestNonceNeverRepeats(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	pt := []byte("identical plaintext test payload")

	const n = 200
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		box, err := Encrypt(ctx, kr, pt, nil)
		if err != nil {
			t.Fatalf("Encrypt #%d: %v", i, err)
		}
		nonce := string(box[headerLength : headerLength+12])
		if _, exists := seen[nonce]; exists {
			t.Fatalf("nonce repeated on iteration %d - GCM total breakdown", i)
		}
		seen[nonce] = struct{}{}
	}
}

// Tiga bagian kotak dirusak SATU PER SATU. Uji lama hanya membalik satu bit
// di posisi len-5 dengan komentar "flip 1 bit on the encrypted body" —
// posisi itu berada di dalam TAG, bukan di badan ciphertext, sehingga badan
// ciphertext tidak pernah benar-benar diuji.
func TestTamperingEachPartRejected(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	ad := []byte("user-id-5000")
	original, err := Encrypt(ctx, kr, []byte("secret payload sufficiently long for testing"), ad)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	positions := map[string]int{
		"nonce": headerLength + 3,
		"body":  headerLength + 12 + 2,
		"tag":   len(original) - 3,
	}
	for name, idx := range positions {
		t.Run(name, func(t *testing.T) {
			corrupted := bytes.Clone(original)
			corrupted[idx] ^= 0x01
			if _, err := Decrypt(ctx, kr, corrupted, ad); !errors.Is(err, ErrDataTampered) {
				t.Fatalf("error = %v, want ErrDataTampered", err)
			}
		})
	}
}

func TestAssociatedDataBindsRecord(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	box, err := Encrypt(ctx, kr, []byte("balance"), []byte("user-id-5000"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	// Ciphertext utuh, tetapi dipindahkan ke baris pengguna lain.
	if _, err := Decrypt(ctx, kr, box, []byte("user-id-5001")); !errors.Is(err, ErrDataTampered) {
		t.Fatalf("error = %v, want ErrDataTampered", err)
	}
}

// Byte versi berada di dalam cakupan tag. Menurunkannya ke versi kunci lama
// harus gagal, bukan berhasil dengan kunci yang salah.
func TestKeyVersionDowngradeRejected(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	box, err := Encrypt(ctx, kr, []byte("secret"), nil)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if box[0] != 2 {
		t.Fatalf("version = %d, want 2", box[0])
	}

	downgraded := bytes.Clone(box)
	downgraded[0] = 1 // versi kunci lama
	if _, err := Decrypt(ctx, kr, downgraded, nil); !errors.Is(err, ErrDataTampered) {
		t.Fatalf("error = %v, want ErrDataTampered", err)
	}
}

// Rotasi kunci: data lama TETAP terbaca tanpa migrasi apa pun.
func TestLegacyDataReadableAfterRotation(t *testing.T) {
	ctx := context.Background()
	k1, _ := DeriveKey(ctx, []byte("master-secret-sufficiently-long-for-testing"), []byte("salt"), []byte("pii-v1"))
	k2, _ := DeriveKey(ctx, []byte("master-secret-sufficiently-long-for-testing"), []byte("salt"), []byte("pii-v2"))

	legacy, err := NewKeyRing(1, map[byte][]byte{1: k1})
	if err != nil {
		t.Fatalf("NewKeyRing: %v", err)
	}
	legacyBox, err := Encrypt(ctx, legacy, []byte("legacy data"), nil)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	// Rotasi: v2 jadi aktif, v1 dipertahankan untuk dekripsi.
	rotated, err := NewKeyRing(2, map[byte][]byte{1: k1, 2: k2})
	if err != nil {
		t.Fatalf("NewKeyRing: %v", err)
	}
	got, err := Decrypt(ctx, rotated, legacyBox, nil)
	if err != nil {
		t.Fatalf("legacy data unreadable after rotation: %v", err)
	}
	if string(got) != "legacy data" {
		t.Fatalf("plaintext = %q", got)
	}
}

func TestCiphertextTooShort(t *testing.T) {
	ctx, kr := context.Background(), testKeyRing(t)
	for _, short := range [][]byte{{}, {2}, append([]byte{2}, bytes.Repeat([]byte{0}, 20)...)} {
		if _, err := Decrypt(ctx, kr, short, nil); !errors.Is(err, ErrCiphertextLength) && !errors.Is(err, ErrKeyVersion) {
			t.Errorf("length %d: error = %v, want ErrCiphertextLength", len(short), err)
		}
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
| Rotasi kunci ditunda terus | ada tidaknya byte versi di ciphertext | Tanpa penanda versi, rotasi = mendekripsi ulang seluruh tabel |
| Jumlah enkripsi per kunci tidak diketahui | penghitung pemakaian kunci | Batas 2^32 terlampaui tanpa ada yang menyadari |
| Berkas terpotong terbaca sebagai berkas utuh | penanda potongan terakhir | AEAD berpotongan tanpa perlindungan pemotongan |

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
