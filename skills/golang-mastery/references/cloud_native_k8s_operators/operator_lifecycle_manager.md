# Operator Lifecycle Manager (OLM) & Bundle

## 1. Konsep Utama & Internals

Bila Operator (`controller-runtime`) adalah perangkat lunaknya (Binary program), maka OLM (Operator Lifecycle Manager) adalah *Google Play Store / App Store* bagi Kubernetes (sangat populer pada lingkungan OpenShift dan K8s Enterprise).

Mengembangkan operator yang jalan dengan perintah kasar `kubectl apply -f .` sangat bagus untuk Dev, namun buruk bagi tim *Enterprise DevOps*. Mereka butuh tahu: (1) Cara upgrade aman v1 ke v2 tanpa downtime, (2) Resolusi Depedensi (Operator A butuh Operator B v1.2), dan (3) Keterbacaan dan kataloging RBAC / Permissions secara terpusat. OLM menjawab hal tersebut.

Konsep Kunci OLM:
1. **CSV (ClusterServiceVersion)**: Lembar manifest (sangat besar) yang menyatakan *segala hal* soal operator Anda. Mulai dari Logo base64 PNG, CRD apa saja yang ia miliki/install, *Role/RoleBinding* apa saja yang dikuasainya, dan rute transisi upgrade versi.
2. **Bundle**: Format kontainerisasi. Anda tak lagi mem-push YAML ke repo. Anda mengemas file CSV dan CRD ke dalam format standard struktur OS Docker Image *(Scratch / UBI)*, dan mendorong Bundle Image itu ke Quay.io atau DockerHub.
3. **Catalog (Index Image)**: Katalog Kumpulan ratusan bundle (seperti SQLite DB list of bundles) yang memfasilitasi perintah pencarian, install (layaknya `apt-get` atau `yum`), dan notifikasi auto-upgrade OTA (Over the Air) bagi pelanggan K8s.

## 2. Diagram ASCII: Alur Pembangunan dan Pemaketan OLM

```text
  [1. Kode Operator Go (KubeBuilder)]
                |
                v
       (make bundle perintah CLI)
                |
                v (Men-generate Struktur Folder Bundle)
   +-------------------------------------+
   | bundle/                             |
   | ├── manifests/                      |
   | │   ├── myapp.crd.yaml              |  <- (CRD Definitions)
   | │   └── myapp.v1.0.0.clusterserviceversion.yaml (Metadata Lengkap)
   | ├── metadata/                       |
   | │   └── annotations.yaml            |  <- (Opsi Katalog)
   | └── tests/                          |
   +-------------------------------------+
                |
                v (make bundle-build)
      [ Docker / Podman Build ] (Membuat Image)
                |
                v (docker push bundle-image:v1.0.0)
     +---------------------------+
     |   Container Registry      |  (Docker Hub / Quay.io)
     +---------------------------+
                |
                v (Administrator Kubernetes Klien)
         [ kubectl krew olm ] atau [ OLM Catalog ]
                |
                +-> 2. Meng-Apply "Subscription" dan "InstallPlan" kustom OLM
                +-> 3. OLM Server (Di Background) mem-pull Bundle Image
                +-> 4. OLM membentangkan RBAC, memasang CRD, & Run Controller Pod Otomatis!
```

## 3. Production-Ready Code & Configuration (CSV Manifests)

Karena OLM fokus pada Distribusi (Package Management), ranah produksinya mayoritas berputar di file YAML *CSV* kustom yang aman secara RBAC. Namun, di bawah ini kita memperlihatkan kerangka Golang (Operator-SDK) utilitas integrasi khusus yang membuat Operator sadar lingkungan OLM.

```go
package olm_integration

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// IS_OLM_MANAGED biasanya di-inject via Env Vars pada template CSV OLM, 
// agar operator (Golang) tau ia sedang diremote oleh OLM.
func IsRunningUnderOLM() bool {
	return os.Getenv("OLM_MANAGED") == "true"
}

// WatchOwnerReferences digunakan untuk Defensive Logic OLM.
// Saat OLM menghancurkan CSV versi 1 untuk Upgrade v2, OLM akan membersihkan / menghapus
// semua resource yg Owned by CSV v1. Operator harus menghindari konflik.
type AppReconciler struct {
	client.Client
}

func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	// Jika di Deploy via OLM, pastikan kita memonitor env vars atau Watcher yang relevan.
	// OLM merekam status upgrade di dalam CustomResource: InstallPlan & CSV.
	// Contoh pengecekan logika internal
	
	if IsRunningUnderOLM() {
		// Dapatkan informasi namespace dan ownership dari Operatornya sendiri 
		// (berguna jika operator multi-tenant OLM yang di install di banyak namespace berbeda).
		operatorNS := os.Getenv("WATCH_NAMESPACE")
		if operatorNS != "" && req.Namespace != operatorNS {
			// Operator di install OLM dalam mode 'OwnNamespace', tolak rekonsiliasi liar luar NS.
			return ctrl.Result{}, nil
		}
	}

	// Business logic utama ...
	return ctrl.Result{}, nil
}

// ----------------------------------------------------
// Contoh Manifest CSV (ClusterServiceVersion) Terbatas
// Biasanya dihasilkan via: `operator-sdk generate kustomize manifests` 
// tapi dimodifikasi / diperkaya secara manual di area spesifik:
// ----------------------------------------------------
/*
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: memcached-operator.v1.0.1
  namespace: placeholder
spec:
  # Rute Upgrade OLM OTA (Mulus tanpa downtime)
  replaces: memcached-operator.v1.0.0 
  
  # Ikon Base64 yang akan tampil di Dashboard K8s (OpenShift UI)
  icon:
  - base64data: iVBORw0KGgoAAAANSUhEUgAA... (potong)
    mediatype: image/png
    
  # Depedensi Resolusion (Install dulu DB Operator V3 sblm install Memcached ini)
  customresourcedefinitions:
    owned:
    - name: memcacheds.cache.example.com
      version: v1
      kind: Memcached
    required:
    - name: postgresqls.database.example.com  # Wajib tersedia! OLM auto-download jika ga ada
      version: v1
      kind: PostgreSQL

  # RBAC yg Diminta (OLM akan me-review ketat, menolak jika Operator meminta Role * "Bypass K8s")
  install:
    strategy: deployment
    spec:
      permissions:
      - serviceAccountName: memcached-operator
        rules:
        - apiGroups: [""]
          resources: ["pods", "configmaps"]
          verbs: ["get", "list", "watch", "create", "update"]
*/


// --- Unit Test Mocking (Mengecek logic IsOLMManaged) ---
func TestOperatorOLMEnvLogic(t *testing.T) {
	os.Setenv("OLM_MANAGED", "true")
	os.Setenv("WATCH_NAMESPACE", "project-x")
	defer os.Unsetenv("OLM_MANAGED")
	defer os.Unsetenv("WATCH_NAMESPACE")

	if !IsRunningUnderOLM() {
		t.Fatalf("Seharusnya mendeteksi injeksi OLM")
	}

	r := &AppReconciler{}
	
	// Test Permintaan rekonsiliasi yang BUKAN pada namespace OLM (Nakal)
	reqOut := ctrl.Request{NamespacedName: types.NamespacedName{Name: "app", Namespace: "default"}}
	res, _ := r.Reconcile(context.TODO(), reqOut)
	
	if res.Requeue {
		t.Errorf("Harusnya reqOut di-drop santai (return nil) tanpa di-requeue karena melanggar OLM Boundaries")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyembunyikan Hak Akses Krusial di CSV
Membuat *ClusterRole* dengan perizinan liar tak terbatas (`verbs: ["*"]` atau `resources: ["*"]`) di dalam manifes instalasi K8s (misal `make install`). Ketika ini digenerate ke OLM `ClusterServiceVersion.yaml`, OLM Catalog Admin (Tim Security Enterprise) akan me-Reject / Memblokir Bundle App Anda.

```yaml
# BAD: Wildcard Administrator
permissions:
- serviceAccountName: app-operator
  rules:
  - apiGroups: ["*"] # Akses semesta alam K8s
    resources: ["*"]
    verbs: ["*"]
```

```yaml
# GOOD: Least Privilege Access Control
permissions:
- serviceAccountName: app-operator
  rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```
**Why dangerous:** Selain isu keamanan parah, OLM memiliki mekanisme *Tenant Boundary*. OLM mungkin ditugaskan untuk meng-install Operator Anda pada skala spesifik 1 Namespace (AllNamespaces = false). Meminta hak `ClusterRole` liar (`*`) memaksa OLM memberikan hak akses Global ke pod tenant, yang mana OLM akan secara aktif mem-Gagal-kan proses `InstallPlan` pada dashboard kustomer K8s dengan error *RBAC Elevation Denied*.

### ❌ Anti-Pattern 2: Mengubah CRD Scheme/Version Tanpa Merangkai field `replaces`
Meng-upgrade Operator dari `v1` ke `v2`. Developer membuat Bundle OLM baru (Image), lalu men-deploy katalognya. Namun lupa menulis rute transisi di file CSV.

```yaml
# BAD: CSV v1.5.0 hadir mendadak seperti anak haram.
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: db-operator.v1.5.0
```

```yaml
# GOOD: CSV harus membentuk Blockchain transisi
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: db-operator.v1.5.0
spec:
  replaces: db-operator.v1.4.0 # Menunjuk langsung versi sebelumnya
  # skips: [db-operator.v1.4.5] # Bisa skip versi cacat di produksi
```
**Why dangerous:** OLM menggunakan DAG (Directed Acyclic Graph) untuk mengupdate ribuan mesin kustomer K8s secara otomatis *(Auto-OTA)*. Jika parameter `replaces` terputus/lupa diset, OLM tidak akan mengetahui bahwa `v1.5.0` adalah penerus dari `v1.4.0`. Mesin pelanggan K8s akan diam saja selamanya *(Stuck di versi lama)*, dan tidak akan memicu Download / Auto-Upgrade background job.

## 5. Edge Cases & Defensive Programming

1. **Two-Phase CRD Upgrade (V1Alpha1 dihapus mendadak)**
   Operator Anda naik ke V2 (men-drop dukungan CRD format `v1alpha1`, dan menggunakan murni `v1`). Anda mengubah Bundle CSV, menghilangkan `v1alpha1`. Ketika OLM mem-push pembaruan ini ke cluster kustomer, OLM Server K8s akan menghapus spesifikasi CRD `v1alpha1`. Masalahnya: kustomer *masih punya ratusan pod/resource CustomObject* K8s peninggalan v1alpha1 di dalam etcd! K8s KubeAPI akan panik dan *force-delete / wipe out* seluruh database pengguna karena definisi schema CRD nya dicabut dari OLM CSV.
   *Defensive Check:* **Deprecation Window**. Anda JANGAN PERNAH menghapus versi CRD lama di versi Bundle terbaru. Biarkan YAML Spec `v1alpha1` tetap *Served: false, Storage: false* di dalam YAML bundle, dengan *Conversion Webhook* aktif. Barulah 2-3 rilis (bulan) ke depan, spesifikasi murni teks lama tersebut dicabut setelah K8s kustomer selesai mengkonversi sisa datanya.

2. **Helm vs OLM (The Operator Installation Conflict)**
   Pengguna meng-install *Operator* Anda hari ini pakai Helm Chart. Bulan depan, atasannya menyuruh pakai OLM. Pengguna meng-install ulang OLM package di klaster K8s yang sama.
   *Defensive Check:* Helm tidak tahu menahu soal keberadaan pod yang diluncurkan oleh OLM (karena OLM mencetak CRD dan Pod menggunakan kontrolernya sendiri, Helm tak punya label *heritage/release*-nya). Terjadilah Dual Controller/Split Brain. Jika mendeteksi migrasi OLM, berikan perintah tegas di *Dokumentasi Release*, Kustomer **wajib** melakukan *Uninstall* murni (Helm Delete) dan *menghapus* custom resource CRD *Orphaned/Zombie* manual sebelum memicu Instansiasi *InstallPlan* OLM, untuk mencegah benturan Reconciler (Dua aplikasi Go mencoba mem-patch resource API K8s berbarengan!).

3. **Multiarch Bundle Base Image (AMD64 vs ARM64)**
   Dalam era cloud hibrida (AWS Graviton ARM64 / Mac M1 lokal dan VM klasik Intel AMD64). OLM secara diam-diam mem-pull `Bundle Image` Docker.
   *Defensive Check:* File Dockerfile Bundle Anda (Bukan Dockerfile Aplikasi murni Go Anda, tapi *Bundle Image OLM*) biasanya sangat minim `FROM scratch`. Anda *wajib* membangunnya menggunakan `docker buildx build --platform linux/amd64,linux/arm64` untuk *Manifest List Indexing* Quay.io. Jika Bundle Image ini didorong *single-architecture AMD64*, admin yang memakai K8s ARM64 Raspberry/Graviton akan mendapati pod *CatalogSource* OLM K8s masuk ke state `CrashLoopBackOff (exec format error)`, macet fatal yang tidak bisa dideteksi oleh lint tools.
