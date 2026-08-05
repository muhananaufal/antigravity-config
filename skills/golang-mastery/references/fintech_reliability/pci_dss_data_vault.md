# PCI-DSS Data Vault & Tokenization (Cardholder Data)

> **Berlaku:** Go 1.21+ · PCI DSS 4.0 · **Lihat juga:** `security_owasp/aes_gcm_cryptography.md` · `security_owasp/audit_logging_scrubbing.md` · `security_owasp/secret_management_vault.md` · `fintech_reliability/idempotency_payment_engine.md`

## Concept/Internals
Sistem e-commerce dan Payment Gateway yang bersentuhan dengan data kartu kredit mentah harus tunduk pada **PCI-DSS (Payment Card Industry Data Security Standard)**. Standar ini adalah hukum besi finansial internasional. Menyimpan *Primary Account Number* (PAN / 16 digit kartu) secara mentah tanpa enkripsi level tertinggi dapat mengakibatkan audit denda miliaran rupiah dan izin akuisisi kartu dicabut selamanya oleh Visa/Mastercard.

Lebih parah lagi, menyimpan data CVV/CVC (3 digit rahasia belakang kartu) di *database storage persisten* secara absolut **DILARANG** oleh hukum PCI-DSS, meskipun data tersebut dienkripsi (Hanya boleh ditahan sebentar di RAM memori selama rentang wajar request proxy ke bank sentral).

Pendekatan Arsitektur:
1. **Tokenization (Reduksi Scope)**: Alih-alih sistem *Checkout* Anda memegang PAN, gunakan API pihak ketiga (Stripe, Midtrans) atau layanan mikro internal super ketat (Data Vault) untuk menyerap kartu dan mengembalikan UUID acak/Token (e.g., `tok_1abc`).
2. **Data Vault (Enkripsi Lapis Baja)**: Jika Anda yang bertindak sebagai *Vault*-nya (Payment Gateway Kategori 1), semua data PAN yang disimpan wajib dienkripsi. Standar kriptografi minimal: **AES-256-GCM** (Bukan CBC lama, karena butuh AEAD otentikasi). 

### Diagram ASCII: Tokenization Vault Flow

```ascii
 [ User Web Browser ] ---> ( Kirim PAN & CVV mentah )
            |
            v
 +---------------------------------------+
 | 🛡️ PCI-DSS Vault Microservice (Go)   |
 |   (1) Extract & Validasi (Luhn Check) |
 |   (2) Enkripsi PAN (AES-256-GCM)      |
 |   (3) Generate UUID (Token)           |
 |   (4) BUANG/Nihilkan CVV dari Memori! |
 |   (5) Simpan (Token -> Encrypted PAN) |
 +---------------------------------------+
            |
      ( Return Token: "v-8a73b..." )
            |
            v
 [ 🛒 E-Commerce Main Backend API ] ---> (Simpan Token v-8a73b di Tabel User_Payment)
            |                            (Scope Main DB TIDAK TERKENA Audit PCI-DSS)
            v 
 (Saat Checkout, Main Backend kirim ID Token ke Vault untuk di-*charge* langsung ke Bank)
```

## Production Code

Implementasi Enkripsi Aman dengan AES-256-GCM di Golang. (Note: Dalam *real production*, *Key* Enkripsi utama harus disediakan melalui *KMS (Key Management Service)* seperti AWS KMS/HashiCorp Vault, bukan *hardcode*).

```go
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

var (
	ErrInvalidKeySize = errors.New("symmetric key must be exactly 32 bytes for AES-256")
	ErrCiphertextLen  = errors.New("ciphertext too short")
)

// CryptoVault menangani enkripsi/dekripsi PAN tingkat tinggi
type CryptoVault struct {
	// AAD (Additional Authenticated Data) untuk mencegah "Confused Deputy Attack"
	// Memastikan sandi ini spesifik milik domain kita.
	aadInfo []byte 
	aead    cipher.AEAD
}

// NewCryptoVault diinisialisasi dari Master Key 32-Byte (256-bit).
// Jangan pernah *hardcode* key ini di Source Code!
func NewCryptoVault(masterKey32Bytes []byte) (*CryptoVault, error) {
	if len(masterKey32Bytes) != 32 {
		return nil, ErrInvalidKeySize
	}

	block, err := aes.NewCipher(masterKey32Bytes)
	if err != nil {
		return nil, err
	}

	// GCM (Galois/Counter Mode) adalah standar wajib AEAD (Authenticated Encryption) modern.
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return &CryptoVault{
		aadInfo: []byte("PCI_VAULT_NAMESPACE_V1"), 
		aead:    aead,
	}, nil
}

// EncryptPAN merubah 16 digit PAN menjadi string terenkripsi berpelindung Nonce (IV).
func (v *CryptoVault) EncryptPAN(plaintextPAN string) (string, error) {
	// PAN tidak perlu dispasi atau strip
	cleanPAN := strings.ReplaceAll(plaintextPAN, " ", "")

	// 1. Generate Nonce Acak Kriptografis (Standard GCM 12-byte)
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("failed generating nonce: %w", err)
	}

	// 2. Lakukan Enkripsi dan tempelkan TAG MAC otentikasi.
	// Fungsi Seal akan menempelkan ciphertext ke dalam buffer 'nonce' (sebagai byte prefix).
	ciphertext := v.aead.Seal(nonce, nonce, []byte(cleanPAN), v.aadInfo)

	// Kembalikan sebagai Hex string untuk aman disimpan ke VARCHAR PostgreSQL
	return hex.EncodeToString(ciphertext), nil
}

// DecryptPAN mengekstrak string heksadesimal GCM kembali ke PAN mentah.
func (v *CryptoVault) DecryptPAN(hexCipher string) (string, error) {
	data, err := hex.DecodeString(hexCipher)
	if err != nil {
		return "", err
	}

	nonceSize := v.aead.NonceSize()
	if len(data) < nonceSize {
		return "", ErrCiphertextLen
	}

	// Pisahkan Nonce dan Ciphertext (Karena kita sambung (prefix) saat Seal)
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]

	// Open & Authenticate! Gagal jika MAC tag tidak valid (Telah ditamper/diubah orang).
	plaintext, err := v.aead.Open(nil, nonce, ciphertext, v.aadInfo)
	if err != nil {
		return "", fmt.Errorf("decryption/authentication failed: %w", err)
	}

	return string(plaintext), nil
}

// --- Unit Tests ---
func TestVaultEncryption(t *testing.T) {
	// Dummy 32-byte key for test
	key := []byte("0123456789ABCDEF0123456789ABCDEF") 
	
	vault, err := NewCryptoVault(key)
	if err != nil {
		t.Fatalf("setup vault failed: %v", err)
	}

	originalPAN := "4111222233334444"
	
	encrypted, err := vault.EncryptPAN(originalPAN)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	
	// Validasi bahwa payload terenkripsi BUKAN plaintext!
	if strings.Contains(encrypted, originalPAN) {
		t.Errorf("FATAL: ciphertext contains plaintext digits!")
	}

	decrypted, err := vault.DecryptPAN(encrypted)
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}

	if decrypted != originalPAN {
		t.Errorf("expected %s, got %s", originalPAN, decrypted)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan CVV di Database/Log
**Mengapa berbahaya:** Menyimpan nilai CVV (misalnya di kolom `user_cards.cvv = '123'`) melanggar mandat mutlak PCI-DSS, meskipun CVV tersebut telah dienkripsi lapis 5 dengan AES. Jika auditor mengetahuinya, sertifikasi dicabut hari itu juga. CVV adalah otentikasi *Card-Not-Present* yang eksistensinya difungsikan murni untuk "dibaca saat transit, kirim ke bank/visa, lalu dibuang selamanya".

```go
// BAD: Meng-insert CVV
db.Exec("INSERT INTO cards (pan, cvv) VALUES ($1, $2)", encPan, encCvv) 
```
```go
// GOOD: Hanya pass-through.
api.Post(bankURL, Payload{PAN: decPan, CVV: tempCvvFromReq})
tempCvvFromReq = "" // Kosongkan variable secepat mungkin
```

### ❌ Anti-Pattern 2: Mode Block ECB atau Tanpa Autentikasi MAC
**Mengapa berbahaya:** Menggunakan AES mode `ECB` (Electronic Codebook) sangat lemah, blok PAN yang identik akan menghasilkan *ciphertext* yang identik pula, yang mengizinkan penyusup menembak pola data. Sedangkan menggunakan mode `CBC` (tanpa HMAC) rawan terhadap serangan manipulasi *Padding Oracle Attack* (Hackers bisa memodifikasi string sandi pelan-pelan tanpa ketahuan). GCM adalah perisai standar yang mengamankan 'Isi Data' (Kerahasiaan) DAN 'Keutuhan Data' (Otentikasi MAC).

### ❌ Anti-Pattern 3: Masking String Gagal dan Panics Dump
**Mengapa berbahaya:** Anda ingin mencetak kartu ke log untuk keperluan debug, dan bermaksud men-*masking* string `4111222233334444` menjadi `4111********4444`. Tetapi ada error dan aplikasi Anda `panic`. Panic *Stack Trace* Golang akan mencetak SELURUH isi variabel lokal dan argument *function* ke standar output secara telanjang. PAN Anda bocor ke Datadog.

```go
// BAD: Passing plaintext raw strings di parameter goroutines panas 
func Charge(pan string) { ... }
```
```go
// GOOD: Gunakan Custom Struct (DTO) yang menutupi (override) fmt.Stringer
type SecureCard struct {
    pan string
}
// Log formatter akan memanggil ini otomatis jika nge-log object-nya, bukan isinya.
func (s SecureCard) String() string {
    return "CARD-[REDACTED]"
}
```

## Edge Cases & Defensive Programming

1. **Key Rotation (Rotasi Kunci Berkala)**: Aturan kriptografi memaksa Anda menukar Master Key enkripsi setidaknya 1 kali setahun. Bagaimana mendekripsi *ciphertext* kartu berumur 2 tahun yang terkunci dengan kunci lama? Sistem produksi nyata menyertakan `KeyID` (Header metadata) pada *prefix* string enkripsi (`V1$hex_ciphertext...`). Saat didekripsi, parser membaca `V1`, mengambil Kunci V1 dari AWS KMS, dan memecahkannya dengan aman, sementara data baru selalu dibungkus dengan Kunci `V2`.
2. **Side-Channel Timing Attacks**: Membandingkan apakah dua PAN atau hash otentikasi sama tidak boleh menggunakan operator standar Go `==` (seperti `if inputHash == realHash`). Operator standar tersebut akan mereturn nilai *false* di karakter pertama yang gagal, sehingga penyerang bisa menebak isi dengan mengukur selisih nanodetik (Timing Attack). Gunakan fungsi waktu konstan khusus kriptografi: `subtle.ConstantTimeCompare()`.
3. **Mencegah Garbage Collector Mengambang**: Memori string dan array *byte* yang dialokasikan di Go (saat menangani password, PAN, dan CVC) akan menetap di RAM berlama-lama sampai Go *Garbage Collector (GC)* mampir, memberikan peluang bagi peretas *memory-dump/Heartbleed* untuk menyedot data kartu mentah. Lakukan praktik *Zeroization* untuk tipe sensitif: `for i := range secretSlice { secretSlice[i] = 0 }` setelah fungsi utilitas selesai tugasnya! (Catatan: ini hanya berfungsi murni pada `[]byte`, bukan `string` imutabel).

## Kapan JANGAN Pakai Ini

- **Menyimpan PAN bila tokenisasi sudah cukup.** Data yang tidak Anda simpan tidak bisa bocor dari Anda, tidak masuk ruang lingkup audit, dan tidak perlu dienkripsi, dirotasi, maupun dihapus. Ini keputusan arsitektur dengan pengembalian terbesar di seluruh domain ini.
- **Menyimpan CVV dalam bentuk apa pun.** Dilarang setelah otorisasi — terenkripsi sekalipun, dan tanpa pengecualian.
- **Mencatat permintaan pembayaran mentah ke log.** Di situlah PAN masuk ke sistem log yang tidak dirancang untuk data kartu, dan **memperluas ruang lingkup PCI** ke seluruh tumpukan observabilitas Anda.
- **Enkripsi tanpa memisahkan kunci dari data.** Kunci yang tersimpan di database yang sama membuat enkripsi hanya melindungi dari pencurian berkas mentah — bukan dari akses yang sesungguhnya menjadi ancaman.
- **Ruang lingkup PCI yang tidak dibatasi jaringan.** Setiap sistem yang **bisa** menyentuh data kartu masuk ruang lingkup audit. Segmentasi jaringan adalah cara paling efektif mengecilkannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| PAN ditemukan di sistem log | pola nomor kartu di log | Permintaan mentah dicatat |
| Ruang lingkup audit terus melebar | segmentasi jaringan | Terlalu banyak sistem bisa menyentuh data kartu |
| Kunci enkripsi di database yang sama | lokasi penyimpanan kunci | Enkripsi tidak melindungi dari akses aplikasi |
| Data kartu di lingkungan non-produksi | asal data uji | Data produksi disalin ke staging |
| Retensi melebihi kebutuhan bisnis | kebijakan penghapusan | Data disimpan lebih lama dari yang bisa dibenarkan |

```bash
# Pola nomor kartu di log -- setiap kecocokan adalah insiden, bukan temuan biasa
kubectl logs -l app=payment --since=1h | grep -oE '\b[45][0-9]{15}\b' | head
kubectl logs -l app=payment --since=1h | grep -oE '\b3[47][0-9]{13}\b' | head

# Segmentasi: sistem mana yang benar-benar bisa mencapai vault
kubectl get networkpolicies -n pci
kubectl get pods -n pci -o wide

# Kunci harus berada di luar database yang menyimpan datanya
vault kv metadata get secret/pci/dek
```

```sql
-- Kolom yang mungkin menyimpan data kartu tanpa disadari
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name ~* '(card|pan|cvv|cvc|kartu)';
```
