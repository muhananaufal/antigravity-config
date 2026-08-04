# Arsitektur Serverless: NestJS via AWS Lambda & `@vendia/serverless-express`

## Pendahuluan

Menjalankan aplikasi NestJS di atas AWS Lambda membutuhkan strategi khusus untuk memastikan performa maksimal dan efisiensi biaya. Secara bawaan, NestJS dikembangkan untuk berjalan sebagai server HTTP jangka panjang (seperti Express atau Fastify). Di dalam lingkungan *serverless*, fungsi Lambda dapat dibekukan (frozen) dan dihidupkan kembali sesuai dengan volume trafik. Oleh karena itu, kita memanfaatkan paket `@vendia/serverless-express` untuk menerjemahkan event API Gateway menjadi permintaan HTTP (request) dan memetakannya ke instans NestJS yang telah dicache di memori eksekusi Lambda.

## Arsitektur Sistem (API Gateway ke NestJS)

```ascii
+-------------------+        +----------------------+        +-----------------------+
|                   |        |                      |        |                       |
|   Amazon API      +------->+   AWS Lambda         +------->+  @vendia/serverless-  |
|   Gateway (HTTP/  |        |   (Execution Context)|        |  express (Adapter)    |
|   REST)           |        |                      |        |                       |
+-------------------+        +----------------------+        +-----------+-----------+
                                                                         |
                                                                         | Request & Response Mapping
                                                                         v
                                                             +-----------+-----------+
                                                             |                       |
                                                             |   NestJS Application  |
                                                             |   (Singleton Cached)  |
                                                             |                       |
                                                             +-----------------------+
```

## Implementasi Produksi (Type-Safe & Cached App)

### 1. Konfigurasi `app.module.ts`

```typescript
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Registrasi middleware keamanan atau logging di sini jika diperlukan
  }
}
```

### 2. Handler Lambda Produksi (`serverless.ts`)

Kunci dari performa serverless adalah menempatkan proses *bootstrap* aplikasi NestJS di luar fungsi handler. Ini memastikan aplikasi hanya di-inisialisasi sekali per "Cold Start" dan digunakan ulang untuk "Warm Start".

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import serverlessExpress from '@vendia/serverless-express';
import { Handler, Context, APIGatewayProxyEvent, Callback } from 'aws-lambda';
import { ValidationPipe, INestApplication } from '@nestjs/common';

// Variabel global untuk caching instans serverless
let cachedServer: Handler | undefined = undefined;

async function bootstrapServer(): Promise<Handler> {
  if (!cachedServer) {
    const app: INestApplication = await NestFactory.create(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    app.enableCors({
      origin: process.env.CORS_ORIGIN ?? '*',
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    const expressApp = app.getHttpAdapter().getInstance();
    
    // Inisialisasi adapter serverless-express
    cachedServer = serverlessExpress({ app: expressApp });
  }
  
  return cachedServer;
}

export const handler: Handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
  callback: Callback,
): Promise<unknown> => {
  try {
    const server: Handler = await bootstrapServer();
    return server(event, context, callback);
  } catch (error: unknown) {
    console.error('Fatal Error during NestJS initialization in Lambda', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Internal Server Error',
        errorId: context.awsRequestId,
      }),
    };
  }
};
```

## Unit Testing & Handler Mock Suite

Pengujian harus memvalidasi bahwa aplikasi NestJS hanya di-bootstrap satu kali saat handler dipanggil berkali-kali.

```typescript
import { handler } from './serverless';
import { APIGatewayProxyEvent, Context, Callback } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Mock NestFactory
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));

// Mock @vendia/serverless-express
jest.mock('@vendia/serverless-express', () => {
  return jest.fn().mockImplementation(() => {
    return jest.fn().mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ message: 'Success' }),
    });
  });
});

describe('Lambda Serverless Express Handler', () => {
  let mockEvent: APIGatewayProxyEvent;
  let mockContext: Context;
  let mockCallback: Callback;
  let mockAppInit: jest.Mock;
  let mockGetHttpAdapter: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockAppInit = jest.fn().mockResolvedValue(true);
    mockGetHttpAdapter = jest.fn().mockReturnValue({
      getInstance: jest.fn().mockReturnValue({}),
    });

    (NestFactory.create as jest.Mock).mockResolvedValue({
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
      init: mockAppInit,
      getHttpAdapter: mockGetHttpAdapter,
    });

    mockEvent = {
      httpMethod: 'GET',
      path: '/api/users',
      headers: {},
      queryStringParameters: null,
      body: null,
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEvent;

    mockContext = {
      awsRequestId: 'req-1234',
      functionName: 'nestjs-api-lambda',
    } as unknown as Context;

    mockCallback = jest.fn();
  });

  afterEach(() => {
    // Reset global cache in implementation by resetting modules
    jest.resetModules();
  });

  it('harus mem-bootstrap aplikasi NestJS pada eksekusi pertama', async () => {
    const result = await handler(mockEvent, mockContext, mockCallback);
    
    expect(NestFactory.create).toHaveBeenCalledTimes(1);
    expect(mockAppInit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      statusCode: 200,
      body: JSON.stringify({ message: 'Success' }),
    });
  });

  it('harus menggunakan instans yang dicache pada eksekusi kedua', async () => {
    // Panggilan Pertama
    await handler(mockEvent, mockContext, mockCallback);
    
    // Panggilan Kedua
    await handler(mockEvent, mockContext, mockCallback);
    
    // NestFactory.create tetap hanya dipanggil 1 kali
    expect(NestFactory.create).toHaveBeenCalledTimes(1);
  });

  it('harus mengembalikan 500 jika bootstrap gagal', async () => {
    (NestFactory.create as jest.Mock).mockRejectedValueOnce(new Error('DB Connection Failed'));

    const result = await handler(mockEvent, mockContext, mockCallback);

    expect(result).toEqual({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Internal Server Error',
        errorId: 'req-1234',
      }),
    });
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Zero Server Management:** Bebas dari pengelolaan infrastruktur instans EC2 atau node Kubernetes. Kapasitas meningkat otomatis sesuai permintaan (auto-scaling absolut).
2. **Cost-Effective (Pay-per-use):** Anda hanya membayar untuk waktu eksekusi aktual saat permintaan diproses (hingga tingkat milidetik), sangat hemat untuk trafik sporadis.
3. **Ekosistem NestJS Utuh:** Mengizinkan penggunaan seluruh fitur canggih NestJS (Guards, Interceptors, Pipes, Dependency Injection) tanpa perlu menulis ulang logika ke fungsi Lambda tradisional murni.

### Kekurangan
1. **Cold Starts:** Boot up awal lingkungan eksekusi dan framework NestJS (IoC Container) bisa lambat (seringkali > 1 detik jika ukuran paket besar), yang bisa menjadi masalah untuk aplikasi latency-sensitive.
2. **Keterbatasan Payload & Timeout:** API Gateway + Lambda memiliki batasan bawaan (maksimum payload 10MB dan batas waktu maksimal 30 detik untuk eksekusi API Gateway).
3. **Friction Pengembangan Lokal:** Mengemulasikan API Gateway dan AWS Lambda secara persis di lingkungan lokal bisa rumit (walaupun bisa difasilitasi oleh serverless-offline atau AWS SAM).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Inisialisasi Aplikasi di Dalam Fungsi Handler
**Mengapa salah?** Menyebabkan koneksi ulang ke database dan re-inisialisasi Dependency Injection NestJS pada SETIAP pemanggilan HTTP request. Membunuh performa.

```typescript
// SALAH: Jangan lakukan ini!
export const handler: Handler = async (event, context, callback) => {
  // NestFactory berjalan di setiap request API!
  const app = await NestFactory.create(AppModule);
  await app.init();
  const server = serverlessExpress({ app: app.getHttpAdapter().getInstance() });
  return server(event, context, callback);
};
```

### ✅ Best Practice: Inisialisasi Global / Singleton Caching
```typescript
// BENAR: Deklarasi global scope di luar handler
let cachedServer: Handler;

async function bootstrap() {
  if (!cachedServer) {
    const app = await NestFactory.create(AppModule);
    await app.init();
    cachedServer = serverlessExpress({ app: app.getHttpAdapter().getInstance() });
  }
  return cachedServer;
}

export const handler: Handler = async (event, context, callback) => {
  const server = await bootstrap();
  return server(event, context, callback);
};
```

### ❌ Anti-Pattern 2: Tidak Menutup Koneksi Saat Lambda Terminate (Leak)
**Mengapa salah?** Meskipun Lambda ter-pause saat warm, AWS dapat menghancurkan container tanpa peringatan. Tanpa penanganan sinyal yang tepat, koneksi DB yang tertinggal bisa menggantung di server DB.

```typescript
// SALAH: Tidak mengaktifkan lifecycle hooks
const app = await NestFactory.create(AppModule);
await app.init();
// Lambda container di-destroy, koneksi DB (Prisma/TypeORM) ditinggalkan terbuka.
```

### ✅ Best Practice: Enable EnableShutdownHooks (Jika Relevan)
Namun dalam konteks Lambda standar, `enableShutdownHooks` tidak akan selalu menerima sinyal SIGTERM dari AWS dengan sempurna tanpa ekstensi Lambda, tetapi penting untuk membersihkan resources sebisa mungkin dalam pola yang didukung:
```typescript
// BENAR: Pertimbangkan perilaku shutdown
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); 
await app.init();
```

## Production Edge Cases

1. **Database Connection Pool Exhaustion:** Karena Lambda dapat berskala hingga ratusan instance secara instan (Burst Concurrency), koneksi database relasional tradisional (seperti PostgreSQL) bisa hancur (Too Many Connections).
   - **Solusi:** Gunakan RDS Proxy (AWS) atau fitur pooling eksternal seperti PgBouncer. Hindari koneksi langsung tanpa manajemen pooler terpusat.
2. **Keterbatasan Ukuran Response/Upload (Payload Limit):** API Gateway secara keras menolak request/response > 10MB.
   - **Solusi:** Implementasikan mekanisme pengunggahan/pengunduhan S3 Pre-signed URL langsung dari klien (Frontend -> S3). NestJS hanya membuat URL dan memvalidasi izin, bukan mem-proxy file binernya.
3. **Penyusutan Kinerja karena Ukuran Paket (Bundle Size):** Jika seluruh `node_modules` di-deploy secara mentah, file zip Lambda menjadi > 200MB, membuat cold start memakan waktu hingga > 5 detik.
   - **Solusi:** Gunakan Webpack atau ESBuild untuk meminifikasikan, tree-shaking, dan menggabungkan aplikasi NestJS menjadi satu berkas JavaScript `main.js` tunggal sebelum di-deploy ke Lambda, menekan ukuran dari puluhan megabyte menjadi hanya 2-3MB.
