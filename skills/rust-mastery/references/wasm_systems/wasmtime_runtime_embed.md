# Wasmtime Runtime Embedding

## Konsep Utama
Meng-embed `wasmtime` ke dalam aplikasi Rust berarti Anda menjalankan runtime WebAssembly mandiri. Ini memungkinkan host app untuk mengeksekusi plugin Wasm dari pihak ketiga dengan aman (sandbox memori), mendaftarkan host functions (agar plugin bisa memanggil Rust host code), dan mengontrol eksekusi melalui metering.

## Arsitektur & Flow
```text
[ Rust Host App ]                                 [ Wasmtime Runtime Engine ]
      |                                                      |
 1. Config (Metering, AOT) ---------------------------> Engine Instance
 2. Wasm File / Bytes --------------------------------> Module Compilation
 3. Define Host Functions ---> Linker <---------------+
 4. Link & Init Store --------------------------------> Store (Memory, Sandbox)
 5. Call Wasm Func  ----------------------------------> Wasm Execution (Fast, Safe)
```

## Production-Ready Code
```rust
use anyhow::{Result, bail};
use wasmtime::*;
use wasmtime_wasi::sync::WasiCtxBuilder;

// Struktur state internal host yang diturunkan ke setiap Wasm invocation
struct MyState {
    wasi: wasmtime_wasi::WasiCtx,
    hit_count: u32,
}

pub fn run_wasm_plugin(wasm_bytes: &[u8]) -> Result<()> {
    // 1. Konfigurasi Engine: Aktifkan konsumsi fuel untuk metering keamanan
    let mut config = Config::new();
    config.consume_fuel(true);
    config.cranelift_opt_level(OptLevel::Speed); // AOT optimization
    
    let engine = Engine::new(&config)?;

    // 2. Compile module. (Bisa dicache pakai engine.precompile_module)
    let module = Module::new(&engine, wasm_bytes)?;

    // 3. Setup Linker (menghubungkan WASI dan host functions)
    let mut linker: Linker<MyState> = Linker::new(&engine);
    wasmtime_wasi::sync::add_to_linker(&mut linker)?;
    
    // Mendaftarkan custom host function
    linker.func_wrap(
        "env",
        "host_log",
        |mut caller: Caller<'_, MyState>, log_id: i32| -> Result<()> {
            println!("Host received log ID: {}", log_id);
            caller.data_mut().hit_count += 1;
            Ok(())
        },
    )?;

    // 4. Setup State & Store
    let wasi = WasiCtxBuilder::new().inherit_stdio().build();
    let mut store = Store::new(
        &engine,
        MyState {
            wasi,
            hit_count: 0,
        },
    );

    // Tambahkan 10,000 unit fuel (mencegah infinite loop di plugin)
    store.add_fuel(10_000)?;

    // 5. Instansiasi dan eksekusi
    let instance = linker.instantiate(&mut store, &module)?;
    
    let process_func = instance
        .get_typed_func::<i32, i32>(&mut store, "process_data")?;
        
    let result = process_func.call(&mut store, 42)?;
    
    println!("Plugin return result: {}", result);
    println!("Total host calls made: {}", store.data().hit_count);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_wasm() {
        let bad_bytes = b"not a real wasm module";
        assert!(run_wasm_plugin(bad_bytes).is_err());
    }
}
```

## Anti-Patterns

1. **Re-compiling Modul di Setiap Request**
   - *Mengapa berbahaya:* `Module::new` memicu kompilasi Cranelift AOT yang sangat mahal secara CPU dan memori.
   - *Solusi:* Lakukan precompile modul sekali di awal aplikasi, simpan instance `Module` atau byte yang telah dicompile (`module.serialize()`), dan buat ulang hanya `Store` dan `Instance` per-request.

2. **Tidak Memberikan Batasan Resource**
   - *Mengapa berbahaya:* Wasm plugin (karena loop tak berujung atau bug) bisa menghabiskan 100% CPU core jika dijalankan tanpa batas.
   - *Solusi:* Selalu aktifkan Fuel metering (seperti kode di atas) atau `epoch_interruption`.

## Edge Cases & Defensive Programming
- **Host Panic dalam `func_wrap`:** Jika closure dari host function (`host_log`) mengalami `panic!()`, itu tidak akan ter-catch otomatis dengan mulus oleh runtime. Sebaiknya selalu return `anyhow::Error` dari closure alih-alih panic.
- **Pointer/Memory Sandbox:** Jika Wasm melempar pointer ke fungsi host, ingat bahwa host harus mengecek apakah offset dan length tersebut valid (membaca via `memory.data(&store)`). Mengekstrak string dari linear memory yang melanggar bounds akan menyebabkan program crash.
