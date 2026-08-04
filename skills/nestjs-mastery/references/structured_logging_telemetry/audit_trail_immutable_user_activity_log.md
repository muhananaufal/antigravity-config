# Audit Trail & Immutable User Activity Log

## 1. Pendahuluan
Aplikasi finansial, kesehatan, dan perbankan Enterprise mewajibkan *Audit Trail* yang ketat (seperti kepatuhan SOC2 / PCI-DSS / HIPAA). Audit trail harus mencatat *"Siapa melakukan apa, kapan, dari mana, dan apa perubahan datanya (Before & After)"* dengan jaminan mutlak bahwa catatan ini tidak dapat dimanipulasi setelah dibuat.

Mengingat logika bisnis yang terdistribusi dan seringkali kompleks di arsitektur microservices, kita menerapkan pola **Event-Driven Architecture (menggunakan `EventEmitter2` atau Message Broker)** di ekosistem NestJS. Hal ini bertujuan untuk melakukan *decoupling* (memisahkan) pencatatan audit yang berat dari logika transaksi bisnis utama.
Data hasil audit disimpan di tabel atau penyimpanan "append-only" (bersifat *immutable*) yang diatur di level sistem basis data agar tidak bisa menerima perintah `UPDATE` atau `DELETE`.

## 2. Diagram Arsitektur
```ascii
+-----------------------+        +--------------------------+        +-----------------------------+
|    User Service       |        |   NestJS Event Emitter   |        |    Audit Trail Listener     |
| (Contoh: Update Data) +---1----+   (In-Memory Event Bus)  +---2----+ (Injects to DB via Prisma)  |
|                       |        |                          |        |                             |
| +-------------------+ |        | Topic:                   |        | +-------------------------+ |
| | PostgreSQL Utama  | |        | 'audit.profile.updated'  |        | | audit_logs (append)     | |
| | [Data Updated]    | |        |                          |        | | No UPDATE/DELETE grants | |
| +-------------------+ |        +--------------------------+        | +-------------------------+ |
+-----------------------+                                            +-----------------------------+
```

## 3. Implementasi Kode Produksi TypeScript 5+ & NestJS 10+

### a. Instalasi Dependencies
Untuk mendukung asinkronisitas, sistem emisi event, dan interaksi basis data yang type-safe, kita menggunakan `@nestjs/event-emitter` beserta Prisma ORM.

```bash
npm install @nestjs/event-emitter @prisma/client
npm install --save-dev prisma typescript @types/node
```

### b. Skema Prisma (Tabel Append-Only)
Definisi skema Prisma di bawah ini mengilustrasikan entitas `User` (sebagai subjek bisnis) dan entitas `AuditLog` (sebagai pencatat jejak). Perhatikan bahwa `oldData` dan `newData` disimpan sebagai tipe `Json` agar fleksibel mencatat delta dari entitas apapun.

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}

model AuditLog {
  id         String   @id @default(uuid())
  actorId    String   // ID user/sistem yang melakukan aksi
  action     String   // Nama aksi (contoh: UPDATE_USER_EMAIL)
  entityName String   // Entitas terpengaruh (contoh: USER)
  entityId   String   // ID entitas terpengaruh
  ipAddress  String   // IP Address dari request
  userAgent  String   // Perangkat/Browser yang digunakan
  oldData    Json?    // Representasi state sebelumnya
  newData    Json?    // Representasi state sesudahnya
  createdAt  DateTime @default(now())

  @@index([entityName, entityId])
  @@index([actorId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### c. Struktur Tipe Audit Event
Pendefinisian interface menggunakan fitur TypeScript mutakhir, dengan generics secara kuat untuk menjamin _type-safety_ pada _payload_ dari data sebelum (`oldData`) dan sesudah (`newData`).

```typescript
// src/common/audit/audit-event.interface.ts
export interface AuditLogPayload<T = Record<string, unknown>> {
  actorId: string;
  action: string;
  entityName: string;
  entityId: string;
  ipAddress: string;
  userAgent: string;
  oldData?: T;
  newData?: T;
}
```

### d. Implementasi Prisma Service
Service ini mengelola koneksi langsung ke basis data menggunakan standar NestJS. Sangat aman dan tidak melakukan hardcode koneksi.

```typescript
// src/database/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

### e. Mengemisikan Event dari Service Bisnis
Di bawah ini adalah bagaimana service bisnis (misal `UserService`) memperbarui entitas dan men-dispatch event secara sinkron tanpa harus menunggu logging masuk ke database (menjaga performa HTTP). Kita sama sekali tidak menggunakan tipe untyped, semuanya strict-typed.

```typescript
// src/modules/user/user.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogPayload } from '../../common/audit/audit-event.interface';
import { User } from '@prisma/client';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  public async updateEmail(
    userId: string,
    newEmail: string,
    actorId: string,
    ip: string,
    ua: string,
  ): Promise<User> {
    // 1. Ambil state data sebelum update (Before)
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentUser) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    // Ekstrak nilai yang relevan sebagai old state
    const oldData = { email: currentUser.email };
    const newData = { email: newEmail };

    // 2. Eksekusi transaksi bisnis mutasi data
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { email: newEmail },
    });

    // 3. Siapkan payload dan Emisikan Event secara _fire-and-forget_
    const auditPayload: AuditLogPayload<typeof oldData> = {
      actorId,
      action: 'UPDATE_EMAIL',
      entityName: 'USER',
      entityId: userId,
      ipAddress: ip,
      userAgent: ua,
      oldData,
      newData,
    };
    
    // Dispatch asinkron untuk non-blocking operation
    this.eventEmitter.emit('audit.log.created', auditPayload);

    return updatedUser;
  }
}
```

### f. Audit Listener (Subscriber)
Listener asinkron menangkap event secara terpisah dari flow response dan menyimpan rekam jejak secara *immutable* via Prisma. Error tidak boleh mengacaukan Event Loop atau menggagalkan response yang sudah berhasil di return kepada user.

```typescript
// src/common/audit/audit.listener.ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogPayload } from './audit-event.interface';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);
  
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  // Parameter { async: true } krusial di Node.js event-emitter untuk tidak memblok thread HTTP utama
  @OnEvent('audit.log.created', { async: true })
  public async handleAuditLogCreated(payload: AuditLogPayload): Promise<void> {
    try {
      // Pastikan cast oldData/newData ke InputJsonValue agar Prisma tidak komplain tipe datanya
      const auditData: Prisma.AuditLogCreateInput = {
        actorId: payload.actorId,
        action: payload.action,
        entityName: payload.entityName,
        entityId: payload.entityId,
        ipAddress: payload.ipAddress,
        userAgent: payload.userAgent,
        oldData: payload.oldData ? (payload.oldData as Prisma.InputJsonValue) : Prisma.DbNull,
        newData: payload.newData ? (payload.newData as Prisma.InputJsonValue) : Prisma.DbNull,
      };

      await this.prisma.auditLog.create({
        data: auditData,
      });

      this.logger.debug(
        `Audit log successfully persisted for entity: ${payload.entityName} ID: ${payload.entityId}`
      );
    } catch (error) {
      // Sangat kritis: Jangan throw error (unhandled rejection).
      // Kirim error ke Sentry/Datadog APM dan cetak di stdout saja
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      this.logger.error(
        `[CRITICAL] Failed to insert audit log for action ${payload.action}: ${errorMessage}`,
        errorStack,
      );
    }
  }
}
```

### g. Konfigurasi Module Lengkap
Merajut semua service di atas menjadi satu kesatuan di NestJS Module, memastikan depedensi terpenuhi dengan benar tanpa *missing imports*.

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaService } from './database/prisma.service';
import { UserService } from './modules/user/user.service';
import { AuditListener } from './common/audit/audit.listener';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 10,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),
  ],
  providers: [
    PrismaService,
    UserService,
    AuditListener,
  ],
})
export class AppModule {}
```

### h. Unit Testing Strict & Robust
Kita menulis unit testing bebas dari mock yang tak berjenis (untyped mocks). Kita murni melakukan mocking terhadap service internal dari Prisma itu sendiri.

```typescript
// src/common/audit/audit.listener.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AuditListener } from './audit.listener';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogPayload } from './audit-event.interface';
import { Logger } from '@nestjs/common';

describe('AuditListener', () => {
  let listener: AuditListener;
  let prismaService: PrismaService;

  // Mock ketat berdasarkan method-method eksekusi Prisma tanpa any
  const mockPrismaService = {
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-123' }),
    },
  };

  beforeEach(async () => {
    // Matikan output log merah ke stdout selama testing
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditListener,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    listener = module.get<AuditListener>(AuditListener);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should insert audit log payload successfully', async () => {
    const payload: AuditLogPayload = {
      actorId: 'usr-456',
      action: 'DELETE_ACCOUNT',
      entityName: 'USER',
      entityId: 'usr-999',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
    };

    await listener.handleAuditLogCreated(payload);

    expect(prismaService.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prismaService.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'usr-456',
        action: 'DELETE_ACCOUNT',
        entityId: 'usr-999',
      }),
    });
  });

  it('should swallow exception and log error if db insertion fails (to prevent event loop crash)', async () => {
    mockPrismaService.auditLog.create.mockRejectedValueOnce(new Error('DB Connection Refused'));
    
    const payload: AuditLogPayload = {
      actorId: 'sys',
      action: 'MIGRATE',
      entityName: 'SYSTEM',
      entityId: '1',
      ipAddress: '127.0.0.1',
      userAgent: 'Cron',
    };

    // Tidak boleh throw error, test harus sukses
    await expect(listener.handleAuditLogCreated(payload)).resolves.not.toThrow();
    
    // Namun logger mencetak harus tetap dipanggil
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
```

## 4. Analisis Trade-Off Arsitektural

### Kelebihan ✅:
1. **Separation of Concerns (Decoupling Logika):** Logika inti mutasi (seperti fungsi _updateUser_) sangat terisolasi. Kita tidak mencemari service dengan kode logging baris-demi-baris yang seringkali menghabiskan ratusan baris, menjaga kepatuhan _Single Responsibility Principle_ (SRP).
2. **Kinerja / Performa Respons HTTP Tinggi:** Karena listener ditangani secara Asynchronous pada memory-event-bus (`{ async: true }`), API akan segera _return_ HTTP 200 OK sesaat setelah operasi _update_ di database transaksi utama berhasil. Operasi I/O insert log dijalankan di background thread oleh Node.js, mempercepat Latency bagi pelanggan.
3. **Immutable Accountability & Kepatuhan SOC2:** Kita merekam jejak delta secara presisi menggunakan state _before/after_. Hal ini memuaskan persyaratan auditor IT compliance secara absolut dan transparan.
4. **Resilience terhadap Kegagalan Logging:** Bila sistem database audit mati, atau koneksi terputus ke _AuditLog_, listener di setting sengaja untuk menahan dan _swallow_ error dengan mencetaknya, alih-alih melempar Error ke proses utama, sehingga sistem transaksi bisnis user tetap bisa terus berjalan mulus _(silent audit failure gracefully)_.

### Kekurangan ❌:
1. **Risiko Minor Data Loss (Eventual Consistency):** Oleh karena sifat _fire-and-forget_ secara *Asynchronous*, terdapat jendela kegagalan kecil: Apabila instansi Server NodeJS mati mendadak atau *restart* (karena _OOM Kill_ atau _SIGKILL_ dari orchestrator) tepat *setelah* respons HTTP di *resolve* namun *sebelum* task Worker `AuditListener` berhasil menyimpan ke basis data audit, record log audit tersebut akan hilang lenyap dan tak tergantikan, karena tidak ada sistem persistensi antrian in-memory tersebut.
2. **Pembengkakan Ukuran Storage Basis Data Tajam:** Secara fungsional tabel Audit akan menjadi salah satu tabel paling raksasa secara kuantitatif dari segi kapasitas penyimpanan (Storage). Setiap 1 record perubahan profil pengguna bisa saja melahirkan ratusan atau bahkan ribuan catatan rentetan Log Audit seiring waktu berjalan. Strategi _Archiving_ bulanan dan Partisi Data (`Table Partitioning` di Postgres) akan wajib ada.
3. **Absennya Jaminan Transaksi Tunggal Mutlak (Non-ACID untuk Audit):** Sangat rumit menjamin eksekusi keberhasilan _save_ di tabel Bisnis dan keberhasilan _save_ di tabel Audit untuk dibungkus ke dalam *Transaction Database* (ACID) yang sama, manakala mereka telah dipisah secara _decoupled_ dengan mekanisme Event-Emitter/Event Bus. Proses integrasi mekanisme *Database Rollback* jadi hampir mustahil. 

## 5. Anti-Patterns Kritis & Praktik Berkualitas

### Anti-Pattern 1: Mengizinkan "Mutasi" Histori (Gagal SOC2)
❌ **Salah (Anti-Pattern):** Membuat endpoint API, panel khusus fitur UI "Ubah Data Audit", atau bahkan membiarkan Role pengguna aplikasi basis data memiliki grant modifikasi penuh (layaknya `GRANT ALL PRIVILEGES`), sehingga rekam histori log versi lampau bebas dirubah, ditimpa ataupun dihapus.
✅ **Benar (Best Practice):** Pada level basis data RDBMS itu sendiri, tabel audit dirancang paksa menjadi `Append-Only` mutlak. Untuk PostgreSQL, hal ini dapat diraih dengan menulis sebuah *trigger function* yang sengaja mengeksekusi `RAISE EXCEPTION` manakala event `BEFORE UPDATE OR DELETE` dipicu, dibarengi hak akses yang membatasi aplikasi hanya memiliki `GRANT INSERT, SELECT` khusus kepada schema tabel bersangkutan.

### Anti-Pattern 2: Mereplika Seluruh Objek Secara Brutal (Membakar Storage Percuma)
❌ **Salah (Anti-Pattern):** Membawa data mentah secara membabi buta sebesar ukuran raksasa, misalnya sebuah dokumen gambar foto profil avatar base-64 string yang tembus jutaan karakter, ke dalam objek state kolom `oldData` maupun menaruh ratusan rentetan *nested relations query*.
✅ **Benar (Best Practice):** Terapan teknik komputasi _Diffing_ minimal di eksekusi layer backend (Service) guna merangkum dan mengekstrak khusus terhadap variabel primitif yang sungguh-sungguh berganti dan memiliki nilai esensi krusial secara audit/hukum komersil. Abaikan dan pangkas hal remeh-temeh yang berubah otomatis semisal atribut tanggal auto-update `updatedAt` / `lastLoginAt`.

### Anti-Pattern 3: Hardcoding Konfigurasi Secrets Sistem Database
❌ **Salah (Anti-Pattern):** Mengekspos rahasia dan mencatat _hardcode credential string_ secara statis telanjang ke dalam source code aplikasi, contoh: `url = "postgresql://dbuser:rahasiaP4ssw0rd!@10.20.10.150:5432/core_db"`.
✅ **Benar (Best Practice):** Eksekusi absolut bahwa *Prisma connection-string* hanya membaca pemanggilan variabel injeksi eksternal dinamis di runtime seperti `env("DATABASE_URL")`, dimana rahasia _value_ aslinya diamankan lewat layanan platform infrastruktur tingkat atas semisal layanan *AWS Secrets Manager* atau *Kubernetes Vault Secrets*.

## 6. Production Edge Cases & Mitigasi Resolusi

1. **Failure Spill-Over Audit (Kegagalan Insert Audit Berantai Mematikan Node):**
   *Kasus Ekstrim:* Storage server Postgres tabel audit tiba-tiba kepenuhan (disk full 100%) sehingga database membeku atau kehabisan blok _connection-pool_. Seandainya anda panik lantas mengubah arsitektur `AuditListener` balik ke perilaku _Synchronous/Blocking_ demi mengejar garansi pencatatan, imbas berantainya membuat seketika seluruh fungsionalitas HTTP transaksi operasional pengguna aplikasi ikut macet dan crash.
   *Mitigasi:* Tetap tahan perancangannya untuk konsisten Asinkron; tapi terapkan pengamanan lapis kedua berjenis _Circuit Breaker_, dan bila sistem mendeteksi error insert log gagal melampaui batasan kritis, lakukan mekanisme *Failover Fallback* yakni mem-pipa-kan (pipe stream) luaran log audit mentah itu menjadi File Teks Biasa (_Flat JSONL File_) di sistem operasi sementara waktu, sehingga _log aggregator_ terpisah layaknya _fluentd_ / _Logstash_ bisa mem-parsing perbaikannya dan melempar balik ke DB kapanpun sistem sehat kembali.
2. **Sistem Skalabilitas Terdistribusi Raksasa (Multipel Replikasi Server):**
   *Kasus Ekstrim:* Dalam mode *deployment cluster* raksasa arsitektur microservices lintas POD di lingkungan Kubernetes, instrumen *Library* `EventEmitter2` faktanya hanyalah *In-Memory Bus* yang terpenjara di batas ruang lingkup tiap 1 (satu) mesin instansi POD Node.js saja. Komponen _Audit Listener_ POD B takkan pernah tahu apa yang diperintahkan _User Service_ POD A.
   *Mitigasi:* Transformasikan pola pergerakan event anda; Singkirkan pemakaian `@nestjs/event-emitter` tradisional, migrasikan transport transmisinya ke perangkat pendistribusi pesan (Message Broker) bertaraf enterprise nan andal seperti *RabbitMQ*, *Apache Kafka*, ataupun setidaknya *Redis Pub/Sub*. Buatlah satu layanan mandiri khusus independen `Audit Tracking Microservice` tersendiri.
3. **Penyusupan Fatal & Kebocoran PII (Personally Identifiable Information) di Kolom Delta Payload:**
   *Kasus Ekstrim:* Pihak tim *Customer Service* super admin melakukan rekayasa sistem untuk mereset alias mengganti kata sandi atau *API token private* seorang pengguna. Komponen _Diffing_ Anda dengan naifnya mengukir rekam jejak yang menangkap *password* mode sandi lampau (terburuknya dalam kondisi teks mentah) dan abadi menyimpannya di basis data audit. Basis Data Audit umumnya dibaca dan diakses oleh ratusan staff *Data Analyst*. Akibatnya bocor masif privasi pengguna berisiko.
   *Mitigasi:* Sistem mutlak menuntut implementasi interceptor lapis perantara atau komponen fungsi _sanitizer utility processor_ persis pada detik-detik pra-emisi sebelum event di *dispatch*. Seluruh terminologi atribut struktur objek yang bernama `password`, `token`, `secret_key`, maupun `ssn_pin` diwajibkan terganti paksa isinya menggunakan string tersensor permanen mask `"***[REDACTED]***"` semasa menyusun laporan delta dari objek `oldData` maupun pada objek `newData`.
4. **Kerapuhan Flaky Tests CI/CD akibat Turbulensi Event Loop Asinkronus:**
   *Kasus Ekstrim:* Dalam pipeline otomatis pengujian tes perangkat lunak (Testing Skala *Jest E2E Integration*), perintah simulasi `await request(app.getHttpServer())` lazim menyelesaikan validasi _response HTTP OK_ miliknya sendiri jauh lebih ngebut mendahului selesainya proses komputasi sang Worker Event Emitter di _background_ yang sedang kesusahan mengeksekusi I/O palsu `await this.prisma.auditLog.create()`. Akhirnya alat validasi Assertion Tester terhancurkan dan melapor tes itu statusnya gagal _(Flaky Tests Error Random)_.
   *Mitigasi:* Spesial bagi fase siklus *environment testing* (dengan parameter sakelar `process.env.NODE_ENV === 'test'`), perbaiki instalasi *EventEmitterModule NestJS* dengan men-tweak sakelar mode *Mock* sehingga _dispatch_ yang tadinya jalan asinkron diganti paksa menjadi siklus berurut (Sinkron). Alternatif kotor lainnya yaitu memaksa test unit melakukan jeda diam statis `await sleep(100)` detik sebelum _Assertion Expection Prisma_ dijalankan agar event tereksekusi tuntas tanpa kejar-kejaran _Race Condition_.
