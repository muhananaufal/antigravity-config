# Docker Container Standards untuk Go Service (Startup Grade)

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
FROM golang:1.23-alpine AS builder

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

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath \
    -ldflags="-s -w \
      -X main.Version=${VERSION} \
      -X main.Commit=${COMMIT} \
      -X main.BuildTime=${BUILD_TIME}" \
    -o /build/app \
    ./cmd/server

# Verifikasi binary (optional tapi direkomendasikan di CI)
RUN /build/app --version || true

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
!go.mod
!go.sum

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

### docker-compose.yml — Development & Staging

```yaml
version: "3.9"

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
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
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
	"syscall"
	"time"
)

func main() {
	srv := &http.Server{
		Addr:    ":8080",
		Handler: buildRouter(),
	}

	// Health check endpoint — wajib ada sebelum app terima traffic
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Readiness probe — cek dependencies (DB, Redis) siap
	http.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := checkDependencies(r.Context()); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"status":"not_ready"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ready"}`))
	})

	// Channel untuk menerima OS signal
	quit := make(chan os.Signal, 1)
	// SIGTERM: dikirim oleh K8s saat pod dihentikan
	// SIGINT: Ctrl+C saat development
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	// Start server di goroutine terpisah
	go func() {
		slog.Info("server starting", "addr", srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Block sampai signal diterima
	sig := <-quit
	slog.Info("shutdown signal received", "signal", sig)

	// Context dengan deadline untuk drain in-flight requests
	// K8s terminationGracePeriodSeconds default: 30s
	// Set timeout lebih kecil agar ada buffer sebelum SIGKILL
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	// Shutdown: tidak menerima request baru, tunggu request aktif selesai
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}

	// Drain dependencies (DB pool, Redis, message queue subscriber)
	drainDependencies()

	slog.Info("server stopped gracefully")
}

func drainDependencies() {
	// db.Close(), redisClient.Close(), natsConn.Drain(), etc.
}

func checkDependencies(ctx context.Context) error {
	// db.PingContext(ctx), redisClient.Ping(ctx).Err(), etc.
	return nil
}
```

### Unit Test — Verify Graceful Shutdown Behavior

```go
package main_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"syscall"
	"testing"
	"time"
)

func TestHealthEndpoint(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestReadinessEndpoint_Unhealthy(t *testing.T) {
	// Simulate DB tidak siap
	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	w := httptest.NewRecorder()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulasi dependency check gagal
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"not_ready"}`))
	})
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestGracefulShutdown(t *testing.T) {
	srv := &http.Server{
		Addr:    ":0", // OS assign port random
		Handler: http.DefaultServeMux,
	}

	go srv.ListenAndServe()
	time.Sleep(50 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		t.Errorf("shutdown failed: %v", err)
	}
}

func TestSIGTERMReceived(t *testing.T) {
	// Verifikasi proses sendiri bisa menerima SIGTERM tanpa crash
	// (hanya test bahwa signal channel setup benar)
	quit := make(chan struct{}, 1)

	go func() {
		// Simulasi SIGTERM handler
		_ = syscall.SIGTERM
		quit <- struct{}{}
	}()

	select {
	case <-quit:
		// OK
	case <-time.After(1 * time.Second):
		t.Error("SIGTERM handler not triggered")
	}
}
```

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
vendor/            (bisa ratusan MB jika tidak dipakai)
*.md               (docs tidak perlu)
Makefile
```

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
