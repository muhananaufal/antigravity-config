# OPA Zero Trust Policy Engine di Go

## 1. Konsep Utama & Internals
Open Policy Agent (OPA) mendelegasikan dan mengamankan logika otorisasi (Policy) dari aplikasi kode keras ke bahasa deklaratif `Rego`. Ini adalah fondasi dari *Zero Trust Architecture*, yang memisahkan "Siapa kamu" (Authentication via Identity/JWT) dengan "Apa yang boleh kamu lakukan" (Authorization/Policy).

Alih-alih membuat request HTTP ke server OPA mandiri (yang memperkenalkan overhead latensi jaringan, kegagalan sidecar, dan kompleksitas mTLS internal), kita meng-embed engine OPA di dalam Go secara native via package `github.com/open-policy-agent/opa/rego`. Policy engine tertanam ini akan mem-parsing Abstract Syntax Tree (AST) Rego dan melakukan evaluasi secara instan di dalam memori (sub-milidetik), yang sangat krusial untuk gateway/middleware yang menangani ribuan TPS.

## 2. Diagram Arsitektur OPA Embedded (ASCII)
```text
  [Request Eksternal (HTTP/gRPC)]
              |
      [Ekstraksi JWT & Atribut]  --> (Membangun Input Map)
              |
              v
     (Go Process / Middleware)
  =================================
  | [Embedded OPA/rego Package]   |  <----- [Policy (.rego file) dari ConfigMap/Filesystem]
  |           |                   |         (Di-reload via fsnotify & sync.RWMutex)
  |   Evaluate(Input, State)      |
  =================================
              |
        [Allow / Deny]
              |------------------ (Deny) ---> HTTP 403 Forbidden
              | (Allow)
              v
       [Execute Action]
```

## 3. Production-Ready Go Code

Kode di bawah ini mendemonstrasikan evaluasi otorisasi Zero Trust yang tertanam secara dinamis, mengelola kompilasi policy secara *thread-safe*.

```go
package opapolicy

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/open-policy-agent/opa/rego"
)

// ZeroTrustAuthz merepresentasikan policy engine yang tertanam dan thread-safe
type ZeroTrustAuthz struct {
	mu    sync.RWMutex
	query rego.PreparedEvalQuery
}

// NewZeroTrustAuthz mengkompilasi modul rego dan mem-prepare evaluasi
func NewZeroTrustAuthz(ctx context.Context, regoCode string) (*ZeroTrustAuthz, error) {
	zt := &ZeroTrustAuthz{}
	if err := zt.UpdatePolicy(ctx, regoCode); err != nil {
		return nil, err
	}
	return zt, nil
}

// UpdatePolicy memungkinkan hot-reloading policy Rego tanpa me-restart service
func (z *ZeroTrustAuthz) UpdatePolicy(ctx context.Context, regoCode string) error {
	r := rego.New(
		rego.Query("data.zerotrust.authz.allow"),
		rego.Module("authz.rego", regoCode),
	)

	// PrepareForEval melakukan kompilasi AST rego. Langkah berat ini 
	// dilakukan 1x saat inisialisasi agar evaluasi cepat.
	pq, err := r.PrepareForEval(ctx)
	if err != nil {
		return fmt.Errorf("failed to prepare OPA query: %w", err)
	}

	z.mu.Lock()
	defer z.mu.Unlock()
	z.query = pq
	return nil
}

// Evaluate memeriksa apakah input (claims/method) diizinkan berdasarkan policy
func (z *ZeroTrustAuthz) Evaluate(ctx context.Context, input map[string]interface{}) (bool, error) {
	// 1. Amankan evaluasi dengan timeout (mencegah infinite loop Rego)
	evalCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()

	z.mu.RLock()
	query := z.query // Copy the prepared query reference
	z.mu.RUnlock()

	results, err := query.Eval(evalCtx, rego.EvalInput(input))
	if err != nil {
		return false, fmt.Errorf("OPA evaluation error: %w", err)
	}

	if len(results) == 0 {
		// OPA tidak mengembalikan hasil, default Zero Trust adalah deny
		return false, nil
	}

	// Mengambil hasil tipe boolean dari rego: data.zerotrust.authz.allow
	allow, ok := results[0].Expressions[0].Value.(bool)
	if !ok {
		return false, fmt.Errorf("unexpected evaluation result type, expected bool")
	}

	return allow, nil
}
```

### Unit Test

```go
package opapolicy

import (
	"context"
	"testing"
)

func TestZeroTrustAuthz(t *testing.T) {
	ctx := context.Background()
	
	// Policy rego Zero Trust: Hanya Admin yang bisa POST, dan request harus
	// berasal dari network yang di-trust (simulasi Zero Trust network context)
	policy := `
	package zerotrust.authz

	default allow = false

	allow {
		input.method == "POST"
		input.role == "admin"
		input.network_trust == "high"
	}
	allow {
		input.method == "GET"
	}
	`

	authz, err := NewZeroTrustAuthz(ctx, policy)
	if err != nil {
		t.Fatalf("Failed to create engine: %v", err)
	}

	// Uji skenario Allow
	inputAllow := map[string]interface{}{
		"method":        "POST",
		"role":          "admin",
		"network_trust": "high",
	}
	
	allowed, err := authz.Evaluate(ctx, inputAllow)
	if err != nil || !allowed {
		t.Errorf("Expected allow=true for admin POST with high trust, got %v (err: %v)", allowed, err)
	}

	// Uji skenario Deny (Zero Trust Default Deny karena network_trust rendah)
	inputDeny := map[string]interface{}{
		"method":        "POST",
		"role":          "admin",
		"network_trust": "low", // Ditolak meski role = admin
	}
	
	denied, err := authz.Evaluate(ctx, inputDeny)
	if err != nil || denied {
		t.Errorf("Expected allow=false for admin POST with low trust, got %v (err: %v)", denied, err)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mengkompilasi Policy di Setiap Request (Performance Killer)
Banyak engineer berasumsi bahwa mengeksekusi `rego.New().Eval()` adalah operasi yang ringan. Faktanya, mem-parsing string Rego menjadi AST adalah operasi intensif CPU.

```go
// ❌ BAD: Kompilasi dan Evaluasi secara bersamaan di handler HTTP
func middlewareAuthz(ctx context.Context, input map[string]interface{}) bool {
    // Dipanggil setiap kali request HTTP masuk
    r := rego.New(
        rego.Query("data.authz.allow"),
        rego.Module("policy.rego", policyCode),
    )
    rs, err := r.Eval(ctx, rego.EvalInput(input))
    // ...
}
```
**Why dangerous:** Latensi aplikasi akan meroket menjadi 50-100ms per request hanya untuk otorisasi, dan CPU usage aplikasi Go akan spike hingga 100% pada throughput tinggi (menyebabkan *CPU Throttling* di Kubernetes).

```go
// ✅ GOOD: Kompilasi 1x via PrepareForEval saat start-up, gunakan ulang instance
func (z *ZeroTrustAuthz) Evaluate(ctx context.Context, input map[string]interface{}) (bool, error) {
    // Hanya memanggil `.Eval` dari PreparedEvalQuery yang sudah terkompilasi
    results, err := z.query.Eval(ctx, rego.EvalInput(input))
    // ...
}
```

### ❌ Anti-Pattern 2: Mem-passing Struct HTTP Utuh sebagai Rego Input
Memasukkan keseluruhan struct `*http.Request` langsung ke OPA Evaluator menggunakan struct reflection.

```go
// ❌ BAD: Mem-passing *http.Request langsung ke OPA
func handler(w http.ResponseWriter, r *http.Request) {
    // r memiliki Body (io.ReadCloser), TLS Connection State, dsb.
    results, err := query.Eval(ctx, rego.EvalInput(r)) 
}
```
**Why dangerous:** Paket `rego` menggunakan reflection berat untuk menavigasi `*http.Request`. Struct kompleks yang berisi channel, *io.ReadCloser*, atau circular reference bisa menyebabkan memory leak parsial, error marshalling internal, atau secara tak sengaja membocorkan PII/secret ke dalam log OPA saat evaluasi.

```go
// ✅ GOOD: Buat proyektor map eksplisit dari data yang dibutuhkan
func buildInput(r *http.Request, claims map[string]interface{}) map[string]interface{} {
    return map[string]interface{}{
        "method": r.Method,
        "path":   r.URL.Path,
        "role":   claims["role"],
        "sub":    claims["sub"],
    }
}
```

## 5. Edge Cases & Defensive Programming

1. **Context Cancellation & Infinite Recursion di Rego**: Rego bersifat *Turing-complete* dalam batasan tertentu; seorang engineer sekuriti dapat tanpa sengaja menulis policy Rego yang sangat kompleks atau memiliki evaluasi lambat (seperti cross-referencing array bersarang). Jika tidak dibatasi, ini akan mencekik goroutine backend Anda. *Defensive:* Selalu terapkan `context.WithTimeout` seketat 50-100ms saat memanggil `.Eval(ctx, ...)` sehingga goroutine HTTP dapat menghentikan evaluasi OPA yang *runaway* dan me-return HTTP 503/403.
2. **Data Type Mismatch saat Resolusi Nilai Evaluasi**: Hasil evaluasi dari Rego tidak selalu berupa primitif Boolean jika query yang dijalankan mengembalikan Object atau Set. Evaluasi *Partial* atau salah sasaran query bisa mengembalikan Map. *Defensive:* Gunakan Type Assertion yang aman `allow, ok := results[0].Expressions[0].Value.(bool)`. Jika `ok` bernilai false, itu adalah cacat sistemik (systemic flaw), default-kan policy otorisasi ke `Deny` (Zero Trust default-deny) dan rekam alert *Critical*.
3. **Hot-Reloading Policy (Concurrency Issues)**: Mengganti policy OPA tanpa me-restart Go service (misalnya, via `fsnotify` Kubernetes ConfigMap) sangat disarankan. Namun, menimpa struct/variabel `PreparedEvalQuery` secara langsung tanpa locking menyebabkan Data Race yang serius saat HTTP request sedang berjalan. *Defensive:* Gunakan `sync.RWMutex` (seperti pada kode di atas) atau `atomic.Value` untuk menyimpan instance `PreparedEvalQuery`. Lakukan lock write (`mu.Lock()`) HANYA saat menukar instance hasil kompilasi baru, sehingga thread pembaca tidak bentrok.
