//! Claimer: settle edilmiş batch'lerin sonuçlarını kullanıcı adına not ağacına alır.
//! - `Refunded` → `returnRefunded` hemen (harcanan kısım not olarak geri döner)
//! - `Filled`   → kilit açılınca `claimNote`
//!
//! İkisi de izinsiz (permissionless) ve miktar/adres sızdırmaz; kullanıcının hiçbir şey
//! yapmasına gerek kalmaz, işlemi kimin gönderdiği de görünmez (relayer gönderir).

use std::collections::HashSet;

use alloy::primitives::{FixedBytes, U256};
use anyhow::Result;
use dark_tee_core::batch::{merkle_proof, OrderStatus};

use crate::{chain::Chain, index::Indexer};

/// Tek adımda en fazla bu kadar işlem (döngü diğer görevleri bekletmesin).
const MAX_PER_TICK: usize = 32;

#[derive(Default)]
pub struct Claimer {
    done: HashSet<[u8; 32]>,
}

impl Claimer {
    pub async fn tick(&mut self, chain: &Chain, index: &Indexer) -> Result<usize> {
        let now = chain.latest_timestamp().await?;
        // İndeksten iş listesini çıkar, kilidi bırak, sonra gönder.
        let mut work = Vec::new();
        {
            let st = index.state.read().await;
            for b in st.batches.values().filter(|b| !b.results.is_empty()) {
                let core = b.core_results();
                let leaves: Vec<[u8; 32]> = core.iter().map(|r| r.leaf()).collect();
                for (i, r) in core.iter().enumerate() {
                    if self.done.contains(&r.order_id) {
                        continue;
                    }
                    if r.status == OrderStatus::Filled && now < b.unlock_time {
                        continue;
                    }
                    work.push((b.batch_id, r.clone(), merkle_proof(&leaves, i)));
                }
            }
        }

        let mut sent = 0;
        for (batch_id, r, proof) in work.into_iter().take(MAX_PER_TICK) {
            let id = FixedBytes(r.order_id);
            if chain.vault.orders(id).call().await?.done {
                self.done.insert(r.order_id);
                continue;
            }
            let proof: Vec<FixedBytes<32>> = proof.into_iter().map(FixedBytes).collect();
            let res = match r.status {
                OrderStatus::Refunded => {
                    chain.send(&format!("returnRefunded {id}"), chain.vault.returnRefunded(batch_id, id, proof)).await
                }
                OrderStatus::Filled => {
                    let sealed_hash = FixedBytes(keccak(&r.sealed_result));
                    let commitment = U256::from_be_bytes(r.output_commitment);
                    chain
                        .send(
                            &format!("claimNote {id}"),
                            chain.vault.claimNote(batch_id, id, commitment, sealed_hash, proof),
                        )
                        .await
                }
            };
            match res {
                Ok(_) => {
                    self.done.insert(r.order_id);
                    sent += 1;
                }
                Err(e) => tracing::warn!(order = %id, error = %e, "claim failed; will retry"),
            }
        }
        Ok(sent)
    }
}

fn keccak(b: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(b).into()
}
