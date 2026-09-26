// Demo projeler için TESTNET ÖNCESİ örnek grafik geçmişi üretir (gerçek işlem DEĞİL).
//
// Testnet'te gerçek fiyatlar ilk işlemlerden 7 gün sonra açılır; o zamana kadar demo projelerin
// grafiği boş kalmasın diye relayer bu dosyayı DEMO_HISTORY_FILE ile okur ve her noktayı
// `demo: true` olarak işaretler (arayüz "Demo geçmiş" etiketi gösterir). Geçmiş, havuzun
// zincirdeki gerçek açılış fiyatında biter ve 7 gün önce durur: son 7 gün gizli dönemdir.
//
//   RPC_URL=… DEPLOYMENT=contracts/deployments/10143.json OUT=.testnet/demo-history.json node sdk/e2e/gen-demo-history.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";

const deploy = JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8"));
const pub = createPublicClient({ transport: http(process.env.RPC_URL, { retryCount: 10, retryDelay: 1200 }) });
const abi = parseAbi([
  "function pools(uint32) view returns (address baseToken, address creator, uint64 window, bool reclaimed, uint128 initBase, uint128 initQuote)",
]);

// Proje karakteri: günlük sürüklenme ve oynaklık (geçmiş, açılış fiyatına doğru ilerler).
const PROFILE = {
  1: { drift: 0.012, vol: 0.035, seed: 11 }, // Nebula: yükselen
  2: { drift: 0.0, vol: 0.06, seed: 22 }, // Orbit: dalgalı
  3: { drift: -0.01, vol: 0.04, seed: 33 }, // Vela: düşen
  4: { drift: 0.0005, vol: 0.008, seed: 44 }, // ArfDAO: ~0,22 $ civarında yatay
};
const DAY = 86_400;
const STEP = 2 * 3600; // 2 saatte bir clearing
const SPAN = 30 * DAY;

// Herkese açık Monad RPC'si istek/sn sınırlı (-32011); viem bunu yeniden denemez.
async function retry(fn, n = 15) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= n || !/limited|429|-32011/.test(String(e?.details ?? e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 800 + i * 400));
    }
  }
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

const end = Math.floor(Date.now() / 1000) - 7 * DAY - 3600;
const out = {};
for (const [id, prof] of Object.entries(PROFILE)) {
  const [, , , , initBase, initQuote] = await retry(() => pub.readContract({ address: deploy.vault, abi, functionName: "pools", args: [Number(id)] }));
  if (initBase === 0n) continue;
  const base0 = Number(initBase) / 1e18;
  const quote0 = Number(initQuote) / 1e6;
  const k = base0 * quote0;
  const r = rng(prof.seed);
  const steps = Math.floor(SPAN / STEP);
  // Açılış fiyatından geriye doğru yürü, sonra zamana göre sırala.
  const prices = [quote0 / base0];
  const perStep = STEP / DAY;
  for (let i = 1; i <= steps; i++) {
    const shock = prof.drift * perStep + prof.vol * Math.sqrt(perStep) * gauss(r);
    prices.push(prices[i - 1] / Math.exp(shock));
  }
  prices.reverse();
  out[id] = prices.map((p, i) => {
    const time = end - (steps - i) * STEP;
    const quoteRes = Math.sqrt(k * p);
    const baseRes = Math.sqrt(k / p);
    const prev = prices[Math.max(0, i - 1)];
    const up = p >= prev;
    const volUsd = quote0 * (0.002 + 0.01 * r()) * (1 + Math.abs(Math.log(p / prev)) * 20);
    const buyShare = up ? 0.55 + 0.3 * r() : 0.15 + 0.3 * r();
    const buys = 1 + Math.floor(r() * 9 * buyShare);
    const sells = 1 + Math.floor(r() * 9 * (1 - buyShare));
    return {
      batchId: 0,
      time,
      priceX18: BigInt(Math.round(p * 1e6)).toString(), // quote_raw/base_raw × 1e18 = p × 1e6 (6 vs 18 ondalık)
      quoteIn: BigInt(Math.round(volUsd * buyShare * 1e6)).toString(),
      baseIn: (BigInt(Math.round((volUsd * (1 - buyShare)) / p * 1e6)) * 10n ** 12n).toString(),
      buyCount: buys,
      sellCount: sells,
      baseReserve: (BigInt(Math.round(baseRes * 1e6)) * 10n ** 12n).toString(),
      quoteReserve: BigInt(Math.round(quoteRes * 1e6)).toString(),
      demo: true,
    };
  });
}
writeFileSync(process.env.OUT, JSON.stringify(out));
console.log(`demo geçmiş: ${Object.keys(out).length} proje, ${Object.values(out)[0]?.length ?? 0} nokta/proje → ${process.env.OUT}`);
