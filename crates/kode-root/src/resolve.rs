//! ROOT-001/012/014/015 根解析:优先级链、宁缺勿猜、引擎定位家族、
//! 多根归属与「诊断仅新启」。
//!
//! 移植证据(ROOT-008/015,逐函数对齐 TS):
//! - def 根家族解析 `src/workspaceDiscovery.ts:308-332`(记忆优先,否则只
//!   认深扫描唯一命中);
//! - 资产根解析 `src/workspaceDiscovery.ts:340-352`(约定探针命中 → 记忆
//!   探针验收 → 深扫描唯一命中);
//! - 引擎源码根 `src/workspaceDiscovery.ts:358-367`(约定锚点直查 → 深扫
//!   描首项);
//! - 引擎消息表双名四级 `src/workspaceDiscovery.ts:382-413`(用户副本 →
//!   源码根用户副本 → defaults → 源码根 defaults);
//! - 候选盘点与歧义判定 `src/workspaceDiscovery.ts:423-469`。
//!
//! 行为差异(如实声明,见 docs/kode2/pr-006.md):边界内锚点(ROOT-004)
//! 在存在非边界候选时降级出解析集——TS 无此概念,属 kode-root 扩展;
//! 显式配置优先级在 TS 位于 layout 装配层,此处收敛为解析链第一级(ROOT-001)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kode_vfs::store::RootId;

use crate::conventions::{
    conventional_config_roots, first_existing, first_single, has_engine_config_probe, CONVENTIONS,
};
use crate::diag::{RootDiagnostic, RootDiagnosticCode};
use crate::platform::{case_folds, PlatformTarget, RootPath};
use crate::scan::{BoundaryKind, ScanOptions, ScanResult};

/// 锚点键(对齐 TS `DiscoveryKey`,`src/workspaceDiscovery.ts:230`,扩展
/// 引擎侧两个定位家族)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AnchorKey {
    EntityDefs,
    EntitiesXml,
    TypesXml,
    ConfigRoot,
    KbeSourceRoot,
    MessagesXml,
}

impl AnchorKey {
    pub fn label(self) -> &'static str {
        match self {
            AnchorKey::EntityDefs => "实体定义目录 entity_defs",
            AnchorKey::EntitiesXml => "entities.xml",
            AnchorKey::TypesXml => "types.xml",
            AnchorKey::ConfigRoot => "服务器资产根 kbengine.assetsRoot",
            AnchorKey::KbeSourceRoot => "引擎源码根 kbe/",
            AnchorKey::MessagesXml => "引擎消息表 messages_fixed.xml",
        }
    }
}

/// 字段状态(对齐 TS `DiscoveryFieldStatus`,`src/workspaceDiscovery.ts:520`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldStatus {
    /// 解析成功且真实存在。
    Ok,
    /// 多候选未选(宁缺勿猜,交激活期询问记忆)。
    Ambiguous,
    /// 未解析出可用路径。
    Missing,
    /// 解析不出但属工作区形态常态(如纯资产仓没有引擎消息表),不计问题。
    Informational,
}

/// 取值来源(对齐 TS `DiscoveryValueSource`,`src/workspaceDiscovery.ts:522-529`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionSource {
    ExplicitConfig,
    RememberedChoice,
    Convention,
    DeepScan,
    Derived,
    Fallback,
    None,
}

/// 显式配置输入(ROOT-001 优先级链第一级;TS 中位于装配层,此处显式化)。
#[derive(Debug, Clone, Default)]
pub struct ExplicitConfig {
    pub entity_defs: Option<String>,
    pub entities_xml: Option<String>,
    pub types_xml: Option<String>,
    pub config_root: Option<String>,
}

/// 单字段解析报告。
#[derive(Debug, Clone)]
pub struct FieldReport {
    pub key: AnchorKey,
    pub status: FieldStatus,
    pub resolved: Option<PathBuf>,
    pub source: ResolutionSource,
    /// 深扫描命中全集(排序去重)。
    pub scan_hits: Vec<PathBuf>,
    /// 约定链命中(存在项,绝对路径)。
    pub convention_hits: Vec<PathBuf>,
    pub remembered: Option<PathBuf>,
    pub explicit: Option<String>,
    /// ROOT-004:解析结果落在仓/厂边界内。
    pub foreign: bool,
}

/// 一次发现报告(ROOT-012:`from_cache=true` 时 diagnostics 恒空)。
#[derive(Debug, Clone)]
pub struct DiscoveryReport {
    pub workspace_root: PathBuf,
    pub from_cache: bool,
    pub fields: Vec<FieldReport>,
    pub diagnostics: Vec<RootDiagnostic>,
    pub scan_visited: usize,
    pub scan_truncated: bool,
}

impl DiscoveryReport {
    /// 问题字段数(ok/informational 之外)。
    pub fn issue_count(&self) -> usize {
        self.fields
            .iter()
            .filter(|f| !matches!(f.status, FieldStatus::Ok | FieldStatus::Informational))
            .count()
    }
}

/// 发现引擎:扫描缓存 + 记忆选择 + 优先级解析(ROOT-001/012)。
#[derive(Debug)]
pub struct DiscoveryEngine {
    pub platform: PlatformTarget,
    options: ScanOptions,
    scans: HashMap<PathBuf, Arc<ScanResult>>,
    remembered: HashMap<(PathBuf, AnchorKey), PathBuf>,
}

impl Default for DiscoveryEngine {
    fn default() -> Self {
        Self::new(PlatformTarget::detect())
    }
}

impl DiscoveryEngine {
    pub fn new(platform: PlatformTarget) -> DiscoveryEngine {
        DiscoveryEngine {
            platform,
            options: ScanOptions::default(),
            scans: HashMap::new(),
            remembered: HashMap::new(),
        }
    }

    pub fn with_options(platform: PlatformTarget, options: ScanOptions) -> DiscoveryEngine {
        DiscoveryEngine {
            platform,
            options,
            scans: HashMap::new(),
            remembered: HashMap::new(),
        }
    }

    /// 激活期询问所得的记忆选择(ROOT-001 第二级)。
    pub fn set_remembered(&mut self, workspace_root: &Path, key: AnchorKey, path: PathBuf) {
        self.remembered
            .insert((workspace_root.to_path_buf(), key), path);
    }

    pub fn remembered(&self, workspace_root: &Path, key: AnchorKey) -> Option<&PathBuf> {
        self.remembered
            .get(&(workspace_root.to_path_buf(), key))
            .filter(|p| p.exists())
    }

    /// 扫描结果(缓存命中返回缓存;ROOT-012 的缓存面)。
    pub fn scan_result(&mut self, workspace_root: &Path) -> Arc<ScanResult> {
        if let Some(cached) = self.scans.get(workspace_root) {
            return cached.clone();
        }
        let result = Arc::new(crate::scan::scan_workspace_anchors(
            workspace_root,
            &self.options,
        ));
        self.scans
            .insert(workspace_root.to_path_buf(), result.clone());
        result
    }

    /// 失效(ROOT-012:失效后下次 discover 重新冷跑并重出诊断)。
    pub fn invalidate(&mut self, workspace_root: &Path) {
        self.scans.remove(workspace_root);
    }

    /// 完整发现(ROOT-001):冷跑产出诊断,缓存命中只回报表(ROOT-012)。
    pub fn discover(
        &mut self,
        workspace_root: &Path,
        explicit: &ExplicitConfig,
    ) -> DiscoveryReport {
        let from_cache = self.scans.contains_key(workspace_root);
        let scan = self.scan_result(workspace_root);
        let fields = vec![
            self.resolve_anchor_field(
                workspace_root,
                AnchorKey::EntityDefs,
                &scan,
                |ws| convention_hits(ws, CONVENTIONS.entity_defs),
                explicit.entity_defs.as_deref(),
            ),
            self.resolve_anchor_field(
                workspace_root,
                AnchorKey::EntitiesXml,
                &scan,
                |ws| convention_hits(ws, CONVENTIONS.entities_xml),
                explicit.entities_xml.as_deref(),
            ),
            self.resolve_anchor_field(
                workspace_root,
                AnchorKey::TypesXml,
                &scan,
                |ws| convention_hits(ws, CONVENTIONS.types_xml),
                explicit.types_xml.as_deref(),
            ),
            self.resolve_config_field(workspace_root, &scan, explicit.config_root.as_deref()),
            self.resolve_kbe_source_field(workspace_root, &scan),
            self.resolve_messages_field(workspace_root, &scan),
        ];

        let mut diagnostics: Vec<RootDiagnostic> = Vec::new();
        if from_cache {
            // ROOT-012:缓存命中不重发诊断(报告仍有完整字段)。
            return DiscoveryReport {
                workspace_root: workspace_root.to_path_buf(),
                from_cache,
                fields,
                diagnostics,
                scan_visited: scan.scan_visited,
                scan_truncated: scan.scan_truncated,
            };
        }
        for field in &fields {
            if field.status == FieldStatus::Ambiguous {
                let n = union_existing(&field.convention_hits, &field.scan_hits).len();
                diagnostics.push(RootDiagnostic::new(
                    RootDiagnosticCode::AmbiguousAnchor,
                    field.key.label(),
                    format!("找到 {n} 个候选但未选定:宁缺勿猜,交激活期一次性询问记忆"),
                ));
            }
            if field.foreign {
                diagnostics.push(RootDiagnostic::new(
                    RootDiagnosticCode::ForeignAnchorDeprioritized,
                    field
                        .resolved
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    "解析结果落在 submodule/vendored 边界内,仅作降级使用",
                ));
            }
        }
        if scan.scan_truncated {
            diagnostics.push(RootDiagnostic::new(
                RootDiagnosticCode::ScanTruncated,
                workspace_root.to_string_lossy(),
                format!(
                    "有界深扫描触顶截断(深度 {}/条目 {}),命中集可能不全",
                    self.options.max_depth, self.options.max_visited
                ),
            ));
        }
        if !scan.skipped_sensitive.is_empty() {
            diagnostics.push(RootDiagnostic::new(
                RootDiagnosticCode::SensitiveDirPruned,
                workspace_root.to_string_lossy(),
                format!(
                    "敏感目录剪枝 {} 个(逐目录见 scan.skipped_sensitive 台账)",
                    scan.skipped_sensitive.len()
                ),
            ));
        }
        DiscoveryReport {
            workspace_root: workspace_root.to_path_buf(),
            from_cache,
            fields,
            diagnostics,
            scan_visited: scan.scan_visited,
            scan_truncated: scan.scan_truncated,
        }
    }

    /// def 根家族字段(ROOT-001 优先级链;显式配置 → 记忆 → 唯一命中;
    /// 多候选宁缺勿猜)。
    fn resolve_anchor_field(
        &self,
        workspace_root: &Path,
        key: AnchorKey,
        scan: &ScanResult,
        conventions_of: impl Fn(&Path) -> Vec<PathBuf>,
        explicit: Option<&str>,
    ) -> FieldReport {
        let convention_hits = conventions_of(workspace_root);
        let scan_hits = match key {
            AnchorKey::EntityDefs => &scan.entity_defs,
            AnchorKey::EntitiesXml => &scan.entities_xml,
            AnchorKey::TypesXml => &scan.types_xml,
            _ => unreachable!("anchor field invoked with engine-side key"),
        };
        let remembered = self.remembered(workspace_root, key).cloned();
        let explicit = explicit.map(str::to_string);
        let validator = |p: &Path| p.exists();
        resolve_field_common(
            workspace_root,
            key,
            scan,
            convention_hits,
            scan_hits.clone(),
            remembered,
            explicit,
            validator,
        )
    }

    /// 资产根字段(ROOT-015,TS `resolveDiscoveredConfigRoot` 口径):
    /// 约定探针命中 → 显式/记忆(探针验收)→ 深扫描唯一命中。
    fn resolve_config_field(
        &self,
        workspace_root: &Path,
        scan: &ScanResult,
        explicit: Option<&str>,
    ) -> FieldReport {
        let conventional = conventional_config_roots(workspace_root);
        let convention_hits: Vec<PathBuf> = conventional
            .iter()
            .filter(|p| has_engine_config_probe(p))
            .cloned()
            .collect();
        let remembered = self
            .remembered(workspace_root, AnchorKey::ConfigRoot)
            .cloned();
        let explicit = explicit.map(str::to_string);
        let validator = |p: &Path| has_engine_config_probe(p);
        resolve_field_common(
            workspace_root,
            AnchorKey::ConfigRoot,
            scan,
            convention_hits,
            scan.config_roots.clone(),
            remembered,
            explicit,
            validator,
        )
    }

    /// 引擎源码根(ROOT-015,TS `resolveKbeSourceRoot` 口径):
    /// 约定锚点直查向上找 kbe → 深扫描首项。
    fn resolve_kbe_source_field(&self, workspace_root: &Path, scan: &ScanResult) -> FieldReport {
        let convention_hits: Vec<PathBuf> = CONVENTIONS
            .kbe_source_anchors
            .iter()
            .map(|a| workspace_root.join(a))
            .filter(|p| p.exists())
            .collect();
        let conventional_root =
            first_existing(&convention_hits).and_then(|p| crate::scan::find_kbe_root_anchor(&p));
        let resolved = conventional_root
            .clone()
            .or_else(|| scan.kbe_source_roots.first().cloned());
        let source = if resolved.is_none() {
            ResolutionSource::None
        } else if conventional_root.is_some() {
            ResolutionSource::Convention
        } else {
            ResolutionSource::DeepScan
        };
        let status = match &resolved {
            Some(p) if p.exists() => FieldStatus::Ok,
            // 引擎源码根缺失对纯资产工作区是常态(与消息表 informational 同口径);
            // 装到引擎仓却解析不出时由上层 binPath 报告表达。
            None => FieldStatus::Informational,
            Some(_) => FieldStatus::Missing,
        };
        FieldReport {
            key: AnchorKey::KbeSourceRoot,
            status,
            foreign: resolved
                .as_deref()
                .map(|r| scan.anchor_is_foreign(workspace_root, r))
                .unwrap_or(false),
            resolved,
            source,
            scan_hits: scan.kbe_source_roots.clone(),
            convention_hits,
            remembered: None,
            explicit: None,
        }
    }

    /// 引擎消息表双名四级(ROOT-015,TS `resolveEngineMessagesXmlFrom`
    /// `src/workspaceDiscovery.ts:382-409`)。
    fn resolve_messages_field(&self, workspace_root: &Path, scan: &ScanResult) -> FieldReport {
        let kbe_root = self.resolve_kbe_source_field(workspace_root, scan);
        let resolved = resolve_engine_messages_xml(scan, kbe_root.resolved.as_deref());
        // 状态口径(TS :756-760):ok;无源码根且工作区无消息表 = informational;
        // 有源码根但两份皆无 = missing。
        let status = match &resolved {
            Some(p) if p.exists() => FieldStatus::Ok,
            _ if kbe_root.resolved.is_none() => FieldStatus::Informational,
            _ => FieldStatus::Missing,
        };
        let source = if resolved.is_some() {
            ResolutionSource::Derived
        } else {
            ResolutionSource::None
        };
        FieldReport {
            key: AnchorKey::MessagesXml,
            status,
            foreign: false,
            resolved,
            source,
            scan_hits: scan.messages_xml.clone(),
            convention_hits: Vec::new(),
            remembered: None,
            explicit: None,
        }
    }
}

/// 消息表双名四级(ROOT-015;纯函数,TS `resolveEngineMessagesXmlFrom` 逐行
/// 对齐:① 扫描命中的用户副本 ② 源码根用户副本 ③ 扫描命中的 defaults
/// ④ 源码根 defaults;用户副本与 defaults 各在各的树里)。
pub fn resolve_engine_messages_xml(scan: &ScanResult, kbe_root: Option<&Path>) -> Option<PathBuf> {
    let scan_hit = |name: &str| {
        scan.messages_xml
            .iter()
            .find(|p| p.file_name().map(|n| n == name).unwrap_or(false))
            .cloned()
    };
    if let Some(user) = scan_hit("messages_fixed.xml") {
        return Some(user);
    }
    if let Some(root) = kbe_root {
        let source_user = root.join("res").join("server").join("messages_fixed.xml");
        if source_user.exists() {
            return Some(source_user);
        }
    }
    if let Some(defaults) = scan_hit("messages_fixed_defaults.xml") {
        return Some(defaults);
    }
    if let Some(root) = kbe_root {
        let source_defaults = root
            .join("res")
            .join("server")
            .join("messages_fixed_defaults.xml");
        if source_defaults.exists() {
            return Some(source_defaults);
        }
    }
    None
}

/// 消息表双名标签(ROOT-015;引擎装载序 defaults 先载打底、用户副本后载
/// 覆盖,TS `src/workspaceDiscovery.ts:370-374` 证据)。
pub const ENGINE_MESSAGES_LABELS: [(&str, &str); 2] = [
    ("messages_fixed.xml", "用户副本(生效表)"),
    ("messages_fixed_defaults.xml", "缺省表(打底)"),
];

#[allow(clippy::too_many_arguments)]
fn resolve_field_common(
    workspace_root: &Path,
    key: AnchorKey,
    scan: &ScanResult,
    convention_hits: Vec<PathBuf>,
    scan_hits: Vec<PathBuf>,
    remembered: Option<PathBuf>,
    explicit: Option<String>,
    validator: impl Fn(&Path) -> bool,
) -> FieldReport {
    // ROOT-001:① 显式配置(验收)→ ② 记忆选择(验收)→ ③ 唯一命中。
    let explicit_resolved = explicit
        .as_deref()
        .map(|v| resolve_against_workspace(workspace_root, v))
        .filter(|p| validator(p));
    let remembered_resolved = remembered.clone().filter(|p| validator(p));
    // 边界降级(ROOT-004):存在非边界候选时,边界内候选出解析集。
    let demoted_scan_hits = demote_foreign(workspace_root, scan, &scan_hits);
    let resolved = explicit_resolved
        .clone()
        .or(remembered_resolved.clone())
        .or_else(|| first_single(&demoted_scan_hits));
    let existing = union_existing(&convention_hits, &scan_hits);
    let status = match &resolved {
        Some(p) if validator(p) => FieldStatus::Ok,
        _ if existing.len() > 1 => FieldStatus::Ambiguous,
        _ => FieldStatus::Missing,
    };
    let source = source_of(
        resolved.as_deref(),
        explicit_resolved.as_deref(),
        remembered_resolved.as_deref(),
        &convention_hits,
        &scan_hits,
        &existing,
    );
    FieldReport {
        key,
        status,
        foreign: resolved
            .as_deref()
            .map(|r| scan.anchor_is_foreign(workspace_root, r))
            .unwrap_or(false),
        resolved,
        source,
        scan_hits,
        convention_hits,
        remembered,
        explicit,
    }
}

/// ROOT-004:边界内候选降级——存在非边界候选时返回非边界子集,否则原样
/// (宁缺勿猜的主语是候选数,不是边界)。
fn demote_foreign(workspace_root: &Path, scan: &ScanResult, hits: &[PathBuf]) -> Vec<PathBuf> {
    let inner: Vec<PathBuf> = hits
        .iter()
        .filter(|p| !scan.anchor_is_foreign(workspace_root, p))
        .cloned()
        .collect();
    if inner.is_empty() || inner.len() == hits.len() {
        hits.to_vec()
    } else {
        inner
    }
}

#[allow(clippy::too_many_arguments)]
fn source_of(
    resolved: Option<&Path>,
    explicit: Option<&Path>,
    remembered: Option<&Path>,
    conventions: &[PathBuf],
    scan_hits: &[PathBuf],
    _existing: &[PathBuf],
) -> ResolutionSource {
    let Some(resolved) = resolved else {
        return ResolutionSource::None;
    };
    if explicit.map(|e| e == resolved).unwrap_or(false) {
        return ResolutionSource::ExplicitConfig;
    }
    if remembered.map(|r| r == resolved).unwrap_or(false) {
        return ResolutionSource::RememberedChoice;
    }
    if conventions.iter().any(|c| c == resolved) {
        return ResolutionSource::Convention;
    }
    if scan_hits.iter().any(|s| s == resolved) {
        return ResolutionSource::DeepScan;
    }
    if resolved.exists() {
        ResolutionSource::Derived
    } else {
        ResolutionSource::Fallback
    }
}

fn union_existing(a: &[PathBuf], b: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in a.iter().chain(b.iter()) {
        if p.exists() && !out.contains(p) {
            out.push(p.clone());
        }
    }
    out
}

/// 约定链命中(存在项;绝对路径,约定顺序=优先顺序)。
fn convention_hits(workspace_root: &Path, conventions: &[&str]) -> Vec<PathBuf> {
    conventions
        .iter()
        .map(|rel| workspace_root.join(rel))
        .filter(|p| p.exists())
        .collect()
}

/// 配置原值解析:`${workspaceFolder}` 占位与相对路径
/// (TS `resolveAgainstWorkspace`,`src/workspaceDiscovery.ts:853-856`)。
pub fn resolve_against_workspace(workspace_root: &Path, value: &str) -> PathBuf {
    let with_workspace = if workspace_root
        .as_os_str()
        .to_string_lossy()
        .contains("${workspaceFolder}")
    {
        value.to_string()
    } else {
        value.replace("${workspaceFolder}", &workspace_root.to_string_lossy())
    };
    let p = PathBuf::from(&with_workspace);
    if p.is_absolute() {
        p
    } else {
        workspace_root.join(p)
    }
}

/// ROOT-014 多根注册与归属:注册顺序=优先顺序、最长前缀归属、平台折叠感知。
/// 身份层仍以 kode-vfs `RootId` 为准,发现层不另造身份。
#[derive(Debug)]
pub struct PlatformRootRegistry {
    platform: PlatformTarget,
    roots: Vec<(RootId, RootPath)>,
}

impl PlatformRootRegistry {
    pub fn new(platform: PlatformTarget) -> PlatformRootRegistry {
        PlatformRootRegistry {
            platform,
            roots: Vec::new(),
        }
    }

    /// 注册一个根(注册顺序即优先顺序;重复身份幂等返回既有 id)。
    pub fn register(&mut self, path: &str) -> Result<RootId, crate::platform::RootPathError> {
        let rp = RootPath::parse(path, self.platform)?;
        if let Some((id, _)) = self.roots.iter().find(|(_, r)| r.identity_eq(&rp)) {
            return Ok(*id);
        }
        let id = RootId(self.roots.len() as u32 + 1); // 0 = UNROOTED(VFS-002)
        self.roots.push((id, rp));
        Ok(id)
    }

    pub fn roots(&self) -> &[(RootId, RootPath)] {
        &self.roots
    }

    /// 最长前缀归属(平台折叠感知;无归属 = None,调用方落 UNROOTED)。
    pub fn root_for(&self, path: &RootPath) -> Option<RootId> {
        let mut best: Option<(RootId, usize)> = None;
        for (id, root) in &self.roots {
            let root_s = root.as_path();
            let p = path.as_path();
            let is_prefix = if case_folds(self.platform) {
                let lower_p = p.to_ascii_lowercase();
                let lower_r = root_s.to_ascii_lowercase();
                lower_p.starts_with(&lower_r)
            } else {
                p.starts_with(root_s.as_str())
            };
            if is_prefix {
                let len = root_s.len();
                if best.map(|(_, l)| len > l).unwrap_or(true) {
                    best = Some((*id, len));
                }
            }
        }
        best.map(|(id, _)| id)
    }

    /// 前缀冲突诊断入口(VFS-009 overlapping_roots 同口径)。
    pub fn overlapping(&self, path: &RootPath) -> Vec<RootId> {
        self.roots
            .iter()
            .filter(|(_, root)| {
                if case_folds(self.platform) {
                    path.as_path()
                        .to_ascii_lowercase()
                        .starts_with(&root.as_path().to_ascii_lowercase())
                } else {
                    path.as_path().starts_with(root.as_path().as_str())
                }
            })
            .map(|(id, _)| *id)
            .collect()
    }

    /// 边界类别别名(测试与诊断用)。
    pub fn boundary_kind_label(kind: BoundaryKind) -> &'static str {
        match kind {
            BoundaryKind::Submodule => "submodule",
            BoundaryKind::Vendored => "vendored",
        }
    }
}
