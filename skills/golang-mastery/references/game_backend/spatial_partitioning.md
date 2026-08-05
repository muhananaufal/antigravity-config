# Spatial Partitioning (Game Server)

> **Berlaku:** Go 1.21+ · **Lihat juga:** `game_backend/realtime_state_sync.md` · `game_backend/game_server_architecture.md` · `hft_zero_alloc/cpu_cache_optimization.md` · `runtime_internals/escape_analysis_pprof.md`

## Konsep Internal & Trade-offs

Di server game skala menengah hingga masif (MMO, Battle Royale, atau RTS), operasi yang paling berat bagi CPU bukanlah sinkronisasi jaringan, melainkan mendeteksi **Collision (Tabrakan)** dan menghitung **Jarak (Radius Pandang / Area of Interest)** antar entitas.

Secara default, jika kita ingin tahu entitas mana saja yang berada di sekitar Player A (untuk mengirim update state atau mengecek peluru), kita menggunakan perhitungan naif (Brute Force `O(N^2)`). 
Jika server memiliki 10.000 pemain/NPC/Item, untuk 1 player kita butuh mengecek 9.999 entitas. Total pengecekan per tick = `10.000 * 9.999 = ~100 juta operasi!`. CPU Server Anda akan seketika terbakar.

Solusi *Industry Standard* adalah **Spatial Partitioning** (seperti *Quadtree, Grid/Bin Lattices, atau Octree*). Ruang 2D atau 3D dunia game dibagi ke dalam zona/petak sel (Cell Grid). 
Saat Player A berada di `Sel(X=5, Y=5)`, server tidak perlu mengecek seluruh dunia. Server **hanya** akan mengecek entitas lain yang sedang terdaftar di sel `(5,5)` dan sel-sel sekitarnya (8 tetangga). Jumlah pengecekan menyusut drastis dari 10.000 menjadi mungkin hanya 10 atau 20 operasi saja (Mendekati `O(1)` akses).

**Trade-offs Quadtree vs Uniform Grid:**
* *Quadtree*: Optimal untuk ruang di mana area kosong sangat besar dan entitas mengumpul di titik tertentu (Dense cluster). Namun *Update/Moving Entity* (memindah entitas lintas node Quadtree yang dalam) memakan alokasi heap besar dan *cache miss* CPU.
* *Uniform Grid (Binning)*: Memori statik dialokasi di awal. Sempurna untuk bahasa Garbage Collector seperti Go. Akses sangat konstan, pindah sel hanya `O(1)` reassignment matematika modulo/pembagian integer. Kerugiannya adalah memakan banyak memori kosong jika petanya terlalu besar. (Di industri, Grid lebih disukai untuk game dinamis Real-Time).

## Arsitektur & Alur Uniform Grid

```text
       0        100       200       300      (Skala Unit Dunia)
   0 +---------+---------+---------+
     |         |         |         |
     | Cell(0,0) Cell(1,0) Cell(2,0)
     |    A    |    B    |         |
 100 +---------+---------+---------+
     |         |         |         |
     | Cell(0,1) Cell(1,1) Cell(2,1)
     |         |      C  |         |
 200 +---------+---------+---------+
 
 Entitas A ingin tahu jarak radius 50:
 1. Hitung Sel A (X=0/100, Y=0/100) -> Sel(0,0)
 2. Ambil entitas tetangga 1 lapis: Sel (0,0), (1,0), (0,1), (1,1)
 3. Hanya ukur jarak Pitagoras terhadap 'B' dan 'C' (bila berdekatan), 
    mengabaikan ribuan entitas lain di luarnya.
```

## Kode Go Production-Ready

Contoh di bawah mengimplementasikan pola *Uniform Spatial Grid*. Memakai `sync.RWMutex` per-*Cell* (Lock-Striping) agar Ribuan Goroutine entitas bisa bergerak (write) dan dibaca secara paralel (Concurrent-Safe) tanpa saling memblokir satu map besar.

```go
package physics

import (
	"fmt"
	"math"
	"sync"
)

// Entity mendefinisikan objek fisik dalam grid
type Entity struct {
	ID uint32
	X  float64
	Y  float64
}

// Cell menyimpan entitas-entitas di sebuah petak lokal secara thread-safe
type Cell struct {
	mu       sync.RWMutex
	Entities map[uint32]*Entity
}

// SpatialGrid mengatur seluruh ruang game
type SpatialGrid struct {
	CellSize int // Ukuran dunia per petak grid (misal 100 unit)
	Width    int // Total grid menyamping
	Height   int // Total grid menurun
	Cells    [][]*Cell // 2D slice Matrix
}

func NewSpatialGrid(worldWidth, worldHeight, cellSize int) *SpatialGrid {
	w := int(math.Ceil(float64(worldWidth) / float64(cellSize)))
	h := int(math.Ceil(float64(worldHeight) / float64(cellSize)))

	cells := make([][]*Cell, w)
	for x := 0; x < w; x++ {
		cells[x] = make([]*Cell, h)
		for y := 0; y < h; y++ {
			cells[x][y] = &Cell{
				Entities: make(map[uint32]*Entity),
			}
		}
	}

	return &SpatialGrid{
		CellSize: cellSize,
		Width:    w,
		Height:   h,
		Cells:    cells,
	}
}

// getCellCoord merubah koordinat dunia (misal X=350, Y=120) menjadi indeks grid
func (g *SpatialGrid) getCellCoord(x, y float64) (int, int) {
	cx := int(x) / g.CellSize
	cy := int(y) / g.CellSize

	// Batasi/clamp agar tidak out-of-bounds array
	if cx < 0 { cx = 0 }
	if cx >= g.Width { cx = g.Width - 1 }
	if cy < 0 { cy = 0 }
	if cy >= g.Height { cy = g.Height - 1 }

	return cx, cy
}

// UpdatePosition mendaftarkan atau memindahkan entitas dari petak lama ke petak baru
func (g *SpatialGrid) UpdatePosition(ent *Entity, newX, newY float64) {
	oldCx, oldCy := g.getCellCoord(ent.X, ent.Y)
	newCx, newCy := g.getCellCoord(newX, newY)

	// Update data murni entity
	ent.X = newX
	ent.Y = newY

	if oldCx == newCx && oldCy == newCy {
		// Masih di sel yang sama, tidak perlu update grid. (OPTIMISASI BESAR)
		return
	}

	// Lock order sangat krusial jika terjadi di thread konkuren untuk menghindari Deadlock.
	// Hapus dari cell lama (Write Lock)
	oldCell := g.Cells[oldCx][oldCy]
	oldCell.mu.Lock()
	delete(oldCell.Entities, ent.ID)
	oldCell.mu.Unlock()

	// Masukkan ke cell baru (Write Lock)
	newCell := g.Cells[newCx][newCy]
	newCell.mu.Lock()
	newCell.Entities[ent.ID] = ent
	newCell.mu.Unlock()
}

// QueryRadius mengembalikan daftar entitas di radius pencarian (Collision Phase 1 / Broadphase)
func (g *SpatialGrid) QueryRadius(x, y float64, radius float64) []*Entity {
	var result []*Entity

	// Cari kotak batas (Bounding Box) sel target
	minCx, minCy := g.getCellCoord(x-radius, y-radius)
	maxCx, maxCy := g.getCellCoord(x+radius, y+radius)

	for cx := minCx; cx <= maxCx; cx++ {
		for cy := minCy; cy <= maxCy; cy++ {
			
			cell := g.Cells[cx][cy]
			// RLocker sangat efisien untuk operasi baca tinggi per cell
			cell.mu.RLock()
			
			for _, e := range cell.Entities {
				// Cek jarak aktual (Pitagoras / Narrowphase)
				dx := e.X - x
				dy := e.Y - y
				distSq := dx*dx + dy*dy
				
				if distSq <= radius*radius {
					result = append(result, e)
				}
			}
			
			cell.mu.RUnlock()
		}
	}

	return result
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Satu RWMutex Raksasa untuk Seluruh Map
Menggunakan satu map `sync.RWMutex` utama untuk membungkus keseluruhan array Cell.

```go
// BAD: Global Mutex di Grid menghancurkan skalabilitas Multi-Core
func (g *SpatialGrid) UpdatePosition(ent *Entity, newX, newY float64) {
	g.GlobalMutex.Lock() // Semua goroutine/worker Fisika berhenti!
	defer g.GlobalMutex.Unlock()
    
    // ... hapus insert Cell
}
```
**Why dangerous:** Jika server Anda memiliki prosesor 32-core dan ratusan goroutine (NPC AI, Player Network Input) yang berusaha bergerak serentak setiap millisecond, memakai *Global Mutex* membuat fisika berubah menjadi operasi *Sequential* (Antrian Single-Thread). CPU usage tertahan di 1 core saja, server lag parah. Solusinya, terapkan *Lock-Striping* (seperti contoh kode): setiap sel punya *Mutex* independennya sendiri. Pemain di Ujung Utara map tidak akan pernah terblokir (Lock contention) oleh pemain di Ujung Selatan.

### ❌ Anti-Pattern 2: Quadtree dengan banyak Alokasi Memori Dinamis (Heap Thrashing)
Membangun struktur Tree murni berorientasi objek yang selalu me-*new()* dan mendelete child Node saat pemain berjalan (Crossing boundaries).

```go
// BAD: Alokasi Object Baru setiap kali kapasitas node lewat dari batas
if node.EntCount > 5 {
    node.Split() // Memicu heap allocation: new(Node), dst.
}
```
**Why dangerous:** Game loop berjalan 60 kali sedetik. Jika Anda memiliki 10.000 NPC berlarian di peta yang memicu Tree untuk *split* dan *merge* ribuan node per detiknya, *Garbage Collector (GC)* Go akan kewalahan. Waktu jeda (GC Pause STW) mendadak menyentuh puluhan milidetik (stuttering massal). Untuk bahasa Go, *Flat Array / Slice of pre-allocated slices (Grid)* jauh lebih mulus karena memori diam (*Static/Pool*) dan cache L1 CPU bekerja super cepat akibat alokasi memori bersebelahan (*Cache Locality/Contiguous*).

### ❌ Anti-Pattern 3: Matematika Akar Kuadrat (Sqrt) di dalam Tight Loop
Memanggil fungsi *Square Root* pada tahap filter akhir di jutaan pengecekan.

```go
// BAD: Penggunaan matematika lambat (Sqrt) secara berulang
dist := math.Sqrt(dx*dx + dy*dy)
if dist <= radius { // masuk area }
```
**Why dangerous:** Kalkulasi `math.Sqrt()` membutuhkan *Floating Point CPU Cycles* yang relatif mahal. Jika Anda mengecek tabrakan peluru 1000x per frame, lag bertambah parah. Pada operasi jarak/area-of-effect, Anda HANYA butuh operasi relatif. *Good Pattern*: Bandingkan hasil kuadrat jarak (*Distance Squared*) melawan hasil kuadrat radius (contoh `if distSq <= radius*radius`), di mana perkalian `*` dieksekusi oleh CPU dalam 1 siklus (*clock*) jam, memangkas beban kinerja secara instan.

## Edge Cases

1. **Jitter Ping-Pong Koordinat Sel (Boundary Oscillation):** Jika sebuah entitas berada *tepat* di garis batas antara Cell(0,0) dan Cell(1,0). Karena gerakan AI terkadang bergetar maju-mundur berukuran mikro (jitter `0.01` unit), entitas akan terhapus dan ditambahkan di cell yang berbeda 60 kali per detik, menyebabkan lonjakan CPU pada Mutex `UpdatePosition`. Trik: Implementasikan batas histeresis (Hysteresis margin/Ghost Cell). Jangan pindahkan entitas ke cell baru kecuali dia melewati garis batas lebih dari margin tertentu (misal > 5 unit ke dalam zona baru).
2. **Entitas Bertubuh Raksasa (Large Entity Span):** Grid di-desain berdasarkan entitas titik tunggal (1 titik koordinat pusat). Bagaimana jika gamenya memiliki *Raid Boss* naga yang hitbox tubuhnya memakan 4 grid penuh sekaligus? *Radius Query* dengan batas `radius` biasa akan gagal mendeteksi ekor boss di sel ujung. Server harus mendaftarkan ID naga raksasa tersebut ke *multiple cells* secara parsial, atau meletakkannya di "Global Entity List" terpisah agar selalu dievaluasi terhadap pemain, menembus filter spatial.
3. **Deadlock Pada Lock-Striping (Pindah Dua Cell Bersamaan):** Pada desain *Grid per-Cell Mutex*, perpindahan entitas menyebabkan operasi Write Lock dua kali (Hapus Cell Lama, Insert Cell Baru). Jika Pemain A bergerak dari Sel X ke Sel Y, dan Pemain B bergerak dari Sel Y ke Sel X di saat nanosecond yang sama, Goroutine 1 memegang Lock X dan menunggu Lock Y, Goroutine 2 memegang Lock Y dan menunggu Lock X (Mati mendadak / Deadlock). Hindari menahan *nested locks*. Solusi dalam Go standar: rilis Lock awal sebelum meminta Lock kedua, atau buat sistem pesan fisika *Asynchronous* via channels tunggal per-grid (Actor Model).

## Unit Test Meaningful

Tes mendemonstrasikan bahwa sistem Broadphase filtering Grid Spatial tidak akan menemukan entitas yang ada di luar sel radius yang tidak terjangkau (Culling berhasil), tetapi menemukan yang berdekatan.

```go
package physics_test

import (
	"testing"
)

// Catatan: SpatialGrid asumsikan sudah diekspor lengkap.
func TestSpatialGrid_QueryRadius(t *testing.T) {
	// Peta ukuran 1000x1000, 1 petak = ukuran 100
	grid := NewSpatialGrid(1000, 1000, 100)

	// Entitas A sebagai titik pusat (X: 150, Y: 150) -> Sel (1,1)
	entA := &Entity{ID: 1, X: 150, Y: 150}
	
	// Entitas B sangat dekat (X: 160, Y: 160) -> Masih di Sel (1,1)
	entB := &Entity{ID: 2, X: 160, Y: 160}
	
	// Entitas C beda sel, tapi nempel di garis perbatasan (X: 105, Y: 150) -> Sel (1,1)
	entC := &Entity{ID: 3, X: 105, Y: 150}

	// Entitas D di pojok map sangat jauh (X: 900, Y: 900) -> Sel (9,9)
	entD := &Entity{ID: 4, X: 900, Y: 900}

	grid.UpdatePosition(entA, entA.X, entA.Y)
	grid.UpdatePosition(entB, entB.X, entB.Y)
	grid.UpdatePosition(entC, entC.X, entC.Y)
	grid.UpdatePosition(entD, entD.X, entD.Y)

	// Cari apa pun yang ada di radius 50 dari A (Pusat: 150,150)
	// Ekspektasi: 
	// - A (diri sendiri pasti masuk, jarak 0)
	// - B (jarak Pitagoras ~14.1, radius 50. Masuk!)
	// - C (jarak Pitagoras ~45, radius 50. Masuk!)
	// - D (jarak >> 50, Tidak Masuk. Bahkan selnya sama sekali tidak disentuh oleh QueryRadius)
	results := grid.QueryRadius(150.0, 150.0, 50.0)

	if len(results) != 3 {
		t.Fatalf("Expected 3 entities (A, B, C) in radius, but got %d", len(results))
	}

	foundD := false
	for _, r := range results {
		if r.ID == 4 {
			foundD = true
		}
	}
	
	if foundD {
		t.Fatalf("Entity D (ID: 4) which is far away was incorrectly found!")
	}
}

func TestSpatialGrid_UpdatePosition_SameCellOptimization(t *testing.T) {
	grid := NewSpatialGrid(500, 500, 100)
	ent := &Entity{ID: 99, X: 50, Y: 50}
	
	grid.UpdatePosition(ent, 50, 50)
	
	cellBefore := grid.Cells[0][0]
	
	// Gerakkan sedikit saja, masih dalam 0,0 (ukuran sel 100)
	grid.UpdatePosition(ent, 60, 60)
	
	cellAfter := grid.Cells[0][0]

	// Pastikan keberadaan referensi entity aman terjaga (Length 1)
	if len(cellAfter.Entities) != 1 {
		t.Fatalf("Expected entity to remain in cell gracefully without issues")
	}
}
```

## Kapan JANGAN Pakai Ini

- **Untuk jumlah entitas yang kecil.** Di bawah beberapa ratus entitas, pemeriksaan langsung semua pasangan lebih cepat daripada memelihara struktur spasial — dan jauh lebih mudah dibuktikan benar.
- **Grid berukuran tetap untuk sebaran entitas yang tidak merata.** Ketika semua pemain berkumpul di satu titik, satu sel memuat semuanya dan struktur itu tidak menyaring apa pun.
- **Struktur spasial yang dibangun ulang tiap tick.** Untuk entitas yang bergerak, memperbarui posisi dalam struktur lebih murah daripada membangun ulang seluruhnya.
- **Quadtree untuk entitas yang terus bergerak.** Penyisipan dan penghapusan berulang memicu pemecahan dan penggabungan node terus-menerus. Grid atau hash spasial lebih stabil untuk objek bergerak.
- **Tanpa mengukur terhadap alternatif yang lebih sederhana.** Struktur spasial menambah kompleksitas nyata; angkanya harus membuktikan itu terbayar pada beban Anda.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Durasi tick melonjak saat pemain berkumpul | jumlah entitas per sel | Sebaran tidak merata; grid tidak menyaring |
| CPU didominasi pemeliharaan struktur | rasio bangun vs query | Struktur dibangun ulang terlalu sering |
| Tidak lebih cepat dari pemeriksaan langsung | jumlah entitas | Belum mencapai titik impas |
| Alokasi tinggi tiap tick | apakah struktur dipakai ulang | Struktur dialokasikan ulang tiap tick |
| Hasil query melewatkan entitas | penanganan batas sel | Entitas di perbatasan sel terlewat |

```bash
# Sebaran entitas per sel: puncak yang tinggi berarti partisi tidak efektif
curl -s localhost:9090/metrics | grep -E 'spatial_(entities_per_cell|query_duration|rebuilds)'

go test -bench='BenchmarkSpatial|BenchmarkBruteForce' -benchmem -count=10 -run='^$' ./...
go tool pprof -top 'http://localhost:6060/debug/pprof/profile?seconds=30' | grep -i spatial
```
