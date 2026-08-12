# Zero-Copy bytes dengan Crate `bytes`

Dalam High-Performance Web Servers, HTTP Proxies, dan sistem HFT, menduplikasi (meng-clone) buffer array `u8` saat mentransfer paket dari jaringan, merender protokol (framing), hingga menyalurkan ke worker thread adalah "kematian" dari sisi performa (Memory Allocation Thrashing).

Crate `bytes` (khususnya `Bytes` dan `BytesMut`) menyelesaikan ini lewat pendekatan **Zero-Copy Data Structures**. Alih-alih membuat malloc baru di heap untuk array data, `Bytes` mempekerjakan *atomic reference counting* secara cerdas di mana beberapa buffer/slice dapat menunjuk (point) pada serpihan (slice) dari buffer utama yang sama tanpa menyalin bit-bit data sedikit pun.

## Arsitektur Reference-Counted Buffer Memory

```ascii
[ TCP Read Socket Buffer Heap - 1000 bytes ] (Atomic RefCount: 2)
  | 0                                                999 |
  +------------------------------------------------------+
  | Header Data   |   Payload Packet 1   |   Packet 2    |
  +------------------------------------------------------+
         ^                     ^
         |                     | (Zero-Copy Slicing)
         |                     +-----------------------+
   [ Bytes (Header) ]                            [ Bytes (Payload) ]
   - ptr: 0                                      - ptr: 16
   - len: 16                                     - len: 480
```
> Baik Header maupun Payload memiliki referensi ke lokasi RAM heap yang sama!

## Produksi-Ready Code: Framer Zero-Copy Jaringan

```rust
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Decoder protokol biner sederhana yang membaca 4 byte (u32) panjang data,
/// lalu mengekstrak frame tersebut TANPA menyalin buffer payload (Zero-Copy).
pub struct NetworkFramer {
    buffer: BytesMut,
}

impl NetworkFramer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: BytesMut::with_capacity(capacity),
        }
    }

    /// Menambahkan data ke dalam internal buffer framer dari jaringan
    pub fn extend_from_slice(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    /// Memproses buffer dan mencoba mengekstrak satu paket utuh
    /// Ini mengembalikan `Bytes` yang merupakan pointer *zero-copy* ke buffer asal.
    pub fn decode_frame(&mut self) -> Option<Bytes> {
        // Frame memerlukan setidaknya 4 bytes header (panjang frame)
        if self.buffer.len() < 4 {
            return None;
        }

        // Lihat (peek) byte tanpa memajukan pointer
        let mut temp_buf = &self.buffer[..4];
        let frame_length = temp_buf.get_u32() as usize;

        let total_frame_size = 4 + frame_length;

        // Jika keseluruhan paket belum diterima dari TCP, tunggu hingga buffer penuh.
        if self.buffer.len() < total_frame_size {
            return None;
        }

        // Hapus 4 bytes header. Advance memodifikasi buffer utama inplace
        self.buffer.advance(4);

        // Ekstrak (split) isi payload secara zero-copy!
        // Split_to merobek sebagian buffer, meninggalkannya utuh untuk frame berikutnya
        let frame = self.buffer.split_to(frame_length);

        Some(frame.freeze()) // Freeze mengubah mutable buffer jadi immutable `Bytes`
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_copy_decode() {
        let mut framer = NetworkFramer::new(1024);
        
        // Buat packet: Panjang 5 byte, payload "HELLO"
        let mut mock_packet = BytesMut::new();
        mock_packet.put_u32(5);
        mock_packet.put_slice(b"HELLO");
        
        // Packet kedua yang datang sekalian: Panjang 5, payload "WORLD"
        mock_packet.put_u32(5);
        mock_packet.put_slice(b"WORLD");

        framer.extend_from_slice(&mock_packet);

        let frame1 = framer.decode_frame().unwrap();
        assert_eq!(&frame1[..], b"HELLO");

        let frame2 = framer.decode_frame().unwrap();
        assert_eq!(&frame2[..], b"WORLD");

        assert!(framer.decode_frame().is_none());
    }
}
```

## Anti-Patterns

1. **Mengonversi `Vec<u8>` ke `Bytes` Berkali-kali dalam Loop**
   **Mengapa berbahaya:** Jika Anda membaca stream TCP menjadi `Vec<u8>` lalu setiap frame di `Bytes::from(vec)`, ini BUKAN zero-copy karena ia melakukan alokasi dan memindahkan data dari array Vec yang tak kompatibel.
   **Solusi:** Gunakan `BytesMut` langsung sejak awal saat membaca socket via `tokio::io::AsyncReadExt::read_buf()`.

2. **`reserve()` yang membabi buta pada `BytesMut`**
   **Mengapa berbahaya:** Jika `reserve()` terus dipanggil pada kapasitas penuh `BytesMut`, kompilator akan memicu re-alokasi array ke lokasi RAM yang baru, karena block sebelumnya dipin oleh atomic reference di pointer `Bytes` lainnya. Ini memicu lonjakan memori OOM (Out-of-Memory).
   **Solusi:** Selalu kontrol ukuran split dan izinkan garbage collection (saat `Bytes` drop) me-reclaim blok memori.

## Edge Cases dan Defensive Programming

1. **Memory Leak Akibat Pointer Kecil:**
   Anggap Anda mengalokasikan TCP Buffer 8 Megabytes. Anda me-split 12 Bytes dari buffer tersebut dan memegangnya erat-erat dalam sebuah variabel di state aplikasi (Long Lived). Selama 12 Bytes itu hidup, struct `Bytes` menjaga reference count blok yang berukuran **8 MB tetap eksis**! Ini adalah leak semantik memori pasif. Jika butuh data statis jangka panjang dari payload kecil, lebih baik Clone (Copy) 12 bytes itu dan hancurkan `Bytes`-nya.

2. **DDoS Attack via Incomplete Frames (Slowloris):**
   Client TCP dapat mengirimkan Header Frame yang menjanjikan `length = 2GB`, lalu mengirim 1 byte per detik. Metode decoding akan membuat `BytesMut` bertumbuh secara gila-gilaan karena `self.buffer.len() < total_frame_size` terus dieksekusi. Pertahanan: Terapkan limit keras (hard threshold limit) maksimal payload size pada `get_u32()`.

3. **Mutable Freeze/Thaw Overhead:**
   Memanggil `freeze()` pada `BytesMut` yang belum dipisahkan dari slice lain mengharuskan promosi *inline buffer* ke heap. Gunakan `.freeze()` dengan bijak di tahap akhir pipeline, dan pastikan read-only worker yang mengkonsumsi paket tersebut.
