#!/usr/bin/env bash
# Frontend geliştirme ortamı: zamanı 16 gün geriye alınmış anvil + enclave (saati zincirden
# okur) + relayer + seed verisi. Açık kaldığı sürece çalışır (Ctrl+C ile kapanır).
#
#   ./scripts/dev-stack.sh            # kur + seed (~8 dk), sonra açık kal
#   SKIP_SEED=1 ./scripts/dev-stack.sh
#
# Çıktılar: .dev/ (anahtarlar, projeler, haberler — git dışı), frontend/.env.local
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DEV=$ROOT/.dev
mkdir -p "$DEV"
PORT_RPC=28545
PORT_ENCLAVE=28080
PORT_RELAYER=28090
RPC=http://127.0.0.1:$PORT_RPC
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_http() { for _ in $(seq 1 240); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "timeout: $1"; exit 1; }

echo "==> derleme"
cargo build -q -p dark-tee-server -p darkpool-relayer
(cd contracts && forge build -q)

START=$(( $(date +%s) - 16 * 86400 ))
echo "==> anvil (zaman: $(date -r $START '+%d.%m %H:%M'), blok 1 sn)"
anvil --port $PORT_RPC --block-time 1 --slots-in-an-epoch 1 --timestamp $START --silent &
PIDS+=($!); disown $!
for _ in $(seq 1 60); do cast chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done

new_key() { cast wallet new --json | jq -r '.[0].private_key'; }
fund() { cast rpc --rpc-url $RPC anvil_setBalance "$(cast wallet address "$1")" 0x3635C9ADC5DEA00000 >/dev/null; }
DEPLOYER_KEY=$(new_key); RELAYER_KEY=$(new_key)
TRADERS=(); for _ in 1 2 3 4; do TRADERS+=("$(new_key)"); done
SIGNERS=(); for _ in 1 2 3 4; do SIGNERS+=("$(new_key)"); done
for k in "$DEPLOYER_KEY" "$RELAYER_KEY" "${TRADERS[@]}"; do fund "$k"; done
jq -n --argjson t "$(printf '%s\n' "${TRADERS[@]}" | jq -R . | jq -s .)" \
      --argjson s "$(printf '%s\n' "${SIGNERS[@]}" | jq -R . | jq -s .)" --arg d "$DEPLOYER_KEY" \
      '{deployer: $d, traders: $t, newsSigners: $s}' > "$DEV/keys.json"
chmod 600 "$DEV/keys.json"

echo "==> enclave (local, saat = zincir)"
TEE_PROVIDER=local RELAYER_ADDRESSES=$(cast wallet address "$RELAYER_KEY") LOCAL_SEED_PATH="$DEV/enclave-seed.bin" LOCAL_CLOCK_RPC=$RPC \
  LISTEN_ADDR=127.0.0.1:$PORT_ENCLAVE RUST_LOG=error target/debug/dark-tee-server &
PIDS+=($!); disown $!
wait_http http://127.0.0.1:$PORT_ENCLAVE/health
ENCLAVE_ADDRESS=$(curl -s http://127.0.0.1:$PORT_ENCLAVE/pubkey | jq -r .address)

echo "==> kontratlar + 3 kurgusal proje"
cd contracts
OWNER=$(cast wallet address "$DEPLOYER_KEY") ENCLAVE_ADDRESS=$ENCLAVE_ADDRESS WINDOW_SECONDS=10 \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key "$DEPLOYER_KEY" -q >/dev/null
CHAIN_ID=$(cast chain-id --rpc-url $RPC)
DEPLOYMENT=$ROOT/contracts/deployments/$CHAIN_ID.json
VAULT=$(jq -r .vault "$DEPLOYMENT")
VAULT=$VAULT forge script script/LocalSetup.s.sol --rpc-url $RPC --broadcast --private-key "$DEPLOYER_KEY" -q >/dev/null
cd "$ROOT"
SETUP=$ROOT/contracts/deployments/$CHAIN_ID-setup.json

addr() { cast wallet address "$1"; }
PROJECTS_TEMPLATE=$ROOT/scripts/projects.template.json
jq --arg s1 "$(addr "${SIGNERS[0]}")" --arg s2 "$(addr "${SIGNERS[1]}")" --arg s3 "$(addr "${SIGNERS[2]}")" --arg s4 "$(addr "${SIGNERS[3]}")" \
  '."1".newsSigners=[$s1] | ."2".newsSigners=[$s2] | ."3".newsSigners=[$s3] | ."4".newsSigners=[$s4]' \
  "$PROJECTS_TEMPLATE" > "$DEV/projects.json"
: > "$DEV/news.jsonl"

echo "==> relayer"
# Ayarlar dosyaya yazılır (git dışı, 600): relayer tek başına yeniden başlatılabilsin:
#   set -a; . .dev/relayer.env; set +a; target/debug/darkpool-relayer
cat > "$DEV/relayer.env" <<EOF
RPC_URL=$RPC
VAULT_ADDRESS=$VAULT
ENCLAVE_URL=http://127.0.0.1:$PORT_ENCLAVE
RELAYER_PRIVATE_KEY=$RELAYER_KEY
DEPLOY_BLOCK=$(jq -r .deployBlock "$DEPLOYMENT")
POLL_MS=400
LISTEN_ADDR=127.0.0.1:$PORT_RELAYER
PROJECTS_FILE=$DEV/projects.json
NEWS_FILE=$DEV/news.jsonl
RATE_PER_MIN=100000
RUST_LOG=warn,darkpool_relayer=info
EOF
chmod 600 "$DEV/relayer.env"
(set -a; . "$DEV/relayer.env"; set +a; exec target/debug/darkpool-relayer) > "$DEV/relayer.log" 2>&1 &
PIDS+=($!); disown $!
wait_http http://127.0.0.1:$PORT_RELAYER/v1/notes

mkdir -p frontend
cat > frontend/.env.local <<EOF
NEXT_PUBLIC_RPC_URL=$RPC
NEXT_PUBLIC_RELAYER_URL=http://127.0.0.1:$PORT_RELAYER
NEXT_PUBLIC_CHAIN_ID=$CHAIN_ID
NEXT_PUBLIC_VAULT=$VAULT
# Yalnızca yerel anvil: tarayıcıda geçici geliştirici cüzdanı + test token musluğu
NEXT_PUBLIC_DEV_CHAIN=1
EOF

if [ -z "${SKIP_SEED:-}" ]; then
  echo "==> seed (16 gün, gerçek kanıtlar)"
  RPC_URL=$RPC RELAYER_URL=http://127.0.0.1:$PORT_RELAYER DEPLOYMENT=$DEPLOYMENT SETUP=$SETUP KEYS="$DEV/keys.json" \
    node sdk/e2e/seed.mjs
fi
echo "==> hazır: relayer http://127.0.0.1:$PORT_RELAYER  (log: .dev/relayer.log) — frontend: npm --prefix frontend run dev"
touch "$DEV/ready"
while true; do sleep 3600; done
