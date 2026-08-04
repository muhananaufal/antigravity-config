# Memantulkan Kecerdasan AI: Tool Calling Otomatis via Reflection Engine NestJS

## 1. Pendahuluan
LLM mutakhir tidak lagi sekadar entitas penghasil teks. Kemampuan *Function Calling / Tool Calling* mengubah LLM menjadi agen komputasional yang dapat secara reaktif memicu API, memanipulasi basis data, dan menjalankan perintah di mesin host. Pada arsitektur Monolit atau Microservices NestJS (TypeScript), membuat definisi *JSON Schema Tools* secara manual ke LangChain atau API OpenAI sangat melelahkan dan rentan *Out-of-Sync* bila rute fungsi berubah.

Solusi Engineering Top 1% adalah mengkombinasikan fungsionalitas Metaprogramming (Custom Decorator) dengan Reflection Engine (`@nestjs/core/DiscoveryService`). Dengan anotasi `@AiTool()`, NestJS secara otomatis men-scan, meregistrasi, dan memproyeksikan service internal manapun menjadi format `zod` Object atau skema fungsi yang langsung dikonsumsi, dikunci, dan dieksekusi asinkronus oleh AI.

## 2. Diagram Aliran Releksi (Reflection Flow Diagram)

```ascii
+-----------------------------------------------------------------------------------------+
| (1) Developer annotates NestJS Service methods with Custom Decorator                    |
|                                                                                         |
|      @AiTool({ description: 'Fetch weather data for city', schema: z.object(...) })     |
|      async getWeather(args: { city: string }) { ... }                                   |
+-----------------------------------------------------------------------------------------+
       |
       v (2) OnModuleInit (NestJS Bootstrapping)
+-----------------------------------------------------------------------------------------+
| NestJS DiscoveryService & Reflector                                                     |
| -> Scans All Providers & Controllers for @AiTool Metadata keys                          |
| -> Registers them into Central "AiToolRegistry" as LangChain DynamicStructuredTool      |
+-----------------------------------------------------------------------------------------+
       |
       v (3) Runtime Agent Execution
+-------------------------------------------------------+      +--------------------------+
| User Query: "What is the weather in Tokyo?"           | ---> | OpenAI/Anthropic Engine  |
+-------------------------------------------------------+      | (Decides to CALL tool)   |
                                                               +----+---------------------+
                                                                    | (4) Tool Call
+-------------------------------------------------------+           v
| LangChain Agent Executor                              | <--- [ Tool: 'getWeather'     ]
| -> Looks up 'getWeather' in Central AiToolRegistry    |      [ Args: { city:'Tokyo' } ]
| -> Dynamically invokes internal NestJS class method   |
+-------------------------------------------------------+
```

## 3. Implementasi Produksi Decorator & Reflection

### `ai-tool.decorator.ts`
Mendefinisikan metadata refleksi untuk mendandani metode (method) TypeScript apa pun.
```typescript
import { SetMetadata } from '@nestjs/common';
import { z } from 'zod';

export const AI_TOOL_METADATA_KEY = 'ai_tool_metadata_key';

export interface AiToolOptions {
  name: string;
  description: string;
  schema: z.ZodObject<any, any, any, any>;
}

// Decorator custom yang menempatkan data AiToolOptions ke dalam reflection target method
export const AiTool = (options: AiToolOptions) => SetMetadata(AI_TOOL_METADATA_KEY, options);
```

### `weather-api.service.ts` (Contoh Servis Target)
Servis standar NestJS yang kini menjadi reaktif-LLM karena dibubuhi anontasi metadata tool.
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AiTool } from './ai-tool.decorator';
import { z } from 'zod';

@Injectable()
export class WeatherApiService {
  private readonly logger = new Logger(WeatherApiService.name);

  // Menandai method ini agar diserap otomatis oleh LLM Agent
  @AiTool({
    name: 'get_current_weather',
    description: 'Use this tool to find out the current weather in a specific city/location.',
    schema: z.object({
      city: z.string().describe('The name of the city, e.g. Jakarta, Tokyo'),
      unit: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Temperature unit'),
    }),
  })
  public async getCurrentWeather(args: { city: string; unit: 'celsius' | 'fahrenheit' }): Promise<string> {
    this.logger.log(`LLM Agent invoking weather for: ${args.city} in ${args.unit}`);
    
    // Logika simulasi API eksternal riil
    const mockTemp = args.unit === 'celsius' ? 32 : 90;
    return `The current weather in ${args.city} is ${mockTemp} degrees ${args.unit}, mostly sunny.`;
  }
}
```

### `ai-tool-explorer.service.ts`
Mesin inti Reflection yang merangkum (harvest) seluruh Decorator ke dalam alat agen (tools agent).
```typescript
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { AI_TOOL_METADATA_KEY, AiToolOptions } from './ai-tool.decorator';
import { DynamicStructuredTool } from '@langchain/core/tools';

@Injectable()
export class AiToolExplorerService implements OnModuleInit {
  private readonly logger = new Logger(AiToolExplorerService.name);
  
  // Penyimpanan terpusat seluruh tool LangChain yang ter-mapping ke method NestJS
  public readonly registeredTools: DynamicStructuredTool[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit() {
    this.exploreAndRegisterTools();
  }

  private exploreAndRegisterTools() {
    // Ambil SEMUA provider NestJS yang diregistrasi di seluruh kontainer Dependency Injection
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;

      const prototype = Object.getPrototypeOf(instance);
      const methodNames = Object.getOwnPropertyNames(prototype);

      for (const methodName of methodNames) {
        const method = instance[methodName as keyof typeof instance];
        if (typeof method !== 'function') continue;

        // Inspeksi metadata menggunakan Reflector
        const toolMeta: AiToolOptions | undefined = this.reflector.get(
          AI_TOOL_METADATA_KEY,
          method,
        );

        if (toolMeta) {
          // Bungkus menjadi LangChain DynamicStructuredTool agar bisa diakses Engine AI
          const lcTool = new DynamicStructuredTool({
            name: toolMeta.name,
            description: toolMeta.description,
            schema: toolMeta.schema,
            // Menautkan pointer fungsi back ke instans aslinya (This binding dipertahankan)
            func: async (args) => {
              this.logger.debug(`[AI Execution] Tool '${toolMeta.name}' triggered.`);
              try {
                // Call method with original class context binding
                const result = await method.apply(instance, [args]);
                return typeof result === 'string' ? result : JSON.stringify(result);
              } catch (err) {
                this.logger.error(`Error in AI Tool ${toolMeta.name}: ${(err as Error).message}`);
                return `Action Failed: ${(err as Error).message}`; // AI Prompt toleransi kegagalan
              }
            },
          });

          this.registeredTools.push(lcTool);
          this.logger.log(`[Registered] AI Tool Extracted: ${toolMeta.name} from ${instance.constructor.name}.${methodName}`);
        }
      }
    }
  }

  // Helper untuk menyerahkan alat ke LLM Agent (LangChain)
  public getToolsArray(): DynamicStructuredTool[] {
    return this.registeredTools;
  }
}
```

## 4. Analisis Trade-off

**Kelebihan:**
1. **Pemisahan Kekhawatiran Murni (Separation of Concerns):** Logika AI (LLM Executor) terpisah 100% dari domain logik (*WeatherService*). Tidak ada saling mengimport library antar domain. NestJS services tetap suci dan dapat diuji-unit secara independen sebagai service standar.
2. **Auto-Synchronization Tool Schema:** Sering kali pengembang mengubah argumen di service tetapi lupa memperbarui JSON parameter di OpenAI portal/Langchain config. Dengan `zod` di dekorator reflektif, definisi skema LLM dan implementasi runtime NestJS diikat menjadi satu (Single Source of Truth), mencegah *schema drift mismatch*.
3. **Membuka "Plug-and-Play" Modul Agentic:** Siapapun anggota tim Backend yang ingin mendelegasikan fungsionalitas aplikasinya untuk dikendalikan Chatbot, hanya perlu membubuhi 1 baris `@AiTool()` pada methd service-nya tanpa menyentuh modul NLP Langchain milik tim AI.

**Kekurangan:**
1. **Bootstrapping Overhead:** Metodologi ini memperlambat proses *start-up time* aplikasi NestJS. `DiscoveryService` harus memindai seluruh *dependency tree* provider (ratusan kelas instans) saat inisiasi secara massal, berdampak minor (tapi terasa) di environment serverless lambdas.
2. **Keterbatasan Bind "this" Context:** Kesalahan merefleksikan dan me-routing `func` method ke instance NestJS tanpa fungsi `method.apply(instance, [args])` yang solid dapat membuang/merusak variabel `this`, memutus akses injeksi lokal semisal database/cache di kelas asal fungsi.
3. **Risiko Otorisasi Keamanan Agen (LLM Bypass):** Mengekspos fungsi krusial (seperti fungsi DML update data nasabah: `@AiTool() updateBalance()`) murni ke kendali LLM tanpa adanya validasi Guard otorisasi internal sangat berbahaya. Konteks user (JWT user ID pengguna pemicu chat) menjadi sulit diteruskan (propagated) ke dalam parameter method yang di-generate argumennya murni dari JSON balasan LLM.

## 5. Anti-Patterns Kritis

### ❌ Anti-Pattern 1: Meregistrasi Tool secara Hardcoded-Manual
Membangun tool array raksasa yang statis di dalam modul AI agent tunggal. Ini memaksa modul AI mengimport *SEMUA* service eksternal yang di-hosting aplikasi, menghancurkan batas Dependency Injection (DI) yang modular.

```typescript
// ❌ CONTOH SALAH: Hardcoding spaghetti imports, merusak kohesi dan kopling DI NestJS
import { WeatherService, BillingService, HRService } from '../all-modules';

const tools = [
  new DynamicStructuredTool({
    name: 'weather',
    func: async (arg) => new WeatherService().get(arg), // Instansiasi fatal, mengabaikan DI Container!
  }),
  // ... 50 tools lainnya berkumpul menjadi monster array
];
```

**Solusi ✅:** Memakai `DiscoveryService` Inversion of Control. Modul AI tidak tau siapa yang dia panggil; servis target yang secara deklaratif mengiklankan dirinya via Decorator Refleksi (`@AiTool`).

### ❌ Anti-Pattern 2: Tool Tanpa Zod / Skema Lemah
Tidak memakai alat validasi skema bertipe-ketat (seperti Zod/Joi) untuk anotasi *Function Parameters*. Memaksa model LLM menebak properti apa yang diterima fungsi (hanya lewat JSON primitive Type), mengundang potensi keracunan parameter palsu saat argumen di-_parse_.

```typescript
// ❌ CONTOH SALAH: Skema tool polos (Type any/Record), LLM bingung
@AiTool({
  name: 'buy_stock', 
  schema: z.any() // FATAL: AI bebas menyuntik { stock: "AAPL", qty: "seribu" } bukan integer
})
async buy(args: any) { ... }
```

**Solusi ✅:** Terapkan Zod validation Schema yang tegas dengan `.describe()` penuh untuk memberikan prompt instruksi terselubung ke model AI apa guna parameter spesifik. (e.g. `z.number().int().describe('Must be integer quantity')`).

## 6. Kasus Uji Unit & Mock AI Tool Reflection

### `ai-tool-explorer.service.spec.ts`
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { AiToolExplorerService } from './ai-tool-explorer.service';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { AiTool, AI_TOOL_METADATA_KEY } from './ai-tool.decorator';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';

class MockTestService {
  @AiTool({
    name: 'mock_ping',
    description: 'Pings the mock system',
    schema: z.object({ value: z.string() })
  })
  async ping(args: { value: string }) {
    return `pong-${args.value}`;
  }
}

describe('AiToolExplorerService', () => {
  let explorerService: AiToolExplorerService;
  let mockServiceInstance: MockTestService;

  beforeEach(async () => {
    mockServiceInstance = new MockTestService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiToolExplorerService,
        Reflector,
        {
          provide: DiscoveryService,
          useValue: {
            getProviders: jest.fn().mockReturnValue([
              { instance: mockServiceInstance, isDependencyTreeStatic: () => true },
              { instance: {}, isDependencyTreeStatic: () => true } // Mock provider kosongan anonim
            ]),
          },
        },
      ],
    }).compile();

    explorerService = module.get<AiToolExplorerService>(AiToolExplorerService);
  });

  describe('exploreAndRegisterTools()', () => {
    it('should successfully discover methods tagged with @AiTool and map to Langchain StructuredTool', async () => {
      // Panggil lifecycle secara eksplisit (otomatis memicu method exploreAndRegisterTools internal)
      explorerService.onModuleInit();

      const tools: DynamicStructuredTool[] = explorerService.getToolsArray();
      
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('mock_ping');
      expect(tools[0].description).toBe('Pings the mock system');
      
      // Test the wrapped internal function binding pointer
      const result = await tools[0].func({ value: 'test1234' });
      expect(result).toBe('pong-test1234');
    });

    it('should handle tool execution failures gracefully without crashing agent runtime', async () => {
      // Ubah fungsionalitas mock instans secara dinamis untuk test error case
      jest.spyOn(mockServiceInstance, 'ping').mockRejectedValue(new Error('Internal ping DB crash'));
      
      explorerService.onModuleInit();
      const tools = explorerService.getToolsArray();
      
      const result = await tools[0].func({ value: 'breakit' });
      
      // Memastikan error dirubah menjadi format string aman untuk diserap LLM prompt, 
      // tidak di throw mentah yang akan membunuh event-loop/agent!
      expect(result).toContain('Action Failed: Internal ping DB crash');
    });
  });
});
```

## 7. Production Edge Cases

1. **Kehilangan Injectable User Context (Request Scoped Loss):** Di NestJS standar, kita mem-passing `req.user` JWT melalui interseptor untuk authorization di fungsi Controller. Namun, AI *Function Calling* memotong (bypasses) Controller Guard dan langsung memanggil method `Service.foo()`. Metode service tidak memiliki akses ke "Siapa pengguna ini?". Pendekatan mitigasi: Tambahkan parameter paksa `context: { userId: string }` ke setiap AiTool handler yang bukan diregistrasikan dari prompt agen, melainkan dikontekstualisasikan dari backend Engine Pembungkus (wrapper) AI saat menyambungkan tool.
2. **Keterbatasan Payload Nested Zod yang Terlalu Dalam (Deeply Nested Tools):** Walau `zod` dapat direpresentasikan secara reflektif, beberapa LLM provider (misal Open-Source Ollama model kecil seperti Llama-3 8B) gagal mem-parsing JSON Schema argumen yang memiliki nestingan array-object di atas 2 tingkat. Edge case mitigasi: Seluruh parameter `@AiTool` schema **wajib** dirancang sangat dangkal dan pipih (Flat DTO), tidak berjenjang.
3. **Deadlock Recursion AI Agent:** Jika alat refleksi yang teregistrasi menghasilkan string *error string error log trace*, agen AI mungkin terjebak di loop retrying tak terbatas karena AI berkeras mengoreksi dan memanggil fungsi yang sama selama ribuan kali secara sekejap, membebani CPU. Wajib melengkapi Executor LangChain (yang memakai set reflection tools ini) dengan pembatasan sirkuit pemutus manual: `maxIterations: 5` di level agen.
