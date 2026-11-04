/**
 * IDE-GIT-005:文件历史列表入口(Kode 侧边栏历史视图)。
 * 用户约束(2026-10-29):默认开启、按需查询——本视图只在用户经「Kode：查看
 * 文件历史」(资源管理器/编辑器右键/命令面板)发起时查询;构造与空闲态
 * **零 Git 调用**(无查询只显示操作引导);功能关闭时入口已被 when 子句隐藏
 * (IDE-GIT-001),命令体再经 runGitHistoryWhenEnabled 短路,定位也返回 disabled。
 *
 * 结构:纯状态机(item 构造/翻页/引导文案可测)+ 薄 TreeDataProvider 包装
 * (vscode 依赖只在 item 映射,经 fake-vscode 可测)。历史泳道视图挂在既有
 * kbengine-explorer 容器下,与 quickActions/serverControl 同族(TreeDataProvider)。
 * 视图标题 = 文件名 @ 基准提交(最新一页顶条;空则 HEAD)。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  DEFAULT_GIT_LOG_PAGE_SIZE,
  queryGitCommitLog,
  type GitCommitEntry,
  type GitCommitLogResult,
} from './gitCommitLog';
import type { GitRunOutcome } from './gitRunner';
import {
  describeGitRepoLocation,
  describeGitUnavailable,
  locateGitRepository,
  realGitRepoLocationDeps,
  type GitRepoLocation,
} from './gitRepoLocate';

/** 视图条目:提交记录 / 加载下一页 / 引导或状态(无查询零 Git 调用)。 */
export type GitHistoryItem =
  | {
      kind: 'commit';
      entry: GitCommitEntry;
      index: number;
      /** 所属文件与仓库(IDE-GIT-006 打开版本 diff/内容时定位虚拟文档三键)。 */
      filePath: string;
      repoRoot: string;
    }
  | { kind: 'next-page'; loadedCount: number }
  | { kind: 'message'; message: string; tone: 'guidance' | 'warning' };

/** 视图状态机:空闲(零 Git)→ 定位 → 装载(分页累计)/ 明确失败。 */
export type GitHistoryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'loaded';
      filePath: string;
      repoRoot: string;
      entries: GitCommitEntry[];
      page: number;
      pageSize: number;
      hasMore: boolean;
    }
  | { kind: 'untracked'; filePath: string }
  | { kind: 'no-history'; filePath: string }
  | { kind: 'no-commits' }
  | { kind: 'error'; message: string };

export interface GitHistoryDeps {
  /** 定位所属仓库(默认:locateGitRepository + 当前工作区根 + 真实 fs 面)。 */
  locateGitRepo(filePath: string, enabled: boolean): GitRepoLocation;
  /** 查询分页提交记录(默认:IDE-GIT-004 queryGitCommitLog)。 */
  queryLog(filePath: string, repoRoot: string, page: number, pageSize: number): Promise<GitCommitLogResult>;
  /** 每页条数(缺省 50;硬上限由 IDE-GIT-004 钳制)。 */
  pageSize: number;
}

export function defaultGitHistoryDeps(deps?: Partial<GitHistoryDeps>): GitHistoryDeps {
  return {
    locateGitRepo: (filePath, enabled) =>
      locateGitRepository(
        filePath,
        (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        enabled,
        realGitRepoLocationDeps()
      ),
    queryLog: (filePath, repoRoot, page, pageSize) =>
      queryGitCommitLog({ repoRoot, filePath, page, pageSize }),
    pageSize: DEFAULT_GIT_LOG_PAGE_SIZE,
    ...deps,
  };
}

/** 由状态构造视图条目(纯函数:引导文案/下一页/提交行)。 */
export function buildHistoryItems(state: GitHistoryState): GitHistoryItem[] {
  switch (state.kind) {
    case 'idle':
      return [
        {
          kind: 'message',
          tone: 'guidance',
          message: '尚未查询:右键文件选择「Kode：查看文件历史」,或在命令面板运行同名命令',
        },
      ];
    case 'loading':
      return [{ kind: 'message', tone: 'guidance', message: '正在查询文件历史…' }];
    case 'loaded': {
      const items: GitHistoryItem[] = state.entries.map((entry, index) => ({
        kind: 'commit',
        entry,
        index,
        filePath: state.filePath,
        repoRoot: state.repoRoot,
      }));
      if (state.hasMore) {
        items.push({ kind: 'next-page', loadedCount: state.entries.length });
      }
      return items;
    }
    case 'untracked':
      return [{ kind: 'message', tone: 'warning', message: `未跟踪文件(不在 Git 索引或历史中):${path.basename(state.filePath)}` }];
    case 'no-history':
      return [{ kind: 'message', tone: 'warning', message: `已跟踪但尚无提交历史(暂存未提交):${path.basename(state.filePath)}` }];
    case 'no-commits':
      return [{ kind: 'message', tone: 'warning', message: '该仓库尚无任何提交' }];
    case 'error':
      return [{ kind: 'message', tone: 'warning', message: state.message }];
  }
}

/** 视图标题:文件名 @ 基准提交(最新一页顶条短哈希;非装载态回缺省)。 */
export function historyViewTitle(state: GitHistoryState): string {
  if (state.kind !== 'loaded') return '文件历史';
  const base = state.entries[0]?.hash.slice(0, 8) ?? 'HEAD';
  return `${path.basename(state.filePath)} @ ${base}`;
}

/**
 * 文件历史树(侧边栏 kbengine.gitHistory)。
 * showHistory 只在用户入口触发;loadNextPage 只在显式点「加载下一页」。
 */
export class GitHistoryTreeProvider implements vscode.TreeDataProvider<GitHistoryItem> {
  private readonly changeEmitter = new vscode.EventEmitter<GitHistoryItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private state: GitHistoryState = { kind: 'idle' };

  constructor(private readonly deps: GitHistoryDeps) {}

  private fire(): void {
    this.changeEmitter.fire();
  }

  getState(): GitHistoryState {
    return this.state;
  }

  getTreeItem(item: GitHistoryItem): vscode.TreeItem {
    const tree = new vscode.TreeItem(item.kind === 'commit' ? item.entry.subject : '');
    if (item.kind === 'commit') {
      tree.description = `${item.entry.authorName} · ${item.entry.authorDate}`;
      tree.tooltip = [
        item.entry.hash,
        `${item.entry.authorName} <${item.entry.authorEmail}>`,
        `作者时间:${item.entry.authorDate}`,
        `提交时间:${item.entry.commitDate}`,
        item.entry.subject,
        item.entry.body,
      ]
        .filter((line) => line.trim() !== '')
        .join('\n');
      tree.contextValue = 'gitCommit';
      // IDE-GIT-006:点击提交记录在主编辑区打开该版本 vs 父版本只读 diff
      tree.command = {
        command: 'kbengine.git.openVersionDiff',
        title: '打开版本差异',
        arguments: [item.entry.hash, item.filePath, item.repoRoot],
      };
    } else if (item.kind === 'next-page') {
      tree.label = `加载下一页(已载 ${item.loadedCount} 条)`;
      tree.command = { command: 'kbengine.git.historyNextPage', title: '加载下一页' };
      tree.contextValue = 'gitHistoryNextPage';
    } else {
      tree.label = item.message;
      if (item.tone === 'warning') {
        tree.contextValue = 'gitHistoryWarning';
      }
    }
    return tree;
  }

  getChildren(): GitHistoryItem[] {
    return buildHistoryItems(this.state);
  }

  /** 入口:定位仓库 → 首页查询(只在用户触发时发生)。 */
  async showHistory(filePath: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      this.state = { kind: 'error', message: '文件历史功能已关闭' };
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
    const result = await this.deps.queryLog(filePath, location.repoRoot, 0, this.deps.pageSize);
    this.state = this.applyResult(filePath, location.repoRoot, result, /* append */ false);
    this.fire();
  }

  /** 翻页:追加下一页(不重复不漏项;只在显式触发时查询)。 */
  async loadNextPage(): Promise<void> {
    if (this.state.kind !== 'loaded' || !this.state.hasMore) return;
    const prev = this.state;
    const result = await this.deps.queryLog(
      prev.filePath,
      prev.repoRoot,
      prev.page + 1,
      prev.pageSize
    );
    if (result.kind !== 'page' || result.entries.length === 0) {
      // 翻页失败/到尽头:保留已载内容,如实质感
      this.state = { ...prev, hasMore: false };
      this.fire();
      return;
    }
    this.state = {
      ...prev,
      entries: [...prev.entries, ...result.entries],
      page: result.page,
      hasMore: result.hasMore,
    };
    this.fire();
  }

  /** Git 不可用时的可操作提示入口(调用面把 describeGitUnavailable 文案送进来)。 */
  showUnavailable(): void {
    this.state = { kind: 'error', message: describeGitUnavailable() };
    this.fire();
  }

  private applyResult(
    filePath: string,
    repoRoot: string,
    result: GitCommitLogResult,
    append: boolean
  ): GitHistoryState {
    switch (result.kind) {
      case 'page': {
        const prevEntries = append && this.state.kind === 'loaded' ? this.state.entries : [];
        return {
          kind: 'loaded',
          filePath,
          repoRoot,
          entries: [...prevEntries, ...result.entries],
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
        };
      }
      case 'untracked':
        return { kind: 'untracked', filePath };
      case 'no-history':
        return { kind: 'no-history', filePath };
      case 'no-commits':
        return { kind: 'no-commits' };
      case 'git-error':
        return { kind: 'error', message: `查询文件历史失败:${summarizeGitError(result.outcome)}` };
    }
  }
}

/** git 失败摘要(结构化结果 → 一行文案)。 */
export function summarizeGitError(outcome: GitRunOutcome): string {
  if (outcome.kind === 'exit' && outcome.stderr) return outcome.stderr.trim().split('\n')[0] || 'git 非零退出';
  if (outcome.kind === 'spawn') return outcome.message ?? 'git 进程启动失败';
  if (outcome.kind === 'timeout') return '查询超时(有界执行已终止)';
  if (outcome.kind === 'cancelled') return '查询已取消';
  if (outcome.kind === 'output-limit') return '输出超限(有界执行已终止)';
  if (outcome.kind === 'invalid-args') return `参数被拒:${outcome.reason ?? ''}`;
  return '未知错误';
}
