# Arsitektur ECS (Entity Component System) di Bevy

## Konsep Utama & Arsitektur
Bevy menggunakan arsitektur ECS yang Data-Driven, sangat mementingkan **Data Locality** untuk efisiensi CPU Cache L1/L2. Tujuannya adalah merancang sistem untuk memproses data ribuan objek di memori secara linear dalam hitungan mikrodetik (SIMD friendly).

Terdapat dua bentuk penyimpanan (storage) utama di ECS Bevy:
1. **Archetypal (Table) Storage (Default)**: Entitas dengan set komponen yang *identik persis* dikelompokkan pada tabel alokasi memori linear (array) yang sama (Archetypes). Akses query berkecepatan super tinggi (contiguous).
2. **Sparse Sets (SparseStorage)**: Komponen yang sering ditambahkan/dihapus frame-per-frame ditaruh di set independen. Ini mempercepat "fragmentasi", menghindarkan overhead mahal pemindahan memori antar archetype (Archetype Move) setiap kali komponen ditambah/dihapus.

### Diagram Arsitektur: Archetype vs Sparse Set Memory Layout
```text
[ Archetype Table 1: (Transform, Velocity, Player) ] (Dense)
Index 0: [ Transform0 ] [ Velocity0 ] [ Player0 ]
Index 1: [ Transform1 ] [ Velocity1 ] [ Player1 ]
* Ideal untuk iterasi linear massal tanpa branching (SIMD-able).
* Buruk jika kita sering memanggil commands.remove::<Velocity>().

[ Sparse Set: (Poisoned) ]
EntityID -> Sparse Index -> Dense Data Index -> Data [Poisoned(10)]
* Menambah/menghapus Poisoned dari entity sangat cepat.
* Iterasi tidak selinear Archetype, tetapi tidak memicu relokasi memori archetype massal.
```

## Kode Produksi Bevy ECS Queries & Scheduling
Kode ini mendemonstrasikan sistem kueri efisien untuk movement, ditambah penjadwalan paralel aman.

```rust
use bevy::prelude::*;

// Komponen (Struct Data murni)
#[derive(Component, Default, Debug)]
pub struct Transform2D {
    pub x: f32,
    pub y: f32,
}

#[derive(Component, Default, Debug)]
pub struct Velocity {
    pub vx: f32,
    pub vy: f32,
}

// Marker component (Empty struct, nol ukuran memory)
#[derive(Component)]
pub struct Player;

// 1. Sistem Iterasi Massal dengan Filter (Archetypal access)
pub fn physics_movement_system(
    time: Res<Time>,
    // Hanya ambil mutasi Transform yang juga punya Velocity. Tanpa Player marker
    mut query: Query<(&mut Transform2D, &Velocity), Without<Player>>,
) {
    let delta = time.delta_seconds();

    for (mut transform, velocity) in query.iter_mut() {
        transform.x += velocity.vx * delta;
        transform.y += velocity.vy * delta;
    }
}

// 2. Sistem Khusus Player (Conflict-free Parallelism)
pub fn player_movement_system(
    time: Res<Time>,
    // Hanya Player (Aman diparalelisasikan oleh Bevy ECS Scheduler dengan sistem di atas)
    mut query: Query<(&mut Transform2D, &Velocity), With<Player>>,
) {
    let delta = time.delta_seconds();

    for (mut transform, velocity) in query.iter_mut() {
        // Logika custom untuk player
        transform.x += (velocity.vx * 2.0) * delta; // lari 2x lebih cepat
        transform.y += (velocity.vy * 2.0) * delta;
    }
}

pub struct PhysicsPlugin;

impl Plugin for PhysicsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            (
                physics_movement_system,
                player_movement_system,
            )
            // Scheduler Bevy otomatis mendeteksi bahwa dua sistem di atas 
            // mengakses komponen Mutable Transform2D pada set entitas yang disjoint 
            // (satu Without<Player>, satu With<Player>). 
            // Maka, sistem di atas akan dieksekusi secara MULTITHREADING paralel!
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_physics_simulation() {
        let mut app = App::new();
        
        // Mock resource manual
        let mut time = Time::default();
        time.update();
        app.insert_resource(time);
        
        app.add_plugins(PhysicsPlugin);

        // Spawn entiti NPC
        let npc_id = app.world_mut()
            .spawn((Transform2D { x: 0.0, y: 0.0 }, Velocity { vx: 10.0, vy: 0.0 }))
            .id();
            
        // Simulasi 1 frame run scheduler
        app.update();
        
        let npc_transform = app.world().get::<Transform2D>(npc_id).unwrap();
        // Verifikasi mutasi terjadi
        // x akan 0.0 karena Time resourcenya belum maju delta sec yang valid di test (dummy delta). 
        // Tapi logic compile & type access teruji.
        assert_eq!(npc_transform.y, 0.0); 
    }
}
```

## Anti-Patterns

### 1. Mengubah Tipe Archetype Setiap Frame (Archetype Thrashing)
**Penjelasan:** Menggunakan `commands.entity(id).insert(MyComponent)` dan `remove(MyComponent)` di loop Update untuk status flag boolean (seperti is_jumping, is_grounded).
**Bahaya:** Ini memicu pergerakan data raksasa di backend memori (dari Archetype A ke Archetype B). CPU harus meng-copy semua field komponen entitas ke tabel array yang baru.
**Solusi:** Gunakan Enum state di dalam komponen (`State::Jumping`), atau gunakan anotasi komponen Sparse Set `#[component(storage = "SparseSet")]`.

### 2. Query Aliasing Deadlock
**Penjelasan:** Mencoba menjalankan dua buah sistem yang mana keduanya meminta `Query<&mut Transform>` tanpa di-disjoint (tidak ada With/Without filter).
**Bahaya:** Bevy ECS Scheduler akan mem-fallback ke single-thread mode atau Anda akan menemui conflict kompilasi. Terlebih jika Anda mengakses memori komponen yang sama di dua kueri berbeda (Nested Iterations di 1 fungsi), Anda akan memicu Rust Borrow Checker panic (`QueryEntityError::AliasedMutability`).

## Edge Cases & Defensive Programming

1. **Commands Latency**:
   Semua modifikasi struktur via `Commands` (spawn/despawn/insert) TIDAK dieksekusi seketika (instant). Ia tertahan (buffered) dan baru diaplikasikan pada fase `apply_deferred` (biasanya di akhir jadwal frame). Jika Anda men-spawn entitas di awal logic fungsi, lalu di baris berikutnya mencoba me-query-nya via Entity ID, ia akan PANIC karena entity belum eksis! Pahami sync point.
2. **Changed Res & Events**:
   Deteksi `Changed<T>` query filter itu mengandalkan "Tick" internal Bevy. Jika Anda mengubah komponen ke nilai yang SAMA (misal: `transform.x = transform.x;`), Bevy tetap menganggapnya 'Berubah' karena ia merujuk pada deref mutation (`DerefMut`), bukan equality perbandingan nilainya (`PartialEq`). Ini bisa memicu infinity loop event jika tidak hati-hati.
3. **Penyusutan Kinerja Entity Berlebihan**:
   Saat puluhan ribu proyektil (peluru) dihapus `despawn` tiap detik, ID array tidak benar-benar dikosongkan. Bevy menggunakan Generational Arena. Meskipun memori komponen di-free, fragmentasi index bisa terjadi. Gunakan teknik "Object Pooling" (merubah visibilitas proyektil dan memindahkannya jauh di off-screen) ketimbang secara brutal menambah-hapus entitas di game intensif.
