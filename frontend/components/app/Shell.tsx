"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { BookOpen, ChevronRight, Compass, EyeOff, LockKeyhole, Moon, Rocket, Search, ShieldCheck, Star, Sun, Wallet, WalletCards } from "lucide-react";
import { config, configError } from "@/lib/config";
import { fmtUsd } from "@/lib/format";
import { useStoredString } from "../usePoll";
import { useApp } from "./AppProvider";
import { FundsModal } from "./FundsModal";

const NAV = [
  { href: "/", label: "Keşfet", icon: Compass },
  { href: "/portfolio", label: "Portföy", icon: WalletCards },
  { href: "/launch", label: "Token oluştur", icon: Rocket },
  { href: "/guide", label: "Nasıl çalışır?", icon: BookOpen },
];

function crumb(path: string, poolName?: string) {
  if (path.startsWith("/token/")) return ["Keşfet", poolName ?? "Proje"];
  if (path.startsWith("/portfolio")) return ["Hesabım", "Portföy"];
  if (path.startsWith("/launch")) return ["Projeler", "Token oluştur"];
  if (path.startsWith("/guide")) return ["Rehber", "Nasıl çalışır?"];
  return ["darkscreener", "Keşfet"];
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "/";
  const { pools, info, infoError, wallet, cash, pendingCash, openFunds } = useApp();
  const [themeRaw, setTheme] = useStoredString("darkscreener:theme");
  const dark = themeRaw === "dark";
  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  const activePool = path.startsWith("/token/") ? Number(path.split("/")[2]) : undefined;
  const poolName = pools?.find((p) => p.poolId === activePool)?.project?.name;
  const [a, b] = crumb(path, poolName);

  return (
    <div className="terminal-shell">
      <Sidebar activePool={activePool} path={path} />
      <div className="workspace">
        <header className="workspace-header">
          <div className="breadcrumb"><span>{a}</span><ChevronRight size={14} /><strong>{b}</strong></div>
          <div className="header-actions">
            <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={dark ? "Açık temaya geç" : "Koyu temaya geç"} title={dark ? "Açık tema" : "Koyu tema"}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <span className="network-label"><span className={`status-dot ${infoError ? "offline" : ""}`} />{config.chainName}</span>
            {wallet ? (
              <div className="cash-pill">
                <Link href="/portfolio" className="cash-amount" title="Yatırımda olmayan, harcanabilir gizli bakiyen">
                  <strong className="num">{fmtUsd(cash)}</strong>
                  <span>{pendingCash > 0n ? `+${fmtUsd(pendingCash)} onaylanıyor` : "nakit"}</span>
                </Link>
                <button type="button" onClick={() => openFunds("deposit")} disabled={!info?.gateway}>
                  <Wallet size={15} /> Yatır
                </button>
              </div>
            ) : (
              <button type="button" className="wallet-link" onClick={() => openFunds("deposit")}>
                <Wallet size={15} /> {wallet === undefined ? "Hesap yükleniyor" : "Hesap oluştur"}
              </button>
            )}
          </div>
        </header>
        {configError && (
          <div className="connection-notice mx-7 mt-5" role="alert">
            <div><strong>Site yapılandırması hatalı</strong><span>{configError}. Barındırma ortam değişkenlerini düzeltip yeniden yayınlayın.</span></div>
          </div>
        )}
        <div className="workspace-content">{children}</div>
        <footer className="terminal-footer">
          <span><span className={`status-dot ${infoError ? "offline" : ""}`} />{infoError ? "Bağlantı bekleniyor" : info ? "Veri bağlantısı aktif" : "Bağlanıyor"}</span>
          <span><LockKeyhole size={12} /> Canlı işlemler gizli · Fiyat geçmişi 7 gün gecikmeli</span>
          <span>darkscreener © 2026</span>
        </footer>
      </div>
      <FundsModal />
    </div>
  );
}

function Sidebar({ activePool, path }: { activePool?: number; path: string }) {
  const { pools } = useApp();
  const [q, setQ] = useState("");
  const [saved, setSaved] = useState(false);
  const [watchRaw, setWatchRaw] = useStoredString("darkscreener:watch");
  const watch = useMemo<number[]>(() => {
    try {
      const v = JSON.parse(watchRaw ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
    } catch {
      return [];
    }
  }, [watchRaw]);
  const toggle = (id: number) => setWatchRaw(JSON.stringify(watch.includes(id) ? watch.filter((x) => x !== id) : [...watch, id]));
  const list = (pools ?? []).filter(
    (p) => (!saved || watch.includes(p.poolId)) && `${p.project?.name} ${p.base.symbol}`.toLocaleLowerCase("tr").includes(q.toLocaleLowerCase("tr")),
  );
  const isActive = (href: string) => (href === "/" ? path === "/" || path.startsWith("/token/") : path.startsWith(href));

  return (
    <aside className="project-sidebar">
      <Link href="/" className="brand"><span className="brand-mark"><EyeOff size={23} /></span><span>darkscreener<span className="brand-period">.</span></span></Link>
      <div className="sidebar-caption">PRIVATE MARKETS. REAL CONVICTION.</div>
      <nav className="primary-nav" aria-label="Ana gezinme">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={isActive(href) ? "selected" : ""} aria-current={isActive(href) ? "page" : undefined}>
            <Icon size={18} /> {label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-list-heading">
        <span>{saved ? "İZLEDİĞİN PROJELER" : "PROJE DİZİNİ"}</span>
        <button type="button" onClick={() => setSaved((s) => !s)} aria-pressed={saved} className="watch-filter" title="Yalnızca izlediklerim">
          <Star size={13} className={saved ? "starred" : ""} /> {watch.length}
        </button>
      </div>
      <label className="project-search"><Search size={15} /><span className="sr-only">Proje ara</span><input type="search" placeholder="İsim veya sembol ara" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="project-list scroll-thin">
        {!pools && <p className="sidebar-empty">Proje listesi bekleniyor…</p>}
        {pools && !list.length && <p className="sidebar-empty">{saved ? "İzlediğin proje yok. Projelerin yanındaki yıldıza dokun." : "Aramana uygun proje bulunamadı."}</p>}
        {list.map((p) => (
          <div className={`project-row ${activePool === p.poolId ? "active" : ""}`} key={p.poolId}>
            <Link href={`/token/${p.poolId}`} aria-current={activePool === p.poolId ? "page" : undefined}>
              <span className="project-avatar">{(p.base.symbol ?? "P").slice(0, 2)}</span>
              <span className="project-label"><strong>{p.project?.name ?? p.base.name}</strong><small>{p.base.symbol} <span>· {p.news24h} gelişme</span></small></span>
            </Link>
            <button aria-label={watch.includes(p.poolId) ? "İzlemeyi bırak" : "Projeyi izle"} aria-pressed={watch.includes(p.poolId)} onClick={() => toggle(p.poolId)}>
              <Star size={14} className={watch.includes(p.poolId) ? "starred" : ""} />
            </button>
          </div>
        ))}
      </div>
      <div className="sidebar-bottom"><ShieldCheck size={15} /><span>Gizlilik, tasarımın bir parçası.</span><span className="version">v0.2</span></div>
    </aside>
  );
}
