# Fuzz Testing di Go (Native go test -fuzz)

Sejak Go 1.18, fuzzing adalah fitur bahasa *first-class*. Coverage-guided fuzzer Go secara otomatis mengeksplorasi path kode yang belum dijangkau oleh seed corpus, mendeteksi panic, OOM, infinite loop, dan pelanggaran invariant yang tidak akan tertangkap oleh test tradisional.

---

## 1. Arsitektur Fuzzer Go

```
go test -fuzz=FuzzTargetName -fuzztime=60s -parallel=4
         │
         ▼
  Fuzzer Engine (coverage-guided mutation)
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  Seed Corpus                                                │
  │  ├── f.Add("hello")         ← developer-provided seeds     │
  │  └── testdata/fuzz/FuzzX/*  ← previously found corpus      │
  │              │                                              │
  │              ▼                                              │
  │  Mutation Engine (byte-flipping, boundary values, etc.)     │
  │              │                                              │
  │              ▼                                              │
  │  Target Function                                            │
  │              │                                              │
  │   ┌──────────┴──────────┐                                  │
  │   │ New coverage found? │ YES → save to corpus, explore     │
  │   │                     │ NO  → try next mutation           │
  │   └─────────────────────┘                                  │
  │              │ CRASH/PANIC found                            │
  │              ▼                                              │
  │  Save to testdata/fuzz/FuzzTargetName/<hash>                │
  │  Report: failing input + stack trace                        │
  └─────────────────────────────────────────────────────────────┘

Replay corpus tanpa fuzzer (di CI):
  go test -run=FuzzTargetName ./...  ← menjalankan seed + saved corpus sebagai unit test
```

**Kapan pakai Fuzzing vs Unit Test vs Property-Based:**

| Aspek | Unit Test | Property-Based (rapid) | Fuzz (go test -fuzz) |
|---|---|---|---|
| Input | Manual, fixed | Generated (typed) | Mutated bytes |
| Tujuan | Verifikasi behavior yang diketahui | Verifikasi invariant untuk domain types | Temukan crash/panic/OOM di sembarang input |
| Kecepatan | Sangat cepat | Cepat | Lambat (butuh waktu berjalan) |
| Cocok untuk | Happy path + known edge cases | Domain logic invariants | Parser, serializer, codec, kriptografi |

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"unicode/utf8"
)

// --- Domain yang Akan Di-Fuzz ---

// JSONRecord adalah struktur data yang akan di-parse dari raw JSON.
type JSONRecord struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Score float64 `json:"score"`
}

// ParseJSONRecord memparse raw JSON bytes ke JSONRecord dengan validasi ketat.
func ParseJSONRecord(data []byte) (*JSONRecord, error) {
	if len(data) == 0 {
		return nil, errors.New("empty input")
	}
	if len(data) > 1<<20 { // 1MB limit — mencegah OOM dari input raksasa
		return nil, fmt.Errorf("input too large: %d bytes (max 1MB)", len(data))
	}

	var rec JSONRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	if rec.ID <= 0 {
		return nil, errors.New("id must be positive")
	}
	if !utf8.ValidString(rec.Name) {
		return nil, errors.New("name contains invalid UTF-8")
	}
	if rec.Score < 0 || rec.Score > 100 {
		return nil, fmt.Errorf("score %v out of range [0, 100]", rec.Score)
	}
	return &rec, nil
}

// RoundTripJSON memverifikasi bahwa Marshal(Unmarshal(data)) == data (round-trip property).
func RoundTripJSON(data []byte) (bool, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return false, err // invalid JSON — bukan error kita
	}

	re, err := json.Marshal(v)
	if err != nil {
		return false, fmt.Errorf("re-marshal failed: %w", err)
	}

	// Re-unmarshal dan bandingkan
	var v2 any
	if err := json.Unmarshal(re, &v2); err != nil {
		return false, fmt.Errorf("re-unmarshal failed: %w", err)
	}

	return fmt.Sprintf("%v", v) == fmt.Sprintf("%v", v2), nil
}

// --- Regular Unit Tests (WAJIB ada, bukan hanya fuzz) ---

// TestParseJSONRecord_KnownCases memverifikasi behavior yang sudah diketahui.
// Di CI, ini juga akan menjalankan semua saved corpus dari testdata/fuzz/.
func TestParseJSONRecord_KnownCases(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{
			name:  "valid record",
			input: `{"id": 1, "name": "Alice", "score": 95.5}`,
		},
		{
			name:    "empty input",
			input:   "",
			wantErr: true,
		},
		{
			name:    "id zero rejected",
			input:   `{"id": 0, "name": "Bob", "score": 50}`,
			wantErr: true,
		},
		{
			name:    "score out of range",
			input:   `{"id": 1, "name": "Eve", "score": 150}`,
			wantErr: true,
		},
		{
			name:    "negative score rejected",
			input:   `{"id": 1, "name": "Eve", "score": -1}`,
			wantErr: true,
		},
		{
			name:    "invalid json",
			input:   `{broken`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseJSONRecord([]byte(tt.input))
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseJSONRecord(%q) expected error, got %+v", tt.input, got)
				}
			} else {
				if err != nil {
					t.Errorf("ParseJSONRecord(%q) unexpected error: %v", tt.input, err)
				}
				if got == nil {
					t.Error("expected non-nil result")
				}
			}
		})
	}
}

// --- Fuzz Targets ---

// FuzzParseJSONRecord memeriksa bahwa ParseJSONRecord tidak pernah panic
// pada sembarang input bytes. Error (invalid JSON, validation fail) diizinkan.
func FuzzParseJSONRecord(f *testing.F) {
	// Seed corpus: input valid yang mendorong fuzzer ke path kode yang bermakna
	f.Add([]byte(`{"id": 1, "name": "Alice", "score": 95.5}`))
	f.Add([]byte(`{"id": 999999, "name": "", "score": 0}`))
	f.Add([]byte(`{"id": 1, "name": "🔥🚀", "score": 100}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(nil))

	f.Fuzz(func(t *testing.T, data []byte) {
		// Invariant: ParseJSONRecord tidak boleh PERNAH panic.
		// Error diizinkan (invalid input) — panic tidak.
		// Tidak perlu recover() karena testing.F sudah handle panic.
		_, _ = ParseJSONRecord(data)
	})
}

// FuzzRoundTripJSON memeriksa properti round-trip JSON:
// Unmarshal(Marshal(Unmarshal(data))) harus konsisten.
func FuzzRoundTripJSON(f *testing.F) {
	f.Add([]byte(`{"key": "value"}`))
	f.Add([]byte(`[1, 2, 3]`))
	f.Add([]byte(`null`))
	f.Add([]byte(`true`))
	f.Add([]byte(`1.5e10`))

	f.Fuzz(func(t *testing.T, data []byte) {
		ok, err := RoundTripJSON(data)
		if err != nil {
			t.Skip() // invalid JSON input — expected, skip
		}
		if !ok {
			t.Fatalf("JSON round-trip property violated for input: %q", data)
		}
	})
}
```

### 2.1. Workflow CI untuk Fuzz Testing

```bash
# Lokal: jalankan fuzzer selama 60 detik untuk eksplorasi
go test -fuzz=FuzzParseJSONRecord -fuzztime=60s ./...

# Lokal: replay semua saved corpus sebagai unit test (tanpa fuzzer engine)
# Ini yang dijalankan di CI — tidak perlu -fuzz flag
go test -run=FuzzParseJSONRecord ./...

# Generate corpus dari file yang ada
go test -fuzz=FuzzParseJSONRecord -fuzztime=10m -parallel=8 ./...

# View saved corpus
ls testdata/fuzz/FuzzParseJSONRecord/

# Reproduksi specific crash
go test -run=FuzzParseJSONRecord/testdata/fuzz/FuzzParseJSONRecord/<crash-hash>
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mengecek Exact Output dalam Fuzz Target

```go
// BAD: fuzzer memberikan input random — tidak mungkin tahu expected output
f.Fuzz(func(t *testing.T, a, b int) {
    result := Add(a, b)
    if result != 42 { // selalu gagal untuk semua input kecuali (40, 2) etc.
        t.Errorf("expected 42, got %d", result)
    }
})

// GOOD: cek PROPERTI/INVARIANT yang selalu benar
f.Fuzz(func(t *testing.T, a, b int) {
    // Commutativity: Add(a,b) == Add(b,a)
    if Add(a, b) != Add(b, a) {
        t.Errorf("Add(%d,%d) != Add(%d,%d)", a, b, b, a)
    }
    // No overflow panic: Add harus selalu return tanpa panic
})
```

**Kenapa berbahaya:** Fuzz test dengan exact value akan selalu gagal pada 99.9999% input random. Fuzzer juga tidak akan belajar coverage baru karena test selalu fail di satu titik yang sama.

### ❌ Anti-Pattern 2: Mutasi Global State di dalam Fuzz Closure

```go
// BAD: closure fuzz dijalankan ribuan kali, bahkan secara concurrent (-parallel flag)
// Mutasi global state menyebabkan data race
var totalCalls int
f.Fuzz(func(t *testing.T, data []byte) {
    totalCalls++ // DATA RACE: concurrent fuzzer goroutine akses bersamaan!
    processData(data)
})

// GOOD: fuzz closure harus stateless — semua state lokal
f.Fuzz(func(t *testing.T, data []byte) {
    // Tidak ada state external yang di-mutasi
    result, _ := processData(data)
    _ = result
})
```

**Kenapa berbahaya:** Fuzzer menjalankan closure secara concurrent (`-parallel` flag). Data race akan terdeteksi oleh `-race` flag dan menyebabkan crash yang tidak related dengan fungsi yang di-fuzz.

### ❌ Anti-Pattern 3: Fuzz Target Tanpa Size Limit (→ OOM)

```go
// BAD: parser tanpa batas ukuran — fuzzer AKAN memberikan input 100MB+
func FuzzParseXML(f *testing.F) {
    f.Fuzz(func(t *testing.T, data []byte) {
        xml.Unmarshal(data, &v) // input 500MB → OOM → process killed
    })
}

// GOOD: selalu validasi ukuran input di awal fungsi yang di-fuzz
func ParseDocument(data []byte) error {
    const maxSize = 10 * 1024 * 1024 // 10MB limit
    if len(data) > maxSize {
        return fmt.Errorf("document too large: %d bytes", len(data))
    }
    // ... parsing logic
}
```

**Kenapa berbahaya:** Fuzzer secara aktif mencari input yang membuka code path baru — termasuk sangat panjang. Tanpa size limit, fuzzer akan menyebabkan OOM yang membunuh proses test secara tidak elegan.

---

## 4. Edge Cases & Defensive Programming

1. **Corpus Persistence di CI:** File di `testdata/fuzz/FuzzXxx/` harus di-commit ke Git. Setiap crash yang ditemukan disimpan di sini dan dijalankan otomatis sebagai regression test di setiap `go test`. Jangan `.gitignore` folder `testdata/fuzz/`.

2. **Fuzz Target Type Restrictions:** `f.Fuzz()` hanya menerima tipe: `string`, `[]byte`, `int`, `int8`-`int64`, `uint`, `uint8`-`uint64`, `float32`, `float64`, `bool`. Untuk struct kompleks, serialisasi ke `[]byte` dulu di seed corpus.

3. **Reproduksi Crash di Versi Go Berbeda:** Corpus yang digenerate di Go 1.21 mungkin tidak me-trigger crash yang sama di Go 1.23 karena perubahan internal. Simpan exact Go version di commit message saat meng-commit corpus baru.

4. **`t.Skip()` vs Return di Fuzz Target:** Jika fuzzer menghasilkan input yang tidak valid untuk domain kita (misal: invalid JSON), gunakan `t.Skip()` atau `return` untuk skip iteration tersebut. JANGAN gunakan `t.Fatal()` atau `t.Error()` untuk invalid input — itu bukan bug, itu expected behavior fuzzer mencari boundary.

5. **Paralel Fuzzing dengan `-parallel`:** Flag `-parallel=N` di `go test -fuzz` berbeda dari `t.Parallel()` di subtest. Flag ini mengatur jumlah fuzzer worker goroutine. Nilai default = GOMAXPROCS. Di CI, set `-parallel=1` untuk deterministic behavior dan menghindari konflik resource.
