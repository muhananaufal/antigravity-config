# Monomorphization & Generics

## Konsep Utama
Monomorfisasi (Monomorphization) adalah proses compile-time yang dilakukan oleh compiler Rust untuk mengubah kode generik menjadi kode spesifik yang beroperasi pada tipe data konkret tertentu. Setiap kali fungsi atau struct generik dipanggil dengan tipe baru, compiler menduplikasi kode tersebut dan mengganti parameter generiknya dengan tipe konkret. Proses ini menghasilkan eksekusi runtime yang luar biasa cepat (*zero-cost abstractions* karena dapat di-*inline*) namun membawa dampak potensial pada ukuran binary akhir (*code bloat*) dan waktu kompilasi (*compile times*).

`impl Trait` digunakan untuk menyembunyikan tipe konkret dari sisi *caller* (Return Position Impl Trait - RPIT) atau untuk menyederhanakan definisi parameter.

**Penggunaan di Proyek Nyata:**
Ini adalah tulang punggung dari *High-Frequency Trading* systems, Rust standard library (`Vec<T>`, `Option<T>`), dan optimisasi performa ekstrem, karena statis dispatch memungkinkan compiler untuk memotong semua overhead dari virtual calls.

## Arsitektur Monomorfisasi
```text
                [Source Code]
           fn process<T: Display>(x: T) { ... }
                     |
  +------------------+-------------------+
  | process("Hello") | process(42_i32)   |
  +------------------+-------------------+
                     | (Compile-Time)
                     v
             [LLVM IR / Binary]
    fn process_str(x: &str) { ... }
    fn process_i32(x: i32) { ... }
                     |
            +--------+-------+
            | Binary Bloat?  | --> Trade-off: Ukuran memori VS CPU cycles (Speed)
            +----------------+
```

## Production-Ready Rust Code

```rust
use std::fmt::Display;

/// Menggunakan Return Position Impl Trait (RPIT) dan RPITIT (Rust 1.75+).
/// Trait ini menggunakan type erasure pada API level, namun pada 
/// tingkat kompilasi tetap mengalami monomorfisasi statis.
pub trait MetricEmitter {
    /// Mengembalikan implementasi dari tipe yang bisa diformat.
    /// Di Rust 1.75+, `impl Trait` bisa dipakai dalam return type trait (RPITIT).
    fn emit(&self, metric_name: &str, value: u64) -> impl Display;
}

pub struct PrometheusEmitter;

impl MetricEmitter for PrometheusEmitter {
    fn emit(&self, metric_name: &str, value: u64) -> impl Display {
        // Mengembalikan tipe anonim (struktur format spesifik) tanpa alokasi Box
        format!("prometheus_metric{{name=\"{}\"}} {}", metric_name, value)
    }
}

// ---------------------------------------------------------
// Inner-Function / Non-Generic Inner Pattern (Anti-Bloat)
// ---------------------------------------------------------

/// Struct generik yang besar (misalnya buffer data).
pub struct DataProcessor<T> {
    data: Vec<T>,
}

impl<T: AsRef<[u8]>> DataProcessor<T> {
    pub fn new(data: Vec<T>) -> Self {
        Self { data }
    }

    /// Fungsi ini dipanggil dari luar. Jika sangat besar dan generik, 
    /// monomorfisasi akan menduplikasi kodenya untuk SETIAP tipe T.
    pub fn process_heavy(&self) -> usize {
        // Panggil helper function tersembunyi yang NON-GENERIC!
        // Ini menghindari kode bloat yang ekstrem dengan melakukan type-erasure 
        // internal menjadi pointer (slice) dinamis/statis.
        Self::process_heavy_inner(self.data.iter().map(|item| item.as_ref()).collect::<Vec<_>>().as_slice())
    }

    // Fungsi non-generik yang berisi logika berat.
    // Kode ini hanya akan di-compile dan ada 1 salinan di final binary.
    fn process_heavy_inner(data: &[&[u8]]) -> usize {
        data.iter().map(|slice| slice.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_turbofish_and_rpit() {
        // Menggunakan "Turbofish" syntax ::<T> secara eksplisit
        let processor = DataProcessor::<String>::new(vec![
            "high".to_string(), 
            "frequency".to_string()
        ]);
        
        assert_eq!(processor.process_heavy(), 13);
        
        let emitter = PrometheusEmitter;
        let output = emitter.emit("latency_ms", 12);
        
        // Output bertipe `impl Display`, dikonversi ke String
        assert_eq!(output.to_string(), "prometheus_metric{name=\"latency_ms\"} 12");
    }
}
```

## Anti-Patterns Spesifik
1. **Generics di Fungsi Raksasa (Code Bloat)**: Menulis fungsi ratusan baris dengan parameter generik yang dipanggil dengan banyak tipe yang berbeda.
   - *Mengapa berbahaya:* Ukuran executable Anda akan membengkak, dan *compile times* akan melonjak tajam, selain menekan icache (*Instruction Cache*) pada CPU sehingga menurunkan performa runtime. Gunakan *Non-Generic Inner Pattern* seperti kode di atas untuk memitigasi hal ini.
2. **Ketergantungan Kuat pada Type Inference Berantai Tanpa Turbofish**: Bergantung pada deduksi kompiler terhadap tipe akhir setelah rangkaian iterasi/kombinasi yang kompleks.
   - *Mengapa berbahaya:* Sangat rapuh (*fragile*). Jika sebuah tipe ditambahkan atau ada implementasi trait baru di standard library, *type inference* bisa pecah atau menghasilkan tipe yang tidak terduga. Gunakan *Turbofish* (`collect::<Vec<String>>()` atau deklarasikan tipe pada variabel binding) sebagai perlindungan statis.

## Edge Cases & Defensive Engineering
- **RPIT (impl Trait) pada Lifetime Bounds**: Saat mengembalikan referensi dalam `impl Trait`, Anda mungkin harus menyertakan bound masa hidup eksplisit (seperti `impl Trait + 'a`) agar compiler tahu dengan siapa ia meminjam state, mencegah error *"hidden lifetime"*.
- **Turbofish Ambiguity**: Pada makro, turbofish terkadang bentrok secara parser. Di sebagian besar kasus di Rust modern, parser sudah diatur dengan sangat baik, namun berhati-hati saat menyisipkan pemanggilan generik di ekspresi makro rumit.
