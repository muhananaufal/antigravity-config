# Axum Locale Routing Middleware: Injeksi Bahasa Dinamis di Rust

## 1. Tantangan Lokalisasi di Lingkungan Microservices (Axum/Tonic)
Menyajikan teks lokalisasi di backend bukan sekadar mengubah dictionary/pustaka kata. Beban utamanya adalah mendeteksi secara akurat keinginan pengguna dari berbagai vektor (HTTP `Accept-Language`, preferensi tersimpan di payload *JWT claims*, atau *Path Prefix* seperti `/id/api/v1/`).
Mengotori parameter di *handler* API dengan mengekstrak bahasa secara manual bertentangan dengan kaidah DRY (*Don't Repeat Yourself*). Praktik "Sultan" menuntut pemisahan urusan ini ke dalam **Axum Middleware**. Middleware akan melakukan interogasi bahasa, lalu menyelinapkan objek `LanguageIdentifier` ke dalam ekstensi permintaan (Request Task-Local Extensions) agar *handler* tidak pusing.

## 2. Diagram Alur Resolusi Ekstraksi Locale di Axum
Diagram di bawah mendeskripsikan hierarki penemuan bahasa (fall-through extraction).

```ascii
+-------------------------------------------------------------------------+
|                        HTTP Request Masuk (Axum)                        |
+-------------------------------------------------------------------------+
                                   |
                                   v
+-------------------------------------------------------------------------+
|                  [ Locale Extractor Middleware ]                        |
|                                                                         |
|  1. Cek Parameter Path URL (mis. /id-ID/dashboard) --(Ada?)--> Resolusi |
|          | (Tidak ada)                                                  |
|          v                                                              |
|  2. Cek JWT Claims (Tabel Preferensi Akun)         --(Ada?)--> Resolusi |
|          | (Tidak ada)                                                  |
|          v                                                              |
|  3. Cek Header HTTP (Accept-Language: id;q=0.9)    --(Ada?)--> Resolusi |
|          | (Tidak ada)                                                  |
|          v                                                              |
|  4. Jatuh ke Konfigurasi Standar Sistem (Fallback) ---> Resolusi en-US  |
+-------------------------------------------------------------------------+
                                   |
                                   v
+-------------------------------------------------------------------------+
|           Injeksi Extension `req.extensions_mut().insert(lang)`         |
+-------------------------------------------------------------------------+
                                   |
                                   v
+-------------------------------------------------------------------------+
|         API Handler Akhir `async fn handler(Extension(lang))`           |
+-------------------------------------------------------------------------+
```

## 3. Implementasi Kasta Sultan: Custom Extractor di Axum
Contoh ini memformulasikan sebuah *FromRequestParts* (Extractor khusus Axum) yang memilah *Accept-Language* dari header secara otomatis atau menggunakan nilai bawaan (fallback). Pendekatan *Extractor* jauh lebih elegan dibandingkan menulis Middleware layer rendah jika kita hanya perlu menarik informasi tanpa memutasi *response headers*.

```rust
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::request::Parts,
    response::{IntoResponse, Response},
    http::StatusCode,
};
use unic_langid::LanguageIdentifier;
use std::str::FromStr;

/// Struktur yang merepresentasikan hasil ekstraksi locale dari request.
#[derive(Debug, Clone)]
pub struct UserLocale(pub LanguageIdentifier);

#[async_trait]
impl<S> FromRequestParts<S> for UserLocale
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Fallback locale default
        let default_lang = LanguageIdentifier::from_str("en-US").unwrap();

        // Mencari keberadaan header Accept-Language
        if let Some(accept_lang) = parts.headers.get("Accept-Language") {
            if let Ok(lang_str) = accept_lang.to_str() {
                // Parsing sederhana: ambil kandidat urutan pertama sebelum koma/titik-koma
                // Untuk produksi kelas atas, gunakan parser `accept-language` crate yang memahami bobot `q=`
                let raw_primary_lang = lang_str
                    .split(',')
                    .next()
                    .unwrap_or("")
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim();

                if let Ok(lang_id) = LanguageIdentifier::from_str(raw_primary_lang) {
                    return Ok(UserLocale(lang_id));
                }
            }
        }

        // Jika tidak ada header, berikan default. Kita asumsikan tidak pernah error (infallible).
        Ok(UserLocale(default_lang))
    }
}
```

### 3.1. Penggunaan di dalam Handler Endpoint
Dengan implementasi *Extractor*, handler kita tetap rapi (clean architecture) dan type-safe.

```rust
use axum::{routing::get, Router};

/// Handler yang secara otomatis meminta `UserLocale`. Ekstraktor Axum akan mengeksekusi
/// `from_request_parts` di belakang layar sebelum menembakkan fungsi ini.
async fn hello_world_handler(locale: UserLocale) -> String {
    // Pada titik ini, kita sudah mendapatkan bahasa pengguna dan dapat mengoperkannya
    // menuju mesin translasi Project Fluent / ICU4X.
    format!("Bahasa yang disepakati (negotiated) adalah: {}", locale.0)
}

pub fn app_router() -> Router {
    Router::new().route("/hello", get(hello_world_handler))
}
```

## 4. Unit & Integration Testing
Memverifikasi respons *extractor* terhadap berbagai skenario manipulasi header, guna menjamin ketepatan mekanisme penyaringan bahasa.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::get,
        Router,
    };
    use tower::ServiceExt;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn test_locale_extractor_with_header() {
        let app = app_router();

        // Skenario 1: Header HTTP valid (id-ID)
        let request = Request::builder()
            .uri("/hello")
            .header("Accept-Language", "id-ID,en-US;q=0.9,en;q=0.8")
            .body(Body::empty())
            .unwrap();

        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        
        assert_eq!(body_str, "Bahasa yang disepakati (negotiated) adalah: id-ID");
    }

    #[tokio::test]
    async fn test_locale_extractor_fallback() {
        let app = app_router();

        // Skenario 2: Tidak ada header dikirim. Harus jatuh ke fallback (en-US)
        let request = Request::builder()
            .uri("/hello")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        
        assert_eq!(body_str, "Bahasa yang disepakati (negotiated) adalah: en-US");
    }
}
```

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Parameter Polusi di Semua Handler
Mengekstrak bahasa melalui manipulasi header mentah di tubuh handler API.
```rust
// SALAH: Pengulangan logika boiler-plate menyebabkan utang teknis yang sangat mahal
// di puluhan rute aplikasi.
async fn render_dashboard_wrong(headers: HeaderMap) -> String {
    let mut lang = "en-US";
    if let Some(hl) = headers.get("Accept-Language") {
        lang = hl.to_str().unwrap_or("en-US");
    }
    format!("Dashboard in {}", lang)
}
```
**✅ Benar:** Pindahkan seluruh orkestrasi ke Axum Middleware (Request Extensions) atau ciptakan `FromRequestParts` *custom extractor* sehingga handler murni hanya bertindak sebagai pengkonsumsi data validasi akhir (`async fn handler(locale: UserLocale)`).

### ❌ Anti-Pattern 2: Panic akibat Parsing `Accept-Language` Gagal
Pengembang gegabah memaksa *unwrap* (panic) jika nilai header tidak bisa diparsing.
```rust
// SALAH: Vulnerable terhadap serangan DDoS dengan header Accept-Language korup/buatan.
let locale = parts.headers.get("Accept-Language").unwrap().to_str().unwrap();
let lang_id: LanguageIdentifier = locale.parse().unwrap(); // PANIC DI SINI
```
**✅ Benar:** *Fail-gracefully*. Jika regex atau fungsi parse rusak, tolak kegagalan dan turun ke opsi bahasa default. Jangan biarkan *bad input* menghancurkan process container `tokio`.

## 6. Production Edge Cases

1. **Prioritas Resolusi Berdasarkan Faktor Kognitif (JWT vs Header):**
   - **Skenario:** Pengguna dari Jepang (Browser Header `ja-JP`) *login* di komputer kafe Spanyol, namun profil akunnya disetel menggunakan bahasa Inggris `en-US` di *Database* miliknya.
   - **Mitigasi:** Aturan baku (Golden Rule): *Explicit User Settings > JWT Claims > URL Prefix > HTTP Request Headers*. Middleware pertama-tama harus mencari klaim `lang` dari token Bearer. Hanya bila token itu absens (Guest Mode), pemeriksaan bergeser pada parameter header browser.
2. **Accept-Language Header yang Terdistorsi Secara Sintaks:**
   - **Skenario:** Web crawler usang atau alat penetrasi mengirimkan parameter berformat malformasi: `Accept-Language: *`. 
   - **Mitigasi:** `LanguageIdentifier::from_str("*")` akan menghasilkan parse error. Middleware wajib mentolerir segala jenis kegagalan parse dengan tidak memberikan error API (seperti 400 Bad Request), melainkan beralih hening *(silent fallback)* ke `en-US`.
3. **Pembatasan Support Bahasa (Supported Locales Limitation):**
   - **Skenario:** Header meminta bahasa Swahili (`sw-KE`), namun sistem kita hanya memiliki data terjemahan untuk ID, EN, dan JA. Jika memaksakan rendering `sw-KE`, aplikasi ICU4X bisa mencetak string kosong.
   - **Mitigasi:** Sediakan konstan `Vec<LanguageIdentifier>` berisi daftar bahasa yang didukung penuh *(allowlist)*. Jika hasil resolusi locale pengguna tidak ada pada vektor tersebut, segera fallback ke `en-US` atau periksa probabilitas serumpun (`id-MY` dipadankan menjadi `id-ID`).
