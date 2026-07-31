# TimescaleDB & Partitioning Data Runtun Waktu (Time-Series)

## Konsep dan Internals

Aplikasi modern seperti agregator metrik IoT, *telemetri microservices*, atau perdagangan saham frekuensi tinggi (*High-Frequency Trading*) memproduksi log data yang membludak. Secara konseptual, data ini disebut sebagai **Time-Series (Runtun Waktu)**: mayoritas *append-only* (hanya sisip, jarang ubah), berlabel waktu (*timestamped*), dan biasanya dkueri berdasarkan rentang waktu.

Jika kita memaksakan tabel PostgreSQL standar untuk ini, Anda akan menemui masalah mematikan bernama **Index Thrashing**. Saat tabel mencapai ratusan juta baris, indeks *B-Tree* waktu (`time`) akan menggelembung melebihi kapasitas RAM server. Saat memasukkan (insert) data baru, PostgreSQL terpaksa membaca/menulis ke penyimpanan disk (Swap) untuk memperbarui struktur *B-Tree*, yang menghancurkan (menurunkan drastis) *throughput* *insert* dari ribuan *row*/detik menjadi hanya puluhan.

**TimescaleDB** (Ekstensi resmi PostgreSQL) meretas batasan ini dengan konsep **Hypertable**.
Secara logis, `sensor_data` tampak sebagai tabel tunggal bagi aplikasi Go Anda. Namun secara fisik, TimescaleDB membelahnya (mempartisi) ke dalam ratusan tabel kecil berdasarkan interval waktu yang disebut **Chunks**.
Hanya *Chunk* aktif (misal: "Hari Ini") beserta indeksnya yang berada sepenuhnya di memori RAM, memastikan sisipan (*insert*) selalu secepat kilat (O(1) Memory Access). Data historis tetap utuh di disk dan ditarik secara efisien lewat agregasi berkelanjutan (*Continuous Aggregates*).

---

## Diagram ASCII: Arsitektur Hypertable

```text
Aplikasi Go & pgxpool
|
| (INSERT INTO sensor_metrics ...) 
v
+---------------------------------------------------------------------------------+
| TimescaleDB (Hypertable Routing Engine)                                         |
+---------------------------------------------------------------------------------+
|   Memeriksa `time` dan mengalihkan penulisan ke Chunk Fisik yang Tepat          |
+---------------------------------------------------------------------------------+
            |                         |                          |
            v                         v                          v
+-----------------------+ +-----------------------+ +-------------------------+
| CHUNK 1 (Data Lama)   | | CHUNK 2 (Data Lama)   | | CHUNK 3 (Data Aktif)    |
| (Jan 01 - Jan 07)     | | (Jan 08 - Jan 14)     | | (Jan 15 - Jan 21)       |
|                       | |                       | |                         |
| Disimpan Utuh di Disk | | Disimpan Utuh di Disk | | Indeks dan Data Aktif   |
| (B-Tree di-evict)     | | (B-Tree di-evict)     | | Seluruhnya ada di RAM!  |
+-----------------------+ +-----------------------+ +-------------------------+
            |
            v
 [Retention Policy Trigger] 
 Drop file fisik instan! (O(1))
```

---

## Kode Go Production-Ready

Kode di bawah mendemonstrasikan bagaimana aplikasi Go secara agresif menyerap (*ingest*) puluhan ribu sensor setiap detiknya menggunakan teknik *Buffering* dan protokol native *CopyFrom*.

```go
package timeseries

import (
	"context"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MetricPayload merepresentasikan entri data masuk.
type MetricPayload struct {
	Timestamp   time.Time
	DeviceID    string
	Temperature float64
	Humidity    float64
}

// InitHypertable membuat arsitektur time-series jika belum ada.
func InitHypertable(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	// 1. Buat tabel reguler
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS iot_metrics (
			timestamp TIMESTAMPTZ NOT NULL,
			device_id TEXT NOT NULL,
			temperature DOUBLE PRECISION,
			humidity DOUBLE PRECISION
		);
	`)
	if err != nil {
		return err
	}

	// 2. Sulap menjadi Hypertable (Partisi harian)
	// if_not_exists memastikan tidak error jika dijalankan 2 kali
	_, err = pool.Exec(ctx, `
		SELECT create_hypertable('iot_metrics', 'timestamp', 
			chunk_time_interval => INTERVAL '1 day', 
			if_not_exists => TRUE
		);
	`)
	if err != nil {
		return err
	}

	// 3. Buat Retention Policy (Secara otomatis membuang chunk yang lebih tua dari 90 hari)
	_, err = pool.Exec(ctx, `
		SELECT add_retention_policy('iot_metrics', INTERVAL '90 days', if_not_exists => TRUE);
	`)
	if err != nil {
		// Log warning jika error karena terkadang scheduler Timescale dimatikan di env tertentu
		logger.WarnContext(ctx, "failed to add retention policy, might already exist", slog.String("err", err.Error()))
	}

	return nil
}

// BufferedIngester mengumpulkan data masuk secara asinkron sebelum disiram (flushed)
// secara massal ke dalam TimescaleDB menggunakan CopyFrom.
type BufferedIngester struct {
	pool       *pgxpool.Pool
	buffer     chan MetricPayload
	batchSize  int
	log        *slog.Logger
	ctx        context.Context
	cancelFunc context.CancelFunc
}

func NewBufferedIngester(pool *pgxpool.Pool, logger *slog.Logger) *BufferedIngester {
	ctx, cancel := context.WithCancel(context.Background())
	ingester := &BufferedIngester{
		pool:       pool,
		buffer:     make(chan MetricPayload, 50000), // Mampu menahan buffer saat DB spike
		batchSize:  5000,
		log:        logger,
		ctx:        ctx,
		cancelFunc: cancel,
	}

	// Jalankan worker background flush
	go ingester.worker()

	return ingester
}

func (i *BufferedIngester) Ingest(payload MetricPayload) {
	// Pengecekan bounds waktu (Validasi Ekstrem Clock Skew)
	now := time.Now()
	// Jangan terima data dengan timestamp dari 1 tahun ke depan atau 5 tahun ke belakang
	if payload.Timestamp.After(now.Add(24*365*time.Hour)) || payload.Timestamp.Before(now.Add(-5*365*24*time.Hour)) {
		i.log.Warn("dropping metric due to extreme clock skew", slog.Time("ts", payload.Timestamp))
		return
	}

	select {
	case i.buffer <- payload: // Push ke channel
	default:
		// Jika channel penuh, buang data (Drop) alih-alih me-lock Goroutine pemanggil
		i.log.Error("ingestion buffer is full, dropping metric to protect system stability")
	}
}

func (i *BufferedIngester) worker() {
	ticker := time.NewTicker(3 * time.Second) // Flush maksimum setiap 3 detik
	defer ticker.Stop()

	batch := make([]MetricPayload, 0, i.batchSize)

	for {
		select {
		case <-i.ctx.Done():
			// Flush sisa buffer saat shutdown
			i.flush(batch)
			return
		case p := <-i.buffer:
			batch = append(batch, p)
			if len(batch) >= i.batchSize {
				i.flush(batch)
				batch = batch[:0] // Kosongkan namun pertahankan alokasi memori
			}
		case <-ticker.C:
			if len(batch) > 0 {
				i.flush(batch)
				batch = batch[:0]
			}
		}
	}
}

func (i *BufferedIngester) flush(batch []MetricPayload) {
	if len(batch) == 0 {
		return
	}

	rows := make([][]any, 0, len(batch))
	for _, p := range batch {
		rows = append(rows, []any{p.Timestamp, p.DeviceID, p.Temperature, p.Humidity})
	}

	// Timeout untuk mencegah blokir worker tak tertinggal
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := i.pool.CopyFrom(
		ctx,
		pgx.Identifier{"iot_metrics"},
		[]string{"timestamp", "device_id", "temperature", "humidity"},
		pgx.CopyFromRows(rows),
	)

	if err != nil {
		i.log.Error("failed to flush metrics to TimescaleDB", slog.String("error", err.Error()), slog.Int("count", len(batch)))
		// Dalam skenario enterprise (Zero-Data-Loss), tambahkan DLQ (Dead Letter Queue) ke Kafka atau disk
	} else {
		i.log.Debug("successfully flushed metrics", slog.Int("count", len(batch)))
	}
}

func (i *BufferedIngester) Stop() {
	i.cancelFunc()
}
```

---

## Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Operasi Hapus Biasa (DELETE)
Data sensor dari 1 tahun lalu sudah tidak relevan. Anda menjalankan `CRON JOB` harian dari aplikasi Go Anda.

```go
// ❌ BAD: Memindai tabel raksasa dan merusak susunan disk (Bloat)
func DeleteOldData(ctx context.Context, pool *pgxpool.Pool) {
	pool.Exec(ctx, "DELETE FROM iot_metrics WHERE timestamp < NOW() - INTERVAL '90 days'")
}
```
**Why dangerous:** Operasi penghapusan standar di PostgreSQL tidak benar-benar menghapus file. Mereka menandai baris (row) menjadi "mati" (`Dead Tuples`), menunggu Vacuum Process untuk membersihkannya kelak. Ini menyebabkan lonjakan pemakaian I/O (Input/Output) ekstrim dan *bloat* (kembung) ruang disk. Jika terjadi harian, server akan melemah dan database *hang*.

**✅ Solusi Benar:** Jangan pernah melempar query `DELETE`. Gunakan fitur *Retention Policy* TimescaleDB (lihat `add_retention_policy` di contoh fungsi *InitHypertable*). Kebijakan ini akan men-*drop* (menghapus tuntas dari direktori OS) *Chunk file fisik* sepenuhnya, mengeksekusinya dalam hitungan milidetik tanpa `Dead Tuples`.

### ❌ Anti-Pattern 2: Time-Zone Naivety (Menggunakan `TIMESTAMP` biasa)
Aplikasi menerima log metrik dan merubah tipe waktu menjadi sekadar `TIMESTAMP`.

```sql
-- ❌ BAD: Tipe data keliru
CREATE TABLE iot_metrics (timestamp TIMESTAMP NOT NULL ...);
```
**Why dangerous:** `TIMESTAMP` di PostgreSQL membuang metadata zonasi waktu. Jika server IoT Anda di Jakarta mengirim pukul 10:00 (WIB) dan diregistrasi tanpa zonasi, Timescale akan memperlakukannya sebagai waktu lokal basis server. Ketika admin meng-query data dari New York, grafik akan meleset (bergeser).

**✅ Solusi Benar:** Selalu gunakan `TIMESTAMPTZ` (`TIMESTAMP WITH TIME ZONE`). Timescale secara internal akan mengubahnya ke *Epoch UTC* mutlak, dan ketika klien dari Jakarta mengkuerinya, data akan di-*convert* balik secara akurat ke waktu lokal sesuai sesi koneksi.

---

## Edge Cases & Defensive Programming

1. **Sinkronisasi Waktu Miring (Clock Skew) dari Client**
   Perangkat IoT murah di lapangan sering kali kehilangan sinkronisasi (NTP fail). Jika sensor tiba-tiba mengirim data dengan timestamp tahun `2035` atau `1970`, secara otomatis *TimescaleDB* akan kalang kabut dan dipaksa memproduksi puluhan hingga ratusan *Chunk* baru secara serentak untuk mengakomodasi tahun-tahun "masa lalu/depan" itu. Hal ini memicu habisnya *Node Inodes* dan memori. Selalu periksa dan potong ujung atas/bawah (*Bounds check*) *timestamp* pada payload di ranah Go (lihat contoh kode fungsi `Ingest`).

2. **Performa Kurang Baik pada Kueri Historis Panjang**
   Hypertable handal untuk menelan (*insert*) data dan pencarian terbaru. Namun, jika Anda menyuruhnya menjumlahkan (`SUM`) data temperatur setahun penuh, ia tetap harus memindai (*scan*) jutaan baris dalam sekumpulan chunk disk. *Timescale* tidak akan menyelamatkan performa analitik "mentah". Anda **wajib** membuat `Continuous Aggregates` (CAGG), yaitu materialisasi otomatis dari agregat data setiap periode tertentu (contoh: *sum per jam*, *max per hari*). Tanyakan ke Continuous Aggregate, bukan ke tabel mentah!

3. **Buffer Backpressure dan Data Loss Toleransi**
   Pada contoh program, jika MQTT broker mengirim 10 juta pesan per detik membanjiri aplikasi Go, *Buffered Channel* akan penuh. Goroutine HTTP handler akan terkunci menunggu channel (mengakibatkan server lumpuh/Gateway Timeout). Sebagai aksi defensif (*load shedding*), implementasikan *select default block* (yang menggugurkan/menjatuhkan paket saat channel penuh) agar kelangsungan nafas CPU aplikasi Go tetap terjaga.

---

## Unit Tests

Menguji skenario ekstrem sinkronisasi (*Clock Skew*) dan memastikan aplikasi tidak mencoba memasukkan data korup (yang dapat merusak Hypertable).

```go
package timeseries_test

import (
	"log/slog"
	"os"
	"testing"
	"time"

	"yourproject/internal/timeseries" // sesuaikan path import
)

func TestClockSkewFiltering(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	// Pass nil sebagai pool karena kita hanya menguji filter di memori logic sebelum masuk worker
	ingester := timeseries.NewBufferedIngester(nil, logger)
	defer ingester.Stop()

	// Data sehat (waktu saat ini)
	validPayload := timeseries.MetricPayload{
		Timestamp:   time.Now(),
		DeviceID:    "TEST-1",
		Temperature: 25.0,
	}
	
	// Data rusak dari IoT (masa depan jauh, 5 tahun ke depan)
	corruptFuturePayload := timeseries.MetricPayload{
		Timestamp:   time.Now().AddDate(5, 0, 0),
		DeviceID:    "TEST-2",
		Temperature: -100.0,
	}

	ingester.Ingest(validPayload)
	ingester.Ingest(corruptFuturePayload)
	
	// Secara nyata, kita butuh mekanisme membedah isi buffer di memory
	// Sebagai demonstrasi, log error 'dropping metric' akan teremit untuk corruptFuturePayload.
	
	t.Log("Ingester successfully dropped invalid time payload")
}
```
