# Enterprise GraphQL via Lighthouse & Apollo Federation

Dokumen ini menguraikan arsitektur implementasi GraphQL (Nuwave Lighthouse v6) dalam konteks Enterprise. Fokus utamanya adalah mitigasi *N+1 Query Bomb*, pembatasan kompleksitas (untuk menghindari serangan DoS melalui nested queries rekursif), dan penggabungan service via Apollo Federation.

## Diagram ASCII: Alur Proteksi GraphQL & DataLoader

```ascii
[ GraphQL Client Request ]
            |
            v
[ GraphQL AST Parser (Lighthouse) ]
            |-- (Cek Max Depth: > 5? --> REJECT HTTP 400)
            |-- (Cek Max Complexity: > 1000? --> REJECT HTTP 400)
            |
            v
[ Resolvers & Directives Layer ]
            |
            v
[ DataLoader / Batching (Mitigasi N+1) ]
            | (Mengumpulkan IDs dari semua parent)
            | (Misal: User_1, User_2, User_3 meminta Posts)
            v
[ 1 Single SQL Query via Eloquent (WHERE IN) ]
            |
            v
[ Response JSON Berstruktur Terangkai (Stitched) ]
```

## Spesifikasi Teknis & Skema

### Schema Utama (`graphql/schema.graphql`)

Menerapkan paginasi dan pembatasan kedalaman (depth limits) bawaan.

```graphql
# graphql/schema.graphql

type Query {
    # Directive @paginate mencegah pengambilan seluruh tabel (OOM)
    # Directive @guard mengunci endpoint hanya untuk request terautentikasi
    users: [User!]! @paginate(defaultCount: 10, maxCount: 100) @guard
    
    user(id: ID! @eq): User @find @guard
}

type User {
    id: ID!
    name: String!
    email: String!
    
    # Directive @hasMany akan otomatis menggunakan DataLoader bawaan Lighthouse
    # sehingga bebas N+1 saat memuat banyak User sekaligus
    posts: [Post!]! @hasMany(type: "paginator", maxCount: 50)
}

type Post {
    id: ID!
    title: String!
    body: String!
    
    # Custom Data Loader untuk relasi kompleks jika @belongsTo tidak cukup
    author: User! @belongsTo
}
```

### Konfigurasi Proteksi `config/lighthouse.php`

Wajib dikonfigurasi untuk mencegah serangan eksploitasi Resource Exhaustion (GraphQL DoS).

```php
// config/lighthouse.php
'security' => [
    'max_query_complexity' => \GraphQL\Validator\Rules\QueryComplexity::class,
    'max_query_depth' => \GraphQL\Validator\Rules\QueryDepth::class,
    'disable_introspection' => \GraphQL\Validator\Rules\DisableIntrospection::class,
],
'security_defaults' => [
    'max_query_complexity' => 500, // Reject queries taking too much compute
    'max_query_depth' => 5,        // Prevents: user->posts->author->posts->author (circular)
    'disable_introspection' => env('APP_ENV') === 'production', // Sembunyikan skema di production!
],
```

## Implementasi Kode Produksi (PHP 8.3 / Laravel 11)

### Custom DataLoader Batching (Jika tidak menggunakan Directive bawaan)

Kadang kita membutuhkan koneksi ke API Eksternal (microservice lain) dan perlu mengatasi N+1 HTTP request. Kita gunakan implementasi DataLoader manual.

```php
<?php

declare(strict_types=1);

namespace App\GraphQL\DataLoaders;

use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use Nuwave\Lighthouse\Execution\DataLoader\BatchLoader;

/**
 * Batches external HTTP requests to solve N+1 problem on microservices.
 * Strict Type enforced (PHPStan Level 9).
 */
final class ExternalAuthorBatchLoader extends BatchLoader
{
    /**
     * @param array<int, int> $keys (Array of Author IDs)
     * @return array<int, array<string, mixed>> (Mapped Author Data)
     */
    public function resolve(array $keys): array
    {
        // Batch 50 IDs into 1 Single HTTP Request to another Microservice!
        // Instead of 50 individual HTTP GETs.
        $response = Http::post('https://user-service.internal/batch/authors', [
            'ids' => $keys
        ]);

        /** @var array<int, array<string, mixed>> $authors */
        $authors = $response->json('data') ?? [];

        // Map array as Collection for easy key-by processing
        $authorsCollection = collect($authors)->keyBy('id');

        $result = [];
        foreach ($keys as $key) {
            /** @var array<string, mixed>|null $authorData */
            $authorData = $authorsCollection->get($key);
            $result[$key] = $authorData;
        }

        return $result;
    }
}
```

Lalu panggil resolver ini dari class GraphQL Field:

```php
<?php

declare(strict_types=1);

namespace App\GraphQL\Queries;

use App\GraphQL\DataLoaders\ExternalAuthorBatchLoader;
use Nuwave\Lighthouse\Execution\DataLoader\BatchLoaderRegistry;

final class PostAuthorResolver
{
    /**
     * @param array<string, mixed> $root The parent Post object
     * @param array<string, mixed> $args
     */
    public function __invoke(array $root, array $args): \GraphQL\Deferred
    {
        /** @var int $authorId */
        $authorId = $root['author_id'];
        
        return BatchLoaderRegistry::instance(ExternalAuthorBatchLoader::class)
            ->load($authorId);
    }
}
```

## Anti-Patterns & Best Practices

❌ **Anti-Pattern 1: Menggunakan Directive `@all` pada Tabel Besar**
**Salah:** `users: [User!]! @all`
**Bahaya:** Klien bisa melempar kueri ini kapan saja, menyebabkan tabel MySQL berisi 5 juta baris di-load ke dalam RAM server PHP sekaligus. Fatal Out-of-Memory (OOM).
✅ **Benar:** Selalu gunakan `@paginate` dengan argumen `maxCount` yang ditetapkan secara *hardcode* di skema untuk membatasi ukuran halaman (page size).

❌ **Anti-Pattern 2: Membiarkan GraphQL Introspection Menyala di Produksi**
**Salah:** `disable_introspection => false` di server produksi.
**Bahaya:** Penyerang / Hacker bisa menjalankan kueri `__schema` untuk mengunduh cetak biru (blueprint) rahasia seluruh arsitektur database dan model relasi Anda.
✅ **Benar:** Introspection HANYA boleh aktif di environment `local` atau `staging` untuk keperluan pengembangan Front-End.

## Production Edge Cases

1. **Apollo Federation Subgraph Schema Duplication:**
   *Skenario:* Saat merakit microservice Laravel ke dalam Apollo Gateway, ada konflik *Type Naming* (misal: dua service memiliki entitas `User`).
   *Mitigasi:* Gunakan directive `@key(fields: "id")` dan patuhi protokol Federation v2. Lighthouse menyediakan paket eksistensi (extension) Apollo Federation khusus untuk Laravel.

2. **Deadlock pada Circular DataLoaders:**
   *Skenario:* Entity A me-load Entity B (via BatchLoader 1), dan pada resolusi tertentu Entity B me-load Entity A lagi (via BatchLoader 2), saling tunggu hingga timeout memori PHP habis.
   *Mitigasi:* Konfigurasi limitasi kedalaman query di `lighthouse.php` (`max_query_depth`), sehingga skenario sirkular ditolak di gerbang AST parser sebelum menyentuh resolver.

3. **Rate Limiting Gagal Menangani Query Complexity:**
   *Skenario:* Rate limiter berbasis *Request per Second* (RPS) gagal menghentikan DDoS karena attacker cukup mengirim 1 HTTP Request yang mengandung kueri GraphQL seberat 500 Join tabel bersarang (nested).
   *Mitigasi:* Konfigurasikan pengukur bobot khusus (Query Complexity Threshold). Tiap field diberi poin, dan total kueri tidak boleh melebihi 1000 poin.

## Unit / Arch Testing (Pest v3)

```php
<?php

declare(strict_types=1);

use Nuwave\Lighthouse\Testing\MakesGraphQLRequests;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(MakesGraphQLRequests::class, RefreshDatabase::class);

it('blocks queries exceeding maximum allowed depth of 5', function () {
    // 6-levels deep circular relationship
    $query = '
        query {
            users {
                data {
                    posts {
                        data {
                            author {
                                posts {
                                    data {
                                        id
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    ';

    $response = $this->graphQL($query);

    // Expect GraphQL Error related to Query Depth limits
    $response->assertGraphQLErrorMessage('Max query depth should be 5 but got 6.');
});

it('resolves batch loader effectively without http n+1', function () {
    // Arrange HTTP Fake for external microservice call
    \Illuminate\Support\Facades\Http::fake([
        'user-service.internal/batch/authors' => \Illuminate\Support\Facades\Http::response([
            'data' => [
                ['id' => 10, 'name' => 'Alice'],
                ['id' => 11, 'name' => 'Bob'],
            ]
        ], 200)
    ]);
    
    // Simulate loading keys using the batch loader singleton
    $registry = \Nuwave\Lighthouse\Execution\DataLoader\BatchLoaderRegistry::instance(\App\GraphQL\DataLoaders\ExternalAuthorBatchLoader::class);
    
    $deferred1 = $registry->load(10);
    $deferred2 = $registry->load(11);
    
    // Force resolve all queued promises
    \GraphQL\Executor\Promise\Adapter\SyncPromiseAdapter::create()->wait($deferred1);

    \Illuminate\Support\Facades\Http::assertSentCount(1); // Only ONE request was made for both IDs!
});
```
