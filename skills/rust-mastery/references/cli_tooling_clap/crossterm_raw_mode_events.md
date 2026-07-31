# `crossterm` Raw Mode & Events

## Konsep Utama
`crossterm` adalah library lintas platform untuk memanipulasi terminal (warna, kursor, pembersihan layar) dan menangkap input (keyboard, mouse, resize). Fitur terpentingnya untuk CLI interaktif/TUI adalah **Raw Mode**, yang mencegah terminal untuk memproses input lokal (seperti echo karakter atau buffer line/Ctrl+C) sehingga aplikasi dapat merespon pergerakan *keypress* seketika.

## Arsitektur & Flow
```ascii
[OS Terminal PTY] <--(Raw Mode Config)--> [Application]
        |
    [crossterm::event::poll]
        | (Is Event Available?)
    [crossterm::event::read] 
        |--> Keyboard Event (KeyCode, Modifiers)
        |--> Mouse Event (Click, Scroll)
        |--> Resize Event (Width, Height)
```

## Production-Ready Code
```rust
use crossterm::{
    cursor::{Hide, Show},
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, Clear, ClearType},
};
use std::io::{self, stdout, Write};
use std::time::Duration;

pub fn interactive_prompt() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(stdout, Hide, Clear(ClearType::All))?;

    let mut cursor_x = 0;

    loop {
        // Non-blocking poll (timeout 250ms)
        if event::poll(Duration::from_millis(250))? {
            match event::read()? {
                Event::Key(key_event) => {
                    // Ignore key release events on Windows
                    if key_event.kind == KeyEventKind::Release {
                        continue;
                    }

                    match key_event.code {
                        KeyCode::Char('c') if key_event.modifiers.contains(KeyModifiers::CONTROL) => {
                            break; // Ctrl+C explicitly handled
                        }
                        KeyCode::Char('q') => {
                            break;
                        }
                        KeyCode::Right => {
                            cursor_x += 1;
                        }
                        KeyCode::Left => {
                            if cursor_x > 0 { cursor_x -= 1; }
                        }
                        _ => {}
                    }
                }
                Event::Resize(cols, rows) => {
                    // Logic to handle terminal resize
                    // e.g., re-render layout based on new constraints
                }
                _ => {} // Mouse events dll
            }
        }
        
        // Render step (contoh sederhana)
        // Di aplikasi nyata, gunakan buffer/ratatui untuk efisiensi
        execute!(stdout, Clear(ClearType::All))?;
        println!("Posisi X: {}\r", cursor_x);
        println!("Tekan 'q' atau Ctrl+C untuk keluar\r");
    }

    execute!(stdout, Show)?;
    disable_raw_mode()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};

    #[test]
    fn test_event_logic() {
        let event = KeyEvent {
            code: KeyCode::Char('c'),
            modifiers: KeyModifiers::CONTROL,
            kind: KeyEventKind::Press,
            state: KeyEventState::empty(),
        };
        assert!(event.modifiers.contains(KeyModifiers::CONTROL));
        assert_eq!(event.code, KeyCode::Char('c'));
    }
}
```

## Anti-Patterns
1. **Tidak Menangani Ctrl+C Sendiri dalam Raw Mode**: 
   *Mengapa Berbahaya:* Dalam mode raw, sinyal SIGINT (Ctrl+C) tidak dikirimkan otomatis oleh terminal. Jika program anda terjebak di infinite loop dan anda tidak menangani `KeyCode::Char('c') + CONTROL`, aplikasi tidak dapat dihentikan pengguna.
2. **Asumsi Blocking Read Aman di Loop UI**:
   *Mengapa Berbahaya:* Memanggil `event::read()` akan mem-block thread hingga event berikutnya datang. UI tidak akan di-redraw, menghentikan animasi atau background task yang memerlukan tick rendering terus-menerus. Selalu gunakan `poll()`.

## Edge Cases & Defensive Programming
- **Line Endings (CRLF)**: Dalam mode raw, menggunakan `println!` atau `\n` akan sekedar turun 1 baris tanpa kembali ke awal kolom. Anda wajib memakai `\r\n` atau mencetak carriage return secara manual agar teks tidak membentuk tangga.
- **Panic Guard**: Selalu siapkan struktur pengaman (seperti Drop trait) yang memastikan `disable_raw_mode()` dipanggil bahkan ketika program mem-panic.
