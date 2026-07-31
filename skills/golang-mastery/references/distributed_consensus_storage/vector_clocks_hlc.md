# Vector Clocks & Hybrid Logical Clocks (HLC)

## 1. Konsep Utama & Internals

Dalam sistem terdistribusi, mengurutkan dua peristiwa (event) yang terjadi di mesin fisik berbeda sangatlah mustahil jika bergantung pada jam dinding OS (NTP / *Wall Clock*). NTP bisa meleset puluhan milidetik atau berputar mundur (*Clock Skew/Drift*).

Untuk menghindari tabrakan data (Concurrency Conflict), kita menggunakan Jam Logis:
1. **Lamport Clocks**: Counter sederhana (+1 setiap peristiwa, +1 jika melihat counter lebih besar dari luar). Hanya bisa menentukan Kausalitas terbatas (Kejadian A pasti sebelum B).
2. **Vector Clocks (VC)**: Evolusi Lamport. Membawa *array/map counter* dari semua Node (misal: `[A:2, B:0, C:1]`). Bisa dengan akurat membedakan: "Apakah Event A mendahului B, atau Event A dan B terjadi secara paralel/serentak (Conflict) tanpa sepengetahuan masing-masing?".
3. **Hybrid Logical Clocks (HLC)**: Kombinasi terbaik dari keduanya untuk sistem modern (seperti CockroachDB). Memadukan Physical NTP Timestamp + Logical Counter. Memungkinkan pemilahan *Causal Ordering* (Sebab-akibat) yang sangat akurat secara logis, sambil tetap dapat dicocokkan dengan Jam Dunia Nyata agar *friendly* buat pengguna manusia.

## 2. Diagram ASCII: Vector Clock Conflict Detection

Skenario: Shopping Cart Replikasi tanpa Master (Leader-less).

```text
    [ Awal Mula: Keduanya Sinkron ]
    Node 1 dan Node 2 memiliki state: Cart(Apel), Vector:[N1:1, N2:1]

       [ Node 1 ]                          [ Node 2 ]
       User X menambah 'Pisang'            User Y (di HP lain) menambah 'Jeruk'
       Cart:(Apel, Pisang)                 Cart:(Apel, Jeruk)
       VC: [N1:2, N2:1]                    VC: [N1:1, N2:2]
            |                                   |
            +------------(Gossip Sync)----------+
                               |
                   [ DETEKSI KONFLIK (SIBLINGS) ]
                   Node 1 memeriksa VC dari Node 2:
                   - VC N1 (2) > VC N2 di pos N1 (1)
                   - VC N2 di pos N2 (2) > VC N1 (1)
                   (Tidak ada yang dominan 100%, berpotongan saling silang)
                   Kesimpulan: Terjadi modifikasi Serentak (Concurrent).
                   Aplikasi dipaksa turun tangan untuk Merging Keduanya!
                               |
                     [ Merged by App Logic ]
                     Cart:(Apel, Pisang, Jeruk)
                     VC Baru: [N1:3, N2:2] (Dimerge via put di Node 1)
```

## 3. Production-Ready Go Code (Vector Clock & HLC)

Berikut adalah implementasi fundamental Vector Clock untuk perlindungan konflik.

```go
package clocks

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// VectorClock menyimpan counter dari masing-masing node partisipan
type VectorClock map[string]int

// Copy mengkloning map (menghindari referensi mmaping bocor)
func (vc VectorClock) Copy() VectorClock {
	c := make(VectorClock)
	for k, v := range vc {
		c[k] = v
	}
	return c
}

// Increment menambah counter lokal untuk mesin ini
func (vc VectorClock) Increment(nodeID string) {
	vc[nodeID]++
}

// Merge menyatukan vector clock luar yang masuk dengan yang ada di memori lokal.
// Aturannya: ambil nilai paling maksimal (Max) dari setiap dimensi node.
func (vc VectorClock) Merge(remote VectorClock) {
	for remoteNode, remoteCount := range remote {
		if localCount, exists := vc[remoteNode]; exists {
			if remoteCount > localCount {
				vc[remoteNode] = remoteCount
			}
		} else {
			// Dimensi node baru yang belum dikenal
			vc[remoteNode] = remoteCount
		}
	}
}

// CompareResult tipe enum
type CompareResult int

const (
	Before CompareResult = -1 // A sebelum B
	Equal  CompareResult = 0  // Sama persis
	After  CompareResult = 1  // A sesudah B
	Concurrent CompareResult = 2 // Keduanya parallel/konflik
)

// Compare memeriksa apakah vcA Mendahului vcB, atau Konkuren.
func Compare(vcA, vcB VectorClock) CompareResult {
	isLess := false
	isGreater := false

	// Cek dimensi A terhadap B
	for nodeA, countA := range vcA {
		countB := vcB[nodeA] // 0 jika ga ada
		if countA < countB {
			isLess = true
		} else if countA > countB {
			isGreater = true
		}
	}

	// Cek dimensi ekstra B yang tidak ada di A
	for nodeB, countB := range vcB {
		if _, exists := vcA[nodeB]; !exists {
			if countB > 0 {
				isLess = true // A ketinggalan
			}
		}
	}

	if isLess && isGreater {
		return Concurrent
	} else if isLess {
		return Before
	} else if isGreater {
		return After
	}
	return Equal
}

// --- HYBRID LOGICAL CLOCK (HLC) Konsep ---

type HLC struct {
	mu      sync.Mutex
	Wall    int64 // NTP Physical clock (microseconds)
	Logical int32 // Kausal counter untuk menampung event serentak pada ms yg sama
}

func NewHLC() *HLC { return &HLC{} }

func (c *HLC) Now() (int64, int32) {
	c.mu.Lock()
	defer c.mu.Unlock()

	sysTime := time.Now().UnixMicro()
	if sysTime > c.Wall {
		c.Wall = sysTime
		c.Logical = 0
	} else {
		// Clock skew terdeteksi, physical OS mundur, atau event menumpuk di 1 microsecond.
		// Abaikan wall clock baru, tambah counter logical!
		c.Logical++
	}
	return c.Wall, c.Logical
}

func (c *HLC) Update(remoteWall int64, remoteLogical int32) {
	c.mu.Lock()
	defer c.mu.Unlock()

	sysTime := time.Now().UnixMicro()
	
	// Cari timestamp terbesar
	maxWall := sysTime
	if remoteWall > maxWall { maxWall = remoteWall }
	if c.Wall > maxWall { maxWall = c.Wall }

	if maxWall == c.Wall && maxWall == remoteWall {
		// Dinding sama, adu logical counter
		if remoteLogical > c.Logical {
			c.Logical = remoteLogical + 1
		} else {
			c.Logical++
		}
	} else if maxWall == c.Wall {
		c.Logical++
	} else if maxWall == remoteWall {
		c.Logical = remoteLogical + 1
	} else {
		// SysTime (Masa Depan!)
		c.Logical = 0
	}
	c.Wall = maxWall
}


// --- Unit Test ---
func TestVectorClockCompare(t *testing.T) {
	vcA := VectorClock{"N1": 1, "N2": 1}
	vcB := VectorClock{"N1": 1, "N2": 2}

	if Compare(vcA, vcB) != Before {
		t.Errorf("vcA harusnya di anggap lebih usang (Before) dari vcB")
	}

	vcC := VectorClock{"N1": 2, "N2": 1} 
	// vcB(N1:1, N2:2) vs vcC(N1:2, N2:1) = CONCURRENT!
	if Compare(vcB, vcC) != Concurrent {
		t.Errorf("vcB dan vcC terjadi secara paralel, harus menghasilkan Concurrent")
	}
}

func TestHLC(t *testing.T) {
	hlc := NewHLC()
	w1, l1 := hlc.Now()
	
	// Simulasi NTP mundur di OS mesin (Jam bergerak lambat / sinkronisasi ulang mundur seabad)
	// Kita push remote clock yang lebih jauh ke masa depan
	hlc.Update(w1 + 9999, 5)
	
	w2, l2 := hlc.Now()
	
	if w2 < w1+9999 {
		t.Errorf("Wall clock HLC harusnya ngotot di masa depan meski NTP OS lokal tertinggal")
	}
	if l2 == 0 {
		t.Errorf("Logical clock harus terinkremen mengikuti push time buatan")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyelesaikan Resolusi Kausalitas Konflik Hanya Menggunakan (LWW) Last Write Wins Berbasis NTP
Jika 2 node yang terpisah jaringan sama-sama diupdate user pada 01:00:00, lalu saat tergabung kembali, backend mencomot timestamp NTP terbesar (Last-Write-Wins secara kasar).

```go
// BAD: NTP-based Last Write Wins murahan pada sistem kolaboratif multi-user
if dataRemote.TimestampOS > dataLocal.TimestampOS {
    save(dataRemote) // Data lokal dihapus sepihak tanpa bekas!
}
```

```go
// GOOD: Gunakan Vector Clocks, Deteksi Konflik Siblings, dan Merge
result := vectorclocks.Compare(dataRemote.VC, dataLocal.VC)
if result == vectorclocks.Concurrent {
    // Tahan! Kedua data sah karena terjadi tanpa sepengatahuan satu sama lain.
    // Kirim keduanya ke Client, biarkan User secara manual menyatukan dokumen, atau aplikasi 
    // otomatis me-merge isi keranjang belanjanya (CRDT).
    saveAsSiblings(dataLocal, dataRemote) 
} else if result == vectorclocks.After {
    save(dataRemote) // Aman, data remote memang kelanjutan resmi data lokal.
}
```
**Why dangerous:** Timestamp NTP di mesin Windows/Linux bisa berselisih 5-20ms secara wajar. Jika rely pada OS clock untuk sistem kolaborasi, ketikan dokumen user (CRDT/Cart) akan raib di-*overwrite* *(Silently Dropped/Data Loss)* semata-mata karena jam laptopnya telat 5 milidetik dari user lain.

### ❌ Anti-Pattern 2: Membiarkan Size Vector Clock Membengkak Tanpa Batas (Ghost Nodes)
Setiap kali ada pod node Kubernetes baru terbentuk, misal dengan nama `pod-xy4z`, node id baru ini akan disisipkan ke dalam Array Vector Clock setiap dokumen. Jika dalam setahun ada 10.000 pod yang silih berganti (Ephemeral), Payload Vector Clock dokumen Anda akan membengkak dari 10 Byte menjadi 150 KB untuk SATU row database, dipenuhi node hantu!

```go
// BAD: Menyimpan node ID ephemeral di Vector Clocks tanpa pembersihan
vc["pod-ephemeral-44111"] = 1
```

```go
// GOOD: Pruning / Node Tombstoning
// Harus ada background job / arsitektur khusus untuk merekapitulasi Vector Clocks node yang
// terkonfirmasi sudah dipensiunkan permanen dari klaster, menciutkannya ke satu 'Epoch' counter.
```
**Why dangerous:** Storage meledak & Kinerja Jaringan Hancur. Database yang harusnya berisi value 50 bytes `{"qty": 5}` kini harus mensinkronisasi header VC JSON sebesar puluhan kilobyte ke semua nodes setiap kali ada mutasi kecil.

## 5. Edge Cases & Defensive Programming

1. **Client Memanipulasi Clock / Timestamp Spoofing**
   Pada game online turn-based atau IoT Terdistribusi yang melibatkan HLC. Klien peretas secara sengaja mengatur jam PC-nya ke tahun 2099 lalu mengirim payload `Update(Event2099, eventLogical=0)`. Server menerima HLC ini dan `c.Wall` server akan terloncat ke masa depan secara absolut. Semenjak itu, semua event asli dari mesin lain di tahun 2026 akan ditolak atau dipaksa menggunakan `c.Logical++` tiada akhir.
   *Defensive Check:* **Max Offset Rejection**. HLC Server harus membatasi batas atas (Upper Bound Offset) dari `remoteWall` yang ia terima. Jika payload `remoteWall` melampaui `LocalSysTime + 500ms`, TOLAK paket (Drop) dan jangan pernah mengaplikasikannya ke HLC server memory lokal!

2. **Tipe Data Overflow pada Counter Logical HLC**
   Bila Jam Mesin lokal rusak (misal batere CMOS mati, jam reset ke tahun 1970). Mesin lain memompa HLC wall time tahun 2026. Mesin lokal akan terus menyadari Wall = 2026, tetapi karena hardware NTP nya nyangkut di 1970, operasi `Update/Now` akan *terus menerus* masuk blok `c.Logical++` miliaran kali setiap iterasi. Jika `Logical` menggunakan `int16`, ia akan *overflow* dan bernilai minus, merusak *causal ordering*.
   *Defensive Check:* Gunakan Minimal `uint32` untuk logical counter dan batasi batas aman (Threshold). Jika `c.Logical > 1000000`, server HARUS melakukan `panic()` atau `FatalLog()`, membunuh dirinya sendiri demi menghindari corruptnya cluster akibat jam OS lokalnya sedang kritis (Clock skew melebihi wajar).

3. **False Conflict karena Event Duplikasi**
   Sistem Message Broker (seperti Kafka) menjamin *At-Least-Once Delivery*. Node A mengirim Vector `[A:1]` tapi delay. Ia kirim lagi. Node B menerimanya dua kali.
   *Defensive Check:* Vector Clock IDEMPOTEN secara lahiriah jika tidak di-inkremen buta di tempat tujuan. Node B me-Merge `[A:1]` lalu me-Merge lagi `[A:1]`, hasil map tetap mentok di `[A:1]`. Selama payload id (Hash) diverifikasi keunikannya.
