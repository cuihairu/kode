//! ROOT-012 discovery diagnostics: structured diagnostic codes, produced only on cold
//! runs (fresh startup); not re-emitted on cache hits.

/// Diagnostic codes (ROOT-012; 7 codes in the basic edition; new codes must clear the
/// assertion surface in tests/discovery.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RootDiagnosticCode {
    /// RK001 ambiguity among multiple candidates: prefer no guess over a wrong guess,
    /// hand off to a one-shot memorized prompt at activation (ROOT-001).
    AmbiguousAnchor,
    /// RK002 bounded deep scan hit its cap and was truncated: the hit set may be
    /// incomplete, zero hits ≠ absent (ROOT-013).
    ScanTruncated,
    /// RK003 anchor inside a submodule/vendored boundary is downgraded: not a first
    /// candidate for root resolution (ROOT-004).
    ForeignAnchorDeprioritized,
    /// RK004 symlink/mount cycle: in follow mode the canonical identity was already
    /// visited, skip it (ROOT-005/007).
    CycleSkipped,
    /// RK005 sensitive directory pruning: tracked per-directory ledger (ROOT-009).
    SensitiveDirPruned,
    /// RK006 asset-root probe missed: the directory exists but
    /// res/server/kbengine.xml is absent (ROOT-008).
    ConfigProbeMiss,
    /// RK007 path alias collapse: several spellings resolve to one root identity
    /// (ROOT-006).
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

/// One discovery diagnostic (ROOT-012).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootDiagnostic {
    pub code: RootDiagnosticCode,
    /// Related path or anchor label (diagnostic locator).
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
