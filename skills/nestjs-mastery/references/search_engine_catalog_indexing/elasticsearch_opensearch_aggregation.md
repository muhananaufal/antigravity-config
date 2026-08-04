---
title: "Elasticsearch & OpenSearch Aggregation"
description: "Penguasaan Elasticsearch & OpenSearch untuk pencarian logikal rumit, analisis agregasi data e-commerce masa nyata, manajemen indeks via Alias, dan kueri Boolean/Fuzzy di NestJS."
tags: [nestjs, elasticsearch, opensearch, backend, search, aggregation]
---

# Elasticsearch & OpenSearch Aggregation: Pencarian Lanjut dan Analitik E-Commerce di NestJS

Elasticsearch (dan fork OpenSearch) adalah standar emas industri untuk mesin pencarian teks penuh terdistribusi, analitik log, dan pemrosesan kueri kompleks. Dalam skala e-commerce raksasa, Elasticsearch digunakan untuk pencarian fuzzy berbobot dan agregasi (aggregations) berlapis untuk membangun dashboard atau menu filter kompleks (Faceted Search).

## 1. Arsitektur Elasticsearch & Index Aliasing

Zero-Downtime Reindexing dicapai dengan pola "Index Aliasing". Aplikasi hanya membaca dari *Alias*, sementara proses sinkronisasi membangun indeks baru secara diam-diam (Blue-Green Deployment untuk data).

```ascii
+--------------------+
| NestJS Application | (Reads/Writes to Alias)
+--------------------+
          |
          v
   [Alias: products]
          |
   +------+------+
   |             | (Switch Pointer during Reindex)
   v             v
[Index:      [Index:
 prod_v1]     prod_v2]
 (Old)        (New/Syncing)
```

## 2. Implementasi NestJS (TypeScript 5+ & NestJS 10+)

### OpenSearch / Elasticsearch Service Implementation

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';

export interface ProductESDocument {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  tags: string[];
  attributes: Record<string, string>;
  createdAt: string;
}

export interface AdvancedSearchFilters {
  query: string;
  category?: string;
  priceRange?: { min: number; max: number };
  tags?: string[];
  page: number;
  size: number;
}

@Injectable()
export class ElasticSearchService implements OnModuleInit {
  private readonly logger = new Logger(ElasticSearchService.name);
  private readonly client: Client;
  private readonly aliasName = 'products_alias';

  constructor(private readonly configService: ConfigService) {
    this.client = new Client({
      node: this.configService.getOrThrow<string>('ELASTICSEARCH_NODE'),
      auth: {
        username: this.configService.getOrThrow<string>('ELASTICSEARCH_USER'),
        password: this.configService.getOrThrow<string>('ELASTICSEARCH_PASS'),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.setupAliasIfNotExists();
  }

  private async setupAliasIfNotExists(): Promise<void> {
    try {
      const aliasExists = await this.client.indices.existsAlias({ name: this.aliasName });
      if (!aliasExists) {
        const initialIndex = `products_v1_${Date.now()}`;
        await this.createIndexWithMapping(initialIndex);
        await this.client.indices.putAlias({ index: initialIndex, name: this.aliasName });
        this.logger.log(`Created initial index ${initialIndex} and aliased to ${this.aliasName}`);
      }
    } catch (error: unknown) {
      this.logger.error('Failed to setup Elasticsearch alias', error);
      throw error;
    }
  }

  private async createIndexWithMapping(indexName: string): Promise<void> {
    await this.client.indices.create({
      index: indexName,
      body: {
        settings: {
          analysis: {
            analyzer: {
              custom_ecommerce_analyzer: {
                type: 'custom',
                tokenizer: 'standard',
                filter: ['lowercase', 'asciifolding', 'snowball'],
              },
            },
          },
        },
        mappings: {
          properties: {
            id: { type: 'keyword' },
            name: { type: 'text', analyzer: 'custom_ecommerce_analyzer', fields: { keyword: { type: 'keyword' } } },
            description: { type: 'text', analyzer: 'english' },
            category: { type: 'keyword' },
            price: { type: 'double' },
            tags: { type: 'keyword' },
            createdAt: { type: 'date' },
            attributes: { type: 'object' },
          },
        },
      },
    });
  }

  async advancedSearch(filters: AdvancedSearchFilters) {
    const mustQueries: any[] = [];
    const filterQueries: any[] = [];

    // Fuzzy Search pada Nama dan Deskripsi
    if (filters.query) {
      mustQueries.push({
        multi_match: {
          query: filters.query,
          fields: ['name^3', 'description'], // name 3x lebih penting
          fuzziness: 'AUTO',
        },
      });
    }

    // Exact Match dan Range Filters
    if (filters.category) {
      filterQueries.push({ term: { category: filters.category } });
    }
    if (filters.tags && filters.tags.length > 0) {
      filterQueries.push({ terms: { tags: filters.tags } });
    }
    if (filters.priceRange) {
      filterQueries.push({
        range: {
          price: {
            gte: filters.priceRange.min,
            lte: filters.priceRange.max,
          },
        },
      });
    }

    try {
      const response = await this.client.search({
        index: this.aliasName,
        from: (filters.page - 1) * filters.size,
        size: filters.size,
        body: {
          query: {
            bool: {
              must: mustQueries,
              filter: filterQueries,
            },
          },
          aggs: {
            categories: {
              terms: { field: 'category', size: 50 },
            },
            price_stats: {
              stats: { field: 'price' },
            },
            price_ranges: {
              range: {
                field: 'price',
                ranges: [
                  { to: 100 },
                  { from: 100, to: 500 },
                  { from: 500 },
                ],
              },
            },
          },
        },
      });

      return {
        total: (response.hits.total as any).value,
        data: response.hits.hits.map((hit) => ({ id: hit._id, ...hit._source as ProductESDocument })),
        aggregations: response.aggregations,
      };
    } catch (error: unknown) {
      this.logger.error('Elasticsearch search failed', error);
      throw error;
    }
  }
}
```

## 3. Unit / Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ElasticSearchService, AdvancedSearchFilters } from './elastic-search.service';

const mockSearchFn = jest.fn();
jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    indices: {
      existsAlias: jest.fn().mockResolvedValue(true),
      create: jest.fn(),
      putAlias: jest.fn(),
    },
    search: mockSearchFn,
  })),
}));

describe('ElasticSearchService', () => {
  let service: ElasticSearchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ElasticSearchService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-val'),
          },
        },
      ],
    }).compile();

    service = module.get<ElasticSearchService>(ElasticSearchService);
    mockSearchFn.mockClear();
  });

  it('should build proper boolean query and aggregation', async () => {
    mockSearchFn.mockResolvedValue({
      hits: { total: { value: 1 }, hits: [{ _id: '1', _source: { name: 'Test' } }] },
      aggregations: { price_stats: { min: 10, max: 20 } },
    });

    const params: AdvancedSearchFilters = {
      query: 'laptop',
      category: 'electronics',
      priceRange: { min: 1000, max: 2000 },
      page: 1,
      size: 10,
    };

    const result = await service.advancedSearch(params);
    expect(mockSearchFn).toHaveBeenCalledWith(expect.objectContaining({
      index: 'products_alias',
      body: expect.objectContaining({
        query: {
          bool: {
            must: expect.arrayContaining([{ multi_match: expect.any(Object) }]),
            filter: expect.arrayContaining([
              { term: { category: 'electronics' } },
              { range: { price: { gte: 1000, lte: 2000 } } },
            ]),
          },
        },
        aggs: expect.any(Object),
      }),
    }));
    expect(result.data).toHaveLength(1);
  });
});
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Pencarian Teks Kompleks:** Kemampuan kustomisasi Analyzer, Tokenizer, dan filter bahasa yang tak tertandingi (seperti Snowball stemmer, ngram).
2. **Aggregations Kuat:** Mampu melakukan komputasi statistik (min, max, rata-rata, bucket) secara instan di atas miliaran dokumen.
3. **Skalabilitas Horizontal & HA:** Desain terdistribusi (Sharding & Replication) sangat tangguh dan bisa diskalakan ke petabytes data.

### Kekurangan
1. **Kurva Belajar Curam:** Query DSL (Domain Specific Language) sangat verbose dan kompleks untuk dipelajari.
2. **Resource Hungry:** JVM memerlukan heap memory yang sangat besar untuk menghindari Garbage Collection pause (Out of Memory).
3. **Manajemen Infrastruktur:** Maintenance cluster mandiri sangat merepotkan (Split Brain, Yellow/Red Status), seringkali butuh solusi managed mahal (Elastic Cloud).

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Pagination Lebar Menggunakan `from` & `size` ❌
Mencoba melompati (skip) offset besar misal halaman ke-10,000. Ini disebut *Deep Paging* dan akan menghancurkan heap memory karena ES harus menyortir semua data sebelumnya.
```typescript
// ❌ SALAH: Deep Paging
client.search({ from: 100000, size: 10, query: {...} });
```
**✅ Solusi Benar:** Gunakan mekanisme `search_after` (Cursor-based pagination) atau batasi maksimum offset (misal 10,000) dan paksa user memfilter kueri lebih ketat.

### Anti-Pattern 2: Pembaruan Sebagian (Partial Update) Masif ❌
Sering mengupdate satu field berulang kali (misal "view count") menggunakan update API. Elasticsearch bukanlah database relasional (setiap update adalah index ulang dokumen).
**✅ Solusi Benar:** Simpan metrik berkecepatan tinggi (view/likes) di Redis, lalu gabungkan datanya (enrichment) hanya pada saat agregasi analitik batch harian.

## 6. Production Edge Cases

1. **Mapping Explosion:** Memasukkan objek JSON dinamis sembarangan (seperti arbitrary attributes) dengan tipe dinamis (Dynamic Mapping). Ini bisa menembus batas maksimal fields per index. Terapkan `dynamic: 'strict'` di mapping, atau gunakan tipe data `flattened` untuk payload tak terstruktur.
2. **Reindexing Downtime:** Melakukan reindexing indeks raksasa saat jam sibuk. Wajib gunakan Alias dan *Reindex API* secara background, baru pindahkan pointer alias ketika selesai.
3. **Peningkatan GCG (Garbage Collection):** Jika aggregasi menggunakan heap berlebih karena memori yang difragmentasi (misal terlalu banyak cardinality pada field text), JVM bisa membeku (Stop The World). Pastikan field yang diagregasi adalah `keyword`, dan optimasi setelan `index.store.type: mmapfs` serta heap RAM yang sesuai.
