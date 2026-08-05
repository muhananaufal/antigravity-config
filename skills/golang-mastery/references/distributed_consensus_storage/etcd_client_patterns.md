# Etcd Client Patterns (v3 API)

> **Berlaku:** Go 1.21+ · etcd v3.5+ · **Lihat juga:** `distributed_consensus_storage/raft_consensus_hashicorp.md` · `concurrency/distributed_locks_redis.md` · `cloud_native_k8s_operators/k8s_client_go_informers.md` · `distributed_patterns_resilience/idempotency_key_engine.md`

## 1. Konsep Utama & Internals

`etcd` adalah highly-available, strongly consistent distributed key-value store yang menggunakan protokol konsensus Raft di bawah kap mesinnya. Sebagai core datastore dari Kubernetes control plane, `etcd` memiliki pola pemakaian client (khususnya melalui Golang package `clientv3`) yang secara khusus dirancang untuk menangani beban konkurensi terdistribusi, mekanisme service discovery, dan optimasi locking system terdistribusi.

Fitur & Konsep Kunci Etcd Client v3:
- **Watch Streams**: Observabilitas asinkron lewat multiplexed gRPC streaming. Mengizinkan puluhan ribu klien bereaksi saat ada mutasi terhadap suatu Key atau Range prefix secara instan tanpa melakukan polling (yang mana sangat membebani server).
- **Lease TTL & KeepAlive**: Mekanisme Time-To-Live yang diikat ke Key(s). Jika sebuah client mati atau terputus secara tidak wajar (heartbeat `KeepAlive` gagal terkirim), Lease akan kadaluwarsa, dan semua Key terkait akan otomatis dihapus oleh cluster. Ini merupakan pilar utama membangun *Self-healing Service Registration/Discovery*.
- **Transactions (`Txn`) / Compare-And-Swap (CAS)**: Mekanisme atomik di skala kluster. Menjalankan operasi kondisional dalam satu round-trip (If ModRevision == X, Then Update Y, Else Error Z). Sangat krusial untuk mencegah *race condition* antar node yang mencoba mengupdate resource yang sama.
- **Concurrency & Election**: Abstraksi tingkat tinggi bawaan etcd untuk menjalankan operasi kompleks seperti Leader Election dan Distributed Mutex/Locks (melalui sub-package `go.etcd.io/etcd/client/v3/concurrency`).

## 2. Diagram ASCII: Service Discovery, Leader Election, & Watch Pattern Flow

```text
+-----------------------+                            +-----------------------+
|  Service Node A       |                            |  Service Node B       |
|  (Leader Candidate)   |                            |  (Follower Candidate) |
+-----------+-----------+                            +-----------+-----------+
            |                                                    |
            | 1. Create Lease (TTL:5s)                           | 1. Create Lease (TTL:5s)
            | 2. KeepAlive() background loop                     | 2. KeepAlive() background loop
            | 3. Txn: Put /leader IF NOT EXISTS                  | 3. Txn: Put /leader IF NOT EXISTS
            |                                                    |
            v                                                    v
    +-------+----------------------------------------------------+-------+
    |                                                                    |
    |                   [ etcd Cluster (Raft Consensus) ]                |
    |                   - Node 1 (Leader Raft)                           |
    |                   - Node 2 (Follower Raft)                         |
    |                   - Node 3 (Follower Raft)                         |
    |                                                                    |
    +----------------------------------+---------------------------------+
                                       |
        (Node A lebih cepat via CAS, sukses menjadi Leader Application)
        (Node B gagal mengunci CAS, berubah menjadi mode follower/standby)
                                       |
                                       v
                       +-------------------------------+
                       | 4. Node B menaruh Watcher     |
                       |    pada key '/leader'         |
                       +---------------+---------------+
                                       |
                                       | (Misal Node A Crash / Terputus)
                                       v
                       +-------------------------------+
                       | 5. Lease A timeout            |
                       | 6. Key '/leader' dihapus      |
                       | 7. WatchEvent(DELETE) trigger |
                       +---------------+---------------+
                                       |
                                       | 8. Node B terbangun & langsung
                                       v    mengambil alih /leader
                            [ Node B is the new Leader! ]
```

## 3. Production-Ready Go Code

```go
package etcdpatterns

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"testing"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
)

// EtcdManager membungkus clientv3 untuk menyederhanakan akses dan menyediakan
// fungsionalitas dengan production-ready defaults.
type EtcdManager struct {
	cli *clientv3.Client
}

// NewEtcdManager membuat koneksi baru dengan timeout dan retry configs.
func NewEtcdManager(endpoints []string) (*EtcdManager, error) {
	cli, err := clientv3.New(clientv3.Config{
		Endpoints:   endpoints,
		DialTimeout: 5 * time.Second,
		// Production practice: Set KeepAlive parameters on client level
		DialKeepAliveTime:    10 * time.Second,
		DialKeepAliveTimeout: 3 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to initialize etcd client: %w", err)
	}
	return &EtcdManager{cli: cli}, nil
}

// Close membersihkan resource client.
func (em *EtcdManager) Close() {
	if em.cli != nil {
		em.cli.Close()
	}
}

// RegisterService membuat lease yang dikaitkan ke registry key untuk discovery.
// Mengembalikan context pembatalan dan channel error jika koneksi terputus permanen.
func (em *EtcdManager) RegisterService(ctx context.Context, serviceID, addr string, ttl int64) (context.CancelFunc, <-chan error, error) {
	// 1. Buat Lease
	resp, err := em.cli.Grant(ctx, ttl)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create lease: %w", err)
	}

	// 2. Put data dengan menyertakan LeaseID
	key := fmt.Sprintf("/services/api/%s", serviceID)
	_, err = em.cli.Put(ctx, key, addr, clientv3.WithLease(resp.ID))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to register key %s: %w", key, err)
	}

	// 3. KeepAlive stream berjalan di background.
	// Production practice: gunakan context child untuk mengontrol keepalive lifecycle.
	kaCtx, cancel := context.WithCancel(context.Background())
	kaCh, err := em.cli.KeepAlive(kaCtx, resp.ID)
	if err != nil {
		cancel()
		return nil, nil, fmt.Errorf("failed to setup keepalive: %w", err)
	}

	errCh := make(chan error, 1)

	// Goroutine monitor KeepAlive
	go func() {
		defer close(errCh)
		for {
			select {
			case <-kaCtx.Done():
				// Dihentikan secara manual (graceful shutdown)
				return
			case kaResp, ok := <-kaCh:
				if !ok {
					// Channel ditutup oleh client sdk (misal network partition terlalu lama, etcd hapus lease)
					errCh <- fmt.Errorf("keepalive channel ditutup, node mungkin terputus")
					return
				}
				if kaResp == nil {
					continue
				}
				// Optional: monitor TTL atau latency di sini jika perlu metrik
			}
		}
	}()

	return cancel, errCh, nil
}

// CompareAndSwapTransaction (CAS) menggunakan skema optimistik locking.
// Jika Value dari kunci di cluster sama dengan expectedValue, maka ganti ke newValue.
func (em *EtcdManager) CompareAndSwapTransaction(ctx context.Context, key, expectedVal, newVal string) (bool, error) {
	txn := em.cli.Txn(ctx)

	// CAS logic: If value == expectedVal
	txnResp, err := txn.If(
		clientv3.Compare(clientv3.Value(key), "=", expectedVal),
	).Then(
		// Maka Put newValue
		clientv3.OpPut(key, newVal),
	).Else(
		// Jika tidak, operasi gagal secara siluman atau bisa kita log.
		clientv3.OpGet(key),
	).Commit()

	if err != nil {
		return false, fmt.Errorf("CAS transaction failed to execute: %w", err)
	}

	return txnResp.Succeeded, nil
}

// RunLeaderElection mengabstraksi mekanisme kampanye election bawaan etcd.
// Memblokir hingga menjadi leader, dan berjalan sampai context dibatalkan.
func (em *EtcdManager) RunLeaderElection(ctx context.Context, electionName, myNodeName string) error {
	// Session membungkus lease dan auto-keepalive. TTL 5 berarti jika node mati, 
	// dalam 5 detik etcd akan mencabut posisi leadernya.
	session, err := concurrency.NewSession(em.cli, concurrency.WithTTL(5))
	if err != nil {
		return fmt.Errorf("failed to create concurrency session: %w", err)
	}
	defer session.Close()

	election := concurrency.NewElection(session, electionName)

	log.Printf("[%s] Berpartisipasi menjadi leader...", myNodeName)
	// Campaign() memblokir fungsi sampai client ini memenangkan pemilihan leader.
	if err := election.Campaign(ctx, myNodeName); err != nil {
		return fmt.Errorf("campaign election terhenti: %w", err)
	}

	log.Printf("[%s] Menjadi Leader! Menjalankan tugas kritikal...", myNodeName)

	// Simulasikan leader mengerjakan hal penting, tetapi juga waspada terhadap putusnya Session (split-brain defense)
	select {
	case <-ctx.Done():
		// Resign dari jabatan leader dengan gracefully jika aplikasi di shutdown
		ctxResign, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := election.Resign(ctxResign); err != nil {
			log.Printf("Failed to resign cleanly: %v", err)
		}
		log.Printf("[%s] Mundur dari leader via signal.", myNodeName)
		return nil
		
	case <-session.Done():
		// INI SANGAT KRUSIAL (Edge Case #2).
		// Jika session mati (karena network partition, etcd ga terima heartbeat),
		// node ini HARUS segera berhenti merasa sebagai leader, kalau tidak akan terjadi Split-Brain!
		log.Printf("[%s] CRITICAL: Session terputus! Mundur paksa dari leader untuk mencegah split-brain.", myNodeName)
		return fmt.Errorf("session expired/terputus")
	}
}

// WatchConfig memantau perubahan konfigurasi secara aman (Defensive terhadap Compaction)
func (em *EtcdManager) WatchConfig(ctx context.Context, key string, callback func(string)) error {
	watchCh := em.cli.Watch(ctx, key)
	
	for {
		select {
		case <-ctx.Done():
			return nil
		case wResp, ok := <-watchCh:
			if !ok {
				return fmt.Errorf("watch channel ditutup")
			}
			if wResp.Err() != nil {
				// Edge Case #1: Penanganan ErrCompacted
				if wResp.Err() == rpctypes.ErrCompacted {
					log.Printf("WARN: Revision telah di-compacted. Melakukan sinkronisasi ulang...")
					// Harus memanggil Get untuk nilai terkini, lalu buat Watcher baru mulai dari ModRevision tersebut
					return fmt.Errorf("compaction error: %w", wResp.Err())
				}
				return fmt.Errorf("watch error: %w", wResp.Err())
			}

			for _, ev := range wResp.Events {
				if ev.Type == clientv3.EventTypePut {
					// Edge Case #3: Thundering herd jitter
					time.Sleep(time.Duration(rand.Intn(500)) * time.Millisecond)
					callback(string(ev.Kv.Value))
				}
			}
		}
	}
}


// --- Unit Test (Integration) ---
// Dalam setup Go sesungguhnya, gunakan go.uber.org/mock/gomock atau envtest, 
// namun test ini mendemonstrasikan contract test yang di-skip bila tidak ada etcd.

func TestEtcdCASLogic(t *testing.T) {
	em, err := NewEtcdManager([]string{"127.0.0.1:2379"})
	if err != nil {
		t.Skip("local etcd not running, skip test")
	}
	defer em.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	key := "/test/cas"
	// Cleanup sebelumnya jika ada
	_, _ = em.cli.Delete(ctx, key)
	
	// Setup Awal
	_, err = em.cli.Put(ctx, key, "status_init")
	if err != nil {
		t.Fatalf("setup put failed: %v", err)
	}

	// CAS Berhasil
	success, err := em.CompareAndSwapTransaction(ctx, key, "status_init", "status_running")
	if err != nil {
		t.Fatalf("cas error: %v", err)
	}
	if !success {
		t.Errorf("expected CAS to succeed, karena expected_val cocok")
	}

	// CAS Gagal (kondisi tidak terpenuhi)
	success, err = em.CompareAndSwapTransaction(ctx, key, "status_init", "status_failed")
	if err != nil {
		t.Fatalf("cas error: %v", err)
	}
	if success {
		t.Errorf("expected CAS to fail because current value is status_running, not status_init")
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Event Watch di Memory Array Tanpa Batas (OOM Risk)
`etcd.Watch()` membuka koneksi gRPC stream persisten. Menambahkan setiap respons mutasi langsung ke *slice* in-memory untuk "sejarah audit" tanpa mem-*flush* (membersihkan) slice tersebut dapat mengakibatkan OOM crash, terutama pada cluster di mana ribuan operasi mutasi terjadi.

```go
// BAD: Menyimpan semua event tanpa batas memori
eventsHistory := make([]*clientv3.Event, 0)
ch := cli.Watch(ctx, "/config")
for resp := range ch {
    eventsHistory = append(eventsHistory, resp.Events...) // Memory Leak & OOM!
}
```

```go
// GOOD: Hanya proses dan langsung lepaskan referensinya (fire and forget / update state)
ch := cli.Watch(ctx, "/config")
for resp := range ch {
    for _, ev := range resp.Events {
        // Langsung mutasi state lokal atau kirim ke DB eksternal
        ApplyToLocalCache(ev.Kv.Key, ev.Kv.Value) 
    }
    // GC akan membersihkan resp dan events-nya secara otomatis
}
```
**Why dangerous:** Menyebabkan *Memory Leak* parah yang akan menumbangkan service secara acak (OOM-killed oleh Kubernetes) jika frekuensi mutasi pada etcd tinggi.

### ❌ Anti-Pattern 2: Lock dan KeepAlive Menggunakan Background Context Tanpa Cancel
Menjalankan loop polling, session, atau `KeepAlive` dengan context bawaan `context.Background()` semata. Saat container di-SIGTERM (shutdown), koneksi ke etcd dibiarkan menggantung (zombie connection), dan Lease tidak dicabut dengan segera. Service lain akan tertunda menunggu TTL lease lama kadaluwarsa (misal 10 detik downtime).

```go
// BAD: Tidak ada cancellation.
resp, _ := cli.Grant(context.Background(), 10)
cli.KeepAlive(context.Background(), resp.ID) // Berjalan liar
```

```go
// GOOD: Ikat dengan root context aplikasi, lalu Revoke saat shutdown.
ctx, cancel := context.WithCancel(appCtx) // appCtx batal jika SIGTERM
resp, _ := cli.Grant(ctx, 10)
cli.KeepAlive(ctx, resp.ID)

<-ctx.Done()
// Revoke manual memberikan grace-shutdown instan. Node lain tidak perlu menunggu 10s.
cli.Revoke(context.Background(), resp.ID) 
```
**Why dangerous:** *Zombie leases*. Menimbulkan *discovery lag* dan *failover latency* lambat pada sistem *high-availability*. Saat Leader di-restart, sistem akan lumpuh total selama periode TTL Lease karena etcd belum mengetahui bahwa Leader lama sudah lenyap.

## 5. Edge Cases & Defensive Programming

1. **Compaction & Revision History Expired (ErrCompacted)**
   Etcd menyimpan sejarah kunci berdasarkan nomor Revisi (`Rev`), tetapi rutin melakukan *Compaction* (penghapusan sejarah lama untuk menghemat disk space). Jika *watch stream* terputus, lalu mencoba reconnect dengan meminta Revisi N (yang sudah lewat dari window compaction), etcd akan me-return `rpctypes.ErrCompacted`.
   *Penanganan:* Jangan panik/crash. Tangkap `ErrCompacted`, lakukan `Get()` untuk nilai kunci mutakhir (tanpa parameter Revision spesifik), lalu *Watch()* ulang mulai dari ModRevision hasil *Get* tersebut.

2. **Network Partitions Saat Sedang Menjadi Leader (Split-Brain)**
   Client terputus dari jaringan atau etcd server sesaat (misal 5 detik). `KeepAlive` untuk Session gagal dikirim ke etcd. Etcd otomatis mencabut (revoke) status leader dari node kita dan menunjuk node lain. **Namun**, aplikasi lokal Go Anda tidak sadar jaringannya putus dan masih mengeksekusi *cronjob* krusial karena mengira dirinya masih Leader. Ini menciptakan masalah Split-Brain mematikan (2 leader aktif serentak).
   *Penanganan:* Selalu implementasi `select { case <-session.Done(): exit() }`. Ketika *KeepAlive* stream terhenti/putus, session internal akan menembakkan event ke *channel Done()*. Node *HARUS* segera menghentikan semua operasi krusial dan mereset status internalnya ke mode standby/follower.

3. **Thundering Herd Effect pada Watcher Configuration**
   Ratusan node API terhubung via *Watch* ke kunci prefix konfigurasi `/config/db_dsn`. Ketika *DevOps engineer* mengubah konfigurasi tersebut, ratusan node tersebut secara serentak (dalam fraksi milidetik yang sama) menerima trigger event, dan ratusan node tersebut secara *bersamaan* merestart koneksi database pool mereka. Database akan *down* karena *connection storm* (DDoS mandiri).
   *Penanganan:* Selalu tanamkan mekanisme *Jitter* (Delay acak). Misal: `time.Sleep(rand.Intn(1000) * time.Millisecond)` setelah menerima event *Watch* sebelum merestart/mengaplikasikan konfigurasi baru, sehingga beban pada sistem terdistribusi tersebar merata dalam rentang waktu beberapa detik.

## Kapan JANGAN Pakai Ini

- **etcd sebagai basis data umum.** Ia dirancang untuk metadata kecil yang jarang berubah, dengan batas ukuran nilai dan kuota backend yang keras. Memakainya untuk data aplikasi akan mengganggu **seluruh** pengguna cluster itu — termasuk Kubernetes bila etcd-nya dibagi.
- **Watch tanpa menangani compaction.** Revisi yang sudah dipangkas membuat watch gagal dengan `ErrCompacted`. Klien WAJIB bisa melakukan list ulang dan memulai watch dari revisi baru.
- **Lease tanpa keepalive yang tahan gangguan jaringan.** Lease yang kedaluwarsa melepas lock atau menghapus kunci — dan itu terjadi tepat saat jaringan sedang bermasalah, ketika Anda paling tidak menginginkannya.
- **Transaksi yang terlalu besar.** etcd membatasi jumlah operasi per transaksi. Transaksi yang melewatinya gagal seluruhnya, bukan sebagian.
- **Mengabaikan kuota backend.** etcd yang melewati kuota masuk mode alarm dan **menolak semua penulisan** sampai ada yang membebaskan ruang dan menghapus alarmnya secara manual.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Semua penulisan ditolak mendadak | alarm etcd | Kuota backend terlampaui |
| Watch berhenti tanpa galat yang jelas | `ErrCompacted` di log klien | Revisi sudah dipangkas |
| Lock terlepas saat jaringan bergetar | keepalive lease | Lease kedaluwarsa terlalu cepat |
| Latensi etcd naik untuk semua konsumen | ukuran database | Data terlalu besar untuk etcd |
| Transaksi gagal seluruhnya | jumlah operasi per transaksi | Melewati batas etcd |

```bash
# Alarm adalah hal pertama yang diperiksa saat penulisan ditolak
etcdctl alarm list
etcdctl endpoint status --write-out=table
etcdctl endpoint health

# Ukuran database vs kuota
etcdctl endpoint status -w json | jq '.[] | {endpoint:.Endpoint, dbSize:.Status.dbSize, dbSizeInUse:.Status.dbSizeInUse}'

# Revisi saat ini dan revisi terkompaksi -- selisihnya menentukan seberapa jauh watch bisa mundur
etcdctl endpoint status -w json | jq '.[].Status.header.revision'

kubectl logs -l app=api --since=1h | grep -ci 'etcdserver: mvcc: required revision has been compacted'
```
