# W3C Baggage pada Distributed Tracing

> **Berlaku:** Go 1.21+ · W3C Baggage · OpenTelemetry-Go v1.24+ · **Lihat juga:** `observability_resilience/opentelemetry_tracing.md` · `microservices_grpc/grpc_interceptors_middleware.md` · `distributed_patterns_resilience/multi_tenancy_isolation.md` · `observability_resilience/structured_logging_zerolog.md`

Dalam arsitektur microservices, request klien melintas 5–10 layanan. Bagaimana Payment Service di ujung rantai mengetahui `tenant_id` atau `user_tier` dari request awal tanpa memaksa setiap layanan perantara membawa data itu di API schema masing-masing (domain coupling)?

Jawabannya adalah **W3C Baggage** — propagasi metadata cross-service via HTTP header `baggage: key=value`, bersamaan dengan `traceparent` W3C Trace Context.

---

## 1. Baggage vs Span Attributes — Perbedaan Kritis

```
Request Flow:
                                                          
  API Gateway                                             
  │  ctx: TraceID=AAA                                     
  │  Inject baggage: tenant_id=T1, user_tier=gold        
  │  Inject traceparent: 00-AAA-BBB-01                   
  │                                                       
  ├──► Order Service (HTTP Header: baggage: tenant_id=T1...)
  │    │  Span Attributes: order_id=789  ← hanya di span ini
  │    │  Baggage: tenant_id=T1          ← diteruskan ke hilir
  │    │                                                  
  │    └──► Payment Service              
  │         │  Baca baggage: user_tier=gold → apply diskon 10%
  │         │  Tanpa call balik ke API Gateway!           
  │         └──► Tracing Backend (Jaeger)                 
  │              Semua span terhubung via TraceID=AAA     
                                                          
Span Attributes → hanya visible di span itu sendiri      
Baggage        → propagasi ke SEMUA downstream services  
```

**Aturan main Baggage:**
- Max size: ~8KB total (dibatasi HTTP header limit server — nginx default 4KB)
- Value harus URL-encoded jika mengandung special chars
- Immutable per request — layanan hilir TIDAK boleh mengubah nilai
- Tidak dienkripsi — JANGAN simpan PII atau credentials

---

## 2. Kode Go Production-Ready

```go
package tracing

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
)

// TenantInfo merepresentasikan data tenant yang dibawa via baggage.
type TenantInfo struct {
	ID   string
	Tier string
}

// InjectTenantBaggage menyisipkan tenant info ke dalam context.
// Dipanggil di API Gateway / entry point service.
func InjectTenantBaggage(ctx context.Context, info TenantInfo) (context.Context, error) {
	if info.ID == "" {
		return ctx, fmt.Errorf("tenant ID cannot be empty")
	}

	mID, err := baggage.NewMember("tenant_id", info.ID)
	if err != nil {
		return ctx, fmt.Errorf("invalid tenant_id baggage member: %w", err)
	}

	mTier, err := baggage.NewMember("user_tier", info.Tier)
	if err != nil {
		return ctx, fmt.Errorf("invalid user_tier baggage member: %w", err)
	}

	b, err := baggage.New(mID, mTier)
	if err != nil {
		return ctx, fmt.Errorf("create baggage: %w", err)
	}

	return baggage.ContextWithBaggage(ctx, b), nil
}

// ExtractTenantInfo mengekstrak tenant info dari context baggage.
// Dipanggil di downstream services.
func ExtractTenantInfo(ctx context.Context) TenantInfo {
	b := baggage.FromContext(ctx)
	return TenantInfo{
		ID:   b.Member("tenant_id").Value(),
		Tier: b.Member("user_tier").Value(),
	}
}

// BaggagePropagatorMiddleware mengekstrak W3C baggage dari HTTP header
// ke dalam request context menggunakan propagator global OTel.
// Setup: otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
//   propagation.TraceContext{}, propagation.Baggage{}))
func BaggagePropagatorMiddleware(next http.Handler) http.Handler {
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract baggage dari HTTP header ke context
		ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// InjectBaggageToOutgoing menyisipkan baggage dari context ke outgoing HTTP request.
// Wajib dipanggil saat membuat request ke service lain agar baggage tidak hilang.
func InjectBaggageToOutgoing(ctx context.Context, req *http.Request) {
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
	propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// DiscountService contoh downstream service yang menggunakan baggage.
func DiscountService(ctx context.Context, basePrice float64) float64 {
	tenant := ExtractTenantInfo(ctx)
	switch tenant.Tier {
	case "gold":
		return basePrice * 0.90 // 10% diskon
	case "platinum":
		return basePrice * 0.80 // 20% diskon
	default:
		return basePrice
	}
}

// --- Unit Tests ---

func TestInjectTenantBaggage_Valid(t *testing.T) {
	ctx, err := InjectTenantBaggage(context.Background(), TenantInfo{
		ID:   "TENANT-999",
		Tier: "platinum",
	})
	if err != nil {
		t.Fatalf("InjectTenantBaggage: %v", err)
	}

	info := ExtractTenantInfo(ctx)
	if info.ID != "TENANT-999" {
		t.Errorf("tenant_id = %q, want TENANT-999", info.ID)
	}
	if info.Tier != "platinum" {
		t.Errorf("user_tier = %q, want platinum", info.Tier)
	}
}

func TestInjectTenantBaggage_EmptyID(t *testing.T) {
	_, err := InjectTenantBaggage(context.Background(), TenantInfo{ID: "", Tier: "gold"})
	if err == nil {
		t.Error("expected error for empty tenant ID, got nil")
	}
}

func TestExtractTenantInfo_EmptyContext(t *testing.T) {
	// Context tanpa baggage harus return TenantInfo{} tanpa panic
	info := ExtractTenantInfo(context.Background())
	if info.ID != "" || info.Tier != "" {
		t.Errorf("expected empty TenantInfo, got %+v", info)
	}
}

func TestBaggagePropagation_E2E(t *testing.T) {
	// Simulasi: inject di upstream, ekstrak di downstream via HTTP
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)

	// Inject ke context dan kemudian ke header HTTP
	ctx, _ := InjectTenantBaggage(context.Background(), TenantInfo{
		ID: "T-ACME", Tier: "gold",
	})
	outReq, _ := http.NewRequest("GET", "/", nil)
	propagator.Inject(ctx, propagation.HeaderCarrier(outReq.Header))

	// Verifikasi header baggage ter-set
	baggageHeader := outReq.Header.Get("baggage")
	if !strings.Contains(baggageHeader, "tenant_id=T-ACME") {
		t.Errorf("baggage header missing tenant_id: %q", baggageHeader)
	}

	// Downstream: ekstrak dari header
	var extractedTenant TenantInfo
	handlerCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		extractedTenant = ExtractTenantInfo(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	wrapped := BaggagePropagatorMiddleware(handler)

	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, outReq)

	if !handlerCalled {
		t.Fatal("handler not called")
	}
	if extractedTenant.ID != "T-ACME" {
		t.Errorf("downstream got tenant_id=%q, want T-ACME", extractedTenant.ID)
	}
	if extractedTenant.Tier != "gold" {
		t.Errorf("downstream got user_tier=%q, want gold", extractedTenant.Tier)
	}
}

func TestDiscountService_TierLogic(t *testing.T) {
	tests := []struct {
		tier      string
		basePrice float64
		want      float64
	}{
		{"gold", 100.0, 90.0},
		{"platinum", 100.0, 80.0},
		{"standard", 100.0, 100.0},
		{"", 100.0, 100.0}, // no tier → no discount
	}
	for _, tt := range tests {
		ctx, _ := InjectTenantBaggage(context.Background(), TenantInfo{ID: "T1", Tier: tt.tier})
		got := DiscountService(ctx, tt.basePrice)
		if got != tt.want {
			t.Errorf("DiscountService(tier=%q, price=%.1f) = %.1f, want %.1f",
				tt.tier, tt.basePrice, got, tt.want)
		}
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Baggage sebagai Transit Database (Payload Raksasa)

```go
// BAD: Menyimpan JSON profile user (2KB+) di baggage
profile, _ := json.Marshal(user) // 2KB JSON
baggage.NewMember("user_profile", string(profile))
// → HTTP 431 Request Header Fields Too Large di NGINX (default limit 4KB)
// → Semua downstream service reject request

// GOOD: Hanya ID ringan (5-30 bytes)
baggage.NewMember("user_id", "usr-81a") // downstream fetch dari DB/cache
```

**Kenapa berbahaya:** HTTP header size limit nginx default 4KB, Tomcat 8KB. Baggage besar menyebabkan 431 error di semua hop — request tidak pernah sampai ke handler. Satu baggage member yang terlalu besar merusak seluruh chain propagation.

### ❌ Anti-Pattern 2: PII/Secrets di Baggage

```go
// BAD: Data sensitif terbang ke semua downstream + third-party services
baggage.NewMember("credit_card_number", "4532-1234-5678-9999")
baggage.NewMember("jwt_token", user.AccessToken) // leaked ke semua service!
// Jika service Anda call third-party API (payment processor, analytics)
// dengan context yang sama, baggage ikut terkirim → data breach

// GOOD: Hanya pass identifier, data sensitif fetch via internal API
baggage.NewMember("session_id", "sess-abc123") // session data di Redis
```

**Kenapa berbahaya:** Baggage TIDAK dienkripsi di wire. Setiap layanan dalam chain (termasuk third-party SDK yang membuat HTTP call dengan context yang sama) bisa membaca seluruh baggage. PII di baggage = pelanggaran GDPR/PCI-DSS otomatis.

### ❌ Anti-Pattern 3: Lupa Setup `otel.SetTextMapPropagator` Global

```go
// BAD: Tidak setup propagator → ExtractBaggageMiddleware tidak mengekstrak apapun
func main() {
    // Lupa panggil otel.SetTextMapPropagator(...)
    http.Handle("/", BaggagePropagatorMiddleware(handler))
}
// baggage.FromContext(ctx) selalu return empty → DiscountService tidak apply diskon

// GOOD: Setup propagator SEKALI di main/init, SEBELUM server start
func main() {
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))
    // ... setup server
}
```

**Kenapa berbahaya:** Tanpa propagator global, OTel middleware tidak mengekstrak baggage dari HTTP header ke context. Bug ini sangat sulit di-debug karena tidak ada error — baggage hanya diam-diam kosong di semua downstream service.

---

## 4. Edge Cases & Defensive Programming

1. **Middlebox Header Dropping:** Load balancer lama (F5, HAProxy <1.9) sering strip header non-standard termasuk `baggage` dan `traceparent`. Trace terputus tanpa peringatan. Verifikasi dengan `curl -v` langsung ke backend — jika header ada di sana tapi tidak di upstream, cek LB config untuk `pass-through` atau `allow-list` custom headers.

2. **Invalid Baggage Character:** W3C Baggage spec hanya izinkan printable ASCII tanpa koma, semicolon, atau equals tanpa encoding. String seperti `"New York"` (spasi) atau `"tier=gold"` (equals) akan menyebabkan `baggage.NewMember()` return error dan entry di-drop diam-diam. Selalu percent-encode value yang mungkin mengandung special chars.

3. **Context Propagation ke Goroutine Baru:** Baggage hidup di `context.Context`. Jika goroutine baru dibuat tanpa meneruskan context (`go func() { ... }()` tanpa ctx), baggage hilang. Selalu teruskan context: `go func(ctx context.Context) { ... }(ctx)`.

4. **Baggage Size Calculation:** Total ukuran semua baggage members dihitung secara kumulatif. 10 members × 100 bytes = 1KB yang aman, tapi 10 members × 500 bytes = 5KB yang bisa melebihi limit. Monitor ukuran baggage via custom middleware yang log `len(r.Header.Get("baggage"))`.

5. **Baggage vs Context Values:** Jangan gunakan `context.WithValue()` sebagai alternatif baggage untuk cross-service propagation — context values tidak pernah dikirim ke wire. `context.WithValue` hanya untuk data dalam satu process. Baggage untuk data cross-service boundaries via HTTP.

## Kapan JANGAN Pakai Ini

- **Untuk data yang dibutuhkan logika bisnis.** Baggage bisa hilang di batas mana pun yang tidak memasang propagator, dan hilangnya **senyap**. Logika yang bergantung padanya akan salah tanpa satu galat pun muncul. Data wajib dikirim lewat body atau header eksplisit yang Anda validasi.
- **Untuk apa pun yang rahasia atau bersifat PII.** Baggage ikut terkirim ke **setiap** hilir, termasuk layanan pihak ketiga, dan sering ikut tercatat di log mereka.
- **Sebagai wadah data yang besar.** Tiap entri menambah ukuran header pada setiap permintaan hilir. Sebagian gateway memotong header yang melewati batas, dan pemotongannya juga senyap.
- **Ketika yang dibutuhkan sebenarnya atribut span.** Atribut melekat pada satu span; baggage merambat ke seluruh hilir. Pilih sesuai maksud, bukan sesuai kemudahan.
- **Meneruskan baggage dari luar tanpa daftar putih.** Tanpa filter, sistem Anda memantulkan data yang tidak Anda kendalikan ke seluruh layanan internal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Nilai baggage kosong di layanan tertentu | propagator di layanan itu | Rantai propagasi putus di situ |
| `431 Request Header Fields Too Large` | ukuran header baggage | Baggage tumbuh melewati batas gateway |
| Header terpotong tanpa galat | konfigurasi proxy | Pemotongan header bersifat senyap di banyak proxy |
| PII muncul di log pihak ketiga | isi baggage | Data sensitif ikut merambat ke luar |
| Logika gagal hanya pada jalur tertentu | apakah logika bergantung baggage | Baggage dipakai sebagai transport data wajib |

```bash
# Apa yang benar-benar dikirim di header
curl -sv localhost:8080/api/v1/pesanan 2>&1 | grep -i '^> baggage'

# Distribusi ukuran baggage dari log terstruktur
kubectl logs -l app=api --since=1h | jq -r 'select(.baggage) | .baggage | length' | sort -n | tail -5

# Gateway yang menolak karena header terlalu besar
kubectl logs -l app=ingress --since=1h | grep -icE '431|header too large'
```
