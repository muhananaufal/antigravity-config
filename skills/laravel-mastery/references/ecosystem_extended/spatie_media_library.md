---
description: "Top 1% Mastery of Spatie Media Library: Advanced patterns, Clean Architecture integration, performance optimization, and robust testing in Laravel 11/12 & PHP 8.3+"
---

# Spatie Media Library Mastery

## 1. Introduction & Philosophy

The Spatie Media Library is the de facto standard for associating files with Eloquent models in Laravel. While its basic usage is straightforward, mastering it in an enterprise context requires deep understanding of filesystem abstraction, queue management for image conversions, clean architecture principles, and memory optimization when dealing with large files.

This guide provides Top 1% engineering practices for using `spatie/laravel-medialibrary` in Laravel 11/12 and PHP 8.3/8.4 environments. We enforce strict typing, comprehensive testing, and strict separation of concerns to ensure highly scalable, secure, and maintainable web applications.

## 2. Core Concepts & Configuration

Before diving into code, configuration is critical for performance and security. Proper configuration prevents massive security loopholes, S3 bottlenecking, and out-of-memory errors on production servers.

### 2.1 Disk Configuration Best Practices

Always abstract your storage disk behind environment variables. Never hardcode `local` or `s3` in your application logic. This abstraction makes local development seamless and testing reliable.

```php
// config/filesystems.php
declare(strict_types=1);

return [
    'default' => env('FILESYSTEM_DISK', 'local'),
    'cloud' => env('FILESYSTEM_CLOUD', 's3'),
    'disks' => [
        'media' => [
            'driver' => 's3',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'region' => env('AWS_DEFAULT_REGION'),
            'bucket' => env('AWS_BUCKET'),
            'url' => env('AWS_URL'),
            'endpoint' => env('AWS_ENDPOINT'),
            'use_path_style_endpoint' => env('AWS_USE_PATH_STYLE_ENDPOINT', false),
            'throw' => true, // Always throw exceptions on failed uploads instead of silent failures
        ],
    ],
];
```

### 2.2 Media Library Config Optimization

```php
// config/media-library.php
declare(strict_types=1);

return [
    'disk_name' => env('MEDIA_DISK', 'media'),
    'max_file_size' => 1024 * 1024 * 50, // 50MB hard limit (Prevents DOS via massive files)
    'queue_conversions_by_default' => env('QUEUE_CONVERSIONS_BY_DEFAULT', true),
    'queue_name' => 'media_conversions', // Dedicated queue for heavy image processing
    'image_driver' => env('IMAGE_DRIVER', 'vips'), // Vips is significantly faster and uses less memory than GD/Imagick
    'path_generator' => \App\Infrastructure\Media\CustomPathGenerator::class, // Custom path generator for better S3 partitioning
];
```

## 3. Clean Architecture Integration

In a Clean Architecture setup, controllers should never handle file uploads directly. We use DTOs (Data Transfer Objects) to carry the file data and Actions to perform the upload. This allows uploads to be triggered from API Controllers, CLI Commands, or asynchronous jobs.

### 3.1 Data Transfer Object (DTO)

```php
// app/Domain/Users/DTOs/AvatarUploadDTO.php
declare(strict_types=1);

namespace App\Domain\Users\DTOs;

use Illuminate\Http\UploadedFile;

readonly class AvatarUploadDTO
{
    public function __construct(
        public UploadedFile $file,
        public int $userId,
    ) {}
}
```

### 3.2 The Action (Usecase)

```php
// app/Domain/Users/Actions/UploadUserAvatarAction.php
declare(strict_types=1);

namespace App\Domain\Users\Actions;

use App\Domain\Users\DTOs\AvatarUploadDTO;
use App\Domain\Users\Models\User;
use Spatie\MediaLibrary\MediaCollections\Exceptions\FileDoesNotExist;
use Spatie\MediaLibrary\MediaCollections\Exceptions\FileIsTooBig;
use Illuminate\Support\Facades\DB;
use Spatie\MediaLibrary\MediaCollections\Models\Media;

final class UploadUserAvatarAction
{
    /**
     * @throws FileDoesNotExist
     * @throws FileIsTooBig
     */
    public function execute(AvatarUploadDTO $dto): Media
    {
        return DB::transaction(function () use ($dto): Media {
            $user = User::findOrFail($dto->userId);

            // Using addMedia to collection with specific disk
            return $user->addMedia($dto->file)
                ->usingName(sprintf('avatar-%d-%s', $user->id, time()))
                ->sanitizingFileName(fn (string $fileName): string => strtolower(str_replace(['#', '/', '\\', ' '], '-', $fileName)))
                ->toMediaCollection('avatars', config('media-library.disk_name'));
        });
    }
}
```

### 3.3 The Eloquent Model Implementation

```php
// app/Domain/Users/Models/User.php
declare(strict_types=1);

namespace App\Domain\Users\Models;

use Illuminate\Database\Eloquent\Model;
use Spatie\Image\Enums\Fit;
use Spatie\MediaLibrary\HasMedia;
use Spatie\MediaLibrary\InteractsWithMedia;
use Spatie\MediaLibrary\MediaCollections\Models\Media;

class User extends Model implements HasMedia
{
    use InteractsWithMedia;

    public function registerMediaCollections(): void
    {
        $this->addMediaCollection('avatars')
            ->singleFile() // Ensures only one avatar exists at a time. Old ones are automatically deleted.
            ->acceptsMimeTypes(['image/jpeg', 'image/png', 'image/webp'])
            ->registerMediaConversions(function (?Media $media = null): void {
                $this->addMediaConversion('thumb')
                    ->fit(Fit::Crop, 100, 100)
                    ->nonQueued() // Thumbnails might be needed immediately for UI feedback
                    ->format('webp');

                $this->addMediaConversion('large')
                    ->fit(Fit::Max, 1024, 1024)
                    ->queued() // Large conversions should ALWAYS be queued
                    ->withResponsiveImages()
                    ->format('webp');
            });
    }
}
```

## 4. Security & Performance Deep Dive

### 4.1 Custom Path Generators for Cloud Storage

By default, Spatie Media Library stores files in folders named after the Media model sequential ID (e.g., `1/file.jpg`, `2/file.jpg`). On scalable file systems like AWS S3, sequential IDs can lead to partition hotspots, degrading read/write performance significantly at scale. A custom path generator that hashes the ID is a Top 1% practice.

```php
// app/Infrastructure/Media/CustomPathGenerator.php
declare(strict_types=1);

namespace App\Infrastructure\Media;

use Spatie\MediaLibrary\MediaCollections\Models\Media;
use Spatie\MediaLibrary\Support\PathGenerator\PathGenerator;

final class CustomPathGenerator implements PathGenerator
{
    public function getPath(Media $media): string
    {
        return $this->getBasePath($media) . '/';
    }

    public function getPathForConversions(Media $media): string
    {
        return $this->getBasePath($media) . '/conversions/';
    }

    public function getPathForResponsiveImages(Media $media): string
    {
        return $this->getBasePath($media) . '/responsive-images/';
    }

    private function getBasePath(Media $media): string
    {
        // Hash the ID to prevent S3 partition hotspots
        $hash = md5((string) $media->getKey());
        
        return sprintf(
            '%s/%s/%s/%s',
            $hash[0],
            $hash[1],
            $hash[2],
            $media->getKey()
        );
    }
}
```

### 4.2 Handling Large Files (Streaming)

When users upload very large files (e.g., videos or massive PDFs), loading the entire file into memory is catastrophic. Use streaming where possible to avoid `Allowed memory size exhausted` errors in PHP.

```php
// Streaming addition of media inside an Action
$user->addMediaFromStream($resource)
    ->usingFileName('large_video.mp4')
    ->toMediaCollection('videos');
```

### 4.3 Stripping EXIF Data (Privacy & Security)

Photos taken with smartphones contain EXIF data, which includes GPS coordinates. Exposing this data is a severe privacy violation. Always configure image conversions to strip EXIF data (Spatie Image strips it by default on manipulation, but enforce it).

```php
// Enforce no EXIF on conversions
$this->addMediaConversion('safe_original')
    ->keepOriginalImageFormat()
    ->queued(); 
// The original file retains EXIF. You should ONLY serve the 'safe_original' conversion to the public!
```

## 5. Anti-Patterns (❌ BAD vs ✅ GOOD)

### 5.1 Anti-Pattern 1: Direct File Upload in Controller (God Controller)

❌ **BAD CODE**: Controller handles request validation, file system operations, and database logic synchronously.

```php
// ❌ BAD: app/Http/Controllers/UserController.php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;

class UserController extends Controller
{
    public function uploadAvatar(Request $request, User $user)
    {
        // 1. Validation inside controller method (Should be FormRequest)
        $request->validate([
            'avatar' => 'required|image|mimes:jpeg,png|max:2048'
        ]);

        // 2. Direct manipulation of the file
        $file = $request->file('avatar');
        $filename = time() . '_' . $file->getClientOriginalName();
        
        // 3. Manual storage (bypassing Spatie Media Library's robust features)
        $path = $file->storeAs('public/avatars', $filename);
        
        // 4. Manual DB update
        $user->avatar_path = $path;
        $user->save();

        return response()->json(['message' => 'Avatar uploaded']);
    }
}
```

**Security/Memory/Performance Risks:**
- **Security Risk:** `getClientOriginalName()` is notoriously insecure and can lead to path traversal or XSS if the filename is reflected in the DOM without sanitization.
- **Maintenance Nightmare:** If you change the storage driver from local to S3, you have to rewrite the controller.
- **No Conversions:** You lose the ability to easily generate thumbnails or responsive images, causing front-end performance degradation.

✅ **GOOD CODE**: Action-based, utilizing Spatie Media Library with DTOs and FormRequests.

```php
// ✅ GOOD: app/Http/Controllers/Api/UserAvatarController.php
declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Users\Actions\UploadUserAvatarAction;
use App\Domain\Users\DTOs\AvatarUploadDTO;
use App\Http\Requests\UploadAvatarRequest;
use Illuminate\Http\JsonResponse;

final class UserAvatarController
{
    public function __invoke(
        UploadAvatarRequest $request, 
        UploadUserAvatarAction $action
    ): JsonResponse {
        $dto = new AvatarUploadDTO(
            file: $request->file('avatar'),
            userId: (int) $request->user()->id
        );

        $media = $action->execute($dto);

        return response()->json([
            'message' => 'Avatar uploaded successfully',
            'url' => $media->getUrl('thumb'),
        ]);
    }
}
```

### 5.2 Anti-Pattern 2: Synchronous Image Conversions for Large Files

❌ **BAD CODE**: Forcing synchronous conversions for heavy image processing blocks the PHP-FPM worker, causing timeouts and terrible UX.

```php
// ❌ BAD: Synchronous conversion registration
public function registerMediaCollections(): void
{
    $this->addMediaCollection('gallery')
        ->registerMediaConversions(function (?Media $media = null): void {
            // Generating 5 different sizes synchronously for a 10MB image
            // This will block the HTTP request for 5-10 seconds!
            $this->addMediaConversion('xs')->width(150)->nonQueued();
            $this->addMediaConversion('sm')->width(300)->nonQueued();
            $this->addMediaConversion('md')->width(600)->nonQueued();
            $this->addMediaConversion('lg')->width(1200)->nonQueued();
            $this->addMediaConversion('xl')->width(2400)->nonQueued();
        });
}
```

**Security/Memory/Performance Risks:**
- **Performance Risk:** PHP-FPM workers are tied up processing images. High concurrent uploads will exhaust server resources (CPU and RAM).
- **UX Impact:** Users stare at a loading spinner until the HTTP request times out (usually 30s or 60s) or gateway timeout (504) occurs.

✅ **GOOD CODE**: Queued conversions with a dedicated worker pool.

```php
// ✅ GOOD: Queued conversions
public function registerMediaCollections(): void
{
    $this->addMediaCollection('gallery')
        ->registerMediaConversions(function (?Media $media = null): void {
            $this->addMediaConversion('thumb')
                ->width(150)
                ->nonQueued(); // Only small thumb is synchronous for immediate UI feedback

            $this->addMediaConversion('sm')->width(300)->queued();
            $this->addMediaConversion('md')->width(600)->queued();
            $this->addMediaConversion('lg')->width(1200)->queued();
            $this->addMediaConversion('xl')->width(2400)->queued();
        });
}
```

### 5.3 Anti-Pattern 3: N+1 Queries with Media

❌ **BAD CODE**: Loading media in a loop causes N+1 queries.

```php
// ❌ BAD: Controller
$users = User::all(); // 1 query

// Blade View
@foreach($users as $user)
    <!-- N queries triggered here! -->
    <img src="{{ $user->getFirstMediaUrl('avatars', 'thumb') }}" />
@endforeach
```

**Security/Memory/Performance Risks:**
- **Database Overload:** 100 users on a page = 101 queries. This will destroy database performance under load and drastically increase response time.

✅ **GOOD CODE**: Eager loading media relationships.

```php
// ✅ GOOD: Controller
$users = User::with('media')->get(); // 2 queries total

// Blade View
@foreach($users as $user)
    <img src="{{ $user->getFirstMediaUrl('avatars', 'thumb') }}" />
@endforeach
```

### 5.4 Anti-Pattern 4: Exposing Sequential Media IDs

❌ **BAD CODE**: Returning the default integer ID of media models to the frontend.

```json
// API Response (BAD)
{
  "id": 452,
  "url": "https://s3.aws.com/bucket/452/avatar.jpg"
}
```

**Security/Memory/Performance Risks:**
- **Insecure Direct Object Reference (IDOR):** Attackers can easily guess sequential IDs (e.g., 453, 454) and attempt to scrape or access unauthorized media files.

✅ **GOOD CODE**: Expose UUIDs for media items.

Configure your Media library to use UUIDs instead of integers.

```php
// config/media-library.php
'media_model' => App\Models\Media::class, // Custom model extending Spatie's Media
```

```php
// app/Models/Media.php
declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Spatie\MediaLibrary\MediaCollections\Models\Media as SpatieMedia;

class Media extends SpatieMedia
{
    use HasUuids; // Ensures UUIDs are generated for the primary key
}
```

## 6. Advanced Feature: Downloading Multiple Files as ZIP

Spatie Media Library provides a brilliant utility to stream multiple files into a single ZIP download on the fly. This avoids server memory exhaustion as it doesn't create the ZIP file fully on disk before sending.

```php
// app/Http/Controllers/Api/DownloadUserGalleryController.php
declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Users\Models\User;
use Illuminate\Http\Request;
use Spatie\MediaLibrary\Support\MediaStream;

final class DownloadUserGalleryController
{
    public function __invoke(Request $request, User $user)
    {
        $downloads = $user->getMedia('gallery');
        
        // This streams the zip creation directly to the HTTP response!
        return MediaStream::create('user-gallery.zip')->addMedia($downloads);
    }
}
```

## 7. Testing with Pest v3

Testing file uploads requires mocking the filesystem and ensuring that conversions are dispatched (or faked) correctly. We use Pest v3 to write clean, expressive tests.

### 7.1 Unit Testing the Upload Action

```php
// tests/Unit/Domain/Users/Actions/UploadUserAvatarActionTest.php
declare(strict_types=1);

use App\Domain\Users\Actions\UploadUserAvatarAction;
use App\Domain\Users\DTOs\AvatarUploadDTO;
use App\Domain\Users\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Queue;
use Spatie\MediaLibrary\Conversions\Jobs\PerformConversionsJob;
use Spatie\MediaLibrary\MediaCollections\Models\Media;

beforeEach(function () {
    // Fake the specific disk used by Media Library
    Storage::fake(config('media-library.disk_name'));
    Queue::fake(); // Fake queues to prevent jobs from actually running
});

it('uploads a user avatar and returns the media instance', function () {
    // Arrange
    $user = User::factory()->create();
    $file = UploadedFile::fake()->image('avatar.jpg', 600, 600);
    $dto = new AvatarUploadDTO(file: $file, userId: $user->id);
    $action = app(UploadUserAvatarAction::class);

    // Act
    $media = $action->execute($dto);

    // Assert Domain Logic
    expect($media)->toBeInstanceOf(Media::class)
        ->and($media->collection_name)->toBe('avatars')
        ->and($media->mime_type)->toBe('image/jpeg')
        ->and($user->getMedia('avatars'))->toHaveCount(1);
        
    // Assert Filesystem Logic
    Storage::disk(config('media-library.disk_name'))->assertExists($media->getPathRelativeToRoot());
    
    // Assert Conversion Jobs were dispatched
    Queue::assertPushed(PerformConversionsJob::class);
});

it('replaces the existing avatar when a new one is uploaded (singleFile)', function () {
    // Arrange
    $user = User::factory()->create();
    $action = app(UploadUserAvatarAction::class);
    
    $file1 = UploadedFile::fake()->image('first.jpg');
    $dto1 = new AvatarUploadDTO(file: $file1, userId: $user->id);
    $media1 = $action->execute($dto1);
    
    $file2 = UploadedFile::fake()->image('second.png');
    $dto2 = new AvatarUploadDTO(file: $file2, userId: $user->id);
    
    // Act
    $media2 = $action->execute($dto2);
    
    // Assert
    expect($user->fresh()->getMedia('avatars'))->toHaveCount(1)
        ->and($user->fresh()->getFirstMedia('avatars')->file_name)->toContain('second.png');
        
    // Assert Old file is deleted from disk
    Storage::disk(config('media-library.disk_name'))->assertMissing($media1->getPathRelativeToRoot());
});
```

### 7.2 Architecture Testing

Ensure that no controller directly touches `Spatie\MediaLibrary\MediaCollections\Models\Media`. We strictly enforce the usage of Actions and DTOs.

```php
// tests/Architecture/MediaLibraryTest.php
declare(strict_types=1);

arch('controllers do not interact directly with media models')
    ->expect('App\Http\Controllers')
    ->not->toUse('Spatie\MediaLibrary\MediaCollections\Models\Media')
    ->ignoring('App\Http\Controllers\Admin'); // Exceptional case for Admin panels if needed

arch('dtos are immutable and strictly typed')
    ->expect('App\Domain\*\DTOs')
    ->classes()
    ->toBeReadonly()
    ->toUseStrictTypes();

arch('actions do not use http requests')
    ->expect('App\Domain\*\Actions')
    ->not->toUse('Illuminate\Http\Request');
```

## 8. Summary & Final Checklist

To achieve Top 1% mastery with Spatie Media Library, enforce these rules in code reviews:
1. **Never use the Controller for direct uploads.** Always proxy through a strictly typed DTO and an Action class.
2. **Always Queue heavy conversions.** Use `->queued()` for any conversion that resizes images or generates responsive images to save PHP-FPM processes.
3. **Use a Custom Path Generator.** Prevent S3 partitioning hotspots by hashing media IDs.
4. **Use Vips instead of GD/Imagick.** Configure `'image_driver' => 'vips'` for massive memory savings and faster processing.
5. **Eager Load Media.** Always use `with('media')` when iterating over models in views or API transformers to prevent N+1 queries.
6. **Fake the Disk & Queues in Tests.** Use `Storage::fake()` and `Queue::fake()`, and explicitly test the side effects of your Actions.
7. **Use UUIDs.** Prevent IDOR vulnerabilities by replacing standard integer IDs with UUIDs for all Media models.
8. **Strip EXIF Data.** Protect user privacy by generating clean conversions that strip geolocation and device data from original images.
