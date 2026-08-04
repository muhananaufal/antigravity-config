# Zero-Touch Greenfield Bootstrap: Modular 3-Tier Container Topology

Arsitektur sistem backend Golang yang tangguh untuk skenario production tidak bisa hanya mengandalkan kode biner Go yang berjalan sendiri. Untuk memastikan kesiapan dari hari pertama (Day 0), pendekatan *Zero-Touch Greenfield Bootstrap* mewajibkan kita membangun fondasi kontainerisasi 3 lapis (3-Tier). Pendekatan ini memastikan lingkungan *development* dan *staging* langsung siap mengukur kinerja, resiliensi, dan metrik aplikasi tanpa intervensi manual yang rumit. 

## 1. Konsep Arsitektur 3-Tier Topology

Topology 3-Tier ini memisahkan layanan menjadi tiga lapisan terpisah dengan tujuan spesifik:

1. **Tier 1 (Core Foundation):** Layanan utama aplikasi yang mutlak dibutuhkan untuk berjalan. Meliputi database utama (PostgreSQL), sistem cache/broker (Redis Valkey), dan service Golang itu sendiri.
2. **Tier 2 (Telemetry & Observability):** Ekosistem visibilitas sistem yang bersifat opsional namun wajib disiapkan. Meliputi OpenTelemetry Collector, Prometheus, Loki, dan Grafana.
3. **Tier 3 (Stress Harness):** Layanan khusus untuk simulasi beban (load testing) seperti `grafana/k6` yang bertujuan mencari batas atas kinerja sistem (breaking point) Golang.

Lapisan 2 dan 3 diisolasi menggunakan fitur `profiles` dari Docker Compose, sehingga menghemat konsumsi CPU dan RAM saat pengembang hanya fokus pada *logic code*.

### ASCII Diagram Topologi Modular 3-Tier

```text
+-----------------------------------------------------------------------------------+
|                                 USER / CLIENT                                     |
+-----------------------------------------------------------------------------------+
                                        | HTTP / gRPC
+-----------------------------------------------------------------------------------+
|  [Tier 3: Stress Harness]             |                                           |
|  (Profile: stress)                    v                                           |
|  +------------------------+      +---------------------------------------------+  |
|  | grafana/k6 container   |=====>|        Go Application Runtime (App)         |  |
|  | - Run HTTP/gRPC load   |      |  - Expose API Port (e.g., 8080)             |  |
|  | - Evaluate p99 latency |      |  - Expose Metrics Port (e.g., 2112)         |  |
|  +------------------------+      +---------------------------------------------+  |
|                                        |                 |             |          |
+----------------------------------------|-----------------|-------------|----------+
                                         v                 v             v
+----------------------------------------------------+  +---------------------------+
| [Tier 1: Core Foundation] (Default Profile)        |  |                           |
|                                                    |  |                           |
|  +-------------------+      +-------------------+  |  |                           |
|  | PostgreSQL        |      | Redis Valkey      |  |  |                           |
|  | - Persistent Data |      | - Session & Cache |  |  |                           |
|  +-------------------+      +-------------------+  |  |                           |
+----------------------------------------------------+  |                           |
                                                        |                           |
+----------------------------------------------------+  |  [Tier 2: Telemetry]      |
|                                                    |  |  (Profile: telemetry)     |
|                                                    |  |                           |
|  +-------------------+      +-------------------+  |  |  +---------------------+  |
|  | Prometheus        |<-----| OTel Collector    |<----|--| Go Runtime Metrics  |  |
|  | - Scrape Metrics  |      | - Receive Traces  |  |  |  | - /metrics endpoint |  |
|  +-------------------+      +-------------------+  |  |  +---------------------+  |
|           |                           |            |  |                           |
|           v                           v            |  |                           |
|  +-------------------+      +-------------------+  |  |                           |
|  | Grafana           |      | Loki              |  |  |                           |
|  | - Dashboard       |      | - Log Aggregation |  |  |                           |
|  +-------------------+      +-------------------+  |  |                           |
+----------------------------------------------------+  +---------------------------+
```

## 2. Manifes Konfigurasi Modular (Zero Placeholders)

### A. `docker-compose.yml`

File utama ini menyatukan semua kontainer dengan pemisahan profil. Gunakan variabel environment dengan default fallback agar tidak ada *hardcoded secrets*.

```yaml
version: '3.8'

x-logging: &default-logging
  driver: "json-file"
  options:
    max-size: "20m"
    max-file: "3"

services:
  # ---------------------------------------------------------
  # TIER 1: Core Foundation (Selalu jalan tanpa profil khusus)
  # ---------------------------------------------------------
  api:
    build: 
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
      - "2112:2112"
    environment:
      - APP_ENV=development
      - DB_DSN=postgres://${POSTGRES_USER:-appuser}:${POSTGRES_PASSWORD:-secret123}@postgres:5432/${POSTGRES_DB:-appdb}?sslmode=disable
      - REDIS_ADDR=redis:6379
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    logging: *default-logging
    networks:
      - app_network

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=${POSTGRES_USER:-appuser}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-secret123}
      - POSTGRES_DB=${POSTGRES_DB:-appdb}
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-appuser}"]
      interval: 5s
      timeout: 5s
      retries: 5
    logging: *default-logging
    networks:
      - app_network
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: valkey/valkey:7.2-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    logging: *default-logging
    networks:
      - app_network
    volumes:
      - redis_data:/data

  # ---------------------------------------------------------
  # TIER 2: Telemetry & Observability (Profile: telemetry)
  # ---------------------------------------------------------
  otel-collector:
    image: otel/opentelemetry-collector:0.96.0
    profiles: ["telemetry"]
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./infra/telemetry/otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317" # OTLP gRPC
      - "4318:4318" # OTLP HTTP
    networks:
      - app_network

  prometheus:
    image: prom/prometheus:v2.50.1
    profiles: ["telemetry"]
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
    ports:
      - "9090:9090"
    volumes:
      - ./infra/telemetry/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    networks:
      - app_network

  grafana:
    image: grafana/grafana:10.3.3
    profiles: ["telemetry"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin123}
      - GF_AUTH_ANONYMOUS_ENABLED=true
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
    volumes:
      - grafana_data:/var/lib/grafana
    networks:
      - app_network

  loki:
    image: grafana/loki:2.9.4
    profiles: ["telemetry"]
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "3100:3100"
    networks:
      - app_network

  # ---------------------------------------------------------
  # TIER 3: Stress Harness (Profile: stress)
  # ---------------------------------------------------------
  k6:
    image: grafana/k6:0.49.0
    profiles: ["stress"]
    command: run /scripts/k6-stress.js
    volumes:
      - ./infra/stress/k6-stress.js:/scripts/k6-stress.js
    networks:
      - app_network
    depends_on:
      - api

networks:
  app_network:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
  prometheus_data:
  grafana_data:
```

### B. Konfigurasi OpenTelemetry Collector (`otel-collector-config.yaml`)

Simpan di `./infra/telemetry/otel-collector-config.yaml`. Bertugas menerima metrik/trace OTLP dan membuangnya secara terpusat untuk keperluan observabilitas.

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    send_batch_size: 1000
    timeout: 1s
  memory_limiter:
    check_interval: 1s
    limit_mib: 1500
    spike_limit_mib: 512

exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: "golang_app"
  debug:
    verbosity: detailed

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, debug]
```

### C. Konfigurasi Prometheus Scrape (`prometheus.yml`)

Simpan di `./infra/telemetry/prometheus.yml`. Membaca metrik standar Golang `client_golang` beserta data yang terekspor dari OTel Collector.

```yaml
global:
  scrape_interval: 5s
  evaluation_interval: 5s

scrape_configs:
  - job_name: 'golang_api_native'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['api:2112']

  - job_name: 'otel_collector'
    static_configs:
      - targets: ['otel-collector:8889']
```

### D. K6 Stress Harness Script (`k6-stress.js`)

Simpan di `./infra/stress/k6-stress.js`. Ini adalah script uji tegak nyata untuk mengukur apakah service Golang mampu bertahan dan memenuhi kriteria latensi p99 < 50ms di bawah tekanan 100 virtual users secara konstan.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 50 },  // Ramp-up to 50 users over 5 seconds
    { duration: '20s', target: 100 }, // Stay at 100 users for 20 seconds
    { duration: '5s', target: 0 },   // Ramp-down to 0 users
  ],
  thresholds: {
    // Assert p99 latency must be lower than 50ms, and p95 lower than 30ms
    http_req_duration: ['p(95)<30', 'p(99)<50'],
    // Assert error rate is strictly less than 1%
    http_req_failed: ['rate<0.01'], 
  },
};

export default function () {
  const res = http.get('http://api:8080/health');
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time is fast': (r) => r.timings.duration < 50,
  });

  // Short sleep to simulate real user wait time between requests
  sleep(0.1); 
}
```

## 3. Analisis Trade-Off Arsitektur 3-Tier Modular

Menjalankan model kontainerisasi multi-tier seperti ini tentu memiliki konsekuensi yang harus dipertimbangkan matang-matang:

**Kelebihan (Pros):**
1. **Zero-Friction Observability:** Sistem telemetri langsung terhubung. Developer tidak perlu membuang waktu 2-3 hari mengonfigurasi Prometheus/Grafana dan instrumentasi OTel saat dibutuhkan; tinggal nyalakan dengan `docker compose --profile telemetry up -d`.
2. **Kinerja Mesin Developer Terjaga:** Penggunaan `profiles` mencegah kontainer berat seperti Grafana, Loki, dan Prometheus berjalan otomatis saat developer sekadar ingin menulis kode bisnis (*Core Tier 1* saja), menghemat minimal 1-2GB RAM.
3. **Mendeteksi Degradasi Sejak Dini:** Kehadiran Tier 3 (Stress Harness) yang siap digunakan memastikan load testing menjadi warga kelas satu. Batas kinerja Golang dan database connection pool bisa diukur tanpa perlu meminjam server eksternal, membuat regresi kinerja terdeteksi lebih cepat.

**Kekurangan (Cons):**
1. **Kompleksitas Perawatan Manifes:** Pemeliharaan file *docker-compose* dan berbagai manifest terkait (Prometheus, OTel) menuntut kompetensi DevOps dasar dari seluruh tim backend.
2. **Learning Curve Ekosistem:** Konfigurasi metrik OTLP sering berubah dari satu rilis ke rilis lainnya; misalnya pemisahan gRPC dan HTTP *endpoint* untuk OpenTelemetry Collector bisa membingungkan developer junior.
3. **Overhead Storage Lokal:** Menjalankan Prometheus dan Loki di lokal dapat menghasilkan akumulasi data di *Docker Volumes* yang jika tidak di-prune secara teratur akan memakan disk space yang masif hingga puluhan Gigabyte.

## 4. Anti-Patterns (Salah vs Benar)

### Anti-Pattern 1: Menjalankan Seluruh Service Secara Monolitik tanpa Profil

❌ **SALAH:** Semua kontainer telemetri (Grafana, Prometheus, Loki) dimasukkan tanpa klausa `profiles`. Akibatnya, `docker compose up` langsung menyala bersamaan, membebani CPU dan RAM developer untuk service yang hanya diakses 5% waktu pengembangan.

✅ **BENAR:** Memisahkan menggunakan `profiles: ["telemetry"]`. Saat butuh telemetri, jalankan eksklusif: `docker compose --profile telemetry up -d`. Mengurangi *footprint* inisialisasi hingga 70%.

### Anti-Pattern 2: Menyatukan Network secara Berantakan tanpa Isolasi Dependensi

❌ **SALAH:** Menjalankan kontainer K6 (`Tier 3`) namun gagal memberi deklarasi `depends_on: api`. K6 akan mencoba membanjiri request ketika kontainer Golang API masih menginisiasi koneksi DB atau melakukan migrasi. Hasil uji *stress test* menjadi kacau (banyak 502/Connection Refused).

✅ **BENAR:** Memberi label `depends_on` untuk memastikan kontainer di-boot berurutan. Gunakan spesifikasi `condition: service_healthy` pada database dan cache agar layer Golang (Tier 1) dan Load Generator (Tier 3) mendapatkan *clean slate* lingkungan pengujian.

## 5. Production Edge Cases

Penerapan *topology* ini di produksi atau skala beban tinggi berpotensi menabrak batasan-batasan nyata, yaitu:

1. **Cardinality Explosion pada Label Prometheus Golang:**
   Secara default, instrumentasi Golang yang mengekspos metrik per route berisiko meledak jika label URL memuat ID dinamis (contoh: `/api/v1/user/123` di mana ID `123` terekam sebagai label path unik). Ini akan membunuh Prometheus karena kehabisan RAM. **Mitigasinya:** Selalu normalisasi path label di middleware Golang (mengubah `/user/123` menjadi `/user/{id}`).

2. **Kelelahan Soket (Socket Exhaustion) saat Eksekusi K6 Load Test:**
   Saat k6 mensimulasikan ribuan VUs (Virtual Users) ke kontainer Golang, host Docker bisa kehabisan ephemeral ports atau membentur batas koneksi maksimum *file descriptors*. Hal ini memunculkan error `dial tcp: lookup / address in use`. **Mitigasinya:** Menaikkan limit *file descriptors* pada *docker-daemon* (misal via sysctl `net.ipv4.ip_local_port_range`) dan memastikan setting *keep-alive* di Golang cukup panjang agar reusing socket lebih efisien.

3. **Loki OOM Kill Akibat Disk I/O Bottleneck:**
   Jika simulasi stress test sangat bising hingga memproduksi >10,000 log per detik, agent Docker yang mengirimkan log ke container Loki dapat mengalami antrean panjang, dan menyebabkan Loki kehabisan memori atau CPU throttling akibat lambatnya flush ke local disk. **Mitigasinya:** Konfigurasikan max-size pada logging driver (seperti contoh yaml di atas) dan gunakan chunking/batching pada Loki untuk mengurai beban *ingestion*.
