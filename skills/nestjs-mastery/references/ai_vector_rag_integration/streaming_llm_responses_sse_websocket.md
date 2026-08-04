# Streaming Respons LLM: SSE & WebSockets Async Non-Blocking di NestJS

## 1. Pendahuluan
Generative AI, khususnya saat mensintesis balasan teks panjang dengan LLM, memunculkan masalah latensi TTFB (Time-To-First-Byte) yang substansial. Daripada menahan klien koneksi HTTP selama 5 hingga 30 detik untuk menunggu penyelesaian inferensi penuh, topologi asinkron menggunakan Server-Sent Events (SSE) atau WebSockets memampukan penyaluran "token-demi-token" secara real-time. Pada platform berbasis V8 Engine Node.js seperti NestJS, pengolahan I/O *streaming* sangat krusial; bila dibungkus secara keliru (seperti perulangan `while` memblokir sinkron), Event Loop terhambat total.

Dokumen ini menjelaskan strategi tingkat-dewa (Top 1% engineering) untuk menyiarkan respons streaming LLM dari provider seperti OpenAI/Anthropic/Gemini melalui NestJS controllers (SSE) & WebSocket Gateway tanpa race condition, mencegah *memory leaks* dan secara eksplisit mempertahankan arsitektur non-blocking async penuh.

## 2. Diagram Aliran Data Streaming (Async Non-Blocking)

```ascii
+-------------+       (1) HTTP POST / WebSocket Message      +--------------------------+
| Client Apps | -------------------------------------------> | NestJS Gateway/Controller|
| (React/Vue) |                                              | (Auth & Rate Limit Guard)|
+------+------+                                              +------------+-------------+
       | ^ (6)                                                            | (2)
       | | Token Stream (SSE/WS Payload)                                  v
       | |                                                   +--------------------------+
       | |    +--------------------------------+             | LangChain / LLM Service  |
       | +--- | RxJS Subject / Async Generator | <---------- | `.stream(prompt)`        |
       |      +--------------------------------+     (4)     +------------+-------------+
       |               (5) Pipeline Data                     | Async Iter | (3) HTTP/2
       +-----------------------------------------------------+            v
                                                             +--------------------------+
                                                             | OpenAI / Anthropic API   |
                                                             +--------------------------+
```

## 3. Implementasi Produksi NestJS: SSE & WebSockets

### `llm-streaming.service.ts`
Layanan pusat yang mendelegasikan iterasi asinkron dan membangun *Stream*. Semua tipe terjamin (type-safe).
```typescript
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Observable } from 'rxjs';

export interface LlmStreamEvent {
  data: {
    token: string;
    isFinished: boolean;
  };
}

@Injectable()
export class LlmStreamingService {
  private readonly logger = new Logger(LlmStreamingService.name);
  private readonly chatModel: ChatOpenAI;

  constructor(private readonly configService: ConfigService) {
    const openAIApiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!openAIApiKey) {
      throw new InternalServerErrorException('OPENAI_API_KEY is not defined.');
    }

    this.chatModel = new ChatOpenAI({
      openAIApiKey,
      modelName: 'gpt-4o-mini',
      streaming: true, // Flag krusial: Memaksa API merespons dengan chunk HTTP/2
      temperature: 0.7,
    });
  }

  /**
   * Menghasilkan RxJS Observable yang melepaskan (emit) setiap token 
   * untuk di-stream melalui SSE.
   */
  public generateStreamObservable(prompt: string, context: string): Observable<LlmStreamEvent> {
    return new Observable<LlmStreamEvent>((subscriber) => {
      // Async IIFE untuk mengeksekusi I/O tanpa memblokir thread
      (async () => {
        try {
          const messages = [
            new SystemMessage(`Gunakan konteks ini: ${context}`),
            new HumanMessage(prompt)
          ];

          // LangChain me-return AsyncGenerator
          const stream = await this.chatModel.stream(messages);

          for await (const chunk of stream) {
            // Periksa jika koneksi tiba-tiba dibatalkan oleh pengguna (unsubscribe)
            if (subscriber.closed) {
              this.logger.log('Client unsubscribed. Aborting stream.');
              break; 
            }
            
            const content = chunk.content.toString();
            if (content) {
              // Kirim payload token per token (SSE format 'data: {...}')
              subscriber.next({
                data: {
                  token: content,
                  isFinished: false
                }
              });
            }
          }

          // Kirim sinyal pengakhir
          subscriber.next({
            data: { token: '', isFinished: true }
          });
          subscriber.complete();
        } catch (error) {
          this.logger.error(`Stream interrupted: ${(error as Error).message}`);
          subscriber.error(error);
        }
      })();
    });
  }
}
```

### `llm-sse.controller.ts`
Controller khusus Server-Sent Events untuk konsumsi UI berbasis browser ringan.
```typescript
import { Controller, Sse, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { LlmStreamingService, LlmStreamEvent } from './llm-streaming.service';
import { Observable } from 'rxjs';

export class ChatPromptDto {
  prompt: string;
  context: string;
}

@Controller('api/v1/ai')
export class LlmSseController {
  constructor(private readonly llmStreamingService: LlmStreamingService) {}

  /**
   * Endpoint SSE murni yang mempertahankan koneksi HTTP terus terbuka
   * dan menyuplai transfer encoding 'chunked' ke frontend.
   */
  @Post('chat/stream')
  @Sse() // Menandai endpoint untuk mengikat Response NestJS menjadi application/event-stream
  streamChat(
    @Body() payload: ChatPromptDto,
    @Headers('authorization') authHeader: string
  ): Observable<LlmStreamEvent> {
    // Basic guard: memastikan otentikasi.
    if (!authHeader) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    
    return this.llmStreamingService.generateStreamObservable(
      payload.prompt, 
      payload.context
    );
  }
}
```

## 4. Analisis Trade-off

**Kelebihan:**
1. **Reduksi Drastis TTFB:** Time-To-First-Byte turun dari yang tadinya ~10-15 detik (untuk pembuatan ~1000 token teks) menjadi hanya ~300 milidetik, meningkatkan Persepsi Kinerja (Perceived Performance) secara radikal di UX Frontend.
2. **Kesesuaian Event Loop (Non-Blocking):** Dengan memanfaatkan asinkronus Generator (`for await`) dikombinasikan dengan `RxJS Observable`, kode NestJS melepaskan kontrol thread utama V8 secara teratur sehingga concurrent request (HTTP request lain) tidak ikut macet.
3. **Standar Agnostik Protokol (SSE vs WebSocket):** Abstraksi Observable RxJS di dalam Service membuat pipeline generik; aliran yang persis sama dapat langsung diumpankan (pipe) ke NestJS WebSocket Gateway (`@WebSocketGateway()`) maupun SSE HTTP murni (`@Sse()`) tanpa duplikasi *business logic*.

**Kekurangan:**
1. **Kompleksitas Retrying/Error Handling:** Streaming tidak memiliki penanganan *resiliency HTTP* konvensional. Jika di tengah-tengah streaming terjadi pemutusan koneksi TCP mendadak (Connection Reset by Peer), State (status token terkini) sulit direkonstruksi karena *response header* `200 OK` telah dikirimkan duluan ke klien.
2. **Kendala Infrastruktur Load Balancer:** Banyak server HTTP proxy/Load Balancer (seperti Nginx, AWS ALB lama) men-buffer respon HTTP secara default. Jika buffering diaktifkan, chunk-chunk data tertahan di Nginx alih-alih dikirim streaming secara instan ke browser, merusak konsep SSE. Harus diatur secara eksplisit pada reverse proxy (`proxy_buffering off;`).
3. **Pengelolaan State & Cost:** Memantau akumulasi token (seperti `prompt_tokens` dan `completion_tokens`) untuk perhitungan kuota/harga API sangat sulit saat stream berlangsung karena beberapa provider menunda penyediaan metadata final sebelum chunk akhir diteruskan.

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Memblokir Iterasi (Synchronous While/For-Loop Sleep)
Mengakumulasi hasil dari API tanpa memanfaatkan asinkronus iterasi `for await` melainkan menyimulasikan stream dengan metode sleep array string sinkron. Akibatnya V8 Thread Pool terblokir.

```typescript
// ❌ CONTOH SALAH: Memalsukan stream tapi memblokir node.js secara destruktif
const res = await openai.chat.completions.create({ ... }); // 10 detik menunggu sinkron (blocking)
const fullString = res.choices[0].message.content;
const chunks = fullString.split(' ');
for (const chunk of chunks) {
   // thread.sleep tiruan yang merusak Node event loop!
   const start = Date.now(); while(Date.now() - start < 100) {} 
   subscriber.next(chunk);
}
```

**Solusi ✅:** Memanggil metode API bawaan yang mengekstrak HTTP/2 Server Push atau Fetch stream response, dan menggunakan native `for await (const chunk of stream)`.

### ❌ Anti-Pattern 2: Mengabaikan Penutupan Koneksi Client Kematian (Ghost Connections)
Saat pengguna menutup tab browser atau putus koneksi jaringan, backend NestJS terus melanjutkan *request stream* yang mahal dari OpenAI dan tidak menghentikannya, memboroskan komputasi memori & uang API.

```typescript
// ❌ CONTOH SALAH: Memory & Cost Leak karena tidak mengawasi sinyal teardown
const stream = await llm.stream(msgs);
for await (const chunk of stream) {
  // Tidak ada pemeriksaan apakah client subscriber sudah close. 
  // LLM API billing jalan terus meski client offline!
  subscriber.next({ data: chunk.content }); 
}
```

**Solusi ✅:** Secara proaktif memeriksa siklus hidup: `if (subscriber.closed) { break; }` di dalam perulangan `for await`, lalu mengaktifkan sinyal *abort controller* ke provider upstream LLM jika tersedia.

## 6. Kasus Uji Unit & Mock AI Stream

### `llm-streaming.service.spec.ts`
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { LlmStreamingService } from './llm-streaming.service';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';

jest.mock('@langchain/openai');

describe('LlmStreamingService', () => {
  let service: LlmStreamingService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmStreamingService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-openai-key';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LlmStreamingService>(LlmStreamingService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateStreamObservable', () => {
    it('should iterate over async generator and emit tokens correctly', (done) => {
      // Mocking Async Generator dari LangChain ChatOpenAI
      async function* mockGenerator() {
        yield { content: 'Halo' };
        yield { content: ' Dunia' };
        yield { content: '!' };
      }

      // Memaksa ChatOpenAI mock me-return generator tersebut
      const mockStream = jest.fn().mockResolvedValue(mockGenerator());
      (service as any).chatModel = { stream: mockStream } as unknown as ChatOpenAI;

      const observable$ = service.generateStreamObservable('tes', 'konteks');
      
      const emittedTokens: string[] = [];
      let isFinishedFlag = false;

      observable$.subscribe({
        next: (event) => {
          if (event.data.isFinished) {
            isFinishedFlag = true;
          } else {
            emittedTokens.push(event.data.token);
          }
        },
        error: (err) => {
          done(err);
        },
        complete: () => {
          expect(mockStream).toHaveBeenCalled();
          expect(emittedTokens).toEqual(['Halo', ' Dunia', '!']);
          expect(isFinishedFlag).toBe(true);
          done();
        }
      });
    });
  });
});
```

## 7. Production Edge Cases

1. **Proxy Reverse Nginx Buffering Menggagalkan SSE:** Pada tahap Deployment Kubernetes atau VM, respons stream dari NestJS sering tampak tertahan dan tiba-tiba muncul seketika secara utuh di klien UI. Penyebab: Nginx (Ingress/Proxy) memiliki pengaturan proxy_buffering On secara default. Mitigasi: Kirim Header spesifik dari NestJS `X-Accel-Buffering: no` serta konfigurasikan Ingress Nginx annotations `nginx.ingress.kubernetes.io/proxy-buffering: "off"`.
2. **Memory Leak pada Koneksi Websocket Tak Terselesaikan (Dangling Subs):** Apabila kita melempar stream LangChain ke WebSocket (melalui RxJS `.subscribe()`) tetapi user melakukan refresh halaman F5 tanpa prosedur teardown/disconnect yang rapi di server-side Gateway, subscriber tak berujung (dangling subscription) di memori heap NestJS akan bertumpuk memicu OOM Error harian. Mitigasi: Di NestJS Websocket Gateway, intervensi siklus `handleDisconnect(client)` untuk memicu `.unsubscribe()` pada array Subscription lokal.
3. **Throttling Token Klien Cepat:** Terkadang API upstream melempar token luar biasa cepat di luar kemampuan rerender UI frontend (contoh React State Update Bottle-neck), yang menyebabkan tab browser freeze. Mitigasi: Meskipun server NestJS non-blocking, terapkan debounce/throttle mikro di Observable (contoh: `bufferTime(50)` di RxJS) untuk menggabungkan token menjadi sub-chunk demi kelancaran React UI.
