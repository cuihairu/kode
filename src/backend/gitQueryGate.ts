/**
 * IDE-GIT-011:历史查询收敛与缓存生命周期(全扩展历史的 Git 子进程协调门)。
 * 用户约束(2026-10-29):默认开启、按需查询——本门只在历史查询发起时生效,
 * 绝不预取/轮询;只协调**历史泳道**的 Git 子进程调用,不涉其它 Git 使用面。
 *
 * 语义(验收):
 * - **同查询合并**:相同 (cwd, args) 的并发查询共享一次子进程(排队中也合并)。
 * - **并发上限 2,高成本范围追踪最多 1 个**:`git log -L`(行段追踪)判为高成本
 *   (cost='range'),同时最多 1 个;其余标准查询合计最多 2 个。
 * - **等待队列有界**:排队满即拒绝新请求(返回 gate 拒绝结果,如实反馈,绝不
 *   无限堆积);重复选区「只留最新」由视图层代际守卫负责(本门按 identity 去重)。
 * - **缓存按 仓库/提交/路径/范围/查询选项 隔离并限制条目数与字节**:键 =
 *   (cwd, args)(编码仓库根、提交、路径、行段范围与查询选项),LRU 淘汰,条目数
 *   与总字节双上限;只缓存成功(ok)结果,失败/超时/取消不缓存。
 * - **提交内容缓存可复用**:`git show <commit>:<path>` 同键命中即复用。
 * - **日志页显式刷新重新获取 HEAD**:`bypassCache` 跳过读缓存但仍写回。
 * - **关闭视图/禁用/卸载取消 + 清理**:`dispose()` 取消全部在途/排队请求并清空
 *   缓存与队列,不残留 Git 子进程(经注入取消令牌终止子进程)。
 *
 * 纯状态机(可测)+ 注入 spawn/取消面;默认 spawn 走 IDE-GIT-003 有界只读执行器。
 */

import { runGitReadOnly, type GitCancellationToken, type GitRunOptions, type GitRunOutcome } from './gitRunner';

/** 高成本查询:`git log -L` 行段追踪(并发最多 1)。 */
export type GitQueryCost = 'standard' | 'range';

/**
 * 查询请求修饰(经门传播):token=调用方取消(关闭视图/卸载);bypassCache=
 * 显式刷新(日志页重新获取 HEAD,跳过读缓存但仍写回)。
 */
export interface GitQueryRequest {
  token?: GitCancellationToken;
  bypassCache?: boolean;
}

/**
 * 可取消信号源(provider 持有一份,dispose 时取消该视图全部在途查询;
 * 结构兼容 GitCancellationToken,可传 runGitReadOnly 终止子进程)。
 */
export class GitCancelSource implements GitCancellationToken {
  private cancelled = false;
  private readonly callbacks: Array<() => void> = [];

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onRequestCancel(cb: () => void): { dispose(): void } {
    this.callbacks.push(cb);
    return { dispose: () => {} };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of this.callbacks) cb();
  }
}

/** 由参数判成本:`-L` 即行段追踪(高成本),其余标准。 */
export function deriveQueryCost(args: readonly string[]): GitQueryCost {
  return args.includes('-L') ? 'range' : 'standard';
}

/** 查询身份键:cwd + 参数数组(编码仓库/提交/路径/范围/选项)。 */
export function gitQueryIdentity(cwd: string, args: readonly string[]): string {
  return `${cwd}\u001f${args.join('\u001f')}`;
}

/**
 * git log 不带显式修订范围时默认以 HEAD 为起点(审核发现修复):`git log`、
 * `git log -L s,e:path`、`git log --skip=N -- path` 等查询的结果随提交变化,
 * 须判 volatile 而不缓存(与 3c04ab2 的「HEAD 触达查询不缓存」一致)。
 * 判定 = 扫描 `--` 分隔符前的裸位置参数;`-L` 及其取值、其余选项不计入。
 */
function gitLogHasExplicitRevision(args: readonly string[]): boolean {
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') return false; // 分隔符后全为路径,此前无裸修订 → 隐式 HEAD
    if (a.startsWith('-L')) {
      // -L 行段追踪:分离形式取下一参为值(附值形式无下一参)
      if (a === '-L') i += 1;
      continue;
    }
    if (a.startsWith('-')) continue; // 其余选项(附值形式,不吞下一参)
    return true; // 首个裸位置参数 = 显式修订范围
  }
  return false;
}

/**
 * 判查询是否含易变引用:HEAD 引用（含裸 `HEAD` 与 `HEAD:<path>`、`HEAD~N` 等）
 * 的结果随提交/工作区变化——缓存这类查询会把过期 diff/HEAD 供后续用
 * （审核发现：修改/提交后再查范围历史会读到旧映射/旧历史）。
 * 固定 hash/路径/reflog/日期等不受影响；只读门仍放行全部查询。
 */
export function queryTouchesHead(args: readonly string[]): boolean {
  if (args.some((arg) => /(^|[/~^])HEAD([:~^/]|$)/.test(arg))) return true;
  // 隐式 HEAD:git log 无显式修订范围 → 默认 HEAD 为起点(审核发现修复)
  if (args[0] === 'log' && !gitLogHasExplicitRevision(args)) return true;
  return false;
}

/** 协调门限制与缓存上限(全部有界,绝不无界堆积)。 */
export interface GitQueryGateLimits {
  /** 并发子进程总数上限(默认 2)。 */
  maxConcurrent: number;
  /** 高成本(`git log -L`)并发上限(默认 1)。 */
  maxRangeConcurrent: number;
  /** 等待队列上限(默认 8;满即拒绝新请求)。 */
  maxQueue: number;
  /** 缓存条目数上限(默认 128)。 */
  maxCacheEntries: number;
  /** 缓存总字节上限(默认 8 MiB;stdout+stderr 计)。 */
  maxCacheBytes: number;
}

export function defaultGitQueryGateLimits(): GitQueryGateLimits {
  return { maxConcurrent: 2, maxRangeConcurrent: 1, maxQueue: 8, maxCacheEntries: 128, maxCacheBytes: 8 * 1024 * 1024 };
}

/** 注入面:spawn(默认只读执行器)与取消/计时(测试可控)。 */
export interface GitQueryGateDeps {
  /** 跑一条只读 Git(默认 runGitReadOnly;经门调度后调用)。 */
  spawn(args: readonly string[], options: GitRunOptions): Promise<GitRunOutcome>;
}

export function defaultGitQueryGateDeps(): GitQueryGateDeps {
  return { spawn: (args, options) => runGitReadOnly(args, options) };
}

interface QueuedRequest {
  identity: string;
  args: readonly string[];
  options: GitRunOptions;
  cost: GitQueryCost;
  bypassCache: boolean;
  volatile: boolean;
  resolve: (outcome: GitRunOutcome) => void;
  cancel: () => void;
}

interface PendingEntry {
  promise: Promise<GitRunOutcome>;
  cancel: () => void;
  addCaller: (token: GitCancellationToken | undefined) => void;
}

/**
 * 历史查询协调门(单例;extension 装配层持有)。
 * 调度 = 去重(排队+运行共享)→ 缓存 → 并发槽(2/1) → 有界队列 → 注入 spawn。
 * 结算:成功写缓存(ok 且可缓存);取消/超时/失败不写。dispose 取消全部并清缓存。
 */
export class GitQueryGate {
  private readonly limits: GitQueryGateLimits;
  private readonly deps: GitQueryGateDeps;
  private running = 0;
  private rangeRunning = 0;
  private readonly queue: QueuedRequest[] = [];
  private readonly pending = new Map<string, PendingEntry>();
  private readonly cache = new Map<string, { outcome: GitRunOutcome; bytes: number }>();
  private cachedBytes = 0;
  private spawns = 0;
  private disposed = false;

  constructor(limits?: Partial<GitQueryGateLimits>, deps?: Partial<GitQueryGateDeps>) {
    this.limits = { ...defaultGitQueryGateLimits(), ...(limits ?? {}) };
    this.deps = { ...defaultGitQueryGateDeps(), ...(deps ?? {}) };
  }

  /** 当前运行中的子进程数(测试探针)。 */
  runningCount(): number {
    return this.running;
  }

  /** 当前排队请求数(测试探针)。 */
  queuedCount(): number {
    return this.queue.length;
  }

  /** 缓存条目数(测试探针)。 */
  cacheCount(): number {
    return this.cache.size;
  }

  /** 缓存字节数(测试探针,IDE-GIT-012 宿主影响验收口径)。 */
  cacheBytes(): number {
    return this.cachedBytes;
  }

  /** 累计启动的 Git 子进程数(测试探针,IDE-GIT-012 记录 Git 调用数)。 */
  spawnCount(): number {
    return this.spawns;
  }

  /**
   * 经门运行一条历史 Git 查询。
   * 同 (cwd, args) 在途/排队 → 合并共享;缓存命中(非 bypassCache)→ 立即返回;
   * 并发/排队超限 → gate 拒绝结果;dispose 后 → 拒绝。结算成功且 ok 写缓存。
   */
  run(args: readonly string[], options: GitRunOptions, opts?: { bypassCache?: boolean }): Promise<GitRunOutcome> {
    const identity = gitQueryIdentity(options.cwd, args);
    const cost = deriveQueryCost(args);
    const bypassCache = opts?.bypassCache === true;
    const volatile = queryTouchesHead(args);

    if (this.disposed) {
      return Promise.resolve({ kind: 'spawn', message: '历史查询已停用(功能已卸载)' });
    }
    if (options.token?.isCancellationRequested) {
      // 预取消短路:不占并发槽、不启动子进程。
      return Promise.resolve({ kind: 'cancelled' });
    }
    // 同查询合并:在途或排队(无论 cost)共享一次。
    const existing = this.pending.get(identity);
    if (existing) {
      // 后加入调用方共享同一次子进程,但其取消语义必须并入:
      // 只有当前无人需要(所有 caller 都取消)或门侧取消才终止查询。
      existing.addCaller(options.token);
      return existing.promise;
    }
    // 缓存命中(显式刷新 bypassCache 跳过读;易变查询一律不读——HEAD 会变)。
    if (!bypassCache && !volatile) {
      const hit = this.cache.get(identity);
      if (hit) {
        return Promise.resolve(hit.outcome);
      }
    }

    const signal = new GitCancelSource();
    // 子进程只认门侧 signal:调用方取消不直接终止共享查询(须全部 caller
    // 都取消或门侧取消才 signal.cancel),否则一个视图取消会误杀另一视图。
    const runOptions = { ...options, token: signal };

    let resolvePromise!: (o: GitRunOutcome) => void;
    const promise = new Promise<GitRunOutcome>((resolve) => {
      resolvePromise = resolve;
    });
    const callers: Array<GitCancellationToken | undefined> = [options.token];
    const isCallerCancelled = (token?: GitCancellationToken): boolean => Boolean(token?.isCancellationRequested);
    const maybeCancelWhenNoCallersNeedIt = (): void => {
      if (callers.every(isCallerCancelled)) signal.cancel();
    };
    options.token?.onRequestCancel?.(() => maybeCancelWhenNoCallersNeedIt());
    const request: QueuedRequest = {
      identity,
      args,
      options: runOptions,
      cost,
      bypassCache,
      volatile,
      resolve: resolvePromise,
      cancel: () => {
        signal.cancel();
      },
    };
    this.pending.set(identity, {
      promise,
      cancel: () => request.cancel(),
      addCaller: (token: GitCancellationToken | undefined) => {
        if (!token) return;
        callers.push(token);
        token.onRequestCancel?.(() => maybeCancelWhenNoCallersNeedIt());
        maybeCancelWhenNoCallersNeedIt();
      }
    });

    // 排队的重复选区只留最新:排队中同 identity 的新请求已在上方合并,
    // 不同 identity 不互斥(视图层代际守卫处理"只留最新")。
    if (this.canStart(cost)) {
      this.start(request);
    } else if (this.queue.length >= this.limits.maxQueue) {
      // 有界队列满:拒绝新请求(不堆积;结算 pending)。
      this.pending.delete(identity);
      resolvePromise({ kind: 'spawn', message: '历史查询队列已满,请稍后重试' });
    } else {
      this.queue.push(request);
    }
    return promise;
  }

  /** 显式刷新:跳过读缓存(仍写回);仅对缓存键生效。 */
  invalidate(identity: string): void {
    const hit = this.cache.get(identity);
    if (hit) {
      this.cache.delete(identity);
      this.cachedBytes -= hit.bytes;
    }
  }

  /** 清空缓存(条目数/字节归零)。 */
  clearCache(): void {
    this.cache.clear();
    this.cachedBytes = 0;
  }

  /**
   * 取消全部在途与排队请求并清缓存(禁用配置触发),但**门保持可用**——
   * 重新启用后新查询照常受理(区别于终态 dispose)。
   */
  cancelAll(): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const q of queued) {
      this.pending.delete(q.identity);
      q.resolve({ kind: 'cancelled' });
    }
    for (const [, p] of this.pending) {
      p.cancel();
    }
    this.clearCache();
  }

  /**
   * 关闭/禁用/卸载:取消全部在途与排队请求(子进程经取消令牌终止),
   * 清空队列与缓存。幂等;之后 run 返回拒绝结果。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queue.splice(0, this.queue.length);
    for (const q of queued) {
      this.pending.delete(q.identity);
      q.resolve({ kind: 'cancelled' });
    }
    for (const [, p] of this.pending) {
      p.cancel();
    }
    this.pending.clear();
    this.clearCache();
  }

  private canStart(cost: GitQueryCost): boolean {
    if (this.running >= this.limits.maxConcurrent) return false;
    if (cost === 'range' && this.rangeRunning >= this.limits.maxRangeConcurrent) return false;
    return true;
  }

  private start(request: QueuedRequest): void {
    this.running += 1;
    this.spawns += 1;
    if (request.cost === 'range') this.rangeRunning += 1;
    void this.deps
      .spawn(request.args, request.options)
      .then((outcome) => {
        if (outcome.kind === 'ok' && !request.volatile && !this.disposed) {
          this.writeCache(request.identity, outcome);
        }
        this.finish(request, outcome);
      })
      .catch(() => {
        // spawn 抛异常(理论上 runGitReadOnly 不抛):按启动失败映射。
        this.finish(request, { kind: 'spawn', message: 'Git 进程启动失败' });
      });
  }

  private finish(request: QueuedRequest, outcome: GitRunOutcome): void {
    if (request.cost === 'range') this.rangeRunning -= 1;
    this.running -= 1;
    this.pending.delete(request.identity);
    request.resolve(outcome);
    // 释放槽后补位下一个可启动请求(有界队列)。
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.canStart(next.cost)) return;
      this.queue.shift();
      this.start(next);
    }
  }

  private writeCache(identity: string, outcome: GitRunOutcome): void {
    if (outcome.kind !== 'ok') return;
    const bytes = outcome.stdout.length + outcome.stderr.length;
    const existing = this.cache.get(identity);
    if (existing) this.cachedBytes -= existing.bytes;
    this.cache.set(identity, { outcome, bytes });
    this.cachedBytes += bytes;
    // LRU:超条目数或超字节时逐最旧(按插入序近似 LRU)淘汰。
    while (this.cache.size > this.limits.maxCacheEntries || this.cachedBytes > this.limits.maxCacheBytes) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const evicted = this.cache.get(key);
      if (!evicted) break;
      this.cache.delete(key);
      this.cachedBytes -= evicted.bytes;
    }
  }
}

/** 共享单例(extension 装配层注入各查询默认面;测试各自新建实例)。 */
export const sharedGitQueryGate = new GitQueryGate();
