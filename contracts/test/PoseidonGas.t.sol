// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";

contract PoseidonGasTest is Test {
    function test_poseidonT3Gas() public {
        uint256 x = PoseidonT3.hash([uint256(1), uint256(2)]);
        uint256 g = gasleft();
        for (uint256 i = 0; i < 10; ++i) {
            x = PoseidonT3.hash([x, uint256(i)]);
        }
        console2.log("10x PoseidonT3", g - gasleft());
        assertEq(
            PoseidonT3.hash([uint256(1), uint256(2)]),
            0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a
        );
    }
}
