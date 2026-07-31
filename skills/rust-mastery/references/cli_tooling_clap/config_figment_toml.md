# `figment` Configuration Layering

## Konsep Utama
Aplikasi CLI dan backend sering kali memerlukan sistem konfigurasi yang fleksibel. `figment` adalah library untuk ekstraksi konfigurasi secara terstruktur yang mendukung layering: Anda dapat memprioritaskan Environment Variables di atas file konfigurasi (seperti TOML/JSON), dan keduanya di atas default value. Ia bekerja mulus dengan infrastruktur `serde::Deserialize`.

## Arsitektur & Flow
```ascii
[ Default Config ]
       ^
       | (merges over)
[ config.toml (Profile: global, dev, prod) ]
       ^
       | (merges over)
[ Environment Variables (APP_*) ]
       |
       v
[ figment::Figment (Extraction) ]  -->  [ Strongly Typed Config Struct ]
```

## Production-Ready Code
```rust
use figment::{
    providers::{Env, Format, Toml},
    Figment,
};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize, Debug, PartialEq)]
pub struct AppConfig {
    pub debug: bool,
    pub database_url: String,
    pub retries: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            debug: false,
            database_url: String::from("sqlite://memory"),
            retries: 3,
        }
    }
}

pub fn load_configuration(custom_path: Option<PathBuf>) -> Result<AppConfig, figment::Error> {
    // Bangun provider layer secara berurutan. Prioritas terakhir menang.
    let mut figment = Figment::from(figment::providers::Serialized::defaults(AppConfig::default()));

    if let Some(path) = custom_path {
        figment = figment.merge(Toml::file(path));
    } else {
        // Default config path fallback
        figment = figment.merge(Toml::file("config.toml"));
    }

    // Env Vars (APP_DEBUG, APP_DATABASE_URL) menimpa file
    figment = figment.merge(Env::prefixed("APP_"));

    let config: AppConfig = figment.extract()?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_default_config() {
        let config = load_configuration(Some(PathBuf::from("non_existent.toml"))).unwrap();
        assert_eq!(config.debug, false);
        assert_eq!(config.retries, 3);
    }

    #[test]
    fn test_env_override() {
        // Secara sementara pasang env var
        env::set_var("APP_RETRIES", "10");
        env::set_var("APP_DATABASE_URL", "postgres://localhost");
        
        let config = load_configuration(Some(PathBuf::from("non_existent.toml"))).unwrap();
        assert_eq!(config.retries, 10);
        assert_eq!(config.database_url, "postgres://localhost");

        env::remove_var("APP_RETRIES");
        env::remove_var("APP_DATABASE_URL");
    }
}
```

## Anti-Patterns
1. **Menyimpan Secret di File Konfigurasi di Version Control**: 
   *Mengapa Berbahaya:* Token, API Key, dan credentials lainnya tidak boleh dilacak dalam file `config.toml` standar. Pisahkan secrets ke file terpisah (`.env`, secret store) dan muat menggunakan `Env` provider Figment tanpa menampilkannya (`Debug` log leaks).
2. **Penggunaan String literals untuk nama env Prefix**:
   *Mengapa Berbahaya:* Ketidakkonsistenan penamaan, (misal menggunakan `"APP_"` di satu tempat dan `"app_"` di tempat lain). Figment case-sensitive untuk bagian-bagian tertentu dari layer environment, pertimbangkan normalisasi.

## Edge Cases & Defensive Programming
- **Profile Routing**: Figment mendukung profile seperti `[development]` vs `[production]` di dalam satu TOML. Selalu ambil target dari flag run-time (seperti parameter `--env`) agar provider memuat subtree yang tepat tanpa tumpang tindih.
- **Desialisasi Error**: Menelan pesan error dari ekstrasi konfigurasi sering terjadi. `figment::Error` menampung informasi persis file dan path field mana yang salah atau tipe yang tidak cocok (string vs integer). Log pesan ini ke end-user sepenuhnya.
