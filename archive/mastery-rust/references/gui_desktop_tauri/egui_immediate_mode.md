# `egui` Immediate Mode GUI

## Konsep Utama
`egui` (Egui) adalah framework GUI bergaya *Immediate Mode* untuk Rust. Tidak seperti retained mode (DOM, GTK, QT) di mana widget menyimpan statusnya sendiri (button exists di memori), dalam immediate mode, UI sepenuhnya digambar dan diproses dari awal pada setiap frame iterasi (biasanya sinkron dengan refresh rate game, mis. 60 FPS). Ini meniadakan sinkronisasi state yang kompleks antara data dan visual (Zero data duplication).

## Arsitektur & Flow
```ascii
    [ Application State Struct ]
               |
               v
       [ Loop / eframe::App::update ]
               |
[egui::Context (Ctx) layout & input parsing] 
               |
  [egui::Window, egui::Button UI Code] -- (Mutate State directly)
               |
        [ Mesh Generation ]
               |
        [ GPU Render (eframe) ]
```

## Production-Ready Code
```rust
use eframe::egui;

pub struct DashboardApp {
    label_text: String,
    value: f32,
    dark_mode: bool,
}

impl Default for DashboardApp {
    fn default() -> Self {
        Self {
            label_text: "Hello, Egui!".to_owned(),
            value: 50.0,
            dark_mode: true,
        }
    }
}

impl eframe::App for DashboardApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Toggle tema
        ctx.set_visuals(if self.dark_mode {
            egui::Visuals::dark()
        } else {
            egui::Visuals::light()
        });

        // Top Panel Setup
        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            egui::menu::bar(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("Quit").clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                });
            });
        });

        // Central Layout
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("System Configuration");

            ui.horizontal(|ui| {
                ui.label("Name: ");
                ui.text_edit_singleline(&mut self.label_text);
            });

            ui.add(egui::Slider::new(&mut self.value, 0.0..=100.0).text("Volume"));
            
            ui.checkbox(&mut self.dark_mode, "Dark Mode");

            if ui.button("Simpan Setting").clicked() {
                // Proses penyimpanan state (mock)
                println!("Data: {}, Vol: {}", self.label_text, self.value);
            }
        });
    }
}

// Untuk app entry
// pub fn run_gui() -> eframe::Result<()> {
//     let options = eframe::NativeOptions::default();
//     eframe::run_native(
//         "My Dashboard",
//         options,
//         Box::new(|_cc| Box::new(DashboardApp::default())),
//     )
// }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_state_mutation() {
        let mut app = DashboardApp::default();
        app.value = 10.0;
        assert_eq!(app.value, 10.0);
    }
}
```

## Anti-Patterns
1. **Membuat alokasi objek raksasa dalam `update`**: 
   *Mengapa Berbahaya:* Loop `update()` dipanggil setiap frame (~16ms). Jika Anda membuat request HTTP jaringan, membaca file I/O secara memblokir, atau alokasi buffer raksasa di dalam scope ini, FPS akan langsung anjlok (Stuttering).
2. **Kehilangan fokus pada Custom Input**:
   *Mengapa Berbahaya:* Jika mengubah nilai state secara background saat input TextField memiliki fokus di Egui, Teks di layar akan kembali berulang dan kursor melompat aneh. Pertimbangkan validasi data saat kursor tidak fokus (lost_focus).

## Edge Cases & Defensive Programming
- **Font Rendering Asynchronous**: Egui hanya mengetahui sistem font standar. Memuat font custom `.ttf` butuh instruksi explisit di saat startup aplikasi via struct `FontDefinitions` yang diinject di struct konteks `egui::Context` dan harus selesai sebelum render pertama.
- **Id Collision**: Jika anda menggunakan loop dan menaruh `ui.button("OK")` berulang kali, egui akan bentrok identifikasi interaksinya. Gunakan string unique atau `ui.push_id` per elemen iterasi loop.
