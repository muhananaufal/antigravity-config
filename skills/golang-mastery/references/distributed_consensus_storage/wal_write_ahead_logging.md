# WAL (Write-Ahead Logging) Patterns

## 1. Konsep Utama & Internals

Write-Ahead Logging (WAL) adalah teknik fundamental nomor satu dalam sistem database (RDBMS seperti Postgres, Etcd, Kafka) untuk menjamin **ACID Durability**. 

Bayangkan sebuah *database engine*. Daripada ia repot-repot mensortir memori, mem-parsing blok Tree, dan menulis byte rumit ke banyak file acak (Random IO) pada saat user mengirim command `INSERT`, *database* cukup menuliskan instruksi "INSERT" tersebut di UJUNG (Append-Only) file log linear berurutan (Sequential IO) di disk, lalu dibumbui dengan konfirmasi sinkronisasi OS (`fsync`). Begitu `fsync` sukses, aplikasi klien diberi tahu "Data Aman!". *Background thread* nantinya akan membereskan *actual write* ke B-Tree / MemTable (asynchronous). Jika mesin mati di tengah-tengah? Pada startup, server sekadar me-replay ulang instruksi yang ada di ujung file WAL tersebut (Crash Recovery).

Konsep WAL:
1. **Append-Only Sequential I/O**: Memaksimalkan throughput disk fisik karena jarum (atau blok NAND SSD) tidak bergerak acak.
2. **Durability First**: Transaksi dianggap sukses HANYA SETELAH log berhasil menembus disk platens fisik.
3. **File Segmenting**: Jika file WAL tumbuh hingga 1 GB, WAL akan membuat file baru (segmentasi/rotasi), dan setelah data lama diterapkan ke disk (Checkpointed), file segmen kuno bisa dibuang untuk menghemat disk.

## 2. Diagram ASCII: Alur Sinkronisasi WAL

```text
  [ Client 1 ]              [ Client 2 ]
    (Insert X)               (Update Y)
        |                        |
        v                        v
+------------------------------------------------+
|                   WAL Buffer                   |
|              (In-Memory Channel/Queue)         |
+------------------------------------------------+
                       |
     (Group Commit / Batching Flush per 10ms)
                       v
+------------------------------------------------+
|       WAL FILE DI DISK (Append Only)           |
|                                                |
| [ CRC32 | LSN 100 | Cmd: Insert X | Payload ]  |
| [ CRC32 | LSN 101 | Cmd: Update Y | Payload ]  |
+------------------------------------------------+
                       |
               +--- [ FSYNC() OS Call ] ---+
               |                           |
        (Sukses Tulis)                     v
               |               [ Aplikasi / Klien di-Reply OK ]
               v
+------------------------------------------------+
|   Background Worker (Asinkron)                 |
|   Membaca RAM dan memodifikasi B-Tree Data Asli|
+------------------------------------------------+
```

## 3. Production-Ready Go Code (WAL Abstraction)

```go
package wal_pattern

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
	"testing"
)

// LogRecord mewakili struktur 1 blok data
// Layout disk: [CRC32(4 bytes) | Size(4 bytes) | Payload(Size bytes)]
type LogRecord struct {
	Data []byte
}

type WAL struct {
	mu      sync.Mutex
	file    *os.File
	writer  *bufio.Writer // Mengatur buffering in-memory agar syscall OS minim
	offset  int64
	syncOff int64 // melacak offset terakhir yang sudah masuk fsync
}

func OpenWAL(path string) (*WAL, error) {
	// Buka dengan O_APPEND untuk memastikan write berurutan linear di ekor
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return nil, err
	}

	stat, _ := f.Stat()
	offset := stat.Size()

	return &WAL{
		file:    f,
		writer:  bufio.NewWriterSize(f, 65536), // Buffer 64KB
		offset:  offset,
		syncOff: offset,
	}, nil
}

// Append membungkus dan menserialisasi payload lalu memasukannya ke write buffer RAM.
// Catatan: Ini BELUM fsync. Jika sistem mati disini, data hilang.
func (w *WAL) Append(data []byte) (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	size := uint32(len(data))
	crc := crc32.ChecksumIEEE(data)

	// Persiapkan block (4 byte CRC + 4 byte Size)
	header := make([]byte, 8)
	binary.LittleEndian.PutUint32(header[0:4], crc)
	binary.LittleEndian.PutUint32(header[4:8], size)

	// Tulis header
	if n, err := w.writer.Write(header); err != nil {
		return 0, err
	} else {
		w.offset += int64(n)
	}

	// Tulis payload aslinya
	if n, err := w.writer.Write(data); err != nil {
		return 0, err
	} else {
		w.offset += int64(n)
	}

	// Kembalikan offset penulisan untuk tracking 
	return w.offset, nil
}

// Sync mem-flush buffer ke kernel OS lalu memaksa physical disk untuk menulisnya.
// (Group Commit sering kali menunggu beberapa MS lalu memanggil fungsi ini sekali tembak)
func (w *WAL) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Flush buffer user space Go -> Kernel page buffer
	if err := w.writer.Flush(); err != nil {
		return err
	}
	
	// FSYNC Kernel -> Physical Disk (Magnetik/NAND) 
	// (Operasi ini blocking dan mahal! Sangat IO intensive)
	if err := w.file.Sync(); err != nil {
		return err
	}
	
	w.syncOff = w.offset
	return nil
}

func (w *WAL) Close() error {
	w.Sync()
	return w.file.Close()
}

// --- Iterator / Replay Recovery pada saat Booting ---

// ReplayIterator melahap satu per satu dari disk untuk validasi.
func (w *WAL) ReplayIterator() ([]*LogRecord, error) {
	// Pindahkan pointer ke awal file
	w.file.Seek(0, io.SeekStart)
	
	var records []*LogRecord
	
	for {
		header := make([]byte, 8)
		_, err := io.ReadFull(w.file, header)
		if err != nil {
			if err == io.EOF {
				break // Normal tuntas
			}
			if err == io.ErrUnexpectedEOF {
				// WAL file terpotong (crash saat write terakhir). 
				// Normal, abaikan data sisa korup ini.
				break 
			}
			return nil, err
		}

		crc := binary.LittleEndian.Uint32(header[0:4])
		size := binary.LittleEndian.Uint32(header[4:8])

		// Proteksi terhadap korupsi ekstrem (misal size jadi bermilyar2 bytes)
		if size > 1<<20 { // max 1 MB payload 
			return nil, errors.New("wal file corrupt: payload size exceed safety threshold")
		}

		payload := make([]byte, size)
		_, err = io.ReadFull(w.file, payload)
		if err != nil {
			break // Tailing file kepotong
		}

		// Validasi Integritas
		if crc32.ChecksumIEEE(payload) != crc {
			// CRC mismatch, hardware bitrot / write setengah jalan.
			break 
		}

		records = append(records, &LogRecord{Data: payload})
	}
	
	return records, nil
}


// --- Unit Test ---
func TestWALWriteSyncAndReplay(t *testing.T) {
	tmpFile := "test_wal_0001.log"
	defer os.Remove(tmpFile)

	wal, err := OpenWAL(tmpFile)
	if err != nil { t.Fatalf("gagal open: %v", err) }

	payload1 := []byte("COMMAND_A_1")
	payload2 := []byte("COMMAND_B_2")

	// Append (masuk RAM Bufio)
	wal.Append(payload1)
	wal.Append(payload2)

	// Paksa ke disk!
	if err := wal.Sync(); err != nil {
		t.Fatalf("sync error: %v", err)
	}

	wal.Close() // Matikan server

	// Server Start-Up Recovery!
	wal2, _ := OpenWAL(tmpFile)
	defer wal2.Close()

	records, err := wal2.ReplayIterator()
	if err != nil { t.Fatalf("Gagal iterasi replay wal: %v", err) }

	if len(records) != 2 {
		t.Errorf("Harusnya ada 2 record direcover, menemukan %d", len(records))
	}
	if !bytes.Equal(records[0].Data, payload1) {
		t.Errorf("Data WAL corrupt! record1 tak sesuai.")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Melakukan `fsync` pada Setiap Kali Operasi Append 
Developer yang paranoid akan data loss menulis kode di mana setiap pemanggilan `wal.Append` langsung diikuti eksekusi keras `wal.file.Sync()`.

```go
// BAD: Fsync per baris payload. Mencekik disk throughput.
func insertDB(data) {
    wal.Append(data)
    wal.Sync() // O(N) fsync overhead untuk Ribuan Request Per Detik (QPS).
    return "OK"
}
```

```go
// GOOD: Group Commit Pattern. Kumpulkan Ratusan Request, Sync sekali tembak.
// Thread A, B, C memanggil wal.Append dan diam mengantre via sync.Cond atau Channel.
// Satu background daemon akan dieksekusi setiap interval 10ms (atau jika bytes capai limit)
// untuk melakukan SATU wal.Sync() mewakili semuanya, lalu memberitahu Thread A, B, C untuk return "OK".
```
**Why dangerous:** Disk SSD modern mentok di angka 10.000 IOPS jika melakukan 4K Random IO dan Fsync per byte. Menyiksa *hardware disk* (merusak limit TBW). Melalui algoritma *Group Commit*, Etcd dan Postgres bisa merenggut *throughput* ratusan ribu transaksi per detik pada disk yang sama.

### ❌ Anti-Pattern 2: Tidak Menggunakan CRC Checksum di Tiap Blok
Berasumsi bahwa selama file tersimpan, berarti datanya utuh.

```go
// BAD: Menulis payload buta
func Append(data []byte) {
    size := len(data)
    binary.Write(file, size)
    file.Write(data)
}
```
**Why dangerous:** Listrik Data Center padam. OS Kernel tertunda mem-flush Page Cache, WAL file *fisik* hanya tertulis setengahnya (Torn Write). Ketika DB di-start ulang, parser membaca "Size=900", padahal *file ekor* baru tertulis 200 karakter sampah korup. Tanpa blok perlindungan CRC, engine akan me-replay sampah korup ini ke dalam B-Tree utama, dan menghancurkan integritas master data Anda (Data Corruption fatal).

## 5. Edge Cases & Defensive Programming

1. **Log Segment Rollover (Disk Penuh)**
   Jika WAL dibiarkan selamanya, file `001.log` akan menjadi raksasa (terabytes), disk meledak.
   *Defensive Check:* Segementasi. Pada saat write, periksa batas `w.offset > 512 * 1024 * 1024` (Misal 512MB). Jika melebihi batas, aplikasikan Lock sementara, buat file baru `002.log`, alihkan stream file descriptor ke file baru. Pekerja background lain akan men-trigger *Checkpointing* untuk memigrasikan aman semua logic ke database inti. Begitu rampung, hapus (Unlink) file `001.log` (Garbage Collection OS).
   
2. **Bit Rot & Partial Flush (Hardware Failure)**
   Sering terjadi di level SAN / NAS Cloud. Saat *Replay WAL Recovery*, Anda mendapati ada CRC Error padahal tidak sedang *end-of-file* (di tengah-tengah rentetan log).
   *Defensive Check:* **Truncate the Tail**. Begitu algoritma me-replay log dan menemukan CRC gagal atau *EOF mendadak*, ini pertanda "Titik Kematian Sistem (Crash Point)" sebelumnya. Berhentilah membaca log dari poin tersebut, anggap titik tersebut sebagai *Ujung File*, dan lakukan `os.Truncate` pada WAL dari byte tersebut untuk membersihkan data busuk sisa hardware error, sebelum server dipersilahkan menampung *write* Klien yang baru.
   
3. **Mmap / Page Cache Tuning**
   Developer sering menggunakan Mmap (`syscall.Mmap`) untuk membaca/menulis WAL karena terasa instan. 
   *Defensive Check:* Mmap kurang direkomendasikan untuk struktur File Log yang melulu *Append Only* dan menuntut ACID fsync. *Kernel page flusher* bekerja tidak terduga, dan *Torn Write* lebih tinggi. Standard library I/O (`os.File` dengan `O_APPEND` dan `Sync()`) jauh lebih andal untuk menstabilkan jaminan durability dan menghindari latensi *Page Fault* yang men-stall thread aplikasi.
