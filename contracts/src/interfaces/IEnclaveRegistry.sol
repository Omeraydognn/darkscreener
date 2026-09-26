// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Settlement imzasını atan adresin doğrulanmış bir enclave'e ait olup olmadığını söyler.
/// @dev Vault yalnızca bu arayüzü bilir. Testnet'te `OwnerEnclaveRegistry`; üretimde
///      TEE attestation'ını (Oyster/Nitro/TDX) doğrulayan bir registry ile değiştirilir.
interface IEnclaveRegistry {
    function isEnclave(address signer) external view returns (bool);
}
