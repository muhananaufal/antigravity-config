# Panduan Mendalam: Strategi Pengujian Procedural Macro di Rust

## 1. Konsep Utama & Arsitektur
Menulis pengujian (testing) untuk *procedural macros* sangat berbeda dengan pengujian fungsi reguler. Macro beroperasi pada fase *compile-time* dan menghasilkan kode. Jika terjadi kesalahan kompilasi yang *disengaja* akibat pembatasan domain spesifik, kita tidak bisa mengujinya dengan assert runtime biasa (karena kompilasi akan gagal total).
Oleh karena itu, standar industri untuk pengujian makro menggunakan:
- **`trybuild`**: Untuk *compile-fail* dan *ui tests*, memastikan bahwa pesan error makro yang diberikan ke developer memiliki span/lokasi dan pesan yang benar.
- **`cargo-expand` / snapshotting**: Untuk *pass tests*, memastikan bahwa token keluaran (hasil ekspansi makro) sama persis dengan snapshot yang diizinkan (mencegah regresi semantik tersembunyi).

### 1.1 Diagram Alur Snapshot Testing Macro
```ascii
[ Test Suite `trybuild` ] 
           |
           v
+--------------------------+          [ Success Test Case (.rs) ]
| Compile Test Harness     | ------->  (Expect Compile Pass) ---> [ Snapshot Diff Check ]
| (Spawn `rustc` process)  | 
+--------------------------+ 
           |
           v
[ Compile-Fail Test Case ]
           |
           v
 [ `rustc` Emits Error ] 
           |
           v
+--------------------------+
| Match against .stderr    | ---> [ Error Msg & Span Validation ]
| Snapshot File            |
+--------------------------+
```

## 2. Implementasi Produksi (Zero-Clippy Warnings, Fully Tested)
Berikut adalah pola standar *golden master* atau ui-testing dengan `trybuild`.
Biasanya, test ini diletakkan di direktori `tests/` di level *crate root* makro.

```rust
// tests/ui_tests.rs
// Dependencies di Cargo.toml:
// [dev-dependencies]
// trybuild = "1.0"
// rustversion = "1.0" // Untuk mengunci versi rustc agar error match konsisten

#[cfg(test)]
mod macro_tests {
    /// Mengorkestrasi tes kompiler untuk procedural macro.
    #[test]
    fn test_ui_macros() {
        let t = trybuild::TestCases::new();
        
        // 1. Uji skenario sukses. Memastikan makro dapat dikompilasi (pass).
        // File pass/01-basic-usage.rs berisi implementasi yang harus berhasil.
        t.pass("tests/ui/pass/*.rs");
        
        // 2. Uji skenario gagal. Memastikan pesan error memiliki letak yang akurat.
        // File fail/01-invalid-args.rs berisi implementasi yang melanggar aturan makro.
        // `trybuild` akan mencari file .stderr pendamping untuk mencocokkan error yang dihasilkan `rustc`.
        t.compile_fail("tests/ui/fail/*.rs");
    }
}

// Simulasi: tests/ui/fail/01-invalid-args.rs (Isi dari file test-case)
/*
use my_macro_crate::MyCustomMacro;

#[derive(MyCustomMacro)]
struct InvalidStruct {
    // Skenario: Makro mengharuskan atribut `#[id]` ada, namun tidak ditemukan.
    name: String, 
}

fn main() {}
*/

// Simulasi: tests/ui/fail/01-invalid-args.stderr (Isi snapshot file)
/*
error: Expected #[id] attribute on at least one field for MyCustomMacro
 --> tests/ui/fail/01-invalid-args.rs:4:1
  |
4 | struct InvalidStruct {
  | ^^^^^^^^^^^^^^^^^^^^
*/
```

## 3. Anti-Patterns Kritis

### 3.1. Parsing Kesalahan secara Manual Berbasis String (`String::contains`)
**Buruk:** Mencoba mengambil token stream sebagai string dan menggunakan regex atau `.contains()` untuk memvalidasi output `TokenStream::to_string()`.
**Alasan:** Representasi spasi dari token bisa bervariasi bergantung pada *compiler internals*. Pengujian ini sangat *flaky* (mudah gagal secara acak). Selain itu, ia gagal menangkap relasi `Span` pada error lint.
**Solusi:** Gunakan `trybuild` atau `macrotest` yang mendelegasikan parsing token ke kompiler `rustc` sesungguhnya dan mengevaluasi pohon sintaks abstrak melalui snapshot.

### 3.2. Mengabaikan *Compile-Fail* Test dalam CI
**Buruk:** Hanya membuat pengujian di mana makro berhasil dieksekusi (happy path).
**Alasan:** Makro seringkali menangani *developer input* yang buruk (contoh: tipe generik yang tidak kompatibel). Tanpa *compile-fail tests*, saat Anda mengubah alur parsing `syn`, Anda mungkin tanpa sadar menyebabkan Rust *panic!* di tengah eksekusi makro daripada memberikan `syn::Error::into_compile_error()`. Ini menghasilkan pengalaman *developer (DX)* yang buruk karena menunjuk ke *internal panic* alih-alih file sumber mereka.

## 4. Edge Cases dalam Skala Produksi

### 4.1. Pergeseran Format Error Antar Versi Rustc
Pesan error pada *compiler* tidak dijamin stabil antara rilis `rustc` (misal Rust 1.70 vs 1.75). Teks `stderr` yang dimonitor oleh `trybuild` bisa gagal secara massal saat Anda meng-upgrade Rust di server CI.
**Solusi:** Gunakan atribut dari crate `rustversion` seperti `#[rustversion::attr(nightly, ignore)]` atau jalankan UI test hanya pada *pinned stable toolchain* tertentu, memisahkan *logic tests* dari *UI compiler snapshot tests*.

### 4.2. Timeout Makro dan Rekursi pada File Skala Raksasa
Makro rekursif tingkat tinggi (seperti *macro-by-example* besar atau *proc-macro* yang menghasilkan ribuan baris State Machine) dapat menghentikan (hang) `cargo test`. Tool `trybuild` menjalankan instance `rustc` baru per file tes, membebani CPU, I/O, dan memory.
**Solusi:** Konsolidasikan skenario kegagalan dalam jumlah file UI test seminimal mungkin. Gunakan variasi kasus kegagalan (multiple structs) dalam satu file test `.rs` yang sama untuk menghindari overhead perputaran instance kompilator berulang-ulang.

### 4.3. Dependensi Tersembunyi (Hidden Dependencies / Path Resolution)
Seringkali `quote! { ... }` dalam makro bergantung pada library seperti `serde` atau `tokio`. Saat dijalankan via `trybuild`, crate tersebut di-compile di direktori temp mandiri yang mungkin kehilangan referensi lokal workspace.
**Solusi:** Pastikan `Cargo.toml` pada lingkungan *proc-macro* telah mendefinisikan *workspace resolution* dengan cermat. Gunakan *path prefixing* mutlak di dalam makro (contoh: `::std::result::Result` daripada `Result`) agar ekspansi makro sukses dalam namespace/konteks apa pun tanpa error *unresolved import*.
