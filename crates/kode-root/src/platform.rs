//! ROOT-002/006/011 平台路径规则与根身份。
//!
//! - **Windows**(ROOT-002):路径大小写不敏感语义 → 身份比较折叠大小写;
//!   盘符大写已由 kode-vfs `CanonicalUri::from_path` 完成(`C:/x` ↔ `/C:/x`)。
//! - **macOS**:默认文件系统(APFS)大小写不敏感但保留大小写 → 身份比较
//!   折叠大小写;若卷为 case-sensitive(APFS Case-Sensitive),折叠会误合
//!   两个真实不同的路径——此为已知边界,按 PR-006 基础版口径:声明而非
//!   静默猜测,探测卷大小写格式属 IO 专项不在此做(VFS-001 同口径)。
//! - **Linux**:大小写敏感,逐字节比较。
//! - **WSL**:`\\wsl$\<distro>\...` / `\\wsl.localhost\<distro>\...` UNC 形态
//!   规范为 `/` 分隔保留;distro 段大小写敏感(WSL 侧真实区分);UNC 前缀
//!   在 Windows 宿主侧访问时大小写不敏感,统一按折叠比较并文档化。
//! - **ROOT-006 别名路径**:`dir//sub`、`dir/./sub`、`dir/../dir/sub`、
//!   尾随 `/` 经 CanonicalUri 词法消解后同身份;symlink 别名在跟随模式下
//!   由 [`crate::scan`] 的 canonical visited 集合并(不跟随则不合并,与
//!   TS/PR-004 口径一致)。
//! - **ROOT-011 UR+Path**:`RootPath::parse` 同时接受 `file:///...` URI 与
//!   原始路径,统一走 `kode_vfs::CanonicalUri`,非 file scheme 显式报错。

use kode_vfs::CanonicalUri;

/// 目标平台路径语义(ROOT-002)。测试可显式构造;`detect()` 只做编译期
/// 判定 + /proc/version 的 WSL 启发式(声明为 best-effort,不做强结论)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformTarget {
    Windows,
    Macos,
    Linux,
    /// Linux 下的 WSL 环境(路径语义同 Linux,UNC 形态多一档)。
    Wsl,
}

impl PlatformTarget {
    /// 编译期探测;WSL 运行期探测读 /proc/version 找 microsoft 标记。
    pub fn detect() -> PlatformTarget {
        if cfg!(target_os = "windows") {
            return PlatformTarget::Windows;
        }
        if cfg!(target_os = "macos") {
            return PlatformTarget::Macos;
        }
        if Self::proc_version_mentions_wsl() {
            return PlatformTarget::Wsl;
        }
        PlatformTarget::Linux
    }

    fn proc_version_mentions_wsl() -> bool {
        // best-effort:读不到就当非 WSL,不猜测(PH1-05 基础版口径)。
        std::fs::read_to_string("/proc/version")
            .map(|v| {
                let lower = v.to_ascii_lowercase();
                lower.contains("microsoft")
            })
            .unwrap_or(false)
    }
}

/// 平台身份比较是否折叠大小写(ROOT-002;macOS 边界见模块头声明)。
pub fn case_folds(platform: PlatformTarget) -> bool {
    matches!(platform, PlatformTarget::Windows | PlatformTarget::Macos)
}

/// 根路径解析错误(ROOT-011:非法输入显式报错,不静默降级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootPathError {
    /// 非法/非本地 URI(透传 kode-vfs 语义)。
    InvalidUri(String),
    /// 相对路径:根必须是绝对路径。
    NotAbsolute,
}

impl std::fmt::Display for RootPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RootPathError::InvalidUri(s) => write!(f, "invalid root path/URI: {s}"),
            RootPathError::NotAbsolute => write!(f, "root path must be absolute"),
        }
    }
}

impl std::error::Error for RootPathError {}

/// 根身份:canonical 形态 + 所属平台语义(ROOT-011)。
/// 比较走 [`RootPath::identity_eq`](平台折叠感知),原始拼写不参与身份。
/// WSL UNC(`//wsl$/<distro>/…`、`//wsl.localhost/<distro>/…`)在解析期
/// 拆出 distro 段后走 CanonicalUri;`as_path()` 还原 `//wsl.localhost/`
/// 前缀形态,保证前缀归属(ROOT-014)输入形态一致。
#[derive(Debug, Clone)]
pub struct RootPath {
    platform: PlatformTarget,
    uri: CanonicalUri,
    /// WSL UNC 的 distro 段(非 UNC 输入为 None)。
    wsl_distro: Option<String>,
}

impl RootPath {
    /// UR+Path 双支持(ROOT-011):`file:///w/a` 与 `/w/a` 同一身份。
    pub fn parse(input: &str, platform: PlatformTarget) -> Result<RootPath, RootPathError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(RootPathError::NotAbsolute);
        }
        if trimmed.starts_with("file:") {
            let uri = CanonicalUri::parse(trimmed)
                .map_err(|e| RootPathError::InvalidUri(e.to_string()))?;
            return Ok(RootPath {
                platform,
                uri,
                wsl_distro: None,
            });
        }
        if kode_vfs_canonical_rejects_scheme(trimmed) {
            return Err(RootPathError::InvalidUri(format!(
                "unsupported scheme in {trimmed}"
            )));
        }
        // WSL UNC 前缀拆段(ROOT-002):反斜杠形态先统一为 `/`。
        let slashed = trimmed.replace('\\', "/");
        let (distro, rest): (Option<String>, &str) =
            if let Some(rest) = slashed.strip_prefix("//wsl$/") {
                split_distro(rest)
            } else if let Some(rest) = slashed.strip_prefix("//wsl.localhost/") {
                split_distro(rest)
            } else {
                (None, slashed.as_str())
            };
        if let Some(d) = &distro {
            if d.is_empty() {
                return Err(RootPathError::NotAbsolute);
            }
        }
        let path_input = if distro.is_some() {
            format!("/{rest}")
        } else {
            rest.to_string()
        };
        let uri = CanonicalUri::from_path(&path_input);
        if !uri.as_path().starts_with('/') {
            return Err(RootPathError::NotAbsolute);
        }
        Ok(RootPath {
            platform,
            uri,
            wsl_distro: distro,
        })
    }

    pub fn platform(&self) -> PlatformTarget {
        self.platform
    }

    pub fn uri(&self) -> &CanonicalUri {
        &self.uri
    }

    /// 规范路径(供磁盘 IO 与前缀归属;WSL UNC 还原 `//wsl.localhost/` 形态)。
    pub fn as_path(&self) -> String {
        match &self.wsl_distro {
            Some(d) => format!("//wsl.localhost/{d}{}", self.uri.as_path()),
            None => self.uri.as_path().to_string(),
        }
    }

    /// 平台折叠感知的身份比较(ROOT-002/006):Windows/macOS 折叠大小写,
    /// Linux/WSL 逐字节(WSL distro 段一并精确比较)。
    pub fn identity_eq(&self, other: &RootPath) -> bool {
        if self.platform != other.platform {
            // 跨平台比较不定义身份,显式不等(不做跨语义猜测)。
            return false;
        }
        if self.wsl_distro != other.wsl_distro {
            return false;
        }
        if case_folds(self.platform) {
            self.uri.as_path().eq_ignore_ascii_case(other.uri.as_path())
        } else {
            self.uri.as_path() == other.uri.as_path()
        }
    }

    /// WSL UNC 形态识别(ROOT-002)。返回 distro 段(如有)。
    pub fn wsl_unc_distro(&self) -> Option<String> {
        self.wsl_distro.clone()
    }
}

/// 拆 WSL UNC 的 distro 段:`Ubuntu-22.04/home/u` → `(Ubuntu-22.04, home/u)`。
fn split_distro(rest: &str) -> (Option<String>, &str) {
    match rest.find('/') {
        Some(i) => (Some(rest[..i].to_string()), &rest[i + 1..]),
        None => (Some(rest.to_string()), ""),
    }
}

/// 判断输入是否带非 file 的 URI scheme(拒绝语义与 kode-vfs 对齐)。
/// 单字母 scheme(`c:/…`)视为 Windows 盘符而非协议。
fn kode_vfs_canonical_rejects_scheme(input: &str) -> bool {
    // `scheme:` 形态:字母开头,后接字母数字+-. 且后面还有内容。
    let bytes = input.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b':' {
            // 单字符"scheme" = 盘符(C:/…),不是协议。
            return i > 1 && i + 1 < bytes.len();
        }
        let ok = b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.';
        if !ok {
            return false;
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_folding_matches_platform_semantics() {
        assert!(case_folds(PlatformTarget::Windows));
        assert!(case_folds(PlatformTarget::Macos));
        assert!(!case_folds(PlatformTarget::Linux));
        assert!(!case_folds(PlatformTarget::Wsl));
    }

    #[test]
    fn detect_returns_current_host_variant() {
        // 本宿主不是 Windows/macOS:至少断言返回 Linux 或 Wsl 且可复现。
        let d = PlatformTarget::detect();
        assert!(matches!(d, PlatformTarget::Linux | PlatformTarget::Wsl));
    }

    #[test]
    fn parse_accepts_file_uri_and_plain_absolute_path_same_identity() {
        let from_uri = RootPath::parse("file:///w/demo", PlatformTarget::Linux).unwrap();
        let from_path = RootPath::parse("/w/demo", PlatformTarget::Linux).unwrap();
        assert!(from_uri.identity_eq(&from_path));
        assert_eq!(from_uri.as_path(), "/w/demo");
        assert_eq!(from_uri.platform(), PlatformTarget::Linux);
    }

    #[test]
    fn parse_rejects_relative_and_unsupported_schemes() {
        // 空/相对路径 → NotAbsolute(不猜 cwd)。
        assert!(matches!(
            RootPath::parse("", PlatformTarget::Linux),
            Err(RootPathError::NotAbsolute)
        ));
        assert!(matches!(
            RootPath::parse("plainpath", PlatformTarget::Linux),
            Err(RootPathError::NotAbsolute)
        ));
        assert!(matches!(
            RootPath::parse("rel/demo", PlatformTarget::Linux),
            Err(RootPathError::NotAbsolute)
        ));
        // 非 file scheme 显式报错,不静默降级。
        assert!(matches!(
            RootPath::parse("http://x/y", PlatformTarget::Linux),
            Err(RootPathError::InvalidUri(_))
        ));
        assert!(matches!(
            RootPath::parse("file:/w/a", PlatformTarget::Linux),
            Err(RootPathError::InvalidUri(_))
        ));
    }

    #[test]
    fn wsl_unc_is_split_and_round_trips_distro_prefix() {
        // WSL UNC 双形态 → distro 段拆出,as_path 还原 wsl.localhost 前缀。
        for input in [
            "//wsl$/Ubuntu-22.04/home/u",
            "//wsl.localhost/Ubuntu-22.04/home/u",
        ] {
            let root = RootPath::parse(input, PlatformTarget::Wsl).unwrap();
            assert_eq!(root.wsl_unc_distro().as_deref(), Some("Ubuntu-22.04"));
            assert_eq!(root.as_path(), "//wsl.localhost/Ubuntu-22.04/home/u");
            // 反斜杠形态同样归一。
            let back = RootPath::parse("\\\\wsl$\\Ubuntu\\home\\u", PlatformTarget::Wsl).unwrap();
            assert_eq!(back.wsl_unc_distro().as_deref(), Some("Ubuntu"));
        }
        // distro 段为空 → NotAbsolute。
        assert!(matches!(
            RootPath::parse("//wsl$/", PlatformTarget::Wsl),
            Err(RootPathError::NotAbsolute)
        ));
    }

    #[test]
    fn identity_eq_folds_only_on_case_insensitive_platforms() {
        let linux_a = RootPath::parse("/W/Demo", PlatformTarget::Linux).unwrap();
        let linux_b = RootPath::parse("/w/demo", PlatformTarget::Linux).unwrap();
        assert!(!linux_a.identity_eq(&linux_b), "Linux 大小写敏感");
        let win_a = RootPath::parse("/W/Demo", PlatformTarget::Windows).unwrap();
        let win_b = RootPath::parse("/w/demo", PlatformTarget::Windows).unwrap();
        assert!(win_a.identity_eq(&win_b), "Windows 折叠大小写");
        // 跨平台身份不定义 → 显式不等。
        assert!(!win_a.identity_eq(&linux_b));
        // WSL distro 段不同 → 不等。
        let d1 = RootPath::parse("//wsl$/Ubuntu/home/u", PlatformTarget::Wsl).unwrap();
        let d2 = RootPath::parse("//wsl$/Debian/home/u", PlatformTarget::Wsl).unwrap();
        assert!(!d1.identity_eq(&d2));
    }

    #[test]
    fn scheme_detector_accepts_plain_and_drive_forms() {
        // 全字母数字无冒号:非 scheme(217 行 false 分支)。
        assert!(!kode_vfs_canonical_rejects_scheme("abcdef"));
        // 单字符 = 盘符,非协议。
        assert!(!kode_vfs_canonical_rejects_scheme("c:/x"));
        // 多字符 scheme 带内容 → 拒绝。
        assert!(kode_vfs_canonical_rejects_scheme("http://x"));
        // 空/非字母开头 → 非 scheme。
        assert!(!kode_vfs_canonical_rejects_scheme(""));
        assert!(!kode_vfs_canonical_rejects_scheme("/w/x"));
    }
}
