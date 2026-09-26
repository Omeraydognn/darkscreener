// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice poseidon-solidity kütüphanelerinin (PoseidonT3/T4) ayrı deploy edilmiş hali.
/// @dev Kaynak olarak import edilmez: kütüphane via_ir OLMADAN derlenir (via_ir maliyeti ~2 katına
///      çıkarıyor), vault ise via_ir ile. `pure` kütüphane fonksiyonları STATICCALL ile çağrılabilir.
interface IPoseidonT3 {
    function hash(uint256[2] calldata) external pure returns (uint256);
}

interface IPoseidonT4 {
    function hash(uint256[3] calldata) external pure returns (uint256);
}
