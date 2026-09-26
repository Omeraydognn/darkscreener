"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, ChevronRight, Layers, LockKeyhole, Newspaper, Rocket, Shield, Wallet } from "lucide-react";
import { api, type History, type NewsItem, type Pool } from "@/lib/api";
import { delayedStats, toPoints } from "@/lib/ghost";
import { fmtCompact, fmtPct, fmtPrice, relTime } from "@/lib/format";
import { usePoll } from "../usePoll";
import { useApp } from "../app/AppProvider";
import { NewsModal } from "../app/NewsModal";

/** Keşfet: projeler canlı fiyata göre değil, gelişmelere göre listelenir; fiyatlar 7 gün gecikmelidir. */
export function Explore() {
  const { pools, info, wallet, openFunds } = useApp();
  const ids = (pools ?? []).map((p) => p.poolId).join(",");
  const histories = usePoll(
    async () => {
      const list = pools ?? [];
      const hs = await Promise.all(list.map((p) => api.history(p.poolId).catch(() => null)));
      return Object.fromEntries(list.map((p, i) => [p.poolId, hs[i]])) as Record<number, History | null>;
    },
    30_000,
    [ids],
  );
  const news = usePoll(() => api.news(undefined, 60), 15_000);
  const [open, setOpen] = useState<NewsItem | null>(null);
  const [sort, setSort] = useState<"news" | "new">("news");

  const rows = useMemo(() => {
    const list = [...(pools ?? [])];
    list.sort((a, b) => (sort === "news" ? b.news24h - a.news24h || a.poolId - b.poolId : b.createdAt - a.createdAt));
    return list.map((p) => {
      const h = histories.data?.[p.poolId];
      const stats = h ? delayedStats(toPoints(h, p)) : null;
      const latest = news.data?.find((n) => n.poolId === p.poolId);
      return { p, stats, locked: h?.locked.length ?? null, latest };
    });
  }, [pools, histories.data, news.data, sort]);

  return (
    <>
      <section className="page-intro">
        <div>
          <span className="mini-eyebrow">DAHA AZ GÜRÜLTÜ · DAHA FAZLA İNANÇ</span>
          <h1>Fiyatın ötesini gör.</h1>
          <p>Projeleri gelişmeleriyle keşfet. Gizli yatırım yap; sonucu 7 gün sonra gör.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => openFunds("deposit")}><Wallet size={15} /> {wallet ? "Para yatır" : "Gizli hesap oluştur"}</button>
            <Link href="/launch" className="btn-secondary"><Rocket size={15} /> Token oluştur</Link>
            <Link href="/guide" className="btn-secondary">Nasıl çalışır? <ChevronRight size={15} /></Link>
          </div>
        </div>
        <span className="privacy-badge"><Shield size={15} /> Gizlilik odaklı DEX</span>
      </section>

      <div className="stat-strip">
        <div><span>Projeler</span><strong className="num">{pools?.length ?? "—"}</strong></div>
        <div><span>Gizli not havuzu</span><strong className="num">{info?.noteCount ?? "—"}</strong></div>
        <div><span>Settle edilen dönem</span><strong className="num">{info?.settledBatches ?? "—"}</strong></div>
        <div><span>Sonuç kilidi</span><strong className="num">{info ? `${Math.round(info.lockSeconds / 86400)} gün` : "—"}</strong></div>
      </div>

      <div className="explore-grid">
        <section className="panel-box" aria-labelledby="projects-h">
          <div className="panel-title">
            <span id="projects-h"><Layers size={16} /> Projeler</span>
            <div className="segmented small" role="tablist">
              <button role="tab" aria-selected={sort === "news"} className={sort === "news" ? "active" : ""} onClick={() => setSort("news")}>Gündem</button>
              <button role="tab" aria-selected={sort === "new"} className={sort === "new" ? "active" : ""} onClick={() => setSort("new")}>Yeni</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="explore-table">
              <thead>
                <tr>
                  <th>Proje</th>
                  <th>Son gelişme</th>
                  <th className="text-right">Haber/24s</th>
                  <th className="text-right" title="7 gün önce açılan son clearing fiyatı">Gecikmeli fiyat</th>
                  <th className="text-right">7G (gecikmeli)</th>
                  <th className="text-right">Gecikmeli TVL</th>
                  <th className="text-right">Kilitli dönem</th>
                </tr>
              </thead>
              <tbody>
                {!pools && [0, 1, 2].map((i) => <tr key={i}><td colSpan={7}><div className="h-10 animate-pulse rounded bg-panel-2" /></td></tr>)}
                {rows.map(({ p, stats, locked, latest }) => (
                  <tr key={p.poolId}>
                    <td>
                      <Link href={`/token/${p.poolId}`} className="flex items-center gap-3">
                        <span className="project-avatar">{(p.base.symbol ?? "P").slice(0, 2)}</span>
                        <span className="min-w-0">
                          <strong className="block truncate">{p.project?.name ?? p.base.name}</strong>
                          <small className="text-muted">{p.base.symbol}{p.project?.category ? ` · ${p.project.category}` : ""}</small>
                        </span>
                      </Link>
                    </td>
                    <td className="max-w-72">
                      {latest ? (
                        <button type="button" className="text-left hover:text-accent" onClick={() => setOpen(latest)}>
                          <span className="line-clamp-1">{latest.title}</span>
                          <small className="text-muted">{relTime(latest.timestamp)}</small>
                        </button>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="num text-right">{p.news24h}</td>
                    <td className="num text-right">{stats?.price != null ? <>{fmtPrice(stats.price)} $</> : <span className="text-muted">Kilitli</span>}</td>
                    <td className={`num text-right ${delta(stats)}`}>{fmtPct(stats?.change[2].value)}</td>
                    <td className="num text-right">{stats?.tvl != null ? `${fmtCompact(stats.tvl)} $` : "—"}</td>
                    <td className="num text-right"><span className="inline-flex items-center gap-1"><LockKeyhole size={12} className="text-muted" />{locked ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-foot">Fiyatlar ve hacimler 7 gün gecikmelidir. Canlı fiyat bu platformda hiç gösterilmez.</p>
        </section>

        <section className="panel-box" aria-labelledby="feed-h">
          <div className="panel-title"><span id="feed-h"><Newspaper size={16} /> Son gelişmeler</span><span className="small-tag">İMZALI</span></div>
          <ul className="divide-y divide-line">
            {!news.data && <li className="p-4"><div className="h-12 animate-pulse rounded bg-panel-2" /></li>}
            {news.data?.length === 0 && <li className="p-6 text-center text-muted">Henüz haber yok.</li>}
            {news.data?.slice(0, 12).map((n) => {
              const pool = pools?.find((p) => p.poolId === n.poolId);
              return (
                <li key={n.signature}>
                  <button type="button" className="news-item block w-full px-4 py-3 text-left" onClick={() => setOpen(n)}>
                    <span className="text-xs text-accent">{pool?.project?.name ?? `#${n.poolId}`}</span>
                    <span className="mt-0.5 block font-medium">{n.title}</span>
                    <span className="text-xs text-muted">{relTime(n.timestamp)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Link href="/launch" className="launch-cta">Projeni listele <ArrowRight size={15} /></Link>
        </section>
      </div>
      <NewsModal item={open} pool={pools?.find((p: Pool) => p.poolId === open?.poolId)} onClose={() => setOpen(null)} />
    </>
  );
}

function delta(stats: ReturnType<typeof delayedStats> | null) {
  const v = stats?.change[2].value;
  return v == null ? "text-muted" : v >= 0 ? "text-buy" : "text-sell";
}
