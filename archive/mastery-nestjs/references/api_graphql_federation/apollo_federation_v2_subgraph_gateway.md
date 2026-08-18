# Arsitektur Distribusi Apollo Federation v2: Subgraph & Supergraph Gateway

## 1. Pendahuluan Komprehensif
Pada era mikrolayanan (*microservices*), menyediakan satu *endpoint* seragam (monolitik API) dari puluhan servis mandiri yang tersebar menjadi kewajiban teknis dalam sistem *enterprise*. **Apollo Federation v2** adalah standar arsitektur evolusioner yang memecah satu grafik besar (Supergraph) menjadi bagian-bagian grafik mandiri yang bisa dikelola (Subgraph). NestJS memfasilitasi pembuatan *gateway* maupun *subgraph* secara *native* dan efisien menggunakan paket `@nestjs/apollo`.

Dengan Apollo Federation, masing-masing tim (contoh: Tim Pengguna, Tim Inventaris, Tim Transaksi) dapat mendeploy, menskalakan, dan mengelola skema mereka sendiri. Supergraph Gateway berfungsi sebagai *router* cerdas yang menyatukan skema-skema tersebut dan meneruskan eksekusi kueri ke masing-masing *subgraph*, mengagregasi hasil sebelum mengirimkannya ke pengguna akhir (klien). Keajaiban utamanya terletak pada entitas terdistribusi, di mana tipe yang sama (seperti `User`) dapat disumbang oleh beberapa mikrolayanan tanpa tumpang tindih kepemilikan.

Apollo Federation v2 juga merombak arahan (*directives*) v1 untuk stabilitas yang lebih baik, mendukung penggabungan skema yang lebih luwes dan kemampuan referensi lintas-*subgraph* secara superior. Sistem ini memberikan kemerdekaan pada skalabilitas tanpa kehilangan fungsionalitas GraphQL.

## 2. Topologi Jaringan Supergraph dan Subgraphs

```ascii
+-----------------------------------------------------------+
|                      CLIENT / WEB                         |
+-----------------------------+-----------------------------+
                              |
                     [ GraphQL Query ]
                              |
                              v
+-----------------------------------------------------------+
|                   APOLLO GATEWAY (PORT 3000)              |
|                    (Supergraph Router)                    |
|  - Menyusun Query Plan                                    |
|  - Memecah Kueri ke Subgraphs                             |
|  - Mengagregasi Response Paralel                          |
+----+--------------------------------------------------+---+
     |                                                  |
     | [ Resolving Users ]              [ Resolving Posts ]
     v                                                  v
+-----------------------+           +-----------------------+
| SUBGRAPH A (PORT 3001)|           | SUBGRAPH B (PORT 3002)|
|     User Service      |           |    Post Service       |
|                       |           |                       |
| type User @key(id) {  |           | extend type User      |
|   id: ID!             |           |   @key(id) {          |
|   name: String!       |           |   posts: [Post]       |
| }                     |           | }                     |
+-----------------------+           +-----------------------+
```

## 3. Implementasi Produksi Type-Safe Subgraph dan Gateway

Di bawah ini adalah kode produksi untuk mendirikan Subgraph dan menyelesaikan entitas terfederasi murni tanpa menggunakan tipe `any`.

```typescript
import { Directive, Field, ID, ObjectType, Resolver, ResolveReference, Query, Args } from '@nestjs/graphql';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// ==========================================
// KODE UNTUK SUBGRAPH USERS (Mikrolayanan 1)
// ==========================================

// 1. DTO / Model
@ObjectType()
@Directive('@key(fields: "id")') // Arahan Federation v2 yang penting
export class User {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  fullName!: string;

  @Field(() => String)
  department!: string;
}

// 2. Service Layer
@Injectable()
export class UserService {
  private readonly users: User[] = [
    { id: '1', fullName: 'Muhammad Antigravity', department: 'Engineering' },
    { id: '2', fullName: 'Alan Turing', department: 'Research' },
  ];

  public async findById(id: string): Promise<User> {
    const user = this.users.find(u => u.id === id);
    if (!user) {
      throw new NotFoundException(`Pengguna dengan ID ${id} tidak ditemukan`);
    }
    return user;
  }
}

// 3. Resolver dengan ResolveReference untuk Federation
@Resolver(() => User)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Query(() => User, { name: 'getUser' })
  public async getUser(@Args('id', { type: () => ID }) id: string): Promise<User> {
    return this.userService.findById(id);
  }

  // Hook ini dipanggil oleh Apollo Gateway saat Subgraph lain mereferensikan entitas User
  @ResolveReference()
  public async resolveReference(reference: { __typename: string; id: string }): Promise<User> {
    return this.userService.findById(reference.id);
  }
}

// ==========================================
// TEST SUITE: Federation Reference Resolving
// ==========================================

describe('UserResolver (Apollo Federation Subgraph)', () => {
  let resolver: UserResolver;
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserResolver, UserService],
    }).compile();

    resolver = module.get<UserResolver>(UserResolver);
    service = module.get<UserService>(UserService);
  });

  it('seharusnya mengembalikan entitas User saat dipanggil oleh Gateway Router', async () => {
    const referenceRequest = { __typename: 'User', id: '1' };
    const result = await resolver.resolveReference(referenceRequest);
    
    expect(result).toBeDefined();
    expect(result.id).toBe('1');
    expect(result.fullName).toBe('Muhammad Antigravity');
  });

  it('seharusnya menolak reference jika ID tidak ada', async () => {
    const invalidReference = { __typename: 'User', id: '999' };
    await expect(resolver.resolveReference(invalidReference)).rejects.toThrow(NotFoundException);
  });
});

/* Catatan Gateway Setup:
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { IntrospectAndCompose } from '@apollo/gateway';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloGatewayDriverConfig>({
      driver: ApolloGatewayDriver,
      gateway: {
        supergraphSdl: new IntrospectAndCompose({
          subgraphs: [
            { name: 'users', url: 'http://localhost:3001/graphql' },
            { name: 'posts', url: 'http://localhost:3002/graphql' },
          ],
        }),
      },
    }),
  ],
})
export class GatewayModule {}
*/
```

## 4. Analisis Trade-Off Apollo Federation v2

### Kelebihan
1. **Otonomi Pengembangan Tim:** Tim bebas melakukan implementasi, pengerahan (*deployment*), dan evolusi domain (*subgraph*) tanpa perlu khawatir bentrok versi atau *merge conflict* dengan modul di repositori monolitik.
2. **Kinerja Distribusi:** *Apollo Router / Gateway* memecah dan mengelompokkan secara paralel kueri-kueri bersarang. Hal ini mendistribusikan beban I/O secara merata ke puluhan mikrolayanan.
3. **Agregasi Entitas Transparan:** Klien hanya melihat graf yang kohesif; klien tidak menyadari di belakang ada perpindahan HTTP kompleks. `@key` memfasilitasi perpanjangan entitas secara efisien lintas ranah.

### Kekurangan
1. **Kompleksitas Infrastruktur Ekstra:** Membutuhkan Apollo Gateway, sistem penemuan layanan (*service discovery*), registri skema (contoh: Apollo Studio/GraphOS), dan mitigasi latensi antar layanan tambahan.
2. **Debugging Kueri Sulit:** Saat sebuah kueri lambat, penelusuran (tracing) letak kemacetan (*bottleneck*) mewajibkan integrasi OpenTelemetry lintas Subgraph, tidak sesederhana menganalisis satu monolit.
3. **Single Point of Failure (SPOF):** Gateway adalah titik rentan kritis; jika Gateway mati atau lamban melakukan introspeksi skema, semua sistem lumpuh terlepas dari Subgraph masih berstatus sehat.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Menyalahgunakan Gateway Sebagai Tempat Logika Bisnis
❌ **Salah (Anti-Pattern):**
Menambahkan fungsionalitas mutasi tambahan, pengubahan respons, atau lapisan autentikasi mendalam langsung pada *Apollo Gateway layer* menggunakan ekstensi penyaring (filter) memori yang berat.

✅ **Benar (Best Practice):**
Gateway hanya berfungsi mutlak sebagai lapisan *routing* murni dan penerusan *header* (misal JWT *Bearer*). Seluruh proses bisnis, validasi *input*, dan resolusi otorisasi tingkat field harus dilakukan pada tingkat Subgraph independen.

### Anti-Pattern 2: N+1 Request Akibat Skema yang Miskin Key
❌ **Salah (Anti-Pattern):**
Mendefinisikan entitas di subgraph yang bergantung tanpa arahan `@provides` atau menggunakan *key* raksasa yang memaksa gateway menjemput seluruh dokumen entitas setiap iterasi daftar relasional.

✅ **Benar (Best Practice):**
Secara eksplisit gunakan komposisi tipe Federasi. Manfaatkan `@external` dan `@provides` (pada v1/v2 kompatibilitas) untuk mengurangi *round-trip* komunikasi HTTP antara subgraph.

## 6. Production Edge Cases

1. **Jebakan Versi Federation Inkompatibel:** Saat mengembangkan Subgraph v1 dengan Gateway yang terkonfigurasi pada Supergraph v2 secara terpaksa tanpa transisi yang bersih, arahkan perbaikan kompatibilitas di `@apollo/subgraph`. Hal ini sangat fatal dan sering menyebabkan gagalnya kompilasi router saat *startup*.
2. **Kegagalan Resolusi Partial:** Dalam sistem federasi, jika Subgraph "Post" merespons sukses dengan milidetik, namun Subgraph "Users" mengalami masalah koneksi basis data (merespon *timeout*), Gateway dapat merespons `null` pada sub-bidang *user* di hasil *post*, sembari melapisi dokumen dengan objek tipe "errors". Aplikasi di sisi *frontend* harus siap menangani graf sebagian terisi (*partial success*).
3. **Penyimpanan (Caching) Gateway yang Sulit Diprediksi:** Menerapkan respons CDN / Caching tingkat kueri di Apollo Gateway menjadi bermasalah pada kueri personalisasi yang mengandalkan JWT sesi. Memastikan pengaturan Cache-Control yang disebar luaskan merata di semua Subgraph mutlak penting agar Gateway tidak secara tidak sengaja men-*cache* data privat secara global.
