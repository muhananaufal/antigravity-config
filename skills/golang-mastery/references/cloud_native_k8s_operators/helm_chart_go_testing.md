# Helm Chart Go Testing (Terratest)

> **Berlaku:** Go 1.21+ · Helm v3 · **Lihat juga:** `devops_control_planes/gitops_flux_controller.md` · `ci_cd_pipeline/deployment_strategies_go.md` · `arch_patterns/config_management.md` · `devops_control_planes/docker_container_go.md`

## 1. Konsep Utama & Internals

Bagi pengembang *Cloud Native K8s Operator*, mendistribusikan sistem biasanya dilakukan via **Helm Charts** (Paket manajer *de facto* untuk Kubernetes). Masalahnya, Helm Chart hanyalah sekumpulan YAML *templates* berbasis bahasa *Go Text Template* yang sangat *fragile* (rapuh). Salah spasi 2 indentasi, atau kurang tanda kutip pada suatu variabel bisa mengakibatkan *syntax error* atau lebih buruk: salah konfigurasi di Cluster Production!

Untuk itu industri (diinisiasi oleh Gruntwork) menggunakan **Terratest**. Ini adalah pustaka (library) Golang yang memungkinkan kita menulis Unit Test untuk *Infrastruktur sebagai Kode (IaC)* dan Helm Chart sama halnya seperti kita menulis unit test `TestCalculate(t *testing.T)` pada kode aplikasi biasa.

### Mendalami Internal API & Unmarshaling Terratest
Secara internal, `terratest/modules/helm` menggunakan Go `os/exec` untuk mengeksekusi binary `helm` yang ada di sistem, menangkap `stdout` dan `stderr` melalui bytes buffer. Ini berarti Terratest beroperasi di layer proses shell, BUKAN memanggil Helm Go SDK secara native. Keputusan desain ini diambil untuk menjamin 100% kompatibilitas dengan kelakuan *Helm CLI* yang dipakai end-user.

Setelah `stdout` YAML string didapatkan, internal engine Terratest menggunakan library `gopkg.in/yaml.v3` (atau v2 bergantung versi) untuk deserialisasi awal ke generic `map[string]interface{}`. Namun kekuatan aslinya ada di fungsi `UnmarshalK8SYaml`. Fungsi ini memanfaatkan package `k8s.io/apimachinery/pkg/runtime/serializer` dan `k8s.io/client-go/kubernetes/scheme` untuk mengubah teks YAML mentah menjadi **Go Struct K8s Native** yang *strongly typed* (seperti `appsv1.Deployment`, `corev1.Service`). Proses de-serialisasi ini sama persis dengan internal Kubernetes API Server (Kube-apiserver) saat memvalidasi dan mencerna YAML dari user.

Konsep Go Testing untuk Helm:
1. **Template Rendering Check**: Merender chart secara lokal (mengimitasi perintah `helm template`) langsung di dalam Go, menangkap string YAML, meng-*unmarshal*nya ke dalam struct `k8s.io/api` strongly-typed, dan mem-validasi logika nilainya (Misal: "Jika values.yaml set `HighAvailability=true`, pastikan Replicas = 3").
2. **Integration / E2E Testing**: Benar-benar memutar klaster Kubernetes (via `minikube` / `kind` / envtest), menginstall Helm Chart ke dalamnya secara otomatis (`helm install`), dan mengecek apakah Pod *Running*, Webhook nyala, dsb., lalu ditutup dengan *teardown/cleanup* (`helm delete`) otomatis di akhir tes.

## 2. Diagram ASCII: Alur Terratest Helm Lifecycle & Internals

```text
    [ test_helm_chart_test.go ]
                 |
                 v
   1. Setup Options (Set values.yaml dummy via Go Map)
                 |
                 v
   +---------------------------+
   |  terratest/modules/helm   |  <- Engine Pembantu
   +---------------------------+
                 |
                 | (Pilih Mode:)
    +------------+-------------+
    | MODE 1: Render Local     | MODE 2: Install E2E (Cluster)
    v                          v
 [helm template]            [helm install --namespace temp-test]
    |                          |
    | (Go Unmarshal YAML)      | (Tunggu Pod K8s via client-go)
    | -> Cek .Spec.Replicas    | -> k8s.WaitUntilServiceAvailable()
    v                          v
 [ Assert Go: OK/Fail ]     [ Assert Status Pod: Running ]
                               |
                               v (Defer)
                            [helm uninstall]
```

**Alur Detail K8s Unmarshaling:**
```text
 YAML -> apimachinery/pkg/util/yaml.NewYAMLOrJSONDecoder() 
      -> json.Unmarshal() -> Go Map 
      -> k8s.io/apimachinery/pkg/runtime.Decode() 
      -> Native k8s.io/api Struct (Type-safe & Schema Validated)
```

## 3. Production-Ready Go Code (Terratest Helm Rendering & Unit Tests)

Berikut 3 unit test nyata (Hanya Templating, tak butuh Real Cluster), yang sanggup menemukan 90% bug pada manifest Helm dengan pendekatan *strongly-typed* API `k8s.io`. Kode ini valid dan compilable.

```go
package helm_tests

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/gruntwork-io/terratest/modules/helm"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
)

// Unit Test 1: Memvalidasi rendering logika High Availability pada Deployment
func TestHelmChartTemplateHAEnabled(t *testing.T) {
	t.Parallel() // Optimasi: Jalankan unit test Helm secara paralel

	helmChartPath, err := filepath.Abs("../charts/my-operator")
	require.NoError(t, err, "Failed to get absolute path to helm chart")

	options := &helm.Options{
		SetValues: map[string]string{
			"replicaCount":             "3",
			"highAvailability.enabled": "true",
			"image.tag":                "v1.5.0",
		},
	}

	// RenderTemplateE me-return error jika rendering gagal, aman dari panic di tengah test.
	output, err := helm.RenderTemplateE(t, options, helmChartPath, "my-release", []string{"templates/deployment.yaml"})
	require.NoError(t, err, "Helm template rendering failed")

	var deployment appsv1.Deployment
	err = helm.UnmarshalK8SYamlE(t, output, &deployment)
	require.NoError(t, err, "Unmarshaling K8s YAML failed")

	// Asersi Bisnis Logika (Strongly Typed!)
	require.NotNil(t, deployment.Spec.Replicas, "Replicas must not be nil")
	assert.Equal(t, int32(3), *deployment.Spec.Replicas, "Incorrect replica count")

	// Pastikan label anti-affinity masuk karena HA Enabled!
	podAffinity := deployment.Spec.Template.Spec.Affinity
	require.NotNil(t, podAffinity, "HA Enabled must render Affinity block to spread pods")
	require.NotNil(t, podAffinity.PodAntiAffinity, "PodAntiAffinity missing from spec")

	// Verifikasi container spec
	containers := deployment.Spec.Template.Spec.Containers
	require.Len(t, containers, 1, "Must have exactly 1 container")
	assert.True(t, strings.HasSuffix(containers[0].Image, ":v1.5.0"), "Image tag mismatch")
}

// Unit Test 2: Validasi Ingress rendering dengan asersi path dan anotasinya
func TestHelmChartTemplateIngress(t *testing.T) {
	t.Parallel()

	helmChartPath, _ := filepath.Abs("../charts/my-operator")

	options := &helm.Options{
		SetValues: map[string]string{
			"ingress.enabled":              "true",
			"ingress.hosts[0].host":        "api.example.com",
			"ingress.hosts[0].paths[0].path": "/",
			"ingress.annotations.cert-manager\\.io/cluster-issuer": "letsencrypt-prod", // escaping
		},
	}

	output, err := helm.RenderTemplateE(t, options, helmChartPath, "my-release", []string{"templates/ingress.yaml"})
	require.NoError(t, err)

	var ingress netv1.Ingress
	err = helm.UnmarshalK8SYamlE(t, output, &ingress)
	require.NoError(t, err)

	// Validasi Anotasi
	val, ok := ingress.Annotations["cert-manager.io/cluster-issuer"]
	require.True(t, ok, "cert-manager annotation not found")
	assert.Equal(t, "letsencrypt-prod", val, "cert-manager annotation value mismatch")

	// Validasi Routing Rules
	require.Len(t, ingress.Spec.Rules, 1, "Must have 1 Ingress rule")
	rule := ingress.Spec.Rules[0]
	assert.Equal(t, "api.example.com", rule.Host, "Host mismatch")
	require.Len(t, rule.HTTP.Paths, 1, "Must have 1 HTTP path on Ingress")
	assert.Equal(t, "/", rule.HTTP.Paths[0].Path, "Routing path mismatch")
}

// Unit Test 3: Simulasi Multi-Document Rendering & Unmarshal List
// Mengatasi problem YAML terpisah oleh "---"
func TestHelmChartMultiDocumentRender(t *testing.T) {
	t.Parallel()

	helmChartPath, _ := filepath.Abs("../charts/my-operator")
	options := &helm.Options{
		SetValues: map[string]string{
			"serviceAccount.create": "true",
		},
	}

	// Merender seluruh template sekaligus (kosongkan parameter file array)
	output, err := helm.RenderTemplateE(t, options, helmChartPath, "my-release", []string{})
	require.NoError(t, err)

	// Memecah multi-document string menjadi beberapa string YAML valid
	docs := strings.Split(output, "---")
	var services []corev1.Service
	
	for _, doc := range docs {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		// Parsing ke TypeMeta sementara untuk mengecek Kind k8s objeknya
		var typeMeta corev1.Service
		err := helm.UnmarshalK8SYamlE(t, doc, &typeMeta)
		if err == nil && typeMeta.Kind == "Service" {
			services = append(services, typeMeta)
		}
	}

	assert.GreaterOrEqual(t, len(services), 1, "Should render at least 1 K8s Service")
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menguji Hanya Dengan `helm lint`
Menyerahkan kualitas *deployment* murni pada perintah `helm lint` dan `helm template` di CI/CD Bash script (Tanpa tes Go terstruktur). 

```bash
# BAD: Bash script purba
helm lint ./charts/my-operator
helm template ./charts/my-operator | grep "image: "
# Kelihatan jalan, tapi grep regex bisa nyangkut di komentar yaml yang salah!
```

```go
// GOOD: Go Terratest yang men-unmarshal dan mengecek Abstract Syntax Tree / Go Struct murni
var svc corev1.Service
helm.UnmarshalK8SYaml(t, output, &svc)
require.Equal(t, corev1.ServiceTypeClusterIP, svc.Spec.Type) // Tidak bisa tertipu oleh komentar regex!
```
**Why dangerous:** `helm lint` hanya mencek kebenaran syntax *YAML* (indentasi dan keabsahan karakter), namun BUKAN kebenaran *Semantic K8s*. Anda bisa saja merender YAML indentasi sempurna, tetapi typo mengetik `.spec.type: "Cluster_IP"` (seharusnya `"ClusterIP"` tanpa underscore). `helm lint` meloloskannya, API Kubernetes Server akan menolaknya mentah-mentah saat pelanggan meng-install di production.

### ❌ Anti-Pattern 2: Melupakan `defer helm.Delete()` pada Test E2E
Saat menjalankan test E2E integrasi K8s (misal di Github Actions dengan cluster Kind).

```go
// BAD: Tidak membersihkan jejak
helm.Install(t, options, chart, name)
// ASERSI: (Misal test FAIL (panic/Fatal) disini!) -> Baris bawahnya takkan dieksekusi.
helm.Delete(t, options, name, true) 
```
**Why dangerous:** Jika Test gagal di tengah jalan (fatal), eksekusi turun ke bawah akan dihentikan. Instalasi Helm yang rusak akan nyangkut membusuk di cluster *Local* atau server dev Anda (Resource Leak). Iterasi Run Test berikutnya akan bertabrakan *(Conflict Already Exists)* dengan tes lama, menyebabkan tes gagal beruntun selamanya (*flaky tests cascading failure*). *Selalu* gunakan fungsi bawaan Go `defer`.

### ❌ Anti-Pattern 3: Menggunakan `helm.RenderTemplate` Alih-alih `helm.RenderTemplateE`
Dalam penulisan *unit test* di ekosistem Go, mengabaikan atau gagal menangkap *error* yang mungkin timbul saat merender Helm template adalah praktek buruk, karena *fatal panic* akan menutupi pesan log yang lebih deskriptif.

```go
// BAD: Fungsi ini akan mem-panic (t.Fatal) jika rendering gagal
// Tanpa memberikan kesempatan untuk membersihkan state atau mengekstrak info error.
output := helm.RenderTemplate(t, options, helmChartPath, "my-release", []string{"templates/deployment.yaml"})

// GOOD: Menangkap dan memvalidasi tipe error yang dihasilkan (Defensive Programming)
output, err := helm.RenderTemplateE(t, options, helmChartPath, "my-release", []string{"templates/deployment.yaml"})
require.NoError(t, err, "An error occurred while executing helm template")
```
**Why dangerous:** Pada pipeline CI/CD yang paralel (`t.Parallel()`), *panic* atau `t.Fatal` dari fungsi non-E bisa merusak eksekusi *goroutine* test lainnya, mengakibatkan *deadlock* atau pipeline *hanging* tanpa log kejelasan di Github Actions. Selalu gunakan *library* varian "E" (Returning Error) untuk *graceful error handling*.

## 5. Edge Cases & Defensive Programming

1. **Rendering Multi-Documents YAML (The "---" delimiter)**
   Ketika menjalankan `helm template` pada seluruh folder chart, outputnya adalah *banyak* YAML yang disambung dengan garis hubung `---` (e.g. ConfigMap, Deployment, Service menyatu). Memanggil `helm.UnmarshalK8SYaml()` pada string besar ini akan *GAGAL / Error* `yaml: unmarshal errors`, karena parser bawaannya didesain khusus hanya untuk memecah 1 dokumen jadi 1 struct.
   *Defensive Implementation:* Jika Anda merender seluruh folder tanpa filter file khusus, pisahkan string tersebut berdasarkan *substring* `---` menjadi `[]string`. Lakukan looping untuk setiap bagian string dan *unmarshal* masing-masing string. Namun solusi jauh lebih *defensive* (mengurangi overhead parsing) adalah mem-passing file spesifik yang hendak dicek pada parameter `templates []string` di `helm.RenderTemplateE`.

2. **Casting Tipe Numerik yang Rapuh di Helm (e.g. Bool vs String) & String Injection**
   Di `values.yaml`, pengguna bisa saja meng-override *boolean* menggunakan string `"true"` dari CLI bash (karena bash tidak punya native boolean parser): `helm install --set autoscaling=true`. Terkadang Helm template mem-parse itu sebagai string tekstual `"true"` alih-alih tipe logika boolean `true`. Begitu pula angka port `8080` dibaca tipe `float64` vs `int` oleh template engine.
   *Defensive Implementation:* 
   Gunakan perbandingan toleran di Helm `{{ if eq (toString .Values.autoscaling) "true" }}`. Lalu di unit test Terratest, WAJIB test dengan tipe string dengan meng-override via `options.SetValues` (sebab ini adalah simulasi `--set` cli), contoh implementasi di Go:
   ```go
   options := &helm.Options{
       SetValues: map[string]string{
           "autoscaling": "true", // mensimulasikan argumen CLI string
       },
   }
   ```

3. **Helm Dependencies Chart (`requirements.yaml` atau `Chart.yaml` dependencies)**
   Jika chart *Operator* Anda mengandalkan chart eksternal (misal chart Bitnami Redis/Postgres) sebagai depedency. Terratest akan *PANIC* mendapati error `found in requirements.yaml, but missing in charts/ directory` jika belum di-*download* ke folder lokal `.charts/` saat memanggil `RenderTemplate`.
   *Defensive Implementation:* Pada tahap Setup / init `TestMain` (atau sebelum asersi), lakukan auto-download *dependency*. Terratest tidak menyediakan fungsi ini langsung, jadi kita harus menggunakan `os/exec` untuk nge-*pull*.
   ```go
   import "os/exec"
   // ... di dalam test block:
   cmd := exec.Command("helm", "dependency", "build", helmChartPath)
   err := cmd.Run()
   require.NoError(t, err, "Failed to download helm dependencies before test")
   ```
   Langkah ini wajib untuk skenario *cold-start* di pipeline CI.

## Kapan JANGAN Pakai Ini

- **Untuk manifest sederhana yang tidak perlu diparameterisasi.** Kustomize atau manifest biasa lebih mudah dibaca, di-diff, dan didebug. Helm membayar dirinya ketika chart yang sama dipasang di banyak tempat dengan nilai berbeda.
- **Template dengan percabangan yang dalam.** Template Go yang bercabang lima tingkat tidak bisa dinalar, tidak bisa diuji dengan meyakinkan, dan galatnya muncul sebagai YAML yang tidak valid di tempat yang jauh dari penyebabnya.
- **Chart tanpa `values.schema.json`.** Nilai yang salah menghasilkan manifest yang salah, dan galatnya baru muncul di API server — bukan di `helm`, tempat orang sebenarnya bisa memperbaikinya.
- **`helm upgrade` tanpa `--atomic` di produksi.** Upgrade yang gagal separuh meninggalkan rilis dalam keadaan campur: sebagian sumber daya versi baru, sebagian lama.
- **Menyimpan rahasia di `values.yaml`.** Ia sering ikut repo, **dan** tersimpan di dalam objek rilis Helm di cluster — dua tempat yang lebih mudah dibaca daripada yang diperkirakan.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Rilis berstatus `pending-upgrade` | riwayat rilis | Upgrade gagal tanpa rollback otomatis |
| Manifest berbeda dari yang diharapkan | keluaran `helm template` | Logika template terlalu rumit untuk dinalar |
| Galat baru muncul di API server | ada tidaknya schema values | Validasi nilai tidak dilakukan di sisi Helm |
| Rahasia terbaca dari objek rilis | isi secret rilis Helm | Rahasia ada di `values.yaml` |
| Rollback tidak mengembalikan keadaan | sumber daya di luar chart | Ada objek yang dikelola di luar Helm |

```bash
helm list -A --all                      # termasuk rilis yang gagal
helm history <rilis> -n <ns>

# Manifest yang BENAR-BENAR dihasilkan -- baca ini sebelum apply
helm template <rilis> ./chart -f values-produksi.yaml | kubectl apply --dry-run=server -f -

helm lint ./chart --strict

# Rahasia yang tersimpan di objek rilis Helm
kubectl get secret -l owner=helm -o json \
  | jq -r '.items[].metadata.name' | head
```
