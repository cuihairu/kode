/**
 * Debug Targets 树视图(IDE-DBG-008):状态板(debugStatusBoard)的工作
 * 台面——逐目标一行,四态在描述与图标上各自可辨,点击带 serverKey 走
 * kbengine.debug.focusTarget 定位命令(已附加=打开 Run and Debug 视图
 * 定位会话;监听/失败/未注入=如实提示)。行数据由装配层注入(getRows
 * 每次拉新),注入回报/会话起止/进程变化三面都踢 refresh。
 */

import * as vscode from 'vscode';
import type { DebugStatusRow, TargetDebugPhase } from './debugStatusBoard';

/** 四态标签(树描述与定位命令共用) */
export const DEBUG_PHASE_LABELS: Readonly<Record<TargetDebugPhase, string>> = {
  'not-injected': '未注入',
  listening: '监听',
  attached: '已附加',
  failed: '失败'
};

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
    const parts = [DEBUG_PHASE_LABELS[row.phase]];
    if (row.port !== undefined) {
      parts.push(`debugpy ${row.port}`);
    }
    if (row.attachedSessions > 0) {
      parts.push(`${row.attachedSessions} 个会话`);
    }
    parts.push(`进程 ${row.processStatus}`);
    this.description = parts.join(' · ');
    this.iconPath = new vscode.ThemeIcon(PHASE_ICONS[row.phase]);
    this.contextValue = `debugTarget_${row.phase}`;
    this.tooltip = [
      row.serverKey,
      `状态: ${DEBUG_PHASE_LABELS[row.phase]}${row.port !== undefined ? ` (debugpy ${row.port})` : ''}`,
      `进程: ${row.processStatus}`,
      row.detail ? `细节: ${row.detail}` : undefined,
      '点击定位调试会话/查看提示'
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
    this.command = {
      command: 'kbengine.debug.focusTarget',
      title: '定位调试目标',
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
