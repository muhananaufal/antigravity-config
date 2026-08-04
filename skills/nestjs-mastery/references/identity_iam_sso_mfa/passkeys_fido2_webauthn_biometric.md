# Arsitektur Otentikasi Tanpa Kata Sandi (Passwordless) dengan Passkeys, FIDO2, dan WebAuthn di NestJS

## Pendahuluan
Era otentikasi konvensional menggunakan kata sandi (password) telah usai karena kerentanannya terhadap serangan *phishing*, *brute-force*, dan penggunaan ulang kredensial. **Passkeys**, didukung oleh standar **FIDO2** dan **WebAuthn**, menawarkan alternatif modern yang kriptografis. Dengan menggunakan sidik jari (biometrik) atau FaceID pada perangkat keras pengguna, kredensial asimetris (kunci privat/publik) dibuat. Kunci privat tidak pernah meninggalkan perangkat, menjadikannya tahan terhadap serangan siber dari jarak jauh.

Dokumen ini memandu implementasi otentikasi Passkey di NestJS 10+ menggunakan library industri standar `@simplewebauthn/server`, berfokus pada ketahanan (resilience), *type-safety*, dan proteksi *replay attack*.

## Arsitektur & Alur WebAuthn

Alur registrasi (Registration) dan Otentikasi (Authentication) melibatkan dua langkah utama: Pembuatan *Challenge* oleh Relying Party (RP, server kita) dan Verifikasi respons yang ditandatangani oleh *Authenticator* (perangkat pengguna).

```ascii
+-------------------+                          +-------------------+                          +-------------------+
|                   |  1. Minta Registrasi     |                   |                          |                   |
|   Client App      |------------------------->|   NestJS Server   |                          |  Redis/Database   |
| (Browser/Mobile)  |                          | (Relying Party)   |                          | (Sesi & Kredensial|
|                   |  2. Kirim RP Challenge   |                   |                          |                   |
|                   |<-------------------------|                   |                          |                   |
|                   |                          |                   |                          |                   |
| [Biometric Scan]  |                          |                   |                          |                   |
|  Kunci Asimetris  |  3. Kirim Attestation    |                   |                          |                   |
|      Dibuat       |------------------------->| Verifikasi Kripto |  4. Simpan Kunci Publik  |                   |
|                   |                          | (Verify Response) |------------------------->|                   |
+-------------------+                          +-------------------+                          +-------------------+
```

## Analisis Trade-Off

### Kelebihan (Pros)
1. **Ketahanan Phishing (Phishing-Resistant):** Kredensial kriptografis terikat pada domain (*Relying Party ID*), mustahil dicuri oleh situs palsu.
2. **Tanpa Manajemen Sandi:** Mengurangi beban server (tidak perlu *hashing* argon2/bcrypt secara masif) dan mencegah kebocoran *database* yang merugikan.
3. **Pengalaman Pengguna (UX) Superior:** Otentikasi selesai dalam hitungan detik menggunakan FaceID/TouchID yang sudah familier bagi pengguna, mengurangi rasio kegagalan login.

### Kekurangan (Cons)
1. **Kompleksitas Perangkat Klien:** Dukungan browser/OS lintas perangkat terkadang tidak sinkron, memerlukan implementasi *fallback* (misal Magic Link) jika perangkat tidak mendukung WebAuthn.
2. **Manajemen Pemulihan Kredensial:** Jika pengguna kehilangan perangkat utama, dan *passkeys* tidak disinkronisasi ke *cloud* (seperti iCloud Keychain), mereka akan terkunci selamanya tanpa metode *recovery* sekunder.
3. **Konfigurasi Spesifik Lingkungan:** `rpID` dan `origin` harus dikonfigurasi dengan sangat presisi (HTTPS wajib) untuk mencegah kegagalan kriptografis saat verifikasi.

## Edge Cases di Production
1. **Replay Attacks:** Seorang penyerang mencegat payload `authenticationResponse` dan mengirim ulang. Solusi: Gunakan Redis untuk menyimpan *challenge* sementara dengan *time-to-live* (TTL) pendek (misal 5 menit) dan pastikan *challenge* dihapus secara atomik dari Redis setelah 1 kali verifikasi sukses.
2. **Kloning Perangkat (Cloned Authenticators):** Validasi parameter `counter` (Sign Count) yang dikirim authenticator. Jika *counter* saat ini kurang dari atau sama dengan *counter* tersimpan di database, perangkat mungkin dikloning atau disalahgunakan.
3. **Ketidaksesuaian Nama Domain (Origin Mismatch):** Cek silang `expectedOrigin` berdasarkan lingkungan (production `https://app.domain.com`, staging `https://staging.domain.com`). Kesalahan *hardcoding* akan memblokir otentikasi pengguna secara massal.

## Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menyimpan Challenge di JWT atau Cookie tanpa Stateful Storage
Menyimpan *challenge* di *client-side cookie* membuka celah eksploitasi jika rahasia untuk menandatangani cookie tersebut bocor.
```typescript
// ❌ CONTOH SALAH
@Get('generate-challenge')
generateChallenge(@Res({ passthrough: true }) res: Response) {
  const challenge = 'random123'; 
  res.cookie('webauthn_challenge', challenge); // BAHAYA: Celah Replay Attack
  return { challenge };
}
```

### ✅ Best Practice 1: Menggunakan Redis untuk Ephemeral Challenge
```typescript
// ✅ CONTOH BENAR (Ada di implementasi penuh di bawah)
await this.redisService.setex(`webauthn_challenge:${userId}`, 300, expectedChallenge);
```

### ❌ Anti-Pattern 2: Tipe Data Bebas (Any Bypass)
```typescript
// ❌ CONTOH SALAH
async verifyRegistration(reqBody: any) {
    const verification = await verifyRegistrationResponse({ response: reqBody, /* ... */ });
}
```

### ✅ Best Practice 2: Validasi Ketat Payload WebAuthn
Gunakan DTO class-validator dan antarmuka *type-safe* yang ketat dari `@simplewebauthn/server`.

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Struktur Data & Entitas Kredensial (Type-Safe)
```typescript
import { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/types';
import { VerifiedRegistrationResponse, VerifiedAuthenticationResponse } from '@simplewebauthn/server';

export interface WebAuthnCredential {
  credentialID: Uint8Array;
  credentialPublicKey: Uint8Array;
  counter: number;
  transports?: string[];
}

export interface UserEntity {
  id: string;
  email: string;
  passkeys: WebAuthnCredential[];
}
```

### 2. Konfigurasi Modul & Environment
```typescript
import { ConfigModule } from '@nestjs/config';
import { Module } from '@nestjs/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // WAJIB: process.env.WEBAUTHN_RP_ID = "domain.com"
      // WAJIB: process.env.WEBAUTHN_RP_ORIGIN = "https://app.domain.com"
    }),
  ],
})
export class WebAuthnModule {}
```

### 3. Service Utama (PasskeysService)
```typescript
import { Injectable, UnauthorizedException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { RegistrationResponseJSON, AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/types';

// Mock dependensi Redis dan Repositori untuk keperluan struktur
interface RedisClient {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}
interface UserRepository {
  findById(id: string): Promise<UserEntity | null>;
  saveCredential(userId: string, credential: WebAuthnCredential): Promise<void>;
  updateCounter(userId: string, credentialIdHex: string, newCounter: number): Promise<void>;
}

@Injectable()
export class PasskeysService {
  private readonly rpName = 'Acme Corp Secure';
  private readonly rpID: string;
  private readonly expectedOrigin: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisClient: RedisClient,
    private readonly userRepository: UserRepository,
  ) {
    const id = this.configService.get<string>('WEBAUTHN_RP_ID');
    const origin = this.configService.get<string>('WEBAUTHN_RP_ORIGIN');
    
    if (!id || !origin) {
      throw new InternalServerErrorException('WebAuthn Configuration Missing (RP_ID or RP_ORIGIN)');
    }
    this.rpID = id;
    this.expectedOrigin = origin;
  }

  public async generateRegistrationChallenge(userId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Pengguna tidak ditemukan');
    }

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: user.id,
      userName: user.email,
      attestationType: 'none',
      excludeCredentials: user.passkeys.map((key) => ({
        id: key.credentialID,
        type: 'public-key',
        transports: key.transports as any,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });

    await this.redisClient.set(`webauthn_reg_challenge:${userId}`, options.challenge, 'EX', 300);
    return options;
  }

  public async verifyRegistration(userId: string, response: RegistrationResponseJSON): Promise<boolean> {
    const expectedChallenge = await this.redisClient.get(`webauthn_reg_challenge:${userId}`);
    if (!expectedChallenge) {
      throw new BadRequestException('Challenge kedaluwarsa atau tidak valid');
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpID,
        requireUserVerification: false,
      });
    } catch (error: unknown) {
      const err = error as Error;
      throw new BadRequestException(`Gagal verifikasi registrasi: ${err.message}`);
    }

    const { verified, registrationInfo } = verification;
    if (verified && registrationInfo) {
      const { credentialPublicKey, credentialID, counter } = registrationInfo;
      
      const newCredential: WebAuthnCredential = {
        credentialID,
        credentialPublicKey,
        counter,
        transports: response.response.transports || [],
      };
      
      await this.userRepository.saveCredential(userId, newCredential);
      await this.redisClient.del(`webauthn_reg_challenge:${userId}`);
      return true;
    }
    
    return false;
  }

  public async generateAuthenticationChallenge(userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Pengguna tidak ditemukan');
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: user.passkeys.map(key => ({
        id: key.credentialID,
        type: 'public-key',
        transports: key.transports as any,
      })),
      userVerification: 'preferred',
    });

    await this.redisClient.set(`webauthn_auth_challenge:${userId}`, options.challenge, 'EX', 300);
    return options;
  }

  public async verifyAuthentication(userId: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Pengguna tidak ditemukan');
    }

    const expectedChallenge = await this.redisClient.get(`webauthn_auth_challenge:${userId}`);
    if (!expectedChallenge) {
      throw new BadRequestException('Challenge kedaluwarsa atau tidak valid');
    }

    const credentialString = response.id;
    const authenticator = user.passkeys.find(
      key => Buffer.from(key.credentialID).toString('base64url') === credentialString
    );

    if (!authenticator) {
      throw new UnauthorizedException('Kredensial tidak valid untuk pengguna ini');
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpID,
        authenticator: {
          credentialID: authenticator.credentialID,
          credentialPublicKey: authenticator.credentialPublicKey,
          counter: authenticator.counter,
          transports: authenticator.transports as any,
        },
        requireUserVerification: false,
      });
    } catch (error: unknown) {
       const err = error as Error;
       throw new BadRequestException(`Gagal verifikasi otentikasi: ${err.message}`);
    }

    const { verified, authenticationInfo } = verification;
    if (verified && authenticationInfo) {
      await this.userRepository.updateCounter(userId, credentialString, authenticationInfo.newCounter);
      await this.redisClient.del(`webauthn_auth_challenge:${userId}`);
      return true;
    }

    return false;
  }
}
```

### 4. Unit Test Suite (Jest)
Menggunakan mocking tingkat lanjut untuk memvalidasi alur kriptografi tanpa memanggil server perangkat lunak nyata.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PasskeysService } from './passkeys.service';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as SimpleWebAuthnServer from '@simplewebauthn/server';

jest.mock('@simplewebauthn/server');

describe('PasskeysService', () => {
  let service: PasskeysService;
  
  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'WEBAUTHN_RP_ID') return 'localhost';
      if (key === 'WEBAUTHN_RP_ORIGIN') return 'http://localhost:3000';
      return null;
    }),
  };

  const mockRedisClient = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };

  const mockUserRepository = {
    findById: jest.fn(),
    saveCredential: jest.fn(),
    updateCounter: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasskeysService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'RedisClient', useValue: mockRedisClient }, // Asumsi DI injection
        { provide: 'UserRepository', useValue: mockUserRepository },
      ],
    }).compile();

    // Memaksa cast ke any karena kita menggunakan interface privat di atas untuk contoh struktur
    service = new PasskeysService(
        mockConfigService as any,
        mockRedisClient as any,
        mockUserRepository as any
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateRegistrationChallenge', () => {
    it('harus membuang exception jika pengguna tidak ditemukan', async () => {
      mockUserRepository.findById.mockResolvedValue(null);
      await expect(service.generateRegistrationChallenge('user-1')).rejects.toThrow(UnauthorizedException);
    });

    it('harus membuat challenge dan menyimpannya di redis', async () => {
      mockUserRepository.findById.mockResolvedValue({ id: 'user-1', email: 'test@test.com', passkeys: [] });
      (SimpleWebAuthnServer.generateRegistrationOptions as jest.Mock).mockResolvedValue({ challenge: 'random-chall' });

      const options = await service.generateRegistrationChallenge('user-1');
      
      expect(options.challenge).toBe('random-chall');
      expect(mockRedisClient.set).toHaveBeenCalledWith('webauthn_reg_challenge:user-1', 'random-chall', 'EX', 300);
    });
  });

  describe('verifyRegistration', () => {
    it('harus membuang exception jika challenge tidak ada di redis (kedaluwarsa)', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      await expect(service.verifyRegistration('user-1', {} as any)).rejects.toThrow(BadRequestException);
    });

    it('harus mengembalikan true jika verifikasi sukses', async () => {
      mockRedisClient.get.mockResolvedValue('valid-chall');
      (SimpleWebAuthnServer.verifyRegistrationResponse as jest.Mock).mockResolvedValue({
        verified: true,
        registrationInfo: {
          credentialPublicKey: new Uint8Array([1, 2, 3]),
          credentialID: new Uint8Array([4, 5, 6]),
          counter: 0,
        },
      });

      const result = await service.verifyRegistration('user-1', { response: { transports: ['internal'] } } as any);
      
      expect(result).toBe(true);
      expect(mockUserRepository.saveCredential).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith('webauthn_reg_challenge:user-1');
    });
  });
});
```
