# System Programming Linux: Inotify (File System Watcher) di Go

## 1. Konsep dan Internals

`inotify` adalah subsistem kernel Linux yang memantau sistem file dan mengirimkan notifikasi (event) ke aplikasi setiap kali terjadi perubahan (seperti file dibuat, diubah, dihapus, atau dipindah). Di Go, library standar standar yang menjadi *de-facto* adalah `github.com/fsnotify/fsnotify`, yang merupakan *wrapper* lintas *platform* (menggunakan `inotify` di Linux, `kqueue` di BSD/macOS, dan `ReadDirectoryChangesW` di Windows). 

Namun, memahami *internals* dari `inotify` Linux sangat penting karena ada batasan khusus *platform*. Inotify bekerja dengan menyediakan *File Descriptor* (FD) master kepada aplikasi (didapat dari *syscall* `inotify_init1()`). Aplikasi kemudian memanggil `inotify_add_watch()` untuk meregistrasikan *path* direktori atau file ke dalam FD tersebut beserta mask bit (misal: `IN_MODIFY | IN_CREATE`). Kernel akan memompa struct event `inotify_event` ke dalam FD ini, yang kemudian dibaca (*read*) oleh goroutine Go.

**Kelemahan dan Keterbatasan Utama Inotify:**
1.  **Tidak Rekursif (Non-recursive):** Jika Anda memantau `/var/log`, Anda hanya akan mendapat notifikasi untuk file tepat di dalam direktori itu. Jika sub-direktori dibuat (`/var/log/nginx/`), Anda TIDAK akan mendapat event dari dalamnya kecuali aplikasi Anda mendeteksi pembuatan folder tersebut dan memanggil `inotify_add_watch` lagi.
2.  **Batas Maksimal Watcher (`fs.inotify.max_user_watches`):** Setiap *watch* memakan resource kernel. Biasanya dilimit (default Linux seringkali 8192). Jika melebihi batas ini (misal memantau *node_modules* frontend), program akan gagal dengan error `ENOSPC` (No space left on device).

## 2. Diagram ASCII: Alur Kerja Inotify

```text
+---------------------+           +---------------------------------+
|   Go Application    |           |          Linux Kernel           |
|                     |           |                                 |
| 1. inotify_init()   |---------->| Creates Inotify Instance (FD)   |
|                     |           |                                 |
| 2. add_watch(path)  |---------->| Registers path to FD            |
+--------+------------+           +------------------+--------------+
         |                                           ^
         | 4. read(FD) blocks/waits                  | 3. File changes
         V                                           |    in VFS (ext4)
+------------------------------------------+         |
| Watcher Event Loop                       |<--------+
|                                          |
| [inotify_event struct]                   |
| - wd (Watch Descriptor ID)               |
| - mask (IN_CREATE, IN_DELETE, etc)       |
| - len (Length of name)                   |
| - name (Filename string)                 |
+------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengabaikan `ENOSPC` saat Menambah Watcher (Khususnya Rekursif)

Developer sering membuat fungsi rekursif yang melakukan `filepath.Walk` untuk menambahkan *watch* pada setiap sub-direktori. Tanpa penanganan error yang baik, aplikasi akan *panic* saat *sysctl limit* tercapai, membuat aplikasi lumpuh (misalnya hot-reload pada development server).

```go
// ❌ BAD: Mengabaikan error dan memaksakan add watch
filepath.Walk("/home/user/project", func(path string, info os.FileInfo, err error) error {
    if info.IsDir() {
        // Jika melebihi 8192 folder, Add() me-return error ENOSPC.
        // Jika tidak di-handle, file baru di dalam direktori sisa tidak akan terdeteksi.
        watcher.Add(path) 
    }
    return nil
})
```
**Why dangerous:** Hilangnya sinkronisasi (*Lost Events*). Sistem mengira semua file sedang dipantau padahal ratusan direktori gagal ditambahkan karena limit kernel, membuat sinkronisasi data gagal diam-diam.

```go
// ✅ GOOD: Handle ENOSPC spesifik, fallback ke Polling atau alert User
err := watcher.Add(path)
if err != nil {
    if strings.Contains(err.Error(), "no space left on device") {
        log.Fatalf("Inotify limit reached! Please run: sysctl fs.inotify.max_user_watches=524288")
    }
    log.Printf("Gagal watch %s: %v", path, err)
}
```

### ❌ Anti-Pattern 2: Blokir Event Loop dengan Pemrosesan Berat

Channel `watcher.Events` memiliki *buffer* bawaan. Jika *goroutine* yang membacanya memanggil pemrosesan *blocking* (misal: panggil API HTTP lambat atau *query* DB) langsung di dalam loop, channel akan penuh. Saat channel penuh, library `fsnotify` (atau *kernel FD*) tidak dapat menaruh *event* baru, mengakibatkan hilangnya notifikasi (*Event Drops*).

```go
// ❌ BAD: Blocking event loop
for event := range watcher.Events {
    if event.Op&fsnotify.Write == fsnotify.Write {
        // Jika UploadToS3 memakan waktu 5 detik, event dari file lain akan tertahan dan berpotensi dropped.
        UploadToS3(event.Name) 
    }
}
```
**Why dangerous:** Aplikasi kehilangan event penting (file terhapus, dll) yang terjadi selama jeda blokade, menyebabkan *state* aplikasi tidak lagi sinkron dengan kondisi *filesystem* asli.

```go
// ✅ GOOD: Pindahkan pemrosesan ke Worker/Goroutine dan debounce
for event := range watcher.Events {
    if event.Op&fsnotify.Write == fsnotify.Write {
        // Lempar ke goroutine atau queue
        go UploadToS3Async(event.Name)
    }
}
```

## 4. Edge Cases & Defensive Programming

1.  **Vim / Editor "Save" Behavior (Rename Pattern):**
    Saat memantau modifikasi (`IN_MODIFY`), banyak *text editor* seperti Vim tidak menulis langsung ke file. Mereka membuat file sementara (`.txt.swp`), menulis ke sana, lalu melakukan *Rename* (Move) menimpa file asli. Ini memicu `IN_CREATE` atau `IN_MOVED_TO` alih-alih `IN_MODIFY`. Aplikasi Anda harus *defensive* dengan memantau berbagai kombinasi *Op* untuk mendeteksi sebuah file "disimpan".
2.  **Symlink dan Pemantauan Direktori:**
    Inotify tidak mengikuti (resolve) *symlink* secara *default*. Jika direktori `/var/log/app` adalah symlink ke `/mnt/data/log`, memantau `/var/log/app` mungkin tidak memberikan hasil yang diinginkan jika opsi `IN_DONT_FOLLOW` aktif di tingkat kernel. Selalu berikan nilai absolut (menggunakan `filepath.EvalSymlinks`) sebelum registrasi watcher.
3.  **The "Write Burst" (Debouncing):**
    Menulis file besar atau mengekstrak tarball akan menghasilkan ribuan event `Write` dalam milidetik. Menjalankan *action* (seperti compile) pada setiap *event* akan meruntuhkan CPU. Gunakan pola *Debounce* untuk mengakumulasi *event* selama (misal) 300ms sebelum memicu aksi tunggal.

## 5. Production-Ready Go Code & Unit Test

Berikut adalah *wrapper* untuk `fsnotify` yang mengimplementasikan *Debounce* untuk mengatasi masalah *Write Burst* dan melindungi *event loop* agar tidak terblokir.

```go
package watcher

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DebouncedWatcher memantau file dengan mekanisme debounce.
type DebouncedWatcher struct {
	watcher    *fsnotify.Watcher
	debounceMs time.Duration
	callbacks  map[string]func(string)
	mu         sync.RWMutex
}

// NewDebouncedWatcher membuat watcher baru
func NewDebouncedWatcher(debounce time.Duration) (*DebouncedWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("failed to create watcher: %w", err)
	}

	return &DebouncedWatcher{
		watcher:    w,
		debounceMs: debounce,
		callbacks:  make(map[string]func(string)),
	}, nil
}

// Add mendaftarkan path dan fungsi callback ketika terjadi perubahan.
func (dw *DebouncedWatcher) Add(path string, onEvent func(string)) error {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}

	dw.mu.Lock()
	dw.callbacks[absPath] = onEvent
	dw.mu.Unlock()

	return dw.watcher.Add(absPath)
}

// Start menjalankan event loop di background. Blokir sampai context di-cancel.
func (dw *DebouncedWatcher) Start(ctx context.Context) {
	defer dw.watcher.Close()

	// Map untuk melacak timer aktif per file (Debounce state)
	timers := make(map[string]*time.Timer)
	var mu sync.Mutex

	for {
		select {
		case <-ctx.Done():
			return // Keluar secara graceful

		case event, ok := <-dw.watcher.Events:
			if !ok {
				return
			}

			// Kami tertarik dengan pembuatan, modifikasi, dan penimpaan (rename)
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename) != 0 {
				mu.Lock()
				// Jika ada timer yang berjalan untuk file ini, reset timernya
				if t, exists := timers[event.Name]; exists {
					t.Stop()
				}
				
				// Buat timer baru. Callback dipanggil setelah jeda hening (debounce).
				timers[event.Name] = time.AfterFunc(dw.debounceMs, func() {
					dw.mu.RLock()
					callback, exists := dw.callbacks[event.Name]
					if !exists {
						// Fallback cek direktori induknya jika file di dalam dir yang di-watch
						parent := filepath.Dir(event.Name)
						callback, exists = dw.callbacks[parent]
					}
					dw.mu.RUnlock()

					if exists {
						// Jalankan di goroutine terpisah, TIDAK block event loop utama!
						go callback(event.Name) 
					}
					
					mu.Lock()
					delete(timers, event.Name)
					mu.Unlock()
				})
				mu.Unlock()
			}

		case err, ok := <-dw.watcher.Errors:
			if !ok {
				return
			}
			fmt.Printf("watcher error: %v\n", err)
		}
	}
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestDebouncedWatcher(t *testing.T) {
	tmpDir := t.TempDir()
	
	// Gunakan debounce pendek 100ms
	dw, err := NewDebouncedWatcher(100 * time.Millisecond)
	if err != nil {
		t.Fatalf("Gagal inisialisasi: %v", err)
	}

	var counter int
	var mu sync.Mutex
	
	// Daftarkan callback
	err = dw.Add(tmpDir, func(changedFile string) {
		mu.Lock()
		counter++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("Gagal add dir: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	
	// Jalankan watcher di background
	go dw.Start(ctx)
	
	// Beri waktu watcher untuk siap
	time.Sleep(50 * time.Millisecond)

	// SIMULASI WRITE BURST: Menulis 5 kali dalam waktu yang sangat singkat
	testFile := filepath.Join(tmpDir, "burst.txt")
	for i := 0; i < 5; i++ {
		// Gunakan WriteFile bawaan untuk tes simpel (akan trigger inotify Create/Write)
		err := os.WriteFile(testFile, []byte(fmt.Sprintf("line %d", i)), 0644)
		if err != nil {
			t.Fatalf("Gagal menulis file: %v", err)
		}
		// Jeda sangat tipis, jauh di bawah debounce threshold
		time.Sleep(10 * time.Millisecond)
	}

	// Tunggu sampai periode debounce selesai (100ms) + buffer
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	finalCount := counter
	mu.Unlock()

	// Walaupun ada 5x penulisan, event harusnya did-debounce menjadi HANYA 1 pemanggilan
	if finalCount != 1 {
		t.Errorf("Expected debounce to yield 1 event callback, got %d", finalCount)
	}
}
```
