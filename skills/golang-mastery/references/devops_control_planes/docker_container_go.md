# Docker Container Standards untuk Go Service (Startup Grade)

> **Berlaku:** Go 1.21+ · Docker / OCI · distroless · **Lihat juga:** `runtime_internals/build_system_linker.md` · `system_programming_linux/cgroups_v2_namespaces.md` · `cli_tooling/binary_distribution_release.md` · `observability_resilience/health_check_readiness.md`

## 1. Konsep Utama & Internals

Docker container untuk Go service di startup besar (Tokopedia, Shopee, Gojek) mengikuti prinsip **minimal, secure, reproducible**. Go sangat ideal untuk containerisasi karena menghasilkan single static binary tanpa runtime dependency — berbeda dengan JVM atau Python yang butuh runtime tebal.

### Mengapa Multi-Stage Build Wajib

```
Single-stage (ANTI-PATTERN):         Multi-stage (PRODUCTION):

golang:1.23 image (~800MB)           Builder stage: golang:1.23-alpine
├── Source code                      └── Compile → binary
├── Go toolchain (gc, asm, link)
├── Build cache                      Runtime stage: distroless (~20MB)
├── Test files                       └── Binary only
└── Binary                           └── CA certs only
                                     └── Timezone data only

Final image: ~800MB                  Final image: ~15-25MB
Attack surface: HUGE                 Attack surface: MINIMAL
```

### Layer Caching Strategy

Docker build layer caching bekerja top-down — layer yang tidak berubah di-reuse dari cache. Urutan `COPY` sangat kritis untuk build speed di CI/CD:

```
WRONG order (cache miss setiap code change):
  COPY . .          ← source code berubah → semua layer bawah invalid
  RUN go mod download

CORRECT order (cache hit untuk dependencies):
  COPY go.mod go.sum ./     ← jarang berubah → cached
  RUN go mod download       ← cached selama go.mod tidak berubah
  COPY . .                  ← source berubah, tapi dependency sudah cached
  RUN go build              ← hanya compile ulang
```

### Runtime Image Options

| Base Image | Size | Use Case | Trade-off |
|---|---|---|---|
| `scratch` | ~0MB | CGO disabled, pure Go | Tidak ada shell/debug tools |
| `gcr.io/distroless/static-debian12` | ~2MB | CGO disabled | Ada CA certs + timezone |
| `gcr.io/distroless/cc-debian12` | ~20MB | CGO enabled (SQLite, etc.) | Ada glibc |
| `alpine:3.20` | ~7MB | Butuh shell/tools | Ada ash shell, apk |

**Pilihan Tokopedia/Shopee standard:** `distroless/static` untuk pure Go, `distroless/cc` jika ada CGO dependency.

## 2. Diagram Arsitektur

```
CI/CD Pipeline — Docker Build & Deploy Flow

  Developer Push
       │
       ▼
  ┌─────────────────────────────────────────────────┐
  │  GitHub Actions / GitLab CI                     │
  │                                                  │
  │  1. docker buildx build --platform linux/amd64,arm64 \
  │       --cache-from type=registry,ref=<image>:cache \
  │       --cache-to   type=registry,ref=<image>:cache \
  │       --push -t <registry>/<image>:<sha>         │
  │                                                  │
  │  2. trivy image --exit-code 1 <image>:<sha>      │
  │     (CVE scan — gagal jika ada CRITICAL vuln)    │
  │                                                  │
  │  3. docker scout cves <image>:<sha>              │
  └──────────────────────┬──────────────────────────┘
                          │ push ke registry
                          ▼
  ┌────────────────────────────────────┐
  │  Container Registry                │
  │  (GCR / ECR / Harbor)              │
  │  Tags: :latest, :<sha>, :<semver>  │
  └──────────────┬─────────────────────┘
                 │ K8s imagePullPolicy: Always
                 ▼
  ┌──────────────────────────────────────────────┐
  │  Kubernetes Pod                              │
  │                                              │
  │  initContainer: db-migrate                   │
  │       │ (golang-migrate / atlas)             │
  │       │ WAJIB selesai sebelum app start      │
  │       ▼                                      │
  │  container: app                              │
  │  ├── livenessProbe:  GET /health             │
  │  ├── readinessProbe: GET /ready              │
  │  ├── startupProbe:   GET /health (initial)   │
  │  ├── resources.limits.memory: 256Mi          │
  │  ├── resources.limits.cpu: 500m              │
  │  ├── securityContext.runAsNonRoot: true      │
  │  └── securityContext.readOnlyRootFilesystem  │
  └──────────────────────────────────────────────┘
```

## 3. Production-Ready Code & Config

### Dockerfile — Go Service (Startup Standard)

```dockerfile
# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────
# Stage 1: Builder
# ─────────────────────────────────────────────────
# --platform=$BUILDPLATFORM: builder berjalan NATIF di arsitektur mesin build,
# lalu cross-compile ke target. Tanpa ini, buildx menjalankan tahap builder
# lewat emulasi QEMU untuk setiap platform target -- kompilasi Go bisa 5-10x
# lebih lambat, tanpa manfaat apa pun karena Go memang bisa cross-compile.
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

# Install build dependencies (hanya di builder stage)
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

# CRITICAL: copy go.mod & go.sum DULU untuk layer cache
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source code setelah dependency di-cache
COPY . .

# Build flags untuk production:
# - CGO_ENABLED=0: static binary, tidak butuh glibc di runtime
# - -trimpath: hapus local path dari binary (security + reproducibility)
# - -ldflags: strip debug symbols (ukuran lebih kecil), inject build info
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown

# TARGETOS/TARGETARCH DIISI OTOMATIS OLEH BUILDKIT dari --platform.
#
# `GOARCH=amd64` yang dipatok mati -- bentuk yang paling sering tersalin --
# membatalkan seluruh guna `docker buildx --platform linux/amd64,linux/arm64`
# yang diperintahkan Edge Case 4 di bawah: manifest arm64-nya akan berisi
# BINARY AMD64, dan pod di node Graviton mati dengan `exec format error`.
# Gejalanya baru muncul di node ARM, jadi lolos di seluruh CI berbasis x86.
ARG TARGETOS
ARG TARGETARCH

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -trimpath \
    -ldflags="-s -w \
      -X main.Version=${VERSION} \
      -X main.Commit=${COMMIT} \
      -X main.BuildTime=${BUILD_TIME}" \
    -o /build/app \
    ./cmd/server

# CATATAN: TIDAK ADA `RUN /build/app --version || true` di sini.
#
# Tiga alasan, dan ketiganya menggigit di CI:
#   1. `|| true` membuat langkah "verifikasi" TIDAK PERNAH BISA GAGAL.
#      Ia memverifikasi nol hal.
#   2. Bila binernya tidak mengenali --version, ia menjalankan apa yang memang
#      dilakukannya: ListenAndServe. `|| true` hanya menangkap exit code
#      bukan-nol; ia TIDAK menangkap proses yang menggantung. Build-nya
#      berhenti di situ sampai timeout CI.
#   3. Saat cross-compile (baris di atas), binernya memang tidak bisa
#      dieksekusi oleh builder sama sekali.
#
# Verifikasi yang benar tidak menjalankan biner: periksa arsitekturnya.
RUN go tool nm /build/app > /dev/null && \
    echo "binary OK: $(ls -lh /build/app | awk '{print $5}')"

# ─────────────────────────────────────────────────
# Stage 2: Runtime (distroless — ~20MB final image)
# ─────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

# Copy CA certificates untuk HTTPS calls (dari builder alpine)
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy timezone data untuk time.LoadLocation() yang benar
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy binary saja — tidak ada source code, tidak ada build tools
COPY --from=builder /build/app /app

# distroless:nonroot sudah set USER 65532:65532 secara default
# Tidak perlu USER directive tambahan

EXPOSE 8080

# WAJIB exec form (array), BUKAN shell form ("CMD /app")
# Shell form: SIGTERM dikirim ke sh, bukan ke /app → graceful shutdown GAGAL
ENTRYPOINT ["/app"]
```

### .dockerignore — Wajib Ada

```dockerignore
# Version control
.git
.gitignore

# Test & development files (tidak perlu di image)
*_test.go
testdata/
tests/
mocks/

# Documentation
docs/
*.md
# CATATAN: `!go.mod` dan `!go.sum` sering ditambahkan di sini "untuk berjaga".
# Keduanya TIDAK diperlukan: pola `*.md` mencocokkan nama yang berakhiran
# `.md`, sedangkan `go.mod` berakhiran `.mod`. Pengecualian yang tidak
# mengecualikan apa pun justru menyesatkan pembaca berikutnya bahwa ada
# tabrakan pola di sini.

# Build artifacts lokal (jangan COPY ke container)
bin/
dist/
*.exe
*.dll

# IDE & OS files
.vscode/
.idea/
.DS_Store
*.swp

# CI/CD files (tidak butuh di dalam container)
.github/
.gitlab-ci.yml
Makefile
docker-compose*.yml

# Secrets (DILARANG masuk image)
*.env
.env*
secrets/
```

**`vendor/` sengaja TIDAK ada di daftar ini** — dan Anti-Pattern 3 di bawah yang menyarankan mengecualikannya perlu diluruskan. Sejak Go 1.14, kehadiran `vendor/` yang konsisten dengan `go.mod` membuat `go build` otomatis memakai `-mod=vendor`. Konsekuensinya:

- **Proyek yang memakai vendoring:** mengecualikan `vendor/` membuat build di dalam container diam-diam beralih ke unduhan modul dari jaringan — menghilangkan justru sifat yang membuat orang memilih vendoring (build hermetik, tanpa jaringan, tanpa bergantung pada proxy yang masih hidup). Jangan kecualikan.
- **Proyek yang tidak memakai vendoring:** direktori itu memang tidak ada, jadi entri `.dockerignore`-nya tidak melakukan apa pun.

Tidak ada kasus di mana mengecualikannya membantu. Yang benar-benar layak dikhawatirkan dari ukuran build context adalah `.git/`, `bin/`, dan `dist/` — ketiganya sudah ada di daftar.

### docker-compose.yml — Development & Staging

```yaml
# TIDAK ADA `version:` di sini. Kunci itu OBSOLETE pada Compose V2 dan hanya
# menghasilkan peringatan "the attribute `version` is obsolete, it will be
# ignored". Compose Spec menentukan versinya dari isi berkas.

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VERSION: "${APP_VERSION:-dev}"
        COMMIT: "${COMMIT_SHA:-local}"
    image: myapp:${TAG:-latest}
    ports:
      - "8080:8080"
    environment:
      - APP_ENV=staging
      - DB_DSN=${DB_DSN}       # Dari .env file atau CI secret
      - REDIS_URL=${REDIS_URL}
    # WAJIB: resource limits agar tidak OOM kill container lain
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
        reservations:
          memory: 64M
          cpus: "0.1"
    # HEALTHCHECK PADA IMAGE DISTROLESS TIDAK BOLEH MEMANGGIL wget/curl/sh.
    #
    # `test: ["CMD", "wget", ...]` -- bentuk yang paling sering tersalin --
    # DIJAMIN GAGAL di sini: image runtime-nya distroless/static, yang memang
    # tidak punya shell, wget, maupun curl (lihat tabel base image di bagian 1
    # berkas ini). Akibatnya container selamanya berstatus `unhealthy`, dan
    # setiap service yang memakai `depends_on.condition: service_healthy`
    # terhadapnya tidak akan pernah start.
    #
    # Solusinya: BINER ITU SENDIRI yang jadi health checker. Tambahkan flag
    # `-healthcheck` di main() yang melakukan GET ke localhost lalu exit 0/1.
    # Nol dependensi baru, dan tetap bekerja di scratch.
    healthcheck:
      test: ["CMD", "/app", "-healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s  # Grace period saat startup
    depends_on:
      postgres:
        condition: service_healthy  # Tunggu DB benar-benar ready
      redis:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d myapp"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 512M

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 128M

volumes:
  postgres_data:
```

### Go Service — Graceful Shutdown (SIGTERM Handler)

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

// jedaPropagasi memberi kube-proxy / ingress controller waktu untuk mencabut
// Pod ini dari daftar endpoint SEBELUM server berhenti menerima koneksi.
// Lihat komentar panjang di main().
const propagationDelay = 5 * time.Second

// App menyatukan state kesiapan agar bisa dibaca handler DAN diubah oleh
// penangan sinyal.
type App struct {
	ready atomic.Bool
}

// Router membangun SATU mux yang benar-benar dilayani server.
//
// Ini bagian yang paling mudah salah dan paling mahal: `http.HandleFunc(...)`
// mendaftar ke http.DefaultServeMux, sementara server dijalankan dengan
// `Handler: buildRouter()`. Keduanya mux yang BERBEDA. Akibatnya /health dan
// /ready mengembalikan 404, livenessProbe gagal terus, dan Pod masuk
// CrashLoopBackOff -- sementara aplikasinya sendiri sehat sempurna.
//
// Gejalanya menyesatkan: log aplikasi bersih, tidak ada panic, tidak ada
// galat. Yang terlihat hanya Pod yang restart berulang.
func (a *App) Router() http.Handler {
	mux := http.NewServeMux()

	// LIVENESS: "apakah proses ini masih waras?" JANGAN periksa dependensi
	// di sini. Liveness yang memeriksa database berarti database yang lambat
	// membuat K8s me-restart SELURUH pod aplikasi Anda -- menambah beban ke
	// database yang sudah kesulitan. Itu cara memperpanjang insiden.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, `{"status":"ok"}`)
	})

	// READINESS: "apakah saya siap MENERIMA trafik?" Di sinilah dependensi
	// diperiksa, dan di sinilah shutdown mulai bekerja.
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		if !a.ready.Load() {
			writeJSON(w, http.StatusServiceUnavailable, `{"status":"shutting_down"}`)
			return
		}
		if err := checkDependencies(r.Context()); err != nil {
			slog.WarnContext(r.Context(), "readiness check failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, `{"status":"not_ready"}`)
			return
		}
		writeJSON(w, http.StatusOK, `{"status":"ready"}`)
	})

	mux.Handle("/", businessRoute())
	return mux
}

func writeJSON(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	// Galat Write di sini berarti klien sudah memutus koneksi -- tidak ada
	// yang bisa dilakukan, dan tidak layak jadi log. Dibuang SECARA SADAR.
	_, _ = w.Write([]byte(body))
}

func main() {
	app := &App{}
	app.ready.Store(true)

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           app.Router(),
		ReadHeaderTimeout: 10 * time.Second, // tanpa ini, Slowloris menahan koneksi tanpa batas
	}

	// SIGTERM: dikirim K8s saat pod dihentikan. SIGINT: Ctrl+C saat dev.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	serverError := make(chan error, 1)
	go func() {
		slog.Info("server started", "addr", srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			// Dikirim ke channel, BUKAN os.Exit(1) dari dalam goroutine.
			// os.Exit melewati SELURUH defer dan mematikan proses di tengah --
			// termasuk melewatkan penutupan pool DB dan flush log.
			serverError <- err
		}
	}()

	select {
	case err := <-serverError:
		slog.Error("server failed to start", "error", err)
		os.Exit(1)
	case sig := <-quit:
		slog.Info("shutdown signal received", "signal", sig)
	}

	// ─────────────────────────────────────────────────────────────
	// LANGKAH 1: NYATAKAN TIDAK SIAP, LALU TUNGGU.
	//
	// Ini langkah yang paling sering hilang, dan ketiadaannya membuat
	// "graceful shutdown" tetap memutus permintaan pengguna.
	//
	// Saat SIGTERM tiba, Pod ini MASIH TERDAFTAR sebagai endpoint Service.
	// Penghapusannya bersifat asinkron: kube-apiserver -> EndpointSlice ->
	// setiap kube-proxy di setiap node -> aturan iptables/IPVS. Rantai itu
	// makan ratusan milidetik sampai beberapa detik pada klaster besar, dan
	// ingress controller punya cache-nya sendiri lagi.
	//
	// Bila kita langsung memanggil Shutdown, selama jendela itu kube-proxy
	// MASIH mengarahkan koneksi BARU ke sini -- dan menemukan listener yang
	// sudah tutup. Pengguna menerima connection refused / 502. Requests yang
	// sudah masuk memang selesai dengan rapi; yang datang di detik-detik itu
	// tidak.
	//
	// Urutan yang benar: not-ready dulu, beri jeda propagasi, BARU Shutdown.
	// ─────────────────────────────────────────────────────────────
	app.ready.Store(false)
	slog.Info("readiness disabled, waiting for endpoint propagation", "delay", propagationDelay)
	time.Sleep(propagationDelay)

	// LANGKAH 2: berhenti menerima koneksi baru, tunggu yang aktif selesai.
	//
	// Anggaran waktu harus MUAT di terminationGracePeriodSeconds (default 30s),
	// SUDAH TERMASUK jedaPropagasi di atas. 5s + 20s = 25s, menyisakan 5s
	// sebagai margin sebelum SIGKILL.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	errShutdown := srv.Shutdown(ctx)
	if errShutdown != nil {
		slog.Error("shutdown timed out, remaining connections dropped", "error", errShutdown)
	}

	// LANGKAH 3: tutup dependensi -- SELALU, termasuk saat Shutdown gagal.
	//
	// Versi sebelumnya memanggil os.Exit(1) begitu Shutdown gagal, sehingga
	// drain TIDAK PERNAH berjalan justru pada jalur kegagalan: koneksi DB
	// tidak ditutup, transaksi menggantung sampai timeout sisi server, dan
	// pesan yang belum di-ack tidak dikembalikan ke antrean.
	drainDependencies()

	if errShutdown != nil {
		os.Exit(1)
	}
	slog.Info("server berhenti dengan rapi")
}

func businessRoute() http.Handler { return http.NewServeMux() }

func drainDependencies() {
	// db.Close(), redisClient.Close(), natsConn.Drain(), dst.
}

func checkDependencies(ctx context.Context) error {
	// db.PingContext(ctx), redisClient.Ping(ctx).Err(), dst.
	return nil
}
```

### Unit Test — Verify Graceful Shutdown Behavior

> **Ketiga uji versi sebelumnya tidak menyentuh kode aplikasi sama sekali.**
>
> `TestHealthEndpoint` dan `TestReadinessEndpoint_Unhealthy` mendefinisikan
> `http.HandlerFunc` BARU di dalam ujinya, lalu memeriksa bahwa handler itu
> mengembalikan apa yang baru saja ditulis di baris atasnya. Yang teruji adalah
> `httptest`, bukan rute aplikasi.
>
> Itulah sebabnya cacat mux di atas — `/health` terdaftar di
> `http.DefaultServeMux` sementara server melayani mux lain — bisa bertahan
> di berkas yang punya "unit test untuk health endpoint". Uji yang tidak
> memanggil `app.Router()` tidak akan pernah menemukannya.

```go
package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Uji memanggil app.Router() -- ROUTER YANG SAMA yang dipakai server.
// Ini satu-satunya bentuk yang bisa menangkap handler yang terdaftar di mux
// yang salah.
func TestRouter_HealthAndReady(t *testing.T) {
	app := &App{}
	app.ready.Store(true)
	router := app.Router()

	cases := []struct {
		name, path string
		wantCode   int
	}{
		{"liveness selalu ok", "/health", http.StatusOK},
		{"readiness saat siap", "/ready", http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
			if w.Code != c.wantCode {
				t.Errorf("%s = %d, mau %d (body: %s)", c.path, w.Code, c.wantCode, w.Body)
			}
		})
	}
}

// Readiness WAJIB berubah 503 begitu shutdown dimulai -- inilah sinyal yang
// membuat kube-proxy mencabut Pod ini dari daftar endpoint. Liveness TIDAK
// boleh ikut berubah: liveness 503 justru membuat K8s me-restart pod yang
// sedang berusaha berhenti dengan rapi.
func TestRouter_ReadinessDeadOnShutdown_LivenessStaysAlive(t *testing.T) {
	app := &App{}
	app.ready.Store(true)
	router := app.Router()

	app.ready.Store(false) // SIGTERM diterima

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("/ready = %d saat shutdown, mau 503", w.Code)
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Errorf("/health = %d saat shutdown, mau 200; liveness 503 memicu restart paksa", w.Code)
	}
}

// Uji lama `go srv.ListenAndServe()` MEMBUANG galatnya, sehingga Shutdown atas
// server yang tidak pernah menyala tetap mengembalikan nil dan ujinya hijau --
// termasuk bila port sudah terpakai. Di sini listener dibuat lebih dulu dan
// galatnya diperiksa secara sinkron, lalu koneksi in-flight sungguhan
// dibuktikan tetap selesai.
func TestGracefulShutdown_ActiveRequestCompletes(t *testing.T) {
	startHandler := make(chan struct{})
	continueHandler := make(chan struct{})

	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(startHandler)
			<-continueHandler
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("selesai"))
		}),
		ReadHeaderTimeout: time.Second,
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err) // sinkron: kegagalan bind menggagalkan uji
	}
	go func() { _ = srv.Serve(ln) }()

	result := make(chan int, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/lambat")
		if err != nil {
			result <- 0
			return
		}
		defer resp.Body.Close()
		result <- resp.StatusCode
	}()

	<-startHandler // permintaan sudah masuk handler

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()

	// Shutdown TIDAK boleh selesai selama masih ada request aktif.
	select {
	case <-shutdownDone:
		t.Fatal("Shutdown kembali sebelum request aktif selesai")
	case <-time.After(100 * time.Millisecond):
	}

	close(continueHandler)

	if code := <-result; code != http.StatusOK {
		t.Errorf("request in-flight berakhir dengan %d, mau 200", code)
	}
	if err := <-shutdownDone; err != nil {
		t.Errorf("Shutdown: %v", err)
	}
}
```

> **Yang sengaja TIDAK ditulis di sini: uji SIGTERM.**
>
> Versi sebelumnya memuat `TestSIGTERMReceived` yang isinya `_ = syscall.SIGTERM`
> (pernyataan tanpa efek) lalu mengirim ke channel dan membacanya kembali. Ia
> menguji channel Go, bukan penanganan sinyal, dan tidak bisa gagal.
>
> Menguji sinyal sungguhan berarti `syscall.Kill(os.Getpid(), syscall.SIGTERM)`
> — yang **mengirim sinyal ke proses uji itu sendiri**, tidak tersedia di
> Windows, dan mengganggu uji lain di paket yang sama. Cara yang benar adalah
> mengekstrak orkestrasi shutdown menjadi fungsi yang menerima
> `<-chan os.Signal`, lalu menyuntikkan channel palsu di uji. Yang salah adalah
> menuliskan uji yang tidak menguji apa pun demi angka cakupan.

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Shell Form ENTRYPOINT (SIGTERM Tidak Sampai ke App)

```dockerfile
# BAD: Shell form — sh menjadi PID 1, bukan /app
CMD sh -c "/app"
# atau
ENTRYPOINT "/app"

# Saat K8s kirim SIGTERM ke container:
#   PID 1 = sh (tidak forward SIGTERM ke child process)
#   /app tidak pernah menerima SIGTERM
#   K8s tunggu terminationGracePeriodSeconds (30s) lalu SIGKILL
#   → In-flight requests langsung terputus, data corruption risk
```

```dockerfile
# GOOD: Exec form — /app langsung menjadi PID 1
ENTRYPOINT ["/app"]

# Saat K8s kirim SIGTERM:
#   PID 1 = /app → menerima SIGTERM langsung
#   Graceful shutdown berjalan → drain requests → exit 0
#   K8s tidak perlu SIGKILL
```

**Kenapa berbahaya:** Di K8s, `terminationGracePeriodSeconds` adalah waktu antara SIGTERM dan SIGKILL paksa. Dengan shell form, SIGTERM tidak pernah sampai ke aplikasi Go, sehingga graceful shutdown tidak berjalan. Semua request yang sedang diproses langsung terputus — ini fatal untuk payment service atau order processing.

---

### ❌ Anti-Pattern 2: COPY Source Code ke Runtime Stage

```dockerfile
# BAD: Source code ikut masuk ke image production
FROM golang:1.23 AS builder
COPY . .
RUN go build -o /app ./cmd/server

FROM alpine
COPY --from=builder / /    # ← SALAH: copy SEMUA dari builder termasuk source!
# atau
FROM golang:1.23           # ← SALAH: tidak pakai multi-stage sama sekali
COPY . .
RUN go build -o /app ./cmd/server
CMD ["/app"]
```

```dockerfile
# GOOD: Hanya copy binary yang diperlukan
FROM gcr.io/distroless/static-debian12:nonroot AS runtime
COPY --from=builder /build/app /app    # binary saja
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/app"]
```

**Kenapa berbahaya:** Source code di image production adalah risiko keamanan serius. Jika container di-compromise, attacker mendapat akses ke seluruh business logic, credential patterns, internal API structure. Image juga jadi 40-800x lebih besar → lambat pull di K8s pod scheduling.

---

### ❌ Anti-Pattern 3: Tidak Ada `.dockerignore`

```
# BAD: Tanpa .dockerignore, COPY . . menyertakan:
.git/              (history commit dengan potential secrets)
*_test.go          (test code tidak perlu di production)
.env               (credentials! — fatal security breach)
*.md               (docs tidak perlu)
Makefile
```
*(`vendor/` sengaja tidak disebut di sini — lihat catatan pada `.dockerignore` di bagian 3: mengecualikannya justru mematikan build hermetik pada proyek yang memang memakai vendoring.)*

```dockerignore
# GOOD: .dockerignore eksplisit
.git
*_test.go
testdata/
.env*
secrets/
docs/
*.md
!go.mod
!go.sum
Makefile
.github/
```

**Kenapa berbahaya:** Tanpa `.dockerignore`, `COPY . .` mengirim seluruh build context ke Docker daemon — termasuk `.env` yang berisi DB password, API keys, dll. File ini masuk ke image layer dan bisa di-extract dengan `docker history` atau `docker save`. Ini adalah salah satu vektor kebocoran credential paling umum di production.

## 5. Edge Cases & Defensive Programming

1. **Timezone di Container Distroless:** `gcr.io/distroless/static` tidak menyertakan `/usr/share/zoneinfo`. Jika app menggunakan `time.LoadLocation("Asia/Jakarta")`, akan panic `unknown time zone`. Solusi: `COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo` dari alpine builder, atau embed timezone data dengan `time/tzdata` import di Go (`import _ "time/tzdata"`).

2. **CA Certificates untuk HTTPS Calls:** `scratch` dan `distroless/static` tidak menyertakan CA certs. Panggilan ke external HTTPS API (payment gateway, Midtrans, dll.) akan gagal dengan `x509: certificate signed by unknown authority`. Solusi: `COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/` dari alpine builder.

3. **Read-Only Root Filesystem di K8s:** `securityContext.readOnlyRootFilesystem: true` adalah best practice K8s hardening, tapi app yang menulis ke `/tmp` atau menggunakan `os.TempDir()` akan crash. Solusi: mount `emptyDir` untuk direktori yang butuh write: `mountPath: /tmp`. Di Go, gunakan `os.MkdirTemp("", "prefix")` dan cleanup dengan `defer os.RemoveAll(tmpDir)`.

4. **Platform Build (ARM vs AMD64):** Di CI/CD berbasis Apple Silicon (M1/M2 runner) atau saat build untuk K8s node ARM (AWS Graviton), `docker build` default ke platform host. Gunakan `docker buildx build --platform linux/amd64,linux/arm64` untuk multi-arch manifest. Tanpa ini, image yang di-push ke registry bisa tidak bisa dijalankan di node production yang berbeda arsitektur.

5. **`depends_on` Tidak Cukup untuk DB Ready:** `depends_on: postgres` di docker-compose hanya menunggu container *start*, bukan menunggu DB *siap menerima koneksi*. PostgreSQL butuh beberapa detik inisialisasi setelah container up. Solusi: gunakan `depends_on.condition: service_healthy` dengan `healthcheck` yang benar (`pg_isready`), atau implementasikan retry loop dengan exponential backoff di app saat startup connection ke DB.

## Kapan JANGAN Pakai Ini

- **`FROM golang` sebagai image runtime.** Ia membawa seluruh toolchain, kompilator, dan puluhan paket sistem — semuanya menjadi permukaan serangan tanpa satu pun dipakai saat aplikasi berjalan. Multi-stage build ke `distroless` atau `scratch` yang benar.
- **Tag `latest` pada base image.** Build hari ini dan bulan depan menghasilkan isi berbeda. Itu bukan build yang bisa direproduksi, dan saat ada insiden Anda tidak bisa membuktikan apa yang berjalan.
- **`CGO_ENABLED=0` dipasang membabi buta lalu memakai `scratch`.** Beberapa paket beralih ke implementasi Go murni yang **perilakunya berbeda**, dan `scratch` juga tidak punya sertifikat CA maupun basis data zona waktu — TLS dan `time.LoadLocation` akan gagal dengan pesan yang membingungkan.
- **Shell form pada `ENTRYPOINT`.** `ENTRYPOINT ./app` menjalankan aplikasi di bawah `sh`, dan **SIGTERM tidak sampai ke aplikasi**. Graceful shutdown yang sudah Anda tulis tidak akan pernah berjalan, dan setiap deploy berakhir dengan SIGKILL.
- **Berjalan sebagai root.** Bahkan di dalam container, root memperbesar dampak setiap escape dan melanggar hampir semua kebijakan admission yang layak.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pod selalu berakhir dengan exit code 137 | bentuk `ENTRYPOINT` | SIGTERM tidak sampai; shell form menahannya |
| CrashLoopBackOff tapi log aplikasi bersih | probe menembak mux mana | Handler probe terdaftar di mux yang tidak dilayani |
| 502/connection refused saat setiap deploy | apakah readiness dimatikan sebelum Shutdown | Endpoint belum dicabut saat listener sudah tutup |
| `exec format error` hanya di node ARM | `GOARCH` di Dockerfile | Arsitektur dipatok mati, manifest multi-arch berisi biner yang salah |
| `x509: certificate signed by unknown authority` | apakah CA bundle ada di image | `scratch` tanpa `ca-certificates` |
| `time.LoadLocation` gagal di produksi | basis data zona waktu di image | `scratch` tanpa `tzdata` |
| Image besar tanpa alasan | `docker history` | Stage build ikut terbawa |
| Banyak CVE pada image | base image dan tag | Base image tebal atau tidak pernah diperbarui |

```bash
# Lapisan mana yang membuat image besar
docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' registri/api:1.4.2 | head

# Kerentanan pada image yang BENAR-BENAR dirilis
trivy image --severity HIGH,CRITICAL registri/api:1.4.2

# Apakah SIGTERM sampai ke proses utama? PID 1 harus aplikasinya, bukan sh.
kubectl exec <pod> -- ps -ef | head -3
kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'
# 137 = 128+9 SIGKILL, 143 = 128+15 SIGTERM

# Konteks keamanan yang benar-benar berlaku
kubectl get pod <pod> -o jsonpath='{.spec.securityContext}{.spec.containers[0].securityContext}' | jq

# Apakah rute probe BENAR-BENAR terdaftar? 404 di sini = handler di mux yang
# salah, dan Pod akan restart terus dengan log aplikasi yang bersih.
kubectl port-forward <pod> 8080:8080 &
curl -si localhost:8080/health | head -1
curl -si localhost:8080/ready  | head -1

# Arsitektur yang benar-benar ada di dalam manifest multi-arch
docker buildx imagetools inspect registri/api:1.4.2 --format '{{json .Manifest}}' \
  | jq -r '.manifests[]? | "\(.platform.os)/\(.platform.architecture)"'
```
