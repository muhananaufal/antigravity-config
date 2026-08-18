# Manajemen Pencabutan Sesi Seketika (Instant Session Revocation) & Pelacakan Perangkat

## Pendahuluan
Keamanan token JWT berbasis *stateless* (tanpa penyimpanan sesi server) menjadi bumerang ketika sebuah akun dikompromikan atau pengguna perlu melakukan "Log Out dari Semua Perangkat". JWT, secara desain kriptografis, tidak dapat dicabut/di-invalidasi sebelum waktu kedaluwarsanya (*exp*) habis.

Untuk memenuhi arsitektur tingkat dewa (Top 1%), sistem IAM harus mendukung **Instant Session Revocation** (pencabutan paksa instan) menggunakan topologi persilangan (hybrid): JWT *Access Token* yang berusia pendek (misal 15 menit), dikawinkan dengan *Refresh Token* buram (*Opaque*) berdurasi panjang, dan sebuah subsistem *Denylist/Revocation Tree* memori tinggi menggunakan Redis Valkey. Disertakan juga kapabilitas Pelacakan Perangkat (Device Tracking) berdasar OS, Browser, dan Geo-IP untuk mendeteksi *Account Takeover*.

## Arsitektur Revocation Tree & Token Denylist

Sistem mencatat pohon sesi aktif (*session tree*) setiap pengguna di Redis. Saat JWT (Access Token) kadaluwarsa, klien menukar Refresh Token. Jika Refresh Token ada di denylist atau dicabut dari *session tree*, permintaan ditolak secara absolut.

```ascii
+----------------+                             +------------------------+
|   Client App   |   1. Minta Data dengan JWT  |   NestJS API Gateway   |
| (Browser/Mobile)---------------------------->| (JWT Guard Middleware) |
|   (Token exp)  |                             |           |            |
|                |   2. Token Kedaluwarsa (401)|           |            |
|                |<----------------------------|           |            |
|                |                             |           |            |
|   3. Tukar RT  |                             |           v            |
|  (Refresh Token)---------------------------->|  [Auth Service/Opaque] |
|                |                             |   |                |   |
|                | 4. Tolak JWT Baru (Dicabut) |   v                v   |
|                |<----------------------------|[Redis Session] [Denylist]|
+----------------+                             +------------------------+
```

## Analisis Trade-Off

### Kelebihan (Pros)
1. **Mitigasi Segera (Instant Kill-Switch):** Admin atau pengguna secara harfiah dapat memutuskan koneksi peretas pada satu perangkat spesifik (atau semua) nyaris seketika.
2. **Kinerja Tetap Tinggi (Statelessness dipertahankan):** Memeriksa validitas `Access Token` tetap terdesentralisasi (CPU *signature verification* murni), tanpa kueri basis data. Redis hanya dipanggil saat *Refresh Token Rotation*.
3. **Visibilitas Audit (Compliance Security):** Memungkinkan pelaporan perangkat, peramban (browser), sistem operasi, dan lokasi IP untuk kebutuhan *fraud detection* dan *audit logging*.

### Kekurangan (Cons)
1. **Kompleksitas Infrastruktur:** Membutuhkan replikasi Redis / Valkey berkinerja dan ketersediaan tinggi secara absolut. Jika Redis *down*, rotasi token akan gagal global.
2. **Potensi Kerentanan Waktu Sisa (Window of Vulnerability):** Karena Access Token bersifat *stateless*, ada jendela kerentanan waktu (sebesar 1-15 menit) hingga penyerang harus merotasi token sebelum pencabutan sepenuhnya memblokir aksesnya.
3. **Inkonsistensi State & Stale Cache:** Membutuhkan tata kelola TTL (*Time to Live*) yang rumit antara waktu *Refresh Token* dengan waktu kunci tersimpan di memori (Memory Leak jika tidak dibersihkan dengan benar).

## Edge Cases di Production
1. **Serangan Race-Condition Rotasi Token:** Klien asinkron (misal banyak tab memanggil API) menyebabkan pertukaran Refresh Token yang sama beberapa kali. Jika kita menerapkan rotasi mutlak, tab kedua akan terkunci. Solusi: Berikan "Grace Period" (Toleransi 10-30 detik) pada *Refresh Token* lama agar masih bisa digunakan untuk menukar kunci baru bagi proses simultan (*Concurrent Network Delay*).
2. **DDoS Pencabutan Masal (Thundering Herd):** Administrator mencabut seluruh sesi (*kill-all*) dari jutaan pengguna, menyebabkan paku besar-besaran beban penulisan Redis *Denylist*. Solusi: Alih-alih mendenylist tiap token sesi individual, tingkatkan satu penanda Unix Timestamp `user:{id}:session_valid_after`—setiap token terbitan sebelumnya otomatis batal.
3. **Palsu Positif Geo-IP Pelacakan Perangkat:** Pengguna normal menggunakan VPN atau *Apple Private Relay*, terlihat seolah melompat dari Jakarta ke Frankfurt dalam 1 detik, memicu penolakan *Account Takeover*. Solusi: Padukan validasi alamat IP dengan *Browser Fingerprint / Device UUID* yang disimpan saat otentikasi awal.

## Anti-Patterns & Best Practices

### ❌ Anti-Pattern 1: Menggunakan JWT Berumur Panjang
Mengeluarkan JWT dengan waktu `expiresIn: '30d'` (30 hari). Tidak mungkin dibatalkan tanpa melakukan panggilan Redis setiap kali request API (menghancurkan arsitektur *stateless*).
```typescript
// ❌ CONTOH SALAH
this.jwtService.sign(payload, { expiresIn: '30d' }); // BAHAYA! Mustahil dicabut seketika.
```

### ✅ Best Practice 1: Hybrid Short-Lived JWT + Opaque Refresh Token
Gunakan JWT Access Token sangat singkat (mis. `15m`) dan *Opaque Refresh Token* alfanumerik acak yang diverifikasi DB/Redis dengan durasi `7d`.

### ❌ Anti-Pattern 2: Menghapus Akses dengan Mendenylist Access Token di Redis (Pola Hitam)
Setiap pemanggilan rute API wajib mengecek Redis untuk mencari apakah Access Token 15 menit ada di *denylist*, mematikan manfaat CPU kriptografi.

### ✅ Best Practice 2: Pencabutan Berbasis Refresh & Versi (Epoch)
Hanya periksa Redis saat klien merotasi sesi, dan/atau sisipkan properti `sessionVersion` atau `issuedAt` ke dalam JWT.

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

### 1. Struktur Data Perangkat & Sesi (Type-Safe)
```typescript
export interface DeviceInfo {
  os: string;
  browser: string;
  ip: string;
  userAgent: string;
  lastActive: number; // Unix timestamp
}

export interface SessionData {
  sessionId: string;
  userId: string;
  deviceInfo: DeviceInfo;
  isValid: boolean;
  refreshTokenHash: string; // Hashed version dari Refresh Token untuk menghindari pencurian
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}
```

### 2. Provider Manajemen Sesi (SessionManagerService)
```typescript
import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

// Asumsi library JwtService standar dan Redis Client injeksi
interface JwtService {
  sign(payload: object, options?: any): string;
  verify(token: string): any;
}

interface RedisClient {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  hset(key: string, field: string, value: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  setex(key: string, ttl: number, value: string): Promise<void>;
}

@Injectable()
export class SessionManagerService {
  private readonly REFRESH_TTL_SEC = 7 * 24 * 60 * 60; // 7 Hari
  private readonly ACCESS_TTL_MIN = 15; // 15 Menit

  constructor(
    private readonly jwtService: JwtService,
    private readonly redisClient: RedisClient,
  ) {}

  public async createSession(userId: string, deviceInfo: DeviceInfo): Promise<TokenPair> {
    const sessionId = crypto.randomUUID();
    const rawRefreshToken = crypto.randomBytes(64).toString('base64url'); // Opaque string panjang yang sangat aman
    const refreshTokenHash = await argon2.hash(rawRefreshToken); // Hashing seperti kata sandi!

    const sessionData: SessionData = {
      sessionId,
      userId,
      deviceInfo: { ...deviceInfo, lastActive: Date.now() },
      isValid: true,
      refreshTokenHash,
    };

    // 1. Catat sesi ini pada pohon sesi milik pengguna (Untuk fitur: Log Out All Devices)
    // Key: user_sessions:{userId} , Field: sessionId , Value: JSON payload
    await this.redisClient.hset(
      `user_sessions:${userId}`, 
      sessionId, 
      JSON.stringify(sessionData)
    );

    // 2. Terbitkan JWT Berjangka Pendek dengan referensi sessionId (JWT Stateless verification)
    const accessToken = this.jwtService.sign(
      { sub: userId, sid: sessionId },
      { expiresIn: `${this.ACCESS_TTL_MIN}m` }
    );

    return {
      accessToken,
      refreshToken: rawRefreshToken, // Diberikan sebagai teks murni HANYA satu kali
      sessionId,
    };
  }

  public async revokeSession(userId: string, sessionId: string): Promise<void> {
    // Menghapus spesifik satu perangkat
    const sessionStr = await this.redisClient.hget(`user_sessions:${userId}`, sessionId);
    if (!sessionStr) {
       return; // Sudah tidak ada/dicabut
    }
    
    // Hapus dari sesi aktif
    await this.redisClient.hdel(`user_sessions:${userId}`, sessionId);
    
    // Opsional: Blacklist JIKA kita mau absolute kill switch
    // (Meskipun JWT stateless masih berlaku hingga <= 15 menit ke depan, kita biarkan saja. Tapi jika mutlak:)
    await this.redisClient.setex(`revoked_session:${sessionId}`, this.ACCESS_TTL_MIN * 60, 'revoked');
  }

  public async revokeAllUserSessions(userId: string): Promise<void> {
    const allSessions = await this.redisClient.hgetall(`user_sessions:${userId}`);
    
    const pipelineOps = []; // Batches network call
    
    // Hapus master tree
    await this.redisClient.del(`user_sessions:${userId}`);
    
    // Opsi: Blacklist massal token sisa dengan mendenylist semua `sid` 
    // Atau terapkan Epoch Unix timestamp revocation (Best practice mitigasi thundering herd)
    const currentEpoch = Math.floor(Date.now() / 1000);
    await this.redisClient.set(`user_global_revocation:${userId}`, currentEpoch.toString(), 'EX', this.ACCESS_TTL_MIN * 60);
  }

  public async rotateTokens(userId: string, sessionId: string, rawRefreshToken: string, newDeviceInfo: DeviceInfo): Promise<TokenPair> {
    const sessionStr = await this.redisClient.hget(`user_sessions:${userId}`, sessionId);
    
    if (!sessionStr) {
      // PERINGATAN: Sesi tidak ditemukan. Jika sebuah refreshToken dipakai lagi dan sesi tidak ada, 
      // ini tanda-tanda ROTASI DIBAJAK (Replay Attack pada Refresh Token).
      // Aksi Kritis: Analisa apakah ini serangan Account Takeover!
      throw new UnauthorizedException('Sesi tidak valid atau telah dicabut.');
    }

    const session: SessionData = JSON.parse(sessionStr);

    // Verifikasi Opaque Token kriptografi hash (Cegah serangan kebocoran memori / string perbandingan statis)
    const isValidToken = await argon2.verify(session.refreshTokenHash, rawRefreshToken);
    if (!isValidToken) {
       throw new ForbiddenException('Kredensial penyegaran tidak sah.');
    }

    // Cabut yang lama dan mutasikan
    await this.revokeSession(userId, sessionId);
    return await this.createSession(userId, newDeviceInfo);
  }
}
```

### 3. Unit Test Suite (Jest)
Fokus pada integritas kriptografi rotasi *Opaque Refresh Token* dan penanganan *Denylist*.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { SessionManagerService } from './session.service';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto');
    return {
        ...actual,
        randomUUID: jest.fn(() => 'mock-session-id'),
        randomBytes: jest.fn(() => Buffer.from('mock-random-bytes')),
    };
});

describe('SessionManagerService', () => {
  let service: SessionManagerService;

  const mockJwtService = {
    sign: jest.fn(() => 'mock-jwt-token'),
    verify: jest.fn(),
  };

  const mockRedisClient = {
    hset: jest.fn(),
    hget: jest.fn(),
    hdel: jest.fn(),
    hgetall: jest.fn(),
    del: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionManagerService,
        { provide: 'JwtService', useValue: mockJwtService },
        { provide: 'RedisClient', useValue: mockRedisClient },
      ],
    }).compile();

    service = module.get<SessionManagerService>(SessionManagerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createSession', () => {
    it('harus membuat hash argon2 dari refresh token buram dan menyimpan di redis', async () => {
      const deviceInfo = { os: 'macOS', browser: 'Chrome', ip: '127.0.0.1', userAgent: 'test', lastActive: 0 };
      const tokens = await service.createSession('user-1', deviceInfo);

      expect(tokens.accessToken).toBe('mock-jwt-token');
      expect(tokens.refreshToken).toBeDefined(); // Asal dari crypto.randomBytes
      expect(tokens.sessionId).toBe('mock-session-id');

      // Memastikan redis menyimpan stringified session
      expect(mockRedisClient.hset).toHaveBeenCalledWith(
        'user_sessions:user-1',
        'mock-session-id',
        expect.any(String)
      );

      // Verifikasi struktur JSON yang disimpan (harus mengandung refreshTokenHash)
      const callArgs = mockRedisClient.hset.mock.calls[0][2];
      const parsedData = JSON.parse(callArgs);
      expect(parsedData.userId).toBe('user-1');
      expect(parsedData.refreshTokenHash).toBeDefined();
    });
  });

  describe('rotateTokens', () => {
    const deviceInfo = { os: 'macOS', browser: 'Safari', ip: '127.0.0.1', userAgent: 'test', lastActive: 0 };
    
    it('harus membuang exception jika sesi tidak ada (mungkin dicabut/takeover replay)', async () => {
      mockRedisClient.hget.mockResolvedValueOnce(null);
      
      await expect(service.rotateTokens('user-1', 'invalid-sid', 'raw-token', deviceInfo))
        .rejects.toThrow(UnauthorizedException);
    });

    it('harus membuang exception jika hash refresh token tidak cocok', async () => {
      const realHash = await argon2.hash('real-token-sekali');
      const sessionData = {
         sessionId: 'sid-1',
         userId: 'user-1',
         refreshTokenHash: realHash,
      };
      
      mockRedisClient.hget.mockResolvedValueOnce(JSON.stringify(sessionData));
      
      // Kirim raw-token salah
      await expect(service.rotateTokens('user-1', 'sid-1', 'wrong-raw-token', deviceInfo))
        .rejects.toThrow(ForbiddenException);
    });

    it('harus berhasil memutar kunci, mencabut sesi lama, dan membuat sesi baru', async () => {
      const rawToken = 'correct-raw-token';
      const realHash = await argon2.hash(rawToken);
      const sessionData = {
         sessionId: 'sid-1',
         userId: 'user-1',
         refreshTokenHash: realHash,
      };
      
      mockRedisClient.hget.mockResolvedValueOnce(JSON.stringify(sessionData));
      
      const tokens = await service.rotateTokens('user-1', 'sid-1', rawToken, deviceInfo);
      
      expect(tokens.accessToken).toBe('mock-jwt-token');
      expect(mockRedisClient.hdel).toHaveBeenCalledWith('user_sessions:user-1', 'sid-1');
    });
  });
});
```
