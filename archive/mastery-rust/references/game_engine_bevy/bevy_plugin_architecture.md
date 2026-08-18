# Bevy Plugin Architecture

## Konsep Utama
Bevy dirancang sangat modular: "Segalanya adalah Plugin". `Plugin` trait adalah dasar ekstensi fungsional. Alih-alih merangkum semua logika di `main.rs`, sistem dipecah menjadi kumpulan *Plugin* terisolasi (misalnya `PhysicsPlugin`, `AudioPlugin`, `UIPlugin`). Kelompok plugin ini kemudian dapat dimatikan, dipindah proyek (reusable crates), atau diekstensikan dengan `PluginGroup` untuk mendikte fungsionalitas kompleks dalam 1 baris kode setup (seperti `DefaultPlugins`).

## Arsitektur & Flow
```ascii
    [ App Builder (main.rs) ]
               |
      [ App::add_plugin ]
       /       |        \
[Plugin 1] [Plugin 2] [PluginGroup]
  (Init)    (Init)     /    |    \
   |         |      [P3]  [P4]  [P5]
(Register System, Resources, Events)
```

## Production-Ready Code
```rust
use bevy::prelude::*;

// Struktur Custom Plugin (Bisa di export di library crate terpisah)
pub struct CombatPlugin;

impl Plugin for CombatPlugin {
    fn build(&self, app: &mut App) {
        // Register Event
        app.add_event::<DamageEvent>();
        
        // Register Global System Set Ordering
        app.configure_sets(Update, CombatSet);
        
        // Register Core Systems
        app.add_systems(
            Update,
            (
                detect_hit.in_set(CombatSet),
                apply_damage.in_set(CombatSet).after(detect_hit),
            ),
        );
        
        info!("CombatPlugin berhasil dimuat!");
    }
}

// System Sets khusus combat modul
#[derive(SystemSet, Debug, Hash, PartialEq, Eq, Clone)]
pub struct CombatSet;

// Custom Event Struct (Message Bus)
#[derive(Event)]
pub struct DamageEvent {
    pub target: Entity,
    pub amount: f32,
}

fn detect_hit(mut ev_damage: EventWriter<DamageEvent>, query: Query<Entity>) {
    // Simulasi deteksi hit
    if let Some(target) = query.iter().next() {
        ev_damage.send(DamageEvent {
            target,
            amount: 15.0,
        });
    }
}

fn apply_damage(mut ev_damage: EventReader<DamageEvent>) {
    for ev in ev_damage.read() {
        println!("Entity {:?} menerima {} damage", ev.target, ev.amount);
    }
}

// Plugin Group yang membungkus banyak hal (Pola Skalabilitas Bevy)
pub struct CoreGamePlugins;

impl PluginGroup for CoreGamePlugins {
    fn build(self) -> bevy::app::PluginGroupBuilder {
        bevy::app::PluginGroupBuilder::start::<Self>()
            .add(CombatPlugin)
            // .add(InventoryPlugin) // dll
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_initialization() {
        let mut app = App::new();
        app.add_plugins(CombatPlugin);
        // Validasi apakah sistem event teregistrasi (tanpa panic)
        let _ = app.world().resource::<Events<DamageEvent>>();
    }
}
```

## Anti-Patterns
1. **Hardcoding logika raksasa di Setup Loop `main`**: 
   *Mengapa Berbahaya:* Jika 100+ sistem disisipkan pada `.add_systems()` di file root secara langsung, dependency order resolusinya akan mustahil untuk didebug. Jika direstokturing menjadi module plugin, logika pembagian ranah (domain split) lebih higienis dan test-able.
2. **Duplikasi Inisialisasi Resource**:
   *Mengapa Berbahaya:* Memanggil `app.insert_resource()` secara konstan pada method `.build()` di multi-plugin akan saling override nilai jika tipenya identik. Gunakan `app.init_resource::<T>()` yang akan menjalankan inisiasi trait *Default* HANYA sekali bila resource belum exist di World (safe fallback).

## Edge Cases & Defensive Programming
- **Mendisable Sub-plugin**: Jika menggunakan `.add_plugins(DefaultPlugins)` dalam mode Headless Server (tanpa monitor render), renderer backend akan crash. Anda bisa memakai `.disable::<RenderPlugin>()` di rantai deklarasinya. Ekstensibilitas ini perlu dipertimbangkan saat membangun library `PluginGroup` anda sendiri, pertimbangkan fitur *builder pattern config* di struct anda.
- **Kompilasi Cepat / Feature Flags**: Saat mengarsiteki framework engine lewat Plugin, tandai dependensi berat menggunakan Cargo Features (`#[cfg(feature = "debug_ui")]`). Modul ini mengontrol Plugin yang ter-compile sehingga bundle binary production tidak terkontaminasi oleh diagnostic inspector yang sangat berat.
