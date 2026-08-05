# Cobra — Arsitektur Perintah CLI

> **Berlaku:** Go 1.21+ · `spf13/cobra` v1.8+ · **Lihat juga:** `cli_tooling/config_precedence_viper.md` · `cli_tooling/cli_testing_golden_files.md` · `observability_resilience/graceful_shutdown_drain.md`

## Konsep Utama

Mengurai flag adalah masalah yang sudah selesai. Yang membedakan CLI yang bertahan lima tahun dari yang jadi beban adalah dua hal: **struktur perintah yang bisa tumbuh** dan **jahitan yang bersih antara lapisan CLI dan logika domain**.

Kegagalan paling umum di CLI Go — dan hampir selalu muncul di setiap basis kode yang tidak sengaja dirancang:

```go
RunE: func(cmd *cobra.Command, args []string) error {
    db, _ := sql.Open("pgx", dsn)          // membuka sumber daya
    rows, _ := db.Query("SELECT ...")      // logika bisnis
    for rows.Next() { fmt.Println(...) }   // menulis ke stdout global
    return nil
}
```

Kode ini tidak bisa diuji tanpa database, tidak bisa dipakai ulang dari luar CLI, dan keluarannya tidak bisa ditangkap. Yang benar: **`cobra.Command` adalah adaptor tipis** — ia menerjemahkan argumen jadi panggilan fungsi domain, lalu menerjemahkan hasilnya jadi keluaran. Tidak lebih.

### Aturan yang menentukan CLI bisa diuji atau tidak

| Aturan | Alasan |
| :--- | :--- |
| **`RunE`, bukan `Run`** | Error dikembalikan, bukan `os.Exit` — bisa diuji dan `defer` tetap jalan |
| **DILARANG `os.Exit` di dalam `RunE`** | Melewati semua `defer`; koneksi tidak ditutup, berkas tidak di-flush |
| **Tulis ke `cmd.OutOrStdout()`** | Bukan `fmt.Println`. Test bisa mengarahkan keluaran ke buffer |
| **Flag jadi field struct, bukan variabel global** | Variabel global bocor antar-test dan membuat urutan test berpengaruh |
| **Bangun perintah lewat fungsi `newXCmd()`** | Tiap test dapat pohon perintah yang bersih |

### stdout vs stderr — kontrak, bukan selera

Ini yang membedakan CLI yang bisa dipakai dalam pipeline dari yang tidak:

| Aliran | Isi | Alasan |
| :--- | :--- | :--- |
| **stdout** | HANYA data yang diminta | Agar `mytool list \| jq` bekerja |
| **stderr** | Log, progres, peringatan, error | Agar tidak mengotori data |

Satu baris `fmt.Println("Memuat konfigurasi...")` yang salah alamat akan merusak setiap skrip yang memakai alat Anda.

### Kode keluar sebagai kontrak

Skrip membaca kode keluar, bukan pesan. Tetapkan sejak awal dan dokumentasikan:

| Kode | Arti |
| :--- | :--- |
| `0` | Berhasil |
| `1` | Kegagalan umum |
| `2` | Kesalahan pemakaian (flag salah, argumen kurang) |
| `3+` | Kegagalan domain spesifik — mis. `4` = tidak ditemukan |

## Diagram ASCII

```text
   JAHITAN CLI — di mana cobra berhenti dan domain dimulai

   +---------------------------------------------------+
   |  LAPISAN CLI (cobra)   -- TIPIS, tidak diuji berat |
   |                                                    |
   |  newListCmd(app *App) *cobra.Command               |
   |    RunE:                                           |
   |      1. baca flag  -> struct Opsi                  |
   |      2. panggil    -> app.ListProduk(ctx, opsi)    |
   |      3. format     -> tulis ke cmd.OutOrStdout()   |
   +------------------------+---------------------------+
                            | jahitan
   +------------------------v---------------------------+
   |  DOMAIN (paket biasa)  -- TEBAL, diuji menyeluruh  |
   |                                                    |
   |  func (a *App) ListProduk(ctx, Opsi) ([]Produk, error)
   |    - tanpa cobra, tanpa os.Exit, tanpa fmt.Println |
   |    - bisa dipakai HTTP handler, worker, atau test  |
   +----------------------------------------------------+

   ---------------------------------------------------------------

   POHON PERINTAH — kata benda dulu, baru kata kerja

   BENAR (dapat tumbuh)          SALAH (datar, cepat sesak)
   -------------------           -------------------------
   app                           app
   |- produk                     |- list-produk
   |  |- list                    |- create-produk
   |  |- create                  |- delete-produk
   |  `- delete                  |- list-order
   |- order                      |- create-order
   |  |- list                    `- ... 40 perintah datar
   |  `- refund
   `- config
      |- get
      `- set

   Kenapa: `app produk --help` menampilkan semua aksi produk.
   Pada bentuk datar, pengguna harus membaca 40 baris untuk menemukannya.
```

## Kode Go Production-Ready

```go
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// Kode keluar sebagai kontrak yang bisa diandalkan skrip.
const (
	ExitOK        = 0
	ExitError     = 1
	ExitUsage     = 2
	ExitNotFound  = 4
)

// Produk adalah tipe domain — tidak tahu apa-apa soal CLI.
type Product struct {
	SKU   string `json:"sku"`
	Nama  string `json:"name"`
	Harga int64  `json:"harga"`
}

// OpsiList adalah parameter murni, tanpa jejak cobra.
type ListOpts struct {
	Tenant string
	Limit  int
}

// ErrTidakAda dikembalikan domain, dipetakan CLI menjadi kode keluar 4.
var ErrNotFound = errors.New("produk tidak ditemukan")

// Store adalah antarmuka domain — inilah yang dipalsukan saat menguji CLI.
type Store interface {
	ListProducts(ctx context.Context, o ListOpts) ([]Product, error)
}

// App menyatukan dependensi. Tidak ada satu pun variabel global.
type App struct {
	Store Store
}

// Opsi global yang diwarisi seluruh subperintah.
type rootOpts struct {
	verbose bool
	format  string // "table" atau "json"
}

// NewRootCmd membangun seluruh pohon perintah.
// Fungsi, bukan variabel paket — tiap test mendapat pohon yang bersih.
func NewRootCmd(app *App) *cobra.Command {
	o := &rootOpts{}

	root := &cobra.Command{
		Use:   "katalog",
		Short: "Kelola katalog produk",
		// SilenceUsage: jangan cetak halaman bantuan pada error RUNTIME.
		// Bantuan hanya relevan untuk kesalahan PEMAKAIAN.
		SilenceUsage: true,
		// SilenceErrors: kita mencetak error sendiri di Execute agar
		// formatnya konsisten dan kode keluarnya bisa dipetakan.
		SilenceErrors: true,
	}

	pf := root.PersistentFlags()
	pf.BoolVarP(&o.verbose, "verbose", "v", false, "log rinci ke stderr")
	pf.StringVar(&o.format, "format", "table", "format keluaran: table|json")

	root.AddCommand(newProdukCmd(app, o))
	return root
}

// newProdukCmd adalah grup kata benda; ia sendiri tidak melakukan apa-apa.
func newProdukCmd(app *App, o *rootOpts) *cobra.Command {
	c := &cobra.Command{
		Use:   "produk",
		Short: "Operasi pada produk",
	}
	c.AddCommand(newProdukListCmd(app, o))
	return c
}

func newProdukListCmd(app *App, o *rootOpts) *cobra.Command {
	var opts ListOpts

	c := &cobra.Command{
		Use:   "list",
		Short: "Tampilkan produk",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// cmd.Context() membawa context yang dipasang di ExecuteContext,
			// sehingga Ctrl-C merambat sampai ke query database.
			ctx := cmd.Context()

			if o.verbose {
				fmt.Fprintf(cmd.ErrOrStderr(), "mengambil produk tenant=%q limit=%d\n",
					opts.Tenant, opts.Limit)
			}

			// Satu panggilan ke domain. Tidak ada logika bisnis di sini.
			items, err := app.Store.ListProducts(ctx, opts)
			if err != nil {
				return err
			}
			return writeProducts(cmd.OutOrStdout(), items, o.format)
		},
	}

	f := c.Flags()
	f.StringVar(&opts.Tenant, "tenant", "", "saring berdasarkan tenant")
	f.IntVar(&opts.Limit, "limit", 50, "jumlah maksimum lines")
	return c
}

// tulisProduk memformat keluaran. Menerima io.Writer, bukan menulis ke
// os.Stdout langsung — inilah yang membuatnya bisa diuji.
func writeProducts(w io.Writer, items []Product, format string) error {
	switch format {
	case "json":
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(items)
	case "table":
		tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "SKU\tNAMA\tHARGA")
		for _, p := range items {
			fmt.Fprintf(tw, "%s\t%s\t%d\n", p.SKU, p.Nama, p.Harga)
		}
		return tw.Flush()
	default:
		return fmt.Errorf("%w: unknown format %q", errUsage, format)
	}
}

// errPemakaian menandai kesalahan yang layak kode keluar 2.
var errUsage = errors.New("usage error")

// Execute menjalankan CLI dan memetakan error ke kode keluar.
// Inilah SATU-SATUNYA tempat os.Exit boleh muncul.
func Execute(app *App) int {
	// Ctrl-C dan SIGTERM membatalkan context, bukan membunuh proses mentah.
	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	root := NewRootCmd(app)
	err := root.ExecuteContext(ctx)
	if err == nil {
		return ExitOK
	}

	fmt.Fprintf(os.Stderr, "katalog: %v\n", err)

	switch {
	case errors.Is(err, context.Canceled):
		return 130 // konvensi: dihentikan sinyal
	case errors.Is(err, errUsage):
		return ExitUsage
	case errors.Is(err, ErrNotFound):
		return ExitNotFound
	default:
		return ExitError
	}
}
```

`main.go` tetap sekecil mungkin:

```go
package main

import (
	"os"

	"example.com/katalog/internal/cli"
	"example.com/katalog/internal/store"
)

func main() {
	app := &cli.App{Store: store.NewPostgres(os.Getenv("DSN"))}
	os.Exit(cli.Execute(app)) // satu-satunya os.Exit di seluruh program
}
```

## Uji

```go
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// storePalsu menggantikan database. Karena CLI hanya bergantung pada
// antarmuka Store, tidak ada satu pun test yang butuh koneksi nyata.
type fakeStore struct {
	items []Product
	err   error
	opts  ListOpts // merekam apa yang diterima domain
}

func (s *fakeStore) ListProducts(_ context.Context, o ListOpts) ([]Product, error) {
	s.opts = o
	return s.items, s.err
}

// jalankan menjalankan CLI dengan argumen tertentu dan menangkap keluarannya.
func run(t *testing.T, app *App, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	root := NewRootCmd(app)
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}

func TestProductList_FormatTable(t *testing.T) {
	app := &App{Store: &fakeStore{items: []Product{
		{SKU: "A-1", Nama: "Apel", Harga: 12000},
	}}}
	out, _, err := run(t, app, "produk", "list")
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if !strings.Contains(out, "A-1") || !strings.Contains(out, "Apel") {
		t.Fatalf("keluaran tidak loading data: %q", out)
	}
}

func TestProductList_FormatJSON(t *testing.T) {
	app := &App{Store: &fakeStore{items: []Product{
		{SKU: "A-1", Nama: "Apel", Harga: 12000},
	}}}
	out, _, err := run(t, app, "produk", "list", "--format", "json")
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	var got []Product
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("keluaran bukan JSON valid: %v\n%s", err, out)
	}
	if len(got) != 1 || got[0].SKU != "A-1" {
		t.Fatalf("content JSON salah: %+v", got)
	}
}

func TestProductList_FlagDiteruskanKeDomain(t *testing.T) {
	s := &fakeStore{}
	app := &App{Store: s}
	if _, _, err := run(t, app, "produk", "list", "--tenant", "acme", "--limit", "7"); err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if s.opts.Tenant != "acme" || s.opts.Limit != 7 {
		t.Fatalf("opts tidak diteruskan: %+v", s.opts)
	}
}

func TestVerbose_ToStderrNotStdout(t *testing.T) {
	// Ini menjaga kontrak pipeline: stdout HANYA data.
	app := &App{Store: &fakeStore{items: []Product{{SKU: "A-1"}}}}
	out, errOut, err := run(t, app, "produk", "list", "--verbose", "--format", "json")
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	if !strings.Contains(errOut, "mengambil produk") {
		t.Fatalf("log verbose harus di stderr, stderr=%q", errOut)
	}
	if strings.Contains(out, "mengambil produk") {
		t.Fatalf("log BOCOR ke stdout, merusak `| jq`: %q", out)
	}
}

func TestUnknownFormat_UsageExitCode(t *testing.T) {
	app := &App{Store: &fakeStore{}}
	_, _, err := run(t, app, "produk", "list", "--format", "xml")
	if !errors.Is(err, errUsage) {
		t.Fatalf("mau errUsage, dapat %v", err)
	}
}

func TestDomainError_MappedToExitCode(t *testing.T) {
	app := &App{Store: &fakeStore{err: ErrNotFound}}
	_, _, err := run(t, app, "produk", "list")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("mau ErrNotFound, dapat %v", err)
	}
}

func TestExtraArgs_Rejected(t *testing.T) {
	app := &App{Store: &fakeStore{}}
	if _, _, err := run(t, app, "produk", "list", "argumen-liar"); err == nil {
		t.Fatal("cobra.NoArgs seharusnya menolak argumen tambahan")
	}
}
```

## Anti-Pattern

**❌ SALAH — logika bisnis dan `os.Exit` di dalam `RunE`**

```go
var dsn string // variabel global, bocor antar-test

var listCmd = &cobra.Command{
	Use: "list",
	Run: func(cmd *cobra.Command, args []string) {
		db, err := sql.Open("pgx", dsn)
		if err != nil {
			fmt.Println("failed:", err) // ke stdout, merusak pipeline
			os.Exit(1)                 // defer di atas TIDAK jalan
		}
		defer db.Close() // tidak pernah tercapai bila error di bawah
		rows, _ := db.Query(`SELECT sku, name FROM produk`)
		for rows.Next() { /* ... */ }
	},
}
```

Empat cacat sekaligus: variabel global, logika bisnis di lapisan CLI, error ke stdout, dan `os.Exit` yang melewati `defer`. Tidak ada satu pun bagian yang bisa diuji tanpa database sungguhan.

**✅ BENAR — adaptor tipis, error dikembalikan**

Lihat `newProdukListCmd` di atas: baca flag → panggil domain → format ke `cmd.OutOrStdout()`. `os.Exit` hanya ada satu, di `main`.

**❌ SALAH — pohon perintah datar**

```text
app list-produk    app create-produk    app delete-produk
app list-order     app create-order     app refund-order
```

Pada 40 perintah, `app --help` menjadi dinding teks. Pengguna tidak bisa menemukan apa pun.

**✅ BENAR — dikelompokkan per kata benda**

```text
app produk list      app produk create      app produk delete
app order list       app order refund
```

`app produk --help` menampilkan tepat yang dibutuhkan.

**❌ SALAH — `fmt.Println` langsung**

```go
fmt.Println("Memproses...")   // ke stdout, merusak `app list | jq`
fmt.Printf("%v\n", result)     // tidak bisa ditangkap test
```

**✅ BENAR — selalu lewat writer perintah**

```go
fmt.Fprintln(cmd.ErrOrStderr(), "Memproses...")  // progres -> stderr
fmt.Fprintf(cmd.OutOrStdout(), "%v\n", result)    // data -> stdout
```

## Kasus Tepi Produksi

1. **Ctrl-C saat operasi panjang berjalan.** Tanpa `signal.NotifyContext` + `ExecuteContext`, proses mati seketika: transaksi menggantung, berkas separuh tertulis. Dengan keduanya, `cmd.Context()` dibatalkan dan query DB ikut berhenti rapi. Kode keluar `130` adalah konvensi untuk terminasi oleh sinyal.

2. **Keluaran diarahkan ke pipe yang tertutup.** `app list | head -5` menyebabkan `SIGPIPE`. Di Go, tulisan ke pipe tertutup mengembalikan error, bukan sinyal. Jangan perlakukan `EPIPE` sebagai kegagalan — periksa `errors.Is(err, syscall.EPIPE)` dan keluar dengan tenang.

3. **Tabrakan nama flag antara persistent dan lokal.** Bila root punya `--format` persistent dan subperintah mendefinisikan `--format` sendiri, yang lokal menang secara diam-diam. Tidak ada peringatan. Sepakati sejak awal flag mana yang milik root, dan jangan mendefinisikannya ulang.

4. **Bantuan yang muncul saat kegagalan runtime.** Tanpa `SilenceUsage: true`, kegagalan koneksi database akan mencetak seluruh halaman bantuan setelah pesan error — membingungkan dan menyembunyikan pesan sesungguhnya. Bantuan hanya untuk kesalahan pemakaian.

5. **Alat yang dipakai di dalam skrip CI.** Kode keluar WAJIB stabil lintas versi. Menambah kode keluar baru itu aman; mengubah makna kode yang sudah ada adalah perubahan yang memutus kompatibilitas dan akan merusak pipeline orang lain diam-diam.

6. **Shell completion yang basi.** `cobra` menghasilkan completion dari pohon perintah saat itu. Bila didistribusikan sebagai berkas statis, completion akan tertinggal setelah perintah baru ditambahkan. Hasilkan saat instalasi, bukan saat rilis.

## Kapan JANGAN Pakai Ini

- **Alat satu tujuan tanpa subperintah.** Paket `flag` di stdlib sudah cukup dan menghemat satu dependensi. Cobra baru menghasilkan nilai saat ada hierarki perintah.
- **Ketika yang Anda buat sebenarnya pustaka.** Kalau logikanya berguna di luar terminal, tulis paket dulu, CLI belakangan sebagai pembungkus tipis. Kebalikannya selalu menyakitkan.
- **Untuk skrip internal sekali pakai.** Sebuah `.sh` sepuluh baris tidak perlu jadi CLI Go dengan struktur perintah.
- **Sebagai antarmuka utama untuk operasi interaktif panjang.** Bila alur kerjanya penuh pilihan bertahap, pertimbangkan TUI — lihat `cli_tooling/tui_bubbletea_interactive.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `app list \| jq` gagal mengurai | jalankan dengan `2>/dev/null` | Log bocor ke stdout; pisahkan aliran |
| Skrip CI tidak mendeteksi kegagalan | `echo $?` setelah perintah gagal | Kode keluar selalu 0; `Run` dipakai, bukan `RunE` |
| Ctrl-C meninggalkan transaksi menggantung | `pg_stat_activity` setelah membatalkan | Context tidak diteruskan; pakai `ExecuteContext` |
| Test CLI butuh database | jumlah test yang gagal tanpa jaringan | Logika bisnis ada di `RunE`; pindahkan ke domain |
| `--help` panjangnya berlembar | `app --help \| wc -l` | Pohon datar; kelompokkan per kata benda |

```bash
# Kode keluar benar-benar dipetakan?
app produk list --format xml; echo "keluar: $?"   # harap 2
app produk list --tenant tidak-ada; echo "keluar: $?"  # harap 4

# stdout benar-benar bersih?
app produk list --verbose --format json 2>/dev/null | jq . >/dev/null && echo "stdout bersih"

# Cari os.Exit yang tersembunyi di luar main
grep -rn "os.Exit" --include="*.go" internal/ | grep -v "_test.go"

# Cari fmt.Print yang tidak lewat writer perintah
grep -rn "fmt.Print\(ln\|f\)\?(" --include="*.go" internal/cli/ | grep -v Fprint
```
