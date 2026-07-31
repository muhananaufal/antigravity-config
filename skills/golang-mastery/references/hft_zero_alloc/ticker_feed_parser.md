# Ticker Feed Parser (Zero Allocation)

## Konsep Utama
High-Frequency Trading melibatkan komunikasi dengan pertukaran bursa secara konstan. Pertukaran ini (seperti NASDAQ OUCH, CME iLink, atau Protokol FIX HFT) mengirimkan aliran informasi buku pesanan dan harga menggunakan format khusus biner ringkas (*Custom Binary Protocols*) atau, sesekali, ASCII berpemisah karakter.

Parser yang lambat dan lapar alokasi akan langsung menghancurkan performa bot *trading*. Mem-parsing deretan *byte* dari jaringan ke dalam *struct* operasional adalah tahap pertama kritis (Front-Door). 

Paradigma **Zero-Allocation Parser** mewajibkan:
1. Menjauhi tipe data `string`. Di Go, `string` itu kekal (*immutable*), mem-parsing potongan string berakibat `copy()` dan alokasi `heap` GC. Kita menggunakan tipe `[]byte` beririsan atau `[N]byte` array statis.
2. Tidak menggunakan fungsi pembantu *high-level* dari pustaka bawaan `strconv` atau `bytes.Split`, karena sering kali membuat irisan yang lari (*escapes*) atau objek pembantu sementara (iterators).
3. Melakukan *in-place arithmetic* tingkat dewa untuk konversi *byte-to-integer*.

## Diagram ASCII: Zero Alloc Parsing

```text
[ PACKET BYTE STREAM DARI JARINGAN ]
Buffer Mentah: | 8-byte Simbol | 8-byte Harga Int | 8-byte Volume | 
                (Array Pointer `buf` menunjuk kesini, Tidak ada pemindahan)

[ OPERASI SCALAR IN-PLACE (O(1) No Copying) ]
[A,A,P,L, , , , ] ---> Masuk statis [8]byte struct event
[0,0,0,0,0,0,0,X] ---> Digeser (*bit-shifted*) lalu OR-ed ke Int64
[0,0,0,0,0,0,0,Y] ---> Digeser (*bit-shifted*) lalu OR-ed ke Int64

[ RESULT STRUCT DI ARENA/STACK ]
Event Struct { "AAPL    ", 25000, 100 }
```

## Kode Go Production-Ready

Kode di bawah mensimulasikan parsing biner format bursa khayalan dengan ketebalan 24 byte *fixed-length*. Teknik parsing ini *zero allocation* sepenuhnya dan bisa di-benchmark.

```go
package hftalloc

import (
	"context"
	"fmt"
	"testing"
)

// MarketEvent adalah hasil parsing data jaringan mentah. 
// Field Symbol sengaja menggunakan array statis 8-byte alih-alih `string` tipe variabel
// agar memori bisa memblok rata sejajar bersebelahan.
type MarketEvent struct {
	Symbol [8]byte
	Price  int64
	Qty    int64
}

var (
	ErrFeedTooShort = fmt.Errorf("feed packet is corrupted or too short")
)

// ParseBinaryFeedFast melakukan parsing in-place tanpa alokasi sedikitpun.
// Menerima buffer dari soket jaringan dan menimpa objek `outEvent` 
// yang biasanya berada di dalam pre-allocated memori arena kita.
func ParseBinaryFeedFast(ctx context.Context, payload []byte, outEvent *MarketEvent) error {
	// Menghindari panic batas array: pastikan buffer memiliki setidaknya 24 byte.
	if len(payload) < 24 {
		return ErrFeedTooShort
	}

	// 1. Ekstrak Simbol (8 bytes). (Menggunakan copy built-in agar compiler
	// mengoptimalkannya menggunakan instruksi khusus CPU SIMD Memmove)
	copy(outEvent.Symbol[:], payload[0:8])

	// 2. Ekstrak Harga (8 bytes Little Endian).
	// Buka jalinan perulangan manual (Manual Unrolling) ke pergeseran Bitwise (Shift).
	// Jauh lebih cepat dari pemanggilan paket `binary.LittleEndian.Uint64()`
	// karena kompilator Go modern dapat menyulap pola spesifik ini 
	// menjadi SATU instruksi MOV murni di x86 Assembly! (Ajaib!)
	_ = payload[15] // BCE (Bounds Check Elimination Hint)
	
	outEvent.Price = int64(payload[8]) |
		int64(payload[9])<<8 |
		int64(payload[10])<<16 |
		int64(payload[11])<<24 |
		int64(payload[12])<<32 |
		int64(payload[13])<<40 |
		int64(payload[14])<<48 |
		int64(payload[15])<<56

	// 3. Ekstrak Kuantitas (8 bytes Little Endian)
	_ = payload[23] // BCE Hint
	
	outEvent.Qty = int64(payload[16]) |
		int64(payload[17])<<8 |
		int64(payload[18])<<16 |
		int64(payload[19])<<24 |
		int64(payload[20])<<32 |
		int64(payload[21])<<40 |
		int64(payload[22])<<48 |
		int64(payload[23])<<56

	return nil
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestParseBinaryFeed(t *testing.T) {
	ctx := context.Background()
	// Mock paket dari Bursa (AAPL, harga 1000, Qty 50)
	packet := []byte{
		'A', 'A', 'P', 'L', ' ', ' ', ' ', ' ', // 8 bytes char
		0xE8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 1000 in 8-byte LE
		0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 50 in 8-byte LE
	}

	var event MarketEvent
	err := ParseBinaryFeedFast(ctx, packet, &event)
	if err != nil {
		t.Fatalf("unexpected parsing error: %v", err)
	}

	symStr := string(event.Symbol[:4]) // Test comparison only
	if symStr != "AAPL" {
		t.Errorf("expected AAPL, got %s", symStr)
	}
	if event.Price != 1000 {
		t.Errorf("expected 1000, got %d", event.Price)
	}
	if event.Qty != 50 {
		t.Errorf("expected 50, got %d", event.Qty)
	}
}

func BenchmarkParseFeed_ZeroAlloc(b *testing.B) {
	ctx := context.Background()
	packet := []byte{
		'B', 'T', 'C', 'U', 'S', 'D', 'T', ' ',
		0xE8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	}
	var event MarketEvent
	
	b.ReportAllocs() // WAJIB: Membuktikan parser tidak menghasilkan sampah GC sama sekali (Zero Allocs/op)
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		// Event digunakan berulang-ulang, meniru modifikasi Arena di tempat
		err := ParseBinaryFeedFast(ctx, packet, &event)
		if err != nil {
			b.Fatal(err)
		}
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengubah Slice Byte Jadi String
**Memanipulasi string untuk memotong nilai Simbol Ticker (seperti BTCUSD).**

```go
// ❌ BAD: Casting String (Double Allocation Memory)
func ParseBadString(payload []byte) *MarketEvent {
    // string(payload) melakukan Deep Copy (membutuhkan memori O(N) baru dan menekan GC)!
    symbol := string(payload[0:8]) 
    return &MarketEvent{
        // Alokasi struktur ke Heap
        SymbolStr: symbol,
    }
}
```

**Mengapa Berbahaya:** Paket ticker bursa sangat sporadis dan bisa melambung hingga jutaan paket/detik. Konstruktor `string(bytes)` di Go terjamin selalu mengalokasikan memori penampung yang sama sekali baru di belantara *heap* (karena keharusan bahasa bahwa string itu tidak dapat diubah / immutable). Dalam HFT, setiap alokasi di zona panas (*hot zone*) parser memicu kematian beruntun dari latensi jeda panjang GC (GC Pauses).

```go
// ✅ GOOD: Array Karakter Primitif
type MarketEvent struct {
    // Array blok nilai (*by-value*), kompilator meratakannya (flatten) ke dalam struct!
    Symbol [8]byte 
}

func ParseGoodByte(payload []byte, event *MarketEvent) {
    // O(1) Memory Move, menyalin nilai seketika tanpa Heap.
    copy(event.Symbol[:], payload[0:8])
}
```

### ❌ Anti-Pattern 2: `bytes.Buffer` atau `binary.Read` Generik
**Menggunakan alat perpustakaan standar yang dibangun untuk keamanan file ketimbang kinerja HFT mentah.**

```go
// ❌ BAD: Memanggil reflection dan buffer abstrak.
func ParseBadIO(payload []byte, out *MarketEvent) {
    buf := bytes.NewReader(payload)
    // binary.Read beroperasi menggunakan antarmuka Reflection (reflect package)
    // jika kita mem-parsing struct majemuk! Sangat-sangat merusak latensi CPU.
    binary.Read(buf, binary.LittleEndian, out) 
}
```

**Mengapa Berbahaya:** Di balik layar implementasi, `binary.Read` dari Golang memeriksa argumen `out` menggunakan modul Refleksi Runtime (`reflect.TypeOf`). Refleksi Go di eksekusi dalam fase operasi memori tunda yang sangat lambat (membutuhkan ribuan siklus untuk mengenali jenis dan *offset* bidang tipe, kemudian melakukan iterasi field satu persatu). Ini adalah perampokan sumber daya yang fatal untuk sebuah rutinitas milidetik HFT.

```go
// ✅ GOOD: Manual Byte Shifting
func ParseGoodManual(payload []byte, out *MarketEvent) {
    // 0 biaya abstraksi! Mesin langsung mentranslasi ke instruksi LEA/MOV x86.
    out.Price = int64(payload[8]) | int64(payload[9])<<8 | ...
}
```

## Edge Cases & Defensive Programming

1. **Efek Panik dari Batas Irisan Tertunda (Deferred Slice Bounds Panic)**:
   *Edge Case*: Anda telah melampirkan kondisional keamanan di awal kode `if len(payload) < 24 { return error }`. Namun dalam kode penggeseran (*bit-shifting*), Anda tiba-tiba secara tidak sengaja salah ketik mengakses byte indeks `payload[25]`. Kompilator tidak mendeteksinya pada tahap kondisional.
   *Defensive*: Jika ini terjadi di produksi saat koneksi sibuk, aplikasi Anda akan berteriak *Panic Array Out of Bounds* dan *crash*. Lebih dari itu, kecurigaan kompilator akan potensi cacat ini memaksanya memasuk-masukkan instruksi pengecekan batas *(Bounds Checks)* di setiap baris `int64(payload[X])`. Gunakan teknik **BCE Hints** (Bounds Check Elimination) di awal metode Anda. Yakni: sentuh satu indeks tertinggi (misal `_ = payload[23]`). Setelah Go mengeksekusi kode itu tanpa panik, ia sadar seluruh rentang 0-23 terjamin aman, dan seketika ia menghapus *semua* rintangan keamanan untuk instruksi berikutnya, meledakkan performa Anda hingga batas silikon logam mentah.
2. **Paket Bursa Campur Aduk (TCP Fragmented)**:
   *Edge Case*: Anda menghubungkan *parser* tersebut pada koneksi bursa FIX Protocol standar berbasis TCP. Pada protokol TCP, aliran data adalah serangkaian gigitan (*Stream*). Anda mungkin melakukan panggilan Soket OS sekali, namun ia hanya meneteskan (mereturn) payload terpenggal sepanjang `12 bytes` (dari total 24 byte paket).
   *Defensive*: Pemecah (*parser*) instan ini ditujukan ekslusif bagi datagram murni UDP (*packet boundary preservation*) di mana data diterima utuh 1 paket penuh, atau koneksi HFT C/C++ FFI terkelola. Untuk TCP, aplikasi Anda WAJIB melingkupi fungsi pemecah ini ke dalam rutinitas pembaca penyambung rahasia, melacak posisi panjang kursor sebelumnya, serta menumpuk iterasi pembacaan memori parsial, sampai blok 24 byte tergenapi dan baru setelah itu mengeksekusi konversi tipe HFT Hashing di atas. 
3. **Ketidaksesuaian Endianness Silikon (Big Endian vs Little Endian)**:
   *Edge Case*: Anda membuat kode penggeser (*shift* dan *OR*) Little Endian di atas dan meluncurkannya. Tiba-tiba perusahaan memindahkan server bot ke mesin superkomputer Arsitektur *Big Endian* (seperti mesin lawas IBM PowerPC yang masih dipakai bursa aneh dunia ketiga).
   *Defensive*: Hasil harga *Price* yang tadinya 1000 akan menjadi nilai hancur triliunan yang gila, lalu HFT Engine Anda akan mengajukan beli (*Buy Order*) saham perusahaan permen seharga satu triliun dolar. Sangat tragis! Tambahkan perlindungan uji pra-rilis (*Init Check* atau *Build Tags*). Go memungkinkan fitur kompilasi khusus per-arsitektur dengan komentar di awal file (contoh: `//go:build amd64 || arm64`).
