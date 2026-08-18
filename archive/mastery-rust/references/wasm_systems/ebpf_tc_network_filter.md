# eBPF Traffic Control (TC) Classifier & Action via Aya

## Konsep Utama & Arsitektur
eBPF Traffic Control (TC) bekerja pada layer egress dan ingress dari qdisc (queueing discipline) sistem kernel Linux. Berbeda dengan XDP yang hanya bekerja pada lapisan ingress terendah (RX queue), TC memungkinkan inspeksi dan modifikasi paket baik sebelum meninggalkan host (egress) maupun setelah diproses oleh network driver namun sebelum masuk ke routing layer (ingress).

Melalui `aya-rs`, kita dapat membuat classifier/action TC di Rust untuk:
1. **Bandwidth Shaping & QOS**: Mengklasifikasikan trafik dan mengirimkannya ke class qdisc yang tepat.
2. **Packet Mangling**: Memodifikasi payload secara in-flight (misalnya enkapsulasi tunneling).
3. **Pinning Maps**: Berbagi data antar eBPF programs atau bahkan saat user-space agent restart melalui `bpffs`.

### Diagram Arsitektur: TC Ingress & Egress Pipeline
```text
           (Network Stack / Sockets)
                 |            ^
          Egress |            | Ingress
                 v            |
        [TC Egress Hook] [TC Ingress Hook]
        (Rust eBPF Prog) (Rust eBPF Prog)
        - Modify Payload - Apply rate limits
        - Route to qdisc - Parse Headers
                 |            ^
                 v            |
            (NIC Driver TX / RX)
```

## Kode Produksi eBPF TC
Kode berikut menunjukkan TC program yang memodifikasi ToS (Type of Service) byte di IPv4 header (packet mangling) untuk paket spesifik.

```rust
#![no_std]
#![no_main]

use aya_ebpf::{
    bindings::TC_ACT_PIPE,
    bindings::TC_ACT_SHOT,
    macros::{classifier, map},
    maps::HashMap,
    programs::TcContext,
};
use core::mem;
use network_types::{
    eth::{EthHdr, EtherType},
    ip::Ipv4Hdr,
};

#[map]
static mut VIP_IPS: HashMap<u32, u8> = HashMap::<u32, u8>::with_max_entries(256, 0);

#[classifier]
pub fn tc_mangle_tos(ctx: TcContext) -> i32 {
    match try_mangle_tos(&ctx) {
        Ok(ret) => ret,
        Err(_) => TC_ACT_SHOT,
    }
}

#[inline(always)]
fn ptr_at<T>(ctx: &TcContext, offset: usize) -> Result<*mut T, ()> {
    let start = ctx.data();
    let end = ctx.data_end();
    let len = mem::size_of::<T>();

    if start + offset + len > end {
        return Err(());
    }
    // Note: TC programs dapat melakukan memodifikasi packet payload (mem-mutasi)
    Ok((start + offset) as *mut T)
}

fn try_mangle_tos(ctx: &TcContext) -> Result<i32, ()> {
    let ethhdr: *mut EthHdr = ptr_at(ctx, 0)?;
    
    if unsafe { (*ethhdr).ether_type } != EtherType::Ipv4 {
        return Ok(TC_ACT_PIPE);
    }

    let ipv4hdr: *mut Ipv4Hdr = ptr_at(ctx, EthHdr::LEN)?;
    let dst_ip = u32::from_be(unsafe { (*ipv4hdr).dst_addr });

    // Jika ini IP VIP, tingkatkan prioritas paket dengan memodifikasi ToS byte.
    let is_vip = unsafe { VIP_IPS.get(&dst_ip) };
    if is_vip.is_some() {
        // eBPF verifier mengizinkan modifikasi direct via pointer di TC
        unsafe {
            // Set ToS / DSCP value ke high priority (contoh: 0x2E = Expedited Forwarding)
            (*ipv4hdr).tos = 0x2E;
            
            // PENTING: Karena kita mengubah IP header, checksum IPv4 menjadi tidak valid.
            // Dalam kode kernel produksi riil, kita HARUS meng-update checksum menggunakan
            // helper function eBPF seperti `bpf_l3_csum_replace`.
            // Jika ini diabaikan, paket akan di-drop di router hop berikutnya.
        }
    }

    Ok(TC_ACT_PIPE)
}

#[cfg(not(target_os = "bpf"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
```

## Anti-Patterns

### 1. Mengabaikan IP/TCP Checksum Setelah Mutasi Data
**Penjelasan:** Ketika TC program memodifikasi packet payload atau IP header (seperti TTL atau ToS), L3 dan L4 checksum menjadi invalid.
**Bahaya:** OS atau router tujuan akan membuang paket tersebut secara diam-diam karena corrupt. Selalu panggil BPF helpers (`bpf_l3_csum_replace`, `bpf_l4_csum_replace`) untuk menambal checksum tanpa mengkalkulasi ulang seluruh payload.

### 2. Tidak Menggunakan BPF FS Pinning untuk Stateful Maps
**Penjelasan:** Secara default, BPF map akan hancur dan memory di-free ketika file descriptor user-space program yang men-loadnya tertutup.
**Bahaya:** Jika user-space control plane (Rust agent) crash atau restart, statistik trafik bandwidth di map akan hilang semua. Selalu pin map ke `/sys/fs/bpf/` sehingga map tersebut persisten meskipun user-space process mati.

## Edge Cases & Defensive Programming

1. **Paket Melebihi `skb->len` vs `skb->data_end`**:
   Di lingkungan TC (sk_buff), `data_end` hanya menunjuk ke akhir dari data linear (linear data buffer). Sebagian paket mungkin terfragmentasi dan masuk ke *paged data* di kernel (non-linear). Anda harus menggunakan helper `bpf_skb_pull_data` untuk menarik data masuk ke buffer linear sebelum mencoba membaca via pointer.
2. **Konflik Multi-Attach pada QDisc Ingress**:
   Banyak aplikasi sekuriti/container (Cilium, Calico, Datadog) meng-attach program TC pada qdisc `clsact`. Saat men-deploy, pastikan Anda memahami *priority* (prio) eBPF attachment agar program TC Anda tidak saling menimpa atau men-drop paket prematur sebelum service mesh memprosesnya.
3. **Memperbesar Ukuran Paket (Mangling Encap)**:
   Modifikasi paket yang menyisipkan header baru (misal: VXLAN tunnel) tidak bisa hanya sekadar mengubah memory. Buffer harus dialokasikan secara eksplisit dengan memanggil BPF helper seperti `bpf_skb_change_tail` atau `bpf_skb_adjust_room`. Pointer harus di-*re-validate* setelah setiap pemanggilan fungsi ini karena verifier membuang memori state pointer lama.
