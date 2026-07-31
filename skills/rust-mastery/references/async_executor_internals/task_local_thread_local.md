# Task-Local Data & Thread-Local Storage

## Konsep Utama
Di dunia sinkron, data konteks (seperti user auth, tracing span) disimpan di `thread_local!` karena 1 thread = 1 request. Di dunia asinkron, hal ini salah! Task dapat bermigrasi antar OS thread melalui *work-stealing*. Untuk menyimpan data spesifik task dengan aman melewati *await points*, kita menggunakan *Task-Local Storage* (seperti makro `tokio::task_local!`). Di bawah kap mesin, ia menyisipkan referensi ke dalam thread-local selagi task tersebut di-polling secara sinkron, dan membuangnya saat polling terjeda (`Poll::Pending`), memastikan lokalisasi scope berdasarkan Task.

## Arsitektur & Context Propagation

```text
       Task A (Running on Thread 1)              Thread Local Storage (TLS)
       +-------------------------+               +--------------------------+
       | task_local.scope()      | --- set ----> | SLOT: "TraceID-A"        |
       | async I/O await         | <--- yield    | (Valid only during poll) |
       +-------------------------+
                  |
        Migrates via work-stealing
                  v
       Task A (Running on Thread 2)              Thread Local Storage (TLS)
       +-------------------------+               +--------------------------+
       | I/O Ready, poll resumes | --- set ----> | SLOT: "TraceID-A"        |
       | task_local.get()        |               | (Restored properly)      |
       +-------------------------+               +--------------------------+
```

## Production-Ready Code

```rust
use std::future::Future;
use tokio::task;

// Definisikan task-local key. Hanya valid dalam lingkup Tokio executor.
tokio::task_local! {
    pub static TRACE_ID: String;
}

/// Fungsi asinkron yang bisa membaca task-local data
async fn process_database_query() -> String {
    // Ambil data dari task-local. Akan panic (atau return error) jika dipanggil
    // di luar scope tokio::task_local.
    let current_trace_id = TRACE_ID.with(|id| id.clone());
    
    // Simulasi delay (await point dimana task bisa pindah thread)
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    // Data aman dan konsisten dengan Task A, bukan TLS thread acak
    format!("Query run under trace: {}", current_trace_id)
}

/// Entry point simulasi
pub async fn run_server_request(trace_id: String) -> String {
    // Membungkus eksekusi Future ke dalam scope `TRACE_ID`
    TRACE_ID.scope(trace_id, async {
        let result = process_database_query().await;
        result
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test(flavor = "multi_thread")]
    async fn test_task_local_across_await() {
        let res1 = run_server_request("REQ-001".to_string());
        let res2 = run_server_request("REQ-002".to_string());
        
        // Eksekusi paralel
        let (out1, out2) = tokio::join!(res1, res2);
        
        assert_eq!(out1, "Query run under trace: REQ-001");
        assert_eq!(out2, "Query run under trace: REQ-002");
    }
}
```

## Anti-Patterns

1. **Menggunakan `std::thread_local!` di Code Async**
   - *Deskripsi*: Menyimpan ID request atau tracing context di `std::thread_local!`.
   - *Mengapa Berbahaya*: Setelah `await`, task mungkin dijemput oleh Thread B. Thread B akan mencoba membaca TLS, yang berisiko membaca context dari request *lain* yang sedang ditangani oleh Thread B (Security Bypass / Data Leakage) atau mereturn `None`.

2. **Memblokir Scope dengan Heavy Synchronous Work**
   - *Deskripsi*: Memanggil `task_local!.with(...)` lalu melakukan komputasi kriptografi intensif tanpa `yield`.
   - *Mengapa Berbahaya*: Walau secara logik context task local valid, ini akan menunda execution polling task lain di thread yang sama. Task-local dirancang ringan untuk meta-data, bukan untuk bypass state management.

## Edge Cases & Defensive Programming

- **Nested Scopes**: Makro `task_local!` mendukung masking, di mana scope dalam menimpa (shadow) scope luar. Harus waspada jika Anda menggunakan nama ID yang ambigu, bisa menyebabkan trace span tidak linier.
- **Men-Spawn Background Task tanpa Scope**: `tokio::spawn` melepaskan context. Jika Anda melakukan `tokio::spawn(async { ... })` di dalam blok, task baru *tidak* secara otomatis mewarisi `TRACE_ID`. Anda harus secara manual membungkusnya lagi: `tokio::spawn(TRACE_ID.scope(id.clone(), async { ... }))` (seperti yang dilakukan oleh library `tracing` dengan `Instrument` trait).
