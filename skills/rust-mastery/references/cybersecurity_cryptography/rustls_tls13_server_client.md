# TLS 1.3 Server/Client Configuration dengan `rustls`

## Konsep Utama
`rustls` adalah library TLS modern dalam ekosistem Rust yang dibangun dengan prinsip "safe-by-default". Berbeda dengan OpenSSL yang mendukung banyak protokol lama dan *cipher suites* yang rentan, `rustls` secara otomatis hanya mendukung TLS 1.2 dan TLS 1.3 dengan algoritma kriptografi yang aman (seperti AEAD). 

Kapan digunakan:
- Membangun microservices internal dengan enkripsi *end-to-end* (mTLS).
- Aplikasi *high-performance* berbasis `tokio` yang membutuhkan overhead TLS yang sangat minim dan memori aman.
- Komunikasi klien-server yang memerlukan *Application-Layer Protocol Negotiation* (ALPN) seperti HTTP/2 atau gRPC.
- *Certificate pinning* untuk mencegah serangan *Man-in-the-Middle* (MitM) oleh CA yang dikompromikan.

## Arsitektur & Flow (TLS 1.3 Handshake + ALPN)

```text
    Client                                               Server
      |                                                    |
      | ------ ClientHello (ALPN: h2, TLS 1.3, KeyShare)-> |
      |                                                    |
      | <----- ServerHello (KeyShare, ALPN: h2) ---------- |
      | <----- EncryptedExtensions ----------------------- |
      | <----- Certificate ------------------------------- |
      | <----- CertificateVerify ------------------------- |
      | <----- Finished ---------------------------------- |
      |                                                    |
      | ------ Finished ---------------------------------> |
      |                                                    |
      | ====== Application Data (Encrypted h2 stream) ===> |
```

## Production-Ready Code

```rust
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::{ClientConfig, ServerConfig, RootCertStore};
use rustls_pemfile::{certs, private_key};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use webpki_roots::TLS_SERVER_ROOTS;

/// Memuat sertifikat publik
fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, std::io::Error> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let certs: Vec<_> = certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(certs)
}

/// Memuat private key
fn load_private_key(path: &Path) -> Result<PrivateKeyDer<'static>, std::io::Error> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    private_key(&mut reader)?
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "No private key found"))
}

/// Inisialisasi Server TLS dengan ALPN HTTP/2
pub fn create_tls_server_config(
    cert_path: &Path,
    key_path: &Path,
) -> Result<Arc<ServerConfig>, Box<dyn std::error::Error>> {
    let certs = load_certs(cert_path)?;
    let key = load_private_key(key_path)?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth() // Ubah jika menggunakan mTLS
        .with_single_cert(certs, key)?;

    // ALPN Negotiation: memprioritaskan HTTP/2
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    
    Ok(Arc::new(config))
}

/// Inisialisasi Client TLS yang ketat
pub fn create_tls_client_config() -> Arc<ClientConfig> {
    let mut root_store = RootCertStore::empty();
    // Gunakan webpki_roots untuk Mozilla's root CA certificates
    root_store.extend(TLS_SERVER_ROOTS.iter().cloned());

    let mut config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    // ALPN Request
    config.alpn_protocols = vec![b"h2".to_vec()];

    Arc::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::generate_simple_self_signed;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn generate_test_certs() -> (NamedTempFile, NamedTempFile) {
        let subject_alt_names = vec!["localhost".to_string()];
        let cert = generate_simple_self_signed(subject_alt_names).unwrap();
        
        let mut cert_file = NamedTempFile::new().unwrap();
        cert_file.write_all(cert.serialize_pem().unwrap().as_bytes()).unwrap();
        
        let mut key_file = NamedTempFile::new().unwrap();
        key_file.write_all(cert.serialize_private_key_pem().as_bytes()).unwrap();
        
        (cert_file, key_file)
    }

    #[test]
    fn test_server_config_creation() {
        let (cert_file, key_file) = generate_test_certs();
        let config = create_tls_server_config(cert_file.path(), key_file.path());
        assert!(config.is_ok());
        let config = config.unwrap();
        assert_eq!(config.alpn_protocols[0], b"h2");
    }
}
```

## Anti-Patterns Spesifik

1. **Mem-bypass Verifikasi Sertifikat (The "DangerousClientConfig" Anti-Pattern)**
   - **Apa yang terjadi:** Mengimplementasikan `ServerCertVerifier` yang selalu me-return `Ok(())` tanpa mengecek signature, masa berlaku, atau hostname (biasanya dilakukan saat development karena sertifikat *self-signed* gagal).
   - **Mengapa berbahaya:** Aplikasi terbuka lebar terhadap serangan *Man-in-the-Middle* (MitM). Attacker dapat menyajikan sertifikat apa saja dan client akan menerimanya sebagai server yang valid.

2. **Memuat Root Certs dari Sistem Operasi Secara Asal (System Trust Roots Poisoning)**
   - **Apa yang terjadi:** Mengandalkan `rustls-native-certs` tanpa pemahaman bahwa *trust store* sistem OS (terutama di environment enterprise atau Windows) dapat diinjeksi root CA nakal oleh admin atau malware.
   - **Mengapa berbahaya:** Jika lingkungan eksekusi terkompromi, TLS bisa disadap. Sebaiknya gunakan *WebPKI roots* (`webpki-roots`) secara eksplisit atau implementasikan *Certificate Pinning* jika aplikasi berinteraksi dengan API yang diketahui secara absolut.

## Edge Cases & Defensive Programming

- **Sertifikat Kedaluwarsa Tanpa Notifikasi Sistem:** Proses panjang (*long-running processes*) tidak otomatis memuat ulang (*hot-reload*) sertifikat dari disk. Terapkan mekanisme *file watcher* (seperti `notify`) yang mendeteksi perubahan file sertifikat/kunci dan membangun ulang `Arc<ServerConfig>` lalu me-replace *pointer*-nya via `ArcSwap` atau mekanisme *state reload* lainnya tanpa perlu mematikan listener.
- **SNI (Server Name Indication) Mismatch:** Klien bisa saja terhubung ke IP dengan header Host yang salah. Pastikan aplikasi (lapisan HTTP) melakukan validasi *Host header* setelah TLS handshake selesai, karena TLS hanya memvalidasi bahwa koneksi disetujui, namun *layer* aplikasi harus memastikan routing *virtual host* tepat.
- **Slowloris di Lapisan TLS:** Handshake TLS membutuhkan daya komputasi. Tanpa *timeout* pada level TCP stream, *attacker* bisa membuka banyak koneksi dan menahannya di tengah handshake. Selalu bungkus TCP Stream dengan `tokio::time::timeout` saat proses `tls_acceptor.accept()`.
