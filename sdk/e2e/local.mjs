// Yerel uçtan uca senaryo (scripts/e2e-local.sh çalıştırır): gerçek anvil zinciri, gerçek
// enclave sunucusu, gerçek relayer. Bu script bir KULLANICI gibi davranır ve yalnızca SDK +
// relayer API'sini kullanır.
//
//  1. 1000 USDC ve 5 USDC yatır (iki gizli not)
//  2. 250 USDC ile A tokenı al: emri JS'te enclave anahtarına şifrele, ZK kanıtı üret,
//     RELAYER üzerinden gönder (zincirde gönderen relayer; kullanıcı adresi görünmez)
//  3. 5 USDC'lik notla bozuk bir emir gönder -> enclave çözemez -> Refunded
//  4. Relayer batch'i settle eder; iadeyi hemen ağaca alır, alım 7 gün kilitli kalır
//  5. Kilitli lot satışı (miktar bilinmeden yüzdeyle): yanlış yetkili satış reddedilir ve lot
//     serbest kalır; %50 satılır (gelir + kalan lot); kalan lot %100 satılır
//  6. Kilit açılınca relayer satış gelirlerini ve kalan lotu ağaca alır; satılan lotlar not eklemez
//  7. Para üstü (750) ve iade (5) notlarını bakiyesi SIFIR olan yeni adreslere relayer ile çek

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  bytesToHex,
  hexToBytes,
  defineChain,
  getAddress,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { noteHelpers, Tree, proveSpend, randomField, shutdown } from "../../circuits/lib/note.mjs";
import { secp256k1 } from "../src/ecies.mjs";
import { encryptOrder, encryptLotSell, orderContext, Side, CIPHERTEXT_LEN, LOT_MEMO_LEN, SEALED_RESULT_LEN } from "../src/order.mjs";
import { RelayerClient, proofForRelayer } from "../src/relayer.mjs";

const RPC = process.env.RPC_URL;
const relayer = new RelayerClient(process.env.RELAYER_URL);
const deploy = JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8"));
const setup = JSON.parse(readFileSync(process.env.SETUP, "utf8"));
const user = privateKeyToAccount(process.env.USER_KEY);

const chain = defineChain({
  id: deploy.chainId,
  name: "local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account: user });

const vaultAbi = parseAbi([
  "function deposit(address token, uint128 amount, uint256 secretHash)",
  "function noteRoot() view returns (uint256)",
  "function orders(bytes32) view returns (uint64 window, bool done, uint256 spendCommitment)",
  "function withdrawContext(address) view returns (uint256)",
  "function lotState(bytes32) view returns (uint8)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const gatewayAbi = parseAbi([
  "function depositNative(uint256 secretHash, uint128 expected) payable",
  "function usdPerMon() view returns (uint256)",
  "function boxOf(address) view returns (address)",
]);
const GATEWAY = getAddress(deploy.gateway);
const VAULT = getAddress(deploy.vault);
const USDC = getAddress(deploy.quoteToken);
const E6 = 1_000_000n;

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
async function until(what, fn, timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 120_000)) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function send(fn, args, address, abi = vaultAbi) {
  const hash = await wallet.writeContract({ address, abi, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert(r.status === "success", `${fn} reverted`);
  return r;
}

async function syncTree(h) {
  const leaves = await relayer.notes();
  const tree = new Tree(h.H);
  for (const l of leaves) tree.insert(l);
  const onchain = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "noteRoot" });
  return { tree, leaves, fresh: tree.root() === onchain };
}

async function main() {
  const h = await noteHelpers();

  step("relayer + enclave bilgisi");
  const info = await relayer.info(); // kayıtlı değilse hata fırlatır
  ok(`enclave ${info.enclave.address} registry'de kayıtlı, relayer ${info.relayer}`);

  step("kullanıcı kimliği (spendKey, ECIES görüntüleme anahtarı)");
  const spendKey = randomField();
  const owner = h.owner(spendKey);
  const viewSk = secp256k1.utils.randomSecretKey();
  const viewPub = secp256k1.getPublicKey(viewSk, true);
  ok("oluşturuldu (yalnızca bu süreçte)");

  step("MON gönder → gizli dolar notu: 1000 $ ve 5 $ (gateway, demo kuru)");
  const notes = [
    { token: BigInt(USDC), amount: 1000n * E6, spendKey, blinding: randomField() },
    { token: BigInt(USDC), amount: 5n * E6, spendKey, blinding: randomField() },
  ];
  const rate = await pub.readContract({ address: GATEWAY, abi: gatewayAbi, functionName: "usdPerMon" });
  for (const n of notes) {
    n.commitment = h.commitment(n.token, n.amount, h.secretHash(owner, n.blinding));
    const value = (n.amount * 10n ** 18n) / rate;
    const hash = await wallet.writeContract({ address: GATEWAY, abi: gatewayAbi, functionName: "depositNative", args: [h.secretHash(owner, n.blinding), n.amount], value });
    assert((await pub.waitForTransactionReceipt({ hash })).status === "success", "depositNative reverted");
  }
  let t = await until("relayer notları indeksler", async () => {
    const s = await syncTree(h);
    return s.fresh && s.leaves.includes(notes[1].commitment) ? s : null;
  });
  for (const n of notes) n.leafIndex = t.leaves.indexOf(n.commitment);
  ok(`ağaç kökü zincirle aynı, notlar ${notes.map((n) => n.leafIndex)} indekslerinde`);

  step("gizli emir: 250 USDC ile havuz 1'den A tokenı al");
  const buy = { amount: 250n * E6, r: randomField(), changeBlinding: randomField() };
  buy.spendBlinding = h.secretHash(owner, buy.r);
  const ct = await encryptOrder(info.enclavePub, deploy.chainId, VAULT, {
    side: Side.Buy,
    poolId: 1,
    amountIn: buy.amount,
    recipientPub: viewPub,
    spendBlinding: buy.spendBlinding,
    owner,
  });
  const buyProof = await proveSpend(h, t.tree, notes[0], { amount: buy.amount, blinding: buy.spendBlinding }, buy.changeBlinding, orderContext(ct));
  const sentBuy = await relayer.submitOrder(bytesToHex(ct), proofForRelayer(buyProof));
  const tx = await pub.getTransaction({ hash: sentBuy.txHash });
  assert(getAddress(tx.from) === getAddress(info.relayer), "order must be sent by relayer");
  assert(getAddress(tx.from) !== getAddress(user.address), "user address must not appear");
  ok(`emir ${sentBuy.orderId.slice(0, 10)}… gönderildi; zincirdeki gönderen = relayer (kullanıcı değil)`);

  step("bozuk emir: 5 USDC'lik notun tamamı, çözülemeyen ciphertext");
  const bad = { amount: 5n * E6, r: randomField(), changeBlinding: randomField() };
  bad.spendBlinding = h.secretHash(owner, bad.r);
  const garbage = randomBytes(CIPHERTEXT_LEN);
  garbage[0] = 0x01;
  const badProof = await proveSpend(h, t.tree, notes[1], { amount: bad.amount, blinding: bad.spendBlinding }, bad.changeBlinding, orderContext(garbage));
  const sentBad = await relayer.submitOrder(bytesToHex(garbage), proofForRelayer(badProof));
  ok(`emir ${sentBad.orderId.slice(0, 10)}… gönderildi`);

  step("relayer pencere kapanınca settle eder");
  // İki emir farklı pencerelere düşebilir: her birinin sonucunu ayrı bekle.
  const settledOrder = (id) =>
    until(`settlement of ${id.slice(0, 10)}`, async () => {
      const s = await relayer.order(id).catch(() => null);
      return s?.batchId ? s : null;
    });
  const settled = { buy: await settledOrder(sentBuy.orderId), bad: await settledOrder(sentBad.orderId) };
  assert(settled.buy.status === 1 && settled.bad.status === 2, "statuses");
  ok(`batch #${settled.buy.batchId}: alım Filled, bozuk emir Refunded (batch #${settled.bad.batchId}); kilit açılışı unix ${settled.buy.unlockTime}`);

  const orderDone = async (id) =>
    (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "orders", args: [id] }))[1];
  await until("relayer iadeyi ağaca alır", () => orderDone(sentBad.orderId));
  ok("iade: harcanan 5 USDC not olarak ağaca döndü (açılış yok, kullanıcı işlem yapmadı)");
  assert(!(await orderDone(sentBuy.orderId)), "result must stay locked for 7 days");
  ok("sonuç notu 7 gün kilitli");

  assert(hexToBytes(settled.buy.sealedResult).length === SEALED_RESULT_LEN + LOT_MEMO_LEN, "buy result carries the enclave lot memo");

  // ---------------------------------------------------------------- kilitli lot satışı
  const lotState = (id) => pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "lotState", args: [id] });
  const lotSell = async (lot, pctBps, auth) => {
    const ct = await encryptLotSell(info.enclavePub, deploy.chainId, VAULT, { poolId: 1, pctBps, lotOrderId: lot, auth });
    const res = await relayer.submitLotSell(bytesToHex(ct), lot);
    const tx = await pub.getTransaction({ hash: res.txHash });
    assert(getAddress(tx.from) === getAddress(info.relayer), "lot sell must be sent by relayer");
    return res.orderId;
  };

  step("kilitli lot satışı: yanlış yetki (başkası lotu satmaya çalışır) -> reddedilir, lot serbest kalır");
  const forged = await lotSell(sentBuy.orderId, 10_000, randomField());
  assert((await lotState(sentBuy.orderId)) === 1, "lot must be pending while the sale waits");
  const malformed = await relayer.submitLotSell("0x01", sentBuy.orderId).then(() => null, (e) => e);
  assert(malformed && /400/.test(malformed.message), "relayer rejects malformed lot sell");
  let dup = null;
  try {
    await lotSell(sentBuy.orderId, 5_000, buy.spendBlinding);
  } catch (e) {
    dup = e;
  }
  assert(dup && /LotUnavailable/.test(dup.message), `pending lot must not be sold twice (${dup?.message})`);
  const forgedRes = await settledOrder(forged);
  assert(forgedRes.status === 2 && forgedRes.lot?.toLowerCase() === sentBuy.orderId.toLowerCase(), "forged sale refunded");
  assert(forgedRes.lotUpdate && forgedRes.lotUpdate.filled === false, "forged sale not filled");
  assert((await lotState(sentBuy.orderId)) === 0, "lot freed after rejected sale");
  ok(`sahte satış ${forged.slice(0, 10)}… reddedildi; lot yeniden serbest (not harcanmadı, iade yok)`);

  step("kilitli lot satışı: alımın %50'si (kullanıcı miktarı bilmiyor, enclave lot notundan okur)");
  const sell1 = await lotSell(sentBuy.orderId, 5_000, buy.spendBlinding);
  const s1 = await settledOrder(sell1);
  assert(s1.status === 1, "sale filled");
  assert(s1.lotUpdate?.filled && BigInt(s1.lotUpdate.remainderCommitment) !== 0n, "remainder note issued");
  assert(hexToBytes(s1.sealedResult).length === SEALED_RESULT_LEN + LOT_MEMO_LEN, "sale result carries the remainder's lot memo");
  assert((await lotState(sentBuy.orderId)) === 2, "sold lot consumed");
  const buyStatus = await relayer.order(sentBuy.orderId);
  assert(buyStatus.lotSales.map((x) => x.state).join() === "rejected,sold", `lot sales: ${JSON.stringify(buyStatus.lotSales)}`);
  ok(`satış ${sell1.slice(0, 10)}… batch #${s1.batchId}: gelir notu + kalan lot notu (${s1.lotUpdate.remainderCommitment.slice(0, 10)}…)`);

  step("kalan lot: satış emrinin sonucu yeniden satılabilir (%100)");
  const sell2 = await lotSell(sell1, 10_000, buy.spendBlinding);
  const s2 = await settledOrder(sell2);
  assert(s2.status === 1 && s2.lotUpdate?.filled, "remainder sale filled");
  assert((await lotState(sell1)) === 2, "remainder lot consumed");
  ok(`kalan lot ${sell2.slice(0, 10)}… ile satıldı (satılan oran dışarıdan anlaşılmaz: kalan not %100'de de üretilir)`);

  step("zamanı 8 gün ileri al (anvil) -> relayer sonuçları otomatik alır");
  await pub.request({ method: "evm_increaseTime", params: [8 * 24 * 3600] });
  await pub.request({ method: "evm_mine", params: [] });
  await until("claimNote (satışlar)", async () => (await orderDone(sell1)) && (await orderDone(sell2)));
  // İndexer yalnızca kesinleşmiş blokları okur: ağaç zincirle aynı olana kadar bekle.
  const synced = await until("ağaç güncel", async () => {
    const s = await syncTree(h);
    return s.fresh ? s : null;
  });
  const leaves = new Set(synced.leaves.map((c) => c.toString()));
  const has = (c) => leaves.has(BigInt(c).toString());
  assert(has(s1.commitment) && has(s2.commitment), "sale proceeds in tree");
  assert(has(s2.lotUpdate.remainderCommitment), "last remainder in tree");
  assert(!has(s1.lotUpdate.remainderCommitment), "sold remainder must not enter the tree");
  assert(!has(settled.buy.commitment), "sold buy lot must not enter the tree");
  assert(!(await orderDone(sentBuy.orderId)), "relayer skips claiming a consumed lot (no gas spent)");
  ok("satış gelirleri ve son kalan lot ağaçta; satılan lotlar ağaca not eklemedi (miktarlar zincirde görünmüyor)");

  step("para üstü (750) ve iade (5) notlarını gazsız, yeni adreslere çek");
  t = await until("ağaç güncel", async () => {
    const s = await syncTree(h);
    return s.fresh ? s : null;
  });
  const change = {
    token: BigInt(USDC),
    amount: notes[0].amount - buy.amount,
    spendKey,
    blinding: buy.changeBlinding,
  };
  const returned = { token: BigInt(USDC), amount: bad.amount, spendKey, blinding: bad.r };
  for (const [name, n, asMon] of [["para üstü (MON olarak)", change, true], ["iade (dUSD olarak)", returned, false]]) {
    n.leafIndex = t.leaves.indexOf(h.commitment(n.token, n.amount, h.secretHash(owner, n.blinding)));
    assert(n.leafIndex >= 0, `${name} note not in tree`);
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const recipient = asMon ? await pub.readContract({ address: GATEWAY, abi: gatewayAbi, functionName: "boxOf", args: [to] }) : to;
    const ctx = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawContext", args: [recipient] });
    const sb = randomField();
    const p = await proveSpend(h, t.tree, n, { amount: n.amount, blinding: sb }, randomField(), ctx);
    const res = await relayer.withdraw(proofForRelayer(p), USDC, n.amount, sb, recipient, asMon ? to : undefined);
    const eth = await pub.getBalance({ address: to });
    if (asMon) {
      assert(res.redeemTxHash && !res.redeemError, `redeem failed: ${res.redeemError}`);
      assert(eth === (n.amount * 10n ** 18n) / rate, `${name} MON amount`);
      ok(`${name}: ${Number(n.amount) / 1e6} $ -> ${Number(eth) / 1e18} MON @ ${to.slice(0, 10)}… (gazı relayer ödedi)`);
    } else {
      const bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [to] });
      assert(bal === n.amount, `${name} balance`);
      assert(eth === 0n, "recipient paid no gas");
      ok(`${name}: ${Number(n.amount) / 1e6} dUSD -> ${to.slice(0, 10)}… (ETH bakiyesi 0)`);
    }
  }

  console.log("\nUÇTAN UCA TEST GEÇTİ");
}

main()
  .then(shutdown)
  .catch(async (e) => {
    console.error(e);
    await shutdown();
    process.exit(1);
  });
