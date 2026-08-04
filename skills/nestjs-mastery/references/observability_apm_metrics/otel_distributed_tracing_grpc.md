# OpenTelemetry (OTel) Auto-Instrumentation & Distributed Tracing di NestJS

Ekosistem mikroservis (gRPC, HTTP REST, Redis) yang kompleks membutuhkan tingkat visibilitas (observability) tinggi. OpenTelemetry (OTel) hadir sebagai standar industri de-facto untuk mengumpulkan metrik, log, dan traces secara terdistribusi. Pada NestJS, penerapan OTel memastikan bahwa setiap permintaan atau RPC panggilan terlacak dari hulu ke hilir dengan konsistensi *Trace ID* melintasi batas jaringan menuju *backend* seperti Jaeger atau Zipkin.

## 1. Arsitektur Propagasi Trace-ID

Diagram berikut menjelaskan bagaimana `traceparent` Header (W3C standard) merambat dari API Gateway HTTP hingga memicu Job dalam antrean Redis atau RPC ke servis gRPC lain.

```ascii
[Client Request] 
      | (HTTP GET /api/v1/orders)
      V
+-------------------+
|  API Gateway (HTTP)|  --- (Inject Trace ID to headers)
+-------------------+
      | (gRPC: CreateOrder)
      V
+-------------------------+
| gRPC Order Service (Go/ |  <-- (Extract Trace ID via gRPC Metadata)
| Node)                   |  --- (Create Child Span: DB Query)
+-------------------------+
      | (Publish Event to Redis)
      V
+-------------------------+
| Redis Pub/Sub Queue     |  <-- (Serialize Trace ID in payload/headers)
+-------------------------+
      |
      V
+-------------------------+
| Worker / Consumer       |  <-- (Deserialize Trace ID, continue Span)
+-------------------------+
```

## 2. Analisis Trade-Off

### Kelebihan (Pros)
1. **Standar Industri Universal:** Memungkinkan perpindahan backend observabilitas (misalnya dari Jaeger ke Datadog atau NewRelic) tanpa mengubah satu baris pun kode aplikasi (vendor-agnostic).
2. **Korelasi Log dan Metrik:** Menyediakan Trace ID yang dapat diinjeksikan langsung ke dalam log (misalnya Pino) sehingga troubleshooting lintas servis menjadi trivial.
3. **Visibilitas Bottleneck:** Memudahkan deteksi *bottleneck* performa latensi mikrolayanan, kueri database (ORM), atau panggilan API pihak ketiga (eksternal).

### Kekurangan (Cons)
1. **Overhead CPU dan Memori:** *Auto-instrumentation* memakan resource lebih banyak dan menambah overhead pada *garbage collector*, khususnya dalam lingkungan *high throughput*.
2. **Biaya Penyimpanan (Storage Cost):** Data traces sangat besar. Jika tidak ada mekanisme *sampling* (misalnya *tail-based sampling* atau rate limiting 10%), tagihan infrastruktur atau SaaS APM akan meledak.
3. **Kompleksitas Setup:** Mengonfigurasi `OpenTelemetry SDK`, `BatchSpanProcessor`, dan eksportir (*exporters*) secara sinkron sebelum siklus hidup framework NestJS aktif kadang menyebabkan kondisi *race*.

## 3. Production Edge Cases

1. **Context Loss Across Promises:** Terkadang *Async Hooks* di NodeJS kehilangan konteks di *library* yang *non-standard* atau pada koneksi native C++ (misalnya modul `pg` versi lama). Solusi: Selalu pastikan menggunakan versi pustaka terbaru yang didukung *auto-instrumentation* OTel.
2. **Traces Tak Berujung (Long-lived Streams):** WebSockets atau gRPC streaming dapat menghasilkan span yang sangat panjang (berhari-hari). Solusi: Lakukan *manual instrumentation* pada pesan individual di dalam stream daripada melacak seluruh koneksi dalam satu *span*.
3. **Sensitive Data Leakage:** HTTP auto-instrumentation berpotensi mengekspos header otorisasi atau body payload rahasia (PII). Solusi: Wajib mendefinisikan *hook* redaksi untuk membersihkan atribut sebelum span di-eksport.

## 4. Anti-Patterns Kritis

### Anti-Pattern 1: Menginisialisasi OTel setelah aplikasi NestJS *bootstrap*
**❌ Salah:** OTel tidak dapat membungkus fungsi NodeJS `require` jika diinisialisasi terlambat.
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startOtel } from './otel';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // OTel dijalankan TERLAMBAT! Modul HTTP/Express/gRPC sudah di-load.
  startOtel(); 
  await app.listen(3000);
}
```

**✅ Benar:** OTel diinisialisasi dalam berkas *entry point* terpisah yang di-*import* atau dieksekusi **sebelum** aplikasi utama.
```typescript
// tracing.ts (Wajib di-load pertama)
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';

const exporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'grpc://localhost:4317',
});

export const otelSDK = new NodeSDK({
  traceExporter: exporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

// main.ts
import './tracing'; // LOAD PERTAMA KALI
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { otelSDK } from './tracing';

async function bootstrap() {
  await otelSDK.start();
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

### Anti-Pattern 2: Tidak menutup span custom (Memory Leak)
**❌ Salah:** Menggunakan API manual tetapi melewatkan `span.end()`.
```typescript
const span = tracer.startSpan('heavy-task');
await doHeavyTask();
// LUPA span.end(); -> MEMORY LEAK!
```

**✅ Benar:** Selalu gunakan *try-finally* atau decorator kustom.
```typescript
const span = tracer.startSpan('heavy-task');
try {
  await doHeavyTask();
} finally {
  span.end();
}
```

## 5. Implementasi Custom Span (Decorator & Interceptor)

Untuk servis atau *method* spesifik (misalnya kalkulasi yang tidak memanggil I/O), kita memerlukan *custom span*.

### OTel Trace Service
```typescript
import { Injectable } from '@nestjs/common';
import { trace, Span, Tracer, SpanStatusCode } from '@opentelemetry/api';

@Injectable()
export class TraceService {
  private readonly tracer: Tracer;

  constructor() {
    this.tracer = trace.getTracer('nestjs-application');
  }

  public getTracer(): Tracer {
    return this.tracer;
  }

  public startSpan(name: string): Span {
    return this.tracer.startSpan(name);
  }

  public setSpanError(span: Span, error: Error): void {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
}
```

### Trace Decorator (@Trace())
```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';

export function Trace(spanName?: string): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value;
    const name = spanName ?? String(propertyKey);

    descriptor.value = async function (...args: unknown[]) {
      const tracer = trace.getTracer('nestjs-application-decorator');
      return tracer.startActiveSpan(name, async (span) => {
        try {
          // eslint-disable-next-line @typescript-eslint/ban-types
          const result = await (originalMethod as Function).apply(this, args);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          if (error instanceof Error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          }
          throw error;
        } finally {
          span.end();
        }
      });
    };
    return descriptor;
  };
}
```

## 6. Unit Testing Suite (Logger & Context Tracking Mocks)

Meskipun sulit untuk menguji integrasi OTel sepenuhnya tanpa APM, kita dapat *mock* tracer API.

```typescript
import { TraceService } from './trace.service';
import { trace, Tracer, Span } from '@opentelemetry/api';
import { Trace } from './trace.decorator';

// Class tiruan yang menggunakan dekorator
class DummyService {
  @Trace('dummy-span')
  public async doSomething(success: boolean): Promise<string> {
    if (!success) throw new Error('Failed');
    return 'Success';
  }
}

describe('OpenTelemetry Integration', () => {
  let traceService: TraceService;

  beforeEach(() => {
    traceService = new TraceService();
  });

  it('TraceService should start a valid span', () => {
    const mockSpan = { end: jest.fn(), setStatus: jest.fn() } as unknown as Span;
    const mockTracer = { startSpan: jest.fn().mockReturnValue(mockSpan) } as unknown as Tracer;
    
    jest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer);
    
    const service = new TraceService();
    const span = service.startSpan('test-operation');
    
    expect(trace.getTracer).toHaveBeenCalledWith('nestjs-application');
    expect(mockTracer.startSpan).toHaveBeenCalledWith('test-operation');
    expect(span).toBeDefined();
  });

  it('Trace Decorator should wrap execution in a span and end it', async () => {
    const mockSpan = { 
      end: jest.fn(), 
      setStatus: jest.fn(),
      recordException: jest.fn() 
    } as unknown as Span;
    
    const mockTracer = { 
      startActiveSpan: jest.fn().mockImplementation((name, cb) => cb(mockSpan)) 
    } as unknown as Tracer;
    
    jest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer);

    const dummy = new DummyService();
    const result = await dummy.doSomething(true);
    
    expect(result).toBe('Success');
    expect(mockTracer.startActiveSpan).toHaveBeenCalled();
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // OK
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('Trace Decorator should record exceptions on failure', async () => {
    const mockSpan = { 
      end: jest.fn(), 
      setStatus: jest.fn(),
      recordException: jest.fn() 
    } as unknown as Span;
    
    const mockTracer = { 
      startActiveSpan: jest.fn().mockImplementation((name, cb) => cb(mockSpan)) 
    } as unknown as Tracer;
    
    jest.spyOn(trace, 'getTracer').mockReturnValue(mockTracer);

    const dummy = new DummyService();
    
    await expect(dummy.doSomething(false)).rejects.toThrow('Failed');
    
    expect(mockTracer.startActiveSpan).toHaveBeenCalled();
    expect(mockSpan.recordException).toHaveBeenCalled();
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'Failed' }); // ERROR
    expect(mockSpan.end).toHaveBeenCalled();
  });
});
```
