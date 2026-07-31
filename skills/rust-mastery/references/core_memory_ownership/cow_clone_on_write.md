# Cow (Clone-On-Write) & Zero-Copy Patterns

## Konsep Utama
`Cow<'a, B>` (Clone-on-Write) adalah enum pintar yang menyediakan abstraksi atas data pinjaman (borrowed) atau data yang dimiliki (owned). Enum ini mengimplementasikan `Deref` sehingga bisa digunakan seolah-olah data aslinya. Mutasi data hanya akan memicu alokasi (clone) jika data saat ini sedang dipinjam (borrowed).
Tipe data B wajib mengimplementasikan trait `ToOwned`.
Tipe paling umum adalah `Cow<'a, str>` dan `Cow<'a, [u8]>`.

**Kapan Digunakan:**
Parsers (JSON, URL, HTML), pemrosesan string di mana sebagian besar data tidak perlu diubah, API yang menerima baik referensi maupun nilai berpemilik dengan alokasi seminimal mungkin (Zero-copy parsing).

## Arsitektur / Flow
```text
          Cow::Borrowed(&'a B) 
                   |
     .to_mut() / .into_owned()
                   |
             [ ALOKASI CLONE ] 
                   |
                   v
          Cow::Owned(<B as ToOwned>::Owned)
```

## Implementasi Production-Ready

```rust
use std::borrow::Cow;

/// Membersihkan string dari karakter tidak valid (misal \r).
/// Menggunakan Cow memastikan alokasi hanya terjadi JIKA ada karakter yang harus dihapus.
pub fn sanitize_string<'a>(input: &'a str) -> Cow<'a, str> {
    if input.contains('\r') {
        // Alokasi terjadi (Clone on Write)
        let cleaned: String = input.replace('\r', "");
        Cow::Owned(cleaned)
    } else {
        // Zero-copy, mengembalikan referensi aslinya
        Cow::Borrowed(input)
    }
}

/// Struktur Zero-Copy untuk merepresentasikan header HTTP
#[derive(Debug, PartialEq)]
pub struct HttpHeader<'a> {
    pub key: Cow<'a, str>,
    pub value: Cow<'a, str>,
}

impl<'a> HttpHeader<'a> {
    pub fn new<K, V>(key: K, value: V) -> Self
    where
        K: Into<Cow<'a, str>>,
        V: Into<Cow<'a, str>>,
    {
        Self {
            key: key.into(),
            value: value.into(),
        }
    }
    
    pub fn normalize_key(&mut self) {
        // Memaksa key menjadi lower-case. Akan mengalokasi jika statusnya Borrowed
        // dan jika ada huruf besar (tergantung implementasi to_lowercase, kita alokasi di sini)
        if self.key.chars().any(|c| c.is_uppercase()) {
            let lower = self.key.to_lowercase();
            self.key = Cow::Owned(lower);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cow_no_allocation() {
        let input = "hello world";
        let result = sanitize_string(input);
        
        // Memastikan tidak ada alokasi memori baru
        assert!(matches!(result, Cow::Borrowed(_)));
        assert_eq!(result.as_ref(), "hello world");
    }

    #[test]
    fn test_cow_with_allocation() {
        let input = "hello\r world";
        let result = sanitize_string(input);
        
        // Memastikan dialokasikan ke Heap
        assert!(matches!(result, Cow::Owned(_)));
        assert_eq!(result.as_ref(), "hello world");
    }

    #[test]
    fn test_http_header() {
        let mut header = HttpHeader::new("Content-Type", "application/json");
        header.normalize_key(); // "Content-Type" punya huruf besar -> Clone
        
        assert!(matches!(header.key, Cow::Owned(_)));
        assert_eq!(header.key.as_ref(), "content-type");
    }
}
```

## Anti-Patterns

1. **Return Tipe `Cow` ke Publik namun Memaksa Alokasi Internal:**
   Menulis API return `Cow<'a, str>` tapi selalu membuat `String` di dalam fungsi lalu me-return `Cow::Owned`.
   *Mengapa Berbahaya:* Ini adalah overhead yang tidak perlu. Pemanggil akan menduga ini bisa berupa borrow dan menyesuaikan lifetime mereka. Jika selalu owned, return `String` saja untuk kejelasan dan menghindari overhead branching dari Cow enum.

2. **Penggunaan `Cow` dalam Loop Ketat tanpa `.into_owned()`:**
   Terus-menerus memanggil `.to_mut()` pada iterasi yang meng-append data.
   *Mengapa Berbahaya:* `.to_mut()` memeriksa state enum `Borrowed`/`Owned` setiap kali dipanggil, menyebabkan penalty branch prediction di HFT (High-Frequency Trading) atau game engine. Konversikan eksplisit menjadi `Owned` sebelum loop.

## Edge Cases & Defensive Engineering
- **Cow pada Slice byte (`Cow<'a, [u8]>`):** Sangat efisien untuk manipulasi network packet. Jika paket tidak dienkripsi/dekripsi, pass sebagai Borrowed. Jika didekripsi, ubah ke Owned di-tempat.
- **Lifetime Extension:** Kadang struct berisi `Cow<'a, str>`. Jika Anda ingin me-return data agar lolos dari scope `'a`, Anda dapat memanggil `into_owned()` yang akan mengkonsumsi state `Borrowed` (melakukan clone) atau mengambil string `Owned` as-is, menghasilkan nilai `'static` tanpa ikatan lifetime awal.
