# Statistical Benchmarking with Criterion & Flamegraph Integration

## Konsep Mendalam
Dalam rekayasa perangkat lunak berperformansi tinggi, pengujian performa primitif menggunakan penghitungan selang waktu manual (misal `std::time::Instant::now().elapsed()`) sangat Rentan terhadap kegaduhan lingkungan eksternal (*noise*). Fluktuasi dari penjawalan sistem operasi (*OS scheduler*), variasi frekuensi CPU (*thermal throttling*), transisi *Garbage Collection/Allocator overhead*, dan interupsi latar belakang menghasilkan angka metrik palsu yang tidak stabil dan membatalkan keaslian optimasi.

`criterion` adalah kerangka kerja pengujian ilmiah berstandar industri untuk Rust yang mengaplikasikan analisis statistik murni (*Student's t-test*, *bootstrap hypothesis testing*, dan *regresi linear*) terhadap sampel iterasi komputasi eksekusi Anda. Dengan membandingkan metrik eksekusi masa kini melawan catatan dasar riwayat terdahulu (*baseline metrics*), Criterion secara obyektif mendeteksi regresi atau perbaikan performa dengan tingkat kepercayaan 95%. Dibarengi integrasi pembuatan *Flamegraph* (via `criterion-partf` atau profiler perangkat keras seperti `perf` di Linux / `DTrace` di macOS), para teknisi dapat membedah tumpukan pemanggilan (*stack trace*) untuk langsung menemukan lempeng titik terburuk yang memakan CPU terbanyak pada *hot path*.

### Elemen Utama Benchmarking Kritis
- **`black_box` Optimization Blinder**: Kompiler LLVM luar biasa ganas dalam melumpuhkan perhitugan mati (*dead code elimination*). Jika argumen pengujian statis atau nilai kembalian fungsi diabaikan, LLVM akan langsung menyeka seluruh kode Anda dari biner akhir! Wrapping parameter input dan kembalian output di dalam `std::hint::black_box` (atau `criterion::black_box`) menipu kompiler agar menganggap nilai tersebut dapat dirubah sewaktu-waktu oleh perangkat luar, menjamin kalkulasi dikerjakan secara nyata.
- **Throughput Profiling**: Pengujian tidak sekadar mencari jumlah detik per iterasi, tetapi mengestimasi laju olah data riel seperti Bytes per detik (`Throughput::Bytes`) atau Jumlah elemen per detik (`Throughput::Elements`).

---

## Arsitektur Alur Uji Statistik & Flamegraph

```ascii
[ Rust Code Target ]
        │
        ├───( Black Box Wrapping Input & Output )
        ▼
[ Criterion Execution Engine ] ──( 100+ Warmup & Measured Iterations )
        │
        ├───> [ Bootstrap Statistical Analysis ] ──> ( T-Test vs Baseline ) ──> [ HTML Statistical Reports ]
        │
        └───> [ Stack Sampling (perf/dtrace) ] ────> ( Stack Folding ) ───────> [ SVG Interactive Flamegraph ]
```

### Pemetaan Anatomi Profil Flamegraph

```ascii
+------------+-------------------------------------------------------------+
| main       | criterion_harness::execute_test                           |
+------------+-------------+-----------------------------------------------+
             | alloc::box  | my_crate::kalkulasi_vektor_intensif [HOT PATH]| <- Fokus Optimasi!
             +-------------+-----------------------+-----------------------+
                           | std::simd::avx2_add   | memcmp                |
                           +-----------------------+-----------------------+
```

---

## Implementasi Kode Produksi & Harness

Below is a complete implementation of a targeted module alongside an exhaustive statistical benchmark test harness utilizing Criterion and best practices.

```rust
// File: src/lib.rs
use std::hint::black_box;

/// Struktur data pesanan untuk diuji dalam skenario sistem mesin pemrosesan pesat.
#[derive(Clone, Debug, PartialEq)]
pub struct PesananFinansial {
    pub id: u64,
    pub harga: f64,
    pub volume: u32,
    pub aktif: bool,
}

/// Fungsi komputasi berskala linier untuk dipasang pada pengukur statistik.
pub fn proses_agregasi_pesanan(daftar_pesanan: &[PesananFinansial]) -> f64 {
    let mut total_valuasi = 0.0;
    for pesanan in daftar_pesanan {
        if pesanan.aktif {
            total_valuasi += pesanan.harga * f64::from(pesanan.volume);
        }
    }
    total_valuasi
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validasi_logika_agregasi() {
        let sampel = vec![
            PesananFinansial { id: 1, harga: 100.0, volume: 10, aktif: true },
            PesananFinansial { id: 2, harga: 50.0, volume: 20, aktif: false },
            PesananFinansial { id: 3, harga: 200.0, volume: 5, aktif: true },
        ];
        // Hanya id 1 (100*10=1000) dan id 3 (200*5=1000) yang dihitung = 2000.0
        let hasil = proses_agregasi_pesanan(&sampel);
        assert_eq!(hasil, 2000.0, "Kalkulasi valuasi aktif wajib presisi");
    }
}
```

Berikut adalah rancangan file penguji eksternal Criterion untuk ditempatkan pada `benches/agregasi_benchmark.rs`:

```rust
// File: benches/agregasi_benchmark.rs
use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use my_crate::{proses_agregasi_pesanan, PesananFinansial};
use std::time::Duration;

fn konfigurasi_dataset_sampel(jumlah: usize) -> Vec<PesananFinansial> {
    (0..jumlah)
        .map(|i| PesananFinansial {
            id: i as u64,
            harga: 120.50 + (i % 10) as f64,
            volume: (i % 50 + 1) as u32,
            aktif: i % 3 != 0,
        })
        .collect()
}

fn benchmark_kalkulasi_valuasi(c: &mut Criterion) {
    let dataset_besar = konfigurasi_dataset_sampel(10_000);
    
    let mut grup = c.benchmark_group("agregasi_transaksi");
    // Mengatur target waktu pengujian dan toleransi pemanasan awal
    grup.warm_up_time(Duration::from_millis(500));
    grup.measurement_time(Duration::from_secs(3));
    grup.sample_size(100);

    // Mendaftarkan laju proses berdasarkan ukuran volume input
    grup.throughput(Throughput::Elements(dataset_besar.len() as u64));

    grup.bench_function("agregasi_10k_elemen", |b| {
        // b.iter menjamin pengujian dijalankan berulang kali untuk signifikansi statistik
        b.iter(|| {
            let hasil = proses_agregasi_pesanan(black_box(&dataset_besar));
            // Mencegah LLVM menghapus perhitungan hasil variabel akhir
            black_box(hasil);
        })
    });

    grup.finish();
}

criterion_group!(benches, benchmark_kalkulasi_valuasi);
criterion_main!(benches);
```

---

## Anti-Patterns Kritis

### 1. Pengabaian Pembungkusan Black Box pada Argumen Statis
- **Penjelasan**: Memanggil fungsi di dalam `b.iter(|| super_fast_func(&my_const_vec))` tanpa membungkus `my_const_vec` atau nilai balik eksekusinya dengan `black_box(..)` dari `std::hint` / `criterion`.
- **Bahaya**: LLVM menyadari bahwa array konstan yang Anda kirimkan tidak pernah termodifikasi dan hasilnya pun tidak pernah dibaca ekosistem luar. Optimiser membuang kalkulasi tersebut dalam hitungan nanodetik sesaat sebelum eksekusi dimulai. Laporan Anda akan salah menyuguhkan waktu pengerjaan 0.0001 picoseconds — kebohongan total (*phantom benchmark*).
- **Solusi**: Bungkus setiap masukan referensi parameter input serta penampung output instan menggunakan `black_box(...)`.

### 2. Membiarkan Mutasi Heap Allocation Langsung Bertengger di Dalam Loop Eksekusi `iter()`
- **Penjelasan**: Menulis `b.iter(|| { let mut v = Vec::with_capacity(1000); fill_data(&mut v); process(&v); })`.
- **Bahaya**: Angka latensi kumulatif Anda yang direkam oleh sistem pengukur statistik akan kotor terpolusi oleh waktu tunda sistem operasi dalam mencarikan blok memori kosong baru pada heap memory (`malloc`/`jemalloc`), bukan menggambarkan laju asli pemantapan algoritma komputasi `process()`.
- **Solusi**: Pindahkan inisiasi pembuatan vektor atau alokasi ke ruang pemanasan (*setup stage*) atau panggil fasilitas `iter_batched()` / `iter_with_setup()` untuk memutus hubungan antara proses instalasi data awal dengan waktu penghitungan target aktual.

---

## Edge Cases & Defensive Programming

1. **Throttling Frekuensi Prosesor akibat Suhu Panas (Thermal Variance)**:
   Menjalankan ratusan iterasi bertingkat selama puluhan menit memeras kinerja maksimum Core CPU anda. Jika kipas pendingin gagal menjaga stabilitas temperatur, mekanisme *Thermal Throttling* pada motherboard akan menurunkan frekuensi CPU (*clock scaling*) dari 4.5GHz ke 2.0GHz di tengah jalannya pengetesan tes ke-40. Ini membatalkan kredibilitas angka stdev statistik Anda dan melancarkan peringatan regresi palsu. Selalu matikan teknologi *Intel Turbo Boost / AMD Precision Boost* atau tetapkan penjajagan CPU ke profil eksekusi statis melalui Governor saat mengaudit CI di peladen produksi.

2. **Kegaduhan Latar Belakang Antrean Thread OS**:
   Ketika mengukur komputasi level nanodetik (< 100ns per eksekusi), interupsi jaringan pendek dari pengirim latar atau perpindahan penjadwalan (*thread migration/preemption*) dari OS akan melumpuhkan kurva Gaussian sampel penguji. Untuk mengurangi anomali *outliers* yang terlalu ekstrem, ikatkan (*pinning*) proses pengetesan Anda ke salah satu core fisik prosesor secara terisolasi via `core_affinity` dan non-aktifkan servis penjaga latar sistem operasi sewaktu melakukan verifikasi rilis *milestone*.

3. **Kompresi Stack Flamegraph pada Inline Fungsi Sangat Sering**:
   Saat mengekspor grafik SVG Flamegraph, Anda terkadang merasa heran karena fungsi krusial yang dicurigai lamban justru lenyap tak bertanda di pohon *trace view*. Ini terjadi karena kompiler Rust melebur fungsi pendek langsung ke tubuh induk melalui *aggressive inlining*, sehingga sistem *profiler* kehilangan referensi simbol (*vtable frames*). Sewaktu sedang fokus membentang visualisasi Flamegraph investigatif, sematkan sementara deklarasi `#[inline(never)]` pada calon target fungsi suspect agar batasan namanya tegak tegap tercantum secara grafis dalam diagram susun *stack folding*.
