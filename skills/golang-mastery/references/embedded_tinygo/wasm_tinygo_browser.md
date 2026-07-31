# WebAssembly (WASM) & TinyGo Browser Target

## Konsep Internal & Trade-offs

WebAssembly (WASM) adalah format instruksi biner yang dapat dieksekusi langsung oleh mesin virtual (*engine/JIT*) di dalam browser modern (V8/SpiderMonkey) dengan kecepatan nyaris mendekati *native* (bahasa mesin).

Standar Golang (`GOOS=js GOARCH=wasm`) bisa dikompilasi menjadi WASM, namun menghasilkan ukuran biner minimal sebesar 2-3 Megabyte hanya untuk "Hello World". Di web modern, mendownload *script* sebesar itu tidak bisa diterima (merusak SEO dan *First Contentful Paint*).

**TinyGo** muncul sebagai solusi mutlak. Karena ia didesain ulang sejak awal (tanpa runtime berat dan membuang library standard refleksi yang boros), TinyGo memangkas target `wasm` hingga sekecil 10 Kilobyte! TinyGo WASM mengekspor fungsi Go ke lingkungan *JavaScript Runtime* secara langsung (disebut syscall/FFI - Foreign Function Interface).

**Trade-offs TinyGo WASM**:
1. **Keunggulan**: Biner ekstra kecil, load web instan. Mendukung tipe data numerik kompleks (game fisika, kalkulator berat) dengan kecepatan yang tidak bisa disamai *JavaScript* murni.
2. **Kekurangan**: Modul Go standard yang membutuhkan *Reflection* (seperti `encoding/json` murni, `net/http` client) banyak yang tidak didukung atau akan memicu panik karena filosofi radikal pengecilan TinyGo. Interaksi bolak-balik antara Memory WASM dan Memory JS (String parsing) sangat lambat jika dieksekusi tiap *frame/millisecond* karena melintasi batas pengaman (*Sandbox boundary*).

## Arsitektur & Alur Jembatan (JS <-> WASM)

```text
[ Browser / DOM (JavaScript) ]               [ WebAssembly Sandbox (TinyGo) ]
 
  <button id="calcBtn">                     +------------------------------+
                                            | package main                 |
     JS Event Listener                      | func add(a, b int) int       |
     onClick() ------------------+          |                              |
                                 |          | //go:wasmexport multiply     |
                                 v          | func multiply(...)           |
     // Panggil Fungsi WASM                 |                              |
     wasm.exports.add(5, 10)  ----------> [ WASM Linear Memory ArrayBuffer ] 
                                 <----------(Hasil: 15)                    |
     document.write(15)                     |                              |
                                            +------------------------------+
 
 DOM tidak bisa dimanipulasi LANGSUNG oleh WASM dalam spesifikasi standar (WASM 1.0). 
 TinyGo harus mengimport API JS "syscall/js" yang secara internal melempar 
 ID pointer kembali ke JS untuk dimutasi. Interaksi/DOM sangat mahal.
```

## Kode Go Production-Ready

Contoh mengekspor pustaka fungsi Go intensif-kalkulasi (*Compute Intensive*) agar dapat dipanggil di ranah Web Frontend murni (React, Vue, atau Vanilla JS) menggunakan *directive* spesifik `//export`.

Penting: Gunakan `tinygo build -o main.wasm -target=wasm main.go` untuk membangunnya.

```go
package main

import (
	"unsafe"
)

// main HARUS ada pada TinyGo wasm agar runtime/sandbox terinisialisasi
func main() {
	// Kosong karena kita hanya mengekspor library logic
}

// -------------------------------------------------------------
// EKSPOR DASAR (NUMERIK) - SANGAT CEPAT
// -------------------------------------------------------------

//export calculatePrimeArea
func calculatePrimeArea(radius float64, complexity int) float64 {
	// Contoh kalkulasi intensif yang JS akan kewalahan jika complexity tinggi
	total := radius * 3.1415
	for i := 0; i < complexity; i++ {
		// Logika kompleks ...
		total += float64(i) * 0.001
	}
	return total
}

// -------------------------------------------------------------
// EKSPOR ADVANCED (STRING / MEMORY) - BUTUH KEAHLIAN POINTER
// -------------------------------------------------------------
// WASM tidak mengerti konsep 'string' dari JavaScript (Hanya tahu int/float).
// Kita harus mengalokasikan memori di sisi Go, memberikan alamatnya ke JS,
// membiarkan JS menulis stringnya ke sana, lalu memprosesnya.

//export malloc
func malloc(size int) *byte {
	// JS memanggil ini untuk meminta secarik memori ke WebAssembly
	buf := make([]byte, size)
	return &buf[0]
}

//export free
func free(ptr *byte, size int) {
	// Go's Garbage Collector sebenarnya akan mengambil alih jika array hilang ref,
	// Namun di FFI, memori ini tidak terikat Go murni. Kosongkan pointer manual (opsional di TinyGo).
}

//export processStringData
func processStringData(ptr *byte, length int) int {
	// 1. Ambil byte mentah dari memory sandbox
	// unsafe.Slice aman digunakan untuk menjembatani blok FFI di Go 1.17+
	byteSlice := unsafe.Slice(ptr, length)
	
	// 2. Cast ke string Go native
	goString := string(byteSlice)

	// Lakukan bisnis logika: (Misal menghitung karakter kapital)
	capitals := 0
	for _, char := range goString {
		if char >= 'A' && char <= 'Z' {
			capitals++
		}
	}
	
	// Kembalikan integer ke JS
	return capitals
}
```

**Sisi JavaScript / HTML**:
```html
<script>
  // Setup bawaan wasm_exec.js dari TinyGo wajib diload dulu
  const go = new Go(); 
  WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject).then((result) => {
      go.run(result.instance); // Inisialisasi Environment
      const wasm = result.instance.exports;

      // Panggilan Cepat (Numerik)
      let area = wasm.calculatePrimeArea(10.5, 5000);
      console.log("Area dari Go:", area);

      // Panggilan Memori (String FFI)
      let text = "Hello WASM World";
      let encoder = new TextEncoder();
      let encodedBytes = encoder.encode(text);
      
      // Minta ruang di Go RAM
      let ptr = wasm.malloc(encodedBytes.length);
      
      // Tulis string kita langsung ke perut RAM Golang (Linear Memory)
      let memoryArray = new Uint8Array(wasm.memory.buffer, ptr, encodedBytes.length);
      memoryArray.set(encodedBytes);

      // Suruh golang memproses string di RAM-nya sendiri
      let count = wasm.processStringData(ptr, encodedBytes.length);
      console.log("Huruf kapital ditemukan:", count);
  });
</script>
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan WebAssembly untuk Segala Logika Interaksi UI (DOM)
Developer menulis ulang kode `document.getElementById` menggunakan API `syscall/js` murni bawaan Go demi membuang JavaScript selamanya.

```go
// BAD: DOM Mutasi setiap detik oleh WASM (Kiamat Performa)
import "syscall/js"

func main() {
    doc := js.Global().Get("document")
    div := doc.Call("getElementById", "myDiv")
    for {
        div.Set("innerHTML", "Uptime: " + fmt.Sprint(time.Now())) // Lag Super Parah
    }
}
```
**Why dangerous:** Saat Go WASM memanggil `js.Global()`, runtime memicu mekanisme interupsi (*context switch*) silang antara *sandbox virtual machine* WASM dan *event loop* JavaScript browser. Pemanggilan *bridge* (jembatan) ini jutaan kali lebih lambat daripada mutasi murni JS ke DOM. Menggunakan JS dari Go untuk DOM update `60fps` akan membuat Chrome/Safari patah-patah (drop ke 10fps). **Pola Benar**: Gunakan JS biasa/React untuk UI dan DOM, gunakan TinyGo WASM sebagai *Kalkulator Pekerja Tak Terlihat* (*Web Worker*) untuk angka murni, algoritma kriptografi, kompresi gambar, atau fisika.

### ❌ Anti-Pattern 2: Returning String/Slice langsung ke fungsi Ekspor WASM
Developer berharap kompilator akan menerjemahkan Slice Go ke JSON String JavaScript secara magis.

```go
// BAD: Tidak dimengerti oleh Ekspor WASM ABI
//export GetNames
func GetNames() []string {
    return []string{"Budi", "Andi"} // Kompilasi PANIC / Error ABI
}
```
**Why dangerous:** Spesifikasi WebAssembly murni (versi 1) belum memiliki tipe data Referensi Kompleks. ABI (*Application Binary Interface*) mesin WASM hanya mengenal 4 tipe data: `i32, i64, f32, f64` (Integer & Float). Jika Anda me-return *slice* memori, browser JavaScript akan bingung karena ia menerima tumpukan angka pointer acak, bukan objek JSON. Anda **wajib** menggunakan pointer memori `uint8 / byte` dan membaca isi rentang memorinya pakai `Uint8Array` di JS (seperti kode produksi di atas) jika harus mengoper string/array.

### ❌ Anti-Pattern 3: Menghalangi Goroutine `main` dan Merusak Event Loop JS
Seringkali developer mengunci `main` dengan loop tak terbatas ala server backend.

```go
// BAD: Menyekik Event Loop Javasript 
func main() {
    for {
        // do nothing
    }
}
```
**Why dangerous:** Berbeda dengan Server yang berjalan di *thread* independen, modul WASM Go (saat dipanggil metode `go.run(instance)`) berjalan menumpang pada **Main Thread UI JavaScript**. Jika Anda mengunci eksekusi di WASM dengan `for{}` abadi tanpa istirahat, seluruh UI browser klien (tombol, scroll mouse, animasi CSS) akan membeku (*Browser Page Unresponsive*). Anda harus membiarkan `main()` kosong (jika library), atau menaruh blokir `select{}` untuk mencegah Go Runtime exit prematur, BUKAN loop sibuk `for{}`.

## Edge Cases

1. **TinyGo "syscall/js" Incompatibility Limitation:** Jika Anda berusaha mem-porting *Library Golang Raksasa* (seperti gRPC, AWS SDK, atau database driver) ke TinyGo Wasm, Anda akan membentur dinding beton. TinyGo meniadakan atau meringkas drastis dukungan standar pustaka Go. Library yang menyentuh `net` (Soket murni) atau reflection tingkat dalam tidak bisa di-compile dengan TinyGo WebAssembly. Porting TinyGo HANYA cocok untuk modul berbasis matematis atau algoritma murni mandiri (Pure Functions).
2. **Memory Leak pada Alokasi FFI Terbengkalai:** Kapanpun JavaScript memanggil fungsi Go `malloc()` (seperti contoh produksi di atas), blok memori Go terpotong. Jika JS secara konstan di-klik 1.000 kali sedetik, dan JS tidak mengosongkannya, Garbage Collector (GC) Konservatif TinyGo *mungkin* buta dan tidak mendeteksinya sebagai sampah karena referensi akarnya ada di dunia JS, bukan Go. Memori Linear WASM (yang punya hard limit, misal Max 2GB) akan membengkak, dan tab browser Web Chrome mendadak Crash (*OOM*). Rancang arsitektur Memory-Reuse (*Shared Memory Buffer statis*) antara JS dan Go daripada `malloc` per-klik.
3. **64-bit Integer (i64) Boundary pada Browser Tua:** Go sangat menyukai `int64`. WASM bisa mengekspor tipe `i64`. Namun, JavaScript (hingga ECMAScript teranyar menggunakan `BigInt`) aslinya menyimpan semua nomor dalam format desimal `Float64` (*Double Precision*). Saat Go mengembalikan `int64` masif melebihi `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`) ke browser usang (Safari iOS lawas), angka tersebut akan otomatis dipotong, dibulatkan, dan memicu bug perbankan/akuntansi logika (Uang minus/hilang). Gunakan String untuk ID besar atau passing pecah array `uint32`.

## Unit Test Meaningful

Meskipun Wasm khusus browser, kompilator Go (Host OS Linux/Windows) sanggup menguji fungsionalitas algoritma secara native tanpa harus di-run dalam environment peramban (Browser), karena kode murninya tak terkait syscall JS.

```go
package main

import (
	"testing"
	"unsafe"
)

// Tes Algoritma FFI yang seolah-olah dipanggil oleh JS
func TestProcessStringData_FFIMock(t *testing.T) {
	// 1. JS-like Setup: Buat array byte dari string
	inputStr := "Wasm IN Golang IS Fast"
	inputBytes := []byte(inputStr) // Simulasi memori yang di-pass JS

	length := len(inputBytes)
	
	// Simulasi Pointer pengalokasian awal dari memori Heap (ptr *byte)
	ptr := &inputBytes[0]

	// 2. Eksekusi fungsi bisnis yang diekspor (diuji murni natif OS saat go test)
	result := processStringData(ptr, length)

	// 3. Validasi
	// Huruf besar: W, I, N, G, I, S, F (Total 7 karakter)
	if result != 7 {
		t.Fatalf("Expected 7 capital letters, but got %d", result)
	}
}

// Tes Keamanan Pointer Slice Cast (Panic Checker)
func TestProcessStringData_EdgeCaseEmpty(t *testing.T) {
	// Kasus string 0 byte
	inputBytes := []byte{}
	
	// Perlindungan: Tidak boleh ambil pointer index 0 kalau kosong (Bisa panic bounds di GO native)
	// Namun di FFI, JS terkadang passing panjang 0. FFI Go harus dicegah panik.
	var ptr *byte
	if len(inputBytes) > 0 {
		ptr = &inputBytes[0]
	} else {
		// Mock Null Pointer JS
		ptr = nil 
	}

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Function panicked when receiving empty string FFI call: %v", r)
		}
	}()

	// Simulasi Panggil FFI
	// Catatan: Jika ptr nil dan length 0, unsafe.Slice() di Go 1.17+ aman (mengembalikan slice kosong).
	result := processStringData(ptr, 0)
	
	if result != 0 {
		t.Fatalf("Expected 0 capitals from empty string, got %d", result)
	}
}
```
