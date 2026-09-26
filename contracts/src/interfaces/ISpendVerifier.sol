// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice circuits/scripts/ceremony.sh'in ürettiği Groth16 verifier'ı (SpendVerifier.sol).
/// @dev Açık girdi sırası: [root, nullifier, changeCommitment, spendCommitment, ctxHash]
interface ISpendVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[5] calldata pubSignals
    ) external view returns (bool);
}
