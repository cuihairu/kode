//! 符号索引:名称倒排 + 文件级增量 + 原子 generation(书 §7 基础版,PR-007)。
//!
//! - 复用 kode-parser [`ParseRegistry`](kode_parser::dep):指纹命中零重建
//!   (VFS-011 ParseCache + FNV-1a,IDX-003/004 基础版)+ 反向依赖索引
//!   (IDX-002 基础版),本层不重复造缓存与指纹;
//! - 名称倒排 `name → 槽位集`(IDX-006:定向 lookup / 前缀 workspace_symbols,
//!   绝不 O(文件数) 扫描);
//! - 文件级增量单元 `DocumentKey → 符号槽位表`:改一个文件只重登记该文件
//!   的符号,其余文件的槽位与倒排原样保留(IDX-013 断言「仅影响相关文件」
//!   的实测依据,rebuild 计数见 [`IndexStats`]);
//! - [`SymbolIndex::update_batch`] 批量提交后一次性递增 generation(IDX-007
//!   原子 generation 基础版);删除/改名 [`SymbolIndex::remove`] 连带清理
//!   倒排/反向索引/继承边(IDX-014);根级 scoped 失效
//!   [`SymbolIndex::invalidate_root`](IDX-015);
//! - 继承链查询委托 kode-parser `resolve_parent_chain`:环显式诊断、有限
//!   截断,绝不死循环(IDX-005 终止保障,SEM-004)。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use kode_parser::dep::{file_kind_of_uri, FileKind, ParseRegistry, ParsedUnit};
use kode_parser::diag::Diagnostic;
use kode_parser::model::{resolve_parent_chain, ChainNode};
use kode_vfs::store::{DocumentKey, RootId};

use crate::symbol::{extract_records, Symbol, SymbolId, SymbolKind, SymbolRecord};

/// 实测计数(增量零重建断言与 pr-007.md 报告的依据)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    /// update/update_batch 入口调用次数(按文件计)。
    pub update_calls: u64,
    /// 实际重登记符号的文件次数(指纹未命中才 +1;期望值 = 真实改动文件数)。
    pub rebuilds: u64,
    /// 指纹命中零重建次数。
    pub cache_hits: u64,
    /// remove/invalidate_root 清理的文件次数。
    pub removals: u64,
    /// generation 递增次数(批量提交只 +1)。
    pub generation_bumps: u64,
}

/// 单文件 update 回执(ARCH-004:明确告知发生了什么)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexUpdateReport {
    /// false = 指纹命中,符号零重建。
    pub rebuilt: bool,
    /// 非声明文件等原因(该文件不产符号)。
    pub error: Option<String>,
    /// 本次新登记符号数(重建时有效)。
    pub added: usize,
    /// 本次被替换掉的旧符号数(重建时有效)。
    pub removed: usize,
    /// 应用后的 generation。
    pub generation: u64,
}

/// 批量提交回执(IDX-007:整批一个 generation)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchReceipt {
    pub generation: u64,
    /// 批内文件数。
    pub files: usize,
    /// 批内真实重建的文件数(指纹命中不计)。
    pub rebuilds: u64,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Default, Clone)]
struct FileEntry {
    symbols: Vec<SymbolId>,
}

/// 符号索引。
#[derive(Debug)]
pub struct SymbolIndex {
    registry: ParseRegistry,
    slots: Vec<Option<Symbol>>,
    free: Vec<SymbolId>,
    /// 名称倒排:name → 持有该名的槽位集(IDX-006)。
    by_name: BTreeMap<String, BTreeSet<SymbolId>>,
    /// 文件级增量单元:file → 该文件符号槽位表(保文档序)。
    by_file: BTreeMap<DocumentKey, FileEntry>,
    /// 继承边:def 实体名 → Parent(IDX-002 基础版;链查询 IDX-005)。
    entity_parents: HashMap<String, String>,
    generation: u64,
    pub stats: IndexStats,
}

impl Default for SymbolIndex {
    fn default() -> Self {
        SymbolIndex {
            registry: ParseRegistry::new(),
            slots: Vec::new(),
            free: Vec::new(),
            by_name: BTreeMap::new(),
            by_file: BTreeMap::new(),
            entity_parents: HashMap::new(),
            generation: 0,
            stats: IndexStats::default(),
        }
    }
}

impl SymbolIndex {
    pub fn new() -> SymbolIndex {
        SymbolIndex::default()
    }

    /// 单文件增量入口:指纹命中零重建(不 bump generation)。
    pub fn update(&mut self, key: DocumentKey, text: &str) -> IndexUpdateReport {
        self.stats.update_calls += 1;
        let (registry_report, unit) = self.registry.update(key.clone(), text);
        if !registry_report.rebuilt {
            self.stats.cache_hits += 1;
            return IndexUpdateReport {
                rebuilt: false,
                error: registry_report.error,
                added: 0,
                removed: 0,
                generation: self.generation,
            };
        }
        let (added, removed) = self.replace_file(&key, unit.as_deref());
        self.stats.rebuilds += 1;
        self.bump();
        IndexUpdateReport {
            rebuilt: true,
            error: registry_report.error,
            added,
            removed,
            generation: self.generation,
        }
    }

    /// 批量提交:全部文件应用完成后一次性递增 generation(IDX-007)。
    pub fn update_batch(&mut self, batch: &[(DocumentKey, String)]) -> BatchReceipt {
        let before_rebuilds = self.stats.rebuilds;
        let mut added = 0usize;
        let mut removed = 0usize;
        for (key, text) in batch {
            self.stats.update_calls += 1;
            let (registry_report, unit) = self.registry.update(key.clone(), text);
            if !registry_report.rebuilt {
                self.stats.cache_hits += 1;
                continue;
            }
            let (a, r) = self.replace_file(key, unit.as_deref());
            added += a;
            removed += r;
            self.stats.rebuilds += 1;
        }
        let rebuilds = self.stats.rebuilds - before_rebuilds;
        // 零改动的空批不递增 generation(与单文件语义一致,读者快照不失效)。
        if rebuilds > 0 {
            self.bump();
        }
        BatchReceipt {
            generation: self.generation,
            files: batch.len(),
            rebuilds,
            added,
            removed,
        }
    }

    /// 删除/改名失效(VFS-012/IDX-014):符号、倒排、反向依赖、继承边连带清理。
    /// 返回移除的符号数。改名 = remove(old) + update(new)。
    pub fn remove(&mut self, key: &DocumentKey) -> usize {
        let removed = self.detach_file(key);
        self.registry.invalidate(key);
        if removed > 0 {
            self.stats.removals += 1;
            self.bump();
        }
        removed
    }

    /// 根级 scoped 失效(IDX-015):只触该根文件,不扫全仓。返回移除符号数。
    pub fn invalidate_root(&mut self, root: RootId) -> usize {
        let keys: Vec<DocumentKey> = self
            .by_file
            .keys()
            .filter(|k| k.root == root)
            .cloned()
            .collect();
        let mut removed = 0usize;
        for key in &keys {
            removed += self.detach_file(key);
            self.registry.invalidate(key);
        }
        if removed > 0 {
            self.stats.removals += 1;
            self.bump();
        }
        removed
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 名称定向查找(IDX-006;结果按 name/kind/file/line 确定性排序)。
    pub fn lookup(&self, name: &str) -> Vec<Symbol> {
        self.ids_of_name(name)
            .into_iter()
            .filter_map(|id| self.slots[id].clone())
            .collect()
    }

    /// 名称 + 种类定向查找。
    pub fn lookup_kind(&self, name: &str, kind: SymbolKind) -> Vec<Symbol> {
        self.ids_of_name(name)
            .into_iter()
            .filter_map(|id| self.slots[id].clone())
            .filter(|s| s.kind == kind)
            .collect()
    }

    /// 前缀扫描(workspace symbol;`prefix` 空串 = 全部;`limit` 0 = 不限)。
    /// 走 BTreeMap 有序范围,不线性扫描符号总数。
    pub fn workspace_symbols(&self, prefix: &str, limit: usize) -> Vec<Symbol> {
        let mut out = Vec::new();
        for (name, ids) in self.by_name.range(prefix.to_string()..) {
            if !name.starts_with(prefix) {
                break;
            }
            for id in ids {
                if let Some(sym) = self.slots[*id].as_ref() {
                    out.push(sym.clone());
                }
                if limit > 0 && out.len() >= limit {
                    out.sort();
                    return out;
                }
            }
        }
        out.sort();
        out
    }

    /// 文件内符号(文档序;文件级增量的观察口)。
    pub fn symbols_in_file(&self, key: &DocumentKey) -> Vec<Symbol> {
        self.by_file
            .get(key)
            .map(|entry| {
                entry
                    .symbols
                    .iter()
                    .filter_map(|id| self.slots[*id].clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 反向依赖:哪些文件引用了符号 `name`(类型/Parent/组件/接口/注册;
    /// 复用 parser RefSet,IDX-002 基础版)。
    pub fn dependents_of(&self, name: &str) -> Vec<DocumentKey> {
        self.registry.dependents_of(name)
    }

    /// 实体继承链(IDX-005:环显式诊断并截断,有限步终止)。
    pub fn entity_chain(&self, entity: &str) -> (Vec<ChainNode>, Option<Diagnostic>) {
        resolve_parent_chain(entity, &self.entity_parents)
    }

    pub fn symbol_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }

    pub fn tracked_files(&self) -> usize {
        self.by_file.len()
    }

    /// 已登记继承边的实体清单(观测/测试用)。
    pub fn entity_declarations(&self) -> &HashMap<String, String> {
        &self.entity_parents
    }

    // ---- 内部:文件级差量替换 ----

    /// 摘除旧符号 → 装入新符号。返回 (added, removed)。
    fn replace_file(&mut self, key: &DocumentKey, unit: Option<&ParsedUnit>) -> (usize, usize) {
        let removed = self.detach_file(key);
        let Some(unit) = unit else {
            return (0, removed);
        };
        let (records, declaration) = extract_records(key, unit);
        let added = records.len();
        let mut entry = FileEntry::default();
        for record in records {
            let id = self.attach_record(key, record);
            entry.symbols.push(id);
        }
        if let Some((entity, Some(parent))) = declaration {
            self.entity_parents.insert(entity, parent);
        }
        self.by_file.insert(key.clone(), entry);
        (added, removed)
    }

    /// 摘除一个文件的全部符号(差量清倒排,槽位回收)。返回摘除数。
    fn detach_file(&mut self, key: &DocumentKey) -> usize {
        let Some(entry) = self.by_file.remove(key) else {
            return 0;
        };
        for id in &entry.symbols {
            if let Some(sym) = self.slots[*id].take() {
                if let Some(set) = self.by_name.get_mut(&sym.name) {
                    set.remove(id);
                    if set.is_empty() {
                        self.by_name.remove(&sym.name);
                    }
                }
                self.free.push(*id);
            }
        }
        // 继承边跟随 def 文件摘除(改名/删除即失效,IDX-014)。
        if file_kind_of_uri(&key.uri) == FileKind::Def {
            if let Some(entity) = crate::symbol::def_entity_name(key.uri.as_path()) {
                self.entity_parents.remove(&entity);
            }
        }
        entry.symbols.len()
    }

    fn attach_record(&mut self, key: &DocumentKey, record: SymbolRecord) -> SymbolId {
        let id = match self.free.pop() {
            Some(id) => id,
            None => {
                self.slots.push(None);
                self.slots.len() - 1
            }
        };
        let name = record.name.clone();
        self.slots[id] = Some(Symbol {
            id,
            name,
            kind: record.kind,
            file: key.clone(),
            line: record.line,
            facet: record.facet,
            detail: record.detail,
        });
        self.by_name.entry(record.name).or_default().insert(id);
        id
    }

    fn bump(&mut self) {
        self.generation += 1;
        self.stats.generation_bumps += 1;
    }

    fn ids_of_name(&self, name: &str) -> Vec<SymbolId> {
        self.by_name
            .get(name)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }
}
