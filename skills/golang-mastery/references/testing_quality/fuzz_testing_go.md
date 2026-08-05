# Fuzz Testing di Go (Native go test -fuzz)

> **Berlaku:** Go 1.21+ (fuzzing native sejak 1.18) · **Lihat juga:** `testing_quality/property_based_testing.md` · `testing_quality/govulncheck_security_scan.md` · `cybersecurity_zerotrust/security_fuzzing_go.md` · `runtime_internals/reflection_unsafe_pointer.md`

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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	// CATATAN: pemeriksaan `!utf8.ValidString(rec.Name)` yang ada di versi
	// sebelumnya adalah CABANG MATI dan sengaja dihapus.
	//
	// `encoding/json` mengganti byte UTF-8 tidak valid dengan U+FFFD saat
	// men-decode ke `string`, sehingga `rec.Name` SELALU UTF-8 valid dan
	// NOTE: the `!utf8.ValidString(rec.Name)` check from previous
	// versions is DEAD CODE and has been intentionally removed.
	//
	// `encoding/json` replaces invalid UTF-8 bytes with U+FFFD when
	// decoding into a `string`, so `rec.Name` is ALWAYS valid UTF-8
	// and that branch can never be taken. Ironically: fuzzing is the
	// easiest tool to prove this — coverage reports show that line
	// is never touched no matter how long the fuzzer runs.
	//
	// If you want to reject inputs that contain broken bytes,
	// check the `data` itself, not the decoded result:
	if bytes.ContainsRune(data, utf8.RuneError) && !bytes.Contains(data, []byte("")) {
		return nil, errors.New("input contains invalid UTF-8 bytes")
	}
	if rec.Score < 0 || rec.Score > 100 {
		return nil, fmt.Errorf("score %v out of range [0, 100]", rec.Score)
	}
	return &rec, nil
}

// RoundTripJSON checks NORMALIZATION properties, not byte-for-byte round-trips.
//
// Nama dan komentar lama menyatakan "Marshal(Unmarshal(data)) == data" —
// properti yang BUKAN yang diperiksa kode ini, dan yang memang TIDAK BENAR:
// spasi, urutan kunci, dan format angka semuanya berubah setelah satu putaran.
// Yang benar-benar berlaku adalah idempotensi setelah normalisasi pertama:
// sekali data melewati Unmarshal→Marshal, putaran berikutnya tidak lagi
// mengubah apa pun.
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
		{
			// Batas 1 MB adalah satu-satunya penjaga terhadap OOM di fungsi
			// ini, dan sebelumnya tidak punya satu pun kasus uji. Penjaga
			// yang tidak diuji adalah penjaga yang bisa hilang saat refactor
			// tanpa ada yang menyadarinya.
			name:    "melebihi batas 1 MB",
			input:   `{"id":1,"name":"` + strings.Repeat("a", 1<<20) + `"}`,
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
		rec, err := ParseJSONRecord(data)

		// Membuang kedua nilai kembalian dengan `_, _ =` — seperti versi
		// sebelumnya — membuat target ini hanya menangkap PANIC. Itu lantai
		// terendah fuzzing, dan menyia-nyiakan seluruh pekerjaan fuzzer:
		// ia mengeksplorasi ribuan masukan lalu tidak ada satu pun asersi
		// yang bisa gagal selain crash.
		//
		// Yang diperiksa di bawah adalah POSTCONDITION fungsi terhadap
		// dirinya sendiri: apa pun masukannya, hasilnya tidak boleh pernah
		// melanggar aturan yang fungsi itu klaim tegakkan.
		if err != nil {
			if rec != nil {
				t.Fatalf("error AND non-nil record simultaneously: %+v", rec)
			}
			return
		}
		if rec == nil {
			t.Fatal("nil error but record is also nil")
		}
		if rec.ID <= 0 {
			t.Fatalf("record received with invalid ID: %d", rec.ID)
		}
		if rec.Score < 0 || rec.Score > 100 {
			t.Fatalf("record received with score out of range: %v", rec.Score)
		}
		if !utf8.ValidString(rec.Name) {
			t.Fatalf("record received with non-UTF-8 name: %q", rec.Name)
		}
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

# Lihat corpus tersimpan
ls testdata/fuzz/FuzzParseJSONRecord/

# Reproduksi satu crash: -run mencocokkan NAMA UJI, bukan path berkas.
# Yang dipakai hanya NAMA BERKAS-nya (basename), bukan path lengkapnya —
# bentuk lama `-run=FuzzX/testdata/fuzz/FuzzX/<hash>` tidak cocok dengan
# apa pun dan diam-diam menjalankan NOL uji, yang terbaca seperti lulus.
go test -run='FuzzParseJSONRecord/771e938e4458e983'

# Pastikan sesuatu benar-benar berjalan: -v menampilkan nama uji yang cocok
go test -run='FuzzParseJSONRecord/771e938e4458e983' -v
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

## Kapan JANGAN Pakai Ini

- **Untuk kode yang tidak menerima input dari luar.** Fuzzing bersinar pada parser, decoder, dan apa pun yang menyentuh byte dari jaringan atau berkas. Untuk logika bisnis internal, property-based testing jauh lebih tepat sasaran.
- **Menjalankan `-fuzz` di CI biasa.** Fuzzing berjalan tanpa batas waktu alami. Yang benar: CI memutar ulang **corpus tersimpan** sebagai uji biasa (`go test` tanpa `-fuzz`), sementara sesi fuzzing panjang dijadwalkan terpisah (nightly).
- **Fuzz target yang memeriksa keluaran persis.** Fuzzer menghasilkan input yang tidak Anda bayangkan; yang bisa diperiksa hanyalah invarian — tidak panic, round-trip konsisten, ukuran keluaran masuk akal.
- **Tanpa batas ukuran input.** Fuzzer pasti menemukan input raksasa dan mematikan proses dengan OOM, lalu melaporkannya sebagai temuan — padahal yang ditemukan adalah ketiadaan batas Anda sendiri.
- **Tidak meng-commit corpus temuan.** Bila `testdata/fuzz/` tidak masuk repo, regresi yang persis sama akan ditemukan ulang berbulan-bulan kemudian, dan waktu triase-nya dibayar dua kali.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Panic di parser dari input pengguna | apakah jalur itu di-fuzz | Ada bentuk input yang belum pernah dicoba |
| Fuzzer selalu menemukan OOM | batas ukuran di fuzz target | Belum ada penjagaan ukuran input |
| Temuan hilang setelah pindah mesin | isi `testdata/fuzz/` | Corpus tidak di-commit |
| Fuzzing berjam-jam tanpa temuan | seed corpus | Seed terlalu sempit; fuzzer tidak punya titik awal yang beragam |
| CI kadang berjalan berjam-jam | apakah `-fuzz` ada di CI | Fuzzing tak berbatas bocor ke pipeline biasa |

```bash
# Eksplorasi lokal dengan batas waktu yang tegas
go test -fuzz=FuzzParse -fuzztime=60s ./...

# Inilah yang dijalankan CI: memutar ulang corpus, tanpa mesin fuzzer
go test ./...

# Temuan WAJIB masuk repo, kalau tidak akan ditemukan ulang nanti
ls testdata/fuzz/FuzzParse/
git add testdata/fuzz/

# Reproduksi satu temuan tertentu
go test -run='FuzzParse/582528ddfad69eb5' ./...

# Perkecil input pemicu agar mudah dianalisis
go test -fuzz=FuzzParse -fuzzminimizetime=30s ./...
```
