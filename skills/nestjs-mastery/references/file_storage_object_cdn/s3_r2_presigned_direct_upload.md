# Arsitektur Direct-to-Cloud Upload (AWS S3 & Cloudflare R2) dengan Presigned URLs di NestJS

## Pendahuluan
Pendekatan konvensional di mana klien mengunggah file (terutama yang berukuran besar) ke server *backend* NestJS terlebih dahulu, lalu server meneruskannya ke Object Storage (seperti AWS S3 atau Cloudflare R2), adalah **anti-pattern** performa. Hal ini menguras CPU, membebani RAM (terutama jika tidak menggunakan *streams* dengan benar), dan menghabiskan *bandwidth* ganda (klien ke server, server ke S3). Solusi *Enterprise-grade* untuk membebaskan *bottleneck* ini adalah **Direct-to-Cloud Upload** menggunakan mekanisme **Presigned URLs**. 

NestJS berfungsi secara eksklusif sebagai *broker* otoritas—ia memvalidasi akses, menghasilkan *Security Token* atau Presigned URL sementara berumur pendek, lalu memberikannya kepada klien. Klien kemudian mengunggah file *langsung* ke *bucket* S3.

## Diagram Alir Data (Direct Upload Flow)

```ascii
+-------------+                          +--------------------------+
|             | 1. Request Upload URL    |                          |
|  Klien/UI   |------------------------->|   NestJS API (Broker)    |
| (Browser/   | 2. Validasi & Auth       |   - Check Auth/RBAC      |
|  Mobile)    |<-------------------------|   - Generate Presigned   |
|             |    Return Signed URL     |     URL (Umur: 1-5 mnt)  |
+-------------+                          +--------------------------+
      |                                                ^
      |                                                |
      | 3. PUT File directly via Signed URL            | 5. Webhook / S3 Event Notification 
      |    (Bypass Server, No CPU/RAM Tax)             |    (Status: Selesai, Validasi Virus)
      v                                                |
+------------------------------------------------------+
|                 AWS S3 / Cloudflare R2               |
|                                                      |
|   * CORS Policy Dikonfigurasi untuk Klien Origin     |
|   * Object Lifecycle Rules                           |
+------------------------------------------------------+
```

## Konfigurasi CORS Bucket (Prasyarat Wajib)
Sebelum kode bekerja, *bucket* S3/R2 wajib memiliki kebijakan CORS yang memperbolehkan *origin* klien melakukan metode `PUT` dengan *headers* spesifik.

```json
[
    {
        "AllowedHeaders": [
            "*"
        ],
        "AllowedMethods": [
            "PUT",
            "POST"
        ],
        "AllowedOrigins": [
            "https://app.namadomainanda.com"
        ],
        "ExposeHeaders": [
            "ETag"
        ],
        "MaxAgeSeconds": 3600
    }
]
```

## Implementasi TypeScript / NestJS 10+ (Tanpa `any` & No Hardcode)

File: `s3-upload.service.ts`

```typescript
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { extname } from 'path';

export interface PresignedUrlResponse {
  readonly uploadUrl: string;
  readonly fileKey: string;
  readonly expiresInSeconds: number;
}

export interface UploadRequestDto {
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileSize: number;
}

@Injectable()
export class S3UploadService {
  private readonly logger = new Logger(S3UploadService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.getOrThrow<string>('AWS_REGION');
    const accessKeyId = this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY');
    this.bucketName = this.configService.getOrThrow<string>('AWS_S3_BUCKET_NAME');

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  /**
   * Menghasilkan Presigned URL untuk klien agar bisa upload file langsung ke S3.
   */
  public async generatePresignedUrl(
    request: UploadRequestDto,
    userId: string,
  ): Promise<PresignedUrlResponse> {
    const extension = extname(request.fileName);
    // Menyusun key file unik berbasis user dan waktu untuk mencegah collision
    const fileKey = `uploads/users/${userId}/${uuidv4()}${extension}`;
    const expiresInSeconds = 300; // 5 Menit kedaluwarsa

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
      ContentType: request.mimeType,
      ContentLength: request.fileSize, // Menjamin ukuran file sesuai persetujuan awal
    });

    try {
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });

      this.logger.log(`Berhasil menghasilkan presigned URL untuk User ID: ${userId}, Key: ${fileKey}`);

      return {
        uploadUrl,
        fileKey,
        expiresInSeconds,
      };
    } catch (error: unknown) {
      this.logger.error(`Gagal menghasilkan presigned URL: ${(error as Error).message}`, (error as Error).stack);
      throw new InternalServerErrorException('Gagal menghasilkan token pengunggahan. Silakan coba lagi.');
    }
  }
}
```

## Unit / Mock Test Suite menggunakan Jest

File: `s3-upload.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { S3UploadService, UploadRequestDto } from './s3-upload.service';
import * as s3Presigner from '@aws-sdk/s3-request-presigner';

// Melakukan mock fungsi getSignedUrl dari SDK
jest.mock('@aws-sdk/s3-request-presigner');

describe('S3UploadService', () => {
  let service: S3UploadService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        S3UploadService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              const mockConfig: Record<string, string> = {
                AWS_REGION: 'us-east-1',
                AWS_ACCESS_KEY_ID: 'MOCK_ACCESS',
                AWS_SECRET_ACCESS_KEY: 'MOCK_SECRET',
                AWS_S3_BUCKET_NAME: 'mock-bucket',
              };
              return mockConfig[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<S3UploadService>(S3UploadService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('seharusnya menghasilkan presigned URL dan fileKey dengan format yang benar', async () => {
    const mockSignedUrl = 'https://mock-bucket.s3.amazonaws.com/mock-url-signed';
    (s3Presigner.getSignedUrl as jest.Mock).mockResolvedValue(mockSignedUrl);

    const dto: UploadRequestDto = {
      fileName: 'profile.png',
      mimeType: 'image/png',
      fileSize: 1048576,
    };
    const userId = 'usr-12345';

    const result = await service.generatePresignedUrl(dto, userId);

    expect(result.uploadUrl).toEqual(mockSignedUrl);
    expect(result.fileKey).toMatch(new RegExp(`^uploads/users/${userId}/.*\\.png$`));
    expect(result.expiresInSeconds).toBe(300);
    expect(s3Presigner.getSignedUrl).toHaveBeenCalledTimes(1);
  });
});
```

## Analisis Trade-Off (Kelebihan & Kekurangan)

### Kelebihan
1. **Zero Server Tax:** Beban RAM, CPU, dan utilisasi *network adapter* pada *node* NestJS turun drastis, memampukan server menghandle ribuan konkurensi (RPS) tinggi tanpa takut OOM (Out Of Memory).
2. **Keamanan Kredensial (STS):** Klien (Browser/Mobile) tidak pernah mengetahui atau memegang kredensial *bucket* S3, mereka hanya menerima URL otorisasi sementara.
3. **Optimasi Latensi Geografis (Cloudflare R2 / S3 Transfer Acceleration):** Klien berinteraksi langsung dengan *edge* terdekat object storage, mempercepat waktu unggahan.

### Kekurangan
1. **Inkonsistensi State:** File sukses diunggah ke S3, tetapi apabila klien gagal (putus koneksi) sebelum memberi tahu NestJS bahwa file selesai diunggah, terjadi berkas yatim (orphan file) di *bucket*.
2. **Ketergantungan CORS:** Kesalahan sedikit pada konfigurasi header atau *preflight request* akan memblokir unggahan di klien.
3. **Tidak Ada Modifikasi In-flight:** Anda tidak bisa memodifikasi atau me-*resize* (misal: thumbnail gambar) di server Anda secara langsung sebelum disimpan, hal tersebut harus dilempar ke worker/lambda.

## Anti-Patterns (Contoh Kode Salah vs Benar)

### Anti-Pattern 1: Menyimpan Berkas di Memori NestJS Sebelum ke S3
❌ **Salah:** Menerima unggahan di *controller* dengan `FileInterceptor` menjadi `Buffer`, lalu melempar ke S3.
```typescript
@Post('upload')
@UseInterceptors(FileInterceptor('file'))
async uploadFile(@UploadedFile() file: Express.Multer.File) {
  // Bencana RAM jika banyak klien unggah file 100MB+!
  await this.s3Client.send(new PutObjectCommand({ Bucket: 'B', Key: 'K', Body: file.buffer }));
}
```
✅ **Benar:** Menghasilkan token Presigned URL untuk klien unggah langsung, server NestJS terhindar dari pemrosesan berat.

### Anti-Pattern 2: Hardcode Tipe MIME dan Ukuran File
❌ **Salah:** Tidak menetapkan spesifikasi pada `PutObjectCommand`, sehingga klien berpotensi mengelabui ukuran (DDoS Storage) atau tipe file yang dilarang.
✅ **Benar:** Menetapkan `ContentType` dan `ContentLength` secara definit pada `PutObjectCommand`. S3 akan menolak unggahan jika klien melanggar *signed payload headers* ini.

## Production Edge Cases

1. **Orphan Objects Accumulation:** Mengatasi file yatim piatu. Implementasikan S3 Lifecycle Rule yang menghapus otomatis (delete) objek di *folder* `/uploads/` yang umurnya > 24 jam dan belum dipindahkan/direname ke *folder* permanen sebagai tanda validasi berhasil oleh backend.
2. **Malware/Virus Scans:** Pengunggahan langsung berarti file belum dicek. Diperlukan integrasi EventBridge/S3 Notification yang memicu AWS Lambda + ClamAV begitu file tiba. File disimpan di bucket "Quarantine" dan baru digeser ke bucket "Clean" jika aman.
3. **MIME Type Spoofing di Klien:** Klien mungkin mendeklarasikan `image/jpeg` tetapi mengunggah `script.exe`. Perlu ada job latar belakang asinkron (misalnya menggunakan fungsi `file-type` magic bytes scanner) yang memvalidasi header biner file sejati sebelum URL publik diaktifkan.
