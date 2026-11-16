//! 增量重构注册表:同文件未变零重建 + 依赖索引(书 IDX-003 基础版 / PR-005 要求)。
//!
//! - 复用 kode-vfs 的 [`kode_vfs::parse_cache::ParseCache`](指纹命中即零重建)
//!   与 FNV-1a 内容指纹(VFS-011),不重复造缓存;
//! - 每个文件解析后登记其**符号引用**(类型引用 / Parent 实体 / 组件类型 /
//!   interfaces),反向索引支持"改 types.xml/父 def 后谁受影响"(依赖索引,
//!   PR-007 全量 DAG 的前置);
//! - 文件删除/改名走 `invalidate`,连带清理反向索引。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use kode_vfs::parse_cache::{content_fingerprint, ParseCache};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use crate::diag::Diagnostic;
use crate::model::{
    parse_alias, parse_def, parse_entities, parse_types, AliasFile, DefFile, EntitiesFile,
    TypesFile,
};

/// 单文件解析产物(按文件种类)。
#[derive(Debug, Clone)]
pub enum ParsedUnit {
    Def(DefFile),
    Entities(EntitiesFile),
    Types(TypesFile),
    Alias(AliasFile),
}

impl ParsedUnit {
    pub fn kind(&self) -> &'static str {
        match self {
            ParsedUnit::Def(_) => "def",
            ParsedUnit::Entities(_) => "entities.xml",
            ParsedUnit::Types(_) => "types.xml",
            ParsedUnit::Alias(_) => "alias.xml",
        }
    }
}

/// 单文件登记的引用集(前向依赖声明)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefSet {
    /// 类型引用(types.xml / alias.xml 名字空间)。
    pub type_refs: BTreeSet<String>,
    /// Parent 实体名。
    pub parent_entities: BTreeSet<String>,
    /// 组件类型名(组件 def)。
    pub component_types: BTreeSet<String>,
    /// interfaces 引用的接口 def。
    pub interface_defs: BTreeSet<String>,
    /// entities.xml:登记的实体名(实体 → def 的正向注册)。
    pub registered_entities: BTreeSet<String>,
}

impl RefSet {
    fn names(&self) -> impl Iterator<Item = &String> {
        self.type_refs
            .iter()
            .chain(&self.parent_entities)
            .chain(&self.component_types)
            .chain(&self.interface_defs)
            .chain(&self.registered_entities)
    }
}

/// 文件种类(由 URI 后缀决定;复杂引擎 profile 规则随 PR-006)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Def,
    Entities,
    Types,
    Alias,
    Other,
}

pub fn file_kind_of_uri(uri: &CanonicalUri) -> FileKind {
    let path = uri.as_path();
    if path.ends_with(".def") {
        FileKind::Def
    } else if path.ends_with("entities.xml") {
        FileKind::Entities
    } else if path.ends_with("types.xml") {
        FileKind::Types
    } else if path.ends_with("alias.xml") {
        FileKind::Alias
    } else {
        FileKind::Other
    }
}

/// 单次 update 的回执(ARCH-004:明确告知发生了什么,不静默)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReport {
    /// 本次是否真的重新解析(false = 指纹命中零重建)。
    pub rebuilt: bool,
    /// 解析失败(负缓存)时的原因。
    pub error: Option<String>,
    /// 本次登记的引用数(重建时有效;零重建为 0)。
    pub refs_registered: usize,
}

/// 增量解析注册表。
#[derive(Debug)]
pub struct ParseRegistry {
    cache: ParseCache<ParsedUnit>,
    /// 反向索引:符号名 → 引用它的文件。
    reverse: BTreeMap<String, BTreeSet<DocumentKey>>,
    /// 每文件当前引用集(失效时按差量清理)。
    forward: BTreeMap<DocumentKey, RefSet>,
    /// 实测计数(测试/观测用:零重建断言的依据)。
    pub stats: RegistryStats,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RegistryStats {
    pub update_calls: u64,
    pub rebuilds: u64,
    pub cache_hits: u64,
    pub negative_hits: u64,
    pub failures: u64,
    /// CORE-013:预算驱逐次数(缓存预算启用后观测)。
    pub evictions: u64,
}

impl Default for ParseRegistry {
    fn default() -> Self {
        ParseRegistry {
            cache: ParseCache::new(),
            reverse: BTreeMap::new(),
            forward: BTreeMap::new(),
            stats: RegistryStats::default(),
        }
    }
}

impl ParseRegistry {
    pub fn new() -> ParseRegistry {
        ParseRegistry::default()
    }

    /// CORE-013 基础版:带驻留预算的注册表。预算单位 = 驻留产物自有字符串
    /// 字节(下界代理,非 RSS 直测;RUST-129 实测 def 形态 RSS ≈ 该权重 ×3)。
    /// 超预算按二次机会近似 LRU 驱逐,驱逐后同文档再 update 即重建(缓存丢
    /// 失不丢正确性);`new()` 保持无界,既有调用面零变化。
    pub fn with_resident_budget(max_bytes: u64) -> ParseRegistry {
        ParseRegistry {
            cache: ParseCache::with_budget(max_bytes, resident_weight_of_unit),
            ..ParseRegistry::default()
        }
    }

    /// 驻留预算上限透传(无界 = None;装配观测面用)。
    pub fn resident_budget_bytes(&self) -> Option<u64> {
        self.cache.budget_bytes()
    }

    /// 增量入口:同 (key, fingerprint) 直接回缓存,零重建。
    pub fn update(
        &mut self,
        key: DocumentKey,
        text: &str,
    ) -> (UpdateReport, Option<Arc<ParsedUnit>>) {
        self.stats.update_calls += 1;
        let fingerprint = content_fingerprint(text);
        if let Some(hit) = self.cache.get(&key, fingerprint) {
            self.stats.cache_hits += 1;
            return (
                UpdateReport {
                    rebuilt: false,
                    error: None,
                    refs_registered: 0,
                },
                Some(hit),
            );
        }
        if let Some(reason) = self.cache.get_negative(&key, fingerprint) {
            self.stats.negative_hits += 1;
            return (
                UpdateReport {
                    rebuilt: false,
                    error: Some(reason.to_string()),
                    refs_registered: 0,
                },
                None,
            );
        }

        let kind = file_kind_of_uri(&key.uri);
        let (unit, refs) = match kind {
            FileKind::Def => {
                let def = parse_def(text);
                (
                    ParsedUnit::Def(def.clone()),
                    RefSet {
                        type_refs: def
                            .properties
                            .iter()
                            .flat_map(|p| p.type_refs.iter().cloned())
                            .collect(),
                        parent_entities: def.parent.iter().cloned().collect(),
                        component_types: def
                            .components
                            .iter()
                            .filter_map(|c| c.component_type.clone())
                            .collect(),
                        interface_defs: def.interfaces.iter().cloned().collect(),
                        registered_entities: BTreeSet::new(),
                    },
                )
            }
            FileKind::Entities => {
                let entities = parse_entities(text);
                (
                    ParsedUnit::Entities(entities.clone()),
                    RefSet {
                        registered_entities: entities
                            .entities
                            .iter()
                            .map(|e| e.name.clone())
                            .collect(),
                        ..RefSet::default()
                    },
                )
            }
            FileKind::Types => {
                let types = parse_types(text);
                (
                    ParsedUnit::Types(types.clone()),
                    // types.xml 是类型**定义方**,不进反向引用索引
                    // (dependents_of(name) 语义 = 谁引用了这个名字)。
                    RefSet::default(),
                )
            }
            FileKind::Alias => {
                let alias = parse_alias(text);
                (
                    ParsedUnit::Alias(alias.clone()),
                    // alias.xml 同上:定义方。
                    RefSet::default(),
                )
            }
            FileKind::Other => {
                let reason = "非 KBEngine 声明文件(.def/entities.xml/types.xml/alias.xml 之外)";
                self.stats.failures += 1;
                self.cache.insert_negative(key, fingerprint, reason);
                return (
                    UpdateReport {
                        rebuilt: false,
                        error: Some(reason.to_string()),
                        refs_registered: 0,
                    },
                    None,
                );
            }
        };

        // 失效旧引用 → 登记新引用(差量维护反向索引)。
        if let Some(old) = self.forward.remove(&key) {
            for name in old.names() {
                if let Some(set) = self.reverse.get_mut(name) {
                    set.remove(&key);
                    if set.is_empty() {
                        self.reverse.remove(name);
                    }
                }
            }
        }
        let count = refs.names().count();
        for name in refs.names().cloned().collect::<Vec<_>>() {
            self.reverse.entry(name).or_default().insert(key.clone());
        }
        self.forward.insert(key.clone(), refs);
        self.cache.insert(key, fingerprint, unit.clone());
        self.stats.rebuilds += 1;
        // CORE-013:预算驱逐数镜像进统计(update 末尾折叠,失效路径的下一次
        // update 也会把驱逐带出来)。
        self.stats.evictions = self.cache.evictions();
        (
            UpdateReport {
                rebuilt: true,
                error: None,
                refs_registered: count,
            },
            Some(Arc::new(unit)),
        )
    }

    /// 反向查询:哪些文件引用了符号 `name`(类型/实体/父/组件/接口)。
    pub fn dependents_of(&self, name: &str) -> Vec<DocumentKey> {
        self.reverse
            .get(name)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn refs_of(&self, key: &DocumentKey) -> Option<&RefSet> {
        self.forward.get(key)
    }

    /// 删除/改名失效(VFS-012 对齐)。
    pub fn invalidate(&mut self, key: &DocumentKey) {
        if let Some(old) = self.forward.remove(key) {
            for name in old.names() {
                if let Some(set) = self.reverse.get_mut(name) {
                    set.remove(key);
                    if set.is_empty() {
                        self.reverse.remove(name);
                    }
                }
            }
        }
        self.cache.invalidate(key);
    }

    pub fn clear(&mut self) {
        self.cache.clear();
        self.reverse.clear();
        self.forward.clear();
        self.stats = RegistryStats::default();
    }

    pub fn tracked_files(&self) -> usize {
        self.forward.len()
    }

    /// RUST-125:缓冲活跃通知(打开/编辑触达面)——缓存条目驱逐缓刑一轮。
    /// 语义口径见 [`ParseCache::mark_recent`](缓刑非硬 pin:硬 pin 超预算
    /// 无界驻留违背冷热分层;正编辑文件经 didChange→update 高频重置缓刑,
    /// 长置未动的打开文件缓刑后被逐=诚实冷逐出,请求自带文本即重建)。
    pub fn note_buffer_activity(&mut self, key: &DocumentKey) {
        self.cache.mark_recent(key);
    }

    /// RUST-125:解析驻留观测(健康面 `parseCache` 键同源;预算面三计数 +
    /// 条目数,无界缓存 budget=None 且 resident 恒 0)。
    pub fn parse_cache_stats(&self) -> ParseCacheStats {
        ParseCacheStats {
            budget_bytes: self.cache.budget_bytes(),
            resident_bytes: self.cache.resident_weight(),
            evictions: self.cache.evictions(),
            valid: self.cache.valid_len(),
            negative: self.cache.negative_len(),
        }
    }
}

/// RUST-125:解析驻留观测快照(健康面 `parseCache` 键)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseCacheStats {
    /// 驻留预算上限(字节权重口径;无界缓存 = None)。
    pub budget_bytes: Option<u64>,
    /// 当前有效条目权重合计(无界缓存恒 0,不追踪)。
    pub resident_bytes: u64,
    /// 累计驱逐条目数。
    pub evictions: u64,
    /// 有效(最新快照)条目数。
    pub valid: usize,
    /// 负缓存条目数。
    pub negative: usize,
}

/// CORE-013 预算权重:驻留产物「自有字符串字节」合计 + 每条目 64B 结构
/// 松弛(下界代理,不含堆分配头与对齐;RUST-129 实测该权重 ≈ RSS 的 1/3,
/// 上限换算归调用方)。逐字段遍历,新增字段漏计只影响预算精度不影响正确性。
fn resident_weight_of_unit(unit: &ParsedUnit) -> u64 {
    fn w(text: &str) -> u64 {
        text.len() as u64
    }
    fn opt(text: &Option<String>) -> u64 {
        text.as_ref().map_or(0, |t| t.len() as u64)
    }
    fn diags(diags: &[Diagnostic]) -> u64 {
        const PER_ENTRY: u64 = 64;
        diags.iter().map(|d| w(&d.message) + PER_ENTRY).sum()
    }
    const PER_ENTRY: u64 = 64;
    match unit {
        ParsedUnit::Def(def) => {
            let mut total = opt(&def.root_tag) + opt(&def.parent) + diags(&def.diagnostics);
            total += def.interfaces.iter().map(|t| w(t)).sum::<u64>();
            for p in &def.properties {
                total += PER_ENTRY
                    + w(&p.name)
                    + opt(&p.type_name)
                    + p.type_refs.iter().map(|t| w(t)).sum::<u64>()
                    + opt(&p.flags_raw)
                    + p.flags.iter().map(|t| w(t)).sum::<u64>()
                    + opt(&p.default_value)
                    + opt(&p.detail_level)
                    + opt(&p.database_length)
                    + opt(&p.identifier)
                    + p.extra_tags.iter().map(|(t, _)| w(t)).sum::<u64>();
            }
            for c in &def.components {
                total += PER_ENTRY + w(&c.name) + opt(&c.component_type);
            }
            for methods in [&def.base_methods, &def.cell_methods, &def.client_methods] {
                for m in methods {
                    total += PER_ENTRY + w(&m.name) + m.args.iter().map(|t| w(t)).sum::<u64>();
                }
            }
            total += def.extra_sections.iter().map(|(t, _)| w(t)).sum::<u64>();
            total
        }
        ParsedUnit::Entities(entities) => {
            let mut total = diags(&entities.diagnostics);
            for e in &entities.entities {
                total += PER_ENTRY
                    + w(&e.name)
                    + e.attributes.iter().map(|(k, v)| w(k) + w(v)).sum::<u64>();
            }
            total
        }
        ParsedUnit::Types(types) => {
            let mut total = diags(&types.diagnostics);
            for t in &types.types {
                total += PER_ENTRY
                    + w(&t.name)
                    + opt(&t.directive)
                    + opt(&t.implemented_by_symbol)
                    + t.field_refs.iter().map(|r| w(r)).sum::<u64>()
                    + opt(&t.element_ref);
            }
            total
        }
        ParsedUnit::Alias(alias) => {
            let mut total = diags(&alias.diagnostics);
            for a in &alias.aliases {
                total += PER_ENTRY + w(&a.name) + w(&a.alias_type);
            }
            for (name, attrs) in &alias.attribute_aliases {
                total += PER_ENTRY + w(name) + attrs.iter().map(|(k, v)| w(k) + w(v)).sum::<u64>();
            }
            total
        }
    }
}

/// 便捷构造 DocumentKey(测试/示例用;生产路径 key 由 server 层给)。
pub fn key_for(root: RootId, uri: &str) -> DocumentKey {
    DocumentKey::new(root, CanonicalUri::parse(uri).expect("valid file uri"))
}
