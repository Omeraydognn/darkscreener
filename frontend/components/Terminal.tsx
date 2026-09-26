"use client";
import { useMemo } from "react";
import { ArrowUpRight, ChevronRight, EyeOff, Globe, LockKeyhole, Radio, RefreshCw, Shield, Star, Wallet } from "lucide-react";
import { api } from "@/lib/api";
import { config } from "@/lib/config";
import { BottomTabs } from "./BottomTabs";
import { GhostChart } from "./GhostChart";
import { Sidebar } from "./Sidebar";
import { StatsPanel } from "./StatsPanel";
import { TopTicker } from "./TopTicker";
import { TradePanel } from "./TradePanel";
import { usePoll, useStoredString } from "./usePoll";

export function Terminal({ poolId }: { poolId: number }) {
  const pools = usePoll(api.pools, 15_000);
  const info = usePoll(async () => ({ ...(await api.info()), fetchedAt: Date.now() / 1000 }), 5_000);
  const history = usePoll(() => api.history(poolId), 15_000, [poolId]);
  const news = usePoll(() => api.news(poolId), 10_000, [poolId]);
  const pool = pools.data?.find(p => p.poolId === poolId);
  const [watchRaw, setWatchRaw] = useStoredString("darkscreener:watch");
  const watch = useMemo<number[]>(() => { try { const value = JSON.parse(watchRaw ?? "[]"); return Array.isArray(value) ? value.filter(x => typeof x === "number") : []; } catch { return []; } }, [watchRaw]);
  const toggleWatch = (id: number) => setWatchRaw(JSON.stringify(watch.includes(id) ? watch.filter(x => x !== id) : [...watch, id]));
  const chainOffset = info.data ? info.data.finalizedTimestamp - info.data.fetchedAt : 0;
  const retry = () => { pools.refresh(); info.refresh(); history.refresh(); news.refresh(); };
  return <div className="terminal-shell">
    <Sidebar pools={pools.data} active={poolId} watch={watch} onToggleWatch={toggleWatch}/>
    <div className="workspace">
      <header className="workspace-header"><div className="breadcrumb"><span>Keşfet</span><ChevronRight size={14}/><strong>Proje terminali</strong></div><div className="header-actions"><span className="network-label"><span className="status-dot"/>{config.chainName}</span><a className="wallet-link" href="#trade-panel"><Wallet size={15}/> Gizli hesabım</a></div></header>
      <TopTicker pools={pools.data} active={poolId}/>
      <div className="workspace-content">
        <div className="page-intro"><div><span className="mini-eyebrow">THE PRIVATE MARKET</span><h1>Sinyali takip et.</h1><p>Fiyatlar bekler. Fikirler ve gelişmeler beklemez.</p></div><span className="privacy-badge"><Shield size={15}/> Gizlilik odaklı DEX</span></div>
        {pools.error && <div className="connection-notice" role="alert"><Radio size={17}/><div><strong>Veri bağlantısı bekleniyor</strong><span>Proje ve piyasa verileri şu anda alınamıyor. Otomatik yeniden denenecek.</span></div><button onClick={retry}><RefreshCw size={14}/> Tekrar dene</button></div>}
        {pools.data && !pool ? <div className="empty-project">Bu havuz bulunamadı. Proje dizininden bir proje seç.</div> : <>
          <section className="project-heading"><div className="project-identity"><span className="project-avatar large">{pool?.base.symbol?.slice(0,2) ?? <EyeOff size={26}/>}</span><div><div className="project-title"><h2>{pool?.project?.name ?? pool?.base.name ?? "Proje terminali"}</h2><span className="symbol-tag">{pool?.base.symbol ?? "—"}</span></div><p>{pool ? `${pool.base.symbol} / ${pool.quote.symbol}` : "Proje verileri bekleniyor"}<span>·</span><LockKeyhole size={12}/> Gizli piyasa</p></div></div><div className="project-links">{pool?.project?.website && <a href={pool.project.website} target="_blank" rel="noreferrer"><Globe size={14}/> Web sitesi <ArrowUpRight size={13}/></a>}<button disabled={!pool} aria-pressed={watch.includes(poolId)} onClick={() => toggleWatch(poolId)}><Star size={15} className={watch.includes(poolId) ? "starred" : ""}/>{watch.includes(poolId) ? "İzleniyor" : "İzle"}</button></div></section>
          <div className="terminal-grid"><main className="main-panels"><div className="privacy-strip"><span><EyeOff size={15}/> Canlı fiyat</span><strong>Gizli</strong><i/><span>İşlem hacmi</span><strong>Gizli</strong><i/><span>Yatırımcılar</span><strong>Gizli</strong><span className="privacy-strip-end"><LockKeyhole size={13}/> Tasarım gereği.</span></div><GhostChart key={`chart-${poolId}`} pool={pool} history={history.data} error={history.error} news={news.data} newsError={news.error}/><BottomTabs key={`details-${poolId}`} pool={pool} history={history.data} news={news.data} newsError={news.error} info={info.data}/></main><aside className="investment-column" aria-label="Yatırım ve proje bilgileri"><section id="trade-panel" className="investment-card"><div className="panel-title"><span><LockKeyhole size={16}/> Gizli yatırım</span><span className="small-tag">PRIVATE</span></div><TradePanel pool={pool} info={info.data}/></section><StatsPanel pool={pool} history={history.data} info={info.data} chainOffset={chainOffset}/><section className="privacy-guide" id="privacy-guide"><span className="mini-eyebrow">BİLEREK GİZLİ</span><h3>İnancına yatırım yap.</h3><ol><li><span>01</span><div><strong>Projeyi araştır</strong><p>Haberleri, vizyonu ve gelişmeleri incele.</p></div></li><li><span>02</span><div><strong>Gizli emrini ver</strong><p>Fiyat ve alacağın token miktarı işlem anında gösterilmez.</p></div></li><li><span>03</span><div><strong>7 gün sonra sonuçlarını gör</strong><p>Kilit açıldığında sonucu incele; satım gelirini hesabından çek.</p></div></li></ol></section></aside></div>
        </>}
      </div><footer className="terminal-footer"><span><span className={`status-dot ${info.error ? "offline" : ""}`}/>{info.error ? "Bağlantı bekleniyor" : info.data ? "Veri bağlantısı aktif" : "Bağlanıyor"}</span><span><LockKeyhole size={12}/> Canlı işlemler gizli · Fiyat geçmişi 7 gün gecikmeli</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Grafik altyapısı: TradingView Lightweight Charts™</a></footer>
    </div>
  </div>;
}
