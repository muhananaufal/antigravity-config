# Testcontainers Docker QA: Integrasi CI/CD Ekosistem Nyata

## Pengantar
Melakukan pengujian E2E (End-to-End) ke basis data tiruan in-memory (seperti SQLite) seringkali menyamarkan ketidakcocokan kueri (query dialect) antara lokal dan basis data raksasa nyata (seperti PostgreSQL atau koneksi broker *Kafka*). Menyiapkan replika *instance* eksternal via docker-compose tradisional seringkali berakibat buruk (ketergantungan infrastruktur lintas CI, port tabrakan, pembersihan database kotor *stale data*). 

Jawaban absolut yang membasmi penderitaan ini di ekosistem NestJS adalah integrasi mendalam dari **Testcontainers Node**. Anda merakit kontainer *Docker* sesungguhnya (melalui NodeJS) berisikan PosgreSQL dan Redis dengan *ephemeral lifecycle* persis sebelum test pertama dimulai, dan sistem akan mengikisnya menjadi debu setelah selesai.

---

## Arsitektur Dinamika Testcontainers

```ascii
+-------------------------------------------------------------+
|              TESTCONTAINER LIFECYCLE MANAGEMENT             |
+-------------------------------------------------------------+
| 1. JEST beforeAll()                                         |
|    |-> Memanggil Docker Daemon API via IPC                  |
|    |-> Tarik image postgres:15-alpine                       |
|    |-> Menyuntik env (USER, PASS, DB) & binding Port acak   |
| 2. JEST start NestJS Module (Koneksi ke port acak tsb)      |
| 3. TEST SUITE RUNS (Eksekusi Real PostgreSQL Query!)        |
| 4. JEST afterAll()                                          |
|    |-> Destroy & Prune Container (Tidak ada residu data!)   |
+-------------------------------------------------------------+
```

## Setup Node.js Type-Safe & Contoh Test Suite

Berikut adalah panduan murni bagaimana merakit kontainer *PostgreSQL* dalam satu siklus `Test.createTestingModule` E2E di NestJS secara dinamis dan statik.

### `database.config.spec.ts` (Bagian Injeksi Kontainer)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { INestApplication } from '@nestjs/common';
import { Entity, PrimaryGeneratedColumn, Column, Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

// Entitas Basis Data Dummy
@Entity('users')
class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  public readonly id!: string;

  @Column()
  public email!: string;
}

describe('PostgreSQL Real Container QA Suite', () => {
  let app: INestApplication;
  let postgresContainer: StartedPostgreSqlContainer;
  let userRepository: Repository<UserEntity>;

  // BUKA DOCKER CONTAINER SEBELUM TEST
  beforeAll(async () => {
    // Meminta Testcontainer untuk mendirikan Database PostgreSQL ephemeral (sementara)
    // JANGAN PERNAH HARDCODE PORT! Testcontainers menangani port dinamis.
    postgresContainer = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('qa_test_db')
      .withUsername('test_user')
      .withPassword(process.env.TEST_DB_PASSWORD || "Test1234!")
      .start();

    // Inisiasi Modul NestJS, arahkan koneksi ke konfigurasi testcontainers
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: postgresContainer.getHost(),
          port: postgresContainer.getPort(),
          username: postgresContainer.getUsername(),
          password: postgresContainer.getPassword(),
          database: postgresContainer.getDatabase(),
          entities: [UserEntity],
          synchronize: true, // Auto generate schema khusus test bed
        }),
        TypeOrmModule.forFeature([UserEntity]),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    userRepository = moduleFixture.get<Repository<UserEntity>>(
      getRepositoryToken(UserEntity),
    );
  });

  // HANCURKAN DOCKER CONTAINER SETELAH TEST
  afterAll(async () => {
    await app.close();
    if (postgresContainer) {
      await postgresContainer.stop();
    }
  });

  it('should successfully perform raw CRUD operation on real PostgreSQL database', async () => {
    // Pengujian ini terjamin dieksekusi di database aslinya (bukan in-memory SQLite)
    const newUser = userRepository.create({ email: 'qa.master@antigravity.io' });
    const savedUser = await userRepository.save(newUser);

    expect(savedUser.id).toBeDefined();
    
    // Tarik ulang via database asli
    const retrieved = await userRepository.findOneBy({ id: savedUser.id });
    
    expect(retrieved).toBeDefined();
    expect(retrieved?.email).toStrictEqual('qa.master@antigravity.io');
  });
});
```

---

## Analisis Trade-Off

### Kelebihan
1. **Kepercayaan Total Lintas Platform**: Tes akan menguji skema kueri tingkat lanjut (`JSONB`, fungsi geografis `PostGIS`, atau Indeks Unik majemuk) persis sesuai perilaku pada sistem *production*.
2. **Kemandirian (Self-Contained & Ephemeral)**: Berkas E2E memiliki kewenangan mutlak memicu infrastrukturnya sendiri! Tanpa intervensi skrip administrasi `docker-compose up` & `down` manual antar tim.
3. **Penyelesaian Bentrok Data**: Memastikan basis data setiap iterasi eksekusi pengujian adalah "perawan" dan nihil data kotor residual sisa sesi sebelumnya.

### Kekurangan
1. **Beban Overhead Waktu Tarik (Pull Image Penalty)**: Siklus eksekusi pertama akan berjalan sangat lambat, bisa memakan bermenit-menit semata-mata untuk mengunduh direktori layer citra (image layer) *Docker* jika cache belum tersedia.
2. **Keharusan Docker Daemon Running**: Pengembang atau lingkungan *runner* CI (seperti Github Actions) WAJIB mengekspos mesin Docker aktif dengan hak akses IPC daemon, jika tidak maka error fatal peluncuran soket container akan meledak.
3. **RAM dan CPU Tinggi**: Merakit Node, Jest, Postgre, Redis secara berjejal menghabiskan sumber daya berat komputer yang bisa melumpuhkan laptop pengembang dengan RAM < 16GB.

---

## Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan Port Tetap (Hardcoded Bind) di Container
Mencoba memaksakan kontainer berjalan di port spesifik (`.withExposedPorts(5432)` dan mengikat port *Host* statis). Ini menghancurkan kemungkinan tes dieksekusi paralel oleh para developer yang membagi mesin server bersama!

```typescript
// ❌ CONTOH SALAH - Pemetaan port fix yang merusak CI paralelisasi
postgresContainer = await new PostgreSqlContainer('postgres:15-alpine')
  .withExposedPorts(5432) // Potensi PORT COLLISION TINGGI!
  .start();
```

```typescript
// ✅ CONTOH BENAR - Biarkan Docker OS secara dinamis mengatur port acak
postgresContainer = await new PostgreSqlContainer('postgres:15-alpine')
  .start();
const dynamicPort = postgresContainer.getPort(); // Dynamic & Conflict Free!
```

### ❌ Anti-Pattern 2: Lupa Timeout Panjang di Jest Setup
Terkadang proses start Docker image Kafka atau PostgreSQL yang gemuk melebihi waktu toleransi *timeout* bawaan *Jest hook* (standar 5 detik).

```typescript
// ❌ CONTOH SALAH - Hook Default tanpa perpanjangan timeout
beforeAll(async () => {
    // Setup docker disini, akan meledak Timeout jika sistem lemot
});
```

```typescript
// ✅ CONTOH BENAR - Bypass Timeout Jest di hook inisiasi container berat
beforeAll(async () => {
    // Setup docker start
}, 60000); // 60 Detik Buffer Limit
```

---

## Production Edge Cases

1. **Jebakan CI Docker-in-Docker (DinD)**: Di lintasan *Github Actions* atau *Gitlab CI* yang mengeksekusi tes di dalam Docker, menyalakan testcontainers berarti Anda mengaktivasi mode `Docker-in-Docker`. Ada batas pelik terkait *network routing host* (misalnya URL `localhost` di dalam container CI tidaklah sama dengan `host.docker.internal`). Penambahan parameter konfigurasi penyeimbangan *hostname* dinamis seringkali dituntut.
2. **Dead Container Leaks**: Jika tes Jest hancur dengan panik massal secara kotor (`process.exit(1)` seketika tanpa `afterAll` tereksekusi), kontainer *Docker* yang dipicu bisa tertinggal menjadi zombi (orphan) tanpa dimatikan. Testcontainers telah menyiasati hal ini menggunakan integrasi *Ryuk Container* (pemulung kontainer), pastikan Anda membiarkan proses Ryuk berjalan di *background*.
3. **Beban Migrasi Kustom vs Sinkronisasi**: Jika sistem basis data sangat besar, *TypeORM `synchronize: true`* akan bekerja sangat lama merakit skema tiruan dari nol. Jika migrasi *SQL* asli (flyway/typeorm CLI) yang diutamakan, Anda diwajibkan menulis ulang eksekusi migrasi kustom berbasis *command execution* Node.js secara programatik setelah *PostgreSQL* kontainer dinyatakan `started`.

## Topik Lanjutan QA Enterprise: Testcontainers Docker

### 1. Strategi Reuse Container (`TESTCONTAINERS_REUSE_ENABLE`)
Membuat kontainer untuk setiap *Test Suite* seringkali sangat lambat (memakan 2-5 detik per fail). Testcontainers menawarkan fitur eksperimental *Reuse* (penggunaan ulang).
- **Cara Kerja**: Anda menetapkan environment variable `TESTCONTAINERS_REUSE_ENABLE=true` di OS. Di dalam kode, Anda menambahkan `.withReuse()` pada *builder* kontainer.
- **Konsekuensi**: Kontainer tidak akan mati otomatis setelah *test* selesai, melainkan dibiarkan hidup. Saat tes lain dengan konfigurasi identik meminta kontainer, Testcontainers akan menumpang (*attach*) ke kontainer yang sudah hidup.
- **Peringatan (Edge Case)**: Anda wajib memastikan pembersihan (*truncate*/*delete*) seluruh tabel antar tes secara manual di `afterEach`, karena kotoran data dari *test suite* sebelumnya tidak lagi lenyap bersama hancurnya kontainer!

### 2. `GenericContainer` vs Spesifik `PostgreSqlContainer`
Testcontainers menyediakan modul pembungkus siap pakai seperti `PostgreSqlContainer` yang menutupi kompleksitas (seperti *username*, *password*, DB otomatis). 
- Namun, dalam arsitektur eksotik (seperti ClickHouse, VictoriaMetrics, atau server internal kustom perusahaan), Anda wajib menggunakan `GenericContainer`.
- Menggunakan `GenericContainer` menuntut Anda untuk mendefinisikan *Exposed Ports* spesifik untuk internal Docker jaringan, menetapkan *Environment Variables* secara manual, serta merakit `Wait Strategy` secara independen.

```typescript
// ✅ Contoh Generic Container untuk layanan kustom
const customCache = await new GenericContainer('redis:7-alpine')
  .withExposedPorts(6379)
  .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
  .start();
```

### 3. Container Startup Health Check Waiting
Terkadang, sebuah kontainer me-respons "berjalan" (OS Docker Process UP), namun proses internal basis datanya masih inisialisasi dan belum siap menerima koneksi TCP.
- ❌ **Anti-Pattern**: Menggunakan `setTimeout` buta selama 10 detik.
- ✅ **Praktik Terbaik**: Gunakan *Wait Strategy* bawaan Testcontainers. `PostgreSqlContainer` otomatis menggunakan strategi penungguan (*wait strategy*) khusus hingga log menyatakan basis data siap. Pada kontainer generik, pakailah strategi seperti `.withWaitStrategy(Wait.forHealthCheck())` (asumsi ada direktif `HEALTHCHECK` di Dockerfile) atau `Wait.forListeningPorts()`.

### 4. Parallel Container Composition (Docker Compose vs Multiple Containers)
Untuk skenario kompleks di mana aplikasi membutuhkan PostgreSQL, Redis, dan Kafka sekaligus, Anda punya dua pilihan:
- Memulai tiga instans `GenericContainer` secara paralel (via `Promise.all`).
- Menggunakan `DockerComposeEnvironment`.
- **Trade-Off**: Pendekatan `Promise.all` memberikan kontrol *programmatic* penuh pada Jest dan memastikan ephemerality port dinamis tanpa bentrok. Pendekatan `DockerComposeEnvironment` lebih mudah bagi yang familiar dengan `docker-compose.yml`, namun rentan bentrok nama kontainer jika Jest menjalankan *worker* secara paralel di mesin CI tunggal. **Rekomendasi**: Selalu gunakan multikontainer spesifik `Promise.all`.

### 5. Strategi Optimasi CI/CD Ekstrem
Menjalankan Testcontainers di GitLab CI atau GitHub Actions seringkali tersendat pada fase *Pull Image Docker*.
- **Penyelesaian 1**: Manfaatkan fitur mekanisme *Docker Cache Layer* di CI (seperti fitur *Cache* pada buildx) atau gunakan *Docker Registry Proxy* internal untuk menarik citra secara lokal di jaringan CI.
- **Penyelesaian 2**: Eksekusi pra-tarik (*Pre-pull*) *image* sebagai langkah pertama di CI *pipeline* Anda sebelum menginisiasi eksekusi ekosistem Jest, sehingga ketika NodeJS memanggil Testcontainers, seluruh citra sudah utuh (*cached*) di dalam Docker *Daemon Runner*.
- **Keamanan (Security)**: Jangan pernah injeksikan *credential* rahasia produksi ke konfigurasi `TEST_DB_PASSWORD` atau Env kontainer uji. Selalu gunakan nilai rahasia rekaan (misal: `process.env.QA_DUMMY_SECRET || 'qa-secret-pass'`).
