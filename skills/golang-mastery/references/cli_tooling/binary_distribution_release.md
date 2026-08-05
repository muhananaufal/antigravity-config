# Distribusi Biner — Cross-Compile, Versi, Checksum, dan Kanal Instalasi

> **Berlaku:** Go 1.21+ · GoReleaser v2+ · **Lihat juga:** `ci_cd_pipeline/goreleaser_release.md` · `cybersecurity_zerotrust/binary_signing_verification.md` · `cli_tooling/cobra_command_architecture.md`

## Konsep Utama

Keunggulan terbesar Go untuk CLI adalah **satu berkas tanpa runtime**. Tapi keunggulan itu hanya terwujud bila distribusinya benar. CLI yang bagus dengan distribusi buruk akan kalah oleh CLI biasa yang bisa dipasang dengan satu baris.

Empat hal yang WAJIB ada, dan tiga di antaranya hampir selalu terlupa:

| Kebutuhan | Sering terlupa? | Akibat bila tidak ada |
| :--- | :---: | :--- |
| Biner untuk platform yang dipakai pengguna | | Pengguna Windows/macOS ARM tidak bisa memakai |
| **`--version` yang menyebut commit dan tanggal** | ✅ | Laporan bug mustahil ditelusuri: "versi apa?" — "yang terbaru" |
| **Checksum & tanda tangan** | ✅ | Tidak ada cara membuktikan biner tidak dimodifikasi |
| **Kanal instalasi yang wajar** | ✅ | Pengguna harus `curl \| tar` manual, dan tidak pernah memperbarui |

### `--version` adalah alat forensik, bukan basa-basi

Versi yang hanya berisi `v1.4.2` nyaris tidak berguna saat menangani insiden. Yang dibutuhkan:

```
$ katalog --version
katalog v1.4.2
  commit  : 3f9a1c2 (dirty)
  dibangun: 2026-08-05T10:04:00Z
  go      : go1.24.1
  platform: linux/amd64
```

`dirty` menandai biner dibangun dari pohon kerja yang belum di-commit — artinya kode yang berjalan **tidak ada di repo mana pun**. Ini informasi paling penting saat menyelidiki perilaku yang tidak masuk akal.

### Cara menyuntikkan versi

Jangan hardcode. Pakai `-ldflags -X` saat build:

```bash
go build -ldflags "-X main.versi=v1.4.2 -X main.commit=$(git rev-parse --short HEAD)" ./cmd/katalog
```

Sejak Go 1.18, sebagian informasi ini tersedia otomatis lewat `runtime/debug.ReadBuildInfo()` — termasuk revisi VCS dan status `dirty` — tanpa perlu ldflags sama sekali. Kode di bawah memakai keduanya: ldflags bila ada, jatuh ke build info bila tidak.

### Matriks platform yang wajar

| GOOS/GOARCH | Wajib? | Catatan |
| :--- | :---: | :--- |
| `linux/amd64` | ✅ | Server, CI |
| `linux/arm64` | ✅ | Graviton, Ampere — makin umum |
| `darwin/arm64` | ✅ | Semua Mac sejak 2020 |
| `darwin/amd64` | ⚠️ | Mac Intel, masih ada tapi menyusut |
| `windows/amd64` | ✅ | Jangan diasumsikan tidak ada penggunanya |

`CGO_ENABLED=0` membuat biner benar-benar statis dan bisa berjalan di `scratch`/`distroless`. Aktifkan CGO hanya bila benar-benar butuh — dan sadari itu mengorbankan cross-compile yang mudah.

## Diagram ASCII

```text
   ALUR RILIS — dari tag sampai terpasang di mesin pengguna

   git tag v1.4.2
        |
        v
   +----------------------+
   | CI: build matriks    |  CGO_ENABLED=0, -trimpath, -ldflags versi
   | 5 platform           |
   +----------+-----------+
              |
              v
   +----------------------+
   | checksums.txt        |  SHA-256 seluruh artefak
   | + tanda tangan       |  cosign / minisign
   +----------+-----------+
              |
     +--------+--------+--------+
     v        v        v        v
   GitHub  Homebrew   Scoop   go install
   Release  (macOS)  (Windows) (pengguna Go)
     |
     v
   pengguna: verifikasi checksum -> jalankan

   ---------------------------------------------------------------

   SUMBER INFORMASI VERSI

   -ldflags -X main.versi=...     <- eksplisit, dipakai CI
            |
            +--- kosong? -------> runtime/debug.ReadBuildInfo()
                                   |
                                   +- vcs.revision   commit
                                   +- vcs.time       tanggal
                                   +- vcs.modified   dirty
                                   +- GoVersion      go1.24.1

   Biner yang dibangun `go install user/repo@v1.4.2` tetap punya
   informasi lengkap TANPA ldflags — inilah kenapa fallback ini penting.
```

## Kode Go Production-Ready

```go
package version

import (
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
	"strings"
)

// Nilai berikut disuntikkan saat build:
//
//	go build -ldflags "-X example.com/katalog/internal/version.versi=v1.4.2"
//
// Bila kosong, Info() jatuh ke runtime/debug.ReadBuildInfo().
var (
	versi   string
	commit  string
	tanggal string
)

// Info memuat seluruh identitas biner.
type Info struct {
	Versi    string `json:"versi"`
	Commit   string `json:"commit"`
	Kotor    bool   `json:"kotor"`
	Tanggal  string `json:"tanggal"`
	GoVersi  string `json:"go_versi"`
	Platform string `json:"platform"`
	Modul    string `json:"modul,omitempty"`
}

// Baca menyusun Info dari ldflags bila ada, atau dari build info.
func Baca() Info {
	i := Info{
		Versi:    versi,
		Commit:   commit,
		Tanggal:  tanggal,
		GoVersi:  runtime.Version(),
		Platform: runtime.GOOS + "/" + runtime.GOARCH,
	}

	bi, ok := debug.ReadBuildInfo()
	if !ok {
		i.lengkapiKosong()
		return i
	}
	i.Modul = bi.Main.Path

	// bi.Main.Version bernilai "(devel)" untuk build lokal, atau tag
	// sebenarnya bila dipasang lewat `go install modul@v1.4.2`.
	if i.Versi == "" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		i.Versi = bi.Main.Version
	}

	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			if i.Commit == "" {
				i.Commit = pendekkan(s.Value)
			}
		case "vcs.time":
			if i.Tanggal == "" {
				i.Tanggal = s.Value
			}
		case "vcs.modified":
			i.Kotor = s.Value == "true"
		}
	}
	i.lengkapiKosong()
	return i
}

func (i *Info) lengkapiKosong() {
	if i.Versi == "" {
		i.Versi = "dev"
	}
	if i.Commit == "" {
		i.Commit = "tidak diketahui"
	}
	if i.Tanggal == "" {
		i.Tanggal = "tidak diketahui"
	}
}

func pendekkan(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// String memberi bentuk satu baris, cocok untuk log dan User-Agent.
func (i Info) String() string {
	s := i.Versi
	if i.Commit != "tidak diketahui" {
		s += "+" + i.Commit
	}
	if i.Kotor {
		s += "-dirty"
	}
	return s
}

// Tulis mencetak versi dalam format panjang atau JSON.
// JSON penting agar skrip bisa memeriksa versi tanpa mengurai teks bebas.
func (i Info) Tulis(w io.Writer, sebagaiJSON bool) error {
	if sebagaiJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(i)
	}
	kotor := ""
	if i.Kotor {
		kotor = " (dirty)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "katalog %s\n", i.Versi)
	fmt.Fprintf(&b, "  commit  : %s%s\n", i.Commit, kotor)
	fmt.Fprintf(&b, "  dibangun: %s\n", i.Tanggal)
	fmt.Fprintf(&b, "  go      : %s\n", i.GoVersi)
	fmt.Fprintf(&b, "  platform: %s\n", i.Platform)
	_, err := io.WriteString(w, b.String())
	return err
}
```

Disambungkan ke cobra:

```go
func newVersionCmd() *cobra.Command {
	var sebagaiJSON bool
	c := &cobra.Command{
		Use:   "version",
		Short: "Tampilkan versi biner",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return version.Baca().Tulis(cmd.OutOrStdout(), sebagaiJSON)
		},
	}
	c.Flags().BoolVar(&sebagaiJSON, "json", false, "keluarkan sebagai JSON")
	return c
}
```

`.goreleaser.yaml` yang lengkap:

```yaml
version: 2
before:
  hooks: [go mod tidy, go test ./...]

builds:
  - env: [CGO_ENABLED=0]
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ignore:
      - goos: windows
        goarch: arm64
    # -trimpath menghapus path absolut mesin build -> build reproducible
    flags: [-trimpath]
    ldflags:
      - -s -w
      - -X example.com/katalog/internal/version.versi={{.Version}}
      - -X example.com/katalog/internal/version.commit={{.ShortCommit}}
      - -X example.com/katalog/internal/version.tanggal={{.Date}}

archives:
  - format_overrides:
      - goos: windows
        format: zip

checksum:
  name_template: checksums.txt
  algorithm: sha256

# Tanda tangan keyless — tidak perlu menyimpan kunci privat
signs:
  - cmd: cosign
    args: [sign-blob, --yes, --output-signature=${signature}, ${artifact}]
    artifacts: checksum

brews:
  - repository: {owner: contoh, name: homebrew-tap}

changelog:
  filters:
    exclude: ['^docs:', '^test:', '^chore:']
```

## Uji

```go
package version

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestBaca_JatuhKeDefaultSaatKosong(t *testing.T) {
	versi, commit, tanggal = "", "", ""
	i := Baca()
	if i.Versi == "" || i.Commit == "" || i.Tanggal == "" {
		t.Fatalf("field wajib tidak boleh kosong: %+v", i)
	}
	if i.Platform == "" || !strings.Contains(i.Platform, "/") {
		t.Fatalf("platform salah bentuk: %q", i.Platform)
	}
}

func TestBaca_LdflagsMenang(t *testing.T) {
	versi, commit, tanggal = "v1.4.2", "3f9a1c2", "2026-08-05T10:04:00Z"
	t.Cleanup(func() { versi, commit, tanggal = "", "", "" })

	i := Baca()
	if i.Versi != "v1.4.2" || i.Commit != "3f9a1c2" {
		t.Fatalf("ldflags harus menang: %+v", i)
	}
}

func TestString_MenandaiDirty(t *testing.T) {
	i := Info{Versi: "v1.4.2", Commit: "3f9a1c2", Kotor: true}
	if got := i.String(); got != "v1.4.2+3f9a1c2-dirty" {
		t.Fatalf("mau v1.4.2+3f9a1c2-dirty, dapat %q", got)
	}
}

func TestString_TanpaCommitTidakMenambahPlus(t *testing.T) {
	i := Info{Versi: "dev", Commit: "tidak diketahui"}
	if got := i.String(); got != "dev" {
		t.Fatalf("mau dev, dapat %q", got)
	}
}

func TestTulis_JSONBisaDiurai(t *testing.T) {
	var b bytes.Buffer
	i := Info{Versi: "v1.4.2", Commit: "3f9a1c2", Platform: "linux/amd64"}
	if err := i.Tulis(&b, true); err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	var got Info
	if err := json.Unmarshal(b.Bytes(), &got); err != nil {
		t.Fatalf("keluaran bukan JSON valid: %v\n%s", err, b.String())
	}
	if got.Versi != "v1.4.2" {
		t.Fatalf("versi tidak terbawa: %+v", got)
	}
}

func TestTulis_TeksMemuatSeluruhField(t *testing.T) {
	var b bytes.Buffer
	i := Info{Versi: "v1.4.2", Commit: "3f9a1c2", Kotor: true,
		Tanggal: "2026-08-05T10:04:00Z", GoVersi: "go1.24.1", Platform: "linux/amd64"}
	if err := i.Tulis(&b, false); err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	for _, wajib := range []string{"v1.4.2", "3f9a1c2", "(dirty)", "go1.24.1", "linux/amd64"} {
		if !strings.Contains(b.String(), wajib) {
			t.Fatalf("keluaran tidak memuat %q:\n%s", wajib, b.String())
		}
	}
}

func TestPendekkan(t *testing.T) {
	if got := pendekkan("3f9a1c2d4e5f6789"); got != "3f9a1c2" {
		t.Fatalf("mau 3f9a1c2, dapat %q", got)
	}
	if got := pendekkan("abc"); got != "abc" {
		t.Fatalf("sha pendek harus dibiarkan, dapat %q", got)
	}
}
```

## Anti-Pattern

**❌ SALAH — versi di-hardcode di kode**

```go
const Versi = "v1.4.0" // lupa dinaikkan saat rilis v1.4.1, v1.4.2, ...
```

Setelah beberapa rilis, angkanya berbohong. Laporan bug menyebut v1.4.0 padahal yang berjalan v1.4.3, dan Anda mencari bug di kode yang salah.

**✅ BENAR — disuntik saat build, dengan cadangan dari build info**

Lihat paket `version` di atas: ldflags bila ada, `debug.ReadBuildInfo()` bila tidak. Biner hasil `go install repo@v1.4.2` tetap tahu versinya tanpa ldflags.

**❌ SALAH — rilis tanpa checksum**

```text
Releases/
  katalog_linux_amd64.tar.gz
```

Pengguna tidak punya cara memverifikasi. Bila akun rilis Anda diretas dan artefaknya diganti, tidak ada yang menyadari.

**✅ BENAR — checksum ditandatangani, verifikasi didokumentasikan**

```bash
# Di README:
curl -LO https://.../katalog_linux_amd64.tar.gz
curl -LO https://.../checksums.txt
curl -LO https://.../checksums.txt.sig

cosign verify-blob --signature checksums.txt.sig \
  --certificate-identity-regexp '.*' --certificate-oidc-issuer-regexp '.*' \
  checksums.txt
sha256sum -c checksums.txt --ignore-missing
```

**❌ SALAH — biner membawa path mesin build**

```bash
go build ./cmd/katalog
# Stack trace memuat /home/budi/proyek/katalog/internal/...
# Build tidak reproducible, dan nama pengguna bocor ke publik.
```

**✅ BENAR — `-trimpath` dan simbol dibuang**

```bash
go build -trimpath -ldflags "-s -w" ./cmd/katalog
# -trimpath : path relatif modul, build reproducible
# -s -w     : buang tabel simbol & DWARF, biner ~30% lebih kecil
```

**❌ SALAH — hanya menyediakan `go install`**

```text
Instalasi: go install example.com/katalog@latest
```

Ini mensyaratkan pengguna punya toolchain Go. Untuk alat operasional yang dipakai SRE atau analis, sebagian besar tidak punya — dan tidak seharusnya harus punya.

**✅ BENAR — beberapa kanal, satu sumber artefak**

```text
brew install contoh/tap/katalog          # macOS/Linux
scoop install katalog                    # Windows
curl -sSfL https://.../install.sh | sh   # skrip, dengan verifikasi checksum
go install example.com/katalog@latest    # pengguna Go
```

## Kasus Tepi Produksi

1. **Biner macOS ditolak Gatekeeper.** Sejak macOS Catalina, biner tak bertanda tangan yang diunduh lewat browser diblokir dengan pesan yang menakutkan. Pemasangan lewat Homebrew tidak terkena karena tidak melewati karantina. Bila mendistribusikan `.dmg` atau `.pkg`, notarization berbayar diperlukan — atau arahkan pengguna macOS ke Homebrew saja.

2. **`CGO_ENABLED=1` menghancurkan cross-compile.** Begitu satu dependensi butuh CGO (mis. `mattn/go-sqlite3`), Anda perlu toolchain silang per platform. Periksa lebih awal: `go list -deps ./... | xargs go list -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}'`. Sering ada pengganti murni Go — untuk SQLite ada `modernc.org/sqlite`.

3. **Windows menambahkan `.exe`, dan path memakai backslash.** Kode yang membangun path dengan `"/"` akan bekerja di Windows secara kebetulan, sampai tidak. Selalu `filepath.Join`. Uji di CI Windows, bukan hanya membangunnya.

4. **Biner ARM64 dijalankan di amd64 lewat emulasi.** Pengguna yang salah unduh mendapat pesan "cannot execute binary file" yang tidak informatif. Skrip instalasi WAJIB mendeteksi `uname -m` dan memetakannya, bukan meminta pengguna memilih.

5. **Ukuran biner membengkak diam-diam.** Satu dependensi yang menarik seluruh AWS SDK bisa menambah 20 MB. Pantau ukuran artefak di CI dan gagalkan bila melewati ambang — regresi ukuran hampir tidak pernah disengaja.

6. **Pemeriksaan pembaruan otomatis.** Menyenangkan, tapi berarti CLI Anda menghubungi jaringan tiap kali dijalankan — melanggar harapan di lingkungan tertutup dan memperlambat pemakaian di skrip. Bila dipasang: cache hasilnya, jangan pernah memblokir jalannya perintah, dan sediakan `--no-update-check`.

## Kapan JANGAN Pakai Ini

- **Alat internal untuk satu tim yang semuanya punya Go.** `go install` sudah cukup; pipeline rilis penuh adalah beban tanpa manfaat.
- **Alat yang hanya berjalan sebagai container.** Distribusinya adalah image, bukan biner. Yang perlu ditandatangani adalah image-nya.
- **Sebelum ada pengguna di luar tim Anda.** Homebrew tap dan penandatanganan untuk nol pengguna eksternal adalah pekerjaan yang belum perlu.
- **Menandatangani tiap commit build.** Tandatangani rilis bertag saja. Build sementara tidak perlu, dan menambah gesekan pada iterasi.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Laporan bug tanpa versi yang bisa dipercaya | apakah `--version` menyebut commit | Versi di-hardcode atau tidak disuntik |
| Perilaku aneh yang tidak cocok kode mana pun | `--version` menampilkan `dirty` | Biner dibangun dari pohon kerja tak ter-commit |
| Pengguna terjebak di versi lama | unduhan per versi di GitHub Releases | Tidak ada kanal yang memperbarui otomatis |
| Stack trace memuat path mesin build | jalankan `strings biner \| grep /home/` | `-trimpath` tidak dipakai |
| Ukuran biner naik tiba-tiba | grafik ukuran artefak per rilis | Dependensi baru yang berat masuk tanpa disadari |

```bash
# Apakah biner benar-benar statis?
ldd ./katalog 2>&1 | head   # "not a dynamic executable" = statis

# Apakah path mesin build bocor?
strings ./katalog | grep -E '/home/|/Users/' | head

# Ukuran per rilis
gh release list --limit 10 --json tagName,assets \
  | jq -r '.[] | "\(.tagName) \(.assets[0].size/1024/1024 | floor)MB"'

# Dependensi yang memaksa CGO
go list -deps ./... | xargs go list -f '{{if .CgoFiles}}{{.ImportPath}}{{end}}' 2>/dev/null

# Verifikasi rilis seperti yang dilakukan pengguna
sha256sum -c checksums.txt --ignore-missing
```
