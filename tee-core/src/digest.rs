//! Settlement özeti. Faz 2'deki Solidity tarafı birebir şunu hesaplayacak:
//!
//! ```solidity
//! keccak256(abi.encodePacked(
//!     "darkpool/settle/v1", uint256(block.chainid), address(this),
//!     uint256(batchId), prevStateHash, newStateHash, resultsRoot,
//!     uint256(unlockRound), keccak256(capsule), keccak256(sealedSummary),
//!     quoteToken, uint256(feeBps), ordersHash, poolsHash, reservesCommitment
//! ))
//! ```
//! `ordersHash` / `poolsHash` enclave'in gördüğü girdiyi bağlar: relayer yatırılan
//! tutar, token, fee veya havuz açılışı hakkında yalan söylerse kontrat kendi
//! kayıtlarından hesapladığı değerle eşleşmez. `reservesCommitment` batch sonrası
//! rezervlere tuzlu commitment'tır; açılışı 7 gün kilitli özettedir (kaçış modunda LP payı).
//!
//! `ecrecover` sonucu kayıtlı (attested) enclave adresine eşit olmalı. Kontrat ayrıca
//! `roundTime(unlockRound) >= block.timestamp + 7 gün` kontrol eder; TEE kilidi kısaltamaz.

use sha3::{Digest, Keccak256};

const TAG: &[u8] = b"darkpool/settle/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub chain_id: u64,
    pub vault: [u8; 20],
    pub batch_id: u64,
    pub prev_state_hash: [u8; 32],
    pub new_state_hash: [u8; 32],
    pub results_root: [u8; 32],
    pub unlock_round: u64,
    pub capsule_hash: [u8; 32],
    pub summary_hash: [u8; 32],
    pub quote_token: [u8; 20],
    pub fee_bps: u16,
    pub orders_hash: [u8; 32],
    pub pools_hash: [u8; 32],
    pub reserves_commitment: [u8; 32],
}

fn u256_be(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

impl Settlement {
    pub fn digest(&self) -> [u8; 32] {
        let mut h = Keccak256::new();
        h.update(TAG);
        h.update(u256_be(self.chain_id));
        h.update(self.vault);
        h.update(u256_be(self.batch_id));
        h.update(self.prev_state_hash);
        h.update(self.new_state_hash);
        h.update(self.results_root);
        h.update(u256_be(self.unlock_round));
        h.update(self.capsule_hash);
        h.update(self.summary_hash);
        h.update(self.quote_token);
        h.update(u256_be(u64::from(self.fee_bps)));
        h.update(self.orders_hash);
        h.update(self.pools_hash);
        h.update(self.reserves_commitment);
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{recover_address, EnclaveKey};

    #[test]
    fn signed_settlement_recovers_enclave() {
        let key = EnclaveKey::generate();
        let s = Settlement {
            chain_id: 10143,
            vault: [0x11; 20],
            batch_id: 1,
            prev_state_hash: [0; 32],
            new_state_hash: [1; 32],
            results_root: [2; 32],
            unlock_round: 99,
            capsule_hash: [3; 32],
            summary_hash: [4; 32],
            quote_token: [5; 20],
            fee_bps: 30,
            orders_hash: [6; 32],
            pools_hash: [7; 32],
            reserves_commitment: [8; 32],
        };
        let d = s.digest();
        let sig = key.sign_digest(&d).unwrap();
        assert_eq!(recover_address(&d, &sig).unwrap(), key.eth_address());

        assert_ne!(Settlement { unlock_round: 98, ..s.clone() }.digest(), d);
        assert_ne!(Settlement { fee_bps: 0, ..s.clone() }.digest(), d);
        assert_ne!(Settlement { orders_hash: [0; 32], ..s }.digest(), d);
    }
}
