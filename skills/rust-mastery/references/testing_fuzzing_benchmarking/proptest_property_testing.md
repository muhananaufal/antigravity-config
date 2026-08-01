# Proptest: Property-Based Testing dan Shrinking

## Deskripsi dan Konsep Utama
Berbeda dari *Unit Testing* klasik yang mengandalkan data statis (contoh: tes input "A" hasilnya "B"), *Property-Based Testing* fokus pada deklarasi **invarian** (sifat yang selalu benar, apapun inputnya). Crate `proptest!` menghasilkan ratusan input *random* yang bervariasi sesuai parameter yang diizinkan (misal: "semua vector i32 yang mungkin"). Jika terjadi kegagalan (test fails), fasa krusial bernama **Shrinking** aktif: `proptest` akan berjuang memperkecil input (*memotong vector, menurunkan nilai int mendekati nol*) hingga menemukan data terekecil absolut yang tetap memicu bug. 

## Arsitektur & Flow (ASCII Diagram)
```text
  [Strategy Definitions] (e.g. Vec<u8> length 0..100)
           |
           v
   +--------------+      (Generates valid test cases)
   | Proptest Gen | ------------------------------+
   +--------------+                               |
           ^                                      v
           | (Shrinks on failure)       [Target Function / SUT]
           |                                      |
   [Shrinking Engine] <--------------------- [Fail/Pass?]
    Finds minimal edge-case                  /       \
    (e.g., Vec of size 2)              [FAIL]         [PASS]
```

## Implementasi Produksi (Rust)
```rust
use proptest::prelude::*;

// Fungsi target: Fungsi pembalik string (harus support unicode)
pub fn reverse_string(s: &str) -> String {
    // Implementasi yang naif: hanya membalik bytes. (INI RAWAN BUG)
    // s.bytes().rev().map(|b| b as char).collect() -> Akan crash di UTF-8 multibyte.
    
    // Implementasi benar (unicode-aware)
    s.chars().rev().collect()
}

// Fungsi target: Dekomposisi pecahan (Invarian: a + b = total)
pub fn split_budget(total: u32) -> (u32, u32) {
    if total % 2 == 0 {
        (total / 2, total / 2)
    } else {
        ((total / 2) + 1, total / 2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Proptest block
    proptest! {
        // Test property: Double reverse menghasilkan string asli
        #[test]
        fn test_reverse_twice_is_identity(s in "\\PC*") { 
            // "\\PC*" adalah regex-like generator dari proptest untuk membuat sembarang valid unicode.
            let reversed = reverse_string(&s);
            let double_reversed = reverse_string(&reversed);
            prop_assert_eq!(s, double_reversed);
        }

        // Test property: Hasil pembagian selalu menjumlah ke original total
        #[test]
        fn test_split_budget_sum(total in 0..10_000_u32) {
            let (a, b) = split_budget(total);
            
            // Invarian: Jumlahnya harus sama
            prop_assert_eq!(a + b, total);
            // Invarian: Selisih maksimal 1
            let diff = a.abs_diff(b);
            prop_assert!(diff <= 1);
        }
        
        // Custom strategy generator combination
        #[test]
        fn test_complex_strategy(
            (idx, vec) in (0..10usize).prop_flat_map(|len| (0..=len, proptest::collection::vec(any::<i32>(), len)))
        ) {
            // idx pasti berada dalam bound panjang dari vec (karena 0..=len).
            // Tapi tunggu! Jika vec panjang 0, idx = 0.
            // Jika kita akses vec[0], akan panic. Ini akan mendemonstrasikan Edge Case Shrinking.
            
            if vec.len() > 0 {
                // Hanya simulasi bahwa akses index aman
                let _val = vec[idx % vec.len()]; 
            }
        }
    }
}
```

## Anti-Patterns

1. **Test Property Berupa Rekonstruksi Ulang Logika**: Menulis test property yang isinya benar-benar mengulangi kode implementasi dari fungsi aslinya.
   *Mengapa berbahaya*: Invarian gagal ditemukan karena jika Anda menulis implementasi salah di kode utama, dan Anda copy-paste ke property test, test akan *pass* dengan sempurna (Error bertemu dengan Error = Match). Property test harus fokus pada sifat (*Identity*, *Associativity*, *Commutativity*).
2. **Kondisi Filter (`prop_assume!`) yang Terlalu Ketat**: Meminta generator sembarang (`any::<i32>()`) lalu membuang 99% input dengan `prop_assume!(x > 1000000)`.
   *Mengapa berbahaya*: Proptest membatasi jumlah *rejections*. Jika terlalu sering di-reject, test akan dibatalkan otomatis dan gagal (*Too many rejects*). Gunakan *generator boundaries* (`1000000..=i32::MAX`) secara langsung.

## Edge Cases & Defensive Programming

1. **Shrinking Meleset (Local Minimum)**: Terkadang mesin *shrinking* proptest terjebak di optimum lokal. Misalnya bug terjadi jika angka > 50 dan genap. Shrinking mungkin berhenti di 52, walau edge case sebenarnya 50, karena algoritma potongnya berdasar bit-shifts dan membagi dua.
2. **Performa Proptest di CI**: Crate `proptest!` secara default menjalankan 256 kasus per fungsi. Jika fungsi lambat atau I/O bound (misal akses SQLite), test akan membengkak dari milidetik jadi puluhan detik. Gunakan environment variable `PROPTEST_CASES=32` di CI untuk mengatur batas eksekusi.
3. **Float NaNs dan Invarian Matematis**: Men-generate angka float sembarangan (`any::<f64>()`) sering memasukkan `NaN` dan `Infinity`. Karena `NaN != NaN` di Rust, hampir semua `prop_assert_eq!` akan meledak. Selalu batasi strategi float untuk menghasilkan bilangan real yang terbatas (`proptest::num::f64::NORMAL`).
