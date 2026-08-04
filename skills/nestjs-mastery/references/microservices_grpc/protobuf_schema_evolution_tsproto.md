# Manajemen Skema Protobuf & Evolusi dengan `ts-proto` di NestJS

## Pendahuluan

Dalam arsitektur *microservices* yang menggunakan gRPC, Protocol Buffers (Protobuf v3) bertindak sebagai *Single Source of Truth* (SSOT) untuk kontrak antarmuka pemrograman aplikasi (API). Seiring berjalannya waktu, kontrak ini harus berevolusi secara terus-menerus tanpa memutus kompatibilitas (*backward-compatible*) dengan klien yang mungkin masih menggunakan versi kontrak lama.

Pengelolaan skema berskala besar membutuhkan disiplin tinggi. Selain itu, untuk ekosistem Node.js/TypeScript seperti NestJS, generasi kode dari Protobuf ke TypeScript yang efisien dan statis (seperti yang ditawarkan oleh `ts-proto`) merupakan sebuah kebutuhan krusial agar pengembangan berjalan secepat kilatan tanpa mengorbankan keamanan tipe (*type-safety*).

## Diagram Arsitektur Evolusi Skema

```ascii
+--------------------+        +---------------------+        +--------------------+
|   Protobuf Repo    |        |   Protobuf Linter   |        |   CI/CD Pipeline   |
| (SSOT .proto files)| -----> | (Buf.build / buf)   | -----> | (NPM Package Pub)  |
+--------------------+        +---------------------+        +--------------------+
          |                                                            |
          | ts-proto plugin                                            | npm install
          v                                                            v
+--------------------+        +---------------------+        +--------------------+
| Generated TS Types | <----- |  NestJS gRPC Server |        | NestJS gRPC Client |
| (interfaces, enum) |        | (Implements Types)  |        | (Consumes Types)   |
+--------------------+        +---------------------+        +--------------------+
```

## Aturan Evolusi Skema Protobuf (Backward-Compatibility)

Agar perubahan skema tidak merusak sistem (breaking changes), aturan ketat berikut harus dipatuhi:
1. **Jangan pernah mengubah ID numerik (tag) dari sebuah field yang sudah ada.** Tag digunakan untuk serialisasi/deserialisasi pada level biner.
2. **Jangan pernah mengubah tipe data dari sebuah field.** Jika tipe data harus berubah, buat field baru.
3. **Jangan menghapus field wajib (meskipun Protobuf v3 tidak memiliki keyword `required`).** Jika ingin "menghapus" field, gunakan keyword `reserved` pada field number dan field name untuk mencegah penggunaan ulang di masa depan.
4. **Tambahkan field baru secara bebas.** Field baru akan diabaikan oleh klien lama yang tidak mengenalnya.

## Implementasi Kode Produksi: Protobuf & ts-proto

Berikut adalah contoh implementasi kontrak `.proto` yang telah berevolusi dan implementasi NestJS menggunakan antarmuka yang dihasilkan oleh `ts-proto`.

### 1. Definisi Skema Protobuf (`hero.proto`)

```protobuf
syntax = "proto3";

package hero.v1;

// Mencegah penggunaan ID 2 dan nama field 'power_level' di masa depan karena sudah usang
message HeroRequest {
  int32 id = 1;
  reserved 2;
  reserved "power_level";
  
  // Field baru yang ditambahkan di iterasi berikutnya
  string alias = 3; 
}

message HeroResponse {
  int32 id = 1;
  string name = 2;
  repeated string abilities = 3;
}

service HeroService {
  rpc GetHero (HeroRequest) returns (HeroResponse) {}
}
```

### 2. Implementasi Controller di NestJS

```typescript
import { Controller, Injectable, Logger } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Observable, of } from 'rxjs';

// Tipe-tipe ini dihasilkan secara otomatis oleh ts-proto
export interface HeroRequest {
  id: number;
  alias: string;
}

export interface HeroResponse {
  id: number;
  name: string;
  abilities: string[];
}

export interface HeroServiceController {
  getHero(request: HeroRequest): Promise<HeroResponse> | Observable<HeroResponse> | HeroResponse;
}

@Controller()
@Injectable()
export class HeroController implements HeroServiceController {
  private readonly logger: Logger = new Logger(HeroController.name);

  // Simulasi basis data memori
  private readonly heroes: Record<number, HeroResponse> = {
    1: { id: 1, name: 'Gundala', abilities: ['Lightning', 'Speed'] },
    2: { id: 2, name: 'Godam', abilities: ['Strength', 'Flight', 'Invulnerability'] },
  };

  @GrpcMethod('HeroService', 'GetHero')
  public getHero(request: HeroRequest): HeroResponse {
    this.logger.log(`Memproses permintaan untuk Hero ID: ${request.id}`);

    // Validasi input
    if (request.id <= 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'ID Pahlawan harus berupa bilangan bulat positif.',
      });
    }

    const hero: HeroResponse | undefined = this.heroes[request.id];

    if (!hero) {
      this.logger.warn(`Pahlawan dengan ID ${request.id} tidak ditemukan.`);
      throw new RpcException({
        code: status.NOT_FOUND,
        message: 'Pahlawan tidak ditemukan dalam basis data.',
      });
    }

    // Jika klien mengirim alias (opsional dalam proto3), kita bisa memprosesnya
    if (request.alias !== '') {
      this.logger.log(`Permintaan menggunakan alias sekunder: ${request.alias}`);
    }

    return hero;
  }
}
```

## Unit Test & gRPC Client Mock

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { HeroController, HeroRequest, HeroResponse } from './hero.controller';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';

describe('HeroController', () => {
  let controller: HeroController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HeroController],
    }).compile();

    controller = module.get<HeroController>(HeroController);
  });

  describe('getHero', () => {
    it('harus mengembalikan data pahlawan ketika ID valid dan ditemukan', () => {
      const request: HeroRequest = { id: 1, alias: '' };
      const response: HeroResponse = controller.getHero(request) as HeroResponse;
      
      expect(response).toBeDefined();
      expect(response.id).toEqual(1);
      expect(response.name).toEqual('Gundala');
      expect(response.abilities).toContain('Lightning');
    });

    it('harus melempar RpcException NOT_FOUND jika ID tidak terdaftar', () => {
      const request: HeroRequest = { id: 999, alias: '' };
      
      try {
        controller.getHero(request);
        fail('Seharusnya melempar eksepsi');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RpcException);
        const rpcError = error as RpcException;
        expect(rpcError.getError()).toMatchObject({
          code: status.NOT_FOUND,
        });
      }
    });

    it('harus melempar RpcException INVALID_ARGUMENT jika ID tidak valid (negatif/nol)', () => {
      const request: HeroRequest = { id: -5, alias: '' };
      
      try {
        controller.getHero(request);
        fail('Seharusnya melempar eksepsi');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RpcException);
        const rpcError = error as RpcException;
        expect(rpcError.getError()).toMatchObject({
          code: status.INVALID_ARGUMENT,
        });
      }
    });
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Performa Tinggi:** `ts-proto` menghasilkan kode TypeScript statis murni tanpa refleksi (reflection) saat runtime, sehingga footprint memori kecil dan eksekusi sangat cepat dibandingkan dengan loader dinamis seperti `@grpc/proto-loader`.
2. **Keamanan Tipe Penuh (Strict Type Safety):** Seluruh pesan masuk dan keluar dijamin keamanannya saat kompilasi (compile-time) sehingga menghilangkan *bugs* terkait *property typo* atau tipe data yang salah.
3. **Kemandirian Evolusi:** Menggunakan pendekatan *schema evolution* dengan `reserved` memungkinkan mikroservis untuk diperbarui tanpa memerlukan rilis serentak di semua klien (Zero-Downtime Deployment).

### Kekurangan
1. **Kurva Pembelajaran & Disiplin:** Tim engineering harus memahami secara mendalam cara kerja Protobuf (seperti bahwa angka 0 adalah default value di proto3) dan mematuhi kedisiplinan yang ketat saat memodifikasi skema.
2. **Overhead Infrastruktur CI/CD:** Memerlukan langkah ekstra di *pipeline* untuk mem-publish paket NPM (atau skema terpusat lainnya) agar layanan klien mendapatkan antarmuka terbaru.
3. **Ukuran File Terbengkalai:** Jika berevolusi secara ugal-ugalan tanpa pembersihan terstruktur, file `.proto` bisa menjadi sangat panjang dan dipenuhi oleh keyword `reserved`.

## Anti-Patterns

### 1. Mengubah ID Numerik Field ❌
Jika sebuah ID diubah, klien lama yang melakukan serialize dengan ID 1 akan salah dibaca oleh server baru yang menganggap ID 1 adalah field lain.
```protobuf
// SALAH ❌ (Memutus kompatibilitas biner)
message User {
  // Awalnya: string name = 1;
  int32 age = 1; 
}
```

```protobuf
// BENAR ✅ (Gunakan ID baru, reserved ID lama)
message User {
  reserved 1;
  reserved "name";
  int32 age = 2;
}
```

### 2. Mem-Bypass Tipe Data dengan `any` di TypeScript ❌
Mengabaikan manfaat dari `ts-proto` dengan menggunakan `any` akan mengembalikan masalah pada *runtime errors*.
```typescript
// SALAH ❌
public getHero(request: any): any {
  return { id: request.id, name: 'Unknown' };
}
```

```typescript
// BENAR ✅
public getHero(request: HeroRequest): HeroResponse {
  return { id: request.id, name: 'Unknown', abilities: [] };
}
```

## Production Edge Cases

1. **Default Values (Zero Values) di Proto3:** Di Protobuf v3, angka `0`, string kosong `""`, dan boolean `false` tidak akan dikirimkan di kawat (wire) secara *default* (untuk menghemat *bandwidth*). Hal ini bisa membingungkan jika Anda ingin membedakan antara "nilai tidak diset" vs "nilai memang diset 0". Solusi: Gunakan `optional` keyword di proto3 (sejak versi 3.15) atau gunakan tipe bungkus (*wrapper types*) seperti `google.protobuf.Int32Value`.
2. **Keterbatasan Ukuran Pesan (Message Size Limits):** Secara *default*, gRPC membatasi ukuran pesan maksimal sekitar 4MB. Jika kontrak berevolusi untuk mengirim daftar objek dalam jumlah besar, payload dapat menabrak limit ini, mengakibatkan *Resource Exhausted error*. Solusi: Gunakan *gRPC Streaming* atau konfigurasi `grpc.max_receive_message_length`.
3. **Konflik Paket Generasi ts-proto:** Jika terdapat dua definisi pesan dengan nama yang sama di *package* Protobuf yang berbeda, `ts-proto` akan meratakan (flatten) ekspor TypeScript secara *default*. Ini berujung pada bentrokan tipe data jika konfigurasi *plugin* tidak dikelola dengan opsi `outputServices=grpc-js` dan ruang nama (*namespaces*) yang sesuai.
