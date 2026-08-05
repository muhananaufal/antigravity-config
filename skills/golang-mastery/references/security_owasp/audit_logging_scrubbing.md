# Panduan Definitif: Audit Logging, PII Scrubbing & Tamper Detection

> **Berlaku:** Go 1.21+ · **Lihat juga:** `observability_resilience/structured_logging_zerolog.md` · `security_owasp/secret_management_vault.md` · `distributed_patterns_resilience/multi_tenancy_isolation.md` · `engineering_practice/incident_postmortem.md`

## 1. Konsep dan Internals (Technical Depth)

Data *Audit Log* sangat penting untuk keamanan sistem, memfasilitasi forensik saat terjadi peretasan, dan wajib bagi standar kepatuhan operasional seperti PCI-DSS, SOC2, dan HIPAA. Namun, seringkali *log system* yang dibuat justru menjadi kelemahan terbesar (titik kebocoran data / *Data Bleed*).

1. **PII Scrubbing (Masking/Redaction)**: Sebelum dikirim ke *sink* seperti stdout/Kibana/Elasticsearch, log tidak boleh memuat *Personally Identifiable Information (PII)* atau rahasia otentikasi (Password, JWT, CC Number). Harus ada proses filter otomatis.
2. **Right to Erasure (GDPR)**: Jika user meminta penghapusan akun, log masa lalu secara hukum tidak boleh menautkan data kepadanya. Solusinya: Jangan log "Email", melainkan log *Pseudonym* (User UUID/Hash) yang dapat dihapus dari tabel relasi (anonymization).
3. **Structured JSON Logs**: Log mentah (string concat) mustahil disaring atau diagregasi oleh SIEM. Setiap record log harus menjadi JSON yang ketat.
4. **Log Tampering & Immutable Audit Trails**: Jika *attacker* memegang akses *root* server, hal pertama yang dilakukan adalah menghapus atau mengedit file log (*covering tracks*). Anda membutuhkan mekanisme *Forward Secrecy* pada log, sering diimplementasikan via:
   - Pengiriman *UDP syslog* ke server *append-only* terpisah (Write-Once Read-Many/WORM storage).
   - **Cryptographic Hash Chaining**: tiap baris menyimpan HMAC-SHA256 atas isi baris itu **beserta hash baris sebelumnya**. Mengubah satu baris di tengah merusak seluruh hash sesudahnya.

   Tiga syarat yang menentukan apakah rantai itu benar-benar melindungi sesuatu — dan ketiganya mudah terlewat:

   | Syarat | Bila dilanggar |
   | :--- | :--- |
   | Seluruh ruas yang mengikat ikut ditandatangani, **termasuk timestamp** | Waktu kejadian bisa dipindahkan bebas tanpa merusak rantai — dan dalam forensik, "kapan" sering merupakan seluruh pertanyaannya |
   | Tiap ruas diberi **awalan panjang** sebelum di-MAC | `("A","BC")` dan `("AB","C")` menghasilkan masukan MAC yang identik; dua peristiwa berbeda bisa punya hash yang sama |
   | **Nomor urut** disimpan di tiap entri | Penghapusan entri di tengah menghasilkan rantai yang tetap konsisten bila hanya hash yang diperiksa |

   Dan satu keterbatasan yang harus diketahui sejak awal: **rantai hash tidak mendeteksi pemotongan.** Penyerang yang membuang N entri **terakhir** meninggalkan rantai yang sempurna valid — dan itulah justru yang akan ia lakukan, karena jejaknya ada di ujung. Satu-satunya jawaban adalah menerbitkan *checkpoint* (nilai hash kepala beserta nomor urutnya) secara berkala ke penyimpanan lain yang tidak dikuasai penyerang yang sama.

## 2. Diagram ASCII: Alur Audit Trail & Immutable Chaining

```text
[ HTTP API / Handler ]
         | (1. User "USR_X" triggers Action "DELETE_DB")
         v
+-------------------------------------------------------------+
| Middleware Audit Interceptor (Extract Actor, Action, Data)  |
+-------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------+
| PII Scrubber Engine (Regex & Field Masking)                 |
|  - payload.password = "REDACTED"                            |
|  - payload.credit_card = "****-****-****-" + last4          |
+-------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------+
| Cryptographic Chaining Engine (Stateful / Atomic)           |
|  CurrentHash = HMAC( PrevHash + Stringify(ScrubbedData) )   |
|  Update In-Memory PrevHash = CurrentHash                    |
+-------------------------------------------------------------+
         |
         v
[ JSON Sink (Stdout / SIEM / Splunk / S3 WORM Storage) ]
  { "ts": "2026-...", "actor": "USR_X", "hash": "abcd..." }
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mencetak Mentah HTTP Request/Response

**Mengapa berbahaya (Exploit Vector)**: Fungsi cetak log golang seperti `log.Printf` atau library `logrus/zap` jika diberikan *struct request* utuh, akan mencetak nilai semua variabel, termasuk tipe data kredensial. Attacker atau pegawai internal biasa yang melihat Kibana Dashboard berpotensi mengunduh CSV jutaan password yang dicetak tak sengaja ke *system log*.

```go
// VULNERABLE: Data Bleed Logging
func loginHandlerVulnerable(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	json.NewDecoder(r.Body).Decode(&req)
	
	// ❌ BAD: Mencetak payload mentah %v yang berisi req.Password
	log.Printf("INFO: User login attempt: %v", req) 
}
```

```go
// ✅ GOOD: Pengekangan log dan Masking field
func loginHandlerSafe(w http.ResponseWriter, r *http.Request) {
	// ... decode
	// Ekstrak data yang aman saja, mask yang lain
	safePayload := map[string]interface{}{
		"email": req.Email,
		"password": "[REDACTED]", 
	}
	logger.Info("User login attempt", zap.Any("payload", safePayload))
}
```

### ❌ Anti-Pattern 2: Log File Mudah Dimodifikasi Tanpa Deteksi (No Integrity)

**Mengapa berbahaya (Exploit Vector)**: Log ditulis menggunakan rotasi file standar. Jika remote code execution (RCE) berhasil, attacker melakukan perintah `sed -i '/attacker_ip/d' /var/log/app.log` untuk menghilangkan semua jejak eksploit. 

```go
// VULNERABLE: Log Lokal Tanpa Integritas
func WriteLogVulnerable(msg string) {
	// ❌ BAD: Hanya text biasa di file, bisa diedit bebas oleh siapapun.
	f.WriteString(msg + "\n") 
}
```

```go
// ✅ GOOD: Menerapkan HMAC Chaining / Sig. (Lihat di Section 5)
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Panic Data Leakage di Stack Trace**: Saat Go mengalami `panic()`, *runtime* mencetak *stack trace* ke *stderr*. Parameter fungsi (misal pointer ke struct kredensial) akan ikut dicetak dalam bentuk heksadesimal atau plain string. Jangan lewatkan obyek kredensial murni antar layer, *override* fungsi `String()` pada tipe struct sensitif Anda.
2. **Kinerja Scrubbing — tetapi penyaringan nama saja TIDAK cukup**: menjalankan regex rumit atas payload 5 MB pada 10.000 rps memang membakar CPU. Urutan yang benar bukan "pakai nama field saja", melainkan: **saring nama field dulu** (murah, O(jumlah kunci)), **potong nilai** ke batas wajar (2000 karakter), lalu **jalankan pola nilai pada sisa yang sudah pendek**. Dengan urutan itu, regex hanya pernah melihat string kecil.

   Menghapus langkah pola nilai sepenuhnya adalah persis yang dilarang bagian "Kapan JANGAN Pakai Ini" di berkas ini, dan yang didaftarkan tabel deteksi sebagai penyebab "rahasia ditemukan di sistem log": rahasia berpindah field, dan field baru muncul tanpa penyaringnya pernah tahu. Nama field melindungi dari kelalaian yang sudah Anda antisipasi; pola nilai melindungi dari yang belum.

   Satu detail kecil yang merusak bukti: potonglah pada batas **rune**, bukan byte. `v[:512]` memotong rune multi-byte di tengah, dan UTF-8 yang tidak valid diganti `U+FFFD` saat encoding JSON — isi log berubah diam-diam, dan pada log audit isi yang berubah berarti bukti yang rusak.
3. **Konkurensi & Mutex pada HMAC Chain**: perhitungan rantai harus berurutan, sementara handler API berjalan konkuren; perebutan `PrevHash` menghancurkan rantainya. Lindungi dengan `sync.Mutex`.

   Yang sering ikut salah: **jangan menahan kunci itu selama I/O sink.** Menulis ke Elasticsearch atau disk di dalam kunci rantai menyerialkan seluruh pencatatan audit di belakang tulisan paling lambat, dan pada laju tinggi audit logging berubah menjadi penyempitan layanan — yang pada gilirannya membuat orang tergoda mematikannya. Hitung rantainya di dalam kunci (mikrodetik), lalu serahkan entri ke sink di luar kunci.

4. **Kunci HMAC tidak boleh menjadi bagian dari rantai yang diterbitkan.** Kesalahan yang paling mudah dilakukan dan paling fatal adalah menjadikan hash akar sebagai turunan langsung dari kunci — misalnya `lastHash = hex(secretKey)`. Nilai itu terbit sebagai `prev_hash` pada entri pertama, sehingga **kunci HMAC tercetak polos di baris log pertama**, dan siapa pun yang bisa membaca log audit dapat memalsukan seluruh rantai. Titik awal rantai harus nilai publik yang memang tidak rahasia.

5. **Rantai per proses bukan rantai per sistem.** Setiap replika memelihara rantainya sendiri, dan restart memulai rantai baru. Sertakan pengenal aliran (`idAliran`) di hash akar agar rantai antar-replika tidak tertukar, dan simpan checkpoint kepala per aliran — tanpa itu, "rantai valid" hanya berarti valid menurut proses yang kebetulan sedang berjalan.

## 5. Production-Ready Go Code

Implementasi sistem logger modular yang melindungi data sensitif (PII Masking) dan menjamin non-repudiation menggunakan HMAC-SHA256 Hash Chaining via Channel Pipeline yang konkuren-aman.

```go
package audit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var (
	ErrBrokenChain  = errors.New("audit chain is broken")
	ErrHashMismatch = errors.New("hash mismatch: entry has been tampered with")
	ErrSequenceGap  = errors.New("sequence gap: entry has been deleted")
)

const maxValLength = 2000 // sesuai Kasus Tepi 2

type AuditEvent struct {
	// Seq menutup celah yang tidak bisa ditutup rantai hash: penghapusan
	// entri di TENGAH menghasilkan rantai yang tetap konsisten bila hanya
	// hash yang diperiksa. Nomor urut membuat lubangnya terlihat.
	Seq       uint64            `json:"seq"`
	Timestamp string            `json:"ts"`
	Action    string            `json:"action"`
	ActorID   string            `json:"actor_id"`
	// Outcome ada karena percobaan yang GAGAL adalah sinyal paling berharga
	// saat investigasi. Bagian "Kapan JANGAN Pakai Ini" menuntutnya dan
	// perintah bash di bawah menyaring `.outcome` — field yang dipancarkan
	// untuk audit trail.
	Outcome   string            `json:"outcome"` // "success" | "failure"
	Payload   map[string]string `json:"payload"`
	PrevHash  string            `json:"prev_hash"`
	Hash      string            `json:"hash"`
}

// rootHash adalah titik awal rantai.
//
// Ia TIDAK BOLEH diturunkan dari kunci HMAC. Versi sebelumnya menyetel
// `lastHash = hex.EncodeToString(secretKey)`, dan nilai itu ditulis ke
// keluaran sebagai `prev_hash` pada entri PERTAMA — artinya **kunci HMAC
// diterbitkan dalam bentuk polos di baris log pertama**. Siapa pun yang bisa
// membaca log audit — dan log audit dibaca banyak orang — bisa memalsukan
// seluruh rantai sejak awal. Titik awal yang benar adalah nilai publik yang
// memang tidak rahasia.
func rootHash(streamID string) string {
	h := sha256.Sum256([]byte("audit-chain-root:" + streamID))
	return hex.EncodeToString(h[:])
}

// calculateHash menghitung HMAC atas SELURUH ruas yang mengikat, dengan awalan
// panjang di setiap ruas.
//
// Dua koreksi kriptografis terhadap versi sebelumnya:
//
//  1. **Timestamp ikut ditandatangani.** Sebelumnya tidak — sehingga penyerang
//     dapat memindahkan waktu kejadian mana pun tanpa merusak rantai. Dalam
//     forensik, "kapan" sering merupakan seluruh pertanyaannya; memindahkan
//     satu aksi keluar dari jendela insiden sudah cukup untuk menghapus
//     kaitannya.
//
//  2. **Setiap ruas diawali panjangnya.** Penulisan berurutan tanpa pembatas
//     bersifat ambigu: `action="A", actor="BC"` menghasilkan masukan MAC yang
//     IDENTIK dengan `action="AB", actor="C"`. Penyerang yang bisa memengaruhi
//     dua ruas bersebelahan dapat menyusun peristiwa berbeda dengan hash yang
//     sama persis — dan verifikasi akan menyatakannya sah.
func calculateHash(key []byte, e AuditEvent) (string, error) {
	// json.Marshal atas map[string]string mengurutkan kunci, sehingga
	// keluarannya deterministik. Itu SYARAT, bukan kebetulan: begitu Payload
	// berubah menjadi tipe yang serialisasinya tidak stabil, verifikasi akan
	// gagal untuk data yang sebenarnya utuh.
	payload, err := json.Marshal(e.Payload)
	if err != nil {
		// Galat ini TIDAK boleh dibuang. Marshal yang gagal menghasilkan
		// masukan MAC yang lebih pendek: hash tetap terbentuk, dan
		// perlindungannya diam-diam berkurang.
		return "", fmt.Errorf("marshal payload: %w", err)
	}

	mac := hmac.New(sha256.New, key)
	var lp [8]byte
	write := func(b []byte) {
		binary.BigEndian.PutUint64(lp[:], uint64(len(b)))
		mac.Write(lp[:])
		mac.Write(b)
	}
	binary.BigEndian.PutUint64(lp[:], e.Seq)
	mac.Write(lp[:])
	write([]byte(e.PrevHash))
	write([]byte(e.Timestamp))
	write([]byte(e.Action))
	write([]byte(e.ActorID))
	write([]byte(e.Outcome))
	write(payload)

	return hex.EncodeToString(mac.Sum(nil)), nil
}

var sensitiveKeys = []string{
	"password", "token", "secret", "ssn", "credit_card", "cvv",
	"authorization", "api_key",
}

// secretValuePattern menangkap rahasia dari BENTUKNYA, bukan dari nama fieldnya.
//
// Penyaringan berbasis nama saja adalah yang dilarang bagian "Kapan JANGAN
// Pakai Ini" di berkas ini, dan yang didaftarkan tabel deteksi sebagai
// penyebab "rahasia ditemukan di sistem log" — tetapi versi sebelumnya hanya
// melakukan itu. Rahasia berpindah field, dan field baru muncul tanpa
// penyaringnya pernah tahu.
var secretValuePattern = regexp.MustCompile(
	`sk_live_[0-9A-Za-z]+|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|` +
		`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|` +
		`\b[45][0-9]{15}\b`)

func isSensitiveKey(k string) bool {
	lower := strings.ToLower(k)
	for _, s := range sensitiveKeys {
		if strings.Contains(lower, s) {
			return true
		}
	}
	return false
}

func scrubPII(data map[string]string) map[string]string {
	result := make(map[string]string, len(data))
	for k, v := range data {
		if isSensitiveKey(k) {
			result[k] = "[REDACTED]"
			continue
		}
		result[k] = safeTruncate(secretValuePattern.ReplaceAllString(v, "[REDACTED]"))
	}
	return result
}

// safeTruncate memotong pada batas RUNE, bukan byte.
//
// `v[:512]` memotong di tengah rune multi-byte dan menghasilkan UTF-8 tidak
// valid. Go menggantinya dengan U+FFFD saat encoding JSON, sehingga isinya
// rusak diam-diam — dan pada log audit, isi yang rusak berarti bukti yang
// rusak.
func safeTruncate(s string) string {
	if len(s) <= maxValLength {
		return s
	}
	cut := s[:maxValLength]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut + "...[TRUNCATED]"
}

// Sink menulis entri ke penyimpanan audit.
//
// Ia dipanggil DI LUAR kunci rantai. Menahan kunci selama I/O jaringan
// menyerialkan seluruh pencatatan audit di belakang tulisan paling lambat —
// dan pada laju tinggi itu menjadikan audit logging sebagai penyempitan
// layanan, yang pada gilirannya membuat orang tergoda mematikannya.
type Sink interface {
	Write(ctx context.Context, e AuditEvent) error
}

type SecureLogger struct {
	mu       sync.Mutex
	seq      uint64
	lastHash string
	hmacKey  []byte
	sink     Sink
}

func NewSecureLogger(hmacKey []byte, streamID string, sink Sink) *SecureLogger {
	return &SecureLogger{
		lastHash: rootHash(streamID),
		hmacKey:  hmacKey,
		sink:     sink,
	}
}

func (s *SecureLogger) LogEvent(ctx context.Context, action, actor, outcome string, payload map[string]string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("context canceled: %w", err)
	}

	clean := scrubPII(payload)

	// Hanya bagian yang WAJIB berurutan yang dikerjakan di dalam kunci.
	s.mu.Lock()
	s.seq++
	e := AuditEvent{
		Seq:       s.seq,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Action:    action,
		ActorID:   actor,
		Outcome:   outcome,
		Payload:   clean,
		PrevHash:  s.lastHash,
	}
	h, err := calculateHash(s.hmacKey, e)
	if err != nil {
		s.seq-- // jangan tinggalkan lubang nomor urut
		s.mu.Unlock()
		return err
	}
	e.Hash = h
	s.lastHash = h
	s.mu.Unlock()

	// I/O di luar kunci. Bila penulisan gagal, rantai TETAP maju — sengaja:
	// entri yang hilang lalu menjadi lubang nomor urut yang TERDETEKSI,
	// jauh lebih baik daripada rantai yang mulus tetapi diam-diam kehilangan
	// peristiwa.
	if err := s.sink.Write(ctx, e); err != nil {
		return fmt.Errorf("write audit entry seq %d: %w", e.Seq, err)
	}
	return nil
}

// Head mengembalikan hash terakhir, untuk diterbitkan sebagai checkpoint.
func (s *SecureLogger) Head() (uint64, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq, s.lastHash
}

// Verify memeriksa seluruh rantai.
//
// Keterbatasan yang tidak boleh disembunyikan: rantai hash mendeteksi
// **perubahan**, tetapi TIDAK mendeteksi **pemotongan**. Penyerang yang
// menghapus N entri TERAKHIR meninggalkan rantai yang sempurna valid — dan
// itulah justru yang akan ia lakukan, karena jejaknya ada di ujung. Nomor
// urut menutup lubang di tengah; untuk ujung rantai, satu-satunya jawaban
// adalah menerbitkan checkpoint (nilai Head) secara berkala ke penyimpanan
// lain yang tidak dikuasai penyerang yang sama.
func Verify(key []byte, streamID string, chain []AuditEvent) error {
	expected := rootHash(streamID)
	for i, e := range chain {
		if e.Seq != uint64(i+1) {
			return fmt.Errorf("%w: entry #%d has seq %d", ErrSequenceGap, i, e.Seq)
		}
		if e.PrevHash != expected {
			return fmt.Errorf("%w: entry seq %d", ErrBrokenChain, e.Seq)
		}
		h, err := calculateHash(key, e)
		if err != nil {
			return fmt.Errorf("entry seq %d: %w", e.Seq, err)
		}
		if !hmac.Equal([]byte(h), []byte(e.Hash)) {
			return fmt.Errorf("%w: entry seq %d", ErrHashMismatch, e.Seq)
		}
		expected = e.Hash
	}
	return nil
}
```

```go
package audit

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

type memorySink struct {
	mu      sync.Mutex
	entries []AuditEvent
}

func (s *memorySink) Write(_ context.Context, e AuditEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, e)
	return nil
}

// Clone mengembalikan SALINAN. Versi sebelumnya mengembalikan slice internal
// apa adanya, sehingga pemanggil bisa mengubah entri milik logger — dan
// ujinya memang melakukannya.
func (s *memorySink) Clone() []AuditEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]AuditEvent(nil), s.entries...)
}

const testStreamID = "api-production"

var testHMACKey = []byte("hmac-audit-key-that-is-sufficiently-long-and-secure")

func testLogger() (*SecureLogger, *memorySink) {
	s := &memorySink{}
	return NewSecureLogger(testHMACKey, testStreamID, s), s
}

// Uji terpenting di berkas ini. Versi sebelumnya menyetel hash akar ke
// hex(kunci HMAC), sehingga kunci itu terbit sebagai prev_hash pada entri
// pertama — dan seluruh mekanisme anti-tamper runtuh bagi siapa pun yang
// bisa membaca log.
func TestHMACKeyNeverLeakedInOutput(t *testing.T) {
	lg, sink := testLogger()
	if err := lg.LogEvent(context.Background(), "LOGIN", "usr_1", "success", nil); err != nil {
		t.Fatalf("LogEvent: %v", err)
	}

	e := sink.Clone()[0]
	keyHex := "686d61632d61756469742d6b65792d746861742d69732d73756666696369656e746c792d6c6f6e672d616e642d736563757265"
	for name, val := range map[string]string{"prev_hash": e.PrevHash, "hash": e.Hash} {
		if strings.Contains(val, keyHex) || strings.Contains(val, string(testHMACKey)) {
			t.Fatalf("HMAC key leaked via %s: %s", name, val)
		}
	}
}

// Timestamp WAJIB ikut ditandatangani. Tanpa itu, penyerang memindahkan waktu
// kejadian apa pun tanpa merusak rantai.
func TestTimestampTamperingDetected(t *testing.T) {
	lg, sink := testLogger()
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := lg.LogEvent(ctx, "ACTION", "usr_1", "success", nil); err != nil {
			t.Fatalf("LogEvent: %v", err)
		}
	}

	chain := sink.Clone()
	if err := Verify(testHMACKey, testStreamID, chain); err != nil {
		t.Fatalf("unmodified chain reported as invalid: %v", err)
	}

	chain[1].Timestamp = "2020-01-01T00:00:00Z"
	if err := Verify(testHMACKey, testStreamID, chain); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("error = %v, want ErrHashMismatch — timestamp was not signed", err)
	}
}

// Ruas tanpa awalan panjang bersifat ambigu: ("A","BC") dan ("AB","C")
// menghasilkan masukan MAC yang identik.
func TestFieldsNonAmbiguous(t *testing.T) {
	a := AuditEvent{Seq: 1, PrevHash: "p", Timestamp: "t", Action: "A", ActorID: "BC", Outcome: "success"}
	b := AuditEvent{Seq: 1, PrevHash: "p", Timestamp: "t", Action: "AB", ActorID: "C", Outcome: "success"}

	ha, err := calculateHash(testHMACKey, a)
	if err != nil {
		t.Fatalf("calculateHash a: %v", err)
	}
	hb, err := calculateHash(testHMACKey, b)
	if err != nil {
		t.Fatalf("calculateHash b: %v", err)
	}
	if ha == hb {
		t.Fatal("two different events generated identical hash — fields not length-prefixed")
	}
}

// Penghapusan di TENGAH terdeteksi lewat nomor urut, bukan lewat hash.
func TestMiddleDeletionDetected(t *testing.T) {
	lg, sink := testLogger()
	ctx := context.Background()
	for i := 0; i < 4; i++ {
		if err := lg.LogEvent(ctx, "ACTION", "usr_1", "success", nil); err != nil {
			t.Fatalf("LogEvent: %v", err)
		}
	}

	chain := sink.Clone()
	deleted := append(chain[:1:1], chain[2:]...) // buang entri seq 2
	if err := Verify(testHMACKey, testStreamID, deleted); !errors.Is(err, ErrSequenceGap) {
		t.Fatalf("error = %v, want ErrSequenceGap", err)
	}
}

// Rahasia dikenali dari BENTUK NILAI, bukan hanya dari nama field.
func TestScrubbingByValuePattern(t *testing.T) {
	lg, sink := testLogger()
	payload := map[string]string{
		"password": "original-secret",
		"notes":    "deploy key: AKIAIOSFODNN7EXAMPLE and token ghp_" + strings.Repeat("a", 36),
		"username": "jane doe",
	}
	if err := lg.LogEvent(context.Background(), "DEPLOY", "usr_1", "success", payload); err != nil {
		t.Fatalf("LogEvent: %v", err)
	}

	e := sink.Clone()[0]
	if e.Payload["password"] != "[REDACTED]" {
		t.Errorf("sensitive field name was not redacted: %q", e.Payload["password"])
	}
	// Field bernama "notes" tidak terdaftar sensitif; hanya penyaringan
	// berbasis pola yang bisa menangkap isinya.
	if strings.Contains(e.Payload["notes"], "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("AWS key leaked to log: %q", e.Payload["notes"])
	}
	if strings.Contains(e.Payload["notes"], "ghp_aaaa") {
		t.Errorf("GitHub token leaked to log: %q", e.Payload["notes"])
	}
	if e.Payload["username"] != "jane doe" {
		t.Errorf("non-sensitive data unexpectedly altered: %q", e.Payload["username"])
	}
}

func TestSafeTruncateUTF8(t *testing.T) {
	longStr := strings.Repeat("é", maxValLength) // 2 byte per rune
	result := safeTruncate(longStr)

	if !strings.HasSuffix(result, "...[TRUNCATED]") {
		t.Fatal("long value was not truncated")
	}
	core := strings.TrimSuffix(result, "...[TRUNCATED]")
	if !utf8.ValidString(core) {
		t.Fatal("truncation produced invalid UTF-8 — audit evidence silently corrupted")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Audit log di tempat yang sama dengan log aplikasi.** Audit harus tahan terhadap penghapusan oleh orang yang sedang diaudit. Simpan terpisah, append-only, dengan retensi dan kontrol akses sendiri.
- **Menyaring hanya berdasarkan nama field.** Rahasia berpindah field, dan field baru muncul tanpa yang menyaring tahu. Saring juga berdasarkan **bentuk nilai** — pola token, kunci, dan nomor kartu.
- **Mencatat seluruh permintaan "untuk berjaga-jaga".** Itu cara paling umum data pribadi masuk ke sistem yang tidak dirancang menyimpannya, dengan retensi lebih panjang dan akses lebih luas daripada database.
- **Audit log tanpa jaminan integritas.** Log yang bisa disunting bukan bukti. Untuk kebutuhan kepatuhan, dibutuhkan penyimpanan WORM atau rantai hash yang bisa diverifikasi.
- **Audit yang mencatat keberhasilan saja.** Percobaan yang **gagal** justru sinyal paling berharga saat investigasi — ia menunjukkan apa yang sedang dicoba seseorang.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Rahasia ditemukan di sistem log | pola nilai di log | Penyaringan berbasis nama field saja |
| Tidak bisa menjawab "siapa mengubah ini" | cakupan peristiwa yang diaudit | Audit hanya mencatat sebagian aksi |
| Audit log bisa dihapus operator | kontrol akses penyimpanan audit | Tidak ada pemisahan kewenangan |
| Investigasi buntu di percobaan gagal | apakah kegagalan dicatat | Hanya keberhasilan yang diaudit |
| Biaya penyimpanan log melonjak | apa yang dicatat per permintaan | Seluruh badan permintaan ikut tersimpan |
| Rantai valid tetapi peristiwa hilang | nomor urut & checkpoint kepala | Pemotongan di ujung tidak terdeteksi rantai hash |
| Waktu kejadian tidak masuk akal tapi hash cocok | apakah timestamp ikut di-MAC | Ruas waktu di luar cakupan tanda tangan |
| `prev_hash` entri pertama terlihat seperti kunci | asal hash akar | Kunci HMAC diterbitkan di baris log pertama |
| Latensi API naik seiring volume audit | apakah I/O sink di dalam kunci rantai | Pencatatan diserialkan di belakang tulisan terlambat |

```bash
# Rantai hash TIDAK mendeteksi pemotongan di ujung -- bandingkan nomor urut
# terakhir dengan checkpoint yang diterbitkan ke penyimpanan terpisah.
kubectl logs -l app=api --since=24h | jq -rs 'map(.seq) | max'
aws s3 cp s3://audit-checkpoints/api-production/latest.json - | jq -r '.seq'
```

```bash
# Deteksi rahasia berdasarkan BENTUK NILAI -- bukan nama field
kubectl logs -l app=api --since=1h \
  | grep -EC1 'sk_live_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{10,}\.eyJ|-----BEGIN' | head

# Nomor kartu yang lolos ke log (pola Luhn kasar)
kubectl logs -l app=api --since=1h | grep -oE '\b[45][0-9]{15}\b' | head

# Apakah kegagalan ikut diaudit?
kubectl logs -l app=audit --since=24h | jq -r '.outcome' | sort | uniq -c

# Retensi audit vs retensi log aplikasi -- keduanya harus berbeda
kubectl get pvc -l app=audit -o custom-columns='NAME:.metadata.name,SIZE:.spec.resources.requests.storage'
```
