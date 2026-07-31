# Panduan Definitif: Manajemen Rahasia Dinamis dengan Vault & Viper

## 1. Konsep dan Internals (Technical Depth)

Penyimpanan *secret* (DB password, API Keys AWS) di *source code*, dalam Git (`.env` yang terbawa *commit*), atau secara statis di Kubernetes Secrets tanpa masa kadaluarsa, adalah risiko utama (*OWASP A02: Cryptographic Failures*). Modern cloud-native pattern menyelesaikan masalah ini secara mendasar dengan konsep **Dynamic Secrets**.

1. **Dynamic Secrets**: Engine rahasia seperti *HashiCorp Vault* menghasilkan kredensial *on-the-fly* (di saat ini juga). Kredensial DB (PostgreSQL) yang diberikan bukan akun `admin` selamanya, melainkan akun buatan mesin yang masa aktifnya (*TTL/Lease Time*) hanya 1 jam dan bisa segera dicabut otomatis dari sisi server (*Revocation*).
2. **Sidecar / Agent Pattern**: Aplikasi Go TIDAK mengimpor *Library Vault API*. Sebagai gantinya, *Pod* K8S menjalankan *Vault Agent Sidecar*. Sidecar itu yang melakukan Auth dan menjemput (pull) *secret* lalu menyimpannya di file disk RAM Memory (Shared TmpFS `dev/shm`). Aplikasi Go HANYA membaca file dari disk internal (File JSON).
3. **In-Memory Redaction**: Saat membaca rahasia, Go secara naif dapat mencetaknya ke stack trace saat aplikasi crash, atau saat `json.Marshal` digunakan di API diagnostic. Tipe Custom Go harus digunakan untuk memutus (Redact) rantai string ke log (`SecretString`).
4. **Hot-Reload (fsnotify / Viper)**: Karena akun DB berganti tiap 1 jam, aplikasi Golang harus membaca event "File Berubah" dari *TmpFS*. Ketika Sidecar memperbaharui JSON, Go harus membangun ulang *Connection Pool* ke DB secara *graceful* tanpa men-drop API yang sedang berjalan.

## 2. Diagram ASCII: Alur Injeksi Dinamis & Pool Swap

```text
[ HashiCorp Vault Server ]
        | (Memberikan kredensial DB umur 1 Jam secara reguler)
        v
+-------------------------------+      [ Kubernetes Pod ]
| Vault Agent (Sidecar)         |
| (Renew lease setiap 45 mnt)   |
+-------------------------------+
        | (Render ke File TmpFS: /vault/secrets/db_config.json)
        v
+-------------------------------+--------------------------------------------+
| File System Watcher (fsnotify)|                                            |
+-------------------------------+         (Go Application Container)         |
        |                                                                    |
        v                                 (Pool lama menuntaskan request)    |
| Update Memory Config  (Atomic)| - - > [ Old SQL.DB Pool  (Closing...) ]    |
| Emit "ConfigChanged" Event    |                                            |
|                               | ----> [ New SQL.DB Pool  (Active)     ]    |
| Re-init Connection Pool       |         (Kredensial baru dicolokkan)       |
+----------------------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Kredensial di `os.Getenv` dan Konstan

**Mengapa berbahaya (Exploit Vector)**: Jika password DB diambil dari `os.Getenv("DB_PASS")` satu kali saat bootup, nilainya tidak bisa dirubah tanpa *restart* (mematikan) aplikasi (*Downtime*). Variabel lingkungan di Linux sangat berisiko bocor saat admin salah mengetik `docker inspect` atau `env` dan melampirkannya di JIRA tiket. 

```go
// VULNERABLE: Konstan atau ENV statis selamanya
func connectDBVulnerable() {
	// ❌ BAD: Statis. Password tidak bisa di rotasi (tanpa restart pod). 
	// Dan ENV sering bocor di monitoring tools.
	pass := os.Getenv("POSTGRES_PASS") 
	db, _ := sql.Open("postgres", "user=admin password="+pass)
}
```

```go
// ✅ GOOD: Mengikat Config dari event file-watcher Vault yang dinamis. 
func connectDBSafe(cm *ConfigManager) {
	cfg := cm.GetConfig()
	// Password diekstrak sebagai string saat dibutuhkan oleh driver DB saja
	db, _ := sql.Open("postgres", "user="+cfg.DBUser+" password="+string(cfg.DBPass))
	// Lanjutkan inisialisasi pool...
}
```

### ❌ Anti-Pattern 2: Kebocoran Data (Data Bleed) di Struct Formatting

**Mengapa berbahaya (Exploit Vector)**: Dalam proses *debugging*, Developer mungkin menaruh perintah `%v` atau `json.Marshal()` pada obyek *Config/Connection struct*. Ini mencetak keseluruhan nilainya (termasuk String DB_PASSWORD asli) ke log *ElasticSearch* yang bisa dibaca ribuan pegawai.

```go
// VULNERABLE: Struct dengan String Publik
type BadConfig struct {
    Password string `json:"password"`
}
func debugLog() {
    c := BadConfig{Password: "real-db-secret"}
    // ❌ BAD: Tercetak plain-text: "Config is: {real-db-secret}"
    log.Printf("Config is: %v", c) 
}
```

```go
// ✅ GOOD: Gunakan tipe `SecretString` yang mencegah kebocoran secara tipe-data
type SafeConfig struct {
    Password SecretString `json:"password"`
}
func debugLogSafe() {
    c := SafeConfig{Password: "real-db-secret"}
    // ✅ GOOD: Tercetak: "Config is: {[REDACTED-SECRET]}"
    log.Printf("Config is: %v", c) 
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Race Condition Saat Reload**: Ada 1 detik kritis di mana Viper mendeteksi pembaruan file dan goroutine config mencoba mem-pointer konfigurasi baru, sementara ratusan handler HTTP goroutine sedang menggunakan config lama. Anda **HARUS** melindungi struct konfig dengan `sync.RWMutex` atau `atomic.Value`, karena Read/Write pointer memori secara simultan di Go = Panic.
2. **Koneksi Mati & EOF vs Lease Expiry**: Kredensial Vault aktif selama 60 menit. Di golang database connection pool, anda punya setting `SetConnMaxLifetime`. Jika `SetConnMaxLifetime` Anda disetel selama 70 menit, aplikasi Go akan me-reuse koneksi yang *sudah ditutup Vault secara sepihak*. Anda akan mendapat banyak error `EOF` acak di production. Set `SetConnMaxLifetime` di Go **lebih kecil** daripada TTL lease Vault (e.g. 50 Menit).
3. **Vault Down saat Bootstrap**: Jika sistem *Vault Agent* telat booting di *Pod*, aplikasi Go membaca JSON dan mendapat *File Not Found*. Go akan panic dan CrashLoop. Go harus meresponsnya dengan *Retry-Backoff* atau setidaknya menunggu signal File di awal.

## 5. Production-Ready Go Code

Implementasi arsitektur aman mencegah *Memory Dump leak* serta sistem Hot-Swap konfigurasi dan database tanpa mematikan layanan (Zero Downtime).

```go
package secret

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// SecretString adalah custom-type pertahanan aktif pencegah Data Bleed (Memory Dump).
type SecretString string

// String men-override print `%s` dan `%v` (fmt package)
func (s SecretString) String() string {
	return "[REDACTED-SECRET]"
}

// MarshalJSON men-override serialization (json package)
func (s SecretString) MarshalJSON() ([]byte, error) {
	return json.Marshal("[REDACTED-SECRET]")
}

// Config struktur yang diikat oleh file hasil render Sidecar Vault
type Config struct {
	DBHost string       `json:"db_host"`
	DBUser string       `json:"db_user"`
	DBPass SecretString `json:"db_pass"`
}

// ConfigManager menangani Hot-Reload (Rotasi Rahasia) secara Thread-Safe.
type ConfigManager struct {
	mu     sync.RWMutex
	config Config
	
	// OnChange listener untuk men-trigger swap resource (seperti koneksi DB)
	OnChange func(ctx context.Context, newCfg Config) error
}

func NewConfigManager(initial Config) *ConfigManager {
	return &ConfigManager{
		config: initial,
	}
}

// ReloadConfig dipanggil oleh fsnotify/Viper (goroutine latar) saat file json diupdate.
func (cm *ConfigManager) ReloadConfig(ctx context.Context, newConfig Config) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("context cancelled before reload: %w", err)
	}

	// 1. Thread-safe atomic pointer swap
	cm.mu.Lock()
	cm.config = newConfig
	cm.mu.Unlock()

	// 2. Eksekusi Hook secara graceful (misal: Init pool DB baru)
	if cm.OnChange != nil {
		if err := cm.OnChange(ctx, newConfig); err != nil {
			return fmt.Errorf("hook onchange failed: %w", err)
		}
	}
	return nil
}

// GetConfig membaca secret dengan read lock yang aman
func (cm *ConfigManager) GetConfig() Config {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	return cm.config
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestSecretRedactionBoundary(t *testing.T) {
	// Boundary: Pastikan SecretString membungkam fungsi Print maupun JSON Marshal
	cfg := Config{
		DBHost: "postgres.int",
		DBUser: "vault-role",
		DBPass: "REAL_DATABASE_PASSWORD_XYZ",
	}

	// Tes 1: Memory dump formatter %v (Sering muncul di Log Panic)
	rawLog := fmt.Sprintf("Config dumped: %v", cfg)
	if strings.Contains(rawLog, "REAL_DATABASE_PASSWORD_XYZ") {
		t.Fatalf("CRITICAL LEAK: Password exposed in fmt.Sprintf log! Output: %s", rawLog)
	}
	if !strings.Contains(rawLog, "[REDACTED-SECRET]") {
		t.Errorf("Expected [REDACTED-SECRET] in log output")
	}

	// Tes 2: JSON Serialization API Leak (Sering terjadi jika model API beririsan dengan Config)
	bytesJson, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}
	
	jsonString := string(bytesJson)
	if strings.Contains(jsonString, "REAL_DATABASE_PASSWORD_XYZ") {
		t.Fatalf("CRITICAL LEAK: Password exposed in JSON payload! Output: %s", jsonString)
	}
	if !strings.Contains(jsonString, "[REDACTED-SECRET]") {
		t.Errorf("Expected [REDACTED-SECRET] in JSON output")
	}
}

func TestDynamicReloadBoundary_RaceConditionSafe(t *testing.T) {
	ctx := context.Background()
	
	initial := Config{DBUser: "v_1", DBPass: "old_pass"}
	cm := NewConfigManager(initial)
	
	// Hook simulasi Re-Connection Database Pool Baru
	hookFired := false
	cm.OnChange = func(c context.Context, newCfg Config) error {
		hookFired = true
		if newCfg.DBUser != "v_2" {
			return fmt.Errorf("expected new user v_2, got %s", newCfg.DBUser)
		}
		return nil
	}

	// Simulasi event file system write dari HashiCorp Vault Agent
	newCfg := Config{DBUser: "v_2", DBPass: "new_pass"}
	err := cm.ReloadConfig(ctx, newCfg)
	if err != nil {
		t.Fatalf("Reloading failed: %v", err)
	}

	if !hookFired {
		t.Errorf("OnChange hook was not triggered properly")
	}

	// Verifikasi State Thread-Safe terbaca
	activeCfg := cm.GetConfig()
	if activeCfg.DBUser != "v_2" {
		t.Errorf("Config was not swapped, got %s", activeCfg.DBUser)
	}
}

func TestConfigManager_ContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel ctx immediately

	cm := NewConfigManager(Config{DBUser: "init"})
	err := cm.ReloadConfig(ctx, Config{DBUser: "new"})
	
	if err == nil {
		t.Fatal("Expected error due to cancelled context, got nil")
	}
}
```
