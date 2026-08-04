# Metadata Reflection: Abstraksi Boilerplate Lewat Dekorator Komposit

## Pendahuluan
Salah satu kelemahan *Controller* di framework berat seperti NestJS adalah "Decorator Hell". Ratusan baris kode habis hanya untuk mendefinisikan *Swagger Docs*, *Security Guard*, *Role Validation*, *Serializer*, dan *Caching*. Dengan memanfaatkan fungsi `@applyDecorators` bawaan, kita bisa meracik dekorator tingkat dewa (Composite Decorators) untuk membunuh redundansi tersebut.

## Diagram Struktur Dekorator Komposit
```ascii
      +-----------------------------------------------------------+
      |               @ApiSecureEndpoint()                        |
      +-----------------------------------------------------------+
                               | Mengemas
      +------------------------+----------------------------------+
      | 1. @UseGuards(JwtAuthGuard, RolesGuard)                   |
      | 2. @ApiBearerAuth()                                       |
      | 3. @ApiOperation({ summary, description })                |
      | 4. @ApiResponse({ status: 200, type: ReturnType })        |
      | 5. @ApiResponse({ status: 401, description: '...' })      |
      | 6. @HttpCode(HttpStatus.OK)                               |
      | 7. @UseInterceptors(ClassSerializerInterceptor)           |
      +-----------------------------------------------------------+
```

## Implementasi Composite Decorator Murni

```typescript
import { 
  applyDecorators, 
  UseGuards, 
  HttpCode, 
  HttpStatus, 
  UseInterceptors,
  ClassSerializerInterceptor,
  Type
} from '@nestjs/common';
import { 
  ApiBearerAuth, 
  ApiOperation, 
  ApiResponse, 
  ApiUnauthorizedResponse,
  ApiForbiddenResponse
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { RequireRoles, Role } from '../decorators/roles.decorator';

// Tipe Statis Ketat Konfigurasi Komposit
export interface SecureEndpointOptions<T> {
  readonly summary: string;
  readonly description?: string;
  readonly roles?: Role[];
  readonly returnType?: Type<T>;
  readonly httpStatus?: HttpStatus;
}

// Dekorator Sang Penghancur Boilerplate
export function ApiSecureEndpoint<T>(options: SecureEndpointOptions<T>): MethodDecorator {
  const decoratorsToApply: Array<ClassDecorator | MethodDecorator | PropertyDecorator> = [
    // 1. Eksekutor Keamanan Inti
    UseGuards(JwtAuthGuard, RolesGuard),
    
    // 2. Modifikasi Perilaku HTTP
    HttpCode(options.httpStatus ?? HttpStatus.OK),
    UseInterceptors(ClassSerializerInterceptor),
    
    // 3. Generasi Dokumentasi Swagger Otomatis
    ApiBearerAuth(),
    ApiOperation({ 
      summary: options.summary, 
      description: options.description ?? 'Akses terautentikasi dibutuhkan.' 
    }),
    ApiUnauthorizedResponse({ description: 'Kredensial JWT hilang atau tidak valid (EXPIRED/MALFORMED).' }),
    ApiForbiddenResponse({ description: 'Akses ditolak karena peran (Role) tidak mencukupi.' })
  ];

  // 4. Injeksi Dinamis (Tergantung Konfigurasi)
  if (options.roles && options.roles.length > 0) {
    decoratorsToApply.push(RequireRoles(...options.roles));
  }

  if (options.returnType) {
    decoratorsToApply.push(
      ApiResponse({ 
        status: options.httpStatus ?? HttpStatus.OK, 
        type: options.returnType,
        description: 'Respons berhasil yang dikembalikan.'
      })
    );
  }

  return applyDecorators(...decoratorsToApply);
}
```

### Cara Pemakaian yang Super Bersih di Controller

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { ApiSecureEndpoint } from './decorators/api-secure-endpoint.decorator';
import { Role } from './decorators/roles.decorator';
import { UserResponseDto } from './dto/user-response.dto';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('users')
export class UsersController {
  
  @Post()
  @ApiSecureEndpoint({
    summary: 'Membuat Pengguna Baru',
    roles: [Role.SUPER_ADMIN],
    returnType: UserResponseDto,
  })
  public async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    // Controller menjadi murni fokus ke bisnis, tanpa polusi 10+ dekorator
    return new UserResponseDto({ id: '123', email: dto.email });
  }
}
```

## Discovery Service: Arsitektur Sistem Plugin dan Auto-Registrasi
Salah satu puncak kekuatan dari komposit dekorator dan meta-programming NestJS adalah kemampuannya membangun mekanisme **Auto-Registration (Pendaftaran Otomatis)** dan **Plugin Architecture**. Dengan `DiscoveryService` milik NestJS (dari `@nestjs/core`), kita dapat memindai seluruh *IoC Container* untuk menemukan komponen, handler, atau *methods* yang ditandai dengan Dekorator kita.

### Skenario: Arsitektur Event-Driven Telemetry (Plugin System)
Bayangkan Anda membuat modul analitik yang harus mengikatkan eksekusi sensor pada setiap *endpoint* yang dihias dengan komposit `@MonitoredOperation()`. Alih-alih mendaftarkan fungsi ke *array* secara manual, sistem ini akan menemukannya secara *On-The-Fly*.

#### 1. Definisi Dekorator Penanda (Marker Decorator)
```typescript
import { SetMetadata, applyDecorators } from '@nestjs/common';

export const TELEMETRY_MARKER_KEY = 'plugin:telemetry:monitored';

export interface TelemetryConfig {
  readonly operationName: string;
  readonly sensitivityLevel: 'LOW' | 'HIGH';
}

// Composite Decorator yang bertindak sebagai Meta-Marker
export function MonitoredOperation(config: TelemetryConfig): MethodDecorator {
  return applyDecorators(
    SetMetadata(TELEMETRY_MARKER_KEY, config),
    // ... bisa digabung dengan Interceptors/Swagger docs otomatis
  );
}
```

#### 2. Discovery Module (Pemindai Kontainer IoC)
Kita menggunakan pustaka `@nestjs/core` untuk iterasi metadata global saat aplikasi selesai melakukan *bootstrap* (`onModuleInit`).

```typescript
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { TELEMETRY_MARKER_KEY, TelemetryConfig } from './telemetry.decorator';

@Injectable()
export class TelemetryPluginDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(TelemetryPluginDiscoveryService.name);
  private readonly registeredOperations = new Map<string, Function>();

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  public onModuleInit(): void {
    this.logger.log('Memulai pemindaian plugin Telemetry (Auto-Registration)...');
    
    // 1. Ekstrak seluruh Provider & Controller dari IoC Container
    const wrappers = [
      ...this.discoveryService.getControllers(),
      ...this.discoveryService.getProviders(),
    ];

    wrappers.forEach((wrapper) => {
      const { instance } = wrapper;
      // Lewati kelas yang tidak berbentuk objek instansiasi nyata
      if (!instance || typeof instance !== 'object') {
        return;
      }

      // 2. Gunakan MetadataScanner untuk memindai purwarupa (prototype) instance
      const prototype = Object.getPrototypeOf(instance);
      
      // metadataScanner.scanFromInstance mensuplai semua method name
      this.metadataScanner.scanFromInstance(instance, prototype, (methodName: string) => {
        const methodRef = instance[methodName as keyof typeof instance] as Function;
        
        // 3. Ekstrak meta-data menggunakan Reflector berdasarkan Method Reference
        const config = this.reflector.get<TelemetryConfig>(
          TELEMETRY_MARKER_KEY, 
          methodRef
        );

        if (config) {
          this.logger.log(`[Plugin Terdaftar] Oprasi: ${config.operationName} (${config.sensitivityLevel}) di ${instance.constructor.name}.${methodName}`);
          
          // 4. Auto-register ke repositori internal
          this.registeredOperations.set(config.operationName, methodRef);
          
          // (Opsional) Di titik ini, Anda dapat membungkus method (Monkey Patching)
          // secara dinamis untuk menginjeksi sensor analitik tanpa Interceptor.
        }
      });
    });
  }
}
```
**Analisis Keunggulan Discovery:**
Teknik ini menghancurkan belenggu *tight coupling*. Modul Analitik/Plugin sama sekali tidak menyadari rute mana yang ia monitor; Rute hanya mendeklarasikan diri (`@MonitoredOperation`). Arsitektur ini 100% mewujudkan fondasi OCP (Open-Closed Principle) tipe tinggi (SOLID) dan siap diluncurkan di ranah *Enterprise Microservices*.

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyembunyikan Logika Validasi yang Berubah-ubah
**Salah:** Memasukkan *Pipe Validation* (seperti `ValidationPipe`) dengan opsi dinamis ke dalam komposisi secara *hardcode*, membuat satu *endpoint* tidak bisa mematikan aturan tertentu.
**Benar:** Tetapkan konfigurasi global di level `main.ts` untuk *ValidationPipe*. Dekorator komposit murni mengatur orientasi *routing*, *swagger*, dan metadata.

### ❌ Anti-Pattern 2: Penyalahgunaan `@applyDecorators` untuk Parameter
**Salah:**
```typescript
export function AuthUser() { return applyDecorators(TenantId(), CurrentUser()); }
```
**Benar:** NestJS `@applyDecorators` HANYA didesain untuk *Class*, *Method*, dan *Property Decorators*. Ia akan **GAGAL TOTAL** jika digunakan untuk membungkus Custom Parameter Decorator.

## Analisis Trade-off

**Kelebihan:**
1. **Standarisasi Menyeluruh:** Setiap tim engineer dipaksa mengikuti standar keamanan (Autentikasi & Otorisasi) dan Dokumentasi *Swagger* yang sama tanpa ruang kelupaan.
2. **Keterbacaan Tinggi:** Controller menyusut dari ratusan baris menjadi hitungan belasan, hanya menonjolkan esensi rute.
3. **Evolusi Arsitektur Tersentral:** Jika perusahaan berpindah dari otentikasi JWT biasa menuju implementasi OpenTelemetry Tracing via Interceptor, cukup tambahkan 1 baris dekorator di berkas komposit ini, dan semua ratusan *endpoint* akan langsung mewarisinya.

**Kekurangan:**
1. **Penurunan Visibilitas (Obscurity):** Engineer baru sering kebingungan dari mana asal `UseGuards(JwtAuthGuard)` karena disembunyikan di dalam komposit.
2. **Kurang Fleksibel untuk Edge Cases:** Jika ada 1 rute yang perlu mematikan *Interceptor* atau mengubah *Swagger response* sedikit saja, ia harus menulis dekorator manual alih-alih menggunakan komposit ini (atau memperbanyak parameter konfigurasi yang berujung *bloated*).
3. **Batas Eksekusi Statik:** Komposit tidak dievaluasi ulang saat *runtime* berdasarkan HTTP Request. Ia dievaluasi sekali pada saat *Bootstrap*.

## Production Edge Cases

1. **Ordering / Urutan Eksekusi:** Pada NestJS, dekorator dievaluasi dari bawah ke atas (Bottom-Up) tetapi dieksekusi berdasarkan tipe (*Guards -> Interceptors -> Pipes*). Menaruh Guard pada `@applyDecorators` akan selalu mematuhi tata urutan IoC Container, bukan urutan Anda mendefinisikan array dekorator tersebut.
2. **Siklus Reflektor Bertumpuk:** Jika dekorator komposit mendaftarkan meta `ROLES_KEY` tetapi *Controller Method* juga mendaftarkan ulang secara manual dengan nilai berbeda, perilaku `getAllAndOverride` pada reflektor berisiko menghasilkan determinasi yang di luar kendali. Aturan emas: Jangan menimpa token kustom yang sama pada properti yang sama.
3. **Swagger Model Registry:** Saat Anda mem-passing kelas *DTO* ke dalam parameter `returnType`, *Swagger* tidak akan mendaftarkan skemanya jika berkas DTO tidak di-impor secara tepat atau jika modul tidak terdaftar. `@nestjs/swagger` mungkin hanya mencetak *Empty Object* di antarmuka UI.

## Unit / Reflection Decorator Mock Test Suite

```typescript
import { Controller, Get, ReflectMetadata } from '@nestjs/common';
import { ApiSecureEndpoint } from './api-secure-endpoint.decorator';
import { Role } from '../decorators/roles.decorator';
import { GUARDS_METADATA } from '@nestjs/common/constants';

describe('ApiSecureEndpoint Composite Decorator Suite', () => {
  it('seharusnya mendaftarkan JwtAuthGuard dan RolesGuard ke metadata', () => {
    class MockController {
      @ApiSecureEndpoint({ summary: 'Test Route', roles: [Role.SYSTEM] })
      @Get('/test')
      public testRoute(): string {
        return 'ok';
      }
    }

    // Ekstrak referensi ke prototipe method
    const route = MockController.prototype.testRoute;

    // NestJS menyimpan guards dalam GUARDS_METADATA token '__guards__'
    const guards = Reflect.getMetadata(GUARDS_METADATA, route);

    expect(guards).toBeDefined();
    // Memastikan guard di-inject di dalam komposit decorator
    expect(guards.length).toBeGreaterThanOrEqual(2);
    
    // Verifikasi role meta-data
    const roles = Reflect.getMetadata('security:roles', route);
    expect(roles).toEqual([Role.SYSTEM]);
  });

  it('seharusnya menjamin imutabilitas array saat melempar decorator berlapis-lapis (Deep Composite Safety)', () => {
    class DeepMockController {
      @ApiSecureEndpoint({ 
        summary: 'Deep Route', 
        roles: [Role.USER, Role.SUPER_ADMIN],
        httpStatus: 201
      })
      @Get('/deep')
      public deepRoute(): string { return 'deep'; }
    }

    const route = DeepMockController.prototype.deepRoute;
    const rolesMeta = Reflect.getMetadata('security:roles', route) as Role[];
    
    // Verifikasi urutan dan kepastian tipe murni tanpa polusi reference
    expect(rolesMeta).toBeInstanceOf(Array);
    expect(rolesMeta).toHaveLength(2);
    expect(rolesMeta).toContain(Role.SUPER_ADMIN);
    expect(Object.isFrozen(rolesMeta)).toBe(false); // metadata TS tidak beku by default
  });
  
  it('seharusnya memvalidasi injeksi refleksi return type HTTP Status Code (Edge Case Coverage)', () => {
    class StatusMockController {
      @ApiSecureEndpoint({ summary: 'Status Check', httpStatus: 204 }) // No Content
      @Get('/status')
      public statusRoute(): void {}
    }

    const route = StatusMockController.prototype.statusRoute;
    // NestJS menyimpan override HTTP code pada __httpCode__ token
    const httpCodeMeta = Reflect.getMetadata('__httpCode__', route);
    
    expect(httpCodeMeta).toBeDefined();
    expect(httpCodeMeta).toEqual(204);
  });
});
```
