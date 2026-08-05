# Double-Entry Bookkeeping Ledger di Go

> **Berlaku:** Go 1.21+ · PostgreSQL 14+ · **Lihat juga:** `fintech_reliability/decimal_arithmetic_money.md` · `fintech_reliability/reconciliation_engine.md` · `db_sqlc/acid_transactions_isolation.md` · `distributed_patterns_resilience/outbox_pattern_transactional.md`

## Concept/Internals
Sistem keuangan dan dompet digital (e-wallet) tidak boleh dibangun semata-mata dengan kolom "Balance" (`saldo`) yang terus di-*update*. Metode ini (Single-Entry) rentan terhadap *race condition*, audit trail yang hilang, dan mutasi diam-diam (ghost mutations).
Standar emas di industri fintech adalah **Double-Entry Bookkeeping**. Prinsip utamanya berbunyi: *Setiap transaksi moneter harus memiliki setidaknya satu baris Debit dan satu baris Credit, dan jumlah total Debet harus sama persis dengan total Kredit (Sum(Debit) = Sum(Credit)).* 
Alih-alih memperbarui *saldo* langsung, *saldo* (Balance) dihitung secara dinamis dari akumulasi buku besar (Ledger Entries). Buku besar bersifat *append-only* (tidak bisa diubah/dihapus), menciptakan sistem *Immutable Audit Trail*.

Komponen Sistem:
1. **Account (Buku):** Entitas yang memegang *saldo*. (e.g., `User_Wallet`, `Company_Revenue`, `System_Holding`).
2. **Transaction (Jurnal):** Event logis perpindahan dana (e.g., `Topup_User`).
3. **Entry (Mutasi):** Catatan Debet atau Kredit aktual yang menempel pada *Transaction*.

### Diagram ASCII: Double-Entry Flow

```ascii
[ Transfer $50 dari Alice ke Bob ]

+-------------------------+
| Transaction ID: TX-789  |
| Type: P2P_TRANSFER      |
+--------+----------------+
         |
         | (Atomic DB Transaction)
         |
         +--> [Entry 1] Account: "Alice_Wallet"
         |              Type: DEBIT (Mengurangi)
         |              Amount: $50.00
         |
         +--> [Entry 2] Account: "Bob_Wallet"
                        Type: CREDIT (Menambah)
                        Amount: $50.00
                        
        Validasi: Sum(DEBIT) == Sum(CREDIT) ? YES (Lanjutkan) : ROLLBACK
```

## Production Code

Implementasi wajib menggunakan pustaka *decimal* dan konteks database transaksional (`sql.Tx`).

```go
package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

var (
	ErrImbalancedTransaction = errors.New("debits and credits do not balance")
	ErrInsufficientFunds     = errors.New("insufficient funds")
	ErrAccountNotFound       = errors.New("account not found")
)

// EntryType menyatakan arah pergerakan uang
type EntryType string

const (
	EntryDebit  EntryType = "DEBIT"  // Menurunkan liability (Saldo user berkurang) / Menambah Asset
	EntryCredit EntryType = "CREDIT" // Menambah liability (Saldo user bertambah) / Mengurangi Asset
)

// LedgerEntry mewakili satu mutasi ke satu akun
type LedgerEntry struct {
	AccountID string
	Type      EntryType
	Amount    decimal.Decimal
}

// PostTransaction memproses double-entry journal secara atomik
func PostTransaction(ctx context.Context, db *sql.DB, txID string, entries []LedgerEntry) error {
	// 1. Validasi Akuntansi Internal (In-Memory)
	if err := validateBalance(entries); err != nil {
		return err
	}

	// 2. Mulai DB Transaction
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("failed to begin tx: %w", err)
	}
	// Pastikan rollback jika terinterupsi/panic
	defer tx.Rollback()

	now := time.Now().UTC()

	for _, entry := range entries {
		// Validasi saldo (Untuk akun tipe user, debit tidak boleh membuat saldo jadi negatif)
		if entry.Type == EntryDebit {
			// Optimistic Locking: Baca saldo saat ini dengan FOR UPDATE untuk mencegah race condition
			var currentBalance string
			err := tx.QueryRowContext(ctx, 
				`SELECT balance FROM accounts WHERE id = $1 FOR UPDATE`, 
				entry.AccountID).Scan(&currentBalance)
			
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return fmt.Errorf("%w: %s", ErrAccountNotFound, entry.AccountID)
				}
				return fmt.Errorf("failed to check balance: %w", err)
			}

			currDec, _ := decimal.NewFromString(currentBalance)
			if currDec.LessThan(entry.Amount) {
				return fmt.Errorf("%w: account %s", ErrInsufficientFunds, entry.AccountID)
			}
		}

		// Insert *append-only* entry log
		_, err = tx.ExecContext(ctx,
			`INSERT INTO ledger_entries (tx_id, account_id, entry_type, amount, created_at) VALUES ($1, $2, $3, $4, $5)`,
			txID, entry.AccountID, string(entry.Type), entry.Amount.String(), now,
		)
		if err != nil {
			return fmt.Errorf("failed to insert entry: %w", err)
		}

		// Update cached balance table (Denormalization for performance)
		modifier := "+"
		if entry.Type == EntryDebit {
			modifier = "-" // Asumsi akun adalah Liability (Saldo Nasabah)
		}
		
		_, err = tx.ExecContext(ctx,
			fmt.Sprintf(`UPDATE accounts SET balance = balance %s $1 WHERE id = $2`, modifier),
			entry.Amount.String(), entry.AccountID,
		)
		if err != nil {
			return fmt.Errorf("failed to update account balance: %w", err)
		}
	}

	// 3. Commit Transaksi
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit tx: %w", err)
	}

	return nil
}

// validateBalance memverifikasi Sum(Debit) == Sum(Credit) dan amount positif.
func validateBalance(entries []LedgerEntry) error {
	sumDebit := decimal.Zero
	sumCredit := decimal.Zero

	for _, e := range entries {
		if e.Amount.LessThanOrEqual(decimal.Zero) {
			return errors.New("entry amount must be positive")
		}
		if e.Type == EntryDebit {
			sumDebit = sumDebit.Add(e.Amount)
		} else if e.Type == EntryCredit {
			sumCredit = sumCredit.Add(e.Amount)
		} else {
			return fmt.Errorf("invalid entry type: %s", e.Type)
		}
	}

	if !sumDebit.Equal(sumCredit) {
		return fmt.Errorf("%w: debits=%s credits=%s", ErrImbalancedTransaction, sumDebit.String(), sumCredit.String())
	}
	return nil
}

// --- Unit Tests ---

func TestValidateBalance(t *testing.T) {
	valid := []LedgerEntry{
		{AccountID: "A", Type: EntryDebit, Amount: decimal.RequireFromString("10.50")},
		{AccountID: "B", Type: EntryCredit, Amount: decimal.RequireFromString("10.50")},
	}
	if err := validateBalance(valid); err != nil {
		t.Errorf("expected no error, got %v", err)
	}

	invalid := []LedgerEntry{
		{AccountID: "A", Type: EntryDebit, Amount: decimal.RequireFromString("10.50")},
		{AccountID: "B", Type: EntryCredit, Amount: decimal.RequireFromString("10.00")}, // Mismatch!
	}
	if err := validateBalance(invalid); !errors.Is(err, ErrImbalancedTransaction) {
		t.Errorf("expected ErrImbalancedTransaction, got %v", err)
	}
}
```

## Anti-Patterns

### ❌ Anti-Pattern 1: Menyimpan Nilai Minus (Negatif) di Database
**Mengapa berbahaya:** Jika Anda merekam nilai `amount = -50` untuk debit dan `-50` untuk saldo, kalkulasi query analitik akan menjadi sangat rumit dan rawan salah tanda (+/-) ganda. Auditor kebingungan menafsirkan apakah itu pembatalan transaksi, hutang, atau penarikan tunai normal.

```go
// BAD: Mencampur positif/negatif di amount mutasi
entry := LedgerEntry{AccountID: "UserA", Amount: decimal.RequireFromString("-50.00")}
```
```go
// GOOD: Amount selalu absolut (positif), arah ditentukan oleh Tipe Entry (Debit/Credit)
entry := LedgerEntry{AccountID: "UserA", Type: EntryDebit, Amount: decimal.RequireFromString("50.00")}
```

### ❌ Anti-Pattern 2: Melakukan Pengecekan Saldo Tanpa `FOR UPDATE` (Race Condition)
**Mengapa berbahaya:** Jika dua transaksi HTTP bersamaan mencoba mengurangi uang dari dompet `User A` sebesar $100 sementara saldo totalnya hanya $100. Keduanya membaca saldo $100 pada baris kode pertama, keduanya mendapati kondisi `100 >= 100`, dan keduanya berhasil memotong $100. Hasilnya saldo User A menjadi -$100 (Overdraft ilegal).

```go
// BAD: Select tanpa mengunci row (No Pessimistic Lock)
tx.QueryRow(`SELECT balance FROM accounts WHERE id = 1`).Scan(&bal)
```
```go
// GOOD: Gunakan klausa penguncian row
tx.QueryRow(`SELECT balance FROM accounts WHERE id = 1 FOR UPDATE`).Scan(&bal)
```

### ❌ Anti-Pattern 3: Single-Sided Ledger
**Mengapa berbahaya:** Mencatat bahwa uang bertambah di akun user $50 tanpa mencatat dari mana uang itu berasal (misal: "Promo_Holding_Account"). Uang tidak diciptakan dari kehampaan. Jika hal ini dibiarkan, neraca percobaan perusahaan akan defisit dan Anda tidak bisa melacak darimana injeksi tunai tersebut bermula, menyebabkan gagalnya lisensi Bank Indonesia (BI).

```go
// BAD: Hanya ada 1 entry
PostTransaction(ctx, db, txID, []LedgerEntry{
    {AccountID: "User", Type: EntryCredit, Amount: val}, // Saldo darimana?!
})
```

## Edge Cases & Defensive Programming

1. **Temporal Precision (Clock Drift)**: Data audit ledger tidak boleh menggunakan *timestamp* dari server yang mengeksekusi request jika waktunya diekstrak tanpa sinkronisasi NTP, karena urutan *append-only* log dapat terbalik secara waktu. Paling aman, serahkan penulisan `created_at` ke database engine (menggunakan `NOW()` atau `CURRENT_TIMESTAMP`) sehingga dijamin *monotonically increasing* di database *master node*.
2. **Denormalization Desync**: Di kode atas, kita melakukan mutasi `ledger_entries` (sumber kebenaran) sekaligus merangkum saldonya ke tabel `accounts` (denormalisasi untuk performa pembacaan). Jika terjadi *bug/race* langka, saldo akun bisa *out of sync* dengan sum mutasinya. Implementasikan *CRON Job Rekonsiliasi Malam (EOD)* yang membandingkan `balance == Sum(Credit) - Sum(Debit)` dan me-resetnya jika terjadi *drift*.
3. **Deadlocks dalam Multi-Row Updates**: Jika Transaksi A memindahkan dana dari Akun 1 ke Akun 2, dan Transaksi B memindahkan dana dari Akun 2 ke Akun 1 pada milidetik yang sama, MySQL/PostgreSQL akan melempar error *Deadlock* (karena menunggu *row lock* satu sama lain secara silang). **Defensive programming:** Selalu lakukan *sorting* (pengurutan) berdasarkan `AccountID` secara ascending (A-Z) pada array `entries` *sebelum* memproses kueri SQL. Hal ini menjamin bahwa seluruh *lock* akan diambil sesuai urutan yang sama di segala kondisi sistem.

## Kapan JANGAN Pakai Ini

- **Ledger yang barisnya bisa di-`UPDATE` atau `DELETE`.** Entri jurnal adalah fakta historis. Koreksi dilakukan dengan **entri pembalik**, bukan dengan menyunting masa lalu. Tegakkan dengan izin database, bukan dengan kesepakatan tim.
- **Saldo sebagai kolom tanpa cara memverifikasinya terhadap jurnal.** Saldo turunan harus bisa dihitung ulang dari entri dan dicocokkan. Tanpa itu, satu bug menghasilkan angka yang salah dan tidak ada yang bisa membuktikannya.
- **Menulis satu sisi entri di luar transaksi yang mencakup keduanya.** Debit tanpa kredit adalah kerusakan permanen di pembukuan, dan menemukannya berbulan-bulan kemudian jauh lebih mahal daripada mencegahnya.
- **Ledger sebagai satu-satunya sumber pelaporan analitik.** Query agregat berat di atas tabel jurnal yang sedang panas akan mengganggu jalur transaksi. Pisahkan jalur pelaporan.
- **Tanpa constraint database yang menegakkan debit sama dengan kredit.** Menyerahkan invarian ini ke kode aplikasi berarti satu bug menghasilkan buku yang tidak seimbang — dan kode aplikasi berubah lebih sering daripada skema.

## Cara Mendeteksi Gejalanya di Produksi

| Gejala | Yang dilihat | Artinya |
| :--- | :--- | :--- |
| Buku tidak seimbang | jumlah debit vs kredit per transaksi | Ada entri yang tertulis sebagian |
| Saldo berbeda dari hasil hitung ulang | saldo kolom vs agregasi jurnal | Saldo turunan menyimpang |
| Ada baris jurnal yang pernah diubah | jejak audit pada tabel jurnal | Ledger tidak benar-benar append-only |
| Jalur transaksi melambat saat tutup buku | query pelaporan pada tabel panas | Pelaporan tidak dipisahkan |
| Entri kembar dari satu permintaan | idempotensi di lapisan atas | Retry menghasilkan entri ganda |

```sql
-- Invarian paling mendasar: setiap transaksi WAJIB seimbang
SELECT transaction_id, sum(debit) AS d, sum(credit) AS k
FROM ledger GROUP BY transaction_id HAVING sum(debit) <> sum(credit) LIMIT 20;

-- Saldo tersimpan vs hasil hitung ulang dari jurnal
SELECT a.id, a.balance,
       coalesce(sum(j.debit) - sum(j.credit), 0) AS calculated_balance,
       a.balance - coalesce(sum(j.debit) - sum(j.credit), 0) AS diff
FROM account a LEFT JOIN ledger j ON j.account_id = a.id
GROUP BY a.id, a.balance HAVING a.balance <> coalesce(sum(j.debit) - sum(j.credit), 0);

-- Apakah append-only benar-benar ditegakkan izin database?
SELECT grantee, privilege_type FROM information_schema.table_privileges
WHERE table_name = 'ledger' AND privilege_type IN ('UPDATE','DELETE');
```
