# Testcontainers untuk Integration Testing di Go

> **Berlaku:** Go 1.21+ · `testcontainers-go` v0.30+ · Docker · **Lihat juga:** `testing_quality/e2e_testing_patterns.md` · `db_sqlc/database_migration_go.md` · `db_sqlc/sqlc_pgx_driver.md` · `testing_quality/mocking_interfaces.md`

`testcontainers-go` menyediakan API untuk spin-up container Docker *disposable* langsung dari kode Go. Ini memungkinkan integration test yang menguji interaksi nyata dengan PostgreSQL, Redis, Kafka — tanpa setup manual, tanpa port conflict, tanpa state pollution antar test.

---

## 1. Arsitektur Testcontainers

```
Test Code (Go)
     │
     ▼
testcontainers-go (Docker API Client via DOCKER_HOST)
     │
     ├── GenericContainer → custom image apa pun
     ├── postgres.Run()   → Module khusus PostgreSQL (recommended)
     ├── redis.Run()      → Module khusus Redis
     └── kafka.Run()      → Module khusus Kafka

Container Lifecycle:
  TestMain.Setup  → Container.Start()         ← shared container (1x per package)
       │
  Test functions  → parallel queries          ← tiap test pakai schema terpisah
       │
  TestMain.Teardown → Container.Terminate()  ← cleanup setelah semua test

Ryuk (Garbage Collector):
  testcontainers-go auto-spawn container "ryuk" yang memantau dan
  membersihkan container orphan jika test process crash/killed.
```

**Strategi lifecycle container:**

| Strategi | Setup | Teardown | Trade-off |
|---|---|---|---|
| **Per-Test** | `TestXxx` → start | `t.Cleanup` → terminate | Isolasi sempurna, lambat (N containers) |
| **Per-Package** (recommended) | `TestMain` → start | `TestMain` → terminate | Cepat (1 container), butuh schema isolation |
| **External** | Manual (docker-compose) | Manual | Cocok untuk CI complex |

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// --- Shared Container untuk Per-Package Strategy ---

// pgContainer menyimpan shared container.
//
// Tipe modulnya dipertahankan (bukan testcontainers.Container generik) supaya
// ConnectionString bisa dipanggil ulang per uji dengan parameter tambahan —
// itu yang membuat isolasi skema benar-benar bekerja. Lihat openDB.
type pgContainer struct {
	container *postgres.PostgresContainer
}

// sharedPG adalah package-level shared container (diinisialisasi di TestMain).
var sharedPG *pgContainer

// setupPostgresContainer membuat PostgreSQL container via Module (recommended).
// Lebih mudah dari GenericContainer karena handle env, wait strategy, dsb.
func setupPostgresContainer(ctx context.Context) (*pgContainer, error) {
	pgCtr, err := postgres.Run(ctx,
		"postgres:16-alpine",
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2). // postgres log ini muncul 2x saat startup
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("start postgres container: %w", err)
	}
	return &pgContainer{container: pgCtr}, nil
}

// TestMain menginisialisasi shared container sekali untuk semua test di package ini.
func TestMain(m *testing.M) {
	ctx := context.Background()

	var err error
	sharedPG, err = setupPostgresContainer(ctx)
	if err != nil {
		// Docker tidak tersedia. Perhatikan yang TIDAK dilakukan di sini:
		// keluar dengan os.Exit(0).
		//
		// Versi sebelumnya melakukannya, dengan komentar "m.Run() dengan 0
		// test = exit 0" — padahal m.Run() tidak pernah dipanggil sama
		// sekali. `go test` melaporkan **ok** untuk paket ini, dan seluruh
		// suite integrasi lewat begitu saja tanpa satu uji pun berjalan.
		// Di CI tanpa Docker, itu berarti gerbang integrasi Anda hijau
		// selamanya tanpa pernah menguji apa pun.
		//
		// Uji-uji di bawah SUDAH punya penjaga `if sharedPG == nil { t.Skip }`.
		// Menjalankan m.Run() membuat penjaga itu bekerja dan menghasilkan
		// keluaran SKIP yang terlihat — bukan PASS yang menipu.
		fmt.Fprintf(os.Stderr, "PERINGATAN: testcontainers gagal disiapkan: %v\n", err)
	}

	kode := m.Run()

	if sharedPG != nil {
		if err := sharedPG.container.Terminate(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "PERINGATAN: gagal menghentikan container: %v\n", err)
		}
	}
	os.Exit(kode)
}

var penghitungSkema atomic.Uint64

// namaSkema menghasilkan identifier unik yang MUAT dalam batas 63 karakter.
//
// Bagian uniknya ditaruh di DEPAN dan tidak pernah terpotong. Versi
// sebelumnya menyusun `test_<nama>_<unixnano>` lalu memotong seluruh string
// pada 63 karakter — dan pemotongan itu membuang justru stempel waktunya,
// sehingga dua uji bernama panjang dengan awalan sama memperoleh skema yang
// IDENTIK dan isolasinya lenyap tanpa gejala apa pun.
func namaSkema(t *testing.T) string {
	awalan := fmt.Sprintf("t%d_%d_", time.Now().UnixNano(), penghitungSkema.Add(1))
	bersih := sanitizeIdentifier(t.Name())
	if sisa := 63 - len(awalan); len(bersih) > sisa {
		bersih = bersih[:sisa]
	}
	return awalan + bersih
}

// openDB membuka pool DB yang benar-benar terisolasi per uji.
func openDB(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	skema := namaSkema(t)

	// Skema dibuat lewat koneksi terpisah yang langsung ditutup.
	admin, err := sql.Open("postgres", connStr(t))
	require.NoError(t, err, "buka koneksi admin")
	defer admin.Close()
	_, err = admin.ExecContext(ctx,
		fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", pq.QuoteIdentifier(skema)))
	require.NoError(t, err, "buat skema uji")

	// search_path dipasang di CONNECTION STRING, bukan lewat `SET`.
	//
	// Ini koreksi terpenting di berkas ini. `SET search_path` bersifat
	// per-SESI, sementara *sql.DB adalah POOL: pernyataan itu hanya berlaku
	// pada koneksi yang kebetulan dipakai Exec, dan query berikutnya bisa
	// mendapat koneksi LAIN yang search_path-nya masih `public`. Isolasi
	// skema yang dijanjikan bagian ini karena itu hanya bekerja secara
	// kebetulan — dan gagalnya acak, tepat ketika uji dijalankan paralel,
	// yaitu satu-satunya keadaan yang membuat isolasi itu diperlukan.
	db, err := sql.Open("postgres", connStr(t, "search_path="+skema))
	require.NoError(t, err, "buka pool uji")

	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("tutup pool: %v", err)
		}
		bersih, err := sql.Open("postgres", connStr(t))
		if err != nil {
			t.Errorf("buka koneksi pembersih: %v", err)
			return
		}
		defer bersih.Close()
		// Galat DROP tidak boleh dibuang: skema yang gagal dihapus menumpuk
		// lintas eksekusi sampai basis data uji penuh.
		if _, err := bersih.ExecContext(ctx,
			fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", pq.QuoteIdentifier(skema))); err != nil {
			t.Errorf("hapus skema %s: %v", skema, err)
		}
	})

	return db
}

func connStr(t *testing.T, args ...string) string {
	t.Helper()
	s, err := sharedPG.container.ConnectionString(context.Background(),
		append([]string{"sslmode=disable"}, args...)...)
	require.NoError(t, err, "bangun connection string")
	return s
}

// sanitizeIdentifier membersihkan nama menjadi identifier PostgreSQL yang valid.
//
// Huruf besar di-LOWERCASE, bukan diganti garis bawah: `TestUserRepo_CRUD`
// menjadi `testuserrepo_crud` yang masih terbaca, bukan `t___________crud`
// yang tidak memberi tahu apa pun saat Anda memeriksa daftar skema tertinggal.
func sanitizeIdentifier(name string) string {
	hasil := make([]byte, 0, len(name))
	for _, c := range []byte(name) {
		switch {
		case c >= 'A' && c <= 'Z':
			hasil = append(hasil, c+('a'-'A'))
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_':
			hasil = append(hasil, c)
		default:
			hasil = append(hasil, '_')
		}
	}
	return string(hasil)
}

// --- Repository & Integration Tests ---

// UserRepository adalah repository yang menggunakan SQL real.
type UserRepository struct {
	db *sql.DB
}

// NewUserRepository membuat tabel dan repository.
func NewUserRepository(ctx context.Context, db *sql.DB) (*UserRepository, error) {
	_, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS users (
			id       BIGSERIAL PRIMARY KEY,
			username VARCHAR(255) UNIQUE NOT NULL,
			email    VARCHAR(255) NOT NULL,
			active   BOOLEAN NOT NULL DEFAULT true,
			created  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("create users table: %w", err)
	}
	return &UserRepository{db: db}, nil
}

// CreateUser menyisipkan user baru dan mengembalikan ID yang digenerate.
func (r *UserRepository) CreateUser(ctx context.Context, username, email string) (int64, error) {
	var id int64
	err := r.db.QueryRowContext(ctx,
		`INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
		username, email,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create user %q: %w", username, err)
	}
	return id, nil
}

// GetUser mengambil user berdasarkan ID.
func (r *UserRepository) GetUser(ctx context.Context, id int64) (*UserData, error) {
	var u UserData
	err := r.db.QueryRowContext(ctx,
		`SELECT id, username, active FROM users WHERE id = $1`,
		id,
	).Scan(&u.ID, &u.Username, &u.Active)
	if err != nil {
		return nil, fmt.Errorf("get user %d: %w", id, err)
	}
	return &u, nil
}

// TestUserRepository_CRUD adalah integration test end-to-end terhadap PostgreSQL nyata.
func TestUserRepository_CRUD(t *testing.T) {
	if sharedPG == nil {
		t.Skip("no docker available")
	}

	ctx := context.Background()
	db := openDB(t) // schema isolation per test

	repo, err := NewUserRepository(ctx, db)
	require.NoError(t, err)

	t.Run("create and get user", func(t *testing.T) {
		id, err := repo.CreateUser(ctx, "alice", "alice@example.com")
		require.NoError(t, err)
		assert.Greater(t, id, int64(0))

		user, err := repo.GetUser(ctx, id)
		require.NoError(t, err)
		assert.Equal(t, "alice", user.Username)
		assert.True(t, user.Active)
	})

	t.Run("username ganda menghasilkan galat", func(t *testing.T) {
		_, err := repo.CreateUser(ctx, "bob", "bob@example.com")
		require.NoError(t, err)

		_, err = repo.CreateUser(ctx, "bob", "bob2@example.com") // ganda!
		require.Error(t, err)

		// Diperiksa lewat KODE SQLSTATE, bukan teks pesannya.
		//
		// `assert.Contains(err.Error(), "duplicate")` bergantung pada
		// `lc_messages` server: pada PostgreSQL dengan locale non-Inggris,
		// pesannya berbunyi lain dan uji gagal karena bahasa, bukan karena
		// perilaku. Kode 23505 sama di semua locale dan semua versi.
		var pgErr *pq.Error
		require.ErrorAs(t, err, &pgErr)
		assert.Equal(t, pq.ErrorCode("23505"), pgErr.Code, "unique_violation")
	})

	t.Run("get non-existent user returns error", func(t *testing.T) {
		_, err := repo.GetUser(ctx, 99999999)
		require.Error(t, err)
	})
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Hardcoding Host Port Mapping

```go
// BAD: bind ke port spesifik di host — conflict jika CI paralel
req := testcontainers.ContainerRequest{
    ExposedPorts: []string{"5432:5432/tcp"}, // port 5432 sudah dipakai!
}

// GOOD: biarkan Docker pilih ephemeral port acak
req := testcontainers.ContainerRequest{
    ExposedPorts: []string{"5432/tcp"}, // random ephemeral port
}
// Dapatkan port yang di-assign:
port, _ := container.MappedPort(ctx, "5432")
connStr := fmt.Sprintf("host=localhost port=%s ...", port.Port())
```

**Kenapa berbahaya:** Jika dua build pipeline berjalan paralel di mesin yang sama, keduanya mencoba bind ke port yang sama → `address already in use` → test gagal secara non-deterministic.

### ❌ Anti-Pattern 2: Shared Database State Antar Test (tanpa Schema Isolation)

```go
// BAD: semua test pakai schema "public" yang sama
// Test A insert user "alice" → Test B mencoba insert "alice" lagi → UNIQUE constraint error!
func TestA(t *testing.T) {
    db.Exec("INSERT INTO users (name) VALUES ('alice')")
}
func TestB(t *testing.T) {
    db.Exec("INSERT INTO users (name) VALUES ('alice')") // GAGAL jika A berjalan lebih dulu
}

// GOOD: setiap test dapat schema uniknya sendiri (lihat openDB() di atas)
func TestA(t *testing.T) {
    db := openDB(t) // schema unik, dipasang lewat connection string
    // State terisolasi — tidak terpengaruh test lain
}
```

**Dan satu jebakan yang membuat isolasi ini palsu.** Cara yang paling sering ditulis untuk memasang skema adalah:

```go
// BAD: SET bersifat per-SESI, *sql.DB adalah POOL
db, _ := sql.Open("postgres", connStr)
db.Exec(`SET search_path TO ` + skema) // hanya berlaku pada SATU koneksi
```

`*sql.DB` bukan koneksi, melainkan kumpulan koneksi. `SET` di atas berlaku pada koneksi mana pun yang kebetulan diambil `Exec`, lalu dikembalikan ke pool; query berikutnya bisa memperoleh koneksi **lain** yang `search_path`-nya masih `public`. Isolasinya bekerja secara kebetulan — sebagian query mendarat di skema uji, sebagian di `public` — dan gagalnya acak, tepat ketika uji dijalankan paralel, yaitu satu-satunya keadaan yang membuat isolasi itu diperlukan.

```go
// GOOD: skema jadi bagian dari connection string, sehingga SETIAP koneksi
// di pool itu membukanya dengan search_path yang benar.
db, _ := sql.Open("postgres", connStr+"&search_path="+skema)
```

Alternatif yang juga benar bila Anda memang butuh `SET`: `db.SetMaxOpenConns(1)`, atau ambil satu `*sql.Conn` lewat `db.Conn(ctx)` dan pakai koneksi itu saja sepanjang uji.

**Kenapa berbahaya:** Test yang tidak terisolasi state-nya menjadi order-dependent. Test berjalan sendiri lulus, tapi gagal saat dijalankan bersama test lain. Sangat sulit di-debug.

### ❌ Anti-Pattern 3: Tidak Ada Docker Availability Check

```go
// BAD: panic atau error buram jika Docker tidak tersedia di lingkungan CI
func TestIntegration(t *testing.T) {
    ctr, err := postgres.Run(ctx, "postgres:16")
    require.NoError(t, err) // panic/fail dengan pesan tidak jelas jika Docker mati

// GOOD: skip gracefully jika Docker tidak tersedia
func TestIntegration(t *testing.T) {
    if os.Getenv("DOCKER_HOST") == "" && !isDockerAvailable() {
        t.Skip("Docker not available, skipping integration test")
    }
    ctr, err := postgres.Run(ctx, "postgres:16")
    require.NoError(t, err)
}

func isDockerAvailable() bool {
    cli, err := client.NewClientWithOpts(client.FromEnv)
    if err != nil { return false }
    _, err = cli.Ping(context.Background())
    return err == nil
}
```

**Kenapa berbahaya:** Developer yang tidak punya Docker Desktop (atau di CI environment tertentu) mendapat error yang membingungkan. Test seharusnya skip, bukan fail.

---

## 4. Edge Cases & Defensive Programming

1. **Ryuk Container Disabled di CI:** Beberapa CI environment (Kubernetes-based) tidak mengizinkan container tambahan. Jika `TESTCONTAINERS_RYUK_DISABLED=true`, container orphan tidak akan dibersihkan otomatis setelah test crash — pastikan selalu ada cleanup eksplisit di `TestMain`.

2. **Race Condition pada Container Readiness:** `wait.ForListeningPort` hanya mengecek bahwa port terbuka, bukan bahwa PostgreSQL benar-benar siap menerima query. Gunakan `wait.ForLog("database system is ready to accept connections").WithOccurrence(2)` untuk memastikan PostgreSQL fully initialized (log muncul 2x: saat init + saat siap).

3. **`postgres.Run` vs `GenericContainer`:** Module `postgres.Run()` secara otomatis menangani env vars, wait strategy, dan connection string. Untuk image custom atau kebutuhan spesifik, gunakan `GenericContainer` dengan kontrol penuh. Jangan re-implementasi `postgres.Run` secara manual.

4. **Multi-Container Networking:** Jika test membutuhkan App → Redis → PostgreSQL dalam 1 test, buat Docker Network eksplisit dan gunakan Network Alias antar container. Tanpa network alias, container tidak bisa berkomunikasi satu sama lain.

5. **TestMain tidak dijalankan saat test file di-run langsung:** `go test -run=TestXxx ./path/to/pkg` tetap menjalankan `TestMain`. Namun jika ada test di multiple package, `TestMain` hanya berlaku untuk package-nya sendiri — setiap package membutuhkan `TestMain` atau helper setup-nya masing-masing.

## Kapan JANGAN Pakai Ini

- **Untuk logika yang tidak menyentuh infrastruktur.** Menyalakan PostgreSQL demi menguji satu fungsi validasi adalah tiga detik yang terbuang setiap kali uji dijalankan — dikalikan ratusan kali sehari.
- **Satu container per uji.** Waktu start container mendominasi total durasi. Bagi satu container untuk seluruh paket, lalu isolasi antar uji dengan schema terpisah atau transaksi yang selalu di-rollback.
- **Di CI yang tidak menyediakan Docker.** Uji akan gagal dengan pesan yang menyesatkan. Periksa ketersediaan Docker di awal dan `t.Skip` secara eksplisit — kegagalan yang jujur lebih baik daripada kegagalan yang membingungkan.
- **Dengan tag image `latest`.** `postgres:latest` bisa berperilaku berbeda dari `postgres:15.4` yang berjalan di produksi, dan bedanya baru terasa saat rilis. Sematkan versinya persis seperti produksi.
- **Untuk mengejar realisme total.** Container tidak mereplikasi replikasi, failover, latensi jaringan, atau tetangga yang berisik. Ia membuktikan query dan migrasi Anda benar — bukan bahwa sistemnya tahan beban.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Runner CI kehabisan disk | container dan volume yatim | Cleanup tidak berjalan; Ryuk dimatikan atau container tidak di-terminate |
| Suite integrasi sangat lambat | jumlah container yang dibuat | Satu container per uji alih-alih per paket |
| Hijau di laptop, gagal di CI | tag image yang dipakai | `latest` menarik versi berbeda di waktu berbeda |
| Uji saling mengganggu secara acak | isolasi antar uji | Berbagi database tanpa schema atau transaksi terpisah |
| Uji gagal dengan galat koneksi | strategi wait | Container dianggap siap sebelum benar-benar menerima koneksi |

```bash
# Periksa Docker sebelum menjalankan, agar kegagalannya jujur
docker info >/dev/null 2>&1 || echo "Docker tidak tersedia -- uji integrasi akan di-skip"

go test ./... -run=TestIntegration -v -timeout=10m

# Container yatim yang ditinggalkan uji yang gagal di tengah jalan
docker ps -a --filter 'label=org.testcontainers=true'
docker ps -a --filter 'label=org.testcontainers=true' -q | xargs -r docker rm -f
docker volume ls -qf dangling=true | xargs -r docker volume rm

# Uji paling lambat: biasanya yang membuat container sendiri
go test ./... -json | jq -r 'select(.Action=="pass") | "\(.Elapsed) \(.Test)"' | sort -rn | head
```
