# Streaming Video & File Raksasa dengan Multipart Chunked Resumable Upload

## Pendahuluan
Mengunggah file berukuran raksasa (Gigabytes) dalam satu HTTP *request* tunggal rentan terhadap kegagalan jaringan, batas waktu (*timeout*), dan batasan transfer TCP. Di skenario produksi (misalnya untuk sistem manajemen aset media), pendekatan standar industri yang dipakai adalah **Multipart Chunked Resumable Upload**. Pendekatan ini memecah satu file raksasa menjadi potongan-potongan (chunks), mengunggah potongan tersebut secara terpisah (bisa diparalelkan), menyatukan kembali potongan di Object Storage, dan membolehkan unggahan dilanjutkan kembali (*resume*) di titik gagalnya—tanpa harus mengulang dari nol.

Dokumentasi ini membongkar arsitektur menggunakan API Multipart AWS S3 yang dikendalikan melalui sistem orkestrasi di NestJS.

## Diagram Alir Data (Multipart Flow)

```ascii
+-------------+                       +-----------------------------+
|  Klien UI   |   1. Initiate Upload  |    NestJS Backend (Orchestrator)
| (File 2GB)  |---------------------->| - Buat `UploadId` dari S3
|             |<----------------------| - Kembalikan `UploadId` 
|             |                       +-----------------------------+
|             |   2. Request Part URLs (Part 1, 2, ..., N)
|             |---------------------->| - Buat Presigned URL untuk tiap Part
|             |<----------------------| - (Menentukan PartNumber)
+-------------+                       +-----------------------------+
   |  |  |
   |  |  | 3. Upload Chunks via HTTP PUT directly ke S3 Presigned URLs
   v  v  v    (Menghasilkan ETag dari setiap Part yang berhasil)
+-------------------------------------------------------------------+
|                            AWS S3                                 |
| [Part 1: 5MB] [Part 2: 5MB] ... [Part N: Sisa]                    |
+-------------------------------------------------------------------+
   |  |  |
+-------------+   4. Complete Upload (Bawa Kumpulan ETag + PartNumber)
|  Klien UI   |---------------------->+-----------------------------+
| (Menunggu)  |                       |    NestJS Backend
|             |<----------------------| - Validasi & Execute `CompleteMultipartUpload`
+-------------+                       +-----------------------------+
```

## Implementasi TypeScript / NestJS 10+ (Tanpa `any` & No Hardcode)

File: `multipart-upload.service.ts`

```typescript
import { Injectable, InternalServerErrorException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  S3Client, 
  CreateMultipartUploadCommand, 
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  CompletedPart
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

export interface MultipartInitializationDto {
  readonly filename: string;
  readonly contentType: string;
}

export interface PartUrlRequestDto {
  readonly uploadId: string;
  readonly fileKey: string;
  readonly partNumbers: number[];
}

export interface CompleteMultipartDto {
  readonly uploadId: string;
  readonly fileKey: string;
  readonly parts: CompletedPart[]; // Array of { ETag, PartNumber }
}

@Injectable()
export class MultipartUploadService {
  private readonly logger = new Logger(MultipartUploadService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.getOrThrow<string>('AWS_S3_BUCKET_NAME');
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  public async initiateUpload(data: MultipartInitializationDto): Promise<{ uploadId: string, fileKey: string }> {
    const fileKey = `videos/${uuidv4()}-${data.filename}`;
    
    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        ContentType: data.contentType,
      });

      const response = await this.s3Client.send(command);
      
      if (!response.UploadId) {
        throw new Error('UploadId tidak diterima dari S3');
      }

      this.logger.log(`Memulai Multipart Upload untuk ${fileKey} dengan ID ${response.UploadId}`);
      return { uploadId: response.UploadId, fileKey };
    } catch (error: unknown) {
      this.logger.error(`Inisiasi Multipart gagal: ${(error as Error).message}`);
      throw new InternalServerErrorException('Gagal menginisiasi pengunggahan file raksasa');
    }
  }

  public async getPresignedUrlsForParts(data: PartUrlRequestDto): Promise<{ partNumber: number, url: string }[]> {
    if (data.partNumbers.length > 100) {
      throw new BadRequestException('Maksimal meminta 100 part URL sekaligus untuk mencegah limit');
    }

    const promises = data.partNumbers.map(async (partNumber) => {
      const command = new UploadPartCommand({
        Bucket: this.bucketName,
        Key: data.fileKey,
        UploadId: data.uploadId,
        PartNumber: partNumber,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
      return { partNumber, url };
    });

    try {
      return await Promise.all(promises);
    } catch (error: unknown) {
      this.logger.error(`Gagal membuat URL part: ${(error as Error).message}`);
      throw new InternalServerErrorException('Gagal menyiapkan tautan bagian file');
    }
  }

  public async completeUpload(data: CompleteMultipartDto): Promise<{ location: string }> {
    // S3 mewajibkan potongan diurutkan berdasarkan PartNumber yang membesar.
    const sortedParts = [...data.parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: data.fileKey,
        UploadId: data.uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      });

      const response = await this.s3Client.send(command);
      this.logger.log(`Multipart upload diselesaikan untuk: ${data.fileKey}`);
      
      return { location: response.Location || data.fileKey };
    } catch (error: unknown) {
      this.logger.error(`Gagal menyelesaikan multipart upload: ${(error as Error).message}`);
      throw new InternalServerErrorException('Gagal merakit file final, hubungi administrator');
    }
  }
}
```

## Unit / Mock Test Suite menggunakan Jest

File: `multipart-upload.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MultipartUploadService } from './multipart-upload.service';
import { S3Client, CreateMultipartUploadCommand } from '@aws-sdk/client-s3';

jest.mock('@aws-sdk/client-s3');
const MockS3Client = S3Client as jest.MockedClass<typeof S3Client>;

describe('MultipartUploadService', () => {
  let service: MultipartUploadService;
  let s3ClientInstance: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultipartUploadService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-val'),
          },
        },
      ],
    }).compile();

    service = module.get<MultipartUploadService>(MultipartUploadService);
    s3ClientInstance = MockS3Client.mock.instances[0];
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('seharusnya menginisiasi multipart upload dan me-return uploadId', async () => {
    const mockUploadId = 'ABCD-1234-EFGH';
    s3ClientInstance.send.mockResolvedValueOnce({ UploadId: mockUploadId });

    const dto = { filename: 'film.mp4', contentType: 'video/mp4' };
    const result = await service.initiateUpload(dto);

    expect(result.uploadId).toEqual(mockUploadId);
    expect(result.fileKey).toContain('film.mp4');
    expect(s3ClientInstance.send).toHaveBeenCalledWith(expect.any(CreateMultipartUploadCommand));
  });

  it('seharusnya gagal dan melempar error jika S3 tidak memberi UploadId', async () => {
    s3ClientInstance.send.mockResolvedValueOnce({}); // Respon kosong

    const dto = { filename: 'film.mp4', contentType: 'video/mp4' };
    await expect(service.initiateUpload(dto)).rejects.toThrow('Gagal menginisiasi pengunggahan');
  });
});
```

## Analisis Trade-Off (Kelebihan & Kekurangan)

### Kelebihan
1. **Resiliensi Jaringan Tinggi:** Dapat di-*resume* ketika koneksi terputus. Jika part 3 gagal, klien hanya mengulang part 3, bukan seluruh 2GB file dari part 1.
2. **Kecepatan Paralelisme:** Klien dapat mengunggah Part 1-5 secara paralel memakai beberapa koneksi *worker thread*, sehingga utilisasi *bandwidth* jauh lebih tinggi dibandingkan *stream* tunggal serial.
3. **Bypass Limit Ukuran File:** Bisa mengunggah *file* dengan skala *petabyte* (selama didukung *Object Store*) yang tidak sanggup dilakukan oleh metode PUT objek tunggal yang dibatasi 5GB (seperti di AWS).

### Kekurangan
1. **Kompleksitas Klien Tinggi:** Memerlukan pemrograman *frontend* yang canggih (memecah file dengan API File/Blob, mengelola ETag asinkronus, menangani limit jaringan klien).
2. **Biaya Transaksi (Puts) Meningkat:** Mengunggah 1 file raksasa dengan ukuran potongan kecil (misal 5MB) berpotensi memanggil puluhan ribu operasi PUT yang mana itu memakan biaya API *request* (meski harga/10k request murah).
3. **Penyimpanan Tak Kunjung Selesai (Dangling Parts):** Jika klien tak pernah memanggil fungsi penyelesaian (CompleteMultipartUpload), setiap *part* yang sudah terunggah terus mengonsumsi tagihan penyimpanan.

## Anti-Patterns (Contoh Kode Salah vs Benar)

### Anti-Pattern 1: Mengirim Data Berukuran Berbeda-beda Sembarangan
❌ **Salah:** Membiarkan klien memutuskan bahwa bagian 1 berukuran 2MB, bagian 2 berukuran 3MB. Dalam arsitektur S3, **hanya bagian terakhir** yang boleh berukuran bebas. Bagian 1 s/d N-1 *wajib* berukuran minimum 5MB!
✅ **Benar:** Klien memecah ukuran mutlak secara pasti (misal konstan 5MB) dan sisa akhirnya diberikan di Part terakhir. Server NestJS tidak secara langsung membatasi ini, namun klien harus patuh ke S3 Specs.

### Anti-Pattern 2: ETag Tanpa Sanitasi Tanda Kutip
❌ **Salah:** Langsung mengirimkan `ETag: "8b..."` (dengan *quotes* ganda) ke `CompleteMultipartUploadCommand` yang mana kadang memunculkan *InvalidPart* pada konfigurasi *library* XML internal tertentu jika tidak pas.
✅ **Benar:** Memastikan arsitektur antarmuka antara S3 dan *request frontend* secara tepat meng-*escape* karakter kutip bawaan respons HTTP.

## Production Edge Cases

1. **Abort Lifecycle Rule (Pembersihan Sisa Sampah):** Anda *wajib* mengatur LifeCycle Rule pada S3 bucket yang disebut `AbortIncompleteMultipartUpload`. Contoh: bersihkan operasi multipart yang dibiarkan menggantung setelah 7 hari. Tanpa ini, tagihan S3 akan meledak dari sampah file tak terlihat (parts).
2. **Korupsi Urutan Part (Out-of-Order Parts):** S3 mensyaratkan saat pemanggilan `CompleteMultipartUpload`, susunan `Parts` array harus **berurutan naik** (`1,2,3...`). Jika klien *front-end* mengirim ETag Part 2 sebelum Part 1, NestJS wajib memiliki rutin `.sort()` untuk menangkal hal ini sebelum dikirim ke API S3.
3. **Concurency Throttling Part Token:** Permintaan URL Presigned untuk part yang banyak (misal: array of 10.000 partNumber). NestJS memanggil `await Promise.all` secara liar bisa meledakkan CPU *node* dan berpotensi kena batas AWS API Rate Limit (TooManyRequests). Terapkan batas ukuran *chunk batch* (misal max 100 parts per permintaan token).
