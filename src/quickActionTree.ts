import * as vscode from 'vscode';
import { baseNameOf } from './quickActionConfig';

export interface QuickActionTreeEntry {
  name: string;
  type: 'command' | 'script' | 'http';
  target: string;
}

export interface QuickActionTreeDeps {
  getActions(): Promise<QuickActionTreeEntry[]>;
}

export class QuickActionTreeItem extends vscode.TreeItem {
  constructor(entry?: QuickActionTreeEntry) {
    if (!entry) {
      super('未配置快速执行动作：在 .kbengine/debug.json 的 quickActions 数组中添加，或点击重新扫描', vscode.TreeItemCollapsibleState.None);
      this.description = '点击扫描脚本';
      this.tooltip = '配置位置：.kbengine/debug.json → quickActions';
      this.command = { command: 'kbengine.quickActions.scanScripts', title: '重新扫描脚本' };
      this.contextValue = 'quickActionEmpty';
      return;
    }
    const scriptName = entry.type === 'script' ? baseNameOf(entry.target) : '';
    const label = scriptName && scriptName !== entry.name ? `${entry.name} · ${scriptName}` : entry.name;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = entry.type === 'script' ? scriptName : entry.type;
    this.tooltip = `${entry.name}\n${entry.target}\n点击执行`;
    this.contextValue = 'quickAction';
    this.command = { command: 'kbengine.quickActions.runByName', title: '执行快速动作', arguments: [entry.name] };
  }
}

export class QuickActionTreeProvider implements vscode.TreeDataProvider<QuickActionTreeItem> {
  private readonly emitter = new vscode.EventEmitter<QuickActionTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: QuickActionTreeDeps) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: QuickActionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<QuickActionTreeItem[]> {
    const actions = await this.deps.getActions();
    return actions.length > 0 ? actions.map(action => new QuickActionTreeItem(action)) : [new QuickActionTreeItem()];
  }
}
