//! Shielded pool notları — circuits/src/spend.circom ile birebir aynı formüller.
//!
//! ```text
//! owner           = Poseidon1(spendKey)
//! secretHash      = Poseidon2(owner, blinding)
//! note            = Poseidon3(token, amount, secretHash)
//! spendCommitment = Poseidon3(token, amount, spendBlinding)
//! ```
//! Tüm alan elemanları 32 bayt big-endian ve BN254 skaler alanında (< p) olmalı.
//! Poseidon: circomlib parametreleri (light-poseidon `new_circom`).

use ark_bn254::Fr;
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use rand_core::{OsRng, RngCore};

use crate::Error;

pub type Field = [u8; 32];

/// BN254 skaler alan modülü p, big-endian.
const MODULUS: Field = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8,
    0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub fn is_canonical(f: &Field) -> bool {
    f < &MODULUS
}

pub fn poseidon(inputs: &[&Field]) -> Result<Field, Error> {
    if inputs.iter().any(|f| !is_canonical(f)) {
        return Err(Error::NonCanonicalField);
    }
    let mut hasher = Poseidon::<Fr>::new_circom(inputs.len()).map_err(|_| Error::NonCanonicalField)?;
    let slices: Vec<&[u8]> = inputs.iter().map(|f| f.as_slice()).collect();
    hasher.hash_bytes_be(&slices).map_err(|_| Error::NonCanonicalField)
}

pub fn address_field(addr: &[u8; 20]) -> Field {
    let mut f = [0u8; 32];
    f[12..].copy_from_slice(addr);
    f
}

pub fn amount_field(amount: u128) -> Field {
    let mut f = [0u8; 32];
    f[16..].copy_from_slice(&amount.to_be_bytes());
    f
}

/// 248 bit rastgele: her zaman < p.
pub fn random_field() -> Field {
    let mut f = [0u8; 32];
    OsRng.fill_bytes(&mut f[1..]);
    f
}

/// 32 baytlık hash'i alana indirger (Solidity `uint256(h) % SNARK_FIELD`). Kanıtların
/// bağlandığı `ctxHash` böyle hesaplanır.
pub fn hash_to_field(h: &[u8; 32]) -> Field {
    use ruint::aliases::U256;
    let p = U256::from_be_bytes(MODULUS);
    (U256::from_be_bytes(*h) % p).to_be_bytes()
}

/// Emir kanıtının bağlamı: keccak256(ciphertext) mod p
pub fn order_context(ciphertext: &[u8]) -> Field {
    use sha3::{Digest, Keccak256};
    hash_to_field(&Keccak256::digest(ciphertext).into())
}

/// Çekim kanıtının bağlamı:
/// keccak256(abi.encodePacked("darkpool/withdraw/v1", uint256(chainId), vault, recipient)) mod p
pub fn withdraw_context(chain_id: u64, vault: &[u8; 20], recipient: &[u8; 20]) -> Field {
    use sha3::{Digest, Keccak256};
    let mut h = Keccak256::new();
    h.update(b"darkpool/withdraw/v1");
    h.update(amount_field(u128::from(chain_id)));
    h.update(vault);
    h.update(recipient);
    hash_to_field(&h.finalize().into())
}

pub fn owner(spend_key: &Field) -> Result<Field, Error> {
    poseidon(&[spend_key])
}

pub fn secret_hash(owner: &Field, blinding: &Field) -> Result<Field, Error> {
    poseidon(&[owner, blinding])
}

pub fn note_commitment(token: &[u8; 20], amount: u128, secret_hash: &Field) -> Result<Field, Error> {
    poseidon(&[&address_field(token), &amount_field(amount), secret_hash])
}

pub fn spend_commitment(token: &[u8; 20], amount: u128, spend_blinding: &Field) -> Result<Field, Error> {
    poseidon(&[&address_field(token), &amount_field(amount), spend_blinding])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(n: u128) -> Field {
        amount_field(n)
    }

    fn h(s: &str) -> Field {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[2 + 2 * i..4 + 2 * i], 16).unwrap();
        }
        out
    }

    /// Değerler circomlibjs `buildPoseidon` ile üretildi (circuits/lib/note.mjs).
    #[test]
    fn matches_circomlib_vectors() {
        assert_eq!(
            poseidon(&[&f(1)]).unwrap(),
            h("0x29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133")
        );
        assert_eq!(
            poseidon(&[&f(1), &f(2)]).unwrap(),
            h("0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a")
        );
        assert_eq!(
            poseidon(&[&f(1), &f(2), &f(3)]).unwrap(),
            h("0x0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732")
        );
        let token = {
            let mut t = [0u8; 20];
            t[16..].copy_from_slice(&0xda4c0c01u32.to_be_bytes());
            t
        };
        assert_eq!(
            spend_commitment(&token, 100_000_000, &f(123_456_789)).unwrap(),
            h("0x0752801c02fbc91653b0c09e46cff94b338f94a051c71f917a2bd1c3566abc40")
        );
    }

    #[test]
    fn hash_to_field_reduces_mod_p() {
        assert_eq!(hash_to_field(&[0u8; 32]), [0u8; 32]);
        assert_eq!(hash_to_field(&MODULUS), [0u8; 32]);
        let r = hash_to_field(&[0xff; 32]);
        assert!(is_canonical(&r));
    }

    #[test]
    fn rejects_non_canonical() {
        assert_eq!(poseidon(&[&MODULUS]), Err(Error::NonCanonicalField));
        assert_eq!(poseidon(&[&[0xff; 32]]), Err(Error::NonCanonicalField));
        assert!(is_canonical(&random_field()));
    }
}
