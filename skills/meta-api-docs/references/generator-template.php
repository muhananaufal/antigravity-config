<?php
/*
 * TEMPLATE generator saved response Postman (skill meta-api-docs).
 * Salin ke tests/Postman/PostmanExamplesTest.php di proyek Laravel, lalu:
 *   - sesuaikan namespace model, username aktor, seeder, dan fake yang dibutuhkan;
 *   - ganti grup contoh `items()` dengan skenario setiap request di collection;
 *   - pastikan direktori tests/Postman TIDAK termasuk testsuite di phpunit.xml.
 * Jalankan: php artisan test tests/Postman/PostmanExamplesTest.php
 * Diturunkan dari generator altrms yang sudah teruji (bagian helper apa adanya).
 */

namespace Tests\Postman;

use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\Sanctum;
use Spatie\Permission\Models\Permission;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

/**
 * Pembuat saved response (example) dan deskripsi untuk collection Postman.
 * Setiap request dijalankan sungguhan (seeder, database test terisolasi,
 * waktu dibekukan); respons aslinya ditulis sebagai example.
 */
class PostmanExamplesTest extends TestCase
{
    use RefreshDatabase;

    private const COLLECTION = 'docs/postman/API.postman_collection.json';

    /** Satu berkas markdown per request, dinamai slug nama request-nya. */
    private const DESCRIPTIONS = 'docs/postman/descriptions';

    /** Hari kerja, sebelum aturan jam mana pun berlaku. */
    private const NOW = '2026-09-21 07:30:00';

    /** @var array<string, array<int, array<string, mixed>>> nama request => example */
    private array $examples = [];

    /** @var array<string, int|string> id hasil request sebelumnya */
    private array $ids = [];

    private User $employee;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        // HUKUM §0.6: seeder + RefreshDatabase mengosongkan database apa pun.
        if (config('database.default') !== 'sqlite' || config('database.connections.sqlite.database') !== ':memory:') {
            $this->markTestSkipped('Generator example Postman hanya jalan di SQLite :memory:.');
        }

        Carbon::setTestNow(Carbon::parse(self::NOW));
        Http::fake(['*' => Http::response(['ok' => true])]); // semua API eksternal
        Mail::fake();
        Storage::fake('public');

        $this->seed();

        // HUKUM §0.4: aktor = role nyata, bukan akun yang melewati policy.
        $this->employee = User::where('username', 'karyawan')->firstOrFail();
        $this->admin    = User::where('username', 'hrd')->firstOrFail();
        $this->admin->syncPermissions(Permission::all()); // bila role ini memang memegang semua izin
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();

        parent::tearDown();
    }

    public function test_generate_saved_responses()
    {
        $this->items();
        // $this->grupLain(); ...

        $this->write();
    }

    /* ====================================================== contoh grup */

    private function items(): void
    {
        $this->guest();
        $this->record('Items', '401 Unauthenticated (tanpa token)', 401, $this->getJson('/api/items'));

        $this->as($this->employee);
        $this->record('Items', '200 OK - Karyawan: hanya milik sendiri', 200, $this->getJson('/api/items'));

        $body = ['name' => 'Contoh'];
        $this->record('Create Item', '201 Created', 201, $created = $this->postJson('/api/items', $body), $body);
        $this->ids['item'] = $created->json('data.id');
        $this->record('Create Item', '422 Validasi gagal', 422, $this->postJson('/api/items', []), []);

        $this->as($this->admin);
        $this->record('Items', '200 OK - HRD / super admin: semua', 200, $this->getJson('/api/items'));
        $this->record('Item Detail', '404 Tidak ditemukan', 404, $this->getJson('/api/items/999999'), null, '/items/999999');
    }

    /* ============================================================= helpers */

    /**
     * multipart/form-data seperti aplikasi mobile (upload file, `_method=PUT`).
     *
     * @param  array<string, mixed>  $data
     */
    private function multipart(string $method, string $uri, array $data): TestResponse
    {
        return $this->withHeaders(['Accept' => 'application/json'])->call($method, $uri, array_filter($data, fn ($v) => !$v instanceof UploadedFile), [], array_filter($data, fn ($v) => $v instanceof UploadedFile), $this->transformHeadersToServerVars(['Accept' => 'application/json']));
    }

    private function as(User $user): void
    {
        $this->guest();
        Sanctum::actingAs($user->fresh());
    }

    /**
     * Tanpa user. Session ikut dikosongkan: Auth::attempt di login mengisi
     * guard web, dan di dalam satu proses test session itu terbawa ke request
     * berikutnya (di produksi request API tidak berbagi session).
     */
    private function guest(): void
    {
        $this->app['session.store']->flush();
        $this->app['auth']->forgetGuards();
    }

    /**
     * Mencatat satu example. Status yang meleset menggagalkan generator:
     * example yang salah lebih buruk daripada tidak ada.
     *
     * @param  array<string, mixed>|null  $body  body yang dikirim bila berbeda dari request di collection
     * @param  string|null  $uri  path + query (tanpa /api) bila berbeda dari URL request di collection
     */
    private function record(string $name, string $label, int $expected, TestResponse $response, ?array $body = null, ?string $uri = null): void
    {
        $status = $response->getStatusCode();
        $this->assertSame($expected, $status, "{$name} / {$label}: " . substr((string) $response->getContent(), 0, 1500));

        $type = (string) $response->headers->get('Content-Type');
        $json = str_contains($type, 'json');

        $this->examples[$name][] = [
            'label'   => $label,
            'code'    => $status,
            'type'    => $type,
            'body'    => $json ? $this->pretty($this->sanitize($response->json())) : '',
            'headers' => array_filter([
                'Content-Type'        => $type,
                'Content-Disposition' => $response->headers->get('Content-Disposition'),
            ]),
            'sent'    => $body,
            'uri'     => $uri,
        ];
    }

    /**
     * @param  mixed  $data
     * @return mixed
     */
    private function sanitize($data)
    {
        if (!is_array($data)) {
            return $data;
        }
        foreach ($data as $key => $value) {
            if (in_array($key, ['token', 'access_token', 'token_firebase'], true) && is_string($value)) {
                $data[$key] = $key === 'token_firebase' ? '<fcm-token>' : '<sanctum-token>';
            } else {
                $data[$key] = $this->sanitize($value);
            }
        }

        return $data;
    }

    /**
     * @param  mixed  $data
     */
    private function pretty($data): string
    {
        return json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * Deskripsi request dari docs/postman/descriptions/{grup}/{slug nama}.md,
     * atau null bila belum ditulis.
     */
    private function description(string $name): ?string
    {
        $slug  = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)), '-');
        $files = glob(base_path(self::DESCRIPTIONS) . '/*/' . $slug . '.md');

        return $files ? trim(str_replace("\r\n", "\n", file_get_contents($files[0]))) : null;
    }

    private function write(): void
    {
        $path = base_path(self::COLLECTION);
        $collection = json_decode(file_get_contents($path), true);
        $missing = [];
        $missingDocs = [];

        $walk = function (array &$items) use (&$walk, &$missing, &$missingDocs) {
            foreach ($items as &$item) {
                if (isset($item['item'])) {
                    $walk($item['item']);
                    continue;
                }
                $description = $this->description($item['name']);
                if ($description === null) {
                    $missingDocs[] = $item['name'];
                } else {
                    $item['request']['description'] = $description;
                }

                $examples = $this->examples[$item['name']] ?? [];
                if ($examples === []) {
                    $missing[] = $item['name'];
                }
                $item['response'] = array_map(fn (array $e) => $this->toPostman($item['request'], $e), $examples);
            }
        };
        $walk($collection['item']);

        $json = json_encode($collection, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        file_put_contents($path, str_replace("\n", "\r\n", $json) . "\r\n");

        $this->assertSame([], $missing, 'Request tanpa example: ' . implode(', ', $missing));
        $this->assertSame([], $missingDocs, 'Request tanpa deskripsi di ' . self::DESCRIPTIONS . ': ' . implode(', ', $missingDocs));
    }

    /**
     * @param  array<string, mixed>  $request
     * @param  array<string, mixed>  $example
     * @return array<string, mixed>
     */
    private function toPostman(array $request, array $example): array
    {
        $original = $request;
        unset($original['description']);
        if ($example['uri'] !== null) {
            [$path, $query] = array_pad(explode('?', $example['uri'], 2), 2, '');
            parse_str($query, $params);
            $original['url'] = [
                'raw'   => '{{base_url}}' . $example['uri'],
                'host'  => ['{{base_url}}'],
                'path'  => array_values(array_filter(explode('/', $path))),
                'query' => array_map(fn ($k, $v) => ['key' => $k, 'value' => (string) $v], array_keys($params), $params),
            ];
        }
        if ($example['sent'] !== null) {
            $original['body'] = [
                'mode'    => 'raw',
                'raw'     => $example['sent'] === [] ? '{}' : $this->pretty($example['sent']),
                'options' => ['raw' => ['language' => 'json']],
            ];
        }

        $reason = Response::$statusTexts[$example['code']] ?? '';

        return [
            'name'                    => $example['code'] . ' ' . preg_replace('/^\d{3}\s*/', '', $example['label']),
            'originalRequest'         => $original,
            'status'                  => $reason,
            'code'                    => $example['code'],
            '_postman_previewlanguage' => str_contains($example['type'], 'json') ? 'json' : 'text',
            'header'                  => array_map(fn ($k, $v) => ['key' => $k, 'value' => $v], array_keys($example['headers']), $example['headers']),
            'cookie'                  => [],
            'body'                    => $example['body'],
        ];
    }
}
