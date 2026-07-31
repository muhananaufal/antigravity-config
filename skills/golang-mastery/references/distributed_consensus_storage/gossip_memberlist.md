# Gossip Protocol: Memberlist

## 1. Konsep Utama & Internals

`memberlist` adalah library Golang dari HashiCorp yang memanajemen deteksi keanggotaan klaster (cluster membership) dan kegagalan node (failure detection) menggunakan protokol Gossip (diadopsi dari protokol SWIM - Scalable Weakly-consistent Infection-style Process Group Membership). 

Sifat dasar dari Gossip Protocol adalah *Eventually Consistent*. Berbeda dengan Etcd (Raft) yang menggunakan consensus berat nan kaku (strongly consistent), Gossip sangat ringan, sangat scalable hingga puluhan ribu node, dan tidak membutuhkan arsitektur terpusat (master/leader-less). Node "berbisik-bisik" satu sama lain, menyebarkan informasi tentang siapa saja yang hidup dan siapa yang mati layaknya penyebaran virus atau rumor (epidemic routing).

Konsep Utama Memberlist:
1. **Periodic Ping (Heartbeat)**: Node secara acak melakukan "Ping" UDP ke node-node di dalam list anggotanya secara konstan. 
2. **Indirect Ping**: Jika node A nge-ping B dan gagal/timeout, node A akan meminta node C, D, E untuk membantu menge-ping node B (Indirect Ping). Jika sukses, B masih hidup; bila gagal semua, B dianggap `Suspect`.
3. **Suspect ke Dead**: Jika node dikategorikan `Suspect` dan tidak ada satupun member lain yang membantah bahwa node tersebut hidup (melalui pesan *Alive* yang menyebar), maka node diubah menjadi status `Dead`.
4. **Piggybacking Data**: Pesan kecil (metadata/state) dapat diselipkan (piggyback) ke dalam paket PING rutin sehingga data kecil bisa disebar ke seantero klaster tanpa overhead jaringan tambahan.

## 2. Diagram ASCII: Mekanisme Deteksi Kegagalan (SWIM Protocol)

```text
       (Periodic Gossip / UDP Ping)
 [ Node A ] --------------------------> [ Node B ] (OK)
     |
     | (Ping Gagal - Timeout 500ms)
     |
     +---X---> [ Node C ] (Terisolasi/Mati)
     |
     | (Initiate Indirect Ping ke C via D & E)
     +-------> [ Node D ] -----> [ Node C ] (X - Gagal)
     +-------> [ Node E ] -----> [ Node C ] (X - Gagal)
     |
     v
[ Node A menyebarkan pesan UDP Gossip: "Node C berstatus SUSPECT" ]
       \
        +---> [ Node D ] update list
        +---> [ Node B ] update list
        +---> [ Node E ] update list
             (Jika Node C tidak memprotes via pesan Alive, 
              status Suspect menjadi DEAD di seluruh klaster)
```

## 3. Production-Ready Go Code

```go
package gossip_memberlist

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/memberlist"
)

// MyDelegate mengelola data metadata piggyback dan menerima notifikasi node masuk/keluar
type MyDelegate struct {
	mu        sync.RWMutex
	LocalData map[string]string // data yg akan disebar
	Events    chan string       // notifikasi event
}

// NodeMeta mengembalikan metadata ringan (max 512 bytes) yang dikirim saat initial join
func (m *MyDelegate) NodeMeta(limit int) []byte {
	return []byte("role=worker,region=us-east")
}

// NotifyMsg dipanggil ketika memberlist menerima direct message (via SendReliable / SendToUDP)
func (m *MyDelegate) NotifyMsg(msg []byte) {
	log.Printf("Pesan gossip diterima: %s\n", string(msg))
}

// GetBroadcasts mendistribusikan data dari local buffer ke jaringan.
func (m *MyDelegate) GetBroadcasts(overhead, limit int) [][]byte {
	// Biasanya ini diisi dengan antrean data mutasi (delta). 
	// Di sini ditiadakan agar simpel.
	return nil
}

// LocalState dipakai untuk Full State Sync.
func (m *MyDelegate) LocalState(join bool) []byte { return []byte{} }
func (m *MyDelegate) MergeRemoteState(buf []byte, join bool) {}

// EventDelegate mengatur life cycle event anggota klaster
type EventDelegate struct {
	events chan<- string
}

func (e *EventDelegate) NotifyJoin(node *memberlist.Node) {
	e.events <- fmt.Sprintf("JOIN: %s", node.Name)
}
func (e *EventDelegate) NotifyLeave(node *memberlist.Node) {
	e.events <- fmt.Sprintf("LEAVE: %s", node.Name)
}
func (e *EventDelegate) NotifyUpdate(node *memberlist.Node) {}

// GossipCluster mengatur memberlist client
type GossipCluster struct {
	list     *memberlist.Memberlist
	delegate *MyDelegate
	evChan   chan string
}

// NewGossipCluster menciptakan node dan join ke klaster (jika ada seed)
func NewGossipCluster(nodeName string, bindPort int, seedNodes []string) (*GossipCluster, error) {
	config := memberlist.DefaultLANConfig()
	config.Name = nodeName
	config.BindPort = bindPort
	// Dalam container env, penting nge-bind addr ke 0.0.0.0
	config.BindAddr = "0.0.0.0" 

	evChan := make(chan string, 100)
	delegate := &MyDelegate{
		LocalData: make(map[string]string),
		Events:    evChan,
	}

	config.Delegate = delegate
	config.Events = &EventDelegate{events: evChan}
	
	// Gunakan logger hening untuk mematikan log spam bawaan memberlist
	// config.Logger = log.New(io.Discard, "", 0)

	list, err := memberlist.Create(config)
	if err != nil {
		return nil, fmt.Errorf("gagal membuat memberlist: %w", err)
	}

	if len(seedNodes) > 0 {
		_, err := list.Join(seedNodes)
		if err != nil {
			// Seringkali join bisa gagal parsial jika 1 node mati. Tangani dengan bijak.
			log.Printf("Peringatan: Gagal menghubungi beberapa seed node: %v", err)
		}
	}

	return &GossipCluster{
		list:     list,
		delegate: delegate,
		evChan:   evChan,
	}, nil
}

// Members mereturn daftar list member saat ini (Local View)
func (gc *GossipCluster) Members() []string {
	var members []string
	for _, member := range gc.list.Members() {
		members = append(members, member.Name)
	}
	return members
}

func (gc *GossipCluster) Close() error {
	// Lakukan leave yang bersih. Mengumumkan secara graceful ke klaster agar
	// Node ini tidak masuk ke mode "Suspect", melainkan langsung dicatat "Left".
	err := gc.list.Leave(2 * time.Second)
	if err != nil {
		return err
	}
	return gc.list.Shutdown()
}


// --- Unit Test (Integration Test 3 Node) ---
func getFreePort() int {
	addr, _ := net.ResolveTCPAddr("tcp", "localhost:0")
	l, _ := net.ListenTCP("tcp", addr)
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func TestGossipMembership(t *testing.T) {
	port1 := getFreePort()
	port2 := getFreePort()
	port3 := getFreePort()

	// Node 1 (Seed Node)
	node1, err := NewGossipCluster("node1", port1, nil)
	if err != nil { t.Fatalf("error node1: %v", err) }
	defer node1.Close()

	// Node 2 join ke Node 1
	node2, err := NewGossipCluster("node2", port2, []string{"127.0.0.1:" + strconv.Itoa(port1)})
	if err != nil { t.Fatalf("error node2: %v", err) }
	defer node2.Close()
	
	// Node 3 join ke Node 2 (Transitive join, Gossip akan sebarkan ke Node 1)
	node3, err := NewGossipCluster("node3", port3, []string{"127.0.0.1:" + strconv.Itoa(port2)})
	if err != nil { t.Fatalf("error node3: %v", err) }
	defer node3.Close()

	// Memberikan waktu UDP paket menyebar untuk Converge
	time.Sleep(1 * time.Second)

	// Node 1 harus mengenali Node 3 walau Node 3 hanya nembak ke Node 2 (Rumor / Epidemic spreading)
	m1 := node1.Members()
	if len(m1) != 3 {
		t.Errorf("Node 1 seharusnya melihat 3 nodes, mendapatkan: %d", len(m1))
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mengirim Data Besar Lewat Broadcast / Piggyback (MTU Overflow)
Memberlist berjalan di atas paket UDP UDP datagrams tanpa koneksi (Connectionless). UDP dibatasi oleh limit MTU (Maximum Transmission Unit) jaringan, umumnya 1500 bytes. Menyelipkan payload JSON besar di atas Broadcast (Delegate) akan merusak jaringan.

```go
// BAD: Piggyback JSON 2 MB di Delegate Broadcast
func (m *MyDelegate) GetBroadcasts(overhead, limit int) [][]byte {
    bigJSONData := fetch2MBDataFromDatabase()
    return [][]byte{bigJSONData} // PANIC / Packet Dropped di router. Gossip protocol gagal.
}
```

```go
// GOOD: Gunakan gossip HANYA untuk mengirim sinyal "Data Telah Berubah", 
// lalu biarkan member melakukan HTTP Pull secara terpisah untuk payload besar.
func (m *MyDelegate) GetBroadcasts(overhead, limit int) [][]byte {
    smallSignal := []byte(`{"event":"db_updated", "rev_id":4991}`)
    return [][]byte{smallSignal}
}
```
**Why dangerous:** Paket UDP besar akan di-*fragment* oleh IP layer, menaikkan tingkat *packet loss* sangat tinggi. Jika packet loss Gossip tinggi, klaster akan dipenuhi oleh deteksi `Suspect` palsu, node akan menganggap satu sama lain terisolir (Partition), lalu terjadi kehancuran topologi (Split Brain Chaos).

### ❌ Anti-Pattern 2: Tidak Melakukan Graceful Leave pada SIGTERM
Seringkali pada Kubernetes pod, aplikasi Go hanya diterminasi begitu saja tanpa men-trigger `memberlist.Leave()`.

```go
// BAD: Pod di stop, langsung exit(0)
func main() {
    list, _ := memberlist.Create(config)
    select{} // Wait forever, jika SIGTERM datang, program kill langsung
}
```

```go
// GOOD: Gunakan OS signal menangkap interupsi dan eksekusi Leave(timeout)
func main() {
    // ...
    c := make(chan os.Signal, 1)
    signal.Notify(c, os.Interrupt, syscall.SIGTERM)
    <-c
    
    // Memberitahu node sekeliling bahwa saya pulang secara normal, jangan jadikan saya suspect
    list.Leave(2 * time.Second)
    list.Shutdown()
}
```
**Why dangerous:** Node lain akan panik mendeteksi node yang mendadak lenyap sebagai kegagalan fatal. Ini memicu `Indirect Pings` yang masif dan lonjakan *overhead* UDP Traffic sesaat (Flapping). Jika di dalam sistem Auto-Scaling puluhan pod hilang-timbul, ini dapat merubuhkan throughput jaringan internal (Network Storm).

## 5. Edge Cases & Defensive Programming

1. **Split-Brain / Network Partitioning (NAT / Container)**
   Dalam environment *Cloud* yang berbeda AZ (Availability Zone) atau dibalik VPN, bisa saja UDP Port terblokir oleh Firewall Security Group, sementara TCP (API) terbuka. Memberlist mengandalkan koneksi UDP untuk PING. Jika UDP mati sepihak, Gossip akan melaporkan ratusan node sebagai `Dead`, aplikasi kita bisa bereaksi ekstrem.
   *Defensive Check:* Selalu buat *Liveness Probes* tersendiri atau cek kesamaan status. Jika memberlist bilang 90% klaster `Dead`, jangan langsung mengeksekusi operasi fail-over database, karena kemungkinan node ANDA lah yang terisolasi jaringannya dari klaster.
   
2. **IP Reuse pada Docker/Kubernetes**
   Di K8s, IP Pod (`10.0.x.x`) cepat sekali di-*recycle*. Pod A mati, lalu Pod B bangkit mengambil IP yang persis sama. Memberlist akan bingung karena paket "Suspect" dari hantu masa lalu datang menghantui IP Pod B yang baru, membuat Pod B langsung diasingkan dari grup sejak ia terlahir.
   *Defensive Check:* Harus men-*generate* nama node (config.Name) dengan ID unik, misal di Kubernetes `Hostname-RandomUUID`. **Dilarang Keras** menggunakan IP Address semata sebagai `config.Name`.

3. **Time Drift dan Jitter Jaringan (The Flapping Member)**
   Sebuah node yang mengalami Load CPU sangat tinggi akan *starving*, telat merespons Ping Gossip selama ratusan milidetik. Statusnya akan *flapping*: `Suspect -> Alive -> Suspect -> Alive`.
   *Defensive Check:* Gunakan `memberlist.DefaultLANConfig()` untuk di 1 datacenter dan `memberlist.DefaultWANConfig()` untuk multi-region. WAN Config otomatis meningkatkan batas toleransi timeout Ping. Kita bisa menaikkan `config.SuspicionMult` agar node tidak terlalu prematur dicap mati, meredam fenomena *Flapping Alerting* di observability tools Anda.
