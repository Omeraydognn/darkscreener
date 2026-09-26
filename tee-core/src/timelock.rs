//! drand quicknet time-lock şifreleme (tlock, age formatı).
//!
//! Her batch'in sonuç anahtarı `K_b`, settlement anından 7 gün sonraki drand
//! turuna şifrelenir. O tur yayınlandığında drand ağının BLS imzası anahtarın
//! kendisi olur: herkes (kullanıcı, indexer, grafik servisi) `K_b`'yi açabilir.
//! TEE çökse bile kilit açılır. Kilit açılmadan önce ise kimse (TEE operatörü
//! dahil, çünkü `K_b` enclave dışına düz çıkmaz) sonuçları göremez.
//!
//! Format drand'in Go `tlock` ve `tlock-js` kütüphaneleriyle uyumludur (Faz 5).

use crate::Error;

/// quicknet zincir hash'i: https://api.drand.sh/52db9ba7.../info
pub const QUICKNET_CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
/// quicknet grup public key'i (G2, imzalar G1 üzerinde, RFC 9380)
pub const QUICKNET_PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
pub const QUICKNET_GENESIS: u64 = 1_692_803_367;
pub const QUICKNET_PERIOD: u64 = 3;

/// Settlement'tan açılışa kadar geçen süre.
pub const LOCK_SECONDS: u64 = 7 * 24 * 60 * 60;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("static hex constant"))
        .collect()
}

/// `unix_ts` anında (veya hemen sonrasında) yayınlanan ilk tur.
/// Faz 2 kontratı aynı formülle `unlockRound >= roundAt(settleTs + LOCK_SECONDS)` kontrol eder.
pub fn round_at(unix_ts: u64) -> u64 {
    if unix_ts <= QUICKNET_GENESIS {
        return 1;
    }
    (unix_ts - QUICKNET_GENESIS).div_ceil(QUICKNET_PERIOD) + 1
}

/// Turun yayınlanacağı unix zamanı.
pub fn round_time(round: u64) -> u64 {
    QUICKNET_GENESIS + (round.saturating_sub(1)) * QUICKNET_PERIOD
}

pub fn lock(secret: &[u8], round: u64) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    tlock_age::encrypt(
        &mut out,
        secret,
        &unhex(QUICKNET_CHAIN_HASH),
        &unhex(QUICKNET_PUBLIC_KEY),
        round,
    )
    .map_err(|_| Error::TimelockFailed)?;
    Ok(out)
}

/// Kapsülün hangi tura kilitlendiğini okur (ağ erişimi yok).
pub fn capsule_round(capsule: &[u8]) -> Result<u64, Error> {
    tlock_age::decrypt_header(capsule)
        .map(|h| h.round())
        .map_err(|_| Error::TimelockOpenFailed)
}

/// `beacon_signature` = drand'in o tur için yayınladığı imza
/// (`GET https://api.drand.sh/<chain>/public/<round>` -> `.signature`).
///
/// Not: `tlock` 0.0.10 yanlış tur imzasında hata döndürmek yerine `assert_eq!` ile
/// panic ediyor (ibe.rs). Sahte/yanlış bir imza indexer'ı çökertmesin diye
/// `catch_unwind` ile sarıyoruz; bu yüzden profillerde `panic = "abort"` kullanılmamalı.
pub fn unlock(capsule: &[u8], beacon_signature: &[u8]) -> Result<Vec<u8>, Error> {
    let chain_hash = unhex(QUICKNET_CHAIN_HASH);
    std::panic::catch_unwind(|| {
        let mut out = Vec::new();
        tlock_age::decrypt(&mut out, capsule, &chain_hash, beacon_signature).map(|_| out)
    })
    .map_err(|_| Error::TimelockOpenFailed)?
    .map_err(|_| Error::TimelockOpenFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// drand quicknet'in gerçek round 1000 imzası (herkese açık, değişmez).
    const ROUND_1000_SIG: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

    #[test]
    fn lock_unlock_with_real_quicknet_beacon() {
        let key = [0x42u8; 32];
        let capsule = lock(&key, 1000).unwrap();
        assert_eq!(capsule_round(&capsule).unwrap(), 1000);
        assert_eq!(unlock(&capsule, &unhex(ROUND_1000_SIG)).unwrap(), key);
    }

    #[test]
    fn wrong_round_signature_does_not_open() {
        // 1001'e kilitli kapsül, 1000'in imzasıyla açılmamalı.
        let capsule = lock(&[1u8; 32], 1001).unwrap();
        assert_eq!(
            unlock(&capsule, &unhex(ROUND_1000_SIG)),
            Err(Error::TimelockOpenFailed)
        );
    }

    #[test]
    fn round_math() {
        assert_eq!(round_at(QUICKNET_GENESIS), 1);
        assert_eq!(round_at(QUICKNET_GENESIS + 3), 2);
        assert_eq!(round_at(QUICKNET_GENESIS + 4), 3);
        for r in [1u64, 2, 1000, 50_000_000] {
            assert_eq!(round_at(round_time(r)), r);
        }
        let now = 1_790_000_000;
        assert!(round_time(round_at(now + LOCK_SECONDS)) >= now + LOCK_SECONDS);
    }
}
