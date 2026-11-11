//! BAS-08 带版本查询快照。
//!
//! 文档 overlay 与版本语义由 [`kode_vfs::store::DocumentStore`](VFS-003) 承载
//! (本模块不重造);本层在其上提供**语义事实的版本化快照库**:每个文档至多
//! 一槽 `(version, facts)`,过期构建(版本低于槽内版本)**不得覆盖**新版本,
//! 删除/重开文档清理对应事实,工程视图 = [`SnapshotStore::fold`] 对全部
//! 槽的确定性折叠(工程代数)。
//!
//! 版本来源契约:构建方从 VFS 快照取 `version`(打开文档为 overlay 版本,
//! 磁盘文档无版本 → 由调用方定基线,见 [`Build`] 说明),连同推导出的事实
//! 一起 [`SnapshotStore::commit`]。查询只读当前槽,不重扫全仓。

use std::collections::HashMap;

use kode_vfs::store::DocumentKey;

use super::snapshot::DefResolver;
use kode_parser::model::DefFile;

/// 一次构建产物:事实 + 计算所依据的文档版本。
///
/// `version` 来源契约:
/// - 打开文档:VFS overlay 的 `version`(didChange 严格递增,与 VFS-003 同源);
/// - 磁盘文档:VFS 快照 `version` 为 `None`——由调用方给定统一基线
///   (如 `0`),保证同一文档的过期磁盘构建同样被拒。
#[derive(Debug, Clone)]
pub struct Build<T> {
    pub key: DocumentKey,
    pub version: i64,
    pub facts: T,
}

impl<T> Build<T> {
    pub fn new(key: DocumentKey, version: i64, facts: T) -> Self {
        Self { key, version, facts }
    }
}

/// 提交裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitVerdict {
    /// 已采纳(新版本或同版本幂等重算;槽更新)。
    Accepted,
    /// 过期构建被拒(版本低于现有;现有事实保留)。
    Stale { current: i64, incoming: i64 },
}

/// 删除/重开清理回执(供下游失效传播)。
#[derive(Debug, Clone)]
pub struct RemovedFacts<T> {
    pub key: DocumentKey,
    pub version: i64,
    pub facts: T,
}

/// 带版本语义事实快照库(每文档一槽)。
///
/// 不变量:
/// - 每文档至多一槽,槽内版本单调不降([`commit`](SnapshotStore::commit) 拒绝
///   过期,接受 `>=`);
/// - 过期构建不覆盖新版本;同版本重算接受(幂等重导);
/// - [`remove`](SnapshotStore::remove) 清槽,重开文档后旧事实不残留。
#[derive(Debug)]
pub struct SnapshotStore<T> {
    slots: HashMap<DocumentKey, (i64, T)>,
}

impl<T> Default for SnapshotStore<T> {
    fn default() -> Self {
        Self { slots: HashMap::new() }
    }
}

impl<T> SnapshotStore<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// 提交构建产物:过期版本被拒并保留现有;新版本(或同版本重算)采纳。
    pub fn commit(&mut self, build: Build<T>) -> CommitVerdict {
        match self.slots.get(&build.key) {
            Some((cur, _)) if build.version < *cur => CommitVerdict::Stale {
                current: *cur,
                incoming: build.version,
            },
            _ => {
                self.slots.insert(build.key.clone(), (build.version, build.facts));
                CommitVerdict::Accepted
            }
        }
    }

    /// 查询当前事实(无登记 → None;查询即当前槽,不重扫)。
    pub fn get(&self, key: &DocumentKey) -> Option<&T> {
        self.slots.get(key).map(|(_, f)| f)
    }

    /// 当前版本(无登记 → None)。
    pub fn version_of(&self, key: &DocumentKey) -> Option<i64> {
        self.slots.get(key).map(|(v, _)| *v)
    }

    /// 文档删除/关闭:清槽,返回被清事实(下游据此传播失效)。
    pub fn remove(&mut self, key: &DocumentKey) -> Option<RemovedFacts<T>> {
        self.slots.remove(key).map(|(version, facts)| RemovedFacts { key: key.clone(), version, facts })
    }

    /// 全清(工程/工作区关闭)。
    pub fn clear(&mut self) {
        self.slots.clear();
    }

    /// 已登记文档数。
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// 工程代数:确定性折叠全部槽(折叠顺序 = 文档键升序,保证同输入同输出;
    /// 组合子由调用方给,单文档内事实合并策略亦由调用方定)。
    pub fn fold<'a, A>(&'a self, init: A, mut f: impl FnMut(A, &'a DocumentKey, &'a T) -> A) -> A {
        let mut keys: Vec<&DocumentKey> = self.slots.keys().collect();
        keys.sort();
        let mut acc = init;
        for k in keys {
            let (_, facts) = &self.slots[k];
            acc = f(acc, k, facts);
        }
        acc
    }
}

/// def 文档的实体/类型名(KBEngine 约定:def 文件名去扩展名 = 类型名,
/// 大小写敏感;`.def` 之外的后缀按 basename 原样)。
pub fn def_name_from_key(key: &DocumentKey) -> String {
    let b = key.uri.basename();
    match b.rsplit_once('.') {
        Some((stem, "def")) => stem.to_string(),
        _ => b.to_string(),
    }
}

/// 工程级 def 解析器:跨全部文档槽解析类型名(工程代数的具体面)。
///
/// 解析规则:def 文档按 [`def_name_from_key`] 得类型名,与请求名相等即命中;
/// 多槽同名的解析序 = 文档键升序(确定性,取首个;冲突裁决由快照层
/// [`super::snapshot`] 的 conflicts 记录承担,此处不任取)。
#[derive(Debug)]
pub struct ProjectDefResolver<'a> {
    store: &'a SnapshotStore<DefFile>,
}

impl<'a> ProjectDefResolver<'a> {
    pub fn new(store: &'a SnapshotStore<DefFile>) -> Self {
        Self { store }
    }
}

impl DefResolver for ProjectDefResolver<'_> {
    fn resolve(&self, name: &str) -> Option<&DefFile> {
        let mut keys: Vec<&DocumentKey> = self.store.slots.keys().collect();
        keys.sort();
        keys.into_iter()
            .find(|k| def_name_from_key(k) == name)
            .and_then(|k| self.store.slots.get(k))
            .map(|(_, d)| d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::store::RootId;
    use kode_vfs::uri::CanonicalUri;

    fn key(uri: &str) -> DocumentKey {
        DocumentKey::new(RootId(1), CanonicalUri::from_path(uri))
    }

    fn def() -> DefFile {
        DefFile {
            root_tag: Some("root".into()),
            parent: None,
            interfaces: vec![],
            volatile: false,
            properties: vec![],
            components: vec![],
            base_methods: vec![],
            cell_methods: vec![],
            client_methods: vec![],
            extra_sections: vec![],
            diagnostics: vec![],
        }
    }

    #[test]
    fn commit_then_get_returns_facts() {
        let mut s = SnapshotStore::new();
        let k = key("/defs/avatar.def");
        assert_eq!(s.commit(Build::new(k.clone(), 1, "v1")), CommitVerdict::Accepted);
        assert_eq!(s.get(&k), Some(&"v1"));
        assert_eq!(s.version_of(&k), Some(1));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn stale_build_rejected_keeps_current() {
        let mut s = SnapshotStore::new();
        let k = key("/defs/avatar.def");
        s.commit(Build::new(k.clone(), 2, "v2"));
        // 过期构建(v1 < v2)被拒,现有 v2 保留。
        assert_eq!(
            s.commit(Build::new(k.clone(), 1, "stale")),
            CommitVerdict::Stale { current: 2, incoming: 1 }
        );
        assert_eq!(s.get(&k), Some(&"v2"), "过期不得覆盖新版本");
        assert_eq!(s.version_of(&k), Some(2));
    }

    #[test]
    fn equal_version_recompute_accepted() {
        let mut s = SnapshotStore::new();
        let k = key("/defs/avatar.def");
        s.commit(Build::new(k.clone(), 3, "first"));
        // 同版本幂等重算接受(同文本重导)。
        assert_eq!(s.commit(Build::new(k.clone(), 3, "recomputed")), CommitVerdict::Accepted);
        assert_eq!(s.get(&k), Some(&"recomputed"));
    }

    #[test]
    fn remove_clears_slot_and_returns_facts() {
        let mut s = SnapshotStore::new();
        let k = key("/defs/avatar.def");
        s.commit(Build::new(k.clone(), 5, "facts"));
        let removed = s.remove(&k).expect("清槽返回被清事实");
        assert_eq!(removed.version, 5);
        assert_eq!(removed.facts, "facts");
        assert_eq!(s.get(&k), None, "删除后事实清理");
        assert_eq!(s.version_of(&k), None);
        assert!(s.is_empty());
        // 重开后可重新提交,不残留旧事实。
        assert_eq!(s.commit(Build::new(k.clone(), 1, "fresh")), CommitVerdict::Accepted);
        assert_eq!(s.get(&k), Some(&"fresh"));
    }

    #[test]
    fn clear_empties_all() {
        let mut s = SnapshotStore::new();
        s.commit(Build::new(key("/defs/a.def"), 1, 1));
        s.commit(Build::new(key("/defs/b.def"), 1, 2));
        s.clear();
        assert!(s.is_empty());
    }

    #[test]
    fn fold_composes_deterministically() {
        let mut s = SnapshotStore::new();
        s.commit(Build::new(key("/defs/b.def"), 1, 2));
        s.commit(Build::new(key("/defs/a.def"), 1, 1));
        // 折叠序 = 键升序(a 先),求和确定性。
        let sum = s.fold(0, |acc, _k, v| acc + v);
        assert_eq!(sum, 3);
        let order = s.fold(Vec::new(), |mut acc, k, v| {
            acc.push((k.uri.as_path().to_string(), *v));
            acc
        });
        assert_eq!(order[0].1, 1, "键升序:a 先");
        assert_eq!(order[1].1, 2);
    }

    #[test]
    fn def_name_from_key_uses_stem() {
        assert_eq!(def_name_from_key(&key("/defs/Avatar.def")), "Avatar");
        assert_eq!(def_name_from_key(&key("/defs/a/b/Health.def")), "Health");
        assert_eq!(def_name_from_key(&key("/types/Pos.txt")), "Pos.txt");
    }

    #[test]
    fn project_resolver_resolves_across_docs() {
        let mut s = SnapshotStore::new();
        s.commit(Build::new(key("/defs/Avatar.def"), 1, def()));
        s.commit(Build::new(key("/defs/Monster.def"), 1, def()));
        let r = ProjectDefResolver::new(&s);
        assert!(r.resolve("Avatar").is_some(), "跨文档解析命中");
        assert!(r.resolve("Monster").is_some());
        assert!(r.resolve("NoSuch").is_none(), "未知类型诚实 None");
    }

    #[test]
    fn project_resolver_same_name_first_by_key_order() {
        let mut s = SnapshotStore::new();
        // 同名 def 存于两文档(键序 z 后于 a)。
        s.commit(Build::new(key("/defs/a/X.def"), 1, def()));
        s.commit(Build::new(key("/defs/z/X.def"), 1, def()));
        let r = ProjectDefResolver::new(&s);
        assert!(r.resolve("X").is_some(), "同名冲突取键序首个,不任取");
    }
}
