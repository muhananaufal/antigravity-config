# Laravel Socialite & SSO Mastery (Top 1%)

Laravel Socialite provides an expressive, fluent interface to OAuth authentication with various providers (Google, GitHub, Facebook, etc.). However, in enterprise applications, handling SSO (Single Sign-On) requires more than just calling `Socialite::driver('provider')->user()`. It demands strict typing, clean architecture, robust error handling, and protection against common security vectors like Account Takeover (ATO) through email collisions.

This guide focuses on PHP 8.3/8.4 and Laravel 11/12 features, enforcing `declare(strict_types=1);` and utilizing advanced architectural patterns.

---

## 1. Core Architecture for SSO

Enterprise SSO integrations should never contain business logic within the controller. Instead, the controller should act as a simple HTTP transport layer, delegating the complex work of user matching, creation, and profile updating to dedicated Action classes.

### The Provider Enum
First, define a strongly typed Enum to restrict the allowed OAuth providers. This prevents arbitrary provider injections.

```php
<?php

declare(strict_types=1);

namespace App\Enums;

enum OAuthProvider: string
{
    case GOOGLE = 'google';
    case GITHUB = 'github';
    case MICROSOFT = 'microsoft';
}
```

### The Thin Controller
The controller simply resolves the enum and passes the data to the action.

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Auth;

use App\Enums\OAuthProvider;
use App\Http\Controllers\Controller;
use App\Actions\Auth\HandleSocialiteCallbackAction;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use Laravel\Socialite\Facades\Socialite;
use Throwable;
use Illuminate\Support\Facades\Log;

final class SocialiteController extends Controller
{
    public function redirect(OAuthProvider $provider): RedirectResponse
    {
        return Socialite::driver($provider->value)
            ->with(['prompt' => 'select_account'])
            ->redirect();
    }

    public function callback(
        OAuthProvider $provider, 
        HandleSocialiteCallbackAction $action
    ): RedirectResponse {
        try {
            $socialiteUser = Socialite::driver($provider->value)->user();
            
            $user = $action->execute($provider, $socialiteUser);
            
            Auth::login($user, remember: true);
            
            request()->session()->regenerate();
            
            return redirect()->intended(route('dashboard'));
        } catch (Throwable $exception) {
            Log::error('SSO Callback Failed', [
                'provider' => $provider->value,
                'message' => $exception->getMessage(),
                'trace' => $exception->getTraceAsString(),
            ]);
            
            return redirect()->route('login')->withErrors([
                'auth' => 'Authentication failed. Please try again or use another method.',
            ]);
        }
    }
}
```

---

## 2. The Core Logic: HandleSocialiteCallbackAction

The core logic handles matching the OAuth user to our database. This involves checking for linked accounts (via `provider_id`) and preventing email collisions (where an attacker creates a GitHub account with a victim's email to hijack their Laravel account).

```php
<?php

declare(strict_types=1);

namespace App\Actions\Auth;

use App\Enums\OAuthProvider;
use App\Models\User;
use App\Models\LinkedAccount;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Socialite\Contracts\User as SocialiteUser;
use App\Exceptions\Auth\EmailCollisionException;
use Carbon\CarbonImmutable;

final readonly class HandleSocialiteCallbackAction
{
    /**
     * @throws EmailCollisionException
     */
    public function execute(OAuthProvider $provider, SocialiteUser $socialiteUser): User
    {
        return DB::transaction(function () use ($provider, $socialiteUser): User {
            // 1. Check if the exact linked account already exists
            $linkedAccount = LinkedAccount::query()
                ->where('provider_name', $provider->value)
                ->where('provider_id', $socialiteUser->getId())
                ->first();

            if ($linkedAccount !== null) {
                $this->updateLinkedAccountTokens($linkedAccount, $socialiteUser);
                return $linkedAccount->user;
            }

            // 2. Account doesn't exist via provider_id. Check via email.
            $user = User::query()->where('email', $socialiteUser->getEmail())->first();

            if ($user !== null) {
                // Email exists, but it's not linked to this provider.
                // SECURITY: If the OAuth provider doesn't strictly verify emails, 
                // we might allow an account takeover. 
                // E.g., someone creates a GitHub account with `admin@example.com` without verifying it.
                // If we blindly link it, they get admin access.
                // Solution: Either block it and force them to login via password and link manually,
                // OR only auto-link if the provider guarantees email verification (like Google).
                
                if ($this->shouldBlockAutoLinking($provider, $user)) {
                    throw new EmailCollisionException('An account with this email already exists. Please login using your password and link your account in settings.');
                }
                
                // If safe, link it.
                $this->createLinkedAccount($user, $provider, $socialiteUser);
                return $user;
            }

            // 3. User doesn't exist at all. Create them.
            $newUser = User::query()->create([
                'name' => $socialiteUser->getName() ?? $socialiteUser->getNickname() ?? 'Unknown User',
                'email' => $socialiteUser->getEmail(),
                'email_verified_at' => CarbonImmutable::now(), // Assume OAuth provider verified it, or set to null if uncertain.
                'password' => null, // Passwordless account
                'avatar_url' => $socialiteUser->getAvatar(),
                'remember_token' => Str::random(60),
            ]);

            $this->createLinkedAccount($newUser, $provider, $socialiteUser);

            return $newUser;
        });
    }

    private function updateLinkedAccountTokens(LinkedAccount $account, SocialiteUser $socialiteUser): void
    {
        $account->update([
            'access_token' => $socialiteUser->token,
            'refresh_token' => $socialiteUser->refreshToken,
            'avatar_url' => $socialiteUser->getAvatar(),
        ]);
    }

    private function createLinkedAccount(User $user, OAuthProvider $provider, SocialiteUser $socialiteUser): void
    {
        $user->linkedAccounts()->create([
            'provider_name' => $provider->value,
            'provider_id' => $socialiteUser->getId(),
            'access_token' => $socialiteUser->token,
            'refresh_token' => $socialiteUser->refreshToken,
            'avatar_url' => $socialiteUser->getAvatar(),
        ]);
    }

    private function shouldBlockAutoLinking(OAuthProvider $provider, User $user): bool
    {
        // Example: Only auto-link Google. GitHub can have unverified emails if configured poorly.
        // In highly secure apps, NEVER auto-link. Always throw.
        return $provider !== OAuthProvider::GOOGLE;
    }
}
```

---

## 3. Anti-Patterns & Refactoring

### ❌ Anti-Pattern 1: Bloated Controllers & Unsafe DB Queries

**Bad Code:**
```php
<?php
// BAD: Controller is bloated, handles logic, no strict types, vulnerable to mass assignment.

namespace App\Http\Controllers;

use Laravel\Socialite\Facades\Socialite;
use App\Models\User;
use Illuminate\Support\Facades\Auth;

class AuthController extends Controller
{
    public function handleProviderCallback($provider)
    {
        $user = Socialite::driver($provider)->user();

        // 🚨 BAD: What if $provider is a string the user manipulated?
        // 🚨 BAD: What if the email is null?
        $existingUser = User::where('email', $user->email)->first();

        if ($existingUser) {
            Auth::login($existingUser, true);
        } else {
            // 🚨 BAD: Mass assignment risk if we don't have $fillable configured correctly.
            // 🚨 BAD: Password is set to a weak random string, could be bruteforced if exposed.
            $newUser = clone $user;
            $createdUser = User::create([
                'name' => $user->name,
                'email' => $user->email,
                'provider' => $provider,
                'provider_id' => $user->id,
                'password' => bcrypt('password123') 
            ]);
            Auth::login($createdUser, true);
        }

        return redirect('/home');
    }
}
```

**Security/Memory/Performance Risks:**
1.  **Security (Account Takeover - ATO):** By blindly trusting `User::where('email', $user->email)->first();` and logging them in, we allow a severe Account Takeover vulnerability. An attacker can create a GitHub account using the administrator's email. Since GitHub allows unverified emails, the attacker can use GitHub SSO to log into the victim's account.
2.  **Security (Type Juggling / RCE Vectors):** Passing the `$provider` string directly into `Socialite::driver($provider)` can allow attackers to pass invalid drivers or potentially trigger unexpected autoloader behavior if the framework isn't strict.
3.  **Architecture (Monolith):** Putting DB queries in the controller makes testing the SSO logic without HTTP requests impossible.

**✅ GOOD CODE:** (See `HandleSocialiteCallbackAction` and `SocialiteController` in Section 1 & 2)

**Detailed Fix Explanation:**
-   **Strict Provider Enum:** We bound the route parameter to an `OAuthProvider` enum. If an attacker passes `/auth/malicious/callback`, Laravel's router throws a 404 immediately.
-   **Dedicated Action:** We extracted the logic into `HandleSocialiteCallbackAction`, allowing us to unit test the database linking logic purely using Pest without mocking HTTP.
-   **ATO Protection:** We added `shouldBlockAutoLinking` to explicitly prevent automatic account takeovers via email collision.

---

### ❌ Anti-Pattern 2: Missing State Verification & Stateless Abuse

**Bad Code:**
```php
<?php
// BAD: Using stateless() by default for web SSO, skipping CSRF protection.

namespace App\Http\Controllers;

use Laravel\Socialite\Facades\Socialite;
use App\Models\User;
use Illuminate\Support\Facades\Auth;

class AuthController extends Controller
{
    public function redirect($provider)
    {
        // 🚨 BAD: Using stateless() in a standard web application disables state parameter validation.
        return Socialite::driver($provider)->stateless()->redirect();
    }

    public function callback($provider)
    {
        // 🚨 BAD: Reading stateless user data ignores the 'state' CSRF check.
        $user = Socialite::driver($provider)->stateless()->user();
        
        $localUser = User::firstOrCreate(['email' => $user->email]);
        Auth::login($localUser);
        return redirect('/dashboard');
    }
}
```

**Security/Memory/Performance Risks:**
1.  **Security (CSRF / Login CSRF):** The `stateless()` method disables the `state` parameter validation in OAuth2. The `state` parameter is crucial for preventing Login CSRF. Without it, an attacker can start an SSO flow on their own machine, pause the redirect, and trick a victim into clicking the callback URL. The victim will then be logged into the *attacker\'s* account without realizing it. When the victim enters sensitive data (like adding a credit card), it gets saved to the attacker's account.
2.  **Security (Stateless abuse):** `stateless()` is ONLY meant for API-driven flows (like Mobile apps) where session-based state cannot be maintained. Web applications using standard session cookies MUST NOT use `stateless()`.

**✅ GOOD CODE:**
```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Auth;

use App\Enums\OAuthProvider;
use Illuminate\Http\RedirectResponse;
use Laravel\Socialite\Facades\Socialite;

final class SocialiteController extends Controller
{
    public function redirect(OAuthProvider $provider): RedirectResponse
    {
        // ✅ GOOD: State is automatically generated and verified by Laravel Socialite by default.
        // We also request specific prompt behavior.
        return Socialite::driver($provider->value)
            ->with(['prompt' => 'select_account'])
            ->redirect();
    }
    
    // ... callback method (as defined in Section 1)
}
```

**Detailed Fix Explanation:**
-   **Default State Management:** By removing `stateless()`, Socialite automatically writes a `state` string to the Laravel session and appends it to the OAuth authorization URL. Upon callback, Socialite verifies that the returned `state` matches the session. This completely mitigates Login CSRF.

---

## 4. Advanced: Schema Design for Linked Accounts

To support multiple OAuth providers per user, you must move away from putting `provider_id` directly on the `users` table.

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('linked_accounts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('provider_name'); // 'google', 'github', etc.
            $table->string('provider_id');
            $table->text('access_token')->nullable();
            $table->text('refresh_token')->nullable();
            $table->string('avatar_url')->nullable();
            $table->timestamps();

            // A provider_id should be unique per provider.
            $table->unique(['provider_name', 'provider_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('linked_accounts');
    }
};
```

---

## 5. Complete Pest v3 Testing

Comprehensive testing involves ensuring architectural rules are respected and the Action logic behaves correctly during happy paths and collisions.

### Architecture Tests (`tests/Architecture/SocialiteTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\Auth\HandleSocialiteCallbackAction;

test('socialite controllers do not contain business logic')
    ->expect('App\Http\Controllers\Auth')
    ->toOnlyUse([
        'Illuminate\Http\RedirectResponse',
        'Laravel\Socialite\Facades\Socialite',
        'App\Enums\OAuthProvider',
        'App\Actions\Auth',
        // other basic controller dependencies...
    ]);

test('auth actions are strongly typed and final')
    ->expect('App\Actions\Auth')
    ->toBeFinal()
    ->toUseStrictTypes();
```

### Unit/Feature Tests (`tests/Feature/Auth/SocialiteCallbackTest.php`)

```php
<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Actions\Auth\HandleSocialiteCallbackAction;
use App\Enums\OAuthProvider;
use App\Exceptions\Auth\EmailCollisionException;
use App\Models\LinkedAccount;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Socialite\Contracts\User as SocialiteUser;
use Laravel\Socialite\Two\User as SocialiteTwoUser;
use Mockery;
use function Pest\Laravel\assertDatabaseHas;

uses(RefreshDatabase::class);

it('creates a new user and linked account when user does not exist', function () {
    // Arrange
    $action = app(HandleSocialiteCallbackAction::class);
    $provider = OAuthProvider::GITHUB;
    
    $socialiteUser = new SocialiteTwoUser();
    $socialiteUser->map([
        'id' => '12345',
        'nickname' => 'johndoe',
        'name' => 'John Doe',
        'email' => 'john@example.com',
        'avatar' => 'https://example.com/avatar.jpg',
    ]);
    $socialiteUser->token = 'access-token-123';
    $socialiteUser->refreshToken = 'refresh-token-123';

    // Act
    $user = $action->execute($provider, $socialiteUser);

    // Assert
    expect($user)->toBeInstanceOf(User::class)
        ->and($user->email)->toBe('john@example.com');

    assertDatabaseHas('users', [
        'email' => 'john@example.com',
        'name' => 'John Doe',
    ]);

    assertDatabaseHas('linked_accounts', [
        'user_id' => $user->id,
        'provider_name' => 'github',
        'provider_id' => '12345',
        'access_token' => 'access-token-123',
    ]);
});

it('logs in existing user if linked account exists', function () {
    // Arrange
    $user = User::factory()->create();
    LinkedAccount::factory()->create([
        'user_id' => $user->id,
        'provider_name' => 'google',
        'provider_id' => 'google-999',
    ]);

    $action = app(HandleSocialiteCallbackAction::class);
    $provider = OAuthProvider::GOOGLE;
    
    $socialiteUser = new SocialiteTwoUser();
    $socialiteUser->map([
        'id' => 'google-999',
        'email' => 'doesnt-matter@example.com', // Should match by provider_id first
    ]);
    $socialiteUser->token = 'new-access-token';

    // Act
    $returnedUser = $action->execute($provider, $socialiteUser);

    // Assert
    expect($returnedUser->id)->toBe($user->id);
    
    assertDatabaseHas('linked_accounts', [
        'user_id' => $user->id,
        'provider_name' => 'google',
        'access_token' => 'new-access-token', // Ensure token is updated
    ]);
});

it('throws exception on email collision for unsafe providers', function () {
    // Arrange
    $existingUser = User::factory()->create([
        'email' => 'victim@example.com',
    ]);

    $action = app(HandleSocialiteCallbackAction::class);
    $provider = OAuthProvider::GITHUB; // Assume GitHub is configured as unsafe in the action
    
    $socialiteUser = new SocialiteTwoUser();
    $socialiteUser->map([
        'id' => 'attacker-id',
        'email' => 'victim@example.com',
    ]);

    // Act & Assert
    expect(fn () => $action->execute($provider, $socialiteUser))
        ->toThrow(EmailCollisionException::class);
});
```

---

## 6. Summary and Architectural Review

Integrating SSO seems simple with Socialite, but handling the enterprise edge-cases separates average code from top 1% code.
1.  **Never Use `stateless()` in Web Flow**: Always maintain session states to prevent Login CSRF.
2.  **Protect Against Email Collision**: Treat emails from OAuth providers with suspicion unless the provider explicitly guarantees their verification status.
3.  **One-to-Many Linking**: Use a `linked_accounts` table instead of hardcoding `github_id` and `google_id` columns on the `users` table.
4.  **Strict Typing**: Utilize Enums for provider names to prevent arbitrary string injection and tightly couple routing logic.
5.  **Action Pattern**: Keep the controllers empty. Testing SSO should not require HTTP Mocks unless you are explicitly testing the middleware.
