//! Clone failure/rejection reasons (PDC-0107: understandable errors for unsupported DB interfaces, non-transactional tables, and unknown columns).

use std::fmt;

/// Clone-related errors. Every variant describes the cause in understandable, presentable English text
/// and carries no underlying SQL/credential details (exported logs must be redacted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneError {
    /// Unknown/unsupported database interface (only mysql is used by the engine for entity persistence; the redis backend does not persist entities).
    UnsupportedDbInterface(String),
    /// Source/target table not in the derived schema allowlist (guessing relations by string prefix is forbidden).
    UnknownTable(String),
    /// Target column does not exist in the derived schema (writing to unverified columns is forbidden).
    UnknownColumn { table: String, column: String },
    /// Table is not an InnoDB transactional table (a consistent snapshot cannot be guaranteed).
    NonTransactionalTable(String),
    /// Relation rule references a nonexistent entity/attribute.
    InvalidRule(String),
    /// Cycle in the plan (e.g. a child table recursing back to itself) or a duplicate relation.
    CycleDetected(String),
    /// Row/byte budget exceeded (truncated honestly, never faked as complete).
    BudgetExceeded { limit: u64, requested: u64 },
    /// Physical layer (information tables) disagrees with the derived schema; rejected fail-closed.
    DriftMismatch(String),
    /// Archive write/read/verify failure (IO, format, hash, size, encryption).
    ArchiveError(String),
    /// Import preconditions gate rejected (environment declaration/write intent/re-import policy, plan §6.1).
    ImportRejected(String),
    /// Unique key/primary key conflict with a reject policy (PDC-0305 fail-closed, without sensitive original values).
    ImportConflict(String),
}

impl fmt::Display for CloneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloneError::UnsupportedDbInterface(s) => {
                write!(f, "unsupported database interface `{s}` (entity persistence uses mysql)")
            }
            CloneError::UnknownTable(t) => write!(
                f,
                "table `{t}` is not in the derived schema allowlist; refusing to guess a relation by name prefix"
            ),
            CloneError::UnknownColumn { table, column } => {
                write!(f, "column `{column}` is not a known column of table `{table}`")
            }
            CloneError::NonTransactionalTable(t) => write!(
                f,
                "table `{t}` is not an InnoDB transactional table; a consistent snapshot is not guaranteed"
            ),
            CloneError::InvalidRule(s) => write!(f, "invalid relation rule: {s}"),
            CloneError::CycleDetected(s) => write!(f, "relation cycle detected: {s}"),
            CloneError::BudgetExceeded { limit, requested } => write!(
                f,
                "row budget exceeded (limit {limit}, requested {requested}); result is truncated, not complete"
            ),
            CloneError::DriftMismatch(s) => write!(
                f,
                "derived and physical schema disagree ({s}); failing closed rather than guessing"
            ),
            CloneError::ArchiveError(s) => write!(f, "archive error: {s}"),
            CloneError::ImportRejected(s) => {
                write!(f, "import rejected: {s}")
            }
            CloneError::ImportConflict(s) => {
                write!(f, "unique key conflict: {s}")
            }
        }
    }
}

impl std::error::Error for CloneError {}

/// Unified Result alias for this crate.
pub type CloneResult<T> = Result<T, CloneError>;
