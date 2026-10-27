// 统一索引调度器(PR3,评审 docs/review/2026-10-22 §3.3):索引任务的生命周期
// 与优先级唯一入口。任务类别覆盖首扫/单文件增量/受影响依赖更新/删除清理/
// 非交互全项目分析;同文件同版本任务合并、过期版本任务取消丢弃;失败任务
// 不缓存「已扫描」假象,后续请求可重新入队恢复(不永久 pending)。
// 后台任务(全量/非交互)受交互限流:交互任务入队或刚完成的冷却窗口内不
// 上主线程,编辑高峰不让全量索引抢占输入响应。
// 打点:每次任务执行经 languageServiceMetrics('index-scheduler')记录耗时与
// 终态;限流让路/合并/丢弃计数由 getStatus().metrics 承载(测试与报告取证)。

import { performance } from 'perf_hooks';
import { startLanguageServiceOperation } from './languageServiceMetrics';

/** 任务类别 = 生命周期阶段(§3.3 至少支持清单) */
export type IndexTaskKind =
  | 'initial-scan'
  | 'single-file-update'
  | 'dependency-update'
  | 'delete-cleanup'
  | 'full-reindex'
  | 'non-interactive';

/**
 * 优先级(评审建议顺序,数值越小越先):
 * 当前文件轻量 > 请求所需局部 > 依赖更新 > 后台全量 > 非交互。
 */
export const IndexTaskPriority = {
  /** 当前打开文件的轻量解析 */
  CurrentFileLight: 0,
  /** 当前请求需要但尚未建立的局部索引 */
  RequestLocal: 1,
  /** 当前文件修改引起的受影响依赖更新 */
  DependencyUpdate: 2,
  /** 后台全量索引 */
  BackgroundFull: 3,
  /** 非交互式全项目分析 */
  NonInteractive: 4
} as const;

export type IndexTaskPriorityValue = (typeof IndexTaskPriority)[keyof typeof IndexTaskPriority];

/** 交互任务 = 会话内用户在等的那几类(优先级高于后台全量) */
export function isInteractivePriority(priority: number): boolean {
  return priority < IndexTaskPriority.BackgroundFull;
}

export interface IndexTaskSpec {
  kind: IndexTaskKind;
  priority: IndexTaskPriorityValue;
  /** 任务体;拒绝 = 该次尝试失败(可恢复,不算永久状态) */
  run: () => Promise<void>;
  /** 单文件增量的目标文件(合并/过期判定的键的一部分) */
  filePath?: string;
  /** 文件版本(document version/mtime 代);同文件跨版本靠它判过期 */
  version?: number;
  /** 文件删除/资产根移除时的失效目标(仅状态查询展示用) */
  targetPath?: string;
}

export type IndexTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface IndexTaskHandle {
  id: number;
  /** 任务终态 Promise(取消 = 拒绝;失败 = 拒绝;调用方可 catch 忽略) */
  wait: Promise<void>;
  cancel(reason?: string): void;
  /** 当前状态快照(queued/running/completed/failed/cancelled) */
  state(): IndexTaskState;
}

interface ScheduledTask {
  id: number;
  seq: number;
  kind: IndexTaskKind;
  priority: number;
  filePath?: string;
  version?: number;
  targetPath?: string;
  run: () => Promise<void>;
  state: IndexTaskState;
  cancelReason?: string;
  /** 任务体抛出的原始错误(handle.wait 拒绝时原样透传) */
  error?: unknown;
  /** 终态钩子(句柄可多份:合并复用/ensureTask 各挂一个) */
  settleListeners: Array<() => void>;
}

export interface SchedulerMetrics {
  /** 同文件同版本合并掉的重复任务数 */
  mergedTasks: number;
  /** 过期版本任务取消丢弃数 */
  staleDropped: number;
  /** 后台任务因交互压力被推迟启动的次数 */
  postponedBackground: number;
  /** 后台任务因交互限流累计让出的等待时长(ms) */
  backgroundDelayMs: number;
  /** 任务失败后重新入队恢复的次数 */
  recoveries: number;
}

export interface SchedulerStatus {
  queued: number;
  queuedByPriority: Record<number, number>;
  running: { id: number; kind: IndexTaskKind; priority: number; filePath?: string } | null;
  completed: number;
  failed: number;
  cancelled: number;
  /** keyed 任务(如首扫)当前状态;无活动任务时为上一次终态 */
  keyedTasks: Record<string, IndexTaskState>;
  metrics: SchedulerMetrics;
}

interface KeyedEntry {
  state: IndexTaskState;
  promise: Promise<void> | null;
  id: number | null;
}

export interface IndexSchedulerOptions {
  /**
   * 交互冷却窗口(ms):最后一次交互任务入队/完成后的这段时间内,后台任务
   * 不启动。默认 50ms——编辑高峰(连续输入)下每个按键都刷新窗口,全量
   * 索引持续让路;空闲后一个窗口内恢复后台推进。
   */
  interactiveCooldownMs?: number;
}

const DEFAULT_INTERACTIVE_COOLDOWN_MS = 50;

export class IndexScheduler {
  private readonly tasks = new Map<number, ScheduledTask>();
  private queueOrder: number[] = [];
  private runningId: number | null = null;
  private nextId = 1;
  private nextSeq = 1;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private readonly keyed = new Map<string, KeyedEntry>();
  private readonly metrics: SchedulerMetrics = {
    mergedTasks: 0,
    staleDropped: 0,
    postponedBackground: 0,
    backgroundDelayMs: 0,
    recoveries: 0
  };
  private lastInteractiveEnqueueAt = -Number.MAX_VALUE;
  private lastInteractiveEndAt = -Number.MAX_VALUE;
  private readonly interactiveCooldownMs: number;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: IndexSchedulerOptions = {}) {
    this.interactiveCooldownMs = options.interactiveCooldownMs ?? DEFAULT_INTERACTIVE_COOLDOWN_MS;
  }

  /** 入队一个任务;返回句柄(wait 取消/失败时拒绝,调用方自行 catch) */
  enqueue(spec: IndexTaskSpec): IndexTaskHandle {
    if (this.disposed) {
      const wait = Promise.reject(new Error('index scheduler disposed'));
      // 防未处理拒绝噪音:调用方不 catch 也不炸进程
      wait.catch(() => undefined);
      return { id: -1, wait, cancel: () => undefined, state: () => 'cancelled' as IndexTaskState };
    }

    if (isInteractivePriority(spec.priority)) {
      this.lastInteractiveEnqueueAt = performance.now();
    }

    // 同文件合并/过期判定:只对带 filePath 的任务生效(首扫等无文件任务不合并)
    if (spec.filePath !== undefined) {
      const sameFile = this.queueOrder
        .map(id => this.tasks.get(id))
        .filter((task): task is ScheduledTask => task !== undefined && task.filePath === spec.filePath);
      const sameVersion = sameFile.find(task => task.version === spec.version);
      if (sameVersion) {
        // ② 同文件同版本:合并为一条,优先级取更高者(数值更小)
        this.metrics.mergedTasks += 1;
        if (spec.priority < sameVersion.priority) {
          sameVersion.priority = spec.priority;
          sameVersion.kind = spec.kind;
        }
        return this.handleOf(sameVersion);
      }
      const newer = sameFile.find(
        task => task.version !== undefined && spec.version !== undefined && task.version > spec.version
      );
      if (newer) {
        // ② 新任务比队列里已有的同文件任务旧:丢弃新任务(过期)
        this.metrics.staleDropped += 1;
        const wait = Promise.reject(new Error(`stale task dropped for ${spec.filePath}`));
        wait.catch(() => undefined);
        return { id: -1, wait, cancel: () => undefined, state: () => 'cancelled' as IndexTaskState };
      }
      // 队列里有同文件的更旧版本任务:取消丢弃,让位新版本
      for (const task of sameFile) {
        if (task.version !== undefined && spec.version !== undefined && task.version < spec.version) {
          this.cancelQueued(task, 'stale-version');
        }
      }
    }

    const task: ScheduledTask = {
      id: this.nextId++,
      seq: this.nextSeq++,
      kind: spec.kind,
      priority: spec.priority,
      filePath: spec.filePath,
      version: spec.version,
      targetPath: spec.targetPath,
      run: spec.run,
      state: 'queued',
      settleListeners: []
    };
    this.tasks.set(task.id, task);
    this.queueOrder.push(task.id);
    this.schedulePump();
    return this.handleOf(task);
  }

  /**
   * keyed 单例任务(首扫等):同 key 进行中直接复用;上一次尝试失败/取消后
   * 再次调用会重新入队——失败不缓存成永久 pending,后续请求可恢复(④)。
   */
  ensureTask(key: string, factory: () => IndexTaskSpec): Promise<void> {
    const entry = this.keyed.get(key);
    if (entry && entry.promise && (entry.state === 'queued' || entry.state === 'running')) {
      return entry.promise;
    }
    if (entry && (entry.state === 'failed' || entry.state === 'cancelled')) {
      this.metrics.recoveries += 1;
    }
    const spec = factory();
    const handle = this.enqueue(spec);
    const record: KeyedEntry = { state: handle.state(), promise: handle.wait, id: handle.id };
    this.keyed.set(key, record);
    void handle.wait.then(
      () => {
        if (this.keyed.get(key) === record) { record.state = 'completed'; }
      },
      () => {
        if (this.keyed.get(key) === record) {
          record.state = handle.state() === 'cancelled' ? 'cancelled' : 'failed';
        }
      }
    );
    return handle.wait;
  }

  /** keyed 任务是否已完成(状态查询便捷面) */
  isKeyedComplete(key: string): boolean {
    return this.keyed.get(key)?.state === 'completed';
  }

  getStatus(): SchedulerStatus {
    const queuedByPriority: Record<number, number> = {};
    for (const id of this.queueOrder) {
      const task = this.tasks.get(id);
      if (!task) { continue; }
      queuedByPriority[task.priority] = (queuedByPriority[task.priority] ?? 0) + 1;
    }
    const running = this.runningId !== null ? this.tasks.get(this.runningId) : undefined;
    const keyedTasks: Record<string, IndexTaskState> = {};
    for (const [key, entry] of this.keyed) {
      keyedTasks[key] = entry.state;
    }
    return {
      queued: this.queueOrder.length,
      queuedByPriority,
      running: running
        ? { id: running.id, kind: running.kind, priority: running.priority, filePath: running.filePath }
        : null,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      keyedTasks,
      metrics: { ...this.metrics }
    };
  }

  /** 取消所有排队任务(运行中的不中断);dispose 前的批量清理用 */
  cancelQueuedTasks(reason = 'scheduler-reset'): number {
    const ids = [...this.queueOrder];
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task) { this.cancelQueued(task, reason); }
    }
    return ids.length;
  }

  dispose(): void {
    this.disposed = true;
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.cancelQueuedTasks('scheduler-disposed');
  }

  private handleOf(task: ScheduledTask): IndexTaskHandle {
    let settled = false;
    const wait = new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (settled) { return; }
        if (task.state === 'completed') { settled = true; resolve(); }
        else if (task.state === 'failed' || task.state === 'cancelled') {
          settled = true;
          reject(task.error ?? new Error(
            `task #${task.id} ${task.state}${task.cancelReason ? ` (${task.cancelReason})` : ''}`
          ));
        }
      };
      // 终态可能在 handle 创建前后到达:先查一次,再挂终态钩子
      check();
      if (!settled) {
        task.settleListeners.push(check);
      }
    });
    wait.catch(() => undefined);
    return {
      id: task.id,
      wait,
      cancel: (reason?: string) => {
        if (task.state === 'queued') { this.cancelQueued(task, reason ?? 'cancelled-by-handle'); }
      },
      state: () => task.state
    };
  }

  private cancelQueued(task: ScheduledTask, reason: string): void {
    const index = this.queueOrder.indexOf(task.id);
    if (index < 0 || task.state !== 'queued') { return; }
    this.queueOrder.splice(index, 1);
    task.state = 'cancelled';
    task.cancelReason = reason;
    this.cancelled += 1;
    this.metrics.staleDropped += reason === 'stale-version' ? 1 : 0;
    for (const listener of task.settleListeners.splice(0)) { listener(); }
    // 取消即终态:同样出表,避免过期版本任务(快速连续保存)在表里积压
    this.tasks.delete(task.id);
  }

  /**
   * pump 推迟到微任务:同一同步批内的入队(一次请求引发的若干索引任务)
   * 先聚齐再排序启动——否则先入队的低优任务同步抢跑,优先级队列失效。
   */
  private pumpScheduled = false;

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) { return; }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** 单并发驱动:每次任务终态后重新取队首 */
  private pump(): void {
    if (this.disposed || this.runningId !== null) { return; }
    const next = this.pickNext();
    if (!next) { return; }
    this.queueOrder.splice(this.queueOrder.indexOf(next.id), 1);
    next.state = 'running';
    this.runningId = next.id;
    const operation = startLanguageServiceOperation('index-scheduler', {
      indexGeneration: next.priority
    });
    void next
      .run()
      .then(() => {
        next.state = 'completed';
        this.completed += 1;
        operation.end('ok');
      })
      .catch((error: unknown) => {
        // 失败不缓存「已扫描」假象:keyed 条目回落 failed,后续请求重跑(④)
        next.state = 'failed';
        next.error = error;
        this.failed += 1;
        operation.end('error');
      })
      .then(() => {
        if (this.runningId === next.id) { this.runningId = null; }
        if (isInteractivePriority(next.priority)) {
          this.lastInteractiveEndAt = performance.now();
        }
        for (const listener of next.settleListeners.splice(0)) { listener(); }
        // 终态任务出表:run 闭包持有整批文件路径与错误对象,长会话保存/扫描
        // 会让 tasks Map 无限增长。句柄经 settleListeners 与自身闭包保留状态,
        // 不依赖 Map;queued/running 查询也只看 queueOrder 与 runningId。
        this.tasks.delete(next.id);
        this.pump();
      });
  }

  private pickNext(): ScheduledTask | null {
    const candidates = this.queueOrder
      .map(id => this.tasks.get(id))
      .filter((task): task is ScheduledTask => task !== undefined);
    if (candidates.length === 0) { return null; }
    candidates.sort((left, right) => left.priority - right.priority || left.seq - right.seq);
    const head = candidates[0];
    if (isInteractivePriority(head.priority)) {
      // ③ 优先级顺序:交互任务永远先于后台任务
      return head;
    }
    // ⑥ 后台限流:交互冷却窗口内不启动后台任务,不让全量索引抢主线程
    const now = performance.now();
    const sinceLastInteractive = now - Math.max(this.lastInteractiveEnqueueAt, this.lastInteractiveEndAt);
    if (sinceLastInteractive < this.interactiveCooldownMs) {
      this.metrics.postponedBackground += 1;
      this.metrics.backgroundDelayMs = Math.round(
        (this.metrics.backgroundDelayMs + (this.interactiveCooldownMs - sinceLastInteractive)) * 100
      ) / 100;
      this.scheduleThrottledPump(this.interactiveCooldownMs - sinceLastInteractive);
      return null;
    }
    return head;
  }

  private scheduleThrottledPump(delayMs: number): void {
    if (this.throttleTimer !== null || this.disposed) { return; }
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.pump();
    }, Math.max(1, Math.ceil(delayMs)));
  }
}
