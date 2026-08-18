# Penguasaan OAuth2 & OpenID Connect (OIDC) dengan PKCE untuk Social SSO

## Pendahuluan
Membangun sistem *Single Sign-On* (SSO) pihak ketiga seperti Google, Apple, dan GitHub memerlukan kepatuhan mutlak terhadap spesifikasi industri **OAuth 2.0** dan **OpenID Connect (OIDC)**. Dalam arsitektur modern berbasis *Single Page Applications (SPA)* atau aplikasi *mobile* tanpa *backend* tersendiri (*Public Clients*), menggunakan metode standar `Authorization Code Grant` sangat berbahaya karena Client Secret tidak bisa disembunyikan.

Oleh karena itu, **PKCE (Proof Key for Code Exchange)** wajib diterapkan. PKCE mencegah serangan *Authorization Code Interception* dengan menghasilkan rahasia asimetris satu kali (*code_verifier* dan *code_challenge*) pada sisi klien.

## Arsitektur OAuth2 dengan PKCE Flow

Alur otentikasi PKCE memastikan hanya entitas yang membuat permintaan otorisasi awal yang dapat menukar kode otorisasi (*Authorization Code*) dengan token akses (*Access Token*).

```ascii
+----------------+          +---------------------+          +------------------------+
|                |  1. Minta Otorisasi PKCE   |                     |                        |
|   SPA / Mobile |--------------------------->|  Authorization Server |                        |
|   Client App   | (Kirim `code_challenge`)   |  (Google / Auth0)     |                        |
|                |                            |                       |                        |
|  (Menghasilkan |  2. Login & Konsen         |                       |                        |
| code_verifier &|<==========================>|                       |                        |
| code_challenge)|                            |                       |                        |
|                |  3. Kembalikan Auth Code   |                       |                        |
|                |<---------------------------|                       |                        |
|                |                            |                       |                        |
|                |  4. Tukar Token + PKCE     |                       |                        |
|                |--------------------------->|                       |                        |
|                | (Kirim `code_verifier` &   |  5. Verifikasi PKCE   |  +------------------+  |
|                |  `authorization_code`)     |--[Hash(verifier) ==]--|  | Resource Server  |  |
|                |                            |  [code_challenge]     |  +------------------+  |
|                |  6. Access & ID Token      |                       |                        |
|                |<---------------------------|                       |                        |
+----------------+          +---------------------+          +------------------------+
```

## Analisis Trade-Off

### Kelebihan (Pros)
1. **Keamanan Tanpa Rahasia Statis:** Menghilangkan kebutuhan untuk menyimpan `client_secret` pada aplikasi klien (SPA/Mobile) yang sangat rentan direkayasa balik (*reverse engineering*).
2. **Mitigasi Code Interception:** Sekalipun serangan *man-in-the-middle* (MITM) atau aplikasi berbahaya mencegat *Authorization Code*, mereka tidak dapat menggunakannya karena mereka tidak memiliki `code_verifier` murni.
3. **Kepatuhan Regulasi Industri:** OAuth 2.0 Security Best Current Practice (BCP) mewajibkan PKCE untuk semua jenis aplikasi (baik klien publik maupun rahasia).

### Kekurangan (Cons)
1. **Kompleksitas State Management Klien:** Klien wajib menyimpan `code_verifier` secara persisten selama siklus *redirect* halaman (misalnya di `sessionStorage` atau penyimpanan lokal terenkripsi).
2. **Ukuran Payload Lebih Besar:** Otorisasi membutuhkan pertukaran parameter ekstra (`code_challenge_method`, `code_challenge`, `code_verifier`).
3. **Kompatibilitas Provider Legacy:** Beberapa penyedia identitas usang (*legacy Identity Providers*) mungkin belum mendukung ekstensi PKCE OIDC.

## Edge Cases di Production
1. **Kegagalan Penyimpanan Verifier (State Loss):** Jika pengguna di-redirect ke Google dan kembali ke SPA di tab berbeda, `sessionStorage` tidak terbagi, menyebabkan kegagalan pertukaran token. Solusi: Gunakan state manajemen yang tahan lintas-tab, atau set *cookie* dengan properti *SameSite* yang aman sebelum *redirect*.
2. **Nonce dan State Manipulation (CSRF):** Penyerang memicu login SSO menggunakan tautan teranotasi. Solusi: Pastikan parameter `state` dikirim dan diverifikasi ketat (terikat pada sesi lokal) dan ID Token divalidasi dengan `nonce` spesifik.
3. **Sinkronisasi Waktu Kriptografis (Clock Skew):** Validasi JWT/OIDC ID Token dapat gagal jika jam server dan jam Identity Provider (Google/Apple) tidak sinkron (JWT `exp` dan `nbf`). Solusi: Berikan toleransi *clock tolerance/skew* (biasanya 5-60 detik) saat memverifikasi token kriptografi.

## Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Mengabaikan Parameter "State"
Hanya mengandalkan rute pengembalian (*callback URI*) membuka peluang kerentanan *Cross-Site Request Forgery (CSRF)* log masuk.
```typescript
// ❌ CONTOH SALAH
@Get('callback')
async handleCallback(@Query('code') code: string) {
    // BAHAYA: Tidak memverifikasi state, rentan terhadap Forged Login Attack
    return this.exchangeCode(code);
}
```

### ✅ Best Practice 1: Validasi Parameter State Ketat
Pastikan token state yang dihasilkan saat sebelum redirect dicocokkan ketika *callback* dilakukan.

### ❌ Anti-Pattern 2: Hardcoding Token Signing (Kunci Simetris Lemah)
Mencoba memvalidasi OIDC Token menggunakan konfigurasi statis JWT (HS256) daripada mengambil kunci asimetris dari `.well-known/jwks.json`.

### ✅ Best Practice 2: Gunakan JWKS (JSON Web Key Set)
Gunakan library `jwks-rsa` secara terpadu untuk memvalidasi *signature* token OIDC dari penyedia secara dinamis.

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. DTO & OIDC Types (Type-Safe)
```typescript
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class PKCECallbackDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  state: string;

  @IsString()
  @IsOptional() // Opsional dalam error flow
  error?: string;
}

export interface OIDCTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
}

export interface DecodedIDToken {
  sub: string; // Identifier unik
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
  iss: string;
  aud: string;
  exp: number;
}
```

### 2. Provider Auth Service (OIDCService)
```typescript
import { Injectable, UnauthorizedException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import fetch from 'node-fetch'; // atau menggunakan HttpModule NestJS

interface RedisCache {
    set(key: string, value: string, ttl: number): Promise<void>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<void>;
}

@Injectable()
export class OIDCService {
  private readonly jwks: jwksClient.JwksClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisCache: RedisCache
  ) {
    const jwksUri = this.configService.get<string>('OIDC_JWKS_URI');
    if (!jwksUri) {
      throw new InternalServerErrorException('OIDC_JWKS_URI tidak terkonfigurasi');
    }
    
    this.jwks = jwksClient({
      jwksUri,
      cache: true,
      rateLimit: true,
    });
  }

  // Digunakan oleh backend klien konfidensial jika berperan sebagai koordinator
  public generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  public async exchangeCodeForToken(code: string, codeVerifier: string): Promise<OIDCTokenResponse> {
    const tokenEndpoint = this.configService.get<string>('OIDC_TOKEN_ENDPOINT');
    const clientId = this.configService.get<string>('OIDC_CLIENT_ID');
    const redirectUri = this.configService.get<string>('OIDC_REDIRECT_URI');

    if (!tokenEndpoint || !clientId || !redirectUri) {
      throw new InternalServerErrorException('Konfigurasi OIDC tidak lengkap');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier, // WAJIB untuk PKCE
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new UnauthorizedException(`Gagal menukar token OIDC: ${errorData}`);
    }

    return await response.json() as OIDCTokenResponse;
  }

  public async verifyIDToken(idToken: string): Promise<DecodedIDToken> {
    const unverifiedToken = jwt.decode(idToken, { complete: true });
    
    if (!unverifiedToken || typeof unverifiedToken === 'string' || !unverifiedToken.header.kid) {
      throw new UnauthorizedException('Format ID Token tidak valid atau KID tidak ditemukan');
    }

    try {
      const key = await this.jwks.getSigningKey(unverifiedToken.header.kid);
      const signingKey = key.getPublicKey();
      
      const clientId = this.configService.get<string>('OIDC_CLIENT_ID');
      const issuer = this.configService.get<string>('OIDC_ISSUER');

      // Validasi JWT dengan jaminan kriptografis
      const decoded = jwt.verify(idToken, signingKey, {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: issuer,
        clockTolerance: 30, // 30 detik toleransi waktu
      }) as DecodedIDToken;

      return decoded;
    } catch (error: unknown) {
      const err = error as Error;
      throw new UnauthorizedException(`OIDC Signature Verification Failed: ${err.message}`);
    }
  }

  public async handleCallback(dto: PKCECallbackDto, sessionId: string): Promise<DecodedIDToken> {
    if (dto.error) {
      throw new BadRequestException(`Provider Authentication Error: ${dto.error}`);
    }

    // 1. Validasi State (Mencegah CSRF)
    const expectedState = await this.redisCache.get(`oidc_state:${sessionId}`);
    if (!expectedState || expectedState !== dto.state) {
      throw new UnauthorizedException('State CSRF Mismatch atau Kedaluwarsa');
    }

    // 2. Ambil Code Verifier
    const codeVerifier = await this.redisCache.get(`oidc_verifier:${sessionId}`);
    if (!codeVerifier) {
      throw new UnauthorizedException('Code Verifier hilang. Sesi PKCE invalid.');
    }

    // 3. Pertukaran Token
    const tokens = await this.exchangeCodeForToken(dto.code, codeVerifier);

    // 4. Verifikasi dan Ekstrak Profil (ID Token)
    const userProfile = await this.verifyIDToken(tokens.id_token);

    // Bersihkan sesi OIDC pasca sukses
    await this.redisCache.del(`oidc_state:${sessionId}`);
    await this.redisCache.del(`oidc_verifier:${sessionId}`);

    return userProfile;
  }
}
```

### 3. Unit Test Suite (Jest)
Mock integrasi jwks-rsa dan node-fetch untuk pengujian jaringan-isolasi (Network-isolated).

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OIDCService } from './oidc.service';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

// Mock dependencies
jest.mock('node-fetch');
jest.mock('jwks-rsa', () => {
  return jest.fn().mockImplementation(() => ({
    getSigningKey: jest.fn().mockResolvedValue({
      getPublicKey: () => 'MOCK_PUBLIC_KEY'
    })
  }));
});
jest.mock('jsonwebtoken', () => ({
  decode: jest.fn(),
  verify: jest.fn(),
}));

describe('OIDCService PKCE Flow', () => {
  let service: OIDCService;
  
  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config = {
        'OIDC_JWKS_URI': 'https://auth.com/.well-known/jwks.json',
        'OIDC_TOKEN_ENDPOINT': 'https://auth.com/token',
        'OIDC_CLIENT_ID': 'client-123',
        'OIDC_REDIRECT_URI': 'https://app.com/callback',
        'OIDC_ISSUER': 'https://auth.com',
      };
      return config[key as keyof typeof config];
    }),
  };

  const mockRedisCache = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OIDCService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: 'RedisCache', useValue: mockRedisCache },
      ],
    }).compile();

    service = new OIDCService(mockConfigService as any, mockRedisCache as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generatePKCE', () => {
    it('harus menghasilkan codeVerifier yang aman dan codeChallenge ter-hash', () => {
      const { codeVerifier, codeChallenge } = service.generatePKCE();
      expect(codeVerifier).toBeDefined();
      expect(codeVerifier.length).toBeGreaterThan(40);
      expect(codeChallenge).toBeDefined();
    });
  });

  describe('handleCallback', () => {
    const sessionId = 'session-999';
    const dto = { code: 'auth-code', state: 'state-123' };

    it('harus membuang error jika terdapat dto.error dari provider', async () => {
      await expect(service.handleCallback({ ...dto, error: 'access_denied' }, sessionId))
        .rejects.toThrow(BadRequestException);
    });

    it('harus gagal karena State CSRF mismatch', async () => {
      mockRedisCache.get.mockResolvedValueOnce('state-salah'); // State salah
      await expect(service.handleCallback(dto, sessionId))
        .rejects.toThrow(UnauthorizedException);
    });

    it('harus gagal jika PKCE Verifier hilang dari sesi', async () => {
      mockRedisCache.get.mockResolvedValueOnce('state-123'); // State benar
      mockRedisCache.get.mockResolvedValueOnce(null); // Verifier hilang
      
      await expect(service.handleCallback(dto, sessionId))
        .rejects.toThrow(UnauthorizedException);
    });
  });
});
```
