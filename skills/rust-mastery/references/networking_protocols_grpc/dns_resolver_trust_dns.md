# Async DNS Resolving dengan Hickory (Trust-DNS)

## Konsep Utama
Penyelesaian nama domain (DNS Resolution) pada library OS default (`std::net::ToSocketAddrs` atau `getaddrinfo()`) bersifat sinkron dan memblokir thread (blocking C-call OS). Dalam ekosistem tokio yang sangat asinkron, ini berisiko mengakibatkan Thread Starvation bila DNS eksternal melambat. Library `hickory-resolver` (sebelumnya `trust-dns-resolver`) memberikan resolusi DNS asli (pure Rust) dan fully async. Ini mendasar untuk Service Discovery (seperti men-query SRV records untuk gRPC backend), DNS-SD, TTL caching pintar, dan validasi DNSSEC.

Kapan digunakan:
- Sistem microservice (misal Kubernetes atau Consul) yang membutuhkan load-balancing client-side dengan query SRV record kustom.
- Web Scraper atau bot asinkron massal yang melakukan ribuan resolve per detik (menghindari limit OS thread pool).
- Sistem keamanan yang wajib memvalidasi cryptographic signatures zona DNS dengan DNSSEC.

## Arsitektur Async Resolver & Caching TTL

```text
+-----------------------+              +------------------------------+
|  Tokio Application    |              | Hickory Async Resolver       |
|                       |  Lookup      |                              |
| task 1: resolve "X" --|------------> | 1. Cek Local Cache (Valid?)  |
| task 2: resolve "X" --|------------> | 2. (Single Flight) Join Req  |
|                       |              | 3. Query UDP Socket ke NS    |
+-----------------------+              +------+-----------------------+
                                              | 
                                           UDP:53 
                                              v 
                                     [ Google / Cloudflare / K8s CoreDNS ]
```

## Production-Ready Implementation

### Kode Rust
```rust
use hickory_resolver::config::{ResolverConfig, ResolverOpts, NameServerConfigGroup};
use hickory_resolver::{TokioAsyncResolver, error::ResolveError};
use std::net::IpAddr;
use tokio::time::{timeout, Duration};

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_dns_resolution() {
        let resolver = create_custom_resolver().unwrap();
        let result = resolver.lookup_ip("example.com").await;
        assert!(result.is_ok());
    }
}

/// Konfigurasi DNS Resolver Asinkron Produksi
pub fn create_custom_resolver() -> Result<TokioAsyncResolver, ResolveError> {
    // Gunakan NameServer Google dan Cloudflare sebagai root dengan UDP & TCP Fallback
    let system_ns = NameServerConfigGroup::google_cloudflare();
    let mut config = ResolverConfig::from_parts(None, vec![], system_ns);
    
    let mut opts = ResolverOpts::default();
    // Cache memory internal dengan awareness TTL record DNS
    opts.cache_size = 10000;
    
    // Konfigurasi pertahanan DNSSEC 
    // Memvalidasi rantai trust Cryptographic dari zona untuk menghindari spoofing
    opts.validate = true;
    
    // DNS timeout and attempts
    opts.timeout = Duration::from_secs(2);
    opts.attempts = 3;
    // Positive caching & negative caching
    opts.positive_max_ttl = Some(Duration::from_secs(3600)); // Cap di 1 jam
    opts.negative_max_ttl = Some(Duration::from_secs(60));   // Record tidak ada (NXDOMAIN)

    let resolver = TokioAsyncResolver::tokio(config, opts);
    Ok(resolver)
}

pub async fn run_dns_lookup() -> Result<(), Box<dyn std::error::Error>> {
    let resolver = create_custom_resolver()?;

    // 1. Basic A/AAAA Lookup (Resolusi IP)
    let domain = "www.rust-lang.org";
    println!("Resolving A/AAAA for: {}", domain);
    
    // Timeout eksternal dibungkus karena network flakiness tak terprediksi
    match timeout(Duration::from_secs(3), resolver.lookup_ip(domain)).await {
        Ok(Ok(response)) => {
            for ip in response.iter() {
                match ip {
                    IpAddr::V4(ipv4) => println!("  IPv4: {}", ipv4),
                    IpAddr::V6(ipv6) => println!("  IPv6: {}", ipv6),
                }
            }
        }
        Ok(Err(e)) => eprintln!("DNS Error: {}", e),
        Err(_) => eprintln!("DNS Query timeout untuk {}", domain),
    }

    // 2. SRV Record Lookup (Sering digunakan Service Mesh & gRPC Load Balancing)
    let srv_domain = "_xmpp-server._tcp.gmail.com";
    println!("\nResolving SRV for: {}", srv_domain);
    
    match resolver.srv_lookup(srv_domain).await {
        Ok(response) => {
            // Urutkan SRV bedasarkan Priority (rendah = utama) dan Weight (tinggi = utama)
            let mut srv_records: Vec<_> = response.iter().collect();
            srv_records.sort_by(|a, b| {
                a.priority().cmp(&b.priority())
                    .then(b.weight().cmp(&a.weight()))
            });

            for record in srv_records {
                println!(
                    "  Host: {} Port: {} (Prio: {}, Weight: {})",
                    record.target(), record.port(), record.priority(), record.weight()
                );
            }
        }
        Err(e) => eprintln!("SRV Error: {}", e),
    }

    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Instantiate `TokioAsyncResolver` di Dalam Handler Request
**Mengapa berbahaya:** Jika Anda membuat resolver baru dengan `TokioAsyncResolver::tokio(..)` di dalam fungsi yang merespon incoming request (contoh per-request Hyper HTTP atau Tonic gRPC), Anda kehilangan kemampuan In-Memory Caching (TTL Cache). Setiap request akan me-re-query server DNS publik secara penuh, menyia-nyiakan bandwidth, memicu throttling/IP Block dari Cloudflare/Google DNS, dan menambah ekstra 50ms ke end-user Anda.
**Solusi:** Buat instance resolver **sekali saja** (Singleton) saat start-up aplikasi (menggunakan `OnceCell`, `Arc`, atau dependency injection State di web framework), dan *clone* ARC pointer dari resolver tersebut di handler. Hickory resolver didesain sangat murah (cheap) untuk di-clone karena berbagi underlying cache memory di belakang layar.

### Anti-Pattern 2: Melupakan Proteksi DNS Cache Poisoning pada Infrastruktur Kritikal
**Mengapa berbahaya:** DNS adalah protokol kuno yang dikirim plain text via UDP. Tanpa validasi, *Man in the middle attacker* di jaringan terdekat dapat membajak UDP response (DNS Cache Poisoning / Spoofing) untuk me-redirect proxy database Anda ke IP mesin hacker. Hacker menyedot seluruh kredensial database Anda.
**Solusi:** Di lingkungan Zero-Trust yang melewati jaringan luar, pastikan parameter `opts.validate = true` diset, memaksa hickory menggunakan ekstensi protokol DNSSEC untuk memeriksa keabsahan signature digital pada record DNS.

## Edge Cases & Defensive Programming
- **Negative Caching (NXDOMAIN):** Jika bot yang malfungsi me-request random sub-domain secara masif yang tidak valid (`jdshfjdsh.com`), respon `NXDOMAIN` (Not Found) dari DNS pusat juga harus di-cache secara lokal dengan parameter `negative_max_ttl`. Tanpa NXDOMAIN caching, resolver Anda akan mengeksekusi I/O eksternal sia-sia terus menerus saat loop.
- **DNS/TCP Fallback (Truncation):** Jika record DNS terlampau besar melebihi MTU UDP 512 byte (seperti rantai DNSSEC atau ratusan IP server load balancer), server DNS merespon bit flag `TC` (Truncated). Hickory otomatis meng-upgrade koneksi di background, membangun TCP connection asinkron ke server DNS untuk mengunduh paket besarnya. TCP handshake jauh lebih lambat. Di sinilah seting cache max TTL panjang menjadi penyelamat latency.
- **/etc/hosts Override:** Custom resolver tidak membaca file OS native `/etc/hosts` secara otomatis (seperti `getaddrinfo` C-library). Jika environment Kubernetes atau dev mode Anda sangat bergantung pada fake entries `/etc/hosts`, inisialisasi Resolver dengan `ResolverConfig::default()` yang akan membaca config system, bukannya `NameServerConfigGroup::google_cloudflare()`.
