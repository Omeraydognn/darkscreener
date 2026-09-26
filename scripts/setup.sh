#!/usr/bin/env bash
# Git'e girmeyen bağımlılıkları sabit sürümlerle kurar.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Foundry bağımlılıkları"
cd contracts
[ -d lib/forge-std ] || forge install foundry-rs/forge-std@v1.16.2 --no-git
[ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
[ -d lib/poseidon-solidity ] || forge install chancehudson/poseidon-solidity@v0.0.5 --no-git
cd ..

echo "==> Circom derleyicisi"
command -v circom >/dev/null || cargo install --git https://github.com/iden3/circom.git --tag v2.2.3 --locked circom

echo "==> Devre bağımlılıkları (snarkjs, circomlib)"
(cd circuits && npm ci --no-fund --no-audit)
(cd sdk && npm ci --no-fund --no-audit)

echo "==> Tamam. Test: cargo test --workspace && (cd contracts && forge test)"
