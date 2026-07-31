# wasm-bindgen JS Interop

## Konsep Utama
`wasm-bindgen` adalah jembatan utama untuk komunikasi antara Rust (WebAssembly) dan JavaScript. Ini mengabstraksi kompleksitas passing objek, string, dan closure antara dua environment yang memiliki model memori berbeda (linear memory Wasm vs garbage collected JS heap). Ekosistem ini mencakup `js-sys` (bindings untuk JS standard built-ins) dan `web-sys` (bindings untuk Web APIs).

## Arsitektur & Flow
```text
[ JS Engine / V8 ] <---(js shim/glue)---> [ WebAssembly Linear Memory ] <---(wasm-bindgen)---> [ Rust ]
      |                                                                                          |
   JS String (UTF-16) --(encode)--> Pointer + Length --(decode)--> Rust String (UTF-8)           |
   JS Object (Ref)    --(store in table, pass index)-------------> JsValue                       |
```

## Production-Ready Code
```rust
use wasm_bindgen::prelude::*;
use js_sys::{Array, Promise, Math};
use web_sys::{console, Window};
use wasm_bindgen_futures::JsFuture;

// Export Rust struct ke JS
#[wasm_bindgen]
pub struct ImageProcessor {
    width: u32,
    height: u32,
}

#[wasm_bindgen]
impl ImageProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Memproses data gambar. Menggunakan `&mut [u8]` menghindari copy bolak-balik.
    #[wasm_bindgen]
    pub fn process(&mut self, data: &mut [u8]) -> Result<(), JsValue> {
        if data.len() as u32 != self.width * self.height * 4 {
            return Err(JsValue::from_str("Invalid image data size"));
        }
        
        // Contoh manipulasi sederhana (grayscale)
        for chunk in data.chunks_exact_mut(4) {
            let r = chunk[0] as f32;
            let g = chunk[1] as f32;
            let b = chunk[2] as f32;
            // Luma = 0.2126*R + 0.7152*G + 0.0722*B
            let gray = (r * 0.2126 + g * 0.7152 + b * 0.0722) as u8;
            chunk[0] = gray;
            chunk[1] = gray;
            chunk[2] = gray;
            // Alpha tetap
        }
        
        console::log_1(&JsValue::from_str("Processing complete!"));
        Ok(())
    }
}

// Interop Async dengan Promises JS
#[wasm_bindgen]
pub async fn fetch_data_async(url: String) -> Result<JsValue, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("No window found"))?;
    let promise = window.fetch_with_str(&url);
    
    // Konversi JS Promise ke Rust Future
    let resp_value = JsFuture::from(promise).await?;
    let resp: web_sys::Response = resp_value.dyn_into()?;
    
    if !resp.ok() {
        return Err(JsValue::from_str("Fetch failed"));
    }
    
    let json_promise = resp.json()?;
    let json_val = JsFuture::from(json_promise).await?;
    
    Ok(json_val)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_processor_invalid_size() {
        let mut proc = ImageProcessor::new(10, 10);
        let mut bad_data = vec![0u8; 100]; // Harusnya 10*10*4 = 400
        assert!(proc.process(&mut bad_data).is_err());
    }
}
```

## Anti-Patterns

1. **Terlalu Sering Melintasi Boundary (Chatty Boundary)**
   - *Mengapa berbahaya:* Setiap pemanggilan fungsi antara JS dan Wasm membutuhkan overhead (type checking, glue code). Memanggil fungsi Wasm dalam loop ketat dari JS (atau sebaliknya) akan merusak performa.
   - *Solusi:* Lakukan batch processing. Kirim array besar dari JS ke Wasm, proses di Wasm, dan kembalikan hasilnya.

2. **Memory Leaks pada Closure (`Closure::forget`)**
   - *Mengapa berbahaya:* Mengubah Rust closure menjadi callback JS mengharuskan memori di Wasm tetap hidup. Jika menggunakan `Closure::forget()`, memori tidak akan pernah di-dealokasi.
   - *Solusi:* Simpan referensi `Closure<T>` di dalam struct dan `drop()` saat callback sudah tidak diperlukan (misalnya saat komponen UI di-unmount).

## Edge Cases & Defensive Programming
- **Panic Handling:** Gunakan `console_error_panic_hook` saat inisialisasi agar panic di Rust menampilkan stack trace yang berguna di console JS (bukan sekadar `unreachable executed`).
- **Shared Memory:** Jika menggunakan Multithreading (Wasm Threads proposal), Wasm memory menjadi `SharedArrayBuffer`. Tidak semua Web APIs menerima tipe ini. Gunakan transfer atau copy bila perlu.
