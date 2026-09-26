// Emir v2 / kilitli lot satışı v3 kodlaması ve sonuç çözümü — tee-core/src/order.rs ve reveal.rs ile aynı.

import { hexToBytes, bytesToHex, concat, keccak256 } from "viem";
import { encrypt, decrypt, openWithBatchKey } from "./ecies.mjs";

export const ORDER_LEN = 128;
export const CIPHERTEXT_LEN = 1 + 33 + 12 + ORDER_LEN + 16;
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const Side = { Buy: 0, Sell: 1 };
/** tee-core reveal.rs `SEALED_RESULT_LEN`: dolu sonuçların sonuna enclave'e özel lot notu eklenir. */
export const SEALED_RESULT_LEN = 12 + 62 + 112 + 16;

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

/**
 * Kilidi açılmamış bir alımın ("lot") yüzdesel satışı (v3). Miktarı enclave lot notundan okur.
 * @param o {poolId, pctBps (1..10000), lotOrderId (0x..32 bayt), auth (lot alımındaki spendBlinding)}
 */
export function encodeLotSell(o) {
  if (!(o.pctBps >= 1 && o.pctBps <= 10_000)) throw new Error("pctBps must be 1..10000");
  const out = new Uint8Array(ORDER_LEN);
  out[0] = 3;
  out[1] = 1;
  out.set(be(o.poolId, 4), 2);
  out.set(be(o.pctBps, 2), 6);
  const lot = hexToBytes(o.lotOrderId);
  if (lot.length !== 32) throw new Error("lotOrderId must be 32 bytes");
  out.set(lot, 8);
  out.set(be(o.auth, 32), 40);
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

export async function encryptLotSell(enclavePub, chainId, vault, lotSell) {
  const ct = await encrypt(enclavePub, encodeLotSell(lotSell), orderAad(chainId, vault));
  if (ct.length !== CIPHERTEXT_LEN) throw new Error("unexpected ciphertext length");
  return ct;
}

/** Kanıtın bağlandığı bağlam: keccak256(ciphertext) mod p (kontrat ile aynı). */
export function orderContext(ciphertext) {
  return BigInt(keccak256(ciphertext)) % SNARK_FIELD;
}

/** Kilit açılınca: K_b ile dış katmanı, kullanıcının ECIES anahtarıyla iç katmanı açar. */
export async function openResult(kb, eciesSecret, orderId, sealedResult) {
  return openOutcome(kb, eciesSecret, hexToBytes(orderId), sealedResult.slice(0, SEALED_RESULT_LEN));
}

/** Lot satışında satılmayan kısmın sonuç kimliği: keccak256("darkpool/remainder/v1" || satışEmriId). */
export function remainderId(sellOrderId) {
  return keccak256(concat([new TextEncoder().encode("darkpool/remainder/v1"), hexToBytes(sellOrderId)]));
}

/** Lot satışının kalan notu (BatchLots.sealedRemainder); sonuçla aynı iki katman, kimlik = remainderId. */
export async function openRemainder(kb, eciesSecret, sellOrderId, sealedRemainder) {
  return openOutcome(kb, eciesSecret, hexToBytes(remainderId(sellOrderId)), sealedRemainder);
}

async function openOutcome(kb, eciesSecret, id, sealed) {
  const inner = await openWithBatchKey(kb, "darkpool/result/v1", sealed, id);
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
