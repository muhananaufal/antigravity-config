# Unit Testing & Testify di Go

> **Berlaku:** Go 1.22+ (variabel loop per-iterasi) · testify v1.9+ · **Lihat juga:** `testing_quality/mocking_interfaces.md` · `testing_quality/e2e_testing_patterns.md` · `testing_quality/property_based_testing.md` · `testing_quality/synctest_deterministic_concurrency.md`

Package `testing` bawaan Go adalah framework test yang powerful. `testify` menambahkan assertion ekspresif, mocking, dan suite support. Memahami perbedaan `assert` vs `require`, table-driven test, `TestMain`, dan goroutine leak detection adalah fondasi unit testing level production.

---

## 1. Arsitektur Internal Test Runner

```
go test -v -race -count=3 -timeout=30s ./...
         │
         ▼
  testing.M (TestMain entry point — opsional, untuk global setup/teardown)
  ├── TestA(t *testing.T)
  │   ├── t.Run("SubtestA1", ...)  ← Parallel-safe dengan tt := tt capture
  │   └── t.Run("SubtestA2", ...)
  └── TestB(t *testing.T)
       └── t.Cleanup(func() {...}) ← LIFO cleanup, dipanggil saat test selesai

Flags penting:
  -short    → t.Short() = true (skip slow/integration tests)
  -run=Pola → filter test berdasarkan regex
  -race     → aktifkan ThreadSanitizer (wajib di CI)
  -count=N  → jalankan N kali (deteksi flakiness)
```

**`assert` vs `require` — perbedaan kritis:**
- `assert.*` → memanggil `t.Errorf()` → test *berlanjut* setelah failure (soft fail). Gunakan untuk validasi multiple field sekaligus.
- `require.*` → memanggil `t.Fatalf()` → test *berhenti* sekarang juga (hard fail). **Wajib** digunakan setelah operasi yang bisa return `nil` + error, agar tidak panic pada baris berikutnya.

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/goleak"
)

// --- Domain Logic ---

// UserData merepresentasikan user yang diparse dari file config.
type UserData struct {
	ID       int
	Username string
	Active   bool
}

// ConfigParser membaca config dari filesystem abstrak (mudah di-mock via fstest.MapFS).
type ConfigParser struct {
	fileSystem fs.FS
}

// NewConfigParser membuat parser baru dengan filesystem yang bisa diinjeksi.
func NewConfigParser(fsys fs.FS) *ConfigParser {
	return &ConfigParser{fileSystem: fsys}
}

// Parse membaca dan memparsing file konfigurasi.
func (p *ConfigParser) Parse(ctx context.Context, filename string) (*UserData, error) {
	// Context check: respect cancellation
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	data, err := fs.ReadFile(p.fileSystem, filename)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("config file %q not found: %w", filename, fs.ErrNotExist)
		}
		return nil, fmt.Errorf("reading config file %q: %w", filename, err)
	}

	if string(data) == "admin:1:true" {
		return &UserData{ID: 1, Username: "admin", Active: true}, nil
	}
	return nil, errors.New("invalid config format")
}

// --- TestMain: Global Setup & Teardown ---

// TestMain dieksekusi sebelum dan sesudah semua test di package ini.
//
// Pemeriksaan kebocoran goroutine ditaruh DI SINI, bukan sebagai
// `defer goleak.VerifyNone(t)` di dalam masing-masing test — alasannya di
// bawah, dan itu perbedaan yang menentukan apakah pemeriksaannya berarti.
//
// Catatan `os.Exit`: sejak **Go 1.15** ia tidak lagi wajib — bila TestMain
// kembali begitu saja, binary uji keluar dengan kode dari `m.Run()`. Yang
// tetap penting adalah jebakannya: `os.Exit` **melewati seluruh `defer`**,
// sehingga `defer db.Close()` di dalam TestMain tidak akan pernah berjalan.
// Panggil teardown secara eksplisit sebelum keluar, atau jangan pakai
// os.Exit sama sekali.
func TestMain(m *testing.M) {
	// Setup global: misal seed test database
	// db := setupTestDB()

	kode := m.Run()

	// Teardown global — WAJIB dipanggil eksplisit di sini, bukan lewat defer.
	// db.Close()

	os.Exit(kode)
}

// --- Table-Driven Tests dengan Closure Variable Capture yang Benar ---

func TestConfigParser_Parse(t *testing.T) {
	// t.Cleanup, BUKAN defer.
	//
	// Ini perbedaan yang menentukan apakah pemeriksaannya berarti sama sekali.
	// Subtest yang memanggil t.Parallel() langsung BERHENTI dan kembali ke
	// induk; badan fungsi induk lalu selesai, dan `defer` induk berjalan saat
	// itu juga — SEBELUM satu pun subtest paralel benar-benar dijalankan.
	// goleak yang dipasang lewat defer memeriksa keadaan pada titik yang salah:
	// ia tidak melihat goroutine yang belum lahir, dan justru bisa melaporkan
	// subtest yang sedang tertahan sebagai kebocoran.
	//
	// t.Cleanup induk berjalan SESUDAH seluruh subtest paralel selesai.
	t.Cleanup(func() { goleak.VerifyNone(t) })

	mockFS := fstest.MapFS{
		"valid.cfg":   {Data: []byte("admin:1:true")},
		"invalid.cfg": {Data: []byte("broken_data::::")},
	}
	parser := NewConfigParser(mockFS)

	tests := []struct {
		name      string
		filename  string
		wantErr   bool
		wantUser  *UserData
		wantErrIs error // target error untuk errors.Is
	}{
		{
			name:     "valid config",
			filename: "valid.cfg",
			wantUser: &UserData{ID: 1, Username: "admin", Active: true},
		},
		{
			name:    "invalid format",
			filename: "invalid.cfg",
			wantErr: true,
		},
		{
			name:      "file not found",
			filename:  "missing.cfg",
			wantErr:   true,
			wantErrIs: fs.ErrNotExist,
		},
	}

	for _, tt := range tests {
		// Tanpa `tt := tt`: sejak Go 1.22 variabel loop punya salinan per
		// iterasi, dan berkas ini menyatakan Go 1.22+ di header. Menyalin
		// ulang bukan salah, tetapi menyisakan baris yang menyiratkan
		// keharusan yang sudah tidak ada. Lihat Anti-Pattern 2.
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel() // test-test ini aman dijalankan paralel

			ctx := context.Background()
			got, err := parser.Parse(ctx, tt.filename)

			if tt.wantErr {
				require.Error(t, err) // hard stop jika tidak ada error
				assert.Nil(t, got)
				if tt.wantErrIs != nil {
					assert.ErrorIs(t, err, tt.wantErrIs, "expected wrapped error type")
				}
				return
			}

			require.NoError(t, err)
			require.NotNil(t, got) // hard stop sebelum akses field (cegah panic)
			assert.Equal(t, tt.wantUser.ID, got.ID)
			assert.Equal(t, tt.wantUser.Username, got.Username)
			assert.Equal(t, tt.wantUser.Active, got.Active)
		})
	}
}

// TestConfigParser_Parse_ContextCancelled memverifikasi respect context cancellation.
func TestConfigParser_Parse_ContextCancelled(t *testing.T) {
	parser := NewConfigParser(fstest.MapFS{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancel

	_, err := parser.Parse(ctx, "any.cfg")
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}

// TestConfigParser_BerkasBesar di-skip saat -short aktif.
func TestConfigParser_BerkasBesar(t *testing.T) {
	if testing.Short() {
		t.Skip("melewati uji lambat pada mode -short")
	}

	// Uji yang benar-benar berjalan, bukan badan kosong: 10.000 berkas
	// membuat biayanya nyata sehingga skip-nya punya alasan.
	fsys := fstest.MapFS{}
	for i := 0; i < 10_000; i++ {
		fsys[fmt.Sprintf("cfg-%05d.cfg", i)] = &fstest.MapFile{Data: []byte("admin:1:true")}
	}
	parser := NewConfigParser(fsys)

	for nama := range fsys {
		got, err := parser.Parse(context.Background(), nama)
		require.NoError(t, err)
		require.NotNil(t, got)
	}
}

// TestConfigParser_TempDir contoh pemakaian t.TempDir() untuk isolasi filesystem.
func TestConfigParser_TempDir(t *testing.T) {
	dir := t.TempDir() // otomatis dihapus setelah test, bahkan jika panic

	cfgPath := filepath.Join(dir, "config.cfg")
	err := os.WriteFile(cfgPath, []byte("admin:1:true"), 0o600)
	require.NoError(t, err)

	// Gunakan os.DirFS untuk wrap directory ke fs.FS
	parser := NewConfigParser(os.DirFS(dir))
	ctx := context.Background()

	got, err := parser.Parse(ctx, "config.cfg")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "admin", got.Username)
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan `assert` untuk Error Check Sebelum Akses Field

```go
// BAD: assert.NoError tidak menghentikan test — baris berikutnya panic!
user, err := parser.Parse(ctx, "file.cfg")
assert.NoError(t, err)     // test terus jalan meski err != nil
assert.Equal(t, "admin", user.Username) // PANIC: nil pointer dereference!

// GOOD: require.NoError menghentikan test sekarang jika ada error
user, err := parser.Parse(ctx, "file.cfg")
require.NoError(t, err)       // stop di sini jika error
require.NotNil(t, user)       // stop di sini jika nil
assert.Equal(t, "admin", user.Username) // aman diakses
```

**Kenapa berbahaya:** Panic dari nil dereference menghasilkan stack trace yang membingungkan dan menyembunyikan error asli. Selalu `require` saat mengecek pre-condition sebelum mengakses nilai kembalian.

### ❌ Anti-Pattern 2: Closure Variable Capture dalam Loop Parallel (Pre-Go 1.22)

```go
// BAD: semua subtest menggunakan nilai tt yang sama (nilai terakhir loop)
for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        // tt di sini bisa sudah berubah ke nilai iterasi berikutnya!
        doSomething(tt.input) // data race + wrong value
    })
}

// GOOD: capture variabel di awal closure (wajib untuk Go < 1.22)
for _, tt := range tests {
    tt := tt // shadow variabel — setiap goroutine punya copy sendiri
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        doSomething(tt.input) // aman
    })
}
// Go 1.22+: loop variable semantics berubah — capture otomatis, tt := tt tidak diperlukan
```

**Kenapa berbahaya:** Semua goroutine subtest berbagi pointer ke variabel loop yang sama. Hasilnya: semua test berjalan dengan input terakhir, atau terjadi data race yang terdeteksi oleh `-race`.

### ❌ Anti-Pattern 3: Tidak Menggunakan `t.Cleanup` — Leak Resource Test

```go
// BAD: berjalan TERLALU CEPAT bila ada subtest paralel
func TestWithDB(t *testing.T) {
    db := openTestDB()
    defer db.Close() // berjalan saat badan fungsi ini selesai --
                     // yaitu SEBELUM subtest paralel dijalankan
    for _, tt := range kasus {
        t.Run(tt.nama, func(t *testing.T) { t.Parallel(); pakai(db) })
    }
}
```
```go
// GOOD: t.Cleanup berjalan SESUDAH test dan seluruh subtest-nya selesai
func TestWithDB(t *testing.T) {
    db := openTestDB()
    t.Cleanup(func() { db.Close() }) // LIFO: terdaftar terakhir, dijalankan pertama
}
```

**Alasan yang benar — dan yang sering dinyatakan keliru.** `defer` **tetap berjalan** saat `t.Fatal()` dipanggil: `t.FailNow` memakai `runtime.Goexit`, dan Goexit menjalankan seluruh deferred call sebelum menghentikan goroutine. Jadi "defer tidak berjalan saat Fatal" adalah mitos; kalau itu benar, seluruh kode Go yang mengandalkan `defer f.Close()` sudah lama bermasalah.

Yang **sungguh** membedakan adalah **urutan terhadap subtest paralel**:

```
badan fungsi induk selesai
  -> defer induk berjalan            <- DI SINI
  -> testing menunggu subtest paralel
  -> t.Cleanup induk berjalan        <- DI SINI
```

Sumber daya yang dipakai bersama subtest paralel karena itu WAJIB ditutup lewat `t.Cleanup`; ditutup lewat `defer`, ia lenyap tepat sebelum subtest-subtest itu mulai memakainya.

---

## 4. Edge Cases & Defensive Programming

1. **`t.Parallel()` + `t.TempDir()` — alasannya isolasi, bukan penghapusan dini.** Setiap subtest paralel sebaiknya punya `t.TempDir()` sendiri. Tetapi alasan yang sering disebut — "TempDir induk dihapus saat induk selesai padahal subtest paralel belum" — **tidak benar**: `t.TempDir` mendaftarkan penghapusannya sebagai `t.Cleanup` induk, dan cleanup induk berjalan **sesudah** seluruh subtest paralel selesai. Direktorinya aman. Yang menjadi masalah adalah subtest-subtest itu **berbagi satu direktori** dan saling menimpa berkas satu sama lain — kegagalan yang muncul acak dan bergantung urutan penjadwalan.

2. **`goleak` WAJIB lewat `t.Cleanup` atau `TestMain`, bukan `defer`.** `defer goleak.VerifyNone(t)` adalah pola yang paling banyak beredar, dan ia **tidak memeriksa apa pun** pada test yang punya subtest paralel: subtest yang memanggil `t.Parallel()` langsung berhenti dan kembali ke induk, badan fungsi induk selesai, dan `defer` berjalan sebelum satu pun subtest dijalankan. Yang benar `t.Cleanup(func() { goleak.VerifyNone(t) })` — atau `goleak.VerifyTestMain(m)` di `TestMain` untuk mencakup seluruh paket sekaligus.

3. **`-count=N` untuk Deteksi Flakiness:** Test yang lulus satu kali belum tentu reliable. Jalankan `go test -count=10 -race` untuk mengekspos race condition dan timing-dependent behavior. Test yang flaky pada `count>1` biasanya menyembunyikan shared state atau improper goroutine management.

4. **`t.Log` vs `t.Error` Visibility:** `t.Log()` hanya muncul saat test gagal atau `-v` flag aktif. Jangan gunakan `fmt.Println` dalam test — output tidak terikat dengan `t` dan tidak akan muncul dalam laporan test terstruktur.

5. **`TestMain` — dua hal yang sering tertukar.** Yang wajib adalah memanggil **`m.Run()`**: TestMain yang tidak memanggilnya membuat seluruh test di paket itu tidak pernah berjalan, dan `go test` melaporkan PASS tanpa menjalankan apa pun — kegagalan paling menyesatkan yang bisa dihasilkan sebuah suite.

   `os.Exit` adalah hal yang berbeda, dan sejak **Go 1.15 ia tidak lagi wajib**: bila TestMain kembali begitu saja, binary uji keluar dengan kode dari `m.Run()`. Yang tetap perlu diingat adalah jebakannya — **`os.Exit` melewati seluruh `defer`**, sehingga `defer db.Close()` di dalam TestMain tidak akan pernah berjalan. Panggil teardown secara eksplisit sebelum keluar, atau jangan memakai `os.Exit` sama sekali.

## Kapan JANGAN Pakai Ini

- **Testify sebagai refleks.** Pustaka standar `testing` sudah cukup untuk sebagian besar assertion; `if got != want { t.Errorf(...) }` tidak butuh dependensi apa pun dan pesan gagalnya bisa Anda kendalikan penuh. Testify berguna untuk assertion kompleks dan `suite`, bukan sebagai kebiasaan.
- **`assert` ketika kegagalannya membuat baris berikutnya tidak masuk akal.** `assert.NoError` lalu langsung mengakses field hasil menghasilkan nil panic yang **menutupi** pesan galat aslinya. Untuk prasyarat, `require` yang benar.
- **Menguji fungsi tidak terekspor demi menaikkan cakupan.** Cakupan yang dikejar lewat jalan itu tidak membuktikan apa pun tentang perilaku yang dilihat pemanggil, dan mengunci detail implementasi sehingga refactor jadi mahal.
- **Menargetkan cakupan 100%.** Angka itu mendorong orang menulis uji untuk getter dan konstruktor sambil membiarkan jalur galat — yang justru paling berisiko — tanpa uji sama sekali.
- **Mock untuk hal yang murah dijalankan sungguhan.** Fungsi murni, formatter, dan validator lebih jujur diuji langsung; mock di situ hanya menguji bahwa Anda menulis ekspektasi yang sama dua kali.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Uji lulus sendirian, gagal saat sepaket | hasil `-shuffle=on` | State global bocor antar uji |
| Hanya gagal di CI, hijau di laptop | `-race -count=10` | Paralelisme atau timing berbeda |
| Cakupan tinggi tapi bug tetap lolos | apa yang sebenarnya diuji | Getter dan konstruktor teruji, jalur galat tidak |
| Suite makin lama tiap sprint | uji terlambat | `time.Sleep` dipakai sebagai sinkronisasi |
| Uji menggantung sampai timeout CI | panic dari `-timeout` | Deadlock atau channel tanpa penerima |
| `goleak` tidak pernah menemukan apa pun | `defer` vs `t.Cleanup` | Diperiksa sebelum subtest paralel berjalan |
| Subtest paralel saling menimpa berkas | `t.TempDir()` di induk atau di subtest | Satu direktori dipakai bersama |
| Paket melaporkan PASS tanpa uji berjalan | apakah `TestMain` memanggil `m.Run()` | Seluruh uji dilewati tanpa gejala |

```bash
# -count=1 mematikan cache uji: WAJIB saat menyelidiki flaky
go test ./... -count=1

# Urutan acak membongkar ketergantungan antar uji yang tersembunyi
go test ./... -shuffle=on

# Diulang dengan detektor race untuk memancing kegagalan yang jarang
go test ./... -race -count=10

# Uji mana yang paling sering gagal
go test ./... -json | jq -r 'select(.Action=="fail") | .Test' | sort | uniq -c | sort -rn

# Uji paling lambat -- biasanya ada Sleep di dalamnya
go test ./... -json | jq -r 'select(.Action=="pass" and .Elapsed>0.5) | "\(.Elapsed)s \(.Test)"' | sort -rn | head -20

# Berkas dengan cakupan terendah, bukan angka total
go test ./... -coverprofile=c.out && go tool cover -func=c.out | sort -k3 -n | head -20
```
