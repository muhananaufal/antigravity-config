# Cloud Storage Patterns (S3 / GCS) di Golang

> **Berlaku:** Go 1.21+ · S3 / GCS · **Lihat juga:** `cloud_provider_sdk/aws_sdk_go_v2.md` · `media_asset_pipeline/govips_jit_image_engine.md` · `caching_strategy/http_cdn_caching.md` · `security_owasp/audit_logging_scrubbing.md`

Bekerja dengan Cloud Storage (AWS S3, Google Cloud Storage, Azure Blob) dalam Golang membutuhkan pemahaman mendalam tentang manajemen memori (`io.Reader` / `io.Writer`) dan batasan jaringan. 

## 1. Multipart Upload (S3/GCS) >5MB

Mengunggah file besar (video, log dump, DB backup) dalam satu request HTTP tunggal sangat rentan terputus (TCP reset) dan butuh RAM besar jika tidak hati-hati. 

**Solusi:** Multipart Upload. File dipecah menjadi *chunk* kecil (minimal 5MB di AWS), di-upload secara paralel (concurrency goroutines), lalu disatukan (*Complete*) di server cloud.

```ascii
+----------+      1. Initiate Multipart       +------------+
|  Client  | -------------------------------> |   Cloud    |
|   (Go)   |      2. Upload Part 1 (5MB)      |  Storage   |
|          | -------------------------------> | (S3/GCS)   |
|          |      2. Upload Part N (5MB)      |            |
|          | -------------------------------> |            |
|          |      3. Complete Multipart       |            |
|          | -------------------------------> | (Assembled)|
+----------+                                  +------------+
```

Di Go AWS SDK v2, `manager.Uploader` otomatis menangani split chunk ke stream memory kecil (buffer pool) tanpa meload seluruh file 50GB ke RAM (dengan catatan Anda mempassing tipe `io.Reader` yang streamable, bukan `[]byte` hardcode).

## 2. Streaming Download dengan `io.Reader`

Jangan pernah me-load *seluruh isi object* ke tipe `[]byte` atau `string` jika melayani user download, karena RAM Container/Pod Anda akan meledak (OOM).

Gunakan `io.Copy` untuk mentransfer (piping) byte langsung dari socket TCP download S3 ke socket TCP HTTP client (User Response).

```go
func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	// ... (Setup SDK GetObject)
	result, err := s3Client.GetObject(ctx, &s3.GetObjectInput{...})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer result.Body.Close()

	w.Header().Set("Content-Disposition", "attachment; filename=file.zip")
	w.Header().Set("Content-Type", *result.ContentType)
	
	// Stream LANGSUNG ke HTTP Response user, RAM usage konstan (< 100 KB)
	io.Copy(w, result.Body)
}
```

## 3. Presigned URL Generation & Expiry Strategy

Generate link sementara agar user direct-download tanpa proxying lewat backend.
- Keamanan: Set expiry minimal (1-15 menit). Jangan cache URL selamanya.
- Content-Disposition: Anda bisa memaksa presigned URL me-return response dengan header download (Save As) via `ResponseContentDisposition` overrides.

## 4. Object Versioning & Lifecycle Policies

- **Versioning**: Simpan objek lama jika tertimpa (overwrite). Melindungi dari ransomware/human error penghapusan. (Storage cost membengkak).
- **Lifecycle Policies**: Solusi pembengkakan. Atur di level IaC (Terraform) agar Cloud otomatis mendelete file "Versioned/NonCurrent" di atas 30 hari, atau mengubahnya ke kelas storage sangat murah (S3 Glacier / GCS Coldline). Aplikasi Go tidak perlu menghapus file secara cron/manual.

## 5. Client-Side Encryption (Envelope Encryption)

Di sistem berkeamanan tinggi (Fintech/Medis), data pasien tidak boleh plain-text di Cloud (Bahkan SSE S3 Managed Keys masih kurang jika karyawan Cloud bisa akses). Lakukan *Envelope Encryption* di memori Go (AES-GCM 256) SEBELUM data di `io.Copy` ke upload manager SDK. 
Gunakan *AWS Crypto SDK for Go* untuk keamanan standar militer yang transparent terhadap stream Reader.

---

## Anti-Patterns & Best Practices

### ❌ BAD: `os.ReadFile` atau Load ke RAM
Memaksa file log 3GB di-load ke RAM dengan `os.ReadFile` lalu passing slice byte (OOM Kill langsung pada container RAM 1GB).

```go
// ❌ ANTI-PATTERN: Container OOM Killed!
data, _ := os.ReadFile("db_backup_50GB.sql") 
s3.PutObject(ctx, &s3.PutObjectInput{Body: bytes.NewReader(data)}) 
```

### ✅ GOOD: Pass `os.File` pointer
Implementasi `os.File` memenuhi interface `io.ReadSeeker` yang efisien. SDK membacanya chunk demi chunk.
```go
// ✅ BEST PRACTICE: RAM usage stabil
file, _ := os.Open("db_backup_50GB.sql")
defer file.Close()
manager.NewUploader(...).Upload(ctx, &s3.PutObjectInput{Body: file})
```

### ❌ BAD: No Retry pada Part Upload 
Menulis custom multipart upload manual tapi tidak ada retry (exponential backoff) pada satu chunk kecil yang gagal karena network blink. Mengakibatkan gagalnya file 100GB karena chunk 1MB gagal. (Gunakan Uploader bawaan SDK!).

---

## Edge Cases

1. **Upload Resume Setelah Network Failure**: Jika app Go mati tengah upload file 50GB di part ke 75, apakah harus diulang dari awal? Jika pakai Uploader bawaan, IYA (karena ia fire & forget statenya). Untuk resumeable upload, catat token `UploadId` dari MultipartUpload S3 di Database Relasional lokal, lalu saat app Go restart, lakukan resume pada part yang belum masuk. (GCS Client API Go memiliki resumable session URL bawaan `gcsWriter.ChunkSize`).
2. **Cross-Region Replication Lag (Read-After-Write Fail)**: Upload avatar via S3 US-East (Primary). User me-refresh web yang menarik CDN CloudFront yang pointing ke S3 EU-West (Replika). CDN me-return 404 (Not Found) karena replikasi S3 *Cross Region* bersifat *Asynchronous/Eventual* dan butuh 1-3 detik. Aplikasi Go harus cerdas me-return image object dari Primary bucket sementara jika diakses kurang dari 10 detik.
3. **Content-Type Auto Detection**: Jika app Go tidak meng-set `ContentType` saat SDK PutObject, S3 mensetnya menjadi `binary/octet-stream`. Saat user klik link URL file tsb, Browser tidak akan bisa merender PDF/HTML/Image nya (akan memaksa download "Save As"). Selalu gunakan `http.DetectContentType([]byte)` pada 512 bytes pertama file (sebelum diupload), lalu pass ke `PutObjectInput.ContentType`.
4. **Data Race pada Stream Reader**: Goroutine utama menerima HTTP body Upload `r.Body`. Jika `r.Body` ini di pass mentah-mentah ke aws-SDK untuk di-upload, aws-SDK mungkin akan men-spawn banyak concurrency `Read()` (pada multipart upload v2). `http.Request.Body` BUKAN *thread-safe concurrent reader*. SDK akan error atau data corruption.
5. **Slow Loris / Rate Limiting PutObject**: Mengirim request PUT `GetObject/PutObject` di atas batas Prefix S3 limit (3,500 PUT/sec, 5,500 GET/sec). Jika sistem Golang Anda trafficnya 10.000 TPS mengakses *Key Prefix (folder)* S3 yang sama misal `s3://bucket/2026/img/`, AWS S3 akan men-throttle `503 Slow Down`. Workaround Top 1%: Tambahkan random string HASH di *depan* nama file object (contoh: `s3://bucket/8f2c-2026/img/`) sehingga terdistribusi rata ke partisi backend S3.

## 6. S3 Transfer Acceleration & Byte-Range Fetch

**Transfer Acceleration**: S3 mendukung endpoint khusus `(bucket.s3-accelerate.amazonaws.com)` yang menggunakan jaringan Edge (CloudFront) global AWS. Ini mempercepat upload dari user di India ke S3 di US hingga 300%. Di Go SDK, cukup nyalakan flag *UseAccelerateEndpoint*.

**Byte-Range Fetch**: Saat mengunduh object 100GB (misal video 4K), jangan gunakan single GET. Gunakan atribut HTTP `Range: bytes=0-4999999` di header `GetObjectInput` dengan concurrency Goroutine. SDK v2 mempermudah ini dengan *S3 Download Manager*.

## 7. Client-Side Encryption Detail & KMS GenerateDataKey

Dalam pola Envelope Encryption:
1. Go app memanggil AWS KMS `GenerateDataKey` (mendapat plain key dan encrypted key).
2. Go menggunakan AES-GCM 256 memori (menggunakan plain key) untuk mengenkripsi file yang akan diupload.
3. Plain key di-*zeroized* dari memori (sangat kritis, timpa slice dengan byte `0` agar tak diretas via memory dump).
4. Hasil enkripsi file diupload ke S3 beserta *Encrypted Key* dari KMS (disimpan di Metadata header HTTP S3 `x-amz-meta-kms-key`).
5. Saat download, Go read metadata, dekrip encrypted key ke KMS, lalu AES dekripsi file.

## 8. S3 Inventory & Lifecycle Policy Automation

- **S3 Inventory**: Jika bucket memiliki miliar objek, memanggil API `ListObjectsV2` akan memakan waktu berminggu-minggu (dan biaya tinggi). Gunakan fitur *S3 Inventory* untuk AWS men-dump file CSV/Parquet otomatis per hari berisi seluruh daftar isi bucket + metadatanya.
- **Lifecycle SDK**: `client.PutBucketLifecycleConfiguration` bisa digunakan untuk men-deploy lifecycle programatis (memindah ke Glacier/DeepArchive).

---

## Edge Cases & Anti-Patterns Tambahan

### ❌ ANTI-PATTERN: `io.Copy` ke File Lokal Tanpa Limitasi Buffer
Bahkan saat menggunakan `io.Copy` yang efisien ke `os.File`, Goroutine I/O dapat memblokir proses lain bila network terlalu cepat namun SSD Disk terlalu lambat. Lebih parah lagi, hacker bisa mensimulasikan upload file 10 TB dan menyebabkan disk full `No space left on device` (Denial of Service).
✅ **Solusi**: Bungkus `Body` request upload dengan `io.LimitReader` (maks misal 5GB) sebelum membacanya.

### Edge Cases Tambahan
6. **Concurrent Multipart Upload (ErrGroup) Deadlock**: Developer Go menggunakan `golang.org/x/sync/errgroup` untuk concurrency download/upload *parts* S3 manual. Jika buffer channel terlalu kecil atau salah passing context `ctx` dari errgroup (ter-cancel di 1 goroutine menyebabkan panic down keseluruhan system), upload berhenti. *Best practice*: gunakan implementasi Uploader/Downloader manajer dari AWS SDK yang telah diuji secara thread-safe dari *race conditions* dan *deadlocks*.
7. **S3 Versioning Delete Marker Trap**: Pada bucket yang Versioning-nya aktif, memanggil `s3.DeleteObject` pada sebuah key TIDAK MENGHAPUS isinya. AWS hanya menambahkan "Delete Marker" objek berukuran nol bytes di atasnya. File asli masih tetap ada dan memakan biaya storage 100%. Untuk mendelete bersih, Anda *harus* memanggil delete spesifik pada Version ID nya (`DeleteObjectInput{VersionId: "..."}`).
8. **MIME Type Sniffing & XSS Security**: Jangan pernah langsung menggunakan output `http.DetectContentType` sebagai kebenaran mutlak. Teks `HTML` yang ditanamkan macro (XSS payload) berkedok gambar bisa menipu detector Golang. S3 yang men-serve `.html` file akan mengeksekusi XSS di browser client. Terapkan Validasi ekstensif, Sanitizer, dan gunakan Content-Security-Policy (CSP) / pre-signed URL header overrides (Force download / `Content-Type: application/octet-stream`).

## 6. Concurrent Multipart Upload dengan errgroup

Saat menangani part upload manual (tanpa uploader SDK v2), sangat direkomendasikan untuk menggunakan `errgroup` guna memaksimalkan bandwidth. Setiap `Part` dari objek dibaca dan dikirim ke S3 secara paralel (concurrency limit).

```go
package storage

import (
	"context"
	"io"
	"golang.org/x/sync/errgroup"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func uploadPartsConcurrently(ctx context.Context, client *s3.Client, bucket, key, uploadID string, chunks [][]byte) error {
	eg, egCtx := errgroup.WithContext(ctx)
	eg.SetLimit(10) // Maks 10 upload paralel
	
	// Untuk menyimpan ETag dari tiap part agar bisa di complete
	completedParts := make([]types.CompletedPart, len(chunks))

	for i, chunk := range chunks {
		i, chunk := i, chunk
		eg.Go(func() error {
			partNumber := int32(i + 1)
			res, err := client.UploadPart(egCtx, &s3.UploadPartInput{
				Bucket:     &bucket,
				Key:        &key,
				PartNumber: &partNumber,
				UploadId:   &uploadID,
				Body:       bytes.NewReader(chunk),
			})
			if err != nil {
				return err
			}
			
			// Track Part Number dan ETag untuk CompleteMultipartUpload
			completedParts[i] = types.CompletedPart{
				ETag:       res.ETag,
				PartNumber: &partNumber,
			}
			return nil
		})
	}
	
	if err := eg.Wait(); err != nil {
		// Jika errgroup gagal (ada 1 error), otomatis panggil AbortMultipartUpload
		client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{...})
		return err
	}
	
	// Sukses semua, lengkapi
	// client.CompleteMultipartUpload(...)
	return nil
}
```

- **Progress Tracking**: Bisa disisipkan increment atomic counter pada errgroup closure.
- **Checksum**: Di AWS SDK v2 terbaru, verifikasi checksum (misal SHA256) per-part upload diaktifkan agar tidak ada file korup (bit flip) saat transit.

## 6. S3 Byte-Range Parallel Download

Untuk mengunduh file berukuran sangat besar (misal 1GB) dengan latensi minimal, kita bisa menggunakan teknik pemotongan byte (Byte-Range Fetch) secara paralel menggunakan `errgroup`. Ini sangat berguna jika bandwidth aplikasi lebih besar dari limitasi per-koneksi S3, karena kita memecah 1 file besar menjadi 8 bagian koneksi yang diunduh secara bersamaan.

### Konsep dan Praktik Terbaik
- **Header `Range`**: Meminta HTTP request secara eksplisit dengan format `Range: bytes=0-134217727` (untuk rentang byte part tertentu).
- **Goroutines + errgroup**: Meluncurkan goroutine sejumlah *concurrent parts* yang diinginkan (misal 8 part) secara asinkron.
- **Reassemble (Penyatuan)**: Karena part selesai secara acak, kita harus menampungnya pada posisi yang benar di dalam file tujuan lokal, biasanya menggunakan `io.WriterAt` (diimplementasikan oleh `os.File` lewat `WriteAt`).
- **Progress Reporting**: Melaporkan progress bisa dilakukan menggunakan tipe `io.Reader` kustom pembungkus body atau melalui mekanisme atomic counter.

### Contoh Kode: Parallel Download (8 Parts)

```go
package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync/atomic"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"golang.org/x/sync/errgroup"
)

// ParallelDownload mengunduh file S3 1GB dalam 8 part concurrent
func ParallelDownload(ctx context.Context, client *s3.Client, bucket, key string, destPath string, fileSize int64) error {
	const numParts = 8
	partSize := fileSize / numParts

	file, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("failed to create destination file: %w", err)
	}
	defer file.Close()

	eg, egCtx := errgroup.WithContext(ctx)
	var downloadedBytes int64 // Untuk progress reporting

	for i := 0; i < numParts; i++ {
		partIndex := i // assign copy for goroutine closure
		eg.Go(func() error {
			start := int64(partIndex) * partSize
			end := start + partSize - 1
			// Part terakhir harus mencakup sisa byte
			if partIndex == numParts-1 {
				end = fileSize - 1
			}

			// 1. Minta rentang byte secara spesifik
			byteRange := fmt.Sprintf("bytes=%d-%d", start, end)
			
			getObjInput := &s3.GetObjectInput{
				Bucket: aws.String(bucket),
				Key:    aws.String(key),
				Range:  aws.String(byteRange),
			}

			res, err := client.GetObject(egCtx, getObjInput)
			if err != nil {
				return fmt.Errorf("part %d get failed: %w", partIndex, err)
			}
			defer res.Body.Close()

			// Pastikan Server mendukung dan merespon dengan status 206 Partial Content
			if res.ContentLength == 0 {
				return fmt.Errorf("part %d returned empty content", partIndex)
			}

			// Baca isi part (buffer)
			bodyBytes, err := io.ReadAll(res.Body)
			if err != nil {
				return fmt.Errorf("part %d read failed: %w", partIndex, err)
			}

			// 2. Tulis secara konkuren ke disk di posisi Offset yang tepat
			if _, err := file.WriteAt(bodyBytes, start); err != nil {
				return fmt.Errorf("part %d write failed: %w", partIndex, err)
			}

			// Progress reporting
			atomic.AddInt64(&downloadedBytes, res.ContentLength)
			fmt.Printf("Progress: %d / %d bytes\n", atomic.LoadInt64(&downloadedBytes), fileSize)

			return nil
		})
	}

	if err := eg.Wait(); err != nil {
		return fmt.Errorf("parallel download failed: %w", err)
	}

	return nil
}
```

### Edge Case: Partial Content (HTTP 206 vs 200)

**Masalah:**
Terkadang, proxy perantara, cache jaringan, atau server yang tidak mendukung header `Range` akan mengabaikan header `Range: bytes=0-134217727` dan malah mengembalikan **seluruh isi file** dengan status HTTP `200 OK` (bukannya `206 Partial Content`).

**Dampak:**
Jika kode Go Anda tidak mengecek hal ini, setiap goroutine `Part` akan mengunduh seluruh file 1GB ke memori secara penuh. Dengan 8 goroutine, aplikasi Go akan mendadak menarik 8GB dari memori RAM, yang seketika menyebabkan aplikasi *OOM (Out of Memory) Crash*!

**Defensive Programming:**
Selalu validasi status kode atau Content-Length respons sebelum membaca `Body`.

```go
// Di dalam goroutine, pastikan mengecek apakah response benar-benar part yang diminta
if res.ContentLength > (partSize * 2) {
	// Fallback/Reject: Server tampaknya membalas dengan status 200 OK penuh,
	// batalkan request dan gunakan metode download single-stream tradisional.
	return fmt.Errorf("server did not respect byte range, received full %d bytes", res.ContentLength)
}
```

## Kapan JANGAN Pakai Ini

- **Untuk akses acak berfrekuensi tinggi.** Latensi object storage adalah puluhan milidetik per objek. Sebagai pengganti database atau cache, ia akan selalu mengecewakan.
- **Menyimpan sangat banyak objek kecil.** Biaya per permintaan mendominasi biaya penyimpanan, dan operasi listing menjadi sangat lambat. Gabungkan objek kecil sebelum menyimpannya.
- **Presigned URL berumur panjang.** Ia adalah **kredensial yang bisa diteruskan siapa saja** — dibagikan lewat pesan, tersimpan di riwayat browser, terindeks bila bocor ke halaman publik. Umurnya harus sependek yang bisa diterima alur kerjanya.
- **Mengandalkan listing untuk menemukan objek.** Listing mahal, dan pada sebagian penyedia bersifat eventually consistent. Simpan indeks objek di database yang Anda kendalikan.
- **Multipart upload tanpa membersihkan bagian yang gagal.** Bagian yang tertinggal tetap ditagih selamanya dan tidak terlihat pada listing objek biasa.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Biaya penyimpanan tidak sesuai ukuran data | multipart upload yang belum selesai | Bagian gagal tidak pernah dibersihkan |
| Biaya API mendominasi tagihan | jumlah objek dan permintaan | Terlalu banyak objek kecil |
| Objek yang baru ditulis tidak ditemukan | apakah bergantung pada listing | Konsistensi listing tidak dijamin |
| URL lama masih bisa dipakai | masa berlaku presigned URL | Umur URL terlalu panjang |
| Latensi tidak membaik meski di-cache | pola akses | Object storage dipakai sebagai database |

```bash
# Multipart upload yang menggantung -- ditagih tapi tak terlihat di listing biasa
aws s3api list-multipart-uploads --bucket data-produksi \
  --query 'Uploads[?Initiated<`2026-08-01`].[Key,Initiated]' --output table

# Jumlah objek dan ukurannya
aws s3 ls s3://data-produksi --recursive --summarize | tail -3

# Aturan lifecycle: pembersihan otomatis harus ada, bukan manual
aws s3api get-bucket-lifecycle-configuration --bucket data-produksi

# Akses publik yang tidak disengaja
aws s3api get-public-access-block --bucket data-produksi
```
