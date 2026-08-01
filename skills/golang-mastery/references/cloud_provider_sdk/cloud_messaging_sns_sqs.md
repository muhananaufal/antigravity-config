# Cloud Messaging (SNS & SQS) Design Patterns

Arsitektur perpesanan asinkron menggunakan AWS Simple Notification Service (SNS) dan Simple Queue Service (SQS) adalah tulang punggung sistem Microservices berskala luas (seperti Gojek, Netflix).

## 1. Pola SNS → SQS Fan-Out

Pola ini sangat populer di mana satu Publisher mendistribusikan pesannya ke multi-Consumer secara independen tanpa menyadari berapa banyak consumer yang ada (Decoupling).

```ascii
                  +------> SQS Queue (Billing) ----> Go Worker A (Generate Invoice)
                  |
Publisher  -----> SNS Topic (Order_Created)
(Go Service)      |
                  +------> SQS Queue (Inventory) ----> Go Worker B (Minus Stock)
                  |
                  +------> SQS Queue (Email) ----> Go Worker C (Kirim Resi)
```

**Kelebihan**: Jika Go Worker B down/deploy/crash, queue B akan menampung pesan dengan aman. Worker A & C tidak terganggu sama sekali.

## 2. SNS Message Filtering Policy

Jangan men-deliver semua pesan `Order_Created` ke *setiap* SQS jika worker tersebut tidak butuh (membuang bandwidth & cost). 
Terapkan **SNS Subscription Filter Policy**.
Jika event berisi Atribut: `{"payment_method": ["credit_card"]}`, Worker *C (Email Bank)* hanya akan subscribe dengan filter spesifik, yang mana difilter di sisi SNS (Server AWS), tidak pernah dikirim (tidak kena cost SQS receive) dan aplikasi Go tidak perlu *If-Else ignore*.

## 3. SQS Standard vs FIFO Queue Trade-offs

| Aspek | Standard SQS | FIFO SQS (Berakhiran `.fifo`) |
|-------|-------------|-------------------------------|
| **Throughput**| Hampir tak terbatas | Up to 3.000 / 30.000 (High throughput mode) TPS |
| **Ordering** | "Best effort". Bisa out-of-order | **Dijamin** Berurutan persis (First In First Out) |
| **Duplikasi** | **Minimal sekali (At-Least-Once)**. Pesan BISA datang 2 kali! | **Tepat sekali (Exactly-Once)** |
| **Grup** | - | MessageGroupId (Concurrency Paralel dlm 1 antrean) |
| **Harga** | Lebih murah | Sedikit lebih mahal |

*Perhatian untuk Go Devs*: Standard SQS BISA memberikan 1 pesan 2 kali. Fungsi handler worker (Go struct / DB Query) HARUS bersifat **Idempoten**! (Menjalankan fungsi yang sama dua kali tidak akan merubah state (contoh, tidak menagih kartu kredit dua kali)).

## 4. Batch Processing (Optimalisasi Cost)

Membaca satu pesan `ReceiveMessage` per API Call dari Go = Biaya membengkak $0.40/juta request.
AWS mengizinkan *MaxNumberOfMessages* hingga 10 per request (Satu API Call). Jika Go worker mendelete pesan, gunakan `DeleteMessageBatch` juga. (1 API call delete = 10 pesan dihapus). 90% Cost Reduction!

```go
package messaging

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func DeleteBatch(ctx context.Context, client *sqs.Client, qURL string, handles []string) error {
	var entries []types.DeleteMessageBatchRequestEntry
	for i, h := range handles {
		entries = append(entries, types.DeleteMessageBatchRequestEntry{
			Id:            aws.String(fmt.Sprintf("msg_%d", i)),
			ReceiptHandle: aws.String(h),
		})
	}

	_, err := client.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{
		QueueUrl: aws.String(qURL),
		Entries:  entries,
	})
	return err
}
```

---

## Anti-Patterns & Best Practices

### ❌ BAD: Short Polling SQS di dalam Loop
`WaitTimeSeconds = 0`. Worker terus memanggil AWS API tiap millidetik padahal queue kosong. Akan membuang CPU instance Anda, log noise yang ekstrim, dan tagihan AWS API SQS miliaran rupiah.
```go
// ❌ ANTI-PATTERN
out, _ := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
    QueueUrl:        qUrl,
    WaitTimeSeconds: 0, // <--- BENCANA KEUANGAN
})
```

### ✅ GOOD: Long Polling 20 Detik
Menginstruksikan server SQS untuk menahan open-connection selama 20 detik, dan baru me-return jika pesan masuk, atau 20 detik habis. `WaitTimeSeconds: 20`.

### ❌ BAD: Tidak ada DLQ (Dead Letter Queue)
Pesan error tidak tertangani -> Visibility Timeout habis -> Pesan masuk lagi -> Go worker memprosesnya lagi -> Crash lagi. Infinite loop (*Poison Pill Message*).

### ✅ GOOD: DLQ Automation (IaC)
Konfigurasi `maxReceiveCount` (misal = 3) pada queue utama SQS (Redrive Policy).
Jika suatu pesan di-*Receive* 3 kali namun tidak di-Delete oleh aplikasi Go (karena panic/error logical), SQS secara otomatis melemparkan pesan itu ke DLQ. Engineer Ops bisa mengecek manual DLQ. Buat CloudWatch Alarm di DLQ jika jumlah record > 0.

---

## Edge Cases (Hardcore Architecture Problems)

1. **256KB Message Size Limit SQS**: Payload SQS (dan SNS) maksimal 256KB. Jika Worker A ingin mengirim PDF 5MB untuk diproses OCR di Worker B, kirim tidak bisa lewat SQS biasa.
   - **Workaround (Top 1%)**: Gunakan AWS SDK for Java Library *SQS Extended Client* atau replikasi logic tersebut di Golang! Worker A menyimpan file di S3, lalu mengirim JSON `{ "s3_bucket": "x", "s3_key": "x.pdf" }` ke SQS. Worker B mendengarkan SQS, lalu mendownload file sebenarnya dari S3, lalu delete SQS.
2. **Duplicate Messages (At-Least-Once Delivery)**: SQS Standard tidak menjamin single delivery. Jika Go Service B adalah Transfer Bank (menambah saldo), duplicate message sangat berbahaya. Gunakan `Idempotency Key` (Misal UUID Order dari SNS Message). Sebelum Go mengeksekusi SQL Update saldo, cek dulu apakah UUID Order tersebut sudah ada di tabel relasional `processed_events`. Jika sudah ada, langsung `DeleteMessage` dan Abaikan.
3. **Visibility Timeout vs Execution Time Mismatch**: `VisibilityTimeout` SQS diatur 30 detik. Worker Go Anda (misal Resize Video) ternyata memakan waktu 45 detik. Di detik ke 30, SQS menyangka worker Go Anda mati, dan SQS me-re-deliver video tsb ke Worker Go yang lain (Worker C). Efek: Server overload memproses dua video barengan. Go app harus rutin mengirim heartbeat `ChangeMessageVisibility` selama proses (Spawn 1 goroutine ping *background* untuk request tambahan 30 detik tiap detik ke-20).
4. **FIFO Queue Blocking (Message Group ID Stuck)**: Jika Anda memakai SQS FIFO, pesan dengan *MessageGroupId* yang sama (misal `user_id_101`) DIJAMIN berurutan. Tetapi jika Go memproses event 1 lambat / error / tak bisa di-ack, event 2 & 3 untuk `user_id_101` AKAN DIBLOKIR 100% dari pengiriman ke worker manapun (agar urutan tidak rusak). Hati-hati, jika DLQ tidak aktif, satu antrean untuk user tsb akan "Macet" selamanya.
5. **EventBridge Routing sebagai Ganti SNS**: Arsitektur modern (sejak 2019) menggeser Pub-Sub sederhana (SNS) menjadi Event-Driven Bus menggunakan *Amazon EventBridge*. Go SDK mendukung pengiriman *Custom Events* (JSON dinamis tanpa batas schema) ke EventBus, di mana rule AWS bisa men-filter regex, key/value deep JSON, dan routing event ke 20+ layanan AWS (Step Functions, Lambda, SQS, API tujuan) tanpa menulis kode fan-out.

## SQS Extended Client (Payload > 256KB)

Batas keras dari AWS untuk SNS/SQS adalah **256KB**. Jika Anda butuh mengirim payload (misal: JSON transaksi raksasa berukuran 2MB), gunakan konsep *Extended Client* yang mengandalkan Amazon S3.

**Cara Kerja di Go:**
1. Sebelum memanggil `sqs.SendMessage`, cek apakah `len(payload) > 256 * 1024`.
2. Jika iya, upload payload asli ke S3 (`PutObject`).
3. Kirim pesan ke SQS yang isinya pointer JSON: `{"s3_bucket": "x", "s3_key": "uuid"}`
4. Di worker Go (Consumer), saat menerima SQS, periksa apakah formatnya pointer S3.
5. Unduh konten asli dari S3 (`GetObject`) dan proses.
6. Hapus object di S3 lalu `DeleteMessage` di SQS.

## SNS FIFO + SQS FIFO (Strict Ordering)

Jika Anda perlu Fan-out ke beberapa Consumer namun **URUTAN** harus dijamin 100% (misal: Event `Order_Created` -> `Order_Paid` -> `Order_Shipped`), gunakan SNS `.fifo` topic dan SQS `.fifo` queue.
Penting: Pesan hanya dijamin urutannya dalam satu `MessageGroupId`.

## EventBridge Pipes

Fitur AWS terbaru yang menghubungkan SQS langsung ke Target (Step Functions, API tujuan, Kinesis) TANPA menulis function Lambda / Go Worker manual. Go worker hanya perlu dibuat untuk fungsi *Enrichment* opsional (mengubah format payload di tengah jalan), sedangkan proses polling dan delivery ditangani AWS.

## Message Deduplication ID vs Group ID di FIFO

- **MessageGroupId**: Pengelompokan urutan. Pesan grup A dan B bisa diproses berbarengan secara paralel. Pesan di dalam grup A diproses serial berurutan.
- **MessageDeduplicationId**: AWS menggunakan string ini untuk mencegat pengiriman *duplicate message* dalam jendela 5 menit (mencegah *At-Least-Once* menjadi *Exactly-Once*). Wajib diset di Go SDK jika Deduplication berbasis Konten (Content-based deduplication) dinonaktifkan di setelan antrean.

## Go Code: Delete Batch & Visibility Extension

Visibility extension manual harus dilakukan dengan goroutine *ping* asinkron.

```go
func extendVisibility(ctx context.Context, client *sqs.Client, qURL, handle string) {
    ticker := time.NewTicker(20 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return // Task selesai, hentikan perpanjangan
        case <-ticker.C:
            client.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
                QueueUrl:          aws.String(qURL),
                ReceiptHandle:     aws.String(handle),
                VisibilityTimeout: 30, // Perpanjang 30s ke depan
            })
        }
    }
}
```

---

## Edge Cases & Anti-Patterns Tambahan

### ❌ ANTI-PATTERN: `ReceiveMessage` tanpa `WaitTimeSeconds` di Cloud Run/Lambda
Melakukan polling SQS dari HTTP request trigger (Serverless). Jika Anda men-spawn container baru hanya untuk mengambil dari SQS, latensi eksekusi menjadi tidak tertebak. Gunakan Event-Source Mapping dari AWS agar AWS yang mem-poll SQS lalu nge-push payload tersebut ke Lambda secara otomatis!

### Edge Cases Tambahan
6. **Lambda SQS Event-Source Mapping Concurrency Limit**: Lambda akan otomatis scale-up worker (container) secara drastis saat antrean SQS panjang. Jika Lambda Anda memanggil Database relasional (Postgres) yang memiliki limit koneksi max 100, Lambda yang scale ke 1000 concurrent worker akan men-DDoS (menumbangkan) DB Anda dengan error *Too many connections*. Anda HARUS men-set `ReservedConcurrentExecutions` pada Lambda (misal 50) untuk men-throttle pengambilan dari antrean. SQS akan menahan pesan dengan aman sementara DB terselamatkan.
7. **In-Flight Messages Limit SQS FIFO**: Berbeda dengan SQS Standard (120,000), limit maksimum *in-flight* (terbaca tapi belum didelete) pada SQS FIFO secara tegas dibatasi di **20,000** pesan. Jika consumer lambat memproses dan menimbun acking (misal sengaja menahan visibility via extension goroutine lama), di 20.000 sistem akan mogok tidak bisa receive pesan baru.

## 6. SQS Consumer Best Practices di Go

Arsitektur consumer SQS produksi membutuhkan beberapa *pattern* berbarengan: Long Polling, Batching, Goroutines pool, dan Graceful Shutdown.

```go
func StartConsumer(ctx context.Context, client *sqs.Client, queueURL string) {
	for {
		select {
		case <-ctx.Done(): // Signal Graceful Shutdown (SIGINT/SIGTERM)
			log.Println("Shutting down consumer...")
			return
		default:
			// 1. Long Polling Batch
			out, err := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
				QueueUrl:            aws.String(queueURL),
				WaitTimeSeconds:     20,
				MaxNumberOfMessages: 10,
			})
			if err != nil {
				time.Sleep(2 * time.Second) // Backoff
				continue
			}
            
            // 2. Process
			var wg sync.WaitGroup
			successHandles := make([]string, 0, len(out.Messages))
			var mu sync.Mutex

			for _, msg := range out.Messages {
				wg.Add(1)
				go func(m types.Message) {
					defer wg.Done()
                    // 3. Visibility Extension asinkron
					extendCtx, cancelExt := context.WithCancel(ctx)
					defer cancelExt()
					go extendVisibility(extendCtx, client, queueURL, *m.ReceiptHandle)

                    // 4. Actual Work
					if err := processEvent(*m.Body); err == nil {
						mu.Lock()
						successHandles = append(successHandles, *m.ReceiptHandle)
						mu.Unlock()
					}
				}(msg)
			}
			wg.Wait()

            // 5. Batch Delete (Atasi Limit Biaya)
			if len(successHandles) > 0 {
				DeleteBatch(context.Background(), client, queueURL, successHandles) // context terpisah agar delete tuntas meski app dimatikan
			}
		}
	}
}
```
Ini memastikan worker Golang aman dari pembekuan (*zombie process*) dan tidak pernah mensisakan *in-flight message* tanpa menghapusnya.
