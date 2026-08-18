# Parking Lot, RwLock & Mutex Poisoning

## Konsep Utama
Standar library `std::sync::Mutex` dan `RwLock` didasarkan pada OS primitives (seperti `pthread_mutex` di pthreads). Implementasi OS seringkali bengkak ukurannya dan lambat (membutuhkan syscall yang berat).

Crate **`parking_lot`** adalah standar de-facto industri di ekosistem Rust untuk sinkronisasi thread. `parking_lot::Mutex` jauh lebih kecil (hanya 1 byte status overhead), sangat cepat (lock-free fast path tanpa syscall jika tidak ada kontensi), dan menghindari konsep menjengkelkan bernama **Lock Poisoning**.

**Catatan Khusus (Async):** Anda **tidak boleh** menahan Mutex sinkron (`std` atau `parking_lot`) melintasi titik `.await`. Gunakan `tokio::sync::Mutex` *hanya* jika terpaksa menahan lock melewati await. Jika hanya memodifikasi shared memory secara cepat, `parking_lot` di dalam asinkron adalah pilihan utama untuk efisiensi CPU.

## Arsitektur & Flow (RwLock Read-Starvation)
```ascii
Masalah klasik RwLock OS:
T1 (Read Lock) ---> [Granted]
T2 (Write Lock) --> [Waiting] (menunggu T1)
T3 (Read Lock) ---> [Granted] (mendapat lock karena saat ini Read sedang aktif)
T4 (Read Lock) ---> [Granted]
... Write (T2) selamanya lapar (Starvation)

Solusi parking_lot:
T1 (Read)  ---> [Granted]
T2 (Write) ---> [Waiting] (parking_lot mengaktifkan Write-Priority)
T3 (Read)  ---> [Waiting] (diblokir karena ada Write di antrean)
T1 Selesai ---> T2 (Write) [Granted] ! Starvation dihindari.
```

## Kode Production-Ready

```rust
use parking_lot::{Mutex, RwLock, Condvar};
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
pub struct DataCache {
    // RwLock cocok digunakan untuk struktur data yang 90% di-Read dan 10% di-Write
    config: RwLock<String>,
    // Mutex standar parking_lot
    access_count: Mutex<u64>,
}

impl DataCache {
    pub fn get_config(&self) -> String {
        // Mendapatkan Read Lock (beberapa thread bisa memiliki ini sekaligus)
        let lock = self.config.read();
        
        // Memodifikasi inner state Mutex
        // Lock tidak perlu `.unwrap()` karena parking_lot tidak mengenal lock poisoning
        *self.access_count.lock() += 1;
        
        lock.clone()
    }

    pub fn update_config(&self, new_val: String) {
        // Mendapatkan Write Lock (eksklusif, memblokir thread Read dan Write lainnya)
        let mut lock = self.config.write();
        *lock = new_val;
        // lock dilepas otomatis (RAII)
    }
}

/// Mencontohkan penggunaan Condvar untuk mensinkronkan thread pekerja
pub struct JobQueue {
    queue: Mutex<Vec<String>>,
    cvar: Condvar,
}

impl JobQueue {
    pub fn wait_for_job(&self) -> String {
        let mut lock = self.queue.lock();
        
        // Loop ini penting! Hindari "Spurious Wakeup" dari sistem operasi.
        while lock.is_empty() {
            // Tunggu sampai ada notifikasi dari cvar. 
            // Secara internal melepaskan lock, menidurkan thread, 
            // dan mengambil lock kembali saat terbangun.
            self.cvar.wait(&mut lock);
        }
        
        lock.remove(0)
    }

    pub fn push_job(&self, job: String) {
        let mut lock = self.queue.lock();
        lock.push(job);
        // Beritahu 1 thread yang sedang tertidur di `wait` (jika ada)
        self.cvar.notify_one(); 
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_datacache() {
        let cache = DataCache::default();
        cache.update_config("Versi 2".into());
        assert_eq!(cache.get_config(), "Versi 2");
    }

    #[test]
    fn test_condvar() {
        let jq = Arc::new(JobQueue {
            queue: Mutex::new(Vec::new()),
            cvar: Condvar::new(),
        });

        let jq_clone = jq.clone();
        let handle = thread::spawn(move || {
            jq_clone.wait_for_job()
        });

        thread::sleep(Duration::from_millis(10));
        jq.push_job("Kerja1".into());

        assert_eq!(handle.join().unwrap(), "Kerja1");
    }
}
```

## Anti-Patterns

1. **Menahan Mutex melintasi `.await`**
   - **Contoh:** `let lock = mu.lock(); call_db().await; *lock += 1;`
   - **Bahaya:** Lock yang dipegang saat thread di-yield (akibat await) dapat diblokir. Pekerja (worker) yang mengambil alih thread tersebut dan mencoba mengambil Lock yang sama akan mengakibatkan **Deadlock absolut**. Kompiler Rust untungnya sering menangkap ini karena `MutexGuard` dari OS/parking_lot tidak mengimplementasikan `Send`.
   - **Solusi:** Lepaskan (drop) mutlak guard sebelum await (menggunakan blok scope `{ let _g = mu.lock(); ... }`), atau ganti dengan `tokio::sync::Mutex` (meski tokio mutex lambat dan mahal, ia aman melewati await).

2. **Lupa Membungkus Condvar Wait dalam `while` Loop**
   - **Bahaya:** `if queue.is_empty() { cvar.wait(&mut lock); }`. OS memiliki fenomena yang dikenal sebagai *Spurious Wakeup* di mana thread terbangun dari tidur tanpa alasan logis (tanpa adanya notifikasi condvar). Jika tidak dicek kembali kondisinya, program Anda akan panik (`Index out of bounds`) karena antrean faktanya masih kosong.
   - **Solusi:** Selalu gunakan loop kondisional `while condition { cvar.wait() }`.

## Edge Cases & Defensive Programming
- **Lock Poisoning (`std::sync::Mutex`):** Di standar lib, jika sebuah thread melakukan operasi panic saat memegang Mutex, lock akan ditandai "Poisoned". Pengambilan lock selanjutnya akan melempar `Err`. Niat awalnya bagus (melindungi state data yang inkonsisten akibat panic), namun praktiknya ini rumit di-handle. `parking_lot` memilih filosofi "Panic = kill thread/process" atau mendelegasikan developer untuk menangani state internal.
- **Reentrant Mutex:** Crate parking_lot menyediakan `ReentrantMutex` yang memungkinkan thread yang sama untuk mengambil (lock) ulang Mutex yang sama tanpa deadlock. Ini berguna untuk pemanggilan fungsi rekursif yang kompleks, tetapi harus digunakan secara hati-hati karena sering mengaburkan flow kepemilikan status.
