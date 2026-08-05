# Read Replica — Routing, Lag, dan Read-After-Write

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ streaming replication · **Lihat juga:** `db_sqlc/connection_pool_tuning.md` · `db_sqlc/acid_transactions_isolation.md` · `caching_strategy/multilevel_cache_l1l2.md`

## Konsep Utama

Menambah read replica terdengar seperti kemenangan gratis: baca disebar, primary lega. Kenyataannya replica memperkenalkan satu masalah baru yang **tidak ada** sebelumnya, dan bugnya muncul di produksi, bukan di staging:

> Pengguna menyimpan profil, halaman langsung dimuat ulang, dan data lamanya yang muncul. Ia menyimpan lagi. Muncul lagi yang lama. Ia melapor "sistem tidak menyimpan perubahan saya" — padahal tersimpan sempurna di primary.

Ini **read-after-write inconsistency**, dan penyebabnya replication lag beberapa puluh milidetik. Di staging dengan satu pengguna, lag-nya nol dan bug ini tidak pernah muncul.

### Tiga pertanyaan yang WAJIB dijawab sebelum menambah replica

| Pertanyaan | Bila jawabannya salah |
| :--- | :--- |
| Query mana yang **boleh** basi, dan seberapa basi? | Data lama tampil di tempat kritis |
| Bagaimana query segera-setelah-tulis diarahkan? | Read-after-write inconsistency |
| Apa yang terjadi saat lag melonjak? | Sistem menyajikan data usang tanpa ada yang tahu |

Kesalahan mendasar adalah memperlakukan ini sebagai keputusan **infrastruktur**. Ini keputusan **produk**: setiap query harus punya toleransi kesegaran yang eksplisit.

### Toleransi kesegaran sebagai kontrak

| Kelas | Contoh | Rute |
| :--- | :--- | :--- |
| **Wajib segar** | Saldo, stok saat checkout, hasil tulis sendiri | **Primary** |
| **Boleh basi sedikit** (<1 detik) | Daftar produk, riwayat pesanan | Replica + jaga lag |
| **Boleh basi lama** (menit) | Dasbor analitik, laporan | Replica khusus analitik |

Menjadikan ini eksplisit di tipe — bukan di komentar — adalah inti dari kode di bawah.

### Dua strategi read-after-write

**1. Sticky primary berbasis waktu.** Setelah pengguna menulis, arahkan seluruh bacaannya ke primary selama N detik. Sederhana, tidak butuh dukungan database, dan cukup untuk sebagian besar kasus. Kelemahannya: durasinya tebakan.

**2. LSN token.** Setelah tulis, ambil `pg_current_wal_lsn()`. Saat membaca, pilih replica yang `pg_last_wal_replay_lsn()`-nya sudah melewati LSN itu. Presisi, tapi butuh membawa token melalui sesi atau cookie.

Kode di bawah memakai keduanya: LSN bila tersedia, sticky sebagai cadangan.

## Diagram ASCII

```text
   READ-AFTER-WRITE — bug yang tidak pernah muncul di staging

   t=0ms    POST /profil  --> PRIMARY   UPDATE nama='Budi Baru'
   t=5ms    respons 200
   t=8ms    GET /profil   --> REPLICA   SELECT nama
                                         ^
                                         replikasi baru sampai t=40ms
                                         mengembalikan 'Budi Lama'

   Pengguna melihat perubahannya HILANG.

   ---------------------------------------------------------------

   ROUTING BERDASARKAN TOLERANSI KESEGARAN

                    +-------------------+
   query masuk ---> | kelas kesegaran?  |
                    +---+-----+-----+---+
                        |     |     |
              wajib segar|  <1dtk|  menit
                        v     v     v
                   PRIMARY  REPLICA  REPLICA
                            (cek lag) ANALITIK
                               |
                               v
                     lag > ambang? -> jatuh ke PRIMARY
                     (lebih baik lambat daripada salah)

   ---------------------------------------------------------------

   LSN TOKEN — presisi tanpa menebak durasi

   tulis di primary --> pg_current_wal_lsn() = 0/16B3748
                              |
                        simpan di sesi/cookie
                              |
   baca berikutnya ----------+
        |
        v
   replica.pg_last_wal_replay_lsn() >= 0/16B3748 ?
        ya  -> pakai replica (aman, data pasti sudah ada)
        tidak -> pakai primary
```

## Kode Go Production-Ready

```go
package dbrouter

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

// Kesegaran menyatakan toleransi basi sebuah query.
// Tipe eksplisit memaksa keputusan ini diambil sadar di tiap pemanggilan,
// bukan tersembunyi di komentar atau kebiasaan.
type Kesegaran int

const (
	// WajibSegar selalu ke primary. Untuk saldo, stok, dan pembacaan
	// yang mengikuti tulis milik pengguna yang sama.
	WajibSegar Kesegaran = iota
	// BolehBasi ke replica, dengan syarat lag di bawah ambang.
	BolehBasi
	// Analitik ke replica analitik; lag besar diterima.
	Analitik
)

// Replica membungkus satu koneksi replica beserta keadaan lag-nya.
type Replica struct {
	DB     *sql.DB
	Nama   string
	lagMs  atomic.Int64
	sehat  atomic.Bool
}

// Config mengatur perilaku router.
type Config struct {
	// MaksLag: replica dengan lag di atas ini dilewati untuk BolehBasi.
	MaksLag time.Duration
	// StickyPrimary: durasi seorang penulis tetap diarahkan ke primary
	// setelah menulis, bila LSN tidak tersedia.
	StickyPrimary time.Duration
	// IntervalCekLag: seberapa sering lag disurvei.
	IntervalCekLag time.Duration
	Logger         *slog.Logger
}

// DefaultConfig memberi nilai yang wajar untuk OLTP.
func DefaultConfig() Config {
	return Config{
		MaksLag:        500 * time.Millisecond,
		StickyPrimary:  3 * time.Second,
		IntervalCekLag: time.Second,
		Logger:         slog.Default(),
	}
}

// Router memilih koneksi berdasarkan kelas kesegaran.
type Router struct {
	primary   *sql.DB
	replicas  []*Replica
	analitik  *Replica
	cfg       Config

	mu      sync.RWMutex
	sticky  map[string]time.Time // penulisID -> kapan sticky berakhir
	next    atomic.Uint64        // round-robin
}

// ErrTakAdaReplicaSehat dikembalikan bila seluruh replica tertinggal.
var ErrTakAdaReplicaSehat = errors.New("dbrouter: tidak ada replica yang cukup segar")

// New membangun router dan memulai pemantau lag.
func New(primary *sql.DB, replicas []*Replica, analitik *Replica, cfg Config) *Router {
	r := &Router{
		primary: primary, replicas: replicas, analitik: analitik,
		cfg: cfg, sticky: make(map[string]time.Time),
	}
	for _, rp := range replicas {
		rp.sehat.Store(true)
	}
	return r
}

// PantauLag menyurvei lag tiap replica sampai ctx dibatalkan.
// Dijalankan sebagai goroutine terpisah saat aplikasi start.
func (r *Router) PantauLag(ctx context.Context) {
	t := time.NewTicker(r.cfg.IntervalCekLag)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, rp := range r.replicas {
				lag, err := ukurLag(ctx, rp.DB)
				if err != nil {
					rp.sehat.Store(false)
					r.cfg.Logger.Warn("failed to measure replica lag",
						"replica", rp.Nama, "err", err)
					continue
				}
				rp.lagMs.Store(lag.Milliseconds())
				rp.sehat.Store(true)
			}
		}
	}
}

// ukurLag mengembalikan selisih waktu replay terhadap sekarang.
// Pada replica yang benar-benar menganggur, nilai ini bisa membesar
// tanpa berarti tertinggal — karena itu kita juga memeriksa apakah
// replay sedang berjalan.
func ukurLag(ctx context.Context, db *sql.DB) (time.Duration, error) {
	var detik sql.NullFloat64
	err := db.QueryRowContext(ctx, `
		SELECT CASE
		         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
		         ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
		       END`).Scan(&detik)
	if err != nil {
		return 0, fmt.Errorf("kueri lag: %w", err)
	}
	if !detik.Valid {
		return 0, nil
	}
	return time.Duration(detik.Float64 * float64(time.Second)), nil
}

// TandaiPenulis menandai bahwa penulisID baru saja menulis, sehingga
// bacaan berikutnya dalam jendela sticky diarahkan ke primary.
func (r *Router) TandaiPenulis(penulisID string) {
	r.mu.Lock()
	r.sticky[penulisID] = time.Now().Add(r.cfg.StickyPrimary)
	r.mu.Unlock()
}

// masihSticky memeriksa dan sekaligus membersihkan entri kedaluwarsa.
func (r *Router) masihSticky(penulisID string) bool {
	if penulisID == "" {
		return false
	}
	r.mu.RLock()
	sampai, ada := r.sticky[penulisID]
	r.mu.RUnlock()
	if !ada {
		return false
	}
	if time.Now().Before(sampai) {
		return true
	}
	r.mu.Lock()
	delete(r.sticky, penulisID)
	r.mu.Unlock()
	return false
}

// Pilih mengembalikan koneksi yang tepat beserta alasannya.
// Alasan dikembalikan agar bisa dicatat — routing yang tidak terlihat
// adalah routing yang tidak bisa didiagnosis.
func (r *Router) Pilih(k Kesegaran, penulisID string) (*sql.DB, string) {
	switch k {
	case WajibSegar:
		return r.primary, "wajib-segar"

	case Analitik:
		if r.analitik != nil && r.analitik.sehat.Load() {
			return r.analitik.DB, "analitik"
		}
		return r.primary, "analitik-jatuh-ke-primary"

	case BolehBasi:
		// Penulis yang baru saja menulis TETAP ke primary.
		if r.masihSticky(penulisID) {
			return r.primary, "sticky-setelah-tulis"
		}
		if rp := r.pilihReplicaSegar(); rp != nil {
			return rp.DB, "replica:" + rp.Nama
		}
		// Lebih baik lambat daripada menyajikan data usang diam-diam.
		return r.primary, "replica-tertinggal-jatuh-ke-primary"
	}
	return r.primary, "kelas-tak-dikenal"
}

// pilihReplicaSegar memilih acak di antara replica yang lag-nya aman.
// Acak, bukan round-robin murni, agar tidak terjadi gelombang serempak
// ketika satu replica pulih.
func (r *Router) pilihReplicaSegar() *Replica {
	maks := r.cfg.MaksLag.Milliseconds()
	kandidat := make([]*Replica, 0, len(r.replicas))
	for _, rp := range r.replicas {
		if rp.sehat.Load() && rp.lagMs.Load() <= maks {
			kandidat = append(kandidat, rp)
		}
	}
	if len(kandidat) == 0 {
		return nil
	}
	return kandidat[rand.Intn(len(kandidat))]
}

// StatusLag mengembalikan lag tiap replica untuk keperluan metrik.
func (r *Router) StatusLag() map[string]time.Duration {
	out := make(map[string]time.Duration, len(r.replicas))
	for _, rp := range r.replicas {
		out[rp.Nama] = time.Duration(rp.lagMs.Load()) * time.Millisecond
	}
	return out
}
```

## Uji

```go
package dbrouter

import (
	"database/sql"
	"testing"
	"time"
)

func replicaUji(nama string, lag time.Duration, sehat bool) *Replica {
	rp := &Replica{DB: &sql.DB{}, Nama: nama}
	rp.lagMs.Store(lag.Milliseconds())
	rp.sehat.Store(sehat)
	return rp
}

func routerUji(reps ...*Replica) *Router {
	return New(&sql.DB{}, reps, nil, DefaultConfig())
}

func TestPilih_WajibSegarSelaluPrimary(t *testing.T) {
	r := routerUji(replicaUji("r1", 0, true))
	db, alasan := r.Pilih(WajibSegar, "")
	if db != r.primary || alasan != "wajib-segar" {
		t.Fatalf("mau primary, dapat alasan %q", alasan)
	}
}

func TestPilih_ReplicaSegarDipakai(t *testing.T) {
	rp := replicaUji("r1", 50*time.Millisecond, true)
	r := routerUji(rp)
	db, alasan := r.Pilih(BolehBasi, "")
	if db != rp.DB {
		t.Fatalf("mau replica, alasan %q", alasan)
	}
}

func TestPilih_ReplicaTertinggalDilewati(t *testing.T) {
	// Lebih baik lambat daripada menyajikan data usang diam-diam.
	rp := replicaUji("r1", 5*time.Second, true)
	r := routerUji(rp)
	db, alasan := r.Pilih(BolehBasi, "")
	if db != r.primary {
		t.Fatalf("replica dengan lag 5s harus dilewati, alasan %q", alasan)
	}
	if alasan != "replica-tertinggal-jatuh-ke-primary" {
		t.Fatalf("alasan harus menjelaskan, dapat %q", alasan)
	}
}

func TestPilih_ReplicaTidakSehatDilewati(t *testing.T) {
	rp := replicaUji("r1", 0, false)
	r := routerUji(rp)
	if db, _ := r.Pilih(BolehBasi, ""); db != r.primary {
		t.Fatal("replica tidak sehat harus dilewati")
	}
}

func TestSticky_PenulisDiarahkanKePrimary(t *testing.T) {
	// Inilah pencegah read-after-write inconsistency.
	rp := replicaUji("r1", 0, true)
	r := routerUji(rp)

	r.TandaiPenulis("pengguna-7")
	db, alasan := r.Pilih(BolehBasi, "pengguna-7")
	if db != r.primary || alasan != "sticky-setelah-tulis" {
		t.Fatalf("penulis harus sticky ke primary, alasan %q", alasan)
	}

	// Pengguna lain tidak terpengaruh.
	if db, _ := r.Pilih(BolehBasi, "pengguna-9"); db != rp.DB {
		t.Fatal("pengguna lain harus tetap ke replica")
	}
}

func TestSticky_KedaluwarsaDanDibersihkan(t *testing.T) {
	rp := replicaUji("r1", 0, true)
	cfg := DefaultConfig()
	cfg.StickyPrimary = 10 * time.Millisecond
	r := New(&sql.DB{}, []*Replica{rp}, nil, cfg)

	r.TandaiPenulis("p1")
	time.Sleep(20 * time.Millisecond)

	if db, _ := r.Pilih(BolehBasi, "p1"); db != rp.DB {
		t.Fatal("sticky sudah kedaluwarsa, harus kembali ke replica")
	}
	r.mu.RLock()
	sisa := len(r.sticky)
	r.mu.RUnlock()
	if sisa != 0 {
		t.Fatalf("entri kedaluwarsa harus dibersihkan, tersisa %d", sisa)
	}
}

func TestPilih_MemilihDiAntaraBeberapaReplicaSehat(t *testing.T) {
	r1 := replicaUji("r1", 10*time.Millisecond, true)
	r2 := replicaUji("r2", 20*time.Millisecond, true)
	r3 := replicaUji("r3", 9*time.Second, true) // tertinggal
	r := routerUji(r1, r2, r3)

	terpakai := map[*sql.DB]bool{}
	for i := 0; i < 200; i++ {
		db, _ := r.Pilih(BolehBasi, "")
		terpakai[db] = true
	}
	if terpakai[r3.DB] {
		t.Fatal("replica tertinggal tidak boleh terpilih")
	}
	if !terpakai[r1.DB] || !terpakai[r2.DB] {
		t.Fatal("kedua replica sehat harus terpakai")
	}
}

func TestAnalitik_JatuhKePrimaryBilaTidakAda(t *testing.T) {
	r := routerUji(replicaUji("r1", 0, true))
	if db, alasan := r.Pilih(Analitik, ""); db != r.primary ||
		alasan != "analitik-jatuh-ke-primary" {
		t.Fatalf("tanpa replica analitik harus jatuh ke primary, alasan %q", alasan)
	}
}
```

## Anti-Pattern

**❌ SALAH — semua baca ke replica tanpa pandang bulu**

```go
func (s *Store) AmbilSaldo(ctx context.Context, id int64) (int64, error) {
	// Replica: saldo bisa tertinggal beberapa ratus milidetik.
	return s.replica.QueryRowContext(ctx, `SELECT saldo FROM akun WHERE id=$1`, id)
}
```

Pengguna menarik dana, saldo dari replica masih yang lama, ia menarik lagi. Pada sistem uang, ini bukan bug kenyamanan — ini kehilangan uang.

**✅ BENAR — kelas kesegaran eksplisit di tanda tangan**

```go
func (s *Store) AmbilSaldo(ctx context.Context, id int64) (int64, error) {
	db, _ := s.router.Pilih(dbrouter.WajibSegar, "")
	return db.QueryRowContext(ctx, `SELECT saldo FROM akun WHERE id=$1`, id)
}

func (s *Store) DaftarProduk(ctx context.Context, penulisID string) ([]Produk, error) {
	db, _ := s.router.Pilih(dbrouter.BolehBasi, penulisID)
	// ...
}
```

**❌ SALAH — transaksi tulis dibuka di replica**

```go
tx, _ := s.replica.BeginTx(ctx, nil)
tx.Exec(`UPDATE pesanan SET status='kirim' WHERE id=$1`, id)
// error: cannot execute UPDATE in a read-only transaction
```

Gagalnya baru muncul saat runtime, sering di jalur yang jarang dilewati.

**✅ BENAR — transaksi selalu dari primary, dan itu ditegakkan tipe**

```go
// Bungkus sehingga BeginTx hanya tersedia dari primary.
func (r *Router) Tx(ctx context.Context) (*sql.Tx, error) {
	return r.primary.BeginTx(ctx, nil)
}
```

**❌ SALAH — lag tidak dipantau**

```go
db := replicas[rand.Intn(len(replicas))] // apa pun keadaannya
```

Ketika satu replica tertinggal 40 detik karena `VACUUM` besar di primary, sepertiga pengguna melihat data 40 detik lalu — tanpa satu pun alert.

**✅ BENAR — lag disurvei dan menjadi metrik**

Lihat `PantauLag` dan `StatusLag` di atas. Ekspor sebagai gauge Prometheus, dan pasang alert pada lag, bukan hanya pada ketersediaan.

## Kasus Tepi Produksi

1. **Replica menganggur melaporkan lag membesar.** `pg_last_xact_replay_timestamp()` tidak bergerak bila tidak ada transaksi baru, sehingga lag terlihat naik terus padahal replica sudah sinkron. Kueri di `ukurLag` menanganinya dengan membandingkan `receive_lsn` dan `replay_lsn` lebih dulu — bila sama, lag adalah nol.

2. **Konflik replay membatalkan query panjang.** Query analitik yang berjalan lama di replica bisa dibunuh saat primary mem-`VACUUM` baris yang sedang dibacanya (`ERROR: canceling statement due to conflict with recovery`). Solusinya `hot_standby_feedback = on` (dengan risiko bloat di primary) atau memperbesar `max_standby_streaming_delay` khusus replica analitik.

3. **Failover mengubah peran.** Setelah promosi, bekas replica menjadi primary. Aplikasi WAJIB bisa mendeteksi ini — periksa `pg_is_in_recovery()` secara berkala, atau pakai proxy seperti pgbouncer/patroni yang menyembunyikan perpindahan peran.

4. **Sticky primary pada armada banyak pod.** Peta `sticky` di atas bersifat per-proses. Bila pengguna menulis lewat pod A lalu membaca lewat pod B, sticky-nya hilang. Untuk armada besar, simpan penanda di sesi bersama (Redis, cookie bertanda tangan) — atau pakai LSN token yang dibawa klien.

5. **Replica untuk cadangan bencana, bukan untuk baca.** Replica lintas region punya lag ratusan milidetik dan mengarahkan trafik ke sana menambah latensi, bukan mengurangi. Bedakan peran replica secara eksplisit, dan jangan sampai satu daftar konfigurasi mencampur keduanya.

6. **Pool koneksi terpisah per replica.** Total koneksi = pod × (primary + jumlah replica) × ukuran pool. Angka ini melonjak cepat dan bisa menghabiskan `max_connections`. Hitung sebelum menambah replica — lihat `db_sqlc/connection_pool_tuning.md`.

## Kapan JANGAN Pakai Ini

- **Sebelum primary benar-benar menjadi penyempitan.** Sebagian besar "masalah beban baca" sebenarnya query tanpa index atau N+1. Perbaiki itu dulu; replica menambah kerumitan permanen.
- **Ketika hampir semua baca wajib segar.** Sistem pembayaran dan inventaris sering tidak punya query yang boleh basi. Replica di situ hanya menambah biaya dan risiko.
- **Sebagai pengganti cache.** Untuk data yang jarang berubah dan sering dibaca, cache jauh lebih murah dan lebih cepat daripada replica. Lihat `caching_strategy/multilevel_cache_l1l2.md`.
- **Tanpa pemantauan lag.** Replica tanpa metrik lag adalah cara elegan menyajikan data usang tanpa ada yang menyadarinya sampai pelanggan yang melapor.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Laporan "perubahan saya tidak tersimpan" | apakah baca setelah tulis ke replica | Read-after-write; sticky atau LSN token belum dipasang |
| Data kadang benar kadang lama | distribusi lag antar replica | Satu replica tertinggal, dan routing tidak memeriksanya |
| Lonjakan lag saat jam sibuk | grafik lag vs QPS tulis | Replica tidak sanggup mengikuti; perbesar atau kurangi tulis |
| `canceling statement due to conflict with recovery` | log replica | Query panjang bertabrakan dengan replay; setel delay atau feedback |
| Beban primary tidak turun setelah menambah replica | rasio query per rute | Routing tidak benar-benar mengarahkan, atau semua ditandai wajib-segar |

```sql
-- Lag replikasi dilihat dari PRIMARY, per replica
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS byte_tertinggal,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- Dari sisi REPLICA
SELECT pg_is_in_recovery() AS ini_replica,
       pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       now() - pg_last_xact_replay_timestamp() AS lag_waktu;

-- LSN saat ini di primary — untuk token read-after-write
SELECT pg_current_wal_lsn();
```

```bash
# Distribusi rute di aplikasi (dari log terstruktur)
kubectl logs -l app=api --since=1h \
  | jq -r 'select(.msg=="db_route") | .alasan' | sort | uniq -c | sort -rn

# Berapa sering jatuh ke primary karena lag?
kubectl logs -l app=api --since=1h \
  | grep -c 'replica-tertinggal-jatuh-ke-primary'
```
