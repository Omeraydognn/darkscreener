"use client";

import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Download, Loader2, Lock, Clock3, ShieldCheck, Wallet } from "lucide-react";
import type { Info, Pool } from "@/lib/api";
import { config } from "@/lib/config";
import { duration, fmtNum, shortAddr, units } from "@/lib/format";
import { devSigner, injectedSigner, ShieldedWallet, toRaw, type NoteRec, type OrderRec } from "@/lib/wallet";
import { useNow, usePoll } from "./usePoll";

type Tab = "buy" | "sell" | "deposit" | "withdraw";
type Book = { notes: NoteRec[]; orders: OrderRec[] };
const EMPTY: Book = { notes: [], orders: [] };

const btn =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

export function TradePanel({ pool, info }: { pool: Pool | undefined; info: Info | undefined }) {
  const [previewAmount, setPreviewAmount] = useState("100");
  const [wallet, setWallet] = useState<ShieldedWallet | null>(null);
  const [initialBook, setInitialBook] = useState<Book>(EMPTY);
  const [tab, setTab] = useState<Tab>("buy");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Not defteri: bekleyen notları ağaçta arar, emir durumlarını ve açılan sonuçları günceller.
  const synced = usePoll(async () => (wallet ? wallet.sync() : EMPTY), 5000, [wallet]);
  const book = synced.data ?? initialBook;
  const sync = synced.refresh;

  const connect = (w: ShieldedWallet) => {
    setInitialBook(w.load());
    setWallet(w);
  };

  const run = async (label: string, fn: (step: (s: string) => void) => Promise<string | void>) => {
    setErr(null);
    setOk(null);
    setBusy(label);
    try {
      const msg = await fn((s) => setBusy(s));
      if (msg) setOk(msg);
      sync();
    } catch (e) {
      setErr((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  };



  const quote = pool?.quote;
  const base = pool?.base;
  const tokens = [quote, base].filter((t): t is Pool["base"] => !!t);
  const dec = (addr: string) => (addr.toLowerCase() === quote?.address.toLowerCase() ? quote?.decimals ?? 6 : base?.decimals ?? 18);
  const sym = (addr: string) => (addr.toLowerCase() === quote?.address.toLowerCase() ? quote?.symbol : addr.toLowerCase() === base?.address.toLowerCase() ? base?.symbol : shortAddr(addr));

  // ---- bağlı değil
  if (!wallet || !pool || !info || !quote || !base) {
    return <div className="trade-preview">
      <div className="trade-switch"><button className={tab !== "sell" ? "active" : ""} onClick={() => setTab("buy")} aria-pressed={tab !== "sell"}>Yatırım yap</button><button className={tab === "sell" ? "active" : ""} onClick={() => setTab("sell")} aria-pressed={tab === "sell"}>Pozisyonu sat</button></div>
      <div className="preview-amount"><label htmlFor="preview-amount">{tab === "sell" ? "Satılacak tutar" : "Yatırım tutarın"}</label><div><input id="preview-amount" inputMode="decimal" autoComplete="off" value={previewAmount} onChange={e => setPreviewAmount(e.target.value)} aria-label="İşlem tutarı"/><span>{(tab === "sell" ? base?.symbol : quote?.symbol) ?? "—"}</span></div></div>
      <div className="quick-amounts">{[50,100,250,500].map(n => <button key={n} onClick={() => setPreviewAmount(String(n))}>{n}</button>)}</div>
      <div className="trade-details"><p><span>{tab === "sell" ? "Satış geliri" : "Alacağın token"}</span><strong><Lock size={12}/> Gizli</strong></p><p><span>İşlem fiyatı</span><strong><Lock size={12}/> Gizli</strong></p><p><span>Sonucun açılması</span><strong><Clock3 size={12}/> 7 gün sonra</strong></p></div>
      <div className="trade-disclaimer"><ShieldCheck size={15}/><span>Emrin gizli işlenir. Token miktarı ve sonuç işlem anında gösterilmez. Satım geliri kilit açıldıktan sonra çekilebilir.</span></div>
      <button type="button" disabled={!!busy || !pool || !info} onClick={() => run("Cüzdan bağlanıyor", async () => connect(await ShieldedWallet.open(await injectedSigner())))} className={`${btn} connect-button`}><Wallet size={15}/>{busy ?? (!pool || !info ? "Veri bağlantısı bekleniyor" : "Cüzdan bağla")}</button>
      <p className="connect-caption">{pool && info ? "Bağlandıktan sonra emrini inceleyip onaylayabilirsin." : "İşlem yapmak için proje ve ağ verileri gerekli."}</p>
      {config.devChain && pool && info && <button type="button" disabled={!!busy} onClick={() => run("Geliştirici cüzdanı açılıyor", async () => connect(await ShieldedWallet.open(devSigner())))} className={`${btn} w-full border border-line text-xs hover:bg-panel-2`}>Geliştirici cüzdanı · yerel zincir</button>}
      <Status busy={busy} err={err} ok={ok}/>
    </div>;
  }

  const balances = tokens.map((t) => {
    const mine = book.notes.filter((n) => n.token.toLowerCase() === t.address.toLowerCase());
    const sum = (st: NoteRec["status"]) => mine.filter((n) => n.status === st).reduce((a, n) => a + BigInt(n.amount), 0n);
    return { t, ready: sum("ready"), pending: sum("pending") };
  });
  const poolOrders = book.orders.filter((o) => o.poolId === pool.poolId);

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          <ShieldCheck className="size-3.5 text-buy" aria-hidden /> Gizli hesap · {shortAddr(wallet.signer.address)}
          {wallet.signer.kind === "dev" && <span className="rounded bg-warn/15 px-1 text-warn">dev</span>}
        </span>
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([wallet.exportBackup()], { type: "application/json" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "darkscreener-gizli-yedek.json";
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="inline-flex h-8 items-center gap-1 rounded px-2 text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Download className="size-3.5" aria-hidden /> Yedek
        </button>
      </div>

      <ul className="grid grid-cols-2 gap-2" aria-label="Gizli bakiyeler">
        {balances.map(({ t, ready, pending }) => (
          <li key={t.address} className="rounded-md border border-line bg-panel-2 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted">Gizli {t.symbol}</p>
            <p className="num font-semibold">{fmtNum(units(ready, t.decimals ?? 18))}</p>
            {pending > 0n && <p className="num text-[11px] text-muted">+{fmtNum(units(pending, t.decimals ?? 18))} bekliyor</p>}
          </li>
        ))}
      </ul>

      <div role="tablist" aria-label="İşlem türü" className="grid grid-cols-4 rounded-md border border-line p-0.5">
        {(
          [
            ["buy", "Al"],
            ["sell", "Sat"],
            ["deposit", "Yatır"],
            ["withdraw", "Çek"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`h-9 rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              tab === k ? (k === "buy" ? "bg-buy/15 text-buy" : k === "sell" ? "bg-sell/15 text-sell" : "bg-panel-2 text-fg") : "text-muted hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {(tab === "buy" || tab === "sell") && (
        <OrderForm
          key={tab}
          side={tab}
          initialAmount={previewAmount}
          token={tab === "buy" ? quote : base}
          busy={!!busy}
          onSubmit={(amount) =>
            run("Emir hazırlanıyor", async (step) => {
              const inToken = (tab === "buy" ? quote.address : base.address) as `0x${string}`;
              await wallet.placeOrder({ info, poolId: pool.poolId, side: tab, inToken, amount }, step);
              return "Emir gönderildi. Sonucu 7 gün sonra burada göreceksiniz.";
            })
          }
        />
      )}

      {tab === "deposit" && (
        <DepositForm
          tokens={tokens}
          busy={!!busy}
          onDeposit={(token, amount) =>
            run("Yatırılıyor", async () => {
              await wallet.deposit(token, amount);
              return "Yatırıldı. Not ağaca eklenince kullanılabilir olur.";
            })
          }
          onFaucet={
            config.testTokens
              ? () =>
                  run("Test tokenları basılıyor", async () => {
                    await wallet.faucet(tokens);
                    return "Test tokenları cüzdanınızda.";
                  })
              : undefined
          }
        />
      )}

      {tab === "withdraw" && (
        <WithdrawList
          notes={book.notes.filter((n) => n.status === "ready")}
          defaultRecipient={wallet.signer.address}
          sym={sym}
          dec={dec}
          busy={!!busy}
          onWithdraw={(c, to) =>
            run("Çekiliyor", async (step) => {
              await wallet.withdraw(c, to, step);
              return "Çekildi. Gazı relayer ödedi.";
            })
          }
        />
      )}

      <Status busy={busy} err={err} ok={ok} />

      <section aria-label="Emirlerim">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Emirlerim · {pool.base.symbol}</p>
        {poolOrders.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-3 text-center text-xs text-muted">Bu projede henüz emriniz yok.</p>
        ) : (
          <ul className="space-y-1.5">
            {poolOrders.map((o) => (
              <li key={o.orderId} className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className={o.side === "buy" ? "text-buy" : "text-sell"}>{o.side === "buy" ? "Alım" : "Satım"}</span>
                  <span className="num">
                    {fmtNum(units(o.amountIn, dec(o.inToken)))} {sym(o.inToken)}
                  </span>
                </div>
                <OrderState o={o} sym={sym} dec={dec} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function OrderState({ o, sym, dec }: { o: OrderRec; sym: (a: string) => string | undefined; dec: (a: string) => number }) {
  const now = useNow();
  if (o.state === "revealed" && o.result)
    return (
      <p className="num mt-1 text-buy">
        Açıldı: {fmtNum(units(o.result.amountOut, dec(o.result.outToken)))} {sym(o.result.outToken)}
      </p>
    );
  if (o.state === "refunded") return <p className="mt-1 text-warn">İade edildi (fon gizli notunuza döndü)</p>;
  if (o.state === "locked" && o.unlockTime)
    return (
      <p className="mt-1 flex items-center gap-1 text-muted">
        <Lock className="size-3 text-accent" aria-hidden /> Kilitli · açılışa <span className="num text-fg">{duration(o.unlockTime - now)}</span>
      </p>
    );
  return <p className="mt-1 text-muted">Batch bekleniyor…</p>;
}

function Status({ busy, err, ok }: { busy: string | null; err: string | null; ok: string | null }) {
  return (
    <div aria-live="polite" className="min-h-5 text-xs">
      {busy && (
        <p className="flex items-center gap-2 text-muted">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> {busy}
        </p>
      )}
      {!busy && err && <p className="text-sell" role="alert">{err}</p>}
      {!busy && !err && ok && <p className="text-buy">{ok}</p>}
    </div>
  );
}

function OrderForm({ side, token, busy, onSubmit, initialAmount }: {
  initialAmount: string;
  side: "buy" | "sell";
  token: Pool["base"];
  busy: boolean;
  onSubmit: (amount: bigint) => void;
}) {
  const [v, setV] = useState(initialAmount);
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = `amount-${side}`;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const raw = toRaw(v, token.decimals ?? 18);
          if (raw <= 0n) throw new Error("Tutar girin");
          setErr(null);
          onSubmit(raw);
        } catch (x) {
          setErr((x as Error).message);
        }
      }}
    >
      <label htmlFor={id} className="text-xs text-muted">
        {side === "buy" ? "Harcanacak" : "Satılacak"} tutar ({token.symbol})
      </label>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="0,00"
        aria-invalid={!!err}
        aria-describedby={err ? `${id}-err` : undefined}
        className="num h-10 w-full rounded-md border border-line bg-bg px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {err && <p id={`${id}-err`} className="text-xs text-sell">{err}</p>}
      <label className="flex cursor-pointer items-start gap-2 text-xs text-muted">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
        <span>
          Fiyatın gizli olduğunu, {side === "buy" ? "kaç token alacağımı" : "ne kadar alacağımı"} <strong className="text-fg">7 gün sonra</strong> göreceğimi ve emrin geri alınamadığını anlıyorum.
        </span>
      </label>
      <button
        type="submit"
        disabled={busy || !ack || !v}
        className={`${btn} w-full ${side === "buy" ? "bg-buy text-bg hover:bg-buy/90" : "bg-sell text-bg hover:bg-sell/90"}`}
      >
        {side === "buy" ? "Gizli al" : "Gizli sat"}
      </button>
    </form>
  );
}

function DepositForm({ tokens, busy, onDeposit, onFaucet }: {
  tokens: Pool["base"][];
  busy: boolean;
  onDeposit: (token: `0x${string}`, amount: bigint) => void;
  onFaucet?: () => void;
}) {
  const [ti, setTi] = useState(0);
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const t = tokens[ti];
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const raw = toRaw(v, t.decimals ?? 18);
          if (raw <= 0n) throw new Error("Tutar girin");
          setErr(null);
          onDeposit(t.address, raw);
        } catch (x) {
          setErr((x as Error).message);
        }
      }}
    >
      <fieldset className="grid grid-cols-2 gap-1" aria-label="Token">
        {tokens.map((x, i) => (
          <button
            key={x.address}
            type="button"
            aria-pressed={ti === i}
            onClick={() => setTi(i)}
            className={`h-9 rounded-md border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${ti === i ? "border-accent text-fg" : "border-line text-muted"}`}
          >
            {x.symbol}
          </button>
        ))}
      </fieldset>
      <label htmlFor="deposit-amount" className="text-xs text-muted">Yatırılacak tutar ({t.symbol})</label>
      <input
        id="deposit-amount"
        inputMode="decimal"
        autoComplete="off"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="0,00"
        className="num h-10 w-full rounded-md border border-line bg-bg px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {err && <p className="text-xs text-sell">{err}</p>}
      <p className="text-[11px] text-muted">Yatırma tutarı zincirde görünür; sonraki gizli işlemlerinizle ilişkilendirilemez.</p>
      <button type="submit" disabled={busy || !v} className={`${btn} w-full bg-accent text-bg hover:bg-accent/90`}>
        <ArrowDownToLine className="size-4" aria-hidden /> Gizli nota yatır
      </button>
      {onFaucet && (
        <button type="button" disabled={busy} onClick={onFaucet} className={`${btn} w-full border border-line hover:bg-panel-2`}>
          Demo token al (10.000 adet, test ağı)
        </button>
      )}
    </form>
  );
}

function WithdrawList({ notes, defaultRecipient, sym, dec, busy, onWithdraw }: {
  notes: NoteRec[];
  defaultRecipient: string;
  sym: (a: string) => string | undefined;
  dec: (a: string) => number;
  busy: boolean;
  onWithdraw: (commitment: string, to: `0x${string}`) => void;
}) {
  const [to, setTo] = useState(defaultRecipient);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to);
  if (!notes.length)
    return <p className="rounded-md border border-dashed border-line p-3 text-center text-xs text-muted">Çekilebilir hazır notunuz yok.</p>;
  return (
    <div className="space-y-2">
      <label htmlFor="recipient" className="text-xs text-muted">Alıcı adres (yeni bir adres de olabilir; gazı relayer öder)</label>
      <input
        id="recipient"
        value={to}
        onChange={(e) => setTo(e.target.value.trim())}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!valid}
        className="num h-10 w-full rounded-md border border-line bg-bg px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {!valid && <p className="text-xs text-sell">Geçerli bir adres girin</p>}
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.commitment} className="flex items-center justify-between rounded-md border border-line bg-panel-2 px-3 py-1.5 text-xs">
            <span className="num">
              {fmtNum(units(n.amount, dec(n.token)))} {sym(n.token)}
              <span className="ml-2 text-muted">{{ deposit: "yatırma", change: "para üstü", output: "işlem sonucu", refund: "iade" }[n.origin]}</span>
            </span>
            <button
              type="button"
              disabled={busy || !valid}
              onClick={() => onWithdraw(n.commitment, to as `0x${string}`)}
              className={`${btn} h-8 border border-line px-3 hover:bg-bg`}
            >
              <ArrowUpFromLine className="size-3.5" aria-hidden /> Çek
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
