# Iterator `iter.Seq` & Range-Over-Func

> **Berlaku:** Go 1.23+ (`iter` stabil) · `slices`/`maps` iterator helper sejak 1.23 · **Lihat juga:** `runtime_internals/go_generics_type_parameters.md` · `runtime_internals/escape_analysis_pprof.md` · `db_sqlc/query_optimization_n_plus_one.md`

## Konsep Utama

Sebelum Go 1.23, tidak ada cara baku untuk mengiterasi struktur data kustom. Setiap pustaka mengarang polanya sendiri, dan pemanggil harus mempelajari ulang tiap kali:

| Pola lama | Masalahnya |
| :--- | :--- |
| `Next() bool` + `Value()` | Bertele-tele; mudah lupa `Close()`; error diperiksa terpisah |
| Callback `ForEach(func(T) error)` | Tidak bisa `break`, `continue`, atau `return` dari pemanggil |
| Kembalikan `[]T` | Seluruh isi masuk memori — mustahil untuk 10 juta baris |
| Kembalikan `chan T` | Satu goroutine per iterasi; bocor bila pemanggil berhenti di tengah |

Go 1.23 membakukan semuanya menjadi **fungsi biasa** yang bisa dipakai langsung oleh `for range`:

```go
type Seq[V any]     func(yield func(V) bool)
type Seq2[K, V any] func(yield func(K, V) bool)
```

Idenya membalik arah kendali. Iterator memanggil `yield` untuk tiap elemen; **`yield` mengembalikan `false` ketika pemanggil ingin berhenti**. Kompilator menerjemahkan `break`, `continue`, `return`, bahkan `goto` di badan `for range` menjadi nilai balik `yield` yang tepat.

Konsekuensi yang membuatnya jauh lebih baik daripada callback:

```go
for user := range db.StreamUsers(ctx) {
    if user.Banned {
        continue          // bekerja
    }
    if user.ID == target {
        return user, nil  // return dari fungsi LUAR — bekerja
    }
}
```

Dengan `ForEach(func(User) error)`, `return` di atas mustahil tanpa error sentinel yang canggung.

### Nilai sesungguhnya: streaming tanpa materialisasi

Ini bukan gula sintaksis. Perbedaannya nyata di memori:

| Pendekatan | 10 juta baris @ 200 byte |
| :--- | :--- |
| `[]User` | ~2 GB heap, GC tertekan, risiko OOM |
| `iter.Seq[User]` | memori tetap ~ukuran satu baris |

**Aturan pembersihan yang WAJIB diingat:** `defer` di dalam fungsi iterator berjalan ketika iterator selesai — termasuk ketika pemanggil `break` di tengah. Inilah yang membuat iterator aman untuk sumber daya yang harus ditutup, berbeda dari channel yang bocor bila pemanggil pergi.

## Diagram ASCII

```text
   ARAH KENDALI — kenapa break/return bisa bekerja

   for v := range seq { ... break ... }
   
   pemanggil                    iterator (seq)
   ---------                    --------------
        |   panggil seq(yield)        |
        |---------------------------->|
        |                             | ambil elemen 1
        |        yield(v1)            |
        |<----------------------------|
        | jalankan badan loop         |
        |   -> true (lanjut)          |
        |---------------------------->|
        |                             | ambil elemen 2
        |        yield(v2)            |
        |<----------------------------|
        | badan loop kena `break`     |
        |   -> FALSE                  |
        |---------------------------->|
        |                             | keluar dari loop internal
        |                             | defer rows.Close() JALAN
        |          return             |
        |<----------------------------|

   Bandingkan channel: pemanggil break -> iterator tetap mengirim ->
   goroutine terblokir selamanya -> BOCOR.

   ---------------------------------------------------------------

   PIPELINE TANPA MATERIALISASI

   StreamRows ---> Filter ---> Map ---> Take(100)
      |             |           |         |
      +-- 1 baris --+-- 1 baris-+- 1 baris+
      
   Puncak memori = 1 baris, bukan 10 juta.
   Take(100) berhenti -> yield=false merambat ke hulu -> query dibatalkan.
```

## Kode Go Production-Ready

Streaming baris database sebagai iterator, lengkap dengan penanganan error — bagian yang paling sering salah dirancang.

```go
package stream

import (
	"context"
	"database/sql"
	"fmt"
	"iter"
)

// User adalah baris hasil query.
type User struct {
	ID    int64
	Email string
	Aktif bool
}

// Rows membungkus iterator beserta error terakhirnya.
//
// KEPUTUSAN DESAIN: iter.Seq tidak bisa mengembalikan error, jadi ada dua pola:
//   1. iter.Seq2[T, error] — error per elemen. Cocok bila tiap elemen bisa
//      gagal sendiri-sendiri (mis. dekode berkas per baris).
//   2. Seq + Err() terpisah — cocok untuk sumber yang gagal SEKALI lalu berhenti,
//      seperti kursor DB. Pola ini dipakai di sini, meniru bufio.Scanner.
type Rows struct {
	seq iter.Seq[User]
	err error
}

// All mengembalikan urutan yang bisa dipakai `for range`.
func (r *Rows) All() iter.Seq[User] { return r.seq }

// Err WAJIB diperiksa setelah loop selesai. Loop yang berakhir lebih cepat
// dari perkiraan hampir selalu berarti ada error di sini.
func (r *Rows) Err() error { return r.err }

// StreamUsers mengalirkan pengguna aktif tanpa memuat seluruhnya ke memori.
func StreamUsers(ctx context.Context, db *sql.DB, batas int) *Rows {
	out := &Rows{}
	out.seq = func(yield func(User) bool) {
		rows, err := db.QueryContext(ctx,
			`SELECT id, email, aktif FROM users WHERE aktif = true ORDER BY id LIMIT $1`, batas)
		if err != nil {
			out.err = fmt.Errorf("query users: %w", err)
			return
		}
		// Berjalan juga saat pemanggil `break` di tengah — inilah alasan
		// iterator aman untuk sumber daya, tidak seperti channel.
		defer rows.Close()

		for rows.Next() {
			var u User
			if err := rows.Scan(&u.ID, &u.Email, &u.Aktif); err != nil {
				out.err = fmt.Errorf("scan baris: %w", err)
				return
			}
			// yield=false berarti pemanggil sudah cukup. Berhenti dengan rapi.
			if !yield(u) {
				return
			}
		}
		if err := rows.Err(); err != nil {
			out.err = fmt.Errorf("iterasi baris: %w", err)
		}
	}
	return out
}

// Filter meneruskan hanya elemen yang lolos predikat. Malas: tidak ada
// pekerjaan yang dilakukan sampai hasilnya benar-benar di-range.
func Filter[T any](src iter.Seq[T], lolos func(T) bool) iter.Seq[T] {
	return func(yield func(T) bool) {
		for v := range src {
			if !lolos(v) {
				continue
			}
			if !yield(v) {
				return
			}
		}
	}
}

// Map mengubah tiap elemen. Perhatikan dua parameter tipe — inilah yang
// membuat pipeline generik bisa berganti tipe di tengah jalan.
func Map[A, B any](src iter.Seq[A], ubah func(A) B) iter.Seq[B] {
	return func(yield func(B) bool) {
		for v := range src {
			if !yield(ubah(v)) {
				return
			}
		}
	}
}

// Take membatasi jumlah elemen. Berhenti di hulu begitu kuota tercapai —
// query DB pun ikut dibatalkan.
func Take[T any](src iter.Seq[T], n int) iter.Seq[T] {
	return func(yield func(T) bool) {
		if n <= 0 {
			return
		}
		sisa := n
		for v := range src {
			if !yield(v) {
				return
			}
			sisa--
			if sisa == 0 {
				return
			}
		}
	}
}

// Chunk mengelompokkan elemen menjadi potongan berukuran n.
// Berguna untuk bulk insert tanpa menahan seluruh data di memori.
func Chunk[T any](src iter.Seq[T], n int) iter.Seq[[]T] {
	return func(yield func([]T) bool) {
		if n <= 0 {
			return
		}
		buf := make([]T, 0, n)
		for v := range src {
			buf = append(buf, v)
			if len(buf) < n {
				continue
			}
			// Salin: pemanggil boleh menyimpan potongan ini.
			keluar := make([]T, len(buf))
			copy(keluar, buf)
			buf = buf[:0]
			if !yield(keluar) {
				return
			}
		}
		if len(buf) > 0 {
			yield(buf)
		}
	}
}
```

## Uji

```go
package stream

import (
	"iter"
	"slices"
	"testing"
)

// dari membuat iter.Seq dari slice untuk keperluan uji.
func dari[T any](xs ...T) iter.Seq[T] {
	return func(yield func(T) bool) {
		for _, x := range xs {
			if !yield(x) {
				return
			}
		}
	}
}

func TestFilterMapTake(t *testing.T) {
	src := dari(1, 2, 3, 4, 5, 6, 7, 8)
	genap := Filter(src, func(n int) bool { return n%2 == 0 })
	kali10 := Map(genap, func(n int) int { return n * 10 })
	dua := Take(kali10, 2)

	got := slices.Collect(dua)
	want := []int{20, 40}
	if !slices.Equal(got, want) {
		t.Fatalf("mau %v, dapat %v", want, got)
	}
}

func TestTake_MenghentikanHulu(t *testing.T) {
	// Membuktikan kemalasan: hulu TIDAK boleh memproses lebih dari yang diminta.
	dibaca := 0
	src := iter.Seq[int](func(yield func(int) bool) {
		for i := 0; i < 1000; i++ {
			dibaca++
			if !yield(i) {
				return
			}
		}
	})

	got := slices.Collect(Take(src, 3))
	if len(got) != 3 {
		t.Fatalf("mau 3 elemen, dapat %d", len(got))
	}
	if dibaca != 3 {
		t.Fatalf("hulu seharusnya berhenti setelah 3, tapi membaca %d", dibaca)
	}
}

func TestChunk(t *testing.T) {
	got := slices.Collect(Chunk(dari(1, 2, 3, 4, 5), 2))
	if len(got) != 3 {
		t.Fatalf("mau 3 potongan, dapat %d", len(got))
	}
	if !slices.Equal(got[2], []int{5}) {
		t.Fatalf("potongan terakhir mau [5], dapat %v", got[2])
	}
}

func TestChunk_PotonganTidakSalingMenimpa(t *testing.T) {
	// Tanpa salin di dalam Chunk, seluruh potongan akan menunjuk buffer sama.
	got := slices.Collect(Chunk(dari(1, 2, 3, 4), 2))
	if !slices.Equal(got[0], []int{1, 2}) {
		t.Fatalf("potongan pertama rusak: %v", got[0])
	}
}

func TestBreak_MenjalankanDefer(t *testing.T) {
	dibersihkan := false
	src := iter.Seq[int](func(yield func(int) bool) {
		defer func() { dibersihkan = true }()
		for i := 0; ; i++ {
			if !yield(i) {
				return
			}
		}
	})

	for v := range src {
		if v == 2 {
			break
		}
	}
	if !dibersihkan {
		t.Fatal("defer di iterator WAJIB jalan meski pemanggil break")
	}
}
```

## Anti-Pattern

**❌ SALAH — memuat seluruh hasil ke slice**

```go
func AmbilSemuaUser(ctx context.Context, db *sql.DB) ([]User, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, email, aktif FROM users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.Aktif); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
```

Pemanggil yang hanya butuh 10 baris pertama tetap membayar seluruh 10 juta. Pada 200 byte per baris, ini 2 GB heap dan tekanan GC yang membuat p99 seluruh service melonjak.

**✅ BENAR — iterator, pemanggil menentukan berapa yang dipakai**

```go
r := StreamUsers(ctx, db, 10_000_000)
for u := range Take(r.All(), 10) {
	fmt.Println(u.Email)
}
if err := r.Err(); err != nil { // WAJIB, jangan dilewat
	return err
}
```

**❌ SALAH — channel sebagai iterator**

```go
func UserChan(ctx context.Context, db *sql.DB) <-chan User {
	ch := make(chan User)
	go func() {
		defer close(ch)
		rows, _ := db.Query(`SELECT ...`)
		defer rows.Close()
		for rows.Next() {
			var u User
			_ = rows.Scan(&u.ID, &u.Email, &u.Aktif)
			ch <- u // BOCOR bila pemanggil break
		}
	}()
	return ch
}
```

Pemanggil yang `break` di elemen ke-3 meninggalkan goroutine terblokir selamanya di `ch <- u`, memegang koneksi DB. Satu goroutine bocor per pemanggilan.

**✅ BENAR — iterator; `break` merambat ke hulu dan `defer` membersihkan**

Lihat `StreamUsers` di atas — `yield` mengembalikan `false`, fungsi `return`, `defer rows.Close()` jalan, koneksi dilepas.

**❌ SALAH — melupakan `Err()` setelah loop**

```go
for u := range StreamUsers(ctx, db, 100).All() {
	proses(u)
}
// Loop berakhir "normal" padahal query gagal di baris ke-7. Diam-diam salah.
```

**✅ BENAR — periksa error setelah loop, seperti `bufio.Scanner`**

```go
r := StreamUsers(ctx, db, 100)
for u := range r.All() {
	proses(u)
}
if err := r.Err(); err != nil {
	return fmt.Errorf("streaming users: %w", err)
}
```

## Kasus Tepi Produksi

1. **Iterator tidak bisa mengembalikan error langsung.** Dua pola sah: `iter.Seq2[T, error]` bila tiap elemen bisa gagal sendiri, atau `Seq` + `Err()` terpisah untuk sumber yang gagal sekali lalu berhenti. Campuran keduanya membingungkan pemanggil — pilih satu per pustaka dan konsisten.

2. **`yield` dipanggil setelah mengembalikan `false`** menyebabkan panic runtime. Selalu `return` segera setelah `!yield(v)`. Bug ini muncul saat menulis iterator berlapis yang lupa merambatkan penghentian.

3. **Iterator berumur panjang memegang sumber daya.** `defer rows.Close()` baru jalan saat iterasi selesai. Bila pemanggil menyimpan `iter.Seq` lalu me-range-nya 10 menit kemudian, koneksi DB ditahan selama itu. Untuk sumber daya mahal, ambil koneksi **di dalam** iterator (seperti kode di atas), bukan di luar.

4. **`context` yang dibatalkan tidak otomatis menghentikan iterator.** `db.QueryContext` menghormati pembatalan pada level driver, tapi loop `rows.Next()` perlu pemeriksaan eksplisit bila iterasinya panjang dan tidak menyentuh jaringan. Sisipkan `select { case <-ctx.Done(): return; default: }` bila memproses batch besar di memori.

5. **Ongkos alokasi pada pipeline dalam.** Tiap lapis `Filter`/`Map` menambah satu closure dan satu frame pemanggilan per elemen. Untuk 10 elemen ini tidak berarti; untuk 100 juta elemen di jalur panas, ukur dengan `benchmarking_pprof.md` — kadang loop tunggal yang eksplisit lebih murah. Jangan menebak, ukur.

6. **`slices.Collect` mengembalikan materialisasi.** Berguna di test, tapi memakainya di produksi mengembalikan Anda ke masalah semula. Pakai hanya bila jumlah elemennya benar-benar terbatas.

## Kapan JANGAN Pakai Ini

- **Koleksi kecil berukuran tetap.** `[]T` biasa lebih sederhana, lebih cepat, dan lebih mudah dibaca. Iterator untuk slice 5 elemen adalah kerumitan tanpa imbalan.
- **Ketika pemanggil selalu butuh seluruh data.** Kalau setiap pemanggil langsung `slices.Collect`, iterator hanya menambah lapisan. Kembalikan slice saja.
- **Iterasi bersamaan (paralel).** `iter.Seq` bersifat berurutan berdasarkan desain. Untuk fan-out paralel, pakai `errgroup` — lihat `concurrency/worker_pool_errgroup.md`.
- **API publik yang harus mendukung Go 1.22 ke bawah.** `iter` baru ada di 1.23. Untuk pustaka dengan dukungan versi lama, sediakan keduanya atau tunda.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Lonjakan heap saat endpoint listing dipanggil | `heap_inuse` per endpoint, pprof heap | Materialisasi seluruh hasil query; kandidat iterator |
| Goroutine terus bertambah tanpa turun | `runtime.NumGoroutine()`, `goroutine` profile | Iterator berbasis channel yang pemanggilnya berhenti di tengah |
| Koneksi DB pool habis padahal QPS rendah | `db.Stats().InUse` vs `MaxOpenConns` | Kursor tidak ditutup — `defer rows.Close()` tidak pernah tercapai |
| GC pause naik seiring jumlah data | `GODEBUG=gctrace=1` | Alokasi besar berumur pendek dari slice hasil query |

```bash
# Siapa yang mengalokasi paling banyak
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# Goroutine yang menggantung di kirim channel
curl -s 'localhost:6060/debug/pprof/goroutine?debug=2' | grep -A5 'chan send'

# Cari fungsi yang mengembalikan slice besar dari query
grep -rn "var out \[\]" --include="*.go" internal/ | head -20
```
