// Tarayıcıya gömülen yapılandırma (scripts/dev-stack.sh, scripts/testnet.sh ya da Vercel ortamı yazar).
//
// Barındırma panellerinde değer alanına yanlışlıkla "AD=değer" satırının tamamı ya da tırnaklı
// değer yapıştırılabiliyor; önek, tırnak ve boşluklar temizlenir.
function env(name: string, raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  let v = raw.trim();
  if (v.startsWith(`${name}=`)) v = v.slice(name.length + 1).trim();
  v = v.replace(/^["']|["']$/g, "").trim();
  return v || undefined;
}

// NEXT_PUBLIC_* değişkenleri derleme anında yerine konur: her biri açıkça yazılmalı.
const RPC = env("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
const RELAYER = env("NEXT_PUBLIC_RELAYER_URL", process.env.NEXT_PUBLIC_RELAYER_URL);
const CHAIN_ID = env("NEXT_PUBLIC_CHAIN_ID", process.env.NEXT_PUBLIC_CHAIN_ID);
const VAULT = env("NEXT_PUBLIC_VAULT", process.env.NEXT_PUBLIC_VAULT);
const DEV = env("NEXT_PUBLIC_DEV_CHAIN", process.env.NEXT_PUBLIC_DEV_CHAIN) === "1";
const EXPLORER = env("NEXT_PUBLIC_EXPLORER_URL", process.env.NEXT_PUBLIC_EXPLORER_URL);
const CHAIN_NAME = env("NEXT_PUBLIC_CHAIN_NAME", process.env.NEXT_PUBLIC_CHAIN_NAME);

/** Yapılandırma hatası (ör. geçersiz vault adresi) varsa arayüz bunu açıkça gösterir. */
export const configError: string | null =
  VAULT && !/^0x[0-9a-fA-F]{40}$/.test(VAULT)
    ? `NEXT_PUBLIC_VAULT geçerli bir adres değil: "${VAULT}"`
    : CHAIN_ID && !/^\d+$/.test(CHAIN_ID)
      ? `NEXT_PUBLIC_CHAIN_ID sayı olmalı: "${CHAIN_ID}"`
      : null;

export const config = {
  /** İlk RPC; cüzdana (MetaMask) eklenen adres budur. */
  rpcUrl: (RPC ?? "http://127.0.0.1:28545").split(",")[0].trim(),
  /** Virgülle ayrılmış RPC listesi: ilki düşerse sıradakine geçilir (viem `fallback`). */
  rpcUrls: (RPC ?? "http://127.0.0.1:28545").split(",").map((u) => u.trim()).filter(Boolean),
  relayerUrl: (RELAYER ?? "http://127.0.0.1:28090").replace(/\/+$/, ""),
  chainId: Number(CHAIN_ID ?? 31337),
  vault: (VAULT ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  /** Yalnızca yerel anvil: test MON'u gönderme düğmesi */
  devChain: DEV,
  explorerUrl: EXPLORER ?? "",
  chainName: CHAIN_NAME ?? (DEV ? "Yerel (anvil)" : "Monad Testnet"),
};
