//! MON/USD kur güncelleyici: MonGateway kurunu piyasa fiyatına yakın tutar.
//!
//! Testnet MON'un piyasası yoktur; referans olarak mainnet MON fiyatı (CoinGecko) kullanılır.
//! Kur yalnızca %2'den fazla saparsa güncellenir: her güncelleme, o anda hazırlanmış bir
//! yatırmayı `AmountMismatch` ile geri çevirebilir (tarayıcı bir sonraki denemede yeni kurla yollar).
//! Relayer, gateway'in sahibi olmalıdır.

use std::time::{Duration, Instant};

use alloy::primitives::U256;
use anyhow::{anyhow, ensure, Result};

use crate::chain::Chain;

const INTERVAL: Duration = Duration::from_secs(600);
const MAX_DEVIATION_BPS: u64 = 200;

pub struct PriceUpdater {
    http: reqwest::Client,
    last: Option<Instant>,
    pub last_price: Option<f64>,
}

impl PriceUpdater {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("darkscreener-relayer/0.2")
                .build()?,
            last: None,
            last_price: None,
        })
    }

    async fn fetch(&self) -> Result<f64> {
        let v: serde_json::Value = self
            .http
            .get("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let usd = v["monad"]["usd"]
            .as_f64()
            .ok_or_else(|| anyhow!("no monad.usd in price response"))?;
        ensure!(
            usd.is_finite() && usd > 0.0 && usd < 1_000.0,
            "implausible MON price {usd}"
        );
        Ok(usd)
    }

    pub async fn tick(&mut self, chain: &Chain) -> Result<()> {
        if self.last.is_some_and(|t| t.elapsed() < INTERVAL) {
            return Ok(());
        }
        self.last = Some(Instant::now());
        let Some(gw) = chain.gateway.as_ref() else {
            return Ok(());
        };
        let usd = self.fetch().await?;
        self.last_price = Some(usd);
        let target = (usd * 1e6).round() as u64; // dUSD birimi (6 ondalık) / 1 MON
        ensure!(target > 0, "price too small");
        let current = u64::try_from(gw.usdPerMon().call().await?).unwrap_or(u64::MAX);
        let dev = target.abs_diff(current).saturating_mul(10_000) / current.max(1);
        if dev <= MAX_DEVIATION_BPS {
            return Ok(());
        }
        chain
            .send(
                &format!("gateway.setRate {current} -> {target} (MON ≈ {usd} $)"),
                gw.setRate(U256::from(target)),
            )
            .await?;
        Ok(())
    }
}
