# TUI Interaktif — Bubble Tea & Kapan TUI Justru Salah

> **Berlaku:** Go 1.21+ · `charmbracelet/bubbletea` v1.x · **Lihat juga:** `cli_tooling/cobra_command_architecture.md` · `cli_tooling/cli_testing_golden_files.md` · `concurrency/context_cancellation_timeout.md`

## Konsep Utama

TUI menggoda karena terlihat canggih. Tapi keputusan pertama yang WAJIB diambil bukan "pakai pustaka apa" melainkan **"apakah ini memang butuh TUI?"** — dan jawabannya lebih sering "tidak" daripada yang dikira.

TUI memiliki satu kelemahan struktural yang tidak bisa dihilangkan: **ia tidak bisa dipakai dalam pipeline, tidak bisa diotomatiskan, dan tidak bisa dijalankan di CI.** Setiap alur kerja yang hanya tersedia lewat TUI adalah alur kerja yang tidak bisa di-script oleh pengguna Anda.

| Cocok TUI | Cocok CLI biasa |
| :--- | :--- |
| Menjelajah data yang tidak diketahui bentuknya (`k9s`, `lazygit`) | Operasi dengan masukan yang sudah jelas |
| Memantau keadaan yang berubah terus | Sekali jalan lalu selesai |
| Alur bertahap yang butuh keputusan di tengah | Apa pun yang akan dipanggil dari skrip |
| Memilih dari daftar besar secara visual | Keluaran yang akan di-pipe |

**Aturan yang menyelamatkan:** setiap kemampuan yang ada di TUI WAJIB juga tersedia sebagai perintah non-interaktif. TUI adalah lapisan kenyamanan di atas perintah, bukan penggantinya.

### Arsitektur Elm — kenapa bentuknya begitu

Bubble Tea memakai pola Elm: satu keadaan, satu fungsi pembaruan, satu fungsi tampilan.

```
        Msg (peristiwa)
             |
             v
   Model --> Update(msg) --> (Model baru, Cmd)
     ^                            |
     |                            v
     +------- View() <------  efek samping
              string          menghasilkan Msg berikutnya
```

Tiga aturan yang menentukan TUI Anda bisa diuji atau tidak:

| Aturan | Alasan |
| :--- | :--- |
| `Update` WAJIB murni | Tanpa I/O, tanpa waktu, tanpa jaringan. Bisa diuji sebagai fungsi biasa. |
| Efek samping WAJIB lewat `tea.Cmd` | `Cmd` adalah fungsi yang mengembalikan `Msg`; ia dijalankan runtime, bukan oleh `Update`. |
| `View` WAJIB tanpa efek samping | Hanya memetakan keadaan ke string. |

Pelanggaran paling umum: memanggil HTTP langsung di dalam `Update`. Akibatnya UI membeku selama request berjalan, dan `Update` jadi mustahil diuji tanpa jaringan.

## Diagram ASCII

```text
   ALUR BUBBLE TEA — di mana I/O boleh terjadi

   +------------------+
   |  tea.Program     |  runtime: baca keyboard, gambar layar
   +--------+---------+
            |  Msg (KeyMsg, WindowSizeMsg, MsgKustom)
            v
   +------------------+
   |  Update(msg)     |  MURNI. Tanpa I/O. Bisa diuji langsung.
   |                  |
   |  return model,   |
   |         tea.Cmd  ---------> dijalankan RUNTIME di goroutine terpisah
   +--------+---------+                    |
            |                              | menghasilkan
            v                              v
   +------------------+              Msg berikutnya
   |  View() string   |              (dikirim balik ke Update)
   +------------------+

   I/O HANYA boleh di dalam tea.Cmd. Di Update = UI membeku.

   ---------------------------------------------------------------

   TUI SEBAGAI LAPISAN, BUKAN PENGGANTI

   pengguna manusia          skrip / CI
        |                        |
        v                        v
   +---------+            +--------------+
   |   TUI   |            | perintah CLI |
   +----+----+            +------+-------+
        |                        |
        +-----------+------------+
                    v
            +---------------+
            |  DOMAIN       |  satu implementasi, dua antarmuka
            +---------------+

   Bila sebuah kemampuan hanya ada di kotak kiri, pengguna Anda
   tidak bisa mengotomatiskannya. Itu cacat, bukan fitur.
```

## Kode Go Production-Ready

Pemilih produk interaktif — dengan pemuatan data lewat `tea.Cmd`, bukan di dalam `Update`.

```go
package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Produk adalah tipe domain.
type Product struct {
	SKU   string
	Nama  string
	Harga int64
}

// Pemuat adalah antarmuka domain — dipalsukan saat menguji.
type Loader interface {
	Search(ctx context.Context, query string) ([]Product, error)
}

// Pesan kustom yang mengalir kembali ke Update.
type (
	msgResult struct{ items []Product }
	msgFail struct{ err error }
)

// Model adalah seluruh keadaan TUI. Tidak ada variabel global.
type Model struct {
	pemuat  Loader
	ctx     context.Context

	query    string
	items   []Product
	cursor  int
	loading  bool
	err     error
	selected *Product

	width int
}

// New membuat model awal.
func New(ctx context.Context, p Loader) Model {
	return Model{pemuat: p, ctx: ctx, width: 80}
}

// Init dipanggil sekali saat program mulai.
func (m Model) Init() tea.Cmd { return m.searchCmd("") }

// cariCmd membungkus pemanggilan domain sebagai tea.Cmd.
// Fungsi ini dijalankan runtime di goroutine terpisah, sehingga UI
// tetap responsif. INILAH satu-satunya tempat I/O boleh terjadi.
func (m Model) searchCmd(query string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
		defer cancel()

		items, err := m.pemuat.Search(ctx, query)
		if err != nil {
			return msgFail{err}
		}
		return msgResult{items}
	}
}

// Update MURNI: tidak memanggil jaringan, tidak menyentuh waktu nyata.
// Seluruh perilakunya bisa diuji dengan memanggil fungsi ini langsung.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil
		case "down", "j":
			if m.cursor < len(m.items)-1 {
				m.cursor++
			}
			return m, nil
		case "enter":
			if len(m.items) > 0 {
				p := m.items[m.cursor]
				m.selected = &p
				return m, tea.Quit
			}
			return m, nil
		case "backspace":
			if len(m.query) > 0 {
				m.query = m.query[:len(m.query)-1]
				m.loading = true
				return m, m.searchCmd(m.query)
			}
			return m, nil
		default:
			// Hanya karakter tercetak tunggal yang dianggap ketikan.
			if len(msg.String()) == 1 {
				m.query += msg.String()
				m.loading = true
				return m, m.searchCmd(m.query)
			}
			return m, nil
		}

	case msgResult:
		m.items = msg.items
		m.loading = false
		m.err = nil
		// Kursor WAJIB dijepit — hasil baru bisa lebih pendek.
		if m.cursor >= len(m.items) {
			m.cursor = max(0, len(m.items)-1)
		}
		return m, nil

	case msgFail:
		m.err = msg.err
		m.loading = false
		return m, nil
	}
	return m, nil
}

// View memetakan keadaan ke string. Tanpa efek samping.
func (m Model) View() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Search: %s\n\n", m.query)

	switch {
	case m.err != nil:
		fmt.Fprintf(&b, "  failed: %v\n", m.err)
	case m.loading:
		b.WriteString("  loading...\n")
	case len(m.items) == 0:
		b.WriteString("  no results\n")
	default:
		for i, p := range m.items {
			penanda := "  "
			if i == m.cursor {
				penanda = "> "
			}
			fmt.Fprintf(&b, "%s%-10s %-24s %d\n", penanda, p.SKU, truncate(p.Nama, 24), p.Harga)
		}
	}
	b.WriteString("\n  ↑/↓ pilih · enter ambil · esc keluar\n")
	return b.String()
}

// Terpilih mengembalikan produk yang dipilih pengguna, bila ada.
func (m Model) Terpilih() (Product, bool) {
	if m.selected == nil {
		return Product{}, false
	}
	return *m.selected, true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// ErrBukanTerminal dikembalikan bila TUI dijalankan tanpa TTY.
var ErrNotTerminal = errors.New("tui: butuh terminal interaktif")

// Jalankan menjalankan TUI dan mengembalikan pilihan pengguna.
func Run(ctx context.Context, p Loader) (Product, bool, error) {
	prog := tea.NewProgram(New(ctx, p))
	akhir, err := prog.Run()
	if err != nil {
		return Product{}, false, fmt.Errorf("run tui: %w", err)
	}
	m, ok := akhir.(Model)
	if !ok {
		return Product{}, false, errors.New("tui: model akhir bertipe tak terduga")
	}
	pr, dipilih := m.Terpilih()
	return pr, dipilih, nil
}
```

Menyambungkannya ke cobra dengan penjagaan TTY:

```go
func newPilihCmd(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "pilih",
		Short: "Pilih produk secara interaktif",
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Tanpa TTY, arahkan pengguna ke perintah non-interaktif.
			// DILARANG menjalankan TUI di pipeline — ia akan menggantung.
			if !term.IsTerminal(int(os.Stdin.Fd())) {
				return fmt.Errorf("%w: pakai `katalog produk list` untuk mode skrip",
					tui.ErrNotTerminal)
			}
			p, ok, err := tui.Run(cmd.Context(), app.Store)
			if err != nil {
				return err
			}
			if !ok {
				return nil // pengguna membatalkan; bukan error
			}
			fmt.Fprintln(cmd.OutOrStdout(), p.SKU)
			return nil
		},
	}
}
```

## Uji

```go
package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

type fakeLoader struct {
	items []Product
	err   error
	query  string
}

func (p *fakeLoader) Search(_ context.Context, query string) ([]Product, error) {
	p.query = query
	return p.items, p.err
}

func testModel(items ...Product) Model {
	m := New(context.Background(), &fakeLoader{items: items})
	m.items = items
	return m
}

// tekan mengirim satu tombol ke Update. Karena Update murni,
// seluruh perilaku TUI bisa diuji tanpa terminal sama sekali.
func press(m Model, k string) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
	return next.(Model), cmd
}

func pressSpecial(m Model, t tea.KeyType) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.KeyMsg{Type: t})
	return next.(Model), cmd
}

func TestNavigation_KursorTidakKeluarBatas(t *testing.T) {
	m := testModel(Product{SKU: "A"}, Product{SKU: "B"})

	m, _ = pressSpecial(m, tea.KeyUp) // sudah di atas
	if m.cursor != 0 {
		t.Fatalf("cursor mau 0, dapat %d", m.cursor)
	}
	m, _ = pressSpecial(m, tea.KeyDown)
	m, _ = pressSpecial(m, tea.KeyDown) // sudah di bawah
	if m.cursor != 1 {
		t.Fatalf("cursor mau 1, dapat %d", m.cursor)
	}
}

func TestResultLebihPendek_KursorDijepit(t *testing.T) {
	// Bug klasik: mengetik menyaring hasil, kursor menunjuk indeks yang hilang.
	m := testModel(Product{SKU: "A"}, Product{SKU: "B"}, Product{SKU: "C"})
	m.cursor = 2

	next, _ := m.Update(msgResult{items: []Product{{SKU: "A"}}})
	m = next.(Model)
	if m.cursor != 0 {
		t.Fatalf("cursor harus dijepit ke 0, dapat %d", m.cursor)
	}
}

func TestType_MemicuPencarian(t *testing.T) {
	m := testModel()
	m, cmd := press(m, "a")
	if m.query != "a" {
		t.Fatalf("query mau %q, dapat %q", "a", m.query)
	}
	if !m.loading {
		t.Fatal("mengetik harus menandai sedang loading")
	}
	if cmd == nil {
		t.Fatal("mengetik harus mengembalikan Cmd pencarian")
	}
}

func TestEnter_SelectsAndExits(t *testing.T) {
	m := testModel(Product{SKU: "A-1", Nama: "Apel"})
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)

	p, ok := m.Terpilih()
	if !ok || p.SKU != "A-1" {
		t.Fatalf("mau A-1 selected, dapat %+v ok=%v", p, ok)
	}
}

func TestEnterWhenEmpty_TidakPanic(t *testing.T) {
	m := testModel()
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := next.(Model).Terpilih(); ok {
		t.Fatal("tidak boleh ada yang selected saat daftar empty")
	}
}

func TestFail_DitampilkanBukanPanic(t *testing.T) {
	m := testModel()
	next, _ := m.Update(msgFail{errors.New("connection lost")})
	m = next.(Model)
	if !strings.Contains(m.View(), "connection lost") {
		t.Fatalf("error must be visible in View:\n%s", m.View())
	}
	if m.loading {
		t.Fatal("loading status must be turned off after failure")
	}
}

func TestView_MarksSelectedLine(t *testing.T) {
	m := testModel(Product{SKU: "A"}, Product{SKU: "B"})
	m.cursor = 1
	v := m.View()
	if !strings.Contains(v, "> B") {
		t.Fatalf("lines aktif harus ditandai:\n%s", v)
	}
}
```

## Anti-Pattern

**❌ SALAH — I/O di dalam `Update`**

```go
case tea.KeyMsg:
	if msg.String() == "enter" {
		resp, err := http.Get("https://api/produk") // UI MEMBEKU di sini
		defer resp.Body.Close()
		json.NewDecoder(resp.Body).Decode(&m.items)
		return m, nil
	}
```

Selama request berjalan, TUI tidak menggambar ulang dan tidak merespons Ctrl-C. Pengguna mengira alatnya hang. Dan `Update` sekarang mustahil diuji tanpa jaringan.

**✅ BENAR — I/O dibungkus `tea.Cmd`**

```go
case tea.KeyMsg:
	if msg.String() == "enter" {
		m.loading = true
		return m, m.searchCmd(m.query) // dijalankan runtime, UI tetap hidup
	}
```

**❌ SALAH — TUI sebagai satu-satunya jalan**

```text
$ katalog pilih    # hanya interaktif
# Pengguna ingin memakainya di skrip: mustahil.
```

**✅ BENAR — TUI di atas perintah yang tetap ada**

```bash
katalog produk list --format json | jq '.[0].sku'   # untuk skrip
katalog pilih                                        # untuk manusia
```

**❌ SALAH — TUI dijalankan tanpa memeriksa TTY**

```go
prog := tea.NewProgram(New(ctx, store))
prog.Run() // di pipeline: menggantung selamanya atau merusak keluaran
```

Di CI, ini membuat job menggantung sampai timeout tanpa pesan yang berguna.

**✅ BENAR — periksa TTY dan arahkan ke alternatif**

Lihat `newPilihCmd` di atas: bila bukan terminal, kembalikan error yang **menyebutkan perintah penggantinya**.

## Kasus Tepi Produksi

1. **Terminal diubah ukurannya saat TUI berjalan.** `tea.WindowSizeMsg` datang setiap kali; tata letak WAJIB dihitung dari `msg.Width`, bukan konstanta. Layout dengan lebar tetap akan rusak berantakan di terminal sempit — dan ini kondisi normal, bukan kasus langka.

2. **Terminal keluar dalam keadaan rusak.** Bila program panic di tengah mode raw, terminal pengguna tertinggal tanpa echo dan tanpa kursor. Bubble Tea memulihkannya pada keluar normal, tapi panic bisa melewatinya — pasang `recover` di level `Jalankan`, atau setidaknya dokumentasikan `reset` sebagai jalan keluar.

3. **Karakter lebar ganda dan emoji.** `len(string)` menghitung byte, bukan kolom terminal. Nama produk dengan aksara CJK atau emoji akan merusak perataan kolom. Pakai pustaka pengukur lebar (`go-runewidth`) bila keluaran Anda menerima teks bebas dari pengguna.

4. **Ctrl-C saat operasi latar berjalan.** `tea.Quit` menghentikan UI, tapi `tea.Cmd` yang sedang berjalan tidak otomatis dibatalkan. Karena itu `cariCmd` di atas menurunkan `context` dari `m.ctx` — sehingga pembatalan merambat sampai ke query.

5. **Keluaran TUI diarahkan ke berkas.** `katalog pilih > out.txt` menghasilkan berkas berisi urutan escape ANSI, bukan data. Inilah alasan pemeriksaan TTY wajib ada di lapisan cobra, bukan di dalam TUI.

6. **Menguji `View` dengan golden file.** Mungkin, tapi rapuh — perubahan kosmetik kecil membuat semua golden gagal. Uji **keadaan** (kursor di mana, item apa yang terpilih) lebih dulu; golden hanya untuk beberapa tata letak kunci. Lihat `cli_tooling/cli_testing_golden_files.md`.

## Kapan JANGAN Pakai Ini

- **Untuk operasi yang masukannya sudah jelas.** Bila pengguna tahu SKU yang dimaksud, `katalog produk get A-1` lebih cepat daripada menjelajah daftar.
- **Apa pun yang akan dipanggil dari skrip atau CI.** TUI tidak bisa diotomatiskan. Titik.
- **Sebagai pengganti dokumentasi.** TUI cantik yang menyembunyikan model mental yang kacau tetap kacau. Perbaiki perintahnya dulu.
- **Ketika keluaran perlu dibaca mesin.** Tabel berwarna tidak bisa di-`jq`.
- **Untuk alat yang jarang dipakai.** Pengguna tidak akan mengingat pintasan tombol yang dipakai sebulan sekali; perintah eksplisit lebih mudah diingat lewat `--help`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Job CI menggantung sampai timeout | perintah terakhir sebelum menggantung | TUI dijalankan tanpa TTY; pemeriksaan terminal hilang |
| Berkas keluaran penuh karakter aneh | `cat -v out.txt` | Escape ANSI ikut tertulis; pisahkan mode interaktif |
| Pengguna mengeluh alat "hang" | apakah ada I/O di dalam `Update` | UI membeku selama request; pindahkan ke `tea.Cmd` |
| Kolom berantakan pada data tertentu | data dengan emoji atau aksara CJK | Lebar dihitung per byte, bukan per kolom |
| Terminal rusak setelah alat crash | apakah ada `recover` di sekitar `Run` | Mode raw tidak dipulihkan saat panic |

```bash
# Apakah alat memeriksa TTY?
katalog pilih < /dev/null; echo "keluar: $?"   # harus gagal cepat, bukan menggantung

# Cari I/O di dalam Update — pelanggaran arsitektur Elm
grep -n "http\.\|sql\.\|os.ReadFile\|time.Sleep" internal/tui/*.go \
  | grep -v "_test.go" | grep -v "func.*Cmd"

# Pastikan setiap kemampuan TUI punya padanan non-interaktif
katalog --help | grep -A100 'Available Commands'
```
