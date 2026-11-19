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

use kode_parser::dep::{file_kind_of_uri, FileKind, ParseCacheStats, ParseRegistry};
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
    /// RUST-120-W:重解析但签名事实全等(body-only)被差异化跳过的次数
    /// (不换槽位、不 bump generation,读者快照全部存活)。
    pub body_only_skips: u64,
}

/// 变化类别(RUST-120-W 差异化失效的判定产物):
/// - [`ChangeCategory::Identical`] 文本未变(指纹命中,零重建零失效);
/// - [`ChangeCategory::BodyOnly`] 文本变了但签名事实(records+Parent+引用集)
///   全等——索引态零变异、generation 不 bump,持有快照的读者全部不失效;
/// - [`ChangeCategory::Signature`] 签名事实变了——重登记 + bump。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeCategory {
    Identical,
    BodyOnly,
    Signature,
}

impl ChangeCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChangeCategory::Identical => "identical",
            ChangeCategory::BodyOnly => "body-only",
            ChangeCategory::Signature => "signature",
        }
    }
}

/// 单文件 update 回执(ARCH-004:明确告知发生了什么)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexUpdateReport {
    /// false = 指纹命中,符号零重建。
    pub rebuilt: bool,
    /// 非声明文件等原因(该文件不产符号)。
    pub error: Option<String>,
    /// RUST-120-W:变化类别(Identical/BodyOnly/Signature)。
    pub change: ChangeCategory,
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
    /// 批内真实重登记的文件数(指纹命中与 body-only 跳过不计)。
    pub rebuilds: u64,
    /// 批内 body-only 差异化跳过数(RUST-120-W;不触发 generation bump)。
    pub body_only: u64,
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
    /// 继承边:(根, def 实体名) → Parent(IDX-002 基础版;链查询 IDX-005)。
    /// 跨根同名实体的边互不覆盖、互不串链(KODE-FULL-017)。
    entity_parents: HashMap<(RootId, String), String>,
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

    /// CORE-013 基础版:解析层驻留预算的索引。预算单位 = 驻留解析产物自有
    /// 字符串字节(下界代理,非 RSS 直测;RUST-129 实测 def 形态 RSS ≈ 该
    /// 权重 ×3)。超预算按二次机会近似 LRU 驱逐,被驱逐文件再 update 即
    /// 重建(缓存丢失不丢正确性);`new()` 保持无界,既有行为零变化。
    pub fn with_parse_budget(max_bytes: u64) -> SymbolIndex {
        SymbolIndex {
            registry: ParseRegistry::with_resident_budget(max_bytes),
            ..SymbolIndex::default()
        }
    }

    /// 解析驻留预算上限透传(无界 = None;装配观测面用)。
    pub fn parse_budget_bytes(&self) -> Option<u64> {
        self.registry.resident_budget_bytes()
    }

    /// RUST-125:缓冲活跃通知(打开/编辑触达面)——解析缓存条目驱逐缓刑
    /// 一轮(缓刑非硬 pin,口径见 kode-parser ParseRegistry::note_buffer_
    /// activity)。打开事件由队列装配面调用;didChange 经 update 自身触达。
    pub fn note_buffer_activity(&mut self, key: &DocumentKey) {
        self.registry.note_buffer_activity(key);
    }

    /// RUST-125:解析驻留观测(健康面 `parseCache` 键同源)。
    pub fn parse_cache_stats(&self) -> ParseCacheStats {
        self.registry.parse_cache_stats()
    }

    /// RUST-133:解析失败文件全量枚举(索引缺口 partial 面)——注册表
    /// 负缓存委托,按 (root, 路径) 字典序。
    pub fn negative_entries(&self) -> Vec<(DocumentKey, String)> {
        self.registry.negative_entries()
    }

    /// RUST-133:文件是否已入库(tracked 判定,per-URI 缺口裁定面;
    /// by_file 直查,不枚举符号)。
    pub fn tracks(&self, key: &DocumentKey) -> bool {
        self.by_file.contains_key(key)
    }

    /// RUST-133:文件是否被解析注册表知晓(tracked 判定的完整口径——
    /// 解析成功但零符号的文件 by_file 为空,tracks 会误判 unindexed;
    /// 注册表前向表对每个成功解析文件都有登记,失败/非声明文件没有)。
    pub fn known_to_registry(&self, key: &DocumentKey) -> bool {
        self.registry.refs_of(key).is_some()
    }

    /// 单文件增量入口(RUST-120-W 差异化失效):指纹命中 = Identical 零重建
    /// 零失效;重解析后签名事实(records + Parent + 引用集)全等 = BodyOnly,
    /// 索引态零变异、generation 不 bump——持有快照的读者全部存活;事实有变
    /// = Signature 才重登记 + bump。解析缓存被 LRU 驱逐时旧引用集取不到 =
    /// 保守按 Signature(宁多失效绝不漏报),旧 records 为空的首次入库不受
    /// 此保守项影响。
    pub fn update(&mut self, key: DocumentKey, text: &str) -> IndexUpdateReport {
        self.stats.update_calls += 1;
        let (rebuilt, change, error, added, removed) = self.ingest_classified(&key, text);
        match change {
            ChangeCategory::Identical => self.stats.cache_hits += 1,
            ChangeCategory::BodyOnly => self.stats.body_only_skips += 1,
            ChangeCategory::Signature => {
                self.stats.rebuilds += 1;
                self.bump();
            }
        }
        let _ = rebuilt;
        IndexUpdateReport {
            rebuilt: rebuilt || change != ChangeCategory::Identical,
            error,
            change,
            added,
            removed,
            generation: self.generation,
        }
    }

    /// 批量提交:全部文件应用完成后一次性递增 generation(IDX-007);分类后
    /// 仅 Signature 触发 bump(RUST-120-W:纯 Identical/BodyOnly 批读者快照
    /// 全部不失效)。
    pub fn update_batch(&mut self, batch: &[(DocumentKey, String)]) -> BatchReceipt {
        let before_rebuilds = self.stats.rebuilds;
        let before_body_only = self.stats.body_only_skips;
        let mut added = 0usize;
        let mut removed = 0usize;
        for (key, text) in batch {
            self.stats.update_calls += 1;
            let (_rebuilt, change, _error, a, r) = self.ingest_classified(key, text);
            match change {
                ChangeCategory::Identical => self.stats.cache_hits += 1,
                ChangeCategory::BodyOnly => self.stats.body_only_skips += 1,
                ChangeCategory::Signature => self.stats.rebuilds += 1,
            }
            added += a;
            removed += r;
        }
        let rebuilds = self.stats.rebuilds - before_rebuilds;
        let body_only = self.stats.body_only_skips - before_body_only;
        // 零签名变化的批不递增 generation(读者快照不失效;与单文件语义一致)。
        if rebuilds > 0 {
            self.bump();
        }
        BatchReceipt {
            generation: self.generation,
            files: batch.len(),
            rebuilds,
            added,
            removed,
            body_only,
        }
    }

    /// 分类 ingest 核心(不动 stats/generation;调用方按类别记账):指纹命中
    /// → Identical;重解析后旧新签名事实全等 → BodyOnly(索引态零变异);
    /// 否则 Signature(差量替换)。旧事实在注册表更新前抓取(旧引用集经
    /// `refs_of`;旧 records 由槽位重构,零额外驻留;旧 Parent 经继承边表)。
    fn ingest_classified(
        &mut self,
        key: &DocumentKey,
        text: &str,
    ) -> (bool, ChangeCategory, Option<String>, usize, usize) {
        let old_refs = self.registry.refs_of(key).cloned();
        let old_records: Vec<SymbolRecord> = self
            .symbols_in_file(key)
            .iter()
            .map(|s| SymbolRecord {
                name: s.name.clone(),
                kind: s.kind,
                line: s.line,
                facet: s.facet,
                detail: s.detail.clone(),
            })
            .collect();
        let old_parent = crate::symbol::def_entity_name(key.uri.as_path())
            .and_then(|entity| self.entity_parents.get(&(key.root, entity)).cloned());
        let had_old_records = self.by_file.contains_key(key);
        let (registry_report, unit) = self.registry.update(key.clone(), text);
        if !registry_report.rebuilt {
            return (
                false,
                ChangeCategory::Identical,
                registry_report.error,
                0,
                0,
            );
        }
        let Some(unit) = unit.as_deref() else {
            // 无解析产物(非声明文件等负缓存路径):摘旧符号,保守 Signature。
            let removed = self.detach_file(key);
            return (
                true,
                ChangeCategory::Signature,
                registry_report.error,
                0,
                removed,
            );
        };
        let (new_records, declaration) = extract_records(key, unit);
        let new_refs = self.registry.refs_of(key).cloned();
        let new_parent = declaration.as_ref().and_then(|(_, p)| p.clone());
        // 旧引用集缺席且旧文件确有记录 = 解析缓存被驱逐,旧引用事实未知 →
        // 保守 Signature(多失效不漏报);首次入库(无旧记录)不在此列。
        let refs_known = old_refs.is_some() || !had_old_records;
        let body_only = refs_known
            && new_records == old_records
            && new_parent == old_parent
            && new_refs == old_refs;
        if body_only {
            return (true, ChangeCategory::BodyOnly, registry_report.error, 0, 0);
        }
        let (added, removed) = self.replace_file_with_records(key, &new_records, declaration);
        (
            true,
            ChangeCategory::Signature,
            registry_report.error,
            added,
            removed,
        )
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

    /// CORE-014 一致快照读:捕获当前 generation 并返回只读查询视图。
    ///
    /// 快照存活期间,`&mut` 变更路径(update/update_batch/remove/
    /// invalidate_root)被借用检查器**编译期拒绝**——读写不一致(定义与
    /// 引用来自不同 generation)在本核内结构性不可能。响应绑定面:装配层
    /// 把 `generation()` 钉在响应上,晚到旧代结果用 [`SymbolIndex::is_current`]
    /// 判旧即弃(绝不发布)。
    pub fn read_snapshot(&self) -> IndexSnapshot<'_> {
        IndexSnapshot {
            index: self,
            generation: self.generation,
        }
    }

    /// 陈旧响应检测:`generation` 是否仍是当前代际。晚到旧代结果
    /// (generation 落后)必须丢弃,不得覆盖新代视图(ARCH-005)。
    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
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

    /// 实体继承链(IDX-005:环显式诊断并截断,有限步终止)。继承边按根
    /// 隔离(KODE-FULL-017):他根同名实体的 Parent 边不参与本根链解析。
    pub fn entity_chain(&self, root: RootId, entity: &str) -> (Vec<ChainNode>, Option<Diagnostic>) {
        resolve_parent_chain(entity, &self.scoped_parents(root))
    }

    pub fn symbol_count(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }

    pub fn tracked_files(&self) -> usize {
        self.by_file.len()
    }

    /// 已登记继承边的实体清单(观测/测试用;按根隔离,KODE-FULL-017)。
    pub fn entity_declarations_in(&self, root: RootId) -> HashMap<String, String> {
        self.scoped_parents(root)
    }

    /// 单根继承边视图:name → Parent(链解析/观测共用同一隔离口径)。
    fn scoped_parents(&self, root: RootId) -> HashMap<String, String> {
        self.entity_parents
            .iter()
            .filter(|((r, _), _)| *r == root)
            .map(|((_, entity), parent)| (entity.clone(), parent.clone()))
            .collect()
    }

    // ---- 内部:文件级差量替换 ----

    // (RUST-120-W 起 None 臂由 ingest_classified 直接走 detach_file,
    //  旧分发壳 replace_file 删除。)

    /// 已抽取记录的装入(records/declaration 由分类路径抽取过,免二次抽取)。
    fn replace_file_with_records(
        &mut self,
        key: &DocumentKey,
        records: &[SymbolRecord],
        declaration: Option<(String, Option<String>)>,
    ) -> (usize, usize) {
        let removed = self.detach_file(key);
        let added = records.len();
        let mut entry = FileEntry::default();
        for record in records {
            let id = self.attach_record(key, record.clone());
            entry.symbols.push(id);
        }
        if let Some((entity, Some(parent))) = declaration {
            self.entity_parents.insert((key.root, entity), parent);
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
        // 继承边跟随 def 文件摘除(改名/删除即失效,IDX-014);按
        // (根, 实体) 摘,他根同名实体的边不受牵连(KODE-FULL-017)。
        if file_kind_of_uri(&key.uri) == FileKind::Def {
            if let Some(entity) = crate::symbol::def_entity_name(key.uri.as_path()) {
                self.entity_parents.remove(&(key.root, entity));
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

/// CORE-014 一致快照读视图(见 [`SymbolIndex::read_snapshot`])。
#[derive(Debug)]
pub struct IndexSnapshot<'a> {
    index: &'a SymbolIndex,
    generation: u64,
}

impl IndexSnapshot<'_> {
    /// 捕获时点的 generation(响应绑定与陈旧检测的判定值)。
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 名称查找(转发 [`SymbolIndex::lookup`],同确定性排序)。
    pub fn lookup(&self, name: &str) -> Vec<Symbol> {
        self.index.lookup(name)
    }

    /// 名称+种类定向查找。
    pub fn lookup_kind(&self, name: &str, kind: SymbolKind) -> Vec<Symbol> {
        self.index.lookup_kind(name, kind)
    }

    /// 文件内符号。
    pub fn symbols_in_file(&self, key: &DocumentKey) -> Vec<Symbol> {
        self.index.symbols_in_file(key)
    }

    /// 反向受影响集。
    pub fn dependents_of(&self, name: &str) -> Vec<DocumentKey> {
        self.index.dependents_of(name)
    }

    /// 符号总数。
    pub fn symbol_count(&self) -> usize {
        self.index.symbol_count()
    }
}

#[cfg(test)]
mod tests {
    use kode_vfs::store::{DocumentKey, RootId};
    use kode_vfs::uri::CanonicalUri;

    use super::{ChangeCategory, SymbolIndex};

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(RootId(1), CanonicalUri::from_path(path))
    }

    // ---- CORE-014 一致快照读 ----

    #[test]
    fn snapshot_captures_generation_and_queries_frozen_view() {
        let mut index = SymbolIndex::new();
        let text = "<root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</root>\n";
        index.update(key("/proj/A.def"), text);
        index.update(key("/proj/B.def"), text);
        let gen = index.generation();
        {
            let snapshot = index.read_snapshot();
            assert_eq!(snapshot.generation(), gen, "快照钉住捕获时点代际");
            assert_eq!(snapshot.lookup("hp").len(), 2, "只读视图照常可查");
            assert_eq!(snapshot.symbol_count(), index.symbol_count());
            // 借用检查器结构性保证:snapshot 存活期间 update/remove/
            // update_batch/invalidate_root 等 &mut 路径编译期拒绝(读写
            // 不一致在核内不可能);作用域结束借用即终止。
        }
        index.update(key("/proj/C.def"), text);
        // 捕获代际已陈旧:is_current 识别旧代,晚到旧代结果必须丢弃。
        assert!(!index.is_current(gen), "变更后旧代必须被判陈旧");
        assert!(index.is_current(index.generation()));
    }

    #[test]
    fn zero_rebuild_update_does_not_bump_generation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), "<root>\n</root>\n");
        let gen = index.generation();
        // 同键同文本:指纹命中零重建,generation 不动(改文档既定语义)。
        let report = index.update(k.clone(), "<root>\n</root>\n");
        assert!(!report.rebuilt);
        assert_eq!(index.generation(), gen, "零重建不 bump generation");
        assert!(index.is_current(gen));
    }

    #[test]
    fn stale_generation_rejects_late_results() {
        let mut index = SymbolIndex::new();
        index.update(key("/proj/A.def"), "<root>\n</root>\n");
        let pinned = index.generation();
        // 模拟装配层把 pinned 钉在响应上,期间索引又被推进一代。
        index.update(key("/proj/B.def"), "<root>\n</root>\n");
        // 晚到响应携 pinned:判旧 → 调用方必须丢弃,不得覆盖新代视图。
        assert!(!index.is_current(pinned));
        assert_eq!(index.generation(), pinned + 1);
    }

    /// 摘除契约(原 replace_file(key, None) 面):只摘旧符号、零新增,返回
    /// (added=0, removed=旧符号数),倒排/继承边/by_file 连带清理。生产路径
    /// update/update_batch 只在 registry rebuilt 时传 Some,该分支按函数自身
    /// 契约直接验证(unit 级精度)。
    #[test]
    fn replace_file_with_none_unit_only_detaches_old_symbols() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/entities/Avatar.def");
        let text = "<root>\n  <Parent>Base</Parent>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </hp>\n  </Properties>\n  <BaseMethods>\n    <onRpc>\n      <Arg>UINT32</Arg>\n    </onRpc>\n  </BaseMethods>\n</root>\n";
        let report = index.update(k.clone(), text);
        assert!(report.rebuilt);
        assert_eq!(index.symbol_count(), 3, "Avatar.def = 实体 + hp + onRpc");
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Avatar")
                .map(String::as_str),
            Some("Base"),
            "带 Parent 的 def 先登记继承边"
        );

        let removed = index.detach_file(&k);
        assert_eq!(removed, 3, "摘除旧文件全部符号,零新增");
        assert_eq!(index.symbol_count(), 0);
        assert!(index.symbols_in_file(&k).is_empty(), "文件摘除后符号表清空");
        assert!(index.lookup("hp").is_empty(), "倒排连带清空");
        assert!(index.lookup("onRpc").is_empty());
        assert_eq!(index.tracked_files(), 0, "by_file 条目摘除");
        assert!(
            !index.entity_declarations_in(k.root).contains_key("Avatar"),
            ".def 继承边跟随摘除(IDX-014)"
        );
    }

    #[test]
    fn parse_budget_preserves_lookup_correctness() {
        // 预算 1B:任何产物都超限,插入即驱逐——最保守形态下查询面必须完好。
        let mut index = SymbolIndex::with_parse_budget(1);
        let mut keys = Vec::new();
        for i in 0..5 {
            let k = DocumentKey::new(
                RootId(1),
                CanonicalUri::from_path(&format!("/w/entities/E{i}.def")),
            );
            keys.push(k.clone());
            index.update(k, "<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>");
        }
        // 全部被驱逐:符号表仍有各文件产物(符号层独立于解析缓存),lookup 正常。
        let found = index.lookup("hp");
        assert_eq!(found.len(), 5, "符号层不受解析缓存驱逐影响");
        // 被驱逐文件再 update:重建(解析层缓存丢失面),符号结果不双份。
        let report = index.update(
            keys[2].clone(),
            "<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>",
        );
        assert!(report.rebuilt, "被驱逐条目必须重建");
        let again = index.lookup("hp");
        assert_eq!(again.len(), 5, "重建后符号不重复");
    }

    // ---- RUST-120-W 变化分类差异化失效 ----

    fn def_with_property(dtype: &str) -> String {
        format!(
            "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> {dtype} </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n"
        )
    }

    #[test]
    fn parse_cache_stats_forward_budget_resident_and_evictions() {
        // 无界构造:budget None、resident 恒 0(不追踪)。
        let stats = SymbolIndex::new().parse_cache_stats();
        assert_eq!(stats.budget_bytes, None);
        assert_eq!(stats.resident_bytes, 0);
        assert_eq!(stats.evictions, 0);
        // 有预算构造:budget 透传;入库后 resident/valid 增长。
        let mut index = SymbolIndex::with_parse_budget(4096);
        let stats = index.parse_cache_stats();
        assert_eq!(stats.budget_bytes, Some(4096));
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let stats = index.parse_cache_stats();
        assert!(stats.resident_bytes > 0, "入库后驻留权重必须增长");
        assert_eq!(stats.valid, 1);
        assert_eq!(stats.negative, 0);
        // 极小预算:插入即逐(单条目超限),驱逐计数透传;触达无效条目
        // =零操作不 panic。
        let mut tiny = SymbolIndex::with_parse_budget(1);
        tiny.update(key("/proj/T.def"), &def_with_property("UINT32"));
        assert!(tiny.parse_cache_stats().evictions >= 1);
        tiny.note_buffer_activity(&key("/proj/ghost.def"));
    }

    #[test]
    fn identical_text_reports_identical_and_keeps_generation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let report = index.update(k.clone(), &def_with_property("UINT32"));
        assert_eq!(report.change, ChangeCategory::Identical);
        assert!(!report.rebuilt);
        assert_eq!(index.generation(), gen, "指纹命中零失效");
        assert_eq!(index.stats.body_only_skips, 0);
    }

    #[test]
    fn body_only_trailing_comment_skips_bump_and_mutation() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let records_before = index.symbols_in_file(&k).len();
        // 尾注不位移任何已捕获元素的行号:模型全等 → BodyOnly(索引态零变异)。
        let body_only_text = format!(
            "{}<!-- trailing comment, model identical -->\n",
            def_with_property("UINT32")
        );
        let report = index.update(k.clone(), &body_only_text);
        assert_eq!(report.change, ChangeCategory::BodyOnly, "尾注 = body-only");
        assert!(report.rebuilt, "文本确实变了(重解析发生)");
        assert_eq!((report.added, report.removed), (0, 0), "索引态零变异");
        assert_eq!(index.generation(), gen, "body-only 不 bump,读者快照全存活");
        assert!(index.is_current(gen));
        assert_eq!(index.symbols_in_file(&k).len(), records_before);
        assert_eq!(index.stats.body_only_skips, 1);
    }

    #[test]
    fn property_type_change_is_signature_and_bumps() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        let gen = index.generation();
        let report = index.update(k.clone(), &def_with_property("UINT64"));
        assert_eq!(report.change, ChangeCategory::Signature);
        assert_eq!(index.generation(), gen + 1, "签名变化才 bump");
        // 实体文件级符号 + hp 属性 = 2 条全量重登记。
        assert_eq!((report.added, report.removed), (2, 2));
        let hp = index.lookup("hp");
        assert_eq!(hp.len(), 1);
        assert_eq!(hp[0].detail.as_deref(), Some("UINT64"), "新类型已入索引");
    }

    #[test]
    fn parent_change_is_signature_via_declaration_face() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/Boss.def");
        let v1 = "<root>\n\t<Parent> Monster </Parent>\n</root>\n";
        index.update(k.clone(), v1);
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Boss")
                .map(String::as_str),
            Some("Monster")
        );
        let gen = index.generation();
        // 尾注版:records 与引用集均等,唯 Parent 变 → 声明面判 Signature。
        let v2 = "<root>\n\t<Parent> Dragon </Parent>\n</root>\n";
        let report = index.update(k.clone(), v2);
        assert_eq!(
            report.change,
            ChangeCategory::Signature,
            "Parent 变 = 签名事实变"
        );
        assert_eq!(index.generation(), gen + 1);
        assert_eq!(
            index
                .entity_declarations_in(k.root)
                .get("Boss")
                .map(String::as_str),
            Some("Dragon"),
            "继承边同步更新"
        );
    }

    #[test]
    fn interfaces_only_change_is_signature_via_reference_face() {
        let mut index = SymbolIndex::new();
        let k = key("/proj/C.def");
        index.update(k.clone(), "<root>\n</root>\n");
        let gen = index.generation();
        // records(records 空)与 Parent(无)均等,唯 interface_defs 引用变
        // → RefSet 引用面判 Signature。
        let v2 = "<root>\n\t<Interfaces>\n\t\t<interface> BaseInterface </interface>\n\t</Interfaces>\n</root>\n";
        let report = index.update(k.clone(), v2);
        assert_eq!(
            report.change,
            ChangeCategory::Signature,
            "接口引用变 = 引用集变"
        );
        assert_eq!(index.generation(), gen + 1);
        let deps = index.dependents_of("BaseInterface");
        assert!(deps.contains(&k), "反向依赖面登记新引用");
    }

    #[test]
    fn evicted_parse_reparse_still_classifies_body_only() {
        // 解析缓存被驱逐(极小预算,单条目超限即逐 + 第二文件挤占)后同文本
        // 再 update:指纹未命中重解析发生,但引用表独立于解析缓存生存 → 旧
        // 签名事实仍可得 → 判 BodyOnly,读者快照不因缓存驱逐被误失效。
        // (ingest_classified 的"旧引用集缺席保守 Signature"守卫为防御纵深
        // ——今日公共 API 不可达:refs 表只在 remove/invalidate_root 连带
        // 清理,而那两路同时摘 records。)
        let mut index = SymbolIndex::with_parse_budget(1);
        let k = key("/proj/A.def");
        index.update(k.clone(), &def_with_property("UINT32"));
        // 挤占:插入 B 把 A 的解析缓存逐出(符号层不受影响)。
        index.update(key("/proj/B.def"), &def_with_property("UINT16").repeat(20));
        let gen = index.generation();
        let rebuilds_before = index.stats.rebuilds;
        let report = index.update(k.clone(), &def_with_property("UINT32"));
        assert_eq!(report.change, ChangeCategory::BodyOnly, "重解析但事实全等");
        assert!(report.rebuilt, "驱逐后指纹未命中,重解析确实发生");
        assert_eq!(
            index.stats.rebuilds, rebuilds_before,
            "body-only 不计重登记(零索引态变异)"
        );
        assert_eq!(index.stats.body_only_skips, 1);
        assert_eq!(index.generation(), gen, "事实全等不失效读者");
    }

    #[test]
    fn batch_with_only_identical_and_body_only_never_bumps() {
        let mut index = SymbolIndex::new();
        let a = key("/proj/A.def");
        let b = key("/proj/B.def");
        index.update(a.clone(), &def_with_property("UINT32"));
        index.update(b.clone(), &def_with_property("UINT16"));
        let gen = index.generation();
        // 同文本(Identical)+ 尾注(BodyOnly):零签名变化 → 不 bump。
        let body_only_b = format!("{}<!-- note -->\n", def_with_property("UINT16"));
        let receipt = index.update_batch(&[
            (a.clone(), def_with_property("UINT32")),
            (b.clone(), body_only_b),
        ]);
        assert_eq!(receipt.rebuilds, 0, "零 Signature 重登记");
        assert_eq!(receipt.body_only, 1, "BodyOnly 计入回执");
        assert_eq!(
            index.generation(),
            gen,
            "纯 Identical/BodyOnly 批不失效读者"
        );
    }

    #[test]
    fn batch_bumps_once_for_any_signature_change() {
        let mut index = SymbolIndex::new();
        let a = key("/proj/A.def");
        let b = key("/proj/B.def");
        index.update(a.clone(), &def_with_property("UINT32"));
        index.update(b.clone(), &def_with_property("UINT16"));
        let gen = index.generation();
        let receipt = index.update_batch(&[
            (a.clone(), def_with_property("UINT64")),
            (b.clone(), def_with_property("UINT16")),
        ]);
        assert_eq!(receipt.rebuilds, 1);
        assert_eq!(receipt.body_only, 0);
        assert_eq!(index.generation(), gen + 1, "整批一次 bump");
        assert_eq!(index.lookup("hp")[0].detail.as_deref(), Some("UINT64"));
    }
}
