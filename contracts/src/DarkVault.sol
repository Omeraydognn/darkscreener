// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IEnclaveRegistry} from "./interfaces/IEnclaveRegistry.sol";
import {ISpendVerifier} from "./interfaces/ISpendVerifier.sol";
import {IPoseidonT3, IPoseidonT4} from "./interfaces/IPoseidon.sol";
import {DarkPoolLib} from "./lib/DarkPoolLib.sol";
import {DrandQuicknet} from "./lib/DrandQuicknet.sol";
import {NoteLib} from "./lib/NoteLib.sol";
import {PoseidonTree} from "./lib/PoseidonTree.sol";

/// @title DarkVault
/// @notice Karanlık havuz DEX'in tek vault'u: shielded not havuzu + şifreli batch emirleri.
///
/// Akış:
///  1. `deposit`             : token yatırılır, karşılığında gizli bir not ağaca eklenir.
///                             (Yatırılan tutar görünür; sonraki hiçbir işlemle ilişkilendirilemez.)
///  2. `submitShieldedOrder` : ZK kanıtıyla bir notun bir kısmı harcanır; kontrat token'ı ve
///                             miktarı GÖRMEZ, yalnızca `spendCommitment`'ı kaydeder. Emrin
///                             kendisi (havuz, yön, açılış) enclave'e şifrelidir.
///  3. `settleBatch`         : enclave imzalı sonucu getirilir; kontrat girdiyi kendi
///                             kayıtlarından doğrular, yalnızca sonuç Merkle kökünü saklar.
///  4. 7 gün sonra           : `claimNote` ile sonuç notu ağaca eklenir (herkes çağırabilir,
///                             miktar görünmez). Not yeni emirde ya da `withdraw`'da kullanılır.
///  Kaçış kapağı             : `ESCAPE_DELAY` boyunca settle olmazsa vault donar; settle edilmemiş
///                             emirlerin `spendCommitment`'ı not olarak ağaca geri döner, notlar
///                             enclave olmadan çekilir, LP'ler 7 gün kilitli rezervleri açıp çeker.
///
/// Monad notları:
///  - Emir zincirleri `uint256(orderId) % SHARDS` shard'larında: farklı shard'lar çakışmaz.
///  - Pencere numarası zamandan türetilir; "batch aç/kapat" işlemi ve global sayaç yok.
///  - Settlement emir başına storage yazmaz; sonuçlar Merkle kanıtıyla ağaca alınır.
///  - Reentrancy koruması transient storage ile.
///  - Ortak yazma noktaları: not ağacı (her ekleme) ve token'daki vault bakiyesi.
contract DarkVault is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoseidonTree for PoseidonTree.Tree;

    // ------------------------------------------------------------------ sabitler

    uint256 public constant SHARDS = 16;
    uint256 public constant MAX_ORDERS_PER_SHARD = 16;
    /// @notice 0x01 || eph_pub(33) || nonce(12) || order(128) || tag(16) — tee-core ecies + order v2
    uint256 public constant CIPHERTEXT_LEN = 190;
    uint256 public constant LOCK_SECONDS = 7 days;
    /// @notice Enclave saati ile blok zamanı arasındaki fark + settlement gecikmesi için pay.
    uint256 public constant MAX_EXTRA_LOCK = 1 days;
    uint256 public constant ESCAPE_DELAY = 2 days;
    uint8 internal constant LOT_FREE = 0;
    uint8 internal constant LOT_PENDING = 1;
    uint8 internal constant LOT_CONSUMED = 2;
    uint256 public constant MAX_FEE_BPS = 100;

    // ------------------------------------------------------------------ değişmezler

    IEnclaveRegistry public immutable registry;
    ISpendVerifier public immutable verifier;
    IPoseidonT3 public immutable poseidon2;
    IPoseidonT4 public immutable poseidon3;
    address public immutable quoteToken;
    uint256 public immutable genesisTime;
    uint256 public immutable windowSeconds;
    uint256 public immutable feeBps;

    // ------------------------------------------------------------------ durum

    struct Order {
        uint64 window;
        bool done; // sonuç notu eklendi / iade edildi
        uint256 spendCommitment;
        /// @notice Lot satış anahtarı zincirinin başı: bir sonraki satış `keccak256(key) == lotKey` olan
        ///         anahtarı açmalı. 0 = lot olarak satılamaz (anahtarsız gönderilmiş emir).
        bytes32 lotKey;
    }

    struct Window {
        bytes32[SHARDS] chains;
        uint256[SHARDS] counts;
        bytes32 poolsChain;
        uint32[] poolIds;
        uint64 next; // emir/havuz içeren bir sonraki pencere
        bool linked;
        uint32 lotSellCount; // bu penceredeki kilitli lot satışları
    }

    struct Pool {
        address baseToken;
        address creator;
        uint64 window;
        bool reclaimed;
        uint128 initBase;
        uint128 initQuote;
    }

    struct Batch {
        bytes32 resultsRoot;
        uint64 window;
        uint64 unlockTime;
        bytes32 reservesCommitment;
    }

    struct Reserves {
        bool revealed;
        uint128 base;
        uint128 quote;
    }

    struct SettleParams {
        uint64 window;
        uint64 unlockRound;
        bytes newSealedState;
        bytes capsule;
        bytes sealedSummary;
        /// Batch sonrası rezervlere tuzlu commitment; açılışı `sealedSummary` içinde (7 gün kilitli)
        bytes32 reservesCommitment;
        /// r || s || v
        bytes signature;
    }

    struct Result {
        bytes32 orderId;
        uint8 status;
        bytes32 commitment;
        bytes sealedResult;
    }

    /// @notice Kilitli lot satışının sonucu (enclave imzalı, batch.rs `LotUpdate`).
    struct LotUpdate {
        bytes32 sellOrderId;
        bool filled;
        bytes32 remainderCommitment;
        bytes sealedRemainder;
    }

    struct LotSell {
        bytes32 lot; // satılan alım (ya da önceki lot satışı) emri
        uint64 window;
        bool settled;
    }

    /// @notice spend.circom kanıtı ve açık girdileri (ctxHash çağrıdan türetilir).
    struct SpendProof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256 nullifier;
        uint256 changeCommitment;
        uint256 spendCommitment;
    }

    PoseidonTree.Tree internal tree;
    mapping(uint256 => bool) public nullifierSpent;
    mapping(bytes32 => Order) public orders;
    mapping(uint64 => Window) internal windows;
    mapping(uint32 => Pool) public pools;
    mapping(address => uint32) public poolOfBaseToken;
    mapping(address => uint128) public minDeposit; // 0 = izin verilmeyen token
    /// @notice İzinsiz proje açılışını yapan launchpad kontratı (0 = kapalı).
    address public launchpad;
    /// @notice Kilitli lotlar: kilidi açılmamış (claim edilmemiş) bir alımın sonucu, miktarı bilinmeden
    ///         yüzdeyle satılabilir. 0 = serbest, 1 = satış bekliyor, 2 = satıldı (eski claim'i ağaca not eklemez).
    mapping(bytes32 => uint8) public lotState;
    mapping(bytes32 => LotSell) public lotSells;
    /// @notice Lot satışında satılmayan kısmın notu; satış emrinin claim'iyle ağaca girer.
    mapping(bytes32 => uint256) public remainders;
    mapping(uint64 => Batch) public batches; // settlement sırası -> batch
    mapping(uint32 => Reserves) public finalReserves; // yalnızca kaçış modunda doldurulur
    bool public finalReservesRevealed;

    uint64 public lastLinkedWindow;
    uint64 public lastSettledWindow;
    uint64 public settledCount;
    bytes32 public stateHash;
    bool public escaped;

    // ------------------------------------------------------------------ olaylar

    /// @notice Not ağacına her ekleme. İstemciler ağacı bu olaylardan yeniden kurar.
    event NoteInserted(uint256 indexed commitment, uint32 index);
    event Deposited(address indexed token, uint128 amount, uint256 commitment);
    event Withdrawn(uint256 indexed nullifier, address indexed token, address indexed recipient, uint128 amount);
    event PoolCreated(
        uint32 indexed poolId, address indexed baseToken, uint64 indexed window, uint128 base, uint128 quote
    );
    event OrderSubmitted(
        uint64 indexed window,
        bytes32 indexed orderId,
        uint8 shard,
        uint32 index,
        uint256 spendCommitment,
        bytes ciphertext
    );
    event BatchSettled(
        uint64 indexed batchId, uint64 indexed window, bytes32 resultsRoot, uint64 unlockRound, uint64 unlockTime
    );
    /// @notice Veri erişilebilirliği: sonraki batch'in girdisi (sealed state), 7 gün sonra
    ///         açılacak kapsül/özet ve kullanıcıların sonuçları.
    event BatchData(uint64 indexed batchId, bytes newSealedState, bytes capsule, bytes sealedSummary, Result[] results);
    event NoteClaimed(bytes32 indexed orderId, uint256 commitment);
    event OrderReturned(bytes32 indexed orderId, uint256 commitment);
    event EscapeActivated(uint64 indexed stuckWindow);
    event PoolReclaimed(uint32 indexed poolId, address indexed to);
    event FinalReservesRevealed(uint64 indexed batchId, uint256 poolCount);
    event LiquidityWithdrawn(uint32 indexed poolId, address indexed to, uint128 base, uint128 quote);
    event MinDepositSet(address indexed token, uint128 amount);
    event LotSellSubmitted(bytes32 indexed orderId, bytes32 indexed lot);
    event BatchLots(uint64 indexed batchId, LotUpdate[] lots);
    event LaunchpadSet(address indexed launchpad);

    // ------------------------------------------------------------------ hatalar

    error Escaped();
    error NotEscaped();
    error BadCiphertext();
    error TokenNotAllowed();
    error BelowMinDeposit();
    error BadField();
    error UnknownRoot();
    error NullifierSpent();
    error InvalidSpendProof();
    error SpendMismatch();
    error DuplicateOrder();
    error ShardFull();
    error FeeOnTransferToken();
    error BadPool();
    error WrongWindow();
    error WindowOpen();
    error UnlockTooEarly();
    error UnlockTooLate();
    error InvalidSigner();
    error ResultCountMismatch();
    error AlreadyDone();
    error Locked();
    error InvalidProof();
    error NotStuck();
    error AlreadySettled();
    error NotOwner();
    error InvalidReveal();
    error LotUnavailable();
    error LotMismatch();
    error LotKeyInvalid();
    error NotRevealed();

    constructor(
        address initialOwner,
        IEnclaveRegistry registry_,
        ISpendVerifier verifier_,
        IPoseidonT3 poseidon2_,
        IPoseidonT4 poseidon3_,
        address quoteToken_,
        uint128 minQuoteDeposit,
        uint256 genesisTime_,
        uint256 windowSeconds_,
        uint256 feeBps_
    ) Ownable(initialOwner) {
        require(genesisTime_ <= block.timestamp && windowSeconds_ > 0 && feeBps_ <= MAX_FEE_BPS && minQuoteDeposit > 0);
        registry = registry_;
        verifier = verifier_;
        poseidon2 = poseidon2_;
        poseidon3 = poseidon3_;
        quoteToken = quoteToken_;
        genesisTime = genesisTime_;
        windowSeconds = windowSeconds_;
        feeBps = feeBps_;
        minDeposit[quoteToken_] = minQuoteDeposit;
        tree.init();
        emit MinDepositSet(quoteToken_, minQuoteDeposit);
    }

    modifier live() {
        if (escaped) revert Escaped();
        _;
    }

    // ------------------------------------------------------------------ görünümler

    function currentWindow() public view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast) 2^64 pencere hiçbir windowSeconds ile dolmaz
        return uint64((block.timestamp - genesisTime) / windowSeconds + 1);
    }

    function windowEnd(uint64 window) public view returns (uint256) {
        return genesisTime + uint256(window) * windowSeconds;
    }

    /// @notice Settle edilmeyi bekleyen en eski pencere (yoksa 0).
    function nextWindowToSettle() public view returns (uint64) {
        return windows[lastSettledWindow].next;
    }

    function windowShard(uint64 window, uint256 shard) external view returns (bytes32 chain, uint256 count) {
        Window storage w = windows[window];
        return (w.chains[shard], w.counts[shard]);
    }

    function windowPools(uint64 window) external view returns (uint32[] memory ids, bytes32 poolsChain) {
        Window storage w = windows[window];
        return (w.poolIds, w.poolsChain);
    }

    function ordersHash(uint64 window) public view returns (bytes32) {
        return keccak256(abi.encodePacked(windows[window].chains));
    }

    function noteRoot() external view returns (uint256) {
        return tree.currentRoot();
    }

    function noteCount() external view returns (uint32) {
        return tree.nextIndex;
    }

    function isKnownRoot(uint256 root) external view returns (bool) {
        return tree.isKnownRoot(root);
    }

    /// @notice `withdraw` kanıtının bağlandığı ctxHash (istemci kanıt üretirken kullanır):
    ///         keccak256(abi.encodePacked("darkpool/withdraw/v1", uint256(chainid), vault, recipient)) mod p
    function withdrawContext(address recipient) public view returns (uint256) {
        return
            NoteLib.toField(
                keccak256(abi.encodePacked("darkpool/withdraw/v1", block.chainid, address(this), recipient))
            );
    }

    // ------------------------------------------------------------------ yönetim

    /// @notice Proje listeleme (küratörlü). Başlangıç likiditesi açıktır; sonrası karanlıktır.
    function createPool(uint32 poolId, address baseToken, uint128 base, uint128 quote, uint128 minBaseDeposit)
        external
        onlyOwner
        live
        nonReentrant
    {
        _createPool(msg.sender, poolId, baseToken, base, quote, minBaseDeposit);
    }

    /// @notice Yetkili launchpad üzerinden izinsiz proje listeleme. Likidite launchpad'den çekilir;
    ///         kaçış modunda başlangıç likiditesi `creator`'a (projeyi açan kullanıcıya) döner.
    function createPoolFor(
        address creator,
        uint32 poolId,
        address baseToken,
        uint128 base,
        uint128 quote,
        uint128 minBaseDeposit
    ) external live nonReentrant {
        if (msg.sender != launchpad || launchpad == address(0)) revert NotOwner();
        if (creator == address(0)) revert BadPool();
        _createPool(creator, poolId, baseToken, base, quote, minBaseDeposit);
    }

    function setLaunchpad(address launchpad_) external onlyOwner {
        launchpad = launchpad_;
        emit LaunchpadSet(launchpad_);
    }

    function _createPool(
        address creator,
        uint32 poolId,
        address baseToken,
        uint128 base,
        uint128 quote,
        uint128 minBaseDeposit
    ) internal {
        if (
            poolId == 0 || pools[poolId].baseToken != address(0) || baseToken == address(0) || baseToken == quoteToken
                || poolOfBaseToken[baseToken] != 0 || base == 0 || quote == 0 || minBaseDeposit == 0
        ) revert BadPool();

        _pull(baseToken, base);
        _pull(quoteToken, quote);

        uint64 window = currentWindow();
        Window storage w = _link(window);
        w.poolsChain = DarkPoolLib.poolChainStep(w.poolsChain, poolId, baseToken, base, quote);
        w.poolIds.push(poolId);

        pools[poolId] = Pool({
            baseToken: baseToken,
            creator: creator,
            window: window,
            reclaimed: false,
            initBase: base,
            initQuote: quote
        });
        poolOfBaseToken[baseToken] = poolId;
        minDeposit[baseToken] = minBaseDeposit;

        emit PoolCreated(poolId, baseToken, window, base, quote);
        emit MinDepositSet(baseToken, minBaseDeposit);
    }

    function setMinDeposit(address token, uint128 amount) external onlyOwner {
        if (amount == 0 || (token != quoteToken && poolOfBaseToken[token] == 0)) revert TokenNotAllowed();
        minDeposit[token] = amount;
        emit MinDepositSet(token, amount);
    }

    // ------------------------------------------------------------------ shielded pool

    /// @notice Token yatır, gizli not al. `secretHash = Poseidon2(owner, blinding)`; notun kime ait
    ///         olduğu ve blinding görünmez. Not commitment'ı kontrat hesaplar: sahte değer basılamaz.
    function deposit(address token, uint128 amount, uint256 secretHash) external live nonReentrant {
        uint128 min = minDeposit[token];
        if (min == 0) revert TokenNotAllowed();
        if (amount < min) revert BelowMinDeposit();
        if (secretHash >= NoteLib.SNARK_FIELD) revert BadField();

        _pull(token, amount);
        uint256 note = NoteLib.commitment(poseidon3, token, amount, secretHash);
        _insert(note);
        emit Deposited(token, amount, note);
    }

    /// @notice Şifreli emir gönder. Kanıt, `ciphertext`'e bağlıdır (ctxHash = keccak mod p):
    ///         mempool'dan kopyalanıp başka ciphertext ile kullanılamaz. Herkes gönderebilir
    ///         (msg.sender kullanılmaz; relayer üzerinden gönderim adresi gizler).
    function submitShieldedOrder(bytes calldata ciphertext, SpendProof calldata p)
        external
        live
        nonReentrant
        returns (bytes32 orderId)
    {
        orderId = _submitOrder(ciphertext, p, bytes32(0), keccak256(ciphertext));
    }

    /// @notice `submitShieldedOrder` + lot satış anahtarı. Sonucu kilitliyken yalnızca anahtar zincirini
    ///         bilen (emir sahibi) satabilir: `lotKeyHash = keccak256^n(seed)`, her satış bir önceki
    ///         halkayı açar. Kanıt `lotKeyHash`'e de bağlıdır (ctxHash = keccak(ciphertext || lotKeyHash)):
    ///         mempool'dan kopyalayan biri anahtarı değiştiremez.
    function submitShieldedOrderWithLotKey(bytes calldata ciphertext, SpendProof calldata p, bytes32 lotKeyHash)
        external
        live
        nonReentrant
        returns (bytes32 orderId)
    {
        if (lotKeyHash == bytes32(0)) revert LotKeyInvalid();
        orderId = _submitOrder(ciphertext, p, lotKeyHash, keccak256(abi.encodePacked(ciphertext, lotKeyHash)));
    }

    function _submitOrder(bytes calldata ciphertext, SpendProof calldata p, bytes32 lotKeyHash, bytes32 ctx)
        internal
        returns (bytes32 orderId)
    {
        if (ciphertext.length != CIPHERTEXT_LEN || ciphertext[0] != 0x01) revert BadCiphertext();
        orderId = keccak256(ciphertext);
        if (orders[orderId].window != 0) revert DuplicateOrder();

        _spend(p, NoteLib.toField(ctx));

        uint64 window = currentWindow();
        uint256 shard = uint256(orderId) % SHARDS;
        Window storage w = _link(window);
        uint256 index = w.counts[shard];
        if (index >= MAX_ORDERS_PER_SHARD) revert ShardFull();

        w.chains[shard] = DarkPoolLib.orderChainStep(w.chains[shard], orderId, p.spendCommitment);
        w.counts[shard] = index + 1;
        orders[orderId] =
            Order({window: window, done: false, spendCommitment: p.spendCommitment, lotKey: lotKeyHash});

        // forge-lint: disable-next-line(unsafe-typecast) shard < 16, index < 16
        emit OrderSubmitted(window, orderId, uint8(shard), uint32(index), p.spendCommitment, ciphertext);
    }

    /// @notice Kilidi açılmamış bir alımı ("lot") miktarını bilmeden yüzdeyle sat. Ciphertext yüzdeyi ve
    ///         sahiplik açılışını taşır; miktarı yalnızca enclave, lotun sonucundaki enclave notundan okur.
    ///         Lot, satış settle edilene kadar kilitlenir (aynı lot iki kez satılamaz, claim edilemez).
    /// @dev `lotKey`, lotun anahtar zincirindeki bir sonraki halka ve yalnızca emir sahibi bilir: başkası
    ///      geçersiz bir satışla lotu kilitleyemez. Açılan halka zincirin yeni başı olur (satış reddedilse
    ///      bile); görülen bir anahtar ikinci kez kullanılamaz. Kalan lot (satış emri) aynı zincirle sürer.
    function submitLotSell(bytes calldata ciphertext, bytes32 lot, bytes32 lotKey)
        external
        live
        nonReentrant
        returns (bytes32 orderId)
    {
        if (ciphertext.length != CIPHERTEXT_LEN || ciphertext[0] != 0x01) revert BadCiphertext();
        orderId = keccak256(ciphertext);
        if (orders[orderId].window != 0) revert DuplicateOrder();
        Order storage l = orders[lot];
        if (l.lotKey == bytes32(0) || keccak256(abi.encodePacked(lotKey)) != l.lotKey) revert LotKeyInvalid();
        // Lot, settle edilmiş ve henüz claim edilmemiş bir emrin sonucu olmalı.
        if (l.window == 0 || l.window > lastSettledWindow || l.done || lotState[lot] != LOT_FREE) {
            revert LotUnavailable();
        }
        lotState[lot] = LOT_PENDING;
        l.lotKey = lotKey;

        uint64 window = currentWindow();
        uint256 shard = uint256(orderId) % SHARDS;
        Window storage w = _link(window);
        uint256 index = w.counts[shard];
        if (index >= MAX_ORDERS_PER_SHARD) revert ShardFull();
        // Emir zincirinde "spendCommitment" alanı lot kimliğini taşır: enclave'in gördüğü lot bağlıdır.
        w.chains[shard] = DarkPoolLib.orderChainStep(w.chains[shard], orderId, uint256(lot));
        w.counts[shard] = index + 1;
        w.lotSellCount += 1;
        orders[orderId] = Order({window: window, done: false, spendCommitment: uint256(lot), lotKey: lotKey});
        lotSells[orderId] = LotSell({lot: lot, window: window, settled: false});

        // forge-lint: disable-next-line(unsafe-typecast) shard < 16, index < 16
        emit OrderSubmitted(window, orderId, uint8(shard), uint32(index), uint256(lot), ciphertext);
        emit LotSellSubmitted(orderId, lot);
    }

    /// @notice Notu (bir kısmını) cüzdana çek. Token ve miktar yalnızca bu çıkış anında görünür.
    /// @dev Kanıt `recipient`'a bağlıdır; açılış (token, amount, spendBlinding) spendCommitment'ı vermelidir.
    function withdraw(SpendProof calldata p, address token, uint128 amount, uint256 spendBlinding, address recipient)
        external
        nonReentrant
    {
        if (NoteLib.commitment(poseidon3, token, amount, spendBlinding) != p.spendCommitment) revert SpendMismatch();
        _spend(p, withdrawContext(recipient));
        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawn(p.nullifier, token, recipient, amount);
    }

    /// @notice 7 gün dolduktan sonra enclave'in ürettiği sonuç notunu ağaca ekler. Herkes çağırabilir;
    ///         not yalnızca sahibince harcanabilir ve miktar görünmez.
    function claimNote(
        uint64 batchId,
        bytes32 orderId,
        uint256 commitment,
        bytes32 sealedResultHash,
        bytes32[] calldata proof
    ) external nonReentrant {
        Batch storage b = batches[batchId];
        if (block.timestamp < b.unlockTime) revert Locked();
        Order storage o = _openOrder(orderId, b.window);
        bytes32 leaf = DarkPoolLib.resultLeaf(orderId, DarkPoolLib.STATUS_FILLED, bytes32(commitment), sealedResultHash);
        if (!MerkleProof.verifyCalldata(proof, b.resultsRoot, leaf)) revert InvalidProof();
        uint8 ls = lotState[orderId];
        if (ls == LOT_PENDING) revert LotUnavailable();

        o.done = true;
        bool consumed = ls == LOT_CONSUMED;
        if (lotSells[orderId].window != 0) {
            // Lot satışı: gelir notu her zaman; kalan lot, sonradan satılmadıysa.
            _insert(commitment);
            uint256 rest = remainders[orderId];
            if (!consumed && rest != 0) _insert(rest);
        } else if (!consumed) {
            // Satılmış bir alımın notu ağaca girmez (karşılığı satış emrinin notlarıdır).
            _insert(commitment);
        }
        emit NoteClaimed(orderId, commitment);
    }

    /// @notice Enclave emri çözemediyse/fonlamayı doğrulayamadıysa: harcanan kısım (spendCommitment,
    ///         kullanıcıya ait bir not biçiminde) hemen ağaca geri döner. Açılış gerekmez.
    function returnRefunded(uint64 batchId, bytes32 orderId, bytes32[] calldata proof) external nonReentrant {
        // Lot satışı not harcamaz: reddedilince lot settlement'ta serbest kalır, iade edilecek not yok.
        if (lotSells[orderId].window != 0) revert LotMismatch();
        Batch storage b = batches[batchId];
        Order storage o = _openOrder(orderId, b.window);
        bytes32 leaf = DarkPoolLib.resultLeaf(orderId, DarkPoolLib.STATUS_REFUNDED, bytes32(0), keccak256(""));
        if (!MerkleProof.verifyCalldata(proof, b.resultsRoot, leaf)) revert InvalidProof();

        o.done = true;
        _insert(o.spendCommitment);
        emit OrderReturned(orderId, o.spendCommitment);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Enclave'in imzaladığı batch sonucunu uygular. Herkes çağırabilir (relayer'a özel yetki yok).
    function settleBatch(SettleParams calldata p, Result[] calldata results, LotUpdate[] calldata lots)
        external
        live
        nonReentrant
    {
        uint64 unlockTime = _checkTiming(p.window, p.unlockRound);
        bytes32 resultsRoot = _checkResults(p.window, results);
        uint64 batchId = settledCount + 1;
        bytes32 newStateHash = keccak256(p.newSealedState);
        _checkSignature(p, batchId, newStateHash, resultsRoot, _applyLots(p.window, lots));

        batches[batchId] = Batch({
            resultsRoot: resultsRoot, window: p.window, unlockTime: unlockTime, reservesCommitment: p.reservesCommitment
        });
        settledCount = batchId;
        lastSettledWindow = p.window;
        stateHash = newStateHash;

        emit BatchSettled(batchId, p.window, resultsRoot, p.unlockRound, unlockTime);
        emit BatchData(batchId, p.newSealedState, p.capsule, p.sealedSummary, results);
        if (lots.length != 0) emit BatchLots(batchId, lots);
    }

    // ------------------------------------------------------------------ kaçış kapağı

    /// @notice Settle edilmeyi bekleyen en eski pencere `ESCAPE_DELAY` kadar gecikmişse
    ///         vault kalıcı olarak kaçış moduna geçer. Herkes çağırabilir.
    function activateEscape() external live {
        uint64 stuck = windows[lastSettledWindow].next;
        if (stuck == 0 || block.timestamp < windowEnd(stuck) + ESCAPE_DELAY) revert NotStuck();
        escaped = true;
        emit EscapeActivated(stuck);
    }

    /// @notice Kaçış modunda: settle edilmemiş bir emrin harcanan kısmını not olarak ağaca geri koyar.
    ///         Herkes çağırabilir; not yalnızca sahibince harcanır. Notlar `withdraw` ile enclave'siz çekilir.
    function escapeReturnOrder(bytes32 orderId) external nonReentrant {
        if (!escaped) revert NotEscaped();
        Order storage o = orders[orderId];
        if (o.window == 0) revert WrongWindow();
        if (o.done) revert AlreadyDone();
        if (o.window <= lastSettledWindow) revert AlreadySettled();

        o.done = true;
        LotSell storage sale = lotSells[orderId];
        if (sale.window != 0) {
            // Settle edilmemiş lot satışı: lot serbest kalır (sahibi kilit açılınca claim eder).
            lotState[sale.lot] = LOT_FREE;
            emit OrderReturned(orderId, 0);
            return;
        }
        _insert(o.spendCommitment);
        emit OrderReturned(orderId, o.spendCommitment);
    }

    /// @notice Kaçış modunda, hiç settle edilmemiş bir havuzun başlangıç likiditesini geri al.
    function escapeReclaimPool(uint32 poolId, address to) external nonReentrant {
        if (!escaped) revert NotEscaped();
        Pool storage p = pools[poolId];
        if (p.creator != msg.sender) revert NotOwner();
        if (p.reclaimed) revert AlreadyDone();
        if (p.window <= lastSettledWindow) revert AlreadySettled();

        p.reclaimed = true;
        IERC20(p.baseToken).safeTransfer(to, p.initBase);
        IERC20(quoteToken).safeTransfer(to, p.initQuote);
        emit PoolReclaimed(poolId, to);
    }

    /// @notice Kaçış modunda: son settle edilen batch'in rezervlerini açar. Değerler ve tuz, o batch'in
    ///         7 gün kilitli özetinde; kilit açılınca herkes drand ile çözüp buraya getirebilir.
    /// @dev Liste enclave'in commitment'ladığı listeyle birebir aynı olmalı (tüm havuzlar, pool_id sırası).
    function revealFinalReserves(
        uint32[] calldata poolIds,
        uint128[] calldata base,
        uint128[] calldata quote,
        bytes32 salt
    ) external {
        if (!escaped) revert NotEscaped();
        if (finalReservesRevealed) revert AlreadyDone();
        uint64 last = settledCount;
        Batch storage b = batches[last];
        if (last == 0) revert NotRevealed();
        if (block.timestamp < b.unlockTime) revert Locked();
        if (poolIds.length != base.length || poolIds.length != quote.length) revert InvalidReveal();
        if (DarkPoolLib.reservesCommitment(last, salt, poolIds, base, quote) != b.reservesCommitment) {
            revert InvalidReveal();
        }

        finalReservesRevealed = true;
        for (uint256 i = 0; i < poolIds.length; ++i) {
            finalReserves[poolIds[i]] = Reserves({revealed: true, base: base[i], quote: quote[i]});
        }
        emit FinalReservesRevealed(last, poolIds.length);
    }

    /// @notice Kaçış modunda: settle edilmiş bir havuzun açılan rezervlerini (ücretler dahil) LP'ye öder.
    function escapeWithdrawLiquidity(uint32 poolId, address to) external nonReentrant {
        if (!escaped) revert NotEscaped();
        Pool storage p = pools[poolId];
        if (p.creator != msg.sender) revert NotOwner();
        if (p.reclaimed) revert AlreadyDone();
        Reserves memory r = finalReserves[poolId];
        if (!r.revealed) revert NotRevealed();

        p.reclaimed = true;
        IERC20(p.baseToken).safeTransfer(to, r.base);
        IERC20(quoteToken).safeTransfer(to, r.quote);
        emit LiquidityWithdrawn(poolId, to, r.base, r.quote);
    }

    // ------------------------------------------------------------------ iç

    /// @dev Kanıtı doğrular, nullifier'ı harcar, para üstü notunu ağaca ekler.
    function _spend(SpendProof calldata p, uint256 ctxHash) internal {
        if (!tree.isKnownRoot(p.root)) revert UnknownRoot();
        if (nullifierSpent[p.nullifier]) revert NullifierSpent();
        if (
            p.nullifier >= NoteLib.SNARK_FIELD || p.changeCommitment >= NoteLib.SNARK_FIELD
                || p.spendCommitment >= NoteLib.SNARK_FIELD
        ) revert BadField();
        if (!verifier.verifyProof(p.a, p.b, p.c, [p.root, p.nullifier, p.changeCommitment, p.spendCommitment, ctxHash]))
        revert InvalidSpendProof();

        nullifierSpent[p.nullifier] = true;
        _insert(p.changeCommitment);
    }

    function _insert(uint256 commitment) internal {
        uint32 index = tree.insert(poseidon2, commitment);
        emit NoteInserted(commitment, index);
    }

    /// @dev Pencereyi "işlem içeren pencereler" listesine bir kez ekler.
    function _link(uint64 window) internal returns (Window storage w) {
        w = windows[window];
        if (!w.linked) {
            w.linked = true;
            windows[lastLinkedWindow].next = window;
            lastLinkedWindow = window;
        }
    }

    /// @dev Fee-on-transfer / rebasing tokenlar muhasebeyi bozar; reddedilir.
    function _pull(address token, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
    }

    function _openOrder(bytes32 orderId, uint64 window) internal view returns (Order storage o) {
        o = orders[orderId];
        if (o.done) revert AlreadyDone();
        if (window == 0 || o.window != window) revert WrongWindow();
    }

    function _checkTiming(uint64 window, uint64 unlockRound) internal view returns (uint64) {
        if (window == 0 || window != windows[lastSettledWindow].next) revert WrongWindow();
        if (block.timestamp < windowEnd(window)) revert WindowOpen();
        // Enclave kilidi kendi saatiyle koyar; kontrat en az 7 gün olduğunu garanti eder.
        uint256 unlockTime = DrandQuicknet.roundTime(unlockRound);
        if (unlockTime < block.timestamp + LOCK_SECONDS) revert UnlockTooEarly();
        // Üst sınır: hatalı/kötü bir tur fonları süresiz kilitlemesin ve uint64'e sığsın.
        if (unlockTime > block.timestamp + LOCK_SECONDS + MAX_EXTRA_LOCK) revert UnlockTooLate();
        // forge-lint: disable-next-line(unsafe-typecast) üst sınır yukarıda kontrol edildi
        return uint64(unlockTime);
    }

    function _checkResults(uint64 window, Result[] calldata results) internal view returns (bytes32) {
        Window storage w = windows[window];
        uint256 total;
        for (uint256 s = 0; s < SHARDS; ++s) {
            total += w.counts[s];
        }
        if (results.length != total) revert ResultCountMismatch();
        return _resultsRoot(results);
    }

    /// @dev Girdiyi (emir zincirleri, havuz açılışları, fee, quote token) kontratın KENDİ
    ///      kayıtlarından koyar: relayer enclave'e yalan söylediyse imza tutmaz.
    /// @dev Penceredeki HER lot satışı için tam olarak bir güncelleme (enclave imzalı, lotsHash ile).
    ///      Gerçekleşen satış lotu tüketir; gerçekleşmeyen lotu serbest bırakır.
    function _applyLots(uint64 window, LotUpdate[] calldata lots) internal returns (bytes32 chain) {
        if (lots.length != windows[window].lotSellCount) revert LotMismatch();
        for (uint256 i = 0; i < lots.length; ++i) {
            LotUpdate calldata u = lots[i];
            LotSell storage sale = lotSells[u.sellOrderId];
            if (sale.window != window || sale.settled) revert LotMismatch();
            sale.settled = true;
            if (u.filled) {
                lotState[sale.lot] = LOT_CONSUMED;
                if (u.remainderCommitment != bytes32(0)) remainders[u.sellOrderId] = uint256(u.remainderCommitment);
            } else {
                lotState[sale.lot] = LOT_FREE;
            }
            chain = DarkPoolLib.lotChainStep(
                chain, u.sellOrderId, u.filled, u.remainderCommitment, keccak256(u.sealedRemainder)
            );
        }
    }

    function _checkSignature(
        SettleParams calldata p,
        uint64 batchId,
        bytes32 newStateHash,
        bytes32 resultsRoot,
        bytes32 lotsHash
    ) internal view {
        Window storage w = windows[p.window];
        bytes32 digest = DarkPoolLib.settlementDigest(
            DarkPoolLib.Settlement({
                chainId: block.chainid,
                vault: address(this),
                batchId: batchId,
                prevStateHash: stateHash,
                newStateHash: newStateHash,
                resultsRoot: resultsRoot,
                unlockRound: p.unlockRound,
                capsuleHash: keccak256(p.capsule),
                summaryHash: keccak256(p.sealedSummary),
                quoteToken: quoteToken,
                feeBps: feeBps,
                ordersHash: keccak256(abi.encodePacked(w.chains)),
                poolsHash: w.poolsChain,
                reservesCommitment: p.reservesCommitment,
                lotsHash: lotsHash
            })
        );
        if (!registry.isEnclave(ECDSA.recover(digest, p.signature))) revert InvalidSigner();
    }

    function _resultsRoot(Result[] calldata results) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](results.length);
        for (uint256 i = 0; i < results.length; ++i) {
            Result calldata r = results[i];
            leaves[i] = DarkPoolLib.resultLeaf(r.orderId, r.status, r.commitment, keccak256(r.sealedResult));
        }
        return DarkPoolLib.merkleRoot(leaves);
    }
}
