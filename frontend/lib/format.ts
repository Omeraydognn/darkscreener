// Sayı, fiyat ve zaman biçimlendirme (Intl, Türkçe).

const compact = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 2, signDisplay: "always" });

/** Ham tamsayıyı ondalıklı sayıya çevirir (grafik/istatistik için yeterli hassasiyet). */
export function units(raw: string | bigint, decimals: number): number {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  return Number(v / scale) + Number(v % scale) / Number(scale);
}

/** priceX18 = quote_raw / base_raw * 1e18 → insan birimiyle quote/base. */
export function priceFromX18(priceX18: string, baseDecimals: number, quoteDecimals: number): number {
  return units(priceX18, 18) * 10 ** (baseDecimals - quoteDecimals);
}

export function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  if (p === 0) return "0";
  if (p >= 1) return p.toLocaleString("tr-TR", { maximumFractionDigits: 4 });
  // küçük fiyatlar: anlamlı 4 basamak
  return p.toLocaleString("tr-TR", { maximumSignificantDigits: 4 });
}

export const fmtCompact = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : compact.format(n));
export const fmtNum = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : plain.format(n));
export const fmtPct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : pct.format(n));

export function shortAddr(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

const rtf = new Intl.RelativeTimeFormat("tr-TR", { numeric: "auto" });
export function relTime(unix: number, now = Date.now() / 1000): string {
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
  if (d > 0) return `${d}g ${h}s`;
  if (h > 0) return `${h}s ${m}dk`;
  return `${m}dk ${s % 60}sn`;
}

export const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
