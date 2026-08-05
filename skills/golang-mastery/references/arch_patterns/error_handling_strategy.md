# Strategi Error Handling di Go

> **Berlaku:** Go 1.20+ (`errors.Join`) · Go 1.21+ (`slog`) · **Lihat juga:** `arch_patterns/clean_hexagonal_architecture.md` · `microservices_grpc/rest_chi_middleware_stack.md` · `observability_resilience/structured_logging_zerolog.md` · `distributed_patterns_resilience/retry_backoff_jitter.md`

## Konsep Utama

Pertanyaan yang salah: "bagaimana cara membuat error di Go?" Pertanyaan yang benar: **"apa yang bisa dilakukan pemanggil dengan error ini?"**

Jawaban atas pertanyaan kedua menentukan bentuk error yang tepat, dan hanya ada tiga:

| Yang dibutuhkan pemanggil | Bentuk | Cara memeriksa |
| :--- | :--- | :--- |
| Membedakan **satu kondisi tertentu** | Sentinel: `var ErrTidakDitemukan = errors.New(...)` | `errors.Is` |
| Mengambil **data** dari error | Tipe: `type GalatValidasi struct{ Field, Aturan string }` | `errors.As` |
| Tidak perlu membedakan apa pun | Opaque: `fmt.Errorf("...: %w", err)` | tidak diperiksa, hanya dicatat |

Sebagian besar error di sistem sehat adalah **opaque**. Sentinel dan tipe kustom dibuat ketika ada kode yang benar-benar bercabang atasnya — bukan untuk berjaga-jaga.

### `%w` adalah komitmen API, bukan hiasan

Membungkus dengan `%w` membuat error di dalamnya **bisa diperiksa pemanggil**. Sejak saat itu, mengganti error dalam adalah perubahan yang merusak — meski tanda tangan fungsi tidak berubah dan kompilator diam.

```go
// Membungkus dengan %w = berjanji ErrNoRows terlihat pemanggil selamanya.
return fmt.Errorf("ambil pengguna: %w", sql.ErrNoRows)

// Membungkus dengan %v = detail masuk pesan, identitas TIDAK bocor keluar.
return fmt.Errorf("ambil pengguna: %v", err)
```

Aturannya: bungkus dengan `%w` hanya error yang **memang** ingin Anda jadikan bagian kontrak. Untuk error dari pustaka pihak ketiga dan driver database, terjemahkan ke error domain Anda sendiri — jika tidak, seluruh sistem jadi bergantung pada detail implementasi lapisan terdalam.

### Konteks ditambahkan sekali per lapisan, bukan per pemanggilan

```
repository:  fmt.Errorf("ambil pesanan %d: %w", id, err)
service:     fmt.Errorf("proses checkout: %w", err)
handler:     petakan ke status, catat sekali
```

Yang salah adalah mencatat **dan** mengembalikan di lapisan yang sama — satu kegagalan berakhir sebagai lima baris log yang terlihat seperti lima insiden.

### Panic bukan error

`panic` untuk **bug programmer** — invariant yang mustahil dilanggar bila kode benar: indeks di luar batas, nil yang seharusnya sudah divalidasi, `switch` yang kehabisan kasus. Keadaan yang **diharapkan terjadi** — berkas tidak ada, jaringan putus, input tidak valid — adalah error, selalu.

## Diagram ASCII

```text
   MEMILIH BENTUK ERROR -- ditentukan PEMANGGIL, bukan penulis

   Apakah ada kode yang akan bercabang atas error ini?
        |
        +-- tidak --> OPAQUE.  fmt.Errorf("konteks: %w", err)
        |                       (mayoritas kasus di sistem sehat)
        |
        `-- ya ---> Butuh DATA dari error-nya?
                        |
                        +-- tidak --> SENTINEL.   errors.Is(err, ErrX)
                        |             var ErrTidakDitemukan = errors.New(...)
                        |
                        `-- ya -----> TIPE.       errors.As(err, &v)
                                      type GalatValidasi struct{ Field string }

   ---------------------------------------------------------------

   ALIRAN KONTEKS -- satu lapisan, satu tambahan, satu pencatatan

   repository ---> "ambil pesanan 42: %w"      <- konteks teknis
        |
   service    ---> "proses checkout: %w"       <- konteks bisnis
        |
   handler    ---> petakan ke status + CATAT   <- berhenti di sini
        |
   klien      <--- pesan aman, tanpa detail internal

   Mencatat di setiap lapisan = satu kegagalan tampak sebagai
   lima insiden berbeda di dasbor.

   ---------------------------------------------------------------

   BATAS: apa yang boleh menyeberang keluar

           DALAM SISTEM              |        KE KLIEN
   ------------------------------    |    ------------------
   nama tabel, kolom, query SQL      |    kode galat stabil
   stack trace, path berkas          |    pesan yang bisa ditindaklanjuti
   alamat host internal              |    id korelasi
   identitas error pustaka           |    (tidak lebih)
```

## Kode Go Production-Ready

```go
package galat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
)

// ---------- 1. SENTINEL: kondisi yang dibedakan pemanggil ----------

var (
	// ErrTidakDitemukan dikembalikan ketika entitas yang diminta tidak ada.
	ErrTidakDitemukan = errors.New("entitas tidak ditemukan")
	// ErrKonflik menandakan pelanggaran keunikan atau kondisi balapan optimistic.
	ErrKonflik = errors.New("konflik keadaan")
	// ErrTidakBerwenang menandakan pemanggil terautentikasi tetapi tidak diizinkan.
	ErrTidakBerwenang = errors.New("tidak berwenang")
)

// ---------- 2. TIPE: error yang membawa data ----------

// GalatValidasi membawa field mana yang gagal dan aturan apa yang dilanggar,
// karena pemanggil (handler HTTP) perlu mengembalikannya ke klien per-field.
type GalatValidasi struct {
	Field  string
	Aturan string
	Nilai  any
}

func (g *GalatValidasi) Error() string {
	return fmt.Sprintf("validasi gagal pada %q: melanggar %s", g.Field, g.Aturan)
}

// GalatBanyakValidasi mengumpulkan beberapa kegagalan sekaligus.
// Pemanggil bisa mengambilnya utuh dengan errors.As, atau memeriksa
// salah satu isinya dengan errors.Is/As karena Unwrap mengembalikan slice.
type GalatBanyakValidasi struct {
	Galat []*GalatValidasi
}

func (g *GalatBanyakValidasi) Error() string {
	return fmt.Sprintf("%d field tidak valid", len(g.Galat))
}

// Unwrap dengan tanda tangan []error (Go 1.20+) membuat errors.Is dan
// errors.As menelusuri SELURUH isi, bukan hanya yang pertama.
func (g *GalatBanyakValidasi) Unwrap() []error {
	out := make([]error, len(g.Galat))
	for i, e := range g.Galat {
		out[i] = e
	}
	return out
}

// ---------- 3. TERJEMAHAN DI BATAS: jangan biarkan galat pustaka bocor ----------

// DariRepository menerjemahkan galat lapisan penyimpanan menjadi galat domain.
//
// Tanpa terjemahan ini, seluruh sistem menjadi bergantung pada detail
// implementasi database: mengganti pgx ke sesuatu yang lain akan memecahkan
// setiap `errors.Is(err, pgx.ErrNoRows)` yang tersebar di lapisan atas.
func DariRepository(err error, entitas string, id any) error {
	if err == nil {
		return nil
	}
	switch {
	// PENGECUALIAN yang wajib didahulukan: galat context TETAP dibungkus %w.
	//
	// Aturan "opaque-kan galat penyimpanan" benar untuk galat spesifik
	// driver, tetapi menerapkannya tanpa pengecualian ini menimbulkan bug
	// yang halus dan mahal. context.Canceled yang diratakan menjadi string
	// tidak lagi bisa dikenali errors.Is, sehingga LayakDiulang di §5 jatuh
	// ke cabang "tak dikenal" dan mengembalikan TRUE — lapisan retry lalu
	// MENGULANG permintaan yang context-nya sudah dibatalkan. Tiap percobaan
	// gagal seketika, seluruh kuota terbakar dalam mikrodetik, dan yang
	// dilaporkan ke pemanggil adalah "percobaan habis", bukan pembatalan.
	//
	// Bukan hanya context: apa pun yang dipakai lapisan lain untuk mengambil
	// KEPUTUSAN harus tetap bisa ditelusuri. Yang boleh di-opaque-kan adalah
	// galat yang hanya berguna untuk dibaca manusia.
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s %v: %w", entitas, id, err)

	case errors.Is(err, errBarisTidakAda):
		// Sentinel domain yang dibungkus; identitas pustaka TIDAK ikut keluar.
		return fmt.Errorf("%s %v: %w", entitas, id, ErrTidakDitemukan)
	case errors.Is(err, errKeunikan):
		return fmt.Errorf("%s %v: %w", entitas, id, ErrKonflik)
	default:
		// %v, bukan %w: pesannya berguna untuk log, identitasnya tidak
		// dijadikan bagian kontrak yang harus dipelihara selamanya.
		return fmt.Errorf("%s %v: galat penyimpanan: %v", entitas, id, err)
	}
}

// Sentinel internal paket penyimpanan (di kode nyata: pgx.ErrNoRows dsb).
var (
	errBarisTidakAda = errors.New("baris tidak ada")
	errKeunikan      = errors.New("pelanggaran keunikan")
)

// ---------- 4. PEMETAAN KE TRANSPORT: satu tempat, bukan di tiap handler ----------

// Respons adalah bentuk galat yang aman dikirim ke klien.
type Respons struct {
	Kode      string            `json:"kode"`
	Pesan     string            `json:"pesan"`
	Field     map[string]string `json:"field,omitempty"`
	KorelasiID string           `json:"korelasi_id"`
}

// KeHTTP memetakan galat domain ke status HTTP dan badan respons.
//
// Ini SATU-SATUNYA tempat pemetaan terjadi. Menyebarnya ke tiap handler
// adalah alasan paling umum 404 dan 500 tertukar secara acak.
func KeHTTP(ctx context.Context, err error, korelasiID string) (int, Respons) {
	var vBanyak *GalatBanyakValidasi
	var vSatu *GalatValidasi

	switch {
	// URUTAN DUA CASE PERTAMA MENGIKAT, dan tidak terlihat dari kodenya.
	//
	// GalatBanyakValidasi.Unwrap() mengembalikan []error berisi setiap
	// *GalatValidasi di dalamnya, sehingga `errors.As(err, &vSatu)` JUGA
	// bernilai true untuk galat jamak — ia akan menemukan yang pertama.
	// Menukar kedua case ini membuat respons hanya memuat satu field dari
	// sekian yang gagal, dan kliennya memperbaiki satu per satu tanpa pernah
	// tahu ada yang lain. Bug diam yang lolos setiap review.
	case errors.As(err, &vBanyak):
		f := make(map[string]string, len(vBanyak.Galat))
		for _, v := range vBanyak.Galat {
			f[v.Field] = v.Aturan
		}
		return http.StatusUnprocessableEntity, Respons{
			Kode: "VALIDASI_GAGAL", Pesan: "Sebagian isian tidak valid.",
			Field: f, KorelasiID: korelasiID,
		}

	case errors.As(err, &vSatu):
		return http.StatusUnprocessableEntity, Respons{
			Kode: "VALIDASI_GAGAL", Pesan: "Sebagian isian tidak valid.",
			Field: map[string]string{vSatu.Field: vSatu.Aturan}, KorelasiID: korelasiID,
		}

	case errors.Is(err, ErrTidakDitemukan):
		return http.StatusNotFound, Respons{
			Kode: "TIDAK_DITEMUKAN", Pesan: "Data yang diminta tidak ada.",
			KorelasiID: korelasiID,
		}

	case errors.Is(err, ErrKonflik):
		return http.StatusConflict, Respons{
			Kode: "KONFLIK", Pesan: "Data sudah berubah. Muat ulang lalu coba lagi.",
			KorelasiID: korelasiID,
		}

	case errors.Is(err, ErrTidakBerwenang):
		return http.StatusForbidden, Respons{
			Kode: "TIDAK_BERWENANG", Pesan: "Anda tidak punya akses ke sumber daya ini.",
			KorelasiID: korelasiID,
		}

	default:
		// Galat tak dikenal TIDAK PERNAH dibocorkan isinya — dan pencatatannya
		// dilakukan DI SINI, bukan diserahkan ke pemanggil.
		//
		// Versi sebelumnya menulis komentar "pesan aslinya dicatat di sisi
		// server" tanpa satu baris pun yang mencatatnya: satu-satunya tempat
		// galat itu masih utuh justru membuangnya, dan korelasiID yang
		// diterima pengguna tidak menunjuk ke apa pun. Ketika ia menelepon
		// dengan ID di tangan, tidak ada yang bisa dicari.
		slog.ErrorContext(ctx, "galat tak tertangani dipetakan ke 500",
			"korelasi_id", korelasiID, "galat", err)

		return http.StatusInternalServerError, Respons{
			Kode: "GALAT_INTERNAL", Pesan: "Terjadi kesalahan. Sebutkan ID ini bila menghubungi dukungan.",
			KorelasiID: korelasiID,
		}
	}
}

// ---------- 5. KLASIFIKASI UNTUK RETRY ----------

// LayakDiulang menjawab satu pertanyaan yang dibutuhkan lapisan retry:
// apakah mengulang operasi ini punya peluang berhasil?
//
// Galat validasi dan otorisasi TIDAK akan menjadi benar karena diulang;
// mengulanginya hanya membakar kuota dan menunda kegagalan yang sudah pasti.
func LayakDiulang(err error) bool {
	if err == nil {
		return false
	}

	// Context yang sudah selesai mendahului segalanya.
	//
	// context.Canceled berarti pemanggil SUDAH PERGI: mengulang hanya
	// membakar kuota untuk hasil yang tidak akan dibaca siapa pun.
	// context.DeadlineExceeded berarti anggaran waktunya sudah habis;
	// percobaan berikutnya mustahil lebih cepat dari waktu yang sudah lewat.
	//
	// Keduanya sengaja diperiksa PERTAMA, karena cabang terakhir fungsi ini
	// mengembalikan true untuk galat tak dikenal — dan galat context yang
	// terlanjur diratakan menjadi string akan mendarat di sana.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var v *GalatValidasi
	switch {
	case errors.As(err, &v),
		errors.Is(err, ErrTidakBerwenang),
		errors.Is(err, ErrTidakDitemukan):
		return false
	}
	var sementara interface{ Sementara() bool }
	if errors.As(err, &sementara) {
		return sementara.Sementara()
	}

	// Konservatif: galat tak dikenal dianggap sementara.
	//
	// Konsekuensinya harus disadari — default ini hanya aman selama galat
	// yang membawa KEPUTUSAN tidak pernah kehilangan identitasnya di
	// perjalanan. Itulah alasan DariRepository di §3 mempertahankan
	// pembungkusan %w untuk galat context.
	return true
}
```

## Uji

```go
package galat

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

// Bug yang paling mahal di berkas ini, dan sebelumnya tidak diuji sama
// sekali: permintaan yang context-nya sudah dibatalkan TIDAK boleh
// diklasifikasikan layak diulang.
func TestGalatContextTidakLayakDiulang(t *testing.T) {
	kasus := map[string]error{
		"dibatalkan":         context.Canceled,
		"deadline terlampaui": context.DeadlineExceeded,
	}
	for nama, asal := range kasus {
		t.Run(nama, func(t *testing.T) {
			// Lewat jalur terjemahan repository, persis seperti di produksi.
			err := DariRepository(asal, "pesanan", 7)

			if !errors.Is(err, asal) {
				t.Fatalf("identitas galat context hilang setelah terjemahan: %v", err)
			}
			if LayakDiulang(err) {
				t.Fatal("permintaan yang sudah dibatalkan diklasifikasikan layak diulang — " +
					"lapisan retry akan membakar seluruh kuota lalu melapor 'percobaan habis'")
			}
		})
	}
}

func TestDariRepository_MenerjemahkanTanpaMembocorkanPustaka(t *testing.T) {
	err := DariRepository(errBarisTidakAda, "pesanan", 42)

	if !errors.Is(err, ErrTidakDitemukan) {
		t.Fatalf("harus bisa dikenali sebagai ErrTidakDitemukan, dapat %v", err)
	}
	// Inti pengujian: identitas galat PUSTAKA tidak boleh ikut keluar,
	// kalau tidak lapisan atas jadi bergantung pada driver database.
	if errors.Is(err, errBarisTidakAda) {
		t.Fatal("identitas galat pustaka bocor ke lapisan atas")
	}
	if got := err.Error(); got == "" || !contains(got, "pesanan 42") {
		t.Errorf("konteks hilang dari pesan: %q", got)
	}
}

func TestDariRepository_GalatTakDikenalTidakDijadikanKontrak(t *testing.T) {
	asli := errors.New("koneksi putus")
	err := DariRepository(asli, "pesanan", 7)

	if errors.Is(err, asli) {
		t.Fatal("galat tak dikenal tidak boleh dibungkus %w")
	}
	if !contains(err.Error(), "koneksi putus") {
		t.Error("pesan aslinya tetap harus terbawa untuk keperluan log")
	}
}

func TestKeHTTP_PemetaanTerpusat(t *testing.T) {
	kasus := []struct {
		nama    string
		err     error
		status  int
		kode    string
	}{
		{"tidak ditemukan", fmt.Errorf("x: %w", ErrTidakDitemukan), http.StatusNotFound, "TIDAK_DITEMUKAN"},
		{"konflik", fmt.Errorf("x: %w", ErrKonflik), http.StatusConflict, "KONFLIK"},
		{"tidak berwenang", ErrTidakBerwenang, http.StatusForbidden, "TIDAK_BERWENANG"},
		{"validasi", &GalatValidasi{Field: "email", Aturan: "format"}, http.StatusUnprocessableEntity, "VALIDASI_GAGAL"},
		{"tak dikenal", errors.New("boom"), http.StatusInternalServerError, "GALAT_INTERNAL"},
	}
	for _, k := range kasus {
		t.Run(k.nama, func(t *testing.T) {
			status, resp := KeHTTP(context.Background(), k.err, "kor-1")
			if status != k.status || resp.Kode != k.kode {
				t.Fatalf("mau %d/%s, dapat %d/%s", k.status, k.kode, status, resp.Kode)
			}
			if resp.KorelasiID != "kor-1" {
				t.Error("korelasi ID wajib ikut agar insiden bisa ditelusuri")
			}
		})
	}
}

func TestKeHTTP_GalatInternalTidakBocorKeKlien(t *testing.T) {
	rahasia := errors.New(`pq: relation "pengguna_rahasia" does not exist`)
	_, resp := KeHTTP(context.Background(), fmt.Errorf("ambil: %v", rahasia), "kor-2")

	if contains(resp.Pesan, "pengguna_rahasia") || contains(resp.Pesan, "pq:") {
		t.Fatalf("detail internal bocor ke klien: %q", resp.Pesan)
	}
}

func TestUnwrapSlice_MenelusuriSeluruhIsi(t *testing.T) {
	// Unwrap() []error membuat errors.As menemukan yang KEDUA, bukan berhenti
	// di yang pertama. Tanpa ini, hanya kegagalan pertama yang terlihat.
	g := &GalatBanyakValidasi{Galat: []*GalatValidasi{
		{Field: "nama", Aturan: "wajib"},
		{Field: "email", Aturan: "format"},
	}}
	var v *GalatValidasi
	if !errors.As(error(g), &v) {
		t.Fatal("errors.As harus menemukan GalatValidasi di dalam gabungan")
	}
	status, resp := KeHTTP(context.Background(), g, "kor-3")
	if status != http.StatusUnprocessableEntity || len(resp.Field) != 2 {
		t.Fatalf("kedua field harus dilaporkan, dapat %v", resp.Field)
	}
}

func TestLayakDiulang(t *testing.T) {
	kasus := map[string]struct {
		err error
		mau bool
	}{
		"validasi tidak diulang":    {&GalatValidasi{Field: "a"}, false},
		"otorisasi tidak diulang":   {ErrTidakBerwenang, false},
		"tidak ditemukan":           {ErrTidakDitemukan, false},
		"tak dikenal dianggap bisa": {errors.New("timeout"), true},
		"nil":                       {nil, false},
	}
	for nama, k := range kasus {
		if got := LayakDiulang(k.err); got != k.mau {
			t.Errorf("%s: mau %v, dapat %v", nama, k.mau, got)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

## Anti-Pattern

**❌ SALAH — mencatat dan mengembalikan di lapisan yang sama**

```go
func (r *Repo) Ambil(ctx context.Context, id int64) (*Pesanan, error) {
	p, err := r.db.Ambil(ctx, id)
	if err != nil {
		log.Error("gagal ambil pesanan", "err", err) // dicatat di sini...
		return nil, err                              // ...DAN dikembalikan
	}
	return p, nil
}
```

Setiap lapisan melakukan hal yang sama, dan satu kegagalan berakhir sebagai lima baris log di lima tempat. Saat insiden, dasbor menunjukkan lonjakan galat lima kali lipat dari kejadian sebenarnya.

**✅ BENAR — tambah konteks di jalan, catat sekali di ujung**

```go
func (r *Repo) Ambil(ctx context.Context, id int64) (*Pesanan, error) {
	p, err := r.db.Ambil(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("ambil pesanan %d: %w", id, err)
	}
	return p, nil
}

// Di handler -- satu-satunya tempat yang mencatat:
if err != nil {
	status, resp := galat.KeHTTP(r.Context(), err, korelasiID)
	if status >= 500 {
		logger.Error("permintaan gagal", "err", err, "korelasi_id", korelasiID)
	}
	tulisJSON(w, status, resp)
	return
}
```

**❌ SALAH — memeriksa error dengan membandingkan string**

```go
if strings.Contains(err.Error(), "duplicate key") {
	return c.JSON(409, "sudah ada")
}
```

Pesan galat bukan API. Ia berubah antar versi pustaka, antar bahasa lokal database, dan antar konfigurasi — dan perubahannya tidak akan ditangkap kompilator maupun uji mana pun.

**✅ BENAR — periksa identitas, bukan teks**

```go
if errors.Is(err, galat.ErrKonflik) {
	return c.JSON(409, "sudah ada")
}
```

**❌ SALAH — membungkus segalanya dengan `%w`**

```go
func (s *Service) Checkout(ctx context.Context) error {
	if err := s.pembayaran.Bayar(ctx); err != nil {
		return fmt.Errorf("bayar: %w", err) // seluruh galat penyedia jadi kontrak
	}
	return nil
}
```

Sejak baris itu, setiap galat internal penyedia pembayaran bisa diperiksa pemanggil — dan mengganti penyedia menjadi perubahan yang merusak, tanpa satu pun peringatan kompilator.

**✅ BENAR — bungkus yang memang kontrak, terjemahkan sisanya**

```go
if err := s.pembayaran.Bayar(ctx); err != nil {
	if errors.Is(err, penyedia.ErrDanaKurang) {
		return fmt.Errorf("checkout: %w", ErrDanaKurang) // sentinel domain
	}
	return fmt.Errorf("checkout: gagal membayar: %v", err) // opaque
}
```

**❌ SALAH — `panic` untuk keadaan yang diharapkan**

```go
func AmbilKonfigurasi(kunci string) string {
	v := os.Getenv(kunci)
	if v == "" {
		panic("konfigurasi " + kunci + " tidak ada") // di tengah permintaan
	}
	return v
}
```

**✅ BENAR — panic hanya saat bootstrap, error saat runtime**

```go
// Saat start: panic sah, karena proses memang tidak boleh berjalan.
func MuatKonfigurasi() (Konfigurasi, error) { /* kembalikan error */ }

func main() {
	cfg, err := MuatKonfigurasi()
	if err != nil {
		log.Fatalf("konfigurasi tidak valid: %v", err) // hanya di main
	}
	// ...
}
```

## Kasus Tepi Produksi

1. **`errors.Is` pada error yang dibungkus `%v` tidak akan cocok.** Ini sering muncul sebagai "kenapa pemeriksaan saya tidak jalan padahal galatnya benar". Bila pemeriksaan itu memang diperlukan, `%w` yang benar — dan itu keputusan sadar untuk menjadikannya kontrak.

2. **`Unwrap() []error` menelusuri semua cabang, `Unwrap() error` hanya satu.** Tipe yang mengumpulkan beberapa galat WAJIB memakai bentuk slice; bila tidak, `errors.As` berhenti di galat pertama dan sisanya tidak pernah terlihat.

3. **Sentinel yang dibandingkan dengan `==` gagal begitu ada yang membungkusnya.** Selalu `errors.Is`, tidak pernah `==`. Ini bug yang muncul berbulan-bulan kemudian ketika seseorang menambahkan satu lapisan konteks di tengah.

4. **`context.Canceled` bukan kegagalan sistem.** Klien yang pergi menghasilkan galat ini di seluruh jalur. Mencatatnya sebagai `ERROR` dan menghitungnya di SLO membuat error budget terbakar oleh perilaku pengguna yang normal. Bedakan dari `DeadlineExceeded`, yang **memang** sinyal masalah.

5. **Galat di dalam `defer` diam-diam hilang.** `defer f.Close()` membuang galat penutupan — dan pada penulisan berkas, galat `Close` adalah tempat kegagalan flush muncul. Untuk penulisan, tangkap dengan named return.

6. **`errors.Join` menggabungkan tanpa urutan yang berarti.** Untuk operasi batch, pemanggil biasanya butuh tahu **item mana** yang gagal, bukan hanya bahwa ada yang gagal. Bungkus tiap galat dengan identitas itemnya sebelum digabung.

7. **Pemetaan galat yang tersebar menghasilkan status yang tidak konsisten.** Endpoint yang ditulis tim berbeda akan mengembalikan `404` dan `500` untuk kondisi yang sama. Satu fungsi pemetaan, dipakai seluruh handler, ditegakkan lewat review.

## Kapan JANGAN Pakai Ini

- **Membuat sentinel atau tipe untuk error yang tidak pernah dibedakan siapa pun.** Setiap sentinel adalah bagian API publik yang harus dipelihara selamanya. Bila tidak ada `if` yang bercabang atasnya, `fmt.Errorf` biasa sudah cukup.
- **Hierarki error berlapis meniru exception di bahasa lain.** Go tidak punya penangkapan berdasarkan tipe induk. Hierarki dalam hanya menambah kode tanpa menambah kemampuan yang bisa dipakai pemanggil.
- **Stack trace pada setiap error.** Menangkap stack punya ongkos, dan pada jalur panas ongkos itu nyata. Untuk galat yang diharapkan — validasi, tidak ditemukan — stack trace tidak menambah informasi apa pun.
- **Mengembalikan error dari fungsi yang tidak mungkin gagal.** Tanda tangan `func (v Uang) String() (string, error)` memaksa setiap pemanggil menangani sesuatu yang tidak pernah terjadi, dan penanganan itu akan berupa `_` yang menyembunyikan kesalahan nyata di kemudian hari.
- **Menjadikan seluruh galat pustaka pihak ketiga sebagai kontrak.** Bila `errors.Is(err, redis.Nil)` tersebar di lapisan service, mengganti klien Redis menjadi proyek tersendiri.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu insiden tampak sebagai lonjakan galat berlipat | jumlah baris log per satu permintaan gagal | Dicatat di setiap lapisan |
| `404` dan `500` tertukar untuk kondisi serupa | berapa tempat memetakan galat ke status | Pemetaan tersebar di banyak handler |
| Nama tabel atau query muncul di respons klien | badan respons `5xx` | Galat internal diteruskan mentah |
| Error budget terbakar tanpa keluhan pengguna | rasio `context.Canceled` vs `DeadlineExceeded` | Pembatalan klien dihitung sebagai kegagalan |
| Retry pada galat yang tidak akan berubah | klasifikasi galat di lapisan retry | Validasi dan otorisasi ikut diulang |
| Pemeriksaan `errors.Is` tiba-tiba berhenti bekerja | apakah ada `%v` di rantai | Satu lapisan membungkus tanpa `%w` |

```bash
# Berapa baris log untuk SATU permintaan gagal? Lebih dari satu berarti
# pencatatan berlapis, dan dasbor Anda melaporkan angka yang salah.
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.level=="error") | .korelasi_id' | sort | uniq -c | sort -rn | head

# Pembatalan klien tidak boleh dihitung sebagai kegagalan sistem
kubectl logs -l app=api --since=1h | grep -c 'context canceled'
kubectl logs -l app=api --since=1h | grep -c 'context deadline exceeded'

# Detail internal yang bocor ke klien
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.status>=500) | .response_body' | grep -iE 'pq:|sql:|pgx|panic|goroutine' | head

# Pemeriksaan galat berbasis string -- rapuh dan tidak tertangkap kompilator
grep -rn 'err.Error()' --include='*.go' . | grep -iE 'Contains|HasPrefix|==' | head

# Sentinel yang dibandingkan dengan == alih-alih errors.Is
grep -rnE 'err (==|!=) Err[A-Z]' --include='*.go' .

# Berapa banyak tempat memetakan galat ke status HTTP? Idealnya satu.
grep -rn 'StatusNotFound\|StatusConflict\|StatusInternalServerError' --include='*.go' . \
  | grep -v '_test.go' | cut -d: -f1 | sort -u
```
