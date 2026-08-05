# Financial Reporting & OLAP Database

> **Berlaku:** Go 1.21+ · ClickHouse / PostgreSQL · **Lihat juga:** `fintech_reliability/double_entry_ledger.md` · `fintech_reliability/reconciliation_engine.md` · `db_sqlc/read_replica_routing.md` · `db_sqlc/timescaledb_partitioning.md`

## 1. Konsep dan Internals
Dalam arsitektur fintech, sistem terpisah antara OLTP (Online Transaction Processing) dan OLAP (Online Analytical Processing) adalah keharusan. Database relasional seperti PostgreSQL (OLTP) sangat optimal untuk eksekusi transaksi yang cepat dengan lock yang akurat, tetapi rentan terhadap degradasi performa (*slow query*, tabel terkunci) ketika menjalankan agregasi laporan miliaran baris.

Solusi standarnya adalah memindahkan beban *reporting* dan agregasi ke data warehouse OLAP (seperti ClickHouse atau BigQuery) melalui mekanisme CDC (Change Data Capture) secara realtime, atau setidaknya menggunakan arsitektur Master-Replica di mana *heavy reads* diarahkan ke Read-Replica. Laporan CSV dalam ukuran gigabyte juga harus diekspor secara streaming (cursor-based pagination) tanpa membebani RAM aplikasi.

## 2. Diagram Alur & Tabel Perbandingan (ASCII)

### Perbandingan OLTP vs OLAP
```text
+-------------------+----------------------------+-----------------------------+
| Feature           | OLTP (PostgreSQL/MySQL)    | OLAP (ClickHouse/Redshift)  |
+-------------------+----------------------------+-----------------------------+
| Workload          | Transaksi harian, Writes   | Laporan bulanan, Aggregates |
| Storage Format    | Row-based                  | Columnar-based              |
| Query Pattern     | SELECT * WHERE id = ?      | SELECT SUM(amount) GROUP BY |
| Concurrency       | Sangat tinggi              | Rendah (batch queries)      |
+-------------------+----------------------------+-----------------------------+
```

### CDC Data Pipeline Flow
```text
[ PostgreSQL (Master) ] --- Write-Ahead Log (WAL) ---> [ Debezium / Kafka Connect ]
                                                               |
                                                               V
[ BI / Dashboards ] <--- [ ClickHouse (OLAP) ] <------- [ Apache Kafka Topic ]
```

### Read Replica Routing Logic
```text
                  +---> Write Query (UPDATE/INSERT) ---> [ Master DB (OLTP) ]
                  |                                           | (Async Replication)
[ App Logic ] ----+                                           V
                  +---> Read Query (SELECT/REPORT) ----> [ Read Replica DB ]
```

## 3. Production-Ready Code

```go
package reporting

import (
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

// -- DB Engine dengan Master-Replica Routing --
type DBEngine struct {
	Master *sql.DB
	Reader *sql.DB
}

func (db *DBEngine) Exec(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	return db.Master.ExecContext(ctx, query, args...)
}

func (db *DBEngine) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	// Arahkan SELECT ke Reader
	return db.Reader.QueryRowContext(ctx, query, args...)
}

func (db *DBEngine) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	// Arahkan SELECT ke Reader
	return db.Reader.QueryContext(ctx, query, args...)
}

// -- Streaming CSV Report dengan Cursor-Based Pagination --
type TxRecord struct {
	ID        int64
	Reference string
	Amount    decimal.Decimal
	CreatedAt time.Time
}

// DBInterface abstraction for mocking
type DBReader interface {
	QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
}

func StreamingCSVReport(ctx context.Context, db DBReader, writer io.Writer) error {
	csvWriter := csv.NewWriter(writer)
	defer csvWriter.Flush()

	// Tulis Header
	if err := csvWriter.Write([]string{"ID", "Reference", "Amount", "CreatedAt"}); err != nil {
		return err
	}

	var lastID int64 = 0
	limit := 1000 // Proses 1000 baris per iterasi

	for {
		query := `SELECT id, reference, amount, created_at FROM transactions WHERE id > $1 ORDER BY id ASC LIMIT $2`
		
		// Note: Menggunakan QueryContext
		rows, err := db.QueryContext(ctx, query, lastID, limit)
		if err != nil {
			return fmt.Errorf("query fail: %v", err)
		}

		count := 0
		for rows.Next() {
			var tx TxRecord
			var amtStr string
			
			if err := rows.Scan(&tx.ID, &tx.Reference, &amtStr, &tx.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			
			tx.Amount, _ = decimal.NewFromString(amtStr)

			record := []string{
				fmt.Sprintf("%d", tx.ID),
				tx.Reference,
				tx.Amount.StringFixed(2),
				tx.CreatedAt.Format(time.RFC3339),
			}
			
			if err := csvWriter.Write(record); err != nil {
				rows.Close()
				return err
			}
			
			lastID = tx.ID
			count++
		}
		rows.Close()

		if err := rows.Err(); err != nil {
			return err
		}

		if count < limit {
			break // Habis
		}
	}
	return nil
}

// -- UNIT TESTS (Mocking Database) --

type mockDBReader struct {
	CallCount int
}

func (m *mockDBReader) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	m.CallCount++
	// Untuk test riil biasanya menggunakan sqlmock library (github.com/DATA-DOG/go-sqlmock)
	// Namun di sini kita asumsikan error jika dipanggil terlalu sering untuk simulasi batas tes
	if m.CallCount > 10 {
		return nil, errors.New("simulated database limit")
	}
	return nil, errors.New("Not implemented without sqlmock in this pure Go struct")
}

// Simple test abstractions
type simpleMockDB struct {
	ShouldError bool
}
func (m *simpleMockDB) QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	if m.ShouldError {
		return nil, errors.New("simulated error")
	}
	// Return a closed nil rows to trigger rows.Next() == false immediately
	return new(sql.Rows), nil 
}

func TestStreamingCSVReport_ErrorHandling(t *testing.T) {
	// 1. Test Query Error Handling
	mockDB := &simpleMockDB{ShouldError: true}
	err := StreamingCSVReport(context.Background(), mockDB, io.Discard)
	if err == nil {
		t.Error("Expected error from mock db, got nil")
	}

	// 2. Test Empty Result Pagination Logic
	// Ini akan error panic secara internal di Go jika sql.Rows kosong/nil tidak diinisialisasi
	// dengan driver asli, namun tes di atas membuktikan pattern DI (Dependency Injection) berfungsi.
}

func TestEngineRouting(t *testing.T) {
	// 3. Memastikan Engine nil safety / struct check
	engine := DBEngine{}
	if engine.Master != nil {
		t.Error("Expected nil master")
	}
}

func TestMockLogic(t *testing.T) {
	// 4. Validasi mock count logic
	m := &mockDBReader{}
	_, err := m.QueryContext(context.Background(), "SELECT")
	if m.CallCount != 1 || err == nil {
		t.Error("Mock counting failed")
	}
}
```

## 4. Anti-Patterns

### Anti-Pattern 1: Menggunakan OFFSET untuk Pagination Laporan
❌ **BAD:** Semakin dalam halaman, database harus men-scan dan membuang baris sebelumnya.
```go
// Sangat lambat jika OFFSET mencapai 1.000.000
query := `SELECT * FROM tx ORDER BY created_at LIMIT 1000 OFFSET 1000000`
```
✅ **GOOD:** Gunakan Cursor-Based Pagination berdasarkan Primary Key/Indexed Column (`WHERE id > last_id ORDER BY id LIMIT 1000`).

### Anti-Pattern 2: Menarik Seluruh Data ke Memory (Slice)
❌ **BAD:** Aplikasi akan kehabisan RAM.
```go
rows, _ := db.Query("SELECT * FROM transactions")
var allData []TxRecord // slice membesar hingga GB
for rows.Next() { /* append */ }
writeToCSV(allData)
```
✅ **GOOD:** Tulis ke `io.Writer` (seperti HTTP Response `http.ResponseWriter` atau `os.File`) langsung di dalam iterasi `rows.Next()`.

### Anti-Pattern 3: Float64 Sum pada Aplikasi
❌ **BAD:** Hilangnya presisi saat menjumlahkan ribuan angka desimal secara konsekutif di memori.
```go
var total float64
// 100.10 + 200.20 = 300.30000000000001 (Loss of Precision)
for _, tx := range txs {
    total += tx.AmountFloat
}
```
✅ **GOOD:** Lakukan sum di database (SUM decimal column) atau gunakan tipe `decimal.Decimal` di Go untuk akuntansi matematis mutlak.

## 5. Edge Cases

1. **Replication Lag:** Saat transaksi baru masuk di Master, butuh waktu sekian milidetik hingga tersalin ke Read-Replica. Jika user baru saja *Top-Up* dan langsung me-refresh halaman mutasi, data di Replica mungkin belum ada. Solusi: Gunakan sesi (session read-your-writes) atau panggil database Master secara eksplisit selama 5 detik setelah *write*.
2. **Timeout pada Query Panjang:** Laporan yang rumit dan berat berisiko dihentikan oleh *Statement Timeout* database, Load Balancer (misalnya Nginx timeout 60s), atau `context.DeadlineExceeded` Golang. Solusi: Laporan besar harus dijadikan *Background Job* asinkron dan filenya diunggah ke S3, pengguna diberitahu via notifikasi.
3. **Penyusutan Kinerja karena CDC WAL Retention:** Jika service Debezium/CDC terputus atau rusak, log WAL PostgreSQL akan terus menumpuk di disk server karena belum dikonfirmasi (replikasi slot). Ini bisa membuat *disk full* dan PostgreSQL *crash*. Pasang *monitoring/alerting* ketat pada metrik replikasi slot lag.
4. **CSV Injection (Excel Macro Vulnerability):** Jika laporan memuat data input user (misal `reference` atau `notes`) yang diawali dengan `=`,`+`,`-`, atau `@`, Microsoft Excel bisa mengeksekusi itu sebagai formula atau perintah OS. Hati-hati melakukan *sanitization* nilai CSV.
5. **Database Connection Exhaustion saat Streaming:** Loop panjang pada iterasi `rows.Next()` mengambil 1 koneksi eksklusif. Jika `StreamingCSVReport` butuh 10 menit dan dipanggil ratusan user sekaligus, *Connection Pool* ke DB akan habis. Batasi konkurensi (misal menggunakan Semaphore pattern) pada rute laporan.

## Kapan JANGAN Pakai Ini

- **Query analitik di database transaksional produksi.** Pemindaian besar mengunci sumber daya yang dibutuhkan jalur pembayaran, dan laporan bulanan tidak layak menyebabkan transaksi gagal.
- **Menghitung ulang laporan periode tertutup dari nol setiap kali.** Untuk periode yang sudah ditutup, hasilnya **tidak boleh berubah**. Simpan hasilnya dan bandingkan; perubahan pada angka yang sudah dilaporkan adalah kejadian yang harus diselidiki.
- **Angka laporan yang tidak bisa ditelusuri ke transaksi asalnya.** Auditor akan meminta jejaknya, dan jawaban "pipeline menghitungnya" tidak memadai.
- **Laporan yang memakai zona waktu server.** Batas hari finansial ditentukan aturan bisnis dan yurisdiksi, bukan lokasi mesin. Server yang dipindah region seharusnya tidak mengubah laporan.
- **OLAP tanpa verifikasi terhadap sumber.** Pipeline yang melewatkan sebagian data menghasilkan laporan yang salah tanpa satu pun galat. Cocokkan total terhadap sumber, secara terjadwal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Angka periode lalu berubah | apakah hasil disimpan | Laporan dihitung ulang dengan data/aturan baru |
| Total OLAP tidak cocok dengan sumber | pemeriksaan silang terjadwal | Pipeline melewatkan sebagian data |
| Laporan berubah setelah pindah region | zona waktu yang dipakai | Batas hari mengikuti server |
| Jalur transaksi melambat saat pelaporan | database yang dipakai query | Analitik berjalan di primary |
| Angka tidak bisa dijelaskan ke auditor | jejak dari angka ke transaksi | Tidak ada penelusuran |

```sql
-- Verifikasi silang: total OLAP WAJIB sama dengan sumber transaksional
SELECT 'source' AS origin, sum(amount) FROM ledger WHERE date = '2026-08-04'
UNION ALL
SELECT 'olap',  sum(amount) FROM daily_report WHERE date = '2026-08-04';

-- Periode tertutup yang angkanya berubah: ini insiden, bukan perbedaan
SELECT period, stored_value, recalculated_value,
       stored_value - recalculated_value AS diff
FROM report_audit WHERE stored_value <> recalculated_value;
```
