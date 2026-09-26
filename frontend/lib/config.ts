// Tarayıcıya gömülen yapılandırma (scripts/dev-stack.sh ya da deploy ortamı yazar).
export const config = {
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:28545",
  relayerUrl: process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://127.0.0.1:28090",
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337),
  vault: (process.env.NEXT_PUBLIC_VAULT ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  /** Yalnızca yerel anvil: geçici geliştirici cüzdanı + test token musluğu */
  devChain: process.env.NEXT_PUBLIC_DEV_CHAIN === "1",
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? "",
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME ?? (process.env.NEXT_PUBLIC_DEV_CHAIN === "1" ? "Yerel (anvil)" : "Monad Testnet"),
};
