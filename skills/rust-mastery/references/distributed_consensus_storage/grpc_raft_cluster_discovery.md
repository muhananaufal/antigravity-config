# gRPC & Cluster Discovery (Tonic)

## Konsep Utama
Dalam ekosistem terdistribusi, komunikasi intra-node dengan latensi rendah dijamin oleh gRPC (via `tonic` di Rust). Node bersifat ephemeral (skala dinamis/mati/hidup), sehingga hardcoding alamat IP tidak dimungkinkan. Node perlu meregistrasikan diri di sistem *Discovery* (seperti etcd / Consul), sementara client melakukan polling (atau melanggan perubahan *watch*) untuk menjaga daftar endpoint terhubung tetap *up-to-date* yang didukung load-balancing dan retries (`tower`).

## Arsitektur & Diagram Alur (ASCII)
```text
[etcd / Service Registry]
   ^           | (Watch / Refresh)
   | (Register)|
[Node B]       |
             [Tonic Client Wrapper]
                 | 
                 +--> Channel 1 (IP: Node A) [Active]
                 +--> Channel 2 (IP: Node B) [Idle]
                 +--> Channel 3 (IP: Node C) [HealthCheck Failed]
```

## Kode Rust Production-Ready
```rust
// Requires: tonic = "0.9", tower = "0.4", tokio = { version = "1.0", features = ["full"] }
use tonic::transport::{Channel, Endpoint};
use tower::retry::{Retry, Policy};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

// --- 1. Retry Policy sederhana menggunakan Tower ---
#[derive(Clone)]
pub struct GrpcRetryPolicy {
    max_retries: usize,
}

impl<Req, Res, Err> Policy<Req, Res, Err> for GrpcRetryPolicy
where
    Req: Clone,
{
    type Future = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn retry(&self, req: &Req, result: Result<&Res, &Err>) -> Option<Self::Future> {
        match result {
            Ok(_) => None, // Sukses, jangan retry
            Err(_) => {
                // Di dunia nyata, cek kode status (misal UNAVAILABLE di retry, INVALID_ARGUMENT jangan)
                if self.max_retries > 0 {
                    // Backoff delay
                    let fut = Box::pin(async {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    });
                    Some(fut)
                } else {
                    None
                }
            }
        }
    }

    fn clone_request(&self, req: &Req) -> Option<Req> {
        Some(req.clone())
    }
}

// --- 2. Dynamic Endpoint Builder ---
pub async fn create_resilient_channel(registry_uris: Vec<String>) -> Result<Channel, tonic::transport::Error> {
    let mut endpoints = Vec::new();
    
    // (Simulasi) Mengambil endpoint dari registry seperti etcd
    for uri in registry_uris {
        let endpoint = Endpoint::from_shared(uri)
            .unwrap()
            .timeout(Duration::from_secs(5))
            .concurrency_limit(256)
            .tcp_keepalive(Some(Duration::from_secs(15))); // Deteksi TCP mati diam-diam
        endpoints.push(endpoint);
    }

    // Tonic secara natif mendukung round-robin load balancing terhadap multiple endpoints
    // Jika endpoint mati, channel akan re-connect/melewati bad node secara dinamis.
    let channel = Channel::balance_list(endpoints.into_iter());
    
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_endpoint_builder() {
        // Test builder tidak crash saat diberikan format uri valid
        let uris = vec!["http://127.0.0.1:8080".to_string(), "http://127.0.0.1:8081".to_string()];
        let channel = create_resilient_channel(uris).await;
        assert!(channel.is_ok());
    }
}
```

## Anti-Patterns
1. **Mengabaikan Keep-Alive / Health Checks pada TCP jangka panjang**
   *Mengapa berbahaya:* Proxy Cloud (seperti AWS NAT / ALB) akan memutus (drop) koneksi TCP yang diam (idle) tanpa mengirim paket RST/FIN. Client gRPC (`tonic`) akan terus "mengira" koneksi aktif. Request baru akan tersangkut dan *timeout*! Wajibkan `tcp_keepalive` (dan HTTP/2 Ping jika ada) agar *dead connection* terdeteksi di layer transport (segera putus lalu re-connect otomatis).
2. **Retry Bad Request secara sporadis / Unbounded Retries**
   *Mengapa berbahaya:* Melakukan retry ketika error adalah `InvalidArgument` atau `Unauthenticated` adalah pemborosan resource karena hasilnya akan selalu sama. Lebih fatal, "Thundering Herd" bisa terjadi: Node A ter-overload lambat (error `ResourceExhausted`), direspon client dengan retry brutal (tanpa *exponential backoff* dan *jitter*), yang akhirnya mematikan semua node di cluster (Cascading Failure).

## Edge Cases & Defensive Programming
- **Split Brain pada Service Registry (Etcd / Consul partition):**
  Jika Service Registry mengalami network partition, client mungkin menerima *stale endpoint list* (melihat node yang sudah mati). Client *channel builder* (misal `tower::discover`) harus cukup cerdas untuk menendang (evict) node yang terus menerus timeout dari *local connection pool*, walaupun registry belum menghapusnya secara formal.
- **TLS & Certificate Rotation:**
  Endpoint discovery gRPC sangat rentan di production jika sertifikat TLS *expire*. Jangan hardcode CA Root secara static tanpa mekanisme *hot-reloading*. Gunakan fitur auto-reload sertifikat atau jalankan client di bawah *Service Mesh* (Istio / Linkerd) agar rotasi mTLS ditangani di luar proses Rust (di level sidecar Envoy).
