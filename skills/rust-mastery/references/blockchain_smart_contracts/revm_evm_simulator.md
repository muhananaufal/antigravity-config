# revm EVM Simulator

## Konsep Utama
`revm` adalah mesin virtual EVM (Ethereum Virtual Machine) yang murni ditulis dalam Rust. Ia sangat cepat, dapat di-*embed*, dan banyak digunakan oleh klien Ethereum modern (seperti Reth) dan infrastruktur riset DeFi / Flashbots (MEV). `revm` memungkinkan simulasi state dan simulasi transaksi lokal berkat kemampuan injeksi basis data statis tanpa harus mensinkronkan chain secara full.

## Arsitektur & Flow
```ascii
    [ Input State / Remote DB (RPC Forking) ]
                     |
         [ Database Trait (revm::Database) ]
                     |
[ Execution Environment (Tx Config, Block Params, Gas Limit) ]
                     |
      [ revm::EVM (Interpreter Step Loop) ] -> (Opcodes: PUSH, SLOAD, CALL)
                     |
       [ Execution Result (State Diffs, Logs, Output) ]
```

## Production-Ready Code
```rust
use revm::{
    db::{CacheDB, EmptyDB},
    primitives::{Address, ExecutionResult, TransactTo, U256},
    EVM,
};
use std::str::FromStr;

pub fn simulate_transfer(sender: &str, receiver: &str, amount_wei: U256) -> anyhow::Result<bool> {
    // 1. Setup Database lokal di Memori
    let mut db = CacheDB::new(EmptyDB::default());
    
    let sender_addr = Address::from_str(sender)?;
    let receiver_addr = Address::from_str(receiver)?;

    // 2. Injeksikan balance (State override)
    let initial_balance = U256::from(10_000_000_000_000_000_000_u128); // 10 ETH
    db.insert_account_info(
        sender_addr,
        revm::primitives::AccountInfo {
            balance: initial_balance,
            nonce: 0,
            code_hash: revm::primitives::KECCAK_EMPTY,
            code: None,
        },
    );

    // 3. Konfigurasi Environment EVM
    let mut evm = EVM::new();
    evm.database(db);

    // Environment Setup (Tx Config)
    evm.env.tx.caller = sender_addr;
    evm.env.tx.transact_to = TransactTo::Call(receiver_addr);
    evm.env.tx.value = amount_wei;

    // 4. Eksekusi Simulasi
    let ref_tx = evm.transact_commit().map_err(|e| anyhow::anyhow!("EVM Execution Error: {:?}", e))?;

    match ref_tx {
        ExecutionResult::Success { reason, gas_used, .. } => {
            println!("Transfer Sukses! Alasan: {:?}. Gas Terpakai: {}", reason, gas_used);
            Ok(true)
        }
        ExecutionResult::Revert { output, gas_used } => {
            println!("Transaksi Revert! Gas: {}, Output: {:?}", gas_used, output);
            Ok(false)
        }
        ExecutionResult::Halt { reason, .. } => {
            println!("Transaksi Terhenti (Halt): {:?}", reason);
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simulate_transfer() {
        let ok = simulate_transfer(
            "0x0000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000002",
            U256::from(1_000_000_000_u64), // 1 Gwei
        );
        assert!(ok.is_ok());
        assert_eq!(ok.unwrap(), true);
    }
}
```

## Anti-Patterns
1. **Mengakses Storage DB Asli secara Sinkron (RPC Blocking)**: 
   *Mengapa Berbahaya:* Jika membuat struktur trait `Database` custom yang memanggil API HTTP Infura/Alchemy secara sinkron (`reqwest::blocking`) pada eksekusi SLOAD, waktu eksekusi VM akan hancur dan program membeku. Untuk Forking, sediakan pre-cached map untuk slot storage.
2. **Tidak menangani Gas Exceed**:
   *Mengapa Berbahaya:* Dalam konfigurasi EVM `.env`, batasan base fee dan gas limit harus diisi akurat. Jika tidak di-set, simulasi transaksi di kontrak kompleks akan menemui OutOfGas padahal di Mainnet memiliki limit gas 30M yang diizinkan. 

## Edge Cases & Defensive Programming
- **State Diffs Inspector**: Hasil EVM (`ExecutionResult`) tidak langsung "menulis" database jika memanggil `.transact()`. Gunakan `.transact_commit()` untuk apply (mutasi database) atau manual apply diffs yang terekan di output jika anda membangun arsitektur pipeline block-builder.
- **Precompiles**: Ada fungsi-fungsi kompleks ECDSA/SHA256 (precompiles) yang memiliki alamat statik `0x01.. 0x08` dll. Jangan over-ride storage area precompile tersebut agar eksekusi EVM kriptografi internal di `revm` tidak crash / korup.
