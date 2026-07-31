# eBPF TC Network Filters

## Konsep Utama
Traffic Control (TC) adalah subsistem jaringan Linux yang berada setelah XDP. Meskipun sedikit lebih lambat dari XDP (karena beroperasi pada `sk_buff` yang sudah teralokasi), TC mendukung egress (paket keluar) di mana XDP hanya mendukung ingress. TC juga memungkinkan injeksi, modifikasi struktur paket yang kompleks (mangling), dan redireksi.

## Arsitektur & Flow
```text
[ Local Application ]
      | (Egress TC eBPF Hook) <-- TC_ACT_OK / TC_ACT_SHOT
[ TCP/IP Stack ]
      | (Ingress TC eBPF Hook) <-- TC_ACT_OK / TC_ACT_SHOT
[ XDP Hook ] 
      |
[ Network Interface ]
```

## Production-Ready Code
*eBPF Program (`my-tc-ebpf/src/main.rs`):*
```rust
#![no_std]
#![no_main]

use aya_ebpf::{
    macros::classifier,
    programs::TcContext,
    bindings::TC_ACT_OK,
    bindings::TC_ACT_SHOT,
};
use network_types::{
    eth::{EthHdr, EtherType},
    ip::Ipv4Hdr,
    tcp::TcpHdr,
};

#[classifier]
pub fn tc_ingress(ctx: TcContext) -> i32 {
    match try_tc_ingress(ctx) {
        Ok(action) => action,
        Err(_) => TC_ACT_SHOT, // Drop packet jika error parsing
    }
}

fn try_tc_ingress(ctx: TcContext) -> Result<i32, ()> {
    // TC menggunakan load_bytes karena packet bisa saja non-linear (fragmented dalam sk_buff)
    let eth_len = core::mem::size_of::<EthHdr>();
    
    // Baca Ethernet header
    let eth_hdr = ctx.load::<EthHdr>(0).map_err(|_| ())?;
    if eth_hdr.ether_type != EtherType::Ipv4 {
        return Ok(TC_ACT_OK);
    }

    // Baca IPv4 header
    let ipv4_len = core::mem::size_of::<Ipv4Hdr>();
    let ipv4_hdr = ctx.load::<Ipv4Hdr>(eth_len).map_err(|_| ())?;
    
    // Pastikan ini adalah TCP
    if ipv4_hdr.protocol != 6 { // 6 is TCP
        return Ok(TC_ACT_OK);
    }

    let tcp_len = core::mem::size_of::<TcpHdr>();
    // Menentukan IP header length yang sebenarnya dari ihl (Header length in 32-bit words)
    let ip_hdr_size = (ipv4_hdr.ihl() * 4) as usize;
    let tcp_offset = eth_len + ip_hdr_size;

    // Baca TCP header
    let tcp_hdr = ctx.load::<TcpHdr>(tcp_offset).map_err(|_| ())?;
    
    let dest_port = u16::from_be(tcp_hdr.dest);
    
    // Misalnya, drop akses ke port spesifik (misal port 22 SSH) dari host nakal
    if dest_port == 22 {
        return Ok(TC_ACT_SHOT);
    }

    Ok(TC_ACT_OK)
}
```

## Anti-Patterns

1. **Akses Data Secara Pointer Langsung (`ctx.data()`) pada Paket Besar**
   - *Mengapa berbahaya:* Berbeda dengan XDP di mana seluruh frame jaringan berbentuk linear, pada hook TC struktur `sk_buff` (socket buffer) mungkin ter-fragment (paged). Mengakses langsung lewat `ptr_at` (seperti di XDP) bisa panik atau gagal diverifikasi kernel untuk payload setelah header.
   - *Solusi:* Gunakan fungsi helper bawaan context `bpf_skb_load_bytes` (di dalam macro aya-rs diabstraksi sebagai `ctx.load::<T>(offset)`).

2. **Lupa Memodifikasi Checksum Setelah Mangling**
   - *Mengapa berbahaya:* Jika Anda menggunakan TC eBPF untuk mengubah isi paket (misalnya NAT / modifikasi IP atau Port), mengubah bit pada data tanpa menghitung ulang L3/L4 checksum akan menyebabkan paket didrop oleh network stack OS tujuan.
   - *Solusi:* Gunakan fungsi `bpf_l3_csum_replace` dan `bpf_l4_csum_replace` untuk secara efisien mem-patch header checksum.

## Edge Cases & Defensive Programming
- **Header Length Berubah-ubah:** Header IPv4 memiliki opsi dinamis (variabel `ihl`). Jangan pernah berasumsi bahwa header IPv4 selalu persis 20 byte. Kalkulasikan ukuran absolut seperti `(ihl * 4)` untuk mencari offset L4 (TCP/UDP) secara presisi.
- **Hook Direction (Ingress/Egress):** Selalu pasang program classifier Anda pada direktif qdisc yang tepat dari userspace (misal `tc qdisc add dev eth0 clsact`). Jika Anda salah memasang program Egress ke interface Ingress, logika inspeksi flow-nya akan terbalik.
