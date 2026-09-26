"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, Copy, Loader2, X } from "lucide-react";
import { config } from "@/lib/config";
import { fmtMon, fmtRate, fmtUsd, relTime } from "@/lib/format";
import { toRaw, USD_DECIMALS } from "@/lib/wallet";
import { useApp, type FundsTab } from "./AppProvider";
import { AccountSetup } from "./AccountSetup";

const symbol = config.devChain ? "ETH" : "MON";

export function FundsModal() {
  const { funds, closeFunds, openFunds, wallet } = useApp();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!funds) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeFunds();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [funds, closeFunds]);
  if (!funds) return null;

  return (
    <div className="modal-backdrop" onClick={closeFunds}>
      <div role="dialog" aria-modal="true" aria-labelledby="funds-title" className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button ref={close} type="button" className="modal-close" onClick={closeFunds} aria-label="Kapat"><X size={18} /></button>
        <h2 id="funds-title" className="modal-title">{!wallet ? "Gizli hesabını oluştur" : funds === "deposit" ? "Kripto ile yatır" : "Çek"}</h2>
        {!wallet ? (
          wallet === undefined ? <p className="text-center text-muted">Hesap yükleniyor…</p> : <AccountSetup />
        ) : (
          <>
            <div className="segmented" role="tablist">
              {(["deposit", "withdraw"] as FundsTab[]).map((t) => (
                <button key={t} role="tab" type="button" aria-selected={funds === t} className={funds === t ? "active" : ""} onClick={() => openFunds(t)}>
                  {t === "deposit" ? <><ArrowDownToLine size={15} /> Yatır</> : <><ArrowUpFromLine size={15} /> Çek</>}
                </button>
              ))}
            </div>
            {funds === "deposit" ? <Deposit /> : <Withdraw />}
          </>
        )}
      </div>
    </div>
  );
}

function Deposit() {
  const { wallet, info, sweep } = useApp();
  const address = wallet!.depositAddress;
  const [svg, setSvg] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    QRCode.toString(address, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0b0e11", light: "#ffffff" } }).then(setSvg);
  }, [address]);
  const rate = info?.gateway ? Number(info.gateway.usdPerMon) / 10 ** USD_DECIMALS : null;
  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="grid gap-4">
      <div className="network-select" aria-label="Ağ">
        <span className="network-icon" aria-hidden>M</span>
        <span>{config.chainName}</span>
        <ChevronDown size={16} className="ml-auto text-muted" aria-hidden />
      </div>
      <p className="text-center text-muted">
        Bu adrese {config.chainName} üzerinden <strong className="text-fg">{symbol}</strong> gönder. Gelen {symbol}, gizli dolar bakiyene otomatik eklenir
        {rate ? <> (kur: <strong className="text-fg">1 {symbol} = {fmtRate(rate)}</strong>, MON piyasa fiyatı)</> : null}.
      </p>
      <div className="qr-box" aria-label="Yatırma adresi QR kodu" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
      <button type="button" className="address-box" onClick={copy} aria-label="Adresi kopyala">
        <span className="num break-all text-left">{address}</span>
        {copied ? <Check size={18} className="text-buy" /> : <Copy size={18} className="text-muted" />}
      </button>

      <div className="deposit-status" aria-live="polite">
        {sweep.state === "sweeping" ? (
          <><Loader2 size={15} className="animate-spin" /> {sweep.mon ? `${fmtMon(sweep.mon, symbol)} geldi — gizli bakiyeye çevriliyor` : "Çevriliyor"}</>
        ) : sweep.state === "error" ? (
          <span className="text-sell">Çevrilemedi: {sweep.error}</span>
        ) : sweep.last ? (
          <><Check size={15} className="text-buy" /> {fmtUsd(sweep.last.usd)} gizli bakiyene eklendi · {relTime(sweep.last.at / 1000)}</>
        ) : sweep.mon ? (
          <span>{fmtMon(sweep.mon, symbol)} bekliyor: en az 0,01 $ ve işlem ücreti (~0,2 {symbol}) kadar {symbol} gerekiyor</span>
        ) : (
          <><Loader2 size={15} className="animate-spin text-muted" /> {symbol} bekleniyor…</>
        )}
      </div>

      {config.devChain && (
        <button type="button" className="btn-secondary" onClick={() => wallet!.devFund().catch((e) => setErr((e as Error).message))}>
          Test {symbol}&apos;u gönder (yerel zincir, 100 {symbol})
        </button>
      )}
      {err && <p className="form-error">{err}</p>}
      <p className="text-xs text-muted">
        Yatırma işlemi zincirde görünür, sonraki gizli alım-satımlarınla ilişkilendirilemez. Bu adresin anahtarı tarayıcında: yedeğini Portföy sayfasından indir.
      </p>
    </div>
  );
}

function Withdraw() {
  const { wallet, info, cash } = useApp();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [asMon, setAsMon] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  let raw = 0n;
  let parseErr: string | undefined;
  try {
    raw = amount ? toRaw(amount, USD_DECIMALS) : 0n;
    if (raw > cash) parseErr = "Nakit bakiyeni aşıyor";
  } catch (e) {
    parseErr = (e as Error).message;
  }
  const rate = info?.gateway ? BigInt(info.gateway.usdPerMon) : 0n;
  const mon = rate ? (raw * 10n ** 18n) / rate : 0n;
  const liquidity = info?.gateway ? BigInt(info.gateway.balance) : 0n;
  const short = asMon && mon > liquidity;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info) return;
    setErr(undefined);
    setOk(undefined);
    try {
      setBusy("Hazırlanıyor");
      await wallet!.withdraw(info, raw, to.trim(), asMon, setBusy);
      setOk(asMon ? `${fmtMon(mon, symbol)} gönderildi. Gazı relayer ödedi.` : `${fmtUsd(raw)} dUSD gönderildi.`);
      setAmount("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">Çekilebilir nakit</span>
        <strong className="num">{fmtUsd(cash)}</strong>
      </div>
      <label className="field">
        <span>Tutar ($)</span>
        <div className="input-row">
          <input inputMode="decimal" autoComplete="off" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button type="button" onClick={() => setAmount((Number(cash) / 1e6).toFixed(6).replace(/\.?0+$/, "").replace(".", ","))}>Tümü</button>
        </div>
      </label>
      <label className="field">
        <span>Alıcı adres</span>
        <input className="num" autoComplete="off" spellCheck={false} placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="segmented small" role="radiogroup" aria-label="Çekim birimi">
        <button type="button" role="radio" aria-checked={asMon} className={asMon ? "active" : ""} onClick={() => setAsMon(true)}>{symbol} olarak</button>
        <button type="button" role="radio" aria-checked={!asMon} className={!asMon ? "active" : ""} onClick={() => setAsMon(false)}>dUSD olarak</button>
      </div>
      <div className="summary-rows">
        <p><span>Alacağın</span><strong className="num">{raw ? (asMon ? `≈ ${fmtMon(mon, symbol)}` : `${fmtUsd(raw)} dUSD`) : "—"}</strong></p>
        <p><span>İşlem ücreti</span><strong>Relayer öder</strong></p>
      </div>
      {parseErr && amount && <p className="form-error">{parseErr}</p>}
      {short && <p className="form-error">Gateway&apos;in {symbol} likiditesi yetersiz ({fmtMon(liquidity, symbol)}). dUSD olarak çekebilirsin.</p>}
      {err && <p className="form-error" role="alert">{err}</p>}
      {ok && <p className="text-sm text-buy" role="status">{ok}</p>}
      <button type="submit" className="btn-primary" disabled={!!busy || !raw || !!parseErr || !to || short}>
        {busy ? <><Loader2 size={15} className="animate-spin" /> {busy}</> : "Gazsız çek"}
      </button>
      <p className="text-xs text-muted">Çekim sıfır bilgi kanıtıyla yapılır; alıcı adres, yatırma adresinle ilişkilendirilemez. Yeni bir adres kullanman önerilir.</p>
    </form>
  );
}
