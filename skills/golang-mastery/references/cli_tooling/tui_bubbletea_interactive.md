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
type Produk struct {
	SKU   string
	Nama  string
	Harga int64
}

// Pemuat adalah antarmuka domain — dipalsukan saat menguji.
type Pemuat interface {
	Cari(ctx context.Context, kata string) ([]Produk, error)
}

// Pesan kustom yang mengalir kembali ke Update.
type (
	msgHasil struct{ items []Produk }
	msgGagal struct{ err error }
)

// Model adalah seluruh keadaan TUI. Tidak ada variabel global.
type Model struct {
	pemuat  Pemuat
	ctx     context.Context

	kata    string
	items   []Produk
	kursor  int
	memuat  bool
	err     error
	terpilih *Produk

	lebar int
}

// New membuat model awal.
func New(ctx context.Context, p Pemuat) Model {
	return Model{pemuat: p, ctx: ctx, lebar: 80}
}

// Init dipanggil sekali saat program mulai.
func (m Model) Init() tea.Cmd { return m.cariCmd("") }

// cariCmd membungkus pemanggilan domain sebagai tea.Cmd.
// Fungsi ini dijalankan runtime di goroutine terpisah, sehingga UI
// tetap responsif. INILAH satu-satunya tempat I/O boleh terjadi.
func (m Model) cariCmd(kata string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
		defer cancel()

		items, err := m.pemuat.Cari(ctx, kata)
		if err != nil {
			return msgGagal{err}
		}
		return msgHasil{items}
	}
}

// Update MURNI: tidak memanggil jaringan, tidak menyentuh waktu nyata.
// Seluruh perilakunya bisa diuji dengan memanggil fungsi ini langsung.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.lebar = msg.Width
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "up", "k":
			if m.kursor > 0 {
				m.kursor--
			}
			return m, nil
		case "down", "j":
			if m.kursor < len(m.items)-1 {
				m.kursor++
			}
			return m, nil
		case "enter":
			if len(m.items) > 0 {
				p := m.items[m.kursor]
				m.terpilih = &p
				return m, tea.Quit
			}
			return m, nil
		case "backspace":
			if len(m.kata) > 0 {
				m.kata = m.kata[:len(m.kata)-1]
				m.memuat = true
				return m, m.cariCmd(m.kata)
			}
			return m, nil
		default:
			// Hanya karakter tercetak tunggal yang dianggap ketikan.
			if len(msg.String()) == 1 {
				m.kata += msg.String()
				m.memuat = true
				return m, m.cariCmd(m.kata)
			}
			return m, nil
		}

	case msgHasil:
		m.items = msg.items
		m.memuat = false
		m.err = nil
		// Kursor WAJIB dijepit — hasil baru bisa lebih pendek.
		if m.kursor >= len(m.items) {
			m.kursor = max(0, len(m.items)-1)
		}
		return m, nil

	case msgGagal:
		m.err = msg.err
		m.memuat = false
		return m, nil
	}
	return m, nil
}

// View memetakan keadaan ke string. Tanpa efek samping.
func (m Model) View() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Cari: %s\n\n", m.kata)

	switch {
	case m.err != nil:
		fmt.Fprintf(&b, "  gagal: %v\n", m.err)
	case m.memuat:
		b.WriteString("  memuat...\n")
	case len(m.items) == 0:
		b.WriteString("  tidak ada hasil\n")
	default:
		for i, p := range m.items {
			penanda := "  "
			if i == m.kursor {
				penanda = "> "
			}
			fmt.Fprintf(&b, "%s%-10s %-24s %d\n", penanda, p.SKU, potong(p.Nama, 24), p.Harga)
		}
	}
	b.WriteString("\n  ↑/↓ pilih · enter ambil · esc keluar\n")
	return b.String()
}

// Terpilih mengembalikan produk yang dipilih pengguna, bila ada.
func (m Model) Terpilih() (Produk, bool) {
	if m.terpilih == nil {
		return Produk{}, false
	}
	return *m.terpilih, true
}

func potong(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// ErrBukanTerminal dikembalikan bila TUI dijalankan tanpa TTY.
var ErrBukanTerminal = errors.New("tui: butuh terminal interaktif")

// Jalankan menjalankan TUI dan mengembalikan pilihan pengguna.
func Jalankan(ctx context.Context, p Pemuat) (Produk, bool, error) {
	prog := tea.NewProgram(New(ctx, p))
	akhir, err := prog.Run()
	if err != nil {
		return Produk{}, false, fmt.Errorf("jalankan tui: %w", err)
	}
	m, ok := akhir.(Model)
	if !ok {
		return Produk{}, false, errors.New("tui: model akhir bertipe tak terduga")
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
					tui.ErrBukanTerminal)
			}
			p, ok, err := tui.Jalankan(cmd.Context(), app.Store)
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

type pemuatPalsu struct {
	items []Produk
	err   error
	kata  string
}

func (p *pemuatPalsu) Cari(_ context.Context, kata string) ([]Produk, error) {
	p.kata = kata
	return p.items, p.err
}

func modelUji(items ...Produk) Model {
	m := New(context.Background(), &pemuatPalsu{items: items})
	m.items = items
	return m
}

// tekan mengirim satu tombol ke Update. Karena Update murni,
// seluruh perilaku TUI bisa diuji tanpa terminal sama sekali.
func tekan(m Model, k string) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
	return next.(Model), cmd
}

func tekanKhusus(m Model, t tea.KeyType) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.KeyMsg{Type: t})
	return next.(Model), cmd
}

func TestNavigasi_KursorTidakKeluarBatas(t *testing.T) {
	m := modelUji(Produk{SKU: "A"}, Produk{SKU: "B"})

	m, _ = tekanKhusus(m, tea.KeyUp) // sudah di atas
	if m.kursor != 0 {
		t.Fatalf("kursor mau 0, dapat %d", m.kursor)
	}
	m, _ = tekanKhusus(m, tea.KeyDown)
	m, _ = tekanKhusus(m, tea.KeyDown) // sudah di bawah
	if m.kursor != 1 {
		t.Fatalf("kursor mau 1, dapat %d", m.kursor)
	}
}

func TestHasilLebihPendek_KursorDijepit(t *testing.T) {
	// Bug klasik: mengetik menyaring hasil, kursor menunjuk indeks yang hilang.
	m := modelUji(Produk{SKU: "A"}, Produk{SKU: "B"}, Produk{SKU: "C"})
	m.kursor = 2

	next, _ := m.Update(msgHasil{items: []Produk{{SKU: "A"}}})
	m = next.(Model)
	if m.kursor != 0 {
		t.Fatalf("kursor harus dijepit ke 0, dapat %d", m.kursor)
	}
}

func TestKetik_MemicuPencarian(t *testing.T) {
	m := modelUji()
	m, cmd := tekan(m, "a")
	if m.kata != "a" {
		t.Fatalf("kata mau %q, dapat %q", "a", m.kata)
	}
	if !m.memuat {
		t.Fatal("mengetik harus menandai sedang memuat")
	}
	if cmd == nil {
		t.Fatal("mengetik harus mengembalikan Cmd pencarian")
	}
}

func TestEnter_MemilihDanKeluar(t *testing.T) {
	m := modelUji(Produk{SKU: "A-1", Nama: "Apel"})
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)

	p, ok := m.Terpilih()
	if !ok || p.SKU != "A-1" {
		t.Fatalf("mau A-1 terpilih, dapat %+v ok=%v", p, ok)
	}
}

func TestEnterSaatKosong_TidakPanic(t *testing.T) {
	m := modelUji()
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := next.(Model).Terpilih(); ok {
		t.Fatal("tidak boleh ada yang terpilih saat daftar kosong")
	}
}

func TestGagal_DitampilkanBukanPanic(t *testing.T) {
	m := modelUji()
	next, _ := m.Update(msgGagal{errors.New("koneksi putus")})
	m = next.(Model)
	if !strings.Contains(m.View(), "koneksi putus") {
		t.Fatalf("error harus tampil di View:\n%s", m.View())
	}
	if m.memuat {
		t.Fatal("status memuat harus dimatikan setelah gagal")
	}
}

func TestView_MenandaiBarisTerpilih(t *testing.T) {
	m := modelUji(Produk{SKU: "A"}, Produk{SKU: "B"})
	m.kursor = 1
	v := m.View()
	if !strings.Contains(v, "> B") {
		t.Fatalf("baris aktif harus ditandai:\n%s", v)
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
		m.memuat = true
		return m, m.cariCmd(m.kata) // dijalankan runtime, UI tetap hidup
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
