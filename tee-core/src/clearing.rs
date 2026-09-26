//! FM-AMM tek fiyatlı batch clearing (Canidio & Fritsch, 2023 — CoW AMM'in temeli).
//!
//! Havuz rezervleri (x = base, y = quote). Batch içinde:
//!   A = toplam satılan base (Sell), B = toplam harcanan quote (Buy), fee düşülmüş halleri A', B'.
//! Herkes aynı fiyattan (quote/base) işlem görür:
//!
//! ```text
//!   p = (y + 2B') / (x + 2A')
//! ```
//!
//! Bu, işlem sonrası havuzun marjinal fiyatı y'/x''in p'ye eşit olduğu tek denge
//! noktasıdır. Sonuçları:
//! - Karşılıklı emirler önce birbirleriyle netleşir, havuz sadece farkı karşılar.
//! - Sıralama yok -> sandviç/front-run imkânsız; batch içi arbitraj kârı LP'ye kalır.
//! - Kapalı form, karekök yok -> enclave'de deterministik tamsayı matematiği.
//! - Tek batch'te havuz base rezervinin en fazla yarısını verebilir (doğal devre kesici).
//!
//! Tüm yuvarlamalar havuz lehine (floor) yapılır; x'·y' ≥ x·y her batch'te kontrol edilir.

use ruint::aliases::U256;

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// quote verir, base alır
    Buy,
    /// base verir, quote alır
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reserves {
    pub base: u128,
    pub quote: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchClearing {
    /// Clearing fiyatı = price_num / price_den (quote birimi / base birimi)
    pub price_num: U256,
    pub price_den: U256,
    /// Emirlerle aynı sırada; Buy için base, Sell için quote miktarı.
    pub amounts_out: Vec<u128>,
    pub new_reserves: Reserves,
}

impl BatchClearing {
    /// 1e18 ölçekli fiyat; gecikmeli grafik / TWAP için saklanacak değer.
    pub fn price_x18(&self) -> U256 {
        self.price_num * U256::from(10u128.pow(18)) / self.price_den
    }
}

const BPS: u64 = 10_000;

/// Batch fiyatını hesaplayan motor. Bugün enclave içinde FM-AMM; ileride bir FHE
/// coprocessor (şifreli bölme desteklendiğinde) aynı arayüzün arkasına konabilir.
pub trait ClearingEngine {
    fn clear(&self, reserves: Reserves, orders: &[(Side, u128)], fee_bps: u16) -> Result<BatchClearing, Error>;
}

/// Varsayılan motor: `clear_batch` (FM-AMM).
#[derive(Debug, Default, Clone, Copy)]
pub struct FmAmm;

impl ClearingEngine for FmAmm {
    fn clear(&self, reserves: Reserves, orders: &[(Side, u128)], fee_bps: u16) -> Result<BatchClearing, Error> {
        clear_batch(reserves, orders, fee_bps)
    }
}

pub fn clear_batch(reserves: Reserves, orders: &[(Side, u128)], fee_bps: u16) -> Result<BatchClearing, Error> {
    if u64::from(fee_bps) >= BPS {
        return Err(Error::InvalidFee);
    }
    if reserves.base == 0 || reserves.quote == 0 {
        return Err(Error::EmptyPool);
    }
    let x = U256::from(reserves.base);
    let y = U256::from(reserves.quote);
    let keep = U256::from(BPS - u64::from(fee_bps));
    let bps = U256::from(BPS);

    let mut gross_base_in = U256::ZERO;
    let mut gross_quote_in = U256::ZERO;
    let mut net_base_in = U256::ZERO;
    let mut net_quote_in = U256::ZERO;
    let nets: Vec<U256> = orders
        .iter()
        .map(|&(side, amount)| {
            let gross = U256::from(amount);
            let net = gross * keep / bps;
            match side {
                Side::Buy => {
                    gross_quote_in += gross;
                    net_quote_in += net;
                }
                Side::Sell => {
                    gross_base_in += gross;
                    net_base_in += net;
                }
            }
            net
        })
        .collect();

    let two = U256::from(2u8);
    let price_num = y + two * net_quote_in;
    let price_den = x + two * net_base_in;

    let mut base_out_total = U256::ZERO;
    let mut quote_out_total = U256::ZERO;
    let mut amounts_out = Vec::with_capacity(orders.len());
    for (&(side, _), net) in orders.iter().zip(nets) {
        let out = match side {
            Side::Buy => {
                let out = net * price_den / price_num;
                base_out_total += out;
                out
            }
            Side::Sell => {
                let out = net * price_num / price_den;
                quote_out_total += out;
                out
            }
        };
        amounts_out.push(u128::try_from(out).map_err(|_| Error::Overflow)?);
    }

    let new_base = (x + gross_base_in)
        .checked_sub(base_out_total)
        .ok_or(Error::InvariantViolated)?;
    let new_quote = (y + gross_quote_in)
        .checked_sub(quote_out_total)
        .ok_or(Error::InvariantViolated)?;
    if new_base * new_quote < x * y {
        return Err(Error::InvariantViolated);
    }

    Ok(BatchClearing {
        price_num,
        price_den,
        amounts_out,
        new_reserves: Reserves {
            base: u128::try_from(new_base).map_err(|_| Error::Overflow)?,
            quote: u128::try_from(new_quote).map_err(|_| Error::Overflow)?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const E18: u128 = 1_000_000_000_000_000_000;

    fn pool() -> Reserves {
        Reserves { base: 100 * E18, quote: 100 * E18 }
    }

    #[test]
    fn empty_batch_is_noop_at_spot_price() {
        let r = clear_batch(pool(), &[], 30).unwrap();
        assert_eq!(r.new_reserves, pool());
        assert_eq!(r.price_x18(), U256::from(E18));
    }

    #[test]
    fn opposite_orders_net_against_each_other() {
        // 10 base satılıyor, 20 quote ile alım var -> p = 140/120
        let orders = [(Side::Sell, 10 * E18), (Side::Buy, 20 * E18)];
        let r = clear_batch(pool(), &orders, 0).unwrap();
        assert_eq!(r.price_num, U256::from(140 * E18));
        assert_eq!(r.price_den, U256::from(120 * E18));
        assert_eq!(r.amounts_out[0], 10 * E18 * 140 / 120); // quote
        assert_eq!(r.amounts_out[1], 20 * E18 * 120 / 140); // base
        // İşlem sonrası marjinal fiyat = clearing fiyatı (yuvarlama toleransı içinde)
        let nr = r.new_reserves;
        let lhs = U256::from(nr.quote) * r.price_den;
        let rhs = U256::from(nr.base) * r.price_num;
        let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
        assert!(diff <= r.price_num * U256::from(2u8));
    }

    #[test]
    fn uniform_price_is_split_invariant() {
        // Aynı toplamı tek emir ya da iki emir olarak göndermek sonucu değiştirmez.
        let one = clear_batch(pool(), &[(Side::Buy, 30 * E18)], 30).unwrap();
        let two = clear_batch(pool(), &[(Side::Buy, 10 * E18), (Side::Buy, 20 * E18)], 30).unwrap();
        assert_eq!(one.price_num, two.price_num);
        assert_eq!(one.price_den, two.price_den);
        let sum = two.amounts_out[0] + two.amounts_out[1];
        assert!(one.amounts_out[0] - sum <= 1);
    }

    #[test]
    fn huge_buy_cannot_drain_more_than_half() {
        let r = clear_batch(pool(), &[(Side::Buy, u128::MAX / 4)], 0).unwrap();
        assert!(r.new_reserves.base > pool().base / 2);
    }

    #[test]
    fn k_never_decreases_across_random_batches() {
        let mut seed = 0x9E3779B97F4A7C15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut reserves = Reserves { base: 1_000_000 * E18, quote: 2_500_000 * 1_000_000 };
        for _ in 0..500 {
            let n = (next() % 8) as usize;
            let orders: Vec<_> = (0..n)
                .map(|_| {
                    let side = if next() % 2 == 0 { Side::Buy } else { Side::Sell };
                    let amt = match side {
                        Side::Buy => u128::from(next() % 50_000) * 1_000_000 + 1,
                        Side::Sell => u128::from(next() % 20_000) * E18 + 1,
                    };
                    (side, amt)
                })
                .collect();
            let fee = (next() % 100) as u16;
            let r = clear_batch(reserves, &orders, fee).unwrap();
            let k0 = U256::from(reserves.base) * U256::from(reserves.quote);
            let k1 = U256::from(r.new_reserves.base) * U256::from(r.new_reserves.quote);
            assert!(k1 >= k0);
            reserves = r.new_reserves;
        }
    }

    #[test]
    fn rejects_bad_params() {
        assert_eq!(clear_batch(pool(), &[], 10_000), Err(Error::InvalidFee));
        assert_eq!(
            clear_batch(Reserves { base: 0, quote: 1 }, &[], 0),
            Err(Error::EmptyPool)
        );
    }
}
