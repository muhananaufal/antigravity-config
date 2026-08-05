# Embedded KV Storage: BadgerDB Pattern

> **Berlaku:** Go 1.21+ · `dgraph-io/badger/v4` · **Lihat juga:** `distributed_consensus_storage/lsm_storage_engine.md` · `distributed_consensus_storage/wal_write_ahead_logging.md` · `devops_control_planes/docker_container_go.md` · `runtime_internals/gc_mark_sweep_internals.md`

## 1. Konsep Utama & Internals

`BadgerDB` (oleh Dgraph) adalah sistem penyimpanan *key-value* (KV) sangat cepat berbasis Go yang ditulis dari nol, beroperasi murni secara tertanam (embedded) layaknya RocksDB atau BoltDB. Badger tidak memerlukan server / port terpisah; ia menyatu bersama memori aplikasi Go (In-Process Datastore).

Perbedaan radikal Badger dibandingkan B-Tree (seperti bbolt):
1. **LSM-Tree Berbasis Log (Log-Structured Merge-Tree)**: Dirancang untuk menangani beban *Write* (Insert/Update) berkecepatan ekstrem yang tidak dapat dicapai B-Tree klasik.
2. **Pemisahan Kunci dan Nilai (Key-Value Separation) (WiscKey Paper)**: Kunci disimpan di dalam *LSM Tree* memori (berukuran mungil), sedangkan *Value* besar yang berat ditulis dalam Value Log (vlog) pada disk. Hal ini membuat RAM requirement sangat minim dan Garbage Collection jauh lebih efisien.
3. **Optimisasi SSD**: Ditulis sepenuhnya dengan pola sekuensial yang memaksimalkan umur IOPS dan TBW (Terabytes Written) dari Solid-State Drives.
4. **Transaksi MVCC (Multi-Version Concurrency Control)**: Mendukung transaksi penuh dengan ACID guarantee, memungkinkan pembacaan (Reads) tanpa menge-block operasi tulis (Writes).

## 2. Diagram ASCII: Arsitektur WiscKey (Badger)

```text
    +-----------------------------------------------+
    |                  Aplikasi Go                  |
    |      (Memanggil db.Update() / db.View())      |
    +-----------------------+-----------------------+
                            |
           [ 1. Transaksi / Batch Write ]
                            v
    +-----------------------------------------------+
    |                  BADGER DB                    |
    |                                               |
    |  +--------------------+  +-----------------+  |
    |  |     LSM Tree       |  |   Value Log     |  |
    |  |  (Key + Pointers)  |  |   (Actual Data) |  |
    |  |    (In-Memory)     |  |   (On Disk)     |  |
    |  |                    |  |                 |  |
    |  |  k1 -> pointer_v1 -+--+-> "Payload_1..."|  |
    |  |  k2 -> pointer_v2 -+--+-> "Payload_2..."|  |
    |  +--------------------+  +-----------------+  |
    +-----------------------------------------------+
                (Compaction & Garbage Collection Berjalan Asinkron)
```

## 3. Production-Ready Go Code

```go
package badger_embedded

import (
	"context"
	"fmt"
	"log"
	"testing"
	"time"

	"github.com/dgraph-io/badger/v4"
)

// BadgerManager mengatur lifecycle storage engine
type BadgerManager struct {
	db *badger.DB
}

// NewBadgerManager menyiapkan DB dengan setting produksi optimal
func NewBadgerManager(dir string) (*BadgerManager, error) {
	// Gunakan preset default, sangat optimal untuk SSD
	opts := badger.DefaultOptions(dir)
	// Matikan log bawaan jika tidak perlu verbose / sesuaikan dengan logger app
	opts.Logger = nil

	db, err := badger.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open badger DB at %s: %w", dir, err)
	}

	bm := &BadgerManager{db: db}
	
	// Jalankan rutin Garbage Collector asinkron (Esensial untuk tipe storage LSM)
	go bm.runGarbageCollection()

	return bm, nil
}

// runGarbageCollection membuang histori value usang (compaction) secara rutin.
func (bm *BadgerManager) runGarbageCollection() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		log.Println("Menjalankan Badger Garbage Collection (Value Log Purge)...")
		
		// RunValueLogGC me-return error ringan `ErrNoRewrite` jika db belum cukup terfragmen.
		// Kami mengatur rasio 0.5 (membuang log jika >50% data di dalamnya sudah usang/terhapus).
	again:
		err := bm.db.RunValueLogGC(0.5)
		if err == nil {
			// Berhasil, jalankan GC loop lagi karena mungkin masih ada log usang
			goto again
		}
	}
}

// SetUser menyimpan atau mengupdate user menggunakan Write Transaction.
func (bm *BadgerManager) SetUser(ctx context.Context, userID string, payload []byte) error {
	// db.Update membungkus R/W Transaction yang di-commit secara otomatis jika tak ada error.
	err := bm.db.Update(func(txn *badger.Txn) error {
		// Menggunakan key string, tapi di badger jadi []byte
		key := []byte(fmt.Sprintf("user:%s", userID))
		
		// SetEntry memungkinkan kita menyisipkan payload.
		// (Optional: tambahkan TTL jika ini berfungsi ganda sbg cache: .WithTTL(24 * time.Hour))
		entry := badger.NewEntry(key, payload)
		
		return txn.SetEntry(entry)
	})
	
	if err != nil {
		return fmt.Errorf("failed to write user data: %w", err)
	}
	return nil
}

// GetUser membaca payload user menggunakan Read-only Transaction (View).
func (bm *BadgerManager) GetUser(ctx context.Context, userID string) ([]byte, error) {
	var valCopy []byte

	err := bm.db.View(func(txn *badger.Txn) error {
		key := []byte(fmt.Sprintf("user:%s", userID))
		item, err := txn.Get(key)
		if err != nil {
			return err // Akan mengembalikan badger.ErrKeyNotFound jika tak ada
		}

		// AWAS! Nilai pointer item.Value() hanya valid DI DALAM block View ini.
		// Jika ingin dikembalikan dan dipakai di luar, HARUS dicopy dengan ValueCopy.
		valCopy, err = item.ValueCopy(nil)
		if err != nil {
			return err
		}
		return nil
	})

	if err != nil {
		if err == badger.ErrKeyNotFound {
			return nil, nil // Interpretasi normal, not found
		}
		return nil, fmt.Errorf("failed to fetch user data: %w", err)
	}

	return valCopy, nil
}

// Close mensinkronisasi write-buffer tersisa di memori ke disk dan menutup locks secara aman.
func (bm *BadgerManager) Close() error {
	if bm.db != nil {
		log.Println("Closing BadgerDB connection and syncing to disk...")
		return bm.db.Close()
	}
	return nil
}


// --- Unit Test ---
func TestBadgerStorageEngine(t *testing.T) {
	// Gunakan memori lokal atau temp dir untuk testing
	opts := badger.DefaultOptions("").WithInMemory(true).WithLogger(nil)
	db, err := badger.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	bm := &BadgerManager{db: db}
	defer bm.Close()

	ctx := context.Background()

	// 1. Uji Tulis
	err = bm.SetUser(ctx, "U_9000", []byte("JOHN DOE"))
	if err != nil {
		t.Fatalf("SetUser failed: %v", err)
	}

	// 2. Uji Baca
	val, err := bm.GetUser(ctx, "U_9000")
	if err != nil {
		t.Fatalf("GetUser failed: %v", err)
	}
	if string(val) != "JOHN DOE" {
		t.Errorf("Ekspektasi JOHN DOE tapi mendapat %s", string(val))
	}

	// 3. Uji Not Found
	valNotFound, err := bm.GetUser(ctx, "U_UNKNOWN")
	if err != nil {
		t.Fatalf("Should not error but return nil: %v", err)
	}
	if valNotFound != nil {
		t.Errorf("Seharusnya nil, mendapat %v", valNotFound)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Referensi Value di Luar Blok Transaksi (Memory Corruption)
Slice memori yang didapatkan via pemanggilan `item.Value(func(val []byte))` atau `item.Value()` dipetakan langsung ke *memory-mapped (mmap) file buffer* Badger. Menggunakannya setelah rutinitas `.View` (Transaksi) selesai adalah Ilegal dan menyebabkan *Memory Corruption / Segmentation Fault*.

```go
// BAD: Mengembalikan pointer langsung yang ditarik dari MMAP pool ke luar scope txn.
func (bm *BadgerManager) GetBad(key string) ([]byte, error) {
    var leakingData []byte
    bm.db.View(func(txn *badger.Txn) error {
        item, _ := txn.Get([]byte(key))
        leakingData, _ = item.ValueCopy(nil) // WAIT, jika pakai `item.Value()` langsung, ITU BENCANA.
        
        // Misal begini (Badger v4 api):
        _ = item.Value(func(val []byte) error {
            leakingData = val // POINTER DARI MMAP BOCOR
            return nil
        })
        return nil
    })
    return leakingData, nil // Saat diakses di controller HTTP, memori ini sudah dioverwrite data orang lain!
}
```

```go
// GOOD: Gunakan `.ValueCopy(nil)` yang membuahkan slice alokasi RAM (Heap) baru yang aman 100%.
func (bm *BadgerManager) GetGood(key string) ([]byte, error) {
    var safeData []byte
    bm.db.View(func(txn *badger.Txn) error {
        item, _ := txn.Get([]byte(key))
        safeData, _ = item.ValueCopy(nil) // Mengkloning bytes mmap ke RAM Heap Go standar
        return nil
    })
    return safeData, nil 
}
```
**Why dangerous:** Data korup secara misterius (Data Corruption). API Controller Anda membaca variabel `leakingData`, yang pada saat di-encode ke JSON secara ajaib nilainya berubah (karena *block memori mmap* di background telah didaur ulang untuk request lain). Aplikasi dapat mengirimkan data kartu kredit user A ke user B.

### ❌ Anti-Pattern 2: Tidak Pernah Memanggil ValueLogGC() pada Produksi
Engine tipe LSM dan WiscKey tidak menghapus record lama seketika. Meng-*Update* key dari X ke Y akan menulis Y baru ke ujung file *Append Only Log*. Histori file akan membengkak tiada akhir (Space Amplification).

```go
// BAD: Setup DB dan biarkan begitu saja tanpa goroutine GC
db, _ := badger.Open(opts)
// ... dan jalan selamanya
```

```go
// GOOD: Gunakan routine ticker yang memanggil RunValueLogGC untuk mengkonsolidasikan data secara senyap.
go func() {
    ticker := time.NewTicker(10 * time.Minute)
    for range ticker.C {
        db.RunValueLogGC(0.5) 
    }
}()
```
**Why dangerous:** Disk Exhaustion. Database kecil dengan total unik data 10 MB yang diupdate jutaan kali per jam secara bertahap akan memakan Disk Space server hingga 200 GB. Operasi Tulis (Write) perlahan menjadi lambat, Inodes habis, OS hang dan me-restart VM cloud Anda.

## 5. Edge Cases & Defensive Programming

1. **Transaction Terlalu Besar (ErrTxnTooBig)**
   Jika Anda mencoba me-loop jutaan baris *Put* di dalam satu rutin tunggal `.Update()`, batas limit memori transaksional akan jebol dan menghasilkan `badger.ErrTxnTooBig`.
   *Defensive Check:* Gunakan Batching. Alih-alih melooping update langsung, pakai package abstrak `badger.WriteBatch` (`db.NewWriteBatch()`). API WriteBatch otomatis akan men-*commit* partisi secara aman ke disk setiap memori sudah penuh dan transparan buat developer.

2. **File Lock Crash (Menangani Panic/SigKill Kasar)**
   Badger mengunci (LOCK file) direktori pada OS. Jika server di *kill -9 (SIGKILL)* paksa atau mati daya seketika, proses Go tidak sempat mengeksekusi `db.Close()`. Ketika container di restart, Badger akan menolak dibuka karena menganggap masih ada service lain yang memegang Lock tersebut (Direktori kotor).
   *Defensive Check:* Opsi default Badger telah mencoba meredam isu LOCK ini, namun pada OS spesifik, Anda harus menyertakan opsi *BypassLockGuard* (Sangat tidak direkomendasikan kecuali anda yakin node tersebut fully isolated, e.g. K8s ephemeral pod restart). Pastikan K8s `terminationGracePeriodSeconds` di-set lega (30s) agar Pod bisa `defer db.Close()` secara teratur di OS Signal SIGTERM.

3. **Iterator Prefetching & Memori Bloat**
   Saat Anda melakukan Query (Iterate) dari A sampai Z, Badger secara agresif men-*prefetch* Value Log agar iterasi kencang. Jika database besarnya ratusan GB, iterator bisa mengkonsumsi RAM signifikan jika tidak disetting.
   *Defensive Check:* Setel `PrefetchValues = false` pada opsi `badger.IteratorOptions` apabila Anda hanya ingin mencari Keys saja, atau memproses Key dengan sangat lamban. Ini mencegah badger memenuhi RAM sembari Anda mengerjakan logic panjang per item-nya.

## Kapan JANGAN Pakai Ini

- **Bila data perlu diakses banyak proses.** Badger mengunci direktorinya untuk satu proses. Dua replika aplikasi yang menunjuk ke volume yang sama akan gagal start, dan pada volume bersama yang salah konfigurasi bisa merusak data.
- **Tanpa rencana backup dan pemulihan.** Embedded berarti tidak ada operator database yang menjaganya. Backup, verifikasi backup, dan latihan pemulihan menjadi tanggung jawab Anda sepenuhnya.
- **Menyimpan nilai besar tanpa memahami value log.** Badger memisahkan kunci dan nilai; nilai besar masuk value log yang butuh garbage collection tersendiri, dan ruangnya tidak dibebaskan otomatis.
- **Tanpa menjalankan `RunValueLogGC` secara terjadwal.** Ruang disk tidak akan pernah kembali, dan pertumbuhannya baru disadari ketika volume penuh.
- **Di pod tanpa volume persisten.** Data hilang setiap kali pod dijadwalkan ulang — dan penjadwalan ulang bisa terjadi kapan saja tanpa pemberitahuan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Aplikasi gagal start dengan galat lock | berapa proses membuka direktori | Dua instans menunjuk volume yang sama |
| Disk terus tumbuh meski data dihapus | value log GC | GC tidak pernah dijalankan |
| Data hilang setelah pod dipindah | jenis volume | `emptyDir` alih-alih PVC |
| Latensi tidak stabil | kompaksi LSM di bawahnya | Sifat LSM; masukkan ke anggaran latensi |
| Pemulihan gagal saat dibutuhkan | apakah backup pernah diuji | Backup tidak pernah diverifikasi |

```bash
# Ukuran direktori dan pemisahan sst/vlog
du -sh /var/lib/app/badger/
ls -la /var/lib/app/badger/ | awk '{print $5, $9}' | sort -rn | head

# Volume harus persisten -- emptyDir berarti data hilang tiap penjadwalan ulang
kubectl get pod <pod> -o jsonpath='{.spec.volumes}' | jq

# Value log GC WAJIB terjadwal, dan hasilnya harus terlihat di metrik
curl -s localhost:9090/metrics | grep -E 'badger_(vlog|gc|lsm)'
```
