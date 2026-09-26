#!/usr/bin/env bash
# Yerel uçtan uca test: anvil (gerçek EVM) + enclave sunucusu + relayer + kullanıcı script'i.
# Anahtarlar her çalıştırmada yeni üretilir, anvil'de fonlanır ve hiçbir yere yazdırılmaz.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
PORT_RPC=18545
PORT_ENCLAVE=18080
PORT_RELAYER=18090
RPC=http://127.0.0.1:$PORT_RPC
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

wait_http() { for _ in $(seq 1 120); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "timeout: $1"; exit 1; }

echo "==> derleme"
cargo build -q -p dark-tee-server -p darkpool-relayer
(cd contracts && forge build -q)

echo "==> anvil (blok 1 sn, finalized = latest-2)"
anvil --port $PORT_RPC --block-time 1 --slots-in-an-epoch 1 --silent &
PIDS+=($!); disown $!
for _ in $(seq 1 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done

new_key() { cast wallet new --json | jq -r '.[0].private_key'; }
fund() { cast rpc --rpc-url $RPC anvil_setBalance "$(cast wallet address "$1")" 0x3635C9ADC5DEA00000 >/dev/null; }
DEPLOYER_KEY=$(new_key); RELAYER_KEY=$(new_key); USER_KEY=$(new_key)
fund "$DEPLOYER_KEY"; fund "$RELAYER_KEY"; fund "$USER_KEY"
DEPLOYER=$(cast wallet address "$DEPLOYER_KEY")

echo "==> enclave (local sağlayıcı)"
TEE_PROVIDER=local RELAYER_ADDRESSES=$(cast wallet address "$RELAYER_KEY") LOCAL_SEED_PATH="$TMP/seed.bin" LISTEN_ADDR=127.0.0.1:$PORT_ENCLAVE RUST_LOG=warn \
  target/debug/dark-tee-server &
PIDS+=($!); disown $!
wait_http http://127.0.0.1:$PORT_ENCLAVE/health
ENCLAVE_ADDRESS=$(curl -s http://127.0.0.1:$PORT_ENCLAVE/pubkey | jq -r .address)

echo "==> kontratlar (pencere 5 sn)"
cd contracts
OWNER=$DEPLOYER ENCLAVE_ADDRESS=$ENCLAVE_ADDRESS WINDOW_SECONDS=5 \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key "$DEPLOYER_KEY" -q >/dev/null
CHAIN_ID=$(cast chain-id --rpc-url $RPC)
DEPLOYMENT=$ROOT/contracts/deployments/$CHAIN_ID.json
VAULT=$(jq -r .vault "$DEPLOYMENT")
VAULT=$VAULT forge script script/LocalSetup.s.sol --rpc-url $RPC --broadcast --private-key "$DEPLOYER_KEY" -q >/dev/null
cd "$ROOT"
echo "    vault $VAULT"

echo "==> relayer"
RPC_URL=$RPC VAULT_ADDRESS=$VAULT ENCLAVE_URL=http://127.0.0.1:$PORT_ENCLAVE RELAYER_PRIVATE_KEY=$RELAYER_KEY \
  DEPLOY_BLOCK=$(jq -r .deployBlock "$DEPLOYMENT") POLL_MS=500 LISTEN_ADDR=127.0.0.1:$PORT_RELAYER \
  RUST_LOG=${RELAYER_LOG:-warn,darkpool_relayer=info} target/debug/darkpool-relayer &
PIDS+=($!); disown $!
wait_http http://127.0.0.1:$PORT_RELAYER/v1/notes

echo "==> kullanıcı senaryosu"
RPC_URL=$RPC RELAYER_URL=http://127.0.0.1:$PORT_RELAYER DEPLOYMENT=$DEPLOYMENT \
  SETUP=$ROOT/contracts/deployments/$CHAIN_ID-setup.json USER_KEY=$USER_KEY \
  node sdk/e2e/local.mjs
