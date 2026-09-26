// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {DarkUSD} from "../src/gateway/DarkUSD.sol";
import {LaunchToken} from "../src/launch/LaunchToken.sol";

/// @notice YALNIZCA yerel/testnet: sabit arzlı demo proje token'ları basar ve küratörlü havuzlarını açar.
/// Vault sahibi anahtarıyla çalıştırılır; yayıncı dUSD basıcısı olmalı (Deploy ayarlar).
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
        DarkUSD quote = DarkUSD(vault.quoteToken());
        Spec[4] memory specs = [
            Spec("Nebula Compute", "NEBC", 1_000_000e18, 500_000e6), // 0.50 $
            Spec("Orbit Relay", "ORBR", 400_000e18, 800_000e6), // 2.00 $
            Spec("Vela Storage", "VELS", 5_000_000e18, 250_000e6), // 0.05 $
            Spec("ArfDAO", "ARF", 5_000_000e18, 1_100_000e6) // 0.22 $ (~10 TL)
        ];

        address[4] memory bases;
        vm.startBroadcast();
        for (uint256 i = 0; i < specs.length; ++i) {
            // Toplam arzın %20'si havuza, kalanı proje hazinesine (yayıncı)
            LaunchToken b = new LaunchToken(specs[i].name, specs[i].symbol, uint256(specs[i].base) * 5, msg.sender);
            quote.mint(msg.sender, specs[i].quote);
            b.approve(address(vault), specs[i].base);
            quote.approve(address(vault), specs[i].quote);
            // forge-lint: disable-next-line(unsafe-typecast) i < 4
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

    function _arr(address[4] memory a) internal pure returns (address[] memory out) {
        out = new address[](4);
        for (uint256 i = 0; i < 4; ++i) {
            out[i] = a[i];
        }
    }
}
