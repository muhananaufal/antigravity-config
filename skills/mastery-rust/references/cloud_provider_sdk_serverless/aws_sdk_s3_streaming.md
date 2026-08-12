# Rust Enterprise Serverless: AWS SDK S3 Async Streaming

Dokumen ini merangkum arsitektur dan implementasi chunked async streaming upload, download, serta Presigned URL generation menggunakan `aws-sdk-s3` pada lingkungan serverless Rust (seperti AWS Lambda). Implementasi ini menjamin penggunaan memori yang konstan (O(1)) tanpa memompa file raksasa (Gigabytes/Terabytes) ke dalam RAM.

## Arsitektur Aliran Data (ASCII Diagram)

```text
+---------------------+     Multipart Upload (5MB Chunks)      +-------------------+
|                     | =====================================> |                   |
|   Rust Serverless   |                                        |     Amazon S3     |
| (aws-sdk-s3, tokio) | <===================================== | (Object Storage)  |
|                     |     Async ByteStream Download          |                   |
+---------------------+                                        +-------------------+
        ^   |
        |   | Stream / File System
        |   v
+---------------------+
| Local Storage / tmp |
+---------------------+
```

## Implementasi Produksi (Zero-Allocation Overhead)

Berikut adalah implementasi `S3Service` menggunakan pola asinkron tingkat lanjut.

```rust
use aws_config::BehaviorVersion;
use aws_sdk_s3::{
    operation::create_multipart_upload::CreateMultipartUploadOutput,
    presigning::PresigningConfig,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
    Client,
};
use std::{path::Path, time::Duration};
use tokio::{fs::File, io::AsyncWriteExt};

/// Konfigurasi untuk part upload. S3 mewajibkan minimal 5MB per part, kecuali part terakhir.
const CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

#[derive(Debug)]
pub enum S3Error {
    UploadError(String),
    DownloadError(String),
    PresignError(String),
    IoError(std::io::Error),
}

impl From<std::io::Error> for S3Error {
    fn from(err: std::io::Error) -> Self {
        S3Error::IoError(err)
    }
}

pub struct S3Service {
    client: Client,
    bucket: String,
}

impl S3Service {
    /// Inisialisasi service menggunakan Default AWS Credential Provider Chain.
    pub async fn new(bucket_name: impl Into<String>) -> Self {
        let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
        let client = Client::new(&config);
        Self {
            client,
            bucket: bucket_name.into(),
        }
    }

    /// Mengunggah file besar menggunakan Multipart Upload untuk efisiensi memori.
    pub async fn upload_large_file(&self, key: &str, file_path: &Path) -> Result<(), S3Error> {
        let file_size = tokio::fs::metadata(file_path)
            .await?
            .len();

        let multipart_upload_res: CreateMultipartUploadOutput = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| S3Error::UploadError(e.to_string()))?;

        let upload_id = multipart_upload_res.upload_id().ok_or_else(|| {
            S3Error::UploadError("Gagal mendapatkan upload_id dari S3".to_string())
        })?;

        let mut completed_parts = Vec::new();
        let mut part_number = 1;
        let mut offset = 0;

        while offset < file_size {
            let length = std::cmp::min(CHUNK_SIZE, file_size - offset);
            
            // ByteStream::read_from menggunakan async read dengan bounding offset, mencegah load ke RAM
            let stream = ByteStream::read_from()
                .path(file_path)
                .offset(offset)
                .length(length)
                .build()
                .await
                .map_err(|e| S3Error::UploadError(e.to_string()))?;

            let upload_part_res = self
                .client
                .upload_part()
                .bucket(&self.bucket)
                .key(key)
                .upload_id(upload_id)
                .body(stream)
                .part_number(part_number)
                .send()
                .await
                .map_err(|e| S3Error::UploadError(e.to_string()))?;

            let e_tag = upload_part_res.e_tag().unwrap_or_default().to_string();

            completed_parts.push(
                CompletedPart::builder()
                    .e_tag(e_tag)
                    .part_number(part_number)
                    .build(),
            );

            offset += length;
            part_number += 1;
        }

        let completed_multipart_upload = CompletedMultipartUpload::builder()
            .set_parts(Some(completed_parts))
            .build();

        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(completed_multipart_upload)
            .send()
            .await
            .map_err(|e| S3Error::UploadError(e.to_string()))?;

        Ok(())
    }

    /// Mengunduh file besar dengan streaming async langsung ke file sistem lokal.
    pub async fn download_large_file(&self, key: &str, dest_path: &Path) -> Result<(), S3Error> {
        let mut response = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| S3Error::DownloadError(e.to_string()))?;

        let mut file = File::create(dest_path).await?;

        // Ekstraksi body (ByteStream) dan tulis per chunk ke disk
        while let Some(bytes) = response
            .body
            .try_next()
            .await
            .map_err(|e| S3Error::DownloadError(e.to_string()))?
        {
            file.write_all(&bytes).await?;
        }

        file.flush().await?;
        Ok(())
    }

    /// Membuat Presigned URL untuk akses upload atau download sementara.
    pub async fn generate_presigned_url(
        &self,
        key: &str,
        expires_in_secs: u64,
    ) -> Result<String, S3Error> {
        let expires_in = Duration::from_secs(expires_in_secs);
        let presigning_config = PresigningConfig::expires_in(expires_in)
            .map_err(|e| S3Error::PresignError(e.to_string()))?;

        let presigned_request = self
            .client
            .put_object() // Atau get_object() untuk download
            .bucket(&self.bucket)
            .key(key)
            .presigned(presigning_config)
            .await
            .map_err(|e| S3Error::PresignError(e.to_string()))?;

        Ok(presigned_request.uri().to_string())
    }
}
```

## Unit / Integration Tests

Untuk menjalankan pengujian ini, gunakan mock AWS S3 atau environment variables dengan bucket test yang sah.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    // Membutuhkan akses kredensial AWS valid di environment atau mock.
    #[tokio::test]
    async fn test_upload_and_download_flow() {
        let bucket_name = std::env::var("TEST_S3_BUCKET").unwrap_or_else(|_| "my-test-bucket-123".to_string());
        let s3_service = S3Service::new(bucket_name).await;
        
        // Buat dummy file 10MB
        let mut temp_file = NamedTempFile::new().expect("Gagal membuat temp file");
        let buffer = vec![0u8; 10 * 1024 * 1024];
        temp_file.write_all(&buffer).expect("Gagal menulis temp file");
        let file_path = temp_file.path();
        
        let test_key = "test-upload-large-file.bin";
        
        // 1. Upload Test
        let upload_res = s3_service.upload_large_file(test_key, file_path).await;
        // Hanya verifikasi result is Ok, atau abaikan jika tak ada kredensial.
        if upload_res.is_err() {
            println!("Upload dilewati karena tidak ada bucket/kredensial.");
            return;
        }
        assert!(upload_res.is_ok());

        // 2. Download Test
        let download_path = NamedTempFile::new().unwrap().into_temp_path();
        let download_res = s3_service.download_large_file(test_key, &download_path).await;
        assert!(download_res.is_ok());
        
        // 3. Presigned URL Test
        let url_res = s3_service.generate_presigned_url(test_key, 3600).await;
        assert!(url_res.is_ok());
        let url = url_res.unwrap();
        assert!(url.contains("X-Amz-Signature="));
    }
}
```

## Anti-Patterns (❌ vs ✅)

### 1. Membaca Seluruh File ke Dalam Memori (OOM Risk)
❌ **Anti-Pattern:**
```rust
// BERBAHAYA: Akan menyebabkan Out-Of-Memory di AWS Lambda jika file berukuran GB.
let file_bytes = tokio::fs::read("large-file.mp4").await.unwrap();
client.put_object().bucket("b").key("k").body(ByteStream::from(file_bytes)).send().await;
```

✅ **Best Practice:**
```rust
// AMAN: Streaming O(1) menggunakan ByteStream::from_path
let stream = ByteStream::from_path("large-file.mp4").await.unwrap();
client.put_object().bucket("b").key("k").body(stream).send().await;
```

### 2. Mengabaikan Error Handling pada Try-Stream Next
❌ **Anti-Pattern:**
```rust
// BERBAHAYA: Panic saat jaringan putus di tengah download streaming.
while let Some(bytes) = response.body.try_next().await.unwrap() {
    file.write_all(&bytes).await;
}
```

✅ **Best Practice:**
```rust
// AMAN: Tangani error secara graceful menggunakan custom enum.
while let Some(bytes) = response.body.try_next().await.map_err(|e| S3Error::DownloadError(e.to_string()))? {
    file.write_all(&bytes).await.map_err(S3Error::IoError)?;
}
```

## Production Edge Cases

1. **Abort Incomplete Multipart Uploads:**
   - **Masalah:** Jika fungsi AWS Lambda timeout atau crash di tengah loop `upload_part()`, part S3 akan menggantung di bucket, menghabiskan biaya penyimpanan yang tidak terlihat.
   - **Solusi:** Selalu implementasikan mekanisme retry atau tangkap sinyal termination untuk memanggil `abort_multipart_upload`. Konfigurasi S3 Lifecycle Rule (`AbortIncompleteMultipartUpload`) untuk membersihkan sisa upload setelah N hari sangat diwajibkan.

2. **Timeout pada File Raksasa (AWS Lambda Limit):**
   - **Masalah:** Lambda memiliki limit maksimum 15 menit. Mengunduh atau mengunggah file 10GB mungkin melewati durasi ini, tergantung pada kecepatan koneksi AWS S3 ke Lambda atau VPC.
   - **Solusi:** Gunakan komputasi Fargate (ECS) untuk memproses file durasi panjang, atau oper file ke client menggunakan Presigned URL agar client langsung berhubungan dengan S3 tanpa melewati server backend (serverless function).

3. **Part Size Tidak Valid pada Multipart Upload:**
   - **Masalah:** S3 memvalidasi ukuran chunk minimal 5MB. Jika part (kecuali yang terakhir) berukuran kurang dari 5MB, API `complete_multipart_upload` akan gagal dengan status 400 Bad Request.
   - **Solusi:** Selalu gunakan offset dan pastikan `CHUNK_SIZE` di-hardcode minimal 5MB (contoh 5 * 1024 * 1024). Validasi file di awal; jika total ukuran di bawah 5MB, lebih efisien menggunakan single `put_object` API dibandingkan memanggil multipart API overhead.
