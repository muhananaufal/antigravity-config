# QUIC Transport dengan s2n-quic

## Konsep Utama
QUIC (Quick UDP Internet Connections) adalah transport protocol berbasis UDP yang didesain untuk memperbaiki batasan TCP. Fitur utamanya mencakup *0-RTT connection establishment* (membuat koneksi tanpa latency handshake yang panjang), dukungan stream independen dalam satu koneksi (mencegah *Head-of-Line blocking* jika satu paket hilang), dan enkripsi bawaan via TLS 1.3. Dalam ekosistem Rust, `s2n-quic` buatan AWS Labs dan `quinn` adalah pustaka andalan.

Kapan digunakan:
- Implementasi HTTP/3.
- Komunikasi VPN berkinerja tinggi atau game real-time (karena latensinya stabil meskipun packet loss).
- Lingkungan mobile di mana IP klien sering berubah (pindah dari Wi-Fi ke Seluler) tanpa harus memutus koneksi (Connection Migration).

## Arsitektur Multiplexing vs TCP

```text
TCP/HTTP2 (HOL Blocking):               QUIC (Independent Streams):
Packets: [P1][P2(Hilang!)][P3]         Packets: [S1-P1] [S2-P1(Hilang!)] [S3-P1]
               |                                           |
+--------------v---------------+        +------------------v------------------+
| Buffer: P1 diterima. P3 ada. |        | Stream 1: Diterima & Langsung diolah|
| App tertahan (blocked)       |        | Stream 2: Menunggu retransmit       |
| menunggu re-transmit P2      |        | Stream 3: Diterima & Langsung diolah|
| karena urutan TCP mutlak     |        |                                     |
+------------------------------+        +-------------------------------------+
```

## Production-Ready Implementation

### Kode Rust
```rust
use s2n_quic::{Server, Client};
use s2n_quic::provider::tls;
use std::error::Error;
use std::net::SocketAddr;
use std::path::Path;

#[cfg(test)]
mod tests {
    // Note: S2N-Quic butuh valid cert setup untuk test lokal.
}

pub async fn run_quic_server() -> Result<(), Box<dyn Error>> {
    // QUIC mewajibkan TLS 1.3, setup sertifikat sangat krusial
    // Dalam produksi, sertifikat X509 dan Private Key yang valid harus dibaca
    let tls = tls::default::Server::builder()
        .with_certificate(Path::new("cert.pem"), Path::new("key.pem"))?
        .build()?;

    let addr: SocketAddr = "127.0.0.1:4433".parse()?;
    
    // Inisialisasi Server s2n-quic
    let mut server = Server::builder()
        .with_tls(tls)?
        .with_io(addr)?
        .start()?;

    println!("QUIC Server listening on {}", addr);

    // Menerima Connection
    while let Some(mut connection) = server.accept().await {
        println!("Connection diterima dari: {}", connection.remote_addr()?);
        
        // Setiap Connection dapat memiliki ribuan Stream
        tokio::spawn(async move {
            // Menerima stream dua arah (bidirectional)
            while let Ok(Some(mut stream)) = connection.accept_bidirectional_stream().await {
                tokio::spawn(async move {
                    let mut buffer = [0; 1024];
                    // Baca dari stream
                    if let Ok(Ok(bytes_read)) = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        stream.receive_into(&mut buffer)
                    ).await {
                        if bytes_read > 0 {
                            println!("Menerima {} bytes", bytes_read);
                            // Tulis balik (Echo)
                            let _ = stream.send(&buffer[..bytes_read]).await;
                        }
                    }
                });
            }
        });
    }

    Ok(())
}

pub async fn run_quic_client() -> Result<(), Box<dyn Error>> {
    // Klien harus memverifikasi sertifikat CA dari server
    let tls = tls::default::Client::builder()
        .with_certificate(Path::new("ca-cert.pem"))?
        .build()?;

    let client = Client::builder()
        .with_tls(tls)?
        .with_io("0.0.0.0:0")? // Bind klien di port sembarang
        .start()?;

    let addr: SocketAddr = "127.0.0.1:4433".parse()?;
    
    // Terhubung ke server
    let mut connection = client.connect(addr).await?;
    
    // Konfigurasi TCP KeepAlive ada secara bawaan di QUIC,
    // memastikan idle ping otomatis.
    connection.keep_alive(true)?;

    // Membuat bidirectional stream dalam satu koneksi
    let mut stream = connection.open_bidirectional_stream().await?;
    stream.send(b"Hello QUIC dari Client!").await?;

    let mut response = vec![0; 1024];
    let bytes_read = stream.receive_into(&mut response).await?.unwrap_or(0);
    
    println!("Response: {}", String::from_utf8_lossy(&response[..bytes_read]));

    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Menggunakan 1 Stream untuk Membawa Banyak Tipe Data yang Berbeda (Seperti TCP Biasa)
**Mengapa berbahaya:** Jika Anda menggunakan 1 Bidirectional stream dan mem-parsing data kustom sendiri di atasnya (multiplexing manual) layaknya koneksi TCP tradisional, Anda kehilangan seluruh keuntungan utama QUIC yaitu penghilangan Head-of-Line Blocking. Stream tunggal berarti paket yang hilang akan menge-block semua message berikutnya dalam stream yang sama.
**Solusi:** Gunakan Stream sesuai fungsinya. QUIC dirancang agar membuat Stream baru itu sangat murah. Jika ingin mentransfer 10 gambar secara paralel, jangan letakkan di dalam 1 Stream. Spawn 10 Unidirectional Stream!

### Anti-Pattern 2: Percaya Pada 0-RTT Secara Penuh (Replay Attacks)
**Mengapa berbahaya:** Fitur "Zero Round Trip Time Resumption" QUIC memungkinkan klien yang pernah terhubung mengirim data aplikasi di paket pertama. Namun, karena data ini dikirim tanpa menunggu *cryptographic nonce* baru dari server, attacker bisa merekam paket 0-RTT dan me-replay-nya (Replay Attack). Jika data berisi perintah seperti "transfer uang", perintah itu akan dieksekusi 2 kali!
**Solusi:** Pastikan endpoint server Anda memperlakukan data dari 0-RTT strictly sebagai *idempotent operations* (misalnya HTTP GET request, query read-only). Jangan izinkan transaksi state-mutating melalui 0-RTT payload.

## Edge Cases & Defensive Programming
- **Connection Migration Handlers:** QUIC bisa selamat jika koneksi klien berubah IP address (misal WiFi drop ke 4G LTE). Hal ini karena sesi diikat pada Connection ID unik, bukan tuple 4 lapis (Source/Dest IP & Port). Pastikan firewall atau load-balancer (seperti HAProxy) di depan server Anda dikonfigurasi untuk me-routing berdasarkan *QUIC Connection ID* menggunakan eBPF atau hashing layer 4, bukan murni berdasarkan Source IP. Jika tidak, koneksi akan putus saat IP berganti.
- **Amplification Attacks Mitigation:** QUIC beroperasi di atas UDP yang rentan *amplification DDoS*. Pustaka `s2n-quic` memitigasi ini dengan membatasi jumlah data yang dikirim sebelum alamat klien diverifikasi, namun seting limit buffer penerima (max datagram size) jangan dibuat terlampau besar.
- **Unidirectional vs Bidirectional:** Jika klien mengirim log/metrik, gunakan `open_unidirectional_stream`. Overheadnya lebih rendah dibanding bidirectional, dan buffer sisi server bisa dialokasikan lebih hemat karena server tahu tidak akan bisa membalas.
