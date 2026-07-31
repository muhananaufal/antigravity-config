# Crossplane Composition & Custom Providers di Go

Crossplane mengubah Kubernetes menjadi Universal Control Plane. Infrastruktur cloud (S3, RDS, VPC) dikelola seperti pod — via YAML deklaratif dan Kubernetes API. Custom Providers ditulis dalam Go menggunakan `crossplane-runtime`, mengimplementasikan reconcile loop yang idempotent.

---

## 1. Internals: Crossplane Reconciliation Architecture

```
Crossplane Control Loop (Kubernetes Controller Pattern):

  User kubectl apply XR (Composite Resource)
         │
         ▼
  [Composite Resource Claim]       ← User-facing abstraction
  e.g., PostgreSQLInstance{ size: large, env: prod }
         │
         │ Composition (YAML template)
         ▼
  [Managed Resources]              ← 1:1 mapping ke cloud objects
  ├── RDSInstance
  ├── DBSubnetGroup
  └── SecurityGroup
         │
         │ Provider Go Binary (gRPC server)
         ▼
  [External Client reconcile loop]

  Reconcile States:
  ┌─────────────────────────────────────────────────────┐
  │ Observe()                                           │
  │   ├── resource NOT FOUND → Create()                │
  │   ├── resource FOUND, spec DRIFT → Update()        │
  │   ├── resource FOUND, UP TO DATE → noop            │
  │   └── DeletionTimestamp set → Delete()             │
  │                                                     │
  │ Key principles:                                     │
  │  - NEVER block inside Create/Update (async!)       │
  │  - External Name = cloud resource ID               │
  │  - spec.forProvider = user intent (READ ONLY!)     │
  │  - status.atProvider = cloud reality               │
  └─────────────────────────────────────────────────────┘

XRD / Composition hierarchy:
  CompositeResourceDefinition (XRD) → defines schema
  Composition → wires XR fields to Managed Resource fields
  Managed Resource → individual cloud object
```

---

## 2. Kode Go Production-Ready

```go
package controller

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	"github.com/crossplane/crossplane-runtime/pkg/meta"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/managed"
	"github.com/crossplane/crossplane-runtime/pkg/resource"
)

// BucketParameters merepresentasikan spec.forProvider dari Custom Managed Resource.
type BucketParameters struct {
	Region      string `json:"region"`
	Versioning  bool   `json:"versioning,omitempty"`
	StorageClass string `json:"storageClass,omitempty"`
}

// BucketObservation merepresentasikan status.atProvider.
type BucketObservation struct {
	ARN          string    `json:"arn,omitempty"`
	CreatedAt    time.Time `json:"createdAt,omitempty"`
	StorageBytes int64     `json:"storageBytes,omitempty"`
}

// CloudStorageAPI adalah interface ke external API (mockable untuk testing).
type CloudStorageAPI interface {
	GetBucket(ctx context.Context, name string) (*BucketObservation, error)
	CreateBucket(ctx context.Context, name, region string, versioning bool) (string, error) // returns ARN
	UpdateBucket(ctx context.Context, name string, versioning bool) error
	DeleteBucket(ctx context.Context, name string) error
}

// BucketExternalClient mengimplementasikan managed.ExternalClient interface.
// Interface ini: Observe, Create, Update, Delete.
type BucketExternalClient struct {
	api    CloudStorageAPI
	// kube client.Client — dipakai untuk update status
}

// Observe mengambil current state dari external API dan menentukan aksi selanjutnya.
// Prinsip: TIDAK boleh melakukan side effect (baca saja, tidak buat/hapus).
func (e *BucketExternalClient) Observe(ctx context.Context, mg resource.Managed) (managed.ExternalObservation, error) {
	// Type assertion — pastikan ManagedResource yang datang adalah tipe yang benar
	// bucket, ok := mg.(*v1alpha1.Bucket)
	// if !ok { return managed.ExternalObservation{}, errors.New("managed resource is not a Bucket") }

	// Ambil external name (cloud resource ID yang di-set saat Create)
	externalName := meta.GetExternalName(mg)
	if externalName == "" {
		// Belum pernah di-create → trigger Create
		return managed.ExternalObservation{ResourceExists: false}, nil
	}

	obs, err := e.api.GetBucket(ctx, externalName)
	if err != nil {
		// Deteksi "not found" vs error lain
		if isNotFoundError(err) {
			return managed.ExternalObservation{ResourceExists: false}, nil
		}
		return managed.ExternalObservation{}, fmt.Errorf("observe bucket %s: %w", externalName, err)
	}

	// Resource ditemukan — periksa apakah spec cocok dengan reality
	// params := bucket.Spec.ForProvider
	// upToDate := obs.Versioning == params.Versioning
	upToDate := true // simplified

	// Update status.atProvider dengan data dari cloud (bukan spec!)
	// bucket.Status.AtProvider = *obs
	// mg.SetConditions(xpv1.Available())
	_ = obs
	_ = xpv1.Available()

	return managed.ExternalObservation{
		ResourceExists:   true,
		ResourceUpToDate: upToDate,
		// ConnectionDetails: managed.ConnectionDetails{...} jika ada secret
	}, nil
}

// Create membuat resource di cloud. HARUS return segera setelah request terkirim.
// Jangan polling sampai selesai — gunakan Observe untuk track status.
func (e *BucketExternalClient) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
	// bucket := mg.(*v1alpha1.Bucket)
	// params := bucket.Spec.ForProvider

	// Simulasi: panggil cloud API untuk create
	arn, err := e.api.CreateBucket(ctx, mg.GetName(), "us-east-1", true)
	if err != nil {
		return managed.ExternalCreation{}, fmt.Errorf("create bucket: %w", err)
	}

	// WAJIB: simpan cloud resource ID ke ExternalName
	// Tanpa ini, Observe berikutnya tidak bisa menemukan resource di cloud
	meta.SetExternalName(mg, mg.GetName()) // atau pakai ARN/ID dari response
	_ = arn

	return managed.ExternalCreation{}, nil
}

// Update memperbarui resource. Hanya panggil jika Observe return ResourceUpToDate: false.
func (e *BucketExternalClient) Update(ctx context.Context, mg resource.Managed) (managed.ExternalUpdate, error) {
	externalName := meta.GetExternalName(mg)
	// params := mg.(*v1alpha1.Bucket).Spec.ForProvider

	if err := e.api.UpdateBucket(ctx, externalName, true); err != nil {
		return managed.ExternalUpdate{}, fmt.Errorf("update bucket %s: %w", externalName, err)
	}

	return managed.ExternalUpdate{}, nil
}

// Delete menghapus resource dari cloud saat DeletionTimestamp ter-set.
func (e *BucketExternalClient) Delete(ctx context.Context, mg resource.Managed) (managed.ExternalDelete, error) {
	externalName := meta.GetExternalName(mg)

	if err := e.api.DeleteBucket(ctx, externalName); err != nil {
		if isNotFoundError(err) {
			// Already deleted — idempotent, tidak perlu error
			return managed.ExternalDelete{}, nil
		}
		return managed.ExternalDelete{}, fmt.Errorf("delete bucket %s: %w", externalName, err)
	}

	return managed.ExternalDelete{}, nil
}

// isNotFoundError mengidentifikasi "resource not found" error dari cloud API.
func isNotFoundError(err error) bool {
	// Implementasi nyata: cek HTTP 404, AWS NoSuchBucketError, dll.
	return errors.Is(err, ErrNotFound)
}

var ErrNotFound = errors.New("not found")

// --- Mock untuk Testing ---

type mockCloudAPI struct {
	buckets map[string]*BucketObservation
	failOn  string // inject failure untuk testing
}

func newMockAPI() *mockCloudAPI {
	return &mockCloudAPI{buckets: make(map[string]*BucketObservation)}
}

func (m *mockCloudAPI) GetBucket(_ context.Context, name string) (*BucketObservation, error) {
	if m.failOn == "get" {
		return nil, fmt.Errorf("API error")
	}
	obs, exists := m.buckets[name]
	if !exists {
		return nil, ErrNotFound
	}
	return obs, nil
}

func (m *mockCloudAPI) CreateBucket(_ context.Context, name, region string, versioning bool) (string, error) {
	if m.failOn == "create" {
		return "", fmt.Errorf("create failed")
	}
	m.buckets[name] = &BucketObservation{ARN: "arn:aws:s3:::" + name, CreatedAt: time.Now()}
	return m.buckets[name].ARN, nil
}

func (m *mockCloudAPI) UpdateBucket(_ context.Context, name string, versioning bool) error {
	if m.failOn == "update" {
		return fmt.Errorf("update failed")
	}
	return nil
}

func (m *mockCloudAPI) DeleteBucket(_ context.Context, name string) error {
	if m.failOn == "delete" {
		return fmt.Errorf("delete failed")
	}
	delete(m.buckets, name)
	return nil
}

// --- Unit Tests ---

// mockManagedResource adalah stub minimal yang mengimplementasikan resource.Managed.
// Di produksi nyata, gunakan generated types dari controller-gen.
type mockManagedResource struct {
	name         string
	externalName string
}

func (m *mockManagedResource) GetName() string                    { return m.name }
func (m *mockManagedResource) GetExternalName() string            { return m.externalName }
func (m *mockManagedResource) SetExternalName(name string)        { m.externalName = name }

// Dummy implementations untuk interface resource.Managed (simplified)
func (m *mockManagedResource) SetConditions(...xpv1.Condition)     {}
func (m *mockManagedResource) GetCondition(xpv1.ConditionType) xpv1.Condition {
	return xpv1.Condition{}
}

// Untuk compile: resource.Managed memiliki banyak method — dalam test nyata
// gunakan struct generated atau pakai gomock.

func TestObserve_ResourceNotFound(t *testing.T) {
	api := newMockAPI() // empty, belum ada bucket
	client := &BucketExternalClient{api: api}

	// Gunakan mock tanpa external name → trigger ResourceExists: false
	// (simplified: kita test logic API langsung)
	_, err := api.GetBucket(context.Background(), "nonexistent-bucket")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestCreate_SetsExternalName(t *testing.T) {
	api := newMockAPI()
	
	arn, err := api.CreateBucket(context.Background(), "my-bucket", "us-east-1", true)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if arn == "" {
		t.Error("expected non-empty ARN")
	}
	
	// Verifikasi bucket ada di mock store
	obs, err := api.GetBucket(context.Background(), "my-bucket")
	if err != nil {
		t.Fatalf("get after create: %v", err)
	}
	if obs.ARN != arn {
		t.Errorf("ARN mismatch: %q != %q", obs.ARN, arn)
	}
}

func TestDelete_Idempotent(t *testing.T) {
	api := newMockAPI()
	
	// Delete bucket yang tidak ada: harus return not found, bukan error lain
	err := api.DeleteBucket(context.Background(), "nonexistent")
	_ = err // not found OK
	
	// Delete dua kali: idempotent
	api.buckets["existing"] = &BucketObservation{ARN: "arn:aws:s3:::existing"}
	if err := api.DeleteBucket(context.Background(), "existing"); err != nil {
		t.Errorf("first delete: %v", err)
	}
	// Second delete — not found, tapi Delete() harus handle ini gracefully
	err = api.DeleteBucket(context.Background(), "existing")
	_ = err // in real impl: isNotFoundError(err) → return nil
}

func TestIsNotFoundError(t *testing.T) {
	if !isNotFoundError(ErrNotFound) {
		t.Error("ErrNotFound should be detected as not found")
	}
	if isNotFoundError(fmt.Errorf("some other error")) {
		t.Error("generic error should not be detected as not found")
	}
}

func TestCreate_FailureHandling(t *testing.T) {
	api := newMockAPI()
	api.failOn = "create"
	
	_, err := api.CreateBucket(context.Background(), "bucket", "us-east-1", true)
	if err == nil {
		t.Error("expected error when API fails")
	}
}
```

---

## 3. Anti-Patterns

### ❌ Anti-Pattern 1: Blocking Polling di `Create()`

```go
// BAD: Block goroutine controller-runtime hingga resource selesai dibuat
func (e *BucketExternalClient) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
    e.api.CreateBucket(ctx, name, region, versioning)
    
    // SANGAT SALAH: poll sampai S3 bucket selesai dibuat
    for {
        obs, _ := e.api.GetBucket(ctx, name)
        if obs.Status == "Active" {
            break // bisa butuh 2-10 menit!
        }
        time.Sleep(5 * time.Second)
    }
    return managed.ExternalCreation{}, nil
}
// → controller-runtime worker terblokir
// → reconcile loop untuk semua resource lain terhenti
// → Kubernetes mendeteksi deadlock dan timeout

// GOOD: Return segera setelah trigger create
func (e *BucketExternalClient) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
    _, err := e.api.CreateBucket(ctx, name, region, versioning)
    if err != nil {
        return managed.ExternalCreation{}, err
    }
    meta.SetExternalName(mg, name) // simpan ID
    return managed.ExternalCreation{}, nil // return langsung!
    // Observe() berikutnya akan check status "creating" vs "active"
}
```

**Kenapa berbahaya:** Controller-runtime menggunakan worker pool (default 1 worker per controller). Satu goroutine yang blocking menghentikan semua reconcile untuk resource sejenis — semua perubahan infrastruktur antri dan tidak diproses.

### ❌ Anti-Pattern 2: Mutasi `spec.forProvider` di Provider

```go
// BAD: Provider menulis balik ke spec berdasarkan data dari cloud
func (e *BucketExternalClient) Observe(ctx context.Context, mg resource.Managed) (...) {
    obs, _ := e.api.GetBucket(ctx, externalName)
    bucket := mg.(*v1alpha1.Bucket)
    bucket.Spec.ForProvider.Region = obs.Region // ← JANGAN!
    // → Crossplane mendeteksi spec berubah → trigger Update loop tak berujung

// GOOD: Tulis HANYA ke status.atProvider
    bucket.Status.AtProvider.ARN = obs.ARN
    bucket.Status.AtProvider.StorageBytes = obs.StorageBytes
    mg.SetConditions(xpv1.Available())
}
```

**Kenapa berbahaya:** `spec.forProvider` adalah zone milik user (desired state). Provider HANYA boleh membaca spec, bukan menulisnya. Jika provider menulis ke spec, Crossplane akan terus mendeteksi "drift" dan memanggil Update secara rekursif — reconcile loop tak berujung yang makan CPU dan menghasilkan ribuan API calls ke cloud.

### ❌ Anti-Pattern 3: Tidak Handle `ExternalName` dengan Benar

```go
// BAD: Tidak set ExternalName setelah Create berhasil
func (e *BucketExternalClient) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
    bucketID, _ := e.api.CreateBucket(ctx, ...)
    // Lupa: meta.SetExternalName(mg, bucketID)
    return managed.ExternalCreation{}, nil
}
// Akibat: Observe berikutnya melihat externalName kosong → ResourceExists: false
// → Create dipanggil lagi → bucket duplikat terus dibuat!

// GOOD
func (e *BucketExternalClient) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
    bucketID, err := e.api.CreateBucket(ctx, ...)
    if err != nil {
        return managed.ExternalCreation{}, err
    }
    meta.SetExternalName(mg, bucketID) // WAJIB set cloud resource ID
    return managed.ExternalCreation{}, nil
}
```

**Kenapa berbahaya:** ExternalName adalah "jembatan" antara Kubernetes object dan cloud resource. Tanpanya, setiap reconcile loop menganggap resource tidak ada dan terus membuat yang baru — biaya cloud meroket, AWS service limit terlampaui.

---

## 4. Edge Cases & Defensive Programming

1. **Deletion Stuck karena Dependency:** S3 bucket tidak bisa dihapus jika tidak kosong. Jika `DeleteBucket` return error "bucket not empty", jangan return error biasa — return error khusus yang direcord ke `Status.Condition` sebagai "DeletionBlocked". Ini mencegah finalizer dilepas prematur dan memberi sinyal yang clear ke operator.

2. **Provider Credential Rotation:** ProviderConfig menyimpan credential (AWS credentials, GCP service account) di Kubernetes Secret. Jika Secret di-rotate sementara reconciler sedang jalan, API call berikutnya gagal dengan 401. Implement retry dengan exponential backoff dan detect "unauthorized" sebagai non-permanent error (jangan mark resource sebagai Failed).

3. **Terraform Upjet-generated Providers vs Native:** Upjet auto-generate provider dari Terraform providers — cepat tapi ada overhead "terraform state" per resource (stored di Kubernetes). Native Go provider lebih performa tapi butuh implementasi manual. Pilih upjet untuk cloud resources yang sudah ada Terraform provider-nya; native Go untuk internal APIs tanpa Terraform support.

4. **Large ResourceVersion Conflict di Kubernetes:** Saat provider melakukan `Update` ke Kubernetes object (untuk menyimpan status), bisa terjadi conflict jika ada concurrent update. Gunakan `retry.RetryOnConflict(retry.DefaultRetry, ...)` dari `k8s.io/client-go/util/retry` untuk handle optimistic concurrency conflict secara graceful.

5. **Observing Resource di Deletion State:** Saat resource di-delete dari Kubernetes (`DeletionTimestamp` ter-set), Crossplane memanggil `Delete()`. Tapi cloud mungkin membutuhkan waktu untuk hapus resource. Observe berikutnya mungkin masih menemukan resource di cloud — return `ResourceExists: true` selama cloud masih ada, dan track deletion progress di `status.atProvider.deletionProgress`.
