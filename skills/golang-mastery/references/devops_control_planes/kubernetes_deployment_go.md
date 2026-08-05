# Manifest Kubernetes untuk Layanan Go

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `devops_control_planes/docker_container_go.md` · `observability_resilience/health_check_readiness.md` · `observability_resilience/graceful_shutdown_drain.md` · `system_programming_linux/cgroups_v2_namespaces.md`

## Konsep Utama

Manifest Kubernetes untuk layanan Go bukan sekadar `image` dan `replicas`. Empat keputusan di dalamnya menentukan perilaku produksi lebih besar daripada sebagian besar kode yang Anda tulis — dan ketiganya berinteraksi dengan runtime Go dengan cara yang tidak jelas dari luar.

### 1. `requests` dan `limits` bukan hal yang sama

| | Artinya | Efek bila salah |
| :--- | :--- | :--- |
| `requests` | Yang **dijamin** dan dipakai penjadwal untuk menempatkan pod | Terlalu rendah → pod ditempatkan di node penuh |
| `limits` CPU | Kuota keras; melewatinya berarti **throttling** | Terlalu rendah → p99 melonjak tanpa CPU terlihat penuh |
| `limits` memori | Batas keras; melewatinya berarti **OOMKilled** | Terlalu rendah → mati mendadak tanpa peringatan |

**CPU limit di-throttle, memory limit membunuh.** Perbedaan ini menentukan cara mendiagnosisnya: masalah CPU muncul sebagai latensi, masalah memori muncul sebagai restart.

### 2. Runtime Go tidak otomatis tahu batas Anda — kecuali Anda memberitahunya

Ini penyebab paling umum layanan Go berperilaku aneh di Kubernetes:

```
GOMAXPROCS  -> sejak Go 1.25 membaca kuota cgroup; di Go 1.21-1.24
               ia memakai jumlah CPU HOST (bisa 64 di node besar),
               menghasilkan penjadwalan berlebih dan throttling
GOMEMLIMIT  -> tanpa ini, GC tidak tahu batas memori pod dan akan
               membiarkan heap tumbuh melewatinya -> OOMKilled
```

`GOMEMLIMIT` harus **di bawah** limit memori pod, dengan margin untuk stack goroutine, buffer, dan memori non-heap. Sekitar 80% dari limit adalah titik awal yang wajar.

### 3. `terminationGracePeriodSeconds` mengikat kontrak dengan kode Anda

Nilai ini adalah batas atas yang keras. Timeout shutdown di aplikasi WAJIB lebih kecil, termasuk jeda awal untuk menunggu endpoint dilepas dari Service. Lihat `observability_resilience/graceful_shutdown_drain.md`.

### 4. PodDisruptionBudget menentukan apakah maintenance bisa berjalan

Tanpa PDB, drain node bisa mematikan seluruh replika layanan sekaligus. Dengan PDB yang terlalu ketat (`minAvailable` = jumlah replika), drain **tidak akan pernah selesai** dan upgrade cluster tersendat tanpa penjelasan.

## Diagram ASCII

```text
   INTERAKSI YANG MENENTUKAN: cgroup <-> runtime Go

   Manifest                    cgroup                  Runtime Go
   ------------------------    ------------------      --------------------
   limits.cpu: "2"        -->  cpu.max: 200000 100000  GOMAXPROCS=?
                                                         Go <=1.24: NumCPU()
                                                         host = 64  <-- SALAH
                                                         Go >=1.25: baca cgroup
   limits.memory: 512Mi   -->  memory.max: 536870912   GOMEMLIMIT=?
                                                         tanpa disetel: GC
                                                         tidak tahu batas
                                                         -> OOMKilled

   Yang WAJIB dipasang eksplisit:
     GOMAXPROCS  <- automaxprocs (Go 1.21-1.24) atau biarkan (Go 1.25+)
     GOMEMLIMIT  <- ~80% limits.memory, sisakan untuk stack & buffer

   ---------------------------------------------------------------

   LINI MASA TERMINASI -- tiga angka yang harus selaras

   SIGTERM                                          SIGKILL
     |                                                 |
     |<-------- terminationGracePeriodSeconds: 45 ---->|
     |                                                 |
     |--jeda--|-------- drain aplikasi --------|       |
       5s              30s                        margin 10s
     ^
     tandai NOT READY, tunggu endpoint dilepas Service

     jeda + drain (35s)  <  grace period (45s)   <- WAJIB
     Bila terbalik: SIGKILL di tengah drain.

   ---------------------------------------------------------------

   TIGA PROBE, TIGA PERTANYAAN BERBEDA

   startup    "sudah selesai boot?"      -> matikan liveness sampai lulus
   readiness  "boleh terima trafik?"     -> boleh memeriksa dependensi
   liveness   "perlu di-restart?"        -> JANGAN periksa dependensi
                                            (DB lambat -> semua pod dibunuh)

   ---------------------------------------------------------------

   PDB: dua cara salah menyetelnya

   minAvailable: 3  dengan replicas: 3   -> drain node MENGGANTUNG selamanya
   (tidak ada PDB)                        -> drain bisa membunuh semua sekaligus
   minAvailable: 2  dengan replicas: 3   -> benar: satu boleh pergi
```

## Kode Go Production-Ready

Manifest yang dirujuk seluruh penjelasan di atas:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0        # 0 = kapasitas tidak pernah turun saat rollout
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api, versi: "1.4.2" }   # label versi WAJIB ada agar
    spec:                                     # canary bisa dinilai dari metrik
      terminationGracePeriodSeconds: 45       # > jeda + timeout drain aplikasi

      # Menyebar replika agar satu node/zona yang hilang tidak
      # menjatuhkan seluruh layanan.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway   # DoNotSchedule bisa memblokir
          labelSelector:                      # penjadwalan saat zona timpang
            matchLabels: { app: api }

      securityContext:
        runAsNonRoot: true
        runAsUser: 65532                      # nonroot pada distroless
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }

      containers:
        - name: api
          image: registri/api@sha256:abc123...   # digest, BUKAN tag:
          ports:                                  # tag bisa dipindahkan
            - { name: http,  containerPort: 8080 }
            - { name: admin, containerPort: 8081 }   # probe + metrik + pprof

          env:
            # Tanpa ini GC tidak tahu batas pod dan akan menembusnya.
            # ~80% dari limits.memory; sisanya untuk stack dan buffer.
            - name: GOMEMLIMIT
              value: "410MiB"
            # Go 1.21-1.24: pasang automaxprocs di kode, atau setel manual
            # sesuai limits.cpu. Go 1.25+: runtime membaca cgroup sendiri.
            - name: GOMAXPROCS
              value: "2"

          resources:
            requests: { cpu: "500m", memory: "256Mi" }
            limits:   { cpu: "2",    memory: "512Mi" }

          # Probe berada di port ADMIN, bukan port publik: saat trafik
          # puncak, probe di port publik ikut mengantre lalu gagal --
          # dan pod dibunuh persis ketika sedang paling dibutuhkan.
          startupProbe:                  # menahan liveness sampai boot selesai
            httpGet: { path: /healthz, port: admin }
            failureThreshold: 30
            periodSeconds: 2             # toleransi boot: 60 detik

          readinessProbe:                # boleh memeriksa dependensi
            httpGet: { path: /readyz, port: admin }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3

          livenessProbe:                 # HANYA "proses ini masih waras?"
            httpGet: { path: /healthz, port: admin }
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3

          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }

          volumeMounts:
            - { name: tmp, mountPath: /tmp }   # readOnlyRootFilesystem
      volumes:                                  # tetap butuh /tmp yang bisa ditulis
        - name: tmp
          emptyDir: {}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  # minAvailable = replicas akan MEMBLOKIR drain node selamanya.
  # Nilai ini harus menyisakan ruang untuk satu pod pergi.
  minAvailable: 2
  selector:
    matchLabels: { app: api }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
  behavior:
    scaleDown:
      # Tanpa jendela stabilisasi, HPA berayun naik-turun mengikuti
      # derau trafik dan menciptakan restart yang tidak perlu.
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 50, periodSeconds: 60 }
```

Sisi Go yang membuat manifest di atas bermakna:

```go
package runtimecfg

import (
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
)

// Laporkan mencetak batas yang BENAR-BENAR berlaku saat start.
//
// Ini tiga baris log yang paling sering menyelamatkan investigasi:
// tanpa mereka, "kenapa pod ini OOMKilled" dijawab dengan menebak.
func Laporkan() string {
	limit := debug.SetMemoryLimit(-1) // -1 = baca tanpa mengubah
	return fmt.Sprintf(
		"GOMAXPROCS=%d NumCPU=%d GOMEMLIMIT=%d GOGC=%s",
		runtime.GOMAXPROCS(0), runtime.NumCPU(), limit, os.Getenv("GOGC"),
	)
}

// PeriksaKonsistensi memperingatkan bila GOMAXPROCS jauh melebihi kuota
// CPU cgroup -- gejala klasik Go 1.21-1.24 tanpa automaxprocs, yang
// muncul sebagai throttling dan p99 tinggi tanpa CPU terlihat penuh.
func PeriksaKonsistensi(kuotaCPU float64) (peringatan string, bermasalah bool) {
	p := runtime.GOMAXPROCS(0)
	if kuotaCPU > 0 && float64(p) > kuotaCPU*2 {
		return fmt.Sprintf(
			"GOMAXPROCS=%d jauh di atas kuota cgroup %.1f CPU; "+
				"pasang go.uber.org/automaxprocs atau setel GOMAXPROCS eksplisit",
			p, kuotaCPU), true
	}
	return "", false
}
```

## Uji

```go
package runtimecfg

import (
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

func TestLaporkan_MemuatKetigaAngkaPenting(t *testing.T) {
	s := Laporkan()
	for _, k := range []string{"GOMAXPROCS=", "NumCPU=", "GOMEMLIMIT="} {
		if !strings.Contains(s, k) {
			t.Errorf("laporan wajib memuat %s, dapat %q", k, s)
		}
	}
}

func TestPeriksaKonsistensi_MendeteksiGOMAXPROCSBerlebih(t *testing.T) {
	// Gejala klasik: node 64 CPU, pod dibatasi 2 CPU, tapi runtime
	// menjadwalkan seolah punya 64.
	asli := runtime.GOMAXPROCS(0)
	defer runtime.GOMAXPROCS(asli)

	runtime.GOMAXPROCS(16)
	p, bermasalah := PeriksaKonsistensi(2.0)
	if !bermasalah {
		t.Fatal("GOMAXPROCS=16 dengan kuota 2 CPU harus dilaporkan bermasalah")
	}
	if !strings.Contains(p, "automaxprocs") {
		t.Errorf("peringatan harus menyebut jalan keluarnya, dapat %q", p)
	}
}

func TestPeriksaKonsistensi_TidakMengeluhSaatWajar(t *testing.T) {
	asli := runtime.GOMAXPROCS(0)
	defer runtime.GOMAXPROCS(asli)

	runtime.GOMAXPROCS(2)
	if _, bermasalah := PeriksaKonsistensi(2.0); bermasalah {
		t.Error("GOMAXPROCS=2 dengan kuota 2 CPU tidak boleh dianggap bermasalah")
	}
}

func TestGOMEMLIMIT_HarusDiBawahLimitPod(t *testing.T) {
	// GOMEMLIMIT yang sama dengan limits.memory tidak menyisakan ruang
	// untuk stack goroutine dan buffer non-heap -> tetap OOMKilled.
	const limitPod = 512 << 20
	asli := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(asli)

	debug.SetMemoryLimit(410 << 20)
	got := debug.SetMemoryLimit(-1)
	if got >= limitPod {
		t.Fatalf("GOMEMLIMIT %d harus di bawah limit pod %d", got, limitPod)
	}
	if float64(got) < float64(limitPod)*0.6 {
		t.Errorf("GOMEMLIMIT %d terlalu konservatif; memori terbuang", got)
	}
}
```

## Anti-Pattern

**❌ SALAH — limit memori tanpa `GOMEMLIMIT`**

```yaml
resources:
  limits: { memory: "512Mi" }
# tidak ada env GOMEMLIMIT
```

GC tidak tahu batas pod. Heap tumbuh sampai melewati 512Mi, dan kernel membunuh proses. Gejalanya: `OOMKilled` berkala tanpa satu pun kebocoran memori di kode.

**✅ BENAR — `GOMEMLIMIT` di bawah limit, dengan margin**

```yaml
env:
  - { name: GOMEMLIMIT, value: "410MiB" }   # ~80% dari 512Mi
resources:
  limits: { memory: "512Mi" }
```

**❌ SALAH — liveness probe memeriksa database**

```yaml
livenessProbe:
  httpGet: { path: /healthz?deep=true, port: http }
```

Database yang lambat sesaat membuat **seluruh** pod gagal probe dan dibunuh bersamaan. Restart massal memperparah keadaan yang sedang buruk, dan pemulihannya jauh lebih lama.

**✅ BENAR — liveness dangkal, readiness yang memeriksa dependensi**

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: admin } }
readinessProbe: { httpGet: { path: /readyz,  port: admin } }
```

**❌ SALAH — probe di port API publik**

```yaml
livenessProbe: { httpGet: { path: /healthz, port: 8080 } }
```

Saat trafik puncak, probe mengantre bersama permintaan pengguna dan gagal. Pod dibunuh persis ketika kapasitasnya paling dibutuhkan.

**✅ BENAR — port admin terpisah**

Server kedua di `:8081` untuk probe, metrik, dan pprof — tidak terekspos ke luar cluster.

**❌ SALAH — `minAvailable` sama dengan jumlah replika**

```yaml
spec: { minAvailable: 3 }   # replicas juga 3
```

Drain node tidak akan pernah bisa memindahkan satu pod pun. Upgrade cluster tersendat, dan penyebabnya tidak jelas dari pesan galat mana pun.

**✅ BENAR — menyisakan ruang untuk satu pod pergi**

```yaml
spec: { minAvailable: 2 }   # dari 3 replika
```

**❌ SALAH — image dengan tag, bukan digest**

```yaml
image: registri/api:1.4.2
```

Tag bisa dipindahkan ke image lain. Pod yang di-restart bulan depan bisa menjalankan biner yang berbeda dari yang Anda uji, dan tidak ada jejak yang menunjukkannya.

**✅ BENAR — digest yang tidak bisa berpindah**

```yaml
image: registri/api@sha256:abc123...
```

**❌ SALAH — `maxUnavailable: 1` pada layanan yang sudah pas kapasitasnya**

```yaml
rollingUpdate: { maxUnavailable: 1, maxSurge: 0 }
```

Kapasitas turun selama rollout. Bila layanan sudah berjalan dekat batas, setiap deploy menjadi insiden kecil.

**✅ BENAR — surge dulu, baru kurangi**

```yaml
rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
```

## Kasus Tepi Produksi

1. **CPU limit menyebabkan throttling yang tidak terlihat di grafik CPU.** Pod bisa di-throttle berat sementara pemakaian CPU rata-ratanya tampak rendah, karena throttling terjadi dalam jendela 100 ms. Yang menunjukkannya adalah `nr_throttled` di `cpu.stat`, bukan grafik utilisasi.

2. **`readOnlyRootFilesystem: true` memecahkan hal yang tidak diduga.** Go menulis ke `/tmp` untuk beberapa operasi, dan sebagian pustaka menulis cache. Sediakan `emptyDir` di `/tmp`, dan uji sebelum menerapkannya ke seluruh armada.

3. **`topologySpreadConstraints` dengan `DoNotSchedule` bisa memblokir penskalaan.** Ketika zona timpang, pod baru tidak akan dijadwalkan sama sekali. `ScheduleAnyway` lebih aman untuk sebagian besar layanan; `DoNotSchedule` hanya bila sebaran benar-benar wajib.

4. **HPA berdasarkan CPU tidak cocok untuk layanan I/O-bound.** Layanan yang menunggu database punya CPU rendah meski antreannya panjang. Untuk itu, skalakan berdasarkan metrik kustom — kedalaman antrean atau latensi — bukan CPU.

5. **`startupProbe` yang terlalu pendek membuat pod tidak pernah start.** Liveness mulai berjalan sebelum aplikasi siap dan membunuhnya, berulang selamanya. `failureThreshold × periodSeconds` harus melampaui waktu boot terburuk, termasuk saat cache dingin.

6. **Init container migrasi memblokir seluruh replika.** Bila setiap pod menjalankan migrasi sebagai init container, sepuluh pod berlomba pada tabel versi yang sama. Pakai Job tunggal, atau bungkus dengan advisory lock — lihat `db_sqlc/database_migration_go.md`.

7. **`requests` yang jauh di bawah pemakaian nyata membuat node kelebihan beban.** Penjadwal memakai `requests` untuk menempatkan pod. Requests yang terlalu optimistis menghasilkan node yang tampak lapang padahal sudah jenuh, dan seluruh pod di node itu ikut melambat.

## Kapan JANGAN Pakai Ini

- **Menyetel `GOMAXPROCS` manual pada Go 1.25+.** Runtime sudah membaca kuota cgroup sendiri. Angka yang dipatok tangan akan salah begitu `limits.cpu` diubah, dan tidak ada yang mengingatkan.
- **HPA pada layanan dengan state di memori.** Menskalakan turun membuang state yang tidak bisa dipulihkan — sesi WebSocket, cache L1 yang mahal dibangun, pekerjaan yang sedang berjalan.
- **PDB pada layanan yang punya satu replika.** PDB akan memblokir drain node tanpa memberi ketersediaan apa pun. Layanan yang benar-benar single-replica butuh keputusan sadar tentang jendela maintenance, bukan PDB.
- **`limits.cpu` pada beban yang bursty dan latensi-sensitif.** Throttling pada burst pendek bisa lebih merusak daripada membiarkan pod memakai CPU menganggur. Sebagian tim sengaja menghilangkan CPU limit dan hanya menetapkan requests — itu keputusan yang sah, dengan konsekuensi yang harus dipahami.
- **Manifest yang ditulis tangan per lingkungan.** Perbedaan antar lingkungan akan menyimpang diam-diam. Kustomize atau Helm dengan nilai per lingkungan lebih tahan — lihat `cloud_native_k8s_operators/helm_chart_go_testing.md`.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| p99 tinggi, CPU tampak rendah | `nr_throttled` di `cpu.stat` | CPU limit menyebabkan throttling |
| `OOMKilled` berkala tanpa kebocoran | apakah `GOMEMLIMIT` dipasang | GC tidak tahu batas pod |
| Restart tanpa crash di log | konfigurasi liveness probe | Liveness membunuh pod yang sehat |
| Drain node menggantung | `minAvailable` vs `replicas` | PDB terlalu ketat |
| Semua replika di satu zona | `topologySpreadConstraints` | Tidak ada penyebaran |
| Pod menjalankan biner tak terduga | tag vs digest pada image | Tag dipindahkan setelah deploy |
| Kapasitas turun saat rollout | `maxUnavailable` | Rollout mengurangi sebelum menambah |

```bash
# Throttling: penjelasan "lambat padahal CPU tidak penuh"
kubectl exec <pod> -- grep -E 'nr_periods|nr_throttled|throttled_usec' /sys/fs/cgroup/cpu.stat

# Batas yang BENAR-BENAR berlaku vs yang dilihat runtime Go
kubectl exec <pod> -- sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max'
kubectl exec <pod> -- env | grep -E 'GOMAXPROCS|GOMEMLIMIT|GOGC'

# Riwayat OOMKilled dan restart
kubectl get pods -l app=api \
  -o custom-columns='NAMA:.metadata.name,RESTART:.status.containerStatuses[0].restartCount,ALASAN:.status.containerStatuses[0].lastState.terminated.reason'

# Sebaran replika antar zona
kubectl get pods -l app=api -o wide --sort-by=.spec.nodeName
kubectl get nodes -L topology.kubernetes.io/zone

# PDB yang memblokir maintenance
kubectl get pdb -A -o custom-columns='NAMA:.metadata.name,MIN:.spec.minAvailable,SEHAT:.status.currentHealthy,DIIZINKAN:.status.disruptionsAllowed'
# DIIZINKAN=0 berarti drain node TIDAK AKAN pernah selesai

# Image yang benar-benar berjalan -- digest, bukan tag
kubectl get pods -l app=api -o jsonpath='{range .items[*]}{.status.containerStatuses[*].imageID}{"\n"}{end}' | sort -u
```
