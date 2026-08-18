# FFMPEG-Next Video Transcoding & HLS Streaming

Pemrosesan video level server rentan terhadap kebocoran memori pada bindings C/C++ FFI. Referensi ini menunjukkan arsitektur abstraksi menggunakan crate `ffmpeg-next` untuk melilit _libavcodec / libavformat_, memastikan segmentasi stream video Zero-Copy dalam koridor _Ownership & Borrowing_ Rust yang sakral.

## 1. Arsitektur FFI Ownership & HLS Segmenter

```text
+-----------------------+        +--------------------------+        +--------------------------+
|  Input Video (MP4)    |        | Rust Ownership Scope     |        | FFMPEG C Memory Space    |
| (libavformat Demuxer) | -----> | `ffmpeg::Packet` (Ptr)   | -----> | `avcodec_send_packet`    |
+-----------------------+        | [Zero-Copy Reference]    |        | (Decode to YUV Frame)    |
                                 +--------------------------+        +--------------------------+
                                                                                  |
                                                                                  v
+-----------------------+        +--------------------------+        +--------------------------+
| Output HLS (.m3u8)    |        | Rust Ownership Scope     |        | FFMPEG C Memory Space    |
| (libavformat Muxer)   | <----- | `ffmpeg::Frame` (YUV)    | <----- | `avcodec_receive_frame`  |
| Segment 1..N (.ts)    |        | [GPU/CPU Rescaled]       |        | (Encode to H.264/265)    |
+-----------------------+        +--------------------------+        +--------------------------+
```

## 2. Implementasi Produksi (Rust Idiomatis)

Kode ini merupakan abstraksi pipeline aman dari memori yang menerima file input dan mentranskodenya. *(Disimplifikasi; penanganan HLS muxer murni memerlukan inisialisasi context format detail, fokus difokuskan ke memory-safety FFI).*

```rust
use ffmpeg_next as ffmpeg;
use ffmpeg::{codec, format, media, software::scaling, frame::Video, util::frame::pixel::Pixel};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum TranscodeError {
    #[error("FFMPEG Error: {0}")]
    Ffmpeg(#[from] ffmpeg::Error),
    #[error("No video stream found")]
    NoVideoStream,
}

pub struct Transcoder {
    input_ctx: format::context::Input,
    video_stream_idx: usize,
}

impl Transcoder {
    /// Inisialisasi secara global (wajib dipanggil 1 kali di aplikasi)
    pub fn init() {
        ffmpeg::init().expect("Gagal inisialisasi FFMPEG environment");
    }

    /// Membuka file dan mengamankan konteks (Context ownership)
    pub fn new(input_path: &str) -> Result<Self, TranscodeError> {
        let input_ctx = format::input(&input_path)?;
        
        let video_stream = input_ctx
            .streams()
            .best(media::Type::Video)
            .ok_or(TranscodeError::NoVideoStream)?;
            
        let video_stream_idx = video_stream.index();
        
        Ok(Self {
            input_ctx,
            video_stream_idx,
        })
    }

    /// Eksekusi ekstrak loop (Simulasi Transcode Frame-by-frame)
    pub fn process_frames<F>(&mut self, mut callback: F) -> Result<(), TranscodeError>
    where
        F: FnMut(&Video), // Safe borrowing of decoded frame!
    {
        // Setup Decoder
        let stream = self.input_ctx.stream(self.video_stream_idx).unwrap();
        let decoder_ctx = codec::context::Context::from_parameters(stream.parameters())?;
        let mut decoder = decoder_ctx.decoder().video()?;
        
        // Frame buffer C-allocated yg dibungkus Rust struct
        let mut decoded_frame = Video::empty();

        // Loop Paket Demuxer -> Decoder -> Raw Frame -> Callback
        for (stream_ref, packet) in self.input_ctx.packets() {
            if stream_ref.index() == self.video_stream_idx {
                // FFI Zero-Copy send
                decoder.send_packet(&packet)?;
                
                // Menerima (drain) semua frame yang berhasil ter-decode
                while decoder.receive_frame(&mut decoded_frame).is_ok() {
                    // Eksekusi manipulasi (scaling/overlay) secara aman
                    callback(&decoded_frame);
                }
            }
        }
        
        // Flush internal FFMPEG buffer dengan mengirim paket kosong (EOF)
        decoder.send_eof()?;
        while decoder.receive_frame(&mut decoded_frame).is_ok() {
            callback(&decoded_frame);
        }

        Ok(())
    }
}
```

## 3. Anti-Patterns & Best Practices Kritis

### ❌ Anti-Pattern 1: Mengabaikan Flush (EOF) ke Encoder/Decoder C
Di library C seperti FFMPEG, codec sering mem-*buffer* frame untuk mengekstrak informasi B-Frame (Bidirectional Predictive). Jika Rust program berhenti dari loop utama tanpa memanggil `send_eof()` (Flush), beberapa detik terakhir video akan hilang dan file MP4/M3U8 rusak.
**Benar ✅:** Lihat pada `decoder.send_eof()?` di implementation, flushing wajib hukumnya untuk draining buffer secara paripurna!

### ❌ Anti-Pattern 2: Memory Leak akibat Ownership Transfer Manual (Raw Pointers)
Mendeklarasikan `*mut AVPacket` secara manual menggunakan `malloc` C dan lupa di-*free*. Rust `ffmpeg-next` mendesain _Smart Pointer wrapper_ (misal tipe `ffmpeg::Packet`) yang mengimplementasikan `Drop` trait (sehingga FFI `av_packet_free` dieksekusi transparan).
**Benar ✅:** Dilarang keras menggunakan C raw pointer FFI secara langsung jika crate pelindung (wrapper) safe Rust sudah ada. Selalu gunakan High-Level API.

## 4. Production Edge Cases

1. **Panic pada Callback `ffmpeg::init()` Multithread:**
   Pemanggilan `ffmpeg::init()` tidak Thread-Safe dari sisi C. Jika diletakkan dalam worker Tokio / Rayon, akan berujung Segmentasi Fault! **Penanganan:** Panggil eksklusif hanya di `fn main()` atau bungkus `std::sync::Once::new()` sebelum instance pipeline apapun diinisialisasi.

2. **DTS / PTS Timestamp Corrupt (Muxing Error):**
   Pada jaringan yang fluktuatif atau input file dari kamera CCTV rusak, Decoding Time Stamp (DTS) dapat bernilai mundur (non-monotonik). HLS chunker akan melempar error muxing. **Penanganan:** Selalu interpolasi atau *rewrite timestamp* berdasar frame-rate (Time Base rasio) secara manual di kode Rust sebelum mengirim `Packet` ke encoder (algoritma _monotonic PTS rescale_).

3. **GPU Hardware Acceleration (NVENC/VAAPI) Binding Mismatch:**
   FFMPEG yang dikompilasi OS (via apt/brew) mungkin tidak memiliki header Nvidia CUDA/NVENC. Akibatnya context binding Rust gagal inisialisasi pada production. **Penanganan:** Distribusi harus berbasis Docker dengan custom FFMPEG binary kompilasi (misal _jrottenberg/ffmpeg_) yang disematkan saat tahapan build `cargo build` agar header FFI sinkron dengan hardware.

## 5. Unit / Benchmark Test

Menguji instansiasi decoder memastikan pointer aman tanpa memory leak.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static INIT: Once = Once::new();

    fn setup_ffmpeg() {
        INIT.call_once(|| {
            Transcoder::init();
        });
    }

    #[test]
    #[ignore] // Butuh file dummy.mp4 di root, maka di-ignore pd pipeline default
    fn test_transcoder_memory_safety_loop() {
        setup_ffmpeg();
        
        let mut t = Transcoder::new("dummy.mp4").expect("File mp4 tidak ada");
        let mut frame_count = 0;
        
        // Menguji bahwa callback tidak bocor memori dan pointer borrow valid
        let res = t.process_frames(|frame| {
            assert!(frame.width() > 0);
            frame_count += 1;
        });
        
        assert!(res.is_ok());
        assert!(frame_count > 0, "Video harus memiliki minimum 1 frame");
    }
}
```
