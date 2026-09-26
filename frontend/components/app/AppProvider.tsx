"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { api, type Info, type Pool } from "@/lib/api";
import { config } from "@/lib/config";
import { ACCOUNT_KEY, ShieldedWallet } from "@/lib/wallet";
import { usePoll, useStoredString } from "../usePoll";

export type FundsTab = "deposit" | "withdraw";
export type SweepStatus = { state: "idle" | "sweeping" | "error"; last?: { usd: bigint; at: number }; error?: string; mon?: bigint };

type Book = ReturnType<ShieldedWallet["load"]>;

type Ctx = {
  pools: Pool[] | undefined;
  poolsError: Error | undefined;
  info: (Info & { fetchedAt: number }) | undefined;
  infoError: Error | undefined;
  refreshData: () => void;
  /** null = hesap yok; undefined = yükleniyor */
  wallet: ShieldedWallet | null | undefined;
  book: Book | undefined;
  /** Harcanabilir gizli dolar (6 ondalık) ve onay bekleyen yatırma */
  cash: bigint;
  pendingCash: bigint;
  sweep: SweepStatus;
  funds: FundsTab | null;
  openFunds: (tab?: FundsTab) => void;
  closeFunds: () => void;
  /** Launch sayfası açıkken yatırma adresindeki MON otomatik çevrilmez (likidite için kullanılır). */
  setSweepPaused: (v: boolean) => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp: AppProvider yok");
  return c;
}

function subscribeBook(cb: () => void) {
  window.addEventListener("darkscreener:book", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("darkscreener:book", cb);
    window.removeEventListener("storage", cb);
  };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const pools = usePoll(api.pools, 15_000);
  const info = usePoll(async () => ({ ...(await api.info()), fetchedAt: Date.now() / 1000 }), 6_000);
  const [secret] = useStoredString(ACCOUNT_KEY);
  const [loaded, setLoaded] = useState<{ secret: string; wallet: ShieldedWallet } | null>(null);
  const [funds, setFunds] = useState<FundsTab | null>(null);
  const [sweep, setSweep] = useState<SweepStatus>({ state: "idle" });
  const paused = useRef(false);

  useEffect(() => {
    if (!secret) return;
    let alive = true;
    ShieldedWallet.fromSecret(secret as Hex).then((wallet) => alive && setLoaded({ secret, wallet }));
    return () => {
      alive = false;
    };
  }, [secret]);
  const hydrated = useSyncExternalStore(() => () => {}, () => true, () => false);
  const wallet = !hydrated ? undefined : !secret ? null : loaded?.secret === secret ? loaded.wallet : undefined;

  // Not defteri: localStorage'daki kopya (her değişiklikte olay yayınlanır) + periyodik zincir senkronu.
  const bookRaw = useSyncExternalStore(
    subscribeBook,
    () => (wallet ? JSON.stringify(wallet.load()) : ""),
    () => "",
  );
  const book = useMemo(() => (bookRaw ? (JSON.parse(bookRaw) as Book) : undefined), [bookRaw]);
  usePoll(async () => (wallet ? wallet.sync() : null), 8_000, [wallet]);

  // Yatırma adresine gelen MON'u gizli dolar notuna çevir.
  const infoData = info.data;
  useEffect(() => {
    if (!wallet || !infoData?.gateway) return;
    let busy = false;
    let failures = 0;
    const tick = async () => {
      if (busy || paused.current) return;
      busy = true;
      try {
        const bal = await wallet.monBalance();
        failures = 0;
        setSweep((s) => (s.state === "error" ? { ...s, state: "idle", error: undefined } : s));
        if (bal > 0n) {
          setSweep((s) => ({ ...s, state: "sweeping", mon: bal, error: undefined }));
          const r = await wallet.sweepDeposit(infoData);
          setSweep((s) => ({ state: "idle", last: r ? { usd: r.usd, at: Date.now() } : s.last, mon: r ? undefined : bal }));
        }
      } catch (e) {
        // Tek seferlik RPC/ağ hatası bir sonraki denemede düzelir; yalnızca üst üste hatada göster.
        failures += 1;
        if (failures >= 3 || !isNetworkError(e)) setSweep((s) => ({ ...s, state: "error", error: shortError(e) }));
      } finally {
        busy = false;
      }
    };
    tick();
    const id = setInterval(tick, config.devChain ? 3_000 : 6_000);
    return () => clearInterval(id);
  }, [wallet, infoData]);

  const quote = infoData?.quoteToken;
  const { cash, pendingCash } = useMemo(() => {
    if (!wallet || !book || !quote) return { cash: 0n, pendingCash: 0n };
    return { cash: wallet.balance(book, quote), pendingCash: wallet.balance(book, quote, "pending") };
  }, [wallet, book, quote]);

  const refreshPools = pools.refresh;
  const refreshInfo = info.refresh;
  const refreshData = useCallback(() => {
    refreshPools();
    refreshInfo();
  }, [refreshPools, refreshInfo]);

  const value: Ctx = {
    pools: pools.data,
    poolsError: pools.error,
    info: info.data,
    infoError: info.error,
    refreshData,
    wallet,
    book,
    cash,
    pendingCash,
    sweep,
    funds,
    openFunds: (tab = "deposit") => setFunds(tab),
    closeFunds: () => setFunds(null),
    setSweepPaused: (v) => {
      paused.current = v;
    },
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

const isNetworkError = (e: unknown) => /HTTP request failed|Failed to fetch|NetworkError|timed out|429/i.test((e as Error)?.message ?? "");

/** viem hata metninin ilk satırı (istek gövdesi ve sürüm ayrıntısı olmadan). */
function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  if (isNetworkError(e)) return "RPC'ye ulaşılamıyor, tekrar deneniyor";
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
}
