# io_uring & Asynchronous Direct I/O

## Konsep Utama
Berbeda dengan `epoll` yang bersifat *readiness-based* (kernel memberi tahu "Anda bisa baca sekarang"), `io_uring` di Linux adalah sistem I/O *completion-based*. Aplikasi menaruh job ("Tolong baca socket A") ke *Submission Queue (SQ)* dan kernel akan mengembalikan hasil ke *Completion Queue (CQ)* setelah buffer diisi, dengan minim system calls. Hal ini memecahkan problem latensi syscall, zero-copy dengan pre-registered fixed buffers, dan merupakan satu-satunya cara optimal melakukan I/O file disk asinkron secara sejati di Linux (mem-bypass block-cache menggunakan `O_DIRECT`). Crate seperti `tokio-uring` menyediakan integrasi runtime ini.

## Arsitektur & io_uring Flow

```text
    User Space                   Kernel Space
+----------------+            +-----------------+
| tokio-uring    |            | Block Device /  |
| Event Loop     |            | Networking      |
+----------------+            +-----------------+
       |                              |
       | 1. Submit Operation (SQE)    |
       v                              v
+---------------+             +-----------------+
|  Submission   | -- ring --> |                 |
|  Queue (SQ)   |             |   Kernel WQs    |
+---------------+             +-----------------+
                                      |
                                      | 2. I/O Completed
       ^                              v
       | 3. Harvest Result (CQE)      |
+---------------+             +-----------------+
|  Completion   | <---------- |                 |
|  Queue (CQ)   |    ring     |                 |
+---------------+             +-----------------+
```

## Production-Ready Code

*(Contoh menggunakan API konsep dasar io_uring melalui crate `io-uring` mentah untuk demonstrasi mendalam)*

```rust
use io_uring::{opcode, types, IoUring};
use std::fs::OpenOptions;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;

pub fn read_file_io_uring(filepath: &str) -> std::io::Result<Vec<u8>> {
    // 1. Inisialisasi Ring dengan kapasitas SQ/CQ 8
    let mut ring = IoUring::new(8)?;

    // Buka file dengan O_DIRECT (untuk bypass page cache jika filesystem support,
    // dihilangkan libc::O_DIRECT di sini agar testable secara umum di local, tapi ini esensinya).
    let file = OpenOptions::new()
        .read(true)
        .open(filepath)?;
    let fd = types::Fd(file.as_raw_fd());

    let mut buf = vec![0u8; 1024]; // Pre-allocate buffer

    // 2. Buat Submission Queue Entry (SQE)
    let read_e = opcode::Read::new(fd, buf.as_mut_ptr(), buf.len() as _)
        .offset(0)
        .build()
        .user_data(42); // token unik pengenal request

    // 3. Masukkan ke Submission Queue dan submit ke kernel (Syscall)
    unsafe {
        ring.submission()
            .push(&read_e)
            .expect("Queue is full");
    }
    ring.submit_and_wait(1)?; // Submit dan blocking tunggu 1 penyelesaian

    // 4. Proses Completion Queue Entry (CQE)
    let mut completion = ring.completion();
    let cqe = completion.next().expect("CQE tidak tersedia");

    assert_eq!(cqe.user_data(), 42); // Validasi request mana yang selesai

    let result = cqe.result();
    if result < 0 {
        return Err(std::io::Error::from_raw_os_error(-result));
    }

    // truncate ke ukuran data yang benar-benar terbaca
    buf.truncate(result as usize);
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_io_uring_read() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"Hello io_uring!").unwrap();

        // Testing fungsional hanya akan lulus jika kernel linux kompatibel
        #[cfg(target_os = "linux")]
        {
            let data = read_file_io_uring(temp_file.path().to_str().unwrap()).unwrap();
            assert_eq!(&data[..], b"Hello io_uring!");
        }
    }
}
```

## Anti-Patterns

1. **Buffer Invalidasi pada Drop (Buffer Tearing)**
   - *Deskripsi*: Melakukan cancel future `io_uring` secara paksa (drop pada future `Read`) lalu membebaskan memory buffer yang dijanjikan ke kernel (via `std::vec::Vec`).
   - *Mengapa Berbahaya*: Kernel io_uring berjalan independen di background dan sedang menulis/membaca ke pointer memory yang sudah di-drop atau dipakai oleh entitas lain (Use-After-Free/Memory Corruption). Solusi di `tokio-uring` adalah model *owned buffer* (mentransfer kepemilikan buffer secara total ke runtime, dan dikembalikan saat CQE panen).

2. **Memanggil Submit_and_wait untuk Tiap File**
   - *Deskripsi*: Melakukan `epoll`-style pola pikir, mensubmit 1 event SQ lalu langsung menunggu.
   - *Mengapa Berbahaya*: Tujuan io_uring adalah *batching* untuk menghilangkan overhead system call. Harus memasukkan ratusan SQE lalu cukup 1 `io_uring_enter` syscall.

## Edge Cases & Defensive Programming

- **Kemampuan Kernel Terbatas**: Fitur io_uring tumbuh sangat pesat. OS lama tidak mendukung fixed buffers atau networking operations via io_uring. Cek `io_uring::Probe` sebelum melempar job opcode spesifik.
- **CORS / Memlock Limits**: Memory buffer yang dipin (fixed buffers) memakan batasan `ulimit -l` (locked memory). Jika melebihi kuota user, registrasi buffer akan mengembalikan `ENOMEM`. Selalu handle dan fallback gracefully ke standard buffer `io_uring`.
