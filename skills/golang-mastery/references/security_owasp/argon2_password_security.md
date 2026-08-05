# Panduan Definitif: Password Security dengan Argon2id

> **Berlaku:** Go 1.21+ · `golang.org/x/crypto/argon2` · **Lihat juga:** `security_owasp/jwt_dual_token_auth.md` · `security_owasp/aes_gcm_cryptography.md` · `observability_resilience/rate_limiting_patterns.md` · `security_owasp/audit_logging_scrubbing.md`

## 1. Konsep dan Internals (Technical Depth)

Standar pengamanan kata sandi berevolusi dengan pesat, menanggapi melimpahnya komputasi GPU dan ASIC murah di tangan *hacker*. Menggunakan SHA256 atau MD5 saat ini disamakan dengan menyimpan password dalam plain-text. Pemenang dari komite *Password Hashing Competition (PHC)* internasional adalah algoritme **Argon2**, yang hadir dalam varian **Argon2id**.

1. **Mengapa tidak Bcrypt/Scrypt?**: bcrypt memang lambat di CPU, tetapi ruang kerjanya hanya **~4 KB** — cukup kecil untuk muat di memori bersama GPU maupun block RAM FPGA, sehingga ribuan instans bisa berjalan paralel. Argon2id menuntut puluhan megabyte per instans, dan di situlah paralelisme itu tersendat. Satu lagi yang jarang disebut dan sering menggigit: **bcrypt diam-diam memotong masukan pada 72 byte** — kata sandi 100 karakter dan 72 karakter pertamanya menghasilkan hash yang sama, tanpa peringatan apa pun. Argon2 tidak punya batas itu; angka "72" yang beredar di banyak panduan berasal dari sini, bukan dari Argon2.
2. **Memory-Hard (Tahan GPU)**: Argon2 memerlukan alokasi block memori raksasa (*memory cost*, parameter `m`)—misalnya 64MB atau 128MB. GPU modern, walau memiliki ribuan *compute cores*, dibatasi oleh *Video RAM* yang spesifik. VRAM habis = Paralelisasi gagal.
3. **Time-Cost (Tahan CPU)**: Kontrol iterasi eksekusi matematika (parameter `t`).
4. **Kenapa varian "id", bukan "i" atau "d"**: Argon2**d** mengakses memori bergantung pada isi data — kuat melawan GPU, tetapi pola aksesnya bocor lewat cache dan bisa diamati proses lain di mesin yang sama. Argon2**i** kebalikannya: aman dari sisi kanal, lebih lemah terhadap serangan trade-off waktu-memori. Argon2**id** menjalankan paruh pertama secara data-independen (seperti `i`) lalu sisanya data-dependen (seperti `d`), sehingga mendapat kedua sifat itu sekaligus. Untuk kata sandi, `id` adalah pilihan bawaan yang benar — dan `d` murni justru berbahaya di lingkungan bersama seperti kontainer multi-tenant.
5. **Format Standard (PHC String Format)**: Agar kita bisa memperbarui (upgrade) parameter algoritma di masa depan tanpa harus me-reset semua password pengguna, kita harus menyimpan seluruh komponennya dengan format modular string: `$argon2id$v=19$m=65536,t=3,p=4$saltB64$hashB64`.

## 2. Diagram ASCII: Hashing Flow Dinamis

```text
[ Plaintext Password ("supersecret") ]     [ Secure Random Salt (16-bytes) ]
                |                                          |
                +--------------------+---------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                  Argon2id Algorithm Factory Engine                      |
|  (Time: 3 passes) | (Memory: 64MB dialokasikan) | (Threads: 4 Workers)  |
|         -- CPU terikat penuh, Memory cache dipenuhi data blok --        |
+-------------------------------------------------------------------------+
                                     |
                                     v
                           [ 32-byte Raw Hash ]
                                     |
                                     +------------------+
                                                        |
       +--------------+------------+-------+--------+---+-----+-----+
PHC:   | $argon2id$v= | 19$m=65536 | ,t=3, | p=4$   | saltB64 | $   | hashB64 
       +--------------+------------+-------+--------+---+-----+-----+
                                     |
             [ String utuh ini yang di-INSERT ke Database Column ]
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Fast Hashing Algorithms (SHA-256) Tanpa Salt

**Mengapa berbahaya (Exploit Vector)**: SHA-256 adalah algoritme kriptografi yang diciptakan untuk menjadi *cepat dan murah*. Dalam kondisi *Offline Dictionary Attack* atau jika Database Anda bocor, sebuah rig multi-GPU RTX 4090 dapat menghitung **miliaran SHA-256 hashes per detik**. Menghancurkan 1 juta row pengguna dalam hitungan menit menggunakan *Rainbow Tables*.

```go
// VULNERABLE: SHA256 / Fast Hashing
func hashPasswordVulnerable(password string) string {
	// ❌ BAD: Kecepatan terlalu tinggi (Hacker menang), tiada perlindungan terhadap pre-computed table (Rainbow Tables)
	h := sha256.New()
	h.Write([]byte(password)) 
	return hex.EncodeToString(h.Sum(nil))
}
```

```go
// ✅ GOOD: Menggunakan Argon2id yang akan menduduki CPU selama ratusan milidetik dengan buffer RAM.
// (Lihat contoh implementasi production di section 5).
```

### ❌ Anti-Pattern 2: Timing Attack pada Verifikasi

**Mengapa berbahaya (Exploit Vector)**: Operasi string operator `==` di Go secara internal merupakan `bytes.Equal()`. Algoritme komparasi bahasa pemrograman konvensional akan segera berhenti mengeksekusi jika menemukan *byte* pertama yang tidak cocok. Attacker (via koneksi konstan) dapat mengukur perbedaan 0.5ms *waktu respons server* untuk membedakan tebakan karakter `a` (langsung ditolak) vs `x` (karena *byte* pertama benar, butuh waktu CPU lebih ekstra sebelum gagal di byte ke-2). Sedikit demi sedikit hash terbongkar dari luar *blackbox*.

```go
// VULNERABLE: Constant Timing Leak
func verifyHashVulnerable(inputHash, dbHash []byte) bool {
	// ❌ BAD: Waktu kembali tidak konstan (Early escape).
	return string(inputHash) == string(dbHash) 
}
```

```go
// ✅ GOOD: Constant Time Compare (Subtle Library)
func verifyHashSafe(inputHash, dbHash []byte) bool {
	// Selalu menghabiskan waktu evaluasi array O(N) ke byte terakhir tanpa henti.
	return subtle.ConstantTimeCompare(inputHash, dbHash) == 1
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Denial of Service (DoS) via "Billion Laughs" Password**: Implementasi hashing Argon2id sengaja membebani *server resources*. Jika *attacker* mengirimkan satu juta karakter (1 MB) via input payload password, fungsi *hash* akan mengkonsumsi waktu CPU luar biasa panjang (OOM server-side CPU DoS). **Selalu batasi maksimal panjang password yang diterima menjadi 72-128 karakter sebelum dilempar ke library kriptografi.** (Lihat `maxPasswordLength`).
2. **Kelelahan RAM Kolektif (Concurrent Auth Flooding)**: Jika Anda mengatur *Memory Cost* pada $64MB$ per panggilan `argon2.IDKey`, maka $100$ panggilan login HTTP serentak akan menghabiskan **6.4 Gigabyte RAM**. Aplikasi backend Go dengan pod kecil ($512MB$ RAM di K8S) akan seketika *Out of Memory Killed* (OOMKill) oleh Linux kernel `oom_reaper`. Solusinya adalah melakukan *Rate Limiting* / antrian (semaphore/worker pool terbatas di Golang untuk max $N$ *concurrent login execution*), bukan membatasi RAM.
3. **Empty String Parsing**: tolak kata sandi kosong atau yang seluruhnya spasi sejak awal, dengan `strings.TrimSpace(password) == ""`. **Tetapi jangan me-*hash* nilai yang sudah di-trim.** Memangkas spasi berarti diam-diam mengubah kredensial: `"  rahasia  "` dan `"rahasia"` menjadi akun yang sama, dan pengguna pengelola kata sandi yang menyalin nilai berspasi tidak akan pernah tahu mengapa loginnya gagal di tempat lain. Trim hanya untuk **memeriksa**, bukan untuk **menyimpan**.

4. **Parameter di dalam hash tersimpan adalah masukan yang dieksekusi.** Ini kelas kerentanan yang paling mudah terlewat di berkas semacam ini: string PHC memuat `m`, `t`, dan `p`, dan verifikasi membacanya lalu menjalankannya. Bila kolom itu pernah bisa dipengaruhi penyerang — injeksi SQL, migrasi dari sistem lain, atau baris yang rusak — maka `m=4194304` mengalokasikan 4 GiB per percobaan login, sementara `t=0` atau `p=0` membuat `argon2.IDKey` **panic** alih-alih mengembalikan galat. Validasi ketiganya terhadap rentang yang Anda tetapkan sendiri sebelum meneruskannya. Perlakukan baris basis data seperti masukan pengguna, karena dalam kasus ini ia memang berperilaku begitu.

## 5. Production-Ready Go Code

Kode di bawah ini memberikan fungsi *encoding & decoding* format PHC standard menggunakan Argon2id `golang.org/x/crypto/argon2` dan *subtle constant time comparison*.

```go
package security

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

var (
	ErrPasswordTerlaluPanjang  = errors.New("panjang kata sandi melebihi batas")
	ErrPasswordKosong          = errors.New("kata sandi tidak boleh kosong")
	ErrFormatHash              = errors.New("format hash tersimpan tidak valid")
	ErrParameterTidakMasukAkal = errors.New("parameter argon2 di luar batas wajar")
)

// Profil parameter AKTIF (dipakai saat membuat hash baru).
//
// CATATAN PENTING: OWASP merekomendasikan **p=1** untuk penyimpanan kata sandi
// sisi server — paralelisme menambah sangat sedikit daya tahan tetapi
// melipatgandakan pemakaian sumber daya per login. Versi sebelumnya memakai
// p=4 dan melabelinya "(Rekomendasi OWASP)"; label itu keliru. Angka di bawah
// tetap lebih berat dari minimum OWASP (19 MiB, t=2, p=1), dan WAJIB diukur
// ulang pada perangkat keras produksi Anda sendiri.
const (
	timeCost     uint32 = 3
	memoryCost   uint32 = 64 * 1024 // 64 MiB
	threads      uint8  = 1
	hashLength   uint32 = 32
	saltLength          = 16
	maxPassBytes        = 128 // BYTE, bukan karakter
)

// Batas yang diterima saat MEMBACA hash tersimpan.
//
// Parameter di dalam string PHC ikut dieksekusi apa adanya. Bila kolom hash
// pernah bisa dipengaruhi penyerang — injeksi SQL, migrasi dari sistem lain,
// atau sekadar baris yang rusak — maka:
//
//   - `m` besar (mis. 4 GiB) membuat SETIAP percobaan login mengalokasikan
//     sebesar itu, dan proses mati seketika;
//   - `t=0` atau `p=0` membuat `argon2.IDKey` **panic**, bukan mengembalikan
//     galat — satu baris basis data yang cacat menjatuhkan handler login.
//
// Karena itu parameter yang dibaca WAJIB divalidasi sebelum dipakai. Versi
// sebelumnya meneruskannya langsung ke IDKey.
const (
	minTimeCost   uint32 = 1
	maxTimeCost   uint32 = 10
	minMemoryCost uint32 = 8 * 1024   // 8 MiB
	maxMemoryCost uint32 = 256 * 1024 // 256 MiB
	minThreads    uint32 = 1
	maxThreads    uint32 = 16
	maxHashLength        = 64
)

// HashPassword membuat hash baru dalam format PHC.
func HashPassword(ctx context.Context, password string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", fmt.Errorf("context batal: %w", err)
	}
	if strings.TrimSpace(password) == "" {
		return "", ErrPasswordKosong
	}
	// Diukur dalam BYTE, dan itu memang unit yang benar: yang dibatasi adalah
	// jumlah data yang masuk ke fungsi hash. Konsekuensinya harus disadari —
	// kata sandi 128 karakter beraksara Jepang berukuran ~384 byte dan akan
	// ditolak. Sebutkan batas ini dalam byte di antarmuka, bukan dalam karakter.
	if len(password) > maxPassBytes {
		return "", ErrPasswordTerlaluPanjang
	}
	// Kata sandi TIDAK di-trim sebelum di-hash. Memangkas spasi berarti
	// diam-diam mengubah kredensial pengguna; TrimSpace di atas hanya dipakai
	// untuk menolak masukan yang seluruhnya spasi.

	salt := make([]byte, saltLength)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("gagal mengambil entropi salt: %w", err)
	}

	rawHash := argon2.IDKey([]byte(password), salt, timeCost, memoryCost, threads, hashLength)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memoryCost, timeCost, threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(rawHash),
	), nil
}

// HasilVerifikasi memisahkan "cocok" dari "perlu di-hash ulang".
//
// Inilah alasan format PHC dipakai (§1 butir 5) — dan justru bagian yang
// hilang dari versi sebelumnya, yang hanya mengembalikan (bool, error).
// Tanpa sinyal ini, "memperbarui parameter tanpa mereset kata sandi pengguna"
// tetap mustahil meskipun formatnya sudah benar: tidak ada yang memberi tahu
// pemanggil bahwa hash ini dibuat dengan parameter lama.
type HasilVerifikasi struct {
	Cocok       bool
	PerluRehash bool
}

type paramArgon2 struct {
	t, m uint32
	p    uint8
}

func uraikanPHC(encoded string) (paramArgon2, []byte, []byte, error) {
	gagal := func(format string, a ...any) (paramArgon2, []byte, []byte, error) {
		return paramArgon2{}, nil, nil, fmt.Errorf(format, a...)
	}

	bagian := strings.Split(encoded, "$")
	if len(bagian) != 6 || bagian[0] != "" {
		return gagal("%w: jumlah ruas", ErrFormatHash)
	}
	if bagian[1] != "argon2id" {
		return gagal("%w: algoritma %q", ErrFormatHash, bagian[1])
	}

	var versi, m, t, p uint32
	if _, err := fmt.Sscanf(bagian[2], "v=%d", &versi); err != nil {
		return gagal("%w: ruas versi", ErrFormatHash)
	}
	// Versi WAJIB diperiksa. Argon2 versi 0x10 memakai skema berbeda; kode
	// lama membaca angka ini lalu tidak pernah memakainya, sehingga hash versi
	// lama gagal verifikasi tanpa satu pun penjelasan — pengguna terkunci dan
	// tidak ada yang tahu sebabnya.
	if versi != argon2.Version {
		return gagal("%w: versi argon2 %d tidak didukung", ErrFormatHash, versi)
	}
	if _, err := fmt.Sscanf(bagian[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return gagal("%w: ruas parameter", ErrFormatHash)
	}
	if m < minMemoryCost || m > maxMemoryCost ||
		t < minTimeCost || t > maxTimeCost ||
		p < minThreads || p > maxThreads {
		return gagal("%w: m=%d t=%d p=%d", ErrParameterTidakMasukAkal, m, t, p)
	}

	salt, err := base64.RawStdEncoding.DecodeString(bagian[4])
	if err != nil {
		return gagal("%w: salt bukan base64", ErrFormatHash)
	}
	hashDB, err := base64.RawStdEncoding.DecodeString(bagian[5])
	if err != nil {
		return gagal("%w: hash bukan base64", ErrFormatHash)
	}
	if len(hashDB) == 0 || len(hashDB) > maxHashLength {
		return gagal("%w: panjang hash %d", ErrFormatHash, len(hashDB))
	}

	return paramArgon2{t: t, m: m, p: uint8(p)}, salt, hashDB, nil
}

// VerifyPassword membandingkan kata sandi terhadap hash PHC tersimpan.
func VerifyPassword(ctx context.Context, password, encodedHash string) (HasilVerifikasi, error) {
	if err := ctx.Err(); err != nil {
		return HasilVerifikasi{}, fmt.Errorf("context batal: %w", err)
	}
	// Kembali lebih awal di sini AMAN meski waktunya berbeda: yang terungkap
	// hanyalah panjang masukan yang dikirim penyerang SENDIRI, bukan sesuatu
	// tentang akun korban. Yang tidak boleh berbeda waktunya adalah jalur
	// "pengguna ada" versus "pengguna tidak ada" — lihat VerifikasiLogin.
	if len(password) > maxPassBytes {
		return HasilVerifikasi{}, nil
	}

	par, salt, hashDB, err := uraikanPHC(encodedHash)
	if err != nil {
		return HasilVerifikasi{}, err
	}

	inputHash := argon2.IDKey([]byte(password), salt, par.t, par.m, par.p, uint32(len(hashDB)))

	return HasilVerifikasi{
		Cocok: subtle.ConstantTimeCompare(hashDB, inputHash) == 1,
		PerluRehash: par.t != timeCost || par.m != memoryCost ||
			par.p != threads || uint32(len(hashDB)) != hashLength,
	}, nil
}

// hashUmpan dipakai ketika pengguna TIDAK ditemukan.
//
// Tanpa ini, jalur "pengguna tidak ada" kembali dalam mikrodetik sementara
// jalur "pengguna ada" memakan 100–500 ms. Selisih itu terukur dari luar
// dengan mudah dan menjadi alat enumerasi akun yang nyaris sempurna — dan
// tabel deteksi di berkas ini mendaftarkan gejalanya sambil SALAH menunjuk
// penyebabnya ke perbandingan konstan-waktu, yang sejak awal sudah benar.
var hashUmpan = sync.OnceValue(func() string {
	h, err := HashPassword(context.Background(), "umpan-penyeimbang-waktu")
	if err != nil {
		panic("gagal menyiapkan hash umpan: " + err.Error())
	}
	return h
})

// VerifikasiLogin adalah pintu yang benar untuk handler login.
func VerifikasiLogin(ctx context.Context, password, hashTersimpan string, penggunaAda bool) (HasilVerifikasi, error) {
	if !penggunaAda {
		// Tetap bayar ongkos hashing penuh, lalu tolak.
		_, _ = VerifyPassword(ctx, password, hashUmpan())
		return HasilVerifikasi{}, nil
	}
	return VerifyPassword(ctx, password, hashTersimpan)
}

// Pembatas menjawab Kasus Tepi 2, yang di versi sebelumnya hanya disebut
// masalahnya tanpa implementasi.
//
// Dengan m=64 MiB, seratus login serentak menuntut 6,4 GiB. Pod 512 MiB
// di-OOMKill sebelum permintaan kesepuluh selesai. Yang dibatasi BUKAN memori
// per panggilan — menurunkannya melemahkan hash — melainkan JUMLAH panggilan
// yang boleh berjalan bersamaan.
type Pembatas struct{ slot chan struct{} }

func NewPembatas(maksSerentak int) *Pembatas {
	return &Pembatas{slot: make(chan struct{}, maksSerentak)}
}

func (pb *Pembatas) Jalankan(ctx context.Context, fn func() error) error {
	select {
	case pb.slot <- struct{}{}:
		defer func() { <-pb.slot }()
		return fn()
	case <-ctx.Done():
		// Antre terlalu lama = tolak, jangan menumpuk. Menumpuk goroutine yang
		// menunggu memori justru mempercepat kematian proses; klien lebih baik
		// menerima 503 dan mencoba lagi.
		return ctx.Err()
	}
}
```

```go
package security

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestHashDanVerifikasi(t *testing.T) {
	ctx := context.Background()
	sandi := "Secure$Passw0rd_32!"

	hash, err := HashPassword(ctx, sandi)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=") {
		t.Fatalf("awalan PHC tidak wajar: %s", hash)
	}

	hasil, err := VerifyPassword(ctx, sandi, hash)
	if err != nil || !hasil.Cocok {
		t.Fatalf("kata sandi benar ditolak: cocok=%v galat=%v", hasil.Cocok, err)
	}
	if hasil.PerluRehash {
		t.Error("hash baru dibuat tetapi ditandai perlu rehash")
	}

	hasil, err = VerifyPassword(ctx, "Secure$Passw0rd_32?", hash)
	if err != nil || hasil.Cocok {
		t.Errorf("kata sandi salah diterima: cocok=%v galat=%v", hasil.Cocok, err)
	}
}

// Parameter dari hash tersimpan ikut DIEKSEKUSI. Ketiga kasus di bawah
// membuat versi sebelumnya panic atau mengalokasikan memori tanpa batas.
func TestParameterTersimpanDivalidasi(t *testing.T) {
	ctx := context.Background()
	sah, err := HashPassword(ctx, "apa-saja")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	bagian := strings.Split(sah, "$")

	rakit := func(param string) string {
		return strings.Join([]string{"", bagian[1], bagian[2], param, bagian[4], bagian[5]}, "$")
	}

	kasus := map[string]string{
		"t=0 membuat argon2.IDKey panic":   "m=65536,t=0,p=1",
		"p=0 membuat argon2.IDKey panic":   "m=65536,t=3,p=0",
		"m raksasa menghabiskan memori":    "m=4194304,t=3,p=1",
		"t raksasa menghabiskan CPU":       "m=65536,t=1000000,p=1",
	}
	for nama, param := range kasus {
		t.Run(nama, func(t *testing.T) {
			_, err := VerifyPassword(ctx, "apa-saja", rakit(param))
			if !errors.Is(err, ErrParameterTidakMasukAkal) {
				t.Fatalf("galat = %v, mau ErrParameterTidakMasukAkal", err)
			}
		})
	}
}

func TestVersiTidakDidukungDitolak(t *testing.T) {
	ctx := context.Background()
	sah, _ := HashPassword(ctx, "apa-saja")
	bagian := strings.Split(sah, "$")
	lama := strings.Join([]string{"", bagian[1], "v=16", bagian[3], bagian[4], bagian[5]}, "$")

	if _, err := VerifyPassword(ctx, "apa-saja", lama); !errors.Is(err, ErrFormatHash) {
		t.Fatalf("galat = %v, mau ErrFormatHash", err)
	}
}

// Membuktikan jalur upgrade parameter yang menjadi alasan format PHC ada.
func TestPerluRehashSaatParameterLama(t *testing.T) {
	ctx := context.Background()
	sah, _ := HashPassword(ctx, "apa-saja")
	bagian := strings.Split(sah, "$")
	// Hash "lama" dengan memori lebih kecil — masih di dalam batas wajar.
	lama := strings.Join([]string{"", bagian[1], bagian[2], "m=16384,t=2,p=1", bagian[4], bagian[5]}, "$")

	hasil, err := VerifyPassword(ctx, "apa-saja", lama)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !hasil.PerluRehash {
		t.Fatal("hash dengan parameter lama tidak ditandai perlu rehash")
	}
}

// Jalur "pengguna tidak ada" WAJIB memakan waktu yang sebanding dengan jalur
// "pengguna ada". Tanpa hash umpan, selisihnya adalah enumerasi akun.
func TestPenggunaTidakAdaTetapMembayarOngkosHash(t *testing.T) {
	ctx := context.Background()
	hashUmpan() // panaskan agar biaya pembuatan pertama tidak ikut terukur

	mulai := time.Now()
	hasil, err := VerifikasiLogin(ctx, "tebakan", "", false)
	lama := time.Since(mulai)

	if err != nil || hasil.Cocok {
		t.Fatalf("pengguna tak ada: cocok=%v galat=%v", hasil.Cocok, err)
	}
	// Argon2id 64 MiB/t=3 jauh melampaui ini; ambang sengaja longgar agar uji
	// tidak rapuh di mesin lambat maupun cepat.
	if lama < 5*time.Millisecond {
		t.Fatalf("jalur pengguna-tidak-ada selesai dalam %s — tidak ada hash umpan, enumerasi akun terbuka", lama)
	}
}

func TestBatasMasukan(t *testing.T) {
	ctx := context.Background()

	if _, err := HashPassword(ctx, strings.Repeat("a", maxPassBytes+1)); !errors.Is(err, ErrPasswordTerlaluPanjang) {
		t.Errorf("galat = %v, mau ErrPasswordTerlaluPanjang", err)
	}
	if _, err := HashPassword(ctx, "   "); !errors.Is(err, ErrPasswordKosong) {
		t.Errorf("galat = %v, mau ErrPasswordKosong", err)
	}
	if _, err := VerifyPassword(ctx, "x", "$argon2id$v=19$m=65536,t=3,p=1$salt-tidak-valid$hash"); !errors.Is(err, ErrFormatHash) {
		t.Errorf("galat = %v, mau ErrFormatHash", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Parameter yang disalin dari tutorial tanpa diukur di mesin produksi.** Parameter terlalu ringan tidak melindungi apa pun; terlalu berat mengubah endpoint login menjadi vektor DoS terhadap diri sendiri. Ukur, targetkan sekitar 100–500 ms per verifikasi di perangkat keras produksi.
- **Argon2id di endpoint yang tidak dibatasi laju.** Setiap percobaan memakan memori dan CPU yang signifikan — itulah gunanya, dan itu pula yang bisa dipakai penyerang untuk menjatuhkan Anda dengan seratus permintaan.
- **Menyimpan parameter terpisah dari hash.** Format hash Argon2 sudah memuat parameternya. Menyimpannya terpisah membuat rotasi parameter mustahil dilakukan bertahap.
- **MD5, SHA-1, atau SHA-256 polos untuk kata sandi.** Cepat adalah **kelemahan** di sini. GPU modern membuat "cepat" berarti miliaran percobaan per detik terhadap dump yang bocor.
- **Membandingkan hash dengan `==`.** Perbandingan yang tidak konstan waktu membocorkan informasi lewat waktu respons. `subtle.ConstantTimeCompare` yang benar.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Endpoint login lambat lalu seluruh layanan lambat | memori dan CPU saat login | Parameter Argon2 berat tanpa rate limiting |
| Waktu respons login berbeda untuk pengguna ada/tidak ada | **apakah jalur "tidak ada" ikut menjalankan hash umpan** | Enumerasi pengguna lewat timing. Penyebabnya bukan perbandingan konstan-waktu (yang sudah benar), melainkan jalur pengguna-tidak-ada yang pulang tanpa membayar ongkos hashing |
| Handler login panic pada akun tertentu | `t` dan `p` pada baris hash itu | `argon2.IDKey` panic untuk `t=0`/`p=0`; parameter tersimpan tidak divalidasi |
| Pod mati saat satu akun mencoba login | nilai `m` pada baris hash itu | Parameter memori dari hash tersimpan dieksekusi apa adanya |
| Parameter tidak pernah bisa dinaikkan | apakah verifikasi melaporkan perlu-rehash | Format PHC dipakai tetapi sinyal upgrade-nya tidak ada |
| Verifikasi kata sandi < 10 ms | parameter yang dipakai | Terlalu ringan untuk melindungi |
| Hash lama tidak bisa diverifikasi | apakah parameter ada di hash | Parameter disimpan terpisah dan berubah |
| Ribuan login gagal dari satu sumber | sebaran IP/akun | Serangan credential stuffing sedang berlangsung |

```bash
# Algoritma cepat yang tidak boleh dipakai untuk kata sandi
grep -rniE 'md5\.|sha1\.|sha256\.Sum' --include='*.go' . | grep -iE 'pass|sandi|kredensial'
gosec -include=G401,G505 ./...

# Waktu verifikasi: konsisten dan berada di rentang 50-500 ms
for i in 1 2 3; do
  curl -sw '%{time_total}\n' -o /dev/null -X POST localhost:8080/login \
    -d '{"email":"ada@contoh.id","sandi":"salah"}'
done

# Credential stuffing terlihat sebagai banyak akun dari sedikit sumber
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.event=="login_gagal") | .ip' | sort | uniq -c | sort -rn | head
```
