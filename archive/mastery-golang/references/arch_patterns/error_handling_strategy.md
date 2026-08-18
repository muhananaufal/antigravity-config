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
return fmt.Errorf("fetch user: %w", sql.ErrNoRows)

// Membungkus dengan %v = detail masuk pesan, identitas TIDAK bocor keluar.
return fmt.Errorf("fetch user: %v", err)
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
	// ErrNotFound dikembalikan ketika entitas yang diminta tidak ada.
	ErrNotFound = errors.New("entity not found")
	// ErrConflict menandakan pelanggaran keunikan atau kondisi balapan optimistic.
	ErrConflict = errors.New("state conflict")
	// ErrUnauthorized menandakan pemanggil terautentikasi tetapi tidak diizinkan.
	ErrUnauthorized = errors.New("unauthorized")
)

// ---------- 2. TIPE: error yang membawa data ----------

// ValidationError membawa field mana yang gagal dan aturan apa yang dilanggar,
// karena pemanggil (handler HTTP) perlu mengembalikannya ke klien per-field.
type ValidationError struct {
	Field  string
	Rule   string
	Value  any
}

func (g *ValidationError) Error() string {
	return fmt.Sprintf("validation failed on %q: violates %s", g.Field, g.Rule)
}

// MultiValidationError mengumpulkan beberapa kegagalan sekaligus.
// Pemanggil bisa mengambilnya utuh dengan errors.As, atau memeriksa
// salah satu isinya dengan errors.Is/As karena Unwrap mengembalikan slice.
type MultiValidationError struct {
	Errors []*ValidationError
}

func (g *MultiValidationError) Error() string {
	return fmt.Sprintf("%d fields are invalid", len(g.Errors))
}

// Unwrap dengan tanda tangan []error (Go 1.20+) membuat errors.Is dan
// errors.As menelusuri SELURUH isi, bukan hanya yang pertama.
func (g *MultiValidationError) Unwrap() []error {
	out := make([]error, len(g.Errors))
	for i, e := range g.Errors {
		out[i] = e
	}
	return out
}

// ---------- 3. TERJEMAHAN DI BATAS: jangan biarkan galat pustaka bocor ----------

// FromRepository menerjemahkan galat lapisan penyimpanan menjadi galat domain.
//
// Tanpa terjemahan ini, seluruh sistem menjadi bergantung pada detail
// implementasi database: mengganti pgx ke sesuatu yang lain akan memecahkan
// setiap `errors.Is(err, pgx.ErrNoRows)` yang tersebar di lapisan atas.
func FromRepository(err error, entitas string, id any) error {
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

	case errors.Is(err, errNoRows):
		// Sentinel domain yang dibungkus; identitas pustaka TIDAK ikut keluar.
		return fmt.Errorf("%s %v: %w", entitas, id, ErrNotFound)
	case errors.Is(err, errUniqueConstraint):
		return fmt.Errorf("%s %v: %w", entitas, id, ErrConflict)
	default:
		// %v, bukan %w: pesannya berguna untuk log, identitasnya tidak
		// dijadikan bagian kontrak yang harus dipelihara selamanya.
		return fmt.Errorf("%s %v: storage error: %v", entitas, id, err)
	}
}

// Sentinel internal paket penyimpanan (di kode nyata: pgx.ErrNoRows dsb).
var (
	errNoRows           = errors.New("row not found")
	errUniqueConstraint = errors.New("unique constraint violation")
)

// ---------- 4. PEMETAAN KE TRANSPORT: satu tempat, bukan di tiap handler ----------

// Response adalah bentuk galat yang aman dikirim ke klien.
type Response struct {
	Code          string            `json:"code"`
	Message       string            `json:"message"`
	Field         map[string]string `json:"field,omitempty"`
	CorrelationID string            `json:"correlation_id"`
}

// ToHTTP memetakan galat domain ke status HTTP dan badan respons.
//
// Ini SATU-SATUNYA tempat pemetaan terjadi. Menyebarnya ke tiap handler
// adalah alasan paling umum 404 dan 500 tertukar secara acak.
func ToHTTP(ctx context.Context, err error, correlationID string) (int, Response) {
	var vMulti *MultiValidationError
	var vSingle *ValidationError

	switch {
	// URUTAN DUA CASE PERTAMA MENGIKAT, dan tidak terlihat dari kodenya.
	//
	// GalatBanyakValidasi.Unwrap() mengembalikan []error berisi setiap
	// *GalatValidasi di dalamnya, sehingga `errors.As(err, &vSatu)` JUGA
	// bernilai true untuk galat jamak — ia akan menemukan yang pertama.
	// Menukar kedua case ini membuat respons hanya memuat satu field dari
	// sekian yang gagal, dan kliennya memperbaiki satu per satu tanpa pernah
	// tahu ada yang lain. Bug diam yang lolos setiap review.
	case errors.As(err, &vMulti):
		f := make(map[string]string, len(vMulti.Errors))
		for _, v := range vMulti.Errors {
			f[v.Field] = v.Rule
		}
		return http.StatusUnprocessableEntity, Response{
			Code: "VALIDATION_FAILED", Message: "Some input fields are invalid.",
			Field: f, CorrelationID: correlationID,
		}

	case errors.As(err, &vSingle):
		return http.StatusUnprocessableEntity, Response{
			Code: "VALIDATION_FAILED", Message: "Some input fields are invalid.",
			Field: map[string]string{vSingle.Field: vSingle.Rule}, CorrelationID: correlationID,
		}

	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound, Response{
			Code: "NOT_FOUND", Message: "Requested data does not exist.",
			CorrelationID: correlationID,
		}

	case errors.Is(err, ErrConflict):
		return http.StatusConflict, Response{
			Code: "CONFLICT", Message: "Data has changed. Reload and try again.",
			CorrelationID: correlationID,
		}

	case errors.Is(err, ErrUnauthorized):
		return http.StatusForbidden, Response{
			Code: "UNAUTHORIZED", Message: "You do not have access to this resource.",
			CorrelationID: correlationID,
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
		slog.ErrorContext(ctx, "unhandled error mapped to 500",
			"correlation_id", correlationID, "error", err)

		return http.StatusInternalServerError, Response{
			Code: "INTERNAL_ERROR", Message: "An unexpected error occurred. Reference this ID when contacting support.",
			CorrelationID: correlationID,
		}
	}
}

// ---------- 5. KLASIFIKASI UNTUK RETRY ----------

// IsRetryable menjawab satu pertanyaan yang dibutuhkan lapisan retry:
// apakah mengulang operasi ini punya peluang berhasil?
//
// Galat validasi dan otorisasi TIDAK akan menjadi benar karena diulang;
// mengulanginya hanya membakar kuota dan menunda kegagalan yang sudah pasti.
func IsRetryable(err error) bool {
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

	var v *ValidationError
	switch {
	case errors.As(err, &v),
		errors.Is(err, ErrUnauthorized),
		errors.Is(err, ErrNotFound):
		return false
	}
	var temporary interface{ Temporary() bool }
	if errors.As(err, &temporary) {
		return temporary.Temporary()
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
		"canceled":          context.Canceled,
		"deadline exceeded": context.DeadlineExceeded,
	}
	for nama, asal := range kasus {
		t.Run(nama, func(t *testing.T) {
			// Lewat jalur terjemahan repository, persis seperti di produksi.
			err := FromRepository(asal, "order", 7)

			if !errors.Is(err, asal) {
				t.Fatalf("context error identity lost after translation: %v", err)
			}
			if IsRetryable(err) {
				t.Fatal("canceled request classified as retryable")
			}
		})
	}
}

func TestFromRepository_MenerjemahkanTanpaMembocorkanPustaka(t *testing.T) {
	err := FromRepository(errNoRows, "order", 42)

	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("should be recognized as ErrNotFound, got %v", err)
	}
	// Inti pengujian: identitas galat PUSTAKA tidak boleh ikut keluar,
	// kalau tidak lapisan atas jadi bergantung pada driver database.
	if errors.Is(err, errNoRows) {
		t.Fatal("library error identity leaked to upper layer")
	}
	if got := err.Error(); got == "" || !contains(got, "order 42") {
		t.Errorf("context missing from message: %q", got)
	}
}

func TestFromRepository_GalatTakDikenalTidakDijadikanKontrak(t *testing.T) {
	asli := errors.New("connection reset")
	err := FromRepository(asli, "order", 7)

	if errors.Is(err, asli) {
		t.Fatal("unknown error must not be wrapped with %w")
	}
	if !contains(err.Error(), "connection reset") {
		t.Error("original message must be preserved for logging")
	}
}

func TestToHTTP_PemetaanTerpusat(t *testing.T) {
	kasus := []struct {
		nama   string
		err    error
		status int
		kode   string
	}{
		{"not found", fmt.Errorf("x: %w", ErrNotFound), http.StatusNotFound, "NOT_FOUND"},
		{"conflict", fmt.Errorf("x: %w", ErrConflict), http.StatusConflict, "CONFLICT"},
		{"unauthorized", ErrUnauthorized, http.StatusForbidden, "UNAUTHORIZED"},
		{"validation", &ValidationError{Field: "email", Rule: "format"}, http.StatusUnprocessableEntity, "VALIDATION_FAILED"},
		{"unknown", errors.New("boom"), http.StatusInternalServerError, "INTERNAL_ERROR"},
	}
	for _, k := range kasus {
		t.Run(k.nama, func(t *testing.T) {
			status, resp := ToHTTP(context.Background(), k.err, "kor-1")
			if status != k.status || resp.Code != k.kode {
				t.Fatalf("want %d/%s, got %d/%s", k.status, k.kode, status, resp.Code)
			}
			if resp.CorrelationID != "kor-1" {
				t.Error("correlation ID must be included to trace incidents")
			}
		})
	}
}

func TestToHTTP_GalatInternalTidakBocorKeKlien(t *testing.T) {
	rahasia := errors.New(`pq: relation "secret_users" does not exist`)
	_, resp := ToHTTP(context.Background(), fmt.Errorf("fetch: %v", rahasia), "kor-2")

	if contains(resp.Message, "secret_users") || contains(resp.Message, "pq:") {
		t.Fatalf("internal details leaked to client: %q", resp.Message)
	}
}

func TestUnwrapSlice_MenelusuriSeluruhIsi(t *testing.T) {
	// Unwrap() []error membuat errors.As menemukan yang KEDUA, bukan berhenti
	// di yang pertama. Tanpa ini, hanya kegagalan pertama yang terlihat.
	g := &MultiValidationError{Errors: []*ValidationError{
		{Field: "name", Rule: "required"},
		{Field: "email", Rule: "format"},
	}}
	var v *ValidationError
	if !errors.As(error(g), &v) {
		t.Fatal("errors.As must find ValidationError within multi-error")
	}
	status, resp := ToHTTP(context.Background(), g, "kor-3")
	if status != http.StatusUnprocessableEntity || len(resp.Field) != 2 {
		t.Fatalf("both fields must be reported, got %v", resp.Field)
	}
}

func TestIsRetryable(t *testing.T) {
	kasus := map[string]struct {
		err error
		mau bool
	}{
		"validation is not retryable":          {&ValidationError{Field: "a"}, false},
		"authorization is not retryable":       {ErrUnauthorized, false},
		"not found is not retryable":           {ErrNotFound, false},
		"unknown error is considered retryable": {errors.New("timeout"), true},
		"nil":                                  {nil, false},
	}
	for nama, k := range kasus {
		if got := IsRetryable(k.err); got != k.mau {
			t.Errorf("%s: want %v, got %v", nama, k.mau, got)
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
		log.Error("failed to fetch order", "err", err) // dicatat di sini...
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
		return nil, fmt.Errorf("fetch order %d: %w", id, err)
	}
	return p, nil
}

// Di handler -- satu-satunya tempat yang mencatat:
if err != nil {
	status, resp := galat.ToHTTP(r.Context(), err, correlationID)
	if status >= 500 {
		logger.Error("request failed", "err", err, "correlation_id", correlationID)
	}
	tulisJSON(w, status, resp)
	return
}
```

**❌ SALAH — memeriksa error dengan membandingkan string**

```go
if strings.Contains(err.Error(), "duplicate key") {
	return c.JSON(409, "already exists")
}
```

Pesan galat bukan API. Ia berubah antar versi pustaka, antar bahasa lokal database, dan antar konfigurasi — dan perubahannya tidak akan ditangkap kompilator maupun uji mana pun.

**✅ BENAR — periksa identitas, bukan teks**

```go
if errors.Is(err, galat.ErrConflict) {
	return c.JSON(409, "already exists")
}
```

**❌ SALAH — membungkus segalanya dengan `%w`**

```go
func (s *Service) Checkout(ctx context.Context) error {
	if err := s.pembayaran.Bayar(ctx); err != nil {
		return fmt.Errorf("pay: %w", err) // seluruh galat penyedia jadi kontrak
	}
	return nil
}
```

Sejak baris itu, setiap galat internal penyedia pembayaran bisa diperiksa pemanggil — dan mengganti penyedia menjadi perubahan yang merusak, tanpa satu pun peringatan kompilator.

**✅ BENAR — bungkus yang memang kontrak, terjemahkan sisanya**

```go
if err := s.pembayaran.Bayar(ctx); err != nil {
	if errors.Is(err, penyedia.ErrDanaKurang) {
		return fmt.Errorf("checkout: %w", ErrInsufficientFunds) // sentinel domain
	}
	return fmt.Errorf("checkout: payment failed: %v", err) // opaque
}
```

**❌ SALAH — `panic` untuk keadaan yang diharapkan**

```go
func AmbilKonfigurasi(kunci string) string {
	v := os.Getenv(kunci)
	if v == "" {
		panic("config " + kunci + " not found") // di tengah permintaan
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
		log.Fatalf("invalid config: %v", err) // hanya di main
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
