/**
 * IDE-GIT-010:展示选区历史并定位该次修改(Kode 侧边栏范围历史视图)。
 * 用户约束(2026-10-29):默认开启、按需查询——只在用户经「Kode：查看选中范围
 * 历史」(编辑器选区右键/命令面板)发起时运行;绝不预取、绝不挂编辑器切换/
 * 选区变化监听。结构:纯状态机(item 构造/标题可测)+ 薄 TreeDataProvider
 * 包装(vscode 依赖只在 item 映射,经 fake-vscode 可测)。
 *
 * 语义:
 * - 入口 `showSelectionHistory(filePath, repoRoot, range)` 把工作区选区先经
 *   IDE-GIT-008 映射为已提交(HEAD)行段(绝不把当前行号当 HEAD 行号),再经
 *   IDE-GIT-009 查询该 HEAD 行段的逐提交修改时间线;视图呈现「文件 @ HEAD
 *   行 N-M」基准与原选区。
 * - 切换编辑器/光标/选区不会错套(视图持有自身查询结果,不随编辑器变化
 *   重查,也不反向应用到别的编辑器)。
 * - 点击条目经 `kbengine.git.openRangeHistoryDiff` 打开该版本 vs 父版本
 *   diff,并在该版本内容中定位行段范围(IDE-GIT-006 虚拟文档,只读不落盘)。
 */

import * as path from 'path';
import { pathApiFor } from './workspacePath';
import * as vscode from 'vscode';
import {
  queryRangeTimeline,
  type GitRangeTimelineDeps,
  type RangeChangeEntry,
  type RangeTimelineBoundary,
  type RangeTimelineResult,
  defaultGitRangeTimelineDeps,
} from './gitRangeTimeline';
import {
  mapSelectionToHeadRange,
  type GitSelectionMapDeps,
  type SelectionMapResult,
  type SelectionRange,
  defaultGitSelectionMapDeps,
} from './gitSelectionMap';
import { summarizeGitError } from './gitHistoryTree';
import {
  describeGitRepoLocation,
  locateGitRepository,
  realGitRepoLocationDeps,
  type GitRepoLocation,
} from './gitRepoLocate';
import { GitCancelSource, type GitQueryRequest } from './gitQueryGate';

/** 视图条目:修改记录(点击打开 diff+定位)/ 引导或状态。 */
export type RangeHistoryItem =
  | {
      kind: 'entry';
      entry: RangeChangeEntry;
      /** 该提交时文件绝对路径(沿重命名:老路径提交用老路径)。 */
      filePath: string;
      repoRoot: string;
      /** 父提交时文件绝对路径(重命名提交的父侧在老路径)。 */
      parentFilePath: string;
    }
  | { kind: 'message'; message: string; tone: 'guidance' | 'warning' };

/** 视图状态机:空闲(零 Git)→ 映射+查询 → 装载 / 明确失败。 */
export type RangeHistoryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'loaded';
      /** 当前文件绝对路径。 */
      filePath: string;
      repoRoot: string;
      /** 已提交(HEAD)行段(1 基、含端点;由映射结果推得)。 */
      headStart: number;
      headEnd: number;
      /** 原始编辑器选区(1 基、含端点,展示用)。 */
      selectionStart: number;
      selectionEnd: number;
      entries: RangeChangeEntry[];
      boundary: RangeTimelineBoundary;
      /** 选区中未提交/未保存、无法映射的行数(>0 时顶部警告,时间线仅已提交部分)。 */
      unmappedLines: number;
    }
  | { kind: 'no-selection' }
  | { kind: 'has-uncommitted'; message: string }
  | { kind: 'untracked' }
  | { kind: 'no-commits' }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export interface RangeHistoryDeps {
  /** 定位所属仓库(默认:locateGitRepository + 当前工作区根 + 真实 fs 面)。 */
  locateGitRepo(filePath: string, enabled: boolean): GitRepoLocation;
  /** 工作区选区 → 已提交(HEAD)行段(默认:IDE-GIT-008 mapSelectionToHeadRange;request 带 token)。 */
  mapSelection(
    filePath: string,
    repoRoot: string,
    range: SelectionRange,
    request?: GitQueryRequest
  ): Promise<SelectionMapResult>;
  /** HEAD 行段 → 逐提交修改时间线(默认:IDE-GIT-009 queryRangeTimeline;request 带 token)。 */
  queryTimeline(
    filePath: string,
    repoRoot: string,
    range: SelectionRange,
    request?: GitQueryRequest
  ): Promise<RangeTimelineResult>;
}

export function defaultRangeHistoryDeps(deps?: Partial<RangeHistoryDeps>): RangeHistoryDeps {
  const mapDeps: GitSelectionMapDeps = defaultGitSelectionMapDeps();
  const queryDeps: GitRangeTimelineDeps = defaultGitRangeTimelineDeps();
  return {
    locateGitRepo: (filePath, enabled) =>
      locateGitRepository(
        filePath,
        (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        enabled,
        realGitRepoLocationDeps()
      ),
    mapSelection: (filePath, repoRoot, range, request) =>
      mapSelectionToHeadRange(filePath, repoRoot, range, mapDeps, request),
    queryTimeline: (filePath, repoRoot, range, request) =>
      queryRangeTimeline(filePath, repoRoot, range, queryDeps, request),
    ...deps,
  };
}

/** 由状态构造视图条目(纯函数:引导/警告/修改记录行)。 */
export function buildRangeHistoryItems(state: RangeHistoryState): RangeHistoryItem[] {
  switch (state.kind) {
    case 'idle':
      return [
        {
          kind: 'message',
          tone: 'guidance',
          message: '尚未查询:选中代码右键「Kode：查看选中范围历史」,或在命令面板运行同名命令',
        },
      ];
    case 'loading':
      return [{ kind: 'message', tone: 'guidance', message: '正在查询选中范围历史…' }];
    case 'loaded': {
      const items: RangeHistoryItem[] = [];
      if (state.unmappedLines > 0) {
        items.push({
          kind: 'message',
          tone: 'warning',
          message: `选区 ${state.unmappedLines} 行为未提交/未保存新增或修改,无法映射(以下时间线仅已提交部分)`,
        });
      }
      state.entries.forEach((entry, index) => {
        const filePath = pathApiFor(state.repoRoot).join(state.repoRoot, entry.path);
        // 父提交时路径 = 更老一条记录的 path(重命名提交的父侧在老路径)。
        const next = state.entries[index + 1];
        const parentFilePath = next ? pathApiFor(state.repoRoot).join(state.repoRoot, next.path) : filePath;
        items.push({ kind: 'entry', entry, filePath, repoRoot: state.repoRoot, parentFilePath });
      });
      const b = state.boundary;
      if (b.kind === 'origin') {
        items.push({
          kind: 'message',
          tone: 'guidance',
          message: `已追溯到行段引入处(提交 ${b.atCommit.slice(0, 8)} @ ${b.atPath})`,
        });
      } else {
        items.push({
          kind: 'message',
          tone: 'warning',
          message: `追踪止于 ${b.atCommit.slice(0, 8)} @ ${b.atPath}(合并/复制/无法继续,不代表完整历史)`,
        });
      }
      return items;
    }
    case 'no-selection':
      return [{ kind: 'message', tone: 'guidance', message: '请先选择要查看历史的代码范围' }];
    case 'has-uncommitted':
      return [{ kind: 'message', tone: 'warning', message: state.message }];
    case 'untracked':
      return [{ kind: 'message', tone: 'warning', message: '文件未纳入 Git 跟踪,没有历史可查' }];
    case 'no-commits':
      return [{ kind: 'message', tone: 'warning', message: '仓库尚无提交,没有历史可查' }];
    case 'invalid':
      return [{ kind: 'message', tone: 'warning', message: state.message }];
    case 'error':
      return [{ kind: 'message', tone: 'warning', message: state.message }];
  }
}

/** 视图标题:文件 @ HEAD 行段(基准提交与原选区);非装载态回缺省。 */
export function rangeHistoryViewTitle(state: RangeHistoryState): string {
  if (state.kind !== 'loaded') return '选区历史';
  return `${path.basename(state.filePath)} @ HEAD 行 ${state.headStart}-${state.headEnd}`;
}

/** 由映射结果推装载状态的 HEAD 行段(各段并集;无段返回 null)。 */
function headSpanFromSegments(
  segments: readonly { headFirstLine: number; headLastLine: number }[]
): { start: number; end: number } | null {
  if (segments.length === 0) return null;
  let start = Infinity;
  let end = 0;
  for (const s of segments) {
    start = Math.min(start, s.headFirstLine);
    end = Math.max(end, s.headLastLine);
  }
  return { start, end };
}

/**
 * 全体段边界中追溯最远(最早)的一个。解析器保证 boundary.atCommit 即该段
 * 最老条目(`entries[last].hash`),以其提交时刻比较;更老者胜,同刻 origin
 * (「引入于此」)优先于 stopped(合并/复制停点);无条目段(解析器空档
 * atCommit='')不参与,全不参与回落末段边界(与旧行为一致)。
 */
function earliestBoundary(
  timelines: readonly { entries: RangeChangeEntry[]; boundary: RangeTimelineBoundary }[]
): RangeTimelineBoundary {
  let best: RangeTimelineBoundary | null = null;
  let bestTime = -Infinity;
  let bestOrigin = false;
  for (const timeline of timelines) {
    const at = timeline.entries.find(e => e.hash === timeline.boundary.atCommit);
    if (!at) continue; // 边界提交不在条目中(空档/异常)→ 该段不参与比较
    const time = Date.parse(at.commitDate);
    const origin = timeline.boundary.kind === 'origin';
    if (
      best === null ||
      time < bestTime ||
      (time === bestTime && origin && !bestOrigin)
    ) {
      best = timeline.boundary;
      bestTime = time;
      bestOrigin = origin;
    }
  }
  return best ?? timelines[timelines.length - 1].boundary;
}

/**
 * 范围历史树(侧边栏 kbengine.gitRangeHistory)。
 * showSelectionHistory 只在用户入口触发;不挂编辑器切换/选区变化监听
 * (视图持有自身状态,切换编辑器不重查、不错套)。
 */
export class GitRangeHistoryTreeProvider implements vscode.TreeDataProvider<RangeHistoryItem> {
  private readonly changeEmitter = new vscode.EventEmitter<RangeHistoryItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private state: RangeHistoryState = { kind: 'idle' };
  /**
   * IDE-GIT-011:视图级取消令牌——关闭视图/卸载时取消本视图全部在途查询。
   */
  private viewToken = new GitCancelSource();
  /**
   * IDE-GIT-011 代际守卫:重复选区「只留最新」——每次入口自增代际,在途查询
   * 恢复时若代际已更替则丢弃(不写状态、不覆盖更新的查询)。
   */
  private generation = 0;

  constructor(private readonly deps: RangeHistoryDeps) {}

  /** 关闭视图/卸载:取消在途查询(不残留子进程)。 */
  dispose(): void {
    this.generation += 1;
    this.viewToken.cancel();
  }

  /**
   * IDE-GIT-011:视图隐藏——取消当前在途查询(代际更替丢弃旧结果)并更换新令牌,
   * 重开视图后新查询仍可用。
   */
  cancelInFlight(): void {
    this.generation += 1;
    this.viewToken.cancel();
    this.viewToken = new GitCancelSource();
  }

  private fire(): void {
    this.changeEmitter.fire();
  }

  getState(): RangeHistoryState {
    return this.state;
  }

  getTreeItem(item: RangeHistoryItem): vscode.TreeItem {
    const tree = new vscode.TreeItem(item.kind === 'entry' ? item.entry.subject : '');
    if (item.kind === 'entry') {
      tree.description = `${item.entry.authorName} · ${item.entry.authorDate}`;
      tree.tooltip = [
        item.entry.hash,
        `${item.entry.authorName} <${item.entry.authorEmail}>`,
        `作者时间:${item.entry.authorDate}`,
        `提交时间:${item.entry.commitDate}`,
        item.entry.subject,
        `行 ${item.entry.rangeStart}-${item.entry.rangeEnd} @ ${item.entry.path}`,
      ]
        .filter((line) => line.trim() !== '')
        .join('\n');
      tree.contextValue = 'gitRangeEntry';
      // 点击:打开该版本 vs 父版本 diff 并定位行段范围。
      tree.command = {
        command: 'kbengine.git.openRangeHistoryDiff',
        title: '打开版本差异并定位',
        arguments: [item.entry, item.filePath, item.repoRoot, item.parentFilePath],
      };
    } else {
      tree.label = item.message;
      if (item.tone === 'warning') tree.contextValue = 'gitRangeHistoryWarning';
    }
    return tree;
  }

  getChildren(): RangeHistoryItem[] {
    return buildRangeHistoryItems(this.state);
  }

  /** 入口:定位仓库 → 映射选区 → 查询时间线(只在用户触发时发生;不挂编辑器监听)。 */
  async showSelectionHistory(
    filePath: string,
    range: SelectionRange,
    enabled: boolean
  ): Promise<void> {
    const gen = ++this.generation;
    if (!enabled) {
      this.state = { kind: 'error', message: '历史功能已关闭' };
      this.fire();
      return;
    }
    this.state = { kind: 'loading' };
    this.fire();
    const location = this.deps.locateGitRepo(filePath, enabled);
    if (location.kind !== 'repo') {
      this.state = { kind: 'error', message: describeGitRepoLocation(location) };
      this.fire();
      return;
    }
    const repoRoot = location.repoRoot;
    const mapped = await this.deps.mapSelection(filePath, repoRoot, range, {
      token: this.viewToken,
    });
    // 重复选区只留最新:在途回归时代际已更替 → 丢弃,不写状态。
    if (gen !== this.generation) return;
    switch (mapped.kind) {
      case 'mapped':
        await this.queryAndLoad(filePath, repoRoot, range, mapped.segments, 0, gen);
        return;
      case 'has-uncommitted': {
        // 已提交部分照常出时间线,未提交行如实警告。
        if (mapped.segments.length > 0) {
          await this.queryAndLoad(
            filePath,
            repoRoot,
            range,
            mapped.segments,
            mapped.unmappedLines,
            gen
          );
        } else {
          this.state = {
            kind: 'has-uncommitted',
            message: `选区 ${mapped.selectionLineCount} 行均为未提交/未保存新增或修改,无法准确映射到已提交版本(保存后重试或选择已提交版本)`,
          };
          this.fire();
        }
        return;
      }
      case 'untracked':
        this.state = { kind: 'untracked' };
        this.fire();
        return;
      case 'no-commits':
        this.state = { kind: 'no-commits' };
        this.fire();
        return;
      case 'binary':
        this.state = { kind: 'invalid', message: '二进制文件不支持按行映射到已提交版本' };
        this.fire();
        return;
      case 'invalid-selection':
        this.state = { kind: 'invalid', message: mapped.reason };
        this.fire();
        return;
      case 'git-error':
        this.state = { kind: 'error', message: `映射失败:${summarizeGitError(mapped.outcome)}` };
        this.fire();
        return;
    }
  }

  /** 无选区提示(直接调用命令且无选区时;同时丢弃在途查询)。 */
  showNoSelection(): void {
    this.generation += 1;
    this.state = { kind: 'no-selection' };
    this.fire();
  }

  /** Git 不可用提示(调用面送文案;同时丢弃在途查询)。 */
  showUnavailable(message: string): void {
    this.generation += 1;
    this.state = { kind: 'error', message };
    this.fire();
  }

  private async queryAndLoad(
    filePath: string,
    repoRoot: string,
    range: SelectionRange,
    segments: readonly { headFirstLine: number; headLastLine: number }[],
    unmappedLines: number,
    gen: number
  ): Promise<void> {
    if (segments.length === 0) {
      this.state = { kind: 'invalid', message: '选区无已提交行段可查询' };
      this.fire();
      return;
    }
    // 审核发现:多段不连续映射不得合并成 min..max——否则会漏进中间未选中行的
    // 修改。逐段查询,再按提交 hash 去重合并时间线。
    // 审核发现(并发面):Promise.all 同时发起全部段查询,段数超过门限
    // (range 并发 1 + 队列 8)时后段被 gate 以「历史查询队列已满」拒绝,
    // 整个范围历史查询失败。改串行逐段:gate 面天然串行 range 查询,不再
    // 瞬时灌满队列;首段失败即停,段间查代际——选区已换/视图已关早停。
    const results: RangeTimelineResult[] = [];
    for (const segment of segments) {
      if (gen !== this.generation) {
        return;
      }
      const result = await this.deps.queryTimeline(
        filePath,
        repoRoot,
        { startLine: segment.headFirstLine, endLine: segment.headLastLine },
        { token: this.viewToken }
      );
      if (result.kind !== 'timeline') {
        this.state = this.applyTimelineFailure(result);
        this.fire();
        return;
      }
      results.push(result);
    }
    // 代际已更替(新选区/视图关闭)→ 丢弃旧结果,不覆盖最新状态。
    if (gen !== this.generation) return;
    const timelines = results.map(result => result as Extract<RangeTimelineResult, { kind: 'timeline' }>);
    if (timelines.length > 0) {
      const entriesByKey = new Map<string, RangeChangeEntry>();
      for (const timeline of timelines) {
        for (const entry of timeline.entries) {
          if (!entriesByKey.has(entry.hash)) {
            entriesByKey.set(entry.hash, entry);
          }
        }
      }
      // 审核发现:段序拼接≠时间序——逐段 git log -L 各自最新在前,跨段时间
      // 交错的提交按段序拼接会乱序,且父路径链 entries[index+1](注释明示为
      // 更老提交)在段边界取到别段更新提交。合并后按提交时间全局降序(稳定
      // 排序,同刻保持首见段序),entries[index+1] 恒为不新于当前条 → 链向正确。
      const entries = [...entriesByKey.values()].sort(
        (a, b) => Date.parse(b.commitDate) - Date.parse(a.commitDate)
      );
      const span = headSpanFromSegments(segments)!;
      this.state = {
        kind: 'loaded',
        filePath,
        repoRoot,
        headStart: span.start,
        headEnd: span.end,
        selectionStart: range.startLine,
        selectionEnd: range.endLine,
        entries,
        boundary: earliestBoundary(timelines),
        unmappedLines,
      };
    }
    this.fire();
  }

  private applyTimelineFailure(result: Exclude<RangeTimelineResult, { kind: 'timeline' }>): RangeHistoryState {
    switch (result.kind) {
      case 'invalid-range':
        return { kind: 'invalid', message: result.reason };
      case 'untracked':
        return { kind: 'untracked' };
      case 'no-commits':
        return { kind: 'no-commits' };
      case 'git-error':
        return { kind: 'error', message: `查询失败:${summarizeGitError(result.outcome)}` };
    }
  }
}
