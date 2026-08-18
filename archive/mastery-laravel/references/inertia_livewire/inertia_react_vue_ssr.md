# Inertia.js dengan React/Vue dan SSR di Ekosistem Laravel (Top 1% Quality)

Inertia.js adalah perekat revolusioner yang memungkinkan developer Laravel membangun Single-Page Applications (SPA) yang modern menggunakan framework frontend seperti React, Vue, atau Svelte, tanpa kerumitan membangun REST API terpisah, menangani client-side routing, atau mengelola state management rumit (seperti Redux/Vuex).

Dokumen ini merupakan panduan *deep dive* berstandar Top 1% untuk menerapkan Inertia.js (React/Vue) lengkap dengan Server-Side Rendering (SSR), pola Clean Architecture, strict typing PHP 8.3/8.4, dan arsitektur pengujian menggunakan Pest v3.

---

## 1. Arsitektur Inertia.js: Monolith dengan Pengalaman SPA

Berbeda dengan arsitektur Decoupled (API terpisah dari Frontend), Inertia bekerja dengan pendekatan monolith. Laravel berfungsi sebagai backend router dan pengontrol, sedangkan React/Vue berfungsi semata-mata sebagai "View" layer pengganti Blade.

### Kenapa Wajib Menggunakan SSR (Server-Side Rendering)?
Secara default, Inertia.js melakukan render di sisi klien (Client-Side Rendering/CSR). Aplikasi mengunduh shell HTML kosong, mengunduh file JS raksasa, lalu React/Vue mengeksekusi DOM. Ini buruk untuk:
1. **SEO:** Crawler Google akan kesulitan membaca konten aplikasi.
2. **First Contentful Paint (FCP):** Pengguna dengan koneksi lambat akan melihat layar putih (blank) lebih lama.
3. **Open Graph / Meta Tags:** Twitter Card dan link preview membutuhkan HTML yang sudah dirender server.

Dengan **Inertia SSR**, Node.js merender komponen React/Vue menjadi string HTML utuh di server saat request awal, sehingga browser klien langsung menerima halaman yang bermakna.

---

## 2. Struktur Backend & Clean Architecture

Inertia.js menerima data sebagai "Props" dari Controller. Untuk menjaga aplikasi tetap terstruktur (terutama saat props bertambah banyak dan kompleks), kita harus menggunakan pola Clean Architecture: Route -> Controller -> Action/Service/DTO -> Inertia Render.

### 2.1 Backend Pipeline: DTO -> Action -> Controller

Kita harus memastikan data yang dikirimkan ke frontend sangat ringan dan tidak membocorkan kolom rahasia database (seperti password atau token internal). Gunakan **Data Transfer Object (DTO)** atau **API Resources**.

#### Model dan DTO (Pengamanan Data)
```php
<?php

declare(strict_types=1);

namespace App\DTOs;

use App\Models\User;
use Illuminate\Http\Resources\Json\JsonResource;

final class UserProfileDTO extends JsonResource
{
    /**
     * @param \Illuminate\Http\Request $request
     * @return array<string, mixed>
     */
    public function toArray($request): array
    {
        // Hanya ekspos data yang diperlukan frontend!
        return [
            'id' => $this->resource->id,
            'name' => $this->resource->name,
            'email' => $this->resource->email,
            'avatar_url' => $this->resource->avatar_url,
            'joined_at' => $this->resource->created_at->format('M Y'),
        ];
    }
}
```

#### Action (Logika Bisnis)
```php
<?php

declare(strict_types=1);

namespace App\Actions\Users;

use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;

final readonly class FetchDashboardMetricsAction
{
    public function __construct(
        private UserRepositoryInterface $userRepository
    ) {}

    /**
     * @return array<string, int>
     */
    public function execute(User $user): array
    {
        // Contoh komputasi berat
        return [
            'active_subscriptions' => $this->userRepository->countActiveSubscriptions($user->id),
            'total_invoices_paid' => $this->userRepository->countPaidInvoices($user->id),
            'unread_notifications' => $this->userRepository->countUnreadNotifications($user->id),
        ];
    }
}
```

#### Controller (Pengontrol Inertia)
Gunakan evaluasi malas (Lazy Evaluation) via penutupan `fn()` untuk data yang lambat atau tidak selalu dibutuhkan di tiap render (menghemat beban memori backend).

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Dashboard;

use App\Actions\Users\FetchDashboardMetricsAction;
use App\DTOs\UserProfileDTO;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

final class DashboardController
{
    public function index(Request $request, FetchDashboardMetricsAction $metricsAction): Response
    {
        /** @var \App\Models\User $user */
        $user = $request->user();

        return Inertia::render('Dashboard/Index', [
            // Langsung di-render
            'user' => new UserProfileDTO($user),
            
            // Evaluasi malas (Lazy): Fungsi ini TIDAK dijalankan kecuali frontend memintanya
            // secara spesifik via metode Inertia visit/reload "only: ['metrics']".
            'metrics' => Inertia::lazy(fn () => $metricsAction->execute($user)),
        ]);
    }
}
```

---

## 3. Implementasi Frontend (React.js dengan Strict Types)

Pastikan frontend React/Vue juga kuat dari sisi tipe (gunakan TypeScript). Komponen Inertia akan menerima data DTO sebagai props.

**`resources/js/Pages/Dashboard/Index.tsx`**
```tsx
import React, { useState } from 'react';
import { Head, router } from '@inertiajs/react';
import Layout from '@/Layouts/AuthenticatedLayout';

interface UserProfile {
    id: number;
    name: string;
    email: string;
    avatar_url: string;
    joined_at: string;
}

interface Metrics {
    active_subscriptions: number;
    total_invoices_paid: number;
    unread_notifications: number;
}

interface Props {
    user: UserProfile;
    metrics?: Metrics; // Bisa undefined karena lazy evaluation
}

export default function Dashboard({ user, metrics }: Props) {
    const [loadingMetrics, setLoadingMetrics] = useState(false);

    // Fetch lazy data manually
    const loadMetrics = () => {
        setLoadingMetrics(true);
        router.reload({
            only: ['metrics'],
            onFinish: () => setLoadingMetrics(false)
        });
    };

    return (
        <Layout>
            <Head title="Dashboard" />
            
            <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                <div className="bg-white overflow-hidden shadow-sm sm:rounded-lg p-6">
                    <div className="flex items-center gap-4">
                        <img src={user.avatar_url} alt="Avatar" className="w-16 h-16 rounded-full" />
                        <div>
                            <h1 className="text-2xl font-bold text-gray-900">Welcome, {user.name}</h1>
                            <p className="text-gray-600">Member since {user.joined_at}</p>
                        </div>
                    </div>

                    <div className="mt-8">
                        <h2 className="text-xl font-semibold mb-4">Your Metrics</h2>
                        {metrics ? (
                            <div className="grid grid-cols-3 gap-4">
                                <MetricCard title="Active Subscriptions" value={metrics.active_subscriptions} />
                                <MetricCard title="Paid Invoices" value={metrics.total_invoices_paid} />
                                <MetricCard title="Unread Alerts" value={metrics.unread_notifications} />
                            </div>
                        ) : (
                            <button 
                                onClick={loadMetrics} 
                                disabled={loadingMetrics}
                                className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:opacity-50"
                            >
                                {loadingMetrics ? 'Loading...' : 'Reveal Metrics'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </Layout>
    );
}

const MetricCard = ({ title, value }: { title: string, value: number }) => (
    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
        <h3 className="text-sm text-gray-500 font-medium">{title}</h3>
        <p className="text-3xl font-bold text-gray-900 mt-2">{value}</p>
    </div>
);
```

---

## 4. Anti-Patterns dalam Inertia.js + Laravel

### ❌ Anti-Pattern 1: Data Over-fetching & Kebocoran Model Database
Mengirim seluruh model database langsung ke properti Inertia (N+1 query problem & kebocoran rahasia).

❌ **KODE SALAH (Berbahaya - Memory/Security Risk):**
```php
public function index()
{
    // Mengirim RIBUAN pengguna berserta password/token ke klien JS!
    // Klien JS bisa menginspeksi memori dan melihat data sensitif.
    return Inertia::render('Users/Index', [
        'users' => User::with('roles', 'permissions')->get() 
    ]);
}
```
*Mengapa Berbahaya:* Ini membocorkan hashed password, remember_token, dan seluruh data ke browser pengguna (bisa dilihat via Vue/React DevTools atau Network Tab). Ini juga menyebabkan bloat pada ukuran *payload* JSON Inertia yang mengakibatkan performa render lambat.

✅ **KODE BENAR (Aman - Protected via DTO/Resources & Pagination):**
```php
public function index()
{
    return Inertia::render('Users/Index', [
        // 1. Pagination wajib digunakan untuk koleksi
        // 2. Resource/DTO digunakan untuk menyaring atribut
        'users' => UserProfileDTO::collection(
            User::with('roles')->paginate(15)
        )
    ]);
}
```

### ❌ Anti-Pattern 2: Merusak SPA Experience dengan Redirect Murni
Melakukan manipulasi data di form lalu memaksakan redirect browser HTTP secara penuh alih-alih redirect Inertia.

❌ **KODE SALAH (Berbahaya - UX/Performance Risk):**
```php
public function store(StoreRequest $request)
{
    $user = User::create($request->validated());
    
    // HTTP REDIRECT MURNI: 
    // Menghentikan SPA, memaksa browser re-download JS/CSS dari awal.
    return redirect()->to(route('users.index')); 
}
```
*Mengapa Berbahaya:* Ini menghancurkan *purpose* SPA. Saat melakukan form submission, backend harus melakukan redirect internal agar Inertia di frontend menangkap response 302 dan melakukan pembaruan halaman secara asinkron tanpa memuat ulang page (full reload).

✅ **KODE BENAR (SPA-Native Redirect):**
```php
public function store(StoreRequest $request)
{
    $user = User::create($request->validated());
    
    // Gunakan fungsi route() native laravel, 
    // Inertia middleware akan otomatis membungkus redirect ini 
    // agar SPA experience tidak rusak.
    return redirect()->route('users.index')
        ->with('success', 'User created successfully.');
}
```

---

## 5. Middleware dan Global Shared Data

Berhati-hatilah dengan `HandleInertiaRequests` middleware (`app/Http/Middleware/HandleInertiaRequests.php`). Data yang Anda masukkan ke metode `share()` akan disuntikkan ke **setiap** *page load*. 

❌ Jangan masukkan logika database yang berat di sini!
✅ Masukkan hanya data user session, setting aplikasi esensial, atau flash messages.

```php
<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Inertia\Middleware;

final class HandleInertiaRequests extends Middleware
{
    protected $rootView = 'app';

    /**
     * @return array<string, mixed>
     */
    public function share(Request $request): array
    {
        return array_merge(parent::share($request), [
            'auth' => [
                // Sangat penting: Filter atribut, jangan kirim model User murni!
                'user' => $request->user() ? [
                    'id' => $request->user()->id,
                    'name' => $request->user()->name,
                    'role' => $request->user()->role,
                ] : null,
            ],
            'flash' => [
                'success' => fn () => $request->session()->get('success'),
                'error' => fn () => $request->session()->get('error'),
            ],
        ]);
    }
}
```

---

## 6. Pengujian Arsitektur Inertia dengan Pest v3

Menguji response Inertia berbeda dengan menguji JSON biasa. Kita harus melakukan asersi terhadap nama komponen dan props yang dikembalikan ke View layer. Laravel memiliki helper Inertia testing out-of-the-box.

### 6.1 Architecture Testing (`tests/ArchTest.php`)
Memastikan aturan DTO & Controller Inertia dipatuhi.

```php
<?php

declare(strict_types=1);

arch('it enforce strict types in all application files')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers should not dump entire model')
    ->expect('App\Http\Controllers')
    ->not->toUse('App\Models\User::all')
    ->not->toUse('App\Models\User::get');
```

### 6.2 Feature Testing Inertia Endpoint (`tests/Feature/DashboardTest.php`)

```php
<?php

declare(strict_types=1);

use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

uses()->group('feature', 'inertia', 'dashboard');

it('renders dashboard component with strict user props', function () {
    // Arrange
    $user = User::factory()->create([
        'name' => 'John Doe',
        'email' => 'john@example.com',
    ]);

    // Act
    $response = $this->actingAs($user)->get(route('dashboard'));

    // Assert
    $response->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Dashboard/Index')
            // Cek ada root user prop
            ->has('user')
            // Pastikan prop spesifik ada dan cocok
            ->where('user.name', 'John Doe')
            ->where('user.email', 'john@example.com')
            // Pastikan tidak bocor password hash
            ->missing('user.password')
            ->missing('user.remember_token')
        );
});

it('does not load lazy metrics on first render', function () {
    // Arrange
    $user = User::factory()->create();

    // Act
    $response = $this->actingAs($user)->get(route('dashboard'));

    // Assert
    $response->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Dashboard/Index')
            // Harus ada prop metrics, tapi statusnya belum terevaluasi/masih missing value riilnya
            ->missing('metrics.active_subscriptions')
        );
});

it('loads metrics when explicitly requested via partial reload', function () {
    // Arrange
    $user = User::factory()->create();

    // Act
    // Simulasikan permintaan X-Inertia-Partial-Data dari React router.reload
    $response = $this->actingAs($user)
        ->get(route('dashboard'), [
            'HTTP_X-Inertia' => 'true',
            'HTTP_X-Inertia-Partial-Component' => 'Dashboard/Index',
            'HTTP_X-Inertia-Partial-Data' => 'metrics',
        ]);

    // Assert
    $response->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Dashboard/Index')
            ->has('metrics')
            ->has('metrics.active_subscriptions')
            ->has('metrics.total_invoices_paid')
        );
});
```

---

## Kesimpulan

Menggunakan Inertia.js dengan React/Vue dan SSR di ekosistem Laravel menjanjikan produktivitas pengembang luar biasa sembari menawarkan SPA UX (User Experience). Namun, dengan produktivitas ini datang kewajiban: arsitek perangkat lunak **wajib** bertindak defensif. Data DTO, Lazy Evaluation, serta validasi Pest Test ketat adalah satu-satunya jaminan sistem ini berskala level *Enterprise*.
