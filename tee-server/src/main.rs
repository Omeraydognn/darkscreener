//! Enclave sunucusu.
//!
//! Ortam değişkenleri:
//! - `TEE_PROVIDER`    : `local` (varsayılan, donanımsız) | `oyster` (Marlin Oyster CVM)
//! - `OYSTER_KMS_PATH` : yalnızca `oyster`; KMS türetme yolu (varsayılan `darkpool-enclave-v1`)
//! - `LOCAL_SEED_PATH` : yalnızca `local`; verilirse anahtar seed'i bu dosyada kalıcı olur.
//! - `LOCAL_CLOCK_RPC` : yalnızca `local`; saat bu RPC'nin son bloğundan okunur (zaman kaydırmalı dev zinciri).
//! - `RELAYER_ADDRESSES`: virgülle ayrılmış adresler; verilirse `/process` yalnızca bunların
//!   imzaladığı istekleri kabul eder (enclave herkese açık ağdaysa ZORUNLU tutun)
//! - `LISTEN_ADDR`     : varsayılan `0.0.0.0:8080`
//! - `RUST_LOG`        : varsayılan `info`

use std::{path::PathBuf, sync::Arc};

use anyhow::{bail, Context};
use dark_tee_attest::{LocalDev, Oyster, TeeProvider, DEFAULT_KMS_PATH};
use dark_tee_server::{
    api::to_hex,
    app::{router, AppState},
};
use tracing_subscriber::EnvFilter;

fn provider_from_env() -> anyhow::Result<Box<dyn TeeProvider>> {
    match std::env::var("TEE_PROVIDER").unwrap_or_else(|_| "local".into()).as_str() {
        "local" => {
            let mut p = LocalDev::new(std::env::var_os("LOCAL_SEED_PATH").map(PathBuf::from));
            if let Ok(rpc) = std::env::var("LOCAL_CLOCK_RPC") {
                tracing::warn!(%rpc, "saat yerel zincirden okunuyor (yalnızca geliştirme)");
                p = p.with_chain_clock(rpc);
            }
            Ok(Box::new(p))
        }
        "oyster" => Ok(Box::new(Oyster::new(
            &std::env::var("OYSTER_KMS_PATH").unwrap_or_else(|_| DEFAULT_KMS_PATH.into()),
        ))),
        other @ ("nitro" | "phala") => {
            bail!("TEE_PROVIDER={other} henüz uygulanmadı (Faz 1 CVM adımı)")
        }
        other => bail!("bilinmeyen TEE_PROVIDER={other}"),
    }
}

fn relayers_from_env() -> anyhow::Result<Vec<[u8; 20]>> {
    let Ok(list) = std::env::var("RELAYER_ADDRESSES") else { return Ok(Vec::new()) };
    list.split(',')
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(|a| {
            let raw = hex::decode(a.trim_start_matches("0x")).with_context(|| format!("RELAYER_ADDRESSES: {a}"))?;
            raw.try_into().map_err(|_| anyhow::anyhow!("RELAYER_ADDRESSES: {a} is not 20 bytes"))
        })
        .collect()
}

/// `docker stop` SIGTERM gönderir; Ctrl+C SIGINT.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let provider = provider_from_env()?;
    if !provider.is_hardware_backed() {
        tracing::warn!(
            provider = provider.name(),
            "DONANIM GARANTİSİ YOK: attestation üretilmez, yalnızca yerel geliştirme içindir"
        );
    }
    let relayers = relayers_from_env()?;
    if relayers.is_empty() {
        tracing::warn!("RELAYER_ADDRESSES yok: /process herkese açık (yalnızca yerel ağda kullanın)");
    }
    let state = Arc::new(AppState::new(provider)?.with_relayers(relayers));
    tracing::info!(
        address = %to_hex(&state.key.eth_address()),
        public_key = %to_hex(&state.key.public_key_compressed()),
        "enclave key ready"
    );

    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.with_context(|| format!("bind {addr}"))?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}
