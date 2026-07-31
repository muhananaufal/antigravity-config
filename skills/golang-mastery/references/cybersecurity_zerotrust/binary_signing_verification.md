# Penandatanganan & Verifikasi Binary (Ed25519) Zero Trust

## 1. Konsep Utama & Internals
Dalam lingkungan *Zero Trust*, tidak peduli jika sebuah artefak biner (aplikasi Go yang dikompilasi atau image Docker) dikirim dari server CI/CD internal; kita tidak boleh mempercayainya jika artefak itu bisa dimodifikasi selama transit atau *at rest*. Kita memvalidasi asal-usul (provenance) menggunakan penandatanganan kriptografis (*Cryptographic Signatures*).

Metode usang menggunakan GPG atau RSA rentan dan kompleks. Standar industri modern di Go memanfaatkan kunci **Ed25519** (cepat dan kebal terhadap serangan tabrakan hash tertentu) via library `golang.org/x/crypto/ed25519` atau ekosistem yang lebih ringkas seperti `minisign` / `cosign` (Sigstore). Sistem yang matang menyertakan tanda tangan pada header atau file `.sig` terpisah, sehingga agen pendeploy (*Kubernetes Admission Controller* atau *OTA Updater*) tidak akan mengeksekusi biner yang *invalid*.

## 2. Diagram Arsitektur / Aliran (ASCII)
```text
   [CI/CD Pipeline]                                   [Production Host / OTA Updater]
         |                                                       |
 1. go build -o myapp                                            |
 2. hash = SHA256(myapp)                                         |
 3. sig = Ed25519_Sign(Private_Key, hash)                        |
         |                                                       |
 4. Deploy (myapp + myapp.sig) ===============================>  |
                                                                 |
                                        5. hash_calc = SHA256(myapp)
                                        6. Ed25519_Verify(Public_Key, hash_calc, sig)
                                                                 |
                                       +-------------------------+-------------------------+
                                       |                                                   |
                                     (Valid)                                           (Invalid)
                                       v                                                   v
                             [Execute ./myapp]                            [Halt, Alert Security Team]
```

## 3. Production-Ready Go Code

Implementasi generator kunci Ed25519, proses penandatanganan stream aman, dan rutinitas verifikasi file biner (menangani file gigabytes tanpa memori OOM menggunakan *Stream Hashing*).

```go
package binarysign

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"testing"
)

// GenerateKeypair membuat pasangan kunci Ed25519 (Private Key = 64 bytes, Public = 32 bytes)
func GenerateKeypair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("ed25519 generate failed: %w", err)
	}
	return pub, priv, nil
}

// SignBinary membuat signature hexadecimal dari payload file biner menggunakan private key
func SignBinary(filePath string, privKey ed25519.PrivateKey) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file for signing: %w", err)
	}
	defer file.Close()

	// 1. Hash file (Stream processing agar tidak OOM untuk file >1GB)
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", fmt.Errorf("hashing failed: %w", err)
	}
	hashSum := hasher.Sum(nil)

	// 2. Sign SHA256 checksum-nya menggunakan Ed25519
	// Ed25519 standard butuh pesan untuk ditandatangani, kita men-sign checksum-nya.
	signature := ed25519.Sign(privKey, hashSum)

	// Return signature dalam format Hex yang mudah di-deploy
	return hex.EncodeToString(signature), nil
}

// VerifyBinary memvalidasi keaslian file biner. Return true jika Public Key terkonfirmasi.
func VerifyBinary(filePath string, pubKey ed25519.PublicKey, sigHex string) (bool, error) {
	// Dekode signature dari string
	signature, err := hex.DecodeString(sigHex)
	if err != nil {
		return false, fmt.Errorf("invalid signature hex format: %w", err)
	}

	file, err := os.Open(filePath)
	if err != nil {
		return false, fmt.Errorf("failed to open file for verification: %w", err)
	}
	defer file.Close()

	// Kalkulasi hash kembali (Stream)
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return false, fmt.Errorf("hashing failed: %w", err)
	}
	hashSum := hasher.Sum(nil)

	// Verifikasi: Cocokkan hashSum, signature, dan Public Key
	isValid := ed25519.Verify(pubKey, hashSum, signature)
	return isValid, nil
}

func TestBinarySigningVerification(t *testing.T) {
	// 1. Persiapan: Buat file dummy
	tmpFile := "dummy_bin.txt"
	_ = os.WriteFile(tmpFile, []byte("my-executable-binary-payload"), 0644)
	defer os.Remove(tmpFile)

	// 2. Keygen (Harusnya dilakukan offline)
	pub, priv, err := GenerateKeypair()
	if err != nil {
		t.Fatalf("GenerateKeypair err: %v", err)
	}

	// 3. Sign Pipeline (CI/CD)
	sigString, err := SignBinary(tmpFile, priv)
	if err != nil {
		t.Fatalf("Sign err: %v", err)
	}

	// 4. Verify Pipeline (Production Agent)
	isValid, err := VerifyBinary(tmpFile, pub, sigString)
	if err != nil {
		t.Fatalf("Verify err: %v", err)
	}
	if !isValid {
		t.Fatalf("Expected valid signature, got invalid")
	}

	// 5. Test Penolakan Tamper/Hacking (Hacker memodifikasi binari)
	_ = os.WriteFile(tmpFile, []byte("my-executable-binary-payload-HACKED"), 0644)
	isValidTampered, _ := VerifyBinary(tmpFile, pub, sigString)
	if isValidTampered {
		t.Fatalf("Expected invalid signature for tampered file, but verification succeeded!")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Memuat Biner (File) ke RAM secara Penuh (`os.ReadFile`)
Seringkali engineer menggunakan `os.ReadFile(file)` untuk menandatangani file *executable*.
```go
// ❌ BAD: Memory Exhaustion OOM
data, err := os.ReadFile("my_huge_app.bin")
signature := ed25519.Sign(privKey, data)
```
**Why dangerous:** Jika file kontainer biner atau arsip ZIP Anda berukuran 2 GB, aplikasi Go akan mengalokasikan string/byte ukuran 2 GB langsung ke RAM. Dalam lingkungan produksi (terutama agen updater IoT kecil), ini seketika menyebabkan kernel membunuh proses (`OOM Killed`).

```go
// ✅ GOOD: Streaming Hashing
file, _ := os.Open("my_huge_app.bin")
hasher := sha256.New()
io.Copy(hasher, file) 
// RAM tetap stabil di angka ~beberapa kilobyte meski ukuran file 10 GB
signature := ed25519.Sign(privKey, hasher.Sum(nil))
```

### ❌ Anti-Pattern 2: Menggabungkan (Append) Signature di Ujung File Executable Tanpa Parsing
Beberapa mekanisme otodidak menyuntikkan (append) *byte array* signature langsung di akhir (ekor) biner ELF Linux.

```bash
# ❌ BAD: Modifikasi brutal 
cat signature.bin >> myapp_linux_amd64
```
**Why dangerous:** OS Loader (Linux ELF atau Windows PE) sangat ketat. Memodifikasi format secara kasar bisa menyebabkan binari tidak mau dijalankan (`Exec format error`). Terlebih lagi, ekor yang disuntikkan mengubah hash biner asli itu sendiri, merusak logika validasi verifikasi `hash_calc = SHA256(myapp)`.

```go
// ✅ GOOD: Gunakan file `.sig` terpisah (Detached Signatures).
// myapp_linux_amd64.sig
// Jika harus embed di biner Go (In-band), gunakan package "debug/elf" atau "golang.org/x/mod/sumdb/note"
// untuk memanipulasi section atau struct spesifik yang sah (seperti mekanisme Go Modules log).
```

## 5. Edge Cases & Defensive Programming

1. **Rollback Attacks (Downgrade Attack)**: Hacker mengganti file produksi aplikasi Anda dengan file versi lama yang legal (signed) tapi memiliki kerentanan CVE yang belum ditambal (Zero-day exploit). *Defensive:* Penandatanganan biner konvensional tidak mencegah *rollback*. Anda harus selalu memvalidasi *Metadata Versi/Timestamp* (seperti manifest JSON yang ditandatangani di samping biner, contoh di TUF framework / Sigstore). Tolak instalasi jika nomor seri/waktu rilis lebih rendah dari biner saat ini.
2. **Kelemahan Public Key Rotation**: Jika Public Key (yang di-hardcode ke agen produksi) bocor atau Anda kehilangan *Private Key*-nya, Anda tidak bisa mem-push *update* biner sama sekali. *Defensive:* Jangan hardcode satu *root public key* secara buta di kode Go. Manfaatkan hierarki (PKI / Root Key -> Intermediate Signing Key) seperti arsitektur The Update Framework (TUF), atau integrasikan sistem rotasi *KMS (Key Management Service)* berbasis OIDC + Sigstore (*Keyless Signing*).
3. **Time-Of-Check to Time-Of-Use (TOCTOU) Race Condition**: Updater memverifikasi signature biner di lokasi `/tmp/myapp`, menyatakannya *Valid*. Tepat setelah itu sebelum mengeksekusi `exec.Command("/tmp/myapp")`, penyerang (*malware*) lokal dengan cepat menimpa file tersebut. *Defensive:* Gunakan izin *File Descriptor Lock* (`syscall.Flock`) atau pindahkan (atomic `os.Rename`) file segera ke path read-only `/opt/bin/myapp` *sebelum* memverifikasi dan mengeksekusinya, memastikan tiada yang memanipulasi rentang jeda verifikasi-eksekusi.
