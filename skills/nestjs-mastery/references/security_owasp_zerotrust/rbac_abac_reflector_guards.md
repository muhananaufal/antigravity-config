# Otorisasi Berjenjang: RBAC & ABAC dengan NestJS Reflector Guards

Dalam arsitektur Zero-Trust, otentikasi saja (mengetahui siapa penggunanya) tidak cukup; sistem harus menjamin otorisasi berlapis (mengetahui apa yang boleh dilakukan pengguna pada objek tertentu). Dengan menggabungkan Role-Based Access Control (RBAC) untuk izin global dan Attribute-Based Access Control (ABAC) untuk izin granular tingkat resource, NestJS memberikan fasilitas metadata reflection yang elegan melalui `Reflector`.

## Arsitektur Guard Interceptor Hierarchy

```ascii
                      [Incoming HTTP Request]
                                |
                                v
                +-------------------------------+
                |       Otentikasi (JWT)        | 1. Memeriksa keberadaan pengguna
                |     (IsUserAuthenticated?)    |    dan validitas token.
                +-------------------------------+
                                | (Lanjut jika valid)
                                v
                +-------------------------------+
                |          RBAC Guard           | 2. Cek metadata 'roles' via Reflector.
                |   (HasGlobalRole 'ADMIN'?)    |    Apakah pengguna memiliki role?
                +-------------------------------+
                                | (Lanjut jika Role cocok)
                                v
                +-------------------------------+
                |          ABAC Guard           | 3. Cek kepemilikan data dinamis.
                | (IsResourceOwner / Check Attr)|    Contoh: userId di request sama dengan
                +-------------------------------+    ownerId pada record database?
                                | (Lanjut jika berhak)
                                v
                    +-----------------------+
                    | Controller / Service  |
                    +-----------------------+
```

## Implementasi Kode: TypeScript & NestJS 10+

### 1. Definisi Custom Decorators

```typescript
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
// Decorator untuk RBAC
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const ABAC_POLICY_KEY = 'abac_policy';
export enum AbacPolicy {
  RESOURCE_OWNER = 'RESOURCE_OWNER',
  DEPARTMENT_MATCH = 'DEPARTMENT_MATCH',
}
// Decorator untuk ABAC
export const RequireAbac = (policy: AbacPolicy) => SetMetadata(ABAC_POLICY_KEY, policy);
```

### 2. Implementasi RBAC Guard

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './decorators';

export interface RequestUser {
  id: string;
  roles: string[];
  departmentId: string;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Jika endpoint tidak memiliki dekorator @Roles, artinya publik (untuk RBAC)
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user: RequestUser }>();

    if (!user || !user.roles) {
      throw new ForbiddenException('Akses ditolak: Profil peran tidak ditemukan.');
    }

    const hasRole = requiredRoles.some((role) => user.roles.includes(role));
    if (!hasRole) {
      throw new ForbiddenException('Akses ditolak: Peran tidak mencukupi untuk operasi ini.');
    }

    return true;
  }
}
```

### 3. Implementasi ABAC Guard (Berbasis Resource)

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ABAC_POLICY_KEY, AbacPolicy } from './decorators';
import { DocumentService } from '../services/document.service'; // Contoh Service

@Injectable()
export class AbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly documentService: DocumentService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AbacPolicy>(ABAC_POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!policy) {
      return true; // Tidak ada kebijakan ABAC, lolos.
    }

    const request = context.switchToHttp().getRequest();
    const user: RequestUser = request.user;
    const resourceId = request.params.id; // Asumsi ID dikirim via /resource/:id

    if (!user) {
      throw new ForbiddenException('Akses ditolak: Pengguna tidak terotentikasi.');
    }

    if (policy === AbacPolicy.RESOURCE_OWNER) {
      if (!resourceId) {
         throw new ForbiddenException('ID Resource tidak disediakan untuk validasi.');
      }
      
      const document = await this.documentService.findById(resourceId);
      if (!document) {
        // Jangan beri tahu jika tidak ditemukan demi keamanan (enumeration prevention)
        throw new ForbiddenException('Akses ditolak: Dokumen tidak valid atau Anda bukan pemilik.');
      }

      if (document.ownerId !== user.id && !user.roles.includes('SUPER_ADMIN')) {
        throw new ForbiddenException('Akses ditolak: Anda bukan pemilik dokumen ini.');
      }
    }
    // Implementasi kebijakan lain (misal: DEPARTMENT_MATCH) dapat ditambahkan di sini.

    return true;
  }
}
```

### 4. Penggunaan di Controller

```typescript
import { Controller, Get, Param, UseGuards, Delete } from '@nestjs/common';
import { Roles, RequireAbac, AbacPolicy } from './decorators';
import { RolesGuard } from './roles.guard';
import { AbacGuard } from './abac.guard';
import { JwtAuthGuard } from './jwt-auth.guard'; // Asumsi Guard Otentikasi ada

@Controller('documents')
@UseGuards(JwtAuthGuard, RolesGuard, AbacGuard) // Eksekusi berurutan: Auth -> RBAC -> ABAC
export class DocumentController {
  
  @Get(':id')
  @Roles('USER', 'EDITOR', 'ADMIN') // Harus minimal memiliki peran ini
  @RequireAbac(AbacPolicy.RESOURCE_OWNER) // Dan HARUS merupakan pemilik data
  public async getDocument(@Param('id') id: string) {
    return { id, title: 'Rahasia Perusahaan', content: '...' };
  }

  @Delete(':id')
  @Roles('ADMIN') // Hanya Admin
  // Admin tidak dibatasi kepemilikan (kebijakan ABAC tidak didefinisikan), jadi bebas menghapus
  public async deleteDocument(@Param('id') id: string) {
    return { message: 'Dokumen dihapus' };
  }
}
```

## Analisis Trade-Off

### Kelebihan
1. **Pemisahan Perhatian (Separation of Concerns):** Logika keamanan dan otorisasi terisolasi sepenuhnya di lapisan Guard. Controller dan Service tetap bersih dan hanya fokus pada logika bisnis.
2. **Keterbacaan & Deklaratif:** Otorisasi endpoint menjadi sangat mudah dipahami hanya dengan melihat dekorator seperti `@Roles('ADMIN')` pada metode.
3. **Fleksibilitas Granular:** ABAC memungkinkan pengecekan kondisi dinamis berbasis data real-time (seperti kepemilikan, rentang IP, atau jadwal shift), yang mustahil dilakukan oleh RBAC standar.

### Kekurangan
1. **Penurunan Performa (Overhead ABAC):** Guard ABAC biasanya harus melakukan *query* database untuk memvalidasi atribut resource (misal: mengambil ownerId), sehingga menambah latensi (N+1 query problem jika tidak di-cache).
2. **Kompleksitas Manajemen Kondisi:** Semakin banyak kebijakan ABAC (`AbacPolicy`), Guard akan menggelembung menjadi switch-case yang masif. Membutuhkan arsitektur engine *policy* eksternal (seperti OPA atau Casbin) jika aturan menjadi ratusan.
3. **Kesulitan Testing:** Membutuhkan *mocking* yang ekstensif terhadap dependency service di dalam Guard selama unit testing, terutama untuk ABAC.

## Anti-Patterns Kritis

### Anti-Pattern 1: Menyembunyikan Logika Otorisasi di Dalam Service
❌ **Salah:** Mencampur logika pengecekan hak akses di dalam bisnis logika.
```typescript
async hapusDokumen(user: User, documentId: string) {
  const doc = await this.db.findById(documentId);
  // BURUK: Validasi keamanan mencemari service
  if (doc.ownerId !== user.id && user.role !== 'ADMIN') {
     throw new Error("Dilarang");
  }
  await this.db.delete(documentId);
}
```

✅ **Benar:** Gunakan NestJS Guard agar otorisasi ditolak sebelum request mencapai Controller atau Service. Controller selalu mengasumsikan input aman dan berhak dieksekusi.

### Anti-Pattern 2: Melupakan Order (Urutan) Eksekusi Guard
❌ **Salah:** Memasang `AbacGuard` sebelum `JwtAuthGuard`. Jika `AbacGuard` mengakses `request.user.id`, ia akan crash (`TypeError: Cannot read properties of undefined`) karena token belum divalidasi.
```typescript
@UseGuards(AbacGuard, JwtAuthGuard) // BURUK! ABAC dieksekusi duluan.
```

✅ **Benar:** Guard dijalankan sesuai urutan array dari kiri ke kanan. Selalu pastikan otentikasi di depan.
```typescript
@UseGuards(JwtAuthGuard, RolesGuard, AbacGuard) 
```

## Production Edge Cases

1. **Atribut Resource Berubah Saat Request:** Misalnya, admin mengganti ownership dari sebuah file sementara request download pengguna lama sedang dieksekusi. Penggunaan Guard ABAC memvalidasi kepemilikan *di awal* request, jika operasi memakan waktu lama, data bisa basi. Solusi: Transaksi database dengan row-locking (`SELECT ... FOR UPDATE`) pada operasi krusial.
2. **Metadata Tidak Terbaca Pada Class:** `Reflector` membaca secara spesifik. Jika Anda memasang `@Roles()` di class controller, tapi memanggil `context.getHandler()` saja di Reflector, role class akan terabaikan. Solusi: Selalu gunakan `getAllAndOverride` dan pass `getHandler()` serta `getClass()`.
3. **Kebocoran Informasi Saat 403 / 404:** Jika pengguna bukan admin meminta objek ber-ID A, dan sistem membalas `403 Forbidden` jika ada, dan `404 Not Found` jika tidak ada, peretas bisa menggunakan endpoint ini untuk menebak ID apa saja yang valid di database. Solusi: Guard ABAC terkadang harus menyamar mengembalikan `404 Not Found` atau pesan umum "Akses ditolak atau dokumen tidak ditemukan" agar tidak mengonfirmasi eksistensi data.

## Unit / Integration Testing Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './decorators';

describe('RolesGuard Security Suite', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  const createMockContext = (userObj: any): ExecutionContext => ({
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue({
        user: userObj,
      }),
    }),
  } as unknown as ExecutionContext);

  describe('canActivate()', () => {
    it('harus mengizinkan akses jika handler publik (tidak memiliki metadata roles)', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const context = createMockContext({ id: '1', roles: ['USER'] });
      
      expect(guard.canActivate(context)).toBe(true);
    });

    it('harus menolak dengan ForbiddenException jika user tidak terotentikasi', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext(undefined); // Tidak ada user
      
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow('Akses ditolak: Profil peran tidak ditemukan.');
    });

    it('harus menolak jika peran user tidak mencukupi', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
      const context = createMockContext({ id: '2', roles: ['USER', 'GUEST'] });
      
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('harus mengizinkan akses jika salah satu dari peran user cocok dengan yang diminta', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['SUPER_ADMIN', 'ADMIN']);
      const context = createMockContext({ id: '3', roles: ['ADMIN', 'USER'] }); // User punya 'ADMIN'
      
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
```
