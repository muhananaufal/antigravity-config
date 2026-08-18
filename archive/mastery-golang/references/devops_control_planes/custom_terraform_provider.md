# Custom Terraform Provider (Terraform Plugin Framework)

> **Berlaku:** Go 1.21+ · Terraform Plugin Framework · **Lihat juga:** `devops_control_planes/crossplane_composition.md` · `cloud_provider_sdk/aws_sdk_go_v2.md` · `security_owasp/secret_management_vault.md` · `cli_tooling/config_precedence_viper.md`

Custom Terraform Provider memungkinkan tim platform mengekspos infrastruktur internal (private cloud, internal API, CMDB) sebagai Terraform resources. Sejak SDKv2 deprecated, `hashicorp/terraform-plugin-framework` adalah standar dengan model data yang type-safe dan support `null`/`unknown` states.

---

## 1. Internals: Terraform Plugin Protocol

```
Terraform Plugin Protocol 6 (gRPC):

  terraform plan/apply
         │
         │ gRPC (protobuf)
         ▼
  [Plugin Framework (tfprotov6)]
         │
         ├── GetProviderSchema → definisi semua resource/datasource
         ├── ValidateProviderConfig → validasi provider config
         ├── ConfigureProvider → init API client
         │
         ├── [Resource CRUD]
         │   ├── ReadResource (Refresh)
         │   ├── PlanResourceChange → diff plan
         │   ├── ApplyResourceChange → create/update/delete
         │   └── UpgradeResourceState → migration
         │
         └── [State Management]
             tftypes.Value → null | unknown | known

  Key tftypes semantics:
    null    = explicitly not set (like nil pointer)
    unknown = will be known after apply (computed fields)
    known   = has a value

  UseStateForUnknown PlanModifier:
    During plan, computed fields show as "(known after apply)"
    UseStateForUnknown → if field not changing, show current state value
    Prevents noisy diffs for stable computed fields like "id"
```

## 2. Diagram

```text
+-------------------+       gRPC        +----------------------------+
| Terraform Core    | <===============> | Custom Terraform Provider  |
| (CLI)             |                   | (Go Binary via plugin.Serve)|
+-------------------+                   +----------------------------+
        |                                       |
        | Plan / Apply                          | Create / Read / Update / Delete
        v                                       v
+-------------------+                   +----------------------------+
| Terraform State   |                   | Target API (REST/gRPC/dll) |
| (terraform.tfstate)|                  |                            |
+-------------------+                   +----------------------------+
```

## Kode Go Production-Ready

```go
package provider

import (
	"context"
	"fmt"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	rschema "github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// 1. Definisikan Provider
var _ provider.Provider = (*ExampleProvider)(nil)

type ExampleProvider struct {
	version string
}

func (p *ExampleProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "example"
	resp.Version = p.version
}

func (p *ExampleProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Attributes: map[string]schema.Attribute{
			"api_token": schema.StringAttribute{
				Required:  true,
				Sensitive: true,
			},
		},
	}
}

func (p *ExampleProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var apiToken types.String
	resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("api_token"), &apiToken)...)
	if resp.Diagnostics.HasError() {
		return
	}
	client := NewAPIClient(apiToken.ValueString())
	resp.DataSourceData = client
	resp.ResourceData = client
}

func (p *ExampleProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return nil
}

func (p *ExampleProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewServerResource,
	}
}

// 2. Definisikan Resource
var _ resource.Resource = (*serverResource)(nil)

func NewServerResource() resource.Resource {
	return &serverResource{}
}

type serverResource struct{}

// Struct yang merepresentasikan state dari resource "example_server"
type serverResourceModel struct {
	ID   types.String `tfsdk:"id"`
	Name types.String `tfsdk:"name"`
}

func (r *serverResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_server"
}

func (r *serverResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = rschema.Schema{
		Attributes: map[string]rschema.Attribute{
			"id": rschema.StringAttribute{
				Computed: true,
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"name": rschema.StringAttribute{
				Required: true,
			},
		},
	}
}

func (r *serverResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan serverResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Panggil API untuk membuat server
	// simulasi:
	createdID := "server-12345"
	plan.ID = types.StringValue(createdID)

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

func (r *serverResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state serverResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Panggil API untuk mendapatkan detail server dengan state.ID.ValueString()
	// Jika resource sudah tidak ada di backend, kita bisa menghapusnya dari state:
	// resp.State.RemoveResource(ctx)

	diags = resp.State.Set(ctx, &state)
	resp.Diagnostics.Append(diags...)
}

func (r *serverResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan serverResourceModel
	diags := req.Plan.Get(ctx, &plan)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Lakukan update ke API menggunakan plan.ID dan plan.Name

	diags = resp.State.Set(ctx, plan)
	resp.Diagnostics.Append(diags...)
}

func (r *serverResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state serverResourceModel
	diags := req.State.Get(ctx, &state)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}

	// Panggil API penghapusan dengan state.ID.ValueString()
}

// 3. Real Unit Tests (tanpa need Terraform binary)
func TestServerResource_SchemaHasRequiredAttributes(t *testing.T) {
	r := NewServerResource()
	var schemaResp resource.SchemaResponse
	r.Schema(context.Background(), resource.SchemaRequest{}, &schemaResp)

	attrs := schemaResp.Schema.Attributes
	if _, ok := attrs["id"]; !ok {
		t.Error("schema missing 'id' attribute")
	}
	if _, ok := attrs["name"]; !ok {
		t.Error("schema missing 'name' attribute")
	}
}

func TestServerResource_MetadataTypeName(t *testing.T) {
	r := NewServerResource()
	var metaResp resource.MetadataResponse
	r.Metadata(context.Background(), resource.MetadataRequest{ProviderTypeName: "example"}, &metaResp)

	if metaResp.TypeName != "example_server" {
		t.Errorf("TypeName = %q, want example_server", metaResp.TypeName)
	}
}

func TestExampleProvider_Metadata(t *testing.T) {
	p := &ExampleProvider{version: "1.2.3"}
	var resp provider.MetadataResponse
	p.Metadata(context.Background(), provider.MetadataRequest{}, &resp)

	if resp.TypeName != "example" {
		t.Errorf("TypeName = %q, want example", resp.TypeName)
	}
	if resp.Version != "1.2.3" {
		t.Errorf("Version = %q, want 1.2.3", resp.Version)
	}
}

func TestServerResourceModel_NullSafetyCheck(t *testing.T) {
	// Verifikasi bahwa types.String zero value adalah null (bukan empty string)
	// Ini penting untuk Terraform null vs empty semantics
	var model serverResourceModel
	if !model.ID.IsNull() {
		t.Error("zero value types.String should be null")
	}
	if !model.Name.IsNull() {
		t.Error("zero value types.String should be null")
	}

	// Setelah di-set, harus berubah ke known
	model.ID = types.StringValue("server-001")
	if model.ID.IsNull() || model.ID.IsUnknown() {
		t.Error("after SetValue, should be known")
	}
	if model.ID.ValueString() != "server-001" {
		t.Errorf("ValueString() = %q, want server-001", model.ID.ValueString())
	}
}
```

## 4. Anti-Patterns

### ❌ Anti-Pattern 1: Mengakses `.ValueString()` pada Unknown Type

```go
// BAD: Panic atau return string kosong untuk unknown values
func (r *serverResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
    var plan serverResourceModel
    req.Plan.Get(ctx, &plan)
    
    apiClient.UpdateServer(plan.ID.ValueString()) // PANIC jika ID masih unknown!
    // Terjadi saat plan phase: ID computed, belum diketahui
}

// GOOD: Guard dengan IsUnknown() / IsNull() check
func (r *serverResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
    var plan serverResourceModel
    req.Plan.Get(ctx, &plan)
    
    if plan.ID.IsUnknown() || plan.ID.IsNull() {
        resp.Diagnostics.AddError("Invalid State", "server ID is unknown during update")
        return
    }
    apiClient.UpdateServer(plan.ID.ValueString())
}
```

**Kenapa berbahaya:** Terraform Plugin Framework menggunakan tipe `types.String` yang bisa bernilai `null`, `unknown`, atau `known`. Memanggil `.ValueString()` pada state `unknown` mengembalikan string kosong — bukan panic, tapi menghasilkan API call dengan ID kosong yang sulit di-debug.

### ❌ Anti-Pattern 2: Tidak Handle 404 di `Read()` — State Drift

```go
// BAD: Error dari API langsung dijadikan error reconciliation
func (r *serverResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
    var state serverResourceModel
    req.State.Get(ctx, &state)
    
    server, err := apiClient.GetServer(state.ID.ValueString())
    if err != nil {
        resp.Diagnostics.AddError("Read Error", err.Error()) // ← stop di sini
        return
    }
    // Jika server dihapus manual: error 404, terraform stuck, tidak bisa plan/apply
}

// GOOD: Hapus dari state jika resource sudah tidak ada di backend
func (r *serverResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
    var state serverResourceModel
    req.State.Get(ctx, &state)
    
    server, err := apiClient.GetServer(state.ID.ValueString())
    if isNotFoundError(err) {
        resp.State.RemoveResource(ctx) // terraform tahu resource perlu di-create ulang
        return
    }
    if err != nil {
        resp.Diagnostics.AddError("Read Error", err.Error())
        return
    }
    // update state dengan data fresh dari API
    state.Name = types.StringValue(server.Name)
    resp.State.Set(ctx, state)
}
```

**Kenapa berbahaya:** Resource yang dihapus di luar Terraform (misal manual di cloud console) menyebabkan `Read()` error terus-menerus. `terraform plan` tidak bisa berjalan → infrastructure drift tidak bisa diperbaiki. Self-healing via `RemoveResource()` memungkinkan Terraform recover otomatis.

### ❌ Anti-Pattern 3: Sensitive Attribute Log Leakage

```go
// BAD: Log API token yang Sensitive ke stderr
func (p *ExampleProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
    var apiToken types.String
    req.Config.GetAttribute(ctx, path.Root("api_token"), &apiToken)
    
    tflog.Debug(ctx, "configuring provider", map[string]interface{}{
        "api_token": apiToken.ValueString(), // ← leaked ke CI/CD logs!
    })
}

// GOOD: Mask sensitive fields di log, atau tidak log sama sekali
func (p *ExampleProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
    var apiToken types.String
    req.Config.GetAttribute(ctx, path.Root("api_token"), &apiToken)
    
    tflog.Debug(ctx, "configuring provider", map[string]interface{}{
        "api_token_set": !apiToken.IsNull(), // hanya log boolean: token ada/tidak
    })
    // Atau: masking otomatis di tflog
    ctx = tflog.MaskFieldValuesWithFieldKeys(ctx, "api_token")
}
```

**Kenapa berbahaya:** Terraform debug logs (`TF_LOG=DEBUG`) sering diaktifkan di CI/CD untuk troubleshooting. Token yang ter-log bisa terekam di CI log storage (GitHub Actions, Jenkins) yang diakses banyak orang → credential leak → security incident.

## 5. Edge Cases & Defensive Programming

1. **Null vs Empty String Semantics:** Di Terraform Plugin Framework, `types.StringNull()` (tidak di-set user) berbeda dengan `types.StringValue("")` (user set ke string kosong). Backend API mungkin memperlakukan keduanya berbeda. Selalu cek `.IsNull()` sebelum passing ke API: jika null → skip field, jika empty string → explicit empty.

2. **Drift Detection via Canonical Form:** API backend bisa normalize data (contoh: mengubah `"US-EAST-1"` ke `"us-east-1"` atau memotong trailing whitespace). Jika `Read()` tidak meng-update state dengan canonical form dari API, setiap `plan` akan menunjukkan diff meski tidak ada perubahan nyata. Gunakan `SemanticEquals()` atau normalize di `Read()` sebelum set state.

3. **Timeouts Context Propagation:** Terraform bisa dibatalkan user (`Ctrl+C`). Provider yang tidak meneruskan `ctx` ke API call tidak akan respond terhadap pembatalan → `terraform destroy` atau `terraform apply` hang hingga process di-kill paksa. Selalu gunakan `req.Context()` atau pass `ctx` dari function parameter ke semua HTTP/gRPC calls.

4. **Schema Evolution dan State Migration:** Jika schema berubah (misal rename attribute atau ubah tipe), state lama yang tersimpan tidak kompatibel → `terraform plan` error. Implementasikan `StateUpgraders` di resource untuk migrate state dari versi lama ke baru secara otomatis. Bump `resource.SchemaVersion` saat ada breaking schema change.

5. **Parallel Resource Operations:** Terraform mengeksekusi beberapa resources secara parallel (`-parallelism=10` default). Provider harus thread-safe. API client yang di-share antara goroutines harus aman untuk concurrent use (atau buat instance per operation jika API client tidak thread-safe).

## Kapan JANGAN Pakai Ini

- **Untuk API yang sudah punya provider resmi.** Pemeliharaannya berlaku selamanya, mengikuti setiap perubahan API hulu, dan bebannya jatuh ke tim Anda — bukan ke vendor.
- **Provider tanpa dukungan impor state.** Sumber daya yang sudah ada tidak bisa diadopsi, dan pengguna terpaksa menghapus lalu membuat ulang. Pada database produksi, itu bukan opsi.
- **Operasi non-idempoten di `Create`/`Update`.** Terraform akan memanggil ulang setelah kegagalan sebagian atau timeout. Setiap operasi WAJIB aman diulang.
- **Menyimpan rahasia di state tanpa menandainya sensitif.** State Terraform sering berada di bucket yang lebih banyak orang bisa baca daripada yang diperkirakan, dan nilainya tersimpan dalam bentuk polos.
- **Provider tanpa retry dan penghormatan rate limit.** `terraform apply` menjalankan operasi secara paralel; provider yang naif akan menabrak kuota API dan menghasilkan kegagalan yang tampak acak.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| `apply` gagal acak pada rencana besar | paralelisme vs rate limit API | Provider tidak menghormati kuota |
| Sumber daya duplikat setelah kegagalan | idempotensi `Create` | Operasi diulang dan membuat dua objek |
| Rahasia terbaca di file state | penandaan `Sensitive` | Nilai tersimpan polos di state |
| Sumber daya yang ada tidak bisa dikelola | dukungan `ImportState` | Tidak ada jalur adopsi |
| `plan` selalu menunjukkan perubahan | pemetaan API ke state | Field yang diisi server tidak diabaikan |

```bash
TF_LOG=DEBUG terraform apply 2>&1 | grep -iE 'rate|throttl|429' | head
terraform plan -detailed-exitcode   # exit 2 = ada perubahan; selalu 2 berarti drift palsu

# Rahasia di state
terraform show -json | jq -r '.. | .values? // empty' | grep -iE 'password|secret|token' | head

terraform providers schema -json | jq '.provider_schemas | keys'
```
