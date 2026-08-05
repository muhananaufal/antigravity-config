# Client-Go & Informers (Kubernetes Controller Foundations)

> **Berlaku:** Go 1.21+ · `k8s.io/client-go` v0.29+ · **Lihat juga:** `cloud_native_k8s_operators/controller_runtime_reconciler.md` · `cloud_native_k8s_operators/custom_resource_definition.md` · `concurrency/data_race_detection.md` · `runtime_internals/gc_mark_sweep_internals.md`

## 1. Konsep Utama & Internals

Sebelum framework modern seperti `controller-runtime` mengabstraksi segalanya, dasar dari arsitektur ekosistem Operator (dan kontroler K8s pada umumnya) ditenagai murni oleh library `k8s.io/client-go`. Memahami `client-go` berarti memahami fondasi (urat nadi) mengapa Kubernetes sangat cepat bereaksi, namun sangat irit I/O disk (etcd).

Pilar Kunci `client-go`:
1. **API Machinery (REST Client)**: Komunikasi TCP mentah HTTPs ke Kube-API. Operasi CRUD (Create, Update, Get, Delete) biasa. (Mahal, berpotensi mencekik/Throttling K8s API jika me-loop `GET` terlalu masif).
2. **Informer (Local In-Memory Cache)**: Pahlawan K8s sesungguhnya. Mekanisme yang mem-*watch* (gRPC multiplexing events) perubahan dari server lalu secara pasif men-sinkronisasinya ke dalam RAM komputer lokal (Worker Node / Pod Controller). Jika aplikasi memanggil `Informer.Lister().Get()`, operasinya berkecepatan `O(1)` murni RAM, tanpa menyebrang kabel *network* secuilpun!
3. **WorkQueue (RateLimiting Queue)**: Informer menumpahkan notifikasi *Add/Update/Delete* secepat kilat. Tapi *Business Logic Controller* Anda lambat. Maka *WorkQueue* mengantrekan *key* objek (Namespace/Name), men-Deduplikasi jika banyak *event* numpuk, dan merilisnya ke *Worker Threads* secara elegan untuk diolah dengan *Exponential Backoff*.

## 2. Diagram ASCII: Arsitektur Client-Go Informer & WorkQueue

```text
    [ Kubernetes API Server ] <------------+ (Watch Connection)
             |                             |
             v (Add, Mod, Del Events)      |
    +--------------------------------------+
    |             INFORMER                 |
    |                                      |
    |  +-------------+    +-------------+  |
    |  | Delta FIFO  |--->| Local Cache |  |  <--- (O(1) Memory Store: Lister)
    |  | Queue       |    | (ThreadSafe)|  |
    |  +-------------+    +-------------+  |
    |          |                           |
    +----------|---------------------------+
               v
      (ResourceEventHandler Funcs)
     OnAdd() / OnUpdate() / OnDelete()
               |
               v (Hanya Menyisipkan "namespace/name" string)
    +--------------------------------------+
    |      RateLimiting WorkQueue          | --- (Deduplikasi Event)
    +--------------------------------------+
               |
               v (Pop)
    +--------------------------------------+
    |     Worker Goroutines (1..N)         |
    |                                      |
    | 1. Ambil "namespace/name" dari antrean
    | 2. Panggil Lister.Get() (Cari di Local Cache)
    | 3. Bandingkan Actual vs Desired State
    | 4. Update API K8s (jika butuh)       |
    +--------------------------------------+
```

## 3. Production-Ready Go Code (Native Informer Controller)

Berikut implementasi murni *bare-metal* k8s controller tanpa *magic* kubebuilder. Sangat vital untuk dipahami mekanika internalnya.

```go
package native_informers

import (
	"context"
	"fmt"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/informers"
	coreinformers "k8s.io/client-go/informers/core/v1"
	"k8s.io/client-go/kubernetes"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
)

// Controller struktur utama.
type Controller struct {
	clientset kubernetes.Interface
	
	// Lister menyediakan pembacaan data super cepat (O(1)) dari Local Memory
	podLister corelisters.PodLister
	// HasSynced memblokir worker run() sampai Sync/Tarik-Awal memori kelar
	podsSynced cache.InformerSynced
	
	// WorkQueue antrean RateLimit yang aman-konkurensi
	workqueue workqueue.RateLimitingInterface
}

func NewController(clientset kubernetes.Interface, podInformer coreinformers.PodInformer) *Controller {
	c := &Controller{
		clientset:  clientset,
		podLister:  podInformer.Lister(),
		podsSynced: podInformer.Informer().HasSynced,
		workqueue:  workqueue.NewNamedRateLimitingQueue(workqueue.DefaultControllerRateLimiter(), "PodsQueue"),
	}

	// Daftarkan 'Event Listeners' ke Informer.
	// PENTING: Function ini JANGAN PERNAH dipakai mengeksekusi logika berat/cloud API!
	// Hanya bertugas menaruh KEY (String) ke dalam antrean (WorkQueue).
	podInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			c.enqueuePod(obj)
		},
		UpdateFunc: func(old, new interface{}) {
			// Optimisasi (Edge Case): Abaikan re-sync berkala jika ResourceVersion belum berubah!
			oldPod := old.(*corev1.Pod)
			newPod := new.(*corev1.Pod)
			if oldPod.ResourceVersion == newPod.ResourceVersion {
				return
			}
			c.enqueuePod(new)
		},
		DeleteFunc: func(obj interface{}) {
			c.enqueuePod(obj) // Event penghapusan, tetapkan re-cek state untuk finalizer
		},
	})

	return c
}

// enqueuePod mengekstrak kunci referensi unik dan memasukannya ke Queue.
func (c *Controller) enqueuePod(obj interface{}) {
	// Menghasilkan format "namespace/name"
	key, err := cache.MetaNamespaceKeyFunc(obj)
	if err != nil {
		utilruntime.HandleError(err)
		return
	}
	c.workqueue.Add(key) // Add akan otomatis men-deduplikasi item di Queue!
}

// Run menjalankan N worker goroutine terus menerus.
func (c *Controller) Run(threadiness int, stopCh <-chan struct{}) error {
	defer utilruntime.HandleCrash()
	defer c.workqueue.ShutDown() // Pastikan queue mati jika pod disuruh stop

	log.Println("Starting Pod Controller")

	// 1. Block sampai Cache In-Memory awal (Lister) disingkron total dengan Etcd K8s
	log.Println("Waiting for informer caches to perform initial synchronization...")
	if ok := cache.WaitForCacheSync(stopCh, c.podsSynced); !ok {
		return fmt.Errorf("failed to synchronize caches with kubernetes")
	}

	// 2. Luncurkan worker
	log.Println("Starting workers...")
	for i := 0; i < threadiness; i++ {
		go wait.Until(c.runWorker, time.Second, stopCh)
	}

	log.Println("Controller running stably...")
	<-stopCh // Tunggu Signal Kill
	log.Println("Shutting down Pod Controller")

	return nil
}

func (c *Controller) runWorker() {
	// Loop Pop-Proses tanpa henti.
	for c.processNextWorkItem() {
	}
}

// processNextWorkItem menarik 1 string KEY dari antrean
func (c *Controller) processNextWorkItem() bool {
	obj, shutdown := c.workqueue.Get()
	if shutdown {
		return false
	}

	// Wrap agar bila Panic, tidak membunuh seluruh pod. Dan memastikan item di-Done() (Dihapus dari antrean).
	err := func(obj interface{}) error {
		defer c.workqueue.Done(obj)
		
		key, ok := obj.(string)
		if !ok {
			c.workqueue.Forget(obj) // Item ngaco, hapus retry-nya.
			return fmt.Errorf("expected string in workqueue but got %#v", obj)
		}
		
		// 3. JALANKAN REKONSILIASI UTAMA
		if err := c.syncHandler(key); err != nil {
			// Kalau GAGAL, kirim ulang kembali ke Queue (AddRateLimited) agar terjadi Exponential Backoff!
			c.workqueue.AddRateLimited(key)
			return fmt.Errorf("error synchronizing '%s': %s, will be requeued", key, err.Error())
		}
		
		// Kalau BERHASIL, hapus history rate-limit retry yang lalu (Forget)
		c.workqueue.Forget(obj)
		log.Printf("Successfully synchronized Pod '%s'", key)
		return nil
	}(obj)

	if err != nil {
		utilruntime.HandleError(err)
	}
	return true
}

// syncHandler logic bisnis. Disinilah Controller sesungguhnya bersemayam.
func (c *Controller) syncHandler(key string) error {
	namespace, name, err := cache.SplitMetaNamespaceKey(key)
	if err != nil { return err }

	// TAPI, kita ngambil datanya DARI CACHE LOKAL (Lister)! SUPER CEPAT! Bukan get API TCP lambat.
	pod, err := c.podLister.Pods(namespace).Get(name)
	if err != nil {
		if apierrors.IsNotFound(err) {
			// Pod sudah terhapus murni.
			log.Printf("Pod %s already deleted from server.", key)
			return nil
		}
		return err
	}

	// Bisnis Logika: (Misal) Cetak log jika pod mati.
	if pod.Status.Phase == corev1.PodFailed {
		log.Printf("Warning: Pod %s/%s Failed!", pod.Namespace, pod.Name)
		// r.clientset.CoreV1().Pods().Delete(...) // Jika butuh merespon dengan K8s mutasi API.
	}

	return nil // Return nil = sukses.
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Memanggil `Clientset.Get()` Terus-Menerus pada Loop
Tidak memahami esensi In-Memory Cache `Lister`. Saat memodifikasi atau memeriksa resource pendukung, programmer malah menggunakan REST API `Get/List` menembus kabel TCP HTTP berulang kali ke K8s.

```go
// BAD: Rest-API Call K8s yang sangat berat (Disk Etcd hit langsung)
func (c *Controller) syncHandler(key string) {
    // ❌ TCP HTTP Latency (O(N) load on K8s API Server)
    pod, _ := c.clientset.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
}
```

```go
// GOOD: Gunakan Cache Lister (In-Memory murni)
func (c *Controller) syncHandler(key string) {
    // ✅ 0 network call. Ambil pointer langsung dari RAM lokal informers. Kecepatan (O(1)).
    pod, _ := c.podLister.Pods(ns).Get(name)
}
```
**Why dangerous:** API Throttling & Etcd Starvation. Jika ada 500 event update terjadi (misal pod direstart massal), Controller Anda menembakkan 500 request TCP Get dalam 1 detik. API server merespon dengan HTTP 429 Too Many Requests, melumpuhkan aplikasi *monitoring* lain. *Informer Cache* dibuat spesifik untuk menghindari ini!

### ❌ Anti-Pattern 2: Menaruh Logic IO/Blocking di dalam `AddEventHandler` Funcs
Saat K8s merilis event, `AddFunc / UpdateFunc` (ResourceEventHandler) akan dipanggil oleh *Informer Core Thread*.

```go
// BAD: Blocking Informer Thread
informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc: func(obj interface{}) {
        pod := obj.(*corev1.Pod)
        
        // JANGAN! Jika cloud lambat 10s, seluruh Informer Stream Event di Pod Anda MATI macet 10 detik!
        http.Post("https://cloud/logger", pod.Name) 
        
        c.workqueue.Add(key)
    },
})
```

```go
// GOOD: Informer Core Thread harus SEcepat Kilat mengantrekan String saja.
informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc: func(obj interface{}) {
        // Murni RAM (Hitungan Nanosecond). Langsung Return!
        key, _ := cache.MetaNamespaceKeyFunc(obj)
        c.workqueue.Add(key) 
    },
})
// Worker thread terpisah (c.syncHandler) lah yang nantinya mem-pop queue dan mengeksekusi HTTP Post.
```
**Why dangerous:** *Informer Blocked*. Pipa *Delta FIFO Queue* K8s internal yang mensuplai cache event di memori RAM akan menumpuk / membludak, menghabiskan memori Pod OOM, dan menyebabkan status Controller Anda tertinggal (Out of Sync / Stale Data) puluhan menit dari kondisi dunia maya yang sebenarnya.

## 5. Edge Cases & Defensive Programming

1. **Stale Cache pada Objek Termutasi Baru**
   Setelah Controller Anda mengeksekusi update Pod API (misal menyuntikkan annotation ke `clientset.Update()`), di baris berikutnya Anda iseng mencoba membaca *Lister* lagi. Anda akan terkejut: datanya MASIH KUNO (Belum terganti)!
   *Defensive Check:* K8s `Client.Update()` langsung tembus menulis ke etcd database via API. Tetapi, `Informer` membutuhkan latensi beberapa milidetik untuk "merasakan Watch Event" dan memperbarui *Local Cache Lister*-nya di RAM. Selalu kembali (return) saja setelah melakukan mutasi Update. Biarkan Informer K8s pasif mem-*Watch* dan memicu `UpdateFunc` yang dengan sendirinya memasukkan antrean baru ke WorkQueue Anda begitu cache *benar-benar sinkron* dengan etcd.

2. **Panics di Dalam Worker Thread**
   Di K8s, nil pointer panic pada satu objek spesifik (misal label *nil*) sering terjadi. Jika goroutine mem-*panic* di `syncHandler`, tidak hanya worker itu yang mati, seluruh Controller App (Pod) akan padam dan direstart berulang kali (CrashLoop).
   *Defensive Check:* Library K8s client-go sudah menyediakan utilitas `defer utilruntime.HandleCrash()` (seperti di baris Run()). Namun, jauh lebih aman merangkum pemanggilan `c.syncHandler(key)` di dalam fungsi anonim tertutup yang dilindungi *defer recover()* sendiri jika mengeksekusi konversi objek yang rumit.

3. **Informer Resync Period Membanjiri Queue (Thundering Herd)**
   Saat `informers.NewSharedInformerFactory(clientset, 10*time.Minute)`, K8s secara periodik akan mereset dan mem-*flush* SELURUH CACHE, merilis ratusan event `UpdateFunc` PALSU (bukan dari K8s server sungguhan, tapi re-sync routine lokal) walau resource tidak berubah apapun. Ini gunanya untuk men-*heal* data yang mungkin terlewat.
   *Defensive Check:* (Diperagakan di kode `UpdateFunc` atas). Wajib memeriksa `if oldPod.ResourceVersion == newPod.ResourceVersion { return }`. Versi resource K8s HANYA berubah jika etcd server benar-benar bermutasi. Jika versi sama, itu artinya sekadar Notifikasi Event Resync Periodik Hantu dari client-go; ABAIKAN SAJA, jangan antrikan membanjiri WorkQueue agar CPU idle santai!

## Kapan JANGAN Pakai Ini

- **`List` dalam loop alih-alih informer.** Setiap `List` membebani API server dan etcd untuk seluruh cluster. Pola ini tidak menskala melewati beberapa klien, dan efeknya dirasakan tim lain sebelum dirasakan Anda.
- **Memodifikasi objek yang diambil dari cache informer.** Objeknya **dibagi** dengan seluruh konsumen di proses yang sama. Menulisnya adalah data race yang merusak controller lain secara diam-diam. `DeepCopy()` dulu, tanpa kecuali.
- **Informer untuk semua namespace bila hanya butuh satu.** Memori klien sebanding dengan jumlah objek yang di-cache; pada cluster besar itu bisa gigabyte.
- **Mengandalkan cache untuk keputusan yang butuh kesegaran mutlak.** Cache selalu tertinggal sedikit dari API server. Untuk pemeriksaan yang harus akurat pada saat itu juga, baca langsung dengan `APIReader`.
- **Bekerja sebelum `WaitForCacheSync`.** Cache yang belum terisi tampak seperti cluster kosong, dan controller akan mengambil keputusan menghapus atau membuat berdasarkan itu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| API server melambat untuk semua tim | laju `List` dari klien Anda | Polling alih-alih watch |
| Data race yang melibatkan objek Kubernetes | apakah `DeepCopy` dipakai | Objek cache dimodifikasi |
| Memori controller sangat besar | cakupan namespace informer | Meng-cache seluruh cluster |
| Keputusan salah tepat setelah start | `WaitForCacheSync` | Bekerja dengan cache kosong |
| Keputusan berdasarkan data usang | cache vs `APIReader` | Kesegaran cache tidak memadai untuk kasus ini |

```bash
# Throttling sisi klien = terlalu banyak permintaan ke API server
kubectl logs -l control-plane=controller-manager --since=1h | grep -ci 'client-side throttling'

curl -s localhost:8080/metrics | grep -E 'rest_client_requests_total|rest_client_request_duration'

# Memori controller dan apa yang mengisinya
kubectl top pod -l control-plane=controller-manager
go tool pprof -sample_index=inuse_space -top http://localhost:6060/debug/pprof/heap | head -20

go test -race -count=5 ./controllers/...
```
