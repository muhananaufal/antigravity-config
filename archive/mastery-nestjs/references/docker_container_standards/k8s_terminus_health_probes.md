# K8s Terminus Health Probes: Kebugaran Sistem NestJS

## Pendahuluan: Nadi Arsitektur Orkestrasi Tersinkronisasi

Dalam lingkungan terdistribusi Cloud Native tinggi seperti Kubernetes (K8s) atau AWS ECS, kelangsungan hidup beban kerja dipertaruhkan dari keandalan mekanisme pemantauan (Health Probes). Aplikasi NestJS yang tidak responsif, tersedak RAM (OOM), atau kehilangan pijakan koneksi dengan basis data utama akan merusak integritas *Load Balancer*. Paket standar `@nestjs/terminus` menyediakan solusi *endpoint* pemantau kebugaran komprehensif, memungkinkan perancang orkestrasi untuk merestart Pod yang sekarat (*liveness*) dan mencegah pendistribusian *traffic* HTTP ke kontainer yang belum sanggup merespons permintaan (*readiness*).

## Diagram ASCII: Terminus Health Check Tree Propagation

```ascii
[ Ingress Controller / Kubelet K8s ]
                |
     +----------+-----------+
     | HTTP GET /health/... |
     +----------+-----------+
                |
                v
  [ NestJS Terminus HealthController ]
                |
                +-- [ MemoryHeapHealthIndicator ] (Memastikan RAM < Threshold OOM)
                |
                +-- [ TypeOrmHealthIndicator ] (Ping Database Utama: PostgreSQL)
                |
                +-- [ RedisHealthIndicator ] (Ping Microservice Caching)
                |
                v
       [ Kesimpulan Status ] ---> 200 OK (Pod Siap Melayani HTTP Request Baru)
                             ---> 503 Service Unavailable (Kubelet memotong trafik Ingress Pod)
```

## Implementasi Blueprint Liveness dan Readiness Probes

Kita memisahkan dua fungsi kritikal K8s:
- **Liveness (`/health/liveness`)**: Menandakan aplikasi sanggup merespons eksekusi utas utama Node.js dan tidak *deadlock*. Jika ini gagal, K8s akan ME-RESTART Pod (SIGTERM lalu dibunuh).
- **Readiness (`/health/readiness`)**: Menandakan konektivitas absolut (DB dan Redis terhubung). Jika ini gagal, Pod DIBIARKAN HIDUP, namun K8s MENGHAPUS IP Pod tersebut dari Load Balancer Service.

### Modul Health Terminus di NestJS

```typescript
import { Controller, Get, Logger } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
  HealthCheckResult,
} from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
  ) {}

  /**
   * Liveness Probe: Menentukan apakah utas aplikasi macet.
   * Cek RAM Heap yang cepat, tak membebankan koneksi TCP keluar.
   */
  @Get('liveness')
  @HealthCheck()
  checkLiveness(): Promise<HealthCheckResult> {
    return this.health.check([
      // Peringatan jika Heap RAM melampaui 300MB (untuk Pod mikro)
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
    ]);
  }

  /**
   * Readiness Probe: Menentukan apakah aplikasi bisa melayani database dan logika berat.
   */
  @Get('readiness')
  @HealthCheck()
  checkReadiness(): Promise<HealthCheckResult> {
    return this.health.check([
      // Lakukan ping sederhana ke database. Jika gagal resolusi > 503 HTTP Code dikembalikan.
      () => this.db.pingCheck('database', { timeout: 3000 }),
    ]);
  }
}
```

## Anti-Patterns Kritis & Praktik Terbaik

### ❌ Anti-Pattern 1: Menggabungkan Liveness dan Readiness menjadi Satu
Mengeksekusi *ping* ke koneksi Database pada `liveness` adalah kebodohan paling populer. Jika database utama sedang mati, Kubelet K8s akan merestart SEMUA instance Pod NestJS secara bersamaan karena mereka gagal memverifikasi rute *liveness*. Ini disebut badai restart berantai (*restart storm/cascading failure*).
```typescript
// ❌ SALAH: Jika DB down sementara, K8s akan me-restart pod aplikasi ini!
@Get('health') // Digunakan untuk Liveness Probe di YAML K8s
checkAll() {
  return this.health.check([ () => this.db.pingCheck('db') ]);
}
```

### ✅ Solusi 1: Dekopel Liveness dan Readiness
Pastikan **Liveness** HANYA memeriksa komponen internal aplikasi itu sendiri (utas Node.js berjalan, tidak ada kebocoran RAM berlebih). Serahkan koneksi eksternal ke probe **Readiness** sehingga ketika server Basis Data turun, pod Node.js kita hanya berhenti menerima permintaan tanpa merestart dirinya sendiri.

### ❌ Anti-Pattern 2: Cek Kebugaran Membebani Kinerja (Heavy Ping)
Menjalankan kueri seleksi mendalam ke tabel tabel raksasa untuk memverifikasi kesehatan koneksi mematikan performa secara linier.
```typescript
// ❌ SALAH: Mengeksekusi kueri mahal pada setiap denyut probe (10 detik sekali!)
await queryBuilder.select('COUNT(*)').from('users_logs_table').execute();
```

### ✅ Solusi 2: Cek Kebugaran Ringan (Shallow Ping)
Gunakan `SELECT 1` (default internal di Terminus) yang dieksekusi secepat kedipan mata dan tidak mencemari memori internal pangkalan data RDBMS.

## Analisis Trade-Off

### Kelebihan
1. **Kestabilan Ketersediaan Layanan (Zero-Downtime):** Proses skalasi turun-naik (HPA) lebih responsif dan mulus karena trafik hanya dipandu ke node yang benar-benar siap dan bersedia melayani klien 100%.
2. **Isolasi Kegagalan Jaringan Inter-Service:** Jika salah satu sistem penopang (misal, broker pesan Kafka) membeku, probe `readiness` memotong sirkulasi trafik API ini secara elegan sehingga pengguna akhir cepat mendapatkan tanggapan (circuit broken/503), tidak membiarkan permintaan menggantung berlarut-larut.
3. **Standarisasi Pengukuran Metrik:** *Endpoint* `/health` ini mengeluarkan status berbasis JSON murni yang mudah diakses dan diamati langsung oleh perangkat pemantau pihak ketiga (Datadog, Prometheus, New Relic).

### Kekurangan
1. **DDoS Mandiri (Self-DDoS):** Interval pengujian yang terlalu tinggi (contoh: 1 detik sekali), memancing letusan beban kejut di koneksi pangkalan data pusat, yang mungkin justru memperburuk keadaaan jika diimplementasikan pada lingkungan yang memiliki 500+ Pod paralel.
2. **Ketergantungan State Tersembunyi:** Aplikasi NestJS bisa memunculkan nilai 200 OK di Liveness namun secara fungsional logika di layer Domain sedang tidak utuh (misal konfigurasi rotasi kunci JWT gagal di-load), di mana Terminus tidak selalu menjangkaunya kecuali di program indikator kustom (Custom Indicator).
3. **Membocorkan Topologi Internal:** Mengaktifkan detail pengungkapan (secara bawaan, jika Kebugaran Gagal Terminus akan meludah error spesifik misal, `redis: connection refused`) ke publik adalah cacat keamanan mematikan; titik akhir ini wajib diblok dari *gateway* *Ingress* luar Internet publik dan hanya dibuka buat alamat IP *cluster internal* (Kubelet).

## Production Edge Cases

1. **Timeout Jaringan Keras:** Ketika terjadi latensi asimetris di VPC, ping TypeORM ke Postgres bisa tertunda lebih dari default *timeout* K8s Probe (1 detik). NestJS memancarkan 503, dan Pod diasingkan keliru. Solusi: Tingkatkan *timeout* *Terminus* ping maupun konfigurasi `timeoutSeconds` Kubernetes YAML minimum menjadi 3-5 detik.
2. **Startup Probe Lambat:** Terutama pada proses Boot NestJS di atas Drizzle atau Prisma yang mungkin melaksanakan migrasi di inisialisasi awal. K8s Readiness akan merestart kontainer karena kelamaan menunggu. Anda WAJIB menggunakan perlindungan `startupProbe` K8s yang memiliki durasi kegagalan jauh lebih longgar.
3. **Disk Pressure (Kebocoran Logging TTY):** Beberapa aplikasi monolitik terjebak menghasilkan berkas sementera dalam kontainer (upload file biner sebelum memindah ke S3). Selama `/tmp/` penuh, app berhenti fungsi namun Liveness Probe lolos 200 OK karena API tidak memeriksa Disk! Wajib ciptakan `DiskHealthIndicator` memantau ruang persentase `/`.

## Unit Test: Memverifikasi Health Controller Readiness

Berikut implementasi Test Suite memastikan modul `Terminus` bertindak tanpa cela jika terjadi pembusukan di koneksi TypeORM.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthCheckService, TypeOrmHealthIndicator, MemoryHealthIndicator, HealthCheckError } from '@nestjs/terminus';

describe('HealthController - K8s Readiness Probes', () => {
  let controller: HealthController;
  let healthCheckService: HealthCheckService;
  let typeOrmIndicator: TypeOrmHealthIndicator;

  beforeEach(async () => {
    // Mock the Health Check Core Module
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: { check: jest.fn((indicators) => Promise.all(indicators.map((i: any) => i()))) },
        },
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck: jest.fn() },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: { checkHeap: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    healthCheckService = module.get<HealthCheckService>(HealthCheckService);
    typeOrmIndicator = module.get<TypeOrmHealthIndicator>(TypeOrmHealthIndicator);
  });

  it('harus membentak (throw) jika database utama putus di rute Readiness', async () => {
    // Simulasi putusnya koneksi jaringan TypeORM Database Server
    const failureResult = new HealthCheckError('Health check failed', { database: { status: 'down' }});
    jest.spyOn(typeOrmIndicator, 'pingCheck').mockRejectedValueOnce(failureResult);

    await expect(controller.checkReadiness()).rejects.toThrow(HealthCheckError);
    expect(typeOrmIndicator.pingCheck).toHaveBeenCalledWith('database', { timeout: 3000 });
  });

  it('harus menyetujui (200 OK) rute Readiness jika pangkalan data online sehat', async () => {
    // Simulasi koneksi sehat TypeORM
    jest.spyOn(typeOrmIndicator, 'pingCheck').mockResolvedValueOnce({ database: { status: 'up' }});

    const result = await controller.checkReadiness();
    expect(result).toEqual([{ database: { status: 'up' } }]);
  });
});
```
