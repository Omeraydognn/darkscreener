//! Router: çekirdeği ve TEE sağlayıcısını birleştiren tek yer.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use dark_tee_attest::TeeProvider;
use dark_tee_core::{
    batch::{process_batch, BatchInput, OrderStatus},
    clearing::FmAmm,
    keys::{recover_address, EnclaveKey},
    Error as CoreError,
};

use sha3::{Digest, Keccak256};

use crate::api::{AttestationResponse, Bytes, ErrorResponse, Fixed, ProcessRequest, ProcessResponse, PubkeyResponse};

/// 2048 emir × ~330 bayt hex + havuz durumu için yeterli.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

pub struct AppState {
    pub key: EnclaveKey,
    pub provider: Box<dyn TeeProvider>,
    forks: Mutex<ForkGuard>,
    /// Boş değilse `/process` yalnızca bu adreslerden birinin imzaladığı istekleri kabul eder.
    relayers: Vec<[u8; 20]>,
}

/// `/process` isteğini imzalayan başlık: hex(r || s || v), özet = `process_digest(body)`.
pub const RELAYER_SIG_HEADER: &str = "x-relayer-signature";

/// keccak("darkpool/process/v1" || gövde) — relayer ile aynı tanım.
pub fn process_digest(body: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(b"darkpool/process/v1");
    h.update(body);
    h.finalize().into()
}

impl AppState {
    pub fn new(provider: Box<dyn TeeProvider>) -> anyhow::Result<Self> {
        let seed = provider.key_seed()?;
        let key = if provider.key_is_direct() {
            EnclaveKey::from_bytes(&seed).map_err(|e| anyhow::anyhow!("TEE key: {e}"))?
        } else {
            EnclaveKey::from_seed(&seed)
        };
        Ok(Self { key, provider, forks: Mutex::new(ForkGuard::default()), relayers: Vec::new() })
    }

    /// Enclave herkese açık bir ağdayken (Oyster CVM) `/process`'i yetkili relayer'lara kısıtlar.
    /// Yoksa herhangi biri relayer'dan önce bir batch için emir alt kümesi göndererek fork
    /// koruyucusunu kilitleyebilir (settle'ı durdurma saldırısı).
    pub fn with_relayers(mut self, relayers: Vec<[u8; 20]>) -> Self {
        self.relayers = relayers;
        self
    }

    fn authorize(&self, headers: &HeaderMap, body: &[u8]) -> Result<(), ApiError> {
        if self.relayers.is_empty() {
            return Ok(());
        }
        let unauthorized = |m: &str| ApiError(StatusCode::UNAUTHORIZED, m.to_string());
        let hex = headers
            .get(RELAYER_SIG_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| unauthorized("missing relayer signature"))?;
        let raw = hex::decode(hex.trim_start_matches("0x")).map_err(|_| unauthorized("bad signature encoding"))?;
        let sig: [u8; 65] = raw.try_into().map_err(|_| unauthorized("bad signature length"))?;
        let signer = recover_address(&process_digest(body), &sig).map_err(|_| unauthorized("bad signature"))?;
        if !self.relayers.contains(&signer) {
            return Err(unauthorized("signer is not an authorized relayer"));
        }
        Ok(())
    }
}

/// Aynı `(batch_id, prev_state_hash)` için yalnızca TEK emir kümesi imzalanır.
///
/// Enclave durumsuz olduğundan, koruma olmadan bir relayer aynı batch'i hedef emirli ve
/// hedef emirsiz iki kez işletip 7 gün sonra iki özetin farkından tek bir kullanıcının
/// emir büyüklüğünü çıkarabilirdi. Farklı emir kümesi 409 alır.
///
/// AYNI istek yeniden işlenir (yeni K_b, yeni kilit turu): aynı emir kümesinin iki çıktısı
/// hiçbir fark sızdırmaz, ve settle gecikip `UnlockTooEarly` ile reddedilirse relayer taze
/// bir kilit turuyla yeniden deneyebilir (önbellekteki eski yanıt batch'i kilitlerdi).
///
/// Bellek içidir; enclave restart'ında sıfırlanır. Enclave'in /process ucu yalnızca relayer'a
/// açık olmalıdır (Oyster CVM'de ağ kuralı).
#[derive(Default)]
struct ForkGuard {
    seen: HashMap<(u64, [u8; 32]), [u8; 32]>,
    order: VecDeque<(u64, [u8; 32])>,
}

const FORK_GUARD_CAPACITY: usize = 256;

impl ForkGuard {
    /// `true` = izinli (yeni veya aynı istek), `false` = farklı emir kümesi (fork girişimi).
    fn allows(&self, key: &(u64, [u8; 32]), request_hash: &[u8; 32]) -> bool {
        self.seen.get(key).is_none_or(|h| h == request_hash)
    }

    fn record(&mut self, key: (u64, [u8; 32]), request_hash: [u8; 32]) {
        if self.seen.insert(key, request_hash).is_none() {
            self.order.push_back(key);
            if self.order.len() > FORK_GUARD_CAPACITY {
                if let Some(old) = self.order.pop_front() {
                    self.seen.remove(&old);
                }
            }
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({ "status": "ok" })) }))
        .route("/pubkey", get(pubkey))
        .route("/attestation", get(attestation))
        .route("/process", post(process))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorResponse { error: self.1 })).into_response()
    }
}

impl From<CoreError> for ApiError {
    fn from(e: CoreError) -> Self {
        let status = match e {
            CoreError::EncryptionFailed | CoreError::SigningFailed | CoreError::TimelockFailed => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            // Girdi kaynaklı: bozuk/yabancı state, sıra dışı batch, geçersiz havuz/fee, fazla emir.
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        ApiError(status, e.to_string())
    }
}

fn fork_conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "batch already processed with a different order set".into())
}

async fn pubkey(State(st): State<Arc<AppState>>) -> Json<PubkeyResponse> {
    Json(PubkeyResponse {
        public_key: Fixed(st.key.public_key_compressed()),
        public_key_xy: Fixed(st.key.public_key_xy()),
        address: Fixed(st.key.eth_address()),
        provider: st.provider.name().to_string(),
        hardware_backed: st.provider.is_hardware_backed(),
    })
}

async fn attestation(State(st): State<Arc<AppState>>) -> Result<Json<AttestationResponse>, ApiError> {
    let report_data = st.key.public_key_xy();
    let doc = st
        .provider
        .attest(&report_data)
        .map_err(|e| ApiError(StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    Ok(Json(AttestationResponse {
        provider: doc.provider.to_string(),
        format: doc.format.to_string(),
        hardware_backed: st.provider.is_hardware_backed(),
        report_data: Fixed(report_data),
        document: Bytes(doc.document),
    }))
}

async fn process(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<ProcessResponse>, ApiError> {
    st.authorize(&headers, &body)?;
    let req: ProcessRequest =
        serde_json::from_slice(&body).map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    let now = st
        .provider
        .trusted_unix_time()
        .map_err(|e| ApiError(StatusCode::SERVICE_UNAVAILABLE, e.to_string()))?;
    let request_hash: [u8; 32] = Keccak256::digest(
        serde_json::to_vec(&req).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    )
    .into();
    let input: BatchInput = req.into();
    let batch_id = input.ctx.batch_id;
    let orders = input.orders.len();
    let prev_hash = input
        .prev_sealed_state
        .as_deref()
        .map(dark_tee_core::state::state_hash)
        .unwrap_or([0u8; 32]);
    let fork_key = (batch_id, prev_hash);

    // Kilit, kontrol ile kayıt arasında tutulmaz (işlem saniyeler sürebilir); iki eşzamanlı
    // farklı istek yarışırsa kayıt anında ikincisi reddedilir, yanıtı dışarı verilmez.
    if !st.forks.lock().unwrap().allows(&fork_key, &request_hash) {
        tracing::warn!(batch_id, "fork attempt rejected");
        return Err(fork_conflict());
    }
    let st2 = st.clone();

    // tlock (BLS pairing) ve ECIES CPU-yoğun: async çalışanı bloklamasın.
    let out = tokio::task::spawn_blocking(move || process_batch(&st2.key, &FmAmm, &input, now))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match out {
        Ok(out) => {
            let filled = out.results.iter().filter(|r| r.status == OrderStatus::Filled).count();
            let resp: ProcessResponse = out.into();
            {
                let mut forks = st.forks.lock().unwrap();
                if !forks.allows(&fork_key, &request_hash) {
                    return Err(fork_conflict());
                }
                forks.record(fork_key, request_hash);
            }
            tracing::info!(batch_id, orders, filled, unlock_round = resp.settlement.unlock_round, "batch processed");
            Ok(Json(resp))
        }
        Err(e) => {
            tracing::warn!(batch_id, orders, error = %e, "batch rejected");
            Err(e.into())
        }
    }
}
