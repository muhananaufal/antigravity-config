# eBPF XDP Programs in Pure Rust via Aya

## Konsep Utama & Arsitektur
XDP (eXpress Data Path) adalah framework di dalam kernel Linux yang memungkinkan pengeksekusian program BPF (Berkeley Packet Filter) dengan performa tinggi pada lapisan driver jaringan, sebelum paket dikelola oleh network stack utama OS. Melalui ekosistem `aya-rs`, kita dapat menulis program eBPF menggunakan Rust murni tanpa bergantung pada `clang` atau C.

Keunggulan XDP:
1. **Performa Ultra Cepat**: Program dijalankan langsung saat NIC (Network Interface Card) menerima paket (RX queue).
2. **Keamanan**: Dikompalasi dengan BPF verifier yang memastikan program tidak akan menyebabkan kernel panic atau infinite loop.
3. **Rust Toolchain**: Penggunaan `aya` memungkinkan kita menulis user-space dan kernel-space code menggunakan ekosistem Rust yang sama.

### Diagram Arsitektur: Kernel to User-space Flow
```text
[NIC Hardware]
      |
      v
[NIC Driver (RX Ring)] -> (XDP Hook Point)
      |                         |
      |                 [eBPF Rust Program]
      |                 - Parse Ethernet
      |                 - Parse IPv4
      |                 - Parse UDP
      |                         |
      v                         v
(Network Stack)        (BPF Map / HashMap)
      |                         |
      |                         v
[User-space App] <-------- [Aya User-space]
(e.g., Firewall)           - Read statistics
                           - Update rules
```

## Kode Produksi eBPF XDP
Kode di bawah ini merupakan program eBPF XDP sederhana yang menghitung jumlah paket UDP berdasarkan IP sumber menggunakan BPF HashMap.
*Catatan: Ini adalah bagian eBPF kernel-space (target `bpfel-unknown-none`).*

```rust
#![no_std]
#![no_main]

use aya_ebpf::{
    bindings::xdp_action,
    macros::{map, xdp},
    maps::HashMap,
    programs::XdpContext,
};
use core::mem;
use network_types::{
    eth::{EthHdr, EtherType},
    ip::{Ipv4Hdr, IpProto},
    udp::UdpHdr,
};

#[map]
static mut BLOCKLIST: HashMap<u32, u32> = HashMap::<u32, u32>::with_max_entries(1024, 0);

#[map]
static mut UDP_PACKET_COUNT: HashMap<u32, u64> = HashMap::<u32, u64>::with_max_entries(1024, 0);

#[xdp]
pub fn xdp_firewall(ctx: XdpContext) -> u32 {
    match try_xdp_firewall(ctx) {
        Ok(ret) => ret,
        Err(_) => xdp_action::XDP_ABORTED,
    }
}

#[inline(always)]
fn ptr_at<T>(ctx: &XdpContext, offset: usize) -> Result<*const T, ()> {
    let start = ctx.data();
    let end = ctx.data_end();
    let len = mem::size_of::<T>();

    if start + offset + len > end {
        return Err(());
    }
    Ok((start + offset) as *const T)
}

fn try_xdp_firewall(ctx: XdpContext) -> Result<u32, ()> {
    // Parse Ethernet Header
    let ethhdr: *const EthHdr = ptr_at(&ctx, 0)?;
    
    // Pastikan ini adalah paket IPv4
    if unsafe { (*ethhdr).ether_type } != EtherType::Ipv4 {
        return Ok(xdp_action::XDP_PASS);
    }

    // Parse IPv4 Header
    let ipv4hdr: *const Ipv4Hdr = ptr_at(&ctx, EthHdr::LEN)?;
    let source_ip = u32::from_be(unsafe { (*ipv4hdr).src_addr });

    // Cek blocklist
    let is_blocked = unsafe { BLOCKLIST.get(&source_ip) };
    if is_blocked.is_some() {
        return Ok(xdp_action::XDP_DROP);
    }

    // Hanya menghitung paket UDP
    if unsafe { (*ipv4hdr).protocol } != IpProto::Udp {
        return Ok(xdp_action::XDP_PASS);
    }

    // Parse UDP Header
    let _udphdr: *const UdpHdr = ptr_at(&ctx, EthHdr::LEN + Ipv4Hdr::LEN)?;

    // Update statistik
    let counter = unsafe { UDP_PACKET_COUNT.get(&source_ip) }.unwrap_or(&0);
    let new_count = *counter + 1;
    unsafe {
        let _ = UDP_PACKET_COUNT.insert(&source_ip, &new_count, 0);
    }

    Ok(xdp_action::XDP_PASS)
}

#[cfg(not(target_os = "bpf"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

## Anti-Patterns

### 1. Parsing Tanpa Boundary Check
**Penjelasan:** BPF verifier akan langsung menolak kode (reject) jika Anda mengakses memori tanpa memvalidasi apakah pointer `start + offset + len` kurang dari `data_end()`.
**Bahaya:** Ini akan memicu rejection saat program di-load ke kernel, menyebabkan aplikasi user-space crash saat inisialisasi.

```rust
// BURUK:
// let ethhdr = ctx.data() as *const EthHdr;
// if (*ethhdr).ether_type == ... // VERIFIER AKAN MARAH KARENA TIDAK ADA BOUND CHECK
```

### 2. Penggunaan Loop Tanpa Batas atau Fungsi Rekursif
**Penjelasan:** eBPF (terutama versi kernel yang lebih tua) tidak mendukung unbounded loops atau stack rekursi. Verifier harus bisa membuktikan bahwa program akan selesai (halt).
**Bahaya:** Program akan gagal diverifikasi. Gunakan `#pragma unroll` pada C, atau loop dengan iterasi konstan maksimum yang kecil di Rust.

## Edge Cases & Defensive Programming

1. **Stack Size Limit 512 Bytes**:
   eBPF stack sangat terbatas (512 bytes). Anda tidak bisa mengalokasikan array besar di stack. Solusi: Gunakan PerCpuArray dari BPF Maps atau variabel lokal yang kecil. Selalu pastikan ukuran struct header (EthHdr, Ipv4Hdr) efisien.
2. **VLAN Tagging & Offset Shifting**:
   Paket Ethernet di alam liar mungkin memiliki header 802.1Q (VLAN tag) (EtherType::Vlan). Jika Anda mengasumsikan Ipv4Hdr selalu tepat setelah EthHdr, Anda akan parsing garbage data. Program produksi harus mengecek EtherType::Vlan dan menggeser pointer `offset` sebanyak 4 bytes.
3. **Concurreny & Map Updates**:
   Saat meng-update `UDP_PACKET_COUNT`, jika Anda tidak menggunakan *atomic operations* (`sync_fetch_and_add` ekuivalen pada BPF), data counter dari paket yang datang bersamaan di core CPU berbeda bisa corrupt. Menggunakan `PerCpuHashMap` jauh lebih aman dibandingkan `HashMap` standar untuk penghitungan data intensif.
