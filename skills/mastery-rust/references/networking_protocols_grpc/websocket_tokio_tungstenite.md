# WebSocket dengan tokio-tungstenite

## Konsep Utama
WebSocket adalah protokol stateful yang menyediakan kanal komunikasi dua arah penuh (full-duplex) di atas TCP tunggal, di-upgrade dari koneksi HTTP/1.1. Di Rust, kombinasi `tokio` dan `tungstenite` (melalui crate `tokio-tungstenite`) menawarkan API berbasis stream yang sangat stabil untuk WebSocket asinkron. Berbeda dengan HTTP Request/Response, interaksi di WebSocket berbasis event sehingga membutuhkan manajemen state yang cermat, mekanisme heartbeat (ping/pong) untuk menjaga agar proxy tidak memutus koneksi, dan mekanisme fan-out untuk broadcast ke banyak client (misalnya menggunakan `tokio::sync::broadcast`).

Kapan digunakan:
- Fitur Real-Time chat / Notifikasi push ke client.
- Market data streaming (Crypto / Stock exchanges).
- Multiplayer games (state synchronization).

## Arsitektur & Aliran Heartbeat + Broadcast

```text
                         +-----------------+
                         | Broadcast Chan  | (tokio::sync::broadcast)
                         |  (TX)    (RX)   |
                         +--|--------^-----+
                            |        |
        [Server Loop]       |        | (Spawn per Client)
+-----------------------+   |        |   +-----------------------+
|                       |   |        |   |                       |
|  RX.recv().await    <-----+        +---+ tx.send(msg)          |
|  Sink.send(msg)       |                |                       |
|                       |                |                       |
+-----------------------+                +-----------------------+
    (Split Sink)                             (Split Stream)
          |                                        ^
          | Ping / Text                            | Pong / Text
          v                                        |
+----------------------------------------------------------------+
|                        Network (TCP)                           |
+----------------------------------------------------------------+
```

## Production-Ready Implementation

### Kode Rust
```rust
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::time;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::accept_async;

#[cfg(test)]
mod tests {
    // Note: Unit testing network protocol state machine is complex.
    // Biasanya menggunakan local memory streams atau real TCP bind di localhost.
}

pub async fn start_websocket_server() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:9000".to_string();
    let listener = TcpListener::bind(&addr).await?;
    println!("Listening on: {}", addr);

    // Channel broadcast (kapasitas 1024 pesan)
    // Kapasitas cukup besar agar slow client tidak langsung kena lagging error.
    let (tx, _rx) = broadcast::channel(1024);

    while let Ok((stream, addr)) = listener.accept().await {
        let tx_clone = tx.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, tx_clone).await {
                eprintln!("Error handling connection {}: {}", addr, e);
            }
        });
    }

    Ok(())
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    tx: broadcast::Sender<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Upgrade koneksi TCP ke WebSocket
    let ws_stream = accept_async(stream).await?;
    println!("New WebSocket connection: {}", addr);

    // Membagi socket menjadi bagian Write (sink) dan Read (stream)
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let mut rx = tx.subscribe();

    // Heartbeat Interval
    let mut ping_interval = time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            // Task 1: Terima broadcast pesan dan kirim ke client ini (Sink)
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if ws_sender.send(Message::Text(text)).await.is_err() {
                            break; // Client disconnected
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Client ini terlalu lambat membaca, tokio broadcast men-drop pesan.
                        eprintln!("Client {} lagged behind!", addr);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            // Task 2: Baca pesan dari client (Stream)
            result = ws_receiver.next() => {
                let msg = match result {
                    Some(Ok(msg)) => msg,
                    Some(Err(e)) => {
                        eprintln!("Error reading from {}: {}", addr, e);
                        break;
                    }
                    None => break, // Clean close dari client
                };

                match msg {
                    Message::Text(t) => {
                        println!("Received dari {}: {}", addr, t);
                        // Broadcast ke client lain
                        let _ = tx.send(format!("{}: {}", addr, t)); 
                    }
                    Message::Close(_) => {
                        println!("Client {} disconnected", addr);
                        break;
                    }
                    Message::Pong(_) => {
                        // Respon ping dari client (Heartbeat success)
                        println!("Pong dari {}", addr);
                    }
                    _ => {} // Abaikan tipe data biner/ping dari client
                }
            }

            // Task 3: Heartbeat ping ke client (mencegah load balancer menutup koneksi)
            _ = ping_interval.tick() => {
                if ws_sender.send(Message::Ping(vec![])).await.is_err() {
                    break;
                }
            }
        }
    }

    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Menyimpan state dengan `Arc<Mutex<Vec<TcpStream>>>` untuk Broadcast
**Mengapa berbahaya:** Menyimpan semua socket di dalam satu state terpusat yang di-lock dengan Mutex berarti setiap kali server ingin mem-broadcast, ia harus nge-lock Mutex dan melakukan loop iterasi secara synchronous ke semua stream. Jika ada satu client yang koneksinya lambat atau pending I/O, seluruh server (termasuk client yang cepat) akan tertahan, mengakibatkan Head-Of-Line (HOL) blocking dan performa turun drastis di skala >1000 clients.
**Solusi:** Gunakan event-driven fan-out pattern. Gunakan `tokio::sync::broadcast` di mana setiap client memiliki task-nya sendiri. Lock tidak pernah diblokir oleh operasi jaringan.

### Anti-Pattern 2: Tidak Mengimplementasikan Ping/Pong
**Mengapa berbahaya:** Reverse proxy modern (seperti NGINX, AWS ALB, atau Cloudflare) memiliki aturan Strict Idle Timeout (biasanya 60 detik). Jika koneksi WebSocket hanya mendengarkan dan client tidak mengirim pesan apapun selama itu, router di tengah jalan akan memotong TCP connection tanpa memberitahu klien maupun server secara eksplisit (TCP Half-Open connection).
**Solusi:** Selalu miliki server-side atau client-side heartbeat dengan mengirim `Message::Ping`.

## Edge Cases & Defensive Programming
- **Slow Loris / Broadcast Lag:** Ketika menggunakan `broadcast::channel`, client lambat tidak menahan client lain. `tokio` akan mengembalikan error `RecvError::Lagged` di receiver milik client lambat tersebut. Lakukan drop gracefully atau biarkan client melompati pesan, daripada memaksa buffer yang akan berujung OOM.
- **Handling the `Close` Frame:** Jangan langsung mematikan TCP secara kasar. Ketika menerima `Message::Close`, Anda seharusnya membalas dengan `Message::Close` juga untuk melakukan graceful handshake penutupan, walau `tungstenite` sudah men-handle sebagian besar logika ini di balik layar jika menggunakan API tinggi.
- **Tipe Pesan yang Tidak Diharapkan:** WebSocket memiliki `Text` dan `Binary` frame. Selalu buat pattern matching exhaustif. Jika client jahat tiba-tiba mengirim gigabytes `Binary` data pada sistem chat yang seharusnya ekspektasi `Text`, sistem Anda harus drop koneksinya, bukan mencoba mem-parsing data tersebut menjadi string.
