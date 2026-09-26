// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {TestToken} from "../test/utils/TestTokens.sol";

/// @notice YALNIZCA yerel/testnet: test proje tokenları basar ve havuzlarını açar (kurgusal projeler).
/// Vault sahibi anahtarıyla çalıştırılır. Quote token, Deploy'un bastığı TestToken olmalı (açık mint).
///   VAULT=... forge script script/LocalSetup.s.sol --rpc-url $RPC --broadcast --private-key $OWNER_PK
contract LocalSetup is Script {
    struct Spec {
        string name;
        string symbol;
        uint128 base;
        uint128 quote;
    }

    function run() external {
        DarkVault vault = DarkVault(vm.envAddress("VAULT"));
        TestToken quote = TestToken(vault.quoteToken());
        Spec[3] memory specs = [
            Spec("Nebula Compute", "NEBC", 1_000_000e18, 500_000e6), // 0.50 dUSD
            Spec("Orbit Relay", "ORBR", 400_000e18, 800_000e6), // 2.00 dUSD
            Spec("Vela Storage", "VELS", 5_000_000e18, 250_000e6) // 0.05 dUSD
        ];

        address[3] memory bases;
        vm.startBroadcast();
        for (uint256 i = 0; i < specs.length; ++i) {
            TestToken b = new TestToken(specs[i].name, specs[i].symbol, 18);
            b.mint(msg.sender, specs[i].base);
            quote.mint(msg.sender, specs[i].quote);
            b.approve(address(vault), specs[i].base);
            quote.approve(address(vault), specs[i].quote);
            // forge-lint: disable-next-line(unsafe-typecast) i < 3
            vault.createPool(uint32(i + 1), address(b), specs[i].base, specs[i].quote, 1e15);
            bases[i] = address(b);
            console2.log(specs[i].symbol, address(b));
        }
        vm.stopBroadcast();

        string memory k = "setup";
        vm.serializeAddress(k, "baseToken", bases[0]); // e2e-local geriye uyumluluğu
        string memory json = vm.serializeAddress(k, "baseTokens", _arr(bases));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-setup.json"));
    }

    function _arr(address[3] memory a) internal pure returns (address[] memory out) {
        out = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            out[i] = a[i];
        }
    }
}
