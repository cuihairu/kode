//! BAS-06 事实与诊断证据。
//!
//! 语义结果不以「类型名」或「置信数字」交付,而按 [`Origin`] 分类:
//! - [`Origin::Declared`] 声明确定(引擎 def/types/config schema);
//! - [`Origin::Derived`]  代码推导(附推导链,逐步保留来源);
//! - [`Origin::Unknown`]  未知(附原因,**不自动转成错误**——判定是否报错
//!   由消费方按 [`Severity`] 策略决定);
//! - [`Origin::Conflict`] 冲突(保留全部候选,绝不任取一个)。
//!
//! 每条事实配 [`Evidence`](来源路径:文件 + 行/列 + 符号路径),便于
//! hover/诊断呈现可执行跳转。

/// 来源路径(文件 + 位置;`line/col` 0 基,`None` = 未携带)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Evidence {
    /// 资源根内的相对路径(或工作区外绝对路径,原样)。
    pub file: String,
    pub line: Option<usize>,
    pub col: Option<usize>,
    /// 符号路径(`Avatar/BaseMethods/teleport/Arg[0]` 等;可空)。
    pub symbol: Option<String>,
}

impl Evidence {
    pub fn new(file: impl Into<String>, line: Option<usize>, col: Option<usize>) -> Self {
        Self { file: file.into(), line, col, symbol: None }
    }

    pub fn with_symbol(mut self, symbol: impl Into<String>) -> Self {
        self.symbol = Some(symbol.into());
        self
    }

    /// 人类可读位置(呈现用;非身份键)。
    pub fn display(&self) -> String {
        let mut s = self.file.clone();
        if let Some(l) = self.line {
            s.push_str(&format!(":{}", l + 1));
            if let Some(c) = self.col {
                s.push_str(&format!(":{}", c + 1));
            }
        }
        if let Some(sym) = &self.symbol {
            s.push_str(&format!(" [{}]", sym));
        }
        s
    }
}

/// 来源类别。
#[derive(Debug, Clone, PartialEq)]
pub enum Origin {
    /// 声明确定(引擎 def/types/config schema)。
    Declared,
    /// 代码推导:推导链逐步保留(`self.r = Repo()` → `r` → `Repo.load` → `DATA`)。
    Derived { chain: Vec<String> },
    /// 未知(原因;空原因也允许 = 单纯无信息)。
    Unknown { reason: String },
    /// 冲突(候选值 + 原因;不任取一个)。
    Conflict { candidates: Vec<String>, reason: String },
}

impl Origin {
    pub fn declared() -> Self {
        Origin::Declared
    }

    pub fn derived(chain: Vec<String>) -> Self {
        Origin::Derived { chain }
    }

    pub fn unknown(reason: impl Into<String>) -> Self {
        Origin::Unknown { reason: reason.into() }
    }

    pub fn conflict(candidates: Vec<String>, reason: impl Into<String>) -> Self {
        Origin::Conflict { candidates, reason: reason.into() }
    }

    pub fn is_unknown(&self) -> bool {
        matches!(self, Origin::Unknown { .. })
    }

    pub fn is_conflict(&self) -> bool {
        matches!(self, Origin::Conflict { .. })
    }

    /// 是否允许升级为「确定错误」——推导/声明两类可以,未知/冲突不行。
    pub fn may_be_error(&self) -> bool {
        matches!(self, Origin::Declared | Origin::Derived { .. })
    }
}

/// 诊断严重级(与 kode-parser `Severity` 同词,**不**复用同一类型以保持
/// 语义层不依赖解析层枚举)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// 一条语义事实。
///
/// `value` 为人类可读表示(类型显示/键名/候选列表),**语义结构**由各模
/// 块自己的类型交付(如 [`crate::semantics::SemType`]);本结构负责证据面。
#[derive(Debug, Clone, PartialEq)]
pub struct Fact {
    pub value: String,
    pub origin: Origin,
    pub evidence: Vec<Evidence>,
}

impl Fact {
    pub fn new(value: impl Into<String>, origin: Origin) -> Self {
        Self { value: value.into(), origin, evidence: Vec::new() }
    }

    pub fn with_evidence(mut self, ev: Evidence) -> Self {
        self.evidence.push(ev);
        self
    }

    pub fn with_evidences(mut self, evs: impl IntoIterator<Item = Evidence>) -> Self {
        self.evidence.extend(evs);
        self
    }

    /// 该事实的严重级策略:声明/推导可升级,未知/冲突恒降级(设计 §4:
    /// 「未知不能自动转成错误,冲突保留候选」)。
    pub fn severity(&self) -> Severity {
        if self.origin.may_be_error() {
            Severity::Error
        } else {
            Severity::Warning
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_never_escalates_to_error() {
        let f = Fact::new("?", Origin::unknown("no def"));
        assert_eq!(f.severity(), Severity::Warning, "未知不能自动转成错误(BAS-06)");
        assert!(!f.origin.may_be_error());
    }

    #[test]
    fn conflict_keeps_candidates_and_does_not_pick() {
        let origin = Origin::conflict(vec!["A".into(), "B".into()], "two writers");
        let f = Fact::new("A|B", origin.clone());
        assert_eq!(f.severity(), Severity::Warning);
        match origin {
            Origin::Conflict { candidates, .. } => assert_eq!(candidates.len(), 2),
            _ => panic!("必须是 Conflict"),
        }
    }

    #[test]
    fn derived_keeps_chain() {
        let f = Fact::new("DATA", Origin::derived(vec!["r".into(), "Repo.load".into()]));
        assert_eq!(f.severity(), Severity::Error);
        match f.origin {
            Origin::Derived { chain } => assert_eq!(chain, ["r", "Repo.load"]),
            _ => panic!("必须是 Derived"),
        }
    }

    #[test]
    fn evidence_display_is_one_based() {
        let ev = Evidence::new("defs/avatar.def", Some(0), Some(2)).with_symbol("Avatar/Properties/hp");
        assert_eq!(ev.display(), "defs/avatar.def:1:3 [Avatar/Properties/hp]");
    }

    #[test]
    fn declared_is_error_capable() {
        let f = Fact::new("INT32", Origin::declared());
        assert_eq!(f.severity(), Severity::Error);
    }
}
