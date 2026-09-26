// Shielded pool notları — tarayıcıda ve Node'da aynı kod. Formüller circuits/src/spend.circom,
// tee-core/src/note.rs ve contracts/src/lib/NoteLib.sol ile birebir aynıdır.
//
//   owner           = Poseidon1(spendKey)
//   secretHash      = Poseidon2(owner, blinding)
//   note            = Poseidon3(token, amount, secretHash)
//   nullifier       = Poseidon2(spendKey, note)
//   spendCommitment = Poseidon3(token, amount, spendBlinding)   (spendBlinding = secretHash(owner, r))

// poseidon-lite: saf JS, circomlib parametreleriyle aynı (vektörler note.rs testlerinde),
// tarayıcıya wasm/ethers taşımaz.
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";

export const LEVELS = 20;
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const POSEIDON = { 1: poseidon1, 2: poseidon2, 3: poseidon3 };

/** (API eşzamansız kalır; çağıranlar değişmesin) */
export async function poseidon() {
  return (inputs) => {
    const f = POSEIDON[inputs.length];
    if (!f) throw new Error(`poseidon arity ${inputs.length} unsupported`);
    return f(inputs.map(BigInt));
  };
}

/** Alan elemanına sığan (248 bit) rastgele değer. */
export function randomField() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
}

export async function noteHelpers() {
  const H = await poseidon();
  return {
    H,
    owner: (spendKey) => H([spendKey]),
    secretHash: (owner, blinding) => H([owner, blinding]),
    commitment: (token, amount, secretHash) => H([token, amount, secretHash]),
    nullifier: (spendKey, commitment) => H([spendKey, commitment]),
    spendCommitment: (token, amount, blinding) => H([token, amount, blinding]),
  };
}

/** Kontrattaki PoseidonTree ile aynı: sıfır yaprak 0, zeros[i+1] = H(zeros[i], zeros[i]). */
export class Tree {
  constructor(H, levels = LEVELS) {
    this.H = H;
    this.levels = levels;
    this.leaves = [];
    this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(H([this.zeros[i], this.zeros[i]]));
  }

  insert(leaf) {
    this.leaves.push(BigInt(leaf));
    return this.leaves.length - 1;
  }

  _layers() {
    const layers = [this.leaves.slice()];
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const cur = layers[lvl];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(this.H([cur[i], i + 1 < cur.length ? cur[i + 1] : this.zeros[lvl]]));
      }
      layers.push(next);
    }
    return layers;
  }

  root() {
    if (this.leaves.length === 0) return this.zeros[this.levels];
    return this._layers()[this.levels][0];
  }

  path(index) {
    const layers = this._layers();
    const elements = [];
    let idx = index;
    for (let lvl = 0; lvl < this.levels; lvl++) {
      const sib = idx ^ 1;
      elements.push(sib < layers[lvl].length ? layers[lvl][sib] : this.zeros[lvl]);
      idx >>= 1;
    }
    return elements;
  }
}

/**
 * spend.circom girdisini hazırlar (kanıt üretimi ortama göre: Node dosya yolu, tarayıcı URL).
 * @param note {token, amount, spendKey, blinding, leafIndex}
 * @param spend {amount, blinding}
 */
export function buildSpendInput(helpers, tree, note, spend, changeBlinding, ctxHash) {
  const { owner, secretHash, commitment, nullifier, spendCommitment } = helpers;
  const o = owner(note.spendKey);
  const noteCommitment = commitment(note.token, note.amount, secretHash(o, note.blinding));
  const change = BigInt(note.amount) - BigInt(spend.amount);
  if (change < 0n) throw new Error("spend exceeds note value");
  const publicInputs = {
    root: tree.root(),
    nullifier: nullifier(note.spendKey, noteCommitment),
    changeCommitment: commitment(note.token, change, secretHash(o, changeBlinding)),
    spendCommitment: spendCommitment(note.token, spend.amount, spend.blinding),
    ctxHash: BigInt(ctxHash) % SNARK_FIELD,
  };
  const input = {
    ...publicInputs,
    token: note.token,
    amount: note.amount,
    spendKey: note.spendKey,
    blinding: note.blinding,
    leafIndex: note.leafIndex,
    pathElements: tree.path(note.leafIndex),
    spendAmount: spend.amount,
    spendBlinding: spend.blinding,
    changeBlinding,
  };
  const stringify = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  return { input: stringify(input), publicInputs, change };
}

/** Solidity verifier'ın beklediği (a, b, c) biçimi — b koordinatları ters sırada. */
export function toSolidityProof(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}
