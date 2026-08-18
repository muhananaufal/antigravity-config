---
title: "Synonyms Relevance & Prominence Scoring"
description: "Optimasi relevansi hasil pencarian toko online: pemetaan kamus sinonim (Synonym Dictionaries), pembobotan bobot judul vs deskripsi (Field Boosting), dan penggabungan parameter popularitas."
tags: [nestjs, relevance, synonyms, search-engine, ranking, e-commerce]
---

# Synonyms Relevance & Prominence Scoring: Seni Optimasi Hasil Pencarian

Mesin pencari e-commerce gagal jika tidak bisa memahami niat berbelanja manusia. Kueri "sepatu lari" harus memunculkan produk "running shoes", dan produk yang sedang tren (banyak ulasan, laris) harus ditempatkan di posisi atas walau kesamaan teksnya sedikit lebih rendah dibanding produk baru. Hal ini diselesaikan melalui **Synonyms Dictionary**, **Field Boosting**, dan **Custom Ranking Rules**.

## 1. Arsitektur Relevansi Pencarian

```ascii
+----------------+      [Synonym Filter Layer]     [Field Boosting Layer]    [Prominence Scoring Layer]
| User Query:    |       (laptop == notebook)       (Title > Description)       (Sales * 0.4 + Text * 0.6)
| "laptop asus"  | ------------------------------> ------------------------> -----------------------------> +-----------------+
+----------------+      Match: 'notebook asus'      Title Match: +50 Pts        Base Score: 50              | Ranked Results  |
                        Match: 'laptop asus'        Desc Match:  +10 Pts        Sales boost: +15            | 1. Asus ROG ... |
                                                                                Final Score: 65             | 2. Asus Vivo... |
                                                                                                            +-----------------+
```

## 2. Implementasi NestJS (TypeScript 5+ & NestJS 10+)

### Konfigurasi MeiliSearch (Relevance Tuning Service)

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeiliSearch, Index } from 'meilisearch';

export interface SynonymDictionary {
  [word: string]: string[];
}

@Injectable()
export class SearchRelevanceTuningService implements OnModuleInit {
  private readonly logger = new Logger(SearchRelevanceTuningService.name);
  private client: MeiliSearch;
  private readonly indexName = 'products';

  constructor(private readonly configService: ConfigService) {
    this.client = new MeiliSearch({
      host: this.configService.getOrThrow<string>('MEILISEARCH_HOST'),
      apiKey: this.configService.getOrThrow<string>('MEILISEARCH_API_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.applyRelevanceSettings();
  }

  /**
   * Mengatur seluruh algoritma relevansi pencarian saat bootstrap
   */
  public async applyRelevanceSettings(): Promise<void> {
    const index: Index = this.client.index(this.indexName);

    try {
      // 1. Synonyms Dictionary
      // "hp" -> juga dicari sebagai "handphone", "smartphone"
      const synonyms: SynonymDictionary = {
        'hp': ['handphone', 'smartphone', 'ponsel'],
        'handphone': ['hp', 'smartphone', 'ponsel'],
        'sepatu olahraga': ['sepatu lari', 'running shoes', 'sneakers'],
        'baju': ['kaos', 'kemeja', 'pakaian'],
        'flashdisk': ['flash drive', 'usb', 'thumb drive']
      };

      await index.updateSynonyms(synonyms);
      this.logger.log('Synonyms dictionary updated.');

      // 2. Field Boosting (Urutan atribut menentukan bobot - Index Kiri = Paling Penting)
      await index.updateSearchableAttributes([
        'name',           // Prioritas 1 (Title)
        'brand',          // Prioritas 2 (Brand)
        'category_name',  // Prioritas 3 (Category)
        'description',    // Prioritas Terakhir (Desc)
      ]);
      this.logger.log('Field boosting priorities updated.');

      // 3. Prominence Scoring (Custom Ranking Rules)
      // Menyuntikkan aturan kustom setelah exact match text dan typo rules bawaan
      // Urutan sangat penting dalam MeiliSearch! Aturan atas mengalahkan bawah.
      await index.updateRankingRules([
        'words',       // Semakin banyak kata pencarian yang cocok, semakin relevan
        'typo',        // Kata dengan typo minimal diurutkan duluan
        'proximity',   // Jarak kata dalam pencarian (cth: "sepatu asus" -> "sepatu merk asus" > "sepatu baru dari pt asus")
        'attribute',   // Mengandalkan urutan `searchableAttributes` di atas
        'sort',        // Memungkinkan kustomisasi sorting oleh user jika diberikan
        'exactness',   // Exact string match (terhindar dari partial matches)
        // CUSTOM PROMINENCE SCORING KITA:
        'rating:desc', // Jika teks sama kuat, menangkan yang ratingnya tertinggi
        'soldCount:desc' // Jika rating sama, menangkan produk yang paling laris
      ]);
      this.logger.log('Prominence scoring / Custom ranking rules updated.');
      
    } catch (error: unknown) {
      this.logger.error('Failed to update relevance tuning settings', error);
      throw error;
    }
  }

  // Fungsi utilitas untuk mengupdate kamus dari Admin Panel (CMS)
  public async addDynamicSynonyms(newSynonyms: SynonymDictionary): Promise<void> {
    const index = this.client.index(this.indexName);
    const existing = await index.getSynonyms();
    const merged = { ...existing, ...newSynonyms };
    await index.updateSynonyms(merged);
  }
}
```

## 3. Unit / Mock Test Suite

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SearchRelevanceTuningService, SynonymDictionary } from './search-relevance-tuning.service';

const mockUpdateSynonyms = jest.fn().mockResolvedValue({ taskUid: 1 });
const mockUpdateSearchableAttrs = jest.fn().mockResolvedValue({ taskUid: 2 });
const mockUpdateRankingRules = jest.fn().mockResolvedValue({ taskUid: 3 });
const mockGetSynonyms = jest.fn().mockResolvedValue({ 'tas': ['bag'] });

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({
    index: jest.fn().mockReturnValue({
      updateSynonyms: mockUpdateSynonyms,
      updateSearchableAttributes: mockUpdateSearchableAttrs,
      updateRankingRules: mockUpdateRankingRules,
      getSynonyms: mockGetSynonyms,
    }),
  })),
}));

describe('SearchRelevanceTuningService', () => {
  let service: SearchRelevanceTuningService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchRelevanceTuningService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('mock-val'),
          },
        },
      ],
    }).compile();

    service = module.get<SearchRelevanceTuningService>(SearchRelevanceTuningService);
    jest.clearAllMocks();
  });

  it('should apply all relevance settings on initialization', async () => {
    await service.applyRelevanceSettings();
    
    expect(mockUpdateSynonyms).toHaveBeenCalled();
    expect(mockUpdateSearchableAttrs).toHaveBeenCalledWith([
      'name', 'brand', 'category_name', 'description'
    ]);
    expect(mockUpdateRankingRules).toHaveBeenCalledWith(
      expect.arrayContaining(['words', 'typo', 'rating:desc', 'soldCount:desc'])
    );
  });

  it('should merge and update dynamic synonyms', async () => {
    const newSyn: SynonymDictionary = { 'kacamata': ['sunglasses'] };
    await service.addDynamicSynonyms(newSyn);

    expect(mockGetSynonyms).toHaveBeenCalled();
    expect(mockUpdateSynonyms).toHaveBeenCalledWith({
      'tas': ['bag'],
      'kacamata': ['sunglasses'],
    });
  });
});
```

## 4. Analisis Trade-Off

### Kelebihan
1. **Peningkatan Konversi (CVR):** Menyelesaikan keluhan "produk tidak ketemu padahal nama beda tipis". Fitur sinonim sangat kuat untuk konversi e-commerce.
2. **Otomatisasi Pemenang:** `soldCount` dan `rating` dalam rule ranking memastikan traffic masuk ke produk unggulan tanpa moderasi manusia (Prominence based scoring).
3. **Fleksibilitas Operasional:** Kamus sinonim dapat di-update secara asinkron lewat Admin Panel saat musim tertentu (misal: "hampers" = "parsel" saat lebaran).

### Kekurangan
1. **Synonym Overlap Conflict:** Kamus sinonim yang terlalu gemuk bisa menimbulkan efek samping. Contoh: 'apel' bersinonim dengan 'buah' tapi user mencari 'laptop apel' memicu hasil keranjang buah.
2. **Kekakuan Algoritma:** Kombinasi ranking rule Meilisearch berbasis urutan (Tie-breaking tie). Berbeda dengan Elasticsearch *Function Score* yang bisa menggunakan formula matematika eksak (misal: Score = Text * 0.7 + Sold * 0.3).
3. **Maintenance Data Kamus:** Harus dirawat berkala oleh tim data analyst dengan membaca metrik *Zero-Result Searches* log.

## 5. Anti-Patterns Kritis

### Anti-Pattern 1: Mengubah Keyword Asli Secara Naif (Frontend Side) ❌
Melakukan manipulasi dan penukaran (replace) string sinonim secara manual di frontend atau middleware Node.js menggunakan Regex, alih-alih melempar fungsionalitas ini ke Search Engine.
```typescript
// ❌ SALAH: Regex manual membebankan CPU NestJS dan rentan bug batas kata
const query = rawQuery.replace(/hp/g, "handphone");
```
**✅ Solusi Benar:** Manfaatkan native `Synonyms Dictionary` pada engine (MeiliSearch / Elastic) yang telah teroptimasi menggunakan tokenizer tingkat rendah (C/Rust/Java).

### Anti-Pattern 2: Menaruh Field Deskripsi Sama Tinggi Dengan Judul ❌
Tidak menset `searchableAttributes` priority / tidak menggunakan `fields` boosting di Elastic, menyebabkan pencarian "Iphone 13" memunculkan casing murahan di urutan 1 hanya karena deskripsinya dipenuhi kata "Iphone 13".
**✅ Solusi Benar:** Judul (Title) harus memiliki bobot (Weight/Priority) ekstrem dibandingkan deskripsi atau meta tag.

## 6. Production Edge Cases

1. **One-way vs Two-way Synonyms:** "Iphone" harus mengembalikan "Smartphone" (One-way), tapi pencarian "Smartphone" tidak boleh HANYA memunculkan "Iphone". Pastikan menggunakan One-way synonym jika klasifikasi hirarkis!
2. **Stop Words Conflict:** Kata sinonim bertabrakan dengan stop words (seperti "dan", "atau", "yang"). Saat diurai tokenizer, ini dapat menyebabkan mesin pecari menghasilkan *false-positive* yang tidak terprediksi. Selalu filter daftar sinonim terhadap Stop Words.
3. **Prominence Bias Pada Produk Lama:** Aturan `soldCount:desc` selalu memenangkan produk tua yang dijual 3 tahun lalu (terjual 10,000) vs produk canggih baru dirilis minggu lalu (terjual 100). Terapkan algoritma *Time Decay* atau normalisasi `sold_velocity_last_30_days` sebagai metrik prominensi alih-alih `lifetime_sold_count`.
