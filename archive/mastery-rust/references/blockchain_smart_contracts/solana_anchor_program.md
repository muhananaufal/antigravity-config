# Anchor Solana Smart Contracts

## Konsep Utama
Anchor adalah kerangka kerja ekosistem Solana yang bertindak mirip "Ruby on Rails" untuk rust-based smart contracts. Menggantikan proses serialisasi manual dan pengecekan keamanan yang rawan kesalahan dalam vanilla Solana SDK. Lewat set instruksi macros `#[program]` dan `#[derive(Accounts)]`, ia mengatur serialisasi Borsh, rent-exemption, CPI invocations, dan pengikatan struct (PDA derivations) demi ketahanan keamanan yang tinggi.

## Arsitektur & Flow
```ascii
  [ Client (JS/TS Web3) ]
           |
   (Borsh Serialized Payload)
           |
  [ Solana BPF Runtime (SVM) ]
           |
[ Anchor Dispatcher #[program] ] --> [ Context<Accounts> Valdiation ]
                                           |
                                [ Execution Logic ]
                                           |
                                [ State Write (Accounts) ]
```

## Production-Ready Code
```rust
use anchor_lang::prelude::*;

// Note: ID yang riil perlu digenerate lewat CLI Anchor.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod counter_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        counter.authority = ctx.accounts.user.key();
        Ok(())
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        
        // Manual constraint check untuk security (atau bisa di-macro)
        require_keys_eq!(counter.authority, ctx.accounts.user.key(), ErrorCode::Unauthorized);
        
        counter.count = counter.count.checked_add(1).unwrap();
        Ok(())
    }
}

// Validasi Akun & Konteks Keamanan
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init, 
        payer = user, 
        space = 8 + 8 + 32, // Discriminator + u64 + Pubkey
        seeds = [b"counter", user.key().as_ref()], 
        bump
    )]
    pub counter: Account<'info, CounterState>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(
        mut,
        seeds = [b"counter", user.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, CounterState>,
    pub user: Signer<'info>,
}

#[account]
pub struct CounterState {
    pub count: u64,
    pub authority: Pubkey,
}

#[error_code]
pub enum ErrorCode {
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_counter_logic() {
        let mut state = CounterState { count: 0, authority: Pubkey::new_unique() };
        state.count = state.count.checked_add(1).unwrap();
        assert_eq!(state.count, 1);
    }
}
```

## Anti-Patterns
1. **Tidak memvalidasi `AccountInfo::owner` atau tipe Akun**: 
   *Mengapa Berbahaya:* Jika tidak memakai tipe `Account<'info, T>` di Anchor (yang secara otomatis memverifikasi tag discriminator Borsh) dan mem-bypass dengan `AccountInfo`, peretas bisa melempar payload token-palsu. Aplikasi akan mentransfer dana di akun salah.
2. **Kalkulasi tanpa `checked_add` / `checked_sub`**:
   *Mengapa Berbahaya:* Di rust biasa, overflow mem-panic program (saat debug). Namun di blockchain, overflow (misal angka dana turun di bawah nol) bisa wrap-around ke nilai integer tertinggi, membiarkan orang mencetak token tanpa batas. 

## Edge Cases & Defensive Programming
- **Rent Exemption Space Calc**: Saat inisialisasi (`init`), hitungan byte `space` mutlak diawali padding `8` byte untuk instruksi unik Anchor (discriminator hash). Melupakan angka `8` ini membuat alokasi terpotong, state akan terkorupsi saat serialisasi write.
- **Close Account Pattern**: Selalu terapkan pola refund lamport (`close = target`) bila menghapus akun PDA statik. Jika saldo tidak di nol-kan, memori akun tersebut selamanya "menghantui" layer memori cluster dengan garbage data (state bloat).
