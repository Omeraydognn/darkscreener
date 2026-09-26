//! DSX-ECIES-v1
//!
//! ```text
//! blob   = 0x01 || eph_pub (33, compressed) || nonce (12) || aes_gcm_ct || tag (16)
//! shared = ECDH(eph_sk, recipient_pk).x                     (32 byte)
//! key    = HKDF-SHA256(ikm = shared,
//!                      salt = eph_pub || recipient_pub,      (33 + 33 byte)
//!                      info = "darkpool/ecies/v1")           -> 32 byte
//! ct     = AES-256-GCM(key, nonce, plaintext, aad)
//! ```
//! Tarayıcı tarafı `@noble/curves/secp256k1` + `@noble/hashes/hkdf` + WebCrypto
//! AES-GCM ile birebir aynı şekilde uygulanacak (Faz 5).
//! AAD, ciphertext'i zincire/havuza bağlar; başka havuza replay edilemez.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use k256::{ecdh::diffie_hellman, PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{keys::compressed, Error};

pub const VERSION: u8 = 0x01;
pub const OVERHEAD: usize = 1 + 33 + 12 + 16;
const INFO: &[u8] = b"darkpool/ecies/v1";

fn derive_key(shared_x: &[u8], eph_pub: &[u8; 33], recipient_pub: &[u8; 33]) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 66];
    salt[..33].copy_from_slice(eph_pub);
    salt[33..].copy_from_slice(recipient_pub);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared_x);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(INFO, okm.as_mut()).expect("32 bytes is a valid HKDF output length");
    okm
}

pub fn encrypt(recipient: &PublicKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    let eph = SecretKey::random(&mut OsRng);
    let eph_pub = compressed(&eph.public_key());
    let recipient_pub = compressed(recipient);
    let shared = diffie_hellman(eph.to_nonzero_scalar(), recipient.as_affine());
    let key = derive_key(shared.raw_secret_bytes(), &eph_pub, &recipient_pub);

    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| Error::EncryptionFailed)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| Error::EncryptionFailed)?;

    let mut out = Vec::with_capacity(OVERHEAD + plaintext.len());
    out.push(VERSION);
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(secret: &SecretKey, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    if blob.len() < OVERHEAD {
        return Err(Error::MalformedCiphertext);
    }
    if blob[0] != VERSION {
        return Err(Error::UnsupportedVersion(blob[0]));
    }
    let eph_pub: [u8; 33] = blob[1..34].try_into().unwrap();
    let nonce = &blob[34..46];
    let ct = &blob[46..];

    let eph = PublicKey::from_sec1_bytes(&eph_pub).map_err(|_| Error::InvalidPublicKey)?;
    let recipient_pub = compressed(&secret.public_key());
    let shared = diffie_hellman(secret.to_nonzero_scalar(), eph.as_affine());
    let key = derive_key(shared.raw_secret_bytes(), &eph_pub, &recipient_pub);

    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| Error::DecryptionFailed)?;
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| Error::DecryptionFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let sk = SecretKey::random(&mut OsRng);
        let blob = encrypt(&sk.public_key(), b"buy 100 USDC", b"ctx").unwrap();
        assert_eq!(blob.len(), OVERHEAD + 12);
        assert_eq!(decrypt(&sk, &blob, b"ctx").unwrap(), b"buy 100 USDC");
    }

    #[test]
    fn wrong_aad_wrong_key_and_tamper_are_rejected() {
        let sk = SecretKey::random(&mut OsRng);
        let other = SecretKey::random(&mut OsRng);
        let blob = encrypt(&sk.public_key(), b"payload", b"pool-A").unwrap();

        assert_eq!(decrypt(&sk, &blob, b"pool-B"), Err(Error::DecryptionFailed));
        assert_eq!(decrypt(&other, &blob, b"pool-A"), Err(Error::DecryptionFailed));

        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(decrypt(&sk, &tampered, b"pool-A"), Err(Error::DecryptionFailed));

        let mut bad_version = blob;
        bad_version[0] = 9;
        assert_eq!(decrypt(&sk, &bad_version, b"pool-A"), Err(Error::UnsupportedVersion(9)));
    }

    #[test]
    fn same_plaintext_encrypts_differently() {
        let sk = SecretKey::random(&mut OsRng);
        let a = encrypt(&sk.public_key(), b"x", b"").unwrap();
        let b = encrypt(&sk.public_key(), b"x", b"").unwrap();
        assert_ne!(a, b);
    }
}
