"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type UTCTimestamp } from "lightweight-charts";
import { ArrowUpRight, Clock3, LockKeyhole, Newspaper, X } from "lucide-react";
import type { History, NewsItem, Pool } from "@/lib/api";
import { candles, toPoints, twapSeries } from "@/lib/ghost";
import { dateFmt, fmtPrice } from "@/lib/format";
import { useNow } from "./usePoll";

const DAY = 86400;
const FRAMES = [{ label: "1S", sec: 3600 }, { label: "4S", sec: 14400 }, { label: "12S", sec: 43200 }, { label: "1G", sec: DAY }];
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const safeUrl = (url: string) => /^https?:\/\//i.test(url) ? url : undefined;

function dayStart(time: number) {
  const date = new Date(time * 1000);
  date.setHours(0, 0, 0, 0);
  return date.getTime() / 1000;
}

/** Gray candles are decorative placeholders, never numeric price series. */
export function GhostChart({ pool, history, error, news, newsError }: {
  pool?: Pool; history?: History; error?: Error; news?: NewsItem[]; newsError?: Error;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<{ candles: { x: number; time: number }[]; markers: { x: number; day: number; count: number }[]; y: number; width: number; boundary: number } | null>(null);
  const [frame, setFrame] = useState(43200);
  const [showTwap, setShowTwap] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const now = useNow();
  const currentBucket = Math.floor(now / frame) * frame;
  const items = useMemo(() => (news ?? []).filter(n => n.poolId === pool?.poolId && n.timestamp >= currentBucket - 7 * DAY && n.timestamp <= currentBucket + frame).sort((a,b) => b.timestamp - a.timestamp), [news, pool?.poolId, currentBucket, frame]);
  const dayNews = (day: number) => items.filter(n => dayStart(n.timestamp) === day);
  const data = useMemo(() => {
    if (!pool || !history) return null;
    const pts = toPoints(history, pool);
    return { pts, cs: candles(pts, frame) };
  }, [pool, history, frame]);

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: css("--panel") }, textColor: css("--muted"), fontSize: 10 },
      grid: { vertLines: { color: css("--line-soft") }, horzLines: { color: css("--line-soft") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderColor: css("--line"), timeVisible: true },
      localization: { locale: "tr-TR", priceFormatter: fmtPrice },
    });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: box.current.clientWidth < 600 ? .42 : .32, bottom: .19 } });
    const c = chart.addSeries(CandlestickSeries, { upColor: css("--buy"), downColor: css("--sell"), borderVisible: false, wickUpColor: css("--buy"), wickDownColor: css("--sell") });
    const v = chart.addSeries(HistogramSeries, { priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
    v.priceScale().applyOptions({ scaleMargins: { top: .86, bottom: 0 } });
    const t = chart.addSeries(LineSeries, { color: css("--accent"), lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    let pending = 0;
    const lastCandle = data?.cs.at(-1);
    const lockedTimes: number[] = [];
    if (lastCandle && currentBucket) {
      // Whitespace expands the SAME time axis without adding fabricated prices.
      for (let time = lastCandle.time + frame; time <= currentBucket && lockedTimes.length < 10000; time += frame) lockedTimes.push(time);
    }
    const markerGroups = new Map<number, { time: number; count: number }>();
    for (const item of items) {
      const day = dayStart(item.timestamp);
      const previous = markerGroups.get(day);
      markerGroups.set(day, { time: Math.floor(item.timestamp / frame) * frame, count: (previous?.count ?? 0) + 1 });
    }
    if (data) {
      c.setData([...data.cs.map(k => ({ ...k, time: k.time as UTCTimestamp })), ...lockedTimes.map(time => ({ time: time as UTCTimestamp }))]);
      v.setData(data.cs.map(k => ({ time: k.time as UTCTimestamp, value: k.volume, color: `${css(k.close >= k.open ? "--buy" : "--sell")}40` })));
      t.setData(showTwap ? twapSeries(data.pts, data.cs, 30 * DAY).map(p => ({ ...p, time: p.time as UTCTimestamp })) : []);
      if (data.cs.length) chart.timeScale().setVisibleLogicalRange({ from: box.current.clientWidth < 600 ? Math.max(-1, data.cs.length - Math.max(8, Math.ceil(lockedTimes.length * .7))) : -1, to: data.cs.length + lockedTimes.length });
      else chart.timeScale().fitContent();
    }
    const place = () => {
      if (!lastCandle || !lockedTimes.length) { setOverlay(null); return; }
      const scale = chart.timeScale();
      const y = c.priceToCoordinate(lastCandle.close);
      const first = scale.timeToCoordinate(lockedTimes[0] as UTCTimestamp);
      const second = scale.timeToCoordinate((lockedTimes[1] ?? lockedTimes[0]) as UTCTimestamp);
      const width = Math.max(2, Math.min(16, Math.abs((second ?? 0) - (first ?? 0)) * .65));
      const candles = lockedTimes.flatMap(time => {
        const x = scale.timeToCoordinate(time as UTCTimestamp);
        return x !== null && x >= 0 && x < scale.width() ? [{ x, time }] : [];
      });
      const markers = [...markerGroups].flatMap(([day, group]) => {
        const x = scale.timeToCoordinate(group.time as UTCTimestamp);
        return x !== null && x >= 18 && x < scale.width() - 18 ? [{ x, day, count: group.count }] : [];
      });
      if (y !== null) setOverlay({ candles, markers, y, width, boundary: Math.max(0, (first ?? 0) - width / 1.3) });
    };
    const schedule = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(place); };
    schedule();
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeSizeChange(schedule);
    const element = box.current;
    element.addEventListener("pointermove", schedule);
    element.addEventListener("wheel", schedule);
    return () => {
      cancelAnimationFrame(pending);
      element.removeEventListener("pointermove", schedule);
      element.removeEventListener("wheel", schedule);
      chart.remove();
    };
  }, [data, showTwap, currentBucket, frame, items]);

  const last = data?.pts.at(-1);
  const selected = selectedDay === null ? [] : dayNews(selectedDay);
  return <section className="chart-section" aria-label="Gecikmeli fiyat ve haber zaman çizelgesi">
    <div className="chart-heading"><div><span className="mini-eyebrow">MARKET / INTELLIGENCE</span><h3>Piyasanın geçmişi. Projenin bugünü.</h3></div><div className="flex items-center gap-2"><span className="chart-delay"><Clock3 size={13}/> 7 GÜN GECİKMELİ</span></div></div>
    <div className="chart-toolbar"><div role="group" aria-label="Zaman aralığı">{FRAMES.map(f => <button key={f.sec} aria-pressed={frame === f.sec} onClick={() => setFrame(f.sec)}>{f.label}</button>)}<button aria-pressed={showTwap} onClick={() => setShowTwap(!showTwap)}>TWAP</button></div><span>{last ? `${fmtPrice(last.price)} ${pool?.quote.symbol} · geçmiş fiyat` : "Geçmiş fiyat bekleniyor"}</span></div>
    <div className="unified-chart">
      <div ref={box} className="unified-canvas"/>
      <span className="chart-zone-label">AÇILMIŞ FİYAT GEÇMİŞİ</span>
      {overlay && <div className="ghost-layer">
        <div className="ghost-boundary" style={{ left: overlay.boundary }}><span><LockKeyhole size={11}/> GİZLİ DÖNEM</span></div>
        <svg className="ghost-candle-svg" aria-label="Gri mumlar sabit temsili işaretlerdir, fiyat verisi değildir.">
          {overlay.candles.map(candle => <g key={candle.time} className="ghost-candle"><line x1={candle.x} x2={candle.x} y1={overlay.y - 20} y2={overlay.y + 20}/><rect x={candle.x - overlay.width / 2} y={overlay.y - 9} width={overlay.width} height={18} rx={1}/></g>)}
        </svg>
        {overlay.markers.map(marker => <button key={marker.day} className={`timeline-news-marker ${selectedDay === marker.day ? "active" : ""}`} style={{ left: marker.x, top: Math.max(46, overlay.y - 76) }} onClick={() => setSelectedDay(selectedDay === marker.day ? null : marker.day)} aria-expanded={selectedDay === marker.day} aria-label={`${dateFmt.format(marker.day * 1000)}: ${marker.count} proje haberi`}><Newspaper size={15}/><span>{marker.count}</span></button>)}
      </div>}
      {(!data?.cs.length || error) && <div className="history-empty"><Clock3 size={24}/><strong>{error ? "Geçmiş verisi alınamadı" : history ? "Henüz açılan fiyat yok" : "Geçmiş yükleniyor"}</strong><p>{error ? "Bağlantı otomatik yeniden denenecek." : "Kilidi açılan fiyatlar burada görünür."}</p></div>}
    </div>
    <div className="timeline-source"><span><LockKeyhole size={12}/> Gri mumlar temsili; fiyat ve hacim içermez.</span><span>{newsError ? "Haber kaynağına ulaşılamıyor" : `${items.length} proje yayını · son 7 gün`}</span></div>
    {selectedDay !== null && <div className="chart-news-detail" role="region" aria-label="Seçilen günün haberleri" onKeyDown={e => { if(e.key === "Escape") setSelectedDay(null); }}><div className="chart-news-title"><span><Newspaper size={15}/> {new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long" }).format(selectedDay * 1000)} · Proje yayınları</span><button aria-label="Haber ayrıntısını kapat" onClick={() => setSelectedDay(null)}><X size={16}/></button></div>{selected.map(n => <article key={n.signature}><time>{dateFmt.format(n.timestamp * 1000)}</time><h4>{n.title}</h4><p>{n.body}</p><span className="news-source">Proje anahtarıyla imzalı {safeUrl(n.url) && <a href={safeUrl(n.url)} target="_blank" rel="noreferrer">Kaynağı aç <ArrowUpRight size={12}/></a>}</span></article>)}{!selected.length && <p>Bu dönemde yayın bulunmuyor.</p>}</div>}
    <div className="chart-footnote"><span><span className="color-key"/> Açılmış fiyat</span><span><span className="gray-key"/> Gizli dönem</span><span><Newspaper size={12}/> Haber için simgeye dokun</span></div>
  </section>;
}
