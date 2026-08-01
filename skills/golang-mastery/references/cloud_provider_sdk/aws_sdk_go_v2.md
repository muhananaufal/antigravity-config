# AWS SDK for Go v2: Referensi Lengkap dan Praktik Terbaik

AWS SDK for Go v2 dirancang ulang dari awal untuk mengatasi limitasi dari v1, terutama terkait modularitas, performa, dan konsumsi memori. 

## Arsitektur SDK (V2 vs V1)

Berbeda dengan v1 yang memuat *seluruh* service dalam satu modul raksasa, v2 menggunakan pendekatan **modular packages**. Artinya, jika Anda hanya butuh S3, Anda hanya akan mem-build dependensi untuk S3.

```ascii
+-------------------------------------------------------------+
|                     Aplikasi Go Anda                        |
+-------------------------------------------------------------+
|                     AWS SDK for Go v2                       |
|  +----------------+  +----------------+  +---------------+  |
|  | config         |  | service/s3     |  | service/sqs   |  |
|  | credentials    |  |                |  |               |  |
|  +----------------+  +----------------+  +---------------+  |
|          |                  |                  |            |
|  +-------------------------------------------------------+  |
|  |                Middleware & Request Pipeline          |  |
|  |  (Retryer, Endpoint Resolver, SigV4 Signer, Metrics)  |  |
|  +-------------------------------------------------------+  |
|                                |                            |
|  +-------------------------------------------------------+  |
|  |                      HTTP Client                      |  |
|  |        (Connection Pooling, TLS, Keep-Alive)          |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### Konfigurasi dan `credentials.Chain`

SDK v2 sangat bergantung pada struktur `aws.Config`. Resolusi kredensial menggunakan mekanisme *Chain* yang secara default berurutan:
1. Environment Variables (`AWS_ACCESS_KEY_ID`, dll)
2. Shared Credentials File (`~/.aws/credentials`)
3. IAM Role for Amazon EC2 / ECS / EKS (IRSA) / OIDC

```go
package main

import (
    "context"
    "log"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func initS3Client() *s3.Client {
    // config.LoadDefaultConfig akan otomatis mencari region dan credentials
    cfg, err := config.LoadDefaultConfig(context.TODO(), 
        config.WithRegion("ap-southeast-1"),
        // Kustomisasi retry
        config.WithRetryMaxAttempts(5),
    )
    if err != nil {
        log.Fatalf("unable to load SDK config, %v", err)
    }

    return s3.NewFromConfig(cfg)
}
```

---

## 1. Amazon S3 (Simple Storage Service)

### Multipart Upload & Download

Untuk objek besar (>5MB), multipart upload sangat dianjurkan. Di v2, kita menggunakan package `manager`.

```go
package storage

import (
	"context"
	"io"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func UploadLargeFile(ctx context.Context, client *s3.Client, bucket, key string, body io.Reader) error {
	uploader := manager.NewUploader(client, func(u *manager.Uploader) {
		u.PartSize = 10 * 1024 * 1024 // 10 MB per part
		u.Concurrency = 5             // 5 concurrent goroutines
	})

	_, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   body,
	})
	return err
}
```

### Presigned URL (GetObject/PutObject)

Presigned URL digunakan agar client (misal: browser/mobile app) bisa langsung upload/download ke S3 tanpa melewati backend kita, menghemat bandwidth server.

```go
import (
    "time"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func GeneratePresignedURL(client *s3.PresignClient, bucket, key string, lifetime time.Duration) (string, error) {
    req, err := client.PresignGetObject(context.TODO(), &s3.GetObjectInput{
        Bucket: aws.String(bucket),
        Key:    aws.String(key),
    }, s3.WithPresignExpires(lifetime))
    if err != nil {
        return "", err
    }
    return req.URL, nil
}
```

### Paginator (ListObjectsV2)

Jangan pernah melakukan for-loop buta saat melist objek, gunakan *Paginator* bawaan SDK.

```go
func ListAllObjects(ctx context.Context, client *s3.Client, bucket string) {
    paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
        Bucket: aws.String(bucket),
    })

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            log.Printf("error listing page: %v", err)
            break
        }
        for _, obj := range page.Contents {
            log.Printf("Object: %s (Size: %d)", *obj.Key, *obj.Size)
        }
    }
}
```

---

## 2. Amazon SQS (Simple Queue Service)

SQS harus dikonsumsi dengan metode **Long Polling** untuk meminimalkan biaya dan empty receives.

### Send & Receive (Long Polling)

```go
package messaging

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func ReceiveMessages(ctx context.Context, client *sqs.Client, queueURL string) (*sqs.ReceiveMessageOutput, error) {
	return client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:            aws.String(queueURL),
		MaxNumberOfMessages: 10,
		WaitTimeSeconds:     20, // Long Polling! Mengurangi API calls drastis
		VisibilityTimeout:   30, // Waktu pemrosesan sebelum kembali terlihat
	})
}
```

### Visibility Timeout & Delete Message

Jika pemrosesan butuh waktu lama dari perkiraan, perbarui `VisibilityTimeout`. Setelah sukses, Wajib dihapus.

```go
func ProcessAndAck(ctx context.Context, client *sqs.Client, queueURL string, receiptHandle string) error {
    // Jika butuh waktu tambahan
    _, err := client.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
        QueueUrl:          aws.String(queueURL),
        ReceiptHandle:     aws.String(receiptHandle),
        VisibilityTimeout: 60, // Tambah 60 detik
    })
    if err != nil {
        return err
    }
    
    // Hapus setelah selesai
    _, err = client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
        QueueUrl:      aws.String(queueURL),
        ReceiptHandle: aws.String(receiptHandle),
    })
    return err
}
```

---

## 3. Amazon DynamoDB

DynamoDB di SDK v2 kini mendukung custom marshalling/unmarshalling melalui package `feature/dynamodb/attributevalue`.

### PutItem & GetItem

```go
package db

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

type User struct {
	ID    string `dynamodbav:"pk"`
	Email string `dynamodbav:"email"`
}

func PutUser(ctx context.Context, client *dynamodb.Client, table string, user User) error {
	item, err := attributevalue.MarshalMap(user)
	if err != nil {
		return err
	}

	_, err = client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(table),
		Item:      item,
		// Conditional Expression: Hanya masukkan jika ID belum ada
		ConditionExpression: aws.String("attribute_not_exists(pk)"),
	})
	return err
}
```

### TransactWriteItems (ACID)

Gunakan `TransactWriteItems` saat Anda butuh update beberapa item secara atomik (semua berhasil atau semua gagal).

```go
func TransferFunds(ctx context.Context, client *dynamodb.Client, table string) error {
	_, err := client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []dynamodb.TransactWriteItem{
			{
				Update: &dynamodb.Update{
					TableName: aws.String(table),
					Key: // ... marshaled key,
					UpdateExpression: aws.String("SET balance = balance - :amt"),
					ConditionExpression: aws.String("balance >= :amt"),
					ExpressionAttributeValues: // ... marshaled value,
				},
			},
			{
				Update: &dynamodb.Update{
					TableName: aws.String(table),
					Key: // ... marshaled key,
					UpdateExpression: aws.String("SET balance = balance + :amt"),
					ExpressionAttributeValues: // ... marshaled value,
				},
			},
		},
	})
	return err
}
```

---

## Anti-Patterns & Best Practices

### ❌ BAD: Memanajemen HTTP Client Sendiri tanpa Tuning / Shared Default Client
Jangan membuat HTTP client baru per request atau membiarkan default client di-override global tanpa connection pooling yang di-tune.

```go
// ❌ ANTI-PATTERN: Membuat config baru tiap request
func HandleRequest(ctx context.Context) {
    cfg, _ := config.LoadDefaultConfig(ctx)
    svc := s3.NewFromConfig(cfg)
    // ...
}
```

### ✅ GOOD: Re-use AWS Client
```go
// ✅ BEST PRACTICE: Inisialisasi 1 client pada saat startup dan re-use.
var s3Client *s3.Client

func init() {
    cfg, _ := config.LoadDefaultConfig(context.Background())
    s3Client = s3.NewFromConfig(cfg)
}

func HandleRequest(ctx context.Context) {
    // gunakan s3Client dengan context dari request
    s3Client.GetObject(ctx, ...)
}
```

### ❌ BAD: Credentials Hardcode
```go
// ❌ ANTI-PATTERN: Hardcode secret key (Bocor di version control!)
cfg, _ := config.LoadDefaultConfig(ctx, config.WithCredentialsProvider(
    credentials.NewStaticCredentialsProvider("AKIA...", "SECRET...", ""),
))
```

### ✅ GOOD: Gunakan Default Chain / IRSA
```go
// ✅ BEST PRACTICE: Biarkan SDK mencari dari Environment / IAM Roles (EKS IRSA)
cfg, _ := config.LoadDefaultConfig(ctx)
```

---

## Context, Timeout & Exponential Backoff

Dalam Microservices, setiap request eksternal WAJIB memiliki batas waktu (deadline). Jika service S3 / DynamoDB lambat, context timeout akan mencegah goroutine leak.

```go
func GetUserWithTimeout(client *dynamodb.Client) {
    // Set timeout max 2 detik
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()

    _, err := client.GetItem(ctx, &dynamodb.GetItemInput{/*...*/})
    if err != nil {
        // Handle context timeout error
    }
}
```

**Retry Logic**: AWS SDK v2 secara otomatis menangani retry dengan algoritma exponential backoff. Anda bisa memodifikasi jumlah retry (default 3): `config.WithRetryMaxAttempts(5)`.

---

## Edge Cases Implementatif

1. **Regional Endpoint Failover**: Kadang satu region mengalami degradasi performa. AWS SDK bisa di-configure untuk menggunakan endpoint regional fallback jika Anda punya arsitektur Active-Passive / multi-region, biasanya dihandle level DNS / Route53 tapi app Go Anda harus bisa handle context timeout dan menswitch client ke region B.
2. **DynamoDB Read-After-Write Consistency**: Secara default DynamoDB menggunakan `Eventually Consistent Reads` (setengah harga). Jika Anda baru saja `PutItem` dan harus *segera* membacanya (misalnya update profile lalu return object-nya), set `ConsistentRead: aws.Bool(true)` pada `GetItemInput`. Jika tidak, pengguna akan melihat data lama!
3. **SQS In-Flight Message Limit**: SQS Standard punya limit 120.000 in-flight messages (pesan yang direceive tapi belum didelete). Jika Anda tidak mendelete message di Golang setelah sukses diproses, Anda akan terkena throttling `OverLimit` dari SQS, yang menyebabkan sistem *stuck* sampai timeout visibility expired.
4. **S3 Multipart Upload Abandoned Parts**: Jika process Go crash saat melakukan multipart upload, *parts* yang sudah di-upload akan tersisa di bucket tanpa batas (memakan storage cost!). Edge case ini harus diatasi dengan menset Lifecycle Policy di bucket S3 untuk meng-abort incomplete multipart uploads setelah X hari.
5. **Context Cancellation vs DeleteMessage**: Sangat penting: jika `context.Context` dari HTTP Request dicancel (user abort request) TAPI worker sudah mulai memproses task SQS, Anda mungkin *masih* ingin mendelete message dari SQS agar tidak diproses ulang. Pisahkan / buat context `context.Background()` baru khusus untuk `DeleteMessage` cleanup.

---

## Unit Testing & Mocks (Interfaces)

SDK v2 memisahkan definisi interface agar lebih mudah di-mock (package `s3iface` dll sudah deprecated di v2, pendekatannya adalah custom interface).

```go
// 1. Definisikan interface subset yang kita pakai
type S3GetObjectAPI interface {
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

// 2. Buat mock struct
type mockS3Client struct {
	output *s3.GetObjectOutput
	err    error
}

func (m mockS3Client) GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	return m.output, m.err
}

// 3. Test Function
func TestDownload(t *testing.T) {
	mockClient := mockS3Client{
		output: &s3.GetObjectOutput{},
		err:    nil,
	}
    // inject mockS3Client ke function
	// err := DownloadFile(context.Background(), mockClient, "bucket", "key")
    // assert.NoError(t, err)
}
```
