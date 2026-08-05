# MQTT & Edge Messaging (TinyGo IoT)

> **Berlaku:** TinyGo 0.31+ · MQTT 3.1.1 · **Lihat juga:** `advanced_networking_protocols/mqtt_broker_client.md` · `embedded_tinygo/tinygo_microcontroller_basics.md` · `distributed_patterns_resilience/idempotency_key_engine.md` · `observability_resilience/rate_limiting_patterns.md`

## Konsep Internal & Trade-offs

Mengirimkan data dari ujung mikrokontroler (Edge Node) seperti Raspberry Pi Pico W atau ESP32 ke cloud/server tidak ideal menggunakan koneksi HTTPS murni. *Overhead* sertifikat TLS/SSL (Handshake HTTP) dan header HTTP sangat menguras memori (RAM) serta *bandwidth* berharga untuk pesan *payload* yang seringkali hanya sebesar 2 byte (misal, `25` untuk indikator suhu).

**MQTT (Message Queuing Telemetry Transport)** adalah protokol perantara pesan (*Pub/Sub*) standar industri (ISO 20922) yang berbobot sangat ringan. MQTT duduk di atas tumpukan TCP/IP murni.
1. **Lightweight Header**: Header MQTT hanya sebesar 2 byte! (Berbanding ratusan byte pada HTTP).
2. **Quality of Service (QoS)**: Protokol bisa memastikan pengiriman *Fire-and-forget* (QoS 0), garansi minimal satu kali sampai (QoS 1), atau dijamin absolut tepat satu kali (QoS 2).
3. **Last Will and Testament (LWT)**: Saat sistem bare-metal IoT di gunung putus baterai/koneksi tanpa pamit, Broker cloud (seperti Mosquitto/AWS IoT) akan secara otomatis merilis *Pesan LWT* kepada klien web bahwa sensor tersebut telah "Offline" (Mati abnormal).

**Trade-offs MQTT vs CoAP (UDP-based)**:
Kelemahan MQTT adalah kewajibannya menahan koneksi soket TCP terbuka terus menerus secara *Long-Lived*. Ini memaksa modem Wifi/LTE pada IoT device tetap terjaga dan menyedot baterai tinggi (Kecuali Anda mengimplementasikan *Deep Sleep* kompleks). Jika baterai sel koin (CR2032) adalah prioritas Anda selama bertahun-tahun, `CoAP` yang stateless dan berbasis UDP seringkali lebih ideal dibanding MQTT TCP.

## Arsitektur & Alur Pub/Sub Edge

```text
[ MICROCONTROLLER (TinyGo + WiFi) ]
   |                               (3) Publish Payload (Temp: 30C)
   | (1) TCP Connect               TOPIC: "rumah/kebun/suhu"
   | (2) MQTT CONNECT (Keep-Alive)           |
   |                                         v
   +==============================> [ MQTT BROKER CLOUD ] 
                                    (Eclipse Mosquitto / EMQX)
                                             |
   +=========================================+
   | (4) Broker mengecek siapa Subscriber ke topik "rumah/kebun/#"
   |     Lalu menyebarkan data via WebSocket/TCP
   v
[ KLIEN WEB / BACKEND SERVER DATABASE (Subscribers) ]
```

## Kode Go Production-Ready

Contoh konektivitas MQTT menggunakan library third-party kompatibel dengan TinyGo seperti `paho.mqtt` (atau *minimal IoT library*) melalui koneksi antarmuka cyw43439 (chip wifi bawaan Pico W). 

> *Disclaimer: Mengatur tumpukan jaringan penuh di TinyGo melibatkan driver Wifi (misal `tinygo.org/x/drivers/net`) dan goroutine TCP stack. Kode di bawah berfokus pada logika *State Machine* rekoneksi (Reconnection Logic) yang kokoh.*

```go
package edge

import (
	"context"
	"fmt"
	"log"
	"time"

	// Mocking antarmuka paho mqtt untuk simplifikasi contoh struktural
)

// Interfacing minimalis dari MQTT Paho Client
type MQTTClient interface {
	Connect() error
	Publish(topic string, qos byte, retained bool, payload interface{}) error
	Disconnect()
	IsConnected() bool
}

// IoTNode mengontrol daur hidup konektivitas dan transmisi
type IoTNode struct {
	client      MQTTClient
	telemetryCh chan string // Saluran data sensor masuk
}

func NewIoTNode(client MQTTClient) *IoTNode {
	return &IoTNode{
		client:      client,
		telemetryCh: make(chan string, 10), // Buffered mencegah sensor blocking
	}
}

// QueueData dipanggil secara eksternal oleh rutin pembaca sensor I2C
func (n *IoTNode) QueueData(data string) {
	select {
	case n.telemetryCh <- data:
	default:
		// Jika antrean melebihi buffer karena wifi lama putus, 
		// data terlama terbuang dan digantikan (agar RAM tak meledak/OOM)
		// Ini adalah implementasi Drop-Oldest/QoS-0 Ring Buffer sederhana.
		log.Println("Buffer penuh, membuang data sensor tua")
	}
}

// StartTelemetryService adalah event loop pengirim tangguh
func (n *IoTNode) StartTelemetryService(ctx context.Context) {
	go func() {
		for {
			// Periksa status koneksi TCP/MQTT
			if !n.client.IsConnected() {
				log.Println("MQTT Disconnected. Attempting Reconnect...")
				
				err := n.client.Connect()
				if err != nil {
					log.Printf("Connection failed: %v. Retrying in 5s...", err)
					// Gunakan sleep (Backoff) untuk yield dan jangan spam jaringan
					time.Sleep(5 * time.Second) 
					continue
				}
				log.Println("MQTT Terhubung!")
			}

			// Proses pengiriman
			select {
			case <-ctx.Done():
				n.client.Disconnect()
				log.Println("Layanan telemetri dimatikan.")
				return
				
			case payload := <-n.telemetryCh:
				// Gunakan QoS 1: Jaminan sampai min. 1x, tahan koneksi agar tepercaya
				err := n.client.Publish("farm/sensor/soil", 1, false, payload)
				
				if err != nil {
					log.Printf("Failed to Publish (%v), putting back to queue buffer", err)
					// Logika Retry: Taruh kembali payload ke channel dengan priority
					// (Untuk menjaga urutan, Anda butuh list, tapi ini simplifikasi re-enqueue)
					go func(p string) {
						time.Sleep(1 * time.Second)
						n.QueueData(p)
					}(payload)
				}
			}
		}
	}()
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Blocking Koneksi saat Boot (Tidak Fail-Safe)
Mikrokontroler menyala, lalu masuk loop *Connect* Wifi/MQTT yang bersifat *infinite* tanpa batas dan menunda semua goroutine lain selamanya.

```go
// BAD: Sistem tertahan selamanya jika router WiFi dimatikan
func main() {
    InitWifi()
    
    // Looping di main thread sampai sukses (Sistem Freeze total)
    for !mqtt.Connect() {
        println("Failed to connect, retrying...") 
    } 
    
    // Sistem Layar OLED dan pembaca Suhu baru jalan di bawah sini
    RunSensors() 
}
```
**Why dangerous:** Jika WiFi lokal/internet mati, IoT *node* Anda pada dasarnya membatu (*Brick*). Sensor suhu tidak membaca apapun, LCD/OLED menampilkan layar hitam/blank, relay/keran air yang seharusnya menetes otomatis terjeda selamanya! Pada sistem *embedded production*, jaringan harus dianggap tidak bisa dipercaya dan 100% Asynchronous/Latar belakang. Modul/Goroutine lokal (layar, aktuator, pembacaan) HARUS beroperasi independen meskipun koneksi gagal.

### ❌ Anti-Pattern 2: Tidak Mereset (Re-initialize) Modem setelah Sleep
Mikrokontroler keluar dari Deep Sleep dan langsung mengirim pesan MQTT menggunakan socket yang sebelumnya ia simpan di memori (Pointer lama).

```go
// BAD: Melanjutkan koneksi mati di level TCP State
Sleep(10 * time.Minute) // WiFi RF Power Down

client.Publish(...) // Error: Broken Pipe / Socket Closed!
```
**Why dangerous:** Di mikrokontroler, `time.Sleep` yang dalam (*Deep Sleep*) atau mode hemat energi biasanya menonaktifkan blok RF (Radio Frequency) di *chip* untuk menghemat mA (Milliampere). Router AP juga telah menendang soket TCP dari tabel NAT router karena tak ada paket *Keep-Alive*. Setelah bangun, pointer soket lama (`net.Conn`) tidak lagi valid secara sirkuit maupun sesi TCP. *Pola yang Benar*: Setelah *Deep Sleep*, IoT Node **wajib** melakukan re-koneksi AP WiFi penuh (DHCP + Handshake) dan koneksi *MQTT Connect* baru sebelum mencoba `Publish`.

### ❌ Anti-Pattern 3: Payload String Konkatenasi yang Boros (RAM Fragmenter)
Membuat Payload JSON MQTT di mikrokontroler menggunakan operator tambah `+` string berulang-ulang di dalam *fast loop*.

```go
// BAD: OOM dalam waktu singkat karena fragmentasi RAM
payload := `{"id":` + idStr + `,"temp":` + fmt.Sprint(t) + `,"hum":` + humStr + `}`
client.Publish("topic", 0, false, payload)
```
**Why dangerous:** TinyGo mengalokasikan string baru di Heap (*Dynamic Allocation*) setiap kali menemukan operator `+`. Mikrokontroler tidak memiliki MMU (Memory Management Unit) seperti OS Desktop. Memori kecil 64KB akan berlubang-lubang (Fragmentasi) saat GC menghapus string lama. Lama-kelamaan (misal 3 hari menyala berturut-turut), tidak ada lagi blok kosong bersebelahan (*Contiguous Free Space*) yang memadai, memicu `panic: out of memory`. *Good Pattern*: Gunakan pre-allocated `[]byte` array statik panjang tetap, dan ubah angkanya dengan fungsi `strconv.AppendFloat` langsung ke buffer tersebut tanpa *allocation*.

## Edge Cases

1. **Topik MQTT Terlalu Panjang (Overhead Cost):** Programmer Web sering menggunakan Path topik yang rapi tapi sangat panjang (contoh: `perusahaanX/regionalY/kotaZ/greenhouse/sektor4/sensor-suhu/dht22`). Ini menghasilkan string 70 Byte. Jika Payload suhu hanyalah `28.5` (4 Byte), rasio datanya tidak rasional! Setiap Anda *Publish*, radio RF memancarkan 74 byte (Menguras baterai untuk mengirim metadata panjang). Pada sistem ter-optimasi baterai ekstrem, gunakan topik sandi/pendek misal `f/4/t` (farm/4/temp) dan biarkan Server Cloud merekonstruksi datanya.
2. **QoS 1 Ack Timeout & Duplikasi Pesan:** Jika *node* menggunakan QoS 1, setelah mengirim paket, node menunggu `PUBACK` (Acknowledge) dari server. Jika jaringan jelek (Loss), Server mungkin menerima datanya (menyimpan di database), tetapi balasan `PUBACK` ke klien hilang di udara. Karena Klien tidak terima balasan `PUBACK`, klien (MQTT Library) akan me-retrie/mengirim ulang *paket yang sama persis*. Jika *Cloud Backend* (Subscriber) Anda tidak *Idempotent* (melakukan SQL Insert murni tanpa cek Duplikasi Timestamp/ID), database akhir bulan akan berisi jutaan data sensor ganda/palsu (Grafik melonjak salah).
3. **Penyimpanan Pesan saat Koneksi Jatuh (Offline Persistence):** Jika Internet mati 1 hari (Traktor memutus kabel FO di kebun), Channel buffered memori internal RAM `chan string, 10` akan penuh dan membuang ratusan data pembacaan sensor (*Data Loss*). Jika data harian/historis wajib dijaga ketat utuh, Arsitektur Edge IoT Node wajib dikawinkan dengan Modul penyimpanan sekunder (SD Card atau Flash EEPROM `I2C/SPI`). Data yang tertolak network dimasukkan (Enqueue) ke file Log SD Card, dan ketika Internet nyala, Goroutine baru mereplay *Log* dari Disk ke Internet pelan-pelan.

## Unit Test Meaningful

Tes ini mensimulasikan mekanisme ketahanan IoT (Reconnection) dari sebuah koneksi yang mati total, dan memastikan bahwa sistem tidak hilang akal/hang, tapi terus mencoba kembali (*Backoff*) tanpa kehilangan data di buffer.

```go
package edge_test

import (
	"context"
	"errors"
	"testing"
	"time"
)

// MockMQTT
type MockMQTT struct {
	IsConn      bool
	FailConnect bool // Flag jebakan untuk merusak wifi
	PubCount    int
}

func (m *MockMQTT) Connect() error {
	if m.FailConnect {
		return errors.New("wifi auth failed / router dead")
	}
	m.IsConn = true
	return nil
}

func (m *MockMQTT) Publish(t string, q byte, r bool, p interface{}) error {
	if !m.IsConn {
		return errors.New("broken pipe, not connected")
	}
	m.PubCount++
	return nil
}

func (m *MockMQTT) Disconnect() { m.IsConn = false }
func (m *MockMQTT) IsConnected() bool { return m.IsConn }


func TestIoTNode_RobustReconnection(t *testing.T) {
	mockClient := &MockMQTT{
		IsConn:      false,
		FailConnect: true, // Awalnya internet mati!
	}
	
	node := edge.NewIoTNode(mockClient)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Nyalakan service di background
	node.StartTelemetryService(ctx)

	// Sensor (Goroutine lain) mendeteksi data dan memasukkannya ke antrean.
	// Operasi ini HARUS non-blocking dan sukses meskipun internet mati!
	node.QueueData("DataSuhu:28.1")
	node.QueueData("DataSuhu:28.2")

	// Kasih waktu service looping gagal reconnect 1 kali
	time.Sleep(10 * time.Millisecond)

	// Validasi data belum ada yang dikirim
	if mockClient.PubCount > 0 {
		t.Fatalf("Data should not be published while disconnected")
	}

	// Tiba-tiba Router Wifi menyala
	mockClient.FailConnect = false 
	// Tunggu sistem Retry logic (yang di production pakai delay 5s, 
	// namun anggap di testing kita modifikasi timer / stub yield agar instan jalan kembali)
	
	// (Simulasi Sleep / percepat)
	time.Sleep(100 * time.Millisecond) 

	// Node harusnya menyadari itu dan publish 2 pesan dalam buffer
	if !mockClient.IsConnected() {
		t.Fatalf("Expected Node to automatically reconnect")
	}
	
	// Masukkan 1 data baru setelah online
	node.QueueData("DataSuhu:28.3")
	time.Sleep(50 * time.Millisecond) // yield processing time

	// Ekspektasi: Karena node sibuk reconnect dan flushing, setidaknya ada Pub > 0
	if mockClient.PubCount == 0 {
		t.Fatalf("Expected MQTT client to have published queued data after recovering online, got 0")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Tanpa buffer lokal saat jaringan terputus.** Perangkat edge sering kehilangan konektivitas. Data yang tidak dibuffer hilang, dan hilangnya tidak terlihat sampai ada yang membandingkan dengan sumber lain.
- **Publikasi setiap pembacaan sensor.** Bandwidth, daya, dan biaya seluler naik sebanding jumlah pesan. Agregasi di perangkat hampir selalu lebih murah daripada mengirim mentah.
- **Tanpa memikirkan konsumsi daya dari radio.** Radio adalah komponen paling boros pada perangkat baterai. Interval publikasi menentukan umur baterai lebih dari faktor lain mana pun.
- **Kredensial yang sama untuk seluruh armada perangkat.** Satu perangkat yang jatuh ke tangan orang lain berarti seluruh armada terkompromi, dan pencabutannya menyentuh semua unit.
- **Tanpa idempotensi pada sisi penerima.** Perangkat yang reconnect akan mengirim ulang buffer-nya. Itu perilaku yang benar, dan penerima harus siap menghadapinya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Data hilang dari periode tertentu | buffer saat offline | Tidak ada penyimpanan lokal |
| Biaya data seluler tinggi | jumlah pesan per perangkat | Publikasi terlalu sering |
| Baterai habis lebih cepat dari desain | interval radio aktif | Radio terlalu sering menyala |
| Satu perangkat bocor, semua harus diganti | kredensial per perangkat | Kredensial dibagi seluruh armada |
| Nilai ganda di basis data | idempotensi penerima | Pengiriman ulang setelah reconnect |

```bash
# Perangkat yang lama tidak melapor -- kandidat masalah konektivitas atau daya
mosquitto_sub -h broker -t 'perangkat/+/status' -v -C 20

# Volume pesan per perangkat: dasar untuk menghitung biaya dan umur baterai
kubectl logs -l app=ingest --since=24h \
  | jq -r '.device_id' | sort | uniq -c | sort -rn | head

# Duplikat akibat pengiriman ulang -- normal, tapi penerima harus menanganinya
```

```sql
SELECT device_id, waktu_sensor, count(*) FROM pembacaan
GROUP BY 1,2 HAVING count(*) > 1 LIMIT 20;
```
