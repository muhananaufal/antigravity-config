# Continuous Profiling di Produksi

> **Berlaku:** Go 1.21+ · Pyroscope / Parca / Cloud Profiler · **Lihat juga:** `testing_quality/benchmarking_pprof.md` · `runtime_internals/gc_mark_sweep_internals.md` · `runtime_internals/pgo_profile_guided_optimization.md` · `observability_resilience/prometheus_metrics_red.md`

## Konsep Utama

Metrik memberi tahu **bahwa** layanan lambat. Trace memberi tahu **di mana** waktunya habis, sampai batas layanan. Tidak satu pun menjawab pertanyaan terakhir: **baris kode mana**.

Profiling ad-hoc menjawabnya, tapi hanya bila Anda sempat mengambil profil **saat masalah sedang terjadi**. Insiden yang berlangsung tiga menit pada jam dua pagi tidak memberi kesempatan itu. Continuous profiling menyimpan profil sepanjang waktu, sehingga pertanyaan "apa yang berbeda kemarin pukul 02:14" punya jawaban.

| Sinyal | Menjawab | Granularitas |
| :--- | :--- | :--- |
| Metrik | Berapa banyak, seberapa cepat | Agregat |
| Trace | Di mana waktunya habis | Per permintaan, per layanan |
| Log | Apa yang terjadi pada satu permintaan | Per kejadian |
| **Profil** | **Baris kode mana yang memakannya** | **Per fungsi, per baris** |

### Nilai terbesarnya bukan profil tunggal — tapi selisihnya

Satu profil menunjukkan di mana CPU habis. **Perbandingan dua profil** menunjukkan apa yang **berubah**, dan itu pertanyaan yang sebenarnya Anda punya saat insiden:

```
go tool pprof -base kemarin.pb.gz hari-ini.pb.gz
```

Tanpa penyimpanan berkelanjutan, "kemarin" tidak pernah ada. Inilah alasan continuous profiling tidak bisa digantikan `curl /debug/pprof` yang dijalankan saat panik.

### Ongkosnya nyata, dan berbeda per jenis profil

| Profil | Ongkos khas | Catatan |
| :--- | :--- | :--- |
| CPU | ~1–3% saat aktif | Sampling 100 Hz; aman menyala terus |
| Heap (alloc) | Rendah | Sampling per 512 KB alokasi secara bawaan |
| Goroutine | **Naik dengan jumlah goroutine** | Mahal pada puluhan ribu goroutine — hentikan dunia |
| Mutex / Block | **Tergantung rate** | `SetMutexProfileFraction(1)` sangat mahal; pakai 100+ |

Menyalakan semuanya sekaligus dengan rate maksimum bukan continuous profiling — itu memindahkan masalah performa ke dalam alat yang seharusnya mendiagnosisnya.

### Label mengubah profil menjadi bisa ditanya

`pprof.Labels` menempelkan dimensi ke sampel, sehingga profil bisa dipilah: per endpoint, per tenant, per versi. Tanpa label, Anda tahu `json.Marshal` memakan 30% CPU — dengan label, Anda tahu 28% dari 30% itu berasal dari satu endpoint ekspor milik satu pelanggan.

## Diagram ASCII

```text
   TIGA SINYAL DAN SATU PERTANYAAN YANG TIDAK MEREKA JAWAB

   metrik  "p99 naik jadi 900ms"        <- BAHWA
   trace   "800ms di layanan katalog"   <- DI MANA
   log     "permintaan X gagal"         <- APA
   profil  "620ms di regexp.MustCompile <- BARIS MANA
            yang dipanggil di dalam loop"

   Tanpa lapisan keempat, investigasi berhenti di batas layanan
   dan dilanjutkan dengan menebak.

   ---------------------------------------------------------------

   AD-HOC vs BERKELANJUTAN

   Ad-hoc:
     insiden mulai --> ... --> ada yang sadar --> ambil profil
     02:14            02:17     02:23             02:26
                                                    ^
                                        insiden sudah selesai.
                                        Profilnya profil sistem SEHAT.

   Berkelanjutan:
     profil disimpan terus-menerus
     02:14 [P] 02:15 [P] ... 02:26 [P]
       ^                                 ambil yang INI, bandingkan
       |                                 dengan hari sebelumnya
       `-- momen insiden tersimpan

   ---------------------------------------------------------------

   YANG DICARI SAAT MEMBANDINGKAN DUA PROFIL

   go tool pprof -base sebelum.pb.gz sesudah.pb.gz

     +420ms  encoding/json.Marshal          <- BERTAMBAH: tersangka utama
     +180ms  regexp.MustCompile             <- kompilasi di dalam loop?
       -5ms  runtime.mallocgc
       ...
   Yang penting bukan yang PALING BESAR, tapi yang paling BERUBAH.

   ---------------------------------------------------------------

   LABEL: dari "apa" menjadi "apa, milik siapa"

   Tanpa label:  json.Marshal  30% CPU
   Dengan label: json.Marshal  30% CPU
                   endpoint=/ekspor  28%   <- satu endpoint
                     tenant=akme      26%  <- satu pelanggan
                   sisanya            2%

   Kesimpulan berubah total: ini bukan masalah serialisasi,
   ini satu pelanggan yang menarik ekspor terlalu sering.
```

## Kode Go Production-Ready

```go
package profiling

import (
	"context"
	"fmt"
	"net/http"
	_ "net/http/pprof" // mendaftarkan handler di DefaultServeMux
	"runtime"
	"time"
)

// Konfig mengatur profil mana yang aktif dan seberapa agresif.
//
// Nilai bawaan sengaja konservatif: profil yang mahal dimatikan, karena
// alat diagnosis yang membebani sistem menciptakan masalah yang
// seharusnya ia bantu selesaikan.
type Konfig struct {
	// AlamatDebug adalah port TERPISAH dari API publik. Endpoint pprof
	// TIDAK BOLEH terekspos ke internet: ia membocorkan nama fungsi,
	// path berkas, dan bisa dipakai untuk menghabiskan CPU.
	AlamatDebug string

	// MutexFraction: 0 = mati. Nilai N berarti ~1/N peristiwa direkam.
	// 1 sangat mahal; 100 memberi gambaran memadai dengan ongkos rendah.
	MutexFraction int

	// BlockRate dalam nanodetik: 0 = mati. 10_000_000 (10ms) merekam
	// hanya blocking yang benar-benar lama.
	BlockRate int

	// LabelTetap menempel di seluruh sampel proses ini.
	LabelTetap map[string]string
}

// KonfigDefault memberi setelan yang aman menyala terus di produksi.
func KonfigDefault(versi, wilayah string) Konfig {
	return Konfig{
		AlamatDebug:   "127.0.0.1:6060", // hanya localhost; agen mengambil dari sini
		MutexFraction: 100,
		BlockRate:     10_000_000,
		LabelTetap:    map[string]string{"versi": versi, "wilayah": wilayah},
	}
}

// Mulai menyalakan profil dan server debug.
// Kembaliannya WAJIB dipanggil saat shutdown.
func Mulai(ctx context.Context, k Konfig) (berhenti func(context.Context) error, err error) {
	if k.MutexFraction > 0 {
		runtime.SetMutexProfileFraction(k.MutexFraction)
	}
	if k.BlockRate > 0 {
		runtime.SetBlockProfileRate(k.BlockRate)
	}

	srv := &http.Server{
		Addr:              k.AlamatDebug,
		Handler:           http.DefaultServeMux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		// Server debug yang mati tidak boleh menjatuhkan aplikasi.
		_ = srv.ListenAndServe()
	}()

	return func(ctx context.Context) error {
		runtime.SetMutexProfileFraction(0)
		runtime.SetBlockProfileRate(0)
		if err := srv.Shutdown(ctx); err != nil {
			return fmt.Errorf("tutup server debug: %w", err)
		}
		return nil
	}, nil
}
```

Label adalah bagian yang paling sering dilewatkan, dan yang paling menentukan apakah profil bisa ditanya:

```go
package profiling

import (
	"context"
	"net/http"
	"runtime/pprof"
)

// MiddlewareLabel menempelkan dimensi ke setiap sampel profil yang
// diambil selama permintaan ini berjalan.
//
// KARDINALITAS: label profil punya batasan yang sama dengan label metrik.
// Rute (pola, bukan path mentah) dan tenant aman; ID permintaan TIDAK --
// ia membuat setiap sampel unik dan penyimpanan profil meledak.
func MiddlewareLabel(polaRute func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			label := pprof.Labels(
				"rute", polaRute(r),
				"metode", r.Method,
				"tenant", r.Header.Get("X-Tenant-ID"),
			)
			// Do() memasang label pada goroutine ini SELAMA fn berjalan.
			pprof.Do(r.Context(), label, func(ctx context.Context) {
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
}

// TandaiTugasLatar memberi label pada pekerjaan yang tidak berasal dari
// permintaan HTTP -- job, konsumer antrean, cron.
//
// Tanpa ini, seluruh pekerjaan latar tampak sebagai satu gumpalan tanpa
// nama di profil, dan justru di situlah beban tak terduga sering berada.
func TandaiTugasLatar(ctx context.Context, jenis string, fn func(context.Context)) {
	pprof.Do(ctx, pprof.Labels("jenis_tugas", jenis), fn)
}
```

## Uji

```go
package profiling

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"runtime/pprof"
	"testing"
	"time"
)

func TestKonfigDefault_TidakMemakaiRateMahal(t *testing.T) {
	// SetMutexProfileFraction(1) dan BlockProfileRate(1) merekam SETIAP
	// peristiwa. Di produksi itu memindahkan masalah performa ke dalam
	// alat yang seharusnya mendiagnosisnya.
	k := KonfigDefault("1.0.0", "id-jkt")
	if k.MutexFraction < 10 {
		t.Errorf("MutexFraction %d terlalu agresif untuk produksi", k.MutexFraction)
	}
	if k.BlockRate > 0 && k.BlockRate < 1_000_000 {
		t.Errorf("BlockRate %d ns terlalu halus untuk produksi", k.BlockRate)
	}
}

func TestKonfigDefault_TidakTerekspos(t *testing.T) {
	// Endpoint pprof membocorkan nama fungsi dan path berkas, dan bisa
	// dipakai menghabiskan CPU. Ia TIDAK BOLEH mendengar di 0.0.0.0.
	k := KonfigDefault("1.0.0", "id-jkt")
	if k.AlamatDebug == "" || k.AlamatDebug[0] == ':' {
		t.Fatalf("alamat debug %q mendengar di semua antarmuka", k.AlamatDebug)
	}
}

func TestMulai_MemasangDanMelepasRate(t *testing.T) {
	k := KonfigDefault("uji", "lokal")
	k.AlamatDebug = "127.0.0.1:0" // port acak agar uji tidak bentrok

	berhenti, err := Mulai(context.Background(), k)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.SetMutexProfileFraction(-1) != k.MutexFraction {
		t.Error("MutexProfileFraction tidak terpasang")
	}

	ctx, batal := context.WithTimeout(context.Background(), 2*time.Second)
	defer batal()
	if err := berhenti(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if got := runtime.SetMutexProfileFraction(-1); got != 0 {
		t.Errorf("rate wajib dilepas saat shutdown, dapat %d", got)
	}
}

func TestMiddlewareLabel_LabelTerpasangSelamaPermintaan(t *testing.T) {
	var terlihat bool
	h := MiddlewareLabel(func(*http.Request) string { return "/pesanan/{id}" })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pprof.ForLabels(r.Context(), func(k, v string) bool {
				if k == "rute" && v == "/pesanan/{id}" {
					terlihat = true
				}
				return true
			})
		}))

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/pesanan/42", nil))
	if !terlihat {
		t.Fatal("label rute harus terpasang pada goroutine yang melayani permintaan")
	}
}

func TestMiddlewareLabel_MemakaiPolaBukanPathMentah(t *testing.T) {
	// Path mentah sebagai label = kardinalitas tak terbatas, persis
	// masalah yang sama seperti pada metrik Prometheus.
	var nilai string
	h := MiddlewareLabel(func(*http.Request) string { return "/pesanan/{id}" })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pprof.ForLabels(r.Context(), func(k, v string) bool {
				if k == "rute" {
					nilai = v
				}
				return true
			})
		}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/pesanan/99999", nil))

	if nilai == "/pesanan/99999" {
		t.Fatal("label memakai path mentah; kardinalitas akan meledak")
	}
}

func TestTandaiTugasLatar(t *testing.T) {
	var ok bool
	TandaiTugasLatar(context.Background(), "kirim_email", func(ctx context.Context) {
		pprof.ForLabels(ctx, func(k, v string) bool {
			if k == "jenis_tugas" && v == "kirim_email" {
				ok = true
			}
			return true
		})
	})
	if !ok {
		t.Fatal("pekerjaan latar wajib berlabel, kalau tidak ia tak bernama di profil")
	}
}
```

## Anti-Pattern

**❌ SALAH — mengekspos pprof di port API publik**

```go
http.ListenAndServe(":8080", nil) // DefaultServeMux sudah memuat /debug/pprof
```

Siapa pun bisa mengambil profil Anda — yang membocorkan seluruh nama fungsi, path berkas mesin build, dan struktur internal. `?seconds=300` juga menahan CPU selama lima menit atas permintaan orang asing.

**✅ BENAR — port terpisah, hanya localhost, agen yang mengambil**

```go
srv := &http.Server{Addr: "127.0.0.1:6060", Handler: http.DefaultServeMux}
go srv.ListenAndServe()
// API publik memakai mux sendiri, bukan DefaultServeMux
```

**❌ SALAH — `SetMutexProfileFraction(1)` di produksi**

```go
runtime.SetMutexProfileFraction(1)  // merekam SETIAP peristiwa mutex
runtime.SetBlockProfileRate(1)      // merekam SETIAP blocking
```

Pada layanan dengan kontensi tinggi, ini menambah beban yang cukup besar untuk mengubah perilaku yang sedang Anda ukur — dan kesimpulan yang ditarik darinya menjadi menyesatkan.

**✅ BENAR — rate yang menangkap yang signifikan saja**

```go
runtime.SetMutexProfileFraction(100)      // ~1% peristiwa
runtime.SetBlockProfileRate(10_000_000)   // hanya blocking > 10ms
```

**❌ SALAH — profil tanpa label**

```go
// Profil menunjukkan json.Marshal 30% CPU. Milik endpoint mana?
// Tenant mana? Tidak ada yang tahu.
```

**✅ BENAR — label per rute dan per tenant**

```go
pprof.Do(ctx, pprof.Labels("rute", pola, "tenant", tenantID), fn)
```

**❌ SALAH — ID permintaan sebagai label profil**

```go
pprof.Labels("request_id", reqID)  // unik per permintaan
```

Setiap sampel menjadi unik, ukuran profil meledak, dan agregasinya kehilangan makna — masalah kardinalitas yang sama persis seperti pada metrik.

**✅ BENAR — dimensi berkardinalitas terbatas**

```go
pprof.Labels("rute", polaRute, "metode", r.Method, "tenant", tenantID)
```

**❌ SALAH — membaca satu profil tanpa pembanding**

```bash
go tool pprof -top cpu.pb.gz   # "runtime.mallocgc 12%" -- lalu apa?
```

Angka absolut jarang bermakna sendirian. Sebagian besar profil sistem sehat terlihat sama mencurigakannya dengan sistem sakit.

**✅ BENAR — bandingkan dengan garis dasar**

```bash
go tool pprof -base sebelum.pb.gz sesudah.pb.gz
```

## Kasus Tepi Produksi

1. **Profil goroutine menghentikan dunia.** Pada proses dengan puluhan ribu goroutine, mengambilnya bisa menyebabkan jeda yang terlihat pengguna. Ambil jarang, dan jangan jadikan bagian dari pengambilan berkala yang agresif.

2. **Profil tanpa simbol setelah `-ldflags "-s -w"`.** Stack trace Go tetap terbaca, tetapi sebagian alat profiling kehilangan informasi simbol. Bila continuous profiling adalah bagian dari operasi Anda, timbang ulang penghematan beberapa megabyte itu.

3. **Agen sidecar menambah pemakaian memori per pod.** Pada armada besar, sidecar profiling dikalikan jumlah pod adalah angka yang nyata. Hitung sebelum memasang di seluruh cluster.

4. **Sampling membuat fungsi yang sangat cepat tampak tidak ada.** Profil CPU mengambil sampel 100 kali per detik. Fungsi yang selalu selesai dalam mikrodetik nyaris tidak pernah tertangkap — meskipun total waktunya besar. Untuk kasus itu, metrik dan trace lebih tepat.

5. **PGO memerlukan profil yang mewakili beban nyata.** Profil dari lingkungan uji menghasilkan optimasi yang menyasar jalur yang salah. Continuous profiling memberi sumber `default.pgo` yang benar — lihat `runtime_internals/pgo_profile_guided_optimization.md`.

6. **Retensi profil punya biaya penyimpanan.** Profil jauh lebih besar daripada metrik. Retensi tinggi untuk seluruh armada bisa mengejutkan di tagihan; simpan resolusi penuh untuk periode pendek dan turunkan resolusinya setelah itu.

7. **Label tidak merambat ke goroutine anak yang dibuat manual.** `pprof.Do` memasang label pada goroutine yang memanggilnya. Goroutine yang di-spawn di dalamnya **mewarisi** label lewat context hanya bila dibuat setelah `Do` dan memakai context tersebut — `go func()` yang menangkap variabel luar tanpa context tidak berlabel.

## Kapan JANGAN Pakai Ini

- **Sebelum metrik dan trace ada.** Profil menjawab pertanyaan keempat. Tanpa tiga yang pertama, Anda tidak akan tahu profil kapan yang perlu dilihat, dan datanya hanya menumpuk.
- **Pada layanan yang tidak pernah menjadi penyempitan.** Cron kecil dan job berkala tidak layak membayar sidecar dan penyimpanan profil. Pasang di layanan yang benar-benar menentukan pengalaman pengguna dan biaya.
- **Dengan semua jenis profil menyala pada rate maksimum.** Itu bukan continuous profiling — itu menambahkan beban tetap ke seluruh armada demi data yang jarang dibaca.
- **Sebagai pengganti benchmark.** Profil memberi tahu di mana waktu habis di produksi; benchmark membuktikan perubahan Anda memperbaikinya. Keduanya diperlukan — lihat `testing_quality/benchmarking_pprof.md`.
- **Bila endpoint pprof tidak bisa diamankan.** Di lingkungan yang tidak memungkinkan port terpisah atau kebijakan jaringan, risiko paparannya lebih besar daripada manfaatnya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Investigasi selalu berhenti di "layanan X lambat" | apakah ada profil pada rentang insiden | Tidak ada lapisan keempat |
| Profil diambil tapi tidak menjelaskan apa pun | apakah ada pembanding | Satu profil tanpa garis dasar |
| Tidak bisa menjawab "beban ini milik siapa" | label pada profil | Profil tidak berlabel |
| Beban dasar naik setelah memasang profiling | rate mutex/block | Rate terlalu agresif |
| Penyimpanan profil membengkak | kardinalitas label | Ada label unik per permintaan |
| `/debug/pprof` dapat diakses dari luar | port dan kebijakan jaringan | Endpoint terekspos |

```bash
# Endpoint pprof TIDAK BOLEH terjangkau dari luar pod
kubectl exec <pod-lain> -- curl -s --max-time 2 http://api:8080/debug/pprof/ \
  && echo "BAHAYA: pprof terekspos di port API"

# Profil dasar yang layak diambil berkala
curl -o cpu.pb.gz  'http://localhost:6060/debug/pprof/profile?seconds=30'
curl -o heap.pb.gz 'http://localhost:6060/debug/pprof/heap'

# Yang paling berguna: SELISIH terhadap garis dasar
go tool pprof -base garis-dasar.pb.gz cpu.pb.gz
go tool pprof -http=:8080 -base garis-dasar.pb.gz cpu.pb.gz

# Memilah profil berdasarkan label -- ini yang mengubah "apa" jadi "milik siapa"
go tool pprof -tagfocus='rute=/ekspor' cpu.pb.gz
go tool pprof -tagshow='tenant' cpu.pb.gz

# Rate yang benar-benar aktif di proses
curl -s localhost:6060/debug/pprof/ | grep -E 'mutex|block|goroutine'
```
