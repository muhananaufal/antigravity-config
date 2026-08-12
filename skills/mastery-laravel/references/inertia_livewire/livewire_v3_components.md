# Livewire v3 Components di Ekosistem Laravel (Top 1% Quality)

Livewire v3 merupakan rilis fundamental yang mendefinisikan ulang batas antara interaktivitas frontend (klien) dan backend (PHP) di dalam Laravel. Tanpa perlu menulis kustom JavaScript/Vue/React kompleks, Livewire menggunakan request `fetch` dan injeksi DOM otomatis untuk mensimulasikan rasa *Single Page Application (SPA)* melalui teknologi server-side state.

Dokumen ini adalah *deep dive* level arsitek untuk mengembangkan aplikasi Laravel + Livewire v3 yang bersih (Clean Architecture), sangat aman (Security First), berperforma tinggi, menghapus Anti-Patterns klasik, dan dijamin oleh standar arsitektur Pest v3.

---

## 1. Arsitektur Inti Livewire v3

Konsep terpenting yang perlu dipahami: **Sebuah komponen Livewire HANYA hidup sesaat.** Komponen kelas PHP akan dimatikan (dihancurkan/destructed) setiap akhir request, dan *state* datanya didehidrasi ke dalam struktur JSON (yang dimanipulasi dengan *hash* MAC agar aman) untuk disematkan di DOM HTML. Saat pengguna menekan tombol, *state* JSON ini dikirim kembali ke server untuk direhidrasi (dihidupkan lagi) menjadi kelas PHP, dieksekusi fungsionalitasnya, lalu mati lagi.

### Fitur Penentu v3:
1. **Pusat Reaktivitas `wire:model`**: Semakin efisien, update state dikelompokkan *(batched)* sehingga tidak memborbardir server.
2. **`wire:navigate`**: Menghadirkan transisi SPA sejati.
3. **Form Objects (Pengganti Form Requests)**: Menyimpan atribut dan validasi terpisah secara logis tanpa mengotori komponen utama.
4. **`wire:stream` / `lazy`**: Memuat UI lambat atau melakukan stream respon AI murni secara bertahap di sisi klien.

---

## 2. Struktur Backend & Clean Architecture 

Komponen kelas Livewire harus diperlakukan sama seperti **Controller**. Tugasnya *hanya* menerima interaksi, mendelegasikan beban ke Action/Service eksternal, dan mengembalikan tampilan (View). Logika bisnis dilarang berada di Livewire.

### 2.1 Form Objects (Kapsulasi Validasi)

Jangan tumpuk puluhan variabel input publik pada kelas komponen Livewire Anda. Gunakan Form Object.

**`app/Livewire/Forms/PostForm.php`**
```php
<?php

declare(strict_types=1);

namespace App\Livewire\Forms;

use App\Models\Post;
use Livewire\Attributes\Validate;
use Livewire\Form;

final class PostForm extends Form
{
    public ?Post $post = null;

    #[Validate('required|min:5|max:100')]
    public string $title = '';

    #[Validate('required|min:10')]
    public string $content = '';

    #[Validate('boolean')]
    public bool $is_published = false;

    public function setPost(Post $post): void
    {
        $this->post = $post;
        $this->title = $post->title;
        $this->content = $post->content;
        $this->is_published = $post->is_published;
    }

    public function store(callable $action): Post
    {
        $this->validate();

        $post = $action($this->all());
        
        $this->reset();
        
        return $post;
    }
}
```

### 2.2 Komponen Livewire (Bertindak Sebagai Controller)

**`app/Livewire/Posts/CreatePost.php`**
```php
<?php

declare(strict_types=1);

namespace App\Livewire\Posts;

use App\Actions\Posts\CreatePostAction;
use App\Livewire\Forms\PostForm;
use Livewire\Component;

final class CreatePost extends Component
{
    public PostForm $form;

    public function save(CreatePostAction $action): void
    {
        // 1. Delegasikan logika persetujuan ke Form
        // 2. Delegasikan logika bisnis aktual ke Action Class (Clean Architecture)
        $this->form->store(
            fn (array $data) => $action->execute(auth()->user(), $data)
        );

        $this->dispatch('post-created');
        session()->flash('success', 'Post successfully created!');
    }

    public function render()
    {
        return view('livewire.posts.create-post');
    }
}
```

### 2.3 Business Logic (Action Class)

**`app/Actions/Posts/CreatePostAction.php`**
```php
<?php

declare(strict_types=1);

namespace App\Actions\Posts;

use App\Models\Post;
use App\Models\User;
use App\Repositories\Contracts\PostRepositoryInterface;
use Illuminate\Support\Facades\DB;

final readonly class CreatePostAction
{
    public function __construct(
        private PostRepositoryInterface $postRepository
    ) {}

    /**
     * @param array<string, mixed> $data
     */
    public function execute(User $author, array $data): Post
    {
        return DB::transaction(function () use ($author, $data) {
            $post = new Post([
                'title' => $data['title'],
                'content' => $data['content'],
                'is_published' => $data['is_published'] ?? false,
            ]);
            
            $post->author_id = $author->id;
            
            $this->postRepository->save($post);
            
            return $post;
        });
    }
}
```

---

## 3. View Blade (Frontend) dan Optimasi Jaringan

Berkat struktur kelas di atas, View kita menjadi bersih. Kita menggunakan `wire:model` dan mengimplementasikan SPA secara otomatis menggunakan atribut `wire:navigate`.

**`resources/views/livewire/posts/create-post.blade.php`**
```html
<div>
    <!-- SPA Navigation link -->
    <a href="{{ route('posts.index') }}" wire:navigate class="text-blue-500 mb-4 inline-block">&larr; Back to Posts</a>

    @if (session('success'))
        <div class="bg-green-100 text-green-700 p-4 rounded mb-4">
            {{ session('success') }}
        </div>
    @endif

    <form wire:submit="save">
        <div class="mb-4">
            <label class="block font-bold">Title</label>
            <!-- Form Object namespace: form.title -->
            <!-- wire:model tersinkronisasi otomatis setiap ada keystroke jika tidak pakai .blur/.defer (tergantung versi) -->
            <input type="text" wire:model.blur="form.title" class="border rounded w-full p-2">
            <div>
                @error('form.title') <span class="text-red-500 text-sm">{{ $message }}</span> @enderror
            </div>
        </div>

        <div class="mb-4">
            <label class="block font-bold">Content</label>
            <textarea wire:model.blur="form.content" class="border rounded w-full p-2 h-32"></textarea>
            <div>
                @error('form.content') <span class="text-red-500 text-sm">{{ $message }}</span> @enderror
            </div>
        </div>

        <div class="mb-4">
            <label class="flex items-center gap-2">
                <input type="checkbox" wire:model="form.is_published">
                <span>Publish Immediately?</span>
            </label>
        </div>

        <!-- Fitur loading spinner native dari Livewire -->
        <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded relative">
            <span wire:loading.remove wire:target="save">Save Post</span>
            <span wire:loading wire:target="save">Saving...</span>
        </button>
    </form>
</div>
```

---

## 4. Computed Properties `#[Computed]` vs Public Properties

Hal ini adalah kesalahan terbesar yang sering dibuat pengembang tingkat pemula. 

Properti publik (`public array $posts;`) disertakan dalam JSON dehidrasi (dikirim bolak-balik antara klien dan server). Jika Anda menyimpan relasi ORM (kumpulan 10.000 data) ke dalam public property, Livewire akan mencoba membuat payload JSON sebesar 10MB! Ini menghancurkan aplikasi Anda.

Gunakan properti terkomputasi (`#[Computed]`) untuk mengambil kumpulan data database yang hanya digunakan di `render()`.

**`app/Livewire/Posts/ListPosts.php`**
```php
<?php

declare(strict_types=1);

namespace App\Livewire\Posts;

use App\Models\Post;
use Illuminate\Pagination\LengthAwarePaginator;
use Livewire\Attributes\Computed;
use Livewire\Component;
use Livewire\WithPagination;

final class ListPosts extends Component
{
    use WithPagination;

    // HANYA data skalar yang dikirim bolak-balik
    public string $search = '';

    // Data collection dieksekusi SETIAP request di server 
    // namun TIDAK ikut dikirim sebagai JSON raksasa.
    #[Computed]
    public function posts(): LengthAwarePaginator
    {
        return Post::query()
            ->where('title', 'like', "%{$this->search}%")
            ->latest()
            ->paginate(10);
    }

    public function render()
    {
        return view('livewire.posts.list-posts');
    }
}
```

**Blade:**
```html
<div>
    <!-- Render computed property menggunakan pemanggilan pseudo-fungsi (atau property-like di V3) -->
    @foreach($this->posts as $post)
        <div>{{ $post->title }}</div>
    @endforeach
    
    {{ $this->posts->links() }}
</div>
```

---

## 5. Anti-Patterns dalam Livewire v3

### ❌ Anti-Pattern 1: Data Exposure Melalui Model Utuh
Meletakkan instance model utuh pada properti publik Livewire dapat membocorkan setiap atribut dari database (termasuk yang tidak boleh diakses oleh pengguna) ke *Inspector Payload* di peramban (browser).

❌ **KODE SALAH (Berbahaya - Security/Data Leak Risk):**
```php
public User $user; // Attacker dapat mengubah JSON payload `{ user: { id: 2, is_admin: true } }` 
                   // untuk mencoba meretas data jika validasi kendor!
```
*Mengapa Berbahaya:* Jika model memaparkan data sensitif (seperti `$user->password`), Livewire akan membocorkan hal tersebut kepada penyerang di peramban yang bisa dengan mudah memeriksa *network payload*. 

✅ **KODE BENAR (Hanya Data Skalar & Terkontrol):**
Gunakan tipe skalar eksplisit untuk variabel pengeditan data atau proteksi lewat Form Objects. Livewire memiliki integrasi `#[Locked]` (v3) untuk mengunci ID dari manipulasi klien.

```php
use Livewire\Attributes\Locked;

#[Locked]
public int $userId; 
// ID ini tidak bisa dimanipulasi oleh klien via inspect element.
```

### ❌ Anti-Pattern 2: N+1 Query dan Polling Membunuh Database
Menjalankan *polling* reguler menggunakan `wire:poll` pada komponen yang memanggil kueri kompleks akan menjatuhkan *throughput* database.

❌ **KODE SALAH (Berbahaya - Performance Risk):**
```html
<div wire:poll.1s>
    <!-- Server akan dieksekusi SETIAP DETIK. -->
    @foreach($users as $user) 
       {{ $user->profile->avatar }} <!-- N+1 Kueri SETIAP DETIK! -->
    @endforeach
</div>
```
*Mengapa Berbahaya:* Bayangkan 1.000 klien yang aktif. Mereka menghasilkan 1.000 HTTP request/detik. Dan bila ada N+1 query (`profile`), itu akan memicu 50.000 kueri basis data setiap detiknya.

✅ **KODE BENAR (Optimasi & Eager Loading):**
1. Batasi interupsi server. Ubah ke `wire:poll.keep-alive` (5 detik atau lebih).
2. Tuntaskan N+1 secara proaktif dengan `with()`.

```php
#[Computed]
public function users()
{
    return User::with('profile')->limit(10)->get();
}
```
```html
<div wire:poll.10s>...</div> <!-- Atau pakai WebSockets / Laravel Reverb jika butuh real-time -->
```

---

## 6. Pengujian Livewire Arsitektur dengan Pest v3

Unit pengujian (Unit testing) aplikasi Livewire sangat efisien, kita tidak membutuhkan peramban (Dusk) untuk memastikan logika berjalan. Kita bisa memastikan *rendering* dan delegasi tugas dari komponen Livewire berkerja secara mulus dengan Pest v3.

### 6.1 Architecture Testing (`tests/ArchTest.php`)
Pastikan Livewire Components tidak bercabang fungsi model secara langsung.

```php
<?php

declare(strict_types=1);

arch('it enforce strict types in all application files')
    ->expect('App')
    ->toUseStrictTypes();

arch('livewire components should not manipulate models directly')
    ->expect('App\Livewire')
    ->not->toUse('App\Models\Post::create')
    ->not->toUse('App\Models\Post::update')
    ->not->toUse('App\Models\Post::delete');

arch('livewire components should not perform authorization queries directly')
    ->expect('App\Livewire')
    ->not->toUse('Gate::allows');
```

### 6.2 Component Feature Testing (`tests/Feature/Livewire/CreatePostTest.php`)

```php
<?php

declare(strict_types=1);

use App\Livewire\Posts\CreatePost;
use App\Models\Post;
use App\Models\User;
use Livewire\Livewire;

uses()->group('feature', 'livewire', 'posts');

it('renders the create post component correctly', function () {
    Livewire::actingAs(User::factory()->create())
        ->test(CreatePost::class)
        ->assertStatus(200)
        ->assertViewIs('livewire.posts.create-post');
});

it('validates post creation input correctly via form object', function () {
    Livewire::actingAs(User::factory()->create())
        ->test(CreatePost::class)
        // Set ke form empty
        ->set('form.title', '')
        ->set('form.content', 'short')
        ->call('save')
        // Harap gagal
        ->assertHasErrors(['form.title' => 'required', 'form.content' => 'min']);
});

it('successfully creates a post through the action and resets form', function () {
    // Arrange
    $user = User::factory()->create();

    // Act & Assert
    Livewire::actingAs($user)
        ->test(CreatePost::class)
        ->set('form.title', 'Secure and Fast Livewire')
        ->set('form.content', 'This is a long content demonstrating Livewire.')
        ->set('form.is_published', true)
        ->call('save')
        // Pastikan event diterbitkan
        ->assertDispatched('post-created')
        // Pastikan variabel internal form dikosongkan
        ->assertSet('form.title', '');

    // Pastikan database menyimpannya lewat form Action
    $this->assertDatabaseHas('posts', [
        'author_id' => $user->id,
        'title' => 'Secure and Fast Livewire',
        'is_published' => 1,
    ]);
});
```

---

## Kesimpulan

Livewire v3 merombak dan mengotomatisasi interaktivitas UI canggih, namun kebebasan penuh tersebut datang dengan tanggung jawab besar akan performa (Payload Size JSON) dan pengamanan komponen. Pemisahan validasi melalui Form Objects, injeksi kelas Actions (Clean Architecture), evaluasi koleksi melalui Computed Properties (meminimalkan *data leak*), serta asersi arsitektur (Pest v3) akan menghasilkan basis kode tingkat Enterprise Top 1%.
