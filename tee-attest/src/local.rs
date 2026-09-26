//! Yerel geliştirme sağlayıcısı: donanım yok, attestation yok.
//!
//! Kriptografi ve batch matematiği gerçek; sadece "bu kod gerçekten enclave'de mi
//! çalışıyor" garantisi yok. Sunucu bu sağlayıcıyla açılırken yüksek sesle uyarır
//! ve `/attestation` yanıtında `hardware_backed: false` döner.

use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::{Attestation, TeeError, TeeProvider};

pub struct LocalDev {
    /// Verilirse seed bu dosyada saklanır; container restart'larında aynı anahtar
    /// ve dolayısıyla okunabilir sealed state korunur. Yoksa her açılışta yeni anahtar.
    seed_path: Option<PathBuf>,
    ephemeral: Zeroizing<[u8; 32]>,
    /// YALNIZCA yerel geliştirme: saat, bu RPC'deki son bloğun zamanından okunur. Zamanı
    /// geriye alınmış bir anvil zincirinde gerçek drand turlarıyla gecikmeli veri üretmek için.
    clock_rpc: Option<String>,
}

impl LocalDev {
    pub fn new(seed_path: Option<PathBuf>) -> Self {
        let mut ephemeral = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(ephemeral.as_mut());
        Self { seed_path, ephemeral, clock_rpc: None }
    }

    /// Saati yerel geliştirme zincirinden al (bkz. `clock_rpc`).
    pub fn with_chain_clock(mut self, rpc_url: String) -> Self {
        self.clock_rpc = Some(rpc_url);
        self
    }

    fn chain_time(rpc: &str) -> Result<u64, TeeError> {
        let err = |e: String| TeeError::Time(format!("{rpc}: {e}"));
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": ["latest", false]
        });
        let resp: serde_json::Value = ureq::post(rpc)
            .send_json(&body)
            .map_err(|e| err(e.to_string()))?
            .body_mut()
            .read_json()
            .map_err(|e| err(e.to_string()))?;
        let ts = resp["result"]["timestamp"].as_str().ok_or_else(|| err("no timestamp".into()))?;
        u64::from_str_radix(ts.trim_start_matches("0x"), 16).map_err(|e| err(e.to_string()))
    }

    fn load_or_create(path: &PathBuf) -> Result<Zeroizing<[u8; 32]>, TeeError> {
        let err = |e: std::io::Error| TeeError::KeySeed(format!("{}: {e}", path.display()));
        match fs::read(path) {
            Ok(bytes) => {
                let seed: [u8; 32] = bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| TeeError::KeySeed(format!("{}: expected 32 bytes", path.display())))?;
                Ok(Zeroizing::new(seed))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut seed = Zeroizing::new([0u8; 32]);
                OsRng.fill_bytes(seed.as_mut());
                if let Some(dir) = path.parent() {
                    fs::create_dir_all(dir).map_err(err)?;
                }
                let mut opts = fs::OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
                opts.open(path).and_then(|mut f| f.write_all(seed.as_ref())).map_err(err)?;
                Ok(seed)
            }
            Err(e) => Err(err(e)),
        }
    }
}

impl TeeProvider for LocalDev {
    fn name(&self) -> &'static str {
        "local"
    }

    fn is_hardware_backed(&self) -> bool {
        false
    }

    fn key_seed(&self) -> Result<Zeroizing<[u8; 32]>, TeeError> {
        match &self.seed_path {
            Some(path) => Self::load_or_create(path),
            None => Ok(self.ephemeral.clone()),
        }
    }

    fn trusted_unix_time(&self) -> Result<u64, TeeError> {
        if let Some(rpc) = &self.clock_rpc {
            return Self::chain_time(rpc);
        }
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .map_err(|e| TeeError::Time(e.to_string()))
    }

    fn attest(&self, _report_data: &[u8; 64]) -> Result<Attestation, TeeError> {
        Ok(Attestation { provider: "local", format: "none", document: Vec::new() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_file_persists_across_instances() {
        let dir = std::env::temp_dir().join(format!("darkpool-seed-test-{}", std::process::id()));
        let path = dir.join("seed.bin");
        let _ = fs::remove_file(&path);

        let a = LocalDev::new(Some(path.clone())).key_seed().unwrap();
        let b = LocalDev::new(Some(path.clone())).key_seed().unwrap();
        assert_eq!(*a, *b);

        fs::write(&path, [1u8; 5]).unwrap();
        assert!(LocalDev::new(Some(path.clone())).key_seed().is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ephemeral_seed_is_stable_within_instance_only() {
        let p = LocalDev::new(None);
        assert_eq!(*p.key_seed().unwrap(), *p.key_seed().unwrap());
        assert_ne!(*p.key_seed().unwrap(), *LocalDev::new(None).key_seed().unwrap());
    }
}
