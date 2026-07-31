# Write-Ahead Log (WAL) & Data Integrity

## Konsep Utama
Write-Ahead Log (WAL) adalah append-only log yang berada di disk, menjamin durabilitas data sebelum data tersebut diaplikasikan ke struktur *in-memory* (seperti MemTable). Jika sistem crash, status dapat dipulihkan dari WAL. Rekaman WAL biasanya diamankan dengan CRC32 (Cyclic Redundancy Check) dan length-prefix agar sistem bisa mendeteksi korupsi data (torn pages).

## Arsitektur & Diagram Alur (ASCII)
```text
[Data Request] 
  |
  v
[Encode: Length (4B) | CRC32 (4B) | Payload]
  |
  v
[Append to WAL Buffer] --> [Group Commit / fsync] ---> [Disk WAL Segment]
  |
  v
[Update In-Memory State]
```

## Kode Rust Production-Ready
```rust
use std::fs::{File, OpenOptions};
use std::io::{self, Write, Read, BufWriter};
use std::path::Path;
use crc32fast::Hasher;

/// Format Record:
/// [Length: u32] [CRC32: u32] [Data: Bytes]
pub struct WalWriter {
    file: File,
}

impl WalWriter {
    pub fn new<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Self { file })
    }

    pub fn append_record(&mut self, data: &[u8]) -> io::Result<()> {
        let len = data.len() as u32;
        
        let mut hasher = Hasher::new();
        hasher.update(data);
        let crc = hasher.finalize();

        // Write header (8 bytes)
        self.file.write_all(&len.to_le_bytes())?;
        self.file.write_all(&crc.to_le_bytes())?;
        
        // Write payload
        self.file.write_all(data)?;
        Ok(())
    }

    pub fn sync(&mut self) -> io::Result<()> {
        self.file.sync_data() // fsync
    }
}

pub struct WalReader {
    file: File,
}

impl WalReader {
    pub fn new<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).open(path)?;
        Ok(Self { file })
    }

    pub fn read_next(&mut self) -> io::Result<Option<Vec<u8>>> {
        let mut len_buf = [0u8; 4];
        let bytes_read = self.file.read(&mut len_buf)?;
        if bytes_read == 0 {
            return Ok(None); // EOF
        } else if bytes_read < 4 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Torn record length"));
        }
        let len = u32::from_le_bytes(len_buf) as usize;

        let mut crc_buf = [0u8; 4];
        self.file.read_exact(&mut crc_buf)?;
        let expected_crc = u32::from_le_bytes(crc_buf);

        let mut data = vec![0u8; len];
        self.file.read_exact(&mut data)?;

        let mut hasher = Hasher::new();
        hasher.update(&data);
        let actual_crc = hasher.finalize();

        if actual_crc != expected_crc {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "CRC mismatch, corrupted record"));
        }

        Ok(Some(data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_wal_write_read_verify() {
        let temp_file = NamedTempFile::new().unwrap();
        
        let mut writer = WalWriter::new(temp_file.path()).unwrap();
        writer.append_record(b"hello").unwrap();
        writer.append_record(b"world").unwrap();
        writer.sync().unwrap();

        let mut reader = WalReader::new(temp_file.path()).unwrap();
        let rec1 = reader.read_next().unwrap().unwrap();
        assert_eq!(rec1, b"hello");
        
        let rec2 = reader.read_next().unwrap().unwrap();
        assert_eq!(rec2, b"world");

        let rec3 = reader.read_next().unwrap();
        assert!(rec3.is_none());
    }
}
```

## Anti-Patterns
1. **Memanggil `fsync` untuk setiap byte/record tunggal**
   *Mengapa berbahaya:* `fsync` memerintahkan OS untuk mem-*flush* buffer disk secara sinkron. Disk modern (SSD/NVMe) sekalipun akan mengalami bottleneck drastis (maksimum ratusan/ribuan IOPS) jika dipaksa sync terus menerus. Terapkan **Group Commit** di mana banyak request ditumpuk di memori sesaat, dan di-*sync* bersamaan (batch).
2. **Mempercayai bahwa read yang berhasil = data pasti utuh tanpa CRC**
   *Mengapa berbahaya:* Crash OS atau disk power loss saat penulisan bisa menyebabkan "torn page" — blok data sebagian berisi byte baru, sebagian byte lama. Tanpa checksumming yang ketat dan pengecekan byte *length*, sistem akan crash fatal atau membaca payload acak.

## Edge Cases & Defensive Programming
- **Pre-allocation & Zero-filling:**
  Daripada bergantung pada OS untuk memperpanjang ukuran file per blok secara dinamis (overhead metadata IO), lakukan pra-alokasi file WAL (misal 64MB) dengan data `0x00` (`fallocate`). OS tidak perlu memodifikasi file table ekstensif, mempercepat kecepatan `write`.
- **Rotasi Log / Recycling:**
  Ketika segment WAL penuh, jangan langsung membuat file baru yang kosong jika memungkinkan. 'Daur ulang' (recycle) segment WAL lama yang sudah di-*flush* (dari L0 SSTable) dengan mengubah header-nya. Ini menekan intervensi VFS (Virtual File System) kernel yang lambat.
