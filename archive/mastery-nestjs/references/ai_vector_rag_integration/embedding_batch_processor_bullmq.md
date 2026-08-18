# Prosesor Batch Embedding Teks Berskala Gigabyte dengan BullMQ

## 1. Pendahuluan
Ekstraksi ribuan dokumen enterprise PDF/Word (berkisar dari ratusan Megabyte hingga Gigabyte data teks kotor) ke dalam representasi Vektor Embeddings menuntut abstraksi konkurensi yang tidak akan membuat memori Node.js NestJS *crash* (OOM). Terlebih lagi, setiap provider API (seperti OpenAI `text-embedding-models`, HuggingFace, atau Cohere) mendikte batas Kuota Tarif Batas Keras (Rate Limit HTTP 429 - *Tokens Per Minute/Requests Per Minute*). 

Penggunaan **BullMQ** (berbasis Redis) dalam ekosistem NestJS tidak hanya menstabilkan I/O *Background Job*, melainkan menyediakan mekanisme throttling algoritmik (Token Bucket) bawaan dan mekanisme Retry backoff logaritmik, menjadikannya arsitektur "Top 1%" standar industri untuk batch embedding processing massal.

## 2. Topologi Prosesor Batch (Token Bucket Throttling)

```ascii
+--------------------+        +---------------------+        +-----------------------------+
| Uploaded Documents |        | Text Splitter Chunk |        | BullMQ Queue (Redis backed) |
| (Gigabyte Scale)   | -----> | (LangChain)         | -----> |   [Chunk1, Chunk2, ... ]    |
+--------------------+        +---------------------+        +--------------+--------------+
                                                                            |
   Rate Limit Enforced! (e.g. Max 3000 Tokens/Min)                          |
+---------------------------------------------------------------------------+
|                                                                           v
|  +-----------------------+     +-----------------------+     +------------+----------+
|  | Node Worker 1 (Nest)  |     | Node Worker 2 (Nest)  |     | API Token Bucket (429)|
|  | - Langchain Embedding |     | - Langchain Embedding | <-> | Limit Throttle Check  |
|  +-----------+-----------+     +-----------+-----------+     +-----------------------+
|              |                             |
+--------------|-----------------------------|-------------------------------------------+
               v                             v
   +---------------------------------------------------------+
   |   Vector Database (pgvector / Pinecone) Storage Sync    |
   +---------------------------------------------------------+
```

## 3. Implementasi Produksi NestJS & BullMQ

Modul menggunakan injeksi `@nestjs/bullmq` asli dengan deklarasi Worker & Queue yang mengisolasi proses pembuatan vektor embedding.

### `embedding-processor.module.ts`
```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmbeddingProducerService } from './embedding-producer.service';
import { EmbeddingWorker } from './embedding.worker';
import { VectorStoreModule } from '../vector-store/vector-store.module';

@Module({
  imports: [
    ConfigModule,
    VectorStoreModule, // Modul yang menghubungkan ke HNSW DB
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
          password: configService.get('REDIS_PASSWORD'),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'embeddings-batch-queue',
      // Mengonfigurasi rate limiting Redis-level untuk Queue ini.
      // Misal: hanya diizinkan maksimal 50 Jobs per 1 menit (60000ms)
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      }
    }),
  ],
  providers: [EmbeddingProducerService, EmbeddingWorker],
  exports: [EmbeddingProducerService],
})
export class EmbeddingProcessorModule {}
```

### `embedding-producer.service.ts`
Producer ini bertugas memecah teks massal (chunking) dan memasukkannya ke Message Queue Redis.
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

export interface EmbeddingJobData {
  documentId: string;
  chunkIndex: number;
  textContext: string;
  metadata: Record<string, any>;
}

@Injectable()
export class EmbeddingProducerService {
  private readonly logger = new Logger(EmbeddingProducerService.name);

  constructor(
    @InjectQueue('embeddings-batch-queue') private readonly batchQueue: Queue<EmbeddingJobData>
  ) {}

  public async chunkAndDispatch(documentId: string, massiveText: string, baseMetadata: Record<string, any>): Promise<void> {
    this.logger.log(`Chunking massive document ID: ${documentId}`);

    // Menggunakan pemecah dokumen secara semantik untuk tidak memotong kalimat di tengah
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });

    const docChunks = await splitter.createDocuments([massiveText]);

    const jobs = docChunks.map((chunk, index) => {
      return {
        name: `embed-doc-${documentId}-chunk-${index}`,
        data: {
          documentId,
          chunkIndex: index,
          textContext: chunk.pageContent,
          metadata: { ...baseMetadata, chunkIndex: index, docId: documentId },
        } as EmbeddingJobData,
      };
    });

    // Bulk Add ke dalam Redis Queue untuk menghindari kelebihan overhead round-trip network
    await this.batchQueue.addBulk(jobs);
    
    this.logger.log(`Dispatched ${jobs.length} jobs to BullMQ for document ${documentId}`);
  }
}
```

### `embedding.worker.ts`
Worker Processor berjalan di latar belakang secara otonom, menarik data dari Redis, menggunakan LangChain Embedding Model, lalu menyimpannya ke `pgvector`.
```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmbeddingJobData } from './embedding-producer.service';
import { OpenAIEmbeddings } from '@langchain/openai';
import { ConfigService } from '@nestjs/config';
import { VectorStoreService } from '../vector-store/vector-store.service'; // Injeksi layer HNSW database

@Processor('embeddings-batch-queue', {
  concurrency: 5, // Batasan proses paralel lokal per-Node/Replika
  limiter: {
    max: 500, // Rate limiting: Maksimum 500 jobs diizinkan
    duration: 60000, // per 60000 milidetik (1 menit)
  }
})
export class EmbeddingWorker extends WorkerHost {
  private readonly logger = new Logger(EmbeddingWorker.name);
  private readonly embeddingsModel: OpenAIEmbeddings;

  constructor(
    private readonly configService: ConfigService,
    private readonly vectorStoreService: VectorStoreService
  ) {
    super();
    const openAIApiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!openAIApiKey) throw new InternalServerErrorException('OPENAI_API_KEY Missing');

    this.embeddingsModel = new OpenAIEmbeddings({
      openAIApiKey,
      modelName: 'text-embedding-3-small',
      maxRetries: 3,
    });
  }

  async process(job: Job<EmbeddingJobData>): Promise<void> {
    const { textContext, metadata } = job.data;
    
    this.logger.log(`Processing Job ID ${job.id}: Creating embedding...`);
    try {
      // API call ke OpenAI Model
      const vectorData = await this.embeddingsModel.embedQuery(textContext);
      
      // Simpan langsung array vektor numerik ke database
      await this.vectorStoreService.insertDirectVector({
        content: textContext,
        metadata: metadata,
        vector: vectorData
      });
      
      this.logger.log(`Job ID ${job.id} Successfully embedded and stored.`);
    } catch (error) {
      this.logger.error(`Failed job ID ${job.id}: ${(error as Error).message}`);
      throw error; // Melempar error memicu percobaan ulang backoff eksponensial otomatis BullMQ
    }
  }
}
```

## 4. Analisis Trade-off

**Kelebihan:**
1. **Resiliensi Tingkat Perusahaan (OOM Resistance):** Alih-alih menaruh file 2 Gigabyte PDF ke dalam satu memori Array Node.js untuk di-loop for-each yang memicu Out Of Memory (OOM), BullMQ mengeksekusi chunk di memori Redis secara bertahap dan terdistribusi, menjaga heap memori backend tetap rendah (< 200MB).
2. **Kepatuhan Limit API Eksternal Presisi:** Penerapan `limiter: { max: 500, duration: 60000 }` di dekorator `@Processor` berfungsi sebagai Token Bucket. Saat batasan API OpenAI limit (429 Too Many Requests) rawan dipicu, BullMQ menjinakkan aliran request agar tidak melewati kuota TPM (Tokens Per Minute), tanpa blocking secara bodoh.
3. **Observabilitas (Redis Metrics):** Status antrean "Pending", "Active", "Failed" disimpan utuh secara persisten pada server Redis. Sangat mudah ditempel UI Dasbor (seperti `bull-board`) untuk inspeksi teknikal admin saat ribuan data PDF gagal diekstrak akibat key kadaluarsa.

**Kekurangan:**
1. **Infrastruktur Ekstra (Redis Dependency):** Penambahan BullMQ secara paksa wajib bergantung pada ketersediaan Redis In-Memory Datastore. Memperkenalkan titik kegagalan tunggal (Single Point of Failure) baru serta menaikkan ongkos deployment infrastructure di lingkungan AWS/GCP (Elasticache/Memorystore).
2. **Keterlambatan (Eventual Consistency):** Ekstraksi asinkronus ke Background Job berarti Frontend yang mengunggah PDF tidak akan secara instan bisa mengkueri vektor dokumen tersebut. Perlu mekanisme intervensi state (seperti Websocket push pemberitahuan atau Polling API) untuk menginfokan klien bahwa vektor dokumennya "Sudah Siap".
3. **Ghost Jobs Hantu & Redis OOM:** Jika worker NestJS mati-hidup berkali-kali (`SIGKILL` Kubernetes mendadak) saat memproses antrean raksasa dan konfigurasi `removeOnComplete` kelupaan tidak diaktifkan, memori set key di Redis cepat menggunung hingga penuh (OOM pada tier cache Redis).

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: "Promise.all()" Massal yang Menghancurkan Heap (Memory Bomb)
Pengembang mencoba memecah file masif menjadi Array of Promise Langchain API calls dan langsung menjalankan `.all()`. NestJS seketika crash, serta IP Address diblokir sementara oleh OpenAI karena serangan ddos ke server API.

```typescript
// ❌ CONTOH SALAH: Memory & API Bomb.
const chunks = textSplitter.split(gbTextFile); 
// Bayangkan array ini 50.000 elements! 
// Promise.all(50000 api requests) = Heap OOM & HTTP 429
await Promise.all(chunks.map(chunk => openai.embed(chunk))); 
```

**Solusi ✅:** Terapkan Batch Processing Queue dengan BullMQ limiter atau menggunakan P-Limit Queue jika dilakukan in-memory, tetapi Queue external BullMQ tetap superior karena kapabilitas retry Redis-backed persisten.

### ❌ Anti-Pattern 2: Lupa Pemecah Karakter Tumpang Tindih (Missing Chunk Overlap)
Memecah teks mentah per persis n-karakter tanpa mempertimbangkan kelanjutan konteks kalimat (tanpa overlap). Vektor menjadi buta semantik saat kueri pengguna menyasar batas potong di antara 2 chunk dokumen yang terpangkas buruk.

```typescript
// ❌ CONTOH SALAH: Splitting membabi buta via sub-string memotong ide semantik
const chunk1 = text.substring(0, 1000); // Teks berakhir di "menurut uuu ten-"
const chunk2 = text.substring(1000, 2000); // Teks berawal "-tang HAM pasal 4..."
// Vektor 1 & 2 akan cacat secara kontekstual!
```

**Solusi ✅:** Selalu gunakan algoritma `RecursiveCharacterTextSplitter` milik LangChain dengan setingan `chunkOverlap: 200` atau lebih, yang otomatis menjamin kalusa atau frasa penting merekatkan ujung chunk n dan ujung chunk n+1.

## 6. Kasus Uji Unit & Mock Pekerja Queue

### `embedding.worker.spec.ts`
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingWorker } from './embedding.worker';
import { ConfigService } from '@nestjs/config';
import { VectorStoreService } from '../vector-store/vector-store.service';
import { Job } from 'bullmq';
import { OpenAIEmbeddings } from '@langchain/openai';

jest.mock('@langchain/openai');

describe('EmbeddingWorker', () => {
  let worker: EmbeddingWorker;
  let vectorStoreService: VectorStoreService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingWorker,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('fake-openai-key'),
          },
        },
        {
          provide: VectorStoreService,
          useValue: {
            insertDirectVector: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    worker = module.get<EmbeddingWorker>(EmbeddingWorker);
    vectorStoreService = module.get<VectorStoreService>(VectorStoreService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('process()', () => {
    it('should generate embeddings and call vector storage insert', async () => {
      // Setup mock data job BullMQ
      const mockJobData = {
        documentId: 'doc-123',
        chunkIndex: 0,
        textContext: 'This is a mocked sentence context.',
        metadata: { source: 'pdf' },
      };
      
      const mockJob = {
        id: 'job-1',
        data: mockJobData,
      } as Job;

      // Mock LangChain OpenAIEmbeddings embedQuery return value
      const fakeVector = [0.123, -0.456, 0.789];
      const mockEmbedQuery = jest.fn().mockResolvedValue(fakeVector);
      (worker as any).embeddingsModel = { embedQuery: mockEmbedQuery } as unknown as OpenAIEmbeddings;

      // Eksekusi trigger worker process
      await expect(worker.process(mockJob)).resolves.not.toThrow();

      // Asserts pemanggilan API & DB
      expect(mockEmbedQuery).toHaveBeenCalledWith('This is a mocked sentence context.');
      expect(vectorStoreService.insertDirectVector).toHaveBeenCalledWith({
        content: mockJobData.textContext,
        metadata: mockJobData.metadata,
        vector: fakeVector,
      });
    });

    it('should throw error and propagate to BullMQ on API failure', async () => {
       const mockJob = { id: 'job-err', data: {} } as Job;
       const err = new Error('Rate limit exceeded');
       
       const mockEmbedQuery = jest.fn().mockRejectedValue(err);
       (worker as any).embeddingsModel = { embedQuery: mockEmbedQuery } as unknown as OpenAIEmbeddings;
       
       await expect(worker.process(mockJob)).rejects.toThrow('Rate limit exceeded');
       // Error terlempar krusial agar Worker BullMQ menganggap job ini Failed, lalu memicu eksponensial Backoff!
    });
  });
});
```

## 7. Production Edge Cases

1. **Stalled Jobs (Poison Pills):** Pekerjaan Redis terkadang mogok ketika server dimatikan paksa (SIGKILL tanpa jeda gracefully shut down). Job ini selamanya terjebak dalam status `active` dan menjadi "Poison Pill". Mitigasinya adalah memastikan `maxStalledCount` pada inisiasi Queue Worker di-setup, dan menambahkan `OnApplicationShutdown` Hook di NestJS untuk menunggu worker membatalkan `.close()` koneksi BullMQ secara aman sebelum OS mati.
2. **Keterbatasan Payload Ukuran Redis (Max Data Size):** Memasukkan keseluruhan korpus dokumen Gigabyte 1-pass ke dalam string Property `data` milik Job Payload BullMQ akan memprovokasi OOM Redis dan error Payload Too Large. Harus dipastikan bahwa string chunk yang masuk Queue dibatasi (<1500 chars/chunk), sisanya disebar ke array Job.
3. **Dead-Letter Queue (DLQ) Penumpukan Permanen:** Setelah maksimal attemps gagal misal 5x (misal model Langchain sedang total-downtime dari OpenAI), job BullMQ dibuang ke pool "Failed". Kalau pool failed dibiarkan sampai ribuan per hari, memori RAM Server Redis penuh. Pembersihan kronologis (cron script `clean('failed', 7*24*3600*1000)`) wajib berjalan untuk membersihkan entri sampah yang usianya lebih dari 7 hari di DLQ Redis.
