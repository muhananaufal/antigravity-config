# Benchmarking & pprof Profiling di Go

Benchmarking di Go adalah first-class citizen: `testing.B` adalah framework bawaan untuk mengukur performa secara statistik. `pprof` adalah tooling profiling untuk mendiagnosis CPU bottleneck, heap allocation, goroutine blocking, dan mutex contention secara mendalam.

---

## 1. Arsitektur Internal `testing.B`

```
go test -bench=. -benchmem -benchtime=3s -count=5
         │
         ▼
  testing.B Runner
  ┌─────────────────────────────────────────────────────┐
  │  1. Warmup phase: estimasi iterasi b.N              │
  │  2. Auto-scaling b.N: naik kelipatan 10 (1,10,100…) │
  │     sampai elapsed ≥ benchtime                      │
  │  3. Timer: b.StartTimer/b.StopTimer/b.ResetTimer    │
  │  4. Alloc tracking: runtime.ReadMemStats snapshot   │
  │     SEBELUM dan SESUDAH loop → hitung delta         │
  │  5. Output: ns/op, B/op, allocs/op                  │
  └─────────────────────────────────────────────────────┘
         │
         ├──► CPU Profile  → cpu.prof  → go tool pprof cpu.prof
         ├──► Mem Profile  → mem.prof  → go tool pprof -alloc_space mem.prof
         └──► Trace        → trace.out → go tool trace trace.out
```

**Method penting `testing.B`:**
- `b.N` — jumlah iterasi yang di-set otomatis oleh runner
- `b.ReportAllocs()` — aktifkan tracking heap alloc (setara `-benchmem`)
- `b.SetBytes(n)` — set payload size untuk kalkulasi throughput (MB/s)
- `b.ResetTimer()` — reset timer setelah phase setup, agar setup tidak terhitung
- `b.StartTimer()` / `b.StopTimer()` — pause timer di tengah loop (misal cleanup antar iterasi)
- `b.RunParallel(func(*testing.PB))` — benchmark concurrent goroutine

---

## 2. Kode Go Production-Ready

```go
package benchpprof

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
)

// --- Domain yang Akan Di-Benchmark ---

// UserProfile adalah struct yang diserialisasi/deserialisasi.
type UserProfile struct {
	ID       int64    `json:"id"`
	Name     string   `json:"name"`
	Email    string   `json:"email"`
	Tags     []string `json:"tags"`
	IsActive bool     `json:"is_active"`
}

// SerializeJSON serializes UserProfile ke JSON bytes (menggunakan encoder).
func SerializeJSON(p *UserProfile) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(p); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// SerializeJSONMarshal serializes menggunakan json.Marshal langsung (untuk perbandingan).
func SerializeJSONMarshal(p *UserProfile) ([]byte, error) {
	return json.Marshal(p)
}

// ConcatStrings menyambung string dengan cara naif (heap-allocating).
func ConcatStrings(parts []string) string {
	var result string
	for _, p := range parts {
		result += p // alokasi baru tiap iterasi
	}
	return result
}

// BuildStrings menyambung string dengan strings.Builder (zero-copy amortized).
func BuildStrings(parts []string) string {
	var sb strings.Builder
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	sb.Grow(total) // pre-allocate → 0 allocs jika cukup
	for _, p := range parts {
		sb.WriteString(p)
	}
	return sb.String()
}

// --- Variabel Sink (Mencegah Dead-Code Elimination) ---
// Wajib: variabel global agar compiler tidak menghapus loop benchmark.
var (
	globalBytes []byte
	globalStr   string
	globalErr   error
)

// --- Benchmarks ---

var sampleProfile = &UserProfile{
	ID:       12345,
	Name:     "Alice Wonderland",
	Email:    "alice@example.com",
	Tags:     []string{"admin", "verified", "premium"},
	IsActive: true,
}

// BenchmarkSerialize membandingkan dua metode serialisasi JSON.
func BenchmarkSerialize(b *testing.B) {
	b.Run("Encoder", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(sampleProfile.Name) + len(sampleProfile.Email)))
		var (
			result []byte
			err    error
		)
		for b.Loop() { // Go 1.24+: b.Loop() menggantikan `i < b.N` idiom
			result, err = SerializeJSON(sampleProfile)
		}
		globalBytes = result
		globalErr = err
	})

	b.Run("Marshal", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(sampleProfile.Name) + len(sampleProfile.Email)))
		var (
			result []byte
			err    error
		)
		for b.Loop() {
			result, err = SerializeJSONMarshal(sampleProfile)
		}
		globalBytes = result
		globalErr = err
	})
}

// BenchmarkStringConcat membandingkan concatenation vs Builder.
func BenchmarkStringConcat(b *testing.B) {
	parts := []string{"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"}

	b.Run("PlusOperator", func(b *testing.B) {
		b.ReportAllocs()
		var s string
		for b.Loop() {
			s = ConcatStrings(parts)
		}
		globalStr = s
	})

	b.Run("Builder", func(b *testing.B) {
		b.ReportAllocs()
		var s string
		for b.Loop() {
			s = BuildStrings(parts)
		}
		globalStr = s
	})
}

// BenchmarkParallel mengukur throughput dengan goroutine paralel.
func BenchmarkParallel(b *testing.B) {
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		var s string
		parts := []string{"foo", "bar", "baz"}
		for pb.Next() {
			s = BuildStrings(parts)
		}
		globalStr = s
	})
}

// --- Unit Tests (Bukan Benchmarks) ---

func TestSerializeJSON_RoundTrip(t *testing.T) {
	original := &UserProfile{
		ID:       1,
		Name:     "Test User",
		Email:    "test@example.com",
		Tags:     []string{"tag1", "tag2"},
		IsActive: true,
	}

	data, err := SerializeJSON(original)
	if err != nil {
		t.Fatalf("SerializeJSON failed: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("serialized data should not be empty")
	}

	var decoded UserProfile
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if decoded.ID != original.ID || decoded.Name != original.Name {
		t.Errorf("round-trip mismatch: got %+v, want %+v", decoded, original)
	}
}

func TestBuildStrings_Correctness(t *testing.T) {
	tests := []struct {
		name  string
		parts []string
		want  string
	}{
		{"empty", []string{}, ""},
		{"single", []string{"hello"}, "hello"},
		{"multi", []string{"foo", "bar", "baz"}, "foobarbaz"},
		{"unicode", []string{"🔥", "🚀", "✅"}, "🔥🚀✅"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := BuildStrings(tt.parts)
			if got != tt.want {
				t.Errorf("BuildStrings(%v) = %q, want %q", tt.parts, got, tt.want)
			}
		})
	}
}

// TestBuildStrings_EqualsConcatStrings memverifikasi keduanya menghasilkan output identik.
func TestBuildStrings_EqualsConcatStrings(t *testing.T) {
	// Gunakan random parts untuk memastikan konsistensi
	buf := make([]byte, 8)
	parts := make([]string, 5)
	for i := range parts {
		rand.Read(buf)
		parts[i] = string(buf)
	}
	if got, want := BuildStrings(parts), ConcatStrings(parts); got != want {
		t.Errorf("BuildStrings != ConcatStrings: %q vs %q", got, want)
	}
}
```

---

## 3. Workflow pprof: Profiling CPU & Memory

### 3.1. Generate Profil dari Benchmark

```bash
# CPU profile: jalankan 5s untuk data statistik lebih stabil
go test -bench=BenchmarkSerialize -benchtime=5s -cpuprofile=cpu.prof .

# Memory (heap allocation) profile
go test -bench=BenchmarkSerialize -benchmem -memprofile=mem.prof .

# Goroutine trace (untuk scheduling analysis)
go test -bench=BenchmarkParallel -trace=trace.out .
```

### 3.2. Analisis Interaktif dengan `go tool pprof`

```bash
# Mode web UI (paling mudah): buka browser localhost:8080
go tool pprof -http=localhost:8080 cpu.prof

# Mode CLI interaktif
go tool pprof cpu.prof
(pprof) top10          # 10 fungsi paling memakan CPU
(pprof) list SerializeJSON  # source-level annotation
(pprof) web            # buka call graph di browser (butuh graphviz)

# Memory: alloc_space (total alokasi) vs inuse_space (saat ini di heap)
go tool pprof -alloc_space mem.prof
(pprof) top10 -cum     # kumulatif (termasuk callee)
```

### 3.3. Diagram: Call Graph Flamegraph

```
CPU Flamegraph (baca dari bawah = caller, atas = callee):

    ┌─────────────────────────────────────────────────────────┐
    │  json.(*encodeState).reflectValue  (narrow = fast)     │ ← leaf
    ├────────────────────────────────────────────────────────┤
    │  json.(*encodeState).marshal                           │
    ├──────────────────────────────────────────────────────────┤
    │  json.NewEncoder(buf).Encode           (wide = hot!)   │ ← bottleneck
    ├──────────────────────────────────────────────────────────┤
    │  benchpprof.SerializeJSON              (benchmark root) │
    └──────────────────────────────────────────────────────────┘

Lebar bar = % waktu CPU dihabiskan di fungsi tersebut + semua calleenya.
```

### 3.4. Analisis `benchstat` (Statistik Antar Run)

```bash
# Install
go install golang.org/x/perf/cmd/benchstat@latest

# Jalankan benchmark 10x untuk statistik yang reliable
go test -bench=BenchmarkStringConcat -count=10 . | tee old.txt

# Setelah optimasi, jalankan lagi
go test -bench=BenchmarkStringConcat -count=10 . | tee new.txt

# Bandingkan
benchstat old.txt new.txt
# Output:
# name              old time/op    new time/op    delta
# StringConcat-8     198ns ± 2%     42ns ± 1%   -78.79%  (p=0.000 n=10+10)
# StringConcat-8     156B/op        0B/op        -100%
```

### 3.5. Production Profiling via `net/http/pprof`

```go
import (
    "net/http"
    _ "net/http/pprof" // side-effect: register /debug/pprof/* handlers
)

func main() {
    // Selalu di goroutine terpisah, JANGAN di port produksi publik!
    go http.ListenAndServe("localhost:6060", nil)
    // ...
}

// Ambil snapshot dari luar:
// go tool pprof http://localhost:6060/debug/pprof/heap
// go tool pprof http://localhost:6060/debug/pprof/goroutine
// curl http://localhost:6060/debug/pprof/trace?seconds=5 > trace.out
```

---

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Setup di Dalam Loop `b.N`

```go
// BAD: generateData() dihitung sebagai bagian dari benchmark
func BenchmarkProcess(b *testing.B) {
    for i := 0; i < b.N; i++ {
        data := generateHugeData() // setup terhitung! angka menjadi tidak valid
        Process(data)
    }
}

// GOOD: setup di luar loop, reset timer setelah setup
func BenchmarkProcess(b *testing.B) {
    data := generateHugeData() // setup sekali
    b.ResetTimer()             // wajib — hapus waktu setup dari hasil
    for i := 0; i < b.N; i++ {
        Process(data)
    }
}
```

**Kenapa berbahaya:** Angka `ns/op` yang dilaporkan akan mencakup waktu generate data — angka ini tidak merepresentasikan performa fungsi `Process` yang sebenarnya.

### ❌ Anti-Pattern 2: Dead-Code Elimination oleh Compiler

```go
// BAD: compiler mendeteksi result tidak dipakai → menghapus seluruh loop!
func BenchmarkMarshal(b *testing.B) {
    for i := 0; i < b.N; i++ {
        json.Marshal(sampleProfile) // result diabaikan → benchmark: 0.0001 ns/op
    }
}

// GOOD: sink ke variabel global mencegah optimasi compiler
var sink []byte
func BenchmarkMarshal(b *testing.B) {
    var result []byte
    for i := 0; i < b.N; i++ {
        result, _ = json.Marshal(sampleProfile)
    }
    sink = result // assign ke global di luar loop
}
```

**Kenapa berbahaya:** Benchmark melaporkan angka yang sangat cepat dan menyesatkan — seolah-olah fungsi sangat optimal padahal tidak pernah dieksekusi.

### ❌ Anti-Pattern 3: Hanya Satu Run tanpa `benchstat`

```go
// BAD: satu run saja tidak reliable — dipengaruhi GC cycle, CPU throttling, OS scheduling
go test -bench=. -count=1

// GOOD: minimal 6-10 run, gunakan benchstat untuk analisis statistik
go test -bench=. -count=10 | tee result.txt
benchstat result.txt
// Perhatikan kolom ±: jika > 5%, noise terlalu tinggi (cek thermal throttling)
```

**Kenapa berbahaya:** Satu sample bisa sangat outlier (GC pause di tengah run, CPU throttle sesaat). `benchstat` menghitung mean ± confidence interval dan menilai apakah perbedaan antar run statistically significant.

---

## 5. Edge Cases & Defensive Programming

1. **GC Pause Mid-Benchmark:** GC cycle yang terjadi di tengah loop `b.N` membuat satu iterasi drastis lebih lambat dari yang lain. Gunakan `runtime.GC()` sebelum `b.ResetTimer()` untuk memastikan GC tidak terjadi selama benchmark, atau terima variance-nya via `benchstat -count=10`.

2. **CPU Thermal Throttling:** Laptop modern akan menurunkan clock speed jika panas. Benchmark awal lebih cepat dari yang belakangan. Solusi: gunakan server dedicated / CI machine dengan cooling stabil, dan selalu gunakan `-count=10` untuk rata-rata.

3. **GOMAXPROCS & Parallel Benchmarks:** `b.RunParallel` menggunakan `GOMAXPROCS` goroutine. Jika benchmark dijalankan di container dengan `GOMAXPROCS=1` (default tanpa `automaxprocs`), hasil `BenchmarkParallel` tidak mencerminkan peforma di mesin multi-core. Selalu set `GOMAXPROCS` sesuai jumlah core target.

4. **pprof Overhead di Production:** Memory profiling (`-memprofilerate=1`) men-sample SETIAP alokasi — overhead CPU signifikan (~10-30%). Di production, gunakan sampling rate default (`runtime.MemProfileRate = 512*1024`) atau aktifkan hanya saat debugging.

5. **Flamegraph dengan Inlined Functions:** Go compiler secara agresif melakukan inlining. Fungsi kecil mungkin tidak muncul di flamegraph karena sudah di-inline ke caller. Nonaktifkan inlining sementara dengan `gcflags='-l'` jika butuh full call stack: `go test -bench=. -gcflags='-l' -cpuprofile=cpu.prof`.
