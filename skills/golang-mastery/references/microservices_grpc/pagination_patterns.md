# Pagination: Cursor vs Offset

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `db_sqlc/index_design_explain_analyze.md` · `microservices_grpc/api_versioning_strategy.md` · `microservices_grpc/rest_chi_middleware_stack.md` · `db_sqlc/query_optimization_n_plus_one.md`

## Konsep Utama

Pagination tampak sepele sampai datanya besar dan berubah. Dua pendekatan yang ada bukan soal selera — keduanya punya sifat yang berbeda secara mendasar, dan memilih yang salah menghasilkan bug yang tidak pernah muncul di pengembangan.

| | **OFFSET/LIMIT** | **Cursor (keyset)** |
| :--- | :--- | :--- |
| Cara kerja | Lewati N baris, ambil M | `WHERE (urut, id) > (nilai_terakhir, id_terakhir)` |
| Biaya halaman ke-N | **O(N)** — database tetap membaca N baris lalu membuangnya | **O(log n)** — lompat lewat index |
| Data berubah saat menelusuri | Baris **terlewat** atau **ganda** | Stabil |
| Lompat ke halaman 500 | Bisa | Tidak bisa |
| Total halaman | Bisa (`COUNT(*)`, mahal) | Tidak, atau perkiraan |

### Kenapa OFFSET rusak pada data yang berubah

Ini bukan kasus tepi — ini perilaku normal:

```
Halaman 1: OFFSET 0  LIMIT 10  -> baris 1..10
   (seseorang menghapus baris #3)
Halaman 2: OFFSET 10 LIMIT 10  -> baris 12..21

Baris 11 TIDAK PERNAH TERLIHAT. Tidak ada galat. Tidak ada yang tahu.
```

Untuk daftar yang diurut waktu — feed, notifikasi, log — penyisipan terjadi terus-menerus di ujung yang sama dengan tempat pengguna menelusuri. Baris ganda dan terlewat menjadi harian.

### Kenapa OFFSET melambat, dan berapa banyak

`OFFSET 100000` menyuruh PostgreSQL membaca 100.000 baris melalui index, membuangnya, lalu mengembalikan 10. Halaman terakhir dari daftar besar bisa ratusan kali lebih lambat daripada halaman pertama — dan itu justru halaman yang dibuka crawler dan skrip ekspor.

### Kunci urut WAJIB unik

Cursor yang hanya berdasarkan `dibuat_pada` akan rusak ketika dua baris punya timestamp identik: yang satu terlewat, atau muncul dua kali. Kunci urut harus **unik dan total** — biasanya `(kolom_urut, id)` sebagai pasangan.

## Diagram ASCII

```text
   OFFSET: database membaca lalu MEMBUANG

   OFFSET 100000 LIMIT 10
   |<--------- dibaca dan dibuang: 100.000 baris --------->|<- 10 ->|
   [#][#][#][#][#] ................................ [#][#][*][*][*]
                                                            ^
                                          hanya ini yang dikembalikan

   Halaman 1     : ~1 ms
   Halaman 10000 : ~800 ms      <- naik LINEAR terhadap nomor halaman

   ---------------------------------------------------------------

   CURSOR: lompat langsung lewat index

   WHERE (dibuat_pada, id) < ('2026-08-04 10:00', 8842)
   ORDER BY dibuat_pada DESC, id DESC LIMIT 10

   index ---> [........................]--> mulai di sini --> ambil 10
                                            ^
                              satu pencarian B-tree, O(log n)

   Halaman 1     : ~1 ms
   Halaman 10000 : ~1 ms        <- KONSTAN

   ---------------------------------------------------------------

   KENAPA OFFSET MELEWATKAN BARIS PADA DATA HIDUP

   t=0  daftar: [A][B][C][D][E][F]
        halaman1 = OFFSET 0 LIMIT 3 -> [A][B][C]

   t=1  B DIHAPUS -> [A][C][D][E][F]

   t=2  halaman2 = OFFSET 3 LIMIT 3 -> [E][F]
                                        ^
        D TERLEWAT. Pengguna tidak pernah melihatnya, dan
        tidak ada satu pun galat yang muncul.

   Dengan cursor "setelah C": [D][E][F]  -- benar.
```

## Kode Go Production-Ready

```go
package pagination

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	batasDefault = 20
	batasMaks    = 100
)

var (
	ErrCursorTidakValid = errors.New("pagination: invalid cursor")
	ErrArahBerubah      = errors.New("pagination: sort order changed mid-traversal")
)

// Cursor menandai posisi terakhir yang sudah dikembalikan.
//
// Kunci urutnya adalah PASANGAN (Waktu, ID). Tanpa ID, dua baris dengan
// timestamp identik membuat satu di antaranya terlewat atau ganda --
// dan itu terjadi jauh lebih sering daripada dugaan pada sistem yang
// menyisipkan secara batch.
type Cursor struct {
	Waktu time.Time `json:"w"`
	ID    int64     `json:"i"`
	// Urut ikut disandikan agar perubahan urutan di tengah penelusuran
	// terdeteksi, bukan menghasilkan hasil yang diam-diam salah.
	Urut string `json:"u"`
}

// Sandi mengubah cursor menjadi string buram yang aman di URL.
//
// Sengaja dibuat buram: klien tidak boleh menyusun cursor sendiri, karena
// bentuk internalnya akan berubah seiring evolusi skema.
func (c Cursor) Sandi() (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("sandikan cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// UraiCursor membaca kembali cursor dan memvalidasinya.
func UraiCursor(s, urutSekarang string) (Cursor, error) {
	if s == "" {
		return Cursor{}, nil // halaman pertama
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Cursor{}, ErrCursorTidakValid
	}
	var c Cursor
	if err := json.Unmarshal(b, &c); err != nil {
		return Cursor{}, ErrCursorTidakValid
	}
	if c.ID <= 0 {
		return Cursor{}, ErrCursorTidakValid
	}
	// Klien yang mengubah urutan di tengah penelusuran akan mendapat
	// hasil yang tidak konsisten. Lebih baik gagal jelas.
	if c.Urut != "" && urutSekarang != "" && c.Urut != urutSekarang {
		return Cursor{}, ErrArahBerubah
	}
	return c, nil
}

// Permintaan adalah parameter pagination yang sudah dinormalisasi.
type Permintaan struct {
	Cursor Cursor
	Batas  int
	Urut   string
}

// Normalisasi membatasi ukuran halaman dan mengurai cursor.
//
// Batas WAJIB dibatasi: tanpa itu, `?limit=1000000` adalah cara termurah
// menjatuhkan layanan Anda.
func Normalisasi(cursorMentah string, batasMentah int, urut string) (Permintaan, error) {
	c, err := UraiCursor(cursorMentah, urut)
	if err != nil {
		return Permintaan{}, err
	}
	batas := batasMentah
	switch {
	case batas <= 0:
		batas = batasDefault
	case batas > batasMaks:
		batas = batasMaks
	}
	return Permintaan{Cursor: c, Batas: batas, Urut: urut}, nil
}

// Halaman adalah bentuk respons yang dikembalikan ke klien.
type Halaman[T any] struct {
	Data            []T    `json:"data"`
	CursorBerikut   string `json:"cursor_berikut,omitempty"`
	AdaBerikutnya   bool   `json:"ada_berikutnya"`
}

// Bangun menyusun respons dari hasil query.
//
// PENTING: query WAJIB mengambil batas+1 baris. Baris ekstra itu tidak
// dikembalikan -- ia hanya menjawab "apakah masih ada halaman berikutnya"
// tanpa memerlukan COUNT(*) yang mahal.
func Bangun[T any](baris []T, p Permintaan, kunci func(T) Cursor) (Halaman[T], error) {
	ada := len(baris) > p.Batas
	if ada {
		baris = baris[:p.Batas]
	}
	h := Halaman[T]{Data: baris, AdaBerikutnya: ada}
	if ada && len(baris) > 0 {
		c := kunci(baris[len(baris)-1])
		c.Urut = p.Urut
		s, err := c.Sandi()
		if err != nil {
			return Halaman[T]{}, err
		}
		h.CursorBerikut = s
	}
	return h, nil
}
```

Query yang menyertainya — perhatikan perbandingan **tuple**, bukan dua kondisi terpisah:

```sql
-- BENAR: perbandingan tuple. PostgreSQL bisa memakainya langsung
-- dengan index komposit (dibuat_pada DESC, id DESC).
SELECT id, judul, dibuat_pada
FROM artikel
WHERE tenant_id = $1
  AND (dibuat_pada, id) < ($2, $3)
ORDER BY dibuat_pada DESC, id DESC
LIMIT $4;                      -- $4 = batas + 1

CREATE INDEX idx_artikel_tenant_waktu
  ON artikel (tenant_id, dibuat_pada DESC, id DESC);
```

```sql
-- SALAH: dipecah jadi dua kondisi. Hasilnya benar, tapi planner
-- sering tidak bisa memakai index secara efisien, dan pada halaman
-- dalam ia kembali memindai.
WHERE dibuat_pada < $2 OR (dibuat_pada = $2 AND id < $3)
```

## Uji

```go
package pagination

import (
	"errors"
	"testing"
	"time"
)

type baris struct {
	ID    int64
	Waktu time.Time
}

func kunciBaris(b baris) Cursor { return Cursor{Waktu: b.Waktu, ID: b.ID} }

func TestNormalisasi_BatasDijaga(t *testing.T) {
	// Tanpa batas atas, ?limit=1000000 adalah cara termurah menjatuhkan layanan.
	kasus := []struct{ minta, mau int }{
		{0, batasDefault}, {-5, batasDefault}, {50, 50}, {100, 100}, {1000000, batasMaks},
	}
	for _, k := range kasus {
		p, err := Normalisasi("", k.minta, "waktu_desc")
		if err != nil {
			t.Fatal(err)
		}
		if p.Batas != k.mau {
			t.Errorf("limit=%d: mau %d, dapat %d", k.minta, k.mau, p.Batas)
		}
	}
}

func TestCursor_BolakBalikUtuh(t *testing.T) {
	asli := Cursor{Waktu: time.Date(2026, 8, 4, 10, 0, 0, 0, time.UTC), ID: 8842, Urut: "waktu_desc"}
	s, err := asli.Sandi()
	if err != nil {
		t.Fatal(err)
	}
	kembali, err := UraiCursor(s, "waktu_desc")
	if err != nil {
		t.Fatal(err)
	}
	if !kembali.Waktu.Equal(asli.Waktu) || kembali.ID != asli.ID {
		t.Fatalf("cursor berubah: %+v vs %+v", kembali, asli)
	}
}

func TestUraiCursor_MenolakMasukanRusak(t *testing.T) {
	for _, s := range []string{"bukan-base64!!", "eyJ4Ijox", "///"} {
		if _, err := UraiCursor(s, "waktu_desc"); !errors.Is(err, ErrCursorTidakValid) {
			t.Errorf("%q should be rejected as invalid cursor, got %v", s, err)
		}
	}
}

func TestUraiCursor_MendeteksiPerubahanUrutan(t *testing.T) {
	// Klien yang mengganti urutan di tengah penelusuran akan mendapat
	// hasil tidak konsisten. Gagal jelas lebih baik daripada salah diam-diam.
	c := Cursor{Waktu: time.Now(), ID: 1, Urut: "waktu_desc"}
	s, _ := c.Sandi()
	if _, err := UraiCursor(s, "judul_asc"); !errors.Is(err, ErrArahBerubah) {
		t.Fatalf("sort order change should be detected, got %v", err)
	}
}

func TestBangun_BarisEkstraTidakDikembalikan(t *testing.T) {
	// Query mengambil batas+1; baris ekstra HANYA untuk menjawab
	// "ada berikutnya", bukan untuk dikirim ke klien.
	p := Permintaan{Batas: 3, Urut: "waktu_desc"}
	data := []baris{{ID: 1}, {ID: 2}, {ID: 3}, {ID: 4}}

	h, err := Bangun(data, p, kunciBaris)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Data) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(h.Data))
	}
	if !h.AdaBerikutnya {
		t.Error("4th row indicates there is a next page")
	}
	if h.CursorBerikut == "" {
		t.Error("next cursor is required when there are more pages")
	}
}

func TestBangun_HalamanTerakhirTanpaCursor(t *testing.T) {
	p := Permintaan{Batas: 3, Urut: "waktu_desc"}
	h, err := Bangun([]baris{{ID: 1}, {ID: 2}}, p, kunciBaris)
	if err != nil {
		t.Fatal(err)
	}
	if h.AdaBerikutnya {
		t.Error("fewer results than limit means it is the last page")
	}
	if h.CursorBerikut != "" {
		t.Error("last page should not send a cursor")
	}
}

func TestBangun_HasilKosong(t *testing.T) {
	h, err := Bangun([]baris{}, Permintaan{Batas: 10}, kunciBaris)
	if err != nil {
		t.Fatal(err)
	}
	if h.AdaBerikutnya || h.CursorBerikut != "" {
		t.Error("empty result must not promise a next page")
	}
}

func TestBangun_CursorMenunjukBarisTERAKHIR(t *testing.T) {
	// Cursor yang menunjuk baris pertama akan mengulang halaman yang sama
	// selamanya -- bug pagination paling umum dan paling membingungkan.
	p := Permintaan{Batas: 2, Urut: "waktu_desc"}
	w := time.Date(2026, 8, 4, 10, 0, 0, 0, time.UTC)
	data := []baris{{ID: 10, Waktu: w}, {ID: 9, Waktu: w.Add(-time.Minute)}, {ID: 8, Waktu: w.Add(-2 * time.Minute)}}

	h, _ := Bangun(data, p, kunciBaris)
	c, err := UraiCursor(h.CursorBerikut, "waktu_desc")
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != 9 {
		t.Fatalf("cursor harus menunjuk baris terakhir yang DIKEMBALIKAN (9), dapat %d", c.ID)
	}
}
```

## Anti-Pattern

**❌ SALAH — OFFSET untuk daftar yang terus bertambah**

```sql
SELECT * FROM notifikasi WHERE pengguna_id = $1
ORDER BY dibuat_pada DESC LIMIT 20 OFFSET $2;
```

Notifikasi baru masuk di ujung yang sama dengan tempat pengguna menelusuri. Baris ganda dan terlewat menjadi kejadian harian, dan tidak ada satu pun galat yang muncul.

**✅ BENAR — cursor pada kunci urut yang unik**

```sql
SELECT * FROM notifikasi
WHERE pengguna_id = $1 AND (dibuat_pada, id) < ($2, $3)
ORDER BY dibuat_pada DESC, id DESC LIMIT $4;
```

**❌ SALAH — cursor hanya berdasarkan timestamp**

```go
WHERE dibuat_pada < $1
```

Dua baris dengan timestamp identik — lazim pada penyisipan batch — membuat salah satunya terlewat atau muncul dua kali.

**✅ BENAR — pasangan (kolom_urut, id) sebagai kunci total**

```go
WHERE (dibuat_pada, id) < ($1, $2)
```

**❌ SALAH — `COUNT(*)` untuk setiap permintaan halaman**

```go
total, _ := db.Hitung(ctx)  // memindai seluruh tabel, setiap kali
return Halaman{Data: baris, Total: total, TotalHalaman: total/batas}
```

Pada tabel besar, `COUNT(*)` sering lebih mahal daripada query datanya sendiri — dan hasilnya sudah usang begitu dikirim.

**✅ BENAR — ambil `batas+1`, jawab "ada berikutnya"**

```go
baris, _ := db.Ambil(ctx, p.Batas+1)
h, _ := Bangun(baris, p, kunci)   // AdaBerikutnya tanpa COUNT
```

Bila UI benar-benar butuh angka total, sajikan **perkiraan** dari `pg_class.reltuples` dan beri label sebagai perkiraan.

**❌ SALAH — cursor yang isinya terlihat dan bisa disusun klien**

```
?cursor=2026-08-04T10:00:00Z_8842
```

Klien akan mulai menyusunnya sendiri, dan sejak saat itu bentuk internal cursor menjadi API publik yang tidak bisa Anda ubah.

**✅ BENAR — buram dan bisa divalidasi**

```go
s, _ := cursor.Sandi()  // base64 dari bentuk internal
```

**❌ SALAH — batas ukuran halaman tanpa plafon**

```go
batas, _ := strconv.Atoi(r.URL.Query().Get("limit"))
db.Ambil(ctx, batas)  // ?limit=1000000
```

**✅ BENAR — plafon ditegakkan di satu tempat**

```go
p, err := pagination.Normalisasi(cursorMentah, batasMentah, urut) // maks 100
```

## Kasus Tepi Produksi

1. **Perubahan urutan di tengah penelusuran.** Klien yang mengganti `sort` sambil membawa cursor lama akan menerima hasil yang tidak konsisten. Sandikan kunci urut ke dalam cursor dan tolak bila berubah — gagal jelas lebih baik daripada hasil yang diam-diam salah.

2. **Penghapusan baris yang ditunjuk cursor.** Cursor keyset tetap bekerja: ia hanya menyatakan "setelah nilai ini", bukan "setelah baris ini". Ini keunggulan nyata dibanding cursor berbasis ID baris yang harus ada.

3. **Kolom urut yang bisa berubah nilainya.** Mengurutkan berdasarkan `diperbarui_pada` membuat baris **berpindah posisi** saat diperbarui — ia bisa muncul dua kali atau hilang dari penelusuran. Untuk cursor, urutkan pada kolom yang tidak berubah setelah dibuat.

4. **Halaman pertama yang di-cache CDN.** `?cursor=` kosong berarti "halaman pertama", dan itu satu-satunya halaman yang layak di-cache. Halaman dengan cursor bersifat per-pengguna dan per-waktu; menandainya cacheable membocorkan hasil satu pengguna ke pengguna lain.

5. **Index yang tidak cocok dengan arah urut.** Cursor `DESC` di atas index `ASC` tetap bisa dipakai PostgreSQL (pemindaian mundur), tetapi index komposit dengan arah campuran — `(a ASC, b DESC)` — tidak. Arah di index WAJIB cocok dengan arah di `ORDER BY`.

6. **Pagination di atas hasil gabungan beberapa sumber.** Menggabungkan dua layanan lalu memaginasi hasilnya menuntut mengambil lebih banyak dari keduanya, dan cursornya harus menyandikan posisi di **masing-masing** sumber. Ini jauh lebih rumit daripada yang terlihat; sering lebih baik memaginasi per sumber.

7. **Crawler dan skrip ekspor menyasar halaman terdalam.** Justru mereka yang paling sering membuka `OFFSET` besar, dan justru itu yang paling mahal. Untuk ekspor, sediakan jalur khusus berbasis cursor atau streaming — jangan biarkan mereka memakai endpoint yang sama dengan UI.

## Kapan JANGAN Pakai Ini

- **Cursor untuk UI yang benar-benar butuh lompat ke halaman tertentu.** Panel admin dengan nomor halaman tidak bisa dilayani cursor. Bila kebutuhannya nyata, OFFSET pada dataset yang **kecil dan stabil** masih pilihan yang sah.
- **Pagination untuk hasil yang selalu kecil.** Daftar yang dijamin di bawah beberapa ratus baris — daftar negara, peran, kategori — lebih baik dikirim utuh dan di-cache. Pagination di situ menambah jalur kode tanpa manfaat.
- **`COUNT(*)` eksak sebagai fitur produk.** Bila UI menampilkan "1.284.392 hasil", tanyakan siapa yang benar-benar memakainya. Angka perkiraan hampir selalu cukup, dan biayanya beberapa orde lebih rendah.
- **Cursor pada data yang diurut berdasarkan skor yang dihitung ulang** — relevansi pencarian, peringkat rekomendasi. Skor berubah antar permintaan, sehingga posisi cursor menjadi tidak bermakna. Untuk itu, materialisasi hasil per sesi pencarian.
- **Mengubah dari OFFSET ke cursor tanpa versi API baru.** Bentuk parameter dan respons berubah; klien lama akan rusak. Lihat `microservices_grpc/api_versioning_strategy.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi naik sebanding nomor halaman | nilai `OFFSET` di query | Database membaca lalu membuang N baris |
| Pengguna melapor item terlewat atau ganda | apakah OFFSET dipakai pada data hidup | Perilaku normal OFFSET, bukan bug logika |
| Satu endpoint mendominasi waktu database | `pg_stat_statements` untuk query berpaginasi | Halaman dalam dibuka crawler/ekspor |
| Memori melonjak dari satu permintaan | plafon ukuran halaman | `?limit` tanpa batas atas |
| `COUNT(*)` muncul di query paling mahal | apakah total dihitung tiap halaman | Total eksak dihitung ulang terus-menerus |
| Halaman berikutnya mengulang isi yang sama | baris mana yang jadi cursor | Cursor menunjuk baris pertama, bukan terakhir |

```sql
-- Query berpaginasi yang paling menghabiskan waktu TOTAL
SELECT calls, mean_exec_time::int AS rata_ms, total_exec_time::int AS total_ms,
       left(query, 80) AS query
FROM pg_stat_statements
WHERE query ILIKE '%offset%' OR query ILIKE '%limit%'
ORDER BY total_exec_time DESC LIMIT 15;

-- Rencana untuk halaman dalam: cari "Rows Removed" yang besar,
-- itu tanda baris dibaca lalu dibuang oleh OFFSET
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM artikel ORDER BY dibuat_pada DESC LIMIT 20 OFFSET 100000;

-- Perkiraan total yang murah, untuk menggantikan COUNT(*) eksak
SELECT reltuples::bigint AS perkiraan_baris FROM pg_class WHERE relname = 'artikel';
```

```bash
# Nilai offset dan limit yang benar-benar diminta klien
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.query.offset) | .query.offset' | sort -n | tail -10

kubectl logs -l app=api --since=1h \
  | jq -r 'select(.query.limit) | .query.limit' | sort -n | uniq -c | tail -10

# Klien yang menyasar halaman terdalam -- biasanya crawler atau skrip ekspor
kubectl logs -l app=api --since=24h \
  | jq -r 'select((.query.offset // 0 | tonumber) > 10000) | .user_agent' | sort | uniq -c | sort -rn
```
