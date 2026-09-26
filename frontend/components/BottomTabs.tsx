"use client";

import { useState } from "react";
import { BadgeCheck, CircleAlert, ExternalLink, Layers, Newspaper, ShieldCheck, Info as InfoIcon } from "lucide-react";
import type { History, Info, NewsItem, Pool } from "@/lib/api";
import { config } from "@/lib/config";
import { toPoints } from "@/lib/ghost";
import { dateFmt, fmtCompact, fmtNum, fmtPrice, relTime, shortAddr, units } from "@/lib/format";

type Tab = "news" | "batches" | "project" | "security";

export function BottomTabs({
  pool,
  history,
  news,
  newsError,
  info,
}: {
  pool: Pool | undefined;
  history: History | undefined;
  news: NewsItem[] | undefined;
  newsError?: Error;
  info: Info | undefined;
}) {
  const [tab, setTab] = useState<Tab>("news");
  const tabs: [Tab, string, React.ComponentType<{ className?: string }>][] = [
    ["news", `Haberler${news ? ` (${news.length})` : ""}`, Newspaper],
    ["batches", "Açılan dönemler", Layers],
    ["project", "Proje", InfoIcon],
    ["security", "Güvenlik", ShieldCheck],
  ];
  return (
    <section className="news-section flex flex-col bg-panel" aria-label="Proje ayrıntıları">
      <div role="tablist" className="scroll-thin flex shrink-0 overflow-x-auto border-b border-line px-2">
        {tabs.map(([k, label, Icon]) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.findIndex(([key]) => key === k);
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next][0]);
              (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
            }}
            onClick={() => setTab(k)}
            className={`flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto" role="tabpanel">
        {tab === "news" && <NewsFeed news={news} error={newsError} pool={pool} />}
        {tab === "batches" && <BatchTable pool={pool} history={history} />}
        {tab === "project" && <ProjectTab pool={pool} />}
        {tab === "security" && <SecurityTab info={info} />}
      </div>
    </section>
  );
}

function NewsFeed({ news, error, pool }: { news: NewsItem[] | undefined; error?: Error; pool: Pool | undefined }) {
  if (error) return <div className="news-empty"><Newspaper size={24}/><strong>Gelişmeler için bağlantı bekleniyor</strong><p>Projenin yayınladığı haberler burada yer alır. Veri bağlantısı otomatik yeniden denenecek.</p></div>;
  if (!news)
    return (
      <div className="space-y-2 p-4" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded bg-panel-2" />
        ))}
      </div>
    );
  if (!news.length)
    return (
      <p className="p-6 text-center text-sm text-muted">
        {pool?.project?.name ?? "Bu proje"} henüz haber yayınlamadı. Haberler yalnızca projenin kayıtlı anahtarıyla imzalanabilir.
      </p>
    );
  return (
    <><div className="news-summary"><span><span className="status-dot"/> PROJEDEN GELİŞMELER</span><span>Proje anahtarıyla imzalı yayınlar</span></div><ul className="divide-y divide-line">
      {news.map((n) => (
        <li key={n.signature} className="fade-in grid grid-cols-[4rem_1fr] gap-4 px-5 py-5">
          <time dateTime={new Date(n.timestamp * 1000).toISOString()} className="num text-xs text-muted" title={dateFmt.format(n.timestamp * 1000)}>
            {relTime(n.timestamp)}
          </time>
          <div>
            <p className="font-medium">{n.title}</p>
            {n.body && <p className="mt-0.5 leading-relaxed text-muted">{n.body}</p>}
            <p className="mt-1 flex items-center gap-1 text-xs text-muted">
              <BadgeCheck className="size-3.5 text-buy" aria-hidden />
              Proje anahtarıyla imzalı · <span className="num">{shortAddr(n.signer)}</span>
              {n.url && (
                <a href={n.url} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-0.5 text-accent hover:underline">
                  Kaynak <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul></>
  );
}

function BatchTable({ pool, history }: { pool: Pool | undefined; history: History | undefined }) {
  if (!pool || !history) return <div className="m-4 h-24 animate-pulse rounded bg-panel-2" aria-hidden />;
  const pts = toPoints(history, pool).reverse();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{"Kilidi açılmış batch'ler"}</caption>
      <thead className="sticky top-0 bg-panel text-xs uppercase tracking-wide text-muted">
        <tr className="border-b border-line">
          <th className="px-4 py-2 text-left font-medium">Tarih</th>
          <th className="px-4 py-2 text-left font-medium">Batch</th>
          <th className="px-4 py-2 text-right font-medium">Clearing fiyatı</th>
          <th className="px-4 py-2 text-right font-medium">Alım / Satım</th>
          <th className="px-4 py-2 text-right font-medium">Hacim ({pool.quote.symbol})</th>
          <th className="px-4 py-2 text-right font-medium">TVL</th>
        </tr>
      </thead>
      <tbody className="num">
        {history.locked.length > 0 && (
          <tr className="locked-hatch border-b border-line text-muted">
            <td colSpan={6} className="px-4 py-2 text-center text-xs">
              {history.locked.length} batch kilitli — fiyat ve hacim 7 gün sonra drand ile açılacak
            </td>
          </tr>
        )}
        {pts.map((p) => (
          <tr key={p.batchId} className="border-b border-line/60 hover:bg-panel-2">
            <td className="px-4 py-1.5 text-muted">{dateFmt.format(p.time * 1000)}</td>
            <td className="px-4 py-1.5 text-muted">#{p.batchId}</td>
            <td className="px-4 py-1.5 text-right">{fmtPrice(p.price)}</td>
            <td className="px-4 py-1.5 text-right">
              <span className="text-buy">{p.buys}</span> / <span className="text-sell">{p.sells}</span>
            </td>
            <td className="px-4 py-1.5 text-right">{fmtCompact(p.buyVol + p.sellVol)}</td>
            <td className="px-4 py-1.5 text-right">{fmtCompact(p.tvl)}</td>
          </tr>
        ))}
        {pts.length === 0 && (
          <tr>
            <td colSpan={6} className="px-4 py-6 text-center text-muted">Henüz kilidi açılmış batch yok.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ProjectTab({ pool }: { pool: Pool | undefined }) {
  if (!pool) return null;
  const p = pool.project;
  return (
    <div className="grid gap-6 p-4 md:grid-cols-2">
      <div>
        <h2 className="text-base font-semibold">{p?.name ?? pool.base.name}</h2>
        <p className="mt-1 leading-relaxed text-muted">{p?.description || "Proje açıklaması eklenmemiş."}</p>
      </div>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-xs">
        <dt className="text-muted">Token</dt>
        <dd className="num">{pool.base.symbol} · {shortAddr(pool.base.address)}</dd>
        <dt className="text-muted">Quote</dt>
        <dd className="num">{pool.quote.symbol} · {shortAddr(pool.quote.address)}</dd>
        <dt className="text-muted">İlk likidite</dt>
        <dd className="num">
          {fmtNum(units(pool.initialLiquidity.base, pool.base.decimals ?? 18))} {pool.base.symbol} +{" "}
          {fmtNum(units(pool.initialLiquidity.quote, pool.quote.decimals ?? 6))} {pool.quote.symbol}
        </dd>
        <dt className="text-muted">Havuz açılışı</dt>
        <dd className="num">{dateFmt.format(pool.createdAt * 1000)}</dd>
        <dt className="text-muted">Haber imzacıları</dt>
        <dd className="num">{p?.newsSigners.map(shortAddr).join(", ") || "—"}</dd>
      </dl>
    </div>
  );
}

function SecurityTab({ info }: { info: Info | undefined }) {
  if (!info) return <div className="m-4 h-24 animate-pulse rounded bg-panel-2" aria-hidden />;
  const lockDays = Math.round(info.lockSeconds / 86400);
  return (
    <div className="grid gap-6 p-4 md:grid-cols-2">
      <ul className="space-y-2 text-sm">
        <li className="flex items-start gap-2">
          {info.enclave.registered ? <BadgeCheck className="mt-0.5 size-4 text-buy" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 text-sell" aria-hidden />}
          <span>
            {`Enclave anahtarı zincirdeki registry'de ${info.enclave.registered ? "kayıtlı" : "KAYITLI DEĞİL"}. Emirler yalnızca bu anahtara şifrelenir.`}
          </span>
        </li>
        {info.enclave.hardwareBacked ? (
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 text-buy" aria-hidden />
            {`Enclave donanım TEE'sinde çalışıyor (${info.enclave.provider}). Anahtar yalnızca doğrulanabilir kod imajına bağlıdır.`}
          </li>
        ) : (
          <li className="flex items-start gap-2 text-warn">
            <CircleAlert className="mt-0.5 size-4" aria-hidden />
            {`Enclave şu an donanım TEE'si olmadan çalışıyor (${info.enclave.provider ?? "local"}). Kriptografi ve ZK gerçek; ancak sunucu operatörü teorik olarak emirleri görebilir. Oyster CVM'e taşınınca bu uyarı kalkar.`}
          </li>
        )}
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 text-buy" aria-hidden />
          Sonuçlar {lockDays} gün boyunca drand zaman kilidindedir; enclave dahil kimse erken açamaz.
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 text-buy" aria-hidden />
          Kaçış kapağı: settlement 2 gün durursa fonlar enclave olmadan geri alınır.
        </li>
      </ul>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-xs">
        <dt className="text-muted">Ağ</dt>
        <dd>{config.chainName} (#{info.chainId})</dd>
        <dt className="text-muted">Vault</dt>
        <dd className="num break-all">{info.vault}</dd>
        <dt className="text-muted">Enclave</dt>
        <dd className="num break-all">{info.enclave.address}</dd>
        <dt className="text-muted">Relayer</dt>
        <dd className="num break-all">{info.relayer}</dd>
        <dt className="text-muted">Batch penceresi</dt>
        <dd className="num">{info.windowSeconds} sn</dd>
        <dt className="text-muted">Settle edilen batch</dt>
        <dd className="num">{info.settledBatches}</dd>
      </dl>
    </div>
  );
}
