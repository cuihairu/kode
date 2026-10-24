//! ROOT-012 发现诊断:结构化诊断码,只在冷跑(新启)产生;缓存命中不重发。

/// 诊断码(ROOT-012;基础版 7 码,新增码须过 tests/discovery.rs 断言面)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RootDiagnosticCode {
    /// RK001 多候选歧义:宁缺勿猜,交激活期一次性询问记忆(ROOT-001)。
    AmbiguousAnchor,
    /// RK002 有界深扫描触顶截断:命中集可能不全,零命中 ≠ 没有(ROOT-013)。
    ScanTruncated,
    /// RK003 submodule/vendored 边界内锚点降级:不作为根解析首选(ROOT-004)。
    ForeignAnchorDeprioritized,
    /// RK004 符号链接/挂载环:跟随模式下 canonical 身份已见,跳过(ROOT-005/007)。
    CycleSkipped,
    /// RK005 敏感目录剪枝:逐目录台账(ROOT-009)。
    SensitiveDirPruned,
    /// RK006 资产根探针未命中:目录在但 res/server/kbengine.xml 缺(ROOT-008)。
    ConfigProbeMiss,
    /// RK007 路径别名收敛:多个拼写同一根身份(ROOT-006)。
    AliasCollapsed,
}

impl RootDiagnosticCode {
    pub fn code(self) -> &'static str {
        match self {
            RootDiagnosticCode::AmbiguousAnchor => "RK001",
            RootDiagnosticCode::ScanTruncated => "RK002",
            RootDiagnosticCode::ForeignAnchorDeprioritized => "RK003",
            RootDiagnosticCode::CycleSkipped => "RK004",
            RootDiagnosticCode::SensitiveDirPruned => "RK005",
            RootDiagnosticCode::ConfigProbeMiss => "RK006",
            RootDiagnosticCode::AliasCollapsed => "RK007",
        }
    }
}

/// 一条发现诊断(ROOT-012)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootDiagnostic {
    pub code: RootDiagnosticCode,
    /// 关联路径或锚点标签(诊断定位)。
    pub subject: String,
    pub message: String,
}

impl RootDiagnostic {
    pub fn new(
        code: RootDiagnosticCode,
        subject: impl Into<String>,
        message: impl Into<String>,
    ) -> RootDiagnostic {
        RootDiagnostic {
            code,
            subject: subject.into(),
            message: message.into(),
        }
    }
}
