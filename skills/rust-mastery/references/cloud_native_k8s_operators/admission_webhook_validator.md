# Enterprise Rust: Validating & Mutating Admission Webhook Servers Berkinerja Tinggi

Dalam arsitektur Cloud-Native, Kubernetes Admission Webhooks (Validating & Mutating) bertindak sebagai penjaga gerbang (gatekeeper) yang sangat kritis. Setiap permintaan pembuatan atau pembaruan sumber daya (seperti Pod) akan dievaluasi oleh webhook ini sebelum direkam di etcd. 

Menggunakan **Rust (Axum + kube-rs)** untuk webhook memberikan keunggulan performa latensi sangat rendah (sub-milidetik), konsumsi memori minimal (sangat penting karena webhook berjalan di *critical path* penjadwalan Kubernetes), dan keamanan memori yang dijamin oleh *borrow checker*.

---

## Arsitektur Admission Webhook

```text
+-----------------------+          +-------------------------------------------------+
|   Kubernetes API      |          |       Rust Admission Webhook Server (Axum)      |
|   Server              |          |                                                 |
|                       |   TLS    |  +-----------+    +--------------------------+  |
|  [Admission Control]  | <=====>  |  | TLS (rustls)|->|   Axum HTTPS Router      |  |
|          |            | (Port    |  +-----------+    +--------------------------+  |
|  MutatingWebhook      |  8443)   |                             |                   |
|  ValidatingWebhook    |          |                 +--------------------------+    |
+----------+------------+          |                 | /mutate | /validate      |    |
           |                       |                 +----+-----------+---------+    |
           |                       |                      |           |              |
     Pod Creation Request          |               +------v------+ +--v-----------+  |
     (JSON / REST)                 |               |  Mutator    | | Validator    |  |
                                   |               | (JSON Patch)| | (Allow/Deny) |  |
                                   |               +-------------+ +--------------+  |
                                   +-------------------------------------------------+
```

---

## Implementasi Kode Produksi Lengkap

Implementasi di bawah ini menggunakan `axum`, `kube-rs`, dan `json-patch` untuk mengelola webhook. Webhook ini akan:
1. **Mutating**: Menyuntikkan label standar dan *SecurityContext* default (misalnya `runAsNonRoot: true`).
2. **Validating**: Menolak Pod yang mencoba berjalan sebagai `privileged: true` atau menggunakan namespace terlarang.

```rust
use axum::{
    extract::Json,
    routing::post,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use json_patch::{PatchOperation, AddOperation};
use k8s_openapi::api::core::v1::Pod;
use kube::core::admission::{AdmissionRequest, AdmissionResponse, AdmissionReview};
use serde_json::json;
use std::net::SocketAddr;
use tracing::{error, info, warn};

/// Konfigurasi utama untuk Webhook Server
#[derive(Clone)]
pub struct WebhookConfig {
    pub require_non_root: bool,
    pub restricted_namespaces: Vec<String>,
}

/// Handler untuk Mutating Webhook
/// Bertugas memodifikasi payload Pod (misalnya menyuntikkan label atau security context).
pub async fn mutate_handler(
    Json(body): Json<AdmissionReview<Pod>>,
) -> Json<AdmissionReview<Pod>> {
    let req: AdmissionRequest<Pod> = match body.try_into() {
        Ok(req) => req,
        Err(e) => {
            error!("Gagal membaca AdmissionRequest: {}", e);
            return Json(AdmissionResponse::invalid(e.to_string()).into_review());
        }
    };

    let mut res = AdmissionResponse::from(&req);

    if let Some(pod) = &req.object {
        let mut patches = Vec::new();

        // Menyuntikkan label mutasi wajib
        let label_path = "/metadata/labels/mutated-by";
        patches.push(PatchOperation::Add(AddOperation {
            path: label_path.to_string(),
            value: json!("rust-admission-webhook"),
        }));

        // Menambahkan security context pada level pod jika belum ada
        if pod.spec.as_ref().and_then(|s| s.security_context.as_ref()).is_none() {
            patches.push(PatchOperation::Add(AddOperation {
                path: "/spec/securityContext".to_string(),
                value: json!({
                    "runAsNonRoot": true,
                    "seccompProfile": {
                        "type": "RuntimeDefault"
                    }
                }),
            }));
        }

        // Menerapkan JSON patch ke AdmissionResponse
        if !patches.is_empty() {
            res = res.with_patch(json_patch::Patch(patches)).unwrap_or_else(|e| {
                error!("Gagal membuat patch: {}", e);
                AdmissionResponse::from(&req).deny(format!("Internal patch error: {}", e))
            });
        }
    }

    info!("Mutasi berhasil untuk request UID: {}", req.uid);
    Json(res.into_review())
}

/// Handler untuk Validating Webhook
/// Bertugas menyetujui atau menolak request berdasarkan kebijakan keamanan.
pub async fn validate_handler(
    axum::extract::State(config): axum::extract::State<WebhookConfig>,
    Json(body): Json<AdmissionReview<Pod>>,
) -> Json<AdmissionReview<Pod>> {
    let req: AdmissionRequest<Pod> = match body.try_into() {
        Ok(req) => req,
        Err(e) => {
            error!("Gagal membaca AdmissionRequest: {}", e);
            return Json(AdmissionResponse::invalid(e.to_string()).into_review());
        }
    };

    let mut res = AdmissionResponse::from(&req);

    // Cek Namespace Terlarang
    if let Some(ns) = &req.namespace {
        if config.restricted_namespaces.contains(ns) {
            warn!("Penolakan karena namespace terlarang: {}", ns);
            res = res.deny(format!("Deployment ke namespace '{}' dilarang secara organisasi.", ns));
            return Json(res.into_review());
        }
    }

    // Validasi Privilege Containers
    if let Some(pod) = &req.object {
        if let Some(spec) = &pod.spec {
            let has_privileged = spec.containers.iter().any(|c| {
                c.security_context
                    .as_ref()
                    .and_then(|sc| sc.privileged)
                    .unwrap_or(false)
            });

            if has_privileged {
                warn!("Penolakan privileged container pada pod: {:?}", pod.metadata.name);
                res = res.deny("Pembuatan Privileged container dilarang berdasarkan Security Policy.".to_string());
                return Json(res.into_review());
            }

            // Validasi Root User jika konfigurasi mengharuskan non-root
            if config.require_non_root {
                let is_root = spec.security_context.as_ref()
                    .and_then(|sc| sc.run_as_non_root)
                    .unwrap_or(false) == false; // Jika secara eksplisit false atau tidak diatur, dan container image bisa jadi root
                
                // Ini hanyalah simplifikasi validasi; dalam praktiknya butuh inspeksi mendalam ke tiap container
                if is_root {
                    res = res.deny("Semua pod wajib berjalan sebagai non-root (runAsNonRoot: true).".to_string());
                    return Json(res.into_review());
                }
            }
        }
    }

    info!("Validasi berhasil (Diterima) untuk request UID: {}", req.uid);
    Json(res.into_review())
}

/// Titik masuk aplikasi: Menyiapkan router dan TLS
pub async fn start_webhook_server() -> Result<(), Box<dyn std::error::Error>> {
    let config = WebhookConfig {
        require_non_root: true,
        restricted_namespaces: vec!["kube-system".to_string(), "default".to_string()],
    };

    let app = Router::new()
        .route("/mutate", post(mutate_handler))
        .route("/validate", post(validate_handler))
        .with_state(config);

    let addr = SocketAddr::from(([0, 0, 0, 0], 8443));
    
    // Kubernetes API server mewajibkan webhook menggunakan HTTPS/TLS
    let tls_config = RustlsConfig::from_pem_file(
        "/etc/webhook/certs/tls.crt",
        "/etc/webhook/certs/tls.key",
    )
    .await?;

    info!("Memulai Admission Webhook pada {}", addr);
    
    axum_server::bind_rustls(addr, tls_config)
        .serve(app.into_make_service())
        .await?;

    Ok(())
}
```

---

## Pengujian Terintegrasi (Unit & Integration Tests)

Pengujian Webhook harus meniru payload `AdmissionReview` dari Kubernetes API Server secara presisi.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Container, PodSpec};
    use kube::core::ObjectMeta;
    
    fn mock_pod_review(privileged: bool, namespace: &str) -> AdmissionReview<Pod> {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("test-pod".to_string()),
                namespace: Some(namespace.to_string()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "app".to_string(),
                    security_context: Some(k8s_openapi::api::core::v1::SecurityContext {
                        privileged: Some(privileged),
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };

        let req = AdmissionRequest {
            uid: "mock-uid-1234".to_string(),
            kind: kube::core::admission::GroupVersionKind { group: "".into(), version: "v1".into(), kind: "Pod".into() },
            resource: kube::core::admission::GroupVersionResource { group: "".into(), version: "v1".into(), resource: "pods".into() },
            sub_resource: None,
            request_kind: None,
            request_resource: None,
            request_sub_resource: None,
            name: Some("test-pod".to_string()),
            namespace: Some(namespace.to_string()),
            operation: kube::core::admission::Operation::Create,
            user_info: kube::core::admission::UserInfo { username: None, uid: None, groups: None, extra: None },
            object: Some(pod),
            old_object: None,
            dry_run: false,
            options: None,
        };

        AdmissionResponse::from(&req).into_review()
    }

    #[tokio::test]
    async fn test_validate_handler_denies_privileged() {
        let config = WebhookConfig {
            require_non_root: false,
            restricted_namespaces: vec![],
        };

        let review = mock_pod_review(true, "app-namespace");
        let response_json = validate_handler(axum::extract::State(config), Json(review)).await;
        
        let response_review: AdmissionReview<Pod> = response_json.0;
        let admission_response = response_review.response.unwrap();
        
        assert_eq!(admission_response.allowed, false);
        assert!(admission_response.result.unwrap().message.unwrap().contains("Pembuatan Privileged container dilarang"));
    }

    #[tokio::test]
    async fn test_validate_handler_denies_restricted_namespace() {
        let config = WebhookConfig {
            require_non_root: false,
            restricted_namespaces: vec!["kube-system".to_string()],
        };

        let review = mock_pod_review(false, "kube-system");
        let response_json = validate_handler(axum::extract::State(config), Json(review)).await;
        
        let response_review: AdmissionReview<Pod> = response_json.0;
        let admission_response = response_review.response.unwrap();
        
        assert_eq!(admission_response.allowed, false);
        assert!(admission_response.result.unwrap().message.unwrap().contains("dilarang secara organisasi"));
    }
}
```

---

## 🛑 Anti-Patterns Kritis & ✅ Best Practices

| Anti-Pattern ❌ | Best Practice ✅ | Penjelasan Teknis |
|-----------------|------------------|-------------------|
| **Blocking Network Calls** | **Pure In-Memory Logic** | Admission Webhook berada di jalur kritis pembuatan resource Kubernetes. Melakukan *external HTTP calls* atau query Database di dalam handler webhook akan memblokir Pod creation dan bisa menyebabkan *control-plane timeout* (standar K8s timeout adalah 10-30 detik). Semuanya harus di-_cache_ di memory. |
| **Silent Failures** | **Fail-Closed vs Fail-Open** | Jangan kembalikan HTTP 500 saat validasi error secara internal. Kubernetes akan melihatnya sebagai kegagalan webhook. Tangani `Result::Err` dengan `AdmissionResponse::deny()` atau log *warning* dan ijinkan (`allow()`) tergantung pada mode FailurePolicy `Ignore` vs `Fail` di `ValidatingWebhookConfiguration`. |

---

## ⚡ Production Edge Cases & Solusinya

1. **JSON Patch Ordinality & Nil Pointers (Mutating Edge Case)**:
   Saat menggunakan JSON patch untuk menambahkan elemen (misalnya `volumeMounts`), elemen parent-nya (`spec.containers[0].volumeMounts`) mungkin belum ada (bernilai null/None).
   *Solusi*: Webhook wajib memeriksa keberadaan *parent array/object* terlebih dahulu. Jika `None`, suntikkan inisialisasi *array/object* kosong menggunakan patch terpisah atau buat patch yang mendefinisikan array sepenuhnya.
   
2. **Kube-API Server Timeout vs Webhook Timeout**:
   API Server memiliki timeout default untuk pemanggilan webhook. Jika Rust server mengalami lonjakan traffic tinggi dan *thread pool* Axum habis (meskipun jarang berkat performa `tokio`), API Server akan *timeout*.
   *Solusi*: Gunakan rate limiting (misal menggunakan middleware `tower::limit::ConcurrencyLimit`) di tingkat Axum untuk memberikan respon 429 *Too Many Requests* dengan cepat, ketimbang membuat K8s API server menunggu hingga *timeout*.

3. **Dry-Run Re-entrancy & Idempotency**:
   User mungkin menjalankan perintah `kubectl apply --dry-run=server`. API Server akan memanggil webhook dengan flag `dry_run: true`.
   *Solusi*: Webhook mutasi **wajib idempoten** dan tidak boleh menyimpan status eksternal (state mutations pada database/cache luar) hanya karena webhook dipanggil. Selalu gunakan nilai-nilai konstan, dan selalu pastikan mutasi bersyarat.
