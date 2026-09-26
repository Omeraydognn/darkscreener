// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice drand quicknet tur/zaman dönüşümü. `tee-core/src/timelock.rs` ile birebir aynı.
library DrandQuicknet {
    uint256 internal constant GENESIS = 1_692_803_367;
    uint256 internal constant PERIOD = 3;

    /// @notice Turun yayınlandığı unix zamanı.
    function roundTime(uint256 round) internal pure returns (uint256) {
        return GENESIS + (round == 0 ? 0 : round - 1) * PERIOD;
    }

    /// @notice `ts` anında veya hemen sonrasında yayınlanan ilk tur.
    function roundAt(uint256 ts) internal pure returns (uint256) {
        if (ts <= GENESIS) return 1;
        return (ts - GENESIS + PERIOD - 1) / PERIOD + 1;
    }
}
