"use client";

import { useState } from "react";
import { KeyRound, Plus, Upload, Wallet } from "lucide-react";
import type { Hex } from "viem";
import { config } from "@/lib/config";
import { accountStore, secretFromWallet } from "@/lib/wallet";

/** Hesap yoksa: yeni gizli hesap, yedekten geri yükleme ya da tarayıcı cüzdanıyla giriş. */
export function AccountSetup({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<"main" | "import">("main");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void> | void) => {
    setErr(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importText = (text: string) => {
    const t = text.trim();
    let secret = t;
    if (t.startsWith("{")) {
      const j = JSON.parse(t) as { secret?: string; notes?: unknown };
      if (!j.secret) throw new Error("Bu yedek dosyasında gizli anahtar yok");
      secret = j.secret;
      // Not defteri, hesap açıldıktan sonra geri yüklenir (bkz. Portföy › Yedek).
      sessionStorage.setItem("darkscreener:pending-book", t);
    }
    accountStore.save(secret as Hex);
  };

  if (mode === "import")
    return (
      <div className="account-setup">
        <label className="field">
          <span>Gizli anahtar ya da yedek dosyası içeriği</span>
          <textarea rows={4} value={value} onChange={(e) => setValue(e.target.value)} placeholder="0x… ya da yedek JSON" spellCheck={false} autoComplete="off" />
        </label>
        <label className="btn-secondary w-full cursor-pointer">
          <Upload size={15} /> Yedek dosyası seç
          <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setValue(await f.text());
          }} />
        </label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="btn-secondary" onClick={() => setMode("main")}>Geri</button>
          <button type="button" className="btn-primary" disabled={!value.trim() || busy} onClick={() => run(() => importText(value))}>Geri yükle</button>
        </div>
      </div>
    );

  return (
    <div className="account-setup">
      {!compact && (
        <p className="text-muted">
          Cüzdan bağlamana gerek yok. Gizli hesabın bu tarayıcıda oluşturulur. Sana özel bir yatırma adresi alırsın; oraya MON gönderdiğinde gizli dolar bakiyene eklenir.
        </p>
      )}
      <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => run(() => void accountStore.create())}>
        <Plus size={16} /> Gizli hesap oluştur
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setMode("import")}>
          <KeyRound size={15} /> Yedekten yükle
        </button>
        {!config.devChain ? (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(async () => accountStore.save(await secretFromWallet()))}>
            <Wallet size={15} /> Cüzdanla giriş
          </button>
        ) : (
          <span className="grid place-items-center text-center text-xs text-muted">Yerel zincir</span>
        )}
      </div>
      {err && <p className="form-error" role="alert">{err}</p>}
      {!compact && <p className="text-xs text-muted">Anahtarın yalnızca bu tarayıcıda durur. Hesabı açtıktan sonra Portföy sayfasından yedeğini indir.</p>}
    </div>
  );
}
