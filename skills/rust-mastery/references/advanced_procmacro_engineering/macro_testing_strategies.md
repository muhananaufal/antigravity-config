# Macro Testing Strategies

Menguji procedural macro sangat berisiko tinggi. Jika macro di-deploy dengan bug ke crates.io, error kompilasinya sangat menyiksa para penggunanya. Ekosistem Rust standard memiliki unit test reguler, namun macro menuntut strategi pengujian ekstra: kompilasi yang *diharapkan* gagal (Compile-Fail Tests) dan inspeksi expansi.

## Arsitektur Macro Testing

```text
[ trybuild Crate ]
  |--> run(tests/ui/pass/*.rs) --> Harap Sukses Kompilasi
  |--> run(tests/ui/fail/*.rs) --> Harap GAGAL Kompilasi 
       |--> Cek apakah output stderr cocok dengan *.stderr 
            (Untuk validasi bahwa Macro Span Error sudah tepat sasaran)

[ cargo expand ]
  |--> Membuang macro di console, untuk debugging kode mentah di IDE
```

## Implementasi Production-Ready

```rust
// File: tests/macro_tests.rs
// Tidak ditempatkan di src/, tetapi di folder tests/ integrasi.

#[test]
fn ui_tests() {
    // `trybuild` mensimulasikan pemanggilan `cargo build` secara real
    let t = trybuild::TestCases::new();
    
    // Test di direktori pass/ HARUS lolos tanpa compiler error
    t.pass("tests/ui/pass/*.rs");
    
    // Test di direktori fail/ HARUS gagal dengan pesan error 
    // yang persis sama dengan file .stderr terkait.
    t.compile_fail("tests/ui/fail/*.rs");
}

/* 
 * Contoh file: tests/ui/fail/missing_derive.rs
 * 
 * #[derive(MyMacro)]
 * struct Foo {
 *    #[custom(wrong_type)] // ini di-reject
 *    name: String,
 * }
 * 
 * ---
 * File pasangannya: tests/ui/fail/missing_derive.stderr
 * error: Atribut wrong_type tidak dikenali
 *  --> tests/ui/fail/missing_derive.rs:3:14
 *   |
 * 3 |    #[custom(wrong_type)]
 *   |             ^^^^^^^^^^
 */
```

## Strategi Debugging dengan `cargo expand`

Sebagai author macro, Anda tidak bisa melakukan `println!` di dalam source code user. Saat membuat makro, gunakan tooling ini:
```bash
cargo install cargo-expand
# Buka file src/main.rs dan jalankan
cargo expand > expanded.rs
```
Ini akan me-render file `expanded.rs` hasil konversi dari macro. Buka file tersebut, jika terdapat sintaks error di Rust analyzer, itu berarti macro Anda menghasilkan AST (Abstract Syntax Tree) yang menyimpang.

## Anti-Pattern Terlarang

1. **Hanya Menguji `TokenStream` String Matching di Unit Test:**
   *Mengapa berbahaya:* Menggunakan `assert_eq!(output.to_string(), "...")` sangatlah rapuh. Whitespace yang di-generate oleh `quote!` tidak ada aturannya. `proc_macro2::TokenStream` bisa meletakkan spasi yang berubah-ubah di tiap rilis internal. Selalu uji dengan tool kompilasi (`trybuild`), atau parse kembali string output ke `syn::File` lalu format.
2. **Hardcode Line Number di Test Stderr `trybuild`:**
   *Mengapa berbahaya:* Saat Anda me-run `cargo test`, `trybuild` pertama akan memunculkan error, lalu merekamnya ke file `.stderr`. Jangan tulis `.stderr` itu secara manual! Biarkan perintah compiler gagal pertama kalinya, dan accept perubahan yang diberikan `trybuild`. Line-number berubah dengan satu pergeseran newline.

## Edge Cases & Defensive Programming

- **Nightly vs Stable Output:** Format string error message di kompilator Rust bisa sedikit berbeda antara rilis *nightly* dan *stable*. Karena `trybuild` mengecek *string text error*, CI pipeline makro Anda berpotensi flappy / flaky jika di-test melintang (cross-tested) ke beda versi compiler. Pertimbangkan binding `.stderr` pada satu versi compiler saja di CI.
- **Cargo Features Integration:** Procedural macro Anda mungkin menghasilkan kode yang memanggil module/library spesifik yang aktif via feature flag. Pastikan test script Anda menginisiasi `cargo-test` dengan flag yang mewakili semua kombinasi feature tersebut.
