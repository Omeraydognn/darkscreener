//! Solidity çapraz-uyum test vektörü (1. aşama): `contracts/test/fixtures/e2e.json`.
//!
//! Her şey gerçek: notlar Poseidon ile, emirler ECIES ile oluşturulur; batch'ler enclave
//! çekirdeğinde işlenip imzalanır; kapsül drand quicknet'in GERÇEK round 1000 imzasıyla
//! açılır; kullanıcı sonuçları kendi anahtarlarıyla çözülür.
//!
//! 2. aşama (`circuits/scripts/prove-fixture.mjs`) aynı dosyaya Groth16 kanıtlarını ekler.
//!
//! Tamamı için: `scripts/gen-fixture.sh`
//!
//! Foundry testinin izlediği sıra (not ağacı indeksleri buna bağlı):
//!   deposit × 5 (0..4) → submitShieldedOrder × 5 (para üstü 5..9) → settle
//!   → returnRefunded × 2 (10, 11) → [kilit açılır] → claimNote × 3 (12..14) → withdraw × 7

use anyhow::{ensure, Result};
use dark_tee_core::{
    batch::{
        merkle_proof, process_batch_locked_to, BatchContext, BatchInput, BatchOutput, EncryptedOrder, OrderStatus,
        PoolInit,
    },
    clearing::{FmAmm, Side},
    ecies,
    keys::EnclaveKey,
    note::{self, random_field, Field},
    order::{order_aad, Order, CIPHERTEXT_LEN},
    reveal,
};
use dark_tee_server::api::to_hex;
use k256::SecretKey;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const CHAIN_ID: u64 = 10143;
const VAULT: [u8; 20] = hex20("00000000000000000000000000000000da4c0001");
const USDC: [u8; 20] = hex20("00000000000000000000000000000000da4c0c01");
const TOKEN_A: [u8; 20] = hex20("00000000000000000000000000000000da4c0a01");
const TOKEN_B: [u8; 20] = hex20("00000000000000000000000000000000da4c0b01");
const FEE_BPS: u16 = 30;
const UNLOCK_ROUND: u64 = 1000;
const ROUND_1000_SIG: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
const E6: u128 = 1_000_000;
const E18: u128 = 1_000_000_000_000_000_000;

const fn hex20(s: &str) -> [u8; 20] {
    let b = s.as_bytes();
    let mut out = [0u8; 20];
    let mut i = 0;
    while i < 20 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("bad hex"),
    }
}

fn recipient(i: u8) -> [u8; 20] {
    let mut a = [0u8; 20];
    a[16..].copy_from_slice(&[0xda, 0x4c, 0x0e, i]);
    a
}

fn ctx(batch_id: u64) -> BatchContext {
    BatchContext { chain_id: CHAIN_ID, vault: VAULT, batch_id, quote_token: USDC, fee_bps: FEE_BPS }
}

fn f(v: &Field) -> String {
    to_hex(v)
}

/// Bir kullanıcının kimliği ve yatırdığı not.
struct User {
    ecies: SecretKey,
    spend_key: Field,
    owner: Field,
    token: [u8; 20],
    amount: u128,
    blinding: Field,
}

impl User {
    fn new(token: [u8; 20], amount: u128) -> Result<Self> {
        let spend_key = random_field();
        Ok(Self {
            ecies: SecretKey::random(&mut OsRng),
            owner: note::owner(&spend_key)?,
            spend_key,
            token,
            amount,
            blinding: random_field(),
        })
    }
}

/// Kullanıcının harcadığı not parçası. `spend_r` ile spend_blinding = secretHash(owner, spend_r):
/// spendCommitment kendisi de kullanıcıya ait bir nottur (iade/kaçışta ağaca aynen döner).
struct Spend {
    user: usize,
    side: Side,
    pool_id: u32,
    order_amount: u128,
    spend_amount: u128,
    spend_r: Field,
    spend_blinding: Field,
    change_blinding: Field,
    ciphertext: Vec<u8>,
    spend_commitment: Field,
}

fn main() -> Result<()> {
    let beacon = hex::decode(ROUND_1000_SIG)?;
    let enclave = EnclaveKey::from_seed(&[0x5e; 32]);

    // ------------------------------------------------ batch 1: havuzlar
    let pools = vec![
        PoolInit { pool_id: 1, base_token: TOKEN_A, base: 1_000_000 * E18, quote: 500_000 * E6 },
        PoolInit { pool_id: 2, base_token: TOKEN_B, base: 10_000 * E18, quote: 2_000_000 * E6 },
    ];
    let b1_input = BatchInput { ctx: ctx(1), prev_sealed_state: None, new_pools: pools.clone(), orders: vec![] };
    let b1 = process_batch_locked_to(&enclave, &FmAmm, &b1_input, UNLOCK_ROUND)?;

    // ------------------------------------------------ yatırmalar (not ağacı 0..4)
    let users = [
        User::new(USDC, 100 * E6)?,    // alice: 100 USDC'nin hepsiyle A alır
        User::new(TOKEN_B, 5 * E18)?,  // bob: 5 B satar
        User::new(USDC, 3_000 * E6)?,  // carol: 3000 USDC'nin 2500'üyle B alır (500 para üstü)
        User::new(USDC, 5 * E6)?,      // mallory: 1 USDC harcar ama emirde 1000 der -> iade
        User::new(USDC, 2 * E6)?,      // dave: 2 USDC harcar, ciphertext çöp -> iade
    ];

    let aad = order_aad(CHAIN_ID, &VAULT);
    let mut spends = Vec::new();
    for (user, side, pool_id, order_amount, spend_amount, garbage) in [
        (0usize, Side::Buy, 1u32, 100 * E6, 100 * E6, false),
        (1, Side::Sell, 2, 5 * E18, 5 * E18, false),
        (2, Side::Buy, 2, 2_500 * E6, 2_500 * E6, false),
        (3, Side::Buy, 1, 1_000 * E6, E6, false),
        (4, Side::Buy, 1, 2 * E6, 2 * E6, true),
    ] {
        let u = &users[user];
        let spend_r = random_field();
        let spend_blinding = note::secret_hash(&u.owner, &spend_r)?;
        let ciphertext = if garbage {
            let mut g = vec![0u8; CIPHERTEXT_LEN];
            OsRng.fill_bytes(&mut g);
            g[0] = ecies::VERSION;
            g
        } else {
            let o = Order {
                side,
                pool_id,
                amount_in: order_amount,
                recipient: u.ecies.public_key(),
                spend_blinding,
                owner: u.owner,
            };
            ecies::encrypt(&enclave.public_key(), &o.encode(), &aad)?
        };
        spends.push(Spend {
            user,
            side,
            pool_id,
            order_amount,
            spend_amount,
            spend_r,
            spend_blinding,
            change_blinding: random_field(),
            spend_commitment: note::spend_commitment(&u.token, spend_amount, &spend_blinding)?,
            ciphertext,
        });
    }

    // ------------------------------------------------ batch 2: emirler
    let b2_input = BatchInput {
        ctx: ctx(2),
        prev_sealed_state: Some(b1.new_sealed_state.clone()),
        new_pools: vec![],
        orders: spends
            .iter()
            .map(|s| EncryptedOrder { ciphertext: s.ciphertext.clone(), spend_commitment: s.spend_commitment })
            .collect(),
    };
    let b2 = process_batch_locked_to(&enclave, &FmAmm, &b2_input, UNLOCK_ROUND)?;
    let b2_kb = reveal::open_capsule(&b2.capsule, &beacon)?;
    let statuses: Vec<_> = b2.results.iter().map(|r| r.status as u8).collect();
    ensure!(statuses == vec![1, 1, 1, 2, 2], "unexpected statuses {statuses:?}");

    let summary = reveal::open_summary(&b2_kb, 2, &b2.sealed_summary)?;
    ensure!(reveal::reserves_commitment(2, &summary.salt, &summary.pools) == b2.settlement.reserves_commitment);

    // ------------------------------------------------ sonuçlar + kullanıcıların açtığı notlar
    let leaves: Vec<[u8; 32]> = b2.results.iter().map(|r| r.leaf()).collect();
    let mut results_json = Vec::new();
    let mut outcomes = Vec::new();
    for (i, r) in b2.results.iter().enumerate() {
        let mut entry = result_entry(r, &merkle_proof(&leaves, i));
        if r.status == OrderStatus::Filled {
            let u = &users[spends[i].user];
            let inner = reveal::open_result_outer(&b2_kb, &r.order_id, &r.sealed_result)?;
            let outcome = reveal::open_result(&u.ecies, &r.order_id, &inner)?;
            ensure!(outcome.commitment()? == r.output_commitment && outcome.owner == u.owner);
            entry["outToken"] = json!(to_hex(&outcome.out_token));
            entry["amountOut"] = json!(outcome.amount_out.to_string());
            entry["blinding"] = json!(f(&outcome.blinding));
            outcomes.push((i, outcome));
        }
        results_json.push(entry);
    }

    // ------------------------------------------------ çekimler (sıfır olmayan tüm notlar)
    // kind: change (para üstü), returned (iade edilen spendCommitment), output (enclave notu)
    let mut withdrawals = Vec::new();
    let mut w = |kind: &str, order: usize, u: &User, token: [u8; 20], amount: u128, blinding: &Field| {
        let rcpt = recipient(withdrawals.len() as u8 + 1);
        withdrawals.push(json!({
            "kind": kind,
            "order": order,
            "token": to_hex(&token),
            "amount": amount.to_string(),
            "spendKey": f(&u.spend_key),
            "blinding": f(blinding),
            "recipient": to_hex(&rcpt),
            "ctxHash": f(&note::withdraw_context(CHAIN_ID, &VAULT, &rcpt)),
            "spendBlinding": f(&random_field()),
        }));
    };
    for (i, s) in spends.iter().enumerate() {
        let u = &users[s.user];
        if u.amount > s.spend_amount {
            w("change", i, u, u.token, u.amount - s.spend_amount, &s.change_blinding);
        }
    }
    for (i, s) in spends.iter().enumerate() {
        if b2.results[i].status == OrderStatus::Refunded {
            w("returned", i, &users[s.user], users[s.user].token, s.spend_amount, &s.spend_r);
        }
    }
    for (i, o) in &outcomes {
        w("output", *i, &users[spends[*i].user], o.out_token, o.amount_out, &o.blinding);
    }

    // ------------------------------------------------ geç emir (kaçış testi): carol'ın para üstünü harcar
    let carol = &users[2];
    let late_r = random_field();
    let late_blinding = note::secret_hash(&carol.owner, &late_r)?;
    let late_ct = {
        let o = Order {
            side: Side::Buy,
            pool_id: 1,
            amount_in: 100 * E6,
            recipient: carol.ecies.public_key(),
            spend_blinding: late_blinding,
            owner: carol.owner,
        };
        ecies::encrypt(&enclave.public_key(), &o.encode(), &aad)?
    };

    let fixture = json!({
        "_comment": "scripts/gen-fixture.sh ile üretildi; elle düzenlemeyin",
        "chainId": CHAIN_ID,
        "vault": to_hex(&VAULT),
        "usdc": to_hex(&USDC),
        "tokenA": to_hex(&TOKEN_A),
        "tokenB": to_hex(&TOKEN_B),
        "feeBps": FEE_BPS,
        "enclave": to_hex(&enclave.eth_address()),
        "pools": pools.iter().map(|p| json!({
            "poolId": p.pool_id,
            "baseToken": to_hex(&p.base_token),
            "base": p.base.to_string(),
            "quote": p.quote.to_string(),
        })).collect::<Vec<_>>(),
        "notes": users.iter().map(|u| -> Result<Value> { Ok(json!({
            "token": to_hex(&u.token),
            "amount": u.amount.to_string(),
            "spendKey": f(&u.spend_key),
            "blinding": f(&u.blinding),
            "secretHash": f(&note::secret_hash(&u.owner, &u.blinding)?),
            // yalnızca SDK çapraz testi için (kullanıcının sonuç çözme anahtarı)
            "eciesSecret": to_hex(&u.ecies.to_bytes()),
        })) }).collect::<Result<Vec<_>>>()?,
        "noteCount": users.len(),
        "orders": spends.iter().map(|s| json!({
            "note": s.user,
            "side": s.side as u8,
            "poolId": s.pool_id,
            "orderAmount": s.order_amount.to_string(),
            "spendAmount": s.spend_amount.to_string(),
            "spendBlinding": f(&s.spend_blinding),
            "spendR": f(&s.spend_r),
            "changeBlinding": f(&s.change_blinding),
            "spendCommitment": f(&s.spend_commitment),
            "ciphertext": to_hex(&s.ciphertext),
            "ctxHash": f(&note::order_context(&s.ciphertext)),
        })).collect::<Vec<_>>(),
        "orderCount": spends.len(),
        "batch1": batch_json(&b1, vec![]),
        "batch2": batch_json(&b2, results_json),
        // yalnızca SDK çapraz testi için: drand round 1000 ile açılmış batch anahtarı
        "batch2Kb": to_hex(b2_kb.as_ref()),
        "batch2Summary": {
            "salt": to_hex(&summary.salt),
            "poolCount": summary.pools.len(),
            "pools": summary.pools.iter().map(|e| json!({
                "poolId": e.pool_id,
                "priceX18": e.price_x18.to_string(),
                "quoteIn": e.quote_in.to_string(),
                "baseIn": e.base_in.to_string(),
                "baseReserve": e.base_reserve.to_string(),
                "quoteReserve": e.quote_reserve.to_string(),
            })).collect::<Vec<_>>(),
        },
        "withdrawalCount": withdrawals.len(),
        "withdrawals": withdrawals,
        "lateOrder": {
            "note": "change:2",
            "spendAmount": (100 * E6).to_string(),
            "spendBlinding": f(&late_blinding),
            "changeBlinding": f(&random_field()),
            "spendCommitment": f(&note::spend_commitment(&USDC, 100 * E6, &late_blinding)?),
            "ciphertext": to_hex(&late_ct),
            "ctxHash": f(&note::order_context(&late_ct)),
        },
    });
    println!("{}", serde_json::to_string_pretty(&fixture)?);
    Ok(())
}

fn result_entry(r: &dark_tee_core::batch::OrderResult, proof: &[[u8; 32]]) -> Value {
    json!({
        "orderId": to_hex(&r.order_id),
        "status": r.status as u8,
        "commitment": to_hex(&r.output_commitment),
        "sealedResult": to_hex(&r.sealed_result),
        "sealedResultHash": to_hex(&Keccak256::digest(&r.sealed_result)),
        "proof": proof.iter().map(|p| to_hex(p)).collect::<Vec<_>>(),
    })
}

fn batch_json(out: &BatchOutput, mut results: Vec<Value>) -> Value {
    if results.is_empty() {
        let leaves: Vec<[u8; 32]> = out.results.iter().map(|r| r.leaf()).collect();
        results = out.results.iter().enumerate().map(|(i, r)| result_entry(r, &merkle_proof(&leaves, i))).collect();
    }
    json!({
        "batchId": out.settlement.batch_id,
        "unlockRound": out.settlement.unlock_round,
        "newSealedState": to_hex(&out.new_sealed_state),
        "capsule": to_hex(&out.capsule),
        "sealedSummary": to_hex(&out.sealed_summary),
        "signature": to_hex(&out.signature),
        "digest": to_hex(&out.settlement.digest()),
        "resultsRoot": to_hex(&out.settlement.results_root),
        "ordersHash": to_hex(&out.settlement.orders_hash),
        "poolsHash": to_hex(&out.settlement.pools_hash),
        "reservesCommitment": to_hex(&out.settlement.reserves_commitment),
        "resultCount": results.len(),
        "results": results,
    })
}
