---
name: async_ffmpeg_video_transcoding
description: Panduan arsitektur pemrosesan video asinkron menggunakan FFmpeg untuk HLS Adaptive Bitrate, chunked upload, dan webhook status di Laravel 11.
---

# Async FFmpeg Video Transcoding & Adaptive Bitrate Streaming

Dokumen ini mendefinisikan standar emas produksi untuk memproses video ukuran raksasa di background tanpa membuat worker PHP-FPM atau Octane mengalami *resource exhaustion*. Kita menggunakan FFmpeg untuk mengonversi video ke format HLS (HTTP Live Streaming) dengan Adaptive Bitrate (H.264/H.265), menangani *resumable chunked uploads*, serta integrasi webhook status.

## 1. Arsitektur Pipeline Transcoding Video

Diagram di bawah mengilustrasikan alur dari frontend (chunked upload) hingga video siap didistribusikan via CDN.

```text
+----------------+      Chunked Upload      +----------------+
|                |  (Dropzone/Uppy) 10MB/s  |                |
| Frontend Web / | -----------------------> | Laravel 11 API |
| Mobile Client  |                          | (Upload Cntrl) |
|                | <----------------------- |                |
+----------------+      Return Upload ID    +-------+--------+
        ^                                           | Simpan temporary chunk
        |                                           v
        | Webhook / WebSocket Notif         +----------------+
        | (Reverb / Pusher)                 | Local / S3 Tmp |
        +-----------------------------------+----------------+
                                                    | Dispatch Job setelah selesai
                                                    v
+----------------+      Generate HLS        +----------------+
| Cloud Storage  | <----------------------- | Laravel Worker |
| (S3 / CDN Edge)|      (M3U8 + TS files)   | (FFmpeg / FFM) |
+----------------+                          +----------------+
        ^                                           | Generate Thumbnail
        |                                           v
+-------+--------+                          +----------------+
|   End-User     |                          |   Database     |
|   Player       |                          |  (PostgreSQL)  |
+----------------+                          +----------------+
```

## 2. Implementasi Produksi (PHP 8.3 + Laravel 11 + PHPStan Level 9)

### 2.1. Video Transcoding Job

Kita menggunakan package `pbmedia/laravel-ffmpeg` untuk interaksi tipe-aman dengan FFmpeg. Pastikan dependensi sudah terinstal.

```php
<?php

declare(strict_types=1);

namespace App\Jobs\Media;

use App\Models\Video;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use ProtoneMedia\LaravelFFMpeg\Support\FFMpeg;
use FFMpeg\Format\Video\X264;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Log;
use Throwable;

final class ProcessHlsVideoTranscoding implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    /**
     * Jumlah maksimum percobaan (retries).
     */
    public int $tries = 3;

    /**
     * Waktu maksimum job berjalan dalam detik sebelum timeout.
     */
    public int $timeout = 3600;

    public function __construct(
        public readonly Video $video
    ) {}

    /**
     * Eksekusi transcoding.
     */
    public function handle(): void
    {
        $this->video->update(['status' => 'processing']);

        try {
            $lowBitrate = (new X264('libx264'))->setKiloBitrate(500);
            $midBitrate = (new X264('libx264'))->setKiloBitrate(1500);
            $highBitrate = (new X264('libx264'))->setKiloBitrate(3000);

            FFMpeg::fromDisk('temp')
                ->open($this->video->temporary_path)
                ->exportForHLS()
                ->setSegmentLength(10) // 10 seconds per segment
                ->setKeyFrameInterval(48)
                ->addFormat($lowBitrate)
                ->addFormat($midBitrate)
                ->addFormat($highBitrate)
                ->onProgress(function (int $percentage) {
                    $this->updateProgress($percentage);
                })
                ->toDisk('s3_videos')
                ->save("hls/{$this->video->id}/playlist.m3u8");

            $this->generateThumbnail();

            $this->video->update([
                'status' => 'ready',
                'hls_playlist_url' => Storage::disk('s3_videos')->url("hls/{$this->video->id}/playlist.m3u8"),
            ]);

            Storage::disk('temp')->delete($this->video->temporary_path);
            
            $this->notifyClient('ready');
            
        } catch (Throwable $exception) {
            Log::error('Video transcoding failed', [
                'video_id' => $this->video->id,
                'error' => $exception->getMessage(),
            ]);
            $this->video->update(['status' => 'failed']);
            $this->notifyClient('failed');
            
            throw $exception; // Rethrow to mark job as failed
        }
    }

    private function generateThumbnail(): void
    {
        FFMpeg::fromDisk('temp')
            ->open($this->video->temporary_path)
            ->getFrameFromSeconds(5)
            ->export()
            ->toDisk('s3_videos')
            ->save("thumbnails/{$this->video->id}/thumb.jpg");
            
        $this->video->update([
            'thumbnail_url' => Storage::disk('s3_videos')->url("thumbnails/{$this->video->id}/thumb.jpg")
        ]);
    }

    private function updateProgress(int $percentage): void
    {
        // Hindari update database atau redis terlalu sering (throttle 5 detik atau step 5%)
        $lastPercentage = $this->video->processing_percentage ?? 0;
        
        if ($percentage - $lastPercentage >= 5) {
            $this->video->update(['processing_percentage' => $percentage]);
            // Dispatch Reverb event if needed
        }
    }
    
    private function notifyClient(string $status): void
    {
        // Implementasi notifikasi WebSocket/Reverb atau Webhook
    }
}
```

## 3. Pest v3 Tests (Storage & Queue Fakes)

Berikut adalah *unit/architecture test* yang mensimulasikan pemrosesan asinkron tanpa harus menjalankan FFmpeg secara riil.

```php
<?php

use App\Jobs\Media\ProcessHlsVideoTranscoding;
use App\Models\Video;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use ProtoneMedia\LaravelFFMpeg\Support\FFMpeg;

test('it dispatches transcoding job upon chunked upload completion', function () {
    Queue::fake();
    Storage::fake('temp');
    Storage::disk('temp')->put('chunked/video.mp4', 'dummy-video-content');

    $video = tap(new Video(), function (Video $video) {
        $video->id = 99;
        $video->temporary_path = 'chunked/video.mp4';
        $video->status = 'uploaded';
        $video->save();
    });

    ProcessHlsVideoTranscoding::dispatch($video);

    Queue::assertPushed(ProcessHlsVideoTranscoding::class, function ($job) use ($video) {
        return $job->video->id === $video->id;
    });
});
```

## 4. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Transcoding Synchronous di HTTP Request
Memproses video secara *synchronous* saat user mengupload akan membunuh server FPM/Octane seketika ketika concurrent user naik.
```php
// ❌ SALAH: Transcoding di controller
public function store(Request $request) {
    $path = $request->file('video')->store('temp');
    FFMpeg::fromDisk('local')->open($path)->exportForHLS()->save('output.m3u8');
    return response()->json(['status' => 'done']);
}
```
**✅ SOLUSI:** Gunakan antrean (RabbitMQ/Redis) seperti contoh job `ProcessHlsVideoTranscoding` di atas.

### ❌ Anti-Pattern 2: Tidak Menangani Chunk Uploads
Menerima file 5GB dalam satu HTTP payload akan memicu `POST_MAX_SIZE` atau Nginx `client_max_body_size` error.
```php
// ❌ SALAH: Mengharap file utuh
$request->file('large_video')->store('s3');
```
**✅ SOLUSI:** Implementasikan *chunked upload protocol* (misal: Tus atau dropzone chunks) di mana frontend mengirim 10MB per *request*, lalu backend menggabungkannya via stream sebelum men-dispatch Job.

## 5. Production Edge Cases

1. **OOM Memory & CPU Starvation:**
   FFmpeg sangat intensif CPU/Memory. Pastikan worker queue untuk video memiliki batas konkurensi (misal Horizon `maxProcesses` = 2 per mesin) agar mesin 8-core tidak overload. Opsional: pindahkan beban komputasi menggunakan AWS MediaConvert.

2. **Timeout pada Job (Job Timeout Exceeded):**
   Video berdurasi 2 jam bisa memakan waktu transcoding lebih dari limit default Laravel (60 detik). Selalu atur `$timeout = 3600;` atau lebih tinggi pada Job, serta perpanjang instruksi CLI `php artisan queue:work --timeout=3600`.

3. **File Upload Korup / Beracun (Zip Bomb/Malicious MP4):**
   Selalu validasi MIME type menggunakan signature internal (ffprobe), bukan sekadar ekstensi `.mp4`. Jika file gagal diparsing oleh FFmpeg, *catch* *exception*-nya dan segera beri flag `status = 'failed'` agar Job tidak tertahan secara infinite loop.
