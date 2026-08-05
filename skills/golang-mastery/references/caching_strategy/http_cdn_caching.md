# Panduan Ekstensif HTTP & CDN Caching di Golang

> **Berlaku:** Go 1.21+ · RFC 9111 · **Lihat juga:** `caching_strategy/cache_invalidation_strategies.md` · `microservices_grpc/rest_chi_middleware_stack.md` · `caching_strategy/cache_aside_singleflight.md` · `cli_tooling/binary_distribution_release.md`

Dalam arsitektur *web scale*, caching bukan sekadar optimasi opsional, melainkan fondasi vital untuk bertahan dari *traffic spike*, menghemat *bandwidth* egress, dan memberikan *Response Time* (TTFB) di bawah 50ms ke seluruh dunia. Caching bekerja berlapis (multi-tier), mulai dari browser pengguna, proxy korporat, *Content Delivery Network* (CDN) edge, hingga reverse proxy internal. Dokumen ini membedah spesifikasi HTTP Caching (RFC 9111), strategi CDN modern, dan implementasi idiomatic di Golang.

## 1. Arsitektur Multi-Tier Caching

Sebelum masuk ke kode, kita perlu memahami ke mana hilangnya data yang kita kirim dari Go origin. Caching flow terjadi di beberapa titik intervensi:

```text
+-----------+       +-----------+       +-------------+       +---------------+
|   User    |       | Corporate |       |    CDN      |       |  Go Origin    |
|  Browser  | <---> |   Proxy   | <---> |  Edge Node  | <---> | Server (App)  |
| (Private) |       | (Shared)  |       | (Shared)    |       | (Source/DB)   |
+-----------+       +-----------+       +-------------+       +---------------+
      |                   |                    |                      |
      |-- Local Cache     |-- Squid/Proxy      |-- Varnish/Nginx      |-- Redis/Memcached
      |   (Disk/Memory)   |   Cache            |   Cache              |
```

**Alur Request-Response (Cache Miss vs Cache Hit):**
1. **Request:** Browser mengirim `GET /api/v1/config`.
2. **CDN Intercept:** CDN mengecek apakah file ada di memori/disk mereka.
   - Jika **HIT** dan belum *stale*, CDN langsung menjawab 200 OK (Origin tidak tahu menahu).
   - Jika **MISS** atau *stale*, CDN mem-forward request ke Go Origin.
3. **Origin Response:** Go Origin menjawab dengan HTTP Headers yang menginstruksikan caching (`Cache-Control`, `ETag`, dll).
4. **CDN Cache Store:** CDN menyimpan respons berdasarkan instruksi, lalu meneruskannya ke Browser.

## 2. Anatomi Cache-Control Header

Header `Cache-Control` (RFC 9111) adalah mekanisme utama mengendalikan cache. Ini adalah *composite header* yang bisa memiliki banyak *directives*.

### Directives Utama

*   **`max-age=<seconds>`**: Waktu maksimal klien (termasuk browser) boleh menggunakan resource tanpa mengecek ke origin.
*   **`s-maxage=<seconds>`**: Waktu maksimal *shared cache* (CDN/Proxy) boleh menyimpan resource. Jika ada ini, CDN mengabaikan `max-age` dan `Expires`.
*   **`no-cache`**: **Miskonsepsi umum!** Ini **TIDAK** berarti "jangan di-cache". Ini berarti "boleh di-cache, TAPI wajib melakukan validasi (conditional request) ke origin sebelum menggunakan versi *cached*".
*   **`no-store`**: Ini baru berarti "jangan simpan sama sekali di disk/memori mana pun".
*   **`public`**: Boleh disimpan oleh cache mana pun (browser, CDN). Seringkali implisit jika ada `max-age`.
*   **`private`**: Hanya boleh disimpan oleh *private cache* (browser pengguna). CDN dilarang menyimpannya. Cocok untuk data personal pengguna.
*   **`must-revalidate`**: Jika *stale*, cache WAJIB validasi ke origin, dilarang menyajikan respons *stale* (meskipun origin down/putus koneksi).

### CDN-Specific Directives (Stale-While-Revalidate)

Standar modern (RFC 5861) memperkenalkan ekstensi yang membuat web terasa sangat cepat dan tahan banting.

*   **`stale-while-revalidate=<seconds>`**: Mengizinkan CDN menyajikan konten yang sudah kedaluwarsa (*stale*) di background, sambil secara asinkron (di background) melakukan revalidasi ke Origin. Pengguna tidak mengalami latensi revalidasi.
*   **`stale-if-error=<seconds>`**: Mengizinkan CDN menyajikan konten *stale* jika Origin mengembalikan error (500, 502, 503, 504) saat proses revalidasi. Ini adalah mekanisme *failover* luar biasa.

**Contoh Header Spektakuler:**
`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=86400, stale-if-error=259200`
*(Artinya: Browser cache 1 menit, CDN cache 5 menit. Jika CDN lewat 5 menit, sajikan yang lama dulu sambil background fetch (berlaku 1 hari). Jika origin mati, sajikan yang lama sampai 3 hari ke depan).*

## 3. Conditional Requests & Validation

Jika resource sudah melewati masa pakainya (`max-age`), klien tidak perlu mendownload ulang secara penuh jika konten belum berubah. Ini dilakukan via *Validation*.

### ETag (Entity Tag) & If-None-Match

`ETag` adalah hash/fingerprint dari konten.

1.  **Origin** merespons: `ETag: "W/abc123def"`
2.  **Browser** (setelah *stale*) request: `If-None-Match: "W/abc123def"`
3.  **Origin** (Go) cek hash. Jika sama, jawab: `304 Not Modified` (tanpa body). Klien tahu untuk pakai cache lama.

### Last-Modified & If-Modified-Since

Mirip ETag, tapi berbasis waktu (resolusi detik).

1.  **Origin** merespons: `Last-Modified: Wed, 21 Oct 2015 07:28:00 GMT`
2.  **Browser** request: `If-Modified-Since: Wed, 21 Oct 2015 07:28:00 GMT`
3.  **Origin** (Go) cek waktu modifikasi DB. Jika belum lewat, jawab: `304 Not Modified`.

## 4. Implementasi Go `http.ResponseWriter` Production-Ready

Mari kita buat handler Go yang mengimplementasikan semua ini dengan benar.

```go
package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"
)

// GenerateETag creates a strong ETag based on content
func GenerateETag(content []byte) string {
	hash := sha256.Sum256(content)
	return fmt.Sprintf(`"%s"`, hex.EncodeToString(hash[:])) // Must be quoted per RFC
}

// ConfigHandler serves system configuration with aggressive CDN caching
func ConfigHandler(w http.ResponseWriter, r *http.Request) {
	// 1. Simulate fetching config (e.g., from DB/Memory)
	configData := []byte(`{"theme":"dark", "version":"1.5.2", "features":["new_ui"]}`)
	
	// 2. Content Negotiation & Cache Key Variance
	// Tell CDN that response varies depending on Accept-Encoding (gzip/br) and Accept-Language
	w.Header().Set("Vary", "Accept-Encoding, Accept-Language")

	// 3. Generate Validation Headers
	etag := GenerateETag(configData)
	lastModified := time.Date(2023, 10, 1, 12, 0, 0, 0, time.UTC)

	// 4. Handle Conditional Requests FIRST to save bandwidth/CPU
	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	
	if since := r.Header.Get("If-Modified-Since"); since != "" {
		if t, err := http.ParseTime(since); err == nil && !lastModified.After(t) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}

	// 5. Set Cache-Control Directives
	// - Browser caches for 1 minute
	// - CDN caches for 1 hour
	// - Stale-while-revalidate for 24 hours
	// - Stale-if-error for 7 days
	cacheControl := "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800"
	w.Header().Set("Cache-Control", cacheControl)
	
	// Set CDN specific headers for granular purging (Surrogate Keys)
	// Fastly uses "Surrogate-Key", Cloudflare uses "Cache-Tag"
	w.Header().Set("Cache-Tag", "config,app-settings")
	w.Header().Set("Surrogate-Key", "config app-settings")

	// 6. Set Entity Headers
	w.Header().Set("ETag", etag)
	w.Header().Set("Last-Modified", lastModified.Format(http.TimeFormat))
	w.Header().Set("Content-Type", "application/json")

	// 7. Write Body
	w.Write(configData)
}
```

## 5. Vary Header: Pedang Bermata Dua

`Vary` memberi tahu CDN komponen request mana yang mengubah respons. Ini menentukan *Cache Key*.
Default CDN cache key: `Host + Path + QueryString`.

Jika API Go Anda melakukan kompresi (gzip/brotli), Anda **WAJIB** set:
`Vary: Accept-Encoding`
Jika tidak, CDN bisa melayani payload Gzip ke browser kuno yang tidak mendukung Gzip, membuat layar blank.

**Peringatan (Vary Pitfall):**
Jangan pernah set `Vary: User-Agent`. Ada ratusan ribu User-Agent string. Ini akan memecah belah cache (Cache fragmentation) menjadi ratusan ribu variasi, membunuh *cache hit ratio* Anda menjadi 0%.

## 6. CDN Purging (Invalidation) & Surrogate Keys

Seringkali `s-maxage` dibuat panjang (misal 1 tahun) demi cache hit tinggi, lalu kita ingin secara eksplisit *purge* (hapus) cache di CDN saat data di Go berubah.

*Purge by URL* lambat dan sulit jika ada banyak URL yang menampilkan data yang sama (misal produk A muncul di homepage, kategori, dan list).
Solusi: **Surrogate Keys / Cache Tags**.

Anda menyuntikkan header meta saat serve (seperti di atas: `Cache-Tag: config`). Saat data berubah, server Go Anda menembak API CDN.

**Contoh Worker Purge ke Cloudflare (Go):**

```go
package purge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

type CloudflarePurgeReq struct {
	Tags []string `json:"tags"`
}

func PurgeCloudflareCache(zoneID, apiToken string, tags []string) error {
	url := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/purge_cache", zoneID)
	
	reqBody, _ := json.Marshal(CloudflarePurgeReq{Tags: tags})
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(reqBody))
	
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")
	
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != 200 {
		return fmt.Errorf("purge failed: status %d", resp.StatusCode)
	}
	return nil
}
```

## 7. Anti-Patterns

### Anti-Pattern 1: Menggunakan `no-cache` untuk konten statis tanpa sadar
❌ **BAD:** Mengirim `Cache-Control: no-cache` untuk file CSS/JS statis, tanpa implementasi ETag/Last-Modified.
**Dampak:** Menguras bandwidth. Browser *wajib* validasi, tapi karena tidak ada ETag, origin tidak bisa menjawab 304, dan berakhir dengan menjawab 200 OK beserta body utuh 1MB terus menerus setiap request!

✅ **GOOD:** Gunakan versi immutable (misal `app.v123.css`), cache 1 tahun, atau gunakan ETag.
```go
// GOOD: Immutable static assets pattern
w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
```

### Anti-Pattern 2: Mislabeled Private Content di CDN
❌ **BAD:** Mengirim JSON data personal (misal saldo user) dengan `Cache-Control: max-age=300`. (Tanpa `private`, ini dianggap `public`).
**Dampak:** CDN akan menyimpan response (saldo user A) dan menampilkannya ke user B yang meminta URL yang sama! Ini adalah **Data Breach / Security Incident kritikal**.

✅ **GOOD:** Eksplisit `private` atau `no-store` untuk data terautentikasi.
```go
// GOOD: Personal/Authenticated Data
w.Header().Set("Cache-Control", "private, no-cache, no-store, must-revalidate")
```

## 8. Unit Testing HTTP Caching

Test yang solid wajib memverifikasi interaksi conditional request.

```go
package cache_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"cache" // assuming the package above
)

func TestConfigHandler_CacheHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/config", nil)
	rr := httptest.NewRecorder()

	cache.ConfigHandler(rr, req)

	// Verify headers
	if rr.Header().Get("Cache-Control") == "" {
		t.Error("Missing Cache-Control header")
	}
	if rr.Header().Get("ETag") == "" {
		t.Error("Missing ETag header")
	}
}

func TestConfigHandler_Conditional_IfNoneMatch(t *testing.T) {
	// 1. Initial Request to get ETag
	req1 := httptest.NewRequest(http.MethodGet, "/config", nil)
	rr1 := httptest.NewRecorder()
	cache.ConfigHandler(rr1, req1)
	
	etag := rr1.Header().Get("ETag")
	if rr1.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %d", rr1.Code)
	}

	// 2. Conditional Request using ETag
	req2 := httptest.NewRequest(http.MethodGet, "/config", nil)
	req2.Header.Set("If-None-Match", etag)
	rr2 := httptest.NewRecorder()
	cache.ConfigHandler(rr2, req2)

	// Should return 304 Not Modified
	if rr2.Code != http.StatusNotModified {
		t.Errorf("Expected 304 Not Modified, got %d", rr2.Code)
	}
	// Body should be empty
	if rr2.Body.Len() > 0 {
		t.Errorf("Expected empty body on 304, got %d bytes", rr2.Body.Len())
	}
}

func TestConfigHandler_Conditional_IfModifiedSince(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/config", nil)
	// Give a future date
	req.Header.Set("If-Modified-Since", "Sun, 01 Jan 2030 00:00:00 GMT")
	rr := httptest.NewRecorder()

	cache.ConfigHandler(rr, req)

	if rr.Code != http.StatusNotModified {
		t.Errorf("Expected 304 Not Modified, got %d", rr.Code)
	}
}
```

## 9. 5 Edge Cases Implementatif yang Sering Bikin Pusing

1.  **CDN Cache Bypass untuk Authenticated Content (Cookie / Authorization)**
    *Kasus:* API Endpoint campuran (guest bisa akses versi umum, logged-in user dapat versi spesifik).
    *Solusi:* CDN modern otomatis bypass cache jika melihat request header `Authorization` atau `Cookie`. Namun Anda *harus* memastikannya di Origin. Gunakan `Vary: Cookie` jika respons bergantung pada sesi, atau bypass eksplisit di edge compute (VCL/Cloudflare Worker) jika deteksi session token.

2.  **Reverse Proxy vs CDN `Cache-Control` Konflik**
    *Kasus:* Nginx di belakang (reverse proxy) juga melakukan caching. Anda set `s-maxage=3600`. CDN nge-cache 1 jam. Nginx internal Anda juga nge-cache 1 jam! Jika Anda purge CDN, Nginx Anda *masih* menyajikan yang lama.
    *Solusi:* CDN-specific header. Cloudflare menggunakan `Cloudflare-CDN-Cache-Control`, Fastly menggunakan `Surrogate-Control`. Header ini dipatuhi oleh CDN, sedangkan proxy internal Anda patuh pada `Cache-Control` biasa.
    ```go
    // Nginx caches for 1 min, Cloudflare for 1 day
    w.Header().Set("Cache-Control", "public, s-maxage=60")
    w.Header().Set("Cloudflare-CDN-Cache-Control", "max-age=86400") 
    ```

3.  **`Vary` Header Hilang di Reverse Proxy**
    *Kasus:* Load balancer/Nginx internal men-strip/menghapus header `Vary` Anda demi efisiensi, CDN di depan jadi caching membuta (menyatukan GZIP dan uncompressed).
    *Solusi:* Audit konfigurasi reverse proxy (misal `gzip_vary on;` di Nginx). Gunakan observability (curl lurus ke origin vs curl lewat proxy) untuk memastikan header `Vary` lolos sampai luar.

4.  **ETag Weak vs Strong**
    *Kasus:* Go origin membalas dengan Weak ETag `W/"123"`. Proxy/CDN mengganti kompresi secara on-the-fly (misal dari Gzip ke Brotli). Weak ETag masih valid untuk konten *semantik* yang sama. Jika Anda butuh bytel-for-byte exact (Strong ETag `"123"`), modifikasi konten oleh proxy akan merusak ETag dan cache validation gagal terus.
    *Solusi:* Untuk JSON/HTML biasa, lebih aman gunakan Weak ETag (tambah prefix `W/`) jika infrastruktur Anda suka merekayasa payload di perjalanan.

5.  **Stale-While-Revalidate Thunder Herd Problem**
    *Kasus:* Konfigurasi `stale-while-revalidate` gagal di-share antar *worker node* di CDN (tergantung vendor). Saat item expired, ratusan request serentak tembus ke origin untuk *revalidate*.
    *Solusi:* Di Go Origin, gunakan teknik konkurensi (single-flight pattern) dengan `golang.org/x/sync/singleflight` untuk memastikan berapapun CDN node yang menjebol, Go hanya melakukan 1x query ke DB.
    ```go
    // Inside handler using singleflight
    v, err, _ := requestGroup.Do(cacheKey, func() (interface{}, error) {
        return fetchFromDatabase(cacheKey)
    })
    ```

---
*Reference ini dirancang untuk insinyur backend dan DevOps dalam merancang pipeline distribusi aset/API yang resilient.*

## Kapan JANGAN Pakai Ini

- **`Cache-Control: public` untuk respons yang bergantung identitas pengguna.** Satu respons milik satu pengguna akan disajikan CDN kepada semua orang. Ini kebocoran data yang paling mudah terjadi dan paling sulit dipercaya sudah terjadi.
- **`ETag` yang dihitung dari waktu pembuatan.** Ia berubah setiap kali meski isinya sama, sehingga revalidasi tidak pernah menghasilkan `304` dan seluruh mekanismenya jadi beban tanpa manfaat.
- **TTL panjang tanpa mekanisme purge.** Aset yang salah akan bertahan selama TTL di ribuan edge, dan Anda tidak punya cara memperbaikinya selain menunggu. Pakai URL berversi (fingerprint) untuk aset statis.
- **`Vary` pada header berkardinalitas tinggi.** `Vary: User-Agent` memecah cache menjadi ribuan varian dan hit rate mendekati nol — cache-nya ada, manfaatnya tidak.
- **Meng-cache respons galat.** `500` yang tersimpan mengubah gangguan sepuluh detik menjadi gangguan sepanjang TTL, dan sering baru ketahuan setelah gangguan aslinya lama berlalu.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Pengguna melihat data pengguna lain | `Cache-Control` pada respons berautentikasi | Respons privat ditandai publik |
| Hit rate CDN sangat rendah | header `Vary` | Cache terpecah oleh header berkardinalitas tinggi |
| Revalidasi tidak pernah `304` | dasar perhitungan `ETag` | ETag berubah meski isi sama |
| Galat bertahan lama setelah diperbaiki | apakah `5xx` ikut di-cache | Respons galat tersimpan di edge |
| Aset lama muncul setelah deploy | apakah URL berfingerprint | Purge tidak menjangkau semua edge |

```bash
# Header yang benar-benar dikirim -- periksa untuk endpoint berautentikasi
curl -sI -H 'Authorization: Bearer x' https://api.contoh.id/v1/profil \
  | grep -iE 'cache-control|vary|etag|age|x-cache'

# Apakah CDN benar-benar menyimpannya? X-Cache/CF-Cache-Status menjawabnya.
curl -sI https://cdn.contoh.id/app.js | grep -iE 'x-cache|cf-cache-status|age'

# Revalidasi menghasilkan 304 atau tidak
ETAG=$(curl -sI https://cdn.contoh.id/app.js | grep -i etag | tr -d '\r' | cut -d' ' -f2)
curl -sI -H "If-None-Match: $ETAG" https://cdn.contoh.id/app.js | head -1

# Endpoint berautentikasi yang ditandai publik -- daftar risiko kebocoran
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.auth==true and (.cache_control|test("public"))) | .path' | sort | uniq -c
```
