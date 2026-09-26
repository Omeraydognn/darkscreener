"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { BadgeCheck, ExternalLink, X } from "lucide-react";
import type { NewsItem, Pool } from "@/lib/api";
import { dateFmt, shortAddr } from "@/lib/format";

const safeUrl = (u: string) => (/^https:\/\//i.test(u) ? u : undefined);

/** Haber ayrıntısı: tam metin, imza doğrulaması ve kaynağa bağlantı. */
export function NewsModal({ item, pool, onClose }: { item: NewsItem | null; pool?: Pool; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!item) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);
  if (!item) return null;
  const url = safeUrl(item.url);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <article role="dialog" aria-modal="true" aria-labelledby="news-title" className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <button ref={close} type="button" className="modal-close" onClick={onClose} aria-label="Kapat"><X size={18} /></button>
        <p className="mini-eyebrow">{pool?.project?.name ?? `Proje #${item.poolId}`} · PROJEDEN GELİŞME</p>
        <h2 id="news-title" className="mt-2 text-xl font-semibold leading-snug">{item.title}</h2>
        <time className="mt-1 block text-sm text-muted" dateTime={new Date(item.timestamp * 1000).toISOString()}>{dateFmt.format(item.timestamp * 1000)}</time>
        {item.body ? <p className="mt-4 whitespace-pre-line leading-relaxed">{item.body}</p> : <p className="mt-4 text-muted">Bu haberin ek metni yok.</p>}
        <div className="signature-box">
          <BadgeCheck size={16} className="text-buy" />
          <span>Projenin kayıtlı anahtarıyla imzalı · <span className="num">{shortAddr(item.signer)}</span></span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {url && <a className="btn-primary" href={url} target="_blank" rel="noreferrer noopener">Kaynağa git <ExternalLink size={15} /></a>}
          {pool && <Link className="btn-secondary" href={`/token/${pool.poolId}`} onClick={onClose}>Proje sayfası</Link>}
        </div>
      </article>
    </div>
  );
}
