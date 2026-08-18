# Low Level TCP Tuning dengan Socket2

## Konsep Utama
Secara default, Rust standar library `std::net::TcpListener` dan `tokio::net::TcpListener` memberikan abstraksi yang sederhana namun kurang memadai jika kita butuh kontrol di level kernel (seperti pada implementasi HFT, reverse proxy berkinerja tinggi, atau custom network stack). Crate `socket2` memberikan akses langsung ke konfigurasi OS socket options sebelum dan sesudah TCP `bind()`. Konfigurasi populer termasuk `SO_REUSEPORT` (memungkinkan multiple thread listen pada port yang sama untuk skalabilitas), `TCP_NODELAY` (mematikan Nagle's algorithm), setting KeepAlive yang agresif, dan manipulasi ukuran OS buffer.

Kapan digunakan:
- Membangun Load Balancer atau Reverse Proxy performa tinggi.
- Sistem High-Frequency Trading (HFT) yang mematikan segala jenis delay buffering (`TCP_NODELAY`, custom buffer).
- Arsitektur server di mana banyak worker process ingin meng-accept koneksi di port yang sama secara serentak (`SO_REUSEPORT`).

## Arsitektur `SO_REUSEPORT` vs Single Listener

```text
       Normal TCP (Single Accept Queue)             SO_REUSEPORT (Kernel Load Balancing)
       +------------------------------+             +------------------------------+
       |   Client 1, Client 2, C3     |             |   Client 1, Client 2, C3     |
       +--------------+---------------+             +-----+-----------+----------+-+
                      |                                   |           |          |
                      v                             [ Kernel hash (IP, Port) membagi ]
             +--------+-------+                           |           |          |
             |   TCP Socket   |                           v           v          v
             +--------+-------+                      +----+--+   +----+--+  +----+--+
                      |                              | Sock1 |   | Sock2 |  | Sock3 |
            (Lock Contention/Mutex)                  +---+---+   +---+---+  +---+---+
                      |                                  |           |          |
      +-------+-------+-------+-------+                  v           v          v
      |       |       |       |       |              +-------+   +-------+  +-------+
    Wrk 1   Wrk 2   Wrk 3   Wrk 4   Wrk 5            | Wrk 1 |   | Wrk 2 |  | Wrk 3 |
                                                     +-------+   +-------+  +-------+
```

## Production-Ready Implementation

### Kode Rust
```rust
use socket2::{Domain, Protocol, Socket, Type, TcpKeepalive};
use std::io;
use std::net::{SocketAddr, TcpListener as StdTcpListener};
use std::time::Duration;
use tokio::net::TcpListener;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    
    #[test]
    fn test_socket_creation() {
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let socket = create_optimized_listener(addr).unwrap();
        assert!(socket.local_addr().is_ok());
    }
}

/// Fungsi untuk membuat socket yang dikustomisasi penuh sebelum di-bind
pub fn create_optimized_listener(addr: SocketAddr) -> io::Result<StdTcpListener> {
    // 1. Inisialisasi Socket Domain
    let domain = Domain::for_address(addr);
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;

    // 2. SO_REUSEADDR: Mengizinkan restart server tanpa menunggu status TIME_WAIT selesai di OS
    socket.set_reuse_address(true)?;

    // 3. SO_REUSEPORT: Mengizinkan multi-process / multi-thread mendengarkan di port yang sama
    // (Fitur spesifik sistem operasi Unix, di Windows mungkin di-abaikan atau beda behavior)
    #[cfg(all(unix, not(target_os = "solaris"), not(target_os = "illumos")))]
    socket.set_reuse_port(true)?;

    // 4. Konfigurasi Buffer OS
    // Menyesuaikan buffer receive/send TCP di OS level (SO_RCVBUF / SO_SNDBUF)
    // Berguna untuk mengelola throughput besar (BDP - Bandwidth Delay Product)
    socket.set_recv_buffer_size(1024 * 1024 * 4)?; // 4MB Receive
    socket.set_send_buffer_size(1024 * 1024 * 4)?; // 4MB Send

    // 5. TCP KeepAlive kustom (level kernel TCP ping)
    // Jangan diam pasif saat koneksi menggantung (half-open)
    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(60))      // Mulai ping setelah 60s idle
        .with_interval(Duration::from_secs(15)); // Jeda antar ping
    socket.set_tcp_keepalive(&keepalive)?;

    // 6. Bind dan Listen
    socket.bind(&addr.into())?;
    socket.listen(1024 /* panjang accept backlog */)?;

    // 7. Konversi ke std::net::TcpListener (Non-blocking)
    let std_listener: StdTcpListener = socket.into();
    std_listener.set_nonblocking(true)?;

    Ok(std_listener)
}

pub async fn run_tokio_custom_server() -> io::Result<()> {
    let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
    
    // Buat listener dengan socket2
    let std_listener = create_optimized_listener(addr)?;
    
    // Konversi std_listener menjadi tokio_listener
    let tokio_listener = TcpListener::from_std(std_listener)?;
    
    println!("Server mendengar di: {:?}", tokio_listener.local_addr()?);

    while let Ok((stream, client_addr)) = tokio_listener.accept().await {
        tokio::spawn(async move {
            println!("Accepted connection dari: {}", client_addr);
            
            // Konfigurasi TCP_NODELAY per-koneksi
            // Mematikan algoritma Nagle (Jangan buffering data kecil, langsung kirim!)
            if let Err(e) = stream.set_nodelay(true) {
                eprintln!("Gagal set nodelay: {}", e);
            }
            
            // Handling koneksi asinkron (misal echo)
            // tokio::io::copy(&mut stream, &mut stream).await...
        });
    }
    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Mengabaikan Nagle's Algorithm (`TCP_NODELAY = false`) pada Gamedev/HFT
**Mengapa berbahaya:** Secara default, stack TCP Linux/Windows mengaktifkan Algoritma Nagle. Nagle menunda pengiriman paket-paket kecil (buffering) sampai mendapat pengakuan (ACK) dari paket sebelumnya atau buffer penuh, demi menghemat bandwidth. Pada sistem real-time seperti game multiplayer atau API trading (HFT) yang sering mengirim payload kecil berukuran 50 byte, algoritma ini menaikkan latency buatan sekitar 20-50ms (kadang hingga 200ms jika kena Delayed ACK di sisi client).
**Solusi:** Panggil `stream.set_nodelay(true)` pada setiap koneksi baru yang di-accept jika protokol aplikasi Anda real-time dan bukan sekadar mendownload file besar.

### Anti-Pattern 2: Melupakan Status `TIME_WAIT` (`SO_REUSEADDR`)
**Mengapa berbahaya:** Ketika server Anda di-restart (via panic atau deploy), sistem operasi kernel akan menahan TCP port pada state `TIME_WAIT` selama 1-2 menit untuk memastikan tidak ada paket sisa dari koneksi lama yang menyasar aplikasi baru. Jika Anda restart aplikasi cepat-cepat tanpa opsi `SO_REUSEADDR`, Anda akan mendapatkan error `Address already in use (os error 98)`.
**Solusi:** Selalu aktifkan `set_reuse_address(true)` di level soket sebelum memanggil method `bind`.

## Edge Cases & Defensive Programming
- **`SO_REUSEPORT` Threading:** Hanya karena Anda menyalakan `SO_REUSEPORT` tidak berarti performa instan berlipat. Opsi ini bekerja optimal jika Anda me-spawn thread OS sejati (misal dengan mode Multi-Thread Tokio runtime) dengan 1 socket listener di-bind per core (menggunakan thread affinity jika memungkinkan) untuk menghindari CPU cross-talk (NUMA node bounding).
- **Socket Backlog Size:** Angka `1024` pada method `listen()` adalah TCP accept backlog. Jika server Anda mendapat lonjakan koneksi (DDoS atau traffic spike) dan kernel backlog penuh (melebihi 1024), kernel secara diam-diam akan mulai men-drop paket SYN awal dari klien. Klien mengira packet loss dan mencoba lagi, menyebabkan latency yang meluas (SYN flood exhaustion). Monitor `netstat -s | grep "listen"` dan tune `/proc/sys/net/core/somaxconn` di Linux bersama nilai aplikasi.
- **Buffer Tunning `SO_SNDBUF`:** Menyetel buffer besar itu bagus untuk high-throughput (download video besar), tapi bisa memunculkan masalah `Bufferbloat`. Jika bandwidth link aslinya kecil namun OS buffer terlalu besar, delay akan meroket, merusak latency TCP. Biarkan default dari fitur TCP Auto-Tuning kernel jika Anda tidak benar-benar yakin dengan bandwidth kapasitas jalur.
