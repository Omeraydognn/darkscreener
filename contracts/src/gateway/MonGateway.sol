// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {DarkUSD} from "./DarkUSD.sol";

interface IVaultDeposit {
    function deposit(address token, uint128 amount, uint256 secretHash) external;
}

/// @notice MON ⇄ gizli dolar köprüsü (testnet demo kuru).
///
/// Yatırma: kullanıcı MON gönderir → kurdan dUSD basılır → doğrudan DarkVault'a gizli not olarak
/// yatırılır. Notun sahibi, `secretHash`'in ön görüntüsünü bilen kişidir (tarayıcıdaki gizli hesap).
///
/// Çekme: vault'tan dUSD, alıcıya özgü anahtarsız bir kutu adresine (`boxOf(to)`, CREATE2) çekilir;
/// `redeem(to)` kutuyu boşaltır, dUSD'yi yakar ve karşılığı MON'u `to`'ya öder. Kutu adresi
/// yalnızca `to`'ya bağlı olduğundan çekim kanıtı (withdrawContext) alıcıyı zaten sabitler;
/// `redeem`'i herkes çağırabilir ama MON yalnızca `to`'ya gider.
///
/// @dev Kur sabit ve sahibin belirlediği demo değeridir; testnet MON'un piyasa fiyatı yoktur.
///      MON ödemesi kontrattaki bakiyeyle sınırlıdır.
contract MonGateway is Ownable2Step, ReentrancyGuardTransient {
    DarkUSD public immutable dusd;
    IVaultDeposit public immutable vault;
    /// @notice 1 MON (1e18 wei) karşılığı dUSD birimi (6 ondalık). Ör. 10e6 = 1 MON başına 10 $.
    uint256 public usdPerMon;

    event NativeDeposited(address indexed from, uint256 value, uint128 amount, uint256 secretHash);
    event Converted(address indexed to, uint256 value, uint256 amount);
    event Redeemed(address indexed to, uint256 amount, uint256 value);
    event RateSet(uint256 usdPerMon);

    error ZeroAmount();
    error AmountMismatch();
    error TransferFailed();

    constructor(address owner_, DarkUSD dusd_, IVaultDeposit vault_, uint256 usdPerMon_) Ownable(owner_) {
        if (usdPerMon_ == 0) revert ZeroAmount();
        dusd = dusd_;
        vault = vault_;
        usdPerMon = usdPerMon_;
        dusd_.approve(address(vault_), type(uint256).max);
        emit RateSet(usdPerMon_);
    }

    receive() external payable {}

    function quoteDeposit(uint256 value) public view returns (uint256) {
        return value * usdPerMon / 1e18;
    }

    function quoteRedeem(uint256 amount) public view returns (uint256) {
        return amount * 1e18 / usdPerMon;
    }

    /// @notice MON'u gizli dolar notu olarak vault'a yatır. `expected` tarayıcının notu hesapladığı
    ///         tutardır; kur arada değişirse işlem geri döner (not hesaplanamaz hale gelmesin).
    function depositNative(uint256 secretHash, uint128 expected) external payable nonReentrant {
        uint256 amount = quoteDeposit(msg.value);
        if (amount == 0) revert ZeroAmount();
        if (amount != expected) revert AmountMismatch();
        dusd.mint(address(this), amount);
        vault.deposit(address(dusd), expected, secretHash);
        emit NativeDeposited(msg.sender, msg.value, expected, secretHash);
    }

    /// @notice MON'u açık dUSD'ye çevir (ör. launchpad'in başlangıç likiditesi).
    function convert(address to) external payable nonReentrant returns (uint256 amount) {
        amount = quoteDeposit(msg.value);
        if (amount == 0) revert ZeroAmount();
        dusd.mint(to, amount);
        emit Converted(to, msg.value, amount);
    }

    /// @notice `to` için çekim kutusu (anahtarı olmayan CREATE2 adresi).
    function boxOf(address to) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _salt(to), keccak256(type(RedeemBox).creationCode))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Kutudaki dUSD'yi yakar ve karşılığı MON'u `to`'ya öder.
    function redeem(address payable to) external nonReentrant returns (uint256 value) {
        address box = boxOf(to);
        if (box.code.length == 0) new RedeemBox{salt: _salt(to)}();
        uint256 amount = RedeemBox(box).sweep();
        if (amount == 0) revert ZeroAmount();
        value = quoteRedeem(amount);
        dusd.burn(amount);
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert TransferFailed();
        emit Redeemed(to, amount, value);
    }

    function setRate(uint256 usdPerMon_) external onlyOwner {
        if (usdPerMon_ == 0) revert ZeroAmount();
        usdPerMon = usdPerMon_;
        emit RateSet(usdPerMon_);
    }

    function _salt(address to) private pure returns (bytes32) {
        return bytes32(uint256(uint160(to)));
    }
}

/// @notice Çekim kutusu: yalnızca kendisini oluşturan gateway boşaltabilir.
contract RedeemBox {
    MonGateway private immutable gateway;

    error NotGateway();

    constructor() {
        gateway = MonGateway(payable(msg.sender));
    }

    function sweep() external returns (uint256 amount) {
        if (msg.sender != address(gateway)) revert NotGateway();
        DarkUSD t = gateway.dusd();
        amount = t.balanceOf(address(this));
        if (amount != 0) t.transfer(address(gateway), amount);
    }
}
