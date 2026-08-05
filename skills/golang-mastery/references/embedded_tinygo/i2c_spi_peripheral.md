# I2C & SPI Peripherals (TinyGo)

> **Berlaku:** TinyGo 0.31+ · **Lihat juga:** `embedded_tinygo/gpio_interrupt_driver.md` · `embedded_tinygo/tinygo_microcontroller_basics.md` · `embedded_tinygo/mqtt_edge_messaging.md` · `realtime_networking/custom_binary_protocol.md`

## Konsep Internal & Trade-offs

Di dunia mikrokontroler (embedded systems), membaca sensor canggih (seperti Giroskop MPU6050 atau Layar OLED SSD1306) atau menulis memori eksternal (SD Card / Flash) jarang menggunakan kaki digital biasa (GPIO/DigitalRead). Anda butuh protokol komunikasi bus serial perangkat keras: **I2C (Inter-Integrated Circuit)** atau **SPI (Serial Peripheral Interface)**.

Perbedaan fundamental (Trade-offs):
1. **SPI**: Sangat cepat (10-40 MHz). Arsitektur *Push-Pull*, menggunakan 4 kabel minimal (SCK, MOSI, MISO, CS/SS). Setiap nambah sensor/layar SPI baru, butuh tambah 1 kaki kabel khusus (Chip Select / CS). Cocok untuk layar LCD/OLED, Kamera, SD Card yang butuh data masif (*bandwidth tinggi*).
2. **I2C**: Cenderung lambat (100kHz - 400kHz). Arsitektur *Open-Drain* (butuh resistor *pull-up*), cukup 2 kabel untuk puluhan sensor (SDA, SCL). Tiap sensor dibedakan berdasarkan *Address* heksadesimal unik (misal 0x3C). Cocok untuk sensor suhu, akselerometer, kompas.

Di TinyGo, penguasaan package `machine` untuk `I2C` dan `SPI` sangat mutlak. Implementasi TinyGo membungkus register perangkat keras menjadi antarmuka mirip package `io.ReadWriter` dalam Go standar.

## Arsitektur & Alur Komunikasi Bus

```text
[ SPI BUS (Full Duplex - Cepat) ]         [ I2C BUS (Half Duplex - Hemat Kabel) ]
 
       +-----------+                            +-----------+
       | MCU (Go)  |                            | MCU (Go)  |
       |  (Master) |                            |  (Master) |
       +-----------+                            +-----------+
      /   |    |    \                                 | |  (Pull-up Resistors)
    CS1  CS2  SCK  MOSI/MISO                     SDA--+-+--- SCL
    /     |     |     |                               |      |
+----+ +----+   |     |                          +----+      |
|SD  | |LCD |<--+-----+                          |Suhu|------+
|(S1)| |(S2)|<--------+                          |0x40|------+
+----+ +----+                                    +----+      |
(Butuh CS per perangkat)                         +----+      |
                                                 |Gyro|------+
                                                 |0x68|
                                                 +----+
```

## Kode Go Production-Ready

Contoh berinteraksi dengan sensor lingkungan (suhu BME280 atau kompas hmc5883l) melalui I2C, termasuk *error handling* jika sensor tidak tersolder/putus. 

Dalam praktiknya, kita tidak menulis ulang byte-level protokol register, tetapi menggunakan driver yang sudah dibuat komunitas TinyGo (`tinygo.org/x/drivers`). Namun, contoh ini menunjukkan cara membaca 1 byte identitas register murni di bare-metal untuk diagnosis.

```go
package peripheral

import (
	"fmt"
	"machine"
	"time"
)

// Contoh membaca ID Chip (Who Am I Register) dari sensor MPU6050/BME280 di I2C0
const (
	SensorAddress = 0x68 // Alamat sensor di bus I2C (datasheet spec)
	WhoAmIRegister = 0x75 // Alamat register internal sensor
)

func InitAndDetectSensor() error {
	// 1. Konfigurasi Peripheral I2C bawaan MCU (misal I2C0)
	// Kita set pin spesifik (SDA, SCL) dan frekuensi Fast Mode (400kHz)
	machine.I2C0.Configure(machine.I2CConfig{
		Frequency: 400 * machine.KHz,
		SDA:       machine.GP4, // Raspberry Pico Default SDA
		SCL:       machine.GP5, // Raspberry Pico Default SCL
	})

	// Opsional tapi disarankan: Beri waktu bus listrik untuk stabil (VCC Pullups)
	time.Sleep(10 * time.Millisecond)

	// 2. Baca register
	// I2C sering membutuhkan transmisi 2 tahap:
	// Tulis alamat register yang mau dituju, TANPA stop bit, lalu BACA hasilnya.
	// TinyGo mengabstraksikan ini dalam `Tx` atau `WriteRegister`/`ReadRegister`
	
	outData := []byte{0} // penampung 1 byte jawaban
	
	// Tx: target_addr, write_bytes, read_buffer
	err := machine.I2C0.Tx(uint16(SensorAddress), []byte{WhoAmIRegister}, outData)
	if err != nil {
		// Sensor mati, kabel SDA putus, VCC drop, atau alamat salah
		return fmt.Errorf("I2C Bus Error / Sensor tak terdeteksi: %v", err)
	}

	println("Sensor ID (WhoAmI) berbunyi: ", outData[0])
	
	// Pastikan sesuai datasheet. MPU6050 = 0x68 (104 desimal)
	if outData[0] != 0x68 {
		return fmt.Errorf("Sensor terdeteksi, tapi ID silang (bukan MPU6050)")
	}

	return nil
}

// =========================================================

// Contoh Inisialisasi SPI untuk layar eksternal (LCD ST7789)
func InitSPIDisplay() {
	machine.SPI0.Configure(machine.SPIConfig{
		Frequency: 40000000, // 40 MHz! (Sangat cepat)
		SCK:       machine.GP18,
		SDO:       machine.GP19, // MOSI
		SDI:       machine.GP16, // MISO (Sering LCD tidak kirim data balik)
	})

	// SPI WAJIB mengontrol pin Chip Select (CS) secara manual via Digital GPIO!
	csPin := machine.GP17
	csPin.Configure(machine.PinConfig{Mode: machine.PinOutput})
	
	// SPI CS bersifat Aktif Rendah (Active Low). 
	// Default saat menganggur harus High (Tinggi).
	csPin.High() 
	
	// -- Operasi Transmisi SPI (Asumsi layar) --
	csPin.Low() // 1. Tarik CS ke Low (Aktifkan Chip Layar)
	
	// 2. Kirim puluhan Kilobyte data frame buffer layar lewat SPI
	// machine.SPI0.Tx(...) 
	
	csPin.High() // 3. Lepaskan CS (Tinggi kembali)
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Timeout & Error Return dari I2C.Tx
Menulis kode baca sensor terus menerus di loop tanpa mengecek `err`.

```go
// BAD: Blind reading tanpa peduli koneksi putus
for {
    machine.I2C0.Tx(0x3C, []byte{0x00}, buf)
    suhu := buf[0] // Jika kabel lepas, buf berisi sampah atau 0!
    time.Sleep(time.Second)
}
```
**Why dangerous:** I2C adalah bus yang sangat rapuh secara kelistrikan. Jika ada motor atau relay nyala di dekat sensor, lonjakan elektromagnetik (*EMI*) dapat mengunci (*lock-up*) bus I2C hardware. Jika `Tx` menghasilkan error (karena gagal menerima bit *ACK* / *Acknowledge* dari sensor), isi dari `buf` tidak valid. Jika data ini diteruskan untuk menyalakan pemanas air atau logika keselamatan, sistem bisa rusak fatal. **Good Pattern**: Jika `Tx` menghasilkan error berturut-turut, sistem harus merestart bus I2C (`Configure` ulang) atau memicu alarm (*Failsafe Mode*).

### ❌ Anti-Pattern 2: Tidak Mengontrol Pin CS (Chip Select) pada SPI
Menancapkan pin CS layar langsung ke GND (Bumi) di PCB agar "selalu aktif", lalu di software tidak mendeklarasikan kode CS sama sekali.

```go
// BAD: Hardware mem-bypass CS ke Ground. Software lepas tangan.
machine.SPI0.Configure(...)
machine.SPI0.Transfer(0xFF)
```
**Why dangerous:** Pada protokol SPI murni, perangkat *Slave* (Layar/SD Card) sering mengandalkan transisi jatuh (High ke Low) dari sinyal pin CS untuk me-reset statemachine bit-nya. Jika CS dikunci permanen di GND, satu saja *glitch* listrik (kehilangan 1 bit clock dari 8 bit), slave akan bergeser 1 bit (*out of sync*) selamanya sampai mikrokontroler dimatikan. Data yang terkirim akan menjadi sampah acak. Pengontrolan CS lewat GPIO `csPin.Low()` sebelum transfer dan `csPin.High()` sesudah transfer adalah **HUKUM WAJIB SPI**.

### ❌ Anti-Pattern 3: Blokade Transmisi Masif SPI Tanpa Yield (DMA Omission)
Mendorong layar TFT dengan frame rate 30 FPS penuh secara manual menggunakan byte loop array.

```go
// BAD: Loop byte-per-byte CPU memblokir seluruh RTOS Goroutines.
for i := 0; i < 320*240*2; i++ {
    machine.SPI0.Transfer(framebuffer[i])
}
```
**Why dangerous:** Mengirim `153.600 bytes` lewat transfer memblokir berarti CPU menunggu bit demi bit merambat di kabel tembaga. Proses ini bisa memakan 30 milidetik lebih. Selama itu, tidak ada satu pun goroutine lain (Sensor, Network/WiFi) yang jalan. Ini sangat mencekik core MCU. Di produksi canggih, pengembang menggunakan transfer Blok (`Tx(buffer, nil)`) agar TinyGo di belakang layar bisa menggunakan *Hardware DMA (Direct Memory Access)* jika didukung, atau memecahnya jadi potongan kecil berselingan dengan scheduler `runtime.Gosched()`.

## Edge Cases

1. **I2C Bus Lockup (The 9-Clock Fix):** Terkadang, jika mikrokontroler direset (ditekan tombol RST) tepat di pertengahan sensor I2C sedang memuntahkan bit ke kabel SDA (dan menariknya LOW), sensor belum tereset. Saat MCU menyala lagi, MCU melihat SDA terkunci LOW dan menolak I2C Inisialisasi selamanya. *Solusi*: Trik standar industri adalah *Software Bit-Banging*: Ubah pin SCL ke manual GPIO digital, ubah LOW/HIGH bergantian sebanyak 9 siklus agar mesin *State* sensor selesai mengeluarkan bit-nya dan membebaskan jalur SDA, lalu baru panggil I2C `Configure()`.
2. **Kabel I2C Terlalu Panjang:** Protokol I2C tidak didesain untuk jarak jauh (maksimal 20-30 sentimeter di atas meja/PCB). Jika Anda menyambungkan sensor sejauh 5 meter dengan kabel utp biasa, resistansi dan kapasitansi kabel akan menghancurkan gelombang kotak clock menjadi landai. Anda akan terus dapat error I2C `Tx`. *Workaround*: Turunkan frekuensi menjadi sangat rendah (contoh: 10 KHz) di config `machine.I2CConfig{Frequency: 10 * machine.KHz}`, dan gunakan Resistor Pull-up yang lebih kuat (2.2k Ohm).
3. **SPI Mode Clock Phase/Polarity Mismatch (Mode 0-3):** Protokol SPI tidak standar. Beberapa sensor membaca bit (sampling) pada saat listrik Clock menanjak (*Rising edge*), beberapa membaca saat menurun (*Falling edge*). Ini disebut CPOL dan CPHA (Menghasilkan Mode 0, 1, 2, 3). TinyGo `machine.SPIConfig` secara default menggunakan Mode 0. Jika Anda menancapkan Sensor yang membutuhkan Mode 3, bacaan Anda akan meleset 1 bit atau gagal. Periksa datasheet secara teliti dan atur argumen `Mode` di struct.

## Unit Test Meaningful

Karena protokol I2C murni perangkat keras register CPU, TinyGo mengijinkan pembuatan I2C Tiruan (*Mock/Software I2C*) jika dibangun dalam tag build desktop/Linux. Di sini kita memodelkan test untuk men-tes parsial driver identifikasi sensor tanpa menyentuh register MCU secara nyata.

```go
package peripheral_test

import (
	"errors"
	"testing"
)

// Interfacing I2C Bus BusMock
type MockI2C struct {
	SimulatedWhoAmI byte
	ShouldReturnErr bool
}

func (m *MockI2C) Tx(addr uint16, w, r []byte) error {
	if m.ShouldReturnErr {
		return errors.New("i2c bus arbitration lost / not acknowledged")
	}

	// Jika ini query menanyakan WhoAmI
	if len(w) > 0 && w[0] == 0x75 {
		if len(r) > 0 {
			r[0] = m.SimulatedWhoAmI
		}
	}
	return nil
}

// Identifikasi logic dibungkus ulang dengan interface (Dependency Injection)
func DetectSensor(bus interface{ Tx(uint16, []byte, []byte) error }) error {
	out := []byte{0}
	err := bus.Tx(0x68, []byte{0x75}, out)
	if err != nil {
		return err
	}
	if out[0] != 0x68 { // MPU6050 identifier
		return errors.New("sensor wrong id")
	}
	return nil
}

func TestSensorDetectionAndErrorHandling(t *testing.T) {
	// Kasus 1: Kabel Terputus / Modul Rusak
	brokenBus := &MockI2C{ShouldReturnErr: true}
	err := DetectSensor(brokenBus)
	if err == nil {
		t.Fatalf("Expected I2C connection error for broken bus, but got nil")
	}

	// Kasus 2: Koneksi Baik, Tapi Sensor Lain yang terpasang (Misal BMP280, ID beda)
	wrongSensorBus := &MockI2C{SimulatedWhoAmI: 0x58, ShouldReturnErr: false}
	err = DetectSensor(wrongSensorBus)
	if err == nil {
		t.Fatalf("Expected Wrong ID error, got nil")
	}

	// Kasus 3: Skenario Sukses / Production Valid
	validBus := &MockI2C{SimulatedWhoAmI: 0x68, ShouldReturnErr: false}
	err = DetectSensor(validBus)
	if err != nil {
		t.Fatalf("Expected successful initialization, got error: %v", err)
	}
}
```

## Kapan JANGAN Pakai Ini

- **Tanpa timeout pada operasi bus.** Perangkat yang tidak merespons akan menggantung bus selamanya, dan seluruh firmware ikut berhenti tanpa jejak apa pun.
- **Mengabaikan pull-up pada I2C.** Bus I2C membutuhkan resistor pull-up. Tanpa nilai yang benar, komunikasi bekerja pada kecepatan rendah dan gagal secara acak pada kecepatan lebih tinggi — gejala yang terlihat seperti bug perangkat lunak.
- **Berbagi bus tanpa penguncian.** Dua goroutine yang mengakses bus yang sama bersamaan menghasilkan transaksi tercampur dan data yang salah tanpa satu pun galat.
- **Mengasumsikan penulisan berhasil tanpa memeriksa ACK.** I2C memberi sinyal ACK/NACK. Kode yang mengabaikannya akan melanjutkan seolah semuanya baik padahal perangkat tidak menerima apa pun.
- **Kecepatan bus tinggi pada kabel panjang.** Kapasitansi kabel membatasi kecepatan yang bisa diandalkan. Ini persoalan fisika, dan tidak ada perubahan kode yang menyelesaikannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Firmware membeku total | timeout pada operasi bus | Perangkat menahan bus |
| Gagal acak pada kecepatan tinggi | pull-up dan panjang kabel | Batas fisik bus |
| Data sensor tercampur | penguncian akses bus | Dua penggunaan bersamaan |
| Nilai sensor tidak masuk akal | pemeriksaan ACK | Kegagalan tidak terdeteksi |
| Bekerja di meja, gagal di lapangan | panjang kabel dan gangguan | Kondisi fisik berbeda |

```bash
# Pindai alamat yang benar-benar menjawab di bus (pada Linux SBC)
i2cdetect -y 1

# Perangkat yang tidak menjawab akan terlihat sebagai NACK, bukan sebagai data salah
i2cget -y 1 0x48 0x00

# Catat setiap kegagalan bus sebagai penghitung, bukan hanya log
tinygo monitor -target=pico | grep -iE 'i2c|spi|timeout|nack'
```
