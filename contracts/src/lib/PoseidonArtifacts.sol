// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Yalnızca derleme için: PoseidonT3/T4 artifact'lerinin (via_ir olmadan) üretilmesini sağlar.
// Vault bunları import etmez; deploy script'i `vm.deployCode("PoseidonT3.sol:PoseidonT3")` ile yayınlar.
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";
