---
title: "Laravel Action-Domain-Responder (ADR)"
description: "Mastering the Action-Domain-Responder pattern in Laravel 11/12 using PHP 8.3+. Deep dive into Clean Architecture, Responders, Domain Services, and Pest v3 Testing."
version: "1.0.0"
---

# Laravel Action-Domain-Responder (ADR) Masterclass

## 1. Introduction to ADR
The Action-Domain-Responder (ADR) pattern, coined by Paul M. Jones, is a refinement of the classic Model-View-Controller (MVC) architectural pattern, specifically tailored for web applications. While MVC was originally designed for desktop GUI applications, ADR aligns perfectly with the HTTP request/response cycle. In Laravel, adopting ADR means breaking free from "Fat Controllers" and establishing a crisp, highly cohesive separation of concerns.

ADR components:
- **Action**: The entry point for the HTTP request. It extracts input, passes it to the Domain, and feeds the Domain's output into the Responder.
- **Domain**: The core business logic. It handles validation, state mutations, and external integrations. It knows absolutely nothing about HTTP.
- **Responder**: Responsible for building the HTTP response. It takes the output from the Action (or Domain) and formats it as HTML, JSON, CSV, etc.

## 2. Why ADR over MVC in Modern Laravel?
In standard MVC, Controllers often accumulate too many responsibilities: validation, business logic, formatting, and HTTP negotiation. This violates the Single Responsibility Principle (SRP).

**ADR Benefits:**
1. **Unrivaled Testability**: The Domain is purely PHP, making unit tests lightning-fast. The Responder can be tested independently of the Action.
2. **Framework Agnosticism in Domain**: The Domain relies less on Laravel's HTTP primitives.
3. **Cognitive Simplicity**: Every Action is a single-action controller (`__invoke`).
4. **Content Negotiation**: Responders handle different outputs (e.g., API vs Web) seamlessly without polluting the Action.

---

## 3. Anti-Patterns & Refactoring

### ❌ Anti-Pattern 1: The "God Controller" (Fat Action & Coupled Response)
**Security/Memory/Performance Risks:**
- **Security**: Mixing business logic with HTTP routing often leads to bypassed authorization checks.
- **Memory**: Injecting numerous repositories and services into a massive controller bloats memory usage per request, even for simple endpoints.
- **Performance**: God controllers tend to eagerly load unrelated relationships to satisfy multiple return types in one massive method.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Mail\OrderCreatedMail;
use Illuminate\Support\Facades\Mail;

class OrderController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        // ❌ BAD: Mixed Validation
        $validated = $request->validate([
            'product_id' => 'required|exists:products,id',
            'quantity' => 'required|integer|min:1',
            'customer_email' => 'required|email',
        ]);

        // ❌ BAD: Business Logic & DB Transactions mixed in HTTP layer
        DB::beginTransaction();
        try {
            $order = Order::create($validated);
            
            // ❌ BAD: Direct external calls in controller
            Mail::to($validated['customer_email'])->send(new OrderCreatedMail($order));
            
            DB::commit();
            
            // ❌ BAD: Hardcoded response formatting
            return response()->json([
                'status' => 'success',
                'message' => 'Order created successfully.',
                'data' => $order
            ], 201);
        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Order creation failed', ['error' => $e->getMessage()]);
            return response()->json(['error' => 'Internal Server Error'], 500);
        }
    }
}
```

### ✅ GOOD CODE: Clean ADR (Action + Domain + Responder)
**Improvements:**
- **Security**: Validation is extracted to FormRequests; authorization is handled precisely.
- **Memory**: The Action only injects exactly what it needs (the specific Use Case and Responder).
- **Performance**: Domain logic can be optimized or queued independently.

```php
<?php

declare(strict_types=1);

namespace App\Http\Actions\Orders;

use App\Http\Requests\Orders\StoreOrderRequest;
use App\Domain\Orders\UseCases\CreateOrderUseCase;
use App\Domain\Orders\DTOs\CreateOrderDTO;
use App\Http\Responders\Orders\OrderCreatedResponder;
use Symfony\Component\HttpFoundation\Response;

final readonly class StoreOrderAction
{
    public function __construct(
        private CreateOrderUseCase $createOrderUseCase,
        private OrderCreatedResponder $responder,
    ) {}

    public function __invoke(StoreOrderRequest $request): Response
    {
        // 1. Action: Collect Input
        $dto = CreateOrderDTO::fromRequest($request);

        // 2. Domain: Execute Business Logic
        $order = $this->createOrderUseCase->execute($dto);

        // 3. Responder: Format Output
        return $this->responder->respond($order);
    }
}
```

---

### ❌ Anti-Pattern 2: Domain Logic Leakage in Responders
**Security/Memory/Performance Risks:**
- **Security**: Exposing full Eloquent models to the Responder can lead to accidental exposure of hidden/sensitive attributes if `makeVisible()` is misused or serialization rules fail.
- **Memory**: Passing massive Collections to a Responder that only needs 2 fields wastes RAM.
- **Performance**: Responders executing N+1 queries during formatting because relationships weren't eager-loaded in the Domain layer.

```php
<?php

declare(strict_types=1);

namespace App\Http\Responders\Users;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class UserProfileResponder
{
    public function respond(User $user): JsonResponse
    {
        // ❌ BAD: Domain logic (calculating subscription status) in the Responder
        $isPremium = $user->subscriptions()->where('active', true)->exists();
        
        // ❌ BAD: N+1 query trigger in Responder layer
        $recentInvoices = $user->invoices()->latest()->take(5)->get();

        return response()->json([
            'id' => $user->id,
            'email' => $user->email,
            'is_premium' => $isPremium,
            'invoices' => $recentInvoices,
        ], Response::HTTP_OK);
    }
}
```

### ✅ GOOD CODE: Dumb Responders & Smart Domains
**Improvements:**
- **Security**: The Domain returns a strictly typed DTO or ViewModel. The Responder only maps it.
- **Memory**: The ViewModel only contains exactly what is needed for the response.
- **Performance**: The Domain executes all queries efficiently before handing off to the Responder.

```php
<?php

declare(strict_types=1);

namespace App\Http\Responders\Users;

use App\Domain\Users\ViewModels\UserProfileViewModel;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final readonly class UserProfileResponder
{
    public function respond(UserProfileViewModel $viewModel): JsonResponse
    {
        // ✅ GOOD: Responder only formats data provided by the Domain
        return response()->json([
            'data' => [
                'id' => $viewModel->id,
                'email' => $viewModel->email,
                'status' => $viewModel->premiumStatus,
                'recent_invoices' => $viewModel->recentInvoices->toArray(),
            ],
            'meta' => [
                'timestamp' => now()->toIso8601String(),
            ]
        ], Response::HTTP_OK);
    }
}
```

---

## 4. Comprehensive ADR Implementation (PHP 8.4 + Laravel 11)

### 4.1. The Input: Form Request & DTO
Using PHP 8.4 constructor property promotion and readonly classes for immutable DTOs.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payments\DTOs;

use App\Http\Requests\Payments\ProcessPaymentRequest;
use SensitiveParameter;

final readonly class ProcessPaymentDTO
{
    public function __construct(
        public string $orderId,
        public float $amount,
        #[SensitiveParameter]
        public string $creditCardToken,
    ) {}

    public static function fromRequest(ProcessPaymentRequest $request): self
    {
        return new self(
            orderId: $request->validated('order_id'),
            amount: (float) $request->validated('amount'),
            creditCardToken: $request->validated('cc_token'),
        );
    }
}
```

### 4.2. The Domain: Use Case & Exceptions
The domain should throw custom exceptions, which the central exception handler or the Action will catch and map to appropriate HTTP codes.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Payments\UseCases;

use App\Domain\Payments\DTOs\ProcessPaymentDTO;
use App\Domain\Payments\Exceptions\PaymentDeclinedException;
use App\Models\Payment;
use Illuminate\Support\Facades\DB;
use App\Services\PaymentGateway\GatewayInterface;

final readonly class ProcessPaymentUseCase
{
    public function __construct(
        private GatewayInterface $gateway,
    ) {}

    /**
     * @throws PaymentDeclinedException
     */
    public function execute(ProcessPaymentDTO $dto): Payment
    {
        return DB::transaction(function () use ($dto) {
            $gatewayResponse = $this->gateway->charge(
                $dto->amount, 
                $dto->creditCardToken
            );

            if (! $gatewayResponse->isSuccessful()) {
                throw new PaymentDeclinedException($gatewayResponse->getErrorMessage());
            }

            return Payment::create([
                'order_id' => $dto->orderId,
                'amount' => $dto->amount,
                'transaction_id' => $gatewayResponse->getTransactionId(),
                'status' => 'completed',
            ]);
        });
    }
}
```

### 4.3. The Responder: Format Negotiation
A great Responder can negotiate content types based on request headers (`Accept: application/json` vs `Accept: text/html`).

```php
<?php

declare(strict_types=1);

namespace App\Http\Responders\Payments;

use App\Models\Payment;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Symfony\Component\HttpFoundation\Response;

final readonly class PaymentProcessedResponder
{
    public function __construct(
        private Request $request,
    ) {}

    public function respond(Payment $payment): Response
    {
        if ($this->request->wantsJson()) {
            return new JsonResponse([
                'message' => 'Payment processed successfully.',
                'payment_id' => $payment->id,
                'transaction_ref' => $payment->transaction_id,
            ], Response::HTTP_CREATED);
        }

        // Fallback for Web/Inertia
        return redirect()->route('payments.success', $payment)
            ->with('success', 'Payment successful!');
    }
}
```

### 4.4. The Action: Orchestrating the Flow
The Action remains remarkably thin.

```php
<?php

declare(strict_types=1);

namespace App\Http\Actions\Payments;

use App\Http\Requests\Payments\ProcessPaymentRequest;
use App\Domain\Payments\DTOs\ProcessPaymentDTO;
use App\Domain\Payments\UseCases\ProcessPaymentUseCase;
use App\Http\Responders\Payments\PaymentProcessedResponder;
use Symfony\Component\HttpFoundation\Response;

final readonly class ProcessPaymentAction
{
    public function __construct(
        private ProcessPaymentUseCase $useCase,
        private PaymentProcessedResponder $responder,
    ) {}

    public function __invoke(ProcessPaymentRequest $request): Response
    {
        $dto = ProcessPaymentDTO::fromRequest($request);

        $payment = $this->useCase->execute($dto);

        return $this->responder->respond($payment);
    }
}
```

---

## 5. Testing ADR with Pest v3

Using Pest v3, we ensure the highest level of code coverage. We test the Action, Domain, Responder, and Architecture.

### 5.1. Unit Testing the Action
Mock the Domain and Responder to ensure the Action passes data correctly.

```php
<?php

declare(strict_types=1);

use App\Http\Actions\Payments\ProcessPaymentAction;
use App\Http\Requests\Payments\ProcessPaymentRequest;
use App\Domain\Payments\UseCases\ProcessPaymentUseCase;
use App\Http\Responders\Payments\PaymentProcessedResponder;
use App\Models\Payment;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

it('orchestrates the payment process correctly', function () {
    // Arrange
    $request = Mockery::mock(ProcessPaymentRequest::class);
    $request->shouldReceive('validated')->with('order_id')->andReturn('ORD-123');
    $request->shouldReceive('validated')->with('amount')->andReturn(100.50);
    $request->shouldReceive('validated')->with('cc_token')->andReturn('tok_123');

    $payment = new Payment(['id' => 1]);

    $useCase = Mockery::mock(ProcessPaymentUseCase::class);
    $useCase->shouldReceive('execute')
        ->once()
        ->andReturn($payment);

    $responder = Mockery::mock(PaymentProcessedResponder::class);
    $responder->shouldReceive('respond')
        ->once()
        ->with($payment)
        ->andReturn(new JsonResponse([], Response::HTTP_CREATED));

    $action = new ProcessPaymentAction($useCase, $responder);

    // Act
    $response = $action($request);

    // Assert
    expect($response->getStatusCode())->toBe(Response::HTTP_CREATED);
});
```

### 5.2. Unit Testing the Responder
Ensure the Responder handles content negotiation properly.

```php
<?php

declare(strict_types=1);

use App\Http\Responders\Payments\PaymentProcessedResponder;
use App\Models\Payment;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;

it('returns a JSON response when requested', function () {
    $request = Request::create('/payments', 'POST');
    $request->headers->set('Accept', 'application/json');

    $payment = new Payment([
        'id' => 99,
        'transaction_id' => 'TXN-888'
    ]);

    $responder = new PaymentProcessedResponder($request);
    $response = $responder->respond($payment);

    expect($response)->toBeInstanceOf(JsonResponse::class)
        ->and($response->getStatusCode())->toBe(201)
        ->and($response->getData(true))->toMatchArray([
            'message' => 'Payment processed successfully.',
            'payment_id' => 99,
            'transaction_ref' => 'TXN-888',
        ]);
});

it('returns a Redirect response for web requests', function () {
    $request = Request::create('/payments', 'POST');
    
    $payment = new Payment(['id' => 99]);

    $responder = new PaymentProcessedResponder($request);
    $response = $responder->respond($payment);

    expect($response)->toBeInstanceOf(RedirectResponse::class)
        ->and($response->getSession()->get('success'))->toBe('Payment successful!');
});
```

### 5.3. Architecture Testing
Ensure Clean Architecture boundaries are respected using Pest's Arch plugin.

```php
<?php

declare(strict_types=1);

arch('actions should be invokable')
    ->expect('App\Http\Actions')
    ->toHaveMethod('__invoke')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();

arch('responders should only format data')
    ->expect('App\Http\Responders')
    ->toHaveMethod('respond')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly()
    ->toOnlyUse([
        'Illuminate\Http',
        'Symfony\Component\HttpFoundation',
        'App\Domain', // Allowed to take ViewModels/DTOs
        'App\Models', // Allowed to take Models (if no ViewModel exists)
    ]);

arch('domain should not depend on HTTP layer')
    ->expect('App\Domain')
    ->toNotUse([
        'Illuminate\Http',
        'App\Http',
    ]);

arch('domain use cases should be strictly typed')
    ->expect('App\Domain\*\UseCases')
    ->toBeClasses()
    ->toBeFinal()
    ->toBeReadonly();
```

## 6. Real-World Tips for ADR at Scale

1. **Don't Over-Engineer Trivial Endpoints**: If an endpoint just returns a static view or a simple list (e.g., `Country::all()`), a single Action returning a standard Laravel Response is fine. Responders and Use Cases are for complex flows.
2. **Action Naming Conventions**: Instead of `UserController@store`, name the Action based on the specific capability: `RegisterUserAction`, `PromoteUserToAdminAction`.
3. **Use ViewModels for Complex Reads**: When the Responder needs to format a massive amount of aggregated data, have the Domain Use Case return a `ViewModel`. A ViewModel transforms raw Eloquent collections into highly specific, localized data structures that the Responder or Blade templates can consume without logic.
4. **Exception Handling**: Rely on Laravel's `bootstrap/app.php` exception handler (`->withExceptions()`) to catch Domain exceptions (like `InsufficientFundsException`) and translate them to HTTP 422 or 400 responses. This keeps the Action and Responder completely ignorant of failure HTTP codes.

---
