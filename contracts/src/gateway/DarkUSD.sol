// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Gizli nakit birimi: 1 dUSD = 1 dolar (6 ondalık). Yalnızca yetkili basıcılar (MonGateway,
///         başlangıç likiditesi için sahip) basabilir; herkes kendi bakiyesini yakabilir.
contract DarkUSD is ERC20, Ownable2Step {
    mapping(address => bool) public minters;

    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();

    constructor(address owner_) ERC20("Dark USD", "dUSD") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
