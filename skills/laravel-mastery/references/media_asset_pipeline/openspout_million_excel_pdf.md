---
name: openspout_million_excel_pdf
description: Panduan arsitektur pengeksporan 1.000.000 baris data ke file Excel/CSV tanpa Out of Memory (OOM) menggunakan OpenSpout (FastExcel) dan generasi faktur presisi mikro menggunakan Spatie Browsershot.
---

# Export Jutaan Baris Excel & Mikro-Presisi PDF

Memproses jutaan baris data untuk diekspor ke Excel (XLSX) dan CSV secara tradisional memicu *Fatal Error: Allowed memory size exhausted*. Solusi mutakhirnya adalah menggunakan *Generator* (`yield`), kursor basis data (`lazy()`), dan pustaka *streaming* seperti **OpenSpout** atau **FastExcel**.
Untuk PDF, HTML-to-PDF berbasis webkit usang digantikan dengan **Spatie Browsershot** (Headless Chromium) untuk dukungan *Grid/Flexbox/SVG/Fonts* presisi mikro.

## 1. Arsitektur Excel Streaming & Headless PDF

Diagram ini memvisualisasikan bagaimana aliran data tidak pernah dimuat sekaligus ke RAM, namun dialirkan (streaming) per-blok langsung ke sistem file.

```text
+-------------------+      Kueri Cursor / lazy()      +-----------------------+
|  PostgreSQL / DB  | ------------------------------> | Laravel 11 App Worker |
| (1.000.000 Baris) |     (Stream: 1000 baris/iterasi)| [ OpenSpout Writer ]  |
+-------------------+                                 +-----------+-----------+
                                                                  | Tulis Stream (I/O)
                                                                  v
+-------------------+      Kirim URL Unduh            +-----------------------+
|  User (Frontend)  | <------------------------------ | Disk (Lokal / S3)     |
|                   |                                 | [ report_Q3.xlsx ]    |
+-------------------+                                 +-----------------------+

====================  ALUR GENERASI PDF FAKTUR ================================

+-------------------+   Kirim HTML/Blade View         +-----------------------+
|  Laravel 11 App   | ------------------------------> | Puppeteer / Chromium  |
| [ PDF Controller ]|   (Render Flexbox/Tailwind)     | [ Headless Browser ]  |
+-------------------+ <------------------------------ +-----------------------+
                            Kembalikan file .pdf
```

## 2. Implementasi Produksi (PHP 8.3 + Laravel 11 + PHPStan Level 9)

### 2.1. Excel Streaming Export (OpenSpout / FastExcel)

Pastikan dependensi `openspout/openspout` atau `rap2hpoutre/fast-excel` sudah terpasang.

```php
<?php

declare(strict_types=1);

namespace App\Services\Export;

use App\Models\Transaction;
use Illuminate\Support\LazyCollection;
use OpenSpout\Writer\XLSX\Writer;
use OpenSpout\Common\Entity\Row;
use OpenSpout\Common\Entity\Cell;
use OpenSpout\Writer\XLSX\Options;
use Illuminate\Support\Facades\Log;
use Throwable;

final class TransactionExcelExporter
{
    /**
     * Ekspor data besar ke file XLSX dengan memori stabil (~15MB RAM konstan).
     *
     * @param string $destinationPath Path absolut untuk menyimpan file
     * @return void
     * @throws Throwable Jika I/O atau Query gagal
     */
    public function export(string $destinationPath): void
    {
        $options = new Options();
        // Optimasi memori saat penulisan (jangan simpan string inline secara default jika file besar)
        
        $writer = new Writer($options);
        $writer->openToFile($destinationPath);

        // Tulis Header
        $writer->addRow(Row::fromValues(['ID', 'Tanggal', 'Nominal', 'Status']));

        try {
            // Gunakan lazy() atau cursor() dari Eloquent (dibungkus dalam LazyCollection)
            /** @var LazyCollection<int, Transaction> $transactions */
            $transactions = Transaction::query()
                ->select(['id', 'created_at', 'amount', 'status'])
                ->cursor(); // Cursor menghemat RAM, mengeksekusi fetch secara streaming per row dari PDO

            foreach ($transactions as $transaction) {
                // Konversi Model ke array skalar
                $rowData = [
                    $transaction->id,
                    $transaction->created_at->format('Y-m-d H:i:s'),
                    (float) $transaction->amount,
                    $transaction->status,
                ];

                $writer->addRow(Row::fromValues($rowData));
            }

            $writer->close();
            
        } catch (Throwable $exception) {
            $writer->close();
            Log::error('Gagal export data transaksi', ['error' => $exception->getMessage()]);
            throw $exception;
        }
    }
}
```

### 2.2. PDF Faktur Presisi Mikro (Browsershot)

Pastikan *Puppeteer* dan *Node.js* tersedia di server.

```php
<?php

declare(strict_types=1);

namespace App\Services\Export;

use Spatie\Browsershot\Browsershot;
use Illuminate\Support\Facades\View;
use RuntimeException;

final class InvoicePdfGenerator
{
    /**
     * Hasilkan PDF berdasarkan data faktur.
     *
     * @param array<string, mixed> $invoiceData
     * @param string $outputPath Path untuk menyimpan PDF
     * @return void
     */
    public function generate(array $invoiceData, string $outputPath): void
    {
        $html = View::make('pdf.invoice', $invoiceData)->render();

        try {
            Browsershot::html($html)
                ->format('A4')
                ->margins(10, 10, 10, 10)
                ->showBackground() // Agar warna Tailwind tercetak
                ->waitUntilNetworkIdle() // Pastikan font/image termuat
                ->noSandbox() // Sering diperlukan di environment containerized/Docker
                ->save($outputPath);
        } catch (\Throwable $exception) {
            throw new RuntimeException(
                "Gagal menghasilkan PDF faktur: " . $exception->getMessage(),
                0,
                $exception
            );
        }
    }
}
```

## 3. Pest v3 Tests (Architecture & Unit)

```php
<?php

use App\Services\Export\TransactionExcelExporter;
use App\Models\Transaction;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

test('it exports transaction stream to excel without memory exhaustion', function () {
    // Siapkan dummy data
    Transaction::factory()->count(100)->create();
    
    $exporter = new TransactionExcelExporter();
    $tempPath = storage_path('app/temp_export.xlsx');
    
    $exporter->export($tempPath);
    
    expect(file_exists($tempPath))->toBeTrue();
    expect(filesize($tempPath))->toBeGreaterThan(0);
    
    // Cleanup
    @unlink($tempPath);
});
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Menggunakan `get()` alih-alih `cursor()` atau `lazy()`
Mencoba memuat data utuh ke dalam RAM menggunakan *collection* memori.
```php
// ❌ SALAH: Memuat 1.000.000 model Eloquent langsung memicu OOM (bisa 2GB+ RAM).
$transactions = Transaction::all(); 
foreach($transactions as $t) { /* tulis excel */ }
```
**✅ SOLUSI:** Selalu gunakan `Transaction::cursor()` (PDO PDO::FETCH_ORI_NEXT) atau `Transaction::chunk(1000, function($rows) {})` yang mempertahankan pemakaian RAM di bawah ~15MB (konstan).

### ❌ Anti-Pattern 2: Menggunakan DOMPDF / TCPDF untuk Layout Kompleks
Memaksakan framework CSS modern (Tailwind/Bootstrap/Grid) pada *library* usang PHP murni.
```php
// ❌ SALAH: Grid, Flexbox, SVG eksternal akan berantakan total di DOMPDF.
$pdf = PDF::loadView('modern-layout'); 
return $pdf->download();
```
**✅ SOLUSI:** Gunakan `Spatie\Browsershot` (Puppeteer/Chromium headless). Rendering akan setara persis dengan apa yang Anda lihat di Google Chrome modern.

## 5. Production Edge Cases

1. **N+1 Query pada Export Lazy/Cursor:**
   Saat menggunakan `cursor()`, relasi *eager loading* konvensional (`with()`) tidak bekerja ideal. Anda dapat mengalami masalah N+1 yang mengerikan. Selalu andalkan kombinasi Joins di kueri utama atau gunakan `chunk()` agar `with()` ter-eksekusi secara per-batch.

2. **File Size Limit (Timeout) saat Export Raksasa:**
   Meski RAM stabil, ekspor 1.000.000 baris memakan waktu I/O (I/O Bound). Menjalankan proses ini di Web Request (Controller) akan menyebabkan Nginx 504 Gateway Timeout (setelah 60 detik). Proses ini **wajib** dikirim sebagai *Background Job* (Queue), lalu *progress* dilaporkan via email atau Reverb ke klien ketika selesai.

3. **Zombie Chrome Processes (Puppeteer Leaks):**
   Pada server Linux produksi yang sibuk me-render PDF (Browsershot), Chromium kadang gagal mati (Crash). Ini meninggalkan "Zombie Processes" (`defunct` chrome) yang menggerogoti RAM server secara senyap. Implementasikan *graceful termination* atau jalankan *cron* internal OS secara berkala `pkill -f "chrome --headless"` untuk mematikan *orphaned processes*.
