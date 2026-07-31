# Health Check: Liveness & Readiness Probe di Go

Kubernetes mendelegasikan tanggung jawab kepada aplikasi untuk melaporkan status kesehatannya. Kesalahpahaman antara Liveness dan Readiness adalah penyebab utama cascading failure di production: memasukkan DB check ke Liveness menyebabkan seluruh fleet pod di-restart saat database spike.

---

## 1. Arsitektur: Tiga Jenis Probe

```
Container Lifecycle & Probe Decision Tree:
                                                          
  [ Container Start ]                                     
         │                                                
         ▼                                                
  [ Startup Probe ] ─────────── gagal ──────────► KILL + RESTART
  (initialDelaySeconds: 10, failureThreshold: 30)        
         │ sukses                                         
         ▼                                                
  ┌─────────────────────────────────────────────────────┐
  │                   RUNNING                           │
  │                                                     │
  │  [ Liveness  /livez  ] ─ gagal ──► KILL + RESTART  │
  │  (only checks: goroutine not deadlocked)            │
  │                                                     │
  │  [ Readiness /readyz ] ─ gagal ──► REMOVE from LB  │
  │  (checks: DB, Redis, dependencies)    (pod alive)  │
  └─────────────────────────────────────────────────────┘
                                                          
Cascading Failure Pattern (JANGAN lakukan ini):          
  DB Spike → DB Ping timeout → Liveness FAIL             
  → K8s restart 100% pods → semua pod disconnect dari DB 
  → DB makin overload → semua pod terus restart          
  → Production DOWN 100%                                 
```

**Aturan emas:**
- **Liveness** — hanya cek hal internal: goroutine not deadlocked, HTTP event loop responsive
- **Readiness** — cek dependency kritis: DB pingable, Redis reachable, config loaded
- **Gunakan port terpisah** (9090) untuk probe — hindari goroutine starvation dari API port

---

## 2. Kode Go Production-Ready

```go
package healthz

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// CheckResult merepresentasikan hasil satu health check.
type CheckResult struct {
	Status  string `json:"status"`           // "UP" atau "DOWN"
	Message string `json:"message,omitempty"` // detail error jika DOWN
}

// HealthResponse adalah response JSON standar.
type HealthResponse struct {
	Status    string                 `json:"status"`    // "UP", "DOWN", "DEGRADED"
	Timestamp time.Time              `json:"timestamp"`
	Checks    map[string]CheckResult `json:"checks"`
}

// HealthChecker mengatur semua health check dengan lifecycle management.
type HealthChecker struct {
	db             *sql.DB
	isShuttingDown atomic.Bool
	dbCheckTimeout time.Duration
}

// NewHealthChecker membuat HealthChecker baru.
func NewHealthChecker(db *sql.DB) *HealthChecker {
	return &HealthChecker{
		db:             db,
		dbCheckTimeout: 2 * time.Second, // ketat — jangan biarkan probe block lama
	}
}

// MarkShuttingDown dipanggil saat SIGTERM diterima — readiness segera 503.
func (h *HealthChecker) MarkShuttingDown() {
	h.isShuttingDown.Store(true)
}

// LivenessHandler — HANYA cek goroutine tidak deadlock.
// JANGAN pernah cek DB/Redis di sini.
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
	if h.isShuttingDown.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("shutting down"))
		return
	}
	// Jika HTTP event loop mencapai sini → server tidak deadlock
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// ReadinessHandler — cek dependency kritis.
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
	// Segera return 503 saat shutdown — hapus pod dari LB traffic
	if h.isShuttingDown.Load() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(HealthResponse{
			Status:    "DOWN",
			Timestamp: time.Now(),
			Checks:    map[string]CheckResult{"shutdown": {Status: "DOWN", Message: "graceful shutdown in progress"}},
		})
		return
	}

	checks := make(map[string]CheckResult)
	allUp := true

	// Check database dengan timeout ketat
	if h.db != nil {
		dbCtx, dbCancel := context.WithTimeout(r.Context(), h.dbCheckTimeout)
		defer dbCancel()

		if err := h.db.PingContext(dbCtx); err != nil {
			checks["database"] = CheckResult{Status: "DOWN", Message: err.Error()}
			allUp = false
		} else {
			checks["database"] = CheckResult{Status: "UP"}
		}
	}

	resp := HealthResponse{
		Status:    "UP",
		Timestamp: time.Now(),
		Checks:    checks,
	}

	w.Header().Set("Content-Type", "application/json")
	if !allUp {
		resp.Status = "DOWN"
		w.WriteHeader(http.StatusServiceUnavailable) // 503
	} else {
		w.WriteHeader(http.StatusOK) // 200
	}
	json.NewEncoder(w).Encode(resp)
}

// RegisterProbeHandlers mendaftarkan handler di mux terpisah (port 9090).
// Wajib di-register di port BERBEDA dari API publik.
func (h *HealthChecker) RegisterProbeHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/livez", h.LivenessHandler)
	mux.HandleFunc("/readyz", h.ReadinessHandler)
}

// --- Unit Tests ---

func TestLivenessHandler_Healthy(t *testing.T) {
	hc := NewHealthChecker(nil)
	req := httptest.NewRequest(http.MethodGet, "/livez", nil)
	rec := httptest.NewRecorder()

	hc.LivenessHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("liveness healthy: got %d, want 200", rec.Code)
	}
}

func TestLivenessHandler_ShuttingDown(t *testing.T) {
	hc := NewHealthChecker(nil)
	hc.MarkShuttingDown()

	req := httptest.NewRequest(http.MethodGet, "/livez", nil)
	rec := httptest.NewRecorder()
	hc.LivenessHandler(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("liveness shutting down: got %d, want 503", rec.Code)
	}
}

func TestReadinessHandler_NoDB(t *testing.T) {
	// Readiness tanpa DB dependency harus return 200
	hc := NewHealthChecker(nil)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	hc.ReadinessHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("readiness no-db: got %d, want 200", rec.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "UP" {
		t.Errorf("status = %q, want UP", resp.Status)
	}
}

func TestReadinessHandler_ShutdownReturns503(t *testing.T) {
	hc := NewHealthChecker(nil)
	hc.MarkShuttingDown()

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("readiness shutdown: got %d, want 503", rec.Code)
	}

	var resp HealthResponse
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Status != "DOWN" {
		t.Errorf("status = %q, want DOWN", resp.Status)
	}
}

func TestReadinessHandler_ContentType(t *testing.T) {
	hc := NewHealthChecker(nil)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, req)

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Database Check di Liveness Probe

```go
// BAD: DB Down → Liveness FAIL → K8s restart ALL pods → cascading failure
func LivenessHandler(w http.ResponseWriter, r *http.Request) {
    if err := db.Ping(); err != nil {
        w.WriteHeader(503) // K8s akan KILL dan RESTART pod ini!
    }
}

// GOOD: DB check hanya di Readiness — pod di-cabut dari LB, tapi tetap hidup
func ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        w.WriteHeader(503) // pod ditarik dari traffic, TIDAK direstart
    }
}
```

**Kenapa berbahaya:** DB spike 30 detik → semua Liveness probe timeout → K8s restart 100% pods → semua koneksi DB disconnected sekaligus → DB makin spike → restart loop tak berujung → production down total. Skenario ini terjadi di Amazon, Slack, dan banyak perusahaan besar.

### ❌ Anti-Pattern 2: Probe di Port API Publik (Goroutine Starvation)

```go
// BAD: Probe di port yang sama dengan API publik
apiMux.HandleFunc("/livez", livenessHandler)
apiMux.HandleFunc("/readyz", readinessHandler)
// DDoS atau traffic spike ke port 443 menghabiskan goroutine pool
// → Kubernetes tidak bisa konek ke /livez → pod dianggap mati → restart paksa

// GOOD: Port terpisah untuk probe — tidak terpengaruh API traffic
go func() {
    probeMux := http.NewServeMux()
    hc.RegisterProbeHandlers(probeMux)
    http.ListenAndServe(":9090", probeMux) // port internal, tidak expose ke internet
}()
http.ListenAndServe(":8080", apiMux) // API publik
```

**Kenapa berbahaya:** HTTP server menggunakan goroutine per-connection. Saat traffic tinggi, goroutine pool habis. Kubernetes tidak bisa connect ke `/livez` karena semua goroutine sibuk — pod dianggap tidak healthy dan di-restart, padahal sebenarnya sehat tapi sedang sibuk melayani request valid.

### ❌ Anti-Pattern 3: Tidak Ada Timeout di Readiness DB Ping

```go
// BAD: DB Ping tanpa timeout — bisa block sampai detik/menit
func ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    if err := db.Ping(); err != nil { // bisa block 30 detik!
        w.WriteHeader(503)
    }
}
// Kubernetes timeoutSeconds default: 1 detik
// → Readiness probe timeout sebelum Ping() selesai
// → Pod terus di-remove dari LB padahal DB sebenarnya OK

// GOOD: Timeout ketat, lebih kecil dari probe timeoutSeconds
func ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        w.WriteHeader(503)
    }
}
```

**Kenapa berbahaya:** Default `timeoutSeconds` K8s probe adalah 1 detik. Jika DB Ping membutuhkan 2 detik, probe selalu timeout — pod selalu dianggap NOT READY meski DB berfungsi normal. Seluruh deployment tidak pernah bisa siap menerima traffic.

---

## 4. Edge Cases & Defensive Programming

1. **Readiness Caching untuk Mengurangi DB Load:** Jika 50 pods masing-masing melakukan `db.Ping()` setiap 5 detik, itu 10 ping/detik konstan ke database — beban yang tidak perlu. Solusi: cache hasil DB check selama 3 detik menggunakan `sync/atomic` timestamp. Hanya jalankan ping nyata jika cache expired.

2. **Startup Probe untuk Aplikasi Berat:** Aplikasi yang butuh warmup (pre-load cache, warm JIT, migrate DB) bisa memakan 60+ detik. Tanpa Startup Probe, Liveness probe akan timeout dan membunuh pod sebelum siap. Startup Probe menggunakan `failureThreshold` tinggi (misal 30 × 10s = 5 menit) untuk memberi waktu startup, lalu menyerahkan kontrol ke Liveness/Readiness.

3. **Thread-Safety di Health State:** `isShuttingDown` dan status dependency harus menggunakan `atomic.Bool` atau `sync/atomic`, bukan regular boolean. Probe handler dipanggil dari goroutine berbeda dengan goroutine signal handler — data race tanpa atomic menyebabkan undefined behavior.

4. **Partial Dependency Degradation:** Tidak semua dependency sama kritisnya. Jika Redis cache down tapi DB masih UP, apakah Readiness harus return 503? Lebih baik return 200 dengan `status: "DEGRADED"` dan `checks.redis: "DOWN"` — pod masih bisa melayani request (dengan sedikit degradasi performa). Reserve 503 hanya untuk dependency yang benar-benar kritikal (primary DB).

5. **Kubernetes Probe Timing Configuration:**
   ```yaml
   livenessProbe:
     httpGet: { path: /livez, port: 9090 }
     initialDelaySeconds: 10  # tunggu app start
     periodSeconds: 10        # check interval
     timeoutSeconds: 2        # beri waktu untuk respond
     failureThreshold: 3      # 3 failures berturut = restart
   readinessProbe:
     httpGet: { path: /readyz, port: 9090 }
     initialDelaySeconds: 5
     periodSeconds: 5
     timeoutSeconds: 3        # sedikit lebih lama (ada DB ping)
     failureThreshold: 2
   ```
   Pastikan `timeoutSeconds` probe selalu > timeout internal Go handler (misal probe timeout 3s, Go context timeout 2s = 1s buffer).
