"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Loader2, Rocket } from "lucide-react";
import { config } from "@/lib/config";
import { fmtMon, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { toRaw } from "@/lib/wallet";
import { usePoll } from "../usePoll";
import { useApp } from "../app/AppProvider";
import { AccountSetup } from "../app/AccountSetup";

const symbol = config.devChain ? "ETH" : "MON";
const CATEGORIES = ["DeFi", "Altyapı", "Yapay zekâ", "Oyun", "Sosyal", "Topluluk · DAO", "Cüzdan", "Depolama", "Diğer"];
const LINKS = [
  ["website", "Web sitesi"],
  ["twitter", "X / Twitter"],
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["github", "GitHub"],
  ["whitepaper", "Whitepaper"],
] as const;

type Form = {
  name: string; symbol: string; category: string; logo: string;
  description: string; team: string; roadmap: string; tokenomics: string;
  website: string; twitter: string; telegram: string; discord: string; github: string; whitepaper: string;
  supply: string; liquidityPct: string; mon: string;
};

const empty: Form = {
  name: "", symbol: "", category: "", logo: "", description: "", team: "", roadmap: "", tokenomics: "",
  website: "", twitter: "", telegram: "", discord: "", github: "", whitepaper: "", supply: "10000000", liquidityPct: "20", mon: "",
};

function validate(f: Form, rate: bigint, monRaw: bigint, balance: bigint, minQuote: bigint) {
  const e: Partial<Record<keyof Form, string>> = {};
  if (!f.name.trim() || f.name.length > 48) e.name = "1–48 karakter";
  if (!/^[A-Z0-9]{2,11}$/.test(f.symbol)) e.symbol = "2–11 büyük harf/rakam";
  if (f.description.trim().length < 40) e.description = "En az 40 karakterle projeyi anlat";
  for (const [k] of LINKS) if (f[k] && !/^https:\/\/[^\s]+$/.test(f[k])) e[k] = "https:// ile başlamalı";
  if (f.logo && !/^https:\/\/[^\s]+$/.test(f.logo)) e.logo = "https:// ile başlamalı";
  const supply = Number(f.supply);
  if (!Number.isInteger(supply) || supply < 1000 || supply > 1e15) e.supply = "1.000 ile 10¹⁵ arasında tam sayı";
  const pct = Number(f.liquidityPct);
  if (!(pct >= 1 && pct <= 100)) e.liquidityPct = "%1–100";
  const usd = rate ? (monRaw * rate) / 10n ** 18n : 0n;
  if (usd < minQuote) e.mon = `En az ${fmtUsd(minQuote)} likidite (${rate ? fmtMon((minQuote * 10n ** 18n + rate - 1n) / rate, symbol) : "—"})`;
  else if (monRaw >= balance) e.mon = `Yatırma adresindeki ${symbol} yetmiyor (işlem ücreti dahil)`;
  return e;
}

export function Launch() {
  const { wallet, info, setSweepPaused, refreshData } = useApp();
  const router = useRouter();
  const [f, setF] = useState<Form>(empty);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();

  // Bu sayfadayken yatırma adresine gelen MON gizli bakiyeye çevrilmez: likidite için kullanılır.
  useEffect(() => {
    setSweepPaused(true);
    return () => setSweepPaused(false);
  }, [setSweepPaused]);
  const balance = usePoll(async () => (wallet ? wallet.monBalance() : 0n), 4_000, [wallet]);

  if (!wallet)
    return (
      <div className="mx-auto mt-10 max-w-md">
        <section className="panel-box p-6">
          <h1 className="mb-4 text-xl font-semibold">Token oluşturmak için gizli hesap gerekli</h1>
          {wallet === undefined ? <p className="text-muted">Hesap yükleniyor…</p> : <AccountSetup />}
        </section>
      </div>
    );

  const rate = info?.gateway ? BigInt(info.gateway.usdPerMon) : 0n;
  let monRaw = 0n;
  try {
    monRaw = f.mon ? toRaw(f.mon, 18) : 0n;
  } catch {}
  const bal = balance.data ?? 0n;
  const errors = validate(f, rate, monRaw, bal, BigInt(info?.launchMinQuote ?? "250000"));
  const valid = Object.keys(errors).length === 0;
  const usd = rate ? (monRaw * rate) / 10n ** 18n : 0n;
  const supply = Number(f.supply) || 0;
  const liqTokens = Math.floor((supply * (Number(f.liquidityPct) || 0)) / 100);
  const price = liqTokens ? Number(usd) / 1e6 / liqTokens : null;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value });
  const show = (k: keyof Form) => (touched || f[k]) && errors[k] ? <small className="form-error">{errors[k]}</small> : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !info) return;
    setErr(undefined);
    try {
      const metadata = JSON.stringify({
        name: f.name.trim(), symbol: f.symbol, category: f.category, logo: f.logo.trim(),
        description: f.description.trim(), team: f.team.trim(), roadmap: f.roadmap.trim(), tokenomics: f.tokenomics.trim() ||
          `Toplam arz ${fmtNum(supply)} ${f.symbol} · %${f.liquidityPct} başlangıç likiditesi · kalanı proje hazinesi`,
        website: f.website.trim(), twitter: f.twitter.trim(), telegram: f.telegram.trim(), discord: f.discord.trim(), github: f.github.trim(), whitepaper: f.whitepaper.trim(),
      });
      const E18 = 10n ** 18n;
      const poolId = await wallet.launch(
        info,
        { name: f.name.trim(), symbol: f.symbol, supply: BigInt(supply) * E18, liquidityBase: BigInt(liqTokens) * E18, mon: monRaw, metadata },
        setBusy,
      );
      refreshData();
      router.push(`/token/${poolId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <form className="launch-grid" onSubmit={submit} noValidate>
      <div className="grid gap-6">
        <header>
          <span className="mini-eyebrow">PROJE AÇILIŞI</span>
          <h1 className="mt-1 text-2xl font-semibold">Token oluştur</h1>
          <p className="mt-1 max-w-2xl text-muted">
            Sabit arzlı token&apos;ın basılır ve gizli havuzu açılır. Başlangıç likiditesi açıktır; sonrasındaki tüm işlemler karanlıktır ve fiyat 7 gün gecikmeli görünür.
            Yatırımcılar projeni yalnızca anlattıkların ve yayınladığın haberlerle değerlendirir; bu yüzden ayrıntılı yaz.
          </p>
        </header>

        <fieldset className="panel-box form-section">
          <legend>Temel bilgiler</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field"><span>Proje adı *</span><input value={f.name} onChange={set("name")} maxLength={48} placeholder="ArfDAO" />{show("name")}</label>
            <label className="field"><span>Token sembolü *</span><input value={f.symbol} onChange={set("symbol")} maxLength={11} placeholder="ARF" className="num" />{show("symbol")}</label>
            <label className="field"><span>Kategori</span>
              <select value={f.category} onChange={set("category")}>
                <option value="">Seç</option>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="field"><span>Logo bağlantısı</span><input type="url" value={f.logo} onChange={set("logo")} placeholder="https://" />{show("logo")}</label>
          </div>
        </fieldset>

        <fieldset className="panel-box form-section">
          <legend>Projeyi anlat</legend>
          <label className="field"><span>Açıklama * <small className="text-muted">(ne yapıyorsunuz, kimin için, neden şimdi)</small></span><textarea rows={5} maxLength={4000} value={f.description} onChange={set("description")} />{show("description")}</label>
          <label className="field"><span>Ekip</span><textarea rows={3} maxLength={4000} value={f.team} onChange={set("team")} placeholder="Kurucular, deneyim, bağlantılar" /></label>
          <label className="field"><span>Yol haritası</span><textarea rows={3} maxLength={4000} value={f.roadmap} onChange={set("roadmap")} placeholder={"Ç1: …\nÇ2: …"} /></label>
          <label className="field"><span>Token dağılımı</span><textarea rows={2} maxLength={4000} value={f.tokenomics} onChange={set("tokenomics")} placeholder="Boş bırakılırsa arz ve likidite oranından yazılır" /></label>
        </fieldset>

        <fieldset className="panel-box form-section">
          <legend>Bağlantılar</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {LINKS.map(([k, label]) => (
              <label className="field" key={k}><span>{label}</span><input type="url" value={f[k]} onChange={set(k)} placeholder="https://" />{show(k)}</label>
            ))}
          </div>
        </fieldset>

        <fieldset className="panel-box form-section">
          <legend>Token ve likidite</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="field"><span>Toplam arz *</span><input inputMode="numeric" value={f.supply} onChange={set("supply")} className="num" />{show("supply")}</label>
            <label className="field"><span>Havuza giden (%) *</span><input inputMode="decimal" value={f.liquidityPct} onChange={set("liquidityPct")} className="num" />{show("liquidityPct")}</label>
            <label className="field"><span>Likidite ({symbol}) *</span><input inputMode="decimal" value={f.mon} onChange={set("mon")} placeholder="0" className="num" />{show("mon")}</label>
          </div>
          <p className="text-xs text-muted">Kalan arz ({fmtNum(supply - liqTokens)} {f.symbol || "token"}) yatırma adresine, yani sana gönderilir. Token sonradan basılamaz.</p>
        </fieldset>
      </div>

      <aside className="launch-side">
        <section className="panel-box p-5">
          <p className="mini-eyebrow">ÖNİZLEME</p>
          <div className="mt-3 flex items-center gap-3">
            <span className="project-avatar large">{(f.symbol || "??").slice(0, 2)}</span>
            <div><strong className="block text-lg">{f.name || "Proje adı"}</strong><small className="text-muted">{f.symbol || "SEMBOL"}{f.category ? ` · ${f.category}` : ""}</small></div>
          </div>
          <div className="summary-rows mt-4">
            <p><span>Havuza giden</span><strong className="num">{fmtNum(liqTokens)} {f.symbol}</strong></p>
            <p><span>Karşılık likidite</span><strong className="num">{fmtUsd(usd)}</strong></p>
            <p><span>Açılış fiyatı</span><strong className="num">{price ? `${fmtPrice(price)} $` : "—"}</strong></p>
            <p><span>Harcanacak</span><strong className="num">{monRaw ? fmtMon(monRaw, symbol) : "—"} + ücret</strong></p>
          </div>
        </section>
        <FundBox address={wallet.depositAddress} balance={bal} />
        {err && <p className="form-error" role="alert">{err}</p>}
        <button type="submit" className="btn-primary w-full" disabled={!!busy || (touched && !valid)}>
          {busy ? <><Loader2 size={15} className="animate-spin" /> {busy}</> : <><Rocket size={15} /> Token&apos;ı oluştur ve havuzu aç</>}
        </button>
        <p className="text-xs text-muted">Proje bilgileri açılış işlemine özetiyle bağlanır; sonradan değiştirilemez. Haber yayınlama yetkisi bu hesaba verilir.</p>
      </aside>
    </form>
  );
}

function FundBox({ address, balance }: { address: string; balance: bigint }) {
  const { wallet } = useApp();
  const [svg, setSvg] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    QRCode.toString(address, { type: "svg", margin: 1, color: { dark: "#0b0e11", light: "#ffffff" } }).then(setSvg);
  }, [address]);
  return (
    <section className="panel-box grid gap-3 p-5">
      <p className="mini-eyebrow">LİKİDİTE İÇİN {symbol}</p>
      <p className="text-sm">Yatırma adresindeki açık bakiye: <strong className="num">{fmtMon(balance, symbol)}</strong></p>
      <div className="flex items-center gap-3">
        <div className="qr-box small" role="img" aria-label="Yatırma adresi QR" dangerouslySetInnerHTML={{ __html: svg }} />
        <button type="button" className="address-box text-xs" onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          <span className="num break-all text-left">{address}</span>{copied ? <Check size={16} className="text-buy" /> : <Copy size={16} />}
        </button>
      </div>
      <p className="text-xs text-muted">Bu sayfa açıkken gelen {symbol} gizli bakiyeye çevrilmez, proje likiditesi için bekler.</p>
      {config.devChain && <button type="button" className="btn-secondary" onClick={() => wallet?.devFund()}>Test {symbol}&apos;u gönder (yerel)</button>}
    </section>
  );
}
