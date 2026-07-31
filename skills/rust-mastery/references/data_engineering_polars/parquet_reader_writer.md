# Parquet Reader & Writer internals

## Konsep Utama
Apache Parquet adalah format file berorientasi kolom yang highly compressed. Ekosistem Rust (`parquet` crate dari Apache Arrow) menyediakan kontrol tingkat rendah atas I/O struktur Parquet, termasuk membatasi akses pada level *Row Group* atau *Column Chunk*, penggunaan Dictionary/RLE (Run-Length Encoding) untuk kompresi data repetitif, serta pembacaan selektif bermodalkan *Bloom Filters* dan *Statistics*.

## Arsitektur & Flow
```text
[ Parquet File ]
   +-- [ Metadata & Footer (Statistics, Min, Max, Bloom Filters) ]
   +-- [ Row Group 1 (100K rows) ]
         +-- [ Column Chunk A ] -> RLE / Snappy Compressed
         +-- [ Column Chunk B ]
   +-- [ Row Group 2 ] ...
```
(Pushdown: Jika filter cari `A = 10`, tapi metadata RG 2 menunjukkan `Min=20, Max=50`, maka RG 2 dilewati tanpa I/O sama sekali!)

## Production-Ready Code
```rust
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::writer::SerializedFileWriter;
use parquet::schema::parser::parse_message_type;
use parquet::record::{Row, Field};
use parquet::basic::{Compression, Encoding};
use parquet::file::properties::WriterProperties;
use std::fs::File;
use std::sync::Arc;

pub fn write_optimized_parquet(path: &str) -> parquet::errors::Result<()> {
    // 1. Definisikan Schema secara manual (String)
    let schema = "
        message user_schema {
            REQUIRED INT32 id;
            REQUIRED BYTE_ARRAY name (UTF8);
        }
    ";
    let schema_type = Arc::new(parse_message_type(schema).unwrap());
    
    let file = File::create(path)?;

    // 2. Setup Properties dengan Kompresi yang kuat dan Statistics enable
    let props = Arc::new(
        WriterProperties::builder()
            .set_compression(Compression::ZSTD(Default::default()))
            .set_dictionary_enabled(true)
            .set_statistics_enabled(parquet::file::properties::EnabledStatistics::Chunk)
            .build()
    );

    let mut writer = SerializedFileWriter::new(file, schema_type, props)?;

    // 3. Tulis Row Group
    let mut row_group_writer = writer.next_row_group()?;
    
    // Tulis kolom pertama (id)
    if let Some(mut col_writer) = row_group_writer.next_column()? {
        use parquet::column::writer::ColumnWriter;
        if let ColumnWriter::Int32ColumnWriter(ref mut typed_writer) = col_writer.untyped() {
            typed_writer.write_batch(&[1, 2, 3], None, None)?;
        }
        row_group_writer.close_column(col_writer)?;
    }

    // Tulis kolom kedua (name)
    if let Some(mut col_writer) = row_group_writer.next_column()? {
        use parquet::column::writer::ColumnWriter;
        if let ColumnWriter::ByteArrayColumnWriter(ref mut typed_writer) = col_writer.untyped() {
            let arrays = [
                parquet::data_type::ByteArray::from("Alice"),
                parquet::data_type::ByteArray::from("Bob"),
                parquet::data_type::ByteArray::from("Charlie"),
            ];
            typed_writer.write_batch(&arrays, None, None)?;
        }
        row_group_writer.close_column(col_writer)?;
    }

    writer.close_row_group(row_group_writer)?;
    writer.close()?;
    Ok(())
}

pub fn read_metadata(path: &str) -> parquet::errors::Result<()> {
    let file = File::open(path)?;
    let reader = SerializedFileReader::new(file)?;
    
    // Akses metadata di Footer tanpa membaca seluruh data payload!
    let metadata = reader.metadata();
    
    println!("Total Rows: {}", metadata.file_metadata().num_rows());
    println!("Total Row Groups: {}", metadata.row_groups().len());
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_read_parquet() {
        let path = "test_output.parquet";
        write_optimized_parquet(path).unwrap();
        read_metadata(path).unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
```

## Anti-Patterns

1. **Batch Size yang Terlalu Kecil Saat Menulis**
   - *Mengapa berbahaya:* Menulis batch ukuran 100-1000 row memicu overhead kompresi. Dictionary encoding menjadi tidak berguna, statistik membengkak, dan memori Zstd tersia-siakan. 
   - *Solusi:* Row Groups harus berisi setidaknya 100k hingga 1 Juta row. Flush column writer pada besaran data minimal belasan Megabytes.

2. **Membaca Semua Kolom Saat Hanya Butuh Satu**
   - *Mengapa berbahaya:* Format Parquet dirancang agar column tidak dibaca jika tidak diminta.
   - *Solusi:* Saat menginisiasi Arrow/Polars Parquet scanner, pass `projection` index secara eksplisit agar I/O disk untuk kolom yang diabaikan tidak pernah dijalankan.

## Edge Cases & Defensive Programming
- **Timestamp & Timezone:** Arrow timestamp microsecond vs millisecond sering bermasalah di Parquet int96 format lama (legacy). Jika berurusan dengan interop Spark/Presto, eksplisit setup WriterProperties versi V2 untuk compatibility integer based timestamp logic dan hindari Int96.
- **Corrupted Footer:** Parquet menempatkan metadatanya di akhir file (Footer). File Parquet yang gagal di-close atau dipotong di tengah pengiriman IO stream tidak dapat dibaca atau direcover (akan terjadi EOF error di magic header parser).
