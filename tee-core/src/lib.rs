//! Dark Pool DEX — TEE çekirdeği (Faz 1).
//!
//! Bu crate enclave içinde çalışan saf mantığı içerir: ağ, dosya, saat ve TEE API yok.
//! Zaman, anahtar seed'i ve attestation dışarıdan (`tee-attest` wrapper'ından) gelir.
//! - `keys`     : enclave secp256k1 anahtarı, Ethereum adresi, ecrecover uyumlu imza
//! - `ecies`    : secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM (DSX-ECIES-v1)
//! - `order`    : sabit boyutlu emir düz metni (uzunluk sızıntısı yok)
//! - `note`     : shielded pool notları, circomlib uyumlu Poseidon
//! - `clearing` : FM-AMM tek fiyatlı batch clearing
//! - `state`    : tüm havuzların şifreli (sealed) zincir üstü vault durumu
//! - `digest`   : Solidity `keccak256(abi.encodePacked(..))` ile birebir settlement özeti
//! - `timelock` : drand quicknet tlock; batch sonuç anahtarı 7 gün sonra herkes için açılır
//! - `batch`    : uçtan uca batch işleme (çöz -> fiyatla -> şifrele -> imzala)
//! - `reveal`   : kilit açıldıktan sonra özet/sonuç çözme (istemci + indexer tarafı)

pub mod batch;
pub mod clearing;
pub mod digest;
pub mod ecies;
pub mod error;
pub mod keys;
pub mod note;
pub mod order;
pub mod reveal;
pub mod state;
pub mod timelock;

pub use error::Error;
