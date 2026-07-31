# TinyGo & Microcontroller Basics

## Konsep Internal & Trade-offs

TinyGo adalah sebuah *compiler* alternatif untuk bahasa Go yang menggunakan LLVM sebagai *backend*. Secara desain, TinyGo ditujukan secara spesifik untuk memecahkan kelemahan utama standard compiler Go (GC berat, runtime besar, minimum biner 2MB+) agar bisa berjalan di *embedded systems* bersumber daya super rendah, mikrokontroler (contoh: memori SRAM <64KB), dan WebAssembly.

Perbedaan fundamental TinyGo dengan Go standar terletak pada manajemen memori dan interaksi perangkat keras:
1. **Conservative Garbage Collector**: Tidak ada GC *concurrent* yang canggih. GC di TinyGo seringkali bersifat *stop-the-world* yang dipanggil berdasarkan alokasi (atau bisa dimatikan sepenuhnya menggunakan `-gc=none`).
2. **Machine Package (HAL)**: Di Go standar, kita memakai package `os` atau `net` untuk berinteraksi dengan sistem host. Di TinyGo untuk bare-metal, OS tidak ada. Interaksi langsung menyentuh register hardware CPU mikrokontroler melalui package `machine`. 
3. **Goroutine Minimalis**: Penjadwalan (*scheduler*) bersifat *cooperative*. Artinya goroutine hanya akan berpindah (yield) jika mendapati blok I/O, `time.Sleep`, atau instruksi `runtime.Gosched()`. Tidak pre-emptive berdasarkan waktu seperti di runtime Go Linux/Windows.

Pemrograman Go pada perangkat keras mengubah paradigma kita. Alokasi heap (`new(T)`, membuat `slice` dinamis) yang murah di server, menjadi malapetaka di mikrokontroler (RAM 264KB pada RP2040 Pico) yang akan menguras SRAM dan memicu fragmentasi memori (*Out Of Memory* panik tanpa peringatan).

## Arsitektur & Hardware Abstraction Layer

```text
+-----------------------------------------------------------+
|                     Aplikasi Go Anda                      |
|                  (import "machine", "time")               |
+-----------------------------------------------------------+
|                    TinyGo Core / Runtime                  |
| (Goroutine scheduler kooperatif, Conservative GC, panic)  |
+-----------------------------------------------------------+
|  [go:build rp2040]           |  [go:build avr]            |
|  machine_rp2040.go (Pico)    |  machine_avr.go (Arduino)  |
|  (Register: 0x40014000)      |  (Register: 0x0020)        |
+-----------------------------------------------------------+
|             Hardware (RP2040, AVR ATmega328p)             |
+-----------------------------------------------------------+
```

## Kode Go Production-Ready

Contoh di bawah mengimplementasikan sistem pembacaan Sensor via GPIO dengan metode non-blocking (memanfaatkan Goroutine kooperatif) dan menggunakan interupsi (*Interrupt*) sebagai ganti dari *busy-loop polling* yang memboroskan CPU dan baterai.

```go
package main

import (
	"context"
	"fmt"
	"machine"
	"time"
)

// SensorHandler membungkus konfigurasi peripheral GPIO
type SensorHandler struct {
	sensorPin machine.Pin
	ledPin    machine.Pin
	triggerCh chan struct{}
}

// NewSensorHandler inisialisasi pin dan interupsi pada mikrokontroler
func NewSensorHandler(sensor machine.Pin, led machine.Pin) *SensorHandler {
	// Konfigurasi LED sebagai Output (Digital)
	led.Configure(machine.PinConfig{Mode: machine.PinOutput})
	
	// Konfigurasi pin Sensor sebagai Input Pullup (agar default High 3.3v, Trigger Low)
	sensor.Configure(machine.PinConfig{Mode: machine.PinInputPullup})

	handler := &SensorHandler{
		sensorPin: sensor,
		ledPin:    led,
		triggerCh: make(chan struct{}, 1), // Buffered channel size 1 sangat penting!
	}

	// Daftarkan Hardware Interrupt (IRQ).
	// Ini JAUH lebih efisien daripada polling `if sensor.Get()` dalam loop terus menerus.
	sensor.SetInterrupt(machine.PinFalling, handler.onSensorTrigger)

	return handler
}

// onSensorTrigger dipanggil langsung oleh Hardware ISR (Interrupt Service Routine).
// PENTING: Jangan lakukan operasi berat (print, alokasi memori, block) di dalam ISR!
func (s *SensorHandler) onSensorTrigger(pin machine.Pin) {
	select {
	case s.triggerCh <- struct{}{}:
		// Berhasil memberi sinyal ke Goroutine
	default:
		// Channel penuh, trigger terabaikan (debouncing sederhana)
	}
}

// Start menjalankan logika aplikasi tanpa memblokir
func (s *SensorHandler) Start(ctx context.Context) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				// Matikan LED sebelum exit (best practice cleanup)
				s.ledPin.Low()
				return
			case <-s.triggerCh:
				// Sinyal dari ISR hardware masuk, jalankan logika!
				// LED menyala indikasi deteksi
				s.ledPin.High()
				
				// Debounce delay kooperatif. Yield scheduler.
				time.Sleep(250 * time.Millisecond)
				
				s.ledPin.Low()
			}
		}
	}()
}

// Entrypoint utama jika di-compile dan diflash ke board
func main() {
	// machine.LED adalah alias bawaan (misal GPIO 25 di Pico)
	// machine.GP15 adalah GPIO 15 fisik
	handler := NewSensorHandler(machine.GP15, machine.LED)
	
	ctx := context.Background()
	handler.Start(ctx)

	// Main thread *HARUS* dikunci (block), jangan sampai main() return,
	// karena jika main() selesai, seluruh runtime mati (power reset).
	for {
		// print ke default UART (Serial USB)
		println("System Heartbeat - CPU Idle")
		time.Sleep(2 * time.Second)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengimpor `fmt` dan `reflect` Secara Luas
Pemrogram yang biasa membuat web server Go terbiasa memakai `fmt.Sprintf` atau JSON *marshalling* berbasis `reflect`.

```go
// BAD: Import fmt dan memanggilnya di loop
import "fmt"

func loop() {
    temp := 28.5
    // Hal ini akan memicu alokasi heap besar dan membawa binary reflect/fmt (ratusan KB)
    fmt.Printf("Suhu saat ini: %f\n", temp) 
}
```
**Why dangerous:** Binary *footprint*. Package `fmt` dan `reflect` bergantung pada banyak package dasar di *core library* Go. Jika Anda meng-importnya, TinyGo terpaksa mem-bundle seluruh logika refleksi, sehingga ukuran firmware *flash memory* bisa melonjak dari 15KB menjadi 400KB+. Selain memakan ROM/Flash, `fmt.Printf` melakukan alokasi *interface{}* yang menghasilkan buangan GC pada *heap*. Gunakan bawaan `println()` atau konversi string statis manual.

### ❌ Anti-Pattern 2: Infinite Busy Loop Tanpa Yield
Membuat loop yang ketat (tight loop) pada bare metal untuk menunggu event.

```go
// BAD: Menunggu I2C / GPIO ready dengan Busy Loop
for !machine.GP12.Get() {
    // Kosong
}
```
**Why dangerous:** Pada TinyGo, scheduler goroutine tidak bisa secara paksa mengambil alih thread (pre-emption) jika Anda tidak pernah memanggil fungsi yang merelakan (*yield*) CPU. Busy loop di atas akan mengambil CPU 100% dan mengunci / mendeadlock semua Goroutine lain, termasuk garabage collector (*starvation*). Solusi terbaik: gunakan Hardware `Interrupt` (seperti contoh production-ready) atau sisipkan `time.Sleep(1 * time.Millisecond)` atau `runtime.Gosched()` ke dalam loop.

### ❌ Anti-Pattern 3: Alokasi Heap Dinamis di ISR (Interrupt Service Routine)
Membuat variabel baru atau slice ketika interupsi perangkat keras tertrigger.

```go
// BAD: Alokasi atau blokade di dalam Interrupt Handler
func onTrigger(pin machine.Pin) {
    data := make([]int, 100) // BAHAYA! Memicu Heap Allocation/GC di ISR
    println("Triggered")     // BAHAYA! UART Blocking Print di dalam ISR
}
```
**Why dangerous:** ISR (Interrupt Service Routine) mengeksekusi kode langsung di tingkat hardware register (melompati konteks scheduler). Melakukan alokasi memori bisa memicu algoritma *Garbage Collector* secara tiba-tiba di tengah eksekusi kernel level perangkat keras, yang akan berujung pada *Hard Fault* atau memori korup. Mencetak ke UART (println) bersifat blokir I/O; CPU tidak bisa merespons interupsi lain yang mengantri. Selalu catat state saja (misal merubah boolean statis) atau *non-blocking send* ke *buffered channel*.

## Edge Cases

1. **Floating Point Support (FPU) Ketiadaan Hardware**: RP2040 (Raspberry Pi Pico) atau mikrokontroler murah berbasis ARM Cortex M0+ **tidak memiliki unit komputasi float (FPU)** perangkat keras. Ketika Anda menulis `3.14 * radius`, instruksi ini diemulasikan (soft-float) oleh puluhan instruksi perakitan (assembly). Jika komputasi float64 terjadi secara intens di *game loop* layar LED matriks, frame rate Anda akan hancur lebur. Hindari `float32/64`, gunakan `int32` (*fixed-point arithmetic*) sebisa mungkin.

2. **Perbedaan Pemetaan Pin (Pin Mapping Conflicts)**: `machine.I2C0` (bus I2C pertama) secara *default* akan mengikat ke pin tertentu berdasarkan konfigurasi *build target*. Misalnya, I2C0 Pico default mengikat SDA ke pin 4. Jika PCB kustom Anda mendesain SDA di pin 12, program Anda akan kompilasi sukses namun I2C mati diam-diam (*silent fail*). Selalu panggil eksplisit `machine.I2C0.Configure(machine.I2CConfig{SDA: machine.GP12, SCL: machine.GP13})` sebelum menggunakannya.

3. **Panic & Dump UART Tanpa Telinga**: Jika terjadi `panic` (misalnya indeks out of bounds array) di bare-metal mikrokontroler, layar perangkat tidak akan memberi tahu apa-apa (hanya "nge-freeze"). TinyGo sebenarnya merender dump stack trace ke default UART TX (Serial output). Jika Anda merancang perangkat keras tertanam yang sudah di dalam kotak (tanpa kabel USB), Anda buta sama sekali terhadap *panic*. Terapkan blok `defer func() { recover() ... }` dan kelola dengan mencatat error ke *EEPROM/Flash* internal atau menyalakan LED MERAH pertanda *panic recovery state*.

## Unit Test Meaningful

Karena package `machine` mengandung *low-level register pointers* (contohnya `volatile uint32` struct di *C binding* LLVM), kode board *TIDAK BISA* dikompilasi menggunakan `go test` normal di Host PC Linux/Windows. Anda harus menyembunyikan `machine` di balik *Interface Go* (*Hexagonal Architecture*) agar tes bisa *mocking* interaksi perangkat keras.

```go
package main_test

import (
	"context"
	"testing"
	"time"
)

// Abstraksi Pin agar bisa di-mock di lingkungan Desktop PC
type Pin interface {
	High()
	Low()
	Get() bool
}

type MockPin struct {
	state bool
}

func (m *MockPin) High() { m.state = true }
func (m *MockPin) Low()  { m.state = false }
func (m *MockPin) Get() bool { return m.state }

// (Asumsikan kita memodifikasi production code NewSensorHandler untuk menerima Pin interface)
// func NewSensorHandler(sensor Pin, led Pin)

func TestSensorInterruptLogic_Mocked(t *testing.T) {
	mockLed := &MockPin{state: false}
	
	// Tes logika Goroutine utama (State Machine/Business Logic) 
	// tanpa menyentuh package 'machine' yang spesifik hardware.
	
	// Untuk demo, asumsikan handler menerima channel langsung sebagai injeksi dependensi
	triggerCh := make(chan struct{}, 1)
	
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Simulasi Start() handler
	go func() {
		for {
			select {
			case <-ctx.Done():
				mockLed.Low()
				return
			case <-triggerCh:
				mockLed.High()
				// Sesuai logika: tahan LED nyala sejenak untuk debouncing
				time.Sleep(50 * time.Millisecond) // dicepatkan untuk tes
				mockLed.Low()
			}
		}
	}()

	// Kondisi awal LED harus mati
	if mockLed.Get() {
		t.Fatal("Ekspektasi LED inisial mati")
	}

	// 1. Tembak Interupsi Palsu (Simulasi Hardware Trigger)
	triggerCh <- struct{}{}
	
	// Tunggu sebentar (yield ke goroutine) agar masuk ke case triggerCh
	time.Sleep(10 * time.Millisecond)
	
	// Cek LED harus hidup selama fase debounce
	if !mockLed.Get() {
		t.Fatal("Ekspektasi LED menyala sesaat setelah trigger dipicu (Hardware IRQ)")
	}

	// 2. Tunggu debounce selesai (50ms)
	time.Sleep(60 * time.Millisecond)

	// Cek LED harus mati setelah debounce
	if mockLed.Get() {
		t.Fatal("Ekspektasi LED mati otomatis setelah debounce selesai")
	}
}
```
