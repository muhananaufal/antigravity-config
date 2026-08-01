# AWS Secrets Manager & Parameter Store dengan Golang

Mengelola secrets dalam aplikasi Cloud Native (K8s/ECS/Lambda) tidak boleh menggunakan file hardcoded atau environment variable biasa tanpa enkripsi. AWS menawarkan dua layanan utama: **Secrets Manager** dan **Systems Manager (SSM) Parameter Store**.

## 1. AWS Secrets Manager vs Parameter Store

| Fitur | Secrets Manager | SSM Parameter Store |
|-------|-----------------|---------------------|
| **Cost** | $0.40/secret/bulan + $0.05/10k API calls | Free (Standard), Cost for Advanced / High Throughput |
| **Rotation**| Built-in Lambda Integration | Manual / Custom logic |
| **KMS** | Custom KMS Key / AWS Managed KMS | Custom KMS Key (SecureString) |

### Parameter Store: Mengambil SecureString

Untuk menyimpan dan mengambil config string biasa atau enkripsi (SecureString).

```go
package config

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

func GetParameter(ctx context.Context, client *ssm.Client, name string) (string, error) {
	out, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(true), // Penting untuk SecureString
	})
	if err != nil {
		return "", err
	}
	return *out.Parameter.Value, nil
}
```

### Secrets Manager: GetSecretValue & Version Staging

Setiap rahasia memiliki "Versions" dan label seperti `AWSCURRENT`, `AWSPREVIOUS`.

```go
package secrets

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

func GetDBCredentials(ctx context.Context, client *secretsmanager.Client, secretID string) (string, error) {
	out, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId:     aws.String(secretID),
		VersionStage: aws.String("AWSCURRENT"),
	})
	if err != nil {
		return "", err
	}
	return *out.SecretString, nil // Biasanya berupa string JSON {"username":"admin","password":"..."}
}
```

---

## 2. Arsitektur Secret Caching (Menghindari Limit & Biaya)

Memanggil `GetSecretValue` pada **setiap** HTTP/gRPC request akan menyebabkan **Throttling** dan tagihan AWS meledak (karena pricing berbasis jumlah API call).

### Arsitektur Caching TTL

```ascii
+-------------+      Request      +---------------+        Cache Hit         
| Client App  | ----------------> |  Secret Cache | <--------------------+   
+-------------+                   +---------------+                      |
      ^                                 | Cache Miss / TTL Expired       |
      | Return Secret                   v                                |
      |                        +------------------+                      |
      +------------------------|  Secrets Manager | ---------------------+
                               +------------------+
```

Gunakan library resmi `github.com/aws/aws-secretsmanager-caching-go`.

```go
import (
	"github.com/aws/aws-secretsmanager-caching-go/secretcache"
)

var cache *secretcache.Cache

func init() {
	c, _ := secretcache.New()
	cache = c
}

func getSecret(secretID string) (string, error) {
    // Akan me-return dari cache memory, atau melakukan fetch jika TTL habis
	return cache.GetSecretString(secretID)
}
```

---

## 3. IAM Role Assumption (Cross-Account Access)

Saat service di Akun AWS A perlu membaca secret di Akun AWS B, Anda menggunakan `sts.AssumeRole`.

```go
import (
	"context"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

func crossAccountSecretClient(ctx context.Context, roleARN string) *secretsmanager.Client {
	cfg, _ := config.LoadDefaultConfig(ctx)
	
	stsClient := sts.NewFromConfig(cfg)
	
	// Create AssumeRole credentials provider
	provider := stscreds.NewAssumeRoleProvider(stsClient, roleARN)
	
	cfg.Credentials = provider
	return secretsmanager.NewFromConfig(cfg)
}
```

---

## 4. IRSA pada EKS (IAM Roles for Service Accounts)

Di Kubernetes (Amazon EKS), meletakkan AWS credentials di ConfigMap/Secret sangat dilarang! Praktik standar (Top 1%) adalah IRSA (OIDC identity). Pod Golang Anda mengasumsikan role IAM tanpa keys!

Golang SDK V2 secara otomatis akan mengambil environment variables `AWS_ROLE_ARN` dan `AWS_WEB_IDENTITY_TOKEN_FILE` yang disuntikkan oleh kubelet EKS. Anda hanya perlu memanggil `config.LoadDefaultConfig`!

---

## Anti-Patterns & Best Practices

### ❌ BAD: Fetch Secret Per-Request
```go
// ❌ ANTI-PATTERN: Membaca secret tanpa cache tiap query DB!
// Tagihan AWS bisa naik drastis dan akan kena rate limit exception.
func HandleUserLogin(w http.ResponseWriter, r *http.Request) {
    secret, _ := smClient.GetSecretValue(ctx, ...)
    db := connect(secret)
    // process
}
```

### ✅ GOOD: Caching dan Hot-Reload
```go
// ✅ BEST PRACTICE: Fetch saat init, jalankan goroutine untuk reload secret saat TTL rotasi dekat.
func main() {
    startSecretWatcher() // Goroutine interval fetch
}
```

### ❌ BAD: Rotasi menyebabkan Restart App / Downtime
Mengharuskan service direstart setiap 30 hari (saat password DB direfresh Lambda) adalah praktik buruk di sistem HFT / ketersediaan tinggi.

### ✅ GOOD: Dynamic Re-connection
Aplikasi Go harus mendeteksi error "Access Denied / Invalid Auth" dari DB layer, me-refresh secret *on the fly*, dan menginisialisasi DB connection pool baru, tanpa me-restart Pod.

---

## Edge Cases

1. **Rotation Race Condition**: Saat Lambda me-rotasi secret di DB (misal mengubah password RDS), ada delay singkat (1-2 detik) dimana label `AWSCURRENT` di Secrets Manager mungkin sudah update, tetapi proses pergantian password di mesin RDS belum selesai. Jika app Go mengambil secret baru dan gagal connect, lakukan **Exponential Backoff Retry**.
2. **KMS Key Rotation / Deletion**: Jika IAM policy SDK diizinkan membaca secret Manager tetapi TIDAK diizinkan KMS Decrypt pada Customer Managed Key, maka `GetSecretValue` akan error `AccessDeniedException`. Selalu berikan policy KMS decrypt yang tepat di IRSA IAM Role.
3. **SSM Parameter Store Rate Limits**: Parameter Store Standard tier di throttle ~40 TPS. Jika aplikasi auto-scale dari 0 ke 1000 Pods (misal HPA burst), 1000 pods ini akan hit SSM bersamaan dan error `ThrottlingException`. Solusinya adalah enable 'High Throughput' mode (berbayar) di AWS SSM atau pass secret lewat Kubernetes External Secrets Operator (ESO).
4. **Stale Connection Pool**: Saat secret cache di-reload, koneksi `*sql.DB` atau redis yang lama masih menggunakan password lama. Beberapa DB memutuskan koneksi, beberapa tidak. App Go Anda harus memanggil `db.Close()` dan membuat pool baru secara thread-safe (`sync.RWMutex`) tanpa menggagalkan request yang sedang in-flight.
5. **Partial Parameter Fetch (GetParametersByPath)**: Mengambil `/prod/app-A/db-password` dan `/prod/app-A/api-key` menggunakan pagination SSM ByPath. Jika total param melebihi 10, Go app harus menangani loop pagination parameter store.

---

## Unit Testing dengan Mock Interfaces

Gunakan mocking untuk mencegah API call betulan ke AWS saat CI pipeline.

```go
type MockSecretsClient struct {
	GetSecretValueFunc func(ctx context.Context, params *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error)
}

func (m *MockSecretsClient) GetSecretValue(ctx context.Context, params *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
	return m.GetSecretValueFunc(ctx, params, optFns...)
}

func TestGetDBCredentials(t *testing.T) {
	mockClient := &MockSecretsClient{
		GetSecretValueFunc: func(ctx context.Context, params *secretsmanager.GetSecretValueInput, optFns ...func(*secretsmanager.Options)) (*secretsmanager.GetSecretValueOutput, error) {
			return &secretsmanager.GetSecretValueOutput{
				SecretString: aws.String(`{"password":"mock"}`),
			}, nil
		},
	}

	// client injection
    secret, err := GetDBCredentials(context.Background(), mockClient, "my-secret")
    if secret != `{"password":"mock"}` {
        t.Fatal("secret mismatch")
    }
}
```

## Cross-Account Secret Sharing via Resource Policy

Alih-alih meng-assume role (`sts.AssumeRole`), cara paling *cloud-native* adalah memasang **Resource-Based Policy** langsung di Secret-nya, mengizinkan akun B untuk `secretsmanager:GetSecretValue`. 
App Go di Akun B cukup memanggil Secret ID menggunakan *Full ARN* dari Akun A. Tidak perlu ada perpindahan Role/Context.

## Secret Rotation Lambda Implementasi

AWS menyediakan template fungsi Lambda untuk merotasi rahasia. Konsep utamanya menggunakan step-step:
1. `createSecret` (generate random password, simpan dengan staging label `AWSPENDING`)
2. `setSecret` (konek ke DB, jalankan `ALTER USER x PASSWORD y`)
3. `testSecret` (konek ke DB dengan password baru)
4. `finishSecret` (pindahkan label `AWSCURRENT` ke password baru).

Bagi developer Go, SDK `aws-secretsmanager-caching-go` sangat esensial saat momen ini, agar aplikasi me-reload sesaat setelah `finishSecret` dipanggil.

## KMS Key Alias vs ARN Best Practice

Saat menggunakan `SecureString` di Parameter Store atau encrypting Secrets Manager:
- ❌ **BAD**: Menggunakan Full Key ARN (hardcoded regional string). Jika key direplikasi atau di-recreate di region lain (DR), kode Go/IaC akan rusak.
- ✅ **GOOD**: Menggunakan Key Alias (`alias/my-app-key`). Alias mengabstraksi ID key fisik yang ada di baliknya.

## Audit Trail via CloudTrail

*Best Practice* sistem keamanan: Anda wajib mengaktifkan **AWS CloudTrail Data Events** untuk mendeteksi siapa (Role IAM mana) yang membaca Secret pada jam berapa. Di Go app, pastikan menyertakan context *User Agent* (contoh request ID/tracer ID) jika memungkinkan agar bisa dikorelasikan di CloudTrail log.

---

## Edge Cases Tambahan

6. **KMS Decryption Rate Limit**: Saat AWS Secrets Manager mendekripsi nilai rahasia untuk diberikan ke Golang app Anda, operasi tersebut mengonsumsi *KMS API Quota* (`kms:Decrypt`), yang batasannya biasanya 10,000 - 50,000 requests/sec. Jika HPA pod Kubernetes menskala ribuan pod serentak tanpa secret cache di level kubelet/ESO, Anda akan kehabisan quota KMS, menyebabkan servis lain di AWS *account* Anda yang juga memakai KMS (misal S3 SSE-KMS) akan gagal (Cascading Failure).
7. **SSM Parameter Store Size Limit**: Batas maksimum ukuran string/SecureString di Parameter Store Standard adalah **4 KB**, dan Advanced adalah **8 KB**. Jika sertifikat TLS/JWT Private Key Anda sebesar 9 KB diserialisasi menjadi Base64, Anda TIDAK BISA menyimpannya di SSM. Anda WAJIB menggunakan AWS Secrets Manager yang memiliki limit ukuran hingga **64 KB**.

## 6. Cross-Account Secret Sharing & Audit

Dalam arsitektur *Multi-Account / Hub-and-Spoke* (misalnya 1 Akun AWS khusus untuk Centralized Security, sedangkan App berjalan di Dev/Prod accounts), sharing secret sangat penting.

### Resource-Based Policy untuk Secret

Jangan buat IAM Role per Account. Pasang JSON Policy langsung di Secrets Manager (seperti S3 Bucket Policy).
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/ProductionGoAppRole"
      },
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "*"
    }
  ]
}
```

### AWS CloudTrail Audit Trail

Untuk mematuhi SOC2/PCI-DSS, akses ke KMS dan Secrets Manager wajib di log (Data Events).
Pastikan kode Go Anda menyuntikkan *Context / Trace ID* ke dalam API Call.

```go
// Menambahkan header internal yang akan terekam di CloudTrail!
func getSecretWithAudit(ctx context.Context, client *secretsmanager.Client, traceID string) {
    client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{...}, func(o *secretsmanager.Options) {
        // Appending user-agent/tracer agar tim Security (SecOps) tahu asal call
        o.APIOptions = append(o.APIOptions, func(middlewareStack *middleware.Stack) error {
            return middlewareStack.Build.Add(
                middleware.Metadata{
                    "custom-trace-id": traceID,
                }, middleware.After)
        })
    })
}
```

### Lambda Secret Rotation Go Template

Rotasi otomatis harus diatur di Secrets Manager, menunjuk ke fungsi Lambda (dalam Go). Struktur handlernya membutuhkan routing dari *Step* rotasi.

```go
// Rotasi Lambda Handler (Konseptual)
func handler(ctx context.Context, event secretsmanager.RotationEvent) error {
	switch event.Step {
	case "createSecret":
		// Bangkitkan password random baru (misal 32 byte), simpan dengan versi AWSPENDING
	case "setSecret":
		// Konek ke RDS DB menggunakan password AWSCURRENT lama, lalu jalankan SQL ALTER ROLE untuk mengubah pass ke AWSPENDING
	case "testSecret":
		// Konek ke RDS menggunakan password AWSPENDING untuk validasi
	case "finishSecret":
		// Update status versi rahasia. Pindahkan AWSCURRENT ke AWSPENDING. (Aplikasi Go akan ter-reload cache TTL nya).
	}
	return nil
}
```
