# Inline Assembly (`core::arch::asm!`)

## Konsep Utama
Rust menyediakan makro `asm!` secara stabil sejak versi 1.59. Ini memungkinkan *developer* untuk menyisipkan instruksi level *assembly* secara langsung (biasanya dengan sintaks Intel untuk platform x86). *Inline assembly* dipakai jika kompilator (LLVM) gagal mengoptimasi kode dengan sempurna, atau untuk memanggil instruksi khusus CPU yang tidak ada abstraksi *intrinsics*-nya.

- **Constraints:** Mendefinisikan register apa yang akan diisi oleh *compiler* (`in`, `out`, `inout`).
- **Clobbers:** Memberitahu *compiler* register mana saja yang kita hancurkan isinya, sehingga kompilator tidak menempatkan variabel penting di sana.
- **Naked Functions:** Fungsi `#[naked]` tidak memasukkan *prologue* dan *epilogue* standar (push/pop stack pointer). Sepenuhnya bergantung pada isi *assembly*.

**Kapan Digunakan:**
- Operasi HFT (High-Frequency Trading) di mana hitungan instruksi (*instruction count*) sangat krusial.
- Membaca _hardware performance counters_ seperti `rdtsc` (Time Stamp Counter) untuk *profiling* nanodetik.
- Memanggil _syscall_ kernel kustom atau _context switching_ di OS development / embedded systems.

## Arsitektur & Aliran: ASM Registers
```ascii
Rust Variables         [ Inline Assembly Blok ]         Rust Variables
-------------          ----------------------         --------------
let mut eax = 1; --->  in("eax") eax          --->  (Input: register EAX)
                       cpuid                        (Modifikasi EBX, ECX, EDX)
                       out("ebx") ebx         --->  let ebx: u32;
                       out("ecx") ecx         --->  let ecx: u32;
```

## Kode Production-Ready
Berikut adalah implementasi baca Time Stamp Counter dan fungsi identifikasi CPU vendor.

```rust
#![cfg_attr(nightly, feature(naked_functions))]
use core::arch::asm;

/// Membaca Time Stamp Counter (TSC) dengan penjaga serialisasi
/// (lfence) untuk mencegah out-of-order execution pada instruksi pembacaan waktu.
#[inline(always)]
pub fn read_rdtsc_serialized() -> u64 {
    let low: u32;
    let high: u32;

    // SAFETY: rdtsc dan lfence adalah instruksi valid di x86_64,
    // tidak mengubah state memori kompilator (selain yang di-declare out).
    unsafe {
        asm!(
            "lfence",      // Mencegah instruksi sebelumnya lewat (serializing)
            "rdtsc",       // Menulis ke EDX (high) dan EAX (low)
            "lfence",
            out("eax") low,
            out("edx") high,
            options(nomem, nostack) // Optimasi: beritahu compiler kita ga akses RAM/Stack
        );
    }
    
    ((high as u64) << 32) | (low as u64)
}

/// Struktur informasi dasar CPU
pub struct CpuIdInfo {
    pub ebx: u32,
    pub ecx: u32,
    pub edx: u32,
}

/// Mendapatkan CPU vendor string part.
pub fn get_cpuid(leaf: u32) -> CpuIdInfo {
    let ebx: u32;
    let ecx: u32;
    let edx: u32;

    // SAFETY: cpuid hanya mengubah eax, ebx, ecx, edx.
    // Kita menangkap semua yang diubah.
    unsafe {
        asm!(
            "cpuid",
            inout("eax") leaf => _, // eax diinput lalu dioverwrite (kita abaikan outputnya)
            out("ebx") ebx,
            out("ecx") ecx,
            out("edx") edx,
            options(nomem, nostack)
        );
    }
    
    CpuIdInfo { ebx, ecx, edx }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tsc() {
        let t1 = read_rdtsc_serialized();
        let t2 = read_rdtsc_serialized();
        assert!(t2 >= t1);
    }
}
```

## Anti-Patterns

### 1. Lupa Mendeklarasikan Clobbers
**Bahaya:** Jika instruksi ASM Anda secara internal menggunakan / merusak nilai di dalam suatu register (misalnya RCX), tetapi Anda tidak mendeklarasikan `out("rcx") _`, kompilator akan berasumsi nilai RCX aman. Jika kompilator menyimpan variabel loop counter di RCX, program Anda akan memiliki aliran yang tidak tertebak.
**Solusi:** Daftarkan semua register yang hancur sebagai _clobber_.

```rust
// ANTI-PATTERN
#[cfg(target_arch = "x86_64")]
unsafe fn bad_syscall() {
    let syscall_number = 39; // getpid
    let mut pid: u64;
    // syscall instruction di x86_64 secara arsitektur menghancurkan isi RCX dan R11
    asm!(
        "syscall",
        in("rax") syscall_number,
        out("rax") pid,
        // FATAL: Lupa mendeklarasikan `out("rcx") _` dan `out("r11") _`!
    );
}
```

### 2. Mengakses Memori Lokal di Naked Functions
**Bahaya:** Di dalam fungsi berlabel `#[naked]`, Anda **sama sekali tidak memiliki stack frame** standar. Mengambil argumen Rust normal atau mengalokasikan variabel lokal akan merusak stack pointer atau membaca memori invalid.
**Solusi:** Naked function murni harus mengontrol stack sepenuhnya melalui ASM manual. Argumen dibaca langsung dari register argumen ABI (e.g. `RDI`, `RSI` di SysV ABI).

## Edge Cases & Defensive Engineering
- **Calling Conventions:** Makro `asm!` secara *default* akan menyelipkan kode Anda di dalam fungsi Rust. Ingat bahwa kompilator berhak mengubah _calling convention_ atau *register allocation* Anda. Jangan berasumsi register argumen ABI (e.g. `rdi`) akan sama dengan _binding_ variabel Rust. Selalu gunakan `in("rdi") my_var`.
- **Target Feature:** Instruksi spesifik (seperti AVX512) hanya bisa dipakai jika fitur target CPU tersebut tersedia. Bungkus dengan kondisi makro seperti `#[target_feature(enable = "avx2")]`.
