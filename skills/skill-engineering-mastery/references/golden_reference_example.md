# Golden Reference Example: Contoh File Referensi Sempurna (Annotated)

Dokumen ini berisi **1 contoh lengkap file referensi yang dianggap SEMPURNA** beserta anotasi penjelasan di setiap bagiannya. Model AI WAJIB menggunakan contoh ini sebagai pola acuan (*pattern to mimic*) saat menulis file referensi baru.

---

## Mengapa Contoh Ini Penting?

Model AI kecil cenderung menghasilkan konten yang dangkal, generik, atau tidak terstruktur jika hanya diberikan "aturan abstrak". Dengan memberikan **1 contoh konkret yang sempurna**, model dapat melakukan *pattern-matching* langsung dan menghasilkan output berkualitas jauh lebih tinggi.

---

## Contoh File Referensi Sempurna: `atomic_locks.md`

Berikut adalah contoh lengkap file referensi untuk topik "Cache Atomic Locks di Laravel" yang memenuhi SEMUA standar kualitas kita:

```markdown
# Cache Atomic Locks: Mencegah Race Condition pada Operasi Konkuren

Atomic Lock (Cache Lock) adalah mekanisme penguncian berbasis cache (Redis/Memcached) untuk mencegah
dua atau lebih proses mengeksekusi operasi yang sama secara bersamaan. Mekanisme ini krusial untuk
mencegah race condition pada skenario seperti: pemrosesan pembayaran ganda, pengiriman email duplikat,
atau pengurangan stok produk secara bersamaan saat flash sale.

---

## 1. Konsep Utama: Mengapa Atomic Lock Dibutuhkan

### Problem Statement
Ketika 2 request HTTP atau 2 Queue Worker memproses data yang sama secara bersamaan,
tanpa mekanisme penguncian, keduanya akan membaca state yang sama dan menghasilkan
mutasi ganda (double processing).

### Diagram Alur Race Condition (Tanpa Lock):
Request A: READ stock=1 → stock=1-1=0 → WRITE stock=0  ✅
Request B: READ stock=1 → stock=1-1=0 → WRITE stock=0  ❌ (Seharusnya ditolak, stok sudah 0)

### Solusi: Atomic Lock menjamin hanya 1 proses yang bisa mengeksekusi blok kritis pada satu waktu.

---

## 2. Implementasi Production-Ready

### 2.1. Basic Atomic Lock Pattern
```php
<?php

use Illuminate\Support\Facades\Cache;

public function processPayment(Order $order): void
{
    $lock = Cache::lock("payment:order:{$order->id}", 30); // Lock 30 detik

    if ($lock->get()) {
        try {
            // Critical section — hanya 1 proses yang bisa masuk di sini
            $order->markAsPaid();
            $order->reduceStock();
            $order->sendConfirmationEmail();
        } finally {
            $lock->release(); // WAJIB release di finally block
        }
    } else {
        // Lock sudah dipegang proses lain
        throw new PaymentAlreadyProcessingException(
            "Order {$order->id} sedang diproses oleh proses lain."
        );
    }
}
```

### 2.2. Block-and-Wait Pattern (Menunggu Lock Tersedia)
```php
<?php

use Illuminate\Support\Facades\Cache;

public function processExclusiveReport(string $reportId): void
{
    $lock = Cache::lock("report:{$reportId}", 120);

    // Tunggu maksimal 10 detik sampai lock tersedia
    $lock->block(10, function () use ($reportId) {
        // Critical section
        $this->generateReport($reportId);
    });
    // Lock otomatis di-release setelah callback selesai
}
```

---

## 3. Anti-Patterns & Kesalahan Umum

### ❌ Anti-Pattern 1: Tidak Menggunakan finally Block
```php
// SALAH — jika exception terjadi sebelum release(), lock akan stuck sampai expired
$lock = Cache::lock('key', 30);
if ($lock->get()) {
    $this->riskyOperation();  // Jika ini throw exception...
    $lock->release();          // ...baris ini tidak pernah dieksekusi!
}
```

### ✅ Perbaikan:
```php
$lock = Cache::lock('key', 30);
if ($lock->get()) {
    try {
        $this->riskyOperation();
    } finally {
        $lock->release(); // Selalu dieksekusi meskipun ada exception
    }
}
```

### ❌ Anti-Pattern 2: Lock Duration Terlalu Pendek
```php
// SALAH — lock 5 detik tapi operasi butuh 30 detik
$lock = Cache::lock('heavy-job', 5);
// Lock expire di tengah jalan → proses lain bisa masuk → race condition
```

### ✅ Perbaikan:
```php
// Atur durasi lock LEBIH LAMA dari estimasi waktu operasi + buffer
$lock = Cache::lock('heavy-job', 60); // 60 detik untuk operasi yang butuh ~30 detik
```

---

## 4. Edge Cases & Defensive Handling

### 4.1. Owner-Aware Release (Mencegah Release Lock Milik Proses Lain)
```php
<?php

$lock = Cache::lock('resource', 30);

if ($lock->get()) {
    try {
        $this->longRunningTask();
    } finally {
        // forceRelease() akan melepas lock SIAPAPUN pemiliknya
        // release() hanya melepas jika KITA yang memiliki lock ini
        $lock->release(); // ✅ Aman: hanya release milik sendiri
    }
}
```

### 4.2. Idempotency Guard dengan Lock
```php
<?php

public function handleWebhookPayment(Request $request): JsonResponse
{
    $idempotencyKey = $request->header('X-Idempotency-Key');

    if (!$idempotencyKey) {
        return response()->json(['error' => 'Missing idempotency key'], 400);
    }

    $lock = Cache::lock("webhook:{$idempotencyKey}", 60);

    if (!$lock->get()) {
        return response()->json(['message' => 'Already processing'], 409);
    }

    try {
        // Cek apakah sudah pernah diproses
        if (Cache::has("processed:{$idempotencyKey}")) {
            return response()->json(['message' => 'Already processed'], 200);
        }

        $this->processPayment($request->all());

        // Tandai sebagai sudah diproses (TTL 24 jam)
        Cache::put("processed:{$idempotencyKey}", true, 86400);

        return response()->json(['message' => 'Payment processed'], 200);
    } finally {
        $lock->release();
    }
}
```

---

## Anotasi: Mengapa Contoh Ini Dianggap Sempurna

| Aspek | Penjelasan |
| :--- | :--- |
| **Paragraf pembuka** | Menjelaskan APA itu Atomic Lock, MENGAPA dibutuhkan, dan KAPAN digunakan — dalam 3 kalimat. |
| **Konsep dengan Diagram** | Memvisualisasikan race condition secara sederhana agar pembaca langsung paham masalahnya. |
| **Kode Production-Ready** | Setiap contoh kode langsung bisa di-copy-paste ke proyek nyata. Tidak ada placeholder. |
| **Anti-Pattern Section** | Menunjukkan pola SALAH (❌) dan BENAR (✅) secara berdampingan — ini sangat membantu AI memahami batas. |
| **Edge Cases** | Mencakup skenario tepi nyata (owner-aware release, idempotency guard) yang sering diabaikan pemula. |
| **Panjang File** | ~120 baris — pas di rentang ideal (100-300 baris). |

---

## Contoh File Referensi Sempurna (Golang): `goroutine_lifecycle_leaks.md`

Berikut adalah contoh lengkap file referensi untuk topik "Goroutine Lifecycle & Leak Prevention di Go" yang memenuhi SEMUA standar kualitas:

```markdown
# Goroutine Lifecycle & Leak Prevention

Goroutine leak terjadi ketika goroutine yang diluncurkan tidak pernah berhenti —
ia terus berjalan di background mengonsumsi memori dan CPU tanpa bisa di-GC.
Leak paling sering terjadi karena channel yang tidak pernah menerima nilai,
context cancellation yang tidak dipropagasi, atau goroutine yang menunggu
resource yang tidak pernah tersedia. Pada skala produksi, leak ini menyebabkan
OOM kill bertahap yang sulit didiagnosis.

---

## 1. Konsep Utama: Kapan Goroutine Berhenti

Goroutine hanya berhenti dalam 3 kondisi:
1. Fungsi goroutine mencapai `return` secara alami.
2. Program utama (`main`) berhenti.
3. Goroutine menerima sinyal stop via `ctx.Done()` atau channel penutup.

### Diagram Goroutine Leak Paling Umum:
```
// Launcher meluncurkan goroutine lalu return
go func() {
    result := <-ch  // ← STUCK di sini selamanya jika ch tidak pernah dikirim
    process(result)
}()
// ch tidak pernah di-close → goroutine leak permanen
```

---

## 2. Implementasi Production-Ready

### 2.1. Context Cancellation Pattern (Standar Wajib)
```go
func StartWorker(ctx context.Context, jobs <-chan Job) error {
    for {
        select {
        case <-ctx.Done():
            // Goroutine berhenti bersih saat context di-cancel
            return ctx.Err()
        case job, ok := <-jobs:
            if !ok {
                // Channel ditutup oleh producer — berhenti normal
                return nil
            }
            if err := processJob(ctx, job); err != nil {
                return fmt.Errorf("process job %d: %w", job.ID, err)
            }
        }
    }
}

// Pemanggil:
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel() // WAJIB: pastikan cancel selalu dipanggil

if err := StartWorker(ctx, jobCh); err != nil && !errors.Is(err, context.Canceled) {
    log.Printf("worker exited with error: %v", err)
}
```

### 2.2. WaitGroup Pattern untuk Fan-Out Worker Pool
```go
func RunWorkerPool(ctx context.Context, concurrency int, jobs <-chan Job) error {
    var wg sync.WaitGroup
    errCh := make(chan error, concurrency) // buffered agar goroutine tidak stuck

    for i := 0; i < concurrency; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for {
                select {
                case <-ctx.Done():
                    return
                case job, ok := <-jobs:
                    if !ok {
                        return
                    }
                    if err := processJob(ctx, job); err != nil {
                        select {
                        case errCh <- err:
                        default: // drop jika channel penuh — ambil error pertama saja
                        }
                        return
                    }
                }
            }
        }()
    }

    wg.Wait()
    close(errCh)

    return <-errCh // nil jika tidak ada error
}
```

---

## 3. Anti-Patterns & Kesalahan Umum

### ❌ Anti-Pattern 1: Goroutine Tanpa Exit Condition
```go
// SALAH — goroutine ini tidak pernah bisa berhenti
go func() {
    for {
        data := fetchData() // jika fetchData() blocking dan tidak ada ctx → leak
        process(data)
    }
}()
```

### ✅ Perbaikan:
```go
go func() {
    for {
        select {
        case <-ctx.Done():
            return // berhenti bersih saat ctx di-cancel
        default:
            data, err := fetchDataWithContext(ctx)
            if err != nil {
                return
            }
            process(data)
        }
    }
}()
```

### ❌ Anti-Pattern 2: Mengirim ke Channel Tanpa Select
```go
// SALAH — jika receiver sudah tidak ada, goroutine ini stuck selamanya
go func() {
    result := compute()
    resultCh <- result // ← DEADLOCK jika tidak ada yang membaca
}()
```

### ✅ Perbaikan:
```go
go func() {
    result := compute()
    select {
    case resultCh <- result:
    case <-ctx.Done(): // berhenti jika context di-cancel sebelum hasil dikirim
    }
}()
```

---

## 4. Edge Cases & Defensive Handling

### 4.1. Deteksi Leak dengan `goleak` di Unit Test
```go
func TestWorkerPool(t *testing.T) {
    defer goleak.VerifyNone(t) // FAIL jika ada goroutine leak setelah test selesai

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    jobs := make(chan Job, 10)
    go RunWorkerPool(ctx, 4, jobs)

    jobs <- Job{ID: 1}
    close(jobs)
}
```

### 4.2. Graceful Shutdown dengan Timeout
```go
func Shutdown(cancel context.CancelFunc, wg *sync.WaitGroup) error {
    cancel() // sinyal semua goroutine untuk berhenti

    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil // semua goroutine berhenti bersih
    case <-time.After(10 * time.Second):
        return fmt.Errorf("shutdown timeout: goroutines still running after 10s")
    }
}
```
```

---

## Anotasi: Mengapa Contoh Golang Ini Dianggap Sempurna

| Aspek | Penjelasan |
| :--- | :--- |
| **Paragraf pembuka** | Menjelaskan APA itu goroutine leak, MENGAPA terjadi, dan DAMPAK produksi — dalam 4 kalimat. |
| **Konsep dengan Diagram** | Menunjukkan kondisi goroutine berhenti + contoh leak pattern langsung dalam kode. |
| **Context Propagation** | Setiap fungsi menerima `ctx context.Context` sebagai parameter pertama — standar wajib Go idiomatik. |
| **Error Handling** | Setiap operasi yang bisa gagal mengembalikan `error` dengan wrapping `fmt.Errorf("...: %w", err)`. |
| **Anti-Pattern Section** | Menunjukkan pola SALAH (❌) dan BENAR (✅) berdampingan dengan penjelasan teknis mengapa salah. |
| **Edge Cases** | Mencakup deteksi leak via `goleak` di test + graceful shutdown dengan timeout — sering diabaikan pemula. |
| **Panjang File** | ~130 baris — pas di rentang ideal (100-300 baris). |
