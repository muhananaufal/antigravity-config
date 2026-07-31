# Feature Flags (LaunchDarkly Pattern)

## 1. Konsep & Internal

Dalam rilis perangkat lunak tradisional, fitur yang sudah dikembangkan (di-*merge* ke *master*) akan dirilis semuanya kepada *semua pengguna* pada hari H *deployment*. Hal ini sangat berisiko. Jika fitur terdapat *bug*, aplikasi akan *down*, dan Anda harus melakukan *Rollback Deployment* (yang memakan waktu).

**Feature Flagging (Toggle)** memisahkan *Deployment* (menaruh kode ke produksi) dari *Release* (menyalakan fitur bagi pengguna). 
Kode fitur disembunyikan di balik blok kondisional (`if flag_enabled`). Fitur ini dapat diatur nyala/mati melalui *dashboard eksternal* secara dinamis di tingkat *runtime* **tanpa perlu re-deploy**.

Fungsi utama:
- **Trunk-Based Development**: Developer bisa terus me-*merge* kode harian ke master, tapi dalam keadaan fitur "Mati".
- **Canary Release & A/B Testing**: Menyalakan fitur baru hanya untuk `10%` pengguna acak, atau khusus pengguna premium.
- **Kill Switch**: Jika sistem pihak ketiga (misal: *Payment Gateway*) *down*, matikan fiturnya segera lewat tombol *toggle* agar pengguna tidak mengalami error terus menerus.

### Arsitektur Internal: Polling vs Streaming (SSE)

Dalam implementasi *enterprise*, klien tidak hanya mem- *poll* (HTTP GET tiap X detik), melainkan membuat koneksi *Server-Sent Events (SSE)* ke *Flag Control Plane*. Ketika ada perubahan di *dashboard*, *Flag Server* mendorong pembaruan *state* secara *real-time* ke semua *instance* API kita, mengurangi *Eventual Consistency window* dari 30 detik menjadi *sub-millisecond*.

Selain itu, mesin evaluasi (*Evaluator*) menggunakan *MurmurHash3* atau *SHA-1* untuk mengevaluasi *bucket* pengguna secara deterministik murni di sisi memori lokal tanpa I/O jaringan.

### Diagram Alir (ASCII)

```ascii
    [ LaunchDarkly / Flag Control Plane ]
        |                              ^
        | (1) SSE Stream (Push rules)  | (2) Metrics/Analytics (Batch push)
        v                              |
    [ API Server Node (Go Application) ]
        |
        +--[ SSE Client ] ---> (Updates) ---> [ RWMutex / atomic.Pointer ]
        |                                             |
        +--[ Evaluator Engine ] <--- (Reads) ---------+
                 |
============================================================
[ User Traffic: Alice (ID: 9942) ]
        |
        v
[ HTTP Handler (Middleware) ] -> Minta Evaluasi: "New_Checkout_Flow"
        |
    [ Evaluator Engine ]
        |  1. Cek Context (Targeting Rules: Country == "ID"?)
        |  2. Cek Cache In-Memory: rule { Percent: 20, KillSwitch: ON }
        |  3. Kalkulasi: sha1("9942" + "New_Checkout_Flow") % 100
        |  4. Hasil Hash: 14. (14 < 20) -> TRUE!
        |
    /       \
  (Ya)      (Tidak)
  /           \
[ V2 ]        [ V1 (Old) ]
```

## 2. Production-Ready Code (In-Memory Evaluator)

Sistem *Feature Flag* tidak boleh mengirim HTTP *request* ke server *flagging* setiap kali klien meminta, karena akan memperlambat respon (RPS aplikasi bisa turun 10x). Sistem Go harus melakukan *background polling* untuk menarik aturan (*ruleset*), kemudian mengevaluasi kondisi pengguna lokal di dalam memori.

```go
package flags

import (
	"context"
	"crypto/sha1"
	"encoding/binary"
	"log"
	"sync"
	"time"
)

// FlagRule menyimpan aturan persentase rilis sebuah fitur.
type FlagRule struct {
	Enabled       bool // Tombol utama pembunuh (Kill Switch)
	PercentageOn  int  // 0 - 100 (Persentase penyebaran fitur)
}

// Client menyimpan aturan-aturan flag dan melakukan pembaruan berkala.
type Client struct {
	mu    sync.RWMutex
	rules map[string]FlagRule
}

func NewFlagClient() *Client {
	return &Client{
		rules: make(map[string]FlagRule),
	}
}

// RuleFetcher interface mempermudah mocking untuk unit testing.
type RuleFetcher interface {
	Fetch(ctx context.Context) map[string]FlagRule
}

func (c *Client) StartPolling(ctx context.Context, fetcher RuleFetcher) {
	ticker := time.NewTicker(30 * time.Second) // Update tiap 30 detik
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("Feature flag poller stopped")
			return
		case <-ticker.C:
			// Fetch dari Data Source terpusat
			newRules := fetcher.Fetch(ctx)
			
			// Replace in-memory config secara thread-safe
			c.mu.Lock()
			c.rules = newRules
			c.mu.Unlock()
		}
	}
}

// IsEnabled mengevaluasi apakah fitur menyala untuk user tertentu.
func (c *Client) IsEnabled(flagName string, userID string) bool {
	c.mu.RLock()
	rule, exists := c.rules[flagName]
	c.mu.RUnlock()

	// Jika flag belum diset atau dihapus, secara default fallback ke FALSE.
	if !exists {
		return false 
	}

	// 1. Kill Switch
	if !rule.Enabled {
		return false
	}

	// 2. Rollout 100%
	if rule.PercentageOn == 100 {
		return true
	}

	// 3. Rollout 0%
	if rule.PercentageOn == 0 {
		return false
	}

	// 4. Fractional Rollout (Canary)
	// Gunakan deterministic hashing berdasarkan FlagName + UserID 
	// agar "Alice" selalu mendapat experience yang sama (Tidak berkedip on/off tiap di-refresh).
	hash := sha1.Sum([]byte(flagName + userID))
	
	// Ambil 4 byte pertama, konversi ke int untuk modulus persentase
	val := binary.BigEndian.Uint32(hash[:4])
	
	// Bandingkan dengan modulus 100
	userBucket := int(val % 100)
	
	// Jika rule 20%, maka user dengan bucket 0-19 akan dapat 'true'
	return userBucket < rule.PercentageOn
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Flag Sebagai Konstanta Lingkungan (Environment Variables)
**Masalah**: Developer menggunakan `.env` untuk mematikan/menyalakan fitur.

❌ **BAD:**
```go
// BAD: Environment Variables butuh Server Restart
if os.Getenv("ENABLE_NEW_UI") == "true" {
    renderNewUI()
}
```
**Why dangerous:** Ini bukan *Feature Flagging* dinamis. Jika Anda merilis fitur yang tiba-tiba menguras *database*, dan sistem *down*, Anda harus mengubah nilai *env* lalu men-*deploy* ulang (atau *restart*) container Kubernetes Anda, yang mana akan menaikkan waktu *downtime* di produksi.

✅ **GOOD:**
```go
// GOOD: Gunakan poller in-memory
if flagClient.IsEnabled("NEW_UI", userID) {
    renderNewUI()
}
```

### ❌ Anti-Pattern 2: Menumpuk Utang Teknis (Stale Flags)
**Masalah**: Menambah *if-else flag* baru di kode base, tapi lupa menghapusnya setahun kemudian setelah fitur 100% stabil.

❌ **BAD:**
```go
// BAD: Terdapat puluhan blok kode yang tak pernah tersentuh
if flagClient.IsEnabled("Halloween_Promo_2022", userID) { ... }
if flagClient.IsEnabled("New_Architecture_Phase_1", userID) { ... }
```
**Why dangerous:** Kompleksitas kode naik (Cyclomatic Complexity), menyulitkan *testing* (*mocking flag* berlebihan), serta berisiko jika seseorang tidak sengaja me-klik `Off` di *dashboard* pada bendera tahun lalu, menyebabkan kelumpuhan fitur yang diyakini sudah permanen (*Release Toggle vs Ops Toggle*).

✅ **GOOD:**
```go
// GOOD: Hapus toggle lama dan gunakan kode permanen
renderNewArchitecture()
```

### ❌ Anti-Pattern 3: Kondisional Silang / Dependensi Flag (Flag Hell)
**Masalah**: Mengikat dua logika *flag* yang berbeda pada blok yang saling bertumpuk (nested).

❌ **BAD:**
```go
// BAD: Nested feature flags membuat matrix testing berlipat ganda
if flagClient.IsEnabled("NEW_PAYMENT_GATEWAY", userID) {
    if flagClient.IsEnabled("ENABLE_CRYPTO", userID) {
        // Harus ditest saat: (On, On), (On, Off), (Off, On), (Off, Off)
        ProcessCryptoNewGateway()
    } else {
        ProcessFiatNewGateway()
    }
} else {
    ProcessOldGateway()
}
```
**Why dangerous:** Ini meledakkan *state space* untuk *QA/Unit Testing* secara eksponensial. Jika salah satu flag dicabut dari server, kode akan memasuki state yang belum pernah diuji dengan benar di produksi.

✅ **GOOD:**
```go
// GOOD: Gunakan satu flag komposit atau pisahkan evaluasi bisnis dari evaluasi teknikal
// Evaluator flag harus menghasilkan satu state konfigurasi final.
config := getPaymentConfig(userID)
if config.UseNewGateway && config.EnableCrypto {
    ProcessCryptoNewGateway()
}
```

## 4. Edge Cases Spesifik

1. **Efek Berkedip (*Flicker*) pada Fractional Rollout**:
   *Masalah*: Developer menggunakan nilai `math.rand()` saat me- *rollout* `50%`. User *refresh* halaman, mereka dapat UI Baru. *Refresh* lagi, dapat UI Lama. User akan bingung dan mengeluhkan bug UI.
   *Implementasi Penanganan*: Wajib menggunakan *Deterministic Hashing* (misalnya dari penggabungan tipe *identifier UUID* user + nama *flag* `sha1(userID+flagName)`), seperti di contoh kode production. Hasil hash yang dimodulus akan selalu mengikat `user123` pada angka (bucket) yang persis sama, menjamin state permanen meskipun user memantul antar-server.

2. **Split Brain & Eventual Consistency antar Pod**:
   *Masalah*: Go mengambil data dari *dashboard* tiap 30 detik (*polling*). Pod A dan Pod B di Kubernetes mungkin tidak sinkron *state*-nya dalam rentang 30 detik masa transisi. Satu *user* me-*request* API dan masuk Pod A (mendapat fitur X), sedetik kemudian ia masuk Pod B lewat *Load Balancer* (fitur X lenyap karena Pod B belum *polling*).
   *Implementasi Penanganan*: Gunakan arsitektur dua arah (SSE / gRPC streaming) agar saat dashboard ditekan, perubahan di-push ke semua Pod dalam 10 milidetik. Sebagai mitigasi *fallback*, operkan parameter `X-Feature-State` melalui headers HTTP jika sistem berada di tengah arsitektur *microservices* terdistribusi (*Context Propagation*), sehingga *downstream* service akan mengeksekusi flag yang selaras dengan *upstream*.

3. **Latency Tersembunyi & Thundering Herd pada Start-up**:
   *Masalah*: Jika ada 100 Pod baru di-deploy bersamaan (HPA scaling), semuanya serentak meminta rules ke Flag Server eksternal (*Thundering Herd*), menyebabkan Flag Server *down*. Atau, developer lupa menggunakan in-memory dan malah query ke Redis per request HTTP.
   *Implementasi Penanganan*: 
   - Gunakan *in-memory RWMutex* caching untuk read path (0 I/O penalty).
   - Implementasikan *jitter* pada timer polling `time.Sleep(random_jitter)` agar request antar Pod menyebar merata, tidak di detik yang persis sama.
   - Sediakan *Fail-safe default* (misal fitur lokal JSON config file) sebagai *fallback* bila Flag Server *down* saat Pod *booting*.

4. **Data Race pada Concurrent Read/Write Cache**:
   *Masalah*: Saat poller mengupdate map dan HTTP handler membaca map, *panic: concurrent map read and map write* dapat terjadi di Go jika modifikasi map dilakukan secara naive.
   *Implementasi Penanganan*: Gunakan `sync.RWMutex` (seperti contoh di kode), atau di skenario dengan throughput ultra-tinggi (*High Frequency Trading*), gunakan `atomic.Pointer` untuk me-*replace* pointer map struct dalam 1 clock cycle tanpa melock read ops sama sekali (Zero-lock read).

## 5. Unit Tests (Behavioral Testing)

```go
package flags

import (
	"context"
	"testing"
	"time"
)

func TestClient_IsEnabled_KillSwitch(t *testing.T) {
	client := NewFlagClient()
	client.rules["TEST_FEATURE"] = FlagRule{Enabled: false, PercentageOn: 100}

	// Sekalipun Rollout 100%, jika Enabled=false (Kill Switch off), harus kembalikan false.
	if client.IsEnabled("TEST_FEATURE", "user123") {
		t.Fatal("Expected false due to Kill Switch")
	}
}

func TestClient_IsEnabled_DeterministicFractional(t *testing.T) {
	client := NewFlagClient()
	// Rollout 30% dari populasi.
	client.rules["NEW_CART"] = FlagRule{Enabled: true, PercentageOn: 30}

	// Test user "alice" yang setelah di-hash dengan "NEW_CART" dan dimodulus 100
	// Nilainya adalah sebuah konstanta. (Misal: 14)
	isAliceEnabled := client.IsEnabled("NEW_CART", "alice")

	// Panggil 10x, hasilnya HARUS konsisten (tidak goyah/flapping)
	for i := 0; i < 10; i++ {
		result := client.IsEnabled("NEW_CART", "alice")
		if result != isAliceEnabled {
			t.Fatalf("Flapping detected for user 'alice'. Run %d yielded %v, expected %v", i, result, isAliceEnabled)
		}
	}
	
	// Test populasi besar untuk mendemonstrasikan penyebaran % (bucket distribusi)
	enabledCount := 0
	for i := 0; i < 1000; i++ {
		// Menggunakan identifier yang bervariasi
		userID := string(rune(i)) + "user" 
		if client.IsEnabled("NEW_CART", userID) {
			enabledCount++
		}
	}

	// Karena hash bersifat semu-acak merata, kita berekspektasi sekitar 30% dari 1000 = 300
	// Toleransi error 10% (antara 250 - 350)
	if enabledCount < 250 || enabledCount > 350 {
		t.Fatalf("Distribution failed. Expected ~300 users enabled, got %d", enabledCount)
	}
}

// Mock interface fetcher dengan dukungan concurrency
type mockFetcher struct {
	mu    sync.Mutex
	rules map[string]FlagRule
}

func (m *mockFetcher) Fetch(ctx context.Context) map[string]FlagRule {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rules
}

func (m *mockFetcher) SetRules(newRules map[string]FlagRule) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rules = newRules
}

func TestClient_StartPolling_And_Update(t *testing.T) {
	client := NewFlagClient()
	
	fetcher := &mockFetcher{
		rules: map[string]FlagRule{
			"DYNAMIC_FLAG": {Enabled: true, PercentageOn: 100},
		},
	}

	// Jangan block, gunakan goroutine karena ini loop tiada henti
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // Penting untuk mencegah goroutine leak di test!

	go client.StartPolling(ctx, fetcher)

	// Biarkan poller memproses iterasi pertamanya (menggunakan retry mechanism yang lebih aman daripada static sleep)
	assertEventually(t, func() bool {
		return client.IsEnabled("DYNAMIC_FLAG", "user123")
	}, 1*time.Second, "Expected DYNAMIC_FLAG to be enabled after polling update")
}

// Helper untuk retry check di unit test menghindari flaky-test akibat goroutine race
func assertEventually(t *testing.T, condition func() bool, timeout time.Duration, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

func TestClient_MissingFlag_Fallback(t *testing.T) {
	client := NewFlagClient()
	// Flag "GHOST_FEATURE" tidak pernah di-set di cache/rules
	
	// Harus selalu fallback ke false (Safe Default)
	if client.IsEnabled("GHOST_FEATURE", "user999") {
		t.Fatal("Missing flags must fallback to FALSE to prevent unintended feature leaks")
	}
}

func TestClient_ConcurrentReadWrite(t *testing.T) {
	// Memastikan tidak ada panic: concurrent map read and map write
	client := NewFlagClient()
	client.rules["RACE_FLAG"] = FlagRule{Enabled: true, PercentageOn: 50}

	var wg sync.WaitGroup
	
	// 50 goroutines membaca secara intensif
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				client.IsEnabled("RACE_FLAG", string(rune(idx)))
			}
		}(i)
	}

	// 1 goroutine menulis/update map konstan (simulasi fetcher background poller)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for j := 0; j < 100; j++ {
			client.mu.Lock()
			client.rules = map[string]FlagRule{
				"RACE_FLAG": {Enabled: true, PercentageOn: j % 100},
			}
			client.mu.Unlock()
			time.Sleep(1 * time.Millisecond)
		}
	}()

	wg.Wait()
	// Jika berhasil mencapai titik ini tanpa panic (atau `go test -race` lulus),
	// artinya concurrency in-memory cache di-handle dengan baik oleh RWMutex.
}
```
