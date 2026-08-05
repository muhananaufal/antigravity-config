# Custom Resource Definitions (CRD) & Kubebuilder Markers

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `cloud_native_k8s_operators/controller_runtime_reconciler.md` · `cloud_native_k8s_operators/admission_webhooks.md` · `devops_control_planes/crossplane_composition.md` · `microservices_grpc/api_versioning_strategy.md`

## 1. Konsep Utama & Internals

Di Kubernetes, *Custom Resource Definition* (CRD) adalah mekanisme ekstensi fundamental yang memungkinkan kita membuat objek API kustom (seperti `Database`, `AppDeployment`, atau `MessageQueue`) layaknya objek bawaan (Pods, Services, Deployments). 

Dalam Go, menggunakan kerangka kerja `controller-runtime` (dan `kubebuilder` / `operator-sdk`), definisi CRD tidak ditulis manual via YAML, melainkan **dihasilkan secara otomatis (auto-generated)** dari struktur *Go struct* yang telah dianotasi (di-markup) menggunakan *Kubebuilder Markers* khusus (`// +kubebuilder:...`).

Konsep Utama CRD via Kubebuilder:
1. **Schema Validation (OpenAPI v3)**: API Server K8s secara internal menggunakan validasi skema ketat. Klien K8s (`kubectl apply`) akan ditolak *di pintu depan* jika memasukkan Tipe Data/Field yang tidak sesuai. Hal ini dikonfigurasi melalui marker di struct Go.
2. **Subresources (Status & Scale)**: Secara default, jika User (kubectl) atau Operator Reconciler melakukan *update*, seluruh objek K8s akan kena mutasi (increment ResourceVersion). Mengaktifkan subresource `/status` memisahkan *Spec* (kemauan user) dan *Status* (laporan terkini operator), memungkinkan modifikasi performa yang tidak memicu Watch Event secara gila-gilaan.
3. **Printer Columns**: Anda bisa memunculkan variabel-variabel kustom ke terminal CLI `kubectl get myresources` sehingga admin sistem langsung tahu ringkasan datanya tanpa perlu perintah `describe` panjang.

## 2. Diagram ASCII: Alur Generasi CRD & Watch

```text
       [ Developer (Go Code) ]
                 |
      (Struct MyApp + Markers)
                 |
                 v
   +---------------------------+
   |   make manifests (CLI)    | -> [ controller-gen tool ]
   +---------------------------+
                 |
                 v (Men-generate output YAML API K8s)
                 |
       [ myapp_crd.yaml ] -----------------------+
                 |                               |
                 v  (kubectl apply)              | (Code Reconciler 
         +---------------+                       |  Listen ke Tipe CRD ini)
         | K8s etcd DB   |                       |
         +---------------+                       v
                 |                      +------------------+
                 +--- (Watch Event) --->| Operator (Go)    |
                                        +------------------+
```

## 3. Production-Ready Go Code (CRD Types)

Kerangka di bawah memperlihatkan bagaimana struktur *Production-Ready CRD Types* disusun di dalam file Go (`api/v1/myapp_types.go`) dengan perisai validasi yang sangar.

```go
package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MyAppSpec mendefinisikan "Desired State" yang diminta user
type MyAppSpec struct {
	// Replicas adalah jumlah pod app. Min 1, Max 10. Default ke 1.
	//
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10
	// +kubebuilder:default=1
	Replicas *int32 `json:"replicas,omitempty"`

	// Image adalah Docker image yang wajib ada
	//
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^([a-zA-Z0-9_\-\.\/]+):([a-zA-Z0-9_\-\.]+)$`
	// +kubebuilder:validation:Required
	Image string `json:"image"`

	// MemoryLimit membatasi alokasi RAM dalam format (e.g. 500Mi, 2Gi)
	//
	// +kubebuilder:validation:Pattern=`^[0-9]+(Mi|Gi)$`
	MemoryLimit string `json:"memoryLimit,omitempty"`

	// EnvironmentType merupakan ENUM
	//
	// +kubebuilder:validation:Enum=Development;Staging;Production
	// +kubebuilder:default=Development
	EnvironmentType string `json:"environmentType,omitempty"`
}

// MyAppStatus menyimpan informasi aktual hasil rekonsiliasi operator (Actual State)
type MyAppStatus struct {
	// ActivePods jumlah pod yang saat ini berjalan dan ready
	//
	// +kubebuilder:default=0
	ActivePods int32 `json:"activePods"`

	// Conditions mencatat histori kronologis transisi sistem (Mirip k8s built-in behavior)
	//
	// +patchMergeKey=type
	// +patchStrategy=merge
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

	// Phase menunjukan life-cycle singkat ("Pending", "Running", "Failed")
	Phase string `json:"phase,omitempty"`
}


// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.activePods
// +kubebuilder:printcolumn:name="Env",type=string,JSONPath=`.spec.environmentType`
// +kubebuilder:printcolumn:name="Active",type=integer,JSONPath=`.status.activePods`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// MyApp adalah Skema Utama CRD API K8s untuk MyApps
type MyApp struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   MyAppSpec   `json:"spec,omitempty"`
	Status MyAppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// MyAppList merupakan array / list yang direturn jika memanggil 'kubectl get myapp'
type MyAppList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []MyApp `json:"items"`
}

func init() {
	// Daftarkan ke Skema agar bisa dimengerti Client-Go K8s Cache
	SchemeBuilder.Register(&MyApp{}, &MyAppList{})
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Referensi Non-Pointer Untuk Field Optional
Menggunakan tipe data telanjang (non-pointer) pada atribut yang bersifat opsional (*omitempty*). Golang akan otomatis menyisipkan "Zero Value" (Contoh `int: 0`, `bool: false`) ketika serialisasi JSON.

```go
// BAD: Replicas adalah integer biasa (Zero value adalah 0).
type WebSpec struct {
    // +kubebuilder:default=3
    Replicas int32 `json:"replicas,omitempty"` // Kalau User masukkin `replicas: 0`, Golang anggap ini kosong (omitempty) -> diconvert jadi 3 oleh K8s! User bingung kenapa pod tetap nyala!
}
```

```go
// GOOD: Gunakan Pointer untuk field numerik / boolean opsional.
type WebSpec struct {
    // +kubebuilder:default=3
    Replicas *int32 `json:"replicas,omitempty"`
    // Jika nil, artinya user tidak men-set (K8s set jadi 3).
    // Jika ptr to 0, artinya user dengan sengaja menset `replicas: 0`, nilai ini dipertahankan!
}
```
**Why dangerous:** Memicu *Reconciliation Flapping*. User men-skala deployment menjadi 0. Reconciler melihat *zero value* dan K8s *omitted* nilai tersebut, memaksakan Default Value masuk dan menimpa keinginan pengguna. Pod akan di-bangkitkan kembali tanpa alasan, user meradang karena *billing* server jalan terus.

### ❌ Anti-Pattern 2: Tidak Memisahkan Subresource Status
Menggunakan `.Update` secara mentah pada objek utuh hanya untuk memperbarui laporan internal (contoh: mengubah `Phase = "Running"`).

```go
// BAD: Mengupdate keseluruhan K8s Object
cm.Status.Phase = "Running"
r.Client.Update(ctx, cm) // Mengupdate Spec & Status berbarengan!
```

```go
// GOOD: Patch Status secara eksklusif (Mewajibkan +kubebuilder:subresource:status diaktifkan!)
cm.Status.Phase = "Running"
r.Client.Status().Update(ctx, cm) 
```
**Why dangerous:** Jika tidak dipisah, modifikasi pada `.Status` oleh *Controller* akan merubah `ResourceVersion` (Metadata K8s), yang mana ini akan langsung men-trigger *Watch Event Baru* ke Reconciler yang sama. Menghasilkan *Infinite Loop of Updates* (Operator ngamuk). Memisahkan `.Status()` menenangkan event filter bawaan controller-runtime.

## 5. Edge Cases & Defensive Programming

1. **Evolusi Versi CRD (Dari v1alpha1 ke v1)**
   Setelah operator Anda *live* setahun, Anda mengubah nama *field* `Image` menjadi `ContainerImage`. Tiba-tiba YAML pelanggan lama gagal *Apply*, atau *Client-Go* di Reconciler *panic* tak mampu membaca data dari *etcd* DB (Backward Incompatibility).
   *Defensive Check:* Gunakan **Conversion Webhooks** & fitur Spoke/Hub (via library `sigs.k8s.io/controller-runtime/pkg/conversion`). K8s dapat mempertahankan versi lawas (`v1alpha1`) dan menyetorkannya ke webhook Go Anda untuk 'diterjemahkan' perlahan menjadi format `v1` on-the-fly, mencegah *breakage* brutal di cluster production.

2. **Penggunaan Slices/List Map tanpa ListType Marker**
   Anda membuat List Conditions atau Ports `[]corev1.ContainerPort`. Saat 2 user (atau controller) me-*patch* resource yang sama bersamaan dengan Server-Side Apply (SSA), elemen array K8s akan hancur / me-reset atau bertumpuk membabi-buta (*List Replacement* ketimbang *Merge*).
   *Defensive Check:* Selalu sertakan annotasi Marker kubebuilder ini di atas elemen slice Anda: `// +listType=map` dan `// +listMapKey=type`. Ini memberitahu algoritma JSONMergePatch K8s bahwa array tersebut harusnya disatukan berdasarkan unik `type` kunci tersebut (tidak main hajar seluruh blok *array slice*-nya).

3. **Limitasi CRD Size (1.5 MB etcd Constraint)**
   Banyak pemula menjadikan CRD sebagai "Database" dengan memasukkan *Blob/String/Script* teks panjang atau array log tak berkesudahan ke dalam Spec CRD (e.g. `Spec.BigScriptFile`).
   *Defensive Check:* Etcd K8s memiliki batas hard-limit object payload sebesar `1.5 MB`. Jika CRD melebihi batas ini, K8s akan melempar *etcd limit exceeded error*. Jika butuh data besar (>500KB), gunakan ConfigMap atau Secret, lalu pada CRD cukup masukkan referensi *string pointer* ke `ConfigMapName`. Jangan seret blob raksasa ke dalam skema utama CRD.

## 6. Implementasi Lanjutan: Conversion Webhook & Status Subresource

### Konsep Internal Conversion Webhook (Hub-Spoke Model)
Di dalam ekosistem K8s API (khususnya untuk Custom Resources), K8s hanya menyimpan SATU versi struktur secara permanen di dalam *etcd*. Versi ini disebut **Hub**. Semua versi lain (misal dari v1alpha1 ke v1) disebut **Spoke**. Saat user memanggil `kubectl get myapp.v1alpha1.example.com`, API Server K8s akan membaca data *v1* dari DB, lalu secara *on-the-fly* meminta Webhook Operator Anda untuk men-downgrade (convert) data tersebut ke `v1alpha1` untuk disajikan ke user. Ini berarti *Conversion* bekerja dua arah: `Convert To` (Spoke -> Hub) dan `Convert From` (Hub -> Spoke).

### Kode Go: Conversion Webhook (Spoke to Hub)
```go
package v1alpha1

import (
	"sigs.k8s.io/controller-runtime/pkg/conversion"
	v1 "github.com/example/api/v1"
)

// ConvertTo mengubah bentuk v1alpha1 (Spoke) menjadi v1 (Hub)
// Misal: di v1alpha1 field Image dan Version dipisah, di v1 digabung jadi ContainerImage
func (src *MyApp) ConvertTo(dstRaw conversion.Hub) error {
	dst := dstRaw.(*v1.MyApp)
	
	// Copy metadata (Labels, Annotations, dll)
	dst.ObjectMeta = src.ObjectMeta
	
	// Implementasi Konversi Bisnis Logic
	dst.Spec.Replicas = src.Spec.Replicas
	dst.Spec.ContainerImage = src.Spec.Image + ":" + src.Spec.Version
	
	return nil
}

// ConvertFrom mengubah bentuk v1 (Hub) kembali ke v1alpha1 (Spoke)
func (dst *MyApp) ConvertFrom(srcRaw conversion.Hub) error {
	src := srcRaw.(*v1.MyApp)
	
	dst.ObjectMeta = src.ObjectMeta
	dst.Spec.Replicas = src.Spec.Replicas
	
	// Parsing logic terbalik tidak selalu mudah. Anda perlu memastikan tidak ada data loss.
	// Jika ContainerImage = "nginx:1.19", kita harus memisahnya:
	// dst.Spec.Image = "nginx"
	// dst.Spec.Version = "1.19"
	// ... (kode parsing string handling yang solid)
	return nil
}
```

### Kode Go: Implementasi Status Subresource Update
Bagaimana Reconciler Anda melaporkan *Actual State* dengan aman? Menggunakan `Status().Update` yang mencegah mutasi `Spec`.

```go
// +kubebuilder:rbac:groups=apps.example.com,resources=myapps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.example.com,resources=myapps/status,verbs=get;update;patch

func (r *MyAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var app v1.MyApp
	if err := r.Get(ctx, req.NamespacedName, &app); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Anggap kita baru saja men-deploy pod...
	// Update Status K8s Condition
	newCondition := metav1.Condition{
		Type:               "Available",
		Status:             metav1.ConditionTrue,
		Reason:             "PodsRunning",
		Message:            "All pods are up and running.",
		LastTransitionTime: metav1.Now(),
	}
	
	// Menggunakan library apimachinery k8s.io untuk mengelola slice kondisi (overwrite if exists)
	meta.SetStatusCondition(&app.Status.Conditions, newCondition)
	app.Status.Phase = "Running"
	app.Status.ActivePods = 3

	// WAJIB: Update HANYA pada Subresource Status.
	if err := r.Status().Update(ctx, &app); err != nil {
		return ctrl.Result{}, fmt.Errorf("gagal mengupdate status: %w", err)
	}
	return ctrl.Result{}, nil
}
```

## 7. Unit Tests: Test Suite Nyata (Dengan Mocks & Envtest)

Menguji CRD/Reconciler tidak boleh pakai dummy struct biasa. Kita harus menggunakan `envtest` (API Server & etcd K8s sungguhan dalam memori) atau me-mock `client.Client` interface dari controller-runtime agar test bisa berjalan *headless* di CI.

```go
package controllers

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	
	v1 "github.com/example/api/v1"
)

// Test 1: Verifikasi Reconciler mampu menemukan CRD dan mengubah status.
func TestMyAppReconciler_UpdateStatus(t *testing.T) {
	// Persiapan dummy data CRD
	replicas := int32(2)
	crdInstance := &v1.MyApp{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "test-app",
			Namespace: "default",
		},
		Spec: v1.MyAppSpec{
			Replicas:        &replicas,
			Image:           "nginx:latest",
			EnvironmentType: "Development",
		},
	}

	// Gunakan Fake Client K8s (Interface Mocks yang disupport official kubernetes)
	scheme := getTestScheme() 
	fakeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(crdInstance).Build()

	reconciler := &MyAppReconciler{
		Client: fakeClient,
		Scheme: scheme,
	}

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "test-app", Namespace: "default"},
	}

	// Eksekusi Reconciler
	res, err := reconciler.Reconcile(context.TODO(), req)
	
	// Assertions Nyata
	assert.NoError(t, err)
	assert.False(t, res.Requeue)

	// Fetch State Terbaru dari Fake DB
	var updatedApp v1.MyApp
	err = fakeClient.Get(context.TODO(), req.NamespacedName, &updatedApp)
	assert.NoError(t, err)
	
	// Validasi Status Subresource terganti dengan benar
	assert.Equal(t, "Running", updatedApp.Status.Phase, "Phase harusnya menjadi Running setelah direkonsiliasi")
}

// Test 2: Edge Case ketika CRD dihapus (Not Found) tidak error, tapi IgnoreNotFound.
func TestMyAppReconciler_NotFound(t *testing.T) {
	fakeClient := fake.NewClientBuilder().WithScheme(getTestScheme()).Build()
	reconciler := &MyAppReconciler{
		Client: fakeClient,
		Scheme: getTestScheme(),
	}

	req := reconcile.Request{
		NamespacedName: types.NamespacedName{Name: "deleted-app", Namespace: "default"},
	}

	res, err := reconciler.Reconcile(context.TODO(), req)
	
	// Assert tidak boleh ada error (harus di-handle dengan client.IgnoreNotFound)
	assert.NoError(t, err)
	assert.Equal(t, time.Duration(0), res.RequeueAfter)
}

// Test 3: Verifikasi Logic Konversi (Spoke to Hub)
func TestMyApp_ConversionWebhook(t *testing.T) {
    // Spoke v1alpha1 (Image dan Version terpisah)
	src := &v1alpha1.MyApp{
		Spec: v1alpha1.MyAppSpec{
			Image:   "redis",
			Version: "7.0",
		},
	}

	// Hub v1
	dst := &v1.MyApp{}
	
	err := src.ConvertTo(dst)
	assert.NoError(t, err)
	
	// Validasi Internal Logic penggabungan
	assert.Equal(t, "redis:7.0", dst.Spec.ContainerImage, "Image dan Version harusnya digabung")
}
```

## 8. Anti-Pattern 3 (Tambahan Khusus Security/Types)

### ❌ Anti-Pattern 3: Menggunakan map[string]interface{} Tipe Bebas di CRD (Bypass Skema)
Sangat menggoda menggunakan properti *Any/Map* tanpa validasi kaku jika Anda ingin fleksibilitas ekstrim. Di Go direpresentasikan sebagai `runtime.RawExtension` atau custom map kosong, dan diberi annotasi `// +kubebuilder:pruning:PreserveUnknownFields`.

```go
// BAD: Bypass OpenAPI Validation
type WebSpec struct {
    // +kubebuilder:pruning:PreserveUnknownFields
    Config map[string]interface{} `json:"config"` 
}
// Kenapa buruk? Admin K8s bisa memasukkan Config berupa object bertingkat 100 level, array jutaan string, 
// atau payload injeksi. K8s APIServer TIDAK AKAN memvalidasinya, membiarkan operator Anda berpotensi kena OOM atau panic.
```

```go
// GOOD: Skema Kaku & Ber-Tipe
type Config struct {
    LogLevel    string `json:"logLevel"`
    EnableDebug bool   `json:"enableDebug"`
}

type WebSpec struct {
    Config Config `json:"config"`
}
```
**Penjelasan:** Mengizinkan "Unknown Fields" di Custom Resources adalah liabilitas sekuriti yang masif. K8s dirancang sebagai *Declarative Typed API*. Setiap field yang diizinkan harus dideskripsikan strukturnya dengan jelas (`string`, `bool`, object spesifik) sehingga K8s dapat menolak payload berbahaya / salah ketik (typo) di *admission phase*, jauh sebelum ia menyentuh etcd atau Controller Go Anda.

## Kapan JANGAN Pakai Ini

- **Untuk data yang berubah sangat sering.** etcd bukan basis data aplikasi. Setiap pembaruan status ditulis ke etcd dan direplikasi ke seluruh control plane; CRD yang diperbarui tiap detik akan membebani cluster untuk semua orang.
- **CRD tanpa skema validasi (`x-kubernetes-validations` atau OpenAPI).** Objek yang tidak valid diterima API server, dan controller yang harus menghadapinya — di tempat yang jauh dari orang yang membuat kesalahannya.
- **Mengubah makna atau tipe field pada versi yang sudah dipakai.** Itu memerlukan versi baru dan conversion webhook. Mengubahnya di tempat akan merusak setiap objek yang sudah tersimpan.
- **Menulis ke `spec` dari controller.** `spec` adalah keinginan pengguna; `status` adalah pengamatan controller. Controller yang menulis ke `spec` memicu rekonsiliasi berikutnya dan menciptakan loop.
- **Objek CRD berukuran besar.** Ada batas ukuran objek etcd (sekitar 1,5 MB), dan objek besar memperlambat `list`/`watch` untuk semua klien di cluster.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| etcd melambat untuk seluruh cluster | laju penulisan CRD | Status diperbarui terlalu sering |
| Controller menangani objek yang tidak masuk akal | skema validasi CRD | Validasi diserahkan ke controller |
| Objek lama gagal dibaca setelah upgrade | versi dan conversion webhook | Field berubah tanpa versi baru |
| Rekonsiliasi tidak pernah berhenti | siapa yang menulis `spec` | Controller memodifikasi keinginan pengguna |
| `list` CRD sangat lambat | ukuran objek dan jumlahnya | Objek terlalu besar untuk pola akses ini |

```bash
kubectl get crd -o custom-columns='NAMA:.metadata.name,VERSI:.spec.versions[*].name'

# Ukuran objek: yang mendekati batas etcd akan menimbulkan masalah untuk semua
kubectl get <crd-plural> -A -o json | jq -r '.items[] | "\(.metadata.name) \(. | tostring | length)"' \
  | sort -k2 -rn | head

# Apakah skema validasi benar-benar ada?
kubectl get crd <nama> -o jsonpath='{.spec.versions[0].schema.openAPIV3Schema.properties.spec}' | jq 'keys'

# Laju penulisan ke etcd dari CRD ini
kubectl get --raw /metrics | grep -E 'etcd_request_duration_seconds_count' | head -5
```
