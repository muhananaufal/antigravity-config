# Katalog Lokalisasi Dinamis Go dengan x/text (Zero-Downtime Reload)

Dokumen ini mendefinisikan standar arsitektur tingkat enterprise untuk implementasi i18n (Internationalization) di Golang menggunakan `golang.org/x/text`. Fokus utama adalah membangun katalog terjemahan yang dinamis, thread-safe, dan dapat di-reload secara on-the-fly (tanpa restart binary) melalui external data source seperti JSON, Redis, atau Database.

## Arsitektur Resolusi Bahasa & Reloading

```ascii
                      +-------------------+
                      | External Storage  |
                      | (Redis/DB/JSON)   |
                      +---------+---------+
                                |
                                v (Async Polling / Webhook)
+-----------------------+    +-----------------------+
|  Client Request       |    | Catalog Manager       |
| HTTP Accept-Language  +--->+ (sync.RWMutex)        +
+-----------------------+    | Updates message.Dict  |
                             +---------+-------------+
                                       |
+-----------------------+              v
| language.Matcher      |    +-----------------------+
| Resolves best match   +--->+ message.Printer       |
| id-ID, en-US, dll     |    | Formats string safely |
+-----------------------+    +-----------------------+
```

## Implementasi Kode Produksi (Go 1.23)

```go
package i18n

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/message/catalog"
)

// TranslationSource mendefinisikan interface untuk menarik translasi secara dinamis.
type TranslationSource interface {
	FetchTranslations(ctx context.Context) (map[string]map[string]string, error)
}

// DynamicCatalog mengelola i18n catalog secara thread-safe.
type DynamicCatalog struct {
	mu            sync.RWMutex
	cat           *catalog.Builder
	matcher       language.Matcher
	supportedTags []language.Tag
	source        TranslationSource
	logger        *slog.Logger
}

// NewDynamicCatalog membuat instance baru dari DynamicCatalog.
func NewDynamicCatalog(source TranslationSource, defaultLang language.Tag, logger *slog.Logger) *DynamicCatalog {
	return &DynamicCatalog{
		cat:           catalog.NewBuilder(),
		supportedTags: []language.Tag{defaultLang},
		matcher:       language.NewMatcher([]language.Tag{defaultLang}),
		source:        source,
		logger:        logger,
	}
}

// Reload menarik data terbaru dari source dan menukar katalog tanpa blocking baca yang lama berlebih.
func (dc *DynamicCatalog) Reload(ctx context.Context) error {
	data, err := dc.source.FetchTranslations(ctx)
	if err != nil {
		return err
	}

	newCat := catalog.NewBuilder()
	var newTags []language.Tag

	for langStr, dict := range data {
		tag, err := language.Parse(langStr)
		if err != nil {
			dc.logger.Warn("invalid language tag from source", "tag", langStr, "error", err)
			continue
		}
		newTags = append(newTags, tag)
		for key, val := range dict {
			if err := newCat.SetString(tag, key, val); err != nil {
				dc.logger.Error("failed to set translation string", "tag", tag, "key", key, "error", err)
			}
		}
	}

	if len(newTags) == 0 {
		return errors.New("no valid translations loaded")
	}

	newMatcher := language.NewMatcher(newTags)

	// Critical section: Swap old with new
	dc.mu.Lock()
	dc.cat = newCat
	dc.supportedTags = newTags
	dc.matcher = newMatcher
	dc.mu.Unlock()

	dc.logger.Info("translations reloaded successfully", "languages_count", len(newTags))
	return nil
}

// GetPrinter mengembalikan message.Printer untuk context atau HTTP request tertentu.
func (dc *DynamicCatalog) GetPrinter(acceptLanguage string) *message.Printer {
	dc.mu.RLock()
	defer dc.mu.RUnlock()

	tags, _, err := language.ParseAcceptLanguage(acceptLanguage)
	if err != nil {
		tags = []language.Tag{dc.supportedTags[0]} // fallback to default
	}

	tag, _, _ := dc.matcher.Match(tags...)
	return message.NewPrinter(tag, message.Catalog(dc.cat))
}

// Middleware injects the i18n printer into the request context.
func (dc *DynamicCatalog) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		printer := dc.GetPrinter(r.Header.Get("Accept-Language"))
		ctx := context.WithValue(r.Context(), printerCtxKey{}, printer)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type printerCtxKey struct{}

// PrinterFromContext retrieves the printer safely.
func PrinterFromContext(ctx context.Context) (*message.Printer, bool) {
	p, ok := ctx.Value(printerCtxKey{}).(*message.Printer)
	return p, ok
}
```

## Unit & Benchmark Tests

```go
package i18n_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"golang.org/x/text/language"
	"yourproject/i18n" // Ganti dengan path aslimu
)

type mockSource struct {
	data map[string]map[string]string
}

func (m *mockSource) FetchTranslations(ctx context.Context) (map[string]map[string]string, error) {
	return m.data, nil
}

func TestDynamicCatalog_ReloadAndMatch(t *testing.testing.T) {
	source := &mockSource{
		data: map[string]map[string]string{
			"en-US": {"hello": "Hello World"},
			"id-ID": {"hello": "Halo Dunia"},
		},
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	dc := i18n.NewDynamicCatalog(source, language.English, logger)
	
	err := dc.Reload(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	printerID := dc.GetPrinter("id-ID;q=0.9, en;q=0.8")
	resID := printerID.Sprintf("hello")
	if resID != "Halo Dunia" {
		t.Errorf("expected 'Halo Dunia', got '%s'", resID)
	}
}

func BenchmarkDynamicCatalog_GetPrinter(b *testing.B) {
	source := &mockSource{
		data: map[string]map[string]string{
			"en-US": {"hello": "Hello"},
			"id-ID": {"hello": "Halo"},
			"ja-JP": {"hello": "こんにちは"},
		},
	}
	dc := i18n.NewDynamicCatalog(source, language.English, slog.Default())
	_ = dc.Reload(context.Background())

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_ = dc.GetPrinter("id-ID;q=0.9,en-US;q=0.8")
		}
	})
}
```

## Anti-Patterns & Production Edge Cases

### ❌ Anti-Pattern 1: Mutasi Map Translasi secara Langsung Tanpa RWMutex
Merubah isi map translasi ketika request sedang berjalan tanpa proteksi lock akan berujung pada **panic: concurrent map read and map write**.
```go
// SALAH: Map ditulis selagi dibaca oleh goroutine lain
func (dc *DynamicCatalog) ReloadBad() {
    dc.unsafeMap["id-ID"]["hello"] = "Halo" // BOOM 💥
}
```
✅ **Benar**: Selalu inisialisasi ulang object `catalog.Builder` di memory terpisah, baru lakukan "pointer swap" di dalam blok `mu.Lock()`.

### ❌ Anti-Pattern 2: Menggunakan `fmt.Sprintf` untuk Pesan Multibahasa Kompleks
Format string standard Go tidak memahami urutan kata (word order) yang berbeda tiap bahasa atau aturan jamak (pluralization).
```go
// SALAH: Asumsi sintaks bahasa seragam
fmt.Sprintf("User %s has %d apples", name, count) 
```
✅ **Benar**: Gunakan `message.Printer` dari `x/text` yang mematuhi template katalog dinamis.

### ⚠️ Edge Case 1: Header `Accept-Language` Malformed / Malicious
Attacker bisa mengirim payload besar: `Accept-Language: aaaaaaaaaaaaaaaaa...`. Fungsi `language.ParseAcceptLanguage` dapat mengalami overhead berat.
**Mitigasi**: Selalu batasi (truncate) header string hingga maksimal 100 karakter sebelum mem-parsingnya untuk mencegah DDoS / CPU Exhaustion.

### ⚠️ Edge Case 2: Kaskade Tag Bahasa yang Tidak Sempurna (e.g., `es-AR` -> `es`)
Jika user meminta `es-AR` (Spanyol Argentina) namun katalog hanya punya `es` (Spanyol), `language.Matcher` otomatis akan fallback ke `es`. Namun, jika matcher tidak diinisialisasi dengan kumpulan root tags yang benar, ini bisa gagal. Pastikan root languages terdaftar di `supportedTags`.

### ⚠️ Edge Case 3: Thundering Herd pada Saat Reload Data
Jika 50 worker nodes menembak Redis/DB serentak untuk reload saat webhook ditembak, DB bisa drop.
**Mitigasi**: Terapkan splay/jitter delay acak `time.Sleep(rand.Intn(5000)*time.Millisecond)` sebelum `FetchTranslations` di dalam worker untuk meratakan beban ke DB.
