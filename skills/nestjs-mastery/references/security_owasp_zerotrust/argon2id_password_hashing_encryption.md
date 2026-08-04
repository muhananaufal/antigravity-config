# Argon2id Password Hashing & Key Derivation di NestJS

## 1. Perbandingan Algoritma Hashing: Argon2id vs Bcrypt vs Scrypt

Pemilihan algoritma hashing yang tepat sangat krusial untuk bertahan dari serangan brute-force, dictionary, dan rainbow table.

| Fitur | Argon2id (Rekomendasi OWASP) | Bcrypt | Scrypt |
| :--- | :--- | :--- | :--- |
| **GPU/ASIC Resistance** | Sangat Tinggi (Memory Hardness) | Menengah (Dibatasi oleh register CPU) | Tinggi (Memory Hardness) |
| **Side-Channel Resistance**| Tinggi (Akses memori independen dari data) | Tinggi | Menengah |
| **Parameter Tuning** | Waktu (Time), Memori, Paralelisme | Biaya (Rounds) | CPU, Memori, Paralelisasi |
| **Standarisasi** | Pemenang Password Hashing Competition (2015) | Standar industri lama sejak 1999 | Terstandarisasi melalui RFC 7914 |

**Mengapa Argon2id?**
Argon2id menggabungkan kemampuan terbaik Argon2d (pertahanan terhadap GPU) dan Argon2i (pertahanan terhadap serangan side-channel). OWASP merekomendasikan Argon2id secara mutlak sebagai standar utama (primary choice) untuk sistem otentikasi masa kini.

```ascii
+-----------------+       +--------------------------+       +-------------------------+
|                 |       |                          |       |                         |
| Plaintext Pass  +------>+ Argon2id Hashing Engine  +------>+ Secure Hash String      |
|                 |       | (Memory, Time, Parallel) |       | $argon2id$v=19$m=...    |
+--------+--------+       +------------+-------------+       +-------------------------+
         |                             |
         v                             v
+-----------------+       +--------------------------+
| System Pepper   |       | Unique Random Salt       |
| (Secret di ENV/ |       | (Di-generate otomatis    |
| Vault)          |       | per pengguna)            |
+-----------------+       +--------------------------+
```

## 2. Implementasi Argon2id di NestJS Service Layer

### Best Practice: The Hashing Service ✅

```typescript
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService {
  private readonly pepper: Buffer;

  public constructor(private readonly configService: ConfigService) {
    const pepperString = this.configService.get<string>('SECURITY_PEPPER');
    if (!pepperString) {
      throw new InternalServerErrorException('SECURITY_PEPPER tidak ditemukan di environment');
    }
    this.pepper = Buffer.from(pepperString, 'utf-8');
  }

  private getArgon2Options(): argon2.Options {
    return {
      type: argon2.argon2id,
      memoryCost: 65536, // Kebutuhan memori: 64 MB
      timeCost: 3,       // Iterasi waktu: 3
      parallelism: 4,    // Thread yang digunakan: 4
      hashLength: 32,    // Panjang hash output: 32 bytes
      secret: this.pepper, // Layer pertahanan tambahan
    };
  }

  public async hashPassword(password: string): Promise<string> {
    try {
      return await argon2.hash(password, this.getArgon2Options());
    } catch (error) {
      throw new InternalServerErrorException('Gagal melakukan proses hashing kata sandi');
    }
  }

  public async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      // Argon2 secara otomatis mengekstrak salt dan parameter lainnya dari string hash
      const isValid = await argon2.verify(hash, password, { secret: this.pepper });
      return isValid;
    } catch (error) {
      return false; // Mengembalikan false secara aman tanpa mengekspos rincian error
    }
  }
}
```

### Anti-Pattern: Insecure Hashing ❌

```typescript
// BERBAHAYA: Menggunakan algoritma hash cepat (SHA-256) untuk kredensial pengguna
import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class VulnerableCryptoService {
  public hashPassword(password: string): string {
    // ❌ Hash sangat cepat, mudah dijebol dengan serangan GPU/ASIC cluster
    // ❌ Tidak ada penambahan salt yang bersifat acak per user (rawan Rainbow Table)
    return createHash('sha256').update(password).digest('hex');
  }
}
```

### Anti-Pattern: Perbandingan String Rentan Timing Attack ❌

```typescript
// BERBAHAYA: Perbandingan string biasa rentan terhadap timing attack
import { Injectable } from '@nestjs/common';

@Injectable()
export class VulnerableVerificationService {
  public verifyToken(providedToken: string, storedToken: string): boolean {
    // ❌ Waktu eksekusi berbeda tergantung pada karakter mana yang salah
    // Penyerang dapat menebak token karakter demi karakter berdasarkan waktu respon
    return providedToken === storedToken;
  }
}
```

### Best Practice: Timing-Safe Comparison ✅

```typescript
import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class SecureVerificationService {
  public verifyToken(providedToken: string, storedToken: string): boolean {
    // Pastikan panjang string sama, lalu bandingkan sebagai buffer secara konstan
    const providedBuffer = Buffer.from(providedToken);
    const storedBuffer = Buffer.from(storedToken);

    if (providedBuffer.length !== storedBuffer.length) {
      return false;
    }

    // ✅ Waktu perbandingan selalu sama, mencegah timing attack
    return timingSafeEqual(providedBuffer, storedBuffer);
  }
}
```

## 3. Strategi Pembaruan Password (Lazy Re-hashing)

Ketika meningkatkan parameter keamanan di masa mendatang (misalnya menaikkan limit `memoryCost`), jangan paksakan pembaruan password massal. Gunakan pola pembaruan hash saat pengguna sukses melakukan login.

```typescript
// Di dalam Service Autentikasi (Contoh Snippet)
public async login(password: string, userHash: string, userId: string): Promise<boolean> {
  const isValid = await this.cryptoService.verifyPassword(userHash, password);
  if (!isValid) {
    return false;
  }

  // Mengecek apakah parameter hash yang tersimpan sudah usang
  if (argon2.needsRehash(userHash, this.cryptoService.getArgon2Options())) {
     const newHash = await this.cryptoService.hashPassword(password);
     // Update ke database secara asinkron (jangan blokir respon login)
     await this.userRepository.updateHash(userId, newHash);
  }
  return true;
}
```

## 4. Key Derivation & Enkripsi Data At-Rest (AES-256-GCM)

Argon2id memiliki kapabilitas sangat baik sebagai Key Derivation Function (KDF). Kita bisa menurunkan sebuah kunci rahasia (AES key) dari master passphrase ditambah salt unik untuk mengamankan data rahasia saat disimpan (at-rest). Timing-safe comparisons bisa diterapkan jika membandingkan cipher atau token secara manual menggunakan `crypto.timingSafeEqual`.

```typescript
import { createCipheriv, randomBytes } from 'crypto';

export class EncryptionService {
    // Menurunkan sebuah key sepanjang 32-byte untuk standar AES-256
    public async deriveKey(masterSecret: string, salt: Buffer): Promise<Buffer> {
        const hash = await argon2.hash(masterSecret, {
            type: argon2.argon2id,
            raw: true, // Output hasil berupa buffer raw, bukan string encoding terenkapsulasi
            salt,
            hashLength: 32,
            timeCost: 3,
            memoryCost: 65536,
            parallelism: 4
        });
        return hash as Buffer;
    }

    public encryptGCM(plaintext: string, key: Buffer): { ciphertext: string, iv: string, authTag: string } {
        const iv = randomBytes(12); // Initialization vector 12 byte (standar GCM)
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        
        let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
        ciphertext += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        
        return { ciphertext, iv: iv.toString('hex'), authTag };
    }
}
```

## 5. Integrasi HashiCorp Vault (Rotation tanpa Downtime)

Untuk rotasi kunci (key rotation) tanpa downtime di level zero-trust, parameter krusial seperti `SECURITY_PEPPER` atau kredensial master database harus dipanggil dinamis melalui HashiCorp Vault. Sistem harus memanfaatkan library `node-vault` di fase bootstrap, dan memiliki mekanisme listener pub-sub (misalnya RabbitMQ) atau poling berkala untuk menyegarkan memori config pada NestJS saat terjadi pembaruan di server Vault utama.

## 6. Trade-Off: Parameter Tuning Argon2id

### Meningkatkan `memoryCost` (Hardness Memori)
**Kelebihan:** 
1. Meningkatkan ongkos eksploitasi serangan ASIC/GPU secara eksponensial.
2. Mengamankan file hash secara maksimal apabila database diretas/dibobol.
3. Memastikan pemenuhan standar kepatuhan regulasi finansial tingkat tinggi.
**Kekurangan:** 
1. Konsumsi kapasitas RAM melonjak di setiap instance/pod container otentikasi.
2. Menekan batas toleransi koneksi serentak pada sistem beban tinggi.
3. Potensi terjadi penghentian paksa oleh mekanisme OOM (Out-of-Memory) killer dari Kubernetes.

### Meningkatkan `parallelism` (Beban Komputasi Threading)
**Kelebihan:** 
1. Menurunkan latensi proses perhitungan (hashing time) bagi pengguna asli (legitimate) di instance multicore.
2. Mengurangi resiko serangan penyerang yang memiliki kapabilitas memori masif namun terkendala paralelisme di mesin tunggal.
3. Mengeksploitasi arsitektur CPU masa kini.
**Kekurangan:** 
1. Menyebabkan kompetisi siklus CPU (contention) tinggi ketika sistem menerima lonjakan traffic login (spike).
2. Potensi membloking Libuv dan Node.js event loop di luar thread pool.
3. Dampak batas (diminishing return) melebihi jumlah core sistem operasi fisikal sebenarnya.

## 7. Kasus Khusus Produksi (Production Edge Cases)

1. **Denial of Service (DoS) melalui Sandi Panjang:** Penyerang mungkin merakit sandi sepanjang 1MB atau lebih untuk melumpuhkan alokasi memori dan CPU server. **Mitigasi:** Selalu gunakan sistem penolakan input di gateway/layer validasi NestJS pipe untuk panjang melebihi 128 karakter.
2. **Kubernetes OOM Kills pada Load Tinggi:** Apabila batas pod memori dialokasi hanya 512MB dan `memoryCost` argon2 diset ke 128MB, 4 upaya login secara simultan akan langsung menghancurkan (crash) service pod. **Mitigasi:** Sesuaikan perhitungan `memoryCost` dengan cermat, serta pasang rate limiting pada endpoint `/login` dan set scaling container horizontal (HPA).
3. **Event Loop Thread Pool Exhaustion:** Proses `argon2.hash()` dieksekusi secara asinkron di internal libuv thread pool. Jika limit bawaan thread pool ini (biasanya 4) diekstraksi habis oleh traffic hashing, API service secara menyeluruh dapat berhenti merespon (freeze). **Mitigasi:** Naikkan parameter `UV_THREADPOOL_SIZE` melalui environment variables atau konfigurasi OS container.

## 8. Unit Test Suite

```typescript
import { CryptoService } from './crypto.service';
import { ConfigService } from '@nestjs/config';

describe('CryptoService Unit Test', () => {
  let service: CryptoService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue('super-secret-pepper-from-env'),
    } as unknown as ConfigService;
    
    service = new CryptoService(configService);
  });

  it('seharusnya melakukan hashing dan memverifikasi kata sandi dengan valid', async () => {
    const password = 'KudaBateraiSteplesBenar123!';
    const hash = await service.hashPassword(password);
    
    expect(hash).toBeDefined();
    expect(hash).toContain('$argon2id$'); // Validasi identifikasi argon
    
    const isValid = await service.verifyPassword(hash, password);
    expect(isValid).toBe(true);
  });

  it('seharusnya gagal memverifikasi jika kata sandi salah', async () => {
    const hash = await service.hashPassword('KataSandiAsli123');
    const isValid = await service.verifyPassword(hash, 'KataSandiPalsu123');
    
    expect(isValid).toBe(false);
  });

  it('seharusnya melempar exception ketika pepper tidak ada di system env', () => {
    configService.get = jest.fn().mockReturnValue(undefined);
    expect(() => new CryptoService(configService)).toThrow('SECURITY_PEPPER tidak ditemukan di environment');
  });
});
```
