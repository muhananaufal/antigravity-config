# Bevy Multithreaded Scheduler

## Konsep Utama
Bevy memiliki Scheduler (penjadwal sistem) yang sangat cerdas. Di balik layar, ia menelusuri argument-argument parameter seluruh fungsi `System` yang terdaftar. Jika Sistem A dan B tidak memutasi `Component` atau `Resource` yang sama, Bevy otomatis menjalankan keduanya secara paralel (Multithreading) lewat pool worker Thread. Namun, hal ini bisa menimbulkan ketidakpastian urutan, sehingga penggunaan `SystemSet` dan constraints (pengendali urutan) sangat kritikal.

## Arsitektur & Flow
```ascii
[ Scheduler Analysis ]
         |
    (Data Dependency Graph)
         |
    [ Worker Thread 1 ]  --> System A (Mut Health)
    [ Worker Thread 2 ]  --> System B (Mut Transform) 
    [ Worker Thread 3 ]  --> System C (Read Health, Read Transform) 
         |
    (Sync Point / Apply Deferred)
         |
    [ Rendering Step ]
```

## Production-Ready Code
```rust
use bevy::prelude::*;

// Define custom schedule ordering sets
#[derive(SystemSet, Debug, Hash, PartialEq, Eq, Clone)]
pub enum PhysicsSet {
    CalculateForces,
    Movement,
    CollisionHandling,
}

#[derive(Component)]
pub struct Collider;

pub fn calculate_forces() {
    // Logic applied here
}
pub fn movement_system() {
    // Logic applied here
}
pub fn collision_detection() {
    // Logic applied here
}
pub fn handle_death() {
    // Logic applied here
}

// Integrasi ke dalam App Bevy
pub fn build_physics_app() -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins);
    
    app.configure_sets(
        Update,
        (
            PhysicsSet::CalculateForces,
            PhysicsSet::Movement,
            PhysicsSet::CollisionHandling,
        ).chain() // Memaksa urutan A -> B -> C
    );

    app.add_systems(
        Update,
        (
            calculate_forces.in_set(PhysicsSet::CalculateForces),
            movement_system.in_set(PhysicsSet::Movement),
            // collision dijalankan sebelum apply_deferred (sync point)
            collision_detection.in_set(PhysicsSet::CollisionHandling),
        )
    );

    // Sistem yang harus tunggu (tidak boleh berjalan paralel dengan collision_detection
    // jika mereka berlomba mengubah state global
    app.add_systems(Update, handle_death.after(PhysicsSet::CollisionHandling));

    app
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_builds() {
        let app = build_physics_app();
        assert_eq!(app.is_plugin_added::<MinimalPlugins>(), true);
    }
}
```

## Anti-Patterns
1. **Mengabaikan Peringatan Ambiguitas (Ambiguity Warnings)**: 
   *Mengapa Berbahaya:* Jika System X memutasi `Score` dan System Y membaca `Score`, dan Anda tidak mengatur urutannya `.before()` atau `.after()`, sistem Bevy akan mengeksekusi mereka dalam urutan acak setiap frame. Bug frame-flickering dan logika yang inkonsisten antar tick akan muncul.
2. **Ketergantungan `.after()` yang Membentuk Lingkaran (Cycle)**:
   *Mengapa Berbahaya:* Mendefinisikan A `.after(B)` dan B `.after(A)` akan menyebabkan runtime panic parah saat mesin menyusun *Dependency Graph*, karena mustahil dijadwalkan.

## Edge Cases & Defensive Programming
- **Thread Local Execution**: Sistem non-Send (mengakses pointer C dari library GUI atau API OS audio primitif) HARUS jalan di Main Thread. Anda harus menjadwalkannya secara eksplisit di Bevy sehingga tak dipindah ke thread pool sembarang (bisa segfault di OS tertentu).
- **apply_deferred**: Jika Sistem A memasukkan (spawns) peluru dengan fungsi `Commands`, dan Sistem B langsung mencari peluru itu di frame yang sama, Sistem B tidak akan mendeteksi apa-apa! `Commands` di-buffer. Panggil parameter khusus `apply_deferred` sebagai sistem perantara agar Bevy meng-flush queue komponen baru sebelum B berjalan.
