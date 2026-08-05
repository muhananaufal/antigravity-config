# Distributed Cache: Groupcache Pattern

> **Berlaku:** Go 1.21+ · `golang/groupcache` · **Lihat juga:** `caching_strategy/multilevel_cache_l1l2.md` · `caching_strategy/cache_invalidation_strategies.md` · `distributed_patterns_resilience/consistent_hashing_ring.md` · `concurrency/singleflight_thundering_herd.md`

## 1. Konsep Utama & Internals

`groupcache` adalah library dari pembuat Go (Brad Fitzpatrick) yang menawarkan kapabilitas distributed caching tanpa server *standalone* seperti Memcached atau Redis. Sistem ini beroperasi *in-memory* sebagai bagian dari binary aplikasi kita (peer-to-peer). 

Konsep utama Groupcache:
1. **Tidak Memiliki Operasi UPDATE atau DELETE**: Groupcache bersifat immutable cache. Setelah data disimpan, data tersebut tidak akan berubah sampai dihapus dari memori melalui mekanisme LRU (Least Recently Used) ketika cache penuh.
2. **Consistent Hashing**: Setiap kunci (key) dipetakan ke *peer* spesifik dalam ring hashing. Jika node A butuh data X, dan data X dimiliki oleh node B, node A akan meminta X ke node B secara otomatis.
3. **Single Flight / Thundering Herd Protection**: Fitur unggulan Groupcache. Jika 10,000 permintaan identik datang ke satu node secara serentak sebelum data tersebut ada di cache, Groupcache hanya akan membiarkan *SATU* permintaan yang melakukan *cache miss* ke database aslinya, lalu mendistribusikan jawabannya ke 9,999 permintaan lainnya.

## 2. Diagram ASCII: Arsitektur Groupcache

```text
[HTTP Client] ----> Node A (Groupcache Peer)
                       |
                       +-- (Key: "user:123")
                       |
                       +-- 1. Cek HotCache lokal (miss)
                       +-- 2. Hash(Key) -> Node C bertanggung jawab
                       |
                       v (Internal RPC / HTTP)
                   Node C (Owner of Key)
                       |
                       +-- 3. Cek MainCache (miss)
                       +-- 4. Getter function dipanggil (SingleFlight aktif)
                       v
                [Database / Slow Storage]
                       |
                       +-- 5. Return data ke Node C
                       +-- 6. Node C simpan di MainCache
                       |
                       v
                   Node A
                       |
                       +-- 7. Simpan sementara di HotCache (sebagian kecil)
                       +-- 8. Return ke Client
```

## 3. Production-Ready Go Code

```go
package groupcache_pattern

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"testing"
	"time"

	"github.com/golang/groupcache"
)

// DBClient mensimulasikan interaksi lambat dengan sistem penyimpanan asli
type DBClient interface {
	GetUser(ctx context.Context, id string) (string, error)
}

// GroupcacheManager membungkus inisialisasi groupcache dan HTTP pool
type GroupcacheManager struct {
	pool  *groupcache.HTTPPool
	group *groupcache.Group
}

// NewGroupcacheManager membuat node cache baru dalam cluster groupcache
func NewGroupcacheManager(selfAddr string, db DBClient, peers []string) *GroupcacheManager {
	// 1. Inisiasi HTTP Pool untuk interaksi antar-peer
	// selfAddr biasanya berupa "http://10.0.0.1:8080"
	pool := groupcache.NewHTTPPool(selfAddr)

	// Set alamat peer (termasuk dirinya sendiri)
	pool.Set(peers...)

	// 2. Buat Group (Namespace data)
	// Kapasitas cache dialokasikan: misal 64 MB
	getter := groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
		// Logika ketika Cache Miss terjadi (Database fetcher)
		log.Printf("[Cache Miss] Fetching data for key: %s dari DB...", key)
		
		data, err := db.GetUser(ctx, key)
		if err != nil {
			return fmt.Errorf("gagal mengambil data pengguna dari DB: %w", err)
		}

		// Masukkan data ke Sink
		// Data harus di-encode menjadi bytes (atau string)
		return dest.SetString(data)
	})

	group := groupcache.NewGroup("users", 64<<20, getter)

	return &GroupcacheManager{
		pool:  pool,
		group: group,
	}
}

// GetUser adalah fungsi utama untuk memanggil data dari cache.
func (gm *GroupcacheManager) GetUser(ctx context.Context, key string) (string, error) {
	var data string
	
	// StringSink bertindak sebagai receiver dari data yang ditemukan di cache
	err := gm.group.Get(ctx, key, groupcache.StringSink(&data))
	if err != nil {
		return "", fmt.Errorf("groupcache gagal mendapatkan kunci %s: %w", key, err)
	}
	
	return data, nil
}

// Serve HTTP untuk komunikasi intra-node peers
func (gm *GroupcacheManager) ServeHTTP(port string) error {
	log.Printf("Menjalankan Groupcache Peer Pool di port %s", port)
	// Biasanya ini digabung dengan multiplexer server aplikasi utama
	return http.ListenAndServe(port, gm.pool)
}


// --- Unit Test (Integration Simulation) ---

type MockDB struct {
	callCount int
}

func (m *MockDB) GetUser(ctx context.Context, id string) (string, error) {
	m.callCount++
	// Simulasi lambat
	time.Sleep(100 * time.Millisecond)
	return fmt.Sprintf("Data_Untuk_%s", id), nil
}

func TestGroupcacheSingleFlight(t *testing.T) {
	// PENTING: groupcache bergantung pada singleton global di package-nya,
	// test mungkin flakey jika dijalankan paralel, sehingga kita pakai grup unik.
	
	mockDB := &MockDB{}
	// Buat groupcache lokal (standalone)
	pool := groupcache.NewHTTPPool("http://localhost:8081")
	pool.Set("http://localhost:8081")
	
	getter := groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
		val, err := mockDB.GetUser(ctx, key)
		if err != nil { return err }
		return dest.SetString(val)
	})
	
	// Gunakan nama grup unik per tes untuk menghindari panic redeclaration
	group := groupcache.NewGroup(fmt.Sprintf("test_users_%d", time.Now().UnixNano()), 1<<20, getter)

	// Simulasi 100 request konkuren untuk key yang DUA (Thundering Herd)
	keyTarget := "user_1001"
	
	done := make(chan bool)
	for i := 0; i < 100; i++ {
		go func() {
			var result string
			err := group.Get(context.Background(), keyTarget, groupcache.StringSink(&result))
			if err != nil {
				t.Errorf("Get error: %v", err)
			}
			if result != "Data_Untuk_user_1001" {
				t.Errorf("Data tidak sesuai")
			}
			done <- true
		}()
	}

	for i := 0; i < 100; i++ {
		<-done
	}

	// Karena ada perlindungan SingleFlight, DB GetUser seharusnya dipanggil maksimal 1 kali saja
	if mockDB.callCount > 1 {
		t.Errorf("SingleFlight gagal! DB dipanggil %d kali, padahal seharusnya 1 kali", mockDB.callCount)
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menggunakan Groupcache untuk Data yang Cepat Berubah (Mutable)
Gagasan bahwa kita dapat men-flush, menghapus, atau memperbarui *specific key* di dalam Groupcache. Groupcache secara sengaja **TIDAK** menyediakan API `Delete(key)` atau `Update(key)`.

```go
// BAD: Berusaha menghack dengan menyimpan timestamp di dalam payload atau mencari celah untuk delete.
// Hal ini bertentangan dengan desain immutable dari groupcache.
```

```go
// GOOD: Gunakan key berbasis versi (Versioning Key)
// Daripada meminta "user:123", minta "user:123:v2" di aplikasi.
// Key "user:123:v1" akan usang dengan sendirinya (evicted) via algoritma LRU ketika memori mulai penuh.
key := fmt.Sprintf("user:%s:rev:%d", userID, currentRevision)
group.Get(ctx, key, sink)
```
**Why dangerous:** Mencoba menimpa atau mengakali memori peers secara manual akan merusak *Consistent Hashing* ring lokal dan HotCache, sehingga node yang berbeda akan mengembalikan data yang berbeda pula. Data loss dan asimetri terjadi.

### ❌ Anti-Pattern 2: Lupa Menangani Error pada Getter Func
Getter *database miss* mengembalikan `error`, tetapi developer hanya me-log error tersebut dan mereturn string kosong untuk di-set ke dest sink.

```go
// BAD: Menyembunyikan error dan meng-cache kegagalan
getter := groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
    data, err := db.GetUser(key)
    if err != nil {
        log.Println("error ambil data", err)
        dest.SetString("") // <-- Sangat buruk, string kosong sekarang akan di-cache dan disajikan ke client!
        return nil
    }
    return dest.SetString(data)
})
```

```go
// GOOD: Kembalikan error langsung agar Groupcache tidak meng-cache data sampah.
getter := groupcache.GetterFunc(func(ctx context.Context, key string, dest groupcache.Sink) error {
    data, err := db.GetUser(key)
    if err != nil {
        // Groupcache akan mem-propagate error ini ke HTTP Client tanpa melakukan cache miss
        return fmt.Errorf("DB error: %w", err) 
    }
    return dest.SetString(data)
})
```
**Why dangerous:** Cache Poisoning. Jika koneksi database putus 1 detik saja, Groupcache akan menyimpan string kosong untuk jutaan record yang masuk di saat itu. Dan string kosong tersebut TIDAK BISA DIHAPUS, ia akan dipertahankan di memori untuk waktu yang sangat lama, merusak data user permanen sampai instance direstart.

## 5. Edge Cases & Defensive Programming

1. **Topology Ring Changes (Peer Dinamis)**
   Ketika menggunakan Groupcache pada environment Kubernetes, pod-pod dapat mati dan tergantikan sehingga alamat IP peer (misal 10.1.2.3) lenyap. Groupcache memerlukan update secara konstan menggunakan metode `.Set(peers...)` setiap kali ada pod yang datang dan pergi.
   *Defensive Check:* Padukan dengan K8s Endpoint Informer. Buat sebuah routine watcher yang mengamati pergerakan IP Pod. Setiap kali IP berubah, tembakkan fungsi `pool.Set(newPeersIPs...)` dengan segera. Hati-hati, re-shuffling hash ring ini akan menyebabkan *cache miss* massal dalam periode singkat, karena pemetaan data berubah.

2. **Hot Key Asymmetry**
   Jika sebuah video artis populer (Satu Key Tertentu: "video:metadata:999") diakses 1 juta kali semenit, Node pemilik hashing key tersebut akan menerima request berlebih yang menyebabkan CPU OOM, sementara Node lain menganggur santai.
   *Defensive Check:* Groupcache memiliki fitur bawaan bernama *HotCache*. Fitur ini mempromosikan duplikat dari data yang sangat sering direquest ke RAM peminta lokal secara langsung, sehingga beban Node Pemilik (Owner Node) berkurang drastis. Pastikan memori limit pada `NewGroup` diset cukup lega (misalnya di atas 50MB) agar *HotCache* punya ruang bernafas dan tidak tersingkir di siklus LRU pertama.

3. **Context Cancellation di Getter**
   Ketika ribuan request memicu SingleFlight, mereka menunggui proses database (Getter). Namun, context yang dilempar oleh request *Pertama* bisa jadi sudah `ctx.Canceled` (misal user menutup browsernya prematur). Jika fungsi Getter Anda membatalkan *database fetch* karena *Context Canceled*, maka ke 9,999 request lainnya yang bergantung padanya akan **gagal masal**.
   *Defensive Check:* Di dalam fungsi `Getter`, lebih baik pisahkan Context antara request HTTP pertama dengan eksekusi call Database. Gunakan context Background dengan Timeout pasti (misal 5 detik) untuk hit database di area Getter, agar fungsi fetch tetap selesai dan memberikannya kepada follower request lain.

## Kapan JANGAN Pakai Ini

- **Untuk data yang bisa berubah.** groupcache **tidak punya mekanisme invalidasi** sama sekali; entri hanya hilang ketika dievict. Ia dirancang untuk data immutable yang mahal dihitung — di luar itu, ia akan menyajikan data lama tanpa cara memperbaikinya.
- **Sebagai pengganti Redis untuk kebutuhan cache umum.** Tidak ada TTL per kunci, tidak ada penghapusan eksplisit, tidak ada struktur data. Itu bukan kekurangan — itu ruang lingkupnya.
- **Tanpa memikirkan perubahan topologi peer.** Perubahan daftar peer memindahkan kepemilikan kunci, dan hit rate akan anjlok setiap kali armada diskalakan.
- **Untuk nilai berukuran besar.** Setiap peer menyimpan salinan hot key di cache lokalnya. Nilai besar dikalikan jumlah peer bisa menghabiskan memori seluruh armada sekaligus.
- **Mengandalkan konsistensi antar peer.** Peer bisa memegang versi berbeda untuk sementara, dan tidak ada mekanisme yang menyatukannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Data lama disajikan tanpa bisa diperbaiki | apakah data memang immutable | groupcache dipakai di luar ruang lingkupnya |
| Hit rate anjlok setiap penskalaan | perubahan daftar peer | Kepemilikan kunci berpindah |
| Memori naik serempak di semua pod | ukuran nilai hot key | Salinan hot key ada di setiap peer |
| Peer menyajikan nilai berbeda | konsistensi antar peer | Tidak ada mekanisme penyatuan versi |
| Beban ke sumber tidak turun | rasio hit lokal vs peer | Kunci tersebar merata; caching kurang efektif |

```bash
# Statistik groupcache: bedakan hit lokal, hit dari peer, dan miss
curl -s localhost:8080/debug/groupcache | jq

# Perubahan daftar peer -- setiap perubahan memindahkan kunci
kubectl get endpoints <layanan> -o jsonpath='{.subsets[*].addresses[*].ip}'

# Nilai berbeda antar pod = bukti langsung ketidakkonsistenan antar peer
for p in $(kubectl get pods -l app=api -o name); do
  kubectl exec "$p" -- curl -s localhost:8080/cache/kunci-uji
done | sort | uniq -c
```
