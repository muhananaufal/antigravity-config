# CosmWasm Contract Dev

## Konsep Utama
CosmWasm (Cosmos WebAssembly) adalah engine smart contract lintas jaringan (Interchain) yang berbasis Wasm. Uniknya, di ekosistem Cosmos, Wasm terisolasi sempurna dengan arsitektur Actor Model; *Contract* tidak pernah bisa secara langsung memutasi status Contract lain. Semua komunikasi bersifat pesan asinkron (`SubMsg` & `Reply`), menjadikannya sangat tahan terhadap serangan *Re-entrancy* yang lazim di EVM.

## Arsitektur & Flow
```ascii
[ Client Transaction ]
          |
[ Cosmos SDK BaseApp ]
          |
    [ x/wasm Module ] -> (Wasm VM Instance)
          |
    [ Contract Entry Point: `instantiate`, `execute`, `query` ]
          |
[ Env/DepsMut (Storage Mutate) ] --> (Return Response/CosmosMsg)
```

## Production-Ready Code
```rust
use cosmwasm_std::{
    entry_point, to_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdError, StdResult,
};
use cw_storage_plus::Item;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct InstantiateMsg {
    pub count: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum ExecuteMsg {
    Increment {},
    Reset { count: i32 },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct State {
    pub count: i32,
    pub owner: String,
}

const STATE: Item<State> = Item::new("state");

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> StdResult<Response> {
    let state = State {
        count: msg.count,
        owner: info.sender.into_string(),
    };
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_attribute("method", "instantiate")
        .add_attribute("owner", state.owner)
        .add_attribute("count", msg.count.to_string()))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, StdError> {
    match msg {
        ExecuteMsg::Increment {} => try_increment(deps),
        ExecuteMsg::Reset { count } => try_reset(deps, info, count),
    }
}

fn try_increment(deps: DepsMut) -> Result<Response, StdError> {
    STATE.update(deps.storage, |mut state| -> StdResult<_> {
        state.count += 1;
        Ok(state)
    })?;

    Ok(Response::new().add_attribute("method", "try_increment"))
}

fn try_reset(deps: DepsMut, info: MessageInfo, count: i32) -> Result<Response, StdError> {
    let state = STATE.load(deps.storage)?;
    if state.owner != info.sender.as_str() {
        return Err(StdError::generic_err("Unauthorized"));
    }
    
    STATE.update(deps.storage, |mut state| -> StdResult<_> {
        state.count = count;
        Ok(state)
    })?;
    
    Ok(Response::new().add_attribute("method", "reset"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};

    #[test]
    fn test_initialization_and_increment() {
        let mut deps = mock_dependencies();
        
        let msg = InstantiateMsg { count: 17 };
        let info = mock_info("creator", &[]);
        
        // Setup
        let res = instantiate(deps.as_mut(), mock_env(), info.clone(), msg).unwrap();
        assert_eq!(0, res.messages.len());

        // Test Execute
        let msg_exec = ExecuteMsg::Increment {};
        let _ = execute(deps.as_mut(), mock_env(), info, msg_exec).unwrap();
        
        let loaded = STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(loaded.count, 18);
    }
}
```

## Anti-Patterns
1. **Iterasi Global Array yang Disimpan di State**: 
   *Mengapa Berbahaya:* Sama seperti Substrate, operasi database (RocksDB) di CosmWasm (menyimpan struct list/vector besar di `Item`) sangat boros *Gas*. Menyimpan state sebagai satu vektor raksasa akan berujung Gas Limit exceeded saat vektor bertambah (Unbounded growth). Gunakan pola `Map` (`cw_storage_plus::Map`).
2. **Panic secara eksplisit (unwrap)**:
   *Mengapa Berbahaya:* Jika kontrak panik di tengah jalan (`unwrap` pada `None`), Gas akan terbakar hangus tanpa feedback message yang memadai. Selalu kembalikan enum variant `ContractError` via `Result<Response, ContractError>`.

## Edge Cases & Defensive Programming
- **Batas Reentrancy dan Reply Handler**: Jika Anda perlu memanggil kontrak C dari B, Anda akan mengekspos tipe objek `WasmMsg::Execute` dan menyertakannya di respons (Return). Anda HARUS menggunakan struktur `SubMsg` beserta field `reply_on` (Misal: *ReplyOn::Success*) jika Anda harus merekam state sukses pemanggilan ke database C.
- **Validasi Alamat (Addr)**: Jangan pernah menyimpan tipe mentah `String` untuk alamat yang diproses tanpa memanggil `.validate()` ke API module `deps.api.addr_validate(&string)`. Data input jahat (malicious format) akan merusak logika dependensi yang membutuhkan validitas struktur kunci alamat Cosmos.
