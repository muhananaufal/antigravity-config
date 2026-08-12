# SQS & SNS Event Federation di Laravel (Microservices Pub/Sub)

## Arsitektur & Motivasi
Dalam arsitektur microservices enterprise (Golang, Python, Laravel), komunikasi point-to-point via REST RESTful / gRPC menyebabkan *tight coupling* dan masalah ketahanan. Solusi Top 1% adalah Event-Driven Architecture menggunakan AWS SNS (Simple Notification Service) sebagai Topic Broadcaster dan AWS SQS (Simple Queue Service) FIFO (First-In-First-Out) sebagai antrean konsumen dengan *Message Deduplication*.

### Diagram Event Bus (SNS -> SQS Fanout)
```text
[Golang Service]           [Python Service]             [Laravel Vapor Service (Publisher)]
      |                           |                                   |
      |                           | 1. Publish Event (SNS Topic: user_registered.fifo)
      |                           |<----------------------------------|
      V                           V
 [AWS SNS Topic: "enterprise_events.fifo"] (Broadcaster)
      |
      |-- (Fanout SQS Subscription 1) --> [AWS SQS: "laravel_notification_queue.fifo"]
      |                                             |
      |                                             |-- (Laravel Queue Worker / Lambda Event) --> [Process Email]
      |
      |-- (Fanout SQS Subscription 2) --> [AWS SQS: "golang_analytics_queue.fifo"]
                                                    |
                                                    |-- (Go gRPC Worker) --> [Process Data Warehouse]
```

## Implementasi PHP 8.3 / Laravel 11 (PHPStan Level 9)

```php
<?php

declare(strict_types=1);

namespace App\Services\EventBus;

use Aws\Sns\SnsClient;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Throwable;

final readonly class SNSEventPublisher
{
    public function __construct(
        private SnsClient $snsClient,
        private string $topicArn
    ) {}

    /**
     * @param string $eventName
     * @param array<string, mixed> $payload
     * @param string $messageGroupId (For FIFO Ordering)
     * @param string $deduplicationId (For FIFO Exactly-Once Delivery)
     * @return string MessageId
     */
    public function publish(
        string $eventName,
        array $payload,
        string $messageGroupId,
        string $deduplicationId
    ): string {
        try {
            $messagePayload = json_encode([
                'event' => $eventName,
                'data' => $payload,
                'timestamp' => now()->toIso8601String(),
            ], JSON_THROW_ON_ERROR);

            $result = $this->snsClient->publish([
                'TopicArn' => $this->topicArn,
                'Message' => $messagePayload,
                'MessageGroupId' => $messageGroupId,
                'MessageDeduplicationId' => $deduplicationId,
                'MessageAttributes' => [
                    'event_type' => [
                        'DataType' => 'String',
                        'StringValue' => $eventName,
                    ],
                ],
            ]);

            $messageId = $result->get('MessageId');
            if (!is_string($messageId)) {
                throw new RuntimeException('SNS Publish failed, MessageId not returned as string.');
            }

            Log::info(sprintf('Event published to SNS: %s (MsgID: %s)', $eventName, $messageId));

            return $messageId;
        } catch (Throwable $e) {
            Log::error('SNS Publish Exception: ' . $e->getMessage(), ['exception' => $e]);
            throw new RuntimeException('Failed to publish event to SNS.', (int) $e->getCode(), $e);
        }
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Jobs\EventBus;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

final class HandleFederatedEventJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $timeout = 60;

    /**
     * @param array<string, mixed> $eventPayload
     */
    public function __construct(
        private readonly array $eventPayload
    ) {}

    public function handle(): void
    {
        $eventType = $this->eventPayload['event'] ?? 'unknown';
        $data = $this->eventPayload['data'] ?? [];

        Log::info(sprintf('Processing federated event: %s', $eventType));

        match ($eventType) {
            'user_registered' => $this->handleUserRegistered($data),
            'order_placed' => $this->handleOrderPlaced($data),
            default => Log::warning(sprintf('Unhandled event type: %s', $eventType)),
        };
    }

    /**
     * @param array<mixed> $data
     */
    private function handleUserRegistered(array $data): void
    {
        // ... execute logic ...
    }

    /**
     * @param array<mixed> $data
     */
    private function handleOrderPlaced(array $data): void
    {
        // ... execute logic ...
    }
}
```

## Pest v3 Tests

```php
<?php

use App\Services\EventBus\SNSEventPublisher;
use Aws\Sns\SnsClient;
use Aws\Result;
use Mockery\MockInterface;

test('publishes event to sns topic with fifo parameters', function () {
    $mockResult = new Result(['MessageId' => 'msg-12345']);

    $snsClientMock = Mockery::mock(SnsClient::class, function (MockInterface $mock) use ($mockResult) {
        $mock->shouldReceive('publish')
            ->once()
            ->withArgs(function (array $args) {
                return $args['TopicArn'] === 'arn:aws:sns:us-east-1:123:topic.fifo'
                    && $args['MessageGroupId'] === 'user_1'
                    && $args['MessageDeduplicationId'] === 'dedup_1'
                    && $args['MessageAttributes']['event_type']['StringValue'] === 'user_registered';
            })
            ->andReturn($mockResult);
    });

    $publisher = new SNSEventPublisher($snsClientMock, 'arn:aws:sns:us-east-1:123:topic.fifo');
    $messageId = $publisher->publish('user_registered', ['user_id' => 1], 'user_1', 'dedup_1');

    expect($messageId)->toBe('msg-12345');
});
```

## Anti-Patterns & Edge Cases

### ❌ Anti-Pattern 1: Menggunakan Standard SQS untuk Event Kritis Keuangan
```php
// SALAH: Standard Queue tidak menjamin "Exactly-Once", menyebabkan double processing.
Queue::connection('sqs')->push(new ProcessPaymentJob($data));
```
✅ **Benar:** Gunakan SQS FIFO dengan `MessageDeduplicationId` berbasis hash dari payload transaksi untuk mencegah replay/duplicate processing.

### ❌ Anti-Pattern 2: Fat Payload (Mengirim Entire Model di Event)
```php
// SALAH: Mengirim seluruh row DB / file binary besar via SNS (batas 256KB).
$publisher->publish('order_placed', $orderModel->toArray(), ...);
```
✅ **Benar:** Claim-Check Pattern. Kirim referensi ID (`order_id => 123`). Konsumen (Worker) mengambil data terbaru dari Database atau S3.

### Production Edge Cases
1. **SNS Message Signature Forgery:** Serangan yang memalsukan webhook SNS secara eksternal. **Mitigasi:** Wajibkan library verifikasi AWS SNS Message Signature pada endpoint Webhook jika tidak menggunakan SQS internal subscription.
2. **Dead Letter Queue (DLQ) Overflow:** Konsumen gagal terus memproses pesan racun. **Mitigasi:** Konfigurasi SQS Redrive Policy `maxReceiveCount=3`, pindahkan ke DLQ, dan pasang CloudWatch Alarm jika DLQ > 0.
3. **FIFO Queue Bottleneck:** Strict ordering membatasi throughput (300 TPS limit default SQS FIFO). **Mitigasi:** Kelompokkan `MessageGroupId` dengan cerdas, misal berdasarkan `tenant_id` atau `user_id` daripada `global`, agar antrean bisa di-paralelisasi.
