"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Download, HelpCircle, KeyRound, LockKeyhole, LogOut, Rocket, Upload } from "lucide-react";
import { config } from "@/lib/config";
import { dateFmt, duration, fmtMon, fmtToken, fmtUsd, shortAddr } from "@/lib/format";
import { accountStore, positions, type OrderRec } from "@/lib/wallet";
import { useNow } from "../usePoll";
import { useApp } from "../app/AppProvider";
import { AccountSetup } from "../app/AccountSetup";

const symbol = config.devChain ? "ETH" : "MON";

/** Portföy: bilinen nakit, pozisyonlar (kilitliyken "Bilinmiyor"), işlem geçmişi ve hesap yedeği. */
export function Portfolio() {
  const { wallet, book, pools, cash, pendingCash, openFunds } = useApp();
  const now = useNow();

  if (!wallet)
    return (
      <div className="mx-auto mt-10 max-w-md">
        <section className="panel-box p-6">
          <h1 className="mb-4 text-xl font-semibold">Gizli hesabın</h1>
          {wallet === undefined ? <p className="text-muted">Hesap yükleniyor…</p> : <AccountSetup />}
        </section>
      </div>
    );

  const pos = book && pools ? positions(wallet, book, pools) : [];
  const lockedCount = pos.reduce((a, p) => a + p.lockedBuys + p.lockedSells, 0);
  const lotCount = pos.reduce((a, p) => a + p.lockedLots, 0);
  const pool = (id: number) => pools?.find((p) => p.poolId === id);
  const groups = groupOrders(book?.orders ?? []);

  return (
    <>
      <section className="portfolio-head">
        <div>
          <span className="mini-eyebrow">GİZLİ HESAP</span>
          <h1 className="mt-1 text-2xl font-semibold">Portföy</h1>
          <p className="num mt-1 text-sm text-muted">Yatırma adresi: {shortAddr(wallet.depositAddress)}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={() => openFunds("deposit")}><ArrowDownToLine size={15} /> Yatır</button>
          <button type="button" className="btn-secondary" onClick={() => openFunds("withdraw")}><ArrowUpFromLine size={15} /> Çek</button>
        </div>
      </section>

      <div className="summary-cards">
        <div className="summary-card">
          <span>Toplam</span>
          <strong className="num">{fmtUsd(cash)}{pos.length ? <span className="unknown"> + bilinmiyor</span> : null}</strong>
          <small>Nakit bilinir; token pozisyonlarının değeri canlı fiyat olmadığı için bilinmez.</small>
        </div>
        <div className="summary-card">
          <span>Nakit (yatırımda değil)</span>
          <strong className="num">{fmtUsd(cash)}</strong>
          <small>{pendingCash > 0n ? `${fmtUsd(pendingCash)} onaylanıyor` : "Harcanabilir gizli dolar"}</small>
        </div>
        <div className="summary-card">
          <span>Token pozisyonları</span>
          <strong className="unknown">Bilinmiyor</strong>
          <small>{pos.length} proje · {lockedCount} kilitli işlem{lotCount ? ` · ${lotCount} kilitli lot` : ""}</small>
        </div>
      </div>

      <section className="panel-box mt-6" aria-labelledby="pos-h">
        <div className="panel-title"><span id="pos-h"><LockKeyhole size={16} /> Pozisyonlar</span></div>
        {pos.length === 0 ? (
          <div className="p-8 text-center text-muted">
            Henüz pozisyonun yok. <Link href="/" className="text-accent hover:underline">Projeleri keşfet</Link> ve gizli alım yap.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="explore-table">
              <thead>
                <tr>
                  <th>Proje</th>
                  <th className="text-right">Yatırılan</th>
                  <th className="text-right">Elindeki token</th>
                  <th className="text-right">Satılan</th>
                  <th className="text-right">Satış geliri</th>
                </tr>
              </thead>
              <tbody>
                {pos.map((p) => {
                  const pl = pool(p.poolId);
                  const dec = pl?.base.decimals ?? 18;
                  return (
                    <tr key={p.poolId}>
                      <td>
                        <Link href={`/token/${p.poolId}`} className="flex items-center gap-3">
                          <span className="project-avatar">{(pl?.base.symbol ?? "P").slice(0, 2)}</span>
                          <span><strong className="block">{pl?.project?.name ?? pl?.base.name}</strong><small className="text-muted">{pl?.base.symbol}</small></span>
                        </Link>
                      </td>
                      <td className="num text-right">{fmtUsd(p.invested)}</td>
                      <td className="num text-right">
                        {p.lockedLots ? (
                          <Unknown
                            label={`${p.lockedLots} kilitli lot · ${p.nextLotUnlock ? `${duration(p.nextLotUnlock - now)} sonra açılır` : "settle bekleniyor"}`}
                            extra={p.held > 0n ? `+ ${fmtToken(p.held, dec)}` : undefined}
                          />
                        ) : (
                          `${fmtToken(p.held, dec)} ${pl?.base.symbol ?? ""}`
                        )}
                      </td>
                      <td className="num text-right">
                        {p.soldUnknown ? (
                          <Unknown label={`${p.lotSells} kilitli lot satışı · kalan kısım kilitli`} extra={p.sold > 0n ? `+ ${fmtToken(p.sold, dec)}` : undefined} />
                        ) : p.sold > 0n ? (
                          <span className="inline-flex flex-col items-end">
                            <span>{fmtToken(p.sold, dec)} {pl?.base.symbol ?? ""}</span>
                            {p.lotSells > 0 && <small className="text-muted">kalan lot: {fmtToken(p.remainder, dec)} {pl?.base.symbol ?? ""}</small>}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="num text-right">
                        {p.lockedSells ? (
                          <Unknown label={p.nextSellUnlock ? `kilit: ${duration(p.nextSellUnlock - now)}` : "settle bekleniyor"} extra={p.proceeds > 0n ? `+ ${fmtUsd(p.proceeds)}` : undefined} />
                        ) : p.proceeds > 0n ? fmtUsd(p.proceeds) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="panel-box" aria-labelledby="act-h">
          <div className="panel-title"><span id="act-h">İşlem geçmişi</span></div>
          <ul className="divide-y divide-line">
            {groups.length === 0 && !book?.activity.length && <li className="p-6 text-center text-muted">Henüz işlem yok.</li>}
            {merge(groups, book?.activity ?? []).map((row) =>
              row.kind === "order" ? (
                <li key={row.g.group} className="activity-row">
                  <span className={`tag ${row.g.side === "buy" ? "buy" : "sell"}`}>{row.g.side === "buy" ? "Alım" : "Satış"}</span>
                  <span className="min-w-0 flex-1">
                    <strong>{pool(row.g.poolId)?.project?.name ?? `#${row.g.poolId}`}</strong>
                    <small className="block text-muted">
                      {dateFmt.format(row.g.createdAt)}
                      {row.g.parts.some((p) => p.lot) ? " · kilitli lot satışı" : ""}
                    </small>
                  </span>
                  <span className="num text-right">
                    {row.g.side === "buy" ? fmtUsd(row.g.amountIn) : row.g.pct ? `%${row.g.pct}` : "—"}
                    <small className="block text-muted">{orderState(row.g, now, pool(row.g.poolId)?.base.symbol, pool(row.g.poolId)?.base.decimals ?? 18)}</small>
                  </span>
                </li>
              ) : (
                <li key={`${row.a.kind}-${row.a.time}`} className="activity-row">
                  <span className={`tag ${row.a.kind === "withdraw" ? "sell" : "neutral"}`}>{row.a.kind === "deposit" ? "Yatırma" : row.a.kind === "withdraw" ? "Çekim" : "Proje"}</span>
                  <span className="min-w-0 flex-1">
                    <strong>{row.a.kind === "launch" ? (row.a.poolId ? pool(row.a.poolId)?.project?.name ?? `Havuz #${row.a.poolId}` : "Proje açılışı") : row.a.kind === "withdraw" ? `→ ${shortAddr(row.a.to)}` : `${row.a.mon ? fmtMon(row.a.mon, symbol) : ""} gönderildi`}</strong>
                    <small className="block text-muted">{dateFmt.format(row.a.time)}{row.a.note ? ` · ${row.a.note}` : ""}</small>
                  </span>
                  <span className="num text-right">
                    {row.a.kind === "launch" ? fmtMon(row.a.mon ?? "0", symbol) : fmtUsd(row.a.usd)}
                    <small className={`block ${row.a.status === "failed" ? "text-sell" : "text-muted"}`}>{row.a.status === "pending" ? "işleniyor" : row.a.status === "failed" ? "başarısız" : "tamamlandı"}</small>
                  </span>
                </li>
              ),
            )}
          </ul>
        </section>
        <AccountBox />
      </div>
    </>
  );
}

function Unknown({ label, extra }: { label: string; extra?: string }) {
  return (
    <span className="inline-flex flex-col items-end">
      <span className="unknown inline-flex items-center gap-1"><HelpCircle size={13} /> Bilinmiyor {extra}</span>
      <small className="text-muted">{label}</small>
    </span>
  );
}

type Group = OrderRec & { amountIn: string; parts: OrderRec[] };

function groupOrders(orders: OrderRec[]): Group[] {
  const map = new Map<string, Group>();
  for (const o of orders) {
    const g = map.get(o.group);
    if (g) {
      g.parts.push(o);
      g.amountIn = (BigInt(g.amountIn) + BigInt(o.amountIn)).toString();
    } else map.set(o.group, { ...o, parts: [o] });
  }
  return [...map.values()];
}

function merge(groups: Group[], activity: NonNullable<ReturnType<typeof useApp>["book"]>["activity"]) {
  const rows = [
    ...groups.map((g) => ({ kind: "order" as const, t: g.createdAt, g })),
    ...activity.map((a) => ({ kind: "act" as const, t: a.time, a })),
  ];
  return rows.sort((a, b) => b.t - a.t).slice(0, 60);
}

function orderState(g: Group, now: number, sym = "", dec = 18) {
  // Reddedilen lot satışında lot olduğu gibi kalır (not harcanmadı): "iade" değil
  if (g.parts.every((p) => p.state === "refunded")) return g.parts.every((p) => p.lot) ? "reddedildi · lot aynen duruyor" : "iade edildi";
  const soldLocked = g.side === "buy" && g.parts.some((p) => p.lotSale?.state === "sold");
  if (g.parts.every((p) => p.state === "revealed" || p.state === "refunded")) {
    const out = g.parts.reduce((a, p) => a + BigInt(p.result?.amountOut ?? "0"), 0n);
    if (g.side === "buy") return `${fmtToken(out, dec)} ${sym} alındı${soldLocked ? " · kilitliyken satıldı" : ""}`;
    const lots = g.parts.filter((p) => p.lot && p.remainder);
    const rest = lots.reduce((a, p) => a + BigInt(p.remainder!.amount), 0n);
    return `${fmtUsd(out)} gelir${lots.length ? ` · kalan lot ${fmtToken(rest, dec)} ${sym}` : ""}`;
  }
  if (g.parts.some((p) => p.lotSale?.state === "pending")) return "kilitli · satışta";
  const t = g.parts.map((p) => p.unlockTime).filter((x): x is number => !!x).sort((a, b) => a - b)[0];
  const lock = t ? `kilitli · ${duration(t - now)}` : "settle bekleniyor";
  return soldLocked ? `${lock} · kilitliyken satıldı` : lock;
}

function AccountBox() {
  const { wallet } = useApp();
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<string>();
  const download = () => {
    const blob = new Blob([wallet!.exportBackup()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `darkscreener-yedek-${wallet!.depositAddress.slice(2, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const pending = typeof window !== "undefined" ? sessionStorage.getItem("darkscreener:pending-book") : null;
  return (
    <section className="panel-box h-max" aria-labelledby="acc-h">
      <div className="panel-title"><span id="acc-h"><KeyRound size={16} /> Hesap ve yedek</span></div>
      <div className="grid gap-3 p-4 text-sm">
        <p className="text-muted">Gizli anahtarın ve not defterin yalnızca bu tarayıcıda. Tarayıcı verisi silinirse yedeksiz fonlara erişemezsin.</p>
        <button type="button" className="btn-primary" onClick={download}><Download size={15} /> Yedeği indir</button>
        {pending && (
          <button type="button" className="btn-secondary" onClick={() => {
            try {
              wallet!.importBook(pending);
              sessionStorage.removeItem("darkscreener:pending-book");
              setMsg("Not defteri geri yüklendi.");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}><Upload size={15} /> Yedekteki notları geri yükle</button>
        )}
        <button type="button" className="btn-secondary" onClick={() => setShow((s) => !s)}>{show ? "Anahtarı gizle" : "Gizli anahtarı göster"}</button>
        {show && <code className="num break-all rounded-md border border-line bg-panel-2 p-2 text-xs">{JSON.parse(wallet!.exportBackup()).secret}</code>}
        <Link href="/launch" className="btn-secondary"><Rocket size={15} /> Proje aç</Link>
        <button type="button" className="btn-danger" onClick={() => {
          if (confirm("Hesaptan çıkılsın mı? Yedeğin yoksa bu hesaba bir daha erişemezsin.")) accountStore.clear();
        }}><LogOut size={15} /> Hesaptan çık</button>
        {msg && <p className="text-xs text-muted">{msg}</p>}
      </div>
    </section>
  );
}
