//! ROOT-012 诊断码契约 + ROOT-002/011 平台路径语义边界。

use kode_root::diag::{RootDiagnostic, RootDiagnosticCode};
use kode_root::platform::{case_folds, PlatformTarget, RootPath, RootPathError};

#[test]
fn diagnostic_codes_are_stable_rk001_to_rk007() {
    // 顺序即文档口径;任何改动都须同步 tests/discovery.rs 与 TS 侧。
    let codes = [
        (RootDiagnosticCode::AmbiguousAnchor, "RK001"),
        (RootDiagnosticCode::ScanTruncated, "RK002"),
        (RootDiagnosticCode::ForeignAnchorDeprioritized, "RK003"),
        (RootDiagnosticCode::CycleSkipped, "RK004"),
        (RootDiagnosticCode::SensitiveDirPruned, "RK005"),
        (RootDiagnosticCode::ConfigProbeMiss, "RK006"),
        (RootDiagnosticCode::AliasCollapsed, "RK007"),
    ];
    for (code, text) in codes {
        assert_eq!(code.code(), text, "{code:?}");
    }
}

#[test]
fn diagnostic_carries_subject_and_message() {
    let d = RootDiagnostic::new(
        RootDiagnosticCode::ScanTruncated,
        "/w/assets",
        "depth cap hit",
    );
    assert_eq!(d.code, RootDiagnosticCode::ScanTruncated);
    assert_eq!(d.subject, "/w/assets");
    assert_eq!(d.message, "depth cap hit");
}

#[test]
fn case_folding_matches_platform_semantics() {
    assert!(case_folds(PlatformTarget::Windows));
    assert!(case_folds(PlatformTarget::Macos));
    assert!(!case_folds(PlatformTarget::Linux));
    assert!(!case_folds(PlatformTarget::Wsl));
}

#[test]
fn detect_returns_a_declared_target() {
    // 只声明返回值落在四类之内;具体值随宿主环境,不做强结论。
    let detected = PlatformTarget::detect();
    assert!(matches!(
        detected,
        PlatformTarget::Windows
            | PlatformTarget::Macos
            | PlatformTarget::Linux
            | PlatformTarget::Wsl
    ));
    // detect 幂等。
    assert_eq!(PlatformTarget::detect(), detected);
}

#[test]
fn raw_path_and_file_uri_are_same_identity() {
    let raw = RootPath::parse("/w/assets", PlatformTarget::Linux).unwrap();
    let uri = RootPath::parse("file:///w/assets", PlatformTarget::Linux).unwrap();
    assert_eq!(raw.platform(), PlatformTarget::Linux);
    assert_eq!(raw.uri().as_path(), "/w/assets");
    assert_eq!(raw.as_path(), "/w/assets");
    assert!(raw.identity_eq(&uri));
    assert!(uri.identity_eq(&raw));
    // file:// 与原始路径的平台也一致才等价(跨平台不定义身份)。
    assert!(
        !raw.identity_eq(&RootPath::parse("file:///w/assets", PlatformTarget::Windows).unwrap())
    );
}

#[test]
fn invalid_inputs_are_rejected_loudly() {
    // 空/相对路径。
    assert!(matches!(
        RootPath::parse("", PlatformTarget::Linux),
        Err(RootPathError::NotAbsolute)
    ));
    assert!(matches!(
        RootPath::parse("  ", PlatformTarget::Linux),
        Err(RootPathError::NotAbsolute)
    ));
    assert!(matches!(
        RootPath::parse("w/assets", PlatformTarget::Linux),
        Err(RootPathError::NotAbsolute)
    ));
    // 非 file 的 URI scheme 显式报错(ROOT-011)。
    assert!(matches!(
        RootPath::parse("http://x/y", PlatformTarget::Linux),
        Err(RootPathError::InvalidUri(_))
    ));
    assert!(matches!(
        RootPath::parse("smb://host/share", PlatformTarget::Linux),
        Err(RootPathError::InvalidUri(_))
    ));
    // 盘符形态不是协议(C:/…),按路径语义处理。
    let drive = RootPath::parse("c:/w/assets", PlatformTarget::Windows).unwrap();
    assert!(drive.as_path().starts_with('/'), "{}", drive.as_path());
    // Display:两类错误文案可读。
    assert_eq!(
        RootPathError::InvalidUri("x".to_string()).to_string(),
        "invalid root path/URI: x"
    );
    assert_eq!(
        RootPathError::NotAbsolute.to_string(),
        "root path must be absolute"
    );
}

#[test]
fn windows_drive_paths_fold_case_in_identity() {
    let lower = RootPath::parse("c:/W/Assets", PlatformTarget::Windows).unwrap();
    let upper = RootPath::parse("C:/w/assets", PlatformTarget::Windows).unwrap();
    assert!(lower.identity_eq(&upper));
    // Linux 逐字节,不折叠。
    let lin_lower = RootPath::parse("/w/Assets", PlatformTarget::Linux).unwrap();
    let lin_upper = RootPath::parse("/W/assets", PlatformTarget::Linux).unwrap();
    assert!(!lin_lower.identity_eq(&lin_upper));
}

#[test]
fn wsl_unc_forms_collapse_to_one_identity() {
    let slashes =
        RootPath::parse("//wsl$/Ubuntu-22.04/home/u/assets", PlatformTarget::Wsl).unwrap();
    let backslash = RootPath::parse(
        "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\assets",
        PlatformTarget::Wsl,
    )
    .unwrap();
    assert_eq!(slashes.wsl_unc_distro().as_deref(), Some("Ubuntu-22.04"));
    assert_eq!(backslash.wsl_unc_distro().as_deref(), Some("Ubuntu-22.04"));
    // as_path 还原 wsl.localhost 前缀形态(ROOT-014 前缀归属)。
    assert_eq!(
        slashes.as_path(),
        "//wsl.localhost/Ubuntu-22.04/home/u/assets"
    );
    assert_eq!(
        backslash.as_path(),
        "//wsl.localhost/Ubuntu-22.04/home/u/assets"
    );
    assert!(slashes.identity_eq(&backslash));
    // distro 段不同 = 不同身份。
    let other = RootPath::parse("//wsl$/Debian/home/u/assets", PlatformTarget::Wsl).unwrap();
    assert!(!slashes.identity_eq(&other));
    // 只有 distro 段、无路径:仍可解析。
    let bare = RootPath::parse("//wsl$/Ubuntu", PlatformTarget::Wsl).unwrap();
    assert_eq!(bare.wsl_unc_distro().as_deref(), Some("Ubuntu"));
    assert_eq!(bare.as_path(), "//wsl.localhost/Ubuntu/");
    // 空 distro 段 → 拒绝(不猜测归属)。
    assert!(matches!(
        RootPath::parse("//wsl$//x", PlatformTarget::Wsl),
        Err(RootPathError::NotAbsolute)
    ));
}
