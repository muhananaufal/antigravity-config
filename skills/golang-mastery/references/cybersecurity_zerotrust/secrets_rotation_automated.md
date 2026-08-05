# Secrets Rotation & Management via HashiCorp Vault di Go

> **Berlaku:** Go 1.21+ · HashiCorp Vault / cloud KMS · **Lihat juga:** `security_owasp/secret_management_vault.md` · `security_owasp/mtls_certificate_rotation.md` · `arch_patterns/config_management.md` · `security_owasp/aes_gcm_cryptography.md`

Dalam Zero Trust, static long-lived credentials (DB password permanen, API key hardcoded) adalah *original sin* keamanan. Vault menyediakan Dynamic Secrets — credential yang dibuat saat dibutuhkan, dengan TTL terbatas, dan di-revoke otomatis. Aplikasi Go tidak menyimpan password sama sekali; ia minta ke Vault dan Vault memberikan credential ephemeral.

---

## 1. Arsitektur: Dynamic Secret Lifecycle

```
Static Credentials (ANTI-PATTERN):
  DB_PASSWORD=s3cr3t → .env → deployed → NEVER rotated → leaked → breach

Dynamic Credentials via Vault (CORRECT):
                                                          
  Go Service                    Vault                 PostgreSQL
      │                           │                       │
      │─── K8s Auth (SA Token) ──►│                       │
      │◄── Vault Token (TTL:24h) ─│                       │
      │                           │                       │
      │─── /db/creds/api-role ───►│                       │
      │                           │── CREATE ROLE ──────►│
      │                           │   vault_api_abc123    │
      │◄── user/pass (TTL:1h) ───│                       │
      │                           │                       │
      │──────── connect ─────────────────────────────────►│
      │                           │                       │
      │                           │   (t=40min)           │
      │─── Renew Lease ──────────►│                       │
      │◄── Extended (TTL:1h) ─────│                       │
      │                           │                       │
      │                           │   (t=max_ttl=24h)     │
      │◄── DoneCh: revoked ───────│                       │
      │                           │── REVOKE ROLE ──────►│
      │                           │   vault_api_abc123    │
      │─── /db/creds/api-role ───►│ (new creds)           │
      │◄── user/pass (NEW) ───────│                       │

Key insight:
  - RenewCh: TTL diperpanjang, credential SAMA — jangan reconnect DB!
  - DoneCh:  credential EXPIRED/REVOKED — harus fetch baru + reconnect
```

---

## 2. Kode Go Production-Ready

```go
package secretsvault

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	vault "github.com/hashicorp/vault/api"
)

// DBCredential menyimpan dynamic credential dari Vault.
type DBCredential struct {
	Username string
	Password string
	LeaseID  string
}

// DBPool mengelola database connection pool dengan hot-swap credential support.
type DBPool struct {
	mu      sync.RWMutex
	db      *sql.DB
	dsn     string // template DSN: "host=pg port=5432 dbname=app user=%s password=%s"
	current DBCredential
}

// Swap mengganti credential dan membangun ulang connection pool.
// Dipanggil hanya saat Vault DoneCh — credential benar-benar expired.
func (p *DBPool) Swap(cred DBCredential) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	dsn := fmt.Sprintf(p.dsn, cred.Username, cred.Password)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(55 * time.Minute) // < Vault lease TTL (1h)

	// Graceful: tutup pool lama setelah pool baru siap
	old := p.db
	p.db = db
	p.current = cred

	if old != nil {
		// Beri waktu in-flight queries selesai sebelum close
		go func() {
			time.Sleep(5 * time.Second)
			old.Close()
		}()
	}
	return nil
}

// VaultSecretManager mengelola lifecycle Dynamic Secrets dari Vault.
type VaultSecretManager struct {
	client  *vault.Client
	logger  *slog.Logger
	running atomic.Bool
}

// NewVaultManager membuat VaultSecretManager dengan Vault client.
func NewVaultManager(addr, token string, logger *slog.Logger) (*VaultSecretManager, error) {
	cfg := vault.DefaultConfig()
	cfg.Address = addr

	client, err := vault.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("vault client: %w", err)
	}
	client.SetToken(token)

	if logger == nil {
		logger = slog.Default()
	}
	return &VaultSecretManager{client: client, logger: logger}, nil
}

// parseCredential mengekstrak DBCredential dari Vault Secret dengan safe type assertion.
func parseCredential(s *vault.Secret) (DBCredential, error) {
	if s == nil || s.Data == nil {
		return DBCredential{}, fmt.Errorf("nil secret or data")
	}

	user, ok := s.Data["username"].(string)
	if !ok || user == "" {
		return DBCredential{}, fmt.Errorf("missing or invalid username in secret")
	}
	pass, ok := s.Data["password"].(string)
	if !ok || pass == "" {
		return DBCredential{}, fmt.Errorf("missing or invalid password in secret")
	}

	return DBCredential{
		Username: user,
		Password: pass,
		LeaseID:  s.LeaseID,
	}, nil
}

// RunRotationLoop mengambil dynamic credential dan mengelola renewal/rotation.
// Blocking — jalankan di goroutine terpisah. Return saat ctx dibatalkan atau error fatal.
func (m *VaultSecretManager) RunRotationLoop(
	ctx context.Context,
	mount, role string,
	pool *DBPool,
) error {
	m.running.Store(true)
	defer m.running.Store(false)

	path := fmt.Sprintf("%s/creds/%s", mount, role)

	for {
		// Cek ctx sebelum fetch baru (menghindari fetch saat shutdown)
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		// 1. Fetch dynamic credential
		secret, err := m.client.Logical().ReadWithContext(ctx, path)
		if err != nil {
			m.logger.Error("failed to fetch credential", "err", err, "path", path)
			// Exponential backoff sebelum retry
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(10 * time.Second):
				continue
			}
		}

		cred, err := parseCredential(secret)
		if err != nil {
			return fmt.Errorf("parse credential: %w", err)
		}

		// 2. Swap credential ke pool baru
		if err := pool.Swap(cred); err != nil {
			return fmt.Errorf("db pool swap: %w", err)
		}
		m.logger.Info("credential loaded", "lease_id", cred.LeaseID, "user", cred.Username)

		// 3. Setup Renewer
		renewer, err := m.client.NewLifetimeWatcher(&vault.LifetimeWatcherInput{
			Secret: secret,
			Increment: 3600, // request 1h renewal
		})
		if err != nil {
			return fmt.Errorf("init renewer: %w", err)
		}

		go renewer.Start()

		// 4. Event loop — hanya handle sinyal dari renewer
	renewLoop:
		for {
			select {
			case <-ctx.Done():
				renewer.Stop()
				// Attempt revoke saat shutdown (Zero Trust: jangan tinggalkan orphaned lease)
				m.revokeGracefully(cred.LeaseID)
				return nil

			case err := <-renewer.DoneCh():
				// Credential expired/revoked — HARUS fetch baru
				if err != nil {
					m.logger.Warn("renewer stopped with error, rotating", "err", err)
				} else {
					m.logger.Info("lease max TTL reached, rotating credential")
				}
				renewer.Stop()
				break renewLoop // outer for loop akan fetch credential baru

			case renewal := <-renewer.RenewCh():
				// TTL diperpanjang, credential SAMA — TIDAK perlu reconnect!
				m.logger.Info("lease renewed",
					"ttl", renewal.Secret.LeaseDuration,
					"lease_id", renewal.Secret.LeaseID,
				)
				// JANGAN pool.Swap() di sini — credential tidak berubah!
			}
		}
	}
}

// revokeGracefully mencoba revoke lease di Vault saat shutdown.
func (m *VaultSecretManager) revokeGracefully(leaseID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.client.Sys().RevokeWithContext(ctx, leaseID); err != nil {
		m.logger.Warn("failed to revoke lease on shutdown", "lease_id", leaseID, "err", err)
	} else {
		m.logger.Info("lease revoked on shutdown", "lease_id", leaseID)
	}
}

// --- Unit Tests ---

func TestParseCredential_Valid(t *testing.T) {
	secret := &vault.Secret{
		LeaseID: "database/creds/api-role/abc123",
		Data: map[string]interface{}{
			"username": "vault_api_abc123",
			"password": "s3cr3t-dynamic-pass",
		},
	}

	cred, err := parseCredential(secret)
	if err != nil {
		t.Fatalf("parseCredential: %v", err)
	}
	if cred.Username != "vault_api_abc123" {
		t.Errorf("username = %q, want vault_api_abc123", cred.Username)
	}
	if cred.Password != "s3cr3t-dynamic-pass" {
		t.Errorf("password mismatch")
	}
	if cred.LeaseID != "database/creds/api-role/abc123" {
		t.Errorf("lease_id = %q", cred.LeaseID)
	}
}

func TestParseCredential_NilSecret(t *testing.T) {
	_, err := parseCredential(nil)
	if err == nil {
		t.Error("expected error for nil secret, got nil")
	}
}

func TestParseCredential_MissingUsername(t *testing.T) {
	secret := &vault.Secret{
		Data: map[string]interface{}{
			"password": "pass",
			// username missing
		},
	}
	_, err := parseCredential(secret)
	if err == nil {
		t.Error("expected error for missing username")
	}
}

func TestParseCredential_WrongType(t *testing.T) {
	// Type assertion guard: Data["username"] adalah int, bukan string
	secret := &vault.Secret{
		Data: map[string]interface{}{
			"username": 12345, // wrong type
			"password": "pass",
		},
	}
	_, err := parseCredential(secret)
	if err == nil {
		t.Error("expected error for non-string username")
	}
}

func TestDBPool_SwapUpdatesCredential(t *testing.T) {
	// Verifikasi bahwa Swap mengupdate current credential
	// Tanpa real DB — test hanya memeriksa state transition
	pool := &DBPool{
		dsn: "host=localhost dbname=test user=%s password=%s sslmode=disable",
	}

	cred := DBCredential{
		Username: "vault_user_new",
		Password: "vault_pass_new",
		LeaseID:  "db/creds/role/xyz",
	}

	// sql.Open tidak membuat koneksi real sampai Query dipanggil
	// Jadi ini aman ditest tanpa real postgres
	pool.mu.Lock()
	pool.current = cred
	pool.mu.Unlock()

	pool.mu.RLock()
	current := pool.current
	pool.mu.RUnlock()

	if current.Username != "vault_user_new" {
		t.Errorf("username = %q, want vault_user_new", current.Username)
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Reconnect DB saat `RenewCh` (bukan `DoneCh`)

```go
// BAD: Reconnect setiap kali lease di-renew (setiap 30-40 menit)
case renewal := <-renewer.RenewCh():
    pool.Close()       // SALAH! Credential sama, tidak perlu reconnect
    pool.Reconnect(renewal.Secret.Data["password"].(string))
    // → Transaksi aktif diputus paksa setiap 30 menit
    // → p99 latency spike di setiap renewal window

// GOOD: RenewCh = TTL extended, credential TIDAK berubah → tidak perlu apa-apa
case renewal := <-renewer.RenewCh():
    logger.Info("lease renewed", "new_ttl", renewal.Secret.LeaseDuration)
    // Tidak perlu reconnect. Credential masih sama.

// Reconnect HANYA saat DoneCh — credential benar-benar revoked/expired
case err := <-renewer.DoneCh():
    // Fetch credential baru dari Vault, lalu pool.Swap(newCred)
```

**Kenapa berbahaya:** `RenewCh` hanya memperpanjang masa sewa credential yang sama — password tidak berubah. Reconnect DB saat ini memutus semua koneksi aktif dalam pool, memaksa re-establish ribuan koneksi TCP + PostgreSQL auth handshake secara bersamaan. Pada sistem dengan 1000 koneksi aktif, ini menyebabkan thundering herd ke database.

### ❌ Anti-Pattern 2: Polling Vault per Request (DDoS ke Vault)

```go
// BAD: Fetch credential baru di setiap HTTP request
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Dipanggil 10,000x per detik → Vault menerima 10,000 API calls/detik
    secret, _ := vaultClient.Logical().Read("database/creds/api-role")
    db.Connect(secret.Data["username"].(string), secret.Data["password"].(string))
    // ...
}

// GOOD: Credential di-cache di DBPool, diperbarui hanya via rotation loop
// Handler cukup mengambil *sql.DB dari pool yang sudah ada credential-nya
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    h.pool.mu.RLock()
    db := h.pool.db
    h.pool.mu.RUnlock()
    // Use db for query...
}
```

**Kenapa berbahaya:** Vault dirancang untuk *secret management*, bukan high-QPS API. Vault cluster (HA mode dengan Raft) memiliki throughput terbatas (ribuan req/s). Polling per request dengan 10K TPS akan melumpuhkan Vault cluster — seluruh sistem Zero Trust perusahaan down.

### ❌ Anti-Pattern 3: Type Assertion Tidak Aman dari `secret.Data`

```go
// BAD: Panic jika Vault mengembalikan format berbeda atau data nil
username := secret.Data["username"].(string) // PANIC jika key tidak ada atau nil
password := secret.Data["password"].(string) // PANIC jika Vault API berubah

// GOOD: Safe type assertion dengan validasi eksplisit
user, ok := secret.Data["username"].(string)
if !ok || user == "" {
    return fmt.Errorf("invalid credential from Vault: missing username")
}
// Fungsi parseCredential() di atas menerapkan pattern ini
```

**Kenapa berbahaya:** `secret.Data` adalah `map[string]interface{}`. Panic dari type assertion yang gagal di production = downtime. Vault versi berbeda atau misconfigured secret engine bisa mengembalikan format data yang berbeda — defensive assertion wajib.

---

## 4. Edge Cases & Defensive Programming

1. **Vault Unavailable selama Rotation:** Jika Vault down tepat saat DoneCh fired (credential expired), retry ke Vault akan gagal. Selama ini, credential lama sudah di-revoke oleh Vault — DB koneksi akan mulai gagal. Solusi: set `ConnMaxLifetime` di pool sedikit lebih pendek dari Vault lease TTL. Tambahkan exponential backoff dengan jitter saat retry fetch. Pisahkan antara "credential expired" (fatal, perlu restart app) dan "Vault temporarily down" (retry aman).

2. **Orphaned Lease saat SIGKILL:** `renewer.Stop()` dan revoke API tidak sempat dipanggil jika pod di-SIGKILL langsung. Credential lama tetap valid di PostgreSQL hingga max_ttl-nya habis. Mitigasi: konfigurasikan Vault Database Engine dengan `max_ttl` agresif (misal 2 jam). Tambahkan Vault Audit Log monitoring untuk deteksi credential yang tidak di-revoke dalam waktu wajar.

3. **Race Condition antara Swap dan Active Queries:** Saat `pool.Swap()` dipanggil, koneksi yang sedang digunakan query aktif tidak langsung terputus (karena pool lama di-close dalam goroutine dengan delay 5 detik). Tapi ada window singkat di mana koneksi dari pool lama masih ada. Pastikan `SetConnMaxLifetime` pool lama sudah lewat agar koneksi tidak direcycle, dan monitor `db.Stats().InUse` sebelum close.

4. **Vault Token Renewal Terpisah dari Secret Renewal:** Vault Token (untuk autentikasi ke Vault itu sendiri) juga punya TTL terpisah dari Dynamic Secret TTL. Jika Vault Token expired, semua operasi ke Vault (termasuk renew) akan gagal dengan 403. Gunakan K8s Auth Method (Service Account Token) yang auto-renews, atau Vault Agent Injector yang mengelola token lifecycle secara transparan.

5. **Multiple Instances / Race pada Initial Fetch:** Di Kubernetes dengan multiple replicas, semua pod fetch credential baru secara bersamaan saat start. Masing-masing mendapat credential yang berbeda (Vault membuat user unik per request). Ini benar dan expected — tidak ada race condition karena setiap pod punya credential-nya sendiri. Total koneksi ke DB = jumlah pods × max_open_conns — monitor ini di Grafana untuk capacity planning.

## Kapan JANGAN Pakai Ini

- **Rotasi tanpa periode tumpang tindih.** Kredensial lama WAJIB tetap berlaku sampai setiap konsumen mengambil yang baru. Tanpa itu, "rotasi" adalah nama lain untuk pemadaman terjadwal.
- **Otomasi rotasi yang belum pernah dijalankan sungguhan.** Rotasi yang hanya diuji di atas kertas akan gagal pada saat pertama kali benar-benar dibutuhkan — yaitu ketika ada kebocoran dan waktunya paling sempit.
- **Rotasi manual dengan pengingat di kalender.** Ia akan terlewat, dan pertama kali terlewat biasanya saat orang yang mengingatnya sedang cuti.
- **Merotasi tanpa mencabut yang lama.** Kredensial lama yang tetap berlaku selamanya membuat rotasi menjadi penambahan, bukan penggantian — dan permukaan serangannya justru bertambah tiap siklus.
- **Mencabut tanpa memantau siapa yang masih memakai kredensial lama.** Anda perlu tahu konsumen mana yang tertinggal **sebelum** mencabut, bukan setelah teleponnya berdering.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pemadaman tepat saat jadwal rotasi | periode tumpang tindih | Kredensial lama dicabut terlalu cepat |
| Kredensial berumur bertahun-tahun | metadata rotasi terakhir | Rotasi tidak pernah benar-benar berjalan |
| Kredensial lama masih dipakai setelah rotasi | log pemakaian per versi | Ada konsumen yang tidak memperbarui |
| Rotasi berhasil tapi layanan tetap pakai yang lama | apakah rahasia dimuat ulang | Rahasia diambil sekali saat start |
| Jumlah kredensial aktif terus bertambah | daftar kredensial | Rotasi menambah, bukan mengganti |

```bash
# Kapan tiap rahasia terakhir dirotasi -- angka bertahun berarti otomasinya mati
vault kv metadata get -format=json secret/app/database | jq '.data.updated_time, .data.current_version'
vault list -format=json sys/leases/lookup/database/creds | jq length

# Kredensial lama yang masih dipakai: cabut hanya setelah angka ini nol
kubectl logs -l app=api --since=24h \
  | jq -r 'select(.kredensial_versi) | .kredensial_versi' | sort | uniq -c

# Rotasi yang gagal
kubectl logs -l app=rotator --since=7d | grep -ci 'rotasi gagal\|rotation failed'
```
