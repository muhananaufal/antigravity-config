# Arsitektur Enterprise GraphQL NestJS: Code-First vs Schema-First

## 1. Pendahuluan Komprehensif
Dalam skala pengembangan aplikasi tingkat *enterprise*, khususnya pada arsitektur monorepo, pemilihan metodologi pembuatan skema GraphQL merupakan keputusan fundamental yang akan mempengaruhi seluruh siklus pengembangan, kecepatan rilis, dan stabilitas produksi. Terdapat dua mazhab utama dalam ekosistem NestJS dan GraphQL: **Code-First** dan **Schema-First**. 

Pendekatan **Schema-First** menggunakan file berekstensi `.graphql` (Schema Definition Language / SDL) sebagai *Single Source of Truth* (SSOT). Dari SDL ini, tim akan mengandalkan berbagai *tooling* generasi kode (seperti GraphQL Code Generator) untuk menghasilkan antarmuka TypeScript dan *resolver boilerplate*. 

Sebaliknya, pendekatan **Code-First** menggunakan dekorator TypeScript murni (`@ObjectType()`, `@Field()`, `@InputType()`) yang secara otomatis pada saat *runtime* atau proses kompilasi (*build-time*) akan menghasilkan skema `.graphql`. Di dalam NestJS, Code-First sangat diagungkan karena memungkinkan penyatuan (unifikasi) antara definisi tipe data GraphQL, DTO (Data Transfer Object) validasi (seperti Zod), dan logika bisnis secara mulus dalam satu bahasa: TypeScript.

Keputusan menggunakan salah satu dari keduanya sering kali bergantung pada distribusi tim: Jika terdapat tim *frontend* dan *backend* yang bekerja secara paralel dengan bahasa berbeda, *Schema-First* (SDL) memfasilitasi kontrak berbasis bahasa agnostik. Namun, di lingkungan tim *Fullstack TypeScript*, *Code-First* menghilangkan beban perpindahan konteks (*context switching*) dan duplikasi tipe, sehingga memberikan produktivitas mutlak.

## 2. Arsitektur Kompilasi dan Sinkronisasi Tipe

```ascii
+---------------------------------------------------------+
|                  PARADIGMA CODE-FIRST                   |
+---------------------------------------------------------+
|                                                         |
|  [ TypeScript Decorators ]                              |
|  @ObjectType() User {                                   |
|    @Field() id: string;                                 |
|  }                                                      |
|           |                                             |
|           v (NestJS GraphQL Plugin + Runtime)           |
|                                                         |
|  [ Generated SDL (schema.gql) ]  <-- SSOT (Auto-gen)    |
|  type User {                                            |
|    id: ID!                                              |
|  }                                                      |
|                                                         |
+---------------------------------------------------------+

+---------------------------------------------------------+
|                 PARADIGMA SCHEMA-FIRST                  |
+---------------------------------------------------------+
|                                                         |
|  [ GraphQL SDL (schema.graphql) ] <-- SSOT (Manual)     |
|  type User {                                            |
|    id: ID!                                              |
|  }                                                      |
|           |                                             |
|           v (GraphQL Code Generator / ts-morph)         |
|                                                         |
|  [ Generated TypeScript Interfaces ]                    |
|  export interface User {                                |
|    id: string;                                          |
|  }                                                      |
|                                                         |
+---------------------------------------------------------+
```

## 3. Implementasi Produksi: Code-First dengan Zod Integration

Berikut adalah standar industri implementasi Code-First di NestJS yang memadukan GraphQL `@InputType()` dengan validasi Zod tanpa duplikasi.

```typescript
import { InputType, Field, ObjectType, Int, Resolver, Mutation, Args } from '@nestjs/graphql';
import { z } from 'zod';
import { Injectable, UsePipes, PipeTransform, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// 1. Zod Schema sebagai Base Validation
export const CreateUserZodSchema = z.object({
  email: z.string().email('Format email tidak valid'),
  age: z.number().min(18, 'Minimal usia adalah 18 tahun').max(100),
  username: z.string().min(3, 'Username minimal 3 karakter').max(30),
});

// Inferensi tipe murni dari Zod
export type CreateUserType = z.infer<typeof CreateUserZodSchema>;

// 2. GraphQL Input Type yang di-extend dari logika struktur validasi
@InputType('CreateUserInput')
export class CreateUserInput implements CreateUserType {
  @Field(() => String, { description: 'Email pengguna yang unik' })
  email!: string;

  @Field(() => Int, { description: 'Usia pengguna dalam tahun' })
  age!: number;

  @Field(() => String, { description: 'Nama pengguna publik' })
  username!: string;
}

// 3. GraphQL Object Type (Response)
@ObjectType('UserResponse')
export class UserResponse {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  email!: string;

  @Field(() => Int)
  age!: number;

  @Field(() => String)
  username!: string;
}

// 4. Custom Zod Validation Pipe untuk GraphQL
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: z.ZodSchema<unknown>) {}

  public transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const errorMessages = result.error.errors.map(err => err.message).join(', ');
      throw new BadRequestException(`Validasi Input Gagal: ${errorMessages}`);
    }
    return result.data;
  }
}

// 5. Mock Service
@Injectable()
export class UserService {
  public async createUser(data: CreateUserInput): Promise<UserResponse> {
    return {
      id: `usr_${Date.now().toString()}`,
      email: data.email,
      age: data.age,
      username: data.username,
    };
  }
}

// 6. GraphQL Resolver
@Resolver(() => UserResponse)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Mutation(() => UserResponse, { name: 'createUserMutation' })
  @UsePipes(new ZodValidationPipe(CreateUserZodSchema))
  public async createUser(
    @Args('input', { type: () => CreateUserInput }) input: CreateUserInput,
  ): Promise<UserResponse> {
    return this.userService.createUser(input);
  }
}

// 7. Unit Test Suite Komprehensif
describe('UserResolver (Code-First with Zod)', () => {
  let resolver: UserResolver;
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserResolver, UserService],
    }).compile();

    resolver = module.get<UserResolver>(UserResolver);
    service = module.get<UserService>(UserService);
  });

  it('seharusnya diinisialisasi dengan benar', () => {
    expect(resolver).toBeDefined();
    expect(service).toBeDefined();
  });

  it('seharusnya berhasil membuat user jika input valid', async () => {
    const validInput: CreateUserInput = {
      email: 'investor@antigravity.com',
      age: 28,
      username: 'ag_investor',
    };

    const result = await resolver.createUser(validInput);
    expect(result.id).toContain('usr_');
    expect(result.email).toBe(validInput.email);
    expect(result.age).toBe(validInput.age);
  });

  it('seharusnya pipe Zod melempar error untuk usia di bawah 18', () => {
    const pipe = new ZodValidationPipe(CreateUserZodSchema);
    const invalidInput = {
      email: 'bocil@kematian.com',
      age: 15,
      username: 'bcl',
    };

    expect(() => pipe.transform(invalidInput)).toThrow(BadRequestException);
    expect(() => pipe.transform(invalidInput)).toThrow('Minimal usia adalah 18 tahun');
  });
});
```

## 4. Analisis Trade-Off Code-First vs Schema-First

### Kelebihan Code-First
1. **Satu Bahasa (TypeScript):** Seluruh tipe data, logika resolusi, dan keamanan *type* berpusat dalam satu ekosistem TypeScript, menghilangkan beban penulisan SDL terpisah.
2. **Kompilasi Plugin NestJS:** Dengan menggunakan `@nestjs/graphql` CLI plugin, pendefinisian berulang tipe di DTO dan GraphQL dihapuskan sepenuhnya; properti kelas diurai secara otomatis.
3. **Refactoring Bebas Risiko:** Memanfaatkan fitur *Rename Symbol* bawaan IDE TypeScript menjamin sinkronisasi langsung antara struktur internal dengan skema GraphQL ter-ekspos, mencegah perbedaan (*schema drift*).

### Kekurangan Code-First
1. **Ketergantungan Ekosistem:** Skema sangat terikat pada spesifikasi *decorator* NestJS/TypeGraphQL, membuatnya sulit untuk dipindahkan ke bahasa atau kerangka kerja lain di masa depan.
2. **Review Proses Skema:** Meninjau Pull Request (PR) bisa menyulitkan *frontend developer* yang tidak memahami TypeScript, kecuali perubahan file `schema.gql` ikut disertakan dan di-commit (yang kadang dilupakan).
3. **Over-Decoration:** Kelas Entitas bisa membengkak drastis dengan gabungan *decorator* TypeORM/Prisma, Swagger (jika *hybrid*), Class-Validator, dan GraphQL.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Menyembunyikan Schema Drift dengan Tidak Meng-commit Auto-Generated Schema
❌ **Salah (Anti-Pattern):**
Mengkonfigurasi modul GraphQL dengan `autoSchemaFile: true` di memori sehingga tim *frontend* tidak memiliki visibilitas atas versi skema saat ini di repositori git.

✅ **Benar (Best Practice):**
```typescript
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';

export const GraphQLConfig = GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
  sortSchema: true, // Mencegah konflik git merge akibat urutan random
});
```

### Anti-Pattern 2: Berbagi Entity Database Secara Langsung Sebagai GraphQL Object
❌ **Salah (Anti-Pattern):**
Mengekspos kelas entitas TypeORM dengan `@ObjectType()` langsung tanpa filter, berpotensi membocorkan kolom rahasia seperti `password_hash` atau data PII.

✅ **Benar (Best Practice):**
Selalu gunakan *Data Transfer Object* (DTO) respons terpisah yang secara eksplisit dikonversi dari entitas *database*. Gunakan kelas `UserResponse` yang bersih dan hanya merender tipe publik yang diizinkan.

## 6. Production Edge Cases

1. **Circular Dependency pada Field Resolvers:** Pada Code-First, dua kelas yang saling mereferensikan tipe kembalian (misalnya `User` memiliki `Post[]` dan `Post` memiliki `User`) akan merusak kompilasi runtime TypeScript jika tidak dibungkus dengan pemanggilan fungsi *lazy-evaluated* `() => User`. Selalu waspadai hal ini dalam struktur relasional.
2. **Staleness Zod vs GraphQL Type:** Karena TypeScript Interface (Zod inferensi) hanya ada di *compile-time*, kita tetap membutuhkan properti *decorator* atau *plugin* di *runtime* agar NestJS mengetahui tipe datanya. Kelalaian mendeklarasikan `@Field(() => Int)` namun memvalidasi dengan `z.number()` dapat menyebabkan GraphQL menerimanya sebagai `Float` atau `String` secara default, memicu kesalahan konversi skala desimal.
3. **GraphQL Int Limit:** Tipe `Int` di spesifikasi standar GraphQL terbatas pada nilai *signed 32-bit integer*. Dalam lingkungan finansial yang mengirimkan ID berbentuk 64-bit integer atau saldo tinggi dari Zod (`z.number()`), ia akan mengalami *overflow* atau penolakan. Wajib mendefinisikan kustom skalar BigInt atau menggunakan Tipe `String` yang diparsing untuk nilai uang dalam *code-first*.
