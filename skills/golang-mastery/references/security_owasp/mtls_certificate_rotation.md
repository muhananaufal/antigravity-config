# Panduan Definitif: mTLS & Zero-Downtime Certificate Rotation

## 1. Konsep dan Internals (Technical Depth)

Dalam arsitektur *Zero-Trust* seperti ekosistem Kubernetes, jaringan privat (`VPC`) tidak pernah diasumsikan "aman". Layanan A (`Service-A`) dan Layanan B (`Service-B`) yang mengobrol di dalam jaringan tersebut rawan terhadap *Man-in-the-Middle (MitM)* jika jaringan disusupi. Standar solusinya adalah **Mutual TLS (mTLS)**.

1. **mTLS (Mutual TLS)**: TLS biasa (seperti HTTPS di browser) bersifat *One-way*: Browser memverifikasi identitas situs Server. Dalam *mTLS*, Server B juga meminta sertifikat TLS dari Service-A. Keduanya saling memverifikasi tandatangan menggunakan Otoritas Sertifikat Pusat (Internal Root CA).
2. **SPIFFE / SVID**: Standar identitas modern (*Secure Production Identity Framework*). Kredensial tidak berbentuk password panjang, melainkan sertifikat x509 yang masa berlakunya hanya 1-24 jam. Ini secara matematis meniadakan perlunya daftar pencabutan sertifikat (*CRL*), karena sertifikat curian akan usang dalam hitungan jam.
3. **Hot-Reload (Zero-Downtime Rotation)**: Jika sertifikat kadaluarsa setiap 1 jam, aplikasi Go tidak boleh me-restart HTTP Server-nya, sebab itu membunuh request pengguna (*downtime* mikro / *Connection Dropped*). Aplikasi Golang Anda harus mendukung pembaharuan (rotasi) memori pointer Sertifikat secara *lock-free* dan dinamis, yang dicolokkan ke field callback `tls.Config.GetCertificate`.
4. **Context Propagation & HTTP Client**: Di Go, TLS di-handle di layer Transport HTTP Client, sementara timeout diatur di layer Context. Membangun mTLS aman tidak cuma Server, Client-nya juga butuh Custom Transport.

## 2. Diagram ASCII: Alur mTLS dengan Rotasi Dinamis Memori

```text
[ Internal CA (cert-manager / Hashicorp Vault) ]
       |
       v (Memperbaharui file cert.pem dan key.pem tiap 1 jam)
+---------------------------------------------------------------+
|                      File System (Pod Disk)                   |
+---------------------------------------------------------------+
       |
       | (Background Watcher Go memonitor /inotify perubahan file)
       v
+-------------------------------+             <-- mTLS Handshake -->
| Service A (Client Go)         | ===========(Saling Lempar & Validasi)=========== | Service B (Server Go)        |
| - atomic.Pointer[Cert]        |                                                  | - atomic.Pointer[Cert]       |
| - GetClientCertificate func   |                                                  | - GetCertificate func        |
+-------------------------------+                                                  +------------------------------+
```

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: InsecureSkipVerify: true di Production

**Mengapa berbahaya (Exploit Vector)**: Karena membuat CA internal, developer sering malas mendistribusikan RootCA ke Container, dan malah mematikan pengecekan TLS dengan `InsecureSkipVerify: true`. Attacker bisa memutar lalu-lintas jaringan DNS lokal (DNS Spoofing / ARP Poisoning), dan bertindak sebagai Server B palsu. Golang *client* tidak akan peduli sertifikatnya bodong, dan memberikan payload rahasianya ke Hacker.

```go
// VULNERABLE: Menghancurkan pilar keamanan TLS
func httpClientVulnerable() *http.Client {
	// ❌ BAD: Mem-bypass verifikasi sertifikat peer, rawan serangan MitM.
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}
}
```

```go
// ✅ GOOD: Tambahkan sertifikat Root CA internal agar Go bisa memvalidasinya dengan benar
func httpClientSafe(rootCA []byte) *http.Client {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(rootCA) // Load Root CA
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs: pool,      // Validasi ketat peer server
			},
		},
	}
}
```

### ❌ Anti-Pattern 2: Lock Contention Saat Rotasi

**Mengapa berbahaya (Exploit Vector)**: Membaca cert file `.pem` dari sistem operasi (I/O) setiap kali *handshake* baru terjadi (ribuan TLS handshake per detik) akan menyebabkan Server hang. Atau, jika menggunakan standard `sync.Mutex` yang mengunci terlalu lama saat IO write pembaharuan, aplikasi mengalami kebuntuan (*Deadlock* atau ekstrim *latency spike*). Solusinya adalah pola asinkron via `atomic.Pointer`.

```go
// VULNERABLE: Menggunakan Mutex yang memblokir semua I/O dan Handshake
type BadCertManager struct {
	mu   sync.RWMutex
	cert *tls.Certificate
}

// ❌ BAD: Lock memblokir semua request selama IO/Update terjadi
func (m *BadCertManager) UpdateCert(newCert *tls.Certificate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cert = newCert
}
```

```go
// ✅ GOOD: Menggunakan atomic.Pointer yang non-blocking (lock-free)
type SafeCertManager struct {
	cert atomic.Pointer[tls.Certificate]
}

func (m *SafeCertManager) UpdateCert(newCert tls.Certificate) {
	m.cert.Store(&newCert) // Operasi O(1) aman tanpa Lock
}
```

## 4. Edge Cases & Defensive Programming Khusus Go

1. **CA Rotation dan "Chain of Trust" terputus**: Ketika perusahaan memutuskan mengganti *Root CA*, sertifikat lama dan baru bersilangan. Server harus bisa mem-parse *RootCA Bundle* (lebih dari 1 sertifikat CA `.pem` bertumpuk dalam satu file) agar mempercayai client lama dan client baru di waktu bersamaan masa transisi. Go mendukung ini dengan `.AppendCertsFromPEM()` berulang.
2. **Kelemahan Cipher Suite Lama**: Mencegah *Downgrade Attack* dari TLS 1.3 ke versi yang lemah/usang (TLS 1.0 yang rawan BEAST attack). Di Go, secara eksplisit atur `MinVersion: tls.VersionTLS13` (atau TLS 1.2 minimum dengan CurvePreferences ketat).
3. **Nilai Awal / Race Condition Load-Up**: Saat server Go pertama dinyalakan (boot), watcher rotasi background mungkin kalah cepat dengan request masuk HTTP pertama, menyebabkan pointer nil panic. Harus selalu lakukan sinkron pemuatan Sertifikat pertama kali sebelum `http.ListenAndServeTLS` atau pasang kontrol error (*fail-close* di callback).

## 5. Production-Ready Go Code

Implementasi arsitektur Manajemen Sertifikat *Thread-Safe* tanpa *Restart/Downtime* menggunakan Generic `atomic.Pointer`.

```go
package security

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
)

var (
	ErrCertNotLoaded    = errors.New("certificate is missing or not initialized yet")
	ErrInvalidRootCA    = errors.New("failed to append root CA, invalid format")
)

// DynamicCertManager memegang sertifikat mTLS secara memory-safe
// Memanfaatkan go 1.19+ atomic.Pointer untuk zero-downtime hot swapping.
type DynamicCertManager struct {
	certPointer atomic.Pointer[tls.Certificate]
}

// NewDynamicCertManager menginisialisasi rotasi sertifikat dengan state awal.
// Di dunia nyata: nilai ini diinisialisasi secara sinkron dengan membacanya dari disk.
func NewDynamicCertManager(initialCert tls.Certificate) *DynamicCertManager {
	manager := &DynamicCertManager{}
	manager.certPointer.Store(&initialCert)
	return manager
}

// UpdateCert dipanggil oleh goroutine terpisah (Watch/CronJob) yang
// membaca pembaruan file di K8S pod storage tanpa memblokir thread HTTP.
func (m *DynamicCertManager) UpdateCert(newCert tls.Certificate) {
	// Operasi O(1) atomic bebas kunci (Lock-free memory swap)
	m.certPointer.Store(&newCert)
}

// GetServerCertificate adalah callback untuk tls.Config server
func (m *DynamicCertManager) GetServerCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	cert := m.certPointer.Load()
	if cert == nil {
		// Fail-secure: Drop koneksi, bukan downgrade!
		return nil, ErrCertNotLoaded 
	}
	return cert, nil
}

// GetClientCertificate adalah callback untuk tls.Config klien
func (m *DynamicCertManager) GetClientCertificate(info *tls.CertificateRequestInfo) (*tls.Certificate, error) {
	cert := m.certPointer.Load()
	if cert == nil {
		return nil, ErrCertNotLoaded
	}
	return cert, nil
}

// CreateMTLSServerConfig merakit konfigurasi untuk Server pendengar
func CreateMTLSServerConfig(ctx context.Context, manager *DynamicCertManager, caPEM []byte) (*tls.Config, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("context timeout: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		return nil, ErrInvalidRootCA
	}

	return &tls.Config{
		GetCertificate: manager.GetServerCertificate,
		ClientAuth:     tls.RequireAndVerifyClientCert, // KEAMANAN mTLS INTI: Wajibkan klien memiliki cert
		ClientCAs:      caPool,                         // Validasi CA dari client
		MinVersion:     tls.VersionTLS13,               // Cegah TLS Downgrade
	}, nil
}

// ==========================================
// Unit Tests (Testing Security Boundaries)
// ==========================================

func TestMTLSCertificateRotation_InitialLoad(t *testing.T) {
	initialCert := tls.Certificate{Certificate: [][]byte{[]byte("cert_V1")}}
	manager := NewDynamicCertManager(initialCert)
	
	sc, err := manager.GetServerCertificate(nil)
	if err != nil || string(sc.Certificate[0]) != "cert_V1" {
		t.Fatalf("Failed initial GetServerCertificate")
	}
}

func TestMTLSCertificateRotation_HotSwap(t *testing.T) {
	initialCert := tls.Certificate{Certificate: [][]byte{[]byte("cert_V1")}}
	manager := NewDynamicCertManager(initialCert)
	
	updatedCert := tls.Certificate{Certificate: [][]byte{[]byte("cert_V2")}}
	manager.UpdateCert(updatedCert)
	
	scNew, err := manager.GetServerCertificate(nil)
	if err != nil || string(scNew.Certificate[0]) != "cert_V2" {
		t.Fatalf("Hot-Swap Failed. Expected V2 got %s", scNew.Certificate[0])
	}
}

func TestMTLSCertificateRotation_FailSecure(t *testing.T) {
	emptyManager := &DynamicCertManager{} // Tidak diinit Store()
	_, err := emptyManager.GetServerCertificate(nil)
	if err != ErrCertNotLoaded {
		t.Fatalf("Expected fail-secure drop (ErrCertNotLoaded) but got: %v", err)
	}
}

func TestMTLSCertificateRotation_InvalidCA(t *testing.T) {
	ctx := context.Background()
	initialCert := tls.Certificate{Certificate: [][]byte{[]byte("cert_V1")}}
	manager := NewDynamicCertManager(initialCert)

	_, err := CreateMTLSServerConfig(ctx, manager, []byte("MALFORMED_PEM_FILE_CONTENTS"))
	if err != ErrInvalidRootCA {
		t.Fatalf("Expected failure on invalid CA format, got: %v", err)
	}
}
```
