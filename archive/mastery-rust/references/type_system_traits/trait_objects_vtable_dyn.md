# Trait Objects, vtable, dan `dyn Trait`

## Konsep Utama
Dalam Rust, `dyn Trait` mewakili tipe yang dihapus tipenya (type-erased) yang mengimplementasikan sebuah trait. Ini memungkinkan *Dynamic Dispatch* di mana tipe konkret yang digunakan diputuskan pada saat runtime (berbeda dengan *Static Dispatch* yang diputuskan saat compile-time melalui monomorfisasi). `dyn Trait` selalu direpresentasikan sebagai *fat pointer* (misalnya `&dyn Trait` atau `Box<dyn Trait>`). *Fat pointer* mengandung dua word (ukuran penunjuk ganda): satu penunjuk mengarah ke data aktual objek, dan penunjuk kedua mengarah ke *vtable* (Virtual Method Table) yang berisi penunjuk ke implementasi metode konkret serta informasi tata letak memori (ukuran dan alignment).

**Penggunaan di Proyek Nyata:**
Digunakan luas dalam sistem arsitektur plug-in, UI widget trees, *Dependency Injection/Service Locator*, atau koleksi heterogen di mana kita perlu menyimpan berbagai tipe berbeda yang mengimplementasikan perilaku (trait) yang sama. 

## Arsitektur VTable & Fat Pointer
```text
Fat Pointer (Box<dyn Trait>)      Memori Heap
+-----------------------+         +-----------------------+
| data_ptr  (8 bytes)   |  ---->  | [Field dari struct A] | (Concrete Data)
+-----------------------+         +-----------------------+
| vtable_ptr(8 bytes)   |  --+
+-----------------------+    |
                             |    VTable (statis di memori read-only)
                             +--> +-----------------------+
                                  | size (e.g. 24)        |
                                  +-----------------------+
                                  | align (e.g. 8)        |
                                  +-----------------------+
                                  | drop_in_place()       | (Destructor ptr)
                                  +-----------------------+
                                  | method_1()            | (Function ptr)
                                  +-----------------------+
                                  | method_2()            | (Function ptr)
                                  +-----------------------+
```

## Production-Ready Rust Code

```rust
use std::sync::Arc;

/// Trait untuk layanan pemrosesan notifikasi.
/// Mewajibkan `Send + Sync` secara eksplisit sebagai supertrait untuk 
/// penggunaan aman di dalam lingkungan multithreading.
pub trait NotificationService: Send + Sync {
    fn send(&self, message: &str) -> Result<(), NotificationError>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum NotificationError {
    NetworkFailure,
    InvalidPayload,
}

// ---------------------------------------------------------
// Implementasi Konkret 1: Email
// ---------------------------------------------------------
pub struct EmailService {
    smtp_server: String,
}

impl EmailService {
    pub fn new(server: impl Into<String>) -> Self {
        Self { smtp_server: server.into() }
    }
}

impl NotificationService for EmailService {
    fn send(&self, message: &str) -> Result<(), NotificationError> {
        if message.is_empty() {
            return Err(NotificationError::InvalidPayload);
        }
        // Simulasi pengiriman email
        println!("Sending email via {}: {}", self.smtp_server, message);
        Ok(())
    }
}

// ---------------------------------------------------------
// Implementasi Konkret 2: SMS
// ---------------------------------------------------------
pub struct SmsService {
    phone_number: String,
}

impl SmsService {
    pub fn new(phone: impl Into<String>) -> Self {
        Self { phone_number: phone.into() }
    }
}

impl NotificationService for SmsService {
    fn send(&self, message: &str) -> Result<(), NotificationError> {
        println!("Sending SMS to {}: {}", self.phone_number, message);
        Ok(())
    }
}

// ---------------------------------------------------------
// Dispatcher dengan Koleksi Heterogen (Trait Objects)
// ---------------------------------------------------------
/// Menggunakan `Arc<dyn NotificationService>` karena kita berbagi layanan ini di berbagai thread.
/// Kita menggunakan `Arc` sebagai *fat pointer*.
pub struct NotificationDispatcher {
    // Koleksi heterogen (bisa berisi EmailService, SmsService, dll.)
    services: Vec<Arc<dyn NotificationService>>,
}

impl NotificationDispatcher {
    pub fn new() -> Self {
        Self { services: Vec::new() }
    }

    pub fn register(&mut self, service: Arc<dyn NotificationService>) {
        self.services.push(service);
    }

    pub fn broadcast(&self, message: &str) -> Vec<Result<(), NotificationError>> {
        self.services
            .iter()
            .map(|svc| svc.send(message))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_heterogeneous_dispatch() {
        let mut dispatcher = NotificationDispatcher::new();
        
        let email_svc = Arc::new(EmailService::new("smtp.example.com"));
        let sms_svc = Arc::new(SmsService::new("+123456789"));
        
        dispatcher.register(email_svc);
        dispatcher.register(sms_svc);
        
        let results = dispatcher.broadcast("Alert: System Reboot!");
        
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|res| res.is_ok()));
    }
}
```

## Anti-Patterns Spesifik
1. **"Default to dyn Trait" Anti-Pattern**: Menggunakan `Box<dyn Trait>` di mana-mana karena terbiasa dengan bahasa OOP (seperti Java/C#).
   - *Mengapa berbahaya:* Menambahkan overhead *runtime* (dereference pointer ganda + fungsi *lookup* di vtable) serta menghambat optimisasi *compiler* seperti *inlining*. Gunakan generics (`impl Trait` atau parameter generik `<T: Trait>`) kecuali ketika Anda benar-benar butuh koleksi heterogen.
2. **Lupa `Send + Sync` pada Trait Objects Multithreaded**: Melewatkan bounds `Send + Sync` pada tipe `Box<dyn Trait>` yang dibagikan antarthread.
   - *Mengapa berbahaya:* Jika Anda menggunakan `Box<dyn Trait>` tanpa mengeksplisitkan `Box<dyn Trait + Send + Sync>`, Rust berasumsi tipe itu tidak aman untuk dipindahkan/dibagikan ke thread lain, membatasi fungsionalitas sistem konkuren.

## Edge Cases & Defensive Engineering
- **Object Safety Rules**: Tidak semua trait bisa dijadikan `dyn Trait`. Trait **tidak boleh** memiliki metode yang mengembalikan tipe `Self` (kecuali dengan *receiver* `self` yang dibungkus, seperti `Box<Self>`), dan tidak boleh bergantung pada tipe generik secara intrinsik pada metodenya.
- **Downcasting (Any)**: Kadang-kadang kita butuh mengembalikan trait object ke tipe aslinya. Desain yang baik menghindari hal ini dengan memperbaiki abstraksi, namun jika mutlak perlu, manfaatkan `std::any::Any`.
- **Mencegah Unsized Mismatch**: Ingat bahwa `dyn Trait` bersifat `!Sized`. Jika fungsi generik mengharapkan argumen berukuran tetap, ia tidak akan menerima trait object kecuali bounds diubah menjadi `T: ?Sized`.
