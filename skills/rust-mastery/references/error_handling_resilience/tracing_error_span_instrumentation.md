# Instrumentasi Span & Tracing Error

## 1. Konsep Utama & Kapan Digunakan
Di lingkungan asynchronous terdistribusi, memecahkan (debug) error sangat sulit jika Anda hanya mengandalkan `println!` atau logging standar. Konteks "permintaan mana yang menyebabkan error ini?" seringkali hilang karena eksekusi task berpindah antar OS thread.

Keluarga ekosistem `tracing` (termasuk `tracing-error`) menyelesaikan ini lewat *Span*. Span adalah blok eksekusi yang memiliki awal dan akhir, serta membawa state kontekstual. Saat error terjadi di kedalaman hirarki call-stack, error tersebut dapat merekam *SpanTrace* (bukan sekadar stacktrace), yang memberi tahu Anda secara eksak variabel context apa saja (seperti `user_id` atau `request_id`) yang sedang aktif.

## 2. Arsitektur / Flow

```ascii
[ Span: "HTTP Request", request_id = 123 ] 
      |
      v
   [ Span: "Process Payment", user_id = 890 ] 
         |
         v
      [ Error Terjadi: "Balance Insufficient" ]
      (SpanTrace menangkap req_id 123 dan user_id 890 secara otomatis)
```

## 3. Kode Rust Production-Ready

```rust
use tracing::{error, info, instrument, Span};
use tracing_error::{SpanTrace, TracedError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PaymentError {
    #[error("Database timeout")]
    Timeout,
    #[error("Insufficient balance")]
    InsufficientFunds,
}

// 1. Menggunakan TracedError untuk menempelkan SpanTrace ke Error Enum kita
pub type TracedPaymentError = TracedError<PaymentError>;

// 2. Makro #[instrument] otomatis membuat Span saat fungsi dipanggil.
// Parameter `user_id` dan `amount` akan terekam ke dalam Span.
// `err` attribute akan otomatis me-log jika fungsi ini me-return Err.
#[instrument(skip(db_pool), fields(db_status = "connected"), err)]
pub async fn process_payment(
    db_pool: &str, // disimulasikan
    user_id: u32,
    amount: u64,
) -> Result<(), TracedPaymentError> {
    info!("Starting payment processing");

    // Simulasi kegagalan dalam inner logic
    let res = execute_db_transaction(amount).await;

    // Membungkus (wrap) error domain dengan TracedError yang meng-capture SpanTrace
    res.map_err(|e| TracedError::from(e))?;

    info!("Payment successful");
    Ok(())
}

async fn execute_db_transaction(amount: u64) -> Result<(), PaymentError> {
    // Kita bisa menambah data ke current span di tengah-tengah fungsi
    Span::current().record("transaction_amount", &amount);
    
    // Simulate error
    Err(PaymentError::Timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_tracing_capture() {
        // Setup tracing subscriber untuk test... (opsional)
        let res = process_payment("pool", 890, 5000).await;
        assert!(res.is_err());
        
        let err = res.unwrap_err();
        // Anda sekarang memiliki err.span_trace() yang mengandungi jejak lengkap
        println!("Error with span trace: {:?}", err);
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Menggunakan `skip` pada `#[instrument]` untuk parameter yang esensial untuk di-debug.**
   - *Bahaya*: Jika Anda me-skip `request_id` karena "terlalu panjang", Anda kehilangan kunci utama untuk menyatukan log aplikasi di Datadog/Kibana.
   - *Solusi*: Hanya gunakan `skip` untuk tipe data yang tidak implement `Debug` (misal Connection Pool, Mutex Guards), parameter identitas harus selalu di-record.
2. **Membuat Span manual tanpa membuangnya (dropping) secara benar di async Rust.**
   - *Bahaya*: Jika membuat `let _enter = span.enter()` dalam fungsi `async`, `_enter` guard akan memblokir (held) melintasi batas `.await`. Ini adalah *Undefined Behavior* di `tracing` karena scheduler akan memindahkan eksekusi thread.
   - *Solusi*: Gunakan `span.in_scope(|| ...)` atau makro `#[instrument]` yang sudah *async-aware*.

## 5. Edge Cases & Defensive Programming
- **Over-instrumentation**: Menaruh `#[instrument]` pada *setiap* fungsi kecil (misal utilitas parsing angka) akan mencekik CPU karena alokasi dan overhead subscriber tracing. Batasi Span level fungsi hanya pada batas layer atau operasi I/O yang berat.
- **Data Sensitif (PII)**: Jangan menaruh password, credit card, atau access token sebagai parameter fungsi yang dikenakan `#[instrument]`, karena akan otomatis di-log dalam clear-text ke stdout/file. Gunakan modifier rahasia jika menggunakan logging framework yang men-supportnya, atau `skip(password)`.
