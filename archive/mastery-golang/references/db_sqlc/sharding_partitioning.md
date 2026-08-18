# Partitioning & Sharding — Memilih Kunci yang Tidak Bisa Ditarik Kembali

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `db_sqlc/read_replica_routing.md` · `db_sqlc/index_design_explain_analyze.md` · `db_sqlc/zero_downtime_migrations.md`

## Konsep Utama

Sharding adalah keputusan arsitektur yang **paling sulit dibatalkan** dalam sebuah sistem. Setelah data tersebar di banyak database, `JOIN` hilang, transaksi lintas shard hilang, `AUTO INCREMENT` hilang, dan `COUNT(*)` global menjadi pekerjaan terjadwal. Memilih shard key yang salah berarti migrasi berbulan-bulan.

Karena itu urutan eskalasinya WAJIB dihormati, dan sharding ada di paling akhir:

```
1. Perbaiki query     -> index, hilangkan N+1        (hari)
2. Perbesar mesin     -> vertical scaling            (jam, sampai batas fisik)
3. Read replica       -> sebar beban baca            (hari)
4. Partitioning       -> satu DB, banyak tabel fisik (minggu)
5. Sharding           -> banyak DB                   (bulan, sekali jalan)
```

Sebagian besar sistem yang "butuh sharding" sebenarnya berhenti di langkah 1. Mesin modern dengan NVMe sanggup memegang tabel puluhan miliar baris bila index-nya benar.

### Partitioning ≠ Sharding

| | **Partitioning** | **Sharding** |
| :--- | :--- | :--- |
| Lokasi | satu database | banyak database |
| Diketahui aplikasi | tidak — SQL tetap sama | ya — routing eksplisit |
| `JOIN` antar bagian | bisa | tidak bisa |
| Transaksi | ACID penuh | hanya dalam satu shard |
| Yang diselesaikan | ukuran tabel, penghapusan massal, `VACUUM` | batas CPU/IOPS/koneksi satu mesin |

**Partitioning menyelesaikan masalah tabel besar. Sharding menyelesaikan masalah mesin penuh.** Keduanya sering tertukar, dan orang melakukan sharding padahal yang dibutuhkan hanya partitioning.

### Memilih shard key

Tiga syarat, dan ketiganya WAJIB terpenuhi:

1. **Ada di hampir semua query.** Bila query tidak membawa shard key, ia harus menyebar ke semua shard (fan-out) — lambat dan tidak menskala.
2. **Sebarannya rata.** Shard key `negara` membuat satu shard memuat 80% data.
3. **Tidak berubah.** Mengubah shard key berarti memindahkan baris antar database.

| Kandidat | Penilaian |
| :--- | :--- |
| `tenant_id` / `organisasi_id` | ✅ Terbaik untuk SaaS B2B — batas alami, ada di semua query |
| `pengguna_id` | ✅ Baik untuk B2C — kecuali ada fitur sosial lintas pengguna |
| `id` acak (UUID) | ⚠️ Sebaran rata, tapi setiap query berdasarkan atribut lain jadi fan-out |
| waktu (`dibuat_pada`) | ❌ Untuk sharding: semua tulis menumpuk di satu shard. ✅ Untuk **partitioning** |
| `negara` / `wilayah` | ❌ Sebaran sangat timpang |

### Logical shard: yang membuat rebalancing mungkin

Kesalahan paling mahal adalah memetakan kunci langsung ke mesin fisik:

```go
shard := hash(tenantID) % 4   // 4 = jumlah mesin
```

Menambah mesin kelima mengubah `% 4` menjadi `% 5`, dan **hampir semua baris berpindah tempat**.

Pemecahannya: sisipkan lapisan **logical shard** yang jumlahnya besar dan tetap selamanya, lalu petakan ke mesin fisik lewat tabel yang bisa diubah.

```go
logis := hash(tenantID) % 4096   // TETAP selamanya
fisik := petaShard[logis]         // bisa diubah kapan saja
```

Rebalancing menjadi: pindahkan sebagian logical shard, perbarui petanya. Inilah yang dipakai Vitess, Notion, dan Figma. Consistent hashing memecahkan masalah yang sama, tapi memindahkan baris **acak** — dengan peta eksplisit Anda memindahkan blok yang Anda pilih sendiri, dan bisa memeriksanya sebelum beralih.

## Diagram ASCII

```text
   TANPA LOGICAL SHARD -- menambah mesin = memindahkan hampir semua data

   hash(kunci) % 4          hash(kunci) % 5
   tenant A -> mesin 2  ==> tenant A -> mesin 0   pindah
   tenant B -> mesin 1  ==> tenant B -> mesin 4   pindah
   tenant C -> mesin 3  ==> tenant C -> mesin 3   tetap
                            ~80% data berpindah

   ---------------------------------------------------------------

   DENGAN LOGICAL SHARD -- pemetaan dua lapis

   kunci --hash%4096--> logical shard --peta--> mesin fisik
                        (TETAP selamanya)       (bisa diubah)

     logis 0..1023   ---+
     logis 1024..2047 --+--> db-01
     logis 2048..3071 -----> db-02
     logis 3072..4095 -----> db-03

   Menambah db-04: pindahkan logis 1024..2047 saja, lalu ubah peta.
   Yang lain tidak tersentuh.

   ---------------------------------------------------------------

   FAN-OUT -- ongkos query tanpa shard key

   WHERE tenant_id = 42        -> 1 shard    ~2ms
   WHERE email = 'a@b.com'     -> SEMUA shard
        db-01 --+
        db-02 --+--> gabung --> latensi = shard TERLAMBAT
        db-03 --+              satu shard lambat = semua lambat
        db-04 --+              satu shard mati   = hasil tidak lengkap

   Solusi: tabel pencarian global email -> tenant_id, lalu 1 shard.
```

## Kode Go Production-Ready

```go
package shard

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"sync"
	"sync/atomic"
)

// JumlahLogis adalah banyaknya logical shard. Nilai ini WAJIB tetap
// selamanya — mengubahnya memetakan ulang seluruh data. Pilih angka
// yang jauh lebih besar dari jumlah mesin yang pernah dibayangkan.
const JumlahLogis = 4096

// Fisik adalah satu database fisik.
type Fisik struct {
	Nama string
	DB   *sql.DB
}

// Peta memetakan logical shard ke database fisik. Bersifat immutable:
// rebalancing membuat Peta baru dan menukarnya secara atomik, sehingga
// query yang sedang berjalan tidak pernah melihat peta setengah jadi.
type Peta struct {
	Versi int
	// slot[i] = fisik yang memegang logical shard i.
	slot [JumlahLogis]*Fisik
	// pindahKe[i] = tujuan bila logical shard i sedang dipindahkan.
	// Selama migrasi, tulis pergi ke asal DAN tujuan; baca dari asal.
	pindahKe map[int]*Fisik
}

// Rentang menyatakan bahwa logical shard [Dari,Sampai] dipegang oleh Fisik.
type Rentang struct {
	Dari, Sampai int
	Fisik        *Fisik
}

var (
	ErrPetaTidakLengkap = errors.New("shard: ada logical shard tanpa pemilik")
	ErrRentangTumpang   = errors.New("shard: rentang logical shard tumpang tindih")
)

// BangunPeta membangun peta dan MEMVERIFIKASI bahwa seluruh 4096 slot
// terisi tepat satu kali. Peta yang bolong menyebabkan data hilang
// diam-diam, jadi ini divalidasi saat boot, bukan saat query.
func BangunPeta(versi int, rentang []Rentang) (*Peta, error) {
	p := &Peta{Versi: versi, pindahKe: make(map[int]*Fisik)}

	urut := make([]Rentang, len(rentang))
	copy(urut, rentang)
	sort.Slice(urut, func(i, j int) bool { return urut[i].Dari < urut[j].Dari })

	for _, r := range urut {
		if r.Dari < 0 || r.Sampai >= JumlahLogis || r.Dari > r.Sampai {
			return nil, fmt.Errorf("shard: rentang [%d,%d] di luar 0..%d",
				r.Dari, r.Sampai, JumlahLogis-1)
		}
		for i := r.Dari; i <= r.Sampai; i++ {
			if p.slot[i] != nil {
				return nil, fmt.Errorf("%w: logis %d diklaim %q dan %q",
					ErrRentangTumpang, i, p.slot[i].Nama, r.Fisik.Nama)
			}
			p.slot[i] = r.Fisik
		}
	}
	for i, f := range p.slot {
		if f == nil {
			return nil, fmt.Errorf("%w: logis %d", ErrPetaTidakLengkap, i)
		}
	}
	return p, nil
}

// TandaiPindah menandai bahwa sederet logical shard sedang bermigrasi.
func (p *Peta) TandaiPindah(dari, sampai int, tujuan *Fisik) {
	for i := dari; i <= sampai; i++ {
		p.pindahKe[i] = tujuan
	}
}

// Logis memetakan shard key ke nomor logical shard.
// FNV-1a dipilih karena stabil lintas versi Go dan lintas arsitektur —
// maphash TIDAK boleh dipakai di sini karena benihnya acak tiap proses.
func Logis(kunci string) int {
	h := fnv.New64a()
	_, _ = h.Write([]byte(kunci)) // Write pada hash tidak pernah gagal
	return int(h.Sum64() % JumlahLogis)
}

// Cluster adalah pintu masuk seluruh akses data ber-shard.
type Cluster struct {
	peta   atomic.Pointer[Peta]
	semua  []*Fisik
	maksPr int // batas paralelisme fan-out
}

// New membangun cluster. Daftar `semua` dipakai untuk fan-out.
func New(p *Peta, semua []*Fisik, maksParalel int) *Cluster {
	if maksParalel <= 0 {
		maksParalel = 8
	}
	c := &Cluster{semua: semua, maksPr: maksParalel}
	c.peta.Store(p)
	return c
}

// TukarPeta mengganti peta secara atomik setelah rebalancing.
func (c *Cluster) TukarPeta(p *Peta) { c.peta.Store(p) }

// Untuk mengembalikan database yang memegang shard key ini.
func (c *Cluster) Untuk(kunci string) *sql.DB {
	return c.peta.Load().slot[Logis(kunci)].DB
}

// TujuanTulis mengembalikan SEMUA database yang wajib menerima tulis
// untuk kunci ini. Selama migrasi jumlahnya dua — asal dan tujuan —
// sehingga peralihan peta tidak kehilangan tulis yang terjadi di sela.
func (c *Cluster) TujuanTulis(kunci string) []*sql.DB {
	p := c.peta.Load()
	l := Logis(kunci)
	out := []*sql.DB{p.slot[l].DB}
	if t, ada := p.pindahKe[l]; ada && t != p.slot[l] {
		out = append(out, t.DB)
	}
	return out
}

// HasilShard membawa hasil dari satu shard beserta kemungkinan galatnya.
type HasilShard[T any] struct {
	Shard string
	Nilai T
	Err   error
}

// Sebar menjalankan fn pada SEMUA shard secara paralel terbatas.
//
// Sengaja mengembalikan hasil per-shard, bukan satu galat gabungan:
// pemanggil WAJIB memutuskan sendiri apakah hasil parsial dapat diterima.
// Menyembunyikan kegagalan satu shard di balik slice yang tampak normal
// adalah cara paling halus menyajikan data tidak lengkap sebagai fakta.
func Sebar[T any](ctx context.Context, c *Cluster,
	fn func(context.Context, *Fisik) (T, error)) []HasilShard[T] {

	hasil := make([]HasilShard[T], len(c.semua))
	sem := make(chan struct{}, c.maksPr)
	var wg sync.WaitGroup

	for i, f := range c.semua {
		wg.Add(1)
		go func(i int, f *Fisik) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				hasil[i] = HasilShard[T]{Shard: f.Nama, Err: ctx.Err()}
				return
			}
			v, err := fn(ctx, f)
			if err != nil {
				err = fmt.Errorf("shard %s: %w", f.Nama, err)
			}
			hasil[i] = HasilShard[T]{Shard: f.Nama, Nilai: v, Err: err}
		}(i, f)
	}
	wg.Wait()
	return hasil
}

// Gabung meratakan hasil fan-out menjadi satu slice, dan mengembalikan
// galat gabungan bila ada shard yang gagal.
func Gabung[T any](hasil []HasilShard[[]T]) ([]T, error) {
	var out []T
	var errs []error
	for _, h := range hasil {
		if h.Err != nil {
			errs = append(errs, h.Err)
			continue
		}
		out = append(out, h.Nilai...)
	}
	return out, errors.Join(errs...)
}
```

## Uji

```go
package shard

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"testing"
)

func fisikUji(nama string) *Fisik { return &Fisik{Nama: nama, DB: &sql.DB{}} }

func petaUji(t *testing.T, n int) (*Peta, []*Fisik) {
	t.Helper()
	var fs []*Fisik
	var rs []Rentang
	per := JumlahLogis / n
	for i := 0; i < n; i++ {
		f := fisikUji("db-" + strconv.Itoa(i))
		fs = append(fs, f)
		sampai := (i+1)*per - 1
		if i == n-1 {
			sampai = JumlahLogis - 1
		}
		rs = append(rs, Rentang{Dari: i * per, Sampai: sampai, Fisik: f})
	}
	p, err := BangunPeta(1, rs)
	if err != nil {
		t.Fatalf("bangun peta: %v", err)
	}
	return p, fs
}

func TestBangunPeta_MenolakSlotBolong(t *testing.T) {
	// Peta bolong = data hilang diam-diam. WAJIB gagal saat boot.
	_, err := BangunPeta(1, []Rentang{{Dari: 0, Sampai: 100, Fisik: fisikUji("a")}})
	if !errors.Is(err, ErrPetaTidakLengkap) {
		t.Fatalf("mau ErrPetaTidakLengkap, dapat %v", err)
	}
}

func TestBangunPeta_MenolakTumpangTindih(t *testing.T) {
	_, err := BangunPeta(1, []Rentang{
		{Dari: 0, Sampai: 2000, Fisik: fisikUji("a")},
		{Dari: 1500, Sampai: JumlahLogis - 1, Fisik: fisikUji("b")},
	})
	if !errors.Is(err, ErrRentangTumpang) {
		t.Fatalf("mau ErrRentangTumpang, dapat %v", err)
	}
}

func TestLogis_StabilDanDalamRentang(t *testing.T) {
	// Stabilitas adalah syarat mutlak: nilai yang berubah antar proses
	// akan mengarahkan kunci yang sama ke shard berbeda.
	if a, b := Logis("tenant-42"), Logis("tenant-42"); a != b {
		t.Fatalf("hash tidak stabil: %d vs %d", a, b)
	}
	for i := 0; i < 10_000; i++ {
		l := Logis("tenant-" + strconv.Itoa(i))
		if l < 0 || l >= JumlahLogis {
			t.Fatalf("logis %d di luar rentang", l)
		}
	}
}

func TestLogis_SebaranCukupRata(t *testing.T) {
	_, fs := petaUji(t, 4)
	p, _ := petaUji(t, 4)
	hitung := map[string]int{}
	const n = 40_000
	for i := 0; i < n; i++ {
		hitung[p.slot[Logis("tenant-"+strconv.Itoa(i))].Nama]++
	}
	ideal := n / len(fs)
	for nama, c := range hitung {
		if c < ideal*8/10 || c > ideal*12/10 {
			t.Errorf("%s dapat %d, ideal ~%d (timpang >20%%)", nama, c, ideal)
		}
	}
}

func TestUntuk_KunciSamaSelaluShardSama(t *testing.T) {
	p, fs := petaUji(t, 4)
	c := New(p, fs, 4)
	pertama := c.Untuk("tenant-99")
	for i := 0; i < 100; i++ {
		if c.Untuk("tenant-99") != pertama {
			t.Fatal("routing tidak deterministik")
		}
	}
}

func TestTujuanTulis_GandaSaatMigrasi(t *testing.T) {
	// Selama migrasi, tulis WAJIB sampai ke asal dan tujuan — kalau tidak,
	// tulis yang terjadi di sela peralihan peta akan hilang.
	p, fs := petaUji(t, 2)
	tujuan := fisikUji("db-baru")
	l := Logis("tenant-7")
	p.TandaiPindah(l, l, tujuan)

	c := New(p, append(fs, tujuan), 4)
	if got := len(c.TujuanTulis("tenant-7")); got != 2 {
		t.Fatalf("saat migrasi harus 2 tujuan tulis, dapat %d", got)
	}
	// Kunci yang tidak bermigrasi tetap satu tujuan.
	var lain string
	for i := 0; ; i++ {
		lain = "tenant-" + strconv.Itoa(i)
		if Logis(lain) != l {
			break
		}
	}
	if got := len(c.TujuanTulis(lain)); got != 1 {
		t.Fatalf("kunci non-migrasi harus 1 tujuan, dapat %d", got)
	}
}

func TestSebar_MengumpulkanSemuaShard(t *testing.T) {
	p, fs := petaUji(t, 4)
	c := New(p, fs, 2)

	hasil := Sebar(context.Background(), c,
		func(_ context.Context, f *Fisik) ([]string, error) {
			return []string{f.Nama + ":a", f.Nama + ":b"}, nil
		})

	gabung, err := Gabung(hasil)
	if err != nil {
		t.Fatalf("must not error: %v", err)
	}
	if len(gabung) != 8 {
		t.Fatalf("want 8 rows from 4 shards, got %d", len(gabung))
	}
}

func TestSebar_KegagalanSatuShardTerlihat(t *testing.T) {
	// Inti pengujian: hasil parsial TIDAK BOLEH tampak seperti sukses.
	p, fs := petaUji(t, 4)
	c := New(p, fs, 4)
	rusak := errors.New("koneksi putus")

	hasil := Sebar(context.Background(), c,
		func(_ context.Context, f *Fisik) ([]string, error) {
			if f.Nama == "db-2" {
				return nil, rusak
			}
			return []string{f.Nama}, nil
		})

	gabung, err := Gabung(hasil)
	if err == nil {
		t.Fatal("shard failure MUST appear as error")
	}
	if !errors.Is(err, rusak) {
		t.Fatalf("original error must be wrapped, got %v", err)
	}
	if !strings.Contains(err.Error(), "db-2") {
		t.Fatalf("error must mention failed shard: %v", err)
	}
	if len(gabung) != 3 {
		t.Fatalf("healthy shards still yield results, got %d", len(gabung))
	}
}

func TestSebar_MenghormatiPembatalanContext(t *testing.T) {
	p, fs := petaUji(t, 4)
	c := New(p, fs, 1)
	ctx, batal := context.WithCancel(context.Background())
	batal()

	hasil := Sebar(ctx, c, func(ctx context.Context, f *Fisik) ([]string, error) {
		return []string{f.Nama}, nil
	})
	var adaGalat bool
	for _, h := range hasil {
		if errors.Is(h.Err, context.Canceled) {
			adaGalat = true
		}
	}
	if !adaGalat {
		t.Fatal("context yang dibatalkan harus menghentikan fan-out")
	}
}

func TestTukarPeta_Atomik(t *testing.T) {
	p1, fs := petaUji(t, 2)
	c := New(p1, fs, 2)
	if c.peta.Load().Versi != 1 {
		t.Fatal("versi awal salah")
	}
	p2, _ := petaUji(t, 4)
	p2.Versi = 2
	c.TukarPeta(p2)
	if c.peta.Load().Versi != 2 {
		t.Fatal("peta tidak tertukar")
	}
}
```

## Anti-Pattern

**❌ SALAH — modulo langsung ke jumlah mesin**

```go
db := mesin[int(hash(tenantID))%len(mesin)]
```

Menambah satu mesin memindahkan sekitar 80% baris. Ini bukan rebalancing — ini migrasi total dengan downtime.

**✅ BENAR — logical shard tetap, peta yang berubah**

```go
db := peta.slot[Logis(tenantID)].DB   // JumlahLogis tetap 4096 selamanya
```

**❌ SALAH — hash yang tidak stabil antar proses**

```go
import "hash/maphash"

var h maphash.Hash                    // benihnya ACAK tiap proses
logis := int(h.Sum64() % JumlahLogis) // pod A dan pod B tidak sepakat
```

Setiap pod merutekan kunci yang sama ke shard berbeda. Data tertulis di satu tempat, dicari di tempat lain.

**✅ BENAR — hash deterministik dan terdokumentasi**

```go
// FNV-1a: stabil lintas versi Go dan lintas arsitektur.
h := fnv.New64a()
_, _ = h.Write([]byte(kunci))
```

**❌ SALAH — kegagalan shard disembunyikan di fan-out**

```go
var semua []Pesanan
for _, s := range shards {
	baris, err := s.Query(ctx, q)
	if err != nil {
		continue // "biar tetap jalan"
	}
	semua = append(semua, baris...)
}
return semua, nil // tampak sukses, padahal data tidak lengkap
```

Pemanggil menerima daftar yang terlihat normal. Laporan keuangan yang kurang satu shard adalah kesalahan yang jauh lebih mahal daripada error.

**✅ BENAR — hasil parsial dinyatakan eksplisit**

```go
gabung, err := shard.Gabung(shard.Sebar(ctx, c, ambil))
if err != nil {
	// Pemanggil yang memutuskan: tolak, atau sajikan dengan penanda parsial.
	return nil, fmt.Errorf("hasil tidak lengkap: %w", err)
}
```

**❌ SALAH — sharding padahal yang dibutuhkan partitioning**

```
"Tabel event 3 miliar baris, VACUUM berjam-jam, hapus data lama mengunci tabel.
 Mari kita shard ke 8 database."
```

Delapan database berarti kehilangan `JOIN` dan transaksi, dan setiap shard tetap punya masalah `VACUUM` yang sama.

**✅ BENAR — partitioning menyelesaikannya tanpa mengubah aplikasi**

```sql
CREATE TABLE event (
  id bigserial, terjadi_pada timestamptz NOT NULL, muatan jsonb,
  PRIMARY KEY (id, terjadi_pada)      -- kunci partisi WAJIB ikut di PK
) PARTITION BY RANGE (terjadi_pada);

CREATE TABLE event_2026_08 PARTITION OF event
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Menghapus data lama menjadi operasi metadata, bukan DELETE jutaan baris:
ALTER TABLE event DETACH PARTITION event_2025_08 CONCURRENTLY;
DROP TABLE event_2025_08;
```

SQL aplikasi tidak berubah sama sekali. Query dengan `WHERE terjadi_pada >= ...` otomatis hanya menyentuh partisi yang relevan (*partition pruning*).

## Kasus Tepi Produksi

1. **ID unik lintas shard.** `bigserial` menghasilkan ID yang bertabrakan antar shard. Pakai UUIDv7 (terurut waktu, ramah index) atau Snowflake ID yang menyisipkan nomor shard. Jangan pernah memakai `serial` di tabel ber-shard.

2. **Query tanpa shard key butuh tabel pencarian global.** Login dengan email tidak membawa `tenant_id`. Fan-out ke semua shard untuk setiap login tidak menskala. Simpan pemetaan `email -> tenant_id` di satu tabel global (atau Redis), lalu rutekan ke satu shard.

3. **Transaksi lintas shard tidak ada.** Memindahkan saldo antar tenant di shard berbeda tidak bisa atomik. Pakai saga atau outbox — lihat `distributed_patterns_resilience/`. Bila kebutuhan ini sering muncul, shard key-nya kemungkinan salah pilih.

4. **Tenant raksasa memenuhi satu shard.** Pada SaaS B2B, satu pelanggan besar bisa membawa 40% data. Sediakan mekanisme *pinning* — logical shard tertentu diberi mesin sendiri — dan pantau ukuran per tenant sebelum menjadi masalah.

5. **Ledakan koneksi.** Setiap pod memelihara pool ke setiap shard. 50 pod × 8 shard × 10 koneksi = 4.000 koneksi. PostgreSQL akan menyerah jauh sebelum itu. Pakai pgbouncer, dan hitung angkanya sebelum menambah shard — lihat `db_sqlc/connection_pool_tuning.md`.

6. **Migrasi skema harus berjalan di semua shard.** Satu shard yang gagal migrasi menghasilkan cluster dengan skema campur. Runner migrasi WAJIB idempoten, mencatat versi per shard, dan gagal keras bila versinya tidak seragam.

7. **Partisi masa depan harus dibuat sebelum waktunya tiba.** Tulis ke rentang yang belum punya partisi akan gagal (`no partition of relation found for row`). Jadwalkan pembuatan partisi beberapa bulan ke depan, dan pasang alert bila partisi terakhir kurang dari 30 hari lagi.

8. **`DETACH PARTITION` tanpa `CONCURRENTLY` mengunci.** Pada PostgreSQL 14+, gunakan `CONCURRENTLY` — tapi ia tidak bisa berjalan di dalam blok transaksi.

## Kapan JANGAN Pakai Ini

- **Sebelum langkah 1–4 benar-benar habis.** Sharding dengan data di bawah ~1 TB atau di bawah ~10 ribu tulis per detik hampir selalu prematur. Ongkos kerumitannya permanen; keuntungannya belum tentu ada.
- **Ketika query utama tidak membawa shard key.** Bila mayoritas query akan menjadi fan-out, sharding menambah latensi tanpa menambah kapasitas.
- **Untuk masalah tabel besar semata.** Itu wilayah partitioning: tanpa perubahan aplikasi, `JOIN` tetap hidup, transaksi tetap ACID.
- **Bila timnya belum punya observability per-shard.** Cluster ber-shard tanpa metrik per shard tidak bisa didiagnosis — masalah muncul sebagai "kadang lambat" tanpa jejak.
- **Sebagai persiapan pertumbuhan yang belum terjadi.** Shard key dipilih berdasarkan pola query yang ada sekarang; pola itu akan berubah, dan kunci yang dipilih terlalu dini biasanya salah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu shard jauh lebih sibuk | CPU & ukuran per shard | Shard key timpang, atau ada tenant raksasa |
| p99 naik tapi p50 tetap | latensi per shard | Fan-out menunggu shard terlambat |
| Hasil kadang kurang | rasio galat per shard di fan-out | Kegagalan parsial disembunyikan di suatu tempat |
| `too many connections` | jumlah pod × shard × pool | Ledakan koneksi; butuh pgbouncer |
| Tulis gagal di awal bulan | partisi terakhir yang ada | Partisi masa depan lupa dibuat |
| `VACUUM` makin lama | ukuran tabel terbesar | Kandidat partitioning, belum tentu sharding |

```sql
-- Ukuran per tabel — mencari kandidat partitioning
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS ukuran,
       n_live_tup
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;

-- Daftar partisi dan rentangnya — memastikan partisi masa depan ada
SELECT c.relname AS partisi,
       pg_get_expr(c.relpartbound, c.oid) AS rentang,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS ukuran
FROM pg_class p
JOIN pg_inherits i ON i.inhparent = p.oid
JOIN pg_class c ON c.oid = i.inhrelid
WHERE p.relname = 'event' ORDER BY c.relname;

-- Memastikan partition pruning benar-benar terjadi:
-- rencana harus menyentuh SATU partisi, bukan semuanya.
EXPLAIN (COSTS OFF)
SELECT * FROM event WHERE terjadi_pada >= '2026-08-01' AND terjadi_pada < '2026-08-02';
```

```bash
# Sebaran beban antar shard (dari log terstruktur aplikasi)
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.msg=="db_query") | .shard' | sort | uniq -c | sort -rn

# Seberapa sering fan-out terjadi? Angka tinggi = shard key salah pilih
kubectl logs -l app=api --since=1h | grep -c '"fanout":true'

# Shard yang gagal dalam fan-out
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.msg=="fanout_partial") | .shard_gagal' | sort | uniq -c
```
