"use client";
import { BookOpen, Clock3, ExternalLink, LockKeyhole } from "lucide-react";
import type { History, Info, Pool } from "@/lib/api";
import { delayedStats, toPoints } from "@/lib/ghost";
import { fmtPrice } from "@/lib/format";
export function StatsPanel({ pool, history, info }: { pool?: Pool; history?: History; info?: Info; chainOffset: number }) {
  const stats = delayedStats(pool && history ? toPoints(history, pool) : []);
  return <section className="about-card"><div className="panel-title"><span><BookOpen size={16}/> Proje hakkında</span><span className="small-tag">{pool?.base.symbol ?? "—"}</span></div><div className="about-body"><p>{pool?.project?.description || "Projenin vizyonu ve açıklaması, proje verileri alındığında burada görünecek."}</p>{pool?.project?.twitter && <a className="text-link" href={pool.project.twitter} target="_blank" rel="noreferrer">Projenin sosyal hesabı <ExternalLink size={13}/></a>}<dl><dt>Gizlilik penceresi</dt><dd><Clock3 size={13}/> {info ? Math.round(info.lockSeconds / 86400) : 7} gün</dd><dt>İşlem ücreti</dt><dd>{info ? `%${(info.feeBps / 100).toFixed(2)}` : "—"}</dd><dt>Token miktarı</dt><dd><LockKeyhole size={12}/> İşlem anında gizli</dd><dt>Geçmiş fiyat</dt><dd>{stats.price === null ? "Henüz açılmadı" : `${fmtPrice(stats.price)} ${pool?.quote.symbol}`}</dd></dl><div className="delayed-note"><Clock3 size={13}/> Fiyat verileri 7 gün gecikmelidir.</div></div></section>;
}
