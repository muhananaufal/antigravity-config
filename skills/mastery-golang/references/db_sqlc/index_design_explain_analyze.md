# Desain Index & Membaca `EXPLAIN ANALYZE`

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `db_sqlc/query_optimization_n_plus_one.md` · `db_sqlc/connection_pool_tuning.md` · `db_sqlc/zero_downtime_migrations.md`

## Konsep Utama

"Query lambat? Tambah index." Nasihat ini benar sekitar separuh waktu, dan separuh sisanya menimbulkan masalah baru yang lebih sulit dilihat.

Index bukan barang gratis. Setiap index:

| Ongkos | Besarnya |
| :--- | :--- |
| Memperlambat `INSERT`/`UPDATE`/`DELETE` | Tiap index WAJIB diperbarui pada setiap tulis |
| Memakan ruang disk | Sering 10–40% ukuran tabel |
| Memakan memori cache | Bersaing dengan data untuk `shared_buffers` |
| Menambah waktu `VACUUM` | Index ikut dibersihkan |

Tabel dengan 12 index yang "berjaga-jaga" akan punya throughput tulis sepertiga dari yang seharusnya. Keahlian senior bukan menambah index — tapi menentukan **index yang mana**, dan membuktikannya dengan angka.

### Yang menentukan index dipakai atau tidak

**Selektivitas.** Index berguna bila ia menyingkirkan sebagian besar baris. Index pada kolom `status` yang hanya bernilai `aktif`/`nonaktif` pada tabel 10 juta baris hampir tidak pernah dipakai — planner tahu bahwa membaca 5 juta baris lewat index lebih lambat daripada memindai seluruh tabel secara berurutan.

**Aturan kasar:** bila query mengambil lebih dari ~5–10% tabel, sequential scan biasanya menang. **`Seq Scan` bukan selalu bug.**

**Urutan kolom pada index komposit.** Ini yang paling sering salah. Index B-tree hanya bisa dipakai dari **awalan kiri**:

```sql
CREATE INDEX ON pesanan (tenant_id, status, dibuat_pada);
```

| Query | Bisa pakai index? |
| :--- | :--- |
| `WHERE tenant_id = 1` | ✅ |
| `WHERE tenant_id = 1 AND status = 'baru'` | ✅ |
| `WHERE tenant_id = 1 AND status = 'baru' ORDER BY dibuat_pada` | ✅ ideal |
| `WHERE status = 'baru'` | ❌ melompati kolom pertama |
| `WHERE tenant_id = 1 AND dibuat_pada > x` | ⚠️ sebagian — hanya `tenant_id` |

Panduan urutan: **kesetaraan dulu, lalu rentang, lalu pengurutan.**

### Membaca `EXPLAIN ANALYZE` — satu angka yang paling penting

Bukan waktu eksekusi. Yang paling menentukan adalah **rasio antara `rows` dugaan dan `actual rows`**:

```
Seq Scan on pesanan  (cost=0.00..18334.00 rows=1000 width=64)
                     (actual time=0.02..842.11 rows=980431 loops=1)
                                                ^^^^^^
   diduga 1.000 baris, kenyataannya 980.431 — meleset 980x
```

Ketika planner meleset sebesar ini, **seluruh rencana di atasnya ikut salah**: ia memilih nested loop untuk 1.000 baris, lalu menjalankannya 980.431 kali. Menambah index tidak akan menolong — yang rusak adalah statistiknya.

| Yang dilihat | Artinya |
| :--- | :--- |
| `actual rows` >> `rows` | Statistik basi (`ANALYZE`), atau korelasi kolom yang tidak diketahui planner |
| `loops=N` besar pada node dalam | Nested loop; sering gejala N+1 di level SQL |
| `Rows Removed by Filter` besar | Index tidak menyaring; predikatnya baru diterapkan setelah baca |
| `Heap Fetches` besar pada Index Only Scan | Tabel butuh `VACUUM`; visibility map basi |
| `Buffers: read` besar vs `hit` | Data tidak di cache — masalah I/O, bukan masalah rencana |

## Diagram ASCII

```text
   INDEX KOMPOSIT — kenapa urutan kolom menentukan segalanya

   CREATE INDEX ON pesanan (tenant_id, status, dibuat_pada)

   Struktur B-tree, terurut kiri ke kanan:

   tenant=1 --+-- status='baru'  --+-- 2026-01-01
              |                    +-- 2026-01-02
              |                    `-- 2026-01-03
              +-- status='kirim' --+-- 2026-01-01
              `-- status='batal' --`-- ...
   tenant=2 --+-- status='baru'  --+-- ...

   WHERE tenant_id=1 AND status='baru'     -> LOMPAT langsung ke cabang
   WHERE status='baru'                     -> harus periksa SEMUA tenant
                                              = pindai seluruh index

   ---------------------------------------------------------------

   MEMBACA EXPLAIN ANALYZE — dari dalam ke luar

   Nested Loop  (rows=1000) (actual rows=980431 loops=1)   <- 4. paling luar
     -> Seq Scan on pesanan (rows=1000) (actual rows=980431) <- 1. dieksekusi pertama
          Filter: (status = 'baru')
          Rows Removed by Filter: 19020                    <- penyaringan setelah baca
     -> Index Scan on pelanggan (actual rows=1 loops=980431) <- 2. DIULANG 980rb kali
          Index Cond: (id = pesanan.pelanggan_id)

   Baca dari BAWAH ke ATAS. Angka `loops` pada node dalam
   adalah pengali — 980.431 x 0,01ms = 9,8 detik.
```

## Kode Go Production-Ready

Penganalisis rencana yang menandai masalah secara otomatis — dipasang di CI atau dipanggil saat menyelidiki query lambat.

```go
package explain

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// Node adalah satu simpul rencana dari EXPLAIN (FORMAT JSON).
type Node struct {
	Tipe          string  `json:"Node Type"`
	Relasi        string  `json:"Relation Name"`
	IndexName     string  `json:"Index Name"`
	PlanRows      float64 `json:"Plan Rows"`
	ActualRows    float64 `json:"Actual Rows"`
	ActualLoops   float64 `json:"Actual Loops"`
	ActualTotalMs float64 `json:"Actual Total Time"`
	RowsRemoved   float64 `json:"Rows Removed by Filter"`
	HeapFetches   float64 `json:"Heap Fetches"`
	SharedHit     float64 `json:"Shared Hit Blocks"`
	SharedRead    float64 `json:"Shared Read Blocks"`
	Filter        string  `json:"Filter"`
	Anak          []Node  `json:"Plans"`
}

type hasilExplain struct {
	Plan          Node    `json:"Plan"`
	ExecutionTime float64 `json:"Execution Time"`
}

// Tingkat menandai keparahan temuan.
type Tingkat string

const (
	Kritis  Tingkat = "KRITIS"
	Perhatian Tingkat = "PERHATIAN"
	Info    Tingkat = "INFO"
)

// Temuan adalah satu masalah yang terdeteksi pada rencana.
type Temuan struct {
	Tingkat Tingkat
	Node    string
	Pesan   string
	Saran   string
}

func (t Temuan) String() string {
	s := fmt.Sprintf("[%s] %s: %s", t.Tingkat, t.Node, t.Pesan)
	if t.Saran != "" {
		s += "\n         saran: " + t.Saran
	}
	return s
}

// Ambang yang bisa disetel per proyek.
type Ambang struct {
	// RasioEstimasi: seberapa jauh dugaan boleh meleset sebelum ditandai.
	RasioEstimasi float64
	// BarisSeqScan: Seq Scan di atas jumlah ini dianggap mencurigakan.
	BarisSeqScan float64
	// LoopsNestedLoop: pengulangan di atas ini menandakan pola N+1.
	LoopsNestedLoop float64
}

// AmbangDefault memberi nilai yang wajar untuk OLTP.
func AmbangDefault() Ambang {
	return Ambang{RasioEstimasi: 100, BarisSeqScan: 10_000, LoopsNestedLoop: 1_000}
}

// Jalankan menjalankan EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) lalu menganalisisnya.
//
// PERINGATAN: ANALYZE benar-benar MENJALANKAN query. Untuk statement yang
// mengubah data, bungkus dalam transaksi dan rollback — lihat JalankanAman.
func Jalankan(ctx context.Context, db *sql.DB, query string, args ...any) ([]Temuan, float64, error) {
	var raw []byte
	q := "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query
	if err := db.QueryRowContext(ctx, q, args...).Scan(&raw); err != nil {
		return nil, 0, fmt.Errorf("jalankan explain: %w", err)
	}

	var hasil []hasilExplain
	if err := json.Unmarshal(raw, &hasil); err != nil {
		return nil, 0, fmt.Errorf("urai rencana: %w", err)
	}
	if len(hasil) == 0 {
		return nil, 0, fmt.Errorf("explain: rencana kosong")
	}

	var temuan []Temuan
	periksa(hasil[0].Plan, AmbangDefault(), &temuan)
	return temuan, hasil[0].ExecutionTime, nil
}

// JalankanAman menjalankan EXPLAIN ANALYZE lalu selalu rollback.
// WAJIB dipakai untuk INSERT/UPDATE/DELETE.
func JalankanAman(ctx context.Context, db *sql.DB, query string, args ...any) ([]Temuan, float64, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("mulai transaksi: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // rollback disengaja

	var raw []byte
	q := "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&raw); err != nil {
		return nil, 0, fmt.Errorf("jalankan explain: %w", err)
	}
	var hasil []hasilExplain
	if err := json.Unmarshal(raw, &hasil); err != nil {
		return nil, 0, fmt.Errorf("urai rencana: %w", err)
	}
	var temuan []Temuan
	periksa(hasil[0].Plan, AmbangDefault(), &temuan)
	return temuan, hasil[0].ExecutionTime, nil
}

// periksa menelusuri pohon rencana dan mengumpulkan temuan.
func periksa(n Node, a Ambang, out *[]Temuan) {
	nama := n.Tipe
	if n.Relasi != "" {
		nama += " on " + n.Relasi
	}

	// 1. Dugaan planner meleset jauh -> statistik basi. Ini akar dari
	//    sebagian besar rencana buruk, dan TIDAK bisa diperbaiki index.
	if n.PlanRows > 0 && n.ActualRows > 0 {
		rasio := n.ActualRows / n.PlanRows
		if rasio < 1 {
			rasio = n.PlanRows / n.ActualRows
		}
		if rasio >= a.RasioEstimasi {
			*out = append(*out, Temuan{
				Tingkat: Kritis, Node: nama,
				Pesan: fmt.Sprintf("dugaan %.0f baris, kenyataan %.0f (meleset %.0fx)",
					n.PlanRows, n.ActualRows, rasio),
				Saran: "jalankan ANALYZE pada tabel; bila tetap meleset, pertimbangkan CREATE STATISTICS untuk kolom berkorelasi",
			})
		}
	}

	// 2. Seq Scan besar. BUKAN otomatis salah — hanya layak diperiksa.
	if n.Tipe == "Seq Scan" && n.ActualRows > a.BarisSeqScan {
		saran := "periksa apakah ada index yang cocok"
		if n.Filter != "" {
			saran = fmt.Sprintf("filter %q diterapkan setelah baca; index pada kolom ini mungkin membantu", ringkas(n.Filter))
		}
		*out = append(*out, Temuan{
			Tingkat: Perhatian, Node: nama,
			Pesan: fmt.Sprintf("Seq Scan membaca %.0f baris", n.ActualRows),
			Saran: saran,
		})
	}

	// 3. Nested loop dengan pengulangan tinggi -> N+1 di level SQL.
	if n.ActualLoops >= a.LoopsNestedLoop {
		*out = append(*out, Temuan{
			Tingkat: Kritis, Node: nama,
			Pesan: fmt.Sprintf("node diulang %.0f kali", n.ActualLoops),
			Saran: "ubah jadi JOIN atau ambil sekaligus dengan WHERE id = ANY($1)",
		})
	}

	// 4. Index Only Scan yang tetap membaca heap -> visibility map basi.
	if strings.Contains(n.Tipe, "Index Only Scan") && n.HeapFetches > n.ActualRows*0.1 {
		*out = append(*out, Temuan{
			Tingkat: Perhatian, Node: nama,
			Pesan: fmt.Sprintf("Index Only Scan tapi %.0f heap fetch", n.HeapFetches),
			Saran: "jalankan VACUUM pada tabel agar visibility map mutakhir",
		})
	}

	// 5. Penyaringan besar setelah baca -> index tidak selektif.
	if n.RowsRemoved > n.ActualRows*10 && n.RowsRemoved > 10_000 {
		*out = append(*out, Temuan{
			Tingkat: Perhatian, Node: nama,
			Pesan: fmt.Sprintf("%.0f baris dibuang filter, hanya %.0f terpakai", n.RowsRemoved, n.ActualRows),
			Saran: "pindahkan predikat ke index, atau pertimbangkan partial index",
		})
	}

	// 6. Rasio baca disk tinggi -> masalah I/O, bukan masalah rencana.
	total := n.SharedHit + n.SharedRead
	if total > 1000 && n.SharedRead/total > 0.5 {
		*out = append(*out, Temuan{
			Tingkat: Info, Node: nama,
			Pesan: fmt.Sprintf("%.0f%% blok dibaca dari disk", 100*n.SharedRead/total),
			Saran: "data tidak muat di cache; periksa shared_buffers atau kurangi data yang disentuh",
		})
	}

	for _, c := range n.Anak {
		periksa(c, a, out)
	}
}

func ringkas(s string) string {
	if len(s) <= 60 {
		return s
	}
	return s[:57] + "..."
}
```

## Uji

```go
package explain

import (
	"encoding/json"
	"strings"
	"testing"
)

func urai(t *testing.T, s string) Node {
	t.Helper()
	var h []hasilExplain
	if err := json.Unmarshal([]byte(s), &h); err != nil {
		t.Fatalf("parse: %v", err)
	}
	return h[0].Plan
}

const rencanaEstimasiMeleset = `[{"Plan":{
  "Node Type":"Seq Scan","Relation Name":"pesanan",
  "Plan Rows":1000,"Actual Rows":980431,"Actual Loops":1,
  "Filter":"(status = 'baru')","Rows Removed by Filter":19020
},"Execution Time":842.1}]`

func TestPeriksa_EstimasiMeleset(t *testing.T) {
	var out []Temuan
	periksa(urai(t, rencanaEstimasiMeleset), AmbangDefault(), &out)

	var kena bool
	for _, f := range out {
		if f.Tingkat == Kritis && strings.Contains(f.Pesan, "meleset") {
			kena = true
		}
	}
	if !kena {
		t.Fatalf("estimation missed 980x should be KRITIS, got %v", out)
	}
}

func TestPeriksa_NestedLoopBerulang(t *testing.T) {
	const r = `[{"Plan":{
	  "Node Type":"Nested Loop","Plan Rows":1,"Actual Rows":1,"Actual Loops":1,
	  "Plans":[{"Node Type":"Index Scan","Relation Name":"pelanggan",
	            "Plan Rows":1,"Actual Rows":1,"Actual Loops":980431}]
	},"Execution Time":9800}]`
	var out []Temuan
	periksa(urai(t, r), AmbangDefault(), &out)

	var kena bool
	for _, f := range out {
		if strings.Contains(f.Pesan, "diulang") {
			kena = true
			if !strings.Contains(f.Saran, "JOIN") {
				t.Errorf("suggestion must mention JOIN, got %q", f.Saran)
			}
		}
	}
	if !kena {
		t.Fatalf("980k loop should be detected, got %v", out)
	}
}

func TestPeriksa_SeqScanKecilTidakDitandai(t *testing.T) {
	// Seq Scan pada tabel kecil adalah pilihan planner yang BENAR.
	const r = `[{"Plan":{"Node Type":"Seq Scan","Relation Name":"config",
	  "Plan Rows":50,"Actual Rows":50,"Actual Loops":1}}]`
	var out []Temuan
	periksa(urai(t, r), AmbangDefault(), &out)
	if len(out) != 0 {
		t.Fatalf("Seq Scan 50 rows must not be flagged, got %v", out)
	}
}

func TestPeriksa_IndexOnlyScanHeapFetch(t *testing.T) {
	const r = `[{"Plan":{"Node Type":"Index Only Scan","Relation Name":"pesanan",
	  "Index Name":"idx_tenant","Plan Rows":1000,"Actual Rows":1000,
	  "Actual Loops":1,"Heap Fetches":950}}]`
	var out []Temuan
	periksa(urai(t, r), AmbangDefault(), &out)

	var kena bool
	for _, f := range out {
		if strings.Contains(f.Saran, "VACUUM") {
			kena = true
		}
	}
	if !kena {
		t.Fatalf("high heap fetch must suggest VACUUM, got %v", out)
	}
}

func TestPeriksa_MenelusuriSeluruhPohon(t *testing.T) {
	const r = `[{"Plan":{"Node Type":"Hash Join","Plan Rows":1,"Actual Rows":1,"Actual Loops":1,
	  "Plans":[
	    {"Node Type":"Seq Scan","Relation Name":"a","Plan Rows":1,"Actual Rows":500000,"Actual Loops":1},
	    {"Node Type":"Seq Scan","Relation Name":"b","Plan Rows":1,"Actual Rows":400000,"Actual Loops":1}
	  ]}}]`
	var out []Temuan
	periksa(urai(t, r), AmbangDefault(), &out)
	if len(out) < 4 { // 2 estimasi meleset + 2 seq scan besar
		t.Fatalf("anak pohon harus ikut diperiksa, dapat %d temuan: %v", len(out), out)
	}
}

func TestRingkas(t *testing.T) {
	panjang := strings.Repeat("x", 100)
	if got := ringkas(panjang); len(got) != 60 || !strings.HasSuffix(got, "...") {
		t.Fatalf("ringkas salah: len=%d %q", len(got), got)
	}
}
```

## Anti-Pattern

**❌ SALAH — index pada setiap kolom "biar aman"**

```sql
CREATE INDEX ON pesanan (tenant_id);
CREATE INDEX ON pesanan (status);
CREATE INDEX ON pesanan (dibuat_pada);
CREATE INDEX ON pesanan (pelanggan_id);
CREATE INDEX ON pesanan (total);
```

Lima index berarti lima pembaruan pada setiap `INSERT`. Throughput tulis turun drastis, dan planner tetap tidak bisa memakai kombinasinya secara efisien untuk `WHERE tenant_id = 1 AND status = 'baru'` — ia harus melakukan bitmap AND yang lebih mahal daripada satu index komposit.

**✅ BENAR — satu index komposit yang cocok dengan pola query nyata**

```sql
-- Kesetaraan dulu, lalu rentang/pengurutan.
CREATE INDEX idx_pesanan_tenant_status_waktu
  ON pesanan (tenant_id, status, dibuat_pada DESC);
```

Satu index melayani `WHERE tenant_id`, `WHERE tenant_id AND status`, dan `WHERE tenant_id AND status ORDER BY dibuat_pada DESC`.

**❌ SALAH — fungsi pada kolom terindeks**

```sql
-- Index pada dibuat_pada TIDAK akan dipakai.
WHERE DATE(dibuat_pada) = '2026-08-05'
WHERE LOWER(email) = 'a@b.com'
```

Index menyimpan nilai asli, bukan hasil fungsi. Planner tidak bisa memakainya.

**✅ BENAR — predikat sargable, atau index ekspresi**

```sql
-- Rentang, bukan fungsi:
WHERE dibuat_pada >= '2026-08-05' AND dibuat_pada < '2026-08-06'

-- Atau index ekspresi bila fungsinya memang wajib:
CREATE INDEX ON users (LOWER(email));
```

**❌ SALAH — menambah index tanpa membaca rencana**

```go
// "Query lambat, tambah index" — tanpa bukti index-nya akan dipakai.
db.Exec(`CREATE INDEX ON pesanan (catatan)`)
```

Sering index baru sama sekali tidak dipakai, tapi ongkos tulisnya tetap dibayar selamanya.

**✅ BENAR — ukur dulu, buktikan sesudah**

```go
results, ms, err := explain.Run(ctx, db, query, args...)
for _, res := range results {
	log.Println(res)
}
// Tambah index, jalankan ulang, bandingkan ms DAN pastikan
// nama index muncul di rencana.
```

**❌ SALAH — `CREATE INDEX` di produksi tanpa `CONCURRENTLY`**

```sql
CREATE INDEX ON pesanan (tenant_id, status);
-- Mengunci tabel dari SEMUA tulis sampai selesai. Pada tabel 50 juta baris
-- ini bisa belasan menit downtime.
```

**✅ BENAR — `CONCURRENTLY`, dan tangani kemungkinan gagalnya**

```sql
CREATE INDEX CONCURRENTLY idx_pesanan_tenant_status ON pesanan (tenant_id, status);
-- Lebih lambat, dua kali pemindaian, TAPI tidak memblokir tulis.
-- Bila gagal, index tertinggal dalam keadaan INVALID dan WAJIB di-DROP:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

## Kasus Tepi Produksi

1. **Statistik basi setelah impor besar.** Memuat 10 juta baris lalu langsung query menghasilkan rencana kacau karena planner masih memakai statistik lama. `ANALYZE nama_tabel` WAJIB dijalankan setelah pemuatan massal — autovacuum mungkin baru berjalan berjam-jam kemudian.

2. **Kolom berkorelasi yang tidak diketahui planner.** `WHERE kota = 'Jakarta' AND provinsi = 'DKI'` — planner mengalikan selektivitas seolah keduanya bebas, padahal berkorelasi sempurna. Dugaannya meleset jauh. Perbaikannya: `CREATE STATISTICS (dependencies) ON kota, provinsi FROM alamat;`.

3. **Partial index untuk data condong.** Bila 99% baris berstatus `selesai` dan query hanya peduli yang `baru`, index penuh membuang ruang. `CREATE INDEX ON pesanan (dibuat_pada) WHERE status = 'baru'` menghasilkan index yang jauh lebih kecil dan lebih cepat.

4. **Index bloat setelah banyak `UPDATE`.** Index B-tree tidak menyusut otomatis. Setelah jutaan pembaruan, ukurannya bisa berlipat dan performanya menurun. Periksa dengan `pgstattuple`, perbaiki dengan `REINDEX CONCURRENTLY`.

5. **Ketidakcocokan tipe menggagalkan index.** Kolom `bigint` dibandingkan dengan parameter yang dikirim sebagai `text` menyebabkan cast implisit dan index diabaikan. Di Go dengan `pgx`, pastikan tipe parameter cocok — kirim `int64`, bukan `string`.

6. **`ORDER BY` + `LIMIT` yang menipu.** `ORDER BY dibuat_pada DESC LIMIT 10` terlihat murah, tapi bila tidak ada index yang cocok, PostgreSQL WAJIB mengurutkan seluruh hasil filter lebih dulu. Rencananya menampilkan `Sort` dengan `Sort Method: external merge Disk` — tanda pasti bahwa index pengurutan hilang.

7. **`ANALYZE` benar-benar menjalankan query.** Untuk `UPDATE`/`DELETE`, ini mengubah data sungguhan. Selalu bungkus dalam transaksi dan rollback — itulah alasan `JalankanAman` ada di kode atas.

## Kapan JANGAN Pakai Ini

- **Tabel kecil.** Di bawah beberapa ribu baris, sequential scan hampir selalu lebih cepat daripada index. Menambah index di situ murni ongkos tulis.
- **Kolom dengan kardinalitas sangat rendah** tanpa partial index. Index pada boolean atau enam nilai enum jarang dipakai planner.
- **Ketika masalahnya N+1 di aplikasi.** Seribu query cepat tetap lebih lambat daripada satu query sedang. Perbaiki polanya dulu — lihat `db_sqlc/query_optimization_n_plus_one.md`.
- **Sebagai pengganti pagination.** Query yang mengembalikan 100.000 baris tetap lambat walau index-nya sempurna. Batasi hasilnya.
- **Menambah index sebelum tahu query mana yang lambat.** Optimasi tanpa pengukuran hampir selalu menyasar tempat yang salah.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 query naik perlahan selama berminggu-minggu | ukuran tabel vs waktu query | Tabel tumbuh melewati titik di mana Seq Scan masih murah |
| Query cepat di staging, lambat di produksi | bandingkan `EXPLAIN` di keduanya | Volume data berbeda menghasilkan rencana berbeda |
| Throughput tulis turun setelah menambah fitur | jumlah index per tabel | Index menumpuk; tiap tulis membayar semuanya |
| Rencana berubah tiba-tiba tanpa perubahan kode | `last_analyze` di `pg_stat_user_tables` | Autovacuum menjalankan `ANALYZE` dan mengubah rencana |
| `Sort Method: external merge Disk` | keluaran `EXPLAIN ANALYZE` | `work_mem` kurang, atau index pengurutan hilang |

```sql
-- Query paling memakan waktu total (butuh pg_stat_statements)
SELECT calls, mean_exec_time::int AS rata_ms, total_exec_time::int AS total_ms,
       left(query, 80) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;

-- Index yang TIDAK PERNAH dipakai — kandidat dihapus
SELECT schemaname, relname, indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS ukuran
FROM pg_stat_user_indexes WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- Tabel dengan rasio Seq Scan tinggi
SELECT relname, seq_scan, idx_scan,
       round(100.0*seq_scan/nullif(seq_scan+idx_scan,0), 1) AS persen_seq
FROM pg_stat_user_tables WHERE seq_scan + idx_scan > 1000
ORDER BY persen_seq DESC LIMIT 15;

-- Kapan terakhir statistik diperbarui
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze
FROM pg_stat_user_tables ORDER BY n_mod_since_analyze DESC LIMIT 10;

-- Index yang gagal dibuat dengan CONCURRENTLY
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```
