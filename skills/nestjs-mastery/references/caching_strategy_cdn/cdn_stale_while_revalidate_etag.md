# CDN Caching & Koordinasi HTTP Header: Stale-While-Revalidate dan ETag

Pada sistem web terdistribusi kelas berat, membiarkan setiap HTTP Request memukul server *backend* NestJS Anda—bahkan jika dijaga oleh lapisan Redis Cache (L2)—adalah pemborosan latensi dan utilitas server. Lapisan pertahanan terdepan dan terkuat adalah **Content Delivery Network (CDN)** seperti Cloudflare, Fastly, atau AWS CloudFront. 

Untuk mensinkronkan CDN dan kapabilitas browser pengguna, insinyur elit menggunakan injeksi *HTTP Headers* `Cache-Control` yang modern, secara khusus taktik **stale-while-revalidate** digabungkan dengan algoritma **ETag (Entity Tag) SHA256** untuk memvalidasi sidik jari (*fingerprint*) secara efisien.

## Alur Siklus Stale-While-Revalidate di CDN

```ascii
      [Client / Browser]                          [Edge CDN]                           [NestJS Origin]
              |                                       |                                       |
              | 1. Request Data (No Cache)            |                                       |
              |-------------------------------------->| 2. Cache Miss (Fetch Origin)          |
              |                                       |-------------------------------------->|
              | 4. Return Data (Max-age=60)           | 3. Res: 200 OK, ETag: "123"           |
              |<--------------------------------------| Cache-Control: s-maxage=60, swr=86400 |
              |                                       |                                       |
           (65 Detik Kemudian - Cache Stale)          |                                       |
              |                                       |                                       |
              | 5. Request Data                       |                                       |
              |-------------------------------------->| 6. Stale Cache Hit! (Instant Return)  |
              |<--------------------------------------| (Data Lama, tapi cepat!)              |
              |                                       |                                       |
              |                                       | 7. Async Background Revalidate        |
              |                                       |    (If-None-Match: "123")             |
              |                                       |-------------------------------------->| 8. Cek ETag
              |                                       | 9. Res: 304 Not Modified              |    "123" masih valid
              |                                       |<--------------------------------------|
              |                                       | (CDN Cache Reset, Fresh!)             |
```

## Implementasi Produksi NestJS: CDN Cache Interceptor

Kode ini mendemonstrasikan sebuah *Interceptor* global/controller di NestJS yang otomatis menghitung hash SHA256 dari payload JSON respons, membandingkannya dengan header `If-None-Match`, dan me-return HTTP 304 atau menyuntikkan header `Cache-Control: stale-while-revalidate`.

```typescript
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

export interface CdnCacheOptions {
  browserMaxAge: number; // Detik browser menahan cache
  cdnSMaxAge: number;    // Detik CDN menganggap fresh
  staleWhileRevalidate: number; // Detik CDN diizinkan melempar cache basi sembari memanggil origin
}

@Injectable()
export class CdnStaleWhileRevalidateInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CdnStaleWhileRevalidateInterceptor.name);

  constructor(
    private readonly options: CdnCacheOptions = {
      browserMaxAge: 10,
      cdnSMaxAge: 3600, // 1 Jam di Cloudflare
      staleWhileRevalidate: 86400, // 1 Hari toleransi revalidasi background
    },
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Hanya metode baca (GET, HEAD) yang boleh di-cache CDN
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown) => {
        // Abaikan manipulasi jika respon sudah memiliki error status (bukan 200)
        if (res.statusCode >= 300 && res.statusCode !== 304) {
          return data;
        }

        const serializedData = JSON.stringify(data);
        
        // 1. Kalkulasi ETag secara deterministik (Algoritma SHA256 cepat)
        const eTag = `W/"${crypto.createHash('sha256').update(serializedData).digest('hex')}"`;

        // 2. Set instruksi CDN Cache-Control
        const cacheControl = `public, max-age=${this.options.browserMaxAge}, s-maxage=${this.options.cdnSMaxAge}, stale-while-revalidate=${this.options.staleWhileRevalidate}`;
        
        res.setHeader('Cache-Control', cacheControl);
        res.setHeader('ETag', eTag);

        // 3. Bandingkan ETag request client CDN (If-None-Match)
        const clientETag = req.headers['if-none-match'];
        
        if (clientETag && clientETag === eTag) {
          this.logger.debug(`[ETAG MATCH] 304 Not Modified (Path: ${req.url})`);
          // Bypass pengiriman body payload (hemat bandwidth besar)
          res.status(HttpStatus.NOT_MODIFIED);
          return null; // Return kosong, status 304 sudah menandakan client pakai cache-nya
        }

        return data; // Lolos verifikasi, client butuh body baru
      }),
    );
  }
}
```

## Unit Testing & Cache Mock Suite

```typescript
import { CdnStaleWhileRevalidateInterceptor } from './cdn-cache.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import * as crypto from 'crypto';

describe('CdnStaleWhileRevalidateInterceptor', () => {
  let interceptor: CdnStaleWhileRevalidateInterceptor;
  let mockRequest: any;
  let mockResponse: any;
  let mockCallHandler: CallHandler;

  beforeEach(() => {
    interceptor = new CdnStaleWhileRevalidateInterceptor({
      browserMaxAge: 10,
      cdnSMaxAge: 60,
      staleWhileRevalidate: 120,
    });

    mockRequest = { method: 'GET', url: '/api/data', headers: {} };
    mockResponse = {
      statusCode: 200,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    mockCallHandler = { handle: () => of({ foo: 'bar' }) };
  });

  it('seharusnya memotong payload dan return status 304 jika ETag identik', (done) => {
    const payloadJson = JSON.stringify({ foo: 'bar' });
    const expectedETag = `W/"${crypto.createHash('sha256').update(payloadJson).digest('hex')}"`;
    
    // Simulasi client punya ETag dari panggilan sebelumnya
    mockRequest.headers['if-none-match'] = expectedETag;

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as ExecutionContext;

    interceptor.intercept(ctx, mockCallHandler).subscribe((result) => {
      expect(mockResponse.setHeader).toHaveBeenCalledWith('ETag', expectedETag);
      expect(mockResponse.status).toHaveBeenCalledWith(304);
      expect(result).toBeNull(); // Body tidak diikutkan
      done();
    });
  });

  it('seharusnya me-return full payload dan headers jika ETag mismatch (Cache Miss)', (done) => {
    mockRequest.headers['if-none-match'] = 'W/"wrong-etag"';

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as ExecutionContext;

    interceptor.intercept(ctx, mockCallHandler).subscribe((result) => {
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'public, max-age=10, s-maxage=60, stale-while-revalidate=120'
      );
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(result).toEqual({ foo: 'bar' });
      done();
    });
  });
});
```

## Analisis Trade-Off Arsitektur

### Kelebihan
1. **Bandwidth Sabuk Pengaman (Egress Saving):** Status 304 `Not Modified` mencegah server mengirim data payload berukuran megabyte yang sia-sia, memangkas masif biaya tagihan jaringan Cloud (AWS Data Egress).
2. **Latensi UX Kosong (Zero Latency UX):** Melalui fitur *stale-while-revalidate*, CDN Edge akan langsung melemparkan (serve) memori cache basi ke user secara instan, sementara revalidasi origin berjalan asinkron di latar belakang (background origin pull).
3. **Penyebaran Global Edge:** Memindahkan beban L2 Redis dan Database NestJS secara mutlak ke lokasi geografis terdekat pengguna (Cloudflare Edge).

### Kekurangan
1. **Risiko Informasi Stale/Basi Konsumen Utama:** Pengguna mungkin melihat harga barang atau data saham yang tertinggal 60 detik di belakang kebenaran absolut sebelum refresh browser. Tidak cocok untuk endpoint Transaksional Finansial.
2. **Double Komputasi (Serializer & Hash Overhead):** Origin NestJS TETAP harus menjalankan eksekusi DB, mengambil data, dan melakukan serialisasi + hashing SHA256 untuk sekadar mengecek ETag. Ini membebani CPU server NestJS untuk endpoint lambat.
3. **Kesulitan Invalidasi Instan:** Menghapus atau meluruhkan Cache Cloudflare membutuhkan API call eksternal (Purge API) yang rentan error dan lambat, tidak seagresif `redis.del()`.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengenkripsi/Hashing Payload Besar
```typescript
// BUKAN PRAKTIK TOP 1%
// ❌ Hashing body 50MB di event loop utama NestJS
const hash = crypto.createHash('sha256').update(large50MbDataset).digest('hex');
```
**Perbaikan ✅:** Hindari interceptor hash ETag global di memori untuk dataset statis/besar. Gunakan versi ETag berbasis cap waktu perbaruan (`updated_at` epoch) dari database: `ETag: "v1-1683921000"` (O(1) kompleksitas!).

### ❌ Anti-Pattern 2: SWR pada Rute Mutasi atau Autentikasi User
```typescript
// BUKAN PRAKTIK TOP 1%
@UseInterceptors(CdnStaleWhileRevalidateInterceptor)
@Get('/user/wallet/balance') // ❌ BAHAYA: Cache Publik!
```
**Perbaikan ✅:** SWR dan `Cache-Control: public` HANYA untuk aset dan data global nir-identitas (misal katalog produk). Data user privat harus menggunakan `Cache-Control: private, no-cache`.

## Production Edge Cases
1. **Weak vs Strong ETag:** Penanda `W/"..."` menandakan Weak ETag (identik secara semantik). CDN dan proxy (seperti GZip layer) mungkin merekonstruksi byte kompresi yang berbeda. Validasi SWR harus cukup luwes mengenali format weak ETag ini.
2. **Thundering Herd Cloudflare:** Meskipun ada instruksi CDN Cache, di masa *Cold Boot* (Cache kosong sepenuhnya), jutaan request yang serentak (DDoS layer 7) ke CDN akan diteruskan semuanya menembus Origin NestJS jika Cloudflare "Request Collapsing" tidak aktif! (Gunakan Cache Stampede Redlock sebagai lapis kedua).
3. **If-None-Match Array Parser:** Browser versi tua atau proxy proxy eksotik bisa mengirim beberapa ETag dalam satu header koma terpisahkan: `If-None-Match: "a", "b", "c"`. Pastikan parser string regex mencakup *includes* cek, bukan sebatas *exact equal*.
