# WASI & Component Model Serverless

## Konsep Utama
WASI (WebAssembly System Interface) Preview 2 memperkenalkan **Component Model**, sebuah cara mendefinisikan Wasm yang strongly-typed, inter-operable, dan bahasa-agnostik. Daripada hanya mengekspor fungsi yang mengambil integer/pointer, komponen mendefinisikan interface level tinggi via **WIT** (Wasm Interface Type). Ini ideal untuk serverless (seperti Spin/Fermyon) karena eksekusi cepat, sandbox ketat, dan ukuran kecil.

## Arsitektur & Flow
```text
[ Host (Wasmtime/Spin) ] ---> (wasi:http/incoming-handler) ---> [ Wasm Component ]
      |                                                            |
      +--- (wasi:cli/environment) <--------------------------------+
      +--- (wasi:keyvalue/store) <---------------------------------+
```

## Production-Ready Code
*Definisi WIT (`wit/world.wit`):*
```wit
package my-org:serverless;

world api-service {
    include wasi:http/proxy@0.2.0;
    import wasi:keyvalue/store@0.2.0-draft;
}
```

*Implementasi Rust (`src/lib.rs`):*
```rust
use exports::wasi::http::incoming_handler::Guest;
use wasi::http::types::{
    IncomingRequest, OutgoingResponse, OutgoingBody, ResponseOutparam, Fields
};
use wasi::keyvalue::store;

// Generate bindings based on WIT
wit_bindgen::generate!({
    path: "wit",
    world: "api-service",
});

struct ApiHandler;

impl Guest for ApiHandler {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        // Ekstrak path dari request
        let path = request.path_with_query().unwrap_or_else(|| String::from("/"));
        
        let response_body_text = match path.as_str() {
            "/ping" => "pong".to_string(),
            "/count" => {
                // Interaksi dengan komponen wasi:keyvalue (contoh state)
                let bucket = store::open("default").expect("Failed to open KV store");
                let count_str = store::get(&bucket, "hits")
                    .unwrap_or_default()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .unwrap_or_else(|| "0".to_string());
                
                let new_count = count_str.parse::<u64>().unwrap_or(0) + 1;
                store::set(&bucket, "hits", new_count.to_string().as_bytes())
                    .expect("Failed to write KV");
                
                format!("Hits: {}", new_count)
            }
            _ => "Not Found".to_string(),
        };

        // Bangun HTTP Response
        let headers = Fields::new();
        headers.set(&"content-type".to_string(), &[b"text/plain".to_vec()]).unwrap();
        
        let status_code = if path == "/ping" || path == "/count" { 200 } else { 404 };
        let response = OutgoingResponse::new(headers);
        response.set_status_code(status_code).unwrap();
        
        let body = response.body().unwrap();
        
        // Kirim header ke runtime
        ResponseOutparam::set(response_out, Ok(response));
        
        // Tulis body stream
        let stream = body.write().unwrap();
        stream.blocking_write_and_flush(response_body_text.as_bytes()).unwrap();
        drop(stream);
        
        OutgoingBody::finish(body, None).unwrap();
    }
}

export!(ApiHandler);
```

## Anti-Patterns

1. **Memblokir Thread Utama Secara Ekstrem**
   - *Mengapa berbahaya:* Dalam wasi:http, jika Wasm component memblokir eksekusi (seperti looping berat tanpa yield) pada model eksekusi asinkron, host Wasmtime thread akan tersandera. 
   - *Solusi:* Eksekusi long-running process menggunakan `wasi:clocks` untuk yield atau offload task.

2. **Panicking Saat Inisialisasi Handler**
   - *Mengapa berbahaya:* Panicking sebelum `ResponseOutparam::set` dipanggil dapat menyebabkan host menjatuhkan koneksi dengan error internal yang samar.
   - *Solusi:* Tangkap error (`Result`) secara eksplisit dan kembalikan response Wasmtime standar dengan HTTP 500.

## Edge Cases & Defensive Programming
- **Resource Dropping:** Objek stream dari Wasm Interface (seperti `OutgoingBody::write()`) berwujud Handles. Kegagalan melakukan `drop(stream)` secara eksplisit sebelum `OutgoingBody::finish` dapat memicu panic dari host runtime karena resource belum selesai digunakan.
- **Batasan Memori Serverless:** Environment Wasm serverless sangat pelit memori. Hindari alokasi besar; proses input payload secara streaming.
