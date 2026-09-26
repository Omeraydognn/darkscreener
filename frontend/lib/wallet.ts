// Gizli cüzdan (tarayıcı): anahtar türetme, not defteri, yatırma, gizli emir, sonuç açma, çekim.
//
// Anahtarlar kullanıcının cüzdan imzasından TÜRETİLİR (saklanmaz): aynı cüzdan aynı mesajı
// yeniden imzalayınca aynı gizli hesap geri gelir. Not defteri (tutar + rastgele değerler)
// tarayıcıda tutulur; "Yedeği indir" ile dışa aktarılabilir.
//
// Emir/çekim zincire RELAYER'dan gider: cüzdan adresi emirle ilişkilenmez.

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  hexToBytes,
  bytesToHex,
  http,
  keccak256,
  parseAbi,
  concat,
  type Account,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { buildSpendInput, noteHelpers, randomField, SNARK_FIELD, Tree } from "darkpool-sdk/note.mjs";
import { encryptOrder, openResult, orderContext, Side } from "darkpool-sdk/order.mjs";
import { proofForRelayer } from "darkpool-sdk/relayer.mjs";
import { api, type Info } from "./api";
import { config } from "./config";

export const chain = defineChain({
  id: config.chainId,
  name: config.chainName,
  nativeCurrency: { name: config.devChain ? "ETH" : "MON", symbol: config.devChain ? "ETH" : "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  ...(config.explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } } : {}),
});
export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

const vaultAbi = parseAbi([
  "function deposit(address token, uint128 amount, uint256 secretHash)",
  "function noteRoot() view returns (uint256)",
  "function withdrawContext(address recipient) view returns (uint256)",
  "function minDeposit(address token) view returns (uint128)",
]);
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
]);

// ---------------------------------------------------------------- tipler

export type NoteOrigin = "deposit" | "change" | "output" | "refund";
export type NoteRec = {
  commitment: string;
  token: `0x${string}`;
  amount: string;
  blinding: string;
  origin: NoteOrigin;
  status: "pending" | "ready" | "spent";
  createdAt: number;
};

export type OrderState = "sent" | "locked" | "revealed" | "refunded";
export type OrderRec = {
  orderId: `0x${string}`;
  poolId: number;
  side: "buy" | "sell";
  inToken: `0x${string}`;
  amountIn: string;
  spendR: string;
  createdAt: number;
  state: OrderState;
  batchId?: number;
  unlockTime?: number;
  result?: { outToken: `0x${string}`; amountOut: string };
};

type Book = { notes: NoteRec[]; orders: OrderRec[] };

// ---------------------------------------------------------------- imzalayıcı

export type Signer = { address: `0x${string}`; client: WalletClient; account: Account | `0x${string}`; kind: "dev" | "injected" };

const DEV_KEY = "darkscreener:devkey";

/** YALNIZCA yerel anvil: tarayıcıda geçici anahtar (gerçek varlık taşımaz). */
export function devSigner(): Signer {
  if (!config.devChain) throw new Error("dev cüzdanı yalnızca yerel zincirde");
  let pk = localStorage.getItem(DEV_KEY) as `0x${string}` | null;
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem(DEV_KEY, pk);
  }
  const account = privateKeyToAccount(pk);
  return { address: account.address, account, client: createWalletClient({ chain, transport: http(config.rpcUrl), account }), kind: "dev" };
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

export async function injectedSigner(): Promise<Signer> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("Tarayıcı cüzdanı bulunamadı");
  const client = createWalletClient({ chain, transport: custom(eth) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: chain.id });
  } catch {
    await client.addChain({ chain });
  }
  return { address, account: address, client, kind: "injected" };
}

// ---------------------------------------------------------------- gizli hesap

function keyMessage() {
  return [
    "darkscreener gizli hesap anahtarı",
    `Zincir: ${config.chainId}`,
    `Vault: ${config.vault.toLowerCase()}`,
    "Bu imza yalnızca gizli hesap anahtarlarını türetmek içindir; işlem göndermez.",
  ].join("\n");
}

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export class ShieldedWallet {
  private constructor(
    readonly signer: Signer,
    private spendKey: bigint,
    readonly owner: bigint,
    private viewSk: Uint8Array,
    private h: Awaited<ReturnType<typeof noteHelpers>>,
  ) {}

  /** Cüzdana sabit bir mesaj imzalatır; gizli anahtarlar imzadan türetilir. */
  static async open(signer: Signer): Promise<ShieldedWallet> {
    const sig = await signer.client.signMessage({ account: signer.account, message: keyMessage() });
    const seed = keccak256(sig);
    const spendKey = BigInt(keccak256(concat([seed, "0x01"]))) % SNARK_FIELD;
    const v = (BigInt(keccak256(concat([seed, "0x02"]))) % (N - 1n)) + 1n;
    const viewSk = hexToBytes(`0x${v.toString(16).padStart(64, "0")}`);
    const h = await noteHelpers();
    return new ShieldedWallet(signer, spendKey, h.owner(spendKey), viewSk, h);
  }

  get viewPub() {
    return secp256k1.getPublicKey(this.viewSk, true);
  }

  // ---- not defteri (localStorage)
  private get key() {
    return `darkscreener:book:${config.chainId}:${config.vault.toLowerCase()}:${this.signer.address.toLowerCase()}`;
  }
  load(): Book {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? "") as Book;
    } catch {
      return { notes: [], orders: [] };
    }
  }
  private save(b: Book) {
    localStorage.setItem(this.key, JSON.stringify(b));
  }
  exportBackup(): string {
    return JSON.stringify({ version: 1, chainId: config.chainId, vault: config.vault, ...this.load() }, null, 2);
  }

  private commitment(token: string, amount: bigint, blinding: bigint) {
    return this.h.commitment(BigInt(token), amount, this.h.secretHash(this.owner, blinding));
  }
  private addNote(b: Book, token: `0x${string}`, amount: bigint, blinding: bigint, origin: NoteOrigin) {
    if (amount === 0n) return;
    const c = `0x${this.commitment(token, amount, blinding).toString(16).padStart(64, "0")}`;
    if (b.notes.some((n) => n.commitment === c)) return;
    b.notes.push({ commitment: c, token, amount: amount.toString(), blinding: blinding.toString(), origin, status: "pending", createdAt: Date.now() });
  }

  /** Ağaç: relayer'dan yaprakları al, zincirdeki kökle karşılaştır (relayer'a körü körüne güvenme). */
  private async tree(): Promise<Tree> {
    const res = await fetch(`${config.relayerUrl}/v1/notes?limit=50000`, { cache: "no-store" });
    const page = (await res.json()) as { commitments: string[] };
    const t = new Tree(this.h.H);
    for (const c of page.commitments) t.insert(BigInt(c));
    const onchain = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "noteRoot" });
    if (t.root() !== onchain) throw new Error("Not ağacı henüz senkron değil; birkaç saniye sonra tekrar deneyin");
    return t;
  }

  /** Bekleyen notları ağaçta arar; emirlerin durumunu günceller (sonuç açma dahil). */
  async sync(): Promise<Book> {
    const b = this.load();
    const res = await fetch(`${config.relayerUrl}/v1/notes?limit=50000`, { cache: "no-store" });
    const leaves = new Set(((await res.json()) as { commitments: string[] }).commitments.map((c) => c.toLowerCase()));
    for (const n of b.notes) if (n.status === "pending" && leaves.has(n.commitment.toLowerCase())) n.status = "ready";

    for (const o of b.orders.filter((o) => o.state !== "revealed" && o.state !== "refunded")) {
      const s = await api.order(o.orderId).catch(() => null);
      if (!s?.batchId) continue;
      o.batchId = s.batchId;
      o.unlockTime = s.unlockTime;
      if (s.status === 2) {
        o.state = "refunded";
        this.addNote(b, o.inToken, BigInt(o.amountIn), BigInt(o.spendR), "refund");
      } else if (s.kb && s.sealedResult) {
        const r = await openResult(hexToBytes(s.kb as `0x${string}`), this.viewSk, o.orderId, hexToBytes(s.sealedResult as `0x${string}`));
        o.result = { outToken: getAddress(r.outToken), amountOut: r.amountOut.toString() };
        o.state = "revealed";
        this.addNote(b, getAddress(r.outToken), r.amountOut, r.blinding, "output");
      } else {
        o.state = "locked";
      }
    }
    this.save(b);
    return b;
  }

  // ---- işlemler

  private async write(address: `0x${string}`, abi: typeof vaultAbi | typeof erc20Abi, functionName: string, args: unknown[]) {
    const hash = await this.signer.client.writeContract({
      address,
      abi,
      functionName,
      args,
      account: this.signer.account,
      chain,
    } as never);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} başarısız`);
  }

  async deposit(token: `0x${string}`, amount: bigint) {
    const min = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "minDeposit", args: [token] });
    if (amount < min) throw new Error("En düşük yatırma tutarının altında");
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.signer.address, config.vault] });
    if (allowance < amount) await this.write(token, erc20Abi, "approve", [config.vault, amount]);
    const blinding = randomField();
    const b = this.load();
    this.addNote(b, token, amount, blinding, "deposit");
    this.save(b); // tx'ten ÖNCE kaydet: sekme kapanırsa not kaybolmasın
    await this.write(config.vault, vaultAbi, "deposit", [token, amount, this.h.secretHash(this.owner, blinding)]);
  }

  /** Tek bir hazır nottan harcar; yeterli tek not yoksa hata verir. */
  private pick(b: Book, token: string, amount: bigint) {
    const candidates = b.notes
      .filter((n) => n.status === "ready" && n.token.toLowerCase() === token.toLowerCase() && BigInt(n.amount) >= amount)
      .sort((a, c) => (BigInt(a.amount) < BigInt(c.amount) ? -1 : 1));
    if (!candidates.length) throw new Error("Bu tutarı karşılayan hazır bir gizli notunuz yok (önce yatırın ya da tutarı düşürün)");
    return candidates[0];
  }

  private async prove(tree: Tree, n: NoteRec, amount: bigint, spendBlinding: bigint, changeBlinding: bigint, ctx: bigint) {
    const leafIndex = tree.leaves.findIndex((l) => l === BigInt(n.commitment));
    if (leafIndex < 0) throw new Error("Not ağaçta bulunamadı");
    const { input, publicInputs } = buildSpendInput(
      this.h,
      tree,
      { token: BigInt(n.token), amount: BigInt(n.amount), spendKey: this.spendKey, blinding: BigInt(n.blinding), leafIndex },
      { amount, blinding: spendBlinding },
      changeBlinding,
      ctx,
    );
    const snarkjs = await import("snarkjs");
    const { proof } = await snarkjs.groth16.fullProve(input, "/zk/spend.wasm", "/zk/spend_final.zkey");
    return proofForRelayer({ proof, publicInputs });
  }

  async placeOrder(p: { info: Info; poolId: number; side: "buy" | "sell"; inToken: `0x${string}`; amount: bigint }, onStep?: (s: string) => void) {
    if (!p.info.enclave.registered) throw new Error("Enclave anahtarı zincirde kayıtlı değil; emir şifrelenmedi");
    const b = this.load();
    const note = this.pick(b, p.inToken, p.amount);
    onStep?.("Not ağacı doğrulanıyor");
    const tree = await this.tree();
    const spendR = randomField();
    const spendBlinding = this.h.secretHash(this.owner, spendR);
    onStep?.("Emir enclave anahtarına şifreleniyor");
    const ct = await encryptOrder(hexToBytes(p.info.enclave.publicKey as `0x${string}`), config.chainId, config.vault, {
      side: p.side === "buy" ? Side.Buy : Side.Sell,
      poolId: p.poolId,
      amountIn: p.amount,
      recipientPub: this.viewPub,
      spendBlinding,
      owner: this.owner,
    });
    onStep?.("Sıfır bilgi kanıtı üretiliyor");
    const changeBlinding = randomField();
    const proof = await this.prove(tree, note, p.amount, spendBlinding, changeBlinding, orderContext(ct));
    onStep?.("Relayer üzerinden gönderiliyor");
    const res = await fetch(`${config.relayerUrl}/v1/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ciphertext: bytesToHex(ct), proof }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Relayer emri reddetti");

    const after = this.load();
    const spent = after.notes.find((n) => n.commitment === note.commitment);
    if (spent) spent.status = "spent";
    this.addNote(after, note.token, BigInt(note.amount) - p.amount, changeBlinding, "change");
    after.orders.unshift({
      orderId: json.orderId,
      poolId: p.poolId,
      side: p.side,
      inToken: p.inToken,
      amountIn: p.amount.toString(),
      spendR: spendR.toString(),
      createdAt: Date.now(),
      state: "sent",
    });
    this.save(after);
    return json.orderId as string;
  }

  async withdraw(commitment: string, recipient: `0x${string}`, onStep?: (s: string) => void) {
    const b = this.load();
    const n = b.notes.find((x) => x.commitment === commitment && x.status === "ready");
    if (!n) throw new Error("Not hazır değil");
    onStep?.("Not ağacı doğrulanıyor");
    const tree = await this.tree();
    const ctx = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "withdrawContext", args: [recipient] });
    const spendBlinding = randomField();
    onStep?.("Sıfır bilgi kanıtı üretiliyor");
    const proof = await this.prove(tree, n, BigInt(n.amount), spendBlinding, randomField(), ctx);
    onStep?.("Relayer üzerinden gönderiliyor (gaz ödemezsiniz)");
    const res = await fetch(`${config.relayerUrl}/v1/withdrawals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof, token: n.token, amount: n.amount, spendBlinding: spendBlinding.toString(), recipient }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Relayer çekimi reddetti");
    const after = this.load();
    const x = after.notes.find((y) => y.commitment === commitment);
    if (x) x.status = "spent";
    this.save(after);
  }

  /** Test token musluğu (yerel zincir + testnet demo). Token başına 10.000 birim basar;
   * testnet'te gaz (MON) kullanıcının cüzdanından ödenir. */
  async faucet(tokens: { address: `0x${string}`; decimals?: number }[]) {
    if (!config.testTokens) throw new Error("Musluk yalnızca test token'larında");
    if (config.devChain)
      await publicClient.request({ method: "anvil_setBalance" as never, params: [this.signer.address, "0x56BC75E2D63100000"] as never });
    else if ((await publicClient.getBalance({ address: this.signer.address })) === 0n)
      throw new Error("Cüzdanınızda gaz için MON yok. Monad testnet musluğundan MON alın.");
    for (const t of tokens) await this.write(t.address, erc20Abi, "mint", [this.signer.address, 10_000n * 10n ** BigInt(t.decimals ?? 18)]);
  }
}

export const toRaw = (v: string, decimals: number): bigint => {
  const [i, f = ""] = v.trim().replace(",", ".").split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error("Geçersiz tutar");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};

