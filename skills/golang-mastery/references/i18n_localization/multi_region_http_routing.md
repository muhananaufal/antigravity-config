# Multi-Region HTTP Routing & SEO Hreflang di Go

Dokumen ini mendefinisikan arsitektur multi-region namespace routing di Golang (ideal untuk platform e-commerce global atau SaaS internasional). Selain routing, ini mencakup implementasi `hreflang` XML Sitemap multi-bahasa yang memastikan SEO global bebas kanibalisasi, dan teknik fallback Geo-IP.

## Arsitektur URL Localized Namespace

```ascii
                          +-------------------------+
                          | User Request /checkout  |
                          +-----------+-------------+
                                      |
                           (1) Is prefix present?
                               /id-id/checkout
                              /en-sg/checkout
                                      |
                     +----------------+----------------+
                     | No prefix                       | Prefix found
                     v                                 v
         +-----------------------+         +-----------------------+
         | Geo-IP Fallback Logic |         | Locale Context Inject |
         | Determine region &    |         | Set lang=id, rgn=ID   |
         | 301 Redirect to /XX-YY|         | Proceed to Next Handler|
         +-----------------------+         +-----------------------+
```

## Implementasi Kode Produksi (Go 1.23)

```go
package router

import (
	"context"
	"encoding/xml"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/text/language"
)

type regionCtxKey struct{}

// LocaleInfo menyimpan informasi wilayah dan bahasa untuk satu request
type LocaleInfo struct {
	Language language.Tag
	Region   string // e.g., "id", "sg", "us"
	Original string // e.g., "id-id"
}

// ValidLocales adalah daftar whitelist region yang didukung server ini.
var ValidLocales = map[string]LocaleInfo{
	"id-id": {Language: language.Indonesian, Region: "id", Original: "id-id"},
	"en-sg": {Language: language.English, Region: "sg", Original: "en-sg"},
	"en-us": {Language: language.AmericanEnglish, Region: "us", Original: "en-us"},
}

// MultiRegionMiddleware mengatur URL yang menggunakan namespace (e.g. /id-id/products).
func MultiRegionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathSegments := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		
		if len(pathSegments) > 0 {
			prefix := strings.ToLower(pathSegments[0])
			if locale, ok := ValidLocales[prefix]; ok {
				// Inject locale context
				ctx := context.WithValue(r.Context(), regionCtxKey{}, locale)
				
				// Rewrite Request URL for underlying handlers so they only see "/products"
				r.URL.Path = "/" + strings.Join(pathSegments[1:], "/")
				
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}

		// Fallback: Jika tidak ada prefix atau tidak valid, deteksi IP
		// Di produksi nyata, gunakan MaxMind GeoIP2. Di sini kita redirect ke US.
		target := "/en-us"
		if r.URL.Path != "/" {
			target += r.URL.Path
		}
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		
		http.Redirect(w, r, target, http.StatusMovedPermanently) // 301 for SEO
	})
}

// GetLocaleFromContext mengambil info region dari context
func GetLocaleFromContext(ctx context.Context) (LocaleInfo, bool) {
	loc, ok := ctx.Value(regionCtxKey{}).(*LocaleInfo)
	if ok && loc != nil {
		return *loc, true
	}
	return LocaleInfo{}, false
}

// XML Sitemap Structures untuk SEO Hreflang
type URLSet struct {
	XMLName xml.Name `xml:"urlset"`
	Xmlns   string   `xml:"xmlns,attr"`
	Xhtml   string   `xml:"xmlns:xhtml,attr"`
	URLs    []URL    `xml:"url"`
}

type URL struct {
	Loc   string `xml:"loc"`
	Links []Link `xml:"xhtml:link"`
}

type Link struct {
	Rel      string `xml:"rel,attr"`
	Hreflang string `xml:"hreflang,attr"`
	Href     string `xml:"href,attr"`
}

// GenerateSitemap membuahkan XML yang bisa dicerna Googlebot.
func GenerateSitemap(w http.ResponseWriter, r *http.Request) {
	set := URLSet{
		Xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
		Xhtml: "http://www.w3.org/1999/xhtml",
	}

	// Buat node URL beserta link korelasi hreflang-nya.
	// Di sistem asli, ini akan di-loop dari Database Content.
	u := URL{Loc: "https://example.com/en-us/checkout"}
	for prefix := range ValidLocales {
		u.Links = append(u.Links, Link{
			Rel:      "alternate",
			Hreflang: prefix,
			Href:     "https://example.com/" + prefix + "/checkout",
		})
	}
	u.Links = append(u.Links, Link{
		Rel:      "alternate",
		Hreflang: "x-default", // Fallback default SEO Google
		Href:     "https://example.com/en-us/checkout",
	})
	
	set.URLs = append(set.URLs, u)

	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(xml.Header))
	xml.NewEncoder(w).Encode(set)
}
```

## Unit & Benchmark Tests

```go
package router_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"yourproject/router" // Sesuaikan path
)

func TestMultiRegionMiddleware(t *testing.T) {
	// Dummy handler yang akan memeriksa context
	var receivedPath string
	var locale router.LocaleInfo
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		loc, _ := router.GetLocaleFromContext(r.Context())
		locale = loc
	})

	mw := router.MultiRegionMiddleware(next)

	// Kasus 1: Valid Prefix
	req := httptest.NewRequest("GET", "/id-id/checkout", nil)
	rr := httptest.NewRecorder()
	mw.ServeHTTP(rr, req)

	if receivedPath != "/checkout" {
		t.Errorf("Path rewrite failed, got: %s", receivedPath)
	}
	if locale.Original != "id-id" {
		t.Errorf("Context inject failed, got: %v", locale.Original)
	}

	// Kasus 2: Invalid Prefix (Akan di-redirect)
	req2 := httptest.NewRequest("GET", "/fr-fr/checkout?promo=1", nil)
	rr2 := httptest.NewRecorder()
	mw.ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusMovedPermanently {
		t.Errorf("Expected 301, got: %d", rr2.Code)
	}
	if loc := rr2.Header().Get("Location"); loc != "/en-us/checkout?promo=1" {
		t.Errorf("Invalid redirect location, got: %s", loc)
	}
}

func BenchmarkMiddlewareRewrite(b *testing.B) {
	req := httptest.NewRequest("GET", "/id-id/api/v1/products", nil)
	rr := httptest.NewRecorder()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	mw := router.MultiRegionMiddleware(next)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		mw.ServeHTTP(rr, req)
	}
}
```

## Anti-Patterns & Production Edge Cases

### ❌ Anti-Pattern 1: Menggunakan Cookie Tanpa URL Namespace untuk Bahasa
Mengubah bahasa hanya berdasarkan Cookie/Session, namun URL tetap sama (`/checkout`). 
**Dampak**: Bot mesin pencari (Googlebot) tidak mengindeks cookies. Google hanya akan melihat satu versi bahasa situs Anda, mengorbankan traffic SEO organik seluruh negara lain!
✅ **Benar**: Gunakan routing eksplisit seperti `/en-sg/checkout` (URL Namespace). Cookie hanya digunakan untuk preferensi fallback pengguna yang tidak menavigasi URL secara manual.

### ❌ Anti-Pattern 2: 302 Temporary Redirect untuk Geo-Fallback
Menggunakan HTTP status `302 Found` untuk membelokkan user dari `/` ke `/en-us/`.
**Dampak**: Google menganggapnya sementara, *link juice* dan *PageRank* domain root tidak diteruskan ke versi lokal.
✅ **Benar**: Selalu gunakan `301 Moved Permanently` atau setidaknya `307 Temporary Redirect` dengan hati-hati.

### ⚠️ Edge Case 1: Trailing Slash Collision
Permintaan ke `/id-id` vs `/id-id/` bisa memicu 404 jika pemotongan (trimming) URL tidak presisi. Middleware harus cukup defensif untuk membersihkan double slash `//` atau trailing slash berlebihan tanpa merusak *query parameters*.

### ⚠️ Edge Case 2: Spoofed Geo-IP dari Cloudflare/CDN
Jika menggunakan Cloudflare, r.RemoteAddr biasanya memuat IP Cloudflare (misal Anycast IP). Mengandalkan itu untuk routing IP Fallback akan membuat situs berpikir semua user berasal dari US.
**Mitigasi**: Pastikan Geo-IP checker melihat secara berurutan ke header `CF-IPCountry`, `X-Forwarded-For`, atau `X-Real-IP`.

### ⚠️ Edge Case 3: Sitemap "x-default" Hreflang
Banyak implementasi SEO melupakan tag `x-default`. Tanpa `x-default`, Googlebot mungkin kebingungan mana halaman utama yang ditawarkan kepada pengunjung Spanyol yang tidak masuk dalam region dukungan.
**Mitigasi**: Selalu definisikan satu canonical URL dengan hreflang `x-default` (biasanya bahasa Inggris/US) pada response XML Sitemap Anda.
