# Mutual TLS (mTLS) & Workload Identity dengan Rustls/SPIFFE

## Konsep Utama
Dalam arsitektur *Zero Trust / Service Mesh*, IP jaringan dan firewall internal tidak lagi dipercaya. Authentikasi aplikasi backend ke backend ditegakkan melalui *Mutual TLS* (mTLS), di mana tidak hanya Client yang memverifikasi sertifikat Server, melainkan Server juga meminta Client memberikan sertifikat kriptografis uniknya. Ekosistem Rust menggunakan `rustls` (pure Rust TLS yang jauh lebih aman dari OpenSSL) dan `tokio-rustls`. Saat digabungkan dengan standar SPIFFE/SPIRE (Secure Production Identity Framework for Everyone), sertifikat X.509 (*SVID - SPIFFE Verifiable Identity Document*) diputar otomatis setiap beberapa jam, memberi microservice Anda identitas kriptografis level enterprise.

Kapan digunakan:
- Membangun sidecar proxy untuk Service Mesh (alternatif Envoy/Linkerd).
- gRPC microservices inter-communication di mana token auth JWT tidak cukup aman, dan mTLS diwajibkan untuk enkripsi transit dan kepastian identitas workload (POD A benar-benar POD A).
- Memenuhi regulasi Payment Card Industry (PCI-DSS) yang mewajibkan enkripsi in-transit antar service backend.

## Arsitektur mTLS & Workload Identity 

```text
       App 1 (Client SVID)                             App 2 (Server SVID)
       [SPIFFE ID: spiffe://domain/app-1]              [SPIFFE ID: spiffe://domain/app-2]
               |                                               ^
               |       TLS Handshake (ClientHello)             |
               | --------------------------------------------> |
               |                                               |
               |   Server Cert (App 2 SVID) + CertRequest      |
               | <-------------------------------------------- |
               |                                               |
               |     Client Cert (App 1 SVID) + Finished       |
               | --------------------------------------------> |
               v        Secure, 2-Way Authenticated Tunnel     |
           [ tokio-rustls ]                            [ tokio-rustls ]
```

## Production-Ready Implementation

### Kode Rust
```rust
use rustls::server::AllowAnyAuthenticatedClient;
use rustls::{Certificate, PrivateKey, RootCertStore, ServerConfig, ClientConfig};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, TlsConnector};

#[cfg(test)]
mod tests {
    // Tests for mTLS require generation of localized Root CA and leaf certificates,
    // which usually spans multiple files and OpenSSL CLI setup logic.
}

/// Helper fungsi untuk parsing file PEM sertifikat menjadi rustls format
fn load_certs(path: &Path) -> std::io::Result<Vec<Certificate>> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let certs: Vec<_> = rustls_pemfile::certs(&mut reader)
        .map(|c| c.map(Certificate))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(certs)
}

/// Helper fungsi untuk parsing Private Key
fn load_private_key(path: &Path) -> std::io::Result<PrivateKey> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    // Mencari kunci format PKCS8 (modern) atau RSA
    let mut keys: Vec<_> = rustls_pemfile::pkcs8_private_keys(&mut reader)
        .map(|k| k.map(PrivateKey))
        .collect::<Result<Vec<_>, _>>()?;
    
    if keys.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "No private key found"));
    }
    Ok(keys.remove(0))
}

pub async fn run_mtls_server() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Load the Identity Root CA (Trust Bundle dari SPIFFE / SPIRE / internal PKI)
    let ca_certs = load_certs(Path::new("trust_bundle.pem"))?;
    let mut client_auth_roots = RootCertStore::empty();
    for cert in ca_certs {
        client_auth_roots.add(&cert).unwrap();
    }

    // 2. Server mengonfigurasi `AllowAnyAuthenticatedClient`
    // Ini mewajibkan klien mengirimkan TLS Certificate yang diterbitkan oleh Root CA yang sama
    let client_auth = AllowAnyAuthenticatedClient::new(client_auth_roots);

    // 3. Load Server's own Workload Identity SVID (Cert & Key)
    let server_cert = load_certs(Path::new("server_svid.pem"))?;
    let server_key = load_private_key(Path::new("server_key.pem"))?;

    let config = ServerConfig::builder()
        .with_safe_defaults()
        .with_client_cert_verifier(client_auth)
        .with_single_cert(server_cert, server_key)?;

    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("0.0.0.0:8443").await?;

    println!("mTLS Server mendengarkan...");

    while let Ok((stream, peer_addr)) = listener.accept().await {
        let acceptor_clone = acceptor.clone();
        tokio::spawn(async move {
            // Handshake asinkron, jika client tidak bawa sertifikat, koneksi putus
            match acceptor_clone.accept(stream).await {
                Ok(tls_stream) => {
                    println!("Client berhasil diverifikasi dan terhubung: {}", peer_addr);
                    // Lanjutkan dengan protokol L7: misal wrap dengan hyper HTTP/2
                    // handle_h2_connection(tls_stream).await;
                }
                Err(e) => {
                    eprintln!("Sertifikat klien ditolak (mTLS Gagal): {:?}", e);
                }
            }
        });
    }

    Ok(())
}

pub async fn run_mtls_client() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Client Load Trust Bundle untuk memverifikasi Server SVID
    let ca_certs = load_certs(Path::new("trust_bundle.pem"))?;
    let mut server_auth_roots = RootCertStore::empty();
    for cert in ca_certs {
        server_auth_roots.add(&cert).unwrap();
    }

    // 2. Client Load Workload Identity-nya sendiri (SVID)
    let client_cert = load_certs(Path::new("client_svid.pem"))?;
    let client_key = load_private_key(Path::new("client_key.pem"))?;

    let config = ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(server_auth_roots)
        // Di sinilah kunci mTLS! Klien menyuntikkan SVID-nya.
        .with_client_auth_cert(client_cert, client_key)?;

    let connector = TlsConnector::from(Arc::new(config));
    let stream = TcpStream::connect("127.0.0.1:8443").await?;

    // DNS Name / SPIFFE ID dari server yang diharapkan
    let domain = rustls::ServerName::try_from("server-id.internal").unwrap();

    let tls_stream = connector.connect(domain, stream).await?;
    println!("Sukses membentuk jalur mTLS ke server!");
    
    // tls_stream.write_all(b"Secret data...").await?;

    Ok(())
}
```

## Anti-Patterns

### Anti-Pattern 1: Mengabaikan Validasi Domain / SAN di Server SVID
**Mengapa berbahaya:** Jika Anda menulis kustom verifier sertifikat (atau menggunakan flag `.with_no_client_auth()` dari config default TLS klien) dan tidak memeriksa *Subject Alternative Name* (SAN), server jahat dari cluster lain (dengan sertifikat valid dari CA yang sama) dapat memalsukan server asli. Klien mTLS akan membocorkan data ke aplikasi peniru.
**Solusi:** `rustls` by default strict. Pastikan ekstensi SAN pada sertifikat server (misalnya: URI SPIFFE `spiffe://domain.test/frontend`) divalidasi dan dicocokkan pada level aplikasi atau level TLS connector dengan `rustls::ServerName` custom resolver jika identitasnya adalah URI (bukan nama DNS tradisional).

### Anti-Pattern 2: Caching File SVID (Rotasi Terhambat)
**Mengapa berbahaya:** Dalam arsitektur mTLS SPIFFE, masa berlaku sertifikat sangat pendek (SVID biasanya kadaluarsa dalam 1 jam sampai 24 jam) untuk mengurangi risiko kunci bocor. Jika aplikasi Rust Anda mem-baca file `server_svid.pem` hanya 1 kali saat startup dengan pola statik `ServerConfig::builder().with_single_cert()`, ketika daemon SPIRE merotasi file tersebut di disk, aplikasi Anda tidak tahu dan akan crash karena expired certificate.
**Solusi:** Implementasikan *Dynamic Certificate Reload*. `rustls` mengizinkan injeksi kustom dari trait `ResolvesServerCert`. Di dalamnya, gunakan mekanisme polling asinkron, struct `RwLock`, atau Hot-reload inotify file system watcher untuk selalu mengembalikan *sertifikat PEM terbaru* dari memori kapan pun `tokio-rustls` di-hit oleh koneksi baru.

## Edge Cases & Defensive Programming
- **Error TLS Handshake (Alert Received):** Pada mTLS, debug error TLS menjadi sangat rumit ("AlertReceived: BadCertificate", "UnknownIssuer", dll). Gunakan logging layer tingkat TRACE dari crate `tracing` dipadu library `rustls` untuk melihat apakan kegagalan berasal dari CA trust yang kadaluarsa, key mismatch, atau protokol suite cipher (seperti ChaCha20 / AES-GCM) yang tidak cocok.
- **Pajak Kinerja Asymmetric Crypto:** TLS handshake, terutama di mTLS di mana validasi dua arah memakan sumber daya CPU untuk RSA/ECDSA, cukup mahal jika aplikasi membuat jutaan koneksi. Manfaatkan fitur TLS 1.3 `Session Resumption` yang ditawarkan Rustls agar reconnect bisa melewati sebagian besar handshake kriptografi asimetris.
- **Panic Saat Parsing File:** `rustls-pemfile` tidak akan merestart service Anda. Namun jika sertifikat rusak tergenerate di disk (karena masalah I/O dari script shell CA), aplikasi dapat panik saat restart. Tangani logic reload secara gracefully dan fall-back ke SVID cache lama apabila format disk gagal di-decode.
