# Tonic gRPC Server & Client Mastery

## Konsep Utama
gRPC adalah framework RPC performa tinggi berbasis HTTP/2 dan Protocol Buffers. Dalam ekosistem Rust, `tonic` adalah library *de facto* untuk gRPC. Tonic dibangun di atas `hyper` (HTTP/2), `prost` (Protobuf serialization), dan `tokio` (async runtime). Arsitektur ini sangat ideal untuk microservices inter-communication yang membutuhkan strict typing, low latency, dan streaming bidirectional.

Kapan digunakan:
- Inter-service communication antar microservices di backend.
- Komunikasi dengan bahasa lain yang didukung gRPC (Go, Java, C++).
- Kasus yang membutuhkan streaming data real-time (unary, server streaming, client streaming, atau bidi streaming).

## Arsitektur & Aliran Interceptor

```text
+-------------------+           +-----------------------+           +-------------------+
|                   |           |                       |           |                   |
|  gRPC Client      |  ------>  |  Client Interceptor   |  ------>  |  Network (HTTP/2) |
| (Tonic Channel)   |           | (Inject Auth Token)   |           |                   |
|                   |           |                       |           |                   |
+-------------------+           +-----------------------+           +---------+---------+
                                                                              |
                                                                              v
+-------------------+           +-----------------------+           +---------+---------+
|                   |           |                       |           |                   |
|  gRPC Server      |  <------  |  Server Interceptor   |  <------  |  Network (HTTP/2) |
| (Tonic Router)    |           | (Validate Auth Token) |           |                   |
|                   |           |                       |           |                   |
+-------------------+           +-----------------------+           +-------------------+
```

## Production-Ready Implementation

### `build.rs` (Protobuf Compilation)
```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile(&["proto/service.proto"], &["proto/"])?;
    Ok(())
}
```

### `proto/service.proto`
```protobuf
syntax = "proto3";
package myservice;

service EchoService {
    rpc Echo (EchoRequest) returns (EchoResponse);
}

message EchoRequest {
    string message = 1;
}
message EchoResponse {
    string message = 1;
}
```

### `src/main.rs`
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Request;
    
    #[tokio::test]
    async fn test_echo_service() {
        let service = MyEchoService::default();
        let request = Request::new(myservice::EchoRequest {
            message: "Hello".to_string(),
        });
        
        let response = service.echo(request).await.unwrap();
        assert_eq!(response.into_inner().message, "Echo: Hello");
    }
}

use std::net::SocketAddr;
use tonic::{transport::{Server, Channel, Endpoint}, Request, Response, Status, metadata::MetadataValue};
use myservice::echo_service_server::{EchoService, EchoServiceServer};
use myservice::echo_service_client::EchoServiceClient;

pub mod myservice {
    tonic::include_proto!("myservice"); // Sesuai dengan package name di proto
}

#[derive(Debug, Default)]
pub struct MyEchoService;

#[tonic::async_trait]
impl EchoService for MyEchoService {
    async fn echo(&self, request: Request<myservice::EchoRequest>) -> Result<Response<myservice::EchoResponse>, Status> {
        // Mendapatkan metadata (auth token dll dari interceptor)
        if let Some(user_id) = request.metadata().get("x-user-id") {
            println!("Request dari user: {:?}", user_id);
        }

        let req_msg = request.into_inner().message;
        let reply = myservice::EchoResponse {
            message: format!("Echo: {}", req_msg),
        };
        Ok(Response::new(reply))
    }
}

// Server Interceptor untuk Authentication
fn check_auth(req: Request<()>) -> Result<Request<()>, Status> {
    match req.metadata().get("authorization") {
        Some(t) if t == "Bearer valid_token" => {
            let mut req = req;
            req.metadata_mut().insert("x-user-id", MetadataValue::from_static("user-123"));
            Ok(req)
        },
        _ => Err(Status::unauthenticated("No valid token found")),
    }
}

// Client Interceptor untuk Inject Token
fn inject_auth(mut req: Request<()>) -> Result<Request<()>, Status> {
    let token: MetadataValue<_> = "Bearer valid_token".parse().unwrap();
    req.metadata_mut().insert("authorization", token);
    Ok(req)
}

pub async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "[::1]:50051".parse()?;
    let echo = MyEchoService::default();
    
    // Server dengan interceptor
    let svc = EchoServiceServer::with_interceptor(echo, check_auth);

    println!("gRPC Server listening on {}", addr);
    Server::builder()
        .add_service(svc)
        .serve(addr)
        .await?;

    Ok(())
}

pub async fn run_client() -> Result<(), Box<dyn std::error::Error>> {
    // Channel load balancing configuration (Endpoint)
    let channel = Endpoint::from_static("http://[::1]:50051")
        .concurrency_limit(256)
        .timeout(std::time::Duration::from_secs(5))
        .connect()
        .await?;
        
    // Client dengan interceptor
    let mut client = EchoServiceClient::with_interceptor(channel, inject_auth);

    let request = tonic::Request::new(myservice::EchoRequest {
        message: "Rust Mastery".into(),
    });

    let response = client.echo(request).await?;
    println!("Response: {:?}", response.into_inner());
    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Blocking Calls di dalam gRPC Handler
**Mengapa berbahaya:** Handler `tonic` berjalan di dalam eksekutor `tokio`. Melakukan synchronous blocking I/O (seperti `std::fs::read` atau koneksi database yang synchronous) akan memblokir thread tokio, menyebabkan thread starvation, latency melonjak drastis, dan berpotensi membuat gRPC server tidak merespon health check.
**Solusi:** Selalu gunakan asynchronous library (seperti `tokio::fs` atau `sqlx`). Jika terpaksa, bungkus blocking code dalam `tokio::task::spawn_blocking`.

### Anti-Pattern 2: Menginisialisasi `Channel` per Request
**Mengapa berbahaya:** Membuat `Channel` gRPC melibatkan negosiasi TCP handshake dan TLS (jika digunakan), serta negosiasi HTTP/2. Jika dilakukan di setiap request, ini akan sangat lambat dan membebani server secara tidak perlu.
**Solusi:** `Channel` di `tonic` dirancang murah untuk di-clone dan menggunakan HTTP/2 connection pooling secara internal. Buat `Channel` satu kali dan clone `Client` yang mengandung channel tersebut untuk di-reuse di setiap request.

## Edge Cases & Defensive Programming
- **Connection Drops (Keepalive):** Pada long-lived streaming connection, jaringan mungkin memutus idle socket tanpa memberitahu aplikasi. Konfigurasi TCP Keepalive dan HTTP/2 Ping (melalui `Endpoint::tcp_keepalive` dan `Server::http2_keepalive_interval`) mutlak diperlukan di environment Cloud/Kubernetes untuk menghindari silent connection drop.
- **Request Size Limits:** Konfigurasi batas ukuran pesan (seperti `.max_decoding_message_size(1024 * 1024 * 16)` untuk 16MB) guna mencegah OOM karena bad actor yang mengirimkan payload gRPC raksasa.
- **Backpressure pada Streaming:** Saat menggunakan gRPC server streaming atau bidi-streaming, jika client lebih lambat membaca daripada server yang mengirim data, memori server bisa penuh karena buffering. Pahami batas TCP window HTTP/2 dan jangan spawn unbounded mpsc channel saat memetakan aliran internal stream ke response stream.
