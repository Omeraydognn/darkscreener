// Relayer API (relayer/src/api.rs) — yalnızca okuma uçları; yazma uçları lib/wallet.ts'te.
import { config } from "./config";

export type TokenMeta = { address: `0x${string}`; name?: string; symbol?: string; decimals?: number };

export type Project = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram?: string;
  discord?: string;
  github?: string;
  whitepaper?: string;
  logo?: string;
  category?: string;
  team?: string;
  roadmap?: string;
  tokenomics?: string;
  newsSigners: string[];
};

export type Pool = {
  poolId: number;
  base: TokenMeta;
  quote: TokenMeta;
  createdAt: number;
  project: Project | null;
  news24h: number;
  initialLiquidity: { base: string; quote: string };
};

export type HistoryPoint = {
  batchId: number;
  time: number;
  priceX18: string;
  quoteIn: string;
  baseIn: string;
  buyCount: number;
  sellCount: number;
  baseReserve: string;
  quoteReserve: string;
  /** Yalnızca demo projeler: testnet öncesi örnek geçmiş (gerçek işlem değil) */
  demo?: boolean;
};

export type History = {
  poolId: number;
  windowSeconds: number;
  points: HistoryPoint[];
  locked: { batchId: number; time: number; unlockTime: number }[];
};

export type NewsItem = {
  poolId: number;
  title: string;
  body: string;
  url: string;
  timestamp: number;
  signature: string;
  signer: string;
};

export type Info = {
  chainId: number;
  vault: string;
  quoteToken: string;
  feeBps: number;
  relayer: string;
  enclave: { publicKey: string; address: string; registered: boolean; provider?: string; hardwareBacked?: boolean };
  finalizedBlock: number;
  noteCount: number;
  settledBatches: number;
  genesisTime: number;
  windowSeconds: number;
  lockSeconds: number;
  finalizedTimestamp: number;
  launchpad?: `0x${string}` | null;
  /** usdPerMon: 1 MON başına dUSD birimi (6 ondalık); balance: MON çekim likiditesi (wei) */
  gateway?: { address: `0x${string}`; usdPerMon: string; balance: string } | null;
};

export type OrderStatus = {
  orderId: string;
  window: number;
  windowEnd: number;
  batchId: number | null;
  status?: 1 | 2;
  commitment?: string;
  sealedResult?: string;
  unlockTime?: number;
  kb?: string | null;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(config.relayerUrl + path, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json();
}

export const api = {
  info: () => get<Info>("/v1/info"),
  pools: () => get<{ pools: Pool[] }>("/v1/pools").then((r) => r.pools),
  history: (poolId: number) => get<History>(`/v1/pools/${poolId}/history`),
  news: (poolId?: number, limit = 50) =>
    get<{ news: NewsItem[] }>(`/v1/news?limit=${limit}${poolId ? `&pool=${poolId}` : ""}`).then((r) => r.news),
  order: (orderId: string) => get<OrderStatus>(`/v1/orders/${orderId}`),
};
