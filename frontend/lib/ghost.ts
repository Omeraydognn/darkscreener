// "Ghost chart" analitiği — YALNIZCA kilidi açılmış (≥ 7 gün önceki) batch'lerden.
// Her batch tek bir clearing fiyatına sahiptir (FM-AMM), bu yüzden mumlar batch'lerin
// zaman kovalarına gruplanmasıyla oluşur.

import type { History, Pool } from "./api";
import { priceFromX18, units } from "./format";

export type Point = {
  time: number;
  batchId: number;
  price: number;
  buyVol: number; // quote cinsinden
  sellVol: number; // quote cinsinden
  buys: number;
  sells: number;
  tvl: number; // quote cinsinden (≈ 2 × quote rezervi)
  demo?: boolean;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; buyVol: number; sellVol: number };

export function toPoints(h: History, pool: Pool): Point[] {
  const bd = pool.base.decimals ?? 18;
  const qd = pool.quote.decimals ?? 6;
  return h.points.map((p) => {
    const price = priceFromX18(p.priceX18, bd, qd);
    return {
      time: p.time,
      batchId: p.batchId,
      price,
      buyVol: units(p.quoteIn, qd),
      sellVol: units(p.baseIn, bd) * price,
      buys: p.buyCount,
      sells: p.sellCount,
      tvl: 2 * units(p.quoteReserve, qd),
      demo: p.demo,
    };
  });
}

export function candles(points: Point[], bucket: number): Candle[] {
  const out: Candle[] = [];
  for (const p of points) {
    const t = Math.floor(p.time / bucket) * bucket;
    const last = out[out.length - 1];
    const vol = p.buyVol + p.sellVol;
    if (last && last.time === t) {
      last.high = Math.max(last.high, p.price);
      last.low = Math.min(last.low, p.price);
      last.close = p.price;
      last.volume += vol;
      last.buyVol += p.buyVol;
      last.sellVol += p.sellVol;
    } else {
      // Mum, bir öncekinin kapanışından açılır: batch'ler arası boşluk fiyat sıçraması gibi görünmesin.
      const open = last ? last.close : p.price;
      out.push({
        time: t,
        open,
        high: Math.max(open, p.price),
        low: Math.min(open, p.price),
        close: p.price,
        volume: vol,
        buyVol: p.buyVol,
        sellVol: p.sellVol,
      });
    }
  }
  return out;
}

/** Zaman ağırlıklı ortalama fiyat (basamak fonksiyonu), [end - window, end] aralığında. */
export function twap(points: Point[], windowSec: number, end = points.at(-1)?.time ?? 0): number | null {
  const start = end - windowSec;
  let area = 0;
  let span = 0;
  for (let i = 0; i < points.length; i++) {
    const a = Math.max(points[i].time, start);
    const b = Math.min(points[i + 1]?.time ?? end, end);
    if (b > a) {
      area += points[i].price * (b - a);
      span += b - a;
    }
  }
  return span > 0 ? area / span : points.length ? points[points.length - 1].price : null;
}

/** TWAP çizgisi: her mum için geriye dönük `windowSec` TWAP'ı. */
export function twapSeries(points: Point[], cs: Candle[], windowSec: number) {
  return cs.map((c) => ({ time: c.time, value: twap(points.filter((p) => p.time <= c.time + 1), windowSec, c.time) ?? c.close }));
}

function priceAt(points: Point[], t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.time <= t) v = p.price;
    else break;
  }
  return v;
}

export type DelayedStats = {
  price: number | null;
  asOf: number | null;
  change: { label: string; value: number | null }[];
  tvl: number | null;
  twap30: number | null;
  window: { buys: number; sells: number; buyVol: number; sellVol: number };
};

/** Son açılmış batch'e göre gecikmeli istatistikler (DexScreener'daki 5m/1h/6h/24h yerine). */
export function delayedStats(points: Point[]): DelayedStats {
  const last = points.at(-1);
  const asOf = last?.time ?? null;
  const ch = (sec: number) => {
    if (!last) return null;
    const ref = priceAt(points, last.time - sec);
    return ref ? last.price / ref - 1 : null;
  };
  const since = (asOf ?? 0) - 7 * 86400;
  const w = points.filter((p) => p.time > since);
  return {
    price: last?.price ?? null,
    asOf,
    change: [
      { label: "1G", value: ch(86400) },
      { label: "3G", value: ch(3 * 86400) },
      { label: "7G", value: ch(7 * 86400) },
      { label: "TÜMÜ", value: points.length ? last!.price / points[0].price - 1 : null },
    ],
    tvl: last?.tvl ?? null,
    twap30: twap(points, 30 * 86400),
    window: {
      buys: w.reduce((a, p) => a + p.buys, 0),
      sells: w.reduce((a, p) => a + p.sells, 0),
      buyVol: w.reduce((a, p) => a + p.buyVol, 0),
      sellVol: w.reduce((a, p) => a + p.sellVol, 0),
    },
  };
}
