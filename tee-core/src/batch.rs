//! Uçtan uca batch işleme: enclave'in tek giriş noktası.
//!
//! ```text
//! zincir (BatchSealed) ──► relayer ──► process_batch ──► relayer ──► settleBatch()
//!   sealed state            BatchInput    (enclave)     BatchOutput   ecrecover + kontroller
//! ```
//!
//! Adımlar:
//! 1. Önceki sealed state'i çöz, `batch_nonce + 1 == batch_id` kontrol et (replay yok).
//! 2. Kontrattan gelen yeni havuzları ekle (havuz açılışı herkese açık bir işlemdir).
//! 3. Her emri çöz ve fonlamasını doğrula: zincirdeki `spendCommitment` (kullanıcının ZK
//!    kanıtıyla harcadığı notun parçası), emirdeki açılışla yeniden hesaplanmalı.
//!    Geçersiz emir tek başına `Refunded` olur, batch durmaz (tek bozuk ciphertext ile
//!    sistemi kilitleme saldırısı böylece engellenir). Kullanıcı fonunu açılışı
//!    zincire vererek geri alır.
//! 4. Her havuzu clearing motoruyla fiyatla (işlem olmasa bile — dışarıdan ayırt edilemez).
//! 5. Rastgele `K_b` üret; sonuçları ve ghost-chart özetini `K_b` ile şifrele,
//!    `K_b`'yi drand'in `unlock_round` turuna kilitle.
//! 6. Yeni state'i mühürle, settlement özetini imzala.

use std::collections::HashSet;

use rand_core::{OsRng, RngCore};
use ruint::aliases::U256;
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::{
    clearing::{ClearingEngine, Reserves, Side},
    digest::Settlement,
    keys::EnclaveKey,
    note::{random_field, spend_commitment, Field},
    order::{order_aad, order_id, Order},
    reveal::{self, BatchSummary, OrderOutcome, PoolSummary},
    state::{self, Pool, VaultState},
    timelock, Error,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchContext {
    pub chain_id: u64,
    pub vault: [u8; 20],
    pub batch_id: u64,
    /// Tüm havuzların ortak quote tokenı (ör. USDC)
    pub quote_token: [u8; 20],
    pub fee_bps: u16,
}

/// Bir batch'te en fazla emir sayısı (enclave'i DoS'a karşı korur; kontrat da aynı sınırı uygular).
pub const MAX_ORDERS_PER_BATCH: usize = 2048;

/// Kilit turu, enclave saatine göre `LOCK_SECONDS + UNLOCK_MARGIN_SECONDS` sonrasına ayarlanır.
/// Pay, enclave saati ile blok zamanı arasındaki farkı ve settlement gecikmesini karşılar;
/// kontrat `unlockRound >= roundAt(block.timestamp + LOCK_SECONDS)` kontrol eder.
pub const UNLOCK_MARGIN_SECONDS: u64 = 15 * 60;

/// Kontrattaki bir emir kaydı. Token ve miktar zincirde GÖRÜNMEZ; kontrat yalnızca ZK
/// kanıtının doğruladığı `spend_commitment = Poseidon3(token, amount, blinding)` değerini bilir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedOrder {
    pub ciphertext: Vec<u8>,
    pub spend_commitment: Field,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolInit {
    pub pool_id: u32,
    pub base_token: [u8; 20],
    pub base: u128,
    pub quote: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchInput {
    pub ctx: BatchContext,
    /// Genesis batch'te (batch_id = 1) `None`.
    pub prev_sealed_state: Option<Vec<u8>>,
    pub new_pools: Vec<PoolInit>,
    pub orders: Vec<EncryptedOrder>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OrderStatus {
    /// Sonuç yeni bir shielded not (`output_commitment`); 7 gün sonra ağaca eklenir.
    /// İşlem görmeyen ama fonlaması doğru emirler de buraya düşer: aynı token/miktarla
    /// özel iade notu (dışarıdan işlem görmüşle ayırt edilemez).
    Filled = 1,
    /// Enclave emri çözemedi ya da fonlamayı doğrulayamadı; kullanıcı `spendCommitment`
    /// açılışını zincire vererek fonunu hemen geri alır.
    Refunded = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderResult {
    pub order_id: [u8; 32],
    pub status: OrderStatus,
    /// Refunded ise sıfır.
    pub output_commitment: [u8; 32],
    /// Refunded ise boş.
    pub sealed_result: Vec<u8>,
}

impl OrderResult {
    /// `keccak256(abi.encodePacked(orderId, uint8(status), commitment, keccak256(sealedResult)))`
    pub fn leaf(&self) -> [u8; 32] {
        let mut h = Keccak256::new();
        h.update(self.order_id);
        h.update([self.status as u8]);
        h.update(self.output_commitment);
        h.update(Keccak256::digest(&self.sealed_result));
        h.finalize().into()
    }
}

// ---------------------------------------------------------------- Merkle

/// OpenZeppelin `Hashes.commutativeKeccak256` ile aynı: küçük olan önce.
fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut h = Keccak256::new();
    h.update(lo);
    h.update(hi);
    h.finalize().into()
}

fn next_layer(layer: &[[u8; 32]]) -> Vec<[u8; 32]> {
    layer
        .chunks(2)
        .map(|c| if c.len() == 2 { hash_pair(&c[0], &c[1]) } else { c[0] })
        .collect()
}

/// Soldan dolu ikili ağaç; tek kalan düğüm bir üst katmana aynen çıkar. Boşsa sıfır.
/// Claim'ler OpenZeppelin `MerkleProof.verify` ile doğrulanır; settlement her emir için
/// storage yazmaz (Monad'da cold SSTORE pahalı), sadece kökü saklar.
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        layer = next_layer(&layer);
    }
    layer[0]
}

pub fn merkle_proof(leaves: &[[u8; 32]], mut index: usize) -> Vec<[u8; 32]> {
    let mut proof = Vec::new();
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let sibling = index ^ 1;
        if sibling < layer.len() {
            proof.push(layer[sibling]);
        }
        layer = next_layer(&layer);
        index /= 2;
    }
    proof
}

pub fn results_root(results: &[OrderResult]) -> [u8; 32] {
    merkle_root(&results.iter().map(OrderResult::leaf).collect::<Vec<_>>())
}

// ---------------------------------------------------------------- girdi bağlama

/// Kontrat emirleri `uint256(orderId) % SHARDS` ile shard'lara dağıtır; her shard
/// kendi hash zincirini tutar. Böylece Monad'ın paralel yürütmesinde farklı
/// shard'lara düşen emirler aynı storage slot'una yazmaz.
pub const SHARDS: usize = 16;

pub fn shard_of(order_id: &[u8; 32]) -> usize {
    (order_id[31] as usize) % SHARDS
}

/// `chain_s = keccak256(abi.encodePacked(chain_s, orderId, spendCommitment))`,
/// shard içindeki sıraya göre; `ordersHash = keccak256(abi.encodePacked(chain_0..chain_15))`.
pub fn orders_hash(orders: &[EncryptedOrder]) -> [u8; 32] {
    let mut chains = [[0u8; 32]; SHARDS];
    for o in orders {
        let id = order_id(&o.ciphertext);
        let chain = &mut chains[shard_of(&id)];
        let mut h = Keccak256::new();
        h.update(*chain);
        h.update(id);
        h.update(o.spend_commitment);
        *chain = h.finalize().into();
    }
    let mut h = Keccak256::new();
    for c in &chains {
        h.update(c);
    }
    h.finalize().into()
}

/// `chain = keccak256(abi.encodePacked(chain, uint32 poolId, address baseToken, uint128 base, uint128 quote))`
pub fn pools_hash(pools: &[PoolInit]) -> [u8; 32] {
    pools.iter().fold([0u8; 32], |chain, p| {
        let mut h = Keccak256::new();
        h.update(chain);
        h.update(p.pool_id.to_be_bytes());
        h.update(p.base_token);
        h.update(p.base.to_be_bytes());
        h.update(p.quote.to_be_bytes());
        h.finalize().into()
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchOutput {
    pub settlement: Settlement,
    pub signature: [u8; 65],
    pub new_sealed_state: Vec<u8>,
    /// Girişteki emirlerle aynı sırada.
    pub results: Vec<OrderResult>,
    /// drand'e kilitli `K_b`
    pub capsule: Vec<u8>,
    pub sealed_summary: Vec<u8>,
}

struct Accepted {
    index: usize,
    order: Order,
    base_token: [u8; 20],
    in_token: [u8; 20],
}

/// Yeni bir not üretir, sonucu `results[index]`'e yazar.
fn issue_note(
    k_b: &[u8; 32],
    result: &mut OrderResult,
    order: &Order,
    pool_id: u32,
    out_token: [u8; 20],
    amount_out: u128,
) -> Result<(), Error> {
    let outcome = OrderOutcome { pool_id, out_token, amount_out, blinding: random_field(), owner: order.owner };
    result.status = OrderStatus::Filled;
    result.output_commitment = outcome.commitment()?;
    result.sealed_result = reveal::seal_outcome(k_b, &result.order_id, &order.recipient, &outcome)?;
    Ok(())
}

/// `now_unix`, TEE wrapper'ının güvenilir saatidir. Kilit turu girdiden ALINMAZ:
/// aksi halde herkes enclave'i geçmiş bir turla çağırıp kapsülü hemen açabilir
/// ve fiyatı zincire hiç gitmeden öğrenirdi.
pub fn process_batch(
    key: &EnclaveKey,
    engine: &dyn ClearingEngine,
    input: &BatchInput,
    now_unix: u64,
) -> Result<BatchOutput, Error> {
    let unlock_round = timelock::round_at(now_unix + timelock::LOCK_SECONDS + UNLOCK_MARGIN_SECONDS);
    process_batch_locked_to(key, engine, input, unlock_round)
}

/// Kilit turunu doğrudan alan varyant. YALNIZCA test vektörü üretimi içindir
/// (gerçek imzası bilinen eski bir drand turuna kilitlemek için); sunucu bunu çağırmaz.
#[doc(hidden)]
pub fn process_batch_locked_to(
    key: &EnclaveKey,
    engine: &dyn ClearingEngine,
    input: &BatchInput,
    unlock_round: u64,
) -> Result<BatchOutput, Error> {
    let ctx = &input.ctx;
    if input.orders.len() > MAX_ORDERS_PER_BATCH {
        return Err(Error::TooManyOrders(input.orders.len()));
    }
    // Motor hatası havuz bazında iadeye dönüşür; geçersiz fee tüm emirleri sessizce
    // iade ettirmesin diye burada, batch seviyesinde reddedilir.
    if ctx.fee_bps >= 10_000 {
        return Err(Error::InvalidFee);
    }

    // 1. durum
    let (mut vault, prev_state_hash) = match &input.prev_sealed_state {
        Some(sealed) => (state::unseal(key, sealed, ctx.chain_id, &ctx.vault)?, state::state_hash(sealed)),
        None => (VaultState::default(), [0u8; 32]),
    };
    let expected = vault.batch_nonce + 1;
    if ctx.batch_id != expected {
        return Err(Error::BatchOutOfOrder { expected, got: ctx.batch_id });
    }

    // 2. yeni havuzlar
    for p in &input.new_pools {
        vault.insert_pool(Pool {
            pool_id: p.pool_id,
            base_token: p.base_token,
            reserves: Reserves { base: p.base, quote: p.quote },
        })?;
    }

    // 3. emirleri çöz + doğrula
    let aad = order_aad(ctx.chain_id, &ctx.vault);
    let mut seen = HashSet::new();
    let mut accepted: Vec<Accepted> = Vec::new();
    let mut results: Vec<OrderResult> = input
        .orders
        .iter()
        .map(|o| OrderResult {
            order_id: order_id(&o.ciphertext),
            status: OrderStatus::Refunded,
            output_commitment: [0u8; 32],
            sealed_result: Vec::new(),
        })
        .collect();

    for (index, enc) in input.orders.iter().enumerate() {
        if !seen.insert(results[index].order_id) {
            continue;
        }
        let Ok(plain) = key.decrypt(&enc.ciphertext, &aad) else { continue };
        let plain = Zeroizing::new(plain);
        let Ok(order) = Order::decode(&plain) else { continue };
        let Some(pool) = vault.pool(order.pool_id) else { continue };
        let in_token = match order.side {
            Side::Buy => ctx.quote_token,
            Side::Sell => pool.base_token,
        };
        // Fonlama: kullanıcının harcadığı not parçası tam olarak bu token ve miktar olmalı.
        match spend_commitment(&in_token, order.amount_in, &order.spend_blinding) {
            Ok(c) if c == enc.spend_commitment => {}
            _ => continue,
        }
        accepted.push(Accepted { index, base_token: pool.base_token, in_token, order });
    }

    // 4. havuz başına clearing (tüm havuzlar)
    let mut k_b = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(k_b.as_mut());
    let mut summary = Vec::with_capacity(vault.pools.len());

    for pool in vault.pools.iter_mut() {
        let members: Vec<&Accepted> = accepted.iter().filter(|a| a.order.pool_id == pool.pool_id).collect();
        let flows: Vec<(Side, u128)> = members.iter().map(|a| (a.order.side, a.order.amount_in)).collect();

        let spot = U256::from(pool.reserves.quote) * U256::from(10u128.pow(18)) / U256::from(pool.reserves.base);
        let mut entry = PoolSummary {
            pool_id: pool.pool_id,
            price_x18: spot,
            quote_in: 0,
            base_in: 0,
            buy_count: 0,
            sell_count: 0,
            base_reserve: 0,
            quote_reserve: 0,
        };

        match engine.clear(pool.reserves, &flows, ctx.fee_bps) {
            Ok(cleared) => {
                pool.reserves = cleared.new_reserves;
                entry.price_x18 = cleared.price_x18();
                for (a, amount_out) in members.iter().zip(&cleared.amounts_out) {
                    let out_token = match a.order.side {
                        Side::Buy => {
                            entry.quote_in += a.order.amount_in;
                            entry.buy_count += 1;
                            a.base_token
                        }
                        Side::Sell => {
                            entry.base_in += a.order.amount_in;
                            entry.sell_count += 1;
                            ctx.quote_token
                        }
                    };
                    issue_note(&k_b, &mut results[a.index], &a.order, pool.pool_id, out_token, *amount_out)?;
                }
            }
            // Motor hata verirse (ör. taşma) havuz değişmez; emirler aynı token/miktarla
            // özel iade notu alır.
            Err(_) => {
                for a in &members {
                    issue_note(&k_b, &mut results[a.index], &a.order, pool.pool_id, a.in_token, a.order.amount_in)?;
                }
            }
        }
        entry.base_reserve = pool.reserves.base;
        entry.quote_reserve = pool.reserves.quote;
        summary.push(entry);
    }

    // 5. özet + kapsül
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);
    let summary = BatchSummary { salt, pools: summary };
    let reserves_commitment = reveal::reserves_commitment(ctx.batch_id, &summary.salt, &summary.pools);
    let sealed_summary = reveal::aead_seal(
        &reveal::summary_key(&k_b),
        &reveal::encode_summary(ctx.batch_id, &summary),
        &reveal::summary_aad(ctx.batch_id),
    )?;
    let capsule = timelock::lock(k_b.as_ref(), unlock_round)?;

    // 6. yeni state + imza
    vault.batch_nonce = ctx.batch_id;
    let new_sealed_state = state::seal(key, &vault, ctx.chain_id, &ctx.vault)?;
    let settlement = Settlement {
        chain_id: ctx.chain_id,
        vault: ctx.vault,
        batch_id: ctx.batch_id,
        prev_state_hash,
        new_state_hash: state::state_hash(&new_sealed_state),
        results_root: results_root(&results),
        unlock_round,
        capsule_hash: Keccak256::digest(&capsule).into(),
        summary_hash: Keccak256::digest(&sealed_summary).into(),
        quote_token: ctx.quote_token,
        fee_bps: ctx.fee_bps,
        orders_hash: orders_hash(&input.orders),
        pools_hash: pools_hash(&input.new_pools),
        reserves_commitment,
    };
    let signature = key.sign_digest(&settlement.digest())?;

    Ok(BatchOutput { settlement, signature, new_sealed_state, results, capsule, sealed_summary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{clearing::FmAmm, ecies, keys::recover_address};
    use k256::SecretKey;

    const E18: u128 = 1_000_000_000_000_000_000;
    const USDC: [u8; 20] = [0xC0; 20];
    const TOKEN_A: [u8; 20] = [0xAA; 20];
    const TOKEN_B: [u8; 20] = [0xBB; 20];
    const VAULT: [u8; 20] = [0x77; 20];
    /// drand quicknet round 1000'in gerçek imzası
    const ROUND_1000_SIG: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

    fn ctx(batch_id: u64) -> BatchContext {
        BatchContext { chain_id: 10143, vault: VAULT, batch_id, quote_token: USDC, fee_bps: 30 }
    }

    /// Testlerde kapsül, gerçek imzası bilinen quicknet round 1000'e kilitlenir.
    fn run(enclave: &EnclaveKey, input: &BatchInput) -> Result<BatchOutput, Error> {
        process_batch_locked_to(enclave, &FmAmm, input, 1000)
    }

    /// Kullanıcı emri: `funding` = kullanıcının ZK kanıtıyla harcadığı not parçası (token, miktar).
    /// Dürüst kullanıcıda funding emirle aynıdır; yalancıda farklıdır.
    fn user_order(
        enclave: &EnclaveKey,
        user: &SecretKey,
        side: Side,
        pool_id: u32,
        amount: u128,
        funding: ([u8; 20], u128),
    ) -> EncryptedOrder {
        let spend_blinding = random_field();
        let o = Order {
            side,
            pool_id,
            amount_in: amount,
            recipient: user.public_key(),
            spend_blinding,
            owner: random_field(),
        };
        EncryptedOrder {
            ciphertext: ecies::encrypt(&enclave.public_key(), &o.encode(), &order_aad(10143, &VAULT)).unwrap(),
            spend_commitment: spend_commitment(&funding.0, funding.1, &spend_blinding).unwrap(),
        }
    }

    fn genesis(enclave: &EnclaveKey) -> BatchOutput {
        let input = BatchInput {
            ctx: ctx(1),
            prev_sealed_state: None,
            new_pools: vec![
                PoolInit { pool_id: 1, base_token: TOKEN_A, base: 1_000_000 * E18, quote: 500_000 * 1_000_000 },
                PoolInit { pool_id: 2, base_token: TOKEN_B, base: 10_000 * E18, quote: 2_000_000 * 1_000_000 },
            ],
            orders: vec![],
        };
        run(enclave, &input).unwrap()
    }

    fn hexd(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn full_batch_lifecycle_with_real_drand_unlock() {
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        assert_eq!(recover_address(&g.settlement.digest(), &g.signature).unwrap(), enclave.eth_address());

        let alice = SecretKey::random(&mut OsRng);
        let bob = SecretKey::random(&mut OsRng);
        let mallory = SecretKey::random(&mut OsRng);

        let alice_o = user_order(&enclave, &alice, Side::Buy, 1, 100 * 1_000_000, (USDC, 100 * 1_000_000));
        let bob_o = user_order(&enclave, &bob, Side::Sell, 2, 5 * E18, (TOKEN_B, 5 * E18));
        // yalancı: emirde 1000 USDC diyor, kanıtla yalnızca 1 USDC harcadı
        let lying_o = user_order(&enclave, &mallory, Side::Buy, 1, 1_000 * 1_000_000, (USDC, 1_000_000));

        let input = BatchInput {
            ctx: ctx(2),
            prev_sealed_state: Some(g.new_sealed_state.clone()),
            new_pools: vec![],
            orders: vec![
                alice_o.clone(),
                bob_o,
                lying_o,
                EncryptedOrder { ciphertext: vec![0xFF; crate::order::CIPHERTEXT_LEN], spend_commitment: [1; 32] },
                alice_o,
            ],
        };
        let out = run(&enclave, &input).unwrap();

        // imza + zincir bağlantısı
        assert_eq!(recover_address(&out.settlement.digest(), &out.signature).unwrap(), enclave.eth_address());
        assert_eq!(out.settlement.prev_state_hash, g.settlement.new_state_hash);
        assert_eq!(out.settlement.results_root, results_root(&out.results));

        // durumlar: dürüstler dolar; yalancı, çöp ve tekrar iade
        let st: Vec<_> = out.results.iter().map(|r| r.status).collect();
        use OrderStatus::*;
        assert_eq!(st, vec![Filled, Filled, Refunded, Refunded, Refunded]);
        assert!(out.results[0].sealed_result.len() == reveal::SEALED_RESULT_LEN);
        assert_eq!(out.results[0].sealed_result.len(), out.results[1].sealed_result.len());

        // Kilit açılmadan: yanlış tur imzası kapsülü açamaz (burada kapsül 1000'e kilitli,
        // gerçek sistemde tur settlement + 7 gün). Gerçek round 1000 imzasıyla açılır.
        let k_b = reveal::open_capsule(&out.capsule, &hexd(ROUND_1000_SIG)).unwrap();

        // Ghost chart: herkes okuyabilir
        let opened = reveal::open_summary(&k_b, 2, &out.sealed_summary).unwrap();
        assert_eq!(
            reveal::reserves_commitment(2, &opened.salt, &opened.pools),
            out.settlement.reserves_commitment,
            "özetteki rezervler imzalı commitment'ı açmalı"
        );
        let summary = opened.pools;
        assert_eq!(summary.len(), 2);
        assert_eq!((summary[0].pool_id, summary[0].buy_count, summary[0].quote_in), (1, 1, 100 * 1_000_000));
        assert_eq!((summary[1].pool_id, summary[1].sell_count, summary[1].base_in), (2, 1, 5 * E18));
        assert!(summary[0].price_x18 > U256::ZERO);

        // Alice: dış katmanı herkes soyar, iç katmanı sadece Alice çözer
        let r = &out.results[0];
        let inner = reveal::open_result_outer(&k_b, &r.order_id, &r.sealed_result).unwrap();
        assert!(reveal::open_result(&bob, &r.order_id, &inner).is_err());
        let outcome = reveal::open_result(&alice, &r.order_id, &inner).unwrap();
        assert_eq!(outcome.out_token, TOKEN_A);
        assert!(outcome.amount_out > 0);
        assert_eq!(outcome.commitment().unwrap(), r.output_commitment);

        // Bob USDC alır
        let r = &out.results[1];
        let inner = reveal::open_result_outer(&k_b, &r.order_id, &r.sealed_result).unwrap();
        assert_eq!(reveal::open_result(&bob, &r.order_id, &inner).unwrap().out_token, USDC);

        // Yeni state'teki rezervler özettekiyle aynı ve nonce ilerledi
        let vault = state::unseal(&enclave, &out.new_sealed_state, 10143, &VAULT).unwrap();
        assert_eq!(vault.batch_nonce, 2);
        for (p, s) in vault.pools.iter().zip(&summary) {
            assert_eq!((p.reserves.base, p.reserves.quote), (s.base_reserve, s.quote_reserve));
        }
        assert!(vault.pool(1).unwrap().reserves.quote > 500_000 * 1_000_000);
        assert!(vault.pool(2).unwrap().reserves.base > 10_000 * E18);
    }

    #[test]
    fn merkle_proofs_verify_for_every_size() {
        fn verify(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
            proof.iter().fold(leaf, |acc, p| hash_pair(&acc, p)) == root
        }
        assert_eq!(merkle_root(&[]), [0u8; 32]);
        for n in 1..=33usize {
            let leaves: Vec<[u8; 32]> = (0..n).map(|i| Keccak256::digest(i.to_be_bytes()).into()).collect();
            let root = merkle_root(&leaves);
            for (i, leaf) in leaves.iter().enumerate() {
                assert!(verify(&merkle_proof(&leaves, i), root, *leaf), "n={n} i={i}");
            }
            assert!(!verify(&merkle_proof(&leaves, 0), root, [9u8; 32]));
        }
    }

    #[test]
    fn input_bindings_detect_relayer_lies() {
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        let user = SecretKey::random(&mut OsRng);
        let honest = BatchInput {
            ctx: ctx(2),
            prev_sealed_state: Some(g.new_sealed_state.clone()),
            new_pools: vec![],
            orders: vec![user_order(&enclave, &user, Side::Buy, 1, 100, (USDC, 100))],
        };
        let a = run(&enclave, &honest).unwrap().settlement;

        // relayer zincirdekinden farklı bir spendCommitment verirse ordersHash tutmaz
        let mut lie = honest.clone();
        lie.orders[0].spend_commitment[31] ^= 1;
        assert_ne!(run(&enclave, &lie).unwrap().settlement.orders_hash, a.orders_hash);

        let mut fee = honest.clone();
        fee.ctx.fee_bps = 0;
        let b = run(&enclave, &fee).unwrap().settlement;
        assert_ne!(b.digest(), a.digest());
        assert_eq!(b.fee_bps, 0);

        assert_eq!(pools_hash(&[]), [0u8; 32]);
        assert_ne!(g.settlement.pools_hash, [0u8; 32]);
    }

    #[test]
    fn capsule_does_not_open_with_other_round() {
        let enclave = EnclaveKey::generate();
        let input = BatchInput { ctx: ctx(1), prev_sealed_state: None, new_pools: vec![], orders: vec![] };
        let out = process_batch_locked_to(&enclave, &FmAmm, &input, 1001).unwrap();
        assert_eq!(timelock::capsule_round(&out.capsule).unwrap(), 1001);
        assert!(reveal::open_capsule(&out.capsule, &hexd(ROUND_1000_SIG)).is_err());
    }

    #[test]
    fn replayed_or_skipped_batches_are_rejected() {
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        let replay = BatchInput {
            ctx: ctx(1),
            prev_sealed_state: Some(g.new_sealed_state.clone()),
            new_pools: vec![],
            orders: vec![],
        };
        assert_eq!(
            run(&enclave, &replay),
            Err(Error::BatchOutOfOrder { expected: 2, got: 1 })
        );
        let skip = BatchInput { ctx: ctx(3), ..replay };
        assert_eq!(
            run(&enclave, &skip),
            Err(Error::BatchOutOfOrder { expected: 2, got: 3 })
        );
    }

    #[test]
    fn unlock_round_comes_from_trusted_clock_not_input() {
        let enclave = EnclaveKey::generate();
        let input = BatchInput { ctx: ctx(1), prev_sealed_state: None, new_pools: vec![], orders: vec![] };
        let now = 1_790_000_000;
        let out = process_batch(&enclave, &FmAmm, &input, now).unwrap();
        let opens_at = timelock::round_time(out.settlement.unlock_round);
        assert!(opens_at >= now + timelock::LOCK_SECONDS + UNLOCK_MARGIN_SECONDS);
        assert!(opens_at < now + timelock::LOCK_SECONDS + UNLOCK_MARGIN_SECONDS + timelock::QUICKNET_PERIOD);
        assert_eq!(timelock::capsule_round(&out.capsule).unwrap(), out.settlement.unlock_round);
    }

    #[test]
    fn too_many_orders_rejected() {
        let enclave = EnclaveKey::generate();
        let order = EncryptedOrder { ciphertext: vec![0], spend_commitment: [0; 32] };
        let input = BatchInput {
            ctx: ctx(1),
            prev_sealed_state: None,
            new_pools: vec![],
            orders: vec![order; MAX_ORDERS_PER_BATCH + 1],
        };
        assert_eq!(run(&enclave, &input), Err(Error::TooManyOrders(MAX_ORDERS_PER_BATCH + 1)));
    }

    #[test]
    fn state_from_another_vault_is_rejected() {
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        let mut input = BatchInput {
            ctx: ctx(2),
            prev_sealed_state: Some(g.new_sealed_state),
            new_pools: vec![],
            orders: vec![],
        };
        input.ctx.vault = [0x01; 20];
        assert_eq!(run(&enclave, &input), Err(Error::DecryptionFailed));
    }

    #[test]
    fn order_to_unknown_pool_or_wrong_token_is_refunded() {
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        let user = SecretKey::random(&mut OsRng);
        let input = BatchInput {
            ctx: ctx(2),
            prev_sealed_state: Some(g.new_sealed_state),
            new_pools: vec![],
            orders: vec![
                // var olmayan havuz
                user_order(&enclave, &user, Side::Buy, 99, 10, (USDC, 10)),
                // Sell ama base yerine USDC notu harcamış
                user_order(&enclave, &user, Side::Sell, 1, 10, (USDC, 10)),
            ],
        };
        let out = run(&enclave, &input).unwrap();
        assert!(out.results.iter().all(|r| r.status == OrderStatus::Refunded));
    }

    /// Fonlaması doğru ama işlem göremeyen emir: aynı token/miktarla ÖZEL iade notu alır
    /// (dışarıdan işlem görmüş emirden ayırt edilemez; zincirde açılış gerekmez).
    #[test]
    fn engine_failure_issues_private_refund_notes() {
        struct Broken;
        impl ClearingEngine for Broken {
            fn clear(&self, _: Reserves, _: &[(Side, u128)], _: u16) -> Result<crate::clearing::BatchClearing, Error> {
                Err(Error::Overflow)
            }
        }
        let enclave = EnclaveKey::generate();
        let g = genesis(&enclave);
        let user = SecretKey::random(&mut OsRng);
        let input = BatchInput {
            ctx: ctx(2),
            prev_sealed_state: Some(g.new_sealed_state),
            new_pools: vec![],
            orders: vec![user_order(&enclave, &user, Side::Sell, 2, 7 * E18, (TOKEN_B, 7 * E18))],
        };
        let out = process_batch_locked_to(&enclave, &Broken, &input, 1000).unwrap();
        let r = &out.results[0];
        assert_eq!(r.status, OrderStatus::Filled);
        let k_b = reveal::open_capsule(&out.capsule, &hexd(ROUND_1000_SIG)).unwrap();
        let inner = reveal::open_result_outer(&k_b, &r.order_id, &r.sealed_result).unwrap();
        let outcome = reveal::open_result(&user, &r.order_id, &inner).unwrap();
        assert_eq!((outcome.out_token, outcome.amount_out), (TOKEN_B, 7 * E18));
        assert_eq!(outcome.commitment().unwrap(), r.output_commitment);
    }
}
