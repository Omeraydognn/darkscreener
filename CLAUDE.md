# CLAUDE.md

Guidance for AI coding assistants (Claude Code and others) working in this repository.
Read this first; `README.md` has the full product description, architecture diagram and constants table.

## What this project is

**darkscreener** is a confidential "dark pool" DEX on **Monad** (testnet chain id `10143`, local anvil `31337`).
Core idea: *hidden price, visible project*. There is no live price, volume or holder list anywhere.

1. The browser encrypts an order (ECIES, fixed 190-byte ciphertext) to the enclave's public key.
2. The browser proves with a **Groth16 ZK proof** that it owns a shielded Poseidon note; a **relayer** submits it, so no user address is on chain.
3. At the end of each window, the **TEE enclave** decrypts all orders and clears them at **one uniform FM-AMM price**.
4. Results are **time-locked for 7 days with drand quicknet** (tlock). Nobody, not even the enclave, can read them early.
5. The contract verifies the enclave signature and the hash chains; the relayer re-runs every contract check before submitting.
6. After unlock, results become new notes (`claimNote`); users withdraw gaslessly to fresh addresses.
7. Users decide based on **signed project news** (EIP-191, `darkpool-news:v1`), not charts. Charts are "ghost charts" delayed by 7 days.

## Repository map

| Path | Language | What it is |
|---|---|---|
| `tee-core/` (`dark-tee-core`) | Rust | **Pure** enclave logic: `ecies`, `order`, `note`, `clearing`, `state`, `digest`, `timelock`, `batch`, `reveal`, `keys`. No network, clock, filesystem or TEE API; these are injected. |
| `tee-attest/` (`dark-tee-attest`) | Rust | `TeeProvider` trait (`key_seed`, `trusted_unix_time`, `attest`, `key_is_direct`) + `LocalDev` and `Oyster` impls. |
| `tee-server/` (`dark-tee-server`) | Rust / Axum | Enclave HTTP server (`/health`, `/pubkey`, `/attestation`, `POST /process`), `ForkGuard`. Bins: `gen-fixture`, `dev-client`. |
| `relayer/` (`darkpool-relayer`) | Rust / alloy | Indexer (finalized blocks only), settler, claimer, reveal, news, price, public API (`/v1/...`). |
| `contracts/` | Solidity 0.8.30 / Foundry | `DarkVault.sol` (main), `gateway/` (dUSD, MON gateway), `launch/` (LaunchPad), `registry/`, `verifier/SpendVerifier.sol` (generated), `lib/`. Scripts in `script/`, deployments in `deployments/10143.json`. |
| `circuits/` | Circom 2.2.3 | `src/spend.circom` → `Spend(20)`. Keys in `keys/` (`spend.wasm`, `spend_final.zkey`, `verification_key.json` are committed). |
| `sdk/` (`darkpool-sdk`) | JS (ESM `.mjs`) | Client lib shared by frontend and e2e scripts: `ecies`, `order`, `note`, `relayer`, `news`. |
| `frontend/` | Next.js 16 / React / TS | UI. Imports the SDK as `darkpool-sdk/*.mjs` (`transpilePackages`, Turbopack root = repo root). Has its own `CLAUDE.md`/`AGENTS.md`. |
| `scripts/` | Bash | `setup.sh`, `e2e-local.sh`, `dev-stack.sh`, `testnet.sh`, `gen-fixture.sh`. |
| `oyster/` | Docker | Marlin Oyster CVM deployment of the enclave. |
| `brand.md` | Markdown | Design tokens, UI voice and rules for the frontend. |

Rust workspace members: `tee-core`, `tee-attest`, `tee-server`, `relayer` (root `Cargo.toml`).

## Commands

```bash
./scripts/setup.sh                # one-time: forge libs, circom, npm deps for circuits/sdk
npm --prefix frontend install

cargo build --workspace
cargo test --workspace            # Rust (tee-core, tee-attest, tee-server, relayer)
cargo test -p dark-tee-core       # one crate
(cd contracts && forge build && forge test)
(cd circuits && npm test)
(cd sdk && npm test)              # JS <-> Rust cross-language tests
npm --prefix frontend run lint
npm --prefix frontend run build   # also installs sdk and copies zk keys into public/zk

./scripts/e2e-local.sh            # full anvil + enclave + relayer + user flow (ports 18xxx)
./scripts/dev-stack.sh            # long-running local stack for the UI (ports 28xxx), writes frontend/.env.local
npm --prefix frontend run dev     # http://localhost:3000
./scripts/testnet.sh status|deploy|up|down|news
```

## Cross-language invariants (most important section)

The same data formats are implemented in **Rust, Solidity, Circom and JS**. Changing one side without the others breaks the system silently or makes settlement revert. When you touch any of these, update **all** mirrors and re-run every test suite:

| Concept | Rust | Solidity | JS / Circom |
|---|---|---|---|
| Order plaintext (128 bytes, v2 buy/sell; v3 `LotSell`) | `tee-core/src/order.rs` | length only (`CIPHERTEXT_LEN = 190`) in `DarkVault.sol` | `sdk/src/order.mjs` |
| ECIES `DSX-ECIES-v1` (secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM, 62 bytes overhead) | `tee-core/src/ecies.rs` | — | `sdk/src/ecies.mjs` |
| Order AAD / order id (`keccak256(ciphertext)`) | `order_aad`, `order_id` in `order.rs` | `orderId` in `DarkVault.sol` | `sdk/src/order.mjs` |
| Poseidon notes, commitments, nullifiers | `tee-core/src/note.rs` | `lib/NoteLib.sol`, `lib/PoseidonTree.sol` | `sdk/src/note.mjs`, `circuits/src/spend.circom` |
| Settlement digest | `tee-core/src/digest.rs` | `DarkPoolLib.settlementDigest` | — |
| drand quicknet round ↔ time (genesis, period) | `tee-core/src/timelock.rs` | `lib/DrandQuicknet.sol` | — |
| Lot sale key chain (`lotKeyAt`, ctx = `keccak(ciphertext \|\| lotKeyHash)` for buys) | — | `submitShieldedOrderWithLotKey`, `submitLotSell` in `DarkVault.sol` | `sdk/src/order.mjs`, `frontend/lib/wallet.ts` (`lotSeed`) |
| Signed news message | `relayer/src/news.rs` | — | `sdk/src/news.mjs` |
| Relayer HTTP API | `relayer/src/api.rs` | — | `sdk/src/relayer.mjs`, `frontend/lib/api.ts` |
| Settlement checks | `relayer/src/settler.rs` (must replay contract checks exactly) | `DarkVault.settleBatch` | — |

After changing an enclave/contract format: `./scripts/gen-fixture.sh` (regenerates `contracts/test/fixtures/e2e.json`, which `forge test` uses to check Rust ↔ Solidity ↔ Circom compatibility).
After changing the circuit: `./circuits/scripts/ceremony.sh && ./scripts/gen-fixture.sh` (regenerates keys and `SpendVerifier.sol`). Never hand-edit `SpendVerifier.sol`, `PoseidonArtifacts.sol`, the zkey/wasm, or the fixture.

## Rules and gotchas

- **`tee-core` stays pure.** No `std::net`, `std::fs`, `SystemTime::now`, or provider APIs there. Time and keys come from `tee-attest`.
- **Keep `panic = "unwind"`** in the release profile: the tlock unlock path relies on `catch_unwind`.
- **Privacy is the product.** Never add anything that shows live/recent price, volume, trade feeds, holder lists, or per-user amounts before the 7-day unlock. Delayed data must be labeled "7-day delayed"; the last 7 days are the "dark zone" (see `brand.md`, `frontend/lib/ghost.ts`).
- **Fixed-size ciphertexts** are intentional (no length leak). Don't make order encodings variable length.
- **ForkGuard / hash chains:** the enclave must never sign two different order sets for the same `(batch_id, prev_state_hash)`. Don't weaken `ordersHash` / `poolsHash` / state-chain checks.
- **Relayer indexes only `finalized` blocks.** Keep it that way.
- **Secrets:** never commit `.env*` (except `*.example`), `*.key`, `*.pem`, `seed.bin`, `.dev/`, `.testnet/`. Relayer keys are gas-only keys.
- **Frontend:** Next.js 16 has breaking changes vs. training data; read `frontend/AGENTS.md` and the docs in `frontend/node_modules/next/dist/docs/` before writing Next code. UI strings go through `t()` in `frontend/lib/i18n.ts` with both English and Turkish (`[en, tr]`); English is the default. Colors come from CSS tokens in `frontend/app/globals.css` (light default, dark via `data-theme="dark"`).
- **`NEXT_PUBLIC_*`** vars are inlined at build time and must be read explicitly (see `frontend/lib/config.ts`).
- **Current TEE status:** `TEE_PROVIDER=local` (real crypto/ZK/timelock, no hardware guarantee). The Oyster path is in `oyster/`.
- **Language:** docs are English. Many source code comments, script output and `brand.md` are in Turkish; that's expected. Match the surrounding style when editing a file, and write new top-level docs in English.

## Before finishing a change

Run the suites relevant to what you touched, at minimum:
- Rust changes → `cargo test --workspace`
- Contract changes → `(cd contracts && forge test)`
- Format / crypto changes → all of: cargo, forge, `circuits` and `sdk` tests, plus `./scripts/gen-fixture.sh` if needed
- Frontend changes → `npm --prefix frontend run lint` and `npm --prefix frontend run build`
