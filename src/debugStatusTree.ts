/**
 * Debug Targets 树视图(IDE-DBG-008):状态板(debugStatusBoard)的工作
 * 台面——逐目标一行,四态在描述与图标上各自可辨,点击带 serverKey 走
 * kbengine.debug.focusTarget 定位命令(已附加=打开 Run and Debug 视图
 * 定位会话;监听/失败/未注入=如实提示)。行数据由装配层注入(getRows
 * 每次拉新),注入回报/会话起止/进程变化三面都踢 refresh。
 */

import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import type { DebugStatusRow, TargetDebugPhase } from './debugStatusBoard';

/** 四态标签英文源串(调用期经 l10nText 取词,树描述与定位命令共用) */
const DEBUG_PHASE_KEYS: Readonly<Record<TargetDebugPhase, string>> = {
  'not-injected': 'Not injected',
  listening: 'Listening',
  attached: 'Attached',
  failed: 'Failed'
};

/**
 * 四态标签(树描述/定位命令/通知面共用):调用期取词——默认英文 locale
 * 出英文源串,zh-cn bundle 出中文,缺 key 回落英文源串。
 */
export function debugPhaseLabel(phase: TargetDebugPhase): string {
  return l10nText(DEBUG_PHASE_KEYS[phase]);
}

/** 四态图标(ThemeIcon 内建 id) */
const PHASE_ICONS: Readonly<Record<TargetDebugPhase, string>> = {
  'not-injected': 'circle-outline',
  listening: 'plug',
  attached: 'debug-alt',
  failed: 'error'
};

export class DebugTargetTreeItem extends vscode.TreeItem {
  constructor(public readonly row: DebugStatusRow) {
    super(row.serverKey, vscode.TreeItemCollapsibleState.None);
    const parts = [debugPhaseLabel(row.phase)];
    if (row.port !== undefined) {
      parts.push(`debugpy ${row.port}`);
    }
    if (row.attachedSessions > 0) {
      parts.push(l10nText('{count} session(s)', { count: row.attachedSessions }));
    }
    parts.push(l10nText('Process {status}', { status: row.processStatus }));
    this.description = parts.join(' · ');
    this.iconPath = new vscode.ThemeIcon(PHASE_ICONS[row.phase]);
    this.contextValue = `debugTarget_${row.phase}`;
    this.tooltip = [
      row.serverKey,
      `${l10nText('Status: {state}', { state: debugPhaseLabel(row.phase) })}${row.port !== undefined ? ` (debugpy ${row.port})` : ''}`,
      `${l10nText('Process {status}', { status: row.processStatus })}`,
      row.detail ? l10nText('Details: {detail}', { detail: row.detail }) : undefined,
      l10nText('Click to focus the debug session')
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
    this.command = {
      command: 'kbengine.debug.focusTarget',
      title: l10nText('Focus debug target'),
      arguments: [row.serverKey]
    };
  }
}

export interface DebugTargetTreeDeps {
  /** 每次拉新的状态板(装配层:进程×注入×会话合板) */
  getRows(): DebugStatusRow[];
}

export class DebugTargetTreeProvider implements vscode.TreeDataProvider<DebugTargetTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DebugTargetTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: DebugTargetTreeDeps) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DebugTargetTreeItem): DebugTargetTreeItem {
    return element;
  }

  async getChildren(): Promise<DebugTargetTreeItem[]> {
    return this.deps.getRows().map(row => new DebugTargetTreeItem(row));
  }
}
