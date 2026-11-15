//! CORE-004 workspace session(基础版):单实例会话 = **唯一根注册表** +
//! **受控共享缓存扇出**。
//!
//! - **单实例**:全部 `RootId` 只能经本会话的根注册表发出(0 恒为
//!   [`RootId::UNROOTED`],永不分配)——结构上不存在第二个发号器,多根会话
//!   仍是一个会话。进程级单例硬闸不做:那会破坏嵌入方组合与测试,单实例
//!   由装配面(server 持有唯一 session)保证。
//! - **根 id 化身隔离**:`remove_root` 走 [`RootRegistry::unregister`],id
//!   永不复用;同一路径撤销后重新注册必得新 id,旧化身的缓存条目绝不可能
//!   被当成新化身的有效身份(撤销时同步扇出清空,双重保证)。
//! - **受控共享缓存**:共享缓存(索引/文档仓库/解析注册表)各持根级失效
//!   入口,本会话把它们登记为 [`RootInvalidationSink`],撤根时按注册序
//!   逐一扇出并给回执([`RootRemoval`],ARCH-004:明确告知每个消费面清了
//!   多少条目);键只能经 [`WorkspaceSession::key_for`] 铸造,根外路径
//!   拒绝(None),绝不给 UNROOTED 铸键——缓存身份永不脱离已注册根。
//!
//! `RootInvalidationSink` 内建实现只覆盖本 crate 依赖面([`SymbolIndex`] /
//! [`DocumentStore`]);解析注册表(PARSE 侧)适配属 server 装配接线,随
//! provider 单接线,不在本基础版范围。

use std::cell::RefCell;
use std::rc::Rc;

use kode_index::SymbolIndex;
use kode_vfs::store::{DocumentKey, DocumentStore, RootId, RootRegistry};
use kode_vfs::uri::CanonicalUri;

/// 受控共享缓存的根级失效面:撤根时由 session 按注册序扇出。
pub trait RootInvalidationSink {
    /// 清除该根的全部驻留条目,返回清除条目数(回执记账用)。
    fn invalidate_root(&mut self, root: RootId) -> usize;
    /// 回执里的消费面身份标签。
    fn sink_name(&self) -> &'static str;
}

impl RootInvalidationSink for SymbolIndex {
    fn invalidate_root(&mut self, root: RootId) -> usize {
        SymbolIndex::invalidate_root(self, root)
    }
    fn sink_name(&self) -> &'static str {
        "symbol-index"
    }
}

impl RootInvalidationSink for DocumentStore {
    fn invalidate_root(&mut self, root: RootId) -> usize {
        DocumentStore::invalidate_root(self, root).len()
    }
    fn sink_name(&self) -> &'static str {
        "document-store"
    }
}

/// 撤根回执(ARCH-004):根 id + 每个消费面清除的条目数(按注册序)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRemoval {
    pub root: RootId,
    pub invalidated: Vec<(&'static str, usize)>,
}

/// 单实例 workspace session(见模块文档)。
#[derive(Default)]
pub struct WorkspaceSession {
    registry: RootRegistry,
    sinks: Vec<Rc<RefCell<dyn RootInvalidationSink>>>,
}

impl std::fmt::Debug for WorkspaceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不打印 sink(可能巨大),只打印根/消费面计数。
        f.debug_struct("WorkspaceSession")
            .field("roots", &self.registry.roots().len())
            .field("sinks", &self.sinks.len())
            .finish()
    }
}

impl WorkspaceSession {
    pub fn new() -> WorkspaceSession {
        WorkspaceSession::default()
    }

    /// 登记一个共享缓存消费面(撤根扇出按登记序);同一实例可重复登记
    /// (每次登记都收到扇出)。返回当前消费面数。
    pub fn register_sink(&mut self, sink: Rc<RefCell<dyn RootInvalidationSink>>) -> usize {
        self.sinks.push(sink);
        self.sinks.len()
    }

    pub fn sink_count(&self) -> usize {
        self.sinks.len()
    }

    /// 注册根(重复注册同一路径幂等,返回既有 id)。
    pub fn add_root(&mut self, path: &str) -> RootId {
        self.registry.register(path)
    }

    /// 撤销根:注册表除名 + 向全部消费面按登记序扇出根级失效。
    /// 未知路径返回 None 且不做任何扇出。
    pub fn remove_root(&mut self, path: &str) -> Option<RootRemoval> {
        let root = self.registry.unregister(path)?;
        let mut invalidated = Vec::new();
        for sink in &self.sinks {
            let mut sink = sink.borrow_mut();
            let cleared = sink.invalidate_root(root);
            invalidated.push((sink.sink_name(), cleared));
        }
        Some(RootRemoval { root, invalidated })
    }

    pub fn roots(&self) -> &[(RootId, String)] {
        self.registry.roots()
    }

    /// URI 归属(最长前缀根胜出;根外 = [`RootId::UNROOTED`])。
    pub fn root_for(&self, uri: &CanonicalUri) -> RootId {
        self.registry.root_for(uri)
    }

    /// 命中该 URI 的全部根(>1 即根冲突,供冲突诊断)。
    pub fn overlapping_roots(&self, uri: &CanonicalUri) -> Vec<RootId> {
        self.registry.overlapping_roots(uri)
    }

    /// 受控铸键入口:根外路径拒绝(None),绝不给 UNROOTED 铸键——
    /// 共享缓存条目身份永不脱离已注册根。
    pub fn key_for(&self, uri: &CanonicalUri) -> Option<DocumentKey> {
        let root = self.registry.root_for(uri);
        if root == RootId::UNROOTED {
            None
        } else {
            Some(DocumentKey::new(root, uri.clone()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_index::SymbolKind;
    use std::cell::RefCell;

    /// 记录扇出调用的假 sink(名可定制,供注册序断言)。
    struct NamedLog {
        name: &'static str,
        calls: Vec<u32>,
        cleared_per_call: usize,
    }
    impl NamedLog {
        fn new(name: &'static str) -> NamedLog {
            NamedLog {
                name,
                calls: Vec::new(),
                cleared_per_call: 1,
            }
        }
    }
    impl RootInvalidationSink for NamedLog {
        fn invalidate_root(&mut self, root: RootId) -> usize {
            self.calls.push(root.0);
            self.cleared_per_call
        }
        fn sink_name(&self) -> &'static str {
            self.name
        }
    }

    fn uri(path: &str) -> CanonicalUri {
        CanonicalUri::from_path(path)
    }

    #[test]
    fn multi_roots_get_distinct_ids_and_unrooted_reserved() {
        let mut session = WorkspaceSession::new();
        let a = session.add_root("/w/alpha");
        let b = session.add_root("/w/beta");
        let a2 = session.add_root("/w/alpha");
        assert_ne!(a, b);
        assert_eq!(a, a2, "重复注册同一路径幂等");
        assert_ne!(a, RootId::UNROOTED);
        assert_ne!(b, RootId::UNROOTED);
    }

    #[test]
    fn remove_root_fans_out_in_registration_order_with_receipt() {
        let mut session = WorkspaceSession::new();
        let root = session.add_root("/w/proj");
        let first = Rc::new(RefCell::new(NamedLog::new("sink-a")));
        let second = Rc::new(RefCell::new(NamedLog::new("sink-b")));
        assert_eq!(session.register_sink(first.clone()), 1);
        assert_eq!(session.register_sink(second.clone()), 2);
        let removal = session.remove_root("/w/proj").expect("已注册根必可撤");
        assert_eq!(removal.root, root);
        assert_eq!(
            removal.invalidated,
            vec![("sink-a", 1), ("sink-b", 1)],
            "回执按注册序列出每个消费面的清除数"
        );
        assert_eq!(first.borrow().calls, vec![root.0]);
        assert_eq!(second.borrow().calls, vec![root.0]);
        // 注册表已除名:同路径再次撤销 = None。
        assert!(session.remove_root("/w/proj").is_none());
    }

    #[test]
    fn remove_unknown_root_is_none_and_does_not_fan_out() {
        let mut session = WorkspaceSession::new();
        session.add_root("/w/real");
        let log = Rc::new(RefCell::new(NamedLog::new("sink")));
        session.register_sink(log.clone());
        assert!(session.remove_root("/w/ghost").is_none());
        assert!(log.borrow().calls.is_empty(), "未知根撤销不得扇出");
    }

    #[test]
    fn key_for_rejects_unrooted_and_mints_registered_key() {
        let mut session = WorkspaceSession::new();
        let root = session.add_root("/w/proj");
        assert!(
            session.key_for(&uri("/elsewhere/x.def")).is_none(),
            "根外路径拒绝铸键"
        );
        let key = session
            .key_for(&uri("/w/proj/entities/Monster.def"))
            .expect("注册根内必可铸键");
        assert_eq!(key.root, root);
        assert_eq!(session.root_for(&uri("/elsewhere/x.def")), RootId::UNROOTED);
    }

    #[test]
    fn incarnation_isolation_fresh_id_after_removal() {
        let mut session = WorkspaceSession::new();
        let first = session.add_root("/w/alpha");
        let key_a = session
            .key_for(&uri("/w/alpha/x.def"))
            .expect("第一化身铸键");
        session.remove_root("/w/alpha").expect("撤根");
        assert!(
            session.key_for(&uri("/w/alpha/x.def")).is_none(),
            "撤根后路径出根"
        );
        let second = session.add_root("/w/alpha");
        assert_ne!(first, second, "id 永不复用:新旧化身隔离");
        let key_b = session
            .key_for(&uri("/w/alpha/x.def"))
            .expect("第二化身铸键");
        assert_ne!(key_a, key_b, "新旧化身缓存身份永不重合");
    }

    #[test]
    fn symbol_index_sink_clears_only_removed_root() {
        let mut session = WorkspaceSession::new();
        let a = session.add_root("/w/alpha");
        let b = session.add_root("/w/beta");
        // 同名实体各根一份:共享缓存里的真隔离考场(实体名取文件 stem)。
        let text = "<root>\n</root>";
        let index = Rc::new(RefCell::new(SymbolIndex::new()));
        index.borrow_mut().update(
            kode_index::DocumentKey::new(a, uri("/w/alpha/Monster.def")),
            text,
        );
        index.borrow_mut().update(
            kode_index::DocumentKey::new(b, uri("/w/beta/Monster.def")),
            text,
        );
        assert_eq!(
            index
                .borrow()
                .lookup_kind("Monster", SymbolKind::Entity)
                .len(),
            2
        );
        session.register_sink(index.clone());
        let removal = session.remove_root("/w/alpha").expect("撤 alpha");
        assert_eq!(removal.invalidated, vec![("symbol-index", 1)]);
        // beta 的同名实体必须幸存:扇出只清被撤根。
        let survivors = index.borrow().lookup_kind("Monster", SymbolKind::Entity);
        assert_eq!(survivors.len(), 1, "只剩 beta 一份");
        assert_eq!(survivors[0].file.root, b, "幸存者必须属于 beta 根");
    }

    #[test]
    fn debug_shows_counts_not_sink_values() {
        let mut session = WorkspaceSession::new();
        session.add_root("/w/alpha");
        session.register_sink(Rc::new(RefCell::new(NamedLog::new("sink-a"))));
        let dbg = format!("{session:?}");
        assert!(dbg.contains("roots: 1"), "{dbg}");
        assert!(dbg.contains("sinks: 1"), "{dbg}");
        assert!(!dbg.contains("sink-a"), "sink 内部不得泄漏进 Debug");
    }
}
