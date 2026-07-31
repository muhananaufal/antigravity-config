# Mocking Interfaces di Go

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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// --- Interface & Domain ---

//go:generate mockgen -destination=mocks/mock_payment.go -package=mocks -source=mocking_interfaces.go PaymentGateway

// PaymentGateway adalah kontrak untuk proses pembayaran.
type PaymentGateway interface {
	Charge(ctx context.Context, amount float64, token string) (string, error)
	Refund(ctx context.Context, txID string, amount float64) error
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

// ProcessOrder memproses pesanan dan mencatat audit log.
func (s *CheckoutService) ProcessOrder(ctx context.Context, amount float64, token string) (string, error) {
	if amount <= 0 {
		return "", errors.New("amount must be positive")
	}
	if token == "" {
		return "", errors.New("payment token required")
	}

	txID, err := s.gateway.Charge(ctx, amount, token)
	if err != nil {
		// Log audit untuk failed charge
		_ = s.logger.Log(ctx, "charge_failed", map[string]any{
			"amount": amount,
			"error":  err.Error(),
		})
		return "", fmt.Errorf("charge failed: %w", err)
	}

	if err := s.logger.Log(ctx, "charge_success", map[string]any{
		"txID":   txID,
		"amount": amount,
	}); err != nil {
		// Log failure tidak membatalkan order — non-fatal
		fmt.Printf("audit log error: %v\n", err)
	}

	return txID, nil
}

// --- Tests dengan go.uber.org/mock ---

// MockPaymentGateway — normalnya digenerate oleh mockgen.
// Di sini ditulis manual untuk demo.
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
func (m *MockPaymentGateway) Charge(ctx context.Context, amount float64, token string) (string, error) {
	ret := m.ctrl.Call(m, "Charge", ctx, amount, token)
	ret0, _ := ret[0].(string)
	ret1, _ := ret[1].(error)
	return ret0, ret1
}
func (m *MockPaymentGateway) Refund(ctx context.Context, txID string, amount float64) error {
	ret := m.ctrl.Call(m, "Refund", ctx, txID, amount)
	ret0, _ := ret[0].(error)
	return ret0
}
func (mr *MockPaymentGatewayMockRecorder) Charge(ctx, amount, token any) *gomock.Call {
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "Charge", ctx, amount, token)
}
func (mr *MockPaymentGatewayMockRecorder) Refund(ctx, txID, amount any) *gomock.Call {
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "Refund", ctx, txID, amount)
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
	ret := m.ctrl.Call(m, "Log", ctx, event, metadata)
	ret0, _ := ret[0].(error)
	return ret0
}
func (mr *MockAuditLoggerMockRecorder) Log(ctx, event, metadata any) *gomock.Call {
	return mr.mock.ctrl.RecordCallWithMethodType(mr.mock, "Log", ctx, event, metadata)
}

// TestCheckoutService_ProcessOrder adalah test table-driven dengan multiple scenarios.
func TestCheckoutService_ProcessOrder(t *testing.T) {
	tests := []struct {
		name      string
		amount    float64
		token     string
		setupMock func(gw *MockPaymentGateway, log *MockAuditLogger)
		wantTxID  string
		wantErr   bool
	}{
		{
			name:   "success — charge and log both succeed",
			amount: 150.00,
			token:  "tok_visa_success",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(150.00), "tok_visa_success").
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
			name:   "gateway error — log failure event, return error",
			amount: 99.99,
			token:  "tok_declined",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(99.99), "tok_declined").
					Return("", errors.New("card declined")).
					Times(1)
				// charge_failed log dipanggil saat gateway error
				log.EXPECT().
					Log(gomock.Any(), "charge_failed", gomock.Any()).
					Return(nil).
					Times(1)
			},
			wantErr: true,
		},
		{
			name:    "validation — negative amount returns error immediately",
			amount:  -10.0,
			token:   "tok_any",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				// Tidak ada call ke gateway atau logger untuk validasi error
				gw.EXPECT().Charge(gomock.Any(), gomock.Any(), gomock.Any()).Times(0)
				log.EXPECT().Log(gomock.Any(), gomock.Any(), gomock.Any()).Times(0)
			},
			wantErr: true,
		},
		{
			name:   "log failure is non-fatal — order still succeeds",
			amount: 50.00,
			token:  "tok_ok",
			setupMock: func(gw *MockPaymentGateway, log *MockAuditLogger) {
				gw.EXPECT().
					Charge(gomock.Any(), gomock.Eq(50.00), "tok_ok").
					Return("txn_xyz", nil).
					Times(1)
				log.EXPECT().
					Log(gomock.Any(), "charge_success", gomock.Any()).
					Return(errors.New("log service down")).  // logger error
					Times(1)
			},
			wantTxID: "txn_xyz", // order tetap sukses
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			ctrl := gomock.NewController(t) // auto-finish + assertion saat t cleanup

			mockGW := NewMockPaymentGateway(ctrl)
			mockLog := NewMockAuditLogger(ctrl)
			tt.setupMock(mockGW, mockLog)

			svc := NewCheckoutService(mockGW, mockLog)
			txID, err := svc.ProcessOrder(context.Background(), tt.amount, tt.token)

			if tt.wantErr {
				require.Error(t, err)
				assert.Empty(t, txID)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantTxID, txID)
			}
		})
	}
}

// TestCheckoutService_DoAndReturn contoh penggunaan DoAndReturn untuk side-effects.
func TestCheckoutService_DoAndReturn(t *testing.T) {
	ctrl := gomock.NewController(t)

	mockGW := NewMockPaymentGateway(ctrl)
	mockLog := NewMockAuditLogger(ctrl)

	// DoAndReturn: eksekusi custom function saat method dipanggil
	mockGW.EXPECT().
		Charge(gomock.Any(), gomock.Any(), gomock.Any()).
		DoAndReturn(func(ctx context.Context, amount float64, token string) (string, error) {
			// Simulasi latency atau side effect kompleks
			if amount > 1000.00 {
				return "", errors.New("amount exceeds limit")
			}
			return fmt.Sprintf("txn_%s", token), nil
		})
	mockLog.EXPECT().Log(gomock.Any(), gomock.Any(), gomock.Any()).Return(nil).AnyTimes()

	svc := NewCheckoutService(mockGW, mockLog)
	txID, err := svc.ProcessOrder(context.Background(), 500.00, "abc")
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
// BAD: matcher terlalu ketat pada dynamic values → flaky test
mockGW.EXPECT().
    Charge(gomock.Eq(ctx), gomock.Eq(100.0), gomock.Eq(time.Now().String()))
    // time.Now() berbeda tiap run → selalu gagal!

// GOOD: gunakan gomock.Any() untuk dynamic/non-deterministic values
mockGW.EXPECT().
    Charge(gomock.Any(), gomock.Eq(100.0), gomock.Any())

// Atau gunakan gomock.AssignableToTypeOf() untuk type assertion:
mockGW.EXPECT().
    Charge(gomock.AssignableToTypeOf(context.Background()), ...)
```

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
