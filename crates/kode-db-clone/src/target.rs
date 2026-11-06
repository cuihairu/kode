//! 导入目标门槛(plan §6.1 / PDC-0301):目标必须显式声明 local/test 环境,
//! 禁止 prod/staging;仅凭 `127.0.0.1` 判定安全不可靠——环境是唯一权威声明,
//! 主机地址永不赋予任何安全含义。
//!
//! 同守 §6.1 其余门槛的静态面:数据库接口仅 mysql(引擎实体持久化唯一通道,
//! redis 后端不持久化实体,source-evidence §1);写意图必须显式开启。
//! 引擎实例运行态检测(本地服务已停止/DBMgr 状态)属 Apply 期(Phase 4),
//! 计划期只做可静态判定的拒绝。

use std::fmt;
use std::str::FromStr;

use crate::error::{CloneError, CloneResult};

/// 目标环境声明(§6.1:必须显式;prod/staging 一律拒绝导入)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetEnvironment {
    Local,
    Test,
}

impl FromStr for TargetEnvironment {
    type Err = CloneError;

    /// 仅接受 `local`/`test`(大小写不敏感);`prod`/`staging` 与一切未知值
    /// fail-closed 拒绝——不接受拼写变体猜测。
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

/// 导入目标连接描述(§6.1 Connections 的计划期形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetProfile {
    /// 显式环境声明(唯一安全权威;host 永不参与判定)。
    pub environment: TargetEnvironment,
    /// 数据库接口(仅 `mysql`;引擎实体持久化不走 redis)。
    pub db_interface: String,
    /// 写意图:导入目标必须显式声明可写,默认只读姿态不可导入。
    pub writable: bool,
    pub host: String,
    pub port: u16,
    pub database: String,
    /// 目标引擎/服务器版本(PDC-0302 版本对比面;未知为 None,计划如实记 drift)。
    pub engine_version: Option<String>,
}

impl TargetProfile {
    /// 导入前静态校验(§6.1):环境已显式(local/test)、接口 mysql、可写意图开。
    /// 通过不代表目标可写的事实核验(连接/权限属执行期),只代表声明面合法。
    pub fn validate_for_import(&self) -> CloneResult<()> {
        if self.db_interface.trim().eq_ignore_ascii_case("mysql") {
            // mysql:引擎实体持久化的唯一接口。
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
        // prod/staging/未知值:一律 fail-closed,不做近义猜测。
        for bad in ["prod", "staging", "production", "dev", ""] {
            assert!(
                bad.parse::<TargetEnvironment>().is_err(),
                "`{bad}` must be rejected"
            );
        }
    }

    #[test]
    fn loopback_host_grants_nothing_by_itself() {
        // §6.1:127.0.0.1 不构成安全判定——环境枚举里没有「按 host 推断」的路径,
        // prod 字符串在 FromStr 就被拒,与 host 无关。
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
}
