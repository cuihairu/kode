//! Clone 失败/拒绝原因(PDC-0107:对不支持的 DB 接口、非事务表及未知列给出可理解错误)。

use std::fmt;

/// 克隆相关错误。所有变体都以「可理解、可展示」的英文文案描述原因,
/// 不携带底层 SQL/凭据细节(导出日志须脱敏)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneError {
    /// 未知/不支持的数据库接口(仅 mysql 被引擎用于实体持久化;redis 后端不持久化实体)。
    UnsupportedDbInterface(String),
    /// 源/目标表不在派生 schema 白名单内(禁止按字符串前缀猜测关系)。
    UnknownTable(String),
    /// 目标列在派生 schema 中不存在(禁止写入未经校验的列)。
    UnknownColumn { table: String, column: String },
    /// 表非 InnoDB 事务表(无法保证一致快照)。
    NonTransactionalTable(String),
    /// 关系规则引用了不存在的实体/属性。
    InvalidRule(String),
    /// 计划中的环路(如子表递归回到自身)或重复关系。
    CycleDetected(String),
    /// 行/字节预算被截断(诚实截断,不伪完整)。
    BudgetExceeded { limit: u64, requested: u64 },
    /// 物理层(信息表)与派生 schema 不一致,按 fail-closed 拒绝。
    DriftMismatch(String),
    /// 归档写入/读取/校验失败(IO、格式、哈希、大小、加密)。
    ArchiveError(String),
    /// 导入前置门槛拒绝(环境声明/写意图/重复导入策略,plan §6.1)。
    ImportRejected(String),
    /// 唯一键/主键冲突且策略为拒绝(PDC-0305 fail-closed,不带敏感原值)。
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

/// 本 crate 统一的 Result 别名。
pub type CloneResult<T> = Result<T, CloneError>;
