# Realtime Networking: Custom Binary Protocol di Go

## 1. Konsep dan Internals

Membangun protokol biner khusus (*Custom Binary Protocol*) seringkali dibutuhkan di lingkungan di mana performa, ukuran *payload*, dan *overhead* CPU menjadi kendala utama (contoh: *game multiplayer realtime*, *High Frequency Trading*, IoT dengan *bandwidth* terbatas). Menggunakan format teks universal seperti JSON (tebal dan *CPU intensive* untuk *parsing*) atau HTTP/1.1 (header panjang dan boros) bukanlah solusi ideal.

Protokol biner menyandikan struktur data langsung menjadi urutan *bytes* (*byte arrays*). Go, dengan kemampuan *low-level slice manipulation* dan package standar `encoding/binary`, sangat kuat dalam memproses protokol biner mentah.

**Anatomi Protokol Biner Berbasis TCP:**
TCP adalah aliran data berkelanjutan (*continuous stream*). Tidak ada konsep "paket" bagi TCP di level aplikasi; jika Anda memanggil `Write([]byte("HELLO"))` dua kali, di ujung *receiver* bisa saja data dibaca sebagai `"HE"` pada pembacaan pertama dan `"LLOHELLO"` pada pembacaan kedua (*TCP Framing issue*).
Oleh karena itu, protokol biner kustom WAJIB mendefinisikan batas pesannya sendiri (Pola Length-Prefixed).
1.  **Header:** Bagian statis, biasanya mendefinisikan *Magic Bytes* (untuk validasi), *Version*, *Opcode/Command Type*, dan yang paling penting: *Payload Length*.
2.  **Payload:** Data dinamis yang panjangnya sama dengan yang disebutkan di header.

**State Machine Parsing Koneksi TCP:**
Karena TCP adalah stream, implementasi ideal membutuhkan *State Machine* per koneksi untuk melacak fase pembacaan:
```text
[STATE_WAIT_HEADER] ---> (Read 5 Bytes) ---> [STATE_PARSE_HEADER]
                                                     |
               +-------------------------------------+
               v
[STATE_WAIT_PAYLOAD] ---> (Read N Bytes) ---> [STATE_PROCESS_FRAME]
               |                                     |
               +-------------------------------------+ (Loop back)
```

## 2. Diagram ASCII: Struktur Frame Length-Prefixed

```text
+-------------------------------------------------------------+
|                     TCP Stream Byte Buffer                  |
| 0xA1 0x01 0x00 0x05 | 0x48 0x45 0x4C 0x4C 0x4F | 0xA1 0x02..|
+--+----+---+---------+--------------------------+------------+
   |    |   |    |                 |                   ^
   |    |   |    |                 |                   |
   |    |   |    +---- Length (2 bytes, uint16, BigEndian) -> 5
   |    |   |
   |    |   +--------- Opcode (1 byte) -> 0 (Ping), 1 (Data)
   |    |
   |    +------------- Version (1 byte) -> 1
   |
   +------------------ Magic Byte (1 byte) -> 0xA1 (Validasi Header)

   [---- HEADER (5 Bytes) ----] [--- PAYLOAD (5 Bytes) ---]
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan `encoding/gob` Secara Bebas untuk Komunikasi Eksternal

Banyak *developer* melihat library standar `encoding/gob` dan tergoda menggunakannya untuk komunikasi jaringan (*RPC-style*).

```go
// ❌ BAD: Menggunakan GOB untuk jaringan publik atau multi-bahasa
encoder := gob.NewEncoder(conn)
decoder := gob.NewDecoder(conn)
// ...
decoder.Decode(&myStruct)
```
**Why dangerous:** 
1. `gob` hanya dimengerti oleh Go. Jika klien berubah menggunakan Python/C++, Anda harus me- *rewrite* seluruh protokol.
2. `gob` sangat lambat dibanding serialisasi biner spesifik seperti Protobuf/FlatBuffers.
3. Kerentanan DoS. Dekoder GOB yang dikirim dari klien tidak terpercaya dapat dialihkan untuk memakan semua memori alokasi jika *type definition* dimanipulasi (*denial of service via memory exhaustion*).

```go
// ✅ GOOD: Rancang Header Manual (binary.BigEndian) dipadu Payload spesifik
// seperti Protocol Buffers, FlatBuffers, atau cukup Raw Bytes (jika sederhana).
```

### ❌ Anti-Pattern 2: Kegagalan Menangani *Partial Reads* (TCP Framing Defect)

Ini adalah sumber *bug* tersering di pemrograman socket. Pengembang berasumsi `conn.Read(buf)` akan mereturn satu pesan utuh sesuai yang dikirim dari klien.

```go
// ❌ BAD: Asumsi 1 Read = 1 Logical Packet
func handle(conn net.Conn) {
    buf := make([]byte, 1024)
    n, _ := conn.Read(buf) // Klien mengirim 10 byte, tapi TCP baru tiba 2 byte!
    
    // Program akan crash (Index out of bounds) karena membaca header yang tidak lengkap
    length := binary.BigEndian.Uint16(buf[3:5]) 
}
```
**Why dangerous:** *State corruption / Panic*. Data di buffer terpotong, program mencoba me-*parsing* sampah, mereturn alokasi *length* 60.000 byte dan mematikan server.

```go
// ✅ GOOD: Gunakan io.ReadFull untuk menjamin bytes yang diminta TUNTAS
func handle(conn net.Conn) {
    headerBuf := make([]byte, 5) // Panjang header fixed 5 bytes
    _, err := io.ReadFull(conn, headerBuf) // Block sampai genap 5 bytes masuk
    if err != nil { return }
    
    length := binary.BigEndian.Uint16(headerBuf[3:5])
    
    payloadBuf := make([]byte, length)
    _, err = io.ReadFull(conn, payloadBuf) // Block sampai body utuh masuk
}
```

## 4. Edge Cases & Defensive Programming

1.  **Endianness (Big vs Little Endian):**
    Di jaringan, standar de-facto (*Network Byte Order*) adalah *Big Endian*. Saat mengonversi tipe data multi-byte (seperti `uint32` ke dalam `[]byte`), jika Klien (biasanya *Little Endian* x86/ARM) dan Server tidak sepakat, angka `1` di sisi Klien dibaca sebagai `16777216` di sisi Server (byte tertukar). **Defensif:** Selalu paksakan `binary.BigEndian` dari package `encoding/binary` di kedua sisi secara eksplisit.
2.  **Max Payload Size Limitation:**
    Jika protokol tidak memiliki batas maksimum ukuran paket yang ketat (*hard limit*), seorang penyerang bisa mengirim Header dengan `Length = 4.294.967.295` (Uint32 Max, ~4GB). Saat `io.ReadFull` mencoba mengalokasi `make([]byte, length)`, server Anda langsung runtuh akibat *OOM (Out Of Memory)* seketika. **Defensif:** Lempar *error* langsung (drop koneksi) jika `length > MAX_ALLOWED` (contoh: 8MB) sebelum melakukan alokasi buffer payload.
3.  **Buffer Re-use (Zero Allocation):**
    Membuat `make([]byte, size)` pada setiap siklus `Read` sangat brutal terhadap kinerja *Garbage Collector* Go di bawah beban puluhan ribu paket per detik. **Defensif:** Gunakan `sync.Pool` untuk membagikan dan mendaur ulang buffer berukuran tetap (contoh: pool untuk ukuran 1KB, pool untuk 10KB), atau lewat *buffer statis* menempel pada instance Koneksi untuk *overhead* 0% (zero allocation loop).
    
    ```go
    // Detail Implementasi Edge Case: Buffer Pool
    var payloadPool = sync.Pool{
        New: func() interface{} {
            // Pre-allocate buffer ke ukuran maksimum (contoh: 65535 byte)
            buf := make([]byte, MaxPayloadSize)
            return &buf
        },
    }
    // Di dalam read loop:
    // bufPtr := payloadPool.Get().(*[]byte)
    // frame.Payload = (*bufPtr)[:frame.Length] // Slice sesuai kebutuhan
    // defer payloadPool.Put(bufPtr) // Kembalikan ke pool
    ```

## 5. Production-Ready Go Code & Unit Test

Kode berikut mendemonstrasikan pembangun dan *parser* TCP mentah, memecahkan permasalahan *TCP Framing* (Partial Reads) dan menetapkan batasan OOM.

```go
package binproto

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"testing"
)

// Frame mewakili struktur data protokol (Header statis 5 byte + Dinamis)
type Frame struct {
	Magic   uint8  // 1 Byte
	Version uint8  // 1 Byte
	Opcode  uint8  // 1 Byte
	Length  uint16 // 2 Bytes (BigEndian)
	Payload []byte
}

const (
	MagicByte uint8 = 0xA1
	MaxPayloadSize  = 65535 // Max uint16
)

var (
	ErrInvalidMagic   = errors.New("invalid magic byte, protocol mismatch")
	ErrPayloadTooBig  = errors.New("payload exceeds maximum allowed size")
)

// WriteFrame merakit dan menulis ke socket/buffer
func WriteFrame(w io.Writer, opcode uint8, payload []byte) error {
	length := len(payload)
	if length > MaxPayloadSize {
		return ErrPayloadTooBig
	}

	header := make([]byte, 5)
	header[0] = MagicByte
	header[1] = 0x01 // Version 1
	header[2] = opcode
	
	// Encode ukuran ke dalam BigEndian Network Byte Order
	binary.BigEndian.PutUint16(header[3:5], uint16(length))

	// Tulis Header
	if _, err := w.Write(header); err != nil {
		return fmt.Errorf("write header error: %w", err)
	}
	// Tulis Payload
	if length > 0 {
		if _, err := w.Write(payload); err != nil {
			return fmt.Errorf("write payload error: %w", err)
		}
	}
	return nil
}

// ReadFrame membaca satu frame logika utuh, kebal terhadap TCP Partial Reads.
func ReadFrame(r io.Reader) (*Frame, error) {
	headerBuf := make([]byte, 5) // Statis Header
	
	// io.ReadFull akan memblokir SAMPAI ke-5 byte ini kumpul.
	// Menyelesaikan masalah "pesan terpotong" di level TCP
	if _, err := io.ReadFull(r, headerBuf); err != nil {
		return nil, fmt.Errorf("read header error: %w", err)
	}

	frame := &Frame{
		Magic:   headerBuf[0],
		Version: headerBuf[1],
		Opcode:  headerBuf[2],
	}

	if frame.Magic != MagicByte {
		return nil, ErrInvalidMagic
	}

	// Dekode ukuran dari BigEndian
	frame.Length = binary.BigEndian.Uint16(headerBuf[3:5])

	if frame.Length > 0 {
		// Proteksi OOM tidak terlalu perlu jika tipe data length hanya uint16 (max 64kb),
		// tapi jika uint32, blok if length > MaxAllowed wajib ada di sini.
		frame.Payload = make([]byte, frame.Length)
		
		// Baca sisa body dengan pasti
		if _, err := io.ReadFull(r, frame.Payload); err != nil {
			return nil, fmt.Errorf("read payload error: %w", err)
		}
	}

	return frame, nil
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------

// slowReader adalah implementasi mock io.Reader untuk Edge Case TCP Fragmentation
type slowReader struct {
	data  []byte
	chunk int
	pos   int
}

func (s *slowReader) Read(p []byte) (n int, err error) {
	if s.pos >= len(s.data) {
		return 0, io.EOF
	}
	end := s.pos + s.chunk
	if end > len(s.data) {
		end = len(s.data)
	}
	n = copy(p, s.data[s.pos:end])
	s.pos += n
	return n, nil
}

func TestWriteFrame_Success(t *testing.T) {
	var buf bytes.Buffer
	err := WriteFrame(&buf, 0x05, []byte("HELLO"))
	if err != nil {
		t.Fatalf("Gagal write frame: %v", err)
	}
	expected := []byte{0xA1, 0x01, 0x05, 0x00, 0x05, 'H', 'E', 'L', 'L', 'O'}
	if !bytes.Equal(buf.Bytes(), expected) {
		t.Errorf("Encoded salah, got: %x", buf.Bytes())
	}
}

func TestReadFrame_SlowConnectionFragmented(t *testing.T) {
	// Klien mengirim data terpotong-potong (1 byte per read) via TCP
	mockConn := &slowReader{
		data:  []byte{0xA1, 0x01, 0x05, 0x00, 0x05, 'H', 'E', 'L', 'L', 'O'},
		chunk: 1, 
	}

	frame, err := ReadFrame(mockConn)
	if err != nil {
		t.Fatalf("ReadFrame gagal menangani fragmentasi: %v", err)
	}
	if string(frame.Payload) != "HELLO" {
		t.Errorf("Payload mismatch, got: %s", frame.Payload)
	}
}

func TestReadFrame_InvalidMagicValidation(t *testing.T) {
	// Memastikan Magic Byte salah otomatis ditolak
	badConn := bytes.NewReader([]byte{0xBB, 0x01, 0x05, 0x00, 0x05, 'X'})
	_, err := ReadFrame(badConn)
	if !errors.Is(err, ErrInvalidMagic) {
		t.Errorf("Expected ErrInvalidMagic, got: %v", err)
	}
}

func TestWriteFrame_OOMProtectionMaxPayload(t *testing.T) {
	// Menguji penolakan Payload di atas batas Max (65535)
	largePayload := make([]byte, MaxPayloadSize+1)
	var buf bytes.Buffer
	err := WriteFrame(&buf, 0x05, largePayload)
	if !errors.Is(err, ErrPayloadTooBig) {
		t.Errorf("Expected ErrPayloadTooBig OOM protection, got: %v", err)
	}
}
```
