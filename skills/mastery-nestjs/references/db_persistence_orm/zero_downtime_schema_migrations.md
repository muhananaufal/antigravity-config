# Zero-Downtime Schema Migrations dalam Lingkungan Terdistribusi CI/CD

Melakukan penyebaran perangkat lunak *(Deployment)* tanpa mengganggu layanan *production* (*Zero-Downtime*) adalah mandat Enterprise level 1%. Namun, memodifikasi skema *database* saat ada instance lama dan instance baru dari API NestJS yang berjalan bersamaan sering menyebabkan aplikasi lama crash karena kolom dihapus atau berubah.

## 1. Arsitektur Rolling Deployment (Expand-Contract Pattern)

Pola "Expand-Contract" (atau pola Migrasi Paralel) memastikan *backward compatibility*.

```ascii
+----------------+        +-----------------+       +----------------+
|  V1 Deployment | -----> |  Database (V1)  | <---- |  V1 Deployment |
+----------------+        +-----------------+       +----------------+
      | (Rolling Update Begins)                          |
      v                                                  v
+----------------+        +-----------------+       +----------------+
|  V2 Deployment | -----> | Database (V1.5) | <---- |  V1 Deployment |
| (Reads New Col)|        | (Adds New Col)  |       | (Reads Old Col)|
+----------------+        +-----------------+       +----------------+
      | (After all V1 Pods are destroyed)                |
      v                                                  v
+----------------+        +-----------------+       +----------------+
|  V2 Deployment | -----> |  Database (V2)  | <---- |  V2 Deployment |
|                |        | (Drops Old Col) |       |                |
+----------------+        +-----------------+       +----------------+
```

## 2. Fase Expand-Contract Murni

Bayangkan kita ingin mengubah tabel pengguna, memisahkan kolom `name` menjadi `first_name` dan `last_name`.

### ❌ Anti-Pattern: Melakukan Modifikasi Berbahaya (Downtime Terjadi)
```sql
-- Dilarang Keras!
-- Saat migrasi ini jalan, Pod API versi lama akan tiba-tiba gagal mencari kolom 'name'
ALTER TABLE users RENAME COLUMN name TO first_name;
ALTER TABLE users ADD COLUMN last_name VARCHAR(255);
```

### ✅ Best Practice: Expand Phase (Langkah 1 - Persiapan Migrasi V1)
```sql
-- Tambahkan kolom baru tanpa mengganggu yang lama (Backward Compatible)
-- Biarkan kolom nullable pada mulanya untuk mencegah error INSERT dari Pod API lama.
ALTER TABLE users ADD COLUMN first_name VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN last_name VARCHAR(255) NULL;

-- Opsional: Copy data asinkronus agar sinkron 
UPDATE users SET 
  first_name = split_part(name, ' ', 1), 
  last_name = substring(name FROM length(split_part(name, ' ', 1)) + 2) 
WHERE first_name IS NULL;
```
Di level kode Node.js NestJS, *version 1.5* kode harus menulis ke **kedua** kolom (yang lama dan baru) selama fase transisi ini.

### ✅ Best Practice: Contract Phase (Langkah 2 - Penghapusan Col V1 - Diperbarui di Hari Lain)
Setelah *Deploy* V2 yang hanya bergantung pada `first_name` dan `last_name` berhasil 100%, barulah hapus:
```sql
-- Aman dilakukan karena tidak ada lagi Pod API yang memakai kolom ini
ALTER TABLE users DROP COLUMN name;
ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;
```

## 3. Eksekusi Migrasi & Table Locks (NestJS Init)

Migrasi sebaiknya dieksekusi di *Job CI/CD runner* terpisah (seperti Kubernetes Job) sebelum *Deployment* berjalan, **BUKAN** saat inisialisasi modul NestJS.

### ❌ Anti-Pattern: Eksekusi Migrasi di App Bootstrap
```typescript
// main.ts
// SANGAT BERBAHAYA: Jika HPA menaikkan 5 pod sekaligus, 
// 5 koneksi migrasi berlomba merusak tabel secara bersamaan (Race Condition).
async function bootstrapBad() {
  const app = await NestFactory.create(AppModule);
  const dataSource = app.get(DataSource);
  await dataSource.runMigrations(); // MENGUNCI DATABASE DAN MATI!
  await app.listen(3000);
}
```

### ✅ Best Practice: Kubernetes Init Containers atau Standalone CI Job
Kode aplikasi NestJS harus menganggap migrasi **sudah** beres di-terapkan oleh agen luar.

```typescript
// typeorm-cli.config.ts (Hanya untuk CLI, terisolasi)
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
config();

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  migrations: ['src/migrations/*.ts'],
  // migrationsTransactionMode: 'all' -> Bungkus satu file DDL di 1 TX aman
  migrationsTransactionMode: 'all', 
});

// package.json script: "migration:run": "typeorm-ts-node-esm migration:run -d typeorm-cli.config.ts"
// Dijalankan 1x murni dari Pipeline CI/CD sebelum Traffic Dialihan ke Pod Baru
```

## 4. Analisis Trade-Off

### Kelebihan
1. **100% Uptime:** Bisnis tidak terganggu dan pengguna tidak menerima `502 Bad Gateway` selama proses deployment.
2. **Aman untuk Revert:** Selama fase Expand, jika V2 API penuh *bug*, kita bisa me-revert instan ke V1 karena data kolom lama masih dipertahankan dan ditambahkan oleh V2.
3. **Isolasi Mutasi:** Tabel Lock tidak mengganggu latensi permintaan aktif jika DDL ditulis perlahan.

### Kekurangan
1. **Lebih Lambat & Mahal:** Proses perombakan skema tabel butuh 2-3 kali tahapan deployment di hari yang berbeda ketimbang langsung dihantam habis 1 kali di hari yang sama.
2. **Keterikatan Database Tambahan:** Developer dipaksa menulis *dual-writes* (*Application level*) untuk menjaga keselarasan baris data V1 dan V2.
3. **Storage Sementara Penuh:** Menggandakan volume data pada tabel masif menyebabkan pengerutan ruang *Disk Space*.

## 5. Production Edge Cases

1. **Access Exclusive Lock Contention:** Menambahkan index di PostgreSQL secara *default* akan mengunci tabel dari operasi WRITE. Pada tabel dengan transaksi finansial, ini menyebabkan API meledak. Selalu buat migrasi *Index* menggunakan klausa `CREATE INDEX CONCURRENTLY` (dan DILARANG dibungkus dalam blok SQL Transaction).
2. **Default Value Rekursif:** Membuat kolom baru dan memberinya nilai *default* `ALTER TABLE x ADD col INT DEFAULT 1` akan merombak (rewrite) SELURUH isi disk PostgreSQL di versi lama, menyebabkan I/O macet berjam-jam pada jutaan baris. Pada PG 11+ ini lebih aman, tapi secara historis butuh update per-*batch* bertahap.
3. **Enum Drops:** PostgreSQL tidak mendukung penghapusan label di *Enum* tipe asli. Harus melalui manipulasi migrasi yang canggung dengan tipe varchar atau pembuatan custom tipe sementara, sehingga sering merusak integritas *TypeORM Synchronization*.

## 6. Unit Testing Konseptual Migrasi (Jest)

```typescript
describe('Zero Downtime Migration Compatibility Check', () => {
  it('should verify dual-write behavior during transition phase', () => {
    const payload = { fullName: 'John Doe' };
    
    // API logic di versi transisi (Expand Phase)
    const entity = {
      // Menulis pada Kolom Lama agar v1 Pod tidak rusak
      name: payload.fullName, 
      // Menulis pada Kolom Baru bersiap untuk v2
      first_name: payload.fullName.split(' ')[0],
      last_name: payload.fullName.split(' ')[1] || '',
    };
    
    expect(entity.name).toBe('John Doe');
    expect(entity.first_name).toBe('John');
    expect(entity.last_name).toBe('Doe');
  });
});

## 7. Strategi Blue-Green Migration & Database Topology

Blue-Green deployment seringkali hanya dikaitkan dengan *stateless application pods*, namun mengaplikasikannya pada tingkat *database* membutuhkan kehati-hatian tingkat tinggi, terutama soal replikasi dua arah (bidirectional replication).

### ❌ Anti-Pattern: Isolasi Database Tanpa Sinkronisasi
Menggunakan dua instansi database (Blue dan Green) yang sepenuhnya terpisah tanpa replikasi sinkron.
Saat rute trafik dipindahkan (switch-over) ke aplikasi Green, pengguna tiba-tiba tidak menemukan data terbaru yang mereka ubah di Blue beberapa detik sebelumnya (Downtime Data).

### ✅ Best Practice: Logical Replication Transisi
Dalam skema Blue-Green murni pada *database* (misalnya menggunakan AWS RDS Blue/Green Deployments, GCP Cloud SQL, atau logical replication manual PG 10+):
1. **Blue (Primary):** Melayani trafik produksi yang berjalan.
2. **Green (Replica):** Node cadangan (Clone dari Blue), di mana kita menerapkan DDL migrasi (skema baru).
3. Replikasi logikal (Logical Replication) tetap berjalan dari Blue ke Green untuk mensinkronkan baris-baris data yang baru disisipkan.
4. Saat *Deployment Switch-over*, trafik di-*routing* ke Green (Primary baru).
5. Lingkungan Blue kemudian dimatikan secara bertahap.

**Analisis Trade-Off Blue-Green Database:**
- **Kelebihan:** Skema migrasi yang sangat berat (seperti mengubah tipe data kolom `UUID` menjadi `BIGINT` di miliaran baris atau re-sharding tabel) dapat berjalan secara independen tanpa menahan transaksi aplikasi utama (Lock contention).
- **Kekurangan:** Jika terjadi *rollback* darurat karena bug aplikasi (Green dibatalkan dan trafik dikembalikan ke Blue), mengembalikan data yang sudah sempat tertulis di Green kembali ke Blue sangat berisiko tanpa replikasi dua arah (bidirectional) atau kompensasi manual.

## 8. Shadow Database Testing di Pipeline CI/CD

Menerapkan zero-downtime membutuhkan kepastian bahwa skrip migrasi tidak gagal saat dijalankan. CI/CD pipeline (GitHub Actions, GitLab CI) harus menguji migrasi terhadap *Shadow Database* yang mereplikasi arsitektur tanpa isi data produksi.

### ✅ Best Practice: Shadow DB Validation Test
Gunakan *shadow schema* / *ephemeral database* di dalam *docker service CI* untuk memvalidasi bahwa eksekusi skrip `up` dan skrip `down` bekerja mulus secara sintaksis.

```typescript
// script: ci-shadow-migration-test.ts
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import * as process from 'process';

async function validateMigrations(): Promise<void> {
  const logger = new Logger('MigrationValidator');
  
  // DILARANG keras menggunakan process.env langsung untuk hardcode credential atau secret di kode source.
  // Pastikan URL disuntikkan murni dari Vault / Secret Manager di CI Runner.
  const shadowDbUrl: string | undefined = process.env.SHADOW_DATABASE_URL;
  
  if (!shadowDbUrl) {
    throw new Error('SHADOW_DATABASE_URL is required for CI testing');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: shadowDbUrl,
    migrations: ['src/migrations/*.ts'],
    logging: ['query', 'error'],
  });

  try {
    await dataSource.initialize();
    logger.log('Shadow DB initialized');
    
    // 1. Uji Migrasi Naik (UP - Apply Migrations)
    const runMigrations = await dataSource.runMigrations();
    logger.log(`Successfully ran ${runMigrations.length} migrations in shadow DB`);
    
    // 2. Uji Migrasi Turun (DOWN - Revert Migrations) untuk memvalidasi fungsi rollback aman tanpa error sintaks
    if (runMigrations.length > 0) {
      for (let i = 0; i < runMigrations.length; i++) {
         await dataSource.undoLastMigration();
      }
      logger.log('Successfully reverted all migrations in Shadow DB. Rollback sanity check passed.');
    }
  } catch (error: unknown) {
    const err = error as Error;
    logger.error(`Migration validation failed: ${err.message}`, err.stack);
    process.exit(1); // Gagal CI Job
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

validateMigrations();
```

**Analisis Trade-Off Shadow DB Testing:**
- **Kelebihan:** Menjamin sintaks DDL valid sebelum menyentuh server Production, mencegah kegagalan pipeline di tengah jalan yang berisiko membuat struktur data tidak konsisten.
- **Kekurangan:** Menambah durasi (waktu build) CI/CD. Membutuhkan instansi database sementara yang memakan sumber daya dan harus di-*provisioning* serta dihancurkan setiap kali commit PR.

## 9. Migration Lock Prevention (Timeout Control)

PostgreSQL menggunakan *Access Exclusive Lock* pada beberapa operasi DDL (misal `ALTER TABLE`). Jika aplikasi sedang aktif memegang lock transaksi (*Read/Write*), perintah DDL migrasi akan mengantre dan memblokir seluruh kueri baru yang masuk di belakangnya (menyebabkan *cascading connection timeout* API).

### ❌ Anti-Pattern: Infinite Wait Locks (Migrasi Menjadi Blocker)
Migrasi dibiarkan menunggu (wait) selama mungkin hingga mendapatkan lock. Hal ini dapat membuat keseluruhan microservices lumpuh jika terjadi kebuntuan (*deadlock*).

### ✅ Best Practice: Set Statement & Lock Timeout
Setiap *script* migrasi mentah wajib menetapkan perlindungan `lock_timeout`.

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndexToUsers1690920000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Batasi waktu DDL menunggu giliran lock (maksimum 2 detik)
    await queryRunner.query(`SET lock_timeout = '2s';`);
    // 2. Batasi waktu query eksekusi berjalan (maksimum 10 detik)
    await queryRunner.query(`SET statement_timeout = '10s';`);

    // Eksekusi DDL aman. Jika gagal mendapatkan lock dalam 2 detik, 
    // migrasi gagal secara Fail-Fast tanpa mematikan API Production.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;`);
  }
}
```

**Analisis Trade-Off Lock Timeout:**
- **Kelebihan:** Sangat aman untuk High-Availability. Gagal dengan cepat (*Fail-fast*) jauh lebih baik ketimbang degradasi sistem massal akibat *connection pool* yang habis.
- **Kekurangan:** Jika basis data selalu sibuk dengan transaksi berat 24/7, migrasi berpotensi terus-menerus gagal dieksekusi karena tidak pernah mendapat antrean di bawah 2 detik. Memerlukan sistem *retry* manual atau jendela pemeliharaan (*maintenance window*).

## 10. Rollback Strategies: Backward Compatibility vs Kompensasi Data

*Rollback* dari migrasi *database* sangat krusial jika *bug* ditemukan sesaat setelah *Deployment*.

### 1. Backward Compatibility (Pola Expand-Contract Rekomendasi Utama)
Dengan pola *Expand-Contract* yang dijabarkan sebelumnya, eksekusi migrasi turun (`Down Migration` / `Rollback Schema`) secara harafiah **HAMPIR TIDAK PERNAH DIBUTUHKAN**. 
- Jika Pod/API V2 gagal total, Pod V1 dapat langsung di-*deploy* ulang dengan instan. 
- *Database* dibiarkan statis dalam kondisi *Expanded* (terdapat kolom baru, tetapi diabaikan oleh V1 API). 
- Keamanan terjamin, nol data lenyap.

### 2. Strategi Kompensasi Data (Jika Backward Compatibility Mustahil)
Jika migrasi terlanjur merusak nilai data logis (seperti kesalahan memformat teks atau salah *update* pada tabel referensi silang), mengandalkan skrip migrasi `down` tidak akan cukup karena jejak modifikasi lama sudah hilang. 
- **✅ Best Practice:** Menjalankan pendekatan *Point-in-Time Recovery* (PITR) (via AWS RDS/GCP CloudSQL Console) untuk kerusakan tingkat parah. 
- Atau, tulis skrip migrasi baru yang disebut skrip "Data Fix" alih-alih mengeksekusi `undoLastMigration()`.
- **❌ Anti-Pattern:** Menjalankan `undoLastMigration()` (skrip turun) ketika aplikasi Production masih menerima trafik. Hal ini sangat mengancam karena bisa menghapus kolom yang baru saja secara pasif ditulis oleh pengguna selama V2 menyala 10 menit terakhir, yang mengakibatkan lenyapnya transaksi finansial yang sah.

## 11. Tambahan Edge Cases di Operasional Terdistribusi

4. **Multi-Region Replica Lag (Stale Reads):** Pada sistem basis data terdistribusi geografis (misalnya Amazon Aurora Global Database), DDL migrasi yang dieksekusi di wilayah *Primary* membutuhkan rentang waktu asinkron milidetik hingga belasan detik untuk menyebar ke simpul *Read Replicas*. API di zona *Read* dapat mengembalikan kegagalan (HTTP 500) jika penyebaran pembaruan Pod/API diselesaikan tepat pada saat DDL replika sedang dalam penundaan perambatan. Mengalihkan pembacaan ke simpul *Primary* untuk baris yang baru disisipkan adalah metode perlindungan utama.
5. **Connection Pooling Cache Drain (PgBouncer):** Menjalankan migrasi operasional tingkat tinggi (DDL) pada arsitektur yang menggunakan kumpulan proksi *connection pooler* eksternal seperti PgBouncer (khususnya *transaction pooling mode*) mengharuskan transisi cermat. Transmutasi struktur tipe tabel mampu secara fatal menginvalidasi rencana *prepared statements* yang sedang di- *cache* oleh ORM / PgBouncer, melempar pesan kesalahan parah seperti `cached plan must not change result type`. Penanganan terbaik mencakup pembersihan (*flush*) paksa, penerapan parameter `DISCARD ALL`, atau merestart simpul *connection pooler* serentak ketika skema basis data diubah besar-besaran.
```
