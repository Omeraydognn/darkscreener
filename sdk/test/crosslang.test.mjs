// Rust enclave ↔ JS SDK çapraz uyum testleri (contracts/test/fixtures/e2e.json üzerinden).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hexToBytes, keccak256 } from "viem";
import { encrypt, decrypt, secp256k1 } from "../src/ecies.mjs";
import { encodeOrder, openResult, orderContext, CIPHERTEXT_LEN, Side } from "../src/order.mjs";

const fx = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/e2e.json", import.meta.url), "utf8"));

test("JS, Rust enclave'in şifrelediği sonuçları açar (dış katman K_b, iç katman kullanıcı)", async () => {
  const kb = hexToBytes(fx.batch2Kb);
  let opened = 0;
  for (const [i, r] of fx.batch2.results.entries()) {
    if (r.status !== 1) continue;
    const user = fx.notes[fx.orders[i].note];
    const out = await openResult(kb, hexToBytes(user.eciesSecret), r.orderId, hexToBytes(r.sealedResult));
    assert.equal(out.outToken.toLowerCase(), r.outToken.toLowerCase());
    assert.equal(out.amountOut, BigInt(r.amountOut));
    assert.equal(out.blinding, BigInt(r.blinding));
    opened++;
  }
  assert.equal(opened, 3);
});

test("başka kullanıcının anahtarı sonucu açamaz", async () => {
  const kb = hexToBytes(fx.batch2Kb);
  const r = fx.batch2.results[0];
  const wrong = hexToBytes(fx.notes[1].eciesSecret);
  await assert.rejects(openResult(kb, wrong, r.orderId, hexToBytes(r.sealedResult)));
});

test("ctxHash hesabı Rust ile aynı", () => {
  for (const o of fx.orders) assert.equal(orderContext(hexToBytes(o.ciphertext)), BigInt(o.ctxHash));
});

test("ECIES tur dönüşü, AAD bağlama ve sabit emir boyutu", async () => {
  const sk = secp256k1.utils.randomSecretKey();
  const pk = secp256k1.getPublicKey(sk, true);
  const order = encodeOrder({
    side: Side.Sell,
    poolId: 7,
    amountIn: 2n ** 127n,
    recipientPub: pk,
    spendBlinding: 123n,
    owner: 456n,
  });
  const ct = await encrypt(pk, order, new Uint8Array([1, 2]));
  assert.equal(ct.length, CIPHERTEXT_LEN);
  assert.deepEqual(await decrypt(sk, ct, new Uint8Array([1, 2])), order);
  await assert.rejects(decrypt(sk, ct, new Uint8Array([9])));
  assert.equal(keccak256(ct).length, 66);
});
