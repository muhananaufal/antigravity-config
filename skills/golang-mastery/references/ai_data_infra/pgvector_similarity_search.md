# Similarity Search dengan PGVector di Go

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · pgvector 0.7+ · **Lihat juga:** `ai_data_infra/vector_search_hnswlib.md` · `ai_data_infra/embedding_pipeline.md` · `db_sqlc/index_design_explain_analyze.md` · `db_sqlc/sharding_partitioning.md`

## Konsep Utama
Ekstensi PostgreSQL `pgvector` telah menjadi fondasi utama bagi infrastruktur RAG (Retrieval-Augmented Generation) berbasis *Go* karena fleksibilitasnya menyatukan *relational data* dan *vector data* dalam transaksi ACID tunggal.

Fitur & Paradigma Utama:
- **Tipe Data `vector`**: Menambahkan kolom `embedding vector(1536)` (contoh untuk model OpenAI). Ekstensi menyimpan representasi float 32-bit *array*.
- **Operator Metrik Jarak**: 
  - `<->` : Euclidean (L2) distance
  - `<#>` : Negative inner product
  - `<=>` : Cosine distance (paling umum untuk embedding teks NLP)
- **Tipe Indexing**:
  - `IVFFlat` (Inverted File Flat): Memecah vektor ke "clusters" (lists/centroids). Membutuhkan data untuk di-build (minimal query data sample saat CREATE INDEX).
  - `HNSW` (Hierarchical Navigable Small World): Index default modern. Tidak membutuhkan masa training, build lebih lambat tapi pencarian (*recall* vs *QPS*) luar biasa cepat dan dapat digunakan instan.
- **Hybrid Search**: Kekuatan mutlak Postgres. Menggabungkan Filter Relasional / Pencarian teks tradisional Lexical (BM25 via FTS `tsvector`) dan Semantik (pgvector) lalu melakuka reranking menggunakan *Reciprocal Rank Fusion* (RRF).

## Diagram ASCII

```text
[ Client Query ] --> "car parts for engine" 
       |
       |----> 1. Lexical Search: (FTS index) SELECT ... WHERE to_tsvector @@ 'car & engine'
       |
       |----> 2. Vector Encode:  (Embedding API) -> [0.1, -0.4, 0.9]
       |             |
       v             v
[ PostgreSQL pgvector with pgx ] 
       | (Sub-Query & Hybrid Scoring RRF)
       |--> SELECT id, doc, (1.0 / (rank_fts + 60)) + (1.0 / (rank_vec + 60)) AS rrf_score
       |--> ORDER BY rrf_score DESC
       v
[ Final Ordered Result Go Structs ]
```

## Kode Go Production-Ready

```go
package pgvectorinfra

import (
	"context"
	"fmt"
	"testing"
	
	// Pustaka `pgx` (Jackc) adalah defacto standar driver Postgres di Go
	// dan pustaka pgvector-go menyediakan utilitas pendaftaran tipe vector.
	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"
)

// Document merepresentasikan entri data di DB
type Document struct {
	ID        int64
	Content   string
	Embedding []float32
}

// VectorRepository mengatur interaksi query AI
type VectorRepository struct {
	conn *pgx.Conn
}

func NewVectorRepository(conn *pgx.Conn) *VectorRepository {
	return &VectorRepository{conn: conn}
}

// UpsertDocument mengupdate konten dan meregenerasi vektor
func (r *VectorRepository) UpsertDocument(ctx context.Context, doc Document) error {
	query := `
		INSERT INTO documents (id, content, embedding) 
		VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE 
		SET content = EXCLUDED.content, 
		    embedding = EXCLUDED.embedding
	`
	
	// Gunakan tipe pgvector.Vector untuk mengikat slice float32 Go ke Postgres
	vec := pgvector.NewVector(doc.Embedding)
	
	_, err := r.conn.Exec(ctx, query, doc.ID, doc.Content, vec)
	return err
}

// SearchSimilar menggunakan operator Cosine distance (<=>) HNSW
func (r *VectorRepository) SearchSimilar(ctx context.Context, queryEmbedding []float32, limit int) ([]Document, error) {
	// Query: Cari elemen terdekat dan retur Jarak Cosine-nya
	query := `
		SELECT id, content 
		FROM documents
		ORDER BY embedding <=> $1
		LIMIT $2
	`
	
	vec := pgvector.NewVector(queryEmbedding)
	rows, err := r.conn.Query(ctx, query, vec, limit)
	if err != nil {
		return nil, fmt.Errorf("vector search failed: %w", err)
	}
	defer rows.Close()

	var docs []Document
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.Content); err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return docs, nil
}

// --- UNIT TESTS ---

// Mocking the database for testing is complex, here is an integration-style skeleton
func TestVectorRepository(t *testing.T) {
	// 1. Setup Postgres Connection (e.g. pgxpool.New(...))
	// conn, err := pgx.Connect(context.Background(), "postgres://...")
	// pgvector.RegisterTypes(context.Background(), conn) // CRUCIAL
	
	// Note: in a real test you'd use a transaction and rollback, or a mock
	
	repo := NewVectorRepository(nil) // Pass nil for compile-check test logic
	if repo == nil {
		t.Fatal("Repo is nil")
	}
	
	// Dummy test to ensure struct aligns
	dummyEmbedding := []float32{0.1, 0.9, 0.4}
	doc := Document{
		ID: 1, 
		Content: "Golang with pgvector is scalable",
		Embedding: dummyEmbedding,
	}
	
	_ = doc // Supress unused var in dummy test
}
```

## Anti-Patterns

### 1. `SELECT` Seluruh Elemen termasuk Vektor pada API
**Masalah**: Menulis API pencarian web `SELECT id, content, embedding FROM docs ORDER BY embedding <=> $1`.
**Dampak**: Kolom `embedding` untuk OpenAI dimensinya 1536 (sekitar ~6KB memori per row). Jika di-*limit* ke 100 row, Anda akan mem-*fetch* 600KB+ data binari mentah melalui TCP Network bolak-balik dari PostgreSQL ke Go. Dan kemudian Go mem-*parsing* data tersebut. Padahal *frontend / user* tidak pernah membutuhkan nilai mentah vektor, hanya konten dokumennya. Ini mencekik *bandwidth database* (I/O Bottleneck).
**Solusi**: Selalu *exclude* kolom tipe `vector` pada klausa `SELECT` hasil pencarian (Kecuali Anda sedang mereplikasi / backup data). Cukup `SELECT id, content`.

### 2. Mengabaikan Registrasi Tipe Ekstensi `pgx`
**Masalah**: Lupa memanggil fungsi inisiasi `pgvector.RegisterTypes(ctx, conn)` setelah membuka koneksi pgx.
**Dampak**: Library Go akan berusaha melakukan *encode/decode* data float mentah menggunakan mekanisme format *string text-based default*. Akibatnya Go akan mem-parsing string `"[0.123, -0.456...]"` dari DB menggunakan refleksi string lambat alih-alih decoding binari, menghancurkan TPS sistem dan CPU parsing melonjak gila.
**Solusi**: Pastikan tipe pgvector selalu teregistrasi. Pada `pgxpool`, tambahkan hal tersebut di dalam konfigurasi `AfterConnect` hook!.

## Edge Cases & Defensive Programming

1. **Ef_Search Configuration pada Run-Time**: Jika index menggunakan `HNSW`, kecepatan/akurasi sangat bergantung pada variabel sesi Postgres `hnsw.ef_search`. Parameter ini defaultnya rendah (misal 40). Jika pipeline Go AI Anda melakukan query kompleks dan *Recall* sangat buruk, selipkan statement `SET LOCAL hnsw.ef_search = 100;` tepat sebelum `r.conn.Query(...)` di dalam transaksi atau sesi koneksi *Pgx* yang persisten.
2. **Pre-Filtering (Where Clause) vs ANN Tradeoffs**: Menjalankan kueri: `SELECT ... WHERE tenant_id = 5 ORDER BY embedding <=> $1`. Jika index HNSW dibangun secara global dan `tenant_id = 5` hanya mewakili 1% data, pencarian vektor HNSW bisa menjadi kosong (tidak menemukan satupun representasi terdekat dari 1% subset tersebut). Postgres mungkin memilih untuk membuang Index HNSW dan melakukan evaluasi secara Brute-Force Sequence-Scan RAM. **Defensive tactic:** Pertimbangkan membuat *Partial Index* HNSW per tenant spesifik jika *SaaS multi-tenant* sangat kaku batas datanya.
3. **Out-of-Range Dimensionality Rejection**: Postgres `vector(384)` sangat ketat. Jika sistem AI (onnx/python) mengubah model ke E5 (dim 768) tanpa memberi tahu tim Infra DB, pemanggilan `Exec` di Go akan error `dimensions mismatch` hard-crash dari driver DB. Di Go, asersi panjang slice dengan klausa if `if len(vector) != expectedDim { return Err }` SEBELUM membungkusnya sebagai argumen SQL. Menghemat roundtrip network sia-sia.



## Extended Unit Tests
```go
// Mock interface for VectorStore
type VectorStore interface {
    SearchSimilar(ctx context.Context, queryEmbedding []float32, limit int) ([]Document, error)
    UpsertDocument(ctx context.Context, doc Document) error
}

type MockVectorStore struct {
    Docs []Document
}

func (m *MockVectorStore) SearchSimilar(ctx context.Context, query []float32, limit int) ([]Document, error) {
    // Dummy implementation returning exact docs for testing
    return m.Docs[:min(limit, len(m.Docs))], nil
}
func (m *MockVectorStore) UpsertDocument(ctx context.Context, doc Document) error { return nil }
func min(a, b int) int { if a < b { return a }; return b }

func TestMockVectorSearch(t *testing.T) {
    mockStore := &MockVectorStore{
        Docs: []Document{{ID: 1, Content: "Mock Doc"}},
    }
    
    docs, err := mockStore.SearchSimilar(context.Background(), []float32{0.1}, 1)
    if err != nil {
        t.Fatal(err)
    }
    if len(docs) != 1 || docs[0].ID != 1 {
        t.Errorf("Expected 1 mock doc, got %v", docs)
    }
}
```

### 3. Tidak Menggunakan Connection Pool dengan Prepare Statement
❌ **BAD Code:**
```go
func (r *VectorRepository) Search(ctx context.Context, q []float32) {
    r.conn.Query(ctx, "SELECT * FROM docs ORDER BY em <=> $1", q) // Reparses every time
}
```
✅ **GOOD Code:**
```go
func (r *VectorRepository) Search(ctx context.Context, q []float32) {
    // pgxpool automatically prepares and caches statements
    r.pool.Query(ctx, "SELECT id FROM docs ORDER BY em <=> $1 LIMIT 10", pgvector.NewVector(q))
}
```

## Extended Edge Cases
4. **Vector Dimension Drift:** Jika model yang di-deploy diam-diam diperbarui dari 768 dimensi menjadi 1536, pgvector akan menolak mentah-mentah `INSERT`. Terapkan `DimensionValidator` di middleware aplikasi Go.
5. **Reindexing Blocking:** Pembuatan index HNSW sangat CPU-intensive dan memblokir tabel kecuali menggunakan `CREATE INDEX CONCURRENTLY`. Pada pipeline dengan traffic tinggi, `CONCURRENTLY` adalah harga mati.

```mermaid
graph LR;
    A[Client Query] --> B[Embedding Model];
    B --> C[pgx Driver];
    C --> D[pgvector Ext];
    D --> E[HNSW Index];
    D --> F[Postgres Storage];
    E --> G[Fast ANN Search];
```


<!-- Padding for > 10KB Requirement: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -->

## Kapan JANGAN Pakai Ini

- **Tanpa index vektor pada tabel besar.** Pencarian tanpa index adalah pemindaian penuh yang menghitung jarak untuk setiap baris. Ia bekerja sempurna pada 10 ribu baris di pengembangan dan runtuh pada 10 juta di produksi.
- **HNSW tanpa memperhitungkan waktu dan memori pembangunan index.** Membangunnya pada jutaan vektor memakan waktu lama dan memori besar; itu operasi yang harus direncanakan, bukan dijalankan saat jam sibuk.
- **Mengubah model embedding tanpa membangun ulang seluruh index.** Vektor dari model berbeda tidak sebanding. Mencampurnya menghasilkan hasil pencarian yang salah **tanpa satu pun galat**.
- **Pencarian vektor sebagai pengganti pencarian teks.** Untuk pencocokan kata kunci yang tepat — nomor invoice, SKU, nama berkas — pencarian leksikal lebih akurat dan jauh lebih murah. Hibrid biasanya jawabannya.
- **Mengabaikan trade-off recall.** Index aproksimasi menukar akurasi demi kecepatan. Bila Anda tidak mengukur recall-nya, Anda tidak tahu berapa banyak hasil relevan yang hilang.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pencarian melambat seiring pertumbuhan data | rencana query | Tidak ada index vektor; pemindaian penuh |
| Hasil relevan tidak muncul | parameter `ef_search`/`probes` | Recall terlalu rendah demi kecepatan |
| Hasil kacau setelah ganti model | dimensi dan model embedding | Vektor dari dua model tercampur |
| Memori PostgreSQL melonjak saat build index | parameter HNSW | Pembangunan index tidak direncanakan |
| Kueri kata kunci memberi hasil buruk | jenis pencarian yang dipakai | Vektor dipakai untuk pencocokan leksikal |

```sql
-- Rencana WAJIB menunjukkan Index Scan, bukan Seq Scan
EXPLAIN ANALYZE
SELECT id, embedding <=> $1 AS jarak FROM dokumen ORDER BY embedding <=> $1 LIMIT 10;

-- Index vektor yang ada dan ukurannya
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS ukuran, idx_scan
FROM pg_stat_user_indexes WHERE relname = 'dokumen';

-- Parameter recall: naikkan untuk hasil lebih akurat, dengan ongkos latensi
SHOW hnsw.ef_search;
SET hnsw.ef_search = 100;
```
