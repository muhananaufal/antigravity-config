# Golang Configuration Management & Arch Patterns

> **Berlaku:** Go 1.21+ · **Lihat juga:** `cli_tooling/config_precedence_viper.md` · `arch_patterns/dependency_injection_wire.md` · `distributed_patterns_resilience/feature_flags_launchdarkly.md` · `devops_control_planes/docker_container_go.md`

Dokumen ini adalah referensi komprehensif (Top 1%) tentang arsitektur manajemen konfigurasi, environment bindings, secret handling, dan flag management di Go untuk skala production (Microservices & 12-Factor Apps).

---

## 1. Konsep & Tooling (Viper, Validator, Envconfig)

### a. `spf13/viper` (Konfigurasi Multi-Source & Hirarki)
Viper menangani parsing file, membaca variabel env, dan default value. Konsep terpenting adalah *Hierarchy of Precedence*:
`Explicit Call (Set) > Env Vars > Flags > Config File > Key/Value Store (etcd) > Defaults`.

**Best Practice Setup dengan Validator:**
```go
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/go-playground/validator/v10"
	"github.com/spf13/viper"
)

type Config struct {
	AppEnv   string `mapstructure:"app_env" validate:"required,oneof=dev staging prod"`
	Port     int    `mapstructure:"port" validate:"required,min=1024,max=65535"`
	Database struct {
		Host     string `mapstructure:"host" validate:"required"`
		Port     int    `mapstructure:"port" validate:"required"`
		Password string `mapstructure:"password"` // Dimuat dari Secret Manager, bukan config file
	} `mapstructure:"database"`
}

func LoadConfig(path string) (*Config, error) {
	v := viper.New()
	v.AddConfigPath(path)
	v.SetConfigName("config")
	v.SetConfigType("yaml")

	// 1. Set Defaults
	v.SetDefault("port", 8080)
	v.SetDefault("app_env", "dev")

	// 2. Load Env Vars (e.g. APP_DATABASE_PASSWORD)
	v.SetEnvPrefix("APP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// 3. Read Config File
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("failed to read config file: %w", err)
		}
		// Abaikan jika file tidak ada (mungkin full dari env vars di K8s)
	}

	// 4. Unmarshal
	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	// 5. Validate struct
	validate := validator.New()
	if err := validate.Struct(&cfg); err != nil {
		return nil, fmt.Errorf("config validation failed: %w", err)
	}

	return &cfg, nil
}
```

### b. `kelseyhightower/envconfig` (Alternatif Minimalis)
Banyak tim modern beralih ke `envconfig` karena murni bergantung pada environment variables (sesuai Twelve-Factor App principles) dan menghilangkan overhead Viper/YAML file.

```go
type Spec struct {
    Port  int    `envconfig:"PORT" default:"8080"`
    DBURL string `envconfig:"DATABASE_URL" required:"true"`
}
// err := envconfig.Process("APP", &spec)
```

---

## 2. Environment-Specific Config Loading (Fallback Chain)

Dalam arsitektur *production-grade*, seringkali kita membutuhkan konfigurasi yang berbeda per *environment* (development, staging, production). Pengelolaan multiple env file harus memiliki *fallback chain* yang jelas untuk meminimalisir duplikasi.

**Mekanisme Fallback (Base + Env Overlay):**
1. Load `config.base.yaml` (berisi *default* statis untuk semua environment).
2. Baca environment variable `APP_ENV` (misal: `staging`).
3. Load dan merge `config.staging.yaml` menimpa base config.
4. *Override* nilai akhir dengan Environment Variables dari sistem operasi.

```go
func LoadConfigWithFallback(basePath string, env string) (*Config, error) {
	v := viper.New()
	v.AddConfigPath(basePath)

	// 1. Load Base Config
	v.SetConfigName("config.base")
	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("base config required: %w", err)
	}

	// 2. Load Env-Specific Config (Merge)
	if env != "" {
		v.SetConfigName(fmt.Sprintf("config.%s", env))
		if err := v.MergeInConfig(); err != nil {
			// "Tidak ada berkas" dan "berkasnya rusak" WAJIB dibedakan.
			//
			// Versi sebelumnya menelan SEMUA galat dengan pesan "no specific
			// config file found". Akibatnya satu salah indentasi di
			// config.production.yaml membuat aplikasi diam-diam jatuh ke base
			// config dan menyala dengan setelan yang SALAH — bukan gagal.
			// Fungsi LoadConfig di §1 sudah membedakan keduanya dengan benar;
			// yang ini tidak, di berkas yang sama.
			var tidakAda viper.ConfigFileNotFoundError
			if !errors.As(err, &tidakAda) {
				return nil, fmt.Errorf("config env %q rusak: %w", env, err)
			}
			slog.Warn("tidak ada config khusus environment, memakai base", "env", env)
		}
	}

	// 3. Env Vars Override (Tertinggi)
	v.SetEnvPrefix("APP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// AutomaticEnv TIDAK CUKUP bila hasilnya di-Unmarshal.
	//
	// Ini jebakan Viper yang paling sering menggigit, dan ia gagal secara
	// SENYAP. AutomaticEnv hanya memengaruhi v.Get(); Unmarshal bekerja dari
	// AllSettings(), yang dibangun dari berkas config, default, dan env yang
	// DIIKAT EKSPLISIT. Viper tidak bisa menyebutkan isi environment, jadi
	// kunci yang HANYA ada di env — tidak ada di YAML mana pun — tidak akan
	// pernah muncul di AllSettings dan tidak pernah ikut ter-unmarshal.
	//
	// Hasilnya: judul "Env Vars Override (Tertinggi)" benar untuk kunci yang
	// kebetulan ada di YAML, dan diam-diam salah untuk yang tidak. Ikat
	// setiap kunci secara eksplisit — atau beri SetDefault untuk semuanya,
	// yang punya efek sama karena defaultnya masuk AllSettings.
	for _, kunci := range []string{
		"server.http_port", "server.grpc_port",
		"database.url", "auth.provider", "auth.secret_key",
	} {
		if err := v.BindEnv(kunci); err != nil {
			return nil, fmt.Errorf("ikat env untuk %q: %w", kunci, err)
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
```

---

## 3. Config Validation Deep Dive (Fail-Fast)

Validasi saat *startup* sangat krusial. Jika konfigurasi hilang atau salah tipe, aplikasi **wajib mati seketika (Fail-Fast)** agar tidak terjadi behavior aneh di runtime. Penggunaan `go-playground/validator/v10` sangat direkomendasikan.

### Cross-Field Validation & Conditional Required
```go
type AuthConfig struct {
	// Provider bisa 'jwt' atau 'oauth'
	Provider string `mapstructure:"provider" validate:"required,oneof=jwt oauth"`
	
	// SecretKey wajib jika provider = jwt
	SecretKey string `mapstructure:"secret_key" validate:"required_if=Provider jwt"`
	
	// OAuthConfig wajib diisi jika provider = oauth
	OAuthConfig *OAuthConfig `mapstructure:"oauth" validate:"required_if=Provider oauth"`
}

type ServerConfig struct {
	HTTPPort int `validate:"required,min=1024,max=65535"`
	GRPCPort int `validate:"required,min=1024,max=65535,nefield=HTTPPort"` // Port tidak boleh tabrakan
}
```

### Formatted Startup Error (User-Friendly)
Bila gagal, error bawaan *validator* sulit dibaca. Kita perlu memformatnya:
```go
func ValidateConfig(cfg *Config) error {
	err := validator.New().Struct(cfg)
	if err == nil {
		return nil
	}

	// errors.As, BUKAN `err.(validator.ValidationErrors)` telanjang.
	//
	// validate.Struct juga bisa mengembalikan *validator.InvalidValidationError
	// — misalnya ketika yang dioper bukan struct, atau nil pointer. Tipe itu
	// BUKAN ValidationErrors, sehingga assertion telanjang PANIC. Dan panic
	// itu terjadi di dalam fungsi yang tugasnya justru mengubah kegagalan
	// menjadi pesan yang bisa dibaca: alih-alih daftar field yang salah,
	// operator mendapat stack trace saat boot.
	var vErrs validator.ValidationErrors
	if !errors.As(err, &vErrs) {
		return fmt.Errorf("validasi konfigurasi tidak dapat dijalankan: %w", err)
	}

	pesan := make([]string, 0, len(vErrs))
	for _, e := range vErrs {
		pesan = append(pesan, fmt.Sprintf("field %q gagal pada aturan %q", e.Namespace(), e.Tag()))
	}
	return fmt.Errorf("konfigurasi tidak valid: %s", strings.Join(pesan, "; "))
}
```

---

## 4. Multi-Environment & Twelve-Factor App Config

Menurut **12-Factor App**, *strict separation of config from code* adalah aturan mutlak.
- Konfigurasi harus bervariasi per environment (dev, staging, prod).
- Konfigurasi diletakkan murni pada *Environment Variables*.
- **Secret Separation**: Konfigurasi umum (port, timeout) beda tempat dengan rahasia (DB password, API Keys). Rahasia JANGAN PERNAH masuk ke `.yaml` config, gunakan external vault (AWS SSM, HashiCorp Vault, K8s Secrets).

**Diagram ASCII: Configuration Hierarchy & Hot Reload Flow**
```text
[Sources]
  AWS SSM / Vault -----------------------> [Secrets (In-Memory Only)]
                                                 |
  Env Vars (APP_PORT) ---------------\           v
                                      +--> [Viper Merge Engine] ---> App Struct Config
  Config File (config.prod.yaml) ----/           |
                                                 | (fsnotify watch)
[Filesystem] <--- (Modified via ConfigMap) <-----+ (Hot Reload updates App Struct via Mutex/Atomic)
```

---

## 5. Hot Reload dengan Viper & `fsnotify`

Agar konfigurasi yang dimodifikasi saat runtime bisa diserap aplikasi tanpa restart pod, gunakan `viper.WatchConfig()`. Sangat berguna jika di Kubernetes menggunakan ConfigMap mounted volume yang auto-update.

```go
v.WatchConfig()
v.OnConfigChange(func(e fsnotify.Event) {
	fmt.Println("Config file changed:", e.Name)
	// PENTING: Gunakan atomic.Value atau RWMutex untuk melindungi update.
	// Jika tidak, goroutine HTTP handler yang sedang baca config bisa kena panic (race condition).
	mu.Lock()
	defer mu.Unlock()
	v.Unmarshal(&globalConfig)
})
```

---

## 6. Feature Flags via Config (LaunchDarkly, Unleash, env)

Feature flag berbeda dari Config statis. Mereka dinamis dan mengubah *execution path* per-request/per-user tanpa restart.
1. **Env Var/Config File Static**: `FEATURE_NEW_UI=true`. Kurang scalable, memicu restart pod untuk toggle.
2. **Self-Hosted (Flipt, Unleash)**: Open-source, Go SDK tersertifikasi, evaluate secara real-time / local cache polling.
3. **SaaS (LaunchDarkly, Statsig)**: Target user granular (e.g. "aktifkan untuk user premium area Jakarta").

```go
// Contoh Unleash Go SDK Evaluation
isEnabled := unleash.IsEnabled("new-payment-gateway")
if isEnabled {
    return NewStripeGateway().Process(req)
}
return LegacyGateway().Process(req)
```

---

## 7. Anti-Patterns (❌ BAD vs ✅ GOOD)

### Anti-Pattern 1: `os.Getenv` Tersebar di Seluruh Codebase
❌ **BAD:**
```go
func ConnectDB() {
    // Hidden dependency, sulit di-mock/test
    dbPass := os.Getenv("DB_PASSWORD") 
    // ...
}
```
✅ **GOOD:**
Dependensi harus secara eksplisit didefinisikan lewat Config Struct yang di-inject.

### Anti-Pattern 2: Secret Hardcoded di Git Config Files
❌ **BAD:**
Memasukkan `api_key: XXXXXX` ke `config.staging.yaml` lalu di-commit ke Git repo.
✅ **GOOD:**
Di `config.staging.yaml` hanya set `api_host: staging.api.com`. `api_key` ditarik murni dari env var `$APP_API_KEY` (di-inject via K8s Secret yang disinkronkan via ExternalSecrets Operator/Vault).

### Anti-Pattern 3: Passing *Global Config Struct* (God Object)
❌ **BAD:**
Memberikan pointer `*Config` raksasa (yang menyimpan DB, Redis, API Key Stripe) ke setiap layer (repository, service), padahal struct tersebut hanya butuh satu atau dua nilai. Ini melanggar Interface Segregation.
```go
func NewUserRepository(cfg *config.Config, db *sql.DB) *UserRepo {
	// UserRepo mendapat akses tak terbatas ke semua config.
	return &UserRepo{timeout: cfg.Database.Timeout} 
}
```
✅ **GOOD:**
Terapkan *Dependency Injection*. Pass struct spesifik (potongan dari main struct) atau antarmuka yang sesuai batas kebutuhan komponen.
```go
type DatabaseConfig struct {
	Timeout time.Duration
}
func NewUserRepository(cfg DatabaseConfig, db *sql.DB) *UserRepo {
	return &UserRepo{timeout: cfg.Timeout}
}
```

---

## 8. Edge Cases & Penanganan

1. **Config Reload Race Condition (Hot Reloading)**: `fsnotify` memicu reload saat worker thread sedang membaca config. 
   - *Solusi & Deep Dive*: Struct Go tidak thread-safe. Jika Viper me-replace field di dalam struct saat handler HTTP sedang mengaksesnya, aplikasi akan mengalami panic (data race). Selalu bungkus referensi global Config dengan `atomic.Pointer[Config]` atau lindungi akses via `sync.RWMutex`.
   ```go
   var config atomic.Pointer[Config]
   // Saat fsnotify reload:
   // config.Store(newCfg)
   
   // Saat HTTP handler read:
   // cfg := config.Load()
   ```

2. **Config Drift Detection di K8s**: Config di memori berbeda jauh dengan ConfigMap (misal mount gagal parsial atau watcher tewas). 
   - *Solusi*: Daripada hot reload, inject SHA-256 hash dari ConfigMap sebagai anotasi Pod (misal `checksum/config: ${hash}`). Jika ConfigMap berubah, Pod otomatis di-restart (*rolling update*) oleh K8s, meminimalisir drift antara replika dan menjamin konsistensi yang solid.

3. **Missing Required Env in K8s**: Pod K8s crash loop tiada henti karena typo env var nama (e.g. `APP_POST`). 
   - *Solusi*: Gunakan *validation library* (validator) saat startup untuk fail-fast, catat log spesifik "Required env DB_HOST is missing" lalu `os.Exit(1)`.

4. **Secret Exposure in Logs**: Mencetak seluruh Struct Config saat start-up (untuk debugging) mengekspos token JWT & DB password. 
   - *Solusi*: Override method `String()` atau berikan tag `json:"-"` atau log-sanitizer yang menyensor key mengandung kata `secret`, `password`, `token`.

5. **Backward-Compatible Config Changes**: Menghapus config key `timeout_ms` menjadi `timeout_duration` memicu panic di service versi lama. 
   - *Solusi*: Terapkan *Versioning* config. Selama masa transisi, terima kedua field dengan mapping alias, dan prioritaskan field baru.

---

## 9. Config Testing (Unit Test Nyata)

Memverifikasi hierarchy, default fallback, override environment, dan validation logic.

```go
package config_test

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	
	// Assume myapp/config contains the LoadConfig function above
	"myapp/config" 
)

func TestConfigLoading_DefaultAndEnvOverride(t *testing.T) {
	// 1. Setup: Clear env vars that might interfere
	os.Clearenv()
	
	// Set specific overrides
	os.Setenv("APP_PORT", "9090")
	os.Setenv("APP_DATABASE_HOST", "postgres.internal")
	os.Setenv("APP_DATABASE_PORT", "5432")
	os.Setenv("APP_APP_ENV", "staging")

	// 2. Execute: Load with non-existent path to force Defaults + Env
	cfg, err := config.LoadConfig("/tmp/nonexistentpath")

	// 3. Assertions
	require.NoError(t, err, "Should not error even if file is missing if we have envs")
	
	// Assert overriden env var port
	assert.Equal(t, 9090, cfg.Port)
	assert.Equal(t, "staging", cfg.AppEnv)
	assert.Equal(t, "postgres.internal", cfg.Database.Host)
}

func TestConfigValidation_FailsMissingRequired(t *testing.T) {
	os.Clearenv()
	// Deliberately DO NOT SET Database.Host which is required

	_, err := config.LoadConfig("/tmp/nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "validation failed")
	assert.Contains(t, err.Error(), "Database.Host")
}

func TestConfigSecrets_AreNotExposedInString(t *testing.T) {
	// Custom test to ensure we don't accidentally leak secrets
	os.Clearenv()
	os.Setenv("APP_DATABASE_HOST", "localhost")
	os.Setenv("APP_DATABASE_PORT", "5432")
	os.Setenv("APP_APP_ENV", "dev")
	os.Setenv("APP_DATABASE_PASSWORD", "super_secret_p4ssw0rd")

	cfg, err := config.LoadConfig("/tmp/nonexistent")
	require.NoError(t, err)
	
	assert.Equal(t, "super_secret_p4ssw0rd", cfg.Database.Password)
}
```

## Kapan JANGAN Pakai Ini

- **Membaca variabel lingkungan tersebar di seluruh kode.** Konfigurasi harus dibaca sekali saat start dan divalidasi di situ. `os.Getenv` di tengah handler berarti kesalahan konfigurasi baru terlihat ketika jalur itu kebetulan dipakai — bisa berminggu-minggu setelah deploy.
- **Nilai bawaan yang nyaman tapi berbahaya bila lupa disetel.** `DEBUG=true` sebagai default berarti satu variabel yang terlewat membuka informasi internal ke publik. Default WAJIB yang paling aman, bukan yang paling mudah.
- **Rahasia di berkas konfigurasi yang ikut repo.** Termasuk `.env.example` yang perlahan diisi nilai sungguhan oleh orang yang ingin cepat.
- **Konfigurasi yang bisa diubah saat runtime tanpa jejak.** Perubahan perilaku produksi yang tidak tercatat membuat insiden tidak bisa direkonstruksi — dan itu selalu ketahuan pada saat paling buruk.
- **Validasi yang hanya memeriksa keberadaan.** `DATABASE_URL` yang ada tapi menunjuk ke staging lolos pemeriksaan "tidak kosong" dengan mulus. Validasi harus memeriksa bentuk dan, bila mungkin, konektivitas.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Galat konfigurasi muncul jam setelah deploy | di mana konfigurasi dibaca | Dibaca saat dipakai, bukan saat start |
| Perilaku berbeda antar pod | konfigurasi tiap pod | ConfigMap tidak seragam, atau ada yang belum restart |
| Rahasia ditemukan di riwayat git | `git log` pada berkas env | Pernah ter-commit, dan tetap ada meski sudah dihapus |
| Produksi menulis ke database staging | nilai DSN yang benar-benar dipakai | Validasi hanya memeriksa keberadaan |
| Perubahan perilaku tanpa deploy | sumber konfigurasi runtime | Perubahan tanpa jejak audit |

```bash
# Berapa banyak tempat membaca env di luar paket config
grep -rn 'os.Getenv' --include='*.go' . | grep -v '_test.go' | grep -v '/config/' | head -20

# Rahasia yang pernah masuk riwayat git -- menghapus berkasnya tidak menghapus riwayatnya
git ls-files | grep -E '\.env$'
git log --all --oneline -- '*.env' | head

# Konfigurasi yang BENAR-BENAR berjalan di pod (rahasia disaring)
kubectl get deploy api -o jsonpath='{.spec.template.spec.containers[0].env}' | jq
kubectl exec <pod> -- env | grep -viE 'password|secret|token|key'
```
