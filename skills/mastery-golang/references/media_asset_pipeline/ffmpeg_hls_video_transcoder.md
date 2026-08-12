# FFmpeg HLS Transcoder: Pipeline Context-Aware & Streaming I/O

> **Berlaku:** Go 1.21+ · FFmpeg · HLS · **Lihat juga:** `media_asset_pipeline/govips_jit_image_engine.md` · `system_programming_linux/process_management_exec.md` · `background_jobs_worker/river_postgres_jobs.md` · `cloud_provider_sdk/cloud_storage_patterns.md`

Transcoding video untuk Adaptive Bitrate Streaming (HLS) sering menjadi biang kerok I/O bottleneck dan file bengkak. Teknik top 1% ini memanfaatkan `os/exec` dengan Context, memantau output via Stderr (karena FFmpeg menulis log ke stderr), serta mengatur pipeline I/O pipes.

## Arsitektur Exec Context & Pipe Stream

```text
+----------------------+        +-------------------------------+         +-----------------------+
| HTTP Multipart/S3    | -----> | Go io.Reader (io.PipeWriter)  | --+     | FFmpeg Subprocess     |
| (Stream Input)       |        +-------------------------------+   |     |                       |
+----------------------+                                            +---> | [stdin]               |
                                                                          | [stdout] -> M3U8/TS   |
+----------------------+        +-------------------------------+   +---> | [stderr] -> Log/Stats |
| Progress WebSocket   | <----- | Go Regex Parser (Progress %)  | --+     +-----------------------+
+----------------------+        +-------------------------------+
```

## Implementasi Context-Bound Exec

```go
package media

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// FFmpegEngine membungkus eksekusi transcoder.
type FFmpegEngine struct {
	binaryPath string
}

// NewFFmpegEngine inisialisasi transcoder engine.
func NewFFmpegEngine() *FFmpegEngine {
	// Pada production, periksa env var path.
	return &FFmpegEngine{binaryPath: "ffmpeg"}
}

// TranscodeToHLS menjalankan konversi ke HLS (1080p, H.264) menggunakan os/exec.
func (e *FFmpegEngine) TranscodeToHLS(ctx context.Context, inputPath, outM3U8 string, progressCh chan<- float64) error {
	// FFmpeg Arguments:
	// -y : Overwrite
	// -i : Input file
	// -c:v libx264 : Video codec
	// -hls_time 4 : Panjang segment 4 detik
	args := []string{
		"-y",
		"-i", inputPath,
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-crf", "23",
		"-c:a", "aac",
		"-b:a", "128k",
		"-f", "hls",
		"-hls_time", "4",
		"-hls_playlist_type", "vod",
		outM3U8,
	}

	// Gunakan CommandContext agar kill process dikelola kernel saat ctx.Done()
	cmd := exec.CommandContext(ctx, e.binaryPath, args...)

	// Tangkap Stderr pipe untuk kalkulasi progress
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start ffmpeg: %w", err)
	}

	// Parsing Progress di Background Goroutine
	go func() {
		defer close(progressCh)
		scanner := bufio.NewScanner(stderrPipe)
		
		// Regex mencari pattern time=00:00:10.50
		timeRegex := regexp.MustCompile(`time=(\d{2}):(\d{2}):(\d{2}\.\d{2})`)
		
		for scanner.Scan() {
			line := scanner.Text()
			matches := timeRegex.FindStringSubmatch(line)
			if len(matches) == 4 {
				h, _ := strconv.Atoi(matches[1])
				m, _ := strconv.Atoi(matches[2])
				s, _ := strconv.ParseFloat(matches[3], 64)
				totalSeconds := float64(h*3600 + m*60) + s
				
				// Kirim durasi terbaca (butuh durasi total video untuk % absolut)
				select {
				case progressCh <- totalSeconds:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	// Tunggu proses selesai secara sinkron
	if err := cmd.Wait(); err != nil {
		// Jika err karena Context deadline terlewati
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("transcoding cancelled due to timeout: %w", err)
		}
		return fmt.Errorf("ffmpeg execution failed: %w", err)
	}

	return nil
}
```

## Benchmark & Unit Tests

```go
func TestFFmpegContextCancellation(t *testing.T) {
	// Tes bahwa FFmpeg (sleep command fallback jika mock) bisa dihentikan oleh context.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sleep", "10") // Simulasi proses lama
	err := cmd.Run()
	
	if err == nil {
		t.Fatal("expected command to be cancelled by context, but it ran successfully")
	}

	if ctx.Err() != context.DeadlineExceeded {
		t.Fatalf("expected context.DeadlineExceeded, got %v", ctx.Err())
	}
}

func BenchmarkFFmpegCommandConstruction(b *testing.B) {
	engine := NewFFmpegEngine()
	ctx := context.Background()
	progress := make(chan float64, 100)
	defer close(progress)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		// Hanya menguji alokasi objek command, jangan eksekusi betulan dalam loop tight.
		_ = exec.CommandContext(ctx, engine.binaryPath, "-version")
	}
}
```

## Anti-Patterns Kritis

### 1. Menggunakan `exec.Command` Tanpa Context
❌ **Salah:** Menggunakan `exec.Command` murni. Jika API dibatalkan klien atau terputus koneksi, proses zombie FFmpeg akan selamanya membakar CPU di server (Orphan process).
```go
cmd := exec.Command("ffmpeg", "-i", "input.mp4", "out.mp4")
cmd.Run() // ZOMBIE LEAK JIKA HTTP TERCANCEL!
```

✅ **Benar:** Gunakan `exec.CommandContext(ctx, ...)` sehingga `kill -9` terkirim dari OS ke child PID saat HTTP context putus.

### 2. Membaca Seluruh Output Exec Ke Memory (RAM Burst)
❌ **Salah:** Menggunakan `cmd.CombinedOutput()` untuk logging FFmpeg transcoding file raksasa 50GB. FFmpeg melempar ribuan log ke stderr, RAM akan meledak!
```go
out, err := cmd.CombinedOutput() // OOM KARENA BUFFER SLICE MEMBENGKAK!
fmt.Println(string(out))
```

✅ **Benar:** Gunakan `StdoutPipe` / `StderrPipe` dan parsing menggunakan `bufio.Scanner` secara streaming per-baris, me-release line dari memori secepat mungkin.

## Production Edge Cases

1. **EOF Pipe Error Saat Transcoding Cepat:** Kadangkala, subprocess FFmpeg selesai sangat cepat atau gagal mendadak (misal file input tidak ada). Saat Go `bufio.Scanner` mencoba membaca dari `StderrPipe`, ia akan mendapat `io.EOF`. Pastikan penanganan EOF pada goroutine pembaca log tidak panik atau nge-block `Wait()`. `Scanner` secara default menangani EOF graceful.
2. **Zombie Process pada Pipa stdin (Piping I/O):** Jika meneruskan video ke stdin FFmpeg menggunakan `io.Pipe`, jika Go selesai mengalirkan data, ia WAJIB memanggil `Close()` pada writer stdin pipe. Jika tidak ditutup, FFmpeg tidak menerima sinyal `EOF` dan akan menunggu (hang) selamanya.
3. **Timeout Graceful Cancellation OS Signal:** Pada OS Linux, membunuh exec via context melemparkan `SIGKILL` instan, membuat video yang sedang ditulis terpotong korup. Pada sistem high-end, disarankan menggunakan `cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }` dan memberi `WaitDelay` selama 5 detik bagi FFmpeg menulis trailer MP4 dengan baik.

## Kapan JANGAN Pakai Ini

- **Transcoding sinkron dalam permintaan HTTP.** Satu video bisa memakan menit sampai jam CPU. Ini pekerjaan latar dengan pelacakan kemajuan, tanpa pengecualian.
- **Menjalankan FFmpeg lewat shell dengan argumen dari input pengguna.** Nama berkas yang mengandung karakter khusus menjadi command injection. Selalu `exec.Command` dengan argumen terpisah.
- **Tanpa timeout dan batas sumber daya per pekerjaan.** Berkas masukan yang rusak bisa membuat FFmpeg berjalan tanpa henti dan menghabiskan CPU seluruh node.
- **Tanpa memvalidasi masukan sebelum diproses.** Berkas media adalah format kompleks dari sumber tidak tepercaya; probe dulu, tolak yang tidak masuk akal sebelum menghabiskan CPU untuknya.
- **Menyimpan hasil transcoding tanpa strategi kedaluwarsa.** Beberapa varian bitrate per video mengalikan biaya penyimpanan, dan sebagian besar varian jarang diakses.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Node CPU penuh oleh satu pekerjaan | timeout dan batas per pekerjaan | Pekerjaan tanpa batas |
| Antrean transcoding menumpuk | kapasitas vs laju unggahan | Kapasitas tidak sebanding |
| Proses FFmpeg yatim | pembersihan proses anak | Anak tidak mati bersama induk |
| Biaya penyimpanan tumbuh cepat | jumlah varian per video | Tidak ada kedaluwarsa varian |
| Perintah dijalankan dengan argumen tak terduga | apakah lewat shell | Command injection |

```bash
# Proses FFmpeg yang berjalan lebih lama dari yang wajar
ps -eo pid,etimes,cmd | awk '/ffmpeg/ && $2 > 3600'

# Antrean dan durasi pekerjaan
curl -s localhost:9090/metrics | grep -E 'transcode_(queue_depth|duration_seconds|failed_total)'

# Validasi masukan SEBELUM menghabiskan CPU
ffprobe -v error -show_entries format=duration,size,format_name -of json masukan.mp4

# Proses yatim setelah pod dihapus
kubectl exec <pod> -- ps -ef | grep -c ffmpeg
```
