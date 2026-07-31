# DataFusion SQL Engine

## Konsep Utama
Apache DataFusion adalah query engine (seperti Postgres, tapi in-memory, distributed-ready) yang ditulis dalam Rust dan didasarkan pada Apache Arrow. Alih-alih hanya DataFrame API, DataFusion mengeksekusi dialek ANSI SQL. Ekosistem ini menyediakan SQL Parser, Query Planner (Logical & Physical), serta execution model berbasis Volcano/Vectorized.

## Arsitektur & Flow
```text
[ SQL String ] --> ( SQL Parser ) --> [ AST ]
                                        |
      +--- ( Data Dictionary & UDF Registration ) ---+
      |
[ Logical Plan ] --> ( Rule-based Optimizer: Pushdown, Simplification )
      |
[ Physical Plan ] --> ( Execution Engine: Partitioning, Vectorized execution ) --> Arrow RecordBatches
```

## Production-Ready Code
```rust
use datafusion::prelude::*;
use datafusion::arrow::datatypes::{DataType, Field, Schema};
use datafusion::arrow::array::Int64Array;
use datafusion::logical_expr::{create_udf, Volatility};
use std::sync::Arc;

// Mendefinisikan Custom UDF (User Defined Function)
// Scalar UDF yang akan menambahkan +100 pada input integer.
fn add_100_impl(args: &[datafusion::arrow::array::ArrayRef]) -> datafusion::error::Result<datafusion::arrow::array::ArrayRef> {
    let array = args[0].as_any().downcast_ref::<Int64Array>()
        .expect("Argument is not Int64");
    
    // Perhitungan Vectorized
    let result: Int64Array = array.iter().map(|opt| opt.map(|v| v + 100)).collect();
    Ok(Arc::new(result))
}

#[tokio::main]
pub async fn run_sql_engine() -> datafusion::error::Result<()> {
    // 1. Buat Context, entrypoint eksekusi
    let ctx = SessionContext::new();

    // 2. Mendaftarkan UDF kustom ke query planner
    let my_udf = create_udf(
        "add_100",
        vec![DataType::Int64], // Input type
        Arc::new(DataType::Int64), // Return type
        Volatility::Immutable,
        Arc::new(add_100_impl),
    );
    ctx.register_udf(my_udf);

    // 3. Register Data Source (misal Parquet atau CSV)
    ctx.register_parquet("users", "users_data.parquet", Default::default()).await?;

    // 4. Eksekusi SQL 
    let sql = "
        SELECT 
            region, 
            add_100(salary) as boosted_salary
        FROM users 
        WHERE salary > 50000 
        ORDER BY boosted_salary DESC
    ";

    let df = ctx.sql(sql).await?;

    // Menampilkan Execution Plan
    df.explain(false, false)?.show().await?;

    // Mengeksekusi dan mengumpulkan hasil ke memori (Arrow RecordBatches)
    let batches = df.collect().await?;
    
    if !batches.is_empty() {
        datafusion::arrow::util::pretty::print_batches(&batches)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_udf_logic() {
        let input = Arc::new(Int64Array::from(vec![Some(10), None, Some(20)])) as datafusion::arrow::array::ArrayRef;
        let res = add_100_impl(&[input]).unwrap();
        let out = res.as_any().downcast_ref::<Int64Array>().unwrap();
        
        assert_eq!(out.value(0), 110);
        assert!(out.is_null(1));
        assert_eq!(out.value(2), 120);
    }
}
```

## Anti-Patterns

1. **Menarik Data ke Memori untuk Logika Sederhana**
   - *Mengapa berbahaya:* Menggunakan `df.collect().await?` lalu memanipulasi *Vec* di Rust menggunakan iterator konvensional akan melepas semua optimasi planner DataFusion.
   - *Solusi:* Daftarkan custom business logic sebagai `UDF` (Scalar) atau `UDAF` (Aggregate) seperti kode di atas agar dijalankan langsung oleh worker internal DataFusion.

2. **Concurrency Tanpa Partisi**
   - *Mengapa berbahaya:* DataFusion menjalankan job secara multithreaded (1 thread per partisi). Jika Anda memuat single-file CSV/Parquet raksasa, engine mungkin hanya mengalokasikan 1 CPU thread.
   - *Solusi:* Setup `SessionConfig` dengan `target_partitions`. Gunakan dataset terdistribusi (direktori dengan ratusan file `.parquet`) atau gunakan format yang mendukung split secara fisik.

## Edge Cases & Defensive Programming
- **OOM pada Join & Sort:** Secara default, operasi Join dan eksekusi SORT membutuhkan jumlah buffer memori yang sangat besar. Pada dataset triliunan baris, Anda akan OOM. Aktifkan *Disk Spill* di configurasi (`config.with_spill_dir`) agar engine melakukan flush block buffer ke disk layaknya database konvensional.
- **SQL Injection:** Karena fungsi `.sql()` menerima String mentah, jangan pernah melakukan interpolasi format Rust (`format!("SELECT * FROM {}", table_name)`) langsung dari input pengguna jika table tidak disanitasi.
