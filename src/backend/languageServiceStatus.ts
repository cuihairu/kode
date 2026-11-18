/**
 * RUST-219(旧 UI-002)语言服务状态栏纯核:Core/索引生命周期 + engine
 * profile + 资源根 + 索引进度,单状态栏项。判定同源:索引计数来自
 * IndexScheduler.getStatus(RUST-187 同源探针),profile/资源根来自活动
 * profile(PRJ-010)。诚实边界:「partial(部分索引)」无数据面——
 * SchedulerStatus 只有 failed/queued/running 三计数,不冒充 partial 态;
 * 探针缺省 null = 面不可用,如实显示「未知」不装就绪。
 *
 * 状态机(判定顺序固定,先失败后忙碌后就绪):
 * - failed > 0 → error 脸(终态失败,附三计数)
 * - running/queued > 0 → busy 脸(索引推进中,附运行/排队计数)
 * - 全零 → ready 脸;profile/资源根已知则缀在后面
 * - index = null → 未知脸(面不可用,不判定)
 */

export interface LanguageServiceIndexCounts {
  failed: number;
  queued: number;
  running: number;
}

export interface LanguageServiceStatusInputs {
  /** 活动 profile 展示名;null = 未设置活动 profile */
  profileName: string | null;
  /** 资源根展示名(assetsRoot 基名);null = 未知/未设置 */
  resourceRoot: string | null;
  /** 索引调度计数;null = 面不可用(调度器未注入/已释放) */
  index: LanguageServiceIndexCounts | null;
  /** 最近一轮索引忙起时刻(epoch ms);null/缺省=从未建过(就绪态不加建立行) */
  lastBuildStartedAt?: number | null;
  /** 最近一轮索引跑空时刻(epoch ms);null/缺省=从未建完(就绪态不加建立行) */
  lastBuildCompletedAt?: number | null;
  /** INDEX-DISCIPLINE-001:输入纪律观测(合并器待合并数+语法门拦截数);
   * null/缺省=面未注入(tooltip 不加该行,不冒充)。 */
  indexDiscipline?: { coalescerPending: number; syntaxGateSkipped: number } | null;
}

export interface LanguageServiceStatusView {
  text: string;
  tooltip: string;
  /** true = 有终态失败(宿主可据此强调) */
  hasFailures: boolean;
  /** true = 索引在推进(运行或排队非零;宿主据此保活轮询) */
  isBusy: boolean;
}

/** 状态栏项最小面:真 vscode.StatusBarItem 的结构子集,测试用假体同形
 * (tooltip/command 宽为最小结构:真项接受 MarkdownString/Command,后端零 vscode 依赖) */
export interface LanguageServiceStatusBarItemLike {
  text: string;
  tooltip?: string | { value: string };
  command?: string | { command: string };
  show(): void;
  dispose(): void;
}

/**
 * 索引建立时间行(批 B):就绪态 tooltip 专用。completedAt 缺失(从未建完)
 * → null 不加行;耗时=completed-started,起止缺一或倒挂 → 只给时刻不编耗时。
 * 时刻用本地时区固定 `YYYY-MM-DD HH:mm:ss` 格式(不随宿主 locale 漂移,
 * 测试可锁);耗时分档:毫秒 / x.x 秒 / x 分 y 秒 / x 小时 y 分 z 秒。
 */
export function formatIndexBuildTimeLine(
  startedAt: number | null | undefined,
  completedAt: number | null | undefined
): string | null {
  if (completedAt === null || completedAt === undefined) {
    return null;
  }
  const d = new Date(completedAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  let durationPart = '';
  if (typeof startedAt === 'number' && completedAt >= startedAt) {
    const elapsedMs = completedAt - startedAt;
    if (elapsedMs < 1000) {
      durationPart = `（耗时 ${elapsedMs} 毫秒）`;
    } else if (elapsedMs < 60_000) {
      durationPart = `（耗时 ${(elapsedMs / 1000).toFixed(1)} 秒）`;
    } else if (elapsedMs < 3_600_000) {
      const totalSeconds = Math.floor(elapsedMs / 1000);
      durationPart = `（耗时 ${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒）`;
    } else {
      const totalSeconds = Math.floor(elapsedMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      durationPart = `（耗时 ${hours} 小时 ${minutes} 分 ${totalSeconds % 60} 秒）`;
    }
  }
  return `索引建立：${stamp}${durationPart}。`;
}

/** 纯核:输入 → 状态栏文案。判定顺序固定(未知→失败→忙碌→就绪)。 */
export function buildLanguageServiceStatus(inputs: LanguageServiceStatusInputs): LanguageServiceStatusView {
  const suffixParts: string[] = [];
  if (inputs.profileName) {
    suffixParts.push(inputs.profileName);
  }
  if (inputs.resourceRoot) {
    suffixParts.push(inputs.resourceRoot);
  }
  const suffix = suffixParts.length > 0 ? ` · ${suffixParts.join(' · ')}` : '';

  if (!inputs.index) {
    return {
      text: `$(circle-slash) Kode 索引: 未知${suffix}`,
      tooltip: '索引面不可用(调度器未注入或已释放),如实不判定。\n点击打开 Project Doctor 健康汇总。',
      hasFailures: false,
      isBusy: false
    };
  }

  const { failed, queued, running } = inputs.index;
  // INDEX-DISCIPLINE-001:输入纪律观测行(合并器待合并+语法门拦截)——
  // 面注入才有,用户能看见「保存才进队列 + 烂文件被拦」纪律在工作。
  const disciplineLine = inputs.indexDiscipline
    ? `\n索引输入队列：待合并 ${inputs.indexDiscipline.coalescerPending}（语法门拦截 ${inputs.indexDiscipline.syntaxGateSkipped}）。`
    : '';
  if (failed > 0) {
    return {
      text: `$(error) Kode 索引: 失败 ${failed}（排队 ${queued}/运行 ${running}）${suffix}`,
      tooltip: `索引任务失败 ${failed} 个（排队 ${queued}/运行 ${running}）。\n点击打开 Project Doctor 健康汇总；恢复入口=重启窗口重建索引。`,
      hasFailures: true,
      isBusy: false
    };
  }
  if (running > 0 || queued > 0) {
    return {
      text: `$(sync~spin) Kode 索引: 运行 ${running} 排队 ${queued}${suffix}`,
      tooltip: `索引推进中：运行 ${running}，排队 ${queued}。${disciplineLine}\n点击打开 Project Doctor 健康汇总。`,
      hasFailures: false,
      isBusy: true
    };
  }
  // 就绪态专属:最近一轮建立时刻+耗时行;从未建完(completedAt null)不加,
  // 运行中/失败/未知态不加(完成时刻只对「已就绪」有陈述意义)。
  const buildLine = formatIndexBuildTimeLine(inputs.lastBuildStartedAt, inputs.lastBuildCompletedAt);
  return {
    text: `$(check) Kode 索引: 就绪${suffix}`,
    tooltip:
      `索引就绪。${buildLine !== null ? `\n${buildLine}` : ''}${disciplineLine}\n点击打开 Project Doctor 健康汇总。`,
    hasFailures: false,
    isBusy: false
  };
}

/** 定时器最小面:测试注入假钟,生产注入真 setInterval/clearInterval */
export interface LanguageServiceStatusTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LanguageServiceStatusControllerDeps {
  createItem(): LanguageServiceStatusBarItemLike;
  /** 同源取数:profile/资源根/索引计数(宿主组装,纯核不碰 vscode/memento) */
  collectInputs(): LanguageServiceStatusInputs;
  timers: LanguageServiceStatusTimers;
  /** 忙碌保活轮询间隔毫秒;默认 1000 */
  readonly pollMs?: number;
  /** 点击状态栏打开的命令;默认 kbengine.profile.health */
  readonly clickCommand?: string;
}

/**
 * 状态栏控制器:事件触发 refresh(宿主订阅活动 profile/配置/保存事件),
 * 忙碌期保活轮询(最后一态 busy 才 setInterval,落定即停),dispose 全清。
 */
export class LanguageServiceStatusController {
  private readonly deps: LanguageServiceStatusControllerDeps;
  private readonly item: LanguageServiceStatusBarItemLike;
  private pollHandle: unknown = null;
  private disposed = false;

  constructor(deps: LanguageServiceStatusControllerDeps) {
    this.deps = deps;
    this.item = deps.createItem();
    this.item.command = deps.clickCommand ?? 'kbengine.profile.health';
    this.item.show();
    this.refresh();
  }

  /** 取数→渲染;忙碌则保活轮询,落定则停轮询 */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    const view = buildLanguageServiceStatus(this.deps.collectInputs());
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    if (view.isBusy && this.pollHandle === null) {
      this.pollHandle = this.deps.timers.setInterval(() => this.refresh(), this.deps.pollMs ?? 1000);
    } else if (!view.isBusy && this.pollHandle !== null) {
      this.deps.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  dispose(): void {
    if (this.pollHandle !== null) {
      this.deps.timers.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.disposed = true;
    this.item.dispose();
  }
}
