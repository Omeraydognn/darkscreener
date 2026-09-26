// Yerel geliştirme verisi (scripts/dev-stack.sh çalıştırır): zamanı 16 gün geriye alınmış anvil
// zincirinde, gün gün gerçek gizli emirler (gerçek ECIES + Groth16) gönderir. Enclave saati
// zincirden okur; kilitler zincir zamanı + 7 gündür. drand gerçek zamanlı yayınladığı için
// ilk ~9 günün batch'leri GERÇEK drand imzalarıyla açılır, son 7 gün kilitli kalır —
// ghost chart tam da ürünün göstereceği şekilde oluşur.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, bytesToHex, defineChain, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { noteHelpers, Tree, proveSpend, randomField, shutdown } from "../../circuits/lib/note.mjs";
import { secp256k1 } from "../src/ecies.mjs";
import { encryptOrder, orderContext, Side } from "../src/order.mjs";
import { RelayerClient, proofForRelayer } from "../src/relayer.mjs";
import { message as newsMessage } from "../src/news.mjs";

const RPC = process.env.RPC_URL;
const relayer = new RelayerClient(process.env.RELAYER_URL);
const deploy = JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8"));
const setup = JSON.parse(readFileSync(process.env.SETUP, "utf8"));
const keys = JSON.parse(readFileSync(process.env.KEYS, "utf8"));
const DAYS = Number(process.env.DAYS ?? 16);
const ROUNDS_PER_DAY = Number(process.env.ROUNDS_PER_DAY ?? 2);

const chain = defineChain({
  id: deploy.chainId,
  name: "dev",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const VAULT = getAddress(deploy.vault);
const USDC = getAddress(deploy.quoteToken);
const BASES = setup.baseTokens.map((a) => getAddress(a));
const E6 = 1_000_000n;
const E18 = 10n ** 18n;

const vaultAbi = parseAbi([
  "function deposit(address token, uint128 amount, uint256 secretHash)",
  "function noteRoot() view returns (uint256)",
  "function orders(bytes32) view returns (uint64 window, bool done, uint256 spendCommitment)",
  "function lastSettledWindow() view returns (uint64)",
]);
const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const gatewayAbi = parseAbi([
  "function depositNative(uint256 secretHash, uint128 expected) payable",
  "function usdPerMon() view returns (uint256)",
]);
const GATEWAY = getAddress(deploy.gateway);
const deployer = privateKeyToAccount(keys.deployer);

// Proje eğilimleri: alım olasılığı günlere göre (0..1)
const BIAS = [
  (d) => 0.72 - 0.15 * Math.sin(d / 3), // Nebula: güçlü talep
  (d) => 0.5 + 0.25 * Math.sin(d / 1.7), // Orbit: dalgalı
  (d) => 0.32 + 0.1 * Math.cos(d / 2), // Vela: satış baskısı
  (d) => 0.5 + 0.04 * Math.sin(d / 2.5), // ArfDAO: dengeli, ~0.22 $ (~10 TL) civarında yatay
];
// Havuz başına emir büyüklüğü (alım $ aralığı, satış binde aralığı)
const SIZE = [
  [300, 6000, 5, 40],
  [300, 6000, 5, 40],
  [300, 6000, 5, 40],
  [100, 1500, 2, 10],
];
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeoutMs = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(700);
  }
}

async function tx(account, address, abi, functionName, args) {
  const w = createWalletClient({ chain, transport: http(RPC), account });
  const hash = await w.writeContract({ address, abi, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

async function syncTree(h) {
  return until("relayer ağacı zincirle eşitler", async () => {
    const leaves = await relayer.notes();
    const tree = new Tree(h.H);
    for (const l of leaves) tree.insert(l);
    const root = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "noteRoot" });
    return tree.root() === root ? { tree, leaves } : null;
  });
}

async function main() {
  const h = await noteHelpers();
  const info = await relayer.info();
  console.log(`seed: ${DAYS} gün × ${ROUNDS_PER_DAY} tur, enclave ${info.enclave.address}`);

  // ---- traderlar: her token için büyük bir not yatırır
  const traders = keys.traders.map((k) => {
    const spendKey = randomField();
    return {
      account: privateKeyToAccount(k),
      spendKey,
      owner: h.owner(spendKey),
      view: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
      notes: {}, // token -> {token, amount, spendKey, blinding, commitment}
    };
  });
  const deposits = [
    [USDC, 400_000n * E6],
    [BASES[0], 150_000n * E18],
    [BASES[1], 40_000n * E18],
    [BASES[2], 2_000_000n * E18],
    [BASES[3], 1_000_000n * E18],
  ];
  const rate = await pub.readContract({ address: GATEWAY, abi: gatewayAbi, functionName: "usdPerMon" });
  for (const t of traders) {
    // Nakit: MON → gateway → gizli dolar notu (uygulamadaki yatırma yolu). Proje token'ları:
    // sabit arzlı; hazineden (yayıncı) dağıtılır ve doğrudan vault'a yatırılır.
    await pub.request({ method: "anvil_setBalance", params: [t.account.address, "0xD3C21BCECCEDA1000000"] });
    for (const [token, amount] of deposits) {
      const blinding = randomField();
      const secret = h.secretHash(t.owner, blinding);
      if (token === USDC) {
        const w = createWalletClient({ chain, transport: http(RPC), account: t.account });
        const hash = await w.writeContract({ address: GATEWAY, abi: gatewayAbi, functionName: "depositNative", args: [secret, amount], value: (amount * E18) / rate });
        if ((await pub.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("depositNative reverted");
      } else {
        await tx(deployer, token, erc20Abi, "transfer", [t.account.address, amount]);
        await tx(t.account, token, erc20Abi, "approve", [VAULT, amount]);
        await tx(t.account, VAULT, vaultAbi, "deposit", [token, amount, secret]);
      }
      t.notes[token] = { token: BigInt(token), amount, spendKey: t.spendKey, blinding, commitment: h.commitment(BigInt(token), amount, secret) };
    }
  }
  console.log(`  ${traders.length} trader, ${traders.length * deposits.length} not yatırıldı`);

  const roundSeconds = Math.floor(86_400 / ROUNDS_PER_DAY);
  for (let day = 0; day < DAYS; day++) {
    for (let round = 0; round < ROUNDS_PER_DAY; round++) {
      const { tree, leaves } = await syncTree(h);
      const orderIds = [];
      // Her turda her trader en fazla bir emir (aynı notu iki kez harcamasın)
      for (const t of traders) {
        if (Math.random() < 0.3) continue;
        const pool = Math.floor(Math.random() * BASES.length);
        const buy = Math.random() < BIAS[pool](day + round / ROUNDS_PER_DAY);
        const inToken = buy ? USDC : BASES[pool];
        const note = t.notes[inToken];
        note.leafIndex = leaves.indexOf(note.commitment);
        if (note.leafIndex < 0) throw new Error("note not in tree");
        const [bMin, bMax, sMin, sMax] = SIZE[pool];
        const amount = buy
          ? BigInt(Math.floor(rand(bMin, bMax))) * E6
          : (note.amount * BigInt(Math.floor(rand(sMin, sMax)))) / 1000n;
        if (amount === 0n || amount > note.amount) continue;

        const spendBlinding = h.secretHash(t.owner, randomField());
        const ct = await encryptOrder(info.enclavePub, deploy.chainId, VAULT, {
          side: buy ? Side.Buy : Side.Sell,
          poolId: pool + 1,
          amountIn: amount,
          recipientPub: t.view,
          spendBlinding,
          owner: t.owner,
        });
        const changeBlinding = randomField();
        const p = await proveSpend(h, tree, note, { amount, blinding: spendBlinding }, changeBlinding, orderContext(ct));
        const res = await relayer.submitOrder(bytesToHex(ct), proofForRelayer(p));
        orderIds.push(res.orderId);
        const change = note.amount - amount;
        const secret = h.secretHash(t.owner, changeBlinding);
        t.notes[inToken] = { token: note.token, amount: change, spendKey: t.spendKey, blinding: changeBlinding, commitment: h.commitment(note.token, change, secret) };
      }

      // Pencere kapanıp settle edilene kadar bekle, sonra zamanı bir sonraki tura al.
      if (orderIds.length) {
        await until("settlement", async () => {
          const last = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "lastSettledWindow" });
          for (const id of orderIds) {
            const [w] = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "orders", args: [id] });
            if (w > last) return false;
          }
          return true;
        });
      }
      const block = await pub.getBlock();
      const jump = roundSeconds - Number(block.timestamp % BigInt(roundSeconds)) + Math.floor(rand(60, 3600));
      await pub.request({ method: "evm_increaseTime", params: [jump] });
      await pub.request({ method: "evm_mine", params: [] });
      process.stdout.write(`  gün ${day + 1}/${DAYS} tur ${round + 1}: ${orderIds.length} emir\n`);
    }
  }

  // ---- imzalı proje haberleri (gerçek zaman damgasıyla; relayer ±10 dk kabul eder)
  const ARF = "https://arfdao.dev";
  const NEWS = [
    [1, "Mainnet beta başvuruları açıldı", "İlk 500 GPU sağlayıcısı için beta kayıtları başladı. Denetim raporu yayında."],
    [1, "Denetim tamamlandı", "Bağımsız güvenlik denetimi kritik bulgu olmadan kapandı; rapor web sitesinde."],
    [2, "Köprü bakımı", "Relay köprüsü 2 saatlik planlı bakıma giriyor; fonlar güvende."],
    [2, "Yeni ağ ortaklığı", "İki yeni L2 ile mesaj taşıma entegrasyonu testnet'te canlı."],
    [3, "Depolama fiyatlandırması güncellendi", "Sağlayıcı ödüllerinde yeniden düzenleme: detaylar yönetişim forumunda."],
    [4, "ArfDAO: Singapur'da disiplinlerarası geliştirici topluluğu", "ArfDAO, farklı disiplinlerden geliştiricileri bir araya getiren topluluğuyla Singapur'da. Topluluk projeleri ve katılım bilgileri arfdao.dev üzerinde.", ARF],
    [4, "ArfHE Wallet canlıya alındı", "ArfDAO'nun geliştirdiği ArfHE Wallet projesi canlıya alındı. Ayrıntılar ve kullanım rehberi arfdao.dev üzerinde.", ARF],
  ];
  for (const [poolId, title, body, url = ""] of NEWS) {
    const signer = privateKeyToAccount(keys.newsSigners[poolId - 1]);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await signer.signMessage({ message: newsMessage(poolId, ts, title, body, url) });
    await fetch(`${process.env.RELAYER_URL}/v1/news`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poolId, title, body, url, timestamp: ts, signature }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`news: ${r.status} ${await r.text()}`);
    });
  }
  console.log(`  ${NEWS.length} imzalı haber yayınlandı`);
  console.log("SEED TAMAM");
}

main()
  .then(shutdown)
  .catch(async (e) => {
    console.error(e);
    await shutdown();
    process.exit(1);
  });
