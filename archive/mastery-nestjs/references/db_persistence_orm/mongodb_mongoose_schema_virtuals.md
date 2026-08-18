# MongoDB Mongoose Schema Virtuals & Indexing di NestJS

Penggunaan basis data dokumen NoSQL seperti MongoDB dengan Mongoose pada arsitektur Enterprise NestJS memerlukan kehati-hatian tingkat tinggi. Pemodelan data (Embedding vs Referencing), perancangan _Aggregation Pipeline_, serta optimasi _B-Tree & Geospatial Indexing_ menentukan skala sistem dalam menampung _High-Frequency Data_.

## 1. Arsitektur Hybrid: Embedding vs Virtuals

Alih-alih selalu menggunakan `$lookup` (yang mahal) atau menanam array dokumen yang tak terhingga batasnya (melampaui 16MB document limit), kita memakai strategi **Virtual Populate**.

```ascii
+--------------------------+          +-------------------------+
|     User Collection      |          |    Order Collection     |
|--------------------------|          |-------------------------|
| _id: ObjectId            |          | _id: ObjectId           |
| name: String             |<---------| user_id: ObjectId (Ref) |
| email: String            |  Virtual | amount: Number          |
|                          |          | status: String          |
| [Virtual: 'orders'] ---->|==========| [Index on user_id]      |
+--------------------------+          +-------------------------+
```

## 2. Pemrograman Schema type-safe (NestJS `@nestjs/mongoose`)

Mongoose Schema harus mendefinisikan tipe statis untuk menjamin type-safety.

```typescript
// user.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

// Optimasi Skema: Jangan biarkan Mongoose menciptakan index saat boot up (autoIndex: false)
// di environment production. Ciptakan di CI/CD.
@Schema({ 
  timestamps: true, 
  toJSON: { virtuals: true }, 
  toObject: { virtuals: true },
  autoIndex: false 
})
export class User {
  @Prop({ required: true, index: true })
  email: string;

  @Prop({ required: true })
  fullName: string;

  // Geospatial Koordinat
  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: false,
    }
  })
  location: { type: string; coordinates: number[] };
}

export const UserSchema = SchemaFactory.createForClass(User);

// 2D Sphere Index untuk kueri lokasi terdekat
UserSchema.index({ location: '2dsphere' });

// Compound Index: Ascending, Descending
UserSchema.index({ email: 1, createdAt: -1 });

// Virtuals untuk membalik relasi tanpa mutasi dokumen utama
UserSchema.virtual('orders', {
  ref: 'Order',
  localField: '_id',
  foreignField: 'user_id',
  justOne: false,
});
```

## 3. High-Frequency Aggregation Pipeline

Mengeksekusi agregasi untuk data analitik skala besar seringkali menimbulkan bottleneck jika tidak dilakukan dengan pipeline yang termitigasi (berada di Memory MongoDB vs Disk).

### ❌ Anti-Pattern: Mengambil data dan difilter di Memory Node.js
```typescript
// SANGAT BURUK: Mengambil jutaan dokumen ke RAM aplikasi, akan OOM (Out of Memory).
async getActiveUserSpendsBad(): Promise<any> {
  const users = await this.userModel.find({ isActive: true }).exec();
  let total = 0;
  for (const u of users) {
    const orders = await this.orderModel.find({ user_id: u._id }).exec();
    total += orders.reduce((acc, curr) => acc + curr.amount, 0);
  }
  return total;
}
```

### ✅ Best Practice: Delegasi Beban Komputasi ke MongoDB Aggregation
```typescript
// user.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './user.schema';

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async getActiveUserSpendsGood(): Promise<any> {
    return this.userModel.aggregate([
      // Stage 1: Filter dengan Index (sangat cepat)
      { $match: { isActive: true } },
      
      // Stage 2: Join virtual (Lookup) - Pastikan user_id di Order memiliki index!
      {
        $lookup: {
          from: 'orders',
          localField: '_id',
          foreignField: 'user_id',
          as: 'order_history'
        }
      },
      
      // Stage 3: Unwind (meratakan array menjadi dokumen)
      { $unwind: { path: '$order_history', preserveNullAndEmptyArrays: false } },
      
      // Stage 4: Mengelompokkan dan jumlah total
      {
        $group: {
          _id: '$_id',
          totalSpent: { $sum: '$order_history.amount' }
        }
      },
      
      // Stage 5: Urutkan pengguna paling boros
      { $sort: { totalSpent: -1 } }
    ]).exec();
  }
}
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Skalabilitas Vertikal-Horizontal:** Kemampuan memecah beban melalui Sharding MongoDB secara transparan.
2. **Schema Flexibility:** Sempurna untuk data yang strukturnya sering berubah-ubah secara dinamis.
3. **Geo-Queries Cepat:** Fitur `2dsphere` index menjadikan Mongoose/MongoDB primadona untuk aplikasi layanan geolokasi dan ride-hailing.

### Kekurangan
1. **Tanpa ACID Native Across Collections:** Meskipun ada multi-document transactions di MongoDB 4+, performanya buruk dibandingkan database SQL relasional.
2. **Memori Rakus:** Aggregation Pipeline mengonsumsi RAM *WiredTiger* secara eksponensial saat operasi pengurutan memori.
3. **Data Duplikasi:** Kebiasaan Embedding untuk menghindari lookup memperbesar ukuran dokumen dan memicu anomali mutasi (Update Anomaly).

## 5. Production Edge Cases

1. **Unbounded Array Anti-Pattern:** Menyematkan (Embedding) log aktivitas di dalam 1 dokumen `User`. Saat log bertambah, ukuran dokumen membengkak melampaui 16MB (BSON limit). Solusi: gunakan referencing atau Outlier Pattern.
2. **CPU Starvation on Indexing:** Membuat indeks compound di _production_ pada koleksi raksasa dengan mode _foreground_ akan mengunci seluruh operasi tulis database (Write Lock). Selalu gunakan operasi pembangunan indeks di *background*.
3. **Replication Oplog Delay:** Node.js melakukan pengecekan kepastian tulis yang salah (`w: 1`) saat menembak Replica Set yang tertunda, mengakibatkan bacaan basi saat segera membaca dari *Secondary node*. 

## 6. Unit Testing (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { UserService } from './user.service';
import { User } from './user.schema';

describe('UserService MongoDB', () => {
  let service: UserService;
  let mockModel: any;

  beforeEach(async () => {
    mockModel = {
      aggregate: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([{ _id: '123', totalSpent: 500 }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getModelToken(User.name),
          useValue: mockModel,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should run performant aggregation pipeline', async () => {
    const result = await service.getActiveUserSpendsGood();
    
    expect(mockModel.aggregate).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].totalSpent).toBe(500);
  });
});
```

## 7. Schema Validation & Lifecycle Hooks

Mongoose menyediakan Lifecycle Hooks (Middleware) dan Validasi bawaan, tetapi pada skala _Enterprise_, mengandalkan validasi Mongoose murni sering tidak cukup untuk aturan domain kompleks. Sebaliknya, gunakan validasi terpisah, dan biarkan _Hooks_ menangani enkripsi, _computed fields_, atau sinkronisasi asinkron.

### ✅ Best Practice: Pre-Save Hooks untuk Hashing
Hindari membocorkan `salt` atau secret di kode; injeksi melalui *Environment Variables*.

```typescript
// user.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import * as bcrypt from 'bcrypt';

@Schema({ timestamps: true })
export class UserAuth {
  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ required: true, select: false }) // select: false mencegah kebocoran saat .find()
  passwordHash: string;
}

export type UserAuthDocument = UserAuth & Document;
export const UserAuthSchema = SchemaFactory.createForClass(UserAuth);

// Gunakan function reguler, BUKAN arrow function untuk menjaga konteks `this`
UserAuthSchema.pre<UserAuthDocument>('save', async function (next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }
  
  // Asumsi bcrypt rounds sudah didefinisikan secara standar, misal 12
  const saltRounds = 12; 
  this.passwordHash = await bcrypt.hash(this.passwordHash, saltRounds);
  next();
});
```

### ❌ Anti-Pattern: Validasi Async yang Lambat di Mongoose Hook
Menjalankan _HTTP Request_ pihak ketiga di dalam hook `pre('save')` akan mengunci koneksi thread Node.js ke database dan dapat memicu *Timeout*.

```typescript
// SANGAT BURUK: Call API external di pre-save hook.
UserAuthSchema.pre('save', async function(next) {
  const result = await fetch(`https://api.example.com/validate?email=${this.email}`); // BLOCKING
  if (!result.ok) throw new Error('Invalid');
  next();
});
```

## 8. Populate vs Aggregation Pipeline

Di NestJS, kita dapat memuat relasi (virtual atau ref) dengan `.populate()`. Walaupun praktis, untuk _Data-Intensive_ applications, `populate()` jauh lebih mahal daripada `$lookup` murni di `aggregate`.

### Analisis Trade-Off Populate vs Aggregate

#### Populate (Mongoose)
1. **Kelebihan:** Sangat mudah dibaca, 1 baris kode `.populate('orders')`, sepenuhnya type-safe dengan definisi interface TypeScript.
2. **Kekurangan:** Menjalankan **multiple queries** di belakang layar (1 kueri tambahan ke koleksi terkait untuk setiap id atau memakai `$in`), lalu menyatukan (_stitching_) data secara _in-memory_ di server Node.js. Memakan CPU dan RAM NestJS yang besar.
3. **Kekurangan Khusus:** Sulit melakukan _pagination_ / limitasi kompleks _di dalam_ hasil _populate_ berjenjang (nested populate).

#### Aggregation (`$lookup`)
1. **Kelebihan:** Dieksekusi 100% pada _Database Engine_ menggunakan bahasa C++ yang sangat cepat, mengirim hanya struktur JSON akhir melalui jaringan.
2. **Kelebihan Tambahan:** Mendukung Pipeline Operators seperti `$filter`, `$slice`, untuk menyaring _nested array_ sebelum dikembalikan.
3. **Kekurangan:** Kode lebih panjang, rentan menjadi "God Function", dan sulit mendapatkan _Type-Safety_ otomatis tanpa mapping ke DTO (Data Transfer Object) kustom secara eksplisit.

## 9. Change Streams untuk Sinkronisasi Real-Time

_Change Streams_ sangat powerful untuk memicu _Event-Driven Architecture_ (seperti Microservices, Kafka, Redis Pub/Sub, atau WebSockets) saat ada mutasi di MongoDB, tanpa melakukan _Polling_ (Polling adalah Anti-Pattern).

### ✅ Best Practice: Mendengarkan Change Streams dengan Robustness

```typescript
// user-sync.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ChangeStream } from 'mongoose';
import { User, UserDocument } from './user.schema';

@Injectable()
export class UserSyncService implements OnModuleInit, OnModuleDestroy {
  private changeStream: ChangeStream | null = null;
  private readonly logger = new Logger(UserSyncService.name);

  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  async onModuleInit(): Promise<void> {
    // Memerlukan Replica Set (Wajib di Production, tidak bisa di Standalone)
    this.changeStream = this.userModel.watch([
      { $match: { 'operationType': { $in: ['insert', 'update'] } } }
    ]);

    this.changeStream.on('change', (change: unknown) => {
      // Broadcast via Websocket / Kafka
      this.logger.log(`Document changed: ${JSON.stringify(change)}`);
      // Lakukan publish ke Broker: this.kafkaClient.emit(...)
    });

    this.changeStream.on('error', (error: unknown) => {
      this.logger.error('Change stream error', error);
      // Restart logic / Fallback
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.changeStream) {
      await this.changeStream.close();
    }
  }
}
```

### Edge Cases di Change Streams
- **Resume Token:** Jika aplikasi NestJS mati secara mendadak (_Crash_), pesan selama waktu jeda akan hilang. _Best Practice_ menyimpan `resumeToken` di Redis, agar dapat menyambung kembali (`startAfter`) dan mencegah Data Loss.
- **Standalone Instance:** Change Streams HANYA berfungsi pada kluster berarsitektur _Replica Set_ / _Sharded Cluster_.

## 10. Atlas Search Integration (Full-Text Search)

Pada aplikasi _E-Commerce_ atau direktori besar, operasi pencarian text murni menggunakan indeks `$text` Mongoose memiliki limitasi performa dan relevansi (kurang optimal menolerir Typo, dll). Integrasi _MongoDB Atlas Search_ (berbasis Apache Lucene) via Mongoose Pipeline menjadi jawaban mutlak.

```typescript
// search.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './user.schema';

export interface SearchResultDto {
  _id: string;
  name: string;
  score: number;
}

@Injectable()
export class ProductSearchService {
  constructor(@InjectModel(User.name) private readonly productModel: Model<UserDocument>) {}

  async performFuzzySearch(keyword: string): Promise<SearchResultDto[]> {
    // Pipeline khusus Mongoose untuk Atlas Search
    // Index 'default' harus dibuat terlebih dahulu di MongoDB Atlas Portal / API.
    const pipeline = [
      {
        $search: {
          index: 'default',
          text: {
            query: keyword,
            path: ['fullName'], // Mencari di field fullName
            fuzzy: {
              maxEdits: 2, // Toleransi typo 2 huruf
            },
          },
        },
      },
      {
        $project: {
          name: '$fullName',
          score: { $meta: 'searchScore' }, // Mendapatkan relevansi Lucene
        },
      },
      { $limit: 20 },
    ];

    return this.productModel.aggregate<SearchResultDto>(pipeline).exec();
  }
}
```

## 11. Schema Versioning & Migrasi

Saat aplikasi berevolusi, struktur koleksi akan mengalami distorsi. Field baru bertambah, field lama usang (_Deprecated_). MongoDB memiliki arsitektur fleksibel, tapi tanpa pola versi, aplikasi _Microservices_ Anda berisiko mengalami _Crash_ jika mendapati dokumen versi usang.

### ✅ Best Practice: Schema Versioning Pattern

Tambahkan field versi (contoh: `schemaVersion`) dan proses Migrasi Data (Upgrading) secara _On-the-Fly_ atau via CI/CD `migrate-mongo`.

#### 11.1 Lazy Upgrade Pattern (On-The-Fly)
Mengekstrak atau mengonversi data versi lama tepat ketika data dibaca oleh aplikasi.
```typescript
// order.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class Order {
  @Prop({ default: 2 })
  schemaVersion: number;

  @Prop()
  total: number; // v2 field

  // Field v1 yang sudah deprecated
  @Prop({ required: false })
  grandTotal_v1?: number; 
}

export type OrderDocument = Order & Document;
export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.post<OrderDocument[]>('find', function(docs: OrderDocument[]) {
  for (const doc of docs) {
    if (doc.schemaVersion === 1) {
      // Migrasi on the fly (di RAM sementara)
      doc.total = doc.grandTotal_v1 ?? 0;
      doc.schemaVersion = 2;
      // Bisa memanggil doc.save() secara asinkron atau membiarkan mutasi terjadi saat transaksi berikutnya.
    }
  }
});
```

#### 11.2 CI/CD Migration Script (Bulk Migration)
Menggunakan paket seperti `migrate-mongo` atau membuat _CLI Command_ NestJS (`nestjs-command`) untuk melakukan `$updateMany` massal pada malam hari saat _Traffic_ sedang sepi.

### Edge Case: Zero Downtime Migration
Memodifikasi tipe data dari `String` ke `Number` secara langsung pada 1 Miliar baris MongoDB akan menghentikan seluruh operasi.
**Mitigasi (Expand and Contract Pattern):**
1. Fase 1: Tambahkan _Field_ baru `price_num` (tipe Number) di samping `price` (tipe String lama).
2. Fase 2: Tulis skrip untuk menyinkronkan (copy) nilai ke _field_ baru (Dual-Write dari aplikasi NestJS juga).
3. Fase 3: Ubah kueri aplikasi agar menggunakan field `price_num`.
4. Fase 4: Buang _field_ `price` yang lama secara bertahap.
