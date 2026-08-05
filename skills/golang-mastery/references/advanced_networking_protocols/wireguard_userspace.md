# WireGuard Userspace (wireguard-go) Implementation

> **Berlaku:** Go 1.21+ · `wireguard-go` · **Lihat juga:** `advanced_networking_protocols/network_proxy_socks5.md` · `security_owasp/mtls_certificate_rotation.md` · `cybersecurity_zerotrust/spiffe_spire_workload.md` · `cybersecurity_zerotrust/network_security_scanning.md`

## 1. Konsep Utama & Internals

WireGuard menggunakan **Noise Protocol Framework (IKpsk2 variant)** — handshake 1.5-RTT yang jauh lebih simpel dibanding TLS:

```
Noise_IKpsk2 Handshake (WireGuard):

  Initiator                          Responder
      │                                  │
      │─── Initiation Message ──────────►│
      │    (Ephemeral DH public key,     │
      │     encrypted static key,        │
      │     timestamp anti-replay)       │
      │                                  │
      │◄── Response Message ─────────────│
      │    (Ephemeral DH public key,     │
      │     empty encrypted payload)     │
      │                                  │
      │══ Data Messages (ChaCha20Poly1305) ══│

Cryptographic primitives:
  Key Exchange: Curve25519 (ECDH)
  Symmetric Cipher: ChaCha20-Poly1305 (AEAD)
  Hash: BLAKE2s
  MAC: HMAC-BLAKE2s
  Replay Protection: sliding window counter (64-bit)

WireGuard Userspace vs Kernel:
  Kernel (wg-quick):  > 2 Gbps, crypto offload ke CPU, no context switch
  Userspace (wg-go):  ~ 500 Mbps, pure Go goroutines, runs without CAP_NET_ADMIN
  Use cases for userspace:
    - Tailscale agent (macOS/Windows/Android embedded)
    - K8s pods without privileged mode
    - NAT traversal client (not high-throughput server)

IPC UAPI (UserSpace API):
  wg setconf wg0 /dev/stdin <<EOF
  private_key=<hex-encoded-32-byte-key>
  listen_port=51820
  [Peer]
  public_key=<hex-encoded-peer-pubkey>
  allowed_ips=10.0.0.2/32
  endpoint=203.0.113.1:51820
  EOF
  → Go: wgDevice.IpcSet(configString)
```

## 2. Diagram Arsitektur / Aliran (ASCII)
```text
  [Aplikasi Biasa (TCP/HTTP)]
              |
              v (Virtual TUN Device / gVisor Netstack)
 ==========================================
 |   Go Userspace Process (wireguard-go)  |
 |    - Routing (AllowedIPs)              |
 |    - Enkripsi ChaCha20-Poly1305        |
 |    - Rekapitulasi (UDP Encapsulation)  |
 ==========================================
              |
              v (UDP Socket Port 51820)
       [Internet Publik]
              |
              v (UDP Socket)
     [WireGuard Kernel (Server)]
```

## 3. Production-Ready Go Code

Implementasi dasar yang men-deploy *userspace wireguard interface* (TUN device) dan mengkonfigurasi rute (Routing) secara dinamis menggunakan IPC UAPI Wireguard.

```go
package wgnet

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/ipc"
	"golang.zx2c4.com/wireguard/tun"
)

// StartWireguardUserspace menginisiasi tun device dan instance WG
func StartWireguardUserspace(ctx context.Context, ifaceName string, port int, privateKeyHex string) (*device.Device, error) {
	// 1. Buat virtual TUN device di userspace
	tunDev, err := tun.CreateTUN(ifaceName, device.DefaultMTU)
	if err != nil {
		return nil, fmt.Errorf("failed to create TUN device: %w", err)
	}

	// 2. Inisiasi instance perangkat WireGuard Go
	logger := device.NewLogger(
		device.LogLevelError,
		fmt.Sprintf("(%s) ", ifaceName),
	)
	
	// Gunakan bind networking default 
	wgDevice := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)

	// 3. Setup UAPI IPC socket agar kita dapat mengirim string konfigurasi
	// (misal via perintah `wg setconf`)
	fileUAPI, err := ipc.UAPIOpen(ifaceName)
	if err != nil {
		wgDevice.Close()
		return nil, fmt.Errorf("UAPI open failed: %w", err)
	}

	uapiListener, err := ipc.UAPIListen(ifaceName, fileUAPI)
	if err != nil {
		wgDevice.Close()
		return nil, fmt.Errorf("UAPI listen failed: %w", err)
	}

	// Tangani koneksi ipc background
	go func() {
		for {
			uapiConn, err := uapiListener.Accept()
			if err != nil {
				return
			}
			go wgDevice.IpcHandle(uapiConn)
		}
	}()

	// Graceful shutdown
	go func() {
		<-ctx.Done()
		_ = uapiListener.Close()
		wgDevice.Close()
	}()

	// 4. Injeksi Private Key dan Setup Peer Konfigurasi WG via string IPC (UAPI format)
	// Catatan: Key WG di-format dalam hexadecimal atau base64 bergantung uapi format
	err = wgDevice.IpcSet(fmt.Sprintf(
		"private_key=%s\nlisten_port=%d\n",
		privateKeyHex, port,
	))
	if err != nil {
		return nil, fmt.Errorf("failed to apply IPC config: %w", err)
	}

	// 5. (Khusus Linux) - Diperlukan perintah 'ip addr add' & 'ip link set up'
	// pada interface TUN yang terbentuk dari luar proses ini atau dieksekusi via exec.Command()
	
	if err := wgDevice.Up(); err != nil {
		return nil, fmt.Errorf("failed to bring device UP: %w", err)
	}

	return wgDevice, nil
}

// IpcConfigBuilder membangun UAPI config string secara type-safe.
type IpcConfigBuilder struct {
	lines []string
}

func NewIpcConfig() *IpcConfigBuilder {
	return &IpcConfigBuilder{}
}

func (b *IpcConfigBuilder) PrivateKey(hexKey string) *IpcConfigBuilder {
	b.lines = append(b.lines, "private_key="+hexKey)
	return b
}

func (b *IpcConfigBuilder) ListenPort(port int) *IpcConfigBuilder {
	b.lines = append(b.lines, fmt.Sprintf("listen_port=%d", port))
	return b
}

func (b *IpcConfigBuilder) AddPeer(pubKeyHex, allowedIPs, endpoint string) *IpcConfigBuilder {
	b.lines = append(b.lines,
		"public_key="+pubKeyHex,
		"allowed_ips="+allowedIPs,
	)
	if endpoint != "" {
		b.lines = append(b.lines, "endpoint="+endpoint)
	}
	return b
}

func (b *IpcConfigBuilder) Build() string {
	return strings.Join(b.lines, "\n") + "\n"
}

// ValidateWGPrivateKey memastikan private key WireGuard valid:
// harus 64 karakter hex (32 bytes raw).
func ValidateWGPrivateKey(hexKey string) error {
	if len(hexKey) != 64 {
		return fmt.Errorf("invalid WireGuard private key: must be 64 hex chars (32 bytes), got %d chars", len(hexKey))
	}
	_, err := hex.DecodeString(hexKey)
	if err != nil {
		return fmt.Errorf("invalid WireGuard private key: not valid hex: %w", err)
	}
	return nil
}

// --- Unit Tests ---

func TestValidateWGPrivateKey_Valid(t *testing.T) {
	validKey := strings.Repeat("0", 64) // 64 hex chars = 32 bytes
	if err := ValidateWGPrivateKey(validKey); err != nil {
		t.Errorf("valid key rejected: %v", err)
	}
}

func TestValidateWGPrivateKey_TooShort(t *testing.T) {
	_, err := hex.DecodeString("too-short")
	// Trigger: key terlalu pendek
	if err := ValidateWGPrivateKey("abcd1234"); err == nil {
		t.Error("short key should be rejected")
	}
}

func TestValidateWGPrivateKey_InvalidHex(t *testing.T) {
	invalidHex := strings.Repeat("z", 64) // 'z' bukan hex
	if err := ValidateWGPrivateKey(invalidHex); err == nil {
		t.Error("non-hex key should be rejected")
	}
}

func TestIpcConfigBuilder_Build(t *testing.T) {
	privKey := strings.Repeat("0", 64)
	pubKey := strings.Repeat("a", 64)

	cfg := NewIpcConfig().
		PrivateKey(privKey).
		ListenPort(51820).
		AddPeer(pubKey, "10.0.0.2/32", "203.0.113.1:51820").
		Build()

	if !strings.Contains(cfg, "private_key="+privKey) {
		t.Error("config missing private_key")
	}
	if !strings.Contains(cfg, "listen_port=51820") {
		t.Error("config missing listen_port")
	}
	if !strings.Contains(cfg, "allowed_ips=10.0.0.2/32") {
		t.Error("config missing allowed_ips")
	}
	if !strings.HasSuffix(cfg, "\n") {
		t.Error("UAPI config must end with newline")
	}
}

func TestWireguardInstance(t *testing.T) {
	// Tes ini mewajibkan root/CAP_NET_ADMIN (karena membuat tun/tap dev lokal)
	if os.Getuid() != 0 {
		t.Skip("Skipping wg-userspace test, requires root privileges")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	dummyPrivKeyHex := strings.Repeat("01", 32) // 64 hex chars

	dev, err := StartWireguardUserspace(ctx, "wg_test0", 51821, dummyPrivKeyHex)
	if err != nil {
		t.Fatalf("Start err: %v", err)
	}
	defer dev.Close()
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Private Key di Memori yang Mudah Di-Dump
Dalam aplikasi *userspace*, konfigurasi IpcSet menerima kunci. Banyak aplikasi meng-hardcode private key WG, atau menyimpannya dalam string global, di mana memori *heap* Golang tidak membersihkannya secara deterministik.
```go
// ❌ BAD: Membiarkan kunci diam di memory terbuka
var GlobalKey string = "a-very-secret-base64-key"
wg.IpcSet("private_key=" + GlobalKey + "\n")
```
**Why dangerous:** Jika penyerang mendapat hak akses baca memori dari container aplikasi (via *memory dump* atau celah eksploit log), *Private Key Curve25519* bisa dicuri. Akses ke VPN dan kredensial kriptografis kompromi total.

```go
// ✅ GOOD: Timpa memori dengan nol (Zeroing) setelah dipakai jika menggunakan byte array
// Di Golang standar (bukan Cgo) hal ini tricky karena garbage collector. 
// Namun kita dapat membatasi lifetime string:
func configWG() {
    b := fetchKeyFromVaultSecurely() 
    wg.IpcSet(fmt.Sprintf("private_key=%x", b))
    // Hapus slice byte dari memori segera (best effort di pure Go)
    for i := range b { b[i] = 0 }
}
```

### ❌ Anti-Pattern 2: Berasumsi Userspace WG Setara dengan Kernel
Banyak engineer men-deploy `wireguard-go` untuk trafik 10 Gbps antar layanan (*Service Mesh*).
```yaml
// ❌ BAD: Menggunakan userspace wg di K8s untuk bandwidth throughput raksasa.
```
**Why dangerous:** Implementasi *userspace* melewati (bypass) banyak alur lambat di context-switching Linux. Goroutine kriptografi (`ChaCha20`) akan menggunakan 100% CPU user Go hanya untuk enkripsi payload TCP, mengorbankan CPU dari aplikasi utama Anda. Max throughput *userspace WG* di Go biasanya macet di angka ~500 Mbps, jauh dibanding WG Kernel (2-3 Gbps).

```go
// ✅ GOOD: Gunakan wg-userspace HANYA untuk:
// 1. Klien Remote (Laptop/Mobile Device), e.g. Tailscale
// 2. NAT Traversal Endpoint lambat (Bastion host API)
// Untuk throughput tinggi Backend-to-Backend, gunakan in-kernel module (wg-quick).
```

## 5. Edge Cases & Defensive Programming

1. **MTU Path Mismatch & UDP Fragmentation**: Paket TCP yang berjalan dalam *tunnel* WG di-enkapsulasi dalam paket UDP berenkripsi (overhead ~60 bytes). Jika Interface WAN MTU 1500, set MTU TUN interface di `1420` (atau lebih rendah untuk seluler `1280`). MTU terlalu besar → middleboxes drop fragmen UDP → TLS handshake via WG putus secara tak wajar (ICMP blackhole).
2. **FD Leak pada TUN Device:** Jika aplikasi Go mati mendadak tanpa `dev.Close()`, file descriptor `/dev/net/tun` bisa stuck sebagai zombie interface. Restart berikutnya gagal create `wg0` (*File exists*). Pasang signal trap OS (`signal.Notify`) + context cancellation untuk selalu ensure `Close()` terpanggil gracefully.
3. **Endpoint Roaming NAT:** WG stateless — jika IP peer berubah (pindah koneksi seluler), traffic drop tanpa error. Aktifkan `PersistentKeepalive = 25` seconds di peer config agar NAT mapping dipertahankan oleh ISP router.
4. **Key Rotation tanpa Downtime:** WireGuard mendukung `preshared_key` per-peer sebagai tambahan lapisan keamanan (post-quantum resistance layer). Saat rotate private key, urutan: generate key baru, update UAPI config dengan key baru, update `public_key` di semua peers — lakukan secara koordinasi agar tidak ada window dimana handshake gagal karena peer masih kenal key lama.
5. **Replay Attack Window:** WireGuard menggunakan sliding window counter untuk mencegah replay attack. Window default 2000ms. Jika ada clock skew besar antara initiator dan responder (> 180 detik), handshake akan ditolak (`timestamp out of range`). Pastikan NTP sinkron di semua node WireGuard.

## Kapan JANGAN Pakai Ini

- **Implementasi userspace bila modul kernel tersedia.** Selisih kinerjanya besar — beberapa kali lipat pada throughput tinggi. Userspace masuk akal untuk portabilitas dan lingkungan tanpa akses kernel, bukan sebagai pilihan bawaan.
- **Kunci yang tidak pernah dirotasi dan tidak bisa dicabut.** Peer yang perangkatnya hilang tetap bisa masuk sampai kuncinya dihapus manual dari setiap peer lain. Rencanakan mekanisme pencabutan sebelum membutuhkannya.
- **`AllowedIPs` yang terlalu luas.** Di WireGuard, `AllowedIPs` adalah **kontrol routing sekaligus otorisasi**. `0.0.0.0/0` pada satu peer berarti peer itu boleh mengaku sebagai alamat mana pun.
- **WireGuard sebagai pengganti otorisasi aplikasi.** Ia membuktikan bahwa lalu lintas berasal dari peer yang memegang kunci. Apa yang boleh dilakukan peer itu tetap urusan aplikasi.
- **Tanpa memperhitungkan MTU.** Enkapsulasi mengurangi MTU efektif. Tanpa penyesuaian, paket besar terfragmentasi atau hilang, dan gejalanya berupa "koneksi bekerja tapi transfer besar gagal" — salah satu masalah jaringan yang paling membingungkan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Koneksi terbentuk tapi transfer besar gagal | MTU pada antarmuka | Fragmentasi akibat enkapsulasi |
| Throughput jauh di bawah harapan | userspace vs kernel | Implementasi userspace pada beban tinggi |
| Peer yang sudah tidak dipakai masih terhubung | daftar peer dan rotasi kunci | Tidak ada pencabutan |
| Peer bisa menjangkau lebih dari seharusnya | `AllowedIPs` per peer | Otorisasi routing terlalu luas |
| Handshake berulang terus | NAT keepalive | Sesi NAT kedaluwarsa di antara handshake |

```bash
# Peer, handshake terakhir, dan AllowedIPs -- ketiganya menjawab sebagian besar masalah
wg show
wg show wg0 allowed-ips
wg show wg0 latest-handshakes

# MTU: sumber "koneksi bekerja tapi transfer besar gagal"
ip link show wg0 | grep -o 'mtu [0-9]*'
ping -M do -s 1372 -c 3 10.8.0.2     # cari ukuran terbesar yang lolos tanpa fragmentasi

# Peer yang sudah lama tidak melakukan handshake: kandidat dicabut
wg show wg0 latest-handshakes | awk '$2 == 0 || $2 < '"$(( $(date +%s) - 86400 ))"''
```
