# System Programming Linux: Cgroups v2 & Namespaces di Go

## 1. Konsep dan Internals

Container (seperti Docker atau Podman) sebenarnya bukanlah entitas kelas satu (first-class citizen) di dalam kernel Linux. Container dibangun dari dua pilar utama kernel: **Namespaces** (untuk isolasi visibilitas) dan **Control Groups / Cgroups** (untuk pembatasan sumber daya).

**Namespaces (Isolasi Lingkungan):**
Namespaces membatasi apa yang bisa *dilihat* oleh sebuah proses. Jika proses berjalan di namespace PID terpisah, ia merasa dirinya adalah PID 1 (init), terisolasi dari proses di host. Go menyediakan dukungan kelas satu untuk membuat namespace baru saat mem-fork proses menggunakan *SysProcAttr* di package `syscall`.
Tipe Namespace utama: PID (Process ID), Mount (Filesystem), Network (Interfaces/Routing), UTS (Hostname), IPC (Inter-Process Communication), dan User (UID/GID).

**Cgroups v2 (Isolasi Sumber Daya):**
Cgroups membatasi apa yang bisa *digunakan* oleh sebuah proses (CPU, Memori, I/O, dll). Cgroups v2 (Unified Hierarchy) adalah standar modern yang menggantikan Cgroups v1. Berbeda dengan v1 dimana resource (cpu, memory) memiliki hierarki tree terpisah, di v2 hanya ada satu struktur hierarki tunggal yang berada di `/sys/fs/cgroup`. Proses mendaftar dengan menulis PID-nya ke file `cgroup.procs`, lalu batasan ditulis ke file seperti `memory.max` atau `cpu.max`.

### Kernel Data Structures (Deep Internals)
Di level kernel Linux, setiap proses direpresentasikan oleh `task_struct`. Untuk mengelola namespaces dan cgroups, kernel tidak menduplikasi struktur, melainkan menggunakan pointer terpisah:
- **`nsproxy`**: Pointer dalam `task_struct` yang merujuk ke himpunan namespace proses. Ketika proses di-*clone* dengan `CLONE_NEWPID`, `nsproxy` akan disalin (Copy-on-Write) dan diubah penunjuk PID namespace-nya ke instance baru.
- **`css_set` (Cgroup Subsystem State Set)**: Pointer dalam `task_struct` untuk memetakan proses ke dalam hierarki cgroup. Berbeda dengan V1 yang menggunakan banyak root/hierarchy, V2 menggunakan **Unified Hierarchy** dimana `css_set` memetakan langsung ke satu posisi node di tree cgroup v2.

```text
Kernel Space Representation
+-------------------------------------------------------------+
| task_struct (PID 1234)                                      |
|  ├── pid: 1234                                              |
|  ├── nsproxy * ------------------+                          |
|  |                               v                          |
|  |                     +-------------------+                |
|  |                     | struct nsproxy    |                |
|  |                     |  - pid_ns_for_... | -> [PID NS X]  |
|  |                     |  - mnt_ns         | -> [MNT NS Y]  |
|  |                     +-------------------+                |
|  |                                                          |
|  └── cgroups * ------------------+                          |
|                                  v                          |
|                        +-------------------+                |
|                        | struct css_set    |                |
|                        |  - cgroup_node    | -> [/my_app]   |
|                        +-------------------+                |
+-------------------------------------------------------------+
```

## 2. Diagram ASCII: Container Internals

```text
Host OS (Root Namespace)
+-------------------------------------------------------------+
| /sys/fs/cgroup/                                             |
| ├── cgroup.procs (Host PIDs)                                |
| ├── memory.max (Max: unlimited)                             |
| └── my_container/ (Cgroups v2 Sub-tree)                     |
|     ├── cgroup.procs (PID 1234, 1235)  <-- Container PIDs   |
|     └── memory.max (Max: 500MB)                             |
|                                                             |
+-------------------------------------------------------------+
                              |
                     Syscall: clone() with CLONE_NEWPID | CLONE_NEWNS
                              V
+-------------------------------------------------------------+
| Isolated Environment (Container)                            |
|                                                             |
|  [PID Namespace]                                            |
|  PID 1: /bin/app (Mapped to Host PID 1234)                  |
|                                                             |
|  [Mount Namespace]                                          |
|  / (Root) -> /var/lib/containers/my_container/rootfs        |
+-------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Tidak Melepas (Unmount) RootFS Sebelum Chroot

Saat membuat Mount Namespace (`CLONE_NEWNS`), *best-practice* adalah melakukan *pivoting root* atau `chroot`. Kesalahan fatal yang sering terjadi adalah sekadar melakukan `chroot` ke direktori baru tanpa memutus dependensi mount lama dari sistem host, sehingga proses yang terisolasi secara teori masih bisa memanjat keluar jika ia berhasil menemukan *file descriptor* yang mengarah ke host.

```go
// ❌ BAD: Hanya chroot tanpa mount ulang
cmd := exec.Command("sh")
cmd.SysProcAttr = &syscall.SysProcAttr{
    Cloneflags: syscall.CLONE_NEWNS,
}
// Di dalam container: syscall.Chroot("/new/rootfs") 
// Jika attacker punya cap_sys_chroot, dia bisa keluar!
```
**Why dangerous:** Ini adalah kerentanan *Container Breakout*. Penyerang yang mendapat akses `root` di dalam container dapat memanipulasi direktori untuk keluar dari `chroot` dan mengakses host secara keseluruhan.

```go
// ✅ GOOD: Menggunakan pivot_root atau mount MS_BIND private
// 1. Mount folder rootfs ke dirinya sendiri agar menjadi mount point valid
syscall.Mount("rootfs", "rootfs", "bind", syscall.MS_BIND|syscall.MS_REC, "")
// 2. Buat subfolder rootfs/oldroot
// 3. syscall.PivotRoot("rootfs", "rootfs/oldroot")
// 4. syscall.Unmount("/oldroot", syscall.MNT_DETACH)
// 5. syscall.Chdir("/")
```
*(Catatan: Langkah di atas dijalankan sebagai instruksi pertama di dalam anak proses).*

### ❌ Anti-Pattern 2: Menulis ke File Cgroups v2 Tanpa `os.OpenFile` yang Benar

Menulis file `/sys/fs/cgroup/my_app/memory.max` sangat sensitif. Menggunakan alat seperti `ioutil.WriteFile` atau `os.WriteFile` sering memicu isu *race condition* atau error `EBUSY` jika penulisan tidak atomik atau permission tidak cocok.

```go
// ❌ BAD: Menggunakan os.WriteFile untuk manipulasi cgroup
err := os.WriteFile("/sys/fs/cgroup/my_app/cgroup.procs", []byte("1234"), 0644)
if err != nil {
    // Sering gagal jika proses terlalu cepat atau string punya newline ekstra
}
```
**Why dangerous:** Kegagalan ini sering diabaikan dan membuat proses tetap berjalan tanpa batasan (unlimited). Jika proses ini *memory leak*, host akan mengalami *Kernel Panic (Out of Memory)*.

```go
// ✅ GOOD: Buka dengan WriteOnly dan Sync
f, err := os.OpenFile("/sys/fs/cgroup/my_app/cgroup.procs", os.O_WRONLY|os.O_TRUNC|os.O_SYNC, 0)
if err != nil {
    log.Fatal(err)
}
defer f.Close()
// Tulis nilai bersih tanpa newline, dan pastikan Sync
_, err = f.WriteString("1234")
```

### ❌ Anti-Pattern 3: Mengabaikan "Zombie Process" Reaping saat Menjadi PID 1

Ketika membuat container dan menspesifikasikan `CLONE_NEWPID`, proses anak pertama yang dieksekusi akan mendapatkan PID 1 di dalam namespace tersebut. Dalam Linux, PID 1 memiliki tanggung jawab khusus: ia harus me-reap (memanen status) child process yang mati (orphaned). Jika Go program hanya menjalankan tugas utama dan mengabaikan `SIGCHLD`, sistem akan dipenuhi oleh "zombie processes" yang mengonsumsi *process table*.

```go
// ❌ BAD: Berjalan sebagai PID 1 tapi tidak menangani SIGCHLD
func runAsPID1() {
    // Menjalankan sub-proses dan lupa Wait()
    cmd := exec.Command("sleep", "1")
    cmd.Start()
    // Ketika sleep selesai, ia menjadi zombie karena parent (kita) tidak memanggil cmd.Wait()
}
```
**Why dangerous:** Proses zombie tidak memakan memori/CPU secara langsung, tetapi mereka mengonsumsi Process ID (PID). Jika batas PID sistem tercapai, host/container tidak dapat lagi meluncurkan proses baru (Resource Exhaustion/Denial of Service).

```go
import "os/signal"

// ✅ GOOD: Menangkap SIGCHLD dan me-reap child process (atau menggunakan init system seperti 'tini')
func runAsPID1WithReaper() {
    sigs := make(chan os.Signal, 1)
    // SIGCHLD dikirim ketika child berhenti
    signal.Notify(sigs, syscall.SIGCHLD)
    
    go func() {
        for range sigs {
            var wstatus syscall.WaitStatus
            // Reap semua zombie non-blocking (WNOHANG)
            for {
                pid, err := syscall.Wait4(-1, &wstatus, syscall.WNOHANG, nil)
                if err != nil || pid <= 0 {
                    break
                }
            }
        }
    }()
    
    // ... jalankan aplikasi utama ...
}
```

## 4. Edge Cases & Defensive Programming

1.  **Cgroup v2 Delegation Issues:**
    Pada cgroup v2, untuk mengizinkan non-root *user* memanajemen sub-cgroup, kita harus mengaktifkan *delegation* di file `cgroup.subtree_control`. Jika kita mencoba membuat sub-cgroup tanpa *controller* memori aktif di *parent*, file `memory.max` tidak akan ada di dalam sub-cgroup. Program Go harus selalu mengecek keberadaan direktori dan status `subtree_control`.
    
2.  **OOM Killer Trap (cgroup.events):**
    Saat memori container melebihi batas, kernel akan menghentikan (SIGKILL) proses di dalamnya secara brutal (OOM Killer). Daemon Go di host dapat memonitor kejadian ini tanpa polling dengan menggunakan `epoll` atau `inotify` pada file `cgroup.events` di direktori cgroup v2 tersebut, untuk meluncurkan ulang container dengan gracefully.

3.  **UID/GID Mapping Gagal di User Namespace:**
    Saat menggunakan `CLONE_NEWUSER`, container akan menganggap UID di dalamnya adalah `0` (root), padahal di host ia berjalan sebagai UID 1000. Jika Go tidak menspesifikasikan `UidMappings` di `SysProcAttr`, proses anak tidak memiliki *permission* untuk membaca filenya sendiri.
    **Implementation Detail:** Set atribut mapping secara eksplisit sebelum start cmd:
    `cmd.SysProcAttr.UidMappings = []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}}`

4.  **Race Condition pada Cgroups Cleanup (EBUSY):**
    Saat mematikan container, kernel tidak langsung menghapus struktur cgroup jika masih ada zombie atau page cache memori aktif yang menahan referensi cgroup tersebut. Penghapusan menggunakan `rmdir` (atau `os.Remove`) akan mengembalikan error `EBUSY`.
    **Defensive Strategy:** Terapkan mekanisme retry eksponensial (exponential backoff) pada fungsi `Cleanup()` dan pastikan untuk me-kill PID yang tersisa di `cgroup.procs`.

## 5. Production-Ready Go Code & Unit Test

Kode berikut mensimulasikan peluncuran sebuah *child process* terisolasi yang di-*throttle* CPU dan memorinya via Cgroups v2 dan diisolasi dengan PID & UTS Namespace.

```go
package container

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// CgroupV2Manager mengelola resource limits
type CgroupV2Manager struct {
	basePath string
	group    string
}

func NewCgroupV2Manager(group string) (*CgroupV2Manager, error) {
	// Pastikan kita berada di OS berbasis systemd / cgroup v2
	base := "/sys/fs/cgroup"
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, fmt.Errorf("cgroups v2 tidak didukung atau belum di-mount")
	}

	path := filepath.Join(base, group)
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, fmt.Errorf("gagal membuat cgroup dir: %w", err)
	}

	return &CgroupV2Manager{basePath: base, group: group}, nil
}

// SetMemoryLimit mengatur batas maksimum memory di memory.max
func (c *CgroupV2Manager) SetMemoryLimit(bytes int64) error {
	path := filepath.Join(c.basePath, c.group, "memory.max")
	return c.writeToFile(path, strconv.FormatInt(bytes, 10))
}

// AddProcess memasukkan PID ke dalam cgroup.procs
func (c *CgroupV2Manager) AddProcess(pid int) error {
	path := filepath.Join(c.basePath, c.group, "cgroup.procs")
	return c.writeToFile(path, strconv.Itoa(pid))
}

// Cleanup menghapus cgroup jika kosong
func (c *CgroupV2Manager) Cleanup() error {
	path := filepath.Join(c.basePath, c.group)
	return os.Remove(path) // Akan gagal jika masih ada proses di dalamnya (EBUSY)
}

func (c *CgroupV2Manager) writeToFile(path, data string) error {
	// Defensive: Gunakan WRONLY dan TRUNC agar tidak ada sisa data
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC|os.O_SYNC, 0)
	if err != nil {
		return fmt.Errorf("open file %s error: %w", path, err)
	}
	defer f.Close()

	if _, err := f.WriteString(data); err != nil {
		return fmt.Errorf("write file %s error: %w", path, err)
	}
	return nil
}

// LaunchIsolatedProcess meluncurkan sebuah shell dengan namespace
func LaunchIsolatedProcess(ctx context.Context, cg *CgroupV2Manager, cmdPath string, args ...string) (*exec.Cmd, error) {
	cmd := exec.CommandContext(ctx, cmdPath, args...)
	
	// Isolasi: PID (Proses merasa dia PID 1) dan UTS (Bisa punya hostname sendiri)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWPID | syscall.CLONE_NEWUTS,
	}

	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("gagal start cmd: %w", err)
	}

	// Masukkan PID baru (dari host perspective) ke dalam Cgroup V2
	if err := cg.AddProcess(cmd.Process.Pid); err != nil {
		// Cleanup process karena gagal masuk cgroup
		cmd.Process.Kill()
		return nil, fmt.Errorf("gagal memasukkan pid ke cgroup: %w", err)
	}

	return cmd, nil
}

// -------------------------------------------------------------------------
// Unit Test
// -------------------------------------------------------------------------
func TestCgroupAndNamespace(t *testing.T) {
	// Tes ini hanya bisa berjalan di Linux sebagai root.
	// Jika bukan root, skip dengan graceful.
	if os.Getuid() != 0 {
		t.Skip("Test membutuhkan akses root (sudo) untuk manipulasi Cgroups & Namespaces")
	}

	cg, err := NewCgroupV2Manager("test_golang_cg")
	if err != nil {
		t.Fatalf("Gagal inisialisasi cgroup: %v", err)
	}
	defer cg.Cleanup() // Pastikan folder terhapus

	// Limit memori ke 50 MB
	if err := cg.SetMemoryLimit(50 * 1024 * 1024); err != nil {
		t.Fatalf("Gagal set memory limit: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Menjalankan 'sleep' di dalam namespace terisolasi
	cmd, err := LaunchIsolatedProcess(ctx, cg, "sleep", "1")
	if err != nil {
		t.Fatalf("Launch failed: %v", err)
	}

	// Tunggu sampai perintah selesai
	if err := cmd.Wait(); err != nil {
		t.Errorf("Proses tidak berhenti secara wajar: %v", err)
	}
}

func TestCgroupManager_MissingMount(t *testing.T) {
	// Tes ini melakukan simulasi (mock) ketika /sys/fs/cgroup tidak ada.
	// Karena kita tidak dapat memanipulasi host cgroup dalam test tanpa side effect,
	// kita ubah basePath ke direktori sementara yang kosong.
	tmpDir := t.TempDir()
	
	manager := &CgroupV2Manager{basePath: filepath.Join(tmpDir, "unmounted_sys_fs_cgroup"), group: "test_grp"}
	
	err := manager.SetMemoryLimit(1024)
	if err == nil {
		t.Error("Diharapkan gagal ketika path cgroup tidak ada, tapi berhasil")
	}
}

func TestCgroupManager_InvalidWrite(t *testing.T) {
	tmpDir := t.TempDir()
	groupName := "test_grp"
	manager := &CgroupV2Manager{basePath: tmpDir, group: groupName}
	
	// Create cgroup dir mock
	os.MkdirAll(filepath.Join(tmpDir, groupName), 0755)
	
	// Create dummy cgroup.procs tapi kita akan mock permission agar write gagal
	procsFile := filepath.Join(tmpDir, groupName, "cgroup.procs")
	os.WriteFile(procsFile, []byte(""), 0400) // Read-only permission

	err := manager.AddProcess(999999) // PID dummy
	if err == nil {
		t.Error("Diharapkan gagal memasukkan PID karena write permissions mock, tapi sukses")
	}
}
```
