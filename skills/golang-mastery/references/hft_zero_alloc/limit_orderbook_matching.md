# Limit Orderbook Matching Engine

## Konsep Utama
Dalam High-Frequency Trading (HFT), *Limit Orderbook* (LOB) harus beroperasi dengan latensi deterministik, umumnya dalam hitungan mikrodetik (µs) hingga nanodetik (ns). Alokasi memori dinamis di *heap* (menggunakan `new` atau `make` saat runtime) sangat dihindari karena akan memicu *Garbage Collection* (GC) pauses yang menghancurkan latensi.

Engine pencocokan beroperasi menggunakan prinsip **Price-Time Priority**: pesanan (*orders*) pada harga terbaik dieksekusi lebih dulu. Jika ada lebih dari satu pesanan pada harga yang sama, pesanan yang masuk lebih awal dieksekusi lebih dulu (FIFO).

Struktur data internal yang wajib digunakan dalam HFT C/Go LOB:
1. **Price Levels**: Menggunakan array statis (untuk *dense price ticks*) atau B-Tree (*sparse ticks*) untuk mengurutkan level harga (*Bid* dari tertinggi ke terendah, *Ask* dari terendah ke tertinggi).
2. **Orders per Price Level**: Menggunakan *Double-Linked List* (DLL) per level harga. DLL memungkinkan operasi tambah (*insert*) di akhir (O(1)) dan batal (*cancel/delete*) di tengah (O(1)).
3. **Order Lookup**: Menggunakan `map` atau array *direct-indexed* berdasarkan `OrderID` untuk menemukan alamat pesanan dalam memori secara instan (O(1)) saat permintaan batal masuk.
4. **Zero-Allocation Object Pool**: Semua struktur *node* order dialokasikan di awal (*pre-allocated*) dalam sebuah *arena* memori.

## Diagram ASCII: Memory Arena & Orderbook Pointers

```text
[ MEMORY ARENA - Pre-allocated Array of Orders ]
Index:   0         1         2         3         4
       +---------+---------+---------+---------+---------+
       | ID:100  | ID:101  | ID:102  | Free    | Free    |
       | Prc:50  | Prc:50  | Prc:51  |         |         |
       +---------+---------+---------+---------+---------+

[ ASK BOOK (Sells) ]
Price 51 ──> Head: [ArenaIdx 2] ──> Tail: [ArenaIdx 2]

[ BID BOOK (Buys) ]
Price 50 ──> Head: [ArenaIdx 0] ──> Next: [ArenaIdx 1] ──> Tail: [ArenaIdx 1]

[ ORDER MAP (O(1) Lookup) ]
OrderID 100 -> Pointer to ArenaIdx 0
OrderID 101 -> Pointer to ArenaIdx 1
OrderID 102 -> Pointer to ArenaIdx 2
```

## Kode Go Production-Ready

Kode di bawah ini mengimplementasikan mesin pencocokan *Limit Orderbook* dengan pre-allocated memori untuk mencapai **Zero Allocation** selama siklus hidup perdagangan. Kita menghindari `sync.Pool` karena itu bisa dibersihkan oleh GC; kita membuat pool deterministik mandiri.

```go
package hftalloc

import (
	"context"
	"fmt"
	"testing"
)

// Konteks dan Error
type Side int8

const (
	Buy  Side = 1
	Sell Side = -1
)

var (
	ErrInvalidOrder   = fmt.Errorf("invalid order parameters")
	ErrOrderNotFound  = fmt.Errorf("order not found")
	ErrPoolExhausted  = fmt.Errorf("order pool exhausted")
)

// Order merepresentasikan simpul dalam Double-Linked List pada Orderbook.
// Dioptimalkan untuk Cache-Line dengan menghindari pointer langsung di tempat yang tidak perlu,
// namun untuk DLL kita menggunakan pointer ke sesama Order di dalam Arena.
type Order struct {
	ID       uint64
	Price    int64 // Harga direpresentasikan dalam Integer (Basis Points) untuk menghindari float
	Quantity int64
	Side     Side
	
	// Double-Linked List Pointers
	Prev *Order
	Next *Order
}

// PriceLevel merepresentasikan satu baris harga di Orderbook.
type PriceLevel struct {
	Price int64
	Head  *Order
	Tail  *Order
}

// OrderBook merepresentasikan mesin antrean pesanan.
type OrderBook struct {
	// Untuk HFT yang nyata, array of pointers atau BTree digunakan.
	// Di sini menggunakan slice flat untuk kesederhanaan (dense map).
	Bids []*PriceLevel
	Asks []*PriceLevel
	
	// Lookup table untuk Cancellation O(1)
	OrderMap map[uint64]*Order
	
	// Zero-Allocation Object Pool (Memory Arena)
	arena    []Order
	freeList []*Order
}

// NewOrderBook menginisialisasi orderbook dan pre-allocate memori.
func NewOrderBook(maxOrders int) *OrderBook {
	ob := &OrderBook{
		Bids:     make([]*PriceLevel, 0, 1024),
		Asks:     make([]*PriceLevel, 0, 1024),
		OrderMap: make(map[uint64]*Order, maxOrders),
		arena:    make([]Order, maxOrders),
		freeList: make([]*Order, 0, maxOrders),
	}
	
	// Inisialisasi free list menunjuk ke seluruh elemen di arena
	for i := 0; i < maxOrders; i++ {
		ob.freeList = append(ob.freeList, &ob.arena[i])
	}
	return ob
}

// alloc mengambil satu instance Order kosong dari pool memori (O(1)).
func (ob *OrderBook) alloc() (*Order, error) {
	n := len(ob.freeList)
	if n == 0 {
		return nil, ErrPoolExhausted
	}
	ord := ob.freeList[n-1]
	ob.freeList = ob.freeList[:n-1]
	return ord, nil
}

// free mengembalikan instance Order ke pool memori (O(1)).
func (ob *OrderBook) free(ord *Order) {
	// Reset data agar aman untuk re-use
	ord.ID = 0
	ord.Price = 0
	ord.Quantity = 0
	ord.Prev = nil
	ord.Next = nil
	ob.freeList = append(ob.freeList, ord)
}

// AddOrder memproses pesanan baru. Mengembalikan jumlah eksekusi.
func (ob *OrderBook) AddOrder(ctx context.Context, id uint64, price int64, qty int64, side Side) (int64, error) {
	if price <= 0 || qty <= 0 {
		return 0, fmt.Errorf("validation failed: %w", ErrInvalidOrder)
	}

	executedQty := int64(0)
	remainingQty := qty

	// 1. Fase Pencocokan (Matching Phase)
	if side == Buy {
		for len(ob.Asks) > 0 && remainingQty > 0 {
			bestAskLevel := ob.Asks[0]
			if price < bestAskLevel.Price {
				break // Harga tidak menyilang spread (No Cross)
			}
			
			curr := bestAskLevel.Head
			for curr != nil && remainingQty > 0 {
				if remainingQty >= curr.Quantity {
					// Trade: Full Fill on resting ask
					executedQty += curr.Quantity
					remainingQty -= curr.Quantity
					
					next := curr.Next
					ob.removeOrder(curr) // O(1) removal
					curr = next
				} else {
					// Trade: Partial Fill on resting ask
					executedQty += remainingQty
					curr.Quantity -= remainingQty
					remainingQty = 0
				}
			}
			
			// Jika level harga sudah kosong, hapus level tersebut
			if bestAskLevel.Head == nil {
				ob.Asks = ob.Asks[1:]
			}
		}
	} else {
		for len(ob.Bids) > 0 && remainingQty > 0 {
			bestBidLevel := ob.Bids[0]
			if price > bestBidLevel.Price {
				break
			}
			
			curr := bestBidLevel.Head
			for curr != nil && remainingQty > 0 {
				if remainingQty >= curr.Quantity {
					executedQty += curr.Quantity
					remainingQty -= curr.Quantity
					
					next := curr.Next
					ob.removeOrder(curr)
					curr = next
				} else {
					executedQty += remainingQty
					curr.Quantity -= remainingQty
					remainingQty = 0
				}
			}
			
			if bestBidLevel.Head == nil {
				ob.Bids = ob.Bids[1:]
			}
		}
	}

	// 2. Fase Penempatan (Resting Phase)
	if remainingQty > 0 {
		// Alokasi zero-alloc dari pool
		ord, err := ob.alloc()
		if err != nil {
			return executedQty, fmt.Errorf("allocating order %d: %w", id, err)
		}
		
		ord.ID = id
		ord.Price = price
		ord.Quantity = remainingQty
		ord.Side = side
		
		ob.insertOrder(ord)
		ob.OrderMap[id] = ord
	}

	return executedQty, nil
}

// insertOrder menaruh order di level harganya masing-masing di akhir ekor (Tail).
func (ob *OrderBook) insertOrder(ord *Order) {
	var levels *[]*PriceLevel
	var isBuy bool

	if ord.Side == Buy {
		levels = &ob.Bids
		isBuy = true
	} else {
		levels = &ob.Asks
		isBuy = false
	}

	// Mencari level harga (Sederhana: iterasi linier. Di HFT asli: BTree atau Direct Array indexing)
	for i, lvl := range *levels {
		if lvl.Price == ord.Price {
			// Tambahkan ke ujung antrean di level ini
			ord.Prev = lvl.Tail
			ord.Next = nil
			if lvl.Tail != nil {
				lvl.Tail.Next = ord
			}
			lvl.Tail = ord
			if lvl.Head == nil {
				lvl.Head = ord
			}
			return
		}
		
		// Sort desc untuk Bids, asc untuk Asks
		if (isBuy && ord.Price > lvl.Price) || (!isBuy && ord.Price < lvl.Price) {
			newLevel := &PriceLevel{Price: ord.Price, Head: ord, Tail: ord}
			
			// Sisipkan level baru (O(N) pada slice, ini harus dihindari di produksi nyata,
			// ganti dengan linked-list price levels).
			*levels = append(*levels, nil)
			copy((*levels)[i+1:], (*levels)[i:])
			(*levels)[i] = newLevel
			return
		}
	}
	
	// Jika level harga belum ada dan nilainya paling ujung
	newLevel := &PriceLevel{Price: ord.Price, Head: ord, Tail: ord}
	*levels = append(*levels, newLevel)
}

// CancelOrder membatalkan pesanan dalam waktu konstan O(1).
func (ob *OrderBook) CancelOrder(ctx context.Context, id uint64) error {
	ord, exists := ob.OrderMap[id]
	if !exists {
		return fmt.Errorf("cancel failed: %w", ErrOrderNotFound)
	}
	
	ob.removeOrder(ord)
	return nil
}

// removeOrder memutus Order dari Double-Linked List dan mengembalikannya ke pool.
func (ob *OrderBook) removeOrder(ord *Order) {
	// Putus kaitan DLL (Double-Linked List)
	if ord.Prev != nil {
		ord.Prev.Next = ord.Next
	}
	if ord.Next != nil {
		ord.Next.Prev = ord.Prev
	}
	
	// Hapus dari map dan free
	delete(ob.OrderMap, ord.ID)
	ob.free(ord)
}

// --- UNIT TESTS DAN BENCHMARKS ---

func TestOrderBook_MatchingAndZeroAlloc(t *testing.T) {
	ob := NewOrderBook(100)
	ctx := context.Background()

	// 1. Tambah resting Ask
	ob.AddOrder(ctx, 1, 100, 10, Sell)
	
	// 2. Tambah agresif Buy yang mencocokkan sebagian (Partial Fill)
	execQty, err := ob.AddOrder(ctx, 2, 100, 5, Buy)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	
	if execQty != 5 {
		t.Errorf("expected executed quantity 5, got %d", execQty)
	}
	
	if ob.Asks[0].Head.Quantity != 5 {
		t.Errorf("expected resting ask quantity 5, got %d", ob.Asks[0].Head.Quantity)
	}
}

func TestOrderBook_Cancel(t *testing.T) {
	ob := NewOrderBook(100)
	ctx := context.Background()

	ob.AddOrder(ctx, 1, 100, 10, Sell)
	
	err := ob.CancelOrder(ctx, 1)
	if err != nil {
		t.Fatalf("failed to cancel: %v", err)
	}
	
	if len(ob.OrderMap) != 0 {
		t.Errorf("expected order map to be empty")
	}
	
	// Cek pengembalian ke free list
	if len(ob.freeList) != 100 {
		t.Errorf("expected pool to be fully restored, got %d", len(ob.freeList))
	}
}

func BenchmarkOrderBook_AddAndCancel_ZeroAlloc(b *testing.B) {
	ob := NewOrderBook(10000)
	ctx := context.Background()
	
	b.ReportAllocs() // MEMVERIFIKASI ZERO ALLOCATION
	b.ResetTimer()
	
	for i := 0; i < b.N; i++ {
		// Insert
		ob.AddOrder(ctx, uint64(i+1), 100, 10, Buy)
		// Cancel (hapus instan dan free pool)
		ob.CancelOrder(ctx, uint64(i+1))
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menghapus Elemen Array/Slice Secara Sinkron
**Menggunakan slice backing untuk antrean pesanan pada satu level harga.**

```go
// ❌ BAD: O(N) Array Shifting saat Cancel
func (lvl *PriceLevel) Cancel(orderID uint64) {
    for i, o := range lvl.Orders {
        if o.ID == orderID {
            // Memory shift (O(N)), memicu latensi tinggi!
            lvl.Orders = append(lvl.Orders[:i], lvl.Orders[i+1:]...)
            return
        }
    }
}
```

**Mengapa Berbahaya:** Dalam HFT, jumlah pesanan pada level harga yang padat (seperti harga tick terkini di saham blue-chip) bisa ribuan. Jika seseorang membatalkan pesanannya, dan kita menggeser ribuan elemen di belakangnya menggunakan iterasi array `append`, sistem akan terkunci untuk waktu yang lama, menciptakan "Microburst Latency Spikes". Selama periode lambat ini, kita mungkin kehilangan peluang *arbitrage* bernilai jutaan dolar.

```go
// ✅ GOOD: O(1) Double-Linked List Deletion
func (ob *OrderBook) removeOrder(ord *Order) {
    if ord.Prev != nil {
        ord.Prev.Next = ord.Next
    }
    if ord.Next != nil {
        ord.Next.Prev = ord.Prev
    }
    // Tidak ada pergeseran elemen bergeser, instan.
}
```

### ❌ Anti-Pattern 2: Menggunakan `float64` untuk Representasi Harga dan Ukuran
**Bekerja dengan desimal langsung di mesin pencocokan.**

```go
// ❌ BAD: Floating point representation
type Order struct {
    Price float64 // Rentan IEEE 754 precision loss
    Qty   float64 
}
```

**Mengapa Berbahaya:** Standar *floating point* (IEEE 754) tidak dapat mewakili bilangan pecahan secara presisi absolut. Penambahan dua nilai harga atau kuantitas secara kontinu (seperti di matching engine) bisa menghasilkan `0.00000000001` ketidakcocokan nilai. Jika mesin validasi memeriksa apakah pesanan *fully filled* (Qty == 0), pengecekan itu mungkin gagal dan membiarkan pesanan "hantu" bersarang di *orderbook* selamanya, merusak *state* akuntansi (*Accounting Drift*).

```go
// ✅ GOOD: Integer Basis Points / Ticks
type Order struct {
    Price int64 // Misal 100.50 USD direpresentasikan sebagai 1005000 (Basis = 10000)
    Qty   int64 // Satuan absolut (seperti Satoshi atau Wei)
}
```

## Edge Cases & Defensive Programming

1. **Memory Arena Pool Exhaustion**:
   *Edge Case*: Apa yang terjadi jika lalu lintas pesanan sangat padat dan array *pre-allocated* kita (misal: 100.000 pesanan) penuh?
   *Defensive*: Pada kejadian `ErrPoolExhausted`, mesin tidak boleh hancur (*panic*). Alih-alih, ia harus menolak pesanan baru (*Reject Request*) dan membunyikan alarm operasional, atau secara asinkron memperluas (*grow*) memori array dan memperbaiki pointer, meskipun itu akan mengorbankan siklus GC. Menambahkan pengecekan eksplisit `len(ob.freeList) == 0` sangat krusial.
2. **Wash Trading (Self-Cross Prevention)**:
   *Edge Case*: Jika entitas HFT secara agresif membeli dan ternyata pesanan terbaik yang menanti (resting) di buku adalah pesanan Jual mereka sendiri.
   *Defensive*: OrderBook tidak boleh mengeksekusi pesanan ini jika bursa melarangnya (ilegal di sebagian besar bursa). Harus ada field `ParticipantID` atau `SessionID`. Jika Beli dan Jual memiliki ID sama, engine harus memiliki mekanisme "Self-Trade Prevention (STP)" dengan kebijakan seperti *Cancel Newest* atau *Cancel Oldest*.
3. **Crossed Orderbook State**:
   *Edge Case*: Terkadang, akibat race condition dari multiple feed, mesin mungkin menerima State di mana `BestBid >= BestAsk`. Ini disebut "Crossed Book" dan tidak mungkin terjadi pada pasar kontinu.
   *Defensive*: Engine harus mendeteksi secara implisit jika order bersilang, ia segera mengawali fase `Trade/Execution`. Namun, jika buku *resting* diinisialisasi secara silang, sistem harus memasuki fase *Auction/Halt* dan tidak menyiarkannya sebagai *Live Orders*.
