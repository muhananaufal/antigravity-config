# Temporal Workflow Engine (Durable Execution)

> **Berlaku:** Go 1.21+ · Temporal SDK v1.25+ · **Lihat juga:** `distributed_patterns_resilience/saga_orchestration_choreography.md` · `distributed_patterns_resilience/idempotency_key_engine.md` · `background_jobs_worker/cron_scheduler_go.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md`

## 1. Konsep & Internal

Dalam sistem terdistribusi, saat kita memanggil serangkaian *API* jarak jauh, selalu ada risiko aplikasi (atau kontainer/pod kita sendiri) akan mengalami *crash* di tengah-tengah transaksi (*misal memori penuh, OOM kill, atau rolling deploy*). Jika aplikasi mati setelah memanggil *API Reserve Flight* namun sebelum *API Charge Credit Card*, _state_ Anda menjadi inkonsisten dan "menggantung" tanpa rekam jejak yang jelas.

**Temporal.io** dan paradigma **Durable Execution** mengatasi ini dengan merekam setiap _event_ (langkah) dari *workflow* secara persisten di dalam *Database Event Sourcing* terpusat (Temporal Server).

- **Workflow**: Fungsi berumur panjang (bisa berjalan berhari-hari). Kodenya HARUS *deterministic* (selalu menghasilkan hal yang sama jika di-replay).
- **Activity**: Fungsi pembantu yang boleh me-manggil dunia nyata (HTTP call, database, non-deterministic).
- **Replay**: Jika worker Go kita mati, *worker* lain (atau *worker* yang baru direstart) akan dihidupkan, mengunduh rekam jejak eksekusi dari *server* Temporal, lalu mengeksekusi ulang kode dari baris pertama. Namun, langkah (Activity) yang sudah pernah sukses *TIDAK* akan dipanggil ulang ke API aslinya, melainkan langsung disuntikkan hasil lamanya (dari _history log_). Seolah-olah eksekusi tidak pernah terputus!

### Diagram Alir Komponen (ASCII)

```ascii
[ Go Worker ]                       [ Temporal Server ]
   |                                      |
   | Mulai Workflow()                     |
   |------------------------------------->| (Simpan Event: WorkflowStarted)
   |                                      |
   | Panggil Activity("BookHotel")        |
   |------------------------------------->| (Simpan Event: ActivityScheduled)
   |                                      |
   | <--- Jalankan Activity() ------------|
   | (Worker mengeksekusi HTTP POST)      |
   | (Berhasil, Return Status OK)         |
   |------------------------------------->| (Simpan Event: ActivityCompleted, Res=OK)
   |                                      |
  (WORKER KITA TIBA-TIBA MATI KARENA OOM KILL!)
   x
  (WORKER BARU DIRESTART OLEH KUBERNETES)
   |                                      |
   | <--- Replay State ke Worker Baru --- |
   | Worker melihat: "BookHotel sudah OK" |
   | Lanjut eksekusi baris berikutnya!    |
   | Panggil Activity("ChargeCard")       |
   |------------------------------------->|
```

## 2. Production-Ready Code (Go SDK)

Berikut adalah penerapan pola *Saga* modern menggunakan Temporal, yang menyederhanakan *Orchestration* tanpa *database state-machine* in-house.

```go
package workflow

import (
	"context"
	"errors"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/workflow"
)

// 1. --- ACTIVITIES --- (Kode yang berinteraksi dengan API nyata)

type PaymentActivities struct{}

func (a *PaymentActivities) ReserveHotel(ctx context.Context, id string) (string, error) {
	// Call Real API (Boleh timeout, network failure, non-deterministic)
	// Jika gagal, Temporal Server otomatis akan me-retry activity ini tanpa mengubah State Workflow.
	return "reservation-xyz", nil 
}

func (a *PaymentActivities) CancelHotel(ctx context.Context, id string) error {
	// Call API untuk kompensasi pembatalan
	return nil
}

func (a *PaymentActivities) ChargeCard(ctx context.Context, id string) error {
	// Simulasi gagal untuk mendemonstrasikan Kompensasi Saga
	return errors.New("insufficient funds")
}

// 2. --- WORKFLOW --- (Orkestrator murni, DILARANG pakai time.Now() native)

type TripRequest struct {
	UserID string
	TripID string
}

// TripSagaWorkflow adalah Workflow jangka panjang. 
// Ia kebal terhadap restart mesin.
func TripSagaWorkflow(ctx workflow.Context, req TripRequest) error {
	// Konfigurasi Retry default untuk Activity (misal 5 menit retry max)
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    10, // Activity akan diulang s.d 10x sebelum error fatal
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	logger := workflow.GetLogger(ctx)
	var activities *PaymentActivities // Reference kosong untuk mapping nama fungsi oleh SDK

	// Daftar Compensasi LIFO (Last In First Out)
	var compensations []func()

	// Defer block untuk menjalankan Rollback (Saga)
	defer func() {
		// Jika terjadi error (atau pembatalan paksa dari user), jalankan compensations
		if !errors.Is(ctx.Err(), nil) || ctx.Err() != nil {
			logger.Info("Executing Saga Compensations...")
			
			// Buat context baru yang tidak terpengaruh cancellation utama
			// Agar Activity Cancel bisa berjalan walaupun Workflow disuruh abort.
			compCtx, _ := workflow.NewDisconnectedContext(ctx)
			
			for i := len(compensations) - 1; i >= 0; i-- {
				// Jalankan satu per satu kompensasinya
				err := compensations[i]()
				if err != nil {
					logger.Error("Compensation failed", "Error", err)
				}
			}
		}
	}()

	// 1. Jalankan Activity Pertama
	var reservationID string
	err := workflow.ExecuteActivity(ctx, activities.ReserveHotel, req.TripID).Get(ctx, &reservationID)
	if err != nil {
		return err // Workflow gagal, (Tapi tidak ada compensation karena belum ada yg sukses)
	}
	
	// Tambahkan logic Undo (CancelHotel) jika ke depannya ada yg error
	compensations = append(compensations, func() error {
		return workflow.ExecuteActivity(ctx, activities.CancelHotel, reservationID).Get(ctx, nil)
	})

	// (Contoh: Menunggu keputusan manual, atau menunggu 2 hari).
	// AMAN untuk tidur berhari-hari. Memori di Go di-kosongkan, Temporal menyimpan State!
	// workflow.Sleep(ctx, 48 * time.Hour) 

	// 2. Jalankan Activity Kedua (Misal: Charge Card)
	err = workflow.ExecuteActivity(ctx, activities.ChargeCard, req.TripID).Get(ctx, nil)
	if err != nil {
		// Akan mengembalikan error. 
		// Fungsi defer akan dipanggil, dan CancelHotel akan dieksekusi dari history log!
		return err 
	}

	return nil // Workflow sukses
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Non-Deterministic Code dalam Workflow (Poison Pill)
**Masalah**: Developer menggunakan fungsi OS lokal di dalam *Workflow Definition*.
```go
// BAD: Dalam fungsi Workflow
randomNum := rand.Int()              // Gagal saat di-replay
currentTime := time.Now()            // Gagal saat di-replay
resp, _ := http.Get("api.com/data")  // Sangat Fatal (I/O)
```
**Why dangerous:** Saat *worker* mati, Temporal akan merestart fungsi Anda dan membaca ulang dari baris atas. Pada pembacaan awal, *random* bernilai 4. Saat di-replay, *random* mungkin bernilai 9, sehingga *if-branch* yang berbeda dieksekusi. Temporal mendeteksi perbedaan histori dan akan membunuh eksekusi secara permanen dengan `NonDeterministicWorkflowError`. *Workflow* tersebut hang/mati suri selamanya (*Poison Pill*).
**Solusi:**
- *Ganti* `time.Now()` dengan `workflow.Now(ctx)`.
- *Ganti* `go func()` dengan `workflow.Go(ctx, ...)`.
- *Pindahkan* operasi jaringan/DB/Disk (I/O) KESELURUHNYA ke dalam struktur `Activity`.

### ❌ Anti-Pattern 2: Menaruh Semua Logika Domain ke Activity (God Activity)
**Masalah**: Developer membuat satu *Activity* raksasa yang melakukan banyak hal (mengurus transaksi DB, mengirim ke Kafka, dan call 3rd-party API).
**Why dangerous:** Jika panggilan ke 3rd-party API *timeout*, Temporal akan me-*retry* seluruh *Activity* raksasa itu. Menyebabkan data disisipkan ganda ke DB atau Kafka.
**Solusi:** Pecah belah fungsi. *Activity* harus sangat kecil, *idempotent*, dan idealnya hanya menangani 1 efek eksternal (*side effect*). Biarkan fungsi *Workflow* Anda yang mengatur alur bisnisnya.

## 4. Edge Cases Spesifik

1. **Workflow Versioning (Evolusi Bisnis)**:
   Perusahaan memutuskan bahwa setelah *ReserveHotel*, tidak langsung *ChargeCard*, melainkan *SendEmail*. Jika Anda mengubah *source code* *Workflow*, ratusan *request* lama yang belum selesai (masih *In-Flight* / sedang disleep) akan mendapati kodenya berubah saat mereka terbangun/di-*replay*. Ini memicu `NonDeterministicWorkflowError`.
   *Penanganan*: Gunakan *Versioning API* milik Temporal. `workflow.GetVersion(ctx, "EmailAdded", workflow.DefaultVersion, 1)`. Ini menjamin *request* lama akan mengikuti cabang (branch) kode yang usang, sementara *request* baru menggunakan cabang kode baru di fungsi yang sama.

2. **Large Payload di Dalam Workflow History**:
   Developer mem-parsing file CSV `50MB` dan melewatkannya (`pass by value`) sebagai argumen `Activity`. Temporal akan menyimpan `50MB` tersebut di dalam *Event Sourcing History* di database utamanya (Postgres/Cassandra). Jika *history* melampaui `50MB`, Temporal menolak melanjutkan dan mematikan eksekusi (*Limit Size*).
   *Penanganan*: Simpan CSV ke S3 (Blob Storage). Lewatkan hanya referensi URL / `Bucket Key` (beberapa byte) sebagai argumen antar *Workflow* dan *Activity*.

3. **Activity Heartbeats (Zombie Detection)**:
   Sebuah *Activity* mentranscode Video membutuhkan waktu 2 jam. Kita memberikan *Timeout* selama 3 jam. Sayangnya, *pod worker* tersebut hang / panik / *kernel panic* diam-diam di menit pertama. Server Temporal harus menunggu selama **sisa 3 jam penuh** sebelum menyadari bahwa ia perlu me-*retry* transcode tersebut ke *pod* lain, mengakibatkan UX yang lamban bagi pengguna.
   *Penanganan*: Implementasikan `activity.RecordHeartbeat(ctx, progressInfo)`. Jika *worker* tidak memanggil *heartbeat* secara periodik (misal tiap 10 detik), Temporal Server langsung tahu *worker* itu mati (Zombie) dan akan segera me-retry *Activity* di tempat lain dalam hitungan detik.

## 5. Unit Tests (Behavioral Testing)

```go
package workflow

import (
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

func TestTripSagaWorkflow_Success(t *testing.T) {
	// Inisialisasi Test Suite yang mem-mock Temporal Server di memory
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	// Daftarkan activity agar testsuite mengenalinya
	var activities *PaymentActivities
	env.RegisterActivity(activities.ReserveHotel)
	env.RegisterActivity(activities.ChargeCard)
	env.RegisterActivity(activities.CancelHotel) // Tidak boleh dipanggil jika sukses

	// Mocking behavior saat Activity dipanggil
	env.OnActivity(activities.ReserveHotel, env.BackgroundContext(), "trip-123").Return("res-123", nil)
	env.OnActivity(activities.ChargeCard, env.BackgroundContext(), "trip-123").Return(nil)

	// Jalankan workflow
	req := TripRequest{UserID: "usr-A", TripID: "trip-123"}
	env.ExecuteWorkflow(TripSagaWorkflow, req)

	if !env.IsWorkflowCompleted() {
		t.Fatal("Expected workflow to be fully completed")
	}

	err := env.GetWorkflowError()
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}

	env.AssertExpectations(t)
}

func TestTripSagaWorkflow_FailureAndCompensation(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	var activities *PaymentActivities
	env.RegisterActivity(activities.ReserveHotel)
	env.RegisterActivity(activities.ChargeCard)
	env.RegisterActivity(activities.CancelHotel)

	// Reserve sukses
	env.OnActivity(activities.ReserveHotel, env.BackgroundContext(), "trip-error").Return("res-error", nil)
	
	// ChargeCard GAGAL
	env.OnActivity(activities.ChargeCard, env.BackgroundContext(), "trip-error").Return(errors.New("insufficient funds"))
	
	// Karena ChargeCard gagal, Workflow harus memanggil CancelHotel
	env.OnActivity(activities.CancelHotel, env.BackgroundContext(), "res-error").Return(nil)

	// Eksekusi
	req := TripRequest{UserID: "usr-B", TripID: "trip-error"}
	env.ExecuteWorkflow(TripSagaWorkflow, req)

	// Pastikan mendapatkan error dari workflow
	err := env.GetWorkflowError()
	if err == nil {
		t.Fatal("Expected workflow to fail due to charge card error")
	}

	// Memastikan semua fungsi mock dipanggil, termasuk CancelHotel (Compensation)
	env.AssertExpectations(t)
}
```

## Kapan JANGAN Pakai Ini

- **Untuk pekerjaan latar sederhana.** Temporal membawa cluster, database sendiri, worker, dan model pemrograman yang harus dipelajari seluruh tim. Untuk mengirim email atau mengubah ukuran gambar, antrean biasa sudah cukup.
- **Kode workflow yang tidak deterministik.** Workflow diputar ulang dari riwayatnya. `time.Now()`, `rand`, iterasi `map`, dan panggilan jaringan langsung di dalam workflow akan menghasilkan kegagalan replay. Semuanya WAJIB lewat API Temporal atau dipindahkan ke activity.
- **Mengubah kode workflow yang sedang berjalan tanpa versioning.** Riwayat lama akan diputar ulang dengan kode baru dan gagal. `workflow.GetVersion` ada persis untuk masalah ini, dan harus dipakai sebelum perubahan, bukan sesudah insiden.
- **Payload besar di input atau output activity.** Semuanya tersimpan di riwayat. Riwayat yang besar memperlambat replay, memperbesar database, dan bisa menembus batas ukuran.
- **Sebagai antrean berthroughput sangat tinggi.** Temporal unggul pada alur berumur panjang dan bercabang. Untuk jutaan pesan sederhana per detik, ia bukan alat yang tepat.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `NonDeterministicError` setelah deploy | riwayat workflow yang gagal | Kode berubah tanpa `GetVersion`, atau ada sumber nondeterminisme |
| Workflow menumpuk berstatus Running | backlog task queue | Jumlah worker tidak cukup |
| Replay sangat lambat | `historyLength` | Riwayat membengkak karena payload besar atau loop panjang |
| Activity diulang terus | kebijakan retry activity | Galat permanen diperlakukan sebagai sementara |
| Database Temporal tumbuh cepat | retensi namespace | Riwayat tidak pernah diarsipkan |

```bash
temporal workflow list --query 'ExecutionStatus="Running"' --limit 20
temporal workflow list --query 'ExecutionStatus="Failed"'  --limit 20

temporal workflow describe --workflow-id <id>
temporal workflow show --workflow-id <id> | head -40

# Riwayat yang membengkak memperlambat setiap replay
temporal workflow describe --workflow-id <id> -o json \
  | jq '.workflowExecutionInfo.historyLength, .workflowExecutionInfo.historySizeBytes'

# Backlog per task queue: kalau menumpuk, tambah worker
temporal task-queue describe --task-queue antrean-pesanan
```
