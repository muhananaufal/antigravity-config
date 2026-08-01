# Branch Prediction & Pipeline CPU di Rust

Dalam sistem High-Frequency Trading (HFT), mikrosekon dan nanosekon adalah penentu kemenangan. Arsitektur CPU modern menggunakan teknik *pipelining* super-scalar dan *branch prediction* untuk mengeksekusi instruksi secara spekulatif di luar urutan (Out-of-Order Execution). Kesalahan tebakan branch (Branch Misprediction) menyebabkan CPU membuang *pipeline flush* yang memakan ~15-20 siklus CPU, menguras latensi berharga.

Teknik optimasi di level kompilator Rust mencakup *branchless programming*, loop unrolling, penggunaan instruksi `std::hint::unreachable_unchecked`, serta hint eksplisit bagi LLVM seperti `#[cold]` dan `#[inline(never)]`.

## Arsitektur CPU Pipeline & Branch Prediction

```ascii
[ Branch History Buffer (BHB) ] ---> [ Fetch ] ---> [ Decode ]
                                                      |
                                                      v
[ Mispredict Flush! ] <--------- [ Execute ] <--- [ Dispatch (OoO) ]
(Cost: 15-20 cycles)                 |
                                     v
                                 [ Retire ]
```

## Produksi-Ready Code: Branchless Algorithms & Cold Paths

Kode di bawah menunjukkan implementasi book-building / order matching sederhana yang meminimalkan percabangan.

```rust
use std::hint::{unreachable_unchecked, black_box};

/// OrderType menggunakan representasi integer untuk mempermudah operasi matematika branchless
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
#[repr(u8)]
pub enum OrderType {
    Buy = 0,
    Sell = 1,
}

pub struct Order {
    pub price: u64,
    pub size: u64,
    pub order_type: OrderType,
}

/// Hint eksplisit pada LLVM bahwa error path ini jarang dieksekusi.
/// Ini memindahkan kode assembly error ke bagian akhir biner (cold section),
/// sehingga instruction cache (L1i) tidak terpolusi oleh instruksi error handling.
#[cold]
#[inline(never)]
fn handle_invalid_order_cold_path(order: &Order) {
    eprintln!("Invalid order size: {}", order.size);
    // Logging metrics, dll.
}

/// Memproses order tanpa branch instruksi bersyarat (cmov di x86).
/// Menggunakan trick matematika.
#[inline(always)]
pub fn update_position_branchless(current_position: &mut i64, order: &Order) {
    if order.size == 0 {
        handle_invalid_order_cold_path(order);
        return;
    }

    // Teknik Branchless:
    // Jika Buy (0), multiplier = 1
    // Jika Sell (1), multiplier = -1
    // multiplier = 1 - (2 * order_type_val)
    let type_val = order.order_type as u8 as i64;
    let multiplier = 1 - (2 * type_val);
    
    *current_position += (order.size as i64) * multiplier;
}

/// Menemukan order maksimum dengan loop yang unrolled dan safe assertions
/// menggunakan hint unreachable untuk optimasi ekstrim LLVM.
pub fn find_max_price(prices: &[u64]) -> u64 {
    if prices.is_empty() {
        return 0;
    }
    
    let mut max_val = prices[0];
    
    // Memberikan hint pada kompilator bahwa bounds check tidak perlu.
    // WARNING: Hanya gunakan ini di hot-path yang ukurannya terjamin.
    for i in 1..prices.len() {
        // SAFETY: Loop index `i` dijamin < `prices.len()` oleh invariant loop iterasi
        let price = unsafe { 
            if i >= prices.len() {
                unreachable_unchecked() 
            } else {
                *prices.get_unchecked(i)
            }
        };
        
        // Operasi branchless MAX.
        // LLVM akan mengkompilasi ini menjadi instruksi CMOV atau MAX inst.
        max_val = max_val.max(price);
    }
    
    max_val
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_branchless_position() {
        let mut pos = 100;
        
        let buy = Order { price: 10, size: 50, order_type: OrderType::Buy };
        update_position_branchless(&mut pos, &buy);
        assert_eq!(pos, 150);

        let sell = Order { price: 10, size: 25, order_type: OrderType::Sell };
        update_position_branchless(&mut pos, &sell);
        assert_eq!(pos, 125);
    }
    
    #[test]
    fn test_find_max() {
        let prices = vec![100, 105, 99, 120, 115];
        assert_eq!(find_max_price(&prices), 120);
    }
}
```

## Anti-Patterns

1. **Penggunaan Branch di dalam Tight Loop (Hot Path)**
   **Mengapa berbahaya:** Menaruh `if-else` dengan probabilitas 50/50 di dalam iterasi loop tingkat jutaan instruksi per detik akan merusak BPU (Branch Predictor Unit). Prediktor tidak bisa mempelajari polanya, sehingga terjadi mispredict konstan yang menghancurkan throughput (latency penalty berlipat ganda).
   ```rust
   // ANTI-PATTERN
   for order in orders {
       if order.is_buy() { // BPU flip-flops!
           pos += order.size;
       } else {
           pos -= order.size;
       }
   }
   ```

2. **Penyalahgunaan `unreachable_unchecked()` Tanpa Invariants**
   **Mengapa berbahaya:** Jika aliran eksekusi sesungguhnya bisa mencapai branch yang ditandai `unreachable_unchecked()`, LLVM akan menganggap state tersebut tidak pernah terjadi dan secara agresif membuang instruksi valid lainnya di sekitar (Time Travel Optimization UB). Ini akan menimbulkan crash atau perilaku yang tidak dapat diprediksi di production.
   ```rust
   // ANTI-PATTERN
   let val = get_user_input(); // Nilai tak terduga!
   if val == 3 {
       unsafe { std::hint::unreachable_unchecked(); } // UB!
   }
   ```

## Edge Cases dan Defensive Programming

1. **L1i Cache Eviction akibat Fat Functions:**
   Fungsi yang sangat panjang karena banyak *inlining* (`#[inline(always)]`) dan error handling akan mendorong L1 instruction cache eviction (L1i miss). Selalu ekstrak error handling ke fungsi terpisah ber-anotasi `#[cold] #[inline(never)]`.

2. **Branch Predictor Aliasing:**
   Jika ada dua percabangan independen di alamat instruksi yang secara modulo berhimpitan di Branch History Table, mereka bisa mengganggu satu sama lain (Aliasing). Walaupun sulit dikontrol dari Rust, reordering statement atau padding (via flag linker) kadang dipakai di HFT C++. Di Rust, memprioritaskan branchless logic lebih diutamakan.

3. **Compiler Auto-Vectorization Defeats Hint:**
   Terkadang kompilator LLVM tidak mengubah percabangan kondisional menjadi `cmov` tetapi tetap mempertahankannya sebagai `jcc` karena analisis biaya. Jika ini kritis, gunakan intrinsik arsitektur (`std::arch`) langsung atau trik bitwise untuk *memaksa* eksekusi bebas cabang.
