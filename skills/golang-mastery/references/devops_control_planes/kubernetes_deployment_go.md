# Manifest Kubernetes untuk Layanan Go

> **Berlaku:** Go 1.21+ · Kubernetes 1.28+ · **Lihat juga:** `devops_control_planes/docker_container_go.md` · `observability_resilience/health_check_readiness.md` · `observability_resilience/graceful_shutdown_drain.md` · `system_programming_linux/cgroups_v2_namespaces.md`

## Konsep Utama

Manifest Kubernetes untuk layanan Go bukan sekadar `image` dan `replicas`. Empat keputusan di dalamnya menentukan perilaku produksi lebih besar daripada sebagian besar kode yang Anda tulis — dan keempatnya berinteraksi dengan runtime Go dengan cara yang tidak jelas dari luar.

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

> **Dua hal yang mengubah cara memakainya, dan keduanya sering terlewat.**
>
> **(a) Menyetel env `GOMAXPROCS` MEMATIKAN kesadaran cgroup Go 1.25+.**
> Perilaku baru itu hanya aktif bila variabel lingkungan `GOMAXPROCS` **tidak
> disetel** (dan modul dideklarasikan `go 1.25` atau lebih baru). Jadi
> menuliskan `GOMAXPROCS: "2"` di manifest "untuk berjaga-jaga" pada klaster
> Go 1.25 bukan sabuk pengaman — ia mematikan fitur yang seharusnya
> menggantikannya, dan angkanya menjadi basi diam-diam begitu `limits.cpu`
> diubah orang lain. Nilai dinamis Go 1.25 juga mengikuti perubahan kuota
> cgroup saat proses berjalan; angka yang dipatok tangan tidak.
>
> **(b) `GOMEMLIMIT` menukar OOMKill dengan spiral GC.**
> Ia adalah batas **lunak**. Bila data hidup benar-benar melampauinya, GC tidak
> menyerah — ia berjalan terus-menerus mencoba turun di bawah batas, dan CPU
> habis untuk GC alih-alih untuk permintaan. Pod tidak mati; ia hidup dan tidak
> melayani apa pun.
>
> Ini berbahaya justru karena berpasangan dengan nasihat "liveness jangan
> memeriksa dependensi" di bawah: `/healthz` yang dangkal **tetap membalas
> 200** selama spiral GC, sehingga Kubernetes tidak pernah me-restart pod itu.
> OOMKill setidaknya menghasilkan pod baru. Karena itu `GOMEMLIMIT` **wajib
> disertai alert** pada `go_memstats_heap_inuse_bytes` mendekati batas dan pada
> `go_gc_duration_seconds` yang melonjak — bukan diandalkan sebagai
> perlindungan yang menyembuhkan dirinya sendiri.
>
> Pola yang didokumentasikan Go untuk beban yang ukurannya bisa diprediksi:
> `GOMEMLIMIT` sebagai batas + `GOGC=off`, sehingga GC hanya berjalan saat
> mendekati batas alih-alih pada setiap kelipatan pertumbuhan heap.

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

      # Layanan yang tidak memanggil API Kubernetes tidak butuh token-nya.
      # Token yang ter-mount otomatis adalah kredensial siap pakai bagi siapa
      # pun yang berhasil menembus container.
      automountServiceAccountToken: false

      # DUA constraint, bukan satu.
      #
      # Sebaran per-ZONA saja TIDAK mencegah ketiga replika mendarat di SATU
      # NODE. Pada klaster satu zona -- yang paling umum di luar penyedia
      # besar -- constraint zona terpenuhi secara trivial oleh penempatan apa
      # pun, termasuk ketiganya di node yang sama. Satu node reboot lalu
      # menjatuhkan seluruh layanan, dan manifestnya terlihat sudah benar.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway   # DoNotSchedule bisa memblokir
          labelSelector:                      # penjadwalan saat zona timpang
            matchLabels: { app: api }
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname # <- yang benar-benar melindungi
          whenUnsatisfiable: ScheduleAnyway   #    dari kehilangan satu node
          labelSelector:
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
            # Ingat: batas LUNAK. Lihat catatan spiral GC di bagian Konsep.
            - name: GOMEMLIMIT
              value: "410MiB"
            # GOMAXPROCS SENGAJA TIDAK DISETEL DI SINI.
            #
            # Pada Go 1.25+, menyetel variabel ini justru MEMATIKAN pembacaan
            # kuota cgroup oleh runtime -- kebalikan dari yang dimaksud. Dan
            # angka yang dipatok tangan menjadi basi diam-diam begitu
            # `limits.cpu` di bawah diubah orang lain.
            #
            # Untuk Go 1.21-1.24, JANGAN menambahkannya di sini; impor
            # `go.uber.org/automaxprocs` di main.go. Alasannya sama: ia
            # membaca kuota yang sebenarnya berlaku, bukan angka yang harus
            # diingat seseorang untuk diperbarui.

          resources:
            requests: { cpu: "500m", memory: "256Mi" }
            limits:   { cpu: "2",    memory: "512Mi" }

          # JEDA SEBELUM SHUTDOWN -- yang dijanjikan lini masa terminasi di
          # diagram atas, dan yang sebelumnya tidak ada di mana pun.
          #
          # Saat SIGTERM tiba, Pod ini masih terdaftar sebagai endpoint
          # Service; pencabutannya asinkron. Tanpa jeda, listener tutup
          # sementara kube-proxy masih mengarahkan koneksi baru ke sini.
          #
          # `exec: ["sleep", "5"]` -- bentuk yang paling sering ditulis --
          # TIDAK BISA dipakai di sini: image runtime-nya distroless, yang
          # tidak punya `sleep` maupun shell. Field `sleep` native (beta di
          # K8s 1.29, GA 1.30) tidak butuh biner apa pun.
          #
          # Pada klaster 1.28, jeda ini WAJIB diimplementasikan di dalam
          # aplikasi -- lihat `devops_control_planes/docker_container_go.md`.
          lifecycle:
            preStop:
              sleep: { seconds: 5 }

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
  # PERSENTASE, BUKAN ANGKA MUTLAK -- karena Deployment ini punya HPA.
  #
  # `minAvailable: 2` benar pada 3 replika, dan berhenti melindungi begitu HPA
  # menaikkannya: pada 20 replika, ia mengizinkan 18 pod dievakuasi SEKALIGUS.
  # Perlindungannya menguap persis ketika beban paling tinggi -- yaitu saat
  # HPA memutuskan menaikkan replika.
  #
  # `maxUnavailable: 25%` naik-turun mengikuti jumlah replika: 1 dari 3,
  # 5 dari 20.
  #
  # Persentase PDB DIBULATKAN KE ATAS (baik minAvailable maupun
  # maxUnavailable). Dua konsekuensinya:
  #   - maxUnavailable persentase tidak pernah jatuh ke 0, jadi ia tidak bisa
  #     memblokir drain selamanya seperti `minAvailable: <jumlah replika>`.
  #   - pada replika sedikit ia lebih longgar dari angkanya: 10% dari 3
  #     dibulatkan menjadi 1, yaitu 33%. Verifikasi dengan
  #     `kubectl get pdb`, jangan dihitung di kepala.
  maxUnavailable: 25%
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
// Ini baris log yang paling sering menyelamatkan investigasi: tanpa mereka,
// "kenapa pod ini OOMKilled" dijawab dengan menebak.
func Laporkan() string {
	limit := debug.SetMemoryLimit(-1) // -1 = baca tanpa mengubah

	// GOGC yang tidak disetel mencetak "GOGC=" -- yang terbaca seperti
	// "kosong" alih-alih "default". Di fungsi yang seluruh gunanya adalah
	// presisi, ambiguitas itu tidak layak dibiarkan.
	gogc := os.Getenv("GOGC")
	if gogc == "" {
		gogc = "100(default)"
	}
	return fmt.Sprintf(
		"GOMAXPROCS=%d NumCPU=%d GOMEMLIMIT=%d GOGC=%s",
		runtime.GOMAXPROCS(0), runtime.NumCPU(), limit, gogc,
	)
}

// PeriksaKonsistensi memperingatkan bila GOMAXPROCS jauh melebihi kuota CPU
// cgroup -- gejala klasik Go 1.21-1.24 tanpa automaxprocs, yang muncul
// sebagai throttling dan p99 tinggi tanpa CPU terlihat penuh.
//
// gomaxprocs DITERIMA SEBAGAI PARAMETER, tidak dibaca dari runtime di dalam
// sini. Fungsi diagnostik yang membaca state global hanya bisa diuji dengan
// MENGUBAH state global itu -- dan `runtime.GOMAXPROCS(n)` men-stop-the-world,
// sehingga uji seperti itu mengganggu setiap uji paralel di paket yang sama.
// Panggil dengan `PeriksaKonsistensi(runtime.GOMAXPROCS(0), kuota)` di main.
//
// Ambang 1,5x bukan angka keramat: sedikit di atas kuota masih wajar (Go
// menjadwalkan lebih banyak M daripada P saat ada blocking syscall), tetapi
// kelipatan besar berarti runtime membaca CPU host, bukan kuota pod.
const ambangGOMAXPROCS = 1.5

func PeriksaKonsistensi(gomaxprocs int, kuotaCPU float64) (peringatan string, bermasalah bool) {
	if kuotaCPU <= 0 {
		return "", false // tidak ada limits.cpu -- tidak ada yang bisa dibandingkan
	}
	if float64(gomaxprocs) > kuotaCPU*ambangGOMAXPROCS {
		return fmt.Sprintf(
			"GOMAXPROCS=%d jauh di atas kuota cgroup %.1f CPU; "+
				"impor go.uber.org/automaxprocs (Go 1.21-1.24), atau pada Go 1.25+ "+
				"HAPUS env GOMAXPROCS agar runtime membaca cgroup sendiri",
			gomaxprocs, kuotaCPU), true
	}
	return "", false
}

// HitungGOMEMLIMIT menurunkan GOMEMLIMIT dari limits.memory pod.
//
// Ada fungsi di sini justru karena versi sebelumnya TIDAK punya: yang ada
// hanya nilai "410MiB" yang ditulis tangan di manifest, plus sebuah uji yang
// memeriksa bahwa 410 lebih kecil dari 512. Angka yang dihitung tangan akan
// menyimpang dari limits.memory pada perubahan berikutnya, dan tidak ada yang
// mengingatkan.
//
// Pemakaian: baca limits.memory lewat Downward API
// (resourceFieldRef: limits.memory) ke sebuah env, lalu panggil ini di main.
func HitungGOMEMLIMIT(limitPodBytes int64, fraksi float64) (int64, error) {
	if limitPodBytes <= 0 {
		return 0, fmt.Errorf("limit pod tidak valid: %d", limitPodBytes)
	}
	if fraksi <= 0 || fraksi >= 1 {
		// fraksi >= 1 berarti tidak ada ruang untuk stack goroutine, buffer
		// jaringan, dan memori non-heap -- pod tetap OOMKilled meski GC
		// patuh sepenuhnya pada batasnya.
		return 0, fmt.Errorf("fraksi harus di antara 0 dan 1 (eksklusif), dapat %v", fraksi)
	}
	return int64(float64(limitPodBytes) * fraksi), nil
}
```

## Uji

```go
package runtimecfg

import (
	"strings"
	"testing"
)

func TestLaporkan_MemuatSeluruhAngkaPenting(t *testing.T) {
	s := Laporkan()
	for _, k := range []string{"GOMAXPROCS=", "NumCPU=", "GOMEMLIMIT=", "GOGC="} {
		if !strings.Contains(s, k) {
			t.Errorf("laporan wajib memuat %s, dapat %q", k, s)
		}
	}
	// GOGC yang tidak disetel harus terbaca sebagai default, bukan kosong.
	if strings.Contains(s, "GOGC=\x00") || strings.HasSuffix(s, "GOGC=") {
		t.Errorf("GOGC kosong ambigu; harus menyebut nilai defaultnya: %q", s)
	}
}

// gomaxprocs kini parameter, sehingga uji ini TIDAK LAGI memanggil
// runtime.GOMAXPROCS(n) -- yang men-stop-the-world dan mengganggu setiap uji
// paralel di paket yang sama.
func TestPeriksaKonsistensi(t *testing.T) {
	kasus := []struct {
		nama       string
		gomaxprocs int
		kuota      float64
		mauMasalah bool
	}{
		// Gejala klasik: node 64 CPU, pod dibatasi 2 CPU, runtime menjadwalkan
		// seolah punya 64.
		{"host 64 CPU, kuota 2", 64, 2.0, true},
		{"16 vs kuota 2", 16, 2.0, true},
		{"pas dengan kuota", 2, 2.0, false},
		{"sedikit di atas kuota masih wajar", 3, 2.0, false},
		{"di bawah kuota", 1, 2.0, false},
		// Tanpa limits.cpu tidak ada yang bisa dibandingkan; memperingatkan di
		// sini hanya menghasilkan derau di setiap pod yang sengaja tak berlimit.
		{"tanpa limits.cpu", 64, 0, false},
	}
	for _, k := range kasus {
		t.Run(k.nama, func(t *testing.T) {
			pesan, bermasalah := PeriksaKonsistensi(k.gomaxprocs, k.kuota)
			if bermasalah != k.mauMasalah {
				t.Fatalf("PeriksaKonsistensi(%d, %v) bermasalah=%v, mau %v",
					k.gomaxprocs, k.kuota, bermasalah, k.mauMasalah)
			}
			if bermasalah && !strings.Contains(pesan, "automaxprocs") {
				t.Errorf("peringatan harus menyebut jalan keluarnya, dapat %q", pesan)
			}
			if !bermasalah && pesan != "" {
				t.Errorf("tidak bermasalah tapi mengembalikan pesan %q", pesan)
			}
		})
	}
}

// Uji versi sebelumnya menyetel GOMEMLIMIT ke 410MiB lalu memeriksa bahwa
// 410 lebih kecil dari 512. Tidak ada satu pun fungsi produksi yang
// dijalankannya -- yang teruji adalah aritmetika yang ditulis di uji itu
// sendiri. Kini yang diuji adalah HitungGOMEMLIMIT.
func TestHitungGOMEMLIMIT(t *testing.T) {
	const limitPod = 512 << 20

	got, err := HitungGOMEMLIMIT(limitPod, 0.8)
	if err != nil {
		t.Fatalf("HitungGOMEMLIMIT: %v", err)
	}
	if got >= limitPod {
		t.Fatalf("GOMEMLIMIT %d harus di bawah limit pod %d", got, limitPod)
	}
	if float64(got) < float64(limitPod)*0.6 {
		t.Errorf("GOMEMLIMIT %d terlalu konservatif; memori terbuang", got)
	}

	// fraksi >= 1 tidak menyisakan ruang untuk stack goroutine dan memori
	// non-heap: pod tetap OOMKilled meski GC patuh sepenuhnya pada batasnya.
	for _, fraksi := range []float64{1.0, 1.2, 0, -0.5} {
		if _, err := HitungGOMEMLIMIT(limitPod, fraksi); err == nil {
			t.Errorf("fraksi %v harus ditolak", fraksi)
		}
	}
	if _, err := HitungGOMEMLIMIT(0, 0.8); err == nil {
		t.Error("limit pod 0 harus ditolak")
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

**❌ JUGA SALAH — angka mutlak pada Deployment yang punya HPA**

```yaml
spec: { minAvailable: 2 }   # benar pada 3 replika...
```

...dan berhenti melindungi begitu HPA menaikkannya. Pada 20 replika, `minAvailable: 2` mengizinkan **18 pod dievakuasi sekaligus**. Perlindungannya menguap persis ketika beban paling tinggi — karena itulah HPA menaikkan replikanya.

**✅ BENAR — persentase, yang ikut naik-turun bersama replika**

```yaml
spec: { maxUnavailable: 25% }   # 1 dari 3, 5 dari 20
```

Persentase PDB dibulatkan **ke atas**, sehingga `maxUnavailable` persentase tidak pernah jatuh ke nol dan tidak bisa memblokir drain selamanya. Efek sampingnya: pada replika sedikit ia lebih longgar dari angkanya (10% dari 3 menjadi 1, yaitu 33%). Verifikasi dengan `kubectl get pdb`, jangan dihitung di kepala.

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
| CPU 100% untuk GC, pod tetap "sehat" | `go_gc_duration_seconds` + heap vs GOMEMLIMIT | Spiral GC: batas lunak ditembus, liveness dangkal tidak menangkapnya |
| Semua replika di satu NODE (zona sudah tersebar) | `topologySpreadConstraints` per hostname | Sebaran hanya per zona |
| PDB tidak melindungi setelah HPA naik | `minAvailable` mutlak vs jumlah replika | Angka mutlak tidak ikut menskala |
| 502 di setiap deploy meski shutdown rapi | `preStop` / jeda not-ready | Endpoint belum dicabut saat listener tutup |

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

# Sebaran per NODE, bukan hanya per zona. Semua di satu node = satu reboot
# menjatuhkan layanan, meski constraint zona terpenuhi.
kubectl get pods -l app=api -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c

# Spiral GC: pod hidup, liveness lolos, dan tidak melayani apa pun.
# heap mendekati GOMEMLIMIT sementara waktu GC melonjak adalah tanda pastinya.
kubectl exec <pod> -- wget -qO- localhost:8081/metrics \
  | grep -E 'go_memstats_heap_inuse_bytes|go_gc_duration_seconds_sum|go_memstats_last_gc'

# GOMAXPROCS yang benar-benar berlaku vs kuota yang benar-benar berlaku.
# Pada Go 1.25+, adanya env GOMAXPROCS berarti kesadaran cgroup DIMATIKAN.
kubectl exec <pod> -- env | grep -c GOMAXPROCS   # harus 0 pada Go 1.25+
```
