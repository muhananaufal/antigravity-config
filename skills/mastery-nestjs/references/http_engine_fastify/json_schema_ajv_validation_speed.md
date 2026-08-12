# Akselerasi Validasi JSON: Ajv Schema vs Class-Validator di Fastify

Ketika menangani lalu lintas ekstrem (misalnya, sistem *ticketing* HFT, proses *webhook* masif, atau platform IoT berskala miliaran), validasi *payload* JSON bisa menjadi *bottleneck* CPU utama. Di NestJS klasik, kita menggunakan `class-validator` berbasis refleksi TypeScript. Sayangnya, untuk performa puncak, ia sangat lambat dibandingkan dengan kompilasi statis dari **Ajv** yang diusung secara asli oleh Fastify. Panduan ini menjelaskan cara mem-bypass pipa validasi lambat dengan JSON Schema native.

## 1. Arsitektur Kompilasi Validasi

Pendekatan `class-validator` mengeksekusi iterasi rekursif dan pengecekan objek saat *runtime*. Sebaliknya, Fastify mendelegasikan validasi ke **Ajv** yang mengkompilasi *JSON Schema* menjadi fungsi JavaScript mentah (`new Function(...)`) pada saat aplikasi *booting*—menghasilkan eksekusi dengan kinerja "zero overhead".

```ascii
[Client Request: JSON Payload]
         |
         | (1) Route Hit
         v
+-----------------------------+
|    Fastify Hook: preHandler |
|                             |
|  [ Ajv Compiled Function ]  | <--- (2) Dieksekusi secara native, Cepat!
|    - Type Check             |
|    - Format Check           |
+-------------+---------------+
              | (3) Jika Valid
              v
+-----------------------------+
|    NestJS Interceptors      |
|    NestJS Controller        |
+-----------------------------+
```

## 2. Implementasi Schema Validasi Ajv di NestJS Fastify

Alih-alih menggunakan decorator `@IsString()` dari `class-validator`, kita mendefinisikan skema JSON dan menyuntikkannya secara langsung ke level rute Fastify.

```typescript
import { Controller, Post, Body, Req, Res, HttpStatus } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';

// Tipe statis TypeScript murni
export interface CreateTransactionDto {
  amount: number;
  currency: string;
  idempotencyKey: string;
}

// JSON Schema yang ketat (Strict Mode Ajv)
const createTransactionSchema = {
  type: 'object',
  required: ['amount', 'currency', 'idempotencyKey'],
  properties: {
    amount: { type: 'number', minimum: 1 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    idempotencyKey: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false, // Penting untuk mencegah injeksi field berbahaya
};

@Controller('v1/transactions')
export class TransactionController {
  
  // Karena NestJS menyembunyikan konfigurasi route Fastify, kita harus mengkustomisasinya.
  // Salah satu cara adalah mendaftarkan schema langsung ke instance Fastify
  // Namun pendekatan NestJS-friendly adalah membuat Custom Decorator / Pipe khusus, 
  // atau melakukan registrasi skema dinamis di onModuleInit.

  // Cara terbaik untuk rute ultra-cepat: Registrasi Rute Fastify Murni di dalam Controller
  constructor() {}
}
```

### Implementasi via Plugin / Bootstrapping untuk Kinerja Maksimal

Untuk menjembatani NestJS dan Fastify murni, kita bisa meregistrasikan rute dengan *schema* langsung pada level adaptor untuk titik akhir (*endpoints*) yang membutuhkan kecepatan gila-gilaan, dan membiarkan rute lainnya ditangani NestJS biasa.

```typescript
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

@Injectable()
export class FastifySchemaService implements OnApplicationBootstrap {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  public onApplicationBootstrap(): void {
    const fastify: FastifyInstance = this.adapterHost.httpAdapter.getInstance();

    const schema = {
      body: {
        type: 'object',
        required: ['eventId', 'timestamp'],
        properties: {
          eventId: { type: 'string' },
          timestamp: { type: 'integer' }
        },
        additionalProperties: false
      }
    };

    // Endpoint ultra-cepat tanpa overhead NestJS Controller/Guards 
    // Berguna untuk webhook Ingestion 100k+ req/sec
    fastify.post('/v1/fast-ingest', { schema }, async (request: FastifyRequest, reply: FastifyReply) => {
      // payload sudah pasti tervalidasi di sini
      const payload: { eventId: string; timestamp: number } = request.body as any;
      
      return reply.code(201).send({ status: 'Ingested', id: payload.eventId });
    });
  }
}
```

## 3. Analisis Trade-Off

**Kelebihan:**
1. **Kecepatan Validasi Ekstrem:** Hingga 10x lebih cepat dari `class-validator` karena *compiled validation function* dan absennya instansiasi kelas berulang.
2. **Serialisasi Output Super Cepat:** Jika Anda menyertakan *response schema* (`schema: { response: { 200: {...} } }`), `fast-json-stringify` mem-bypass `JSON.stringify` standar, menggandakan kecepatan serialisasi data.
3. **Spesifikasi Standar (OpenAPI Ready):** JSON Schema bersifat universal, mudah diubah menjadi dokumentasi Swagger, kontrak API, atau divalidasi silang oleh *frontend* (misal: RHF + Ajv).

**Kekurangan:**
1. **Duplikasi Type System:** Anda harus memelihara JSON Schema (untuk runtime) dan TypeScript Interfaces (untuk kompilasi statis) secara terpisah, kecuali Anda menggunakan library generator otomatis seperti `typebox` atau `zod-to-json-schema`.
2. **Pesan Galat Terbatas:** Pesan galat *default* Ajv agak sulit dibaca oleh pengguna akhir dibandingkan pesan kustom intuitif dari `class-validator`.
3. **Bypass Pipa NestJS:** Jika didaftarkan di tingkat Fastify langsung, Anda akan kehilangan dukungan *built-in* NestJS seperti `Interceptors`, `Exception Filters`, dan `Guards`.

## 4. Critical Anti-Patterns

### Anti-Pattern 1: Menyusun Skema Dinamis per-Request
Kompilasi skema Ajv adalah operasi sinkron yang sangat mahal. Menyusun atau mengubah skema saat runtime untuk setiap permintaan akan membunuh (OOM/CPU 100%) server Anda.

❌ **Salah:** Menginstansiasi Ajv di dalam penangan rute.
```typescript
import Ajv from 'ajv';
import { FastifyRequest, FastifyReply } from 'fastify';

async function badHandler(req: FastifyRequest, res: FastifyReply): Promise<void> {
  const ajv: Ajv = new Ajv(); // MALAPETAKA: Instansiasi objek mahal per-request
  const validate = ajv.compile({ type: 'object' }); // Operasi pemblokiran CPU per-request
  if (!validate(req.body)) {
    return res.status(400).send('Invalid');
  }
}
```

✅ **Benar:** Kompilasi skema secara statis pada fase *bootstrapping*.
```typescript
import Ajv, { ValidateFunction } from 'ajv';
import { FastifyRequest, FastifyReply } from 'fastify';

const ajv: Ajv = new Ajv();
// Kompilasi dijalankan HANYA SEKALI saat startup aplikasi
const validate: ValidateFunction = ajv.compile({ 
  type: 'object',
  properties: { id: { type: 'number' } }
}); 

async function goodHandler(req: FastifyRequest, res: FastifyReply): Promise<void> {
  if (!validate(req.body)) {
    return res.status(400).send({ error: validate.errors });
  }
}
```

### Anti-Pattern 2: `additionalProperties: true` pada Endpoint Sensitif
Mengizinkan properti tak dikenal di *payload* akan mengundang bahaya pengubahan status secara massal (*Mass Assignment*).

❌ **Salah:** Tidak mendefinisikan batasan properti secara eksplisit.
```typescript
const badSchema = {
  type: 'object',
  properties: { username: { type: 'string' } }
  // additionalProperties true secara implisit
};
```

✅ **Benar:** Secara tegas memblokir properti siluman.
```typescript
const goodSchema = {
  type: 'object',
  properties: { username: { type: 'string' } },
  additionalProperties: false // Memblokir injeksi field is_admin: true
};
```

## 5. Production Edge Cases

1. **Denial of Service (DoS) via Payload Raksasa:** Sekalipun Ajv sangat cepat, *parsing* awal JSON di Node.js bersifat *blocking*. Pastikan `bodyLimit` di Fastify disetel ke ukuran minimal yang rasional (misalnya 512KB) untuk mencegah serangan payload besar melumpuhkan *event loop*.
2. **Regex Catastrophic Backtracking dalam Skema:** Jika skema Anda menggunakan format *regex* yang kompleks, *hacker* bisa mengeksploitasi ReDoS (Regular Expression DoS). Gunakan opsi Ajv `safe: true` (via `ajv-keywords` / konfigurasi ReDoS) untuk memastikan waktu komputasi regex yang terukur.
3. **Sirkuler Referensi (Circular Reference):** Validasi *body* JSON yang memiliki objek dengan siklus melingkar akan menyebabkan rekursi tak terbatas (stack overflow) pada validasi lambat atau JSON parser bodoh. Secara arsitektur, jangan pernah memperbolehkan referensi objek rekursif murni tanpa pembatasan kedalaman (Max Depth limit).

## 6. Unit / Inject Test Suite

Berikut adalah uji validasi menggunakan *Fastify Inject* murni untuk membuktikan akselerasi validasi bekerja secara aman.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Controller, Post, Body, HttpStatus, INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

// Simulasi Fastify Schema Hook
describe('Ajv Validation Acceleration Test Suite', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter()
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const fastify = app.get(HttpAdapterHost).httpAdapter.getInstance();
    
    // Registrasi endpoint ultra-fast dengan skema
    fastify.post('/fast', {
      schema: {
        body: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'number', minimum: 100 }
          },
          additionalProperties: false
        }
      }
    }, (req: any, reply: any) => reply.send({ success: true }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('harus menolak request dengan struktur ilegal secara instan tanpa menyentuh controller', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/fast',
      payload: { userId: 50 } // Minimum 100
    });

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body: Record<string, unknown> = JSON.parse(response.payload);
    expect(body.message).toContain('body/userId must be >= 100');
  });

  it('harus menolak injeksi parameter tambahan (Mass Assignment protection)', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/fast',
      payload: { userId: 150, isAdmin: true } // isAdmin adalah injeksi terlarang
    });

    expect(response.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body: Record<string, unknown> = JSON.parse(response.payload);
    expect(body.message).toContain('must NOT have additional properties');
  });

  it('harus mengizinkan request valid menembus dengan cepat', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/fast',
      payload: { userId: 200 }
    });

    expect(response.statusCode).toBe(HttpStatus.OK);
  });
});
```

*Side Note: Jika Anda tidak siap memelihara duplikasi definisi skema Ajv vs TypeScript interface, pertimbangkan `typebox` atau NestJS `@nestjs/swagger` DTO-to-schema generator yang dikemas menjadi pipeline Fastify custom.*
