// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {MonGateway} from "../gateway/MonGateway.sol";

interface IVaultLaunch {
    function createPoolFor(
        address creator,
        uint32 poolId,
        address baseToken,
        uint128 base,
        uint128 quote,
        uint128 minBaseDeposit
    ) external;
    function quoteToken() external view returns (address);
}

/// @notice İzinsiz proje açılışı: sabit arzlı token basar, gönderilen MON'u gateway kurundan dUSD'ye
///         çevirip başlangıç likiditesi yapar ve gizli havuzu açar. Kalan arz projeyi açana gider.
///         Proje meta verisi (açıklama, site, ekip...) zincir dışında tutulur; burada yalnızca
///         özeti (`metadataHash`) saklanır, relayer yalnızca `creator` imzalı meta veriyi kabul eder.
contract LaunchPad is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Launch {
        address creator;
        address token;
        bytes32 metadataHash;
        uint64 time;
    }

    /// @notice Küratörlü havuzlarla çakışmasın diye launchpad havuzları 1000'den başlar.
    uint32 public constant FIRST_POOL_ID = 1000;
    uint128 public constant MIN_QUOTE = 10e6; // en az 10 $ başlangıç likiditesi

    IVaultLaunch public immutable vault;
    MonGateway public immutable gateway;
    uint32 public nextPoolId = FIRST_POOL_ID;
    mapping(uint32 => Launch) public launches;

    event Launched(
        uint32 indexed poolId,
        address indexed token,
        address indexed creator,
        bytes32 metadataHash,
        uint256 supply,
        uint128 liquidityBase,
        uint128 liquidityQuote
    );

    error BadParams();

    constructor(IVaultLaunch vault_, MonGateway gateway_) {
        vault = vault_;
        gateway = gateway_;
    }

    function launch(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        uint128 liquidityBase,
        bytes32 metadataHash
    ) external payable nonReentrant returns (uint32 poolId, address token) {
        uint256 nl = bytes(name).length;
        uint256 sl = bytes(symbol).length;
        if (nl == 0 || nl > 48 || sl == 0 || sl > 11 || liquidityBase == 0 || supply < liquidityBase) {
            revert BadParams();
        }
        uint256 quote = gateway.convert{value: msg.value}(address(this));
        if (quote < MIN_QUOTE || quote > type(uint128).max) revert BadParams();

        token = address(new LaunchToken(name, symbol, supply, address(this)));
        poolId = nextPoolId++;
        IERC20(token).forceApprove(address(vault), liquidityBase);
        IERC20(vault.quoteToken()).forceApprove(address(vault), quote);
        vault.createPoolFor(msg.sender, poolId, token, liquidityBase, uint128(quote), 1e15);
        if (supply > liquidityBase) IERC20(token).safeTransfer(msg.sender, supply - liquidityBase);

        launches[poolId] = Launch(msg.sender, token, metadataHash, uint64(block.timestamp));
        emit Launched(poolId, token, msg.sender, metadataHash, supply, liquidityBase, uint128(quote));
    }

    function creatorOf(uint32 poolId) external view returns (address) {
        return launches[poolId].creator;
    }
}
