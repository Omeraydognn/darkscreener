// Fixture 2. aşama: gen-fixture'ın ürettiği notlar/emirler için GERÇEK Groth16 kanıtları üretir
// ve aynı dosyaya yazar. Not ağacını Foundry testindeki işlem sırasıyla birebir kurar:
//   deposit × 5 → emirlerin para üstü × 5 → iade dönüşleri → claim'ler → çekimler
// Kullanım: node circuits/scripts/prove-fixture.mjs contracts/test/fixtures/e2e.json

import { readFileSync, writeFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { noteHelpers, Tree, proveSpend, toSolidityProof, randomField, shutdown } from "../lib/note.mjs";

const file = process.argv[2];
const fx = JSON.parse(readFileSync(file, "utf8"));
const vkey = JSON.parse(readFileSync(new URL("../keys/verification_key.json", import.meta.url)));
const h = await noteHelpers();
const tree = new Tree(h.H);
const B = (x) => BigInt(x);
const hex = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");

async function prove(note, spend, changeBlinding, ctxHash, expectSpendCommitment) {
  const r = await proveSpend(h, tree, note, spend, changeBlinding, ctxHash);
  if (!(await snarkjs.groth16.verify(vkey, r.publicSignals, r.proof))) throw new Error("proof does not verify");
  if (expectSpendCommitment !== undefined && r.publicInputs.spendCommitment !== B(expectSpendCommitment)) {
    throw new Error("spendCommitment mismatch between Rust and circuit");
  }
  const p = toSolidityProof(r.proof);
  return {
    a: p.a.map(hex),
    b0: p.b[0].map(hex),
    b1: p.b[1].map(hex),
    c: p.c.map(hex),
    root: hex(r.publicInputs.root),
    nullifier: hex(r.publicInputs.nullifier),
    changeCommitment: hex(r.publicInputs.changeCommitment),
    spendCommitment: hex(r.publicInputs.spendCommitment),
  };
}

// 1) yatırmalar
const notes = fx.notes.map((n, i) => {
  const commitment = h.commitment(B(n.token), B(n.amount), B(n.secretHash));
  const leafIndex = tree.insert(commitment);
  if (leafIndex !== i) throw new Error("deposit index");
  return { token: B(n.token), amount: B(n.amount), spendKey: B(n.spendKey), blinding: B(n.blinding), leafIndex };
});

// 2) emir kanıtları: hepsi yatırmalardan sonraki köke karşı (kontrat son 64 kökü kabul eder)
for (const o of fx.orders) {
  const note = notes[o.note];
  o.proof = await prove(
    note, { amount: B(o.spendAmount), blinding: B(o.spendBlinding) }, B(o.changeBlinding), B(o.ctxHash), o.spendCommitment,
  );
}
const changeIndex = [];
for (const o of fx.orders) changeIndex.push(tree.insert(B(o.proof.changeCommitment)));

// 3) geç emir (kaçış testi): carol'ın para üstü notunu harcar, 10 yapraklı ağaca karşı
{
  const lo = fx.lateOrder;
  const carolOrder = 2;
  const src = fx.orders[carolOrder];
  const n = fx.notes[src.note];
  const changeNote = {
    token: B(n.token),
    amount: B(n.amount) - B(src.spendAmount),
    spendKey: B(n.spendKey),
    blinding: B(src.changeBlinding),
    leafIndex: changeIndex[carolOrder],
  };
  lo.proof = await prove(
    changeNote, { amount: B(lo.spendAmount), blinding: B(lo.spendBlinding) }, B(lo.changeBlinding), B(lo.ctxHash),
    lo.spendCommitment,
  );
}

// 4) iadeler (hemen), sonra claim'ler (kilit açılınca) — testteki sıra
const returnedIndex = {};
fx.batch2.results.forEach((r, i) => {
  if (r.status === 2) returnedIndex[i] = tree.insert(B(fx.orders[i].spendCommitment));
});
const outputIndex = {};
fx.batch2.results.forEach((r, i) => {
  if (r.status === 1) outputIndex[i] = tree.insert(B(r.commitment));
});

// 5) çekimler: tüm sıfır olmayan notlar, hepsi aynı köke karşı
for (const w of fx.withdrawals) {
  const leafIndex =
    w.kind === "change" ? changeIndex[w.order] : w.kind === "returned" ? returnedIndex[w.order] : outputIndex[w.order];
  const note = { token: B(w.token), amount: B(w.amount), spendKey: B(w.spendKey), blinding: B(w.blinding), leafIndex };
  // Rust'ın açtığı notun ağaçtakiyle aynı olduğunu doğrula
  const c = h.commitment(note.token, note.amount, h.secretHash(h.owner(note.spendKey), note.blinding));
  if (c !== tree.leaves[leafIndex]) throw new Error(`withdraw note ${w.kind}/${w.order} not in tree`);
  w.proof = await prove(note, { amount: note.amount, blinding: B(w.spendBlinding) }, randomField(), B(w.ctxHash));
}

fx.treeAfterDeposits = hex(fx.orders[0].proof.root);
writeFileSync(file, JSON.stringify(fx, null, 2) + "\n");
console.error(`proved: ${fx.orders.length} orders, 1 late order, ${fx.withdrawals.length} withdrawals`);
await shutdown();
