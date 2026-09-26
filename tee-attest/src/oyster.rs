//! Marlin Oyster CVM sağlayıcısı (AWS Nitro tabanlı).
//!
//! Anahtar: CVM içindeki KMS derive sunucusundan (`127.0.0.1:1100`) alınır. KMS anahtarı
//! enclave'in **image id**'sine bağlıdır: aynı docker-compose → aynı anahtar (restart'ta
//! sealed state okunabilir kalır), farklı kod → farklı anahtar. Operatör anahtarı göremez.
//!
//! Bağlama (herkes doğrulayabilir, operatöre güvenmeden):
//!   oyster-cvm kms-derive --image-id <ID> --path <KMS_PATH> --key-type secp256k1/address
//! çıktısı, zincirdeki registry'de kayıtlı enclave adresine EŞİT olmalı. Çalışan makinenin
//! gerçekten o image'ı çalıştırdığı ise `oyster-cvm verify --enclave-ip <IP> --image-id <ID>`
//! ile doğrulanır. Bu yüzden anahtar HKDF'den geçirilmeden doğrudan kullanılır
//! (`key_is_direct`).
//!
//! Saat: Nitro enclave saati hipervizörün kvm-clock'u; host geri alamaz (kilit turu yine
//! drand'dan ileri tarihe hesaplanır, geri alınmış saat yalnızca kilidi uzatır).

use std::time::{SystemTime, UNIX_EPOCH};

use zeroize::Zeroizing;

use crate::{Attestation, TeeError, TeeProvider};

/// KMS türetme yolu. Değiştirmek = yeni enclave anahtarı (registry'de yeniden kayıt).
pub const DEFAULT_KMS_PATH: &str = "darkpool-enclave-v1";

pub struct Oyster {
    derive_url: String,
    attestation_url: String,
}

impl Oyster {
    pub fn new(kms_path: &str) -> Self {
        Self {
            derive_url: format!("http://127.0.0.1:1100/derive/secp256k1?path={kms_path}"),
            attestation_url: "http://127.0.0.1:1300/attestation/raw".into(),
        }
    }

    fn get_bytes(url: &str) -> Result<Vec<u8>, String> {
        let mut resp = ureq::get(url).call().map_err(|e| format!("{url}: {e}"))?;
        resp.body_mut().with_config().limit(64 * 1024).read_to_vec().map_err(|e| format!("{url}: {e}"))
    }
}

impl TeeProvider for Oyster {
    fn name(&self) -> &'static str {
        "oyster"
    }

    fn is_hardware_backed(&self) -> bool {
        true
    }

    fn key_is_direct(&self) -> bool {
        true
    }

    fn key_seed(&self) -> Result<Zeroizing<[u8; 32]>, TeeError> {
        let raw = Zeroizing::new(Self::get_bytes(&self.derive_url).map_err(TeeError::KeySeed)?);
        let key: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| TeeError::KeySeed(format!("KMS returned {} bytes, expected 32", raw.len())))?;
        Ok(Zeroizing::new(key))
    }

    fn trusted_unix_time(&self) -> Result<u64, TeeError> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .map_err(|e| TeeError::Time(e.to_string()))
    }

    /// Oyster'ın attestation sunucusu kendi anahtarını belgeler; enclave anahtarımız ise KMS
    /// üzerinden image id'ye bağlıdır (modül belgesine bakın). Belge, image ölçümlerini (PCR)
    /// içeren ham Nitro COSE_Sign1'dir.
    fn attest(&self, _report_data: &[u8; 64]) -> Result<Attestation, TeeError> {
        let document = Self::get_bytes(&self.attestation_url).map_err(TeeError::Attestation)?;
        Ok(Attestation { provider: "oyster", format: "nitro-cose-sign1", document })
    }
}
