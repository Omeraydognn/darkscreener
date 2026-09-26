// Relayer HTTP istemcisi (relayer/src/api.rs).

import { hexToBytes } from "viem";

export class RelayerClient {
  constructor(url) {
    this.url = url.replace(/\/$/, "");
  }

  async #req(path, body) {
    const res = await fetch(this.url + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
    return json;
  }

  /** Enclave anahtarı yalnızca registry'de kayıtlıysa kullanılır. */
  async info() {
    const info = await this.#req("/v1/info");
    if (!info.enclave.registered) throw new Error("enclave key is NOT registered on-chain; refusing to encrypt to it");
    return { ...info, enclavePub: hexToBytes(info.enclave.publicKey) };
  }

  async notes(from = 0) {
    const out = [];
    for (;;) {
      const page = await this.#req(`/v1/notes?from=${from + out.length}`);
      out.push(...page.commitments.map(BigInt));
      if (from + out.length >= page.total || page.commitments.length === 0) return out;
    }
  }

  batch(id) {
    return this.#req(`/v1/batches/${id}`);
  }

  submitOrder(ciphertext, proof) {
    return this.#req("/v1/orders", { ciphertext, proof });
  }

  withdraw(proof, token, amount, spendBlinding, recipient) {
    return this.#req("/v1/withdrawals", { proof, token, amount, spendBlinding, recipient });
  }
}

/** circuits/lib/note.mjs `proveSpend` çıktısını relayer biçimine çevirir. */
export function proofForRelayer({ proof, publicInputs }) {
  const s = (x) => BigInt(x).toString();
  return {
    a: [s(proof.pi_a[0]), s(proof.pi_a[1])],
    b: [
      [s(proof.pi_b[0][1]), s(proof.pi_b[0][0])],
      [s(proof.pi_b[1][1]), s(proof.pi_b[1][0])],
    ],
    c: [s(proof.pi_c[0]), s(proof.pi_c[1])],
    root: s(publicInputs.root),
    nullifier: s(publicInputs.nullifier),
    changeCommitment: s(publicInputs.changeCommitment),
    spendCommitment: s(publicInputs.spendCommitment),
  };
}
