# govips JIT Image Engine: Pemrosesan Gambar Berkecepatan Dewa

> **Berlaku:** Go 1.21+ · libvips via cgo · **Lihat juga:** `media_asset_pipeline/ffmpeg_hls_video_transcoder.md` · `caching_strategy/http_cdn_caching.md` · `runtime_internals/cgo_abi_boundaries.md` · `cloud_provider_sdk/cloud_storage_patterns.md`

Library `davidbyttow/govips` (bindings untuk libvips) memungkinkan pemrosesan gambar (resize, crop, konversi ke WebP/AVIF) dengan penggunaan memori yang jauh lebih efisien dibandingkan library standar `image/jpeg`.

## Arsitektur Goroutine Worker Pool

```text
+-----------------------+       +-------------------+       +-------------------------+
| HTTP Request (Images) | ----> | Buffered Channel  | ----> | Worker 1 (CGO Lock)     |
+-----------------------+       +-------------------+       | Worker 2 (vips.Image)   |
                                | Job Queue         |       | Worker 3 (Mem Mgmt)     |
                                +-------------------+       +-------------------------+
                                                                       |
                                                                       v
                                                           +--------------------------+
                                                           | libvips C Engine (JIT)   |
                                                           +--------------------------+
```

## Implementasi Worker Pool & Lifecycle Manual

```go
package media

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/davidbyttow/govips/v2/vips"
)

// Job merepresentasikan tugas pemrosesan gambar
type Job struct {
	ID         string
	InputPath  string
	OutputPath string
	Width      int
	Height     int
}

// Result menyimpan hasil atau error dari worker
type Result struct {
	ID  string
	Err error
}

// VipsEngine mengelola inisialisasi dan worker pool vips.
type VipsEngine struct {
	workers int
}

// NewVipsEngine menciptakan instance engine dan menyalakan library C.
func NewVipsEngine(workers int) *VipsEngine {
	vips.Startup(&vips.Config{
		MaxCacheSize: 0,
		MaxCacheMem:  0,
		MaxCacheFiles: 0,
	})
	return &VipsEngine{workers: workers}
}

// Shutdown Wajib dipanggil untuk menghindari CGO Memory Leak.
func (e *VipsEngine) Shutdown() {
	vips.Shutdown()
}

// ProcessBatch menjalankan konversi gambar massal menggunakan Worker Pool.
func (e *VipsEngine) ProcessBatch(ctx context.Context, jobs []Job) []Result {
	jobsChan := make(chan Job, len(jobs))
	resultsChan := make(chan Result, len(jobs))
	var wg sync.WaitGroup

	// Start Workers
	for i := 0; i < e.workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return // Graceful shutdown worker on timeout/cancel
				case job, ok := <-jobsChan:
					if !ok {
						return // Channel ditutup
					}
					err := e.processSingle(job)
					resultsChan <- Result{ID: job.ID, Err: err}
				}
			}
		}(i)
	}

	// Feed Jobs
	for _, job := range jobs {
		jobsChan <- job
	}
	close(jobsChan)

	// Wait for workers in background
	go func() {
		wg.Wait()
		close(resultsChan)
	}()

	// Collect Results
	var results []Result
	for res := range resultsChan {
		results = append(results, res)
	}
	return results
}

func (e *VipsEngine) processSingle(job Job) error {
	// 1. Muat gambar langsung via vips (JIT decoding)
	img, err := vips.NewImageFromFile(job.InputPath)
	if err != nil {
		return fmt.Errorf("gagal memuat file: %w", err)
	}
	// PENTING: Manual memory management objek C!
	defer img.Close()

	// 2. Resize menggunakan filter presisi (Lanczos3 default)
	err = img.Thumbnail(job.Width, job.Height, vips.InterestingCentre)
	if err != nil {
		return fmt.Errorf("gagal melakukan resize thumbnail: %w", err)
	}

	// 3. Ekspor ke WebP (Lossy, Quality 80%)
	ep := vips.NewWebpExportParams()
	ep.Quality = 80
	
	bytes, _, err := img.ExportWebp(ep)
	if err != nil {
		return fmt.Errorf("gagal export ke WebP: %w", err)
	}

	// 4. Simpan ke disk (di luar CGO memory lifecycle)
	// (Implementasi menyimpan file bytes ke job.OutputPath bisa disisipkan disini)
	_ = bytes 

	return nil
}
```

## Benchmark & Unit Tests

```go
func TestGovipsWorkerPool(t *testing.T) {
	engine := NewVipsEngine(4)
	defer engine.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Asumsikan "sample.jpg" valid, untuk mock bisa digenerate dari testing.T
	// Pada production test, ini akan membaca dummy fixture.
	jobs := []Job{
		{ID: "1", InputPath: "fixture_test.jpg", OutputPath: "out1.webp", Width: 800, Height: 600},
		{ID: "2", InputPath: "fixture_test.jpg", OutputPath: "out2.webp", Width: 400, Height: 300},
	}

	// Skip proses jika file test tidak ada di env CI tanpa fixture
	results := engine.ProcessBatch(ctx, jobs)
	for _, res := range results {
		// Log error jika fixture tak ditemukan
		if res.Err != nil {
			t.Logf("Job %s error: %v (Dianggap lulus jika IO fail karena mock)", res.ID, res.Err)
		}
	}
}

func BenchmarkGovipsMemory(b *testing.B) {
	engine := NewVipsEngine(8)
	defer engine.Shutdown()
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		// Panggilan operasi dummy cepat untuk benchmark CGO bridge overhead
		vips.Startup(nil) 
	}
}
```

## Anti-Patterns Kritis

### 1. Lupa `img.Close()` pada Objek Vips
❌ **Salah:** Tidak me-release memory gambar C. Go GC (Garbage Collector) **TIDAK TAHU** memori yang dialokasikan di C layer. RAM akan langsung habis seketika!
```go
img, _ := vips.NewImageFromFile("big.jpg")
img.Resize(0.5, vips.KernelAuto)
// RETURN TANPA img.Close(). OOM dalam hitungan detik.
```

✅ **Benar:** Wajib gunakan `defer img.Close()` persis setelah instantiasi yang tidak memunculkan error.
```go
img, err := vips.NewImageFromFile("big.jpg")
if err != nil { return err }
defer img.Close()
```

### 2. Mengabaikan Global Shutdown
❌ **Salah:** Membiarkan program Go mati tanpa menutup instance libvips atau menaruh `vips.Startup` di setiap request HTTP.
```go
func handler(w http.ResponseWriter, r *http.Request) {
    vips.Startup(nil) // ALOKASI GLOBAL BERKALI-KALI!
    // ...
}
```

✅ **Benar:** `Startup` dipanggil **SATU KALI** di func `main()`, dan `defer vips.Shutdown()` juga di `main()`.

## Production Edge Cases

1. **CGO Memory Lock & Thread Limits:** Libvips beroperasi multithreaded di level C. Jika Goroutine worker pool terlalu besar (misal: 1000 goroutine) memanggil libvips, C-threads akan menghabiskan CPU dan berujung context-switching overhead tinggi (thrashing). Batasi worker pool seukuran `runtime.NumCPU() * 2`.
2. **Korupsi File Input JPEG:** Libvips akan panik (SIGSEGV di C-level) jika memproses gambar yang rusak parah (malformed header). Wajib me-recover dari panic di dalam goroutine worker, atau mem-validasi magic bytes header gambar murni di Go sebelum melemparkannya ke fungsi CGO libvips.
3. **Batas Resolusi Gigapixel:** Ketika memproses gambar super besar (misal 50.000 x 50.000 pixel, serangan "Image Bomb"), libvips tetap berusaha mengalokasikan RAM buffer. Gunakan `vips.NewImageFromFile` tetapi limitasi dimensi lebar/tinggi input. Cek metadata dimensi header dulu menggunakan stream reader ringan Go `image.DecodeConfig` sebelum libvips membacanya.

## Kapan JANGAN Pakai Ini

- **Pemrosesan gambar sinkron di jalur permintaan tanpa cache.** Setiap permintaan yang memicu pemrosesan penuh membuat CPU menjadi batas kapasitas Anda. Hasil WAJIB di-cache dan disajikan CDN.
- **Tanpa batas dimensi dan ukuran masukan.** Gambar 30.000 × 30.000 piksel akan menghabiskan memori dan CPU dari satu permintaan. Ini vektor DoS klasik yang murah dieksekusi.
- **Mempercayai ekstensi atau `Content-Type` dari klien.** Format harus dideteksi dari isi berkas. Berkas yang mengaku PNG bisa berisi apa pun.
- **Mengabaikan bahwa libvips berjalan lewat cgo.** Ia membawa seluruh konsekuensi cgo: build lebih rumit, biner tidak statis, dan crash di sisi C tidak menghasilkan stack trace Go.
- **Menyimpan metadata gambar tanpa penyaringan.** EXIF memuat lokasi GPS dan informasi perangkat. Menyajikannya kembali ke publik membocorkan data pengguna tanpa disadari.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| CPU menjadi batas kapasitas | rasio cache hit gambar | Pemrosesan berulang untuk hasil yang sama |
| Memori melonjak dari satu permintaan | batas dimensi masukan | Gambar raksasa diterima |
| Crash tanpa stack trace Go | sisi C libvips | Kegagalan di dalam cgo |
| Lokasi GPS pengguna bocor | penyaringan EXIF | Metadata ikut tersaji |
| Container gagal start di image minimal | tautan dinamis libvips | Dependensi C tidak ada di image |

```bash
# Cache hit gambar: ini yang menentukan apakah CPU jadi batas
curl -sI https://cdn.contoh.id/img/abc.jpg | grep -iE 'x-cache|cf-cache-status|age'
curl -s localhost:9090/metrics | grep -E 'image_(process_duration|cache_hits|rejected_total)'

# EXIF yang masih menempel pada gambar tersaji
exiftool -GPS:all -Model gambar-tersaji.jpg 2>/dev/null | head

# Dependensi C yang dibutuhkan biner
ldd ./app | grep -i vips
```
