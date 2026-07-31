# AI Data Infrastructure: Text Embedding Pipeline via ONNX di Go

## 1. Konsep Utama & Infrastruktur Internal (Technical Depth)

Meskipun Python adalah *lingua franca* untuk melatih (training) model *Machine Learning*, eksekusi model (inference) dalam arsitektur berskala besar memunculkan masalah bottleneck akibat *Global Interpreter Lock (GIL)* dan tingginya konsumsi memori Python. Oleh karena itu, arsitektur *AI Infrastructure* tingkat lanjut (seperti yang dilakukan oleh perusahaan *search engine* dan sistem rekomendasi) sering memigrasikan *inference pipeline* mereka menggunakan Go.

Strategi utamanya adalah **Text Embedding via ONNX Runtime**. ONNX (Open Neural Network Exchange) memungkinkan model-model yang tadinya dilatih menggunakan PyTorch (misalnya arsitektur Transformer seperti `all-MiniLM-L6-v2` atau `bge-large`) di-*export* ke format *graph* komputasi statis yang independen terhadap bahasa pemrograman.

Pipeline di Go berjalan melalui tiga fase intensif (CGO bound):
1.  **Tokenization (BPE/WordPiece)**: Input berupa `string` di dalam Go tidak dikenali oleh model Transformer. Sistem Go harus menggunakan mesin Tokenizer untuk mengubah string ini ke dalam array ID kamus (integer statis) yang disebut `input_ids`. Proses tokenization ini juga menghasilkan `attention_mask` (array binary 0 dan 1 yang memberi tahu model mana token asli dan mana yang sekadar *padding*).
2.  **Tensor Mapping & Execution (ONNX C-API)**: Array token dari ruang memori Go tidak dapat langsung dibaca oleh ONNX. Data disalin (atau di-*pin* jika didukung CGO mem-sharing) ke dalam C-Tensor yang *memory-aligned*. Go kemudian memanggil eksekusi inferensi (Graph Evaluation). Pada titik ini, *Matrix Multiplication* (MatMul) raksasa dieksekusi murni di C++ land memanfaatkan AVX512, CUDA (GPU), atau CoreML.
3.  **Mean Pooling & L2 Normalization**: Output dari model Transformer biasanya berbentuk *3D Tensor* (misal: Batch = 32, SequenceLength = 128, Hidden Dimension = 384). Untuk memasukkannya ke database *Vector* seperti `pgvector` atau `Qdrant`, kita butuh *1D flat vector* untuk tiap dokumen. Teknik *Mean Pooling* merata-ratakan 128 dimensi *sequence length* tersebut menjadi satu kesatuan dengan memperhatikan `attention_mask`. Selanjutnya, vektor akhir **wajib** dikalibrasi panjangnya menjadi persis 1.0 (L2 Normalization) agar perhitungan komputasi metrik *Cosine Similarity* di tingkat database berjalan sangat cepat (direduksi sekadar operasi perkalian dot product internal database).

---

## 2. Diagram ASCII Arsitektur Pipeline

Alur ini menunjukkan pergerakan data dari request user, dikonversi menjadi memori kontinu CGO, melewati matriks C++ ONNX, dan keluar menjadi *Normalized Floating Vector*.

```text
=============================================================================================
                          GO RUNTIME (Web API / gRPC Worker Pool)
=============================================================================================
         [Incoming String Slice] -> e.g. Batch of 32 Product Descriptions
                   |
                   v
+-----------------------------------------------------------------------------------------+
|                                    BPE TOKENIZER (Go)                                   |
| - Memotong string "Kucing lucu" -> [3021, 5920]                                         |
| - Padding batch terkecil ke max sequence length dari kalimat terpanjang (Smart Padding) |
+-----------------------------------------------------------------------------------------+
                   | 
                   | (Menghasilkan Go Slice: []int64 `input_ids`, []int64 `attention_mask`)
                   v
=============================================================================================
                               CGO BOUNDARY (Unsafe Pointer)
=============================================================================================
                   | (Salin Slice Go ke Memory Aligned C-Malloc)
                   v
+-----------------------------------------------------------------------------------------+
|                                ONNX RUNTIME C++ ENGINE                                  |
| [ Tensor Node: input_ids ]    [ Tensor Node: attention_mask ]                           |
|              \                               /                                          |
|               \                             /                                           |
|       +-------------------------------------------------------------+                   |
|       |     TRANSFORMER MODEL (Graph Execution / MatMul / AVX2)     |                   |
|       +-------------------------------------------------------------+                   |
|                                |                                                        |
|         [ Output Node: last_hidden_state (32 x 128 x 384 float32) ]                     |
+-----------------------------------------------------------------------------------------+
                   |
                   | (Extract Raw Float Array kembali ke []float32 Go Space)
                   v
=============================================================================================
                                GO SIMD / CPU POST-PROCESSING
=============================================================================================
+-----------------------------------------------------------------------------------------+
| 1. Mean Pooling (Abaikan padding mask == 0 saat menghitung rata-rata array)             |
| 2. L2 Normalization (Membagi semua komponen dimensi vektor dengan panjang absolutnya)   |
+-----------------------------------------------------------------------------------------+
                   |
                   v
   [ 32x384 Normalized float32 Vectors (Siap di-Upsert ke pgvector/Qdrant) ]
```

---

## 3. Production-Ready Go Code

Dalam *production code* di bawah ini, kita mensimulasikan struktur arsitektur yang aman: bagaimana model diposisikan di dalam memori, bagaimana *context* propagasi diterapkan pada operasi *batch*, serta bagaimana alokasi *slice* disiapkan dengan cermat untuk menghindari *garbage collection thrashing*. *Note: Kita memakai implementasi representatif karena CGO murni sangat panjang.*

```go
package embedding_infra

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// PipelineConfig menampung parameter fundamental untuk AI Inference.
type PipelineConfig struct {
	ModelPath    string
	HiddenDim    int // Contoh: 384 untuk MiniLM, 768 untuk BERT
	MaxSeqLength int // Batas maksimal token per kalimat (contoh: 128, 512)
}

// ModelEngine membungkus C-Pointer milik eksekutor ONNX dan status inisialisasi.
type ModelEngine struct {
	config PipelineConfig
	mu     sync.RWMutex
	
	// Di dunia nyata:
	// onnxSession  *onnxruntime.Session
	// tokenizer    *bpe.Tokenizer
	isReady bool
}

// NewModelEngine menginisialisasi memory-heavy assets ke RAM.
// Fungsi ini harus dipanggil HANYA SEKALI (Singleton) saat startup server.
func NewModelEngine(cfg PipelineConfig) (*ModelEngine, error) {
	if cfg.HiddenDim <= 0 {
		return nil, fmt.Errorf("hidden dimension must be positive")
	}

	// 1. (Simulasi) Load Tokenizer vocabulary file
	// 2. (Simulasi) Initialize ONNX Environment 
	// 3. (Simulasi) Load `.onnx` graph into memory, set IntraOpNumThreads

	return &ModelEngine{
		config:  cfg,
		isReady: true,
	}, nil
}

// GenerateEmbeddings menerima batch kalimat.
// Penting: Parameter Context harus pertama untuk merespon timeout HTTP/gRPC.
func (me *ModelEngine) GenerateEmbeddings(ctx context.Context, texts []string) ([][]float32, error) {
	me.mu.RLock()
	defer me.mu.RUnlock()

	if !me.isReady {
		return nil, fmt.Errorf("embedding: model engine is not ready")
	}

	batchSize := len(texts)
	if batchSize == 0 {
		return nil, nil // Tidak ada kerjaan, kembalikan kosong secara aman
	}

	// --- FASE 1: TOKENIZATION & PADDING ---
	
	// Dalam realita, panjang batch disesuaikan secara dinamis berdasar kalimat terpanjang 
	// (maksimal config.MaxSeqLength) untuk menghemat komputasi ONNX.
	seqLength := me.config.MaxSeqLength 
	
	// Pre-alokasi flat slice untuk dikirim ke C (menghindari GC memindahkan inner array pointer)
	// Ukuran: batchSize * sequenceLength
	inputIDsFlat := make([]int64, batchSize*seqLength)
	attentionMaskFlat := make([]int64, batchSize*seqLength)

	// Simulasi populasi tokenizer (Loop pengisian ke array 1 dimensi)
	for i := 0; i < batchSize; i++ {
		select {
		case <-ctx.Done():
			// Proteksi 1: Batalkan tokenisasi jika request timeout
			return nil, fmt.Errorf("embedding tokenization canceled: %w", ctx.Err())
		default:
		}
		
		for j := 0; j < seqLength; j++ {
			idx := i*seqLength + j
			inputIDsFlat[idx] = 100 // Dummy Token ID
			attentionMaskFlat[idx] = 1 // 1 berarti "bukan padding"
		}
	}

	// --- FASE 2: ONNX INFERENCE BOUNDARY ---
	
	// Simulasi: Mengirim inputIDsFlat ke C++ ONNX dan menerima raw tensor keluaran.
	// Waktu yang dihabiskan mayoritas berada di sini (blocking CGO call).
	// ... onnxSession.Run(...)
	
	// rawOutput mewakili tensor hasil: Shape [batchSize, seqLength, HiddenDim]
	// yang diflatkan menjadi array 1 dimensi agar efisien secara CPU cache.
	rawOutputLength := batchSize * seqLength * me.config.HiddenDim
	rawOutputFlat := make([]float32, rawOutputLength)
	
	// Mengisi data dummy layaknya output neural network
	for i := range rawOutputFlat {
		rawOutputFlat[i] = 0.5 
	}

	// --- FASE 3: MEAN POOLING & L2 NORMALIZATION ---
	
	// Membuat matriks output final (2D) siap lempar ke pgvector
	finalEmbeddings := make([][]float32, batchSize)
	
	for b := 0; b < batchSize; b++ {
		finalEmbeddings[b] = make([]float32, me.config.HiddenDim)
		
		// 1. Pooling: Menjumlahkan dimensi tersembunyi berdasar rentang token
		validTokens := 0
		for seq := 0; seq < seqLength; seq++ {
			maskVal := attentionMaskFlat[b*seqLength+seq]
			if maskVal == 0 {
				continue // Abaikan padding token
			}
			validTokens++
			
			// Tambahkan vektor token ke total kumpulan dimensi
			for d := 0; d < me.config.HiddenDim; d++ {
				// Menghitung indeks 3D pada flat array 1D
				flatIdx := (b * seqLength * me.config.HiddenDim) + (seq * me.config.HiddenDim) + d
				finalEmbeddings[b][d] += rawOutputFlat[flatIdx]
			}
		}
		
		// Bagi penjumlahan dengan total valid token (Rata-rata)
		if validTokens > 0 {
			for d := 0; d < me.config.HiddenDim; d++ {
				finalEmbeddings[b][d] /= float32(validTokens)
			}
		}

		// 2. Normalisasi L2 (Agar Cosine Similarity database = perkalian titik (Dot Product))
		var sumSquares float32
		for d := 0; d < me.config.HiddenDim; d++ {
			sumSquares += finalEmbeddings[b][d] * finalEmbeddings[b][d]
		}
		
		// Kalkulasi akar, lalu verifikasi non-Zero untuk menghindari NaN
		magnitude := float32(math.Sqrt(float64(sumSquares)))
		if magnitude > 1e-12 { // Epsilon guard
			for d := 0; d < me.config.HiddenDim; d++ {
				finalEmbeddings[b][d] /= magnitude
			}
		}
	}

	return finalEmbeddings, nil
}
```

### Unit Tests (Meaningful & Edge Cases Coverage)

```go
package embedding_infra

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestGenerateEmbeddings_HappyPath(t *testing.T) {
	cfg := PipelineConfig{
		ModelPath:    "/fake/path/model.onnx",
		HiddenDim:    384,
		MaxSeqLength: 64,
	}
	engine, err := NewModelEngine(cfg)
	if err != nil {
		t.Fatalf("Failed to init engine: %v", err)
	}

	ctx := context.Background()
	texts := []string{
		"Berapa harga mesin cuci ini?",
		"Rekomendasi laptop gaming terbaik 2026.",
	}

	embeddings, err := engine.GenerateEmbeddings(ctx, texts)
	if err != nil {
		t.Fatalf("Generation failed: %v", err)
	}

	// Validasi Output Bentuk Tensor
	if len(embeddings) != len(texts) {
		t.Errorf("Expected batch size %d, got %d", len(texts), len(embeddings))
	}
	if len(embeddings[0]) != cfg.HiddenDim {
		t.Errorf("Expected hidden dimension %d, got %d", cfg.HiddenDim, len(embeddings[0]))
	}

	// Validasi L2 Normalization (Panjang mutlak setiap vektor wajib == 1.0)
	for i, emb := range embeddings {
		var sum float64
		for _, val := range emb {
			sum += float64(val * val)
		}
		magnitude := math.Sqrt(sum)
		
		// Gunakan presisi floating epsilon (0.0001) untuk komparasi float
		if math.Abs(magnitude-1.0) > 1e-4 {
			t.Errorf("Embedding index %d is NOT normalized. Magnitude: %f", i, magnitude)
		}
	}
}

func TestGenerateEmbeddings_ContextCancellation(t *testing.T) {
	cfg := PipelineConfig{
		HiddenDim:    768,
		MaxSeqLength: 512,
	}
	engine, _ := NewModelEngine(cfg)

	// Ciptakan context yang SUDAH dibatalkan
	ctx, cancel := context.WithCancel(context.Background())
	cancel() 

	texts := []string{"Cek timeout propagasi pada iterasi loop"}
	
	// Seharusnya fungsi gagal di tokenization block awal
	embeddings, err := engine.GenerateEmbeddings(ctx, texts)
	if err == nil {
		t.Error("Expected an error due to context cancellation, got nil")
	}
	if embeddings != nil {
		t.Error("Expected nil embeddings, got slice")
	}
}
```

---

## 4. Anti-Patterns AI Inference di Go

### ❌ Anti-Pattern 1: Eksekusi Serial dalam Loop Iteratif per Dokumen
Sangat sering *Backend Engineer* membuat abstraksi API generik di Go yang menerima `1 string` menjadi `1 vector`, kemudian mengeksekusi pipeline di atas array dokumen menggunakan perulangan *for*.

```go
// ❌ BAD: Eksekusi beruntun 1 per 1 (Tanpa Batching)
func IngestProducts(ctx context.Context, products []Product, engine *ModelEngine) error {
    for _, prod := range products {
        // Melakukan Panggilan ONNX ke C++ 1000 kali. Overhead switching CGO akan 
        // membakar CPU. Hardware SIMD/GPU juga menganggur (under-utilized) karena 
        // perkalian matriks berjalan dalam shape (1 x N).
        emb, _ := engine.GenerateEmbeddings(ctx, []string{prod.Description})
        saveToDB(emb[0]) 
    }
}
```
**Mengapa berbahaya:** Pemanggilan jembatan Go-to-CGO memerlukan penyusunan argumen khusus dan *stack setup* oleh *runtime* yang mahal secara *clock-cycle*. Menjalankan inferensi model dengan *batch size* = 1 membuang kapasitas matriks paralel prosesor. Akibatnya, *throughput* layanan jatuh drastis (contoh: dari kemampuan 500 kalimat per detik jatuh menjadi 30 kalimat per detik) dan memicu penumpukan antrean koneksi web.

```go
// ✅ GOOD: Menerapkan Smart Batching Strategy
func IngestProducts(ctx context.Context, products []Product, engine *ModelEngine) error {
    batchSize := 32 // Atau gunakan Micro-Batching worker pool di memory
    
    // Kumpulkan deskripsi produk ke array batch
    for i := 0; i < len(products); i += batchSize {
        end := i + batchSize
        if end > len(products) { end = len(products) }
        
        batchText := make([]string, 0, batchSize)
        for _, p := range products[i:end] { batchText = append(batchText, p.Description) }
        
        // Memukul API ONNX sekaligus (1 kali lompatan CGO untuk 32 kalimat sekaligus).
        // Utilisasi Matrix/SIMD processor di level C++ akan mencapai performa teoritis tertinggi.
        embeddings, _ := engine.GenerateEmbeddings(ctx, batchText)
        saveBatchToDB(embeddings)
    }
}
```

### ❌ Anti-Pattern 2: Meneruskan Slice Pointer Langsung ke `Unsafe.Pointer` (C-API) tanpa Alokasi Khusus (Pinning)
Saat menggunakan pustaka ONNX C API (`onnxruntime_c_api.h`), pengembang tergoda melemparkan _backing array_ dari Go-slice (`[]float32`) secara mentah ke dalam fungsi `C`.

```go
// ❌ BAD: Memory Leak / SIGSEGV Time Bomb
func createTensor(data []float32) {
    // data[0] dipaksa menjadi referensi pointer bahasa C
    cPtr := unsafe.Pointer(&data[0]) 
    
    // C++ mengambil pointer ini. NAMUN, Go tidak di-lock. 
    // Garbage Collector Go dapat berjalan, melihat ini, dan MEMINDAHKAN / MENATA ULANG 
    // array ini ke RAM lain. Saat eksekusi ONNX sedang berjalan, ONNX membaca alamat memori 
    // lama yang sudah invalid!
    C.OrtCreateTensorWithDataAsOrtValue(..., cPtr, ...)
}
```
**Mengapa berbahaya:** Go menggunakan mekanisme *Garbage Collection* yang dapat memindahkan alokasi memori (seperti memadatkan stack goroutine yang berkembang). Jika penunjuk memori Go dioper ke C++, dan *runtime* Go menggeser objek aslinya, maka kode C++ akan membaca atau menulis pada alamat memori acak. Ini mengakibatkan panik *Segmentation Fault (SIGSEGV)* pada tingkat OS yang sangat sulit dilacak dan tidak bisa ditangkap oleh `recover()`. Program hancur seketika.

**✅ GOOD:** Alokasikan memori eksplisit di ruang heap *C* (menggunakan `C.malloc`), salin byte dari Go ke ruang C tersebut menggunakan `C.memcpy`, dan delegasikan kepemilikannya ke modul C++. Atau gunakan pustaka pembungkus pihak ketiga yang telah teruji secara produksi dan aman-CGO seperti `github.com/yalue/onnxruntime_go`.

---

## 5. Edge Cases Kritis dalam Inferensi (Defensive Programming)

1.  **Vektor Bernilai Nol Akibat String Kosong (Zero Vector & NaN Spread):**
    *Masalah:* API terkadang menerima input dari user berupa spasi, string kosong `""`, atau *null*. Model Transformer yang menerima token 100% *padding mask* (tanpa *attention*) sering mengeluarkan hasil *output hidden state* bernilai serba 0.
    *Dampak:* Saat masuk ke fase perhitungan Euclidean Distance (L2 Norm), rumusnya menghitung `math.Sqrt(0) == 0`. Kemudian membagi semua elemen matriks dengan 0 (Divide-by-Zero). Di arsitektur floating-point IEEE 754, angka tersebut menjadi `NaN` (*Not a Number*). Vektor yang mengandung `NaN` tidak bisa diindeks secara matematis di dalam `pgvector` HNSW index dan berpotensi membuat *crash* database.
    *Defensif:* *Hard-guard* pembagian panjang (*magnitude*) menggunakan toleransi angka Epsilon (seperti `< 1e-12`). Jika panjang vektor nol, ubah menjadi angka acak sangat kecil (noise fallback), tangkap dengan kembalian eror, atau tolak proses di fase awal (`if strings.TrimSpace(text) == "" { return nil, ErrEmptyInput }`).

2.  **Pemotongan Informasi Fatal (Silent Token Truncation):**
    *Masalah:* Model seperti *MiniLM* memiliki kapasitas *Max Sequence Length* bawaan 256 atau 512 token. Jika *frontend* mengirim artikel jurnal Wikipedia sepanjang 5.000 kata, tokenizer akan secara naif mengambil 512 token awal (hanya mukadimah artikel) dan mencampakkan sisanya.
    *Dampak:* Hilangnya konteks pencarian semantik (Semantic Search Data Loss). Pengguna mencari frasa yang jelas-jelas ada di paragraf terbawah dari dokumen yang di-*ingest*, namun database mengklaim "Data tidak relevan" karena data bawah tersebut tidak pernah masuk ke *Vector Space*.
    *Defensif:* Jangan biarkan tokenizer Go beraksi pasif memotong (truncate). Bangun lapisan *Chunking Pipeline*. Jika dokumen melebihi *MaxSeqLength*, bagi dokumen tersebut menjadi paragraf (overlap 50 kata per potong). Proses dan simpan pecahan *chunks* (vektor jamak) yang dikorelasikan ulang ke 1 *Document ID* yang sama (misal `doc_id: 123_chunk1`, `123_chunk2`).

3.  **Tegangan Bending Memori pada Long-Tail Batching (OOM Spike):**
    *Masalah:* Dalam sistem asinkron stream (seperti kafka poller), Go memasukkan berbagai macam *event* teks secara simultan dengan ukuran *batch* 32. Jika 31 pesan berukuran 5 kata, tetapi ada 1 pesan nyasar berukuran 512 kata.
    *Dampak:* Alokasi tensor ONNX *WAJIB* mensyaratkan bentuk kubus/persegi (Batch Size x Max Sequence di dalam *batch* tersebut). Ini berarti matriks *batch* tersebut akan terbentuk seukuran (32 x 512 token). 31 dokumen pendek tersebut akan direntangkan dengan padding angka 0 besar-besaran, memaksa CPU bekerja sangat keras memproses angka nol tak berguna, menghabiskan alokasi RAM mendadak 100x lebih masif daripada seharusnya, dan menaikkan drastis waktu interupsi (latency tail spike).
    *Defensif:* *Smart Batching*. Jangan menumpuk batch secara buta `[A, B, C]`. Sortir pesanan masuk di goroutine ke dalam *bucket* panjang (misal *ShortBucket* untuk pesan < 20 token, *LongBucket* untuk pesan > 100). Saat *bucket short* dieksekusi ONNX, bentuk tensor *hanya* akan sebesar 32 x 20. Utilisasi melonjak maksimal.
