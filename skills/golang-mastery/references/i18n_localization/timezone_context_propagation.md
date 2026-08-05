# Propagasi Context Zona Waktu dan Penanganan DST

> **Berlaku:** Go 1.21+ · `time` · IANA tzdata · **Lihat juga:** `i18n_localization/multi_region_http_routing.md` · `concurrency/context_cancellation_timeout.md` · `fintech_reliability/financial_reporting_olap.md` · `background_jobs_worker/cron_scheduler_go.md`

Dokumen ini menjelaskan strategi propagasi `time.Location` di aplikasi berskala enterprise, merespons perubahan wilayah (region) client dan menangani kompleksitas Daylight Saving Time (DST) di Golang.

## Arsitektur Propagasi Zona Waktu

```ascii
+-------------+       +-------------------+       +--------------------+
| Client User |       | API Gateway / Web |       | Backend Services   |
| (TZ: +0700) |======>| (Middleware)      |======>| (DB Operations)    |
| X-Timezone: |       | Parse Header &    |       | UTC Default        |
| Asia/Jakarta|       | Inject to Context |       | Converts to UTC    |
+-------------+       +---------+---------+       +---------+----------+
                                |                           |
                          ctx.Value("tz")             Save to DB in UTC
                                |                           |
                                v                           v
                      +-------------------+       +--------------------+
                      | gRPC Interceptors |       | Response Formatter |
                      | Forward ctx to    |       | Convert DB UTC back|
                      | microservices     |<======| to User TZ         |
                      +-------------------+       +--------------------+
```

## Implementasi Kode Produksi (Go 1.23)

```go
package timezone

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// tzContextKey is an unexported type to prevent collisions in context.Value.
type tzContextKey struct{}

// DefaultTimezone adalah fallback jika request tidak memberikan header/informasi waktu.
var DefaultTimezone = time.UTC

// InjectTimezone middleware menyisipkan `time.Location` ke dalam request context
// berdasarkan header HTTP 'X-Timezone' atau claim JWT dari client.
func InjectTimezone(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tzStr := r.Header.Get("X-Timezone")
		loc := DefaultTimezone

		if tzStr != "" {
			parsedLoc, err := time.LoadLocation(tzStr)
			if err == nil {
				loc = parsedLoc
			}
			// Bisa juga pasang logging peringatan jika error, lalu gunakan UTC.
		}

		ctx := context.WithValue(r.Context(), tzContextKey{}, loc)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// LocationFromContext mengekstrak `time.Location` dari context.
// Selalu mengembalikan zona waktu valid (minimal UTC).
func LocationFromContext(ctx context.Context) *time.Location {
	if loc, ok := ctx.Value(tzContextKey{}).(*time.Location); ok {
		return loc
	}
	return DefaultTimezone
}

// ParseUserTime mengurai string waktu dari input user yang DIASUMSIKAN 
// berada dalam zona waktu lokal user tersebut (bukan UTC).
// Method ini kebal terhadap DST ambiguities dibandingkan `time.Parse`.
func ParseUserTime(ctx context.Context, layout, value string) (time.Time, error) {
	loc := LocationFromContext(ctx)
	
	// time.ParseInLocation wajib digunakan jika string waktu tidak mengandung offset Z/+07:00
	t, err := time.ParseInLocation(layout, value, loc)
	if err != nil {
		return time.Time{}, err
	}
	
	// Konversi langsung ke UTC untuk internal logic / database.
	return t.UTC(), nil
}

// FormatUserTime merender objek waktu internal (biasanya UTC) ke format 
// lokal user berdasarkan konteksnya.
func FormatUserTime(ctx context.Context, t time.Time, layout string) string {
	loc := LocationFromContext(ctx)
	return t.In(loc).Format(layout)
}
```

## Unit & Benchmark Tests

```go
package timezone_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"yourproject/timezone" // Ganti path
)

func TestInjectTimezoneAndParse(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Timezone", "America/New_York")
	
	var ctx context.Context
	
	// Dummy handler to capture context
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx = r.Context()
	})
	
	middleware := timezone.InjectTimezone(next)
	middleware.ServeHTTP(httptest.NewRecorder(), req)
	
	loc := timezone.LocationFromContext(ctx)
	if loc.String() != "America/New_York" {
		t.Fatalf("expected America/New_York, got %v", loc)
	}

	// Test DST: Musim panas vs Musim dingin
	layout := "2006-01-02 15:04:05"
	
	// Winter (EST): UTC-5
	tWinter, _ := timezone.ParseUserTime(ctx, layout, "2023-01-15 12:00:00")
	if tWinter.Hour() != 17 { // 12:00 EST -> 17:00 UTC
		t.Errorf("Winter time failure, got %v", tWinter)
	}

	// Summer (EDT): UTC-4
	tSummer, _ := timezone.ParseUserTime(ctx, layout, "2023-07-15 12:00:00")
	if tSummer.Hour() != 16 { // 12:00 EDT -> 16:00 UTC
		t.Errorf("Summer time failure, got %v", tSummer)
	}
}

func BenchmarkTimeParseInLocation(b *testing.B) {
	loc, _ := time.LoadLocation("Asia/Jakarta")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = time.ParseInLocation("2006-01-02 15:04:05", "2023-10-10 10:10:10", loc)
	}
}
```

## Anti-Patterns & Production Edge Cases

### ❌ Anti-Pattern 1: Menyimpan Local Time ke Database
Menyimpan `time.Now()` secara langsung ke DB tanpa `.UTC()` akan menciptakan *Hell of Timezones* ketika server di-deploy ke region AWS yang berbeda atau diakses user lintas negara.
```go
// SALAH: Bergantung pada zona waktu server OS
db.Exec("INSERT INTO events (start_time) VALUES (?)", time.Now()) 
```
✅ **Benar**: Selalu lakukan `time.Now().UTC()` dan pastikan koneksi DB engine (seperti Postgres/MySQL) disetel secara absolut menggunakan timezone `UTC`.

### ❌ Anti-Pattern 2: Menggunakan `time.Parse` untuk Waktu Tanpa Offset
`time.Parse` dengan string `"2023-10-10 15:00:00"` akan otomatis mengasumsikan waktu UTC. Jika user di Tokyo mengisinya, waktu akan meleset 9 jam secara senyap.
```go
// SALAH: Asumsi ghaib bahwa string ini UTC
t, _ := time.Parse("2006-01-02 15:04", "2023-01-01 10:00")
```
✅ **Benar**: Gunakan `time.ParseInLocation` bersama dengan Location object milik user dari middleware.

### ⚠️ Edge Case 1: Zone Database (tzdata) OS Tidak Update / Hilang
Pada kontainer Docker berbasis Alpine minimalis, paket `tzdata` sering absen. Pemanggilan `time.LoadLocation("Asia/Jakarta")` akan error atau fallback panic.
**Mitigasi**: Pastikan Dockerfile menyertakan `RUN apk add --no-cache tzdata`. Untuk keamanan Go 1.15+, import `_ "time/tzdata"` dalam package utama untuk mem-bundle TZ database ke dalam compiled binary, membuat aplikasi imun dari absensi tzdata OS (dengan kompromi ukuran binary +400KB).

### ⚠️ Edge Case 2: "The Missing Hour" pada Transisi DST
Di banyak negara (seperti USA), saat Spring Forward (musim semi), jam melompat dari 01:59 AM ke 03:00 AM. Jam 02:30 AM secara teknis **tidak pernah ada** pada hari itu. Jika user menginput jam 02:30, `time.ParseInLocation` Go akan menafsirkan ke waktu transisional terdekat yang valid. Anda bisa mengabaikan atau mereject ini, tapi validasi mutlak perlu.

### ⚠️ Edge Case 3: IANA Timezone ID Deprecation
ID seperti `US/Eastern` atau `Asia/Saigon` sering kali didepresiasi dan dipindahkan (`America/New_York` atau `Asia/Ho_Chi_Minh`). Jika DB pengguna lama masih menyimpan ID lawas, `LoadLocation` mungkin error suatu saat nanti.
**Mitigasi**: Buat layer translasi (alias mapping) dari zona waktu lawas ke zona waktu standar modern sebelum memanggil `time.LoadLocation`.

## Kapan JANGAN Pakai Ini

- **Menyimpan waktu tanpa zona.** `TIMESTAMP` tanpa zona waktu adalah sumber kebingungan permanen: tidak ada yang tahu apakah nilainya UTC, waktu server, atau waktu pengguna. `TIMESTAMPTZ` dan UTC di penyimpanan, konversi hanya di presentasi.
- **Zona waktu server sebagai zona waktu bisnis.** Memindahkan server ke region lain seharusnya tidak mengubah kapan hari akuntansi dimulai. Zona bisnis WAJIB eksplisit di konfigurasi.
- **Menghitung "besok" dengan menambah 24 jam.** Peralihan DST membuat sebagian hari berdurasi 23 atau 25 jam. Aritmetika kalender harus melalui `time.Date` pada lokasi yang benar.
- **Container tanpa `tzdata`.** `time.LoadLocation` gagal, dan pada image `scratch` atau `distroless` minimal itu berarti seluruh logika zona waktu tidak berfungsi. Sematkan dengan `import _ "time/tzdata"` atau pasang paketnya.
- **Menerima zona waktu dari input pengguna tanpa validasi.** Nama zona yang tidak dikenal menghasilkan galat pada jalur yang mungkin tidak menanganinya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `LoadLocation` gagal di produksi | ada tidaknya tzdata di image | Image minimal tanpa basis data zona |
| Laporan berubah setelah pindah region | zona waktu bisnis | Zona diambil dari server |
| Anomali dua kali setahun | penanganan DST | Aritmetika 24 jam |
| Waktu tampil salah bagi sebagian pengguna | konversi di presentasi | Zona pengguna tidak dibawa |
| Data lama ambigu | tipe kolom waktu | `TIMESTAMP` tanpa zona |

```bash
# tzdata di dalam image -- tanpa ini LoadLocation gagal
kubectl exec <pod> -- ls /usr/share/zoneinfo/Asia/Jakarta 2>&1
kubectl exec <pod> -- date

# Sematkan basis data zona ke dalam biner untuk image minimal
grep -rn 'time/tzdata' --include='*.go' .
```

```sql
-- Kolom waktu tanpa zona: sumber ambiguitas permanen
SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE data_type = 'timestamp without time zone';
```
