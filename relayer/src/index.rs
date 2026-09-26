//! Olay indexer'ı: yalnızca `finalized` bloklara kadar okur (Monad'da kesinleşmemiş bloklar
//! değişebilir) ve `eth_getLogs`'u RPC sınırına uygun parçalarla (varsayılan 100 blok) çağırır.
//!
//! Tüm durum zincirden türetilir; relayer yeniden başlarsa `DEPLOY_BLOCK`'tan tekrar tarar.

use std::collections::BTreeMap;

use alloy::{
    eips::BlockNumberOrTag,
    primitives::{Bytes, B256, U256},
    providers::Provider,
    rpc::types::{Filter, Log},
    sol_types::SolEvent,
};
use anyhow::{anyhow, Result};
use dark_tee_core::batch::{OrderResult, OrderStatus, PoolInit};
use tokio::sync::RwLock;

use crate::chain::{Chain, IDarkVault};

#[derive(Debug, Clone)]
pub struct OrderRec {
    pub order_id: B256,
    pub shard: u8,
    pub index: u32,
    pub spend_commitment: U256,
    pub ciphertext: Bytes,
}

#[derive(Debug, Clone, Default)]
pub struct WindowRec {
    pub pools: Vec<PoolInit>,
    /// Zincirdeki sırayla (blok, log indeksi): her shard içindeki sıra korunur.
    pub orders: Vec<OrderRec>,
}

#[derive(Debug, Clone)]
pub struct BatchRec {
    pub batch_id: u64,
    pub window: u64,
    pub results_root: B256,
    pub unlock_round: u64,
    pub unlock_time: u64,
    pub new_sealed_state: Bytes,
    pub capsule: Bytes,
    pub sealed_summary: Bytes,
    pub results: Vec<IDarkVault::Result>,
}

impl BatchRec {
    /// Kontratın `_resultsRoot` ile aynı yaprakları üretmek için çekirdek türüne çevirir.
    pub fn core_results(&self) -> Vec<OrderResult> {
        self.results
            .iter()
            .map(|r| OrderResult {
                order_id: r.orderId.0,
                status: if r.status == 1 { OrderStatus::Filled } else { OrderStatus::Refunded },
                output_commitment: r.commitment.0,
                sealed_result: r.sealedResult.to_vec(),
            })
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct PoolMeta {
    pub pool_id: u32,
    pub base_token: alloy::primitives::Address,
    pub window: u64,
    pub init_base: u128,
    pub init_quote: u128,
}

#[derive(Debug, Default)]
pub struct IndexState {
    pub pools: BTreeMap<u32, PoolMeta>,
    /// Bir sonraki taranacak blok
    pub cursor: u64,
    pub finalized_block: u64,
    pub finalized_timestamp: u64,
    pub windows: BTreeMap<u64, WindowRec>,
    pub batches: BTreeMap<u64, BatchRec>,
    /// NoteInserted olaylarından, indeks sırasıyla
    pub notes: Vec<U256>,
}

pub struct Indexer {
    pub state: RwLock<IndexState>,
    chunk: u64,
}

impl Indexer {
    pub fn new(deploy_block: u64, chunk: u64) -> Self {
        Self { state: RwLock::new(IndexState { cursor: deploy_block, ..Default::default() }), chunk: chunk.max(1) }
    }

    /// `finalized` başa kadar tarar. Parça parça ilerler; hata olursa imleç son başarılı parçada kalır.
    pub async fn sync(&self, chain: &Chain) -> Result<()> {
        let head = chain
            .provider
            .get_block_by_number(BlockNumberOrTag::Finalized)
            .await?
            .ok_or_else(|| anyhow!("no finalized block"))?;
        let head_number = head.header.number;
        let head_ts = head.header.timestamp;

        let mut from = self.state.read().await.cursor;
        while from <= head_number {
            let to = (from + self.chunk - 1).min(head_number);
            let filter = Filter::new().address(*chain.vault.address()).from_block(from).to_block(to);
            let logs = chain.provider.get_logs(&filter).await?;
            let mut st = self.state.write().await;
            for log in &logs {
                apply(&mut st, log)?;
            }
            st.cursor = to + 1;
            drop(st);
            from = to + 1;
        }
        let mut st = self.state.write().await;
        st.finalized_block = head_number;
        st.finalized_timestamp = head_ts;
        Ok(())
    }
}

fn apply(st: &mut IndexState, log: &Log) -> Result<()> {
    let Some(topic0) = log.topic0() else { return Ok(()) };
    match *topic0 {
        IDarkVault::NoteInserted::SIGNATURE_HASH => {
            let e = log.log_decode::<IDarkVault::NoteInserted>()?.inner.data;
            if e.index as usize != st.notes.len() {
                return Err(anyhow!("note index gap: got {}, expected {}", e.index, st.notes.len()));
            }
            st.notes.push(e.commitment);
        }
        IDarkVault::PoolCreated::SIGNATURE_HASH => {
            let e = log.log_decode::<IDarkVault::PoolCreated>()?.inner.data;
            st.pools.insert(
                e.poolId,
                PoolMeta { pool_id: e.poolId, base_token: e.baseToken, window: e.window, init_base: e.base, init_quote: e.quote },
            );
            st.windows.entry(e.window).or_default().pools.push(PoolInit {
                pool_id: e.poolId,
                base_token: e.baseToken.0 .0,
                base: e.base,
                quote: e.quote,
            });
        }
        IDarkVault::OrderSubmitted::SIGNATURE_HASH => {
            let e = log.log_decode::<IDarkVault::OrderSubmitted>()?.inner.data;
            st.windows.entry(e.window).or_default().orders.push(OrderRec {
                order_id: e.orderId,
                shard: e.shard,
                index: e.index,
                spend_commitment: e.spendCommitment,
                ciphertext: e.ciphertext,
            });
        }
        IDarkVault::BatchSettled::SIGNATURE_HASH => {
            let e = log.log_decode::<IDarkVault::BatchSettled>()?.inner.data;
            st.batches.insert(
                e.batchId,
                BatchRec {
                    batch_id: e.batchId,
                    window: e.window,
                    results_root: e.resultsRoot,
                    unlock_round: e.unlockRound,
                    unlock_time: e.unlockTime,
                    new_sealed_state: Bytes::new(),
                    capsule: Bytes::new(),
                    sealed_summary: Bytes::new(),
                    results: vec![],
                },
            );
        }
        IDarkVault::BatchData::SIGNATURE_HASH => {
            let e = log.log_decode::<IDarkVault::BatchData>()?.inner.data;
            let b = st
                .batches
                .get_mut(&e.batchId)
                .ok_or_else(|| anyhow!("BatchData before BatchSettled for {}", e.batchId))?;
            b.new_sealed_state = e.newSealedState;
            b.capsule = e.capsule;
            b.sealed_summary = e.sealedSummary;
            b.results = e.results;
        }
        _ => {}
    }
    Ok(())
}
