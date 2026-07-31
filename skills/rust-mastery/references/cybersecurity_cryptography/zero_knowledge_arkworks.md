# Zero-Knowledge Proofs: zk-SNARKs dengan `arkworks`

## Konsep Utama
*Zero-Knowledge Succinct Non-Interactive Argument of Knowledge* (zk-SNARK) memungkinkan satu pihak (Prover) membuktikan kepada pihak lain (Verifier) bahwa suatu komputasi dijalankan secara benar dengan input tersembunyi (*private witness*), tanpa mengungkapkan input tersebut.
`arkworks` adalah ekosistem Rust yang modular untuk memprogram sirkuit *zero-knowledge*, mencakup primitif aljabar, kurva eliptik (seperti BLS12-381), dan protokol seperti Groth16.

Kapan digunakan:
- Sistem privasi blockchain (membuktikan validitas transaksi tanpa mengungkap jumlah atau pengirim).
- Identitas terdesentralisasi (Decentralized ID) - membuktikan usia di atas 18 tahun tanpa mengungkap tanggal lahir.
- Komputasi off-chain yang dapat diverifikasi (Rollups).

## Arsitektur & Flow (Groth16 pada Kurva BLS12-381)

```text
  [Trusted Setup / Phase 1+2]
           |
           v
  Proving Key (PK)  &  Verifying Key (VK)
           |                    |
           v                    v
      [ Prover ]           [ Verifier ]
           |                    |
   (Public Input: X)    (Public Input: X)
   (Private Witness: W)         |
           |                    |
    Proof = Groth16(X, W, PK)   |
           |                    |
           +----- Proof ------->|
                                v
                      Valid = Check(Proof, X, VK)
```

## Production-Ready Code

```rust
use ark_bls12_381::{Bls12_381, Fr};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, ProvingKey, VerifyingKey, Proof};
use ark_relations::{
    lc,
    r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError},
};
use ark_snark::SNARK;
use ark_std::rand::rngs::OsRng;
use std::error::Error;

/// Sirkuit Sederhana: Membuktikan bahwa kita mengetahui akar kuadrat (x) dari suatu nilai publik (y).
/// Persamaan: x * x = y
/// Public Input: y
/// Private Witness: x
#[derive(Clone)]
pub struct SquareRootCircuit<F: PrimeField> {
    pub x: Option<F>, // Private (Witness)
    pub y: Option<F>, // Public
}

impl<F: PrimeField> ConstraintSynthesizer<F> for SquareRootCircuit<F> {
    fn generate_constraints(self, cs: ConstraintSystemRef<F>) -> Result<(), SynthesisError> {
        // Alokasi private witness 'x'
        let x_var = cs.new_witness_variable(|| self.x.ok_or(SynthesisError::AssignmentMissing))?;
        
        // Alokasi public input 'y'
        let y_var = cs.new_input_variable(|| self.y.ok_or(SynthesisError::AssignmentMissing))?;

        // Tambahkan constraint (Rank-1 Constraint System / R1CS)
        // a * b = c ==> x * x = y
        cs.enforce_constraint(
            lc!() + x_var,
            lc!() + x_var,
            lc!() + y_var,
        )?;

        Ok(())
    }
}

pub struct ZkSetup {
    pub pk: ProvingKey<Bls12_381>,
    pub vk: VerifyingKey<Bls12_381>,
}

/// Mensimulasikan Trusted Setup
pub fn setup_circuit() -> Result<ZkSetup, Box<dyn Error>> {
    let mut rng = OsRng;
    let dummy_circuit = SquareRootCircuit::<Fr> { x: None, y: None };

    // Groth16 setup (memerlukan randomness rahasia yang harus dihancurkan nantinya - "Toxic Waste")
    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(dummy_circuit, &mut rng)?;
    Ok(ZkSetup { pk, vk })
}

/// Prover membuat proof
pub fn generate_proof(
    pk: &ProvingKey<Bls12_381>,
    secret_x: Fr,
    public_y: Fr,
) -> Result<Proof<Bls12_381>, Box<dyn Error>> {
    let mut rng = OsRng;
    let circuit = SquareRootCircuit {
        x: Some(secret_x),
        y: Some(public_y),
    };

    let proof = Groth16::<Bls12_381>::prove(pk, circuit, &mut rng)?;
    Ok(proof)
}

/// Verifier memvalidasi proof tanpa mengetahui `secret_x`
pub fn verify_proof(
    vk: &VerifyingKey<Bls12_381>,
    proof: &Proof<Bls12_381>,
    public_y: Fr,
) -> Result<bool, Box<dyn Error>> {
    let is_valid = Groth16::<Bls12_381>::verify(vk, &[public_y], proof)?;
    Ok(is_valid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ff::Field;

    #[test]
    fn test_zk_snark_groth16() {
        // Trusted Setup
        let setup = setup_circuit().unwrap();

        // Data yang ingin dibuktikan: akar kuadrat dari 25 adalah 5
        let secret_x = Fr::from(5u32);
        let public_y = secret_x.square(); // 25

        // Generate Proof
        let proof = generate_proof(&setup.pk, secret_x, public_y).unwrap();

        // Verify Proof with valid public input (25)
        let is_valid = verify_proof(&setup.vk, &proof, public_y).unwrap();
        assert!(is_valid);

        // Verify Proof with invalid public input (26)
        let invalid_public_y = Fr::from(26u32);
        let is_valid_bad = verify_proof(&setup.vk, &proof, invalid_public_y).unwrap();
        assert!(!is_valid_bad);
    }
}
```

## Anti-Patterns Spesifik

1. **Gagal Mendeklarasikan Variabel Publik (Under-constrained Circuits)**
   - **Apa yang terjadi:** Developer mengalokasikan nilai yang seharusnya diverifikasi (seperti `y_var`) menggunakan `new_witness_variable` alih-alih `new_input_variable`.
   - **Mengapa berbahaya:** Dalam R1CS, *witness* dapat diisi apa saja oleh *Prover*. Jika `y` menjadi *witness*, Prover bisa membuat bukti valid untuk sembarang `x` tanpa persetujuan dari Verifier. Sirkuit menjadi *under-constrained* (memiliki celah), memungkinkan pemalsuan bukti secara sepele (*fake proofs*).

2. **Memanipulasi Trusted Setup (Toxic Waste Retention)**
   - **Apa yang terjadi:** Dalam lingkungan produksi, skrip yang menjalankan *Setup Phase* untuk Groth16 tidak menghapus variabel *randomness* (dikenal sebagai *Toxic Waste*) dari memori atau disk.
   - **Mengapa berbahaya:** Siapa pun yang memiliki *Toxic Waste* ini dapat menghasilkan `ProvingKey` ajaib yang dapat mensintesis *Proof* palsu untuk semua input, meruntuhkan seluruh sistem kepercayaan ZKP secara fatal (seperti *counterfeiting* massal pada crypto). Untuk produksi, setup *wajib* dilakukan via metode MPC (*Multi-Party Computation*), bukan fungsi setup tunggal di satu mesin.

## Edge Cases & Defensive Programming

- **Proof Serialization Vulnerabilities:** `Proof` dan `VerifyingKey` yang diterima dari jaringan harus di-deserialize menggunakan flag `ark_serialize::CanonicalDeserialize::deserialize_compressed_unchecked` dengan sangat hati-hati. Jika menerima *untrusted proof*, selalu gunakan verifikasi *subgroup check* ketat yang memastikan titik pada kurva eliptik valid dan tidak menimbulkan serangan *Small Subgroup*.
- **Malleability pada Non-Malleable SNARK:** Groth16 secara teknis adalah skema yang dapat dimanipulasi (*malleable*) jika desain sirkuit tidak mengikat *public inputs* secara kuat. Jika dibutuhkan sistem tanpa *trusted setup* dan resisten penuh, pertimbangkan migrasi dari Groth16 ke PLONK atau STARK menggunakan framework seperti Halo2, meski trade-off ukuran proof akan meningkat.
