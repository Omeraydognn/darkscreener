//! Relayer HTTP API.
//!
//! Gizlilik: kullanıcı gizli emrini ve çekimini buraya yollar; zincire RELAYER'ın adresinden
//! gider. Böylece kullanıcının cüzdan adresi emirle ilişkilenmez ve yeni (bakiyesiz) bir
//! adrese gaz ödemeden çekim yapılabilir. Kanıtlar çağrı bağlamına bağlı olduğundan relayer
//! emri/alıcıyı değiştiremez; yalnızca göndermeyi reddedebilir (o zaman kullanıcı kendisi gönderir).
//!
//! | Uç                      | Açıklama |
//! |-------------------------|----------|
//! | GET  /v1/info           | zincir, vault, enclave anahtarı + registry kaydı, settle durumu |
//! | GET  /v1/notes?from=&limit= | not ağacı yaprakları (istemci ağacı buradan kurar) |
//! | GET  /v1/batches/{id}   | kapsül, özet, sonuçlar (7 gün sonra açmak için) |
//! | POST /v1/orders         | { ciphertext, proof } → submitShieldedOrder |
//! | POST /v1/withdrawals    | { proof, token, amount, spendBlinding, recipient } → withdraw |
//! | GET  /v1/pools          | havuzlar + token bilgisi + proje meta verisi |
//! | GET  /v1/pools/{id}/history | 7 gün gecikmeli "ghost chart": açılmış batch noktaları + kilitli batch'ler |
//! | GET  /v1/news?pool=&limit= | imzalı proje haberleri |
//! | POST /v1/news           | imzalı haber (yalnızca projenin yetkili anahtarları) |

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use alloy::primitives::{Address, Bytes, B256, U256};
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    chain::{Chain, IDarkVault},
    index::Indexer,
    news::{NewsPost, NewsStore},
    reveal::Revealer,
    settler::Enclave,
};

pub struct AppCtx {
    pub chain: Arc<Chain>,
    pub index: Arc<Indexer>,
    pub enclave: Arc<Enclave>,
    pub limiter: RateLimiter,
    pub revealer: Arc<Revealer>,
    pub news: Arc<NewsStore>,
    pub tokens: tokio::sync::Mutex<HashMap<Address, Value>>,
    /// Yalnızca demo projeler: testnet öncesi örnek grafik noktaları (`demo: true`), bkz.
    /// sdk/e2e/gen-demo-history.mjs. Gerçek açılmış noktalardan önceki zamana eklenir.
    pub demo_history: HashMap<u32, Vec<Value>>,
}

pub fn router(ctx: Arc<AppCtx>) -> Router {
    use tower_http::cors::{Any, CorsLayer};
    Router::new()
        .route("/v1/info", get(info))
        .route("/v1/notes", get(notes))
        .route("/v1/batches/{id}", get(batch))
        .route("/v1/orders", post(submit_order))
        .route("/v1/orders/{id}", get(order_status))
        .route("/v1/withdrawals", post(withdraw))
        .route("/v1/pools", get(pools))
        .route("/v1/pools/{id}/history", get(history))
        .route("/v1/news", get(news_list).post(news_post))
        .route("/v1/projects", post(register_project))
        // Tarayıcıdaki frontend farklı origin'den çağırır. Kimlik bilgisi (cookie) kullanılmaz.
        // allow_private_network: herkese açık bir siteden (ör. Vercel) yerel relayer'a gelen isteklerin ön kontrolü
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any).allow_private_network(true))
        .with_state(ctx)
}

fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- hata

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        // Revert'ler (ör. "UnknownRoot", "NullifierSpent") kullanıcı hatasıdır.
        ApiError(StatusCode::UNPROCESSABLE_ENTITY, format!("{e:#}"))
    }
}

// ---------------------------------------------------------------- hız sınırı

/// IP başına dakikada N yazma isteği (relayer gazı öder; kötüye kullanımı sınırlar).
pub struct RateLimiter {
    per_minute: u32,
    hits: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(per_minute: u32) -> Self {
        Self { per_minute, hits: Mutex::new(HashMap::new()) }
    }

    fn check(&self, ip: IpAddr) -> Result<(), ApiError> {
        let mut hits = self.hits.lock().unwrap();
        let now = Instant::now();
        let entry = hits.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) > Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 > self.per_minute {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "rate limit".into()));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- kanıt biçimi

/// Solidity sırasıyla Groth16 kanıtı (b koordinatları snarkjs'e göre ters çevrilmiş).
/// Sayılar ondalık ya da 0x-hex string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofDto {
    pub a: [String; 2],
    pub b: [[String; 2]; 2],
    pub c: [String; 2],
    pub root: String,
    pub nullifier: String,
    pub change_commitment: String,
    pub spend_commitment: String,
}

fn num(s: &str) -> Result<U256, ApiError> {
    U256::from_str(s).map_err(|_| bad(format!("invalid number: {s}")))
}

impl ProofDto {
    pub fn to_call(&self) -> Result<IDarkVault::SpendProof, ApiError> {
        Ok(IDarkVault::SpendProof {
            a: [num(&self.a[0])?, num(&self.a[1])?],
            b: [[num(&self.b[0][0])?, num(&self.b[0][1])?], [num(&self.b[1][0])?, num(&self.b[1][1])?]],
            c: [num(&self.c[0])?, num(&self.c[1])?],
            root: num(&self.root)?,
            nullifier: num(&self.nullifier)?,
            changeCommitment: num(&self.change_commitment)?,
            spendCommitment: num(&self.spend_commitment)?,
        })
    }
}

// ---------------------------------------------------------------- uçlar

async fn info(State(ctx): State<Arc<AppCtx>>) -> Result<Json<Value>, ApiError> {
    let chain = &ctx.chain;
    let enclave: Value = ctx
        .enclave
        .http
        .get(format!("{}/pubkey", ctx.enclave.url))
        .send()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?
        .json()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let addr = enclave["address"].as_str().and_then(|a| Address::from_str(a).ok());
    let registered = match addr {
        Some(a) => chain.registry.isEnclave(a).call().await.map_err(anyhow::Error::from)?,
        None => false,
    };
    let gateway = match &chain.gateway {
        Some(g) => {
            let rate = g.usdPerMon().call().await.map_err(anyhow::Error::from)?;
            use alloy::providers::Provider;
            let balance = chain.provider.get_balance(*g.address()).await.map_err(anyhow::Error::from)?;
            // usdPerMon: 1 MON başına dUSD birimi (6 ondalık); balance: MON çekim likiditesi (wei)
            Some(json!({ "address": g.address(), "usdPerMon": rate.to_string(), "balance": balance.to_string() }))
        }
        None => None,
    };
    let st = ctx.index.state.read().await;
    Ok(Json(json!({
        "chainId": chain.chain_id,
        "vault": chain.vault.address(),
        "quoteToken": chain.quote_token,
        "feeBps": chain.fee_bps,
        "relayer": chain.sender,
        // İstemci emri YALNIZCA registered=true ise bu anahtara şifrelemeli.
        "enclave": {
            "publicKey": enclave["public_key"], "address": enclave["address"], "registered": registered,
            // Enclave'in kendi beyanı; doğrulaması attestation (/attestation) ile yapılır.
            "provider": enclave["provider"], "hardwareBacked": enclave["hardware_backed"],
        },
        "finalizedBlock": st.finalized_block,
        "noteCount": st.notes.len(),
        "settledBatches": st.batches.len(),
        "genesisTime": chain.genesis_time,
        "windowSeconds": chain.window_seconds,
        "lockSeconds": dark_tee_core::timelock::LOCK_SECONDS,
        "finalizedTimestamp": st.finalized_timestamp,
        "launchpad": chain.launchpad.as_ref().map(|l| *l.address()),
        "launchMinQuote": match &chain.launchpad {
            Some(l) => l.minQuote().call().await.ok().map(|v| v.to_string()),
            None => None,
        },
        "gateway": gateway,
    })))
}

#[derive(Deserialize)]
struct NotesQuery {
    from: Option<usize>,
    limit: Option<usize>,
}

async fn notes(State(ctx): State<Arc<AppCtx>>, Query(q): Query<NotesQuery>) -> Json<Value> {
    let st = ctx.index.state.read().await;
    let from = q.from.unwrap_or(0).min(st.notes.len());
    let to = (from + q.limit.unwrap_or(5_000).min(50_000)).min(st.notes.len());
    Json(json!({
        "from": from,
        "total": st.notes.len(),
        "commitments": st.notes[from..to].iter().map(|c| format!("{c:#066x}")).collect::<Vec<_>>(),
    }))
}

async fn batch(State(ctx): State<Arc<AppCtx>>, Path(id): Path<u64>) -> Result<Json<Value>, ApiError> {
    let st = ctx.index.state.read().await;
    let b = st.batches.get(&id).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "unknown batch".into()))?;
    Ok(Json(json!({
        "batchId": b.batch_id,
        "window": b.window,
        "resultsRoot": b.results_root,
        "unlockRound": b.unlock_round,
        "unlockTime": b.unlock_time,
        "capsule": b.capsule,
        "sealedSummary": b.sealed_summary,
        // Kilit açıldıysa: K_b herkese açıktır; kullanıcı kendi sonucunu bununla + kendi anahtarıyla çözer.
        "kb": ctx.revealer.revealed.read().await.get(&id).map(|r| format!("0x{}", hex::encode(r.kb))),
        "results": b.results.iter().map(|r| json!({
            "orderId": r.orderId,
            "status": r.status,
            "commitment": r.commitment,
            "sealedResult": r.sealedResult,
        })).collect::<Vec<_>>(),
    })))
}

/// Kullanıcının kendi emrinin durumu: hangi batch'te, sonucu, kilit ve (açıldıysa) K_b.
/// Sonucun iç katmanı yalnızca emir sahibinin görüntüleme anahtarıyla açılır.
async fn order_status(State(ctx): State<Arc<AppCtx>>, Path(id): Path<B256>) -> Result<Json<Value>, ApiError> {
    let st = ctx.index.state.read().await;
    let submitted = st.windows.iter().find_map(|(w, rec)| rec.orders.iter().any(|o| o.order_id == id).then_some(*w));
    let Some(window) = submitted else {
        return Err(ApiError(StatusCode::NOT_FOUND, "order not indexed yet".into()));
    };
    for b in st.batches.values().filter(|b| b.window == window) {
        if let Some((i, r)) = b.results.iter().enumerate().find(|(_, r)| r.orderId == id) {
            let core = b.core_results();
            let leaves: Vec<[u8; 32]> = core.iter().map(|r| r.leaf()).collect();
            let kb = ctx.revealer.revealed.read().await.get(&b.batch_id).map(|r| format!("0x{}", hex::encode(r.kb)));
            return Ok(Json(json!({
                "orderId": id,
                "window": window,
                "windowEnd": ctx.chain.window_end(window),
                "batchId": b.batch_id,
                "status": r.status,
                "commitment": r.commitment,
                "sealedResult": r.sealedResult,
                "unlockTime": b.unlock_time,
                "kb": kb,
                "merkleProof": dark_tee_core::batch::merkle_proof(&leaves, i).iter().map(|p| format!("0x{}", hex::encode(p))).collect::<Vec<_>>(),
            })));
        }
    }
    Ok(Json(json!({ "orderId": id, "window": window, "windowEnd": ctx.chain.window_end(window), "batchId": null })))
}

#[derive(Deserialize)]
struct OrderReq {
    ciphertext: Bytes,
    proof: ProofDto,
}

async fn submit_order(
    State(ctx): State<Arc<AppCtx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<OrderReq>,
) -> Result<Json<Value>, ApiError> {
    ctx.limiter.check(peer.ip())?;
    if req.ciphertext.len() != dark_tee_core::order::CIPHERTEXT_LEN {
        return Err(bad("ciphertext length"));
    }
    let proof = req.proof.to_call()?;
    let order_id = B256::from(keccak(&req.ciphertext));
    let chain = &ctx.chain;
    let tx = chain
        .send(&format!("submitShieldedOrder {order_id}"), chain.vault.submitShieldedOrder(req.ciphertext, proof))
        .await?;
    Ok(Json(json!({ "orderId": order_id, "txHash": tx })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithdrawReq {
    proof: ProofDto,
    token: Address,
    amount: String,
    spend_blinding: String,
    recipient: Address,
    /// Verilirse çekim MON olarak yapılır: `recipient` = gateway.boxOf(redeemTo) olmalı; relayer
    /// çekimden sonra gateway.redeem(redeemTo) çağırır (gazı relayer öder).
    #[serde(default)]
    redeem_to: Option<Address>,
}

async fn withdraw(
    State(ctx): State<Arc<AppCtx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WithdrawReq>,
) -> Result<Json<Value>, ApiError> {
    ctx.limiter.check(peer.ip())?;
    let proof = req.proof.to_call()?;
    let amount = u128::try_from(num(&req.amount)?).map_err(|_| bad("amount exceeds u128"))?;
    let chain = &ctx.chain;
    if let Some(to) = req.redeem_to {
        let gw = chain.gateway.as_ref().ok_or_else(|| bad("MON çekimi bu dağıtımda yok"))?;
        let box_addr = gw.boxOf(to).call().await.map_err(anyhow::Error::from)?;
        if box_addr != req.recipient || req.token != chain.quote_token {
            return Err(bad("recipient must be gateway.boxOf(redeemTo) and token dUSD"));
        }
    }
    let tx = chain
        .send(
            &format!("withdraw -> {}", req.recipient),
            chain.vault.withdraw(proof, req.token, amount, num(&req.spend_blinding)?, req.recipient),
        )
        .await?;
    let (mut redeem_tx, mut redeem_error) = (None, None);
    if let (Some(to), Some(gw)) = (req.redeem_to, chain.gateway.as_ref()) {
        // Başarısız olursa (ör. gateway'de yeterli MON yok) dUSD kutuda güvende kalır ve
        // redeem(to) sonra herkes tarafından yeniden çağrılabilir.
        match chain.send(&format!("redeem MON -> {to}"), gw.redeem(to)).await {
            Ok(h) => redeem_tx = Some(h),
            Err(e) => {
                tracing::warn!(error = %e, %to, "redeem failed; dUSD stays in box");
                redeem_error = Some(e.to_string());
            }
        }
    }
    Ok(Json(json!({ "txHash": tx, "redeemTxHash": redeem_tx, "redeemError": redeem_error })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterProjectReq {
    pool_id: u32,
    /// LaunchPad.launch'a verilen metadataHash'in ön görüntüsü (tam JSON metni)
    metadata: String,
}

async fn register_project(
    State(ctx): State<Arc<AppCtx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<RegisterProjectReq>,
) -> Result<Json<Value>, ApiError> {
    ctx.limiter.check(peer.ip())?;
    let pad = ctx.chain.launchpad.as_ref().ok_or_else(|| bad("launchpad yok"))?;
    let l = pad.launches(req.pool_id).call().await.map_err(anyhow::Error::from)?;
    if l.creator == Address::ZERO {
        return Err(ApiError(StatusCode::NOT_FOUND, "no launch for this pool".into()));
    }
    let project = ctx
        .news
        .register_launched(req.pool_id, &req.metadata, l.metadataHash.0, l.creator)
        .map_err(|e| bad(e.to_string()))?;
    Ok(Json(json!({ "poolId": req.pool_id, "project": project })))
}

async fn token_meta(ctx: &AppCtx, token: Address) -> Value {
    if let Some(v) = ctx.tokens.lock().await.get(&token) {
        return v.clone();
    }
    let v = match ctx.chain.token_meta(token).await {
        Ok((name, symbol, decimals)) => json!({ "address": token, "name": name, "symbol": symbol, "decimals": decimals }),
        Err(_) => return json!({ "address": token }),
    };
    ctx.tokens.lock().await.insert(token, v.clone());
    v
}

async fn pools(State(ctx): State<Arc<AppCtx>>) -> Json<Value> {
    let metas: Vec<_> = ctx.index.state.read().await.pools.values().cloned().collect();
    let quote = token_meta(&ctx, ctx.chain.quote_token).await;
    let now = now_unix();
    let mut out = Vec::new();
    for p in metas {
        let news_24h = ctx.news.list(Some(p.pool_id), 1000).iter().filter(|n| n.timestamp + 86_400 >= now).count();
        out.push(json!({
            "poolId": p.pool_id,
            "base": token_meta(&ctx, p.base_token).await,
            "quote": quote,
            "createdAt": ctx.chain.window_end(p.window),
            // Havuz açılışı herkese açık bir işlemdir; sonrasındaki rezervler 7 gün gecikmeli açılır.
            "initialLiquidity": { "base": p.init_base.to_string(), "quote": p.init_quote.to_string() },
            "project": ctx.news.project(p.pool_id),
            "news24h": news_24h,
        }));
    }
    Json(json!({ "pools": out }))
}

/// Ghost chart: yalnızca kilidi açılmış (≥ 7 gün önceki) batch'lerin noktaları. Kilitli
/// batch'ler için yalnızca zaman ve açılış anı döner — fiyat/hacim bilgisi YOKTUR.
async fn history(State(ctx): State<Arc<AppCtx>>, Path(id): Path<u32>) -> Result<Json<Value>, ApiError> {
    let st = ctx.index.state.read().await;
    if !st.pools.contains_key(&id) {
        return Err(ApiError(StatusCode::NOT_FOUND, "unknown pool".into()));
    }
    let revealed = ctx.revealer.revealed.read().await;
    let mut points = Vec::new();
    let mut locked = Vec::new();
    for b in st.batches.values() {
        let time = ctx.chain.window_end(b.window);
        match revealed.get(&b.batch_id).and_then(|r| r.summary.pools.iter().find(|p| p.pool_id == id)) {
            Some(p) => points.push(json!({
                "batchId": b.batch_id,
                "time": time,
                "priceX18": p.price_x18.to_string(),
                "quoteIn": p.quote_in.to_string(),
                "baseIn": p.base_in.to_string(),
                "buyCount": p.buy_count,
                "sellCount": p.sell_count,
                "baseReserve": p.base_reserve.to_string(),
                "quoteReserve": p.quote_reserve.to_string(),
            })),
            None if !revealed.contains_key(&b.batch_id) => {
                locked.push(json!({ "batchId": b.batch_id, "time": time, "unlockTime": b.unlock_time }))
            }
            None => {} // bu havuz o batch'te henüz yoktu
        }
    }
    if let Some(demo) = ctx.demo_history.get(&id) {
        let first_real = points.first().and_then(|p| p["time"].as_u64()).unwrap_or(u64::MAX);
        let mut merged: Vec<Value> = demo.iter().filter(|p| p["time"].as_u64().is_some_and(|t| t < first_real)).cloned().collect();
        merged.append(&mut points);
        points = merged;
    }
    Ok(Json(json!({ "poolId": id, "windowSeconds": ctx.chain.window_seconds, "points": points, "locked": locked })))
}

#[derive(Deserialize)]
struct NewsQuery {
    pool: Option<u32>,
    limit: Option<usize>,
}

async fn news_list(State(ctx): State<Arc<AppCtx>>, Query(q): Query<NewsQuery>) -> Json<Value> {
    Json(json!({ "news": ctx.news.list(q.pool, q.limit.unwrap_or(50).min(500)) }))
}

async fn news_post(
    State(ctx): State<Arc<AppCtx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(post): Json<NewsPost>,
) -> Result<Json<Value>, ApiError> {
    ctx.limiter.check(peer.ip())?;
    let saved = ctx.news.add(post, now_unix()).map_err(|e| ApiError(StatusCode::FORBIDDEN, format!("{e:#}")))?;
    Ok(Json(json!({ "news": saved })))
}

fn keccak(b: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_accepts_decimal_and_hex() {
        let p = ProofDto {
            a: ["1".into(), "0x2".into()],
            b: [["3".into(), "4".into()], ["5".into(), "6".into()]],
            c: ["7".into(), "8".into()],
            root: "9".into(),
            nullifier: "0x0a".into(),
            change_commitment: "11".into(),
            spend_commitment: "12".into(),
        };
        let c = p.to_call().ok().unwrap();
        assert_eq!(c.a[1], U256::from(2));
        assert_eq!(c.nullifier, U256::from(10));
        let mut bad_p = p;
        bad_p.root = "xyz".into();
        assert!(bad_p.to_call().is_err());
    }

    #[test]
    fn rate_limiter_blocks_after_quota() {
        let l = RateLimiter::new(2);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(l.check(ip).is_ok());
        assert!(l.check(ip).is_ok());
        assert!(l.check(ip).is_err());
        assert!(l.check("10.0.0.2".parse().unwrap()).is_ok());
    }
}
