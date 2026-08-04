# Server-Sent Events (SSE) & AI Streaming di NestJS

Dokumen ini mendefinisikan standar **Top 1% Engineering** untuk implementasi `Server-Sent Events` (SSE) di NestJS. Berbeda dengan WebSocket yang bersifat dwiarah (bidirectional), SSE berfokus pada aliran data searah (unidirectional) dari peladen ke klien. SSE sangat cocok untuk *AI text streaming* (misal: ChatGPT style response), indikator progres tugas panjang, dan pembaruan metrik *dashboard* secara waktu nyata (real-time).

## Arsitektur Alur SSE dan Konversi W3C

```ascii
+-------------------+      GET /ai/stream (Accept: text/event-stream)    +-----------------------+
|                   | -------------------------------------------------> |                       |
|   Client (Browser)|                                                    |   NestJS Controller   |
|   EventSource API | <------------------------------------------------- |   (@Sse Decorator)    |
|                   |      HTTP 200 OK (Content-Type: text/event-stream) +-----------+-----------+
+---------+---------+                                                                |
          ^                                                                          |
          |               data: {"chunk": "Hal"} \n\n                                |
          |               data: {"chunk": "lo!"} \n\n                       +--------v--------+
          +-----------------------------------------------------------------|  RxJS Observable|
                          Aliran data chunk persisten                       | (MessageEvent)  |
                                                                            +--------+--------+
                                                                                     |
                                                                            +--------v--------+
                                                                            |  LLM Provider   |
                                                                            | (OpenAI / dsb)  |
                                                                            +-----------------+
```

## Implementasi SSE Controller Berkemampuan Tinggi

Implementasi berikut menangani konversi aliran asinkron dari penyedia AI menjadi `Observable` RxJS yang membungkus setiap *chunk* data ke dalam spesifikasi `MessageEvent` dari W3C.

```typescript
import { Controller, Get, Sse, MessageEvent, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize, from } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { randomUUID } from 'crypto';

// 1. DTO & Interfaces
export interface AiStreamPayload {
  readonly id: string;
  readonly chunk: string;
  readonly isDone: boolean;
}

// 2. Mock AI Service (Contoh Pembangkit Stream Async)
class MockLlmService {
  public async *generateTextStream(prompt: string): AsyncGenerator<string, void, unknown> {
    const chunks = ['Halo', ', ', 'ini', ' ', 'adalah', ' ', 'stream', ' ', 'dari', ' ', 'AI.'];
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 300)); // Simulasi jeda komputasi LLM
      yield chunk;
    }
  }
}

// 3. Controller Implementation
@Controller('ai')
export class AiStreamingController {
  private readonly logger = new Logger(AiStreamingController.name);
  private readonly llmService = new MockLlmService();

  @Sse('stream')
  public streamAiResponse(@Req() req: Request, @Res() res: Response): Observable<MessageEvent> {
    const streamId = randomUUID();
    const clientIp = req.ip || 'unknown';
    this.logger.log(`Klien ${clientIp} memulai stream SSE [ID: ${streamId}]`);

    // Konfigurasi Header untuk mencegah caching dan timeout yang tidak diinginkan
    req.on('close', () => {
      this.logger.log(`Klien ${clientIp} memutus stream secara prematur [ID: ${streamId}]`);
    });

    // Mengubah AsyncGenerator menjadi RxJS Observable
    return from(this.consumeGeneratorAsArray(streamId, 'Ceritakan tentang NestJS')).pipe(
      map((payload: AiStreamPayload): MessageEvent => {
        return {
          id: payload.id,
          type: 'ai-chunk', // Custom event type (event: ai-chunk \n data: {...})
          data: payload,
          retry: 3000,
        };
      }),
      finalize(() => {
        // Dieksekusi ketika stream selesai atau dibatalkan klien
        this.logger.log(`Stream SSE berakhir secara normal atau dibatalkan [ID: ${streamId}]`);
      }),
      catchError((error: Error) => {
        this.logger.error(`Terjadi kesalahan pada stream [ID: ${streamId}]: ${error.message}`);
        // Mengirim chunk error yang bisa ditangani klien tanpa memecahkan format SSE
        return from([{
          data: { error: 'Terjadi kegagalan pembangkitan teks', isDone: true },
          type: 'ai-error',
        } as MessageEvent]);
      })
    );
  }

  /**
   * Helper internal untuk membongkar AsyncGenerator menjadi async array yang dipancarkan satu per satu.
   * Di production nyata, Anda harus menggunakan aliran observasi langsung dari penyedia AI.
   */
  private async *consumeGeneratorAsArray(streamId: string, prompt: string): AsyncGenerator<AiStreamPayload, void, unknown> {
    const generator = this.llmService.generateTextStream(prompt);
    
    for await (const chunk of generator) {
      yield {
        id: streamId,
        chunk: chunk,
        isDone: false,
      };
    }
    
    // Chunk penutup stream
    yield {
      id: streamId,
      chunk: '',
      isDone: true,
    };
  }
}
```

## Unit Test Suite SSE

Menguji rute SSE memerlukan perlakuan khusus terhadap `Observable`. Kita bisa mengumpulkan seluruh emisi hingga *stream* selesai dan memeriksanya.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AiStreamingController, AiStreamPayload } from './ai-streaming.controller';
import { Request, Response } from 'express';
import { MessageEvent } from '@nestjs/common';
import { toArray } from 'rxjs/operators';
import { lastValueFrom } from 'rxjs';

describe('AiStreamingController', () => {
  let controller: AiStreamingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiStreamingController],
    }).compile();

    controller = module.get<AiStreamingController>(AiStreamingController);
  });

  it('harus memancarkan deretan MessageEvent untuk stream AI', async () => {
    const mockRequest = { ip: '127.0.0.1', on: jest.fn() } as unknown as Request;
    const mockResponse = {} as unknown as Response;

    const stream$ = controller.streamAiResponse(mockRequest, mockResponse);
    
    // Mengubah Observable menjadi Promise Array untuk verifikasi urutan emisi
    const events: MessageEvent[] = await lastValueFrom(stream$.pipe(toArray()));
    
    expect(events.length).toBeGreaterThan(0);
    
    // Verifikasi format MessageEvent yang valid
    const firstEvent = events[0];
    expect(firstEvent).toHaveProperty('data');
    expect(firstEvent).toHaveProperty('type', 'ai-chunk');
    
    // Verifikasi chunk terakhir menandakan isDone = true
    const lastEvent = events[events.length - 1];
    expect((lastEvent.data as AiStreamPayload).isDone).toBe(true);
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Lebih Ringan dari WebSocket:** Karena bekerja di atas koneksi HTTP/1.1 standar dan searah, overhead protokol jauh lebih rendah dari abstraksi Socket.io atau WS murni.
2. **Kompabilitas Browser Otomatis:** Klien (*browser*) memiliki kelas `EventSource` bawaan yang menangani penguraian protokol (*parsing* \n\n) dan penanganan koneksi ulang otomatis tanpa pustaka tambahan.
3. **Mudah Menembus Firewall:** Karena memakai rute GET standar lewat port 80/443, proksi perusahaan dan WAF (Web Application Firewall) hampir tidak pernah memblokir koneksi SSE.

### Kekurangan
1. **Unidirectional Strict:** Klien tidak bisa membalas atau mengirim data kembali ke peladen menggunakan soket yang sama. Klien harus melakukan permintaan HTTP baru (POST/PUT).
2. **Keterbatasan Koneksi Maksimum (HTTP/1.1):** Browser tradisional sering membatasi maksimal 6 koneksi persisten HTTP/1.1 per domain secara bersamaan. (Dapat dimitigasi dengan menggunakan HTTP/2).
3. **Kompleksitas State Stream:** Apabila server terhenti (*crash*), sangat sulit melanjutkan kembali *stream* AI dari potongan teks (*chunk*) yang terputus, dibandingkan dengan sekadar me-restart permintaan HTTP biasa.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Disconnect Klien (Zombie Streams)
Jika klien menutup tab browser namun peladen (atau LLM) terus bekerja keras membangkitkan token AI dan mencoba mengirimnya via SSE, server akan membuang CPU dan tagihan API yang mahal.

```typescript
// SALAH: Tidak mengaitkan penghentian generator LLM dengan req.on('close')
req.on('close', () => {
  this.logger.log('Klien pergi, tapi LLM di background masih jalan men-generate token...');
});
```

```typescript
// BENAR: Memicu mekanisme AbortController ke service LLM saat socket tertutup
const abortController = new AbortController();
req.on('close', () => {
  abortController.abort(); // Menghentikan provider external secara paksa
});
```

### ❌ Anti-Pattern 2: Memancarkan Data Tanpa Tipe W3C `MessageEvent`
Hanya melemparkan objek JSON mentah di dalam `Observable` tanpa membungkusnya dalam struktur `{ data: any, id?: string, type?: string }` akan merusak spesifikasi SSE di pihak klien.

```typescript
// SALAH: Memancarkan string biasa
return of('chunk text').pipe(map(text => text)); // NestJS tidak bisa men-serialize ke format `data: xxx \n\n`
```

```typescript
// BENAR: Membungkus dalam MessageEvent interface
return of('chunk text').pipe(map(text => ({ data: { chunk: text } } as MessageEvent)));
```

## Production Edge Cases

1. **Infrastruktur NGINX/Proxy Buffering:** Banyak proksi terbalik (Reverse Proxy) seperti NGINX secara bawaan menggunakan penjanggaan (*buffering*). Alih-alih mengirim token teks per sekian milidetik, NGINX akan menahan respons hingga *buffer* penuh (misal 1MB), merusak ilusi pengaliran "*real-time*".
   - **Mitigasi:** Tambahkan header `X-Accel-Buffering: no` di tingkat aplikasi (NestJS) atau atur `proxy_buffering off;` pada rute lokasi SSE di NGINX.
2. **Resource Leak akibat Observable Tak Terhingga (Infinite Observables):** Penggunaan `interval()` atau aliran RxJS yang tidak di-*teardown* (tanpa `takeUntil` atau `finalize`) akan membocorkan memori setiap kali koneksi diputus secara paksa oleh jaringan yang buruk.
   - **Mitigasi:** Secara ketat tangkap `req.on('close')` atau gunakan operator `takeUntil(clientDisconnect$)` untuk menghancurkan pipa RxJS sepenuhnya.
3. **Batas Timeout Peladen Awan (Cloud Server Timeouts):** Platform *Serverless* atau *Load Balancer* awan (misal AWS ALB, Heroku) sering memiliki konfigurasi batas kedaluwarsa ketat (misal 30 detik untuk *idle HTTP*). SSE akan sering diputus secara paksa.
   - **Mitigasi:** Kirim *Heartbeat Ping* khusus berupa pesan komentar (dimulai dengan titik dua `: heartbeat \n\n` dalam spesifikasi W3C) setiap 15 detik agar infrastruktur awan menganggap koneksi sedang aktif mentransfer data.
