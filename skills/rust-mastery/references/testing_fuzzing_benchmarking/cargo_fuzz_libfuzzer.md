# Fuzzing dengan `cargo-fuzz` (libFuzzer)

## 1. Konsep Utama & Kapan Digunakan
Fuzzing adalah teknik testing otomatis dengan mengirimkan input data random (yang perlahan dimutasi/dievolusikan oleh algoritma genetic berbasis code-coverage) ke suatu fungsi untuk memicu *crash*, panic, atau *memory error*. `cargo-fuzz` mengintegrasikan LLVM `libFuzzer` ke dalam ekosistem Rust.

Gunakan `cargo-fuzz` ketika:
- Menulis parser untuk format data yang kompleks (JSON, gambar, protokol network, custom DSL).
- Menulis kode kriptografi atau sistem manipulasi memori tingkat rendah.
- Setiap kode yang memproses input eksternal "tidak terpercaya" (untrusted user input).

## 2. Arsitektur / Flow

```ascii
[ LLVM libFuzzer Engine ] ---(Generates mutated bytes)---> [ Fuzz Target (Rust) ]
        ^                                                         |
        | (Coverage Feedback: "Ah, new code path hit!")           |
        +---------------------------------------------------------+
        
If Panic / OOM / Hang occurs -> (Crash Saved to `fuzz/artifacts`)
```

## 3. Kode Rust Production-Ready

Struktur folder hasil menjalankan `cargo fuzz init`:

```rust
// File: fuzz/fuzz_targets/parse_url.rs
#![no_main]
use libfuzzer_sys::fuzz_target;

// Anda perlu trait Arbitrary jika fuzzer membangkitkan Struct terstruktur alih-alih [u8]
use arbitrary::Arbitrary;

#[derive(Arbitrary, Debug)]
struct FuzzInput {
    url_str: String,
    port_override: Option<u16>,
}

// Target yang akan dibombardir ribuan kali per detik
fuzz_target!(|data: FuzzInput| {
    // Panggil target fungsi dari crate utama Anda
    // Asumsi: my_crate::UrlParser
    
    // Fuzzer bertugas MENEMUKAN PANIC. 
    // Oleh karena itu, panic yang wajar karena input "benar-benar ngaco" harus 
    // ditangani agar tidak dilaporkan sebagai bug. (Namun dalam Rust yang aman, parse tak boleh panic).
    
    // Jika parse() me-return Result (Ok atau Err), itu valid, program tidak crash.
    // Jika ada panic internal di dalam parse(), fuzzer akan menangkapnya.
    let _ = parse_custom_url_logic(&data.url_str, data.port_override);
});

// Implementasi dummy di crate utama yang sengaja punya bug panics!
fn parse_custom_url_logic(url: &str, _port: Option<u16>) -> Result<(), ()> {
    // Bug 1: Panic jika user input format aneh tertentu
    if url.starts_with("http") && url.contains("^^") {
        panic!("Unreachable state, URL parser logic failed!"); 
    }
    
    Ok(())
}
```

Cara eksekusi: `cargo +nightly fuzz run parse_url`

## 4. Anti-Pattern Spesifik
1. **Melewatkan limitasi input (seperti max length).**
   - *Bahaya*: Fuzzer dapat mengirim data sebesar 2GB, memicu Out of Memory (OOM) yang merupakan behavior standar sistem operasi, tetapi membingungkan hasil fuzzing karena OOM dicatat sebagai "crash".
   - *Solusi*: Batasi ukuran input awal di fuzzer target. Cek `if data.len() > 1_000_000 { return; }`.
2. **Tidak mensuplai `corpus` awal.**
   - *Bahaya*: libFuzzer harus menebak struktur data valid dari nol array `[]`. Ini memakan jutaan iterasi hanya untuk menembus filter sederhana.
   - *Solusi*: Isi folder `fuzz/corpus/parse_url` dengan 5-10 contoh file input yang valid/normal. Fuzzer akan memutasikannya, meningkatkan coverage seketika.

## 5. Edge Cases & Defensive Programming
- **Sanitizers**: Jalankan fuzzer dengan Address Sanitizer (ASan) untuk menangkap memory leak / unsafe Rust violations: `RUSTFLAGS="-Z sanitizer=address" cargo +nightly fuzz run ...`
- **Fuzzing Logic Berurutan (Stateful)**: Fuzzing API yang stateful (misal Database: Insert -> Update -> Delete) cukup sulit. Ubah target fuzz menerima `enum Action { Insert(String), Update(u32), ... }` sebagai `Arbitrary` lalu iterasi enum tersebut secara stateful di loop fuzzer.
