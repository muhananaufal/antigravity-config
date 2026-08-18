# Panduan Definitif Keamanan API di Laravel 11/12 (API Security)

## 1. Pendahuluan

Dalam era pengembangan sistem terdistribusi modern, arsitektur *microservices*, dan aplikasi klien berbasis *Single Page Application* (SPA) atau *Mobile*, *Application Programming Interface* (API) merupakan tulang punggung komunikasi pertukaran data. Keamanan API bukan sekadar fitur tambahan, melainkan pondasi operasional yang mutlak. *Open Web Application Security Project* (OWASP) telah mengidentifikasi daftar ancaman paling kritis khusus untuk API (OWASP API Security Top 10). Beberapa kerentanan yang paling merusak di antaranya adalah *Broken Object Level Authorization* (BOLA), *Broken Authentication*, *Improper Assets Management*, serta *Mass Assignment / Data Exposure*.

Laravel versi 11 dan 12, ketika dipadukan dengan fitur-fitur modern dari PHP 8.3 dan 8.4, memberikan persenjataan keamanan *out-of-the-box* yang sangat tangguh. Kendati demikian, kerangka kerja (framework) seaman apa pun tidak akan berguna apabila lapisan logika bisnis diimplementasikan secara ceroboh. Dokumen ini menyajikan panduan mendalam tentang bagaimana merancang, membangun, dan menguji API yang sangat aman dengan menerapkan prinsip Arsitektur Bersih (*Clean Architecture*), pengetikan statis ketat (*Strict Typing*), pemisahan tanggung jawab (*Separation of Concerns*), dan otomasi pengujian menggunakan Pest v3.

---

## 2. Fundamental Keamanan Ekosistem API Laravel

Sebelum melangkah ke ranah arsitektur lanjutan, pastikan API Anda selalu mematuhi pedoman keamanan esensial berikut:

1. **HTTPS/TLS Enforced**: Jangan pernah mengekspos endpoint API dalam protokol HTTP biasa. Gunakan fitur pengalihan otomatis pada lapisan infrastruktur (Nginx/Traefik) atau melalui *middleware* di Laravel (`URL::forceScheme('https')`).
2. **Stateless Authentication**: API harus bersifat tanpa status (*stateless*). Hindari penggunaan sesi (*sessions*). Gunakan Laravel Sanctum untuk SPA otentikasi berbasis *cookie* ringan atau *API Tokens*, dan gunakan Laravel Passport untuk implementasi spesifikasi OAuth2 secara penuh.
3. **Konfigurasi Keamanan CORS**: Laravel 11 merevisi penanganan *Cross-Origin Resource Sharing* (CORS). Pastikan file konfigurasi `config/cors.php` mengatur `allowed_origins` dengan nama domain yang spesifik secara eksplisit, alih-alih menggunakan karakter *wildcard* (`*`) di lingkungan *production*.
4. **Rate Limiting Dinamis**: Lindungi API dari serangan *Denial of Service* (DDoS) dan *brute force* menggunakan *throttling*. API yang baik harus memberikan kuota yang berbeda berdasarkan peran (pengguna tidak terautentikasi vs pengguna terautentikasi vs level administrator).
5. **Menyembunyikan Informasi Sensitif (Error Handling)**: Pada mode produksi (`APP_DEBUG=false`), Laravel akan meredam pelacakan *stack trace*. Gunakan penangan eksepsi (*Exception Handler*) bawaan untuk memastikan setiap kesalahan logika aplikasi selalu mengembalikan respon JSON standar tanpa mengekspos *query database* atau alur memori.

---

## 3. Implementasi Clean Architecture pada Operasi Kritis API

Prinsip *Clean Architecture* mewajibkan kita memisahkan logika validasi (*FormRequest*), orkestrasi respons (*Controller*), logika bisnis inti (*Action/Service*), serta lapisan akses data (*Repository*). Berikut adalah implementasi dunia nyata yang sepenuhnya menggunakan fitur pengetikan ketat PHP 8.4 untuk alur pembaruan kata sandi pengguna secara aman.

### Lapisan 1: Validasi Input (FormRequest)

Tidak boleh ada permintaan dari luar yang langsung menyentuh lapisan *Controller* tanpa melalui validasi. Kita memanfaatkan aturan kata sandi (*Password Rules*) bawaan Laravel untuk memastikan sandi yang dimasukkan kuat dan belum pernah bocor di publik.

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\User;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Password;

final class UpdatePasswordRequest extends FormRequest
{
    /**
     * Memastikan hanya pengguna yang terautentikasi yang dapat mengakses FormRequest ini.
     */
    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    /**
     * Mendefinisikan aturan validasi yang sangat ketat.
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'current_password' => [
                'required',
                'string',
                'current_password:api' // Memvalidasi sandi saat ini berdasarkan *guard* API
            ],
            'new_password' => [
                'required',
                'string',
                'confirmed',
                // Aturan Password Kuat: Minimal 12 karakter, huruf, angka, simbol, dan periksa apakah kompromi (HIBP API)
                Password::min(12)->letters()->mixedCase()->numbers()->symbols()->uncompromised(),
            ],
        ];
    }
}
```

### Lapisan 2: Lapisan Akses Data (Repository dan Kontrak)

Akses langsung melalui *Eloquent Model* di lapisan layanan dapat menyebabkan ketergantungan yang kaku (*tight coupling*). Kita akan mendeklarasikan kontrak antarmuka dan implementasi fisiknya.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Models\User;

interface UserRepositoryInterface
{
    public function findById(int $id): ?User;
    public function updatePassword(int $userId, string $hashedPassword): bool;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Eloquent;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Database\DatabaseManager;
use Carbon\CarbonImmutable;

final readonly class EloquentUserRepository implements UserRepositoryInterface
{
    public function __construct(
        private DatabaseManager $db
    ) {}

    public function findById(int $id): ?User
    {
        return User::query()->find($id);
    }

    public function updatePassword(int $userId, string $hashedPassword): bool
    {
        // Menggunakan Query Builder secara langsung untuk menghindari pemicu Event berlebihan jika tidak diperlukan
        // sekaligus membatasi pengeluaran ke memori.
        $affectedRows = $this->db->table('users')
            ->where('id', '=', $userId)
            ->update([
                'password' => $hashedPassword,
                'updated_at' => CarbonImmutable::now(),
            ]);

        return $affectedRows > 0;
    }
}
```

### Lapisan 3: Logika Bisnis (Action Class)

*Action Class* berfungsi murni untuk menyelesaikan satu tugas bisnis tunggal. Class ini harus bersifat *stateless* dan berpotensi digunakan kembali oleh antarmuka apa pun, baik dari API, Command Line (Artisan), maupun Event Listeners.

```php
<?php

declare(strict_types=1);

namespace App\Actions\User;

use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

final readonly class UpdateUserPasswordAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    /**
     * Mengeksekusi pembaruan sandi secara aman.
     * 
     * @param int $userId
     * @param string $newPassword
     * @return void
     * @throws ValidationException
     */
    public function execute(int $userId, string $newPassword): void
    {
        $user = $this->userRepository->findById($userId);
        
        if ($user === null) {
            // Mencatat aktivitas percobaan manipulasi terhadap user_id yang tidak valid
            Log::warning('Upaya pembaruan kata sandi untuk pengguna non-eksisten.', ['user_id' => $userId]);
            abort(404, 'Data pengguna tidak ditemukan pada sistem.');
        }

        // Jangan pernah melakukan hash password secara hardcoded seperti md5 atau sha1.
        // Gunakan Hash facade bawaan Laravel (Argon2id atau Bcrypt secara default).
        $hashedPassword = Hash::make($newPassword);
        
        $success = $this->userRepository->updatePassword($user->id, $hashedPassword);
        
        if (!$success) {
            Log::error('Kegagalan sistem saat memperbarui kata sandi di database.', ['user_id' => $userId]);
            abort(500, 'Kesalahan internal saat menyimpan data yang telah diperbarui.');
        }

        Log::info('Kata sandi berhasil diperbarui oleh pengguna.', ['user_id' => $userId]);
    }
}
```

### Lapisan 4: Pengontrol API (API Controller)

*Controller* ini sekarang sangat tipis dan murni fokus terhadap pengaturan aliran antara permintaan masuk (Request) dan respons keluar (Response).

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\User;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\User\UpdatePasswordRequest;
use App\Actions\User\UpdateUserPasswordAction;
use Illuminate\Http\JsonResponse;

final class UserPasswordController extends Controller
{
    public function __construct(
        private readonly UpdateUserPasswordAction $updatePasswordAction
    ) {}

    /**
     * Memperbarui sandi pengguna (User Profile).
     */
    public function update(UpdatePasswordRequest $request): JsonResponse
    {
        // $request->validated() memastikan kita tidak mengambil input acak.
        $newPassword = (string) $request->validated('new_password');
        
        // $request->user() bersifat dijamin eksistensinya oleh middleware otentikasi.
        $this->updatePasswordAction->execute(
            userId: (int) $request->user()->id,
            newPassword: $newPassword
        );

        return response()->json([
            'status' => 'success',
            'message' => 'Kata sandi Anda telah berhasil diperbarui dengan aman.',
        ], 200);
    }
}
```

---

## 4. Analisis Anti-Pattern Keamanan API di Laravel

Untuk mendalami keamanan secara holistik, sangat penting mempelajari kesalahan masa lalu dan mengerti kerentanan tingkat rendah. Bagian ini membandingkan penulisan yang cacat secara keamanan (❌ *Anti-Pattern*) dengan implementasi yang kokoh (✅ *Best Practice*).

### Anti-Pattern 1: Insecure Direct Object References (IDOR) & Broken Authorization

IDOR (atau BOLA dalam nomenklatur khusus API) terjadi jika sistem API mengandalkan identifier dari input klien tanpa melakukan otorisasi berlapis untuk mengecek kepemilikan data aktual pengguna.

**❌ KODE SALAH (Beresiko Terserang IDOR)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Invoice;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

final class InvoiceController extends Controller
{
    // Celah Kritis: Menerima ID faktur secara buta dan mengembalikannya ke klien
    public function show(Request $request, int $id): JsonResponse
    {
        $invoice = Invoice::findOrFail($id);
        
        // BENCANA: User A bisa mencoba URL /api/invoices/2 
        // dan dapat melihat faktur rahasia milik User B tanpa verifikasi otoritas!
        
        return response()->json([
            'data' => $invoice
        ]);
    }
}
```

**✅ KODE BENAR (Mencegah IDOR melalui Middleware & Policy Otorisasi)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Invoice;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;

final class SecureInvoiceController extends Controller
{
    use AuthorizesRequests;

    public function show(Request $request, int $id): JsonResponse
    {
        $invoice = Invoice::findOrFail($id);
        
        // AMAN: Memanggil Laravel Policy (`InvoicePolicy`) untuk memastikan 
        // secara absolut apakah user yang sedang masuk adalah pemilik Invoice tersebut.
        $this->authorize('view', $invoice);
        
        return response()->json([
            'data' => $invoice
        ]);
    }
}
```
**Penjelasan Kerentanan IDOR**: Tanpa otorisasi pada tingkat kepemilikan objek (`$this->authorize('view', $model)`), setiap pengguna terautentikasi dapat mengekstrak seluruh basis data aplikasi secara linear menggunakan bot *scraper* yang mengurutkan nomor *integer ID* dari `1` hingga `N`. Anda wajib membentenginya menggunakan mekanisme *Policy*, atau mengubah tipe *Primary Key* menjadi entitas UUID/ULID bawaan Laravel, yang mustahil untuk ditebak urutannya.

---

### Anti-Pattern 2: Mass Assignment dan Data Exposure Vulnerability

Salah satu kesalahan paling jamak di Laravel adalah mengaktifkan penugasan massal (*mass assignment*) pada *Model Eloquent* secara membabi buta, yang pada akhirnya menimpa status krusial pada tabel, seperti manipulasi level akses admin atau saldo keuangan.

**❌ KODE SALAH (Beresiko Terserang Mass Assignment & Type Juggling)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;

final class UserProfileController extends Controller
{
    public function update(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        
        // BENCANA KRITIS: Meneruskan array payload ($request->all()) secara langsung!
        // Jika klien jahat mengirimkan {"name": "Hacker", "is_admin": true, "balance": 9999999}
        // Dan apabila model tidak membatasi field $fillable, data akan langsung dieksekusi masuk ke DB!
        $user->update($request->all());
        
        return response()->json($user); // Kebocoran tambahan: Mengekspos seluruh isi row (termasuk hidden fields)
    }
}
```

**✅ KODE BENAR (Strict FormRequest & Data Transfer Objects)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Api\User\UpdateProfileRequest;
use App\Http\Resources\UserResource;

final class SecureUserProfileController extends Controller
{
    public function update(UpdateProfileRequest $request): UserResource
    {
        $user = $request->user();
        
        // AMAN: Hanya mengambil input yang telah disetujui lewat FormRequest.
        // Semua field tak terduga (seperti `is_admin`, `balance`) akan diabaikan.
        $safeData = $request->validated();
        
        $user->update([
            'name'  => (string) $safeData['name'],
            'email' => (string) $safeData['email'],
            // Menutup secara statis akses field yang sifatnya destruktif
        ]);
        
        // AMAN: Mengembalikan representasi data menggunakan API Resource,
        // sehingga field sensitif seperti `password`, `remember_token`, atau metadata admin 
        // secara definitif dibuang dan tidak terlihat di JSON Response.
        return new UserResource($user);
    }
}
```

**Penjelasan Kerentanan Mass Assignment**: Menerima objek yang tidak jelas dari *request JSON* HTTP dan menginjeksinya secara langsung ke lapisan basis data berisiko tinggi. Kombinasi yang tangguh memanfaatkan batas properti (`$fillable` atau `$guarded` di Model Eloquent), mengambil data melalui metode `$request->validated()`, dan mengkonversi hasil luaran balik ke pihak klien melalui pengurai lapisan presentasi (`JsonResource` atau kelas DTO) guna mencegah Data Exposure.

---

### Anti-Pattern 3: Serangan *Timing Attack* pada Komparasi Rahasia Kriptografik

Di dalam API keamanan, seringkali kita diminta untuk membandingkan token autentikasi (seperti *Webhook Signature*, OTP Rahasia, atau *API Key* statis). Pengembang pemula umumnya menggunakan komparator string normal (`==` atau `===`), yang berisiko fatal pada *Timing Attacks*.

**❌ KODE SALAH (Beresiko Timing Attack pada Komparasi Hash/Webhook)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

final class VerifyWebhookSignature
{
    public function handle(Request $request, Closure $next)
    {
        $signature = $request->header('X-Hub-Signature');
        
        $expectedSignature = hash_hmac('sha256', $request->getContent(), config('services.webhook.secret'));
        
        // BENCANA: Menggunakan string equal biasa "===" akan dievaluasi dari kiri ke kanan.
        // Sistem akan merespon sepersekian milidetik lebih lambat jika satu karakter cocok.
        // Penyerang tingkat mahir secara matematis dapat menebak hash tersebut satu per satu 
        // karakter berdasarkan analisis perbedaan waktu respons server!
        if ($signature !== $expectedSignature) {
            abort(401, 'Invalid webhook signature');
        }

        return $next($request);
    }
}
```

**✅ KODE BENAR (Menggunakan Fungsi Komparasi Konstan)**

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

final class SecureVerifyWebhookSignature
{
    public function handle(Request $request, Closure $next)
    {
        $signature = $request->header('X-Hub-Signature');
        
        if (empty($signature) || !is_string($signature)) {
            abort(401, 'Signature tidak disertakan atau memiliki tipe cacat.');
        }

        $expectedSignature = hash_hmac('sha256', $request->getContent(), config('services.webhook.secret'));
        
        // AMAN: Memanfaatkan algoritma hash_equals yang dieksekusi secara konstan (Constant-Time).
        // Waktu operasi selalu identik tanpa bergantung pada jumlah karakter valid yang cocok,
        // sehingga mengebiri sepenuhnya metode Timing Attacks (Side-Channel Vulnerability).
        if (!hash_equals($expectedSignature, $signature)) {
            abort(401, 'Invalid webhook signature');
        }

        return $next($request);
    }
}
```

---

## 5. Pengujian Keamanan Tuntas dengan Pest v3

Menulis abstraksi yang aman tidaklah cukup. Anda perlu merutinkan verifikasi terhadap kerangka kerja Anda. Ekosistem pengujian modern di lingkungan PHP direpresentasikan secara elegan melalui *Pest v3*, yang memungkinkan pembuatan *Unit Tests*, *Feature Tests* tingkat HTTP, hingga *Architecture Tests*.

### A. Uji Arsitektural (Architecture Testing)

Pest secara otomatis menelusuri keseluruhan basis data dan menegakkan konvensi arsitektur ke seluruh barisan kode Anda, memastikan para pengembang di dalam tim tidak menciptakan celah keamanan karena *bypass*.

```php
<?php

declare(strict_types=1);

// File: tests/Arch/SecurityArchTest.php

uses()->group('architecture', 'security');

test('Controllers tidak boleh berinteraksi dengan API Request global')
    ->expect('App\Http\Controllers')
    ->not->toUse('request') // Memaksa Injeksi Dependency menggunakan kelas request (FormRequest)
    ->not->toUse('Illuminate\Support\Facades\Request');

test('Semua file aplikasi harus menggunakan type ketat dan tidak mengadopsi fungsi tidak aman')
    ->expect('App')
    ->toUseStrictTypes()
    ->not->toUse(['dd', 'dump', 'var_dump', 'die', 'echo', 'print_r', 'env']); 
    // `env()` tidak boleh dipakai di logika; harus melalui `config()` untuk performa cache.

test('Tidak ada query model langsung pada action dan controller API')
    ->expect(['App\Actions', 'App\Http\Controllers\Api'])
    ->not->toUse('App\Models'); // Memaksa implementasi Repositori
```

### B. Uji Integrasi Fitur dan Isolasi Keamanan (Feature Testing)

Di lapisan integrasi, kita dapat mensimulasikan lingkungan seolah peretas masuk melalui *endpoint* REST. Pengujian ini memastikan fungsi seperti rate limiting dan autentikasi berhasil mencegah ancaman secara definitif.

```php
<?php

declare(strict_types=1);

// File: tests/Feature/Api/User/UpdatePasswordSecurityTest.php

use App\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use function Pest\Laravel\{actingAs, postJson};

uses()->group('api', 'security', 'password');

beforeEach(function () {
    $this->user = clone User::factory()->create([
        'password' => Hash::make('PasswordLama123!@#'),
    ]);
});

it('menolak upaya pembaruan password dari user yang tidak terautentikasi', function () {
    $response = postJson('/api/user/password', [
        'current_password' => 'PasswordLama123!@#',
        'new_password' => 'SandiBaruPalingAman2024$$',
        'new_password_confirmation' => 'SandiBaruPalingAman2024$$',
    ]);

    // Ekspektasi: Terjadi perlindungan 401 Unauthorized yang ketat
    $response->assertStatus(401);
});

it('menolak eksekusi ketika current password direkayasa salah', function () {
    actingAs($this->user, 'sanctum');

    $response = postJson('/api/user/password', [
        'current_password' => 'PasswordSalah123',
        'new_password' => 'SandiBaruPalingAman2024$$',
        'new_password_confirmation' => 'SandiBaruPalingAman2024$$',
    ]);

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['current_password']);
});

it('menolak pengajuan kata sandi lemah (Dictionary Attack Mitigation)', function () {
    actingAs($this->user, 'sanctum');

    $response = postJson('/api/user/password', [
        'current_password' => 'PasswordLama123!@#',
        'new_password' => 'password123', // Kata sandi sangat lemah (Pwned Database & Terlalu Pendek)
        'new_password_confirmation' => 'password123',
    ]);

    $response->assertStatus(422)
             ->assertJsonValidationErrors(['new_password']);
});

it('berhasil memperbarui kata sandi dengan validasi paripurna', function () {
    // Pengujian menggunakan fakes untuk menghindari spam operasi memori / logger di dalam tes
    Log::spy();
    Event::fake();

    actingAs($this->user, 'sanctum');

    $response = postJson('/api/user/password', [
        'current_password' => 'PasswordLama123!@#',
        'new_password' => 'SandiBaruPalingAman2024$$',
        'new_password_confirmation' => 'SandiBaruPalingAman2024$$',
    ]);

    $response->assertStatus(200)
             ->assertJson([
                 'status' => 'success',
                 'message' => 'Kata sandi Anda telah berhasil diperbarui dengan aman.',
             ]);

    // Ekspektasi Lanjutan: Validasi ke basis data memastikan proses enkripsi sukses
    $refreshedUser = User::find($this->user->id);
    expect(Hash::check('SandiBaruPalingAman2024$$', $refreshedUser->password))->toBeTrue();
    
    // Memastikan class log dipanggil minimal sekali selama eksekusi
    Log::shouldHaveReceived('info')->with('Kata sandi berhasil diperbarui oleh pengguna.', ['user_id' => $this->user->id]);
});
```

---

## 6. Kesimpulan

Membangun ekosistem API modern di atas fondasi Laravel bukan sekadar tentang *routing* dan respons data yang cepat; aspek *Security By Design* dan *Secure By Default* merupakan filosofi yang mendikte keseluruhan logika. Kombinasi di atas mematuhi standarisasi ketat melalui:

1. **Clean Architecture**: Mendisiplinkan akses memori sistem secara linear tanpa lompatan logik yang tersembunyi.  
2. **FormRequests & DTOs**: Mensanitasi input yang terinjeksi dari publik, meledakkan secara instan *payload* rekayasa berbahaya.  
3. **Pest Testing**: Menggunakan lapisan `uses`, unit, fakes, & *architecture bounds* untuk mencegah re-introduksi masalah pada *Pull Request* atau inisiasi penerapan fitur selanjutnya.

Kode Anda adalah pertahanan pertama dan terakhir ekosistem siber. Gunakan metode otorisasi secara presisi, hindari manipulasi tipe statis (*Type Juggling*), dan pastikan seluruh API mematuhi kerangka regulasi mutakhir standar industri (seperti PCI-DSS atau GDPR).
