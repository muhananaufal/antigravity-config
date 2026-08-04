# Zero-Touch Greenfield Bootstrap: Modular 3-Tier Container Topology (Core + Telemetry + Stress)

Pilar ini adalah hukum mutlak yang wajib dipatuhi saat memulai proyek baru (Greenfield) berbasis NestJS Enterprise. Tanpa arsitektur kontainer modular ini, Anda berisiko kehilangan visibilitas produksi dan stabilitas sistem.

## Topologi Arsitektur Mutlak: Modular 3-Tier

Arsitektur 3-Tier ini memisahkan dependency operasional (Tier 1) dari observabilitas (Tier 2) dan alat pengujian (Tier 3), memungkinkan sistem berjalan dengan tapak memori kecil saat pengembangan (tanpa telemetry), atau sebagai instance siap stres untuk tuning ketat.

### Diagram ASCII Topologi

```text
+-----------------------------------------------------------------------------------------+
|                              Host OS / Local Network Bridge                             |
|                                                                                         |
|  +---------------------------+       +-------------------------+      +--------------+  |
|  |       TIER 1 (CORE)       |       |   TIER 2 (TELEMETRY)    |      |    TIER 3    |  |
|  |     (Always Running)      |       |  (profiles: telemetry)  |      |   (STRESS)   |  |
|  |                           |       |                         |      |              |  |
|  | +-----------------------+ |       | +---------------------+ |      | +----------+ |  |
|  | | NestJS Fastify/Bun    | |<======|=| OTel Collector      | |<-----|-| k6 Load  | |  |
|  | | (Port 3000, 9229)     | | gRPC  | | (Port 4317, 4318)   | |      | | Generator| |  |
|  | | + OpenTelemetry SDK   | | HTTP  | +---------------------+ |      | +----------+ |  |
|  | +-----------------------+ |       |           |             |      |              |  |
|  |             |             |       | +---------v---------+   |      | (profiles:   |  |
|  | +-----------v-----------+ |       | | Prometheus (RED)  |   |      |  stress)     |  |
|  | | PostgreSQL 16         | |       | +-------------------+   |      +--------------+  |
|  | | (Port 5432)           | |       | +-------------------+   |                        |
|  | +-----------------------+ |       | | Grafana           |   |                        |
|  | +-----------------------+ |       | | (Port 3001)       |   |                        |
|  | | Redis Valkey          | |       | +-------------------+   |                        |
|  | | (Port 6379)           | |       | +-------------------+   |                        |
|  | +-----------------------+ |       | | Loki (Logs)       |   |                        |
|  |                           |       | +-------------------+   |                        |
|  +---------------------------+       +-------------------------+                        |
+-----------------------------------------------------------------------------------------+
```

## Konfigurasi Manifes Mutlak: `docker-compose.yml`

File mutlak `docker-compose.yml` ini wajib ditanam di root proyek. Gunakan Docker Compose Profiles agar infrastruktur non-core dapat dimatikan/dihidupkan.

```yaml
version: '3.8'

x-logging: &default-logging
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"

services:
  # ==========================================
  # TIER 1: CORE (Selalu Aktif)
  # ==========================================
  postgres:
    image: postgres:16-alpine
    container_name: core-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER:-nest_user}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-nest_secret}
      POSTGRES_DB: ${DB_NAME:-nest_db}
    ports:
      - "${DB_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-nest_user} -d ${DB_NAME:-nest_db}"]
      interval: 5s
      timeout: 5s
      retries: 5
    logging: *default-logging

  valkey:
    image: valkey/valkey:7.2-alpine
    container_name: core-valkey
    restart: unless-stopped
    command: valkey-server --requirepass ${REDIS_PASSWORD:-valkey_secret}
    ports:
      - "${REDIS_PORT:-6379}:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "-a", "${REDIS_PASSWORD:-valkey_secret}", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    logging: *default-logging

  # ==========================================
  # TIER 2: TELEMETRY (profile: telemetry)
  # ==========================================
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.95.0
    container_name: telemetry-otel
    profiles: ["telemetry"]
    command: ["--config=/etc/otel-collector-config.yaml"]
    volumes:
      - ./infra/otel-collector-config.yaml:/etc/otel-collector-config.yaml
    ports:
      - "4317:4317" # OTLP gRPC
      - "4318:4318" # OTLP HTTP
    logging: *default-logging

  prometheus:
    image: prom/prometheus:v2.50.0
    container_name: telemetry-prometheus
    profiles: ["telemetry"]
    volumes:
      - ./infra/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
    logging: *default-logging

  grafana:
    image: grafana/grafana:10.3.3
    container_name: telemetry-grafana
    profiles: ["telemetry"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin_secret}
      - GF_USERS_ALLOW_SIGN_UP=false
    ports:
      - "3001:3000"
    volumes:
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
      - loki
    logging: *default-logging

  loki:
    image: grafana/loki:2.9.4
    container_name: telemetry-loki
    profiles: ["telemetry"]
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "3100:3100"
    logging: *default-logging

  # ==========================================
  # TIER 3: STRESS HARNESS (profile: stress)
  # ==========================================
  k6:
    image: grafana/k6:0.49.0
    container_name: stress-k6
    profiles: ["stress"]
    volumes:
      - ./infra/k6:/scripts
    command: run /scripts/k6-fastify-ajv.js
    environment:
      - K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write
      - TARGET_URL=http://host.docker.internal:3000
    depends_on:
      - prometheus
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  postgres_data:
  valkey_data:
  prometheus_data:
  grafana_data:
```

## OTLP gRPC dan Prometheus RED Metrics

Implementasikan instrumen pada entri aplikasi untuk memicu pengumpulan jejak dan metrik OTLP:

```typescript
// src/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTLP_ENDPOINT || 'grpc://localhost:4317',
});

const metricExporter = new OTLPMetricExporter({
  url: process.env.OTLP_ENDPOINT || 'grpc://localhost:4317',
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 10000,
});

export const otelSDK = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'nestjs-enterprise-core',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter,
  metricReader,
});

// Anda wajib memanggil otelSDK.start() sebelum bootstrap NestJS.
```

## Skrip Uji Beban k6 (`infra/k6/k6-fastify-ajv.js`)

Untuk membuktikan Fastify sanggup menangani komputasi JSON Schema dan routing yang berat dengan p99 < 30ms, Anda diwajibkan melakukan stress test ini:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 50 },  // Ramp-up to 50 users
    { duration: '30s', target: 100 }, // Spike to 100 users
    { duration: '10s', target: 0 },   // Ramp-down to 0 users
  ],
  thresholds: {
    'http_req_duration': ['p(99)<30'], // 99% of requests must complete below 30ms
    'http_req_failed': ['rate<0.01'],  // Less than 1% errors allowed
  },
};

export default function () {
  const payload = JSON.stringify({
    username: `user_${__VU}_${__ITER}`,
    email: `user_${__VU}_${__ITER}@enterprise.local`,
    age: Math.floor(Math.random() * 60) + 18,
    roles: ['user'],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.TEST_TOKEN || 'dummy_token'}`,
    },
  };

  const res = http.post(`${__ENV.TARGET_URL || 'http://localhost:3000'}/api/v1/users`, payload, params);

  check(res, {
    'status is 201': (r) => r.status === 201,
    'latency below 30ms': (r) => r.timings.duration < 30,
  });

  sleep(0.1);
}
```

## Analisis Trade-Off

### 3 Kelebihan
1. **Isolasi Beban & Resource Development yang Ramping:** Anda dapat mengembangkan Core Tier (DB, Redis) tanpa dibebani overhead OTel Collector dan Prometheus yang mengonsumsi memori besar (hingga >1GB). Cukup aktifkan Tier 2 ketika debugging latensi mikro.
2. **Standardisasi Metrik & Observabilitas Seragam:** Penggunaan OTLP gRPC memastikan Anda tidak terikat dengan vendor observabilitas. Anda dapat mengganti backend dari Loki/Prometheus ke Datadog/NewRelic tanpa mengubah instrumentasi SDK Node.js.
3. **Deteksi Regresi Latensi Awal (Shift-Left Performance):** Berkat Tier 3 (k6 harness), kebocoran event loop, alokasi memori berlebih, atau ketidakefisienan kueri Prisma/Drizzle langsung ketahuan sebelum kode mencapai staging/produksi.

### 3 Kekurangan
1. **Kompleksitas Inisialisasi:** Proyek Greenfield kini memiliki manifest kontainer besar sejak awal. Jika Anda tidak terbiasa dengan arsitektur OTLP dan Profil Compose, kurva belajar terasa sangat mendaki.
2. **Port Conflict pada Local Machine:** Menjalankan Prometheus (9090), Grafana (3001), Loki (3100), dan OTel (4317/4318) secara konstan memperbesar probabilitas bentrokan port jika developer mengerjakan berbagai microservices berbarengan.
3. **Overhead Instrumentation NestJS yang Cukup Terasa:** Meski gRPC sangat cepat, penangkapan metrik RED (Rate, Errors, Duration) dan distributed tracing OTLP menambah jejak komputasi sinkron kecil di atas Event Loop Node.js.

## Anti-Patterns: Praktik Terlarang di Produksi

### Anti-Pattern 1: Hardcoding Credential di `docker-compose.yml`
❌ **Salah (Fatal):** Menanamkan plaintext credential dan DSN ke dalam berkas `docker-compose.yml` yang dikomit ke VCS (Git).
```yaml
# DOSA BESAR
services:
  postgres:
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: mySuperSecretPassword123
```
✅ **Benar:** Memanfaatkan Environment Variable Substitutions (`${VAR:-default}`) untuk mengizinkan injeksi rahasia secara eksternal melalui `.env` atau CI/CD Vault.
```yaml
services:
  postgres:
    environment:
      POSTGRES_USER: ${DB_USER:-nest_user}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-nest_secret}
```
**Mengapa Fatal:** Akses kode berarti akses langsung ke basis data produksi. Credential hardcode adalah pintu gerbang pencurian data masif!

### Anti-Pattern 2: Logging Sinkron ke File atau Loki secara Langsung (Blocking)
❌ **Salah (Fatal):** Menggunakan `console.log` mentah atau `winston` transport langsung yang melakukan disk I/O / HTTP request secara sinkron ke Loki, memblokir main event loop Node.js selama lonjakan trafik.
✅ **Benar:** Gunakan `pino` logger yang dialirkan (piped) ke `pino-loki` di thread terpisah (Worker Thread) atau mengandalkan stdout standar yang ditangkap via Docker log driver dan dikirim asinkron oleh Promtail/Loki plugin.
**Mengapa Fatal:** Memblokir V8 Event Loop demi menunggu konfirmasi penulisan log berujung pada penurunan throughput radikal dan socket timeout pada klien Fastify.

## 3 Production Edge Cases

1. **V8 Old Space Heap Out-Of-Memory Saat Pengujian k6 Massal:** Ketika k6 membombardir NestJS dengan 10.000 RPS, Fastify memproduksi jutaan objek respons. Jika Anda memiliki kebocoran konteks observabilitas (misalnya `AsyncLocalStorage` yang tidak di-clear), *Old Space Heap* V8 akan bengkak dan mengakibatkan proses `OOMKilled`. Pasang `--max-old-space-size=2048` sebagai mitigasi awal dan profil alokasi.
2. **Event Loop Blocking Karena Tracing Ekspor:** Jika jaringan gRPC ke OTel Collector putus secara mikro, queue OTLP SDK di NestJS dapat penuh. Proses sinkronisasi buffer berlebihan memaksa CPU spike, sehingga pengolahan koneksi asinkron HTTP baru melambat secara drastis. Pengaturan `exportIntervalMillis` dan membatasi `batchSize` menjadi krusial.
3. **Socket Timeout di Fastify Under Spike:** Saat *thundering herd* dari k6 menabrak engine Fastify, Prisma/Drizzle connection pool mungkin kehabisan slot koneksi database. Ini mengakibatkan request mengantri di Fastify lebih dari 5 detik, menyebabkan NGINX/Client memotong socket (timeout 504/502). Mengelola limit koneksi pgbouncer sangat diwajibkan bersamaan dengan topologi ini.
