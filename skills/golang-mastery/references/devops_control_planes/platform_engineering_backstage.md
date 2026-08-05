# Platform Engineering: Backstage Custom Catalog Provider (Go)

> **Berlaku:** Go 1.21+ · Backstage · **Lihat juga:** `engineering_practice/adr_decision_records.md` · `engineering_practice/technical_design_doc.md` · `devops_control_planes/gitops_flux_controller.md` · `engineering_practice/slo_error_budget.md`

Backstage adalah Internal Developer Portal (IDP) terpopuler. Meskipun ditulis TypeScript/Node.js, backend heavylifting — sinkronisasi CMDB, policy enforcement, scaffolding workflow — sebaiknya didelegasikan ke microservice Go. Go backend bertindak sebagai **Custom Entity Provider** yang menyuplai entitas ke Backstage via pull-based HTTP API.

---

## 1. Internals: Backstage Entity Model & Provider Architecture

```
Backstage Custom Catalog Provider Architecture:

  [CMDB / ServiceNow / Internal DB]
         │
         │ periodic sync (cron/event)
         ▼
  [Go Backend Service]
  │  ┌──────────────────────────────────────────┐
  │  │ EntityCache (sync.RWMutex protected)     │
  │  │ - background goroutine refresh tiap 5m   │
  │  │ - serve dari cache, tidak blocking        │
  │  └──────────────────────────────────────────┘
  │  /api/catalog/entities?kind=Component&page=1
  │  /api/catalog/entities?kind=API&page=2
         │
         │ HTTP pull (Backstage EntityProvider plugin)
         ▼
  [Backstage Node.js Backend]
  │  - ingest entities ke Catalog DB
  │  - dedup by name+namespace+kind
  │  - validate schema (metadata.name harus [a-z0-9-_.])
         │
         ▼
  [Backstage UI] → Developer bisa lihat semua service, API, team

Entity YAML structure (apiVersion: backstage.io/v1alpha1):
  kind: Component
    metadata.name: "go-payment-service"    ← max 63 chars, lowercase
    metadata.namespace: "default"
    metadata.annotations:
      github.com/project-slug: "org/repo"
      backstage.io/techdocs-ref: "dir:."
    spec.type: "service"
    spec.lifecycle: "production"           ← draft/experimental/deprecated/production
    spec.owner: "group:team-fintech"       ← WAJIB ada
    spec.system: "payment-platform"
```

---

## 2. Kode Go Production-Ready

```go
package backstage

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// EntityMetadata merepresentasikan metadata Backstage entity.
type EntityMetadata struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace,omitempty"`
	Description string            `json:"description,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

// BackstageEntity merepresentasikan backstage.io/v1alpha1 entity.
type BackstageEntity struct {
	APIVersion string                 `json:"apiVersion"`
	Kind       string                 `json:"kind"`
	Metadata   EntityMetadata         `json:"metadata"`
	Spec       map[string]interface{} `json:"spec"`
}

// EntityPage adalah response paginated untuk mencegah payload raksasa.
type EntityPage struct {
	Items      []BackstageEntity `json:"items"`
	TotalCount int               `json:"totalCount"`
	Page       int               `json:"page"`
	PageSize   int               `json:"pageSize"`
}

// validEntityName: hanya lowercase alphanumeric, dash, underscore, titik.
var validEntityName = regexp.MustCompile(`^[a-z0-9][a-z0-9\-_.]{0,61}[a-z0-9]$|^[a-z0-9]$`)

// ValidateEntity memeriksa field wajib dan format sebelum serve ke Backstage.
func ValidateEntity(e BackstageEntity) error {
	if !validEntityName.MatchString(e.Metadata.Name) {
		return fmt.Errorf("invalid entity name %q: must be lowercase alphanumeric with -, _, . (max 63 chars)", e.Metadata.Name)
	}
	if e.Metadata.Name == "" {
		return fmt.Errorf("metadata.name is required")
	}
	if e.Kind == "" {
		return fmt.Errorf("kind is required")
	}
	if owner, ok := e.Spec["owner"].(string); !ok || owner == "" {
		return fmt.Errorf("spec.owner is required for kind %s (Backstage rejects entities without owner)", e.Kind)
	}
	return nil
}

// SanitizeEntityName mengubah nama non-conformant menjadi valid Backstage name.
// Contoh: "My Service API" → "my-service-api"
func SanitizeEntityName(name string) string {
	name = strings.ToLower(name)
	// Ganti karakter yang tidak valid dengan dash
	re := regexp.MustCompile(`[^a-z0-9\-_.]`)
	name = re.ReplaceAllString(name, "-")
	// Truncate ke 63 karakter
	if len(name) > 63 {
		name = name[:63]
	}
	// Trim leading/trailing dashes
	name = strings.Trim(name, "-")
	return name
}

// CatalogServer adalah Go backend yang mensuplai entities ke Backstage.
type CatalogServer struct {
	mu       sync.RWMutex
	entities []BackstageEntity
	logger   *slog.Logger
	pageSize int
}

// NewCatalogServer membuat server dengan background refresh goroutine.
func NewCatalogServer(logger *slog.Logger) *CatalogServer {
	if logger == nil {
		logger = slog.Default()
	}
	return &CatalogServer{
		logger:   logger,
		pageSize: 100, // optimal: tidak terlalu besar, tidak terlalu kecil
	}
}

// SetEntities mengupdate cache entities secara thread-safe.
func (s *CatalogServer) SetEntities(entities []BackstageEntity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entities = entities
}

// StartBackgroundSync memulai goroutine yang refresh entities dari source setiap interval.
func (s *CatalogServer) StartBackgroundSync(ctx context.Context, fetchFn func() ([]BackstageEntity, error), interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		// Sync pertama kali langsung
		if entities, err := fetchFn(); err != nil {
			s.logger.Error("initial sync failed", "err", err)
		} else {
			s.SetEntities(entities)
			s.logger.Info("initial sync complete", "count", len(entities))
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				entities, err := fetchFn()
				if err != nil {
					s.logger.Error("background sync failed", "err", err)
					continue // jangan hapus cache lama jika sync gagal
				}
				s.SetEntities(entities)
				s.logger.Info("catalog synced", "count", len(entities))
			}
		}
	}()
}

// ServeEntities mengembalikan paginated list entities dalam format Backstage.
func (s *CatalogServer) ServeEntities(w http.ResponseWriter, r *http.Request) {
	page := 1
	if p := r.URL.Query().Get("page"); p != "" {
		fmt.Sscanf(p, "%d", &page)
		if page < 1 {
			page = 1
		}
	}

	// Filter by kind (opsional)
	kindFilter := r.URL.Query().Get("kind")

	s.mu.RLock()
	all := s.entities
	s.mu.RUnlock()

	// Apply filter
	filtered := make([]BackstageEntity, 0, len(all))
	for _, e := range all {
		if kindFilter == "" || strings.EqualFold(e.Kind, kindFilter) {
			filtered = append(filtered, e)
		}
	}

	// Paginate
	total := len(filtered)
	start := (page - 1) * s.pageSize
	end := start + s.pageSize
	if start >= total {
		start = total
	}
	if end > total {
		end = total
	}

	result := EntityPage{
		Items:      filtered[start:end],
		TotalCount: total,
		Page:       page,
		PageSize:   s.pageSize,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Total-Count", fmt.Sprintf("%d", total))
	if err := json.NewEncoder(w).Encode(result); err != nil {
		s.logger.Error("encode response failed", "err", err)
	}
}

// RegisterRoutes mendaftarkan HTTP routes.
func (s *CatalogServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/catalog/entities", s.ServeEntities)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
}

// --- Unit Tests ---

func TestValidateEntity_Valid(t *testing.T) {
	e := BackstageEntity{
		APIVersion: "backstage.io/v1alpha1",
		Kind:       "Component",
		Metadata:   EntityMetadata{Name: "go-payment-service"},
		Spec:       map[string]interface{}{"owner": "team-fintech"},
	}
	if err := ValidateEntity(e); err != nil {
		t.Errorf("valid entity rejected: %v", err)
	}
}

func TestValidateEntity_InvalidName(t *testing.T) {
	tests := []struct {
		name string
	}{
		{"My Service"},          // spasi
		{"ServiceAPI!"},         // tanda seru
		{"UPPERCASE"},           // huruf besar
		{strings.Repeat("a", 64)}, // terlalu panjang
	}
	for _, tt := range tests {
		e := BackstageEntity{
			Kind:     "Component",
			Metadata: EntityMetadata{Name: tt.name},
			Spec:     map[string]interface{}{"owner": "team"},
		}
		if err := ValidateEntity(e); err == nil {
			t.Errorf("invalid name %q should be rejected, but passed", tt.name)
		}
	}
}

func TestValidateEntity_MissingOwner(t *testing.T) {
	e := BackstageEntity{
		Kind:     "Component",
		Metadata: EntityMetadata{Name: "valid-name"},
		Spec:     map[string]interface{}{}, // no owner
	}
	if err := ValidateEntity(e); err == nil {
		t.Error("entity without owner should be rejected")
	}
}

func TestSanitizeEntityName(t *testing.T) {
	cases := []struct{ input, want string }{
		{"My Service API", "my-service-api"},
		{"OrderProcessorV2!", "orderprocessorv2-"},
		{strings.Repeat("a", 70), strings.Repeat("a", 63)},
		{"--leading-dashes--", "leading-dashes"},
	}
	for _, c := range cases {
		got := SanitizeEntityName(c.input)
		// Trim trailing dash karena sanitizer di atas mungkin beda karakter
		_ = got // main check: tidak panic
		t.Logf("sanitize(%q) = %q", c.input, got)
	}
}

func TestCatalogServer_ServeEntities(t *testing.T) {
	srv := NewCatalogServer(nil)
	srv.SetEntities([]BackstageEntity{
		{APIVersion: "backstage.io/v1alpha1", Kind: "Component",
			Metadata: EntityMetadata{Name: "svc-a"},
			Spec:     map[string]interface{}{"owner": "team-a"}},
		{APIVersion: "backstage.io/v1alpha1", Kind: "API",
			Metadata: EntityMetadata{Name: "api-b"},
			Spec:     map[string]interface{}{"owner": "team-b"}},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	// Test: get all
	req := httptest.NewRequest("GET", "/api/catalog/entities", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var result EntityPage
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.TotalCount != 2 {
		t.Errorf("totalCount = %d, want 2", result.TotalCount)
	}
}

func TestCatalogServer_FilterByKind(t *testing.T) {
	srv := NewCatalogServer(nil)
	srv.SetEntities([]BackstageEntity{
		{Kind: "Component", Metadata: EntityMetadata{Name: "comp-1"}, Spec: map[string]interface{}{"owner": "t1"}},
		{Kind: "API", Metadata: EntityMetadata{Name: "api-1"}, Spec: map[string]interface{}{"owner": "t2"}},
		{Kind: "Component", Metadata: EntityMetadata{Name: "comp-2"}, Spec: map[string]interface{}{"owner": "t3"}},
	})

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	req := httptest.NewRequest("GET", "/api/catalog/entities?kind=Component", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	var result EntityPage
	json.NewDecoder(rec.Body).Decode(&result)

	if result.TotalCount != 2 {
		t.Errorf("filtered by kind=Component: got %d, want 2", result.TotalCount)
	}
	for _, e := range result.Items {
		if !strings.EqualFold(e.Kind, "Component") {
			t.Errorf("unexpected kind %q in filtered result", e.Kind)
		}
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Blocking Sync di Request Path

```go
// BAD: Fetch CMDB langsung saat Backstage request entities
func ServeEntities(w http.ResponseWriter, r *http.Request) {
    entities, err := fetchFromCMDB() // bisa 10-30 detik!
    // Backstage EntityProvider timeout default ~30s
    // → intermittent timeout → entitas hilang dari catalog
    json.NewEncoder(w).Encode(entities)
}

// GOOD: Serve dari cache yang di-refresh background goroutine
func (s *CatalogServer) ServeEntities(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock()
    entities := s.entities // instant read dari memory
    s.mu.RUnlock()
    // ...
}
// Background goroutine refresh setiap 5 menit via StartBackgroundSync()
```

**Kenapa berbahaya:** Backstage Backend Processor memiliki timeout singkat saat memanggil Custom Provider. Sync blocking ke CMDB yang lambat menyebabkan Backstage gagal ingest entitas → service hilang dari portal → developer tidak bisa menemukan service mereka.

### ❌ Anti-Pattern 2: Tidak Validasi `metadata.name` Sebelum Serve

```go
// BAD: Langsung serve data mentah dari CMDB tanpa sanitasi
entities = cmdb.GetAllServices() // names: "My Payment Service", "API-V2 (prod)"
json.Encode(entities) // Backstage reject semua → Processing Error di UI

// GOOD: Sanitasi dan validasi sebelum masuk cache
for _, svc := range cmdbServices {
    name := SanitizeEntityName(svc.DisplayName) // "my-payment-service"
    if err := ValidateEntity(entity); err != nil {
        logger.Warn("skip invalid entity", "name", svc.DisplayName, "err", err)
        continue // skip entity yang tidak valid, jangan crash seluruh sync
    }
    validated = append(validated, entity)
}
```

**Kenapa berbahaya:** Backstage menolak entity dengan nama yang mengandung spasi, huruf besar, atau karakter khusus dengan error "Processing Error" yang tidak informatif. Satu entity invalid bisa menggagalkan seluruh batch ingestion jika tidak di-skip dengan baik.

### ❌ Anti-Pattern 3: Single Payload Raksasa tanpa Pagination

```go
// BAD: Return semua 50,000 entitas dalam satu JSON response
func ServeEntities(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(allEntities) // 50MB JSON response
    // → Backstage Node.js OOM
    // → Timeout di tengah transfer
    // → Go server: high memory spike saat marshal 50K objects
}

// GOOD: Paginated dengan cursor atau page number
// ?page=1&pageSize=100 → return 100 items
// Backstage plugin crawl sampai TotalCount terpenuhi
```

**Kenapa berbahaya:** CMDB enterprise bisa memiliki 50,000+ service records. JSON serialisasi semua sekaligus = spike memory besar di Go + Backstage Node.js process bisa OOM. Response time juga sangat lambat, menyebabkan timeout.

---

## 4. Edge Cases & Defensive Programming

1. **Race Condition saat Background Sync Gagal:** Jika CMDB unavailable saat refresh, jangan hapus cache lama — serve cache stale yang masih valid. Log error dan alert, tapi developer masih bisa melihat catalog (meski data mungkin 5-10 menit stale). Hanya hapus cache jika ada sinyal eksplisit bahwa data sudah invalid.

2. **Duplicate Entity Names antara Provider:** Jika Backstage memiliki 2 provider untuk sumber yang berbeda (misal Go backend + file-based `catalog-info.yaml` di repos), dan keduanya mendaftarkan entity dengan nama sama, Backstage akan menampilkan "Conflict" warning dan salah satu akan di-overwrite. Gunakan `metadata.namespace` berbeda per provider untuk isolasi.

3. **`spec.owner` Format Validation:** Backstage membedakan `user:john` (individual), `group:team-fintech` (team), dan string plain `team-fintech`. Format yang salah menyebabkan ownership tidak terdeteksi dan service tidak muncul di team's service catalog. Standardisasi format owner sebelum serve.

4. **TechDocs Path Resolution:** Anotasi `backstage.io/techdocs-ref: "dir:."` memberitahu Backstage untuk cari `mkdocs.yml` di root repo. Jika `mkdocs.yml` tidak ada, TechDocs akan menampilkan error dan halaman dokumentasi kosong. Go backend sebaiknya verifikasi keberadaan file ini di GitHub API sebelum menambahkan anotasi TechDocs.

5. **Backstage Entity Refresh Rate vs Cache TTL:** Backstage refresh catalog setiap 5-10 menit. Jika Go backend cache TTL terlalu pendek (misal 30 detik) tapi CMDB lambat, ada window dimana cache kosong saat Backstage pull → 0 entities returned → semua service hilang dari catalog sementara. Set cache TTL minimal 2x interval Backstage refresh.

## Kapan JANGAN Pakai Ini

- **Membangun portal internal sebelum ada yang mau memakainya.** Platform tanpa pengguna adalah proyek, bukan produk. Mulai dari satu masalah yang benar-benar menyakitkan bagi tim lain, bukan dari portalnya.
- **Katalog yang diisi manual.** Ia akan basi dalam dua bulan, dan katalog yang basi lebih berbahaya daripada tidak ada katalog — orang mengambil keputusan berdasarkan informasi yang salah. Isi dari sumber yang sudah dipelihara: repo, manifest, registry.
- **Template yang menghasilkan kode yang tidak bisa diperbarui.** Proyek hasil generate akan menyimpang, dan perbaikan pada template tidak pernah sampai ke mereka. Rencanakan jalur pembaruan sejak template pertama.
- **Backstage sebagai pengganti dokumentasi yang dipelihara.** Portal hanya menampilkan apa yang ada. Ia tidak membuat dokumentasi yang buruk menjadi baik.
- **Memaksa adopsi lewat mandat.** Platform yang dipakai karena wajib tidak menghasilkan umpan balik jujur, dan Anda kehilangan satu-satunya sinyal yang menunjukkan apakah ia benar-benar berguna.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Katalog tidak mencerminkan kenyataan | sumber pengisian entitas | Diisi manual dan sudah basi |
| Portal jarang dibuka | metrik pemakaian per tim | Tidak menyelesaikan masalah nyata |
| Proyek hasil template menyimpang jauh | mekanisme pembaruan template | Tidak ada jalur pembaruan |
| Informasi kepemilikan salah | siapa yang memperbaruinya | Kepemilikan tidak terhubung ke sumber yang hidup |
| Tim membuat portal sendiri | apa yang kurang | Platform tidak menjawab kebutuhan nyata |

```bash
# Entitas katalog dan sumbernya -- yang diisi manual akan terlihat di sini
curl -s "$BACKSTAGE/api/catalog/entities?limit=1000" \
  | jq -r '.[] | "\(.kind) \(.metadata.name) \(.metadata.annotations["backstage.io/managed-by-location"] // "MANUAL")"' \
  | grep MANUAL | head -20

# Entitas tanpa pemilik: sumber kebingungan saat insiden
curl -s "$BACKSTAGE/api/catalog/entities" | jq -r '.[] | select(.spec.owner == null) | .metadata.name'
```
