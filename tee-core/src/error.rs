use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid public key")]
    InvalidPublicKey,
    #[error("invalid secret key")]
    InvalidSecretKey,
    #[error("ciphertext malformed")]
    MalformedCiphertext,
    #[error("unsupported version {0}")]
    UnsupportedVersion(u8),
    #[error("decryption failed")]
    DecryptionFailed,
    #[error("encryption failed")]
    EncryptionFailed,
    #[error("signing failed")]
    SigningFailed,
    #[error("malformed order: {0}")]
    MalformedOrder(&'static str),
    #[error("malformed state")]
    MalformedState,
    #[error("pool reserves must be non-zero")]
    EmptyPool,
    #[error("fee_bps must be < 10000")]
    InvalidFee,
    #[error("arithmetic overflow")]
    Overflow,
    #[error("invariant violated: k decreased")]
    InvariantViolated,
    #[error("pool {0} already exists")]
    DuplicatePool(u32),
    #[error("batch out of order: expected {expected}, got {got}")]
    BatchOutOfOrder { expected: u64, got: u64 },
    #[error("value is not a canonical BN254 field element")]
    NonCanonicalField,
    #[error("too many orders in batch: {0}")]
    TooManyOrders(usize),
    #[error("timelock encryption failed")]
    TimelockFailed,
    #[error("timelock not yet openable or wrong beacon")]
    TimelockOpenFailed,
}
