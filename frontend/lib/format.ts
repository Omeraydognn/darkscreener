// Number, price and time formatting (Intl) in the current interface language.

import { getLang, locale, t } from "./i18n";

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${locale()}|${key}`;
  let f = cache.get(k);
  if (!f) cache.set(k, (f = new Intl.NumberFormat(locale(), opts)));
  return f;
}
const compact = () => nf("compact", { notation: "compact", maximumFractionDigits: 2 });
const plain = () => nf("plain", { maximumFractionDigits: 2 });
const pct = () => nf("pct", { style: "percent", maximumFractionDigits: 2, signDisplay: "always" });
const pctPlain = () => nf("pctPlain", { style: "percent", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const usdFmt = () => nf("usd", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Raw integer → decimal number (enough precision for charts/stats). */
export function units(raw: string | bigint, decimals: number): number {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  return Number(v / scale) + Number(v % scale) / Number(scale);
}

/** priceX18 = quote_raw / base_raw * 1e18 → human quote/base. */
export function priceFromX18(priceX18: string, baseDecimals: number, quoteDecimals: number): number {
  return units(priceX18, 18) * 10 ** (baseDecimals - quoteDecimals);
}

export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  if (p === 0) return "0";
  if (p >= 1) return p.toLocaleString(locale(), { maximumFractionDigits: 4 });
  // small prices: 4 significant digits
  return p.toLocaleString(locale(), { maximumSignificantDigits: 4 });
}

/** Dollar amount next to a plain number: "$1.23" (en) / "1,23 $" (tr). */
export const withUsd = (s: string) => (getLang() === "tr" ? `${s} $` : `$${s}`);

export const fmtCompact = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : compact().format(n));
export const fmtNum = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : plain().format(n));
export const fmtPct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : pct().format(n));
/** Fraction → unsigned percent, e.g. 0.003 → "0.30%" / "%0,30". */
export const fmtPctPlain = (n: number) => pctPlain().format(n);

export function shortAddr(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export function relTime(unix: number, now = Date.now() / 1000): string {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const d = unix - now;
  const abs = Math.abs(d);
  if (abs < 60) return rtf.format(Math.round(d), "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("time.d", { d, h });
  if (h > 0) return t("time.h", { h, m });
  return t("time.m", { m, s: s % 60 });
}

/** Short date-time in the current language (`dateFmt.format(ms)`). */
export const dateFmt = {
  format: (ms: number) => new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms),
};

/** Raw dUSD amount (6 decimals) → "$1,234.56" / "$1.234,56" */
export function fmtUsd(raw: bigint | string | number | null | undefined): string {
  if (raw == null) return "—";
  const v = typeof raw === "number" ? raw : units(typeof raw === "bigint" ? raw : BigInt(raw), 6);
  return usdFmt().format(v);
}

/** Raw token amount → "12,345.67" */
export function fmtToken(raw: bigint | string, decimals = 18): string {
  return plain().format(units(typeof raw === "bigint" ? raw : BigInt(raw), decimals));
}

/** wei → "1.2345 MON" */
export function fmtMon(raw: bigint | string, symbol = "MON"): string {
  const v = units(typeof raw === "bigint" ? raw : BigInt(raw), 18);
  return `${v.toLocaleString(locale(), { maximumFractionDigits: 4 })} ${symbol}`;
}

/** Small dollar amounts with significant digits: "$0.02668" */
export function fmtRate(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  return withUsd(usd.toLocaleString(locale(), usd >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 }));
}

/** Number → text for an amount input in the current language (no grouping). */
export function toInput(v: number, maxDecimals: number): string {
  const s = v.toFixed(maxDecimals).replace(/\.?0+$/, "");
  return getLang() === "tr" ? s.replace(".", ",") : s;
}
