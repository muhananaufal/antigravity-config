---
title: "Mastering Laravel API Documentation"
description: "Top 1% Guide to Building, Maintaining, and Testing API Documentation in Laravel 11/12 with PHP 8.3/8.4. Includes Scramble, L5-Swagger, and Pest v3."
tags: [laravel, api, documentation, scramble, swagger, openapi, pest]
---

# Mastering Laravel API Documentation

API documentation is the UI/UX for developers consuming your API. In the modern Laravel ecosystem (Laravel 11/12 + PHP 8.3/8.4), manual documentation is considered a severe anti-pattern. The Top 1% standard dictates that documentation must be **generated automatically**, **strictly typed**, and **tested for regressions** to prevent configuration drift.

This guide covers advanced strategies for maintaining source-of-truth documentation using Clean Architecture, OpenAPI specifications, and Pest v3.

## 1. The Modern Paradigm: Code as the Source of Truth

Maintaining separate Postman collections, Notion pages, or Markdown files leads to inevitable drift. When a developer adds a new column to a database or a new field to a request, they will inevitably forget to update a disconnected markdown file. Modern API documentation relies on generating the OpenAPI (Swagger) specification directly from your codebase.

In the Laravel ecosystem, there are two premier ways to achieve this:
1. **Scramble** (`dedoc/scramble`): The modern, zero-annotation, AST-based documentation generator. It infers routes, request rules, and resource structures directly from your PHP code. This is the **highly recommended** approach for Top 1% teams.
2. **L5-Swagger** (`darkaonline/l5-swagger`): The traditional annotation-based approach using PHP attributes. Requires extensive boilerplate but offers explicit, manual control over every aspect of the OpenAPI spec.

## 2. Clean Architecture & Documentation Inference

To leverage automated tools like Scramble effectively, your code must adhere to strict Clean Architecture. Automatic generators read your `FormRequest` for input parameters and your `JsonResource` for output schemas. If your logic is tangled in a monolithic controller, the documentation generator will fail to infer the schema.

### The Foundation: Strictly Typed Models and Resources

Models are the core of your domain. By defining precise PHPDoc properties and strict casting, you allow tools to infer exactly what data types are being processed.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;

/**
 * @property string $id
 * @property string $name
 * @property string $email
 * @property \Carbon\CarbonImmutable $created_at
 * @property \Carbon\CarbonImmutable $updated_at
 */
final class User extends Model
{
    use HasUuids;
    
    protected $fillable = ['name', 'email', 'password'];
    
    protected function casts(): array
    {
        return [
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
        ];
    }
}
```

### The Output: API Resources with Array Shapes

Your `JsonResource` dictates the exact structure of the API response. Scramble will parse this to generate the output schema. By utilizing PHPStan/Psalm array shape annotations, we provide a mathematically sound definition of the response.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use App\Domain\Users\Models\User;

/**
 * @mixin User
 */
final class UserResource extends JsonResource
{
    /**
     * Transform the resource into an array.
     *
     * @return array{
     *     id: string,
     *     name: string,
     *     email: string,
     *     joined_at: string
     * }
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'email' => $this->email,
            'joined_at' => $this->created_at->toIso8601String(),
        ];
    }
}
```
*Note the use of `@return array{...}`. Scramble uses this AST information to perfectly map the response in the OpenAPI spec.*

### The Input: Explicit FormRequests

Your incoming data structure must be strictly defined in a `FormRequest`. Any validation rule provided here will be automatically extracted into the OpenAPI documentation.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string|\Illuminate\Validation\Rules\Password>>
     */
    public function rules(): array
    {
        return [
            /**
             * The full name of the user.
             * @example John Doe
             */
            'name' => ['required', 'string', 'max:255'],
            
            /**
             * A unique email address.
             * @example john@example.com
             */
            'email' => ['required', 'string', 'email', 'max:255', 'unique:users,email'],
            
            /**
             * Secure password with minimum requirements.
             */
            'password' => ['required', 'string', \Illuminate\Validation\Rules\Password::defaults()],
        ];
    }
}
```

### The Controller: Binding it Together

With inputs and outputs defined, the controller simply glues the request to the domain action, and formats the response.

```php
<?php

declare(strict_types=1);

namespace App\Domain\Users\Http\Controllers;

use App\Domain\Users\Http\Requests\StoreUserRequest;
use App\Domain\Users\Http\Resources\UserResource;
use App\Domain\Users\Actions\CreateUserAction;
use Illuminate\Http\JsonResponse;

final class UserController
{
    /**
     * Create a new user.
     * 
     * Registers a new user in the system and dispatches a welcome email.
     *
     * @unauthenticated
     */
    public function store(StoreUserRequest $request, CreateUserAction $action): JsonResponse
    {
        $user = $action->execute($request->validated());
        
        return response()->json([
            'data' => new UserResource($user),
            'message' => 'User created successfully.'
        ], 201);
    }
}
```

## 3. Anti-Patterns in API Documentation

### Anti-Pattern 1: Out-of-Sync Documentation (Manual Markdown/Postman)

The biggest failure in API management is maintaining docs manually. When developers update the code, they often forget to update the documentation. 

❌ **BAD: Manual API Blueprint/Markdown**
```markdown
# POST /api/v1/users
Body:
- name (string, required)
- email (string, required)

Response:
{ "id": 1, "name": "John" }
```
*Why it's bad*: The response returns a UUID string in the code, but the manually typed docs say integer ID. Clients will crash because they trust the documentation.

✅ **GOOD: Generating Docs via Scramble / Code AST**
Using `dedoc/scramble`, the documentation is generated on-the-fly directly from the AST of the PHP code. If the code changes, the documentation updates instantly. The documentation is the code.

```bash
composer require dedoc/scramble
php artisan vendor:publish --provider="Dedoc\Scramble\ScrambleServiceProvider" --tag="scramble-config"
```

### Anti-Pattern 2: Controller God Objects Hiding API Schema

If you don't use FormRequests and Resources, automatic generators cannot infer the schema. They cannot "run" the code, they can only parse the abstract syntax tree.

❌ **BAD: Inline Validation and Response mapping**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Models\Post;

final class BadController
{
    public function store(Request $request)
    {
        // Generators cannot easily parse complex inline arrays inside method bodies
        $validated = $request->validate([
            'title' => 'required|string',
            'body' => 'required|string',
        ]);
        
        $post = Post::create($validated);
        
        // The return structure is hidden in the controller logic
        return response()->json([
            'success' => true,
            'payload' => [
                'post_id' => $post->id,
                'content' => $post->body
            ]
        ]);
    }
}
```
*Why it's bad*: Tooling (and other developers) cannot look at this class from the outside and know exactly what it requires or returns without reading and mentally parsing the entire method body. The OpenAPI spec will show empty `{}` structures for this route.

✅ **GOOD: Explicit Contracts via FormRequest and JsonResource**
Use `StorePostRequest` and `PostResource`. Clean Architecture inherently documents the application because types are declared at the boundaries.

### Anti-Pattern 3: Exposing Internal Exception Traces in API Docs

When generating OpenAPI specs, sometimes internal exception structures leak into the documented `500` or `4xx` responses.

❌ **BAD: Uncontrolled Exception Rendering**
Not defining standard error responses means the API docs will either lack error documentation entirely or document the full, insecure Laravel exception stack trace.

✅ **GOOD: Standardized Problem Details (RFC 7807)**
Implement standardized error responses and document them explicitly.

```php
<?php

declare(strict_types=1);

namespace App\Exceptions;

use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Throwable;
use Illuminate\Http\JsonResponse;

final class Handler extends ExceptionHandler
{
    public function render($request, Throwable $e): JsonResponse
    {
        if ($request->wantsJson()) {
            return response()->json([
                'type' => 'about:blank',
                'title' => $this->getExceptionTitle($e),
                'status' => $this->getExceptionStatus($e),
                'detail' => $e->getMessage(),
                'instance' => $request->url(),
            ], $this->getExceptionStatus($e));
        }

        return parent::render($request, $e);
    }
}
```
*In Scramble, you can configure extensions to globally document these error responses across all endpoints, ensuring 404, 422, and 500 responses are universally documented.*

## 4. L5-Swagger (Annotation-Driven) Approach

While Scramble is preferred for new projects, legacy projects or APIs requiring highly customized, non-standard specifications often use `darkaonline/l5-swagger`.

L5-Swagger uses PHP Attributes (or Doctrine annotations) to manually define the OpenAPI spec. 

```php
<?php

declare(strict_types=1);

namespace App\Domain\Products\Http\Controllers;

use OpenApi\Attributes as OA;
use Illuminate\Http\JsonResponse;

final class ProductController
{
    #[OA\Get(
        path: '/api/products',
        summary: 'List products',
        tags: ['Products'],
        responses: [
            new OA\Response(
                response: 200,
                description: 'Successful operation',
                content: new OA\JsonContent(
                    type: 'array',
                    items: new OA\Items(
                        properties: [
                            new OA\Property(property: 'id', type: 'string', format: 'uuid'),
                            new OA\Property(property: 'name', type: 'string'),
                            new OA\Property(property: 'price', type: 'integer'),
                        ]
                    )
                )
            )
        ]
    )]
    public function index(): JsonResponse
    {
        // ... logic
    }
}
```

**Trade-offs**: 
- Pro: Maximum flexibility. You have absolute control over the output.
- Con: Extreme verbosity. The documentation code often exceeds the business logic code. It is prone to the same "out-of-sync" drift as manual Markdown, because changing the response array does not automatically update the `#[OA\Property]` attributes.

## 5. Security & Authentication Documentation

Ensure your security schemes are correctly documented. If using Sanctum (Bearer Token) for your API, configure it in Scramble.

```php
// config/scramble.php
return [
    'security' => [
        'bearerAuth' => [
            'type' => 'http',
            'scheme' => 'bearer',
            'bearerFormat' => 'JWT', // Or opaque token
        ],
    ],
    // ...
];
```

In your controllers, Scramble infers if a route requires auth based on middleware (e.g., `auth:sanctum`). You can manually override this with the `@unauthenticated` PHPDoc tag or the `#[Unauthenticated]` attribute from Scramble.

## 6. Architecture & Quality Testing with Pest v3

Top 1% APIs don't just generate documentation; they enforce the *quality* and *consistency* of the code that generates the documentation using Architecture tests.

We want to ensure that:
1. Every API Controller uses FormRequests (so input is documented).
2. Every API Controller returns JsonResources or standard responses (so output is documented).
3. No endpoint is lacking proper PHPDoc or Attributes if required by team standards.

```php
<?php

declare(strict_types=1);

// tests/Architecture/ApiDocumentationTest.php

test('api controllers must use strict types')
    ->expect('App\Domain\*\Http\Controllers')
    ->toUseStrictTypes();

test('api controllers must not use generic Illuminate Request')
    ->expect('App\Domain\*\Http\Controllers')
    ->not->toUse(\Illuminate\Http\Request::class)
    ->ignoring('App\Http\Controllers\Controller'); // Only allow strictly typed FormRequests

test('api controllers must return standard json responses')
    ->expect('App\Domain\*\Http\Controllers\*Controller')
    ->toHaveMethod('__invoke') // Or specific methods like store/index
    ->or()
    ->toReturn(\Illuminate\Http\JsonResponse::class)
    ->or()
    ->toReturn(\Illuminate\Http\Resources\Json\JsonResource::class);

test('all code must be free of debugging statements that leak in API docs')
    ->expect(['App\Domain', 'App\Http'])
    ->not->toUse(['dd', 'dump', 'var_dump', 'print_r', 'env']);
```

### Validating the OpenAPI Spec Generation in CI/CD

You must write a test that ensures the OpenAPI specification can be successfully generated without throwing exceptions. A failure here prevents a broken doc portal in production.

```php
<?php

declare(strict_types=1);

// tests/Feature/ApiDocumentationGenerationTest.php

use Dedoc\Scramble\Scramble;
use Dedoc\Scramble\Generator;

test('openapi specification generates successfully and validates', function () {
    /** @var Generator $generator */
    $generator = app(Generator::class);
    
    // Attempt to generate the spec. If Scramble encounters un-parseable AST, 
    // it may throw an exception, failing the test.
    $spec = $generator();
    
    expect($spec)->not->toBeNull()
        ->and($spec['openapi'])->toStartWith('3.1')
        ->and($spec['paths'])->not->toBeEmpty();
        
    // Optionally assert specific critical routes are present
    expect(array_keys($spec['paths']))->toContain('/api/users');
});
```

## 7. Versioning API Documentation

When you build `v1` and `v2` of an API, you must serve separate OpenAPI specs to prevent client confusion. Scramble handles this via Route configuration mapping in your service provider.

```php
<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Dedoc\Scramble\Scramble;
use Illuminate\Routing\Route;
use Illuminate\Support\Str;

final class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Scramble::registerApi('v1', [
            'api_path' => 'api/v1',
        ])->routes(fn (Route $route) => Str::startsWith($route->uri, 'api/v1/'));

        Scramble::registerApi('v2', [
            'api_path' => 'api/v2',
        ])->routes(fn (Route $route) => Str::startsWith($route->uri, 'api/v2/'));
    }
}
```

## Conclusion: Checklist for Top 1% API Documentation

- [ ] **Zero manual documentation.** Use `dedoc/scramble` to generate OpenAPI specs from the AST.
- [ ] **Strict Typing everywhere.** Use `array{...}` shapes in Resources and precise types in FormRequests.
- [ ] **Clean Architecture.** Keep controllers thin; extract logic to actions and routing structures to Requests/Resources. This acts as documentation.
- [ ] **Error Standardization.** Use RFC 7807 Problem Details for consistent error definitions, avoiding stack trace leaks.
- [ ] **Architecture Tests.** Enforce that API endpoints return proper Resource classes via Pest v3 `expect()->toReturn()`.
- [ ] **CI/CD Validation.** Ensure the OpenAPI spec can compile without errors during the testing pipeline.
