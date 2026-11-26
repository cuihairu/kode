//! Import target gate (plan §6.1 / PDC-0301): the target must explicitly declare a
//! local/test environment, prod/staging are forbidden; judging safety by
//! `127.0.0.1` alone is unreliable — the environment is the only authoritative
//! declaration, a host address never grants any safety meaning.
//!
//! Also guards the static face of the remaining §6.1 gates: the database interface
//! is mysql only (the only channel for engine entity persistence; the redis backend
//! does not persist entities, source-evidence §1); write intent must be explicitly
//! enabled. Engine instance runtime detection (local service stopped / DBMgr
//! state) belongs to the Apply phase (Phase 4); the planning phase only performs
//! statically decidable rejections.

use std::fmt;
use std::str::FromStr;

use crate::error::{CloneError, CloneResult};

/// Target environment declaration (§6.1: must be explicit; prod/staging always
/// rejected for import).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetEnvironment {
    Local,
    Test,
}

impl FromStr for TargetEnvironment {
    type Err = CloneError;

    /// Accepts only `local`/`test` (case-insensitive); `prod`/`staging` and every
    /// unknown value fail closed — no spelling-variant guessing.
    fn from_str(s: &str) -> CloneResult<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "local" => Ok(TargetEnvironment::Local),
            "test" => Ok(TargetEnvironment::Test),
            other => Err(CloneError::ImportRejected(format!(
                "target environment `{other}` is not allowed for import; only local/test may be declared"
            ))),
        }
    }
}

impl fmt::Display for TargetEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TargetEnvironment::Local => write!(f, "local"),
            TargetEnvironment::Test => write!(f, "test"),
        }
    }
}

/// Import target connection description (§6.1 Connections, planning-phase form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetProfile {
    /// Explicit environment declaration (the only safety authority; host never
    /// participates in the decision).
    pub environment: TargetEnvironment,
    /// Database interface (`mysql` only; engine entity persistence never goes
    /// through redis).
    pub db_interface: String,
    /// Write intent: an import target must explicitly declare itself writable; a
    /// default read-only posture cannot be imported into.
    pub writable: bool,
    pub host: String,
    pub port: u16,
    pub database: String,
    /// Target engine/server version (the PDC-0302 version comparison face; None
    /// when unknown, the plan honestly records drift).
    pub engine_version: Option<String>,
}

impl TargetProfile {
    /// Static pre-import validation (§6.1): environment explicit (local/test),
    /// interface mysql, write intent enabled. Passing does not verify the fact
    /// that the target is writable (connection/permissions belong to execution);
    /// it only says the declaration face is legal.
    pub fn validate_for_import(&self) -> CloneResult<()> {
        if self.db_interface.trim().eq_ignore_ascii_case("mysql") {
            // mysql: the only interface for engine entity persistence.
        } else {
            return Err(CloneError::UnsupportedDbInterface(
                self.db_interface.clone(),
            ));
        }
        if !self.writable {
            return Err(CloneError::ImportRejected(
                "import target is not declared writable; refusing to plan writes against a read-only profile"
                    .into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_profile() -> TargetProfile {
        TargetProfile {
            environment: TargetEnvironment::Local,
            db_interface: "mysql".into(),
            writable: true,
            host: "127.0.0.1".into(),
            port: 3306,
            database: "kbe_test".into(),
            engine_version: Some("8.0.36".into()),
        }
    }

    #[test]
    fn parses_local_and_test_only() {
        assert_eq!(
            "local".parse::<TargetEnvironment>().unwrap(),
            TargetEnvironment::Local
        );
        assert_eq!(
            "Test".parse::<TargetEnvironment>().unwrap(),
            TargetEnvironment::Test
        );
        // prod/staging/unknown values: always fail closed, no synonym guessing.
        for bad in ["prod", "staging", "production", "dev", ""] {
            assert!(
                bad.parse::<TargetEnvironment>().is_err(),
                "`{bad}` must be rejected"
            );
        }
    }

    #[test]
    fn loopback_host_grants_nothing_by_itself() {
        // §6.1: 127.0.0.1 constitutes no safety decision — the environment enum
        // has no "infer from host" path; the prod string is rejected at FromStr,
        // independent of host.
        let err = "prod".parse::<TargetEnvironment>().unwrap_err();
        assert!(matches!(err, CloneError::ImportRejected(_)));
    }

    #[test]
    fn validates_interface_and_write_intent() {
        local_profile().validate_for_import().unwrap();

        let mut redis = local_profile();
        redis.db_interface = "redis".into();
        assert!(matches!(
            redis.validate_for_import().unwrap_err(),
            CloneError::UnsupportedDbInterface(_)
        ));

        let mut readonly = local_profile();
        readonly.writable = false;
        assert!(matches!(
            readonly.validate_for_import().unwrap_err(),
            CloneError::ImportRejected(_)
        ));
    }

    #[test]
    fn display_renders_local_and_test() {
        // Display is the import-report/validation message face: the environment
        // enum renders honestly, no internal details leak.
        assert_eq!(TargetEnvironment::Local.to_string(), "local");
        assert_eq!(TargetEnvironment::Test.to_string(), "test");
    }
}
