# LSM Storage Engine & Internals (Log-Structured Merge-Tree)

> **Berlaku:** Go 1.21+ · **Lihat juga:** `distributed_consensus_storage/wal_write_ahead_logging.md` · `distributed_consensus_storage/kv_badger_embedded.md` · `db_sqlc/index_design_explain_analyze.md` · `runtime_internals/memory_allocator_arenas.md`

## 1. Konsep Utama & Internals

LSM-Tree adalah fondasi (Storage Engine) dari datastore modern berskala besar (seperti Cassandra, RocksDB, LevelDB, dan BadgerDB). Database tradisional biasanya menggunakan struktur B-Tree yang ideal untuk *Reads* (karena operasi pencariannya cepat) namun terseok-seok pada rasio *Writes* tinggi dikarenakan fragmentasi dan pembaruan acak (Random IO) pada Disk berputar.

LSM-Tree membalikkan paradigma tersebut: Semua modifikasi data dipaksa menjadi berurutan secara temporal (**Sequential IO**), yang mana 10x - 100x lipat lebih cepat baik di disk Magnetik apalagi SSD.

Komponen Inti dari LSM:
1. **MemTable (In-Memory)**: Struktur tree dalam RAM (Bisa *SkipList* atau Red-Black tree). Semua operasi write awal masuk ke sini, yang otomatis ter-sortir.
2. **WAL (Write-Ahead Log)**: Data persistensi penyelamat bila server crash, merekam instruksi sebelum masuk MemTable.
3. **SSTable (Sorted String Table, on Disk)**: Ketika MemTable telah penuh, ia di-flush secara sekuensial (utuh) ke Disk dalam format *Immutable* yang disebut SSTable.
4. **Compaction (Leveling)**: Seiring berjalannya waktu, Disk akan dipenuhi puluhan file SSTable. Pekerja latar (Background worker) secara asinkron membaca tabel yang berlapis-lapis ini, menggabungkannya, membuang data yang kadaluwarsa (deleted / tombstone), lalu menulisnya kembali (Merge). 

## 2. Diagram ASCII: Alur Penulisan & Pemadatan LSM-Tree

```text
    [ Write Request: Put(K,V) ]
                |
                v
    +-------------------------+
    |   MemTable (RAM)        |  ---> (Terurut Otomatis, Misal via SkipList)
    |   Limit: misal 64 MB    |
    +-------------------------+
                |
     (MemTable penuh, Flush ke L0)
                |
                v
    +=====================================================+
    |                      DISK                           |
    |                                                     |
    |  Level 0 (L0): [SSTable_1] [SSTable_2] [SSTable_3]  |
    |               (Saling overlap rentang kuncinya)     |
    |                       |                             |
    |        (Compaction)   v                             |
    |                                                     |
    |  Level 1 (L1): [ SSTable_4  | SSTable_5  ]          |
    |               (Diurutkan, tidak overlap)            |
    |                       |                             |
    |        (Compaction)   v                             |
    |                                                     |
    |  Level 2 (L2): [ SSTable_6 | SSTable_7 | SSTable_8 ]|
    +=====================================================+
```

## 3. Production-Ready Go Code (Simulasi LSM Flush & Tombstone)

Karena membuat engine LSM penuh mencapai ribuan baris, kode Go di bawah mengilustrasikan mekanisme internal yang sangat krusial: transisi dari *MemTable* (SkipList in-memory) ke pembuangan (Flush) simulasi *SSTable* dengan Tombstone (Deletions).

```go
package lsm_engine

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"sort"
	"sync"
	"testing"
	"time"
)

const TombstoneValue = "__DELETED__"

// Entry merepresentasikan satu sel record di memori
type Entry struct {
	Key       string
	Value     string
	Timestamp int64 // Penting untuk conflict resolution / compaction
}

// MemTable adalah penyimpanan in-memory (Di produksi sungguhan menggunakan arena-allocated SkipList)
type MemTable struct {
	mu      sync.RWMutex
	entries map[string]*Entry // Simulasi, tidak tersortir
	size    int
	maxSize int
}

func NewMemTable(max int) *MemTable {
	return &MemTable{
		entries: make(map[string]*Entry),
		maxSize: max,
	}
}

// Put menambahkan atau memperbarui data (Update di LSM itu sama persis dengan Put, yaitu menumpuk)
func (mt *MemTable) Put(key, val string) bool {
	mt.mu.Lock()
	defer mt.mu.Unlock()

	// Menghitung delta memori
	newEntry := &Entry{Key: key, Value: val, Timestamp: time.Now().UnixNano()}
	mt.entries[key] = newEntry
	
	// Simulasi hitung bytes
	mt.size += len(key) + len(val)

	// Kembalikan boolean 'apakah sudah penuh?'
	return mt.size >= mt.maxSize
}

// Delete menaruh "Batu Nisan" (Tombstone) pada data. 
// LSM tidak pernah men-delete secara brutal di tengah file/memori.
func (mt *MemTable) Delete(key string) bool {
	return mt.Put(key, TombstoneValue)
}

// Get mencari data terbaru
func (mt *MemTable) Get(key string) (string, bool) {
	mt.mu.RLock()
	defer mt.mu.RUnlock()

	if ent, ok := mt.entries[key]; ok {
		if ent.Value == TombstoneValue {
			return "", false // Secara logika sudah dihapus (Tombstone)
		}
		return ent.Value, true
	}
	return "", false // Tidak ada di memTable, engine nanti harus cek ke file SSTable Disk (L0 -> L1 dst)
}

// Flush mensimulasikan pembuangan isi RAM menjadi file Immutable SSTable tersortir
func (mt *MemTable) FlushToSSTable() []byte {
	mt.mu.Lock()
	defer mt.mu.Unlock()

	// 1. Ekstrak dan Urutkan Keys (Penting untuk Pencarian Binari/SSTable di Disk nantinya)
	var keys []string
	for k := range mt.entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	// 2. Tulis Buffer Sekuensial
	var buffer bytes.Buffer
	for _, k := range keys {
		ent := mt.entries[k]
		// Format disk pseudo (Key|Timestamp|Value)
		buffer.WriteString(fmt.Sprintf("%s|%d|%s\n", ent.Key, ent.Timestamp, ent.Value))
	}

	// 3. Reset MemTable setelah di flush
	mt.entries = make(map[string]*Entry)
	mt.size = 0

	return buffer.Bytes()
}

// --- Unit Test ---
func TestLSMTombstoneLogic(t *testing.T) {
	mt := NewMemTable(1024)

	// 1. Put Data
	mt.Put("user:123", "alice")
	mt.Put("user:999", "bob")
	
	// Update (hanya menambah record penumpuk di memori)
	mt.Put("user:123", "alice_updated")

	// 2. Baca data terbaru (Menghasilkan alice_updated karena timestamp/insert belakangan nimpa map)
	val, found := mt.Get("user:123")
	if !found || val != "alice_updated" {
		t.Errorf("Harusnya alice_updated, tapi dapat %v", val)
	}

	// 3. Delete Data (menggunakan Tombstone)
	mt.Delete("user:123")

	// Memastikan Delete di engine LSM memblokir view
	_, foundAfterDel := mt.Get("user:123")
	if foundAfterDel {
		t.Errorf("Data user:123 harusnya terhapus dan ditutup oleh tombstone marker")
	}

	// 4. Flush ke SSTable imajiner
	sstFile := mt.FlushToSSTable()
	log.Printf("SSTable Output pada Disk:\n%s", string(sstFile))
	
	// Bukti bahwa marker __DELETED__ tetap ditulis ke disk agar memblokir data versi 
	// yang lebih usang yang mungkin masih tertinggal di level L1 / L2 di disk bawah.
	if !bytes.Contains(sstFile, []byte(TombstoneValue)) {
		t.Errorf("SSTable kehilangan jejak tombstone! Data lama bisa bangkit dari kubur (Zombie Data).")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: In-Place Update & Deletion pada Disk
Mengimitasi database RDBMS konvensional dengan mencari byte *offset* di disk lalu meniban/menghapus byte persis di blok tersebut (In-Place Edit).

```go
// BAD: Mencari offset pointer lalu me-rewrite disk I/O acak
func updateRecord(file *os.File, offset int, newVal string) {
    file.Seek(int64(offset), 0)
    file.Write([]byte(newVal)) // Fatal untuk IOPS Disk, dan berbahaya jika listrik putus di tengah byte
}
```

```go
// GOOD: Paradigma Immutable Append-Only (Tumpuk terus, ratakan di background)
func putRecord(mem *MemTable, key, newVal string) {
    // Selalu tulis data BARU sebagai baris paling akhir, abaikan keberadaan baris lama di file disk.
    // Compaction job lah yang akan membuang baris lama suatu hari nanti.
    mem.Put(key, newVal)
}
```
**Why dangerous:** In-place modification pada arsitektur modern (terutama SSD yang menggunakan blok fisik *NAND Gate Flash*) sangat merusak (menyebabkan *Write Amplification* pada hardware level). Jika sistem *crash* di tengah modifikasi blok disk, struktur file tersebut akan corrupt secara permanen tanpa harapan *recoverability*.

### ❌ Anti-Pattern 2: Melupakan Tombstone Marker Saat Proses Compaction
Ketika pekerja Compaction (L0 ke L1) dijalankan dan menyatukan 2 file lama. Developer melihat tanda *__DELETED__* (Tombstone) lalu berasumsi: "Oh, ini mau dihapus? Bagus, langsung jangan ditulis lagi ke file baru".

```go
// BAD: Membuang Tombstone terlalu dini di level atas
if record.Value == "__DELETED__" {
    // Skip, jangan sertakan di L1!
    continue 
}
```

```go
// GOOD: Tombstone HARUS dipertahankan hingga mencapai dasar paling bawah (L-max)
if record.Value == "__DELETED__" {
    if currentLevel == maxLevelOfLSM {
        // Hanya buang jika kita sudah mentok di lantai dasar (tidak ada lagi versi kuno yang bisa muncul)
        continue 
    }
    // Jika masih di L0, L1, terus turunkan Tombstone ini ke file bawahnya
    writeSST(record)
}
```
**Why dangerous:** Fenomena *Zombie Data Bangkit dari Kubur*. Jika Anda memiliki file L2 (tua) yang masih menampung data `user:1=Joko`, lalu di L0 (baru) Anda menghapus `user:1`, *Tombstone* tersebut harus menutupi L2. Jika saat pemadatan file L0 dan L1 Anda iseng membuang *Tombstone* tersebut secara prematur (karena berpikir hemat *space*), iterasi selanjutnya akan "menembus" ke L2 dan si 'Joko' yang telah tiada akan tiba-tiba nongol lagi di aplikasi.

## 5. Edge Cases & Defensive Programming

1. **Write Stalls (MemTable Flush Macet)**
   Jika throughput aplikasi masuk mencapai gigabytes per detik (melebihi kecepatan disk HDD/SSD menyerap dan menulis ke SSTable file), maka MemTable di memori akan *full* 100%. Laju aplikasi Anda akan ditahan / di-rem mendadak (*Write Stalled*) agar RAM tidak OOM.
   *Defensive Check:* Mengonfigurasi `MemTable Size` secukupnya dan memastikan `Write Buffer` memiliki beberapa duplikat (misal 3-4 memtable). Saat 1 memtable penuh dan mengantre giliran masuk disk, Engine otomatis beralih menampung Write ke Memtable cadangan ke-2. Anda juga harus memastikan laju I/O Disk sesuai.

2. **Read Amplification (SSTable Terlalu Banyak)**
   Mencari kunci `id:777`. Jika tidak ketemu di MemTable, engine harus membuka L0. Di L0 karena rentangnya *overlap*, ia harus mencari di SEMUA file L0. Jika ada 5 file, ia membaca 5 file. Jika tak ketemu, turun ke L1, dan seterusnya. Ini sangat melambatkan baca (Read Amplification).
   *Defensive Check:* Gunakan **Bloom Filters**. Tanamkan bitmask kecil *Bloom Filter* pada *footer* setiap file SSTable di disk yang langsung bisa memberikan respon pasti: "Data id:777 100% TIDAK ADA di file ini". Dengan cara ini, bacaan yang menembus ratusan file bisa mem-*bypass* / *skip* pembacaan fisik IO dari disk dan meluncur tajam mencari file yang benar-benar memilikinya.

3. **WAL (Write Ahead Log) Corruption / Panic**
   Listrik datacenter terputus dan proses sinkronisasi fsync dari WAL file tidak utuh (terpotong pada karakter byte terakhir). Ketika Node di-*restart*, inisialisasi awal (startup phase) akan gagal dan *panic* saat mengurai file WAL untuk *recovery*.
   *Defensive Check:* Selalu sertakan validasi CRC-32 (Cyclic Redundancy Check) *checksum header* untuk setiap baris / *chunk* record di WAL. Jika parser menemukan *mismatch* CRC (misal file kepotong/corrupt ekornya), *Trunk* (potong) record *corrupt* tersebut, terima *partial loss* minor untuk beberapa record terakhir (maksimum sekian millisecond per batch), dan biarkan engine tetap *StartUp* memutar sisa database.

## Kapan JANGAN Pakai Ini

- **Untuk beban yang didominasi baca acak.** LSM menukar amplifikasi baca demi throughput tulis. Bila pola Anda adalah banyak baca acak dan sedikit tulis, B-tree lebih tepat — dan PostgreSQL sudah menyediakannya.
- **Tanpa memantau amplifikasi tulis dan kesehatan kompaksi.** Kompaksi yang tertinggal membuat setiap baca menyentuh lebih banyak level, dan latensi baca memburuk perlahan tanpa satu pun perubahan kode.
- **Menulis LSM sendiri.** Jumlah detail yang harus benar sangat besar, dan kesalahan pada level mana pun berarti kehilangan data. Pakai yang sudah teruji di produksi orang lain.
- **Menghapus tanpa memahami masa hidup tombstone.** Penghapusan tidak langsung membebaskan ruang; ia menambah penanda yang baru hilang setelah kompaksi mencapai level terbawah.
- **Mengasumsikan latensi seragam.** Kompaksi menghasilkan lonjakan p99 yang teratur. Itu sifat LSM, bukan bug — dan harus dimasukkan ke dalam anggaran latensi Anda.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Latensi baca memburuk perlahan | jumlah level dan file per level | Kompaksi tertinggal dari laju tulis |
| p99 melonjak berkala | jadwal kompaksi | Kompaksi berjalan; ini sifat LSM |
| Ruang disk tidak turun setelah hapus | tombstone yang belum dikompaksi | Penghapusan belum mencapai level terbawah |
| Amplifikasi tulis tinggi | byte tertulis vs byte logis | Konfigurasi level tidak cocok dengan beban |
| Baca menyentuh banyak file | bloom filter | Filter tidak efektif atau tidak aktif |

```bash
# Statistik engine: level, file per level, dan antrean kompaksi
curl -s localhost:9090/metrics | grep -E 'lsm_(levels|compaction|sstables|write_amp)'

# Berapa banyak byte fisik ditulis dibanding byte logis
iostat -x 1 5 | head -20
du -sh /var/lib/app/data/

# Kompaksi yang tertinggal terlihat sebagai jumlah file di level 0
ls /var/lib/app/data/*.sst 2>/dev/null | wc -l
```
