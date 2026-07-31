# Zero-Copy dengan Bytes dan BytesMut

## Konsep Utama dan Penggunaan
Dalam pemrosesan *network stack*, menyalin payload (data) dari memori kernel, lalu ke buffer I/O, dan lalu ke struktur data aplikasi sangat membebani CPU dan memori (Memory Bandwidth Bottleneck). 

Crate `bytes` menyediakan tipe `Bytes` dan `BytesMut` yang secara internal menggunakan ARC (Atomic Reference Counting) untuk *shallow clone*. Anda dapat melakukan *slicing* (mengambil potongan payload) dan mendistribusikannya ke berbagai thread/task secara **zero-copy**. Sangat penting untuk parser protokol finansial (FIX, FAST) yang menerima stream data TCP berkecepatan gigabit.

## Arsitektur: Bytes ARC Representation
```text
[ Bytes 1 (Slice 0..5) ]      [ Bytes 2 (Slice 5..10) ]
        \                             /
         \     [ ARC Pointer ]       /
          \---->[ Shared Data Heap ]<---
                [ H, E, L, L, O, W, O, R, L, D ]
                
(Tidak ada duplikasi "HELLO" atau "WORLD" di heap, hanya referensi)
```

## Kode Production-Ready: Zero-Copy Network Parser
```rust
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Mensimulasikan parser paket finansial yang efisien
pub struct MarketDataPacket {
    pub symbol: Bytes, // Zero-copy referensi ke payload asli
    pub price: u64,
}

pub fn parse_packet(mut payload: Bytes) -> Result<MarketDataPacket, &'static str> {
    if payload.len() < 12 {
        return Err("Packet too short");
    }

    // Ekstraksi 4 byte untuk simbol, TIDAK ADA COPY HEAP
    // split_to memotong referensi asli dan mereturn referensi baru
    let symbol = payload.split_to(4);

    // Mengambil sisa payload sebagai data integer (menggunakan trait Buf)
    let price = payload.get_u64_le();

    Ok(MarketDataPacket { symbol, price })
}

/// Mensimulasikan pembangunan buffer dinamis (BytesMut)
pub fn create_outgoing_message(symbol: &[u8], price: u64) -> Bytes {
    // Alokasi awal yang mencegah re-allocations
    let mut buf = BytesMut::with_capacity(64);
    
    // Menulis ke buffer menggunakan trait BufMut
    buf.put(symbol);
    buf.put_u64_le(price);
    
    // freeze() mengubah BytesMut menjadi Bytes (Read-Only) dalam O(1) time
    // Tidak ada alokasi heap baru, hanya perubahan state internal flag.
    buf.freeze()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_copy_parsing() {
        let raw_data = b"AAPL\x00\x00\x00\x00\x00\x00\x00\x01"; // "AAPL" + 1_u64
        let bytes_data = Bytes::from_static(raw_data);
        
        let packet = parse_packet(bytes_data).unwrap();
        assert_eq!(&packet.symbol[..], b"AAPL");
        assert_eq!(packet.price, 72057594037927936); // Representation of bytes in LE
    }
}
```

## Anti-Patterns

1. **Iterasi Byte per Byte di Crate `bytes`**
   - *Bahaya*: Melakukan `for byte in my_bytes.iter()` secara manual lebih lambat daripada operasi slice murni (`[..]`).
   - *Solusi*: Casting ke slice standar via `as_ref()` (`&[u8]`) jika Anda perlu menggunakan pencocokan memori intrinsik (mis. `memchr`) atau memparsing byte-per-byte.

2. **Terlalu Sering Memanggil `split` pada Partisi Kecil**
   - *Bahaya*: Setiap kali `Bytes::split` dipanggil, tipe ini harus merawat ARC dan *pointer offsets*. Jika Anda membelah paket menjadi puluhan kepingan ukuran 1 byte menggunakan `Bytes`, biaya manajemen reference counting akan melebihi biaya memcpy array 10 byte biasa.
   - *Solusi*: Tipe `Bytes` bersinar untuk slice besar atau *payload* yang diteruskan ke channel Toko. Untuk primitive data ringan (seperti u8, u32), cukup copy datanya (`get_u32()`).

## Edge Cases & Defensive Engineering
- **Capacity Reservation**: Saat mengumpulkan data dari TCP stream via `tokio::io::AsyncReadExt::read_buf`, pastikan `BytesMut` memiliki *reserve capacity*. Jika ruang habis, `BytesMut` akan diam-diam mengalokasikan heap baru yang sangat lambat.
- **Vulnerability - Memory Leak (Ghost Retention)**: Jika Anda mengunduh paket sebesar 10MB ke dalam `Bytes`, lalu men-*slice* (split) 4 byte header untuk disimpan permanen (misal: di cache HashMap) sedangkan Anda membuang sisa data 10MB-nya... 10MB data aslinya **TIDAK AKAN** dibebaskan. Hal ini terjadi karena 4 byte slice yang tersimpan menahan seluruh ARC pointer asli! Dalam kasus ini, alih-alih `split`, salin 4 byte tersebut ke `Vec<u8>` baru agar blok 10MB bisa di-*drop*.
