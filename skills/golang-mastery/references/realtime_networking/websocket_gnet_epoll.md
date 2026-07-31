# Realtime Networking: WebSocket via Epoll (gnet) di Go

## 1. Konsep dan Internals

WebSocket adalah protokol komunikasi dua arah (*full-duplex*) yang bermula sebagai HTTP *handshake* lalu di- *upgrade* secara permanen menjadi koneksi TCP persisten. Meskipun library standar `nhooyr.io/websocket` atau `gorilla/websocket` sangat idiomatis dan bagus, mereka menggunakan pendekatan standar "1 Goroutine = 1 Connection".

Untuk skala hiper-ekstrim (*Hyper-scale* seperti jutaan koneksi CCU untuk layanan *chat*, *live score*, atau IoT telemetri), model goroutine per-koneksi boros memori (1 Juta goroutine = ~2GB+ *stack memory* mati). 

**Solusinya: Event-Driven Networking (Epoll/Kqueue).**
*Framework* seperti `panjf2000/gnet` membangun abstraksi tipis di atas syscall `epoll` (Linux). Konsepnya adalah memiliki *Worker Pool* statis (misal sejumlah Core CPU) yang secara terus-menerus memanggil `epoll_wait`. Ketika jaringan menerima data, kernel menginterupsi *worker* untuk bereaksi. Tidak ada pemblokiran, dan memori yang digunakan semata-mata hanya memori data (*payload*), bukan *OS/Goroutine stack*.

**Anatomi WebSocket Frame di Level Biner:**
Protokol WebSocket bukan sekadar teks mentah TCP. Data dibungkus dalam *Frame* (RFC 6455). Byte pertama menampung bit FIN (Akhir pesan) dan *Opcode* (Text, Binary, Ping, Pong, Close). Mengoperasikan WebSocket di atas `gnet` (yang murni raw TCP/epoll) berarti Anda HARUS mem-parsing HTTP *Upgrade Request* dan menyusun *WebSocket Frame Headers* sendiri secara manual.

## 2. Diagram ASCII: Event-Driven WebSocket (Gnet)

```text
                            [ Internet (1M Clients) ]
                                     |
+------------------------------------+------------------------------------+
|                             Linux Kernel (Epoll)                        |
|                                                                         |
|        [ FD 101, FD 102 (Ready to Read) ] ---> (Interrupt)              |
+------------------------------------+------------------------------------+
                                     |
                                     V
+-------------------------------------------------------------------------+
|                              Go Application                             |
|                                                                         |
|  [ Event Loop (gnet) - 1 OS Thread per CPU Core ]                       |
|                                                                         |
|  epoll_wait() returns [FD 101, 102]                                     |
|                                                                         |
|  -> OnReact(frame, context):                                            |
|       1. Parse WebSocket Frame (Masking, Payload Len)                   |
|       2. Jika Ping = Kirim Pong Frame (Zero allocation response)        |
|       3. Jika Data = Kirim ke Bisnis Logik / Redis PubSub               |
|                                                                         |
|  <- conn.AsyncWrite(response_frame)                                     |
|     (Menyusun masking bit, payload size header, lalu raw epoll write)   |
+-------------------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan WebSocket Ping/Pong

Developer sering hanya memproses *Opcode Text* (1) atau *Binary* (2). Ketika browser/klien secara otomatis mengirim kontrol pesan *Ping* (Opcode 9), server diam saja.

```go
// ❌ BAD: Mengabaikan Control Frames
func decodeFrame(data []byte) {
    opcode := data[0] & 0x0F
    if opcode == 1 {
        // Teks diterima
    }
    // Jika opcode 9 (Ping) atau 8 (Close), diabaikan!
}
```
**Why dangerous:** *Load Balancer* (seperti Nginx/AWS ALB) dan klien *Browser* menggunakan `Ping` untuk memastikan koneksi hidup. Jika server tidak merespons dengan `Pong` (Opcode 10) dalam waktu tertentu (misal 60 detik), koneksi akan ditutup paksa (*Connection Reset by Peer*), menyebabkan klien melakukan rekoneksi massal (*Reconnect Storm*) yang melumpuhkan server.

```go
// ✅ GOOD: Handle spesifik opcode kontrol (khususnya untuk raw implementasi)
opcode := data[0] & 0x0F
switch opcode {
    case 9: // Ping
        sendPong(conn) // Segera kirim Pong
    case 8: // Close
        conn.Close()
}
```

### ❌ Anti-Pattern 2: Melakukan Blocking Call di Dalam Event Loop (`OnReact`)

Fungsi event loop (`OnReact` di `gnet` atau loop `epoll_wait`) berjalan langsung di atas OS *Thread* utama (biasanya berjumlah sama dengan `GOMAXPROCS`).

```go
// ❌ BAD: Pemrosesan memblokir (I/O) di dalam Event Loop
func (es *myServer) OnReact(frame []byte, c gnet.Conn) (out []byte, action gnet.Action) {
    // KIAMAT KECIL: Memanggil database akan memblokir OS Thread!
    // Jika ada 4 thread, dan 4 klien memicu call ini, SELURUH server
    // (ratusan ribu client lain) akan BEKU tidak bisa I/O.
    db.Query("SELECT ...", string(frame)) 
    return nil, gnet.None
}
```
**Why dangerous:** Melumpuhkan performa *Asynchronous Event Loop*. *Thread* yang membeku membuat notifikasi *epoll* tidak ada yang mengambil. Kapasitas (Throughput) server yang seharusnya 100.000 Req/Sec akan drop menjadi 10 Req/Sec.

```go
// ✅ GOOD: Pindahkan pemrosesan ke Goroutine Worker Pool
func (es *myServer) OnReact(frame []byte, c gnet.Conn) (out []byte, action gnet.Action) {
    // Duplikasi data (karena frame buffer di gnet sering di-reuse oleh epoll pool)
    dataCopy := append([]byte(nil), frame...) 
    
    // Asign tugas ke Worker Pool (Goroutine)
    go func(data []byte, conn gnet.Conn) {
        db.Query(...)
        conn.AsyncWrite(buildWebSocketTextFrame("SUCCESS"))
    }(dataCopy, c)
    
    return nil, gnet.None
}
```

## 4. Edge Cases & Defensive Programming

1.  **Masking Key pada Client-to-Server:**
    Sesuai RFC 6455, semua payload dari Klien ke Server **WAJIB** di-*mask* (XOR-ed) menggunakan 4-byte *masking key* yang dibuat acak per- *frame*. Jika Klien nakal mengirim data tak ber-masking (bit mask diset 0), server Anda HARUS memutuskan koneksi secara keras (`Close`). Ini mencegah serangan *Cache Poisoning* pada proksi perantara. Server->Klien tidak boleh di-*mask*.
2.  **Fragmentasi Pesan Panjang (Continuation Frame):**
    WebSocket memungkinkan pengiriman data ber-Gigabyte tanpa menguras memori melalui *Fragmentation* (Opcode 0). Pesan pertama diset `FIN=0`, dan pesan berikutnya ber-opcode 0, hingga diakhiri dengan frame `FIN=1`. Parser mentah Anda harus menahan state `context` di level soket untuk menggabungkan paket ini sebelum dilempar ke bisnis logika.
3.  **Maximum Payload Size Limitation:**
    Jika aplikasi tidak memeriksa panjang *payload header*, klien iseng bisa mensetel bit length `127` (64-bit integer length) dan mengklaim mengirim file 10 Petabytes. Saat server Anda mengalokasikan `make([]byte, length)`, ia langsung mati karena `Out of Memory (OOM)`. Batasi *allocation* (contoh: tolak frame > 2MB).

## 5. Production-Ready Go Code & Unit Test

Kode di bawah mendemonstrasikan sebuah *parser/builder* mentah (*raw*) standar RFC6455 tingkat produksi. *(Catatan: Pada produksi riil via `gnet`, fungsi ini digunakan di dalam `OnTraffic/OnReact` untuk mengekstrak data dari `bytes buffer` epoll).*

```go
package raw_ws

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"testing"
)

// Opcodes standar RFC 6455
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// DecodeClientFrame membaca 1 frame dari Client (WAJIB di-mask)
// Secara simplifikasi untuk tes ini asumsikan buffer berisi full frame utuh.
func DecodeClientFrame(buf []byte) (opcode byte, payload []byte, err error) {
	if len(buf) < 6 { // Min: 2 (Header) + 4 (Mask Key)
		return 0, nil, errors.New("frame terlalu pendek")
	}

	fin := (buf[0] & 0x80) != 0
	if !fin {
		// Edge Case: Fragmentasi diabaikan di contoh sederhana ini
		return 0, nil, errors.New("fragmentasi tidak didukung (FIN=0)")
	}

	opcode = buf[0] & 0x0F
	isMasked := (buf[1] & 0x80) != 0
	
	if !isMasked {
		// RFC6455: Klien WAJIB masking payloadnya. Keamanan.
		return 0, nil, errors.New("frame dari client tidak di-mask")
	}

	payloadLen := int(buf[1] & 0x7F)
	headerOffset := 2

	// Ekstensi Length (Mencegah OOM: batasi max 64KB)
	if payloadLen == 126 {
		if len(buf) < 8 {
			return 0, nil, errors.New("frame tidak utuh (length 126)")
		}
		payloadLen = int(buf[2])<<8 | int(buf[3])
		headerOffset = 4
	} else if payloadLen == 127 {
		return 0, nil, errors.New("payload terlalu besar (length 127 ditolak untuk OOM protection)")
	}

	if len(buf) < headerOffset+4+payloadLen {
		return 0, nil, errors.New("buffer kurang panjang dari yang diklaim payload")
	}

	maskKey := buf[headerOffset : headerOffset+4]
	payloadData := buf[headerOffset+4 : headerOffset+4+payloadLen]

	// Dekripsi (Unmask) In-Place: XOR
	unmasked := make([]byte, payloadLen)
	for i := 0; i < payloadLen; i++ {
		unmasked[i] = payloadData[i] ^ maskKey[i%4]
	}

	return opcode, unmasked, nil
}

// BuildServerFrame membangun frame balasan Server (Tanpa Mask)
func BuildServerFrame(opcode byte, data []byte) []byte {
	length := len(data)
	var b bytes.Buffer

	// FIN=1 (Selesai), Opcode = opcode
	b.WriteByte(0x80 | opcode)

	// Server->Client TIDAK BOLEH di-mask (MSB = 0)
	if length < 126 {
		b.WriteByte(byte(length))
	} else if length <= 65535 {
		b.WriteByte(126)
		b.WriteByte(byte(length >> 8))
		b.WriteByte(byte(length & 0xFF))
	} else {
		// Frame besar sekali dilarang (Batasi 65KB untuk contoh)
		panic("Terlalu besar")
	}

	// Payload langsung
	b.Write(data)
	return b.Bytes()
}

// GenerateAcceptKey memproses header "Sec-WebSocket-Key" saat Handshake
func GenerateAcceptKey(clientKey string) string {
	const magicString = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	h := sha1.New()
	h.Write([]byte(clientKey + magicString))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestWebSocketFrameCodec(t *testing.T) {
	// Skenario 1: Frame Masked dari Client ("Hello")
	// Header: 1000 0001 (0x81: FIN, Text)
	// Length: 1000 0101 (0x85: Mask=1, Len=5)
	// Mask: 0x37, 0xfa, 0x21, 0x3d
	// Payload: 0x7f, 0x9f, 0x4d, 0x51, 0x58 (H ^ 0x37, dst)
	clientFrame := []byte{0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58}

	op, msg, err := DecodeClientFrame(clientFrame)
	if err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if op != OpText {
		t.Errorf("Expected OpText(1), got %d", op)
	}
	
	if string(msg) != "Hello" {
		t.Errorf("Expected 'Hello', got '%s'", string(msg))
	}

	// Skenario 2: Klien nakal tidak melakukan masking (Dilarang RFC)
	clientNaughtyFrame := append([]byte{0x81, 0x05}, []byte("Hello")...) // Mask bit = 0
	_, _, err = DecodeClientFrame(clientNaughtyFrame)
	if err == nil {
		t.Errorf("Klien mengirim data tanpa mask harusnya error!")
	}

	// Skenario 3: Server membangun frame balasan
	// Server->Client: Mask = 0. Data = "Ping" (Len 4)
	serverFrame := BuildServerFrame(OpPing, []byte("Ping"))
	expectedServer := []byte{0x89, 0x04, 'P', 'i', 'n', 'g'}
	
	if !bytes.Equal(serverFrame, expectedServer) {
		t.Errorf("Server frame salah. Got: %v, Expected: %v", serverFrame, expectedServer)
	}
}
```
