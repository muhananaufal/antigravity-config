# Zero-Copy ICU Message Formatting: Performa Tinggi untuk Gramatika Kompleks

Dokumen referensi ini menguraikan metodologi pemrosesan pemformatan pesan berstandar ICU (International Components for Unicode) di dalam lingkungan NestJS dan Node.js, khususnya fokus pada operasi *zero-copy* atau alokasi buffer minimal untuk merender pluralisasi, jender, dan pemformatan tanggal/waktu/mata uang dengan kecepatan tinggi.

## 1. Arsitektur Memori Anti-Alokasi Berulang

Pemformatan pesan ICU sering memicu alokasi *garbage collection* (GC) yang tinggi akibat pembuatan string berulang pada siklus render besar. Solusinya adalah menggunakan caching abstrak dari mesin *Intl.MessageFormat* untuk mem-bypass parsing string berulang kali.

```ascii
+-------------------------------------------------------------------------------+
|                      ICU Message Formatting Pipeline                          |
+-------------------------------------------------------------------------------+
|                                                                               |
|  [ Raw String Pattern ] "You have {numPhotos, plural, ...} photos."           |
|            |                                                                  |
|            v                                                                  |
|  +--------------------+      +-------------------------------------------+    |
|  |   AST Parser       | ---> |   Zero-Copy LRU Cache (In-Memory)         |    |
|  +--------------------+      |   Map<Pattern, PrecompiledFormatter>      |    |
|                              +-------------------------------------------+    |
|                                         |                                     |
|  [ Context Variables ] { numPhotos: 5 } |                                     |
|            |                            v                                     |
|            +----------------> +--------------------+                          |
|                               | Runtime Evaluator  |                          |
|                               +--------------------+                          |
|                                         |                                     |
|                                         v                                     |
|  [ Output Buffer ] "You have 5 photos." (Direct writes, minimal allocation)   |
|                                                                               |
+-------------------------------------------------------------------------------+
```

## 2. Implementasi Zero-Copy Formatter Service

Layanan ini mengimplementasikan parser *IntlMessageFormat* dengan caching LRU bawaan berkinerja tinggi, mengeliminasi penguraian redundan (redundant AST parsing) untuk pola pesan yang sama. 

```typescript
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import IntlMessageFormat from 'intl-messageformat';
import { LRUCache } from 'lru-cache';

export interface FormatterOptions {
  locale: string;
  pattern: string;
  values: Record<string, string | number | boolean | Date>;
}

@Injectable()
export class IcuFormatterService implements OnModuleDestroy {
  private readonly logger = new Logger(IcuFormatterService.name);
  
  // LRU Cache for precompiled ICU formatters to prevent GC thrashing
  private readonly formatterCache: LRUCache<string, IntlMessageFormat>;

  constructor() {
    this.formatterCache = new LRUCache<string, IntlMessageFormat>({
      max: 5000, // Maximum cached compiled ASTs
      ttl: 1000 * 60 * 60 * 24, // 24 hours
      updateAgeOnGet: true,
      dispose: (value, key) => {
        this.logger.debug(`Evicted formatter from cache: ${key}`);
      },
    });
  }

  /**
   * Mengembalikan pesan berformat ICU menggunakan caching.
   * Sangat efisien, menghindari alokasi parser berulang.
   */
  public formatMessage({ locale, pattern, values }: FormatterOptions): string {
    const cacheKey = `${locale}:${pattern}`;
    
    let formatter = this.formatterCache.get(cacheKey);
    
    if (!formatter) {
      try {
        formatter = new IntlMessageFormat(pattern, locale);
        this.formatterCache.set(cacheKey, formatter);
      } catch (error: unknown) {
        this.logger.error(`Failed to parse ICU pattern: ${pattern}`, (error as Error).stack);
        // Fallback gracefully without throwing 500 to end users
        return pattern; 
      }
    }

    try {
      // Execute the formatting against the values
      return formatter.format(values) as string;
    } catch (error: unknown) {
      this.logger.error(`Formatting execution failed for pattern: ${pattern}`, (error as Error).stack);
      return pattern;
    }
  }

  public onModuleDestroy(): void {
    this.formatterCache.clear();
  }
}
```

## 3. Contoh Penggunaan: Controller dengan Pluralisasi & Format Waktu

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { IcuFormatterService } from './icu-formatter.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly formatter: IcuFormatterService) {}

  @Get('inbox')
  getInboxStats(
    @Query('messages') messagesStr: string,
    @Query('lang') lang: string = 'en-US'
  ): string {
    const messageCount = parseInt(messagesStr, 10) || 0;
    
    // Pola ICU dengan pluralisasi kompleks
    const pattern = `You have {messageCount, plural, 
      =0 {no new messages} 
      one {one new message} 
      other {# new messages}
    } as of {lastUpdated, time, short}.`;

    return this.formatter.formatMessage({
      locale: lang,
      pattern,
      values: {
        messageCount,
        lastUpdated: new Date(),
      },
    });
  }
}
```

## 4. Unit Test Suite: ICU Formatting Mock

Uji performa dan keandalan pemformat ICU, memvalidasi pluralisasi dan edge cases tipe data primitif.

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { IcuFormatterService } from './icu-formatter.service';

describe('IcuFormatterService Tests', () => {
  let service: IcuFormatterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IcuFormatterService],
    }).compile();

    service = module.get<IcuFormatterService>(IcuFormatterService);
  });

  it('harus merender pluralisasi dengan benar untuk jumlah 0 (zero)', () => {
    const pattern = 'Found {count, plural, =0 {zero items} one {one item} other {# items}}.';
    const result = service.formatMessage({
      locale: 'en',
      pattern,
      values: { count: 0 },
    });
    expect(result).toBe('Found zero items.');
  });

  it('harus merender pluralisasi dengan benar untuk jumlah banyak (other)', () => {
    const pattern = 'Found {count, plural, =0 {zero items} one {one item} other {# items}}.';
    const result = service.formatMessage({
      locale: 'en',
      pattern,
      values: { count: 42 },
    });
    expect(result).toBe('Found 42 items.');
  });

  it('harus memanfaatkan cache pada eksekusi kedua dengan performa tinggi', () => {
    const pattern = 'Hello {name}';
    
    // Pertama kali parse & compile
    service.formatMessage({ locale: 'en', pattern, values: { name: 'Alice' } });
    
    const start = performance.now();
    // Kedua kali ambil dari cache LRU
    const result = service.formatMessage({ locale: 'en', pattern, values: { name: 'Bob' } });
    const end = performance.now();
    
    expect(result).toBe('Hello Bob');
    expect(end - start).toBeLessThan(2); // Harus sub-millisecond execution
  });

  it('harus mengembalikan string mentah (fallback) jika pattern ICU rusak secara sintaksis', () => {
    const brokenPattern = 'Hello {name, plural, broken syntax...}';
    
    const result = service.formatMessage({
      locale: 'en',
      pattern: brokenPattern,
      values: { name: 'Test' },
    });
    
    expect(result).toBe(brokenPattern);
  });
});
```

## 5. Analisis Trade-Off

**Kelebihan:**
1. **Performa Luar Biasa (High Throughput):** Caching AST (Abstract Syntax Tree) secara drastis mengurangi siklus CPU Node.js yang memakan biaya besar selama penguraian regex/pola berulang.
2. **Kaya Fitur (Rich Semantics):** ICU standard mendukung kompleksitas global yang tidak tertandingi: multi-plural, format waktu/mata uang spesifik area, dan seleksi jender dalam satu string ringkas.
3. **Pengurangan Rekaman GC:** Re-use memori terkompilasi berarti heap Node.js tetap ramping tanpa gelombang garbage collection besar saat beban puncak.

**Kekurangan:**
1. **Ledakan Ukuran Bundle:** Pustaka parsial `intl-messageformat` bisa agak besar (terutama jika polyfill disertakan) dibandingkan interpolasi template literal sederhana.
2. **Kompleksitas Sintaks Khusus:** Kurva pembelajaran bagi penerjemah (translators) sering kali curam karena tanda kurung kurawal ganda ICU yang rentan kesalahan ketik.
3. **Cache Memory Overhead:** Semakin bervariasi locale dan pola, semakin banyak RAM yang dimonopoli oleh cache LRU. Perlu pemantauan metrik memori di K8s/Docker.

## 6. Anti-Patterns Kritis

### Anti-Pattern 1: Rekompilasi Pola Inline (Tanpa Cache)
**❌ Salah:** Menginisialisasi `new IntlMessageFormat` langsung di dalam loop atau request handler, membunuh kinerja karena parsing regex berulang untuk setiap request API.
```typescript
@Get()
getMessage(@Query('name') name: string) {
  // Parah: Instansiasi objek berat berulang kali setiap hit HTTP!
  const formatter = new IntlMessageFormat('Hi {name}', 'en');
  return formatter.format({ name });
}
```
**✅ Benar:** Membungkus instansiasi ke dalam instance Singleton atau layanan dengan abstraksi Cache LRU (seperti yang ditunjukkan di atas).

### Anti-Pattern 2: Interpolasi Terpisah dari Pluralisasi Logikal
**❌ Salah:** Menerapkan percabangan kode backend (`if/else`) untuk menentukan pluralisasi lalu meneruskan kunci sederhana ke modul I18n. Ini akan hancur untuk bahasa dengan aturan jamak yang tidak konvensional seperti Rusia atau Arab.
```typescript
// DILARANG KERAS merender plural manual!
const key = count === 1 ? 'item.singular' : 'item.plural'; 
return i18n.translate(key); 
```
**✅ Benar:** Kirim data numerik mentah ke string yang diformat oleh mesin ICU sehingga locale yang memutuskan tata bahasanya.

## 7. Production Edge Cases

1. **Cache Key Collision Attack / Lemahnya Kunci:** Jika cache key menggunakan input berbahaya (misal `locale` bukan dari enum valid tetapi payload 2MB), cache key hashing dapat memicu buffer overflow/OOM. *Solusi:* Validasi `locale` di level pipe secara ketat dan hashing string pola panjang (menggunakan XXHash atau SHA256) jika pola tidak statis.
2. **Missing Polyfills di Runtime Tua:** Berjalan pada platform V8/Node.js usang yang tidak sepenuhnya mendukung `Intl` locale-data. *Solusi:* Selalu injeksi `@formatjs/intl-pluralrules/polyfill` di root index file untuk menjamin konsistensi lintas-lingkungan Node.js.
3. **Circular Value Injection:** Mem-passing parameter objek yang memiliki iterasi rekursif dalam value formating, memicu kejatuhan call stack V8 engine. *Solusi:* Gunakan utilitas *flattener* objek statis (dengan `maxDepth=1`) atau *Object.freeze()* untuk sanitize nilai sebelum diumpan ke eksekusi `.format()`.
