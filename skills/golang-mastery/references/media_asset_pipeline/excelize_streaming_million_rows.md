# High-Performance Excel Streaming (1 Juta Baris, <20MB RAM)

> **Berlaku:** Go 1.21+ · `qax-os/excelize` v2 · **Lihat juga:** `media_asset_pipeline/chromedp_pdf_rendering_engine.md` · `fintech_reliability/financial_reporting_olap.md` · `runtime_internals/escape_analysis_pprof.md` · `background_jobs_worker/river_postgres_jobs.md`

Streaming API pada `xuri/excelize` adalah kunci utama untuk menangani file Excel berukuran raksasa tanpa mengorbankan memori. Pendekatan tradisional yang memuat seluruh DOM Excel ke memori akan menyebabkan GC (Garbage Collector) thrashing dan Out-Of-Memory (OOM) pauses.

## Arsitektur Alur Memori (StreamWriter)

```text
+---------------------+      +------------------------+      +--------------------------+
| Data Source (DB/IO) | ---> | Go Channel (Batching)  | ---> | excelize.StreamWriter    |
+---------------------+      +------------------------+      +--------------------------+
          |                              |                                |
          | GC Friendly                  | Buffered (e.g. 1000 rows)      | Direct to XML File (Disk)
          v                              v                                v
+---------------------------------------------------------------------------------------+
| RAM Consumption: Tetap Stabil < 20 MB, Terlepas dari Jumlah Baris (Bisa 1.000.000+)   |
+---------------------------------------------------------------------------------------+
```

## Implementasi Production-Ready

Kode di bawah ini mendemonstrasikan penulisan 1 juta baris ke dalam format `.xlsx` menggunakan `StreamWriter`, serta pembacaan menggunakan `Rows.Next()`.

```go
package media

import (
	"context"
	"fmt"
	"io"
	"os"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// ExportMillionRows menghasilkan file Excel dengan data masif menggunakan memori minimal.
func ExportMillionRows(ctx context.Context, filePath string, totalRows int) error {
	f := excelize.NewFile()
	defer func() {
		if err := f.Close(); err != nil {
			fmt.Printf("failed to close file: %v\n", err)
		}
	}()

	sheetName := "Sheet1"
	sw, err := f.NewStreamWriter(sheetName)
	if err != nil {
		return fmt.Errorf("failed to create stream writer: %w", err)
	}

	// Tulis Header
	header := []interface{}{"ID", "Name", "Transaction", "Time", "Status"}
	if err := sw.SetRow("A1", header); err != nil {
		return fmt.Errorf("failed to write header: %w", err)
	}

	// Tulis Baris Data (Batching & Context Cancellation Check)
	for i := 1; i <= totalRows; i++ {
		// Validasi context setiap 1000 iterasi agar tidak memblokir performa
		if i%1000 == 0 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("operation cancelled: %w", ctx.Err())
			default:
			}
		}

		cell, err := excelize.CoordinatesToCellName(1, i+1)
		if err != nil {
			return fmt.Errorf("invalid cell coordinate at row %d: %w", i, err)
		}

		rowData := []interface{}{
			i,
			fmt.Sprintf("User %d", i),
			150000.50 + float64(i),
			time.Now().Format(time.RFC3339),
			true,
		}

		if err := sw.SetRow(cell, rowData); err != nil {
			return fmt.Errorf("failed to write row %d: %w", i, err)
		}
	}

	// PENTING: Wajib Flush sebelum disimpan
	if err := sw.Flush(); err != nil {
		return fmt.Errorf("failed to flush stream writer: %w", err)
	}

	if err := f.SaveAs(filePath); err != nil {
		return fmt.Errorf("failed to save file %s: %w", filePath, err)
	}

	return nil
}

// ReadStreaming membaca file Excel berukuran besar tanpa memuat semuanya ke RAM.
func ReadStreaming(ctx context.Context, filePath string) (int, error) {
	f, err := excelize.OpenFile(filePath)
	if err != nil {
		return 0, fmt.Errorf("failed to open Excel file: %w", err)
	}
	defer f.Close()

	rows, err := f.Rows("Sheet1")
	if err != nil {
		return 0, fmt.Errorf("failed to read rows: %w", err)
	}

	count := 0
	for rows.Next() {
		// Cek context pembatalan
		if count%1000 == 0 {
			select {
			case <-ctx.Done():
				return count, fmt.Errorf("reading cancelled: %w", ctx.Err())
			default:
			}
		}
		
		row, err := rows.Columns()
		if err != nil {
			return count, fmt.Errorf("failed to parse columns at row %d: %w", count, err)
		}
		
		// Proses data baris (simulasi)
		_ = row
		count++
	}

	if err := rows.Error(); err != nil {
		return count, fmt.Errorf("error during row iteration: %w", err)
	}

	return count, nil
}
```

## Benchmark & Unit Tests

```go
func BenchmarkExportMillionRows(b *testing.B) {
	tempFile := "benchmark_million_rows.xlsx"
	defer os.Remove(tempFile)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		// Uji dengan 100,000 baris untuk benchmark cepat
		err := ExportMillionRows(context.Background(), tempFile, 100000)
		if err != nil {
			b.Fatalf("failed to export: %v", err)
		}
	}
}

func TestStreamWriterReader(t *testing.T) {
	tempFile := "test_stream.xlsx"
	defer os.Remove(tempFile)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	totalRows := 50000
	err := ExportMillionRows(ctx, tempFile, totalRows)
	if err != nil {
		t.Fatalf("Export error: %v", err)
	}

	readCount, err := ReadStreaming(ctx, tempFile)
	if err != nil {
		t.Fatalf("Read error: %v", err)
	}

	// Baris data (50000) + 1 baris header
	expected := totalRows + 1
	if readCount != expected {
		t.Errorf("expected %d rows, got %d rows", expected, readCount)
	}
}
```

## Anti-Patterns Kritis

### 1. Menulis ke Sel Menggunakan Standard API pada Data Masif
❌ **Salah:** Menggunakan `SetCellValue` di dalam loop jutaan kali. Memori akan membengkak gila-gilaan karena seluruh worksheet di-buffer di RAM.
```go
for i := 1; i <= 1000000; i++ {
    f.SetCellValue("Sheet1", fmt.Sprintf("A%d", i), data) // OOM TUNGGU WAKTU SAJA!
}
```

✅ **Benar:** Gunakan `StreamWriter` dan `SetRow`.
```go
sw, _ := f.NewStreamWriter("Sheet1")
for i := 1; i <= 1000000; i++ {
    sw.SetRow(fmt.Sprintf("A%d", i), []interface{}{data})
}
sw.Flush() // Wajib Flush!
```

### 2. Lupa Memanggil `Flush()` pada StreamWriter
❌ **Salah:** Menggunakan `StreamWriter` tapi tidak di-flush sebelum di-save. File Excel yang dihasilkan akan korup atau datanya hilang.
```go
sw.SetRow("A1", rowData)
f.SaveAs("result.xlsx") // ERROR: File XML tidak selesai ditulis!
```

✅ **Benar:** Memanggil `Flush()` untuk memastikan temporary XML buffer disalin sepenuhnya ke struktur zip `.xlsx`.
```go
sw.Flush()
f.SaveAs("result.xlsx")
```

## Production Edge Cases

1. **Context Timeout saat Ekspor Data Masif:** Ekspor 1 juta baris dari database lambat bisa memakan waktu menit-an. Jika koneksi HTTP klien terputus, backend tidak boleh terus menggerus CPU. Wajib menginjeksi context cancellation (misal cek `ctx.Done()` setiap 1000 iterasi loop) untuk memutus proses di tengah jalan.
2. **Karakter Ilegal dalam Sel Excel (XML Encoding Error):** Excel menggunakan standar XML ketat (XML 1.0). Karakter kontrol seperti `\x00` - `\x08` akan memecahkan proses unmarshaling saat file dibuka. Wajib melakukan sanitasi string data (menghilangkan non-printable characters) sebelum dimasukkan ke `SetRow()`.
3. **Membaca File Corrupted dengan Endless Loop:** Kadangkala file Excel hasil unggahan pengguna memiliki struktur internal `<sheetData>` yang rusak. Ketika menggunakan `rows.Next()`, pastikan menambahkan pengecekan `rows.Error()` sesudah loop, dan sediakan time-out context ketat, agar worker tidak terjebak dalam pembacaan tak berujung (CPU pin) karena iterasi gagal maju.

## Kapan JANGAN Pakai Ini

- **Menulis jutaan baris tanpa StreamWriter.** API biasa menyimpan seluruh lembar di memori sebelum menulisnya. Pada satu juta baris, itu gigabyte — dan berakhir `OOMKilled` di tengah pekerjaan yang sudah berjalan lama.
- **Menghasilkan berkas Excel di jalur permintaan HTTP.** Pembuatannya memakan detik sampai menit. Ia pekerjaan latar dengan pemberitahuan saat selesai, bukan respons sinkron.
- **Excel untuk pertukaran data antar sistem.** CSV atau Parquet lebih sederhana, lebih cepat, dan tidak membawa batasan format Excel. Excel untuk manusia yang akan membukanya.
- **Mengabaikan batas format.** Satu lembar Excel maksimal sekitar 1.048.576 baris. Melewatinya bukan sekadar lambat — berkasnya tidak valid.
- **Rumus dan gaya per sel pada volume besar.** Keduanya memperbesar berkas dan memperlambat pembuatan secara dramatis. Untuk ekspor besar, nilai polos jauh lebih tepat.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Proses `OOMKilled` saat ekspor besar | apakah StreamWriter dipakai | Seluruh lembar dibangun di memori |
| Permintaan HTTP timeout saat ekspor | apakah sinkron | Pembuatan berkas di jalur permintaan |
| Berkas tidak bisa dibuka | jumlah baris | Melewati batas format |
| Berkas sangat besar | gaya dan rumus per sel | Metadata mendominasi isi |
| Ekspor makin lambat tiap bulan | pertumbuhan data | Tidak ada paginasi atau pembatasan rentang |

```bash
# Memori saat ekspor besar berjalan
kubectl top pod -l app=export
go tool pprof -sample_index=inuse_space -top http://localhost:6060/debug/pprof/heap | head -15

# Durasi dan ukuran hasil
curl -s localhost:9090/metrics | grep -E 'export_(duration_seconds|rows_total|bytes)'

kubectl get pods -l app=export -o json \
  | jq -r '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason=="OOMKilled") | .metadata.name'
```
