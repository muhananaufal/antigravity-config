---
title: "MeiliSearch Faceted Catalog Engine"
description: "Rancang bangun mesin pencarian katalog E-Commerce ultra-cepat milidetik menggunakan MeiliSearch: konfigurasi Faceted Navigation, Typo-Tolerance, sorting, ranking rules, dan indexing secara batch ter Sinkronisasi."
tags: [nestjs, meilisearch, search-engine, typescript, backend]
---

# MeiliSearch Faceted Catalog Engine: Ultra-Fast E-Commerce Search di NestJS

Dalam pengembangan sistem e-commerce skala besar, kecepatan pencarian dan relevansi hasil adalah metrik kritis yang memengaruhi konversi. MeiliSearch hadir sebagai solusi pencarian in-memory/disk hybrid dengan fokus pada *typo-tolerance* out-of-the-box dan waktu respons sub-50ms. Dokumen ini membahas implementasi MeiliSearch untuk katalog produk dengan *faceted navigation*, *sorting*, dan sinkronisasi batch.

## 1. Arsitektur Faceted Catalog

```ascii
+--------------------+        +---------------------+       +-----------------------+
|   Client / Web     |        |   NestJS API (BFF)  |       |   MeiliSearch Engine  |
|--------------------|        |---------------------|       |-----------------------|
| - Search Input     | -----> | POST /search        | ----> | Index: `products`     |
| - Filters (Facets) |        | - Sanitize Input    |       | - Typo Tolerance      |
| - Sort Options     | <----- | - Map Response      | <---- | - Ranking Rules       |
+--------------------+        +---------------------+       +-----------------------+
                                        |                             ^
                                        | (Sync on Write)             |
                                        v                             |
                              +---------------------+                 |
                              | Postgres DB         | ----------------+
                              | (Source of Truth)   | (Asynchronous Batch Sync via Queue / CDC)
                              +---------------------+
```

## 2. Implementasi NestJS (TypeScript 5+ & NestJS 10+)

### MeiliSearch Service Implementation

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch, Index, SearchResponse } from 'meilisearch';

export interface ProductDocument {
  id: string;
  name: string;
  description: string;
  price: number;
  categories: string[];
  brand: string;
  rating: number;
  inStock: boolean;
  createdAt: string;
}

export interface SearchQueryParams {
  query: string;
  categories?: string[];
  brands?: string[];
  minPrice?: number;
  maxPrice?: number;
  sortBy?: 'price:asc' | 'price:desc' | 'rating:desc';
  page: number;
  limit: number;
}

@Injectable()
export class ProductSearchService implements OnModuleInit {
  private readonly logger = new Logger(ProductSearchService.name);
  private client: MeiliSearch;
  private readonly indexName = 'products';

  constructor(private readonly configService: ConfigService) {
    this.client = new MeiliSearch({
      host: this.configService.getOrThrow<string>('MEILISEARCH_HOST'),
      apiKey: this.configService.getOrThrow<string>('MEILISEARCH_API_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.initializeIndex();
  }

  private async initializeIndex(): Promise<void> {
    try {
      await this.client.createIndex(this.indexName, { primaryKey: 'id' });
      const index: Index<ProductDocument> = this.client.index(this.indexName);

      // Konfigurasi Search Settings
      await index.updateSettings({
        searchableAttributes: ['name', 'description', 'brand'],
        filterableAttributes: ['categories', 'brand', 'price', 'rating', 'inStock'],
        sortableAttributes: ['price', 'rating', 'createdAt'],
        rankingRules: [
          'words',
          'typo',
          'proximity',
          'attribute',
          'sort',
          'exactness',
        ],
        faceting: {
          maxValuesPerFacet: 100,
        },
        typoTolerance: {
          enabled: true,
          minWordSizeForTypos: {
            oneTypo: 4,
            twoTypos: 8,
          },
          disableOnWords: [],
          disableOnAttributes: ['brand'],
        }
      });
      this.logger.log('MeiliSearch index settings updated successfully.');
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('already exists')) {
        this.logger.debug('MeiliSearch index already exists.');
      } else {
        this.logger.error('Failed to initialize MeiliSearch index', error);
        throw error;
      }
    }
  }

  async searchProducts(params: SearchQueryParams): Promise<SearchResponse<ProductDocument>> {
    const index: Index<ProductDocument> = this.client.index(this.indexName);
    
    const filters: string[] = [];
    if (params.categories && params.categories.length > 0) {
      filters.push(`categories IN [${params.categories.map(c => `"${c}"`).join(', ')}]`);
    }
    if (params.brands && params.brands.length > 0) {
      filters.push(`brand IN [${params.brands.map(b => `"${b}"`).join(', ')}]`);
    }
    if (params.minPrice !== undefined) {
      filters.push(`price >= ${params.minPrice}`);
    }
    if (params.maxPrice !== undefined) {
      filters.push(`price <= ${params.maxPrice}`);
    }

    const sortOpt: string[] = params.sortBy ? [params.sortBy] : [];

    return index.search(params.query, {
      filter: filters,
      sort: sortOpt,
      facets: ['categories', 'brand'],
      hitsPerPage: params.limit,
      page: params.page,
    });
  }

  async syncBatch(documents: ProductDocument[]): Promise<void> {
    try {
      const index: Index<ProductDocument> = this.client.index(this.indexName);
      const response = await index.addDocuments(documents);
      this.logger.log(`Queued batch sync task: ${response.taskUid}`);
    } catch (error: unknown) {
      this.logger.error('Failed to sync batch to MeiliSearch', error);
      throw error;
    }
  }
}
```

## 3. Unit / Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProductSearchService, SearchQueryParams, ProductDocument } from './product-search.service';

// Mocking MeiliSearch class
jest.mock('meilisearch', () => {
  return {
    MeiliSearch: jest.fn().mockImplementation(() => {
      return {
        createIndex: jest.fn(),
        index: jest.fn().mockReturnValue({
          updateSettings: jest.fn().mockResolvedValue({ taskUid: 1 }),
          search: jest.fn().mockResolvedValue({
            hits: [{ id: '1', name: 'Test Product', price: 100 }],
            estimatedTotalHits: 1,
            processingTimeMs: 1,
            query: 'Test',
            facetDistribution: {}
          }),
          addDocuments: jest.fn().mockResolvedValue({ taskUid: 2 })
        })
      };
    })
  };
});

describe('ProductSearchService', () => {
  let service: ProductSearchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductSearchService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-value'),
          },
        },
      ],
    }).compile();

    service = module.get<ProductSearchService>(ProductSearchService);
  });

  it('should format filters correctly and execute search', async () => {
    const params: SearchQueryParams = {
      query: 'phone',
      categories: ['electronics'],
      minPrice: 500,
      limit: 10,
      page: 1
    };

    const result = await service.searchProducts(params);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('1');
  });

  it('should batch sync documents', async () => {
    const docs: ProductDocument[] = [
      { id: '2', name: 'Sync Prod', description: 'Desc', price: 50, categories: [], brand: 'A', rating: 5, inStock: true, createdAt: new Date().toISOString() }
    ];
    await expect(service.syncBatch(docs)).resolves.toBeUndefined();
  });
});
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Developer Experience:** Konfigurasi `typo-tolerance` dan `rankingRules` sangat intuitif dan out-of-the-box dibandingkan ElasticSearch yang membutuhkan mapping kompleks.
2. **Performa:** Sangat cepat untuk dataset < 10 juta dokumen karena optimasi arsitektur Rust dan penggunaan memory-mapped files.
3. **Faceted Search Native:** API bawaan untuk agregasi kategori (facets) sangat mudah digunakan oleh frontend tanpa query DSL rumit.

### Kekurangan
1. **Vertical Scaling Limit:** Tidak mendukung native clustering/sharding layaknya Elasticsearch, sehingga tidak cocok untuk dataset ratusan juta dokumen (skala Big Data).
2. **RAM Heavy:** Karena menggunakan struktur index memory-mapped, performa akan drop signifikan jika ukuran index melebihi kapasitas RAM server.
3. **Advanced Analytics Terbatas:** Tidak memiliki kapabilitas agregasi data yang kompleks (seperti time-series analysis) layaknya Elasticsearch/OpenSearch.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Sinkronisasi Sinkron Saat Checkout ❌
Mengupdate index MeiliSearch secara blocking setiap kali stok berubah di database utama.
```typescript
// ❌ SALAH: Blocking thread
async updateProductStock(id: string, qty: number) {
  await this.db.update(id, qty);
  // Blocking API call ke search engine
  await this.meiliSearch.index('products').updateDocuments([{ id, inStock: qty > 0 }]);
}
```

**✅ Solusi Benar:** Gunakan Message Queue (RabbitMQ) atau CDC (Debezium) untuk update index secara asinkron (Event-Driven).

### Anti-Pattern 2: Tidak Menggunakan Limit/Pagination ❌
Mengizinkan user meminta data dengan `hitsPerPage` terlalu tinggi (misal 10,000) yang membebani CPU MeiliSearch dan network egress.
```typescript
// ❌ SALAH: Limit dikontrol bebas oleh client
return index.search(query, { hitsPerPage: req.query.limit || 999999 });
```

**✅ Solusi Benar:** Selalu berikan validasi/clamp nilai maksimum (misal max 100) dan wajibkan paginasi.

## 6. Production Edge Cases

1. **Stale Data saat Spike Traffic:** Saat 11.11, antrean sinkronisasi (sync queue) bisa tertinggal. Sistem harus memiliki *fallback* mengecek ketersediaan (in-stock) ke redis/DB asional sebelum checkout akhir.
2. **Cold Start & Index Rebuilding:** Rebuilding index secara massal dari Postgres dapat mengunci (lock) performa pencarian. Gunakan strategi *Blue/Green Indexing* (buat indeks sementara `products_new`, swap alias).
3. **Payload Besar pada Facet Distribution:** Untuk produk dengan kategori yang sangat dalam dan luas, mengembalikan semua facet bisa membengkak respon JSON. Konfigurasikan `maxValuesPerFacet` di pengaturan MeiliSearch untuk melimitasi elemen berlebih.
