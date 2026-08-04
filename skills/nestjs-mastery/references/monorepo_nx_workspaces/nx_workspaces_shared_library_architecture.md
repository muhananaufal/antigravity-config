# Arsitektur Monorepo NestJS Skala Enterprise dengan Nx Workspaces

## 1. Pendahuluan
Dalam ekosistem *Enterprise-Grade* yang melibatkan puluhan bahkan ratusan aplikasi mikro dan layanan, pengelolaan repositori tunggal (Monorepo) menjadi sangat krusial. Nx Workspaces menyediakan ekosistem perkakas yang kuat untuk mengelola monorepo berbasis TypeScript. Arsitektur perpustakaan bersama (*Shared Library Architecture*) memecah domain bisnis dan teknikal menjadi unit-unit independen (DataAccess, Feature, UI, Util) yang dapat dipublikasikan dan digunakan ulang antar aplikasi. Pendekatan ini secara drastis meningkatkan konsistensi, *code reusability*, dan kecepatan *onboarding* tim rekayasawan. Sistem ini memastikan isolasi antara logika bisnis, presentasi, dan operasi pangkalan data.

## 2. Diagram Arsitektur Library
Berikut adalah struktur *dependency graph* ideal dalam arsitektur Nx Monorepo untuk NestJS:

```text
+-------------------+       +-------------------+
|   App: api-core   |       |  App: api-admin   |
+--------+----------+       +---------+---------+
         |                            |
         |                            |
+--------v----------------------------v---------+
|                Feature Libraries              |
|   (e.g., @myorg/feature-auth, feature-user)   |
+--------+----------------------------+---------+
         |                            |
+--------v----------+       +---------v---------+
| UI / Presentation |       |   Data Access     |
| (@myorg/ui-api)   |       | (@myorg/data-db)  |
+--------+----------+       +---------+---------+
         |                            |
+--------v----------------------------v---------+
|                Utility Libraries              |
|   (e.g., @myorg/util-logger, util-crypto)     |
+-----------------------------------------------+
```

## 3. Implementasi Kode Produksi: Struktur Library

### 3.1 Data Access Library (Prisma/TypeORM)
Library *Data Access* bertanggung jawab penuh atas interaksi dengan persisten state. Tidak ada logika fitur atau antarmuka di sini.

```typescript
// libs/data-access-user/src/lib/user.repository.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@myorg/util-prisma';
import { UserEntity } from '@myorg/util-types';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async findUserById(userId: string): Promise<UserEntity> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found in database.`);
    }

    return user;
  }
  
  public async createUser(email: string, passwordHash: string): Promise<UserEntity> {
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    });
  }
}
```

### 3.2 Feature Library
Library *Feature* mengemas logika domain bisnis yang spesifik, memanggil Data Access, dan memberikan antarmuka service untuk aplikasi.

```typescript
// libs/feature-user/src/lib/user.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import { UserRepository } from '@myorg/data-access-user';
import { CryptoService } from '@myorg/util-crypto';
import { UserEntity } from '@myorg/util-types';

@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly cryptoService: CryptoService,
  ) {}

  public async registerNewUser(email: string, rawPassword: string): Promise<UserEntity> {
    try {
      if (rawPassword.length < 12) {
        throw new ConflictException('Password must be at least 12 characters long');
      }

      const passwordHash = await this.cryptoService.hashPassword(rawPassword);
      return await this.userRepository.createUser(email, passwordHash);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        throw new ConflictException(`Email ${email} is already registered.`);
      }
      throw error;
    }
  }
}
```

### 3.3 NestJS Module Definition
Setiap library di dalam Nx harus mengekspor modul NestJS yang membungkus komponen-komponennya.

```typescript
// libs/feature-user/src/lib/feature-user.module.ts
import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { DataAccessUserModule } from '@myorg/data-access-user';
import { UtilCryptoModule } from '@myorg/util-crypto';

@Module({
  imports: [DataAccessUserModule, UtilCryptoModule],
  providers: [UserService],
  exports: [UserService], // Export hanya service, bukan repository secara publik
})
export class FeatureUserModule {}
```

## 4. Anti-Patterns Kritis dan Praktik Terbaik

### Anti-Pattern 1: "Spaghetti" Dependency (Impor Melingkar / Circular Imports)
❌ **Salah:** Aplikasi langsung mengimpor dari berbagai layer secara acak, dan library saling mengimpor bolak-balik tanpa hierarki yang jelas dan terstruktur.
```typescript
// ❌ PELANGGARAN ARSITEKTUR: Di dalam util-logger (layer terbawah) mengimpor feature-user (layer atas)
import { UserService } from '@myorg/feature-user'; 
```

✅ **Benar:** Lapisan utilitas tidak memiliki dependensi terhadap domain bisnis. Alur dependensi dipaksa searah (dari atas ke bawah).
```typescript
// ✅ util-logger murni, tidak bergantung pada library internal lain
import { Injectable, ConsoleLogger } from '@nestjs/common';
```

### Anti-Pattern 2: Pengeksposan Entity Database secara Langsung ke Klien
❌ **Salah:** Mengembalikan entitas persisten dari *Prisma Client Object* yang berisi kata sandi (passwordHash) langsung melalui controller ke end-user.
```typescript
// ❌ Salah, membocorkan passwordHash secara telanjang ke respon API JSON
@Get(':id')
public async getUser(@Param('id') id: string): Promise<UserEntity> {
  return this.userRepository.findUserById(id); 
}
```

✅ **Benar:** Wajib memetakan entitas ke *Data Transfer Object* (DTO) respons sebelum data meninggalkan batas *Feature Library* atau setidaknya di *App Layer*.

## 5. Analisis Trade-Off

### Kelebihan
1. **Pemisahan Kekhawatiran Mutlak (Absolute Separation of Concerns):** Logika domain bisnis dikarantina di dalam *Feature*, sementara operasi Input/Output terisolasi di *Data Access*. Ini menyederhanakan pengujian terisolasi.
2. **Penggunaan Ulang Kode Skala Massal (Massive Reusability):** Modul utilitas independen dan antarmuka *Feature* dapat ditanamkan pada ratusan *microservices* berbeda tanpa terjadinya duplikasi kode yang rawan degradasi.
3. **Skalabilitas Manajerial Organisasi:** Tim-tim pengembang independen (Squads/Tribes) dapat memegang hak kepemilikan (ownership code) atas *Feature Libraries* spesifik, mengurangi *merge conflict* pada basis kode pusat.

### Kekurangan
1. **Kurva Pembelajaran yang Sangat Curam:** Pengembang pendatang baru (Junior/Mid level) akan mengalami kebingungan berlarut-larut dalam memahami batasan direktori yang berlapis-lapis dalam kerangka Nx.
2. **Overhead Konfigurasi Ekstra:** Mengatur dan menjaga file `project.json`, `tsconfig.base.json`, serta deklarasi *path mapping* untuk puluhan perpustakaan menambah beban tugas *DevOps* / *Architect*.
3. **Bahaya Pemisahan Prematur (Premature Modularization Syndrome):** Berlebihan dalam membelah *library* terpisah untuk komponen-komponen trivial justru akan menyebabkan fragmentasi repositori ekstrem yang melambatkan pengindeksan IDE dan kompilasi statis TypeScript.

## 6. Unit Test Suite (Monorepo Verification)

```typescript
// libs/feature-user/src/lib/user.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { UserRepository } from '@myorg/data-access-user';
import { CryptoService } from '@myorg/util-crypto';
import { ConflictException } from '@nestjs/common';
import { UserEntity } from '@myorg/util-types';

describe('UserService (Nx Monorepo Feature Boundary Enforcement Suite)', () => {
  let service: UserService;
  let mockUserRepository: jest.Mocked<UserRepository>;
  let mockCryptoService: jest.Mocked<CryptoService>;

  beforeEach(async () => {
    mockUserRepository = {
      createUser: jest.fn(),
      findUserById: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    mockCryptoService = {
      hashPassword: jest.fn(),
    } as unknown as jest.Mocked<CryptoService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: UserRepository, useValue: mockUserRepository },
        { provide: CryptoService, useValue: mockCryptoService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should explicitly register a new user successfully ensuring boundary communications', async () => {
    const email = 'test@myenterprise.com';
    const password = process.env.TEST_USER_PASSWORD || 'SuperSecretPassword123_fallback';
    const hashedPassword = process.env.TEST_USER_HASH || 'hashed_password_mock_value';
    const mockUser: UserEntity = {
      id: '1',
      email,
      passwordHash: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockCryptoService.hashPassword.mockResolvedValue(hashedPassword);
    mockUserRepository.createUser.mockResolvedValue(mockUser);

    const result = await service.registerNewUser(email, password);

    expect(result).toEqual(mockUser);
    expect(mockCryptoService.hashPassword).toHaveBeenCalledWith(password);
    expect(mockUserRepository.createUser).toHaveBeenCalledWith(email, hashedPassword);
  });

  it('should rigidly enforce password length constraints locally inside the feature domain layer', async () => {
    const email = 'test@myenterprise.com';
    const password = 'short';

    await expect(service.registerNewUser(email, password)).rejects.toThrow(ConflictException);
    expect(mockUserRepository.createUser).not.toHaveBeenCalled();
  });
});
```

## 7. Production Edge Cases

1. **Circular Dependency pada Konstruksi NestJS vs Linting Nx:** Terkadang dua *Feature Library* membutuhkan satu sama lain (Misal: User membutuhkan Auth, Auth membutuhkan User). Secara level kompilasi TypeScript dan Nx, hal ini akan merusak *build dependency graph*. Anda **wajib** memecahnya dengan pola *Mediator* atau menyatukan keduanya menjadi *shared-domain* yang lebih kohesif.
2. **Library Versioning dalam Monorepo Skala Global:** Seluruh aplikasi dan library di dalam naungan Nx Monorepo secara fundamental harus bersepakat menggunakan versi *third-party dependencies* yang absolut identik (Single Version Policy) di `package.json` tingkat root. Ketidakkonsistenan sekecil apa pun akan membuahkan kegagalan kompilasi *Shared Library* pada run-time.
3. **Environment Variables Injection Kritis:** *Shared libraries* TIDAK BOLEH sekalipun mencoba mengakses pendelegasian statis `process.env` secara langsung. Konfigurasi kredensial sistem wajib diinjeksi murni dari level *Application Root* (Main Apps) ke dalam *Library* melalui pola modul dinamis NestJS (Misalnya `ConfigService` menggunakan Injeksi Dependensi).
