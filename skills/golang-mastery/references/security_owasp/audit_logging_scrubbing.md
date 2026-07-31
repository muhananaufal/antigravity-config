# Panduan Definitif: Audit Logging, PII Scrubbing & Tamper Detection

## 1. Konsep dan Internals (Technical Depth)

Data *Audit Log* sangat penting untuk keamanan sistem, memfasilitasi forensik saat terjadi peretasan, dan wajib bagi standar kepatuhan operasional seperti PCI-DSS, SOC2, dan HIPAA. Namun, seringkali *log system* yang dibuat justru menjadi kelemahan terbesar (titik kebocoran data / *Data Bleed*).

1. **PII Scrubbing (Masking/Redaction)**: Sebelum dikirim ke *sink* seperti stdout/Kibana/Elasticsearch, log tidak boleh memuat *Personally Identifiable Information (PII)* atau rahasia otentikasi (Password, JWT, CC Number). Harus ada proses filter otomatis.
2. **Right to Erasure (GDPR)**: Jika user meminta penghapusan akun, log masa lalu secara hukum tidak boleh menautkan data kepadanya. Solusinya: Jangan log "Email", melainkan log *Pseudonym* (User UUID/Hash) yang dapat dihapus dari tabel relasi (anonymization).
3. **Structured JSON Logs**: Log mentah (string concat) mustahil disaring atau diagregasi oleh SIEM. Setiap record log harus menjadi JSON yang ketat.
4. **Log Tampering & Immutable Audit Trails**: Jika *attacker* memegang akses *root* server, hal pertama yang dilakukan adalah menghapus atau mengedit file log (*covering tracks*). Anda membutuhkan mekanisme *Forward Secrecy* pada log, sering diimplementasikan via:
   - Pengiriman *UDP syslog* ke server *append-only* terpisah (Write-Once Read-Many/WORM storage).
   - **Cryptographic Hash Chaining**: Tiap baris log menyimpan nilai hash *HMAC-SHA256* yang merupakan hasil persilangan data log saat ini dengan nilai hash *dari baris log sebelumnya*. Mirip struktur *Blockchain*, jika attacker mengedit satu baris saja di tengah file log, seluruh *hash* pada baris-baris setelahnya akan rusak.

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
2. **Kinerja CPU pada Scrubbing Regex**: Menjalankan regular expression yang rumit pada setiap byte JSON (misal payload berukuran 5MB) pada kecepatan 10.000 Request/detik akan membuat CPU Go Anda hangus (99% usage). Terapkan *Scrubbing* pada *Key Map* level, bukan string regex level, dan batasi ukuran log payload yang diproses (*truncate max 2000 chars*).
3. **Konkurensi & Mutex pada HMAC Chain**: Perhitungan Chaining harus berurutan (*Sequential*). Di Go, *Goroutine* API handler sifatnya konkuren (paralel). Jika dua API handler berjalan bersamaan, perebutan variabel `PrevHash` (Race Condition) akan menghancurkan rantai hash. Pastikan penulisan rantai dilindungi oleh `sync.Mutex` atau gunakan arsitektur saluran (*Channel Actor Model*) di background.

## 5. Production-Ready Go Code

Implementasi sistem logger modular yang melindungi data sensitif (PII Masking) dan menjamin non-repudiation menggunakan HMAC-SHA256 Hash Chaining via Channel Pipeline yang konkuren-aman.

```go
package audit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// AuditEvent merepresentasikan skema standar SIEM log
type AuditEvent struct {
	Timestamp   string            `json:"ts"`
	Action      string            `json:"action"`
	ActorID     string            `json:"actor_id"`
	Payload     map[string]string `json:"payload"`
	PrevHash    string            `json:"prev_hash"`
	CurrentHash string            `json:"hash"`
}

// engine global state (untuk sinkronisasi chaining hash)
type SecureLogger struct {
	mu        sync.Mutex
	lastHash  string
	hmacKey   []byte
	logSink   []AuditEvent // Simulasi I/O output (misal write ke Elasticsearch)
}

// NewSecureLogger membuat logger dengan base root hash dari Vault Key
func NewSecureLogger(secretKey []byte) *SecureLogger {
	return &SecureLogger{
		lastHash: hex.EncodeToString(secretKey),
		hmacKey:  secretKey,
		logSink:  make([]AuditEvent, 0),
	}
}

// scrubPII menyisir struktur Map secara aman (O(N) keys) tanpa Regex mahal
func scrubPII(data map[string]string) map[string]string {
	sensitiveKeys := []string{"password", "token", "ssn", "secret", "credit_card", "cvv"}
	scrubbed := make(map[string]string, len(data))

	for k, v := range data {
		isSensitive := false
		lowerK := strings.ToLower(k)
		for _, sk := range sensitiveKeys {
			if strings.Contains(lowerK, sk) {
				isSensitive = true
				break
			}
		}

		if isSensitive {
			scrubbed[k] = "[REDACTED]"
		} else {
			// Limit panjang string untuk mencegah OOM saat SIEM menelan log raksasa
			if len(v) > 512 {
				scrubbed[k] = v[:512] + "...[TRUNCATED]"
			} else {
				scrubbed[k] = v
			}
		}
	}
	return scrubbed
}

// LogEvent melakukan masking data dan merekatkan hash kriptografis log ke chain sebelumnya
func (s *SecureLogger) LogEvent(ctx context.Context, action, actor string, payload map[string]string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("context timeout: %w", err)
	}

	scrubbedData := scrubPII(payload)

	// Lock mutex memastikan strict ordering event agar HashChain valid.
	// Di environment High-Throughput, gunakan background worker (Go Channel)
	s.mu.Lock()
	defer s.mu.Unlock()

	event := AuditEvent{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Action:    action,
		ActorID:   actor,
		Payload:   scrubbedData,
		PrevHash:  s.lastHash,
	}

	// Sign data = PrevHash + Action + ActorID + JSON(Payload)
	mac := hmac.New(sha256.New, s.hmacKey)
	mac.Write([]byte(event.PrevHash))
	mac.Write([]byte(event.Action))
	mac.Write([]byte(event.ActorID))
	
	payloadBytes, _ := json.Marshal(event.Payload)
	mac.Write(payloadBytes)

	event.CurrentHash = hex.EncodeToString(mac.Sum(nil))
	s.lastHash = event.CurrentHash // Majukan chain-nya

	// (Di environment real, encode ke JSON dan tulis ke disk / stdout)
	s.logSink = append(s.logSink, event)

	return nil
}

// GetLogs digunakan untuk keperluan simulasi read-only I/O
func (s *SecureLogger) GetLogs() []AuditEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logSink
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestAuditLogSecurityBoundaries(t *testing.T) {
	ctx := context.Background()
	secretKey := []byte("master-secret-vault-key-very-long")
	logger := NewSecureLogger(secretKey)

	// --- 1. Boundary: Scrubbing Confidential PII ---
	payload1 := map[string]string{
		"target_user": "jane_doe",
		"password":    "janeS3cret!@#", // MUST BE SCRUBBED
		"token_id":    "eyJhbGc...",    // MUST BE SCRUBBED
	}
	_ = logger.LogEvent(ctx, "ADMIN_RESET_PASS", "usr_admin", payload1)
	
	logs := logger.GetLogs()
	if len(logs) == 0 {
		t.Fatalf("Log not written")
	}
	
	if logs[0].Payload["password"] != "[REDACTED]" {
		t.Errorf("Password was not redacted! Data leak: %s", logs[0].Payload["password"])
	}
	if logs[0].Payload["token_id"] != "[REDACTED]" {
		t.Errorf("Token was not redacted!")
	}
	if logs[0].Payload["target_user"] != "jane_doe" {
		t.Errorf("Non-sensitive data tampered")
	}

	// --- 2. Boundary: Truncating Huge Payload (DOS limit) ---
	hugeString := strings.Repeat("A", 1000)
	payload2 := map[string]string{"notes": hugeString}
	_ = logger.LogEvent(ctx, "UPDATE_NOTES", "usr_admin", payload2)

	logs = logger.GetLogs()
	if !strings.HasSuffix(logs[1].Payload["notes"], "[TRUNCATED]") {
		t.Errorf("Huge payload was not truncated")
	}

	// --- 3. Boundary: Chain Integrity & Tamper Detection ---
	// LogEvent memajukan PrevHash dengan benar
	if logs[1].PrevHash != logs[0].CurrentHash {
		t.Errorf("Blockchain broken: Event[1].PrevHash (%s) != Event[0].Hash (%s)", logs[1].PrevHash, logs[0].CurrentHash)
	}

	// Simulasi Tampering: Hacker mengedit logSink database/stdout di masa depan
	logs[0].Action = "ADMIN_RESET_PASS_TAMPERED"

	// Kita bangun ulang hash (Simulasi Audit verifier tools script)
	mac := hmac.New(sha256.New, secretKey)
	mac.Write([]byte(logs[0].PrevHash))
	mac.Write([]byte(logs[0].Action)) // Hacker merubah variabel ini
	mac.Write([]byte(logs[0].ActorID))
	pBytes, _ := json.Marshal(logs[0].Payload)
	mac.Write(pBytes)
	
	recalculatedHash := hex.EncodeToString(mac.Sum(nil))

	// Karena teks dirubah, recalculatedHash TIDAK SAMA DENGAN logs[0].CurrentHash
	if recalculatedHash == logs[0].CurrentHash {
		t.Fatalf("Tampering protection failed, hash matches despite changes")
	}
}
```
