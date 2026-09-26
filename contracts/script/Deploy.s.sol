// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {OwnerEnclaveRegistry} from "../src/registry/OwnerEnclaveRegistry.sol";
import {ISpendVerifier} from "../src/interfaces/ISpendVerifier.sol";
import {Groth16Verifier} from "../src/verifier/SpendVerifier.sol";
import {IPoseidonT3, IPoseidonT4} from "../src/interfaces/IPoseidon.sol";
import {TestToken} from "../test/utils/TestTokens.sol";

/// @notice Monad testnet dağıtımı.
///
/// Ortam değişkenleri:
///   OWNER              vault + registry sahibi (önerilen: multisig)
///   ENCLAVE_ADDRESS    enclave'in /pubkey `address` alanı (boşsa sonra `register` edilir)
///   QUOTE_TOKEN        ortak quote token (boşsa 6 ondalıklı test USD dağıtılır)
///   MIN_QUOTE_DEPOSIT  varsayılan 1e6 (1 birim, 6 ondalık)
///   WINDOW_SECONDS     varsayılan 30
///   FEE_BPS            varsayılan 30
///
/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $PK
/// Monad gaz LİMİTİ üzerinden ücretlendirir: forge'un tahminini kullanın, elle yüksek limit vermeyin.
contract Deploy is Script {
    function run() external returns (DarkVault vault, OwnerEnclaveRegistry registry) {
        address owner = vm.envAddress("OWNER");
        address enclave = vm.envOr("ENCLAVE_ADDRESS", address(0));
        address quote = vm.envOr("QUOTE_TOKEN", address(0));
        uint128 minQuote = uint128(vm.envOr("MIN_QUOTE_DEPOSIT", uint256(1e6)));
        uint256 windowSeconds = vm.envOr("WINDOW_SECONDS", uint256(30));
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(30));

        uint256 deployBlock = block.number;
        vm.startBroadcast();
        if (quote == address(0)) {
            quote = address(new TestToken("Dark Test USD", "dUSD", 6));
            console2.log("test quote token", quote);
        }
        // Registry'yi önce yayıncıya ver, enclave'i kaydet, sonra sahipliği devret (2 adımlı).
        registry = new OwnerEnclaveRegistry(msg.sender);
        if (enclave != address(0)) registry.register(enclave, bytes32(0));
        if (owner != msg.sender) registry.transferOwnership(owner);

        // circuits/keys/spend_final.zkey ile eşleşen verifier
        ISpendVerifier verifier = ISpendVerifier(address(new Groth16Verifier()));
        // Poseidon kütüphaneleri via_ir olmadan derlenmiş halleriyle ayrı deploy edilir (bkz. IPoseidon.sol)
        IPoseidonT3 p2 = IPoseidonT3(vm.deployCode("out/PoseidonT3.sol/PoseidonT3.json"));
        IPoseidonT4 p3 = IPoseidonT4(vm.deployCode("out/PoseidonT4.sol/PoseidonT4.json"));
        vault =
            new DarkVault(owner, registry, verifier, p2, p3, quote, minQuote, block.timestamp, windowSeconds, feeBps);
        vm.stopBroadcast();

        console2.log("registry", address(registry));
        console2.log("verifier", address(verifier));
        console2.log("vault   ", address(vault));
        console2.log("chainId ", block.chainid);

        // Relayer ve frontend adresleri buradan okur: deployments/<chainId>.json
        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", deployBlock);
        vm.serializeUint(k, "windowSeconds", windowSeconds);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "verifier", address(verifier));
        vm.serializeAddress(k, "quoteToken", quote);
        string memory json = vm.serializeAddress(k, "vault", address(vault));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
