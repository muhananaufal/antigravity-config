# Laravel & PostGIS: High-Performance Spatial Indexing and Geospatial Queries

This guide covers top-tier implementations of PostGIS within Laravel 11/12 using PHP 8.3/8.4. It focuses on Clean Architecture, strong typing, spatial indexing (GiST), and eliminating common spatial query bottlenecks.

## 1. Foundation: Migrations and Spatial Indexes

To efficiently query geospatial data, a standard B-Tree index is insufficient. We must use a GiST (Generalized Search Tree) index on a `geography` or `geometry` column. The `geography` type is preferred for global lat/lon data as it accounts for the Earth's curvature (calculating in meters), while `geometry` is flat (calculating in degrees).

### Database Migration

```php
<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Ensure PostGIS extension is enabled
        DB::statement('CREATE EXTENSION IF NOT EXISTS postgis;');

        Schema::create('locations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('name');
            $table->string('category');
            
            // Define a geography point for longitude and latitude (SRID 4326)
            $table->geography('coordinates', subtype: 'point', srid: 4326);
            
            $table->timestamps();
        });

        // Add a GiST index to the coordinates column for blazing-fast spatial queries
        DB::statement('CREATE INDEX locations_coordinates_gist ON locations USING GIST (coordinates);');
    }

    public function down(): void
    {
        Schema::dropIfExists('locations');
    }
};
```

## 2. Clean Architecture Implementation

We decouple the layers: Request -> Controller -> Action -> Repository -> Model.

### Data Transfer Object (DTO) & Request

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Spatial;

use Illuminate\Foundation\Http\FormRequest;

final class FindNearbyLocationsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, \Illuminate\Contracts\Validation\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'latitude' => ['required', 'numeric', 'between:-90,90'],
            'longitude' => ['required', 'numeric', 'between:-180,180'],
            'radius_meters' => ['required', 'numeric', 'min:1', 'max:50000'],
        ];
    }

    public function toDto(): NearbyLocationDto
    {
        return new NearbyLocationDto(
            latitude: (float) $this->validated('latitude'),
            longitude: (float) $this->validated('longitude'),
            radiusMeters: (int) $this->validated('radius_meters'),
        );
    }
}
```

```php
<?php

declare(strict_types=1);

namespace App\Http\Requests\Spatial;

final readonly class NearbyLocationDto
{
    public function __construct(
        public float $latitude,
        public float $longitude,
        public int $radiusMeters,
    ) {}
}
```

### Model

```php
<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;

/**
 * @property string $id
 * @property string $name
 * @property string $category
 * @property mixed $coordinates
 */
final class Location extends Model
{
    use HasUuids;

    protected $table = 'locations';

    protected $fillable = [
        'name',
        'category',
        'coordinates',
    ];

    // Note: We handle spatial data casting or DB raw expressions at the repository layer 
    // or use a package like grimzy/laravel-mysql-spatial / mjaschen/phpgeo for robust model casting.
    // Here we focus on the raw PostGIS power via Repositories.
}
```

### Repository Layer

The repository handles the complex raw SQL required for optimal PostGIS execution.

```php
<?php

declare(strict_types=1);

namespace App\Repositories\Contracts;

use App\Http\Requests\Spatial\NearbyLocationDto;
use Illuminate\Support\Collection;

interface LocationRepositoryInterface
{
    /**
     * @return Collection<int, \App\Models\Location>
     */
    public function findWithinRadius(NearbyLocationDto $dto): Collection;
    
    public function createWithCoordinates(string $name, string $category, float $longitude, float $latitude): \App\Models\Location;
}
```

```php
<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Models\Location;
use App\Repositories\Contracts\LocationRepositoryInterface;
use App\Http\Requests\Spatial\NearbyLocationDto;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

final readonly class PostGisLocationRepository implements LocationRepositoryInterface
{
    public function findWithinRadius(NearbyLocationDto $dto): Collection
    {
        // ST_DWithin utilizes the GiST index perfectly for radius searches.
        // It's significantly faster than calculating distances for all rows and filtering.
        // Using parameterized bindings prevents SQL injection.
        return Location::query()
            ->select('locations.*')
            ->selectRaw(
                'ST_Distance(coordinates, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) as distance_meters',
                [$dto->longitude, $dto->latitude]
            )
            ->whereRaw(
                'ST_DWithin(coordinates, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)',
                [$dto->longitude, $dto->latitude, $dto->radiusMeters]
            )
            ->orderByRaw('distance_meters ASC')
            ->get();
    }

    public function createWithCoordinates(string $name, string $category, float $longitude, float $latitude): Location
    {
        $location = new Location([
            'name' => $name,
            'category' => $category,
        ]);

        // Using ST_MakePoint ensures valid geometry generation at the database level.
        $location->coordinates = DB::raw(
            sprintf(
                "ST_SetSRID(ST_MakePoint(%F, %F), 4326)::geography",
                $longitude,
                $latitude
            )
        );

        $location->save();

        return $location;
    }
}
```

### Action Layer

```php
<?php

declare(strict_types=1);

namespace App\Actions\Spatial;

use App\Http\Requests\Spatial\NearbyLocationDto;
use App\Repositories\Contracts\LocationRepositoryInterface;
use Illuminate\Support\Collection;

final readonly class FindLocationsWithinRadiusAction
{
    public function __construct(
        private LocationRepositoryInterface $locationRepository,
    ) {}

    /**
     * @return Collection<int, \App\Models\Location>
     */
    public function execute(NearbyLocationDto $dto): Collection
    {
        // Additional business logic could go here (e.g., filtering out inactive locations, logging)
        return $this->locationRepository->findWithinRadius($dto);
    }
}
```

### Controller Layer

```php
<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Spatial;

use App\Actions\Spatial\FindLocationsWithinRadiusAction;
use App\Http\Requests\Spatial\FindNearbyLocationsRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Routing\Controller;
use Symfony\Component\HttpFoundation\Response;

final class LocationController extends Controller
{
    public function index(FindNearbyLocationsRequest $request, FindLocationsWithinRadiusAction $action): JsonResponse
    {
        $dto = $request->toDto();
        
        $locations = $action->execute($dto);

        return response()->json([
            'data' => $locations,
            'meta' => [
                'count' => $locations->count(),
                'search_radius' => $dto->radiusMeters,
            ],
        ], Response::HTTP_OK);
    }
}
```

## 3. Anti-Patterns & Best Practices

### Anti-Pattern 1: Application-Level Haversine Formula (Memory Exhaustion)
❌ **Bad Practice:** Fetching all records (or large bounding boxes) into memory and calculating distances using PHP.

```php
// ❌ SECURITY/PERFORMANCE RISK: Fetching huge amounts of data and calculating distance in PHP.
// Memory Risk: If the table has 500k rows, fetching them all causes Fatal Error: Allowed memory size exhausted.
// Performance Risk: Complete table scan, rendering indexes useless. Takes seconds to minutes.
$allLocations = Location::all();
$nearby = $allLocations->filter(function ($loc) use ($lat, $lon) {
    return $this->calculateHaversineDistance($lat, $lon, $loc->latitude, $loc->longitude) <= 5000;
});
```

✅ **Good Practice:** Push the spatial calculation to PostGIS using `ST_DWithin`. PostGIS uses the GiST index to quickly eliminate rows outside the bounding box, then performs precise calculations only on the narrowed dataset.

```php
// ✅ Uses GiST index. Executes in milliseconds. No PHP memory bloat.
Location::whereRaw('ST_DWithin(coordinates, ST_MakePoint(?, ?)::geography, ?)', [$lon, $lat, $radius])->get();
```

### Anti-Pattern 2: String Interpolation in Spatial SQL (SQL Injection)
❌ **Bad Practice:** Concatenating raw variables directly into `DB::raw()` when executing spatial queries.

```php
// ❌ SECURITY RISK: SQL Injection. If $lat or $lon come from unvalidated user input, 
// a malicious user can inject SQL commands (e.g., dropping tables).
$lat = request('lat'); // e.g. "0); DROP TABLE locations; --"
$lon = request('lon');
Location::whereRaw("ST_DWithin(coordinates, ST_MakePoint($lon, $lat)::geography, 1000)")->get();
```

✅ **Good Practice:** Always use parameterized queries (bindings `?`) or cast inputs to strict types beforehand.

```php
// ✅ Safe execution using parameter bindings.
Location::whereRaw(
    'ST_DWithin(coordinates, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)',
    [$dto->longitude, $dto->latitude, $dto->radiusMeters]
)->get();
```

## 4. Pest v3 Testing (Unit, Feature, Arch)

A high-quality codebase requires testing architectural boundaries and spatial query correctness.

### Architecture Test (`tests/ArchTest.php`)

```php
<?php

declare(strict_types=1);

arch('strict types are enforced across the application')
    ->expect('App')
    ->toUseStrictTypes();

arch('controllers depend on actions and requests, not repositories directly')
    ->expect('App\Http\Controllers')
    ->toOnlyUse([
        'App\Actions',
        'App\Http\Requests',
        'Illuminate\Http\JsonResponse',
        'Illuminate\Routing\Controller',
        'Symfony\Component\HttpFoundation\Response',
    ]);

arch('repositories strictly implement interfaces')
    ->expect('App\Repositories')
    ->classes()
    ->toImplementAnything();
```

### Repository / Database Test (`tests/Feature/Spatial/PostGisLocationRepositoryTest.php`)

```php
<?php

declare(strict_types=1);

use App\Repositories\PostGisLocationRepository;
use App\Http\Requests\Spatial\NearbyLocationDto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;

uses(RefreshDatabase::class);

beforeEach(function () {
    // Ensure PostGIS is active for the test database
    DB::statement('CREATE EXTENSION IF NOT EXISTS postgis;');
    $this->repository = new PostGisLocationRepository();
});

it('can find locations accurately within a specified radius', function () {
    // Monas, Jakarta (Center)
    $monasLat = -6.175392;
    $monasLon = 106.827153;

    // Bundaran HI, Jakarta (Approx 2.5km away)
    $this->repository->createWithCoordinates('Bundaran HI', 'Landmark', 106.823055, -6.195048);

    // Bogor Botanical Gardens (Approx 45km away - should not be included)
    $this->repository->createWithCoordinates('Bogor Gardens', 'Park', 106.799516, -6.597623);

    // Search within 3km radius from Monas
    $dto = new NearbyLocationDto(latitude: $monasLat, longitude: $monasLon, radiusMeters: 3000);
    $results = $this->repository->findWithinRadius($dto);

    expect($results)
        ->toHaveCount(1)
        ->and($results->first()->name)->toBe('Bundaran HI')
        ->and($results->first()->distance_meters)->toBeLessThan(3000);

    // Search within 50km radius from Monas
    $largeDto = new NearbyLocationDto(latitude: $monasLat, longitude: $monasLon, radiusMeters: 50000);
    $largeResults = $this->repository->findWithinRadius($largeDto);

    expect($largeResults)->toHaveCount(2);
});

it('creates location with valid postgis geometry', function () {
    $location = $this->repository->createWithCoordinates('Test POI', 'POI', 100.0, 10.0);
    
    expect($location->id)->not->toBeNull();

    // Verify DB directly
    $dbRaw = DB::selectOne("SELECT ST_AsText(coordinates) as wkt FROM locations WHERE id = ?", [$location->id]);
    
    expect($dbRaw->wkt)->toBe('POINT(100 10)');
});
```

### Action Test (`tests/Unit/Actions/FindLocationsWithinRadiusActionTest.php`)

```php
<?php

declare(strict_types=1);

use App\Actions\Spatial\FindLocationsWithinRadiusAction;
use App\Http\Requests\Spatial\NearbyLocationDto;
use App\Repositories\Contracts\LocationRepositoryInterface;
use App\Models\Location;
use Illuminate\Support\Collection;

it('delegates to the repository and returns collection', function () {
    // Mock the repository
    $mockRepo = Mockery::mock(LocationRepositoryInterface::class);
    
    $dto = new NearbyLocationDto(latitude: -6.0, longitude: 106.0, radiusMeters: 1000);
    
    // Simulate repository returning an empty collection
    $mockRepo->shouldReceive('findWithinRadius')
        ->once()
        ->with($dto)
        ->andReturn(new Collection());

    $action = new FindLocationsWithinRadiusAction($mockRepo);
    
    $result = $action->execute($dto);
    
    expect($result)->toBeInstanceOf(Collection::class)
        ->and($result->isEmpty())->toBeTrue();
});
```

## 5. Performance Tuning & Scalability

1. **Clustering Indexes**: If spatial reads vastly outnumber writes, you can `CLUSTER` the table on the GiST index. This physically orders the table rows on disk based on geographic proximity, reducing disk I/O drastically for bounding-box/radius queries.
2. **Vacuum Analyze**: PostGIS query planner heavily relies on accurate statistics. Ensure you run `VACUUM ANALYZE locations;` after massive bulk inserts of geospatial data so the planner knows whether to use the GiST index or perform a sequential scan.
3. **Partitioning**: For billions of rows, combine PostGIS with table partitioning (e.g., partitioning by country code or geohash bounds) to keep index sizes manageable in RAM.
