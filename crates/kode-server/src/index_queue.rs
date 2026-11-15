//! RUST-070/071/073:索引刷新队列——hover 语料 ingest 装配线(生产接线)。
//!
//! CORE-005「局部依赖刷新让位直接语义查询」:didOpen/didChange/didClose 的
//! hover 语料 ingest 不再在 stdio 泵线程内联执行(镜像洪水逐文件解析会把
//! 交互帧压在后面),改为入 kode-scheduler 调度队列(DEPENDENCY_UPDATE),
//! 主循环空闲切片 + 请求入口「先刷新所需文件」驱动。CORE-008:同文件同版
//! 本合并、旧版本让位(取消旧队新),一次输入风暴收敛为至多一个待执行任务;
//! CORE-006:有界队列(超限诚实拒绝计数,不静默积压)。执行体取「执行时刻
//! 真相」:overlay 优先(打开文档),回落磁盘,读盘失败=真正逐出(VFS-012
//! 修订同口径)——入队时的 open/change/close 语境不携带,幂等可合并。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use kode_scheduler::model::priority::DEPENDENCY_UPDATE;
use kode_scheduler::scheduler::RunFn;
use kode_scheduler::{EnqueueDecision, Scheduler, SchedulerOptions, TaskKind, TaskSpec};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use crate::hover::HoverEngine;

/// 有界队列上限(CORE-006)。语料量级(千级 def 文件)远低于此;超限拒新
/// 计入 `rejectedQueueFull`(健康面),不静默积压不静默丢失语义——被拒文件
/// 至下次变更前无索引条目,属诚实缺口不装完整。
pub const INDEX_QUEUE_MAX: usize = 8192;

/// 请求入口排水预算(条):freshen 自键 + FIFO 追赶至多 N 条,其余留给
/// 空闲切片——小语料(测试/小仓)单请求即全量就绪,大语料请求不背全量洪水。
pub const REQUEST_DRAIN_BUDGET: usize = 16;

/// 身份键:`root:path`(dedup/freshen/purge 三面同源)。
pub fn identity_of(key: &DocumentKey) -> String {
    format!("{}:{}", key.root.0, key.uri.as_path())
}

/// 索引刷新观测快照(健康面 `ingest` 键同源)。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexQueueSnapshot {
    /// 当前在队条数。
    pub queued: u64,
    /// 累计入队(让位重入队计入)。
    pub enqueued: u64,
    /// 同文件同版本合并(未入队)。
    pub merged: u64,
    /// 过期版本丢弃(新任务比在队旧)。
    pub stale_dropped: u64,
    /// 队列满拒绝。
    pub rejected_queue_full: u64,
    /// 累计执行成功。
    pub executed: u64,
    /// 撤根清除的待执行条目。
    pub purged: u64,
}

/// 索引刷新队列:kode-scheduler 调度核 + 身份台账(pending)。
/// (ServerState 派生 Debug 需要本类型 Debug:观测面走快照,闭包不打印。)
pub struct IndexQueue {
    sched: Scheduler,
    /// identity → (task id, RootId):freshen 指名面 + 撤根 purge 面。
    pending: HashMap<String, (u64, RootId)>,
    /// 执行回执日志:包装闭包完成后推 identity,泵侧对账清台账。
    /// Rc 共享(闭包持有克隆,队列持有原件;单线程 Rc/RefCell 世界)。
    done_log: Rc<RefCell<Vec<String>>>,
    counters: IndexQueueSnapshot,
}

impl std::fmt::Debug for IndexQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexQueue")
            .field("snapshot", &self.snapshot())
            .field("pending", &self.pending.len())
            .finish()
    }
}

impl Default for IndexQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl IndexQueue {
    pub fn new() -> IndexQueue {
        IndexQueue {
            sched: Scheduler::new(SchedulerOptions {
                // CORE-006:有界队列。交互冷却/饥饿晋升属 ≥BACKGROUND_FULL
                // 语义,本队列恒 DEPENDENCY_UPDATE(is_interactive=true),
                // 冷却不适用(如实登记,不假称防饥饿机制在岗)。
                max_queued: Some(INDEX_QUEUE_MAX),
                ..SchedulerOptions::default()
            }),
            pending: HashMap::new(),
            done_log: Rc::new(RefCell::new(Vec::new())),
            counters: IndexQueueSnapshot::default(),
        }
    }

    /// 请求一次索引刷新(时间点无关:执行时按真相重放)。同文件同版本在队
    /// 即合并;新版本让位(旧任务被调度核取消,台账指向新 id);过期丢弃;
    /// 队满诚实拒绝。`run` 由调用方构造(捕获 hover/store 的 Rc 克隆)。
    pub fn request_refresh(
        &mut self,
        key: &DocumentKey,
        version: Option<u64>,
        run: Box<RunFn>,
    ) -> EnqueueDecision {
        let identity = identity_of(key);
        let done_log = Rc::clone(&self.done_log);
        let wrapped: Box<RunFn> = Box::new(move |token| {
            let result = run(token);
            done_log.borrow_mut().push(identity);
            result
        });
        let outcome = self.sched.enqueue(TaskSpec {
            kind: TaskKind::DependencyUpdate,
            priority: DEPENDENCY_UPDATE,
            file: Some(identity_of(key)),
            version,
            target: None,
            run: wrapped,
        });
        let identity = identity_of(key);
        match outcome.decision {
            EnqueueDecision::Queued => {
                self.pending.insert(identity, (outcome.id, key.root));
                self.counters.enqueued += 1;
            }
            EnqueueDecision::Merged => {
                self.counters.merged += 1;
            }
            EnqueueDecision::StaleDropped => {
                self.counters.stale_dropped += 1;
            }
            EnqueueDecision::RejectedQueueFull => {
                self.counters.rejected_queue_full += 1;
            }
        }
        outcome.decision
    }

    /// 泵切片:至多执行 `max_tasks` 条,返回实际执行数(Ran 计)。
    pub fn pump_budgeted(&mut self, max_tasks: usize) -> usize {
        let mut ran = 0;
        while ran < max_tasks {
            match self.sched.pump_once() {
                kode_scheduler::Pump::Ran => {
                    ran += 1;
                    self.settle_done();
                }
                _ => break,
            }
        }
        ran
    }

    /// 请求所需文件先刷新(打开文档小范围交互 > 局部刷新):该键有待执行
    /// 任务则立即插队执行,返回是否执行。
    pub fn freshen(&mut self, identity: &str) -> bool {
        let id = match self.pending.get(identity) {
            Some(&(id, _)) => id,
            None => return false,
        };
        let ran = self.sched.promote_and_run(id);
        if ran {
            self.settle_done();
        }
        ran
    }

    /// 撤根扇出:该根的待执行刷新全部摘除(RUST-069-W 撤根清缓存语义的
    /// 队列侧延伸——撤根后残留刷新任务会把旧根语料重新灌回=复活缺陷)。
    pub fn purge_root(&mut self, root: RootId) -> usize {
        let doomed: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, (_, r))| *r == root)
            .map(|(identity, _)| identity.clone())
            .collect();
        let mut purged = 0;
        for identity in &doomed {
            if let Some(&(id, _)) = self.pending.get(identity) {
                if self.sched.cancel(id, "root removed") {
                    self.pending.remove(identity);
                    purged += 1;
                }
            }
        }
        self.counters.purged += purged as u64;
        purged
    }

    /// 观测快照(健康面同源)。
    pub fn snapshot(&self) -> IndexQueueSnapshot {
        IndexQueueSnapshot {
            queued: self.sched.status().queued as u64,
            ..self.counters
        }
    }

    /// 执行回执对账:已完成的 identity 出台账。
    fn settle_done(&mut self) {
        for identity in self.done_log.borrow_mut().drain(..) {
            if self.pending.remove(&identity).is_some() {
                self.counters.executed += 1;
            }
        }
    }
}

/// 构造刷新执行体(捕获 hover/store 的 Rc 克隆;执行时刻真相重放):
/// overlay 优先(打开文档未保存修订不被盘上快照冲掉),回落磁盘,读盘失败
/// =真正逐出(close ≠ 删除,VFS-012 修订同口径)。
pub fn ingest_refresh_task(
    store: Rc<RefCell<kode_vfs::DocumentStore>>,
    hover: Rc<RefCell<HoverEngine>>,
    key: DocumentKey,
) -> Box<RunFn> {
    Box::new(move |_token| {
        if let Some((_, buffer)) = store.borrow().open_buffer(&key) {
            let text = buffer.text().to_string();
            hover.borrow_mut().update(key, &text);
        } else {
            match std::fs::read_to_string(key.uri.as_path()) {
                Ok(text) => hover.borrow_mut().update(key, &text),
                Err(_) => {
                    hover.borrow_mut().remove(&key);
                }
            }
        }
        Ok(())
    })
}

/// 从 uri 重放 DocumentKey(执行侧不需要;入队侧统一走 session.root_for)。
/// 保留为独立函数以便测试构造与将来 watch 下沉复用。
pub fn replay_key(root: RootId, path: &str) -> Option<DocumentKey> {
    CanonicalUri::parse(path)
        .ok()
        .map(|uri| DocumentKey::new(root, uri))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::uri::CanonicalUri;

    fn key(root: u32, path: &str) -> DocumentKey {
        DocumentKey::new(RootId(root), CanonicalUri::from_path(path))
    }

    fn noop_run() -> Box<RunFn> {
        Box::new(|_token| Ok(()))
    }

    #[test]
    fn same_file_same_version_merges_and_never_double_counts() {
        let mut q = IndexQueue::new();
        let k = key(1, "/w/A.def");
        assert_eq!(
            q.request_refresh(&k, Some(3), noop_run()),
            EnqueueDecision::Queued
        );
        assert_eq!(
            q.request_refresh(&k, Some(3), noop_run()),
            EnqueueDecision::Merged
        );
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.enqueued, snap.merged), (1, 1, 1));
    }

    #[test]
    fn newer_version_displaces_and_older_version_is_stale_dropped() {
        let mut q = IndexQueue::new();
        let k = key(1, "/w/A.def");
        assert_eq!(
            q.request_refresh(&k, Some(1), noop_run()),
            EnqueueDecision::Queued
        );
        // 新版本让位:旧任务取消,新任务入队,台账指向新 id。
        assert_eq!(
            q.request_refresh(&k, Some(2), noop_run()),
            EnqueueDecision::Queued
        );
        // 过期版本丢弃:比在队旧,不入队。
        assert_eq!(
            q.request_refresh(&k, Some(1), noop_run()),
            EnqueueDecision::StaleDropped
        );
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.stale_dropped), (1, 1));
        // 排水只执行一次(风暴收敛=至多一个待执行)。
        assert_eq!(q.pump_budgeted(16), 1);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.executed), (0, 1));
    }

    #[test]
    fn freshen_runs_named_key_first_and_reports_miss() {
        let mut q = IndexQueue::new();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        q.request_refresh(&a, Some(1), noop_run());
        q.request_refresh(&b, Some(1), noop_run());
        // 指名后入队者立即执行(插队)。
        let ident_b = identity_of(&b);
        assert!(q.freshen(&ident_b));
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.executed), (1, 1));
        // 未在队键 false 不动作。
        assert!(!q.freshen("9:/w/none.def"));
        // 其余照常切片排水。
        assert_eq!(q.pump_budgeted(16), 1);
        assert_eq!(q.snapshot().executed, 2);
    }

    #[test]
    fn pump_budget_caps_slice_size() {
        let mut q = IndexQueue::new();
        for i in 0..5 {
            q.request_refresh(&key(1, &format!("/w/F{i}.def")), Some(1), noop_run());
        }
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.snapshot().queued, 3);
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.pump_budgeted(2), 1);
        assert_eq!(q.snapshot().queued, 0);
    }

    #[test]
    fn purge_root_drops_only_that_roots_pending_tasks() {
        let mut q = IndexQueue::new();
        let keep = key(1, "/w/A.def");
        let drop = key(2, "/w/B.def");
        q.request_refresh(&keep, Some(1), noop_run());
        q.request_refresh(&drop, Some(1), noop_run());
        assert_eq!(q.purge_root(RootId(2)), 1);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.purged), (1, 1));
        // 执行剩余:被 purge 的键不执行。
        assert_eq!(q.pump_budgeted(16), 1);
        let snap = q.snapshot();
        assert_eq!((snap.executed, snap.purged), (1, 1));
    }

    #[test]
    fn queue_full_rejects_new_work_and_counts_honestly() {
        let mut q = IndexQueue::new();
        // 有界队列(CORE-006):超过上限的新工作诚实拒绝(计数),不静默积压。
        for i in 0..INDEX_QUEUE_MAX {
            assert_eq!(
                q.request_refresh(&key(1, &format!("/w/F{i}.def")), Some(1), noop_run()),
                EnqueueDecision::Queued
            );
        }
        assert_eq!(
            q.request_refresh(&key(1, "/w/overflow.def"), Some(1), noop_run()),
            EnqueueDecision::RejectedQueueFull
        );
        let snap = q.snapshot();
        assert_eq!(
            (snap.queued, snap.rejected_queue_full),
            (INDEX_QUEUE_MAX as u64, 1)
        );
    }

    #[test]
    fn ingest_refresh_task_replays_time_of_execution_truth() {
        // 执行时刻真相:入队时无 overlay,执行时打开 → 取 overlay 文本;
        // 全程未打开 → 读盘;盘上也无 → 逐出。真盘临时 def 文件验证,
        // 索引面以 symbol_count 变化为证(def 语料入库才有符号)。
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE_AND_CLIENT </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));

        let mut q = IndexQueue::new();
        // 未打开:执行读盘 → def 语料入库(symbol_count > 0)。
        q.request_refresh(
            &k,
            Some(1),
            ingest_refresh_task(Rc::clone(&store), Rc::clone(&hover), k.clone()),
        );
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "盘上 def 文件应入索引"
        );

        // 关闭且盘上仍在:回落磁盘(不逐出)。
        store.borrow_mut().close(&k);
        q.request_refresh(
            &k,
            None,
            ingest_refresh_task(Rc::clone(&store), Rc::clone(&hover), k.clone()),
        );
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "关闭后盘上文件仍应喂补全/悬停"
        );

        // 删除盘上文件 + 关闭态:执行=真正逐出(symbol_count 回 0)。
        std::fs::remove_file(&path).unwrap();
        q.request_refresh(
            &k,
            None,
            ingest_refresh_task(Rc::clone(&store), Rc::clone(&hover), k.clone()),
        );
        assert_eq!(q.pump_budgeted(4), 1);
        assert_eq!(hover.borrow().index.symbol_count(), 0, "盘上已删除应逐出");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
