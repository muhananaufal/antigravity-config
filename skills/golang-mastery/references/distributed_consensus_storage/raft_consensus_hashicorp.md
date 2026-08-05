# Raft Consensus Protocol: Hashicorp Raft

> **Berlaku:** Go 1.21+ · `hashicorp/raft` · **Lihat juga:** `distributed_consensus_storage/etcd_client_patterns.md` · `distributed_consensus_storage/wal_write_ahead_logging.md` · `concurrency/distributed_locks_redis.md` · `distributed_patterns_resilience/consistent_hashing_ring.md`

## 1. Konsep Utama & Internals

Raft adalah protokol konsensus terdistribusi yang dirancang untuk dapat dimengerti, menggantikan Paxos yang rumit secara akademis. Di ekosistem Golang, `github.com/hashicorp/raft` adalah implementasi standar industri untuk mem-bootstrap *Replicated State Machine* di dalam aplikasi Anda (dipakai di Consul, Nomad, dsb).

Konsep Kunci Raft:
1. **Leader Election**: Waktu dipilah dalam sebuah *Term*. Cluster selalu memilih (secara demokratis via quorums) SATU Leader. Sisanya menjadi *Follower*. Jika Leader mati/terisolir, Follower yang sadar *timeout* duluan akan menjadi *Candidate* dan memicu pemilu.
2. **Log Replication**: SATU pintu masuk. Klien tidak boleh me-write ke Follower. Semua *Write Operation* wajib dialirkan (*forward*) ke Leader. Leader mencatatnya di WAL (Log), lalu me-replikasikan append-log tersebut ke para Follower. Jika >50% (quorum) follower sudah acknowledge, Log di *Commit* dan diaplikasikan ke State Machine (FSM).
3. **Safety & Snapshotting**: Untuk menghindari ukuran Log menjadi jutaan baris, Node secara periodik mengambil memori State Machine saat ini (Snapshot/Checkpoint), lalu membuang Log usang sebelumnya ke tong sampah.
4. **Strong Consistency**: Raft menolak masalah *split-brain*. Dalam jaringan terbelah menjadi 2 fraksi (misal 3 dan 2 pada 5-node cluster), hanya partisi yang punya >50% member mayoritas yang bisa merespons write. Partisi kecil otomatis tertidur mati (tidak bisa mengumpulkan *votes* pemilihan Leader).

## 2. Diagram ASCII: Alur Log Replication

```text
       [ Klien Aplikasi (HTTP/gRPC) ]
                   |
            (Kirim: X = 100)
                   v
+---------------------------------------------+
|               Node A (LEADER)               |
|                                             |
| 1. Append Log Index 99: "X=100" (Uncommit)  |
| 2. Broadcast AppendEntries RPC (Parallel) --+---+
+---------------------------------------------+   |
      |                                           |
      v                                           v
+----------------------+                  +----------------------+
| Node B (Follower)    |                  | Node C (Follower)    |
| Log: [Index 99]      |                  | Log: [Index 99]      |
| Return: ACK (Yes)    |                  | Return: ACK (Yes)    |
+---------+------------+                  +-------+--------------+
          |                                       |
          +---------- (Leader Wait Quorum) <------+
                              |
    (2 dari 3 setuju -> QUORUM TERCAPAI. Leader Commit Log Index 99)
                              |
+---------------------------------------------+
| 3. Apply Index 99 ke State Machine (FSM)    |
|    Local Data Memory: X menjadi 100         |
| 4. Leader Reply Sukses ke Klien Aplikasi    |
+---------------------------------------------+
                              |
     (Di RPC Heartbeat Berikutnya, Leader beri tau Follower:
      "Tolong kalian semua commit Index 99 ke FSM masing-masing")
```

## 3. Production-Ready Go Code

```go
package hashicorp_raft_pattern

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb"
)

// MyFSM (Finite State Machine) adalah struktur Data aplikasi in-memory kita.
// Raft bertugas memastikan FSM ini selalu sinkron 100% pada semua mesin.
type MyFSM struct {
	mu sync.RWMutex
	kv map[string]string
}

// Apply dipanggil oleh Raft SETELAH log mendapatkan QUORUM mayoritas node.
// HARUS bersifat deterministik. Jangan panggil External API HTTP atau logic acak.
func (f *MyFSM) Apply(logRecord *raft.Log) interface{} {
	var payload map[string]string
	if err := json.Unmarshal(logRecord.Data, &payload); err != nil {
		return fmt.Errorf("FSM apply bad data: %w", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	for k, v := range payload {
		f.kv[k] = v
	}
	return nil
}

// Snapshot membuat checkpoint memory (Dipanggil Raft berkala)
func (f *MyFSM) Snapshot() (raft.FSMSnapshot, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()

	// Deep copy agar Snapshot IO ke disk tidak menge-block apply Write di RAM
	clone := make(map[string]string)
	for k, v := range f.kv {
		clone[k] = v
	}
	return &fsmSnapshot{kv: clone}, nil
}

// Restore membaca state utuh saat node bangkit dari tidur panjang / join cluster.
func (f *MyFSM) Restore(rc io.ReadCloser) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	
	f.kv = make(map[string]string)
	if err := json.NewDecoder(rc).Decode(&f.kv); err != nil {
		return err
	}
	return nil
}

type fsmSnapshot struct {
	kv map[string]string
}

func (f *fsmSnapshot) Persist(sink raft.SnapshotSink) error {
	err := func() error {
		b, err := json.Marshal(f.kv)
		if err != nil { return err }
		if _, err := sink.Write(b); err != nil { return err }
		return sink.Close()
	}()
	if err != nil {
		sink.Cancel()
		return err
	}
	return nil
}

func (f *fsmSnapshot) Release() {}

// RaftNode merepresentasikan aplikasi server yang menampung FSM & Raft Daemon
type RaftNode struct {
	Raft *raft.Raft
	FSM  *MyFSM
}

// SetupRaftNode men-setup BoltDB, LogStore, Network Transport dan instance Raft.
func SetupRaftNode(nodeID string, raftBindAddr string, dataDir string) (*RaftNode, error) {
	config := raft.DefaultConfig()
	config.LocalID = raft.ServerID(nodeID)

	// Transport jaringan via TCP murni
	addr, err := net.ResolveTCPAddr("tcp", raftBindAddr)
	if err != nil {
		return nil, err
	}
	transport, err := raft.NewTCPTransport(raftBindAddr, addr, 3, 10*time.Second, os.Stderr)
	if err != nil {
		return nil, err
	}

	// Buat direktori data untuk WAL disk
	os.MkdirAll(dataDir, 0700)

	// Log Store (Menyimpan record "X=100") dan Stable Store (menyimpan nomor Term, dll)
	logStore, err := raftboltdb.NewBoltStore(filepath.Join(dataDir, "raft-log.db"))
	if err != nil { return nil, err }
	stableStore, err := raftboltdb.NewBoltStore(filepath.Join(dataDir, "raft-stable.db"))
	if err != nil { return nil, err }

	// Snapshot store menyimpan memori checkpoint (.rdb zip / file)
	snapshotStore, err := raft.NewFileSnapshotStore(dataDir, 2, os.Stderr)
	if err != nil { return nil, err }

	myFSM := &MyFSM{kv: make(map[string]string)}

	r, err := raft.NewRaft(config, myFSM, logStore, stableStore, snapshotStore, transport)
	if err != nil {
		return nil, err
	}

	return &RaftNode{
		Raft: r,
		FSM:  myFSM,
	}, nil
}

// Bootstrap (HANYA DIPANGGIL SEKALI pada Node Leader Pertama kali cluster lahir)
func (r *RaftNode) BootstrapCluster(nodeID, bindAddr string) error {
	configuration := raft.Configuration{
		Servers: []raft.Server{
			{
				ID:      raft.ServerID(nodeID),
				Address: raft.ServerAddress(bindAddr),
			},
		},
	}
	f := r.Raft.BootstrapCluster(configuration)
	return f.Error()
}

// SetValue adalah endpoint untuk merubah data. Harus divalidasi apakah ia Leader.
func (r *RaftNode) SetValue(key, val string) error {
	if r.Raft.State() != raft.Leader {
		// Tolak secara Graceful. Pada sistem prdoduksi, kembalikan HTTP 307 Redirect ke r.Raft.Leader()
		return fmt.Errorf("saya bukan leader, silakan ke %s", r.Raft.Leader())
	}

	payload := map[string]string{key: val}
	dataBytes, _ := json.Marshal(payload)

	// Apply blok hingga Kuorum merespons
	f := r.Raft.Apply(dataBytes, 10*time.Second)
	if err := f.Error(); err != nil {
		return err
	}

	// Opsional: periksa jika `f.Response()` memberikan error logika FSM
	if fsmErr, ok := f.Response().(error); ok && fsmErr != nil {
		return fsmErr
	}
	return nil
}


// --- Unit Test ---
func TestRaftSingleNodeBootstrap(t *testing.T) {
	tempDir, _ := os.MkdirTemp("", "raft-test-*")
	defer os.RemoveAll(tempDir)

	// Setup In-Process Local Port
	nodeID := "node-1"
	addr := "127.0.0.1:0" // auto port

	node, err := SetupRaftNode(nodeID, addr, tempDir)
	if err != nil { t.Fatalf("Gagal setup: %v", err) }

	// Karena Node ini sendirian, ia harus mem-bootstrap clusternya sendiri agar jadi Leader
	err = node.BootstrapCluster(nodeID, node.Raft.Transport().LocalAddr().String())
	if err != nil { t.Fatalf("Gagal bootstrap: %v", err) }

	// Tunggu sampai Raft berdikusi dalam batinnya dan mengesahkan dirinya sebagai Leader
	time.Sleep(3 * time.Second)

	if node.Raft.State() != raft.Leader {
		t.Fatalf("Node gagal terpilih menjadi leader")
	}

	// Coba operasikan penyimpanan data lewat State Machine yang terlindungi Consensus
	err = node.SetValue("kopi", "hitam")
	if err != nil {
		t.Fatalf("Gagal menset log data: %v", err)
	}

	// Baca FSM murni lokal
	node.FSM.mu.RLock()
	val := node.FSM.kv["kopi"]
	node.FSM.mu.RUnlock()

	if val != "hitam" {
		t.Errorf("FSM tidak menerima mutasi apply raft. Dapat: %s", val)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Non-Deterministik Code di Dalam Fungsi Apply() FSM
`Apply` adalah zona steril. Instruksi di Log Raft (Misal Index #214 = "Potong Saldo Joko Rp.50.000") akan diulang (replay) secara identik pada SEMUA mesin, bahkan di-replay lagi tahun depan jika node restart (Snapshot restore).

```go
// BAD: Melakukan pemanggilan waktu Time.Now() eksternal atau hit gRPC dari dalam Apply
func (f *MyFSM) Apply(logRecord *raft.Log) interface{} {
    currentTime := time.Now().String() // BAHAYA: Berbeda tiap mesin/node!!
    f.data["last_update"] = currentTime 
    
    // BAD: HTTP call ke API luar
    http.Get("http://example.com/api/trigger") // Bakal di execute 3-5 kali oleh semua anggota cluster!
    return nil
}
```

```go
// GOOD: Semuanya harus bersifat Datar, Deterministik, Mutasi pasif dari input Log.
func (f *MyFSM) Apply(logRecord *raft.Log) interface{} {
    var payload MyPayload
    json.Unmarshal(logRecord.Data, &payload)
    
    // Waktu (Timestamp) HARUS dicetak oleh Leader di step awal (sebelum raft.Apply())
    // lalu dimasukkan ke dalam payload json log. Sehingga follower tinggal nurut baca timestamp dari payload.
    f.data["last_update"] = payload.LeaderTimestampString 
    return nil
}
```
**Why dangerous:** Jika node Anda dan node teman Anda merekam Data Memori dengan hasil yang *berbeda* (misalnya timestamp meleset 2 detik), Hash Memori State Machine akan bentrok (*State Divergence*). Raft akan panic mendeteksi bahwa FSM tidak sejalan, meledakkan sistem dan berhenti merespons traffic sampai disk dihapus manual.

### ❌ Anti-Pattern 2: Menutup (Block) IO Snapshot
Membuat Mutex Lock pada Data yang menyebabkan Thread Raft tertahan selama proses Copy Disk berlangsung bermenit-menit.

```go
// BAD: Ngunci memory dari awal sampai penulisan zip file ke disk I/O selesai!
func (f *MyFSM) Snapshot() (raft.FSMSnapshot, error) {
    f.mu.RLock() // Lock data
    // Jangan Unblock disini! Biarkan Raft melempar sink.Write(20 GB Memory to Disk)
    return &BadSnapshotBlocker{mu: f.mu, data: f.data}, nil
}
```

```go
// GOOD: Gunakan Deep Copy yang super kilat saat melock memory, 
// baru lempar hasil kloningan itu ke Routine Persist Disk
func (f *MyFSM) Snapshot() (raft.FSMSnapshot, error) {
    f.mu.RLock()
    defer f.mu.RUnlock() // KILAT: Langsung dilepas
    
    clonedData := deepClone(f.data) // RAM ke RAM kencang
    return &GoodSnapshot{data: clonedData}, nil // Disk IO akan dilakukan di belakang layar tanpa menahan thread aplikasi Read/Write utama
}
```
**Why dangerous:** Raft Heartbeat *Thread* mungkin akan *Stalled* (nyangkut). Follower akan curiga: "Loh Leader kok gak kirim heartbeat, oh leader mati kali ya?". Pemilu (Election) ulang meledak tanpa alasan hanya karena satu node asyik nulis snapshot ke disk yang lambat. *Availability* terganggu.

## 5. Edge Cases & Defensive Programming

1. **Jebakan Snapshot Restore (Boot-up Memory Spike)**
   Ketika node K8s baru dihidupkan, dan *Snapshot file* dari Raft besarnya 5 GB, fungsi `Restore()` akan disemburkan memori 5GB tersebut. Parsing JSON sebesar 5GB dari `io.ReadCloser` akan memakan RAM hingga 20GB di container (akibat tree object json overhead) dan otomatis kena bunuh OOMKilled K8s (Out of Memory).
   *Defensive Check:* Hindari JSON untuk Snapshot. Gunakan *MessagePack* atau Protobuf yang overhead-nya ringan, atau untuk sistem ekstrem, gunakan desain logik streaming ke `bboltdb` on disk untuk FSM-nya alih-alih me-load semuanya ke `map[string]struct` (RAM).

2. **Split Brain Partial (One-Way Network Partition)**
   Node Leader (A) tiba-tiba koneksi keluar/TCP kirimnya putus ke B dan C, tetapi koneksi Terimanya lancar. B dan C memutuskan menjadi Leader, terpilih C.
   Node A (Leader Lama) mengira ia masih Leader, dan aplikasinya masih mengirim traffic ke Node A. Node A mencoba *Append Log* dan macet total.
   *Defensive Check:* Tangkap *Timeout* di `f := r.Raft.Apply(data, timeout)`. Jangan pernah izinkan HTTP response ke Klien me-gantung abadi. Ketika `Apply()` melampaui timeout 5 detik (akibat tidak adanya *Quorum Ack* yang merespons karena terputus), return HTTP 503 Service Unavailable ke client Anda segera.

3. **Stale Read / Phantom Read (Dirty Read)**
   Klien membaca GET Data lewat Node B (Follower). Secara kebetulan jaringan Node B tersendat sedetik yang lalu. Di ujung sana, Node A (Leader) baru saja me-write X = 200, tapi replikasinya macet ke Node B. Klien membaca B, dan mendapatkan X = 100 (Stale).
   *Defensive Check:* Raft memisahkan *Write* dan *Read*. Secara fundamental, `Get()` tidak melalui layer Raft, melainkan ambil mentah dari RAM masing-masing FSM. Untuk menghindarinya (Bila Anda butuh Strict/Linearizable Consistency layaknya Perbankan), lakukan pembacaan dengan membungkusnya sebagai operasi Raft Dummy lewat metode khusus `Raft.VerifyLeader()` atau memasukkannya ke *Apply* kosong, lalu respon ke klien hanya saat index tersebut komplit. (Ini akan mengorbankan Read Throughput secara signifikan).

## Kapan JANGAN Pakai Ini

- **Untuk data yang bisa menerima eventual consistency.** Raft membayar latensi kuorum pada **setiap** penulisan. Bila kebutuhannya bukan konsistensi kuat, ongkos itu murni kerugian.
- **Cluster dengan jumlah node genap.** Empat node menoleransi kegagalan yang sama dengan tiga, tetapi menambah satu peserta yang harus dihubungi setiap kuorum. Ganjil selalu.
- **Raft lintas region tanpa memperhitungkan latensi.** Setiap penulisan menunggu mayoritas menjawab. Dengan node di tiga benua, latensi tulis Anda ditentukan geografi, bukan kode.
- **Menulis implementasi Raft sendiri.** Detail yang salah — pemotongan log, snapshot, perubahan keanggotaan — menghasilkan kehilangan data yang tidak terdeteksi sampai failover pertama, dan failover pertama biasanya terjadi saat keadaan sudah buruk.
- **Tanpa snapshot dan pemangkasan log.** Log yang tumbuh selamanya membuat pemulihan node makin lama, sampai titik di mana node baru tidak pernah berhasil menyusul.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi tulis tinggi dan stabil | latensi antar node kuorum | Ongkos kuorum, bukan ongkos aplikasi |
| Pemilihan pemimpin berulang | timeout heartbeat vs jitter jaringan | Cluster tidak stabil; timeout terlalu ketat |
| Node baru tidak pernah menyusul | ukuran log dan frekuensi snapshot | Snapshot terlalu jarang |
| Cluster kehilangan kuorum saat satu node mati | jumlah node | Konfigurasi genap atau terlalu kecil |
| Penulisan ditolak | status pemimpin | Tidak ada pemimpin; kuorum tidak terbentuk |

```bash
# Keadaan cluster: siapa pemimpin, dan apakah semua node menyusul
curl -s localhost:8080/raft/stats | jq
# atau, tergantung integrasi Anda:
#   raft.Stats() -> state, term, last_log_index, commit_index, applied_index

# Selisih commit_index antar node menunjukkan siapa yang tertinggal
for n in node1 node2 node3; do echo "== $n"; curl -s "$n:8080/raft/stats" | jq -r '.commit_index'; done

# Pemilihan pemimpin yang sering = cluster tidak stabil
kubectl logs -l app=raft --since=1h | grep -ci 'entering candidate state\|new leader elected'
```
