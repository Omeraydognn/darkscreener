//! Yerel duman testi: çalışan bir enclave sunucusuna kullanıcı + relayer gibi davranır
//! ve her yanıtı Faz 2 kontratının yapacağı kontrollerle doğrular.
//!
//! `DEV_CLIENT_URL` (varsayılan http://127.0.0.1:8080)
//!
//! Akış:
//! 1. /pubkey  -> adres, public_key_xy'den bağımsız olarak doğrulanır
//! 2. batch 1  -> iki havuz açılır (genesis)
//! 3. batch 2  -> 3 dürüst kullanıcı + 1 yalancı + 1 çöp ciphertext
//! 4. batch 2 tekrar -> 422 beklenir (replay)
//!
//! Kilit 7 gün sonra açılacağı için sonuç miktarları burada görülemez; bu bilinçli.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, ensure, Context, Result};
use dark_tee_core::{
    batch::{orders_hash, pools_hash, results_root, BatchInput, OrderResult},
    clearing::Side,
    digest::Settlement,
    ecies,
    keys::recover_address,
    note::{random_field, spend_commitment},
    order::{order_aad, Order},
    timelock,
};
use dark_tee_server::api::{
    to_hex, Amount, Bytes, Fixed, OrderDto, PoolInitDto, ProcessRequest, ProcessResponse, PubkeyResponse, StatusDto,
};
use k256::{PublicKey, SecretKey};
use rand_core::OsRng;
use sha3::{Digest, Keccak256};

const CHAIN_ID: u64 = 10143; // Monad testnet
const VAULT: [u8; 20] = [0x77; 20];
const USDC: [u8; 20] = [0xC0; 20];
const TOKEN_A: [u8; 20] = [0xAA; 20];
const TOKEN_B: [u8; 20] = [0xBB; 20];
const E6: u128 = 1_000_000;
const E18: u128 = 1_000_000_000_000_000_000;

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

/// Kullanıcı emri. `funding` = kullanıcının ZK kanıtıyla harcadığı not parçası (token, miktar);
/// kontrat yalnızca bunun Poseidon commitment'ını bilir.
fn order(
    enclave_pk: &PublicKey,
    user: &SecretKey,
    side: Side,
    pool_id: u32,
    amount: u128,
    funding: ([u8; 20], u128),
) -> Result<OrderDto> {
    let spend_blinding = random_field();
    let o = Order { side, pool_id, amount_in: amount, recipient: user.public_key(), spend_blinding, owner: random_field() };
    Ok(OrderDto {
        ciphertext: Bytes(ecies::encrypt(enclave_pk, &o.encode(), &order_aad(CHAIN_ID, &VAULT))?),
        spend_commitment: Fixed(spend_commitment(&funding.0, funding.1, &spend_blinding)?),
    })
}

fn request(batch_id: u64, prev: Option<&ProcessResponse>, pools: Vec<PoolInitDto>, orders: Vec<OrderDto>) -> ProcessRequest {
    ProcessRequest {
        chain_id: CHAIN_ID,
        vault: Fixed(VAULT),
        batch_id,
        quote_token: Fixed(USDC),
        fee_bps: 30,
        prev_sealed_state: prev.map(|p| p.new_sealed_state.clone()),
        new_pools: pools,
        orders,
    }
}

fn post(url: &str, req: &ProcessRequest) -> Result<ProcessResponse, ureq::Error> {
    ureq::post(format!("{url}/process")).send_json(req)?.body_mut().read_json()
}

/// Faz 2 kontratının `settleBatch` içinde yapacağı kontrollerin aynısı.
fn verify(resp: &ProcessResponse, req: &ProcessRequest, enclave: [u8; 20], prev_state_hash: [u8; 32]) -> Result<()> {
    let s = Settlement::from(&resp.settlement);
    // Kontrat bunları kendi kayıtlarından hesaplar; relayer'ın TEE'ye verdiğiyle aynı olmalı.
    let input: BatchInput = req.clone().into();
    ensure!(s.orders_hash == orders_hash(&input.orders), "orders_hash mismatch");
    ensure!(s.pools_hash == pools_hash(&input.new_pools), "pools_hash mismatch");
    ensure!(s.quote_token == USDC && s.fee_bps == 30, "quote/fee binding mismatch");
    let expected_orders = input.orders.len();
    ensure!(s.digest() == resp.settlement.digest.0, "digest mismatch");
    ensure!(recover_address(&s.digest(), &resp.signature.0)? == enclave, "signature not from enclave");
    ensure!(s.chain_id == CHAIN_ID && s.vault == VAULT, "wrong chain/vault binding");
    ensure!(s.prev_state_hash == prev_state_hash, "state chain broken");
    ensure!(s.new_state_hash == keccak(&resp.new_sealed_state.0), "new_state_hash mismatch");
    ensure!(s.capsule_hash == keccak(&resp.capsule.0), "capsule_hash mismatch");
    ensure!(s.summary_hash == keccak(&resp.sealed_summary.0), "summary_hash mismatch");
    ensure!(resp.results.len() == expected_orders, "result count mismatch");
    let results: Vec<OrderResult> = resp.results.iter().map(OrderResult::from).collect();
    ensure!(s.results_root == results_root(&results), "results_root mismatch");

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    ensure!(
        s.unlock_round >= timelock::round_at(now + timelock::LOCK_SECONDS),
        "unlock round shorter than 7 days"
    );
    ensure!(timelock::capsule_round(&resp.capsule.0)? == s.unlock_round, "capsule locked to a different round");
    Ok(())
}

fn main() -> Result<()> {
    let url = std::env::var("DEV_CLIENT_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".into());

    // 1. enclave kimliği
    // Container ilk açılışta birkaç saniye alabilir.
    let mut attempt = 0;
    let pk: PubkeyResponse = loop {
        match ureq::get(format!("{url}/pubkey")).call() {
            Ok(mut r) => break r.body_mut().read_json()?,
            Err(e) if attempt < 30 => {
                attempt += 1;
                eprintln!("sunucu bekleniyor ({attempt}/30): {e}");
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            Err(e) => return Err(e).context("sunucuya ulaşılamadı"),
        }
    };
    let derived = &keccak(&pk.public_key_xy.0)[12..];
    ensure!(derived == pk.address.0, "address does not match public_key_xy");
    let enclave_pk = PublicKey::from_sec1_bytes(&pk.public_key.0)?;
    ensure!(
        dark_tee_core::keys::eth_address(&enclave_pk) == pk.address.0,
        "public_key and public_key_xy disagree"
    );
    println!("enclave  {} (provider={}, hardware_backed={})", to_hex(&pk.address.0), pk.provider, pk.hardware_backed);

    // 2. genesis
    let genesis = request(
        1,
        None,
        vec![
            PoolInitDto { pool_id: 1, base_token: Fixed(TOKEN_A), base: Amount(1_000_000 * E18), quote: Amount(500_000 * E6) },
            PoolInitDto { pool_id: 2, base_token: Fixed(TOKEN_B), base: Amount(10_000 * E18), quote: Amount(2_000_000 * E6) },
        ],
        vec![],
    );
    let b1 = post(&url, &genesis)?;
    verify(&b1, &genesis, pk.address.0, [0u8; 32])?;
    println!("batch 1  ok  state={} unlock_round={}", to_hex(&b1.settlement.new_state_hash.0), b1.settlement.unlock_round);

    // 3. gerçek emirler
    let users: Vec<SecretKey> = (0..4).map(|_| SecretKey::random(&mut OsRng)).collect();
    let orders = vec![
        order(&enclave_pk, &users[0], Side::Buy, 1, 100 * E6, (USDC, 100 * E6))?,
        order(&enclave_pk, &users[1], Side::Sell, 2, 5 * E18, (TOKEN_B, 5 * E18))?,
        order(&enclave_pk, &users[2], Side::Buy, 2, 2_500 * E6, (USDC, 2_500 * E6))?,
        // yalancı: emirde 1000 USDC diyor, kanıtla 1 USDC harcadı
        order(&enclave_pk, &users[3], Side::Buy, 1, 1_000 * E6, (USDC, E6))?,
        // çöp
        OrderDto {
            ciphertext: Bytes(vec![0xFF; dark_tee_core::order::CIPHERTEXT_LEN]),
            spend_commitment: Fixed([1; 32]),
        },
    ];
    let req2 = request(2, Some(&b1), vec![], orders);
    let b2 = post(&url, &req2)?;
    verify(&b2, &req2, pk.address.0, b1.settlement.new_state_hash.0)?;
    let statuses: Vec<StatusDto> = b2.results.iter().map(|r| r.status).collect();
    use StatusDto::*;
    ensure!(
        statuses == vec![Filled, Filled, Filled, Refunded, Refunded],
        "unexpected statuses: {statuses:?}"
    );
    let sizes: Vec<usize> = b2.results.iter().filter(|r| r.status == Filled).map(|r| r.sealed_result.0.len()).collect();
    ensure!(sizes.windows(2).all(|w| w[0] == w[1]), "filled results must be equal size");
    let opens = timelock::round_time(b2.settlement.unlock_round);
    println!(
        "batch 2  ok  statuses={statuses:?} sealed_result={}B unlock_round={} (unix {opens}, ~{:.1} gün sonra)",
        sizes[0],
        b2.settlement.unlock_round,
        (opens as f64 - SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as f64) / 86_400.0
    );

    // 4a. relayer retry: aynı istek yeniden işlenir (taze kilit turu), girdi özetleri aynı
    let again = post(&url, &req2)?;
    verify(&again, &req2, pk.address.0, b1.settlement.new_state_hash.0)?;
    ensure!(again.settlement.orders_hash == b2.settlement.orders_hash, "retry must cover the same orders");
    println!("retry    ok  (aynı emir kümesi yeniden işlendi)");

    // 4b. fork denemesi: aynı batch, bir emir çıkarılmış -> 409
    let mut fork = req2.clone();
    fork.orders.remove(0);
    match post(&url, &fork) {
        Err(ureq::Error::StatusCode(409)) => println!("fork     ok  (409 reddedildi)"),
        Ok(_) => bail!("fork of batch 2 was signed"),
        Err(e) => bail!("unexpected error on fork: {e}"),
    }

    // 4c. eski state ile yanlış batch numarası -> 422
    let stale = request(3, Some(&b1), vec![], vec![]);
    match post(&url, &stale) {
        Err(ureq::Error::StatusCode(422)) => println!("stale    ok  (422 reddedildi)"),
        Ok(_) => bail!("stale state accepted"),
        Err(e) => bail!("unexpected error on stale state: {e}"),
    }

    println!("\nTÜM KONTROLLER GEÇTİ");
    Ok(())
}
