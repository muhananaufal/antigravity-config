# Health Check: Liveness & Readiness Probe di Go

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `observability_resilience/graceful_shutdown_drain.md` · `db_sqlc/connection_pool_tuning.md` · `observability_resilience/circuit_breaker_hystrix.md` · `devops_control_planes/docker_container_go.md`

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
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type Status string

const (
	StatusUP       Status = "UP"
	StatusDEGRADED Status = "DEGRADED"
	StatusDOWN     Status = "DOWN"
)

// Pemeriksaan adalah satu dependensi yang diperiksa readiness.
type Pemeriksaan struct {
	Nama string
	// Kritis=false berarti kegagalannya menghasilkan DEGRADED (tetap 200),
	// bukan 503. Menarik pod dari LB karena cache mati mengubah kegagalan
	// PARSIAL menjadi kegagalan TOTAL — 90% permintaan yang masih bisa
	// dilayani ikut dibuang.
	Kritis  bool
	Periksa func(context.Context) error
}

type HasilPeriksa struct {
	Status Status `json:"status"`
	// Pesan memuat galat mentah. Aman HANYA karena port probe tidak pernah
	// diekspos ke internet (Anti-Pattern 2) — galat koneksi DB kerap memuat
	// host dan nama pengguna.
	Pesan string `json:"pesan,omitempty"`
}

type ResponsKesehatan struct {
	Status Status                  `json:"status"`
	Waktu  time.Time               `json:"waktu"`
	Cek    map[string]HasilPeriksa `json:"cek"`
}

type HealthChecker struct {
	sedangMati atomic.Bool

	pemeriksaan  []Pemeriksaan
	batasPeriksa time.Duration

	mu        sync.RWMutex
	terakhir  ResponsKesehatan
	kodeAkhir int

	denyut      sync.Map // nama komponen → *atomic.Int64 (UnixNano)
	batasDenyut time.Duration
}

func NewHealthChecker(pemeriksaan ...Pemeriksaan) *HealthChecker {
	return &HealthChecker{
		pemeriksaan: pemeriksaan,
		// Lebih kecil dari probe.timeoutSeconds — yang default-nya di
		// Kubernetes adalah 1 DETIK. Lihat Anti-Pattern 3.
		batasPeriksa: 800 * time.Millisecond,
		batasDenyut:  60 * time.Second,
		// FAIL-CLOSED: sebelum pemeriksaan pertama selesai, pod BELUM siap.
		// Bawaan yang sebaliknya membuat pod yang dependensinya belum terpasang
		// sama sekali melapor SIAP dan langsung menerima trafik.
		kodeAkhir: http.StatusServiceUnavailable,
		terakhir:  ResponsKesehatan{Status: StatusDOWN, Cek: map[string]HasilPeriksa{}},
	}
}

// MarkShuttingDown dipanggil saat SIGTERM diterima — readiness segera 503.
func (h *HealthChecker) MarkShuttingDown() { h.sedangMati.Store(true) }

// MulaiPenyegar menjalankan pemeriksaan di LATAR BELAKANG, bukan di jalur probe.
//
// Alasannya bukan sekadar mengurangi beban. `db.PingContext` MENGAMBIL koneksi
// dari pool: saat pool jenuh di puncak trafik, ping mengantre dan readiness
// gagal — padahal database baik-baik saja. Pod ditarik dari LB, bebannya pindah
// ke pod sisanya, pool mereka ikut jenuh, dan seterusnya. Itu kaskade yang
// sama persis dengan Anti-Pattern 1, hanya lewat pintu readiness.
func (h *HealthChecker) MulaiPenyegar(ctx context.Context, tiap time.Duration) {
	go func() {
		t := time.NewTicker(tiap)
		defer t.Stop()
		h.segarkan(ctx) // sekali di awal agar pod tidak lama tertahan di 503
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.segarkan(ctx)
			}
		}
	}()
}

func (h *HealthChecker) segarkan(induk context.Context) {
	cek := make(map[string]HasilPeriksa, len(h.pemeriksaan))
	status := StatusUP
	kode := http.StatusOK

	for _, p := range h.pemeriksaan {
		ctx, batal := context.WithTimeout(induk, h.batasPeriksa)
		err := p.Periksa(ctx)
		batal()

		switch {
		case err == nil:
			cek[p.Nama] = HasilPeriksa{Status: StatusUP}
		case p.Kritis:
			cek[p.Nama] = HasilPeriksa{Status: StatusDOWN, Pesan: err.Error()}
			status, kode = StatusDOWN, http.StatusServiceUnavailable
		default:
			cek[p.Nama] = HasilPeriksa{Status: StatusDOWN, Pesan: err.Error()}
			if status == StatusUP {
				status = StatusDEGRADED // tetap 200
			}
		}
	}

	h.mu.Lock()
	h.terakhir = ResponsKesehatan{Status: status, Waktu: time.Now(), Cek: cek}
	h.kodeAkhir = kode
	h.mu.Unlock()
}

// DaftarkanDenyut dipanggil SEBELUM komponen berjalan, supaya komponen yang
// tidak pernah berdenyut sekali pun tetap terdeteksi.
func (h *HealthChecker) DaftarkanDenyut(komponen string) { h.KetukDenyut(komponen) }

// KetukDenyut dipanggil setiap iterasi oleh goroutine latar (konsumer antrean,
// scheduler).
//
// Inilah yang membuat liveness benar-benar berarti. Handler yang sekadar
// mengembalikan 200 hanya membuktikan goroutine HTTP hidup — ia tidak
// membuktikan apa pun tentang worker yang macet, padahal worker macet adalah
// satu-satunya keadaan yang memang pantas disembuhkan dengan restart.
func (h *HealthChecker) KetukDenyut(komponen string) {
	v, _ := h.denyut.LoadOrStore(komponen, new(atomic.Int64))
	v.(*atomic.Int64).Store(time.Now().UnixNano())
}

func (h *HealthChecker) denyutBasi() (string, bool) {
	var basi string
	h.denyut.Range(func(k, v any) bool {
		umur := time.Since(time.Unix(0, v.(*atomic.Int64).Load()))
		if umur > h.batasDenyut {
			basi = fmt.Sprintf("%v basi %s", k, umur.Round(time.Second))
			return false
		}
		return true
	})
	return basi, basi != ""
}

// LivenessHandler menjawab satu pertanyaan: apakah proses ini masih waras?
//
// Perhatikan apa yang TIDAK ada di sini: pemeriksaan sedangMati. Liveness yang
// gagal membuat Kubernetes MEMBUNUH DAN ME-RESTART container. Selama graceful
// shutdown, itu memotong drain di tengah — persis kebalikan dari yang
// diinginkan. Saat shutdown, hanya READINESS yang boleh berubah jadi 503.
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
	if pesan, basi := h.denyutBasi(); basi {
		slog.Error("liveness gagal: denyut komponen basi", "detail", pesan)
		http.Error(w, "denyut basi: "+pesan, http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}

// ReadinessHandler menyajikan hasil pemeriksaan terakhir. Ia TIDAK memanggil
// dependensi apa pun secara langsung.
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if h.sedangMati.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(ResponsKesehatan{
			Status: StatusDOWN,
			Waktu:  time.Now(),
			Cek:    map[string]HasilPeriksa{"shutdown": {Status: StatusDOWN, Pesan: "graceful shutdown berjalan"}},
		})
		return
	}

	h.mu.RLock()
	resp, kode := h.terakhir, h.kodeAkhir
	h.mu.RUnlock()

	w.WriteHeader(kode)
	_ = json.NewEncoder(w).Encode(resp)
}

// RegisterProbeHandlers mendaftarkan handler di mux terpisah (port 9090).
// Wajib di-register di port BERBEDA dari API publik — lihat Anti-Pattern 2.
func (h *HealthChecker) RegisterProbeHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/livez", h.LivenessHandler)
	mux.HandleFunc("/readyz", h.ReadinessHandler)
}

// PemeriksaanDB membungkus *sql.DB menjadi Pemeriksaan kritis.
func PemeriksaanDB(db *sql.DB) Pemeriksaan {
	return Pemeriksaan{
		Nama:    "database",
		Kritis:  true,
		Periksa: func(ctx context.Context) error { return db.PingContext(ctx) },
	}
}
```

```go
package healthz

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Uji terpenting di berkas ini. Liveness yang gagal saat shutdown membuat
// Kubernetes me-restart container DI TENGAH drain. Versi lama berkas ini
// mengembalikan 503 di sini — dan ujinya mengunci perilaku itu sebagai benar.
func TestLivenessTetap200SaatShutdown(t *testing.T) {
	hc := NewHealthChecker()
	hc.MarkShuttingDown()

	rec := httptest.NewRecorder()
	hc.LivenessHandler(rec, httptest.NewRequest(http.MethodGet, "/livez", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("liveness saat shutdown = %d, mau 200 (503 memicu restart di tengah drain)", rec.Code)
	}
}

func TestLivenessGagalSaatDenyutBasi(t *testing.T) {
	hc := NewHealthChecker()
	hc.batasDenyut = 10 * time.Millisecond
	hc.DaftarkanDenyut("konsumer-antrean")
	time.Sleep(20 * time.Millisecond)

	rec := httptest.NewRecorder()
	hc.LivenessHandler(rec, httptest.NewRequest(http.MethodGet, "/livez", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("liveness dengan denyut basi = %d, mau 503", rec.Code)
	}
}

// Fail-closed. Versi lama mengembalikan 200 sebelum satu dependensi pun
// diperiksa: pod yang DB-nya belum terpasang melapor SIAP dan menerima trafik.
func TestReadinessBelumDiperiksaBerartiTidakSiap(t *testing.T) {
	hc := NewHealthChecker(Pemeriksaan{
		Nama: "db", Kritis: true,
		Periksa: func(context.Context) error { return nil },
	})

	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness sebelum pemeriksaan pertama = %d, mau 503", rec.Code)
	}
}

func TestReadinessDependensiKritisJatuh(t *testing.T) {
	hc := NewHealthChecker(Pemeriksaan{
		Nama: "db", Kritis: true,
		Periksa: func(context.Context) error { return errors.New("koneksi ditolak") },
	})
	hc.segarkan(context.Background())

	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("kode = %d, mau 503", rec.Code)
	}
	var resp ResponsKesehatan
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("dekode: %v", err)
	}
	if resp.Status != StatusDOWN {
		t.Fatalf("status = %q, mau DOWN", resp.Status)
	}
}

// Kegagalan parsial TIDAK boleh diubah menjadi kegagalan total.
func TestReadinessDependensiOpsionalJatuhTetapSiap(t *testing.T) {
	hc := NewHealthChecker(
		Pemeriksaan{Nama: "db", Kritis: true,
			Periksa: func(context.Context) error { return nil }},
		Pemeriksaan{Nama: "cache", Kritis: false,
			Periksa: func(context.Context) error { return errors.New("redis mati") }},
	)
	hc.segarkan(context.Background())

	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("kode = %d, mau 200 — cache mati bukan alasan menarik pod dari LB", rec.Code)
	}
	var resp ResponsKesehatan
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("dekode: %v", err)
	}
	if resp.Status != StatusDEGRADED {
		t.Fatalf("status = %q, mau DEGRADED", resp.Status)
	}
}

func TestReadinessShutdownMengembalikan503(t *testing.T) {
	hc := NewHealthChecker()
	hc.segarkan(context.Background()) // tanpa dependensi → UP/200
	hc.MarkShuttingDown()

	rec := httptest.NewRecorder()
	hc.ReadinessHandler(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("kode = %d, mau 503", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, mau application/json", ct)
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

// GOOD: timeout internal LEBIH KECIL dari probe.timeoutSeconds,
// dan pemeriksaannya dijalankan di latar belakang (lihat §2).
func (h *HealthChecker) segarkan(induk context.Context) {
    ctx, batal := context.WithTimeout(induk, 800*time.Millisecond)
    defer batal()
    // ...
}
```

**Kenapa berbahaya:** default `timeoutSeconds` probe Kubernetes adalah **1 detik**, bukan 3. Bila ping DB butuh 2 detik, probe selalu timeout — pod selamanya NOT READY meski database berfungsi normal, dan deployment tidak pernah bisa menerima trafik.

> Versi lama berkas ini memakai **2 detik** di kode, menyebut **500ms** di sini, dan **3 detik** di Edge Case 5 — tiga angka untuk satu rantai yang sama, sementara `timeoutSeconds` bawaan Kubernetes 1 detik membuat dua di antaranya mustahil berhasil. Setelah readiness disajikan dari cache (§2), rantainya jauh lebih sederhana: `batasPeriksa` membatasi penyegar latar, dan probe hanya membacakan hasil. Angka lengkapnya di Edge Case 5.

### ❌ Anti-Pattern 4: Liveness Ikut Gagal Saat Graceful Shutdown

Ini kesalahan yang paling merusak justru karena terlihat rapi dan konsisten.

```go
// BAD: satu penanda dipakai untuk kedua probe
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    if h.sedangMati.Load() {
        w.WriteHeader(503) // Kubernetes: "container ini mati" → KILL + RESTART
        return
    }
    w.WriteHeader(200)
}
```

Liveness yang gagal **bukan** sinyal "jangan kirim trafik ke sini" — itu tugas readiness. Liveness yang gagal berarti "container ini rusak, bunuh dan hidupkan lagi". Selama drain, kubelet **tetap menjalankan liveness probe**. Setelah `failureThreshold` tercapai, container dibunuh di tengah drain: permintaan yang sedang berjalan putus, pool DB tidak sempat ditutup, dan seluruh urutan di `graceful_shutdown_drain.md` tidak pernah selesai.

Yang membuatnya sulit terlihat: dengan `periodSeconds: 10` dan `failureThreshold: 3`, pembunuhan datang pada detik ke-30 — persis berimpit dengan `terminationGracePeriodSeconds`. Di lingkungan yang santai, drain menang tipis dan semuanya tampak normal. Percepat probe, perlambat drain sedikit, atau tambah beban, dan urutannya berbalik tanpa ada yang berubah di kode.

```go
// GOOD: shutdown HANYA memengaruhi readiness. Liveness tetap 200 selama
// proses masih waras — lihat implementasinya di §2.
```

---

## 4. Edge Cases & Defensive Programming

1. **Readiness WAJIB memakai hasil ter-cache, dan alasannya bukan sekadar beban:** 50 pod yang masing-masing `db.Ping()` tiap 5 detik memang menghasilkan 10 ping/detik yang percuma. Tapi bahaya sesungguhnya lain: **`db.PingContext` mengambil koneksi dari pool**. Saat pool jenuh di puncak trafik, ping mengantre dan readiness gagal — padahal database sehat. Pod ditarik dari LB, bebannya pindah ke pod sisanya, pool mereka ikut jenuh, dan seluruh fleet menandai diri tidak siap secara berurutan. Itu kaskade yang sama dengan Anti-Pattern 1, hanya lewat pintu readiness dan tanpa satu pun restart untuk memberi petunjuk. Karena itu `MulaiPenyegar` di §2 menjalankan pemeriksaan di goroutine latar, dan handler probe hanya membacakan hasil terakhir.

2. **Startup Probe untuk Aplikasi Berat:** Aplikasi yang butuh warmup (pre-load cache, warm JIT, migrate DB) bisa memakan 60+ detik. Tanpa Startup Probe, Liveness probe akan timeout dan membunuh pod sebelum siap. Startup Probe menggunakan `failureThreshold` tinggi (misal 30 × 10s = 5 menit) untuk memberi waktu startup, lalu menyerahkan kontrol ke Liveness/Readiness.

3. **Thread-Safety di Health State:** `isShuttingDown` dan status dependency harus menggunakan `atomic.Bool` atau `sync/atomic`, bukan regular boolean. Probe handler dipanggil dari goroutine berbeda dengan goroutine signal handler — data race tanpa atomic menyebabkan undefined behavior.

4. **Partial Dependency Degradation:** tidak semua dependensi sama kritisnya. Redis cache mati sementara DB sehat **tidak** boleh menghasilkan 503 — lebih baik 200 dengan `status: "DEGRADED"` dan `cek.cache: "DOWN"`. Diimplementasikan lewat field `Kritis` pada `Pemeriksaan` di §2. Sediakan 503 hanya untuk dependensi yang tanpanya layanan benar-benar tidak bisa menjawab apa pun.

5. **Konfigurasi timing probe — dan startup probe yang mengubah aturannya:**
   ```yaml
   startupProbe:
     httpGet: { path: /livez, port: 9090 }
     periodSeconds: 10
     failureThreshold: 30     # 30 x 10 = 5 menit anggaran boot
   livenessProbe:
     httpGet: { path: /livez, port: 9090 }
     periodSeconds: 10
     timeoutSeconds: 2
     failureThreshold: 3
   readinessProbe:
     httpGet: { path: /readyz, port: 9090 }
     periodSeconds: 2
     timeoutSeconds: 1
     failureThreshold: 2      # deteksi ~4 detik
   ```
   Tiga hal yang sering luput:
   - **Selama `startupProbe` belum berhasil, liveness dan readiness TIDAK dijalankan sama sekali.** Karena itu `initialDelaySeconds` pada keduanya menjadi tidak berguna dan sengaja dihapus di atas — memakai keduanya sekaligus hanya menambah kebingungan tanpa menambah perlindungan.
   - **`timeoutSeconds` tidak perlu lagi memberi ruang untuk ping DB.** Karena readiness disajikan dari cache (§2), handler-nya menjawab dalam mikrodetik; `batasPeriksa` 800ms membatasi penyegar di LATAR BELAKANG, bukan probe. Inilah yang membebaskan `timeoutSeconds` menjadi 1 detik, dan itu pada gilirannya yang memungkinkan `periodSeconds` turun ke 2.
   - **`failureThreshold × periodSeconds` harus LEBIH KECIL dari jeda tepi shutdown.** Di sini 2 × 2 = 4 detik, di bawah jeda 5 detik pada `graceful_shutdown_drain.md`. Bila terbalik — misalnya bawaan 3 × 10 = 30 detik — listener sudah ditutup sementara endpoint masih terdaftar, dan seluruh jeda yang dirancang untuk mencegah `502` justru tidak menghasilkan apa-apa.

## Kapan JANGAN Pakai Ini

- **Memeriksa dependensi di liveness probe.** Database yang lambat sesaat akan membuat Kubernetes membunuh **seluruh** pod yang sebenarnya sehat, dan restart massal memperparah keadaan yang sedang buruk. Liveness hanya menjawab satu pertanyaan: apakah proses ini masih waras dan perlu di-restart?
- **Readiness yang memeriksa dependensi opsional.** Bila layanan masih bisa melayani 90% permintaan tanpa Redis, menandai diri tidak siap justru membuang 90% itu — kegagalan parsial diubah menjadi kegagalan total.
- **Probe pada port API publik.** Saat beban puncak, probe ikut mengantre bersama trafik pengguna dan gagal — lalu pod dibunuh persis ketika sedang paling dibutuhkan. Sediakan port terpisah untuk probe.
- **Probe tanpa timeout internalnya sendiri.** Ping database tanpa `context.WithTimeout` bisa menggantung lebih lama daripada `timeoutSeconds` probe, dan hasilnya menjadi tidak menentu.
- **Melewatkan startup probe pada aplikasi yang lambat boot.** Tanpanya, liveness membunuh pod sebelum sempat siap — dan pod tidak akan pernah berhasil start, berapa kali pun dicoba.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `restartCount` naik tanpa crash di log | konfigurasi liveness | Liveness membunuh pod yang sebenarnya sehat |
| Seluruh pod tidak siap bersamaan | dependensi yang diperiksa readiness | Readiness bergantung pada satu dependensi bersama |
| Pod tidak pernah mencapai `Ready` | startup probe | Waktu boot melebihi toleransi probe |
| Probe gagal hanya saat trafik puncak | port yang dipakai probe | Probe antre bersama trafik pengguna |
| Restart beruntun memperparah insiden | apakah liveness memeriksa hilir | Liveness ikut jatuh saat hilir jatuh |
| Pod di-restart saat rollout, bukan berhenti bersih | apakah liveness ikut 503 saat shutdown | Drain dipotong oleh liveness sendiri (Anti-Pattern 4) |
| Seluruh fleet tidak-siap di puncak trafik tanpa restart | apakah readiness memanggil DB di jalur probe | Pool jenuh, bukan database yang mati (Edge Case 1) |

```bash
kubectl describe pod <pod> | grep -A6 -E 'Liveness|Readiness|Startup'

# Peristiwa probe gagal, terbaru di bawah
kubectl get events --field-selector reason=Unhealthy --sort-by=.lastTimestamp | tail -20

# Restart tanpa crash di log = hampir selalu liveness yang salah konfigurasi
kubectl get pods -l app=api \
  -o custom-columns='NAMA:.metadata.name,RESTART:.status.containerStatuses[0].restartCount'

# Waktu respons probe -- harus jauh di bawah timeoutSeconds.
# Port dan path WAJIB sama dengan yang dipakai RegisterProbeHandlers di §2.
curl -sw '\n%{http_code} %{time_total}s\n' -o /dev/null localhost:9090/livez
curl -sw '\n%{http_code} %{time_total}s\n' -o /dev/null localhost:9090/readyz

# Saat rollout: /livez WAJIB tetap 200 sampai proses benar-benar keluar.
# Bila ia berubah 503, drain sedang dipotong oleh liveness sendiri.
kubectl exec <pod> -- sh -c 'while :; do curl -so /dev/null -w "%{http_code} " localhost:9090/livez; sleep 1; done'
```
