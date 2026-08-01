# Insta: Snapshot Testing untuk Struktur Kompleks

## Deskripsi dan Konsep Utama
Snapshot testing (via crate `insta`) sangat esensial ketika fungsi menghasilkan output yang kompleks dan lebar, seperti JSON, YAML, atau Abstract Syntax Trees (AST). Daripada menulis ribuan baris `assert_eq!` secara manual, `insta` menangkap ("snapshots") output tersebut pada *run* pertama, menyimpannya ke disk (atau inline), dan pada *run* berikutnya memastikan output tidak berubah. Jika output *seharusnya* berubah (akibat fitur baru), developer dapat me-review perbedaannya (diff) dan menerima snapshot baru dengan `cargo insta review`. Redaction (pemfilteran/masking dinamis) memungkinkan filter timestamp, UUID, dan hash agar tidak merusak tes setiap kali dijalankan.

## Arsitektur & Flow (ASCII Diagram)
```text
  [Test Execution: insta::assert_yaml_snapshot!]
                  |
        (Does snapshot file exist?)
          /                  \
       [NO]                 [YES]
        |                     |
 [Create New Snapshot]   [Serialize Target]
 [Fail test initially]        |
        |                [Compare with Existing]
 [cargo insta review]         |
        |             (Matches?) -> [YES: Pass]
 [Approve -> Save]            |
                           [NO: Fail, Show Diff]
```

## Implementasi Produksi (Rust)
```rust
use serde::Serialize;
use insta::assert_yaml_snapshot;
use std::time::{SystemTime, UNIX_EPOCH};

// Target struktur kompleks
#[derive(Serialize)]
pub struct UserProfile {
    pub id: String,
    pub username: String,
    pub permissions: Vec<String>,
    pub created_at: u64, // Waktu dinamis (berubah tiap eksekusi)
}

pub fn generate_default_profile(username: &str) -> UserProfile {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    UserProfile {
        id: format!("usr_{}", uuid::Uuid::new_v4().to_string()),
        username: username.to_string(),
        permissions: vec!["READ".to_string(), "WRITE".to_string()],
        created_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use insta::{assert_yaml_snapshot, dynamic_redaction};

    #[test]
    fn test_generate_default_profile_snapshot() {
        let profile = generate_default_profile("johndoe");

        // Menggunakan redaction untuk ID acak dan Timestamp dinamis
        // Sehingga snapshot tetap stabil / deterministik
        assert_yaml_snapshot!(profile, {
            ".id" => "[uuid]",
            ".created_at" => dynamic_redaction(|value, _path| {
                // Pastikan nilai waktu adalah u64, lalu samarkan
                assert!(value.as_u64().is_some());
                "[timestamp]"
            })
        });
    }

    #[test]
    fn test_inline_snapshot() {
        let simple_data = vec!["apple", "banana", "cherry"];
        
        // Inline snapshot: Insta akan langsung mengubah kode sumber ini (menulis ulang test) 
        // saat kita melakukan `cargo insta review`
        insta::assert_yaml_snapshot!(simple_data, @r###"
        ---
        - apple
        - banana
        - cherry
        "###);
    }
}
```

## Anti-Patterns

1. **Mengabaikan `cargo insta review`**: Developer sering kali melihat error pada CI akibat *snapshot mismatch*, dan mem-bypass dengan menghapus file `.snap` lama lalu men-generate ulang tanpa me-review diff.
   *Mengapa berbahaya*: Snapshot yang rusak atau data busuk (misal: payload typo) akan terlegitimasi dan lolos ke produksi karena dianggap sebagai "kebenaran baru". Review *snapshot diff* sama krusialnya dengan Code Review!
2. **Snapshot Flakiness tanpa Redaction**: Membiarkan parameter yang random (Date, Thread ID, Hash Set iteration order yang tidak berurutan) terekam di dalam snapshot.
   *Mengapa berbahaya*: Test akan menjadi *flaky*, gagal 50% dari total *runs* karena pergeseran waktu atau memori. Iterasi struktur seperti `HashMap` atau `HashSet` dalam Rust memiliki urutan *pseudo-random*. Wajib di-*sort* dulu (misal jadi `BTreeMap`) sebelum di-snapshot.

## Edge Cases & Defensive Programming

1. **BTreeMap vs HashMap**: Seperti disebut sebelumnya, Rust `HashMap` tidak menjaga urutan karena *SipHash* anti-DoS *seed*. Saat di-serialize ke YAML/JSON, *key order* akan acak. Di lingkungan testing atau di serializer target, ubah ke `BTreeMap` atau aktifkan `#[serde(serialize_with = "...")]` untuk mem-filter dan *sort* *keys*, sehingga string snapshot tidak rewel (*flaky*).
2. **Large Snapshot File (Git Bloat)**: Snapshot yang berisi gigabytes output JSON akan disimpan sebagai teks mentah di `.snap`. Ini akan membuat repository Git membengkak luar biasa (Git tidak handal untuk ratusan megabyte text *diff*). Filter data dengan mengekstraksi parameter kunci (proyeksi), atau abaikan array besar (*truncate*) dalam trait `Serialize` *wrapper* khusus testing.
3. **CI Environment `INSTA_UPDATE`**: Seringkali CI bingung dan gagal memberikan instruksi yang jelas saat test gagal. Gunakan environment variable `INSTA_UPDATE=always` jika memang itu fase di *script update automation*, tapi di CI produksi pastikan variable `CI=true` selalu *set* sehingga insta *force-fails* langsung saat *mismatch*, bukannya menunggu prompt interaktif.
