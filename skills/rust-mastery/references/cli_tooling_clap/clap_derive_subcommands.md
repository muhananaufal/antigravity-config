# `clap` Derive API & CLI Parsing

## Konsep Utama
`clap` (Command Line Argument Parser) adalah standar de-facto untuk membangun antarmuka baris perintah di Rust. `clap` versi 4 menggunakan sistem macros/derive API (`Parser`, `Args`, `Subcommand`) untuk mendeklarasikan struktur argumen secara statis, memberikan type safety, validasi nilai bawaan, fallback variabel lingkungan (env vars), dan pembuatan auto-completion otomatis. Ini krusial untuk CLI yang ergonomis, maintainable, dan aman.

## Arsitektur & Flow
```ascii
[User Input: "cli run --port 8080"] 
       |
       v
[OS Args Parsing] -> [clap::Command]
       |
       v
[Validation (Types, Bounds, Env Fallbacks)]
       |
       v
[Struct `Cli` (Type-Safe)] -> [Subcommand Dispatch] -> [Application Logic]
```

## Production-Ready Code
```rust
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// CLI Tool yang kuat dan type-safe
#[derive(Parser, Debug)]
#[command(name = "forge", version = "1.0", author = "Engineer")]
#[command(about = "Manajemen infrastruktur tingkat lanjut", long_about = None)]
pub struct Cli {
    /// Aktifkan mode verbose (-v, -vv, -vvv)
    #[arg(short, long, action = clap::ArgAction::Count)]
    pub verbose: u8,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Menjalankan server
    Run(RunArgs),
    /// Melakukan deploy konfigurasi
    Deploy {
        /// Target deployment
        #[arg(short, long, value_enum, default_value_t = TargetEnv::Dev)]
        env: TargetEnv,
    },
}

#[derive(Args, Debug)]
pub struct RunArgs {
    /// Port untuk server
    #[arg(short, long, env = "FORGE_PORT", default_value_t = 8080)]
    pub port: u16,

    /// Jalur file konfigurasi
    #[arg(short, long, value_name = "FILE", value_hint = clap::ValueHint::FilePath)]
    pub config: Option<PathBuf>,
}

#[derive(ValueEnum, Clone, Debug, PartialEq)]
pub enum TargetEnv {
    Dev,
    Staging,
    Prod,
}

pub fn run_cli(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    match cli.command {
        Commands::Run(args) => {
            println!("Starting server on port: {} (Verbose: {})", args.port, cli.verbose);
        }
        Commands::Deploy { env } => {
            println!("Deploying to environment: {:?}", env);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_cli() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn parse_run_command() {
        let args = Cli::parse_from(&["forge", "-vv", "run", "--port", "9090"]);
        assert_eq!(args.verbose, 2);
        match args.command {
            Commands::Run(r) => assert_eq!(r.port, 9090),
            _ => panic!("Expected Run subcommand"),
        }
    }
}
```

## Anti-Patterns
1. **Menggunakan Builder API untuk struktur statis**: 
   *Mengapa Berbahaya:* Builder API (menggunakan `Command::new()`, `Arg::new()`) rentan terhadap typo dan error string-matching (misal `matches.get_one::<String>("potr")`). Derive API memastikan validasi pada waktu kompilasi.
2. **Tidak menggunakan `debug_assert()` di test**:
   *Mengapa Berbahaya:* Kesalahan konfigurasi pada macro `clap` (seperti konflik flags) akan menyebabkan panic saat runtime jika tidak diverifikasi dengan `Cli::command().debug_assert()` di dalam unit test.

## Edge Cases & Defensive Programming
- **Env Var Fallback & Prioritas**: Pastikan nilai yang diteruskan secara eksplisit mengesampingkan `env`. `clap` menangani ini secara default, tapi pengujian diperlukan.
- **Value Hints**: Gunakan `value_hint` untuk path agar shell completion dapat memberikan rekomendasi file/direktori dengan benar, mencegah user frustration.
