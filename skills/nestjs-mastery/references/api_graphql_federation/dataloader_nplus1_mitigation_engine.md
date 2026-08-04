# Mesin Mitigasi N+1 Query: DataLoader di Lingkungan NestJS

## 1. Pendahuluan Komprehensif
Salah satu kelemahan terbesar bawaan (inherent) dalam arsitektur GraphQL adalah fenomena maut bernama **N+1 Query Problem**. Karena resolvers dieksekusi berdasarkan relasi grafik per tingkat (node), sebuah kueri untuk mengambil `100 Users` dan masing-masing mengambil `City`-nya akan mengakibatkan `1 kueri awal + 100 kueri parsial` ke basis data. Jika tidak ditangani, hal ini secara efektif dapat memicu penolakan layanan (Denial of Service - DoS) tidak disengaja ke server relasional saat menghadapi lalu lintas tinggi (high traffic).

Solusi definitif standar industri untuk menyembelih masalah ini adalah penerapan pola (pattern) **DataLoader**. Awalnya dirancang oleh tim Facebook, DataLoader bertindak sebagai lapisan penunda (*debouncer*) mikro dan penyimpanan terpusat (*cache*) per-permintaan (*request lifecycle*).

Dalam kerangka NestJS, integrasi DataLoader membutuhkan ketelitian arsitektural. Karena DataLoader sifatnya sangat berorientasi pada siklus hidup setiap koneksi (*request-scoped*), mendaftarkan kelas DataLoader ke dalam *Dependency Injection* global (Singleton) adalah **malapetaka besar**. Jika di-Singleton, data dari pengguna A akan terbocor dan diambil oleh pengguna B. Oleh karena itu, kita harus mengikat injeksi secara ketat melalui cakupan `Scope.REQUEST` atau membungkus inisialisasinya dalam level *Interceptor* atau *GraphQL Context*.

## 2. Diagram N+1 vs Pemrosesan Batch DataLoader

```ascii
+-------------------------------------------------------------+
|               MASALAH N+1 KETIKA MENGAKSES RELASI           |
+-------------------------------------------------------------+
| Resolver: Query "users { city { name } }"                   |
|                                                             |
| DB EXECUTIONS (Non-Optimized):                              |
| 1. SELECT * FROM users;                  (Returns 100 row)  |
| 2. SELECT * FROM city WHERE id = 1;      (Untuk User 1)     |
| 3. SELECT * FROM city WHERE id = 2;      (Untuk User 2)     |
| ...                                                         |
| 101. SELECT * FROM city WHERE id = 100;  (Untuk User 100)   |
|                                                             |
| Total Queries: 101 queries yang membunuh I/O Network.       |
+-------------------------------------------------------------+

+-------------------------------------------------------------+
|                PENYELESAIAN MELALUI DATALOADER              |
+-------------------------------------------------------------+
| Resolver mendelegasikan ID ke dataloader.load(id)           |
| DataLoader mengumpulkan seluruh ID dalam satu tick loop (ms)|
|                                                             |
| DB EXECUTIONS (Optimized by Batching):                      |
| 1. SELECT * FROM users;                  (Returns 100 row)  |
| 2. SELECT * FROM city WHERE id IN (1, 2, ..., 100);         |
|                                                             |
| DataLoader mendistribusikan kembali baris (row) ke pemanggil|
| Total Queries: 2 queries yang sangat ramah terhadap DB.     |
+-------------------------------------------------------------+
```

## 3. Implementasi Produksi Type-Safe DataLoader

Berikut merupakan implementasi tipe aman tingkat perusahaan, menggunakan pola *NestJS Scoped Provider*, menjamin data setiap *request* aman dari kebocoran (*memory-leak* & *data-leak*).

```typescript
import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { Resolver, Query, ResolveField, Parent, ObjectType, Field, ID } from '@nestjs/graphql';
import { Test, TestingModule } from '@nestjs/testing';

// 1. Tipe Data Domain (GraphQL & TypeScript bersatu tanpa "any")
@ObjectType()
export class Author {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  name!: string;
}

@ObjectType()
export class Book {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  authorId!: string;

  @Field(() => Author)
  author!: Author;
}

// 2. Simulasi Service Basis Data
@Injectable()
export class AuthorService {
  private authors: Author[] = [
    { id: 'a1', name: 'Robert C. Martin' },
    { id: 'a2', name: 'Martin Fowler' },
  ];

  // FUNGSI INTI UNTUK BATCHING (Hanya menerima array dan mengembalikan array dalam urutan sama)
  public async findAuthorsByIds(ids: readonly string[]): Promise<(Author | Error)[]> {
    // Pada dunia nyata: Mongoose `find({ _id: { $in: ids } })` atau TypeORM `In(ids)`
    const fetchedAuthors = this.authors.filter(a => ids.includes(a.id));
    
    // PERINGATAN BATCH: Dataloader WAJIB merespon dalam urutan index yg presisi sesuai `ids`
    return ids.map(id => {
      const author = fetchedAuthors.find(a => a.id === id);
      return author ? author : new Error(`Author dengan ID ${id} tidak ditemukan`);
    });
  }
}

// 3. Kelas Dataloader Terikat Request Lifecycle (Anti-Leak)
@Injectable({ scope: Scope.REQUEST })
export class AuthorDataLoader {
  private loader: DataLoader<string, Author | Error>;

  constructor(private readonly authorService: AuthorService) {
    this.loader = new DataLoader<string, Author | Error>(
      async (keys) => this.authorService.findAuthorsByIds(keys),
      { cache: true } // Cache dalam memori hanya untuk 1 request lifecycle HTTP ini
    );
  }

  public async load(id: string): Promise<Author> {
    const result = await this.loader.load(id);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

// 4. GraphQL Resolver Relasional
@Resolver(() => Book)
export class BookResolver {
  constructor(private readonly authorLoader: AuthorDataLoader) {}

  @Query(() => [Book])
  public async getBooks(): Promise<Book[]> {
    return [
      { id: 'b1', title: 'Clean Code', authorId: 'a1' } as Book,
      { id: 'b2', title: 'Clean Architecture', authorId: 'a1' } as Book,
      { id: 'b3', title: 'Refactoring', authorId: 'a2' } as Book,
    ];
  }

  @ResolveField(() => Author)
  public async author(@Parent() book: Book): Promise<Author> {
    // Membunuh N+1: Memanggil load berulang kali tidak memicu 3x kueri DB
    return this.authorLoader.load(book.authorId);
  }
}

// 5. Test Suite Murni Isolasi N+1 Mitigation
describe('Dataloader N+1 Mitigation Engine', () => {
  let authorService: AuthorService;
  let dataloader: AuthorDataLoader;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuthorService, AuthorDataLoader],
    }).compile();

    authorService = module.get<AuthorService>(AuthorService);
    // Kita menimpa context Request pada pengujian menggunakan instance lokal
    dataloader = await module.resolve<AuthorDataLoader>(AuthorDataLoader);
  });

  it('seharusnya membuktikan sistem batching mengeksekusi multiple ID secara simultan', async () => {
    const spyFind = jest.spyOn(authorService, 'findAuthorsByIds');

    // Memicu N panggilan secara asinkron serentak layaknya GraphQL Field Resolver
    const [res1, res2, res3] = await Promise.all([
      dataloader.load('a1'),
      dataloader.load('a2'),
      dataloader.load('a1'), // Terkena Cache, tak merusak tatanan
    ]);

    expect(res1.name).toBe('Robert C. Martin');
    expect(res2.name).toBe('Martin Fowler');
    expect(res3.name).toBe('Robert C. Martin'); // Pemanggilan ganda untuk data yang sama
    
    // Kueri basis data (fungsi batch) seharusnya murni terakumulasi hanya dipanggil 1 kali eksekusi untuk 2 ID unik!
    expect(spyFind).toHaveBeenCalledTimes(1);
    expect(spyFind).toHaveBeenCalledWith(['a1', 'a2']);
  });
});
```

## 4. Analisis Trade-Off DataLoader

### Kelebihan
1. **Penghancuran N+1 Mutlak:** Menurunkan frekuensi pemanggilan ke *database* atau servis internal secara dramatis (dari `O(n)` menjadi `O(1)` per level penyelesaian relasi).
2. **Cache Memorization Per-Request:** Pemanggilan terhadap entitas dengan *primary key* yang sama berulang kali dalam satu skema yang dalam, cukup meresolusi memori cache (tanpa menyentuh basis data).
3. **Pemisahan Kepedulian:** Resolver tidak dipaksa mengetahui teknik penggabungan kompleks (seperti `JOIN` basis data). Resolver tetap menjaga modularitas murni memanggil fungsi tunggal `load(id)`.

### Kekurangan
1. **Arsitektur Request-Scope Overhead:** Menginjeksikan Dataloader sebagai *Scope.REQUEST* memaksa NestJS melakukan inisialisasi ulang instansi kontainer pada setiap masuknya HTTP kueri baru; ini memberikan pukulan *overhead* memori minor.
2. **Kompleksitas Sinkronisasi Array (The Array Mapping Trap):** Pemrograman yang mengurus iterasi *batching* `find` diwajibkan secara tegas merespons indeks data sama persis dengan urutan ID array masukan. Kesalahan menyortir akan menukar data pengguna A ke B.
3. **Bukan Silver Bullet untuk Multi-Variabel Filter:** DataLoader brilian untuk pengikatan via `ID`, tetapi kesulitan yang absurd muncul saat *Field* memerlukan pencarian yang menyematkan argumen ganda (seperti `load({ authorId: 'x', orderBy: 'date', limit: 10 })`), memicu *caching key collisions*.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Menggunakan Default Singleton Scope untuk DataLoader
❌ **Salah (Anti-Pattern):**
```typescript
@Injectable() // <- DEFAULT ADALAH SINGLETON = FATAL LEAK!
export class UserLoader {
  // Semua request dari seluruh dunia akan membagi 1 instance cache yang sama!
  // User Z bisa melihat data privat profil User A dari tembolok (cache) ini!
}
```

✅ **Benar (Best Practice):**
Selalu gunakan `@Injectable({ scope: Scope.REQUEST })` untuk memastikan kerahasiaan (*isolation*) memori DataLoader hancur ketika respons GraphQL selesai dikirim ke pengguna tunggal.

### Anti-Pattern 2: Mengabaikan Pengurutan Kembalian Data
❌ **Salah (Anti-Pattern):**
```typescript
// ID input: [1, 5, 2]
async batchFn(ids: number[]) {
  // Basis data SQL secara default tidak mempedulikan urutan WHERE IN (1, 5, 2)
  // Ia mungkin mengembalikan Array object dengan urutan index: [ID:2, ID:1, ID:5]
  return this.repo.find({ id: In(ids) }); // Kesalahan Fatal Dataloader
}
```

✅ **Benar (Best Practice):**
Fungsi muat (batch loader function) *wajib mutlak* mencocokkan urutan panjang (length) dan pemetaan array balik. Jika hasil dari basis data tidak sejajar dengan indeks kunci permintaan masukan, buat *loop* pencocokan atau kembalikan obyek abstrak *Error*.

## 6. Production Edge Cases

1. **Efek Domino ID Hilang (Soft Delete):** Jika sebuah obyek pada tabel direferensikan dalam GraphQL namun dihapus secara halus (*Soft Delete*) dari tabel lain, `findByIds` pada DataLoader mungkin merespons kekosongan (`undefined`). Jika ini terjadi dan larik (*array*) respon Dataloader jadi lebih pendek dari pemanggil awal ID masukan, keseluruhan eksekusi akan rusak (*panic*). Wajib mengisi slot yang tak ditemukan itu dengan entitas nol yang ditangani anggun (seperti `null` atau abstraksi obyek error).
2. **Keterbatasan Ukuran (Batch Size Limit):** Saat sebuah klien tanpa henti melakukan permintaan GraphQL yang merender tabel analitik atau lis panjang, DataLoader bisa melompat merakit satu raksasa kueri *SQL IN (10.000 IDs)*. Hal ini dapat meledakkan mesin basis data pada tingkat *statement threshold*. Tetapkan `{ maxBatchSize: 1000 }` di dalam opsi instansiasi kelas *DataLoader*.
3. **Kondisi Perlombaan Event Loop di Interceptor NestJS:** Terkadang `Promise.all` di Dataloader diproses tertunda oleh *Interceptor NestJS* kustom yang bersifat asinkron menunda *tick* eksekusi NodeJS. Hal ini mengakibatkan `batchFn` dieksekusi berkali-kali untuk pecahan ukuran ID yang sangat kecil, menghancurkan optimalisasi I/O murni dari *debounce*. Pastikan untuk mengoptimalkan pengaturan `batchScheduleFn` menggunakan *process.nextTick* pada skenario intensif.
