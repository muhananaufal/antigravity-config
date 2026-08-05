# ISO 20022 & SWIFT Messaging

> **Berlaku:** Go 1.21+ · ISO 20022 · **Lihat juga:** `fintech_reliability/idempotency_payment_engine.md` · `fintech_reliability/reconciliation_engine.md` · `security_owasp/audit_logging_scrubbing.md` · `microservices_grpc/api_versioning_strategy.md`

## 1. Konsep dan Internals
ISO 20022 adalah standar internasional pertukaran data elektronik antara institusi keuangan. Menggunakan format XML dengan skema XSD yang ketat, pesan ISO 20022 membawa informasi finansial yang kaya dan terstruktur. Standar ini membagi pesan ke dalam beberapa domain bisnis, seperti Payments Initiation (PAIN), Cash Management (CAMT), dan Payments Clearing and Settlement (PACS).

Dalam arsitektur *fintech* modern (seperti Payment Gateway atau E-Wallet), Go sering digunakan untuk mem-parsing dan membuat pesan ini karena kecepatannya. Namun, karena XML bisa sangat besar (terutama pesan CAMT.053 End of Day Statement), penggunaan `xml.Decoder` berbasis stream token jauh lebih superior dibanding `xml.Unmarshal` tradisional yang memakan memori O(N). Keakuratan namespace, timestamp ISO 8601, serta presisi nilai uang menggunakan representasi desimal (*fixed-point*) mutlak diperlukan.

## 2. Diagram Alur End-to-End (ASCII)

```text
[Corporate/Fintech]                  [Bank System]                      [Clearing Network]
        |                                 |                                     |
        |---- 1. PAIN.001 (Init) -------->|                                     |
        |                                 |---- 2. Routing/Clearing ----------->|
        |                                 |                                     |
        |<--- 3. PACS.002 (Reject) -------| (If validation fails)               |
        |                                 |                                     |
        |<--- 4. CAMT.054 (Credit/Debit)- | (Intra-day Notification)            |
        |                                 |                                     |
        |<--- 5. CAMT.053 (Statement) --- | (End-of-day Reconciliation)         |
        |                                 |                                     |
```

## 3. Production-Ready Code

```go
package iso20022

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Types for PAIN.001 Generation
type DocumentPain001 struct {
	XMLName xml.Name `xml:"urn:iso:std:iso:20022:tech:xsd:pain.001.001.03 Document"`
	CstmrCdtTrfInitn CustomerCreditTransferInitiation `xml:"CstmrCdtTrfInitn"`
}

type CustomerCreditTransferInitiation struct {
	GrpHdr GroupHeader `xml:"GrpHdr"`
	PmtInf PaymentInformation `xml:"PmtInf"`
}

type GroupHeader struct {
	MsgId    string `xml:"MsgId"`
	CreDtTm  string `xml:"CreDtTm"`
	NbOfTxs  int    `xml:"NbOfTxs"`
	InitgPty Party  `xml:"InitgPty"`
}

type PaymentInformation struct {
	PmtInfId string `xml:"PmtInfId"`
	CdtTrfTxInf []CreditTransferTransactionInformation `xml:"CdtTrfTxInf"`
}

type CreditTransferTransactionInformation struct {
	PmtId PaymentIdentification `xml:"PmtId"`
	Amt   Amount                `xml:"Amt"`
}

type PaymentIdentification struct {
	EndToEndId string `xml:"EndToEndId"`
}

type Amount struct {
	InstdAmt InstdAmt `xml:"InstdAmt"`
}

type InstdAmt struct {
	Ccy   string `xml:"Ccy,attr"`
	Value string `xml:",chardata"`
}

type Party struct {
	Nm string `xml:"Nm"`
}

// 1. Generate PAIN.001
func GeneratePain001(msgId string, endToEndId string, currency string, amount decimal.Decimal) ([]byte, error) {
	doc := DocumentPain001{
		CstmrCdtTrfInitn: CustomerCreditTransferInitiation{
			GrpHdr: GroupHeader{
				MsgId:   msgId,
				CreDtTm: time.Now().UTC().Format(time.RFC3339),
				NbOfTxs: 1,
				InitgPty: Party{Nm: "Fintech Corp"},
			},
			PmtInf: PaymentInformation{
				PmtInfId: "PMT-" + msgId,
				CdtTrfTxInf: []CreditTransferTransactionInformation{
					{
						PmtId: PaymentIdentification{EndToEndId: endToEndId},
						Amt: Amount{
							InstdAmt: InstdAmt{
								Ccy:   currency,
								Value: amount.StringFixed(2),
							},
						},
					},
				},
			},
		},
	}

	buf := new(bytes.Buffer)
	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(buf)
	enc.Indent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// 2. Validate PAIN.001
var bicRegex = regexp.MustCompile(`^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$`)

func ValidatePain001(doc *DocumentPain001) error {
	if doc.CstmrCdtTrfInitn.GrpHdr.MsgId == "" {
		return errors.New("MsgId is required")
	}
	for _, tx := range doc.CstmrCdtTrfInitn.PmtInf.CdtTrfTxInf {
		if tx.PmtId.EndToEndId == "" {
			return errors.New("EndToEndId is required")
		}
		if len(tx.PmtId.EndToEndId) > 35 {
			return errors.New("EndToEndId exceeds 35 characters")
		}
		if tx.Amt.InstdAmt.Ccy == "" {
			return errors.New("Currency is required")
		}
		amt, err := decimal.NewFromString(tx.Amt.InstdAmt.Value)
		if err != nil {
			return errors.New("Invalid amount format")
		}
		if amt.LessThanOrEqual(decimal.Zero) {
			return errors.New("Amount must be greater than zero")
		}
	}
	return nil
}

// 3. Streaming Parser for CAMT.053
type StatementEntry struct {
	Ref    string
	Amount decimal.Decimal
}

func ParseCamt053(reader io.Reader) ([]StatementEntry, error) {
	decoder := xml.NewDecoder(reader)
	var entries []StatementEntry

	for {
		t, err := decoder.Token()
		if t == nil || err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}

		switch se := t.(type) {
		case xml.StartElement:
			// Match 'Ntry' inside statement
			if se.Name.Local == "Ntry" {
				var entry struct {
					NtryRef string `xml:"NtryRef"`
					Amt     string `xml:"Amt"`
				}
				if err := decoder.DecodeElement(&entry, &se); err != nil {
					return nil, err
				}
				amt, _ := decimal.NewFromString(entry.Amt)
				entries = append(entries, StatementEntry{Ref: entry.NtryRef, Amount: amt})
			}
		}
	}
	return entries, nil
}

// Strip BOM for robust XML parsing
func stripBOM(b []byte) []byte {
	return bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
}

// -- UNIT TESTS --
func TestPain001Flow(t *testing.T) {
	// 1. Valid Generation
	msgId := uuid.New().String()
	xmlBytes, err := GeneratePain001(msgId, "E2E-12345", "IDR", decimal.NewFromInt(150000))
	if err != nil {
		t.Fatalf("Generate fail: %v", err)
	}

	// 2. Invalid XML Validation (Missing MsgId)
	var doc DocumentPain001
	_ = xml.Unmarshal(xmlBytes, &doc)
	doc.CstmrCdtTrfInitn.GrpHdr.MsgId = ""
	if err := ValidatePain001(&doc); err == nil || !strings.Contains(err.Error(), "MsgId") {
		t.Errorf("Expected MsgId error")
	}

	// 3. Amount = 0 Validation
	doc.CstmrCdtTrfInitn.GrpHdr.MsgId = "MSG1"
	doc.CstmrCdtTrfInitn.PmtInf.CdtTrfTxInf[0].Amt.InstdAmt.Value = "0.00"
	if err := ValidatePain001(&doc); err == nil || !strings.Contains(err.Error(), "greater than zero") {
		t.Errorf("Expected amount error")
	}

	// 4. EndToEndId > 35 rejection
	doc.CstmrCdtTrfInitn.PmtInf.CdtTrfTxInf[0].Amt.InstdAmt.Value = "10.00"
	doc.CstmrCdtTrfInitn.PmtInf.CdtTrfTxInf[0].PmtId.EndToEndId = strings.Repeat("A", 36)
	if err := ValidatePain001(&doc); err == nil || !strings.Contains(err.Error(), "exceeds 35") {
		t.Errorf("Expected EndToEndId error")
	}
}

func TestParseCamt053(t *testing.T) {
	// 5. Valid Parse & BOM Stripping
	camtXML := []byte("\xef\xbb\xbf<Document><BkToCstmrStmt><Stmt><Ntry><NtryRef>REF1</NtryRef><Amt>100.50</Amt></Ntry></Stmt></BkToCstmrStmt></Document>")
	entries, err := ParseCamt053(bytes.NewReader(stripBOM(camtXML)))
	if err != nil {
		t.Fatalf("Parse fail: %v", err)
	}
	if len(entries) != 1 || entries[0].Ref != "REF1" || !entries[0].Amount.Equal(decimal.NewFromFloat(100.5)) {
		t.Errorf("Parsed wrong data: %+v", entries)
	}
}
```

## 4. Anti-Patterns

### Anti-Pattern 1: In-Memory XML Unmarshalling (OOM Risk)
❌ **BAD:** Menggunakan `xml.Unmarshal` untuk file statement berukuran GB.
```go
// Akan crash (OOM) jika file CAMT.053 mencapai 2GB
var doc Camt053
err := xml.Unmarshal(largeXMLBytes, &doc)
```
✅ **GOOD:** Gunakan `xml.Decoder.Token()` untuk iterasi per-elemen `<Ntry>` secara streaming.

### Anti-Pattern 2: Menggunakan Float untuk Amount
❌ **BAD:**
```go
type InstdAmt struct {
    Value float64 `xml:",chardata"` // 0.1 + 0.2 = 0.30000000000000004
}
```
✅ **GOOD:** Gunakan tipe string saat Unmarshal dan konversi ke Decimal (`shopspring/decimal`).

### Anti-Pattern 3: Format Waktu Tidak Presisi ISO 8601
❌ **BAD:**
```go
CreDtTm: time.Now().Format("2006-01-02 15:04:05") // Ditolak oleh XSD Bank
```
✅ **GOOD:** Gunakan UTC RFC3339 `time.Now().UTC().Format(time.RFC3339)`.

## 5. Edge Cases

1. **Byte Order Mark (BOM):** File XML dari sistem Windows bank sering memiliki karakter *invisible* BOM (`\xef\xbb\xbf`) di awal yang akan membuat `xml.NewDecoder` melempar `EOF` atau `syntax error`. Solusi: Lakukan `bytes.TrimPrefix` sebelum mem-parsing.
2. **Missing Namespaces (xmlns):** Standar ISO20022 ketat pada namespace (`urn:iso:std:iso:20022:tech:xsd:pain.001.001.03`). Jika parser tidak mencocokkan namespace ini di root `<Document>`, data di dalamnya bisa gagal dimapping meskipun field tag-nya benar.
3. **EndToEndId Character Limit & Special Chars:** `EndToEndId` dibatasi maksimal 35 karakter alphanumeric. Jika mengirim UUID v4 utuh (36 karakter), transaksi akan ditolak (`PACS.002` Reject). UUID harus di-*strip* tanda hubungnya. Karakter non-latin juga akan menyebabkan XSD schema failure.
4. **Duplicate Messages (Idempotency):** `MsgId` pada header harus unik per bank. Fintech harus menyimpan state pengiriman dan memastikan `MsgId` yang sama tidak dikirim dua kali meskipun terjadi timeout, melainkan melakukan inquiry.
5. **Huge Payload Streaming Interruption:** Saat mem-parsing CAMT.053 besar secara streaming, network/disk I/O bisa drop. Pastikan parser menyimpan *offset* atau cursor rekonsiliasi yang sukses di-proses (`NtryRef`) agar bisa di-resume, bukan diulang dari awal saat file diunduh ulang.

## Kapan JANGAN Pakai Ini

- **Menulis parser XML sendiri.** Skema ISO 20022 besar dan berubah mengikuti rilis tahunan. Hasilkan kode dari XSD resmi; parser tangan akan tertinggal dan kesalahannya muncul sebagai pesan yang ditolak bank.
- **Mengasumsikan semua bank menerapkan skema yang identik.** Variasi lokal nyata, didokumentasikan terpisah, dan sering wajib. Rencanakan profil per counterparty sejak awal.
- **Memproses pesan tanpa validasi terhadap skema.** Pesan yang tidak valid harus ditolak di gerbang dengan alasan yang jelas — bukan diteruskan sampai gagal di logika bisnis, jauh dari konteksnya.
- **Menyimpan pesan mentah tanpa penyaringan untuk keperluan debug.** Pesan memuat data pihak yang tunduk aturan privasi dan retensi. Simpan yang perlu, saring sisanya, dan tetapkan masa simpan.
- **Mengabaikan idempotensi di tingkat pesan.** Pengiriman ulang adalah bagian **normal** protokol perbankan, bukan anomali. Deduplikasi berdasarkan pengenal pesan wajib ada.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Bank menolak pesan | validasi terhadap XSD sebelum kirim | Pesan tidak sesuai skema atau profil lokal |
| Instruksi diproses dua kali | deduplikasi pengenal pesan | Pengiriman ulang dianggap pesan baru |
| Gagal setelah pembaruan skema tahunan | versi skema yang dipakai | Skema hulu berubah |
| Data pribadi tersimpan lebih lama dari kebijakan | retensi pesan mentah | Tidak ada penyaringan dan masa simpan |
| Perilaku beda antar counterparty | profil per bank | Variasi lokal tidak dimodelkan |

```bash
# Validasi terhadap XSD resmi SEBELUM mengirim -- ini gerbang yang paling murah
xmllint --noout --schema pain.001.001.09.xsd message.xml

# Pesan yang ditolak, dikelompokkan berdasarkan alasan
kubectl logs -l app=swift --since=24h \
  | jq -r 'select(.event=="message_rejected") | .reason' | sort | uniq -c | sort -rn
```

```sql
-- Pengenal pesan yang muncul lebih dari sekali: pengiriman ulang, harus dideduplikasi
SELECT msg_id, count(*) FROM incoming_messages GROUP BY 1 HAVING count(*) > 1 LIMIT 20;
```
