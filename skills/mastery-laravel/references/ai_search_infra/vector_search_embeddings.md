# Vector Search & Embeddings Infrastructure di Laravel 11+

## 1. Pendahuluan & Teori Dasar

Vector Search (Pencarian Vektor) dan Embeddings adalah fondasi utama dari sistem pencarian semantik modern (Semantic Search) dan Retrieval-Augmented Generation (RAG). Berbeda dengan pencarian leksikal tradisional (seperti Full-Text Search MySQL/Elasticsearch) yang mencocokkan keyword secara eksak, Vector Search memahami konteks dan makna semantik dari teks, gambar, atau audio.

### Konsep Embeddings
Embedding adalah representasi numerik (vektor densitas tinggi) dari data (misalnya teks) dalam ruang berdimensi tinggi ($N$-dimensional space). Semakin mirip makna dua buah teks, semakin dekat posisi vektor representasinya di dalam ruang tersebut. Model populer seperti OpenAI `text-embedding-3-small` menghasilkan vektor dengan 1536 dimensi, sedangkan model lokal seperti BAAI/bge-m3 menghasilkan 1024 dimensi.

### Metrik Jarak dan Similaritas (Distance Metrics)
Untuk mengukur seberapa "dekat" dua vektor, kita menggunakan metrik jarak matematis:
1.  **Cosine Similarity**: Mengukur sudut antara dua vektor. Rentang nilainya dari -1 (berlawanan) hingga 1 (sangat mirip). Paling sering digunakan untuk teks karena mengabaikan magnitudo (panjang teks). Rumus: $\cos(\theta) = \frac{A \cdot B}{||A|| ||B||}$.
2.  **Euclidean Distance (L2)**: Mengukur jarak garis lurus antara ujung dua vektor. Berguna saat magnitudo penting.
3.  **Dot Product**: Perkalian titik dua vektor. Jika vektor sudah dinormalisasi, nilainya sama dengan Cosine Similarity namun jauh lebih cepat dikomputasi.

### Algoritma Pencarian (ANN - Approximate Nearest Neighbors)
Mencari vektor terdekat di database dengan jutaan data menggunakan Exact k-NN sangat lambat ($O(N)$). Oleh karena itu, Vector Database menggunakan algoritma ANN:
-   **HNSW (Hierarchical Navigable Small World)**: Membangun struktur graf berlapis. Sangat cepat dengan akurasi tinggi, namun memakan banyak memori (RAM). Ini adalah standar industri saat ini (Pinecone, Qdrant, pgvector).
-   **IVF-PQ (Inverted File Index dengan Product Quantization)**: Mengelompokkan vektor ke dalam cluster (Voronoi cells) dan mengkompresi dimensi vektor (PQ). Memori sangat efisien namun sedikit mengorbankan akurasi.

## 2. Pemilihan Vector Database

Untuk aplikasi Laravel, terdapat beberapa opsi integrasi Vector DB:
1.  **pgvector (PostgreSQL Extension)**: Pilihan paling solid untuk ekosistem Laravel karena tidak memerlukan infrastruktur baru jika sudah menggunakan PostgreSQL. Sangat mudah digabungkan dengan Eloquent dan filter SQL standar (metadata filtering).
2.  **Pinecone / Qdrant**: Managed service atau serverless untuk sistem skala massif (ratusan juta vektor) di mana pgvector mulai mengalami bottleneck. Memiliki API REST/gRPC yang sangat cepat.
3.  **Milvus**: Open-source, highly scalable, ideal untuk level enterprise yang mengelola cluster sendiri.

Dalam panduan ini, kita menggunakan arsitektur yang agnostik, dengan implementasi spesifik **pgvector** melalui ekstensi resmi atau Raw Query PostgreSQL.

---

## 3. Clean Architecture: Integrasi Vector Search

Kita menggunakan arsitektur berlapis: `FormRequest` -> `Controller` -> `Action` (Use Case) -> `Repository` (Data Access) -> `Vector DB/LLM Client`.

### A. Value Objects & DTOs (Data Transfer Objects)

Value Object memastikan tipe data yang ketat (Strongly Typed) untuk vektor.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\ValueObjects;

use InvalidArgumentException;

final readonly class EmbeddingVector
{
    /**
     * @param array<int, float> $vector
     */
    public function __construct(
        public array $vector,
        public int $dimensions = 1536
    ) {
        if (count($vector) !== $dimensions) {
            throw new InvalidArgumentException(
                sprintf('Vector dimension mismatch. Expected %d, got %d.', $dimensions, count($vector))
            );
        }
        
        foreach ($vector as $val) {
            if (!is_float($val) && !is_int($val)) {
                throw new InvalidArgumentException('Vector values must be numeric.');
            }
        }
    }

    public function toJson(): string
    {
        return json_encode($this->vector, JSON_THROW_ON_ERROR);
    }
    
    public function toPgVectorString(): string
    {
        return '[' . implode(',', $this->vector) . ']';
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\DTOs;

use App\Domain\Search\ValueObjects\EmbeddingVector;

final readonly class SearchResultDTO
{
    public function __construct(
        public int $documentId,
        public string $content,
        public float $similarityScore,
        public array $metadata
    ) {}
}
```

### B. Client Interface untuk LLM (Embedding Generator)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\Contracts;

use App\Domain\Search\ValueObjects\EmbeddingVector;

interface EmbeddingGeneratorInterface
{
    /**
     * Menggenerate embedding dari teks.
     */
    public function generate(string $text): EmbeddingVector;
    
    /**
     * Menggenerate embedding secara batch (untuk ingestion performa tinggi).
     * @param array<int, string> $texts
     * @return array<int, EmbeddingVector>
     */
    public function generateBatch(array $texts): array;
}
```

### C. Implementasi OpenAI Embedding Client

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Search\Clients;

use App\Domain\Search\Contracts\EmbeddingGeneratorInterface;
use App\Domain\Search\ValueObjects\EmbeddingVector;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

final class OpenAIEmbeddingClient implements EmbeddingGeneratorInterface
{
    private const string MODEL = 'text-embedding-3-small';
    private PendingRequest $client;

    public function __construct(string $apiKey)
    {
        $this->client = Http::withToken($apiKey)
            ->baseUrl('https://api.openai.com/v1/')
            ->timeout(10)
            ->retry(3, 100);
    }

    public function generate(string $text): EmbeddingVector
    {
        $response = $this->client->post('embeddings', [
            'input' => $text,
            'model' => self::MODEL,
        ]);

        if ($response->failed()) {
            throw new RuntimeException('OpenAI Embedding API failed: ' . $response->body());
        }

        $vector = $response->json('data.0.embedding');
        
        return new EmbeddingVector($vector, 1536);
    }

    public function generateBatch(array $texts): array
    {
        $response = $this->client->post('embeddings', [
            'input' => $texts,
            'model' => self::MODEL,
        ]);

        if ($response->failed()) {
            throw new RuntimeException('OpenAI Batch Embedding API failed: ' . $response->body());
        }

        $vectors = [];
        $data = $response->json('data');
        foreach ($data as $item) {
            $vectors[] = new EmbeddingVector($item['embedding'], 1536);
        }

        return $vectors;
    }
}
```

### D. Model & Migration (pgvector)

Untuk pgvector, kolom menggunakan tipe `vector(1536)`. Pastikan ekstensi pgvector terinstall di instance PostgreSQL Anda (`CREATE EXTENSION vector;`).

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Pastikan extension vector aktif
        DB::statement('CREATE EXTENSION IF NOT EXISTS vector');

        Schema::create('documents', function (Blueprint $table) {
            $table->id();
            $table->text('content');
            $table->jsonb('metadata')->default('{}');
            // Menambahkan kolom vector secara spesifik menggunakan raw statement jika native method blueprint tidak mendukung
            $table->timestamps();
        });
        
        // Menambahkan kolom vector secara eksplisit
        DB::statement('ALTER TABLE documents ADD COLUMN embedding vector(1536)');
        
        // Index HNSW untuk performa tinggi pada Cosine Similarity (opsional tapi wajib untuk production)
        DB::statement('CREATE INDEX documents_embedding_hnsw_idx ON documents USING hnsw (embedding vector_cosine_ops)');
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
        DB::statement('DROP EXTENSION IF EXISTS vector');
    }
};
```

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

final class Document extends Model
{
    protected $fillable = [
        'content',
        'metadata',
        'embedding',
    ];

    protected $casts = [
        'metadata' => 'array',
        // Kita tidak auto-cast embedding menjadi array agar performa read reguler tidak terbebani deserialize vektor panjang,
        // karena tipe vektor biasanya hanya digunakan saat pencarian HNSW.
    ];
}
```

### E. Repository Pattern untuk Pencarian

```php
<?php

declare(strict_types=1);

namespace App\Infrastructure\Search\Repositories;

use App\Domain\Search\DTOs\SearchResultDTO;
use App\Domain\Search\ValueObjects\EmbeddingVector;
use Illuminate\Support\Facades\DB;

final class PgVectorDocumentRepository
{
    /**
     * Melakukan pencarian vektor berbasis Cosine Similarity (Operator <=> di pgvector).
     * 
     * @return array<int, SearchResultDTO>
     */
    public function searchSimilar(EmbeddingVector $vector, int $limit = 10, float $minScore = 0.75): array
    {
        $vectorString = $vector->toPgVectorString();
        
        // Dalam pgvector, operator <=> menghitung Cosine Distance (1 - Cosine Similarity)
        // Cosine Similarity = 1 - (embedding <=> '[...]')
        $query = "
            SELECT id, content, metadata, 
                   (1 - (embedding <=> ?::vector)) as similarity_score
            FROM documents
            WHERE (1 - (embedding <=> ?::vector)) >= ?
            ORDER BY embedding <=> ?::vector
            LIMIT ?
        ";

        $results = DB::select($query, [
            $vectorString, 
            $vectorString, 
            $minScore, 
            $vectorString, 
            $limit
        ]);

        $dtos = [];
        foreach ($results as $row) {
            $dtos[] = new SearchResultDTO(
                documentId: (int) $row->id,
                content: $row->content,
                similarityScore: (float) $row->similarity_score,
                metadata: json_decode($row->metadata, true, 512, JSON_THROW_ON_ERROR)
            );
        }

        return $dtos;
    }
}
```

### F. Action (Use Case)

```php
<?php

declare(strict_types=1);

namespace App\Domain\Search\Actions;

use App\Domain\Search\Contracts\EmbeddingGeneratorInterface;
use App\Infrastructure\Search\Repositories\PgVectorDocumentRepository;

final readonly class PerformSemanticSearchAction
{
    public function __construct(
        private EmbeddingGeneratorInterface $embeddingGenerator,
        private PgVectorDocumentRepository $repository
    ) {}

    public function execute(string $query, int $limit = 10, float $minScore = 0.7): array
    {
        // 1. Generate embedding dari query text
        $queryVector = $this->embeddingGenerator->generate($query);
        
        // 2. Lakukan pencarian Approximate Nearest Neighbors
        return $this->repository->searchSimilar($queryVector, $limit, $minScore);
    }
}
```

### G. Controller & HTTP Layer

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Search;

use Illuminate\Foundation\Http\FormRequest;

final class SemanticSearchRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'q' => ['required', 'string', 'min:3', 'max:500'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:50'],
            'min_score' => ['sometimes', 'numeric', 'min:0', 'max:1'],
        ];
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Search;

use App\Domain\Search\Actions\PerformSemanticSearchAction;
use App\Http\Requests\Search\SemanticSearchRequest;
use Illuminate\Http\JsonResponse;

final class SemanticSearchController
{
    public function __construct(
        private readonly PerformSemanticSearchAction $searchAction
    ) {}

    public function __invoke(SemanticSearchRequest $request): JsonResponse
    {
        $results = $this->searchAction->execute(
            query: $request->validated('q'),
            limit: (int) $request->validated('limit', 10),
            minScore: (float) $request->validated('min_score', 0.7)
        );

        return response()->json([
            'status' => 'success',
            'data' => $results,
            'meta' => [
                'total_returned' => count($results)
            ]
        ]);
    }
}
```

---

## 4. Anti-Patterns & Best Practices

### Anti-Pattern 1: Generate Embedding Synchronous di Proses Web
Saat pengguna mengunggah dokumen (PDF/Artikel panjang), men-generate embedding untuk puluhan/ratusan paragraf secara synchronous di Controller atau Action web request akan menyebabkan timeout dan bottleneck parah.

❌ **KODE SALAH (Synchronous Ingestion - Berbahaya!)**
```php
<?php
// Di dalam DocumentController
public function store(Request $request) {
    $document = Document::create(['content' => $request->text]);
    
    // ❌ BLOCKING: Menghubungi OpenAI untuk teks yang sangat panjang. Bisa memakan waktu 10-30 detik!
    // Memblokir worker PHP-FPM, rentan 504 Gateway Timeout.
    $vector = $this->embeddingGenerator->generate($request->text);
    
    $document->update(['embedding' => $vector->toPgVectorString()]);
    
    return response()->json(['message' => 'Success']);
}
```

✅ **KODE BENAR (Asynchronous Job & Chunking)**
Text yang besar harus di-chunk (dipotong) menjadi paragraf kecil (maksimal 500-1000 token) dan diproses melalui Background Jobs/Queue.

```php
<?php
declare(strict_types=1);

namespace App\Jobs;

use App\Domain\Search\Contracts\EmbeddingGeneratorInterface;
use App\Models\Document;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

final class ProcessDocumentEmbeddingJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    
    public int $timeout = 120;
    public int $tries = 3;

    public function __construct(
        public readonly int $documentId
    ) {}

    public function handle(EmbeddingGeneratorInterface $generator): void
    {
        $document = Document::findOrFail($this->documentId);
        
        // Best Practice: Pastikan generator menggunakan timeout!
        $vector = $generator->generate($document->content);
        
        // Gunakan DB Facade jika model cast belum diset untuk pgvector array
        \Illuminate\Support\Facades\DB::statement(
            'UPDATE documents SET embedding = ?::vector WHERE id = ?',
            [$vector->toPgVectorString(), $this->documentId]
        );
    }
}

// Di Controller:
public function store(Request $request) {
    $document = Document::create(['content' => $request->text]);
    
    // ✅ Menggunakan Queue (Redis/RabbitMQ) sehingga respons API instan
    ProcessDocumentEmbeddingJob::dispatch($document->id);
    
    return response()->json(['message' => 'Processing in background']);
}
```
**Penjelasan Mengapa Berbahaya:** API LLM sering rate-limited atau memiliki latensi tinggi. Memblokir HTTP Worker (PHP-FPM/Octane) menurunkan throughput (TPS) aplikasi secara drastis, berisiko memory exhaust, dan memberikan User Experience (UX) yang buruk (aplikasi terasa "nge-hang").

---

### Anti-Pattern 2: Limit dan Pagination Naif (Offset Pagination)
Melakukan paginasi tradisional dengan `LIMIT` dan `OFFSET` pada Vector Search merupakan bencana performa dan inakurasi secara logika.

❌ **KODE SALAH (Offset Pagination pada ANN Search - Berbahaya!)**
```php
<?php
// Di dalam Repository
public function search(EmbeddingVector $vector, int $page = 2) {
    $offset = ($page - 1) * 10;
    
    // ❌ BURUK: Menggunakan OFFSET. 
    // HNSW index tidak dioptimalkan untuk OFFSET yang dalam. Kehilangan akurasi dan membuang resource komputasi ANN.
    $query = "
        SELECT id, content FROM documents
        ORDER BY embedding <=> ?::vector
        LIMIT 10 OFFSET ?
    ";
    
    return DB::select($query, [$vector->toPgVectorString(), $offset]);
}
```

✅ **KODE BENAR (Cursor/Score-based Filtering dengan Metadata)**
Vector search difokuskan untuk "Top K" (misal top 20, 50). Jika butuh lebih dari itu, lakukan filtering lebih ketat berbasis meta-data atau cursor berbasis skor kemiripan (Score Threshold). HNSW index bekerja sangat cepat jika diberi `LIMIT` kecil, namun lambat jika dipaksa mengkalkulasi banyak `OFFSET`.

```php
<?php
// Di dalam Repository
public function search(EmbeddingVector $vector, string $categoryFilter, float $minScore = 0.8) {
    // ✅ BENAR: Gunakan Pre-Filtering (metadata) dan Score Threshold alih-alih paginasi halaman yang tak terbatas.
    // Paling efisien karena menyaring candidate vector sebelum/selama traversal HNSW.
    $query = "
        SELECT id, content, (1 - (embedding <=> ?::vector)) as score 
        FROM documents
        WHERE metadata->>'category' = ? 
          AND (1 - (embedding <=> ?::vector)) > ?
        ORDER BY embedding <=> ?::vector
        LIMIT 20
    ";
    
    $vectorStr = $vector->toPgVectorString();
    return DB::select($query, [$vectorStr, $categoryFilter, $vectorStr, $minScore, $vectorStr]);
}
```
**Penjelasan Mengapa Berbahaya:** Vector search tidak dirancang untuk menelusuri data berurutan (sequential) seperti data tabel tradisional. Jika pengguna sudah menscroll sampai dokumen ke-50 teratas dari hasil ANN dan belum menemukan apa yang dicari, artinya model gagal memberikan hasil relevan di Top K (kemungkinan query pengguna jelek, atau algoritma perlu perbaikan/reranking), BUKAN berarti kita harus menyediakan offset data ke-51 hingga 1000. OFFSET di pgvector index (HNSW) sering kali mende-gradasi kueri ke Exact-KNN (table scan), merusak performa CPU hingga memicu Out-of-Memory (OOM).

---

## 5. Testing (Pest v3)

Pest adalah framework testing modern untuk ekosistem PHP.

### Unit Test: Value Object
```php
<?php

declare(strict_types=1);

use App\Domain\Search\ValueObjects\EmbeddingVector;

it('creates embedding vector properly', function () {
    $data = array_fill(0, 1536, 0.1);
    $vector = new EmbeddingVector($data);
    
    expect($vector->dimensions)->toBe(1536)
        ->and($vector->vector)->toHaveCount(1536)
        ->and($vector->toPgVectorString())->toStartWith('[0.1,0.1')
        ->and($vector->toPgVectorString())->toEndWith(']');
});

it('throws exception if dimension mismatches', function () {
    $data = array_fill(0, 500, 0.1);
    new EmbeddingVector($data);
})->throws(InvalidArgumentException::class);
```

### Unit Test: Action 
```php
<?php

declare(strict_types=1);

use App\Domain\Search\Actions\PerformSemanticSearchAction;
use App\Domain\Search\Contracts\EmbeddingGeneratorInterface;
use App\Domain\Search\DTOs\SearchResultDTO;
use App\Domain\Search\ValueObjects\EmbeddingVector;
use App\Infrastructure\Search\Repositories\PgVectorDocumentRepository;

it('performs semantic search correctly', function () {
    $mockGenerator = Mockery::mock(EmbeddingGeneratorInterface::class);
    $mockRepo = Mockery::mock(PgVectorDocumentRepository::class);
    
    $queryStr = "How to deploy Laravel?";
    $mockVector = new EmbeddingVector(array_fill(0, 1536, 0.05));
    
    $dto = new SearchResultDTO(1, "Deploy Laravel with Vapor", 0.95, []);
    
    $mockGenerator->shouldReceive('generate')
        ->once()
        ->with($queryStr)
        ->andReturn($mockVector);
        
    $mockRepo->shouldReceive('searchSimilar')
        ->once()
        ->with($mockVector, 10, 0.7)
        ->andReturn([$dto]);
        
    $action = new PerformSemanticSearchAction($mockGenerator, $mockRepo);
    $results = $action->execute($queryStr);
    
    expect($results)->toHaveCount(1)
        ->and($results[0]->documentId)->toBe(1)
        ->and($results[0]->similarityScore)->toBe(0.95);
});
```

### Architecture Testing
Memastikan dependensi antar layer sesuai kaidah Clean Architecture.

```php
<?php

declare(strict_types=1);

arch('controllers should not use repositories directly')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Infrastructure\Search\Repositories')
    ->ignoring('Tests');

arch('domain should not depend on infrastructure')
    ->expect('App\Domain')
    ->not->toUse('App\Infrastructure')
    ->ignoring('Tests');

arch('strict types are enforced')
    ->expect('App')
    ->toUseStrictTypes();
```
