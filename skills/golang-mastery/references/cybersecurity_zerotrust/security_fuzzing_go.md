# Fuzzing Keamanan di Go (Native 1.18+)

## 1. Konsep Utama & Internals

Fuzzing adalah teknik *automated security testing* yang terus-menerus memborbardir fungsi target dengan data acak untuk menemukan *panics*, *memory corruption*, *hangs*, dan *logical vulnerabilities*.

Sejak Go 1.18, fuzzing adalah *first-class citizen* di toolchain. Go fuzzer menggunakan **coverage-guided mutation** — bukan random, melainkan cerdas:

```
Go Native Fuzzer Internals:

  ┌──────────────────────────────────────────────────────┐
  │  Fuzzer Corpus Management                            │
  │                                                      │
  │  Seed Corpus          Generated Corpus               │
  │  (f.Add() inputs)     (testdata/fuzz/<FuzzFn>/)      │
  │       │                      ▲                       │
  │       ▼                      │ save if new coverage  │
  │  ┌─────────────────┐         │                       │
  │  │  Mutator Engine │─────────┘                       │
  │  │  - bit flip     │                                 │
  │  │  - byte insert  │                                 │
  │  │  - splice 2     │                                 │
  │  │    inputs       │                                 │
  │  └────────┬────────┘                                 │
  │           │ mutated input                            │
  │           ▼                                          │
  │  ┌────────────────┐    ┌──────────────────────┐      │
  │  │  Fuzz Target   │───►│ Coverage Tracker     │      │
  │  │  (your func)   │    │ (instrumented code)  │      │
  │  └────────────────┘    │ - branch edges hit?  │      │
  │       │ panic/hang      │ - new path found?    │      │
  │       ▼                └──────────────────────┘      │
  │  Save to corpus                                      │
  │  (permanent regression test!)                        │
  └──────────────────────────────────────────────────────┘

Key difference from random fuzzing:
  Random: tries [0xFF,0x00,...] regardless of result
  Coverage-guided: if changing byte[2] opens new `if` branch
                   → explore mutations of that input deeply

Corpus persistence:
  Crash found → saved to testdata/fuzz/FuzzFn/<hash>
  Next `go test` → replay crash as regression test automatically
  `go test -run=FuzzFn/testdata/fuzz/...` → manual replay
```

## 2. Diagram Arsitektur / Aliran (ASCII)
```text
  [Seed Corpus (Valid Inputs)] ----+
                                   |
                                   v
                      +--------------------------+
                      |      Mutator Engine      | <---+
                      +--------------------------+     |
                                   |                   | (Feedback: Cabang IF/ELSE baru tersentuh?)
                                   v                   |
                      +--------------------------+     |
                      | Fuzz Target (f.Fuzz)     | ----+
                      | - ParseJSON(input)       |
                      +--------------------------+
                                   |
                +------------------+------------------+
                |                                     |
              (Crash / Panic / Hang)               (Success)
                |                                     |
                v                               (Lanjut Mutasi)
        [Simpan ke testdata/fuzz]
        (Otomatis menjadi Unit Test permanen!)
```

## 3. Production-Ready Go Code

Contoh fuzzer keamanan untuk men-tes kerentanan parser jaringan kustom.

```go
package securityfuzz

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// DecodeNetworkPacket adalah parser payload biner dari IoT/Network.
// Rentan terhadap bugs karena menggunakan aritmatika panjang bit.
func DecodeNetworkPacket(payload []byte) (string, error) {
	if len(payload) < 4 {
		return "", errors.New("packet too small")
	}

	// 2 byte pertama: Header marker
	if payload[0] != 0xAA || payload[1] != 0xBB {
		return "", errors.New("invalid header")
	}

	// 2 byte berikutnya: Payload Length
	length := binary.BigEndian.Uint16(payload[2:4])

	// BUGS (Simulasi Kerentanan):
	// Jika length diklaim 50000, tapi array payload hanya berukuran 10,
	// payload[4 : 4+length] akan PANIC (Index out of bounds)!
	
	// Defensive (Perbaikan sesungguhnya):
	if int(length)+4 > len(payload) {
		return "", errors.New("length spoofing detected")
	}

	data := payload[4 : 4+length]
	
	// Simulasi pemrosesan (jika data berisi sequence crash)
	if bytes.Contains(data, []byte("BOOM")) {
		// Logika kompleks aplikasi yang mungkin gagal
		return "", errors.New("boom sequence hit")
	}

	return string(data), nil
}

// FuzzDecodeNetworkPacket mengimplementasikan standar Go 1.18 Fuzzing
func FuzzDecodeNetworkPacket(f *testing.F) {
	// 1. Masukkan Seed Corpus (Input yang valid dan merepresentasikan base case)
	// Seed 1: Valid "OK" packet
	seed1 := []byte{0xAA, 0xBB, 0x00, 0x02, 'O', 'K'}
	f.Add(seed1)

	// Seed 2: Empty data
	seed2 := []byte{0xAA, 0xBB, 0x00, 0x00}
	f.Add(seed2)

	// 2. Target Fuzzing
	f.Fuzz(func(t *testing.T, payload []byte) {
		// Fuzzer akan menyuntikkan ribuan variasi acak ke 'payload' per detik
		
		result, err := DecodeNetworkPacket(payload)
		
		// Tujuan fuzzing BUKANLAH memeriksa apakah err == nil.
		// Tujuan utamanya adalah memastikan fungsi TIDAK PANIC, DEADLOCK, atau OOM!
		
		if err == nil {
			// Invarian: Output tidak boleh lebih panjang dari raw input
			if len(result) > len(payload) {
				t.Errorf("Security Flaw: output length %d > input length %d", len(result), len(payload))
			}
		}
	})
}

// TestDecodeNetworkPacket_KnownCases menguji kasus-kasus konkret yang HARUS selalu benar.
// File di testdata/fuzz/ yang ditemukan fuzzer otomatis menjadi test cases di sini.
func TestDecodeNetworkPacket_KnownCases(t *testing.T) {
	tests := []struct {
		name    string
		input   []byte
		wantErr bool
	}{
		{"valid packet", []byte{0xAA, 0xBB, 0x00, 0x02, 'O', 'K'}, false},
		{"too short", []byte{0xAA, 0xBB}, true},
		{"invalid header", []byte{0x00, 0x00, 0x00, 0x02, 'O', 'K'}, true},
		{"length spoofing: claimed 1000 but only 4 bytes", []byte{0xAA, 0xBB, 0x03, 0xE8}, true},
		{"empty payload", []byte{0xAA, 0xBB, 0x00, 0x00}, false},
		{"boom sequence", []byte{0xAA, 0xBB, 0x00, 0x04, 'B', 'O', 'O', 'M'}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DecodeNetworkPacket(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("DecodeNetworkPacket() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// TestDecodeNetworkPacket_PropertyOutputLength memverifikasi property penting:
// output string TIDAK PERNAH lebih panjang dari input bytes (no information expansion).
func TestDecodeNetworkPacket_PropertyOutputLength(t *testing.T) {
	// Simulate beberapa valid inputs dengan berbagai panjang payload
	for payloadLen := 0; payloadLen <= 20; payloadLen++ {
		input := make([]byte, 4+payloadLen)
		input[0] = 0xAA
		input[1] = 0xBB
		input[2] = byte(payloadLen >> 8)
		input[3] = byte(payloadLen)
		// Fill payload dengan 'A'
		for i := 0; i < payloadLen; i++ {
			input[4+i] = 'A'
		}
		
		result, err := DecodeNetworkPacket(input)
		if err == nil && len(result) > len(input) {
			t.Errorf("payloadLen=%d: output %d > input %d (invariant violated)", payloadLen, len(result), len(input))
		}
	}
}
```

*Cara menjalankan: `go test -fuzz=FuzzDecodeNetworkPacket -fuzztime=30s`*

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Fuzzing Layaknya Unit Test
Banyak programmer keliru mencoba mencocokkan hasil string pasti di dalam blok `f.Fuzz()`.
```go
// ❌ BAD: Mencoba memvalidasi nilai spesifik dari input yang tak terduga (Chaos)
f.Fuzz(func(t *testing.T, input string) {
    res, err := ReverseString(input)
    if res != "olleh" { // Mustahil! Input sedang diacak!
        t.Errorf("Failed")
    }
})
```
**Why dangerous:** Ini merusak fuzzer. Fuzzer menghasilkan jutaan input "*garbage*". Memvalidasinya terhadap nilai statis akan memastikan *Fuzz Test* tersebut GAGAL 100% pada milidetik pertama, menutupi *bug crash/panic* yang sebenarnya ada.

```go
// ✅ GOOD: Uji invarians (Kebenaran Universal) atau round-trip
f.Fuzz(func(t *testing.T, input string) {
    res, _ := ReverseString(input)
    res2, _ := ReverseString(res) // Double reverse (Round-Trip)
    
    // Invarians: String yang dibalik 2x harus sama dengan aslinya!
    if input != res2 {
        t.Errorf("Roundtrip flaw: %s != %s", input, res2)
    }
})
```

### ❌ Anti-Pattern 2: Tidak Memberikan Seed Corpus Sama Sekali
Mengosongkan `f.Add()` dan mengharap *Fuzzer* akan ajaib menemukan *bug* pada protokol jaringan Anda yang tebal dan ketat.

```go
// ❌ BAD: Tidak ada seed. 
func FuzzMyProtocol(f *testing.F) {
    f.Fuzz(func(t *testing.T, data []byte) { ... })
}
```
**Why dangerous:** Jika paket Anda memiliki validasi *header/magic-bytes* yang kompleks (seperti CRC32 atau `0xAA 0xBB`), fuzzer yang memulai dari murni "nol" akan menghabiskan waktu berminggu-minggu *CPU cycles* hanya untuk menebak urutan 2 byte pembuka. Evaluasi akan selalu mental di pengecekan `if len<4` atau `if header != 0xAA`, dan *coverage* bagian dalam protokol tak akan pernah tersentuh.

```go
// ✅ GOOD: Daftarkan (Add) beberapa rekaman valid / happy path
f.Add([]byte{0xAA, 0xBB, 0x00, 0x04, 'T','E','S','T'})
// Fuzzer akan menggunakan array di atas dan secara pintar HANYA memutasi bagian
// payload ('T','E','S','T') atau memalsukan panjang byte.
```

## 5. Edge Cases & Defensive Programming

1. **Denial of Service via RAM Exhaustion (OOM)**: Jika parser membaca `length = 0xFFFFFFFF` dari input dan mengalokasikan `make([]byte, 4294967295)`, proses Go langsung OOM Killed. *Defensive:* Terapkan hard limit alokasi: `if length > MaxPacketSize { return error }`. Fuzzing memaksa Anda mempertimbangkan semua nilai ekstrim dari field numerik.
2. **Infinite Loops / Hangs**: Input tertentu dengan byte berulang bisa membuat state-machine atau regex berputar selamanya. Go fuzzer mendeteksi hang dan report. *Defensive:* Pasang batas iterasi maksimum dan/atau `context.WithTimeout` pada operasi parsing yang bisa lama.
3. **Dirty File System / Side Effects**: `f.Fuzz()` dipanggil ratusan ribu kali per detik secara paralel. Jika ada `os.WriteFile` atau `db.Exec` di dalamnya, disk/DB akan hancur. *Defensive:* Fuzz target HARUS pure function — hanya memori CPU, tanpa I/O, tanpa state global, tanpa DB calls.
4. **Unicode dan Encoding Boundaries**: Fuzzer sering menghasilkan input dengan byte yang tampak valid tapi bukan UTF-8 valid. Jika `string(payload)` di-convert tanpa validasi, karakter replacement (`�`) bisa masuk ke downstream storage dan merusak data. *Defensive:* Gunakan `utf8.ValidString(s)` atau `utf8.Valid(b)` sebelum konversi string jika sistem downstream sensitif terhadap encoding.
5. **Integer Overflow di Length Calculation:** `uint16(0xFF) + 4 = 259` tapi jika dihitung sebagai `int8`, hasilnya overflow ke nilai negatif. Go tidak memiliki implicit integer overflow untuk slice index, tapi arithmetic murni bisa overflow. *Defensive:* Saat mengkalkulasi `length + headerSize`, lakukan dalam tipe integer yang lebih besar (int64) dan validasi hasil akhir sebelum cast ke ukuran lebih kecil.
