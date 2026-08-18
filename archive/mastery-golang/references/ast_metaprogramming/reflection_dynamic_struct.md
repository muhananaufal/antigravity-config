# Metaprogramming Runtime: Dynamic Struct & Reflection di Go

> **Berlaku:** Go 1.21+ · `reflect` · **Lihat juga:** `runtime_internals/reflection_unsafe_pointer.md` · `ast_metaprogramming/code_generation_template.md` · `runtime_internals/go_generics_type_parameters.md` · `runtime_internals/escape_analysis_pprof.md`

## Konsep Utama dan Internal

Golang dikompilasi secara *statis* dengan struktur data bertipe mutlak (*Strongly and Statically Typed*). Compiler me-resolve alokasi layout struct di memori sejak proses build, sehingga ukuran byte presisi dan akses alamat pointer sangat cepat di runtime OS.

Namun, framework metaprogramming canggih (contoh: *Database ORM mapper, GraphQL engines, JSON Schema validator ad-hoc, API Data Proxy*) membutuhkan penempatan memori (memory layout) yang bentuk skemanya **tidak diketahui** ketika kompilator dijalankan (e.g., membuat tabel baru hasil kalkulasi `SQL JOIN` secara dinamis dari database).

Paket ajaib `reflect` merobek batas statis tersebut. Dengan dukungan VM runtime allocator `reflect.StructOf`, Go memungkinkan developer **mencetak/menyintesis struct layout baru persis ketika aplikasi sedang berjalan (*Runtime*)**, serta menggunakan `reflect.New()` guna mengalokasikan RAM Heap instansiasinya.

## Diagram Arsitektur Memory Allocator (ASCII)

Diagram berikut memetakan bagaimana referensi dictionary mentah dipompakan ke runtime Go guna melahirkan struktur memori baru beserta binding data value-nya secara dinamis (*Dynamic Struct Factory*).

```text
 +---------------------------------------------------------+
 |  [ Raw Schema ] (e.g. Kolom Table SQL / JSON Key)       |
 |  -> {"id": string, "balance": int64, "active": bool}    |
 +---------------------------------------------------------+
                              |
                              v
 [ Go Type Parser & Slice reflect.StructField Assembler ]
                              |
                              | (Menyusun definisi tag dan memory offset metadata)
                              v
           +----------------------------------------+
           | reflect.StructOf([]reflect.StructField)| ---> (Menghasilkan Virtual *reflect.rtype*)
           +----------------------------------------+
                              |
                              | (Minta OS/Runtime alokasikan Memory pointer (Heap) untuk Type ini)
                              v
               +-----------------------------+
               |     reflect.New(dynType)    | ---> Pointer Value Instance terbentuk
               +-----------------------------+
                              |
                              | (Dereference: `ptr.Elem()` dan Injeksi Nilai)
                              v
       +---------------------------------------------+
       | reflect.Value.FieldByName("Id").SetString() |
       +---------------------------------------------+
```

## Kode Go Production-Ready

Kode di bawah mensimulasikan sintesis tipe struct secara programatik pada fase *runtime*, menyematkan _Struct Tags_ khusus, dan mengamankan injeksi set data dengan tipe silang yang defensif.

```go
package dynamicstruct

import (
	"fmt"
	"reflect"
	"testing"
	"unicode"
	"unicode/utf8"
)

// ==========================================
// 1. DYNAMIC STRUCT FACTORY ENGINE
// ==========================================

// DynamicRecord menampung metadata Type beserta state Heap pointer Value-nya
// agar dapat diekstrak atau di-query lebih lanjut oleh pihak pemanggil.
type DynamicRecord struct {
	Type  reflect.Type
	Value reflect.Value
}

// BuildStruct menghasilkan Layout Memori Struct kustom di *Runtime*, 
// serta menjejalinya dengan data dari payload (Map Interface).
func BuildStruct(fieldsDef map[string]reflect.Type, payload map[string]interface{}) (*DynamicRecord, error) {
	// 1. Kumpulkan array Definisi Alokasi Memory Field
	var structFields []reflect.StructField
	for name, typ := range fieldsDef {
		// PERTAHANAN KRUSIAL: Field dalam struct Go HARUS diexport (Diawali Huruf Kapital).
		// Jika tidak kapital, ia menolak untuk di Assign nilai (.Set) dari layer reflection (akan memicu Panic OS).
		firstRune, size := utf8.DecodeRuneInString(name)
		if size == 0 {
			continue
		}
		capitalizedName := string(unicode.ToUpper(firstRune)) + name[size:]

		structFields = append(structFields, reflect.StructField{
			Name: capitalizedName, // E.g., "id" -> "Id", "balance" -> "Balance"
			Type: typ,
			// Menambah custom tag otomatis, cocok untuk encoding/json formatter turunannya
			Tag:  reflect.StructTag(fmt.Sprintf(`json:"%s" db:"%s"`, name, name)),
		})
	}

	// 2. Alokasi Struct Type Blueprint secara dinamis ke Go runtime.
	// Jika terjadi mal-definisi struktur hirarki / recursive loop fatal, ini akan panic murni.
	dynType := reflect.StructOf(structFields)

	// 3. Mengalokasikan instance memori di Heap (equivalent: `new(DynType)`)
	dynPtr := reflect.New(dynType)
	
	// Dereference pointer dari address ke nilainya untuk mulai memanipulasi slot isinya
	dynVal := dynPtr.Elem()

	// 4. Injeksi & Assignment Data (Setter)
	for rawKey, rawValue := range payload {
		// Lakukan perlakuan kapital yang sama ke payload lookup
		r, s := utf8.DecodeRuneInString(rawKey)
		capKey := string(unicode.ToUpper(r)) + rawKey[s:]
		
		fieldVal := dynVal.FieldByName(capKey)
		
		// Validasi absolut perlindungan akses Write Memory address pointer
		if fieldVal.IsValid() && fieldVal.CanSet() {
			valToSet := reflect.ValueOf(rawValue)
			
			// Validasi safety assign: Memastikan pointer memory type sama agar terhindar dari segfault
			if valToSet.IsValid() && valToSet.Type().AssignableTo(fieldVal.Type()) {
				fieldVal.Set(valToSet)
			}
		}
	}

	return &DynamicRecord{
		Type:  dynType,
		Value: dynVal,
	}, nil
}

// ==========================================
// 2. UNIT TEST (Proof of Concept)
// ==========================================

func TestBuildDynamicStruct_Validation(t *testing.T) {
	// (A) Skema yang belum pernah dikompilasi Go compiler sebelumnya
	schemaDefinition := map[string]reflect.Type{
		"userId":  reflect.TypeOf(""),     // Expected Type String
		"balance": reflect.TypeOf(int64(0)), // Expected Type Int64
		"active":  reflect.TypeOf(true),   // Expected Type Boolean
	}

	// (B) Data Payload dari jaringan (e.g. JSON/SQL Query Result mentah)
	dataPayload := map[string]interface{}{
		"userId":  "usr_99X",
		"balance": int64(88500),
		"active":  true,
		"hacker":  "drop table", // Field liar yang diabaikan (karena tak ada di Skema Memory Alloc)
	}

	// (C) Eksekusi Mesin Factory Reflection 
	record, err := BuildStruct(schemaDefinition, dataPayload)
	if err != nil {
		t.Fatalf("Build process fatally failed: %v", err)
	}

	// Membuktikan Object adalah Struct Tulen (Bukan Map)
	if record.Type.Kind() != reflect.Struct {
		t.Errorf("Expected allocation Kind to be a Struct, got %v", record.Type.Kind())
	}

	// (D) Menelusuri hasil Assigment memori dengan aman (Query Assertions)
	
	idField := record.Value.FieldByName("UserId")
	if idField.String() != "usr_99X" {
		t.Errorf("Expected UserId 'usr_99X', got %s", idField.String())
	}

	balanceField := record.Value.FieldByName("Balance")
	if balanceField.Int() != 88500 {
		t.Errorf("Expected Balance 88500, got %d", balanceField.Int())
	}

	activeField := record.Value.FieldByName("Active")
	if !activeField.Bool() {
		t.Errorf("Expected Active True")
	}
	
	// Pastikan field Hacker tidak dibuat karena di-reject skema
	if record.Value.FieldByName("Hacker").IsValid() {
		t.Errorf("Payload pollution occurred, non-schema field bypassed filter")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Memaksakan Instansiasi Struct Dinamis di Loop Ketat (Hot Paths)
Banyak engineer menempelkan mesin *factory* reflection seperti `reflect.StructOf` ini tepat di gerbang persimpangan middleware JSON Decode atau DB mapper yang berjalan per satu iterasi kueri untuk ratusan ribu request/sec.

```go
// ❌ BAD: Memory bloat JIT compilation per row database.
func MapDynamicResult(rows []Data) []interface{} {
    var result []interface{}
    for _, row := range rows {
        // FATAL: Mengkompilasi AST tipe runtime baru untuk SETIAP baris!
        dynType := reflect.StructOf(fields) 
        ptr := reflect.New(dynType)
        result = append(result, ptr.Interface())
    }
    return result
}
```
**Why dangerous:** Operasi pembuatan `Type` Go di fase runtime (pembangunan meta memori pointer, struct alignment calculation) sangat lamban secara arsitektur (menelan CPU yang besar) dan meninggalkan sampah Garbage Collector (GC) raksasa. Menjalankannya di loop miliaran kali merusak kestabilan latensi backend parah.
**Solusi (Benar):** Lakukan **Type Caching**. Generate/kompilasi struktur tabel dinamis `reflect.Type` **HANYA SEKALI** di fase *startup*, atau letakkan di dalam koleksi `sync.Map` hash. Kemudian, pada `for loop` database-nya, Anda cukup memanggil pendealokasian heap `reflect.New(cachedDynType)` menggunakan *Type Cache* yang telah dimasak sebelumnya.

### ❌ Anti-Pattern 2: Menaruh Field Struct Berkategori "Huruf Kecil" (Unexported Fields)
Kesan dinamis JSON yang mayoritas berhuruf kecil seringkali diteruskan persis (hard-pass) begitu saja ke mesin memory generator.

```go
// ❌ BAD: Menciptakan tipe dengan field memori tidak diexport
fields := []reflect.StructField{ {Name: "user_id", Type: typ} }
dynType := reflect.StructOf(fields) 

// Nanti saat mengisi datanya..
ptr.Elem().FieldByName("user_id").SetString("123") // PANIC KERNEL: "cannot set unexported field"
```
**Why dangerous:** Ini jebakan mematikan golang. *Struct pointer memory layout* tetap mengalokasikan byte yang diminta, namun *Go runtime layer* akan **melempar panic paksa** saat instruksi `.Set()` dicoba karena field-field tersebut secara teknis *private* dalam scope package `reflect` (hanya var kapital yang public-writeable di runtime reflection).
**Solusi (Benar):** (Lihat contoh Production-ready) Terapkan filter _Sanitizer/Capitalize_ untuk menyulap `user_id` menjadi `User_id` di field `.Name`, lalu pertahankan label string asli `user_id` di dalam field deklarasi anotasi `.Tag` (contoh: `json:"user_id"`), sehingga library luar (JSON Encoder) tetap mengeluarkannya berhuruf kecil saat render data.

## Edge Cases & Defensive Programming Konkrit

1. **Panic Tipe Inferensi Nilai Nil (Dereference Type Collision):**
   Jika skema API mensyaratkan ekspektasi bahwa field X adalah `string`, lalu payload eksternal mengirim `nil` (null di JSON) atau *Object Array Kosong*, saat Anda melempar parameter tersebut ke parameter penampung interface `reflect.ValueOf(nil)`, obyek reflect tersebut menjadi Invalid/Kosong (`val.IsValid() == false`).
   *Defensive:* Secara absolut lindungi rantai _Assignment (`fieldVal.Set(valToSet)`)_ dengan tiga benteng pelindung urut: (1) `valToSet.IsValid()`, lalu (2) `.Type().AssignableTo(fieldVal.Type())`. Jika Anda butuh menerima *null* (Nulls), tipe pada array schema `StructField` harus didefinisikan secara khusus sebagai Pointer `reflect.PtrTo(reflect.TypeOf(""))`, bukan *Value string murni*.

2. **Pointer Aliasing & Memory Data Corruption:**
   Saat memanggil `reflect.ValueOf(v)`, di mana `v` ternyata adalah struct majemuk slice `[]int` atau map, reflection assignment tidak membuat duplikasi memori mendalam (Deep Copy), melainkan _menyalin pointer referensi_ *(Shallow Copy)*. Ini artinya state dynamic record pointer Anda terkait permanen dengan memori eksternal asli.
   *Defensive:* Modifikasi slice dari dynamic object akan memodifikasi slice payload. Jika obyek itu harus bersih, jangan sembarang me-assign nilai slice. Pastikan melakukan manual instance array baru dan _loop copy_ atau _Json Marshal/Unmarshal_ dalam blok aman.

3. **Collision / Duplikasi Identifikasi Field Struct:**
   Sebuah JSON kacau memuat format field `{"ID": 12, "iD": 30}`. Setelah program generator kita menerapkan *Capitalize* ke kunci di atas, JSON tersebut beralih menjadi 2 buah struktur nama identik `[]reflect.StructField{ {Name: "ID"}, {Name: "ID"} }`.
   *Defensive:* `reflect.StructOf` akan **Panic Mutlak** bila menelan array tipe duplikat *Name*. Sangat direkomendasikan membersihkan data metadata definisi via deduplikasi menggunakan map validasi `seenFields := make(map[string]bool)` tepat sebelum array dimasukkan ke pendelegasi instruksi StructOf.

## Kapan JANGAN Pakai Ini

- **Di jalur panas.** Setiap operasi refleksi mengalokasikan dan tidak bisa di-inline. Untuk serialisasi berkecepatan tinggi, kode yang di-generate mengalahkan refleksi telak dan tidak punya kejutan.
- **Ketika generik sudah cukup.** Sejak Go 1.18, banyak pemakaian refleksi bisa diganti parameter tipe — dengan keamanan tipe saat kompilasi dan tanpa ongkos runtime.
- **Untuk mengakses field tidak terekspor pustaka pihak ketiga.** Tata letak struct bukan bagian dari kontrak API dan bisa berubah di rilis tambalan. Kode Anda akan rusak tanpa satu pun peringatan kompilator.
- **Tanpa menangani `panic` dari operasi refleksi.** Refleksi memindahkan kesalahan tipe dari waktu kompilasi ke waktu jalan. Setiap `Field`, `Call`, dan `Set` yang salah adalah panic di produksi.
- **Membangun struct dinamis untuk masalah yang sebenarnya adalah `map`.** Bila field tidak diketahui saat kompilasi dan tidak ada perilaku yang melekat padanya, `map[string]any` lebih sederhana dan jujur.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Profil CPU didominasi `reflect.*` | jalur yang memakai refleksi | Refleksi di hot path |
| Alokasi tinggi pada serialisasi | profil alokasi | Setiap operasi refleksi mengalokasikan |
| Panic setelah upgrade dependensi | akses field tidak terekspor | Tata letak struct berubah |
| Galat tipe muncul di produksi | validasi sebelum operasi refleksi | Kesalahan tipe berpindah ke runtime |
| Kode sulit dipahami tanpa menjalankannya | apakah generik bisa dipakai | Refleksi untuk masalah yang punya solusi statis |

```bash
go tool pprof -top 'http://localhost:6060/debug/pprof/profile?seconds=30' | grep -i reflect
go tool pprof -sample_index=alloc_objects -top 'http://localhost:6060/debug/pprof/allocs?seconds=30' | grep -i reflect

go test -bench=. -benchmem -run='^$' ./...

# Panic dari refleksi di produksi
kubectl logs -l app=api --previous | grep -A10 'reflect:' | head -20
```
