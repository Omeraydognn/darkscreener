// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IEnclaveRegistry} from "../interfaces/IEnclaveRegistry.sol";

/// @title OwnerEnclaveRegistry
/// @notice YALNIZCA TESTNET. Enclave adreslerini sahip (multisig) ekler/çıkarır.
/// @dev Donanım attestation'ı DOĞRULAMAZ: güven sahibe aittir. Faz 1 CVM adımında
///      attestation'ı zincir üstünde (veya ZK ile) doğrulayan bir registry ile değiştirilecek.
///      Vault yalnızca `IEnclaveRegistry` arayüzünü bildiği için değişim vault'a dokunmaz.
contract OwnerEnclaveRegistry is IEnclaveRegistry, Ownable2Step {
    mapping(address => bool) public override isEnclave;

    event EnclaveRegistered(address indexed signer, bytes32 indexed measurement);
    event EnclaveRevoked(address indexed signer);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @param measurement Enclave imajının ölçümü (PCR0 / MRTD özeti); kayıt amaçlı, doğrulanmaz.
    function register(address signer, bytes32 measurement) external onlyOwner {
        isEnclave[signer] = true;
        emit EnclaveRegistered(signer, measurement);
    }

    function revoke(address signer) external onlyOwner {
        isEnclave[signer] = false;
        emit EnclaveRevoked(signer);
    }
}
