# Zero-Touch Greenfield Bootstrap: Modular 3-Tier Container Topology

Dalam rekayasa sistem *Top 1% Engineering*, arsitektur lokal harus 100% mewakili kompleksitas *production*, namun tetap ringan bagi *developer machine*. Oleh karena itu, kita memisahkan topologi *container* ke dalam 3 level yang independen (Modular 3-Tier Container Topology):

1. **Tier 1 (Core):** Aplikasi inti (FrankenPHP/Octane, PostgreSQL, Valkey/Redis, Reverb). *Always-on* untuk *coding* sehari-hari.
2. **Tier 2 (Telemetry):** Observabilitas RED Metrics & Logs (Prometheus, Grafana, Loki, Promtail). Diaktifkan dengan profil khusus `telemetry` saat *debugging* performa.
3. **Tier 3 (Stress Harness):** Beban Sintetis (K6, Locust). Diaktifkan dengan profil `stress` untuk validasi arsitektur sebelum di-*push* ke reviu kode.

## ASCII Diagram Arsitektur Modular

```text
+-------------------------------------------------------------------------------------------------+
|                                 DEVELOPER WORKSTATION (DOCKER ENGINE)                             |
|                                                                                                 |
|   +-------------------------------------+       +-------------------------------------------+   |
|   |         TIER 1 (CORE)               |       |           TIER 2 (TELEMETRY)              |   |
|   |                                     |       |                                           |   |
|   |  +-------------------------------+  |       |  +-------------------------------------+  |   |
|   |  |        APP NETWORK            |  |<=====>|  |        OBSERVABILITY NETWORK        |  |   |
|   |  +-------------------------------+  |       |  +-------------------------------------+  |   |
|   |         |                  |        |       |         |               |              |  |   |
|   |  +-------------+    +------------+  |       |  +-------------+  +-----------+  +-----+  |   |
|   |  | FrankenPHP  |    | PostgreSQL |  |       |  | Prometheus  |  | Grafana   |  | Loki|  |   |
|   |  | (Octane)    |    | (Primary)  |  |       |  | (Scraper)   |  | (DashUI)  |  |     |  |   |
|   |  | Port: 8000  |    | Port: 5432 |  |       |  | Port: 9090  |  | Port:3000 |  | 3100|  |   |
|   |  +-------------+    +------------+  |       |  +-------------+  +-----------+  +-----+  |   |
|   |         |                  |        |       |         |               |              |  |   |
|   |  +-------------+    +------------+  |       |  +-------------+        |              |  |   |
|   |  | Reverb (WS) |    | Valkey     |  |       |  | Promtail    |--------+--------------+  |   |
|   |  | Port: 8080  |    | (Cache/Q)  |  |       |  | (Log Tail)  |                          |   |
|   |  +-------------+    +------------+  |       |  +-------------+                          |   |
|   +-------------------------------------+       +-------------------------------------------+   |
|                      ^                                                ^                       |
|                      |                                                |                       |
|   +------------------+------------------------------------------------+-----------------+   |
|   |                            TIER 3 (STRESS HARNESS)                                  |   |
|   |                                                                                     |   |
|   |  +-----------------------------+                                                    |   |
|   |  | K6 Load Generator (grafana) |---- [Simulates 500+ Virtual Users / Sec]           |   |
|   |  | k6-octane.js Script         |---- [Validates p95 latency & error rates]          |   |
|   |  +-----------------------------+                                                    |   |
|   +-------------------------------------------------------------------------------------+   |
+-------------------------------------------------------------------------------------------------+
```

## Konfigurasi Manifes Nyata (No Placeholders)

### 1. `docker-compose.yml` (Modular Profiles)

Kode di bawah wajib ditulis di *root* direktori untuk mengaktifkan ketiga *tier*.

```yaml
version: '3.8'

services:
  # ==========================================
  # TIER 1: CORE (Always Running by Default)
  # ==========================================
  app:
    image: dunglas/frankenphp:latest-php8.3-alpine
    container_name: laravel_octane
    environment:
      APP_ENV: ${APP_ENV:-local}
      APP_KEY: ${APP_KEY:-base64:qWeRtY+U1I0oP/aSdF+GhJ/kLzXcVbNmM=}
      DB_CONNECTION: pgsql
      DB_HOST: db
      DB_PORT: 5432
      DB_DATABASE: ${DB_DATABASE:-laravel}
      DB_USERNAME: ${DB_USERNAME:-postgres}
      DB_PASSWORD: ${DB_PASSWORD:-secret}
      REDIS_HOST: cache
      REDIS_PASSWORD: ${REDIS_PASSWORD:-null}
      OCTANE_SERVER: frankenphp
    volumes:
      - ./:/app
      - ./storage/logs:/app/storage/logs
    ports:
      - "8000:8000"
      - "2019:2019" # FrankenPHP Admin API (Prometheus Target)
    command: php artisan octane:start --server=frankenphp --host=0.0.0.0 --port=8000 --watch
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    networks:
      - core_network

  db:
    image: postgres:16-alpine
    container_name: laravel_postgres
    environment:
      POSTGRES_DB: ${DB_DATABASE:-laravel}
      POSTGRES_USER: ${DB_USERNAME:-postgres}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secret}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USERNAME:-postgres}"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - core_network

  cache:
    image: valkey/valkey:7.2-alpine
    container_name: laravel_valkey
    ports:
      - "6379:6379"
    command: ["valkey-server", "--appendonly", "yes"]
    volumes:
      - valkeydata:/data
    networks:
      - core_network

  reverb:
    image: dunglas/frankenphp:latest-php8.3-alpine
    container_name: laravel_reverb
    environment:
      APP_ENV: ${APP_ENV:-local}
      APP_KEY: ${APP_KEY:-base64:qWeRtY+U1I0oP/aSdF+GhJ/kLzXcVbNmM=}
      REVERB_SERVER_HOST: 0.0.0.0
      REVERB_SERVER_PORT: 8080
    volumes:
      - ./:/app
    ports:
      - "8080:8080"
    command: php artisan reverb:start --host=0.0.0.0 --port=8080
    depends_on:
      - cache
    networks:
      - core_network

  # ==========================================
  # TIER 2: TELEMETRY (Profile: telemetry)
  # ==========================================
  prometheus:
    image: prom/prometheus:v2.53.0
    container_name: telemetry_prometheus
    profiles:
      - telemetry
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    networks:
      - core_network

  loki:
    image: grafana/loki:3.0.0
    container_name: telemetry_loki
    profiles:
      - telemetry
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    networks:
      - core_network

  promtail:
    image: grafana/promtail:3.0.0
    container_name: telemetry_promtail
    profiles:
      - telemetry
    volumes:
      - ./storage/logs:/var/log/laravel
      - ./docker/promtail/promtail.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml
    depends_on:
      - loki
    networks:
      - core_network

  grafana:
    image: grafana/grafana:11.0.0
    container_name: telemetry_grafana
    profiles:
      - telemetry
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
      - loki
    networks:
      - core_network

  # ==========================================
  # TIER 3: STRESS HARNESS (Profile: stress)
  # ==========================================
  k6:
    image: grafana/k6:latest
    container_name: stress_k6
    profiles:
      - stress
    volumes:
      - ./docker/k6:/scripts
    command: run /scripts/k6-octane.js
    depends_on:
      - app
    networks:
      - core_network

networks:
  core_network:
    driver: bridge

volumes:
  pgdata:
  valkeydata:
```

### 2. Konfigurasi Pengaliran Log Monolog & Telemetry (Tier 2)

**File:** `docker/promtail/promtail.yml` (Sinkronisasi Monolog ke Loki)
```yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: laravel_monolog
    static_configs:
      - targets:
          - localhost
        labels:
          job: laravel_octane
          __path__: /var/log/laravel/laravel.log
    pipeline_stages:
      - regex:
          expression: '^\[(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (?P<env>\w+)\.(?P<level>\w+): (?P<message>.*)'
      - labels:
          level:
          env:
```

**File:** `docker/prometheus/prometheus.yml` (Scraping Octane Metrics)
```yaml
global:
  scrape_interval: 5s

scrape_configs:
  - job_name: 'frankenphp_octane'
    static_configs:
      - targets: ['app:2019']
```

### 3. Skrip Uji Beban k6 (Tier 3 - Stress Harness)

**File:** `docker/k6/k6-octane.js` (Validasi Performa Worker Pool)
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

export const errorRate = new Rate('errors');

export const options = {
    stages: [
        { duration: '10s', target: 50 },  // Ramp-up ke 50 Virtual Users
        { duration: '30s', target: 200 }, // Spike ke 200 Virtual Users (Stress)
        { duration: '10s', target: 0 },   // Ramp-down
    ],
    thresholds: {
        'http_req_duration': ['p(95)<50'], // 95% request harus selesai di bawah 50ms
        'errors': ['rate<0.01'],           // Error rate maksimal 1%
    },
};

export default function () {
    // Simulasi hit endpoint API krusial
    const res = http.get('http://app:8000/api/health');

    const success = check(res, {
        'status is 200': (r) => r.status === 200,
        'transaction is fast': (r) => r.timings.duration < 50,
    });

    if (!success) {
        errorRate.add(1);
    }

    sleep(0.1);
}
```

## Analisis Trade-off

**Kelebihan (Pros):**
1. **Developer Experience (DX) Tertinggi:** Isolasi Tier `profiles` mencegah RAM developer tersedot habis oleh Prometheus & Elasticsearch/Loki saat *coding* harian. Telemetry hanya dinyalakan dengan `docker compose --profile telemetry up -d`.
2. **Replikasi Cacat Produksi yang Sempurna:** Arsitektur K6 stress test menekan *worker pool* Octane (FrankenPHP) sampai batasnya, menguak isu *memory leak* `static` variabel lokal sebelum menembus *production*.
3. **Observabilitas Zero-Touch:** Konfigurasi Promtail + Regex Parser langsung mengenali `laravel.log` bawaan Monolog tanpa perlu modifikasi *package* tambahan di *codebase* Laravel.

**Kekurangan (Cons):**
1. **Kompleksitas Inisiasi:** Anggota tim *junior* rentan bingung dengan banyaknya *container* dan peran masing-masing saat *onboarding*.
2. **Kurva Pembelajaran PromQL/LogQL:** Mencari sumber *bug* di Tier 2 membutuhkan pemahaman dasar *query* Loki (LogQL) dan Grafana, bukan sekadar melihat log *text plain*.
3. **Overhead Disk Volume:** Retensi data metrik Prometheus dan log Loki dapat membengkak pada volume Docker lokal jika tidak diawasi/dibersihkan secara reguler (`docker system prune`).

## Anti-Patterns (Sangat Dilarang ❌)

1. ❌ **Menjalankan Prometheus/Metrics Scraper di dalam Thread Utama Octane:** Menyisipkan pengirim metrik UDP StatsD atau Prometheus di dalam blok `App::terminating` Octane secara sinkron.
   ✅ **Benar:** Biarkan FrankenPHP *metrics endpoint* (`:2019`) diekspos lalu biarkan *container* Prometheus yang melakukan *pulling* (Scrape) di *network* internal Docker tanpa memblokir siklus permintaan pengguna.
2. ❌ **Auto-Start Seluruh Layanan (No Profiles):** Membiarkan K6 load test dan Grafana selalu berjalan sejak perintah `docker compose up` ditekan.
   ✅ **Benar:** Gunakan spesifikasi `--profile telemetry` atau `--profile stress` untuk eksklusivitas. K6 hanya berjalan satu kali (*one-off command*) dengan perintah `docker compose --profile stress run --rm k6`.

## Production Edge Cases Mutlak

1. **Octane Worker Memory Leaks di Bawah Stress K6:**
   Saat k6 memukul server Octane dengan 200 VUs terus-menerus, *service provider* Laravel yang menyimpan status di *array static* (seperti *query log* Eloquent, atau *custom singleton*) akan membesar tanpa henti. Sistem ini langsung menggagalkan *pipeline* karena penggunaan RAM akan melonjak (terbaca di Grafana) dan K6 akan mencatat lonjakan latensi di atas p95 > 50ms karena proses *Garbage Collection* PHP kewalahan.
2. **Loki Buffer Overflow Saat Request Spike:**
   Saat *load testing* K6 mencapai puncaknya, Laravel akan menghasilkan puluhan ribu log dalam detik yang sama (misal log *query* lambat). Promtail bisa mengalami *buffer overflow* dan men-drop *log* penting. Solusi arsitekturnya adalah memastikan Monolog dikonfigurasi menggunakan level `warning` atau `error` di profil *production*, atau membatasi batas ukuran *batch* di `/etc/promtail/config.yml`.
3. **OPcache JIT Cache Exhaustion di Docker:**
   FrankenPHP + PHP 8.3 menggunakan OPcache *Just-In-Time* (JIT) *compilation*. Di lingkungan dengan banyak *file* dinamis yang di-render saat *runtime*, K6 akan membongkar *cache exhaustion* (OPcache *buffer full*), memaksa PHP mengkompilasi *script* ulang, dan menurunkan *throughput* drastis. Metrik FrankenPHP di Grafana akan menunjukkan *hit-rate* OPcache terjun bebas. Mengubah batas *memory* OPcache via konfigurasi `php.ini` khusus di Dockerfile Tier 1 mutlak dilakukan untuk resolusi ini.
