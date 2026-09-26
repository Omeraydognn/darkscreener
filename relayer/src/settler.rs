//! Settler: settle sırası gelen pencere kapanıp kesinleşince batch'i enclave'e gönderir,
//! yanıtı kontratın yapacağı TÜM kontrollerle yerelde doğrular ve ancak o zaman zincire yazar
//! (başarısız işleme gaz harcanmaz; Monad gaz limitini ücretlendirir).

use alloy::primitives::{Address, Bytes, FixedBytes};
use anyhow::{anyhow, bail, ensure, Context, Result};
use dark_tee_core::{
    batch::{lots_hash, orders_hash, pools_hash, results_root, BatchInput, LotUpdate, OrderResult},
    digest::Settlement,
    keys::recover_address,
    timelock,
};
use dark_tee_server::api::{Amount, Bytes as HexBytes, Fixed, OrderDto, PoolInitDto, ProcessRequest, ProcessResponse};

use crate::{
    chain::{Chain, IDarkVault},
    index::{IndexState, Indexer, WindowRec},
};

pub struct Enclave {
    pub url: String,
    pub http: reqwest::Client,
    /// Relayer anahtarı: `/process` gövdesini imzalar (enclave RELAYER_ADDRESSES ile doğrular).
    pub signer: alloy::signers::local::PrivateKeySigner,
}

impl Enclave {
    pub async fn process(&self, req: &ProcessRequest) -> Result<ProcessResponse> {
        use alloy::signers::SignerSync;
        let body = serde_json::to_vec(req)?;
        let digest = dark_tee_server::app::process_digest(&body);
        let sig = self.signer.sign_hash_sync(&digest.into())?.as_bytes();
        let resp = self
            .http
            .post(format!("{}/process", self.url))
            .header("content-type", "application/json")
            .header(dark_tee_server::app::RELAYER_SIG_HEADER, format!("0x{}", hex::encode(sig)))
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            bail!("enclave {status}: {}", resp.text().await.unwrap_or_default());
        }
        Ok(resp.json().await?)
    }
}

/// Tek adım: settle edilecek bir şey varsa settle eder. `Ok(Some(batch_id))` = yazıldı.
pub async fn tick(chain: &Chain, index: &Indexer, enclave: &Enclave) -> Result<Option<u64>> {
    if chain.vault.escaped().call().await? {
        return Ok(None);
    }
    let window = chain.vault.nextWindowToSettle().call().await?;
    if window == 0 {
        return Ok(None);
    }
    let end = u64::try_from(chain.vault.windowEnd(window).call().await?)?;
    let settled = chain.vault.settledCount().call().await?;

    let (req, rec) = {
        let st = index.state.read().await;
        // Pencerenin tüm olayları kesinleşmiş ve indekslenmiş olmalı.
        if st.finalized_timestamp < end {
            return Ok(None);
        }
        let prev = if settled == 0 {
            None
        } else {
            let b = st.batches.get(&settled).ok_or_else(|| anyhow!("batch {settled} not indexed yet"))?;
            ensure!(!b.new_sealed_state.is_empty(), "batch {settled} data not indexed yet");
            Some(b.new_sealed_state.clone())
        };
        let rec = st.windows.get(&window).cloned().unwrap_or_default();
        (build_request(chain, settled + 1, prev, &rec, &st), rec)
    };

    // Indexer eksikse (ör. RPC log kaybı) enclave'e hiç gitme.
    check_window_integrity(&rec)?;
    let input: BatchInput = req.clone().into();
    let chain_orders = chain.vault.ordersHash(window).call().await?;
    ensure!(
        chain_orders.0 == orders_hash(&input.orders),
        "window {window}: indexed orders ({}) do not match chain ordersHash",
        rec.orders.len()
    );
    let chain_pools = chain.vault.windowPools(window).call().await?;
    ensure!(chain_pools.poolsChain.0 == pools_hash(&input.new_pools), "window {window}: pools mismatch");

    let resp = enclave.process(&req).await.context("enclave /process")?;
    let now = chain.latest_timestamp().await?;
    let signer = verify(chain, &req, &resp, settled, now)?;
    ensure!(chain.registry.isEnclave(signer).call().await?, "signer {signer} is not a registered enclave");

    let (params, results, lots) = to_call(window, &resp);
    chain
        .send(
            &format!("settleBatch #{} (window {window}, {} orders, {} lot sells)", settled + 1, results.len(), lots.len()),
            chain.vault.settleBatch(params, results, lots),
        )
        .await?;
    Ok(Some(settled + 1))
}

/// Her shard'da indeksler 0'dan boşluksuz ilerlemeli ve orderId = keccak(ciphertext) olmalı.
fn check_window_integrity(rec: &WindowRec) -> Result<()> {
    let mut next = [0u32; dark_tee_core::batch::SHARDS];
    for o in &rec.orders {
        ensure!(o.order_id.0 == keccak(&o.ciphertext), "orderId != keccak(ciphertext) for {}", o.order_id);
        let s = o.shard as usize;
        ensure!(s == dark_tee_core::batch::shard_of(&o.order_id.0), "wrong shard for {}", o.order_id);
        ensure!(o.index == next[s], "shard {s}: index gap at {} (expected {})", o.index, next[s]);
        next[s] += 1;
    }
    Ok(())
}

/// Lot satışında enclave'e satılan lotun enclave notu (lotun `sealedResult` sonu) verilir.
/// Bulunamazsa (olmamalı: kontrat yalnızca settle edilmiş lotu kabul eder) enclave satışı
/// reddeder ve lot serbest kalır.
fn lot_memo(st: &IndexState, lot: &alloy::primitives::B256) -> Option<HexBytes> {
    let r = st.result_of(lot)?;
    let (_, memo) = dark_tee_core::reveal::split_sealed_result(&r.sealedResult);
    memo.map(|m| HexBytes(m.to_vec()))
}

fn build_request(chain: &Chain, batch_id: u64, prev: Option<Bytes>, rec: &WindowRec, st: &IndexState) -> ProcessRequest {
    ProcessRequest {
        chain_id: chain.chain_id,
        vault: Fixed(chain.vault.address().0 .0),
        batch_id,
        quote_token: Fixed(chain.quote_token.0 .0),
        fee_bps: chain.fee_bps,
        prev_sealed_state: prev.map(|b| HexBytes(b.to_vec())),
        new_pools: rec
            .pools
            .iter()
            .map(|p| PoolInitDto {
                pool_id: p.pool_id,
                base_token: Fixed(p.base_token),
                base: Amount(p.base),
                quote: Amount(p.quote),
            })
            .collect(),
        orders: rec
            .orders
            .iter()
            .map(|o| OrderDto {
                ciphertext: HexBytes(o.ciphertext.to_vec()),
                spend_commitment: Fixed(o.spend_commitment.to_be_bytes()),
                is_lot_sell: o.lot.is_some(),
                lot_memo: o.lot.as_ref().and_then(|l| lot_memo(st, l)),
            })
            .collect(),
    }
}

/// Kontratın `settleBatch` içindeki kontrollerinin aynısı; imzacı adresini döner.
fn verify(chain: &Chain, req: &ProcessRequest, resp: &ProcessResponse, settled: u64, now: u64) -> Result<Address> {
    let s = Settlement::from(&resp.settlement);
    let input: BatchInput = req.clone().into();
    ensure!(s.chain_id == chain.chain_id && s.vault == chain.vault.address().0 .0, "chain/vault binding");
    ensure!(s.batch_id == settled + 1, "batch id");
    ensure!(s.quote_token == chain.quote_token.0 .0 && s.fee_bps == chain.fee_bps, "quote/fee binding");
    ensure!(s.orders_hash == orders_hash(&input.orders), "orders hash");
    ensure!(s.pools_hash == pools_hash(&input.new_pools), "pools hash");
    let prev = input.prev_sealed_state.as_deref().map(dark_tee_core::state::state_hash).unwrap_or([0u8; 32]);
    ensure!(s.prev_state_hash == prev, "state chain");
    ensure!(s.new_state_hash == keccak(&resp.new_sealed_state.0), "new state hash");
    ensure!(s.capsule_hash == keccak(&resp.capsule.0), "capsule hash");
    ensure!(s.summary_hash == keccak(&resp.sealed_summary.0), "summary hash");
    ensure!(resp.results.len() == input.orders.len(), "result count");
    let results: Vec<OrderResult> = resp.results.iter().map(OrderResult::from).collect();
    ensure!(s.results_root == results_root(&results), "results root");
    // Kontrat: penceredeki her lot satışı için tam bir güncelleme, imzalı lotsHash ile.
    let lot_sells: Vec<[u8; 32]> =
        input.orders.iter().filter(|o| o.is_lot_sell).map(|o| dark_tee_core::order::order_id(&o.ciphertext)).collect();
    let lots: Vec<LotUpdate> = resp.lots.iter().map(LotUpdate::from).collect();
    ensure!(lots.len() == lot_sells.len(), "lot update count");
    for l in &lots {
        ensure!(lot_sells.contains(&l.sell_order_id), "lot update for unknown sell order");
    }
    ensure!(s.lots_hash == lots_hash(&lots), "lots hash");
    let opens = timelock::round_time(s.unlock_round);
    ensure!(opens >= now + timelock::LOCK_SECONDS, "unlock earlier than 7 days (enclave clock behind chain?)");
    ensure!(opens <= now + timelock::LOCK_SECONDS + 86_400, "unlock later than 8 days");
    ensure!(timelock::capsule_round(&resp.capsule.0)? == s.unlock_round, "capsule round");
    Ok(Address::from(recover_address(&s.digest(), &resp.signature.0)?))
}

fn to_call(
    window: u64,
    resp: &ProcessResponse,
) -> (IDarkVault::SettleParams, Vec<IDarkVault::Result>, Vec<IDarkVault::LotUpdate>) {
    let params = IDarkVault::SettleParams {
        window,
        unlockRound: resp.settlement.unlock_round,
        newSealedState: Bytes::from(resp.new_sealed_state.0.clone()),
        capsule: Bytes::from(resp.capsule.0.clone()),
        sealedSummary: Bytes::from(resp.sealed_summary.0.clone()),
        reservesCommitment: FixedBytes(resp.settlement.reserves_commitment.0),
        signature: Bytes::from(resp.signature.0.to_vec()),
    };
    let results = resp
        .results
        .iter()
        .map(|r| IDarkVault::Result {
            orderId: FixedBytes(r.order_id.0),
            status: OrderResult::from(r).status as u8,
            commitment: FixedBytes(r.output_commitment.0),
            sealedResult: Bytes::from(r.sealed_result.0.clone()),
        })
        .collect();
    let lots = resp
        .lots
        .iter()
        .map(|l| IDarkVault::LotUpdate {
            sellOrderId: FixedBytes(l.sell_order_id.0),
            filled: l.filled,
            remainderCommitment: FixedBytes(l.remainder_commitment.0),
            sealedRemainder: Bytes::from(l.sealed_remainder.0.clone()),
        })
        .collect();
    (params, results, lots)
}

fn keccak(b: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(b).into()
}
