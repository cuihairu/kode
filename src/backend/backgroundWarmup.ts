/**
 * 后台预热控制器(BG-WARM 批)。
 *
 * 痛点:kode 首次打开索引依赖面板(依赖图/流程图/调用链等)才扫描分析,
 * 打开等很久。改造:activate(工作区门控放行后)即后台起全量索引/实例分析
 * 管线,面板打开只读缓存——预热中显示进度+部分结果,复用在跑任务不重起。
 *
 * 设计口径:
 * - 阶段顺序执行,阶段间让出主线程(setImmediate 宏任务边界,与 EVT-012
 *   让出节拍同源);阶段内部有逐条目的工作量时用 mapWithConcurrency
 *   有界并发(KR-AUD-35 口径:上限常量,禁无界并行)。
 * - 产物面:阶段用 expectedArtifacts 声明将发布的产物键,阶段启动即登记
 *   running——面板经 artifact() 拿到的是同一在跑 Promise(复用不重算),
 *   完成后 peekArtifact() 只读缓存。
 * - 失败快速止步(后续阶段不跑,整体 failed);取消同理(整体 cancelled)。
 *   两者都不写完成标记,下次会话照常重跑。
 * - 完成(全部阶段 done)写 workspaceState 标记:{generation, completedAt,
 *   durationMs, stages}——首次运行/升级重建由 firstRun/upgraded 如实记账,
 *   不改变既有 KR-AUD-34(发现链会话缓存)/KR-AUD-36(布局缓存口径)的
 *   语义,只挪时机。
 * - 本模块零 vscode 导入(除类型注释外),装配在 extension.ts,状态栏进度
 *   (withProgress Window 位,可取消)由装配层接。
 */

/** 预热扫描有界并发上限(KR-AUD-35:rebuild 无界并发是已知审计项,管线侧上限常量) */
export const WARMUP_SCAN_CONCURRENCY = 4;

/** workspaceState 完成标记键 */
export const warmupMarkerKey = 'kbengine.backgroundWarmup.completed';

export interface WarmupStageContext {
  /** 取消旗标(控制器 cancel 后,后续阶段不启动;长阶段内部可自查) */
  readonly token: { readonly isCancellationRequested: boolean };
  /** 阶段内有界并发上限(KR-AUD-35 口径:上限常量经控制器配置下发) */
  readonly concurrency: number;
  /** 阶段内进度明细(装配层透传到状态栏 message) */
  report(detail: string): void;
  /**
   * 阶段启动即登记产物为 running(动态清单面:实体键这类运行期才知道的清单,
   * 在逐条计算前先登记——面板中途打开读到 running(进度页 + 复用在跑),不是
   * missing(另起现算)。已终态的键不回改。
   */
  declare(key: string): void;
  /** 发布产物(面板只读缓存) */
  publish<T>(key: string, value: T): void;
}

export interface WarmupStageDef {
  readonly key: string;
  readonly label: string;
  run(ctx: WarmupStageContext): Promise<void>;
  /** 阶段启动即登记 running 的产物键(面板预热中可复用在跑任务) */
  readonly expectedArtifacts?: readonly string[];
}

export type WarmupStageState = 'pending' | 'running' | 'done' | 'cancelled' | 'failed';

export interface WarmupStageSnapshot {
  readonly key: string;
  readonly label: string;
  readonly state: WarmupStageState;
  readonly error?: string;
}

export type WarmupState = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface WarmupSnapshot {
  readonly state: WarmupState;
  /** 上一会话无完成标记 = 首次运行(重建全后台化) */
  readonly firstRun: boolean;
  /** 上一会话有标记但代际不同 = 升级重建(全后台化) */
  readonly upgraded: boolean;
  readonly completedStages: number;
  readonly totalStages: number;
  readonly stages: readonly WarmupStageSnapshot[];
  /** 当前运行阶段的展示名(状态栏进度用) */
  readonly currentLabel: string | null;
}

export interface WarmupArtifactPeek<T> {
  readonly state: 'missing' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly value?: T;
}

export interface WarmupWorkspaceStateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

/** 面板只读缓存视图(面板构造注入面;控制器即此形状) */
export interface PanelWarmupSource {
  peekArtifact<T>(key: string): WarmupArtifactPeek<T>;
  artifact<T>(key: string): Promise<T | undefined>;
  snapshot(): WarmupSnapshot;
}

export interface BackgroundWarmupMarker {
  readonly generation: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly stages: readonly string[];
}

export interface BackgroundWarmupOptions {
  readonly stages: readonly WarmupStageDef[];
  readonly workspaceState: WarmupWorkspaceStateLike;
  /** 代际(扩展版本+工作区根指纹):升级/换根即视为重建轮 */
  readonly generation: string;
  readonly markerKey?: string;
  /** 每次状态结算推送(装配层接状态栏进度) */
  readonly onDidChange?: (snapshot: WarmupSnapshot) => void;
  /** 阶段间让出边界(测试注入;生产 setImmediate 宏任务) */
  readonly yieldBetweenStages?: () => Promise<void>;
  /** 阶段内部 mapWithConcurrency 缺省上限 */
  readonly concurrency?: number;
}

export type WarmupFinalState = 'completed' | 'cancelled' | 'failed';

interface ArtifactEntry {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  promise?: Promise<unknown>;
  value?: unknown;
}

export interface MapWithConcurrencyOptions {
  /**
   * 取下一条前的停手谓词(取消面):返回 true 即不再领取新条目,已在跑的条目
   * 照常结算。结果数组未取到的位保持 undefined(调用方按「未处理」读)。
   */
  readonly stop?: () => boolean;
}

/**
 * 有界并发映射(KR-AUD-35 口径):上限常量限流,槽释放后继续取下一条。
 * worker 抛错整批拒绝(调用方自行兜底),并发槽正确释放;stop 置真后不再取新条目。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {}
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      if (options.stop?.()) {
        return;
      }
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

const defaultYield = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

export class BackgroundWarmupController implements PanelWarmupSource {
  private readonly stageStates: Array<{ key: string; label: string; state: WarmupStageState; error?: string }> = [];
  private readonly artifacts = new Map<string, ArtifactEntry>();
  private readonly expectedKeys = new Map<string, readonly string[]>();
  // 逐阶段动态登记的产物键(declare 面):阶段结算时与 expectedKeys 合并——
  // 阶段失败/取消也把这批键结算掉,不给面板留永远 running 的悬挂键。
  private readonly declaredKeysByStage = new Map<string, Set<string>>();
  private runPromise?: Promise<WarmupFinalState>;
  private state: WarmupState = 'idle';
  private cancellationRequested = false;
  private startedAt = 0;
  private readonly firstRun: boolean;
  private readonly upgraded: boolean;

  constructor(private readonly options: BackgroundWarmupOptions) {
    for (const stage of options.stages) {
      this.stageStates.push({ key: stage.key, label: stage.label, state: 'pending' });
      if (stage.expectedArtifacts) {
        this.expectedKeys.set(stage.key, stage.expectedArtifacts);
      }
    }
    const previous = options.workspaceState.get<BackgroundWarmupMarker>(options.markerKey ?? warmupMarkerKey);
    this.firstRun = !previous;
    this.upgraded = previous !== undefined && previous.generation !== options.generation;
  }

  /** 启动预热(幂等):在跑/已终态轮复用同一 Promise,绝不重扫。 */
  start(): Promise<WarmupFinalState> {
    if (this.runPromise) {
      return this.runPromise;
    }
    const run = this.runStages();
    this.runPromise = run;
    return run;
  }

  private async runStages(): Promise<WarmupFinalState> {
    this.state = 'running';
    this.startedAt = Date.now();
    this.emit();
    const yieldBoundary = this.options.yieldBetweenStages ?? defaultYield;
    // 取消旗标取值面:箭头捕获控制器实例(getter 语法体内 this 会换绑到 token)
    const isCancelled = (): boolean => this.isCancelled();
    for (let index = 0; index < this.options.stages.length; index += 1) {
      const stage = this.options.stages[index];
      if (this.cancellationRequested) {
        this.stageStates[index].state = 'cancelled';
        continue;
      }
      if (index > 0) {
        // 阶段间让出主线程:宏任务边界,长管线不占交互
        await yieldBoundary();
        if (this.cancellationRequested) {
          this.stageStates[index].state = 'cancelled';
          continue;
        }
      }
      const record = this.stageStates[index];
      record.state = 'running';
      for (const key of this.expectedKeys.get(stage.key) ?? []) {
        this.registerRunning(key);
      }
      this.emit();
      try {
        await stage.run({
          token: { get isCancellationRequested(): boolean { return isCancelled(); } },
          concurrency: this.options.concurrency ?? WARMUP_SCAN_CONCURRENCY,
          report: () => undefined,
          declare: key => this.declareArtifact(stage.key, key),
          publish: (key, value) => this.publish(key, value)
        });
        record.state = 'done';
        this.resolveRunning(stage.key, 'done');
      } catch (error) {
        record.state = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        this.resolveRunning(stage.key, 'failed');
        this.state = 'failed';
        this.emit();
        return 'failed';
      }
      this.emit();
    }
    if (this.cancellationRequested) {
      this.state = 'cancelled';
      this.emit();
      return 'cancelled';
    }
    this.state = 'completed';
    const marker: BackgroundWarmupMarker = {
      generation: this.options.generation,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      stages: this.options.stages.map(stage => stage.key)
    };
    await this.options.workspaceState.update(this.options.markerKey ?? warmupMarkerKey, marker);
    this.emit();
    return 'completed';
  }

  /** token 取消旗标:控制器层在阶段边界结算,ctx.token 恒反射真实旗标。 */
  private isCancelled(): boolean {
    return this.cancellationRequested;
  }

  cancel(reason = 'warmup-cancelled'): void {
    if (this.cancellationRequested) {
      return;
    }
    this.cancellationRequested = true;
    void reason;
    // 在跑产物登记逐个经 settleEntry 落 cancelled:等待方(已开面板的 artifact())
    // 立刻兑现 undefined 回落现算,而不是攥着原 Promise 等阶段自行走完。
    for (const [key, entry] of [...this.artifacts.entries()]) {
      if (entry.state === 'running') {
        this.settleEntry(key, 'cancelled');
      }
    }
    this.emit();
  }

  snapshot(): WarmupSnapshot {
    const completedStages = this.stageStates.filter(stage => stage.state === 'done').length;
    const running = this.stageStates.find(stage => stage.state === 'running');
    return {
      state: this.state,
      firstRun: this.firstRun,
      upgraded: this.upgraded,
      completedStages,
      totalStages: this.stageStates.length,
      stages: this.stageStates.map(stage => ({
        key: stage.key,
        label: stage.label,
        state: stage.state,
        ...(stage.error !== undefined ? { error: stage.error } : {})
      })),
      currentLabel: running ? running.label : null
    };
  }

  peekArtifact<T>(key: string): WarmupArtifactPeek<T> {
    const entry = this.artifacts.get(key);
    if (!entry) {
      return { state: 'missing' };
    }
    if (entry.state === 'running') {
      return { state: 'running' };
    }
    if (entry.state === 'done') {
      return { state: 'done', value: entry.value as T };
    }
    return { state: entry.state };
  }

  /** 面板取产物:在跑复用同一 Promise(不重算),done 直读,缺失/失败/取消 → undefined。 */
  async artifact<T>(key: string): Promise<T | undefined> {
    const entry = this.artifacts.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.state === 'done') {
      return entry.value as T;
    }
    if (entry.state === 'running' && entry.promise) {
      const value = await entry.promise;
      return value as T | undefined;
    }
    return undefined;
  }

  /**
   * 阶段声明面:键未登记即登记 running;已终态/在跑的键原样保留(不重开)。
   * 声明同时记到所属阶段的键集合里——阶段收尾(含失败/取消)统一结算。
   */
  private declareArtifact(stageKey: string, key: string): void {
    const declared = this.declaredKeysByStage.get(stageKey) ?? new Set<string>();
    declared.add(key);
    this.declaredKeysByStage.set(stageKey, declared);
    if (!this.artifacts.has(key)) {
      this.registerRunning(key);
    }
  }

  private registerRunning(key: string): void {
    const existing = this.artifacts.get(key);
    if (existing && existing.state !== 'running') {
      return;
    }
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>(resolver => { resolve = resolver; });
    this.artifacts.set(key, { state: 'running', promise });
    void (promise as Promise<unknown>);
    // resolve 句柄挂在条目上:发布/终态结算时兑现
    (this.artifacts.get(key) as ArtifactEntry & { __resolve?: (value: unknown) => void }).__resolve = resolve;
  }

  private settleEntry(key: string, state: 'done' | 'failed' | 'cancelled', value?: unknown): void {
    const entry = this.artifacts.get(key);
    // 终态只进一次:只有 running 可结算——取消/失败之后的迟到发布不把条目翻回
    // done(cancelled 不复活),已 done 的也不被阶段收尾重写。
    if (!entry || entry.state !== 'running') {
      return;
    }
    const resolve = (entry as ArtifactEntry & { __resolve?: (value: unknown) => void }).__resolve;
    entry.state = state;
    if (state === 'done') {
      entry.value = value;
    }
    entry.promise = undefined;
    if (resolve) {
      resolve(state === 'done' ? value : undefined);
    }
  }

  /**
   * 阶段收尾:expectedArtifacts(静态声明)与 declare(运行期动态登记)两批键
   * 一并结算——阶段抛错时动态键同样落 failed,面板等待方立刻拿空值回落现算,
   * 不留永远 running 的悬挂键;已终态的键由 settleEntry 的 running 闸挡住。
   */
  private resolveRunning(stageKey: string, outcome: 'done' | 'failed' | 'cancelled'): void {
    const keys = new Set<string>([
      ...(this.expectedKeys.get(stageKey) ?? []),
      ...(this.declaredKeysByStage.get(stageKey) ?? [])
    ]);
    for (const key of keys) {
      this.settleEntry(key, outcome);
    }
    this.declaredKeysByStage.delete(stageKey);
  }

  private publish<T>(key: string, value: T): void {
    // 未声明 expectedArtifacts 的动态产物(flowGraph:<entity> 运行期才知道键)
    // 首发即登记,后续 peek/artifact 同样只读。
    if (!this.artifacts.has(key)) {
      this.registerRunning(key);
    }
    this.settleEntry(key, 'done', value);
    this.emit();
  }

  private emit(): void {
    this.options.onDidChange?.(this.snapshot());
  }
}
