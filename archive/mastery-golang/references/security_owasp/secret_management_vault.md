# Panduan Definitif: Manajemen Rahasia Dinamis dengan Vault & Viper

> **Berlaku:** Go 1.21+ · HashiCorp Vault · **Lihat juga:** `cybersecurity_zerotrust/secrets_rotation_automated.md` · `arch_patterns/config_management.md` · `cybersecurity_zerotrust/spiffe_spire_workload.md` · `security_owasp/aes_gcm_cryptography.md`

## 1. Konsep dan Internals (Technical Depth)

Penyimpanan *secret* (DB password, API Keys AWS) di *source code*, dalam Git (`.env` yang terbawa *commit*), atau secara statis di Kubernetes Secrets tanpa masa kadaluarsa, adalah risiko utama (*OWASP A02: Cryptographic Failures*). Modern cloud-native pattern menyelesaikan masalah ini secara mendasar dengan konsep **Dynamic Secrets**.

1. **Dynamic Secrets**: Engine rahasia seperti *HashiCorp Vault* menghasilkan kredensial *on-the-fly* (di saat ini juga). Kredensial DB (PostgreSQL) yang diberikan bukan akun `admin` selamanya, melainkan akun buatan mesin yang masa aktifnya (*TTL/Lease Time*) hanya 1 jam dan bisa segera dicabut otomatis dari sisi server (*Revocation*).
2. **Sidecar / Agent Pattern**: Aplikasi Go TIDAK mengimpor *Library Vault API*. Sebagai gantinya, *Pod* K8S menjalankan *Vault Agent Sidecar*. Sidecar itu yang melakukan Auth dan menjemput (pull) *secret* lalu menyimpannya di file disk RAM Memory (Shared TmpFS `dev/shm`). Aplikasi Go HANYA membaca file dari disk internal (File JSON).
3. **In-Memory Redaction**: Saat membaca rahasia, Go secara naif dapat mencetaknya ke stack trace saat aplikasi crash, atau saat `json.Marshal` digunakan di API diagnostic. Tipe Custom Go harus digunakan untuk memutus (Redact) rantai string ke log (`SecretString`).
4. **Hot-Reload (fsnotify / Viper)**: Karena akun DB berganti tiap 1 jam, aplikasi Golang harus membaca event "File Berubah" dari *TmpFS*. Ketika Sidecar memperbaharui JSON, Go harus membangun ulang *Connection Pool* ke DB secara *graceful* tanpa men-drop API yang sedang berjalan.

## 2. Diagram ASCII: Alur Injeksi Dinamis & Pool Swap

```text
[ HashiCorp Vault Server ]
        | (Memberikan kredensial DB umur 1 Jam secara reguler)
        v
+-------------------------------+      [ Kubernetes Pod ]
| Vault Agent (Sidecar)         |
| (Renew lease setiap 45 mnt)   |
+-------------------------------+
        | (Render ke File TmpFS: /vault/secrets/db_config.json)
        v
+-------------------------------+--------------------------------------------+
| File System Watcher (fsnotify)|                                            |
+-------------------------------+         (Go Application Container)         |
        |                                                                    |
        v                                 (Pool lama menuntaskan request)    |
| Update Memory Config  (Atomic)| - - > [ Old SQL.DB Pool  (Closing...) ]    |
| Emit "ConfigChanged" Event    |                                            |
|                               | ----> [ New SQL.DB Pool  (Active)     ]    |
| Re-init Connection Pool       |         (Kredensial baru dicolokkan)       |
+----------------------------------------------------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Kredensial di `os.Getenv` dan Konstan

**Mengapa berbahaya:** dua masalah berbeda yang sering tercampur, dan keduanya nyata.

**Rotasi.** Nilai yang dibaca sekali saat boot tidak bisa berubah tanpa restart, sehingga kredensial berumur satu jam kehilangan seluruh gunanya.

**Paparan.** Variabel lingkungan jauh lebih terbuka daripada yang disangka orang, dan tidak satu pun jalur di bawah ini melibatkan seseorang yang ceroboh menempel isi `env` ke tiket:
- `/proc/<pid>/environ` terbaca oleh proses lain dengan UID yang sama di dalam kontainer;
- seluruh environment **diwariskan ke setiap proses anak** — satu `exec.Command` untuk `pg_dump` menyerahkan semuanya;
- ia muncul di `kubectl describe pod`, di manifes Deployment, dan sering ikut terkirim ke pelapor galat pihak ketiga yang mengumpulkan "konteks lingkungan" secara otomatis.

Berkas di tmpfs bisa dibatasi izinnya, tidak diwariskan ke proses anak, dan bisa diperbarui tanpa restart.

```go
// VULNERABLE: Konstan atau ENV statis selamanya
func connectDBVulnerable() {
	// ❌ BAD: Statis. Password tidak bisa di rotasi (tanpa restart pod). 
	// Dan ENV sering bocor di monitoring tools.
	pass := os.Getenv("POSTGRES_PASS") 
	db, _ := sql.Open("postgres", "user=admin password="+pass)
}
```

```go
// ✅ GOOD: konfigurasi terikat ke berkas yang diperbarui Vault Agent, dan
// DSN-nya sendiri tetap bertipe rahasia.
func connectDBSafe(ctx context.Context, cm *ConfigManager, ttlLease time.Duration) (*sql.DB, error) {
	// Galat sql.Open TIDAK dibuang: driver kerap menyertakan DSN di dalam
	// pesannya, dan DSN memuat kata sandi. Lihat BukaPool di §5, yang
	// menyamarkannya sebelum galat itu keluar.
	return BukaPool(ctx, cm.GetConfig(), ttlLease)
}
```

Dua hal yang membedakan potongan ini dari bentuk yang biasa ditulis:

- **DSN diperlakukan sebagai rahasia, bukan hanya kata sandinya.** Melindungi field `DBPass` lalu menyusun `"user=... password=..."` sebagai `string` telanjang hanya memindahkan kebocoran satu lapis — dan DSN justru nilai yang paling sering ikut tercetak, baik di log "menghubungkan ke ...", di pesan galat driver, maupun sebagai atribut span.
- **Galat dari driver disamarkan sebelum keluar.** Ini titik kebocoran yang paling mudah terlewat: kode Anda tidak pernah mencetak kata sandi, tetapi galat dari pustaka pihak ketiga bisa membawanya, dan galat itu berakhir di log persis seperti yang lain.

### ❌ Anti-Pattern 2: Kebocoran Data (Data Bleed) di Struct Formatting

**Mengapa berbahaya (Exploit Vector)**: Dalam proses *debugging*, Developer mungkin menaruh perintah `%v` atau `json.Marshal()` pada obyek *Config/Connection struct*. Ini mencetak keseluruhan nilainya (termasuk String DB_PASSWORD asli) ke log *ElasticSearch* yang bisa dibaca ribuan pegawai.

```go
// VULNERABLE: Struct dengan String Publik
type BadConfig struct {
    Password string `json:"password"`
}
func debugLog() {
    c := BadConfig{Password: "real-db-secret"}
    // ❌ BAD: Tercetak plain-text: "Config is: {real-db-secret}"
    log.Printf("Config is: %v", c) 
}
```

```go
// ✅ GOOD: Gunakan tipe `SecretString` yang mencegah kebocoran secara tipe-data
type SafeConfig struct {
    Password SecretString `json:"password"`
}
func debugLogSafe() {
    c := SafeConfig{Password: "real-db-secret"}
    // ✅ GOOD: Tercetak: "Config is: {[REDACTED-SECRET]}"
    log.Printf("Config is: %v", c) 
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **Race Condition Saat Reload — dan akibat sebenarnya, yang lebih buruk daripada panic**: saat watcher menukar konfigurasi sementara ratusan handler membacanya, Anda memang WAJIB memakai `atomic.Pointer` atau `sync.RWMutex`. Tetapi alasannya sering dinyatakan keliru: **baca/tulis pointer secara simultan di Go BUKAN panic.** Yang panic adalah akses map secara konkuren (`concurrent map writes`); race pada pointer atau struct adalah *undefined behavior* yang diam.

   Dan diamnya itulah masalahnya. `Config` adalah struct multi-kata, sehingga penyalinan tanpa sinkronisasi bisa menghasilkan **nilai robek** — gabungan sebagian field lama dan sebagian field baru. Yang Anda dapat bukan crash yang jelas, melainkan koneksi dengan **username baru dan kata sandi lama**, yang gagal autentikasi secara acak dan terlihat seperti masalah jaringan. Panic akan jauh lebih mudah didiagnosis.
2. **Koneksi Mati & EOF vs Lease Expiry**: Kredensial Vault aktif selama 60 menit. Di golang database connection pool, anda punya setting `SetConnMaxLifetime`. Jika `SetConnMaxLifetime` Anda disetel selama 70 menit, aplikasi Go akan me-reuse koneksi yang *sudah ditutup Vault secara sepihak*. Anda akan mendapat banyak error `EOF` acak di production. Set `SetConnMaxLifetime` di Go **lebih kecil** daripada TTL lease Vault (e.g. 50 Menit).
3. **Vault Down saat Bootstrap**: bila Vault Agent telat menyala, aplikasi membaca JSON dan mendapat *file not found*, lalu masuk CrashLoop. Tangani dengan retry-backoff atau tunggu berkasnya muncul. Perhatikan perbedaannya dengan butir berikutnya: gagal saat **bootstrap** memang harus mencegah proses menyala; gagal saat **rotasi** tidak boleh menjatuhkan proses yang sudah sehat.

4. **Pemuatan ulang yang tidak divalidasi lebih berbahaya daripada tidak memuat ulang.** Urutannya menentukan segalanya. Bila konfigurasi ditukar lebih dulu dan hook penerapan dijalankan sesudahnya, maka saat kredensial baru ternyata belum aktif di sisi basis data, konfigurasi yang **sudah diketahui salah** terlanjur terpasang — dan yang lama, yang masih bekerja, sudah hilang. Terapkan dulu (buka pool baru, `Ping`), tukar hanya bila berhasil, dan **pertahankan yang lama** bila gagal.

5. **Pool lama tidak boleh ditutup seketika.** Diagram di §2 menggambarkan "Old SQL.DB Pool (Closing...)" berdampingan dengan pool baru yang aktif, dan jeda itu bukan hiasan: `Close()` yang dipanggil tepat setelah penukaran memutus query yang sedang berjalan di tengah jalan. Tukar pointer-nya dulu agar permintaan baru memakai pool baru, lalu tutup yang lama setelah jeda selebar timeout permintaan terpanjang Anda.

## 5. Production-Ready Go Code

Implementasi arsitektur aman mencegah *Memory Dump leak* serta sistem Hot-Swap konfigurasi dan database tanpa mematikan layanan (Zero Downtime).

```go
package secret

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"
)

const disamarkan = "[REDACTED-SECRET]"

// SecretString mencegah rahasia bocor lewat FORMATTING dan SERIALISASI.
//
// Batas kemampuannya harus dinyatakan jujur: ia **tidak** melindungi dari
// memory dump. Nilai `string` di Go tidak bisa dinolkan — ia immutable,
// dikelola GC, dan bisa disalin diam-diam saat objeknya dipindahkan. Menyebut
// tipe ini "pencegah memory dump leak" menjanjikan sesuatu yang tidak
// diberikannya. Yang benar-benar dicegahnya adalah kebocoran TAK SENGAJA
// lewat log, respons API, dan pesan galat — dan justru itulah bentuk sebagian
// besar kebocoran rahasia yang benar-benar terjadi.
type SecretString string

// String menangani %v, %s, dan %q.
func (s SecretString) String() string { return disamarkan }

// GoString menangani %#v — dan inilah yang HILANG dari versi sebelumnya.
//
// fmt tidak memanggil String() untuk %#v; ia memakai refleksi dan mencetak
// nilai mentahnya. Verb itu justru yang paling sering diketik orang ketika
// sedang men-debug sebuah struct, sehingga celahnya terbuka persis pada saat
// ia paling mungkin dipakai.
func (s SecretString) GoString() string { return `"` + disamarkan + `"` }

// MarshalJSON menangani encoding/json dan slog.JSONHandler.
func (s SecretString) MarshalJSON() ([]byte, error) { return json.Marshal(disamarkan) }

// MarshalText menangani encoder berbasis teks (YAML, env, sebagian handler
// slog) yang memilih TextMarshaler lebih dulu sebelum jatuh ke fmt.
func (s SecretString) MarshalText() ([]byte, error) { return []byte(disamarkan), nil }

// Ungkap adalah SATU-SATUNYA jalan menuju nilai aslinya. Namanya sengaja
// mencolok supaya setiap pemakaiannya menonjol saat code review.
func (s SecretString) Ungkap() string { return string(s) }

// Config diikat dari berkas hasil render Vault Agent.
type Config struct {
	DBHost string       `json:"db_host"`
	DBUser string       `json:"db_user"`
	DBPass SecretString `json:"db_pass"`
}

// DSN mengembalikan SecretString, BUKAN string biasa.
//
// DSN memuat kata sandi di dalam dirinya, dan DSN adalah nilai yang paling
// sering ikut tercetak — di log "menghubungkan ke ...", di pesan galat driver,
// dan di atribut span tracing. Melindungi field kata sandi tetapi membiarkan
// DSN sebagai string telanjang hanya memindahkan kebocoran satu lapis.
func (c Config) DSN() SecretString {
	return SecretString(fmt.Sprintf("host=%s user=%s password=%s sslmode=verify-full",
		c.DBHost, c.DBUser, c.DBPass.Ungkap()))
}

// galatTersamar menyembunyikan rahasia dari pesan galat TANPA memutus rantai
// errors.Is/errors.As — mengganti galat dengan errors.New yang baru akan
// menghilangkan kemampuan pemanggil memeriksa jenis galatnya.
type galatTersamar struct {
	pesan string
	asal  error
}

func (g galatTersamar) Error() string { return g.pesan }
func (g galatTersamar) Unwrap() error { return g.asal }

func samarkan(err error, cfg Config) error {
	rahasia := cfg.DBPass.Ungkap()
	if err == nil || rahasia == "" {
		return err
	}
	return galatTersamar{pesan: strings.ReplaceAll(err.Error(), rahasia, disamarkan), asal: err}
}

// BukaPool membuka pool dan MEMBUKTIKAN kredensialnya bekerja.
//
// Kasus Tepi 2: bila SetConnMaxLifetime lebih panjang dari TTL lease Vault,
// Go memakai ulang koneksi yang sudah dicabut Vault dari sisi server, dan
// gejalanya adalah galat `EOF` acak yang nyaris mustahil dilacak ke sebabnya.
func BukaPool(ctx context.Context, cfg Config, ttlLease time.Duration) (*sql.DB, error) {
	db, err := sql.Open("pgx", cfg.DSN().Ungkap())
	if err != nil {
		return nil, fmt.Errorf("failed to open pool for host %s: %w", cfg.DBHost, samarkan(err, cfg))
	}

	db.SetConnMaxLifetime(ttlLease * 3 / 4) // margin sebelum lease dicabut
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(25)

	pingCtx, batal := context.WithTimeout(ctx, 5*time.Second)
	defer batal()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("new credentials cannot be used: %w", samarkan(err, cfg))
	}
	return db, nil
}

// Terapkan menerima konfigurasi baru dan harus MEMBUKTIKAN bahwa ia bekerja.
// Nilai kembaliannya menjadi sumber daya aktif yang baru.
type Terapkan func(ctx context.Context, cfg Config) (*sql.DB, error)

type ConfigManager struct {
	config    atomic.Pointer[Config]
	pool      atomic.Pointer[sql.DB]
	terapkan  Terapkan
	jedaTutup time.Duration
}

// NewConfigManager memasang konfigurasi awal, dan GAGAL bila konfigurasi itu
// tidak bisa diterapkan — lebih baik proses tidak pernah menyala daripada
// menyala dengan kredensial yang tidak berfungsi.
//
// Terapkan diterima di konstruktor, bukan sebagai field publik yang bisa
// ditugaskan belakangan. Field publik yang ditulis setelah konstruksi dan
// dibaca dari goroutine watcher adalah data race yang menunggu terjadi.
func NewConfigManager(ctx context.Context, awal Config, terapkan Terapkan, jedaTutup time.Duration) (*ConfigManager, error) {
	cm := &ConfigManager{terapkan: terapkan, jedaTutup: jedaTutup}
	if err := cm.Muat(ctx, awal); err != nil {
		return nil, err
	}
	return cm, nil
}

// Muat memasang konfigurasi baru HANYA bila penerapannya berhasil.
//
// Urutan inilah yang terbalik pada versi sebelumnya: config ditukar lebih
// dulu, hook dijalankan sesudahnya. Ketika hook gagal — kredensial baru dari
// Vault ternyata belum aktif, atau basis data menolaknya — konfigurasi yang
// SUDAH DIKETAHUI SALAH terlanjur terpasang dan yang lama, yang masih bekerja
// dengan baik, sudah hilang. Setiap permintaan sesudahnya memakai kredensial
// buruk itu, dan tidak ada jalan mundur.
func (cm *ConfigManager) Muat(ctx context.Context, baru Config) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("context canceled before loading: %w", err)
	}

	poolBaru, err := cm.terapkan(ctx, baru)
	if err != nil {
		// Konfigurasi lama DIPERTAHANKAN.
		slog.ErrorContext(ctx, "new configuration rejected, retaining old one", "error", err)
		return fmt.Errorf("failed to apply new configuration: %w", err)
	}

	lama := cm.pool.Swap(poolBaru)
	cm.config.Store(&baru)

	if lama != nil {
		// Pool lama TIDAK ditutup seketika. Query yang sedang berjalan masih
		// memegang koneksinya. Ditutup setelah jeda, saat permintaan yang
		// sudah terlanjur dimulai sudah selesai.
		go func() {
			time.Sleep(cm.jedaTutup)
			if err := lama.Close(); err != nil {
				slog.Error("failed to close old pool", "error", err)
			}
		}()
	}
	return nil
}

func (cm *ConfigManager) GetConfig() Config { return *cm.config.Load() }
func (cm *ConfigManager) DB() *sql.DB       { return cm.pool.Load() }
```

```go
package secret

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

const sandiUji = "REAL_DATABASE_PASSWORD_XYZ"

func TestRahasiaTidakBocorLewatFormat(t *testing.T) {
	cfg := Config{DBHost: "postgres.int", DBUser: "vault-role", DBPass: sandiUji}

	// Setiap jalur keluar diuji terpisah. Versi sebelumnya hanya menguji %v
	// dan json.Marshal — dan %#v, verb yang paling sering diketik saat
	// men-debug struct, LOLOS membawa kata sandi apa adanya.
	jsonBytes, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	teksBytes, err := cfg.DBPass.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}

	jalur := map[string]string{
		"%v":            fmt.Sprintf("%v", cfg),
		"%+v":           fmt.Sprintf("%+v", cfg),
		"%s":            fmt.Sprintf("%s", cfg.DBPass),
		"%q":            fmt.Sprintf("%q", cfg.DBPass),
		"%#v":           fmt.Sprintf("%#v", cfg),
		"json.Marshal":  string(jsonBytes),
		"MarshalText":   string(teksBytes),
		"DSN":           fmt.Sprintf("%v", cfg.DSN()),
	}
	for nama, keluaran := range jalur {
		if strings.Contains(keluaran, sandiUji) {
			t.Errorf("LEAKED via %s: %s", nama, keluaran)
		}
		if !strings.Contains(keluaran, disamarkan) {
			t.Errorf("%s does not contain redaction marker: %s", nama, keluaran)
		}
	}
}

func TestGalatDisamarkanTanpaMemutusRantai(t *testing.T) {
	cfg := Config{DBPass: sandiUji}
	asal := errors.New("connection failed: password=" + sandiUji)
	tersamar := samarkan(asal, cfg)

	if strings.Contains(tersamar.Error(), sandiUji) {
		t.Fatalf("password is still present in error message: %s", tersamar)
	}
	// errors.Is harus tetap bekerja — penyamaran tidak boleh menghapus
	// kemampuan pemanggil memeriksa jenis galat.
	if !errors.Is(tersamar, asal) {
		t.Fatal("error chain broken by redaction")
	}
}

// Konfigurasi yang penerapannya GAGAL tidak boleh menggantikan yang sehat.
func TestKonfigurasiBurukTidakMenggantikanYangSehat(t *testing.T) {
	ctx := context.Background()
	gagalkan := false
	terapkan := func(context.Context, Config) (*sql.DB, error) {
		if gagalkan {
			return nil, errors.New("credentials rejected by database")
		}
		return nil, nil // pool nil cukup untuk uji ini
	}

	cm, err := NewConfigManager(ctx, Config{DBUser: "v_1"}, terapkan, time.Millisecond)
	if err != nil {
		t.Fatalf("NewConfigManager: %v", err)
	}

	gagalkan = true
	if err := cm.Muat(ctx, Config{DBUser: "v_2"}); err == nil {
		t.Fatal("configuration that failed to apply was accepted")
	}
	if got := cm.GetConfig().DBUser; got != "v_1" {
		t.Fatalf("DBUser = %q after failed load, expected v_1 — bad credentials installed and healthy ones lost", got)
	}
}

// Uji yang benar-benar konkuren. Versi sebelumnya bernama
// "RaceConditionSafe" tetapi seluruhnya berjalan di satu goroutine, sehingga
// `go test -race` tidak punya apa pun untuk diperiksa.
func TestPembacaanKonkurenSaatRotasi(t *testing.T) {
	ctx := context.Background()
	terapkan := func(context.Context, Config) (*sql.DB, error) { return nil, nil }

	cm, err := NewConfigManager(ctx, Config{DBUser: "v_0"}, terapkan, time.Millisecond)
	if err != nil {
		t.Fatalf("NewConfigManager: %v", err)
	}

	var wg sync.WaitGroup
	berhenti := make(chan struct{})

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-berhenti:
					return
				default:
					if cm.GetConfig().DBUser == "" {
						t.Error("configuration read as empty during rotation")
						return
					}
				}
			}
		}()
	}

	for i := 1; i <= 50; i++ {
		if err := cm.Muat(ctx, Config{DBUser: fmt.Sprintf("v_%d", i)}); err != nil {
			t.Errorf("load attempt %d: %v", i, err)
		}
	}
	close(berhenti)
	wg.Wait()
}
```

## Kapan JANGAN Pakai Ini

- **Vault tanpa identitas beban kerja yang bisa dibuktikan.** Tanpa cara memverifikasi siapa yang meminta, Anda hanya memindahkan rahasia ke tempat lain — dan menambahkan satu token statis yang membuka semuanya.
- **Mengambil rahasia sekali saat start lalu menyimpannya selamanya.** Rotasi menjadi tidak berarti: proses lama tetap memakai kredensial lama sampai di-restart, dan tidak ada yang tahu proses mana yang masih memegang apa.
- **Vault sebagai dependensi keras di jalur panas.** Vault yang tidak terjangkau tidak boleh langsung mematikan layanan yang sudah berjalan. Cache dengan masa berlaku, dan perbarui di latar.
- **Rahasia di variabel lingkungan pod.** Ia terlihat di `kubectl describe`, di dump proses, dan sering ikut terkirim ke sistem pelaporan galat pihak ketiga tanpa disadari.
- **Rotasi tanpa periode tumpang tindih.** Kredensial lama WAJIB tetap berlaku sampai semua konsumen mengambil yang baru. Tanpa itu, rotasi adalah pemadaman terjadwal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Rahasia terlihat di `kubectl describe pod` | sumber variabel lingkungan | Rahasia disuntikkan sebagai env biasa |
| Layanan mati saat Vault bermasalah | penanganan galat pengambilan rahasia | Vault jadi dependensi keras |
| Rotasi tidak berefek sampai restart | apakah rahasia diperbarui berkala | Diambil sekali saat start |
| Token Vault tidak pernah kedaluwarsa | TTL token | Token statis; kompromi berarti akses permanen |
| Rahasia ditemukan di riwayat git | `git log` pada berkas konfigurasi | Menghapus berkasnya tidak menghapus riwayatnya |
| Rahasia muncul di log padahal tipenya `SecretString` | verb format yang dipakai | `%#v` tidak memanggil `String()`; butuh `GoString()` |
| Kata sandi terlihat di pesan galat driver | apakah galat disamarkan sebelum keluar | Kode Anda tidak mencetaknya — pustaka pihak ketiga yang mencetaknya |
| Autentikasi DB gagal acak setelah rotasi | urutan tukar-config vs uji koneksi | Konfigurasi buruk terpasang, yang sehat sudah hilang |
| Galat `EOF` acak beberapa menit sekali | `SetConnMaxLifetime` vs TTL lease | Koneksi yang sudah dicabut Vault dipakai ulang |

```bash
# Rahasia yang terlihat sebagai env -- setiap baris di sini adalah temuan
kubectl describe pod <pod> | grep -A25 'Environment:'
kubectl get secrets -o json | jq -r '.items[] | "\(.metadata.name) \(.type)"'

# TTL token dan kapan rahasia terakhir dirotasi
vault token lookup
vault kv metadata get secret/app/database

# Riwayat git menyimpan rahasia meski berkasnya sudah dihapus
git log --all -p | grep -EC1 'sk_live_|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}' | head
git ls-files | grep -E '\.env$|credentials|\.pem$'
```
