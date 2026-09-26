//! HTTP/JSON sözleşmesi. Tüm baytlar `0x` önekli hex, tüm u128 tutarlar
//! ondalık string (JSON sayıları 2^53 üstünde hassasiyet kaybeder).
//! Çekirdek serde bilmez; dönüşümler burada.

use dark_tee_core::{
    batch::{BatchContext, BatchInput, BatchOutput, EncryptedOrder, OrderResult, OrderStatus, PoolInit},
    digest::Settlement,
};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};

// ---------------------------------------------------------------- primitifler

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fixed<const N: usize>(pub [u8; N]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Amount(pub u128);

fn decode_hex<E: serde::de::Error>(s: &str) -> Result<Vec<u8>, E> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| E::custom(format!("invalid hex: {e}")))
}

pub fn to_hex(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&to_hex(&self.0))
    }
}
impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        decode_hex(&s).map(Bytes)
    }
}

impl<const N: usize> Serialize for Fixed<N> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&to_hex(&self.0))
    }
}
impl<'de, const N: usize> Deserialize<'de> for Fixed<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let v: Vec<u8> = decode_hex(&s)?;
        let len = v.len();
        v.try_into()
            .map(Fixed)
            .map_err(|_| D::Error::custom(format!("expected {N} bytes, got {len}")))
    }
}

impl Serialize for Amount {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for Amount {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse::<u128>()
            .map(Amount)
            .map_err(|e| D::Error::custom(format!("amount must be a decimal u128 string: {e}")))
    }
}

// ---------------------------------------------------------------- /process

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessRequest {
    pub chain_id: u64,
    pub vault: Fixed<20>,
    pub batch_id: u64,
    pub quote_token: Fixed<20>,
    pub fee_bps: u16,
    #[serde(default)]
    pub prev_sealed_state: Option<Bytes>,
    #[serde(default)]
    pub new_pools: Vec<PoolInitDto>,
    #[serde(default)]
    pub orders: Vec<OrderDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PoolInitDto {
    pub pool_id: u32,
    pub base_token: Fixed<20>,
    pub base: Amount,
    pub quote: Amount,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderDto {
    pub ciphertext: Bytes,
    /// Kontratın ZK kanıtıyla kaydettiği Poseidon3(token, amount, blinding)
    pub spend_commitment: Fixed<32>,
}

impl From<ProcessRequest> for BatchInput {
    fn from(r: ProcessRequest) -> Self {
        BatchInput {
            ctx: BatchContext {
                chain_id: r.chain_id,
                vault: r.vault.0,
                batch_id: r.batch_id,
                quote_token: r.quote_token.0,
                fee_bps: r.fee_bps,
            },
            prev_sealed_state: r.prev_sealed_state.map(|b| b.0),
            new_pools: r
                .new_pools
                .into_iter()
                .map(|p| PoolInit { pool_id: p.pool_id, base_token: p.base_token.0, base: p.base.0, quote: p.quote.0 })
                .collect(),
            orders: r
                .orders
                .into_iter()
                .map(|o| EncryptedOrder { ciphertext: o.ciphertext.0, spend_commitment: o.spend_commitment.0 })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementDto {
    pub chain_id: u64,
    pub vault: Fixed<20>,
    pub batch_id: u64,
    pub prev_state_hash: Fixed<32>,
    pub new_state_hash: Fixed<32>,
    pub results_root: Fixed<32>,
    pub unlock_round: u64,
    pub capsule_hash: Fixed<32>,
    pub summary_hash: Fixed<32>,
    pub quote_token: Fixed<20>,
    pub fee_bps: u16,
    pub orders_hash: Fixed<32>,
    pub pools_hash: Fixed<32>,
    pub reserves_commitment: Fixed<32>,
    /// Bilgi amaçlı; doğrulayan taraf alanlardan kendisi yeniden hesaplamalı.
    pub digest: Fixed<32>,
}

impl From<&SettlementDto> for Settlement {
    fn from(s: &SettlementDto) -> Self {
        Settlement {
            chain_id: s.chain_id,
            vault: s.vault.0,
            batch_id: s.batch_id,
            prev_state_hash: s.prev_state_hash.0,
            new_state_hash: s.new_state_hash.0,
            results_root: s.results_root.0,
            unlock_round: s.unlock_round,
            capsule_hash: s.capsule_hash.0,
            summary_hash: s.summary_hash.0,
            quote_token: s.quote_token.0,
            fee_bps: s.fee_bps,
            orders_hash: s.orders_hash.0,
            pools_hash: s.pools_hash.0,
            reserves_commitment: s.reserves_commitment.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusDto {
    Filled,
    Refunded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultDto {
    pub order_id: Fixed<32>,
    pub status: StatusDto,
    pub output_commitment: Fixed<32>,
    pub sealed_result: Bytes,
}

impl From<&ResultDto> for OrderResult {
    fn from(r: &ResultDto) -> Self {
        OrderResult {
            order_id: r.order_id.0,
            status: match r.status {
                StatusDto::Filled => OrderStatus::Filled,
                StatusDto::Refunded => OrderStatus::Refunded,
            },
            output_commitment: r.output_commitment.0,
            sealed_result: r.sealed_result.0.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessResponse {
    pub settlement: SettlementDto,
    /// `r || s || v`, v ∈ {27, 28}
    pub signature: Fixed<65>,
    pub new_sealed_state: Bytes,
    pub results: Vec<ResultDto>,
    pub capsule: Bytes,
    pub sealed_summary: Bytes,
}

impl From<BatchOutput> for ProcessResponse {
    fn from(o: BatchOutput) -> Self {
        let s = &o.settlement;
        ProcessResponse {
            settlement: SettlementDto {
                chain_id: s.chain_id,
                vault: Fixed(s.vault),
                batch_id: s.batch_id,
                prev_state_hash: Fixed(s.prev_state_hash),
                new_state_hash: Fixed(s.new_state_hash),
                results_root: Fixed(s.results_root),
                unlock_round: s.unlock_round,
                capsule_hash: Fixed(s.capsule_hash),
                summary_hash: Fixed(s.summary_hash),
                quote_token: Fixed(s.quote_token),
                fee_bps: s.fee_bps,
                orders_hash: Fixed(s.orders_hash),
                pools_hash: Fixed(s.pools_hash),
                reserves_commitment: Fixed(s.reserves_commitment),
                digest: Fixed(s.digest()),
            },
            signature: Fixed(o.signature),
            new_sealed_state: Bytes(o.new_sealed_state),
            results: o
                .results
                .into_iter()
                .map(|r| ResultDto {
                    order_id: Fixed(r.order_id),
                    status: match r.status {
                        OrderStatus::Filled => StatusDto::Filled,
                        OrderStatus::Refunded => StatusDto::Refunded,
                    },
                    output_commitment: Fixed(r.output_commitment),
                    sealed_result: Bytes(r.sealed_result),
                })
                .collect(),
            capsule: Bytes(o.capsule),
            sealed_summary: Bytes(o.sealed_summary),
        }
    }
}

// ---------------------------------------------------------------- /pubkey, /attestation

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubkeyResponse {
    /// Kullanıcılar emirlerini buna ECIES ile şifreler (33 bayt, compressed)
    pub public_key: Fixed<33>,
    /// Attestation report_data'sı (64 bayt, x || y)
    pub public_key_xy: Fixed<64>,
    /// Kontratın ecrecover ile karşılaştıracağı adres
    pub address: Fixed<20>,
    pub provider: String,
    pub hardware_backed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationResponse {
    pub provider: String,
    pub format: String,
    pub hardware_backed: bool,
    pub report_data: Fixed<64>,
    pub document: Bytes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}
