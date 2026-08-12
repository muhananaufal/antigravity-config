# Referensi Mutakhir: Buku Besar Audit Ledger Immutable Berbasis HMAC untuk Kepatuhan SOC2

## 1. Pendahuluan
Mempertahankan kepatuhan SOC2 Tipe II mewajibkan sebuah perusahaan memiliki log audit (Audit Trail) yang tidak bisa diubah (immutable), tahan banting, dan membuktikan keaslian setiap kejadian operasional di sistem. Dalam pendekatan arsitektur *Zero Trust Enterprise*, sekadar menulis log ke dalam file *plain text* sangat rawan dimanipulasi setelah insiden *breach*. Referensi ini mendemonstrasikan implementasi "Buku Besar Audit (Audit Ledger) Tersambung" (*chained ledger*) di Rust menggunakan HMAC (Hash-based Message Authentication Code). Pendekatan ini memastikan secara kriptografis bahwa jika ada satu baris kejadian log yang diedit oleh aktor jahat di tengah-tengah file, maka rantai *hash* HMAC berikutnya akan terputus dan korupsi bisa langsung dideteksi secara presisi.

## 2. Diagram Arsitektur Ledger HMAC
Sistem Audit Ledger ini berfungsi secara mirip dengan *blockchain* ringan internal:

```text
    [ Event Keamanan Masuk ]
        (Akses Gagal, Otorisasi Elevasi, dll)
                   |
                   v
    +-----------------------------------------------+
    |         Audit Ledger Manager (Singleton)      |
    |                                               |
    |  +-----------------------------------------+  |
    |  | Ciptakan Baris Log Baru                 |  |
    |  | Serialisasi JSON -> Payload Log         |  |
    |  +-----------------------------------------+  |
    |                   |                           |
    |  +-----------------------------------------+  |
    |  | Hitung HMAC ( Payload Log + Prev_Hash ) |  |
    |  | Kunci Rahasia = Secret dari KMS / Vault |  |
    |  +-----------------------------------------+  |
    |                   |                           |
    |                   v                           |
    |    ( Menghasilkan Hash Ledger Saat Ini )      |
    +-------------------+---------------------------+
                        |
            Append-only File / Stream Database
            (Baris log memuat Hash sebagai verifikasi)
```

## 3. Implementasi Produksi Idiomatis
Implementasi ini menggunakan pustaka `ring` untuk kriptografi level enterprise (HMAC-SHA256) serta pengelolaan rantai keadaan log.

```rust
use ring::hmac;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("Integritas buku besar gagal diverifikasi pada blok: {0}")]
    IntegrityViolation(usize),
    #[error("Gagal melakukan serialisasi event log")]
    SerializationError,
}

/// Struktur data entitas Event Audit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub timestamp: u64,
    pub action: String,
    pub actor_id: String,
    pub resource: String,
}

/// Mewakili satu baris/blok dalam ledger audit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub sequence_id: usize,
    pub event: AuditEvent,
    pub previous_hash: String,
    pub entry_hash: String,
}

/// Pengelola Buku Besar Kriptografis In-Memory
pub struct HmacAuditLedger {
    secret_key: hmac::Key,
    entries: Arc<Mutex<Vec<LedgerEntry>>>,
}

impl HmacAuditLedger {
    /// Inisialisasi buku besar. Dalam produksi, key diambil dari layanan rotasi kredensial rahasia
    pub fn new(secret_string: &str) -> Self {
        let key = hmac::Key::new(hmac::HMAC_SHA256, secret_string.as_bytes());
        Self {
            secret_key: key,
            entries: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Hitung hash HMAC berbasis Hexadecimal String
    fn compute_hash(&self, payload: &str, prev_hash: &str) -> String {
        let mut ctx = hmac::Context::with_key(&self.secret_key);
        ctx.update(payload.as_bytes());
        ctx.update(b"||");
        ctx.update(prev_hash.as_bytes());
        let tag = ctx.sign();
        hex::encode(tag.as_ref())
    }

    /// Menambahkan kejadian baru dengan mendelegasikan dan mengikat hash ke state log sebelumnya
    pub fn append_event(&self, event: AuditEvent) -> Result<LedgerEntry, LedgerError> {
        let mut entries = self.entries.lock().unwrap();
        
        let seq_id = entries.len();
        let previous_hash = if seq_id == 0 {
            "GENESIS_BLOCK_HASH_ZERO".to_string()
        } else {
            entries[seq_id - 1].entry_hash.clone()
        };

        let event_json = serde_json::to_string(&event)
            .map_err(|_| LedgerError::SerializationError)?;

        let entry_hash = self.compute_hash(&event_json, &previous_hash);

        let entry = LedgerEntry {
            sequence_id: seq_id,
            event,
            previous_hash,
            entry_hash,
        };

        entries.push(entry.clone());
        Ok(entry)
    }

    /// Melakukan verifikasi keseluruhan rantai sejarah log kriptografis.
    /// Berfungsi sebagai alat validasi SOC2.
    pub fn verify_integrity(&self) -> Result<bool, LedgerError> {
        let entries = self.entries.lock().unwrap();
        
        for i in 0..entries.len() {
            let current = &entries[i];
            
            let prev_hash = if i == 0 {
                "GENESIS_BLOCK_HASH_ZERO".to_string()
            } else {
                entries[i - 1].entry_hash.clone()
            };
            
            if current.previous_hash != prev_hash {
                return Err(LedgerError::IntegrityViolation(i));
            }
            
            let event_json = serde_json::to_string(&current.event)
                .map_err(|_| LedgerError::SerializationError)?;
            let computed = self.compute_hash(&event_json, &prev_hash);
            
            if current.entry_hash != computed {
                return Err(LedgerError::IntegrityViolation(i));
            }
        }
        
        Ok(true)
    }
    
    /// Modifikasi paksa secara internal untuk kebutuhan pengujian integritas (Simulasi Hacker)
    #[cfg(test)]
    fn tamper_with_ledger(&self, index: usize, new_action: &str) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get_mut(index) {
            entry.event.action = new_action.to_string();
        }
    }
}
```

## 4. Pengujian (Unit & Integration Tests)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn create_dummy_event(action: &str) -> AuditEvent {
        AuditEvent {
            timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            action: action.to_string(),
            actor_id: "admin_x".to_string(),
            resource: "database_users".to_string(),
        }
    }

    #[test]
    fn test_valid_ledger_append_and_verify() {
        let ledger = HmacAuditLedger::new("soc2_super_secret_audit_key");
        
        ledger.append_event(create_dummy_event("CREATE")).unwrap();
        ledger.append_event(create_dummy_event("UPDATE")).unwrap();
        ledger.append_event(create_dummy_event("DELETE")).unwrap();
        
        assert_eq!(ledger.verify_integrity().unwrap(), true);
    }

    #[test]
    fn test_tampered_ledger_detection() {
        let ledger = HmacAuditLedger::new("soc2_super_secret_audit_key");
        
        ledger.append_event(create_dummy_event("CREATE")).unwrap();
        ledger.append_event(create_dummy_event("READ")).unwrap(); // Sequence 1
        ledger.append_event(create_dummy_event("DELETE")).unwrap();
        
        // Memverifikasi state sehat
        assert_eq!(ledger.verify_integrity().unwrap(), true);
        
        // Mensimulasikan manipulasi oleh Aktor Jahat (Hacker)
        // Hacker mengganti rekaman log READ menjadi ELEVATE_PRIVILEGE tanpa tahu Kunci HMAC.
        ledger.tamper_with_ledger(1, "ELEVATE_PRIVILEGE");
        
        // Verifikasi harus mendeteksi kerusakan rantai kriptografis.
        let result = ledger.verify_integrity();
        assert!(matches!(result, Err(LedgerError::IntegrityViolation(1))));
    }
}
```

## 5. Anti-Patterns Kritis

1. **Sinkronisasi File I/O Blocking di Main Thread (Single-Threaded I/O Bottleneck)**
   *Penjelasan:* Apabila sistem menulis (menyimpan) *audit event* berurut HMAC ini langsung menuju sistem *file* Linux tanpa pendelegasian asinkron atau menggunakan penahan (*buffer/channel*), maka keseluruhan layanan akan ditahan (*blocked*) selama latensi disk I/O.
   *Solusi:* Sistem operasi *Ledger Logging* semestinya berjalan sebagai *Actor* atau *Worker Thread* terpisah yang membaca event log dari antrean *MPSC channel* berbasis memori bebas halangan.

2. **Mengekspos Kunci HMAC dalam Kode Biner Rilis (Hardcoded Secret Material)**
   *Penjelasan:* Menginisialisasi HMAC menggunakan konstanta terkompilasi (atau *Environment Variable* yang disuntik saat membangun *image* Docker dan ter-ekspos di manifest) akan secara permanen membocorkan keamanan HMAC tersebut ke siapapun yang memiliki akses ekstrak kontainer. Aktor internal jahat bisa merekalkulasi seluruh rantai.
   *Solusi:* Ambil material kunci langsung pada masa *startup service* (`runtime`) ke penyedia keamanan rotasi (e.g. AWS KMS atau Azure KeyVault) dan tahan di memori terproteksi.

## 6. Production Edge Cases

1. **Volume Log Raksasa (Audit Ledger Partitioning and Rollover)**
   *Penjelasan:* Sistem yang berumur berbulan-bulan akan menumpuk puluhan juta *events*, membuat eksekusi verifikasi `.verify_integrity()` atas keseluruhan dari Genesis memakan waktu berjam-jam (menghabiskan CPU). 
   *Penanganan:* Lakukan strategi partisipasi kalendar (Misal: harian `audit_log_20241012.db`). Akhir dari rantai partisi hari sebelumnya akan dienkapsulasi menjadi *Genesis Block* hari besok.

2. **Kondisi Kehabisan Kapasitas Diska (*No Space Left on Device*)**
   *Penjelasan:* Apabila diska pencatatan log penuh, *Append* akan gagal secara persisten. Di lingkungan Zero Trust, sistem dilarang keras terus mengeksekusi operasi bisnis tanpa jejak audit karena ini mencoreng jaminan SOC2 (kegagalan tak kentara/ *silent fail open*).
   *Penanganan:* Desain dengan arsitektur "Fail Closed" secara tegas. Layanan *ingress* API harus seketika dihentikan, di-*throttle*, atau membalik error `HTTP 503` saat lapisan bawah sistem gagal merekam *audit*.

3. **Kehilangan Log Karena Crash Dadakan (*Volatile Log Loss*)**
   *Penjelasan:* Bila log dimasuk-antrekan ke *buffer* RAM tanpa disk-sync `fsync()`, lalu mesin putus daya mendadak, insiden pelanggaran otorisasi terbaru tidak akan tergurat di *ledger*. Aktor canggih sering sengaja menyebabkan *Kernel Panic* sesaat setelah aksi kotor (*smash & grab*).
   *Penanganan:* Eksekusi `fdatasync()` berkala atau serahkan kepada basis daya log terdistribusi yang menyediakan sinkronisasi *quorum/consensus* yang konsisten kuat seperti Apache Kafka (tipe *acks=all*).
