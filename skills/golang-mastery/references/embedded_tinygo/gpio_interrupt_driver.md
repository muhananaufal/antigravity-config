# GPIO & Interrupt Driver (TinyGo)

## Konsep Internal & Trade-offs

Di lingkungan *Bare Metal* mikrokontroler (SRAM di bawah 256KB, frekuensi CPU 16MHz-133MHz), menangani sinyal digital melalui pin GPIO (*General Purpose Input Output*) secara efisien adalah fundamental. Berbeda dengan Go di backend web di mana interaksi hardware di-abstraksi oleh OS, dengan TinyGo Anda berinteraksi nyaris langsung dengan register CPU.

Dua paradigma utama menangani input (seperti tombol ditekan, sensor mendeteksi hambatan, atau sinyal *Clock* I2C) adalah:
1. **Polling (Busy Wait)**: Goroutine terus-menerus mengecek status register pin GPIO (misal `pin.Get()`) di dalam loop tak terbatas.
2. **Hardware Interrupts (IRQ)**: CPU diberi tahu oleh peripheral perangkat keras HANYA saat ada transisi sinyal listrik. CPU otomatis menghentikan tugas saat ini, dan melompat (context switch) ke *Interrupt Service Routine (ISR)*.

**Trade-offs Polling vs Interrupt:**
Polling sangat memboroskan baterai (CPU terus terjaga 100%) dan menghalangi tugas goroutine lain pada *cooperative scheduler* jika Anda lupa menyisipkan `runtime.Gosched()`. Di sisi lain, *Interrupt* (IRQ) 100% efisien karena hardware yang memantau pin. Namun, menulis ISR menggunakan bahasa level tinggi seperti Go sangat berbahaya. ISR dieksekusi di level kernel/hardware: Anda tidak boleh melakukan alokasi memori (heap), tidak boleh mengeblok I/O (seperti `println`), dan tidak boleh berinteraksi kompleks dengan *scheduler* Go. 

Di TinyGo, trik terbaiknya adalah memadukan IRQ Hardware untuk menangkap sinyal, dan *non-blocking channel send* untuk mengembalikan kontrol logika ke goroutine aman di ruang pengguna (*User Space*).

## Arsitektur & Alur Interupsi Perangkat Keras

```text
    Sinyal Listrik Fisik (Tombol Ditekan)
            v
[ 3.3v -> Transisi Tepi Jatuh (Falling Edge) -> 0v ]
            v
     Hardware MCU Trigger (RP2040 / AVR)
            |
            | (Pre-empts Goroutine apa pun yang sedang jalan)
            v
+---------------------------------------+
|  Interrupt Service Routine (ISR)      |
|  - Handler Kecil/Cepat                |
|  - Non-blocking channel send:         |
|    select { case ch <- event: }       |
|  - Selesai dalam mikrodetik           |
+---------------------------------------+
            | (Sinyal masuk Channel)
            v
+---------------------------------------+
|  User Space Goroutine (Go Scheduler)  |
|  <- ch                                |
|  - Melakukan delay Debounce           |
|  - Menulis state ke Network / Serial  |
|  - Aman alokasi memori                |
+---------------------------------------+
```

## Kode Go Production-Ready

Kode di bawah menunjukkan implementasi driver `Rotary Encoder` (tombol putar volume) yang membutuhkan deteksi sinyal sangat cepat tanpa membebani CPU. Terdapat pemisahan jelas antara ISR dan Goroutine logika utama.

```go
package hardware

import (
	"context"
	"machine"
	"sync/atomic"
	"time"
)

// RotaryEncoderDriver membungkus abstraksi hardware putaran mekanik.
type RotaryEncoderDriver struct {
	pinA machine.Pin
	pinB machine.Pin

	// Flag atomic untuk passing data lock-free dari ISR ke Goroutine
	position atomic.Int32 

	// Channel sebagai trigger notifikasi dari ISR ke User Space
	triggerCh chan struct{}
}

// NewRotaryEncoderDriver inisialisasi pin dengan interupsi hardware.
func NewRotaryEncoderDriver(pinA, pinB machine.Pin) *RotaryEncoderDriver {
	pinA.Configure(machine.PinConfig{Mode: machine.PinInputPullup})
	pinB.Configure(machine.PinConfig{Mode: machine.PinInputPullup})

	driver := &RotaryEncoderDriver{
		pinA:      pinA,
		pinB:      pinB,
		// Buffered 1 untuk menghindari block pada ISR
		triggerCh: make(chan struct{}, 1), 
	}

	// Daftarkan ISR pada transisi Falling Edge Pin A
	pinA.SetInterrupt(machine.PinFalling, driver.handleInterrupt)

	return driver
}

// handleInterrupt dieksekusi oleh MCU HARDWARE di level register.
// [CRITICAL] Fungsi ini tidak boleh mengandung alokasi heap atau operasi blokir (Print).
func (d *RotaryEncoderDriver) handleInterrupt(pin machine.Pin) {
	// Logika pembacaan sinyal B untuk menentukan arah putaran (Searah/Berlawanan Jarum Jam)
	// (Menggunakan pin.Get() yang bersifat register read langsung, O(1) dan instan)
	if d.pinB.Get() {
		d.position.Add(1) // Clockwise
	} else {
		d.position.Add(-1) // Counter-Clockwise
	}

	// Kirim notifikasi tanpa-blokade.
	// Jika channel sudah penuh, biarkan sinyal jatuh (debouncing).
	select {
	case d.triggerCh <- struct{}{}:
	default:
	}
}

// StartEventLoop berjalan pada goroutine biasa (User space scheduler TinyGo)
func (d *RotaryEncoderDriver) StartEventLoop(ctx context.Context, onTurn func(pos int32)) {
	go func() {
		var lastPos int32 = d.position.Load()

		for {
			select {
			case <-ctx.Done():
				return
			case <-d.triggerCh:
				// ISR baru saja memperbarui nilai atomik
				currentPos := d.position.Load()
				
				if currentPos != lastPos {
					// Callback ke aplikasi user (Aman untuk memanggil print, I2C, alokasi memori di sini)
					onTurn(currentPos)
					lastPos = currentPos
				}

				// Debounce mekanikal: Matikan pendengaran event sesaat
				// agar getaran per plat mekanik (bouncing) tidak merusak event.
				// Memanggil Sleep pada Goroutine akan mengembalikan CPU ke goroutine lain (Cooperative Yield).
				time.Sleep(2 * time.Millisecond)
			}
		}
	}()
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Blokade I/O dan Alokasi Dinamis di Dalam Interrupt
Menggunakan fungsi *print* dan alokasi `struct`/`slice` di dalam ISR.

```go
// BAD: Mencetak ke layar dan membuat string baru di level Hardware ISR
func onButtonPress(pin machine.Pin) {
	message := "Button was pressed at " + time.Now().String() // BAHAYA: Heap Allocation
	println(message) // BAHAYA: Blocking UART I/O (Bisa jutaan siklus CPU lamanya)
}
```
**Why dangerous:** Pada RTOS atau implementasi bare-metal TinyGo, fungsi ISR menghentikan *seluruh* eksekusi sistem. Jika ISR mencoba mencetak ke konsol UART lambat (misal baud rate 9600), interupsi jaringan WiFi atau sensor lain di latar belakang akan hilang/basi. Lebih parah, alokasi heap (menggunakan operator `+` pada *string* dinamis) dapat memicu algoritma GC (`Stop The World`) di tengah ISR, yang berujung pada kerusakan pointer memori (*Hard Fault / MCU Restart*). Selalu pisahkan pendeteksian di ISR dengan pemrosesan di Goroutine.

### ❌ Anti-Pattern 2: Debouncing menggunakan `time.Sleep` di dalam Interrupt Handler
Menggunakan asumsi bahasa pemrograman level tinggi (seperti Web JS) untuk mendelay bacaan agar menepis bounce elektrik dari tombol logam fisik.

```go
// BAD: Menghentikan CPU di dalam kernel ISR selama 50 milidetik
func onButtonPress(pin machine.Pin) {
	time.Sleep(50 * time.Millisecond) // CPU nge-freeze, sistem gantung 50ms!
	if !pin.Get() {
		state.ButtonCounter++
	}
}
```
**Why dangerous:** Memanggil `time.Sleep` atau timer dari *runtime* Go di dalam ISR adalah bunuh diri arsitektural di mikrokontroler. Ini akan mengunci seluruh OS/Scheduler TinyGo. Selama 50ms, perangkat Anda tidak responsif sama sekali (tidak bisa merender layar, membaca sensor vital). Solusi yang benar adalah memindahkan timer (Sleep) ke channel receiver di *user space* goroutine, BUKAN di deklarasi fungsi `SetInterrupt`.

### ❌ Anti-Pattern 3: Shared Memory Tanpa Atomic / Volatile Protection
Berbagi variabel antara ISR dan goroutine utama dengan deklarasi int biasa.

```go
// BAD: Data race antara core hardware ISR dan software Goroutine
var counter int32 = 0

func isr(pin machine.Pin) {
	counter++ // Terjadi diluar kendali Scheduler
}
```
**Why dangerous:** Operasi `counter++` di arsitektur ARM terdiri dari 3 instruksi (Read, Add, Store). Jika goroutine membaca memori ini ketika ISR sedang berada di pertengahan instruksi `Add`, nilai akan rusak (*Data Race*). Karena ini interupsi level perangkat keras, `-race` detektor Go tidak akan menemukannya saat dikompilasi! Gunakan selalu tipe bawaan `sync/atomic` (seperti `atomic.Int32`) untuk modifikasi memori yang di-share antara konteks interupsi perangkat keras dan rutin perangkat lunak, agar kompilator LLVM dan CPU membangkitkan penjagaan memori barier (*memory barrier/fence*) yang tepat.

## Edge Cases

1. **Interrupt Storm (Badai Interupsi):** Jika kabel sensor Anda goyah atau dekat dengan sumber interferensi Elektromagnetik tinggi (seperti Motor DC 12V), pin GPIO yang diset mode *Interrupt* akan terpicu ribuan kali dalam satu detik (Bounce berlebih). ISR akan dieksekusi terus menerus mengalahkan rutinitas goroutine utama (Sistem lumpuh tapi tidak *crash*). Pastikan selalu menerapkan kapasitor 0.1uF di PCB fisik sebagai *Hardware Debouncing* tambahan, bukan cuma di *software*.
2. **Keterbatasan Register Pin Board Spesifik:** Pada beberapa board mikrokontroler (seperti Arduino AVR ATmega328p / Arduino Uno), tidak semua pin mendukung *External Interrupts*. Hanya Pin 2 dan 3 yang mendukungnya. Memanggil `SetInterrupt` pada Pin 10 mungkin diam-diam tidak akan memberikan error pada kompilator TinyGo, namun handler tidak akan pernah terpicu. Selalu cross-check dengan Datasheet hardware Anda sebelum merancang program pin IRQ massal.
3. **Ghost Trigger saat Inisialisasi:** Saat program pertama kali memanggil konfigurasi pin `PinInputPullup`, kapasitansi internal kabel membutuhkan beberapa *microsecond* untuk stabilisasi ke tegangan 3.3v. Jika Anda mendaftarkan `SetInterrupt` terlalu cepat sebelum kapasitansi rata, Anda akan menerima *Phantom Interrupt* 1 kali sesaat sistem menyala. Selalu sisipkan yield/sleep sangat kecil (`time.Sleep(1 * time.Millisecond)`) antara fase konfigurasi `Configure()` dan registrasi `SetInterrupt()`.

## Unit Test Meaningful

Menguji logika ISR *mocking* tanpa harus memiliki board perangkat keras asli (menggunakan Hexagonal Architecture style).

```go
package hardware_test

import (
	"context"
	"testing"
	"time"
)

// Catatan: Kode tes ini bergantung pada abstraksi interface dari library utama.
// Kita akan menggunakan stub untuk simulasi Atomic State & Event Loop.

type MockRotarySystem struct {
	triggerCh chan struct{}
	lastPos   int32
}

func TestRotaryEncoder_EventLoopDebounce(t *testing.T) {
	// Simulasi lingkungan rotary encoder yang disederhanakan
	triggerCh := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var eventCount int
	var recordedPos []int32

	// Simulasi StartEventLoop yang mendengarkan trigger dari channel
	go func() {
		var pos int32 = 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-triggerCh:
				// Asumsikan ISR telah mengubah nilai atomic position ke 1
				pos = 1 
				
				eventCount++
				recordedPos = append(recordedPos, pos)
				
				// Debounce mekanikal
				time.Sleep(20 * time.Millisecond)
			}
		}
	}()

	// Simulasi: Badai Interupsi (Interrupt Storm / Bouncing mekanikal parah)
	// Hardware terpicu 3 kali berturut-turut dalam hitungan mikrosekon
	select {
	case triggerCh <- struct{}{}:
	default:
	}
	select {
	case triggerCh <- struct{}{}:
	default:
	}
	select {
	case triggerCh <- struct{}{}:
	default:
	}

	// Beri waktu bagi goroutine merespon
	time.Sleep(50 * time.Millisecond)

	// Validasi Debounce & Non-blocking channel send
	// Berapapun sinyal hardware memborbardir, karena channel ukuran 1 (buffered) 
	// dan adanya jeda debounce di User Space goroutine, aplikasi hanya boleh 
	// mendaftarkannya sebagai 1 kali event yang teratur.
	if eventCount != 1 {
		t.Fatalf("Debouncing and channel drop failed. Expected 1 event, got %d", eventCount)
	}

	// Setelah delay lewat, trigger wajar (Manusia mutar pelan)
	select {
	case triggerCh <- struct{}{}:
	default:
	}
	time.Sleep(30 * time.Millisecond)

	if eventCount != 2 {
		t.Fatalf("Expected second legit rotation to register, got %d events", eventCount)
	}
}
```
