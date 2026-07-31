# Mocking Integrasi dengan `mockall`

## 1. Konsep Utama & Kapan Digunakan
Dalam Rust, mocking jauh lebih ketat karena *static typing* dan *trait boundaries*. `mockall` adalah library paling populer di ekosistem Rust untuk membuat mock implementation dari sebuah Trait secara otomatis menggunakan macro. 

Gunakan `mockall` ketika:
- Anda ingin melakukan Unit Testing secara terisolasi tanpa menyentuh dependensi I/O asli (Database, Network, Filesystem).
- Kode Anda dirancang menggunakan arsitektur Trait (dependency inversion), misalnya fungsi Anda menerima `&dyn Repository` atau argumen generic `<T: Repository>`.

## 2. Arsitektur / Flow

```ascii
[ Business Logic ] ---> calls `fetch_user()` ---> (Trait: UserRepository)
        |
        +---> (Production)  ---> [ SqlxUserRepository ] -> (Database)
        |
        +---> (Unit Test)   ---> [ MockUserRepository ] -> (Returns predefined values)
```

## 3. Kode Rust Production-Ready

```rust
use async_trait::async_trait;
#[cfg(test)]
use mockall::{automock, predicate::*};

/// 1. Definisikan Trait untuk komponen yang akan di-mock.
/// #[automock] akan men-generate struct `MockPaymentGateway` di mode testing.
#[cfg_attr(test, automock)]
#[async_trait]
pub trait PaymentGateway {
    async fn charge_card(&self, amount: u64, token: &str) -> Result<String, String>;
    fn is_online(&self) -> bool;
}

/// 2. Komponen Domain / Bisnis Logic yang menerima dependensi.
pub struct CheckoutService<P: PaymentGateway> {
    pub gateway: P,
}

impl<P: PaymentGateway> CheckoutService<P> {
    pub async fn process_order(&self, total: u64, token: &str) -> Result<String, String> {
        if !self.gateway.is_online() {
            return Err("Gateway offline".to_string());
        }

        self.gateway.charge_card(total, token).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_checkout_success() {
        // 3. Inisialisasi struct Mock yang di-generate
        let mut mock_gw = MockPaymentGateway::new();

        // 4. Atur ekspektasi (Expectations)
        
        // Ekspektasi 1: is_online dipanggil persis 1 kali, mengembalikan true.
        mock_gw.expect_is_online()
            .times(1)
            .return_const(true);

        // Ekspektasi 2: charge_card dipanggil dengan parameter tertentu
        mock_gw.expect_charge_card()
            .with(eq(5000), eq("tok_123")) // Predicate matching
            .times(1)
            .returning(|_, _| Ok("txn_999".to_string())); // Returning mengizinkan logic dinamis closure

        let service = CheckoutService { gateway: mock_gw };
        
        let result = service.process_order(5000, "tok_123").await;
        
        assert_eq!(result, Ok("txn_999".to_string()));
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Mocking tipe konkrit alih-alih Trait (walau diizinkan via `mock!`).**
   - *Bahaya*: Membatasi fleksibilitas desain dan membuat refactoring sulit. Meng-mock struct eksternal (seperti `reqwest::Client`) sangat rapuh.
   - *Solusi*: Buat Trait wrapper perantara di domain Anda dan mock Trait perantara tersebut.
2. **Tidak membatasi `.times()` pada ekspektasi mock.**
   - *Bahaya*: Jika kode implementasi memiliki bug infinite loop yang memanggil mock fungsi, test tetap lolos atau hang.
   - *Solusi*: Selalu gunakan `.times(n)` atau `.at_least(1)` untuk memvalidasi interaksi secara ketat.

## 5. Edge Cases & Defensive Programming
- **Reference Parameters**: Jika parameter trait berupa reference (contoh `&Struct`), mockall mewajibkan predicate pencocokan nilai.
- **Multithreading / Cloning**: Terkadang Anda perlu meng-clone dependensi ke thread/task lain. `Mock` objects by default tidak mengimplementasikan `Clone`. Anda harus mengatur arsitekturnya, misal membungkus mock dalam `Arc`, atau membuat closure yang menginisiasi mock baru.
- **Urutan Panggilan (Sequence)**: Gunakan `mockall::Sequence` jika urutan pemanggilan `gateway.is_online()` HARUS mendahului `gateway.charge_card()`. Kegagalan mematuhi sequence akan langsung panic di testing.
