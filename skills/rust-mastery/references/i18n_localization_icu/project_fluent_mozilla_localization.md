# Project Fluent: Mozilla Localization Architecture di Rust

## 1. Konsep Project Fluent & Kemandirian Terjemahan
Project Fluent adalah paradigma pelokalan asimetris hasil karya Mozilla. Tidak seperti kerangka lawas (contoh: gettext), di mana bahasa perantara dipaksa mereplika struktur grammar bahasa sumber (bahasa Inggris), Fluent membebaskan penerjemah untuk menggunakan kondisi majemuk (Selectors), atribut gender, interpolasi dinamis, serta kalkulasi jamak di *luar* jangkauan *backend engineer*.
Dalam arsitektur Rust yang skalabel, kita mengandalkan _crate_ `fluent` dan `fluent-bundle`. Modul ini mengonstruksi serangkaian pesan yang dikompilasi secara *runtime* dari berkas berformat `.ftl` (Fluent Translation List) sekaligus memecahkan polemik kejatuhan *(fallback language chains)* tanpa interupsi kegagalan berantai *(graceful error resilience)*.

## 2. Diagram Fallback Language Chains
Sistem akan meluncur menuruni rantai hierarki bahasa secara bertahap jika menemukan pesan yang rumpang atau terjadi kegagalan _syntax_ pada suatu pesan di bahasa prioritas utama.

```ascii
+-----------------------------------------------------------------+
|                         User Request                            |
|                 Accept-Language: id-ID, en-US;q=0.8             |
+-----------------------------------------------------------------+
                                |
                                v
+-----------------------------------------------------------------+
|             Language Negotiator & Fallback Chain                |
|                                                                 |
|  [ Level 1: id-ID ] ---> Jika pesan "welcome_msg" absen?        |
|          |                                                      |
|          v (Fallback)                                           |
|  [ Level 2: id ]    ---> Jika "welcome_msg" juga absen?         |
|          |                                                      |
|          v (Fallback)                                           |
|  [ Level 3: en-US ] ---> (Master Language) Terjemahan pasti ada |
+-----------------------------------------------------------------+
                                |
                                v
+-----------------------------------------------------------------+
|    Fluent Bundle Resolver (Variabel, Gender, Plural Selector)   |
|   Mengekstrak pesan dan menyuntikkan argumen `{"name": "Budi"}` |
+-----------------------------------------------------------------+
```

## 3. Implementasi Kasta Sultan: Bundle Resolver & Selector Dinamis
Kode di bawah menginisialisasi bundle statis (via simulasi sumber string FTL) untuk mendemonstrasikan penyisipan argumen interpolasi dan resolusi ke dalam string target dengan validasi type-safe.

```rust
use fluent_bundle::{FluentArgs, FluentBundle, FluentResource};
use intl_memoizer::concurrent::IntlLangMemoizer;
use unic_langid::LanguageIdentifier;
use std::borrow::Cow;

/// Tipe Bundle yang aman dibagikan ke antar thread
pub type ThreadSafeBundle = FluentBundle<FluentResource, IntlLangMemoizer>;

/// Menginisialisasi satu FluentBundle untuk locale spesifik dari string mentah FTL.
/// Di skenario produksi (production), string ini dibaca dari I/O disk file `.ftl`.
pub fn create_bundle(locale_str: &str, ftl_content: &str) -> Result<ThreadSafeBundle, String> {
    let lang_id: LanguageIdentifier = locale_str
        .parse()
        .map_err(|e| format!("Gagal mem-parsing locale id: {}", e))?;
        
    let resource = FluentResource::try_new(ftl_content.to_string())
        .map_err(|(_, errors)| format!("Gagal mem-parsing FTL: {:?}", errors))?;
        
    let mut bundle = FluentBundle::new_concurrent(vec![lang_id]);
    bundle.add_resource(resource)
        .map_err(|e| format!("Gagal menambahkan resource: {:?}", e))?;
        
    Ok(bundle)
}

/// Menarik pesan dan menyuntikkan data argumen untuk memicu kalkulasi varian kalimat.
pub fn format_message<'a>(
    bundle: &'a ThreadSafeBundle,
    message_id: &str,
    args: Option<&'a FluentArgs>,
) -> Result<Cow<'a, str>, String> {
    let msg = bundle.get_message(message_id)
        .ok_or_else(|| format!("Pesan '{}' tidak ditemukan di dalam bundle.", message_id))?;
        
    let pattern = msg.value()
        .ok_or_else(|| format!("Pesan '{}' tidak memiliki nilai (value) utama.", message_id))?;
        
    let mut errors = vec![];
    let formatted = bundle.format_pattern(pattern, args, &mut errors);
    
    // Fluent didesain untuk tangguh (resilient). 
    // Kegagalan pada argumen tertentu tetap menghasilkan string fallback (misal: "Halo {$name}").
    if !errors.is_empty() {
        // Log error secara non-blocking di environment nyata
        eprintln!("Peringatan saat format ({}): {:?}", message_id, errors);
    }
    
    Ok(formatted)
}
```

## 4. Unit & Integration Testing
Pengujian terhadap skenario pemilihan (Selector) berdasarkan tipe *plural* (jamak). Variabel disuntikkan dan string hasil harus merepresentasikan tata bahasa yang valid sesuai angka.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use fluent_bundle::FluentArgs;

    const FTL_INPUT: &str = r#"
# Kalimat ucapan dengan selector jumlah (plural)
unread-emails =
    { $emailsCount ->
        [0] Anda tidak memiliki email baru.
        [1] Anda memiliki satu email baru yang menumpuk.
       *[other] Anda memiliki { $emailsCount } email baru yang harus dibaca.
    }
"#;

    #[test]
    fn test_fluent_plural_selectors() {
        let bundle = create_bundle("id-ID", FTL_INPUT).unwrap();
        
        // Skenario 1: Nol Email
        let mut args_zero = FluentArgs::new();
        args_zero.set("emailsCount", 0);
        let res_zero = format_message(&bundle, "unread-emails", Some(&args_zero)).unwrap();
        assert_eq!(res_zero, "Anda tidak memiliki email baru.");
        
        // Skenario 2: Satu Email
        let mut args_one = FluentArgs::new();
        args_one.set("emailsCount", 1);
        let res_one = format_message(&bundle, "unread-emails", Some(&args_one)).unwrap();
        assert_eq!(res_one, "Anda memiliki satu email baru yang menumpuk.");

        // Skenario 3: Banyak Email (Other)
        let mut args_other = FluentArgs::new();
        args_other.set("emailsCount", 42);
        let res_other = format_message(&bundle, "unread-emails", Some(&args_other)).unwrap();
        
        // Fluent men-format angkanya menggunakan isolasi Unicode (U+2068) sebagai pengaman BIDI
        // Kita menggunakan `contains` agar tidak bermasalah dengan zero-width character
        assert!(res_other.contains("Anda memiliki \u{2068}42\u{2069} email baru yang harus dibaca."));
    }
}
```

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menyebarkan Logika Translasi di Kode Program
Pengembang menyisipkan manipulasi string atau IF logic untuk urusan jamak secara hardcoded di dalam API respon.
```rust
// SALAH: Back-end engineer dipaksa menebak susunan bahasa.
fn render_inbox_wrong(count: usize) -> String {
    if count == 0 {
        "No messages".to_string()
    } else if count == 1 {
        "1 message".to_string()
    } else {
        format!("{} messages", count)
    }
}
```
**✅ Benar:** Back-end engineer hanya menyerahkan `count` (sebagai argumen) menuju bundle `.ftl`. Seluruh logika dan spesialisasi gender/jumlah (seperti `zero`, `one`, `few`) ditangani mutlak di berkas `.ftl`.

### ❌ Anti-Pattern 2: Berhenti / Panic akibat Sintaks FTL yang Cacat
Menggagalkan boot/startup sistem (menggunakan `.unwrap()`) hanya karena ada kesalahan ketik kecil di satu kalimat FTL.
```rust
// SALAH: Satu kesalahan koma di FTL bahasa Spanyol mematikan keseluruhan node server.
let resource = FluentResource::try_new(corrupt_ftl_string).unwrap();
```
**✅ Benar:** Bundle dan Resource dari Fluent mampu mengisolasi error pada pesan tunggal *(Syntax Error Resilience)*. Rekam log error dan gunakan struktur fallback (menggunakan Master English file) sebagai cadangan sehingga pengguna tidak mendapat layar mati (500 Internal Server Error).

## 6. Production Edge Cases

1. **Atribut dan Pesan yang Hilang di Disk saat Runtime:**
   - **Skenario:** File `id.ftl` belum diterjemahkan sepenuhnya, menyebabkan pesan khusus (contoh: `checkout-button`) hilang saat resolusi. 
   - **Mitigasi:** Bangun hierarki bundle bertingkat (`Vec<FluentBundle>`). Jika lookup pesan gagal pada bundle bahasa Indonesia, injeksikan *iterator chain* untuk mencari fallback di bundle bahasa Inggris tanpa campur tangan tambahan.
2. **Kejahatan Input (Format String Attack/XSS melalui Interpolasi):**
   - **Skenario:** Variabel masuk ke dalam pesan (misal `{$username}`) memuat string bahaya `<script>alert(1)</script>`.
   - **Mitigasi:** Ekstensi `.ftl` secara native meloloskan string ini murni sebagai string mentah. Hindari menggunakan fungsi semacam `dangerouslySetInnerHTML` di tingkat klien Web/React. Pastikan rendering mengonsumsi data *Fluent* lewat manipulasi DOM yang tersanitasi, bukan *raw HTML concat*.
3. **Karakter Bidi (Bidirectional Text) yang Terisolasi (FSI/PDI):**
   - **Skenario:** Format numerik dan variabel pada Fluent menggunakan *First Strong Isolate (U+2068)* secara otomatis untuk menghindari hancurnya teks jika tata letak RTL (Right-to-Left) seperti Arab disatukan dengan bahasa Inggris.
   - **Mitigasi:** Jangan sekali-kali menjalankan perbandingan *string exact equal* (seperti `==` atau asersi panjang karakter yang telanjang) terhadap output Fluent untuk evaluasi bisnis karena kehadiran `\u{2068}` dan `\u{2069}` tidak kasat mata tetapi memperlebar jumlah memori *bytes* pada representasi string. Gunakan strip-bidi markers khusus saat pengujian atau biarkan peramban merendernya dengan damai.
