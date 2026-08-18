# Sealed Traits & API Stability

## Konsep Utama
Sealed Trait Pattern adalah arsitektur untuk membatasi sebuah public Trait (yang terekspos oleh library/crate Anda) agar **tidak bisa diimplementasikan** oleh pihak ketiga (downstream users). Ini menjaga fleksibilitas pengembangan (API Stability/SemVer) sehingga di versi mendatang Anda bebas menambahkan tipe atau fungsi asosiasi tambahan ke dalam Trait tanpa khawatir akan merusak/patah kode pengguna. 
`#[non_exhaustive]` adalah pola saudaranya untuk struct/enum, mencegah kode pengguna menginisialisasi dengan konstruktor literal eksplisit atau mencocokkannya (*pattern matching*) tanpa pola fallback `_`.

**Penggunaan di Proyek Nyata:**
Digunakan di seluruh standard library (`std::error::Error`, `std::slice::SliceIndex`) dan ekosistem Rust stabil (seperti `reqwest`, `serde`, `tower`) di mana antarmuka publik perlu dipakai oleh user untuk input generic API, namun tidak pantas/berbahaya jika direkayasa/diimplementasikan custom oleh user sendiri.

## Arsitektur Modul "Sealing"
```text
Crate / Library kita:
+-------------------------------------------------+
| pub trait ApiTransport: private::Sealed { ... } | <- Publik, bisa dipanggil!
|                                                 |
| mod private {                                   | <- Privat, tak terlihat user!
|    pub trait Sealed {}                          |
|    impl Sealed for super::Http {}               |
| }                                               |
+-------------------------------------------------+
                      |
Downstream User (Crate lain):
  impl ApiTransport for UserCustomTransport  <---- [COMPILE ERROR]
  (Karena `private::Sealed` tidak dapat diakses untuk dipenuhi!)
```

## Production-Ready Rust Code

```rust
// ---------------------------------------------------------
// Sealed Trait Pattern
// ---------------------------------------------------------

/// Modul private menjamin bahwa hanya struktur di file/crate ini 
/// yang bisa melihat dan mengimplementasikan Trait `Sealed`.
mod private {
    pub trait Sealed {}
    
    // Kita melist semua tipe valid secara internal
    impl Sealed for super::TcpStreamConfig {}
    impl Sealed for super::UdpStreamConfig {}
}

/// Trait Publik: User bisa menggunakan trait ini sebagai generic bound
/// (e.g. `fn connect<T: NetworkConfig>(config: T)`), 
/// tetapi mereka TIDAK BISA membuat implementasi mereka sendiri!
pub trait NetworkConfig: private::Sealed {
    fn connection_timeout(&self) -> u32;
    fn protocol_name(&self) -> &'static str;
}

pub struct TcpStreamConfig {
    pub timeout_ms: u32,
}

impl NetworkConfig for TcpStreamConfig {
    fn connection_timeout(&self) -> u32 {
        self.timeout_ms
    }
    
    fn protocol_name(&self) -> &'static str {
        "TCP"
    }
}

pub struct UdpStreamConfig;

impl NetworkConfig for UdpStreamConfig {
    fn connection_timeout(&self) -> u32 {
        5000 // default UDP fallback
    }

    fn protocol_name(&self) -> &'static str {
        "UDP"
    }
}

// ---------------------------------------------------------
// #[non_exhaustive] untuk Structs & Enums
// ---------------------------------------------------------

/// Enum ini diekspos secara publik. Namun karena ditandai #[non_exhaustive],
/// pengguna crate ini di masa depan tidak bisa melakukan pola matching (match) 
/// tanpa klausa `_ => {}`. Ini berarti kita bebas menambah varian enum Error 
/// baru di update versi (Minor release) tanpa melanggar Semantic Versioning!
#[non_exhaustive]
#[derive(Debug, PartialEq)]
pub enum SystemError {
    NetworkDown,
    DiskFull,
    // [Varian baru bisa ditambahkan esok hari dengan aman]
}

/// Untuk Struct, #[non_exhaustive] mencegah inisialisasi literal secara
/// struktural `SystemConfig { port: 80 }` di crate eksternal. User dipaksa
/// menggunakan `SystemConfig::new(...)` atau `Builder`.
#[non_exhaustive]
pub struct SystemConfig {
    pub port: u16,
    pub max_retries: u8,
}

impl SystemConfig {
    pub fn default() -> Self {
        Self {
            port: 8080,
            max_retries: 3,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sealed_dispatch() {
        // Kita menggunakan konfigurasi lokal yang valid
        fn boot_system<T: NetworkConfig>(cfg: T) -> u32 {
            cfg.connection_timeout()
        }

        let tcp = TcpStreamConfig { timeout_ms: 3000 };
        assert_eq!(boot_system(tcp), 3000);
    }

    #[test]
    fn test_non_exhaustive_enum() {
        let err = SystemError::NetworkDown;
        
        // Match statement di crate lokal ini tidak diwajibkan ada '_', 
        // TETAPI jika match ini ada di crate luar, kompilator akan memaksa klausa '_'.
        match err {
            SystemError::NetworkDown => assert!(true),
            SystemError::DiskFull => assert!(false),
        }
    }
}
```

## Anti-Patterns Spesifik
1. **Me-leak (Membocorkan) Sealed Trait Marker**: Mengubah visibilitas modul menjadi `pub mod private` dan menyuruh user untuk tidak menyentuhnya dalam dokumentasi.
   - *Mengapa berbahaya:* Di Rust, dokumentasi berpesan "*do not touch*" bukanlah *enforcement*. Sealing harus dipaksakan oleh *visibility checker* (visibilitas `mod private` dan metode publik). Membiarkannya publik berarti Anda kehilangan jaminan kompatibilitas kompilasi ke depannya (SemVer break).
2. **Menambahkan Struct Fields Publik ke Non-Exhaustive API yang Telanjang**: Membuat struct `#[non_exhaustive] pub struct MyConfig`, tetapi tidak menyediakan *konstruktor*, *builder*, atau metode *default* yang diekspor.
   - *Mengapa berbahaya:* User hilir tidak akan pernah bisa membuat *instance* dari `MyConfig` sama sekali. Anda mengekspos tipe kosong yang penggunaannya sepenuhnya cacat secara struktural.

## Edge Cases & Defensive Engineering
- **Dokumentasi `private::Sealed`**: Karena `Sealed` berada pada modul non-publik, maka rustdoc biasanya akan mengabaikannya, menyebabkan supertrait bound hilang pada dokumentasi publik. Ada trik rahasia di mana Anda menggunakan `#[doc(hidden)] pub mod sealed { ... }`. Ini membuat modul ter-ekspor (tetap tersembunyi di web), namun trait publik Anda bisa menunjukkannya di halamannya sebagai supertrait, mengklarifikasi secara visual bagi pembaca bahwa trait ini di-seal.
- **Transitifitas Non-Exhaustive**: Ingat bahwa ketika `SystemError` merupakan varian dalam Enum hilir milik User (misal dibungkus `Box<dyn Error>`), itu bisa berinteraksi dengan API layer mereka secara eksklusif. Gunakan `#[non_exhaustive]` seawal mungkin di desain domain (khususnya untuk kode error).
