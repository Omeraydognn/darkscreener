//! HTTP katmanı testleri (ağ açmadan, router'a doğrudan istek).

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use dark_tee_attest::LocalDev;
use dark_tee_core::keys::recover_address;
use dark_tee_server::{
    api::{AttestationResponse, ProcessResponse, PubkeyResponse},
    app::{process_digest, router, AppState, RELAYER_SIG_HEADER},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> Router {
    router(Arc::new(AppState::new(Box::new(LocalDev::new(None))).unwrap()))
}

async fn call(app: &Router, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    let req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_default()).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn genesis() -> Value {
    json!({
        "chain_id": 10143,
        "vault": format!("0x{}", "77".repeat(20)),
        "batch_id": 1,
        "quote_token": format!("0x{}", "c0".repeat(20)),
        "fee_bps": 30,
        "new_pools": [{
            "pool_id": 1,
            "base_token": format!("0x{}", "aa".repeat(20)),
            "base": "1000000000000000000000000",
            "quote": "500000000000"
        }]
    })
}

#[tokio::test]
async fn pubkey_and_attestation_are_consistent() {
    let app = app();
    let (s, v) = call(&app, "GET", "/pubkey", None).await;
    assert_eq!(s, StatusCode::OK);
    let pk: PubkeyResponse = serde_json::from_value(v).unwrap();
    assert!(!pk.hardware_backed);
    assert_eq!(pk.provider, "local");

    let (s, v) = call(&app, "GET", "/attestation", None).await;
    assert_eq!(s, StatusCode::OK);
    let at: AttestationResponse = serde_json::from_value(v).unwrap();
    assert_eq!(at.report_data.0, pk.public_key_xy.0);
    assert_eq!(at.format, "none");
}

#[tokio::test]
async fn process_genesis_then_reject_replay() {
    let app = app();
    let (_, v) = call(&app, "GET", "/pubkey", None).await;
    let pk: PubkeyResponse = serde_json::from_value(v).unwrap();

    let (s, v) = call(&app, "POST", "/process", Some(genesis())).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let out: ProcessResponse = serde_json::from_value(v).unwrap();
    let digest = dark_tee_core::digest::Settlement::from(&out.settlement).digest();
    assert_eq!(recover_address(&digest, &out.signature.0).unwrap(), pk.address.0);

    // Aynı batch'i state ile tekrar göndermek 422
    let mut replay = genesis();
    replay["prev_sealed_state"] = json!(format!("0x{}", hex::encode(&out.new_sealed_state.0)));
    replay["new_pools"] = json!([]);
    let (s, v) = call(&app, "POST", "/process", Some(replay)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(v["error"].as_str().unwrap().contains("batch out of order"));
}

#[tokio::test]
async fn same_batch_cannot_be_forked() {
    let app = app();
    let (s, v1) = call(&app, "POST", "/process", Some(genesis())).await;
    assert_eq!(s, StatusCode::OK);

    // Aynı istek: yeniden işlenir (taze kilit/K_b), aynı girdi özetleri
    let (s, v2) = call(&app, "POST", "/process", Some(genesis())).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v1["settlement"]["pools_hash"], v2["settlement"]["pools_hash"]);
    assert_eq!(v1["settlement"]["orders_hash"], v2["settlement"]["orders_hash"]);

    // Aynı (batch_id, prev_state), farklı içerik: 409
    let mut fork = genesis();
    fork["new_pools"][0]["quote"] = json!("1");
    let (s, _) = call(&app, "POST", "/process", Some(fork)).await;
    assert_eq!(s, StatusCode::CONFLICT);
}

#[tokio::test]
async fn malformed_requests_are_rejected() {
    let app = app();

    let mut bad_amount = genesis();
    bad_amount["new_pools"][0]["base"] = json!(1000); // sayı değil string olmalı
    let (s, _) = call(&app, "POST", "/process", Some(bad_amount)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let mut bad_addr = genesis();
    bad_addr["vault"] = json!("0x1234");
    let (s, _) = call(&app, "POST", "/process", Some(bad_addr)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let mut unknown_field = genesis();
    unknown_field["unlock_round"] = json!(1000); // kilit turu girdiden alınamaz
    let (s, _) = call(&app, "POST", "/process", Some(unknown_field)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let mut bad_fee = genesis();
    bad_fee["fee_bps"] = json!(10_000);
    let (s, v) = call(&app, "POST", "/process", Some(bad_fee)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(v["error"].as_str().unwrap().contains("fee"));
}

#[tokio::test]
async fn process_requires_authorized_relayer_signature_when_configured() {
    let relayer = dark_tee_core::keys::EnclaveKey::generate();
    let stranger = dark_tee_core::keys::EnclaveKey::generate();
    let app = router(Arc::new(
        AppState::new(Box::new(LocalDev::new(None))).unwrap().with_relayers(vec![relayer.eth_address()]),
    ));
    let body = genesis().to_string();
    let send = |sig: Option<[u8; 65]>| {
        let mut req = Request::builder().method("POST").uri("/process").header("content-type", "application/json");
        if let Some(sig) = sig {
            req = req.header(RELAYER_SIG_HEADER, format!("0x{}", hex::encode(sig)));
        }
        app.clone().oneshot(req.body(Body::from(body.clone())).unwrap())
    };
    let digest = process_digest(body.as_bytes());

    assert_eq!(send(None).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let bad = stranger.sign_digest(&digest).unwrap();
    assert_eq!(send(Some(bad)).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    // Başka bir gövdenin imzası bu gövde için geçersiz
    let other = relayer.sign_digest(&process_digest(b"{}")).unwrap();
    assert_eq!(send(Some(other)).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let good = relayer.sign_digest(&digest).unwrap();
    assert_eq!(send(Some(good)).await.unwrap().status(), StatusCode::OK);
}
