use k256::{
    ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey},
    elliptic_curve::sec1::ToEncodedPoint,
    PublicKey, SecretKey,
};
use rand_core::OsRng;
use sha3::{Digest, Keccak256};

use crate::{ecies, Error};

/// Enclave'in kimlik + şifre çözme anahtarı.
///
/// Tek bir secp256k1 anahtarı iki iş görür:
/// 1. Kullanıcılar emirlerini bu public key'e ECIES ile şifreler.
/// 2. Settlement özetleri bu anahtarla imzalanır; Monad kontratı `ecrecover`
///    (3000 gas) ile doğrular.
///
/// Anahtar enclave dışına asla çıkmaz. Kalıcılık (restart sonrası aynı anahtar)
/// Marlin/Phala KMS ile, ölçüm (PCR) bağlı türetme üzerinden sağlanacak.
pub struct EnclaveKey {
    secret: SecretKey,
}

impl EnclaveKey {
    pub fn generate() -> Self {
        Self { secret: SecretKey::random(&mut OsRng) }
    }

    /// TEE wrapper'ının verdiği 32 baytlık seed'den (KMS / sealed dosya) anahtar türetir.
    /// Aynı seed her zaman aynı anahtarı verir; seed'in kendisi imza anahtarı olarak
    /// kullanılmaz: `HKDF-SHA256(seed, "darkpool/enclave-key/v1" || ctr)`, geçerli
    /// skaler çıkana kadar sayaç artırılır (pratikte ilk denemede).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, seed);
        for ctr in 0u8..=255 {
            let mut okm = zeroize::Zeroizing::new([0u8; 32]);
            let mut info = b"darkpool/enclave-key/v1".to_vec();
            info.push(ctr);
            hk.expand(&info, okm.as_mut()).expect("valid length");
            if let Ok(secret) = SecretKey::from_slice(okm.as_ref()) {
                return Self { secret };
            }
        }
        unreachable!("256 ardışık geçersiz skaler olasılığı ~2^-32000")
    }

    /// Ham secp256k1 gizli anahtarından yükler (test vektörleri için).
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, Error> {
        SecretKey::from_slice(bytes)
            .map(|secret| Self { secret })
            .map_err(|_| Error::InvalidSecretKey)
    }

    pub fn public_key(&self) -> PublicKey {
        self.secret.public_key()
    }

    pub fn public_key_compressed(&self) -> [u8; 33] {
        compressed(&self.public_key())
    }

    pub fn eth_address(&self) -> [u8; 20] {
        eth_address(&self.public_key())
    }

    /// Attestation'a gömülen 64 bayt `x || y`. Kontrat adresi
    /// `address(uint160(uint256(keccak256(pubkey64))))` ile türetir; TDX report_data (64 bayt)
    /// alanına da birebir sığar.
    pub fn public_key_xy(&self) -> [u8; 64] {
        let point = self.public_key().to_encoded_point(false);
        let mut out = [0u8; 64];
        out.copy_from_slice(&point.as_bytes()[1..]);
        out
    }

    pub fn decrypt(&self, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
        ecies::decrypt(&self.secret, blob, aad)
    }

    /// Ham 32 baytlık özeti imzalar. Çıktı `r || s || v` (v ∈ {27, 28}),
    /// Solidity `ecrecover(digest, v, r, s)` ile doğrudan uyumlu. s low-S'dir.
    pub fn sign_digest(&self, digest: &[u8; 32]) -> Result<[u8; 65], Error> {
        let signing_key = SigningKey::from(&self.secret);
        let (sig, recid) = signing_key
            .sign_prehash_recoverable(digest)
            .map_err(|_| Error::SigningFailed)?;
        let (sig, recid) = match sig.normalize_s() {
            Some(low) => (low, RecoveryId::new(!recid.is_y_odd(), recid.is_x_reduced())),
            None => (sig, recid),
        };
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.to_bytes());
        out[64] = 27 + recid.to_byte();
        Ok(out)
    }

    /// Faz 1 durum mühürleme anahtarı gibi alt anahtarlar için kök materyal.
    pub(crate) fn secret_bytes(&self) -> zeroize::Zeroizing<[u8; 32]> {
        zeroize::Zeroizing::new(self.secret.to_bytes().into())
    }
}

pub fn compressed(pk: &PublicKey) -> [u8; 33] {
    let point = pk.to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(point.as_bytes());
    out
}

pub fn eth_address(pk: &PublicKey) -> [u8; 20] {
    let point = pk.to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

/// `ecrecover` eşdeğeri; testlerde ve relayer tarafında doğrulama için.
pub fn recover_address(digest: &[u8; 32], sig: &[u8; 65]) -> Result<[u8; 20], Error> {
    let signature = Signature::from_slice(&sig[..64]).map_err(|_| Error::SigningFailed)?;
    let v = sig[64].checked_sub(27).ok_or(Error::SigningFailed)?;
    let recid = RecoveryId::from_byte(v).ok_or(Error::SigningFailed)?;
    let vk = VerifyingKey::recover_from_prehash(digest, &signature, recid)
        .map_err(|_| Error::SigningFailed)?;
    Ok(eth_address(&PublicKey::from(vk)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_address_vector() {
        // secret = 1 -> generator noktası; adresi iyi bilinen bir vektördür.
        let mut sk = [0u8; 32];
        sk[31] = 1;
        let key = EnclaveKey::from_bytes(&sk).unwrap();
        assert_eq!(
            hex::encode(key.eth_address()),
            "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn seed_derivation_is_deterministic() {
        let a = EnclaveKey::from_seed(&[7; 32]);
        let b = EnclaveKey::from_seed(&[7; 32]);
        let c = EnclaveKey::from_seed(&[8; 32]);
        assert_eq!(a.eth_address(), b.eth_address());
        assert_ne!(a.eth_address(), c.eth_address());
        let xy = a.public_key_xy();
        assert_eq!(&Keccak256::digest(xy)[12..], &a.eth_address());
    }

    #[test]
    fn signature_recovers_to_enclave_address_with_low_s() {
        let key = EnclaveKey::generate();
        for i in 0..32u8 {
            let digest: [u8; 32] = Keccak256::digest([i]).into();
            let sig = key.sign_digest(&digest).unwrap();
            assert_eq!(recover_address(&digest, &sig).unwrap(), key.eth_address());
            let s = Signature::from_slice(&sig[..64]).unwrap();
            assert!(s.normalize_s().is_none(), "s must be low");
        }
    }
}
