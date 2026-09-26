//! TEE sağlayıcı katmanı (wrapper).
//!
//! Çekirdek (`dark-tee-core`) bu crate'i bilmez; sunucu ikisini birleştirir.
//! Sağlayıcı değiştirmek = bu trait'in yeni bir implementasyonunu yazmak.
//! Çekirdekten TEE'ye özgü tek ihtiyaç üç şeydir:
//!
//! | İhtiyaç            | Neden                                                            |
//! |--------------------|------------------------------------------------------------------|
//! | `key_seed`         | Restart sonrası aynı enclave anahtarı (KMS / sealing)            |
//! | `trusted_unix_time`| 7 günlük kilit turunu enclave belirler, girdiden almaz           |
//! | `attest`           | Enclave public key'ini donanım ölçümüne (PCR/MRTD) bağlar         |
//!
//! Implementasyonlar: `LocalDev` (geliştirme, donanımsız), `Oyster` (Marlin Oyster CVM).
//! AWS Nitro (doğrudan) ve Phala dstack (Intel TDX) yedek olarak aynı trait ile eklenir.

mod local;
mod oyster;

pub use local::LocalDev;
pub use oyster::{Oyster, DEFAULT_KMS_PATH};

use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum TeeError {
    #[error("key seed unavailable: {0}")]
    KeySeed(String),
    #[error("trusted time unavailable: {0}")]
    Time(String),
    #[error("attestation failed: {0}")]
    Attestation(String),
}

/// Sağlayıcının ürettiği ham attestation belgesi. Formatı sağlayıcıya özgüdür;
/// doğrulama zincir üstünde (Faz 2) ya da istemcide yapılır.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    /// ör. "local", "oyster", "nitro", "phala"
    pub provider: &'static str,
    /// ör. "none", "nitro-cose-sign1", "tdx-quote-v4"
    pub format: &'static str,
    pub document: Vec<u8>,
}

pub trait TeeProvider: Send + Sync {
    fn name(&self) -> &'static str;

    /// `false` ise çıktılar hiçbir donanım garantisi taşımaz (yalnızca geliştirme).
    fn is_hardware_backed(&self) -> bool;

    /// `true` ise `key_seed` doğrudan enclave'in secp256k1 gizli anahtarıdır (ör. Oyster KMS:
    /// dışarıdan image id ile doğrulanabilsin diye). `false` ise anahtar seed'den HKDF ile türetilir.
    fn key_is_direct(&self) -> bool {
        false
    }

    /// Enclave anahtarının türetildiği 32 baytlık gizli seed.
    fn key_seed(&self) -> Result<Zeroizing<[u8; 32]>, TeeError>;

    /// Kilit turunun hesaplandığı saat. Host tarafından geri alınamamalı.
    fn trusted_unix_time(&self) -> Result<u64, TeeError>;

    /// `report_data` = enclave public key'i (64 bayt `x || y`). Belge bunu
    /// donanım ölçümüyle birlikte imzalar.
    fn attest(&self, report_data: &[u8; 64]) -> Result<Attestation, TeeError>;
}
