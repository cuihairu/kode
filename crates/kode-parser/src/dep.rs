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
}

/// 便捷构造 DocumentKey(测试/示例用;生产路径 key 由 server 层给)。
pub fn key_for(root: RootId, uri: &str) -> DocumentKey {
    DocumentKey::new(root, CanonicalUri::parse(uri).expect("valid file uri"))
}
