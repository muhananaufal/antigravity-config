# Panduan Migrasi Arsitektur NestJS: Express ke Fastify Engine

Migrasi dari Express (engine default NestJS) ke Fastify bukanlah sekadar mengubah adapter di `main.ts`. Ini adalah transisi paradigma dari arsitektur sinkron/callback-based Node.js klasik menuju arsitektur asinkron berkinerja tinggi yang dirancang secara khusus untuk throughput ekstrem dan alokasi memori yang rendah. Panduan ini mengupas tuntas proses migrasi tingkat lanjut, penanganan perbedaan fundamental dalam objek `req/res`, middleware vs interceptor, serta kompromi library pihak ketiga.

## 1. Arsitektur Internal: Express vs Fastify

Fastify menggunakan arsitektur routing berbasis radix-tree (Find-My-Way) dan serialisasi JSON yang dioptimalkan dengan skema (`fast-json-stringify`), berbeda drastis dengan ekspresi reguler berantai milik Express.

```ascii
[Client Request]
       |
+------v------+
| NestJS Core |
+------+------+
       |
       v
+---------------------------------------------------+
|              HTTP Adapter Interface               |
+---------+-------------------------------+---------+
          |                               |
    [Express Adapter]              [Fastify Adapter]
          |                               |
    +-----v-----+                   +-----v-----+
    | Middleware|                   | Hooks     |
    +-----------+                   +-----------+
    | RegEx Rout|                   | Radix Tree|
    +-----------+                   +-----------+
    | JSON.parse|                   | Ajv/Schema|
    +-----------+                   +-----------+
```

## 2. Implementasi Bootstrap Migrasi Mutakhir

Berikut adalah contoh bootstrap aplikasi yang aman, modular, dan type-safe menggunakan `@nestjs/platform-fastify`.

```typescript
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from '@nestjs/common';
import helmet from '@fastify/helmet';

export async function bootstrap(): Promise<NestFastifyApplication> {
  const logger: Logger = new Logger('Bootstrap');
  
  // Instansiasi Fastify Adapter dengan konfigurasi keamanan & performa
  const fastifyAdapter = new FastifyAdapter({
    logger: false, // Gunakan custom logger NestJS di production
    ignoreTrailingSlash: true,
    bodyLimit: 1048576, // 1MB payload limit untuk mencegah serangan DoS
    trustProxy: true, // Diperlukan jika berada di belakang reverse proxy seperti Nginx/AWS ALB
  });

  const app: NestFastifyApplication = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    fastifyAdapter,
    { bufferLogs: true }
  );

  const configService: ConfigService = app.get(ConfigService);
  const port: number = configService.get<number>('PORT') ?? 3000;
  const host: string = configService.get<string>('HOST') ?? '0.0.0.0';

  // Registrasi plugin Fastify native
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
      },
    },
  });

  // Contoh hook Fastify global (opsional, jika tidak menggunakan Interceptor)
  const fastifyInstance: FastifyInstance = fastifyAdapter.getInstance();
  fastifyInstance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    // Validasi header super cepat di layer Fastify sebelum masuk ke lifecycle NestJS
    done();
  });

  app.enableShutdownHooks();
  await app.listen(port, host);
  
  logger.log(`Aplikasi berjalan di http://${host}:${port} dengan Fastify Engine`);
  return app;
}
```

## 3. Kompatibilitas Objek Request dan Response

Perbedaan terbesar adalah Express menggunakan `req` dan `res` yang memperluas objek HTTP asli Node.js. Fastify merangkumnya dalam `FastifyRequest` dan `FastifyReply`.

### Menggunakan Decorator yang Benar

Di controller, jika Anda harus menyentuh objek underlying:

```typescript
import { Controller, Get, Req, Res, HttpStatus } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';

@Controller('v1/health')
export class HealthController {
  
  @Get('ping')
  public checkPing(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply
  ): void {
    // Pastikan tidak menggunakan reply.json() (Express), gunakan reply.send() (Fastify)
    const clientIp: string = request.ips ? request.ips[0] : request.ip;
    
    reply.status(HttpStatus.OK).send({
      status: 'UP',
      ip: clientIp,
      timestamp: new Date().toISOString()
    });
  }

  @Get('standard')
  public checkStandard(): Record<string, string> {
    // Pendekatan terbaik: Biarkan NestJS menangani serialisasi tanpa menyentuh @Res()
    return { status: 'UP' };
  }
}
```

## 4. Analisis Trade-Off Migrasi

**Kelebihan:**
1. **Throughput Luar Biasa:** Mampu menangani hingga 30.000+ req/sec pada perangkat keras standar, memangkas latensi latensi P99 secara drastis dibandingkan Express.
2. **Efisiensi Alokasi Memori:** Fastify meminimalkan overhead *garbage collection* (GC) V8 dengan menggunakan struktur data pra-alokasi dan serialisasi JSON berkinerja tinggi.
3. **Ekosistem Plugin Murni:** Arsitektur plugin Fastify terenkapsulasi secara sempurna, mencegah kebocoran state global antar rute yang sering terjadi pada middleware Express.

**Kekurangan:**
1. **Inkompatibilitas Ekosistem Express:** Pustaka seperti Passport.js, Multer, atau Apollo Server (Express flavor) tidak akan bekerja secara native; membutuhkan penulisan ulang atau penggunaan modul spesifik Fastify.
2. **Kurva Pembelajaran Lifecycle:** Hook Fastify (`onRequest`, `preParsing`, `preValidation`) beroperasi secara independen dan terkadang overlap dengan lifecycle NestJS (Middleware, Guard, Interceptor).
3. **Objek HTTP Berbeda:** Ketergantungan langsung terhadap metode `res.json()`, `res.sendFile()`, atau manipulasi header spesifik Express memerlukan *refactoring* ekstensif.

## 5. Critical Anti-Patterns

### Anti-Pattern 1: Menggantungkan Eksekusi dengan `@Res()` Tanpa Passthrough
Jika Anda menyuntikkan `@Res()` di NestJS, Nest akan menganggap Anda mengelola *response* secara manual. Jika Anda mengembalikan nilai *return* standar tanpa menggunakan `passthrough`, *request* akan hang (berujung pada *timeout*).

❌ **Salah:** Request akan *timeout* karena NestJS menunggu `reply.send()`!
```typescript
import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Controller('users')
export class UserController {
  @Get()
  public getUsers(@Res() reply: FastifyReply): Record<string, string>[] {
    // Bahaya: Menggunakan @Res() tetapi mengembalikan objek secara langsung
    return [{ id: '1', name: 'Alice' }]; 
  }
}
```

✅ **Benar:** Gunakan `passthrough: true` agar NestJS yang menangani serialisasi akhirnya.
```typescript
import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Controller('users')
export class UserController {
  @Get()
  public getUsers(@Res({ passthrough: true }) reply: FastifyReply): Record<string, string>[] {
    // Kita bisa menyetel header spesifik, dan biarkan Nest menserialisasi body
    reply.header('X-Custom-Header', 'Fastify-Migrated');
    return [{ id: '1', name: 'Alice' }]; 
  }
}
```

### Anti-Pattern 2: Menggunakan Express Middleware Pihak Ketiga
Banyak *developer* mencoba menyelundupkan *middleware* Express favorit mereka ke Fastify menggunakan *adapter* kompatibilitas, yang merusak kinerja secara drastis.

❌ **Salah:** Menggunakan ekstensi Express *middleware*.
```typescript
import * as morgan from 'morgan';
// Di dalam bootstrap...
app.use(morgan('combined')); // Merusak performa dan bisa tidak kompatibel dengan req/res Fastify
```

✅ **Benar:** Gunakan *plugin* Fastify native atau NestJS Interceptor murni.
```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: Logger = new Logger(LoggingInterceptor.name);

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: FastifyRequest = context.switchToHttp().getRequest<FastifyRequest>();
    const reply: FastifyReply = context.switchToHttp().getResponse<FastifyReply>();
    const startTimestamp: number = Date.now();

    return next.handle().pipe(
      tap(() => {
        const delay: number = Date.now() - startTimestamp;
        this.logger.log(`${request.method} ${request.url} ${reply.statusCode} - ${delay}ms`);
      }),
    );
  }
}
```

## 6. Production Edge Cases

1. **Reverse Proxy & Client IP Spoofing:** Secara *default*, `request.ip` mungkin menampilkan IP dari *load balancer* (misal: 10.0.x.x di AWS). Anda WAJIB mengkonfigurasi `trustProxy: true` di FastifyAdapter agar Fastify membaca header `x-forwarded-for` secara akurat untuk pencegahan eksploitasi *rate-limiting*.
2. **Timeout Besar & Socket Hang Up:** Saat *client* lambat dan koneksi TCP terputus secara tiba-tiba sebelum Fastify sempat menyelesaikan *reply*, aplikasi bisa *crash* jika tidak ada penanganan galat asinkron yang memadai. Pastikan untuk menangkap `reply.raw.on('close', ...)` pada tugas latar belakang berdurasi panjang.
3. **Konflik CORS Preflight:** Integrasi *plugin* CORS Fastify terkadang bentrok dengan konfigurasi bawaan `app.enableCors()` dari NestJS. Gunakan pendekatan NestJS `app.enableCors()` dan jangan daftarkan `@fastify/cors` secara paralel.

## 7. Unit / Integration Testing Suite

Fastify menyertakan utilitas `.inject()` native untuk pengujian tanpa membuka soket jaringan (jauh lebih cepat daripada Supertest HTTP)!

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Controller, Get, HttpStatus } from '@nestjs/common';

@Controller('ping')
class PingController {
  @Get()
  public ping(): Record<string, string> {
    return { status: 'OK' };
  }
}

describe('Fastify Migration Test Suite', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PingController],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter()
    );
    await app.init();
    // Diperlukan agar Fastify siap melayani permintaan inject
    await app.getHttpAdapter().getInstance().ready(); 
  });

  afterAll(async () => {
    await app.close();
  });

  it('seharusnya mengembalikan respons 200 OK secara instan via fastify.inject()', async () => {
    const fastifyInstance = app.getHttpAdapter().getInstance();
    
    // Injeksi permintaan tanpa port jaringan, bebas latensi socket
    const response = await fastifyInstance.inject({
      method: 'GET',
      url: '/ping',
    });

    expect(response.statusCode).toBe(HttpStatus.OK);
    
    // Pastikan type parse response payload secara aman
    const payload: Record<string, string> = JSON.parse(response.payload);
    expect(payload.status).toBe('OK');
  });
});
```

*Side Note: Pastikan seluruh dependensi pihak ketiga (`multer`, `passport-local`, dll) di audit setelah mengubah base adapter ke Fastify untuk mencegah kebocoran memori (memory leaks).*
