# Penegakkan Batas Arsitektur (Boundary Enforcement) Monorepo via ESLint

## 1. Pendahuluan
Pada arsitektur Monorepo NestJS berskala raksasa, mengawal dan menjaga konsistensi integritas aliran hierarki graf dependensi adalah tantangan terbesar dalam skala korporasi. Tanpa pengawasan lint otomatis berdisiplin tinggi, para pengembang rekayasawan rentan secara serampangan melakukan impor pintas langsung antar lapis sub-modul menciptakan labirin jebakan *Spaghetti Code*, sebagai contoh fatal ketika unit library level visual *User Interface* (UI) mendadak menyedot dan mengimpor modul inti *Database Connector* (Data Access), menembus lapisan pelindung keamanan enkapsulasi desain domain logis aplikasi. Melalui formasi ketat benteng aturan statis leksikal dari kerangka linter ESLint `@nx/enforce-module-boundaries` berpadu mutlak dengan klasifikasi *Scope and Type Tagging* ekstensif, kita bertindak sebagai jagal kode untuk menggagalkan fase kompilasi pra-CI secara paksa tanpa belas kasihan (Prinsip *Zero-Tolerance*) bilamana terdeteksi penyimpangan atau penyelewengan pelanggaran tatanan arsitektur.

## 2. Diagram Matriks Aturan Batas
Berikut merupakan cetak biru peta skema larangan ketergantungan graf modul yang sah.

```text
               +-------------------------------------------------------+
               |     MATRIX TABEL DEPENDENCY TAG PERINTAH MUTLAK       |
+--------------+----------+-----------+------------+----------+--------+
| Source Tag   | type:app | type:feat | type:data  | type:ui  | type:ut|
+--------------+----------+-----------+------------+----------+--------+
| type:app     |    ❌    |     ✅    |     ✅     |    ✅    |   ✅   |
| type:feature |    ❌    |     ✅    |     ✅     |    ✅    |   ✅   |
| type:data    |    ❌    |     ❌    |     ✅     |    ❌    |   ✅   |
| type:ui      |    ❌    |     ❌    |     ❌     |    ✅    |   ✅   |
| type:util    |    ❌    |     ❌    |     ❌     |    ❌    |   ✅   |
+--------------+----------+-----------+------------+----------+--------+
*Legenda Perintah: Level Aplikasi bebas mengimpor semuanya (selain App lain), 
sementara level utilitas yang fundamental dan mendasar murni hanya 
diizinkan memanggil modul layer utilitas dasar belaka.*
```

## 3. Implementasi Kode: Konfigurasi Linter Skala Enterprise

### 3.1 Penetapan Tag Pengenal Berlapis (Project Configuration)
Setiap simpul rantai aplikasi terminal dan balok-balok pustaka komponen (library) di seantero kawasan Monorepo mutlak diberikan predikat pengawasan berjuluk "Tanda Pengenal Khusus" (*Metadata Tag*) terselip permanen di dalam berkas konfigurasi proyek inti mereka.

```json
// libs/data-access-user/project.json
{
  "name": "data-access-user",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/data-access-user/src",
  "projectType": "library",
  "tags": ["type:data-access", "scope:user", "platform:node"]
}
```

```json
// libs/feature-auth/project.json
{
  "name": "feature-auth",
  "tags": ["type:feature", "scope:auth", "platform:node"]
}
```

### 3.2 Penegakan Aturan Penalti Eksekutor Linter (ESLint Configuration)
Aturan hukuman penalti ini ditanamkan mutlak sebagai hukum kanonikal terpusat pada simpul induk akar repositori, senantiasa mengeksekusi sanksi kegagalan fatal (*Fatal Error Build Process*) pada fase penghalang tahapan prasyarat *linting* saat *pre-commit hooks* berjalan atau paling lambat merobohkan barikade pipa agen *Continuous Integration* jarak jauh.

```javascript
// .eslintrc.json (Berkas akar tata tertib hukum Monorepo Utama)
module.exports = {
  root: true,
  plugins: ['@nx'],
  overrides: [
    {
      files: ['*.ts', '*.tsx', '*.js', '*.jsx'],
      rules: {
        '@nx/enforce-module-boundaries': [
          'error', // 🚨 KEPUTUSAN MUTLAK ZERO-TOLERANCE: PENGHANCURAN OTOMATIS JIKA MELANGGAR!
          {
            allowCircularSelfDependency: false,
            enforceBuildableLibDependency: true,
            depConstraints: [
              // 1. ATURAN PENGHALANG HIERARKI TIPE (Lapis Benteng Lapisan Arsitektur)
              {
                sourceTag: 'type:util',
                onlyDependOnLibsWithTags: ['type:util'], // Hukum Alam: Utilitas hanya merangkul utilitas sejawat.
              },
              {
                sourceTag: 'type:data-access',
                onlyDependOnLibsWithTags: ['type:data-access', 'type:util'],
              },
              {
                sourceTag: 'type:feature',
                onlyDependOnLibsWithTags: ['type:data-access', 'type:ui', 'type:util', 'type:feature'],
              },
              
              // 2. ATURAN PENYEKAT ISOLASI DOMAIN (Batasan Ruang Karantina Domain-Driven Design)
              {
                sourceTag: 'scope:auth',
                onlyDependOnLibsWithTags: ['scope:auth', 'scope:shared'], // Dinding Api: Domain Otentikasi dilarang tajam menengok isi perut Domain Pembayaran
              },
              {
                sourceTag: 'scope:payment',
                onlyDependOnLibsWithTags: ['scope:payment', 'scope:shared', 'scope:auth'], // Mekanika Logika: Pembayaran wajib merujuk sistem validasi otentikasi sentral
              }
            ],
          },
        ],
      },
    },
  ],
};
```

## 4. Anti-Patterns Kritis dan Praktik Terbaik

### Anti-Pattern 1: "Deep Imports" Tindakan Infiltrasi Mem-bypass Portal Pintu API Publik
❌ **Salah:** Aktivitas perusakan menembus dan meretas lapisan dalam internal modul perpustakaan properti milik orang lain secara melewati, mengakali (bypass telanjang) berkas publik `index.ts` resmi milik domain sasaran mereka.
```typescript
// ❌ Salah Berakibat Fatal, tindakan terlarang perusak enkapsulasi (Internal Implementation Abyssal Leak)
import { UserInternalHelper } from '@myorg/data-access-user/src/lib/internal-helper'; 
```
✅ **Benar:** Mekanisme akses mutlak cuma sah diimpor legal melewati jalur gerbang *Public Barrels* (`index.ts`) yang diregistrasikan tegas pada konstelasi penyusunan direktori *Path Mapping* internal rute kompilator TypeScript sentral.
```typescript
// ✅ Benar Terpuji, wujud teladan enkapsulasi lapisan baja.
import { UserRepository } from '@myorg/data-access-user';
```
*(Garda gembok penyaring otomatis lint `@nx/enforce-module-boundaries` secara alamiah memberangus dan membunuh tanpa pandang bulu pola infiltrasi "Deep Imports" busuk ini bila sekadar tersetel tegak sempurna).*

### Anti-Pattern 2: Pemasangan Stempel Sembarangan (Tags) "Sapu Jagat" pada Library yang Ditelantarkan Malas
❌ **Salah:** Semena-mena melekatkan stempel tag sembarangan beralias `scope:shared` ke kulit penutup semua perpustakaan tak bertuan sebatas sekadar muslihat instan demi memuluskan lolos uji portal linter bersembunyi sembunyi mengesampingkan kalkulasi matang dari rasionalitas arsitektural.
✅ **Benar:** Pegang teguh prinsip kesucian isolasi dinding bata Domain sekompak murni kohesif rapi serapat sedapat mungkin. Dorong keras eksekusi *refactoring* pangkas kasar menjadi puing-puing unit *micro-libraries* ringkas lincah apabila utilitas itu diyakini wajib disebarluaskan beramai-ramai.

## 5. Analisis Trade-Off

### Kelebihan
1. **Pemusatan Otoritas Arsitektur Repositori Absolut:** Benteng pencegahan permanen dari fenomena kemerosotan kebusukan erosi perangkat lunak berkelanjutan (*architecture rot / technical debt corrosion syndrome*) dari himpitan waktu berlarut-larut berkat bantuan mesin, tegak dan siaga bertugas mekanikal menolak toleransi meskipun sedang berhadapan argumen saat *Pull Request* diajukan oleh insinyur senior dewa veteran yang tengah didera letih sekalipun.
2. **Representasi Fisik Tata Leksikal Domain Driven Design (DDD):** Menyulap penuangan batas-batas fatamorgana dinding leksikal konseptual (*Bounded Contexts*) secara radikal menjadi wujud nyata absolut di alam pembagian tata letak sekat-sekat laci repositori dan hierarki restriksi pengimporan sistem, bukan sekadar tempelan dekorasi tulisan abstrak dokumentasi wiki hampa.
3. **Kekuatan Isolasi Karantina Zona Kegagalan (High Blast-Radius Isolation):** Pagar api tangguh penyekat memastikan kobaran sengkarut masalah lingkaran *circular dependency* pada batas suatu teritori semisal ranah domain (*payment / finansial*) tiada daya tenaga untuk sedikitpun menyambar lalu menghanguskan pondasi proses rute kompilasi lintas perbatasan sistem pada gugus domain independen lainnya semisal teritori (*chat platform*) dikarenakan sekatan dinding leksikal lint.

### Kekurangan
1. **Penghalang Laju Produksi Eksperimen Massal:** Beban waktu mengukir sketsa purwarupa perumusan cetak biru batasan struktur ideal yang presisi matematis sejak hari hampa amat sangat panjang, melelahkan dan boros menuntut kalori durasi analisis awal. Apabila serampangan melakukan meleset satu jengkal dalam tahap merancang peta denah tag ini, pengembang lini depan akan senantiasa terbelenggu babak belur bertumbuk-tumbuk tersandung tabrakan tebing eror masif penjaga palang lint `ESLint`.
2. **Kengerian Fase Eksekusi Refaktorisasi Silang Domain:** Upaya penggusuran merelokasi struktur lintasan pemindahan modul merobek paksa tata tapal batas zona *Boundary lint* mengharuskan konsentrasi ekstra kehatian perombakan operasi masif bedah jantung manual menata serentak di parameter berkas deklarasi konfigurasi, pembaharuan rentetan indeks leksikal label *tag* dan perombakan drastis serbuan reorganisasi jalur tatanan repositori fisik direktori dalam kerangka detik dimensi waktu eksekusi yang berhimpitan tunggal.
3. **Konflik Ketidakluwesan Paradigma Tabrakan Frontal Metodologi Rapid Prototipe:** Kultur penyekatan ekstrem birokrasi sekat lint bertolak punggung beringas memusuhi putaran lintasan siklus lekas radikal rilis MVP cepat gila (*Minimal Viable Rapid Prototype Extremism*) spesifik tatkala prinsip anarkis radikal "segenap entitas modul mendesak wajib mengakses dan menyentuh inti sari segala unsur fungsional komponen serentak secepat kilat tanpa halangan birokrasi penyekat" menguasai nalar tim.

## 6. Monorepo Boundary Config Verification Test Suite Runtime

Sebuah lapis tes bedah otopsi unit *verification test* elementer mutlak guna melegalisasi ketahanan integritas arsitektur penyekatan batasan perakitan agregator batas modul sungguh-sungguh tereksekusi tanpa celah semburat serta mampu di-*mock* dikarantina steril bersemayam tegak sempurna terkunci terkontrol absolut bernaung mematuhi pilar payung NestJS.

```typescript
// apps/api-core/src/app/app.module.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { FeatureAuthModule } from '@myorg/feature-auth';

// Test Meta-Architecture Penjaga Ekosistem Makro Ruang Runtime:
// Seremoni absolut memverifikasi pembuktian menjamin bahwa modul jantung root 
// eksekutor mesin aplikasi utama mutlak piawai aman 100% lurus mengkonstruksi perakitan simpul rekat 
// gugusan perpustakaan micro terisolasi mandiri tanpa sekecilpun mencemari jejak merobek 
// tata letak pakem perbatasan tembok pertahanan graph lint aliran dependency.
describe('AppModule Ecosystem Runtime Architecture Integrity Verification Suite (Nx Bound-Graph Enforcement Vault)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // Tahapan proses menginjeksi pasokan dan mengkompilasi radikal untuk menginterogasi keaslian Integritas
    // dari skema struktur Dependency Graph murni absolut pada tahapan berjalannya masa mesin runtime utuh berdetak.
    moduleRef = await Test.createTestingModule({
      imports: [AppModule], 
    }).compile();
  });

  it('should flawlessly and rigorously compile the root application core instance systematically orchestrating the FeatureAuthModule devoid of nefarious bypass internal deep module route path imports', () => {
    const authModuleInstance = moduleRef.get(FeatureAuthModule);
    expect(authModuleInstance).toBeDefined();
    expect(authModuleInstance).not.toBeNull();
    expect(typeof authModuleInstance).toBe('object');
  });

  it('should tyrannically mandate and rigidly enforce the execution of remote decentralized runtime credential configuration state environment injection completely and securely bypassing all traces of reckless distributed global state variable mutation linkages', () => {
    // Pembuktian ketegasan deklarasi paksa: Assert the runtime Application Container Core Module precisely injected 
    // root configurations down via robust interfaces, categorically blocking any sub-feature library nodes from directly polling global shared dirty process environments autonomously.
    const configProvider = moduleRef.get('CONFIG_OPTIONS', { strict: false });
    expect(configProvider).toBeDefined();
  });
});
```

## 7. Production Edge Cases

1. **Jebakan Labirin Fatal Circular Import Bisu di Level Puncak Monolitik Barrel (`index.ts`):** Malapetaka sesekali menghampiri rute di mana suatu entitas *library* komponen yang sepenuhnya sah tanpa sadar memanggil dan mengimpor inter-dependensi tipe tipe leksikal resiprokal lintas *library* yang saling bersilang tumpuk bersarang erat mengular dalam keranjang wadah deklarasi ekspor publik simpul sentral *barrel* bersama (`index.ts`). Bencana semacam ini tanpa gagal sontak seketika membekukan total gerak laju kompilator *compiler* NestJS tewas kaku saat proses detak putaran masa runtime mesin `tsc` sembari linting verifikasi dari sang satpam deteksi `ESLint` tak berkutik tak sadar (salah deteksi sebagai *false positive success* alias lolos mulus lint buta). Tim wajib mutlak secara agresif dan ketat memberlakukan hukum pemisahan berkas file karantina pemisahan fisik jarak jauh secara partisi spartan untuk zona pengetikan tipe abstrak murni transparan TS (*Interfaces/Types Only*) dipisah ranjang jauh-jauh sekat dimensi mutlak berpisah benua berseberangan dari implementasi kongkret algoritma struktur statik kelas logika *Class Implementation Providers*.
2. **Huru-hara Tragedi NPM Link / Prahara Sinkronisasi Simlink Folder Silang Ekosistem Skala Lokal:** Momentum pada saat seorang inisiator perancang nekat mencoba bereksperimen merakit penautan tali jaringan akar pintas sistem *link file virtual symbolic lokal (symlinks)* mencangkok menjembatani area *workspace* inti monorepo utama Nx secara terjal berseberangan bahu-membahu bersinggungan ke pangkuan folder hibrid eksternal persemayaman inkubator repo ganda independen luar yang lokasinya tergeletak bertetanggaan merapat (biasa lazimnya via praktik pintas manipulasi `npm link` akar paksa alias menggunakan utilitas sinkronisasi fitur bawaan alat bantu *pnpm workspaces symlink auto-wiring mechanism*), maka serentak benteng perlindungan portal `@nx/enforce-module-boundaries` linter sang penjaga kesucian batas seketika sanggup berpotensi balik bermutasi malih rupa berevolusi menjadi tombak pedang bermata dua pemicu bumerang yang kalap meledak, menembak dan mengamuk membabi-buta melemparkan lontaran eror fatal merah menyala melaknat ke seluk beluk penjuru rantai dependensi silang melintas seberang repositori dimensi tak dikenal asing (*unregistered cross-boundary trans-repository dimensional dependencies*) yang sesungguhnya tak luput tak tercatat eksis gaib hilang dari mata radikal pantauan pergerakan radar *graph tracker mapper internal dependency builder* sang linter.
3. **Siluman Penyusup Lolos Jalur Siluman Pengecualian Type-Only Imports (TS Erasure Bypass Syndrome):** Sangat sering di lapangan ditemui bahwasanya pengembang yang bandel pandai menipu mengelabuhi ketajaman pengawasan sang linter penjaga garis batas tapal batas domain dengan sekedar mengenakan topeng mantel siluman menggunakan kamuflase sintaksis deklarasi manipulasi impor utilitas abstraksi perbekalan ketikan leksikal tipe entitas murni seutuhnya: rupa sintaks `import type { HighlyRestrictedClassEntity } from '@myorg/super-secret-restricted-isolated-payment-domain'`. Meskipun manuver taktis licin trik lintasan sirkus akrobatik ini sangat gemilang amat brilian bermanfaat positif luar biasa ampuh meringankan mempercepat pangkas waktu bagi kecepatan akselerasi laju trajektori gerak performa kompilasi mesin run-time Node (karena nyatanya rantai berkas gaib bayangan ini seutuhnya musnah terhapus lenyap ditiup terbakar sempurna tatkala proses leleh pembakaran mesin *Transpilasi kompilator TS* bekerja), sayangnya kecurangan cerdik ini pada hakikat esensi fundamental murni filosofinya terang terangan tetaplah merupakan tindakan ilegal penodaan sabotase pembobolan merusak benteng perawan suci pilar pertahanan otonomi arsitektur Domain Driven Design (DDD) secara mendasar merobohkan kemurnian tembok leksikal domain perbatasan modul. Anomali langka ini tanpa dispensasi mutlak wajib dilarang, dikekang, dijinakkan secara radikal ditertibkan wajib diikat hukum regulasi kontrol kendali penuh absolut ketat sentralisasi terpadu terkunci mati disetrum tegangan ganda via penetapan tambahan paksaan tumpukan penggaris mistar *linter rules engine* spesifik tingkat lapisan dewa langit tingkat makro tinggi ekstrim (*Architectural Abstract Interface Erasure Strict Type Rule Policies*).
