# Keamanan Kontainer NestJS: Non-Root User & Graceful Shutdown (SIGTERM)

## Pendahuluan: Bertahan di Ekosistem Orkestrasi

Menjalankan proses aplikasi di kontainer Docker sebagai pengguna `root` adalah pelanggaran kepatuhan mutlak dalam arsitektur Zero-Trust. Eksekusi sebagai root membuka eksploitasi eskalasi hak istimewa (Privilege Escalation) langsung ke node Kubernetes host jika terjadi pelepasan kontainer (container breakout). Di luar keamanan eksistensial, siklus hidup kontainer yang epik bergantung pada transisi penutupan yang tertib (Graceful Shutdown) saat menerima sinyal `SIGTERM` dari *orchestrator*, demi melindungi integritas koneksi database dan mencegah hilangnya transaksi data pelanggan.

## Diagram ASCII: Orkestrasi Sinyal SIGTERM & Pemadaman

```ascii
[ Kubernetes Kubelet ]
          | (Pod Eviction / Rolling Update)
          v
[ Mengirim SIGTERM ke Kontainer PID 1 ]
          |
          v
[ NestJS Application (Node.js Process) ]
          |
          |-- 1. Berhenti menerima request HTTP baru (Draining)
          |
          |-- 2. Menyelesaikan HTTP request yang sedang diproses (In-flight)
          |
          |-- 3. Memancarkan app.close() / OnApplicationShutdown hooks
          |        |
          |        |-- Menutup koneksi TCP Database (PostgreSQL)
          |        |-- Menghentikan polling Redis / RabbitMQ
          |        |-- Membersihkan File Descriptor
          |
          |-- 4. Proses Node.js keluar dengan exit code 0
          v
[ Pod Terminated Safely ]
```

## Implementasi Graceful Shutdown pada Bootstrapping NestJS

NestJS menyediakan kait siklus hidup, namun pengikatan sinyal sistem operasi harus diaktifkan secara eksplisit pada `main.ts`.

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // MENGAKTIFKAN KEPATUHAN SIGTERM DAN SIGINT UNTUK GRACEFUL SHUTDOWN
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  logger.log(`Aplikasi NestJS (Non-Root) mengudara di port ${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Kesalahan fatal saat bootstrapping:', err);
  process.exit(1);
});
```

### Modul Pembersihan Koneksi Database (Contoh PostgreSQL/Prisma)

Kita harus bereaksi terhadap kait pemadaman.

```typescript
import { Injectable, OnApplicationShutdown, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super();
  }

  // Hook ini dipanggil otomatis ketika app.enableShutdownHooks() menerima SIGTERM
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.warn(`Menerima sinyal ${signal}. Menutup koneksi database...`);
    try {
      await this.$disconnect();
      this.logger.log('Koneksi database PostgreSQL ditutup dengan tertib.');
    } catch (error: unknown) {
      this.logger.error('Gagal menutup koneksi database secara tertib', error);
    }
  }
}
```

## Memaksa Non-Root User pada Dockerfile & Kubernetes Manifest

Untuk memenuhi standar keamanan, kita menetapkan `node` sebagai *user* di Dockerfile.

```dockerfile
FROM node:20.11.1-alpine AS production
WORKDIR /usr/src/app

ENV NODE_ENV=production

# Ubah kepemilikan direktori kerja ke user 'node' sebelum mengeksekusi
COPY --chown=node:node ./dist ./dist
COPY --chown=node:node ./node_modules ./node_modules

# EKSPLISIT: Ganti pengguna menjadi 'node' yang memiliki hak istimewa terbatas (Non-Root)
USER node

CMD ["node", "dist/main.js"]
```

## Anti-Patterns Kritis & Praktik Terbaik

### ❌ Anti-Pattern 1: Mengabaikan SIGTERM dan Membiarkan Sinyal SIGKILL Menghancurkan State
Jika `app.enableShutdownHooks()` tidak diaktifkan, Node.js mengabaikan sinyal SIGTERM dari Kubernetes. Kubernetes akan menunggu periode *grace* (default 30 detik) lalu menembakkan sinyal mematikan brutal `SIGKILL`.
```typescript
// ❌ SALAH: Transaksi database bisa terpotong di tengah eksekusi
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // app.enableShutdownHooks(); // LUPA DIAKTIFKAN
  await app.listen(3000);
}
```

### ✅ Solusi 1: Pemadaman yang Anggun
Pastikan `app.enableShutdownHooks()` diaktifkan, dan semua modul adapter I/O mengimplementasikan antarmuka `OnApplicationShutdown` atau `BeforeApplicationShutdown`.

### ❌ Anti-Pattern 2: Menjalankan NPM Start di Entrypoint Docker (PID 1 Problem)
NPM sering menelan sinyal SIGTERM dan tidak meneruskannya ke proses Node.js child, merusak rute penutupan anggun.
```dockerfile
# ❌ SALAH: Menyebabkan NPM menjadi PID 1, menjebak sinyal.
CMD ["npm", "run", "start:prod"]
```

### ✅ Solusi 2: Eksekusi Langsung Biner Node
Pastikan eksekusi di CMD langsung mengarah ke *runtime* untuk membuat aplikasi NestJS sebagai proses PID 1 di dalam kontainer yang bisa menerima sinyal OS.
```dockerfile
# ✅ BENAR: Aplikasi Node menerima sinyal langsung.
CMD ["node", "dist/main.js"]
```

## Analisis Trade-Off

### Kelebihan
1. **Isolasi Keamanan Tinggi:** Pengguna `node` tidak dapat menjalankan instalasi paket sembarangan atau mengubah file sistem esensial di kontainer.
2. **Integritas Data Transaksi:** *Graceful shutdown* melindungi aplikasi dari korupsi data akibat koneksi database (Postgres/Mongo) yang ditarik paksa saat transaksi masih mengudara.
3. **Ketersediaan Layan (Zero-Downtime Deployment):** Mengizinkan Load Balancer membuang kontainer lama dengan tenang sementara request baru diarahkan ke kontainer baru (rolling restart K8s yang mulus).

### Kekurangan
1. **Izin File Logging Sulit:** Menulis log ke dalam sistem file lokal sebagai non-root (seperti `/var/log`) sering kali gagal karena keterbatasan izin, memaksa peralihan absolut ke penulisan log di `stdout`/`stderr`.
2. **Port Priviledge (< 1024):** Non-root user tidak dapat *bind* server HTTP NestJS ke port standar seperti 80 atau 443 di dalam kontainer. Harus menggunakan port tinggi seperti 3000 atau 8080.
3. **Keterlambatan Pod Termination:** Proses shutdown hook yang menunggu koneksi I/O tertutup dapat membuat Pod berstatus `Terminating` selama beberapa detik hingga menit, memperlambat proses *scale-in*.

## Production Edge Cases

1. **Deadlock pada Shutdown Hook:** Jika hook pelepasan sumber daya Anda menanti *Promise* yang gagal *resolve* (seperti koneksi DB yang membeku), kontainer Anda tidak akan berhenti perlahan, melainkan memicu Kubernetes untuk mengirim `SIGKILL` setelah 30 detik (default `terminationGracePeriodSeconds`). Pastikan setiap hook pelepasan sumber daya Anda menggunakan modul *timeout*.
2. **Batas Eksekusi Pod (Termination Grace Period):** Jika transisi pemadaman NestJS butuh 45 detik (memproses laporan tertunda), tetapi Kubernetes diatur dengan `terminationGracePeriodSeconds: 30`, NestJS akan dimatikan secara brutal di detik ke-30. Konfigurasi orkestrator dan logika penutupan NestJS wajib sinkron!
3. **Gagal Bind Port 80:** Mengubah dari Root ke Non-root `node` mengakibatkan eksistensi `EACCES` saat aplikasi mencoba bind ke port 80. Aplikasi wajib diikat ke port alternatif dalam rentang non-privilese, lalu mengandalkan Ingress K8s atau Docker port mapping (`-p 80:3000`) untuk penyesuaian publik.

## Unit Test: Menguji Sinyal Pemadaman
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService Shutdown Hooks', () => {
  let prismaService: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('harus memanggil $disconnect saat onApplicationShutdown dipicu', async () => {
    // Membuat mock fungsi disconnect untuk mengawasi panggilannya
    const disconnectSpy = jest.spyOn(prismaService, '$disconnect').mockResolvedValue(undefined);
    
    // Memicu siklus pemadaman secara manual
    await prismaService.onApplicationShutdown('SIGTERM');

    // Menegaskan bahwa perisai koneksi telah dikerahkan dan DB ditarik mundur dengan aman
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    
    disconnectSpy.mockRestore();
  });
});
```
