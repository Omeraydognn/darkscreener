//! Emir düz metni (v2, shielded). Sabit 128 bayt: her ciphertext aynı uzunlukta olduğu
//! için zincirde tutar/yön hakkında uzunluk üzerinden bilgi sızmaz.
//!
//! ```text
//! 0        version = 2
//! 1        side    (0 = Buy: quote verir base alır, 1 = Sell: base verir quote alır)
//! 2..6     pool_id         u32 big-endian (hangi proje tokenı; zincirde görünmez)
//! 6..22    amount_in       u128 big-endian
//! 22..55   recipient_pub   secp256k1 compressed (sonuç bu anahtara şifrelenir)
//! 55..87   spend_blinding  alan elemanı; zincirdeki spendCommitment'ın açılışı
//! 87..119  owner           alan elemanı; çıktı notunun sahibi (Poseidon1(spendKey))
//! 119..128 sıfır padding
//! ```
//!
//! Kontrat emri, kullanıcının ZK kanıtıyla harcadığı notun `spendCommitment =
//! Poseidon3(token, amount_in, spend_blinding)` değeriyle kaydeder. Enclave açılışı
//! buradan okur ve commitment'ı yeniden hesaplayarak fonlamayı doğrular.

use k256::PublicKey;
use sha3::{Digest, Keccak256};

use crate::{
    clearing::Side,
    keys::compressed,
    note::{is_canonical, Field},
    Error,
};

pub const ORDER_LEN: usize = 128;
pub const ORDER_VERSION: u8 = 2;
/// Kontratın beklediği ciphertext uzunluğu (ECIES ek yükü + emir).
pub const CIPHERTEXT_LEN: usize = crate::ecies::OVERHEAD + ORDER_LEN;
const AAD_TAG: &[u8] = b"darkpool/order/v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    pub side: Side,
    pub pool_id: u32,
    pub amount_in: u128,
    pub recipient: PublicKey,
    pub spend_blinding: Field,
    pub owner: Field,
}

impl Order {
    pub fn encode(&self) -> [u8; ORDER_LEN] {
        let mut out = [0u8; ORDER_LEN];
        out[0] = ORDER_VERSION;
        out[1] = match self.side {
            Side::Buy => 0,
            Side::Sell => 1,
        };
        out[2..6].copy_from_slice(&self.pool_id.to_be_bytes());
        out[6..22].copy_from_slice(&self.amount_in.to_be_bytes());
        out[22..55].copy_from_slice(&compressed(&self.recipient));
        out[55..87].copy_from_slice(&self.spend_blinding);
        out[87..119].copy_from_slice(&self.owner);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != ORDER_LEN {
            return Err(Error::MalformedOrder("length"));
        }
        if bytes[0] != ORDER_VERSION {
            return Err(Error::MalformedOrder("version"));
        }
        let side = match bytes[1] {
            0 => Side::Buy,
            1 => Side::Sell,
            _ => return Err(Error::MalformedOrder("side")),
        };
        let pool_id = u32::from_be_bytes(bytes[2..6].try_into().unwrap());
        let amount_in = u128::from_be_bytes(bytes[6..22].try_into().unwrap());
        if amount_in == 0 {
            return Err(Error::MalformedOrder("zero amount"));
        }
        let recipient = PublicKey::from_sec1_bytes(&bytes[22..55])
            .map_err(|_| Error::MalformedOrder("recipient"))?;
        let spend_blinding: Field = bytes[55..87].try_into().unwrap();
        let owner: Field = bytes[87..119].try_into().unwrap();
        if !is_canonical(&spend_blinding) || !is_canonical(&owner) {
            return Err(Error::MalformedOrder("field"));
        }
        if bytes[119..].iter().any(|b| *b != 0) {
            return Err(Error::MalformedOrder("padding"));
        }
        Ok(Self { side, pool_id, amount_in, recipient, spend_blinding, owner })
    }
}

// ---------------------------------------------------------------- kilitli lot satışı (v3)

/// Kilidi henüz açılmamış bir alımın ("lot") yüzdesel satışı. Kullanıcı lotun miktarını
/// bilmez (7 gün kilitli); miktarı yalnızca enclave, alımda bıraktığı `LotMemo`'dan okur.
///
/// ```text
/// 0 version = 3 | 1 side = 1 | 2..6 pool_id | 6..8 pct_bps (1..=10000)
/// 8..40  lot_order_id   satılan alım emrinin kimliği (zincirde spendCommitment alanında)
/// 40..72 auth           o alım emrindeki spend_blinding (yalnızca emir sahibi bilir)
/// 72..128 sıfır padding
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotSell {
    pub pool_id: u32,
    pub pct_bps: u16,
    pub lot_order_id: [u8; 32],
    pub auth: Field,
}

pub const LOT_SELL_VERSION: u8 = 3;

impl LotSell {
    pub fn encode(&self) -> [u8; ORDER_LEN] {
        let mut out = [0u8; ORDER_LEN];
        out[0] = LOT_SELL_VERSION;
        out[1] = 1;
        out[2..6].copy_from_slice(&self.pool_id.to_be_bytes());
        out[6..8].copy_from_slice(&self.pct_bps.to_be_bytes());
        out[8..40].copy_from_slice(&self.lot_order_id);
        out[40..72].copy_from_slice(&self.auth);
        out
    }

    pub fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() != ORDER_LEN || b[0] != LOT_SELL_VERSION {
            return Err(Error::MalformedOrder("version"));
        }
        if b[1] != 1 {
            return Err(Error::MalformedOrder("side"));
        }
        let pct_bps = u16::from_be_bytes(b[6..8].try_into().unwrap());
        if pct_bps == 0 || pct_bps > 10_000 {
            return Err(Error::MalformedOrder("pct"));
        }
        let auth: Field = b[40..72].try_into().unwrap();
        if !is_canonical(&auth) {
            return Err(Error::MalformedOrder("field"));
        }
        if b[72..].iter().any(|x| *x != 0) {
            return Err(Error::MalformedOrder("padding"));
        }
        Ok(Self {
            pool_id: u32::from_be_bytes(b[2..6].try_into().unwrap()),
            pct_bps,
            lot_order_id: b[8..40].try_into().unwrap(),
            auth,
        })
    }
}

/// Şifre çözülmüş emir gövdesi: not harcayan normal emir ya da kilitli lot satışı.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plain {
    Order(Order),
    LotSell(LotSell),
}

pub fn decode_plain(b: &[u8]) -> Result<Plain, Error> {
    match b.first() {
        Some(&ORDER_VERSION) => Order::decode(b).map(Plain::Order),
        Some(&LOT_SELL_VERSION) => LotSell::decode(b).map(Plain::LotSell),
        _ => Err(Error::MalformedOrder("version")),
    }
}

/// Emir ciphertext'inin AAD'si: zincir + vault kontratı. Havuz (token) bilinçli olarak
/// AAD'de YOK; o bilgi şifreli gövdenin içinde. Başka ağ/vault'a replay'i engeller.
pub fn order_aad(chain_id: u64, vault: &[u8; 20]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_TAG.len() + 32 + 20);
    aad.extend_from_slice(AAD_TAG);
    aad.extend_from_slice(&[0u8; 24]);
    aad.extend_from_slice(&chain_id.to_be_bytes());
    aad.extend_from_slice(vault);
    aad
}

/// Zincir üstünde emri tanımlayan kimlik = keccak256(ciphertext).
pub fn order_id(ciphertext: &[u8]) -> [u8; 32] {
    Keccak256::digest(ciphertext).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ecies, keys::EnclaveKey, note::random_field};
    use k256::SecretKey;
    use rand_core::OsRng;

    fn sample() -> Order {
        Order {
            side: Side::Buy,
            pool_id: 3,
            amount_in: 100_000_000, // 100 USDC (6 decimals)
            recipient: SecretKey::random(&mut OsRng).public_key(),
            spend_blinding: random_field(),
            owner: random_field(),
        }
    }

    #[test]
    fn lot_sell_matches_js_vector() {
        // sdk/test/crosslang.test.mjs ile aynı vektör
        let mut auth = [0u8; 32];
        auth[31] = 7;
        let l = LotSell { pool_id: 4, pct_bps: 5_000, lot_order_id: [9; 32], auth };
        assert_eq!(hex::encode(l.encode()), "0301000000041388090909090909090909090909090909090909090909090909090909090909090900000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(hex::encode(crate::reveal::remainder_id(&[9; 32])), "4ab812e6bf5cbeed1d99994683f12201e49a1b61734b689a4825dfe4877ba48c");
    }

    #[test]
    fn lot_sell_roundtrip_and_validation() {
        let l = LotSell { pool_id: 4, pct_bps: 5_000, lot_order_id: [9; 32], auth: random_field() };
        let b = l.encode();
        assert_eq!(decode_plain(&b).unwrap(), Plain::LotSell(l.clone()));
        let mut bad = b;
        bad[6..8].copy_from_slice(&10_001u16.to_be_bytes());
        assert_eq!(LotSell::decode(&bad), Err(Error::MalformedOrder("pct")));
        let mut bad = b;
        bad[100] = 1;
        assert_eq!(LotSell::decode(&bad), Err(Error::MalformedOrder("padding")));
        assert!(matches!(decode_plain(&sample().encode()).unwrap(), Plain::Order(_)));
    }

    #[test]
    fn encode_decode_roundtrip() {
        let o = sample();
        assert_eq!(Order::decode(&o.encode()).unwrap(), o);
    }

    #[test]
    fn rejects_bad_fields() {
        let mut b = sample().encode();
        b[1] = 7;
        assert_eq!(Order::decode(&b), Err(Error::MalformedOrder("side")));
        let mut b = sample().encode();
        b[127] = 1;
        assert_eq!(Order::decode(&b), Err(Error::MalformedOrder("padding")));
        let mut b = sample().encode();
        b[6..22].fill(0);
        assert_eq!(Order::decode(&b), Err(Error::MalformedOrder("zero amount")));
        let mut b = sample().encode();
        b[87..119].fill(0xff); // p'den büyük
        assert_eq!(Order::decode(&b), Err(Error::MalformedOrder("field")));
    }

    #[test]
    fn full_user_to_enclave_path_and_constant_size() {
        let enclave = EnclaveKey::generate();
        let aad = order_aad(10143, &[0xAA; 20]);
        let small = Order { amount_in: 1, ..sample() };
        let big = Order { amount_in: u128::MAX, side: Side::Sell, ..sample() };

        let c1 = ecies::encrypt(&enclave.public_key(), &small.encode(), &aad).unwrap();
        let c2 = ecies::encrypt(&enclave.public_key(), &big.encode(), &aad).unwrap();
        assert_eq!(c1.len(), CIPHERTEXT_LEN);
        assert_eq!(c1.len(), c2.len());

        let back = Order::decode(&enclave.decrypt(&c2, &aad).unwrap()).unwrap();
        assert_eq!(back, big);
    }
}
