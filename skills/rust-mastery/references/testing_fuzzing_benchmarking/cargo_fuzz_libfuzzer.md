# Cargo Fuzz & libFuzzer: Automasi Deteksi Kelemahan Memori

## Deskripsi dan Konsep Utama
Fuzzing adalah teknik *automated software testing* yang menyediakan data *random* (namun ber-evolusi) yang tidak terduga ke fungsi sistem target (SUT). Rust `cargo-fuzz` menggunakan kapabilitas sanitisasi LLVM (`libFuzzer`) berbasis *Coverage-Guided Fuzzing*. Daripada mengandalkan insting developer untuk menulis edge-cases, fuzzer membaca *code branches* yang dieksekusi, lalu memutasi input (*genetic algorithm*) demi mencari branch tersembunyi yang berisiko memicu `panic!`, *out-of-bounds index*, OOM, atau bahkan *memory leak*.

## Arsitektur & Flow (ASCII Diagram)
```text
 [Corpus Directory (Seed Inputs)]
           |     ^
           v     | (New coverage found: save input)
   +-------------------+
   |   LLVM libFuzzer  | <--- Mutates raw bytes (Bit-flips, splicing)
   +-------------------+
           |
    [fuzz_target!(|data: &[u8]|)]
           |
           v
 [Target Rust Function (Parser/Codec)]
           |
       [Crash / Panic?]
          /       \
      [YES]       [NO]
        |           |
 [Save artifact] [Loop]
```

## Implementasi Produksi (Rust)
```rust
// File ini diasumsikan berada di bawah direktori `fuzz/fuzz_targets/` (e.g. parse_packet.rs)
// Untuk referensi code: tidak ada #[cfg(test)] karena fuzz target dikompilasi terpisah.
// Namun kita sediakan mock environment untuk kompatibilitas.

#![no_main]

// Simulasikan macro cargo-fuzz agar lolos compiler lokal
#[cfg(not(fuzzing))]
macro_rules! fuzz_target {
    (|$name:ident: $ty:ty| $body:block) => {
        pub fn run_fuzz($name: $ty) {
            $body
        }
    };
}

#[cfg(fuzzing)]
use libfuzzer_sys::fuzz_target;

use arbitrary::Arbitrary;

// Grammar-aware fuzzing: daripada menggunakan bytes mentah &[u8],
// kita meminta Arbitrary trait dari libfuzzer untuk membangkitkan struktur yang valid secara parsial.
#[derive(Arbitrary, Debug)]
pub struct NetworkPacket {
    pub magic: u16,
    pub version: u8,
    pub payload: Vec<u8>,
}

// Target Fungsi yang rapuh
pub fn decode_custom_protocol(packet: &NetworkPacket) {
    if packet.magic == 0xBEEF {
        if packet.version > 2 {
            // Potensi panic: membaca indeks yang tidak aman dari payload tanpa validasi panjang
            if packet.payload.len() >= 4 {
                let critical_data = packet.payload[3];
                // Lakukan sesuatu...
                if critical_data == 0xAA {
                    // Logic flaw (hanya dapat dideteksi dengan assertion kustom)
                    assert!(packet.payload.len() < 1000, "Payload too large for AA code");
                }
            }
        }
    }
}

// Entrypoint fuzzer
fuzz_target!(|packet: NetworkPacket| {
    // Jalankan fungsi
    decode_custom_protocol(&packet);
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safe_packet() {
        let p = NetworkPacket {
            magic: 0x0000,
            version: 1,
            payload: vec![1, 2, 3],
        };
        decode_custom_protocol(&p);
    }

    #[test]
    #[should_panic(expected = "Payload too large")]
    fn test_panic_condition_discovered_by_fuzzer() {
        let p = NetworkPacket {
            magic: 0xBEEF,
            version: 3,
            payload: vec![0, 0, 0, 0xAA, 0, 0], // panjang baru 6, masih di bawah 1000? Oh, wait, padding
        };
        // Setup payload length to be >= 1000 to trigger the panic
        let mut p_large = p;
        p_large.payload = vec![0; 1000];
        p_large.payload[3] = 0xAA;
        
        decode_custom_protocol(&p_large);
    }
}
```

## Anti-Patterns

1. **Fuzzing Stateful Systems tanpa Reset**: Melakukan fuzzing terhadap suatu *global static state* atau koneksi database tanpa melakukan *reset/cleanup* di akhir tiap siklus eksekusi `fuzz_target!`.
   *Mengapa berbahaya*: Fuzzer akan menemukan *false positive* crash karena sistem kehabisan memori (*memory leak* fiktif) atau statenya menjadi rusak oleh input sebelumnya, membuat replikasi (reproducibility) bug dari *artifact* mustahil dilakukan.
2. **Raw Byte Parsing untuk Format Kompleks (Tanpa Arbitrary)**: Membuang waktu CPU memfuzzing `&[u8]` secara *random* ke *parser* JSON atau SQL tanpa mendefinisikan *grammar-aware fuzzer* (seperti `arbitrary`).
   *Mengapa berbahaya*: 99.9% komputasi fuzzing akan terbuang hanya untuk mendapatkan *syntax error* di fase awal (awal parser). Libfuzzer tidak bisa menembus *deep code branches* yang memerlukan valid format.

## Edge Cases & Defensive Programming

1. **Corpus Explosion (Corpus Minimization)**: Corpus input yang disimpan libfuzzer membengkak dari 1MB ke 100GB karena terlalu banyak rute unik minor. Solusinya, rutin lakukan `cargo fuzz cmin` (Corpus Minimization) yang mereduksi input yang memiliki *coverage overlap* sehingga fuzzer iterasi lebih agresif dan ringan.
2. **Infinite Loops / Timeout**: Input acak menghasilkan kondisi di mana `while count > 0` berjalan tanpa henti karena `count` secara logis termutasi aneh dan berputar-putar. *Timeout* akan ditangkap fuzzer sebagai crash. Selalu amankan loop dengan iterasi absolut maksimum (`MAX_ITER`).
3. **OOM akibat Alokasi Fiktif**: Fuzzer sering membuat input: `[LENGTH=0xFFFF_FFFF_FFFF, DATA...]`. Kalau parser Rust melakukan `Vec::with_capacity(length)` secara langsung, sistem akan langsung OOM Panic dan fuzzer mati. Batasi `capacity` maksimum pada data eksternal, atau gunakan fallible allocation (`try_reserve`).
