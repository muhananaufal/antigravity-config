# Isolasi Kompartemen: Bulkhead Pattern di NestJS

Secara filosofis, kapal laut raksasa seperti Titanic tenggelam karena saat satu ruang kargo robek oleh gunung es, air membanjiri ruang lain tanpa penghalang. *Bulkhead Pattern* mencegah hal yang sama terjadi dalam sistem terdistribusi: memisahkan sumber daya aplikasi menjadi "kompartemen" terisolasi (mis. koneksi basis data atau kumpulan *thread*) sedemikian rupa sehingga jika kompartemen untuk proses "Mencetak Laporan PDF" kehabisan tenaga karena antrian panjang, hal tersebut **TIDAK AKAN MENGGANGGU** kompartemen proses kritis seperti "Transaksi Pembayaran".

Dalam ekosistem NodeJS/NestJS (yang mengandalkan *Event Loop* tunggal yang terbatas dan batasan koneksi I/O asinkron), menerapkan sekat *Bulkhead* dapat dilakukan secara fisik dengan memisahkan instans layanan mikro, atau secara logis menggunakan pembatasan semafor (Semaphore) dan antrian khusus per domain.

## Arsitektur Bulkhead (ASCII Diagram)

```text
Tanpa Bulkhead (Air menenggelamkan semuanya):
[ API Gateway ] ---> (Shared Pool 100 Threads) ---> PDF Generator (HOGS 100 Threads)
                                               ---> Payment API (STARVED! TIMEOUT!)

Dengan Bulkhead Pattern (Terkompartemen):
                                +---[ Bulkhead A: 10 Worker ]---> PDF Generator (Queue Penuh, Drop PDF)
                                |
[ API Gateway (Node.js) ] ------+
                                |
                                +---[ Bulkhead B: 90 Worker ]---> Payment API (90/90 Free, Fast!)
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

Di sini kita akan menggunakan modul `async-mutex` atau pembatasan `bullmq` sebagai sekat logis (*logical bulkhead*). Dalam contoh ini, kita membuat abstraksi `BulkheadService` kustom yang menggunakan Semaphore untuk membatasi penerbangan serentak (*in-flight concurrency*) untuk jenis pekerjaan tertentu.

```typescript
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Semaphore, withTimeout } from 'async-mutex';

/**
 * Registry dari berbagai kompartemen Bulkhead.
 */
interface BulkheadCompartments {
  payment: Semaphore;
  reports: Semaphore;
}

@Injectable()
export class BulkheadIsolationService {
  private readonly logger = new Logger(BulkheadIsolationService.name);
  private compartments: BulkheadCompartments;

  constructor() {
    // Inisialisasi kapasitas Kompartemen
    // Laporan PDF adalah beban berat yang berpotensi menyumbat CPU, batasi hanya max 2 serentak!
    // Pembayaran adalah hal kritis dan cepat, sediakan max 50 serentak.
    this.compartments = {
      reports: withTimeout(new Semaphore(2), 5000, new Error('Kompartemen Report Penuh')), // Tolak dengan timeout jika antri > 5dtk
      payment: withTimeout(new Semaphore(50), 2000, new Error('Kompartemen Payment Penuh')),
    };
  }

  /**
   * Menjalankan tugas yang menyita CPU (seperti PDF) dalam batas perlindungan bulkhead.
   */
  public async executeReportTask<T>(task: () => Promise<T>): Promise<T> {
    return this.runInCompartment('reports', task);
  }

  /**
   * Menjalankan tugas kritis di dalam kompartemen terpisah.
   */
  public async executePaymentTask<T>(task: () => Promise<T>): Promise<T> {
    return this.runInCompartment('payment', task);
  }

  /**
   * Logika inti pengunci sekat.
   */
  private async runInCompartment<T>(
    compartmentName: keyof BulkheadCompartments,
    task: () => Promise<T>,
  ): Promise<T> {
    const compartment = this.compartments[compartmentName];

    try {
      // Mengakuisisi tempat di kompartemen (menunggu jika penuh tapi belum timeout)
      return await compartment.runExclusive(async () => {
        return await task();
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Penuh')) {
        this.logger.warn(`Bulkhead [${compartmentName}] mengalami Overflow! Menolak permintaan untuk mencegah kelaparan sumber daya sistem.`);
        throw new ServiceUnavailableException(`Server terlalu sibuk untuk memproses area ${compartmentName}. Silakan coba lagi nanti.`);
      }
      throw error;
    }
  }
}
```

### Menggunakan Bulkhead di Controller

```typescript
import { Controller, Post, Get, Body } from '@nestjs/common';
import { BulkheadIsolationService } from './bulkhead-isolation.service';

@Controller('api/v1')
export class SystemController {
  constructor(private bulkhead: BulkheadIsolationService) {}

  @Post('/payments')
  async processPayment(@Body() data: { amount: number }) {
    // Masuk kompartemen aman, hingga max 50 koneksi konstan
    return this.bulkhead.executePaymentTask(async () => {
       // Logika pembayaran yang sebenarnya (missal panggil DB/Gateway stripe)
       return { status: 'success', amount: data.amount };
    });
  }

  @Get('/reports/heavy')
  async downloadReport() {
    // Terbatas ketat pada 2 beban berat (PDF buffer render) yang tidak akan mencekik Event Loop bagi Payment
    return this.bulkhead.executeReportTask(async () => {
       await new Promise((res) => setTimeout(res, 3000)); // Simulasi berat 3 detik
       return { file: 'buffer.pdf' };
    });
  }
}
```

## Unit / Chaos Interceptor Mock Test Suite

Kita menyimulasikan kelaparan di kompartemen laporan, dan membuktikan kompartemen pembayaran tetap hidup dan melesat cepat tak tersentuh.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { BulkheadIsolationService } from './bulkhead-isolation.service';
import { ServiceUnavailableException } from '@nestjs/common';

describe('BulkheadIsolationService Concurrency Suite', () => {
  let service: BulkheadIsolationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BulkheadIsolationService],
    }).compile();

    service = module.get<BulkheadIsolationService>(BulkheadIsolationService);
  });

  it('harus membatasi kapasitas kompartemen report secara independen tanpa mempengaruhi payment', async () => {
    // 1. Eksekusi 3 report task serentak. Bulkhead hanya berkapasitas 2. Task 3 akan mengantri.
    const longRunningReportTask = () => new Promise<string>((res) => setTimeout(() => res('report_done'), 500));
    
    // Fire and forget, menempati slot
    const p1 = service.executeReportTask(longRunningReportTask);
    const p2 = service.executeReportTask(longRunningReportTask);

    // Task ke 3 harusnya masuk ke timeout exception karena tidak bisa mengakuisisi kunci cepat
    const timeoutReportTask = () => new Promise<string>((res) => setTimeout(() => res('report_timeout_test'), 6000)); // lebih dr batas withTimeout
    
    const p3Promise = service.executeReportTask(timeoutReportTask);

    // Sementara itu (selagi report bulkhead penuh dan p3 terjebak antrian)
    // 2. Kita menembak kompartemen Payment yang seharusnya kosong dan terisolasi
    const fastPaymentTask = () => Promise.resolve('payment_success');
    const paymentResult = await service.executePaymentTask(fastPaymentTask);

    // BUKTI: Payment melesat cepat dan sukses secara independen
    expect(paymentResult).toBe('payment_success');

    // BUKTI: Bulkhead report akhirnya melempar ServiceUnavailable Exception yang menyelamatkan sistem
    await expect(p3Promise).rejects.toThrow(ServiceUnavailableException);
    await Promise.all([p1, p2]);
  });
});
```

## Analisis Trade-off

### Kelebihan
1. **Pencegahan Gangguan Tetangga Bising (*Noisy Neighbor*):** Rute yang kelebihan beban CPU atau panjang tidak akan menghabiskan seluruh Event Loop *pool* NestJS (atau pool DB koneksi pg/knex) yang membuat aplikasi seakan membeku.
2. **Pengutamaan Misi Kritis:** Memastikan bisnis beroperasi meskipun terjadi penyalahgunaan pengguna pada fitur komplementer. (Misalnya, e-commerce terus menerima pesanan meskipun server ulasan pengguna macet karena *DDoS scraping*).
3. **Pengelolaan Serentak yang Prediktif:** Pengembang dapat memodelkan skala infrastruktur mereka secara matematika pasti (hanya akan menghabiskan maksimum RAM untuk 2 render PDF serentak di dalam 1 wadah pod).

### Kekurangan
1. **Kesulitan Menentukan Kapasitas Optimal (Sizing):** Memberi ruang yang terlalu kecil akan menolak pengguna (*false positives dropping*), ruang yang terlalu besar menjadikan *Bulkhead* tersebut tidak berguna ketika lonjakan muatan terjadi.
2. **Meningkatkan Kompleksitas Kode:** Mengembangkan antrian sinkronisasi, *semaphores*, dan pelepasan *resources* menambah lapisan kesalahan internal di antara layanan.
3. **Risiko Kebuntuan Tersembunyi (*Deadlock Risk*):** Jika eksekusi gagal melepaskan kunci semafor karena panik asinkron tanpa blok try/finally yang tepat di lapisan abtraksi *library*, seluruh kompartemen dapat terkunci permanen (*starvation lock*).

## Anti-Patterns

### ❌ Anti-Pattern 1: Pool Database Global Terpusat
**Masalah:** Memiliki satu `TypeOrmModule` pool koneksi global (10 pool max) dan membiarkan laporan berat yang menggabungkan 10 tabel menyita waktu 5 detik. Akibatnya, query sisipan pesanan pembayaran harus menunggu koneksi bebas hingga akhirnya dibatalkan oleh *timeout pg*.
✅ **Solusi Benar:** Terapkan *Physical Bulkhead*, yakni buat dua *Datasource pool connection* ke PostgreSQL. Satu yang dialokasikan khusus max 8 *pool* untuk *transactions*, dan 1 koneksi khusus untuk laporan analitik.

### ❌ Anti-Pattern 2: Asumsi Sinkron NodeJS
**Masalah:** Menggunakan rutinitas sinkron besar dalam NodeJS (seperti `JSON.parse(hugeFile)` atau kompresi gambar murni `zlib.sync`) meskipun dibungkus dalam *Bulkhead Semaphore*. Jika `Thread` utama NodeJS terkunci (*Event Loop Blocked*), semafor dan pengatur waktu akan meleset, Bulkhead lain akan tetap terhenti!
✅ **Solusi Benar:** Pindahkan komputasi tugas CPU murni ke `Worker_Threads` NestJS yang diatur dalam kolam terpisah (*Worker Thread Pool* Bulkhead), agar utas I/O utama tetap lancar tak peduli betapapun berat kompartemen latar belakangnya.

## Production Edge Cases

1. **Masalah Restart Paksa pada Antrian Menumpuk:** Jika Bulkhead dikonfigurasi untuk mengizinkan antrian 5000 tugas dalam memori, lalu tiba-tiba klaster Kubernetes melakukan perombakan *Pod Restart*, semua 5000 tugas memori di kompartemen tersebut terhapus tanpa ampun. Solusi tangguh harus beralih dari memori ke persisten seperti `BullMQ` dengan redis.
2. **Kebocoran Koneksi Soket Tanpa Kunci:** Jika tugas pihak ketiga di dalam kompartemen membocorkan penanganan file soket (`socket.hangup()`) atau merusak TLS, proses akan diam. Kunci *bulkhead* akan ditahan selamanya kecuali `withTimeout` mengintervensi dengan sempurna mematikan dan melepaskan status jaminan mutex.
3. **Starvation pada API Internal Mikro-Jaringan:** Kompartemen API internal antar-pod (GRPC channel) jika menggunakan 1 terusan multiplex HTTP2, dapat menyumbat di TCP layer jika *Bulkhead* logis saja (semafor) diterapkan di sisi NestJS, karena *underlying libuv* C++ engine telah jenuh oleh paket macet. Memerlukan penyesuaian limitasi kernel TCP max sockets per agen!
