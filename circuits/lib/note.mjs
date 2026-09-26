// Node tarafı: not/ağaç mantığı SDK'dan (tarayıcıyla ortak), kanıt dosyaları yerel diskten.

import * as snarkjs from "snarkjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildSpendInput } from "../../sdk/src/note.mjs";

export {
  LEVELS,
  SNARK_FIELD,
  poseidon,
  randomField,
  noteHelpers,
  Tree,
  buildSpendInput,
  toSolidityProof,
} from "../../sdk/src/note.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM = path.join(here, "../keys/spend.wasm");
export const ZKEY = path.join(here, "../keys/spend_final.zkey");

/** Spend kanıtı üretir (girdiler için bkz. sdk/src/note.mjs `buildSpendInput`). */
export async function proveSpend(helpers, tree, note, spend, changeBlinding, ctxHash) {
  const { input, publicInputs, change } = buildSpendInput(helpers, tree, note, spend, changeBlinding, ctxHash);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  return { proof, publicSignals, publicInputs, change };
}

/** snarkjs'in bn128 worker'larını kapatır; aksi halde Node süreci açık kalır. */
export async function shutdown() {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}
