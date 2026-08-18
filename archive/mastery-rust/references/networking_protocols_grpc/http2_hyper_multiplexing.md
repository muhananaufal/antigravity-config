# HTTP/2 & Stream Multiplexing dengan Hyper v1.0

## Konsep Utama
HTTP/2 adalah perombakan radikal dari HTTP/1.1 yang berfokus pada efisiensi layer transport, mempertahankan semantik layer aplikasi (metode, header). Fitur paling revolusionernya adalah *Stream Multiplexing* (mengirim banyak request/response secara paralel di dalam 1 koneksi TCP), kompresi header menggunakan stateful protocol `HPACK`, dan kontrol aliran granular (Flow Control). Ekosistem Rust memiliki framework `hyper` v1.0, yang menawarkan fungsionalitas HTTP/1 dan HTTP/2 murni dengan arsitektur trait berbasis `Service`.

Kapan digunakan:
- Membuat reverse proxy modern yang berkomunikasi ke upstream service.
- Implementasi API Gateway yang mendukung koneksi multiplex padat (ribuan request per detik via koneksi TCP yang minim).
- Pondasi bagi gRPC client/server (Tonic mengandalkan Hyper untuk H2).

## Arsitektur Multiplexing & H2 Frame

```text
HTTP/1.1 (Pipelining Gagal / HOLB)          HTTP/2 (Multiplexed Frames over TCP)

Conn 1: [Req 1] -> [Resp 1]                 Single TCP Connection:
Conn 2: [Req 2] -> [Resp 2]                  +--------------------------------+
                                             | [Stream 1: Header Req Frame]   |
       (Butuh 2 koneksi TCP)                 | [Stream 2: Header Req Frame]   |
                                             | [Stream 1: Data Frame 1]       |
                                             | [Stream 2: Data Frame 1]       |
                                             | [Stream 1: Data Frame 2 (END)] |
                                             +--------------------------------+
                                              (1 TCP, banyak concurrent stream)
```

## Production-Ready Implementation

### Kode Rust
```rust
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http2;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};

#[cfg(test)]
mod tests {
    // Pengujian H2 multiplexing memerlukan library client hyper, 
    // biasanya diuji sebagai integrasi e2e dengan reqwest::Client builder H2 prior knowledge.
}

/// Handler fungsi inti, dipanggil secara konkuren per HTTP/2 stream
async fn echo_h2_handler(req: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    // Karena ini HTTP/2, request body dapat berbentuk stream (data frame masuk per blok).
    // Kumpulkan seluruh data stream HTTP/2 menjadi satu chunk byte.
    let bytes = req.into_body().collect().await.unwrap().to_bytes();

    let response = Response::builder()
        .status(StatusCode::OK)
        // Di HTTP/2, Header 'Connection', 'Keep-Alive', 'Transfer-Encoding' diabaikan
        .header("content-type", "text/plain")
        .body(Full::new(bytes))
        .unwrap();

    Ok(response)
}

pub async fn run_hyper_h2_server() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "127.0.0.1:3000".parse()?;
    let listener = TcpListener::bind(addr).await?;

    println!("Hyper HTTP/2 server listening on {}", addr);

    loop {
        let (stream, peer_addr) = listener.accept().await?;
        println!("Accepted connection from: {}", peer_addr);
        
        let io = TokioIo::new(stream);

        // Spawn task baru untuk setiap koneksi fisik TCP
        tokio::spawn(async move {
            // Konfigurasi khusus HTTP/2
            let h2_builder = http2::Builder::new(hyper::rt::TokioExecutor::new())
                // H2 Window Size (Flow Control) menentukan seberapa besar data buffer max per stream.
                // 16 MB max window mencegah server memori penuh dari slow client yang idle
                .initial_stream_window_size(1024 * 1024 * 16)
                // H2 Max Concurrent Streams
                // Membatasi jumlah multiplexing stream dalam satu TCP agar tidak OOM
                .max_concurrent_streams(256);

            // Melayani koneksi sebagai pure HTTP/2 (Prior Knowledge), tanpa HTTP/1.1 upgrade.
            if let Err(e) = h2_builder
                .serve_connection(io, service_fn(echo_h2_handler))
                .await
            {
                eprintln!("Error melayani koneksi {}: {:?}", peer_addr, e);
            }
        });
    }
}

/// Cuplikan pembuatan H2 Client dengan Hyper v1.0
pub async fn run_hyper_h2_client() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:3000";
    let stream = TcpStream::connect(addr).await?;
    let io = TokioIo::new(stream);

    // Handshake HTTP/2 murni
    let (mut sender, conn) = hyper::client::conn::http2::handshake(
        hyper::rt::TokioExecutor::new(), 
        io
    ).await?;

    tokio::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("Client connection error: {}", e);
        }
    });

    let req = Request::builder()
        .uri(format!("http://{}/", addr))
        .method("POST")
        .body(Full::new(Bytes::from("Multiplexed Request 1")))?;

    // Di HTTP/2, multiple sender.send_request bisa dijalankan secara simultan
    // dengan cloning sender/menggunakan task terpisah.
    let res = sender.send_request(req).await?;
    println!("Response status: {}", res.status());

    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Menyisipkan Forbidden Header HTTP/1.1 ke HTTP/2
**Mengapa berbahaya:** Protokol HTTP/2 menangani mekanisme pemutusan dan pembingkaian (framing) di level internal protokol. Memasukkan header khas HTTP/1.1 seperti `Connection: keep-alive`, `Transfer-Encoding: chunked`, atau `Upgrade: websocket` di dalam respons hyper H2 akan melanggar standar RFC 7540. Client parser (seperti browser) biasanya akan memberikan respon `PROTOCOL_ERROR` yang menyebabkan stream terputus seketika dengan error ambigu.
**Solusi:** Bersihkan logika mapping header Anda. Biarkan `hyper` mengurus framing. H2 tidak punya chunked-encoding text, karena sudah diganti dengan DATA frames bawaan.

### Anti-Pattern 2: Tidak Membatasi Konkurensi Stream (`max_concurrent_streams`)
**Mengapa berbahaya:** Jika Anda tidak melakukan tuning pada batas multiplexing di `Builder::new()`, attacker bisa membuat satu koneksi TCP lalu membuka 1 juta HTTP/2 Streams secara serentak dalam mili-detik. `hyper` akan spawn 1 juta asynchronous task, merusak RAM server dalam sekejap (OOM) melalui vektor serangan eksploitasi layer-7 klasik (H2 Rapid Reset / Stream Exhaustion).
**Solusi:** Set `.max_concurrent_streams(N)`. N = 100 s/d 256 sudah lebih dari cukup untuk standar produksi cloud.

## Edge Cases & Defensive Programming
- **HPACK Bomb (Decompression Attack):** Header di HTTP/2 dikompresi menggunakan HPACK. Attacker dapat membuat header ukuran 100 byte yang ketika di-dekompres oleh server meledak menjadi gigabytes (memanfaatkan state tabel HPACK). Batasi maksimum ukuran header dekompresi dengan `.max_header_list_size()`.
- **H2 Rapid Reset Attack:** Serangan CVE-2023-44487 di mana attacker mensubmit request (Headers Frame) dan langsung membatalkannya (RST_STREAM) berulang kali di dalam satu TCP stream. Aplikasi backend Anda mungkin memproses iterasi backend yang berat meski klien sudah RST (batal). Pastikan fungsi handler Anda mendukung Cancellation. Di Tokio dan Hyper, handler di-*drop* saat RST_STREAM dipicu. Jangan spawn backend process dengan thread terlepas (`tokio::spawn(heavy_task)`) tanpa membawa `CancellationToken` atau memeriksa apakah future masih hidup.
- **HTTP/2 Prior Knowledge vs ALPN:** Jika server di atas mengimplementasikan "HTTP/2 Prior Knowledge" murni, `curl` biasa tanpa argumen `--http2-prior-knowledge` tidak akan berfungsi. Dalam lingkungan produksi, HTTP/2 disajikan dibalik TLS, dan negosiasi protokol (apakah H1 atau H2) terjadi di level TLS Handshake melalui ALPN (Application-Layer Protocol Negotiation).
