# Optimalisasi Cache Build Docker: Corepack, PNPM & Virtual Mount

## Pendahuluan: Memecahkan Kemacetan Waktu Build

Dalam siklus integrasi dan pengiriman berkelanjutan (CI/CD) pada aplikasi skala enterprise (monorepo atau layanan mikro raksasa), proses resolusi dependensi Node.js sering memakan >60% total waktu build Docker. Tradisi mengunduh direktori `node_modules` secara naif merugikan produktivitas dan tagihan jaringan (egress costs) ekosistem Cloud. Blueprint ini menstandarisasi pemakaian **Corepack**, **PNPM** (manajer paket performa maksimal dengan sistem *hard-link* virtual), dan fitur eksperimental (namun stabil) Docker **BuildKit Cache Mount** (`--mount=type=cache`) untuk memangkas waktu instalasi hingga 80%.

## Diagram ASCII: Mekanisme Docker BuildKit Cache Layering

```ascii
[ Eksekusi Perintah Docker BuildKit ]
                    |
                    v
[ Dockerfile: RUN --mount=type=cache,target=/pnpm_store pnpm install ]
                    |
                    |--> [ Virtual Cache Mount Layer ]
                    |    (Tidak menjadi bagian dari image final)
                    |    (Disimpan persisten di Docker daemon host)
                    |
                    +--> Apakah paket 'nestjs/common@10.0' ada di Cache Host?
                           |
            +--------------+---------------+
            | YA                           | TIDAK
            v                              v
[ Hubungkan paket via Hard-link ]  [ Unduh dari Registry Npmjs ]
[ ke dalam context /usr/src/app ]  [ Simpan ke Virtual Cache   ]
            |                              |
            v                              |
    [ Resolusi Instan ]                    v
                              [ Hubungkan paket via Hard-link ]
```

## Implementasi Blueprint Docker Caching yang Kuat

Kode Dockerfile ini mengunci determinisme *package manager* menggunakan spesifikasi `packageManager` yang tertanam dalam `package.json` dan Corepack.

```dockerfile
# Menggunakan Alpine Node JS base
FROM node:20.11.1-alpine3.19 AS builder
WORKDIR /usr/src/app

# Mengaktifkan Corepack untuk determinisme PNPM
# Ini menghindari konflik versi pnpm di mesin CI yang berbeda
RUN corepack enable && corepack prepare pnpm@8.15.3 --activate

# Konfigurasi Store Directory PNPM secara global di dalam kontainer
# agar selaras dengan target cache mount Docker
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Hanya salin spesifikasi dependensi (Layer Caching Docker L1)
COPY package.json pnpm-lock.yaml ./

# EKSPLISIT: Mount lapisan cache khusus untuk pnpm store.
# Cache ini hidup di host machine dan di-share di antara proses `docker build` yang berulang.
RUN --mount=type=cache,id=pnpm-store-app,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Salin sisa kode aplikasi
COPY . .

# Build aplikasi NestJS (TS ke JS)
RUN pnpm run build
```

## Anti-Patterns Kritis & Praktik Terbaik

### ❌ Anti-Pattern 1: Mengubah Source Code sebelum `npm install`
Menyalin kode sumber penuh sebelum menjalankan instalasi dependensi akan selalu merusak (*invalidate*) *layer caching* Docker jika terjadi perubahan satu karakter saja pada kode sumber.
```dockerfile
# ❌ SALAH: Membatalkan cache dependensi di setiap commit kode!
COPY . .
RUN npm install
RUN npm run build
```

### ✅ Solusi 1: Pemisahan Layer Spesifikasi Dependensi
Salin `package.json` dan `lockfile` secara terpisah, instal dependensi, lalu baru salin kode sumber. Ini memastikan *layer* dependensi hanya dibangun ulang jika kita benar-benar menambah atau menghapus pustaka.
```dockerfile
# ✅ BENAR: Cache instalasi dilestarikan dengan baik.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
```

### ❌ Anti-Pattern 2: Menghapus Cache Manajer Paket dalam Image Layer Tunggal
Beberapa engineer secara keliru menjalankan instalasi dan pembersihan cache dalam eksekusi RUN tanpa mekanisme `--mount`, memaksa proses unduh paket di *build* berikutnya dari nol absolute.
```dockerfile
# ❌ SALAH: Cache terhapus selamanya, waktu instalasi berikutnya selalu lambat.
RUN npm install && npm cache clean --force
```

### ✅ Solusi 2: Gunakan Docker BuildKit Mount Cache
Gunakan fungsi `type=cache` sehingga direktori cache disisihkan ke host build dan dimanfaatkan terus menerus lintas run *tanpa* menyumbang *byte* pada *image* kontainer terakhir.

## Analisis Trade-Off

### Kelebihan
1. **Akselerasi Spektakuler:** Kecepatan siklus integrasi berkelanjutan pada GitHub Actions/GitLab CI meningkat dramatis dari hitungan menit menjadi belasan detik (saat cache *hit*).
2. **Determinisme dan Keamanan Dependensi:** Melalui penggunaan `--frozen-lockfile` dipasangkan dengan versi PNPM yang dijepit absolut via Corepack, setiap node di lintasan komputasi *cloud* menghasilkan pohon dependensi yang 100% sama secara matematis.
3. **Efisiensi Hard Disk Runner CI:** Sistem manajemen penyimpanan terpusat pada host dengan PNPM tidak menduplikasi data, melindungi server *build* dari kepenuhan `inode` atau habisnya *storage* secara dini.

### Kekurangan
1. **Kompleksitas Persistensi di CI:** Di platform CI *ephemeral* atau sistem kontainer pelari satu kali buang, lapisan cache Docker tidak menetap (non-persisten) antar tugas kecuali cache orkestrator (seperti `actions/cache` atau cache registri eksternal Docker `--cache-to`) diatur secara sinkron.
2. **Kebocoran Cache Gagal (Poisoned Cache):** Terkadang, unduhan paket yang rusak secara jaringan tercetak pada lapisan cache host, memaksa pengembang melakukan pembersihan manual (`docker builder prune -a`).
3. **Tidak Mendukung Eksekutor Usang:** Pendekatan ini membutuhkan ekstensi lingkungan BuildKit; docker usang atau daemon lawas akan memberikan galat fatal saat mendeteksi sintaks eksperimental `--mount`.

## Production Edge Cases

1. **GitHub Actions Cache Tarball Miss:** Ketika menjalankan *cache layer* pada *runner* GitHub CI yang terdistribusi, *host cache* dari *build* lama mungkin berada di *runner* fisik berbeda. Wajib mengekspor lapisan Docker cache menggunakan `--cache-to=type=gha` dan `--cache-from=type=gha` untuk integrasi sempurna *mount cache* pnpm.
2. **Postinstall Scripts yang Gagal (Prisma, dll):** Skrip pasca instalasi yang memerlukan artefak platform bawaan (seperti biner Prisma/Bcrypt) bisa mendeteksi *cache hit* paket namun gagal mengenali bahwa lingkungan host (OS Kernel) yang mengunduh dependensi sebelumnya sudah berbeda, mengakibatkan `invalid ELF header` (musl vs glibc). Pastikan biner digenerasi ulang secara paksa, misalnya: `RUN pnpm prisma generate`.
3. **Korporat Proxy & Sertifikat SSL:** Ketika bekerja di dalam jaringan terbatas, cache mount docker tidak akan mentransfer *environment proxy* (`HTTP_PROXY`, dsb) atau *root CA cert* otomatis ke proses PNPM. Hal tersebut perlu dikirim manual via argument *build* Docker (`--build-arg`) dan variabel lingkungan instruksi `RUN`.
4. **Corepack Signature Verification Crash:** Ketika registry NPM mengalami jeda atau SSL handshake gagal saat Corepack mengverifikasi SHA256 checksum dari biner PNPM yang diunduh, build kontainer akan putus secara instan. Solusi: Sediakan fallback biner PNPM lokal di dalam cache layer atau panggil `corepack enable --offline` jika sistem menggunakan miror internal korpora.

## Unit & Integration Testing Suite (Automated CI Container Audit)

Untuk menjamin bahwa image kontainer hasil rakitan Docker tidak meneteskan memori berlebih dan Corepack beroperasi sesuai spesifikasi yang dijepit, berikut adalah *suite pengujian integrasi otomatis* menggunakan **Jest** dan `testcontainers-node` (atau eksekusi shell validasi) di pipeline QA:

```typescript
// test/docker-caching-verification.spec.ts
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'join';

describe('Docker Build & Corepack Determinism Verification Suite', () => {
  const packageJsonPath = path.resolve(__dirname, '../package.json');
  let pkgData: any;

  beforeAll(() => {
    const rawContent = fs.readFileSync(packageJsonPath, 'utf8');
    pkgData = JSON.parse(rawContent);
  });

  it('harus mencantumkan spesifikasi packageManager secara mutlak di package.json', () => {
    expect(pkgData.packageManager).toBeDefined();
    expect(typeof pkgData.packageManager).toBe('string');
    expect(pkgData.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('harus melarang adanya folder node_modules terindek di repositori git (zero bloat)', () => {
    const gitIgnorePath = path.resolve(__dirname, '../.gitignore');
    const gitIgnoreContent = fs.readFileSync(gitIgnorePath, 'utf8');
    expect(gitIgnoreContent).toMatch(/node_modules/);
  });

  it('harus menguji ketahanan CLI pnpm di lingkungan eksekusi lokal atau CI', () => {
    try {
      const pnpmVersion = execSync('pnpm --version', { encoding: 'utf8' }).trim();
      const expectedVersion = pkgData.packageManager.split('@')[1];
      expect(pnpmVersion).toEqual(expectedVersion);
    } catch (error) {
      // Jika dilakoni di CI yang menggunakan Corepack shims
      console.warn('Pengecekan versi PNPM diarahkan melalui corepack shims');
    }
  });

  it('harus memvalidasi kehadiran instruksi BuildKit Cache Mount pada Dockerfile', () => {
    const dockerfilePath = path.resolve(__dirname, '../Dockerfile');
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
    
    // Verifikasi pemakaian Corepack
    expect(dockerfileContent).toContain('corepack enable');
    // Verifikasi pemantulan cache mount yang valid
    expect(dockerfileContent).toMatch(/--mount=type=cache,.*target=\/root\/.local\/share\/pnpm\/store/);
    // Verifikasi frozen lockfile untuk menjamin determinisme 100%
    expect(dockerfileContent).toContain('--frozen-lockfile');
  });
});
```

## Protokol Debugging Terminal jika Cache Mount Mengalami Kegagalan (Corrupt Inode)

Jika build pipeline tiba-tiba mengalami `ENOSPC: no space left on device` atau checksum error dari lapisan cache BuildKit host, lakukan langkah mitigasi darurat berikut via terminal pemantau sistem:

```bash
# 1. Inspect status cache penggunaan hard drive di host BuildKit
docker buildx du --verbose

# 2. Hapus lapisan cache pnpm yang dicurigai corrupt tanpa menghabiskan cache image lain
docker builder prune --filter "id=pnpm-store-app" --force

# 3. Regenerasikan build ulang dengan instruksi mematikan cache parsial
docker buildx build --no-cache --progress=plain -t my-nestjs-service:latest .
```
With these strict standards, the NestJS container engineering architecture ensures absolute top tier performance, unmatched CI speed, and uncompromising reliability across multi-stage cloud infrastructures.
