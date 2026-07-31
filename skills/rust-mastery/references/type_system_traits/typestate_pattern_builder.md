# Typestate Pattern & Type-Safe Builders

## Konsep Utama
Typestate Pattern adalah teknik menggunakan tipe pada kompilasi (tipe statis Rust) untuk mengatur atau menegakkan logika state-machine pada sistem Anda. Ini memungkinkan API mendeteksi transisi tidak valid, metode yang dipanggil di luar urutan, atau atribut yang belum terisi di *compile time* daripada melempar error di runtime.
Dipadukan dengan *Builder Pattern* dan tipe `PhantomData`, ini dapat memastikan Anda tidak akan bisa melakukan operasi tertentu kecuali objek berada pada _state_ atau tipe yang benar.

**Penggunaan di Proyek Nyata:**
Membangun Driver Perangkat Keras Embedded (Hardware Abstraction Layers), Protokol Jaringan (seperti TCP state machine), Enkripsi dan Kriptografi Kunci (seperti transisi dari key initialization ke ready state), dan API Client kompleks.

## Arsitektur State Machine via Types
```text
 [State: NoEmail] ----(set_email)----> [State: HasEmail]
                                             |
                                        (set_body)
                                             |
                                             v
 [Build Error] <---------------- [State: HasEmailAndBody]
 (Cannot build                       | (build)
  if missing states)                 v
                               [Request Struct Ready]
```

## Production-Ready Rust Code

```rust
use std::marker::PhantomData;

// ---------------------------------------------------------
// Typestates - Sealed Type Definitions
// ---------------------------------------------------------
pub struct MissingEmail;
pub struct EmailSet;
pub struct MissingBody;
pub struct BodySet;

/// Modul ini menggunakan Sealed Trait untuk mencegah state dari luar
/// mengimplementasikan marker state yang tidak valid.
mod private {
    pub trait Sealed {}
    impl Sealed for super::MissingEmail {}
    impl Sealed for super::EmailSet {}
    impl Sealed for super::MissingBody {}
    impl Sealed for super::BodySet {}
}

pub trait EmailState: private::Sealed {}
impl EmailState for MissingEmail {}
impl EmailState for EmailSet {}

pub trait BodyState: private::Sealed {}
impl BodyState for MissingBody {}
impl BodyState for BodySet {}

// ---------------------------------------------------------
// Struct Utama dengan State (Typestate via PhantomData)
// ---------------------------------------------------------
#[derive(Debug, PartialEq, Eq)]
pub struct EmailRequest {
    email: String,
    body: String,
}

pub struct EmailRequestBuilder<E, B> {
    email: Option<String>,
    body: Option<String>,
    // PhantomData membiarkan struct bergantung pada parameter generik 
    // tanpa memiliki variabel fisik yang memakan memori di saat runtime.
    _marker_email: PhantomData<E>,
    _marker_body: PhantomData<B>,
}

// Implementasi Awal
impl EmailRequestBuilder<MissingEmail, MissingBody> {
    pub fn new() -> Self {
        Self {
            email: None,
            body: None,
            _marker_email: PhantomData,
            _marker_body: PhantomData,
        }
    }
}

// Transisi State: Set Email
impl<B> EmailRequestBuilder<MissingEmail, B> {
    pub fn email(self, email: impl Into<String>) -> EmailRequestBuilder<EmailSet, B> {
        EmailRequestBuilder {
            email: Some(email.into()),
            body: self.body,
            _marker_email: PhantomData,
            _marker_body: PhantomData,
        }
    }
}

// Transisi State: Set Body
impl<E> EmailRequestBuilder<E, MissingBody> {
    pub fn body(self, body: impl Into<String>) -> EmailRequestBuilder<E, BodySet> {
        EmailRequestBuilder {
            email: self.email,
            body: Some(body.into()),
            _marker_email: PhantomData,
            _marker_body: PhantomData,
        }
    }
}

// Final Build: HANYA tersedia jika EmailSet DAN BodySet!
impl EmailRequestBuilder<EmailSet, BodySet> {
    pub fn build(self) -> EmailRequest {
        EmailRequest {
            // Karena type state memastikan field sudah di-set, 
            // `unwrap()` dijamin 100% aman (Zero-cost safety).
            email: self.email.unwrap(),
            body: self.body.unwrap(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_builder_transitions() {
        let request = EmailRequestBuilder::new()
            .email("admin@server.local")
            .body("System alert!")
            .build();
            
        assert_eq!(request.email, "admin@server.local");
        
        // Kode ini tidak akan bisa dikompilasi jika kita tidak memanggil `email` / `body`:
        // let fail = EmailRequestBuilder::new().build(); // ERROR: Method not found for Typestate
    }
}
```

## Anti-Patterns Spesifik
1. **Bool Flag Soup**: Menggunakan berbagai field bool di dalam struct untuk melacak state (misalnya `is_initialized`, `has_connected`, `is_authenticated`) lalu mengeceknya saat memanggil metode, dan merespons `Result::Err`.
   - *Mengapa berbahaya:* Mengalihkan *error discovery* dari *compile-time* ke *runtime*. Ini menciptakan kemungkinan program crash/membuang error di production jika urutan pemanggilan salah, sesuatu yang harusnya bisa dicegah secara statis oleh kompiler.
2. **Tidak Me-*Seal* Marker Types**: Membiarkan state struct (`MissingEmail`, dll.) tanpa *sealed trait bounds*.
   - *Mengapa berbahaya:* User luar dapat membuat implementasi custom mereka dan mem-*bypass* logika flow state API Anda, sehingga menghancurkan invariansi dan keamanan internal library.

## Edge Cases & Defensive Engineering
- **Variansi PhantomData (`PhantomData<T>`)**: Berhati-hati dengan kepemilikan. `PhantomData<T>` secara teknis bertindak seolah struct *memiliki* (owns) tipe `T`. Jika state berisi tipe lifetime (`PhantomData<&'a T>`), ini mengubah variansi drop dari objek (bisa memicu *dropck* - drop checker errors). Untuk pure typestate state-machine, marker Kosong (unit-like structs) adalah yang terbaik dan bebas dari efek komplikasi drop bounds.
- **Ukuran dan Move Semantics**: Typestate diimplementasikan dengan `self` transfer (move semantics). Jangan pernah gunakan mutable reference `&mut self` sebagai transition signature untuk tipe yang merubah generics (`fn transform(&mut self) -> Type<NewState>`); karena Rust tidak bisa merubah tipe sebuah referensi *in-place*.
