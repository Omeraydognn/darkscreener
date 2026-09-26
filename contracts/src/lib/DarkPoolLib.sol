// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/// @notice Enclave (Rust `tee-core`) ile bayt bayt aynı olması gereken formatlar.
/// Her fonksiyonun Rust karşılığı yorumda; çapraz uyum `test/fixtures` ile test edilir.
library DarkPoolLib {
    uint8 internal constant STATUS_FILLED = 1;
    uint8 internal constant STATUS_REFUNDED = 2;

    struct Settlement {
        uint256 chainId;
        address vault;
        uint256 batchId;
        bytes32 prevStateHash;
        bytes32 newStateHash;
        bytes32 resultsRoot;
        uint256 unlockRound;
        bytes32 capsuleHash;
        bytes32 summaryHash;
        address quoteToken;
        uint256 feeBps;
        bytes32 ordersHash;
        bytes32 poolsHash;
        bytes32 reservesCommitment;
        bytes32 lotsHash;
    }

    /// @dev digest.rs `Settlement::digest`
    function settlementDigest(Settlement memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                abi.encodePacked(
                    "darkpool/settle/v1", s.chainId, s.vault, s.batchId, s.prevStateHash, s.newStateHash, s.resultsRoot
                ),
                abi.encodePacked(
                    s.unlockRound,
                    s.capsuleHash,
                    s.summaryHash,
                    s.quoteToken,
                    s.feeBps,
                    s.ordersHash,
                    s.poolsHash,
                    s.reservesCommitment,
                    s.lotsHash
                )
            )
        );
    }

    /// @dev batch.rs `OrderResult::leaf`
    function resultLeaf(bytes32 orderId, uint8 status, bytes32 commitment, bytes32 sealedResultHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(orderId, status, commitment, sealedResultHash));
    }

    /// @dev batch.rs `orders_hash` içindeki shard zinciri adımı
    function orderChainStep(bytes32 chain, bytes32 orderId, uint256 spendCommitment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chain, orderId, spendCommitment));
    }

    /// @dev batch.rs `lots_hash` adımı
    function lotChainStep(
        bytes32 chain,
        bytes32 sellOrderId,
        bool filled,
        bytes32 remainderCommitment,
        bytes32 sealedRemainderHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chain, sellOrderId, filled, remainderCommitment, sealedRemainderHash));
    }

    /// @dev batch.rs `pools_hash` adımı
    function poolChainStep(bytes32 chain, uint32 poolId, address baseToken, uint128 base, uint128 quote)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(chain, poolId, baseToken, base, quote));
    }

    /// @dev reveal.rs `reserves_commitment`
    function reservesCommitment(
        uint256 batchId,
        bytes32 salt,
        uint32[] calldata poolIds,
        uint128[] calldata base,
        uint128[] calldata quote
    ) internal pure returns (bytes32) {
        bytes memory packed = abi.encodePacked("darkpool/reserves/v1", batchId, salt);
        for (uint256 i = 0; i < poolIds.length; ++i) {
            packed = bytes.concat(packed, abi.encodePacked(poolIds[i], base[i], quote[i]));
        }
        return keccak256(packed);
    }

    /// @dev batch.rs `merkle_root`: soldan dolu, tek kalan düğüm yukarı çıkar, çift hash
    ///      OpenZeppelin `commutativeKeccak256`. `leaves` yerinde ezilir.
    function merkleRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        while (n > 1) {
            uint256 m = 0;
            for (uint256 i = 0; i < n; i += 2) {
                leaves[m++] = i + 1 < n ? Hashes.commutativeKeccak256(leaves[i], leaves[i + 1]) : leaves[i];
            }
            n = m;
        }
        return leaves[0];
    }
}
