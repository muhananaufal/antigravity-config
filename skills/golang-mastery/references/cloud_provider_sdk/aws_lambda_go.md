# AWS Lambda dengan Golang

AWS Lambda dengan Go sangat cepat dan stabil karena Go di-compile menjadi *static binary* (Cold Start < 200ms). Pada arsitektur custom runtime Amazon Linux 2 (`provided.al2`), Go binaries merupakan salah satu bahasa terbaik untuk serverless.

## Arsitektur Lambda (Init Phase vs Handler Phase)

Lifecycle Lambda terdiri dari 3 fase:
1. **Init**: AWS men-download kode Anda, membuat env eksekusi, dan menjalankan fungsi `init()` atau blok kode *di luar* fungsi handler. Waktu init (maks 10 detik) **tidak ditagih** (gratis) sebelum AWS ubah policy, sekarang ditagih jika Provisioned Concurrency, namun tetap merupakan waktu yang tepat untuk setup.
2. **Invoke**: Menjalankan fungsi handler. (Maks 15 menit, ditagih per milidetik).
3. **Shutdown**: Freeze (pembekuan) eksekusi.

```ascii
      Cold Start                                 Warm Start (Re-used)
+-----------------------+                    +-----------------------+
|  Boot Custom Runtime  |                    |                       |
+-----------------------+                    |                       |
|   Run global/init()   | <--- DB Connect    |                       |
+-----------------------+                    |                       |
|   Execute Handler()   | <--- API Call      |   Execute Handler()   | <--- API Call (Fast)
+-----------------------+                    +-----------------------+
```

---

## 1. AWS Lambda Go Handler Patterns

Package `github.com/aws/aws-lambda-go/events` memiliki *struct definitions* untuk SEMUA tipe trigger dari AWS.

### API Gateway Proxy Request

Menangani HTTP REST request yang diteruskan oleh API Gateway.

```go
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

type ResponseBody struct {
	Message string `json:"message"`
}

func handler(ctx context.Context, req events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	// 1. Ekstrak data dari path/query params
	id := req.PathParameters["id"]

	// 2. Logic aplikasi
	res := ResponseBody{Message: "User " + id}
	bodyJson, _ := json.Marshal(res)

	// 3. Return JSON response
	return events.APIGatewayProxyResponse{
		StatusCode: http.StatusOK,
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
		Body: string(bodyJson),
	}, nil
}

func main() {
	lambda.Start(handler)
}
```

### SQS Event Batch Handler

Lambda dapat membaca batch pesan dari SQS dan otomatis melakukan retries/deletion jika kita return error secara parsial.

```go
import (
	"context"
	"github.com/aws/aws-lambda-go/events"
)

func sqsHandler(ctx context.Context, sqsEvent events.SQSEvent) error {
	for _, message := range sqsEvent.Records {
		// Proses pesan satu per satu
		processMessage(message.Body)
	}
	return nil // Jika return nil, otomatis semua pesan dihapus dari antrean
}
```

---

## 2. Cold Start Optimization (Global Init & Binary Size)

Go sudah sangat cepat, tetapi bisa ditingkatkan dengan:

1. **Lazy Initialization di Global Scope**:
Buka koneksi DB di global context (init phase), tapi cek pointer nil agar tidak panic.

2. **Binary Size Reduction**:
Kecilkan ukuran file zip agar Lambda lebih cepat men-download-nya dari S3.
Build command dengan LDFLAGS (stripping symbol table):
```bash
GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -tags lambda.norpc -o bootstrap main.go
```
Kecilkan size file hingga 40-50%. Penggunaan tag `-tags lambda.norpc` khusus untuk Lambda `provided.al2` untuk menghilangkan dependency RPC lama.

---

## 3. Advanced Features

### Lambda Extensions untuk Telemetry
Extensions berjalan berdampingan sebagai process terpisah dari *execution environment*. Digunakan untuk mengambil logs/metrics asinkron (Datadog/NewRelic agent) tanpa memblokir/menunda return HTTP response ke client!

### Function URLs
Fitur AWS (sejak 2022) di mana Lambda mendapat public HTTP(S) endpoint tanpa perlu setting API Gateway (Bebas biaya API Gateway). Cocok untuk webhook stripe, bots Telegram. Tipe kembalian yang digunakan adalah HTTP biasa (bukan Proxy API GW V1).

### Provisioned Concurrency
Jika aplikasi Go Anda adalah sistem Trading (HFT) yang menuntut *ZERO Cold Start latency spikes*, Anda dapat mengaktifkan Provisioned Concurrency. AWS menjaga pool VM tetap *warm*. (Sangat mahal!).

### ARM64 (Graviton2)
Ubah arsitektur Lambda dari x86_64 ke `arm64`. Anda mendapat diskon 20% biaya komputasi dan performa 19% lebih cepat untuk workload Golang! Cukup kompilasi silang: `GOARCH=arm64`.

---

## Anti-Patterns & Best Practices

### ❌ BAD: DB Connection di Handler
Membuka koneksi baru dan membuangnya pada *setiap* pemanggilan API HTTP (invoke).

```go
// ❌ ANTI-PATTERN: Tiap request buat koneksi (DDoS DB Anda sendiri)
func handler(ctx context.Context) (events.APIGatewayProxyResponse, error) {
    db, _ := sql.Open("postgres", "...")
    defer db.Close()
    db.Query("SELECT ...")
}
```

### ✅ GOOD: Init DB di Luar Handler
```go
// ✅ BEST PRACTICE: Re-use koneksi
var db *sql.DB

func init() {
    db, _ = sql.Open("postgres", "...")
}

func handler(ctx context.Context) {
    // gunakan db
}
```

### ❌ BAD: Mengabaikan Context Deadline
Context yang dipassing AWS ke handler memiliki `Deadline()` tepat sebelum Lambda Timeout (misal config 15 detik). Jika tidak dipassing ke HTTP client/DB eksternal, dan DB menggantung (network freeze), Anda akan bayar tagihan penuh 15 detik tanpa info error log selain "Task timed out after 15.01 seconds".

### ✅ GOOD: Teruskan Context
```go
func handler(ctx context.Context) error {
    // AWS otomatis cancel context jika mau timeout
    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil) 
}
```

---

## Edge Cases

1. **Panic Recovery & Lambda Retry**: Jika Lambda function mengalami `panic()` saat mengonsumsi event asinkron (SQS/SNS/EventBridge), AWS Lambda akan menganggapnya gagal dan melakukan retry (hingga batas MaxReceiveCount). Jika bug tsb deterministik, request akan terus `panic` (Poison Pill). Terapkan `defer func() { if r := recover(); ... }()` pada top level handler untuk graceful degradation dan report error ke Sentry tanpa me-trigger infinite loop.
2. **Lambda Concurrency Throttle**: Jika account limit (default 1000 concurrent executions) tersentuh, request API Gateway (synchronous) akan mendapat HTTP `429 Too Many Requests`. Tetapi request SQS (asynchronous) akan melempar pesan kembali ke antrean secara otomatis dengan exponential backoff (throtling).
3. **Ghost Goroutines**: Goroutine asinkron (misal kirim tracking event ke Kafka lewat channel) yang disisakan berjalan di backround setelah Handler return akan dibekukan (*Frozen*) saat fase Shutdown (AWS mensuspend CPU). Goroutine tersebut baru akan 'bangun' (dijeda waktu) saat Lambda tsb di-*invoke* lagi! Hal ini memunculkan error aneh (timeout koneksi tertunda). Di Lambda, JANGAN TINGGALKAN GOROUTINE di background. Gunakan ekstensi (Extension) atau block dengan WaitGroup.
4. **S3 Event vs Object Size**: S3 event trigger tidak memuat isi file objek, hanya metadatanya (key, size). Jika aplikasi di-trigger S3, Anda *harus* memanggil `s3.GetObject` di Go. Perhatikan RAM Lambda Anda (128MB - 10GB). Jika download file 1GB ke memory untuk diproses tanpa streaming/Reader, Lambda akan OOM (Out Of Memory) dan langsung *killed*.
5. **Partial Batch Failure SQS**: Jika di batch SQS Handler (10 record), ke-9 sukses dan 1 error. Di versi lama, me-return error menyebabkan KESEPULUH message di-redeliver dan diproses lagi (Duplicate). SDK Baru (dan AWS Config) mendukung *Report Batch Item Failures*. Anda bisa return struct khusus memberitahu AWS untuk hanya me-retry message/ID yang gagal saja.

---

## Unit Testing

Sangat mudah men-test Lambda, cukup jalankan function seperti golang function biasa dengan mempassing mock Context dan mock Request struct.

```go
func TestHandler(t *testing.T) {
	req := events.APIGatewayProxyRequest{
		PathParameters: map[string]string{"id": "123"},
	}

	res, err := handler(context.Background(), req)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.StatusCode != 200 {
		t.Errorf("expected 200, got %d", res.StatusCode)
	}
}
```

## Advanced Lambda Features (Lanjutan)

### Lambda Layers untuk Shared Dependencies
Jika Anda punya file statis besar (model ML, config timezone besar, library C/C++) atau binary Go kedua yang sering dipakai banyak function, gunakan **Lambda Layers**. Layer diekstrak ke direktori `/opt` saat runtime. Ini menghemat waktu build dan ukuran deployment package.

### Lambda SnapStart (Konsep)
*SnapStart* (saat ini eksklusif untuk Java/Python C-Python) melakukan *snapshot* state memori Firecracker microVM tepat setelah fase init selesai, lalu me-resume VM dari memory snapshot tersebut pada invocation berikutnya (meniadakan waktu Boot JVM). Untuk Golang, *Provisioned Concurrency* adalah alternatifnya, atau karena Go sudah sangat cepat (binary statis), SnapStart seringkali tidak dibutuhkan (Cold start Go murni hanya ~150ms).

### Konfigurasi Dead Letter Queue (DLQ) Lambda
Lambda memiliki *Asynchronous Invocation DLQ*. Jika trigger asinkron (EventBridge, S3) gagal diproses Lambda setelah 2 kali retries (default), AWS akan mengirim event payload tersebut ke antrean SQS atau SNS tujuan. Ini sangat kritis di set!

---

## Tambahan SQS Trigger Lambda

### SQS Batch Size & Bisect on Error
Konfigurasi `BatchSize` Lambda bisa diset hingga 10.000 (untuk SQS Standard). 
- **BisectBatchOnFunctionError**: Jika diaktifkan, saat function me-return error, AWS tidak akan me-retry seluruh batch, tetapi membelahnya jadi dua. Separuh diretry, separuh dipisah.
- **ReportBatchItemFailures**: Di Go, kembalikan struct *Partial Batch Failure* (seperti dibahas sebelumnya) untuk akurasi.

```go
type SQSBatchItemFailure struct {
	ItemIdentifier string `json:"itemIdentifier"`
}
type SQSBatchResponse struct {
	BatchItemFailures []SQSBatchItemFailure `json:"batchItemFailures"`
}

func handler(ctx context.Context, sqsEvent events.SQSEvent) (SQSBatchResponse, error) {
    failures := []SQSBatchItemFailure{}
    for _, record := range sqsEvent.Records {
        if err := process(record.Body); err != nil {
            failures = append(failures, SQSBatchItemFailure{ItemIdentifier: record.MessageId})
        }
    }
    return SQSBatchResponse{BatchItemFailures: failures}, nil
}
```

---

## Edge Cases & Anti-Patterns Tambahan

### ❌ ANTI-PATTERN: Sleep untuk Menunggu Proses Eksternal
Menggunakan `time.Sleep` di dalam Lambda untuk "polling" status dari external API.
Anda ditagih per *milidetik* waktu eksekusi. `time.Sleep(10 * time.Second)` membuang biaya $0.0002 tanpa melakukan apa-apa.
✅ **Solusi**: Gunakan AWS Step Functions untuk orkestrasi asinkron dengan status `Wait` (tidak memungut biaya per detik).

### Edge Cases Tambahan
6. **VPC Cold Start & ENI**: Jika Lambda di-attach ke VPC (untuk query RDS/ElastiCache pribadi), pada zaman dulu ada penalti cold start 10 detik. Sejak inovasi *Hyperplane ENI* di AWS, penalti ini hampir hilang, tetapi ENI limit per subnet masih berlaku. Jika traffic membludak, Lambda bisa gagal expand karena kehabisan IP address di subnet VPC.
7. **`/tmp` Storage State Bleed**: Direktori `/tmp` di Lambda (maks 10GB) *dipertahankan* antara warm invocations! Jika request A menulis file sensitif ke `/tmp/user.pdf` dan tidak menghapusnya, request B (user lain) pada container yang sama bisa membaca `user.pdf` milik request A. Selalu *delete* file di `/tmp` menggunakan `defer os.Remove(path)`.

## 6. SQS Trigger: Batch Processing & Partial Failure

Ketika Lambda di-trigger oleh SQS, Lambda platform berfungsi otomatis sebagai "Long Poller" tanpa kode SDK SQS `ReceiveMessage` sama sekali.

Jika batch size diset 10, fungsi Lambda akan menerima array 10 event. Jika di pertengahan ada yang gagal (misal index 5 error parse JSON) dan Anda me-*return `error`*, AWS SQS secara default akan mengasumsikan **KESEPULUH** event tsb gagal diproses (walaupun 9 lainnya sukses), dan me-redeliver 10 pesan lagi ke Lambda, mengakibatkan duplikasi.

### Solusi 1: Bisect on Error
Konfigurasi fitur AWS `BisectBatchOnFunctionError`. Jika error terjadi, AWS membagi batch 10 menjadi dua (batch 5 dan batch 5), mempermudah isolasi pesan "beracun" tanpa meredelivery terlalu banyak.

### Solusi 2: Partial Batch Response (Top 1% Practice)
Go struct `SQSBatchResponse` bisa dikembalikan untuk memberi tahu AWS mana item yang sukses dan mana yang gagal, sehingga hanya item gagal yang ditambahkan kembali ke SQS.

```go
type SQSBatchItemFailure struct {
	ItemIdentifier string `json:"itemIdentifier"`
}
type SQSBatchResponse struct {
	BatchItemFailures []SQSBatchItemFailure `json:"batchItemFailures"`
}

func handler(ctx context.Context, sqsEvent events.SQSEvent) (SQSBatchResponse, error) {
	var failures []SQSBatchItemFailure
	for _, record := range sqsEvent.Records {
		// Proses record individual
		if err := process(record.Body); err != nil {
			// Tambahkan ID record gagal, BUKAN mereturn error global Lambda
			failures = append(failures, SQSBatchItemFailure{ItemIdentifier: record.MessageId})
		}
	}
	// Return sukses ke AWS dengan array item-item yang error
	return SQSBatchResponse{BatchItemFailures: failures}, nil
}
```
