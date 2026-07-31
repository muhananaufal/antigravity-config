# Branch Prediction & CPU Pipeline

## Konsep Utama dan Penggunaan
CPU modern adalah "pipelined". Mereka tidak menunggu satu instruksi selesai sebelum memulai yang berikutnya. Mereka menebak (branch prediction) rute kode mana yang akan diambil pada statement `if/else`. Jika tebakan salah (Branch Misprediction), CPU membuang semua instruksi dalam pipeline (pipeline flush), yang memakan waktu 10-20 *clock cycles*.

Dalam HFT, latensi *microsecond* menjadi masalah. Meminimalkan *branching* dalam *hot path* (seperti logika evaluasi sinyal atau parsing paket) adalah hal krusial. Kita bisa menggunakan *branch-free programming* (trik bitwise) atau memberi *hint* compiler dengan `likely`/`unlikely` atau atribut `#[cold]`.

## Arsitektur: Pipeline Flush
```text
Waktu  ->
[ Fetch ] [ Decode ] [ Execute ] [ Writeback ]
[ IF x=1]
          [ Fetch  ] [ Decode  ] [ Execute ] <- CPU menebak rute 'if'
                     [ Fetch   ] [ Decode  ]

Ternyata x=0 (Salah tebak)! 
-> FLUSH PIPELINE (Buang hasil di atas)
-> Fetch ulang dari rute 'else' (Penalti 15 cycles)
```

## Kode Production-Ready: Branch-Free Programming
```rust
#![feature(core_intrinsics)]

/// Hint untuk optimizer (tersedia di nightly, atau stabil lewat std::intrinsics)
/// Dalam HFT, digunakan untuk mengisyaratkan bahwa jalur kesalahan itu langka.
#[inline(always)]
pub fn likely(b: bool) -> bool {
    // Pada stable, kita bisa menggunakan eksperimental eksternal atau membiarkan
    // LLVM melakukan profiler-guided optimization (PGO).
    // Implementasi dummy untuk contoh
    b
}

#[inline(always)]
#[cold]
fn handle_rare_error() {
    // Memindahkan blok kode ini dari "hot instruction cache" (icache)
    eprintln!("A very rare error occurred, parsing corrupted packet!");
}

/// Menghitung nilai absolut tanpa cabang (Branch-free / Branchless).
/// Tradisional: if x < 0 { -x } else { x } -> Memiliki instruksi branch.
/// Branchless ini memanfaatkan bitwise shift.
pub fn branchless_abs(x: i32) -> i32 {
    // mask = -1 (semua bit 1) jika x negatif, 0 jika positif
    let mask = x >> 31;
    // (x + mask) ^ mask
    // Jika positif: (x + 0) ^ 0 = x
    // Jika negatif: (x + -1) ^ -1 = -x (Two's complement)
    (x + mask) ^ mask
}

/// Memilih antara 'a' atau 'b' tanpa conditional branch (if).
/// condition harus berupa 0 (false) atau 1 (true).
pub fn branchless_select(condition: i32, a: i32, b: i32) -> i32 {
    // Jika condition = 1, -condition = -1 (0xFFFFFFFF). a terambil.
    // Jika condition = 0, -condition = 0 (0x00000000). b terambil.
    let mask = -condition;
    (a & mask) | (b & !mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_branchless_abs() {
        assert_eq!(branchless_abs(-10), 10);
        assert_eq!(branchless_abs(42), 42);
        assert_eq!(branchless_abs(0), 0);
    }

    #[test]
    fn test_branchless_select() {
        assert_eq!(branchless_select(1, 100, 200), 100);
        assert_eq!(branchless_select(0, 100, 200), 200);
    }
}
```

## Anti-Patterns

1. **Membuat Asumsi Kinerja Branchless Tanpa Benchmark**
   - *Bahaya*: Kode *branchless* dengan bitwise hack yang terlalu kompleks bisa menghasilkan lebih banyak instruksi. Jika kondisi "if" sangat mudah ditebak (contoh: probabilitas 99% benar), CPU branch predictor akan mengeksekusinya lebih cepat daripada instruksi bitwise buatan Anda.
   - *Solusi*: Ukur dengan `criterion` atau `iai`. Sering kali compiler LLVM sudah mengoptimasi skenario `if-else` sederhana menjadi instruksi `CMOV` (Conditional Move) yang bersifat *branchless* secara native.

2. **Penggunaan `#[inline(always)]` yang Agresif di Jalur Dingin**
   - *Bahaya*: Memaksa *inline* pada fungsi error/logging (cold path) akan memperbesar ukuran fungsi utama. Ini mendegradasi efisiensi Instruction Cache (L1i) di CPU karena kode error menempati ruang memori instruksi, menggusur kode *hot path*.
   - *Solusi*: Ekstrak kode error ke fungsi terpisah dan gunakan anotasi `#[cold]` agar LLVM memindahkannya ke akhir binary (menjaga *hot path* tetap padat).

## Edge Cases & Defensive Engineering
- **Compiler Optimizations (PGO)**: Jangan bertarung melawan compiler (LLVM). Daripada menggunakan `likely`/`unlikely` secara manual (yang sering kali salah), cara terbaik dalam ekosistem Rust production adalah menggunakan Profile-Guided Optimization (PGO). Kumpulkan data dari *real workloads*, biarkan LLVM menyesuaikan tata letak cabang sendiri.
- **Duff's Device/Loop Unrolling**: Compiler Rust modern biasanya sangat lihai melakukan unrolling otomatis. Menulis unrolling manual secara kotor berisiko melanggar *bounds checking* yang pada akhirnya disisipi *branch* tersembunyi oleh compiler.
