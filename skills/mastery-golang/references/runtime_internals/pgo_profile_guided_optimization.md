# PGO — Profile-Guided Optimization

> **Berlaku:** Go 1.21+ (stabil, aktif otomatis bila ada `default.pgo`) · **Lihat juga:** `runtime_internals/escape_analysis_pprof.md` · `testing_quality/benchmarking_pprof.md` · `ci_cd_pipeline/github_actions_go.md`

## Konsep Utama

Kompilator Go harus menebak. Fungsi mana yang layak di-*inline*? Cabang `if` mana yang lebih sering diambil? Tanpa informasi, ia memakai heuristik statis yang sama untuk semua kode — padahal jalur panas di service Anda hanya beberapa persen dari total kode.

**PGO memberi kompilator data nyata dari produksi.** Anda menaruh profil CPU di root modul dengan nama `default.pgo`, dan `go build` memakainya otomatis tanpa flag apa pun.

Perbaikan yang wajar diharapkan: **2–14%** throughput, tergantung bentuk beban. Ini bukan angka besar untuk satu fungsi, tapi ini **gratis** — tanpa mengubah satu baris kode, tanpa risiko perubahan perilaku. Pada armada 200 pod, 8% berarti 16 pod tidak perlu ada.

### Apa yang sebenarnya dilakukan kompilator

| Optimasi | Tanpa PGO | Dengan PGO |
| :--- | :--- | :--- |
| **Inlining agresif** | Ambang biaya seragam (~80) | Fungsi panas diberi ambang jauh lebih longgar |
| **Devirtualisasi** | Panggilan lewat interface selalu tidak langsung | Bila satu tipe konkret mendominasi, panggilannya diubah jadi langsung + guard |
| **Tata letak blok dasar** | Urutan sesuai penulisan | Cabang panas ditaruh berdekatan → lebih ramah cache instruksi |

Devirtualisasi adalah yang paling sering memberi hasil besar di kode Go idiomatik, karena kita banyak memakai interface (`io.Reader`, `Storer`, `Handler`). Bila 99% panggilan `s.Save()` sebenarnya menuju `*PostgresStore`, PGO mengubahnya menjadi panggilan langsung yang bisa di-inline.

### Aturan yang menentukan berhasil atau tidak

> Profil WAJIB berasal dari **beban produksi nyata**. Profil dari benchmark mikro atau dari lingkungan idle akan mengoptimalkan jalur yang salah — dan bisa membuat lebih lambat.

Ini kesalahan paling umum. Orang menjalankan `go test -cpuprofile`, menaruh hasilnya sebagai `default.pgo`, lalu heran kenapa tidak ada perbaikan. Profil test menggambarkan pola test, bukan pola pengguna.

## Diagram ASCII

```text
   SIKLUS PGO — profil produksi kembali jadi masukan build

   +---------------------+
   |  PRODUKSI berjalan  |
   |  net/http/pprof     |
   +----------+----------+
              | ambil profil 30-60 detik saat BEBAN PUNCAK
              v
   +---------------------+
   | cpu.pprof (banyak)  |  dari beberapa pod & beberapa waktu
   +----------+----------+
              | go tool pprof -proto a.pprof b.pprof > merged.pprof
              v
   +---------------------+
   | default.pgo di root |  DI-COMMIT ke repo
   +----------+----------+
              | go build  (otomatis, tanpa flag)
              v
   +---------------------+
   | biner teroptimasi   | --> deploy --> produksi (siklus berulang)
   +---------------------+

   ---------------------------------------------------------------

   DEVIRTUALISASI — kenapa hasilnya bisa besar

   TANPA PGO                      DENGAN PGO (99% -> *PostgresStore)
   -----------                    ---------------------------------
   call [itab.Save]               if type == *PostgresStore {
     ^                              <badan Save di-INLINE di sini>
     |                            } else {
     tidak bisa inline              call [itab.Save]   // jalur dingin
     tidak bisa lihat ke dalam    }
```

## Kode Go Production-Ready

Endpoint pengambil profil yang aman untuk produksi — dilindungi, dibatasi laju, dan tidak terbuka ke publik.

```go
package pgoserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime"
	"sync"
	"time"
)

// Config mengatur server profil internal.
type Config struct {
	Addr            string        // WAJIB alamat internal, mis. "127.0.0.1:6060"
	Token           string        // token bearer; kosong = tolak semua
	MaxDuration     time.Duration // batas atas ?seconds=
	MinAntarProfil  time.Duration // jeda minimum antar pengambilan
	Logger          *slog.Logger
}

// DefaultConfig memberi nilai aman untuk produksi.
func DefaultConfig() Config {
	return Config{
		Addr:           "127.0.0.1:6060",
		MaxDuration:    60 * time.Second,
		MinAntarProfil: 5 * time.Minute,
		Logger:         slog.Default(),
	}
}

// Server menyajikan endpoint pprof dengan pengaman.
type Server struct {
	cfg      Config
	mu       sync.Mutex
	terakhir time.Time
	srv      *http.Server
}

// ErrTokenSalah dikembalikan bila autentikasi gagal.
var ErrTokenSalah = errors.New("pgoserver: invalid token")

// New membangun server profil. Token diambil dari env agar tidak masuk kode.
func New(cfg Config) (*Server, error) {
	if cfg.Token == "" {
		cfg.Token = os.Getenv("PPROF_TOKEN")
	}
	if cfg.Token == "" {
		return nil, errors.New("pgoserver: PPROF_TOKEN is required")
	}
	if cfg.MaxDuration == 0 {
		cfg.MaxDuration = 60 * time.Second
	}
	s := &Server{cfg: cfg}

	mux := http.NewServeMux()
	mux.Handle("/debug/pprof/profile", s.jaga(http.HandlerFunc(pprof.Profile)))
	mux.Handle("/debug/pprof/heap", s.jaga(http.HandlerFunc(pprof.Index)))

	s.srv = &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// WriteTimeout WAJIB lebih besar dari MaxDuration, kalau tidak
		// pengambilan profil 60 detik akan terputus di tengah.
		WriteTimeout: cfg.MaxDuration + 30*time.Second,
	}
	return s, nil
}

// jaga membungkus handler dengan autentikasi dan pembatasan laju.
func (s *Server) jaga(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+s.cfg.Token {
			http.Error(w, ErrTokenSalah.Error(), http.StatusUnauthorized)
			return
		}
		// Profiling CPU menambah overhead ~5%. Dua pengambilan bersamaan
		// pada pod yang sama membuat profilnya sendiri tidak representatif.
		s.mu.Lock()
		sejak := time.Since(s.terakhir)
		if sejak < s.cfg.MinAntarProfil {
			s.mu.Unlock()
			w.Header().Set("Retry-After",
				fmt.Sprintf("%d", int((s.cfg.MinAntarProfil-sejak).Seconds())))
			http.Error(w, "too frequent", http.StatusTooManyRequests)
			return
		}
		s.terakhir = time.Now()
		s.mu.Unlock()

		s.cfg.Logger.Info("profile capture started",
			"remote", r.RemoteAddr, "path", r.URL.Path, "goroutine", runtime.NumGoroutine())
		next.ServeHTTP(w, r)
	})
}

// Start menjalankan server dan mengembalikan alamat yang benar-benar dipakai.
func (s *Server) Start() (net.Addr, error) {
	ln, err := net.Listen("tcp", s.cfg.Addr)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", s.cfg.Addr, err)
	}
	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.cfg.Logger.Error("profile server stopped", "err", err)
		}
	}()
	return ln.Addr(), nil
}

// Shutdown menghentikan server dengan rapi.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.srv.Shutdown(ctx)
}
```

## Uji

```go
package pgoserver

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"
)

func serverUji(t *testing.T, minJeda time.Duration) (string, func()) {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Addr = "127.0.0.1:0"
	cfg.Token = "test-secret"
	cfg.MinAntarProfil = minJeda
	cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	s, err := New(cfg)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	addr, err := s.Start()
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return "http://" + addr.String(), func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.Shutdown(ctx)
	}
}

func minta(t *testing.T, url, token string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func TestJaga_TanpaTokenDitolak(t *testing.T) {
	base, stop := serverUji(t, 0)
	defer stop()
	if got := minta(t, base+"/debug/pprof/heap", ""); got != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", got)
	}
}

func TestJaga_TokenSalahDitolak(t *testing.T) {
	base, stop := serverUji(t, 0)
	defer stop()
	if got := minta(t, base+"/debug/pprof/heap", "invalid"); got != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", got)
	}
}

func TestJaga_PembatasanLaju(t *testing.T) {
	base, stop := serverUji(t, time.Hour)
	defer stop()

	if got := minta(t, base+"/debug/pprof/heap", "test-secret"); got != http.StatusOK {
		t.Fatalf("first request want 200, got %d", got)
	}
	if got := minta(t, base+"/debug/pprof/heap", "test-secret"); got != http.StatusTooManyRequests {
		t.Fatalf("second request want 429, got %d", got)
	}
}

func TestNew_TanpaTokenGagal(t *testing.T) {
	t.Setenv("PPROF_TOKEN", "")
	cfg := DefaultConfig()
	if _, err := New(cfg); err == nil {
		t.Fatal("want error on empty token")
	}
}
```

Alur pengambilan sampai build:

```bash
# 1. Ambil profil saat BEBAN PUNCAK, dari beberapa pod
for pod in $(kubectl get pod -l app=order -o name | head -5); do
  kubectl exec "$pod" -- curl -s -H "Authorization: Bearer $PPROF_TOKEN" \
    "localhost:6060/debug/pprof/profile?seconds=45" > "prof-${pod##*/}.pprof"
done

# 2. Gabungkan — satu pod tidak mewakili armada
go tool pprof -proto prof-*.pprof > default.pgo

# 3. Commit ke root modul. go build memakainya OTOMATIS.
git add default.pgo && git commit -m "chore: perbarui profil PGO"

# 4. Verifikasi PGO benar-benar aktif
go build -pgo=auto -x ./... 2>&1 | grep -c preprofile   # >0 berarti aktif
go version -m ./bin/app | grep pgo                       # tercatat di metadata biner
```

## Anti-Pattern

**❌ SALAH — profil dari benchmark atau lingkungan idle**

```bash
go test -bench=. -cpuprofile=cpu.out ./...
cp cpu.out default.pgo    # menggambarkan pola BENCHMARK, bukan pengguna
```

Benchmark memanggil sedikit fungsi berulang kali. Kompilator akan mengoptimalkan jalur itu dan **mengabaikan** jalur produksi yang sesungguhnya panas. Hasil paling umum: nol perbaikan; hasil paling buruk: regresi karena kode dingin ikut membengkak dan menekan cache instruksi.

**✅ BENAR — profil produksi saat puncak, digabung dari beberapa sumber**

```bash
# Puncak trafik, beberapa pod, beberapa waktu berbeda dalam sepekan
go tool pprof -proto senin-siang-*.pprof rabu-malam-*.pprof > default.pgo
```

**❌ SALAH — profil dibiarkan basi berbulan-bulan**

```text
default.pgo  terakhir diperbarui 14 bulan lalu
```

Kode sudah berubah total. Fungsi yang tercatat panas mungkin sudah dihapus. PGO tidak akan rusak — sebutan fungsi yang hilang diabaikan diam-diam — tapi manfaatnya menguap tanpa ada yang menyadari.

**✅ BENAR — perbarui terjadwal, dengan bukti**

```yaml
# .github/workflows/pgo-refresh.yml — bulanan
- name: Ambil profil produksi
  run: ./scripts/ambil-profil.sh > default.pgo
- name: Bandingkan sebelum/sesudah
  run: |
    go build -pgo=off -o app-off ./cmd/app
    go build -pgo=auto -o app-on ./cmd/app
    ./scripts/bench-compare.sh app-off app-on | tee hasil.txt
- name: Buka PR bila membaik
  run: gh pr create --title "chore: perbarui default.pgo" --body-file hasil.txt
```

**❌ SALAH — endpoint pprof terbuka tanpa perlindungan**

```go
import _ "net/http/pprof" // mendaftar ke DefaultServeMux

func main() {
	http.ListenAndServe(":8080", nil) // pprof ikut terekspos ke publik
}
```

Siapa pun bisa memicu profiling terus-menerus (DoS ringan) dan mengunduh `/debug/pprof/heap` yang bisa memuat isi memori — termasuk token dan data pengguna.

**✅ BENAR — port internal terpisah, token, dan pembatasan laju**

Lihat `pgoserver` di atas: mux terpisah, `127.0.0.1`, bearer token dari env, dan jeda minimum antar pengambilan.

## Kasus Tepi Produksi

1. **Waktu build naik 5–15%.** PGO membuat kompilator bekerja lebih keras, terutama pada inlining. Pada monorepo besar ini terasa di CI. Mitigasi: aktifkan PGO hanya pada build rilis, bukan pada build cek cepat per-commit.

2. **Biner membesar.** Inlining agresif menambah ukuran, biasanya 2–10%. Untuk kontainer ini tidak berarti; untuk target embedded atau fungsi serverless yang menagih ukuran artefak, ukur dulu — lihat `embedded_tinygo/`.

3. **Profil dari satu pod tidak mewakili armada.** Pod yang kebetulan menangani tenant besar punya bentuk beban berbeda. Selalu gabungkan minimal 3–5 pod dari waktu yang berbeda. `go tool pprof -proto` menjumlahkan sampelnya dengan benar.

4. **Devirtualisasi bisa berbalik merugikan.** Bila distribusi tipe berubah setelah profil diambil — misalnya Anda menambah implementasi kedua yang kini mendominasi — guard tipe akan selalu meleset dan menambah satu cabang tanpa manfaat. Gejalanya: PGO memberi hasil lebih buruk daripada tanpa PGO. Perbarui profil.

5. **Cross-compile tetap aman.** `default.pgo` bersifat agnostik arsitektur pada level yang dipakai kompilator, jadi profil dari `linux/amd64` boleh dipakai membangun `linux/arm64`. Manfaatnya sedikit berkurang, tapi tidak merusak.

6. **Reproducible build tetap terjaga.** Selama `default.pgo` ada di repo dan tidak berubah, keluaran build tetap deterministik. Yang DILARANG adalah mengambil profil saat build berjalan — itu membuat biner tidak bisa direproduksi.

## Kapan JANGAN Pakai Ini

- **Sebelum optimasi algoritmik selesai.** PGO memberi 2–14%; memperbaiki N+1 query memberi 10x. Kejar yang besar dulu — lihat `db_sqlc/query_optimization_n_plus_one.md`.
- **Service yang terikat I/O.** Kalau 95% waktu dihabiskan menunggu jaringan atau disk, mengoptimalkan CPU tidak mengubah apa pun yang terasa pengguna.
- **Tanpa kemampuan mengukur.** PGO tanpa benchmark sebelum/sesudah adalah kepercayaan buta. Bila Anda tidak bisa membuktikan perbaikannya, Anda juga tidak akan tahu saat profilnya jadi merugikan.
- **Beban yang bentuknya berubah drastis tiap hari.** Sistem batch yang paginya ETL dan sorenya API tidak punya satu profil yang mewakili. Kalau harus, ambil dari jalur yang paling menentukan biaya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| CPU tinggi tapi profil datar tanpa puncak jelas | `pprof -top` | Beban tersebar; PGO memberi sedikit. Cari masalah arsitektur. |
| Satu fungsi >15% total sampel | `pprof -top -cum` | Kandidat kuat PGO **dan** kandidat optimasi manual |
| Banyak waktu di `runtime.duffcopy`, `runtime.mallocgc` | `pprof -top` | Masalah alokasi, bukan inlining. Lihat `escape_analysis_pprof.md`. |
| PGO aktif tapi tidak ada perbaikan | bandingkan tanggal `default.pgo` dengan riwayat kode | Profil basi, atau diambil dari lingkungan yang salah |
| p99 memburuk setelah mengaktifkan PGO | benchmark sebelum/sesudah | Kemungkinan devirtualisasi meleset; perbarui profil atau matikan |

```bash
# Apakah biner yang berjalan benar-benar dibangun dengan PGO?
go version -m /proc/1/exe | grep -E 'pgo|build\s+-pgo'

# Fungsi paling panas — kandidat PGO sekaligus kandidat optimasi manual
go tool pprof -top -nodecount=20 default.pgo

# Umur profil
git log -1 --format='%ar' -- default.pgo
```
