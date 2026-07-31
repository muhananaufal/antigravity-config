# Benchmarking Tepat dengan `criterion`

## 1. Konsep Utama & Kapan Digunakan
Dalam optimasi performa Rust, Anda tidak boleh menggunakan module standar `std::time::Instant` secara naif dalam loop `for` karena compiler bisa meng-optimize-out (membuang) kode Anda secara diam-diam.
`criterion` adalah library pembuat *micro-benchmark* mutakhir yang kebal (resilient) terhadap noise sistem/OS, memiliki deteksi perubahan (regresi statistik), dan membangun *flamegraph* secara otomatis.

Gunakan `criterion` ketika:
- Membandingkan performa dua algoritma berbeda (contoh: regex vs iterasi karakter manual).
- Mendeteksi regresi performa (performance regressions) di CI Pipeline ketika ada Pull Request baru masuk.
- Mengukur throughput dari rutin I/O atau komputasi paralel.

## 2. Arsitektur / Flow

```ascii
[ Cargo Bench ] -> [ Criterion Engine ]
                          |
             (Warm-up -> Measurement -> Statistical Analysis)
                          |
             +------------+-------------+
             v                          v
    [ Terminal Output ]         [ target/criterion/report/index.html ]
   (Detects % diff changes)     (Graphical Plots / Throughput / Flamegraphs)
```

## 3. Kode Rust Production-Ready

```toml
# Di Cargo.toml
[dev-dependencies]
criterion = "0.4"

[[bench]]
name = "my_benchmark"
harness = false # Mencegah test harness bawaan rustc untuk campur tangan
```

```rust
// File: benches/my_benchmark.rs
use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput, BenchmarkId};

// Fungsi bodoh yang ingin kita ukur
fn fibonacci(n: u64) -> u64 {
    match n {
        0 => 1,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}

pub fn criterion_benchmark(c: &mut Criterion) {
    // Basic benchmarking
    // black_box memberitahu compiler LLVM untuk tidak menebak (optimize-out) 
    // argumen maupun hasil eksekusi (seakan-akan datanya dinamis di runtime).
    c.bench_function("fib 20", |b| b.iter(|| fibonacci(black_box(20))));
}

pub fn bench_parametric(c: &mut Criterion) {
    let mut group = c.benchmark_group("Fibonacci Group");
    
    // Benchmark sebuah array of values
    for i in [10, 20, 30].iter() {
        group.bench_with_input(BenchmarkId::new("Recursive", i), i, |b, i| {
            b.iter(|| fibonacci(black_box(*i)))
        });
    }
    
    // Set throughput untuk melihat laporan MB/s / elemen/detik
    group.throughput(Throughput::Elements(1));
    group.finish();
}

// Registrasi grup
criterion_group!(benches, criterion_benchmark, bench_parametric);
criterion_main!(benches);
```

## 4. Anti-Pattern Spesifik
1. **Lupa membungkus param/return di dalam `black_box()`.**
   - *Bahaya*: Jika fungsi tidak bergantung input eksternal atau efek samping, compiler LLVM akan menghitung hasilnya sewaktu *compile-time* dan menggantinya dengan nilai konstan. Benchmark Anda akan menunjukkan durasi 0 nanoseconds.
   - *Solusi*: Selalu gunakan `black_box` pada argumen dan hasil yang dipantau dalam `iter()`.
2. **Benchmark kode yang melakukan disk I/O / database di mesin developer yang sibuk.**
   - *Bahaya*: Variansi (noise) akan sangat tinggi karena bergantung pada antrian IO OS yang sibuk oleh aplikasi lain (browser, docker).
   - *Solusi*: Benchmark macro/micro di lingkungan terkontrol atau matikan service yang memakan background resource. Criterion akan memberi warning jika variansi *outliers* tinggi.

## 5. Edge Cases & Defensive Programming
- **Async Benchmarking**: Criterion native bersifat sinkron. Untuk membencmark fungsi `async`, Anda harus menyiapkan runtime (seperti Tokio) di dalam blok test dan menggunakan `b.to_async(Runtime).iter(...)`. Peringatan: setup runtime meng-overhead sedikit durasi, pastikan fungsional core terisolasi dengan baik.
- **Profiling**: Criterion bisa dipasangkan dengan profiler seperti `pprof` di Linux (via crate `criterion-pprof`) untuk meng-output data Flamegraph secara otomatis bersamaan dengan jalannya cargo bench, memperlihatkan tepat di baris mana CPU menghabiskan waktu terbanyak.
