# Blanket Impls & Orphan Rules

## Konsep Utama
Orphan Rule (Koherensi/Coherence) di Rust adalah aturan kompiler fundamental yang menyatakan: Anda hanya dapat mengimplementasikan sebuah trait pada sebuah tipe JIKA tipe tersebut, ATAU trait tersebut didefinisikan secara lokal di crate Anda sendiri. Ini mencegah tabrakan fatal (conflicts) antara library eksternal yang berbeda, melindungi program dari skenario dimana dua dependensi berbeda membuat implementasi tak kompatibel untuk `Trait` yang sama pada struct eksternal yang sama.

Untuk mem-bypass Orphan Rule, Rust Engineer umumnya menggunakan *Newtype Pattern*. Sementara itu, *Blanket Impls* adalah implementasi trait untuk *semua* tipe yang memenuhi kondisi tertentu (seperti `impl<T: TraitA> TraitB for T`).

**Penggunaan di Proyek Nyata:**
Digunakan di seluruh framework Rust tingkat perusahaan (seperti Tokio, Serde). *Blanket impls* mendasari fitur standard library raksasa seperti bagaimana `ToString` diimplementasikan secara otomatis untuk semua tipe yang mengimplementasikan `Display`.

## Arsitektur Orphan Rules
```text
Crate A: Trait `Serializable` 
Crate B: Struct `User`
--------------------------------------------
Crate C: 
  impl Serializable for User { ... }  <--- ERROR (Orphan Rule)! 
                                           Tipe `User` eksternal.
                                           Trait `Serializable` eksternal.

  +-------------------------------+
  | Solusi: Newtype Pattern       |
  | struct LocalUser(CrateB::User)|
  | impl Serializable for LocalUser  <--- OK! LocalUser milik Crate C.
  +-------------------------------+
```

## Production-Ready Rust Code

```rust
use std::fmt::Display;

// Asumsikan trait eksternal (dari dependency 'external_crate')
pub trait VendorApiAuth {
    fn get_token(&self) -> String;
}

// Asumsikan tipe eksternal (dari dependency 'external_crate')
pub struct VendorUser {
    pub name: String,
    pub id: u64,
}

// ---------------------------------------------------------
// Newtype Pattern - Bypassing Orphan Rule
// ---------------------------------------------------------
/// Membungkus tipe eksternal dengan tuple struct. Ini menjadikan
/// `AuthUser` tipe LOKAL untuk crate ini.
pub struct AuthUser(pub VendorUser);

// Sekarang kita bebas mengimplementasikan Trait eksternal/internal apapun!
impl VendorApiAuth for AuthUser {
    fn get_token(&self) -> String {
        format!("{}-TOKEN-xyz", self.0.id)
    }
}

// ---------------------------------------------------------
// Blanket Implementations & `!Trait` (Negative Impls)
// ---------------------------------------------------------
pub trait Logger {
    fn log_info(&self);
}

/// Blanket Impl: Terapkan trait Logger untuk SEMUA tipe T yang
/// mengimplementasikan `Display` dan `VendorApiAuth`.
impl<T> Logger for T
where
    T: Display + VendorApiAuth,
{
    fn log_info(&self) {
        println!("[INFO] Token: {} | Data: {}", self.get_token(), self);
    }
}

// Untuk mendemonstrasikan, kita butuh AuthUser agar bisa di `Display`.
impl Display for AuthUser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "User({})", self.0.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_newtype_and_blanket_impl() {
        let external_user = VendorUser {
            name: "Alice".to_string(),
            id: 8841,
        };
        
        // Membungkusnya
        let user = AuthUser(external_user);
        
        // Karena `AuthUser` sekarang memiliki `Display` dan `VendorApiAuth`,
        // kompiler secara OTOMATIS memberikan implementasi `Logger` via Blanket Impl!
        user.log_info();
        
        assert_eq!(user.get_token(), "8841-TOKEN-xyz");
    }
}
```

## Anti-Patterns Spesifik
1. **Overlapping Blanket Impls**: Membuat dua blanket implementation yang bertabrakan, contohnya: `impl<T: TraitA> MyTrait for T` dan `impl<T: TraitB> MyTrait for T`.
   - *Mengapa berbahaya:* Jika ada sebuah tipe yang mengimplementasikan KEDUA `TraitA` dan `TraitB`, kompiler Rust akan panic dengan error konflik implementasi, karena kompiler tidak tahu implementasi mana yang harus dieksekusi. Jangan pernah merilis crate publik dengan blanket impl yang bersinggungan secara bebas.
2. **Huge Tuple Newtypes yang Membocorkan Akses**: Menggunakan `pub struct MyNewtype(pub String, pub usize, pub Vec<u8>)`.
   - *Mengapa berbahaya:* Tujuan Newtype bukan cuma soal Orphan rule, tetapi abstraksi batas (*boundaries*). Mengekspos internal data via `pub` merusak enkapsulasi tipe dan memperketat kopling terhadap detail struktural, yang membunuh keleluasaan evolusi API crate Anda.

## Edge Cases & Defensive Engineering
- **Atribut `#[fundamental]`**: Beberapa tipe di Rust stdlib seperti `Box<T>`, `&T`, dan `&mut T` diberi atribut khusus `#[fundamental]`. Ini membuat compiler sedikit mengendurkan Orphan Rule, menganggap `Box<LocalType>` sebagai tipe "Lokal", memungkinkan Anda untuk melakukan `impl ExternalTrait for Box<LocalType>`. Berhati-hatilah pada sifat khusus `#[fundamental]` karena atribut ini hanya eksklusif untuk internal kompiler saat ini.
- **Negative Impls (Eksperimental/Nightly)**: Terkadang Anda butuh memastikan sebuah blanket impl **TIDAK** mengenai tipe tertentu. Saat ini, explicit negative impl (misalnya `impl !Trait for Type`) sebagian besar stabil untuk auto traits (seperti `Send/Sync`), namun masih terbatas dalam memecahkan overlap di fitur koherensi standard, sering membutuhkan trik *autoref-based specialization* sebagai workaround.
