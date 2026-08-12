# gRPC Integration in Laravel 11 Microservices

## 1. Introduction

Dalam ekosistem microservices, HTTP/REST bisa menjadi bottleneck karena overhead teks (JSON) dan koneksi HTTP/1.1 yang *stateless*. **gRPC** (Google Remote Procedure Call) menggunakan HTTP/2 dan Protocol Buffers (Protobuf) untuk memberikan komunikasi antar-layanan (inter-service) yang strongly-typed, sangat cepat, dengan payload biner berukuran kecil.

Dokumen ini menguraikan penerapan gRPC di Laravel 11 / PHP 8.3 dengan Clean Architecture, memanfaatkan environment seperti RoadRunner atau Swoole (Laravel Octane) yang mendukung long-running processes dan worker multiplexing.

## 2. Core Concepts

*   **Protobuf (`.proto`):** Bahasa pendeskripsi antarmuka (IDL) yang bahasa-agnostik. Mendifinisikan layanan (RPCs) dan struktur pesan (Messages).
*   **gRPC Server:** Menerima request biner HTTP/2, memanggil metode yang relevan, dan mereturn response biner. Di PHP, ini butuh RoadRunner/Swoole.
*   **gRPC Client:** Stub yang melakukan pemanggilan ke server. Bisa berjalan di PHP-FPM tradisional, CLI, atau worker Octane.
*   **Channels & Connections:** Koneksi persisten ke server HTTP/2, krusial untuk performa HFT (High-Frequency Trading) atau microservices yang intensif.

## 3. Clean Architecture Integration

Integrasi gRPC melibatkan dua sisi: bertindak sebagai **Server** (menyediakan layanan) dan bertindak sebagai **Client** (mengkonsumsi layanan).

### 3.1. Protobuf Definition (Kontrak)

```protobuf
// proto/user/v1/user_service.proto
syntax = "proto3";

package user.v1;

option php_namespace = "App\\Infrastructure\\Grpc\\Generated\\User\\V1";
option php_metadata_namespace = "App\\Infrastructure\\Grpc\\Generated\\GPBMetadata";

service UserService {
    rpc GetUser (GetUserRequest) returns (GetUserResponse);
}

message GetUserRequest {
    string user_id = 1;
}

message GetUserResponse {
    string id = 1;
    string name = 2;
    string email = 3;
}
```

### 3.2. Server-Side: Presentation Layer

Dalam Clean Architecture, gRPC Controller (atau Service Impl) berada di **Presentation Layer**. Tugasnya hanyalah memetakan Protobuf request ke DTO/UseCase (Application Layer) dan sebaliknya.

```php
<?php

declare(strict_types=1);

namespace App\Presentation\Grpc\Controllers;

use App\Application\UseCases\User\GetUserUseCase;
use App\Application\DTOs\User\GetUserDto;
use App\Infrastructure\Grpc\Generated\User\V1\UserServiceInterface;
use App\Infrastructure\Grpc\Generated\User\V1\GetUserRequest;
use App\Infrastructure\Grpc\Generated\User\V1\GetUserResponse;
use Spiral\RoadRunner\GRPC\ContextInterface;
use Throwable;

final class UserGrpcController implements UserServiceInterface
{
    public function __construct(
        private readonly GetUserUseCase $useCase
    ) {}

    public function GetUser(ContextInterface $ctx, GetUserRequest $in): GetUserResponse
    {
        try {
            // Map Protobuf Request to Application DTO
            $dto = new GetUserDto(id: $in->getUserId());
            
            // Execute Business Logic
            $user = $this->useCase->execute($dto);
            
            // Map Domain Model/DTO to Protobuf Response
            $response = new GetUserResponse();
            $response->setId($user->id);
            $response->setName($user->name);
            $response->setEmail($user->email);
            
            return $response;
            
        } catch (\App\Domain\Exceptions\UserNotFoundException $e) {
            // Error mapping to gRPC Status
            throw new \App\Presentation\Grpc\Exceptions\GrpcException(
                message: 'User not found',
                code: \Spiral\RoadRunner\GRPC\StatusCode::NOT_FOUND
            );
        } catch (Throwable $e) {
            throw new \App\Presentation\Grpc\Exceptions\GrpcException(
                message: 'Internal server error',
                code: \Spiral\RoadRunner\GRPC\StatusCode::INTERNAL
            );
        }
    }
}
```

### 3.3. Client-Side: Infrastructure Layer (Adapter)

Jika layanan kita memanggil microservice lain, kita mendefinisikan *Port* (Interface) di Application Layer, lalu mengimplementasikannya di Infrastructure Layer menggunakan gRPC Client.

```php
<?php

declare(strict_types=1);

// Application/Ports/Outbound/PaymentGatewayInterface.php
namespace App\Application\Ports\Outbound;

interface PaymentGatewayInterface
{
    public function processPayment(string $orderId, float $amount): bool;
}

// Infrastructure/Adapters/Grpc/PaymentGatewayGrpcAdapter.php
namespace App\Infrastructure\Adapters\Grpc;

use App\Application\Ports\Outbound\PaymentGatewayInterface;
use App\Infrastructure\Grpc\Generated\Payment\V1\PaymentServiceClient;
use App\Infrastructure\Grpc\Generated\Payment\V1\ProcessPaymentRequest;
use Grpc\ChannelCredentials;

final readonly class PaymentGatewayGrpcAdapter implements PaymentGatewayInterface
{
    private PaymentServiceClient $client;

    public function __construct(string $hostname)
    {
        $this->client = new PaymentServiceClient($hostname, [
            'credentials' => ChannelCredentials::createInsecure(),
        ]);
    }

    public function processPayment(string $orderId, float $amount): bool
    {
        $request = new ProcessPaymentRequest();
        $request->setOrderId($orderId);
        $request->setAmount($amount);

        /** @var \App\Infrastructure\Grpc\Generated\Payment\V1\ProcessPaymentResponse $response */
        /** @var \Grpc\Call $status */
        [$response, $status] = $this->client->ProcessPayment($request)->wait();

        if ($status->code !== \Grpc\STATUS_OK) {
            // Log & handle error natively in Infrastructure
            throw new \App\Infrastructure\Exceptions\PaymentGatewayException(
                'gRPC call failed: ' . $status->details
            );
        }

        return $response->getSuccess();
    }
}
```

## 4. Anti-Patterns & Best Practices

### Anti-Pattern 1: Melekatkan Protobuf Objects ke Domain Layer

❌ **Anti-Pattern:** Menggunakan object class yang digenerate oleh `protoc` (seperti `GetUserRequest` atau `GetUserResponse`) sebagai argumen atau return type di UseCases atau Domain Entities.

```php
<?php
// ❌ BAD: Application Layer bergantung pada Protobuf (Infrastruktur/Presentation details)
namespace App\Application\UseCases;

use App\Infrastructure\Grpc\Generated\User\V1\GetUserRequest; // LEAK!

class ProcessUserActionUseCase
{
    public function execute(GetUserRequest $request): void
    {
        $userId = $request->getUserId();
        // logic
    }
}
```
*Penjelasan:* Ini mengikat inti aplikasi ke protokol komunikasi (gRPC). Jika besok kita juga perlu menyajikan UseCase ini via GraphQL atau REST, kita terpaksa melakukan refactoring besar-besaran karena parameternya adalah object gRPC.

✅ **Best Practice:** Selalu *map* object Protobuf menjadi DTO standar atau primitif sebelum memasuki Application Layer.

```php
<?php
// ✅ GOOD: UseCase hanya menerima DTO PHP murni
namespace App\Application\UseCases;

use App\Application\DTOs\UserActionDto;

class ProcessUserActionUseCase
{
    public function execute(UserActionDto $dto): void
    {
        $userId = $dto->userId;
        // logic
    }
}
```

### Anti-Pattern 2: Tidak Menggunakan Connection Pool atau Persistent Channels (Blocking Sync)

❌ **Anti-Pattern:** Melakukan instantiasi `new gRPCClient()` setiap kali ada request (di environment FPM tanpa ekstensi gRPC persisten, atau di loop). Ini akan membangun koneksi HTTP/2 berulang kali.

```php
<?php
// ❌ BAD: Re-creating connection per call without pooling/persistency
foreach ($items as $item) {
    $client = new GrpcClient('localhost:9090', []);
    $client->Process($item);
}
```
*Penjelasan:* SSL Handshake dan inisialisasi koneksi HTTP/2 memakan waktu. Melakukannya berulang kali dalam satu request cycle atau per iterasi akan menghancurkan keuntungan latensi dari gRPC.

✅ **Best Practice:** Register gRPC Client sebagai Singleton di Laravel Container, andalkan Octane (RoadRunner/Swoole) untuk menjaga worker hidup, atau gunakan persistent channel config di ekstensi `ext-grpc` PHP.

```php
<?php
// ✅ GOOD: Singleton injection in Provider
namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Infrastructure\Grpc\Generated\Payment\V1\PaymentServiceClient;
use Grpc\ChannelCredentials;

class GrpcServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(PaymentServiceClient::class, function () {
            // Ekstensi gRPC C akan me-reuse channel ke host ini secara default
            // jika array konfigurasi identik.
            return new PaymentServiceClient(config('services.payment.grpc_host'), [
                'credentials' => ChannelCredentials::createInsecure(),
                'grpc.keepalive_time_ms' => 10000,
            ]);
        });
    }
}
```

## 5. Testing with Pest v3

### 5.1. Unit Testing Presentation Layer (gRPC Controller)

Kita harus memastikan Controller dengan tepat memetakan input Protobuf ke DTO dan sebaliknya.

```php
<?php

declare(strict_types=1);

use App\Presentation\Grpc\Controllers\UserGrpcController;
use App\Application\UseCases\User\GetUserUseCase;
use App\Application\DTOs\User\GetUserDto;
use App\Domain\Entities\User;
use App\Infrastructure\Grpc\Generated\User\V1\GetUserRequest;
use Spiral\RoadRunner\GRPC\ContextInterface;

it('maps grpc request to use case and returns valid protobuf response', function () {
    // Arrange
    $useCaseMock = Mockery::mock(GetUserUseCase::class);
    
    $mockUser = new User(id: 'usr_123', name: 'John Doe', email: 'john@example.com');
    
    // Expectation: DTO received must have the correct ID mapped
    $useCaseMock->shouldReceive('execute')
        ->withArgs(function (GetUserDto $dto) {
            return $dto->id === 'usr_123';
        })
        ->once()
        ->andReturn($mockUser);

    $controller = new UserGrpcController($useCaseMock);
    
    $ctxMock = Mockery::mock(ContextInterface::class);
    $request = new GetUserRequest();
    $request->setUserId('usr_123');

    // Act
    $response = $controller->GetUser($ctxMock, $request);

    // Assert
    expect($response->getId())->toBe('usr_123')
        ->and($response->getName())->toBe('John Doe')
        ->and($response->getEmail())->toBe('john@example.com');
});
```

### 5.2. Architecture Testing

Memastikan batas-batas *layer* terjaga terkait dependensi Protobuf/gRPC.

```php
<?php

declare(strict_types=1);

use PHPUnit\Architecture\ArchitectureAsserts;

test('Domain and Application layers do not depend on gRPC classes', function () {
    expect(['App\Domain', 'App\Application'])
        ->not->toUse('Grpc')
        ->not->toUse('App\Infrastructure\Grpc\Generated')
        ->because('gRPC is an infrastructure delivery detail, not a core business concept.');
});

test('gRPC controllers are only located in Presentation layer', function () {
    expect('Spiral\RoadRunner\GRPC\ServiceInterface')
        ->toBeUsedOnlyIn('App\Presentation\Grpc\Controllers')
        ->because('All gRPC server interfaces must be implemented within the Presentation Layer.');
});
```
