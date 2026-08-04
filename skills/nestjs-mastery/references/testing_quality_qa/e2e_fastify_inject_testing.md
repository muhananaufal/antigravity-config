# E2E Fastify Inject Testing: Pengujian Integrasi Tanpa Overhead Port Jaringan

## Pengantar
Pengujian *End-to-End* (E2E) tradisional seringkali melibatkan tahapan inisiasi server HTTP yang mengikat (*bind*) port fisik (misalnya port 3000) pada sistem operasi host. Proses tersebut rentan terhadap masalah *port collision* di lingkungan CI/CD paralel, meningkatkan latensi eksekusi jaringan, serta mempersulit mekanisme siklus `setup` dan `teardown`.

Sebagai arsitek platform enterprise di ekosistem NestJS yang berbasis Fastify, **Fastify Inject** (`app.getHttpAdapter().getInstance().inject()`) hadir sebagai solusi mutlak. Pendekatan injeksi langsung ini menghindari beban buka-tutup soket jaringan TCP, mensimulasikan koneksi HTTP murni dalam memori. Hasilnya? Pengujian berjalan dalam hitungan milidetik.

---

## Arsitektur Fastify Inject E2E

```ascii
+-------------------------------------------------------------+
|               TRADITIONAL SUPERTEST PIPELINE                |
+-------------------------------------------------------------+
| Jest -> Supertest -> OS TCP Stack -> Port 3000 -> Fastify   |
| (Slow, Port Conflicts, Network Serialization Overhead)      |
+-------------------------------------------------------------+
                              VS
+-------------------------------------------------------------+
|                 FASTIFY INJECT PIPELINE                     |
+-------------------------------------------------------------+
| Jest -> Fastify Inject -> Fastify Router Engine             |
| (Direct Memory Access, No Port Binding, Blazing Fast)       |
+-------------------------------------------------------------+
```

## Implementasi Kode Produksi & Test Suite

Berikut adalah struktur kode untuk mensimulasikan integrasi injeksi Fastify secara Type-Safe di dalam NestJS.

### `health.controller.ts`

```typescript
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

export interface HealthResponse {
  readonly status: 'UP' | 'DOWN';
  readonly timestamp: string;
  readonly environment: string;
}

@Controller('health')
export class HealthController {
  @Get()
  @HttpCode(HttpStatus.OK)
  public checkHealth(): HealthResponse {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    };
  }
}
```

### `health.e2e-spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { HealthController } from './health.controller';
import { HttpStatus } from '@nestjs/common';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';

describe('HealthController (E2E with Fastify Inject)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    // Kritis: Melakukan inisialisasi framework tanpa listen ke port OS
    await app.init();
    
    // WAJIB panggil ini agar Fastify memuat rutenya secara sempurna
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET) - should return healthy status in memory', async () => {
    const injectOptions: InjectOptions = {
      method: 'GET',
      url: '/health',
    };

    // Eksekusi injeksi tanpa Supertest
    const response: LightMyRequestResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject(injectOptions);

    expect(response.statusCode).toStrictEqual(HttpStatus.OK);
    
    const payload = JSON.parse(response.payload);
    expect(payload.status).toStrictEqual('UP');
    expect(payload.environment).toBeDefined();
    expect(payload.timestamp).toBeDefined();
  });
});
```

---

## Analisis Trade-Off

### Kelebihan
1. **Kecepatan Eksekusi Ekstrem**: Karena operasi tidak menyeberang *OS network stack* atau protokol TCP layer 4, eksekusi Request-Response diproses secara langsung via memori. Waktu uji akan turun drastis!
2. **Bebas Bentrok Port (No Collision)**: Ratusan berkas E2E bisa dijalankan paralel seutuhnya karena kita tidak membutuhkan ketersediaan Port HTTP yang kosong.
3. **Konfigurasi Minimalis**: Tidak perlu menyematkan pustaka eksternal seperti `supertest`. Fungsionalitas `inject()` sudah secara langsung dikemas di dalam ekosistem `fastify` lewat ekstensi `light-my-request`.

### Kekurangan
1. **Hanya Terikat dengan Fastify**: Solusi ini sangat bergantung pada *FastifyAdapter*. Proyek yang dibangun menggunakan platform *ExpressAdapter* tidak dapat memanfaatkan API tingkat lanjut dari injeksi rute ini.
2. **Kesenjangan Akurasi OS Layer**: Mengingat jaringan HTTP dilewati, pengujian ini tidak memvalidasi konfigurasi level proksi beban server, HTTP *keep-alive*, atau parameter SSL jaringan fisik, di mana masalah bisa terjadi di tataran NGINX/Proxy produksi nyata.
3. **Ekstra Pemanggilan `ready()`**: Harus ingat untuk senantiasa memanggil `await app.getHttpAdapter().getInstance().ready()` setelah proses `app.init()`.

---

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Tetap menggunakan Listen/Supertest bersamaan Fastify
Mengapa bersikeras menghidupkan port ketika sudah ada Fastify Injeksi? 

```typescript
// ❌ CONTOH SALAH - Membuka port dan menggunakan Supertest di Fastify 
beforeAll(async () => {
  // app init dll...
  await app.listen(0); // Memakan port random di sistem operasi
});
it('test', async () => {
  return supertest(app.getHttpServer()).get('/health').expect(200);
});
```

```typescript
// ✅ CONTOH BENAR - Full In-Memory Injection
beforeAll(async () => {
  // app init dll...
  await app.init(); 
  await app.getHttpAdapter().getInstance().ready(); // Build routing tree
});
it('test', async () => {
  const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/health' });
  expect(response.statusCode).toBe(200);
});
```

### ❌ Anti-Pattern 2: Lupa melakukan Inisiasi Routing Tree
Menjalankan `inject` tanpa terlebih dahulu memastikan mesin internal (*routing tree*) dari fastify terbangun sempurna.

```typescript
// ❌ CONTOH SALAH - Hanya memanggil app.init()
await app.init();
// Fastify secara asinkron menunda pemuatan plugin, inject bisa gagal 404!
const response = await app.getHttpAdapter().getInstance().inject({ url: '/test' });
```

```typescript
// ✅ CONTOH BENAR - Selalu tunggu lifecycle hooks instance root
await app.init();
await app.getHttpAdapter().getInstance().ready();
const response = await app.getHttpAdapter().getInstance().inject({ url: '/test' });
```

---

## Production Edge Cases

1. **Pengunggahan File (Multipart FormData)**: Menguji rute pengunggahan (upload) fail via `fastify.inject()` memerlukan trik khusus. Anda harus merekonstruksi isi dari *buffer* FormData ke dalam `payload` injeksi dan menetapkan _header_ batas konten `content-type` (`multipart/form-data; boundary=...`) dengan tepat. Jika header ini meleset, pengurai (*parser*) akan gagal dengan error 415.
2. **Fastify Plugins Dependency**: Terkadang sebuah plugin eksternal berbasis asinkron yang sangat lambat tidak sepenuhnya termuat bahkan ketika *instance ready* dipanggil. Menanggulangi kasus keterlambatan inisiasi plugin bisa disiasati dengan membungkus blok koneksi khusus di `beforeAll` demi menjamin ketersediaan sebelum tes menginjeksi beban uji.
3. **Validasi Skema JSON Ekstrim**: Injeksi internal mensimulasikan pemrosesan `JSON.stringify` secara eksplisit. Jika sistem anda mengembalikan *circular structures* atau referensi tak valid, respon balikan (`response.payload`) via Injeksi berpotensi menampilkan perilaku kerusakan serializer (`TypeError`) yang berbeda dengan apa yang terjadi jika dibungkus dengan filter level jaringan fisik standar Express.

Menguasai injeksi Fastify adalah langkah paling mendasar dari Top 1% QA Engineer NestJS!

## Topik Lanjutan QA Enterprise: Fastify Inject

### 1. Fastify Inject vs Supertest: Perbandingan Mendalam
Meskipun kita telah membahas sekilas tentang kelemahan Supertest, penting untuk memahami perbedaan arsitektur keduanya di level mikro.
- **Supertest**: Melakukan *parsing* dan serialisasi HTTP penuh. Setiap permintaan `GET /health` diubah menjadi paket TCP/IP, dikirim melalui antarmuka *loopback* sistem operasi, dan diterima oleh lapisan soket Node.js. Ini mensimulasikan lingkungan se-realistis mungkin, tetapi memicu *overhead* pada kernel OS.
- **Fastify Inject**: Memotong seluruh perjalanan jaringan. Ia langsung menyuntikkan objek *request* murni (*mocked Request/Response*) ke dalam fungsi *Router* utama Fastify. Dampaknya adalah eksekusi hampir setara dengan pemanggilan fungsi JavaScript biasa, membuatnya 10x - 50x lebih cepat dari Supertest, sangat vital untuk suite dengan >5000 *test case*.

### 2. Application Lifecycle Hooks dalam Pengujian
Dalam arsitektur *Enterprise NestJS*, aplikasi biasanya memiliki *hook lifecycle* yang krusial seperti `onApplicationBootstrap` atau `onModuleInit` (misalnya untuk menyambungkan koneksi Kafka atau mengisi *cache* Redis).
- Jika Anda hanya memanggil `await app.init()`, semua *hook* ini akan dijalankan.
- **Penting**: Pastikan Anda memiliki *mock* atau pemisahan (*stub*) untuk koneksi eksternal yang diinisialisasi pada *hook* ini. Jika tidak, proses injeksi in-memory yang super cepat akan terhambat oleh *timeout* koneksi eksternal tersebut.

### 3. Strategi Database Seeding untuk Fastify Inject
Karena tes berjalan sangat cepat secara paralel, *seeding* database konvensional (mengisi tabel sebelum setiap *test*) seringkali memicu kondisi *Race Condition* atau *Deadlock* di database.
✅ **Pola Terbaik**: 
- Gunakan skema *Database-per-test-suite* (via Testcontainers) atau isolasi menggunakan *Transaction Rollback*.
- Lakukan penyisipan (insert) data *mock* melalui *Repository* langsung di blok `beforeEach` dan pastikan data diisolasi per entitas unik, atau bungkus seluruh injeksi API E2E dalam *Database Transaction* yang dibatalkan (rollback) di akhir iterasi.

### 4. Parallel Test Execution Isolation
Kecepatan Fastify Inject membuka pintu bagi *Parallel Execution* penuh. Menggunakan `jest --maxWorkers=50%`, Anda bisa menjalankan puluhan fail secara bersamaan.
- ❌ **Anti-Pattern**: Menggunakan *Global Singleton State* (seperti modul Config yang diubah-ubah di tengah *test*).
- ✅ **Praktik Terbaik**: Jaga kemurnian (*purity*) lingkungan. Karena Injeksi tidak menggunakan port jaringan (yang merupakan *shared OS resource*), batasan Anda kini hanyalah CPU RAM, dan I/O Database. Pastikan nama *database* dinamis per proses *Jest worker* jika mengeksekusi tes database berdampingan.

### 5. Snapshot Testing pada JSON Responses
Memverifikasi setiap bidang (field) *payload* JSON yang besar secara manual adalah pekerjaan melelahkan. Fastify Inject mengembalikan `payload` murni dalam wujud *string*. Anda bisa mengintegrasikannya dengan fitur *Snapshot Testing* dari Jest.

```typescript
it('/api/v1/complex-data (GET) - snapshot verification', async () => {
  const response = await app.getHttpAdapter().getInstance().inject({ url: '/api/v1/complex-data' });
  const jsonResponse = JSON.parse(response.payload);
  
  // Memastikan bahwa data selalu identik secara struktur! 
  // Tanggal yang dinamis harus dimodifikasi sebelum snapshot.
  jsonResponse.timestamp = 'MOCKED_TIMESTAMP';
  
  expect(jsonResponse).toMatchSnapshot();
});
```
*Trade-off*: Snapshot testing membuat pembaruan *test* sangat instan (hanya via perintah `jest -u`), namun berisiko membuat *developer* lengah (langsung memperbarui *snapshot* tanpa mengecek apa perubahannya). Selalu periksa *diff* *snapshot* pada Git *Pull Request*!
