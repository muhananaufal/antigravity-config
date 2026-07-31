# Saga Pattern: Orchestration vs Choreography

## 1. Konsep & Internal

Dalam arsitektur *microservices*, transaksi bisnis yang mencakup beberapa layanan tidak bisa lagi menggunakan *Distributed Transaction* tradisional (seperti 2-Phase Commit / 2PC) karena dapat memblokir basis data, tidak skalabel, dan mengurangi *availability* (Hukum Brewer / CAP Theorem).

**Saga Pattern** memecah satu transaksi bisnis besar menjadi serangkaian transaksi lokal yang berjalan di tiap-tiap layanan. Setiap transaksi lokal memperbarui basis data dan mempublikasikan suatu *event* atau pesan untuk memicu transaksi lokal berikutnya.

Jika salah satu langkah gagal, Saga akan menjalankan **Compensating Transactions** (transaksi kompensasi) pada setiap langkah yang sudah berhasil untuk membatalkan (undo) perubahan.

### Dua Varian Saga

1. **Choreography (Desentralisasi)**
   Tidak ada koordinator terpusat. Tiap layanan mendengarkan (*listen*) *event* dari layanan lain dan memutuskan aksi apa yang harus dilakukan.
   *Cocok untuk:* Saga yang sederhana (2-4 langkah).
   *Kelemahan:* Logika bisnis tersebar di mana-mana, sangat sulit di-*debug* jika macet di tengah jalan.

2. **Orchestration (Sentralisasi)**
   Ada satu layanan spesifik (Orchestrator / Saga Manager) yang bertindak sebagai "otak". Ia yang memanggil layanan-layanan lain (via HTTP/gRPC atau *command queue*) dan melacak *state* saat ini.
   *Cocok untuk:* Alur kerja kompleks, banyak layanan terlibat, atau sering berubah.
   *Kelemahan:* Orchestrator bisa menjadi *Single Point of Failure* (jika tidak dirancang HA) dan berpotensi menjadi "God Service" yang tahu terlalu banyak domain orang lain.

### Diagram Arsitektur (ASCII)

```ascii
[ SAGA ORCHESTRATION - Create Order ]

      +-------------------+
      | Order Orchestrator| (State Machine: Pending -> Reserved -> Paid -> Completed)
      +-------------------+
         |             |              |
 (1. Reserve)  (3. Charge)    (5. Ship)
         v             v              v
  +-----------+   +----------+   +----------+
  | Inventory |   | Payment  |   | Shipping |
  +-----------+   +----------+   +----------+
         |             |
 (2. Success)  (4. FAILED!) 
 
 --- KARENA PAYMENT FAILED, ORCHESTRATOR MENJALANKAN KOMPENSASI ---
 
      +-------------------+
      | Order Orchestrator| 
      +-------------------+
         |
 (6. Cancel/Restore Inventory)
         v
  +-----------+
  | Inventory |
  +-----------+
```

## 2. Production-Ready Code (Orchestration Engine Sederhana)

Dalam produksi modern, pola ini sering ditangani oleh Temporal.io atau AWS Step Functions. Namun, jika Anda harus membangun *in-house state machine* di Go untuk kasus sederhana, berikut pendekatannya:

```go
package saga

import (
	"context"
	"errors"
	"fmt"
	"log"
)

// Step mendefinisikan satu langkah dalam Saga beserta kompensasinya.
type Step struct {
	Name           string
	ExecuteFunc    func(ctx context.Context) error
	CompensateFunc func(ctx context.Context) error
}

// Orchestrator mengelola jalannya Saga.
type Orchestrator struct {
	steps []Step
}

func NewOrchestrator() *Orchestrator {
	return &Orchestrator{}
}

func (o *Orchestrator) AddStep(name string, exec, comp func(context.Context) error) {
	o.steps = append(o.steps, Step{
		Name:           name,
		ExecuteFunc:    exec,
		CompensateFunc: comp,
	})
}

// Execute menjalankan saga. Jika ada ExecuteFunc yang gagal, ia akan memanggil CompensateFunc
// dari langkah-langkah yang SUDAH berhasil secara mundur (Reverse Order).
func (o *Orchestrator) Execute(ctx context.Context) error {
	var completedSteps []Step

	for i, step := range o.steps {
		log.Printf("[Saga] Executing step: %s", step.Name)
		
		err := step.ExecuteFunc(ctx)
		if err != nil {
			log.Printf("[Saga] Step %s failed: %v", step.Name, err)
			
			// Jika gagal, inisiasi Compensation untuk step yang SUDAH sukses
			compErr := o.compensate(ctx, completedSteps)
			if compErr != nil {
				// FATAL: Lihat Anti-Pattern #2 (Compensation Failure)
				return fmt.Errorf("saga execution failed on step '%s': %w (CRITICAL: compensation also failed: %v)", step.Name, err, compErr)
			}
			
			return fmt.Errorf("saga execution failed on step '%s' (rolled back successfully): %w", step.Name, err)
		}
		
		// Catat bahwa step ini sukses dan bisa dikompensasi nanti jika dibutuhkan
		completedSteps = append(completedSteps, step)
		log.Printf("[Saga] Step %s completed at index %d", step.Name, i)
	}

	log.Println("[Saga] Execution completed successfully")
	return nil
}

func (o *Orchestrator) compensate(ctx context.Context, completedSteps []Step) error {
	var compErrors []error
	
	// Kompensasi harus dilakukan dari step terakhir yang sukses, mundur ke step pertama (LIFO)
	for i := len(completedSteps) - 1; i >= 0; i-- {
		step := completedSteps[i]
		log.Printf("[Saga] Compensating step: %s", step.Name)
		
		if step.CompensateFunc == nil {
			log.Printf("[Saga] No compensation defined for step %s", step.Name)
			continue
		}
		
		// Seharusnya logic compensation di-retry secara asinkron dengan backoff 
		// jika terjadi kegagalan jaringan (lihat Edge Cases)
		err := step.CompensateFunc(ctx)
		if err != nil {
			log.Printf("[Saga] Compensation failed for step %s: %v", step.Name, err)
			compErrors = append(compErrors, fmt.Errorf("step %s: %w", step.Name, err))
		}
	}
	
	if len(compErrors) > 0 {
		return fmt.Errorf("encountered %d errors during compensation", len(compErrors))
	}
	return nil
}
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan Idempotensi pada Fungsi Kompensasi
**Masalah**: Fungsi `CompensateFunc` dirancang mengasumsikan ia hanya dipanggil satu kali.
```go
// BAD: Tidak idempotent. Jika dipanggil 2x karena timeout jaringan,
// stok akan bertambah +2 padahal yang di-reserve hanya +1.
func CompensateInventory(itemID string) error {
    _, err := db.Exec("UPDATE inventory SET qty = qty + 1 WHERE id = ?", itemID)
    return err
}
```
**Why dangerous:** Jika jaringan terputus (timeout) tepat setelah Orchestrator memanggil fungsi kompensasi, Orchestrator tidak tahu apakah fungsi sukses dieksekusi atau tidak. Orchestrator akan (dan harus) me-*retry* kompensasi tersebut. Jika tidak *idempotent*, data akan rusak secara fatal.
**Solusi:** Kompensasi harus mengirim `SagaID` atau `TransactionID` untuk mengabaikan eksekusi ganda, atau ubah *state* secara absolut.

### ❌ Anti-Pattern 2: Orchestrator Blocking secara Sinkron Menunggu Balasan (Synchronous Orchestration)
**Masalah**: Orchestrator memanggil layanan lain via HTTP POST dan `time.Sleep` atau nge-block (goroutine macet) selama berdetik-detik menunggu *callback*.
```go
// BAD:
func (o *Orchestrator) Execute(ctx context.Context) error {
    // Blocking HTTP call ke layanan yang lambat
    http.Post("http://payment/charge") 
}
```
**Why dangerous:** Jika pembayaran memakan waktu 3 menit (karena *Payment Gateway Provider* sedang lemot), pod Orchestrator akan kehabisan *thread* (Goroutine/Memory Leak) jika menampung ribuan *request* secara bersamaan.
**Solusi:** Orchestrator harus asinkron. Kirim *Command* ke antrean pesan (Kafka), simpan *state* Saga di database (contoh: status = "WAITING_PAYMENT_REPLY"), dan biarkan worker lain memproses *event* balasan untuk melanjutkan Saga.

## 4. Edge Cases Spesifik

1. **Kompensasi Gagal (The "Stuck" Saga)**:
   Bagaimana jika saat kompensasi dijalankan, layanan terkait mati berhari-hari atau *database*nya rusak permanen? 
   *Penanganan*: Kompensasi **tidak boleh gagal selamanya**. Jika ia gagal setelah di-*retry* habis-habisan, catat ke *Dead Letter Queue* (DLQ) dan harus membunyikan alarm (PagerDuty). Kegagalan ini membutuhkan **Intervensi Manual (Manual Reconciliation)** oleh tim *Customer Service* atau *Engineer* untuk merapikan datanya.

2. **Dirty Reads (Isolation Lack)**:
   Karena Saga adalah serangkaian transaksi lokal yang terpisah, ia tidak memiliki isolasi penuh (*I* dalam ACID). 
   Misal: Saga (Langkah 1) menambah poin *loyalty* User. Lalu Saga (Langkah 2) gagal. Saga lalu harus melakukan kompensasi (mengurangi poin). 
   Tapi, pada jeda waktu antara Langkah 1 dan Kompensasi, pengguna tersebut melihat saldo poinnya dan langsung *Redeem* (Membeli barang) menggunakan poin tersebut! Saat Saga hendak kompensasi, poinnya sudah kosong.
   *Penanganan*: Gunakan *Semantic Lock* (contoh: poin berstatus "PENDING_VERIFICATION") sehingga poin tersebut belum bisa digunakan oleh transaksi lain sampai keseluruhan Saga `COMPLETED`.

3. **Pivot Transaction**:
   Dalam pola Saga, transaksi dibagi menjadi *Compensatable*, *Pivot*, dan *Retryable*. *Pivot Transaction* adalah titik di mana keadaan tidak dapat lagi dikembalikan (Point of No Return), contoh: layanan pengiriman fisik pihak ketiga sudah menjemput paket.
   *Penanganan*: Urutkan desain sistem Anda. Pastikan *Pivot Transaction* diletakkan pada titik krusial (biasanya langkah terakhir yang mengubah dunia nyata). Setelah *Pivot* sukses dijalankan, sisa langkah dalam Saga HANYA boleh berupa *Retryable Transactions* (tidak boleh gagal secara fungsional, dan jika gagal murni karena infrastruktur, terus di-*retry* sampai sukses).

## 5. Unit Tests (Behavioral Testing)

```go
package saga

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestOrchestrator_SuccessPath(t *testing.T) {
	orch := NewOrchestrator()
	var executed []string

	orch.AddStep("Reserve_Stock", 
		func(ctx context.Context) error { executed = append(executed, "reserve"); return nil },
		nil,
	)
	orch.AddStep("Process_Payment", 
		func(ctx context.Context) error { executed = append(executed, "pay"); return nil },
		nil,
	)

	err := orch.Execute(context.Background())
	if err != nil {
		t.Fatalf("Expected success, got %v", err)
	}
	
	if len(executed) != 2 || executed[0] != "reserve" || executed[1] != "pay" {
		t.Fatalf("Expected execution order [reserve, pay], got %v", executed)
	}
}

func TestOrchestrator_RollbackOnFailure(t *testing.T) {
	orch := NewOrchestrator()
	var flow []string

	orch.AddStep("Step1", 
		func(ctx context.Context) error { flow = append(flow, "exec1"); return nil },
		func(ctx context.Context) error { flow = append(flow, "comp1"); return nil },
	)
	orch.AddStep("Step2", 
		func(ctx context.Context) error { flow = append(flow, "exec2"); return errors.New("payment declined") },
		func(ctx context.Context) error { flow = append(flow, "comp2"); return nil },
	)
	orch.AddStep("Step3", 
		func(ctx context.Context) error { flow = append(flow, "exec3"); return nil },
		func(ctx context.Context) error { flow = append(flow, "comp3"); return nil },
	)

	err := orch.Execute(context.Background())
	if err == nil {
		t.Fatal("Expected saga to fail")
	}

	if !strings.Contains(err.Error(), "payment declined") {
		t.Fatalf("Expected error to contain 'payment declined', got %v", err)
	}

	// Step 1 success, Step 2 fails. 
	// Therefore, Step 3 execute should NOT run.
	// Step 2 compensate should NOT run (because it failed to execute).
	// Step 1 compensate SHOULD run.
	
	expectedFlow := []string{"exec1", "exec2", "comp1"}
	
	if len(flow) != len(expectedFlow) {
		t.Fatalf("Expected flow length %d, got %d. Flow: %v", len(expectedFlow), len(flow), flow)
	}
	
	for i, step := range expectedFlow {
		if flow[i] != step {
			t.Fatalf("Expected flow[%d] = %s, got %s", i, step, flow[i])
		}
	}
}

func TestOrchestrator_CompensationFailure(t *testing.T) {
	orch := NewOrchestrator()

	orch.AddStep("Step1", 
		func(ctx context.Context) error { return nil },
		func(ctx context.Context) error { return errors.New("db down during compensation") },
	)
	orch.AddStep("Step2", 
		func(ctx context.Context) error { return errors.New("fail step 2") },
		nil,
	)

	err := orch.Execute(context.Background())
	if err == nil {
		t.Fatal("Expected error")
	}
	
	// Error harus memberitahu bahwa kompensasi juga gagal (Fatal state)
	if !strings.Contains(err.Error(), "CRITICAL: compensation also failed") {
		t.Fatalf("Expected critical error format, got %v", err)
	}
}
```
