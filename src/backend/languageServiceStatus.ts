/**
 * Pure core of the RUST-219 (formerly UI-002) language service status bar: Core / index
 * lifecycle + engine profile + resource root + index progress, in a single status-bar item.
 * Same-source determination: the index counts come from IndexScheduler.getStatus (the same
 * probe as RUST-187), and profile / resource root come from the active profile (PRJ-010).
 * Honest boundary: "partial (partially indexed)" has no data face -- SchedulerStatus carries
 * only the failed/queued/running three counts, so a partial state is never passed off; a probe
 * default of null = the face is unavailable, displayed honestly as "unknown" instead of
 * pretending readiness.
 *
 * The state machine (a fixed decision order: failure first, then busy, then ready):
 * - failed > 0 -> the error face (a terminal failure, carrying the three counts)
 * - running/queued > 0 -> the busy face (index progress under way, carrying the running/queued counts)
 * - all zero -> the ready face; a known profile / resource root is appended after it
 * - index = null -> the unknown face (the face is unavailable; no judgement is made)
 */

export interface LanguageServiceIndexCounts {
  failed: number;
  queued: number;
  running: number;
}

export interface LanguageServiceStatusInputs {
  /** The active profile's display name; null = no active profile set */
  profileName: string | null;
  /** The resource root's display name (the assetsRoot basename); null = unknown/not set */
  resourceRoot: string | null;
  /** Index scheduler counts; null = the face is unavailable (the scheduler not injected / already released) */
  index: LanguageServiceIndexCounts | null;
  /** The moment the most recent index round turned busy (epoch ms); null/absent = never started (the ready state adds no build line) */
  lastBuildStartedAt?: number | null;
  /** The moment the most recent index round drained (epoch ms); null/absent = never completed (the ready state adds no build line) */
  lastBuildCompletedAt?: number | null;
  /** INDEX-DISCIPLINE-001: input-discipline observations (the coalescer's pending merges + the
   * syntax gate's interceptions); null/absent = the face was not injected (the tooltip adds no
   * line and does not pass it off). */
  indexDiscipline?: { coalescerPending: number; syntaxGateSkipped: number } | null;
}

export interface LanguageServiceStatusView {
  text: string;
  tooltip: string;
  /** true = there is a terminal failure (the host may emphasize on this basis) */
  hasFailures: boolean;
  /** true = the index is progressing (running or queued non-zero; the host keeps the poll alive on this basis) */
  isBusy: boolean;
}

/** The status-bar item's minimal face: a structural subset of the real vscode.StatusBarItem, and
 * test fakes share the same shape (tooltip/command widened to the minimal structure: the real item
 * accepts MarkdownString/Command, while the backend keeps zero vscode dependencies) */
export interface LanguageServiceStatusBarItemLike {
  text: string;
  tooltip?: string | { value: string };
  command?: string | { command: string };
  show(): void;
  dispose(): void;
}

/**
 * The index build time line (batch B): exclusive to the ready-state tooltip. A missing
 * completedAt (never completed) -> null, no line; the duration = completed-started, and if
 * either end is missing or they are inverted -> only the moment is given, no duration invented.
 * The moment uses the local time zone in the fixed `YYYY-MM-DD HH:mm:ss` format (it does not
 * drift with the host locale, so tests can pin it); the duration tiers: milliseconds / x.x s /
 * x min y s / x h y min z s.
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

/** Pure core: inputs -> the status-bar wording. The decision order is fixed (unknown -> failed -> busy -> ready). */
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
  // INDEX-DISCIPLINE-001: the input-discipline observation line (the coalescer's pending merges +
  // the syntax gate's interceptions) --
  // present only when the face is injected, so the user can see the "only queued on save +
  // broken files are intercepted" discipline working.
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
  // Exclusive to the ready state: the most recent build moment + the duration line; not added when
  // never completed (completedAt null), and not added in the running/failed/unknown states (the
  // completion moment only means something for "already ready").
  const buildLine = formatIndexBuildTimeLine(inputs.lastBuildStartedAt, inputs.lastBuildCompletedAt);
  return {
    text: `$(check) Kode 索引: 就绪${suffix}`,
    tooltip:
      `索引就绪。${buildLine !== null ? `\n${buildLine}` : ''}${disciplineLine}\n点击打开 Project Doctor 健康汇总。`,
    hasFailures: false,
    isBusy: false
  };
}

/** The timers' minimal face: tests inject a fake clock, production injects the real setInterval/clearInterval */
export interface LanguageServiceStatusTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LanguageServiceStatusControllerDeps {
  createItem(): LanguageServiceStatusBarItemLike;
  /** Same-source data gathering: profile / resource root / index counts (assembled by the host; the pure core touches neither vscode nor memento) */
  collectInputs(): LanguageServiceStatusInputs;
  timers: LanguageServiceStatusTimers;
  /** The busy keep-alive poll interval in milliseconds; default 1000 */
  readonly pollMs?: number;
  /** The command opened by clicking the status bar; default kbengine.profile.health */
  readonly clickCommand?: string;
}

/**
 * The status-bar controller: events trigger refresh (the host subscribes to active-profile /
 * config / save events), and a keep-alive poll runs while busy (setInterval only while the last
 * state is busy, stopping as soon as it settles); dispose clears everything.
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

  /** Gather -> render; a busy view keeps the poll alive, a settled one stops it */
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
