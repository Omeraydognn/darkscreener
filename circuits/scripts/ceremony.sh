#!/usr/bin/env bash
# Groth16 trusted setup — YEREL TESTNET TÖRENİ.
#
# Faz 1 (powers of tau) burada yerel üretilir: tek makinede yapılan tören, katkı
# verenlerden en az birinin rastgeleliğini sildiği varsayımına dayanır. Mainnet öncesi:
#   - Faz 1 için Perpetual Powers of Tau / Hermez final ptau kullanılmalı,
#   - Faz 2'ye bağımsız birden fazla kişi katkı vermeli (`snarkjs zkey contribute`),
#   - sonda halka açık bir drand turu beacon olarak uygulanmalı.
#
# Çıktılar:
#   keys/spend_final.zkey            kanıt üretimi (frontend, fixture)
#   keys/verification_key.json       JS doğrulama
#   ../contracts/src/verifier/SpendVerifier.sol
set -euo pipefail
cd "$(dirname "$0")/.."
SNARKJS="npx --no-install snarkjs"
POWER=14
mkdir -p build keys ../contracts/src/verifier

echo "==> derleme"
circom src/spend.circom --r1cs --wasm --sym --O2 -o build
$SNARKJS r1cs info build/spend.r1cs

echo "==> faz 1 (powers of tau 2^$POWER)"
$SNARKJS powersoftau new bn128 $POWER build/pot_0000.ptau
$SNARKJS powersoftau contribute build/pot_0000.ptau build/pot_0001.ptau --name="darkpool-1" -e="$(openssl rand -hex 64)"
$SNARKJS powersoftau contribute build/pot_0001.ptau build/pot_0002.ptau --name="darkpool-2" -e="$(openssl rand -hex 64)"
$SNARKJS powersoftau prepare phase2 build/pot_0002.ptau build/pot_final.ptau
$SNARKJS powersoftau verify build/pot_final.ptau

echo "==> faz 2 (devreye özel)"
$SNARKJS groth16 setup build/spend.r1cs build/pot_final.ptau build/spend_0000.zkey
$SNARKJS zkey contribute build/spend_0000.zkey build/spend_0001.zkey --name="darkpool-p2-1" -e="$(openssl rand -hex 64)"
$SNARKJS zkey contribute build/spend_0001.zkey build/spend_0002.zkey --name="darkpool-p2-2" -e="$(openssl rand -hex 64)"
$SNARKJS zkey beacon build/spend_0002.zkey keys/spend_final.zkey "$(openssl rand -hex 32)" 10 -n="final beacon"
$SNARKJS zkey verify build/spend.r1cs build/pot_final.ptau keys/spend_final.zkey

echo "==> dışa aktarım"
$SNARKJS zkey export verificationkey keys/spend_final.zkey keys/verification_key.json
$SNARKJS zkey export solidityverifier keys/spend_final.zkey ../contracts/src/verifier/SpendVerifier.sol
cp build/spend_js/spend.wasm keys/spend.wasm
echo "==> tamam"
