# Presedensi Konfigurasi CLI — Flag, Env, Berkas, Default

> **Berlaku:** Go 1.21+ · `spf13/viper` v1.18+ (opsional) · **Lihat juga:** `cli_tooling/cobra_command_architecture.md` · `arch_patterns/config_management.md` · `security_owasp/secret_management_vault.md`

## Konsep Utama

Setiap CLI yang dipakai lebih dari satu orang akhirnya butuh tiga sumber konfigurasi: **flag** untuk sekali jalan, **environment** untuk kontainer dan CI, **berkas** untuk kenyamanan sehari-hari. Masalahnya bukan membacanya — masalahnya menentukan siapa menang, dan membuat aturan itu **bisa dijelaskan tanpa membaca kode**.

Urutan yang menjadi standar de facto, dari paling menang:

```
1. Flag baris perintah      --db-host=x        paling spesifik, paling sementara
2. Environment variable     APP_DB_HOST=x      lingkungan, kontainer, CI
3. Berkas konfigurasi       db.host: x         proyek atau pengguna
4. Nilai default            "localhost"        aman, terdokumentasi
```

Logikanya konsisten: **semakin dekat ke momen eksekusi, semakin menang.**

### Kegagalan diam yang menghabiskan berjam-jam

Kegagalan paling mahal di konfigurasi bukan nilai yang salah — tapi nilai yang **diam-diam diabaikan**:

> Seseorang menyetel `APP_DB_HOST=prod-db`, tapi ada `--db-host` di skrip pembungkus yang tidak terlihat. Alat menyambung ke tempat yang salah, tanpa satu pun pesan. Debugging berjam-jam.

Karena itu satu kemampuan WAJIB ada di setiap CLI serius: **perintah yang menjelaskan asal setiap nilai.**

```
$ app config debug
db.host   = prod-db        <- env APP_DB_HOST
db.port   = 5432           <- default
db.name   = katalog        <- berkas /etc/app/config.yaml
log.level = debug          <- flag --log-level
```

Satu perintah ini menghapus seluruh kelas tiket dukungan.

### Viper atau tulis sendiri?

| | Viper | Tulis sendiri |
| :--- | :--- | :--- |
| Sumber | Flag, env, berkas, remote, live-reload | Yang Anda butuhkan saja |
| Ukuran biner | +~4 MB | ~0 |
| Presedensi | Sudah ada, tapi **halus dan mudah salah paham** | Eksplisit, Anda yang menentukan |
| Kecocokan tipe | `GetInt`, `GetString` — gagal diam bila tipe salah | Kompilator yang menjaga |

Untuk CLI dengan <15 opsi, **struct + `env` + `flag` biasanya lebih baik**: lebih kecil, lebih jelas, dan kompilator menangkap salah tipe. Viper mulai menang saat Anda butuh banyak format berkas, konfigurasi berlapis, atau muat ulang saat berjalan.

Berkas ini menunjukkan implementasi mandiri yang eksplisit — karena inilah yang paling sering ditanyakan dalam review: *"kenapa nilai ini yang dipakai?"*

## Diagram ASCII

```text
   PRESEDENSI — nilai efektif ditentukan lapis paling atas yang MENYETEL

   lapis          db.host        log.level      timeout
   -----          -------        ---------      -------
   flag           (kosong)       debug   <--+   (kosong)
   env            prod-db  <--+  (kosong)   |   (kosong)
   berkas         file-db     |  info       |   30s   <--+
   default        localhost   |  info       |   10s     |
                              |             |           |
   EFEKTIF        prod-db ----+  debug -----+   30s -----+
   ASAL           env            flag           berkas

   Kunci: lacak ASAL, bukan hanya nilai. Tanpa itu, konfigurasi
   yang salah tampak identik dengan konfigurasi yang benar.

   ---------------------------------------------------------------

   PEMETAAN NAMA — satu kunci, tiga bentuk

   kunci kanonik : db.host
                     |
        +------------+------------+
        v            v            v
   flag: --db-host   env: APP_DB_HOST   yaml: db: { host: ... }
        |                 |                  |
        `- titik jadi     `- titik jadi      `- struktur bersarang
           strip             garis bawah,        alami
                             awalan APP_
```

## Kode Go Production-Ready

```go
package config

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Asal menandai dari lapis mana sebuah nilai berasal.
type Asal string

const (
	AsalDefault Asal = "default"
	AsalBerkas  Asal = "berkas"
	AsalEnv     Asal = "env"
	AsalFlag    Asal = "flag"
)

// Nilai membungkus nilai efektif beserta asalnya.
// Menyimpan asal adalah inti dari seluruh berkas ini — tanpa itu,
// `config debug` mustahil dan salah konfigurasi jadi tak terlacak.
type Nilai[T any] struct {
	V    T
	Asal Asal
}

// Config adalah konfigurasi efektif aplikasi.
type Config struct {
	DBHost   Nilai[string]
	DBPort   Nilai[int]
	Timeout  Nilai[time.Duration]
	LogLevel Nilai[string]
}

// berkasConfig memetakan struktur YAML.
type berkasConfig struct {
	DB struct {
		Host *string `yaml:"host"`
		Port *int    `yaml:"port"`
	} `yaml:"db"`
	Timeout  *string `yaml:"timeout"`
	LogLevel *string `yaml:"log_level"`
}

// Flags memuat nilai flag. Pointer nil berarti flag TIDAK diberikan —
// membedakan "tidak disetel" dari "disetel ke nilai kosong".
type Flags struct {
	DBHost   *string
	DBPort   *int
	Timeout  *time.Duration
	LogLevel *string
}

// ErrValidasi menandai konfigurasi yang tidak masuk akal.
var ErrValidasi = errors.New("config: nilai tidak valid")

// levelSah adalah level log yang diterima.
var levelSah = map[string]bool{"debug": true, "info": true, "warn": true, "error": true}

// Muat menggabungkan keempat lapis sesuai presedensi.
// Urutan penerapan sengaja dari yang PALING LEMAH ke PALING KUAT,
// sehingga lapis berikutnya menimpa — dan asalnya ikut tercatat.
func Muat(path string, env func(string) (string, bool), f Flags) (*Config, error) {
	c := &Config{
		DBHost:   Nilai[string]{"localhost", AsalDefault},
		DBPort:   Nilai[int]{5432, AsalDefault},
		Timeout:  Nilai[time.Duration]{10 * time.Second, AsalDefault},
		LogLevel: Nilai[string]{"info", AsalDefault},
	}

	// Lapis 2: berkas. Berkas tidak ada BUKAN error — itu kasus normal.
	if path != "" {
		raw, err := os.ReadFile(path)
		switch {
		case err == nil:
			var bc berkasConfig
			if err := yaml.Unmarshal(raw, &bc); err != nil {
				return nil, fmt.Errorf("urai %s: %w", path, err)
			}
			if bc.DB.Host != nil {
				c.DBHost = Nilai[string]{*bc.DB.Host, AsalBerkas}
			}
			if bc.DB.Port != nil {
				c.DBPort = Nilai[int]{*bc.DB.Port, AsalBerkas}
			}
			if bc.Timeout != nil {
				d, perr := time.ParseDuration(*bc.Timeout)
				if perr != nil {
					return nil, fmt.Errorf("%s: timeout %q: %w", path, *bc.Timeout, perr)
				}
				c.Timeout = Nilai[time.Duration]{d, AsalBerkas}
			}
			if bc.LogLevel != nil {
				c.LogLevel = Nilai[string]{*bc.LogLevel, AsalBerkas}
			}
		case errors.Is(err, os.ErrNotExist):
			// Sengaja diabaikan. Berkas konfigurasi bersifat opsional.
		default:
			return nil, fmt.Errorf("baca %s: %w", path, err)
		}
	}

	// Lapis 3: environment.
	if v, ok := env("APP_DB_HOST"); ok {
		c.DBHost = Nilai[string]{v, AsalEnv}
	}
	if v, ok := env("APP_DB_PORT"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("APP_DB_PORT %q: %w", v, err)
		}
		c.DBPort = Nilai[int]{n, AsalEnv}
	}
	if v, ok := env("APP_TIMEOUT"); ok {
		d, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("APP_TIMEOUT %q: %w", v, err)
		}
		c.Timeout = Nilai[time.Duration]{d, AsalEnv}
	}
	if v, ok := env("APP_LOG_LEVEL"); ok {
		c.LogLevel = Nilai[string]{v, AsalEnv}
	}

	// Lapis 4: flag — paling menang.
	if f.DBHost != nil {
		c.DBHost = Nilai[string]{*f.DBHost, AsalFlag}
	}
	if f.DBPort != nil {
		c.DBPort = Nilai[int]{*f.DBPort, AsalFlag}
	}
	if f.Timeout != nil {
		c.Timeout = Nilai[time.Duration]{*f.Timeout, AsalFlag}
	}
	if f.LogLevel != nil {
		c.LogLevel = Nilai[string]{*f.LogLevel, AsalFlag}
	}

	if err := c.Validasi(); err != nil {
		return nil, err
	}
	return c, nil
}

// Validasi menolak konfigurasi yang mustahil SEBELUM aplikasi berjalan.
// Gagal saat boot jauh lebih murah daripada gagal saat request pertama.
func (c *Config) Validasi() error {
	var masalah []string
	if c.DBHost.V == "" {
		masalah = append(masalah, "db.host kosong")
	}
	if c.DBPort.V < 1 || c.DBPort.V > 65535 {
		masalah = append(masalah, fmt.Sprintf("db.port %d di luar 1-65535", c.DBPort.V))
	}
	if c.Timeout.V <= 0 {
		masalah = append(masalah, fmt.Sprintf("timeout %v harus positif", c.Timeout.V))
	}
	if !levelSah[c.LogLevel.V] {
		masalah = append(masalah, fmt.Sprintf("log_level %q tidak dikenal", c.LogLevel.V))
	}
	if len(masalah) > 0 {
		return fmt.Errorf("%w: %s", ErrValidasi, strings.Join(masalah, "; "))
	}
	return nil
}

// Jejak mengembalikan penjelasan asal tiap kunci, terurut.
// Inilah keluaran perintah `app config debug`.
func (c *Config) Jejak() []string {
	baris := []string{
		fmt.Sprintf("db.host   = %-20s <- %s", c.DBHost.V, c.DBHost.Asal),
		fmt.Sprintf("db.port   = %-20d <- %s", c.DBPort.V, c.DBPort.Asal),
		fmt.Sprintf("timeout   = %-20v <- %s", c.Timeout.V, c.Timeout.Asal),
		fmt.Sprintf("log.level = %-20s <- %s", c.LogLevel.V, c.LogLevel.Asal),
	}
	sort.Strings(baris)
	return baris
}
```

## Uji

```go
package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// envDari membuat pencari env palsu — tanpa menyentuh env proses.
func envDari(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func tulisBerkas(t *testing.T, isi string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(isi), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPresedensi_FlagMenangSegalanya(t *testing.T) {
	p := tulisBerkas(t, "db:\n  host: file-db\n")
	host := "flag-db"
	c, err := Muat(p, envDari(map[string]string{"APP_DB_HOST": "env-db"}), Flags{DBHost: &host})
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if c.DBHost.V != "flag-db" || c.DBHost.Asal != AsalFlag {
		t.Fatalf("mau flag-db dari flag, dapat %q dari %s", c.DBHost.V, c.DBHost.Asal)
	}
}

func TestPresedensi_EnvMenangAtasBerkas(t *testing.T) {
	p := tulisBerkas(t, "db:\n  host: file-db\n")
	c, err := Muat(p, envDari(map[string]string{"APP_DB_HOST": "env-db"}), Flags{})
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if c.DBHost.V != "env-db" || c.DBHost.Asal != AsalEnv {
		t.Fatalf("mau env-db dari env, dapat %q dari %s", c.DBHost.V, c.DBHost.Asal)
	}
}

func TestPresedensi_BerkasMenangAtasDefault(t *testing.T) {
	p := tulisBerkas(t, "db:\n  host: file-db\n  port: 6543\n")
	c, err := Muat(p, envDari(nil), Flags{})
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if c.DBPort.V != 6543 || c.DBPort.Asal != AsalBerkas {
		t.Fatalf("mau 6543 dari berkas, dapat %d dari %s", c.DBPort.V, c.DBPort.Asal)
	}
	if c.Timeout.Asal != AsalDefault {
		t.Fatalf("timeout tak disebut mana pun harus default, dapat %s", c.Timeout.Asal)
	}
}

func TestBerkasTidakAda_BukanError(t *testing.T) {
	c, err := Muat("/tidak/ada/config.yaml", envDari(nil), Flags{})
	if err != nil {
		t.Fatalf("berkas opsional tidak boleh jadi error: %v", err)
	}
	if c.DBHost.V != "localhost" {
		t.Fatalf("mau default, dapat %q", c.DBHost.V)
	}
}

func TestFlagKosongEksplisitTetapMenang(t *testing.T) {
	// Membedakan "tidak disetel" dari "disetel ke kosong" — inilah
	// alasan Flags memakai pointer, bukan nilai biasa.
	p := tulisBerkas(t, "log_level: debug\n")
	kosong := ""
	_, err := Muat(p, envDari(nil), Flags{LogLevel: &kosong})
	if !errors.Is(err, ErrValidasi) {
		t.Fatalf("flag kosong eksplisit harus menimpa lalu gagal validasi, dapat %v", err)
	}
}

func TestValidasi_MenolakNilaiMustahil(t *testing.T) {
	port := 70000
	_, err := Muat("", envDari(nil), Flags{DBPort: &port})
	if !errors.Is(err, ErrValidasi) {
		t.Fatalf("mau ErrValidasi, dapat %v", err)
	}
	if !strings.Contains(err.Error(), "di luar 1-65535") {
		t.Fatalf("pesan harus menyebut batas, dapat %v", err)
	}
}

func TestEnvSalahTipe_ErrorJelas(t *testing.T) {
	_, err := Muat("", envDari(map[string]string{"APP_DB_PORT": "bukan-angka"}), Flags{})
	if err == nil || !strings.Contains(err.Error(), "APP_DB_PORT") {
		t.Fatalf("error harus menyebut nama variabel, dapat %v", err)
	}
}

func TestJejak_MenyebutAsal(t *testing.T) {
	host := "flag-db"
	c, err := Muat("", envDari(map[string]string{"APP_TIMEOUT": "45s"}), Flags{DBHost: &host})
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	j := strings.Join(c.Jejak(), "\n")
	if !strings.Contains(j, "flag") || !strings.Contains(j, "env") || !strings.Contains(j, "default") {
		t.Fatalf("jejak harus menyebut ketiga asal:\n%s", j)
	}
	if c.Timeout.V != 45*time.Second {
		t.Fatalf("timeout dari env salah: %v", c.Timeout.V)
	}
}
```

## Anti-Pattern

**❌ SALAH — presedensi terbalik atau tidak disengaja**

```go
cfg := bacaBerkas(path)
if v := os.Getenv("APP_DB_HOST"); v != "" {
	cfg.DBHost = v
}
cfg.DBHost = *flagHost // flag SELALU menimpa, walau tidak diberikan
```

Baris terakhir menimpa dengan string kosong ketika flag tidak diberikan, menghapus nilai dari berkas dan env. Bug ini sangat umum dan gejalanya membingungkan: konfigurasi "hilang" tanpa sebab.

**✅ BENAR — pointer membedakan "tidak disetel" dari "kosong"**

```go
if f.DBHost != nil { // hanya bila flag benar-benar diberikan
	c.DBHost = Nilai[string]{*f.DBHost, AsalFlag}
}
```

Dengan cobra: `if cmd.Flags().Changed("db-host") { ... }`.

**❌ SALAH — rahasia di berkas konfigurasi**

```yaml
db:
  host: prod-db
  password: rahasia123    # ikut ter-commit, ikut tersalin, ikut ter-backup
```

**✅ BENAR — rahasia hanya lewat env atau penyimpan rahasia**

```yaml
db:
  host: prod-db
  # password diambil dari APP_DB_PASSWORD atau Vault; lihat
  # security_owasp/secret_management_vault.md
```

Dan pastikan `Jejak()` **DILARANG** mencetak nilai rahasia — cukup asalnya:

```go
fmt.Sprintf("db.password = %-20s <- %s", "********", c.DBPassword.Asal)
```

**❌ SALAH — validasi baru terjadi saat nilai dipakai**

```go
db, err := sql.Open("pgx", fmt.Sprintf("host=%s port=%d", cfg.Host, cfg.Port))
// port = 0 baru ketahuan di sini, setelah aplikasi berjalan 10 menit
```

**✅ BENAR — gagal saat boot, dengan seluruh masalah sekaligus**

`Validasi()` di atas mengumpulkan **semua** masalah lalu melaporkannya bersama. Memperbaiki satu per satu karena validator berhenti di masalah pertama membuang waktu.

## Kasus Tepi Produksi

1. **Beberapa lokasi berkas konfigurasi.** Urutan pencarian yang lazim: `--config` eksplisit → `./app.yaml` → `$XDG_CONFIG_HOME/app/config.yaml` → `/etc/app/config.yaml`. Yang pertama ditemukan dipakai; **DILARANG** menggabungkan beberapa berkas kecuali Anda benar-benar mendokumentasikan aturan penggabungannya, karena penggabungan diam-diam adalah sumber kebingungan besar.

2. **Awalan env yang bertabrakan.** `APP_` terlalu umum. Bila alat Anda berjalan bersama alat lain di kontainer yang sama, tabrakan bisa terjadi. Pakai awalan spesifik seperti `KATALOG_`, dan sebutkan di `--help`.

3. **Nilai boolean di env.** `APP_DEBUG=false` bernilai **true** bila Anda hanya memeriksa keberadaannya. Selalu urai dengan `strconv.ParseBool`, dan perlakukan nilai tak terurai sebagai error, bukan sebagai `false`.

4. **Konfigurasi berubah saat proses berjalan.** Untuk CLI berumur pendek ini tidak relevan. Untuk daemon, muat ulang menambah kelas bug baru: apa yang terjadi pada koneksi yang sudah terbuka? Jawaban paling aman untuk sebagian besar kasus: **jangan muat ulang, restart saja** — dan jadikan restart murah.

5. **Nilai default yang bergantung lingkungan.** Default `localhost` benar di laptop, salah di kontainer. Bila mendeteksi lingkungan otomatis, WAJIB tampilkan di `Jejak()` sebagai asal terpisah (mis. `<- deteksi-otomatis`), jangan menyamar sebagai `default`.

6. **Berkas konfigurasi memuat kunci yang tidak dikenal.** Salah ketik `hots:` alih-alih `host:` akan diabaikan diam-diam oleh YAML. Pakai `yaml.Decoder` dengan `KnownFields(true)` agar salah ketik jadi error — ini menangkap kesalahan yang sangat sulit dilihat mata.

## Kapan JANGAN Pakai Ini

- **Alat dengan kurang dari tiga opsi.** Flag saja sudah cukup. Berkas konfigurasi untuk dua opsi menambah tempat bagi kebingungan tanpa manfaat.
- **Viper untuk kebutuhan sederhana.** Tambahan ~4 MB pada biner dan lapisan tak langsung yang membuat pertanyaan "kenapa nilai ini?" jadi sulit dijawab. Pakai bila Anda benar-benar butuh banyak format atau konfigurasi remote.
- **Konfigurasi untuk hal yang seharusnya argumen.** Kalau nilainya berubah tiap kali dijalankan, itu argumen, bukan konfigurasi.
- **Muat ulang saat berjalan pada CLI.** Prosesnya hidup beberapa detik; kerumitannya tidak akan pernah terbayar.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Alat menyambung ke tempat yang salah | jalankan `app config debug` | Ada lapis yang menimpa tanpa disadari — biasanya flag di skrip pembungkus |
| Konfigurasi "hilang" setelah menambah flag | cek apakah flag menimpa tanpa `Changed()` | Flag tidak diberikan tetap menimpa dengan nilai kosong |
| Berbeda perilaku di laptop dan CI | bandingkan keluaran `config debug` di keduanya | Env di CI menimpa berkas, atau sebaliknya |
| Salah ketik di YAML tidak terdeteksi | apakah `KnownFields(true)` aktif | Kunci tak dikenal diabaikan diam-diam |
| Rahasia muncul di log | cari nilai sensitif di keluaran `Jejak()` | Penyamaran nilai rahasia belum dipasang |

```bash
# Selalu jalankan ini lebih dulu saat konfigurasi mencurigakan
app config debug

# Bandingkan lingkungan
ssh ci-runner 'app config debug' > ci.txt
app config debug > lokal.txt
diff ci.txt lokal.txt

# Env apa saja yang terbaca alat ini?
env | grep '^KATALOG_'

# Cari flag yang menimpa tanpa memeriksa Changed()
grep -rn "Flags()\.\(String\|Int\|Bool\)Var" --include="*.go" internal/cli/ \
  | while read -r l; do echo "periksa Changed() untuk: $l"; done
```
