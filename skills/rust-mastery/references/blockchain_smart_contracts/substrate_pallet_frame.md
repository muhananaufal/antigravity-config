# Substrate FRAME Pallet

## Konsep Utama
Substrate (kerangka dasar dari blockchain Polkadot) menggunakan "Pallet" (modul eksekusi runtime) yang ditulis dalam FRAME. Alih-alih smart-contract terisolasi (seperti Wasm atau EVM), pallet adalah potongan *core-code* node. Mereka berjalan secara natif dan berinteraksi mendalam dengan layer konsensus, mendefinisikan skema state `StorageMap`, sinyal logika dispatchable `Call`, `Event`, serta error secara makro deklaratif.

## Arsitektur & Flow
```ascii
[ Extrinsic (Transaksi) ] -> [ Substrate Transaction Pool ]
                                       |
                     [ Runtime Dispatcher (pallet_balances, dll) ]
                                       |
                   [ #[pallet::call] (Fungsi Eksekusi Eksternal) ]
                                       |
                 [ Mutate State #[pallet::storage] via DB RocksDB ] -> [ Emit #[pallet::event] ]
```

## Production-Ready Code
```rust
#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

#[frame_support::pallet]
pub mod pallet {
    use frame_support::pallet_prelude::*;
    use frame_system::pallet_prelude::*;

    #[pallet::pallet]
    #[pallet::generate_store(pub(super) trait Store)]
    pub struct Pallet<T>(_);

    // Konfigurasi sistem traiting (Dependency Injection)
    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    }

    // Storage on-chain
    #[pallet::storage]
    #[pallet::getter(fn points)]
    pub type Points<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// Poin berhasil ditambahkan ke akun
        PointsAdded { who: T::AccountId, amount: u32 },
    }

    #[pallet::error]
    pub enum Error<T> {
        /// Limit poin melampaui integer 32-bit
        StorageOverflow,
    }

    // Entrypoint fungsi transaksi
    #[pallet::call]
    impl<T: Config> Pallet<T> {
        #[pallet::weight(10_000 + T::DbWeight::get().writes(1).ref_time())]
        pub fn add_points(origin: OriginFor<T>, amount: u32) -> DispatchResult {
            // Verifikasi origin transaksi adalah akun yang valid
            let who = ensure_signed(origin)?;

            // Logika State Mutasi
            Points::<T>::mutate(&who, |point| {
                if let Some(new_val) = point.checked_add(amount) {
                    *point = new_val;
                    Ok(())
                } else {
                    Err(Error::<T>::StorageOverflow)
                }
            })?;

            // Emit sinyal keluar
            Self::deposit_event(Event::PointsAdded { who, amount });
            
            Ok(())
        }
    }
}

// Di lingkungan Substrate, tes dibungkus dengan mock environment. 
// Ini simulasi sketsa dasarnya.
#[cfg(test)]
mod tests {
    // Note: requires mock.rs frame-support
    // #[test]
    // fn add_points_works() {
    //     new_test_ext().execute_with(|| {
    //         assert_ok!(PalletModule::add_points(RuntimeOrigin::signed(1), 100));
    //         assert_eq!(PalletModule::points(1), 100);
    //     });
    // }
}
```

## Anti-Patterns
1. **Looping Tanpa Batas atau Iterasi Array Besar**: 
   *Mengapa Berbahaya:* Blockchain Substrate beroperasi pada batasan eksekusi block time ketat (~6 detik). Melakukan iterasi seluruh entri `StorageMap` akan membuat waktu kalkulasi beban memakan banyak _Weight_, mengakibatkan chain *stall* dan block tidak tercetak.
2. **Tidak Melakukan Validasi `ensure_signed` atau Otoritas**:
   *Mengapa Berbahaya:* Transaksi RPC ke jaringan (disebut Extrinsic) dapat dikirim kosong (unsigned) atau oleh root. Jika dispatcher logic call tidak memverifikasi caller, akun root atau anonim bisa merusak data kritikal.

## Edge Cases & Defensive Programming
- **Weight Calibration**: Semua parameter `#[pallet::weight(..)]` wajib dikalibrasi via proses "Benchmarking" di mesin riil. Jangan memakai hardcode nilai statik `10_000` di mainnet. Runtime yang diretas biayanya akan under-priced dan rawan serangan DDoS (Spam transaksi murahan membekukan blockchain).
- **Storage Item Cleanup**: Jika Anda menggunakan `StorageMap` atau `StorageDoubleMap`, data state persisten selamanya dan biaya state-rent merayap naik. Sediakan API/mekanisme Call untuk membersihkan `remove()` entri yang terbengkalai.
