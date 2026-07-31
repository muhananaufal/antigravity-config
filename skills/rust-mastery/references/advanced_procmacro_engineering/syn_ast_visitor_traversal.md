# Syn AST Visitor Traversal

Ketika mengembangkan Procedural Macro di Rust, seringkali kita butuh untuk menganalisis (traversing) atau mengubah kode AST (Abstract Syntax Tree) tanpa harus manual melakukan pattern matching untuk setiap enum dan struct yang ada pada parsing pohon.
Crate `syn` menyediakan trait `Visit` (untuk membaca iteratif) dan `VisitMut` (untuk mutasi iteratif) melalui pattern *Visitor*.

## Arsitektur Traversal AST

```text
[ ItemFn (Fungsi) ]
    |--> Signature
    |--> Block (Isi Fungsi)
           |--> Stmt 1 (Let x = 1;)
           |      |--> Expr (1)
           |--> Stmt 2 (CallFunc(x);)
```
*Visitor menelusuri secara mendalam (depth-first). `syn` menyediakan method default yang melakukan delegasi pada node anaknya.*

## Implementasi Production-Ready

```rust
use proc_macro2::TokenStream;
use quote::quote;
use syn::{parse_quote, Expr, ItemFn};
use syn::visit_mut::{self, VisitMut};
use syn::visit::{self, Visit};

/// Visitor untuk mencari apakah fungsi menggunakan keyword `await`.
pub struct AwaitVisitor {
    pub has_await: bool,
}

impl<'ast> Visit<'ast> for AwaitVisitor {
    fn visit_expr_await(&mut self, i: &'ast syn::ExprAwait) {
        self.has_await = true;
        // Teruskan traversing anak-anak node.
        visit::visit_expr_await(self, i);
    }
}

/// Visitor Mutabel untuk meng-injeksi `tracing::info!` di setiap fungsi
pub struct TracingInjector;

impl VisitMut for TracingInjector {
    fn visit_item_fn_mut(&mut self, i: &mut ItemFn) {
        let func_name = i.sig.ident.to_string();
        
        let trace_stmt: syn::Stmt = parse_quote! {
            ::tracing::info!("Entering function: {}", #func_name);
        };
        
        // Sisipkan statement di paling awal fungsi
        i.block.stmts.insert(0, trace_stmt);

        // Jangan lupa mengunjungi node dalam fungsi jika ada 
        // nested function (closure/fungsi lokal).
        visit_mut::visit_item_fn_mut(self, i);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    #[test]
    fn test_await_visitor() {
        let ast: syn::Expr = parse_quote! {
            foo().await.unwrap()
        };
        let mut visitor = AwaitVisitor { has_await: false };
        visitor.visit_expr(&ast);
        assert!(visitor.has_await);
    }

    #[test]
    fn test_tracing_injector() {
        let mut func: ItemFn = parse_quote! {
            fn my_func() {
                let x = 1;
            }
        };

        let mut injector = TracingInjector;
        injector.visit_item_fn_mut(&mut func);

        let code = quote!(#func).to_string();
        assert!(code.contains("tracing :: info !"));
    }
}
```

## Anti-Pattern Terlarang

1. **Lupa Memanggil `visit_*` Asli di Overridden Method:**
   *Mengapa berbahaya:* Jika Anda meng-override `visit_expr` untuk menangkap sebuah expresi, namun lupa memanggil `visit::visit_expr(self, i)` di dalamnya, maka Visitor akan **berhenti** melacak anak-anak node dari ekspresi tersebut. AST sebagian besar ter-skip tanpa Anda sadari.
2. **Tidak Memperhatikan Macro Hygiene pada Mutasi:**
   *Mengapa berbahaya:* Injeksi node yang mengandung identifier kustom harus benar-benar di-resolve di root namespace. Contoh, gunakan `::tracing::info` ketimbang `tracing::info`, agar variabel/modul user tidak melakukan shadowing dan memecahkan kompilasi macro.

## Edge Cases & Defensive Programming

- **Nested Definitions:** Saat melacak tipe data (misal Anda mencari struct dalam sebuah modul), ingat bahwa pengguna bisa meletakkan definisi dalam sebuah *block function* atau *closure*. Jika Visitor Anda tidak meng-override `visit_item_fn` untuk melanjutkan ke dalamnya, struct lokal tersebut tidak akan ditemukan.
