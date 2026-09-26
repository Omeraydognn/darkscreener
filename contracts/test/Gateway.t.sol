// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {OwnerEnclaveRegistry} from "../src/registry/OwnerEnclaveRegistry.sol";
import {ISpendVerifier} from "../src/interfaces/ISpendVerifier.sol";
import {Groth16Verifier} from "../src/verifier/SpendVerifier.sol";
import {IPoseidonT3, IPoseidonT4} from "../src/interfaces/IPoseidon.sol";
import {NoteLib} from "../src/lib/NoteLib.sol";
import {DarkUSD} from "../src/gateway/DarkUSD.sol";
import {MonGateway, RedeemBox, IVaultDeposit} from "../src/gateway/MonGateway.sol";
import {LaunchPad, IVaultLaunch} from "../src/launch/LaunchPad.sol";
import {LaunchToken} from "../src/launch/LaunchToken.sol";

/// @notice MON ⇄ gizli dolar köprüsü ve izinsiz proje açılışı.
contract GatewayTest is Test {
    DarkVault vault;
    DarkUSD dusd;
    MonGateway gw;
    LaunchPad pad;
    IPoseidonT4 p3;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_800_000_000);
        OwnerEnclaveRegistry registry = new OwnerEnclaveRegistry(owner);
        ISpendVerifier verifier = ISpendVerifier(address(new Groth16Verifier()));
        IPoseidonT3 p2 = IPoseidonT3(deployCode("out/PoseidonT3.sol/PoseidonT3.json"));
        p3 = IPoseidonT4(deployCode("out/PoseidonT4.sol/PoseidonT4.json"));
        dusd = new DarkUSD(owner);
        vault = new DarkVault(owner, registry, verifier, p2, p3, address(dusd), 1e6, block.timestamp, 60, 30);
        gw = new MonGateway(owner, dusd, IVaultDeposit(address(vault)), 10e6); // 1 MON = 10 $
        pad = new LaunchPad(IVaultLaunch(address(vault)), gw);
        vm.startPrank(owner);
        dusd.setMinter(address(gw), true);
        vault.setLaunchpad(address(pad));
        vm.stopPrank();
        vm.deal(alice, 100 ether);
    }

    function test_depositNativeCreatesPrivateDollarNote() public {
        uint256 secretHash = 12345;
        uint128 expected = uint128(gw.quoteDeposit(2.5 ether));
        assertEq(expected, 25e6);
        uint256 rootBefore = vault.noteRoot();

        vm.prank(alice);
        gw.depositNative{value: 2.5 ether}(secretHash, expected);

        assertEq(dusd.balanceOf(address(vault)), 25e6, "dUSD in vault");
        assertEq(address(gw).balance, 2.5 ether, "MON in gateway");
        assertTrue(vault.noteRoot() != rootBefore, "note inserted");
    }

    function test_depositRejectsStaleQuote() public {
        vm.prank(owner);
        gw.setRate(20e6);
        vm.prank(alice);
        vm.expectRevert(MonGateway.AmountMismatch.selector);
        gw.depositNative{value: 1 ether}(1, 10e6);
    }

    function test_depositBelowVaultMinimumReverts() public {
        vm.prank(alice);
        vm.expectRevert(DarkVault.BelowMinDeposit.selector);
        gw.depositNative{value: 0.05 ether}(1, 5e5);
    }

    function test_redeemPaysMonOnlyToBoxOwner() public {
        vm.prank(alice);
        gw.depositNative{value: 5 ether}(1, 50e6);
        address bob = makeAddr("bob");
        address box = gw.boxOf(bob);
        // vault.withdraw'un kutuya dUSD göndermesinin yerine geçer
        vm.prank(address(vault));
        dusd.transfer(box, 20e6);

        uint256 supply = dusd.totalSupply();
        vm.prank(makeAddr("anyone"));
        uint256 paid = gw.redeem(payable(bob));
        assertEq(paid, 2 ether);
        assertEq(bob.balance, 2 ether);
        assertEq(dusd.totalSupply(), supply - 20e6, "dUSD burned");
        assertEq(dusd.balanceOf(box), 0);

        // İkinci çekim aynı kutuyu yeniden kullanır
        vm.prank(address(vault));
        dusd.transfer(box, 10e6);
        gw.redeem(payable(bob));
        assertEq(bob.balance, 3 ether);

        // Boş kutu
        vm.expectRevert(MonGateway.ZeroAmount.selector);
        gw.redeem(payable(bob));
    }

    function test_boxCannotBeSweptByOthers() public {
        vm.prank(alice);
        gw.depositNative{value: 1 ether}(1, 10e6);
        address box = gw.boxOf(alice);
        vm.prank(address(vault));
        dusd.transfer(box, 5e6);
        gw.redeem(payable(alice)); // kutu artık kodlu
        vm.prank(address(vault));
        dusd.transfer(box, 1e6);
        vm.expectRevert(RedeemBox.NotGateway.selector);
        RedeemBox(box).sweep();
    }

    function test_onlyMintersMint() public {
        vm.expectRevert(DarkUSD.NotMinter.selector);
        dusd.mint(alice, 1);
    }

    function test_launchCreatesPoolForCreator() public {
        bytes32 meta = keccak256("arfdao");
        vm.prank(alice);
        (uint32 poolId, address token) = pad.launch{value: 3 ether}("ArfDAO", "ARF", 10_000_000e18, 1_000_000e18, meta);

        assertEq(poolId, 1000);
        assertEq(pad.creatorOf(poolId), alice);
        (address baseToken, address creator,,, uint128 initBase, uint128 initQuote) = vault.pools(poolId);
        assertEq(baseToken, token);
        assertEq(creator, alice, "escape liquidity goes to creator");
        assertEq(initBase, 1_000_000e18);
        assertEq(initQuote, 30e6);
        assertEq(LaunchToken(token).balanceOf(alice), 9_000_000e18, "rest of supply to creator");
        assertEq(vault.poolOfBaseToken(token), poolId);
        assertEq(vault.minDeposit(token), 1e15);

        vm.prank(alice);
        (uint32 second,) = pad.launch{value: 1 ether}("Other", "OTH", 1e24, 1e24, meta);
        assertEq(second, 1001);
    }

    function test_launchRequiresMinimumLiquidity() public {
        vm.prank(alice);
        vm.expectRevert(LaunchPad.BadParams.selector);
        pad.launch{value: 0.5 ether}("X", "X", 1e18, 1e18, 0);
    }

    function test_createPoolForOnlyLaunchpad() public {
        vm.prank(alice);
        vm.expectRevert(DarkVault.NotOwner.selector);
        vault.createPoolFor(alice, 7, address(1), 1, 1, 1);
    }
}
