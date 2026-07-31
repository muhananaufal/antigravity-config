# Tokio Framed Codec & Length-Delimited Framing

## Konsep Utama
Dalam komunikasi TCP raw, data datang sebagai aliran byte kontinyu (stream) tanpa ada batas yang jelas antara satu "pesan" dengan pesan lainnya. Jika aplikasi membaca 1024 byte, bisa jadi itu berisi setengah pesan, satu setengah pesan, atau bagian dari beberapa pesan. `tokio_util::codec` menyediakan abstraksi `Encoder` dan `Decoder` untuk mengubah aliran byte yang kacau balau ini menjadi stream of discrete messages (frames). Salah satu metode framing paling populer adalah *Length-Delimited Framing*, di mana setiap pesan diawali dengan panjang dari pesan tersebut.

Kapan digunakan:
- Membangun protokol TCP kustom di atas `tokio`.
- Berkomunikasi dengan sistem legacy yang menggunakan protokol panjang-prefix (seperti FIX protocol atau aplikasi perbankan ISO-8583).
- Implementasi message queue internal antar komponen.

## Arsitektur & Aliran Framing

```text
       Write (Application)                          Read (Application)
               |                                          ^
               v                                          |
      +-----------------+                        +-----------------+
      |                 |                        |                 |
      |     Encoder     |                        |     Decoder     |
      | (Struct -> Byte)|                        | (Byte -> Struct)|
      |                 |                        |                 |
      +--------+--------+                        +--------+--------+
               |                                          ^
               v                                          |
      +-----------------+                        +-----------------+
      |                 |    Raw Byte Stream     |                 |
      |  Length Prefix  | ---------------------> |  Length Prefix  |
      | (e.g., 4 bytes) |      (TCP Socket)      |   Extraction    |
      |                 |                        |                 |
      +-----------------+                        +-----------------+
```

## Production-Ready Implementation

### Kode Rust
```rust
use bytes::{Buf, BufMut, BytesMut};
use std::io;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::codec::{Decoder, Encoder, Framed, LengthDelimitedCodec};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct CustomMessage {
    pub id: u32,
    pub payload: String,
}

/// Custom Codec yang membungkus LengthDelimitedCodec dengan Bincode/Serde
pub struct CustomMessageCodec {
    // Kita gunakan codec bawaan untuk menangani pembatas panjangnya
    length_codec: LengthDelimitedCodec,
}

impl CustomMessageCodec {
    pub fn new() -> Self {
        Self {
            // Konfigurasi panjang frame maksimal (misal 1 MB)
            length_codec: LengthDelimitedCodec::builder()
                .max_frame_length(1024 * 1024)
                .new_codec(),
        }
    }
}

impl Decoder for CustomMessageCodec {
    type Item = CustomMessage;
    type Error = io::Error;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        // Delegate ekstraksi frame ke LengthDelimitedCodec
        if let Some(frame) = self.length_codec.decode(src)? {
            // Deserialize byte frame ke struct kita
            let message: CustomMessage = bincode::deserialize(&frame)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            Ok(Some(message))
        } else {
            Ok(None)
        }
    }
}

impl Encoder<CustomMessage> for CustomMessageCodec {
    type Error = io::Error;

    fn encode(&mut self, item: CustomMessage, dst: &mut BytesMut) -> Result<(), Self::Error> {
        // Serialize struct ke bytes
        let encoded = bincode::serialize(&item)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        
        // Delegate penambahan length prefix dan penulisan buffer
        self.length_codec.encode(bytes::Bytes::from(encoded), dst)?;
        Ok(())
    }
}

pub async fn run_server() -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    
    loop {
        let (socket, _) = listener.accept().await?;
        
        tokio::spawn(async move {
            let mut framed = Framed::new(socket, CustomMessageCodec::new());
            
            while let Some(result) = framed.next().await {
                match result {
                    Ok(msg) => {
                        println!("Server received: {:?}", msg);
                        // Echo back
                        if let Err(e) = framed.send(msg).await {
                            eprintln!("Failed to send: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Codec error: {}", e);
                        break;
                    }
                }
            }
        });
    }
}

pub async fn run_client() -> io::Result<()> {
    let socket = TcpStream::connect("127.0.0.1:8080").await?;
    let mut framed = Framed::new(socket, CustomMessageCodec::new());

    let msg = CustomMessage {
        id: 42,
        payload: "Hello Tokio Framed!".into(),
    };

    framed.send(msg).await?;
    
    if let Some(Ok(response)) = framed.next().await {
        println!("Client received: {:?}", response);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::BytesMut;

    #[test]
    fn test_custom_message_codec() {
        let mut codec = CustomMessageCodec::new();
        let mut buffer = BytesMut::new();
        
        let msg = CustomMessage { id: 1, payload: "Test".into() };
        
        // Test Encoder
        codec.encode(msg, &mut buffer).unwrap();
        assert!(!buffer.is_empty());
        
        // Test Decoder
        let decoded = codec.decode(&mut buffer).unwrap().unwrap();
        assert_eq!(decoded.id, 1);
        assert_eq!(decoded.payload, "Test");
    }
}
```

## Anti-Patterns

### Anti-Pattern 1: Mengabaikan Batas Ukuran Frame Maksimal
**Mengapa berbahaya:** Jika attacker mengirimkan 4-byte header yang mengindikasikan ukuran payload sebesar 4 GB `(0xFFFFFFFF)` namun tidak pernah benar-benar mengirim isi payloadnya, `Decoder` akan mencoba mengalokasikan 4 GB RAM dengan `BytesMut`. Ini adalah serangan OOM (Out Of Memory) yang klasik.
**Solusi:** Selalu atur `.max_frame_length()` di konfigurasi codec. Jangan biarkan client bebas mendikte memori yang akan dialokasikan oleh server.

### Anti-Pattern 2: Melakukan Blocking Operation di dalam `decode()`
**Mengapa berbahaya:** Method `decode` dan `encode` berjalan synchronously di dalam pipeline tokio event loop (saat membaca dari buffer I/O). Melakukan network call lain, filesystem access, atau komputasi kriptografi intensif di dalam method codec ini akan memblokir thread worker tokio, yang dapat membuat loop jaringan terhenti.
**Solusi:** Codec hanya boleh melakukan parsing/serialisasi yang super cepat. Offload komputasi berat ke worker tasks sesudah `Framed::next()` me-return parsed message.

## Edge Cases & Defensive Programming
- **Data Tidak Cukup (Partial Frames):** Method `decode` akan dipanggil berulang kali. Jika `src` buffer belum memiliki byte yang cukup untuk membentuk pesan utuh, method harus mereturn `Ok(None)`. Ini memberi tahu `tokio` untuk menunggu socket dan mengisi `src` dengan sisa byte yang tiba dari jaringan sebelum memanggil `decode` lagi.
- **Handling TCP Close:** Saat koneksi ditutup secara clean oleh peer, socket akan mengembalikan 0 bytes read. `Framed` stream secara otomatis akan mereturn `None`. Pastikan logika loop Anda menangani `None` dengan graceful exit (break), bukan mencoba membacanya berulang-ulang yang bisa menyebabkan busy loop CPU.
- **Backpressure pada Penulisan:** `framed.send(msg).await` memanfaatkan mekanisme `SinkExt`. Operasi `.await` pada `send()` tidak akan resolve sebelum buffer I/O internal cukup kosong untuk menampung pesan baru. Ini adalah backpressure natif tokio, yang mencegah memory server bocor saat mengirim data ke client yang lelet.
