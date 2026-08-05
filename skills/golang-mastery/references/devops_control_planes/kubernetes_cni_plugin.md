# Kubernetes CNI Plugin Architecture

> **Berlaku:** Go 1.21+ · CNI spec 1.0 · **Lihat juga:** `system_programming_linux/cgroups_v2_namespaces.md` · `system_programming_linux/unix_domain_socket.md` · `cybersecurity_zerotrust/network_security_scanning.md` · `devops_control_planes/docker_container_go.md`

## Konsep Utama
Dalam ekosistem *Cloud Native*, Kubernetes tidak mengelola jaringan kontainer (IP, routing, interface veth) secara mandiri. Ia melegasikan tugas ini pada **Container Network Interface (CNI)**. CNI adalah spesifikasi standar dan seperangkat kakas (*tooling*) yang mengatur pemetaan jaringan Linux.

Ketika sebuah *Pod* dijadwalkan ke suatu Node, komponen `kubelet` pada node tersebut memanggil plugin CNI (executable binari seperti Calico, Cilium, atau Flannel) melalui antarmuka baris perintah (CLI), mengoper *environment variables* dan menerima konfigurasi JSON via `stdin`.

Proses inti pembuatan jaringan CNI Plugin melibatkan:
1. Pembuatan *Network Namespace* (netns) baru untuk Pod.
2. Pembuatan pasangan *veth* (Virtual Ethernet). Satu ujung disambungkan ke Host (atau bridge root), satu ujung diletakkan dalam *netns* Pod.
3. Alokasi IP Address melalui plugin IPAM (IP Address Management).
4. Penulisan rute jaringan (*routing rules*) atau konfigurasi eBPF untuk merutekan lalu lintas lintas simpul (*cross-node*).

## Diagram ASCII: Eksekusi Kubelet ke CNI

```text
+-----------------------+
|    Kubelet Process    |
| (Creates Pod Sandbox) |
+-----------------------+
           | (1) Set ENVs (CNI_COMMAND=ADD, CNI_NETNS=/var/run/netns/xxx)
           | (2) Send JSON Config via stdin
           v
+-----------------------+      (3) Create veth pair   +-------------------+
|  CNI Plugin Binary    | --------------------------> | Pod Network NS    |
| (Cilium/Calico/dll.)  |                             | (veth1, IP: 10.x) |
+-----------------------+                             +-------------------+
           |
           | (4) Write iptables/eBPF rules
           v
+-----------------------+
| Linux Host Networking |
| (Bridge / eBPF Maps)  |
+-----------------------+
```

## Kode Go Production-Ready

Kode di bawah ini mengilustrasikan inti dari CNI plugin khusus yang dibangun dengan Cobra untuk abstraksi *command-line*. Menggunakan `RunE` dan `github.com/containernetworking/cni/pkg/skel` untuk kepatuhan protokol sejati.

```go
package devopscni

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"runtime"
	"testing"

	"github.com/spf13/cobra"
	"github.com/containernetworking/cni/pkg/skel"
	"github.com/containernetworking/cni/pkg/types"
	current "github.com/containernetworking/cni/pkg/types/100"
	"github.com/containernetworking/cni/pkg/version"

	// Pseudo-packages untuk operasi jaringan rendah (sebagai ganti netlink di sini agar bisa compile)
	// "github.com/vishvananda/netlink"
)

// NetConf merupakan spesifikasi konfigurasi JSON yang diterima dari kubelet.
type NetConf struct {
	types.NetConf
	BridgeName string `json:"bridge"`
	IPMasq     bool   `json:"ipMasq"`
}

// CNIPlugin mengkapsulasi fungsionalitas utama plugin jaringan.
type CNIPlugin struct {
	// Konteks dapat menyimpan dependencies mockable seperti Netlink client atau IPAM client
}

// cmdAdd dipanggil saat Kubelet meminta penambahan Pod ke jaringan (CNI_COMMAND=ADD).
func (p *CNIPlugin) cmdAdd(args *skel.CmdArgs) error {
	var conf NetConf
	if err := json.Unmarshal(args.StdinData, &conf); err != nil {
		return fmt.Errorf("failed to load CNI network config: %w", err)
	}

	// 1. Panggil IPAM (IP Address Management) untuk mendapatkan IP
	// Secara nyata, ini memanggil plugin IPAM terpisah seperti `host-local`
	// Di sini kita simulasikan untuk kejelasan
	ip, ipnet, err := net.ParseCIDR("10.244.1.5/24")
	if err != nil {
		return fmt.Errorf("ipam dummy parse failed: %w", err)
	}

	result := &current.Result{
		CNIVersion: conf.CNIVersion,
		IPs: []*current.IPConfig{
			{
				Address: net.IPNet{IP: ip, Mask: ipnet.Mask},
				Gateway: net.ParseIP("10.244.1.1"),
			},
		},
		Interfaces: []*current.Interface{
			{Name: args.IfName, Sandbox: args.Netns},
		},
	}

	// 2. Lakukan operasi sistem: Buat veth pair, set IP, masuk ke netns.
	// Kita mensimulasikan fungsi setup jaringan di sini.
	err = p.setupNetwork(args.Netns, args.IfName, result)
	if err != nil {
		return fmt.Errorf("network setup failed: %w", err)
	}

	// 3. Output hasil JSON kembali ke kubelet via stdout
	return types.PrintResult(result, conf.CNIVersion)
}

func (p *CNIPlugin) setupNetwork(netns string, ifName string, result *current.Result) error {
	// Operasi real menggunakan github.com/vishvananda/netlink
	if netns == "" || ifName == "" {
		return fmt.Errorf("invalid arguments to setup network")
	}
	// Di sini plugin akan mengunci thread Linux agar netns tidak berganti
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	
	// Create veth pair, set IP di dalam NS.
	return nil
}

// cmdDel dipanggil saat Pod dimatikan (CNI_COMMAND=DEL).
func (p *CNIPlugin) cmdDel(args *skel.CmdArgs) error {
	// Panggil IPAM delegator untuk rilis IP
	// Hapus interface veth dari Namespace Linux
	return nil
}

// --- COBRA COMMAND CLI: Pembungkus untuk Debugging atau Ekseskusi Standalone ---

func NewCNICmd() *cobra.Command {
	plugin := &CNIPlugin{}

	cmd := &cobra.Command{
		Use:   "mycni",
		Short: "Eksekusi Plugin CNI khusus ini",
		RunE: func(cmd *cobra.Command, args []string) error {
			// skel.PluginMain adalah standar resmi kerangka kerja CNI
			// Ia membaca ENVs (CNI_COMMAND) dan mendelegasikan ke cmdAdd/cmdDel/cmdCheck
			
			// Di lingkungan Cobra asli, kita men-capture panic/error dari plugin
			// untuk disalurkan kembali sebagai error return.
			
			ctx := cmd.Context()
			_ = ctx // Gunakan konteks jika berintegrasi mendalam
			
			// Gunakan PluginMainFunc agar kita tidak keluar lewat os.Exit secara keras di dalam tes
			err := runSkel(plugin)
			if err != nil {
				return fmt.Errorf("CNI execution failed: %w", err)
			}
			return nil
		},
	}
	return cmd
}

// runSkel mensimulasikan eksekusi wrapper tanpa memanggil os.Exit langsung.
func runSkel(p *CNIPlugin) error {
	// Di kenyataan: 
	// skel.PluginMain(p.cmdAdd, p.cmdCheck, p.cmdDel, version.All, "MyCNI")
	cmd := os.Getenv("CNI_COMMAND")
	if cmd == "" {
		return fmt.Errorf("CNI_COMMAND environment variable not set")
	}
	return nil
}

// --- UNIT TESTS ---

func TestCNI_CmdAddSuccess(t *testing.T) {
	plugin := &CNIPlugin{}
	
	validJSON := []byte(`{
		"cniVersion": "1.0.0",
		"name": "mynet",
		"type": "mycni",
		"bridge": "cni0"
	}`)

	args := &skel.CmdArgs{
		ContainerID: "abc123xxx",
		Netns:       "/var/run/netns/test",
		IfName:      "eth0",
		StdinData:   validJSON,
	}

	err := plugin.cmdAdd(args)
	if err != nil {
		t.Fatalf("unexpected error during ADD command: %v", err)
	}
}

func TestCNI_CobraWrapper_RunE(t *testing.T) {
	cmd := NewCNICmd()
	
	// CNI_COMMAND tidak ter-set, Cobra harus me-return error (RunE logic)
	os.Unsetenv("CNI_COMMAND")
	
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error from missing CNI_COMMAND")
	}
	
	if err.Error() != "CNI execution failed: CNI_COMMAND environment variable not set" {
		t.Errorf("got unexpected error message: %v", err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengubah `netns` Tanpa Mengunci OS Thread
**Mengganti *Network Namespace* dari *Goroutine* asinkron tanpa perlindungan Go Scheduler.**

```go
// ❌ BAD: Konteks Linux bisa terbalik!
func SetupVeth(netns string) error {
    file, _ := os.Open(netns)
    unix.Setns(int(file.Fd()), unix.CLONE_NEWNET) // Berganti Namespace
    // Saat ini, goroutine kita sedang berada di NS Pod.
    
    // Tiba-tiba Go Scheduler memindahkan eksekusi Goroutine kita 
    // ke OS Thread yang berbeda yang masih di Namespace Host!
    netlink.LinkAdd(...) // BERBAHAYA: Dieksekusi di NS Host, bukan NS Pod.
}
```

**Mengapa Berbahaya:** Di Go, Goroutine bersifat dinamis dan melompat-lompat antar OS Thread (*M:N scheduling*). Sistem *Network Namespace* (netns) di Linux mengikat per-OS Thread. Jika Goroutine kita berpindah thread setelah instruksi `Setns`, sisa instruksi konfigurasi jaringan akan mencemari/merusak rute sistem operasi host (memicu pemadaman jaringan simpul K8s, alias *Node Isolation*).

```go
// ✅ GOOD: Kunci Thread Goroutine agar eksklusif!
func SetupVethSafe(netns string) error {
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()
    
    // Simpan namespace awal
    origns, _ := netns.Get()
    defer origns.Close()

    // Pindah ke Pod namespace, lakukan setup, lalu kembali ke namespace asli sebelum lepas thread.
}
```

### ❌ Anti-Pattern 2: Terlalu Santai Mengabaikan Error pada `cmdDel`
**Fungsi *Deletion* (hapus pod) yang panik atau mogok (*crash*) ketika sebagian sumber daya jaringan sudah hilang.**

```go
// ❌ BAD: Gagal membuang Pod Sandbox
func (p *CNIPlugin) cmdDel(args *skel.CmdArgs) error {
    link, err := netlink.LinkByName(args.IfName)
    if err != nil {
        return err // Mereturn error jika veth tidak ditemukan
    }
    netlink.LinkDel(link)
    return nil
}
```

**Mengapa Berbahaya:** CNI bersifat idempoten. Terkadang, *kubelet* bisa memanggil `DEL` beberapa kali. Atau host me-*reboot* Kubelet dan `veth` sudah dihapus oleh Kernel. Jika plugin mereturn *error* saat `DEL` karena objek tidak ditemukan, Kubelet menganggap penghapusan **gagal**, sehingga Status Pod menyangkut pada *Terminating*. Ratusan *Terminating Pods* dapat menghabiskan alokasi blok IPAM (IP Exhaustion).

```go
// ✅ GOOD: Idempotensi dan Toleransi
func (p *CNIPlugin) cmdDel(args *skel.CmdArgs) error {
    link, err := netlink.LinkByName(args.IfName)
    if err != nil {
        // Jika interface sudah tidak ada, anggap sukses karena tujuan akhirnya memang tidak ada.
        if isNotFoundError(err) {
            return nil
        }
        return fmt.Errorf("failed fetching link: %w", err)
    }
    _ = netlink.LinkDel(link) // Terus maju meskipun error parsial
    return nil
}
```

## Edge Cases & Defensive Programming

1. **IPAM IP Exhaustion (Kehabisan Blok IP)**:
   *Edge Case*: Kubelet menginstruksikan `ADD` namun IPAM sudah membagikan seluruh rentang (/24 subnet). IPAM mereturn *error*.
   *Defensive*: Plugin harus memastikan bahwa kegagalan alokasi IP *selalu* membersihkan (rollback) interface veth atau eBPF map yang terlanjur diciptakan pada langkah-langkah di atasnya. Jika gagal, *garbage* veth akan menumpuk di node Linux memakan resource.
2. **Crash saat CNI Output JSON Belum Dicetak**:
   *Edge Case*: Plugin berhasil memasang rute eBPF dan IP, tetapi *binary* mati (`panic` atau `os.Exit(1)`) sebelum sempat menge-print balasan JSON sukses ke `stdout`. Kubelet akan menangkap *Exit Code 1*.
   *Defensive*: Selalu perangkap *panic* menggunakan `defer recover()` pada level teratas CLI dan pastikan *output error JSON* dikembalikan. Kubelet akan memanggil `DEL` hanya jika `ADD` gagal secara terstruktur (untuk memicu retry/cleanup).
3. **Versi CNI Mismatch**:
   *Edge Case*: Daemon K8s tua mengoper *cniVersion="0.3.1"* ke konfigurasi, sedangkan CNI *binary* Anda hanya mendukung "1.0.0". Format kolom balasan JSON berbeda.
   *Defensive*: CNI harus selalu memparsing variabel `cniVersion` dan jika tidak berada dalam rentang versi *SupportedVersions* dari library `cni/pkg/skel`, CNI harus seketika berhenti. Jangan mencoba merender struktur struct Golang ke versi yang salah karena Kubelet akan salah membacanya dan *Pod* tidak dapat merutekan DNS.

## Kapan JANGAN Pakai Ini

- **Menulis plugin CNI sendiri kecuali ada kebutuhan jaringan yang benar-benar tidak terpenuhi.** Kegagalan CNI berarti **seluruh node tidak bisa menjalankan pod**. Radius kerusakannya jauh lebih besar daripada layanan aplikasi mana pun.
- **Tanpa membuat `ADD` dan `DEL` idempoten.** Kubelet akan mengulang keduanya. `ADD` yang tidak idempoten membocorkan alamat IP; `DEL` yang tidak idempoten membuat pembersihan gagal dan pod tersangkut di `Terminating`.
- **IPAM yang tidak tahan restart.** Alamat yang sudah dialokasikan harus tetap dikenali setelah plugin atau node di-restart, kalau tidak akan terjadi alamat ganda.
- **Menguji hanya di kind atau minikube.** Perilaku jaringan berbeda nyata di lingkungan cloud — MTU, routing overlay, dan interaksi dengan security group tidak muncul di lingkungan lokal.
- **Menulis log ke stdout.** CNI berkomunikasi dengan runtime lewat **stdout dalam bentuk JSON**. Satu baris log di sana merusak protokol, dan kegagalannya tampak sebagai galat parsing yang membingungkan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pod tersangkut `ContainerCreating` | log kubelet untuk plugin CNI | `ADD` gagal atau menggantung |
| Pod tersangkut `Terminating` | jalur `DEL` | Pembersihan gagal dan tidak idempoten |
| Alamat IP habis padahal pod sedikit | catatan IPAM | Alamat bocor karena `ADD` diulang |
| Galat parsing JSON dari CNI | apakah plugin menulis ke stdout | Log mencemari kanal protokol |
| Paket besar hilang | MTU pada antarmuka pod | MTU overlay tidak diperhitungkan |

```bash
# Kubelet adalah tempat pertama melihat kegagalan CNI
journalctl -u kubelet --since '30 min ago' | grep -i cni | tail -30

# Konfigurasi dan biner plugin yang benar-benar dipakai node
ls -la /etc/cni/net.d/ /opt/cni/bin/
cat /etc/cni/net.d/*.conflist | jq

# Pod yang tersangkut di kedua arah
kubectl get pods -A --field-selector status.phase!=Running | head -20

# MTU yang benar-benar berlaku di dalam pod
kubectl exec <pod> -- ip link show eth0
```
