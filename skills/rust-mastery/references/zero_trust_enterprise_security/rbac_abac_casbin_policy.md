# Referensi Mutakhir: Kebijakan Otorisasi Hibrida (RBAC + ABAC) Menggunakan Casbin

## 1. Pendahuluan
Pendekatan Zero Trust menuntut agar setiap subjek yang berusaha mengakses sebuah objek diverifikasi berdasar lebih dari sekadar "role". Atribut dinamis dari subjek, objek, maupun lingkungan (waktu, lokasi IP) harus diperiksa secara *real-time*. Di dalam ekosistem Rust, Casbin (dengan `casbin-rs`) menawarkan mesin otorisasi (*authorization engine*) berforma tinggi yang dapat menangani model kombinasi *Role-Based Access Control* (RBAC) dan *Attribute-Based Access Control* (ABAC) secara elegan tanpa mengubah kode bisnis secara radikal.

## 2. Diagram Arsitektur Otorisasi
Berikut adalah ilustrasi dari sistem otorisasi menggunakan Casbin:

```text
    [ Permintaan Akses Klien ] 
          (Subject, Object, Action, Environment)
                     |
                     v
    +-----------------------------------------------+
    |             Policy Enforcement Point (PEP)    |
    |                                               |
    |  +-----------------------------------------+  |
    |  |  Data Ekstraksi: Role, Atribut Subjek,  |  |
    |  |  Atribut Objek, Kondisi Lingkungan      |  |
    |  +-----------------------------------------+  |
    |                     |                         |
    |                     v                         |
    |  +-----------------------------------------+  |
    |  |  Casbin Enforcer (In-Memory Model &     |  |
    |  |  Policy, Async Adapter if DB Backed)    |  |
    |  +-----------------------------------------+  |
    |                     |                         |
    |         +-----------+-----------+             |
    |         |                       |             |
    |    [ Allow ]                 [ Deny ]         |
    +---------+-----------------------+-------------+
              |                       |
              v                       v
     [ Eksekusi Bisnis ]       [ Log Audit & 403 ]
```

## 3. Implementasi Produksi Idiomatis
Implementasi menggunakan `casbin` dalam mode sinkron atau asinkron (menggunakan tokio) untuk memvalidasi atribut. Model file dikonfigurasi melalui konfigurasi string *inline* untuk memudahkan pengujian.

```rust
use casbin::{CoreApi, DefaultModel, Enforcer, MemoryAdapter, Result};
use std::sync::Arc;
use tokio::sync::RwLock;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthzError {
    #[error("Kesalahan internal pada mesin kebijakan otorisasi")]
    EngineError(String),
    #[error("Akses Ditolak: Role atau atribut tidak memenuhi syarat")]
    AccessDenied,
}

/// Struktur Pembungkus Enforcer untuk Otorisasi Enterprise
pub struct EnterpriseAuthorizer {
    enforcer: Arc<RwLock<Enforcer>>,
}

impl EnterpriseAuthorizer {
    /// Inisialisasi authorizer dengan memuat model hibrida dan adapter memori
    pub async fn new() -> std::result::Result<Self, AuthzError> {
        // Model konfigurasi Casbin untuk kombinasi RBAC dan ABAC
        // r(sub, obj, act) merupakan permintaan yang masuk
        // p(sub_rule, obj, act) merupakan aturan policy 
        // m(match) mengkombinasikan struktur role (g) dengan fungsi eval untuk ABAC
        let model_conf = "
        [request_definition]
        r = sub, obj, act
        
        [policy_definition]
        p = sub_rule, obj, act
        
        [role_definition]
        g = _, _
        
        [policy_effect]
        e = some(where (p.eft == allow))
        
        [matchers]
        m = g(r.sub.role, p.sub_rule) && r.obj == p.obj && r.act == p.act && eval(p.sub_rule)
        ";

        let model = DefaultModel::from_str(model_conf)
            .await
            .map_err(|e| AuthzError::EngineError(e.to_string()))?;

        let adapter = MemoryAdapter::default();
        let mut enforcer = Enforcer::new(model, adapter).await
            .map_err(|e| AuthzError::EngineError(e.to_string()))?;

        // Menambahkan rules dasar secara programatis
        // Format: RuleName, Object, Action
        enforcer.add_policy(vec!["admin_rule".to_string(), "data1".to_string(), "read".to_string()]).await.unwrap();
        enforcer.add_policy(vec!["user_rule".to_string(), "data2".to_string(), "write".to_string()]).await.unwrap();
        
        // Membangun relasi role
        enforcer.add_grouping_policy(vec!["alice".to_string(), "admin".to_string()]).await.unwrap();
        enforcer.add_grouping_policy(vec!["bob".to_string(), "user".to_string()]).await.unwrap();

        Ok(Self {
            enforcer: Arc::new(RwLock::new(enforcer)),
        })
    }

    /// Mengecek apakah akses diizinkan
    pub async fn enforce_access(&self, subject_role: &str, object: &str, action: &str) -> std::result::Result<(), AuthzError> {
        let mut enforcer = self.enforcer.write().await;
        
        // Pada implementasi ABAC nyata, parameter sub bisa berupa struktur dinamis JSON.
        // Di sini disederhanakan dengan memasukkan string identitas.
        let is_allowed = enforcer.enforce((subject_role, object, action))
            .map_err(|e| AuthzError::EngineError(e.to_string()))?;

        if is_allowed {
            Ok(())
        } else {
            Err(AuthzError::AccessDenied)
        }
    }
}
```

## 4. Pengujian (Unit & Integration Tests)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_rbac_admin_access_allowed() {
        let authz = EnterpriseAuthorizer::new().await.unwrap();
        
        // Alice memiliki peran 'admin' yang dapat membaca 'data1'
        let result = authz.enforce_access("alice", "data1", "read").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_rbac_user_access_denied() {
        let authz = EnterpriseAuthorizer::new().await.unwrap();
        
        // Bob memiliki peran 'user' dan tidak bisa membaca 'data1'
        let result = authz.enforce_access("bob", "data1", "read").await;
        assert!(matches!(result, Err(AuthzError::AccessDenied)));
    }
    
    #[tokio::test]
    async fn test_rbac_user_access_allowed() {
        let authz = EnterpriseAuthorizer::new().await.unwrap();
        
        // Bob memiliki peran 'user' dan bisa menulis ke 'data2'
        let result = authz.enforce_access("bob", "data2", "write").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_unknown_user_denied() {
        let authz = EnterpriseAuthorizer::new().await.unwrap();
        
        // Eve tidak memiliki kebijakan apa pun
        let result = authz.enforce_access("eve", "data1", "read").await;
        assert!(matches!(result, Err(AuthzError::AccessDenied)));
    }
}
```

## 5. Anti-Patterns Kritis

1. **Pembuatan Instance Enforcer di Setiap Request**
   *Penjelasan:* Menginisialisasi `Enforcer::new()` dari awal untuk setiap panggilan API adalah bencana performa. Fungsi ini memuat seluruh model, menyusun AST (Abstract Syntax Tree), dan menata graf *role*. Jika dipanggil per-*request*, latensi API akan melesat eksponensial.
   *Solusi:* Letakkan `Enforcer` di dalam `Arc<RwLock<Enforcer>>` pada level _application state_ (seperti ekstensi data pada platform Axum atau Actix) agar di-_share_ lintas koneksi.

2. **Pengabaian Manajemen Kegagalan Koneksi Adapter (Database Silently Fails)**
   *Penjelasan:* Menggunakan adapter basis data (seperti `sqlx-adapter` atau `diesel-adapter`) tanpa menangani skenario saat basis data luring (*offline*). Jika basis data *down*, *enforce* mungkin memblokir thread atau menghasilkan "Deny" palsu yang membingungkan (*false negative*).
   *Solusi:* Tangani *Error Handling* secara eksplisit dengan mendefinisikan *graceful degradation* atau mekanisme *cache-fallback* sementara saat DB utama lumpuh.

## 6. Production Edge Cases

1. **Perubahan Kebijakan Massal Saat Beban Tinggi (Hot-Reloading Policy)**
   *Penjelasan:* Ketika ratusan admin mengubah *policy* di waktu bersamaan, Casbin harus me-*reload* kebijakan secara internal. Jika menggunakan `RwLock`, penulisan besar-besaran (Write-lock) dapat memblokir operasi pembacaan (Read-lock), menyebabkan waktu tunggu (*timeout*) pada pengguna valid.
   *Penanganan:* Gunakan *asynchronous channel* untuk men-de-bounce pembaruan *policy*, atau modelkan *double-buffering* sehingga penggantian kebijakan di dalam memori terjadi seketika secara atomik tanpa memblokir pembaca.

2. **Atribut ABAC dengan Evaluasi Eksekusi Lambat (Slow Eval Matching)**
   *Penjelasan:* Jika fungsi `eval()` untuk pengecekan ABAC terlalu kompleks (misalnya memerlukan pengecekan Regex atau panggilan REST API sekunder di dalam *matcher*), performa evaluasi otorisasi akan runtuh secara sistemik.
   *Penanganan:* Hitung evaluasi variabel yang mahal (seperti geolokasi atau resolusi keanggotaan departemen eksternal) sebelum memanggil `.enforce()`, lalu lemparkan hasil *boolean* / kalkulasi bersih ke dalam parameter *subject* Casbin.

3. **Perputaran Identitas (*Identity Rollover*) dan Sisa Hirarki Peran (Stale Graph)**
   *Penjelasan:* Ketika seorang karyawan dipindahkan ke divisi lain, penghapusan peran (*role deletion*) lama harus sinkron sempurna di dalam model RBAC hibrida. Kegagalan melepaskan peran "Admin Sistem" lama dapat memberikan izin eksesif pada pekerjaan barunya (*over-privileged*).
   *Penanganan:* Mengaitkan penghapusan kebijakan langsung dengan layanan sentral Direktori Perusahaan (misal LDAP/AD) yang bereaksi atas event terpusat (Webhook/Kafka Queue) secara *exactly-once* yang dijamin.
