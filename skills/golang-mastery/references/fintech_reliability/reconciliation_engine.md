# Reconciliation Engine (Pencocokan Transaksi Keuangan)

> **Berlaku:** Go 1.21+ · **Lihat juga:** `fintech_reliability/double_entry_ledger.md` · `fintech_reliability/idempotency_payment_engine.md` · `fintech_reliability/financial_reporting_olap.md` · `db_sqlc/read_replica_routing.md`

## Concept/Internals
Rekonsiliasi (Recon) adalah proses verifikasi integritas data untuk memastikan bahwa dua set rekaman terpisah (biasanya Buku Besar Internal Anda melawan Rekening Koran/Settlement dari Pihak Bank eksternal) berujung pada saldo yang sinkron dan nilai yang konsisten.
Tanpa rekonsiliasi harian, Anda akan buta jika Bank tiba-tiba menolak pembayaran yang menurut DB Anda sukses, atau lebih mematikan lagi: *Bank memotong uang pengguna tetapi DB Anda mencatat itu gagal (Dana mengendap tak bertuan)*.

Proses Rekonsiliasi terbagi 3 tahap:
1. **Extraction/Ingestion**: Mengambil dan menyeragamkan data (CSV mutasi Bank, File MT940 Swift, API JSON) menjadi objek Go internal.
2. **Matching Engine**: Inti logika. Mengkorelasikan baris internal dan barsternal dengan aturan pencocokan (Exact, Partial, atau Fuzzy).
3. **Dispute/Resolution**: Mengkategorikan data hasil *matching*.
   - **Matched**: Sama identik secara referensi dan jumlah.
   - **Mismatched**: Referensi ketemu, tapi *Amount* (nominal) atau *Direction* (In/Out) beda.
   - **Unmatched (Orphan)**: Ada di bank tapi tidak ada di internal, atau sebaliknya.

### Diagram ASCII: Matching Algorithm (Two-Pointers / HashMap)

```ascii
 [ Internal Ledger DB ]                        [ Bank Settlement CSV ]
 (TxnID, Amount, Date)                         (RefNo, Amount, Date)

          |                                               |
          v                                               v
    [ In-Memory Hash Map by RefNo ]               [ Stream Reader ]
          |                                               |
  { "TX-01": (100.0, Success) }    <--- Cek Key ---- ( "TX-01", 100.0 )  ==> MATCH
  { "TX-02": ( 50.0, Success) }    <--- Cek Key ---- ( "TX-02",  50.1 )  ==> MISMATCH (Selisih)
  { "TX-03": ( 25.0, Success) }        (Tak Ada) <-- ( "TX-99",  10.0 )  ==> UNMATCHED (Ext)
                                   ==> Sisa Hash = { "TX-03" }           ==> UNMATCHED (Int)
```

## Production Code

Skrip rekonsiliasi yang memproses ratusan ribu baris data tidak boleh melempar semuanya ke dalam loop tingkat kerumitan $O(n^2)$. Kita wajib menggunakan struktur `Map` atau memilahnya di memori (dengan hash matching / $O(n)$) untuk kecepatan, didukung *decimal* mathematics.

```go
package recon

import (
	"errors"
	"fmt"
	"testing"

	"github.com/shopspring/decimal"
)

// Record internal atau eksternal yang dinormalisasi
type Record struct {
	ReferenceID string          // Kunci korelasi utama
	Amount      decimal.Decimal // Selalu positif absolut
	Type        string          // "CREDIT" atau "DEBIT"
}

// ReconResult menyimpan output rekonsiliasi
type ReconResult struct {
	Matched    []string
	Mismatched []MismatchReport
	MissingInt []Record // Ada di eksternal, tak ada di internal
	MissingExt []Record // Ada di internal, tak ada di eksternal
}

type MismatchReport struct {
	RefID     string
	IntAmount decimal.Decimal
	ExtAmount decimal.Decimal
	Reason    string
}

// Engine menampung logika recon.
type Engine struct {
	Tolerance decimal.Decimal // Untuk memaklumi fee terpotong langsung/pembulatan bank
}

func NewReconEngine(tolerance decimal.Decimal) *Engine {
	return &Engine{Tolerance: tolerance}
}

// Reconcile membandingkan dua dataset berukuran besar di memori via HashMap
func (e *Engine) Reconcile(internals []Record, externals []Record) ReconResult {
	res := ReconResult{}

	// O(N) Space: Buat map internal untuk pencarian O(1)
	internalMap := make(map[string]Record, len(internals))
	for _, in := range internals {
		internalMap[in.ReferenceID] = in
	}

	// Loop O(M) over externals
	for _, ext := range externals {
		in, exists := internalMap[ext.ReferenceID]

		if !exists {
			// Kasus: Uang masuk di bank tapi sistem internal tidak tahu (Topup anonim, dll)
			res.MissingInt = append(res.MissingInt, ext)
			continue
		}

		// Validasi Arah Transaksi (Debit/Credit)
		if in.Type != ext.Type {
			res.Mismatched = append(res.Mismatched, MismatchReport{
				RefID: ext.ReferenceID, IntAmount: in.Amount, ExtAmount: ext.Amount, 
				Reason: "Direction mismatch (Credit vs Debit)",
			})
			// Delete untuk nandain sudah di process
			delete(internalMap, ext.ReferenceID)
			continue
		}

		// Validasi Jumlah (Amount) menggunakan selisih absolut (Abs)
		diff := in.Amount.Sub(ext.Amount).Abs()
		if diff.GreaterThan(e.Tolerance) {
			res.Mismatched = append(res.Mismatched, MismatchReport{
				RefID: ext.ReferenceID, IntAmount: in.Amount, ExtAmount: ext.Amount,
				Reason: fmt.Sprintf("Amount diff exceeds tolerance: %s", diff.String()),
			})
		} else {
			// Sempurna
			res.Matched = append(res.Matched, ext.ReferenceID)
		}

		// Hapus dari map internal karena sudah di-scan
		delete(internalMap, ext.ReferenceID)
	}

	// Sisa-sisa yang belum dihapus dari internalMap berarti tidak muncul di bank!
	for _, leftover := range internalMap {
		res.MissingExt = append(res.MissingExt, leftover)
	}

	return res
}

// --- Unit Tests ---
func TestReconcile(t *testing.T) {
	engine := NewReconEngine(decimal.RequireFromString("0.10")) // Toleransi 10 sen

	internal := []Record{
		{"TX-1", decimal.RequireFromString("100.00"), "CREDIT"},
		{"TX-2", decimal.RequireFromString("50.00"), "CREDIT"},  // Beda amount
		{"TX-3", decimal.RequireFromString("20.00"), "CREDIT"},  // Ilang di bank
	}

	external := []Record{
		{"TX-1", decimal.RequireFromString("100.00"), "CREDIT"}, // MATCH
		{"TX-2", decimal.RequireFromString("49.80"), "CREDIT"},  // MISMATCH (0.2 > 0.1)
		{"TX-9", decimal.RequireFromString("99.99"), "CREDIT"},  // EXTRA (MissingInt)
	}

	res := engine.Reconcile(internal, external)

	if len(res.Matched) != 1 || res.Matched[0] != "TX-1" {
		t.Errorf("Expected TX-1 to match")
	}
	if len(res.Mismatched) != 1 || res.Mismatched[0].RefID != "TX-2" {
		t.Errorf("Expected TX-2 to mismatch")
	}
	if len(res.MissingExt) != 1 || res.MissingExt[0].ReferenceID != "TX-3" {
		t.Errorf("Expected TX-3 to be missing in external")
	}
	if len(res.MissingInt) != 1 || res.MissingInt[0].ReferenceID != "TX-9" {
		t.Errorf("Expected TX-9 to be missing in internal")
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Exact Time/Date Matching (Pencocokan Menit Presisi)
**Mengapa berbahaya:** Server Internal menggunakan zona UTC dan mencatat transaksi di jam `23:59:15`. File Settlement Bank dari pihak ketiga menggunakan Waktu Lokal Bank (misal WIB/JST) dan mungkin me-*batch* pencatatannya menjadi `00:00:00` pada hari esoknya. Jika algoritma Anda mewajibkan parameter `Date == Date` mutlak, ratusan ribu transaksi akan dilaporkan gagal padahal statusnya sama persis.

```go
// BAD: Mencocokkan waktu persis
if internal.Date == external.Date && internal.Ref == external.Ref { }
```
```go
// GOOD: Abaikan Timestamp saat membandingkan key unik/RefNo. 
// Jika tak ada RefNo unik, gunakan Fuzzy Time Window (T-1 s/d T+1 hari) 
```

### ❌ Anti-Pattern 2: Nested Loop O(N²) Untuk Dataset Besar
**Mengapa berbahaya:** File rekonsiliasi akhir bulan bisa berisi 5 juta baris mutasi. Mengiterasi array internal sambil memutari ulang *(loop dalam loop)* array bank untuk mencari kecocokan referensi akan menyebabkan program hang/OOM selama berjam-jam (menghabiskan triliunan iterasi CPU). 

```go
// BAD: Loop O(N^2)
for _, in := range int_recs {
   for _, ext := range ext_recs {
       if in.Ref == ext.Ref { ... } // MATI LEmas
   }
}
```
```go
// GOOD: Gunakan Hash Map In-Memory atau fitur JOIN SQL Database (O(N) time)
```

### ❌ Anti-Pattern 3: Mengubah Mutasi Asli Secara Langsung (Data Tampering)
**Mengapa berbahaya:** Saat menemukan status *Unmatched*, programmer menambal kodenya dengan script auto-update `UPDATE ledger SET amount = {ext_amount}` untuk "menyelaraskan/memperbaiki". Praktik ini menghancurkan *audit trail* murni dan mengundang kecurigaan regulator. Selalu selesaikan ketidaksesuaian melalui pembuatan jurnal penyesuaian (*Adjustment Entries* baru) yang melacak referensi *Dispute*.

## Edge Cases & Defensive Programming

1. **Many-to-One Matching (Aggregated Settlement)**: Seringkali, *Payment Gateway* membayarkan (Pencairan/Settlement) total uang kumulatif 10,000 mutasi harian ke rekening Anda dalam *SATU* baris lump-sum senilai $1,000,000. Strategi `1-vs-1 HashMap RefNo` akan runtuh. Anda harus mengimplementasikan fungsi khusus `Settlement Reconciliation` yang melakukan agregasi parsial per *Settlement Batch ID* sebelum dicocokkan dengan mutasi tunggal koran bank.
2. **Potongan Bank (Hidden Fees)**: Beberapa bank lama memotong pajak cukai atau biaya admin langsung dari jumlah uang yang sama tanpa memisahkan baris catatannya (`gross - fee = net`). Akibatnya, `Amount` selalu meleset beberapa rupiah. Toleransi statis (contoh: 1 sen) tidak bisa menangkap skema *percentage-based fee*. Anda butuh injeksi fungsi kalkulasi *Fee Engine* pada logic Mismatch untuk menjustifikasi perbedaan nominal secara rasional.
3. **Out-of-Memory (OOM) pada Skala Raksasa**: Menggunakan Hash Map RAM O(N) untuk 100 juta rekaman mutasi pada *instance pod* kecil (2GB) tetap akan menguras memori (*Pointer & Struct Overhead*). Pada skala Enterprise ekstrem, tinggalkan recon *in-memory* dan serahkan kepada teknologi *Data Warehouse* (OLAP) dengan menjejalkan (*Bulk Copy*) CSV bank langsung ke tabel sementara (Staging), dan jalankan *Massive Parallel JOIN query* dari engine DB analitik.

## Kapan JANGAN Pakai Ini

- **Rekonsiliasi yang hanya membandingkan total.** Dua selisih yang saling meniadakan akan lolos tanpa jejak, dan keduanya tetap salah. Cocokkan per transaksi.
- **Tanpa toleransi batas waktu.** Transaksi yang terjadi di perbatasan hari akan tampak sebagai selisih **setiap hari**, dan tim belajar mengabaikan laporan selisih.
- **Menjalankan rekonsiliasi terhadap tabel produksi yang panas.** Pemindaian penuh mengganggu jalur pembayaran. Jalankan terhadap replica atau salinan harian.
- **Perbaikan otomatis atas selisih.** Perbaikan otomatis menyembunyikan penyebab, dan penyebab itu akan menghasilkan selisih lagi besok. Catat, eskalasi, perbaiki dengan keputusan yang tercatat.
- **Laporan selisih tanpa pemilik.** Laporan yang tidak ada yang menindaklanjuti melatih seluruh tim mengabaikannya — termasuk pada hari selisihnya benar-benar berarti kehilangan uang.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Selisih yang sama muncul setiap hari | toleransi batas waktu | Transaksi perbatasan hari dihitung sebagai selisih |
| Total cocok tapi ada transaksi hilang | granularitas pencocokan | Rekonsiliasi hanya di tingkat agregat |
| Jalur pembayaran melambat saat rekonsiliasi | terhadap database mana ia berjalan | Berjalan di primary produksi |
| Selisih menumpuk tanpa ditindak | pemilik dan SLA penyelesaian | Tidak ada proses tindak lanjut |
| Selisih hilang sendiri | apakah ada perbaikan otomatis | Penyebab tersembunyi dan akan berulang |

```sql
-- Pencocokan per transaksi, bukan per total
SELECT i.referensi, i.jumlah AS jumlah_internal, e.jumlah AS jumlah_eksternal,
       i.jumlah - e.jumlah AS selisih
FROM transaksi_internal i
FULL OUTER JOIN transaksi_penyedia e ON e.referensi = i.referensi
WHERE i.jumlah IS DISTINCT FROM e.jumlah
   OR i.referensi IS NULL OR e.referensi IS NULL
LIMIT 50;

-- Umur selisih yang belum diselesaikan: ini metrik kesehatan yang sebenarnya
SELECT kategori, count(*), max(now() - ditemukan_pada) AS tertua
FROM selisih_rekonsiliasi WHERE status = 'terbuka' GROUP BY 1;
```
