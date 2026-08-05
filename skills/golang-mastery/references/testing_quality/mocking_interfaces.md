# Mocking Interfaces di Go

> **Berlaku:** Go 1.21+ · `go.uber.org/mock` (pengganti `github.com/golang/mock` yang tidak lagi dipelihara) · **Lihat juga:** `testing_quality/unit_testing_testify.md` · `testing_quality/testcontainers_integration.md` · `arch_patterns/clean_hexagonal_architecture.md` · `arch_patterns/dependency_injection_wire.md`

Mocking di Go berbasis interface — bukan reflection magic seperti di Java/Python. Prinsip "Accept interfaces, return structs" memungkinkan penggantian implementasi nyata dengan mock saat testing. `go.uber.org/mock` (penerus `golang/mock`) adalah tool standar industri; `testify/mock` cocok untuk manual mocking ringan.

---

## 1. Arsitektur Mocking di Go

```
Interface Definition (kontrak)
        │
        ├──► Production Implementation  (di-inject saat runtime)
        │    └── RealPaymentGateway { stripe.Client }
        │
        └──► Mock Implementation        (di-inject saat test)
             └── MockPaymentGateway     ← digenerate oleh mockgen
                  ├── EXPECT() recorder
                  └── Charge() → ctrl.Call(...)

Dependency Injection:
  NewCheckoutService(gateway PaymentGateway)
                              ↑
             test inject MockPaymentGateway
             prod inject RealPaymentGateway
```

**Pilihan tool:**

| Tool | Generate? | Style | Cocok untuk |
|---|---|---|---|
| `go.uber.org/mock` (mockgen) | ✅ Auto | Behavior verification (EXPECT) | Kompleks, perlu verifikasi call order & count |
| `testify/mock` + `mockery` | ✅ Auto | Stub-based (On/Return) | Sederhana, tanpa controller |
| `moq` | ✅ Auto | Struct + func pointer | Lightweight, no controller |
| Manual mock struct | ❌ Manual | Minimal | Sangat sederhana, 1-2 method |

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// --- Interface & Domain ---

//go:generate mockgen -destination=mocks/mock_payment.go -package=mocks -source=mocking_interfaces.go PaymentGateway

// PaymentGateway adalah kontrak untuk proses pembayaran.
//
// Jumlah dalam SATUAN MINOR bertipe int64. Di berkas tentang mocking, ini
// bukan sekadar soal uang: `gomock.Eq(99.99)` mencocokkan nilai float64
// secara persis, sehingga begitu jumlahnya melewati satu operasi aritmetika
// pun, matcher-nya berhenti cocok dan gomock melaporkannya sebagai
// "missing call" — kegagalan yang menuntun Anda mencari bug di logika,
// padahal yang salah adalah matcher-nya.
type PaymentGateway interface {
	Charge(ctx context.Context, amountSen int64, token string) (string, error)
	Refund(ctx context.Context, txID string, amountSen int64) error
}

// AuditLogger adalah kontrak untuk audit log.
type AuditLogger interface {
	Log(ctx context.Context, event string, metadata map[string]any) error
}

// CheckoutService mengorkestrasikan proses checkout.
type CheckoutService struct {
	gateway PaymentGateway
	logger  AuditLogger
}

// NewCheckoutService membuat instance baru dengan DI.
func NewCheckoutService(g PaymentGateway, l AuditLogger) *CheckoutService {
	return &CheckoutService{gateway: g, logger: l}
}

// Galat validasi sebagai sentinel, supaya uji bisa memeriksanya dengan
// errors.Is alih-alih mencocokkan teks.
var (
	ErrJumlahTidakValid = errors.New("jumlah harus positif")
	ErrTokenKosong      = errors.New("token pembayaran wajib ada")
)

// ProcessOrder memproses pesanan dan mencatat audit log.
func (s *CheckoutService) ProcessOrder(ctx context.Context, amountSen int64, token string) (string, error) {
	if amountSen <= 0 {
		return "", ErrJumlahTidakValid
	}
	if token == "" {
		return "", ErrTokenKosong
	}

	txID, err := s.gateway.Charge(ctx, amountSen, token)
	if err != nil {
		// Galat audit di jalur ini pun tidak boleh ditelan diam-diam.
		if errLog := s.logger.Log(ctx, "charge_failed", map[string]any{
			"amount_minor": amountSen,
			"error":        err.Error(),
		}); errLog != nil {
			slog.ErrorContext(ctx, "audit charge_failed gagal dicatat", "galat", errLog)
		}
		return "", fmt.Errorf("charge gagal: %w", err)
	}

	if err := s.logger.Log(ctx, "charge_success", map[string]any{
		"txID":         txID,
		"amount_minor": amountSen,
	}); err != nil {
		// Kegagalan audit tidak membatalkan pesanan — tetapi ia WAJIB
		// terlihat. fmt.Printf menulis ke stdout tanpa level, tanpa korelasi,
		// dan tidak akan pernah memicu alert apa pun; padahal audit yang
		// gagal diam-diam persis yang ingin Anda ketahui.
		slog.ErrorContext(ctx, "audit charge_success gagal dicatat",
			"galat", err, "tx_id", txID)
	}

	return txID, nil
}

// --- Tests dengan go.uber.org/mock ---

// MockPaymentGateway — normalnya digenerate mockgen; ditulis manual di sini
// agar bentuknya terlihat.
//
// Dua hal yang WAJIB ditiru dari keluaran mockgen, dan keduanya salah pada
// versi sebelumnya:
//
//  1. **`RecordCall`, bukan `RecordCallWithMethodType`.** Tanda tangan yang
//     kedua adalah `(receiver any, method string, methodType reflect.Type,
//     args ...any)` — parameter ketiganya bertipe `reflect.Type`. Meneruskan
//     `ctx` yang bertipe `any` ke sana adalah **galat kompilasi**, sehingga
//     seluruh blok demo ini sebelumnya tidak bisa dibangun sama sekali.
//     mockgen memang memakai varian WithMethodType, tetapi ia menyertakan
//     `reflect.TypeOf((*MockX)(nil).Metode)` sebagai argumen ketiga. Untuk
//     mock yang ditulis tangan, `RecordCall` menemukan tipe metodenya
//     sendiri lewat refleksi dan lebih sulit disalahtulis.
//
//  2. **`ctrl.T.Helper()` di awal setiap metode.** Tanpanya, laporan
//     kegagalan gomock menunjuk ke baris DI DALAM berkas mock, bukan ke
//     baris pemanggil yang sebenarnya salah — dan pada suite besar itu
//     berarti setiap kegagalan menunjuk ke tempat yang sama dan tidak
//     berguna.
type MockPaymentGateway struct {
	ctrl     *gomock.Controller
	recorder *MockPaymentGatewayMockRecorder
}
type MockPaymentGatewayMockRecorder struct{ mock *MockPaymentGateway }

func NewMockPaymentGateway(ctrl *gomock.Controller) *MockPaymentGateway {
	m := &MockPaymentGateway{ctrl: ctrl}
	m.recorder = &MockPaymentGatewayMockRecorder{mock: m}
	return m
}
func (m *MockPaymentGateway) EXPECT() *MockPaymentGatewayMockRecorder { return m.recorder }

func (m *MockPaymentGateway) Charge(ctx context.Context, amountSen int64, token string) (string, error) {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "Charge", ctx, amountSen, token)
	ret0, _ := ret[0].(string)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}
func (m *MockPaymentGateway) Refund(ctx context.Context, txID string, amountSen int64) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "Refund", ctx, txID, amountSen)
	ret0, _ := ret[0].(error)
	return ret0
}
func (mr *MockPaymentGatewayMockRecorder) Charge(ctx, amountSen, token any) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCall(mr.mock, "Charge", ctx, amountSen, token)
}
func (mr *MockPaymentGatewayMockRecorder) Refund(ctx, txID, amountSen any) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCall(mr.mock, "Refund", ctx, txID, amountSen)
}

// MockAuditLogger — minimal mock untuk AuditLogger.
type MockAuditLogger struct {
	ctrl     *gomock.Controller
	recorder *MockAuditLoggerMockRecorder
}
type MockAuditLoggerMockRecorder struct{ mock *MockAuditLogger }

func NewMockAuditLogger(ctrl *gomock.Controller) *MockAuditLogger {
	m := &MockAuditLogger{ctrl: ctrl}
	m.recorder = &MockAuditLoggerMockRecorder{mock: m}
	return m
}
func (m *MockAuditLogger) EXPECT() *MockAuditLoggerMockRecorder { return m.recorder }

func (m *MockAuditLogger) Log(ctx context.Context, event string, metadata map[string]any) error {
	m.ctrl.T.Helper()
	ret := m.ctrl.Call(m, "Log", ctx, event, metadata)
	ret0, _ := ret[0].(error)
	return ret0
}
func (mr *MockAuditLoggerMockRecorder) Log(ctx, event, metadata any) *gomock.Call {
	mr.mock.ctrl.T.Helper()
	return mr.mock.ctrl.RecordCall(mr.mock, "Log", ctx, event, metadata)
}

// TestCheckoutService_ProcessOrder adalah test table-driven dengan multiple scenarios.
func TestCheckoutService_ProcessOrder(t *testing.T) {
	tests := []struct {
		name      string
		amountSen int64
		token     string
		setupMock func(gw *MockPaymentGateway, log *MockAuditLogger)
		wantTxID  string
		wantErr   error // sentinel, bukan bool: "ada galat" tidak membedakan galat yang SALAH
	}{
		{
			name:      "sukses — charge dan audit sama-sama berhasil",
			amountSen: 15_000,
			token:     "tok_visa_success",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(int64(15_000)), "tok_visa_success").
					Return("txn_abc123", nil).
					Times(1)
				log.EXPECT().
					Log(gomock.Any(), "charge_success", gomock.Any()).
					Return(nil).
					Times(1)
			},
			wantTxID: "txn_abc123",
		},
		{
			name:      "gateway gagal — audit charge_failed tetap dicatat",
			amountSen: 9_999,
			token:     "tok_declined",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(int64(9_999)), "tok_declined").
					Return("", errors.New("kartu ditolak")).
					Times(1)
				log.EXPECT().
					Log(gomock.Any(), "charge_failed", gomock.Any()).
					Return(nil).
					Times(1)
			},
			wantErr: errKartuDitolak,
		},
		{
			// Tanpa EXPECT sama sekali: controller gomock SUDAH menggagalkan
			// panggilan yang tidak diharapkan. `Times(0)` di sini hanya
			// mengulang jaminan yang sudah ada, dan menyiratkan bahwa tanpa
			// baris itu panggilan liar akan lolos — padahal tidak.
			name:      "validasi — jumlah negatif ditolak sebelum menyentuh gateway",
			amountSen: -1_000,
			token:     "tok_any",
			setupMock: func(*MockPaymentGateway, *MockAuditLogger) {},
			wantErr:   ErrJumlahTidakValid,
		},
		{
			// Cabang ini sama sekali tidak diuji pada versi sebelumnya,
			// meski validasinya ada dua.
			name:      "validasi — token kosong ditolak",
			amountSen: 5_000,
			token:     "",
			setupMock: func(*MockPaymentGateway, *MockAuditLogger) {},
			wantErr:   ErrTokenKosong,
		},
		{
			name:      "audit gagal tidak membatalkan pesanan",
			amountSen: 5_000,
			token:     "tok_ok",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(int64(5_000)), "tok_ok").
					Return("txn_xyz", nil).
					Times(1)
				log.EXPECT().
					Log(gomock.Any(), "charge_success", gomock.Any()).
					Return(errors.New("layanan audit mati")).
					Times(1)
			},
			wantTxID: "txn_xyz", // order tetap sukses
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctrl := gomock.NewController(t) // auto-finish + asersi saat cleanup

			mockGW := NewMockPaymentGateway(ctrl)
			mockLog := NewMockAuditLogger(ctrl)
			tt.setupMock(mockGW, mockLog)

			svc := NewCheckoutService(mockGW, mockLog)
			txID, err := svc.ProcessOrder(context.Background(), tt.amountSen, tt.token)

			if tt.wantErr != nil {
				// errors.Is, bukan require.Error. `wantErr bool` hanya
				// menjawab "ada galat" — ia sama-sama lulus ketika kode
				// mengembalikan galat yang SALAH, mis. ErrTokenKosong padahal
				// yang diharapkan ErrJumlahTidakValid.
				require.ErrorIs(t, err, tt.wantErr)
				assert.Empty(t, txID)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.wantTxID, txID)
		})
	}
}

// errKartuDitolak dipakai tabel di atas agar asersinya bisa memakai errors.Is.
var errKartuDitolak = errors.New("kartu ditolak")

// TestCheckoutService_DoAndReturn contoh DoAndReturn untuk efek samping.
func TestCheckoutService_DoAndReturn(t *testing.T) {
	ctrl := gomock.NewController(t)

	mockGW := NewMockPaymentGateway(ctrl)
	mockLog := NewMockAuditLogger(ctrl)

	// DoAndReturn: fungsi kustom dijalankan saat metode dipanggil.
	//
	// Tanda tangannya WAJIB persis sama dengan metode yang di-mock. gomock
	// memanggilnya lewat refleksi, sehingga ketidakcocokan tipe baru meledak
	// saat runtime sebagai panic — bukan ditangkap kompilator.
	mockGW.EXPECT().
		Charge(gomock.Any(), gomock.Any(), gomock.Any()).
		DoAndReturn(func(ctx context.Context, amountSen int64, token string) (string, error) {
			if amountSen > 100_000 {
				return "", errors.New("jumlah melebihi batas")
			}
			return fmt.Sprintf("txn_%s", token), nil
		})
	mockLog.EXPECT().Log(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil).AnyTimes()

	svc := NewCheckoutService(mockGW, mockLog)
	txID, err := svc.ProcessOrder(context.Background(), 50_000, "abc")
	require.NoError(t, err)
	assert.Equal(t, "txn_abc", txID)
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Mocking Concrete Struct (bukan Interface)

```go
// BAD: struct konkret tidak bisa di-mock tanpa monkey-patching
type CheckoutService struct {
    gateway *StripeGateway // concrete type
}
func NewService(g *StripeGateway) *CheckoutService { ... }
// Di test: tidak bisa inject gateway palsu → harus panggil Stripe API sungguhan

// GOOD: accept interface
type CheckoutService struct {
    gateway PaymentGateway // interface
}
func NewService(g PaymentGateway) *CheckoutService { ... }
// Di test: inject MockPaymentGateway → test tanpa network
```

**Kenapa berbahaya:** Test menjadi terikat pada implementasi nyata (network, database). Test lambat, flaky, dan tidak bisa berjalan offline. Prinsip Go: "Accept interfaces, return structs."

### ❌ Anti-Pattern 2: Over-Specification pada Argument Matcher

```go
// BAD: matcher terlalu ketat pada nilai dinamis → uji flaky
mockGW.EXPECT().
    Charge(gomock.Eq(ctx), gomock.Eq(int64(10_000)), gomock.Eq(time.Now().String()))
    // time.Now() berbeda tiap run → selalu gagal!

// GOOD: gomock.Any() untuk nilai non-deterministik
mockGW.EXPECT().
    Charge(gomock.Any(), gomock.Eq(int64(10_000)), gomock.Any())
```

**Dan satu bentuk over-specification yang jauh lebih sunyi: `gomock.Eq` pada `float64`.**

```go
// BAD: cocok HANYA bila bit-nya sama persis
mockGW.EXPECT().Charge(gomock.Any(), gomock.Eq(99.99), gomock.Any())
```

Selama nilainya diteruskan apa adanya dari literal yang sama, ini kebetulan cocok. Begitu jumlahnya melewati **satu** operasi aritmetika — pajak, pembulatan, penjumlahan keranjang — hasilnya berbeda beberapa ULP dan matcher berhenti cocok. gomock melaporkannya sebagai **"missing call"**, yang menuntun Anda mencari bug di logika bisnis, padahal yang salah adalah matcher-nya. Jumlah uang dalam satuan minor bertipe `int64` menghapus seluruh kelas kegagalan ini; bila terpaksa memakai float, pakai matcher toleransi kustom, jangan `Eq`.

**Kenapa berbahaya:** Test bergantung pada nilai timestamp, UUID, atau pointer yang berubah setiap run. Hasilnya: flaky test yang lulus di lokal tapi gagal di CI.

### ❌ Anti-Pattern 3: Menggunakan Old Package `github.com/golang/mock`

```go
// BAD: package lama, tidak di-maintain sejak 2023
import "github.com/golang/mock/gomock"

// GOOD: gunakan fork aktif yang di-maintain Uber
import "go.uber.org/mock/gomock"

// Install mockgen:
// go install go.uber.org/mock/mockgen@latest
// Generate:
// mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks
```

**Kenapa berbahaya:** `github.com/golang/mock` telah diarsipkan. Bug tidak diperbaiki, tidak kompatibel dengan Go versi terbaru. `go.uber.org/mock` adalah penerus resmi yang aktif di-maintain.

---

## 4. Edge Cases & Defensive Programming

1. **Unexpected Call Panic:** `gomock.Controller` akan panic saat test jika method dipanggil yang tidak di-EXPECT()-kan. Ini fitur, bukan bug — memastikan tidak ada call tersembunyi. Gunakan `mockGW.EXPECT().SomeMethod(...).AnyTimes()` jika method boleh dipanggil berapa kali saja.

2. **Goroutine Safety di `testify/mock`:** `testify/mock.Mock` tidak thread-safe secara default. Jika method mock dipanggil dari goroutine berbeda (misal HTTP handler yang di-test concurrently), perlu sinkronisasi manual atau switch ke `gomock` yang thread-safe.

3. **Interface yang Terlalu Lebar (Interface Pollution):** Jangan buat interface dengan 15+ method hanya agar bisa di-mock. Pecah menjadi beberapa interface kecil (Interface Segregation Principle). `PaymentGateway` dengan `Charge` dan `Refund` lebih baik dari `PaymentService` dengan semua metode payment.

4. **`gomock.InOrder` untuk Sequential Call Verification:** Jika urutan call penting (misal: `Begin()` harus sebelum `Commit()`), gunakan `gomock.InOrder(call1, call2, call3)`. Tanpa ini, gomock tidak peduli urutan.

5. **Mock Interface dari External Package:** Untuk interface dari library pihak ketiga (misal `database/sql.DB`), gunakan `mockgen -destination` dengan `-source` path ke package tersebut, atau gunakan `//go:generate` directive di file interface wrapper yang kamu buat sendiri.

## Kapan JANGAN Pakai Ini

- **Mock untuk database.** Mem-mock query SQL hanya menguji bahwa Anda menulis string yang sama di dua tempat. Yang perlu dibuktikan adalah query-nya benar terhadap PostgreSQL sungguhan — termasuk tipe, constraint, dan galat unik driver. Pakai testcontainers.
- **Interface yang dibuat semata agar bisa di-mock.** Di Go, interface milik konsumen. Interface satu-implementasi yang lahir di sisi produsen hanya demi mock adalah abstraksi yang tidak pernah dipakai untuk apa pun selain uji.
- **Argument matcher yang terlalu ketat.** `EXPECT().Simpan(ctxTertentu, objekPersisIni)` akan gagal setiap kali struct bertambah satu field yang tidak relevan. Cocokkan hanya yang benar-benar menentukan.
- **Mock untuk fungsi murni.** Formatter, validator, dan kalkulasi lebih cepat dan lebih jujur diuji langsung.
- **Memverifikasi urutan panggilan** kecuali urutan itu memang bagian dari kontrak. Menguncinya membuat refactor yang sama sekali tidak mengubah perilaku tetap gagal.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Uji hijau tapi produksi gagal di jalur yang sama | apa yang di-mock | Mock tidak mencerminkan perilaku nyata dependensinya |
| Uji gagal setiap kali struct bertambah field | matcher yang dipakai | Over-specification pada argument matcher |
| Mock tidak sinkron dengan interface | `go generate` di CI | Kode mock basi; interface sudah berubah |
| Banyak interface satu-implementasi | siapa konsumennya | Interface dibuat demi mock, bukan demi kebutuhan |
| Galat driver tidak pernah teruji | daftar galat yang di-stub | Mock hanya mengembalikan sukses dan satu galat generik |

```bash
mockgen -source=repository.go -destination=mocks/repository_mock.go -package=mocks

# Gerbang CI: mock yang basi langsung ketahuan
go generate ./... && git diff --exit-code

# Paket lama yang sudah tidak dipelihara -- pindah ke go.uber.org/mock
grep -rn 'github.com/golang/mock' --include='*.go' .

# Ekspektasi yang tidak terpenuhi atau panggilan tak terduga
go test ./... -v 2>&1 | grep -iE 'missing call|unexpected call|has already been called'
```
