# End-to-End & Contract Testing Patterns di Go

E2E testing di Go memverifikasi sistem dari boundary terluar (HTTP handler) hingga interaksi paling dalam. `httptest` package bawaan Go adalah tool utama — tidak perlu framework eksternal. Contract testing dengan `pact-go` memastikan konsistensi API antar microservice.

---

## 1. Arsitektur: Tiga Level HTTP Testing

```
Level 1: Handler Test (Paling Cepat)
  ┌─────────────────────────────────────────────────────┐
  │  httptest.NewRequest() + httptest.NewRecorder()     │
  │  Direct function call — tidak ada TCP overhead      │
  │  Cocok untuk: handler logic, middleware, response   │
  └─────────────────────────────────────────────────────┘
         ↓ lebih realistik, sedikit lebih lambat

Level 2: In-Process Server Test
  ┌─────────────────────────────────────────────────────┐
  │  httptest.NewServer(mux) → membuka TCP port nyata   │
  │  http.Client bisa connect ke URL real               │
  │  Cocok untuk: middleware chain, TLS, redirect       │
  └─────────────────────────────────────────────────────┘
         ↓ paling realistik, paling lambat

Level 3: External/Contract Test
  ┌─────────────────────────────────────────────────────┐
  │  pact-go: consumer-driven contract testing          │
  │  Verifikasi API contract antar service              │
  │  Cocok untuk: microservice integration, API versioning│
  └─────────────────────────────────────────────────────┘
```

---

## 2. Kode Go Production-Ready

```go
package testingquality

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --- Domain Handler ---

// UserResponse adalah response struct untuk endpoint user.
type UserResponse struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// APIError adalah format error standar (RFC 7807).
type APIError struct {
	Type    string `json:"type"`
	Title   string `json:"title"`
	Status  int    `json:"status"`
	Detail  string `json:"detail"`
}

// UserHandler menangani GET /users/{id}.
func UserHandler(w http.ResponseWriter, r *http.Request) {
	// Parse user ID dari URL (Go 1.22+ pattern matching)
	idStr := r.PathValue("id")
	if idStr == "" {
		writeError(w, http.StatusBadRequest, "missing user id")
		return
	}

	// Simulasi: hanya user ID 101 yang ada
	if idStr != "101" {
		writeError(w, http.StatusNotFound, fmt.Sprintf("user %q not found", idStr))
		return
	}

	resp := UserResponse{
		ID:        101,
		Name:      "Jane Doe",
		Status:    "active",
		CreatedAt: time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC), // fixed time untuk golden test
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, detail string) {
	apiErr := APIError{
		Type:   fmt.Sprintf("https://api.example.com/errors/%d", status),
		Title:  http.StatusText(status),
		Status: status,
		Detail: detail,
	}
	writeJSON(w, status, apiErr)
}

// AuthMiddleware adalah contoh JWT middleware yang akan di-test.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			writeError(w, http.StatusUnauthorized, "missing authorization header")
			return
		}
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "invalid authorization format")
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if token != "valid-test-token" {
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// newTestServer membuat router dengan middleware chain — reusable across tests.
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", UserHandler)

	// Middleware chain: Auth → Handler
	protected := AuthMiddleware(mux)

	ts := httptest.NewServer(protected)
	t.Cleanup(func() { ts.Close() })
	return ts
}

// --- Level 1: Handler Unit Test (httptest.Recorder) ---

// TestUserHandler_Recorder menguji handler secara langsung tanpa TCP.
func TestUserHandler_Recorder(t *testing.T) {
	tests := []struct {
		name           string
		userID         string
		wantStatus     int
		updateGolden   bool
	}{
		{"existing user", "101", http.StatusOK, false},
		{"not found", "999", http.StatusNotFound, false},
		{"empty id", "", http.StatusBadRequest, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := "/users/" + tt.userID
			req := httptest.NewRequest(http.MethodGet, path, nil)
			// Go 1.22+: Set path value untuk pattern matching
			req.SetPathValue("id", tt.userID)

			rec := httptest.NewRecorder()
			UserHandler(rec, req)

			res := rec.Result()
			defer res.Body.Close()

			require.Equal(t, tt.wantStatus, res.StatusCode)
			require.Equal(t, "application/json", res.Header.Get("Content-Type"))

			// Golden file comparison untuk response 200 OK
			if tt.wantStatus == http.StatusOK {
				bodyBytes, err := io.ReadAll(res.Body)
				require.NoError(t, err)
				assertGoldenFile(t, tt.name, bodyBytes)
			}
		})
	}
}

// assertGoldenFile membandingkan body dengan golden file.
// Set env UPDATE_GOLDEN=true untuk update golden files.
func assertGoldenFile(t *testing.T, testName string, got []byte) {
	t.Helper()

	// Sanitize filename
	filename := strings.ReplaceAll(testName, " ", "_") + ".golden"
	goldenPath := filepath.Join("testdata", "golden", filename)

	if os.Getenv("UPDATE_GOLDEN") == "true" {
		require.NoError(t, os.MkdirAll(filepath.Dir(goldenPath), 0o755))
		require.NoError(t, os.WriteFile(goldenPath, got, 0o644))
		t.Logf("Updated golden file: %s", goldenPath)
		return
	}

	expected, err := os.ReadFile(goldenPath)
	if os.IsNotExist(err) {
		t.Fatalf("golden file not found: %s\nRun with UPDATE_GOLDEN=true to create it", goldenPath)
	}
	require.NoError(t, err)

	assert.JSONEq(t, string(expected), string(got),
		"response does not match golden file %s", goldenPath)
}

// --- Level 2: Full Server Test dengan Middleware Chain ---

// TestUserHandler_WithAuthMiddleware menguji seluruh middleware chain via TCP.
func TestUserHandler_WithAuthMiddleware(t *testing.T) {
	ts := newTestServer(t)

	tests := []struct {
		name       string
		authHeader string
		userID     string
		wantStatus int
	}{
		{
			name:       "valid token authorized",
			authHeader: "Bearer valid-test-token",
			userID:     "101",
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing auth header rejected",
			authHeader: "",
			userID:     "101",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token rejected",
			authHeader: "Bearer wrong-token",
			userID:     "101",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid auth but user not found",
			authHeader: "Bearer valid-test-token",
			userID:     "999",
			wantStatus: http.StatusNotFound,
		},
	}

	client := ts.Client() // gunakan client dari server, sudah dikonfigurasi untuk TLS jika TLS server

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, ts.URL+"/users/"+tt.userID, nil)
			require.NoError(t, err)

			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}

			resp, err := client.Do(req)
			require.NoError(t, err)
			defer resp.Body.Close()

			assert.Equal(t, tt.wantStatus, resp.StatusCode)

			// Verifikasi Content-Type selalu JSON
			assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
		})
	}
}

// TestUserHandler_ConcurrentRequests memverifikasi handler aman untuk concurrent access.
func TestUserHandler_ConcurrentRequests(t *testing.T) {
	ts := newTestServer(t)
	client := ts.Client()

	const numWorkers = 20
	errs := make(chan error, numWorkers)

	for i := 0; i < numWorkers; i++ {
		go func() {
			req, _ := http.NewRequest(http.MethodGet, ts.URL+"/users/101", nil)
			req.Header.Set("Authorization", "Bearer valid-test-token")

			resp, err := client.Do(req)
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				errs <- fmt.Errorf("unexpected status: %d", resp.StatusCode)
				return
			}
			errs <- nil
		}()
	}

	for i := 0; i < numWorkers; i++ {
		if err := <-errs; err != nil {
			t.Errorf("concurrent request failed: %v", err)
		}
	}
}

// TestUserHandler_RequestBody memverifikasi parsing JSON request body.
func TestUserHandler_RequestBody(t *testing.T) {
	// Simulasi handler yang menerima POST body
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		writeJSON(w, http.StatusCreated, body)
	})

	payload := map[string]any{"name": "New User", "email": "new@example.com"}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)

	var got map[string]any
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&got))
	assert.Equal(t, "New User", got["name"])
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Tidak Menutup `httptest.Server` → Resource Leak

```go
// BAD: server tidak ditutup → goroutine & socket leak
func TestSomething(t *testing.T) {
    ts := httptest.NewServer(mux)
    // Tidak ada defer ts.Close() → setiap test run leak 1 goroutine + 1 file descriptor

// GOOD: selalu close, dan gunakan t.Cleanup untuk auto-close
func TestSomething(t *testing.T) {
    ts := httptest.NewServer(mux)
    t.Cleanup(func() { ts.Close() }) // dipanggil bahkan jika test panic
    // atau: defer ts.Close()
```

**Kenapa berbahaya:** Setelah ribuan test run (CI pipeline), akumulasi goroutine dan socket yang tidak ditutup menyebabkan OOM dan "too many open files" error. Setiap `httptest.NewServer` membuka goroutine listener yang perlu ditutup eksplisit.

### ❌ Anti-Pattern 2: Hardcoded JSON String dalam Assertion

```go
// BAD: string comparison rapuh terhadap key ordering, whitespace, newline
expected := `{"id":101,"name":"Jane Doe","status":"active"}`
assert.Equal(t, expected, string(bodyBytes)) // FAIL jika key order berbeda

// GOOD: gunakan assert.JSONEq yang key-order dan whitespace agnostic
assert.JSONEq(t, expected, string(bodyBytes))

// GOOD: untuk output besar, gunakan golden file
assertGoldenFile(t, "user_101_response", bodyBytes)
```

**Kenapa berbahaya:** JSON key ordering bergantung pada implementasi `json.Encoder`. Go 1.x mungkin output key dalam urutan berbeda dari Go 1.y. `assert.Equal` pada string JSON = flaky test yang tidak jelas kenapa gagal.

### ❌ Anti-Pattern 3: Menggunakan `ts.URL` tanpa `ts.Client()` untuk HTTPS

```go
// BAD: menggunakan http.DefaultClient untuk httptest.NewTLSServer
ts := httptest.NewTLSServer(mux)
resp, err := http.Get(ts.URL + "/endpoint")
// ERROR: x509: certificate signed by unknown authority
// Default client tidak mengenal sertifikat self-signed testserver

// GOOD: gunakan ts.Client() yang sudah dikonfigurasi dengan sertifikat server
ts := httptest.NewTLSServer(mux)
t.Cleanup(func() { ts.Close() })
resp, err := ts.Client().Get(ts.URL + "/endpoint") // aman
```

**Kenapa berbahaya:** TLS test server menggunakan sertifikat self-signed. `http.DefaultClient` menolaknya → test selalu gagal dengan error TLS yang membingungkan. `ts.Client()` sudah dikonfigurasi dengan trust store yang berisi sertifikat server.

---

## 4. Edge Cases & Defensive Programming

1. **Golden File pada First Run di CI:** Jika golden file belum ada (first-time run di CI baru), `os.ReadFile` akan return `ErrNotExist` dan test gagal. Workflow yang benar: commit golden files ke Git bersama kode, atau buat `testdata/golden/` di init test dengan `UPDATE_GOLDEN=true` satu kali sebelum commit.

2. **Dynamic Fields (timestamp, uuid) di Golden Files:** JSON response yang mengandung `created_at`, `request_id`, atau `uuid` akan selalu berbeda tiap run → golden file test selalu gagal. Solusi: mask field-field tersebut sebelum compare — gunakan regex replace atau unmarshal ke struct kemudian set field dinamis ke nilai fixed.

3. **Context Cancellation di httptest.NewRecorder:** `httptest.NewRecorder()` tidak terhubung ke TCP riil — `r.Context()` dari `httptest.NewRequest()` tidak pernah cancelled secara alamiah. Untuk test yang melibatkan `r.Context().Done()`, bungkus dengan `httptest.NewRequest(...).WithContext(cancelCtx)` yang di-cancel manual.

4. **`httptest.ResponseRecorder.Result()` setelah Multiple Writes:** Jika handler memanggil `w.Write()` berkali-kali, `rec.Result()` akan mengandung semua data gabungan. Namun `rec.Result()` hanya bisa dipanggil sekali per recorder — body sudah di-consume setelah pertama dipanggil.

5. **Concurrency dalam Handler Test:** Handler yang di-test dengan `httptest.NewServer` bisa menerima request concurrent dari `TestUserHandler_ConcurrentRequests`. Pastikan handler tidak menggunakan shared mutable state tanpa sinkronisasi (mutex/RWMutex). Gunakan `-race` flag saat test.
