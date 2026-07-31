# Cloud Native K8s Operators: Controller Runtime Reconciler

## 1. Konsep Utama & Internals

Dalam ekosistem Kubernetes Operator yang dibangun dengan framework `controller-runtime`, `Reconciler` adalah *jantung* atau inti dari arsitektur *control loop*. Tugas utamanya adalah secara kontinu menerapkan pola *level-based reconciliation*: membaca **Desired State** (kondisi yang diinginkan pengguna, biasanya didefinisikan dalam spec Custom Resource Definition / CRD), kemudian membandingkannya dengan **Actual State** (kondisi dunia nyata saat ini dari resource K8s atau infrastruktur cloud eksternal), dan melakukan mutasi untuk menyeimbangkan keduanya.

Satu perbedaan arsitektural krusial: Reconciler K8s **TIDAK** didesain secara *edge-based/event-driven* (misalnya: "Jalankan fungsi X *hanya* jika menerima event CREATE"). Walaupun ada event pemicu (Watch), reconciler K8s adalah state machine yang bersifat *level-triggered*. Reconcile loop hanya tahu bahwa "object Y mungkin telah berubah bentuk". Ia tidak peduli event apa yang memicunya. Tugasnya hanyalah mengamankan bahwa state akhir tercapai (Idempotency).

**Komponen Penting Internal:**
*   **`ctrl.Request`**: Argumen fungsi `Reconcile` hanya berisi Nama dan Namespace dari objek yang memicu rekonsiliasi. *Sengaja* tidak mengirim salinan object utuhnya ke parameter fungsi untuk menghindari *stale object caching* dan insiden konkurensi (Race Condition).
*   **`client.Client`**: Digunakan untuk membaca dan menulis API K8s. Secara default: operasi `Get()` dan `List()` akan membaca data dari *Informer Local Cache* (sangat cepat, O(1), tidak membebani etcd K8s), sedangkan `Create()`, `Update()`, `Delete()`, `Patch()` akan mengirim request tembus langsung ke Kubernetes API Server.
*   **`ctrl.Result`**: Struktur kembalian (Return) yang mendikte antrean (WorkQueue). Mereturn `RequeueAfter` sangat penting untuk melakukan *Exponential Backoff Retry* bila kita melakukan polling ke API Cloud eksternal (misal menunggu Database AWS RDS Provisioned).

## 2. Diagram ASCII: Reconciliation Flow & WorkQueue

```text
    +-------------------------+
    | K8s API Server (etcd)   |
    +-----------+-------------+
                |
                | 1. Watch Events (Create/Update/Delete)
                v
    +-----------+-------------+
    | Informer (Local Cache)  |
    +-----------+-------------+
                |
                | 2. Push to Queue (Hanya Namespace/Name)
                v
    +-----------+-------------+       5. Return ctrl.Result
    | RateLimiting WorkQueue  | <------------------------------------+
    +-----------+-------------+                                      |
                |                                                    |
                | 3. Pop Request (e.g. default/my-db)                |
                v                                                    |
    +-----------+-------------+       +------------------------+     |
    |      RECONCILER         | ----> | ctrl.Result{           | ----+
    |                         |       |   Requeue: true,       |
    |  - Get(Cache)           |       |   RequeueAfter: 30s    |
    |  - Patch/Update(API)    |       | }                      |
    +-----------+-------------+       +------------------------+
                |
                | 4. Compare & Act
                v
    +-----------+-------------+
    | External Cloud API      |
    | (AWS/GCP/Database SaaS) |
    +-------------------------+
```

## 3. Production-Ready Go Code & Unit Tests

Berikut adalah kerangka *Production-Ready Reconciler* lengkap dengan *Finalizer pattern* untuk mengamankan penghapusan resource, proper error handling, idempotency, dan Exponential Backoff.

```go
package controllers

import (
	"context"
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

const (
	databaseFinalizer = "database.example.com/finalizer"
)

// DatabaseReconciler merekonsiliasi sebuah custom resource "Database"
// (Untuk contoh ini, direpresentasikan dengan ConfigMap demi kemudahan kompilasi standar)
type DatabaseReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile adalah main event loop. HARUS Idempotent!
func (r *DatabaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// 1. Dapatkan objek dari cache
	var dbResource corev1.ConfigMap
	if err := r.Get(ctx, req.NamespacedName, &dbResource); err != nil {
		if apierrors.IsNotFound(err) {
			// Object dihapus dari server sebelum kita memprosesnya di antrean.
			// Reconcile selesai. Jangan return error, hindari infinite requeue.
			logger.Info("Resource tidak ditemukan. Mengabaikan event.")
			return ctrl.Result{}, nil
		}
		// Error koneksi K8s, antre kembali via framework
		return ctrl.Result{}, fmt.Errorf("gagal mengambil resource: %w", err)
	}

	// 2. Lifecycle & Finalizers Management (Deletion Phase)
	if !dbResource.ObjectMeta.DeletionTimestamp.IsZero() {
		// Object ini SEDANG dalam antrean proses penghapusan (Terminating)
		if controllerutil.ContainsFinalizer(&dbResource, databaseFinalizer) {
			logger.Info("Melakukan de-provisioning pada database eksternal...")
			
			// Memanggil cloud API external (SaaS / AWS)
			if err := r.deleteExternalDatabase(ctx, dbResource.Name); err != nil {
				// Bila error cloud API, kita requeue agar dicoba lagi (Backoff Retry)
				logger.Error(err, "Gagal menghapus cloud resource, akan diulang.")
				return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
			}

			// Berhasil dihapus dari cloud, hilangkan finalizer
			controllerutil.RemoveFinalizer(&dbResource, databaseFinalizer)
			if err := r.Update(ctx, &dbResource); err != nil {
				return ctrl.Result{}, fmt.Errorf("gagal menghapus finalizer: %w", err)
			}
			logger.Info("Finalizer dihapus, kubernetes akan menghancurkan resource.")
		}
		// Sudah tidak ada finalizer. Stop rekonsiliasi.
		return ctrl.Result{}, nil
	}

	// (Creation/Update Phase) Pastikan finalizer terpasang
	if !controllerutil.ContainsFinalizer(&dbResource, databaseFinalizer) {
		controllerutil.AddFinalizer(&dbResource, databaseFinalizer)
		if err := r.Update(ctx, &dbResource); err != nil {
			return ctrl.Result{}, fmt.Errorf("gagal memasang finalizer: %w", err)
		}
		// Hentikan eksekusi di sini. Karena r.Update memodifikasi objek, K8s akan menghasilkan
		// event UPDATE baru yang secara otomatis akan men-trigger ulang fungsi Reconcile ini.
		return ctrl.Result{}, nil
	}

	// 3. Logika Bisnis Rekonsiliasi (Idempotency Phase)
	// Kita periksa status external resource
	status, err := r.checkExternalDatabaseStatus(ctx, dbResource.Name)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("gagal memeriksa status db cloud: %w", err)
	}

	if status == "NotExists" {
		logger.Info("Membangun instance database baru...")
		if err := r.createExternalDatabase(ctx, dbResource.Name); err != nil {
			logger.Error(err, "Gagal provision. Retry dalam 15 detik.")
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		// Status masih "Creating", requeue untuk mengecek nanti
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	} else if status == "Creating" {
		logger.Info("Masih provisioning, menunggu...")
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	} else if status == "Ready" {
		// 4. Update Status pada Custom Resource (Jika ada modifikasi status)
		// r.Status().Patch(ctx, &dbResource, client.MergeFrom(oldDbResource))
		
		logger.Info("Reconciliation sukses. Desired State == Actual State.")
		return ctrl.Result{}, nil
	}

	return ctrl.Result{}, nil
}

// Mock functions untuk interaksi API Cloud (dummy)
func (r *DatabaseReconciler) deleteExternalDatabase(ctx context.Context, name string) error { return nil }
func (r *DatabaseReconciler) createExternalDatabase(ctx context.Context, name string) error { return nil }
func (r *DatabaseReconciler) checkExternalDatabaseStatus(ctx context.Context, name string) (string, error) { return "Ready", nil }


// ---------------------------------------------------------
// UNIT TESTS (Envtest Simulation menggunakan Client Fake)
// ---------------------------------------------------------
func TestReconcile_FinalizerLifecycle(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)

	// Persiapkan resource tanpa finalizer
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-db",
			Namespace: "default",
		},
	}

	// Gunakan Fake client (tidak butuh envtest K8s sungguhan untuk uji coba controller flow)
	fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).Build()

	reconciler := &DatabaseReconciler{
		Client: fakeClient,
		Scheme: scheme,
	}

	req := ctrl.Request{
		NamespacedName: types.NamespacedName{Name: "test-db", Namespace: "default"},
	}

	// TAHAP 1: Reconcile pertama harus hanya menambahkan Finalizer, tidak lebih.
	res, err := reconciler.Reconcile(context.TODO(), req)
	if err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if res.Requeue || res.RequeueAfter != 0 {
		t.Errorf("Diharapkan return empty result saat Update memicu watch event baru")
	}

	// Verifikasi: ambil data terbaru dari cache K8s
	updatedCM := &corev1.ConfigMap{}
	err = fakeClient.Get(context.TODO(), req.NamespacedName, updatedCM)
	if err != nil {
		t.Fatalf("Get error: %v", err)
	}
	if !controllerutil.ContainsFinalizer(updatedCM, databaseFinalizer) {
		t.Errorf("Diharapkan K8s object memiliki finalizer setelah reconcile loop pertama")
	}

	// TAHAP 2: Simulasi pengguna menjalankan perintah `kubectl delete`
	now := metav1.Now()
	updatedCM.DeletionTimestamp = &now // K8s API memanipulasi DeletionTimestamp
	_ = fakeClient.Update(context.TODO(), updatedCM)

	// Reconcile selanjutnya harus mendeteksi DeletionTimestamp, menghapus resource eksternal,
	// lalu menghilangkan Finalizer.
	_, err = reconciler.Reconcile(context.TODO(), req)
	if err != nil {
		t.Fatalf("Reconcile deletion error: %v", err)
	}

	// Verifikasi Finalizer sudah dibersihkan, mengijinkan etcd K8s menghapus objek utuhnya
	_ = fakeClient.Get(context.TODO(), req.NamespacedName, updatedCM)
	if controllerutil.ContainsFinalizer(updatedCM, databaseFinalizer) {
		t.Errorf("Diharapkan Finalizer lenyap setelah deletion logic tereksekusi!")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mutasi Pointer Objek yang Diambil dari Cache
`client.Get` membaca data dari Informer cache in-memory untuk efisiensi ekstrim. Objek yang direturn oleh fungsi GET tersebut merupakan *shared pointer* referensi memori dari informer internal `client-go`. Memodifikasinya secara sembarangan akan merusak *data-structure* seluruh operator dan memicu panic.

```go
// BAD: Modifikasi pointer cache in-memory secara langsung!
var db corev1.ConfigMap
r.Get(ctx, req.NamespacedName, &db)

// Mengubah slice map secara langsung, merusak state controller-runtime di background
db.Annotations["operator-updated"] = "true" 
r.Update(ctx, &db)
```

```go
// GOOD: Gunakan DeepCopy(), atau jauh lebih baik, gunakan PATCH (Server-Side Apply)
var db corev1.ConfigMap
r.Get(ctx, req.NamespacedName, &db)

patch := client.MergeFrom(db.DeepCopy())
db.Annotations["operator-updated"] = "true"
r.Patch(ctx, &db, patch)
```
**Why dangerous:** Memicu *Concurrent Map Writes Panic* bawaan Golang, membuat pod operator CrashLoopBackOff terus-menerus. Selain itu, mengakibatkan cache informer di RAM menjadi *polluted* (tercemar) dengan data yang berbeda dengan yang ada di etcd K8s.

### ❌ Anti-Pattern 2: Infinite Requeue Loop dengan `Requeue: true`
Reconciler tidak dirancang untuk menangani infinite retry loop buta layaknya message broker klasik. Mereturn true saat berhadapan dengan *fatal validation error* akan menyebabkan eksponensial laju CPU usage.

```go
// BAD: Requeue membabi-buta untuk error CRD format / invalid user input.
if !isValidCRDFormat(dbResource.Spec) {
    return ctrl.Result{Requeue: true}, err 
}
```

```go
// GOOD: Berhenti rekonsiliasi dan catat error di `.Status.Conditions` resource.
if !isValidCRDFormat(dbResource.Spec) {
    // Update K8s Status dengan "Condition: Invalid", lalu..
    return ctrl.Result{}, nil // Jangan return error/requeue. 
                              // Biarkan berhenti, tunggu user memperbaiki manifest CRD-nya.
}
```
**Why dangerous:** Controller-runtime rate-limiter antrean akan jebol bila *banyak* object CRD memiliki error fatal. Pod controller akan me-max-out pemakaian CPU limit, terkena throttling CPU K8s OOM (CPU starvation), dan gagal merekonsiliasi seluruh CRD resource sah lainnya yang berada di antrean belakang (*noisy neighbor starvation*).

## 5. Edge Cases & Defensive Programming Khusus Operator

1. **Stale Cache setelah Create/Update Sukses**
   Anda melakukan `Client.Update` dan sukses. K8s API menyimpan ke `etcd`. Namun, di baris kode tepat bawahnya Anda memanggil `Client.Get(sama)`. Cache belum tersinkronisasi (karena latensi internal Watcher K8s). *Get* tersebut mengembalikan object versi *Kuno*.
   *Defensive Check:* **JANGAN PERNAH** memanggil `Get()` langsung tepat setelah operasi modifikasi API. Begitu Anda mengeksekusi Update/Patch di tengah Reconcile loop, kembalikan `return ctrl.Result{}, nil` segera. Biarkan Controller-runtime yang menangkap Watch Event mutasi Anda secara pasif dari udara (lewat informer), memicu ulang fungsi Reconcile secara sendirinya dengan cache termutakhir.

2. **Conflict Errors (Optimistic Concurrency - Error 409)**
   User K8s (`kubectl edit`) dan Operator K8s Anda sama-sama mencoba memodifikasi resource yang sama pada nanodetik yang hampir berbarengan. API Server K8s melacak perubahan melalui properti `metadata.resourceVersion`. Permintaan ke-dua akan otomatis ditolak dengan `Error IsConflict (HTTP 409)`.
   *Defensive Check:* Selalu periksa `apierrors.IsConflict(err)`. Jika ada konflik, JANGAN mereturn *Requeue: true* secara manual, melainkan return `return ctrl.Result{}, err`. Controller-runtime akan mengerti status konflik 409 ini dan memasukkannya ke algoritma *Backoff Retry Queue* internal dengan sendirinya, memberikan sistem jendela jeda sebelum menarik cache versi baru.

3. **Orphaned External Resources (Finalizer Edge Case)**
   Pengguna men-delete namespace, yang memaksa K8s untuk me-delete ribuan resource di dalamnya seketika secara brutal. Jika Finalizer operator Anda memiliki bug/hang (misalnya Cloud API time-out tak berujung karena kurangnya batas Context Timeout K8s), resource di Kubernetes tersangkut di kondisi *Terminating*, membuat *namespace deletion* macet permanen.
   *Defensive Check:* Selalu *wrap* fungsi eksternal ke cloud (AWS/GCP) menggunakan `context.WithTimeout`. Jika menghapus resource eksternal memakan waktu melampaui 20 detik, *return error* agar fungsi gagal *fail-fast*, melonggarkan requeue, dan mencatat peringatan di Event Recorder, dibanding membuat goroutine nyangkut permanen di memori menunggu respons cloud yang mati.
