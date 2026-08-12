# Task-Local vs Thread-Local: Internals Async Executor

## Deskripsi dan Konsep Utama
Dalam model pemrograman thread *blocking* tradisional (synchronous), kita sering memakai `std::thread_local!` untuk menyimpan state global per-thread tanpa harus terus-menerus mem-passing *struct argument* (argument drilling). Namun, di ekosistem asynchronous Tokio (M:N execution model, *work-stealing* scheduler), satu *Task* bisa berpindah-pindah antar *OS Threads* sesuka hati di titik interupsi (`.await`). Jika kita menggunakan `std::thread_local!` dalam *async*, data akan bocor/tersangkut di *Worker Thread A* padahal eksekusi tasknya sudah dilanjutkan oleh *Worker Thread B*. Disinilah `tokio::task_local!` dibutuhkan: ia menyediakan penyimpanan *context-aware* yang akan menempel terus mengikuti *Async Task*, apapun *thread* yang mem-poll-nya.

## Arsitektur & Flow (ASCII Diagram)
```text
[OS Thread 1 (Worker)]                  [OS Thread 2 (Worker)]
          |                                       |
 +--------+--------+                     +--------+--------+
 | std::thread_local|                    | std::thread_local| (State stuck here!)
 +--------+--------+                     +--------+--------+
          |                                       |
 [Task A execution] --- ( yield .await ) --+      |
 [Task_Local state]                        |      |
                                           v
                                   [Task A resumed (Polled)]
                                   [Task_Local state MOVES!]
```

## Implementasi Produksi (Rust)
```rust
use std::cell::RefCell;
use tokio::task_local;

// Definisi Task Local:
// Data yang akan selalu menempel pada instance tokio::spawn spesifik.
task_local! {
    pub static REQUEST_ID: String;
    pub static USER_SESSION: RefCell<SessionState>;
}

// Struct state simulasi
#[derive(Debug, Clone, PartialEq)]
pub struct SessionState {
    pub user_id: u32,
    pub role: String,
}

// Fungsi dalam tumpukan panggilan (call stack) yang sangat dalam.
// Tidak perlu argument drilling (passing REQUEST_ID dari fungsi A -> B -> C).
pub async fn deep_database_call() {
    // Membaca task-local state (aman melintasi threads).
    let req_id = REQUEST_ID.with(|id| id.clone());
    
    // Membaca via RefCell mutability, butuh di-borrow hati-hati
    let user_role = USER_SESSION.with(|session| {
        session.borrow().role.clone()
    });

    println!("DB Call by Request ID: {}, Role: {}", req_id, user_role);
}

pub async fn handle_http_request() {
    let session = SessionState {
        user_id: 101,
        role: "admin".to_string(),
    };

    // Kita menyuntikkan (scope) nilai ini khusus untuk Future (blok async) ini
    REQUEST_ID.scope("req-xyz-789".to_string(), async {
        USER_SESSION.scope(RefCell::new(session), async {
            // Future apapun (bahkan span tokio baru) yang dieksekusi di dalam
            // tree scope ini dapat mengakses TASK_LOCAL.
            
            // Misal: Future yield, executor bisa mencabut task ini 
            // dan melempar ke worker thread lain.
            tokio::task::yield_now().await;
            
            // Bahkan di dalam pemanggilan fungsi terdalam...
            deep_database_call().await;
        }).await;
    }).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_task_local_encapsulation() {
        // Jalankan dua request simultan.
        // Task-local akan mencegah kontaminasi state (isolation).
        
        let t1 = tokio::spawn(async {
            REQUEST_ID.scope("id-1".to_string(), async {
                tokio::task::yield_now().await;
                REQUEST_ID.with(|id| assert_eq!(id, "id-1"));
            }).await;
        });

        let t2 = tokio::spawn(async {
            REQUEST_ID.scope("id-2".to_string(), async {
                tokio::task::yield_now().await;
                REQUEST_ID.with(|id| assert_eq!(id, "id-2"));
            }).await;
        });

        let _ = tokio::join!(t1, t2);
    }
}
```

## Anti-Patterns

1. **Memakai `std::thread_local!` di Blok Async (Work Stealing Trap)**: Menyimpan akses koneksi atau `UUID` otentikasi di statik `std::thread_local!`.
   *Mengapa berbahaya*: Saat `tokio` scheduler meresume Future, sangat umum state otentikasi `Thread 1` bocor dan dibaca oleh *Request HTTP B* yang kebetulan numpang dialokasikan di `Thread 1` yang sama, memicu peretasan data rahasia lintas-user.
2. **`RefCell` Borrow Memlintasi `.await` pada Task-Local**: Memanggil `.borrow_mut()` lalu mempertahankan *guard*-nya melintasi titik yield `.await`.
   *Mengapa berbahaya*: `RefCell` tidak thread-safe. Begitu thread lain mengambil alih task, mengakses `RefCell` ini akan memicu *Runtime Panic* karena borrow guard masih nyangkut, membuat executor panik secara instan.

## Edge Cases & Defensive Programming

1. **Panic pada Akses di Luar Scope (`.with()`)**: Jika Anda mengeksekusi `REQUEST_ID.with(...)` tetapi di stack root belum dideklarasikan `.scope(...)`, aplikasi akan langsung *Panic* (unwinding thread). Pastikan middleware di lapis terluar *routing framework* menangani injeksi Task Local ini secara komprehensif, atau tangani panic dengan *fallible API* bawaan (`.try_with()`).
2. **Drop Overhead dan Memory Retention**: Nilai di dalam `task_local!` akan tetap hidup hingga Scope (Future yang di-wrap) selesai. Memasukkan byte buffer ukuran besar yang berumur panjang (seperti 10MB chunk data) ke Task-local akan menyita memori (RAM) dengan ketat, terutama kalau request timeout ditahan oleh I/O.
3. **Propagation pada Tokio Spawn Baru**: Saat men-spawn task terpisah (`tokio::spawn(async move { ... })`), *state task_local* milik parent (induk) **TIDAK** di-copy secara otomatis ke *child task* baru. Induk dan Anak memiliki root stack terpisah. Anda harus mengekstraksinya dahulu dan menginjeksinya ulang dengan manual `.scope()` pada task anak yang disinggahi.
