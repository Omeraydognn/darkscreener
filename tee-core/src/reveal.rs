//! Batch çıktılarının formatları ve kilit açıldıktan sonra çözülmesi.
//!
//! Her batch için enclave rastgele bir `K_b` üretir ve bunu drand'e kilitler
//! (`timelock`). `K_b`'den iki anahtar türetilir:
//!
//! ```text
//! result_key  = HKDF-SHA256(K_b, info = "darkpool/result/v1")
//! summary_key = HKDF-SHA256(K_b, info = "darkpool/summary/v1")
//! ```
//!
//! - **Özet (ghost chart):** havuz başına fiyat, hacim ve batch sonrası rezervler,
//!   `summary_key` ile şifreli. 7 gün sonra herkes okur -> gecikmeli grafik, TWAP,
//!   alım/satım oranı, gecikmeli TVL. İçindeki tuz + rezervler, settlement'ta imzalanan
//!   `reserves_commitment`'ı açar: enclave ölse bile LP'ler kaçış modunda paylarını alır.
//! - **Emir sonucu:** yeni bir shielded notun açılışı; iki katman. Dış katman
//!   `result_key` (7 gün kilidi), iç katman kullanıcının kendi anahtarına ECIES. Kilit
//!   açılınca herkes dış katmanı soyar, ama miktarı sadece emir sahibi görür.
//!
//! Aynı fonksiyonlar Faz 5'te TypeScript'e birebir taşınacak.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use k256::SecretKey;
use rand_core::{OsRng, RngCore};
use ruint::aliases::U256;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::{
    ecies,
    note::{self, Field},
    timelock, Error,
};

pub const RESULT_PLAIN_LEN: usize = 112;
pub const SEALED_RESULT_LEN: usize = 12 + ecies::OVERHEAD + RESULT_PLAIN_LEN + 16;
const SUMMARY_VERSION: u8 = 2;
const SUMMARY_HEADER_LEN: usize = 1 + 8 + 32 + 4;
const SUMMARY_ENTRY_LEN: usize = 4 + 32 + 16 + 16 + 4 + 4 + 16 + 16;

fn derive(k_b: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(None, k_b);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(info, okm.as_mut()).expect("valid length");
    okm
}

pub fn result_key(k_b: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    derive(k_b, b"darkpool/result/v1")
}

pub fn summary_key(k_b: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    derive(k_b, b"darkpool/summary/v1")
}

pub(crate) fn aead_seal(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = Aes256Gcm::new_from_slice(key)
        .map_err(|_| Error::EncryptionFailed)?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| Error::EncryptionFailed)?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn aead_open(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    if sealed.len() < 12 + 16 {
        return Err(Error::MalformedCiphertext);
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| Error::DecryptionFailed)?
        .decrypt(Nonce::from_slice(&sealed[..12]), Payload { msg: &sealed[12..], aad })
        .map_err(|_| Error::DecryptionFailed)
}

// ---------------------------------------------------------------- emir sonucu

/// Kullanıcının 7 gün sonra göreceği sonuç: shielded pool'a eklenecek yeni notun açılışı.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderOutcome {
    pub pool_id: u32,
    pub out_token: [u8; 20],
    pub amount_out: u128,
    /// Notun rastgelesi (alan elemanı)
    pub blinding: Field,
    /// Notun sahibi = emirdeki `owner` (Poseidon1(spendKey))
    pub owner: Field,
}

impl OrderOutcome {
    /// ```text
    /// 0 version=2 | 1..5 pool_id | 5..25 out_token | 25..41 amount_out | 41..73 blinding | 73..105 owner | 105..112 pad
    /// ```
    pub fn encode(&self) -> [u8; RESULT_PLAIN_LEN] {
        let mut out = [0u8; RESULT_PLAIN_LEN];
        out[0] = 2;
        out[1..5].copy_from_slice(&self.pool_id.to_be_bytes());
        out[5..25].copy_from_slice(&self.out_token);
        out[25..41].copy_from_slice(&self.amount_out.to_be_bytes());
        out[41..73].copy_from_slice(&self.blinding);
        out[73..105].copy_from_slice(&self.owner);
        out
    }

    pub fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() != RESULT_PLAIN_LEN || b[0] != 2 || b[105..].iter().any(|x| *x != 0) {
            return Err(Error::MalformedCiphertext);
        }
        Ok(Self {
            pool_id: u32::from_be_bytes(b[1..5].try_into().unwrap()),
            out_token: b[5..25].try_into().unwrap(),
            amount_out: u128::from_be_bytes(b[25..41].try_into().unwrap()),
            blinding: b[41..73].try_into().unwrap(),
            owner: b[73..105].try_into().unwrap(),
        })
    }

    /// Zincire yazılan ve 7 gün sonra shielded ağaca eklenen not commitment'ı:
    /// `Poseidon3(token, amount, Poseidon2(owner, blinding))` — spend.circom'daki not.
    pub fn commitment(&self) -> Result<Field, Error> {
        note::note_commitment(&self.out_token, self.amount_out, &note::secret_hash(&self.owner, &self.blinding)?)
    }
}

// ---------------------------------------------------------------- lot notu (yalnızca enclave)

/// Kilidi açılmamış bir alımın ("lot") enclave'e özel kaydı. Kullanıcı lotun miktarını 7 gün
/// bilmez ama yüzdeyle satabilir: satış emrini işleyen enclave miktarı buradan okur.
/// `sealed_result`'ın SONUNA eklenir; anahtarı enclave'in gizli anahtarından türediği için
/// kilit açıldıktan sonra da (dış katman soyulunca bile) yalnızca enclave okuyabilir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotMemo {
    pub pool_id: u32,
    /// Lottaki base token miktarı
    pub amount: u128,
    /// Çıktı notlarının sahibi
    pub owner: Field,
    /// keccak256(alım emrindeki spend_blinding): satışta kullanıcı açılışı verir
    pub auth_hash: [u8; 32],
    /// Sonuçların şifreleneceği kullanıcı anahtarı
    pub recipient: k256::PublicKey,
}

pub const LOT_MEMO_PLAIN_LEN: usize = 4 + 16 + 32 + 32 + 33;
pub const LOT_MEMO_LEN: usize = 12 + LOT_MEMO_PLAIN_LEN + 16;

impl LotMemo {
    fn encode(&self) -> [u8; LOT_MEMO_PLAIN_LEN] {
        let mut out = [0u8; LOT_MEMO_PLAIN_LEN];
        out[0..4].copy_from_slice(&self.pool_id.to_be_bytes());
        out[4..20].copy_from_slice(&self.amount.to_be_bytes());
        out[20..52].copy_from_slice(&self.owner);
        out[52..84].copy_from_slice(&self.auth_hash);
        out[84..117].copy_from_slice(&crate::keys::compressed(&self.recipient));
        out
    }

    fn decode(b: &[u8]) -> Result<Self, Error> {
        if b.len() != LOT_MEMO_PLAIN_LEN {
            return Err(Error::MalformedCiphertext);
        }
        Ok(Self {
            pool_id: u32::from_be_bytes(b[0..4].try_into().unwrap()),
            amount: u128::from_be_bytes(b[4..20].try_into().unwrap()),
            owner: b[20..52].try_into().unwrap(),
            auth_hash: b[52..84].try_into().unwrap(),
            recipient: k256::PublicKey::from_sec1_bytes(&b[84..117]).map_err(|_| Error::MalformedCiphertext)?,
        })
    }
}

pub(crate) fn lot_memo_key(key: &crate::keys::EnclaveKey) -> Zeroizing<[u8; 32]> {
    let secret = key.secret_bytes();
    let hk = Hkdf::<Sha256>::new(None, secret.as_ref());
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(b"darkpool/lot-memo/v1", okm.as_mut()).expect("valid length");
    okm
}

/// AAD = lotun emir kimliği: bir lotun notu başka bir lot için kullanılamaz.
pub(crate) fn seal_lot_memo(key: &crate::keys::EnclaveKey, lot_order_id: &[u8; 32], memo: &LotMemo) -> Result<Vec<u8>, Error> {
    aead_seal(&lot_memo_key(key), &memo.encode(), lot_order_id)
}

pub(crate) fn open_lot_memo(key: &crate::keys::EnclaveKey, lot_order_id: &[u8; 32], sealed: &[u8]) -> Result<LotMemo, Error> {
    LotMemo::decode(&aead_open(&lot_memo_key(key), sealed, lot_order_id)?)
}

/// `sealed_result` = sonuç (SEALED_RESULT_LEN) [+ lot notu (LOT_MEMO_LEN)]. Lot notu varsa döner.
pub fn split_sealed_result(sealed: &[u8]) -> (&[u8], Option<&[u8]>) {
    if sealed.len() == SEALED_RESULT_LEN + LOT_MEMO_LEN {
        (&sealed[..SEALED_RESULT_LEN], Some(&sealed[SEALED_RESULT_LEN..]))
    } else {
        (sealed, None)
    }
}

/// Lot satışında satılmayan kısım (kalan lot) için ayrı sonuç kimliği:
/// `keccak256("darkpool/remainder/v1" || satışEmriId)`.
pub fn remainder_id(sell_order_id: &[u8; 32]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"darkpool/remainder/v1");
    h.update(sell_order_id);
    h.finalize().into()
}

/// Enclave tarafı: iç katman kullanıcıya, dış katman batch kilidine.
pub(crate) fn seal_outcome(
    k_b: &[u8; 32],
    order_id: &[u8; 32],
    recipient: &k256::PublicKey,
    outcome: &OrderOutcome,
) -> Result<Vec<u8>, Error> {
    let inner = ecies::encrypt(recipient, &outcome.encode(), order_id)?;
    aead_seal(&result_key(k_b), &inner, order_id)
}

/// Kilit açıldıktan sonra herkes: dış katmanı soyar, kullanıcıya özel ECIES blob'unu döner.
pub fn open_result_outer(k_b: &[u8; 32], order_id: &[u8; 32], sealed_result: &[u8]) -> Result<Vec<u8>, Error> {
    aead_open(&result_key(k_b), split_sealed_result(sealed_result).0, order_id)
}

/// Emir sahibi: kendi anahtarıyla iç katmanı çözer.
pub fn open_result(user_secret: &SecretKey, order_id: &[u8; 32], inner: &[u8]) -> Result<OrderOutcome, Error> {
    OrderOutcome::decode(&ecies::decrypt(user_secret, inner, order_id)?)
}

// ---------------------------------------------------------------- ghost chart özeti

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSummary {
    pub pool_id: u32,
    /// quote/base, 1e18 ölçekli clearing fiyatı (işlem yoksa spot fiyat)
    pub price_x18: U256,
    /// Alımlarda harcanan toplam quote (brüt)
    pub quote_in: u128,
    /// Satımlarda verilen toplam base (brüt)
    pub base_in: u128,
    pub buy_count: u32,
    pub sell_count: u32,
    /// Batch sonrası rezervler (LP'ye ait; kullanıcı çıktıları hariç)
    pub base_reserve: u128,
    pub quote_reserve: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchSummary {
    /// `reserves_commitment` tuzu. Tuzsuz olsaydı az işlem gören bir havuzun tahmin
    /// edilebilir rezervleri, 7 gün dolmadan commitment'tan kaba kuvvetle bulunabilirdi.
    pub salt: [u8; 32],
    /// Tüm havuzlar, pool_id sırasıyla
    pub pools: Vec<PoolSummary>,
}

/// Solidity:
/// `keccak256(abi.encodePacked("darkpool/reserves/v1", uint256(batchId), salt,
///     [uint32 poolId, uint128 base, uint128 quote] ...))`
pub fn reserves_commitment(batch_id: u64, salt: &[u8; 32], pools: &[PoolSummary]) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[24..].copy_from_slice(&batch_id.to_be_bytes());
    let mut h = Keccak256::new();
    h.update(b"darkpool/reserves/v1");
    h.update(id);
    h.update(salt);
    for p in pools {
        h.update(p.pool_id.to_be_bytes());
        h.update(p.base_reserve.to_be_bytes());
        h.update(p.quote_reserve.to_be_bytes());
    }
    h.finalize().into()
}

pub(crate) fn encode_summary(batch_id: u64, summary: &BatchSummary) -> Vec<u8> {
    let entries = &summary.pools;
    let mut out = Vec::with_capacity(SUMMARY_HEADER_LEN + SUMMARY_ENTRY_LEN * entries.len());
    out.push(SUMMARY_VERSION);
    out.extend_from_slice(&batch_id.to_be_bytes());
    out.extend_from_slice(&summary.salt);
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for e in entries {
        out.extend_from_slice(&e.pool_id.to_be_bytes());
        out.extend_from_slice(&e.price_x18.to_be_bytes::<32>());
        out.extend_from_slice(&e.quote_in.to_be_bytes());
        out.extend_from_slice(&e.base_in.to_be_bytes());
        out.extend_from_slice(&e.buy_count.to_be_bytes());
        out.extend_from_slice(&e.sell_count.to_be_bytes());
        out.extend_from_slice(&e.base_reserve.to_be_bytes());
        out.extend_from_slice(&e.quote_reserve.to_be_bytes());
    }
    out
}

pub(crate) fn summary_aad(batch_id: u64) -> [u8; 8] {
    batch_id.to_be_bytes()
}

pub fn open_summary(k_b: &[u8; 32], batch_id: u64, sealed: &[u8]) -> Result<BatchSummary, Error> {
    let b = aead_open(&summary_key(k_b), sealed, &summary_aad(batch_id))?;
    if b.len() < SUMMARY_HEADER_LEN || b[0] != SUMMARY_VERSION {
        return Err(Error::MalformedCiphertext);
    }
    if u64::from_be_bytes(b[1..9].try_into().unwrap()) != batch_id {
        return Err(Error::MalformedCiphertext);
    }
    let salt: [u8; 32] = b[9..41].try_into().unwrap();
    let count = u32::from_be_bytes(b[41..45].try_into().unwrap()) as usize;
    if b.len() != SUMMARY_HEADER_LEN + count * SUMMARY_ENTRY_LEN {
        return Err(Error::MalformedCiphertext);
    }
    let pools = b[SUMMARY_HEADER_LEN..]
        .chunks_exact(SUMMARY_ENTRY_LEN)
        .map(|c| PoolSummary {
            pool_id: u32::from_be_bytes(c[0..4].try_into().unwrap()),
            price_x18: U256::from_be_bytes::<32>(c[4..36].try_into().unwrap()),
            quote_in: u128::from_be_bytes(c[36..52].try_into().unwrap()),
            base_in: u128::from_be_bytes(c[52..68].try_into().unwrap()),
            buy_count: u32::from_be_bytes(c[68..72].try_into().unwrap()),
            sell_count: u32::from_be_bytes(c[72..76].try_into().unwrap()),
            base_reserve: u128::from_be_bytes(c[76..92].try_into().unwrap()),
            quote_reserve: u128::from_be_bytes(c[92..108].try_into().unwrap()),
        })
        .collect();
    Ok(BatchSummary { salt, pools })
}

// ---------------------------------------------------------------- kapsül

/// drand beacon imzasıyla batch anahtarını açar.
pub fn open_capsule(capsule: &[u8], beacon_signature: &[u8]) -> Result<Zeroizing<[u8; 32]>, Error> {
    let raw = Zeroizing::new(timelock::unlock(capsule, beacon_signature)?);
    let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| Error::TimelockOpenFailed)?;
    Ok(Zeroizing::new(key))
}
