# W3C Baggage pada Distributed Tracing

> **Berlaku:** Go 1.21+ · W3C Baggage · OpenTelemetry-Go v1.24+ · **Lihat juga:** `observability_resilience/opentelemetry_tracing.md` · `microservices_grpc/grpc_interceptors_middleware.md` · `distributed_patterns_resilience/multi_tenancy_isolation.md` · `observability_resilience/structured_logging_zerolog.md`

Dalam arsitektur microservices, request klien melintas 5–10 layanan. Bagaimana Payment Service di ujung rantai mengetahui `tenant_id` atau `user_tier` dari request awal tanpa memaksa setiap layanan perantara membawa data itu di API schema masing-masing (domain coupling)?

Jawabannya adalah **W3C Baggage** — propagasi metadata cross-service via HTTP header `baggage: key=value`, bersamaan dengan `traceparent` W3C Trace Context.

---

## 1. Baggage vs Span Attributes — Perbedaan Kritis

```
Request Flow:
                                                          
  API Gateway  ── BUANG header `baggage` kiriman klien ──┐
  │  Autentikasi sesi  → TenantID=T1, Tier=gold          │  (Anti-Pattern 4)
  │  ctx: TraceID=AAA                                    │
  │  Inject baggage DARI SESI: tenant_id=T1, user_tier=gold
  │  Inject traceparent: 00-AAA-BBB-01                   
  │                                                       
  ├──► Order Service (HTTP Header: baggage: tenant_id=T1...)
  │    │  Span Attributes: order_id=789  ← hanya di span ini
  │    │  Baggage: tenant_id=T1          ← diteruskan ke hilir
  │    │                                                  
  │    └──► Payment Service              
  │         │  Baca baggage: user_tier=gold → diskon 10%
  │         │  Tanpa call balik ke API Gateway!           
  │         └──► Tracing Backend (Jaeger)                 
  │              Semua span terhubung via TraceID=AAA     
                                                          
Span Attributes → hanya visible di span itu sendiri      
Baggage        → propagasi ke SEMUA downstream services  
```

> Perhatikan langkah pertama. Payment Service boleh memercayai `user_tier` **hanya karena** gateway sudah membuang kiriman klien dan menuliskannya ulang dari sesi terautentikasi. Hilangkan langkah itu, dan diagram yang sama berubah menjadi eskalasi tier satu baris `curl`.

**Aturan main Baggage:**

| Batas | Angka | Ditegakkan oleh |
| :--- | :--- | :--- |
| Jumlah anggota | 180 | Spesifikasi W3C; `baggage.New()` menolak bila lewat |
| Panjang satu anggota | 4096 byte | Spesifikasi W3C |
| Total seluruh anggota | 8192 byte | Spesifikasi W3C |
| Panjang satu header di nginx | `large_client_header_buffers` — default `4 8k`, jadi **8 KB per header**, bukan 4 KB | nginx, dengan `431` |

- Value harus percent-encoded bila mengandung karakter di luar himpunan yang diizinkan.
- **Nilainya sepenuhnya dikendalikan pengirim.** Tidak ada tanda tangan, tidak ada verifikasi, dan tidak ada yang mencegah hop mana pun mengubahnya. Konvensi "hilir tidak mengubah nilai" hanyalah konvensi — ia tidak ditegakkan siapa pun. Lihat Anti-Pattern 4.
- Tidak dienkripsi — JANGAN simpan PII atau credential.

---

## 2. Kode Go Production-Ready

```go
package tracing

import (
	"context"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
)

// TenantInfo merepresentasikan data tenant yang dibawa via baggage.
type TenantInfo struct {
	ID   string
	Tier string
}

// SetupPropagator dipanggil SEKALI di main, SEBELUM server start.
//
// Seluruh kode di bawah membaca propagator lewat otel.GetTextMapPropagator(),
// bukan membangun sendiri, supaya hanya ada SATU tempat yang menentukan format
// propagasi. Membangun propagator lokal di tiap middleware terlihat lebih
// mandiri, tapi menciptakan dua sumber kebenaran yang bisa menyimpang diam-diam.
func SetupPropagator() {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
}

// InjectTenantBaggage menyisipkan tenant info ke dalam context.
//
// Dipanggil di edge service SETELAH autentikasi selesai. Nilainya WAJIB berasal
// dari sesi yang sudah diverifikasi — bukan dari header masuk. Lihat Anti-Pattern 4.
func InjectTenantBaggage(ctx context.Context, info TenantInfo) (context.Context, error) {
	if info.ID == "" {
		return ctx, fmt.Errorf("tenant ID must not be empty")
	}

	mID, err := baggage.NewMember("tenant_id", info.ID)
	if err != nil {
		return ctx, fmt.Errorf("invalid tenant_id baggage member: %w", err)
	}
	mTier, err := baggage.NewMember("user_tier", info.Tier)
	if err != nil {
		return ctx, fmt.Errorf("invalid user_tier baggage member: %w", err)
	}

	// baggage.New menegakkan batas W3C (180 anggota, 4096 byte per anggota,
	// 8192 byte total). Galatnya WAJIB dicek: mengabaikannya membuat baggage
	// diam-diam kosong alih-alih gagal keras.
	b, err := baggage.New(mID, mTier)
	if err != nil {
		return ctx, fmt.Errorf("bangun baggage: %w", err)
	}
	return baggage.ContextWithBaggage(ctx, b), nil
}

// ExtractTenantInfo mengembalikan ok=false bila tenant_id tidak ada.
//
// Bentuk (TenantInfo, bool) disengaja. Versi yang mengembalikan TenantInfo{}
// begitu saja mengubah "propagasi putus di satu hop" menjadi tenant ID KOSONG
// yang mengalir diam-diam ke query — dan di sistem multi-tenant, filter tenant
// yang kosong biasanya berarti TANPA filter sama sekali.
func ExtractTenantInfo(ctx context.Context) (TenantInfo, bool) {
	b := baggage.FromContext(ctx)
	id := b.Member("tenant_id").Value()
	if id == "" {
		return TenantInfo{}, false
	}
	return TenantInfo{ID: id, Tier: b.Member("user_tier").Value()}, true
}

// PropagatorMiddleware mengekstrak traceparent + baggage dari header masuk.
//
// tepiPublik WAJIB true di layanan mana pun yang bisa dijangkau dari internet,
// dan hanya boleh false di hop internal yang SELURUH pemanggilnya tepercaya.
func PropagatorMiddleware(tepiPublik bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tepiPublik {
			// Buang apa pun yang dikirim klien. Baggage yang sah dibuat ULANG
			// dari identitas yang sudah diautentikasi, bukan dari header.
			r.Header.Del("baggage")
		}
		ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// InjectBaggageToOutgoing menyisipkan traceparent + baggage ke request keluar.
// Wajib dipanggil saat memanggil layanan lain, atau rantai propagasi putus.
func InjectBaggageToOutgoing(ctx context.Context, req *http.Request) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// HargaSetelahDiskon memakai satuan minor (sen) bertipe int64, bukan float64.
//
// tier datang sebagai ARGUMEN, bukan dibaca dari baggage di dalam fungsi ini.
// Pemanggil yang bertanggung jawab membuktikan tier itu tepercaya — memindahkan
// pembacaan baggage ke dalam fungsi ini menyembunyikan asal-usul nilainya dan
// membuat eskalasi tier tidak terlihat saat code review.
func PriceAfterDiscount(hargaSen int64, tier string) int64 {
	var discountPercent int64
	switch tier {
	case "gold":
		discountPercent = 10
	case "platinum":
		discountPercent = 20
	default:
		return hargaSen
	}
	// Pembulatan ke bawah yang eksplisit dan deterministik. float64 untuk uang
	// menghasilkan selisih yang tidak bisa direkonsiliasi dengan pembukuan.
	return hargaSen - (hargaSen*discountPercent)/100
}
```

```go
package tracing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInjectTenantBaggage_Valid(t *testing.T) {
	ctx, err := InjectTenantBaggage(context.Background(), TenantInfo{ID: "TENANT-999", Tier: "platinum"})
	if err != nil {
		t.Fatalf("InjectTenantBaggage: %v", err)
	}
	info, ok := ExtractTenantInfo(ctx)
	if !ok {
		t.Fatal("ok = false, mau true")
	}
	if info.ID != "TENANT-999" || info.Tier != "platinum" {
		t.Errorf("info = %+v, mau {TENANT-999 platinum}", info)
	}
}

func TestInjectTenantBaggage_IDKosong(t *testing.T) {
	if _, err := InjectTenantBaggage(context.Background(), TenantInfo{Tier: "gold"}); err == nil {
		t.Error("want error for empty tenant ID, got nil")
	}
}

func TestExtractTenantInfo_ContextKosong(t *testing.T) {
	if _, ok := ExtractTenantInfo(context.Background()); ok {
		t.Error("ok = true untuk context tanpa baggage, mau false")
	}
}

// Uji terpenting di berkas ini. Tanpa ia, satu baris curl sudah cukup untuk
// menaikkan tier sendiri — dan tidak ada uji lain yang akan memberitahu Anda.
func TestTepiPublikMembuangBaggageKiriman(t *testing.T) {
	SetupPropagator()

	var terlihat bool
	h := PropagatorMiddleware(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, terlihat = ExtractTenantInfo(r.Context())
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("baggage", "tenant_id=KORBAN,user_tier=platinum")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if terlihat {
		t.Fatal("baggage kiriman klien lolos di tepi publik — eskalasi tier terbuka lebar")
	}
}

func TestPropagasiInternalE2E(t *testing.T) {
	SetupPropagator()

	ctx, err := InjectTenantBaggage(context.Background(), TenantInfo{ID: "T-ACME", Tier: "gold"})
	if err != nil {
		t.Fatalf("InjectTenantBaggage: %v", err)
	}

	outReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://hilir.internal/", nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	InjectBaggageToOutgoing(ctx, outReq)

	if h := outReq.Header.Get("baggage"); !strings.Contains(h, "tenant_id=T-ACME") {
		t.Fatalf("header baggage tanpa tenant_id: %q", h)
	}

	var diterima TenantInfo
	var ok bool
	h := PropagatorMiddleware(false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		diterima, ok = ExtractTenantInfo(r.Context())
	}))

	inReq := httptest.NewRequest(http.MethodGet, "/", nil)
	inReq.Header = outReq.Header.Clone()
	h.ServeHTTP(httptest.NewRecorder(), inReq)

	if !ok || diterima.ID != "T-ACME" || diterima.Tier != "gold" {
		t.Fatalf("hilir menerima %+v (ok=%v), mau {T-ACME gold}", diterima, ok)
	}
}

func TestHargaSetelahDiskon(t *testing.T) {
	tests := []struct {
		tier string
		cents  int64
		mau  int64
	}{
		{"gold", 10000, 9000},
		{"platinum", 10000, 8000},
		{"standard", 10000, 10000},
		{"", 10000, 10000},
		// Nilai yang TIDAK habis dibagi. Dengan float64, 1015 × 0.90 menghasilkan
		// 913.4999999999999 dan hasil akhirnya bergantung cara pembulatan.
		// Dengan int64 hasilnya selalu 914. Uji lama memakai 100.0 saja —
		// satu-satunya nilai yang membuat galat float64 tidak pernah terlihat.
		{"gold", 1015, 914},
	}
	for _, tt := range tests {
		if got := PriceAfterDiscount(tt.cents, tt.tier); got != tt.mau {
			t.Errorf("HargaSetelahDiskon(%d, %q) = %d, mau %d", tt.cents, tt.tier, got, tt.mau)
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
// → melewati batas W3C per-anggota bila >4096 byte, dan total >8192 byte
//   ditolak baggage.New()
// → di sisi jaringan: HTTP 431 di gateway, request tidak pernah sampai handler

// GOOD: Hanya ID ringan (5-30 bytes)
baggage.NewMember("user_id", "usr-81a") // downstream fetch dari DB/cache
```

**Kenapa berbahaya:** ada **dua** batas berbeda, dan keduanya sering tertukar. Batas **protokol** datang dari spesifikasi W3C (4096 byte per anggota, 8192 byte total) dan ditegakkan `baggage.New()` sebagai galat Go. Batas **infrastruktur** datang dari gateway: nginx memakai `large_client_header_buffers` yang default-nya `4 8k` — artinya **8 KB per header**, bukan 4 KB; Tomcat `maxHttpHeaderSize` default 8192 untuk seluruh header. Melewati batas pertama gagal di proses Anda; melewati batas kedua menghasilkan `431` di hop mana pun sepanjang rantai, dan satu member kelebihan ukuran merusak propagasi untuk seluruh request.

### ❌ Anti-Pattern 2: PII/Secrets di Baggage

```go
// BAD: Data sensitif terbang ke semua downstream + third-party services
baggage.NewMember("credit_card_number", "4532-1234-5678-9999")
baggage.NewMember("jwt_token", user.AccessToken) // leaked ke semua service!
// Jika service Anda call third-party API (payment processor, analytics)
// dengan context yang sama, baggage ikut terkirim → data breach

// MASIH BURUK: session ID adalah CREDENTIAL. Siapa pun yang menerimanya
// bisa menyamar sebagai pengguna itu — termasuk pihak ketiga di ujung rantai.
baggage.NewMember("session_id", "sess-abc123")

// GOOD: identifier internal yang tidak memberi kuasa apa pun kepada pemegangnya.
// Layanan hilir tetap harus melakukan otorisasinya sendiri.
baggage.NewMember("user_id", "usr-81a")
```

**Kenapa berbahaya:** Baggage TIDAK dienkripsi di wire. Setiap layanan dalam chain (termasuk SDK pihak ketiga yang membuat HTTP call dengan context yang sama) bisa membaca seluruh baggage. PII di baggage = pelanggaran GDPR/PCI-DSS otomatis.

> Garis pemisahnya bukan "ID versus data", melainkan **apakah nilai itu memberi kuasa kepada pemegangnya**. Session ID, refresh token, dan API key semuanya "hanya ID" — dan ketiganya cukup untuk menyamar sebagai pengguna. Yang aman dibawa adalah pengenal yang tidak berguna tanpa otorisasi terpisah.

### ❌ Anti-Pattern 3: Lupa Setup `otel.SetTextMapPropagator` Global

```go
// BAD: propagator global tidak pernah di-set
func main() {
    // Lupa panggil otel.SetTextMapPropagator(...)
    http.Handle("/", PropagatorMiddleware(true, handler))
}
// otel.GetTextMapPropagator() mengembalikan composite KOSONG — Extract tidak
// melakukan apa-apa, tidak mengembalikan galat, dan tidak mencatat apa pun.

// GOOD: setup SEKALI di main, SEBELUM server start
func main() {
    SetupPropagator()
    http.Handle("/", PropagatorMiddleware(true, handler))
}
```

**Kenapa berbahaya:** propagator global bawaan OTel-Go adalah **composite kosong** — bukan nil, bukan panic, melainkan objek yang sah dan tidak melakukan apa-apa. `Extract` mengembalikan context yang sama persis, `Inject` tidak menulis header. Tidak ada galat, tidak ada log. Yang Anda lihat hanyalah baggage yang kosong di semua layanan hilir, tanpa satu pun petunjuk ke penyebabnya.

> Inilah alasan kode di §2 membaca `otel.GetTextMapPropagator()` alih-alih membangun propagator lokal per-middleware. Middleware yang membangun propagatornya sendiri memang kebal terhadap bug ini — tapi ia juga mengabaikan konfigurasi global, sehingga menambah `propagation.B3{}` untuk kompatibilitas dengan sistem lama tidak berpengaruh apa-apa pada middleware itu, dan Anda kehilangan berjam-jam mencari tahu kenapa.

### ❌ Anti-Pattern 4: Memercayai Baggage yang Datang dari Luar

Ini kesalahan paling mahal di berkas ini, dan yang paling sering lolos review karena kodenya terlihat wajar.

```go
// BAD: tier dibaca dari baggage, di layanan yang bisa dijangkau dari internet
func HargaFinal(ctx context.Context, hargaSen int64) int64 {
    tenant, _ := ExtractTenantInfo(ctx)
    return PriceAfterDiscount(hargaSen, tenant.Tier)
}
```

`baggage` adalah **header HTTP biasa**. Tidak ditandatangani, tidak diverifikasi, sepenuhnya ditulis pengirim. Satu baris cukup untuk memberi diri sendiri diskon 20%:

```bash
curl -H 'baggage: tenant_id=T1,user_tier=platinum' https://api.contoh.com/checkout
```

Dan bila `tenant_id` juga diambil dari sana, yang Anda buka bukan lagi soal harga melainkan **akses lintas tenant** — pengirim memilih sendiri tenant mana yang ingin ia baca.

```go
// GOOD: tepi publik membuang baggage kiriman, lalu membangunnya ULANG dari
// identitas yang sudah diautentikasi.
func EdgeHandler(w http.ResponseWriter, r *http.Request) {
    session, err := AutentikasiSesi(r) // sumber kebenaran satu-satunya
    if err != nil {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }
    ctx, err := InjectTenantBaggage(r.Context(), TenantInfo{ID: session.TenantID, Tier: session.Tier})
    if err != nil {
        http.Error(w, "internal", http.StatusInternalServerError)
        return
    }
    // ... teruskan ctx ke hilir
}
```

Pembuangan header itu dilakukan `PropagatorMiddleware(true, …)` di §2. Aturannya sederhana: **baggage boleh dipercaya persis sejauh Anda memercayai pihak yang mengirimnya.** Di dalam mesh tertutup dengan mTLS, itu wajar. Di tepi yang menghadap internet, tidak pernah.

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
| Diskon/tier tidak cocok dengan data pelanggan | apakah tepi membuang `baggage` masuk | Klien menulis sendiri tier-nya (Anti-Pattern 4) |
| Satu akun membaca data tenant lain | asal `tenant_id` di layanan itu | `tenant_id` diambil dari header, bukan dari sesi |

```bash
# Apa yang benar-benar dikirim di header
curl -sv localhost:8080/api/v1/pesanan 2>&1 | grep -i '^> baggage'

# Uji tepi publik: nilai ini TIDAK boleh muncul di trace atau log hilir mana pun
curl -s -H 'baggage: tenant_id=UJI-SUNTIK,user_tier=platinum' localhost:8080/api/v1/checkout

# Distribusi ukuran baggage dari log terstruktur
kubectl logs -l app=api --since=1h | jq -r 'select(.baggage) | .baggage | length' | sort -n | tail -5

# Gateway yang menolak karena header terlalu besar
kubectl logs -l app=ingress --since=1h | grep -icE '431|header too large'
```
