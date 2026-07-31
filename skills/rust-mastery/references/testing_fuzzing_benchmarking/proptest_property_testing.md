# Property Testing dengan `proptest`

## 1. Konsep Utama & Kapan Digunakan
Property Testing membuktikan bahwa untuk *seluruh kemungkinan kombinasi input*, sistem Anda mematuhi seperangkat sifat (*properties*) yang baku. Berbeda dengan fuzzing (fokus pada byte raw & crash), `proptest` menggunakan strategi pembangkitan (generators) berbasis tipe (types) dan sangat pintar dalam proses **Shrinking** (menyusutkan input kompleks yang gagal menjadi contoh paling minimal yang memicu kegagalan).

Gunakan `proptest` ketika:
- Menguji operasi matematika, parser data terstruktur, enkripsi.
- Menguji Invariants: Misal, "Encode -> Decode selalu mengembalikan data awal" (Roundtrip property).
- Menguji sistem berbasis state / State Machines.

## 2. Arsitektur / Flow

```ascii
[ Generator Strategy ] -> (Produces 1000s of inputs) -> [ Test Function ]
                                                               |
    +-- (Minimal Case) <--- [ Shrinker ] <--- (Fails at input X) 
    v
[ Test Reports Failure: "Fails when vector has exactly [0]" ]
```

## 3. Kode Rust Production-Ready

```rust
use proptest::prelude::*;

// Fungsi bisnis: Memecah string menjadi kata.
fn split_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

// Definisi Property Tests
proptest! {
    // 1. Proptest akan menjalankan blok ini defaultnya 256 kali.
    // 2. `\\PC*` adalah regex generator: Semua string tanpa character control.
    #[test]
    fn test_split_words_never_contain_whitespace(s in "\\PC*") {
        let words = split_words(&s);
        
        // Property 1: Tidak satupun kata hasil split yang mengandung spasi
        for word in words {
            prop_assert!(!word.contains(' '), "Kata memuat spasi: {}", word);
            prop_assert!(!word.contains('\t'));
        }
    }
    
    // Strategi komposit: Membangkitkan angka dengan batas tertentu
    #[test]
    fn test_reverse_roundtrip(vec in prop::collection::vec(0..1000i32, 0..100)) {
        let mut reversed = vec.clone();
        reversed.reverse();
        reversed.reverse();
        
        // Property 2: A == Reverse(Reverse(A))
        prop_assert_eq!(vec, reversed);
    }
}

// Strategi Kustom menggunakan prop_compose!
prop_compose! {
    // Generator yang menghasilkan data User valid
    fn valid_user_strategy()(
        name in "[a-zA-Z]{3,20}",
        age in 18u8..100
    ) -> User {
        User { name, age }
    }
}

#[derive(Debug)]
struct User {
    name: String,
    age: u8,
}
```

## 4. Anti-Pattern Spesifik
1. **Membuat *Properties* yang hanya menduplikasi fungsi produksi.**
   - *Bahaya*: Anda menulis fungsi `add(a,b)` dan test-nya memvalidasi `assert_eq!(add(a,b), a+b)`. Ini mubazir karena test dan kode punya probabilitas salah yang sama.
   - *Solusi*: Temukan properti independen. Untuk fungsi `add`, ujilah Sifat Komutatif: `add(a,b) == add(b,a)`.
2. **Filtering (membuang input) secara berlebihan pada strategy.**
   - *Bahaya*: Menggunakan `prop_assume!(condition)` berlebihan akan membuang 90% input yang dibangkitkan. Proptest akan menyerah ("Too many rejects").
   - *Solusi*: Lebih baik buat generator (*Strategy*) spesifik yang hanya membangkitkan kombinasi valid menggunakan kombinator alih-alih membangkitkan nilai luas dan memfilternya.

## 5. Edge Cases & Defensive Programming
- **Lambat di CI**: Property testing secara default dieksekusi ratusan kali per fungsi. Jika fungsi Anda berat, ini akan memakan waktu lama di CI. Gunakan `ProptestConfig` untuk mengubah iterasi di mode rilis / CI vs saat developer testing lokal.
- **State Machine Testing**: `proptest` menyokong `prop_state_machine!` untuk memvalidasi invariants sebuah struct stateful terhadap sekuens operasi acak (misal, struktur memori tree divalidasi tidak akan rusak jika di-insert, delete, rotate). Sangat powerful namun butuh setup state ekstensif.
