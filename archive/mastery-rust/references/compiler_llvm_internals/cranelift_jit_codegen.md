# Cranelift JIT & Code Generation Backend

## Deskripsi Konsep
Cranelift adalah backend code generation (pembuat kode mesin) yang murni ditulis dalam Rust, didesain dari awal untuk kecepatan dan keamanan memori (awalnya untuk Wasmtime). Cranelift lebih cepat, berfokus pada kompilasi Just-In-Time (JIT) dan waktu jeda rendah (low latency), dibandingkan backend industri-berat seperti LLVM yang berfokus pada optimalisasi agresif dan membutuhkan waktu kompilasi (*compile-time*) tinggi.

Arsitektur JIT dengan Cranelift menggunakan paradigma **SSA (Static Single Assignment)**: setiap variabel hanya bisa *assigned* atau dideklarasikan satu kali, memudahkan analisis optimisasi. Instruksi diatur dalam unit logis yang disebut **Basic Blocks**, yang merepresentasikan urutan lurus instruksi komputasi yang diakhiri instruksi perpindahan (*jump / branch / return*).

`JITModule` dan `FunctionBuilder` adalah fasad (interface) utama Cranelift:
- `JITModule` menangani alokasi memori runtime eksklusif, registrasi simbol global (fungsi, data), dan manajemen linkage biner di runtime.
- `FunctionBuilder` adalah alat mutasi yang menyediakan interface nyaman untuk membangun representasi graf IR per fungsi secara terstruktur dengan kontrol penuh atas registrasi Basic Blocks.

Kasus Penggunaan Terbaik: Wasm Runtimes (Wasmtime), Scripting Engines berkinerja tinggi, atau *repl* / evaluasi query basis data secara instan di mana *compile latency* tidak bisa ditolerir.

## Diagram ASCII: Cranelift JIT Pipeline

```text
[ Frontend AST / Bytecode ]
          │
          ▼  (Traversal & Terjemahan)
[ cranelift_codegen::FunctionBuilder ]
          │
          ├── (1) Buat & Switch ke blok awal (Basic Block)
          ├── (2) Append SSA Instructions (ins().iadd(a, b))
          └── (3) Insert Return Instruction / Branch
          │
[ Cranelift IR (clif) ]
          │
          ▼  (Kompilasi cepat via JITModule)
[ Memori Dapat Dieksekusi (Native x86/ARM Machine Code) ]
          │
          ▼  (Casting ke function pointer & Execute!)
[ Hasil Eksekusi ]
```

## Kode Rust Production-Ready

```rust
// Kode disimulasikan sebagai representasi API Cranelift
// Dependencies required: cranelift, cranelift-jit, cranelift-module

// use cranelift::prelude::*;
// use cranelift_jit::{JITBuilder, JITModule};
// use cranelift_module::{Linkage, Module};

/// Struktur dummy mengilustrasikan pembungkus (wrapper) JIT runtime.
pub struct JitRuntime {
    // Pada aslinya:
    // builder_context: FunctionBuilderContext,
    // ctx: codegen::Context,
    // module: JITModule,
    is_initialized: bool,
}

impl JitRuntime {
    pub fn new() -> Self {
        // Konfigurasi asli JITBuilder (Mendefinisikan arsitektur target mesin saat ini)
        // let builder = JITBuilder::new(cranelift_module::default_libcall_names());
        // let module = JITModule::new(builder);
        
        JitRuntime { is_initialized: true }
    }

    /// Mendemonstrasikan bagaimana fungsi dibentuk (secara virtual/konseptual).
    pub fn compile_adder_function(&mut self) -> Result<*const u8, &'static str> {
        /* Pembangunan IR Nyata:
        
        // 1. Deklarasi Signature (Tipe parameter & kembalian)
        self.ctx.func.signature.params.push(AbiParam::new(types::I32));
        self.ctx.func.signature.params.push(AbiParam::new(types::I32));
        self.ctx.func.signature.returns.push(AbiParam::new(types::I32));

        // 2. Buat builder IR Cranelift
        let mut builder = FunctionBuilder::new(&mut self.ctx.func, &mut self.builder_context);

        // 3. Bangun Basic Block Utama
        let entry_block = builder.create_block();
        builder.append_block_params_for_function_params(entry_block);
        builder.switch_to_block(entry_block);
        builder.seal_block(entry_block); // Block tidak memiliki cabang masuk lainnya

        // 4. Bangkitkan Instruksi Aritmetika (SSA)
        let param_a = builder.block_params(entry_block)[0];
        let param_b = builder.block_params(entry_block)[1];
        let sum = builder.ins().iadd(param_a, param_b);

        // 5. Kembalikan hasil
        builder.ins().return_(&[sum]);
        builder.finalize();

        // 6. Registrasi ke JIT Module & Deklarasi finaliasi memori (Mmap mprotect)
        let func_id = self.module.declare_function("add", Linkage::Export, &self.ctx.func.signature).unwrap();
        self.module.define_function(func_id, &mut self.ctx).unwrap();
        self.module.clear_context(&mut self.ctx);
        self.module.finalize_definitions();

        // 7. Ambil Pointer Eksekusi
        let code_ptr = self.module.get_finalized_function(func_id);
        Ok(code_ptr)
        */

        if !self.is_initialized {
            return Err("Runtime failed to initialize");
        }

        // Return fake pointer for mock evaluation
        Ok(0x1234ABCD as *const u8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jit_runtime_initialization() {
        let mut runtime = JitRuntime::new();
        assert!(runtime.is_initialized);
        
        let ptr_res = runtime.compile_adder_function();
        assert!(ptr_res.is_ok());
    }
}
```

## Anti-Patterns

1. **Gagal Me-seal (Segel) Basic Block**
   - **Contoh Buruk**: Melupakan panggilan `builder.seal_block(block_id)` di sebuah blok ketika semua cabang panah eksekusi (branches) sudah didefinisikan tertuju ke blok tersebut.
   - **Mengapa berbahaya**: Di sistem SSA, jika sebuah blok tidak "disegel", Cranelift akan beranggapan ada kemungkinan nilai instruksi variabel (phi nodes) yang tertunda dari blok misterius lain, menyebabkan Cranelift tak bisa sepenuhnya meresolusi tipe data dan berpotensi panik saat fungsi di-*finalize*.

2. **JIT Pointer Casting (FFI) yang Sembrono**
   - **Contoh Buruk**: Menge-cast pointer `*const u8` dari memori JIT menggunakan `mem::transmute` ke `fn(i32) -> f64` sementara signature cranelift menggunakan I32 sebagai return.
   - **Mengapa berbahaya**: Memori tereksekusi JIT terikat erat ke *Application Binary Interface (ABI)* pemanggil (contohnya system V). Jika signature di Cranelift tidak identik 1-ke-1 dengan tanda-tangan penunjuk fungsi C (function pointer transmute) Rust Anda, ini akan memicu *Stack Corruption* atau *Undefined Behavior* karena register atau urutan stack args tidak singkron.

## Edge Cases & Defensive Programming
- **Pembersihan Memori & W\^X**: JIT modern sangat ketat dengan perlindungan keamanan W\^X (Write XOR Execute). Saat membuat memori instruksi, *JITModule* Cranelift mem-mmap memori sebagai *Read+Write*. Saat fungsi di-*finalize*, perlindungan memori ditegakkan menjadi *Read+Execute*. Jangan pernah memanipulasi permission page memory buffer OS secara manual.
- **Cold vs Hot Paths**: Fungsi di-JIT menggunakan buffer besar. Di scripting engine produksi yang kompleks (seperti JavaScript VM), JIT Cranelift lebih baik ditempatkan di lapisan ke-dua (Tiers) ("Optimizing Compiler") sedangkan untuk eksekusi pertama ("Cold Start"), gunakan interpreter statis standar untuk mencegah penalti waktu start-up kompilasi dan memori buangan (*memory thrashing*).
