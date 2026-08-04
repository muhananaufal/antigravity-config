# Penanganan Upload Raksasa: Streaming Multipart di Fastify (Low-Memory)

Salah satu area di mana Fastify benar-benar menghancurkan Express adalah penanganan *file upload*. Di ekosistem Express, de-facto standarnya adalah `multer` yang sering kali menyebabkan aplikasi Node.js terkena masalah V8 *Out-Of-Memory* (OOM) ketika berhadapan dengan unggahan *gigabyte-scale*, karena Multer kadang memuat seluruh berkas ke RAM (atau bergantung pada *disk spooling* yang padat I/O sinkron). Dengan `@fastify/multipart`, kita dapat mengimplementasikan *stream* langsung dari soket HTTP ke *Object Storage* (seperti AWS S3) tanpa pernah membebani *heap* memori Node.js.

## 1. Arsitektur Aliran Bebas Memori (Memory-Free Streaming)

Pendekatan ini menjamin memori aplikasi tetap konstan—kisaran 30-50MB—tanpa peduli apakah berkas yang diunggah berukuran 1MB atau 50GB.

```ascii
[Client] ---> 50GB Video File
   |
   | (Chunked TCP Stream)
   v
+-------------------------------+
| @fastify/multipart Pipeline   |
| (Stream iterator / pipeline)  |
+---------------+---------------+
                |
                | (Piping 64KB Chunks)
                v
+-------------------------------+
|     Object Storage SDK        |
|  (e.g., AWS S3 Multi-part)    |
+-------------------------------+
```

## 2. Implementasi Produksi NestJS & @fastify/multipart

Pastikan `multer` tidak dipasang. Kita akan mendaftarkan `@fastify/multipart` secara global, dan memproses aliran (*stream*) secara langsung di *controller*.

```typescript
// --- 1. Bootstrap: Mendaftarkan Plugin ---
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import fastifyMultipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';

export async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter();
  const app: NestFastifyApplication = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  // Daftarkan multipart dengan limit sangat ketat untuk file memory,
  // dan aktifkan stream processing.
  await app.register(fastifyMultipart, {
    limits: {
      fieldNameSize: 100, // Max panjang nama field
      fieldSize: 100,     // Max panjang string field nilai
      fields: 10,         // Max jumlah non-file field
      fileSize: 50 * 1024 * 1024 * 1024, // 50GB Limit mutlak, tapi kita gunakan stream!
      files: 1,           // Hanya terima 1 file per upload
      headerPairs: 2000   // Proteksi HTTP Header DoS
    }
  });

  await app.listen(3000);
  Logger.log('Aplikasi Fastify berjalan dengan Multipart Streaming aktif');
}

// --- 2. Controller: Penanganan Stream Asinkron ---
import { Controller, Post, Req, Res, HttpStatus } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import * as util from 'util';

const pipeline: (readStream: NodeJS.ReadableStream, writeStream: NodeJS.WritableStream) => Promise<void> = util.promisify(stream.pipeline);

@Controller('v1/media')
export class MediaController {
  
  @Post('upload')
  public async uploadLargeVideo(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    
    // Pastikan ini adalah multipart request
    if (!request.isMultipart()) {
      reply.status(HttpStatus.BAD_REQUEST).send({ error: 'Request is not multipart' });
      return;
    }

    try {
      // Dapatkan stream langsung (async iterator)
      const data = await request.file();
      
      if (!data) {
        reply.status(HttpStatus.BAD_REQUEST).send({ error: 'No file uploaded' });
        return;
      }

      // Validasi Ekstensi/Mimetype yang ekstrim ketat
      if (data.mimetype !== 'video/mp4') {
        reply.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).send({ error: 'Only MP4 allowed' });
        return;
      }

      const destinationPath: string = path.join('/tmp', `video_${Date.now()}.mp4`);
      const writeStream: fs.WriteStream = fs.createWriteStream(destinationPath);

      // STREAMING LANGSUNG: Memori stabil terlepas dari ukuran data
      await pipeline(data.file, writeStream);

      reply.status(HttpStatus.CREATED).send({ 
        status: 'Success', 
        message: 'File streaming completed',
        filename: data.filename 
      });

    } catch (error) {
      // Tangkap galat batas ukuran atau terputus
      const err: Error = error as Error;
      reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: err.message });
    }
  }
}
```

## 3. Analisis Trade-Off Streaming Multipart

**Kelebihan:**
1. **Memori Resilien & Kebal OOM:** Aplikasi Node.js tidak akan pernah meledak karena kehabisan RAM. Konsumsi RAM datar pada buffer alokasi (biasanya berkisar ~64KB per koneksi aktif).
2. **Tanpa Disk Spooling Lokal:** Dibanding metode sementara (temporary disk-write) pada Multer, kita bisa langsung `pipe` menuju S3 Bucket/GCS, menghilangkan batas I/O Disk server perantara secara absolut.
3. **Penyisipan Cepat (Bail-out):** Mampu menghentikan dan menolak unduhan *seketika* ketika *header/mimetype* salah dideteksi, menghemat bandwidth jaringan *backend*.

**Kekurangan:**
1. **Lebih Rumit untuk Validasi:** Anda tidak memiliki seluruh berkas untuk dipindai *hash*/virus di awal. Anda harus melakukan inspeksi *stream-on-the-fly* atau memvalidasi pasca-unggah di Object Storage.
2. **Ketergantungan Ekosistem Terpisah:** Tidak bisa menggunakan *built-in* FileInterceptor NestJS, yang berarti hilangnya integrasi OpenAPI/Swagger bawaan Nest secara mulus.
3. **Kesulitan Parsing DTO Bersamaan:** Anda tidak bisa dengan mudah membaca payload/DTO dalam waktu yang sama karena stream DTO tekstual dan stream binary bisa tercampur; memaksa arsitektur khusus untuk penguraian bidang terpisah.

## 4. Critical Anti-Patterns

### Anti-Pattern 1: Menggunakan `await data.toBuffer()`
Fitur bantuan dari Fastify ini sangat menggiurkan untuk mempermudah hidup, namun ini mengumpulkan semua porsi *(chunks)* ke dalam satu Buffer raksasa di dalam RAM.

❌ **Salah:** Ini akan menyebabkan *Crash OOM* jika berkas bernilai 2GB diunggah.
```typescript
const data = await request.file();
const buffer: Buffer = await data.toBuffer(); // BENCANA RAM!
fs.writeFileSync('/tmp/file.mp4', buffer);
```

✅ **Benar:** Selalu gunakan *stream pipeline* dan biarkan sistem operasi mengelola antrian.
```typescript
const data = await request.file();
const writeStream = fs.createWriteStream('/tmp/file.mp4');
await pipeline(data.file, writeStream); // RAM terjaga, IO dioptimalkan.
```

### Anti-Pattern 2: Menempatkan Field Metadata *Setelah* Berkas
Dalam form-data, *stream* diproses berurutan (*sequential*). Jika klien mengirim *field* JSON/Teks setelah *binary part*, Anda tidak akan memiliki metadata ketika *binary part* sedang ditransmisikan.

❌ **Salah:** Klien mengirimkan `[File Binary]` -> lalu `[UserId=123]`. Anda tidak bisa mencocokkan *userid* untuk folder S3 saat berkas tiba.
✅ **Benar:** Pastikan kontrak *frontend* mewajibkan semua metadata teks dikirim **sebelum** lampiran *file binary* dalam format `multipart/form-data`.

## 5. Production Edge Cases

1. **Broken Pipe (Klien Putus Tiba-Tiba):** Pengguna dengan koneksi seluler buruk menekan batal di tengah *upload* 1GB. Anda WAJIB mendengarkan `stream.on('error', ...)` atau menangkap blok `try/catch` pada fungsi `pipeline()`. Jika gagal, anda harus men- *trigger* penghapusan sebagian *file* sampah yang tersisa di *storage*.
2. **Serangan Zip Bomb / Tar Bomb Terkompresi:** File yang *streamed* secara langsung bisa sangat besar ketika diekstrak. Pastikan stream yang diterima melalui dekompresi lokal memiliki pemutus batas *stream limit bytes*.
3. **Pemuatan API Lambat (Slowloris Attack):** Pihak peretas mengirimkan 1 byte data per 10 detik. Fastify dan NGINX *Reverse Proxy* WAJIB disetel dengan `client_body_timeout` yang ekstrim dan ketat (misal 60 detik) untuk mencegah penumpukan alokasi soket TCP.

## 6. Unit / Inject Test Suite

Menguji *multipart form-data* dengan metode *inject* Fastify membutuhkan format manual pembuatan struktur batas multipart *(multipart boundary payload)* secara otentik.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Controller, Post, Req, Res, HttpStatus } from '@nestjs/common';
import fastifyMultipart from '@fastify/multipart';
import { FastifyRequest, FastifyReply } from 'fastify';
import FormData from 'form-data';

@Controller('v1')
class UploadController {
  @Post('stream')
  public async upload(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    if (!req.isMultipart()) {
      return res.status(400).send({ error: 'Bukan Multipart' });
    }
    const data = await req.file();
    // Simulate consuming the stream (wajib agar koneksi terselesaikan)
    let size = 0;
    for await (const chunk of data.file) {
      size += chunk.length;
    }
    res.status(200).send({ received: size });
  }
}

describe('Fastify Multipart Stream Testing', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UploadController],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyMultipart);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('harus memproses multipart upload berformat form-data via Fastify inject', async () => {
    const form: FormData = new FormData();
    const mockFileBuffer: Buffer = Buffer.from('INI_ADALAH_DATA_VIDEO_PALSU');
    
    // Pasang file palsu
    form.append('file', mockFileBuffer, {
      filename: 'test.mp4',
      contentType: 'video/mp4',
    });

    const fastify = app.getHttpAdapter().getInstance();
    
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/stream',
      headers: form.getHeaders(), // Header boundary sangat krusial
      payload: form // Payload stream dari form-data library
    });

    expect(response.statusCode).toBe(HttpStatus.OK);
    
    const parsed: Record<string, number> = JSON.parse(response.payload);
    expect(parsed.received).toBe(mockFileBuffer.length);
  });
});
```

*Side Note: Penggunaan stream pipeline yang kustom lebih stabil. Jangan menggunakan Multer di Node.js ketika throughput tinggi dan file size >5MB terlibat; itu adalah dosa kardinal dalam Backend Engineering modern.*
