# Master-Level CI/CD: Deployment Strategies & Zero-Downtime di Golang Kubernetes

Dokumen referensi ini menguraikan strategi deployment tingkat lanjut untuk aplikasi Golang di Kubernetes (K8s). Strategi yang dibahas dirancang untuk meminimalkan waktu henti (zero-downtime), mengurangi risiko, dan memastikan integritas data melalui mekanisme rollout yang terkendali.

## 1. Rolling Update (K8s Native)

Rolling update adalah strategi deployment bawaan Kubernetes di mana Pod dari versi lama digantikan oleh Pod versi baru secara bertahap. Parameter utama yang mengontrol perilaku ini adalah `maxSurge` (batas maksimal pod yang dibuat melebihi replica set) dan `maxUnavailable` (batas maksimal pod yang mati dari kapasitas yang diharapkan).

### ASCII Traffic Flow: Rolling Update

```text
WAKTU: T0                   WAKTU: T1 (Proses)             WAKTU: T2 (Selesai)
[ Ingress / Service ]       [ Ingress / Service ]          [ Ingress / Service ]
      |                           |   \                            |
      v                           v    v                           v
  [v1] [v1] [v1]              [v1] [v1] [v2]                   [v2] [v2] [v2]
```

### Konfigurasi K8s YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: golang-app
  labels:
    app: golang-app
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
  selector:
    matchLabels:
      app: golang-app
  template:
    metadata:
      labels:
        app: golang-app
    spec:
      containers:
      - name: api-server
        image: registry.internal.io/golang-app:v2.0.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
```

## 2. Blue/Green Deployment

Blue/Green deployment menyediakan zero-downtime dengan mempertahankan dua lingkungan produksi yang identik. "Blue" adalah versi live saat ini, sedangkan "Green" adalah versi baru. Setelah pengujian di Green berhasil, traffic secara instan dialihkan menggunakan pembaruan pemilih layanan (Service Selector Swap).

### ASCII Traffic Flow: Blue/Green

```text
WAKTU: T0 (Deployment)         WAKTU: T1 (Testing Green)      WAKTU: T2 (Switch Traffic)
[ Ingress / Service ]          [ Ingress / Service ]          [ Ingress / Service ]
      |                                |                              |
      v                                v                              v
  +-------+                        +-------+                      +-------+
  | BLUE  |                        | BLUE  |                      | BLUE  | (Idle)
  | (v1)  |                        | (v1)  |                      | (v1)  |
  +-------+                        +-------+                      +-------+
                                                                     |
  +-------+                        +-------+                      +-------+
  | GREEN | <--- Test Traffic ---> | GREEN |                      | GREEN | (Live)
  | (v2)  |                        | (v2)  |                      | (v2)  |
  +-------+                        +-------+                      +-------+
```

### Manifest Service Selector Swap

Untuk melakukan transisi, ubah selector pada K8s Service:

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: golang-app-svc
spec:
  selector:
    app: golang-app
    version: v2.0.0 # Ubah dari v1.0.0 ke v2.0.0 secara atomik
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
```

## 3. Canary Deployment (Argo Rollouts)

Canary deployment merilis versi baru ke sebagian kecil pengguna terlebih dahulu, memungkinkan pengukuran stabilitas dan kinerja (misalnya, memantau HTTP 500s atau latency) sebelum rollout penuh. Menggunakan Argo Rollouts memberikan kontrol deklaratif seperti (10% -> 50% -> 100%).

### ASCII Traffic Flow: Canary

```text
[ Ingress (Nginx / Istio / AWS ALB) ]
           /         \
  90%     /           \     10%
         v             v
  +------------+   +------------+
  | Canary-Old |   | Canary-New |
  |   (v1)     |   |   (v2)     |
  +------------+   +------------+
```

### Konfigurasi Argo Rollout YAML

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: golang-app-rollout
spec:
  replicas: 10
  strategy:
    canary:
      steps:
      - setWeight: 10
      # Analisis metrik selama 10 menit
      - pause: {duration: 10m}
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 100
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: golang-app
  template:
    metadata:
      labels:
        app: golang-app
    spec:
      containers:
      - name: api-server
        image: registry.internal.io/golang-app:v2.0.0
        ports:
        - containerPort: 8080
```

## 4. Feature Flag-Based Deployment (Dark Launch)

Feature flagging memisahkan *deployment* (menempatkan kode di server) dari *release* (mengaktifkan fitur untuk pengguna). Hal ini memungkinkan Dark Launch, di mana kode fitur baru masuk produksi namun tertutup di balik gerbang kondisional.

### Go Code Implementation

Menggunakan standar OpenFeature atau layanan in-house untuk mengevaluasi flag:

```go
package handlers

import (
	"net/http"
	"context"

	"github.com/open-feature/go-sdk/openfeature"
)

type FeatureHandler struct {
	client *openfeature.Client
}

func NewFeatureHandler(client *openfeature.Client) *FeatureHandler {
	return &FeatureHandler{client: client}
}

func (h *FeatureHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	
	// Evaluasi feature flag "new-payment-gateway"
	useNewGateway, err := h.client.BooleanValue(ctx, "new-payment-gateway", false, openfeature.EvaluationContext{
		TargetingKey: r.Header.Get("X-User-ID"),
	})
	if err != nil {
		// Fallback ke sistem lama jika flag fail
		useNewGateway = false
	}

	if useNewGateway {
		w.Write([]byte("Menyelesaikan pembayaran via NEW Gateway"))
		return
	}

	w.Write([]byte("Menyelesaikan pembayaran via LEGACY Gateway"))
}
```

## 5. Database Migration Saat Deployment

Migrasi skema database yang digabungkan dengan pipeline CI/CD menimbulkan tantangan besar. Praktik terbaik K8s melibatkan penggunaan Kubernetes `Job` dalam fase pre-sync atau menggunakan `Init Container` jika skalanya sederhana, dengan tool `golang-migrate`.

### Konsep Init Container

Init container berjalan hingga selesai secara berurutan sebelum container aplikasi utama (API Golang) dimulai. Ini menjamin DB termigrasi sebelum kode versi baru terkoneksi.

### YAML Manifest (Init Container + golang-migrate)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: golang-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: golang-api
  template:
    metadata:
      labels:
        app: golang-api
    spec:
      initContainers:
      - name: db-migrate
        image: migrate/migrate:v4.15.2
        command:
        - /migrate
        - -path=/migrations
        - -database=$(POSTGRES_DSN)
        - up
        volumeMounts:
        - name: migrations-vol
          mountPath: /migrations
        env:
        - name: POSTGRES_DSN
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: dsn
      containers:
      - name: api
        image: my-golang-api:v2.0.0
      volumes:
      - name: migrations-vol
        configMap:
          name: db-migrations-cm
```

## 6. Rollback Strategy

Kubernetes menyimpan riwayat Deployment (disesuaikan dengan `revisionHistoryLimit`). Untuk mengembalikan kondisi sistem ke revisi sebelumnya secara instan jika Canary/Blue-Green gagal, eksekusi K8s native commands.

### K8s Rollback

```bash
# Cek riwayat
kubectl rollout history deployment/golang-app

# Undo ke versi sebelumnya (otomatis)
kubectl rollout undo deployment/golang-app

# Undo ke spesifik revisi
kubectl rollout undo deployment/golang-app --to-revision=2
```

## 7. Anti-Patterns (Bad vs Good)

### Anti-Pattern 1: Migrate DB + Deploy Simultaneously (Race Condition)

❌ **BAD**: Skrip startup container menjalankan migrasi dan API server pada saat bersamaan, atau container replica > 1 bersaing menjalankan `migrate up`.

```go
// ❌ BAD: Dijalankan di func main() ketika replicas = 3. 
// 3 Pod akan mengalami Race Condition saat migrasi.
func main() {
    m, _ := migrate.New("file://migrations", os.Getenv("DB_URL"))
    m.Up() // Race condition & DB Lock contention!
    
    http.ListenAndServe(":8080", handler)
}
```

✅ **GOOD**: Pisahkan fase menggunakan pre-install Helm Hook, Kubernetes Job, atau setidaknya satu proses eksklusif untuk DB lock (misalnya via K8s Init Container). Pastikan migrasi bersifat backwards-compatible.

```go
// ✅ GOOD: Aplikasi Go HANYA memeriksa apakah skema siap
// Proses migrate ditangani oleh pipeline terpisah / Job
func main() {
    db := connectDB()
    if err := db.Ping(); err != nil {
        log.Fatal("DB not ready")
    }
    // Tidak ada pemanggilan m.Up()
    http.ListenAndServe(":8080", handler)
}
```

### Anti-Pattern 2: No Readiness/Liveness Probe (Tidak Ada Health Check)

❌ **BAD**: Tidak ada `readinessProbe` dalam K8s YAML. K8s akan menganggap container `Running` segera setelah proses dimulai, dan me-route traffic meskipun aplikasi Golang masih sibuk *warm-up* cache atau inisialisasi koneksi DB.

```yaml
# ❌ BAD: Container langsung diberi traffic
containers:
- name: golang-app
  image: golang-app:v1
  ports:
  - containerPort: 8080
```

✅ **GOOD**: Sediakan endpoint `/health/live` (untuk liveness) dan `/health/ready` (untuk readiness) yang memeriksa status dependensi.

```yaml
# ✅ GOOD: Kubernetes menunggu endpoint HTTP 200 sebelum routing traffic
containers:
- name: golang-app
  image: golang-app:v1
  ports:
  - containerPort: 8080
  readinessProbe:
    httpGet:
      path: /health/ready
      port: 8080
    initialDelaySeconds: 5
```

```go
// ✅ GOOD: Go Health Check Handler
func readinessHandler(w http.ResponseWriter, r *http.Request) {
    if err := db.Ping(); err != nil {
        http.Error(w, "DB Disconnected", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("Ready"))
}
```

## 8. Edge Cases Implementatif

Berikut adalah 5 kasus ekstrim (edge cases) yang wajib diantisipasi dalam CI/CD Golang tingkat produksi:

1. **Sticky Session saat Blue/Green Deployment**: Jika aplikasi mempertahankan sesi in-memory (contoh: load balancer sticky session), pengguna yang terkoneksi ke "Blue" akan kehilangan sesi saat router dialihkan ke "Green".
   * **Solusi**: Terapkan *Stateless Architecture*. Simpan session data pada data store terdistribusi eksternal seperti Redis atau memcached, sehingga v1 dan v2 memiliki State yang konsisten.
2. **Long-Running Job (Misal WebSocket/gRPC streaming) saat Rolling Update**: Kubernetes mengirim `SIGTERM` ke pod lama saat di-rollout. Koneksi websocket/gRPC yang panjang akan terputus mendadak jika Golang server langsung mati.
   * **Solusi**: Tangkap signal `SIGTERM` dengan `os.Signal` channel, hentikan penerimaan traffic baru, tunggu job yang berjalan selesai dengan `sync.WaitGroup` (Graceful Shutdown) maksimal selama nilai `terminationGracePeriodSeconds` di yaml K8s.
3. **Schema Backwards Incompatibility saat Canary**: Canary menjalankan v1 (kode lama) dan v2 (kode baru) bersamaan. Jika v2 melakukan migrasi `RENAME COLUMN` pada database, v1 akan *crash* secara massal.
   * **Solusi**: Lakukan **Expand-and-Contract Pattern** pada database. Fase 1: Tambah kolom baru (v1 dan v2 hidup rukun). Fase 2: Migrate data ke kolom baru. Fase 3: Hapus kolom lama setelah v1 sepenuhnya diganti (Deployment selanjutnya).
4. **Consumer Kafka/RabbitMQ Rebalancing Storm saat Rolling Update**: Saat Consumer Group Golang di-restart perlahan-lahan oleh Rolling Update, Broker akan terus memicu Rebalancing (memecah partisi ke consumer yang hidup) yang sangat mahal dan bisa mematikan traffic.
   * **Solusi**: Gunakan strategi *Static Membership* pada Kafka consumer config, atau gunakan StatefulSet dan Blue/Green deployment alih-alih rolling update jika jumlah partisi tinggi, sehingga Consumer ID tidak memicu rebalancing berturut-turut.
5. **Init Container Timeout saat Database Migration Besar**: Jika Anda menggunakan init container untuk DB Migrate dan migrasi tersebut memakan waktu 30 menit karena volume tabel sangat besar (contoh: pembuatan INDEX besar). K8s mungkin menandai pod sebagai CrashLoopBackOff.
   * **Solusi**: Migrasi data masif (*Data Migration*) tidak boleh via Init Container / CD Pipeline. CD Pipeline dan Init container hanya untuk *Schema Migration* (waktu < 3 detik). Migrasi data harus via CronJob background script / tool terpisah tanpa mem-blokir proses *Rollout*.

## 9. Unit Test & Config Test untuk Pipeline

Menguji integrasi CI/CD sangat penting untuk memastikan tidak ada miskonfigurasi K8s atau error logic dalam handling readiness.

### Test 1: Go Unit Test untuk Health/Readiness Endpoint

Pastikan handler Readiness merespons `503 Service Unavailable` saat koneksi mati.

```go
// health_test.go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadinessProbe_DBDown(t *testing.T) {
	// Mock DB yang error
	mockDB := &MockDB{PingErr: true}
	handler := ReadinessHandler(mockDB)

	req, _ := http.NewRequest("GET", "/health/ready", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusServiceUnavailable {
		t.Errorf("Handler memberikan status %v padahal DB mati, seharusnya %v", status, http.StatusServiceUnavailable)
	}
}
```

### Test 2: Unit Test Feature Flag Integrasi

```go
// feature_test.go
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/open-feature/go-sdk/openfeature"
)

// Mock Provider OpenFeature
type MockFlagProvider struct{}

func (m *MockFlagProvider) BooleanEvaluation(ctx context.Context, flag string, defaultValue bool, evalCtx openfeature.EvaluationContext) openfeature.BoolResolutionDetail {
	if flag == "new-payment-gateway" && evalCtx.TargetingKey == "user-123" {
		return openfeature.BoolResolutionDetail{Value: true}
	}
	return openfeature.BoolResolutionDetail{Value: false}
}

func TestFeatureFlag_DarkLaunch(t *testing.T) {
	openfeature.SetProvider(&MockFlagProvider{})
	client := openfeature.NewClient("test-app")
	handler := NewFeatureHandler(client)

	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("X-User-ID", "user-123")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	expected := "Menyelesaikan pembayaran via NEW Gateway"
	if rr.Body.String() != expected {
		t.Errorf("Harusnya memicu flag baru, dapat: %s", rr.Body.String())
	}
}
```

### Test 3: Argo Rollout & Kubeval Config Validation (Bash/CI Step)

Pastikan spesifikasi K8s tidak memuat anti-pattern (misalnya salah konfigurasi readiness probe) di pipeline:

```bash
#!/bin/bash
# test-k8s-config.sh

echo "Validating Kubernetes YAML syntax..."
kubeval deployment.yaml service.yaml

echo "Validating Argo Rollout definition..."
kubectl argo rollouts lint rollout golang-app-rollout -f rollout.yaml

# Validasi tidak ada `maxUnavailable` sebesar 100% saat RollingUpdate
SURGE=$(grep "maxUnavailable:" deployment.yaml | awk '{print $2}')
if [ "$SURGE" == "100%" ]; then
    echo "❌ ERROR: maxUnavailable 100% menyebabkan zero-availability saat deployment."
    exit 1
fi
echo "✅ CI/CD Validation Passed!"
```
