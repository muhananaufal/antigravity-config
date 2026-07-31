# Laravel Reverb & WebSockets Mastery: Panduan Enterprise Skala Besar

Laravel 11 dan 12 memperkenalkan ekosistem real-time yang sangat revolusioner dengan hadirnya **Laravel Reverb**, sebuah server WebSocket native berkinerja tinggi (first-party WebSocket server) yang dirancang khusus untuk ekosistem Laravel. Dibangun secara asinkron menggunakan ReactPHP, Reverb mampu menangani ribuan hingga puluhan ribu koneksi secara simultan (concurrent connections) pada satu instance tunggal, memberikan alternatif superior dibandingkan solusi pihak ketiga berbayar seperti Pusher atau Socket.io yang rumit dalam hal pemeliharaan.

Dokumen ini adalah referensi definitif (Top 1% Quality) untuk merancang, mengimplementasikan, memelihara, dan menguji sistem real-time berskala *Enterprise*. Panduan ini mencakup manajemen *connection limits*, *horizontal scaling* menggunakan Redis, taktik keamanan pada *Private* dan *Presence Channels*, penerapan *Clean Architecture* yang ketat, dan unit serta *architecture testing* menggunakan Pest v3. 

---

## 1. Arsitektur Reverb, Limit Koneksi, dan Skalabilitas (Scaling)

Ketika aplikasi real-time bertumbuh, satu proses WebSocket akan menghadapi limitasi, baik berupa CPU-bound, Memory-bound, maupun *port exhaustion* (batas *file descriptor* Linux). Reverb dirancang dengan kesadaran penuh terhadap limitasi ini.

### Konfigurasi Limit dan Interval (`config/reverb.php`)

Kestabilan server WebSocket sangat bergantung pada *ping interval* dan limitasi *request size*. Manajemen *ping/pong* secara aktif menjaga agar koneksi jaringan yang sudah terputus secara sepihak (zombie connections) segera dibersihkan dari memori RAM server.

```php
<?php

declare(strict_types=1);

return [
    'default' => env('REVERB_SERVER', 'reverb'),

    'servers' => [
        'reverb' => [
            'host' => env('REVERB_HOST', '0.0.0.0'),
            'port' => env('REVERB_PORT', 8080),
            'hostname' => env('REVERB_HOSTNAME'),
            'options' => [
                'tls' => [],
            ],
            // Membatasi ukuran payload mencegah serangan eksploitasi memori (DDoS)
            'max_request_size' => env('REVERB_MAX_REQUEST_SIZE', 10_000), 
            
            // Konfigurasi Scaling akan diterangkan di bawah
            'scaling' => [
                'enabled' => env('REVERB_SCALING_ENABLED', false),
                'channel' => env('REVERB_SCALING_CHANNEL', 'reverb_cluster_bus'),
            ],
            
            'pulse' => [
                'enabled' => env('REVERB_PULSE_ENABLED', true),
            ],
            
            // Jangan over-provisioning max_connections melebihi (ulimit -n) server Linux Anda
            'max_connections' => env('REVERB_MAX_CONNECTIONS', 10_000), 
            'ping_interval' => env('REVERB_PING_INTERVAL', 30),
            'ping_timeout' => env('REVERB_PING_TIMEOUT', 10),
        ],
    ],
];
```

### Skalabilitas Horizontal dengan Redis Pub/Sub

Bila aplikasi melebihi 10.000 koneksi bersamaan (misal: sistem *Ticketing* konser atau *Crypto Trading Dashboard*), satu instance Reverb tidak akan cukup. Anda wajib melakukan *Horizontal Scaling* (menambah jumlah server Reverb di belakang Load Balancer seperti Nginx atau AWS ALB).

Untuk memastikan pengguna di Server A bisa menerima *broadcast* *event* dari aksi yang terjadi di Server B, Reverb memanfaatkan **Redis Pub/Sub**.

Konfigurasi `.env` pada *production cluster*:

```env
BROADCAST_CONNECTION=reverb

# Reverb Server
REVERB_SERVER=reverb
REVERB_HOST="0.0.0.0"
REVERB_PORT=8080
REVERB_SCHEME=https

# Reverb Scaling
REVERB_SCALING_ENABLED=true
REVERB_SCALING_CHANNEL=reverb_enterprise_cluster_bus
REDIS_HOST=10.0.1.25 # IP Private Server Redis
REDIS_PASSWORD=SecureRedisPassword123
REDIS_PORT=6379
```

Dengan mengaktifkan opsi ini, setiap kali aplikasi memicu (`event()`), Laravel akan mendorong payload ke Redis. Semua server Reverb yang terhubung ke Redis akan membaca pesan tersebut dan meneruskannya (menyebarkan) ke semua klien WebSocket yang terkoneksi pada *instance* mereka masing-masing.

---

## 2. Clean Architecture pada Integrasi WebSockets

Mengikat logika WebSocket langsung ke dalam Controller atau Model Observers akan menyebabkan *spaghetti code* yang sulit di-test dan rentan terhadap efek samping siklik (*cyclic side effects*). Kita menggunakan pendekatan **Clean Architecture** (berbasis *Domain, Actions/Use Cases*, dan *Events*).

### Studi Kasus Nyata: Sistem Monitor Lelang Real-time (Live Auction Bidding)

Pada aplikasi lelang mobil skala besar, ribuan pengguna mengamati harga penawaran (bid) secara *live*. Saat penawaran baru diajukan, seluruh partisipan dalam ruang lelang (Room) tersebut harus melihat harga terbaru tanpa memuat ulang (refresh) halaman.

#### 1. Domain Event (`app/Domain/Auction/Events/NewBidPlaced.php`)

*Event* berfungsi murni sebagai Data Transfer Object (DTO) untuk komunikasi eksternal. *Event* ini mengimplementasikan `ShouldBroadcastNow` agar segera diproses tanpa melalui antrean panjang jika *latency* adalah prioritas utama (misal untuk HFT/Bidding), namun pada skenario standar bisa memakai `ShouldBroadcast` yang dimasukkan ke *Queue Worker*.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Auction\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PresenceChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class NewBidPlaced implements ShouldBroadcastNow
{
    use Dispatchable;
    use InteractsWithSockets;
    use SerializesModels;

    public function __construct(
        public readonly string $auctionId,
        public readonly string $bidderId,
        public readonly string $bidderName,
        public readonly float $amount,
        public readonly string $currency,
    ) {
    }

    /**
     * @return array<int, Channel>
     */
    public function broadcastOn(): array
    {
        // Menggunakan Presence Channel karena kita butuh fitur Who is Online dalam ruang lelang
        return [
            new PresenceChannel('auction.room.' . $this->auctionId),
        ];
    }

    public function broadcastAs(): string
    {
        return 'auction.bid.placed';
    }

    /**
     * @return array<string, mixed>
     */
    public function broadcastWith(): array
    {
        return [
            'auction_id' => $this->auctionId,
            'bidder' => [
                'id' => $this->bidderId,
                'name' => $this->bidderName,
            ],
            'amount' => $this->amount,
            'currency' => $this->currency,
            'timestamp' => now()->toIso8601String(),
        ];
    }
}
```

#### 2. Domain Action / Use Case (`app/Domain/Auction/Actions/PlaceBidAction.php`)

*Action* menangani logika bisnis murni, memvalidasi aturan (*business rules*), menyimpan ke database, dan hanya memicu *event* jika transaksi *database* berhasil (menghindari data hantu / *ghost data* dikirim ke frontend).

```php
<?php

declare(strict_types=1);

namespace App\Domain\Auction\Actions;

use App\Domain\Auction\Events\NewBidPlaced;
use App\Domain\Auction\Models\Bid;
use App\Domain\Auction\Repositories\AuctionRepositoryInterface;
use App\Domain\User\Models\User;
use Illuminate\Support\Facades\DB;
use DomainException;

final readonly class PlaceBidAction
{
    public function __construct(
        private AuctionRepositoryInterface $auctionRepository
    ) {
    }

    /**
     * @throws DomainException
     */
    public function execute(string $auctionId, User $bidder, float $amount): Bid
    {
        return DB::transaction(function () use ($auctionId, $bidder, $amount): Bid {
            $auction = $this->auctionRepository->lockForUpdate($auctionId);

            if ($auction === null) {
                throw new DomainException('Sesi lelang tidak ditemukan.');
            }

            if ($amount <= $auction->current_highest_bid) {
                throw new DomainException('Nominal penawaran harus lebih tinggi dari harga saat ini.');
            }

            // Menyimpan penawaran ke database
            $bid = $auction->bids()->create([
                'user_id' => $bidder->id,
                'amount' => $amount,
            ]);

            // Pembaruan denormalisasi data
            $auction->update(['current_highest_bid' => $amount]);

            // Trigger integrasi sistem real-time WebSockets secara asinkron (lepas tembak)
            event(new NewBidPlaced(
                auctionId: $auction->id,
                bidderId: (string) $bidder->id,
                bidderName: $bidder->name,
                amount: $amount,
                currency: $auction->currency,
            ));

            return $bid;
        });
    }
}
```

#### 3. Autentikasi Presisi pada Routes (`routes/channels.php`)

Otorisasi *Channel* WebSockets harus bersifat ringan (*lightweight*) karena *endpoint* ini akan dibombardir oleh ribuan request berbarengan (bersamaan dengan aksi *reconnection*).

```php
<?php

declare(strict_types=1);

use App\Domain\User\Models\User;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\DB;

/*
 * Presence Channel Otorisasi
 * Presence channel wajib mengembalikan array metadata pengguna (id, name)
 * jika otorisasi sukses. Mengembalikan false berarti otorisasi gagal.
 */
Broadcast::channel('auction.room.{auctionId}', function (User $user, string $auctionId): array|bool {
    // Validasi super efisien, langsung menggunakan Redis atau Database Query tanpa ORM berat
    $isParticipant = DB::table('auction_participants')
        ->where('auction_id', $auctionId)
        ->where('user_id', $user->id)
        ->exists();

    if (! $isParticipant) {
        return false;
    }

    // Informasi metadata yang akan disiarkan ke pengguna lain dalam ruangan yang sama
    return [
        'id' => $user->id,
        'name' => $user->name,
        'level' => $user->vip_level,
    ];
});
```

---

## 3. Anti-Pattern dalam Praktik WebSockets dan Solusi Konkrit

### Anti-Pattern 1: Data Leakage via Serialisasi Model Eloquent

Seringkali developer junior menginjeksi Model Eloquent yang memuat data tersembunyi (*hidden attributes*) ke konstruktor Event, dan lupa mendefinisikan *method* `broadcastWith()`. Ini berujung pada tereksposnya struktur database atau atribut rahasia (seperti saldo bank, password, token) ke *network payload* WebSockets publik.

#### ❌ KODE SALAH

```php
<?php

declare(strict_types=1);

namespace App\Domain\User\Events;

use App\Domain\User\Models\User;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class ProfileUpdated implements ShouldBroadcast
{
    use Dispatchable;
    use SerializesModels;

    // BAD: Menyimpan instance Model Eloquent. 
    // Jika relasi $user->bankAccounts telah ter-load di memori sebelumnya, 
    // relasi tersebut AKAN IKUT TERSERIALISASI dan disebarkan ke koneksi WebSocket!
    public function __construct(
        public User $user 
    ) {
    }

    public function broadcastOn(): array
    {
        return [new PrivateChannel('user.' . $this->user->id)];
    }
    
    // FATAL: Tidak ada fungsi broadcastWith() yang melakukan filter spesifik.
}
```

#### ✅ KODE BENAR

Buat batas demarkasi (*demarcation boundary*) yang tegas: selalu gunakan tipe primitif di *constructor* atau paksa *explicit mapping* di `broadcastWith()`.

```php
<?php

declare(strict_types=1);

namespace App\Domain\User\Events;

use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class ProfileUpdated implements ShouldBroadcast
{
    use Dispatchable;
    use SerializesModels;

    // GOOD: Hanya menyimpan data esensial berupa primitif skalar.
    public function __construct(
        public readonly string $userId,
        public readonly string $newName,
        public readonly string $newAvatarUrl
    ) {
    }

    public function broadcastOn(): array
    {
        return [new PrivateChannel('user.' . $this->userId)];
    }

    // GOOD: Presisi mutlak dalam penentuan struktur JSON yang disiarkan ke Frontend.
    public function broadcastWith(): array
    {
        return [
            'id' => $this->userId,
            'name' => $this->newName,
            'avatar_url' => $this->newAvatarUrl,
        ];
    }
}
```

**Penjelasan:** *Default serialization* PHP akan menangkap seluruh memori Model. Di skala Enterprise, ini melanggar OWASP Top 10 (Sensitive Data Exposure) dan juga mengakibatkan lonjakan penggunaan RAM pada proses Reverb serta menghabiskan batas `max_request_size`.

### Anti-Pattern 2: Infinite Loop Broadcasting (Event Ping-Pong)

Memasang pemanggilan *Event Broadcasting* pada siklus hidup internal Eloquent (seperti di metode `boot()` atau pada class Observer) saat melakukan event `updated` atau `saved`. Jika *Event WebSocket* ditangkap oleh klien, kemudian klien memicu request balik ke API yang memodifikasi model yang sama, akan memicu pembaruan berulang tanpa batas (*infinite loop*).

#### ❌ KODE SALAH

```php
<?php

declare(strict_types=1);

namespace App\Domain\Order\Observers;

use App\Domain\Order\Models\Order;
use App\Domain\Order\Events\OrderStatusUpdated;

final class OrderObserver
{
    // BAD: Observer memonitoring hook Eloquent "updated"
    public function updated(Order $order): void
    {
        // FATAL: Setiap query update() di aplikasi entah dari Artisan command,
        // Cron Job, atau API klien akan memicu broadcast ke Websocket.
        // Sangat rentan memicu infinite loop jika klien memiliki logika sinkronisasi state.
        event(new OrderStatusUpdated(
            $order->id,
            $order->status
        ));
    }
}
```

#### ✅ KODE BENAR

Lokalisasi proses penyiaran *WebSockets* hanya pada *Domain Actions/Use Case* yang merespons secara eksklusif tindakan eksplisit dari aktor eksternal. (Seperti yang dicontohkan pada skenario Clean Architecture `PlaceBidAction` di atas, di mana *event* ditembak secara manual, spesifik di satu tempat bisnis).

**Penjelasan:** Observer berjalan secara implisit. Tindakan implisit sulit untuk dilacak, di-*debug*, dan seringkali berkonflik dengan operasi sinkronisasi basis data berskala massal. Selalu jalankan operasi WebSocket Anda (seperti memicu event) secara **EKSPLISIT** di layer Action.

---

## 4. Testing WebSockets Secara Menyeluruh dengan Pest v3

Tingkat kepercayaan terhadap sistem berbasis asinkron bergantung pada *testability*-nya. Menggunakan Pest v3, kita memvalidasi arsitektur, pemanggilan Unit Test, dan keamanan koneksi Otorisasi.

### Architecture (Arch) Testing

Menggaransi kedisiplinan Clean Architecture bahwa direktori Event digunakan semestinya, dan semua interaksi real-time diimplementasikan dengan benar.

```php
<?php

declare(strict_types=1);

// tests/Arch/BroadcastingArchTest.php

use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

test('semua domain event untuk WebSockets mematuhi kontrak broadcasting Laravel')
    ->expect('App\Domain\*\Events')
    ->classes()
    ->toImplementAny([ShouldBroadcast::class, ShouldBroadcastNow::class])
    ->when(fn (string $class): bool => str_contains($class, 'Broadcast') || str_contains($class, 'WebSocket'));

test('event broadcasting tidak boleh bergantung secara terbalik ke Http Controllers')
    ->expect('App\Domain\*\Events')
    ->not->toUse('App\Http\Controllers');
    
test('event broadcasting dilarang melakukan query database langsung')
    ->expect('App\Domain\*\Events')
    ->not->toUse('Illuminate\Support\Facades\DB')
    ->not->toUse('App\Models'); // Memaksa agar Event menggunakan konstruktor DTO primitif
```

### Unit Testing: Mencegah Kegagalan Payload dan Alokasi Channel

Menguji *Use Case* (Action) tanpa harus menjalankan Node.js atau WebSocket Server secara *live* selama fase CI/CD menggunakan *Mocking/Faking* murni.

```php
<?php

declare(strict_types=1);

// tests/Unit/Domain/Auction/Actions/PlaceBidActionTest.php

use App\Domain\Auction\Actions\PlaceBidAction;
use App\Domain\Auction\Events\NewBidPlaced;
use App\Domain\Auction\Models\Auction;
use App\Domain\Auction\Repositories\AuctionRepositoryInterface;
use App\Domain\User\Models\User;
use Illuminate\Support\Facades\Event;
use Mockery\MockInterface;
use DomainException;

it('mengirimkan event WebSockets yang presisi saat lelang diajukan', function (): void {
    // 1. Arrange & Mocking
    Event::fake([NewBidPlaced::class]);
    
    $auctionId = 'AUC-404';
    $amount = 5500000.00;
    
    $bidder = User::factory()->make([
        'id' => 'USR-999',
        'name' => 'Budi Santoso',
    ]);

    $auction = new Auction([
        'id' => $auctionId,
        'current_highest_bid' => 5000000.00, // Bid awal lebih rendah, harus sukses
        'currency' => 'IDR'
    ]);
    $auction->id = $auctionId;

    /** @var AuctionRepositoryInterface|MockInterface $repository */
    $repository = Mockery::mock(AuctionRepositoryInterface::class);
    $repository->shouldReceive('lockForUpdate')
        ->once()
        ->with($auctionId)
        ->andReturn($auction);

    $action = new PlaceBidAction($repository);

    // 2. Act
    $action->execute($auctionId, $bidder, $amount);

    // 3. Assert Broadcasting
    Event::assertDispatched(NewBidPlaced::class, function (NewBidPlaced $event) use ($auctionId, $bidder, $amount): bool {
        
        $channels = $event->broadcastOn();
        
        // Memastikan tipe Channel dan Nama Channel sesuai kesepakatan
        expect($channels)->toHaveCount(1)
            ->and($channels[0]->name)->toBe('presence-auction.room.' . $auctionId)
            ->and($event->broadcastAs())->toBe('auction.bid.placed');

        // Memastikan payload spesifik dan struktur JSON tidak berubah
        $payload = $event->broadcastWith();
        
        expect($payload)->toHaveKeys(['auction_id', 'bidder', 'amount', 'currency', 'timestamp'])
            ->and($payload['amount'])->toBe($amount)
            ->and($payload['currency'])->toBe('IDR')
            ->and($payload['bidder']['id'])->toBe((string) $bidder->id)
            ->and($payload['bidder']['name'])->toBe($bidder->name);
            
        return true;
    });
});
```

### HTTP Testing: Memvalidasi Filter Keamanan Koneksi (Auth Endpoint)

Mengecek stabilitas integrasi otorisasi dari rute `channels.php` via HTTP Request karena pada saat inisiasi koneksi ke channel jenis *Private/Presence*, klien `laravel-echo` akan melempar *HTTP POST* rahasia ke `/broadcasting/auth`.

```php
<?php

declare(strict_types=1);

// tests/Feature/BroadcastingAuthTest.php

use App\Domain\User\Models\User;
use App\Domain\Auction\Models\Auction;
use Illuminate\Support\Facades\DB;

it('hanya memberikan otorisasi kepada pengguna VIP yang mendaftar ke ruang lelang', function (): void {
    // Arrange
    $vipUser = User::factory()->create([
        'vip_level' => 'Diamond'
    ]);
    
    $auction = Auction::factory()->create(['id' => 'AUC-777']);
    
    // Inject otorisasi DB tabel pivot murni
    DB::table('auction_participants')->insert([
        'auction_id' => $auction->id,
        'user_id' => $vipUser->id,
    ]);

    $channelName = 'presence-auction.room.' . $auction->id;
    $socketId = '849202.193240'; // Simulasi Reverb Socket Identifier

    // Act
    $response = $this->actingAs($vipUser)
        ->postJson('/broadcasting/auth', [
            'channel_name' => $channelName,
            'socket_id' => $socketId,
        ]);

    // Assert
    $response->assertSuccessful();
    
    // Memastikan payload Presence Channel mengandung metadata 'channel_data'
    $response->assertJsonStructure([
        'auth',
        'channel_data'
    ]);
    
    $channelData = json_decode($response->json('channel_data'), true, 512, JSON_THROW_ON_ERROR);
    
    expect($channelData['user_info']['level'])->toBe('Diamond')
        ->and($channelData['user_id'])->toBe($vipUser->id);
});

it('menolak akses pengguna publik yang menyusup ke ruang lelang premium', function (): void {
    // Arrange: User tidak didaftarkan di table auction_participants
    $publicUser = User::factory()->create();
    $auctionId = 'AUC-SECRET';
    $channelName = 'presence-auction.room.' . $auctionId;

    // Act
    $response = $this->actingAs($publicUser)
        ->postJson('/broadcasting/auth', [
            'channel_name' => $channelName,
            'socket_id' => '000000.000000',
        ]);

    // Assert
    $response->assertForbidden();
});
```

---

## Ringkasan Eksekutif

Mengadopsi Laravel Reverb di lingkungan produksi membutuhkan perencanaan kapasitas arsitektural di atas sekadar menginstal dependensi. 

Kunci keberhasilan implementasi WebSockets tingkat tinggi terletak pada 3 pilar:
1. **Presisi Transfer Data**: Hanya mem-broadcast informasi esensial (hindari instansiasi model yang masif), gunakan DTO.
2. **Pengamanan Jalur Broadcast**: Lakukan operasi basis data pada `channels.php` seringan mungkin, disarankan memakai query Pivot, Redis *Exists*, atau sekadar Claims dari *Token* pengguna.
3. **Penyebaran Event Eksplisit (Explicit Trigger)**: Picu (`trigger`) *event real-time* secara eksklusif dari dalam lapisan *Action / Use Case* bukan dari siklus kejadian implisit (*Lifecycle Observer*). 

Ketaatan pada pola ini akan secara drastis mengurangi biaya pemeliharaan *server-side rendering*, menekan *bottleneck* dari sisi *database*, dan menyediakan pengalaman waktu nyata (*real-time experience*) yang mulus hingga puluhan ribu pengguna tanpa kompromi performa.

*(End of technical specifications)*
