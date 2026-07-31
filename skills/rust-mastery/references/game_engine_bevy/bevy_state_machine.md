# Bevy State Machine

## Konsep Utama
Manajemen Scene di Bevy diatur oleh sistem `States`. Daripada memiliki *IF-ELSE* flag boolean rumit, `States` adalah Enum yang terintegrasi langsung ke dalam scheduler. Fitur ini memungkinkan anda menjadwalkan blok Sistem tertentu hanya berjalan di `OnEnter`, `OnExit`, atau `Update` dari Status tertentu (misal menu utama, permainan jeda, level transisi). Ini memastikan transisi logika UI dan gameplay yang bersih, bebas bentrok dan deterministic.

## Arsitektur & Flow
```ascii
[ GameState::MainMenu ]
         |
    (Menu Button Clicked)
         |
[ NextState<GameState>::set(InGame) ] ---> [ OnExit(MainMenu) ] -> (Cleanup menu UI)
                                                 |
                                           [ OnEnter(InGame) ]  -> (Spawn hero, enemy)
                                                 |
                                           [ Update(InGame) ]   -> (Game logic Loop)
```

## Production-Ready Code
```rust
use bevy::prelude::*;

// 1. Definisikan state utama (derive standar untuk trait States)
#[derive(States, Default, Clone, Eq, PartialEq, Debug, Hash)]
pub enum GameState {
    #[default]
    MainMenu,
    Playing,
    Paused,
}

// Struct penanda untuk pembersihan UI Menu
#[derive(Component)]
pub struct MainMenuUI;

// 2. Setup Transisi Logika
pub fn setup_menu(mut commands: Commands) {
    commands.spawn((
        TextBundle::from_section(
            "Mulai Main (Tekan Spasi)",
            TextStyle { font_size: 50.0, ..default() },
        ),
        MainMenuUI, // Penanda untuk dibersihkan
    ));
}

pub fn handle_menu_input(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut next_state: ResMut<NextState<GameState>>,
) {
    if keyboard.just_pressed(KeyCode::Space) {
        info!("Masuk In-Game!");
        // Transisi aman melalui mutasi queue Bevy
        next_state.set(GameState::Playing);
    }
}

pub fn cleanup_menu(mut commands: Commands, query: Query<Entity, With<MainMenuUI>>) {
    // Despawn semua elemen yang memiliki tag Menu saat layar ditinggalkan
    for entity in query.iter() {
        commands.entity(entity).despawn_recursive();
    }
}

// 3. Register Plugin Logic
pub struct StatePlugin;

impl Plugin for StatePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<GameState>()
            // Dijadwalkan saat MainMenu masuk dan sedang update
            .add_systems(OnEnter(GameState::MainMenu), setup_menu)
            .add_systems(Update, handle_menu_input.run_if(in_state(GameState::MainMenu)))
            // Dijadwalkan saat MainMenu keluar (cleanup fase)
            .add_systems(OnExit(GameState::MainMenu), cleanup_menu)
            // Logika spesifik saat Playing berjalan saja
            .add_systems(Update, play_logic.run_if(in_state(GameState::Playing)));
    }
}

pub fn play_logic() {
    // Logika gameplay physics dll
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_initial_state() {
        let state = GameState::default();
        assert_eq!(state, GameState::MainMenu);
    }
}
```

## Anti-Patterns
1. **Mengubah state mutabel `CurrentState` secara langsung**: 
   *Mengapa Berbahaya:* Anda tidak bisa memodifikasi `Res<State<T>>` langsung. Perubahan harus diproses melalui `ResMut<NextState<T>>`. Bevy membutuhkan delay scheduler hingga akhir fase apply (Flush) agar komponen _OnExit_ tereksekusi paripurna. Transisi langsung akan merusak pipeline tick frame Bevy.
2. **Tidak Membersihkan Aset/Entitas di `OnExit`**:
   *Mengapa Berbahaya:* Lupa men-despawn karakter (atau UI Button) pada rute `OnExit(GameState::Playing)` ketika pemain "Quit to Menu" akan menumpuk entitas dan menyebabkan hantu rendering bertumpuk pada ronde berikutnya (State overlap glitch).

## Edge Cases & Defensive Programming
- **Computed States & Sub-States**: Di Bevy v0.14+, hirarki sub-state telah stabil. Daripada men-set kombinasi rumit enum (e.g. `InGamePaused`, `InGamePlaying`), lebih tangguh memakai turunan Computed state. Jadi logika rendering in-game bisa terus berjalan walaupun Logic movement-nya di-*pause* via filter constraint state terpisah.
- **Transisi Berganda dalam Satu Frame**: Jika dua UI button ditekan bersamaan dan memicu dua panggilan `NextState::set(A)` dan `NextState::set(B)` di frame yang sama, pemanggilan sistem terakhir yang akan menimpa/menang. Pastikan penguncian boolean manual di input UI jika menuntut determinisme absolut di multi-trigger.
