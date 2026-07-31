# Aya eBPF XDP Programs

## Konsep Utama
XDP (eXpress Data Path) adalah hook eBPF yang berjalan di kernel driver jaringan (sebelum `sk_buff` dialokasikan). Ini menjadikannya sangat cepat untuk packet filtering, DDoS protection, dan load balancing. `aya-rs` memungkinkan kita menulis dan meload program eBPF menggunakan Rust murni dengan ekosistem `cargo` konvensional.

## Arsitektur & Flow
```text
[ Network Interface Card ] ---> [ XDP Hook (eBPF in Kernel) ] --- Drop (TC_ACT_SHOT) ---> (Packet Dropped)
                                      |
                                      +--- Pass (TC_ACT_OK) ---> [ Linux TCP/IP Stack ] ---> [ User Space ]
```

## Production-Ready Code
*eBPF Program (`my-xdp-ebpf/src/main.rs`):*
```rust
#![no_std]
#![no_main]

use aya_ebpf::{
    bindings::xdp_action,
    macros::{map, xdp},
    maps::HashMap,
    programs::XdpContext,
};
use network_types::{
    eth::{EthHdr, EtherType},
    ip::Ipv4Hdr,
};

#[map]
static BLOCKLIST: HashMap<u32, u8> = HashMap::with_max_entries(1024, 0);

#[xdp]
pub fn my_xdp(ctx: XdpContext) -> u32 {
    match try_my_xdp(ctx) {
        Ok(ret) => ret,
        Err(_) => xdp_action::XDP_ABORTED,
    }
}

fn try_my_xdp(ctx: XdpContext) -> Result<u32, ()> {
    // Membaca packet memory boundaries
    let data = ctx.data();
    let data_end = ctx.data_end();

    let eth_hdr = ptr_at::<EthHdr>(&ctx, data)?;
    
    // Hanya proses IPv4
    if eth_hdr.ether_type != EtherType::Ipv4 {
        return Ok(xdp_action::XDP_PASS);
    }

    let eth_len = core::mem::size_of::<EthHdr>();
    let ipv4_hdr = ptr_at::<Ipv4Hdr>(&ctx, data + eth_len)?;

    let src_ip = u32::from_be(ipv4_hdr.src_addr);

    // Cek apakah IP ada di blocklist map
    if unsafe { BLOCKLIST.get(&src_ip) }.is_some() {
        // Drop the packet directly in kernel
        return Ok(xdp_action::XDP_DROP);
    }

    Ok(xdp_action::XDP_PASS)
}

#[inline(always)]
fn ptr_at<T>(ctx: &XdpContext, offset: usize) -> Result<*const T, ()> {
    let start = ctx.data();
    let end = ctx.data_end();
    let len = core::mem::size_of::<T>();

    if start + offset + len > end {
        return Err(());
    }

    Ok((start + offset) as *const T)
}
```

## Anti-Patterns

1. **Unbounded Loops**
   - *Mengapa berbahaya:* Kernel eBPF verifier (bpf-verifier) akan menolak program yang memiliki loop tak terbatas atau berpotensi melampaui kompleksitas eksekusi maksimal.
   - *Solusi:* Gunakan loop unrolling di Rust atau `#![feature(const_for)]`. Batasi iterasi loop dengan konstanta literal.

2. **Akses Memori Tanpa Bound Checks**
   - *Mengapa berbahaya:* Kernel *memaksa* verifikasi bahwa semua pointer dereference di-bounds-check terhadap `data_end()`. Gagal melakukannya menyebabkan program ditolak saat load (verifier error).
   - *Solusi:* Selalu gunakan helper pattern seperti `ptr_at` di atas untuk memastikan verifikasi panjang memori sebelum membaca header.

## Edge Cases & Defensive Programming
- **Byte Order:** Payload jaringan adalah Network Endian (Big Endian). XDP membaca bytes mentah. Harus secara eksplisit melakukan konversi ke arsitektur endian host (misal `u32::from_be`) saat membandingkan IP atau port dengan data di BPF Maps.
- **Map Alignment:** Pastikan struct custom yang dijadikan value di BPF Map direpresentasikan dengan `#[repr(C)]` atau diletakkan sejajar (aligned), karena memori padangan bisa memicu uninitialized memory read errors di verifier kernel.
