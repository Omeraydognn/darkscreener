"use client";

import { useState } from "react";
import { Clock3, Loader2, Lock, ShieldCheck, Wallet } from "lucide-react";
import type { Pool } from "@/lib/api";
import { duration, fmtToken, fmtUsd } from "@/lib/format";
import { positions, toRaw, USD_DECIMALS } from "@/lib/wallet";
import { useNow } from "../usePoll";
import { useApp } from "./AppProvider";
import { AccountSetup } from "./AccountSetup";

const PCTS = [25, 50, 75, 100];

/** Gizli al/sat: alımda yalnızca dolar tutarı, satışta yalnızca yüzde girilir. Sonuç 7 gün sonra açılır. */
export function TradeBox({ pool }: { pool: Pool | undefined }) {
  const { wallet, info, cash, book, openFunds } = useApp();
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [usd, setUsd] = useState("");
  const [pct, setPct] = useState<number | "other">(50);
  const [otherPct, setOtherPct] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const now = useNow();

  const pos = wallet && book && pool ? positions(wallet, book, [pool])[0] : undefined;
  const held = pos?.held ?? 0n;
  const lots = wallet && book && pool ? wallet.sellableLots(book, pool.poolId) : [];
  const pending = wallet && book && pool ? wallet.pendingLots(book, pool.poolId) : { settling: 0, selling: 0 };
  const canSell = held > 0n || lots.length > 0;

  let buyRaw = 0n;
  let buyErr: string | undefined;
  try {
    buyRaw = usd ? toRaw(usd, USD_DECIMALS) : 0n;
    if (buyRaw > cash) buyErr = "Nakit bakiyeni aşıyor";
  } catch (e) {
    buyErr = (e as Error).message;
  }
  const sellPct = pct === "other" ? Number(otherPct.replace(",", ".")) : pct;
  const sellValid = sellPct > 0 && sellPct <= 100;

  const run = async (label: string, fn: (step: (s: string) => void) => Promise<string>) => {
    setErr(undefined);
    setOk(undefined);
    setBusy(label);
    try {
      setOk(await fn(setBusy));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const header = (
    <div className="trade-switch" role="tablist">
      <button role="tab" aria-selected={tab === "buy"} className={tab === "buy" ? "active" : ""} onClick={() => setTab("buy")}>Gizli al</button>
      <button role="tab" aria-selected={tab === "sell"} className={tab === "sell" ? "active" : ""} onClick={() => setTab("sell")}>Gizli sat</button>
    </div>
  );

  if (!wallet)
    return (
      <div className="trade-preview grid gap-4">
        {header}
        {wallet === undefined ? <p className="text-center text-muted">Hesap yükleniyor…</p> : <AccountSetup compact />}
      </div>
    );


  return (
    <div className="trade-preview grid gap-4">
      {header}
      {tab === "buy" ? (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pool || !info) return;
            run("Hazırlanıyor", async (step) => {
              await wallet.buy(info, pool, buyRaw, step);
              setUsd("");
              return `${fmtUsd(buyRaw)} tutarında gizli alım gönderildi. Aldığın ${pool.base.symbol} miktarını 7 gün sonra göreceksin.`;
            });
          }}
        >
          <div className="preview-amount">
            <label htmlFor="buy-usd">Yatırım tutarın</label>
            <div>
              <input id="buy-usd" inputMode="decimal" autoComplete="off" placeholder="0" value={usd} onChange={(e) => setUsd(e.target.value)} />
              <span>USD</span>
            </div>
          </div>
          <div className="quick-amounts">
            {[25, 50, 75, 100].map((n) => (
              <button type="button" key={n} disabled={cash === 0n} onClick={() => setUsd(((Number(cash) * n) / 100 / 1e6).toFixed(n === 100 ? 6 : 2).replace(/\.?0+$/, "").replace(".", ","))}>
                {n === 100 ? "Tümü" : `%${n}`}
              </button>
            ))}
          </div>
          <div className="trade-details">
            <p><span>Nakit</span><strong className="num">{fmtUsd(cash)}</strong></p>
            <p><span>Alacağın {pool?.base.symbol ?? "token"}</span><strong><Lock size={12} /> 7 gün sonra görünür</strong></p>
            <p><span>İşlem fiyatı</span><strong><Lock size={12} /> Gizli</strong></p>
          </div>
          {cash === 0n ? (
            <button type="button" className="connect-button btn-primary" onClick={() => openFunds("deposit")}><Wallet size={15} /> Önce para yatır</button>
          ) : (
            <>
              <label className="flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
                Kaç token alacağımı 7 gün sonra göreceğimi anlıyorum.
              </label>
              {buyErr && usd && <p className="form-error">{buyErr}</p>}
              <button type="submit" className="connect-button btn-primary" disabled={!!busy || !ack || !buyRaw || !!buyErr || !pool || !info}>
                {busy ? <><Loader2 size={15} className="animate-spin" /> {busy}</> : `Gizli al${buyRaw ? ` · ${fmtUsd(buyRaw)}` : ""}`}
              </button>
            </>
          )}
        </form>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pool || !info) return;
            run("Hazırlanıyor", async (step) => {
              await wallet.sell(info, pool, sellPct, step);
              return `%${sellPct} gizli satış gönderildi. Satış gelirini 7 gün sonra göreceksin.${lots.length ? " Kilitli alımların da bu yüzdeyle satıldı; miktarı enclave hesaplar." : ""}`;
            });
          }}
        >
          <div>
            <p className="mb-2 text-xs text-muted">Eldeki {pool?.base.symbol ?? "token"}&apos;ın ne kadarını satmak istiyorsun?</p>
            <div className="pct-grid">
              {PCTS.map((p) => (
                <button type="button" key={p} className={pct === p ? "active" : ""} aria-pressed={pct === p} onClick={() => setPct(p)}>%{p}</button>
              ))}
              <button type="button" className={pct === "other" ? "active" : ""} aria-pressed={pct === "other"} onClick={() => setPct("other")}>Diğer</button>
            </div>
            {pct === "other" && (
              <label className="field mt-3">
                <span>Yüzde</span>
                <div className="input-row">
                  <input inputMode="decimal" autoComplete="off" placeholder="örn. 33" value={otherPct} onChange={(e) => setOtherPct(e.target.value)} />
                  <span className="px-3 text-muted">%</span>
                </div>
              </label>
            )}
          </div>
          <div className="trade-details">
            <p><span>Satılacak miktar</span><strong><Lock size={12} /> Gösterilmez</strong></p>
            <p><span>Satış geliri</span><strong><Clock3 size={12} /> 7 gün sonra</strong></p>
          </div>
          {lots.length > 0 && (
            <p className="text-xs text-muted">
              Kilidi açılmamış alımların da bu yüzdeyle satılır. Miktarı sen de bilmezsin; enclave hesaplar ve satış gelirini 7 gün sonra görürsün.
            </p>
          )}
          {!canSell ? (
            <p className="rounded-md border border-dashed border-line p-3 text-center text-xs text-muted">
              {pending.settling
                ? "Alımın işleme alınıyor; pencere kapanıp işlenince (birkaç dakika) kilitliyken de satabilirsin."
                : pending.selling
                  ? "Önceki satış emrin işleniyor; işlenince kalan kısmı yeniden satabilirsin."
                  : `Satılabilir ${pool?.base.symbol ?? "token"} yok. Önce gizli alım yap.`}
            </p>
          ) : (
            <button type="submit" className="connect-button btn-primary" disabled={!!busy || !sellValid || !pool || !info}>
              {busy ? <><Loader2 size={15} className="animate-spin" /> {busy}</> : `%${sellValid ? sellPct : "—"} gizli sat`}
            </button>
          )}
        </form>
      )}
      {err && <p className="form-error" role="alert">{err}</p>}
      {ok && <p className="text-sm text-buy" role="status">{ok}</p>}
      <div className="trade-disclaimer"><ShieldCheck size={15} /><span>Emrin şifrelenir, sıfır bilgi kanıtıyla relayer üzerinden gönderilir; cüzdan adresin emirle ilişkilendirilemez.</span></div>
      {pos && (pos.invested > 0n || pos.held > 0n) && (
        <div className="position-mini">
          <p className="mini-eyebrow">BU PROJEDEKİ POZİSYONUN</p>
          <p><span>Yatırılan</span><strong className="num">{fmtUsd(pos.invested)}</strong></p>
          <p><span>{pool?.base.symbol}</span><strong className="num">{pos.lockedBuys ? `Bilinmiyor · ${pos.nextBuyUnlock ? duration(pos.nextBuyUnlock - now) : "kilitli"}` : fmtToken(pos.held, pool?.base.decimals ?? 18)}</strong></p>
          {pos.lockedSells > 0 && <p><span>Satış geliri</span><strong>Kilitli · {pos.nextSellUnlock ? duration(pos.nextSellUnlock - now) : "settle bekleniyor"}</strong></p>}
        </div>
      )}
    </div>
  );
}
