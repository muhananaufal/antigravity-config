# Anatomi Reflector dan Metadata Engine NestJS: Deep Dive

## Pendahuluan
NestJS dibangun di atas fondasi meta-programming TypeScript yang sangat bergantung pada Reflection API (`reflect-metadata`). Dokumen ini membedah secara mendalam bagaimana NestJS mengelola eksekusi dekorator, merapatkan token kustom, dan menyusun hierarki metadata dari level Class hingga Parameter.

## Diagram Arsitektur Metadata Resolusion
```ascii
+---------------------------------------------------+
|                  NestJS IoC Container             |
+---------------------------------------------------+
                          |
+-------------------------v-------------------------+
|                  ExecutionContext                 |
|  (HTTP, RPC, Ws, GraphQL Execution Context)       |
+-------------------------v-------------------------+
                          |
+-------------------------v-------------------------+
|                    Reflector                      |
| + getAllAndOverride()                             |
| + getAllAndMerge()                                |
| + get()                                           |
+---------------------------------------------------+
                          |
      +-------------------v-------------------+
      |           Reflect Metadata            |
      +-------------------+-------------------+
                          |
      +-------------------v-------------------+
      | Token Hierarchy Resolution (Fallback) |
      | 1. Method Level (Highest Priority)    |
      | 2. Class Level (Fallback Priority)    |
      +---------------------------------------+
```

## Mekanika `Reflect.defineMetadata` dan `Reflect.getMetadata`
Di balik layar `SetMetadata` milik NestJS, mekanisme inti murni memanggil `Reflect.defineMetadata`.

### Implementasi Dasar Engine Internal

```typescript
import { SetMetadata, CustomDecorator } from '@nestjs/common';
import 'reflect-metadata';

// Token Identifier Konstan
export const ROLES_KEY = 'security:roles';
export const FEATURE_FLAG_KEY = 'config:feature_flag';

// Tipe Statis Murni
export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

// 1. Dekorator Level Class/Method Menggunakan SetMetadata NestJS
export const RequireRoles = (...roles: Role[]): CustomDecorator<string> => 
  SetMetadata(ROLES_KEY, roles);

// 2. Dekorator Native Reflect API (Cara NestJS bekerja di balik layar)
export const FeatureFlag = (flagName: string): MethodDecorator & ClassDecorator => {
  return (
    target: object | Function,
    propertyKey?: string | symbol,
    descriptor?: TypedPropertyDescriptor<unknown>
  ) => {
    if (descriptor) {
      // Method Level Decorator
      Reflect.defineMetadata(FEATURE_FLAG_KEY, flagName, descriptor.value as object);
      return descriptor;
    }
    // Class Level Decorator
    Reflect.defineMetadata(FEATURE_FLAG_KEY, flagName, target);
    return target;
  };
};
```

## Eksekutor Reflector dalam Guard/Interceptor

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    // Hierarchical resolution: Method takes precedence over Class
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // Tidak ada metadata, biarkan lewat (fail-open atau fail-closed sesuai kebijakan)
    }

    const request = context.switchToHttp().getRequest<Readonly<{ user?: { role: Role } }>>();
    const user = request.user;

    if (!user || !user.role) {
      throw new ForbiddenException('Akses ditolak: Identitas tidak ditemukan.');
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      throw new ForbiddenException(`Akses ditolak: Dibutuhkan role ${requiredRoles.join(', ')}.`);
    }

    return true;
  }
}
```

## `Reflect.metadata` Internals dan Spesifikasi
Di bawah permukaan eksekutor NestJS, engine metadata mematuhi penuh spesifikasi Decorator Metadata dari bahasa TypeScript. Objek `Reflect` memiliki penyimpanan internal berbasis `WeakMap` yang mengaitkan objek target (seperti *class* atau purwarupa *method*) dengan metadata.

```typescript
// Konseptualisasi internal spesifikasi reflect-metadata
const MetadataStorage = new WeakMap<
  object, 
  Map<string | symbol, Map<string | symbol, unknown>>
>();

export function defineMetadata(
  metadataKey: string | symbol, 
  metadataValue: unknown, 
  target: object, 
  propertyKey?: string | symbol
): void {
  let targetMetadata = MetadataStorage.get(target);
  if (!targetMetadata) {
    targetMetadata = new Map();
    MetadataStorage.set(target, targetMetadata);
  }
  
  let keyMetadata = targetMetadata.get(propertyKey ?? Symbol.for('class_level'));
  if (!keyMetadata) {
    keyMetadata = new Map();
    targetMetadata.set(propertyKey ?? Symbol.for('class_level'), keyMetadata);
  }
  
  keyMetadata.set(metadataKey, metadataValue);
}
```

## Perbandingan Kritis: `@SetMetadata` vs `@Reflect.metadata`
Framework NestJS merekomendasikan penggunaan `@SetMetadata` ketimbang memanggil langsung *native* Decorator TypeScript, meskipun di baliknya mereka bekerja dengan cara yang sangat identik.

### 1. Eksekusi Abstraksi `@SetMetadata` (Rekomendasi Utama ✅)
Mengemas panggilan metadata dengan abstraksi NestJS memastikan kompabilitas dan kejelasan *intent*.
```typescript
import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'config:feature_flag';

// Pendekatan elegan, secara semantik menunjukkan konfigurasi framework
export const FeatureFlag = (flagName: string): CustomDecorator<string> => 
  SetMetadata(FEATURE_FLAG_KEY, flagName);
```

### 2. Eksekusi Native Reflect API (Low-Level Control)
Digunakan ketika Anda membutuhkan manipulasi objek *descriptor* pada eksekusi runtime, atau membangun fungsionalitas di luar siklus NestJS IoC.
```typescript
import 'reflect-metadata';

export const RATE_LIMIT_KEY = 'security:rate_limit';

// Pendekatan manual, memerlukan pemahaman spesifikasi TypedPropertyDescriptor
export const RateLimit = (limit: number): MethodDecorator & ClassDecorator => {
  return (
    target: object | Function,
    propertyKey?: string | symbol,
    descriptor?: TypedPropertyDescriptor<unknown>
  ) => {
    if (descriptor) {
      // Menyisipkan metadata murni pada level method
      Reflect.defineMetadata(RATE_LIMIT_KEY, limit, descriptor.value as object);
      return descriptor;
    }
    // Menyisipkan metadata pada konstruktor class
    Reflect.defineMetadata(RATE_LIMIT_KEY, limit, target);
    return target;
  };
};
```

## Strategi Resolusi dan Hierarki Warisan Metadata (Inheritance)
Dalam sistem skala besar (Enterprise), arsitektur sering memadukan deklarasi hak akses (RBAC/ABAC) pada tingkat modul dasar (Base Controller) dan rute individu (Method). NestJS `Reflector` menyediakan dua paradigma penggabungan:

### Paradigma 1: `getAllAndOverride` (Metode Menimpa Kelas)
Sistem memprioritaskan metadata yang paling spesifik. Jika sebuah Token Metadata ditemukan di level *Method*, pembacaan dihentikan dan nilainya dikembalikan. Jika tidak, ia akan membaca level *Class*. Ini sangat ideal untuk menetapkan "aturan dasar" di *Controller*, tetapi memberikan "pengecualian" pada rute tertentu.

```typescript
// Hierarchical resolution: Method takes precedence over Class
const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
  context.getHandler(), // Diperiksa pertama (Prioritas 1)
  context.getClass(),   // Diperiksa kedua (Fallback)
]);
```

### Paradigma 2: `getAllAndMerge` (Penggabungan Akumulatif)
Sistem ini membaca semua level, lalu menggabungkannya (misal: menggabungkan dua *Array* atau melakukan *Deep Merge* pada *Object*). Ini digunakan untuk mengakumulasi prasyarat, misalnya rute memerlukan `[Role.USER]` (dari kelas) DAN `[Role.PREMIUM_USER]` (dari metode).

```typescript
const accumulatedPermissions = this.reflector.getAllAndMerge<string[]>('permissions', [
  context.getHandler(),
  context.getClass(),
]);
// Hasil: Array ter-merge, misal: ['read:users', 'write:profile']
```

## Implikasi Performa (Performance Implications) dalam Skala High Frequency
1. **Kompleksitas Ekstraksi Runtime:** Pembacaan `Reflect.getMetadata` di atas mesin V8 berjalan pada waktu konstan `O(1)` karena dukungan arsitektur memori internal yang optimal (WeakMap caching). Beban CPU untuk jutaan invocations per detik (High Frequency Trading) hampir tidak terdeteksi.
2. **Memori dan Garbage Collection (GC):** Eksekusi `getAllAndMerge` membuat instansiasi *Array* baru pada setiap siklus HTTP request. Pada lalu lintas masif (10.000+ RPM), ini menyebabkan *minor GC spikes*.
   - *Solusi Optimasi ✅:* Jika resolusi metadata statis, gunakan *Memoization* (Caching hasil `getAllAndMerge` pada tingkat instansiasi `Guard` dengan *Map* lokal berdasarkan objek handler `context.getHandler()`).

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mutasi Metadata Global secara Dinamis
**Salah:**
```typescript
// JANGAN PERNAH MENGUBAH METADATA DI RUNTIME BERDASARKAN REQUEST!
Reflect.defineMetadata(ROLES_KEY, ['ADMIN'], context.getHandler());
```
**Benar:** Metadata bersifat statis pada saat bootstrap aplikasi. Jika butuh logika dinamis, gunakan layanan injeksi (Provider) atau Request-scoped provider.

### ❌ Anti-Pattern 2: Tipe Data `any` dalam Reflector
**Salah:**
```typescript
const roles = this.reflector.get('roles', context.getHandler()); // Kembalian any
```
**Benar:**
```typescript
const roles = this.reflector.get<Role[]>(ROLES_KEY, context.getHandler());
```

## Analisis Trade-off

**Kelebihan:**
1. **Dekoupling Logika:** Dekorator memisahkan konfigurasi (metadata) dari logika bisnis, membuat *controller* sangat bersih.
2. **Fleksibilitas Hierarki:** Kemampuan `Reflector` untuk `getAllAndOverride` dan `getAllAndMerge` memungkinkan sistem pewarisan hak akses atau konfigurasi yang elegan (Class -> Method).
3. **Standarisasi Enterprise:** Pembuatan kerangka kerja internal (in-house framework) sangat tertolong dengan eksekutor terpusat seperti Guard dan Interceptor yang membaca token metadata yang sama.

**Kekurangan:**
1. **Kesulitan Debugging:** Jika terjadi kesalahan pada resolusi metadata (misalnya salah string token), kesalahan muncul di *runtime*, bukan *compile-time*.
2. **Ketergantungan Eksternal:** Sangat bergantung pada polyfill `reflect-metadata` dan fitur eksperimental TypeScript (`experimentalDecorators`, `emitDecoratorMetadata`).
3. **Overhead Performa (Mikro):** Pemanggilan reflection memiliki overhead kecil dibandingkan akses properti langsung, meskipun pada skala besar dampaknya sangat minimal.

## Production Edge Cases

1. **Kehilangan Metadata pada Wrapper:** Saat Anda membungkus fungsi (Higher Order Function) atau melakukan *monkey patching*, metadata pada fungsi asli akan hilang jika tidak disalin secara eksplisit (`Reflect.getMetadataKeys`, iterasi, dan tetapkan kembali).
2. **Tabrakan Kunci (Token Collision):** Menggunakan `string` biasa seperti `'roles'` berisiko bertabrakan dengan pustaka lain. **Solusi:** Selalu gunakan konstanta dengan prefix domain perusahaan (contoh: `@mycompany/security:roles`) atau gunakan `Symbol`.
3. **Bocornya Konteks Execution:** Memanggil `context.getClass()` pada GraphQL *resolver* akan mengembalikan kelas *Resolver*, sedangkan pada HTTP akan mengembalikan *Controller*. Logika reflekter harus *agnostic* terhadap lapisan transport jika *Guard* digunakan bersama.

## Unit / Reflection Decorator Mock Test Suite

```typescript
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, Role, ROLES_KEY, RequireRoles } from './roles.guard';

describe('RolesGuard Unit Test Suite', () => {
  let rolesGuard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    rolesGuard = new RolesGuard(reflector);
  });

  it('seharusnya mengizinkan akses jika tidak ada metadata ROLES_KEY (fail-open)', () => {
    const mockContext = {
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: Role.USER } }),
      }),
    } as unknown as ExecutionContext;

    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const result = rolesGuard.canActivate(mockContext);
    expect(result).toBe(true);
  });

  it('seharusnya menolak akses jika pengguna tidak memiliki role yang diwajibkan', () => {
    const mockContext = {
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: Role.USER } }),
      }),
    } as unknown as ExecutionContext;

    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([Role.SUPER_ADMIN]);

    expect(() => rolesGuard.canActivate(mockContext)).toThrowError('Akses ditolak: Dibutuhkan role SUPER_ADMIN.');
  });

  it('seharusnya mendukung cache memoization untuk mencegah overhead GC pada resolusi metadata (Performance Edge Case)', () => {
    const handlerRef = () => {};
    const mockContext = {
      getHandler: () => handlerRef,
      getClass: () => class MockClass {},
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: Role.SUPER_ADMIN } }),
      }),
    } as unknown as ExecutionContext;

    // Simulasi caching handler memory
    const metadataCache = new Map<Function, Role[]>();
    
    // First run (Cache miss)
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValueOnce([Role.SUPER_ADMIN]);
    if (!metadataCache.has(mockContext.getHandler())) {
      metadataCache.set(
        mockContext.getHandler(), 
        reflector.getAllAndOverride<Role[]>(ROLES_KEY, [mockContext.getHandler(), mockContext.getClass()])
      );
    }
    
    // Validate output
    expect(metadataCache.get(handlerRef)).toEqual([Role.SUPER_ADMIN]);
    
    // Second run (Cache hit, zero reflector invocation)
    const cachedRoles = metadataCache.get(mockContext.getHandler());
    expect(cachedRoles).toEqual([Role.SUPER_ADMIN]);
    expect(reflector.getAllAndOverride).toHaveBeenCalledTimes(1); // Tetap 1 kali karena cache
  });
});
```
