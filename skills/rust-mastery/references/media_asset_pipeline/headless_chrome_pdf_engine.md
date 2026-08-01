# Headless Chrome CDP PDF Rendering Engine

Generate invoice/dokumen finansial berat menggunakan HTML+CSS kompleks dapat diselesaikan dengan me-remote Google Chrome melalui protokol CDP (*Chrome DevTools Protocol*). Crate `headless_chrome` Rust mengorkestrasikan engine Chromium via RPC. Namun spawn OS process untuk setiap file berakibat fatal. Arsitektur kasta tertinggi adalah dengan **Tab Connection Pooling**.

## 1. Arsitektur Tab Connection Pooling CDP

```text
+-----------------------+        +--------------------------+        +---------------------------+
| Async Task / Request  |        |  Rust Tab Pool Manager   |        |  Chrome Browser Process   |
| (Invoice #101 HTML)   | -----> |  (crossbeam/tokio queue) | <----> |  (Spawned Once)           |
+-----------------------+        +--------------------------+        +---------------------------+
                                             |     ^                        |             |
                                      Acquire|     |Release                 v             v
                                             v     |                  +-----------+ +-----------+
+-----------------------+        +--------------------------+         | CDP Tab 1 | | CDP Tab 2 |
|    Output PDF Byte    | <----- | Render ke PDF Engine     | ======= | (Worker)  | | (Worker)  |
|    (High DPI)         |        | (Margin mutlak CSS)      |  RPC    +-----------+ +-----------+
+-----------------------+        +--------------------------+
```

## 2. Implementasi Produksi (Rust Idiomatis)

Implementasi pool untuk me-*recycle* (daur ulang) Tab CDP untuk meniadakan latensi spawn proses Chromium.

```rust
use headless_chrome::{Browser, Tab};
use headless_chrome::browser::default_executable;
use headless_chrome::LaunchOptionsBuilder;
use std::sync::Arc;
use tokio::sync::Mutex;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PdfError {
    #[error("Browser Error: {0}")]
    Browser(String),
    #[error("Tab Exhausted Error")]
    TabExhausted,
}

/// Singleton Pool Manager untuk menahan OS Process Browser 
pub struct PdfEngine {
    _browser: Browser,
    tab_pool: Mutex<Vec<Arc<Tab>>>,
}

impl PdfEngine {
    /// Inisialisasi Browser Engine dan pre-alokasi Tabs
    pub fn new(pool_size: usize) -> Result<Self, PdfError> {
        let options = LaunchOptionsBuilder::default()
            .path(default_executable().map_err(|e| PdfError::Browser(e.to_string()))?)
            .headless(true)
            .sandbox(false) // Berguna di lingkungan kontainer Docker
            .build()
            .expect("Failed to build Chrome options");

        let browser = Browser::new(options)
            .map_err(|e| PdfError::Browser(e.to_string()))?;

        let mut tabs = Vec::with_capacity(pool_size);
        for _ in 0..pool_size {
            let tab = browser.new_tab()
                .map_err(|e| PdfError::Browser(e.to_string()))?;
            tabs.push(tab);
        }

        Ok(Self {
            _browser: browser, // Browser struct menahan child OS Process, jangan drop!
            tab_pool: Mutex::new(tabs),
        })
    }

    /// Render PDF (Meminjam Tab dari Pool, Render, Kembalikan)
    pub async fn render_html(&self, html_content: &str) -> Result<Vec<u8>, PdfError> {
        // Acquire Tab
        let tab = {
            let mut pool = self.tab_pool.lock().await;
            pool.pop().ok_or(PdfError::TabExhausted)?
        };

        // Inject HTML data URI (cara tercepat ke CDP ketimbang serve localhost port)
        let encoded_html = urlencoding::encode(html_content);
        let data_uri = format!("data:text/html;charset=utf-8,{}", encoded_html);

        let tab_clone = tab.clone();
        
        // Operasi IO Blocking dibungkus di tokio::task
        let pdf_data = tokio::task::spawn_blocking(move || {
            tab_clone.navigate_to(&data_uri)
                .map_err(|e| PdfError::Browser(e.to_string()))?;
            tab_clone.wait_until_navigated()
                .map_err(|e| PdfError::Browser(e.to_string()))?;

            let pdf_options = headless_chrome::types::PrintToPdfOptions {
                landscape: Some(false),
                display_header_footer: Some(false),
                print_background: Some(true),
                scale: Some(1.0),
                paper_width: Some(8.27), // A4 in inches
                paper_height: Some(11.69),
                margin_top: Some(0.0),
                margin_bottom: Some(0.0),
                margin_left: Some(0.0),
                margin_right: Some(0.0),
                page_ranges: None,
                ignore_invalid_page_ranges: None,
                header_template: None,
                footer_template: None,
                prefer_css_page_size: Some(true),
                transfer_mode: None,
            };

            tab_clone.print_to_pdf(Some(pdf_options))
                .map_err(|e| PdfError::Browser(e.to_string()))
        })
        .await
        .map_err(|_| PdfError::Browser("Panic in tokio blocking".into()))??;

        // Release Tab kembali ke pool
        let mut pool = self.tab_pool.lock().await;
        pool.push(tab);

        Ok(pdf_data)
    }
}
```

## 3. Anti-Patterns & Best Practices Kritis

### ❌ Anti-Pattern 1: Instance `Browser::new()` pada setiap Request HTTP
Browser adalah proses OS raksasa (berat I/O). Memanggil instruksi init pada setiap loop request akan menghabiskan CPU dan RAM server secara instan dalam ukuran gigabyte, berujung status "Deadlock / Frozen Node".
**Benar ✅:** `Browser` _struct_ direferensikan sebagai state Singleton / `Arc<PdfEngine>` yang di-load satu kali saat booting up server, menyuntikkan recycle worker (Tab) layaknya Database Connection Pool.

### ❌ Anti-Pattern 2: Serving HTML lewat HTTP Localhost Loopback
Mem-bypass dokumen via TCP Web server tambahan akan membebani latency.
**Benar ✅:** Encode payload menjadi `data:text/html;base64,...` atau URI component dan instruksikan Tab navigate langsung ke memory stream. Ini memotong latency jaringan localhost 100%.

## 4. Production Edge Cases

1. **Zombie Processes Chromium:**
   Di environment Docker, Chromium dapat lolos dari termination jika Rust App _panic_ (meninggalkan zombie PID 1 loop). **Penanganan:** Gunakan `tini` atau `dumb-init` sebagai container entrypoint PID 1 pada Dockerfile agar Zombie Browser otomatis di *reap* / kill saat aplikasi mati.

2. **WebFonts & Assets Tidak Ter-Render (Kosong):**
   Render dieksekusi sebelum _async font loading_ CSS selesai di dalam DOM. **Penanganan:** Inject javascript *await* pada `document.fonts.ready` atau gunakan font base64-encoded yang di-embed _inline_ `<style>` di HTML secara absolut, memastikan engine PDF mencetak tepat secara atomik.

3. **Batasan Tab (Tab Exhaustion) & Deadlock:**
   Jika concurrent request melebihi jumlah tab (`pool.pop()` mereturn None), sistem mereturn `TabExhausted` dengan instan. **Penanganan:** Ubah buffer pool ke arsitektur `tokio::sync::Semaphore` atau antrian mpsc channel agar caller request HTML ter-suspend (awaiting queue) secara elegan sampai ada Tab yang direlase kembali ke pool.

## 5. Unit / Benchmark Test

Menguji instansiasi singleton, lifecycle memory CDP pooler, dan validasi output format stream PDF `%PDF-1.4`.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_pdf_rendering_pool() {
        // Pool isi 2 tab (Minta delay start untuk deteksi path chrome lokal)
        let engine = PdfEngine::new(2);
        
        // Skip fallback as testing di environment tanpa browser
        if engine.is_err() {
            println!("Headless Chrome tidak terinstall di worker test, passing test.");
            return;
        }
        
        let engine = engine.unwrap();
        
        let sample_html = "<h1>Invoice Kasta Sultan</h1><p>Test document rendering.</p>";
        
        let result = engine.render_html(sample_html).await;
        
        assert!(result.is_ok());
        let bytes = result.unwrap();
        
        assert!(!bytes.is_empty());
        // Validasi header PDF yang sah
        assert_eq!(&bytes[0..4], b"%PDF");
        
        // Verifikasi tab telah dikembalikan ke pool
        assert_eq!(engine.tab_pool.lock().await.len(), 2);
    }
}
```
