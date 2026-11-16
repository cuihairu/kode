//! RUST-070/071/073:索引刷新队列——hover 语料 ingest 装配线(生产接线)。
//! RUST-082:didChange debounce 风暴缓冲(时间窗合并 + max latency)。
//!
//! CORE-005「局部依赖刷新让位直接语义查询」:didOpen/didChange/didClose 的
//! hover 语料 ingest 不再在 stdio 泵线程内联执行(镜像洪水逐文件解析会把
//! 交互帧压在后面),改为入 kode-scheduler 调度队列(DEPENDENCY_UPDATE),
//! 主循环空闲切片 + 请求入口「先刷新所需文件」驱动。CORE-008:同文件同版
//! 本合并、旧版本让位(取消旧队新),一次输入风暴收敛为至多一个待执行任务;
//! CORE-006:有界队列(超限诚实拒绝计数,不静默积压)。执行体取「执行时刻
//! 真相」:overlay 优先(打开文档),回落磁盘,读盘失败=真正逐出(VFS-012
//! 修订同口径)——入队时的 open/change/close 语境不携带,幂等可合并。
//!
//! RUST-082(CORE-017):didChange 先入 StormBuffer 时间窗(同文件并一/
//! 最新版本胜出),窗口到期(≤ max latency)或缓冲超限才整批移交调度队列
//! ——连续敲键不再逐版本入队执行;didOpen/didClose 不过窗(open=交互即时
//! 需求,close=状态转移),请求入口对该文件缓冲立即移交(take_file)保
//! 「打开文档请求即新鲜」。delete/create 语义=执行时刻真相(盘上无→逐出、
//! 盘上有→回读)天然合并,无独立 watch 面(诚实边界,不假称 fs-watch 在岗)。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use kode_scheduler::model::priority::DEPENDENCY_UPDATE;
use kode_scheduler::scheduler::RunFn;
use kode_scheduler::{
    EnqueueDecision, Scheduler, SchedulerOptions, StormBuffer, TaskKind, TaskSpec,
};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

use kode_index::ChangeCategory;

use crate::hover::HoverEngine;

/// 有界队列上限(CORE-006)。语料量级(千级 def 文件)远低于此;超限拒新
/// 计入 `rejectedQueueFull`(健康面),不静默积压不静默丢失语义——被拒文件
/// 至下次变更前无索引条目,属诚实缺口不装完整。
pub const INDEX_QUEUE_MAX: usize = 8192;

/// 请求入口排水预算(条):freshen 自键 + FIFO 追赶至多 N 条,其余留给
/// 空闲切片——小语料(测试/小仓)单请求即全量就绪,大语料请求不背全量洪水。
pub const REQUEST_DRAIN_BUDGET: usize = 16;

/// didChange debounce 时间窗(CORE-017 max latency):窗口内同文件多版本
/// 并一,窗口到期整批移交——最坏延迟 = 窗口时长,连续输入下至多每窗一批
/// (延迟有界,绝不无限推迟)。
pub const DID_CHANGE_DEBOUNCE_MS: u64 = 300;

/// 风暴缓冲文件数上限:超限先强制落批(延迟换吞吐的诚实界——极端风暴下
/// 不积压、不限延迟到无限,先保住旧批进队列)。
pub const STORM_BUFFER_MAX_FILES: usize = 512;

/// 身份键:`root:path`(dedup/freshen/purge/风暴缓冲四面同源)。
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
    /// RUST-082:风暴缓冲累计收到事件。
    pub storm_seen: u64,
    /// RUST-082:风暴缓冲并一掉的事件。
    pub storm_merged: u64,
    /// RUST-082:当前缓冲中的文件数。
    pub storm_buffered: u64,
    /// RUST-082:窗口到期整批移交次数(max latency 兑现记账)。
    pub storm_deadline_flushes: u64,
    /// RUST-082:缓冲超限强制落批次数。
    pub storm_forced_flushes: u64,
    /// RUST-120-W:ingest 判类 identical(指纹命中,索引态零变异)。
    pub ingest_identical: u64,
    /// RUST-120-W:ingest 判类 body-only(注册事实全等,视图零写不 bump)。
    pub ingest_body_only: u64,
    /// RUST-120-W:ingest 判类 signature(重灌视图 + bump)。
    pub ingest_signature: u64,
    /// RUST-120-W:执行时刻真相逐出(盘上无文件)。
    pub ingest_removed: u64,
}

/// RUST-120-W:分类失效计数(执行体在执行时刻记账;队列持有原件,闭包
/// 持有克隆;单线程 Rc/RefCell 世界,done_log 同模式)。字段由
/// [`record_ingest`] 记账,读经 [`IndexQueue::snapshot`]。
#[derive(Debug, Default)]
pub struct IngestCounts {
    identical: u64,
    body_only: u64,
    signature: u64,
    removed: u64,
}

fn record_ingest(counts: &Rc<RefCell<IngestCounts>>, change: ChangeCategory) {
    let mut c = counts.borrow_mut();
    match change {
        ChangeCategory::Identical => c.identical += 1,
        ChangeCategory::BodyOnly => c.body_only += 1,
        ChangeCategory::Signature => c.signature += 1,
    }
}

/// 索引刷新队列:kode-scheduler 调度核 + 身份台账(pending)+ 风暴缓冲。
pub struct IndexQueue {
    sched: Scheduler,
    /// identity → (task id, RootId):freshen 指名面 + 撤根 purge 面。
    pending: HashMap<String, (u64, RootId)>,
    /// 执行回执日志:包装闭包完成后推 identity,泵侧对账清台账。
    /// Rc 共享(闭包持有克隆,队列持有原件;单线程 Rc/RefCell 世界)。
    done_log: Rc<RefCell<Vec<String>>>,
    counters: IndexQueueSnapshot,
    /// RUST-120-W:分类失效计数(闭包执行时刻记账,snapshot 合并)。
    ingest_counts: Rc<RefCell<IngestCounts>>,
    /// RUST-082:didChange 风暴缓冲(时间窗合并;核心 record 的内部超限
    /// 强制 flush 会静默丢弃返回值,包装侧恒在 record 前预排水,绝不触发)。
    storm: StormBuffer,
    /// identity → RootId:缓冲事件移交时重建 DocumentKey 用。
    storm_roots: HashMap<String, RootId>,
    /// 窗口到期时刻(首事件落窗时置位;缓冲清空后复位)。
    storm_deadline: Option<Instant>,
    /// 引擎句柄(入队时构建执行时刻真相执行体)。
    store: Rc<RefCell<kode_vfs::DocumentStore>>,
    hover: Rc<RefCell<HoverEngine>>,
}

impl std::fmt::Debug for IndexQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexQueue")
            .field("snapshot", &self.snapshot())
            .field("pending", &self.pending.len())
            .finish()
    }
}

impl IndexQueue {
    pub fn new(
        store: Rc<RefCell<kode_vfs::DocumentStore>>,
        hover: Rc<RefCell<HoverEngine>>,
    ) -> IndexQueue {
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
            ingest_counts: Rc::new(RefCell::new(IngestCounts::default())),
            storm: StormBuffer::new(STORM_BUFFER_MAX_FILES),
            storm_roots: HashMap::new(),
            storm_deadline: None,
            store,
            hover,
        }
    }

    /// didOpen:语料 ingest 立即入队(open=交互即时需求,不过风暴窗)。
    /// 同文件同版本在队即合并;新版本让位(旧任务被调度核取消,台账指向
    /// 新 id);过期丢弃;队满诚实拒绝。
    pub fn request_open(&mut self, key: &DocumentKey, version: u64) -> EnqueueDecision {
        self.enqueue_refresh(key, Some(version))
    }

    /// RUST-125:打开事件触达解析缓存(驱逐缓刑一轮)——「当前打开文件
    /// 优先」的索引侧兑现。编辑面由 didChange→update 自然触达;长置未动
    /// 的打开文件缓刑后被逐=诚实冷逐出(缓刑非硬 pin,超预算不无界驻留)。
    pub fn note_buffer_open(&self, key: &DocumentKey) {
        self.hover.borrow_mut().index.note_buffer_activity(key);
    }

    /// didClose:刷新入队(version=None 与 Some 不同键,close 后必让位重
    /// 入队,不合并;执行时刻真相决定回读磁盘还是逐出)。
    pub fn request_close(&mut self, key: &DocumentKey) -> EnqueueDecision {
        self.enqueue_refresh(key, None)
    }

    /// didChange:入风暴缓冲(时间窗合并;同文件并一/最新版本胜出)。
    /// 返回是否与缓冲内同文件事件合并。缓冲超限先强制落批(移交调度队列),
    /// 绝不让核心 record 的内部 flush 静默吞事件。
    pub fn record_change(&mut self, key: &DocumentKey, version: u64) -> bool {
        // 预排水:缓冲将满先整批移交(延迟换吞吐的诚实界)。
        if self.storm.buffered() >= STORM_BUFFER_MAX_FILES {
            self.drain_storm();
            self.counters.storm_forced_flushes += 1;
        }
        let identity = identity_of(key);
        self.storm_roots.entry(identity.clone()).or_insert(key.root);
        self.storm_deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(DID_CHANGE_DEBOUNCE_MS));
        self.storm.record(identity, version, DEPENDENCY_UPDATE)
    }

    /// RUST-082:窗口到期整批移交(max latency 兑现)——到期才搬,未到期
    /// 一律不动。返回移交条数。连续输入下至多每窗一批,绝不无限推迟。
    pub fn flush_due(&mut self, now: Instant) -> usize {
        match self.storm_deadline {
            Some(deadline) if now >= deadline => {
                let drained = self.drain_storm();
                if drained > 0 {
                    self.counters.storm_deadline_flushes += 1;
                }
                drained
            }
            _ => 0,
        }
    }

    /// 请求所需文件先刷新(RUST-082 接线面):该文件的缓冲事件立即移交
    /// 调度队列,不等窗口——请求入口随后的 freshen 即可执行它。返回是否
    /// 有缓冲事件被移交。
    pub fn take_buffered(&mut self, identity: &str) -> bool {
        match self.storm.take_file(identity) {
            Some(event) => {
                let root = self.storm_roots.remove(identity).unwrap_or(RootId(0));
                let enqueued = self.enqueue_identity(identity, root, Some(event.version));
                let _ = enqueued;
                if self.storm.buffered() == 0 {
                    self.storm_deadline = None;
                }
                true
            }
            None => false,
        }
    }

    /// 移交缓冲→调度队列(整批,插入序稳定;StormBuffer.flush 每文件一条)。
    fn drain_storm(&mut self) -> usize {
        let events = self.storm.flush();
        let count = events.len();
        for event in events {
            if let Some(root) = self.storm_roots.remove(&event.file) {
                let enqueued = self.enqueue_identity(&event.file, root, Some(event.version));
                let _ = enqueued;
            }
        }
        self.storm_deadline = None;
        count
    }

    /// 按身份重建 DocumentKey 并入队(风暴移交路径;身份来自真实键,解析
    /// 失败不可达——不伪造计数)。
    fn enqueue_identity(&mut self, identity: &str, root: RootId, version: Option<u64>) -> bool {
        let Some((_, path)) = identity.split_once(':') else {
            return false;
        };
        let Ok(uri) = CanonicalUri::parse(path) else {
            return false;
        };
        let key = DocumentKey::new(root, uri);
        self.enqueue_refresh(&key, version);
        true
    }

    /// 入队一次刷新(时间点无关:执行时按真相重放)。同文件同版本在队
    /// 即合并;新版本让位;过期丢弃;队满诚实拒绝。
    fn enqueue_refresh(&mut self, key: &DocumentKey, version: Option<u64>) -> EnqueueDecision {
        let identity = identity_of(key);
        let done_log = Rc::clone(&self.done_log);
        let identity_for_log = identity.clone();
        let store = Rc::clone(&self.store);
        let hover = Rc::clone(&self.hover);
        let counts = Rc::clone(&self.ingest_counts);
        let key_for_run = key.clone();
        let wrapped: Box<RunFn> = Box::new(move |token| {
            let run = ingest_refresh_task(store, hover, counts, key_for_run);
            let result = run(token);
            done_log.borrow_mut().push(identity_for_log);
            result
        });
        let outcome = self.sched.enqueue(TaskSpec {
            kind: TaskKind::DependencyUpdate,
            priority: DEPENDENCY_UPDATE,
            file: Some(identity),
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
    /// 队列侧延伸——撤根后残留刷新任务会把旧根语料重新灌回=复活缺陷),
    /// 该根的风暴缓冲事件一并摘除(同语义)。
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
        // 风暴缓冲同根事件一并摘除(缓冲移交会把被撤根语料重新灌回)。
        let buffered_doomed: Vec<String> = self
            .storm_roots
            .iter()
            .filter(|(_, r)| **r == root)
            .map(|(identity, _)| identity.clone())
            .collect();
        for identity in buffered_doomed {
            self.storm.take_file(&identity);
            self.storm_roots.remove(&identity);
            purged += 1;
        }
        if self.storm.buffered() == 0 {
            self.storm_deadline = None;
        }
        self.counters.purged += purged as u64;
        purged
    }

    /// RUST-131-W:单文件撤销的队列侧延伸(生产文件事件 delete/rename 旧
    /// URI 共用)——该身份的待执行刷新与风暴缓冲事件全部摘除。文件已删/
    /// 已改名后残留刷新会把旧 URI 语料重新灌回 = 晚到复活缺陷(撤根
    /// purge_root 同语义,定域到单身份)。返回摘除条数。
    pub fn purge_key(&mut self, identity: &str) -> usize {
        let mut purged = 0;
        if let Some(&(id, _)) = self.pending.get(identity) {
            if self.sched.cancel(id, "file removed") {
                self.pending.remove(identity);
                purged += 1;
            }
        }
        if self.storm_roots.remove(identity).is_some() {
            self.storm.take_file(identity);
            purged += 1;
        }
        if self.storm.buffered() == 0 {
            self.storm_deadline = None;
        }
        self.counters.purged += purged as u64;
        purged
    }

    /// RUST-133:该身份是否仍有待执行刷新(排程 pending 或风暴缓冲)——
    /// 索引缺口 stale 面的判据(缺口=刷新已在路上,非真缺)。
    pub fn has_pending(&self, identity: &str) -> bool {
        self.pending.contains_key(identity) || self.storm_roots.contains_key(identity)
    }

    /// 观测快照(健康面同源)。
    pub fn snapshot(&self) -> IndexQueueSnapshot {
        let ingest = self.ingest_counts.borrow();
        IndexQueueSnapshot {
            queued: self.sched.status().queued as u64,
            storm_seen: self.storm.events_seen,
            storm_merged: self.storm.merged,
            storm_buffered: self.storm.buffered() as u64,
            ingest_identical: ingest.identical,
            ingest_body_only: ingest.body_only,
            ingest_signature: ingest.signature,
            ingest_removed: ingest.removed,
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

/// 构造刷新执行体(执行时刻真相重放):overlay 优先(打开文档未保存修订
/// 不被盘上快照冲掉),回落磁盘,读盘失败=真正逐出(close ≠ 删除,VFS-012
/// 修订同口径)。
pub(crate) fn ingest_refresh_task(
    store: Rc<RefCell<kode_vfs::DocumentStore>>,
    hover: Rc<RefCell<HoverEngine>>,
    counts: Rc<RefCell<IngestCounts>>,
    key: DocumentKey,
) -> Box<RunFn> {
    Box::new(move |_token| {
        if let Some((_, buffer)) = store.borrow().open_buffer(&key) {
            let text = buffer.text().to_string();
            let change = hover.borrow_mut().update(key, &text);
            record_ingest(&counts, change);
        } else {
            // 磁盘回落用原生路径:canonical `/C:/...` 形态在 Windows 上非
            // 有效路径(相对当前盘根解析),直喂 std::fs 读盘恒败=关闭文档
            // 回落全走逐出臂。
            match std::fs::read_to_string(key.uri.to_native_path()) {
                Ok(text) => {
                    let change = hover.borrow_mut().update(key, &text);
                    record_ingest(&counts, change);
                }
                Err(_) => {
                    hover.borrow_mut().remove(&key);
                    counts.borrow_mut().removed += 1;
                }
            }
        }
        Ok(())
    })
}

/// 从 uri 重放 DocumentKey(风暴移交侧身份重建与测试构造共用)。
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

    fn test_queue() -> IndexQueue {
        IndexQueue::new(
            Rc::new(RefCell::new(kode_vfs::DocumentStore::new())),
            Rc::new(RefCell::new(HoverEngine::new())),
        )
    }

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn same_file_same_version_merges_and_never_double_counts() {
        let mut q = test_queue();
        let k = key(1, "/w/A.def");
        assert_eq!(q.request_open(&k, 3), EnqueueDecision::Queued);
        assert_eq!(q.request_open(&k, 3), EnqueueDecision::Merged);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.enqueued, snap.merged), (1, 1, 1));
    }

    #[test]
    fn newer_version_displaces_and_older_version_is_stale_dropped() {
        let mut q = test_queue();
        let k = key(1, "/w/A.def");
        assert_eq!(q.request_open(&k, 1), EnqueueDecision::Queued);
        // 新版本让位:旧任务取消,新任务入队,台账指向新 id。
        assert_eq!(q.request_open(&k, 2), EnqueueDecision::Queued);
        // 过期版本丢弃:比在队旧,不入队。
        assert_eq!(q.request_open(&k, 1), EnqueueDecision::StaleDropped);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.stale_dropped), (1, 1));
        // 排水只执行一次(风暴收敛=至多一个待执行)。
        assert_eq!(q.pump_budgeted(16), 1);
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.executed), (0, 1));
    }

    #[test]
    fn freshen_runs_named_key_first_and_reports_miss() {
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        q.request_open(&a, 1);
        q.request_open(&b, 1);
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
        let mut q = test_queue();
        for i in 0..5 {
            q.request_open(&key(1, &format!("/w/F{i}.def")), 1);
        }
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.snapshot().queued, 3);
        assert_eq!(q.pump_budgeted(2), 2);
        assert_eq!(q.pump_budgeted(2), 1);
        assert_eq!(q.snapshot().queued, 0);
    }

    #[test]
    fn purge_root_drops_only_that_roots_pending_tasks() {
        let mut q = test_queue();
        let keep = key(1, "/w/A.def");
        let drop = key(2, "/w/B.def");
        q.request_open(&keep, 1);
        q.request_open(&drop, 1);
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
        let mut q = test_queue();
        // 有界队列(CORE-006):超过上限的新工作诚实拒绝(计数),不静默积压。
        for i in 0..INDEX_QUEUE_MAX {
            assert_eq!(
                q.request_open(&key(1, &format!("/w/F{i}.def")), 1),
                EnqueueDecision::Queued
            );
        }
        assert_eq!(
            q.request_open(&key(1, "/w/overflow.def"), 1),
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

        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));
        // 未打开:执行读盘 → def 语料入库(symbol_count > 0)。
        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "盘上 def 文件应入索引"
        );

        // 关闭且盘上仍在:回落磁盘(不逐出)。
        store.borrow_mut().close(&k);
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        assert!(
            hover.borrow().index.symbol_count() > 0,
            "关闭后盘上文件仍应喂补全/悬停"
        );

        // 删除盘上文件 + 关闭态:执行=真正逐出(symbol_count 回 0)。
        std::fs::remove_file(&path).unwrap();
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        assert_eq!(hover.borrow().index.symbol_count(), 0, "盘上已删除应逐出");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ingest_counters_classify_identical_body_only_signature_removed() {
        // RUST-120-W:执行体按类别记账(健康面 ingest 四键同源)。def 语料:
        // 同文本重开=identical;尾注(已登记位置全不变)=body-only;属性
        // 类型变更=signature;盘上删除后的 close=removed。
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iqc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));

        // 首次入库 = signature。
        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_signature, 1);

        // 同文本重开 = identical(指纹命中,generation 不动)。
        let gen0 = hover.borrow().index.generation();
        q.request_open(&k, 2);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_identical, 1);
        assert_eq!(hover.borrow().index.generation(), gen0);

        // 尾注追加 = body-only(零失效)。
        std::fs::write(&path, format!("{T_DEF}\n<!-- tail -->\n")).unwrap();
        q.request_open(&k, 3);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_body_only, 1);
        assert_eq!(hover.borrow().index.generation(), gen0);

        // 属性类型变更 = signature(generation bump,视图反映新类型)。
        let t16 = T_DEF.replace("UINT32", "UINT16");
        std::fs::write(&path, &t16).unwrap();
        q.request_open(&k, 4);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_signature, 2);
        assert_eq!(hover.borrow().index.generation(), gen0 + 1);

        // 盘上删除 + close = removed(逐出记账)。
        std::fs::remove_file(&path).unwrap();
        q.request_close(&k);
        assert_eq!(q.pump_budgeted(4), 1);
        let snap = q.snapshot();
        assert_eq!(snap.ingest_removed, 1);
        assert_eq!(hover.borrow().index.symbol_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn did_change_same_text_via_storm_take_buffered_classifies_identical() {
        // RUST-120-W E2E 形状复刻:didOpen v1 → pump;didChange v2(同文本
        // 全量替换)→ 风暴缓冲 → 请求入口 take_buffered + freshen → 分类
        // = identical(与 kodeCoreDifferentialInvalidation e2e 对账)。
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t\t<Flags> BASE </Flags>\n\t\t</hp>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iqs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("T.def");
        std::fs::write(&path, T_DEF).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));

        q.request_open(&k, 1);
        assert_eq!(q.pump_budgeted(4), 1);
        assert_eq!(q.snapshot().ingest_signature, 1);

        // didChange v2:同文本全量替换(overlay 文本=盘上文本,变更语义在
        // 分类面等价)+ 风暴缓冲记录(生产 handle_did_change 同型)。
        let ident = identity_of(&k);
        q.record_change(&k, 2);
        assert!(q.take_buffered(&ident), "缓冲中的 v2 应被立即移交");
        assert!(q.freshen(&ident), "移交后 freshen 应执行");
        let snap = q.snapshot();
        assert_eq!(snap.ingest_identical, 1, "同文本 didChange = identical");
        assert_eq!(snap.ingest_signature, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn did_change_storm_buffers_merge_and_flushes_at_deadline() {
        // 时间窗合并:同文件多版本并一(最新胜出);窗口未到期一律不动;
        // 到期整批移交 → 每文件一条入队(最新版本),max latency 兑现。
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        let t0 = Instant::now();
        assert!(!q.record_change(&a, 1), "首条新文件不合并");
        assert!(q.record_change(&a, 2), "同文件第二条合并");
        assert!(q.record_change(&a, 1), "旧版本事件仍合并(缓冲只留最新)");
        assert!(!q.record_change(&b, 5), "另一文件新入缓冲");
        let snap = q.snapshot();
        assert_eq!(
            (snap.storm_seen, snap.storm_merged, snap.storm_buffered),
            (4, 2, 2)
        );
        assert_eq!(q.snapshot().queued, 0, "窗口未到期不入调度队列");
        // 未到期不动(max latency 上界内允许等)。
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS - 1)), 0);
        assert_eq!(q.snapshot().storm_buffered, 2);
        // 到期整批移交:每文件一条(最新版本),窗口记账落账。
        // deadline = record 时刻真实时钟 + 窗口,取两倍窗宽越过它。
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 2)), 2);
        let snap = q.snapshot();
        assert_eq!(
            (
                snap.queued,
                snap.storm_buffered,
                snap.storm_deadline_flushes
            ),
            (2, 0, 1)
        );
        assert_eq!(snap.enqueued, 2, "移交即入队");
        // 到期后缓冲空:再 flush_due 不重复记账。
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 4)), 0);
        assert_eq!(q.snapshot().storm_deadline_flushes, 1);
    }

    #[test]
    fn take_buffered_moves_only_named_file_and_resets_deadline_when_empty() {
        let mut q = test_queue();
        let a = key(1, "/w/A.def");
        let b = key(1, "/w/B.def");
        assert!(!q.record_change(&a, 1));
        assert!(!q.record_change(&b, 1));
        let ident_a = identity_of(&a);
        assert!(q.take_buffered(&ident_a), "指名移交");
        let snap = q.snapshot();
        assert_eq!(
            (snap.queued, snap.storm_buffered),
            (1, 1),
            "a 入队,b 留缓冲"
        );
        assert_eq!(snap.enqueued, 1);
        // 摘空后窗口复位;未缓冲键 false。
        assert!(q.take_buffered(&identity_of(&b)));
        assert_eq!(q.snapshot().storm_buffered, 0);
        assert!(!q.take_buffered(&ident_a));
        assert_eq!(q.snapshot().queued, 2);
    }

    #[test]
    fn storm_overflow_forces_batch_handoff_before_core_silent_flush() {
        // 缓冲超限:包装侧 record 前预排水(整批移交调度队列),绝不触发
        // 核心 record 的内部 flush(其返回值被丢弃=静默吞事件)。
        let mut q = test_queue();
        for i in 0..STORM_BUFFER_MAX_FILES {
            assert!(!q.record_change(&key(1, &format!("/w/F{i}.def")), 1));
        }
        assert_eq!(q.snapshot().storm_buffered, STORM_BUFFER_MAX_FILES as u64);
        assert_eq!(q.snapshot().storm_forced_flushes, 0);
        // 第 MAX+1 个文件触发预排水:旧批全部入队,新批独占缓冲。
        assert!(!q.record_change(&key(1, "/w/overflow.def"), 1));
        let snap = q.snapshot();
        assert_eq!(snap.enqueued, STORM_BUFFER_MAX_FILES as u64);
        assert_eq!(snap.storm_buffered, 1);
        assert_eq!(snap.storm_forced_flushes, 1);
        assert_eq!(snap.storm_deadline_flushes, 0, "预排水不算窗口到期");
    }

    #[test]
    fn purged_root_drops_buffered_change_events_too() {
        // 撤根:在队任务 + 风暴缓冲事件同根全摘(移交不得复活被撤根语料)。
        let mut q = test_queue();
        let keep = key(1, "/w/A.def");
        let drop = key(2, "/w/B.def");
        q.request_open(&keep, 1);
        assert!(!q.record_change(&drop, 1));
        assert!(q.record_change(&drop, 2));
        assert_eq!(q.purge_root(RootId(2)), 1, "缓冲中同根事件计 1(合并态)");
        let snap = q.snapshot();
        assert_eq!((snap.queued, snap.storm_buffered, snap.purged), (1, 0, 1));
        // 排水:被撤根缓冲事件不复活。
        assert_eq!(q.pump_budgeted(16), 1);
        assert_eq!(q.snapshot().executed, 1);
    }

    #[test]
    fn flushed_change_ingests_latest_version_into_engine() {
        // 内容级:风暴窗并一后移交执行的 ingest = 最新版本语料(引擎中
        // 最新版本独有属性在库)。
        const T_DEF: &str = "<root>\n\t<Properties>\n\t\t<{prop}>\n\t\t\t<Type> UINT32 </Type>\n\t\t</{prop}>\n\t</Properties>\n</root>\n";
        let dir = std::env::temp_dir().join(format!("kode-iq-storm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("S.def");
        std::fs::write(&path, T_DEF.replace("{prop}", "v1only")).unwrap();
        let k = key(1, &path.to_string_lossy());

        let store = Rc::new(RefCell::new(kode_vfs::DocumentStore::new()));
        let hover = Rc::new(RefCell::new(HoverEngine::new()));
        let mut q = IndexQueue::new(Rc::clone(&store), Rc::clone(&hover));
        let t0 = Instant::now();
        assert!(!q.record_change(&k, 1));
        assert!(q.record_change(&k, 2));
        // 最新版本内容写入盘上(overlay 未开 → 执行时刻真相读盘)。
        std::fs::write(&path, T_DEF.replace("{prop}", "v3only")).unwrap();
        assert!(q.record_change(&k, 3));
        assert_eq!(q.flush_due(at(t0, DID_CHANGE_DEBOUNCE_MS * 2)), 1);
        assert_eq!(q.pump_budgeted(4), 1);

        let text = std::fs::read_to_string(&path).unwrap();
        let mk = DocumentKey::new(RootId(1), CanonicalUri::from_path(&path.to_string_lossy()));
        let hover_latest = hover.borrow().hover(&mk, &text, 2, 3);
        assert!(
            hover_latest
                .map(|h| h.symbol.name == "v3only")
                .unwrap_or(false),
            "风暴并一后执行应落最新版本语料"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
