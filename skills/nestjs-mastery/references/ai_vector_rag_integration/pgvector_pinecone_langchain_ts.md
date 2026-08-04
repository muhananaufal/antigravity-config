# Integrasi AI Vector Database (pgvector & Pinecone) dengan LangChain TypeScript untuk RAG

## 1. Pendahuluan
Dalam era Generative AI, Retrieval-Augmented Generation (RAG) menjadi standar arsitektur untuk menyuntikkan konteks eksternal spesifik domain ke dalam prompt Large Language Models (LLM). Dokumen ini menguraikan best practices arsitektural 1% teratas dalam mengintegrasikan ekosistem Vector Database — secara spesifik menggunakan kapabilitas HNSW (Hierarchical Navigable Small World) dari ekstensi PostgreSQL `pgvector` maupun managed service terdistribusi seperti Pinecone — bersanding dengan abstraksi LangChain dalam ekosistem NestJS dan TypeScript 5+.

Pencarian kemiripan kosinus (Cosine Similarity) pada indeks HNSW menawarkan kinerja kueri sub-milidetik bahkan pada himpunan data berjumlah jutaan vektor, krusial bagi aplikasi interaktif RAG berskala enterprise.

## 2. Arsitektur Vektor HNSW & Pipeline RAG

```ascii
+-------------------+       +-----------------------+       +------------------------+
| User Query (Text) | ----> | Embedding Model (API) | ----> | Query Vector (Float[]) |
+-------------------+       +-----------+-----------+       +-----------+------------+
                                        |                               |
                                        v                               v
+-------------------+       +-----------------------+       +------------------------+
|   Response LLM    | <---- | Prompt Construction   | <---- | Vector Search Engine   |
|   (Streaming)     |       | (System + Context)    |       | (pgvector / Pinecone)  |
+-------------------+       +-----------------------+       +------------------------+
                                                                        ^
                                                                        | Cosine
                                                                        | Similarity
                                                            +------------------------+
                                                            | Indexed Vector Store   |
                                                            | (HNSW Graph Structure) |
                                                            +------------------------+
```

## 3. Implementasi Produksi NestJS

Kode berikut menunjukkan modul layanan hibrida yang mendukung `pgvector` dan Pinecone dengan pengetikan ketat dan tanpa tipe `any`.

### `vector-store.module.ts`
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VectorStoreService } from './vector-store.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([DocumentEntity])
  ],
  providers: [VectorStoreService],
  exports: [VectorStoreService],
})
export class VectorStoreModule {}
```

### `entities/document.entity.ts`
```typescript
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('documents_vector')
export class DocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, string | number | boolean>;

  // Membutuhkan ekstensi pgvector: CREATE EXTENSION IF NOT EXISTS vector;
  // Index HNSW untuk pencarian kosinus berkecepatan tinggi
  @Column({
    type: 'vector',
    length: 1536, // Dimensi standar OpenAI text-embedding-3-small
  })
  @Index('hnsw_idx_document_embedding', {
    synchronize: false, // Dikelola secara manual melalui migrasi karena parameter spesifik HNSW
  })
  embedding: number[];
}
```

### `vector-store.service.ts`
```typescript
import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { PoolConfig } from 'pg';
import { Document } from '@langchain/core/documents';

export interface SearchResult {
  content: string;
  metadata: Record<string, string | number | boolean>;
  score: number;
}

@Injectable()
export class VectorStoreService implements OnModuleInit {
  private readonly logger = new Logger(VectorStoreService.name);
  private readonly embeddingsModel: OpenAIEmbeddings;
  private pineconeStore: PineconeStore;
  private pgVectorStore: PGVectorStore;

  constructor(private readonly configService: ConfigService) {
    const openAIApiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!openAIApiKey) {
      throw new InternalServerErrorException('OPENAI_API_KEY environment variable is missing.');
    }

    this.embeddingsModel = new OpenAIEmbeddings({
      openAIApiKey,
      modelName: 'text-embedding-3-small',
      batchSize: 512,
    });
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.initializePineconeStore(),
      this.initializePGVectorStore()
    ]);
  }

  private async initializePineconeStore(): Promise<void> {
    try {
      const pineconeApiKey = this.configService.get<string>('PINECONE_API_KEY');
      const pineconeIndexName = this.configService.get<string>('PINECONE_INDEX_NAME');

      if (!pineconeApiKey || !pineconeIndexName) {
        this.logger.warn('Pinecone credentials missing. Pinecone store will be disabled.');
        return;
      }

      const pineconeClient = new Pinecone({ apiKey: pineconeApiKey });
      const pineconeIndex = pineconeClient.Index(pineconeIndexName);

      this.pineconeStore = await PineconeStore.fromExistingIndex(this.embeddingsModel, {
        pineconeIndex,
        maxConcurrency: 5, // Batas koneksi paralel
      });
      this.logger.log('Pinecone Vector Store initialized.');
    } catch (error) {
      this.logger.error(`Failed to initialize Pinecone Store: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async initializePGVectorStore(): Promise<void> {
    try {
      const dbUrl = this.configService.get<string>('DATABASE_URL');
      if (!dbUrl) {
        this.logger.warn('DATABASE_URL missing. pgvector store will be disabled.');
        return;
      }

      const config: PoolConfig = {
        connectionString: dbUrl,
        max: 20, // Connection pool size
      };

      this.pgVectorStore = await PGVectorStore.initialize(this.embeddingsModel, {
        postgresConnectionOptions: config,
        tableName: 'documents_vector',
        columns: {
          idColumnName: 'id',
          vectorColumnName: 'embedding',
          contentColumnName: 'content',
          metadataColumnName: 'metadata',
        },
        // Menggunakan Cosine Distance (<=>) untuk HNSW index
        distanceStrategy: 'cosine' 
      });
      this.logger.log('PGVector Store initialized.');
    } catch (error) {
      this.logger.error(`Failed to initialize pgvector Store: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  public async similaritySearch(
    query: string, 
    topK: number = 5, 
    storeType: 'pinecone' | 'pgvector' = 'pgvector'
  ): Promise<SearchResult[]> {
    try {
      const store = storeType === 'pinecone' ? this.pineconeStore : this.pgVectorStore;
      if (!store) {
        throw new InternalServerErrorException(`Store ${storeType} is not initialized.`);
      }

      // Melakukan pencarian menggunakan LangChain dengan pengembalian skor kosinus
      const results: [Document, number][] = await store.similaritySearchWithScore(query, topK);

      return results.map(([doc, score]) => ({
        content: doc.pageContent,
        metadata: doc.metadata as Record<string, string | number | boolean>,
        score,
      }));
    } catch (error) {
      this.logger.error(`Similarity search failed in ${storeType}: ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to perform similarity search.');
    }
  }

  public async addDocuments(
    documents: { content: string; metadata: Record<string, string | number | boolean> }[],
    storeType: 'pinecone' | 'pgvector' = 'pgvector'
  ): Promise<void> {
    const store = storeType === 'pinecone' ? this.pineconeStore : this.pgVectorStore;
    if (!store) {
      throw new InternalServerErrorException(`Store ${storeType} is not initialized.`);
    }

    const langchainDocs = documents.map(doc => new Document({
      pageContent: doc.content,
      metadata: doc.metadata,
    }));

    await store.addDocuments(langchainDocs);
  }
}
```

## 4. Analisis Trade-off

**Kelebihan:**
1. **Performa HNSW:** Menggunakan indeks HNSW (Hierarchical Navigable Small World) yang sangat dioptimalkan memberikan pencarian latensi sub-milidetik (biasanya < 10ms) bahkan untuk kueri terhadap jutaan vektor.
2. **Fleksibilitas Arsitektur Hybrid:** Membungkus Pinecone dan `pgvector` dalam satu antarmuka abstrak memungkinkan tim men-switch backend penyedia cloud-native ke database in-house (PostgreSQL) kapan saja tanpa refactoring besar-besaran, mencegah vendor lock-in.
3. **Ekosistem Abstraksi Tinggi (LangChain):** Penggunaan LangChain Document abstractions menghemat ratusan baris boilerplate yang dibutuhkan untuk orkestrasi panggilan Embeddings API (seperti penanganan batch array untuk payload OpenAI), serta parser konsisten untuk query hasil similarity dan raw string mapping.

**Kekurangan:**
1. **Overhead Infrastruktur Memori HNSW:** Ekstensi `pgvector` dengan indeks HNSW sangat rakus memori RAM (RAM-intensive). Berbeda dengan indeks IVFFlat, graf multi-lapisan HNSW harus dimuat penuh dalam memory PostgreSQL cache (`shared_buffers`) agar menjamin pencarian performa tinggi.
2. **Cold Start Re-Indexing HNSW:** Pembuatan indeks di Postgres `pgvector` memblokir I/O secara intensif. Pembaruan indeks graf (inserts skala masif) dapat menurunkan kinerja database transaksional konvensional (OLTP) jika disatukan ke dalam satu klaster server.
3. **Kompleksitas Sinkronisasi Metadata:** Struktur metadata agregat noSQL (JSONB pada Postgres vs Map di Pinecone) menuntut validasi skema tipe yang ketat karena LangChain seringkali secara sepihak mem-parsing semuanya menjadi tipe literal primitif saat diserialisasi.

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Mengabaikan Indeks Vektor dan Melakukan Full-Scan L2 Distance (Kinerja O(N))
Banyak pemula mendefinisikan kolom vektor di TypeORM tetapi gagal menyediakan indeks `HNSW` atau `IVFFlat`, sehingga Postgres terpaksa melakukan pencarian brute-force berurutan dengan penghitungan skor *Euclidean (L2)* per baris.

```typescript
// ❌ CONTOH SALAH: TypeORM Entity tanpa indeks HNSW (Menyebabkan Table Scan O(N))
@Entity('documents_vector')
export class BadDocumentEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'vector', length: 1536 }) embedding: number[];
  // Fatal: Tanpa Index HNSW/IVFFlat, query similarity memakan waktu >10 detik untuk sejuta row!
}
```

**Solusi ✅:** Terapkan indeks HNSW secara eksplisit dengan metode indeks vektor (misalnya menggunakan fungsi `<=>` untuk kosinus `vector_cosine_ops`) menggunakan Migration builder murni pada SQL, atau TypeORM custom Index configuration yang sesuai.

### ❌ Anti-Pattern 2: Hardcoding Rate Limit dan Batch Size untuk Embeddings API
Mengirim data jutaan entri string untuk diekstraksi ke API OpenAI/Cohere secara berulang dengan pemanggilan for-loop asinkronus reguler.

```typescript
// ❌ CONTOH SALAH: For-loop iterasi Embeddings yang memblokir I/O dan memicu Rate Limit HTTP 429
for (const chunk of massiveDocuments) {
  const emb = await openai.embeddings.create({ input: chunk.text, model: 'text-embedding-ada-002' }); // Memicu bottleneck dan blokir API!
  await saveVector(emb);
}
```

**Solusi ✅:** Memanfaatkan delegator batching dari abstraksi `OpenAIEmbeddings` atau membuat rate-limiter khusus. Inilah mengapa kita menyetel `batchSize: 512` di awal implementasi layanan dan bergantung pada antrean latensi LangChain.

## 6. Kasus Uji Unit & Mock AI Vector

### `vector-store.service.spec.ts`
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { VectorStoreService } from './vector-store.service';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { PineconeStore } from '@langchain/pinecone';

// Mock dependensi eksternal
jest.mock('@langchain/openai');
jest.mock('@langchain/pinecone');
jest.mock('@langchain/community/vectorstores/pgvector');
jest.mock('@pinecone-database/pinecone');

describe('VectorStoreService', () => {
  let service: VectorStoreService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorStoreService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-openai-key';
              if (key === 'PINECONE_API_KEY') return 'test-pinecone-key';
              if (key === 'PINECONE_INDEX_NAME') return 'test-index';
              if (key === 'DATABASE_URL') return 'postgres://test:test@localhost:5432/test';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<VectorStoreService>(VectorStoreService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should throw exception if OPENAI_API_KEY is missing', () => {
      jest.spyOn(configService, 'get').mockReturnValueOnce(null);
      expect(() => new VectorStoreService(configService)).toThrow(InternalServerErrorException);
    });

    it('should initialize successfully when credentials are valid', async () => {
      // Mock implementasi PineconeStore dari kelas Langchain
      (PineconeStore.fromExistingIndex as jest.Mock).mockResolvedValue({});
      
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('similaritySearch', () => {
    it('should execute similarity search and return mapped SearchResult objects', async () => {
      await service.onModuleInit();
      
      // Inject mock data ke internal pinecone store mock
      const mockResults = [
        [{ pageContent: 'NestJS HNSW', metadata: { source: 'docs' } }, 0.95],
        [{ pageContent: 'TypeORM Vector', metadata: { source: 'blog' } }, 0.88]
      ];
      
      const mockPineconeStore = {
        similaritySearchWithScore: jest.fn().mockResolvedValue(mockResults)
      };
      
      // Akses private field melalui any (khusus testing) atau spy getter
      (service as any).pineconeStore = mockPineconeStore;

      const results = await service.similaritySearch('query test', 2, 'pinecone');

      expect(mockPineconeStore.similaritySearchWithScore).toHaveBeenCalledWith('query test', 2);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        content: 'NestJS HNSW',
        metadata: { source: 'docs' },
        score: 0.95
      });
    });
  });
});
```

## 7. Production Edge Cases

1. **Jaringan Timeout & Transient Failures di Pinecone API:** Jaringan latensi tinggi antara region server AWS EC2 internal dan region Pinecone menyebabkan terputusnya pipeline similarity saat fase `similaritySearchWithScore`. Harus menggunakan strategi eksponensial Back-off & Retry, yang sebagian bisa diimplementasikan melalui interseptor kustom Axios atau retry logic dari SDK Pinecone.
2. **Vektor Dimensi Mismatch Exception (1536 vs 3072):** Upgrade model embedding di environment staging (misalnya dari `text-embedding-ada-002` ke `text-embedding-3-large` yang berdimensi `3072`) menyebabkan Postgres memunculkan exception `vector dimensions mismatch` saat `INSERT`. Strategi mitigasi: Wajib mengkarantina embedding baru ke tabel/kolom migrasi spesifik (contoh tabel: `documents_vector_v2_3072`) ketimbang mengubah dimensi tabel eksisting secara in-place.
3. **Maksimum Token Context Size Overflow untuk HNSW Query (PGVector Index Bloat):** Volume data yang sangat tinggi (jutaan DML per minggu di PGVector) menciptakan "Index Bloat", di mana graf navigasi menjadi terfragmentasi sehingga menghabiskan memori RAM hingga memicu `OOM (Out Of Memory) Killer` dari kernel Linux. Proses rekonsiliasi berkala dengan `REINDEX INDEX CONCURRENTLY hnsw_idx_document_embedding` mutlak dijadwalkan via cron job pada jam non-sibuk.
