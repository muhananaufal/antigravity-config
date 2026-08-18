# Consistent Hashing Ring

> **Berlaku:** Go 1.21+ · **Lihat juga:** `db_sqlc/sharding_partitioning.md` · `caching_strategy/multilevel_cache_l1l2.md` · `distributed_patterns_resilience/multi_tenancy_isolation.md` · `concurrency/distributed_locks_redis.md`

## 1. Konsep & Internal

Dalam sistem terdistribusi, kita sering kali perlu mendistribusikan data atau *traffic* secara merata ke dalam sebuah kluster *server* (misal: Redis Cache, *Database Sharding*, atau *Load Balancing* lengket).

### A. Algoritma Internal (Hash Modulo vs Consistent Hashing)
Jika kita menggunakan **Naive Hashing** tradisional (`Hash(Key) % N`) dengan `N` adalah jumlah *server*, penambahan atau pengurangan 1 *server* akan mengubah nilai pembagi (*divisor*). Akibatnya, operasi *modulo* berubah secara drastis untuk hampir semua kunci. Ini memicu Re-hashing masif yang berujung pada *Cache Miss Avalanche* ke *database* utama.

**Consistent Hashing** menyelesaikan ini dengan memetakan *Server* dan *Key* ke dalam sebuah *Ring* (lingkaran logis) berbasis rentang representasi integer. Umumnya menggunakan arsitektur 32-bit (`0` hingga `2^32 - 1`), atau 64-bit (`uint64`).
1. **Node Hashing**: *Hash* representasi *string* atau *IP* setiap *server* dengan algoritma hash non-kriptografi (contoh: MurmurHash3, FNV-1a, atau CRC32). Letakkan nilai `uint32` di *ring*.
2. **Key Hashing**: *Hash* *key* data (misal: "user:1001") dengan fungsi hash **yang sama persis**.
3. **Lookup Routine**: Lakukan pencarian berurutan pada *ring* secara *clockwise* (searah jarum jam). Nilai hash *server* pertama yang lebih besar atau sama dengan (`>=`) nilai hash *key* akan dipilih. Operasi ini dilakukan dengan skema pencarian biner (*Binary Search*) pada *array* yang tersortir dengan kompleksitas `O(log N)`.

### B. Virtual Nodes (VNodes)
Fungsi hash tidak pernah benar-benar mendistribusikan titik secara simetris dalam jumlah sampel yang kecil. Untuk memastikan distribusi beban merata (*Load Balancing Entropy* yang bagus), satu *physical node* diwakili oleh ratusan **Virtual Nodes**. Misalnya Node A diwakili sebagai `0:NodeA`, `1:NodeA`, ... `N:NodeA`. Semakin besar `N` (replicas), semakin standar variansi terdistribusi.

### Diagram Arsitektur (ASCII)

```ascii
[ Hash Ring 0 - 2^32 ]

             [ Node A ] (Misal Hash: 100)
             /        \
           /            \
 (Key 2) x                x (Key 1: Hash 200) -> Dialihkan ke Node B
         |                |
         |                |
[Node D] |                | [Node B] (Hash: 300)
         |                |
         |                |
 (Key 3) x                x (Key 4) -> Dialihkan ke Node C
           \            /
             \        /
             [ Node C ] (Hash: 800)
             
* Jika Node B Mati, Key 1 hanya akan berpindah (searah jarum jam) ke Node C.
* Key 2, Key 3, dan Key 4 TETAP di tempatnya (TIDAK ADA Re-hashing)!
```

## 2. Production-Ready Code

Implementasi menggunakan *Virtual Nodes* (Replika) untuk memastikan distribusi yang merata. Karena fungsi *hash* (seperti `crc32` atau `murmur3`) tidak selalu mendistribusikan titik *server* secara rata, kita meng-*hash* 1 buah *server* menjadi puluhan titik virtual (misal `NodeA-1`, `NodeA-2`, dst).

```go
package hashing

import (
	"errors"
	"fmt"
	"hash/crc32"
	"sort"
	"strconv"
	"sync"
)

// Hash function signature. Boleh di-override (misal MurmurHash3).
type Hash func(data []byte) uint32

// ConsistentHash mengatur cincin dan node
type ConsistentHash struct {
	hashFunc Hash
	replicas int               // Jumlah Virtual Nodes per physical node
	keys     []uint32          // Cincin tersortir (Sorted keys)
	hashMap  map[uint32]string // Memetakan Hash(Virtual Node) -> Physical Node Name
	mu       sync.RWMutex      // Melindungi dari concurrent read/write (Thread Safe)
}

// NewConsistentHash menginisialisasi cincin baru.
func NewConsistentHash(replicas int, fn Hash) *ConsistentHash {
	m := &ConsistentHash{
		replicas: replicas,
		hashFunc: fn,
		hashMap:  make(map[uint32]string),
	}
	if m.hashFunc == nil {
		m.hashFunc = crc32.ChecksumIEEE
	}
	return m
}

// Add memasukkan satu atau lebih physical nodes ke dalam cincin.
func (c *ConsistentHash) Add(nodes ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for _, node := range nodes {
		for i := 0; i < c.replicas; i++ {
			// Buat identifier Virtual Node (contoh: "NodeA:0", "NodeA:1")
			virtualNode := []byte(strconv.Itoa(i) + ":" + node)
			hash := c.hashFunc(virtualNode)
			
			c.keys = append(c.keys, hash)
			c.hashMap[hash] = node
		}
	}
	// Sortir cincin agar kita bisa menggunakan Binary Search (O(log N))
	sort.Slice(c.keys, func(i, j int) bool { return c.keys[i] < c.keys[j] })
}

// Remove mencabut physical node dari cincin (misal saat server mati).
func (c *ConsistentHash) Remove(node string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for i := 0; i < c.replicas; i++ {
		virtualNode := []byte(strconv.Itoa(i) + ":" + node)
		hash := c.hashFunc(virtualNode)
		
		// Hapus dari map
		delete(c.hashMap, hash)
		
		// Hapus dari slice tersortir
		for j, k := range c.keys {
			if k == hash {
				c.keys = append(c.keys[:j], c.keys[j+1:]...)
				break
			}
		}
	}
}

// Get mencari node yang bertanggung jawab atas key tertentu.
func (c *ConsistentHash) Get(key string) (string, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if len(c.keys) == 0 {
		return "", errors.New("hash ring is empty")
	}

	hash := c.hashFunc([]byte(key))

	// Telusuri searah jarum jam menggunakan Binary Search
	// sort.Search mengembalikan indeks terkecil di mana f(i) bernilai true.
	idx := sort.Search(len(c.keys), func(i int) bool {
		return c.keys[i] >= hash
	})

	// Jika idx mencapai panjang array, berarti harus melingkar ke elemen pertama (0 derajat)
	if idx == len(c.keys) {
		idx = 0
	}

	return c.hashMap[c.keys[idx]], nil
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengubah Ring Tanpa Virtual Nodes
**Masalah**: Developer menginisiasi *Consistent Hashing* dengan `replicas = 1` (satu physical node direpresentasikan oleh satu titik).

❌ **BAD:**
```go
// BAD: Replicas = 1
ring := NewConsistentHash(1, nil)
ring.Add("ServerA", "ServerB", "ServerC")
```
**Why dangerous:** Fungsi *hash* (seperti `crc32`) pada nilai *string* acak tidak dijamin mendistribusikan titiknya dengan sempurna dalam putaran 360 derajat. ServerA dan ServerB mungkin jaraknya sangat dekat di satu ujung (menguasai 5% area), sementara ServerC berdiri sendiri di sisi yang lain (menguasai 95% area). *Traffic* dan *load* data menjadi sangat timpang/miring (*Skewed Load*).

✅ **GOOD:**
```go
// Gunakan Virtual Nodes yang cukup (misal 250)
ring := NewConsistentHash(250, nil)
ring.Add("ServerA", "ServerB", "ServerC")
```

### ❌ Anti-Pattern 2: Menghitung Hash Menggunakan O(N) Loop
**Masalah**: Fungsi `Get(key)` menelusuri array cincin secara *linear* dari indeks 0 setiap kali mencari.

❌ **BAD:**
```go
// BAD: O(N) time complexity untuk Get
for _, nodeHash := range c.keys {
    if nodeHash >= hash { return hashMap[nodeHash] }
}
```
**Why dangerous:** Jika terdapat 100 *server* dengan 500 replika (`50.000` elemen dalam array cincin), dan ada `100.000 RPS (Requests Per Second)` ke cache Anda, *linear search* akan memakan terlalu banyak siklus CPU (`5 miliar operasi per detik`). Latensi *router* akan naik tajam.

✅ **GOOD:**
```go
// Gunakan Binary Search O(log N)
idx := sort.Search(len(c.keys), func(i int) bool {
    return c.keys[i] >= hash
})
```

### ❌ Anti-Pattern 3: Menggunakan Cryptographic Hash (MD5/SHA256) untuk Pencarian Ring
**Masalah**: Developer menggunakan `crypto/sha256` untuk menghitung posisi hash, berpikir bahwa itu memberikan distribusi yang paling baik dan paling aman.

❌ **BAD:**
```go
// BAD: Sangat lambat dan membebani CPU
import "crypto/sha256"

func cryptoHash(data []byte) uint32 {
	h := sha256.Sum256(data)
	return uint32(h[0])<<24 | uint32(h[1])<<16 | uint32(h[2])<<8 | uint32(h[3])
}
```
**Why dangerous:** Fungsi kriptografi sengaja dirancang secara *CPU-intensive* agar sulit di-*bruteforce*. Pada *load balancer* atau *router* dengan puluhan ribu RPS, penggunaan SHA256 akan menjadi *bottleneck* CPU utama yang menaikkan latensi (*P99 latency spike*). *Consistent hashing* tidak butuh ketahanan kriptografis, melainkan kecepatan dan distribusi (*avalanche effect*) yang bagus.

✅ **GOOD:**
```go
// Gunakan Non-Cryptographic Fast Hash
import "github.com/spaolacci/murmur3"

func fastHash(data []byte) uint32 {
	return murmur3.Sum32(data) // 10x - 100x lebih cepat dari SHA256
}
```

## 4. Edge Cases Spesifik

1. **Hash Collisions pada Virtual Nodes**:
   Bagaimana jika `hash("0:ServerA")` dan `hash("0:ServerB")` menghasilkan integer `uint32` yang sama persis? Jika ditimpa ke dalam `c.hashMap`, satu titik akan di-hilangkan diam-diam.
   *Penanganan & Detail Implementasi*: Fungsi *hash* modern (non-kriptografi) seperti `Murmur3` atau `xxHash` memiliki kemungkinan bentrokan (*collision rate*) yang amat rendah. Namun untuk perlindungan mutlak (dalam sistem dengan ratusan ribu VNodes), Anda bisa menggunakan teknik *Linear Probing* atau pergeseran bit:
   ```go
   // Jika hash bentrok, geser terus sampai mendapat titik logis yang kosong
   hash := c.hashFunc(virtualNode)
   for {
       if _, exists := c.hashMap[hash]; !exists {
           break
       }
       hash++ // Linear Probing ke kanan
   }
   ```

2. **Flapping Nodes (Server Mati-Hidup Cepat / Network Partitions)**:
   Jika satu server memiliki koneksi *network* yang tidak stabil (mati nyala setiap 3 detik), sistem *health checker* (misal Consul atau etcd) akan memanggil `ring.Remove()` lalu `ring.Add()` berulang-ulang. Ini mengakibatkan data tetangganya dipaksa berpindah (*cache miss*) setiap 3 detik (*Churn rate* sangat tinggi, berpotensi menggerus IOPS *database*).
   *Penanganan & Detail Implementasi*: Implementasikan mekanisme *Debounce* (penundaan) atau status *Quarantine* (*Tombstone*). Jika sebuah *node* terdeteksi mati, ubah statusnya menjadi `Quarantined`, dan hanya pindahkan *traffic* **baca** (*read*) ke tetangga, tetapi tetap arahkan *write* ke log darurat pada tetangganya (*Hinted Handoff*). Jika node tersebut tidak hidup secara stabil dalam jendela waktu toleransi (misal 60 detik), barulah dieksekusi pembersihan permanen (`ring.Remove`).

3. **Stateful Replication & Data Re-balancing (Data Pindah Fisik)**:
   Pada *Cache* sementara (seperti Memcached atau Redis murni *cache*), *Consistent Hashing* sudah cukup mengatasi perutean (*Routing*). Namun jika Anda membangun *Database Sharding* yang bersifat *Stateful* (seperti Cassandra atau DynamoDB), Anda tidak bisa sekadar memindahkan titik *request routing* saat *node* ditambah.
   *Detail Implementasi*: Anda **harus memindahkan gigabyte data** secara fisik (*Resharding*) dari node tetangga ke node yang baru. Sistem harus menolak perutean baca-tulis penuh (masih berstatus `Joining` pada Gossip Protocol) hingga semua sinkronisasi data *background* selesai ditransfer sepenuhnya via RPC.

4. **Kapasitas Hardware yang Berbeda (Weighted/Heterogeneous Nodes)**:
   Bagaimana jika `ServerA` punya spesifikasi RAM 64GB dan `ServerB` hanya punya RAM 16GB? Kita tidak boleh mendistribusikan data dan *traffic* dengan probabilitas 50:50.
   *Detail Implementasi*: Sesuaikan jumlah `replicas` (*Virtual Nodes*) yang diinjeksi berdasarkan bobot/kapasitas mesin secara komputasional.
   ```go
   func (c *ConsistentHash) AddWithWeight(node string, weight int) {
       // weight yang tinggi menghasilkan VNodes lebih banyak secara eksponensial/linear
       // misal ServerA (64GB) -> weight=4 -> 400 VNodes
       // misal ServerB (16GB) -> weight=1 -> 100 VNodes
       vNodes := c.replicas * weight
       for i := 0; i < vNodes; i++ {
           // Proses hashing...
       }
   }
   ```

## 5. Unit Tests (Behavioral Testing)

```go
package hashing

import (
	"strconv"
	"testing"
)

// Dummy hash untuk memprediksi letak
func dummyHash(data []byte) uint32 {
	i, _ := strconv.Atoi(string(data))
	return uint32(i)
}

func TestConsistentHash_Routing(t *testing.T) {
	// Buat ring, gunakan dummyHash agar input "2", "4", "6" 
	// langsung menghasilkan uint32 bernilai 2, 4, 6.
	// Gunakan 1 replica untuk mempermudah tes prediksi.
	ring := NewConsistentHash(1, dummyHash)
	ring.Add("2", "4", "6")

	// Peta test cases:
	// Ring saat ini: 2, 4, 6.
	// Jika Hash(Key) = 1 -> Harus jatuh di 2 (Searah jarum jam)
	// Jika Hash(Key) = 3 -> Harus jatuh di 4
	// Jika Hash(Key) = 5 -> Harus jatuh di 6
	// Jika Hash(Key) = 7 -> Harus jatuh di 2 (Melingkar kembali ke awal / Wrap around)

	testCases := map[string]string{
		"1": "2",
		"3": "4",
		"5": "6",
		"7": "2", 
	}

	for k, expected := range testCases {
		node, err := ring.Get(k)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}
		if node != expected {
			t.Fatalf("For key %s, expected node %s but got %s", k, expected, node)
		}
	}
}

func TestConsistentHash_RemoveNode(t *testing.T) {
	ring := NewConsistentHash(1, dummyHash)
	ring.Add("2", "4", "6")

	// Saat ini Key "3" akan jatuh ke node "4".
	node, _ := ring.Get("3")
	if node != "4" {
		t.Fatalf("Expected node 4, got %s", node)
	}

	// Simulasi node "4" crash / dihapus
	ring.Remove("4")

	// Sekarang Key "3" harusnya maju terus dan jatuh ke node "6".
	node, _ = ring.Get("3")
	if node != "6" {
		t.Fatalf("Expected node 6, got %s", node)
	}
}

// Mock interface representation for testing
type NodeResolver interface {
	Get(key string) (string, error)
}

func TestConsistentHash_EmptyRing(t *testing.T) {
	var resolver NodeResolver = NewConsistentHash(100, nil)
	
	// Test edge case: cincin kosong
	_, err := resolver.Get("any_key")
	if err == nil {
		t.Fatal("Expected error when getting from empty ring, got nil")
	}
}

// ---------------------------------------------------------
// BENCHMARK: Naive Hash Mod vs Consistent Hashing
// ---------------------------------------------------------

// Naive Router (Hash Mod)
type NaiveRouter struct {
	nodes []string
}

func (n *NaiveRouter) Get(key string) string {
	if len(n.nodes) == 0 {
		return ""
	}
	hash := crc32.ChecksumIEEE([]byte(key))
	idx := hash % uint32(len(n.nodes))
	return n.nodes[idx]
}

// go test -bench=.
func BenchmarkConsistentHash_Get(b *testing.B) {
	ring := NewConsistentHash(250, nil)
	for i := 0; i < 100; i++ {
		ring.Add("node_" + strconv.Itoa(i))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		key := "session_id_" + strconv.Itoa(i)
		_, _ = ring.Get(key)
	}
}

func BenchmarkNaiveRouter_Get(b *testing.B) {
	router := &NaiveRouter{}
	for i := 0; i < 100; i++ {
		router.nodes = append(router.nodes, "node_"+strconv.Itoa(i))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		key := "session_id_" + strconv.Itoa(i)
		_ = router.Get(key)
	}
}

// ---------------------------------------------------------
// TEST DISTRIBUSI: Validasi Entropi Virtual Nodes
// ---------------------------------------------------------

// Membuktikan bahwa dengan VNodes, standar deviasi/distribusi data cukup merata.
func TestConsistentHash_Distribution(t *testing.T) {
	nodes := []string{"ServerA", "ServerB", "ServerC", "ServerD", "ServerE"}
	
	// 150 Virtual Nodes per Server (Entropy tinggi)
	ring := NewConsistentHash(150, nil)
	ring.Add(nodes...)

	hits := make(map[string]int)
	totalKeys := 100000

	for i := 0; i < totalKeys; i++ {
		key := "random_data_key_" + strconv.Itoa(i)
		node, _ := ring.Get(key)
		hits[node]++
	}

	// Ekspektasi: setiap node mendapat ~20% dari totalKeys (20.000)
	// Kita periksa batas toleransi error (misal +- 20%)
	expected := totalKeys / len(nodes)
	tolerance := float64(expected) * 0.20 // 20% margin of error untuk CRC32 hash (standar wajar)

	for _, node := range nodes {
		count := hits[node]
		diff := count - expected
		if diff < 0 {
			diff = -diff
		}
		if float64(diff) > tolerance {
			t.Errorf("Distribusi timpang untuk %s. Expected ~%d, got %d. Butuh fungsi hash lebih baik atau replica dinaikkan.", node, expected, count)
		}
	}
}
```

## Kapan JANGAN Pakai Ini

- **Untuk sharding database.** Rebalancing memindahkan baris **acak**, dan Anda tidak bisa memeriksa mana yang pindah sebelum beralih. Peta logical shard yang eksplisit memberi kendali yang tidak dimiliki ring — lihat `db_sqlc/sharding_partitioning.md`.
- **Tanpa virtual node.** Dengan sedikit node fisik, sebaran titik di ring sangat timpang; satu node bisa memegang tiga kali beban tetangganya tanpa ada yang salah dalam kodenya.
- **Dengan fungsi hash yang tidak stabil antar proses.** Setiap instans akan memetakan kunci yang sama ke node berbeda. `maphash` — yang benihnya acak per proses — tidak boleh dipakai di sini.
- **Ketika daftar node berubah sangat sering.** Setiap perubahan memindahkan sebagian kunci. Pada armada yang autoscale agresif, hit rate cache tidak pernah sempat stabil.
- **Sebagai jaminan penempatan.** Consistent hashing **meminimalkan** perpindahan, bukan meniadakannya. Data yang benar-benar tidak boleh berpindah membutuhkan pemetaan eksplisit.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Satu node jauh lebih sibuk | sebaran kunci antar node | Virtual node terlalu sedikit |
| Hit rate cache anjlok setelah scaling | jumlah kunci yang berpindah | Perubahan topologi memindahkan kunci |
| Kunci yang sama dilayani node berbeda | fungsi hash yang dipakai | Hash tidak stabil antar proses |
| Hit rate tidak pernah stabil | frekuensi perubahan node | Autoscaling terlalu agresif untuk pola ini |
| Node yang dihapus masih menerima trafik | pembaruan daftar node | Ring tidak disinkronkan di semua klien |

```bash
# Sebaran beban antar node: ini bukti paling langsung apakah ring seimbang
kubectl top pods -l app=cache

# Jumlah kunci per node (Redis Cluster)
redis-cli --cluster check localhost:6379 | grep -E 'slots|keys'

curl -s localhost:9090/metrics | grep -E 'ring_(nodes|vnodes|keys_moved_total)'

# Hit rate sebelum dan sesudah perubahan topologi
redis-cli info stats | grep -E 'keyspace_hits|keyspace_misses'
```
