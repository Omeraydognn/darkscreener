//! Dark Pool relayer.
//!
//! Ortam değişkenleri:
//! - `RPC_URL`             Monad RPC (ör. https://testnet-rpc.monad.xyz)
//! - `VAULT_ADDRESS`       DarkVault adresi
//! - `ENCLAVE_URL`         enclave sunucusu (varsayılan http://127.0.0.1:8080)
//! - `RELAYER_PRIVATE_KEY` gaz ödeyen anahtar — ASLA loglanmaz; .env dosyası git dışıdır
//! - `DEPLOY_BLOCK`        taramaya başlanacak blok (vault'un deploy bloğu)
//! - `LOG_CHUNK`           eth_getLogs blok aralığı (Monad RPC: 100)
//! - `POLL_MS`             döngü aralığı (varsayılan 1000)
//! - `LISTEN_ADDR`         API (varsayılan 0.0.0.0:8090)
//! - `RATE_PER_MIN`        IP başına dakikada yazma isteği (varsayılan 30)
//! - `PROJECTS_FILE`       proje meta verisi + haber imzacıları (JSON)
//! - `NEWS_FILE`           imzalı haberlerin kalıcı kaydı (JSON satırları)

mod api;
mod chain;
mod claimer;
mod index;
mod news;
mod reveal;
mod settler;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use alloy::{primitives::Address, signers::local::PrivateKeySigner};
use anyhow::{Context, Result};
use tracing_subscriber::EnvFilter;

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} gerekli"))
}

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> Result<T> {
    match std::env::var(name) {
        Ok(v) => v.parse().map_err(|_| anyhow::anyhow!("{name} geçersiz")),
        Err(_) => Ok(default),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let signer: PrivateKeySigner = env("RELAYER_PRIVATE_KEY")?.trim().parse().context("RELAYER_PRIVATE_KEY")?;
    let vault: Address = env("VAULT_ADDRESS")?.parse().context("VAULT_ADDRESS")?;
    let chain = Arc::new(chain::Chain::connect(&env("RPC_URL")?, vault, signer.clone()).await?);
    let index = Arc::new(index::Indexer::new(env_or("DEPLOY_BLOCK", 0u64)?, env_or("LOG_CHUNK", 100u64)?));
    let enclave = Arc::new(settler::Enclave {
        url: env_or("ENCLAVE_URL", "http://127.0.0.1:8080".to_string())?,
        http: reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?,
        signer,
    });
    let poll = Duration::from_millis(env_or("POLL_MS", 1000u64)?);
    let revealer = Arc::new(reveal::Revealer::new()?);
    let news = Arc::new(news::NewsStore::load(
        std::env::var_os("PROJECTS_FILE").map(Into::into),
        std::env::var_os("NEWS_FILE").map(Into::into),
    )?);
    tracing::info!(chain_id = chain.chain_id, %vault, relayer = %chain.sender, "relayer started");

    // indexer + settler + claimer tek döngüde, sırayla: settle kararı güncel indekse dayanır.
    {
        let (chain, index, enclave, revealer) = (chain.clone(), index.clone(), enclave.clone(), revealer.clone());
        tokio::spawn(async move {
            let mut claimer = claimer::Claimer::default();
            loop {
                if let Err(e) = index.sync(&chain).await {
                    tracing::warn!(error = %e, "index sync");
                }
                match settler::tick(&chain, &index, &enclave).await {
                    Ok(Some(id)) => tracing::info!(batch_id = id, "settled"),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(error = format!("{e:#}"), "settle"),
                }
                if let Err(e) = claimer.tick(&chain, &index).await {
                    tracing::warn!(error = %e, "claimer");
                }
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                match revealer.tick(&index, now).await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(revealed = n, "batches unlocked via drand"),
                    Err(e) => tracing::warn!(error = format!("{e:#}"), "reveal"),
                }
                tokio::time::sleep(poll).await;
            }
        });
    }

    let ctx = Arc::new(api::AppCtx {
        chain,
        index,
        enclave,
        limiter: api::RateLimiter::new(env_or("RATE_PER_MIN", 30u32)?),
        revealer,
        news,
        tokens: Default::default(),
    });
    let addr = env_or("LISTEN_ADDR", "0.0.0.0:8090".to_string())?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "api listening");
    axum::serve(listener, api::router(ctx).into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}
