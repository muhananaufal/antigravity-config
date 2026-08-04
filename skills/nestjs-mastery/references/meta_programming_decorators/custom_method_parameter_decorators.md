# Merancang Custom Method & Parameter Decorators Tipe Statis di NestJS

## Pendahuluan
Membangun dekorator kustom (Method, Property, dan Parameter) adalah keterampilan meta-programming tingkat tinggi di NestJS. Teknik ini mengurangi duplikasi logika berulang seperti pengambilan pengguna saat ini, ID *tenant* pada arsitektur *multi-tenant*, atau injeksi sistem *audit logging* dan *caching*.

## Diagram Alur Custom Decorator
```ascii
+-----------------------+      +---------------------------+      +-------------------------+
| HTTP Request Arrives  | ---> |   Guards & Interceptors   | ---> | Route Handler (Method)  |
+-----------------------+      +---------------------------+      +-------------------------+
                                             |                                 ^
                                             | Eksekusi Evaluasi               |
                                             v                                 |
                            +----------------------------------+               |
                            | Parameter Decorator (@TenantId)  | --------------+
                            | Ekstrak dari ExecutionContext    | (Inject Data)
                            +----------------------------------+
```

## Pembuatan Parameter Decorator Kustom

### 1. Dekorator Parameter `@CurrentUser()` dan `@TenantId()`

```typescript
import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

// Tipe Statis Ketat
export interface JwtPayload {
  readonly sub: string;
  readonly email: string;
  readonly tenantId: string;
  readonly roles: string[];
}

// Dekorator TenantId
export const TenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = request.user;
    
    // Verifikasi Keberadaan Tenant
    if (!user || !user.tenantId) {
      throw new UnauthorizedException('Konteks Tenant tidak ditemukan pada sesi saat ini.');
    }
    
    return user.tenantId;
  },
);

// Dekorator CurrentUser dengan Proyeksi Properti Selektif
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext): JwtPayload | string | string[] => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Identitas pengguna gagal divalidasi oleh sistem.');
    }

    return data ? user[data] : user;
  },
);
```

### 2. Method Decorator: Eksekusi Audit Logging

Dekorator ini mendaftarkan *metadata* agar *Interceptor* memproses rekam jejak.

```typescript
import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const AUDIT_LOG_KEY = 'audit:log:action';

export interface AuditLogOptions {
  readonly action: string;
  readonly entity: string;
  readonly maskSensitiveData?: boolean;
}

export const AuditLog = (options: AuditLogOptions): CustomDecorator<string> => 
  SetMetadata(AUDIT_LOG_KEY, options);
```

## Eksekusi Ordo Parameter Decorator (Execution Order)
Memahami siklus eksekusi parameter decorator adalah faktor kritis dalam men-*debug* NestJS. Tidak seperti *Method Decorator* yang dievaluasi saat inisialisasi modul (Bootstrap phase), **Parameter Decorator dieksekusi secara dinamis setiap kali route handler dipanggil (Runtime phase)**.

### Rantai Resolusi Pipeline (Pipeline Resolution Chain)
```ascii
1. Middleware (Tingkat Express/Fastify murni)
2. Guards (Otorisasi, RBAC)
3. Interceptors (Fase Pre-controller, Global/Controller/Route)
4. Pipes (Validasi & Transformasi - DI SINI Parameter Dievaluasi!)
5. Custom Parameter Decorator Extraction (Pengambilan nilai)
6. Controller Method Execution
7. Interceptors (Fase Post-controller, mapping response)
8. Exception Filters (Jika ada throw/error)
```
**Implikasi Edge Case:** Karena parameter diekstrak setelah *Guards*, Anda dipastikan selalu mendapatkan objek request yang sudah dimutasi oleh Guard (misalnya `req.user` yang berisi identitas JWT yang sudah divalidasi).

## Pattern Lanjutan: Parameter Decorator Factories dan Komposisi
Dalam sistem multi-layer yang rumit, kita dapat membuat dekorator parameter dinamis yang menerima *factory configuration* untuk menghasilkan ekstraktor tipe yang aman dan spesifik.

### 1. Dinamik Typed Parameter Extraction
Mari kita ciptakan dekorator parametrik untuk mengekstrak spesifik *Header* dengan auto-validasi Regex tipe statis yang solid.

```typescript
import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';
import { Request } from 'express';

// Tipe Konfigurasi untuk Factory
export interface HeaderExtractorOptions {
  readonly headerKey: string;
  readonly regexConstraint?: RegExp;
  readonly isRequired?: boolean;
}

// Factory Function Mengembalikan Decorator
export const ExtractHeader = (options: HeaderExtractorOptions) => {
  return createParamDecorator(
    (data: HeaderExtractorOptions, ctx: ExecutionContext): string | undefined => {
      const request = ctx.switchToHttp().getRequest<Request>();
      
      // Node.js Express otomatis lowercase pada headers
      const rawValue = request.headers[data.headerKey.toLowerCase()];
      const headerValue = Array.isArray(rawValue) ? rawValue[0] : rawValue;

      if (data.isRequired && !headerValue) {
        throw new BadRequestException(`Validasi Gagal: Header wajib '${data.headerKey}' tidak terdeteksi.`);
      }

      if (headerValue && data.regexConstraint && !data.regexConstraint.test(headerValue)) {
        throw new BadRequestException(`Validasi Gagal: Format header '${data.headerKey}' tidak valid.`);
      }

      return headerValue;
    },
  )(options); // Injecting option payload directly to factory execution
};

// Cara Penggunaan di Controller:
// @ExtractHeader({ headerKey: 'X-API-Version', regexConstraint: /^v[1-9]$/, isRequired: true }) apiVersion: string
```

### 2. Komposisi Pipes di dalam Parameter Decorator
Kita dapat merantai *Parameter Decorator* kustom dengan *Pipes* transformator bawaan NestJS untuk keamanan tipe maksimal, tanpa mengotori berkas controller. Fitur ini lazim digunakan dalam sanitasi input.

```typescript
import { ParseUUIDPipe } from '@nestjs/common';

// Alih-alih membuat:
// @Param('workspaceId', new ParseUUIDPipe({ version: '4' })) id: string

// Buat Decorator Pembungkus Terpusat ✅
export const WorkspaceId = () => {
  return createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
      const request = ctx.switchToHttp().getRequest<Request>();
      return request.params.workspaceId;
    }
  )()(new ParseUUIDPipe({ version: '4' })); // Pipeline composition di Decorator Factory!
};
```

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengakses Database dari Parameter Decorator
**Salah:** Parameter decorator mengeksekusi *query* ke database via ORM di dalam fungsi `createParamDecorator`.
**Benar:** Parameter decorator harus sepenuhnya sinkron dan *stateless*. Hanya ekstrak data yang sudah divalidasi oleh *Guard* (yang ada di `request.user`). Jangan ubah menjadi *async*.

### ❌ Anti-Pattern 2: Tidak Mendukung Transport Lintas (GraphQL / RPC)
**Salah:**
```typescript
const request = ctx.switchToHttp().getRequest(); // HANCUR di GraphQL atau Microservices
```
**Benar:** Gunakan utilitas abstrak jika mendukung transport hybrid.
```typescript
let request;
if (ctx.getType() === 'http') {
  request = ctx.switchToHttp().getRequest();
} else if (ctx.getType() === 'rpc') {
  request = ctx.switchToRpc().getData(); // Asumsi payload
}
```

## Analisis Trade-off

**Kelebihan:**
1. **DRY (Don't Repeat Yourself):** Menghapus logika `const tenantId = req.user.tenantId` dari ratusan fungsi *controller*.
2. **Keterbacaan Signature Method:** Membaca parameter fungsi `(@TenantId() tenantId: string)` langsung mengomunikasikan dependensi rute.
3. **Isolasi Logika Ekstraksi:** Perubahan struktur HTTP Request Header hanya perlu diubah di satu tempat (dalam dekorator).

**Kekurangan:**
1. **Hidden Coupling:** Fungsi *controller* tidak bisa lagi dipanggil secara independen tanpa *mocking* yang rumit untuk *Execution Context* jika diuji murni dari luar NestJS IoC.
2. **Sync-Only Constraint:** Fungsi `createParamDecorator` tidak dirancang untuk operasi *asynchronous*. Jika butuh `await`, Anda harus memindahkannya ke *Pipe* atau *Interceptor*.
3. **Ketergantungan Pipeline Eksekusi:** Parameter *decorator* akan dieksekusi **setelah** *Guard* dan **setelah** *Interceptor* awal. Urutan ini sering membingungkan engineer junior.

## Production Edge Cases

1. **Kegagalan Ekstraksi Context di WebSocket:** `ctx.switchToHttp()` akan melempar *exception* jika diakses dari rute WSS (WebSocket). *Type checking* dinamis `ctx.getType() === 'ws'` mutlak diperlukan.
2. **Mutasi Data Reference:** Mengubah referensi objek di dalam `createParamDecorator` dapat berdampak pada siklus *Request* secara global. Pastikan selalu me-return salinan (clone) atau referensi *read-only*.
3. **Null vs Undefined Injection:** Saat data tidak ditemukan, melempar `Exception` secara langsung di *decorator* akan menginterupsi *pipeline* NestJS dengan status 500 jika tidak dikonversi menjadi HTTP Exception (misal `UnauthorizedException`).

## Unit Test Suite untuk Parameter Decorator

Untuk menguji `createParamDecorator`, kita menggunakan *factory function*.

```typescript
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { TenantId } from './tenant.decorator';

function getParamDecoratorFactory(decorator: Function): Function {
  class Test {
    public test(@decorator() value: unknown): void {
      // no-op
    }
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Test, 'test');
  return args[Object.keys(args)[0]].factory;
}

describe('TenantId Parameter Decorator Unit Test Suite', () => {
  let factory: Function;

  beforeAll(() => {
    factory = getParamDecoratorFactory(TenantId);
  });

  it('seharusnya mengekstrak tenantId jika token user valid', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { tenantId: 'tenant-xyz-8899' } }),
      }),
    } as unknown as ExecutionContext;

    const result = factory(null, mockContext);
    expect(result).toEqual('tenant-xyz-8899');
  });

  it('seharusnya melempar UnauthorizedException jika tenantId absen', () => {
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user: {} }),
      }),
    } as unknown as ExecutionContext;

    expect(() => factory(null, mockContext)).toThrow(UnauthorizedException);
  });

  it('seharusnya memvalidasi ekstensi factory komposit dengan proteksi fallback tipe yang benar', () => {
    // Pengujian Edge Case: Parameter extractor dengan payload kosong yang lolos guard
    const mockContextFallback = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { tenantId: '' } }), // Empty string tapi objek user ada
      }),
    } as unknown as ExecutionContext;
    
    // Verifikasi bahwa string kosong (falsy) tetap melempar exception sesuai rancangan sistem
    expect(() => factory(null, mockContextFallback)).toThrowError(
      'Konteks Tenant tidak ditemukan pada sesi saat ini.'
    );
  });
  
  it('seharusnya memastikan proper return reference tanpa mutasi state (Pure Function constraint)', () => {
    const mockUserRef = Object.freeze({ tenantId: 'tenant-ro-99', email: 'test@company.com' });
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ user: mockUserRef }),
      }),
    } as unknown as ExecutionContext;

    const result = factory(null, mockContext);
    
    expect(result).toBe('tenant-ro-99');
    // Verifikasi imutabilitas tidak terganggu oleh decorator pipeline
    expect(Object.isFrozen(mockUserRef)).toBe(true);
  });
});
```
