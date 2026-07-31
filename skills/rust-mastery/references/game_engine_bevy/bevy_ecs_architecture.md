# Bevy ECS Architecture

## Konsep Utama
Bevy adalah game engine yang dibangun 100% menggunakan arsitektur Entity-Component-System (ECS). Paradigma ini memisahkan Data (Component) dan Logika (System). Entitas hanyalah ID (angka unik). Dengan memecat hierarki Class/OOP (Inheritance), Bevy memastikan tata letak memori cache-friendly (Data-Oriented Design) di mana iterasi sangat cepat dan logika sistem paralel otomatis dapat diorkestrasi tanpa kunci.

## Arsitektur & Flow
```ascii
    [ World (Database Internal ECS) ]
               /          |         \
 [ Entity 1 ]      [ Entity 2 ]       [ Entity 3 ]
(Health, Transform) (Health, Speed)  (Transform, Speed)
         \                /                 /
   [ System A (Query Health) ]     [ System B (Query Transform) ]
         \                /                 /
       [ Parallel Execution (Bevy Scheduler) ]
```

## Production-Ready Code
```rust
use bevy::prelude::*;

// 1. Components
#[derive(Component, Debug, PartialEq)]
pub struct Velocity(pub Vec3);

#[derive(Component, Debug, PartialEq)]
pub struct Health {
    pub current: f32,
    pub max: f32,
}

#[derive(Component)]
pub struct Player;

// 2. Resource (Global state)
#[derive(Resource)]
pub struct GameTimer(Timer);

// 3. Systems
pub fn apply_velocity(
    time: Res<Time>,
    mut query: Query<(&mut Transform, &Velocity)>,
) {
    let delta = time.delta_seconds();
    // Paralel iterasi di ECS
    for (mut transform, velocity) in query.iter_mut() {
        transform.translation += velocity.0 * delta;
    }
}

pub fn damage_player(
    mut commands: Commands,
    mut query: Query<(Entity, &mut Health), With<Player>>,
) {
    for (entity, mut health) in query.iter_mut() {
        health.current -= 10.0;
        
        if health.current <= 0.0 {
            // Despawn (menghapus Entity) secara aman
            commands.entity(entity).despawn();
            info!("Player entity {:?} destroyed!", entity);
        }
    }
}

pub fn setup(mut commands: Commands) {
    commands.spawn((
        Player,
        Health { current: 100.0, max: 100.0 },
        Transform::from_xyz(0.0, 0.0, 0.0),
        Velocity(Vec3::new(1.0, 0.0, 0.0)),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_logic() {
        let mut health = Health { current: 10.0, max: 100.0 };
        health.current -= 10.0;
        assert!(health.current <= 0.0);
    }
}
```

## Anti-Patterns
1. **Menggunakan Struct Besar sebagai Component (God Object)**: 
   *Mengapa Berbahaya:* Arsitektur ECS bersinar saat struktur memori kecil dan spesifik. Jika Anda membuat `Component` `PlayerState` yang mengandung inventori, animasi, HP, speed, iterasi akan lambat karena cache miss memory. Pisahkan menjadi komponen-komponen diskrit.
2. **Kueri Tumpang Tindih yang Mutabel (Conflicting Queries)**:
   *Mengapa Berbahaya:* Jika dua argumen di fungsi sistem meminta `&mut Transform`, Rust (dan Bevy via compile time/run time checker) akan panic. Gunakan `QuerySplit` jika membutuhkan referensi ke entitas berbeda dengan mutasi di query yang sama.

## Edge Cases & Defensive Programming
- **Filter Query**: Jika Anda memiliki 10.000 musuh namun cuma ingin iterasi yang posisi berjalannya berubah, filter `Changed<Transform>` mutlak krusial untuk menyelamatkan siklus CPU. `Without<Dead>` juga mencegah iterasi mayat statis.
- **Commands Buffering**: Fungsi `Commands` tidak langsung dieksekusi seketika. Proses `.despawn()` atau insert baru dimasukkan ke queue dan dijalan di fasa *Apply Deferred* pada akhir cycle scheduler. Tidak bijak membaca ulang entitas baru tepat di function spawn yang sama.
