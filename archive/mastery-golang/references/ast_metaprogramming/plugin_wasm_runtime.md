# Eksekusi WASM Plugin Runtime dengan Wazero di Go

> **Berlaku:** Go 1.21+ · `tetratelabs/wazero` · WASI · **Lihat juga:** `embedded_tinygo/wasm_tinygo_browser.md` · `system_programming_linux/seccomp_bpf_sandbox.md` · `runtime_internals/cgo_abi_boundaries.md` · `distributed_patterns_resilience/feature_flags_launchdarkly.md`

## Konsep Utama dan Internal

Seringkali sistem (seperti Kong, Envoy, atau custom API Gateways) menuntut kemampuan di mana pengguna bisa menginjeksi potongan logika ekstensi mereka sendiri (Plugins / Middleware) tanpa harus men-compile ulang aplikasi utamanya.
Dahulu, hal ini diselesaikan melalui library `plugin` Go (yang mensyaratkan dependensi CGO yang ketat dan menyedihkan soal version mismatch), atau IPC rpc lambat via gRPC. 

**WebAssembly (WASM)** menjadi penyelamat di era modern. WebAssembly mendeskripsikan byte-code biner mesin tumpukan virtual yang sangat efisien dan aman. Proyek `tetratelabs/wazero` merevolusi ekosistem Go dengan menciptakan *Zero Dependency WebAssembly Runtime* (100% Go murni tanpa kaitan CGO). Melalui Wazero, aplikasi (Host) bisa memuat byte-code WASM dari bahasa manapun (TinyGo, Rust, C++) di memori yang dikurung (Sandbox). Host bisa meresolve fungsi dari WASM, WASM bisa mengimpor balik (Host Functions) fitur OS standar via spesifikasi lingkungan WASI, dan yang paling krusial: tidak ada delay TCP overhead lintas jaringan. Kecepatannya mendekati nanodetik (*native speed* via AOT compiler JIT di Wazero).

## Diagram Arsitektur dan Aliran Memori (ASCII)

WASM menggunakan alokasi memori berbaris *(Linear Memory)*, bukan heap-pointer biasa. Go (Host) tidak dapat membaca/menulis memori secara aman melainkan melalui alamat offset int32.

```text
 +-------------------------------------------------------------------------+
 |                            GO HOST APPLICATION                          |
 |                                                                         |
 |  [ File Sistem, Jaringan I/O, Database, Konteks Eksekusi (Ctx) ]        |
 |                                                                         |
 |                                   |                                     |
 |  (1. Call Exported Plugin Func)   |   (4. WASM Memanggil Host Function) |
 |  (2. Tulis parameter ke RAM WASM) |                                     |
 |                                   v                                     |
 | +---------------------------------------------------------------------+ |
 | |                        WAZERO JIT RUNTIME                           | |
 | |   +-------------------------------------------------------------+   | |
 | |   |                      WASM GUEST SANDBOX                     |   | |
 | |   |                                                             |   | |
 | |   |  (3. Eksekusi Custom Logic User)                            |   | |
 | |   |                                                             |   | |
 | |   |      +-----------------------------------------------+      |   | |
 | |   |      |   LINEAR MEMORY (RAM Terbatas, misal 2 MB)    |      |   | |
 | |   |      +-----------------------------------------------+      |   | |
 | |   |             ^                   ^                       |   | |
 | |   +-------------|-------------------|-----------------------+   | |
 | +-----------------|-------------------|---------------------------+ |
 |                   |                   | (Pointer Offset di memori)  |
 +-------------------|-------------------|-----------------------------+
```

## Kode Go Production-Ready

Contoh mendemonstrasikan bagaimana mendelegasikan eksekusi ekstensi secara aman (termasuk Injeksi Host Function).

```go
package wasmplugin

import (
	"context"
	"fmt"
	"testing"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// ==========================================
// 1. PENGELOLA RUNTIME WAZERO
// ==========================================

// WasmEngine mengelola instansiasi kompilator WASM AOT/JIT yang mahal.
type WasmEngine struct {
	runtime wazero.Runtime
}

func NewWasmEngine(ctx context.Context) *WasmEngine {
	// Buat runtime teroptimasi default. 
	// Environment ini bersifat Singleton dan di-cache secara agresif.
	r := wazero.NewRuntime(ctx)

	// Inject lingkungan standar WASI (Supaya Guest WASM OS/Browser functions berjalan lancar)
	wasi_snapshot_preview1.MustInstantiate(ctx, r)
	
	return &WasmEngine{runtime: r}
}

func (e *WasmEngine) Close(ctx context.Context) error {
	return e.runtime.Close(ctx) // Tutup seluruh engine saat shutdown aplikasi
}

// ==========================================
// 2. EKSEKUSI PLUGIN DINAMIS
// ==========================================

// RunMathPlugin memuat byte code, menyuntikkan fungsi dari GO ke WASM,
// dan memanggil fungsi spesifik dari WASM secara aman.
func (e *WasmEngine) RunMathPlugin(ctx context.Context, wasmBytes []byte, a, b uint32) (uint32, error) {
	// (A) Host Functions Declaration:
	// Mendefinisikan modul imajiner "env" agar plugin dari luar (WASM) 
	// bisa memanggil fungsi Go lokal (misal: fitur logging Go).
	_, err := e.runtime.NewHostModuleBuilder("env").
		NewFunctionBuilder().
		WithFunc(func(ctx context.Context, mod api.Module, val uint32) {
			// Callback Go ini tereksekusi saat logic dalam sandbox memanggil `host_log`
			fmt.Printf("[Host API Triggered] WASM executed logging: Result is %d\n", val)
		}).
		Export("host_log").
		Instantiate(ctx)

	if err != nil && err.Error() != "module env has already been instantiated" {
		return 0, fmt.Errorf("failed to mount host functions: %w", err)
	}

	// (B) Kompilasi dan Muat Bytecode WASM (Di prod: gunakan Cache wazero.CompiledModule)
	mod, err := e.runtime.Instantiate(ctx, wasmBytes)
	if err != nil {
		return 0, fmt.Errorf("failed to instantiate guest wasm module: %w", err)
	}
	// Pastikan module selalu ditutup setelah return untuk melepas memori alokasi liniarnya
	defer mod.Close(ctx)

	// (C) Temukan referensi fungsi Guest WASM yang mau dieksekusi (e.g., "add")
	addFunc := mod.ExportedFunction("add")
	if addFunc == nil {
		return 0, fmt.Errorf("the plugin did not export expected function 'add'")
	}

	// (D) FIRE! Eksekusi logic internal sandbox WASM
	// Argumen dilempar via stack memori VM sebagai nilai primitif murni.
	results, err := addFunc.Call(ctx, uint64(a), uint64(b))
	if err != nil {
		return 0, fmt.Errorf("execution panic or trapped inside sandbox: %w", err)
	}

	if len(results) == 0 {
		return 0, fmt.Errorf("sandbox executed successfully but returned zero results")
	}

	// Casting byte raw ke int
	return uint32(results[0]), nil
}

// ==========================================
// 3. UNIT TEST (Menguji Integrasi WASM Tanpa File Eksternal)
// ==========================================

func TestWasmEngine_RunMathPlugin(t *testing.T) {
	ctx := context.Background()
	engine := NewWasmEngine(ctx)
	defer engine.Close(ctx)

	// Ini adalah dump heksadesimal kode biner WASM sesungguhnya (Hasil kompilasi C++/Rust/TinyGo).
	// Pseudocode asal WASM: 
	// `func add(a i32, b i32) i32 { return a + b }`
	var mockWASMBytes = []byte{
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 
		0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 
		0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
		0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 
		0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
	}

	result, err := engine.RunMathPlugin(ctx, mockWASMBytes, 20, 15)
	
	if err != nil {
		t.Fatalf("Wazero failed to execute sandbox: %v", err)
	}

	if result != 35 {
		t.Errorf("Expected 35, got %d", result)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengompilasi Bytecode Berulang Kali pada Skenario HTTP Request
Pengembang pemula menyertakan panggilan `runtime.Instantiate(ctx, wasmBytes)` secara naif di setiap siklus `ServeHTTP` router API-nya, memanggil file biner mentah.

```go
// ❌ BAD: Mem-parsing biner byte dan mengkompilasi Ulang VM JIT per HTTP Request
func HandleRequest(w http.ResponseWriter, r *http.Request) {
    bytes, _ := os.ReadFile("plugin.wasm")
    wazeroRuntime.Instantiate(ctx, bytes) // Re-compile AOT (Lambat: 10-50ms)
}
```
**Why dangerous:** Wazero bukan *interpreter* lambat, ia akan menganalisis biner WASM dan mengkompilasinya menggunakan arsitektur (AOT - Ahead of Time). Pemanggilan iteratif instruksi tersebut memicu komputasi masif per request yang membuat latensi API meledak tak terkendali serta menghancurkan RAM (*Garbage Collector hell*).
**Solusi (Benar):** Kompilasi di muka (Pre-compile) secara _Singleton_. Saat boot server, gunakan `compMod, _ := runtime.CompileModule(ctx, bytes)` dan simpan objeknya (Cache). Lalu, di HTTP Handler untuk setiap request, cukup buat namespace/instance mandiri yang ringan menggunakan memory pointer via fungsi terpisah `runtime.InstantiateModule(ctx, compMod, wazero.NewModuleConfig().WithName(uniqueId))`.

### ❌ Anti-Pattern 2: Mengasumsikan Linear Memory itu Sama dengan Host Heap
WASM tidak mem-passing data majemuk (strings, array, json structs) ke bahasa induknya via parameter murni. 

```go
// ❌ BAD: Mencoba mem-passing pointer host (Go) ke WASM Guest
jsonBytes := []byte(`{"request": true}`)
ptrStr := &jsonBytes[0]

// Guest (WASM) di Sandbox dilarang membongkar alamat memori Host (Go)!
addFunc.Call(ctx, uint64(uintptr(unsafe.Pointer(ptrStr)))) // SEGFAULT PANIC!
```
**Why dangerous:** Sandbox WebAssembly hidup di tata ruang linear memori virtual tertutup yang diisolasi oleh Wazero JIT. Ia HANYA memahami tipe `int32/int64/float32/float64`. Jika Anda memaksakan OS RAM Host pointer ke eksekusi plugin, WASM akan mengakses alamat tidak sah (Index Out of Bound) dan mematikan (Traps) modul secara mematikan.
**Solusi (Benar):** Lakukan *Shared Memory Serialization*. Tulis string yang Anda mau ke memori WASM itu sendiri. 
1. Ekspor fungsi pendealokasian (misal `malloc` di TinyGo) dan jalankan dari Host untuk memesan ukuran buffer.
2. Dapatkan address buffer (`offset`).
3. Tulis slice bytes dari Host langsung ke instansiasi linear memory dengan modul: `mod.Memory().Write(offset, jsonBytes)`. 
4. Oper parameter `offset` integer 32-bit itu ke parameter `Call()`, WASM kemudian merangkum buffer pada alokasinya.

## Edge Cases & Defensive Programming Konkrit

1. **Penjara Kehabisan Waktu (*Infinite Loop Sandbox Tarpit*):**
   Kode *third-party* yang Anda jalankan kelewat batas, memiliki bug rekursi, atau *for { }* loop tak terbatas (Bisa jadi serangan DOS mematikan/Hanging goroutines) dan VM mengunci satu *CPU core host* secara abadi.
   *Defensive:* Engine WASM tak pernah bisa ditembus, tetapi dapat dihentikan (Interrupt). Set up mekanisme `wazero.NewRuntimeConfig().WithContextDeadline()` atau implementasikan batas *Execution Gas (Fuel)* khusus yang menjeda (Traps) sandbox ketika kuota limit CPU yang telah ditentukan host dicabut paksa.

2. **Panic di Fungsi Host-Callback yang Diekspos (Callback Traps):**
   Mungkin Anda menginjeksikan fitur Go ke Plugin (contoh: Database `ExecuteSQL` Go API disodorkan agar plugin bisa menembak database). Jika kode Golang DB Anda *panic* saat berjalannya iterasi (misal koneksi putus), dan tidak diblokir/direcover, *engine compiler internal JIT wazero* juga ikut hancur.
   *Defensive:* Di setiap implementasi `WithFunc(func(...) {...})` (pintu penghubung Go-API ke WASM), SELALU bungkus logic Go dengan `defer recover()`. Tangkap masalah dari Go, terjemahkan jadi Return kode error 1/0 ke dalam Sandbox, seolah-olah C-ABI standar memancarkan OS Error Code secara senyap.

3. **Memory Leaks pada Instance Persistent Module:**
   Jika sebuah modul plugin stateful ditaruh (cached) terus menerus secara konkuren oleh banyak goroutine di instance `Module` yang sama, setiap pemanggilan internal *malloc* yang diekspos (tapi si penulis TinyGo/Rust tidak pernah mem-`free` heap-nya) akan melebarkan (*grow*) kurva limit *api.Memory* sandbox tanpa henti hingga Server Go Host meletus kehabisan RAM Host OS.
   *Defensive:* Instansiasi sandbox `Module` baru per *request pipeline isolation* dan pastikan SELALU jalankan `.Close(ctx)` via defer. Ini langsung memusnahkan arena Linear Memory sebesar apapun milik plugin WASM itu (membabat bersih memory leaks Guest) seketika secara serentak ke OS.

## Kapan JANGAN Pakai Ini

- **Plugin WASM bila `plugin` Go atau proses terpisah cukup.** WASM membawa runtime, batas ABI, dan biaya konversi data di setiap panggilan. Proses terpisah yang berkomunikasi lewat pipa sering lebih sederhana dan lebih mudah didebug.
- **Tanpa batas sumber daya per instans.** Modul WASM bisa mengalokasikan memori dan berputar dalam loop tak berujung. Tanpa batas memori dan mekanisme penghentian, satu plugin bisa menjatuhkan host.
- **Untuk pekerjaan yang membutuhkan throughput tinggi lintas batas.** Setiap panggilan menyalin data melintasi batas memori linear WASM. Pada data besar dan frekuensi tinggi, penyalinan itu mendominasi.
- **Menganggap WASM sebagai sandbox keamanan yang lengkap.** Ia mengisolasi memori dengan baik, tetapi setiap fungsi host yang Anda ekspos adalah permukaan serangan. Sandbox-nya sekuat antarmuka yang Anda berikan.
- **Mengkompilasi Go ke WASM tanpa memperhitungkan ukuran dan runtime.** Biner Go WASM membawa runtime dan GC; TinyGo menghasilkan yang jauh lebih kecil dengan trade-off kompatibilitas.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Host kehabisan memori | batas memori per instans WASM | Modul mengalokasikan tanpa batas |
| Satu plugin menggantung seluruh host | mekanisme penghentian | Tidak ada batas waktu eksekusi |
| Throughput rendah pada data besar | ukuran data per panggilan | Penyalinan lintas batas mendominasi |
| Plugin bisa melakukan hal tak terduga | daftar fungsi host | Permukaan serangan ada di API host |
| Ukuran modul sangat besar | kompilator yang dipakai | Go standar membawa runtime penuh |

```bash
# Ukuran modul: Go standar vs TinyGo
ls -lh plugin.wasm
wasm-objdump -h plugin.wasm 2>/dev/null | head

# Batas yang benar-benar diterapkan host
curl -s localhost:9090/metrics | grep -E 'wasm_(instances|memory_bytes|exec_duration|killed_total)'

# Plugin yang dihentikan karena melewati batas
kubectl logs -l app=host --since=1h | grep -ci 'wasm.*timeout\|wasm.*memory limit'
```
