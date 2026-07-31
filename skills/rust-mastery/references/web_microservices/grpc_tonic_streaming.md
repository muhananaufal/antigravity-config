# gRPC & Tonic Streaming

## Konsep Utama
**Tonic** adalah framework gRPC (dan HTTP/2) terkemuka di Rust, dibangun di atas `hyper` dan `prost` (Protocol Buffers). Fitur terkuat dari gRPC adalah **Streaming**; di mana client atau server dapat mengirim data berkelanjutan (sequence of messages) dalam satu koneksi TCP persisten. 
- **Server Streaming:** Klien mengirim 1 request, Server membalas N respons.
- **Client Streaming:** Klien mengirim N request, Server membalas 1 respons.
- **Bidirectional Streaming:** Keduanya bebas mengirim dan menerima N pesan.

**Kapan Digunakan:**
- Inter-service communication berkinerja tinggi (latency rendah, binary payload).
- Data feeds real-time (market data HFT, chat, live logs).
- Mengunggah/Mengunduh file berukuran besar secara sepotong-sepotong (chunks) mencegah kehabisan memori.

## Arsitektur & Flow

```ascii
+-----------------+     HTTP/2 Frame (Header)       +------------------+
| gRPC Client     | ------------------------------> | Tonic gRPC Server|
| (Stream Sender) |     HTTP/2 Frame (Data Chunk 1) | (Stream Receiver)|
|                 | ------------------------------> |                  |
|                 |     HTTP/2 Frame (Data Chunk 2) |                  |
+-----------------+ <------------------------------ +------------------+
                        gRPC Status OK (Trailer)
```

## Production-Ready Code

```rust
// Misal terdefinisi di build.rs atau proto:
// syntax = "proto3";
// package echo;
// service EchoService {
//     rpc BidirectionalEcho(stream EchoRequest) returns (stream EchoResponse);
// }

use std::pin::Pin;
use tokio_stream::{Stream, StreamExt};
use tonic::{transport::Server, Request, Response, Status, Streaming};

// Auto-generated module dari prost
pub mod pb {
    tonic::include_proto!("echo"); // Nama package di file .proto
}

use pb::echo_service_server::{EchoService, EchoServiceServer};
use pb::{EchoRequest, EchoResponse};

#[derive(Default)]
pub struct MyEchoService;

#[tonic::async_trait]
impl EchoService for MyEchoService {
    // Definisi trait yang memerlukan return type berupa Stream trait object
    type BidirectionalEchoStream =
        Pin<Box<dyn Stream<Item = Result<EchoResponse, Status>> + Send + 'static>>;

    #[tracing::instrument(skip(self, request))]
    async fn bidirectional_echo(
        &self,
        request: Request<Streaming<EchoRequest>>,
    ) -> Result<Response<Self::BidirectionalEchoStream>, Status> {
        // Ambil stream dari request client
        let mut in_stream = request.into_inner();

        // Buat channel mpsc asinkron untuk menyalurkan respon stream kembali ke klien
        let (tx, rx) = tokio::sync::mpsc::channel(128);

        // Spawn task background untuk membaca request secara streaming
        tokio::spawn(async move {
            while let Some(result) = in_stream.next().await {
                match result {
                    Ok(req) => {
                        let res = EchoResponse {
                            message: format!("Echo: {}", req.message),
                        };
                        // Kirim balasan. Jika receiver dropped (koneksi putus), hentikan loop
                        if tx.send(Ok(res)).await.is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        // Klien error / putus mendadak
                        tracing::error!("Error pada stream client: {:?}", err);
                        break;
                    }
                }
            }
        });

        // Bungkus Receiver channel sebagai Stream yang di-return oleh fungsi
        let out_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

        Ok(Response::new(Box::pin(out_stream)))
    }
}

// Boilerplate Server setup
/*
pub async fn run_grpc_server() {
    let addr = "[::1]:50051".parse().unwrap();
    let service = MyEchoService::default();
    
    Server::builder()
        .add_service(EchoServiceServer::new(service))
        .serve(addr)
        .await
        .unwrap();
}
*/
```

## Anti-Patterns

1. **Me-load Seluruh Stream ke dalam Memori (Vec)**
   - **MENGAPA BERBAHAYA:** Tujuan utama streaming adalah *menghindari* alokasi buffer tak terbatas. Jika Anda melakukan `while let Some(req) = stream.next()` dan melakukan `vec.push(req)` secara akumulatif sampai stream selesai, penyerang dapat mengirim stream berukuran GigaBytes dan memicu Out of Memory (OOM) kill.
2. **Tidak Menghandle Client Disconnect dengan Benar**
   - **MENGAPA BERBAHAYA:** Di gRPC bidireksional, client bisa diamati hilang jika pemanggilan `.next().await` menghasilkan error (Tonic gRPC cancel) atau channel send `.send().await` mengembalikan Err. Mengabaikan penanganan error ini akan membuat zombie loop background `tokio::spawn` terus berjalan selamanya.

## Edge Context & Defensive Programming
- **Message Size Limits:** Secara default, Tonic membatasi ukuran satu pesan gRPC menjadi sekitar 4MB. Jika Anda mentransfer file tanpa me-slice datanya (chunking) menjadi satuan kecil (< 4MB), Tonic akan otomatis menolak request dengan memunculkan error `ResourceExhausted`. Konfigurasikan `.max_decoding_message_size()` jika diperlukan.
- **Interceptors:** Gunakan `tonic::service::Interceptor` untuk Auth/Middleware. Namun hati-hati, interceptor Tonic bekerja pada level *request inisial* sebelum stream dimulai. Interceptor tidak diinvokasi untuk *setiap pesan (chunk)* dalam stream.
