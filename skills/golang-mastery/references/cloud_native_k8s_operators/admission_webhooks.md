# Cloud Native K8s Operators: Admission Webhooks

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `cloud_native_k8s_operators/custom_resource_definition.md` · `cloud_native_k8s_operators/controller_runtime_reconciler.md` · `cybersecurity_zerotrust/binary_signing_verification.md` · `security_owasp/mtls_certificate_rotation.md`

## 1. Konsep Utama & Internals

Di Kubernetes, *Admission Webhooks* adalah pagar pengaman kustom (interceptor) pada sisi API Server (Control Plane). Sebelum sebuah Custom Resource (atau Pod standar) benar-benar ditulis/dimutasi ke *etcd storage*, request dari klien `kubectl` akan melewati filter *Mutating* dan *Validating* webhook.

- **MutatingAdmissionWebhook**: Dieksekusi pertama. Dapat memodifikasi manifest on-the-fly (contoh: menyuntikkan *Env Var* rahasia, atau meng-inject kontainer *Istio sidecar/Envoy*).
- **ValidatingAdmissionWebhook**: Dieksekusi kedua setelah segala bentuk mutasi beres. Bersifat "Ya/Tidak" (Allow/Deny). Ini adalah gerbang otorisasi logika bisnis (Misalnya: "ReplicaCount tidak boleh genap!", "CPU Request tidak boleh lebih dari Limit!").

Operator yang dibangun dengan `controller-runtime` biasanya menyediakan webhook server (melalui HTTPs Server, sertifikat TLS wajib disertakan) yang *numpang* (listen) secara built-in satu paket bersama dengan Reconciler utamanya di dalam Pod yang sama.

## 2. Diagram ASCII: Alur Kubernetes API Server Interception

```text
       [ kubectl apply -f pod.yaml ]
                   |
                   v
         +-------------------+
         | K8s API Server    |  (Authentication & Authorization RBAC)
         +-------------------+
                   |
                   v (1. Mutasi)
  +-------------------------------------+
  | MutatingAdmissionWebhook (Luar K8s) | <--- (Operator Kita)
  | "Tolong inject Env DB_URL di Pod"   |      - Return JSONPatch
  +-------------------------------------+
                   |
                   v (2. K8s Object Schema Validation internal K8s)
                   |
                   v (3. Validasi Bisnis Logik Ekstra)
  +-------------------------------------+
  | ValidatingAdmissionWebhook          | <--- (Operator Kita)
  | "Apakah CPU > 2? Jika Ya -> DENY"   |      - Return Allowed: True/False
  +-------------------------------------+
                   |
                   v (4. Lolos)
         +-------------------+
         | Persisted di etcd |  (Tersimpan Resmi)
         +-------------------+
```

## 3. Production-Ready Go Code (Controller-Runtime Webhook)

Kerangka di bawah memperlihatkan implementasi webhook `CustomValidator` (Menggunakan interface `CustomValidator` terbaru dari `controller-runtime`).

```go
package webhooks

import (
	"context"
	"fmt"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// MyAppResource hanyalah dummy penampung (Harusnya berupa CRD Type Anda sendiri)
// Contoh ini menggunakan K8s ConfigMap yg diabuse sebagai Custom Type demi test.
type MyAppResource struct {
	corev1.ConfigMap
}

// MyAppWebhook mengimplementasikan mutating & validating interface
type MyAppWebhook struct {
	Client  client.Client
	Decoder *admission.Decoder
}

// SetupWebhookWithManager mendaftarkan hook server ke mgr
func (w *MyAppWebhook) SetupWebhookWithManager(mgr ctrl.Manager) error {
	// Pendaftaran standar untuk tipe kustom
	return ctrl.NewWebhookManagedBy(mgr).
		For(&corev1.ConfigMap{}). // Asumsikan kita hook ConfigMap
		WithValidator(w).
		WithDefaulter(w).
		Complete()
}

// +kubebuilder:webhook:path=/mutate-core-v1-configmap,mutating=true,failurePolicy=fail,sideEffects=None,groups=core,resources=configmaps,verbs=create;update,versions=v1,name=mconfigmap.kb.io,admissionReviewVersions=v1

// Default mengimplementasikan Defaulter (Mutating Webhook)
func (w *MyAppWebhook) Default(ctx context.Context, obj runtime.Object) error {
	cm, ok := obj.(*corev1.ConfigMap)
	if !ok {
		return fmt.Errorf("unexpected data type detected")
	}

	// 1. Mutasi: Tambahkan metadata otomatis jika tidak ada
	if cm.Labels == nil {
		cm.Labels = make(map[string]string)
	}
	if _, exists := cm.Labels["injected-by"]; !exists {
		cm.Labels["injected-by"] = "myapp-operator"
	}
	
	// Inject default data Config jika user tidak nge-set
	if cm.Data == nil {
		cm.Data = make(map[string]string)
	}
	if _, ok := cm.Data["environment"]; !ok {
		cm.Data["environment"] = "production"
	}

	return nil
}

// +kubebuilder:webhook:path=/validate-core-v1-configmap,mutating=false,failurePolicy=fail,sideEffects=None,groups=core,resources=configmaps,verbs=create;update;delete,versions=v1,name=vconfigmap.kb.io,admissionReviewVersions=v1

// ValidateCreate mengimplementasikan Validating Webhook saat objek Dibuat
func (w *MyAppWebhook) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	cm, ok := obj.(*corev1.ConfigMap)
	if !ok {
		return nil, apierrors.NewBadRequest("expected a ConfigMap")
	}
	return w.validate(cm)
}

// ValidateUpdate memvalidasi objek saat diUpdate (bandingkan nilai old/new)
func (w *MyAppWebhook) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
	cm, ok := newObj.(*corev1.ConfigMap)
	if !ok {
		return nil, apierrors.NewBadRequest("expected a ConfigMap")
	}

	// Logika: Cegah user mengubah label kritikal yang sudah di-inject
	oldCM := oldObj.(*corev1.ConfigMap)
	if oldCM.Labels["critical-lock"] == "true" && cm.Labels["critical-lock"] != "true" {
		return nil, fmt.Errorf("strictly forbidden to remove 'critical-lock' label")
	}

	return w.validate(cm)
}

// ValidateDelete mengeksekusi proteksi penghapusan tak disengaja
func (w *MyAppWebhook) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	cm, ok := obj.(*corev1.ConfigMap)
	if !ok { return nil, apierrors.NewBadRequest("expected a ConfigMap") }

	if cm.Labels["protected"] == "true" {
		// Tolak Keras command `kubectl delete`!
		return nil, fmt.Errorf("deletion denied: resource is protected by protected=true label")
	}
	return nil, nil
}

// validate pusat bisnis logika murni
func (w *MyAppWebhook) validate(cm *corev1.ConfigMap) (admission.Warnings, error) {
	var allErrs field.ErrorList

	// Contoh aturan bisnis: Value environment tidak boleh "test" di cluster prod
	if val := cm.Data["environment"]; val == "test" {
		allErrs = append(allErrs, field.Invalid(
			field.NewPath("data").Child("environment"),
			val,
			"environment 'test' is forbidden in production namespace",
		))
	}

	if len(allErrs) == 0 {
		return nil, nil // Sukses! (Allow: true otomatis)
	}

	// Bungkus menjadi HTTP 422 Unprocessable Entity berstandar K8s
	return nil, apierrors.NewInvalid(
		schema.GroupKind{Group: "", Kind: "ConfigMap"},
		cm.Name,
		allErrs,
	)
}


// --- Unit Test ---
// Test webhook murni lokal tanpa boot K8s Envtest API (Cukup panggil structnya)

import "testing"

func TestWebhookValidation(t *testing.T) {
	hook := &MyAppWebhook{}
	
	// Test Create dengan data Dilarang
	badCM := &corev1.ConfigMap{
		Data: map[string]string{"environment": "test"},
	}
	
	warnings, err := hook.ValidateCreate(context.TODO(), badCM)
	if err == nil {
		t.Fatalf("Error should be triggered because of env 'test'!")
	}
	if len(warnings) > 0 {
		t.Logf("Returned warnings: %v", warnings)
	}
	
	// Test Update proteksi label (Kritis)
	oldCM := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"critical-lock": "true"}},
	}
	newCM := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{}}, // User mencoba hilangkan label
	}
	
	_, err = hook.ValidateUpdate(context.TODO(), oldCM, newCM)
	if err == nil || err.Error() != "strictly forbidden to remove 'critical-lock' label" {
		t.Fatalf("Failed to protect old resource from illegal modification: %v", err)
	}
	
	// Test Default Mutating
	cmDef := &corev1.ConfigMap{}
	hook.Default(context.TODO(), cmDef)
	if cmDef.Data["environment"] != "production" {
		t.Errorf("Failed to inject default mutation")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Side Effects & External HTTP Calls (Blocking)
Webhook dilarang *keras* membuat permintaan eksternal ke internet, database, atau sistem di luar control plane yang *blocking* dan tidak stabil. Webhook adalah *Critical Path* K8s. Jika Webhook lambat, server API akan *hang*, dan pengguna CLI akan berjam-jam menunggu respons.

```go
// BAD: Melakukan koneksi internet yang lambat atau tak menentu di dalam webhook.
func (w *MyAppWebhook) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    // Awas! Jika API AWS/GCP sedang mati 30 detik, perintah `kubectl apply` di cluster K8s
    // akan nyangkut (Timeout 30s) massal!
    resp, _ := http.Get("https://api.mycloud.com/validate?name=" + obj.GetName())
    if resp.StatusCode != 200 { return nil, errors.New("denied") }
    return nil, nil
}
```

```go
// GOOD: Semua validasi bersifat O(1) deterministik, berdasarkan atribut CRD internal atau in-memory cache murni.
func (w *MyAppWebhook) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
    // Validasi pure lokal menggunakan string regex, perbandingan field
    return w.validateSpecFormatLocal(obj)
}
```
**Why dangerous:** Mencekik Kubernetes API Server. Jika K8s APIServer sedang stress, mem-boot *HPA (Horizontal Pod Autoscaler)* dan sistem auto-scale lain, Webhook yang memakan waktu timeout akan menembakkan API Server mati dengan *goroutine explosion* / HTTP Context Deadline Exceeded. 

### ❌ Anti-Pattern 2: `failurePolicy: Fail` pada NameSpace Kosong atau System
Seringkali manifest pendaftaran MutatingWebhookConfiguration men-set `failurePolicy: Fail`. Dan Webhook mem-filter "*SEMUA POD di SEMUA Namespace*".
Ketika sertifikat cert-manager operator Webhook mati/kadaluwarsa, tidak ada pod baru yang bisa dibuat di manapun, bahkan Pod Reconciler atau `kube-system` tidak bisa bangun lagi akibat terhadang Webhook Anda sendiri yang mati (*Deadlock*).

```yaml
# BAD: Webhook mencakup segalanya secara brutal, failurePolicy: Fail. 
# Jika pod webhook down, seluruh cluster k8s lumpuh!
webhooks:
- name: myhook.example.com
  failurePolicy: Fail
  rules:
  - apiGroups: [""]
    resources: ["pods"]
```

```yaml
# GOOD: Gunakan namespaceSelector eksklusif untuk melindungi kube-system!
webhooks:
- name: myhook.example.com
  failurePolicy: Ignore # atau jika Fail: WAJIB pakai namespace selector
  namespaceSelector:
    matchExpressions:
    - key: control-plane
      operator: DoesNotExist
```
**Why dangerous:** Menyebabkan *Catastrophic Cluster Deadlock*. Pod webhok mati -> Node direstart K8s -> Node mau spawn pod webhok baru -> API Server menahan spawn pod karena menunggu persetujuan Validating Webhook Anda yang mati. Cluster tak akan bisa sembuh sendirinya.

## 5. Edge Cases & Defensive Programming

1. **Pengulangan Webhook Tanpa Henti di Controller Loop**
   Reconciler Anda (Operator utamanya) biasanya akan melakukan `Update()` terhadap resource `.Status`. Jika webhook Anda me-listen event *Update* juga, dan Reconciler melakukan *Patch Status*, Webhook akan didera request konstan, bahkan mungkin me-nolak Update Status dari dirinya sendiri.
   *Defensive Check:* Selalu periksa `userInfo` yang meminta *admission review*. Jika yang me-*request* modifikasi adalah *ServiceAccount* dari Operator Anda sendiri, langsung setuju/kembalikan (bypass validation). Hanya saring request murni dari *User End User / CI-CD Pipeline*.

2. **Cert-Manager & TLS Rotation (Handshake Failed)**
   API Server K8s (Berjalan di host Master Node) HANYA menerima trafik HTTPS dari webhook yang dipercaya via CA Bundle. Jika Webhook dirotasi *(cert renewal)* oleh *cert-manager*, memory Go Webhook Server mungkin masih menyimpan sertifikat lawas. Koneksi akan `EOF` dan `TLS Handshake Error`.
   *Defensive Check:* Integrasi dengan library *controller-runtime* sudah men-support dynamic rotasi (mem-watch direktori `/tmp/k8s-webhook-server/serving-certs` dan me-reload cache TLS in-memory otomatis tanpa re-start Go Binary). Jangan menulis `http.ListenAndServeTLS` manual, percayakan pada `.SetupWebhookWithManager`.

3. **Versioning CRD yang Berantakan di Decoder (Conversion Webhook)**
   Ketika Anda men-upgrade versi CRD dari `v1alpha1` ke `v1beta1`, user yang mengeksekusi *apply* bisa saja memakai YAML lama v1alpha1. Saat diterima Webhook, objek berbentuk versi lama yang tidak cocok dengan struct Golang v1beta1 terbaru.
   *Defensive Check:* Kubernetes juga punya fitur **Conversion Webhook**. Pisahkan logic. Paksa conversion webhook merubah `v1alpha1` menjadi `v1beta1` mutakhir DULU. Webhook *Validating/Mutating* utama Anda hanya perlu di-set untuk memantau spesifik API *Version* `v1beta1` demi mempertahankan kebersihan fungsi Go di parameter `obj runtime.Object`.

## Kapan JANGAN Pakai Ini

- **Tanpa memikirkan `failurePolicy` secara sadar.** `Fail` berarti cluster **berhenti menerima objek** ketika webhook mati — termasuk objek yang dibutuhkan untuk memperbaiki webhook itu. `Ignore` berarti kebijakan Anda bisa dilewati persis saat sedang paling rapuh. Keduanya adalah keputusan, bukan default.
- **Webhook yang memanggil layanan eksternal.** Setiap operasi API di cluster jadi bergantung pada latensi dan ketersediaan layanan itu. Muat datanya lebih dulu.
- **Tanpa mengecualikan namespace webhook itu sendiri.** Webhook yang memvalidasi namespace-nya sendiri bisa mengunci diri: ia mati, dan Anda tidak bisa men-deploy penggantinya.
- **Mutating webhook yang tidak idempoten.** Ia bisa dipanggil beberapa kali untuk satu objek dalam satu permintaan. Mutasi yang menambah tanpa memeriksa akan menumpuk.
- **Timeout bawaan 10 detik dibiarkan.** Setiap operasi API membayar itu saat webhook lambat. Untuk webhook yang sehat, satu atau dua detik lebih dari cukup.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Seluruh cluster menolak pembuatan objek | `failurePolicy: Fail` + webhook mati | Webhook menjadi titik kegagalan tunggal |
| Operasi `kubectl` lambat di seluruh cluster | latensi webhook | Setiap permintaan menunggu webhook |
| Kebijakan tidak berlaku sesekali | `failurePolicy: Ignore` | Webhook mati dan permintaan lolos |
| Anotasi menumpuk berkali-kali | idempotensi mutating webhook | Mutasi dipanggil ulang tanpa pemeriksaan |
| Webhook tidak bisa di-deploy ulang | pengecualian namespace | Webhook mengunci dirinya sendiri |

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations \
  -o custom-columns='NAMA:.metadata.name,KEBIJAKAN:.webhooks[*].failurePolicy,TIMEOUT:.webhooks[*].timeoutSeconds'

# Latensi dan tingkat penolakan webhook dari sisi API server
kubectl get --raw /metrics | grep -E 'apiserver_admission_webhook_(rejection_count|admission_duration_seconds_count)' | head

# Apakah webhook mengecualikan namespace-nya sendiri?
kubectl get validatingwebhookconfiguration <nama> -o jsonpath='{.webhooks[*].namespaceSelector}' | jq

kubectl logs -l app=webhook --since=1h | grep -ciE 'timeout|context deadline'
```
