# Polars Lazy DataFrame

## Konsep Utama
Polars adalah DataFrame engine berbasis Apache Arrow. Kekuatan terbesarnya adalah `LazyFrame`, yakni representasi logis (AST) dari sebuah query sebelum dieksekusi. Melalui komputasi Lazy, Polars melakukan **Query Optimization** (seperti *Predicate Pushdown* dan *Projection Pushdown*) untuk meminimalkan beban memori dan IO, sehingga dapat memproses dataset yang tidak muat di RAM.

## Arsitektur & Flow
```text
[ scan_parquet() ] --> [ filter() ] --> [ select() ] --> [ groupby() ]
           \_________________________________________________/
                                   |
                  ( Query Optimizer Engine )
           1. Projection Pushdown (Hanya ambil kolom A, B)
           2. Predicate Pushdown (Filter di level pembaca file)
                                   |
[ Optimized Execution Plan (Multithreaded Streaming) ] --> collect() / collect_into_stream()
```

## Production-Ready Code
```rust
use polars::prelude::*;
use std::time::Instant;

pub fn process_sales_data(file_path: &str) -> PolarsResult<DataFrame> {
    let start_time = Instant::now();

    // 1. Inisiasi LAZY frame dengan streaming support
    let mut args = ScanArgsParquet::default();
    args.n_rows = None; // Ambil semua
    
    // Scan file parquet tanpa memuat seluruhnya ke memory
    let lazy_df = LazyFrame::scan_parquet(file_path, args)?;

    // 2. Deklarasi operasi, optimizer akan menyusun ulang
    let optimized_plan = lazy_df
        // Predicate Pushdown: filter akan ditarik ke level I/O Parquet Row Groups
        .filter(col("status").eq(lit("COMPLETED")))
        .filter(col("amount").gt(lit(100.0)))
        
        // Group By dengan agregasi
        .group_by([col("region")])
        .agg([
            col("amount").sum().alias("total_sales"),
            col("transaction_id").count().alias("transaction_count"),
        ])
        
        // Sortir descending
        .sort("total_sales", SortOptions { 
            descending: true,
            nulls_last: true,
            multithreaded: true,
            maintain_order: false
        })
        
        // Projection Pushdown: hanya butuh region, status, amount, transaction_id
        // di level scan file, kolom lainnya akan diabaikan!
        .select([
            col("region"),
            col("total_sales"),
            col("transaction_count")
        ]);

    // 3. Eksekusi query logis ke memori
    // Opsi `streaming(true)` memproses dataset berukuran di atas RAM (out-of-core)
    let result_df = optimized_plan.with_streaming(true).collect()?;
    
    println!("Query executed in: {:?}", start_time.elapsed());
    
    Ok(result_df)
}

#[cfg(test)]
mod tests {
    use super::*;
    use polars::df;

    #[test]
    fn test_polars_syntax() -> PolarsResult<()> {
        let df = df! (
            "region" => &["US", "EU", "US"],
            "amount" => &[200.0, 50.0, 300.0],
            "status" => &["COMPLETED", "COMPLETED", "COMPLETED"],
            "transaction_id" => &[1, 2, 3]
        )?;
        
        let lazy = df.lazy()
            .filter(col("amount").gt(lit(100.0)))
            .group_by([col("region")])
            .agg([col("amount").sum().alias("total")]);
            
        let res = lazy.collect()?;
        assert_eq!(res.height(), 1); // US doang
        Ok(())
    }
}
```

## Anti-Patterns

1. **Eager Evaluation Prematur**
   - *Mengapa berbahaya:* Memanggil `.collect()` terlalu dini, memanipulasinya secara fungsional dengan mutasi array standar, dan kemudian membuat dataframe lagi. Ini merusak kemampuan optimizer.
   - *Solusi:* Tetap di domain `LazyFrame` menggunakan Expression (`col()`, `.when().then()`, `.apply()`) selama mungkin.

2. **Penggunaan Apply/UDF Berlebihan**
   - *Mengapa berbahaya:* `.apply` untuk custom Rust lambda memaksa Polars melepaskan eksekusi multithreaded native Arrow dan serialize per-row. Performa bisa turun drastis (mirip `.apply` di pandas).
   - *Solusi:* Ekspresikan logika menggunakan Polars Expression API (math operator, string manipulasi) karena ini dieksekusi via SIMD/multithreaded backend.

## Edge Cases & Defensive Programming
- **Streaming Limitation:** Walaupun `.with_streaming(true)` luar biasa untuk OOM prevention, belum semua operasi mendukung streaming (contoh: *cross-joins* memori besar atau full sort eksternal yang kompleks). Polars akan *fallback* diam-diam ke memory. Waspadai RAM spike.
- **Null Safety:** Kolom dalam Parquet yang masuk mungkin mengandung NULL. Gunakan `.fill_null(lit(0))` sebelum melakukan agregasi (seperti sum/mean) untuk menghindari kontaminasi hasil atau panic.
