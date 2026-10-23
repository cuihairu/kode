//! ROOT-004/005/007/009/013 有界深扫描:锚点收集 + 边界标注 + 循环免疫。
//!
//! 对拍口径(ROOT-010):默认模式下遍历语义逐字对齐 TS
//! `scanWorkspaceAnchors`(`src/workspaceDiscovery.ts:129-206`):
//! - 每个 readdir 条目计一次 visited(含被剪枝目录与符号链接);
//! - 目录:`SKIP_DIRECTORY_NAMES`/点前缀剪枝,`entity_defs` 目录记锚点;
//! - 文件:entities.xml/types.xml/messages 双名记锚点,`entitydef.cpp`/
//!   `entity_table_mysql.cpp` 向上找 `kbe` 祖先记引擎源码根(去重),
//!   `kbengine.xml` 恰在 `<root>/res/server/` 形态记资产根;
//! - 深度 7 / 条目 20000 触顶截断如实标注(ROOT-013)。
//!
//! 扩展(TS 无、对拍中性):边界标注(ROOT-004)、符号链接跟随模式与
//! 循环护栏(ROOT-005/007)、敏感目录台账(ROOT-009)。扩展不改变对拍
//! 字段的成员与 visited 计数——这是 tests/discovery.rs 断言面的一部分。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::conventions::{is_skipped_directory_name, DEFAULT_SCAN_DEPTH, DEFAULT_SCAN_MAX_VISITED};
use crate::diag::{RootDiagnostic, RootDiagnosticCode};

/// vendored 判定名单(ROOT-004;kode-root 决策,TS 无此概念):
/// 相对路径任一组件命中即视为第三方引入树,内部锚点降级。
pub const VENDORED_DIR_NAMES: &[&str] = &[
    "vendor",
    "vendors",
    "third_party",
    "thirdparty",
    "external",
    "deps",
];

/// 仓边界类别(ROOT-004)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BoundaryKind {
    /// `.gitmodules` 命名或含 `.git` 标记的嵌套仓(工作区根本身的 .git 不算)。
    Submodule,
    /// vendored 名单目录。
    Vendored,
}

/// 一个边界(ROOT-004):边界内锚点仍进对拍原始集,但解析时降级。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Boundary {
    pub kind: BoundaryKind,
    pub path: PathBuf,
}

/// 扫描选项(ROOT-013 默认值与 TS 同源)。
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub max_depth: usize,
    pub max_visited: usize,
    /// ROOT-005/007:是否跟随目录符号链接(默认 false = TS/VFS-010 口径,
    /// 循环天然免疫;true 时带 canonical 身份 visited 集护栏 + RK004 诊断)。
    pub follow_dir_symlinks: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            max_depth: DEFAULT_SCAN_DEPTH,
            max_visited: DEFAULT_SCAN_MAX_VISITED,
            follow_dir_symlinks: false,
        }
    }
}

/// 一次有界 walk 收集的全部锚点(字段对齐 TS `DiscoveredCandidateSet`,
/// `src/workspaceDiscovery.ts:106-119`;扩展字段在分隔线之后)。
#[derive(Debug, Clone, Default)]
pub struct ScanResult {
    pub entity_defs: Vec<PathBuf>,
    pub entities_xml: Vec<PathBuf>,
    pub types_xml: Vec<PathBuf>,
    pub kbe_source_roots: Vec<PathBuf>,
    /// 引擎消息表双名(TS:`messages_fixed.xml` 用户副本 /
    /// `messages_fixed_defaults.xml` 缺省,`src/workspaceDiscovery.ts:111`)。
    pub messages_xml: Vec<PathBuf>,
    /// 深扫描命中的资产根(`res/server/kbengine.xml` 探针所在目录族)。
    pub config_roots: Vec<PathBuf>,
    pub scan_visited: usize,
    pub scan_truncated: bool,
    // ---- kode-root 扩展(TS 对拍中性)----
    /// ROOT-004 仓/厂边界。
    pub boundaries: Vec<Boundary>,
    /// ROOT-009 敏感目录台账(逐目录路径,含点前缀剪枝)。
    pub skipped_sensitive: Vec<PathBuf>,
    /// ROOT-005/007 循环跳过台账(follow 模式)。
    pub cycles_skipped: Vec<PathBuf>,
    /// ROOT-012 扫描期诊断(仅冷跑;缓存命中不重发,见 resolve::DiscoveryEngine)。
    pub diagnostics: Vec<RootDiagnostic>,
}

impl ScanResult {
    /// 排序去重视图(对拍 golden 与 TS 侧比较都用此形态,消除 readdir 序差)。
    pub fn sorted_view(&self) -> SortedScanView {
        SortedScanView {
            entity_defs: sorted_unique(&self.entity_defs),
            entities_xml: sorted_unique(&self.entities_xml),
            types_xml: sorted_unique(&self.types_xml),
            kbe_source_roots: sorted_unique(&self.kbe_source_roots),
            messages_xml: sorted_unique(&self.messages_xml),
            config_roots: sorted_unique(&self.config_roots),
            scan_visited: self.scan_visited,
            scan_truncated: self.scan_truncated,
        }
    }

    /// ROOT-004:锚点是否落在边界(嵌套仓/vendored)之内。
    pub fn anchor_is_foreign(&self, root: &Path, anchor: &Path) -> bool {
        let ok = anchor.strip_prefix(root).is_ok_and(|rel| {
            rel.components().count() > 0
                && rel
                    .components()
                    .filter_map(|c| c.as_os_str().to_str())
                    .any(|c| VENDORED_DIR_NAMES.contains(&c))
        });
        if ok {
            return true;
        }
        self.boundaries.iter().any(|b| {
            b.kind == BoundaryKind::Submodule && anchor.starts_with(&b.path) && anchor != b.path
        })
    }
}

/// 排序去重后的扫描视图(对拍形状)。
#[derive(Debug, Clone)]
pub struct SortedScanView {
    pub entity_defs: Vec<PathBuf>,
    pub entities_xml: Vec<PathBuf>,
    pub types_xml: Vec<PathBuf>,
    pub kbe_source_roots: Vec<PathBuf>,
    pub messages_xml: Vec<PathBuf>,
    pub config_roots: Vec<PathBuf>,
    pub scan_visited: usize,
    pub scan_truncated: bool,
}

fn sorted_unique(paths: &[PathBuf]) -> Vec<PathBuf> {
    let set: BTreeSet<&PathBuf> = paths.iter().collect();
    set.into_iter().cloned().collect()
}

/// 有界深扫描入口(ROOT-013;TS `scanWorkspaceAnchors` 的 Rust 移植 + 扩展)。
pub fn scan_workspace_anchors(workspace_root: &Path, options: &ScanOptions) -> ScanResult {
    AnchorScanner::new(options).scan(workspace_root)
}

/// 扫描器(可复用 visited/护栏状态;每次 scan 一个根)。
#[derive(Debug)]
pub struct AnchorScanner {
    options: ScanOptions,
    visited: usize,
    truncated: bool,
    result: ScanResult,
    /// ROOT-005/007 跟随模式下的 canonical 身份集(挂载环/符号链接环终止保障)。
    descended_canonical: BTreeSet<PathBuf>,
}

impl AnchorScanner {
    pub fn new(options: &ScanOptions) -> AnchorScanner {
        AnchorScanner {
            options: options.clone(),
            visited: 0,
            truncated: false,
            result: ScanResult::default(),
            descended_canonical: BTreeSet::new(),
        }
    }

    pub fn scan(mut self, workspace_root: &Path) -> ScanResult {
        let root_canonical =
            std::fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
        self.descended_canonical.insert(root_canonical);
        self.walk(workspace_root, 0);
        self.result.scan_visited = self.visited;
        self.result.scan_truncated = self.truncated;
        self.result.boundaries.sort();
        self.result.boundaries.dedup();
        self.result.skipped_sensitive.sort();
        self.result.skipped_sensitive.dedup();
        self.result
    }

    fn walk(&mut self, dir: &Path, depth: usize) {
        if depth > self.options.max_depth || self.visited >= self.options.max_visited {
            // 触顶截断:命中集可能不全,报告如实标注(TS :149-153 同口径)。
            self.truncated = true;
            return;
        }
        let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(_) => return, // 权限/消失:跳过不 panic(VFS-010 口径)
        };
        self.prescan_boundaries(dir, &entries);
        for entry in entries {
            if self.visited >= self.options.max_visited {
                self.truncated = true;
                return;
            }
            self.visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = dir.join(&name);
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                self.visit_directory(&full, &name, depth);
                continue;
            }
            if file_type.is_file() {
                self.visit_file(&full, &name, dir);
                continue;
            }
            // 符号链接:默认不跟随(TS Dirent.isDirectory/isFile 对 symlink 均
            // false,同口径);follow 模式解析目标形态走目录/文件分支(ROOT-007)。
            if file_type.is_symlink() && self.options.follow_dir_symlinks {
                self.visit_symlink(&full, &name, dir, depth);
            }
        }
    }

    fn visit_directory(&mut self, full: &Path, name: &str, depth: usize) {
        if is_skipped_directory_name(name) {
            // ROOT-009 敏感目录台账:计一次 visited(上面已计),不下降。
            self.result.skipped_sensitive.push(full.to_path_buf());
            return;
        }
        if name == "entity_defs" {
            self.result.entity_defs.push(full.to_path_buf());
        }
        self.walk(full, depth + 1);
    }

    fn visit_file(&mut self, full: &Path, name: &str, dir: &Path) {
        match name {
            "entities.xml" => self.result.entities_xml.push(full.to_path_buf()),
            "types.xml" => self.result.types_xml.push(full.to_path_buf()),
            "messages_fixed.xml" | "messages_fixed_defaults.xml" => {
                self.result.messages_xml.push(full.to_path_buf());
            }
            "entitydef.cpp" | "entity_table_mysql.cpp" => {
                if let Some(kbe_root) = find_kbe_root_anchor(full) {
                    if !self.result.kbe_source_roots.contains(&kbe_root) {
                        self.result.kbe_source_roots.push(kbe_root);
                    }
                }
            }
            "kbengine.xml"
                if dir.file_name().map(|n| n == "server").unwrap_or(false)
                    && dir
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n == "res")
                        .unwrap_or(false) =>
            {
                // 资产根探针形态(TS :189-197):kbengine.xml 恰在
                // <root>/res/server/ 下,资产根 = 再上两级。
                if let Some(root_dir) = dir.parent().and_then(|p| p.parent()) {
                    self.result.config_roots.push(root_dir.to_path_buf());
                }
            }
            _ => {}
        }
    }

    fn visit_symlink(&mut self, full: &Path, name: &str, dir: &Path, depth: usize) {
        // 先按链接目标形态分派;解析失败(悬空)按普通条目忽略。
        let target_type = std::fs::metadata(full).map(|m| m.file_type());
        match target_type {
            Ok(t) if t.is_dir() => {
                // ROOT-005/007 循环护栏:canonical 身份已见(符号链接环、
                // 绑定挂载环、别名路径汇合)→ 跳过 + RK004 诊断。
                let canonical = std::fs::canonicalize(full).unwrap_or_else(|_| full.to_path_buf());
                if !self.descended_canonical.insert(canonical) {
                    self.result.cycles_skipped.push(full.to_path_buf());
                    self.result.diagnostics.push(RootDiagnostic::new(
                        RootDiagnosticCode::CycleSkipped,
                        full.to_string_lossy(),
                        "目录符号链接/挂载目标的 canonical 身份已在本次下降集合中,跳过以防循环",
                    ));
                    return;
                }
                self.visit_directory(full, name, depth);
            }
            Ok(t) if t.is_file() => {
                self.visit_file(full, name, dir);
            }
            _ => {}
        }
    }

    /// ROOT-004 边界预扫:含 `.git` 的子目录(嵌套仓)与 `.gitmodules`
    /// 命名的路径、vendored 名单目录。
    fn prescan_boundaries(&mut self, dir: &Path, entries: &[std::fs::DirEntry]) {
        let names: Vec<String> = entries
            .iter()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // vendored:当前目录名命中名单(工作区根本身不算)。
        if let Some(name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) {
            if VENDORED_DIR_NAMES.contains(&name.as_str()) {
                self.result.boundaries.push(Boundary {
                    kind: BoundaryKind::Vendored,
                    path: dir.to_path_buf(),
                });
            }
        }
        // .gitmodules 命名的子模块路径(相对当前目录)。
        if names.iter().any(|n| n == ".gitmodules") {
            let gm = dir.join(".gitmodules");
            for sub in parse_gitmodules_paths(&gm) {
                self.result.boundaries.push(Boundary {
                    kind: BoundaryKind::Submodule,
                    path: dir.join(sub),
                });
            }
        }
        // .git 目录标记(真实 submodule checkout 形态;名字必须精确)。
        if names.iter().any(|n| n == ".git") {
            let entry = entries
                .iter()
                .find(|e| e.file_name().to_string_lossy() == ".git");
            if let Some(e) = entry {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    self.result.boundaries.push(Boundary {
                        kind: BoundaryKind::Submodule,
                        path: dir.to_path_buf(),
                    });
                }
            }
        }
    }
}

/// 引擎源码根锚点:从锚文件向上找名为 `kbe` 的祖先目录
/// (TS `findKbeRootAnchor`,`src/workspaceDiscovery.ts:209-221`)。
pub fn find_kbe_root_anchor(file: &Path) -> Option<PathBuf> {
    let mut dir = file.parent()?;
    loop {
        if dir.file_name().map(|n| n == "kbe").unwrap_or(false) {
            return Some(dir.to_path_buf());
        }
        let parent = dir.parent()?;
        dir = parent;
    }
}

/// 极简 `.gitmodules` 解析:只取 `path = X` 行的值(ROOT-004)。
fn parse_gitmodules_paths(gitmodules: &Path) -> Vec<String> {
    let text = match std::fs::read_to_string(gitmodules) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut paths = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("path") {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix('=') {
                let value = value.trim();
                if !value.is_empty() {
                    paths.push(value.to_string());
                }
            }
        }
    }
    paths
}
