//! Vault durumunun (tüm havuzlar) zincir üstünde şifreli saklanması.
//!
//! Enclave durumsuzdur (stateless): her batch'te zincirden son sealed state'i alır,
//! yeni sealed state üretir. Böylece enclave yeniden başlasa bile (aynı KMS
//! anahtarıyla) kaldığı yerden devam eder ve relayer hiçbir şey saklamaz.
//! Kontrat sadece `keccak256(sealed)` commitment'ını tutar/kontrol eder.
//!
//! Tüm havuzlar tek blob'da ve her batch'te hepsi yeniden şifrelenir: dışarıdan
//! bakan biri hangi havuzda işlem olduğunu göremez.
//!
//! ```text
//! plaintext = version(1) || batch_nonce u64 || pool_count u32
//!             || pool_count × [ pool_id u32 || base_token (20) || base u128 || quote u128 ]
//! sealed    = nonce(12) || AES-256-GCM(state_key, nonce, plaintext, aad = chain_id || vault)
//! state_key = HKDF-SHA256(ikm = enclave_secret, info = "darkpool/state/v1")
//! ```

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::{clearing::Reserves, keys::EnclaveKey, Error};

const STATE_VERSION: u8 = 1;
const HEADER_LEN: usize = 1 + 8 + 4;
const POOL_LEN: usize = 4 + 20 + 16 + 16;
const AEAD_OVERHEAD: usize = 12 + 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pool {
    pub pool_id: u32,
    pub base_token: [u8; 20],
    pub reserves: Reserves,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VaultState {
    /// Son uygulanan batch numarası; eski bir state'in replay edilmesini engeller.
    pub batch_nonce: u64,
    /// pool_id'ye göre artan sırada, benzersiz.
    pub pools: Vec<Pool>,
}

impl VaultState {
    pub fn pool(&self, pool_id: u32) -> Option<&Pool> {
        self.pools
            .binary_search_by_key(&pool_id, |p| p.pool_id)
            .ok()
            .map(|i| &self.pools[i])
    }

    /// Yeni havuz ekler; sıralamayı korur. Aynı id ya da boş rezerv reddedilir.
    pub fn insert_pool(&mut self, pool: Pool) -> Result<(), Error> {
        if pool.reserves.base == 0 || pool.reserves.quote == 0 {
            return Err(Error::EmptyPool);
        }
        match self.pools.binary_search_by_key(&pool.pool_id, |p| p.pool_id) {
            Ok(_) => Err(Error::DuplicatePool(pool.pool_id)),
            Err(i) => {
                self.pools.insert(i, pool);
                Ok(())
            }
        }
    }

    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Zeroizing::new(Vec::with_capacity(HEADER_LEN + POOL_LEN * self.pools.len()));
        out.push(STATE_VERSION);
        out.extend_from_slice(&self.batch_nonce.to_be_bytes());
        out.extend_from_slice(&(self.pools.len() as u32).to_be_bytes());
        for p in &self.pools {
            out.extend_from_slice(&p.pool_id.to_be_bytes());
            out.extend_from_slice(&p.base_token);
            out.extend_from_slice(&p.reserves.base.to_be_bytes());
            out.extend_from_slice(&p.reserves.quote.to_be_bytes());
        }
        out
    }

    fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() < HEADER_LEN {
            return Err(Error::MalformedState);
        }
        if b[0] != STATE_VERSION {
            return Err(Error::UnsupportedVersion(b[0]));
        }
        let batch_nonce = u64::from_be_bytes(b[1..9].try_into().unwrap());
        let count = u32::from_be_bytes(b[9..13].try_into().unwrap()) as usize;
        if b.len() != HEADER_LEN + count * POOL_LEN {
            return Err(Error::MalformedState);
        }
        let mut pools = Vec::with_capacity(count);
        for chunk in b[HEADER_LEN..].chunks_exact(POOL_LEN) {
            let pool = Pool {
                pool_id: u32::from_be_bytes(chunk[0..4].try_into().unwrap()),
                base_token: chunk[4..24].try_into().unwrap(),
                reserves: Reserves {
                    base: u128::from_be_bytes(chunk[24..40].try_into().unwrap()),
                    quote: u128::from_be_bytes(chunk[40..56].try_into().unwrap()),
                },
            };
            if pools.last().is_some_and(|prev: &Pool| prev.pool_id >= pool.pool_id) {
                return Err(Error::MalformedState);
            }
            pools.push(pool);
        }
        Ok(Self { batch_nonce, pools })
    }
}

fn state_key(key: &EnclaveKey) -> Zeroizing<[u8; 32]> {
    let secret = key.secret_bytes();
    let hk = Hkdf::<Sha256>::new(None, secret.as_ref());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(b"darkpool/state/v1", okm.as_mut()).expect("valid length");
    okm
}

fn aad(chain_id: u64, vault: &[u8; 20]) -> [u8; 28] {
    let mut out = [0u8; 28];
    out[..8].copy_from_slice(&chain_id.to_be_bytes());
    out[8..].copy_from_slice(vault);
    out
}

pub fn seal(key: &EnclaveKey, state: &VaultState, chain_id: u64, vault: &[u8; 20]) -> Result<Vec<u8>, Error> {
    let plain = state.encode();
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(state_key(key).as_ref()).map_err(|_| Error::EncryptionFailed)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain.as_ref(), aad: &aad(chain_id, vault) })
        .map_err(|_| Error::EncryptionFailed)?;

    let mut out = Vec::with_capacity(AEAD_OVERHEAD + plain.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn unseal(key: &EnclaveKey, sealed: &[u8], chain_id: u64, vault: &[u8; 20]) -> Result<VaultState, Error> {
    if sealed.len() < AEAD_OVERHEAD + HEADER_LEN {
        return Err(Error::MalformedState);
    }
    let cipher = Aes256Gcm::new_from_slice(state_key(key).as_ref()).map_err(|_| Error::DecryptionFailed)?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&sealed[..12]), Payload { msg: &sealed[12..], aad: &aad(chain_id, vault) })
            .map_err(|_| Error::DecryptionFailed)?,
    );
    VaultState::decode(&plain)
}

/// Kontratta saklanan commitment.
pub fn state_hash(sealed: &[u8]) -> [u8; 32] {
    Keccak256::digest(sealed).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(id: u32, base: u128, quote: u128) -> Pool {
        Pool { pool_id: id, base_token: [id as u8; 20], reserves: Reserves { base, quote } }
    }

    #[test]
    fn seal_unseal_roundtrip_and_binding() {
        let key = EnclaveKey::generate();
        let mut st = VaultState { batch_nonce: 42, pools: vec![] };
        st.insert_pool(pool(9, 7, u128::MAX)).unwrap();
        st.insert_pool(pool(2, 1, 1)).unwrap();
        assert_eq!(st.pools[0].pool_id, 2);

        let sealed = seal(&key, &st, 10143, &[1; 20]).unwrap();
        assert_eq!(unseal(&key, &sealed, 10143, &[1; 20]).unwrap(), st);
        assert_eq!(unseal(&key, &sealed, 10143, &[2; 20]), Err(Error::DecryptionFailed));
        assert_eq!(unseal(&key, &sealed, 1, &[1; 20]), Err(Error::DecryptionFailed));
        assert_eq!(
            unseal(&EnclaveKey::generate(), &sealed, 10143, &[1; 20]),
            Err(Error::DecryptionFailed)
        );
    }

    #[test]
    fn resealing_same_state_looks_different() {
        let key = EnclaveKey::generate();
        let mut st = VaultState::default();
        st.insert_pool(pool(1, 5, 5)).unwrap();
        let a = seal(&key, &st, 1, &[0; 20]).unwrap();
        let b = seal(&key, &st, 1, &[0; 20]).unwrap();
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn rejects_duplicate_and_empty_pools() {
        let mut st = VaultState::default();
        st.insert_pool(pool(1, 5, 5)).unwrap();
        assert_eq!(st.insert_pool(pool(1, 5, 5)), Err(Error::DuplicatePool(1)));
        assert_eq!(st.insert_pool(pool(2, 0, 5)), Err(Error::EmptyPool));
    }
}
