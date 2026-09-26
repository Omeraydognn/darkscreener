// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoseidonT4} from "../interfaces/IPoseidon.sol";

/// @notice Not formülleri — spend.circom ve tee-core/src/note.rs ile aynı.
///   note            = Poseidon3(token, amount, secretHash),  secretHash = Poseidon2(owner, blinding)
///   spendCommitment = Poseidon3(token, amount, spendBlinding)
/// Kullanıcı spendBlinding'i secretHash biçiminde seçer; böylece spendCommitment kendisi de
/// kullanıcıya ait geçerli bir nottur ve iade/kaçışta açılış olmadan ağaca eklenebilir.
library NoteLib {
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function commitment(IPoseidonT4 h, address token, uint256 amount, uint256 secretHash)
        internal
        view
        returns (uint256)
    {
        return h.hash([uint256(uint160(token)), amount, secretHash]);
    }

    function toField(bytes32 h) internal pure returns (uint256) {
        return uint256(h) % SNARK_FIELD;
    }
}
