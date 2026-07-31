# Formal Memory Model & Atomics

## Konsep Utama dan Penggunaan
Ketika dua *thread* berjalan secara paralel pada berbagai core (atau bahkan diurutkan ulang oleh compiler LLVM), urutan eksekusi memori tidak terjamin sesuai tulisan di source code.
Rust mewarisi **C++20 Memory Model** untuk mensinkronisasi visibilitas data antar thread. Ada empat model ordering utama yang dideklarasikan lewat parameter di operasi atomics (seperti `fetch_add`):
- `Relaxed`: Tidak ada sinkronisasi, instruksi bebas di-*reorder*. Super cepat, bagus untuk metrik counter sederhana.
- `Acquire` & `Release`: Membangun hubungan *Happens-Before*. Berguna pada arsitektur *Producer-Consumer* dan *Locks*.
- `SeqCst` (Sequentially Consistent): Sinkronisasi global yang paling ketat dan berat secara performa. 

## Arsitektur: Happens-Before Relationship
```text
      Thread 1 (Producer)                 Thread 2 (Consumer)

   1. Tulis data ke X = 42;
   2. Attr.store(true, Release);  --+
                                    | (Membangun happens-before)
                                    V
                                  3. Attr.load(Acquire) == true
                                  4. Baca data X. (Dijamin melihat 42)
                                  
Semua instruksi sebelum `Release` (Instruksi 1) TIDAK BOLEH 
dipindah compiler/CPU ke setelah `Release`. 
Semua sesudah `Acquire` (Instruksi 4) TIDAK BOLEH dipindah ke sebelumnya.
```

## Kode Production-Ready: Atomic Producer-Consumer
```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

pub struct SharedFlag {
    data: i32,
    ready: AtomicBool,
}

impl SharedFlag {
    pub fn new() -> Self {
        Self {
            data: 0,
            ready: AtomicBool::new(false),
        }
    }
}

pub fn producer_consumer_sync() {
    // Kita menembus aturan strict Rust untuk mensimulasikan pointer unsafe
    // yang dijaga murni oleh atomics memori.
    let shared = Box::leak(Box::new(SharedFlag::new()));

    // Thread Producer
    let t1 = thread::spawn(move || {
        // Tulis data. (Non-atomic memory operation)
        unsafe {
            let mutable_ref = &mut shared.data as *mut i32;
            *mutable_ref = 42;
        }

        // Release: Mempublikasikan perubahan ke sistem memori.
        // Semua write (seperti mutasi shared.data = 42 di atas) dijamin
        // TUNTAS di cache sebelum flag ini dipasang.
        shared.ready.store(true, Ordering::Release);
    });

    // Thread Consumer
    let t2 = thread::spawn(move || {
        // Spin-wait membaca indikator kesiapan.
        // Acquire: Menunggu publisitas dari Release. 
        while !shared.ready.load(Ordering::Acquire) {
            std::hint::spin_loop();
        }

        // Pada titik ini, Release-Acquire pair sukses.
        // Maka, semua memori *sebelum* Release sekarang 100% visible ke thread ini.
        unsafe {
            let data_ref = &shared.data as *const i32;
            assert_eq!(*data_ref, 42);
            println!("Data safely consumed: {}", *data_ref);
        }
    });

    t1.join().unwrap();
    t2.join().unwrap();
    
    // Cleanup leak manual
    unsafe { Box::from_raw(shared as *mut SharedFlag); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_ordering() {
        producer_consumer_sync();
    }
}
```

## Anti-Patterns

1. **Overuse `SeqCst` di Hot Path**
   - *Bahaya*: Setiap kali ragu, developer Rust sering menggunakan `Ordering::SeqCst` dengan pikiran "yang paling aman". Pada x86 (arsitektur x86 adalah TSO - *Total Store Order*), perbedaannya mungkin tipis. Tapi pada prosesor ARM (Apple M1/M2, AWS Graviton), `SeqCst` menyisipkan perintah `DMB ISH` memori barrier penuh yang sangat menguras *pipeline* CPU dan mematikan optimasi reordering.
   - *Solusi*: Ganti `SeqCst` dengan `Acquire/Release` untuk *message passing*, dan `Relaxed` untuk *counter* (seperti `fetch_add` pada metrik statistik).

2. **Acquire/Release tanpa Ketergantungan Data**
   - *Bahaya*: Memanfaatkan sepasang `Acquire/Release` untuk menyinkronkan data yang bahkan tidak saling berhubungan secara struktural/kausalitas, atau mengira itu adalah mekanisme "mengunci" thread.
   - *Solusi*: Model ordering bukan *Locks*. Atomics sinkronisasi harus mendirikan *Visibility*. Jika Anda tidak memodifikasi data mentah dan murni mengupdate metrik tunggal, `Relaxed` adalah yang benar.

## Edge Cases & Defensive Engineering
- **X86 TSO Fallacy (The Architecture Trap)**: Arsitektur x86 secara hardware memiliki model konsistensi memori yang sangat kuat (Total Store Order). Jika Anda menguji kode atomics dengan memory order yang *salah* (mis. `Relaxed` di tempat yang butuh `Release`), di CPU lokal Intel/AMD Anda, tidak akan terjadi bug sama sekali! Namun begitu dideploy ke AWS ARM Graviton atau diproses oleh optimizer LLVM yang super agresif, aplikasi akan mengalami *Data Race* yang gaib dan acak. Selalu patuhi standar formal.
- **Fences**: Di algoritma sinkronisasi ekstrim (seperti dek seqlock yang canggih), seringkali `compiler_fence(Ordering::SeqCst)` atau instruksi perangkat keras murni diperlukan untuk mencegah register reordering.
