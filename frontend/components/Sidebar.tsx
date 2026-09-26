"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Compass, EyeOff, LockKeyhole, Search, ShieldCheck, Star } from "lucide-react";
import type { Pool } from "@/lib/api";

export function Sidebar({ pools, active, watch, onToggleWatch }: { pools: Pool[] | undefined; active: number; watch: number[]; onToggleWatch: (id: number) => void }) {
  const [q, setQ] = useState("");
  const [saved, setSaved] = useState(false);
  const list = (pools ?? []).filter(p => (!saved || watch.includes(p.poolId)) && `${p.project?.name} ${p.base.symbol}`.toLocaleLowerCase("tr").includes(q.toLocaleLowerCase("tr")));
  return <aside className="project-sidebar">
    <Link href="/" className="brand"><span className="brand-mark"><EyeOff size={23}/></span><span>darkscreener<span className="brand-period">.</span></span></Link>
    <div className="sidebar-caption">PRIVATE MARKETS. REAL CONVICTION.</div>
    <nav className="primary-nav" aria-label="Ana gezinme">
      <button className={!saved ? "selected" : ""} onClick={() => setSaved(false)}><Compass size={18}/> Projeleri keşfet <span className="nav-count">{pools?.length ?? "—"}</span></button>
      <button className={saved ? "selected" : ""} onClick={() => setSaved(true)}><Star size={18}/> İzleme listem <span className="nav-count">{watch.length}</span></button>
    </nav>
    <div className="sidebar-list-heading"><span>{saved ? "İZLEDİĞİN PROJELER" : "PROJE DİZİNİ"}</span><span>↗</span></div>
    <label className="project-search"><Search size={15}/><span className="sr-only">Proje ara</span><input type="search" placeholder="İsim veya sembol ara" value={q} onChange={e => setQ(e.target.value)}/></label>
    <div className="project-list scroll-thin">
      {!pools && <p className="sidebar-empty">Proje listesi bekleniyor…</p>}
      {pools && !list.length && <p className="sidebar-empty">{saved ? "İzlediğin proje yok. Projelerin yanındaki yıldıza dokun." : "Aramana uygun proje bulunamadı."}</p>}
      {list.map(p => <div className={`project-row ${active === p.poolId ? "active" : ""}`} key={p.poolId}>
        <Link href={`/p/${p.poolId}`} aria-current={active === p.poolId ? "page" : undefined}><span className="project-avatar">{(p.base.symbol ?? "P").slice(0,2)}</span><span className="project-label"><strong>{p.project?.name ?? p.base.name}</strong><small>{p.base.symbol} <span>· {p.news24h} gelişme</span></small></span></Link>
        <button aria-label={watch.includes(p.poolId) ? "İzlemeyi bırak" : "Projeyi izle"} aria-pressed={watch.includes(p.poolId)} onClick={() => onToggleWatch(p.poolId)}><Star size={14} className={watch.includes(p.poolId) ? "starred" : ""}/></button>
      </div>)}
    </div>
    <div className="sidebar-manifesto"><span className="mini-eyebrow"><LockKeyhole size={13}/> FİYAT GİZLİ. VİZYON AÇIK.</span><h3>Gürültüyü kapat.<br/>Projeye odaklan.</h3><p>Kararını fiyat hareketleriyle değil, projenin ürettikleriyle ver.</p><a href="#privacy-guide">Nasıl çalışır? <ArrowUpRight size={15}/></a></div>
    <div className="sidebar-bottom"><ShieldCheck size={15}/><span>Gizlilik, tasarımın bir parçası.</span><span className="version">v0.1</span></div>
  </aside>;
}
