# Chromedp PDF Rendering Engine: Invoice Generator Presisi

> **Berlaku:** Go 1.21+ · `chromedp` · Chrome headless · **Lihat juga:** `media_asset_pipeline/excelize_streaming_million_rows.md` · `system_programming_linux/process_management_exec.md` · `background_jobs_worker/river_postgres_jobs.md` · `devops_control_planes/docker_container_go.md`

Membangun file PDF dari template HTML CSS menggunakan instance Chrome/Chromium Headless secara JIT adalah metode paling akurat (mendukung Grid, Flexbox, Web Fonts). Metode ini jauh lebih superior dari pustaka Go murni (seperti `gofpdf`) jika berurusan dengan CSS kompleks.

## Arsitektur Headless Debugger WS Connection Pooling

```text
+-------------------+      +-------------------------------+      +---------------------------+
| HTTP Request API  | ---> | Chromedp Context Allocator    | ---> | Headless Chrome Browser   |
+-------------------+      +-------------------------------+      | (WS Debugger Protocol)    |
         |                         | Connection Pool                 | Render Pipeline           |
         v                         v                                 v                           |
+-------------------+      +-------------------------------+      +---------------------------+  |
| Render HTML/CSS   | <--- | Browser.PrintToPDF (Byte Arr) | <--- | Page -> DOM -> CSS -> PDF | -+
+-------------------+      +-------------------------------+      +---------------------------+
```

## Implementasi Headless PDF Renderer

```go
package media

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// PDFEngine mengelola koneksi ke peramban Chrome.
type PDFEngine struct {
	execAllocatorCtx context.Context
	allocatorCancel  context.CancelFunc
}

// NewPDFEngine melakukan bootstrapping process pool Chrome.
// Jangan melakukan spawn per request HTTP! Alokasikan sekali saat server start.
func NewPDFEngine() *PDFEngine {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true), // Dibutuhkan jika jalan di Docker
	)

	// Context allocator global dengan lifecycle menempel di aplikasi (bukan HTTP Request)
	allocCtx, cancel := chromedp.NewExecAllocator(context.Background(), opts...)

	// Pre-start browser instance (warm-up)
	ctx, cancelCtx := chromedp.NewContext(allocCtx)
	_ = chromedp.Run(ctx)
	cancelCtx()

	return &PDFEngine{
		execAllocatorCtx: allocCtx,
		allocatorCancel:  cancel,
	}
}

// Shutdown membersihkan Chrome Zombie Process di OS level.
func (e *PDFEngine) Shutdown() {
	e.allocatorCancel()
}

// RenderHTMLToPDF menerima raw HTML (atau URL) dan mencetak layout PDF persis piksel A4.
func (e *PDFEngine) RenderHTMLToPDF(ctx context.Context, htmlContent string) ([]byte, error) {
	// Buat context lokalan untuk tab browser (dari allocator global)
	taskCtx, cancel := chromedp.NewContext(e.execAllocatorCtx)
	defer cancel()

	// Timeout untuk single rendering task
	taskCtx, cancelTimeout := context.WithTimeout(taskCtx, 15*time.Second)
	defer cancelTimeout()

	var pdfBuffer []byte

	// Pipeline Task
	tasks := chromedp.Tasks{
		// Inject HTML ke DOM (Bypass network request jika lokal)
		chromedp.Navigate("about:blank"),
		chromedp.ActionFunc(func(c context.Context) error {
			frameTree, err := page.GetFrameTree().Do(c)
			if err != nil {
				return err
			}
			return page.SetDocumentContent(frameTree.Frame.ID, htmlContent).Do(c)
		}),
		// Tunggu layout siap. Penting untuk font web eksternal!
		chromedp.ActionFunc(func(ctx context.Context) error {
			// PrintToPDF dipanggil langsung via action func custom 
			// agar bisa mengatur setelan kertas presisi.
			buf, _, err := page.PrintToPDF().
				WithPaperWidth(8.27).   // A4 Width in inches
				WithPaperHeight(11.69). // A4 Height in inches
				WithPrintBackground(true).
				WithMarginTop(0.4).
				WithMarginBottom(0.4).
				Do(ctx)
			
			if err != nil {
				return err
			}
			pdfBuffer = buf
			return nil
		}),
	}

	if err := chromedp.Run(taskCtx, tasks); err != nil {
		return nil, fmt.Errorf("chromedp PDF render failed: %w", err)
	}

	return pdfBuffer, nil
}
```

## Benchmark & Unit Tests

```go
func TestChromedpPDFGeneration(t *testing.T) {
	// Membutuhkan instalasi Google Chrome/Chromium lokal di mesin test.
	engine := NewPDFEngine()
	defer engine.Shutdown()

	ctx := context.Background()
	html := `<!DOCTYPE html><html><body style="color: red;"><h1>Invoice Test</h1></body></html>`

	pdfData, err := engine.RenderHTMLToPDF(ctx, html)
	if err != nil {
		t.Fatalf("failed to render PDF: %v", err)
	}

	if len(pdfData) < 100 { // Minimal signature PDF %PDF-
		t.Errorf("generated PDF byte array is too small: %d bytes", len(pdfData))
	}
}

func BenchmarkChromedpContextAlloc(b *testing.B) {
	engine := NewPDFEngine()
	defer engine.Shutdown()
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		// Tes seberapa cepat spawn dan tutup konteks TAB (bukan proses baru)
		ctx, cancel := chromedp.NewContext(engine.execAllocatorCtx)
		cancel()
		_ = ctx
	}
}
```

## Anti-Patterns Kritis

### 1. Spawning Allocator di Setiap Request HTTP
❌ **Salah:** Menciptakan browser Chrome penuh (PID OS baru) untuk setiap permintaan cetak PDF. Jika ada 100 user konruken mencetak invoice, 100 proses Chrome akan menghabiskan seluruh RAM VPS (Server OOM Kill!).
```go
func handlePrint(w http.ResponseWriter, r *http.Request) {
    alloc, cancel := chromedp.NewExecAllocator(context.Background()) // OOM INSTANT
    defer cancel()
    // ...
}
```

✅ **Benar:** Gunakan arsitektur Connection Pooling. `NewExecAllocator` hanya dipanggil SATU KALI di struct engine global saat inisialisasi, dan tiap request hanya memanggil `chromedp.NewContext` untuk membuka "Tab" virtual baru di debugger WS.

### 2. Tidak Menuggu Asset Font Selesai Dimuat (Race Condition WebFonts)
❌ **Salah:** Merender PDF seketika HTML dimasukkan. Teks akan dicetak menggunakan font default (Times New Roman fallback) karena Chrome belum selesai memuat font Custom/Google Fonts via jaringan.

✅ **Benar:** Gunakan Action handler sinkronisasi di chromedp seperti `chromedp.WaitVisible` pada DOM selector spesifik, atau injeksi CSS `@font-face` berbentuk Base64 WOFF2 langsung (inline) ke dalam tag `<style>` HTML payload untuk bypassing network layer 100% (Instant rendering).

## Production Edge Cases

1. **Goroutine Leak di Tab Context:** Jika context lokal (Tab) `chromedp.NewContext` tidak ditutup lewat `cancel()` karena linter/developer error (misalnya `return err` prematur tanpa `defer cancel()`), Tab Headless tersebut beserta WebSocket hub-nya akan menjadi Zombie Goroutine Memory Leak di aplikasi Go. Pastikan lifecycle di-wrap ketat.
2. **Zombie Chrome OS Process di Docker Container:** Walau Go crash atau dibunuh (SIGTERM), process `chrome` / `chromium` seringkali tetap menempel di host kernel PID 1 Docker sebagai zombie process, menyebabkan restart loop gagal. Wajib memakai init process dummy sebagai PID 1 di Dockerfile (seperti `tini` atau `dumb-init`) agar child PID disapu bersih saat Go aplikasi exit.
3. **Layout Overflow Terpotong:** CSS `height: 100vh` akan dipaksa menjadi ukuran `WithPaperHeight` oleh headless print. Halaman yang overflow panjang tidak otomatis membuat lembar ke-2 (page break) kecuali CSS `@media print { page-break-after: always; }` ditulis dan diposisikan dengan seksama pada block-level elements DOM HTML.

## Kapan JANGAN Pakai Ini

- **Chrome headless bila pustaka PDF murni cukup.** Menjalankan browser lengkap untuk menghasilkan invoice adalah ratusan megabyte memori per instans. Untuk tata letak sederhana, pustaka PDF langsung jauh lebih ringan dan lebih dapat diprediksi.
- **Merender HTML dari input pengguna tanpa isolasi.** Halaman yang dirender bisa memuat sumber daya eksternal dan menjalankan JavaScript. Tanpa isolasi jaringan, itu jalur SSRF yang lengkap — halaman bisa meminta metadata cloud internal.
- **Tanpa timeout dan pembersihan instans browser.** Instans Chrome yang tertinggal adalah kebocoran memori berskala ratusan megabyte, dan menumpuk sampai node tidak sehat.
- **Rendering sinkron di jalur permintaan.** Halaman kompleks memakan detik. Ia pekerjaan latar dengan pengunduhan hasil, bukan respons langsung.
- **Tanpa menyematkan versi Chrome.** Pembaruan Chrome mengubah rendering, dan dokumen yang dihasilkan bulan lalu tidak lagi identik — masalah nyata untuk dokumen yang harus konsisten.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Memori pod naik dan tidak turun | instans Chrome yang tersisa | Browser tidak ditutup |
| Permintaan ke alamat internal dari renderer | isolasi jaringan renderer | Jalur SSRF lewat HTML |
| Tampilan PDF berubah tanpa perubahan kode | versi Chrome | Pembaruan browser mengubah rendering |
| Permintaan timeout saat membuat PDF | apakah sinkron | Rendering di jalur permintaan |
| Node tidak sehat setelah beberapa jam | jumlah proses Chrome | Instans menumpuk |

```bash
# Instans Chrome yang tertinggal -- penyebab paling umum masalah memori di sini
kubectl exec <pod> -- ps -ef | grep -c '[c]hrome'
kubectl top pod -l app=pdf

# Versi Chrome yang benar-benar dipakai
kubectl exec <pod> -- chromium --version

# Renderer TIDAK BOLEH bisa menjangkau metadata cloud
kubectl exec <pod> -- curl -s --max-time 2 http://169.254.169.254/ && echo "BAHAYA: metadata terjangkau"

curl -s localhost:9090/metrics | grep -E 'pdf_(render_duration|failed_total|browser_instances)'
```
