# Stdlib Modern — `slices`, `maps`, `sync.OnceValue`, `unique`, `weak`

> **Berlaku:** `slices`/`maps`/`sync.OnceFunc` Go 1.21+ · `maps.Keys` sebagai iterator Go 1.23+ · `unique` & `weak` Go 1.24+ · **Lihat juga:** `runtime_internals/iterators_range_over_func.md` · `runtime_internals/memory_allocator_arenas.md` · `concurrency/sync_primitives_deep.md`

## Konsep Utama

Setiap basis kode Go yang berumur lebih dari dua tahun memuat berkas `utils` berisi `Contains`, `Map`, `Filter`, `Keys`, dan `Min` versi sendiri. Sejak Go 1.21 sebagian besar sudah ada di stdlib — ditulis lebih hati-hati, diuji lebih keras, dan sering lebih cepat karena kompilator mengenalinya.

Menghapus kode adalah bentuk kontribusi yang paling jarang dihargai tapi paling bernilai. Berkas `utils` bukan cuma duplikasi: ia adalah tempat bug bersembunyi (`Contains` yang tidak menangani `NaN`, `Min` yang panic pada slice kosong) dan tempat pendatang baru tersesat.

### Peta pengganti

| Kode tulis tangan | Pengganti stdlib | Sejak |
| :--- | :--- | :--- |
| loop `for` cari elemen | `slices.Contains`, `slices.Index` | 1.21 |
| bandingkan dua slice | `slices.Equal`, `slices.EqualFunc` | 1.21 |
| `sort.Slice` dengan closure | `slices.Sort`, `slices.SortFunc` | 1.21 |
| binary search manual | `slices.BinarySearch` | 1.21 |
| `min`/`max` tulis tangan | `min()`, `max()` **builtin** | 1.21 |
| kumpulkan kunci map | `maps.Keys` (iterator) + `slices.Sorted` | 1.23 |
| `sync.Once` + variabel hasil | `sync.OnceValue`, `sync.OnceValues` | 1.21 |
| interning string manual | `unique.Make` | 1.24 |
| cache yang menahan memori | `weak.Pointer` | 1.24 |

### Yang paling sering salah dipakai

**`slices.Sorted(maps.Keys(m))`** — sejak 1.23 `maps.Keys` mengembalikan `iter.Seq[K]`, bukan slice. Banyak contoh lama di internet masih memakai `golang.org/x/exp/maps` yang mengembalikan slice. Keduanya bernama sama, perilakunya berbeda.

**`sync.OnceValue`** menggantikan pola yang selalu ditulis salah:

```go
// Pola lama: mudah lupa, mudah race saat inisialisasi.
var (
	once sync.Once
	cfg  *Config
	err  error
)
func Get() (*Config, error) {
	once.Do(func() { cfg, err = load() })
	return cfg, err
}
```

**`unique.Make`** adalah interning: string identik dijamin menempati satu alokasi. Pada sistem yang menyimpan jutaan label berulang (nama tenant, kode negara, label metrik), penghematannya besar dan perbandingannya jadi perbandingan pointer.

**`weak.Pointer`** memungkinkan cache yang **tidak** mencegah GC membebaskan objek. Ini menutup satu kelas kebocoran memori klasik: cache yang tumbuh selamanya karena tiap entri adalah referensi kuat.

## Diagram ASCII

```text
   unique.Handle — interning menghapus duplikasi

   TANPA interning: 1 juta baris log, tiap baris punya tenant "acme-corp"
   
   heap:
   [ "acme-corp" ][ "acme-corp" ][ "acme-corp" ] ... x 1.000.000
     10 byte        10 byte        10 byte          = ~10 MB + header

   DENGAN unique.Make:
   
   heap:
   [ "acme-corp" ]  <-- SATU salinan
        ^  ^  ^
        |  |  |     Handle[string] = pointer 8 byte
   [h1][h2][h3] ... x 1.000.000   = ~8 MB pointer, 1 salinan string
   
   Bonus: h1 == h2 adalah perbandingan POINTER, bukan perbandingan byte.

   ---------------------------------------------------------------

   weak.Pointer — cache yang tidak menahan memori

   REFERENSI KUAT (cache biasa)        REFERENSI LEMAH (weak)
   ---------------------------         ----------------------
   map[id]*Gambar                      map[id]*weak.Pointer[Gambar]
        |                                   |
        v                                   v  (tidak dihitung GC)
   [ Gambar 8 MB ]                     [ Gambar 8 MB ]
        ^                                   ^
        `- GC TIDAK BISA membebaskan        `- GC BOLEH membebaskan
           selama masih di map                 saat tekanan memori

   cache tumbuh selamanya -> OOM       Value() mengembalikan nil,
                                        muat ulang bila perlu
```

## Kode Go Production-Ready

```go
package katalog

import (
	"cmp"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"unique"
)

// Produk adalah entri katalog.
type Produk struct {
	SKU    string
	Nama   string
	Harga  int64 // dalam sen, DILARANG float untuk uang
	Tenant unique.Handle[string]
}

// NewProduk membuat produk dengan tenant yang di-intern.
// Pada 1 juta produk milik 50 tenant, ini menyimpan 50 string, bukan 1 juta.
func NewProduk(sku, nama string, harga int64, tenant string) Produk {
	return Produk{
		SKU:    sku,
		Nama:   nama,
		Harga:  harga,
		Tenant: unique.Make(tenant),
	}
}

// Katalog menyimpan produk terindeks SKU.
type Katalog struct {
	mu    sync.RWMutex
	items map[string]Produk
}

// NewKatalog membuat katalog kosong.
func NewKatalog() *Katalog {
	return &Katalog{items: make(map[string]Produk)}
}

// ErrTidakAda dikembalikan bila SKU tidak ditemukan.
var ErrTidakAda = errors.New("katalog: SKU tidak ada")

// Tambah menyisipkan atau menimpa produk.
func (k *Katalog) Tambah(p Produk) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[p.SKU] = p
}

// Ambil mengembalikan produk berdasarkan SKU.
func (k *Katalog) Ambil(sku string) (Produk, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	p, ok := k.items[sku]
	if !ok {
		return Produk{}, fmt.Errorf("%w: %s", ErrTidakAda, sku)
	}
	return p, nil
}

// SKUTerurut mengembalikan seluruh SKU dalam urutan stabil.
//
// maps.Keys sejak Go 1.23 mengembalikan iter.Seq[K], BUKAN slice.
// slices.Sorted mengumpulkan sekaligus mengurutkannya dalam satu langkah.
func (k *Katalog) SKUTerurut() []string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return slices.Sorted(maps.Keys(k.items))
}

// TenantUnik mengembalikan daftar tenant tanpa duplikat, terurut.
// Perbandingan Handle adalah perbandingan pointer — jauh lebih murah
// daripada membandingkan string byte demi byte.
func (k *Katalog) TenantUnik() []string {
	k.mu.RLock()
	terlihat := make(map[unique.Handle[string]]struct{})
	for _, p := range k.items {
		terlihat[p.Tenant] = struct{}{}
	}
	k.mu.RUnlock()

	out := make([]string, 0, len(terlihat))
	for h := range terlihat {
		out = append(out, h.Value())
	}
	slices.Sort(out)
	return out
}

// TermurahPerTenant mengembalikan produk termurah tiap tenant.
func (k *Katalog) TermurahPerTenant() map[string]Produk {
	k.mu.RLock()
	defer k.mu.RUnlock()

	out := make(map[string]Produk)
	for _, p := range k.items {
		t := p.Tenant.Value()
		cur, ada := out[t]
		if !ada || p.Harga < cur.Harga {
			out[t] = p
		}
	}
	return out
}

// UrutkanUntukTampilan mengurutkan berdasarkan harga naik, lalu nama.
// slices.SortFunc + cmp.Or menggantikan sort.Slice berlapis if.
func UrutkanUntukTampilan(ps []Produk) {
	slices.SortFunc(ps, func(a, b Produk) int {
		return cmp.Or(
			cmp.Compare(a.Harga, b.Harga),
			strings.Compare(a.Nama, b.Nama),
		)
	})
}

// CariHarga melakukan binary search pada slice yang SUDAH terurut harga.
// Mengembalikan indeks dan apakah nilainya persis ditemukan.
func CariHarga(ps []Produk, harga int64) (int, bool) {
	return slices.BinarySearchFunc(ps, harga, func(p Produk, target int64) int {
		return cmp.Compare(p.Harga, target)
	})
}

// MuatKonfigurasi diinisialisasi tepat sekali, aman dari race.
// sync.OnceValues menggantikan pola sync.Once + dua variabel global.
var MuatKonfigurasi = sync.OnceValues(func() (map[string]string, error) {
	cfg := map[string]string{"mata_uang": "IDR", "zona": "Asia/Jakarta"}
	if len(cfg) == 0 {
		return nil, errors.New("katalog: konfigurasi kosong")
	}
	return cfg, nil
})
```

Cache lemah untuk objek besar:

```go
package gambar

import (
	"sync"
	"weak"
)

// Cache menyimpan gambar TANPA mencegah GC membebaskannya.
// Cocok untuk objek besar yang mahal dibuat tapi bisa dibuat ulang.
type Cache struct {
	mu    sync.Mutex
	items map[string]weak.Pointer[Gambar]
	muat  func(string) (*Gambar, error)
}

// Gambar adalah objek besar (mis. bitmap ter-dekode).
type Gambar struct {
	ID   string
	Data []byte
}

// NewCache membuat cache lemah dengan pemuat tertentu.
func NewCache(muat func(string) (*Gambar, error)) *Cache {
	return &Cache{items: make(map[string]weak.Pointer[Gambar]), muat: muat}
}

// Ambil mengembalikan gambar dari cache bila masih hidup, atau memuat ulang.
func (c *Cache) Ambil(id string) (*Gambar, error) {
	c.mu.Lock()
	if wp, ada := c.items[id]; ada {
		if g := wp.Value(); g != nil {
			c.mu.Unlock()
			return g, nil // masih hidup
		}
		// Sudah dibebaskan GC. Bersihkan entri mati agar map tidak tumbuh.
		delete(c.items, id)
	}
	c.mu.Unlock()

	g, err := c.muat(id)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.items[id] = weak.Make(g)
	c.mu.Unlock()
	return g, nil
}
```

## Uji

```go
package katalog

import (
	"slices"
	"testing"
	"unique"
)

func katalogUji() *Katalog {
	k := NewKatalog()
	k.Tambah(NewProduk("B-2", "Buku", 45_000, "acme"))
	k.Tambah(NewProduk("A-1", "Apel", 12_000, "acme"))
	k.Tambah(NewProduk("C-3", "Cangkir", 30_000, "beta"))
	return k
}

func TestSKUTerurut(t *testing.T) {
	got := katalogUji().SKUTerurut()
	want := []string{"A-1", "B-2", "C-3"}
	if !slices.Equal(got, want) {
		t.Fatalf("mau %v, dapat %v", want, got)
	}
}

func TestTenantUnik(t *testing.T) {
	got := katalogUji().TenantUnik()
	want := []string{"acme", "beta"}
	if !slices.Equal(got, want) {
		t.Fatalf("mau %v, dapat %v", want, got)
	}
}

func TestInterning_HandleSamaUntukStringSama(t *testing.T) {
	a := unique.Make("acme-corp")
	b := unique.Make("acme" + "-corp") // dibangun runtime, bukan konstanta
	if a != b {
		t.Fatal("handle untuk string identik WAJIB sama")
	}
	if a.Value() != "acme-corp" {
		t.Fatalf("Value() rusak: %q", a.Value())
	}
}

func TestTermurahPerTenant(t *testing.T) {
	got := katalogUji().TermurahPerTenant()
	if got["acme"].SKU != "A-1" {
		t.Fatalf("termurah acme mau A-1, dapat %s", got["acme"].SKU)
	}
	if got["beta"].SKU != "C-3" {
		t.Fatalf("termurah beta mau C-3, dapat %s", got["beta"].SKU)
	}
}

func TestUrutkanDanCari(t *testing.T) {
	ps := []Produk{
		NewProduk("C", "Cangkir", 30_000, "t"),
		NewProduk("A", "Apel", 12_000, "t"),
		NewProduk("B", "Buku", 45_000, "t"),
	}
	UrutkanUntukTampilan(ps)
	if ps[0].SKU != "A" || ps[2].SKU != "B" {
		t.Fatalf("urutan salah: %v %v %v", ps[0].SKU, ps[1].SKU, ps[2].SKU)
	}
	if i, ok := CariHarga(ps, 30_000); !ok || i != 1 {
		t.Fatalf("cari 30000 mau (1,true), dapat (%d,%v)", i, ok)
	}
	if _, ok := CariHarga(ps, 99_999); ok {
		t.Fatal("harga yang tidak ada seharusnya ok=false")
	}
}

func TestUrutkanUntukTampilan_PengurutStabilPadaHargaSama(t *testing.T) {
	ps := []Produk{
		NewProduk("Z", "Zebra", 10_000, "t"),
		NewProduk("A", "Apel", 10_000, "t"),
	}
	UrutkanUntukTampilan(ps)
	if ps[0].Nama != "Apel" {
		t.Fatalf("harga sama harus diurut nama, dapat %s duluan", ps[0].Nama)
	}
}

func TestMuatKonfigurasi_HanyaSekali(t *testing.T) {
	a, err := MuatKonfigurasi()
	if err != nil {
		t.Fatalf("tak terduga: %v", err)
	}
	b, _ := MuatKonfigurasi()
	if &a == nil || len(a) != len(b) {
		t.Fatal("hasil pemanggilan kedua berbeda")
	}
}
```

## Anti-Pattern

**❌ SALAH — berkas `utils` yang mengulang stdlib**

```go
package utils

func Contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func Keys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out // urutan ACAK — sumber test rapuh klasik
}

func Min(xs []int) int {
	m := xs[0] // PANIC pada slice kosong
	for _, v := range xs[1:] {
		if v < m {
			m = v
		}
	}
	return m
}
```

Tiga fungsi, dua bug. `Keys` mengembalikan urutan acak sehingga test yang membandingkan hasilnya akan gagal sesekali. `Min` panic pada masukan kosong.

**✅ BENAR — stdlib, dengan urutan yang ditegaskan**

```go
slices.Contains(xs, x)
slices.Sorted(maps.Keys(m))   // eksplisit terurut, test jadi stabil
slices.Min(xs)                // tetap panic pada kosong — periksa len dulu
if len(xs) == 0 { return 0, ErrKosong }
```

**❌ SALAH — cache referensi kuat untuk objek besar**

```go
var cache = map[string]*Gambar{} // tumbuh selamanya

func Ambil(id string) *Gambar {
	if g, ok := cache[id]; ok {
		return g
	}
	g := muatGambar(id)
	cache[id] = g // GC TIDAK PERNAH bisa membebaskan
	return g
}
```

Pada 8 MB per gambar dan 10.000 id unik, ini 80 GB. OOM hanya soal waktu.

**✅ BENAR — `weak.Pointer`, GC boleh membebaskan saat tertekan**

Lihat `gambar.Cache` di atas. Perhatikan `delete(c.items, id)` saat `Value()` mengembalikan `nil` — tanpa itu, map entri-nya tetap tumbuh meski gambarnya sudah dibebaskan.

**❌ SALAH — `sync.Once` dengan variabel hasil terpisah**

```go
var (
	once sync.Once
	db   *sql.DB
	dbErr error
)

func DB() *sql.DB {
	once.Do(func() { db, dbErr = sql.Open("pgx", dsn) })
	return db // pemanggil LUPA memeriksa dbErr
}
```

**✅ BENAR — `sync.OnceValues` memaksa error ikut dikembalikan**

```go
var DB = sync.OnceValues(func() (*sql.DB, error) {
	return sql.Open("pgx", dsn)
})
// Pemanggil TIDAK BISA mengabaikan error; tanda tangannya memaksa.
```

## Kasus Tepi Produksi

1. **`maps.Keys` berubah makna antar versi.** Di `golang.org/x/exp/maps` ia mengembalikan slice; di stdlib sejak 1.23 ia mengembalikan `iter.Seq`. Kode yang menyalin contoh dari internet akan gagal kompilasi dengan pesan yang membingungkan. Periksa import-nya lebih dulu.

2. **`slices.Sort` pada `float64` dengan `NaN`.** Urutan `NaN` tidak terdefinisi pada perbandingan biasa. Pakai `slices.SortFunc` dengan `cmp.Compare` yang menangani `NaN` secara konsisten, atau saring `NaN` sebelum mengurutkan.

3. **`unique.Handle` menahan string selama handle-nya hidup.** Interning bukan gratis: string yang di-intern tidak akan dibebaskan selama ada handle yang merujuknya. Untuk nilai yang benar-benar unik (UUID per request), interning **menambah** memori, bukan mengurangi. Pakai hanya untuk nilai dengan kardinalitas rendah dan pengulangan tinggi.

4. **`weak.Pointer` tidak menjamin apa pun tentang kapan objek dibebaskan.** `Value()` bisa mengembalikan objek yang sama berkali-kali, lalu tiba-tiba `nil`. Kode WAJIB siap memuat ulang kapan saja. Jangan pakai weak untuk data yang mahal dimuat ulang tanpa lapisan cache kedua.

5. **`slices.Clip` vs `slices.Clone`.** `Clip` memotong kapasitas berlebih tanpa menyalin — berguna sebelum menyimpan slice jangka panjang agar array besar di belakangnya bisa dibebaskan. `Clone` menyalin. Keduanya sering tertukar dan menghasilkan kebocoran memori halus: menyimpan `s[:1]` dari slice 1 juta elemen menahan seluruh array.

6. **`slices.SortFunc` tidak stabil.** Untuk urutan stabil pakai `slices.SortStableFunc`. Bug ini muncul sebagai urutan tampilan yang berubah-ubah pada nilai yang sama — sulit dilacak karena tidak deterministik.

## Kapan JANGAN Pakai Ini

- **`unique` untuk nilai berkardinalitas tinggi.** UUID, timestamp, atau isi payload akan memperbesar tabel interning tanpa manfaat. Ukurannya justru bertambah.
- **`weak` untuk data yang wajib ada.** Session, kunci kriptografi, koneksi — semua yang kehilangannya berarti kegagalan fungsional. Weak hanya untuk cache yang benar-benar boleh meleset.
- **Migrasi massal `utils` di satu PR.** Perubahan mekanis pada 200 berkas mustahil direview — lihat `engineering_practice/code_review_go.md`. Ganti per paket, per PR, dengan test yang sudah ada sebagai jaring pengaman.
- **Pustaka yang harus mendukung Go 1.20 ke bawah.** `slices`/`maps` baru di 1.21, `unique`/`weak` di 1.24. Untuk pustaka publik, cek matriks dukungan Anda dulu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Heap didominasi banyak string pendek identik | `pprof -top` pada profil heap, cari `runtime.stringtoslicebyte` | Kandidat kuat `unique.Make` |
| Cache tumbuh monoton, tidak pernah turun | `len(cache)` sebagai metrik | Referensi kuat menahan objek; kandidat `weak.Pointer` |
| Test kadang gagal pada perbandingan urutan | test yang membandingkan hasil iterasi map | Urutan map acak; bungkus dengan `slices.Sorted` |
| Panic `index out of range` pada agregasi | stack trace ke fungsi `utils` | Fungsi tulis tangan tanpa penjagaan slice kosong |
| Alokasi tinggi di jalur pengurutan | `pprof -top` menampilkan `sort.Slice` | `sort.Slice` memakai refleksi; `slices.SortFunc` bebas refleksi |

```bash
# Berapa banyak kode yang bisa dihapus?
grep -rn "func Contains\|func Keys\|func Values\|func Map\[\|func Filter\[\|func Min\|func Max" \
  --include="*.go" internal/ pkg/ | wc -l

# Masih memakai x/exp yang sudah ada di stdlib?
grep -rn "golang.org/x/exp/slices\|golang.org/x/exp/maps" --include="*.go" .

# sort.Slice yang bisa jadi slices.SortFunc (bebas refleksi)
grep -rn "sort.Slice(" --include="*.go" . | wc -l

# Duplikasi string di heap
go tool pprof -sample_index=inuse_space -top http://localhost:6060/debug/pprof/heap | head -25
```
