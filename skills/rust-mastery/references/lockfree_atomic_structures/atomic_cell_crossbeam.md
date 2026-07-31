# AtomicCell & Memory Ordering (Crossbeam)

## Konsep Utama
Rust standar (`std::sync::atomic`) hanya menyediakan operasi atomik untuk angka biner primitif (`AtomicUsize`, `AtomicBool`, dll). Jika kita ingin membuat custom `Copy` struct menjadi atomik tanpa Mutex, kita perlu manipulasi pointer dan OS-level spinlock yang merepotkan. `crossbeam::atomic::AtomicCell<T>` mengatasi ini. Ia menganalisis ukuran `T` secara statik; jika ukurannya pas ke *machine word* atau lock-free atomic registers pada arsitektur target (seperti 8-byte CMPXCHG di x64), ia memakai `AtomicUsize` dan mentransmutasi. Jika tipe terlalu besar (misal array 32 byte), ia secara elegan mem-fallback (jatuh kembali) pada *global hashed spinlock*, menjamin keamanan thread.

## Arsitektur & Fallback Mechanism

```text
    Struct T (e.g., [u8; 8] vs [u8; 32])
                 |
                 v
   +-----------------------------+
   |  AtomicCell<T> constructor  |
   +-----------------------------+
                 |
         Is size_of<T>() <= 8? (On 64-bit arch)
                 |
        Yes /          \ No
           /            \
+----------------+    +--------------------------+
| Lock-Free      |    | Global Array Lock        |
| Atomic (Trans- |    | (SeqLock / SpinLock Fall-|
| mute to u64)   |    | back per memory address) |
+----------------+    +--------------------------+
```

## Production-Ready Code

```rust
use crossbeam_utils::atomic::AtomicCell;
use std::sync::Arc;
use std::thread;

/// Struct Copy-able yang merepresentasikan konfigurasi ringkas.
/// Di arsitektur 64-bit, struct ini memakan 8 byte (4+4),
/// jadi AtomicCell akan SEPENUHNYA LOCK-FREE!
#[derive(Copy, Clone, Debug, PartialEq)]
struct ConfigMetrics {
    active_connections: u32,
    error_rate: f32, // f32 memakan 4 byte
}

pub struct SystemState {
    // Membungkus custom struct dalam AtomicCell
    metrics: AtomicCell<ConfigMetrics>,
}

impl SystemState {
    pub fn new() -> Self {
        Self {
            metrics: AtomicCell::new(ConfigMetrics {
                active_connections: 0,
                error_rate: 0.0,
            }),
        }
    }

    pub fn update_connections(&self, count: u32) {
        // fetch_update: CAS loop aman dengan closure, sangat idomatis
        self.metrics.fetch_update(|mut current| {
            current.active_connections = count;
            Some(current)
        }).unwrap();
    }

    pub fn read_state(&self) -> ConfigMetrics {
        self.metrics.load() // Ordering::SeqCst by default di AtomicCell load()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_cell_metrics() {
        // Bukti statik bahwa struct ini didukung lock-free secara natif oleh crossbeam
        assert!(AtomicCell::<ConfigMetrics>::is_lock_free());

        let state = Arc::new(SystemState::new());
        let state_clone = state.clone();

        let t1 = thread::spawn(move || {
            state_clone.update_connections(150);
        });

        t1.join().unwrap();
        let result = state.read_state();
        assert_eq!(result.active_connections, 150);
        assert_eq!(result.error_rate, 0.0);
    }
}
```

## Anti-Patterns

1. **Terkejut dengan Hidden Spinlocks di Embedded/Real-Time**
   - *Deskripsi*: Menggunakan `AtomicCell<T>` untuk tipe besar (misal matriks 256 byte) di konteks interrupt handler atau Real-Time Operating System.
   - *Mengapa Berbahaya*: `AtomicCell` di-desain aman, jadi tipe memori raksasa ini akan memicu *SeqLock* di belakang layar. Jika ditaruh di handler IRQ, dan thread kernel OS sedang memegang spinlock, IRQ mencoba membaca `load()` lalu tersangkut (deadlock IRQ-Kernel), menghancurkan hard-realtime guarantee. Selalu gunakan `is_lock_free()` as assert untuk validasi desain.

2. **AtomicCell untuk Tipe dengan Destructor (`Drop`)**
   - *Deskripsi*: Memasukkan `String` atau custom type dengan `Drop` ke dalam AtomicCell.
   - *Mengapa Berbahaya*: `AtomicCell` *wajib* mengharuskan batasan `T: Copy` (atau di versi baru `T: Send + Sync` asalkan no drop). Transmutasi bitwise di atas memori tak mentrigger Drop semantics dengan sempurna tanpa resiko memori bocor (leaks).

## Edge Cases & Defensive Programming

- **`AtomicConsume` ordering on ARM**: `crossbeam` mendefinisikan Ordering::Consume sebagai load-data dependencies (berguna di arsitektur ARM/PowerPC untuk mencegah pembatasan flush cache berlebih). Namun, compiler LLVM masih menaikkan `Consume` menjadi `Acquire`. Anda harus sadar hardware performance akan sedikit termutilasi akibat keterbatasan compiler backend (LLVM) saat ini.
- **Partial Updates vs Data Tearing**: fetch_update menjamin tipe `ConfigMetrics` 8-byte selalu diupdate penuh. Tidak pernah terjadi pembacaan dimana connection update baru, tapi error rate terpotong dari epoch sebelumnya, berbeda jika di-split menjadi dua `AtomicU32`.
