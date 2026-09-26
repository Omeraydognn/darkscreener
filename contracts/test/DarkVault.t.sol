// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2, stdStorage, StdStorage} from "forge-std/Test.sol";
import {DarkVault} from "../src/DarkVault.sol";
import {OwnerEnclaveRegistry} from "../src/registry/OwnerEnclaveRegistry.sol";
import {ISpendVerifier} from "../src/interfaces/ISpendVerifier.sol";
import {Groth16Verifier} from "../src/verifier/SpendVerifier.sol";
import {DrandQuicknet} from "../src/lib/DrandQuicknet.sol";
import {NoteLib} from "../src/lib/NoteLib.sol";
import {DarkPoolLib} from "../src/lib/DarkPoolLib.sol";
import {TestToken, FeeOnTransferToken} from "./utils/TestTokens.sol";

/// @notice Rust enclave + Circom kanıtlarıyla (test/fixtures/e2e.json) uçtan uca shielded test.
/// Fixture'daki kapsüller drand quicknet round 1000'e kilitli; not ağacı indeksleri bu sıraya bağlı:
///   GENESIS + 1     havuzlar (pencere 1)          GENESIS + 61   batch 1 settle
///   GENESIS + 65    deposit × 5 (not 0..4)        GENESIS + 70   gizli emir × 5 (para üstü 5..9)
///   GENESIS + 121   batch 2 settle                GENESIS + 122  iadeler (10, 11)
///   roundTime(1000) claimNote × 3 (12..14)        sonra          withdraw × 7
contract DarkVaultTest is Test {
    using stdStorage for StdStorage;

    uint256 constant GENESIS = 1_692_200_000;
    uint256 constant WINDOW = 60;
    uint256 constant UNLOCK = 1_692_806_364; // DrandQuicknet.roundTime(1000)

    string fx;
    DarkVault vault;
    OwnerEnclaveRegistry registry;
    TestToken usdc;
    TestToken tokenA;
    TestToken tokenB;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address enclave;

    function setUp() public {
        fx = vm.readFile("test/fixtures/e2e.json");
        vm.chainId(vm.parseJsonUint(fx, ".chainId"));
        vm.warp(GENESIS);

        usdc = TestToken(_deployToken(".usdc", "USD Coin", "USDC", 6));
        tokenA = TestToken(_deployToken(".tokenA", "Project A", "PRJA", 18));
        tokenB = TestToken(_deployToken(".tokenB", "Project B", "PRJB", 18));

        enclave = vm.parseJsonAddress(fx, ".enclave");
        registry = new OwnerEnclaveRegistry(owner);
        vm.prank(owner);
        registry.register(enclave, bytes32(0));
        ISpendVerifier verifier = ISpendVerifier(address(new Groth16Verifier()));
        address p2 = deployCode("out/PoseidonT3.sol/PoseidonT3.json");
        address p3 = deployCode("out/PoseidonT4.sol/PoseidonT4.json");

        address vaultAddr = vm.parseJsonAddress(fx, ".vault");
        deployCodeTo(
            "DarkVault.sol:DarkVault",
            abi.encode(
                owner,
                registry,
                verifier,
                p2,
                p3,
                address(usdc),
                uint128(1e6),
                GENESIS,
                WINDOW,
                vm.parseJsonUint(fx, ".feeBps")
            ),
            vaultAddr
        );
        vault = DarkVault(vaultAddr);
    }

    // ================================================================ yardımcılar

    function _noLots() internal pure returns (DarkVault.LotUpdate[] memory) {
        return new DarkVault.LotUpdate[](0);
    }

    function _deployToken(string memory key, string memory name, string memory sym, uint8 dec)
        internal
        returns (address a)
    {
        a = vm.parseJsonAddress(fx, key);
        deployCodeTo("TestTokens.sol:TestToken", abi.encode(name, sym, dec), a);
    }

    function _user(uint256 i) internal returns (address) {
        return makeAddr(string.concat("user", vm.toString(i)));
    }

    function _str(string memory path) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(fx, path));
    }

    function _u(string memory path) internal view returns (uint256) {
        return uint256(vm.parseJsonBytes32(fx, path));
    }

    function _pair(string memory path) internal view returns (uint256[2] memory out) {
        bytes32[] memory v = vm.parseJsonBytes32Array(fx, path);
        out = [uint256(v[0]), uint256(v[1])];
    }

    function _proof(string memory p) internal view returns (DarkVault.SpendProof memory sp) {
        sp.a = _pair(string.concat(p, ".a"));
        sp.b = [_pair(string.concat(p, ".b0")), _pair(string.concat(p, ".b1"))];
        sp.c = _pair(string.concat(p, ".c"));
        sp.root = _u(string.concat(p, ".root"));
        sp.nullifier = _u(string.concat(p, ".nullifier"));
        sp.changeCommitment = _u(string.concat(p, ".changeCommitment"));
        sp.spendCommitment = _u(string.concat(p, ".spendCommitment"));
    }

    function _order(uint256 i) internal view returns (bytes memory ct, DarkVault.SpendProof memory sp) {
        string memory o = string.concat(".orders[", vm.toString(i), "]");
        ct = vm.parseJsonBytes(fx, string.concat(o, ".ciphertext"));
        sp = _proof(string.concat(o, ".proof"));
    }

    function _createPools() internal {
        vm.warp(GENESIS + 1);
        for (uint256 i = 0; i < 2; ++i) {
            string memory p = string.concat(".pools[", vm.toString(i), "]");
            address base = vm.parseJsonAddress(fx, string.concat(p, ".baseToken"));
            uint128 baseAmt = uint128(_str(string.concat(p, ".base")));
            uint128 quoteAmt = uint128(_str(string.concat(p, ".quote")));
            TestToken(base).mint(owner, baseAmt);
            usdc.mint(owner, quoteAmt);
            vm.startPrank(owner);
            TestToken(base).approve(address(vault), baseAmt);
            usdc.approve(address(vault), quoteAmt);
            vault.createPool(uint32(vm.parseJsonUint(fx, string.concat(p, ".poolId"))), base, baseAmt, quoteAmt, 1e15);
            vm.stopPrank();
        }
    }

    function _deposit(uint256 i) internal {
        string memory n = string.concat(".notes[", vm.toString(i), "]");
        address token = vm.parseJsonAddress(fx, string.concat(n, ".token"));
        uint128 amount = uint128(_str(string.concat(n, ".amount")));
        address user = _user(i);
        TestToken(token).mint(user, amount);
        vm.startPrank(user);
        TestToken(token).approve(address(vault), amount);
        vault.deposit(token, amount, _u(string.concat(n, ".secretHash")));
        vm.stopPrank();
    }

    function _depositAll() internal {
        vm.warp(GENESIS + 65);
        for (uint256 i = 0; i < vm.parseJsonUint(fx, ".noteCount"); ++i) {
            _deposit(i);
        }
    }

    function _submitAll() internal {
        vm.warp(GENESIS + 70);
        for (uint256 i = 0; i < vm.parseJsonUint(fx, ".orderCount"); ++i) {
            (bytes memory ct, DarkVault.SpendProof memory sp) = _order(i);
            vm.prank(relayer); // gönderen önemsiz: kullanıcının adresi emirle ilişkilenmez
            vault.submitShieldedOrder(ct, sp);
        }
    }

    function _results(string memory b) internal view returns (DarkVault.Result[] memory rs) {
        uint256 n = vm.parseJsonUint(fx, string.concat(b, ".resultCount"));
        rs = new DarkVault.Result[](n);
        for (uint256 i = 0; i < n; ++i) {
            string memory r = string.concat(b, ".results[", vm.toString(i), "]");
            rs[i] = DarkVault.Result({
                orderId: vm.parseJsonBytes32(fx, string.concat(r, ".orderId")),
                status: uint8(vm.parseJsonUint(fx, string.concat(r, ".status"))),
                commitment: vm.parseJsonBytes32(fx, string.concat(r, ".commitment")),
                sealedResult: vm.parseJsonBytes(fx, string.concat(r, ".sealedResult"))
            });
        }
    }

    function _params(string memory b, uint64 window) internal view returns (DarkVault.SettleParams memory) {
        return DarkVault.SettleParams({
            window: window,
            unlockRound: uint64(vm.parseJsonUint(fx, string.concat(b, ".unlockRound"))),
            newSealedState: vm.parseJsonBytes(fx, string.concat(b, ".newSealedState")),
            capsule: vm.parseJsonBytes(fx, string.concat(b, ".capsule")),
            sealedSummary: vm.parseJsonBytes(fx, string.concat(b, ".sealedSummary")),
            reservesCommitment: vm.parseJsonBytes32(fx, string.concat(b, ".reservesCommitment")),
            signature: vm.parseJsonBytes(fx, string.concat(b, ".signature"))
        });
    }

    function _settle1() internal {
        vm.warp(GENESIS + 61);
        vault.settleBatch(_params(".batch1", 1), _results(".batch1"), _noLots());
    }

    function _settle2() internal {
        vm.warp(GENESIS + 121);
        vault.settleBatch(_params(".batch2", 2), _results(".batch2"), _noLots());
    }

    function _throughSettle2() internal {
        _createPools();
        _settle1();
        _depositAll();
        _submitAll();
        _settle2();
    }

    function _result(uint256 i) internal pure returns (string memory) {
        return string.concat(".batch2.results[", vm.toString(i), "]");
    }

    function _status(uint256 i) internal view returns (uint256) {
        return vm.parseJsonUint(fx, string.concat(_result(i), ".status"));
    }

    function _returnRefunded() internal {
        vm.warp(GENESIS + 122);
        for (uint256 i = 0; i < 5; ++i) {
            if (_status(i) != 2) continue;
            string memory r = _result(i);
            vault.returnRefunded(
                2,
                vm.parseJsonBytes32(fx, string.concat(r, ".orderId")),
                vm.parseJsonBytes32Array(fx, string.concat(r, ".proof"))
            );
        }
    }

    function _claim(uint256 i) internal {
        string memory r = _result(i);
        vault.claimNote(
            2,
            vm.parseJsonBytes32(fx, string.concat(r, ".orderId")),
            _u(string.concat(r, ".commitment")),
            vm.parseJsonBytes32(fx, string.concat(r, ".sealedResultHash")),
            vm.parseJsonBytes32Array(fx, string.concat(r, ".proof"))
        );
    }

    function _claimAll() internal {
        vm.warp(UNLOCK);
        for (uint256 i = 0; i < 5; ++i) {
            if (_status(i) == 1) _claim(i);
        }
    }

    function _withdrawArgs(uint256 i)
        internal
        view
        returns (DarkVault.SpendProof memory sp, address token, uint128 amount, uint256 blinding, address to)
    {
        string memory w = string.concat(".withdrawals[", vm.toString(i), "]");
        sp = _proof(string.concat(w, ".proof"));
        token = vm.parseJsonAddress(fx, string.concat(w, ".token"));
        amount = uint128(_str(string.concat(w, ".amount")));
        blinding = _u(string.concat(w, ".spendBlinding"));
        to = vm.parseJsonAddress(fx, string.concat(w, ".recipient"));
    }

    // ================================================================ uçtan uca

    /// @notice Tam yaşam döngüsü: yatır → gizli emir → settle → iade/claim → çek.
    ///         Sonunda vault'ta kalan = havuz rezervleri (enclave'in imzaladığı, 7 gün sonra açılan):
    ///         Rust FM-AMM + Poseidon notları + Groth16 + kontrat muhasebesi birebir tutarlı.
    function test_e2e_shieldedLifecycleConservesFunds() public {
        _createPools();
        _settle1();
        _depositAll();
        assertEq(vault.noteCount(), 5);
        assertEq(vault.noteRoot(), _u(".treeAfterDeposits"), "not agaci != circomlib");

        _submitAll();
        assertEq(vault.ordersHash(2), vm.parseJsonBytes32(fx, ".batch2.ordersHash"), "orders hash != enclave");
        assertEq(vault.noteCount(), 10);

        _settle2();
        (bytes32 root,, uint64 unlockTime,) = vault.batches(2);
        assertEq(root, vm.parseJsonBytes32(fx, ".batch2.resultsRoot"));
        assertEq(unlockTime, UNLOCK);

        _returnRefunded();
        vm.expectRevert(DarkVault.Locked.selector);
        _claim(0);
        _claimAll();
        assertEq(vault.noteCount(), 15);

        uint256 n = vm.parseJsonUint(fx, ".withdrawalCount");
        for (uint256 i = 0; i < n; ++i) {
            (DarkVault.SpendProof memory sp, address token, uint128 amount, uint256 blinding, address to) =
                _withdrawArgs(i);
            vault.withdraw(sp, token, amount, blinding, to);
            assertEq(TestToken(token).balanceOf(to), amount);
        }

        // Korunum: vault'ta yalnızca LP rezervleri kaldı
        uint256 q0 = _str(".batch2Summary.pools[0].quoteReserve");
        uint256 q1 = _str(".batch2Summary.pools[1].quoteReserve");
        assertEq(usdc.balanceOf(address(vault)), q0 + q1, "usdc");
        assertEq(tokenA.balanceOf(address(vault)), _str(".batch2Summary.pools[0].baseReserve"), "tokenA");
        assertEq(tokenB.balanceOf(address(vault)), _str(".batch2Summary.pools[1].baseReserve"), "tokenB");
    }

    // ================================================================ gizli emir saldırıları

    function test_order_proofBoundToCiphertext() public {
        _createPools();
        _depositAll();
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);
        ct[100] ^= 0x01; // başka ciphertext -> ctxHash değişir
        vm.expectRevert(DarkVault.InvalidSpendProof.selector);
        vault.submitShieldedOrder(ct, sp);
    }

    function test_order_rejectsDoubleSpendUnknownRootAndTamper() public {
        _createPools();
        _depositAll();
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);

        DarkVault.SpendProof memory badRoot = _proof(".orders[0].proof");
        badRoot.root = 12345;
        vm.expectRevert(DarkVault.UnknownRoot.selector);
        vault.submitShieldedOrder(ct, badRoot);

        DarkVault.SpendProof memory inflated = _proof(".orders[0].proof");
        inflated.spendCommitment = sp.spendCommitment + 1;
        vm.expectRevert(DarkVault.InvalidSpendProof.selector);
        vault.submitShieldedOrder(ct, inflated);

        vault.submitShieldedOrder(ct, sp);
        vm.expectRevert(DarkVault.DuplicateOrder.selector);
        vault.submitShieldedOrder(ct, sp);

        bytes memory other = vm.parseJsonBytes(fx, ".orders[0].ciphertext");
        other[50] ^= 0x01;
        vm.expectRevert(DarkVault.NullifierSpent.selector);
        vault.submitShieldedOrder(other, sp);

        vm.expectRevert(DarkVault.BadCiphertext.selector);
        vault.submitShieldedOrder(new bytes(158), sp);
    }

    function test_withdraw_boundToRecipientAndOpening() public {
        _throughSettle2();
        _returnRefunded();
        _claimAll();
        (DarkVault.SpendProof memory sp, address token, uint128 amount, uint256 blinding, address to) = _withdrawArgs(0);

        vm.expectRevert(DarkVault.InvalidSpendProof.selector);
        vault.withdraw(sp, token, amount, blinding, makeAddr("thief"));

        vm.expectRevert(DarkVault.SpendMismatch.selector);
        vault.withdraw(sp, token, amount + 1, blinding, to);

        vm.expectRevert(DarkVault.SpendMismatch.selector);
        vault.withdraw(sp, address(tokenA), amount, blinding, to);

        vault.withdraw(sp, token, amount, blinding, to);
        vm.expectRevert(DarkVault.NullifierSpent.selector);
        vault.withdraw(sp, token, amount, blinding, to);
    }

    function test_deposit_validations() public {
        _createPools();
        address u = makeAddr("u");
        usdc.mint(u, 10e6);
        vm.startPrank(u);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(DarkVault.TokenNotAllowed.selector);
        vault.deposit(makeAddr("random"), 1e6, 1);
        vm.expectRevert(DarkVault.BelowMinDeposit.selector);
        vault.deposit(address(usdc), 1e6 - 1, 1);
        vm.expectRevert(DarkVault.BadField.selector);
        vault.deposit(address(usdc), 1e6, NoteLib.SNARK_FIELD);
        vault.deposit(address(usdc), 1e6, 1);
        vm.stopPrank();
        assertEq(vault.noteCount(), 1);
    }

    // ================================================================ claim / iade

    function test_claimAndReturn_rejections() public {
        _throughSettle2();
        string memory r0 = _result(0);
        bytes32 id0 = vm.parseJsonBytes32(fx, string.concat(r0, ".orderId"));
        bytes32[] memory p0 = vm.parseJsonBytes32Array(fx, string.concat(r0, ".proof"));

        // dolmuş emir iade yolundan döndürülemez
        vm.expectRevert(DarkVault.InvalidProof.selector);
        vault.returnRefunded(2, id0, p0);

        vm.warp(UNLOCK);
        bytes32 sealedHash = vm.parseJsonBytes32(fx, string.concat(r0, ".sealedResultHash"));
        vm.expectRevert(DarkVault.InvalidProof.selector);
        vault.claimNote(2, id0, 42, sealedHash, p0);

        _claim(0);
        vm.expectRevert(DarkVault.AlreadyDone.selector);
        _claim(0);
    }

    // ================================================================ settlement saldırıları

    function test_settle_rejectsTamperedResult() public {
        _createPools();
        _settle1();
        _depositAll();
        _submitAll();
        vm.warp(GENESIS + 121);
        DarkVault.SettleParams memory p = _params(".batch2", 2);
        DarkVault.Result[] memory rs = _results(".batch2");
        rs[3].status = 1; // iadeyi dolmuş gibi göster
        vm.expectRevert(DarkVault.InvalidSigner.selector);
        vault.settleBatch(p, rs, _noLots());
    }

    function test_settle_rejectsDroppedResult() public {
        _createPools();
        _settle1();
        _depositAll();
        _submitAll();
        vm.warp(GENESIS + 121);
        DarkVault.Result[] memory full = _results(".batch2");
        DarkVault.Result[] memory rs = new DarkVault.Result[](full.length - 1);
        for (uint256 i = 0; i < rs.length; ++i) {
            rs[i] = full[i];
        }
        DarkVault.SettleParams memory p = _params(".batch2", 2);
        vm.expectRevert(DarkVault.ResultCountMismatch.selector);
        vault.settleBatch(p, rs, _noLots());
    }

    /// @notice Zincirdeki emir kümesi enclave'in işlediğinden farklıysa imzalı sonuç reddedilir.
    function test_settle_rejectsWhenOnchainOrdersDifferFromEnclaveInput() public {
        _createPools();
        _settle1();
        _depositAll();
        vm.warp(GENESIS + 70);
        for (uint256 i = 0; i < 4; ++i) {
            (bytes memory ct, DarkVault.SpendProof memory sp) = _order(i);
            vault.submitShieldedOrder(ct, sp);
        }
        vm.warp(GENESIS + 121);
        DarkVault.SettleParams memory p = _params(".batch2", 2);
        DarkVault.Result[] memory full = _results(".batch2");
        DarkVault.Result[] memory four = new DarkVault.Result[](4);
        for (uint256 i = 0; i < 4; ++i) {
            four[i] = full[i];
        }
        vm.expectRevert(DarkVault.InvalidSigner.selector);
        vault.settleBatch(p, four, _noLots());
    }

    function test_settle_rejectsTamperedStateAndUnregisteredEnclave() public {
        _createPools();
        vm.warp(GENESIS + 61);
        DarkVault.SettleParams memory p = _params(".batch1", 1);
        DarkVault.Result[] memory rs = _results(".batch1");
        p.newSealedState[20] ^= 0x01;
        vm.expectRevert(DarkVault.InvalidSigner.selector);
        vault.settleBatch(p, rs, _noLots());

        p = _params(".batch1", 1);
        vm.prank(owner);
        registry.revoke(enclave);
        vm.expectRevert(DarkVault.InvalidSigner.selector);
        vault.settleBatch(p, rs, _noLots());
    }

    function test_settle_timingRules() public {
        _createPools();
        DarkVault.SettleParams memory p = _params(".batch1", 1);
        DarkVault.Result[] memory rs = _results(".batch1");
        vm.warp(GENESIS + 59);
        vm.expectRevert(DarkVault.WindowOpen.selector);
        vault.settleBatch(p, rs, _noLots());

        vm.warp(UNLOCK - 7 days + 1);
        vm.expectRevert(DarkVault.UnlockTooEarly.selector);
        vault.settleBatch(p, rs, _noLots());

        vm.warp(GENESIS + 61);
        DarkVault.SettleParams memory p2 = _params(".batch2", 2);
        DarkVault.Result[] memory rs2 = _results(".batch2");
        vm.expectRevert(DarkVault.WrongWindow.selector);
        vault.settleBatch(p2, rs2, _noLots());

        vault.settleBatch(p, rs, _noLots());
        vm.expectRevert(DarkVault.WrongWindow.selector);
        vault.settleBatch(p, rs, _noLots());
    }

    // ================================================================ kaçış kapağı

    function test_escape_returnsUnsettledOrdersAsNotesAndFreezes() public {
        _createPools();
        _settle1();
        _depositAll();
        _submitAll();

        vm.expectRevert(DarkVault.NotStuck.selector);
        vault.activateEscape();
        vm.warp(vault.windowEnd(2) + vault.ESCAPE_DELAY());
        vault.activateEscape();

        for (uint256 i = 0; i < 5; ++i) {
            bytes32 id = keccak256(vm.parseJsonBytes(fx, string.concat(".orders[", vm.toString(i), "].ciphertext")));
            vault.escapeReturnOrder(id); // herkes çağırabilir; not sahibine döner
            vm.expectRevert(DarkVault.AlreadyDone.selector);
            vault.escapeReturnOrder(id);
        }
        assertEq(vault.noteCount(), 15);

        DarkVault.SettleParams memory p = _params(".batch2", 2);
        DarkVault.Result[] memory rs = _results(".batch2");
        vm.expectRevert(DarkVault.Escaped.selector);
        vault.settleBatch(p, rs, _noLots());
        vm.expectRevert(DarkVault.Escaped.selector);
        vault.deposit(address(usdc), 1e6, 1);
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);
        vm.expectRevert(DarkVault.Escaped.selector);
        vault.submitShieldedOrder(ct, sp);
    }

    /// @notice Enclave settle ettikten sonra ölür: settle edilmiş sonuçlar yine claim edilir,
    ///         geç emir not olarak döner, LP'ler 7 gün kilitli rezervleri açıp çeker.
    function test_escape_afterSettlement_claimsReturnsAndLiquidity() public {
        _throughSettle2();

        vm.warp(GENESIS + 3 * WINDOW + 5); // pencere 4: enclave'in hiç işlemeyeceği emir
        bytes memory lateCt = vm.parseJsonBytes(fx, ".lateOrder.ciphertext");
        bytes32 lateId = vault.submitShieldedOrder(lateCt, _proof(".lateOrder.proof"));

        vm.warp(vault.windowEnd(4) + vault.ESCAPE_DELAY());
        vault.activateEscape();
        vault.escapeReturnOrder(lateId);

        bytes32 settledId = vm.parseJsonBytes32(fx, string.concat(_result(0), ".orderId"));
        vm.expectRevert(DarkVault.AlreadySettled.selector);
        vault.escapeReturnOrder(settledId);

        (uint32[] memory ids, uint128[] memory base, uint128[] memory quote, bytes32 salt) = _revealArgs();
        vm.expectRevert(DarkVault.Locked.selector);
        vault.revealFinalReserves(ids, base, quote, salt);

        vm.warp(UNLOCK);
        vm.expectRevert(DarkVault.InvalidReveal.selector);
        vault.revealFinalReserves(ids, base, quote, bytes32(uint256(salt) ^ 1));
        vault.revealFinalReserves(ids, base, quote, salt);

        vm.startPrank(owner);
        vault.escapeWithdrawLiquidity(1, owner);
        vault.escapeWithdrawLiquidity(2, owner);
        vm.expectRevert(DarkVault.AlreadyDone.selector);
        vault.escapeWithdrawLiquidity(1, owner);
        vm.stopPrank();
        assertEq(tokenA.balanceOf(owner), base[0]);
        assertEq(tokenB.balanceOf(owner), base[1]);
        assertEq(usdc.balanceOf(owner), uint256(quote[0]) + quote[1]);

        _claim(0); // enclave olmadan
    }

    function test_escape_reclaimsUnsettledPool() public {
        _createPools();
        vm.warp(vault.windowEnd(1) + vault.ESCAPE_DELAY());
        vault.activateEscape();
        vm.prank(owner);
        vault.escapeReclaimPool(1, owner);
        assertEq(tokenA.balanceOf(owner), 1_000_000e18);
    }

    function _revealArgs()
        internal
        view
        returns (uint32[] memory ids, uint128[] memory base, uint128[] memory quote, bytes32 salt)
    {
        uint256 n = vm.parseJsonUint(fx, ".batch2Summary.poolCount");
        ids = new uint32[](n);
        base = new uint128[](n);
        quote = new uint128[](n);
        for (uint256 i = 0; i < n; ++i) {
            string memory p = string.concat(".batch2Summary.pools[", vm.toString(i), "]");
            ids[i] = uint32(vm.parseJsonUint(fx, string.concat(p, ".poolId")));
            base[i] = uint128(_str(string.concat(p, ".baseReserve")));
            quote[i] = uint128(_str(string.concat(p, ".quoteReserve")));
        }
        salt = vm.parseJsonBytes32(fx, ".batch2Summary.salt");
    }

    // ================================================================ yönetim

    function test_createPool_rejectsFeeOnTransferAndDuplicates() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(owner, 100e18);
        usdc.mint(owner, 1_000e6);
        vm.startPrank(owner);
        fee.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(DarkVault.FeeOnTransferToken.selector);
        vault.createPool(9, address(fee), 10e18, 10e6, 1);
        vm.expectRevert(DarkVault.BadPool.selector);
        vault.createPool(9, address(usdc), 10e18, 10e6, 1);
        vm.stopPrank();
        vm.expectRevert();
        vault.createPool(10, address(tokenA), 1, 1, 1);
    }

    function test_emptyWindowsAreSkipped() public {
        _createPools();
        _settle1();
        _depositAll();
        vm.warp(GENESIS + 4 * WINDOW + 5); // pencere 5
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);
        vault.submitShieldedOrder(ct, sp);
        assertEq(vault.nextWindowToSettle(), 5);
    }

    // ================================================================ gas

    /// @notice Ethereum fiyatlamasıyla ölçüm (Foundry, Monad'ın cold-page fiyatlamasını taklit etmez).
    function test_gasProfile() public {
        _createPools();
        _settle1();
        vm.warp(GENESIS + 65);
        address user = _user(0);
        usdc.mint(user, 100e6);
        vm.prank(user);
        usdc.approve(address(vault), 100e6);
        uint256 secret = _u(".notes[0].secretHash");
        vm.prank(user);
        uint256 g = gasleft();
        vault.deposit(address(usdc), 100e6, secret);
        console2.log("deposit (Poseidon agac eklemesi)", g - gasleft());
        for (uint256 i = 1; i < 5; ++i) {
            _deposit(i);
        }

        vm.warp(GENESIS + 70);
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);
        g = gasleft();
        vault.submitShieldedOrder(ct, sp);
        console2.log("submitShieldedOrder (Groth16 + ekleme)", g - gasleft());
        for (uint256 i = 1; i < 5; ++i) {
            (ct, sp) = _order(i);
            vault.submitShieldedOrder(ct, sp);
        }

        vm.warp(GENESIS + 121);
        DarkVault.SettleParams memory p = _params(".batch2", 2);
        DarkVault.Result[] memory rs = _results(".batch2");
        g = gasleft();
        vault.settleBatch(p, rs, _noLots());
        console2.log("settleBatch (5 emir)", g - gasleft());

        _returnRefunded();
        vm.warp(UNLOCK);
        string memory r = _result(0);
        bytes32 id = vm.parseJsonBytes32(fx, string.concat(r, ".orderId"));
        uint256 c = _u(string.concat(r, ".commitment"));
        bytes32 sh = vm.parseJsonBytes32(fx, string.concat(r, ".sealedResultHash"));
        bytes32[] memory mp = vm.parseJsonBytes32Array(fx, string.concat(r, ".proof"));
        g = gasleft();
        vault.claimNote(2, id, c, sh, mp);
        console2.log("claimNote", g - gasleft());
        _claim(1);
        _claim(2);

        (DarkVault.SpendProof memory wsp, address token, uint128 amount, uint256 blinding, address to) =
            _withdrawArgs(0);
        g = gasleft();
        vault.withdraw(wsp, token, amount, blinding, to);
        console2.log("withdraw (Groth16 + ekleme)", g - gasleft());
    }

    // ================================================================ kilitli lot satışı
    //
    // Lot = batch 2'nin ilk dolu sonucu (alım). Lot satışı batch'lerini enclave'in yerine ikinci bir
    // kayıtlı test anahtarı imzalar: kontrat sonuç gövdelerini değil, imzalı özeti doğrular.

    uint256 constant LOT_ENCLAVE_PK = 0xA11CE;

    function _lot() internal view returns (bytes32) {
        return vm.parseJsonBytes32(fx, string.concat(_result(0), ".orderId"));
    }

    /// @dev 190 baytlık, 0x01 ile başlayan (ECIES sürümü) ayırt edilebilir sahte şifreli metin.
    function _lotCt(uint256 salt) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(0x01), abi.encode(salt, salt + 1, salt + 2, salt + 3, salt + 4), new bytes(29));
    }

    function _lotEnclave() internal {
        vm.prank(owner);
        registry.register(vm.addr(LOT_ENCLAVE_PK), bytes32(0));
    }

    function _filled(bytes32 id, uint256 commitment) internal pure returns (DarkVault.Result memory) {
        return DarkVault.Result({orderId: id, status: 1, commitment: bytes32(commitment), sealedResult: "sealed"});
    }

    function _refunded(bytes32 id) internal pure returns (DarkVault.Result memory) {
        return DarkVault.Result({orderId: id, status: 2, commitment: bytes32(0), sealedResult: ""});
    }

    function _one(DarkVault.Result memory r) internal pure returns (DarkVault.Result[] memory rs) {
        rs = new DarkVault.Result[](1);
        rs[0] = r;
    }

    function _oneLot(bytes32 sellId, bool filled, uint256 remainder)
        internal
        pure
        returns (DarkVault.LotUpdate[] memory lots)
    {
        lots = new DarkVault.LotUpdate[](1);
        lots[0] = DarkVault.LotUpdate({
            sellOrderId: sellId,
            filled: filled,
            remainderCommitment: bytes32(remainder),
            sealedRemainder: filled ? bytes("remainder") : bytes("")
        });
    }

    /// @dev Enclave'in yapacağı gibi imzalı settlement parametreleri (girdi kontratın kendi kayıtlarından).
    function _signedParams(uint64 window, DarkVault.Result[] memory rs, DarkVault.LotUpdate[] memory lots)
        internal
        view
        returns (DarkVault.SettleParams memory p)
    {
        p = DarkVault.SettleParams({
            window: window,
            unlockRound: uint64(DrandQuicknet.roundAt(block.timestamp + 7 days) + 1),
            newSealedState: abi.encodePacked("state", window),
            capsule: abi.encodePacked("capsule", window),
            sealedSummary: abi.encodePacked("summary", window),
            reservesCommitment: keccak256(abi.encode(window)),
            signature: ""
        });
        bytes32[] memory leaves = new bytes32[](rs.length);
        for (uint256 i = 0; i < rs.length; ++i) {
            leaves[i] =
                DarkPoolLib.resultLeaf(rs[i].orderId, rs[i].status, rs[i].commitment, keccak256(rs[i].sealedResult));
        }
        bytes32 lotsHash;
        for (uint256 i = 0; i < lots.length; ++i) {
            lotsHash = DarkPoolLib.lotChainStep(
                lotsHash,
                lots[i].sellOrderId,
                lots[i].filled,
                lots[i].remainderCommitment,
                keccak256(lots[i].sealedRemainder)
            );
        }
        (, bytes32 poolsChain) = vault.windowPools(window);
        bytes32 digest = DarkPoolLib.settlementDigest(
            DarkPoolLib.Settlement({
                chainId: block.chainid,
                vault: address(vault),
                batchId: vault.settledCount() + 1,
                prevStateHash: vault.stateHash(),
                newStateHash: keccak256(p.newSealedState),
                resultsRoot: DarkPoolLib.merkleRoot(leaves),
                unlockRound: p.unlockRound,
                capsuleHash: keccak256(p.capsule),
                summaryHash: keccak256(p.sealedSummary),
                quoteToken: vault.quoteToken(),
                feeBps: vault.feeBps(),
                ordersHash: vault.ordersHash(window),
                poolsHash: poolsChain,
                reservesCommitment: p.reservesCommitment,
                lotsHash: lotsHash
            })
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LOT_ENCLAVE_PK, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    function _settleSigned(uint64 window, DarkVault.Result[] memory rs, DarkVault.LotUpdate[] memory lots)
        internal
        returns (uint64 batchId)
    {
        vault.settleBatch(_signedParams(window, rs, lots), rs, lots);
        batchId = vault.settledCount();
    }

    function _unlockOf(uint64 batchId) internal view returns (uint64 t) {
        (,, t,) = vault.batches(batchId);
    }

    /// @dev Satış emrinin (tek sonuçlu batch: kanıt boş) claim'i.
    function _claimSell(uint64 batchId, bytes32 sellId, uint256 proceeds) internal {
        vault.claimNote(batchId, sellId, proceeds, keccak256("sealed"), new bytes32[](0));
    }

    /// @dev Batch 2 settle edilir, lot (alım sonucu) %50 satılır: pencere 3.
    function _sellLot() internal returns (bytes32 sellId) {
        _throughSettle2();
        _armLot(_lot());
        _lotEnclave();
        vm.warp(GENESIS + 125);
        vm.expectEmit(address(vault));
        emit DarkVault.LotSellSubmitted(keccak256(_lotCt(1)), _lot());
        sellId = vault.submitLotSell(_lotCt(1), _lot(), _key(1));
    }

    function test_lotSell_lockedLotSoldByPercentage_claimsProceedsAndRemainder() public {
        bytes32 sellId = _sellLot();
        assertEq(sellId, keccak256(_lotCt(1)));
        assertEq(vault.lotState(_lot()), 1);
        (bytes32 lot, uint64 window, bool settled) = vault.lotSells(sellId);
        assertEq(lot, _lot());
        assertEq(window, 3);
        assertFalse(settled);
        (, bool done, uint256 sc, bytes32 sellKey) = vault.orders(sellId);
        assertFalse(done);
        assertEq(sc, uint256(_lot()), "emir zinciri lot kimligini tasir");
        (,,, bytes32 lotHead) = vault.orders(_lot());
        assertEq(lotHead, _key(1), "acilan anahtar zincirin yeni basi");
        assertEq(sellKey, _key(1), "kalan lot ayni zincirle surer");

        // Ayni lot ikinci kez satilamaz
        vm.expectRevert(DarkVault.LotUnavailable.selector);
        vault.submitLotSell(_lotCt(2), _lot(), _key(2));

        // Satis beklerken lotun kilidi acilsa bile claim edilemez
        vm.warp(UNLOCK);
        vm.expectRevert(DarkVault.LotUnavailable.selector);
        _claim(0);

        // Lot guncellemesi eksik ya da imzasiz degistirilmis settlement reddedilir
        DarkVault.Result[] memory rs = _one(_filled(sellId, 111));
        DarkVault.LotUpdate[] memory lots = _oneLot(sellId, true, 222);
        DarkVault.SettleParams memory p = _signedParams(3, rs, lots);
        vm.expectRevert(DarkVault.LotMismatch.selector);
        vault.settleBatch(p, rs, _noLots());
        lots[0].remainderCommitment = bytes32(uint256(333));
        vm.expectRevert(DarkVault.InvalidSigner.selector);
        vault.settleBatch(p, rs, lots);
        lots[0].remainderCommitment = bytes32(uint256(222));

        vm.expectEmit(address(vault));
        emit DarkVault.BatchLots(3, lots);
        vault.settleBatch(p, rs, lots);
        assertEq(vault.lotState(_lot()), 2, "lot tuketildi");
        assertEq(vault.remainders(sellId), 222);
        (,, settled) = vault.lotSells(sellId);
        assertTrue(settled);

        // Satilmis lotun claim'i agaca not eklemez (karsiligi satis emrinin notlari)
        uint32 count = vault.noteCount();
        _claim(0);
        assertEq(vault.noteCount(), count, "satilan lot not eklemez");
        (, done,,) = vault.orders(_lot());
        assertTrue(done);

        // Satis emri kilitli; acilinca gelir + kalan lot notlari agaca girer
        vm.expectRevert(DarkVault.Locked.selector);
        _claimSell(3, sellId, 111);
        vm.warp(_unlockOf(3));
        vm.expectEmit(address(vault));
        emit DarkVault.NoteInserted(111, count);
        vm.expectEmit(address(vault));
        emit DarkVault.NoteInserted(222, count + 1);
        _claimSell(3, sellId, 111);
        assertEq(vault.noteCount(), count + 2);

        // Lot satisi not harcamaz: iade yolu yoktur
        vm.expectRevert(DarkVault.LotMismatch.selector);
        vault.returnRefunded(3, sellId, new bytes32[](0));
    }

    function test_lotSell_rejectedSaleFreesLot() public {
        bytes32 sellId = _sellLot();
        vm.warp(GENESIS + 181);
        _settleSigned(3, _one(_refunded(sellId)), _oneLot(sellId, false, 0));
        assertEq(vault.lotState(_lot()), 0, "lot serbest");
        assertEq(vault.remainders(sellId), 0);

        // Reddedilen satisin iadesi yok (not harcanmadi)
        vm.expectRevert(DarkVault.LotMismatch.selector);
        vault.returnRefunded(3, sellId, new bytes32[](0));

        // Serbest kalan lot yeniden satilabilir ya da kilit acilinca normal claim edilir
        vm.warp(GENESIS + 185);
        vault.submitLotSell(_lotCt(7), _lot(), _key(2));
        assertEq(vault.lotState(_lot()), 1);
    }

    function test_lotSell_rejectedLotClaimsNormally() public {
        bytes32 sellId = _sellLot();
        vm.warp(GENESIS + 181);
        _settleSigned(3, _one(_refunded(sellId)), _oneLot(sellId, false, 0));
        vm.warp(UNLOCK);
        uint32 count = vault.noteCount();
        _claim(0);
        assertEq(vault.noteCount(), count + 1, "alim notu agaca girer");
        // Claim edilmis lot artik satilamaz
        vm.expectRevert(DarkVault.LotUnavailable.selector);
        vault.submitLotSell(_lotCt(8), _lot(), _key(2));
    }

    function test_lotSell_remainderCanBeSoldAgain() public {
        bytes32 sell1 = _sellLot();
        vm.warp(GENESIS + 181);
        uint64 b3 = _settleSigned(3, _one(_filled(sell1, 111)), _oneLot(sell1, true, 222));

        // Kalan lot (satis emrinin sonucu) settle edilince yeniden yuzdeyle satilabilir: %100
        vm.warp(GENESIS + 185);
        bytes32 sell2 = vault.submitLotSell(_lotCt(9), sell1, _key(2));
        assertEq(vault.lotState(sell1), 1);
        vm.warp(GENESIS + 241);
        uint64 b4 = _settleSigned(4, _one(_filled(sell2, 333)), _oneLot(sell2, true, 444));
        assertEq(vault.lotState(sell1), 2);

        // Ilk satisin claim'i: gelir girer, satilan kalan lot girmez
        vm.warp(_unlockOf(b3));
        uint32 count = vault.noteCount();
        _claimSell(b3, sell1, 111);
        assertEq(vault.noteCount(), count + 1);
        vm.warp(_unlockOf(b4));
        _claimSell(b4, sell2, 333);
        assertEq(vault.noteCount(), count + 3, "ikinci satis: gelir + kalan");
    }

    function test_lotSell_rejectsUnavailableLots() public {
        _throughSettle2();
        vm.warp(GENESIS + 125);
        _armLot(_lot());
        // Bilinmeyen emir (anahtarı yok)
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(1), keccak256("unknown"), _key(1));
        // Henuz settle edilmemis emir (bu pencerede gonderilen lot satisi)
        bytes32 sell1 = vault.submitLotSell(_lotCt(1), _lot(), _key(1));
        vm.expectRevert(DarkVault.LotUnavailable.selector);
        vault.submitLotSell(_lotCt(2), sell1, _key(2));
        // Sonucu alinmis (done) emir: iade edilmis emir
        _returnRefunded();
        bytes32 refundedId = vm.parseJsonBytes32(fx, string.concat(_result(3), ".orderId"));
        _armLot(refundedId);
        vm.expectRevert(DarkVault.LotUnavailable.selector);
        vault.submitLotSell(_lotCt(3), refundedId, _key(1));
        // Bicimsiz sifreli metin ve tekrar eden emir
        vm.expectRevert(DarkVault.BadCiphertext.selector);
        vault.submitLotSell(new bytes(190), _lot(), _key(2));
        vm.expectRevert(DarkVault.DuplicateOrder.selector);
        vault.submitLotSell(_lotCt(1), _lot(), _key(2));
    }

    function test_lotSell_escapeFreesLot() public {
        bytes32 sellId = _sellLot();
        vm.warp(GENESIS + 180 + 2 days);
        vault.activateEscape();
        vault.escapeReturnOrder(sellId);
        assertEq(vault.lotState(_lot()), 0, "kacis: lot serbest");
        (, bool done,,) = vault.orders(sellId);
        assertTrue(done);
        // Lotun kendisi kilit acilinca claim edilir
        vm.warp(UNLOCK);
        uint32 count = vault.noteCount();
        _claim(0);
        assertEq(vault.noteCount(), count + 1);
    }

    /// @dev Lot anahtar zinciri: `_key(0)` baş (zincirde saklanır), `keccak256(_key(i + 1)) == _key(i)`.
    function _key(uint256 i) internal pure returns (bytes32 k) {
        k = keccak256("lot-key-seed");
        for (uint256 j = i; j < 8; ++j) {
            k = keccak256(abi.encodePacked(k));
        }
    }

    /// @dev Fixture emirleri anahtarsız gönderildi (kanıtları düz ctxHash'e bağlı): lot testleri için
    ///      zincirin başını doğrudan storage'a yaz. Anahtarlı gönderim ayrıca test edilir.
    function _armLot(bytes32 id) internal {
        stdstore.target(address(vault)).sig(vault.orders.selector).with_key(id).depth(3).checked_write(_key(0));
    }

    function test_lotSell_requiresOwnersLotKey() public {
        _throughSettle2();
        vm.warp(GENESIS + 125);
        // Anahtarsız gönderilmiş emir lot olarak satılamaz: kimse başkasının lotunu kilitleyemez
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(1), _lot(), bytes32(0));
        _armLot(_lot());
        // Zincir başının kendisi, atlanmış halka ya da rastgele anahtar geçmez
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(1), _lot(), _key(0));
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(1), _lot(), _key(2));
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(1), _lot(), keccak256("guess"));
        assertEq(vault.lotState(_lot()), 0, "lot kilitlenmedi");
    }

    function test_lotSell_revealedKeyCannotBeReplayed() public {
        bytes32 sellId = _sellLot();
        vm.warp(GENESIS + 181);
        _settleSigned(3, _one(_refunded(sellId)), _oneLot(sellId, false, 0));
        assertEq(vault.lotState(_lot()), 0, "lot serbest");
        // Satış reddedildi ama açılan anahtar harcandı: gören biri onu tekrar kullanamaz
        vm.warp(GENESIS + 185);
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitLotSell(_lotCt(7), _lot(), _key(1));
        vault.submitLotSell(_lotCt(7), _lot(), _key(2));
    }

    function test_submitWithLotKey_bindsProofToKey() public {
        _createPools();
        _settle1();
        _depositAll();
        vm.warp(GENESIS + 70);
        (bytes memory ct, DarkVault.SpendProof memory sp) = _order(0);
        vm.expectRevert(DarkVault.LotKeyInvalid.selector);
        vault.submitShieldedOrderWithLotKey(ct, sp, bytes32(0));
        // Kanıt düz ctxHash'e bağlı: anahtar eklenirse (ya da kopyalayan değiştirirse) geçmez
        vm.expectRevert(DarkVault.InvalidSpendProof.selector);
        vault.submitShieldedOrderWithLotKey(ct, sp, _key(0));
    }

    // ================================================================ kütüphaneler

    function test_drand_knownRound() public pure {
        assertEq(DrandQuicknet.roundTime(1000), UNLOCK);
        assertEq(DrandQuicknet.roundAt(DrandQuicknet.GENESIS), 1);
        assertEq(DrandQuicknet.roundAt(DrandQuicknet.GENESIS + 3), 2);
        assertEq(DrandQuicknet.roundAt(DrandQuicknet.GENESIS + 4), 3);
    }

    function testFuzz_drand_roundTrip(uint64 round) public pure {
        vm.assume(round > 0 && round < type(uint64).max / 4);
        assertEq(DrandQuicknet.roundAt(DrandQuicknet.roundTime(round)), round);
    }
}
