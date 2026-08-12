# Sistem WhatsApp & SMS OTP Fallback (Twilio/Meta API) di NestJS

Dokumen ini mendeskripsikan integrasi komunikasi pesan berbayar tinggi yang vital untuk onboarding pengguna: pengiriman OTP (One Time Password) via WhatsApp dengan SMS sebagai mekanisme fallback otomatis apabila pengiriman utama gagal.

## Arsitektur Sistem Fallback

```ascii
[Client Request OTP] -> [AuthController] -> [OtpService]
                                                 |
                                     (1) Try WhatsApp (Meta API)
                                                 |
                   +-----------------------------+-----------------------------+
                   | (Success)                                                 | (Failed/Timeout)
             [Delivery OK]                                              [Fallback Engine]
                   |                                                           |
           (Log success metrics)                                    (2) Try SMS (Twilio API)
                                                                               |
                                                                         [Delivery OK]
```

## Implementasi Kode Produksi (TypeScript 5+ & NestJS 10+)

```typescript
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';
import axios, { AxiosInstance } from 'axios';

export interface OtpSendResult {
  provider: 'whatsapp' | 'sms';
  messageId: string;
  status: 'sent' | 'failed';
  errorDetail?: string;
}

@Injectable()
export class OtpCommunicationService {
  private readonly logger = new Logger(OtpCommunicationService.name);
  private twilioClient: Twilio;
  private metaApiClient: AxiosInstance;

  constructor(private configService: ConfigService) {
    const twilioAccountSid = this.configService.getOrThrow<string>('TWILIO_ACCOUNT_SID');
    const twilioAuthToken = this.configService.getOrThrow<string>('TWILIO_AUTH_TOKEN');
    this.twilioClient = new Twilio(twilioAccountSid, twilioAuthToken);

    const metaAccessToken = this.configService.getOrThrow<string>('META_ACCESS_TOKEN');
    this.metaApiClient = axios.create({
      baseURL: 'https://graph.facebook.com/v19.0',
      headers: {
        Authorization: `Bearer ${metaAccessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000, // Timeout ketat 5 detik untuk trigger fallback
    });
  }

  async sendOtpWithFallback(phoneNumber: string, otpCode: string): Promise<OtpSendResult> {
    const formattedPhone = this.formatPhoneNumber(phoneNumber);
    
    // 1. Coba WhatsApp Business API (Lebih murah di banyak region dan lebih terpercaya)
    try {
      this.logger.log(`Attempting to send WhatsApp OTP to ${formattedPhone}`);
      const waResult = await this.sendWhatsAppOtp(formattedPhone, otpCode);
      return { provider: 'whatsapp', messageId: waResult.messages[0].id, status: 'sent' };
    } catch (waError) {
      this.logger.warn(`WhatsApp sending failed for ${formattedPhone}. Initiating SMS Fallback. Error: ${(waError as Error).message}`);
      
      // 2. Fallback ke SMS Twilio
      try {
        const smsResult = await this.sendSmsOtp(formattedPhone, otpCode);
        return { provider: 'sms', messageId: smsResult.sid, status: 'sent' };
      } catch (smsError) {
        this.logger.error(`SMS Fallback also failed for ${formattedPhone}.`, (smsError as Error).stack);
        throw new InternalServerErrorException('Failed to send OTP via all available channels');
      }
    }
  }

  private async sendWhatsAppOtp(phone: string, code: string): Promise<any> {
    const phoneNumberId = this.configService.getOrThrow<string>('META_PHONE_NUMBER_ID');
    // Menggunakan Template Message yang wajib di-approve oleh Meta
    const payload = {
      messaging_product: 'whatsapp',
      to: phone.replace('+', ''), // Meta Graph API biasanya menerima format tanpa '+'
      type: 'template',
      template: {
        name: 'otp_verification',
        language: { code: 'id' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: code }
            ]
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              { type: 'text', text: code }
            ]
          }
        ]
      }
    };

    const response = await this.metaApiClient.post(`/${phoneNumberId}/messages`, payload);
    return response.data;
  }

  private async sendSmsOtp(phone: string, code: string): Promise<any> {
    const twilioPhone = this.configService.getOrThrow<string>('TWILIO_PHONE_NUMBER');
    return this.twilioClient.messages.create({
      body: `Kode Verifikasi Anda adalah: ${code}. JANGAN BAGIKAN KODE INI KEPADA SIAPAPUN.`,
      from: twilioPhone,
      to: phone,
    });
  }

  private formatPhoneNumber(phone: string): string {
    // Basic E.164 normalization, ensure + prefix. In prod use 'google-libphonenumber'
    if (phone.startsWith('0')) return `+62${phone.substring(1)}`;
    if (!phone.startsWith('+')) return `+${phone}`;
    return phone;
  }
}
```

## Unit / Mock Test Suite (Jest)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OtpCommunicationService } from './otp-communication.service';
import { Twilio } from 'twilio';

// Mock Modules
jest.mock('twilio', () => {
  return {
    Twilio: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn(),
      },
    })),
  };
});
jest.mock('axios');
import axios from 'axios';

describe('OtpCommunicationService', () => {
  let service: OtpCommunicationService;
  let configService: ConfigService;

  beforeEach(async () => {
    const mockConfigService = {
      getOrThrow: jest.fn().mockImplementation((key) => `mock-${key}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpCommunicationService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<OtpCommunicationService>(OtpCommunicationService);
    configService = module.get<ConfigService>(ConfigService);
    
    // Reset mocks inside axios instance
    (service as any).metaApiClient = { post: jest.fn() };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should send via WhatsApp if successful', async () => {
    ((service as any).metaApiClient.post as jest.Mock).mockResolvedValue({
      data: { messages: [{ id: 'wa-id-123' }] }
    });

    const result = await service.sendOtpWithFallback('+6281234567890', '123456');
    
    expect(result.provider).toBe('whatsapp');
    expect(result.messageId).toBe('wa-id-123');
    expect((service as any).metaApiClient.post).toHaveBeenCalled();
  });

  it('should fallback to SMS if WhatsApp fails', async () => {
    ((service as any).metaApiClient.post as jest.Mock).mockRejectedValue(new Error('Timeout'));
    
    const twilioMessagesMock = (service as any).twilioClient.messages.create as jest.Mock;
    twilioMessagesMock.mockResolvedValue({ sid: 'sms-sid-456' });

    const result = await service.sendOtpWithFallback('+6281234567890', '123456');
    
    expect(result.provider).toBe('sms');
    expect(result.messageId).toBe('sms-sid-456');
    expect((service as any).metaApiClient.post).toHaveBeenCalled();
    expect(twilioMessagesMock).toHaveBeenCalled();
  });
});
```

## Analisis Trade-Off

### Kelebihan
1. **Tingkat Konversi (Delivery Rate) Mendekati 100%:** Menggunakan 2 channel mitigasi resiko jika satu channel sedang terganggu (down) di regional tertentu.
2. **Efisiensi Biaya:** WhatsApp transaksional (Utility/Authentication template) umumnya lebih murah per pesan dibanding SMS Internasional di banyak negara Asia/Eropa.
3. **UX yang Modern:** Pengguna mendapatkan OTP langsung di WhatsApp yang sudah sangat familiar (dan fitur copy-code button).

### Kekurangan
1. **Regulasi Ketat Meta:** Template WhatsApp harus didaftarkan dan di-approve manual oleh Meta sebelum bisa dipanggil lewat API.
2. **Format Nomor Sensitif:** SMS Twilio butuh strict E.164 format dengan simbol '+', sedangkan WhatsApp Business API sering membutuhkan nomor tanpa tanda '+'. Validasi ketat dibutuhkan.
3. **Biaya Development Ekstra:** Mengatur Webhook Delivery Receipts (DLR) dari dua provider berbeda (Twilio & Meta) menguras waktu setup.

## Anti-Patterns & Best Practices

### Anti-Pattern 1: Tidak Membatasi Retry OTP
❌ **Salah:** Membiarkan user mengklik "Kirim Ulang OTP" tanpa batasan waktu (Rate Limiting). Ini bisa digunakan untuk SMS Bombing / Toll Fraud, menyebabkan tagihan membengkak.
✅ **Benar:** Wajib gunakan implementasi Redis Rate Limiter (misal 3 OTP maksimal per nomor per 30 menit).

### Anti-Pattern 2: Free-form WhatsApp Message
❌ **Salah:** Mencoba mengirim OTP via WhatsApp dengan text bebas tanpa pre-approved template di jam ke-25+ (di luar customer service window). Pesan pasti di-reject Meta.
✅ **Benar:** Selalu panggil endpoint template API `/messages` dengan tipe `template` dan kirim variabel komponennya saja.

## Production Edge Cases
1. **Toll Fraud Routing (SMS Pumping):** Operator nakal memompa SMS ke nomor-nomor aneh berbiaya premium. Pastikan Anda mengaktifkan pengaturan "Geo-Permissions" di Twilio Console untuk memblokir negara yang tidak Anda layani.
2. **Timeout Provider Tersembunyi:** API WhatsApp Meta mungkin merespons 200 OK tetapi pengiriman ke device delay parah (status "sent" tapi bukan "delivered"). Fallback instan SMS harus ditunda jika kita mau menunggu webhook DLR.
3. **Karakter Spesial di SMS:** Jika interpolasi text OTP Anda menggunakan karakter non-GSM-7 (seperti Unicode/Emoji), Twilio akan memotong SMS menjadi UCS-2 (maks 70 karakter), merubah tarif pengiriman menjadi 2-3x lipat (multipart SMS).
