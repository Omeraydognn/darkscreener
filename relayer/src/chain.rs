//! Monad bağlantısı: kontrat bağlamaları + sıralı işlem gönderici.
//!
//! Monad notları:
//! - Gaz LİMİTİ üzerinden ücretlendirilir: her işlem önce `estimate_gas` ile ölçülür, üzerine
//!   küçük bir pay eklenir. Elle yüksek limit verilmez.
//! - `eth_sendRawTransaction` nonce/bakiye doğrulamasını erteler: işlemler tek bir kilit altında
//!   sırayla gönderilir ve makbuzu beklenir, böylece nonce boşluğu oluşmaz.

use std::time::Duration;

use alloy::{
    contract::{CallBuilder, CallDecoder},
    network::EthereumWallet,
    primitives::{Address, TxHash},
    providers::{DynProvider, Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    sol,
};
use anyhow::{anyhow, bail, Context, Result};
use tokio::sync::Mutex;

sol! {
    #[sol(rpc)]
    #[derive(Debug)]
    interface IDarkVault {
        struct SpendProof {
            uint256[2] a;
            uint256[2][2] b;
            uint256[2] c;
            uint256 root;
            uint256 nullifier;
            uint256 changeCommitment;
            uint256 spendCommitment;
        }
        struct SettleParams {
            uint64 window;
            uint64 unlockRound;
            bytes newSealedState;
            bytes capsule;
            bytes sealedSummary;
            bytes32 reservesCommitment;
            bytes signature;
        }
        struct Result {
            bytes32 orderId;
            uint8 status;
            bytes32 commitment;
            bytes sealedResult;
        }
        struct LotUpdate {
            bytes32 sellOrderId;
            bool filled;
            bytes32 remainderCommitment;
            bytes sealedRemainder;
        }

        event NoteInserted(uint256 indexed commitment, uint32 index);
        event PoolCreated(uint32 indexed poolId, address indexed baseToken, uint64 indexed window, uint128 base, uint128 quote);
        event OrderSubmitted(uint64 indexed window, bytes32 indexed orderId, uint8 shard, uint32 index, uint256 spendCommitment, bytes ciphertext);
        event BatchSettled(uint64 indexed batchId, uint64 indexed window, bytes32 resultsRoot, uint64 unlockRound, uint64 unlockTime);
        event BatchData(uint64 indexed batchId, bytes newSealedState, bytes capsule, bytes sealedSummary, Result[] results);
        event LotSellSubmitted(bytes32 indexed orderId, bytes32 indexed lot);
        event BatchLots(uint64 indexed batchId, LotUpdate[] lots);

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
        error NotRevealed();
        error LotUnavailable();
        error LotMismatch();

        function quoteToken() external view returns (address);
        function genesisTime() external view returns (uint256);
        function windowSeconds() external view returns (uint256);
        function feeBps() external view returns (uint256);
        function registry() external view returns (address);
        function escaped() external view returns (bool);
        function settledCount() external view returns (uint64);
        function nextWindowToSettle() external view returns (uint64);
        function windowEnd(uint64 window) external view returns (uint256);
        function ordersHash(uint64 window) external view returns (bytes32);
        function windowPools(uint64 window) external view returns (uint32[] memory ids, bytes32 poolsChain);
        function orders(bytes32 orderId) external view returns (uint64 window, bool done, uint256 spendCommitment);
        function batches(uint64 batchId) external view returns (bytes32 resultsRoot, uint64 window, uint64 unlockTime, bytes32 reservesCommitment);

        function lotState(bytes32 lot) external view returns (uint8);
        function lotSells(bytes32 orderId) external view returns (bytes32 lot, uint64 window, bool settled);

        function settleBatch(SettleParams calldata p, Result[] calldata results, LotUpdate[] calldata lots) external;
        function submitLotSell(bytes calldata ciphertext, bytes32 lot) external returns (bytes32 orderId);
        function submitShieldedOrder(bytes calldata ciphertext, SpendProof calldata p) external returns (bytes32 orderId);
        function withdraw(SpendProof calldata p, address token, uint128 amount, uint256 spendBlinding, address recipient) external;
        function claimNote(uint64 batchId, bytes32 orderId, uint256 commitment, bytes32 sealedResultHash, bytes32[] calldata proof) external;
        function returnRefunded(uint64 batchId, bytes32 orderId, bytes32[] calldata proof) external;
        function launchpad() external view returns (address);
    }

    #[sol(rpc)]
    interface ILaunchPad {
        function gateway() external view returns (address);
        function minQuote() external view returns (uint128);
        function launches(uint32 poolId) external view returns (address creator, address token, bytes32 metadataHash, uint64 time);
    }

    #[sol(rpc)]
    interface IMonGateway {
        error ZeroAmount();
        error TransferFailed();
        function usdPerMon() external view returns (uint256);
        function setRate(uint256 usdPerMon) external;
        function boxOf(address to) external view returns (address);
        function redeem(address to) external returns (uint256 value);
    }

    #[sol(rpc)]
    interface IERC20Meta {
        function name() external view returns (string);
        function symbol() external view returns (string);
        function decimals() external view returns (uint8);
    }

    #[sol(rpc)]
    interface IEnclaveRegistry {
        function isEnclave(address signer) external view returns (bool);
    }
}

pub type Vault = IDarkVault::IDarkVaultInstance<DynProvider>;

/// Tahmini gaza eklenen pay (%20 + sabit). Monad limiti ücretlendirdiği için büyük tutulmaz.
fn with_margin(gas: u64) -> u64 {
    gas + gas / 5 + 10_000
}

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Chain {
    pub provider: DynProvider,
    pub vault: Vault,
    pub registry: IEnclaveRegistry::IEnclaveRegistryInstance<DynProvider>,
    pub sender: Address,
    pub chain_id: u64,
    pub quote_token: Address,
    pub fee_bps: u16,
    pub genesis_time: u64,
    pub window_seconds: u64,
    /// Vault'a bağlı launchpad (izinsiz proje açılışı) ve MON köprüsü; eski dağıtımlarda yok.
    pub launchpad: Option<ILaunchPad::ILaunchPadInstance<DynProvider>>,
    pub gateway: Option<IMonGateway::IMonGatewayInstance<DynProvider>>,
    send_lock: Mutex<()>,
}

impl Chain {
    pub async fn connect(rpc_url: &str, vault: Address, signer: PrivateKeySigner) -> Result<Self> {
        let sender = signer.address();
        // Herkese açık Monad RPC'si istek/sn sınırlıdır (-32011 / 429): sınırda üstel bekleyip yeniden dene.
        let client = alloy::rpc::client::ClientBuilder::default()
            .layer(alloy::transports::layers::RetryBackoffLayer::new_with_policy(
                12,
                400,
                300,
                // Monad: "-32011 requests limited to N/sec" standart 429 değil
                alloy::transports::layers::RateLimitRetryPolicy::default()
                    .or(|e| e.as_error_resp().is_some_and(|r| r.code == -32011)),
            ))
            .http(rpc_url.parse().context("RPC_URL")?);
        let provider = ProviderBuilder::new().wallet(EthereumWallet::from(signer)).connect_client(client).erased();
        let chain_id = provider.get_chain_id().await.context("chain id")?;
        let v = IDarkVault::new(vault, provider.clone());
        let quote_token = v.quoteToken().call().await.context("vault.quoteToken (VAULT_ADDRESS doğru mu?)")?;
        let fee = v.feeBps().call().await?;
        let registry = IEnclaveRegistry::new(v.registry().call().await?, provider.clone());
        let genesis_time = u64::try_from(v.genesisTime().call().await?)?;
        let window_seconds = u64::try_from(v.windowSeconds().call().await?)?;
        let launchpad = match v.launchpad().call().await {
            Ok(a) if a != Address::ZERO => Some(ILaunchPad::new(a, provider.clone())),
            _ => None,
        };
        let gateway = match &launchpad {
            Some(l) => Some(IMonGateway::new(l.gateway().call().await.context("launchpad.gateway")?, provider.clone())),
            None => None,
        };
        Ok(Self {
            provider,
            vault: v,
            registry,
            sender,
            chain_id,
            quote_token,
            fee_bps: u16::try_from(fee).map_err(|_| anyhow!("fee_bps out of range"))?,
            genesis_time,
            window_seconds,
            launchpad,
            gateway,
            send_lock: Mutex::new(()),
        })
    }

    /// Önce simüle eder (revert nedenini okunur verir), sonra gönderir ve makbuzu bekler.
    pub async fn send<D: CallDecoder + Send + Sync + Unpin>(
        &self,
        what: &str,
        call: CallBuilder<&DynProvider, D>,
    ) -> Result<TxHash> {
        let _guard = self.send_lock.lock().await;
        let gas = call.estimate_gas().await.map_err(|e| anyhow!("{what}: {}", describe(&e)))?;
        let pending = call
            .gas(with_margin(gas))
            .send()
            .await
            .map_err(|e| anyhow!("{what}: send: {}", describe(&e)))?;
        let hash = *pending.tx_hash();
        let receipt = tokio::time::timeout(RECEIPT_TIMEOUT, pending.get_receipt())
            .await
            .map_err(|_| anyhow!("{what}: receipt timeout for {hash}"))??;
        if !receipt.status() {
            bail!("{what}: reverted on-chain ({hash})");
        }
        tracing::info!(%hash, gas_limit = with_margin(gas), gas_used = receipt.gas_used, "{what} confirmed");
        Ok(hash)
    }

    /// Pencerenin kapandığı an (batch'in grafik zamanı).
    pub fn window_end(&self, window: u64) -> u64 {
        self.genesis_time + window * self.window_seconds
    }

    pub async fn token_meta(&self, token: Address) -> Result<(String, String, u8)> {
        let t = IERC20Meta::new(token, self.provider.clone());
        Ok((t.name().call().await?, t.symbol().call().await?, t.decimals().call().await?))
    }

    pub async fn latest_timestamp(&self) -> Result<u64> {
        let block = self
            .provider
            .get_block_by_number(alloy::eips::BlockNumberOrTag::Latest)
            .await?
            .ok_or_else(|| anyhow!("no latest block"))?;
        Ok(block.header.timestamp)
    }
}

/// Revert'i kontratın özel hata adına çevirir (ör. "UnknownRoot"), yoksa ham mesaj.
pub fn describe(e: &alloy::contract::Error) -> String {
    if let Some(err) = e.as_decoded_interface_error::<IDarkVault::IDarkVaultErrors>() {
        return format!("{err:?}");
    }
    e.to_string()
}
