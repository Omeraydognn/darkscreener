// Emir v2 / kilitli lot satışı v3 kodlaması ve sonuç çözümü — tee-core/src/order.rs ve reveal.rs ile aynı.

import { hexToBytes, bytesToHex, keccak256 } from "viem";
import { encrypt, decrypt, openWithBatchKey } from "./ecies.mjs";

export const ORDER_LEN = 128;
export const CIPHERTEXT_LEN = 1 + 33 + 12 + ORDER_LEN + 16;
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const Side = { Buy: 0, Sell: 1 };
/** reveal.rs: sonuç = nonce(12) || ECIES(112 bayt) || tag(16) */
export const SEALED_RESULT_LEN = 12 + 62 + 112 + 16;
/** reveal.rs `LOT_MEMO_LEN`: dolu sonuçların sonuna eklenen, yalnızca enclave'in açabildiği lot notu */
export const LOT_MEMO_LEN = 12 + 117 + 16;

function be(n, len) {
  const out = new Uint8Array(len);
  let v = BigInt(n);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("value does not fit");
  return out;
}

function toBig(bytes) {
  return BigInt(bytesToHex(bytes));
}

/**
 * @param o {side, poolId, amountIn, recipientPub(33), spendBlinding, owner}
 *   spendBlinding = secretHash(owner, r): harcanan kısım kullanıcıya ait bir not olur.
 */
export function encodeOrder(o) {
  const out = new Uint8Array(ORDER_LEN);
  out[0] = 2;
  out[1] = o.side;
  out.set(be(o.poolId, 4), 2);
  out.set(be(o.amountIn, 16), 6);
  if (o.recipientPub.length !== 33) throw new Error("recipientPub must be compressed (33 bytes)");
  out.set(o.recipientPub, 22);
  out.set(be(o.spendBlinding, 32), 55);
  out.set(be(o.owner, 32), 87);
  return out;
}

/** "darkpool/order/v2" || 24 sıfır || chainId (u64 BE) || vault */
export function orderAad(chainId, vault) {
  const tag = new TextEncoder().encode("darkpool/order/v2");
  const out = new Uint8Array(tag.length + 32 + 20);
  out.set(tag, 0);
  out.set(be(chainId, 8), tag.length + 24);
  out.set(hexToBytes(vault), tag.length + 32);
  return out;
}

export async function encryptOrder(enclavePub, chainId, vault, order) {
  const ct = await encrypt(enclavePub, encodeOrder(order), orderAad(chainId, vault));
  if (ct.length !== CIPHERTEXT_LEN) throw new Error("unexpected ciphertext length");
  return ct;
}

/**
 * Kanıtın bağlandığı bağlam (kontrat ile aynı): keccak256(ciphertext) mod p; lot anahtarıyla
 * gönderilen emirde keccak256(ciphertext || lotKeyHash) mod p (kopyalayan anahtarı değiştiremez).
 */
export function orderContext(ciphertext, lotKeyHash) {
  const pre = lotKeyHash ? concatBytes(ciphertext, hexToBytes(lotKeyHash)) : ciphertext;
  return BigInt(keccak256(pre)) % SNARK_FIELD;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Bir lotun en fazla bu kadar kez (kalanlar dahil) kilitliyken satılabilmesi için zincir uzunluğu. */
export const LOT_KEY_CHAIN = 32;

/**
 * Lot anahtar zinciri (DarkVault `submitLotSell`): `lotKeyAt(seed, i) = keccak256^(N - i)(seed)`.
 * `lotKeyAt(seed, 0)` alımda zincire yazılır; i. satış `lotKeyAt(seed, i)`'yi açar
 * (`keccak256(lotKeyAt(seed, i)) == lotKeyAt(seed, i - 1)`). Açılan anahtardan sonrakini kimse bulamaz.
 */
export function lotKeyAt(seed, i) {
  if (!(i >= 0 && i <= LOT_KEY_CHAIN)) throw new Error("lot key index out of range");
  let k = seed;
  for (let j = i; j < LOT_KEY_CHAIN; j++) k = keccak256(k);
  return k;
}

/** Zincirdeki başa (`orders(lot).lotKey`) göre açılacak bir sonraki anahtar; zincir bittiyse null. */
export function nextLotKey(seed, head) {
  for (let i = 0; i < LOT_KEY_CHAIN; i++) {
    if (lotKeyAt(seed, i).toLowerCase() === head.toLowerCase()) return lotKeyAt(seed, i + 1);
  }
  return null;
}

/**
 * Kilidi açılmamış bir alımın ("lot") yüzdeyle satışı (v3). Miktarı enclave lotun notundan okur.
 * @param l {poolId, pctBps (1..=10000), lotOrderId (0x..32 bayt), auth}
 *   auth = lotu doğuran ALIM emrindeki spendBlinding (kalan lotlar da aynı yetkiyi taşır).
 */
export function encodeLotSell(l) {
  if (!(l.pctBps >= 1 && l.pctBps <= 10_000)) throw new Error("pctBps must be 1..=10000");
  const out = new Uint8Array(ORDER_LEN);
  out[0] = 3;
  out[1] = Side.Sell;
  out.set(be(l.poolId, 4), 2);
  out.set(be(l.pctBps, 2), 6);
  const lot = hexToBytes(l.lotOrderId);
  if (lot.length !== 32) throw new Error("lotOrderId must be 32 bytes");
  out.set(lot, 8);
  out.set(be(l.auth, 32), 40);
  return out;
}

export async function encryptLotSell(enclavePub, chainId, vault, lotSell) {
  const ct = await encrypt(enclavePub, encodeLotSell(lotSell), orderAad(chainId, vault));
  if (ct.length !== CIPHERTEXT_LEN) throw new Error("unexpected ciphertext length");
  return ct;
}

/** Sonuç ve varsa sonuna eklenmiş enclave lot notu (reveal.rs `split_sealed_result`). */
export function splitSealedResult(sealed) {
  if (sealed.length === SEALED_RESULT_LEN + LOT_MEMO_LEN) {
    return { result: sealed.slice(0, SEALED_RESULT_LEN), lotMemo: sealed.slice(SEALED_RESULT_LEN) };
  }
  return { result: sealed, lotMemo: null };
}

/** Lot satışında satılmayan kısmın sonuç kimliği: keccak256("darkpool/remainder/v1" || satışEmriId). */
export function remainderId(sellOrderId) {
  const tag = new TextEncoder().encode("darkpool/remainder/v1");
  const id = hexToBytes(sellOrderId);
  const b = new Uint8Array(tag.length + 32);
  b.set(tag, 0);
  b.set(id, tag.length);
  return keccak256(b);
}

/** Kilit açılınca: lot satışında kalan lotun notunu açar (sonuçla aynı iki katman, kimlik = remainderId). */
export function openRemainder(kb, eciesSecret, sellOrderId, sealedRemainder) {
  return openResult(kb, eciesSecret, remainderId(sellOrderId), sealedRemainder);
}

/** Kilit açılınca: K_b ile dış katmanı, kullanıcının ECIES anahtarıyla iç katmanı açar. */
export async function openResult(kb, eciesSecret, orderId, sealedResult) {
  const id = hexToBytes(orderId);
  const inner = await openWithBatchKey(kb, "darkpool/result/v1", splitSealedResult(sealedResult).result, id);
  const b = await decrypt(eciesSecret, inner, id);
  if (b.length !== 112 || b[0] !== 2) throw new Error("malformed outcome");
  return {
    poolId: Number(toBig(b.slice(1, 5))),
    outToken: bytesToHex(b.slice(5, 25)),
    amountOut: toBig(b.slice(25, 41)),
    blinding: toBig(b.slice(41, 73)),
    owner: toBig(b.slice(73, 105)),
  };
}
