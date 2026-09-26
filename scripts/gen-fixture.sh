#!/usr/bin/env bash
# Rust enclave + Circom kanıtlarıyla Solidity çapraz-uyum fixture'ını üretir.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=contracts/test/fixtures/e2e.json
cargo run -q -p dark-tee-server --bin gen-fixture > "$OUT"
node circuits/scripts/prove-fixture.mjs "$OUT"
