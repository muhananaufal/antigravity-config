# Zero-Touch Greenfield Bootstrap: Modular 3-Tier Container Topology

> **Berlaku:** Go 1.21+ · Docker Compose v2 · **Lihat juga:** `devops_control_planes/docker_container_go.md` · `testing_quality/testcontainers_integration.md` · `observability_resilience/health_check_readiness.md` · `db_sqlc/connection_pool_tuning.md`

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

File utama ini menyatukan semua kontainer dengan pemisahan profil.

> ### ⚠️ Dua hal yang harus diluruskan sebelum menyalin berkas ini
>
> **1. `${VAR:-nilai}` BUKAN cara menghindari hardcoded secret — ia ADALAH hardcoded secret.**
>
> Bentuk `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-secret123}` menuliskan
> `secret123` **ke dalam berkas yang masuk git**. Itu kredensial hardcode
> dengan langkah tak-langsung satu lapis, dan ia melanggar aturan "zero
> placeholder, rahasia lewat `.env` + validasi schema" yang dipakai seluruh
> korpus ini. Yang lebih berbahaya: default yang bekerja membuat tidak ada
> yang pernah menyetel `.env`, sehingga `secret123` menjadi kata sandi
> sungguhan di setiap mesin tim — dan setiap orang tahu isinya.
>
> Gunakan `${VAR:?pesan}` — Compose **menolak start** bila variabelnya tidak
> ada, dengan pesan yang memberi tahu apa yang harus disetel. Tidak ada
> default yang bisa bocor, dan kegagalannya terjadi di detik pertama, bukan
> di produksi.
>
> **2. `"5432:5432"` mengikat ke SELURUH antarmuka jaringan, bukan localhost.**
>
> Docker juga menulis aturan iptables-nya sendiri yang **melewati `ufw` dan
> `firewalld`** — jadi firewall host yang Anda kira melindungi mesin ini tidak
> berlaku untuk port yang dipublikasikan Docker. Di jaringan kantor atau wifi
> kafe, stack ini mengekspos Postgres, Grafana, dan Redis ke satu segmen
> jaringan penuh.
>
> Prefiks `127.0.0.1:` pada setiap `ports` yang tidak benar-benar perlu
> dijangkau dari luar mesin.

```yaml
# TIDAK ADA `version:` -- kunci itu obsolete di Compose V2 dan hanya
# menghasilkan peringatan "the attribute `version` is obsolete".

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
      - "127.0.0.1:8080:8080"
      - "127.0.0.1:2112:2112"
    environment:
      - APP_ENV=development
      - DB_DSN=postgres://${POSTGRES_USER:?setel di .env}:${POSTGRES_PASSWORD:?setel di .env}@postgres:5432/${POSTGRES_DB:?setel di .env}?sslmode=disable
      - REDIS_ADDR=redis:6379
      - REDIS_PASSWORD=${REDIS_PASSWORD:?setel di .env}
      - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
    # HEALTHCHECK PADA `api` BUKAN OPSIONAL DI SINI.
    #
    # Tanpa ini, `depends_on` milik k6 di Tier 3 TIDAK BISA memakai
    # `condition: service_healthy` -- yang justru diwajibkan Anti-Pattern 2
    # berkas ini sendiri. Yang tersisa hanya `depends_on` telanjang, yang
    # hanya menunggu container START, sehingga k6 mulai membanjiri API yang
    # belum selesai memigrasi DB: persis 502/connection refused yang
    # anti-pattern itu ada untuk mencegahnya.
    #
    # Perintahnya harus cocok dengan base image runtime Anda. Bila
    # distroless (lihat `devops_control_planes/docker_container_go.md`),
    # tidak ada wget/curl/sh -- binernya sendiri yang jadi health checker.
    healthcheck:
      test: ["CMD", "/app", "-healthcheck"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 15s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    deploy:
      resources:
        limits: { memory: 512M, cpus: "1.0" }
    restart: unless-stopped
    logging: *default-logging
    networks:
      - app_network

  postgres:
    image: postgres:16-alpine
    environment:
      # `:?` bukan `:-`. Tanpa .env, Compose menolak start dengan pesan yang
      # menyebut variabelnya -- alih-alih diam-diam memakai kata sandi yang
      # tertulis di repo dan diketahui semua orang.
      - POSTGRES_USER=${POSTGRES_USER:?setel di .env}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?setel di .env}
      - POSTGRES_DB=${POSTGRES_DB:?setel di .env}
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      # -d WAJIB: tanpa nama database, pg_isready menguji koneksi ke database
      # bawaan yang senama dengan user, dan bisa melaporkan "siap" untuk
      # instance yang belum selesai membuat database aplikasi.
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
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
    # TANPA BARIS INI, REDIS BERJALAN TANPA AUTENTIKASI SAMA SEKALI --
    # dan itu jauh lebih berbahaya daripada kata sandi lemah pada Postgres,
    # karena tidak ada satu pun lapisan yang menghalangi siapa pun yang bisa
    # menjangkau portnya.
    command: ["valkey-server", "--requirepass", "${REDIS_PASSWORD:?setel di .env}"]
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      # valkey-cli, bukan redis-cli: image ini memang Valkey, jadi jangan
      # bergantung pada symlink kompatibilitas yang bisa hilang antar rilis.
      # `| grep PONG` juga penting -- `ping` polos bisa keluar dengan status 0
      # sementara balasannya "LOADING" saat server masih memuat dump.
      test: ["CMD-SHELL", "valkey-cli -a \"$$REDIS_PASSWORD\" ping | grep -q PONG"]
      interval: 5s
      timeout: 3s
      retries: 5
    environment:
      - REDIS_PASSWORD=${REDIS_PASSWORD:?setel di .env}
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
      - ./infra/telemetry/otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro
    ports:
      - "127.0.0.1:4317:4317" # OTLP gRPC
      - "127.0.0.1:4318:4318" # OTLP HTTP
    # memory_limiter di config collector memakai limit_mib: 1500. Angka itu
    # hanya bermakna bila container-nya MEMANG punya batas -- kalau tidak, ia
    # sekadar angka yang tidak merujuk apa pun.
    deploy:
      resources:
        limits: { memory: 2G }
    networks:
      - app_network

  prometheus:
    image: prom/prometheus:v2.50.1
    profiles: ["telemetry"]
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      # 15d DENGAN scrape_interval 5s ADALAH BOM DISK DI LAPTOP -- dan justru
      # itu yang dikeluhkan bagian "Kekurangan #3" berkas ini sendiri
      # ("akumulasi data ... hingga puluhan Gigabyte"). Untuk stack lokal,
      # retensi diukur dalam jam. Naikkan hanya bila memang sedang menyelidiki
      # sesuatu yang butuh sejarah panjang.
      - '--storage.tsdb.retention.time=${PROM_RETENTION:-24h}'
      - '--storage.tsdb.retention.size=2GB'
    ports:
      - "127.0.0.1:9090:9090"
    volumes:
      - ./infra/telemetry/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    networks:
      - app_network

  grafana:
    image: grafana/grafana:10.3.3
    profiles: ["telemetry"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:?setel di .env}
      # Anonymous auth + port yang terbuka ke seluruh antarmuka = dasbor
      # internal yang bisa dibaca siapa pun di segmen jaringan yang sama.
      # Aktifkan hanya bila portnya memang terikat ke 127.0.0.1 saja.
      - GF_AUTH_ANONYMOUS_ENABLED=${GRAFANA_ANON:-false}
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      - prometheus
    volumes:
      - grafana_data:/var/lib/grafana
    networks:
      - app_network

  # LOKI TIDAK MENERIMA APA PUN TANPA PENGIRIM LOG.
  #
  # Versi sebelumnya menjalankan Loki sendirian sementara `logging: json-file`
  # menulis log ke disk host. Tidak ada satu byte pun yang sampai ke Loki --
  # ia hanya memakan RAM sambil digambar di diagram sebagai "Log Aggregation".
  #
  # `promtail` di bawah yang membuat kotak itu benar. Alternatif tanpa
  # container tambahan: pasang logging driver Loki
  # (`logging: { driver: loki, options: { loki-url: ... } }`), tetapi driver
  # itu adalah plugin yang harus dipasang lebih dulu di daemon Docker --
  # ketergantungan tersembunyi yang tidak cocok untuk stack "zero-touch".
  loki:
    image: grafana/loki:2.9.4
    profiles: ["telemetry"]
    command: -config.file=/etc/loki/local-config.yaml
    ports:
      - "127.0.0.1:3100:3100"
    networks:
      - app_network

  promtail:
    image: grafana/promtail:2.9.4
    profiles: ["telemetry"]
    command: -config.file=/etc/promtail/config.yaml
    volumes:
      - ./infra/telemetry/promtail.yaml:/etc/promtail/config.yaml:ro
      # Membaca log container dari daemon host. `:ro` -- promtail tidak pernah
      # perlu menulis ke sini.
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    depends_on:
      - loki
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
      - ./infra/stress/k6-stress.js:/scripts/k6-stress.js:ro
    networks:
      - app_network
    depends_on:
      # `- api` telanjang -- bentuk sebelumnya -- hanya menunggu container
      # START. k6 lalu mulai membanjiri API yang masih memigrasi database, dan
      # hasil ujinya penuh 502/connection refused: persis kegagalan yang
      # Anti-Pattern 2 di bawah ada untuk mencegahnya, di berkas yang sama.
      #
      # Bentuk ini hanya bisa ditulis karena `api` sekarang punya healthcheck.
      api:
        condition: service_healthy

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
    # `verbosity: detailed` MENCETAK SETIAP SPAN DAN SETIAP TITIK METRIK.
    #
    # Di stack yang juga memuat generator beban (Tier 3), itu bom log: k6
    # dengan 100 VU menghasilkan ribuan span per detik, dan seluruhnya
    # dicetak ke stdout collector. Itu persis mekanisme kegagalan yang
    # diuraikan Edge Case 3 di bawah -- hanya sumbernya bukan aplikasi Anda,
    # melainkan collector-nya sendiri.
    #
    # `basic` mencetak ringkasan hitungan saja. Naikkan ke `detailed` hanya
    # saat sedang men-debug pipeline, lalu turunkan lagi.
    verbosity: ${OTEL_DEBUG_VERBOSITY:-basic}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      # HANYA `debug` berarti TRACE TIDAK DISIMPAN DI MANA PUN -- ia dicetak
      # ke stdout collector lalu hilang. Diagram di atas menggambar Tier 2
      # sebagai "Receive Traces", tetapi tanpa backend trace, satu-satunya
      # cara membaca trace adalah `docker compose logs otel-collector`.
      #
      # Tambahkan Tempo (atau Jaeger) bila trace memang mau dipakai; bila
      # tidak, hapus pipeline trace-nya sekalian agar tidak ada yang mengira
      # tracing sudah terpasang.
      exporters: [otlp/tempo, debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, debug]
```

Bagian `otlp/tempo` di atas mengacu pada exporter berikut — tambahkan ke blok `exporters`, dan tambahkan servis `tempo` ke profil `telemetry`:

```yaml
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }   # jaringan Compose lokal; JANGAN di produksi
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

Simpan di `./infra/stress/k6-stress.js`.

> **Dua koreksi terhadap versi sebelumnya, dan keduanya menentukan apakah skrip ini bermakna.**
>
> **1. Menembak `/health` tidak mengukur apa pun tentang aplikasi Anda.**
> Endpoint itu membalas konstanta tanpa menyentuh database, cache, maupun satu
> baris logika bisnis. Yang terukur adalah kecepatan stack HTTP Go — yang
> memang selalu cepat. Skrip seperti itu menghasilkan p99 hijau yang meyakinkan
> sambil membiarkan N+1 query, pool koneksi yang terlalu kecil, dan lock
> contention lolos sepenuhnya. Beban harus menyentuh jalur yang benar-benar
> dipakai pengguna.
>
> **2. `check()` TIDAK BISA menggagalkan build.** Ini jebakan k6 yang paling
> sering menggigit: `check` yang gagal hanya menaikkan penghitung dan dicetak
> di ringkasan — exit code k6 tetap **0**. Hanya `thresholds` yang menentukan
> exit code. Gerbang CI yang bersandar pada `check` selalu lulus.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 50 },   // Ramp-up ke 50 VU
    { duration: '20s', target: 100 }, // Tahan 100 VU
    { duration: '5s', target: 0 },    // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<30', 'p(99)<50'],
    http_req_failed: ['rate<0.01'],

    // BARIS INI yang membuat check() ikut menentukan exit code.
    // Tanpanya, seluruh check bisa gagal dan k6 tetap keluar dengan status 0.
    checks: ['rate>0.99'],

    // Ambang per-endpoint. Tanpa pemisahan ini, satu endpoint yang cepat
    // (/health) menutupi satu endpoint yang lambat di dalam agregat p99 yang
    // sama -- dan justru endpoint lambat itulah yang ingin ditemukan.
    'http_req_duration{endpoint:health}': ['p(99)<20'],
    'http_req_duration{endpoint:daftar_produk}': ['p(99)<200'],
  },
};

export default function () {
  // Endpoint sepele: hanya untuk memastikan proses hidup.
  const sehat = http.get('http://api:8080/health', {
    tags: { endpoint: 'health' },
  });
  check(sehat, { 'health 200': (r) => r.status === 200 });

  // JALUR YANG SEBENARNYA DIUKUR: menyentuh DB dan cache, seperti pengguna.
  // Ini yang menemukan N+1 query, pool koneksi kurang, dan lock contention.
  const daftar = http.get('http://api:8080/api/v1/produk?limit=20', {
    tags: { endpoint: 'daftar_produk' },
  });
  check(daftar, {
    'daftar produk 200': (r) => r.status === 200,
    'daftar produk berisi data': (r) => {
      try {
        return JSON.parse(r.body).items?.length > 0;
      } catch {
        // Body bukan JSON -- misalnya halaman galat proxy. Tanpa penjaga ini,
        // JSON.parse melempar dan iterasi VU-nya berhenti, sehingga beban
        // yang sebenarnya diterapkan lebih kecil dari yang dilaporkan.
        return false;
      }
    },
  });

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

**Dan syarat yang membuat aturan ini bisa dipakai:** `condition: service_healthy` **hanya sah bila servis yang dirujuk punya `healthcheck`**. Menuliskannya terhadap servis tanpa healthcheck membuat Compose menolak konfigurasinya. Karena itu `api` di manifes atas wajib punya healthcheck sendiri — tanpa itu, k6 hanya bisa memakai `depends_on: [api]` telanjang, yang menunggu container *start* dan bukan *siap*, yaitu tepat kegagalan yang anti-pattern ini lawan.

### Anti-Pattern 3: Kredensial Default lewat `${VAR:-nilai}`

❌ **SALAH:** `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-secret123}`. Kata sandinya tertulis di berkas yang masuk git. Lebih buruk, karena defaultnya *bekerja*, tidak ada yang pernah menyetel `.env` — sehingga `secret123` menjadi kata sandi sungguhan di setiap mesin tim, dan setiap orang tahu isinya.

✅ **BENAR:** `${POSTGRES_PASSWORD:?setel di .env}`. Compose menolak start dengan pesan yang menyebut variabel yang kurang. Tidak ada nilai yang bisa bocor, dan kegagalannya terjadi di detik pertama alih-alih menjadi temuan audit.

### Anti-Pattern 4: `ports` Tanpa Prefiks Alamat

❌ **SALAH:** `"5432:5432"`. Docker mengikat ke **seluruh antarmuka**, dan aturan iptables yang ditulisnya **melewati `ufw` dan `firewalld`** — firewall host yang Anda kira aktif tidak berlaku untuk port yang dipublikasikan Docker. Di wifi kafe atau jaringan kantor, ini mengekspos database ke satu segmen penuh.

✅ **BENAR:** `"127.0.0.1:5432:5432"`. Tetap bisa diakses `psql` di mesin sendiri, tidak bisa dijangkau siapa pun di luar. Hilangkan prefiksnya hanya untuk port yang memang harus dijangkau perangkat lain, dan hanya dengan sadar.

## 5. Production Edge Cases

Penerapan *topology* ini di produksi atau skala beban tinggi berpotensi menabrak batasan-batasan nyata, yaitu:

1. **Cardinality Explosion pada Label Prometheus Golang:**
   Secara default, instrumentasi Golang yang mengekspos metrik per route berisiko meledak jika label URL memuat ID dinamis (contoh: `/api/v1/user/123` di mana ID `123` terekam sebagai label path unik). Ini akan membunuh Prometheus karena kehabisan RAM. **Mitigasinya:** Selalu normalisasi path label di middleware Golang (mengubah `/user/123` menjadi `/user/{id}`).

2. **Kelelahan Soket (Socket Exhaustion) saat Eksekusi K6 Load Test:**
   Saat k6 mensimulasikan ribuan VUs (Virtual Users) ke kontainer Golang, host Docker bisa kehabisan ephemeral ports atau membentur batas koneksi maksimum *file descriptors*. Hal ini memunculkan error `dial tcp: lookup / address in use`. **Mitigasinya:** Menaikkan limit *file descriptors* pada *docker-daemon* (misal via sysctl `net.ipv4.ip_local_port_range`) dan memastikan setting *keep-alive* di Golang cukup panjang agar reusing socket lebih efisien.

3. **Loki OOM Kill Akibat Disk I/O Bottleneck:**
   Jika simulasi stress test sangat bising hingga memproduksi >10,000 log per detik, agent Docker yang mengirimkan log ke container Loki dapat mengalami antrean panjang, dan menyebabkan Loki kehabisan memori atau CPU throttling akibat lambatnya flush ke local disk. **Mitigasinya:** Konfigurasikan max-size pada logging driver (seperti contoh yaml di atas) dan gunakan chunking/batching pada Loki untuk mengurai beban *ingestion*.

## Kapan JANGAN Pakai Ini

- **Untuk proyek kecil.** Compose tiga tingkat lengkap dengan observability stack dan harness beban untuk skrip 100 baris adalah pelanggaran KISS yang nyata — dan biaya perawatannya dibayar setiap kali ada yang mencoba menjalankannya.
- **`depends_on` tanpa `condition: service_healthy`.** Container yang sudah "start" belum tentu menerima koneksi. Aplikasi akan gagal saat boot dengan galat koneksi yang tampak acak.
- **Bind mount untuk data yang penting.** Kepemilikan berkas dan izin berbeda antar host dan antar OS. Named volume menghindarkan seluruh kelas masalah ini.
- **Menyalin konfigurasi produksi ke Compose.** Compose adalah alat pengembangan lokal. Produksi punya orkestrator dengan semantik berbeda untuk health check, restart, dan jaringan.
- **Menjadikan seluruh stack sebagai syarat kontribusi.** Semakin berat stack lokalnya, semakin sering orang melewatinya — dan uji yang dilewati sama saja dengan uji yang tidak ada.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Aplikasi gagal saat start di CI | `condition` pada `depends_on` | Dependensi dianggap siap terlalu cepat |
| Berjalan di satu laptop, gagal di laptop lain | bind mount dan izin berkas | Ketergantungan pada tata letak host |
| Kontributor melewati uji lokal | waktu dan sumber daya untuk start | Stack terlalu berat |
| Perilaku beda antara Compose dan produksi | health check dan restart policy | Semantik orkestrator berbeda |
| Data hilang setelah `docker compose down` | volume yang dipakai | Data di bind mount atau anonymous volume |
| Layanan bisa dijangkau dari mesin lain | prefiks alamat pada `ports` | Port terikat 0.0.0.0; iptables Docker melewati ufw |
| Uji beban selalu hijau, produksi tetap lambat | endpoint yang ditembak k6 | Beban hanya menyentuh `/health` |
| Gerbang CI beban tidak pernah gagal | apakah ada threshold `checks` | `check()` tidak memengaruhi exit code k6 |
| Loki menyala tapi kosong | apakah ada pengirim log | Tidak ada promtail / logging driver Loki |

```bash
docker compose config                 # konfigurasi setelah interpolasi
                                      # WAJIB dijalankan: `:?` akan gagal di
                                      # sini bila .env belum lengkap

# Port yang benar-benar terekspos ke luar mesin. Apa pun yang tampil sebagai
# 0.0.0.0 dapat dijangkau seluruh segmen jaringan Anda -- termasuk yang
# dikira dilindungi ufw, karena Docker menulis aturan iptables-nya sendiri.
docker compose ps --format '{{.Service}}\t{{.Ports}}' | grep -v '127.0.0.1'

# Kredensial yang tidak sengaja tertulis di manifes
grep -nE ':-[A-Za-z0-9_.]{4,}\}' docker-compose.yml   # default `:-` = hardcode
docker compose ps --format json | jq -r '.[] | "\(.Service) \(.State) \(.Health)"'

# Health check yang benar-benar terpasang
docker inspect --format '{{.Name}} {{.State.Health.Status}}' $(docker compose ps -q)

# Waktu start seluruh stack: angka ini menentukan orang memakainya atau tidak
time docker compose up -d --wait
```
