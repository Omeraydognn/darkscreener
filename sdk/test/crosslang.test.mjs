// Rust enclave ↔ JS SDK çapraz uyum testleri (contracts/test/fixtures/e2e.json üzerinden).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hexToBytes, keccak256 } from "viem";
import { encrypt, decrypt, secp256k1 } from "../src/ecies.mjs";
import { encodeOrder, encodeLotSell, openResult, orderContext, remainderId, CIPHERTEXT_LEN, Side } from "../src/order.mjs";
import { bytesToHex } from "viem";

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

// Aynı vektör tee-core/src/order.rs `lot_sell_matches_js_vector` testinde.
test("kilitli lot satışı (v3) kodlaması ve kalan not kimliği Rust ile aynı", () => {
  const lot = "0x" + "09".repeat(32);
  assert.equal(
    bytesToHex(encodeLotSell({ poolId: 4, pctBps: 5000, lotOrderId: lot, auth: 7n })),
    "0x0301000000041388090909090909090909090909090909090909090909090909090909090909090900000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(remainderId(lot), "0x4ab812e6bf5cbeed1d99994683f12201e49a1b61734b689a4825dfe4877ba48c");
  assert.throws(() => encodeLotSell({ poolId: 4, pctBps: 0, lotOrderId: lot, auth: 7n }));
});
