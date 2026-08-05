# Google Cloud Platform (GCP) Client Libraries in Go

> **Berlaku:** Go 1.21+ · Google Cloud Client Libraries · **Lihat juga:** `cloud_provider_sdk/aws_sdk_go_v2.md` · `cybersecurity_zerotrust/spiffe_spire_workload.md` · `microservices_grpc/grpc_interceptors_middleware.md` · `security_owasp/secret_management_vault.md`

Aplikasi Golang yang di-deploy di lingkungan GCP (Google Kubernetes Engine, Cloud Run, Compute Engine) memiliki standar autentikasi dan desain client SDK yang sedikit berbeda dari AWS. Library resmi berada di `cloud.google.com/go/...`.

## Application Default Credentials (ADC) Chain

GCP menggunakan *Application Default Credentials (ADC)*. SDK Google Client secara otomatis mencari kredensial dengan urutan ini:
1. Environment Variable `GOOGLE_APPLICATION_CREDENTIALS` (Path ke JSON file Service Account).
2. Konfigurasi kredensial pengguna yang diset via `gcloud auth application-default login` (Developer local environment).
3. Metadata Server: Saat berjalan di GCP (Compute Engine, GKE, Cloud Run), client mengambil token dari Metadata server IAM Workload/Service Account terpasang secara transparan.

### Workload Identity Federation (GKE → GCP SA)

Praktik Top 1%: JANGAN gunakan service account key (file JSON) di produksi. Gunakan Workload Identity (WI).
Di GKE, WI mengikat Kubernetes Service Account (KSA) ke Google Service Account (GSA).
- Pod Golang menggunakan ADC biasa `storage.NewClient(ctx)`.
- Kubelet akan men-generate token OIDC, menukarkannya dengan access token GSA, dan meng-inject-nya via environment variables tanpa JSON keys!

---

## 1. Google Cloud Storage (GCS)

Client GCS sangat efisien karena dirancang berbasis streaming / `io.Reader` dan `io.Writer`.

### Upload / Download Streaming

```go
package gcp

import (
	"context"
	"io"
	"cloud.google.com/go/storage"
)

func StreamUpload(ctx context.Context, client *storage.Client, bucket, object string, src io.Reader) error {
	b := client.Bucket(bucket)
	obj := b.Object(object)
	
	// Create writer (streaming langsung ke cloud)
	writer := obj.NewWriter(ctx)
	writer.ContentType = "application/octet-stream"

	if _, err := io.Copy(writer, src); err != nil {
		writer.Close() // Pastikan ditutup walau error
		return err
	}
	// Object HANYA tersimpan di GCS jika Close() berhasil tanpa error
	return writer.Close()
}
```

### V4 Signed URLs

Digunakan agar pengguna dapat mendownload file private secara langsung.
*Peringatan*: Signed URL GCS butuh access ke *Private Key* GCP, yang mana ADC dari GKE Metadata server TIDAK sediakan secara otomatis (kecuali impersonation SignBlob IAM policy ditambahkan).

```go
import (
	"time"
	"cloud.google.com/go/storage"
)

func GetSignedURL(bucket, object string, serviceAccountEmail string, privateKey []byte) (string, error) {
	opts := &storage.SignedURLOptions{
		Scheme:         storage.SigningSchemeV4,
		Method:         "GET",
		GoogleAccessID: serviceAccountEmail,
		PrivateKey:     privateKey,
		Expires:        time.Now().Add(15 * time.Minute),
	}
	return storage.SignedURL(bucket, object, opts)
}
```

---

## 2. Google Cloud Pub/Sub

Pub/Sub adalah Global Messaging service dari GCP.

### Publish dengan Ordering Key

Ordering menjamin urutan eksekusi di sisi consumer selama key-nya sama (misal: ID transaksi).

```go
import (
	"context"
	"cloud.google.com/go/pubsub"
)

func PublishMessage(ctx context.Context, client *pubsub.Client, topicID, msg string, orderKey string) (string, error) {
	topic := client.Topic(topicID)
	// Penting: Aktifkan ordering untuk topic
	topic.EnableMessageOrdering = true

	result := topic.Publish(ctx, &pubsub.Message{
		Data:        []byte(msg),
		OrderingKey: orderKey, // Semua msg dgn key yg sama dijamin berurutan
	})
    // Get() melakukan proses secara sinkron (blocking) sampai ID dipublish/error
	return result.Get(ctx) 
}
```

### Subscribe & Ack Deadline Extension

Subscriber Golang bekerja asinkron (Pull streaming). Library Go akan otomatis melakukan perpanjangan tenggat waktu Ack (*Ack Deadline Extension*) di background jika handler Anda butuh waktu lama!

```go
func Subscribe(ctx context.Context, client *pubsub.Client, subID string) error {
	sub := client.Subscription(subID)
	
	// Menerima pesan secara concurrent. Blocking func.
	return sub.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
		// Proses data Anda. 
		// SDK akan otomatis mengirim ModAck ke GCP untuk memperpanjang deadline.
        err := process(msg.Data)
        if err != nil {
            msg.Nack() // Akan redeliver
            return
        }
		msg.Ack()
	})
}
```

---

## 3. Google BigQuery

BigQuery client digunakan untuk analisis skala petabyte.

### Query & Schema Auto-detect (Pagination)

Paginasi di BigQuery Client dilakukan lewat iterasi object. 

```go
import (
	"context"
	"cloud.google.com/go/bigquery"
	"google.golang.org/api/iterator"
)

type UserRow struct {
	Name string `bigquery:"name"`
	Age  int    `bigquery:"age"`
}

func QueryUsers(ctx context.Context, client *bigquery.Client, projectID string) ([]UserRow, error) {
	q := client.Query(`SELECT name, age FROM ` + "`" + projectID + ".dataset.users`" + ` LIMIT 100`)
	
	it, err := q.Read(ctx)
	if err != nil {
		return nil, err
	}

	var results []UserRow
	for {
		var row UserRow
		err := it.Next(&row)
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		results = append(results, row)
	}
	return results, nil
}
```

---

## Anti-Patterns & Best Practices

### ❌ BAD: Sync Publish Tanpa Batch/Goroutine
Melakukan blocking `result.Get(ctx)` dalam HTTP loop akan memperlambat response time karena Anda menahan request HTTP untuk HTTP call ke GCP.

```go
// ❌ ANTI-PATTERN
for _, msg := range messages {
    res := topic.Publish(ctx, msg)
    res.Get(ctx) // Blocking per message!
}
```

### ✅ GOOD: Async Publish (Biarkan SDK Batching)
GCP SDK otomatis membundle (batch) publish request berdasarkan size/waktu (misal tiap 10ms). Biarkan jalan asinkron atau sinkronkan via goroutine.
```go
// ✅ BEST PRACTICE
var results []*pubsub.PublishResult
for _, msg := range messages {
    results = append(results, topic.Publish(ctx, msg)) // Tidak blocking!
}
for _, r := range results {
    // Kumpulkan status di akhir, batching sudah optimal
    id, err := r.Get(ctx) 
}
```

### ❌ BAD: No Context Deadline pada BQ Query
BigQuery queries bisa berjalan selama berjam-jam. Tanpa deadline, goroutine di backend Go Anda akan menggantung selamanya.

```go
// ✅ BEST PRACTICE
ctx, cancel := context.WithTimeout(requestCtx, 5*time.Second)
defer cancel()
q := client.Query("SELECT ...")
q.Read(ctx)
```

---

## Edge Cases

1. **Pub/Sub Ordering Guarantee & Poison Pill**: Jika `OrderingKey` A gagal di-Ack (masuk ke status Nack), SDK Go akan menahan (pause) pengiriman seluruh pesan berikutnya untuk `OrderingKey` A sampai yang ini sukses diproses (menghindari race urutan). Ini bisa menyebabkan sistem stuck (Poison Pill). Anda HARUS punya logic skip atau lempar ke Dead Letter Topic dalam code Anda dan memanggil `topic.ResumePublish(orderingKey)`.
2. **BigQuery Streaming Buffer Delay**: Saat Anda menggunakan `Inserter.Put` (Streaming Insert BQ), data baru akan masuk ke _streaming buffer_. Data ini langsung bisa di-SELECT (query), TAPI tidak bisa segera di-UPDATE/DELETE atau diekspor selama 30-90 menit. Jangan rancang arsitektur yang mengharuskan update (mutation) langsung ke baris yang baru disisipkan secara streaming.
3. **GCS Object Immutability**: GCS object is *immutable*. Anda tidak bisa append file layaknya OS local. Jika Anda open GCS `Writer` dengan nama object yang sama, object lama akan di-_overwrite_ keseluruhan. Jika butuh append, gunakan fitur *Compose Objects*.
4. **GCS Concurrent Overwrites (Lost Update)**: Dua proses Go melakukan update state JSON di file GCS bersamaan. Gunakan Preconditions (`If-Match: Generation Number`) di `storage.Conditions` agar update GCS bersifat atomik layaknya Optimistic Locking di database.
5. **Memory Leak di PubSub Subscriber**: SDK Pub/Sub membuat multi goroutines. Jika Anda tidak menutup `sub.Receive(ctx)` saat service shutdown (misal SIGTERM), context dari parent akan dicancel namun open connection gRPC dapat menggantung. Selalu catch os signal dan cancel context dengan rapi (Graceful Shutdown).

---

## Unit Testing dengan GCS Emulator (fsouza) atau Mocks

Menggunakan _real mock interface_ dari GCP agak sulit karena library menggunakan tipe struct konkret, bukan interface penuh (seperti AWS SDK). Top 1% pendekatan di GCP Go adalah menggunakan Emulator! (Misal: `github.com/fsouza/fake-gcs-server`)

```go
import (
	"testing"
	"github.com/fsouza/fake-gcs-server/fakestorage"
)

func TestGCSUpload(t *testing.T) {
    // In-memory fake GCS server
	server, err := fakestorage.NewServerWithOptions(fakestorage.Options{
		InitialObjects: []fakestorage.Object{
			{BucketName: "my-bucket", Name: "hello.txt", Content: []byte("world")},
		},
	})
	if err != nil { t.Fatal(err) }
	defer server.Stop()

    // Ambil client gcp asli dari server fake (interceptor url)
	client := server.Client() 
	
    // Panggil func kita (bisa streaming)
	// err = StreamUpload(ctx, client, "my-bucket", "test.txt", src)
}
```

## Cloud Spanner Go Client

Google Cloud Spanner adalah database relasional terdistribusi global dengan konsistensi kuat. Go client-nya sangat dioptimasi.

### NewClient & BatchRead

```go
import (
	"context"
	"cloud.google.com/go/spanner"
	"google.golang.org/api/iterator"
)

func SpannerRead(ctx context.Context, client *spanner.Client) error {
	// Read-Only Transaction (Snapshot)
	ro := client.ReadOnlyTransaction()
	defer ro.Close()
	
	iter := ro.Read(ctx, "Users", spanner.AllKeys(), []string{"UserID", "Name"})
	defer iter.Stop()
	
	for {
		row, err := iter.Next()
		if err == iterator.Done { break }
		if err != nil { return err }
		// ... proses row
	}
	return nil
}
```

### ReadWriteTransaction

Untuk mutasi yang butuh read-modify-write atomik:

```go
_, err := client.ReadWriteTransaction(ctx, func(ctx context.Context, txn *spanner.ReadWriteTransaction) error {
    row, err := txn.ReadRow(ctx, "Accounts", spanner.Key{"acc1"}, []string{"Balance"})
    if err != nil { return err }
    
    var balance int64
    if err := row.Column(0, &balance); err != nil { return err }
    
    m := spanner.Update("Accounts", []string{"AccountID", "Balance"}, []interface{}{"acc1", balance + 100})
    return txn.BufferWrite([]*spanner.Mutation{m})
})
```

## Cloud Run Deployment Pattern

Aplikasi Go sangat ideal untuk Cloud Run (Serverless Container).
1. **Container-Native**: Go `scratch` image (ukuran 5-10MB) membuat waktu boot container kurang dari 500ms.
2. **Auto-scaling to zero**: Karena boot sangat cepat, Cloud Run bisa diset min-instances=0 untuk menghemat biaya secara drastis saat tidak ada trafik.
3. **Concurrency**: Cloud Run mendukung hingga 1000 concurrent requests per container. Satu container Go HTTP server dapat menangani ribuan QPS tanpa perlu men-spawn container baru.

## Error Handling GCP API & Retries

Berbeda dengan `error` biasa, API GCP (gRPC/HTTP) mengembalikan error tipe khusus dari package `google.golang.org/grpc/status` atau `google.golang.org/api/googleapi`.

```go
import (
    "google.golang.org/api/googleapi"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/codes"
)

func handleGCPError(err error) {
    // 1. Cek HTTP Error (REST)
    if apiErr, ok := err.(*googleapi.Error); ok {
        if apiErr.Code == 429 || apiErr.Code == 503 {
            // Lakukan Exponential Backoff Retry (Rate Limit / Unavailable)
        }
    }
    
    // 2. Cek gRPC Error (Spanner/PubSub)
    if st, ok := status.FromError(err); ok {
        if st.Code() == codes.ResourceExhausted {
            // Quota limit hit
        }
    }
}
```

## Tambahan Edge Cases GCP

6. **Cloud Spanner Session Leaks**: Spanner client menggunakan "Session Pool". Jika Anda tidak memanggil `defer iter.Stop()` pada saat read, session Spanner akan menggantung (leak) di sisi client. Lama-kelamaan aplikasi Go akan kehabisan session (max 400 default) dan seluruh query database akan freeze menunggu session kosong!
7. **Cloud Run CPU Throttling**: Secara default, Cloud Run membatasi (throttle) alokasi CPU mendekati 0 saat *TIDAK ADA* request HTTP yang sedang diproses secara aktif (saat idle). Jika worker Go melakukan background processing (goroutine) sesudah me-return HTTP response `200 OK`, eksekusi background itu akan berjalan suaaaangat lambat atau beku. Solusinya: Aktifkan fitur "CPU always allocated" jika aplikasi butuh background tasking.

## Kapan JANGAN Pakai Ini

- **Berkas kredensial JSON di dalam container.** Workload Identity menghapus kebutuhan itu sepenuhnya. Berkas kunci adalah kredensial berumur panjang yang bisa disalin, dan pencabutannya sering terlambat.
- **Client yang tidak pernah ditutup.** Sebagian client GCP memegang koneksi gRPC berumur panjang. Membuatnya berulang tanpa `Close()` membocorkan koneksi dan goroutine.
- **Mengabaikan kuota per proyek.** Kuota berlaku lintas layanan dan lintas beban kerja dalam satu proyek. Job batch yang menghabiskan kuota akan mematikan jalur permintaan pengguna di proyek yang sama.
- **Retry tanpa memperhatikan kode galat gRPC.** `InvalidArgument` dan `PermissionDenied` tidak akan menjadi benar karena diulang; hanya `Unavailable` dan `ResourceExhausted` yang layak.
- **Emulator sebagai satu-satunya lingkungan uji.** Emulator tidak mereplikasi IAM, kuota, dan sebagian perilaku konsistensi. Uji jalur kritis terhadap layanan sungguhnya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `ResourceExhausted` saat batch berjalan | kuota per proyek | Beban batch menghabiskan kuota bersama |
| Goroutine dan koneksi menumpuk | apakah client di-`Close` | Client dibuat ulang tanpa ditutup |
| Berkas kunci ditemukan di image | sumber kredensial | Workload Identity belum dipakai |
| Retry pada galat yang tidak akan berubah | klasifikasi kode gRPC | Semua galat diperlakukan sementara |
| Lolos di emulator, gagal di produksi | perbedaan IAM dan konsistensi | Uji hanya terhadap emulator |

```bash
# Identitas yang benar-benar dipakai -- harus service account via Workload Identity
gcloud auth list
kubectl get sa <ksa> -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}'

# Kuota yang mendekati batas
gcloud alpha services quota list --service=storage.googleapis.com --consumer=projects/"$PROJECT" 2>/dev/null | head

# Berkas kunci di dalam image adalah temuan
kubectl exec <pod> -- find / -name '*.json' -path '*credential*' 2>/dev/null | head

curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | grep -i -c grpc
```
