# CI/CD Terakselerasi dengan Nx Affected dan Distributed Caching

## 1. Pendahuluan
Dalam arsitektur monorepo skala masif yang memuat jutaan baris kode secara agregat, menjalankan tugas esensial `lint`, `test`, dan `build` untuk seluruh porsi proyek pada setiap permintaan *Pull Request* (PR) adalah sebuah anti-pattern bunuh diri yang akan secara sistematis melumpuhkan produktivitas (menghasilkan waktu putaran *pipeline* CI berjam-jam). **Nx Affected Command** menyelesaikan bencana ini dengan melakukan analisis matematis pada *dependency graph* berdasar Git delta *commits*, sehingga hanya mengeksekusi komputasi ketat pada proyek yang secara transitif dipengaruhi oleh perubahan bersangkutan. Ketika ini dipadukan dengan *Distributed Remote Caching*, waktu komputasi bisa dipangkas drastis hingga 80-90% dengan menghindari proses eksekusi ulang pada target artefak yang faktanya sudah di-*build* sebelumnya oleh mesin (agen CI) lain.

## 2. Diagram Mekanika "Affected" & Remote Cache
Berikut adalah representasi topologis bagaimana Nx menganalisis benturan dampak dari sebuah *commit* secara leksikal dan menarik sisa kalkulasi *cache* dari infrastruktur *remote server*.

```text
[Git Commit: modifies 'libs/util-crypto']
         |
         v
+-------------------------------------------------+
| Nx Dependency Graph Analyzer                    |
| 1. Deteksi perubahan inkremental 'util-crypto'  |
| 2. Cari 'dependents' vertikal dari util-crypto  |
+------------------------+------------------------+
                         |
           +-------------+-------------+
           |                           |
  [App: api-core]            [Lib: feature-user]
  (Affected: YES)              (Affected: YES)
           |                           |
           v                           v
+-------------------------------------------------+
| Nx Task Orchestrator (nx affected:build)        |
+------------------------+------------------------+
                         |
         +---------------+---------------+
         |                               |
[Check Remote Cache Node]      [Check Remote Cache Node]
 Hash: 8f9a2b...                 Hash: 4c3d1e...
         |                               |
   (Cache HIT!)                   (Cache MISS!)
         |                               |
 [Download Artifact]           [Execute Build Task]
 [Skipped CPU cycles]          [Upload to S3/Cloud]
```

## 3. Implementasi Kode & Konfigurasi Pipeline

### 3.1 Konfigurasi Distributed Remote Caching (S3 Custom Adapter)
Untuk operasi korporat monorepo yang tidak berkenan menggunakan *Nx Cloud* komersial dikarenakan kebijakan privasi keamanan kerahasiaan kaku (*On-Premise/VPC airgapped*), penyetelan mandiri *remote cache* via *AWS S3 Adapter* amat sangat diwajibkan.

```json
// nx.json (Root konfigurasi deklaratif Nx)
{
  "tasksRunnerOptions": {
    "default": {
      "runner": "@nx/workspace/tasks-runners/default",
      "options": {
        "cacheableOperations": ["build", "lint", "test", "e2e"],
        "parallel": 4
      }
    },
    "s3-remote": {
      "runner": "nx-remotecache-s3",
      "options": {
        "cacheableOperations": ["build", "lint", "test", "e2e"],
        "bucket": "my-enterprise-nx-cache-bucket",
        "region": "ap-southeast-1",
        "readOnly": false
      }
    }
  },
  "defaultTasksRunner": "s3-remote"
}
```

### 3.2 Implementasi CI Pipeline (GitHub Actions - Production Grade)
*Workflow pipeline* ini dirancang khusus untuk mengkalkulasi rekam jejak basis (*base commit target*) yang absolut akurat demi kesuksesan kalkulus perintah `affected`.

```yaml
# .github/workflows/ci.yml
name: Enterprise Immutable CI Pipeline

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code (Deep Clone for Graph Analysis)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # WAJIB ABSOLUT: nx affected membutuhkan riwayat git tree berurutan

      - name: Setup Node.js Ecosystem
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Monorepo Dependencies
        run: npm ci

      - name: Calculate Affected Graph Base Boundary (PR vs Main)
        id: nx-base
        run: |
          if [ "${{ github.event_name }}" == "pull_request" ]; then
            echo "NX_BASE=origin/main" >> $GITHUB_ENV
          else
            echo "NX_BASE=${{ github.event.before }}" >> $GITHUB_ENV
          fi

      - name: Run Affected Code Linting Enforcement
        run: npx nx affected --target=lint --base=$NX_BASE --head=HEAD --parallel=3

      - name: Run Affected Unit Testing (With Distributed Caching Support)
        run: npx nx affected --target=test --base=$NX_BASE --head=HEAD --parallel=3 --ci

      - name: Run Affected Production Build
        run: npx nx affected --target=build --base=$NX_BASE --head=HEAD --parallel=3
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

## 4. Anti-Patterns Kritis dan Praktik Terbaik

### Anti-Pattern 1: Mutasi File Eksternal Saat Testing/Build (Cache Poisoning)
❌ **Salah:** Sebuah komponen fungsi *unit test* membuat atau merusak parameter file secara statis di sistem berkas *(file system)* liar luar batas atau menautkan perhitungan acak ke variabel waktu (tanggal absolut), yang pastinya membuat *hash* produk menjadi tidak deterministik.
```typescript
// ❌ Salah, parameter waktu akan terus beranjak merubah, status cache akan senantiasa *miss* (meleset) dikarenakan input senantiasa terpolusi oleh faktor waktu runtime.
const buildTimestamp = Date.now();
fs.writeFileSync('./dist/timestamp.txt', buildTimestamp.toString());
```
✅ **Benar:** Prosedur eksekusi statis `build` dan target `test` **HARUS MULTAK** bersandar pada prinsip *pure functions*. Masukan statis konstan wajib memuntahkan *output* deterministik identik tanpa sisa jejak temporal. Serahkan ke lingkungan agen *mock* statis.

### Anti-Pattern 2: Pemanfaatan Shallow Checkout dangkal pada eksekusi CI/CD
❌ **Salah:** Menerapkan perintah argumen `--fetch-depth=1` terlampau hemat di mekanisme Git Checkout tindakan Actions.
```yaml
# ❌ Salah, sistem pelacakan Nx tidak mempunyai kepingan memori untuk membedakan commit delta, sistem akhirnya menganggap semua paket secara fatal 'affected'.
uses: actions/checkout@v4
with:
  fetch-depth: 1
```
✅ **Benar:** Penerapan mutlak `fetch-depth: 0` atau menyetel skema pelacakan rekam jejak kedalaman commit PR secara kalkulatif dinamis demi memastikan algoritma `nx affected` bekerja sempurna optimal.

## 5. Analisis Trade-Off

### Kelebihan
1. **Penghematan Skala Ekonomis dan Kronologis:** Mereduksi tajam pemakaian meteran tagihan CPU/Menit di kluster penyedia agen CI hingga puluhan ribu dolar ekuivalen per kuartal, serta durasi tunggu iterasi teknisi menyusut drastis dari estimasi 30+ menit menuju hitungan puluhan detik.
2. **Paksaan Determinisme Integritas:** Terpaksa mendisiplinkan seluruh lapisan tim operasional untuk senantiasa mewaspadai agar tugas kompilasi terbebas dari *side effects*, karena kecerobohan setetes saja akan menghancurkan rantai *cache remote* dan menuai kebocoran ke agen CI lintas benua.
3. **Kapasitas Penskalaan Paralel Horizontal:** Bergandengan mesin virtual agen CI terdistribusi (*Distributed Task Execution DTE*), target kompilasi paralel raksasa bisa ditebarkan tanpa ampun di atas armada *server* berkapasitas tanpa plafon.

### Kekurangan
1. **Kerapuhan Determinisme Global (Fragile Ecosystem):** Menggeser atau menabrak satu variabel sisipan *environment global* sepele secara sembrono otomatis seketika membongkar paksa (*mass invalidation*) eksistensi ratusan *gigabyte cache*.
2. **Retribusi Penyimpanan & Transfer (Egress) Caching:** Tagihan lalu-lintas jaringan untuk proses mengunduh muatan besar target artefak (S3 egress billings) terkadang nilainya berpotensi melampaui keekonomisan mempekerjakan *core CPU* mengomputasi ulang secara lokal.
3. **Paradoks Debugging Kriptik:** Sekali suatu artefak *build* terjebak tersimpan di dalam status *corrupt* hancur terpotong secara hening (misalnya disebabkan oleh memori sesaat OOM *Out Of Memory* di Linux tapi status *exit code* 0 alias sukses), racun mematikan dari target *cache* korup ini akan memicu ledakan masal merata terdistribusi ke seluruh *developer* (Fenomena *Cache Poisoning* akut).

## 6. Monorepo Caching Verification Test Suite

```typescript
// libs/util-crypto/src/lib/crypto.service.spec.ts
import { CryptoService } from './crypto.service';
import { ConfigService } from '@nestjs/config';

describe('CryptoService (Nx Distributed Testing Cache Determinism Absolute Enforcement)', () => {
  let service: CryptoService;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn().mockReturnValue('super-secret-deterministic-static-salt-for-remote-test'),
    } as unknown as jest.Mocked<ConfigService>;
    
    service = new CryptoService(mockConfigService);
  });

  // VERIFIKASI KEKEBALAN KETERULANGAN: Tes blok murni ini secara keras membuktikan 
  // bahwasanya kalkulasi cipher hash konsisten konstan statis, 
  // meredam dan menjaga ketat agen CI cache Nx terhindar dari skenario fatal cache poisoning lintas tenant.
  it('should rigorously generate highly deterministic output hashes for pure input payloads to prevent mass distributed CI cache poisoning', async () => {
    const inputPayload = 'deterministic_transaction_payload_nx';
    const hashIterationOne = await service.hashPassword(inputPayload);
    const hashIterationTwo = await service.hashPassword(inputPayload);

    expect(hashIterationOne).toEqual(hashIterationTwo);
    expect(typeof hashIterationOne).toBe('string');
    expect(hashIterationOne.length).toBeGreaterThan(10);
  });
});
```

## 7. Production Edge Cases

1. **Global Configuration Mass Invalidation Disaster:** Sentuhan modifikasi inkremental tipis yang berisiko pada berkas akar tumpuan `package-lock.json`, berkas TS sentral `tsconfig.base.json`, ataupun manifest `nx.json` bakal berujung malapetaka merangsang komando `nx affected` mengeksekusi dengan liar SELURUH target modul proyek secara paripurna memakan waktu brutal berjam-jam (Skala 100% *Global cache invalidation*). Tim DevOps WAJIB menaruh mata elang memonitor secara sinis segala trajektori PR yang menyentuh akar versi paket dependensi root!
2. **Distorsi Latensi DTE (Distributed Task Execution):** Pada saat perancangan konfigurasi penyalaan DTE agen-agen kuli kluster paralel di CI berbarengan dengan tumpukan ratusan barisan modul target mikro yang ekstra mini, bobot waktu (*overhead*) persiapan seremonial melakukan proklamasi agen VM *container* lantas mengangkut *manifest* konfigurasi sistem Nx justru terkalkulasi lebih mengakar memakan durasi panjang dibanding jika digempur dengan eksekusi sekuensial pararel mentah internal (Lokal CPU) untuk proyek-proyek sekunder mikroskopis.
3. **Ancaman Sabotase Keamanan Cache di Lingkungan Multi-Tenant:** Ketika tumpukan basis penyimpanan S3 *remote cache* secara naif digunakan campur-aduk oleh *freelance* pihak ketiga, segala kerahasiaan kekayaan *source-code* intelektual internal (yang terselip menyusup masuk di kompilasi *bundler frontend artifact* akibat kelalaian infiltrasi statis konfigurasi `.env`) dapat dilacak dan diunduh mundur tuntas direkayasa oleh kontraktor secara brutal melalui jalur pancingan eksploitasi peracikan *hash collision matching*. Prosedur Enkripsi simetris ganda *payload cache end-to-end* merupakan prasyarat krusial tidak terelakkan untuk arsitektur militer berskala paranoid mutlak tingkat negara.
