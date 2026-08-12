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
| Goroutine | **Naik dengan jumlah goroutine** | Sejak **Go 1.19** jeda stop-the-world-nya singkat dan hampir tidak bergantung jumlah goroutine — pembacaan stack dilakukan konkuren. Total kerjanya tetap sebanding dengan jumlah goroutine, jadi tetap jangan diambil sering |
| Mutex / Block | **Tergantung rate** | `SetMutexProfileFraction(1)` sangat mahal; pakai 100+ |
| Label (`pprof.Do`) | Kecil tapi **per permintaan** | Ia memasang label pada goroutine di setiap permintaan. Kecil dibanding kerja handler, tetapi bukan nol — jangan dipasang pada jalur yang tidak pernah Anda profil |

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
	"net"
	"net/http"
	httppprof "net/http/pprof"
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
	FixedLabels map[string]string
}

// KonfigDefault memberi setelan yang aman menyala terus di produksi.
func KonfigDefault(version, region string) Konfig {
	return Konfig{
		AlamatDebug:   "127.0.0.1:6060", // hanya localhost; agen mengambil dari sini
		MutexFraction: 100,
		BlockRate:     10_000_000,
		FixedLabels:    map[string]string{"versi": version, "wilayah": region},
	}
}

// Mulai menyalakan profil dan server debug. `berhenti` WAJIB dipanggil saat
// shutdown; `alamat` adalah alamat yang benar-benar terikat (berguna saat
// AlamatDebug memakai port 0).
//
// Listener DIIKAT SECARA SINKRON supaya kegagalannya benar-benar dilaporkan.
// Bentuk `go func() { _ = srv.ListenAndServe() }()` mengembalikan err nil apa
// pun yang terjadi: port yang sudah terpakai menghasilkan konstruktor yang
// tampak "berhasil" dan endpoint profil yang TIDAK ADA. Anda baru
// mengetahuinya saat insiden — tepat ketika endpoint itu satu-satunya hal
// yang Anda butuhkan.
func Start(k Konfig) (alamat string, stop func(context.Context) error, err error) {
	ln, err := net.Listen("tcp", k.AlamatDebug)
	if err != nil {
		return "", nil, fmt.Errorf("ikat alamat debug %q: %w", k.AlamatDebug, err)
	}

	if k.MutexFraction > 0 {
		runtime.SetMutexProfileFraction(k.MutexFraction)
	}
	if k.BlockRate > 0 {
		runtime.SetBlockProfileRate(k.BlockRate)
	}

	// Mux SENDIRI, bukan http.DefaultServeMux.
	//
	// Blank import `_ "net/http/pprof"` mendaftarkan handler ke mux GLOBAL.
	// Selama mux global memuatnya, setiap server yang dijalankan dengan
	// handler nil — termasuk yang ditambahkan orang lain enam bulan kemudian
	// tanpa tahu soal ini — ikut mengekspos /debug/pprof. Pendaftaran
	// eksplisit membuat paparannya menjadi keputusan, bukan efek samping
	// sebuah baris import.
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", httppprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", httppprof.Trace)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// SENGAJA tanpa WriteTimeout. Profil CPU 30 detik ditulis sebagai satu
		// respons yang berlangsung selama itu; WriteTimeout akan memutusnya di
		// tengah dan menghasilkan berkas profil rusak yang sulit dijelaskan.
	}
	go func() {
		// Server debug yang mati tidak boleh menjatuhkan aplikasi.
		_ = srv.Serve(ln)
	}()

	return ln.Addr().String(), func(ctx context.Context) error {
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
// KARDINALITAS: label profil punya batasan yang sama dengan label metrik --
// dan sumbernya pun harus sama-sama TEPERCAYA. Rute wajib berupa pola, bukan
// path mentah; ID permintaan tidak boleh dipakai sama sekali.
//
// tenantDari sengaja berupa fungsi yang membaca CONTEXT, bukan header.
// Mengambil tenant langsung dari `X-Tenant-ID` berarti nilainya ditulis
// klien: cukup kirim nilai berbeda tiap permintaan, dan setiap sampel menjadi
// unik sampai penyimpanan profil meledak. Itu ledakan kardinalitas yang bisa
// dipicu dari luar, tanpa perlu satu pun bug di sisi Anda.
func MiddlewareLabel(
	polaRute func(*http.Request) string,
	tenantFrom func(context.Context) string,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pair := []string{"rute", polaRute(r), "metode", r.Method}
			// Label kosong hanya menambah derau; lewati bila tenant tak dikenal.
			if t := tenantFrom(r.Context()); t != "" {
				pair = append(pair, "tenant", t)
			}
			// Do() memasang label pada goroutine ini SELAMA fn berjalan.
			pprof.Do(r.Context(), pprof.Labels(pair...), func(ctx context.Context) {
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
func MarkBackgroundTask(ctx context.Context, kind string, fn func(context.Context)) {
	pprof.Do(ctx, pprof.Labels("jenis_tugas", kind), fn)
}
```

## Uji

```go
package profiling

import (
	"context"
	"net"
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
	// Endpoint pprof membocorkan nama fungsi dan path berkas, dan bisa dipakai
	// menahan profiler. Ia TIDAK BOLEH mendengar di semua antarmuka.
	k := KonfigDefault("1.0.0", "id-jkt")
	host, _, err := net.SplitHostPort(k.AlamatDebug)
	if err != nil {
		t.Fatalf("alamat debug %q bukan host:port: %v", k.AlamatDebug, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		// Menangkap ":6060", "0.0.0.0:6060", dan "[::]:6060" sekaligus —
		// pemeriksaan lama hanya menangkap yang pertama.
		t.Fatalf("debug address %q is not limited to loopback", k.AlamatDebug)
	}
}

func TestMulai_MelaporkanGagalIkat(t *testing.T) {
	// Membuktikan kegagalan benar-benar dilaporkan. Versi lama menjalankan
	// ListenAndServe di goroutine dan membuang galatnya, sehingga port yang
	// sudah terpakai menghasilkan konstruktor "berhasil" tanpa endpoint apa pun.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	k := KonfigDefault("uji", "lokal")
	k.AlamatDebug = ln.Addr().String() // sudah terpakai
	if _, _, err := Start(k); err == nil {
		t.Fatal("Start must report error when address is already in use")
	}
}

func TestMulai_MemasangRateDanMelayaniProfil(t *testing.T) {
	k := KonfigDefault("uji", "lokal")
	k.AlamatDebug = "127.0.0.1:0" // port acak agar uji tidak bentrok

	alamat, stop, err := Start(k)
	if err != nil {
		t.Fatal(err)
	}
	if got := runtime.SetMutexProfileFraction(-1); got != k.MutexFraction {
		t.Errorf("MutexProfileFraction = %d, mau %d", got, k.MutexFraction)
	}
	// Catatan: runtime tidak menyediakan cara membaca BlockProfileRate yang
	// sedang aktif, jadi setelan itu tidak bisa diperiksa di sini — hanya
	// pelepasannya yang bisa dipastikan lewat kode.

	// Endpoint benar-benar melayani. Tanpa pemeriksaan ini, uji hanya
	// membuktikan konstruktor tidak melempar galat.
	resp, err := http.Get("http://" + alamat + "/debug/pprof/")
	if err != nil {
		t.Fatalf("debug endpoint unreachable: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /debug/pprof/ = %d, mau 200", resp.StatusCode)
	}

	ctx, batal := context.WithTimeout(context.Background(), 2*time.Second)
	defer batal()
	if err := stop(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if got := runtime.SetMutexProfileFraction(-1); got != 0 {
		t.Errorf("rate wajib dilepas saat shutdown, dapat %d", got)
	}
}

// tanpaTenant dipakai uji yang tidak menguji dimensi tenant.
func withoutTenant(context.Context) string { return "" }

func TestMiddlewareLabel_LabelTerpasangSelamaPermintaan(t *testing.T) {
	var terlihat bool
	h := MiddlewareLabel(func(*http.Request) string { return "/pesanan/{id}" }, withoutTenant)(
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
	var val string
	h := MiddlewareLabel(func(*http.Request) string { return "/pesanan/{id}" }, withoutTenant)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pprof.ForLabels(r.Context(), func(k, v string) bool {
				if k == "rute" {
					val = v
				}
				return true
			})
		}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/pesanan/99999", nil))

	if val == "/pesanan/99999" {
		t.Fatal("label memakai path mentah; kardinalitas akan meledak")
	}
}

// Header kiriman klien TIDAK boleh menjadi label. Uji ini membuktikan
// tenant hanya bisa masuk lewat context yang sudah terautentikasi.
func TestMiddlewareLabel_TenantTidakDariHeader(t *testing.T) {
	var tenantValue string
	h := MiddlewareLabel(func(*http.Request) string { return "/pesanan/{id}" }, withoutTenant)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pprof.ForLabels(r.Context(), func(k, v string) bool {
				if k == "tenant" {
					tenantValue = v
				}
				return true
			})
		}))

	req := httptest.NewRequest(http.MethodGet, "/pesanan/1", nil)
	req.Header.Set("X-Tenant-ID", "sembarang-nilai-unik-tiap-permintaan")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if tenantValue != "" {
		t.Fatalf("tenant label = %q, want empty — client sent value becomes label", tenantValue)
	}
}


func TestTandaiTugasLatar(t *testing.T) {
	var ok bool
	MarkBackgroundTask(context.Background(), "kirim_email", func(ctx context.Context) {
		pprof.ForLabels(ctx, func(k, v string) bool {
			if k == "jenis_tugas" && v == "kirim_email" {
				ok = true
			}
			return true
		})
	})
	if !ok {
		t.Fatal("background job must be labeled, otherwise it is unnamed in profile")
	}
}
```

## Anti-Pattern

**❌ SALAH — mengekspos pprof di port API publik**

```go
http.ListenAndServe(":8080", nil) // DefaultServeMux sudah memuat /debug/pprof
```

Siapa pun bisa mengambil profil Anda — yang membocorkan seluruh nama fungsi, path berkas mesin build, dan struktur internal. Dua penyalahgunaan yang lebih konkret dari sekadar "membebani CPU":

- `?seconds=300` menahan **profiler CPU** selama lima menit. Profil CPU bersifat eksklusif: selama itu berjalan, Anda **tidak bisa mengambil profil sendiri** — tepat saat insiden, alat diagnosis Anda dipegang orang asing.
- `/debug/pprof/heap?gc=1` **memaksa garbage collection** setiap kali dipanggil. Ini satu permintaan HTTP yang memicu jeda GC atas permintaan pihak luar, berulang sesuka mereka.

**✅ BENAR — mux sendiri, port terpisah, hanya loopback, agen yang mengambil**

```go
mux := http.NewServeMux()
mux.HandleFunc("/debug/pprof/", httppprof.Index) // dan seterusnya, lihat Mulai()
srv := &http.Server{Handler: mux}
ln, err := net.Listen("tcp", "127.0.0.1:6060")   // galatnya WAJIB diperiksa
```

Perhatikan: yang benar bukan sekadar "port terpisah", tetapi **mux terpisah**. Selama `_ "net/http/pprof"` diimpor, handler-nya terdaftar di `http.DefaultServeMux` — dan server mana pun yang kelak dijalankan dengan handler `nil` ikut mengekspos `/debug/pprof` tanpa ada yang pernah memutuskannya.

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

2. **`-ldflags "-s -w"` — yang hilang bukan yang biasa disangka.** Profil `runtime/pprof` **tetap tersimbolisasi penuh**: nama fungsi dan nomor barisnya berasal dari `pclntab`, tabel yang sama yang membuat panic tetap mencetak stack trace, dan `-s -w` tidak menghapusnya. Yang benar-benar terdampak adalah profiler **di luar proses**: agen berbasis eBPF/perf (mode itu ada pada Parca dan Pyroscope) yang membongkar stack dengan DWARF atau membaca tabel simbol ELF akan kehilangan informasi, begitu pula `gdb` dan `delve`. Putuskan berdasarkan cara agen Anda mengambil profil, bukan berdasarkan anggapan bahwa binary yang di-strip selalu buta.

3. **Agen sidecar menambah pemakaian memori per pod.** Pada armada besar, sidecar profiling dikalikan jumlah pod adalah angka yang nyata. Hitung sebelum memasang di seluruh cluster.

4. **Sampling membuat fungsi yang sangat cepat tampak tidak ada.** Profil CPU mengambil sampel 100 kali per detik. Fungsi yang selalu selesai dalam mikrodetik nyaris tidak pernah tertangkap — meskipun total waktunya besar. Untuk kasus itu, metrik dan trace lebih tepat.

5. **PGO memerlukan profil yang mewakili beban nyata.** Profil dari lingkungan uji menghasilkan optimasi yang menyasar jalur yang salah. Continuous profiling memberi sumber `default.pgo` yang benar — lihat `runtime_internals/pgo_profile_guided_optimization.md`.

6. **Retensi profil punya biaya penyimpanan.** Profil jauh lebih besar daripada metrik. Retensi tinggi untuk seluruh armada bisa mengejutkan di tagihan; simpan resolusi penuh untuk periode pendek dan turunkan resolusinya setelah itu.

7. **Label DIWARISKAN goroutine anak — dan justru itu masalahnya.** Pewarisan label terjadi di tingkat runtime: goroutine baru menyalin label dari goroutine yang membuatnya, **tanpa** memerlukan context. Konsekuensinya berlawanan dengan dugaan umum:
   - Goroutine yang di-spawn di dalam handler dan **hidup lebih lama** dari permintaan itu tetap membawa label `rute` dan `tenant` permintaan tersebut — selamanya. Pekerjaan latar yang berjalan berjam-jam akan terus dihitung sebagai beban satu endpoint yang sudah lama selesai, dan kesimpulan "endpoint X memakan 40% CPU" menjadi salah tanpa ada yang curiga.
   - Sebaliknya, worker pool yang dibuat **saat startup** tidak akan pernah mendapat label permintaan meski memproses pekerjaan yang berasal dari permintaan — karena ia lahir sebelum label apa pun terpasang. Worker seperti itu harus diberi label sendiri lewat `pprof.Do` di dalam loop kerjanya (lihat `TandaiTugasLatar`).

   Perhatikan juga bahwa `pprof.ForLabels(ctx, …)` membaca label dari **context**, bukan dari goroutine. Keduanya biasanya sinkron karena `pprof.Do` menyetel keduanya sekaligus, tetapi pada goroutine anak yang tidak menerima context, hanya label runtime-nya yang ikut.

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
| Endpoint profil tidak ada saat dibutuhkan | galat pengikatan saat start | Kegagalan listener ditelan goroutine |
| Beban latar dihitung sebagai beban satu endpoint | goroutine yang hidup melampaui permintaan | Label permintaan terwariskan dan tidak pernah dilepas |

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
