//! ROOT-008 引擎配置规则移植(证据化):全部常量与谓词对齐
//! `src/workspaceDiscovery.ts` 现有实现,每条带 TS file:line 注记。
//! 对拍门禁(ROOT-010)保证这些规则与 TS 同输入同输出。

use std::path::{Path, PathBuf};

/// 约定路径常量,逐字移植自 `src/workspaceDiscovery.ts:16-47`
/// (`DISCOVERY_CONVENTIONS`)。修改任一条都必须:① TS 侧同改;② 重新生成
/// golden;③ docs/kode2/pr-006.md 证据表同步。
#[derive(Debug, Clone)]
pub struct DiscoveryConventions {
    pub entity_defs: &'static [&'static str],
    pub entities_xml: &'static [&'static str],
    pub types_xml: &'static [&'static str],
    /// 引擎源码根锚点:本仓 fork 为 kbe/src/lib,原版为 kbe/src/common
    /// (TS `src/workspaceDiscovery.ts:39-43`)。
    pub kbe_source_anchors: &'static [&'static str],
    /// 资产根约定候选(TS `src/workspaceDiscovery.ts:46`,'' 即工作区根本身)。
    pub config_roots: &'static [&'static str],
}

/// 与 TS `DISCOVERY_CONVENTIONS` 同源(证据:`src/workspaceDiscovery.ts:16-47`)。
pub const CONVENTIONS: DiscoveryConventions = DiscoveryConventions {
    entity_defs: &[
        "entity_defs",
        "scripts/entity_defs",
        "assets/scripts/entity_defs",
        "server_assets/scripts/entity_defs",
    ],
    entities_xml: &[
        "entities.xml",
        "scripts/entities.xml",
        "assets/scripts/entities.xml",
        "server_assets/scripts/entities.xml",
    ],
    types_xml: &[
        "types.xml",
        "entity_defs/types.xml",
        "scripts/entity_defs/types.xml",
        "assets/scripts/entity_defs/types.xml",
        "server_assets/scripts/entity_defs/types.xml",
        "scripts/types.xml",
        "assets/scripts/types.xml",
    ],
    kbe_source_anchors: &[
        "kbe/src/lib/entitydef/entitydef.cpp",
        "kbe/src/lib/db_mysql/entity_table_mysql.cpp",
        "kbe/src/common/entitydef/entitydef.cpp",
    ],
    config_roots: &["", "assets", "server_assets"],
};

/// 有界深扫描上限,移植自 TS `src/workspaceDiscovery.ts:103-104`。
pub const DEFAULT_SCAN_DEPTH: usize = 7;
pub const DEFAULT_SCAN_MAX_VISITED: usize = 20_000;

/// 敏感目录名单(ROOT-009),逐字对齐 TS `SKIP_DIRECTORY_NAMES`
/// (`src/workspaceDiscovery.ts:100`):node_modules/.git/.vscode/out/dist,
/// 另有点前缀目录剪枝(TS `src/workspaceDiscovery.ts:168`)。
/// 注意:这是发现层的名单,比 kode-vfs::walk 的 DEFAULT_EXCLUDED_DIRS
/// (VFS-007 文件分类扫描名单)窄——两层各有证据口径,不互相覆盖;
/// 对拍(ROOT-010)要求与本名单逐字一致。
pub const SKIP_DIRECTORY_NAMES: &[&str] = &["node_modules", ".git", ".vscode", "out", "dist"];

pub fn is_skipped_directory_name(name: &str) -> bool {
    SKIP_DIRECTORY_NAMES.contains(&name) || name.starts_with('.')
}

/// 资产根验收谓词(ROOT-008/ROOT-015):引擎以该目录为 cwd 启动并读
/// `<根>/res/server/kbengine.xml`;移植自 TS `hasEngineConfigProbe`
/// (`src/workspaceDiscovery.ts:58-66`,探针口径同 `serverManager`)。
pub fn has_engine_config_probe(config_root: &Path) -> bool {
    config_root
        .join("res")
        .join("server")
        .join("kbengine.xml")
        .is_file()
}

/// 资产根约定候选:静态名单 + 一级 `*_assets` 目录(动态段),移植自 TS
/// `conventionalConfigRoots`(`src/workspaceDiscovery.ts:76-98`;动态段
/// 只读一级,readdir 失败回落静态名单)。返回绝对路径,顺序=优先顺序。
pub fn conventional_config_roots(workspace_root: &Path) -> Vec<PathBuf> {
    let statics: Vec<PathBuf> = CONVENTIONS
        .config_roots
        .iter()
        .map(|rel| workspace_root.join(rel))
        .collect();
    let entries = match std::fs::read_dir(workspace_root) {
        Ok(rd) => rd,
        Err(_) => return statics,
    };
    let mut dynamics: Vec<PathBuf> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_dir && name.ends_with("_assets") {
            dynamics.push(workspace_root.join(name));
        }
    }
    let mut merged = statics;
    for d in dynamics {
        if !merged.contains(&d) {
            merged.push(d);
        }
    }
    merged
}

/// 候选链取第一个存在项(TS `firstExisting`,`src/workspaceDiscovery.ts:289-296`)。
pub fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|c| c.exists()).cloned()
}

/// 只认唯一命中,多候选宁缺勿猜(ROOT-001;TS `firstSingle`,
/// `src/workspaceDiscovery.ts:303-305` 及注释:多候选交激活期询问记忆,
/// 同步读路径绝不静默改写 def 根)。
pub fn first_single(candidates: &[PathBuf]) -> Option<PathBuf> {
    if candidates.len() == 1 {
        Some(candidates[0].clone())
    } else {
        None
    }
}
