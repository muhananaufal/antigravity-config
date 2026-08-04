# Zero-Downtime Hot-Reload Konfigurasi dari K8s ConfigMap/Secrets

## 1. Visi Arsitektur Hot-Reload (Top 1% Engineering)

Dalam ekosistem Kubernetes, mengubah environment variables memerlukan proses rolling restart pada Pod. Ini memicu latensi, cache invalidation, dan risiko down sementara (jitter). Pendekatan sultan adalah menyuntikkan K8s ConfigMap dan Secret sebagai **Volume Mounts** ke dalam Pod, kemudian membuat aplikasi NestJS mendengarkan event perubahan file pada volume tersebut via Inotify, lalu memperbarui konfigurasi di dalam Memory secara mulus dan aman tipe (Type-Safe), TANPA merestart container Node.js.

Teknik ini krusial untuk fitur toggles, rotasi token rahasia secara otomatis, penyesuaian limit rate limiter secara on-the-fly, dan perbaikan konfigurasi SLA dinamis tanpa interupsi.

## 2. Topologi Arsitektur Hot-Reload Volume

```text
+-----------------------------------------------------------+
| KUBERNETES NODE                                           |
|                                                           |
|  +--------------------+                                   |
|  | ConfigMap / Secret |                                   |
|  | (Kubelet Syncs)    |                                   |
|  +---------+----------+                                   |
|            | 1. Kubelet updates symlinks in volume        |
|            v                                              |
|  +-----------------------------------------------------+  |
|  | POD (NestJS App)                                    |  |
|  |   Volume Mount: /etc/config/appsettings.json        |  |
|  |                                                     |  |
|  |   +---------------------------------------------+   |  |
|  |   | fs.watch / chokidar                         |   |  |
|  |   | (Mendeteksi perubahan inodes/symlinks)      |   |  |
|  |   +----------------------+----------------------+   |  |
|  |                          | 2. File change event     |  |
|  |                          v                          |  |
|  |   +---------------------------------------------+   |  |
|  |   | DynamicConfigService (NestJS Provider)      |   |  |
|  |   | Atomic update of internal object state      |   |  |
|  |   +---------------------------------------------+   |  |
|  +-----------------------------------------------------+  |
+-----------------------------------------------------------+
```

## 3. Implementasi Kode NestJS TypeScript 5+

Berikut adalah provider `DynamicConfigService` dengan pendekatan Singleton murni dan event emitter untuk merotasi konfigurasi.

```typescript
// src/config/dynamic-config.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfiguration {
  featureFlags: {
    newPaymentGateway: boolean;
    maintenanceMode: boolean;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
}

@Injectable()
export class DynamicConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicConfigService.name);
  private configState: AppConfiguration;
  private readonly configPath: string;
  private watcher: fs.FSWatcher | null = null;
  private configChangeSubject = new Subject<AppConfiguration>();

  constructor() {
    this.configPath = process.env.DYNAMIC_CONFIG_PATH || '/etc/config/appsettings.json';
    this.configState = this.loadConfigSync();
  }

  public onModuleInit(): void {
    this.watchConfigVolume();
  }

  public onModuleDestroy(): void {
    if (this.watcher) {
      this.watcher.close();
    }
    this.configChangeSubject.complete();
  }

  /**
   * Mendapatkan konfigurasi terkini. Tidak pernah stale.
   */
  public getConfig(): AppConfiguration {
    return this.configState;
  }

  /**
   * Berlangganan jika servis lain butuh notifikasi instan.
   */
  public get configChanges$(): Observable<AppConfiguration> {
    return this.configChangeSubject.asObservable();
  }

  private loadConfigSync(): AppConfiguration {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.warn(`File config tidak ditemukan di ${this.configPath}. Menggunakan fallback default.`);
        return this.getDefaultConfig();
      }
      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      const parsedConfig = JSON.parse(fileContent) as AppConfiguration;
      // Validasi struktur (bisa ditambahkan class-validator / zod di sini)
      return parsedConfig;
    } catch (error) {
      this.logger.error(`Gagal memuat konfigurasi dari volume: ${(error as Error).message}`);
      return this.configState || this.getDefaultConfig(); // Fallback ke state sebelumnya jika rusak
    }
  }

  private getDefaultConfig(): AppConfiguration {
    return {
      featureFlags: { newPaymentGateway: false, maintenanceMode: false },
      rateLimit: { windowMs: 60000, maxRequests: 100 },
    };
  }

  private watchConfigVolume(): void {
    try {
      const targetDir = path.dirname(this.configPath);
      if (!fs.existsSync(targetDir)) {
        this.logger.warn(`Direktori target watch tidak ada: ${targetDir}`);
        return;
      }

      // Kubernetes ConfigMap mengupdate symlinks, jadi kita harus mengamati direktorinya
      this.watcher = fs.watch(targetDir, (eventType, filename) => {
        // K8s merotasi ConfigMap dengan membuat symlink baru berawalan '..data'
        if (eventType === 'rename' && filename && filename.includes('..data')) {
          this.logger.log(`Deteksi rotasi symlink ConfigMap Kubernetes. Memuat ulang konfigurasi...`);
          setTimeout(() => {
            const newConfig = this.loadConfigSync();
            this.configState = newConfig;
            this.configChangeSubject.next(this.configState);
            this.logger.log(`Konfigurasi berhasil diperbarui tanpa restart Pod!`);
          }, 1000); // Jeda kecil untuk memastikan Kubelet selesai merotasi file symlink atomic
        }
      });
    } catch (error) {
      this.logger.error(`Gagal memulai FSWatcher pada volume K8s: ${(error as Error).message}`);
    }
  }
}
```

## 4. Unit / K8s Watcher Mock Test Suite

```typescript
// src/config/dynamic-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { DynamicConfigService, AppConfiguration } from './dynamic-config.service';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('fs');

describe('DynamicConfigService (Volume Watcher)', () => {
  let service: DynamicConfigService;
  let mockWatchCallback: (eventType: string, filename: string) => void;

  beforeEach(async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      featureFlags: { newPaymentGateway: true, maintenanceMode: false },
      rateLimit: { windowMs: 60000, maxRequests: 200 }
    }));
    
    jest.spyOn(fs, 'watch').mockImplementation((dir: fs.PathLike, callback: fs.WatchListener<string>) => {
      mockWatchCallback = callback as any;
      return { close: jest.fn() } as unknown as fs.FSWatcher;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [DynamicConfigService],
    }).compile();

    service = module.get<DynamicConfigService>(DynamicConfigService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('seharusnya memuat inisial config dengan benar', () => {
    const config = service.getConfig();
    expect(config.featureFlags.newPaymentGateway).toBe(true);
    expect(config.rateLimit.maxRequests).toBe(200);
  });

  it('seharusnya memperbarui config secara atomic saat K8s merotasi symlink', (done) => {
    // Simulasi perubahan ConfigMap K8s (..data symlink rotation)
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      featureFlags: { newPaymentGateway: false, maintenanceMode: true },
      rateLimit: { windowMs: 60000, maxRequests: 50 }
    }));

    // Trigger FS Watcher
    mockWatchCallback('rename', '..data');

    // Karena ada setTimeout 1000ms di implementation, kita pakai async check
    setTimeout(() => {
      const config = service.getConfig();
      expect(config.featureFlags.maintenanceMode).toBe(true);
      expect(config.rateLimit.maxRequests).toBe(50);
      done();
    }, 1100);
  });
});
```

## 5. Analisis Trade-Off

### Kelebihan
1. **Zero-Downtime**: Menghilangkan kebutuhan untuk mematikan dan menghidupkan kembali container, menjaga Cache dan koneksi DB persisten tetap hidup.
2. **Atomic Rollout**: Jika validasi JSON parse gagal karena administrator melakukan kesalahan ketik (typo) di ConfigMap, sistem akan melakukan fallback otomatis ke state sehat terakhir, mencegah pemadaman (outage).
3. **Agilitas FinOps / Skalabilitas**: Mengubah limit rate API gateway atau mode maintenance dapat dilakukan seketika dalam hitungan milidetik secara global di ratusan pod sekaligus.

### Kekurangan
1. **Inkonsistensi State Sementara**: Dalam jeda 1-3 detik rotasi file Kubelet, sebagian Pod mungkin sudah menggunakan config baru sementara sisanya belum, memicu "split-brain" sejenak.
2. **Ketergantungan Polling / Watch**: Library Inotify dan `fs.watch` dapat mengkonsumsi sedikit CPU dan memori, serta rentan terhadap isu kompabilitas lintas platform OS.
3. **Kompleksitas Dependencies Singlenton**: Service lain yang menyuntikkan konfigurasi ini harus selalu memanggil `getConfig()` di dalam setiap eksekusi method, bukan menyimpannya (caching) di level constructor.

## 6. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyimpan state Config di Constructor Service Konsumen
Jika service konsumer melakukan dekonstruksi saat inisialisasi, perubahan dinamis tidak akan pernah terefleksikan.

**Salah:**
```typescript
@Injectable()
export class PaymentService {
  private readonly gatewayEnabled: boolean;
  constructor(private configService: DynamicConfigService) {
    // Nilai terperangkap mati di masa lalu!
    this.gatewayEnabled = this.configService.getConfig().featureFlags.newPaymentGateway;
  }
}
```

**Benar:**
```typescript
@Injectable()
export class PaymentService {
  constructor(private configService: DynamicConfigService) {}
  
  public processPayment() {
    // Ambil tepat pada saat dibutuhkan (JIT)
    const gatewayEnabled = this.configService.getConfig().featureFlags.newPaymentGateway;
    if (gatewayEnabled) { ... }
  }
}
```

### ❌ Anti-Pattern 2: Melakukan Watch Langsung Pada File ConfigMap
Di K8s, Kubelet mengelola ConfigMap menggunakan symlink. Menonton (watch) file spesifik (contoh: `appsettings.json`) tidak akan memicu event karena inode target dari symlink berubah, bukan file symlink itu sendiri.

**Salah:**
```typescript
fs.watch('/etc/config/appsettings.json', ...) // Event tidak akan terpanggil di K8s!
```

**Benar:**
```typescript
fs.watch('/etc/config', ...) // Watch direktorinya!
// Dan filter untuk nama '..data'
```

## 7. Production Edge Cases

1. **Partially Written Files**: Dalam beberapa skenario race condition ekstrim (non-K8s env), `fs.watch` mungkin terpanggil ketika file sedang ditulis (ukuran 0 byte). Penggunaan `setTimeout` dan block `try...catch` JSON.parse yang solid mencegah aplikasi crash membaca JSON rusak.
2. **OOM Akibat Memory Leak Watcher**: Kegagalan memanggil `.close()` pada event watcher saat module hancur (`OnModuleDestroy`) pada end-to-end testing (Jest) dapat menggerogoti heap memory dan me-leak file descriptors (`ENFILE`).
3. **Konflik Validasi Eksternal**: Jika K8s Admin mengubah Tipe data (contoh dari `boolean` menjadi `string` "true") via Kustomize, parsing manual JSON akan menghasilkan string yang mengelabui IF-statement. Di production nyata, implementasikan skema Zod pada metode `loadConfigSync` untuk memfilter validasi Runtime secara agresif.
