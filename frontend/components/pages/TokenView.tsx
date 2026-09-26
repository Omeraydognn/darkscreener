"use client";

import { ArrowUpRight, EyeOff, Globe, LockKeyhole, Radio, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { BottomTabs } from "../BottomTabs";
import { GhostChart } from "../GhostChart";
import { StatsPanel } from "../StatsPanel";
import { TopTicker } from "../TopTicker";
import { usePoll, useStoredString } from "../usePoll";
import { useApp } from "../app/AppProvider";
import { TradeBox } from "../app/TradeBox";

/** Token sayfası: proje başlığı, gecikmeli grafik, haberler/proje ayrıntıları ve gizli al-sat. */
export function TokenView({ poolId }: { poolId: number }) {
  const { pools, poolsError, info, refreshData } = useApp();
  const history = usePoll(() => api.history(poolId), 15_000, [poolId]);
  const news = usePoll(() => api.news(poolId), 10_000, [poolId]);
  const [themeRaw] = useStoredString("darkscreener:theme");
  const pool = pools?.find((p) => p.poolId === poolId);
  const chainOffset = info ? info.finalizedTimestamp - info.fetchedAt : 0;
  const p = pool?.project;
  const retry = () => {
    refreshData();
    history.refresh();
    news.refresh();
  };

  return (
    <>
      <TopTicker pools={pools} active={poolId} />
      {poolsError && (
        <div className="connection-notice mt-5" role="alert"><Radio size={17} /><div><strong>Veri bağlantısı bekleniyor</strong><span>Proje verileri alınamıyor. Otomatik yeniden denenecek.</span></div><button onClick={retry}><RefreshCw size={14} /> Tekrar dene</button></div>
      )}
      {pools && !pool ? (
        <div className="empty-project">Bu proje bulunamadı. Keşfet sayfasından bir proje seç.</div>
      ) : (
        <>
          <section className="project-heading mt-6">
            <div className="project-identity">
              <span className="project-avatar large">{pool?.base.symbol?.slice(0, 2) ?? <EyeOff size={26} />}</span>
              <div>
                <div className="project-title"><h1 className="text-xl font-medium">{p?.name ?? pool?.base.name ?? "Proje"}</h1><span className="symbol-tag">{pool?.base.symbol ?? "—"}</span></div>
                <p>{p?.category ? <>{p.category}<span>·</span></> : null}{pool ? `${pool.base.symbol} / USD` : "Proje verileri bekleniyor"}<span>·</span><LockKeyhole size={12} /> Gizli piyasa</p>
              </div>
            </div>
            <div className="project-links">
              {p?.website && <a href={p.website} target="_blank" rel="noreferrer noopener"><Globe size={14} /> {p.website.replace(/^https:\/\//, "")} <ArrowUpRight size={13} /></a>}
            </div>
          </section>
          <div className="terminal-grid">
            <main className="main-panels">
              <div className="privacy-strip"><span><EyeOff size={15} /> Canlı fiyat</span><strong>Gizli</strong><i /><span>İşlem hacmi</span><strong>Gizli</strong><i /><span>Yatırımcılar</span><strong>Gizli</strong><span className="privacy-strip-end"><LockKeyhole size={13} /> Tasarım gereği.</span></div>
              <GhostChart key={`chart-${poolId}-${themeRaw === "dark" ? "d" : "l"}`} pool={pool} history={history.data} error={history.error} news={news.data} newsError={news.error} />
              <BottomTabs key={`details-${poolId}`} pool={pool} history={history.data} news={news.data} newsError={news.error} info={info} />
            </main>
            <aside className="investment-column" aria-label="Gizli yatırım">
              <section id="trade-panel" className="investment-card">
                <div className="panel-title"><span><LockKeyhole size={16} /> Gizli yatırım</span><span className="small-tag">PRIVATE</span></div>
                <TradeBox pool={pool} />
              </section>
              <StatsPanel pool={pool} history={history.data} info={info} chainOffset={chainOffset} />
            </aside>
          </div>
        </>
      )}
    </>
  );
}
