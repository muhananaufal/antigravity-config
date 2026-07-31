# Goroutine Leak Detection & Prevention

## Konsep Utama
*Goroutine Leak* adalah bentuk yang paling mematikan dan diam-diam dari *memory leak* (kebocoran memori) spesifik di ekosistem Go. Ini terjadi ketika sebuah goroutine tetap berjalan atau (lebih sering) diblokir (stuck) hidup-hidup di background, meskipun tugas dan fungsionalitasnya sudah tidak lagi dibutuhkan atau API caller-nya sudah pergi. 

Berbeda dengan objek data (structs/strings) di memori RAM yang bisa dikumpulkan dan dibersihkan otomatis oleh Garbage Collector (GC), di Go, **GC tidak akan pernah menyentuh atau menghapus Goroutine yang sedang berjalan atau terblokir**. Sebuah goroutine *hanya* akan dihapus jika alur fungsi utamanya (`entry point`) telah tuntas dieksekusi (*return* alami) atau aplikasi *panic/crash*.

Penyebab umum terjadinya goroutine leak:
1. **Blocked on Unbuffered Channel**: Goroutine worker menunggu untuk mengirim (`ch <-`) atau menerima (`<-ch`), tetapi pasangannya sudah tidak ada (early return akibat HTTP timeout).
2. **Forgotten Context Propagation**: Melahirkan goroutine API/Network I/O di background tanpa merantaikan objek `context.Context` untuk mendengarkan sinyal terminasi/pembatalan dari atas.
3. **Nil Channels**: Membaca atau menulis ke channel yang bernilai *nil* (belum di-make) akan menyebabkan goroutine terblokir diam permanen (*forever block*).
4. **Infinite / Tight Loops**: Loop berulang `for {}` yang tidak mendengarkan notifikasi pembatalan dan terus berputar selamanya, atau tertahan pada API call pihak ketiga yang membatu.

Dampaknya sangat destruktif di *Production*. Tiap goroutine membawa jejak *Stack Memory* sebesar minimal 2KB (dan akan terus berkembang jika memanggil *deep functions*). Ribuan HTTP request harian yang masing-masing membocorkan 1 goroutine akan menimbun RAM server dengan pesat dan berujung pada ledakan Kematian Akibat Kehabisan Memori (OOM / Out-of-Memory Killer Linux).

## Diagram ASCII

```text
    How a Leak Happens in an HTTP Handler timeout scenario
    
    [ HTTP Request (10ms Limit) ] -> Handler Starts
           |
           v
    +--------------+                    +------------------+
    |  Goroutine A | -- spawn(async) -> |   Goroutine B    |
    | (Parent)     |                    | (Heavy DB Task)  |
    +--------------+                    +------------------+
           |                                     |
    [10ms Timer Expires!]                        | (Processing for 2000ms...)
    Parent aborts & returns early                |
           |                                     |
           v                               Tries to send result:
    GC cleans up Parent memory             "resultCh <- data" (Unbuffered)
    and HTTP connection closes,                  |
    BUT...                                 No one is receiving!
                                                 v
                                           Block Forever (Leak!)
                                           (Zombies eating your RAM)
```

## Kode Go Production-Ready

Kode di bawah ini mengilustrasikan teknik mencegah goroutine leak menggunakan kombinasi **Buffered Channels (Kapasitas 1)** dan **Context Cancellation**.

```go
package concurrency

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// ==========================================
// KODE PRODUCTION-READY
// ==========================================

// ProcessDataSafe adalah contoh fungsi yang aman dari goroutine leak.
// Fungsi memisahkan tugas I/O ke worker, tetapi kebal terhadap pembatalan.
func ProcessDataSafe(ctx context.Context, data string, processLatency time.Duration) (string, error) {
	// PRINSIP UTAMA: 
	// Gunakan buffered channel dengan ukuran sebesar 1 (atau jumlah worker).
	// Mengapa? Jika parent function me-return karena ctx timeout (pembaca kabur),
	// goroutine di bawah tetap bisa membuang hasilnya ke dalam buffer tanpa 
	// terblokir, lalu ia bisa mati (return) dengan tenang.
	resultCh := make(chan string, 1)
	errCh := make(chan error, 1)

	// Spawn task di background goroutine
	go func() {
		// Simulasi pekerjaan berat (e.g. koneksi database lambat, API eksternal)
		time.Sleep(processLatency)
		
		// Opsional tapi penting: Cek ulang, jangan buang effort proses 
		// komputasi data jika ternyata context client sudah putus.
		if ctx.Err() != nil {
			return 
		}
		
		// Karena channel ukurannya 1, send ini tidak akan pernah block selamanya
		// bahkan jika `ProcessDataSafe` sudah return lebih dulu dari `select`.
		resultCh <- fmt.Sprintf("Processed: %s", data)
	}()

	// Event loop pemantau: Siapa yang merespons duluan?
	select {
	case <-ctx.Done():
		// Skenario: Client pergi, timeout, atau parent function dicancel.
		// Fungsi ini langsung return, melepaskan router thread, 
		// DAN background goroutine terjamin tak membeku.
		return "", fmt.Errorf("operation aborted: %w", ctx.Err())
	case res := <-resultCh:
		// Skenario: Pekerjaan selesai alami.
		return res, nil
	case err := <-errCh:
		return "", err
	}
}

// ==========================================
// UNIT TEST DENGAN GOLEAK (-race)
// ==========================================
// Pengujian sangat kritikal menggunakan library go.uber.org/goleak 
// untuk mendeteksi goroutine zombie secara statis paska test selesai.

func TestProcessDataSafe_Success(t *testing.T) {
	// goleak akan memonitor runtime goroutine di awal dan di akhir test.
	// Jika jumlah goroutine naik permanen di akhir, test di-FALKAN.
	defer goleak.VerifyNone(t)

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	// Task butuh 50ms, Timeout 1000ms. Aman.
	res, err := ProcessDataSafe(ctx, "hello", 50*time.Millisecond)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if res != "Processed: hello" {
		t.Errorf("unexpected result: %s", res)
	}
}

func TestProcessDataSafe_CancellationAndLeakCheck(t *testing.T) {
	defer goleak.VerifyNone(t)

	// Skenario berbahaya: Timeout sengaja diset terlampau sempit
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	// Task butuh 50ms, tapi Timeout 10ms.
	_, err := ProcessDataSafe(ctx, "world", 50*time.Millisecond)
	
	// Memastikan Parent keluar tepat waktu
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context deadline exceeded, got %v", err)
	}
	
	// CATATAN: Di titik ini, worker goroutine yang tertinggal di belakang 
	// masih tertidur (sleep 50ms). Namun, begitu ia bangun, karena channel kita 
	// bertipe Buffer 1, instruksi `resultCh <- res` akan sukses secara instant, 
	// dan worker tersebut MATI (return). `goleak.VerifyNone` akan memverifikasi 
	// hal tersebut secara dinamis.
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Async Task pada Unbuffered Channel

```go
// ❌ BAD: Goroutine tersangkut pada Unbuffered Channel
func BadFetch() error {
    ch := make(chan int) // BAD: Kapasitas nol (Unbuffered)
    go func() {
        // Jika BadFetch timeout dan me-return duluan, tak ada yang membaca 'ch'.
        // Goroutine ini akan macet permanen (Forever blocked on Send) di sini!
        ch <- doHeavyWork() 
    }()
    
    select {
    case res := <-ch:
        return handle(res)
    case <-time.After(10 * time.Millisecond):
        return errors.New("timeout reached") 
    }
}

// ✅ GOOD: Lindungi worker dengan kapasitas Buffer Channel sejumlah worker-nya
func GoodFetch() error {
    ch := make(chan int, 1) // GOOD: Buffered 1
    go func() {
        ch <- doHeavyWork() // Mampu melemparkan data dan mati dengan tenang
    }()
    // ... select timeout ...
}
```

**Why dangerous:** Unbuffered channel memaksa garansi jabat-tangan sinkron (*Synchronous Handshake*) yang 100% sempurna antara Sender dan Receiver. Jika fungsi utama (`parent`) dipaksa merespons *timeout* (dengan blok `time.After`), maka goroutine parent itu pergi dari arena. Ketika goroutine *worker* mencoba `ch <- hasil`, ia tak menemukan kawan (Receiver). Di mata Go, goroutine itu tak berdosa dan wajib dibiarkan hidup menunggu temannya seumur hidup sistem menyala (Goroutine Leak absolut). Buffer 1 memastikan worker bisa meninggalkan "paket data" di kotak surat dan pensiun seketika.

### ❌ Anti-Pattern 2: Melupakan Perintah `cancel()` dari Context Factory

```go
// ❌ BAD: Background Goroutine Pemantau Timer bocor ke memori
func BadContext() {
    ctx, _ := context.WithTimeout(context.Background(), 10*time.Second)
    // BAD: Anda tidak memanggil fungsi cancel().
    
    // Walaupun doSomething() return dalam 1 detik,
    // objek timer milik context dan background goroutine bawaannya 
    // akan tetap disandera di memori sistem selama 10 detik penuh!
    doSomething(ctx) 
}

// ✅ GOOD: Gunakan defer dengan tegas
func GoodContext() {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel() // GOOD: Seketika menghentikan timer segera setelah fungsi exit.
    
    doSomething(ctx)
}
```

**Why dangerous:** Saat memanggil `context.WithCancel`, `WithTimeout`, atau `WithDeadline`, pustaka (library) internal Go mendaftarkan *node timer* baru yang memantau durasi dari sisi background goroutine internal (OS-level runtime). Apabila pekerjaan aplikasi telah beres di luar durasi dan `cancel()` diabaikan, fungsi *cleanup timer* tidak tertrigger. Dalam sistem e-commerce padat (contoh 10,000 requests per detik), tidak memanggil `defer cancel()` akan menyebabkan 10,000 instance timer mengendap di RAM setiap detiknya dan tak bisa dipungut GC, meruntuhkan performa server seiring jalannya waktu.

## Edge Cases

1. **Membiarkan `time.After` Menggantung dalam Loop**: Menuliskan blok kontrol `case <-time.After(1 * time.Second):` secara lugu di dalam iterasi *for...select* yang tak terhingga (*endless loop*) adalah malapetaka memori. Setiap putaran iterasi, Go akan melahirkan satu goroutine OS baru bertugas menghitung mundur waktu, dan goroutine ini tidak akan pernah dihapus oleh Garbage Collector hingga detiknya kedaluwarsa.
   - *Defensive*: Gunakan fungsi konstruktor yang bisa didaur ulang: `timer := time.NewTimer(...)` taruh letaknya di luar loop pembungkus. Selama perulangan, manfaatkan `timer.Reset()` dan panggil `timer.Stop()` di ujung akhir.

2. **Perpustakaan Eksternal (Third-Party Libs) yang Buta-Context**: Aplikasi Go Anda sekuat rantai terlemahnya. Jika Anda memanggil library database lawas (`CGO` atau yang tidak menerima parameter `context.Context`), lalu database server asing (remote) tersebut *hang* dan tak menjawab packet TCP (tanpa mengirim sinyal Reset), goroutine Go pembungkus library tersebut akan beku menanti dalam blok *OS syscall* hingga ajal. Ini melampaui kemampuan context Go murni, menyebabkan *undeniable goroutine leak*.
   - *Defensive*: Secara arsitektural bungkus panggilan third-party kolot (legacy) tersebut dalam goroutine terpisah dan *tinggalkan* secara asinkron jika *timeout context caller* tersentuh. Laporkan (submit PR) kepada maintainer package tersebut untuk beralih ke `API` yang *context-aware*. Perlu diakui goroutine pembungkus aslinya tetap bocor (tersendat pada OS level), namun setidaknya aplikasi utama Go Anda terselamatkan dari kebuntuan berantai.

3. **HTTP Server Blocked on ResponseWriter**: Jika client (browser/aplikasi HP user) secara brutal memutuskan (drop/abort) koneksi HTTP saat server Go sedang sibuk mengompilasi dan mengunduhkan (streaming chunking) data ukuran besar lewat `http.ResponseWriter`, goroutine Writer berpotensi terblokir menunggu soket jaringan merespons kesiapan buffer TCP.
   - *Defensive*: Selalu sadari parameter *context* bawaan pada interface Request HTTP `req.Context()`. Patuhi sinyal `<-ctx.Done()` setiap selesai menulis sekumpulan blok data kecil (chunks) pada siklus loop panjang. Fungsi framework akan meng-cancel context ini seketika saat client terdeteksi memutuskan TCP koneksinya di layer bawah.
