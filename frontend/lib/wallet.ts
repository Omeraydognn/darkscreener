// Gizli hesap (tarayıcı): anahtar türetme, yatırma adresi, not defteri, gizli al/sat, çekim.
//
// Hesap tek bir 32 baytlık GİZLİ ANAHTARDIR (tarayıcıda saklanır; "Yedek" ile dışa aktarılır ya da
// cüzdan imzasından türetilir). Ondan türetilenler:
//   - yatırma adresi (yerel EOA): kullanıcı buraya MON gönderir, uygulama MonGateway ile gizli
//     dolar notuna çevirir. Cüzdan bağlamak gerekmez.
//   - spendKey (not sahipliği, ZK kanıtı) ve görüntüleme anahtarı (7 gün sonra sonuçları açar).
//
// Emir ve çekimler zincire RELAYER'dan gider: yatırma adresi emirlerle ilişkilenmez.

import {
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  getAddress,
  hexToBytes,
  fallback,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  type Account,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { buildSpendInput, noteHelpers, randomField, SNARK_FIELD, Tree } from "darkpool-sdk/note.mjs";
import { encryptOrder, openResult, orderContext, Side } from "darkpool-sdk/order.mjs";
import { proofForRelayer } from "darkpool-sdk/relayer.mjs";
import { message as newsMessage } from "darkpool-sdk/news.mjs";
import { api, type Info, type Pool } from "./api";
import { config } from "./config";

export const chain = defineChain({
  id: config.chainId,
  name: config.chainName,
  nativeCurrency: { name: config.devChain ? "ETH" : "MON", symbol: config.devChain ? "ETH" : "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  ...(config.explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } } : {}),
});
// Herkese açık RPC'ler hız sınırına takılınca (429, CORS başlığı olmadan) tarayıcı "Failed to fetch" verir:
// her adres birkaç kez yeniden denenir, liste verilmişse sıradaki RPC'ye geçilir.
const rpcTransport = () =>
  fallback(config.rpcUrls.map((u) => http(u, { retryCount: 4, retryDelay: 400, timeout: 15_000 })), { rank: false });
export const publicClient = createPublicClient({ chain, transport: rpcTransport() });

const vaultAbi = parseAbi([
  "function noteRoot() view returns (uint256)",
  "function withdrawContext(address recipient) view returns (uint256)",
  "function minDeposit(address token) view returns (uint128)",
]);
const gatewayAbi = parseAbi([
  "function depositNative(uint256 secretHash, uint128 expected) payable",
  "function boxOf(address to) view returns (address)",
]);
const launchpadAbi = parseAbi([
  "function launch(string name, string symbol, uint256 supply, uint128 liquidityBase, bytes32 metadataHash) payable returns (uint32 poolId, address token)",
  "event Launched(uint32 indexed poolId, address indexed token, address indexed creator, bytes32 metadataHash, uint256 supply, uint128 liquidityBase, uint128 liquidityQuote)",
]);

export const USD_DECIMALS = 6;

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
  /** Birden çok nottan bölünmüş tek kullanıcı işlemi aynı grubu paylaşır */
  group: string;
  poolId: number;
  side: "buy" | "sell";
  inToken: `0x${string}`;
  amountIn: string;
  /** Satışlarda kullanıcının seçtiği yüzde */
  pct?: number;
  spendR: string;
  createdAt: number;
  state: OrderState;
  batchId?: number;
  unlockTime?: number;
  result?: { outToken: `0x${string}`; amountOut: string };
};

export type Activity = {
  kind: "deposit" | "withdraw" | "launch";
  time: number;
  /** dUSD (6 ondalık) */
  usd: string;
  /** wei */
  mon?: string;
  to?: string;
  tx?: string;
  poolId?: number;
  status: "pending" | "done" | "failed";
  note?: string;
};

type Book = { notes: NoteRec[]; orders: OrderRec[]; activity: Activity[] };

export type Signer = { address: `0x${string}`; client: WalletClient; account: Account | `0x${string}` };

// ---------------------------------------------------------------- hesap anahtarı

export const ACCOUNT_KEY = `darkscreener:secret:${config.chainId}:${config.vault.toLowerCase()}`;
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export const accountStore = {
  load(): Hex | null {
    try {
      const v = localStorage.getItem(ACCOUNT_KEY);
      return v && /^0x[0-9a-f]{64}$/i.test(v) ? (v as Hex) : null;
    } catch {
      return null;
    }
  },
  save(secret: Hex) {
    if (!/^0x[0-9a-f]{64}$/i.test(secret)) throw new Error("Geçersiz gizli anahtar (0x + 64 hex karakter)");
    localStorage.setItem(ACCOUNT_KEY, secret.toLowerCase());
    window.dispatchEvent(new Event("darkscreener:storage"));
  },
  create(): Hex {
    const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    this.save(secret);
    return secret;
  },
  clear() {
    localStorage.removeItem(ACCOUNT_KEY);
    window.dispatchEvent(new Event("darkscreener:storage"));
  },
};

function keyMessage() {
  return [
    "darkscreener gizli hesap anahtarı",
    `Zincir: ${config.chainId}`,
    `Vault: ${config.vault.toLowerCase()}`,
    "Bu imza yalnızca gizli hesap anahtarlarını türetmek içindir; işlem göndermez.",
  ].join("\n");
}

/** Tarayıcı cüzdanıyla giriş: sabit bir mesajın imzasından aynı gizli anahtar her seferinde yeniden türetilir. */
export async function secretFromWallet(): Promise<Hex> {
  const s = await injectedSigner();
  const sig = await s.client.signMessage({ account: s.account, message: keyMessage() });
  return keccak256(sig);
}

const derive = (seed: Hex, tag: number) => BigInt(keccak256(concat([seed, bytesToHex(new Uint8Array([tag]))])));

// ---------------------------------------------------------------- gizli hesap

export class ShieldedWallet {
  private constructor(
    readonly signer: Signer,
    private spendKey: bigint,
    readonly owner: bigint,
    private viewSk: Uint8Array,
    private secret: Hex,
    private h: Awaited<ReturnType<typeof noteHelpers>>,
  ) {}

  static async fromSecret(secret: Hex): Promise<ShieldedWallet> {
    const seed = keccak256(concat([toBytes("darkscreener/account/v1"), secret]));
    const spendKey = derive(seed, 1) % SNARK_FIELD;
    const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
    const viewSk = hexToBytes(hex32((derive(seed, 2) % (N - 1n)) + 1n));
    const account = privateKeyToAccount(hex32((derive(seed, 3) % (N - 1n)) + 1n));
    const client = createWalletClient({ chain, transport: rpcTransport(), account });
    const h = await noteHelpers();
    return new ShieldedWallet({ address: account.address, account, client }, spendKey, h.owner(spendKey), viewSk, secret, h);
  }

  /** Kullanıcının MON göndereceği adres (bu hesaba özel). */
  get depositAddress() {
    return this.signer.address;
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
      const b = JSON.parse(localStorage.getItem(this.key) ?? "") as Partial<Book>;
      return { notes: b.notes ?? [], orders: (b.orders ?? []).map((o) => ({ ...o, group: o.group ?? o.orderId })), activity: b.activity ?? [] };
    } catch {
      return { notes: [], orders: [], activity: [] };
    }
  }
  private save(b: Book) {
    localStorage.setItem(this.key, JSON.stringify(b));
    window.dispatchEvent(new Event("darkscreener:book"));
  }
  /** Gizli anahtar + not defteri. Gizli anahtar tek başına fonlara erişim sağlar: güvenli saklayın. */
  exportBackup(): string {
    return JSON.stringify({ version: 2, chainId: config.chainId, vault: config.vault, secret: this.secret, ...this.load() }, null, 2);
  }
  importBook(json: string) {
    const b = JSON.parse(json) as Partial<Book> & { secret?: string };
    if (b.secret && b.secret.toLowerCase() !== this.secret.toLowerCase()) throw new Error("Yedek başka bir hesaba ait");
    const cur = this.load();
    for (const n of b.notes ?? []) if (!cur.notes.some((x) => x.commitment === n.commitment)) cur.notes.push(n);
    for (const o of b.orders ?? []) if (!cur.orders.some((x) => x.orderId === o.orderId)) cur.orders.push({ ...o, group: o.group ?? o.orderId });
    for (const a of b.activity ?? []) if (!cur.activity.some((x) => x.time === a.time && x.kind === a.kind)) cur.activity.push(a);
    this.save(cur);
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

  /** Bekleyen notları ağaçta arar; emirlerin durumunu günceller (7 gün sonra sonuçları açar). */
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
        const r = await openResult(hexToBytes(s.kb as Hex), this.viewSk, o.orderId, hexToBytes(s.sealedResult as Hex));
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

  // ---- bakiyeler

  /** Hazır (harcanabilir) notların toplamı; token küçük harfle. */
  balance(b: Book, token: string, status: NoteRec["status"] = "ready") {
    return b.notes.filter((n) => n.status === status && n.token.toLowerCase() === token.toLowerCase()).reduce((a, n) => a + BigInt(n.amount), 0n);
  }
  monBalance() {
    return publicClient.getBalance({ address: this.signer.address });
  }

  // ---- yatırma: yatırma adresine gelen MON → gizli dolar notu

  /** Yatırma adresindeki MON'u (gaz payı hariç) gateway ile gizli dolar notuna çevirir.
   * Yeterli bakiye yoksa `null` döner. */
  async sweepDeposit(info: Info): Promise<{ usd: bigint; mon: bigint } | null> {
    const gw = info.gateway;
    if (!gw) throw new Error("Bu dağıtımda MON yatırma yok");
    const rate = BigInt(gw.usdPerMon);
    const bal = await this.monBalance();
    if (bal === 0n) return null;
    const min = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "minDeposit", args: [info.quoteToken as Hex] });
    const fees = await publicClient.estimateFeesPerGas();
    // Gaz tahmini için en küçük geçerli tutarla simüle et (tutar gaz maliyetini değiştirmez).
    const probeUsd = min;
    const probeValue = (probeUsd * 10n ** 18n + rate - 1n) / rate;
    if (bal <= probeValue) return null;
    const gas = await publicClient.estimateContractGas({
      address: gw.address, abi: gatewayAbi, functionName: "depositNative", args: [1n, probeUsd], value: probeValue, account: this.signer.account as Account,
    });
    const limit = gas + gas / 5n + 10_000n; // Monad gaz LİMİTİNİ ücretlendirir: payı küçük tut
    const reserve = limit * fees.maxFeePerGas;
    if (bal <= reserve) return null;
    const usd = ((bal - reserve) * rate) / 10n ** 18n;
    if (usd < min) return null;
    const value = (usd * 10n ** 18n + rate - 1n) / rate;

    const blinding = randomField();
    const b = this.load();
    this.addNote(b, getAddress(info.quoteToken), usd, blinding, "deposit");
    const act: Activity = { kind: "deposit", time: Date.now(), usd: usd.toString(), mon: value.toString(), status: "pending" };
    b.activity.unshift(act);
    this.save(b); // tx'ten ÖNCE kaydet: sekme kapanırsa not kaybolmasın
    try {
      const hash = await this.signer.client.writeContract({
        address: gw.address, abi: gatewayAbi, functionName: "depositNative", args: [this.h.secretHash(this.owner, blinding), usd],
        value, gas: limit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, account: this.signer.account as Account, chain,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      this.patchActivity(act.time, { tx: hash, status: r.status === "success" ? "done" : "failed" });
      if (r.status !== "success") throw new Error("Yatırma işlemi başarısız");
    } catch (e) {
      this.patchActivity(act.time, { status: "failed" });
      throw e;
    }
    return { usd, mon: value };
  }

  private patchActivity(time: number, patch: Partial<Activity>) {
    const b = this.load();
    const a = b.activity.find((x) => x.time === time);
    if (a) Object.assign(a, patch);
    this.save(b);
  }

  /** YALNIZCA yerel anvil: yatırma adresine test MON'u gönderir. */
  async devFund() {
    if (!config.devChain) throw new Error("Yalnızca yerel zincir");
    const cur = await this.monBalance();
    await publicClient.request({ method: "anvil_setBalance" as never, params: [this.signer.address, `0x${(cur + 100n * 10n ** 18n).toString(16)}`] as never });
  }

  // ---- harcama

  /** `total`'ı hazır notlara en büyükten başlayarak dağıtır (her not ayrı bir kanıt). */
  private allocate(b: Book, token: string, total: bigint) {
    const ready = b.notes
      .filter((n) => n.status === "ready" && n.token.toLowerCase() === token.toLowerCase())
      .sort((a, c) => (BigInt(c.amount) > BigInt(a.amount) ? 1 : -1));
    const out: { note: NoteRec; amount: bigint }[] = [];
    let left = total;
    for (const n of ready) {
      if (left === 0n) break;
      const take = BigInt(n.amount) < left ? BigInt(n.amount) : left;
      out.push({ note: n, amount: take });
      left -= take;
    }
    if (left > 0n) throw new Error("Hazır bakiyeniz bu tutara yetmiyor");
    if (out.length > 8) throw new Error("Tutar çok sayıda küçük nota dağılmış; daha küçük bir tutar deneyin");
    return out;
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

  private async order(p: { info: Info; pool: Pool; side: "buy" | "sell"; total: bigint; pct?: number }, onStep?: (s: string) => void) {
    if (!p.info.enclave.registered) throw new Error("Enclave anahtarı zincirde kayıtlı değil; emir şifrelenmedi");
    const inToken = getAddress(p.side === "buy" ? p.pool.quote.address : p.pool.base.address);
    const parts = this.allocate(this.load(), inToken, p.total);
    onStep?.("Not ağacı doğrulanıyor");
    const tree = await this.tree();
    const group = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    for (const [i, part] of parts.entries()) {
      const tag = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
      const spendR = randomField();
      const spendBlinding = this.h.secretHash(this.owner, spendR);
      onStep?.(`Emir enclave anahtarına şifreleniyor${tag}`);
      const ct = await encryptOrder(hexToBytes(p.info.enclave.publicKey as Hex), config.chainId, config.vault, {
        side: p.side === "buy" ? Side.Buy : Side.Sell,
        poolId: p.pool.poolId,
        amountIn: part.amount,
        recipientPub: this.viewPub,
        spendBlinding,
        owner: this.owner,
      });
      onStep?.(`Sıfır bilgi kanıtı üretiliyor${tag}`);
      const changeBlinding = randomField();
      const proof = await this.prove(tree, part.note, part.amount, spendBlinding, changeBlinding, orderContext(ct));
      onStep?.(`Relayer üzerinden gönderiliyor${tag}`);
      const res = await fetch(`${config.relayerUrl}/v1/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ciphertext: bytesToHex(ct), proof }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Relayer emri reddetti");

      const after = this.load();
      const spent = after.notes.find((n) => n.commitment === part.note.commitment);
      if (spent) spent.status = "spent";
      this.addNote(after, part.note.token, BigInt(part.note.amount) - part.amount, changeBlinding, "change");
      after.orders.unshift({
        orderId: json.orderId, group, poolId: p.pool.poolId, side: p.side, inToken, amountIn: part.amount.toString(),
        pct: p.pct, spendR: spendR.toString(), createdAt: Date.now(), state: "sent",
      });
      this.save(after);
    }
  }

  /** Dolar tutarıyla gizli alım: alınacak token miktarı 7 gün sonra açılır. */
  buy(info: Info, pool: Pool, usd: bigint, onStep?: (s: string) => void) {
    if (usd <= 0n) throw new Error("Tutar girin");
    return this.order({ info, pool, side: "buy", total: usd }, onStep);
  }

  /** Eldeki token'ın yüzdesiyle gizli satış: miktar gösterilmez, gelir 7 gün sonra açılır. */
  sell(info: Info, pool: Pool, pct: number, onStep?: (s: string) => void) {
    if (!(pct > 0 && pct <= 100)) throw new Error("Yüzde 1 ile 100 arasında olmalı");
    const held = this.balance(this.load(), pool.base.address);
    if (held === 0n) throw new Error("Satılabilir token yok (alımın kilidi açılınca satılabilir)");
    const total = pct === 100 ? held : (held * BigInt(Math.round(pct * 100))) / 10_000n;
    if (total === 0n) throw new Error("Seçilen yüzde çok küçük");
    return this.order({ info, pool, side: "sell", total, pct }, onStep);
  }

  // ---- çekim

  /** Gizli dolar bakiyesinden çekim. `asMon`: MON olarak (gateway kutusu üzerinden), yoksa dUSD. */
  async withdraw(info: Info, usd: bigint, to: string, asMon: boolean, onStep?: (s: string) => void) {
    if (!isAddress(to)) throw new Error("Geçerli bir adres girin");
    const dest = getAddress(to);
    const token = getAddress(info.quoteToken);
    if (asMon && !info.gateway) throw new Error("Bu dağıtımda MON çekimi yok");
    const parts = this.allocate(this.load(), token, usd);
    const recipient = asMon
      ? await publicClient.readContract({ address: info.gateway!.address, abi: gatewayAbi, functionName: "boxOf", args: [dest] })
      : dest;
    onStep?.("Not ağacı doğrulanıyor");
    const tree = await this.tree();
    const ctx = await publicClient.readContract({ address: config.vault, abi: vaultAbi, functionName: "withdrawContext", args: [recipient] });
    const act: Activity = { kind: "withdraw", time: Date.now(), usd: usd.toString(), to: dest, status: "pending" };
    const b0 = this.load();
    b0.activity.unshift(act);
    this.save(b0);
    let lastTx: string | undefined;
    const errors: string[] = [];
    for (const [i, part] of parts.entries()) {
      const tag = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
      const spendBlinding = randomField();
      const changeBlinding = randomField();
      onStep?.(`Sıfır bilgi kanıtı üretiliyor${tag}`);
      const proof = await this.prove(tree, part.note, part.amount, spendBlinding, changeBlinding, ctx);
      onStep?.(`Relayer üzerinden gönderiliyor${tag} — gaz ödemezsiniz`);
      const res = await fetch(`${config.relayerUrl}/v1/withdrawals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proof, token, amount: part.amount.toString(), spendBlinding: spendBlinding.toString(), recipient,
          ...(asMon ? { redeemTo: dest } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        this.patchActivity(act.time, { status: "failed", note: json.error });
        throw new Error(json.error ?? "Relayer çekimi reddetti");
      }
      lastTx = json.redeemTxHash ?? json.txHash;
      if (json.redeemError) errors.push(json.redeemError);
      const after = this.load();
      const x = after.notes.find((y) => y.commitment === part.note.commitment);
      if (x) x.status = "spent";
      this.addNote(after, part.note.token, BigInt(part.note.amount) - part.amount, changeBlinding, "change");
      this.save(after);
    }
    const rate = info.gateway ? BigInt(info.gateway.usdPerMon) : 0n;
    this.patchActivity(act.time, {
      status: errors.length ? "failed" : "done",
      tx: lastTx,
      mon: asMon && rate ? ((usd * 10n ** 18n) / rate).toString() : undefined,
      note: errors.length ? "dUSD çekim kutusunda; MON ödemesi yeniden denenebilir" : undefined,
    });
    if (errors.length) throw new Error("dUSD çekildi ama MON ödemesi yapılamadı (gateway likiditesi). Fonlar kutuda güvende.");
  }

  // ---- proje sahibi

  /** Projenin haber imzacısı bu hesapsa imzalı haber yayınlar. */
  async postNews(poolId: number, title: string, body: string, url: string) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await this.signer.client.signMessage({ account: this.signer.account as Account, message: newsMessage(poolId, timestamp, title, body, url) });
    const res = await fetch(`${config.relayerUrl}/v1/news`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poolId, title, body, url, timestamp, signature }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Haber reddedildi");
  }

  /** Yeni proje: token basar, MON'la başlangıç likiditesi koyar, gizli havuzu açar, meta veriyi kaydeder.
   * MON yatırma adresinden (açık bakiye) harcanır. */
  async launch(
    info: Info,
    p: { name: string; symbol: string; supply: bigint; liquidityBase: bigint; mon: bigint; metadata: string },
    onStep?: (s: string) => void,
  ): Promise<number> {
    if (!info.launchpad) throw new Error("Bu dağıtımda proje açılışı yok");
    const hash32 = keccak256(toBytes(p.metadata));
    onStep?.("Token basılıyor ve gizli havuz açılıyor");
    const act: Activity = { kind: "launch", time: Date.now(), usd: "0", mon: p.mon.toString(), status: "pending" };
    const b = this.load();
    b.activity.unshift(act);
    this.save(b);
    const tx = await this.signer.client.writeContract({
      address: info.launchpad, abi: launchpadAbi, functionName: "launch",
      args: [p.name, p.symbol, p.supply, p.liquidityBase, hash32], value: p.mon, account: this.signer.account as Account, chain,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") {
      this.patchActivity(act.time, { status: "failed", tx });
      throw new Error("Proje açılışı başarısız");
    }
    let poolId = 0;
    let quote = 0n;
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: launchpadAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Launched") {
          poolId = ev.args.poolId;
          quote = ev.args.liquidityQuote;
        }
      } catch {}
    }
    if (!poolId) throw new Error("Launched olayı bulunamadı");
    this.patchActivity(act.time, { status: "done", tx, poolId, usd: quote.toString() });
    onStep?.("Proje bilgileri kaydediliyor");
    // Relayer havuzu finalized blokta görür; birkaç kez dene.
    for (let i = 0; ; i++) {
      const res = await fetch(`${config.relayerUrl}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poolId, metadata: p.metadata }),
      });
      if (res.ok) break;
      if (i >= 10) throw new Error(`Meta veri kaydedilemedi: ${(await res.json()).error ?? res.status}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    return poolId;
  }
}

// ---------------------------------------------------------------- portföy

export type Position = {
  poolId: number;
  /** Alımlara harcanan dolar (6 ondalık) */
  invested: bigint;
  /** Kilidi açılmış alımlardan gelen token */
  received: bigint;
  /** Kilitli alım sayısı ve en yakın açılış */
  lockedBuys: number;
  nextBuyUnlock?: number;
  /** Satılan token (bilinen) ve kilitli satışlar */
  sold: bigint;
  lockedSells: number;
  nextSellUnlock?: number;
  /** Açılmış satışlardan gelen dolar */
  proceeds: bigint;
  /** Şu an elde tutulan (harcanabilir) token */
  held: bigint;
};

export function positions(w: ShieldedWallet, b: Book, pools: Pool[]): Position[] {
  const out: Position[] = [];
  for (const pool of pools) {
    const os = b.orders.filter((o) => o.poolId === pool.poolId && o.state !== "refunded");
    if (!os.length && w.balance(b, pool.base.address) === 0n) continue;
    const buys = os.filter((o) => o.side === "buy");
    const sells = os.filter((o) => o.side === "sell");
    const lockedB = buys.filter((o) => o.state !== "revealed");
    const lockedS = sells.filter((o) => o.state !== "revealed");
    const minUnlock = (xs: OrderRec[]) => xs.map((o) => o.unlockTime).filter((t): t is number => !!t).sort((a, c) => a - c)[0];
    const sum = (xs: OrderRec[], f: (o: OrderRec) => string | undefined) => xs.reduce((a, o) => a + BigInt(f(o) ?? "0"), 0n);
    out.push({
      poolId: pool.poolId,
      invested: sum(buys, (o) => o.amountIn),
      received: sum(buys.filter((o) => o.state === "revealed"), (o) => o.result?.amountOut),
      lockedBuys: new Set(lockedB.map((o) => o.group)).size,
      nextBuyUnlock: minUnlock(lockedB),
      sold: sum(sells, (o) => o.amountIn),
      lockedSells: new Set(lockedS.map((o) => o.group)).size,
      nextSellUnlock: minUnlock(lockedS),
      proceeds: sum(sells.filter((o) => o.state === "revealed"), (o) => o.result?.amountOut),
      held: w.balance(b, pool.base.address),
    });
  }
  return out;
}

export const toRaw = (v: string, decimals: number): bigint => {
  const [i, f = ""] = v.trim().replace(/\./g, "").replace(",", ".").split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error("Geçersiz tutar");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
};

// ---------------------------------------------------------------- tarayıcı cüzdanı (isteğe bağlı giriş)

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type RpcError = { code?: number; message?: string; data?: { originalError?: { code?: number } } };

/** EIP-6963: birden çok cüzdan eklentisi `window.ethereum` için yarışır; MetaMask'ı açıkça seç. */
function discoverProvider(): Promise<Eip1193 | undefined> {
  return new Promise((resolve) => {
    const found: { rdns: string; provider: Eip1193 }[] = [];
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: { rdns: string }; provider: Eip1193 }>).detail;
      if (d?.provider) found.push({ rdns: d.info?.rdns ?? "", provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const pick = found.find((f) => f.rdns === "io.metamask") ?? found[0];
      resolve(pick?.provider ?? (globalThis as { ethereum?: Eip1193 }).ethereum);
    }, 300);
  });
}

const rpcCode = (e: unknown) => (e as RpcError)?.data?.originalError?.code ?? (e as RpcError)?.code;

/** Cüzdanı doğru ağa getirir. Ağ eklemeyi YALNIZCA cüzdan "tanımıyorum" (4902) derse dener;
 * reddi yutup ardından ikinci bir onay penceresi açmak MetaMask arayüzünü çökertebiliyor. */
async function ensureChain(eth: Eip1193) {
  const hexId = `0x${chain.id.toString(16)}`;
  if (Number(await eth.request({ method: "eth_chainId" })) === chain.id) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (rpcCode(e) === 4001) throw new Error("Ağ değişikliği reddedildi.");
    if (rpcCode(e) !== 4902) throw new Error(`Cüzdan ağ değiştiremedi: ${(e as RpcError).message ?? e}`);
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hexId,
        chainName: config.chainName,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [config.rpcUrl],
        ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}),
      }],
    });
  }
}

export async function injectedSigner(): Promise<Signer> {
  const eth = await discoverProvider();
  if (!eth) throw new Error("Tarayıcı cüzdanı bulunamadı. MetaMask kurun ya da açın.");
  let accounts: string[];
  try {
    accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  } catch (e) {
    if (rpcCode(e) === -32002) throw new Error("MetaMask'ta bekleyen bir istek var: eklentiyi açıp onu tamamlayın.");
    if (rpcCode(e) === 4001) throw new Error("Bağlantı reddedildi.");
    throw e;
  }
  if (!accounts?.length) throw new Error("Cüzdanda hesap yok.");
  await ensureChain(eth);
  // Cüzdandaki ağ aynı chainId'ye sahip ama farklı bir RPC'ye (ör. hazır "Localhost 8545") bağlı
  // olabilir: o zaman işlemler başka bir zincire gider. Vault kodunu cüzdanın kendi RPC'sinden oku.
  const code = (await eth.request({ method: "eth_getCode", params: [config.vault, "latest"] })) as string;
  if (!code || code === "0x")
    throw new Error(`Cüzdandaki ${chain.id} ağı farklı bir RPC'ye bağlı. MetaMask ağ ayarlarında RPC adresini ${config.rpcUrl} yapın.`);
  const address = getAddress(accounts[0]);
  const client = createWalletClient({ chain, transport: custom(eth), account: address });
  return { address, account: address, client };
}

