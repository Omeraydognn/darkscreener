//! Kilidi açılan batch'leri açar: drand quicknet'in o tur için yayınladığı imza kapsülü çözer
//! (`K_b`), `K_b` ile ghost-chart özeti açılır. Tamamen izinsizdir; herkes aynısını yapabilir —
//! relayer yalnızca istemcilere hazır sunar. Uygunluk GERÇEK saate göredir (drand gerçek
//! zamanda yayınlar), zincir saatine değil.

use std::{collections::BTreeMap, time::Duration};

use anyhow::{anyhow, Result};
use dark_tee_core::{
    reveal::{open_capsule, open_summary, BatchSummary},
    timelock::QUICKNET_CHAIN_HASH,
};
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::index::Indexer;

/// Aynı ağın farklı aynaları; biri düşerse sıradaki denenir.
const DRAND_MIRRORS: &[&str] = &[
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://drand.cloudflare.com",
];

#[derive(Debug, Clone)]
pub struct Revealed {
    pub kb: [u8; 32],
    pub summary: BatchSummary,
}

pub struct Revealer {
    http: reqwest::Client,
    pub revealed: RwLock<BTreeMap<u64, Revealed>>,
}

#[derive(Deserialize)]
struct Beacon {
    round: u64,
    signature: String,
}

impl Revealer {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()?,
            revealed: RwLock::new(BTreeMap::new()),
        })
    }

    async fn beacon(&self, round: u64) -> Result<Vec<u8>> {
        let mut last = anyhow!("no mirror");
        for m in DRAND_MIRRORS {
            let url = format!("{m}/{QUICKNET_CHAIN_HASH}/public/{round}");
            match self.http.get(&url).send().await {
                Ok(r) if r.status().is_success() => {
                    let b: Beacon = r.json().await?;
                    if b.round != round {
                        last = anyhow!("{m}: wrong round {}", b.round);
                        continue;
                    }
                    return Ok(hex::decode(b.signature)?);
                }
                Ok(r) => last = anyhow!("{m}: {}", r.status()),
                Err(e) => last = anyhow!("{m}: {e}"),
            }
        }
        Err(last)
    }

    /// Açılabilir durumdaki batch'leri açar. Döner: bu adımda açılan sayı.
    pub async fn tick(&self, index: &Indexer, now_unix: u64) -> Result<usize> {
        let pending: Vec<(u64, u64, Vec<u8>, Vec<u8>)> = {
            let st = index.state.read().await;
            let done = self.revealed.read().await;
            st.batches
                .values()
                .filter(|b| !b.capsule.is_empty() && !done.contains_key(&b.batch_id))
                .filter(|b| dark_tee_core::timelock::round_time(b.unlock_round) <= now_unix)
                .map(|b| {
                    (
                        b.batch_id,
                        b.unlock_round,
                        b.capsule.to_vec(),
                        b.sealed_summary.to_vec(),
                    )
                })
                .collect()
        };
        let mut n = 0;
        for (batch_id, round, capsule, sealed) in pending {
            let sig = self.beacon(round).await?;
            // Kapsül yanlış tura/imzaya karşı AEAD ile doğrulanır: sahte beacon açamaz.
            let kb = open_capsule(&capsule, &sig).map_err(|e| anyhow!("batch {batch_id}: {e}"))?;
            let summary = open_summary(&kb, batch_id, &sealed)
                .map_err(|e| anyhow!("batch {batch_id}: {e}"))?;
            self.revealed
                .write()
                .await
                .insert(batch_id, Revealed { kb: *kb, summary });
            n += 1;
        }
        Ok(n)
    }
}
