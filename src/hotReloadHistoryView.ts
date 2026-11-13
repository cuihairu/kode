//! HR-PR-06 接线批:热更历史 UI 装配(TreeView + 历史面板 + 搜索)。
//!
//! - **数据面**:投递台账(HotReloadTargetStateStore)是事实源;onRecord
//!   单条回调把每次发送/回执升级/注解写回投影进 HotReloadHistoryCore——
//!   requestId 按「目标键/文件#代际」稳定成键(同一次执行回执升级幂等原位
//!   替换,新代际=新行),状态映射 accepted→sent-unverified(accepted 只是
//!   回执中段,未到 applied 核验,历史三态如实不拔高);模块双名经注入的
//!   解析面取(HR-MOD-011 树标题用 fullModule,tooltip 双名)。
//! - **TreeView(kbengine.hotReloadHistory)**:最近更新/按文件/按目标三组
//!   (HR-UI-002,键组再套行;同路径不同 target 天然分行,HR-UI-010/014);
//!   标题=buildHistoryEntryLabel(HR-MOD-011),tooltip=
//!   buildHistoryEntryTooltipLines(双名/file/target/时间/requestId);
//!   台账事件→重渲染经合并窗节流(HR-UI-007),受限宿主无 createTreeView
//!   退化为 registerTreeDataProvider(与既有视图同口径)。
//! - **搜索命令(kbengine.hotReload.historySearch)**:fullModule 子串过滤
//!   作用于树(HR-UI-010)。
//! - **历史面板命令(kbengine.hotReload.historyPanel)**:webview 单列面板
//!   (既有 createWebviewPanel 模式,不新造框架,HR-UI-004)——页头(监听
//!   模式/目标/计数)、过滤(fullModule 子串/target/状态)、表格(最新在前,
//!   「加载更多」分页增量,HR-UI-007)、行字段=fullModule(requestModule
//!   异时并列,HR-UI-006)+file+target+状态+时间+requestId(HR-HTTP-014
//!   展示面)+错误摘要。
//! - **持久化(HR-MOD-014)**:persist 注入面(宿主用 workspaceState 适配)
//!   每次台账投影后落全量行;启动时回载,行形状不符的条目如实丢弃。
//! - **生命周期(HR-UI-012)**:全部句柄进 context.subscriptions;面板/树
//!   关闭不停热更服务(feed 独立于面板生命周期,只清引用)。
//! - 编排纯函数化(翻译/渲染可独立断言),vscode 面只留薄壳。

import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildHistoryEntryLabel,
  buildHistoryEntryTooltipLines,
  HotReloadHistoryCore,
  type HotReloadHistoryEntry,
  type HotReloadHistoryFilter,
  type HotReloadHistoryInput,
  type HotReloadHistoryStatus
} from './backend/hotReloadHistoryCore';
import { buildHotReloadTargetKeyId, type HotReloadDeliveryRecord } from './backend/hotReloadTargetState';

/** workspaceState 持久化键(HR-MOD-014;宿主适配面用) */
export const HOT_RELOAD_HISTORY_STATE_KEY = 'kbengine.hotReload.history';

export const HOT_RELOAD_HISTORY_PANEL_COMMAND = 'kbengine.hotReload.historyPanel';
export const HOT_RELOAD_HISTORY_SEARCH_COMMAND = 'kbengine.hotReload.historySearch';

/** 模块双名解析面(注入;解析不了如实回落,不猜) */
export type HotReloadNamesResolver = (file: string) => { fullModule: string; requestModule: string };

/** feed 页头状态(HR-UI-004:监听模式/目标;如实给,缺=空串) */
export interface HotReloadFeedStatus {
  readonly watchMode: string;
  readonly target: string;
}

/** 台账记录 → 历史行翻译(纯;requestId 同执行稳定,回执升级幂等替换) */
export function translateDeliveryRecord(
  record: HotReloadDeliveryRecord,
  resolveNames: HotReloadNamesResolver
): HotReloadHistoryInput {
  const names = resolveNames(record.file);
  // accepted 只是回执中段(未到 applied 核验),历史三态如实按 sent-unverified
  const status: HotReloadHistoryStatus =
    record.outcome === 'applied' ? 'applied' : record.outcome === 'failed' ? 'failed' : 'sent-unverified';
  return {
    requestId: `${buildHotReloadTargetKeyId({ rootId: record.rootId, targetId: record.targetId })}/${path.basename(record.file)}#${record.attempt}`,
    fullModule: names.fullModule,
    requestModule: names.requestModule,
    fileUri: record.file,
    targetId: record.targetId,
    time: record.recordedAt,
    status,
    ...(record.detail !== undefined ? { errorSummary: record.detail } : {})
  };
}

/** 面板状态(过滤+分页;纯渲染输入) */
export interface HotReloadHistoryPanelState {
  readonly feedStatus: HotReloadFeedStatus;
  readonly filter: HotReloadHistoryFilter;
  readonly page: number;
}

/** 面板体(纯字符串;过滤/加载更多按钮 postMessage 回装配改状态重渲染) */
export function renderHistoryPanelHtml(input: {
  state: HotReloadHistoryPanelState;
  rows: readonly HotReloadHistoryEntry[];
  total: number;
  hasMore: boolean;
  pageSize: number;
}): string {
  const esc = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const statusLabel = (status: HotReloadHistoryStatus): string =>
    status === 'applied' ? '已应用' : status === 'failed' ? '失败' : '已发送(未确认)';
  const body = input.rows
    .map(entry => {
      const moduleCell =
        entry.requestModule !== entry.fullModule && entry.fullModule.length > 0
          ? `${esc(entry.fullModule)}<span class="req">发送: ${esc(entry.requestModule)}</span>`
          : esc(entry.fullModule || entry.requestModule);
      return `      <tr>
        <td class="module">${moduleCell}</td>
        <td><code title="${esc(entry.fileUri)}">${esc(path.basename(entry.fileUri))}</code></td>
        <td>${esc(entry.targetId.length > 0 ? entry.targetId : '(default)')}</td>
        <td class="st-${entry.status}">${statusLabel(entry.status)}</td>
        <td>${esc(new Date(entry.time).toISOString())}</td>
        <td><code>${esc(entry.requestId)}</code></td>
        <td>${entry.errorSummary ? esc(entry.errorSummary) : ''}</td>
      </tr>`;
    })
    .join('\n');
  const filter = input.state.filter;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  h2 { margin: 0 0 8px; }
  .header { color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  form.filter { margin-bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  form.filter input, form.filter select { min-width: 140px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  td.module { white-space: normal; word-break: break-all; }
  span.req { display: block; color: var(--vscode-descriptionForeground); }
  .st-applied { color: var(--vscode-testing-iconPassed, #73c991); }
  .st-failed { color: var(--vscode-testing-iconFailed, #f14c4c); }
  .st-sent-unverified { color: var(--vscode-testing-iconQueued, #cca700); }
  .more { margin-top: 8px; }
  code { word-break: break-all; }
</style></head>
<body>
  <h2>热更历史</h2>
  <div class="header">监听模式: ${esc(input.state.feedStatus.watchMode || '(未配置)')} | 目标: ${esc(input.state.feedStatus.target || '(默认)')} | 显示 ${input.rows.length}/${input.total} 行</div>
  <form class="filter">
    <input id="f-module" placeholder="模块包含…" value="${esc(filter.fullModuleContains ?? '')}">
    <input id="f-target" placeholder="目标 id…" value="${esc(filter.targetId ?? '')}">
    <select id="f-status">
      <option value="">全部状态</option>
      <option value="sent-unverified" ${filter.status === 'sent-unverified' ? 'selected' : ''}>已发送(未确认)</option>
      <option value="applied" ${filter.status === 'applied' ? 'selected' : ''}>已应用</option>
      <option value="failed" ${filter.status === 'failed' ? 'selected' : ''}>失败</option>
    </select>
    <button type="button" id="apply">应用筛选</button>
    <button type="button" id="clear">清除筛选</button>
  </form>
  <table>
    <thead><tr><th>模块</th><th>文件</th><th>目标</th><th>状态</th><th>时间</th><th>请求 id</th><th>错误</th></tr></thead>
    <tbody>
${body || '      <tr><td colspan="7">(无匹配行)</td></tr>'}
    </tbody>
  </table>
  ${input.hasMore ? `<div class="more"><button type="button" id="more">加载更多(每页 ${input.pageSize} 行)</button></div>` : ''}
  <script>
    const vscode = acquireVsCodeApi();
    const apply = () => {
      vscode.postMessage({
        type: 'filter',
        fullModuleContains: document.getElementById('f-module').value,
        targetId: document.getElementById('f-target').value,
        status: document.getElementById('f-status').value
      });
    };
    document.getElementById('apply').addEventListener('click', apply);
    document.getElementById('clear').addEventListener('click', () => {
      document.getElementById('f-module').value = '';
      document.getElementById('f-target').value = '';
      document.getElementById('f-status').value = '';
      apply();
    });
    const more = document.getElementById('more');
    if (more) { more.addEventListener('click', () => vscode.postMessage({ type: 'loadMore' })); }
  </script>
</body>
</html>`;
}

/** 装配选项(注入面;测试给内存替身) */
export interface HotReloadHistoryViewOptions {
  core: HotReloadHistoryCore;
  /** 台账记录→模块双名解析面(HR-MOD-011) */
  resolveNames: HotReloadNamesResolver;
  /** feed 页头状态(如实;缺省全空串) */
  feedStatus?: () => HotReloadFeedStatus;
  /** 重渲染节流窗 ms(HR-UI-007;缺省 500) */
  refreshWindowMs?: number;
  /** 树「最近更新」组行数上限=面板分页页大小(HR-UI-007;缺省 50) */
  pageSize?: number;
  /** 节流定时器(注入;缺省真 setTimeout;测试给假钟) */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** 持久化面(HR-MOD-014;宿主用 context.workspaceState 适配;缺省不落) */
  persist?: {
    load(): unknown;
    save(entries: readonly HotReloadHistoryEntry[]): void;
  };
}

/** 树节点:顶层组(recent/file/target)/键组(具体文件或目标)/历史行 */
type TreeNode =
  | { kind: 'group'; groupKind: 'recent' | 'file' | 'target'; label: string }
  | { kind: 'keyGroup'; groupKind: 'file' | 'target'; label: string; rows: HotReloadHistoryEntry[] }
  | { kind: 'entry'; entry: HotReloadHistoryEntry };

const isHistoryEntryShape = (value: unknown): value is HotReloadHistoryEntry => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.fullModule === 'string' &&
    typeof candidate.requestModule === 'string' &&
    typeof candidate.fileUri === 'string' &&
    typeof candidate.targetId === 'string' &&
    typeof candidate.time === 'number' &&
    (candidate.status === 'sent-unverified' || candidate.status === 'applied' || candidate.status === 'failed')
  );
};

/**
 * 装配:树(三组)+ 搜索命令 + 面板命令 + store.onRecord 投影 feed。
 * 全部句柄进 context.subscriptions;返回 feed 入口(activate 接线)。
 */
export function setupHotReloadHistoryView(
  context: vscode.ExtensionContext,
  opts: HotReloadHistoryViewOptions
): { handle(record: HotReloadDeliveryRecord): void } {
  const timers = opts.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const refreshWindowMs = opts.refreshWindowMs ?? 500;
  const pageSize = opts.pageSize ?? 50;
  const feedStatus = opts.feedStatus ?? (() => ({ watchMode: '', target: '' }));

  // 启动回载(HR-MOD-014):形状不符的条目如实丢弃,不猜不全量吞
  if (opts.persist) {
    const loaded = opts.persist.load();
    if (Array.isArray(loaded)) {
      for (const item of loaded) {
        if (isHistoryEntryShape(item)) {
          opts.core.record(item);
        }
      }
    }
  }

  // HR-UI-007:重渲染节流——窗内多次台账事件只刷一次;面板打开时即时重渲染
  let pendingHandle: unknown = null;
  const cancelPending = (): void => {
    if (pendingHandle !== null) {
      timers.clear(pendingHandle);
      pendingHandle = null;
    }
  };

  // HR-UI-010:搜索过滤状态(搜索命令改;作用于树)
  let treeFilterText = '';
  const treeEntries = (): readonly HotReloadHistoryEntry[] => {
    const all = opts.core.newestFirst();
    if (treeFilterText.length === 0) {
      return all;
    }
    const needle = treeFilterText.toLowerCase();
    return all.filter(entry => entry.fullModule.toLowerCase().includes(needle));
  };

  const emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();

  const treeProvider: vscode.TreeDataProvider<TreeNode> = {
    onDidChangeTreeData: emitter.event,
    getTreeItem(node: TreeNode): vscode.TreeItem {
      if (node.kind === 'entry') {
        const entry = node.entry;
        const item = new vscode.TreeItem(buildHistoryEntryLabel(entry));
        item.tooltip = buildHistoryEntryTooltipLines(entry).join('\n');
        item.description = `${entry.status}${entry.targetId.length > 0 ? ` · ${entry.targetId}` : ''}`;
        item.contextValue = 'kbengineHotReloadHistoryEntry';
        return item;
      }
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description =
        node.kind === 'keyGroup'
          ? String(node.rows.length)
          : String(treeEntries().length);
      return item;
    },
    getChildren(node?: TreeNode): TreeNode[] {
      const entries = treeEntries();
      if (node === undefined) {
        return [
          { kind: 'group', groupKind: 'recent', label: '最近更新' },
          { kind: 'group', groupKind: 'file', label: '按文件' },
          { kind: 'group', groupKind: 'target', label: '按目标' }
        ];
      }
      if (node.kind === 'group') {
        if (node.groupKind === 'recent') {
          return entries.slice(0, pageSize).map(entry => ({ kind: 'entry', entry }));
        }
        // file/target 顶层组 → 键组(动态分组;同路径不同 target 分行)
        const grouped =
          node.groupKind === 'file'
            ? HotReloadHistoryCore.groupByFile([...entries])
            : HotReloadHistoryCore.groupByTarget([...entries]);
        return [...grouped.entries()].map(([label, groupRows]) => ({
          kind: 'keyGroup' as const,
          groupKind: node.groupKind as 'file' | 'target',
          label,
          rows: groupRows
        }));
      }
      if (node.kind === 'keyGroup') {
        return node.rows.map(entry => ({ kind: 'entry', entry }));
      }
      return [];
    }
  };

  const refresh = (): void => emitter.fire();
  const scheduleRefresh = (): void => {
    if (pendingHandle !== null) {
      return;
    }
    pendingHandle = timers.set(() => {
      pendingHandle = null;
      refresh();
    }, refreshWindowMs);
  };

  // 受限宿主(fake-vscode 无 createTreeView)退化为 registerTreeDataProvider
  if (typeof vscode.window.createTreeView === 'function') {
    const treeView = vscode.window.createTreeView('kbengine.hotReloadHistory', { treeDataProvider: treeProvider });
    context.subscriptions.push(treeView);
  } else {
    const registration = vscode.window.registerTreeDataProvider('kbengine.hotReloadHistory', treeProvider);
    context.subscriptions.push(registration);
  }

  const searchCommand = vscode.commands.registerCommand(HOT_RELOAD_HISTORY_SEARCH_COMMAND, async () => {
    const input = await vscode.window.showInputBox({
      prompt: '按模块名过滤热更历史(fullModule 子串,留空清除)',
      value: treeFilterText
    });
    if (input === undefined) {
      return;
    }
    treeFilterText = input.trim();
    refresh();
  });
  context.subscriptions.push(searchCommand);

  // 面板状态(HR-UI-010 过滤 + HR-UI-007 分页)
  const panelState: { state: HotReloadHistoryPanelState | null; panel: vscode.WebviewPanel | null } = {
    state: null,
    panel: null
  };
  const renderPanel = (): void => {
    const state = panelState.state;
    const panel = panelState.panel;
    if (state === null || panel === null) {
      return;
    }
    const filtered = opts.core.filter(state.filter);
    const newestFirst = [...filtered].reverse();
    const visibleCount = state.page * pageSize;
    const rows = newestFirst.slice(0, visibleCount);
    panel.webview.html = renderHistoryPanelHtml({
      state,
      rows,
      total: filtered.length,
      hasMore: rows.length < filtered.length,
      pageSize
    });
  };
  const panelCommand = vscode.commands.registerCommand(HOT_RELOAD_HISTORY_PANEL_COMMAND, () => {
    panelState.state = { feedStatus: feedStatus(), filter: {}, page: 1 };
    panelState.panel = vscode.window.createWebviewPanel(
      'kbengineHotReloadHistory',
      '热更历史',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panelState.panel.webview.onDidReceiveMessage(message => {
      if (panelState.state === null) {
        return;
      }
      if (message?.type === 'filter') {
        const fullModuleContains =
          typeof message.fullModuleContains === 'string' ? message.fullModuleContains.trim() : '';
        const targetId = typeof message.targetId === 'string' ? message.targetId.trim() : '';
        const status =
          message.status === 'sent-unverified' || message.status === 'applied' || message.status === 'failed'
            ? (message.status as HotReloadHistoryStatus)
            : undefined;
        panelState.state = {
          ...panelState.state,
          page: 1,
          filter: {
            ...(fullModuleContains.length > 0 ? { fullModuleContains } : {}),
            ...(targetId.length > 0 ? { targetId } : {}),
            ...(status !== undefined ? { status } : {})
          }
        };
        renderPanel();
        return;
      }
      if (message?.type === 'loadMore') {
        panelState.state = { ...panelState.state, page: panelState.state.page + 1 };
        renderPanel();
      }
    }, undefined, context.subscriptions);
    panelState.panel.onDidDispose(() => {
      // HR-UI-012:面板关闭不停服务——只清面板引用,feed/树照常驱动
      panelState.panel = null;
      panelState.state = null;
    }, undefined, context.subscriptions);
    renderPanel();
  });
  context.subscriptions.push(panelCommand);

  // 生命周期(HR-UI-012):deactivate 走 subscriptions.dispose 清节流钟
  context.subscriptions.push({
    dispose: (): void => {
      cancelPending();
    }
  });

  return {
    handle: (record: HotReloadDeliveryRecord): void => {
      opts.core.record(translateDeliveryRecord(record, opts.resolveNames));
      opts.persist?.save(opts.core.entries());
      // 面板开着 → 即时重渲染(数据变了);树 → 节流刷新
      if (panelState.panel !== null) {
        renderPanel();
      } else {
        scheduleRefresh();
      }
    }
  };
}
