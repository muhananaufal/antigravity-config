# Panduan Definitif: mTLS & Zero-Downtime Certificate Rotation

> **Berlaku:** Go 1.21+ · `crypto/tls` · cert-manager · **Lihat juga:** `cybersecurity_zerotrust/spiffe_spire_workload.md` · `microservices_grpc/service_mesh_grpc_lb.md` · `security_owasp/secret_management_vault.md` · `cybersecurity_zerotrust/binary_signing_verification.md`

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
// ✅ GOOD: muat Root CA internal, dan sajikan identitas sendiri — ini mTLS,
// bukan TLS satu arah.
func httpClientSafe(rootCA []byte, sertifikatKlien tls.Certificate) (*http.Client, error) {
	pool := x509.NewCertPool()
	// Nilai kembalian WAJIB diperiksa. Bila PEM rusak, pool tetap ada tetapi
	// KOSONG — dan setiap koneksi gagal dengan "certificate signed by unknown
	// authority", galat yang menuduh peer padahal berkas CA Anda yang cacat.
	if !pool.AppendCertsFromPEM(rootCA) {
		return nil, errors.New("root CA tidak dapat dimuat")
	}
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:      pool,
				Certificates: []tls.Certificate{sertifikatKlien}, // identitas KITA
				MinVersion:   tls.VersionTLS13,                   // lihat Kasus Tepi 2
			},
		},
	}, nil
}
```

Perhatikan dua hal yang hilang dari bentuk yang biasa ditulis: contoh "aman" tanpa `Certificates` hanya melakukan TLS satu arah — server tetap tidak tahu siapa peneleponnya — dan tanpa `MinVersion` eksplisit, aturan yang ditulis sendiri di Kasus Tepi 2 tidak diterapkan pada contoh yang seharusnya menjadi teladan.

### ❌ Anti-Pattern 2: Lock Contention Saat Rotasi

**Mengapa berbahaya:** membaca berkas `.pem` dari disk **di dalam callback handshake** — pada ribuan handshake per detik — memasukkan I/O sinkron ke jalur terpanas yang ada. Itulah masalah sesungguhnya.

Perlu diluruskan: potongan "buruk" yang biasa ditampilkan untuk anti-pattern ini sebenarnya **tidak** menghasilkan masalah yang dijelaskan.

```go
// Sering dilabeli BAD — padahal ini baik-baik saja.
func (m *BadCertManager) UpdateCert(newCert *tls.Certificate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cert = newCert // penugasan pointer: nanodetik, bukan I/O
}
```

Tidak ada I/O di dalam kunci itu, dan **tidak ada kemungkinan deadlock sama sekali** — hanya satu kunci, tanpa nested lock, tanpa pemanggilan balik. Menyebutnya penyebab "deadlock atau lonjakan latensi ekstrem" salah menunjuk sasaran, dan orang yang percaya diagnosis itu akan mencari kunci di tempat yang salah saat benar-benar ada masalah.

```go
// BAD YANG SESUNGGUHNYA: I/O di dalam callback handshake
func (m *BadCertManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c, err := tls.LoadX509KeyPair("/etc/tls/tls.crt", "/etc/tls/tls.key") // dua syscall PER HANDSHAKE
	return &c, err
}
```

```go
// ✅ GOOD: muat di latar belakang, baca di handshake sebagai satu load atomik
type SafeCertManager struct {
	cert atomic.Pointer[tls.Certificate]
}

func (m *SafeCertManager) UpdateCert(newCert tls.Certificate) { m.cert.Store(&newCert) }
```

Alasan `atomic.Pointer` tetap lebih baik dari `RWMutex` di sini bukan soal deadlock, melainkan hal yang lebih sederhana: setiap handshake harus membaca pointer itu, dan pembacaan atomik tidak menyentuh baris cache yang sama dengan penulis maupun pembaca lain. Pada laju handshake tinggi dan banyak inti, `RLock` yang murah pun mulai terasa.

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

1. **CA Rotation — dan alasan `tls.Config` statis membuatnya mustahil**: saat Root CA diganti, CA lama dan baru harus dipercaya bersamaan selama masa transisi. Go mendukungnya lewat bundel PEM bertumpuk yang dibaca `AppendCertsFromPEM`. **Tetapi itu hanya setengah cerita.** `ClientCAs` pada sebuah `tls.Config` yang dirakit sekali saat start membeku selamanya: bundel di disk boleh berubah sesering apa pun, server tidak akan pernah melihatnya sampai proses di-restart — dan restart demi rotasi CA adalah persis yang ingin dihindari seluruh berkas ini. Yang membuatnya bekerja adalah `GetConfigForClient`, yang membangun ulang konfigurasi per koneksi masuk dari bundel terkini (lihat `KonfigServer` di §5). Di sisi klien, `RootCAs` punya masalah kembar dan jawabannya `DialTLSContext`.
2. **Kelemahan Cipher Suite Lama**: Mencegah *Downgrade Attack* dari TLS 1.3 ke versi yang lemah/usang (TLS 1.0 yang rawan BEAST attack). Di Go, secara eksplisit atur `MinVersion: tls.VersionTLS13` (atau TLS 1.2 minimum dengan CurvePreferences ketat).
3. **Nilai Awal / Race Condition Load-Up**: saat proses baru menyala, watcher rotasi bisa kalah cepat dengan permintaan pertama, dan pointer yang masih nil menghasilkan panic. Muat sertifikat pertama **secara sinkron sebelum** server mulai mendengar, dan tetap pasang cabang fail-close di callback sebagai jaring pengaman.

4. **Pemuatan ulang yang tidak divalidasi lebih berbahaya daripada tidak memuat ulang.** cert-manager menulis berkas; pembaca yang kebetulan bangun di tengah penulisan mendapat PEM terpotong. Bila bundel rusak itu langsung dipasang, **setiap** handshake berikutnya gagal — pemadaman total yang ditimbulkan oleh mekanisme rotasi itu sendiri, pada layanan yang sertifikat lamanya masih sepenuhnya sah. Aturannya: parse dan validasi dulu, pasang hanya bila berhasil, dan **pertahankan bundel lama** bila gagal.

5. **inotify sering tidak menyala di Kubernetes.** Secret dipasang lewat direktori bersimbol (`..data`) yang **ditukar** saat pembaruan; berkas yang Anda pantau tidak pernah benar-benar ditulisi, sehingga watcher pada path berkas bisa diam selamanya sementara isinya sudah berganti. Polling berkala dengan pembandingan sidik isi terlihat kurang elegan, tetapi ia bekerja di semua cara pemasangan — dan sertifikat yang tidak pernah dimuat ulang adalah kegagalan yang baru ketahuan saat kedaluwarsa.

6. **Sisa masa berlaku harus jadi metrik, bukan kejutan.** Tanpa mengekspos `NotAfter` dari sertifikat yang **sedang benar-benar disajikan**, tidak ada cara membedakan "rotasi berjalan" dari "rotasi berhenti tiga minggu lalu" — keduanya terlihat identik sampai hari kedaluwarsa. Pasang alert pada sisa masa berlaku, bukan pada kegagalan handshake; yang kedua datang terlambat.

## 5. Production-Ready Go Code

Implementasi arsitektur Manajemen Sertifikat *Thread-Safe* tanpa *Restart/Downtime* menggunakan Generic `atomic.Pointer`.

```go
package security

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

var (
	ErrBundelBelumDimuat = errors.New("bundel sertifikat belum dimuat")
	ErrRootCATidakValid  = errors.New("gagal mem-parse root CA")
	ErrSertifikatExpired = errors.New("sertifikat sudah kedaluwarsa")
)

// Bundel adalah SATU kesatuan yang dirotasi bersama: sertifikat identitas
// beserta kumpulan CA yang dipercaya.
//
// Keduanya harus berada di dalam satu pointer atomik, dan inilah yang tidak
// ada di versi sebelumnya. Merotasi sertifikat saja tidak cukup: ketika CA
// internal diganti, `ClientCAs` pada `tls.Config` yang dirakit sekali saat
// start TIDAK AKAN PERNAH berubah, dan klien yang sudah memakai CA baru
// ditolak sampai pod di-restart. Itu persis baris "Klien lama gagal setelah
// CA berganti" pada tabel deteksi berkas ini sendiri.
type Bundel struct {
	Sertifikat *tls.Certificate
	CAPool     *x509.CertPool
	NotAfter   time.Time
	sidik      [32]byte // sidik isi berkas, untuk mendeteksi perubahan
}

// MuatBundel membaca DAN memvalidasi sebelum bundel layak dipakai.
//
// Validasi ini bukan kemewahan: cert-manager menulis berkas, dan pembaca yang
// kebetulan bangun di tengah penulisan mendapat PEM terpotong. Tanpa
// pemeriksaan, bundel rusak itu terpasang dan SETIAP handshake berikutnya
// gagal — pemadaman yang disebabkan oleh mekanisme rotasi itu sendiri.
func MuatBundel(pathCert, pathKey, pathCA string) (*Bundel, error) {
	certPEM, err := os.ReadFile(pathCert)
	if err != nil {
		return nil, fmt.Errorf("baca sertifikat: %w", err)
	}
	keyPEM, err := os.ReadFile(pathKey)
	if err != nil {
		return nil, fmt.Errorf("baca kunci: %w", err)
	}
	caPEM, err := os.ReadFile(pathCA)
	if err != nil {
		return nil, fmt.Errorf("baca CA: %w", err)
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("sertifikat dan kunci tidak cocok atau rusak: %w", err)
	}
	// tls.X509KeyPair TIDAK mengisi cert.Leaf pada Go < 1.23. Diparse sendiri
	// supaya tanggal kedaluwarsa bisa diperiksa di sini dan diekspos sebagai
	// metrik — tanpa itu, tidak ada cara menjawab pertanyaan "kapan
	// sertifikat ini habis" dari dalam proses.
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse sertifikat daun: %w", err)
	}
	cert.Leaf = leaf

	if time.Now().After(leaf.NotAfter) {
		return nil, fmt.Errorf("%w: berakhir %s", ErrSertifikatExpired, leaf.NotAfter)
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, ErrRootCATidakValid
	}

	return &Bundel{
		Sertifikat: &cert,
		CAPool:     pool,
		NotAfter:   leaf.NotAfter,
		sidik:      sha256.Sum256(bytes.Join([][]byte{certPEM, keyPEM, caPEM}, nil)),
	}, nil
}

type ManajerBundel struct {
	bundel                    atomic.Pointer[Bundel]
	pathCert, pathKey, pathCA string
}

func NewManajerBundel(pathCert, pathKey, pathCA string) (*ManajerBundel, error) {
	m := &ManajerBundel{pathCert: pathCert, pathKey: pathKey, pathCA: pathCA}
	// Pemuatan pertama SINKRON — Kasus Tepi 3. Watcher yang kalah cepat
	// dengan permintaan pertama menghasilkan pointer nil.
	b, err := MuatBundel(pathCert, pathKey, pathCA)
	if err != nil {
		return nil, err
	}
	m.bundel.Store(b)
	return m, nil
}

// Pantau menyegarkan bundel secara berkala.
//
// POLLING, bukan inotify — dan itu disengaja, bertentangan dengan diagram
// versi lama. Kubernetes memasang Secret lewat direktori bersimbol (`..data`)
// yang DITUKAR saat pembaruan; berkas yang Anda pantau tidak pernah
// benar-benar ditulisi, sehingga watcher inotify pada path berkas sering
// tidak pernah menyala sama sekali. Membandingkan sidik isi setiap beberapa
// detik jauh lebih sederhana dan tidak pernah meleset.
func (m *ManajerBundel) Pantau(ctx context.Context, tiap time.Duration) {
	t := time.NewTicker(tiap)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			baru, err := MuatBundel(m.pathCert, m.pathKey, m.pathCA)
			if err != nil {
				// Bundel lama DIPERTAHANKAN. Berkas yang tertangkap di tengah
				// penulisan tidak boleh menjatuhkan layanan yang sedang sehat.
				slog.ErrorContext(ctx, "gagal memuat bundel, tetap memakai yang lama", "galat", err)
				continue
			}
			if lama := m.bundel.Load(); lama != nil && lama.sidik == baru.sidik {
				continue
			}
			m.bundel.Store(baru)
			slog.InfoContext(ctx, "bundel sertifikat dirotasi", "kedaluwarsa", baru.NotAfter)
		}
	}
}

// SisaBerlaku dipasang sebagai metrik. Baris pertama tabel deteksi menanyakan
// persis ini, dan sebelumnya tidak ada cara menjawabnya dari dalam proses.
func (m *ManajerBundel) SisaBerlaku() (time.Duration, error) {
	b := m.bundel.Load()
	if b == nil {
		return 0, ErrBundelBelumDimuat
	}
	return time.Until(b.NotAfter), nil
}

// KonfigServer memakai GetConfigForClient, bukan tls.Config statis.
//
// Inilah satu-satunya cara ClientCAs ikut berotasi: konfigurasi dibangun
// ulang per koneksi masuk dari bundel terkini.
func (m *ManajerBundel) KonfigServer() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			b := m.bundel.Load()
			if b == nil {
				return nil, ErrBundelBelumDimuat // fail-secure: putuskan koneksi
			}
			return &tls.Config{
				MinVersion:   tls.VersionTLS13,
				Certificates: []tls.Certificate{*b.Sertifikat},
				ClientAuth:   tls.RequireAndVerifyClientCert,
				ClientCAs:    b.CAPool,
			}, nil
		},
	}
}

// TransportKlien membangun konfigurasi TLS BARU pada setiap dial.
//
// Sisi klien sebelumnya tidak ada sama sekali, padahal §1 butir 4 dan diagram
// §2 keduanya menyebutnya. Perhatikan konfigurasi dirakit DI DALAM dial:
// tls.Config yang disimpan sekali di Transport membekukan RootCAs-nya,
// sehingga rotasi CA tidak pernah sampai ke sisi klien.
func (m *ManajerBundel) TransportKlien() *http.Transport {
	return &http.Transport{
		DialTLSContext: func(ctx context.Context, jaringan, alamat string) (net.Conn, error) {
			b := m.bundel.Load()
			if b == nil {
				return nil, ErrBundelBelumDimuat
			}
			host, _, err := net.SplitHostPort(alamat)
			if err != nil {
				return nil, fmt.Errorf("alamat tujuan: %w", err)
			}
			d := &tls.Dialer{Config: &tls.Config{
				MinVersion:   tls.VersionTLS13,
				ServerName:   host,
				RootCAs:      b.CAPool,
				Certificates: []tls.Certificate{*b.Sertifikat},
			}}
			return d.DialContext(ctx, jaringan, alamat)
		},
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}
}
```

Uji memakai sertifikat X.509 SUNGGUHAN dan handshake sungguhan. Uji versi sebelumnya memasukkan `[]byte("cert_V1")` sebagai "sertifikat" — ia membuktikan pertukaran pointer atomik berhasil, dan tidak satu pun klaim mTLS di berkas ini:

```go
package security

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type otoritas struct {
	sert *x509.Certificate
	kunci *ecdsa.PrivateKey
	pem  []byte
}

func buatCA(t *testing.T) otoritas {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("kunci CA: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "uji-ca"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatalf("buat CA: %v", err)
	}
	sert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse CA: %v", err)
	}
	return otoritas{sert: sert, kunci: k, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// tulisBundel menerbitkan sertifikat daun dan menuliskannya sebagai berkas,
// meniru apa yang dilakukan cert-manager di dalam pod.
func tulisBundel(t *testing.T, dir string, ca otoritas, cn string) (pathCert, pathKey, pathCA string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("kunci daun: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     []string{cn},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.sert, &k.PublicKey, ca.kunci)
	if err != nil {
		t.Fatalf("terbitkan daun: %v", err)
	}
	kDER, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		t.Fatalf("marshal kunci: %v", err)
	}

	pathCert = filepath.Join(dir, "tls.crt")
	pathKey = filepath.Join(dir, "tls.key")
	pathCA = filepath.Join(dir, "ca.crt")
	tulis := func(p string, b []byte) {
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatalf("tulis %s: %v", p, err)
		}
	}
	tulis(pathCert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	tulis(pathKey, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kDER}))
	tulis(pathCA, ca.pem)
	return
}

// mTLS yang benar-benar menolak klien tanpa sertifikat. Inilah klaim inti
// berkas ini, dan sebelumnya tidak diuji sama sekali.
func TestServerMenolakKlienTanpaSertifikat(t *testing.T) {
	dir := t.TempDir()
	ca := buatCA(t)
	m, err := NewManajerBundel(tulisBundel(t, dir, ca, "127.0.0.1"))
	if err != nil {
		t.Fatalf("NewManajerBundel: %v", err)
	}

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	srv.TLS = m.KonfigServer()
	srv.StartTLS()
	defer srv.Close()

	// Klien TANPA sertifikat: hanya mempercayai CA, tidak menyajikan identitas.
	tanpaSertifikat := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: poolDari(t, ca.pem)},
	}}
	resp, err := tanpaSertifikat.Get(srv.URL)
	if err == nil {
		resp.Body.Close()
		t.Fatal("klien tanpa sertifikat diterima — ClientAuth tidak ditegakkan")
	}

	// Klien DENGAN sertifikat dari CA yang sama: harus lolos.
	dengan := &http.Client{Transport: m.TransportKlien()}
	resp, err = dengan.Get(srv.URL)
	if err != nil {
		t.Fatalf("klien ber-sertifikat ditolak: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("kode = %d, mau 200", resp.StatusCode)
	}
}

// Berkas rusak di tengah penulisan TIDAK boleh menjatuhkan layanan sehat.
func TestBundelRusakTidakMenggantikanYangSehat(t *testing.T) {
	dir := t.TempDir()
	ca := buatCA(t)
	pathCert, pathKey, pathCA := tulisBundel(t, dir, ca, "127.0.0.1")
	m, err := NewManajerBundel(pathCert, pathKey, pathCA)
	if err != nil {
		t.Fatalf("NewManajerBundel: %v", err)
	}
	sebelum := m.bundel.Load()

	// Tulis PEM terpotong, persis seperti pembacaan di tengah penulisan.
	isi, _ := os.ReadFile(pathCert)
	if err := os.WriteFile(pathCert, isi[:len(isi)/2], 0o600); err != nil {
		t.Fatalf("potong berkas: %v", err)
	}
	if _, err := MuatBundel(pathCert, pathKey, pathCA); err == nil {
		t.Fatal("PEM terpotong diterima MuatBundel")
	}

	ctx, batal := context.WithCancel(context.Background())
	go m.Pantau(ctx, 10*time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	batal()

	if m.bundel.Load() != sebelum {
		t.Fatal("bundel rusak menggantikan bundel yang sehat")
	}
}

func TestSisaBerlakuTerbaca(t *testing.T) {
	dir := t.TempDir()
	ca := buatCA(t)
	m, err := NewManajerBundel(tulisBundel(t, dir, ca, "127.0.0.1"))
	if err != nil {
		t.Fatalf("NewManajerBundel: %v", err)
	}
	sisa, err := m.SisaBerlaku()
	if err != nil {
		t.Fatalf("SisaBerlaku: %v", err)
	}
	if sisa <= 0 || sisa > time.Hour {
		t.Fatalf("sisa berlaku = %s, di luar rentang yang diharapkan", sisa)
	}
}

func poolDari(t *testing.T, caPEM []byte) *x509.CertPool {
	t.Helper()
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM(caPEM) {
		t.Fatal("CA PEM tidak dapat dimuat")
	}
	return p
}
```

## Kapan JANGAN Pakai Ini

- **`InsecureSkipVerify: true` di luar uji lokal.** Ia mematikan verifikasi rantai **dan** nama sekaligus. Dengan satu baris itu, mTLS berubah menjadi enkripsi terhadap siapa pun yang bisa menyisipkan diri di jalur.
- **Sertifikat berumur panjang untuk beban kerja.** Sertifikat setahun berarti kunci yang bocor berlaku setahun. Sertifikat berumur jam dengan rotasi otomatis lebih aman **dan** memaksa otomasinya benar-benar bekerja — kegagalan rotasi ketahuan hari itu juga, bukan setahun kemudian.
- **Memuat sertifikat sekali saat start.** Rotasi tidak akan pernah berlaku sampai restart. `GetCertificate`/`GetClientCertificate` membaca ulang tanpa mengganggu koneksi berjalan.
- **CA sendiri tanpa rencana rotasi CA.** Mengganti CA yang tertanam di semua klien adalah operasi yang harus direncanakan **sebelum** dibutuhkan. Saat CA-nya bermasalah, sudah terlambat menyusun rencananya.
- **mTLS sebagai pengganti otorisasi.** Ia membuktikan identitas, bukan izin. Layanan yang terautentikasi tetap harus dibatasi apa yang boleh dilakukannya.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Koneksi tiba-tiba gagal serempak | tanggal kedaluwarsa sertifikat | Rotasi gagal dan tidak ada yang memantau |
| Rotasi tidak berlaku sampai pod di-restart | apakah `GetCertificate` dipakai | Sertifikat dimuat sekali saat start |
| `InsecureSkipVerify` ditemukan di kode produksi | konfigurasi TLS | Verifikasi dimatikan; mTLS jadi teater |
| Layanan bisa memanggil apa saja setelah autentikasi | kebijakan otorisasi | Identitas disamakan dengan izin |
| Klien lama gagal setelah CA berganti | apakah `ClientCAs` ikut dirotasi | `tls.Config` statis membekukan kumpulan CA; butuh `GetConfigForClient` |
| Berkas cert berubah tapi proses tidak melihatnya | mekanisme deteksi perubahan | inotify tidak menyala pada penukaran symlink Kubernetes |
| Handshake gagal serentak sesaat setelah rotasi | validasi sebelum pemasangan | PEM terbaca di tengah penulisan lalu langsung dipasang |

```bash
# Kedaluwarsa dan penerbit sertifikat yang benar-benar disajikan
openssl s_client -connect layanan:8443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# Verifikasi yang dimatikan -- setiap kemunculan di luar uji adalah temuan
grep -rn 'InsecureSkipVerify' --include='*.go' . | grep -v '_test.go'
gosec -include=G402 ./...

# Sertifikat yang dikelola cert-manager dan status pembaruannya
kubectl get certificates -A \
  -o custom-columns='NS:.metadata.namespace,NAMA:.metadata.name,SIAP:.status.conditions[0].status,KEDALUWARSA:.status.notAfter'

kubectl logs -l app=api --since=1h | grep -ciE 'x509|certificate has expired|bad certificate'
```
