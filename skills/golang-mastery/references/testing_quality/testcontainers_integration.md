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
	"testing"
	"time"

	_ "github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// --- Shared Container untuk Per-Package Strategy ---

// pgContainer menyimpan shared container dan connection pool.
type pgContainer struct {
	container testcontainers.Container
	connStr   string
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

	connStr, err := pgCtr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return nil, fmt.Errorf("get connection string: %w", err)
	}

	return &pgContainer{container: pgCtr, connStr: connStr}, nil
}

// TestMain menginisialisasi shared container sekali untuk semua test di package ini.
func TestMain(m *testing.M) {
	ctx := context.Background()

	var err error
	sharedPG, err = setupPostgresContainer(ctx)
	if err != nil {
		// Jika Docker tidak tersedia (CI tanpa Docker), skip semua test gracefully
		fmt.Printf("WARNING: testcontainers setup failed: %v. Skipping integration tests.\n", err)
		// m.Run() dengan 0 test = exit 0
		os.Exit(0)
	}

	// Jalankan semua test
	exitCode := m.Run()

	// Cleanup container setelah semua test selesai
	if err := sharedPG.container.Terminate(ctx); err != nil {
		fmt.Printf("WARNING: container terminate failed: %v\n", err)
	}

	os.Exit(exitCode)
}

// openDB membuka koneksi DB dengan schema isolation per test.
// Tiap test menggunakan schema berbeda → tidak ada state conflict meski parallel.
func openDB(t *testing.T) *sql.DB {
	t.Helper()

	db, err := sql.Open("postgres", sharedPG.connStr)
	require.NoError(t, err, "open DB connection")

	// Schema unik per test untuk isolasi total
	schemaName := fmt.Sprintf("test_%s_%d", t.Name(), time.Now().UnixNano())
	// Sanitize schema name (t.Name() bisa mengandung karakter ilegal)
	schemaName = sanitizeIdentifier(schemaName)

	_, err = db.ExecContext(context.Background(), fmt.Sprintf(`
		CREATE SCHEMA IF NOT EXISTS %q;
		SET search_path TO %q;
	`, schemaName, schemaName))
	require.NoError(t, err, "create test schema")

	t.Cleanup(func() {
		// Drop schema test setelah selesai
		db.ExecContext(context.Background(), fmt.Sprintf(`DROP SCHEMA IF EXISTS %q CASCADE`, schemaName))
		db.Close()
	})

	return db
}

// sanitizeIdentifier membersihkan nama menjadi identifier PostgreSQL yang valid.
func sanitizeIdentifier(name string) string {
	result := make([]byte, 0, len(name))
	for _, c := range []byte(name) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' {
			result = append(result, c)
		} else {
			result = append(result, '_')
		}
	}
	if len(result) > 63 { // PostgreSQL max identifier length
		result = result[:63]
	}
	return string(result)
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

	t.Run("duplicate username returns error", func(t *testing.T) {
		_, err := repo.CreateUser(ctx, "bob", "bob@example.com")
		require.NoError(t, err)

		_, err = repo.CreateUser(ctx, "bob", "bob2@example.com") // duplicate!
		require.Error(t, err)
		// PostgreSQL unique violation error code 23505
		assert.Contains(t, err.Error(), "duplicate")
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
    db := openDB(t) // schema: test_TestA_1234567890
    // State terisolasi — tidak terpengaruh test lain
}
```

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
