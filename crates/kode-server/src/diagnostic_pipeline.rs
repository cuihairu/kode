//! 诊断调度状态机 + 四族分层独立节流(RUST-142 批 1,src/backend/
//! diagnosticScheduler.ts 同构下沉,纯回放核零真实时钟)。
//!
//! 面 = TS DiagnosticScheduler 的**确定性状态机**(版本化合并/分层记账/
//! 关闭代/输入代/开关闸/异步五守卫/12 计数器),事件迹回放驱动:
//!   - request(立即通道:同步计算+发布守卫)/ request_queued + flush
//!     (排队通道:同 URI 最新版本胜出,coalescedStale 永不执行);
//!   - flush 让出边界(slice_ms=0 确定性:每条目后必让出)执行 duringYield
//!     脚本事件;让出 hook 体同步执行,期间 resolve 的异步计算其续延在
//!     让出返回前以 FIFO 结算(镜像侧 computeAsync 直接返回 gate promise
//!     =单微任务续延,onOk 于 flush-resume 前排队,TS 微任务序同构);
//!   - 异步续延 = 发布五守卫(null 中止→staleDropped/任务 doc 对象被
//!     重入改版→staleDropped/关闭代失配→releasedDropped/开关关闭→
//!     disabledAsyncDropped/输入代切换→staleGenerationDropped),失败
//!     → errored(不重抛,与 KR-AUD-04 同口径);**版本守卫读的是任务
//!     自己捕获的 doc 对象**(TS document 对象语义:新版本=新请求=新
//!     对象,旧任务守卫不受新请求影响,发布回写自己的 version 标记);
//!   - 四族分层:LocalSyntax / Semantic / EngineCompat / RuntimeConfig,
//!     每层一个独立调度器实例(独立节流=实例隔离,TS 生产 13 个
//!     DiagnosticScheduler 每族一实例同构);层只作路由与记账面,不改
//!     调度语义(TS options.layer 仅影响 metrics fileKind)。
//!
//! golden = {traces, outcomes}:traces 与 outcomes 都由 Rust 产出,TS 侧
//! tests/kodeDiagnosticPipelineParity.test.ts 读 golden 的 traces 驱动
//! **生产** DiagnosticScheduler(4 实例管线)逐迹复算,逐条 outcomes
//! 深等(发布序+终态统计+残留量规)——TS 生产调度器是语义真值源,
//! 镜像红=移植错,按源码重推。
//!
//! 诚实边界:TS 生产层枚举仍是 local|semantic 两值(17 家族现全部按
//! local 调度);四族是本行的目标设计,层路由/分类面在本核,生产 TS
//! 不动(接线留批 2)。性能计时(recordLanguageServiceOperation)不在
//! 对拍面。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

// ---------------------------------------------------------------------------
// 四族分层
// ---------------------------------------------------------------------------

/// 诊断分层(RUST-142 目标四族;TS 生产现为 local|semantic 两值,
/// 本枚举是服务端目标面,层只作路由/记账不改调度语义)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLayer {
    LocalSyntax,
    Semantic,
    EngineCompat,
    RuntimeConfig,
}

impl DiagnosticLayer {
    pub const ALL: [DiagnosticLayer; 4] = [
        DiagnosticLayer::LocalSyntax,
        DiagnosticLayer::Semantic,
        DiagnosticLayer::EngineCompat,
        DiagnosticLayer::RuntimeConfig,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            DiagnosticLayer::LocalSyntax => "localSyntax",
            DiagnosticLayer::Semantic => "semantic",
            DiagnosticLayer::EngineCompat => "engineCompat",
            DiagnosticLayer::RuntimeConfig => "runtimeConfig",
        }
    }

    pub fn parse(value: &str) -> Option<DiagnosticLayer> {
        DiagnosticLayer::ALL
            .iter()
            .copied()
            .find(|layer| layer.as_str() == value)
    }
}

/// 四族→既有 Rust 模块锚(分类面;一族一层,各锚为已落库模块):
/// local syntax=def 本地校验(diagnostics.rs)/ semantic=KSEM 语义索引
/// (semantics/)/ engine compatibility=def md5 引擎门(def_md5.rs)/
/// runtime config=配置契约(config_rpc.rs)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticFamily {
    DefLocalValidation,
    SemanticsIndex,
    DefMd5Compat,
    ConfigContract,
}

pub fn layer_for_family(family: DiagnosticFamily) -> DiagnosticLayer {
    match family {
        DiagnosticFamily::DefLocalValidation => DiagnosticLayer::LocalSyntax,
        DiagnosticFamily::SemanticsIndex => DiagnosticLayer::Semantic,
        DiagnosticFamily::DefMd5Compat => DiagnosticLayer::EngineCompat,
        DiagnosticFamily::ConfigContract => DiagnosticLayer::RuntimeConfig,
    }
}

// ---------------------------------------------------------------------------
// 统计(TS DiagnosticSchedulerStats 12 计数器同构)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStats {
    pub requested: u64,
    pub computed: u64,
    pub published: u64,
    pub coalesced_stale: u64,
    pub stale_dropped: u64,
    pub released_dropped: u64,
    pub skipped_current_version: u64,
    pub disabled_skipped: u64,
    pub disabled_async_dropped: u64,
    pub stale_generation_dropped: u64,
    pub errored: u64,
    pub cleared: u64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorkload {
    pub queued: u64,
    pub in_flight: u64,
}

// ---------------------------------------------------------------------------
// 事件迹(golden 内嵌;TS 镜像读同一迹驱动生产调度器)
// ---------------------------------------------------------------------------

/// 计算体内重入编排(TS compute/computeAsync 闭包内的副作用):
/// MutateVersion=改写本任务捕获的 doc 对象版本;Release=重入 releaseDocument。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum SideEffect {
    MutateVersion { version: i64 },
    Release { uri: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum AsyncOutcome {
    Items { items: Vec<u32> },
    Null,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum TraceEvent {
    Request {
        uri: String,
        version: Option<i64>,
        items: Vec<u32>,
        #[serde(default)]
        async_compute: bool,
        #[serde(default)]
        side_effects: Vec<SideEffect>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    RequestQueued {
        uri: String,
        version: Option<i64>,
        items: Vec<u32>,
        #[serde(default)]
        async_compute: bool,
        #[serde(default)]
        side_effects: Vec<SideEffect>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Flush {
        #[serde(default = "default_slice_ms")]
        slice_ms: u64,
        #[serde(default)]
        during_yields: Vec<TraceEvent>,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    ResolveAsync {
        async_id: usize,
        outcome: AsyncOutcome,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    AwaitMacrotask {
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Release {
        uri: String,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    SetEnabled {
        enabled: bool,
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
    Invalidate {
        #[serde(default = "default_layer")]
        layer: DiagnosticLayer,
    },
}

fn default_layer() -> DiagnosticLayer {
    DiagnosticLayer::LocalSyntax
}

fn default_slice_ms() -> u64 {
    // TS FLUSH_SLICE_MS 巨值域=永不 yield(确定性;真值 25ms 依赖时钟,
    // 对拍只走 0=每条目必让出 与 巨值=零让出 两确定性域)
    1_000_000_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCorpusEntry {
    pub name: String,
    pub events: Vec<TraceEvent>,
}

// ---------------------------------------------------------------------------
// 调度器核心(TS DiagnosticScheduler 状态机同构;items = u32 脚本化)
// ---------------------------------------------------------------------------

/// 文档版本格(每请求任务一个,支持同步计算内重入改版——TS 侧 compute
/// 闭包改写 document.version 对象语义)。
#[derive(Debug, Clone)]
struct DocCell {
    version: std::cell::Cell<Option<i64>>,
}

type SharedDoc = std::rc::Rc<DocCell>;

#[derive(Debug, Clone)]
pub struct TaskSpec {
    pub items: Vec<u32>,
    /// 异步计算 ID(注册进 pending;None=同步路径)
    pub async_id: Option<usize>,
    pub side_effects: Vec<SideEffect>,
}

#[derive(Debug, Clone)]
struct QueuedTask {
    key: String,
    doc: SharedDoc,
    task: TaskSpec,
    version: Option<i64>,
    release_epoch: u64,
}

#[derive(Debug, Default)]
struct UriState {
    published_version: Option<i64>,
    published_generation: i64,
    queued: Option<QueuedTask>,
}

/// 发布面记录(golden 可比;TS 镜像同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum PublishRecord {
    Publish {
        layer: DiagnosticLayer,
        uri: String,
        items: Vec<u32>,
    },
    ClearAll {
        layer: DiagnosticLayer,
    },
}

/// 在途异步计算(续延数据;TS .then(onOk, onErr) 闭包捕获面的结构化)。
#[derive(Debug)]
struct PendingAsync {
    key: String,
    doc: SharedDoc,
    task: TaskSpec,
    version: Option<i64>,
    release_epoch: u64,
    started_generation: i64,
}

/// 微任务模型(TS 生产续延链的结构化):Body = async fn 体恢复段
/// (`await gate` 返回;计算体内重入副作用;Error 拒绝跳过体内后续),
/// 完后按 outcome 排 OkItems/OkNull/Err;Ok*/Err = onOk/onErr 段
/// (计数+五守卫+发布/记账),跑完从 pending 摘除。settle=排空全部
/// 微任务(事件后/让出边界,先于 flush 恢复宏任务)。
#[derive(Debug, Clone)]
enum MicroTask {
    Body(usize),
    OkItems(usize, Vec<u32>),
    OkNull(usize),
    Err(usize),
}

/// 诊断调度核心(单层;四族管线 = 每层一个实例)。
/// 状态迭代序 = TS Map 插入序(Vec + 索引,flush 批序可对拍)。
#[derive(Debug)]
pub struct DiagnosticSchedulerCore {
    generation: i64,
    enabled: bool,
    states: Vec<(String, UriState)>,
    state_index: BTreeMap<String, usize>,
    /// 在途异步计算(Ok/Err 跑完即摘,TS pending Set 同口径;in_flight=长度)
    pending: Vec<PendingAsync>,
    /// 已 resolve 待结算的续延(async_id;outcome 由 outcomes 携带)
    resolved: BTreeMap<usize, AsyncOutcome>,
    /// 微任务队列(TS 微任务 FIFO 同构;flush 让出边界含 FlushResume 哨)
    microtasks: VecDeque<MicroTask>,
    next_async_id: usize,
    epochs: BTreeMap<String, u64>,
    /// 发布收集(回放面注入的 sink 等价物)
    sink: Vec<PublishRecord>,
    layer: DiagnosticLayer,
    stats: SchedulerStats,
}

impl DiagnosticSchedulerCore {
    pub fn new(layer: DiagnosticLayer) -> DiagnosticSchedulerCore {
        DiagnosticSchedulerCore {
            generation: 0,
            enabled: true,
            states: Vec::new(),
            state_index: BTreeMap::new(),
            pending: Vec::new(),
            resolved: BTreeMap::new(),
            microtasks: VecDeque::new(),
            next_async_id: 0,
            epochs: BTreeMap::new(),
            sink: Vec::new(),
            layer,
            stats: SchedulerStats::default(),
        }
    }

    pub fn stats(&self) -> &SchedulerStats {
        &self.stats
    }

    pub fn sink(&self) -> &[PublishRecord] {
        &self.sink
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn has_queued_tasks(&self) -> bool {
        self.states.iter().any(|(_, s)| s.queued.is_some())
    }

    /// 残留任务量规(TS pendingWorkload;queued=排队 URI 数,
    /// in_flight=未落定异步计算数)。
    pub fn pending_workload(&self) -> PendingWorkload {
        let queued = self
            .states
            .iter()
            .filter(|(_, s)| s.queued.is_some())
            .count() as u64;
        PendingWorkload {
            queued,
            in_flight: self.pending.len() as u64,
        }
    }

    /// 开关切换(A6-4;clear_all 走发布面 ClearAll 记录)。
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        if !enabled {
            self.sink.push(PublishRecord::ClearAll { layer: self.layer });
            self.stats.cleared += 1;
            // 关闭期间发布的版本标记全部作废:重开后同版本也要重算一次
            for (_, state) in self.states.iter_mut() {
                state.published_version = None;
            }
        } else {
            self.invalidate_all();
        }
    }

    /// 诊断输入代切换(子开关/语义索引失效):迫使已发布文档重算。
    pub fn invalidate_all(&mut self) {
        self.generation += 1;
        for (_, state) in self.states.iter_mut() {
            state.published_version = None;
        }
    }

    /// TS stateFor:插入序 map 新建状态 + 关闭代自增(重开=旧代在途全作废)。
    /// 返回状态槽位(借用纪律:持槽借用期间不得再调 &self 方法)。
    fn state_for(&mut self, key: &str) -> usize {
        if let Some(&index) = self.state_index.get(key) {
            return index;
        }
        self.states.push((key.to_string(), UriState::default()));
        let index = self.states.len() - 1;
        self.state_index.insert(key.to_string(), index);
        let epoch = self.epochs.entry(key.to_string()).or_insert(0);
        *epoch += 1;
        index
    }

    fn epoch_of(&self, key: &str) -> u64 {
        self.epochs.get(key).copied().unwrap_or(0)
    }

    /// 立即通道:同步计算 + 发布守卫(版本/关闭代)。
    pub fn request(&mut self, uri: &str, version: Option<i64>, task: TaskSpec) {
        self.stats.requested += 1;
        if !self.enabled {
            self.stats.disabled_skipped += 1;
            return;
        }
        let doc = SharedDoc::new(DocCell {
            version: std::cell::Cell::new(version),
        });
        let index = self.state_for(uri);
        let (published_version, published_generation) = {
            let state = &self.states[index].1;
            (state.published_version, state.published_generation)
        };
        let skip = version.is_some()
            && published_version == version
            && published_generation == self.generation;
        if skip {
            self.stats.skipped_current_version += 1;
            return;
        }
        self.compute_and_publish(uri, doc, version, task);
    }

    /// 排队通道(A6-1):同 URI 只留最新版本任务(旧版本 coalescedStale)。
    pub fn request_queued(&mut self, uri: &str, version: Option<i64>, task: TaskSpec) {
        self.stats.requested += 1;
        if !self.enabled {
            self.stats.disabled_skipped += 1;
            return;
        }
        let doc = SharedDoc::new(DocCell {
            version: std::cell::Cell::new(version),
        });
        let index = self.state_for(uri);
        let replace_stale = match &self.states[index].1.queued {
            Some(queued) => {
                queued.version.is_some() && version.is_some() && queued.version != version
            }
            None => false,
        };
        let release_epoch = self.epoch_of(uri);
        if replace_stale {
            // 版本不同=「连续编辑合并过期任务」;同版本替换不记合并
            self.stats.coalesced_stale += 1;
        }
        self.states[index].1.queued = Some(QueuedTask {
            key: uri.to_string(),
            doc,
            task,
            version,
            release_epoch,
        });
    }

    /// 冲刷排队任务:每 URI 至多一个(最新版本),发布前复核版本令牌。
    /// slice_ms=0 = 每条目后必让出(确定性;TS performance.now 差 ≥0 恒真),
    /// 巨值域=零让出;yield = 跑一条 duringYields 脚本事件 + 边界内结算全部
    /// 续延。生产序依据:让出面默认 setImmediate 宏任务边界,脚本事件
    /// (外部 worker 回调 resolve)是让出窗口内的宏任务轮,gate 续延链
    /// (async fn 体恢复 → onOk 发布)是微任务,在 flush 恢复的宏任务之前
    /// 排空——让出窗口 resolve 的异步先于 flush 恢复发布。让出过=再收一轮
    /// (收编窗口内新入队任务)。
    fn flush_round(&mut self, slice_ms: u64, script: &mut std::vec::IntoIter<TraceEvent>) {
        if !self.enabled {
            return;
        }
        loop {
            let batch = self.collect_queued();
            if batch.is_empty() {
                return;
            }
            let mut sliced = false;
            let last = batch.len() - 1;
            for (index, queued) in batch.into_iter().enumerate() {
                self.process_queued_entry(queued);
                if index == last {
                    break;
                }
                if slice_ms == 0 {
                    // 让出 hook 体:同步跑一条脚本事件,随后结算续延
                    // (微任务排空先于 flush 恢复宏任务)
                    if let Some(event) = script.next() {
                        self.run_event(event, script);
                    }
                    self.settle();
                    // 让出窗口内开关关闭:剩余条目不再计算(重开 invalidateAll 兜重算)
                    if !self.enabled {
                        return;
                    }
                    sliced = true;
                }
            }
            // 零让出=同步原子完成收工;让出过=再收一轮
            if !sliced {
                return;
            }
        }
    }

    /// 出队:插入序取走全部排队任务(所有权转移,TS collectQueued 同构)。
    fn collect_queued(&mut self) -> Vec<QueuedTask> {
        let mut batch = Vec::new();
        for (_, state) in self.states.iter_mut() {
            if let Some(queued) = state.queued.take() {
                batch.push(queued);
            }
        }
        batch
    }

    /// 处理单个出队条目:处理时守卫(关闭代失配/任务 doc 改版)后才计算发布。
    fn process_queued_entry(&mut self, queued: QueuedTask) {
        // 入队后文档已关闭(含让出窗口内关闭)→ 零计算直接丢弃
        if self.epoch_of(&queued.key) != queued.release_epoch {
            self.stats.released_dropped += 1;
            return;
        }
        // 处理时任务 doc 对象已前进到入队之后的新版本 → 过期丢弃
        let current = queued.doc.version.get();
        if queued.version.is_some() && current != queued.version {
            self.stats.stale_dropped += 1;
            return;
        }
        let skip = self
            .states
            .iter()
            .find(|(k, _)| *k == queued.key)
            .map(|(_, s)| {
                queued.version.is_some()
                    && s.published_version == queued.version
                    && s.published_generation == self.generation
            })
            .unwrap_or(false);
        if skip {
            self.stats.skipped_current_version += 1;
            return;
        }
        self.compute_and_publish(&queued.key, queued.doc, queued.version, queued.task);
    }

    /// 计算与发布:同步路径(计算体内副作用→守卫→发布)/异步路径
    /// (注册在途,续延由 settle 驱动跑同一组守卫)。
    fn compute_and_publish(
        &mut self,
        key: &str,
        doc: SharedDoc,
        version: Option<i64>,
        task: TaskSpec,
    ) {
        // TS:捕获当代关闭代与发起代——在途期间关闭/换代都失配
        let release_epoch = self.epoch_of(key);
        let started_generation = self.generation;
        match task.async_id {
            Some(_id) => {
                self.pending.push(PendingAsync {
                    key: key.to_string(),
                    doc,
                    task,
                    version,
                    release_epoch,
                    started_generation,
                });
            }
            None => {
                // 同步计算(计算体内重入副作用:改版/重入关闭)
                for effect in &task.side_effects {
                    self.apply_side_effect(effect, Some(&doc));
                }
                self.stats.computed += 1;
                // 发布守卫:计算期间文档前进(重入 mutateVersion)
                if version.is_some() && doc.version.get() != version {
                    self.stats.stale_dropped += 1;
                    return;
                }
                // 发布守卫:同步计算重入关闭文档
                if self.epoch_of(key) != release_epoch {
                    self.stats.released_dropped += 1;
                    return;
                }
                self.publish(key, version, task.items);
            }
        }
    }

    fn publish(&mut self, key: &str, version: Option<i64>, items: Vec<u32>) {
        self.sink.push(PublishRecord::Publish {
            layer: self.layer,
            uri: key.to_string(),
            items,
        });
        let generation = self.generation;
        let index = self.state_for(key);
        let state = &mut self.states[index].1;
        state.published_version = version;
        state.published_generation = generation;
        self.stats.published += 1;
    }

    /// 文档关闭:释放版本标记与残留排队任务;关闭代自增(晚到结果全作废)。
    pub fn release_document(&mut self, uri: &str) {
        let Some(index) = self.state_index.get(uri).copied() else {
            return;
        };
        if self.states[index].1.queued.is_some() {
            self.stats.coalesced_stale += 1;
        }
        self.states.remove(index);
        // 重建索引(TS Map delete 不动其余插入序;Vec remove 同)
        self.state_index.clear();
        for (position, (key, _)) in self.states.iter().enumerate() {
            self.state_index.insert(key.clone(), position);
        }
        let epoch = self.epochs.entry(uri.to_string()).or_insert(0);
        *epoch += 1;
        self.stats.cleared += 1;
    }

    /// 异步解析(事件):记录 outcome 并排队 Body 段(async fn 体恢复——
    /// TS gate resolve 时刻;守卫/发布在 Body 产的 Ok 段)。
    pub fn resolve_async(&mut self, async_id: usize, outcome: AsyncOutcome) {
        if !self.pending.iter().any(|p| p.task.async_id == Some(async_id)) {
            return;
        }
        self.resolved.insert(async_id, outcome);
        self.microtasks.push_back(MicroTask::Body(async_id));
    }

    /// 结算:排空微任务队列(TS 解释器每事件 await setImmediate 同构;
    /// FIFO=排队序;让出边界先于 flush 恢复宏任务)。
    pub fn settle(&mut self) {
        while let Some(task) = self.microtasks.pop_front() {
            self.run_microtask(task);
        }
    }

    /// 单微任务执行。
    fn run_microtask(&mut self, task: MicroTask) {
        match task {
            MicroTask::Body(id) => {
                let Some(outcome) = self.resolved.remove(&id) else {
                    return;
                };
                match outcome {
                    // async fn 体 await gate 拒绝 → 体内后续(副作用)不执行
                    AsyncOutcome::Error => self.microtasks.push_back(MicroTask::Err(id)),
                    AsyncOutcome::Null => {
                        // 体恢复段:计算体内重入副作用(await 返回后、return null 前)
                        self.apply_pending_effects(id);
                        self.microtasks.push_back(MicroTask::OkNull(id));
                    }
                    AsyncOutcome::Items { items } => {
                        self.apply_pending_effects(id);
                        self.microtasks.push_back(MicroTask::OkItems(id, items));
                    }
                }
            }
            MicroTask::OkNull(id) => {
                let Some(pending) = self.take_pending(id) else {
                    return;
                };
                // TS onOk(null):computed 先记,null=中止记过期不发布
                self.stats.computed += 1;
                self.stats.stale_dropped += 1;
                let _ = pending;
            }
            MicroTask::Err(id) => {
                let pending = self.take_pending(id);
                // KR-AUD-04:失败不重抛,errored 记账,computed 不增
                self.stats.errored += 1;
                let _ = pending;
            }
            MicroTask::OkItems(id, items) => {
                let Some(pending) = self.take_pending(id) else {
                    return;
                };
                // TS onOk 首行:computed 先记(先于 null 检查与全部守卫)
                self.stats.computed += 1;
                // 发布守卫:计算期间文档前进(任务 doc 对象被重入改版)
                if pending.version.is_some() && pending.doc.version.get() != pending.version {
                    self.stats.stale_dropped += 1;
                    return;
                }
                // 发布守卫:计算期间文档已关闭(或关闭后重开到新代)
                if self.epoch_of(&pending.key) != pending.release_epoch {
                    self.stats.released_dropped += 1;
                    return;
                }
                // 发布守卫:计算在途时开关关闭
                if !self.enabled {
                    self.stats.disabled_async_dropped += 1;
                    return;
                }
                // 发布守卫:计算在途时代已切换(不发布,也不把新代标成已发布)
                if self.generation != pending.started_generation {
                    self.stats.stale_generation_dropped += 1;
                    return;
                }
                self.publish(&pending.key, pending.version, items);
            }
        }
    }

    /// async fn 体恢复段的重入副作用(gate 正常落定后执行;Error 拒绝跳过)。
    fn apply_pending_effects(&mut self, id: usize) {
        let (effects, doc) = self
            .pending
            .iter()
            .find(|p| p.task.async_id == Some(id))
            .map(|p| (p.task.side_effects.clone(), Some(p.doc.clone())))
            .unwrap_or((Vec::new(), None));
        for effect in &effects {
            self.apply_side_effect(effect, doc.as_ref());
        }
    }

    /// TS pending.delete:onOk/onErr 段起跑即从在途摘除。
    fn take_pending(&mut self, id: usize) -> Option<PendingAsync> {
        let position = self
            .pending
            .iter()
            .position(|p| p.task.async_id == Some(id))?;
        Some(self.pending.remove(position))
    }

    fn apply_side_effect(&mut self, effect: &SideEffect, doc: Option<&SharedDoc>) {
        match effect {
            SideEffect::MutateVersion { version } => {
                if let Some(doc) = doc {
                    doc.version.set(Some(*version));
                }
            }
            SideEffect::Release { uri } => self.release_document(uri),
        }
    }

    fn make_task(&mut self, items: Vec<u32>, async_compute: bool, side_effects: Vec<SideEffect>) -> TaskSpec {
        let async_id = if async_compute {
            let id = self.next_async_id;
            self.next_async_id += 1;
            Some(id)
        } else {
            None
        };
        TaskSpec {
            items,
            async_id,
            side_effects,
        }
    }

    /// 事件回放入口(事件层路由由回放面负责,这里只跑单层语义)。
    fn run_event(&mut self, event: TraceEvent, _script: &mut std::vec::IntoIter<TraceEvent>) {
        match event {
            TraceEvent::Request {
                uri,
                version,
                items,
                async_compute,
                side_effects,
                layer: _,
            } => {
                let task = self.make_task(items, async_compute, side_effects);
                self.request(&uri, version, task);
            }
            TraceEvent::RequestQueued {
                uri,
                version,
                items,
                async_compute,
                side_effects,
                layer: _,
            } => {
                let task = self.make_task(items, async_compute, side_effects);
                self.request_queued(&uri, version, task);
            }
            TraceEvent::Flush {
                slice_ms,
                during_yields,
                layer: _,
            } => {
                let mut script_iter = during_yields.into_iter();
                self.flush_round(slice_ms, &mut script_iter);
            }
            TraceEvent::ResolveAsync {
                async_id,
                outcome,
                layer: _,
            } => self.resolve_async(async_id, outcome),
            TraceEvent::AwaitMacrotask { layer: _ } => self.settle(),
            TraceEvent::Release { uri, layer: _ } => self.release_document(&uri),
            TraceEvent::SetEnabled { enabled, layer: _ } => self.set_enabled(enabled),
            TraceEvent::Invalidate { layer: _ } => self.invalidate_all(),
        }
    }
}

// ---------------------------------------------------------------------------
// 回放面(四族管线;每层独立调度器=独立节流)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceOutcome {
    pub name: String,
    pub publish_log: Vec<PublishRecord>,
    pub stats: BTreeMap<String, SchedulerStats>,
    pub workload: BTreeMap<String, PendingWorkload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineGolden {
    pub generator: &'static str,
    pub trace_count: usize,
    pub traces: Vec<TraceCorpusEntry>,
    pub outcomes: Vec<TraceOutcome>,
}

/// 回放:四族管线(每层独立调度器),事件按层路由,事件后结算续延
/// (TS 解释器每事件 await setImmediate 排空微任务同构)。
pub fn replay_trace(trace: &TraceCorpusEntry) -> TraceOutcome {
    let mut schedulers: BTreeMap<String, DiagnosticSchedulerCore> = BTreeMap::new();
    for layer in DiagnosticLayer::ALL {
        schedulers.insert(
            layer.as_str().to_string(),
            DiagnosticSchedulerCore::new(layer),
        );
    }
    for event in &trace.events {
        let layer = layer_of_event(event);
        let scheduler = schedulers
            .get_mut(layer.as_str())
            .expect("layer routed scheduler");
        let mut empty_script = Vec::new().into_iter();
        scheduler.run_event(event.clone(), &mut empty_script);
        // 事件后结算(TS 解释器统一 await 排空微任务)
        scheduler.settle();
    }
    let mut stats = BTreeMap::new();
    let mut workload = BTreeMap::new();
    let mut publish_log = Vec::new();
    for (name, scheduler) in &schedulers {
        stats.insert(name.clone(), scheduler.stats().clone());
        workload.insert(name.clone(), scheduler.pending_workload());
        publish_log.extend(scheduler.sink().iter().cloned());
    }
    TraceOutcome {
        name: trace.name.clone(),
        publish_log,
        stats,
        workload,
    }
}

fn layer_of_event(event: &TraceEvent) -> DiagnosticLayer {
    match event {
        TraceEvent::Request { layer, .. }
        | TraceEvent::RequestQueued { layer, .. }
        | TraceEvent::Flush { layer, .. }
        | TraceEvent::ResolveAsync { layer, .. }
        | TraceEvent::AwaitMacrotask { layer }
        | TraceEvent::Release { layer, .. }
        | TraceEvent::SetEnabled { layer, .. }
        | TraceEvent::Invalidate { layer } => *layer,
    }
}

// ---------------------------------------------------------------------------
// golden 语料(迹由本函数权威定义;TS 镜像读 golden 的 traces 复算)
// ---------------------------------------------------------------------------

pub const DIAGNOSTIC_PIPELINE_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/diagnostic-pipeline-parity.json";

fn corpus() -> Vec<TraceCorpusEntry> {
    let a = "file:///a.def";
    let b = "file:///b.def";
    let c = "file:///c.def";
    let d = "file:///d.def";
    let req = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::Request {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: false,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let req_async = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::Request {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: true,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let queued = |uri: &str, version: i64, items: Vec<u32>| TraceEvent::RequestQueued {
        uri: uri.to_string(),
        version: Some(version),
        items,
        async_compute: false,
        side_effects: Vec::new(),
        layer: DiagnosticLayer::LocalSyntax,
    };
    let macro_task = || TraceEvent::AwaitMacrotask {
        layer: DiagnosticLayer::LocalSyntax,
    };
    vec![
        // T1 立即通道:发布/同版本同代跳过/版本前进重算
        TraceCorpusEntry {
            name: "sync_request_publish_version_skip".into(),
            events: vec![
                req(a, 1, vec![1]),
                req(a, 1, vec![1]),
                req(a, 2, vec![2]),
            ],
        },
        // T2 开关闸:关→clearAll+cleared+disabledSkipped;开→invalidateAll 重算
        TraceCorpusEntry {
            name: "disabled_gate_roundtrip".into(),
            events: vec![
                req(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                req(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: true,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                req(a, 1, vec![1]),
            ],
        },
        // T3 排队合并:同 URI 最新版本胜出(coalescedStale=1),flush 只算 v2
        TraceCorpusEntry {
            name: "queued_coalesce_latest_wins".into(),
            events: vec![
                queued(a, 1, vec![1]),
                queued(a, 2, vec![2]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T4 让出窗口:批间让出执行脚本(入队新任务→re-collect 第二轮;
        // release 已入批任务→处理时关闭代失配 releasedDropped)
        TraceCorpusEntry {
            name: "flush_yield_recollect_and_release".into(),
            events: vec![
                queued(a, 1, vec![1]),
                queued(b, 1, vec![2]),
                queued(c, 1, vec![3]),
                TraceEvent::Flush {
                    slice_ms: 0,
                    during_yields: vec![
                        queued(d, 1, vec![4]),
                        TraceEvent::Release {
                            uri: c.to_string(),
                            layer: DiagnosticLayer::LocalSyntax,
                        },
                    ],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T5 异步+新版本请求:任务 doc 对象不受新请求影响,晚到回包照发布
        // (TS document 对象语义:守卫只读任务自己捕获的对象;发布回写
        // 自己的 version 标记覆盖新请求标记)
        TraceCorpusEntry {
            name: "async_own_doc_object_publishes_late".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                req(a, 2, vec![2]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T6 异步 null 中止(computed 先于 null 检查,staleDropped)
        TraceCorpusEntry {
            name: "async_null_abort".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Null,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T7 异步在途关闭:晚到回包不发布(releasedDropped)
        TraceCorpusEntry {
            name: "async_release_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::Release {
                    uri: a.to_string(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T8 异步在途关开关:旧结果不写回(disabledAsyncDropped)
        TraceCorpusEntry {
            name: "async_disable_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T9 异步在途换代:旧配置结果丢弃(不发布也不标已发布→重开同版本要重算)
        TraceCorpusEntry {
            name: "async_invalidate_midflight".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::Invalidate {
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
                req(a, 1, vec![9]),
            ],
        },
        // T10 异步失败:errored 记账,computed 不增,无发布
        TraceCorpusEntry {
            name: "async_error_accounted".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Error,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T11 异步双在途 FIFO 结算:发布序=解析序(先 resolve b 后 a)
        TraceCorpusEntry {
            name: "async_fifo_settle_order".into(),
            events: vec![
                req_async(a, 1, vec![1]),
                req_async(b, 1, vec![2]),
                TraceEvent::ResolveAsync {
                    async_id: 1,
                    outcome: AsyncOutcome::Items { items: vec![2] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
                TraceEvent::ResolveAsync {
                    async_id: 0,
                    outcome: AsyncOutcome::Items { items: vec![1] },
                    layer: DiagnosticLayer::LocalSyntax,
                },
                macro_task(),
            ],
        },
        // T12 已发布同版本重入队:flush 处理时守卫 skippedCurrentVersion
        TraceCorpusEntry {
            name: "flush_repeat_skips_published_version".into(),
            events: vec![
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T13 同步计算重入改版:守卫读改后版本→staleDropped(computed 已记)
        TraceCorpusEntry {
            name: "sync_compute_reentrant_mutate_version".into(),
            events: vec![TraceEvent::Request {
                uri: a.to_string(),
                version: Some(1),
                items: vec![1],
                async_compute: false,
                side_effects: vec![SideEffect::MutateVersion { version: 9 }],
                layer: DiagnosticLayer::LocalSyntax,
            }],
        },
        // T14 同步计算重入关闭(自 release):releasedDropped
        TraceCorpusEntry {
            name: "sync_compute_reentrant_release".into(),
            events: vec![TraceEvent::Request {
                uri: a.to_string(),
                version: Some(1),
                items: vec![1],
                async_compute: false,
                side_effects: vec![SideEffect::Release { uri: a.to_string() }],
                layer: DiagnosticLayer::LocalSyntax,
            }],
        },
        // T15 排队任务处理时任务 doc 改版:staleDropped(release 重入在
        // 入队后、flush 前由另一事件改版不可达——用让出窗口入队+第二让出
        // 改不了已捕获 doc,本迹改由 flush 让出窗口内 Invalidate 后同版本
        // 重入队覆盖 publishedGeneration 守卫路径)
        TraceCorpusEntry {
            name: "queued_flush_after_invalidate_recomputes".into(),
            events: vec![
                queued(a, 1, vec![1]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Invalidate {
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(a, 1, vec![7]),
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
        // T16 四族管线独立节流:同 URI 四层各自调度;关 localSyntax 不影响
        // 其余层计算与发布(clearAll 只落在 localSyntax 发布面)
        TraceCorpusEntry {
            name: "pipeline_layers_independent_throttle".into(),
            events: vec![
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![1],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![2],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::Semantic,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![3],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::EngineCompat,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![4],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::RuntimeConfig,
                },
                TraceEvent::SetEnabled {
                    enabled: false,
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(2),
                    items: vec![5],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(2),
                    items: vec![6],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::Semantic,
                },
                TraceEvent::RequestQueued {
                    uri: b.to_string(),
                    version: Some(1),
                    items: vec![7],
                    async_compute: false,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::RuntimeConfig,
                },
                TraceEvent::Flush {
                    slice_ms: default_slice_ms(),
                    during_yields: vec![],
                    layer: DiagnosticLayer::RuntimeConfig,
                },
            ],
        },
        // T17 异步在途期间排队任务让出窗口 resolve:续延于让出边界结算,
        // 发布落在 flush 批内(onOk 于 flush-resume 前排空的 TS 微任务序)
        TraceCorpusEntry {
            name: "yield_resolves_async_publish_inside_flush".into(),
            events: vec![
                TraceEvent::Request {
                    uri: a.to_string(),
                    version: Some(1),
                    items: vec![1],
                    async_compute: true,
                    side_effects: Vec::new(),
                    layer: DiagnosticLayer::LocalSyntax,
                },
                queued(b, 1, vec![2]),
                queued(c, 1, vec![3]),
                TraceEvent::Flush {
                    slice_ms: 0,
                    during_yields: vec![TraceEvent::ResolveAsync {
                        async_id: 0,
                        outcome: AsyncOutcome::Items { items: vec![1] },
                        layer: DiagnosticLayer::LocalSyntax,
                    }],
                    layer: DiagnosticLayer::LocalSyntax,
                },
            ],
        },
    ]
}

/// golden 生成(权威迹 + 回放产出;traces 与 outcomes 同文件,TS 镜像读
/// traces 驱动生产调度器逐条对拍 outcomes)。
pub fn dump_diagnostic_pipeline_golden() -> String {
    let traces = corpus();
    let outcomes: Vec<TraceOutcome> = traces.iter().map(replay_trace).collect();
    let golden = PipelineGolden {
        generator: "dump-diagnostic-pipeline-golden",
        trace_count: traces.len(),
        traces,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden serialize")
}

// ---------------------------------------------------------------------------
// 单元钉(核心语义独立断言;golden 的 outcomes 由同一代码产出属自洽,
// 这里的钉直接对调度核语义断言,防 golden 同义反复)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_task(items: Vec<u32>) -> TaskSpec {
        TaskSpec {
            items,
            async_id: None,
            side_effects: Vec::new(),
        }
    }

    fn async_task(id: usize, items: Vec<u32>) -> TaskSpec {
        TaskSpec {
            items,
            async_id: Some(id),
            side_effects: Vec::new(),
        }
    }

    #[test]
    fn coalesce_and_latest_version_wins() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.request_queued("a", Some(2), sync_task(vec![2]));
        assert_eq!(core.stats().coalesced_stale, 1);
        core.flush_round(1_000_000_000, &mut Vec::new().into_iter());
        assert_eq!(core.stats().published, 1);
        assert_eq!(
            core.sink(),
            &[PublishRecord::Publish {
                layer: DiagnosticLayer::LocalSyntax,
                uri: "a".into(),
                items: vec![2],
            }]
        );
    }

    #[test]
    fn same_version_replacement_is_not_coalesced() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.request_queued("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().coalesced_stale, 0);
        assert_eq!(core.stats().requested, 2);
    }

    #[test]
    fn release_drops_queued_task_and_late_async_result() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("a", Some(1), sync_task(vec![1]));
        core.release_document("a");
        assert_eq!(core.stats().coalesced_stale, 1, "关闭时排队任务记合并");
        assert_eq!(core.stats().cleared, 1);
        assert!(!core.has_queued_tasks(), "关闭后队列清空");
        core.flush_round(1_000_000_000, &mut Vec::new().into_iter());
        assert_eq!(core.stats().published, 0, "已释放任务不发布");
        // 在途异步:关闭后代失配,晚到回包不发布
        core.request("a", Some(1), async_task(0, vec![1]));
        core.release_document("a");
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().released_dropped, 1);
        assert_eq!(core.stats().published, 0);
        assert_eq!(core.pending_workload().in_flight, 0, "结算后在途摘除");
    }

    #[test]
    fn generation_switch_drops_and_does_not_mark_published() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), async_task(0, vec![1]));
        core.invalidate_all();
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().stale_generation_dropped, 1);
        assert_eq!(core.stats().published, 0);
        // 关键语义:不把新代标成已发布——同版本重算不跳过
        core.request("a", Some(1), sync_task(vec![9]));
        assert_eq!(core.stats().skipped_current_version, 0);
        assert_eq!(core.stats().published, 1);
    }

    #[test]
    fn disable_drops_inflight_and_reopen_forces_recompute() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), sync_task(vec![1]));
        core.set_enabled(false);
        assert_eq!(core.stats().cleared, 1);
        core.request("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().disabled_skipped, 1);
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(core.stats().disabled_async_dropped, 0, "关前未注册异步");
        // 在途异步在关闭后 resolve
        let mut core2 = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core2.request("a", Some(1), async_task(0, vec![1]));
        core2.set_enabled(false);
        core2.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core2.settle();
        assert_eq!(core2.stats().disabled_async_dropped, 1);
        // 重开:invalidateAll 迫使已发布文档重算(同版本不跳过)
        core.set_enabled(true);
        core.request("a", Some(1), sync_task(vec![1]));
        assert_eq!(core.stats().skipped_current_version, 0);
        assert_eq!(core.stats().published, 2);
    }

    #[test]
    fn settle_order_is_resolution_fifo() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request("a", Some(1), async_task(0, vec![1]));
        core.request("b", Some(1), async_task(1, vec![2]));
        core.resolve_async(1, AsyncOutcome::Items { items: vec![2] });
        core.resolve_async(0, AsyncOutcome::Items { items: vec![1] });
        core.settle();
        assert_eq!(
            core.sink(),
            &[
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "b".into(),
                    items: vec![2],
                },
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "a".into(),
                    items: vec![1],
                },
            ]
        );
    }

    #[test]
    fn flush_batch_follows_insertion_order_and_recollects_after_yield() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("zz", Some(1), sync_task(vec![1]));
        core.request_queued("aa", Some(1), sync_task(vec![2]));
        // 插入序批:zz 先于 aa(非字典序);slice=0 批间让出执行脚本入队新任务
        core.request_queued("mm", Some(1), sync_task(vec![3]));
        let mut script = vec![TraceEvent::RequestQueued {
            uri: "bb".into(),
            version: Some(1),
            items: vec![4],
            async_compute: false,
            side_effects: Vec::new(),
            layer: DiagnosticLayer::LocalSyntax,
        }]
        .into_iter();
        core.flush_round(0, &mut script);
        let uris: Vec<&str> = core
            .sink()
            .iter()
            .filter_map(|r| match r {
                PublishRecord::Publish { uri, .. } => Some(uri.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(uris, vec!["zz", "aa", "mm", "bb"], "插入序批+让出窗口收编");
    }

    #[test]
    fn yield_window_async_publishes_before_flush_resume() {
        // T17 语义:让出面默认 setImmediate 宏任务边界,让出窗口内 resolve
        // 的续延链(async fn 体恢复→onOk 发布)是微任务,在 flush 恢复的
        // 宏任务之前排空——异步发布先落,flush 同步条目后落。
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request_queued("b", Some(1), async_task(0, vec![1]));
        core.request_queued("c", Some(1), sync_task(vec![3]));
        let mut script = vec![TraceEvent::ResolveAsync {
            async_id: 0,
            outcome: AsyncOutcome::Items { items: vec![1] },
            layer: DiagnosticLayer::LocalSyntax,
        }]
        .into_iter();
        core.flush_round(0, &mut script);
        core.settle();
        assert_eq!(
            core.sink(),
            &[
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "b".into(),
                    items: vec![1],
                },
                PublishRecord::Publish {
                    layer: DiagnosticLayer::LocalSyntax,
                    uri: "c".into(),
                    items: vec![3],
                },
            ],
            "让出窗口异步先发布,flush 同步条目后发布"
        );
        assert_eq!(core.stats().computed, 2, "异步 onOk 与同步计算各计一次");
        assert_eq!(core.stats().published, 2);
        assert_eq!(core.stats().stale_dropped, 0);
    }

    #[test]
    fn sync_reentrant_mutate_version_drops_publish() {
        let mut core = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        core.request(
            "a",
            Some(1),
            TaskSpec {
                items: vec![1],
                async_id: None,
                side_effects: vec![SideEffect::MutateVersion { version: 9 }],
            },
        );
        assert_eq!(core.stats().computed, 1);
        assert_eq!(core.stats().stale_dropped, 1);
        assert_eq!(core.stats().published, 0);
    }

    #[test]
    fn layer_pipeline_routes_independently() {
        assert_eq!(layer_for_family(DiagnosticFamily::DefLocalValidation), DiagnosticLayer::LocalSyntax);
        assert_eq!(layer_for_family(DiagnosticFamily::SemanticsIndex), DiagnosticLayer::Semantic);
        assert_eq!(layer_for_family(DiagnosticFamily::DefMd5Compat), DiagnosticLayer::EngineCompat);
        assert_eq!(layer_for_family(DiagnosticFamily::ConfigContract), DiagnosticLayer::RuntimeConfig);
        assert_eq!(DiagnosticLayer::parse("localSyntax"), Some(DiagnosticLayer::LocalSyntax));
        assert_eq!(DiagnosticLayer::parse("runtimeConfig"), Some(DiagnosticLayer::RuntimeConfig));
        assert_eq!(DiagnosticLayer::parse("nope"), None);
        // 独立节流:关一层不影响其余层计算
        let mut local = DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax);
        let mut semantic = DiagnosticSchedulerCore::new(DiagnosticLayer::Semantic);
        local.request("a", Some(1), sync_task(vec![1]));
        semantic.request("a", Some(1), sync_task(vec![2]));
        local.set_enabled(false);
        local.request("a", Some(2), sync_task(vec![3]));
        semantic.request("a", Some(2), sync_task(vec![4]));
        assert_eq!(local.stats().disabled_skipped, 1);
        assert_eq!(semantic.stats().published, 2);
    }
}
