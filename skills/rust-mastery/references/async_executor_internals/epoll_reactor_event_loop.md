# Epoll Reactor & Non-Blocking Event Loop

## Konsep Utama
Dalam model asinkron di Linux, `epoll` bertindak sebagai *reactor* utama yang mengumpulkan notifikasi event I/O (seperti ketersediaan read/write pada socket) dengan efisiensi O(1) terkait koneksi aktif. Rust async executor (seperti mio atau tokio) memanfaatkan operasi `epoll_create1`, `epoll_ctl` (untuk registrasi interest, *Edge-Triggered* via `EPOLLET`), dan `epoll_wait` (untuk bloking reaktor dan menangkap notifikasi) guna mengelola ribuan non-blocking sockets. Penggunaan *Edge-Triggered* mensyaratkan pemrogram membaca hingga `EAGAIN`/`EWOULDBLOCK` dipicu.

## Arsitektur & Epoll Flow

```text
  +------------------+         epoll_ctl         +----------------+
  |   Async Socket   | ------------------------> |  Kernel epoll  |
  |  (Non-blocking)  |   (ADD/MOD interest)      |  (Event Queue) |
  +------------------+                           +----------------+
           ^                                             |
           | read / write                                | epoll_wait
           |                                             v
  +------------------+         Wake Task         +----------------+
  |   Task Executor  | <------------------------ |  Event Loop    |
  |   (polls Future) |     (Waker::wake)         |  (Reactor)     |
  +------------------+                           +----------------+
```

## Production-Ready Code

```rust
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::ptr;
use libc::{c_int, epoll_event, epoll_create1, epoll_ctl, epoll_wait, EPOLLIN, EPOLLOUT, EPOLLET, EPOLL_CTL_ADD, EPOLL_CLOEXEC};

/// Abstraksi untuk Reactor Loop
pub struct EpollReactor {
    epfd: RawFd,
}

impl EpollReactor {
    /// Inisialisasi instance epoll
    pub fn new() -> io::Result<Self> {
        let epfd = unsafe { epoll_create1(EPOLL_CLOEXEC) };
        if epfd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { epfd })
    }

    /// Meregistrasi sebuah file descriptor untuk dibaca secara Edge-Triggered
    pub fn register(&self, fd: RawFd, token: u64) -> io::Result<()> {
        let mut event = epoll_event {
            events: (EPOLLIN | EPOLLET) as u32,
            u64: token,
        };

        let res = unsafe {
            epoll_ctl(
                self.epfd,
                EPOLL_CTL_ADD,
                fd,
                &mut event as *mut epoll_event,
            )
        };

        if res < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Menunggu event terjadi (blocking)
    pub fn poll_events(&self, max_events: usize) -> io::Result<Vec<epoll_event>> {
        let mut events = Vec::with_capacity(max_events);
        let timeout = -1; // Block selamanya hingga ada event

        let res = unsafe {
            epoll_wait(
                self.epfd,
                events.as_mut_ptr(),
                max_events as c_int,
                timeout,
            )
        };

        if res < 0 {
            return Err(io::Error::last_os_error());
        }

        unsafe {
            events.set_len(res as usize);
        }

        Ok(events)
    }
}

impl Drop for EpollReactor {
    fn drop(&mut self) {
        unsafe { libc::close(self.epfd) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn test_epoll_reactor_lifecycle() {
        let reactor = EpollReactor::new().unwrap();
        // Socket listener dummy
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        // Buat non-blocking
        listener.set_nonblocking(true).unwrap();
        
        // Registrasi listener ke epoll reactor dengan token = 1
        reactor.register(listener.as_raw_fd(), 1).unwrap();
        // Pada titik ini, kita bisa memanggil poll_events() di thread terpisah.
        // poll_events di-skip di tes statis ini karena memicu bloking permanen tanpa koneksi eksternal.
    }
}
```

## Anti-Patterns

1. **Level-Triggered dengan Drain yang Salah**
   - *Deskripsi*: Menggunakan level-triggered tanpa menghapus fd atau mematikan mask interest jika belum siap memproses buffer.
   - *Mengapa Berbahaya*: `epoll_wait` akan terus langsung me-return event dan menghabiskan siklus CPU 100% (busy loop) karena data masih ada di buffer kernel tapi aplikasi belum melahapnya (drain).

2. **Edge-Triggered tanpa Loop EAGAIN**
   - *Deskripsi*: Menggunakan `EPOLLET` (Edge-Triggered) namun membaca fd hanya sekali (`read()`).
   - *Mengapa Berbahaya*: Edge-Triggered hanya memberi tahu **satu kali** saat state berubah dari empty ke readable. Jika Anda tidak membaca sampai habis hingga `EWOULDBLOCK`/`EAGAIN`, sisa data akan stuck selamanya di kernel dan tidak pernah memicu event epoll baru (silent stall / hang).

## Edge Cases & Defensive Programming

- **Interrupted System Calls (`EINTR`)**: `epoll_wait` dapat terganggu oleh sinyal (seperti profiler atau OS traps). Selalu cek error untuk `EINTR` dan restart polling (retry) bukan mem-panic atau fail.
- **Dangling FDs**: Pastikan FD dihapus (atau dibiarkan OS membersihkan otomatis jika FD ditutup dan tidak ada dup). Menutup fd yang masih diregistrasi *biasanya* menghapusnya dari set, tapi jika dup() terjadi, epoll akan bingung dan ghost events mungkin ter-trigger.
