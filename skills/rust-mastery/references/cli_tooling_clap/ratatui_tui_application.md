# `ratatui` TUI Application

## Konsep Utama
`ratatui` adalah framework pilihan di Rust untuk membangun Text User Interfaces (TUI). Ia menggunakan model deklaratif, di mana UI digambar ulang setiap frame (immediate mode style wrapper) di atas buffer terminal. Dipadukan dengan backend seperti `crossterm` dan runtime `tokio`, ia mampu menghasilkan UI responsif, asinkron, dan kaya fitur di lingkungan terminal.

## Arsitektur & Flow
```ascii
[Event Source (Crossterm / Async Tasks)] 
          |
          v (mpsc channel)
    [Event Loop] --> [App State Update]
          |
          v
   [Terminal Draw] --> [Widget Rendering (ratatui)]
          |
          v
[Terminal Output (CrosstermBackend)]
```

## Production-Ready Code
```rust
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Direction, Layout},
    style::{Color, Style},
    widgets::{Block, Borders, Paragraph},
    Terminal,
};
use std::{error::Error, io};
use tokio::sync::mpsc;
use std::time::Duration;

pub struct App {
    pub counter: i32,
    pub quit: bool,
}

impl App {
    pub fn new() -> Self {
        Self { counter: 0, quit: false }
    }
}

pub async fn run_tui() -> Result<(), Box<dyn Error>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new();
    let (tx, mut rx) = mpsc::channel(100);

    // Event polling in async task
    tokio::spawn(async move {
        loop {
            if event::poll(Duration::from_millis(16)).unwrap() {
                if let Event::Key(key) = event::read().unwrap() {
                    tx.send(key).await.unwrap();
                }
            }
        }
    });

    let res = run_app(&mut terminal, &mut app, &mut rx).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    res
}

async fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
    rx: &mut mpsc::Receiver<crossterm::event::KeyEvent>,
) -> Result<(), Box<dyn Error>> {
    loop {
        terminal.draw(|f| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .margin(1)
                .constraints([Constraint::Percentage(100)].as_ref())
                .split(f.size());

            let p = Paragraph::new(format!("Counter: {}\nPress 'q' to quit, '+' to add, '-' to sub", app.counter))
                .block(Block::default().title("Ratatui App").borders(Borders::ALL))
                .style(Style::default().fg(Color::Cyan));
            f.render_widget(p, chunks[0]);
        })?;

        if let Some(key) = rx.recv().await {
            match key.code {
                KeyCode::Char('q') => app.quit = true,
                KeyCode::Char('+') => app.counter += 1,
                KeyCode::Char('-') => app.counter -= 1,
                _ => {}
            }
        }

        if app.quit {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    #[test]
    fn test_app_counter() {
        let mut app = App::new();
        assert_eq!(app.counter, 0);
        app.counter += 1;
        assert_eq!(app.counter, 1);
    }
}
```

## Anti-Patterns
1. **Blocking Main Thread**: 
   *Mengapa Berbahaya:* Memanggil sinkron API (seperti IO disk atau jaringan) di dalam thread rendering `Terminal::draw` akan membekukan UI dan menjadikannya tidak responsif.
2. **Tidak merestore state terminal saat panic**:
   *Mengapa Berbahaya:* Jika aplikasi panic dalam "raw mode" dan tidak merestore dengan `disable_raw_mode()`, terminal user akan menjadi rusak/glitchy, memaksa user mereset shell.

## Edge Cases & Defensive Programming
- **Panic Handlers**: Daftarkan custom `std::panic::set_hook` untuk secara eksplisit membersihkan alternate screen dan raw mode sebelum mencetak pesan panic, sehingga error tetap bisa dibaca user.
- **Resize Events**: Harus diproses dengan hati-hati. `ratatui` otomatis menyesuaikan bounds, tetapi logika kalkulasi layout custom (constraints) bisa crash jika ukurannya terlalu sempit.
