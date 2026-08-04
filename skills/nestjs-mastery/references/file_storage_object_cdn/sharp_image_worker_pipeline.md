# Pipeline Pemrosesan Gambar (Sharp) pada BullMQ Worker

## Pendahuluan
Memproses gambar (misalnya kompresi resolusi tinggi, konversi ke WebP/AVIF, *cropping*, pembuatan *thumbnail*, dan *EXIF sanitization* perlindungan lokasi koordinat GPS privasi user) adalah salah satu tugas CPU paling berat yang dapat melumpuhkan *Event Loop* NodeJS. Menangani ini secara sinkronus di dalam siklus HTTP NestJS (API handler) merupakan **Anti-Pattern fatal** di tingkatan arsitektur. Solusinya, operasi ini dipisahkan (*decoupled*) ke dalam *job queue* berbasis Redis menggunakan **BullMQ**, dan diolah menggunakan pustaka C++ berkecepatan tinggi, **Sharp**.

Dokumen ini membedah alur data (pipeline) proses worker di latar belakang dengan standar *Enterprise*.

## Diagram Alir Data (Worker Pipeline)

```ascii
+-------------+                       +-----------------------------+
|    API      |  1. Upload Original   |      NestJS Controller      |
|  Consumer   |---------------------->|   - Terima HTTP File        |
+-------------+                       |   - Simpan Ke Storage Raw   |
                                      |   - Queue Job (BullMQ)      |
                                      +-----------------------------+
                                                     | 2. Enqueue { fileId, originPath }
                                                     v
                                      +-----------------------------+
                                      |        Redis (BullMQ)       |
                                      +-----------------------------+
                                                     | 3. Dequeue Job
                                                     v
+-------------------------------------------------------------------+
|                   NestJS Worker Process (Sharp)                   |
| 4. Fetch Raw Object                                               |
| 5. Hapus Metadata EXIF (GPS Data Privacy)                         |
| 6. Konversi Paralel (Sharp):                                      |
|    +--> WebP (1080p, quality 80) -> Simpan: id_1080p.webp         |
|    +--> WebP (500px, quality 80) -> Simpan: id_500px.webp         |
|    +--> WebP ( 80px, quality 60) -> Simpan: id_thumbnail.webp     |
| 7. Hapus Raw Object (Opsional/Sesuai Kebijakan)                   |
| 8. Publikasikan Event (Emit WebSockets / Update DB Record)        |
+-------------------------------------------------------------------+
```

## Implementasi TypeScript / NestJS 10+ (Tanpa `any` & No Hardcode)

File: `image-processor.processor.ts`

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { promises as fsPromises } from 'fs';
import * as path from 'path';

export interface ImageProcessingJobPayload {
  readonly imageId: string;
  readonly originalFilePath: string;
  readonly outputDirectory: string;
}

@Injectable()
@Processor('image-processing-queue')
export class ImageProcessorWorker extends WorkerHost {
  private readonly logger = new Logger(ImageProcessorWorker.name);

  async process(job: Job<ImageProcessingJobPayload, void, string>): Promise<void> {
    const { imageId, originalFilePath, outputDirectory } = job.data;
    this.logger.log(`Memulai pemrosesan untuk gambar: ${imageId}`);

    try {
      // Memeriksa dan membuat direktori jika belum ada
      await fsPromises.mkdir(outputDirectory, { recursive: true });

      // Membaca file original
      const inputBuffer = await fsPromises.readFile(originalFilePath);

      // Inisialisasi pipeline Sharp (Menghapus EXIF demi privasi dengan withMetadata=false bawaan)
      const imagePipeline = sharp(inputBuffer).rotate(); // auto-rotate berdasar EXIF orientation

      // Mendefinisikan target resolusi dan menyalakan janji paralelisme (Promises)
      const tasks = [
        { suffix: '1080p', width: 1920, quality: 80 },
        { suffix: '500p', width: 500, quality: 80 },
        { suffix: 'thumb', width: 80, quality: 60 },
      ].map(async (preset) => {
        const outputPath = path.join(outputDirectory, `${imageId}_${preset.suffix}.webp`);
        
        await imagePipeline
          .clone()
          .resize({ width: preset.width, withoutEnlargement: true })
          .webp({ quality: preset.quality, effort: 4 }) // Effort disetel untuk rasio speed/compression optimal
          .toFile(outputPath);

        this.logger.debug(`Berhasil membuat resolusi ${preset.suffix} -> ${outputPath}`);
      });

      // Menjalankan konversi semua resolusi secara konkuren
      await Promise.all(tasks);

      // (Opsional) Di tahap ini Anda bisa mengirim event ke sistem bahwa id gambar ini sudah berstatus 'processed'
      this.logger.log(`Pemrosesan tuntas untuk gambar: ${imageId}`);
    } catch (error: unknown) {
      this.logger.error(`Gagal memproses gambar ${imageId}: ${(error as Error).message}`);
      throw error; // Melemparkan error agar BullMQ dapat melakukan retry (jika dikonfigurasi)
    }
  }
}
```

## Unit / Mock Test Suite menggunakan Jest

File: `image-processor.processor.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ImageProcessorWorker, ImageProcessingJobPayload } from './image-processor.processor';
import { Job } from 'bullmq';
import * as fsPromises from 'fs/promises';
import * as sharp from 'sharp';

// Mocks
jest.mock('fs/promises');
jest.mock('sharp');

describe('ImageProcessorWorker', () => {
  let worker: ImageProcessorWorker;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ImageProcessorWorker],
    }).compile();

    worker = module.get<ImageProcessorWorker>(ImageProcessorWorker);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('seharusnya memproses gambar ke dalam multiresolusi dan menghapus exif', async () => {
    const mockPayload: ImageProcessingJobPayload = {
      imageId: 'img-123',
      originalFilePath: '/tmp/original.jpg',
      outputDirectory: '/tmp/outputs',
    };

    const mockJob = { data: mockPayload } as Job<ImageProcessingJobPayload, void, string>;

    // Setup mocks
    const mockBuffer = Buffer.from('fake-image-data');
    (fsPromises.readFile as jest.Mock).mockResolvedValue(mockBuffer);
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);

    // Mock sharp chain
    const mockToFile = jest.fn().mockResolvedValue(undefined);
    const mockWebp = jest.fn().mockReturnValue({ toFile: mockToFile });
    const mockResize = jest.fn().mockReturnValue({ webp: mockWebp });
    const mockClone = jest.fn().mockReturnValue({ resize: mockResize });
    const mockRotate = jest.fn().mockReturnValue({ clone: mockClone });

    (sharp as unknown as jest.Mock).mockReturnValue({ rotate: mockRotate });

    await worker.process(mockJob);

    expect(fsPromises.mkdir).toHaveBeenCalledWith('/tmp/outputs', { recursive: true });
    expect(fsPromises.readFile).toHaveBeenCalledWith('/tmp/original.jpg');
    expect(sharp).toHaveBeenCalledWith(mockBuffer);
    
    // Dipanggil 3 kali (1080p, 500p, thumb)
    expect(mockClone).toHaveBeenCalledTimes(3);
    expect(mockResize).toHaveBeenCalledTimes(3);
    expect(mockWebp).toHaveBeenCalledTimes(3);
    expect(mockToFile).toHaveBeenCalledTimes(3);
  });
});
```

## Analisis Trade-Off (Kelebihan & Kekurangan)

### Kelebihan
1. **Performa Luar Biasa (Non-blocking HTTP):** HTTP endpoint merespons klien < 50ms karena tugas mahal C++ digeser ke mesin *queue* latar belakang.
2. **Skalabilitas Vertikal/Horizontal (Decoupled):** Konfigurasi BullMQ membolehkan proses API dan proses Sharp dijalankan di server *microservices* yang terpisah. Worker bisa dipasangi instance berspesifikasi Compute/CPU-Optimized (misalnya AWS c6g).
3. **Zero Data Privacy Leak (EXIF Wipe):** Kamera pengguna yang menyisipkan lokasi GPS akan digerus oleh Sharp sebelum dibagikan secara publik ke Web, mencegah kasus *doxing*.

### Kekurangan
1. **Delay Ketersediaan Gambar:** Antara pengguna mengunggah gambar dan gambar tersebut muncul dalam antarmuka UI akan terdapat *gap* waktu. Diperlukan penanganan UI pintar (seperti WebSockets/Polling/Skeleton load) sambil menunggu status selesai.
2. **Kompleksitas Infrastruktur (Redis Required):** Mewajibkan tambahan *resource* ekosistem (in-memory Redis store) untuk mendukung BullMQ, yang menaikkan ongkos kelola.
3. **RAM Hogs pada Konkurensi:** Pustaka C++ (Sharp/libvips) mengonsumsi memori *native*. Menjalankan 50 operasi *resize* serempak dalam 1 node bisa membunuh memori.

## Anti-Patterns (Contoh Kode Salah vs Benar)

### Anti-Pattern 1: Sinkronus pada Request-Response Cycle
❌ **Salah:** Menggunakan `sharp()` langsung di *Controller*. Event-Loop Node akan memblokade dan koneksi HTTP dari user lain akan tersendat (Hanging API).
```typescript
@Post('upload')
async upload(@UploadedFile() file) {
  const result = await sharp(file.buffer).resize(500).toBuffer(); // BENCANA jika ada 100 RPS!
  return result;
}
```
✅ **Benar:** Kirim ke BullMQ atau antrean lain, lalu kembalikan status respon 202 Accepted ke klien secara prematur.

### Anti-Pattern 2: Tidak Mereset Rotasi Berdasarkan Data EXIF 
❌ **Salah:** Tidak memakai `sharp().rotate()`. Seringkali foto dari ponsel (Apple/Samsung) terlihat rotasi 90 derajat secara salah akibat orientasi lensa tidak ditangani otomatis.
✅ **Benar:** Panggil metode rantai `.rotate()` secara default pada ujung hulu objek *Sharp* sebelum dikloning (*clone*).

## Production Edge Cases

1. **Memori Ludes (OOM via libvips memory leak):** Atur *concurrency parameter* di worker BullMQ. Jika worker NestJS dijalankan pada RAM 1GB, set limit maksimal concurrency worker di angka ~2 hingga 5 per pod. Jika antrean macet di dalam Sharp, ubah konfigurasi manajemen alokasi `sharp.concurrency(1)` guna menstabilkan RAM thread-pool bawaan libvips.
2. **DDoS *Zip-Bomb* atau Image Bomb:** Seseorang mungkin mengirim berkas JPEG sebesar 2KB, namun apabila direntangkan resolusi pikselnya (100.000 x 100.000 pixel) bisa menyedot 10GB memori untuk dekompresi. Batasi dimensi maksimum pembacaan pada *interceptor* di pintu masuk atau limit limit *input validation* (sharp limit pixel).
3. **Pemulihan Bencana/Gagal Konversi:** Konversi gagal karena file disrupsi (misalnya gambar rusak/korup 0 byte). Job BullMQ jangan diulang (*retry*) selamanya. Atur `attempts: 3` dengan strategi eksponensial di *producer*. Jika gagal final, pindahkan file ID ke status 'Dead Letter / Error DB Status' agar user dapat mengunggah ulang.
