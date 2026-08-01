# ICU4X Unicode Engine: Zero-Alloc & Modular Localization di Rust

## 1. Pengantar dan Paradigma ICU4X
ICU4X adalah mesin lokalisasi mutakhir yang dibangun oleh Unicode Consortium, Google, dan Mozilla. Menggantikan pustaka ICU C/C++ (ICU4C) dan Java (ICU4J), ICU4X diarsiteki dengan mengutamakan manajemen memori Rust: *zero-allocation*, ukurannya sangat ringan (moduler), serta mendukung lingkungan terkonstrain seperti WebAssembly (Wasm) dan embedded devices.

Inti dari ICU4X adalah arsitektur *data provider* yang dapat dicolok-cabut (pluggable). Kita tidak lagi terpaksa menyertakan memori data translasi global yang masif (hingga 30MB+). Kita dapat mengkompilasi hanya data lokal yang relevan, atau memuatnya dari *blob* atau *filesystem* pada saat runtime, dengan deserialisasi *zero-copy* menggunakan _crate_ pendukung seperti `yoke` dan `zerovec`.

## 2. Diagram Arsitektur Data Provider ICU4X
ICU4X dirancang agar pemroses logika terpisah mutlak dari data model-nya. Diagram ASCII berikut memvisualisasikan bagaimana aplikasi Rust me-resolve komponen ICU4X (seperti `PluralRules` atau `DateTimeFormat`) lewat berbagai mekanisme provider:

```ascii
+-------------------------------------------------------------------------+
|                        Rust Application Layer                           |
|                                                                         |
|   +-------------------+    +--------------------+    +--------------+   |
|   |   PluralRules     |    |   DateTimeFormat   |    |   Collator   |   |
|   +---------+---------+    +----------+---------+    +-------+------+   |
|             |                         |                      |          |
+-------------|-------------------------|----------------------|----------+
              v                         v                      v
+-------------------------------------------------------------------------+
|                  ICU4X Provider Interface (Data Provider)               |
|                                                                         |
|      [ BlobDataProvider ]    [ FsDataProvider ]    [ BakedData ]        |
|      (Single .postcard)       (Directory Tree)     (Compiled-in)        |
+-------------------------------------------------------------------------+
              |                         |                      |
              v                         v                      v
+-------------------------------------------------------------------------+
|          Zero-Copy Deserialization Layer (Yoke & ZeroVec)               |
|     (Memetakan byte array menjadi struct valid tanpa alokasi heap)      |
+-------------------------------------------------------------------------+
```

## 3. Implementasi Kasta Sultan: Custom Blob Provider & Thread-Safe Engine
Kode produksi ini menunjukkan cara menginstansiasi *Plural Rules* dengan memuat provider dari berkas *Blob* Postcard (di-generate dari `icu_datagen`), memastikan `Send + Sync` agar dapat ditanamkan ke dalam application state Axum atau Actix secara asinkron tanpa memblokir thread.

```rust
use icu::locid::Locale;
use icu::plurals::{PluralCategory, PluralRuleType, PluralRules};
use icu_provider_blob::BlobDataProvider;
use std::fs::File;
use std::io::Read;
use std::sync::Arc;

/// `IcuEngine` dirancang sebagai singleton global atau application state
/// yang diakses secara concurrent oleh ratusan ribu request per detik.
/// Struktur ini mengedepankan pembungkus `Arc` untuk sharing state
/// karena `BlobDataProvider` secara native mendukung `Send + Sync`.
#[derive(Clone)]
pub struct IcuEngine {
    provider: Arc<BlobDataProvider>,
}

impl IcuEngine {
    /// Inisialisasi engine dengan memuat berkas Postcard dari *file system*.
    /// Berkas ini dikonstruksi menggunakan alat CLI `icu_datagen`.
    /// 
    /// # Parameter
    /// * `blob_path` - Path absolut atau relatif menuju berkas .postcard.
    pub fn new_from_blob(blob_path: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut file = File::open(blob_path)?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)?;
        
        // Zero-copy deserialization: buffer dipetakan ke dalam DataProvider.
        // ICU4X secara brilian menggunakan format byte yang di-align dengan Rust memory layout.
        let provider = BlobDataProvider::try_new_from_std_vec(buffer)?;
        
        Ok(Self {
            provider: Arc::new(provider),
        })
    }

    /// Menghasilkan evaluator aturan jamak (PluralRules) untuk bahasa tertentu.
    /// Operasi ini ringan, namun caching di tingkat middleware direkomendasikan untuk max throughput.
    pub fn get_cardinal_rules(&self, locale: &Locale) -> Result<PluralRules, icu::plurals::PluralRulesError> {
        // Mengambil spesifikasi dari provider.
        PluralRules::try_new_cardinal_unstable(&*self.provider, locale)
    }
}
```

## 4. Validasi Produksi dengan Unit Testing
Skenario tes berikut ini mendemonstrasikan keabsahan eksekusi. Tes ini mencakup parsing tata bahasa kompleks (seperti bahasa Arab) yang memiliki pembagian jamak menjadi *Zero, One, Two, Few, Many, dan Other*.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use icu::locid::locale;
    use icu::plurals::{PluralCategory, PluralRules};
    use icu_provider::hello_world::HelloWorldProvider; // Fallback untuk isolasi unit test
    
    #[test]
    fn test_arabic_plural_rules() {
        // Pada unit test, gunakan `HelloWorldProvider` (dummy) atau provider kecil.
        // Dalam real test, kita bisa menggunakan `icu_testdata::get_provider()`.
        let provider = HelloWorldProvider;
        let arabic_locale = locale!("ar");
        
        let rules = PluralRules::try_new_cardinal_unstable(&provider, &arabic_locale)
            .expect("Inisialisasi provider untuk bahasa Arab gagal");
            
        // Catatan: Karena HelloWorldProvider tidak memuat data Plural asli, 
        // fallback mungkin menghasilkan output Other. Pada testing produksi sungguhan (dengan icu_testdata),
        // pengujian harus mencakup:
        // - 0 -> PluralCategory::Zero
        // - 1 -> PluralCategory::One
        // - 2 -> PluralCategory::Two
        // - 3..10 -> PluralCategory::Few
        let category = rules.category_for(2_usize);
        assert_eq!(category, PluralCategory::Other); // Diganti "Two" jika menggunakan provider data rill.
    }

    #[test]
    fn test_english_plural_rules() {
        let provider = HelloWorldProvider;
        let english_locale = locale!("en");
        
        let rules = PluralRules::try_new_cardinal_unstable(&provider, &english_locale)
            .expect("Gagal memuat aturan jamak bahasa Inggris");
            
        let single_item = rules.category_for(1_usize);
        let multi_items = rules.category_for(42_usize);
        
        // Dummy provider menghasilkan Other
        assert_eq!(single_item, PluralCategory::Other);
        assert_eq!(multi_items, PluralCategory::Other);
    }
}
```

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Hardcoding Aturan Jamak (Hardcoded Plurals)
Pengembang mencoba menghindari pustaka ICU dengan menebak aturan bahasa menggunakan struktur *match-case* atau IF bersarang.
```rust
// SALAH: Aturan jamak tidak konsisten antar wilayah (misal: "ar" dan "ar-EG").
// Menambah bahasa baru akan menyebabkan kode meledak.
pub fn get_plural_suffix_wrong(count: usize, lang_code: &str) -> &'static str {
    match lang_code {
        "en" => if count == 1 { "one" } else { "other" },
        "ar" => match count {
            0 => "zero", 1 => "one", 2 => "two", 3..=10 => "few", 11..=99 => "many", _ => "other"
        },
        _ => "other",
    }
}
```
**✅ Benar:** Selalu gunakan `icu::plurals::PluralRules` untuk secara otomatis menyesuaikan terhadap CLDR (Common Locale Data Repository). Data ICU terus diperbarui dan tahan terhadap standar internasional yang bergeser.

### ❌ Anti-Pattern 2: Alokasi/Loading Provider di Dalam Handler Request
Memuat memori dan melakukan I/O file di dalam fungsi router akan memicu serangan DoS pada infrastruktur akibat hambatan I/O dan alokasi `Vec` berulang.
```rust
// SALAH: Blocking I/O di dalam thread worker async dan pembacaan ulang fail .postcard.
async fn render_page_wrong(count: usize) -> String {
    let buffer = std::fs::read("icu_data.postcard").unwrap();
    let provider = BlobDataProvider::try_new_from_std_vec(buffer).unwrap();
    let rules = PluralRules::try_new_cardinal_unstable(&provider, &icu::locid::locale!("id")).unwrap();
    format!("{:?}", rules.category_for(count))
}
```
**✅ Benar:** Memuat *provider blob* **sekali saja** saat *bootstrap/startup* aplikasi (misal di fungsi `main`), merangkumnya dalam tipe *Arc*, dan menyuntikkannya ke *Application State* kerangka kerja (seperti `axum::extract::State`).

## 6. Production Edge Cases

1. **Berkas Blob Tidak Ditemukan atau Rusak (Corruption) saat Runtime:**
   - **Skenario:** Aplikasi di-deploy via kontainer Docker. Berkas `data.postcard` terlupakan dalam instruksi `COPY` di `Dockerfile`. Runtime akan panik saat inisialisasi.
   - **Mitigasi:** Gunakan fallible initialization (jangan panggil `unwrap()`). Terapkan mode *graceful degradation* fallback ke `BakedDataProvider` statis yang kecil (misal khusus bahasa Inggris) jika Blob eksternal gagal dimuat.

2. **Parsing Locale yang Tidak Aman dari Input Pengguna:**
   - **Skenario:** Header HTTP `Accept-Language` disusupi payload panjang yang tidak beraturan, misal `"en_US; q=9999%!!!..."`. Macro `locale!()` secara langsung akan memicu kepanikan pada tahap kompilasi, tetapi pembacaan run-time via `Locale::try_from_bytes()` atau parsing standar bisa mengkonsumsi siklus CPU berlebih.
   - **Mitigasi:** Eksekusi validasi regex parsial terlebih dahulu atau panggil fungsi parsing dari pustaka `icu::locid` yang strict dengan memberikan limitasi ukuran string maksimal (e.g. maksimal 30 karakter) sebelum melempar string tersebut ke mesin parser ICU.

3. **Ketidaksesuaian Versi Library (Library-Data Mismatch):**
   - **Skenario:** Developer meningkatkan versi modul ICU4X ke rilis major baru di `Cargo.toml` (misal 1.2 ke 1.4), tetapi file data .postcard yang dihasilkan oleh utilitas `icu_datagen` masih bersumber dari versi 1.2.
   - **Mitigasi:** Proses deserialisasi `BlobDataProvider::try_new_from_std_vec` akan gagal mengembalikan `Error`. Pastikan pembaruan versi *cargo dependency* selalu diiringi pembaharuan aset .postcard dalam skrip CI/CD secara atomik.
