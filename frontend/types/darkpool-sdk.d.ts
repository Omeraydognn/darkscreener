// SDK saf JS (.mjs); tipler burada, kullanıldığı kadarıyla.
declare module "darkpool-sdk/note.mjs" {
  export const SNARK_FIELD: bigint;
  export function randomField(): bigint;
  export function noteHelpers(): Promise<{
    H: (inputs: bigint[]) => bigint;
    owner: (spendKey: bigint) => bigint;
    secretHash: (owner: bigint, blinding: bigint) => bigint;
    commitment: (token: bigint, amount: bigint, secretHash: bigint) => bigint;
    nullifier: (spendKey: bigint, commitment: bigint) => bigint;
    spendCommitment: (token: bigint, amount: bigint, blinding: bigint) => bigint;
  }>;
  export class Tree {
    constructor(H: (inputs: bigint[]) => bigint);
    leaves: bigint[];
    insert(leaf: bigint): number;
    root(): bigint;
  }
  export function buildSpendInput(
    helpers: unknown,
    tree: Tree,
    note: { token: bigint; amount: bigint; spendKey: bigint; blinding: bigint; leafIndex: number },
    spend: { amount: bigint; blinding: bigint },
    changeBlinding: bigint,
    ctxHash: bigint,
  ): { input: Record<string, unknown>; publicInputs: Record<string, bigint>; change: bigint };
}

declare module "darkpool-sdk/order.mjs" {
  export const Side: { Buy: 0; Sell: 1 };
  export function encryptOrder(
    enclavePub: Uint8Array,
    chainId: number,
    vault: string,
    order: { side: number; poolId: number; amountIn: bigint; recipientPub: Uint8Array; spendBlinding: bigint; owner: bigint },
  ): Promise<Uint8Array>;
  export function orderContext(ciphertext: Uint8Array): bigint;
  export function openResult(
    kb: Uint8Array,
    eciesSecret: Uint8Array,
    orderId: string,
    sealedResult: Uint8Array,
  ): Promise<{ poolId: number; outToken: string; amountOut: bigint; blinding: bigint; owner: bigint }>;
}

declare module "darkpool-sdk/relayer.mjs" {
  export function proofForRelayer(p: { proof: unknown; publicInputs: Record<string, bigint> }): Record<string, unknown>;
}

declare module "darkpool-sdk/news.mjs" {
  export function message(poolId: number, ts: number, title: string, body: string, url: string): string;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: unknown; publicSignals: string[] }>;
  };
}
