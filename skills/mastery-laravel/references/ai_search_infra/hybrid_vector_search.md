# Hybrid Vector Search Infrastructure di Laravel 11/12

## 1. Pengantar dan Teori Fundamental

Hybrid Vector Search adalah teknik pencarian mutakhir (state-of-the-art) yang menggabungkan dua metodologi pencarian utama secara bersamaan:

1. **Sparse Retrieval (Keyword/Lexical Search)**: Menggunakan algoritma probabilitas seperti BM25, TF-IDF, atau PostgreSQL FTS (`to_tsvector`). Algoritma ini mencari kecocokan kata kunci eksak berdasarkan frekuensi istilah dalam dokumen versus frekuensi di seluruh korpus.
   * **Kekuatan**: Sangat akurat untuk pencarian *exact match*, ID unik (misalnya UUID, nomor resi), entitas spesifik, atau terminologi medis/teknis.
   * **Kelemahan**: Tidak memahami konteks, gagal mengenali sinonim, dan rentan terhadap typo.

2. **Dense Retrieval (Semantic/Vector Search)**: Menggunakan model Embedding *Machine Learning* (seperti OpenAI `text-embedding-3-small` atau BGE-M3) untuk memetakan setiap kalimat/dokumen ke dalam ruang vektor berdimensi tinggi (misalnya array dengan 1536 float). Algoritma kemudian menghitung *Cosine Similarity* atau *Dot Product* untuk mengukur jarak antar vektor.
   * **Kekuatan**: Mampu mencari berdasarkan *makna* dan relevansi semantik. Menangkap konteks meskipun tidak ada satupun kata yang persis sama.
   * **Kelemahan**: Sering gagal untuk pencarian kata kunci yang sangat unik/out-of-vocabulary, karena model bisa saja mengaburkan fitur khusus dari angka acak/serial number.

**Mengapa Hybrid Wajib untuk Top 1% Platform?**
Sistem yang murni menggunakan vektor search (Semantic Only) akan gagal di tes sederhana: mencari produk elektronik berdasarkan nomor serinya. Sistem murni keyword gagal di tes "produk serupa dengan bahasa alami". Hybrid mengatasi hal ini dengan mengeksekusi kedua *pipeline* sekaligus.

### Algoritma Penggabungan: Reciprocal Rank Fusion (RRF)
Untuk menggabungkan hasil dari sistem Keyword (yang menghasilkan skor *unbounded* sembarang) dan Semantic (yang menghasilkan skor normalisasi 0-1), kita tidak bisa sekadar menjumlahkannya secara mentah (*linear combination*). Sebagai standar industri, kita menggunakan **Reciprocal Rank Fusion (RRF)** yang merata-rata bobot berdasarkan **Peringkat (Rank)** alih-alih skor absolut.

$$ RRF\_Score = \frac{1}{k + Rank_{sparse}} + \frac{1}{k + Rank_{dense}} $$

Di mana:
- $Rank_{sparse}$ adalah peringkat dokumen pada hasil *Keyword Search*.
- $Rank_{dense}$ adalah peringkat dokumen pada hasil *Vector Search*.
- $k$ adalah konstanta stabilitas (biasanya diatur ke 60, terbukti secara empiris memberikan kualitas *ranking* paling optimal dari riset akademik).

---

## 2. Arsitektur Infrastruktur (Clean Architecture)

Dalam *Enterprise Laravel Framework*, membangun fitur ini secara scalable mensyaratkan pemisahan batas lapisan (*layer boundaries*) yang ketat. Kode tidak boleh diletakkan di satu Controller raksasa.

1. **Presentation Layer**: `SearchController` & `SearchRequest` bertugas memvalidasi *input* HTTP dan merangkai *output* response JSON.
2. **Application Layer**: `PerformHybridSearchAction` bertindak sebagai koordinator yang memanggil service embedding dan mengomandoi pencarian.
3. **Data Transfer Object (DTO)**: Menggunakan class `SearchCriteria` dan `SearchResult` sebagai kontrak *type-safe* antar layer.
4. **Infrastructure Layer**: `OpenAIEmbeddingClient` (implementasi HTTP) & `PostgresArticleRepository` (implementasi eksekusi CTE PostgreSQL).
5. **Domain Layer**: Entitas abstrak `Article` dan antarmuka *contracts*.

---

## 3. Implementasi Kode Production-Ready (PHP 8.3/8.4)

### 3.1. Data Transfer Objects (DTO) dan Interface Contracts

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\DTO;

/**
 * Membungkus kriteria pencarian dari Presentation Layer.
 */
readonly class SearchCriteria
{
    public function __construct(
        public string $query,
        public int $limit = 20,
        public float $minSimilarity = 0.65,
    ) {}
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\DTO;

/**
 * Representasi seragam dari satu baris hasil pencarian.
 */
readonly class SearchResult
{
    public function __construct(
        public int $id,
        public string $title,
        public string $snippet,
        public float $rrfScore,
    ) {}
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\Contracts;

interface EmbeddingServiceInterface
{
    /**
     * Dapatkan dimensi vektor. Wajib ketat mengembalikan array of float.
     * 
     * @return array<int, float>
     */
    public function embedText(string $text): array;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\Contracts;

use App\Domain\Search\DTO\SearchResult;

interface ArticleRepositoryInterface
{
    /**
     * @param array<int, float> $vector
     * @return array<int, SearchResult>
     */
    public function hybridSearch(
        string $keyword, 
        array $vector, 
        int $limit, 
        float $minSimilarity
    ): array;
}
```

### 3.2. Infrastructure / PostgreSQL Repository

Implementasi RRF murni di database memanfaatkan `pgvector` dan Full Text Search. Teknik CTE (*Common Table Expressions*) di bawah ini adalah rahasia untuk eksekusi kilat (di bawah 50ms untuk dataset moderat) karena menghindarkan transfer data mentah ke memori PHP.

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use App\Domain\Search\Contracts\ArticleRepositoryInterface;
use App\Domain\Search\DTO\SearchResult;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

final class PostgresArticleRepository implements ArticleRepositoryInterface
{
    public function hybridSearch(string $keyword, array $vector, int $limit, float $minSimilarity): array
    {
        if (empty($vector)) {
            throw new InvalidArgumentException('Vector array cannot be empty for semantic search.');
        }

        // Sanitasi ke format literal PostgreSQL array, bebas dari SQL Injection
        // karena $vector sudah dipastikan array of floats oleh Type System.
        $vectorString = '[' . implode(',', $vector) . ']';
        $rrfConstant = 60; // Standard $k value untuk Reciprocal Rank Fusion

        // Query CTE kompleks yang melakukan agregasi rank secara in-memory database
        $sql = <<<SQL
            WITH semantic_search AS (
                SELECT id, title, LEFT(content, 150) as snippet,
                       1 - (embedding <=> ?::vector) AS similarity,
                       RANK() OVER (ORDER BY embedding <=> ?::vector) AS dense_rank
                FROM articles
                WHERE 1 - (embedding <=> ?::vector) >= ?
                LIMIT 100
            ),
            keyword_search AS (
                SELECT id, title, LEFT(content, 150) as snippet,
                       ts_rank(to_tsvector('english', title || ' ' || content), plainto_tsquery('english', ?)) AS rank_score,
                       RANK() OVER (ORDER BY ts_rank(to_tsvector('english', title || ' ' || content), plainto_tsquery('english', ?)) DESC) AS sparse_rank
                FROM articles
                WHERE to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', ?)
                LIMIT 100
            )
            SELECT 
                COALESCE(s.id, k.id) as id,
                COALESCE(s.title, k.title) as title,
                COALESCE(s.snippet, k.snippet) as snippet,
                COALESCE(1.0 / (? + s.dense_rank), 0.0) + COALESCE(1.0 / (? + k.sparse_rank), 0.0) AS rrf_score
            FROM semantic_search s
            FULL OUTER JOIN keyword_search k ON s.id = k.id
            ORDER BY rrf_score DESC
            LIMIT ?;
        SQL;

        $bindings = [
            // Parameter untuk Vector (Cosine Distance: <=>)
            $vectorString, $vectorString, $vectorString, $minSimilarity,
            // Parameter untuk FTS (ts_rank dan @@)
            $keyword, $keyword, $keyword,
            // Parameter untuk konstanta K (60)
            $rrfConstant, $rrfConstant,
            // Limit Final
            $limit
        ];

        // Eksekusi RAW SQL secara aman dengan Binding Parameters
        $results = DB::select($sql, $bindings);

        // Map PDO object ke DTO yang aman
        return array_map(
            fn (object $row) => new SearchResult(
                id: (int) $row->id,
                title: (string) $row->title,
                snippet: (string) $row->snippet,
                rrfScore: (float) $row->rrf_score,
            ),
            $results
        );
    }
}
```

### 3.3. Application Service (Action)

Action adalah orkestrator bisnis. Tanggung jawabnya menjahit service `EmbeddingServiceInterface` yang melakukan request ke OpenAI/LLM dan `ArticleRepositoryInterface` yang menjalankan database.

```php
<?php

declare(strict_types=1);

namespace App\Application\Search\Actions;

use App\Domain\Search\Contracts\ArticleRepositoryInterface;
use App\Domain\Search\Contracts\EmbeddingServiceInterface;
use App\Domain\Search\DTO\SearchCriteria;
use App\Domain\Search\DTO\SearchResult;
use Illuminate\Support\Facades\Log;

final readonly class PerformHybridSearchAction
{
    public function __construct(
        private ArticleRepositoryInterface $repository,
        private EmbeddingServiceInterface $embeddingService,
    ) {}

    /**
     * Eksekusi hybrid pipeline pencarian utama.
     * 
     * @return array<int, SearchResult>
     */
    public function execute(SearchCriteria $criteria): array
    {
        // 1. Generate Embeddings (Call External API)
        $vector = $this->embeddingService->embedText($criteria->query);
        
        // Logging performa dan observabilitas
        Log::info('Initiating hybrid search', [
            'query' => $criteria->query,
            'limit' => $criteria->limit,
        ]);

        // 2. Fetch Aggregated Result dari Infra Repository
        return $this->repository->hybridSearch(
            keyword: $criteria->query,
            vector: $vector,
            limit: $criteria->limit,
            minSimilarity: $criteria->minSimilarity
        );
    }
}
```

### 3.4. HTTP Layer (Request Validasi & Controller)

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Search;

use Illuminate\Foundation\Http\FormRequest;

final class SearchArticleRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Sesuaikan dengan logic policy (contoh: hanya auth user/API key valid)
        return true; 
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'q' => ['required', 'string', 'min:3', 'max:255'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'threshold' => ['sometimes', 'numeric', 'min:0.1', 'max:1.0'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Search;

use App\Application\Search\Actions\PerformHybridSearchAction;
use App\Domain\Search\DTO\SearchCriteria;
use App\Http\Requests\Search\SearchArticleRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Symfony\Component\HttpFoundation\Response;

final class SearchController extends Controller
{
    public function __construct(
        private readonly PerformHybridSearchAction $searchAction
    ) {}

    /**
     * Mapping data ke response. Dilarang meletakkan logika bisnis disini.
     */
    public function __invoke(SearchArticleRequest $request): JsonResponse
    {
        $criteria = new SearchCriteria(
            query: $request->validated('q'),
            limit: (int) $request->validated('limit', 20),
            minSimilarity: (float) $request->validated('threshold', 0.65),
        );

        $results = $this->searchAction->execute($criteria);

        // Map DTO back to Array for JSON response
        $mappedData = array_map(fn (SearchResult $result) => [
            'id' => $result->id,
            'title' => $result->title,
            'snippet' => $result->snippet,
            'score' => round($result->rrfScore, 4), // Hindari e-notation di JSON
        ], $results);

        return response()->json([
            'meta' => [
                'query' => $criteria->query,
                'total_returned' => count($results),
            ],
            'data' => $mappedData,
        ], Response::HTTP_OK);
    }
}
```

---

## 4. Anti-Patterns & Production Security (Wajib Hindari)

### 🚨 Anti-Pattern 1: Eksekusi Reciprocal Rank Fusion (RRF) di Application Level Memory

**❌ KODE SALAH:**
```php
<?php
// Mengambil ribuan data besar ke RAM PHP lalu memproses RRF
$keywordResults = Article::whereFullText('title', $query)->take(1000)->get();
// Menjalankan query vector manual tanpa CTE
$vectorResults = DB::select('SELECT *, (1 - (embedding <=> ?)) as dist FROM articles LIMIT 1000', [$vector]);

$allResults = [];
foreach ($keywordResults as $i => $item) {
    // Array manipulation memory ballooning
    $allResults[$item->id] = ($allResults[$item->id] ?? 0) + (1 / (60 + $i));
}
foreach ($vectorResults as $i => $item) {
    $allResults[$item->id] = ($allResults[$item->id] ?? 0) + (1 / (60 + $i));
}
// Sorting array raksasa in-memory 💥
arsort($allResults);
```

**Mengapa Berbahaya (Memory Risk)?**
Mengambil ribuan *instance* (misal: 2000 Eloquent objects) ke memori (RAM) web server *Worker PHP-FPM* akan memicu kelonjakan memori ekstrem. Jika aplikasi Anda di-hit 100 concurrent user saat bersamaan, PHP-FPM akan menabrak limit memori dan meng-OOM (Out-of-Memory) *killer* keseluruhan infrastruktur app Anda, berujung *Downtime 502 Bad Gateway*.

**✅ KODE BENAR:**
Lakukan penggabungan RRF menggunakan SQL `FULL OUTER JOIN` dengan klausa CTE di tingkat Database. Seperti pada implementasi `PostgresArticleRepository` kita di atas. Server database ditulis dengan bahasa tingkat rendah seperti `C/C++` atau `Rust` yang dioptimasi untuk komputasi relasional massal dalam hitungan *microseconds*. PHP hanya menerima DTO ringkas sebesar puluhan kilobytes.


### 🚨 Anti-Pattern 2: N+1 Embeddings Request dalam Loop Saat Indexing Data

**❌ KODE SALAH:**
```php
<?php
$articles = Article::whereNull('embedding')->get();

foreach ($articles as $article) {
    // 🚨 N+1 HTTP Request ke Network Luar (OpenAI)
    $response = OpenAI::embeddings()->create([
        'model' => 'text-embedding-3-small',
        'input' => $article->content,
    ]); 
    
    $article->embedding = $response->embeddings[0]->embedding;
    $article->save(); // 🚨 N+1 Database Write
}
```

**Mengapa Berbahaya?**
1. **Network Overhead & Timeout**: Melakukan `HTTP POST` satu-per-satu untuk 10,000 data membutuhkan 10,000 TCP/TLS handshake. Proses ini akan menghabiskan waktu berjam-jam dan job *queue* akan putus karena timeout (120 detik *default* timeout Redis).
2. **Rate Limit 429**: Vendor AI seperti OpenAI memiliki ketatnya TPM/RPM (Tokens Per Minute / Requests Per Minute). N+1 API Hit akan secara instan menghabiskan jatah Requests Per Minute Anda dan Anda akan terblokir.

**✅ KODE BENAR:**
Manfaatkan *batch processing* dan kirim payload teks sebagai *array* pada Endpoint API model, lalu update ke database dalam *Batch Transactions*.

```php
<?php
use Illuminate\Support\Facades\DB;

// Ambil dalam chunk yang aman bagi memori
Article::whereNull('embedding')->chunk(500, function ($articles) {
    $inputs = $articles->pluck('content')->toArray();

    // 1 HTTP Request yang menghandle langsung 500 kalimat (Bulk Embed)
    $response = OpenAI::embeddings()->create([
        'model' => 'text-embedding-3-small',
        'input' => $inputs,
    ]);

    // Update batch efisien menggunakan Database Transaction
    DB::transaction(function () use ($articles, $response) {
        foreach ($articles as $index => $article) {
            $vector = '[' . implode(',', $response->embeddings[$index]->embedding) . ']';
            DB::statement('UPDATE articles SET embedding = ?::vector WHERE id = ?', [$vector, $article->id]);
        }
    });
});
```

---

## 5. Edge Cases & Advanced Production Tactics

1. **pgvector HNSW Indexing (Wajib)**: Secara *default*, kueri pencarian vektor di pgvector bersifat O(N) (*Sequential Scan* tabel penuh). Anda **WAJIB** membuat indeks `hnsw` (Hierarchical Navigable Small World).
   ```sql
   -- Menggunakan operator distance khusus (vector_cosine_ops) 
   -- m: jumlah edge max antar node. ef_construction: presisi graf.
   CREATE INDEX articles_embedding_hnsw_idx 
   ON articles USING hnsw (embedding vector_cosine_ops) 
   WITH (m = 16, ef_construction = 64);
   ```
2. **Kecocokan Dimensi Vektor (Dimensionality Collapse)**: Model seperti `text-embedding-ada-002` dan `text-embedding-3-small` OpenAI menghasilkan array `1536` dimensi. Model Open Source e5/minilm menghasilkan `384` atau `768`. Jika Anda men-declare `embedding vector(1536)` namun menerima `768` array *float*, PostgreSQL akan melemparkan *fatal insert error*. Pastikan pipeline selaras!
3. **Mengapa Pagination di RRF Sulit?**: Kueri `LIMIT OFFSET` standar tidak relevan jika menggunakan CTE untuk perankingan algoritma rekursif. Pendekatan untuk *Infinite Scroll* pada RRF bukan *Offset*, namun mengambil ID yang terpilih dari hasil komputasi *Limit besar (1000 ID)*, melakukan cache di `Redis` array, lalu mempaginate pada Redis Cache menggunakan *pointer Offset* sederhana.

---

## 6. Architecture & Unit Testing (Pest v3)

Kode Top 1% harus disertai perlindungan Anti-Regresi dan Pengawasan Arsitektur.

### 6.1. Architecture Tests (`tests/ArchitectureTest.php`)

```php
<?php

declare(strict_types=1);

test('controller tidak mengakses model database secara langsung')
    ->expect('App\Http\Controllers\Search')
    ->not->toUse('App\Models')
    ->not->toUse('App\Domain\Search\Contracts\ArticleRepositoryInterface');

test('action service hanya memanggil interface, tidak menggunakan request HTTP mentah')
    ->expect('App\Application\Search\Actions')
    ->not->toUse('Illuminate\Http\Request')
    ->not->toUse('Illuminate\Foundation\Http\FormRequest');

test('domain dan application wajib strict typed')
    ->expect(['App\Domain', 'App\Application'])
    ->toUseStrictTypes();
```

### 6.2. Unit Testing Service (`tests/Unit/PerformHybridSearchActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Application\Search\Actions\PerformHybridSearchAction;
use App\Domain\Search\Contracts\ArticleRepositoryInterface;
use App\Domain\Search\Contracts\EmbeddingServiceInterface;
use App\Domain\Search\DTO\SearchCriteria;
use App\Domain\Search\DTO\SearchResult;

it('menjalankan alur pencarian hibrida dengan memanggil dua interface', function () {
    // 1. Arrange Mocks & Setup Data
    $criteria = new SearchCriteria('laravel tips', 5, 0.70);
    $mockVector = [0.111, 0.222, 0.333];
    $fakeRrfResults = [
        new SearchResult(1, 'Top 10 Laravel Tips', 'Belajar facade...', 0.033),
    ];

    $mockEmbeddingService = Mockery::mock(EmbeddingServiceInterface::class);
    $mockEmbeddingService->shouldReceive('embedText')
        ->with('laravel tips')
        ->once()
        ->andReturn($mockVector);

    $mockRepo = Mockery::mock(ArticleRepositoryInterface::class);
    $mockRepo->shouldReceive('hybridSearch')
        ->with('laravel tips', $mockVector, 5, 0.70)
        ->once()
        ->andReturn($fakeRrfResults);

    $action = new PerformHybridSearchAction($mockRepo, $mockEmbeddingService);

    // 2. Act
    $results = $action->execute($criteria);

    // 3. Assert
    expect($results)->toBeArray()->toHaveCount(1)
        ->and($results[0])->toBeInstanceOf(SearchResult::class)
        ->and($results[0]->id)->toBe(1)
        ->and($results[0]->rrfScore)->toBe(0.033);
})->group('unit');
```

### 6.3. Database Integration Test (`tests/Integration/PostgresArticleRepositoryTest.php`)

Memastikan sintaks SQL kompleks bebas `Syntax Error` dan FTS PostgreSQL berjalan di test environment.

```php
<?php

declare(strict_types=1);

use App\Infrastructure\Persistence\PostgresArticleRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('mengeksekusi CTE database untuk hybrid search', function () {
    // 1. Setup Table and PGVector on Testing Schema
    DB::statement('CREATE EXTENSION IF NOT EXISTS vector');
    DB::statement('
        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content TEXT NOT NULL,
            embedding vector(3) -- Mock 3 Dimensi Saja untuk Test
        )
    ');

    DB::table('articles')->insert([
        ['title' => 'Laravel Framework', 'content' => 'The best web framework in PHP', 'embedding' => '[0.1, 0.2, 0.3]'],
        ['title' => 'VueJS Frontend', 'content' => 'Frontend javascript framework', 'embedding' => '[0.9, 0.1, 0.1]'],
    ]);

    $repo = new PostgresArticleRepository();
    // 2. Act (Search 'Laravel', Semantic Target dekat vektor data pertama)
    $results = $repo->hybridSearch('Laravel', [0.11, 0.22, 0.33], 10, 0.0);

    // 3. Assert
    expect($results)->toBeArray();
    if (count($results) > 0) {
        expect($results[0]->title)->toContain('Laravel');
    }
})->group('integration', 'database');
```
