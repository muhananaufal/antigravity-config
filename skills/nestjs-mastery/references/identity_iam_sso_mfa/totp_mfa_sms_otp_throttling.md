# Arsitektur Multi-Factor Authentication (MFA/2FA) Kasta Tinggi

## Pendahuluan
Penggunaan kata sandi saja di era komputasi awan modern (*cloud-native*) sudah tidak memenuhi standar kepatuhan siber (PCI-DSS, HIPAA, SOC2). Arsitektur Multi-Factor Authentication (MFA) yang kokoh mengombinasikan Faktor Pengetahuan (sesuatu yang Anda ketahui, misal kata sandi) dengan Faktor Kepemilikan (sesuatu yang Anda miliki, misal *Time-Based One-Time Password*/TOTP atau SMS/WhatsApp OTP terisolasi).

Dokumen ini merinci arsitektur generasi, verifikasi, limitasi laju (*Rate Limiting* / *Throttling*), serta mekanisme *Backup Recovery Codes* dengan enkripsi Argon2id berbasis algoritma *hash* lambat untuk mitigasi ekstraksi massal (*offline dumping attack*).

## Arsitektur MFA Pipeline

Arsitektur ini melindungi vektor penyalahgunaan di mana penyerang (*botnet*) secara massal menebak-nebak (brute-force) kombinasi OTP yang relatif pendek (6-8 digit angka).

```ascii
+----------------+        1. Login Basic Auth        +------------------+
|                |---------------------------------->|                  |
|   User Client  |      2. Kembalikan MFA Token      |  NestJS Core API |
|                |<----------------------------------|                  |
|                |                                   |                  |
|   Maukkan OTP  |     3. Kirim OTP & MFA Token      |                  |
|   (Google Auth/|---------------------------------->|   [Rate Limiter] |
|    WhatsApp)   |                                   |         |        |
|                |                                   |   [TOTP/otplib]  |
|                |    4. Success: Access/Refresh     |         |        |
|                |<----------------------------------|   [Argon2 Verif] |
+----------------+                                   +------------------+
```

## Analisis Trade-Off

### Kelebihan (Pros)
1. **Keamanan Eksponensial (Defense in Depth):** Melindungi pengguna dari pencurian *database* karena *password* saja tidak cukup; perangkat fisik atau akses aplikasi (Authenticator) dibutuhkan.
2. **Mitigasi *Brute-force* Instan:** Penggunaan Throttling memblokir upaya acak tebakan angka 6 digit (sebesar 1.000.000 kombinasi).
3. **Backup Codes (Argon2id):** Jika ponsel hilang, ketersediaan layanan tidak putus. Disimpan dalam bentuk hash tepercaya, mencegah pengembang/admin melihat kode pemulihan murni.

### Kekurangan (Cons)
1. **Friksi Pengguna Akhir (User Friction):** Menambahkan langkah dan waktu pada proses log masuk, yang bisa mengganggu tingkat retensi jika tidak diimplementasikan dengan fitur "Remember This Device".
2. **Biaya Infrastruktur (Cost):** SMS/WhatsApp OTP sangat berbiaya mahal jika laju permintaan tidak dibatasi (rawan serangan *SMS Pumping/Toll Fraud*).
3. **Kompleksitas Implementasi Sinkronisasi Waktu:** TOTP membutuhkan presisi jam (*NTP Time Sync*). Ketidakselarasan jam server/klien menyebabkan kegagalan log masuk massal yang membingungkan (*Phantom rejections*).

## Edge Cases di Production
1. **Time Skew & Window Tolerance:** Jam ponsel pengguna mungkin maju/mundur 30-60 detik dari jam server. Solusi: Konfigurasikan jendela validasi (`window` pada *otplib*) ke `±1` (memberikan toleransi 30 detik masa lalu & masa depan).
2. **Serangan Tol SMS (SMS Toll Fraud):** Penyerang menggunakan botnet memicu OTP ke nomor ponsel premium internasional untuk mencuri biaya telekomunikasi kita. Solusi: Batasi rute kode negara (Geo-fencing), gunakan reCAPTCHA/Turnstile sebelum rute SMS, dan pasang Rate-Limiting ketat di Redis.
3. **Gagal Atomik Saat Pengaturan Pertama (Setup Race Condition):** Pengguna memindai QR Code, tapi gagal memverifikasi setup awal, meninggalkan *secret* mengambang dan membuat akun terkunci secara prematur. Solusi: Terapkan status `is_mfa_pending` di basis data sampai verifikasi TOTP pertama divalidasi sukses.

## Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menyimpan Recovery Codes Plain-Text
Menyimpan *Backup Codes* dalam basis data dalam format teks mentah. Jika DB diretas, penyerang dapat melewati 2FA seketika.
```typescript
// ❌ CONTOH SALAH
user.recoveryCodes = ['CODE1', 'CODE2']; // BAHAYA: Teks mentah
```

### ✅ Best Practice 1: Hashing Recovery Code dengan Argon2id
Seperti kata sandi, *recovery codes* harus di-*hash*. Argon2id adalah standar ketahanan GPU saat ini.

### ❌ Anti-Pattern 2: Menggunakan JWT Standar Tanpa Penanda Jelas Selama MFA
Memperbolehkan JWT log masuk utama digunakan untuk menembus rute terproteksi walau belum menuntaskan 2FA.

### ✅ Best Practice 2: JWT Berbatas Domain (Partial Token)
Terbitkan JWT khusus berlapis (misal *MfaRequiredToken*) dengan sekop (*scope*) terbatas HANYA untuk mengakses *endpoint* `/mfa/verify`.

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. DTO & Entitas (Type-Safe)
```typescript
import { IsString, IsNotEmpty, Length } from 'class-validator';

export class VerifyMfaDto {
  @IsString()
  @IsNotEmpty()
  @Length(6, 8)
  otp: string; // Kode TOTP 6 digit atau Backup Code (misal 8 digit alfanumerik)
}

export interface MfaEntity {
  isMfaEnabled: boolean;
  totpSecret: string; // Harus dienkripsi di level basis data menggunakan KMS, tapi dalam contoh disederhanakan
  recoveryCodesHashed: string[]; // Argon2id hashes
}
```

### 2. Provider TOTP & Recovery Service (MfaService)
```typescript
import { Injectable, BadRequestException, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

// Mengasumsikan ada ThrottleService (Redis-based)
interface RateLimiter {
  consume(key: string, limit: number, windowSec: number): Promise<boolean>;
}
interface UserRepository {
  findById(id: string): Promise<MfaEntity | null>;
  updateMfaStatus(id: string, mfaStatus: Partial<MfaEntity>): Promise<void>;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly userRepository: UserRepository,
  ) {
    // Toleransi: ±1 jendela (30 detik x 1 = 30 detik masa lalu/depan)
    authenticator.options = { window: 1 };
  }

  public async generateMfaSecret(userId: string, userEmail: string): Promise<{ secret: string; qrCodeUrl: string; recoveryCodes: string[] }> {
    const secret = authenticator.generateSecret(32); // Generate RFC 4226/6238 Base32 Secret
    const otpauthUrl = authenticator.keyuri(userEmail, 'Acme Corp API', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);

    // Hasilkan 8 recovery codes
    const plainRecoveryCodes: string[] = [];
    const hashedRecoveryCodes: string[] = [];

    for (let i = 0; i < 8; i++) {
      const code = crypto.randomBytes(4).toString('hex'); // 8 karakter hex
      plainRecoveryCodes.push(code);
      const hashed = await argon2.hash(code, { type: argon2.argon2id });
      hashedRecoveryCodes.push(hashed);
    }

    // PENTING: Simpan ke DB dengan status isMfaEnabled: false sampai divalidasi
    await this.userRepository.updateMfaStatus(userId, {
      totpSecret: secret,
      recoveryCodesHashed: hashedRecoveryCodes,
      isMfaEnabled: false,
    });

    return { secret, qrCodeUrl, recoveryCodes: plainRecoveryCodes }; // Tampilkan plain code SATU KALI KE USER
  }

  public async verifyAndEnableMfa(userId: string, otp: string): Promise<boolean> {
    const user = await this.userRepository.findById(userId);
    if (!user || !user.totpSecret) {
      throw new BadRequestException('MFA Setup tidak ditemukan.');
    }

    const isValid = authenticator.check(otp, user.totpSecret);
    if (!isValid) {
      throw new UnauthorizedException('Kode TOTP tidak valid.');
    }

    // Aktifkan MFA secara penuh
    await this.userRepository.updateMfaStatus(userId, { isMfaEnabled: true });
    return true;
  }

  public async validateLoginMfa(userId: string, otp: string): Promise<boolean> {
    // 1. Throttling ketat: Maks 5 percobaan per 5 menit untuk ID ini
    const isAllowed = await this.rateLimiter.consume(`mfa_login:${userId}`, 5, 300);
    if (!isAllowed) {
      throw new HttpException('Terlalu banyak percobaan MFA. Coba lagi dalam 5 menit.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.userRepository.findById(userId);
    if (!user || !user.isMfaEnabled) {
      throw new BadRequestException('MFA tidak aktif untuk pengguna ini.');
    }

    // 2. Coba Validasi TOTP Primer
    const isTotpValid = authenticator.check(otp, user.totpSecret);
    if (isTotpValid) {
      return true;
    }

    // 3. Fallback: Coba Validasi Recovery Code (jika input panjangnya spesifik/salah format TOTP)
    // Otentikasi fallback memeriksa secara linear, ini memerlukan hashing verifikasi mahal (Argon2)
    // Karena itu, rate limit sangat esensial.
    const validRecoveryIndex = await this.checkRecoveryCodes(otp, user.recoveryCodesHashed);
    if (validRecoveryIndex > -1) {
      // Menghapus backup code yang sudah digunakan (Satu kali pakai / Single Use)
      const remainingCodes = [...user.recoveryCodesHashed];
      remainingCodes.splice(validRecoveryIndex, 1);
      await this.userRepository.updateMfaStatus(userId, { recoveryCodesHashed: remainingCodes });
      return true;
    }

    throw new UnauthorizedException('Kode MFA atau Recovery Code tidak valid.');
  }

  private async checkRecoveryCodes(inputCode: string, hashedCodes: string[]): Promise<number> {
    for (let i = 0; i < hashedCodes.length; i++) {
      const match = await argon2.verify(hashedCodes[i], inputCode);
      if (match) return i;
    }
    return -1; // Tidak ada yang cocok
  }
}
```

### 3. Unit Test Suite (Jest)
Menguji keabsahan TOTP dengan isolasi *windowing* dan validasi mekanisme *brute-force prevention*.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { MfaService } from './mfa.service';
import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';

describe('MfaService Enterprise Specs', () => {
  let service: MfaService;
  
  const mockRateLimiter = {
    consume: jest.fn(),
  };

  const mockUserRepository = {
    findById: jest.fn(),
    updateMfaStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: 'RateLimiter', useValue: mockRateLimiter },
        { provide: 'UserRepository', useValue: mockUserRepository },
      ],
    }).compile();

    service = module.get<MfaService>(MfaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateLoginMfa', () => {
    const userId = 'user-101';
    
    it('harus memblokir permintaan jika melebihi rate limit (Brute-force protection)', async () => {
      mockRateLimiter.consume.mockResolvedValue(false); // Throttled

      try {
        await service.validateLoginMfa(userId, '123456');
        fail('Should have thrown HttpException');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('harus berhasil memvalidasi TOTP valid', async () => {
      mockRateLimiter.consume.mockResolvedValue(true);
      const secret = authenticator.generateSecret();
      const validCode = authenticator.generate(secret);
      
      mockUserRepository.findById.mockResolvedValue({
        isMfaEnabled: true,
        totpSecret: secret,
        recoveryCodesHashed: [],
      });

      const result = await service.validateLoginMfa(userId, validCode);
      expect(result).toBe(true);
    });

    it('harus menghapus recovery code yang valid saat digunakan sebagai fallback', async () => {
      mockRateLimiter.consume.mockResolvedValue(true);
      
      const plainCode = 'abcd1234';
      const hashedCode = await argon2.hash(plainCode);
      
      mockUserRepository.findById.mockResolvedValue({
        isMfaEnabled: true,
        totpSecret: String(process.env.TEST_MOCK_INVALID_TOTP || ''),
        recoveryCodesHashed: [hashedCode, 'another_hash'],
      });

      const result = await service.validateLoginMfa(userId, plainCode);
      
      expect(result).toBe(true);
      // Validasi bahwa update dipanggil dengan index dihapus
      expect(mockUserRepository.updateMfaStatus).toHaveBeenCalledWith(userId, {
        recoveryCodesHashed: ['another_hash'],
      });
    });

    it('harus membuang UnauthorizedException jika kode dan backup code invalid', async () => {
       mockRateLimiter.consume.mockResolvedValue(true);
       
       mockUserRepository.findById.mockResolvedValue({
        isMfaEnabled: true,
        totpSecret: 'secret',
        recoveryCodesHashed: [],
      });

      await expect(service.validateLoginMfa(userId, '000000')).rejects.toThrow(UnauthorizedException);
    });
  });
});
```
