import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { noteHelpers, Tree, proveSpend, randomField, shutdown } from "../lib/note.mjs";

after(shutdown);

const vkey = JSON.parse(readFileSync(new URL("../keys/verification_key.json", import.meta.url)));
const USDC = 0xda4c0c01n;

async function setup() {
  const h = await noteHelpers();
  const tree = new Tree(h.H);
  // Ağaçta başka notlar da olsun (anonimlik kümesi)
  for (let i = 0; i < 5; i++) tree.insert(randomField());
  const note = { token: USDC, amount: 1_000_000_000n, spendKey: randomField(), blinding: randomField() };
  const leaf = h.commitment(note.token, note.amount, h.secretHash(h.owner(note.spendKey), note.blinding));
  note.leafIndex = tree.insert(leaf);
  for (let i = 0; i < 3; i++) tree.insert(randomField());
  return { h, tree, note };
}

test("geçerli spend kanıtı doğrulanır ve açık girdiler beklenen sırada", async () => {
  const { h, tree, note } = await setup();
  const spend = { amount: 250_000_000n, blinding: randomField() };
  const { proof, publicSignals, publicInputs, change } = await proveSpend(h, tree, note, spend, randomField(), 12345n);
  assert.equal(change, 750_000_000n);
  assert.deepEqual(publicSignals, [
    publicInputs.root, publicInputs.nullifier, publicInputs.changeCommitment,
    publicInputs.spendCommitment, publicInputs.ctxHash,
  ].map(String));
  assert.ok(await snarkjs.groth16.verify(vkey, publicSignals, proof));

  // Kanıt başka bir bağlama (ctxHash) taşınamaz
  const moved = [...publicSignals];
  moved[4] = "999";
  assert.equal(await snarkjs.groth16.verify(vkey, moved, proof), false);
  // Nullifier değiştirilemez
  const nf = [...publicSignals];
  nf[1] = (BigInt(nf[1]) + 1n).toString();
  assert.equal(await snarkjs.groth16.verify(vkey, nf, proof), false);
});

test("notun değerinden fazla harcanamaz", async () => {
  const { h, tree, note } = await setup();
  await assert.rejects(
    proveSpend(h, tree, note, { amount: note.amount + 1n, blinding: randomField() }, randomField(), 1n),
  );
});

test("ağaçta olmayan not ya da yanlış anahtar kanıt üretemez", async () => {
  const { h, tree, note } = await setup();
  await assert.rejects(
    proveSpend(h, tree, { ...note, spendKey: randomField() }, { amount: 1n, blinding: 1n }, 1n, 1n),
  );
  await assert.rejects(
    proveSpend(h, tree, { ...note, amount: note.amount + 5n }, { amount: 1n, blinding: 1n }, 1n, 1n),
  );
});

test("notun tamamı harcanabilir (para üstü sıfır)", async () => {
  const { h, tree, note } = await setup();
  const { proof, publicSignals } = await proveSpend(h, tree, note, { amount: note.amount, blinding: randomField() }, randomField(), 7n);
  assert.ok(await snarkjs.groth16.verify(vkey, publicSignals, proof));
});
