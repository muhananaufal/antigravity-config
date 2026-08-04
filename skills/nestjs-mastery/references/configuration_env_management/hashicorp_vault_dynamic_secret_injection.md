# HashiCorp Vault Dynamic Secret Injection

## 1. Pendahuluan
Meletakkan database password secara statis di dalam file `.env` atau repostiory (walau terenkripsi) sudah ketinggalan zaman dan berbahaya. Di arsitektur Enterprise dengan skala mikroservis yang rentan, praktik terbaik adalah **Zero Trust** via kredensial dinamis berumur pendek (Dynamic Secrets) dan injeksi memori. Kita menggunakan **HashiCorp Vault** (atau AWS Secrets Manager) yang ditarik saat tahap bootstrap NestJS. Rahasia hidup di memori RAM sesaat dan tidak pernah menyentuh disk fisik. Konsep krusial seperti **Vault Agent Sidecar vs SDK direct**, **lease renewal strategy**, **policy-as-code HCL**, dan **AppRole vs K8s auth method** sangat menentukan kesuksesan implementasi arsitektur ini.

## 2. Diagram Arsitektur & Perbandingan Pola Integrasi

### Pola 1: Vault Agent Sidecar (Direkomendasikan di Kubernetes)
```ascii
+-----------------------------------------------------------+
| Kubernetes Pod                                            |
|                                                           |
| +---------------------+      +--------------------------+ |
| | Vault Agent Sidecar |<-----| Vault Cluster (Remote)   | |
| | (Auto-Renews TTL)   |      | (Policies via HCL)       | |
| +---------+-----------+      +--------------------------+ |
|           | (Writes to memory-mapped /dev/shm)            |
| +---------v-----------+                                   |
| | NestJS App          |      +--------------------------+ |
| | (Reads /dev/shm)    |----->| PostgreSQL Database      | |
| +---------------------+      +--------------------------+ |
+-----------------------------------------------------------+
```

### Pola 2: Direct SDK Integration (Untuk VM Non-K8s atau Legacy)
```ascii
+-----------------------+       +-------------------+       +-----------------------+
|  NestJS Startup       |       | HashiCorp Vault   |       | AWS RDS / Postgres    |
|  (Direct SDK)         |       |                   |       |                       |
|  1. K8s Auth      ----+---A-->+ 2. Generates Temp +---B-->+ Create Temporary User |
|  3. Fetch Secret  <---+---C---+    DB Credential  |       | 'vault_user_789'      |
|                       |       |                   |       |                       |
+--------+--------------+       +-------------------+       +-----------------------+
         | 4. Initialize TypeORM/Prisma
         v
+-----------------------+
| Database Connection   |
| (Uses Temp Creds)     |
+-----------------------+
```

## 3. Konsep Lanjutan & Mekanisme Otentikasi

### a. Vault Agent Sidecar vs SDK Direct
- **Vault Agent Sidecar:** Adalah aplikasi terpisah yang berjalan di samping aplikasi utama. Sidecar ini menangani seluruh kerumitan otentikasi, perpanjangan umur rahasia (*lease renewal*), dan kegagalan jaringan. NestJS hanya tinggal membaca file kredensial hasil dari sidecar yang biasanya diletakkan di memori virtual (`/dev/shm`). **(Sangat Direkomendasikan)**.
- **SDK Direct:** NestJS memanggil Vault API secara langsung lewat library (seperti `node-vault`). NestJS harus mengatur siklus hidup otentikasi dan *lease renewal* sendiri. Rawan masalah *re-connection* dan *race condition*.

### b. Lease Renewal Strategy
Rahasia dinamis di Vault memiliki *Time-To-Live* (TTL), atau "masa sewa" (*lease*). Ketika *lease* berakhir, Vault secara otomatis akan mencabut kredensial di sisi *backend* (misalnya dengan mengeksekusi `DROP USER` di database). Jika NestJS menggunakan *SDK Direct*, aplikasi harus secara berkala mengirim ping "perpanjangan sewa" (Renew Lease) ke Vault sebelum *lease* habis. Jika koneksi database lama terputus, aplikasi harus sanggup me-rutin perolehan rahasia baru.

### c. Policy-as-code HCL
Vault mengamankan siapa yang boleh membaca rahasia dengan kebijakan (Policies). Enterprise menggunakan HCL (*HashiCorp Configuration Language*) yang di-*commit* ke GitOps. Kredensial tidak boleh bisa diakses secara global, melainkan sangat terikat pada spesifik *path*.

### d. AppRole vs K8s Auth Method
- **AppRole Auth:** Diperuntukkan untuk aplikasi *machine-to-machine* di luar Kubernetes (misalnya VM tradisional). Membutuhkan *RoleID* (publik) dan *SecretID* (rahasia sesaat dari CI/CD).
- **K8s Auth Method:** Kubernetes dapat mengotentikasi dirinya langsung ke Vault menggunakan Service Account Token (`JWT`). Aplikasi di K8s tidak perlu memiliki kredensial apa pun untuk menghubungi Vault, membuatnya menjadi pola paling aman di ekosistem *Cloud Native*.

## 4. Implementasi Kode Produksi TypeScript 5+ & NestJS 10+ (Pola SDK Direct / AppRole & Retry)

### a. Instalasi Dependencies
```bash
npm install node-vault
npm install -D @types/node-vault
```

### b. Pembuatan Service Vault Configuration
Kita menggunakan `Custom Configuration Provider` asinkron.

```typescript
// src/config/vault/vault.service.ts
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import * as vault from 'node-vault';

@Injectable()
export class VaultService implements OnApplicationShutdown {
  private vaultClient: vault.client;
  private readonly logger = new Logger(VaultService.name);
  private leaseId: string | undefined;

  constructor() {
    this.vaultClient = vault({
      apiVersion: 'v1',
      endpoint: process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200',
      token: process.env.VAULT_TOKEN, // Initial Bootstrap Token (AppRole disarankan)
    });
  }

  async getDatabaseCredentials(): Promise<{ user: string; pass: string }> {
    try {
      // Menarik dynamic credentials postgres (hanya valid selama lease)
      const response = await this.vaultClient.read('database/creds/my-app-role');
      
      this.leaseId = response.lease_id;
      this.logger.log('Successfully injected dynamic DB credentials from Vault');
      
      return {
        user: response.data.username as string,
        pass: response.data.password as string,
      };
    } catch (error) {
      this.logger.error('Failed to fetch credentials from Vault', error);
      throw new Error('Vault Dynamic Secret Injection Failed');
    }
  }

  // Mengurus revocation saat NestJS dimatikan secara graceful
  async onApplicationShutdown() {
    if (this.leaseId) {
      try {
        await this.vaultClient.revoke({ lease_id: this.leaseId });
        this.logger.log(`Vault lease ${this.leaseId} gracefully revoked`);
      } catch (err) {
        this.logger.warn(`Failed to revoke lease: ${err}`);
      }
    }
  }
}
```

### c. Koneksi Database Dinamis Asinkron
```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VaultService } from './config/vault/vault.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      // VaultService dibuat secara ad-hoc atau diregistrasi di provider tersendiri
      providers: [VaultService],
      inject: [VaultService],
      useFactory: async (vaultService: VaultService) => {
        // Blok eksekusi Node.js sampai kredensial di dapat
        const creds = await vaultService.getDatabaseCredentials();
        
        return {
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: parseInt(process.env.DB_PORT ?? '5432', 10),
          username: creds.user, // Diinjeksikan secara dinamis!
          password: creds.pass, // Diinjeksikan secara dinamis!
          database: process.env.DB_NAME ?? 'enterprise_db',
          autoLoadEntities: true,
          synchronize: false, // JANGAN TRUE DI PROD!
        };
      },
    }),
  ],
})
export class AppModule {}
```

### d. Unit Testing
```typescript
// src/config/vault/vault.service.spec.ts
import { VaultService } from './vault.service';

describe('VaultService', () => {
  let service: VaultService;

  beforeEach(() => {
    // Mock the external vault dependency by overriding the internal client
    service = new VaultService();
    // Gunakan type assertion yang ketat untuk men-suppress type checking pada client internal
    (service as unknown as { vaultClient: unknown }).vaultClient = {
      read: jest.fn().mockResolvedValue({
        lease_id: 'test_lease_123',
        data: { 
          username: 'temp_user', 
          password: process.env.MOCK_VAULT_PASS ?? 'temp_password_fallback' 
        },
      }),
      revoke: jest.fn().mockResolvedValue({}),
    };
  });

  it('should fetch database credentials successfully', async () => {
    const creds = await service.getDatabaseCredentials();
    expect(creds.user).toBe('temp_user');
    expect(creds.pass).toBe('temp_password_fallback');
    const mockClient = (service as unknown as { vaultClient: any }).vaultClient;
    expect(mockClient.read).toHaveBeenCalledWith('database/creds/my-app-role');
  });
  
  it('should revoke lease on application shutdown', async () => {
    await service.getDatabaseCredentials(); // To set leaseId
    await service.onApplicationShutdown();
    const mockClient = (service as unknown as { vaultClient: any }).vaultClient;
    expect(mockClient.revoke).toHaveBeenCalledWith({ lease_id: 'test_lease_123' });
  });
});
```

## 5. Analisis Trade-Off
### Kelebihan:
1. **Zero Trust & Blast Radius Terbatas:** Kredensial bersifat fana (ephemeral) dan otomatis hangus. Jika server diretas, peretas hanya mendapat kredensial sesaat dengan batas akses (*Lease TTL*).
2. **Tidak Ada File Rahasia di Disk:** Tidak perlu menyimpan kredensial di file `.env` di lingkungan Production (menghindari ancaman *directory traversal/file read vulnerability*).
3. **Audit Kriptografi Otomatis:** HashiCorp Vault mencatat secara mutlak siapa, identitas Kubernetes mana, dan pada jam berapa setiap kredensial *database* di-*minting*.
4. **Kebijakan Sebagai Kode (Policy-as-Code):** Kepatuhan keamanan menjadi sistematis lewat kebijakan HCL (HashiCorp Configuration Language) yang mendefinisikan batasan otorisasi sangat ketat per-path rahasia.

### Kekurangan:
1. **Single Point of Failure Ekstra:** Jika *cluster* Vault mati, NestJS tidak akan bisa terhubung ke *database* saat *booting* atau saat terjadi *restart*.
2. **Latensi Startup:** Proses asinkron jaringan (mengirim *request Auth* lalu merestitusi rahasia via HTTPS TLS) menambah *booting time* yang diperlukan sebelum kontainer Kubernetes dinyatakan *Ready*.
3. **Kompleksitas Manajemen Kredensial Rotasi Ulang (Jika SDK Direct):** Pada koneksi persisten pool lama (TypeORM/Prisma), jika Lease TTL (umur rahasia) habis dan aplikasi gagal me-*renew*, NestJS perlu mendeteksi koneksi *database* yang mati, lalu me-*re-fetch* Vault dan mereset *pool connection*, yang mana merupakan operasi sangat rumit. Ini alasan utama *Vault Agent Sidecar* lebih direkomendasikan.

## 6. Anti-Patterns Kritis

### Anti-Pattern 1: Logging Rahasia yang Ditarik (Terminal Leak)
❌ **Salah:** Membanggakan bahwa aplikasi kita berhasil mendapat kredensial dari Vault lalu mencetaknya ke konsol terminal.
```typescript
// const creds = await vault.getDatabaseCredentials();
// console.log('Creds arrived:', creds); // MASUK KE KIBANA, TAMAT RIWAYAT!
```
✅ **Benar:** Sama sekali tidak pernah men-serialize variabel kredensial ke disk atau konsol log (baik disengaja maupun dari utilitas `JSON.stringify` objek utuh).

### Anti-Pattern 2: Meletakkan Master Vault Token di `.env` Prod
❌ **Salah:** Memberikan `VAULT_TOKEN=root_token_super_admin` statis pada `.env` agar aplikasi bisa menarik kredensial DB. Praktik ini menghancurkan tujuan dari dynamic secrets.
✅ **Benar:** Gunakan `AppRole` atau `Kubernetes Auth Method` di mana CI/CD pipeline hanya memberikan `RoleID` atau pod K8s menyuntikkan *Service Account Token* (OIDC) sesaat dengan HCL policy *Least Privilege* (Akses Minimum).

### Anti-Pattern 3: Ignorance pada Lease Revocation
❌ **Salah:** Membiarkan aplikasi mati tanpa mencabut (*revoke*) rahasia. Rahasia akan tetap aktif di sistem *database* selama *lease duration* Vault belum tercapai, membuang resouce koneksi.
✅ **Benar:** Tangkap sinyal terminasi (`SIGTERM`/`SIGINT`) melalui *OnApplicationShutdown* NestJS untuk mengirimkan perintah *revoke* ke Vault agar *database* dibersihkan.

## 7. Production Edge Cases
1. **Lease Expiration during Execution:**
   Vault Dynamic Secrets membatasi umur kredensial DB misal (1 Jam). Setelah 1 jam, Vault menghapus *user* di Postgres. *Pool* koneksi NestJS TypeORM tiba-tiba putus dengan pesan `FATAL: password authentication failed`. Harus menggunakan sistem Pool Rekoneksi Cerdas (Smart Pool) yang menangkap *error auth* dan memanggil Vault ulang tanpa re-start server, atau serahkan beban sinkronisasi file pada Vault Agent Sidecar yang merotasi variabel otomatis.
2. **Network Partition (Jaringan Terputus saat Boot):**
   Vault berada di region cloud berbeda yang latensinya tinggi atau putus. Aplikasi melempar Unhandled Promise Rejection dan mati berulang di Kubernetes (*CrashLoopBackOff*) terus menerus. **Solusi:** Terapkan strategi *Exponential Backoff Retry* saat inisialisasi koneksi ke Vault.
3. **Development Friction:**
   Membawa infrastruktur HashiCorp Vault ke laptop lokal developer (`localhost`) akan sangat membuang waktu (menghambat *Developer Experience*). Terapkan *Adapter Pattern* di mana lingkungan `NODE_ENV=development` kredensial menggunakan kelas tiruan *Dummy Config* (dari `.env.local`), sedangkan di *production* injektor beralih ke menggunakan instansi `VaultService`.
4. **Prisma ORM Shadow Database Leakage:**
   Prisma membutuhkan koneksi ekstra (*shadow database*) jika hendak menjalankan migrasi saat produksi (tidak direkomendasikan). Vault harus dapat menghasilkan lebih dari satu pasang kredensial dinamis untuk koneksi ganda ini, masing-masing dengan otoritas izin operasi DDL yang berbeda (migrator vs aplikasi).
