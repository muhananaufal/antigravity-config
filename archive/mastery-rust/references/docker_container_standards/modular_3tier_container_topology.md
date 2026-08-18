# Zero-Touch Greenfield Bootstrap: Modular 3-Tier Container Topology

Dalam rekayasa sistem Rust enterprise, stabilitas dan kemampuan observabilitas sistem sama pentingnya dengan performa kode itu sendiri. Standar arsitektur ini mendiktekan bahwa setiap inisialisasi proyek baru (Greenfield) di Rust **WAJIB** secara default menggunakan struktur kontainerisasi Modular 3-Tier. Arsitektur ini memastikan lingkungan pengembangan lokal identik dengan *production*, tanpa mengorbankan kecepatan iterasi karena memisahkan core dependencies, observabilitas, dan alat *stress testing*.

## 1. ASCII Diagram Topologi Modular 3-Tier

Arsitektur sistem dibagi menjadi 3 lapisan independen namun terintegrasi melalui *Docker network* internal:

```text
+---------------------------------------------------------------------------------------+
|                                    USER REQUESTS                                      |
+---------------------------------------------------------------------------------------+
                                        |
                                        v
+---------------------------------------------------------------------------------------+
|  [Tier 3] Stress Harness (Profil: `stress`)                                           |
|  Container: Grafana k6                                                                |
|  Fungsi: Membanjiri endpoint Rust dengan jutaan RPS tanpa latensi GC.                 |
+---------------------------------------------------------------------------------------+
                                        | (HTTP/gRPC Load)
                                        v
+---------------------------------------------------------------------------------------+
|  RUST RUNTIME (Host / Container)                                                      |
|  - Tokio Async Runtime (Thread Pool)                                                  |
|  - Axum Web Server (HTTP/1.1 & HTTP/2)                                                |
|  - OpenTelemetry Tracing Layer                                                        |
|  - Connection Pool (SQLx / bb8)                                                       |
+---------------------------------------------------------------------------------------+
         | (SQL / Redis Cmds)                           | (OTLP gRPC/HTTP Spans)
         v                                              v
+---------------------------------------------------+ +---------------------------------+
|  [Tier 1] Core Dependencies (Default)             | | [Tier 2] Telemetry (Profil:     |
|  - PostgreSQL (Persistent State)                  | |   `telemetry`)                  |
|  - Valkey / Redis (L1/L2 Cache)                   | | - OTel Collector (Receiver)     |
|                                                   | | - Prometheus (Metrics Storage)  |
|  Fungsi: Menjalankan kebutuhan mutlak runtime     | | - Loki (Log Aggregation)        |
|  aplikasi agar dapat beroperasi secara fungsional.| | - Grafana (Dashboards)          |
+---------------------------------------------------+ +---------------------------------+
```

## 2. Konfigurasi Manifes Nyata (Tanpa Placeholders)

Berikut adalah contoh `docker-compose.yml` yang memenuhi kriteria 3-Tier Modular Topology:

```yaml
version: '3.8'

x-logging: &default-logging
  driver: "json-file"
  options:
    max-size: "20m"
    max-file: "5"

services:
  # ---------------------------------------------------------
  # TIER 1: CORE DEPENDENCIES (Selalu aktif secara default)
  # ---------------------------------------------------------
  postgres:
    image: postgres:16-alpine
    container_name: core-postgres
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-rust_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-rust_pass}
      POSTGRES_DB: ${POSTGRES_DB:-rust_db}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-rust_user}"]
      interval: 5s
      timeout: 5s
      retries: 5
    logging: *default-logging

  valkey:
    image: valkey/valkey:7.2-alpine
    container_name: core-valkey
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    logging: *default-logging

  # ---------------------------------------------------------
  # TIER 2: TELEMETRY (Diaktifkan dengan `docker compose --profile telemetry up`)
  # ---------------------------------------------------------
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.95.0
    container_name: telemetry-otel
    profiles: ["telemetry"]
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes:
      - ./otel-config.yaml:/etc/otelcol-contrib/config.yaml
    ports:
      - "4317:4317" # OTLP gRPC receiver
      - "4318:4318" # OTLP HTTP receiver
    logging: *default-logging

  prometheus:
    image: prom/prometheus:v2.50.1
    container_name: telemetry-prometheus
    profiles: ["telemetry"]
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    logging: *default-logging

  grafana:
    image: grafana/grafana:10.3.3
    container_name: telemetry-grafana
    profiles: ["telemetry"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
    logging: *default-logging

  # ---------------------------------------------------------
  # TIER 3: STRESS HARNESS (Diaktifkan dengan `docker compose --profile stress up`)
  # ---------------------------------------------------------
  k6:
    image: grafana/k6:0.49.0
    container_name: stress-k6
    profiles: ["stress"]
    volumes:
      - ./scripts:/scripts
    command: run /scripts/k6-zero-alloc.js
    environment:
      - TARGET_URL=${TARGET_URL:-http://host.docker.internal:8080}
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  postgres_data:
```

### Integrasi OpenTelemetry di Rust

Di sisi aplikasi Rust, kita memerlukan inisialisasi OTLP exporter untuk mengirimkan trace secara mulus ke `otel-collector` yang berjalan di Tier 2:

```rust
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{trace::{self, Sampler}, Resource};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Registry};

pub fn init_telemetry() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Konfigurasi OTLP gRPC Exporter
    let exporter = opentelemetry_otlp::new_exporter()
        .tonic()
        .with_endpoint(std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or_else(|_| "http://localhost:4317".to_string()));

    // 2. Konfigurasi Tracer Pipeline
    let tracer = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(exporter)
        .with_trace_config(
            trace::config()
                .with_sampler(Sampler::AlwaysOn)
                .with_resource(Resource::new(vec![
                    KeyValue::new("service.name", "rust-axum-core"),
                    KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                ])),
        )
        .install_batch(opentelemetry_sdk::runtime::Tokio)?;

    // 3. Setup Tracing Subscriber Layer
    let telemetry_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    
    // 4. Integrasi dengan log lokal (stdout) sebagai fallback/debug
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(false)
        .without_time();

    Registry::default()
        .with(telemetry_layer)
        .with(fmt_layer)
        .try_init()?;

    Ok(())
}
```

### Skrip Stress Test k6 (`scripts/k6-zero-alloc.js`)

Tier 3 menggunakan Grafana k6 untuk pengujian beban ekstrim. Script ini dikalibrasi untuk memastikan latensi pada persentil 99 berada di bawah 10ms.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  discardResponseBodies: true, // Optimasi zero-alloc untuk klien k6
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: 500,
      duration: '30s',
    },
  },
  thresholds: {
    // Kriteria keberhasilan: p(99) harus < 10ms
    http_req_duration: ['p(99)<10'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const url = __ENV.TARGET_URL || 'http://host.docker.internal:8080/api/v1/health';
  const res = http.get(url);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
```

## 3. Analisis Trade-off

Pendekatan Modular 3-Tier memiliki pro dan kontra yang harus dipahami oleh setiap arsitek Rust.

### Kelebihan
1. **Isolasi Beban CPU/Memori:** Memisahkan beban *telemetry* (Tier 2) dan *stress test* (Tier 3) dari core database/cache (Tier 1) mencegah anomali performa. Seringkali, OTel collector atau Grafana k6 akan memakan banyak CPU; jika dicampur tanpa profil, akan merusak representasi performa database.
2. **Kecepatan Boot Lokal (Zero-Friction DX):** Developer yang hanya ingin menguji *unit tests* atau *logic* sederhana cukup menjalankan profil *default* (Tier 1). Ini menghemat waktu boot kontainer dan menghindari pemborosan RAM lokal dari komponen *telemetry* yang tidak terpakai.
3. **Reproduktibilitas Lingkungan Production:** Dengan profil yang terdefinisi dengan jelas, developer dapat memproduksi anomali latensi yang terjadi di *production* secara lokal dengan me-*recreate* kondisi tersebut (misal: menyalakan Tier 2 dan Tier 3 sekaligus), membuat simulasi jaringan dan *bottleneck* sangat akurat.

### Kekurangan
1. **Kompleksitas Manajemen Konfigurasi Ekstra:** Developer harus memelihara lebih dari sekadar `docker-compose.yml`. File seperti `otel-config.yaml`, `prometheus.yml`, dan *script* k6 harus dijaga agar tetap sinkron dengan perubahan *endpoint* atau format metrik aplikasi Rust.
2. **Kurva Belajar yang Lebih Curam:** Anggota tim yang belum terbiasa dengan OpenTelemetry dan konsep profil Docker (`--profile`) akan kebingungan jika tidak membaca dokumentasi yang disediakan.
3. **Beban Overhead I/O pada Tier 2 (Telemetry):** Mengekspor *traces* 100% (Sampler::AlwaysOn) secara lokal dapat membanjiri *network socket* lokal dan I/O *disk* jika menggunakan SSD pelan, terutama saat *stress testing* di Tier 3 sedang berjalan, yang mungkin mendistorsi hasil k6.

## 4. Anti-Patterns Kritis

### ❌ Salah (Anti-Pattern 1): Monolithic Compose File Tanpa Profil
Menggabungkan semuanya tanpa mendefinisikan `profiles: ["telemetry"]` atau `profiles: ["stress"]`. Akibatnya, setiap kali developer menjalankan `docker compose up`, mereka akan menjalankan k6 (yang akan langsung membombardir *endpoint*) dan *telemetry stack* yang berat.
**Mengapa Fatal:** Membuat laptop developer *hang*, menghabiskan *battery*, dan merusak *developer experience* (DX) karena *boot time* menjadi sangat lambat.

### ❌ Salah (Anti-Pattern 2): Hardcoded Secrets dan Endpoint
Menulis `POSTGRES_PASSWORD: supersecret` langsung di dalam manifes, atau me-*hardcode* endpoint OTLP dalam kode Rust `with_endpoint("http://192.168.1.5:4317")`.
**Mengapa Fatal:** Saat kode di-push ke CI/CD atau repositori publik, *credential* langsung bocor. Selain itu, mengubah lingkungan (misal dari lokal ke *staging*) akan memerlukan kompilasi ulang (recompile) kode Rust, yang merusak prinsip "Build Once, Run Anywhere". Selalu gunakan lingkungan berbasis variabel dengan *fallback* aman (`${ENV_VAR:-fallback}`).

## 5. Production Edge Cases

Arsitektur ini, meskipun tangguh, akan menghadapi batasan fisika saat ditekan ke ekstrem. Berikut adalah kasus-kasus batas (Edge Cases) di *production* dan saat simulasi lokal:

1. **Jemalloc Allocator Heap Limits dalam Docker cgroups v2:**
   Secara default, Rust menggunakan *system allocator*. Di bawah beban ekstrem k6 (jutaan RPS), fragmentasi memori akan meningkat tajam. Jika mengganti *allocator* ke `jemalloc` untuk efisiensi, dan menjalankan aplikasi Rust di dalam kontainer dengan batasan RAM (cgroups v2), `jemalloc` terkadang enggan mengembalikan memori ke OS (`MADV_DONTNEED`). Hal ini bisa memicu `OOMKilled` oleh kernel Linux meskipun aplikasi tampaknya tidak memakan RAM sebanyak batasnya. *Mitigasi:* Konfigurasi `MALLOC_CONF=background_thread:true,dirty_decay_ms:5000` wajib disuntikkan.

2. **Tokio Thread Runtime Stalling di Konfigurasi CPU Rendah (1 Core):**
   Jika aplikasi Rust dijalankan di lingkungan dengan batasan 1 vCPU (misal: simulasi terburuk), *multi-threaded runtime* Tokio dapat mengalami *stalling* atau *thread contention*. *Task* asinkron yang melakukan I/O ke Postgres (Tier 1) atau mengekspor *traces* ke OTel (Tier 2) mungkin saling memblokir jika salah satu *task* melakukan CPU-bound work (misal: enkripsi password bcrypt) tanpa di-*offload* ke `spawn_blocking`. *Mitigasi:* Pemantauan ketat melalui *tracing spans* dan *Grafana metrics* diperlukan untuk melacak `tokio_scheduler_lag`.

3. **Port Exhaustion dan TIME_WAIT pada k6 (Tier 3):**
   Saat menggunakan k6 untuk membanjiri aplikasi Rust lokal, kernel sistem (khususnya *TCP stack*) dapat kehabisan *ephemeral ports*. Ratusan ribu koneksi yang ditutup dengan cepat akan masuk ke dalam *state* `TIME_WAIT`. Jika batas port habis (`EADDRNOTAVAIL`), *stress test* akan melaporkan error I/O seolah-olah aplikasi Rust gagal, padahal OS yang sudah menyerah. *Mitigasi:* Dalam skenario sesungguhnya, *tuning* parameter kernel `net.ipv4.tcp_tw_reuse = 1` pada kontainer *stress test* dan *host* sangat direkomendasikan.

Penerapan topologi Modular 3-Tier ini adalah standar *non-negotiable* untuk memastikan seluruh proyek Rust baru di ekosistem ini bermula dari pondasi baja (Titanium-grade foundation).
