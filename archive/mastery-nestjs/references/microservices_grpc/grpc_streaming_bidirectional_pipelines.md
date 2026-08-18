# Pemrograman gRPC Streaming & Bidirectional Pipelines di NestJS

## Pendahuluan

Komunikasi *Unary* (Satu *Request*, Satu *Response*) sering kali tidak memadai untuk sistem berskala besar yang membutuhkan pengiriman data berkelanjutan secara waktu nyata (*real-time*), seperti *telemetry*, sistem pengunggahan *file* bongkahan (*chunked uploads*), atau saluran obrolan (*chat/messaging pipelines*). 

gRPC memecahkan masalah ini dengan menyediakan pola *Streaming*: *Client Streaming*, *Server Streaming*, dan *Bidirectional Streaming*. Di NestJS, pemrosesan aliran data tingkat lanjut ini diimplementasikan menggunakan kekuatan RxJS Observables secara reaktif murni, menghilangkan kebutuhan akan *callback hell* dan pengelolaan sirkuit *memory leaks*.

## Diagram Arsitektur Bidirectional Streaming

```ascii
+--------------------------+                         +--------------------------+
|  NestJS gRPC Client      |      HTTP/2 TCP         |  NestJS gRPC Server      |
|                          |    <============>       |                          |
|  [RxJS Subject/Iter]     |  (Multiplexed Stream)   |  [RxJS Observable Pipe]  |
|   - Send: Chunk 1        | ----------------------> |   - Receive: Chunk 1     |
|   - Send: Chunk 2        | ----------------------> |   - Process: ML Model    |
|   - Recv: Ack 1          | <---------------------- |   - Send: Ack 1          |
|   - Send: Chunk 3        | ----------------------> |   - Receive: Chunk 2     |
+--------------------------+                         +--------------------------+
```

## Implementasi Kode Produksi: Bidirectional Streaming

Dalam contoh ini, kita membangun layanan *Telemetri Sensor* di mana jutaan sensor kendaraan mengirimkan koordinat lokasi secara proaktif (*Client Stream*) sementara *Server* merespons secara reaktif kapanpun kecepatan melebihi batas (Peringatan Bahaya / *Server Stream*). Ini adalah kasus penggunaan *Bidirectional*.

### 1. Definisi Skema Protobuf (`telemetry.proto`)

```protobuf
syntax = "proto3";

package telemetry.v1;

message LocationData {
  string vehicle_id = 1;
  double latitude = 2;
  double longitude = 3;
  int32 speed_kmh = 4;
}

message SpeedWarning {
  string vehicle_id = 1;
  string message = 2;
  int32 recorded_speed = 3;
}

service TelemetryService {
  // Bidirectional streaming rpc
  rpc StreamTelemetry (stream LocationData) returns (stream SpeedWarning) {}
}
```

### 2. Implementasi Controller di NestJS Server

```typescript
import { Controller, Logger } from '@nestjs/common';
import { GrpcStreamMethod } from '@nestjs/microservices';
import { Observable, Subject } from 'rxjs';

export interface LocationData {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
}

export interface SpeedWarning {
  vehicleId: string;
  message: string;
  recordedSpeed: number;
}

@Controller()
export class TelemetryController {
  private readonly logger: Logger = new Logger(TelemetryController.name);
  private readonly SPEED_LIMIT: number = 120; // Batas Kecepatan 120 km/jam

  // @GrpcStreamMethod secara otomatis memetakan ke nama Method protobuf
  @GrpcStreamMethod('TelemetryService', 'StreamTelemetry')
  public streamTelemetry(messages: Observable<LocationData>): Observable<SpeedWarning> {
    // Kita harus mengembalikan Observable yang memancarkan peringatan
    const warningSubject: Subject<SpeedWarning> = new Subject<SpeedWarning>();

    messages.subscribe({
      next: (data: LocationData) => {
        this.logger.debug(`Menerima data telemetri dari ${data.vehicleId}: ${data.speedKmh} km/h`);
        
        // Logika Bisnis: Evaluasi Kecepatan
        if (data.speedKmh > this.SPEED_LIMIT) {
          this.logger.warn(`Pelanggaran batas kecepatan oleh ${data.vehicleId}`);
          // Pancarkan (emit) respon kembali ke klien
          warningSubject.next({
            vehicleId: data.vehicleId,
            message: `PELANGGARAN KESELAMATAN: Kurangi kecepatan dari ${data.speedKmh} km/h!`,
            recordedSpeed: data.speedKmh,
          });
        }
      },
      error: (err: unknown) => {
        this.logger.error('Kesalahan aliran telemetri kendaraan', err);
        warningSubject.error(err);
      },
      complete: () => {
        this.logger.log('Aliran telemetri ditutup oleh klien kendaraan.');
        warningSubject.complete();
      },
    });

    return warningSubject.asObservable();
  }
}
```

## Unit Test RxJS Observables

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TelemetryController, LocationData, SpeedWarning } from './telemetry.controller';
import { Subject, lastValueFrom } from 'rxjs';
import { toArray } from 'rxjs/operators';

describe('TelemetryController', () => {
  let controller: TelemetryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TelemetryController],
    }).compile();

    controller = module.get<TelemetryController>(TelemetryController);
  });

  describe('streamTelemetry', () => {
    it('harus memancarkan SpeedWarning jika kecepatan melebihi batas 120km/h', async () => {
      const clientStream: Subject<LocationData> = new Subject<LocationData>();
      const responseStream = controller.streamTelemetry(clientStream.asObservable());

      // Observasi keluaran menjadi array agar dapat di-*assert*
      const outputPromise = lastValueFrom(responseStream.pipe(toArray()));

      // Simulasi injeksi data dari klien
      clientStream.next({ vehicleId: 'V-001', latitude: 0, longitude: 0, speedKmh: 80 }); // Aman
      clientStream.next({ vehicleId: 'V-001', latitude: 0, longitude: 0, speedKmh: 135 }); // Pelanggaran
      clientStream.next({ vehicleId: 'V-002', latitude: 0, longitude: 0, speedKmh: 150 }); // Pelanggaran
      clientStream.complete();

      const output: SpeedWarning[] = await outputPromise;

      expect(output.length).toEqual(2);
      expect(output[0].vehicleId).toEqual('V-001');
      expect(output[0].recordedSpeed).toEqual(135);
      expect(output[1].vehicleId).toEqual('V-002');
      expect(output[1].recordedSpeed).toEqual(150);
    });
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Efisiensi Jaringan Kritis:** Menghindari *overhead handshake* TCP/TLS berulang; koneksi dipertahankan secara asinkron selama aliran data beroperasi via *multiplexing* HTTP/2.
2. **Kinerja Reaktif Asinkron:** Penggunaan *Observables* RxJS mencegah penyumbatan *Event Loop* Node.js, memungkinkan satu server Node.js menangani ribuan aliran secara paralel (*Backpressure Handling*).
3. **Latensi Transmisi Minimal:** Karena tidak ada pembukaan dan penutupan koneksi berulang, paket dikirim langsung layaknya *piping* data secara berkesinambungan.

### Kekurangan
1. **Kompleksitas *Debugging*:** Melacak *stack trace error* dan titik awal putusnya koneksi dalam RxJS pipeline terkadang membingungkan dibandingkan REST konvensional.
2. **Penyeimbangan Beban (Load Balancing) Sulit:** Koneksi yang hidup dalam jangka panjang (L4/L7 long-lived connections) mengharuskan proksi pengarah *traffic* (seperti Envoy atau Nginx) dikonfigurasi khusus agar penyeimbangan (*round-robin*) tidak timpang.
3. **Manajemen *Backpressure* Manual:** Jika klien membanjiri server dengan data lebih cepat dari yang bisa diproses server, antrean *buffer* memori akan meledak jika tidak dikontrol secara eksplisit oleh rekayasawan.

## Anti-Patterns

### 1. Mengabaikan Sinyal Penutupan (Memory Leak) ❌
Tidak membersihkan sumber daya (misalnya timer / listener tambahan) ketika *stream observable* memanggil metode `complete()` atau `error()`. Ini akan membocorkan memori (*memory leak*).
```typescript
// SALAH ❌ (Tidak pernah unsubscribe atau menyelesaikan subject internal)
public streamData(messages: Observable<Data>): Observable<Response> {
  const subject = new Subject<Response>();
  messages.subscribe(data => subject.next(process(data)));
  return subject.asObservable(); // Subject tidak ditutup saat messages complete/error
}
```

```typescript
// BENAR ✅ (Propagasi komplit dan error)
public streamData(messages: Observable<Data>): Observable<Response> {
  const subject = new Subject<Response>();
  messages.subscribe({
    next: (data) => subject.next(process(data)),
    error: (err) => subject.error(err),
    complete: () => subject.complete()
  });
  return subject.asObservable();
}
```

### 2. Memanipulasi Aliran Secara Sinkron (Blocking the Event Loop) ❌
Memanggil operasi yang lambat, masif, dan bersifat *CPU-bound* langsung secara sinkron di blok `next()`.
```typescript
// SALAH ❌
next: (data) => {
   const cryptoHash = crypto.pbkdf2Sync(data.pwd, salt, 100000, 64, 'sha512'); // EVENT LOOP BLOCKED
}
```

```typescript
// BENAR ✅ (Gunakan Worker Threads atau Async)
next: async (data) => {
   const cryptoHash = await util.promisify(crypto.pbkdf2)(data.pwd, salt, 100000, 64, 'sha512'); 
}
```

## Production Edge Cases

1. **Jaringan Terputus Tanpa Sinyal (Half-Open Connections):** Ketika router atau *firewall* memutuskan rute komunikasi diam-diam (tanpa FIN TCP), server tidak menyadari koneksi telah mati, memegang alokasi memori selamanya. Solusi: Menerapkan mekanisme `KeepAlive` dari gRPC (`grpc.keepalive_time_ms`) pada konfigurasi inisiasi Klien dan Server.
2. **Backpressure (Ledakan Memori):** Server tidak sempat memproses *chunk* data dari *streaming* klien, berpotensi OOM (*Out Of Memory*). Solusi: Implementasi *High-Water Marks* yang menunda (pause) penerimaan data di klien sampai server siap.
3. **Pembaruan Aplikasi Tanpa Gangguan (Graceful Shutdown):** Bagaimana merestart Server tanpa memutus *stream* yang sedang kritis? Solusi: Gunakan sinyal SIGTERM untuk menolak koneksi gRPC baru sementara membiarkan *stream* yang sedang berlangsung (Active RPCs) untuk menyelesaikan tugas mereka dalam batas waktu *timeout* (Graceful Draining).
