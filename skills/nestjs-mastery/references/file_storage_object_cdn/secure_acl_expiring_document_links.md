# Pengamanan Akses Dokumen ACL (Expiring Document Links)

## Pendahuluan
Aset statis pada sistem seperti gambar profil (Avatar) seringkali bersifat publik secara *default*, namun berkas tingkat krusial seperti Nota PDF (*Invoices*), Rekam Medis Elektronik, Laporan Keuangan, hingga tiket penerbangan **tidak boleh terbuka untuk umum** atau diletakkan di ember penyimpanan (*Bucket*) yang dapat ditebak polanya. Sistem ini ditangani menggunakan ACL (Access Control Lists) dan *Expiring Signed URLs*.
Berdasarkan pendekatan arsitektur nir-kepercayaan (*Zero-Trust*), semua objek disimpan secara *Private*. Apabila *user* terotentikasi berupaya mengunduh file, server NestJS pertama-tama memverifikasi hak akses pada DB, dan jika disetujui, me-return tautan unduhan sekali pakai/berumur sangat pendek.

Mekanisme token penandatangan otomatis ini melindungi kita dari pencurian tautan, pemalakan (*hotlinking/scraping*), dan membocorkan data *Enterprise* ke indeks Google Bot.

## Diagram Alir Data (Secure ACL Flow)

```ascii
+----------------+                   +----------------------------------+
|    User UI     | 1. Klik Unduh     |        NestJS Backend (API)      |
| (Token Header) |------------------>| 1a. Decode JWT User ID           |
+----------------+ /api/docs/123/url | 1b. Cek Relasi DB (Apakah user   |
       |                             |     ini punya akses doc 123?)    |
       |                             | 1c. Hasilkan Presigned URL S3    |
       | 2. Terima URL Sementara     |     (Berlaku hanya 10 detik!)    |
       |<----------------------------| 1d. Kembalikan ke UI             |
       |                             +----------------------------------+
       |
       | 3. Akses URL Mengunduh File (GET)
       v
+-----------------------------------------------------------------------+
|                       Private Object Storage S3                       |
| - Verifikasi Signature `X-Amz-Signature` di Query String              |
| - Verifikasi Expiration (Jika umur > 10s, Akses Ditolak 403 Forbidden)|
| - Kembalikan Biner PDF ke Klien.                                      |
+-----------------------------------------------------------------------+
```

## Implementasi TypeScript / NestJS 10+ (Tanpa `any` & No Hardcode)

File: `secure-document.service.ts`

```typescript
import { Injectable, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Mocks untuk Service Database/ACL
export interface DocumentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly s3ObjectKey: string;
}

export abstract class DocumentRepository {
  abstract findDocumentById(docId: string): Promise<DocumentRecord | null>;
}

@Injectable()
export class SecureDocumentService {
  private readonly logger = new Logger(SecureDocumentService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly docRepository: DocumentRepository, // Inject repository
  ) {
    this.bucketName = this.configService.getOrThrow<string>('AWS_S3_PRIVATE_BUCKET');
    this.s3Client = new S3Client({
      region: this.configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  /**
   * Menghasilkan tautan kedaluwarsa singkat hanya bila user terbukti memiliki akses.
   */
  public async getExpiringDownloadUrl(documentId: string, currentUserId: string): Promise<string> {
    const docRecord = await this.docRepository.findDocumentById(documentId);

    if (!docRecord) {
      throw new ForbiddenException('Dokumen tidak ditemukan atau akses ditolak');
    }

    // RBAC/ACL Core Logic: Pastikan peminta adalah pemilik, 
    // Di sistem nyata, logika ini bisa kompleks melibatkan Roles/Groups/Organisasi.
    if (docRecord.ownerId !== currentUserId) {
      this.logger.warn(`Pelanggaran akses ACL: User ${currentUserId} mencoba mengakses dokumen ${documentId}`);
      throw new UnauthorizedException('Anda tidak memiliki izin mengunduh berkas ini.');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: docRecord.s3ObjectKey,
        // (Opsional) Memaksa file agar diunduh (ter-download) bukan terbuka di tab baru browser
        ResponseContentDisposition: `attachment; filename="secure_document_${documentId}.pdf"`,
      });

      // TTL (Time to Live) ekstrim singkat. 15 Detik cukup untuk UI langsung memicu unduhan otomatis.
      const urlTtlSeconds = 15;
      
      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: urlTtlSeconds,
      });

      this.logger.log(`URL kedaluwarsa-pendek di-generate untuk Doc ID: ${documentId} (TTL: 15s)`);
      return signedUrl;
    } catch (error: unknown) {
      this.logger.error(`Gagal menghasilkan signed url: ${(error as Error).message}`);
      throw new Error('Terjadi kesalahan pada sistem manajemen dokumen internal.');
    }
  }
}
```

## Unit / Mock Test Suite menggunakan Jest

File: `secure-document.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SecureDocumentService, DocumentRepository, DocumentRecord } from './secure-document.service';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as s3Presigner from '@aws-sdk/s3-request-presigner';

jest.mock('@aws-sdk/s3-request-presigner');

describe('SecureDocumentService', () => {
  let service: SecureDocumentService;
  let docRepository: DocumentRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecureDocumentService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-env-val'),
          },
        },
        {
          provide: DocumentRepository,
          useValue: {
            findDocumentById: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SecureDocumentService>(SecureDocumentService);
    docRepository = module.get<DocumentRepository>(DocumentRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('seharusnya gagal 403 (Forbidden) bila ID dokumen tidak di Database', async () => {
    (docRepository.findDocumentById as jest.Mock).mockResolvedValue(null);
    await expect(service.getExpiringDownloadUrl('fake-doc', 'usr-1')).rejects.toThrow(ForbiddenException);
  });

  it('seharusnya gagal 401 (Unauthorized) bila ID pemilik beda (Hacking/Scraping attempt)', async () => {
    const mockDoc: DocumentRecord = { id: 'doc1', ownerId: 'budi', s3ObjectKey: 'k/1.pdf' };
    (docRepository.findDocumentById as jest.Mock).mockResolvedValue(mockDoc);
    
    // Tono mencoba download dokumen Budi
    await expect(service.getExpiringDownloadUrl('doc1', 'tono')).rejects.toThrow(UnauthorizedException);
  });

  it('seharusnya berhasil memberikan URL jika acl tervalidasi benar', async () => {
    const mockDoc: DocumentRecord = { id: 'doc1', ownerId: 'budi', s3ObjectKey: 'private/1.pdf' };
    (docRepository.findDocumentById as jest.Mock).mockResolvedValue(mockDoc);
    
    (s3Presigner.getSignedUrl as jest.Mock).mockResolvedValue('https://secure-url.com?sig=123');
    
    const result = await service.getExpiringDownloadUrl('doc1', 'budi');
    expect(result).toBe('https://secure-url.com?sig=123');
    expect(s3Presigner.getSignedUrl).toHaveBeenCalledTimes(1);
  });
});
```

## Analisis Trade-Off (Kelebihan & Kekurangan)

### Kelebihan
1. **Keamanan Ekstra Terhadap Pencurian (Anti-Hotlinking):** Jika *link* dicuri dan diposting di media sosial atau *crawler*, setelah 15 detik URL menjadi mati sepenuhnya dan tidak berguna.
2. **Tidak Menguras Bandwidth Server Utama (Egress-Free):** Server hanya melayani token *string* kecil. Saat lalu lintas pengunduhan data (PDF MBs) terjadi, *Cloud Provider* yang menangani lalu lintas itu secara langsung.
3. **Pemisahan Kepentingan Logika Izin Akses:** Database/NestJS menangani kerumitan hirarki izin organisasi *(misal: Boss boleh lihat nota Staff)*, sedangkan *Object Storage* yang kaku hanya cukup tahu tentang memverifikasi keabsahan token.

### Kekurangan
1. **Peningkatan Latensi Waktu Pertama Klik (TTFB):** User tidak bisa seketika mengunduh, ada jeda rute: Klik UI -> API call (verify DB + generate URL) -> terima URL -> Pemicu klik (redirect) -> Browser mulai unduh S3. Jeda waktu mikro bisa terasa oleh jaringan lambat.
2. **Kendala pada Download-Manager (IDM):** Pengaturan durasi `expiresIn` menjadi terlalu cepat (e.g. 5 detik) akan merusak unduhan bagi aplikasi eksternal (*download manager*) yang butuh waktu inisiasi persilangan *handshake*.
3. **Audit Log Penyimpanan vs Aplikasi:** Anda tahu siapa yang *meminta izin* untuk mengunduh, tapi sulit mengetahui 100% apakah orang tersebut berhasil menyedot filenya sampai selesai. Membutuhkan sinkronisasi rumit dengan *AWS CloudTrail Data Events*.

## Anti-Patterns (Contoh Kode Salah vs Benar)

### Anti-Pattern 1: NestJS Berperan Sebagai Proxy Pengunduh
❌ **Salah:** Mengambil biner file dari S3 ke memori server NestJS menggunakan AWS SDK, kemudian server kita menyemburkan (`pipe`) filestream kepada klien HTTP (Buffer passing).
✅ **Benar:** Memanfaatkan properti Redirect atau pengembalian String Token *Presigned Url*, lalu membiarkan browser / klien berurusan langsung mengambil filenya di S3 API Endpoint.

### Anti-Pattern 2: Waktu Kedaluwarsa Dibiarkan Terlalu Panjang
❌ **Salah:** Mencetak token `expiresIn: 86400` (24 jam) untuk unduhan *Invoice* pribadi. Orang dapat mendistribusikan *link* itu di Discord, menyedot ribuan kali, membengkakkan biaya *bandwidth* Anda selama sehari penuh!
✅ **Benar:** Set token sekecil mungkin. Bila untuk *Immediate UI Download*, setel 10 sampai 30 detik maksimum. UI Frontend bertanggung jawab segera me-redirect window/href sesaat setelah menerima respon API.

## Production Edge Cases

1. **Inline vs Attachment Headers (Disposition):** Pada dokumen rahasia, sangat kritis bagi sistem untuk menambahkan `ResponseContentDisposition: "attachment"` agar *browser* selalu melakukan penyimpanan. Menampilkan file PDF di tab *browser* (inline) rentan terekspos karena ekstensi pihak ke-tiga peramban (*Adblocker, PDF readers*) bisa men-*scraping* memori DOM atau me-minta *cache* tabnya!
2. **Struktur Key Mencegah Penyusupan:** Penggunaan hierarki direktori S3 (S3 Object Key) sebaiknya memiliki `UUID`. Hindari kunci mudah ditebak `2024/inv-001.pdf`. Meski file dilindungi *private*, penamaan berkas sekuensial adalah risiko celah jika suatu hari salah setel *bucket ACL*. Penamaan wajib acak semacam `invoices/org_abc_x9f2L.pdf`.
3. **Validasi Clock-Skew (Drift Jam Sistem):** Waktu *expire* di AWS bertumpu pada waktu sistem (`Date.now()` nodejs) ketika *signature* dibuat. Jika jam server NestJS Anda ngaco (melenceng 30 detik lambat/cepat) dari UTC time server, Token AWS Presigned URL langsung gagal saat diakses S3 karena penandatangan terdeteksi tidak valid (*Signature Not Yet Valid / Expired*). Pastikan server NestJS tersinkron NTP secara akurat.
