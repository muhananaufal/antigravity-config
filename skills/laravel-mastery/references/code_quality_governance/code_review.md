# Laravel Enterprise Code Review Playbook

## 1. Filosofi dan Tujuan Code Review
Dalam pengembangan aplikasi Laravel level enterprise (Top 1% Quality), Code Review (Tinjauan Kode) bukanlah sekadar proses mencari kesalahan sintaksis atau "gatekeeping" dari developer senior ke junior. Code Review adalah proses **knowledge sharing**, **quality assurance (QA)**, dan penjaga utama dari arsitektur perangkat lunak (Clean Architecture).

Tujuan utama dari Code Review meliputi:
1. **Memastikan Keselarasan Arsitektur**: Memastikan kode baru mematuhi aturan Clean Architecture dan Domain-Driven Design (DDD).
2. **Keamanan dan Performa**: Menangkap potensi kelemahan keamanan (OWASP) dan masalah performa (N+1 queries, memory leaks, missing indexes).
3. **Keterbacaan dan Maintainability**: Memastikan kode dapat dipahami oleh developer lain tanpa perlu membaca dokumentasi panjang (Self-documenting code).
4. **Mendeteksi Technical Debt Dini**: Mencegah masuknya *code smells* ke dalam basis kode utama (main branch).

## 2. Alur Proses Code Review (Enterprise Standard)
Proses code review yang ideal berjalan secara asinkron namun memiliki Service Level Agreement (SLA) yang ketat (misalnya maksimal 24 jam untuk First Review).

### Tahap 1: Self-Review (Pre-Commit & Pre-Push)
Developer penulis kode WAJIB melakukan tinjauan pada kodenya sendiri sebelum membuat Pull Request (PR).
* Pastikan tidak ada `dd()`, `dump()`, atau `Log::info()` yang tertinggal.
* Pastikan semua *test case* berjalan hijau di mesin lokal.
* Verifikasi tidak ada perubahan file yang tidak disengaja (misal: format ulang seluruh file yang tidak relevan dengan PR).

### Tahap 2: Automated Review (CI/CD Pipeline)
Manusia sangat buruk dalam mendeteksi kesalahan sintaks standar. Biarkan mesin (bot) melakukan pekerjaan membosankan ini. Pipeline CI/CD WAJIB memiliki:
* **Laravel Pint / PHP CS Fixer**: Memastikan format kode sesuai PER-CS 2.0.
* **PHPStan (Level 8 atau 9)**: Analisis statis untuk memastikan *type safety* secara ketat.
* **Pest Arch Testing**: Memastikan arsitektur tidak dilanggar secara struktural.
* **SonarQube / CodeClimate**: Mendeteksi kompleksitas siklomatik, *code smells*, dan duplikasi kode.

### Tahap 3: Peer Review (Human Review)
Fokus manusia adalah pada *business logic*, desain arsitektur, penamaan variabel (naming convention), algoritma, dan *edge cases*.
* **Pola Pikir Peninjau (Reviewer)**: Bertanya, bukan menyuruh. Gunakan kalimat seperti "Apakah ada alasan khusus mengapa kita tidak menggunakan DTO di sini?" daripada "Ubah ini jadi DTO."
* **Pola Pikir Penulis (Author)**: Jangan defensif. Kode Anda bukan representasi harga diri Anda.

## 3. Pest v3 Architecture Testing
Sebagai bagian dari *Automated Review*, kita menggunakan fitur *Architecture Testing* dari Pest v3 untuk menegakkan aturan Clean Architecture secara terprogram.

```php
declare(strict_types=1);

namespace Tests\Architecture;

test('strict types digunakan di semua file aplikasi', function () {
    expect('App')
        ->toUseStrictTypes();
});

test('controllers tidak boleh berisi business logic', function () {
    expect('App\Http\Controllers')
        ->not->toUse('App\Models') // Controller tidak boleh memanggil model langsung (gunakan Action/Service)
        ->not->toUse('Illuminate\Support\Facades\DB'); // Tidak boleh ada query manual di Controller
});

test('domain layer harus independen dari framework', function () {
    expect('App\Domain')
        ->not->toUse('Illuminate\Http') // Domain tidak peduli soal HTTP Request
        ->not->toUse('App\Http\Controllers')
        ->not->toUse('Illuminate\Support\Facades'); // Hindari Facades di Domain Layer, gunakan Dependency Injection
});

test('actions hanya memiliki satu metode publik (handle/execute)', function () {
    expect('App\Actions')
        ->toHaveMethod('handle') // atau 'execute'
        ->toBeInvokable();
});

test('models hanya boleh digunakan oleh repositories atau actions', function () {
    expect('App\Models')
        ->toOnlyBeUsedIn([
            'App\Repositories',
            'App\Actions',
            'App\Observers',
            'Database\Factories',
            'Tests',
        ]);
});

test('tidak ada debugging code yang tertinggal', function () {
    expect(['dd', 'dump', 'ray', 'var_dump'])
        ->not->toBeUsed();
});
```

## 4. Anti-Patterns dalam Code Review (❌ vs ✅)

### Anti-Pattern 1: God Class Controller / Fat Controller
Sering terjadi developer menempatkan validasi, logika bisnis, pemrosesan data, dan respons HTTP di dalam Controller. Hal ini melanggar Single Responsibility Principle (SRP) dan membuat kode tidak bisa di-test secara terisolasi.

❌ **KODE SALAH (God Controller)**
```php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;

class RegisterUserController extends Controller
{
    public function store(Request $request)
    {
        // 1. Validasi manual (harusnya FormRequest)
        $request->validate([
            'name' => 'required',
            'email' => 'required|email|unique:users',
            'password' => 'required|min:8',
        ]);

        // 2. Transaksi Database Manual & Business Logic di Controller
        DB::beginTransaction();
        try {
            $user = User::create([
                'name' => $request->input('name'),
                'email' => $request->input('email'),
                'password' => Hash::make($request->input('password')),
                'is_active' => true,
            ]);

            // 3. Side Effects di Controller
            Mail::to($user->email)->send(new \App\Mail\WelcomeEmail($user));

            DB::commit();

            return response()->json(['user' => $user], 201);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json(['error' => 'Registration failed'], 500);
        }
    }
}
```
**Dampak pada kualitas/debt**: Sangat sulit untuk melakukan unit testing pada logika registrasi karena terikat pada HTTP Request. Jika kita ingin membuat user dari CLI (Artisan command) atau Job, kita harus menduplikasi logika ini.

✅ **KODE BENAR (Clean Architecture - Controller as a Router)**
```php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\Users\RegisterUserAction;
use App\DTOs\Users\RegisterUserData;
use App\Http\Requests\Users\RegisterUserRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class RegisterUserController extends Controller
{
    public function __invoke(
        RegisterUserRequest $request,
        RegisterUserAction $action
    ): JsonResponse {
        // FormRequest menangani validasi. Controller hanya orkestrasi.
        // DTO digunakan untuk passing data secara strongly-typed.
        $dto = RegisterUserData::fromRequest($request);

        // Action menangani business logic secara independen dari HTTP Layer.
        $user = $action->execute($dto);

        // Resource / JsonResponse untuk layer presentasi.
        return response()->json([
            'message' => 'User registered successfully',
            'data' => [
                'id' => $user->id,
                'email' => $user->email,
            ],
        ], Response::HTTP_CREATED);
    }
}
```
*(Catatan: Logika database transaction dan pengiriman email dipindahkan ke dalam `RegisterUserAction` dan menggunakan Event/Listener untuk side-effects).*

---

### Anti-Pattern 2: Untyped Arrays / "Array Blindness"
Penggunaan associative array secara masif untuk mentransfer data antar layer (Controller -> Action -> Job). Ini menyebabkan "Array Blindness" di mana developer harus men-debug (dump) kode untuk mengetahui struktur data yang dikirim.

❌ **KODE SALAH (Array Blindness)**
```php
declare(strict_types=1);

namespace App\Services;

use App\Models\Invoice;

class InvoiceService
{
    /**
     * Kita tidak tahu apa saja isi dari array $data!
     * Apakah ada 'amount'? Apakah 'due_date' berupa string atau Carbon?
     */
    public function generateInvoice(array $data): Invoice
    {
        return Invoice::create([
            'user_id' => $data['user_id'],
            'amount' => $data['amount'],
            'due_date' => $data['due_date'], // Risiko error jika key tidak ada
            'status' => 'pending'
        ]);
    }
}
```
**Dampak pada kualitas/debt**: IDE tidak bisa memberikan *auto-complete*. PHPStan tidak bisa memvalidasi tipe data. Jika struktur array berubah, tidak ada error yang terdeteksi hingga *runtime* (menyebabkan bug di production). Refactoring menjadi sangat berisiko.

✅ **KODE BENAR (Strongly Typed dengan DTO & PHP 8.3/8.4 Readonly Classes)**
```php
declare(strict_types=1);

namespace App\DTOs\Invoices;

use Carbon\CarbonImmutable;

final readonly class CreateInvoiceData
{
    public function __construct(
        public int $userId,
        public float $amount,
        public CarbonImmutable $dueDate,
    ) {}
}

namespace App\Actions\Invoices;

use App\DTOs\Invoices\CreateInvoiceData;
use App\Models\Invoice;

final class GenerateInvoiceAction
{
    public function execute(CreateInvoiceData $data): Invoice
    {
        // IDE memberikan autocomplete ($data->userId, $data->amount).
        // PHPStan dapat memvalidasi tipe data dengan sempurna secara statis.
        return Invoice::create([
            'user_id' => $data->userId,
            'amount' => $data->amount,
            'due_date' => $data->dueDate,
            'status' => 'pending',
        ]);
    }
}
```

## 5. Checklist Code Review Harian
Saat melakukan *peer review*, gunakan checklist berikut:
1. [ ] Apakah kode ini menyertakan `declare(strict_types=1);`?
2. [ ] Apakah semua property, argumen method, dan return type dideklarasikan tipenya? (PHP 8.3/8.4)
3. [ ] Apakah kode menggunakan class/method berukuran kecil (Single Responsibility)?
4. [ ] Apakah ada potensi N+1 Query? (Sudahkah menggunakan Eager Loading `with()`)?
5. [ ] Apakah ada hardcoded credentials/secrets? (Wajib menggunakan `config()`).
6. [ ] Apakah unit/feature test telah ditambahkan atau diperbarui untuk mencakup *edge cases*?
7. [ ] Apakah penamaan variabel dan fungsi sudah mewakili *domain language* (Ubiquitous Language)?

Dengan menerapkan standar code review ini, aplikasi Laravel enterprise Anda akan terhindar dari pembusukan perangkat lunak (software rot) dan technical debt yang tak terkendali.
