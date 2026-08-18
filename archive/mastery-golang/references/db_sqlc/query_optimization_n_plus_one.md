# Query Optimization: Menumpas N+1 & JSON Aggregation

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `db_sqlc/index_design_explain_analyze.md` · `db_sqlc/sqlc_pgx_driver.md` · `microservices_grpc/graphql_gqlgen_dataloader.md` · `db_sqlc/multi_layer_caching.md`

## Konsep dan Internals

Kelemahan paling kronis dan mematikan dalam pengembangan backend berbasis objek (terutama saat transisi dari ORM ke SQL murni) adalah **Anomali N+1**.
Ini terjadi saat Anda mengeksekusi 1 kueri utama (Misal: Daftar 50 Pengguna), lalu melakukan iterasi (*looping*) dalam memori aplikasi, dan mengeksekusi $N$ kueri tambahan untuk mengambil data relasi per item (Misal: Daftar Artikel untuk Pengguna 1, Daftar Artikel untuk Pengguna 2, dst).

Dalam Go, hal ini sangat destruktif. Bukan hanya membebani CPU, tetapi hambatan sesungguhnya adalah **Network RTT (Round Trip Time)**. Jika jeda jaringan server ke DB adalah 2ms, maka 50 kueri beruntun akan *memblokir (menggantung)* Goroutine Anda selama **100 milidetik penuh** sebelum respon HTTP terkirim ke *client*!

### Evolusi Penanganan N+1
1. **Bad (Looping N+1)**: Eksekusi $1 + N$ kueri. Sering membocorkan (*leak*) `pgxpool`.
2. **Better (Eager Loading IN)**: Eksekusi 2 kueri: `SELECT * FROM users` dan `SELECT * FROM posts WHERE user_id = ANY($1::int[])`. Cepat, tapi aplikasi Go harus menyusun algoritma *HashMap* di memori (`map[int][]Post`) untuk menjahit (menyatukan) data tersebut kembali.
3. **Best (PostgreSQL Native `JSONB_AGG`)**: Eksekusi 1 kueri tunggal. Memerintahkan modul internal PostgreSQL (yang ditulis dalam bahasa C super cepat) untuk melakukan *grouping* (pengelompokan) dan *marshaling* memori langsung ke format Array JSON. Aplikasi Go hanya menerima struktur mentah (`[]byte`) dan langsung di-`json.Unmarshal`.

---

## Diagram ASCII: Arsitektur Eksekusi Jaringan N+1 vs JSONB_AGG

```text
========================================================================================
[ ANOMALI N+1 (Membunuh Throughput Jaringan) ]
Go Application                                PostgreSQL (Port 5432)
|---- 1. SELECT * FROM users LIMIT 100 -----> | 
| <------ (Kembalikan 100 User) ------------- | (2ms)
|---- 2. SELECT * FROM posts WHERE id=1 ----> |
| <------ (Kembalikan Posts User 1) --------- | (2ms)
|---- 3. SELECT * FROM posts WHERE id=2 ----> |
| <------ (Kembalikan Posts User 2) --------- | (2ms)
... (Terus berulang hingga 100x)
TOTAL WAKTU TUNGGU JARINGAN: > 202 milidetik! (Goroutine Idle/Tertahan)

========================================================================================
[ POLA EFEKTIF: JSONB_AGG (C-Engine Aggregation) ]
Go Application                                PostgreSQL (Port 5432)
|                                             |
|---- SELECT u.*, JSONB_AGG(p.*) AS posts --> | (Menyatukan JOIN & Grouping)
|     FROM users u LEFT JOIN posts p          | (Postgres menyusun JSON secara internal)
|                                             |
| <------ (1 Kueri! Mengembalikan 100 baris,  | (15ms komputasi + 2ms RTT = 17ms)
|          di mana kolom posts adalah JSON) - | 
|                                             |
(Go mengeksekusi json.Unmarshal di RAM) (1ms) |
TOTAL WAKTU TUNGGU JARINGAN: ~18 milidetik! (11X Lebih Cepat)
========================================================================================
```

---

## Kode Go Production-Ready

Contoh berikut mengimplementasikan `JSONB_AGG` beserta penanganan *Edge Case Null Array* bawaan PostgreSQL.

```go
package database

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UserDTO adalah objek transfer data (termasuk relasinya) untuk layer Service/HTTP
type UserDTO struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Posts     []PostDTO `json:"posts"`
}

type PostDTO struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

// FetchUsersWithPosts mendemonstrasikan penghancuran N+1 via Layer Database.
func FetchUsersWithPosts(ctx context.Context, pool *pgxpool.Pool, limit int) ([]UserDTO, error) {
	// 1. jsonb_build_object merakit key-value dari tabel child.
	// 2. jsonb_agg merangkum seluruh objek menjadi array [{}, {}].
	// 3. FILTER (WHERE) mencegah terciptanya array sakti berisi null: "[null]" jika relasi kosong.
	// 4. COALESCE memberikan jaminan balikan array kosong "[]" yang valid di-parsing Go.
	
	// URUTAN KLAUSA DI SINI MENENTUKAN SEGALANYA.
	//
	// Bentuk yang SALAH -- dan yang paling sering disalin:
	//     FROM users u LEFT JOIN posts p ON ...
	//     GROUP BY u.id, u.name
	//     ORDER BY u.id DESC
	//     LIMIT $1
	// LIMIT diterapkan SETELAH agregasi. PostgreSQL akan men-JOIN SELURUH
	// tabel users dengan SELURUH posts, mengelompokkan semuanya, mengurutkan
	// hasilnya, lalu membuang semua kecuali 20 baris. Pada tabel 1 juta
	// pengguna, query "optimal" ini justru membaca seluruh basis data --
	// persis kebalikan dari yang ingin dicapai.
	//
	// Bentuk yang BENAR: batasi INDUK lebih dulu di CTE, baru gabungkan
	// anaknya. Hanya `limit` pengguna yang pernah disentuh.
	//
	// LIMIT pada anak juga WAJIB: satu pengguna dengan 150.000 komentar
	// menghasilkan dokumen JSON puluhan megabyte di memori server.
	query := `
		WITH induk AS (
			SELECT id, name
			FROM users
			ORDER BY id DESC
			LIMIT $1
		)
		SELECT
			i.id,
			i.name,
			COALESCE(
				jsonb_agg(
					jsonb_build_object('id', p.id, 'title', p.title)
					ORDER BY p.id DESC
				) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb
			) AS posts_json
		FROM induk i
		LEFT JOIN LATERAL (
			SELECT id, title
			FROM posts
			WHERE user_id = i.id
			ORDER BY id DESC
			LIMIT 50          -- batas anak per induk; tanpa ini payload bisa meledak
		) p ON true
		GROUP BY i.id, i.name
		ORDER BY i.id DESC
	`

	rows, err := pool.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query aggregation failed: %w", err)
	}
	defer rows.Close() // Wajib agar tidak membocorkan koneksi pool!

	var result []UserDTO
	for rows.Next() {
		var u UserDTO
		// pgx secara native akan menerjemahkan byte jsonb postgres ke []byte (json.RawMessage) Go
		var rawPosts []byte 

		if err := rows.Scan(&u.ID, &u.Name, &rawPosts); err != nil {
			return nil, fmt.Errorf("scan failed on row %d: %w", u.ID, err)
		}

		// Terjemahkan byte array ke struct Go (Memindahkan beban CPU parsing ke Go)
		if err := json.Unmarshal(rawPosts, &u.Posts); err != nil {
			return nil, fmt.Errorf("failed to decode jsonb array for user %d: %w", u.ID, err)
		}

		result = append(result, u)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iteration error: %w", err)
	}

	return result, nil
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengiterasi *Scan* di Dalam Loop `Next()` (Klasik N+1)
Developer ORM sering tak sadar melakukan ini, tetapi dalam *Go raw SQL*, memanggil kueri di tengah rotasi *Rows*.

```go
// ❌ BAD: Menembak kakinya sendiri (Pool Exhaustion & N+1)
rows, _ := db.Query(ctx, "SELECT id, name FROM users LIMIT 10")
defer rows.Close()

for rows.Next() {
	var id int
	rows.Scan(&id) // Mengkonsumsi pointer baris dari Koneksi 1
	
	// BAHAYA: Membuka Kueri di Atas Koneksi Tambahan!
	// Ini melipatgandakan beban, memblokir thread loop.
	db.QueryRow(ctx, "SELECT COUNT(*) FROM posts WHERE user_id = $1", id) 
}
```
**Why dangerous:** Selain mengidap N+1 RTT yang sangat lambat, Anda **menahan** 1 koneksi idle (`rows.Next`) selama proses eksekusi loop yang juga menuntut 1 koneksi baru tiap iterasi (`db.QueryRow`). Di sistem dengan *traffic* tinggi, perilaku (*Nested Query*) ini secara harfiah akan menyapu bersih semua kapasitas *pgxpool* (Pool kelaparan, *Deadlock* lokal). 

**✅ Solusi Benar:** Gunakan mekanisme satu kueri *Join / Subquery / Lateral* (seperti `JSONB_AGG` atau klausa `IN`).

### ❌ Anti-Pattern 2: `IN = ANY($1::int[])` dengan Array Kosong (`len == 0`)
Teknik pemecahan Eager Loading sering mem-passing argument (Slice/Array) ke klausa Postgres `ANY`.

```go
// ❌ BAD: Tidak divalidasi
var emptyIDs []int // length = 0
// Kueri di bawah bisa error sintaks "syntax error at or near ')'" 
// pada beberapa driver abstrak atau memakan cost komputasi yang tidak perlu.
db.Query(ctx, "SELECT * FROM posts WHERE user_id = ANY($1::int[])", emptyIDs) 
```

**✅ Solusi Benar:** Lakukan pencegatan logika pendek (*Short-circuiting*). Jika slice induk di Go bernilai 0 (kosong), tidak perlu menelepon database sama sekali. Langsung kembalikan array kosong secepat kilat (0ms).

---

## Edge Cases & Defensive Programming

1. **Jebakan `[null]` pada Relasi Kosong (LEFT JOIN)**
   Jika *User 101* sama sekali belum menulis Post, `LEFT JOIN posts` mengembalikan kolom `posts` yang keseluruhannya `NULL`. Secara harfiah, instruksi agregasi tipe data relasional akan merekam iterasi `NULL` itu. Kembalian mentah dari PostgreSQL `JSONB_AGG` menjadi *string* sakti: `[null]`.
   Masalahnya, saat `json.Unmarshal("[null]", &[]PostDTO)` beraksi, Go akan kebingungan (mencoba membaca struct di dalam null) atau malah mereturn *Slice* panjang $1$ berisi objek/struct kosong. *Defensive programming* wajib memanfaatkan `FILTER (WHERE relation.id IS NOT NULL)` dan `COALESCE` untuk secara paksa menjinakkan responnya kembali ke format `[]`.

2. **Ledakan Payload Memory & Latensi Garbage Collector**
   Memindahkan konstruksi data (JOIN) ke JSONB_AGG memang melenyapkan N+1, tetapi menciptakan masalah baru pada tabel gemuk: Payload Raksasa. Jika Pengguna 101 punya **150.000** komentar, database akan membentuk Dokumen JSON seberat 50MB di memori C-Engine dan mentransfer seluruhnya melalui jaringan (TCP Stream) ke Go. Alhasil, memori Heap aplikasi Go melonjak (OOM), lalu *Garbage Collector (GC)* Go macet bermilidetik mencoba membuang JSON tersebut seusai parsing (GC Thrashing). 
   **Pastikan limit!** Gunakan kueri `LATERAL` dengan `LIMIT` maksimal 50-100 baris anak (child rows) per entitas parent (Paginasi).

3. **Batasan Caching Execution Plan**
   Satu kelemahan jika Anda memakai string generator `IN (?,?,?)` konvensional secara iteratif: Setiap jumlah penanda tanya `?` yang berbeda akan dimengerti *Query Planner* PostgreSQL sebagai eksekusi baru yang berbeda. Anda akan mendesak (`Evict`) eksekusi log yang sebenarnya mirip. Solusinya (seperti di atas): Selalu operasikan tipe Array native Postgres `$1::int[]` dan `ANY()`, karena `($1)` selalu terkompilasi sebagai 1 pola baku walau *Slice*-nya berisi 5 atau 500 nilai id.

---

## Unit Tests

Menguji struktur dan logika *parsing* hasil komputasi *JSON Aggregation* untuk memastikan kekebalan (*resilience*) terhadap artifak null.

```go
package database_test

import (
	"encoding/json"
	"testing"
	"yourproject/internal/database" // sesuaikan path import
)

// Simulasi unmarshal logic secara mandiri dari layer database
func TestParseJSONAggregation_Robustness(t *testing.T) {
	tests := []struct {
		name          string
		mockPGPayload []byte
		expectLen     int
		expectErr     bool
	}{
		{
			name:          "Normal Populated Relation",
			mockPGPayload: []byte(`[{"id": 1, "title": "A"}, {"id": 2, "title": "B"}]`),
			expectLen:     2,
			expectErr:     false,
		},
		{
			// Simulasi jika developer lupa menggunakan klausa FILTER dan COALESCE
			name:          "Dangerous Artifact [null] from Missing Filter",
			mockPGPayload: []byte(`[null]`),
			expectLen:     0,
			expectErr:     true, // Go unmarshal akan membuahkan struct kosong jika tidak ditangani 
		},
		{
			// Output idaman jika menggunakan pattern COALESCE(..., '[]'::jsonb)
			name:          "Safe Coalesced Empty Relation",
			mockPGPayload: []byte(`[]`),
			expectLen:     0,
			expectErr:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var parsedPosts []database.PostDTO
			err := json.Unmarshal(tt.mockPGPayload, &parsedPosts)

			// Validasi kelemahan [null]
			if !tt.expectErr && err != nil {
				t.Fatalf("Unexpected parsing error: %v", err)
			}

			// Khusus menjinakkan the [null] artifact, unmarshal mungkin tidak melempar error,
			// tapi meng-insert struct zero value. Kita harus validasi length nyatanya.
			validCount := 0
			for _, p := range parsedPosts {
				// jika struct nilainya nol/kosong, berarti korban artifact null
				if p.ID != 0 { 
					validCount++
				}
			}

			if validCount != tt.expectLen {
				t.Errorf("Expected valid posts len %d, got %d", tt.expectLen, validCount)
			}
		})
	}
}

---

## Anti-Pattern 3: JSONB Abuse (Penyalahgunaan JSONB)
Terkadang developer yang malas melakukan normalisasi memilih untuk membuang semua child entities ke dalam satu kolom `JSONB`. 
```go
// ❌ BAD: Memasukkan relasi dinamis yang Sering Difilter ke JSONB
db.Query(ctx, "SELECT * FROM posts WHERE metadata->>'author_type' = 'admin'") 
```
**Impact:** Query planner Postgres tidak bisa menggunakan statistics secara efisien untuk JSONB. Melakukan sekuensial scan atau bahkan harus membuat GIN index raksasa.
**✅ Solusi:** Normalisasikan ke kolom nyata / tabel nyata jika *field* tersebut sering menjadi klausa `WHERE`. JSONB hanya untuk atribut bebas yang *jarang* di-filter.
```

## 6. EXPLAIN ANALYZE Workflow di Go

Untuk meyakinkan diri kita bahwa kueri kita telah teroptimasi dengan indeks (*Index Scan*) dan bukan memindai semua baris secara kotor (*Sequential Scan*), kita bisa langsung mengujinya di dalam *test suite* Go dengan mengeksekusi `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.

### Deteksi Auto via EXPLAIN dan `pg_stat_statements`
1. **`pg_stat_statements`**: Ekstensi Postgres ini terus mencatat waktu eksekusi kueri riil. Jika di *production*, monitoring Go (Prometheus) bisa melirik ke log tabel fungsi tersebut untuk menemukan kueri lambat.
2. **Regresi via JSON Plan**: Di pipeline CI/CD (Test Go), kita mengeksekusi *EXPLAIN JSON* untuk menangkap rencana eksekusi dan memastikannya *Index Scan*. Jika kode berubah dan kueri ter-downgrade menjadi lamban *Sequential Scan*, *Test* akan otomatis melempar `t.Fatal()`.

### Contoh Kode Go: Query Plan Capture (Regresi Test)

```go
package database_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Struct ringkas untuk mem-parsing respons JSON EXPLAIN dari PostgreSQL
type ExplainPlan []struct {
	Plan struct {
		NodeType string `json:"Node Type"`
		Plans    []struct {
			NodeType string `json:"Node Type"`
		} `json:"Plans"`
	} `json:"Plan"`
}

func TestQueryDoesNotUseSequentialScan(t *testing.T) {
	ctx := context.Background()
	// db := ... inisialisasi pool pgx test

	query := `SELECT * FROM users WHERE email = $1`
	
	// Prefix dengan EXPLAIN (ANALYZE, FORMAT JSON)
	explainQuery := "EXPLAIN (ANALYZE, FORMAT JSON) " + query
	
	var planJSON string
	err := db.QueryRow(ctx, explainQuery, "test@test.com").Scan(&planJSON)
	if err != nil {
		t.Fatalf("Failed to run explain: %v", err)
	}

	var plan ExplainPlan
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		t.Fatalf("Failed to parse plan json: %v", err)
	}

	// Deteksi rekursif sederhana jika mengandung kata "Seq Scan"
	if strings.Contains(planJSON, "Seq Scan") {
		t.Errorf("PERFORMANCE REGRESSION DETECTED: Query uses Sequential Scan! Add an index. Plan: %v", plan[0].Plan.NodeType)
	}
}
```

### Edge Case: EXPLAIN ANALYZE pada Production

**Masalah:** 
Perintah `EXPLAIN ANALYZE` **BENAR-BENAR MENGEKSEKUSI** *kueri* yang ada di belakangnya secara nyata, untuk mengukur waktu milidetiknya. Jika Anda merancang *diagnostic endpoint* `/debug/explain?q=DELETE FROM users`, dan user memanggilnya, *semua user Anda benar-benar akan terhapus!*

**Dampak Samping Eksekusi:**
- Data termutasi secara tak terduga (*side effect*).
- Jika pada tabel raksasa (*heavy query*), akan membebani CPU server Production seketika.

**Solusi:**
1. Hanya gunakan flag `ANALYZE` di lingkungan tes atau replika. 
2. Jika terpaksa di production (untuk kueri mutasi seperti `UPDATE/DELETE`), selalu bungkus dalam blok `BEGIN; EXPLAIN ANALYZE ...; ROLLBACK;` untuk mencegah mutasi permanen!

## Kapan JANGAN Pakai Ini

- **`jsonb_agg` untuk hasil yang sangat besar.** Seluruh dokumen dibangun di memori server lalu dikirim sekaligus. Untuk 100 ribu baris anak, ini menaikkan memori PostgreSQL sekaligus latensi. Dua query terpisah lalu digabungkan di Go lebih hemat.
- **Satu query raksasa dengan banyak `JOIN` demi menghindari N+1.** Perkalian baris (fan-out) bisa membuat hasil yang dikirim jauh lebih besar daripada data sebenarnya — 100 pesanan × 20 item × 5 tag = 10.000 baris untuk 125 objek.
- **Batching pada jalur yang memang mengambil satu baris.** Kerumitan dataloader tidak terbayar bila jumlah anaknya nol atau satu.
- **`IN (...)` dengan daftar puluhan ribu ID.** Rencana query membengkak dan waktu parse ikut naik. Pakai `= ANY($1::bigint[])` dengan satu parameter array, atau salin ID ke tabel sementara.
- **Mengoptimalkan sebelum mengukur.** N+1 yang berjalan tiga kali per permintaan bukan masalah. Yang berjalan tiga ribu kali baru masalah — dan hanya pengukuran yang bisa membedakannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi naik sebanding jumlah item di halaman | jumlah query per permintaan | Tanda paling khas N+1 |
| `pg_stat_statements`: `calls` sangat tinggi, `mean_exec_time` sangat rendah | rasio calls vs total_exec_time | Ribuan query kecil; masing-masing cepat, totalnya lambat |
| CPU database tinggi tapi tidak ada query lambat | total_exec_time terakumulasi | Beban berasal dari volume, bukan dari satu query berat |
| Memori PostgreSQL melonjak pada endpoint tertentu | ukuran hasil `jsonb_agg` | Agregasi membangun dokumen raksasa di memori |
| Satu trace berisi ratusan span database | jumlah span `db.*` per trace | N+1 yang terlihat langsung di tracing |

```sql
-- Ciri khas N+1: calls sangat tinggi, rata-rata sangat cepat, total mendominasi
SELECT calls, mean_exec_time::numeric(10,3) AS rata_ms,
       total_exec_time::int AS total_ms, left(query,70) AS query
FROM pg_stat_statements
WHERE calls > 10000 ORDER BY calls DESC LIMIT 20;

-- Query yang paling menghabiskan waktu SECARA TOTAL -- bukan yang paling lambat
SELECT calls, total_exec_time::int AS total_ms, left(query,70)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;
```

```bash
# Jumlah span database per trace. Satu trace dengan 200 span db = N+1 yang jelas.
curl -s "$JAEGER/api/traces?service=api&limit=20" \
  | jq '[.data[] | {trace: .traceID,
                    db: ([.spans[] | select(.operationName | test("^db"))] | length)}]
        | sort_by(-.db)[:5]'
```
