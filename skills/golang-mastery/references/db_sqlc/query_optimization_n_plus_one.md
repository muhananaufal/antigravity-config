# Query Optimization: Menumpas N+1 & JSON Aggregation

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
	"testing"
	"time"

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
	
	query := `
		SELECT 
			u.id, 
			u.name, 
			COALESCE(
				jsonb_agg(
					jsonb_build_object(
						'id', p.id, 
						'title', p.title
					)
				) FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb
			) as posts_json
		FROM users u
		LEFT JOIN posts p ON p.user_id = u.id
		GROUP BY u.id, u.name
		ORDER BY u.id DESC
		LIMIT $1
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
```
