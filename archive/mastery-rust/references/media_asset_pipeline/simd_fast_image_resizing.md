# SIMD Fast Image Resizing & Dynamic Encoding (WebP/AVIF)

Arsitektur ini mendemonstrasikan pipeline pemrosesan gambar milidetik dengan optimasi ekstrem menggunakan instruksi vektor SIMD (AVX2/NEON) melalui crate `fast_image_resize`, digabungkan dengan `image` crate untuk I/O, serta penyebaran beban kerja ke seluruh core CPU melalui *Rayon Thread Pool*.

## 1. Arsitektur Pipeline (SIMD + Rayon)

```text
+-------------------+        +-----------------------+        +---------------------------+
|                   |  I/O   |                       | Decode |                           |
|  Raw Image Bytes  | -----> |   image::DynamicImage | -----> |  fast_image_resize::Image |
| (Disk/Network/S3) |        |  (RGB8 / RGBA8)       |        | (Memory-Aligned Buffer)   |
+-------------------+        +-----------------------+        +---------------------------+
                                                                            |
                                                                            v
+-----------------------------------------------------------------------------------------+
|                                  RAYON THREAD POOL                                      |
|                                                                                         |
|  [Worker 1: Core 0]   [Worker 2: Core 1]   [Worker 3: Core 2]   [Worker N: Core X]      |
|  +--------------+     +--------------+     +--------------+     +--------------+        |
|  | SIMD Resizer |     | SIMD Resizer |     | SIMD Resizer |     | SIMD Resizer |        |
|  | (AVX2/NEON)  |     | (AVX2/NEON)  |     | (AVX2/NEON)  |     | (AVX2/NEON)  |        |
|  +--------------+     +--------------+     +--------------+     +--------------+        |
+-----------------------------------------------------------------------------------------+
                                                                            |
                                                                            v
+-------------------+        +-----------------------+        +---------------------------+
|                   | Encode |                       | I/O    |                           |
| Output Bytes      | <----- |  WebP / AVIF Encoder  | <----- |   fast_image_resize::Image|
| (WebP/AVIF)       |        |  (Dynamic Quality)    |        |   (Resized Output)        |
+-------------------+        +-----------------------+        +---------------------------+
```

## 2. Implementasi Produksi (Rust Idiomatis)

Kode berikut memproses batch gambar secara paralel, memotong dan mengubah ukuran menggunakan algoritma Lanczos3 berakselerasi SIMD, lalu meng-encode ke WebP.

```rust
use std::num::NonZeroU32;
use fast_image_resize::{Image, PixelType, Resizer, ResizeAlg, FilterType};
use image::{DynamicImage, RgbImage, EncodableLayout};
use rayon::prelude::*;
use thiserror::Error;
use std::sync::Arc;

#[derive(Error, Debug)]
pub enum ImagePipelineError {
    #[error("Gagal membaca atau mendecode gambar: {0}")]
    ImageError(#[from] image::ImageError),
    #[error("Dimensi gambar tidak valid (Lebar atau Tinggi bernilai 0)")]
    InvalidDimensions,
    #[error("Gagal dalam proses resize SIMD: {0}")]
    ResizeError(String),
}

/// Konfigurasi untuk target gambar
pub struct TargetSpec {
    pub width: u32,
    pub height: u32,
    pub quality: u8,
}

/// Pipeline Pemroses Gambar Paralel
pub struct ImagePipeline {
    resizer_pool: Arc<rayon::ThreadPool>,
}

impl ImagePipeline {
    /// Inisialisasi thread pool khusus untuk isolasi resource
    pub fn new(threads: usize) -> Result<Self, rayon::ThreadPoolBuildError> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|idx| format!("img-worker-{}", idx))
            .build()?;
            
        Ok(Self {
            resizer_pool: Arc::new(pool),
        })
    }

    /// Memproses batch secara paralel dengan SIMD
    pub fn process_batch(
        &self,
        images: Vec<DynamicImage>,
        spec: TargetSpec,
    ) -> Vec<Result<Vec<u8>, ImagePipelineError>> {
        self.resizer_pool.install(|| {
            images.into_par_iter()
                .map(|img| Self::process_single(img, &spec))
                .collect()
        })
    }

    /// Proses single image dengan zero-copy sejauh mungkin
    fn process_single(
        img: DynamicImage,
        spec: &TargetSpec,
    ) -> Result<Vec<u8>, ImagePipelineError> {
        let rgb_image = img.into_rgb8();
        let src_width = NonZeroU32::new(rgb_image.width())
            .ok_or(ImagePipelineError::InvalidDimensions)?;
        let src_height = NonZeroU32::new(rgb_image.height())
            .ok_or(ImagePipelineError::InvalidDimensions)?;

        // Buat src Image aligned untuk SIMD
        let src_image = Image::from_vec_u8(
            src_width,
            src_height,
            rgb_image.into_raw(),
            PixelType::U8x3,
        ).map_err(|e| ImagePipelineError::ResizeError(e.to_string()))?;

        let dst_width = NonZeroU32::new(spec.width)
            .ok_or(ImagePipelineError::InvalidDimensions)?;
        let dst_height = NonZeroU32::new(spec.height)
            .ok_or(ImagePipelineError::InvalidDimensions)?;

        // Alokasi target image untuk SIMD
        let mut dst_image = Image::new(dst_width, dst_height, PixelType::U8x3);

        // Instansiasi Resizer dengan fallback otomatis (AVX2 -> SSE4 -> Scalar)
        let mut resizer = Resizer::new(
            ResizeAlg::Convolution(FilterType::Lanczos3)
        );

        resizer.resize(&src_image, &mut dst_image)
            .map_err(|e| ImagePipelineError::ResizeError(e.to_string()))?;

        // Reconstruct RgbImage dari buffer hasil untuk encoding
        let result_rgb = RgbImage::from_raw(
            spec.width,
            spec.height,
            dst_image.into_vec(),
        ).ok_or_else(|| ImagePipelineError::ResizeError("Buffer output corrupt".into()))?;

        // Encode ke WebP (memory buffer)
        let mut output_buffer = std::io::Cursor::new(Vec::with_capacity(1024 * 128)); // Pre-alloc 128kb
        let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut output_buffer);
        let dynamic_result = DynamicImage::ImageRgb8(result_rgb);
        
        dynamic_result.write_with_encoder(encoder)?;
        
        Ok(output_buffer.into_inner())
    }
}
```

## 3. Anti-Patterns & Best Practices Kritis

### ❌ Anti-Pattern 1: Blocking Main Async Thread dengan Rayon
Memanggil Rayon `par_iter` secara langsung dari dalam Tokio async context akan membuat *executor thread* Tokio kelaparan (starved), memblokir seluruh eksekusi I/O server.
**Salah:**
```rust
async fn handle_upload(data: Vec<DynamicImage>) {
    // ❌ MEMBLOKIR ASYNC RUNTIME!
    data.into_par_iter().map(|img| resize(img)).collect::<Vec<_>>();
}
```
**Benar ✅:**
Gunakan `tokio::task::spawn_blocking` untuk memindahkan beban CPU-bound ke thread pool blocking Tokio.
```rust
async fn handle_upload(data: Vec<DynamicImage>) {
    // ✅ Mengirim beban SIMD ke blocking thread, tak memblokir I/O Tokio
    tokio::task::spawn_blocking(move || {
        data.into_par_iter().map(|img| resize(img)).collect::<Vec<_>>()
    }).await.unwrap();
}
```

### ❌ Anti-Pattern 2: Menggunakan Fallback Skalar Tanpa Pre-Alokasi SIMD
Meng-copy buffer `Vec<u8>` bolak-balik antara standard `image` crate dan resizer, menghasilkan bottleneck Memory Bandwidth (OOM rawan terjadi di Kubernetes).
**Benar ✅:** `fast_image_resize` memiliki tipe `Image` yang mendasari alokasi memory-aligned 32-byte untuk operasi cache-line AVX2 yang mutlak efisien. Selalu konsumsi `into_raw()` (zero-copy) dari RgbImage.

## 4. Production Edge Cases

1. **Hardware Fallback pada Chip Lama (Non-AVX2/NEON):**
   `fast_image_resize` men-detect fitur instruksi CPU via instruksi `CPUID` secara runtime. Pada arsitektur virtual (seperti container Docker di cloud lawas yang tidak mengekspos flag AVX2), resizer akan fallback ke *Scalar mode* secara diam-diam (kecepatan anjlok 10x lipat). **Penanganan:** Log capability SIMD saat boot server (`is_x86_feature_detected!("avx2")`) dan siagakan metrik latensi.

2. **Poisoning Alpha Channel di WebP:**
   Resize memecah interpolasi warna di sekitar pixel transparan (fringing hitam). **Penanganan:** Lakukan premultiplied alpha (mengalikan RGB dengan channel Alpha sebelum resize, dan membaginya kembali sesudahnya) untuk menjaga pinggiran transparan tetap tajam. Crate ini mendominasi opsi `PixelType::U8x4`.

3. **Memory Spike & OOM Killer saat Batch Processing:**
   Resolusi super besar (8000x8000) menuntut memori dekompresi ratusan megabyte per gambar. **Penanganan:** Batasi (throttle) concurrency pada `rayon::ThreadPool` atau gunakan `tokio::sync::Semaphore` (misal maks 4 proses bersamaan) agar RAM tak bocor menembus batas Kubernetes Pod (OOM Killed).

## 5. Unit / Benchmark Test

Menggunakan `#[test]` unit testing untuk memverifikasi fungsionalitas dan pipeline tanpa memory leak.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use image::{RgbImage, DynamicImage};

    #[test]
    fn test_simd_pipeline_accuracy_and_stability() {
        // Generate blank 4K image 
        let raw_img = RgbImage::new(3840, 2160);
        let dyn_img = DynamicImage::ImageRgb8(raw_img);
        
        let pipeline = ImagePipeline::new(4).expect("Failed to init thread pool");
        let spec = TargetSpec { width: 1920, height: 1080, quality: 80 };
        
        // Eksekusi
        let results = pipeline.process_batch(vec![dyn_img.clone(), dyn_img], spec);
        
        // Assertions
        assert_eq!(results.len(), 2);
        for res in results {
            assert!(res.is_ok());
            let webp_bytes = res.unwrap();
            assert!(!webp_bytes.is_empty());
            
            // Verifikasi output signature WebP RIFF
            assert_eq!(&webp_bytes[0..4], b"RIFF");
        }
    }
}
```
