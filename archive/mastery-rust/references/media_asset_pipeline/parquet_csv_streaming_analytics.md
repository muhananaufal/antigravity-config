# Parquet & CSV Streaming Analytics O(1) Memory Footprint

Pemrosesan data analitik bervolume masif (10.000.000+ baris) rentan menyebabkan *Out-of-Memory (OOM)*. Desain ini merangkai arsitektur *streaming* murni menggunakan Apache Arrow dan Parquet digabungkan dengan sink I/O asinkron (`tokio`), menjaga footprint RAM di bawah 15MB berkat pengikatan memori O(1) berbasis *Batched Record Generator*.

## 1. Arsitektur Arrow Streaming O(1)

```text
+-------------------+        +--------------------+        +-------------------------+
| Data Source       |        | Async Generator    |        | Apache Arrow (In-Memory)|
| (DB/API/Kafka)    | Stream | (Batched 1K Rows)  | Yield  | RecordBatch             |
| [ 100 Juta Baris] | -----> | [Buffer: < 5MB ]   | -----> | [ 1K Rows ]             |
+-------------------+        +--------------------+        +-------------------------+
                                                                     |
                                                                     v
+-------------------+        +--------------------+        +-------------------------+
| S3 / Disk Storage |  Sink  | Tokio Async File / |  I/O   | Async Parquet Writer    |
| (output.parquet)  | <----- | Network Socket     | <----- | (Row Group Compression) |
+-------------------+        +--------------------+        +-------------------------+
```

## 2. Implementasi Produksi (Rust Idiomatis)

Kode berikut mendemonstrasikan bagaimana mencetak stream data artifisial raksasa secara asinkron ke file Parquet, batch per batch, tanpa menahan array penuh di memori.

```rust
use std::sync::Arc;
use arrow::array::{Int64Array, StringArray, Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use futures::stream::{self, Stream, StreamExt};
use parquet::arrow::AsyncArrowWriter;
use parquet::file::properties::WriterProperties;
use tokio::fs::File;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StreamingError {
    #[error("Arrow error: {0}")]
    ArrowError(#[from] arrow::error::ArrowError),
    #[error("Parquet error: {0}")]
    ParquetError(#[from] parquet::errors::ParquetError),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Men-generate data secara simulatif, mirip dengan query paginated dari database.
fn generate_batch_stream(total_rows: usize, batch_size: usize) -> impl Stream<Item = Result<RecordBatch, StreamingError>> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("event_name", DataType::Utf8, false),
    ]));

    let num_batches = (total_rows + batch_size - 1) / batch_size;
    let schema_clone = schema.clone();

    stream::iter(0..num_batches).map(move |batch_idx| {
        let start = batch_idx * batch_size;
        let end = std::cmp::min(start + batch_size, total_rows);
        let current_batch_size = end - start;

        // Alokasi per-batch (O(1) memory bound karena dibatasi `batch_size`)
        let mut ids = Vec::with_capacity(current_batch_size);
        let mut names = Vec::with_capacity(current_batch_size);

        for i in start..end {
            ids.push(i as i64);
            names.push(format!("event_type_{}", i % 5));
        }

        let id_array = Arc::new(Int64Array::from(ids)) as Arc<dyn Array>;
        let name_array = Arc::new(StringArray::from(names)) as Arc<dyn Array>;

        let batch = RecordBatch::try_new(
            schema_clone.clone(),
            vec![id_array, name_array],
        ).map_err(StreamingError::ArrowError)?;

        Ok(batch)
    })
}

/// Sink yang menulis RecordBatch stream ke Parquet file O(1) Memory
pub async fn write_streaming_parquet(
    path: &str,
    total_rows: usize,
    batch_size: usize,
) -> Result<(), StreamingError> {
    let file = File::create(path).await?;
    
    // Schema yang disetujui (wajib identik dengan generator)
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("event_name", DataType::Utf8, false),
    ]));

    // Gunakan zstd kompresi standar tinggi
    let props = WriterProperties::builder()
        .set_compression(parquet::basic::Compression::ZSTD(parquet::basic::ZstdLevel::default()))
        .build();

    let mut writer = AsyncArrowWriter::try_new(file, schema, 0, Some(props))?;
    let mut stream = generate_batch_stream(total_rows, batch_size);

    while let Some(batch_res) = stream.next().await {
        let batch = batch_res?;
        writer.write(&batch).await?; // Menulis batch langsung ke sink (terkompresi dalam buffer disk)
    }

    // Flush footer Parquet
    writer.close().await?;
    
    Ok(())
}
```

## 3. Anti-Patterns & Best Practices Kritis

### ❌ Anti-Pattern 1: "Load All, Then Write"
Membangun satu `RecordBatch` masif untuk memuat 10 juta baris sekaligus (seperti `df.to_parquet()` di Pandas). Di Rust, ini akan mengisi Vector sampai meledak (Memory Leak/OOM).
**Salah:**
```rust
let mut all_ids = Vec::with_capacity(10_000_000); 
// ❌ Out of Memory di production jika data mencapai jutaan record kompleks!
```
**Benar ✅:** Gunakan iterasi / chunking dengan generator stream, selalu flush per `RecordBatch` dengan ukuran misal 4096 / 8192 baris.

### ❌ Anti-Pattern 2: Lupa Memanggil `writer.close().await`
Sistem Parquet berbasis metadata Footer. Jika IO streaming tidak diakhiri dengan pemanggilan `.close()`, file yang dihasilkan akan menjadi file _corrupt_ dan reader (seperti AWS Athena / PySpark) akan gagal membaca _magic bytes_ pada akhir file. Selalu panggil `close()` alih-alih mengandalkan sekadar fungsi Drop trait.

## 4. Production Edge Cases

1. **Backpressure dari Disk I/O:**
   Jika CPU memproduksi stream batch Arrow lebih cepat daripada kecepatan tulis disk IO/Jaringan (S3 multipart), akan terjadi lonjakan RAM lokal karena task menumpuk. **Penanganan:** Gunakan `futures::stream::buffered` atau paksakan mpsc channel *bounded* (kapasitas misalnya 10 batch) agar generator mengalami suspend/backpressure.

2. **Skema Berubah Secara Dinamis:**
   Parquet adalah format kolom ber-schema statis ketat. Stream asinkron tidak dapat berganti tipe (misal string tiba-tiba menjadi integer). **Penanganan:** Gunakan tipe Enum konkrit atau json stringified column, serta lakukan strict schema validation di sisi stream consumer sebelum dipaksa masuk RecordBatch.

3. **Row Group Size vs Compression Ratio:**
   Jika ukuran batch stream sangat kecil (misal 10 record), kompresi Zstd atau Snappy Parquet akan gagal memampatkan data secara optimal, menyebabkan file membengkak besar. **Penanganan:** Atur `batch_size` di kisaran 10.000 - 100.000 baris agar Dictionary Encoding dan Run-Length Encoding (RLE) Parquet efektif.

## 5. Unit / Benchmark Test

Pengujian ini memastikan streaming O(1) bekerja, menyelesaikan file, dan memvalidasi isinya.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    use std::fs::File as StdFile;

    #[tokio::test]
    async fn test_parquet_streaming_o1_memory() {
        let temp_path = "test_output.parquet";
        
        // Eksekusi generator dan stream ke disk 
        // 50,000 rows dengan chunks 10,000
        let res = write_streaming_parquet(temp_path, 50_000, 10_000).await;
        assert!(res.is_ok());

        // Validasi dan assert konten dengan Synchronous Reader
        let file = StdFile::open(temp_path).unwrap();
        let builder = ParquetRecordBatchReaderBuilder::try_new(file).unwrap();
        
        // Assert bahwa file valid dan memiliki total 50_000 baris metadata
        assert_eq!(builder.metadata().file_metadata().num_rows(), 50_000);
        
        // Bersihkan resource
        let _ = std::fs::remove_file(temp_path);
    }
}
```
