//! PR-006 根发现测试面:ROOT-001..015 逐条断言。
//! fixture 树 = crates/kode-root/tests/fixtures(逐平台典型树,ROOT-003);
//! 对拍 golden = tests/golden/root-parity.json(ROOT-010,双向门禁 Rust 侧)。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use kode_root::scan::{scan_workspace_anchors, BoundaryKind, ScanOptions};
use kode_root::{
    case_folds, conventional_config_roots, has_engine_config_probe, resolve_engine_messages_xml,
    AnchorKey, DiscoveryEngine, ExplicitConfig, FieldStatus, PlatformRootRegistry, PlatformTarget,
    ResolutionSource, RootDiagnosticCode, RootPath, CONVENTIONS, DEFAULT_SCAN_DEPTH,
    DEFAULT_SCAN_MAX_VISITED, SKIP_DIRECTORY_NAMES,
};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn fixtures_dir() -> PathBuf {
    repo_root().join("crates/kode-root/tests/fixtures")
}

static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

fn temp_tree(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kode-root-test-{}-{}-{}",
        tag,
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir temp tree");
    dir
}

fn scan(tree: &str) -> kode_root::ScanResult {
    scan_workspace_anchors(&fixtures_dir().join(tree), &ScanOptions::default())
}

/// fixture 树的排序去重视图,路径已相对化(便于断言可读)。
#[derive(Debug)]
#[allow(dead_code)] // scan_visited 保留作对拍口径展示
struct RelSorted {
    entity_defs: Vec<String>,
    entities_xml: Vec<String>,
    types_xml: Vec<String>,
    kbe_source_roots: Vec<String>,
    messages_xml: Vec<String>,
    config_roots: Vec<String>,
    scan_visited: usize,
    scan_truncated: bool,
}

fn rel_sorted(tree: &str) -> RelSorted {
    let root = fixtures_dir().join(tree);
    let v = scan_workspace_anchors(&root, &ScanOptions::default()).sorted_view();
    let rel_list = |ps: &[PathBuf]| -> Vec<String> {
        ps.iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    };
    RelSorted {
        entity_defs: rel_list(&v.entity_defs),
        entities_xml: rel_list(&v.entities_xml),
        types_xml: rel_list(&v.types_xml),
        kbe_source_roots: rel_list(&v.kbe_source_roots),
        messages_xml: rel_list(&v.messages_xml),
        config_roots: rel_list(&v.config_roots),
        scan_visited: v.scan_visited,
        scan_truncated: v.scan_truncated,
    }
}

fn field(report: &kode_root::DiscoveryReport, key: AnchorKey) -> &kode_root::FieldReport {
    report
        .fields
        .iter()
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("field {:?} missing", key))
}

// ---- ROOT-008: TS 移植证据锁(常量逐字对齐 src/workspaceDiscovery.ts:16-47) ----

#[test]
fn root008_conventions_match_ts_evidence() {
    assert_eq!(
        CONVENTIONS.entity_defs,
        &[
            "entity_defs",
            "scripts/entity_defs",
            "assets/scripts/entity_defs",
            "server_assets/scripts/entity_defs"
        ]
    );
    assert_eq!(
        CONVENTIONS.entities_xml,
        &[
            "entities.xml",
            "scripts/entities.xml",
            "assets/scripts/entities.xml",
            "server_assets/scripts/entities.xml"
        ]
    );
    assert_eq!(
        CONVENTIONS.types_xml,
        &[
            "types.xml",
            "entity_defs/types.xml",
            "scripts/entity_defs/types.xml",
            "assets/scripts/entity_defs/types.xml",
            "server_assets/scripts/entity_defs/types.xml",
            "scripts/types.xml",
            "assets/scripts/types.xml"
        ]
    );
    assert_eq!(
        CONVENTIONS.kbe_source_anchors,
        &[
            "kbe/src/lib/entitydef/entitydef.cpp",
            "kbe/src/lib/db_mysql/entity_table_mysql.cpp",
            "kbe/src/common/entitydef/entitydef.cpp"
        ]
    );
    assert_eq!(CONVENTIONS.config_roots, &["", "assets", "server_assets"]);
    // 有界扫描上限与 TS 同源(src/workspaceDiscovery.ts:103-104)
    assert_eq!(DEFAULT_SCAN_DEPTH, 7);
    assert_eq!(DEFAULT_SCAN_MAX_VISITED, 20_000);
    // 敏感目录名单与 TS SKIP_DIRECTORY_NAMES 同源(:100)
    assert_eq!(
        SKIP_DIRECTORY_NAMES,
        &["node_modules", ".git", ".vscode", "out", "dist"]
    );
}

#[test]
fn root008_config_probe_predicate() {
    // 探针口径:<根>/res/server/kbengine.xml 存在(TS hasEngineConfigProbe :58-66)
    assert!(has_engine_config_probe(
        &fixtures_dir().join("linux_assets/assets")
    ));
    assert!(!has_engine_config_probe(
        &fixtures_dir().join("linux_assets/server_assets")
    ));
    // 约定候选链:静态名单 + 一级 *_assets 动态段,顺序 = 优先顺序
    let roots = conventional_config_roots(&fixtures_dir().join("linux_assets"));
    assert_eq!(
        roots,
        vec![
            fixtures_dir().join("linux_assets"),
            fixtures_dir().join("linux_assets/assets"),
            fixtures_dir().join("linux_assets/server_assets"),
        ]
    );
}

// ---- ROOT-003: 逐平台典型树夹具即验收 ----

#[test]
fn root003_linux_assets_tree() {
    let s = rel_sorted("linux_assets");
    assert_eq!(s.entity_defs, vec!["assets/scripts/entity_defs"]);
    assert_eq!(s.entities_xml, vec!["assets/scripts/entities.xml"]);
    assert_eq!(s.types_xml, vec!["assets/scripts/entity_defs/types.xml"]);
    assert_eq!(s.config_roots, vec!["assets"]);
    assert!(s.kbe_source_roots.is_empty() && s.messages_xml.is_empty());
    assert!(!s.scan_truncated);
}

#[test]
fn root003_engine_repo_tree() {
    let s = rel_sorted("engine_repo");
    // 引擎源码根 = 向上找 kbe 祖先(:209-221)
    assert_eq!(s.kbe_source_roots, vec!["kbe"]);
    // 消息表双名(:111)
    assert_eq!(
        s.messages_xml,
        vec![
            "kbe/res/server/messages_fixed_defaults.xml",
            "res/server/messages_fixed.xml",
        ]
    );
    // 工作区根本身是资产根('' 约定,探针 <root>/res/server/kbengine.xml)
    assert_eq!(s.config_roots, vec![""]);
    assert_eq!(s.entity_defs, vec!["scripts/entity_defs"]);
}

#[test]
fn root003_multi_ambiguous_tree() {
    let s = rel_sorted("multi_ambiguous");
    assert_eq!(s.entity_defs.len(), 2);
    assert_eq!(s.entities_xml.len(), 2);
    assert_eq!(s.types_xml.len(), 2);
}

// ---- ROOT-004: submodule / vendored 判定(每仓/每文件级可测) ----

#[test]
fn root004_submodule_and_vendored_boundaries() {
    let s = scan("submodule_vendor");
    let sub = s
        .boundaries
        .iter()
        .find(|b| b.kind == BoundaryKind::Submodule)
        .expect("submodule boundary");
    assert!(sub.path.ends_with("sub"));
    let vendored = s
        .boundaries
        .iter()
        .filter(|b| b.kind == BoundaryKind::Vendored)
        .collect::<Vec<_>>();
    assert!(vendored.iter().any(|b| b.path.ends_with("vendor")));
    // 每文件级:外仓锚点非边界,sub/vendored 锚点是边界
    let root = fixtures_dir().join("submodule_vendor");
    assert!(!s.anchor_is_foreign(&root, &root.join("entity_defs")));
    assert!(s.anchor_is_foreign(&root, &root.join("sub/entity_defs")));
    assert!(s.anchor_is_foreign(&root, &root.join("vendor/engine_clone/entity_defs")));
}

#[test]
fn root004_foreign_anchors_demoted_in_resolution() {
    // 存在外仓候选时,边界内候选(sub/vendor)不得误导根解析
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let report = engine.discover(
        &fixtures_dir().join("submodule_vendor"),
        &ExplicitConfig::default(),
    );
    let defs = field(&report, AnchorKey::EntityDefs);
    assert_eq!(defs.status, FieldStatus::Ok);
    assert_eq!(
        defs.resolved,
        Some(fixtures_dir().join("submodule_vendor/entity_defs"))
    );
    assert!(!defs.foreign);
    // 引擎源码根命中 vendored(唯一候选):保留但打 foreign 旗标 + RK003
    let kbe = field(&report, AnchorKey::KbeSourceRoot);
    assert!(kbe.foreign);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == RootDiagnosticCode::ForeignAnchorDeprioritized));
}

// ---- ROOT-005/007: 挂载环 / 符号链接环(默认免疫 + 跟随模式护栏) ----

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("symlink");
}

#[cfg(unix)]
#[test]
fn root007_default_mode_never_follows_dir_symlinks() {
    let t = temp_tree("sym-default");
    std::fs::create_dir_all(t.join("entity_defs")).unwrap();
    std::fs::write(t.join("entity_defs/A.def"), "<root/>").unwrap();
    // 链接 entity_defs → 上一层(别名 + 环形态)
    symlink(Path::new(".."), &t.join("alias"));
    symlink(&t.join("entity_defs"), &t.join("entity_defs_link"));
    let s = scan_workspace_anchors(&t, &ScanOptions::default());
    assert_eq!(s.entity_defs, vec![t.join("entity_defs")]);
    assert!(s.cycles_skipped.is_empty());
    std::fs::remove_dir_all(&t).unwrap();
}

#[cfg(unix)]
#[test]
fn root005_root007_follow_mode_terminates_on_cycles() {
    let t = temp_tree("sym-follow");
    std::fs::create_dir_all(t.join("a/b")).unwrap();
    std::fs::write(t.join("a/b/x.xml"), "<x/>").unwrap();
    // 符号链接环:loop 指回祖先
    symlink(Path::new(".."), &t.join("a/b/loop"));
    // 绑定挂载环形态:两个名字指向同一目标(canonical 身份相同)
    symlink(&t.join("a"), &t.join("alias1"));
    symlink(&t.join("a"), &t.join("alias2"));
    let opts = ScanOptions {
        follow_dir_symlinks: true,
        ..ScanOptions::default()
    };
    let s = scan_workspace_anchors(&t, &opts); // 必须终止,不挂死
    assert!(!s.cycles_skipped.is_empty(), "环必须被识别并跳过");
    assert!(s
        .diagnostics
        .iter()
        .any(|d| d.code == RootDiagnosticCode::CycleSkipped));
    std::fs::remove_dir_all(&t).unwrap();
}

// ---- ROOT-006: 别名路径判定 ----

#[test]
fn root006_path_alias_same_identity() {
    let linux = PlatformTarget::Linux;
    let base = RootPath::parse("/w/proj", linux).unwrap();
    for alias in [
        "/w/proj/",
        "//w/proj",
        "/w/./proj",
        "/w/other/../proj",
        "/w/proj/.",
    ] {
        let p = RootPath::parse(alias, linux).unwrap();
        assert!(base.identity_eq(&p), "alias {alias} 应与 /w/proj 同身份");
    }
    // 不同路径不同身份;跨平台比较不定义身份
    assert!(!base.identity_eq(&RootPath::parse("/w/proj2", linux).unwrap()));
    assert!(!base.identity_eq(&RootPath::parse("/w/proj", PlatformTarget::Windows).unwrap()));
}

// ---- ROOT-002: 平台规则 ----

#[test]
fn root002_platform_case_folding_matrix() {
    assert!(case_folds(PlatformTarget::Windows));
    assert!(case_folds(PlatformTarget::Macos));
    assert!(!case_folds(PlatformTarget::Linux));
    assert!(!case_folds(PlatformTarget::Wsl));
    let win = RootPath::parse("/W/Proj/entity_defs", PlatformTarget::Windows).unwrap();
    let win2 = RootPath::parse("/w/proj/ENTITY_DEFS", PlatformTarget::Windows).unwrap();
    assert!(win.identity_eq(&win2), "Windows 身份折叠大小写");
    let linux_a = RootPath::parse("/w/Proj", PlatformTarget::Linux).unwrap();
    let linux_b = RootPath::parse("/w/proj", PlatformTarget::Linux).unwrap();
    assert!(!linux_a.identity_eq(&linux_b), "Linux 逐字节敏感");
    // 盘符大写归一(CanonicalUri 语义)
    let drive1 = RootPath::parse("c:/kb", PlatformTarget::Windows).unwrap();
    let drive2 = RootPath::parse("C:/kb", PlatformTarget::Windows).unwrap();
    assert!(drive1.identity_eq(&drive2));
}

#[test]
fn root002_wsl_unc_semantics() {
    for unc in [
        "//wsl$/Ubuntu-22.04/home/u/proj",
        "//wsl.localhost/Ubuntu-22.04/home/u/proj",
        "\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\proj",
    ] {
        let p = RootPath::parse(unc, PlatformTarget::Windows).unwrap();
        assert_eq!(p.wsl_unc_distro().as_deref(), Some("Ubuntu-22.04"), "{unc}");
    }
    let plain = RootPath::parse("/home/u/proj", PlatformTarget::Wsl).unwrap();
    assert_eq!(plain.wsl_unc_distro(), None);
}

// ---- ROOT-011: UR + Path 双支持 ----

#[test]
fn root011_uri_and_path_dual_input() {
    let linux = PlatformTarget::Linux;
    let by_uri = RootPath::parse("file:///w/proj/entity_defs", linux).unwrap();
    let by_path = RootPath::parse("/w/proj/entity_defs", linux).unwrap();
    assert!(by_uri.identity_eq(&by_path));
    assert_eq!(by_uri.as_path(), "/w/proj/entity_defs");
    // 非 file scheme 拒绝;相对路径拒绝;空输入拒绝
    assert!(RootPath::parse("http://x/y", linux).is_err());
    assert!(RootPath::parse("rel/path", linux).is_err());
    assert!(RootPath::parse("", linux).is_err());
}

// ---- ROOT-009: 敏感目录不动(逐目录逐文件台账) ----

#[test]
fn root009_sensitive_dirs_pruned_with_ledger() {
    let s = rel_sorted("sensitive_dirs");
    assert_eq!(s.entity_defs, vec!["entity_defs"]);
    // node_modules/out/.hidden 里的诱饵锚点一个都不进
    assert!(s.entities_xml.is_empty() && s.types_xml.is_empty());
    let root = fixtures_dir().join("sensitive_dirs");
    let raw = scan("sensitive_dirs");
    let ledger_names: Vec<String> = raw
        .skipped_sensitive
        .iter()
        .map(|p| {
            p.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    for expected in [".hidden", ".vscode", "node_modules", "out"] {
        assert!(
            ledger_names.iter().any(|n| n == expected),
            "台账缺 {expected}: {ledger_names:?}"
        );
    }
}

// ---- ROOT-013: 有界深扫描 ----

#[test]
fn root013_bounded_scan_truncation() {
    let s = rel_sorted("deep_nest");
    assert!(s.scan_truncated, "深度 8 的 entity_defs 必须触发截断标注");
    // 深度 6 仍在界内;深度 8 不可达(触顶截断如实标注,零命中 ≠ 没有)
    assert_eq!(
        s.entity_defs,
        vec![
            "d1/d2/d3/d4/d5/d6/entity_defs",
            "demo/assets/scripts/entity_defs",
        ]
    );
    // 深扫兜底资产根(约定链之外的 demo/ 与 d1/d2/d3/)
    assert_eq!(s.config_roots, vec!["d1/d2/d3", "demo"]);
    // 条目上限触顶
    let tight = ScanOptions {
        max_visited: 3,
        ..ScanOptions::default()
    };
    let s2 = scan_workspace_anchors(&fixtures_dir().join("engine_repo"), &tight);
    assert!(s2.scan_truncated && s2.scan_visited <= 3);
    // 深度上限生效(深度 2 封顶时 scripts/entity_defs 不可达)
    let shallow = ScanOptions {
        max_depth: 2,
        ..ScanOptions::default()
    };
    let s3 = scan_workspace_anchors(&fixtures_dir().join("engine_repo"), &shallow);
    assert!(!s3
        .sorted_view()
        .entity_defs
        .contains(&PathBuf::from("scripts/entity_defs")));
}

// ---- ROOT-001: 优先级链与宁缺勿猜 ----

fn build_priority_tree() -> PathBuf {
    let t = temp_tree("priority");
    std::fs::create_dir_all(t.join("entity_defs")).unwrap();
    std::fs::create_dir_all(t.join("scripts/entity_defs")).unwrap();
    std::fs::write(t.join("entity_defs/A.def"), "<root/>").unwrap();
    std::fs::write(t.join("scripts/entity_defs/B.def"), "<root/>").unwrap();
    t
}

#[test]
fn root001_priority_chain_and_no_guess() {
    let t = build_priority_tree();
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let report = engine.discover(&t, &ExplicitConfig::default());
    // 多候选宁缺勿猜:不猜,状态 Ambiguous + RK001
    let defs = field(&report, AnchorKey::EntityDefs);
    assert_eq!(defs.status, FieldStatus::Ambiguous);
    assert_eq!(defs.resolved, None);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.code == RootDiagnosticCode::AmbiguousAnchor));
    // ② 记忆选择优先
    engine.set_remembered(&t, AnchorKey::EntityDefs, t.join("scripts/entity_defs"));
    let report = engine.discover(&t, &ExplicitConfig::default());
    let defs = field(&report, AnchorKey::EntityDefs);
    assert_eq!(defs.status, FieldStatus::Ok);
    assert_eq!(defs.source, ResolutionSource::RememberedChoice);
    assert_eq!(defs.resolved, Some(t.join("scripts/entity_defs")));
    // ① 显式配置最高(含 ${workspaceFolder} 占位)
    let explicit = ExplicitConfig {
        entity_defs: Some("${workspaceFolder}/entity_defs".into()),
        ..ExplicitConfig::default()
    };
    let report = engine.discover(&t, &explicit);
    let defs = field(&report, AnchorKey::EntityDefs);
    assert_eq!(defs.source, ResolutionSource::ExplicitConfig);
    assert_eq!(defs.resolved, Some(t.join("entity_defs")));
    // ③ 唯一命中直接采用(约定链内 → convention 来源)
    let single = temp_tree("single");
    std::fs::create_dir_all(single.join("entity_defs")).unwrap();
    std::fs::write(single.join("entity_defs/S.def"), "<root/>").unwrap();
    let mut engine2 = DiscoveryEngine::new(PlatformTarget::Linux);
    let report = engine2.discover(&single, &ExplicitConfig::default());
    let defs = field(&report, AnchorKey::EntityDefs);
    assert_eq!(defs.status, FieldStatus::Ok);
    assert_eq!(defs.source, ResolutionSource::Convention);
    // 显式配置指向不存在的路径:不生效,回落记忆选择
    let broken = ExplicitConfig {
        entity_defs: Some("${workspaceFolder}/nope".into()),
        ..ExplicitConfig::default()
    };
    let report = engine.discover(&t, &broken);
    assert_eq!(
        field(&report, AnchorKey::EntityDefs).source,
        ResolutionSource::RememberedChoice
    );
    for d in [t, single] {
        std::fs::remove_dir_all(d).unwrap();
    }
}

#[test]
fn root001_config_root_priority() {
    // 资产根:约定探针命中优先;探针是验收口径(目录存在 ≠ 命中)
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let report = engine.discover(
        &fixtures_dir().join("linux_assets"),
        &ExplicitConfig::default(),
    );
    let cfg = field(&report, AnchorKey::ConfigRoot);
    assert_eq!(cfg.status, FieldStatus::Ok);
    assert_eq!(cfg.source, ResolutionSource::Convention);
    assert_eq!(
        cfg.resolved,
        Some(fixtures_dir().join("linux_assets/assets"))
    );
    // 纯约定落空(无探针)时不猜:multi_ambiguous 无资产根
    let report = engine.discover(
        &fixtures_dir().join("multi_ambiguous"),
        &ExplicitConfig::default(),
    );
    assert_eq!(
        field(&report, AnchorKey::ConfigRoot).status,
        FieldStatus::Missing
    );
}

// ---- ROOT-015: 引擎侧定位家族 ----

#[test]
fn root015_kbe_source_root_and_messages() {
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let report = engine.discover(
        &fixtures_dir().join("engine_repo"),
        &ExplicitConfig::default(),
    );
    let kbe = field(&report, AnchorKey::KbeSourceRoot);
    assert_eq!(kbe.status, FieldStatus::Ok);
    assert_eq!(kbe.source, ResolutionSource::Convention);
    assert_eq!(kbe.resolved, Some(fixtures_dir().join("engine_repo/kbe")));
    // 消息表:扫描命中用户副本 → 生效表 = 用户副本(双名四级 ①)
    let msgs = field(&report, AnchorKey::MessagesXml);
    assert_eq!(msgs.status, FieldStatus::Ok);
    assert_eq!(
        msgs.resolved,
        Some(fixtures_dir().join("engine_repo/res/server/messages_fixed.xml"))
    );
    // 纯资产树无消息表 = informational(不计问题,TS :756-760 口径)
    let report = engine.discover(
        &fixtures_dir().join("linux_assets"),
        &ExplicitConfig::default(),
    );
    assert_eq!(
        field(&report, AnchorKey::MessagesXml).status,
        FieldStatus::Informational
    );
    assert_eq!(report.issue_count(), 0);
}

#[test]
fn root015_messages_four_level_fallback() {
    let s = scan("engine_repo");
    // ③ 扫描命中 defaults(无用户副本形态)
    let kbe = Some(Path::new("/fake/kbe"));
    let picked = resolve_engine_messages_xml(&s, kbe).unwrap();
    assert_eq!(
        picked,
        fixtures_dir().join("engine_repo/res/server/messages_fixed.xml"),
        "扫描命中的用户副本是生效表(四级之①)"
    );
    // ④ 源码根 defaults(扫描/超深漏掉工作区消息表时;探针存在性校验)
    let t = temp_tree("msgs4");
    std::fs::create_dir_all(t.join("kbe/res/server")).unwrap();
    std::fs::write(t.join("kbe/res/server/messages_fixed_defaults.xml"), "<m/>").unwrap();
    let empty = kode_root::ScanResult::default();
    let picked = resolve_engine_messages_xml(&empty, Some(&t.join("kbe"))).unwrap();
    assert_eq!(picked, t.join("kbe/res/server/messages_fixed_defaults.xml"));
    // 源码根路径不存在探针 → 不回落(与 TS fs.existsSync 同口径)
    assert_eq!(
        resolve_engine_messages_xml(&empty, Some(Path::new("/fake/kbe"))),
        None
    );
    // 全部落空 = None(纯资产常态)
    assert_eq!(resolve_engine_messages_xml(&empty, None), None);
    assert_eq!(kode_root::ENGINE_MESSAGES_LABELS[0].0, "messages_fixed.xml");
    std::fs::remove_dir_all(&t).unwrap();
}

// ---- ROOT-012: 诊断仅新启 ----

#[test]
fn root012_diagnostics_only_on_fresh_run() {
    let t = build_priority_tree();
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let first = engine.discover(&t, &ExplicitConfig::default());
    assert!(!first.from_cache);
    assert!(!first.diagnostics.is_empty(), "冷跑必须出诊断");
    let second = engine.discover(&t, &ExplicitConfig::default());
    assert!(second.from_cache);
    assert!(second.diagnostics.is_empty(), "缓存命中不得重发诊断");
    assert_eq!(second.fields.len(), first.fields.len(), "字段照常完整回报");
    // 失效后重新冷跑,诊断重出
    engine.invalidate(&t);
    let third = engine.discover(&t, &ExplicitConfig::default());
    assert!(!third.from_cache);
    assert!(!third.diagnostics.is_empty());
    std::fs::remove_dir_all(&t).unwrap();
}

#[test]
fn root012_truncation_diagnostic_on_fresh_only() {
    let mut engine = DiscoveryEngine::new(PlatformTarget::Linux);
    let first = engine.discover(
        &fixtures_dir().join("deep_nest"),
        &ExplicitConfig::default(),
    );
    assert!(first
        .diagnostics
        .iter()
        .any(|d| d.code == RootDiagnosticCode::ScanTruncated));
    let second = engine.discover(
        &fixtures_dir().join("deep_nest"),
        &ExplicitConfig::default(),
    );
    assert!(second.from_cache && second.diagnostics.is_empty());
    let first2 = engine.discover(
        &fixtures_dir().join("sensitive_dirs"),
        &ExplicitConfig::default(),
    );
    assert!(first2
        .diagnostics
        .iter()
        .any(|d| d.code == RootDiagnosticCode::SensitiveDirPruned));
}

// ---- ROOT-014: 多根注册与归属 ----

#[test]
fn root014_multi_root_registration_and_attribution() {
    let mut reg = PlatformRootRegistry::new(PlatformTarget::Linux);
    let assets = reg.register("/w/proj/assets").unwrap();
    let scripts = reg.register("/w/proj/assets/scripts").unwrap();
    let again = reg.register("/w/proj/assets").unwrap();
    assert_eq!(assets, again, "同身份重复注册幂等");
    assert_eq!(reg.roots().len(), 2);
    // 最长前缀归属
    let doc = RootPath::parse(
        "/w/proj/assets/scripts/entity_defs/A.def",
        PlatformTarget::Linux,
    )
    .unwrap();
    assert_eq!(reg.root_for(&doc), Some(scripts));
    let other = RootPath::parse(
        "/w/proj/assets/res/server/kbengine.xml",
        PlatformTarget::Linux,
    )
    .unwrap();
    assert_eq!(reg.root_for(&other), Some(assets));
    let outside = RootPath::parse("/w/elsewhere/x", PlatformTarget::Linux).unwrap();
    assert_eq!(reg.root_for(&outside), None, "根外归 UNROOTED(调用方处理)");
    // 前缀冲突诊断入口
    assert_eq!(reg.overlapping(&doc), vec![assets, scripts]);
    // Windows 折叠感知归属
    let mut wreg = PlatformRootRegistry::new(PlatformTarget::Windows);
    let wid = wreg.register("/W/Proj").unwrap();
    let wdoc = RootPath::parse("/w/proj/entity_defs/A.def", PlatformTarget::Windows).unwrap();
    assert_eq!(wreg.root_for(&wdoc), Some(wid));
}

// ---- ROOT-010(Rust 侧): golden 重生成比对 ----

#[test]
fn root010_golden_matches_regenerated_dump() {
    let regenerated = kode_root::golden::dump_golden(&fixtures_dir());
    let golden_path = repo_root().join("crates/kode-root/tests/golden/root-parity.json");
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-root/tests/golden/root-parity.json");
    let committed = committed.trim_end_matches('\n');
    let regenerated = regenerated.trim_end_matches('\n');
    assert_eq!(
        regenerated, committed,
        "golden 与重生成不一致;重新运行: cargo run -p kode-root --bin dump-golden -- . > crates/kode-root/tests/golden/root-parity.json"
    );
    assert!(committed.contains("\"scanVisited\""));
    assert_eq!(kode_root::golden::PARITY_TREES.len(), 6);
}

// ---- 扫描器遍历计数语义(对拍前提):visited 逐条目计数 ----

#[test]
fn scan_visited_counts_every_entry_like_ts() {
    // sensitive_dirs: 根下 5 条目(entity_defs, node_modules, out, .hidden, .vscode)
    // + entity_defs 内 1(Real.def) = 6;node_modules/out/.hidden/.vscode
    // 不下降,其内部条目不计。
    let s = scan("sensitive_dirs");
    assert_eq!(s.scan_visited, 6, "visited 必须含被剪枝目录自身,不含其后代");
}
