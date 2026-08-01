# Cargo ASM & Machine Code Disassembly (LLVM Verification)

## Konsep Mendalam
Dalam pemrograman sistem berpeforma tinggi dan *ultra-low latency* (seperti HFT atau komputasi grafis intensif), asumsi tentang *zero-cost abstractions* di Rust seringkali harus divalidasi secara faktual hingga tingkat instruksi mesin (*machine instructions*) dan *assembly* lokal (x86_64, aarch64). Abstraction seperti iterasi berantai (`.iter().map().filter()`), smart pointer deferencing, atau inline function calls **tidak semestinya meninggalkan overhead instruksi pemanggilan fungsi (function call overhead)** di binary akhir.

Untuk memverifikasi apakah kompiler LLVM telah berhasil melakukan inlining, menyingkirkan pengecekan batas memori (*bounds-checking elimination*), dan memvalidasi auto-vectorization (instruksi SIMD seperti `VPSHUFD` atau `PADDQ` di AVX2), kita menggunakan perkakasan seperti `cargo-asm` atau `cargo-show-asm`. Pembedahan kode assembly memungkinkan kita melacak titik di mana register mengalami *spilling* ke stack memori (yang memperlambat siklus CPU) serta mengejar penghapusan *branch prediction failure* pada *hot path*.

### Atribut Kompiler & Kontrol Optimasi
- **`#[inline]` dan `#[inline(always)]`**: Menasihati atau memaksa LLVM untuk meleburnya ke dalam *caller*, membuka gerbang optimasi silang fungsi.
- **`#[inline(never)]`**: Digunakan pada jalur dingin (*cold path*, misal pelaporan error atau log logging) agar tidak mengotori *instruction cache (I-Cache)* dari jalur utama yang kritis.
- **`#[no_mangle]` dan `#[export_name = "..."]`**: Mencegah kompiler melakukan *symbol mangling* (seperti `_ZN3std3sys...`), memudahkan identifikasi fungsi langsung saat membaca output disassembler atau file `.s`.
- **Target Feature & Codegen Units**: Menandai fungsi dengan `#[target_feature(enable = "avx2")]` memaksa emisi register vektor YMM berskalar tinggi pada perangkat yang kompatibel.

---

## Arsitektur & Pipeline Emisi Assembly

```ascii
[ Rust Source Code (*.rs) ] 
       │ 
       ├──( rustc HIR & MIR optimization )──> [ High/Mid-level IR ]
       │
       └──( LLVM IR Generation & Passes )───> [ LLVM IR (*.ll) ]
               │
               ├──( O3 / ThinLTO / FatLTO )
               ▼
   [ Native Machine Assembly (x86_64/ARM64) ] ──( cargo-asm )──> [ Annotated Assembly & Register Allocation ]
```

### Analisis Perbedaan: Zero-Cost vs Overhead

```ascii
Tanpa Optimasi (Call Overhead & Bounds Check):
.LBB0_3:
    movq    %rsi, %rdi
    callq   *std::slice::index_check_failed
    ud2

Zero-Cost Abstraction & Vectorized Loop (SIMD AVX2):
.LBB0_1:
    vmovups (%rdi,%rax,4), %ymm0
    vaddps  (%rsi,%rax,4), %ymm0, %ymm0
    vmovups %ymm0, (%rdx,%rax,4)
    addq    $8, %rax
    cmpq    %rcx, %rax
    jb      .LBB0_1
```

---

## Implementasi Kode Produksi & Komparasi

Berikut adalah kode pengujian yang siap dibedah menggunakan disassembler, membandingkan loop bernota indeks statis (memicu bounds test) dengan kombinasi iterator tanpa batas (zero-cost SIMD target).

```rust
// File: src/lib.rs

/// Jalur dingin (cold path): Menghindari polusi instruction cache pada fungsi utama.
#[cold]
#[inline(never)]
pub fn laporkan_anomali_performa(indeks: usize) {
    eprintln!("Anomali performa ekstrim pada siklus pemrosesan ke-{}", indeks);
}

/// Implementasi suboptimal yang memaksakan bounds checking berulang pada array.
/// Mudah untuk dilihat via `cargo asm my_crate::penghitungan_berindex` karena mengandung instruction `ud2` (panic).
#[no_mangle]
pub extern "C" fn penghitungan_berindex(data: &[f64], target: &mut [f64]) {
    let panjang = data.len().min(target.len());
    for i in 0..panjang {
        // Berpotensi menyisakan instruksi pembanding batas jika LLVM luput mengenali invarian.
        if data[i] < 0.0 {
            laporkan_anomali_performa(i);
        } else {
            target[i] = data[i] * 2.5 + 1.0;
        }
    }
}

/// Implementasi zero-cost abstraction menggunakan Zip Iterator.
/// LLVM dapat mengeliminasi bounds checking sepenuhnya dan melakukan unroll/SIMD vectorization.
#[no_mangle]
pub extern "C" fn penghitungan_iterator_vectorized(data: &[f64], target: &mut [f64]) {
    for (val, res) in data.iter().zip(target.iter_mut()) {
        // Mengubah kontrol branching menjadi instruksi prediksi mask berskala mutlak
        *res = *val * 2.5 + 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_komparasi_akurasi_kalkulasi() {
        let input = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let mut output_indeks = vec![0.0; 5];
        let mut output_iter = vec![0.0; 5];

        penghitungan_berindex(&input, &mut output_indeks);
        penghitungan_iterator_vectorized(&input, &mut output_iter);

        assert_eq!(output_indeks, output_iter, "Keluaran dari kedua metode wajib identik");
        assert_eq!(output_iter[0], 3.5);
        assert_eq!(output_iter[4], 13.5);
    }

    #[test]
    fn test_penanganan_slice_beda_panjang() {
        let input = vec![10.0, 20.0, 30.0];
        let mut output_pendek = vec![0.0; 2];

        penghitungan_iterator_vectorized(&input, &mut output_pendek);
        assert_eq!(output_pendek, vec![26.0, 51.0]);
    }
}
```

---

## Anti-Patterns Kritis

### 1. Polusi Hot Path Akibat Inlining Fungsi Besar Berisi String Formatting
- **Penjelasan**: Memaksimalkan `#[inline(always)]` pada fungsi yang di dalamnya berisi pemanggilan makro log ekstensif atau manipulasi string error (`format!`, `println!`).
- **Bahaya**: Kode assembly untuk merakit string formatting sangat panjang dan berbelang. Memaksanya masuk ke dalam fungsi komputasi cepat (*hot path*) akan melempar blok instruksi komputasi asli keluar dari L1/L2 Instruction Cache (I-Cache thrashing), memperlambat siklus iterasi secara fatal.
- **Solusi**: Isolasi logika pembuatan pesan error atau log ke fungsi eksternal tersendiri dan beri penunjuk `#[cold]` serta `#[inline(never)]`.

### 2. Mengabaikan Symbol Mangling Saat Pengujian Komparasi Assembly
- **Penjelasan**: Berusaha mencari nama simbol fungsi standar pada output dump assembly (`.s` atau `.asm`) tanpa menambahkan parameter pencegah mangling.
- **Bahaya**: Kompiler Rust merakit ID unik acak (seperti `_ZN7memsys8kalkul17hb78a2e41c_E`). Saat refactored, hash berubah total sehingga skrip otomatisasi audit performa CI/CD Anda yang mengecek emisi instruksi assembly tertentu gagal mengenali fungsi sasaran.
- **Solusi**: Gunakan pembatasan `#[no_mangle]` atau `#[export_name = "nama_stabil"]` HANYA untuk fungsi inti yang akan dijadikan subjek pemantauan *benchmark analysis* atau target verifikasi assembler eksternal.

---

## Edge Cases & Defensive Programming

1. **Perbedaan Arsitektur Cross-Compilation (x86_64 vs aarch64)**:
   Instruksi SIMD atau intrinsik assembly sangat terikat pada target register keras keras mesin lokal. Mengandalkan `#[target_feature(enable = "avx2")]` akan melempar *SIGILL (Illegal Instruction)* saat biner dijalankan di server awan berprosesor ARM atau CPU Intel lawas yang tidak mendukung AVX2. Selalu gunakan gerbang kompilasi bersyarat (`#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]`) serta deteksi kapabilitas dinamis secara runtime (`is_x86_feature_detected!("avx2")`) sebelum membelokkan eksekusi ke blok fungsi assembly khusus.

2. **Register Spilling Akibat Tekanan Variabel Lokal Ekstrim**:
   Bahkan ketika kode tampak sederhana dalam sintaks Rust, pembuatan variabel sementara bertingkat di dalam loop ketat dapat menembus batas jumlah register keras x86_64 (16 register umum). Saat ini terdeteksi pada *disassembled view*, Anda akan memergoki instruksi beruntun `movq %rax, -32(%rbp)` dan `movq -32(%rbp), %rcx` berulang kali. Ini adalah tanda nyata *register spilling* di mana data dijatuhkan ke L1 stack memory. Sederhanakan struktur alur pembagian variabel atau pecahkan komputasi menjadi tahapan bertingkat agar register tidak tumpang tindih.

3. **Luputnya Vectorization Karena Aliasing Pointer**:
   Jika kompiler menduga ada kemungkinan bahwa dua slice referensi di dalam argumen fungsi bisa saling bertindih alamat (memory aliasing), LLVM menolak membuang instruksi loop konvensional menjadi satu blok vektor SIMD untuk mencegah kerusakan data secara diam-diam. Untuk menjamin asumsi zero-aliasing terdeteksi utuh oleh optimiser LLVM di tingkat bahasa Rust, selalu utamakan pemanfaatan pola kepemilikan eksplisit, `&mut [T]` yang dijamin rustc bebas aliased, atau metode pembelah terverifikasi seperti `split_at_mut` dibanding operasi indexing pointer manual via `*mut T`.
