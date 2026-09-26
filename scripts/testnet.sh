#!/usr/bin/env bash
# Monad testnet: gerçek zincir, gerçek ZK kanıtları, gerçek drand zaman kilidi; token'lar demo.
#
#   ./scripts/testnet.sh status   # adresler + MON bakiyeleri
#   ./scripts/testnet.sh deploy   # kontratlar + 3 demo proje + relayer'a gaz (bir kez)
#   ./scripts/testnet.sh up       # enclave + relayer'ı çalıştır (açık kaldığı sürece)
#   ./scripts/testnet.sh down     # çalışan enclave + relayer'ı durdur
#   ./scripts/testnet.sh news <poolId> "<başlık>" "<metin>"   # demo projesi adına imzalı haber
#
# Anahtarlar .testnet/ altındadır (git dışı, 600) ve hiçbir çıktıya yazdırılmaz.
# Enclave şimdilik TEE_PROVIDER=local (donanımsız) çalışır; Oyster CVM için oyster/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
T=${TESTNET_DIR:-$ROOT/.testnet}
RPC=${RPC_URL:-https://testnet-rpc.monad.xyz}
EXPLORER=${EXPLORER_URL:-https://testnet.monadexplorer.com}
PORT_ENCLAVE=${PORT_ENCLAVE:-8180} # 8080 docker-compose enclave'ıyla çakışmasın
PORT_RELAYER=${PORT_RELAYER:-8090}
WINDOW_SECONDS=${WINDOW_SECONDS:-60}
OWNER_RESERVE=${OWNER_RESERVE:-300000000000000000} # 0.3 MON: yönetim işlemleri için deployer'da kalır
mkdir -p "$T"; chmod 700 "$T"
umask 077

new_key() { cast wallet new --json | jq -r '.[0].private_key'; }
if [ ! -f "$T/keys.env" ]; then
  { echo "DEPLOYER_KEY=$(new_key)"; echo "RELAYER_KEY=$(new_key)"; } > "$T/keys.env"
fi
if [ ! -f "$T/news-keys.json" ]; then echo '{}' > "$T/news-keys.json"; fi
for i in 1 2 3 4; do # demo projelerin haber anahtarları (ArfDAO = 4)
  if [ "$(jq -r --arg i "$i" '.[$i] // empty' "$T/news-keys.json")" = "" ]; then
    jq --arg i "$i" --arg k "$(new_key)" '.[$i]=$k' "$T/news-keys.json" > "$T/news-keys.tmp" && mv "$T/news-keys.tmp" "$T/news-keys.json"
  fi
done
set -a; . "$T/keys.env"; set +a
DEPLOYER=$(cast wallet address "$DEPLOYER_KEY")
RELAYER=$(cast wallet address "$RELAYER_KEY")
bal() { cast balance "$1" --rpc-url "$RPC" --ether; }
wait_http() { for _ in $(seq 1 120); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "zaman aşımı: $1"; exit 1; }

start_enclave() {
  cargo build -q --release -p dark-tee-server -p darkpool-relayer
  if ! curl -sf "http://127.0.0.1:$PORT_ENCLAVE/health" >/dev/null 2>&1; then
    TEE_PROVIDER=local RELAYER_ADDRESSES=$RELAYER LOCAL_SEED_PATH="$T/enclave-seed.bin" LISTEN_ADDR=127.0.0.1:$PORT_ENCLAVE \
      RUST_LOG=warn target/release/dark-tee-server >> "$T/enclave.log" 2>&1 &
    ENCLAVE_PID=$!
    wait_http "http://127.0.0.1:$PORT_ENCLAVE/health"
  fi
  ENCLAVE_ADDRESS=$(curl -s "http://127.0.0.1:$PORT_ENCLAVE/pubkey" | jq -r .address)
}

cmd=${1:-status}
case $cmd in
status)
  echo "ağ       : Monad testnet ($(cast chain-id --rpc-url "$RPC"))"
  echo "deployer : $DEPLOYER  $(bal "$DEPLOYER") MON"
  echo "relayer  : $RELAYER  $(bal "$RELAYER") MON"
  [ -f "$T/deployed" ] && echo "vault    : $(jq -r .vault contracts/deployments/10143.json)" || echo "vault    : (henüz deploy edilmedi)"
  ;;

deploy)
  [ -f "$T/deployed" ] && { echo "zaten deploy edildi (yeniden için: rm $T/deployed)"; exit 1; }
  B=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
  NEED=3500000000000000000 # deploy ~2 + kurulum ~0.5 + relayer'a en az ~0.7 MON
  if [ "$(echo "$B < $NEED" | bc)" = 1 ]; then
    echo "deployer bakiyesi yetersiz: $(bal "$DEPLOYER") MON (gereken en az 3, önerilen 10+)."
    echo "Monad testnet musluğundan şu adrese MON gönderin: $DEPLOYER"; exit 1
  fi
  start_enclave
  trap '[ -n "${ENCLAVE_PID:-}" ] && kill $ENCLAVE_PID 2>/dev/null || true' EXIT
  echo "==> enclave $ENCLAVE_ADDRESS"
  cd contracts
  forge build -q
  FORGE=(--rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier 115 --private-key "$DEPLOYER_KEY" -q)
  echo "==> kontratlar (pencere $WINDOW_SECONDS sn)"
  OWNER=$DEPLOYER ENCLAVE_ADDRESS=$ENCLAVE_ADDRESS WINDOW_SECONDS=$WINDOW_SECONDS \
    forge script script/Deploy.s.sol "${FORGE[@]}" >/dev/null
  VAULT=$(jq -r .vault deployments/10143.json)
  echo "==> 3 demo proje + havuzlar"
  VAULT=$VAULT forge script script/LocalSetup.s.sol "${FORGE[@]}" >/dev/null
  cd "$ROOT"
  # Gizli emirleri relayer gönderir (kullanıcı adresi zincirde görünmesin diye): kalan MON'un
  # tamamı relayer'a. Emir başına ~1.5-2.5M gaz; Monad limiti ücretlendirdiğinden bol tutulur.
  LEFT=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
  SEND=$(echo "$LEFT - $OWNER_RESERVE - 10000000000000000" | bc)
  echo "==> relayer'a gaz: $(cast from-wei "$SEND") MON"
  cast send "$RELAYER" --value "$SEND" --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  touch "$T/deployed"
  echo "vault $VAULT — $EXPLORER/address/$VAULT"
  ;;

up)
  [ -f "$T/deployed" ] || { echo "önce: ./scripts/testnet.sh deploy"; exit 1; }
  if curl -sf "http://127.0.0.1:$PORT_RELAYER/v1/info" >/dev/null 2>&1; then
    echo "relayer zaten çalışıyor: http://127.0.0.1:$PORT_RELAYER (durdurmak için: ./scripts/testnet.sh down)"; exit 0
  fi
  D=contracts/deployments/10143.json
  VAULT=$(jq -r .vault $D)
  NK=$T/news-keys.json
  # Havuz 1000+ launchpad projeleri relayer tarafından eklenir; dosya yalnızca ilk kurulumda yazılır.
  if [ ! -f "$T/projects.json" ]; then
    signer() { cast wallet address "$(jq -r --arg i "$1" '.[$i]' "$NK")"; }
    jq --arg s1 "$(signer 1)" --arg s2 "$(signer 2)" --arg s3 "$(signer 3)" --arg s4 "$(signer 4)" \
      '."1".newsSigners=[$s1] | ."2".newsSigners=[$s2] | ."3".newsSigners=[$s3] | ."4".newsSigners=[$s4]' \
      scripts/projects.template.json > "$T/projects.json"
  fi
  touch "$T/news.jsonl"
  # Demo projelerin testnet öncesi örnek grafiği (işaretli; gerçek veri 7 gün sonra devam eder)
  if [ ! -f "$T/demo-history.json" ]; then
    RPC_URL=$RPC DEPLOYMENT=$D OUT="$T/demo-history.json" node sdk/e2e/gen-demo-history.mjs
  fi
  cat > "$T/relayer.env" <<EOF
RPC_URL=$RPC
VAULT_ADDRESS=$VAULT
ENCLAVE_URL=http://127.0.0.1:$PORT_ENCLAVE
RELAYER_PRIVATE_KEY=$RELAYER_KEY
DEPLOY_BLOCK=$(jq -r .deployBlock $D)
LOG_CHUNK=100
POLL_MS=1000
LISTEN_ADDR=127.0.0.1:$PORT_RELAYER
PROJECTS_FILE=$T/projects.json
NEWS_FILE=$T/news.jsonl
DEMO_HISTORY_FILE=$T/demo-history.json
MON_PRICE_SOURCE=coingecko
RATE_PER_MIN=60
RUST_LOG=warn,darkpool_relayer=info
EOF
  cat > frontend/.env.local <<EOF
NEXT_PUBLIC_RPC_URL=$RPC
NEXT_PUBLIC_RELAYER_URL=http://127.0.0.1:$PORT_RELAYER
NEXT_PUBLIC_CHAIN_ID=10143
NEXT_PUBLIC_VAULT=$VAULT
NEXT_PUBLIC_CHAIN_NAME=Monad Testnet
NEXT_PUBLIC_EXPLORER_URL=$EXPLORER
EOF
  start_enclave
  trap 'kill ${ENCLAVE_PID:-} ${RELAYER_PID:-} 2>/dev/null || true' EXIT INT TERM
  # Enclave anahtarı zincirdeki registry'de kayıtlı olmalı; değiştiyse (ör. yeni makine) yenisini
  # kaydet, eskisini kaldır. Registry sahibi deployer'dır.
  REGISTRY=$(jq -r .registry $D)
  if [ "$(cast call "$REGISTRY" 'isEnclave(address)(bool)' "$ENCLAVE_ADDRESS" --rpc-url "$RPC")" != true ]; then
    echo "==> registry: enclave $ENCLAVE_ADDRESS kaydediliyor"
    cast send "$REGISTRY" 'register(address,bytes32)' "$ENCLAVE_ADDRESS" 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
    OLD=$(cat "$T/enclave-address" 2>/dev/null || true)
    if [ -n "$OLD" ] && [ "$OLD" != "$ENCLAVE_ADDRESS" ] && [ "$(cast call "$REGISTRY" 'isEnclave(address)(bool)' "$OLD" --rpc-url "$RPC")" = true ]; then
      echo "==> registry: eski enclave $OLD kaldırılıyor"
      cast send "$REGISTRY" 'revoke(address)' "$OLD" --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
    fi
  fi
  echo "$ENCLAVE_ADDRESS" > "$T/enclave-address"
  echo "==> enclave $ENCLAVE_ADDRESS  (log: .testnet/enclave.log)"
  (set -a; . "$T/relayer.env"; set +a; exec target/release/darkpool-relayer) >> "$T/relayer.log" 2>&1 &
  RELAYER_PID=$!
  wait_http "http://127.0.0.1:$PORT_RELAYER/v1/info"
  kill -0 "$RELAYER_PID" 2>/dev/null || { echo "relayer başlamadı; son satırlar:"; tail -5 "$T/relayer.log"; exit 1; }
  echo "==> relayer http://127.0.0.1:$PORT_RELAYER  (log: .testnet/relayer.log, gaz: $(bal "$RELAYER") MON)"
  echo "==> frontend: npm --prefix frontend run dev  → http://localhost:3000"
  wait $RELAYER_PID
  ;;

down)
  for p in "$PORT_RELAYER" "$PORT_ENCLAVE"; do lsof -ti "tcp:$p" -sTCP:LISTEN | xargs kill 2>/dev/null || true; done
  echo "relayer ve enclave durduruldu"
  ;;

news)
  shift
  NEWS_KEY=$(jq -r --arg p "$1" '.[$p]' "$T/news-keys.json") RELAYER_URL=http://127.0.0.1:$PORT_RELAYER \
    node sdk/e2e/post-news.mjs "$@"
  ;;

*) sed -n 2,9p "$0"; exit 2 ;;
esac
