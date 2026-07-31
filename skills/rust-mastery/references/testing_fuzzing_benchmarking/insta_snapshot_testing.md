# Snapshot Testing dengan `insta`

## 1. Konsep Utama & Kapan Digunakan
Dalam TDD tradisional, developer menulis manual nilai ekpektasi (expected value). Untuk string/JSON yang kompleks, ini membosankan dan sangat rapuh. 
*Snapshot Testing* (via library `insta`) menangkap output aktual dari tes, menyimpannya dalam file khusus (snapshot), dan di eksekusi berikutnya akan membandingkannya (diff) secara otomatis. Jika output berubah, test gagal (atau Anda bisa meninjau untuk mem-veto perubahannya jika itu sengaja dirubah).

Gunakan `insta` ketika:
- Memvalidasi render output CLI (pesan error panjang, UI tabel console).
- Validasi generasi file statis, Markdown generator, serializer JSON/YAML format besar.
- API Endpoints yang memuntahkan respons JSON bersarang rumit.

## 2. Arsitektur / Flow

```ascii
[ Rust Test ] -> (Generates JSON Output) -> insta::assert_json_snapshot!()
                                                  |
           (File exists?)                         v
             +------- YES ----------------> [ Compare with snapshot.snap ] -> DIFF!
             |
             +------- NO -----------------> [ Save to `snapshots/` folder ] -> SUCCESS
                                                  |
                               (Developer review via `cargo insta review`)
```

## 3. Kode Rust Production-Ready

```rust
use serde::Serialize;
// asumsikan import serde dll.

#[derive(Serialize)]
pub struct UserProfile {
    pub id: uuid::Uuid,
    pub name: String,
    pub email: String,
    pub created_at: String, // String timestamp ISO
}

pub fn generate_user_report(user: &UserProfile) -> String {
    format!("REPORT\n==========\nName: {}\nContact: {}", user.name, user.email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use insta::{assert_snapshot, assert_json_snapshot};

    #[test]
    fn test_user_report_output() {
        let user = UserProfile {
            id: uuid::Uuid::nil(),
            name: "John Doe".to_string(),
            email: "john@example.com".to_string(),
            created_at: "2023-10-01T12:00:00Z".to_string(),
        };

        // 1. Text snapshot
        let report = generate_user_report(&user);
        assert_snapshot!(report); 
        // Snapshot file otomatis terbuat di folder `snapshots/tests__test_user_report_output.snap`
    }

    #[test]
    fn test_json_api_response() {
        let user = UserProfile {
            id: uuid::Uuid::new_v4(), // DINAMIS! Berubah tiap iterasi
            name: "Jane".to_string(),
            email: "jane@example.com".to_string(),
            created_at: "2023-10-01T12:00:00Z".to_string(),
        };

        // 2. JSON snapshot DENGAN Redactions/Filters!
        // Karena ID adalah random UUID, tes akan gagal tiap di run karena snapshot tidak cocok.
        // Kita gunakan filter dinamis: ganti field `.id` dengan string statis "[uuid]" saat disimpan.
        assert_json_snapshot!(user, {
            ".id" => "[uuid]"
        });
    }
}
```

## 4. Anti-Pattern Spesifik
1. **Lupa memfilter (Redact) nilai non-deterministik pada output (Dates, UUID, Random IDs).**
   - *Bahaya*: Snapshot test Anda (Flaky Test) akan gagal secara acak (flaky) di CI/CD karena timestamp selalu maju ke depan.
   - *Solusi*: Selalu konfigurasikan macro `assert_json_snapshot` dengan selector filter.
2. **Menerima (Accepting) perubahan snapshot secara buta tanpa me-review.**
   - *Bahaya*: Saat Anda menggunakan `cargo insta accept` untuk mengubah massal ratusan fail snapshot test pasca-refactor besar, Anda mungkin menyetujui bug struktural.
   - *Solusi*: Selalu tinjau diff `cargo insta review`, karena diff tool insta sangat rapi (mirip git diff).

## 5. Edge Cases & Defensive Programming
- **Inline Snapshots**: Jika snapshotnya kecil (kurang dari 5 baris text), lebih baik gunakan `insta::assert_snapshot!(result, @"");`. Saat test dijalankan, `cargo insta review` akan **mengubah (edit)** source code file Rust Anda untuk mengisi/mengganti block `@""` dengan teks jawaban sebenarnya secara in-place. Sangat ergonomis dan tidak membuang file di directory.
- **Batas Panjang (Size Limit)**: Jangan gunakan snapshot pada dump DB atau file megabytes. Ini akan membebani repository Git. Snapshot dirancang untuk data representatif yang bisa dibaca/divalidasi mata manusia (Human Readable).
