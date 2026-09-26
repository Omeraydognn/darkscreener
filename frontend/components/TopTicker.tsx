"use client";

import Link from "next/link";
import { Newspaper } from "lucide-react";
import type { Pool } from "@/lib/api";

/** DexScreener'daki "trending" şeridinin karşılığı: fiyata göre DEĞİL, haber aktivitesine göre sıralı. */
export function TopTicker({ pools, active }: { pools: Pool[] | undefined; active: number }) {
  const ranked = [...(pools ?? [])].sort((a, b) => b.news24h - a.news24h || a.poolId - b.poolId);
  return (
    <div className="scroll-thin flex h-11 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2" aria-label="Haber aktivitesine göre projeler">
      <span className="flex shrink-0 items-center gap-1 px-2 text-xs font-medium uppercase tracking-wide text-muted">
        <Newspaper className="size-3.5 text-accent" aria-hidden /> Gündem
      </span>
      {ranked.map((p, i) => (
        <Link
          key={p.poolId}
          href={`/token/${p.poolId}`}
          className={`flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-sm hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            p.poolId === active ? "bg-panel-2" : ""
          }`}
        >
          <span className="text-xs text-muted">#{i + 1}</span>
          <span className="font-semibold">{p.base.symbol}</span>
          <span className="text-xs text-muted">{p.news24h} haber / 24s</span>
        </Link>
      ))}
    </div>
  );
}
