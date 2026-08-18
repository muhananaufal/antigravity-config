# Mockall: Integrasi Mocking untuk Trait dan API Eksternal

## Deskripsi dan Konsep Utama
Dalam sistem terdistribusi, pengujian *business logic* yang terikat dengan entitas eksternal (Database, S3, gRPC service) sangat lambat jika harus memanggil entitas sungguhan. `mockall` adalah *crate* untuk mendefinisikan *mock objects* di Rust secara otomatis, memanfaatkan procedural macros. Kita dapat mengatur ekspektasi ketat (`expect_foo().times(1).returning(...)`) untuk memastikan *trait behavior* (seperti jumlah panggilan, input spesifik, dan output) ditaati oleh *System Under Test* (SUT).

## Arsitektur & Flow (ASCII Diagram)
```text
 +----------------+      (trait Dependency)     +-----------------+
 | Business Logic | --------------------------> | Actual Database | (Prod)
 +----------------+                             +-----------------+
        |
    (test env)
        |
        v
 +----------------+                             +-----------------+
 | Business Logic | --- (calls method) -------> | MockDatabase    | (Test)
 +----------------+                             +-----------------+
                                                       |
                                               [Check Expectations]
                                         (e.g., fetch_user called 1 time?)
```

## Implementasi Produksi (Rust)
```rust
use async_trait::async_trait;
use mockall::{automock, predicate::*};
use std::sync::Arc;

// Entity target
#[derive(Debug, PartialEq, Clone)]
pub struct User {
    pub id: u32,
    pub name: String,
}

// Definisikan Behavior (Trait)
// #[automock] secara ajaib akan men-generate struct MockUserRepository
#[automock]
#[async_trait]
pub trait UserRepository: Send + Sync {
    async fn fetch_user(&self, user_id: u32) -> Result<User, String>;
    async fn delete_user(&self, user_id: u32) -> Result<(), String>;
}

// System Under Test (SUT): Business logic kita
pub struct UserService {
    repo: Arc<dyn UserRepository>,
}

impl UserService {
    pub fn new(repo: Arc<dyn UserRepository>) -> Self {
        Self { repo }
    }

    pub async fn remove_user_safely(&self, user_id: u32) -> Result<String, String> {
        let user = self.repo.fetch_user(user_id).await?;
        
        if user.name == "admin" {
            return Err("Cannot delete admin".to_string());
        }

        self.repo.delete_user(user_id).await?;
        Ok(format!("Deleted {}", user.name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_delete_normal_user_success() {
        // Inisiasi mock
        let mut mock_repo = MockUserRepository::new();

        // Tetapkan ekspektasi pertama: fetch_user
        mock_repo
            .expect_fetch_user()
            .with(eq(42))
            .times(1)
            .returning(|id| Ok(User { id, name: "johndoe".to_string() }));

        // Tetapkan ekspektasi kedua: delete_user
        mock_repo
            .expect_delete_user()
            .with(eq(42))
            .times(1)
            .returning(|_| Ok(()));

        let service = UserService::new(Arc::new(mock_repo));
        
        let result = service.remove_user_safely(42).await;
        assert_eq!(result.unwrap(), "Deleted johndoe");
    }

    #[tokio::test]
    async fn test_cannot_delete_admin() {
        let mut mock_repo = MockUserRepository::new();

        mock_repo
            .expect_fetch_user()
            .with(eq(1))
            .times(1)
            .returning(|id| Ok(User { id, name: "admin".to_string() }));

        // delete_user TIDAK boleh dipanggil (times = 0, secara implisit)
        // Jika delete_user dipanggil, test ini akan panic (failed).
        mock_repo
            .expect_delete_user()
            .times(0);

        let service = UserService::new(Arc::new(mock_repo));
        let result = service.remove_user_safely(1).await;
        
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Cannot delete admin");
    }
}
```

## Anti-Patterns

1. **Over-Mocking (Mocking segalanya)**: Menggunakan `mockall` untuk fungsi matematika sederhana atau struct *in-memory* yang tidak memiliki I/O network atau I/O disk.
   *Mengapa berbahaya*: Test akan menjadi *brittle* (rapuh). Ketika detail internal / refaktor logika berubah sedikit, seluruh konfigurasi *mock expectations* harus diubah ulang, meskipun output *business logic* sebenarnya tidak salah. Test yang bagus menguji behavior (*black box*), bukan internal *call chain*.
2. **Missing `times(1)` Expectations**: Menulis mock handler tanpa mendefinisikan *berapa kali* fungsi tersebut ekspek dipanggil.
   *Mengapa berbahaya*: Tanpa `.times(1)`, jika logika aplikasi memanggil API pengiriman Email 10 kali (karena bug perulangan), mock akan terus mengembalikan *Ok* dan test *pass*, padahal ada *severe bug* yang berdampak pada produksi.

## Edge Cases & Defensive Programming

1. **Send + Sync Bounds dengan Mockall**: Ketika *mocked trait* akan dimasukkan ke `Arc<dyn Trait>` yang dibagikan melintasi `tokio::spawn`, trait aslinya *wajib* meminta trait bounds `Send + Sync`. Jika tidak, compiler akan protes keras terhadap *Arc bounding* dan *Mock struct* generasinya.
2. **Returning References atau Lifetimes yang Kompleks**: Mengembalikan referensi (`&str`) atau variabel dengan lifetimes kompleks dari *mock object*. `mockall` cukup kesulitan melakukan *lifetime tracing* untuk hasil yang dimiliki oleh *mock struct*. Lebih baik men-*clone* data saat *mocking*, atau refactor arsitektur aplikasi agar menerima kepemilikan (ownership).
3. **Async Method Mocking**: `mockall` dan `async_trait` bisa konflik pada spesifikasi tipe `BoxFuture` yang dihasilkan oleh proc-macro. Biasanya tidak ada masalah sejak `mockall` v0.11+, namun perhatikan error mutabilitas: closure pada `.returning()` seringkali dimutasi oleh multiple threads async (sehingga butuh *Clone* atau state dienkapsulasi dengan *Mutex* di dalam mock, jika *stateful returning* dibutuhkan).
